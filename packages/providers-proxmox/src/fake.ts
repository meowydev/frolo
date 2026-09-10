// Fake Proxmox provider (req §14.1). In-memory inventory + async task polling.
// Tasks transition running -> ok after N polls (scriptable to error) so the
// orchestrator's "advance only on task result" behavior (req §6.3) is exercised.

import type {
  CapabilityReport,
  CloneRequest,
  ConfigureRequest,
  Ipv4,
  ProxmoxProvider,
  TaskRef,
  TaskResult,
  TemplateInfo,
  VmInfo,
} from "@frolo/contracts";

interface FakeVm {
  vmid: number;
  name: string;
  status: "running" | "stopped";
  cores: number;
  ramMb: number;
  diskGb: number;
  isTemplate: boolean;
  cloudInit: boolean;
  osHint?: string;
  ipConfig?: string;
  dhcpAddress?: Ipv4;
  guestAgent: boolean;
}

interface FakeTask {
  upid: string;
  node: string;
  pollsRemaining: number;
  outcome: "ok" | "error";
  exitStatus?: string;
  kind: string;
}

export interface FakeProxmoxOptions {
  node?: string;
  // Force a specific action's next task to fail (for failure-path tests).
  failNext?: Partial<Record<"clone" | "configure" | "start" | "delete", string>>;
  // How many polls before a task resolves. Default 2 (models async).
  pollsToResolve?: number;
  // Simulate a DHCP lease handed to configured VMs.
  dhcpBase?: string; // e.g. "192.168.7."
}

export class FakeProxmoxProvider implements ProxmoxProvider {
  private readonly node: string;
  private readonly vms = new Map<number, FakeVm>();
  private readonly tasks = new Map<string, FakeTask>();
  private upidCounter = 0;
  private nextVmid = 100;
  private dhcpCounter = 50;

  constructor(private readonly opts: FakeProxmoxOptions = {}) {
    this.node = opts.node ?? "pve";
    // Seed a couple of QEMU cloud-init templates and one existing VM.
    this.vms.set(9000, {
      vmid: 9000,
      name: "ubuntu-2404-cloudinit",
      status: "stopped",
      cores: 2,
      ramMb: 2048,
      diskGb: 10,
      isTemplate: true,
      cloudInit: true,
      osHint: "ubuntu-24.04",
      guestAgent: true,
    });
    this.vms.set(9001, {
      vmid: 9001,
      name: "ubuntu-2204-cloudinit",
      status: "stopped",
      cores: 2,
      ramMb: 2048,
      diskGb: 10,
      isTemplate: true,
      cloudInit: true,
      osHint: "ubuntu-22.04",
      guestAgent: true,
    });
    this.vms.set(120, {
      vmid: 120,
      name: "existing-service",
      status: "running",
      cores: 1,
      ramMb: 1024,
      diskGb: 8,
      isTemplate: false,
      cloudInit: false,
      guestAgent: false,
    });
  }

  async validate(): Promise<CapabilityReport> {
    return {
      ok: true,
      node: this.node,
      canClone: true,
      canConfigure: true,
      canStart: true,
      canDelete: true,
      detail: "fake provider ready",
    };
  }

  async listTemplates(node: string): Promise<TemplateInfo[]> {
    return [...this.vms.values()]
      .filter((v) => v.isTemplate)
      .map((v) => ({
        vmid: v.vmid,
        name: v.name,
        kind: "qemu-template" as const,
        cloudInit: v.cloudInit,
        osHint: v.osHint,
      }));
  }

  async listVms(node: string): Promise<VmInfo[]> {
    return [...this.vms.values()]
      .filter((v) => !v.isTemplate)
      .map((v) => ({
        vmid: v.vmid,
        name: v.name,
        status: v.status,
        cores: v.cores,
        ramMb: v.ramMb,
        diskGb: v.diskGb,
      }));
  }

  async cloneTemplate(req: CloneRequest): Promise<TaskRef> {
    const template = this.vms.get(req.templateVmid);
    if (!template || !template.isTemplate) {
      // The clone task itself will resolve to error.
      return this.makeTask("clone", req.node, "error", "template not found");
    }
    // Create the VM now, but the orchestrator must wait for the task result
    // before treating it as done.
    if (!this.vms.has(req.newVmid)) {
      this.vms.set(req.newVmid, {
        vmid: req.newVmid,
        name: req.name,
        status: "stopped",
        cores: template.cores,
        ramMb: template.ramMb,
        diskGb: template.diskGb,
        isTemplate: false,
        cloudInit: true,
        osHint: template.osHint,
        guestAgent: template.guestAgent,
      });
    }
    return this.makeTask("clone", req.node, this.outcomeFor("clone"), this.opts.failNext?.clone);
  }

  async configureVm(req: ConfigureRequest): Promise<TaskRef> {
    const vm = this.vms.get(req.vmid);
    if (!vm) return this.makeTask("configure", req.node, "error", "vm not found");
    vm.cores = req.cores;
    vm.ramMb = req.ramMb;
    vm.diskGb = req.diskGb;
    vm.name = req.hostname;
    vm.ipConfig = req.ipConfig;
    if (req.ipConfig.includes("ip=dhcp")) {
      const base = this.opts.dhcpBase ?? "192.168.7.";
      vm.dhcpAddress = `${base}${this.dhcpCounter++}`;
    }
    return this.makeTask("configure", req.node, this.outcomeFor("configure"), this.opts.failNext?.configure);
  }

  async startVm(node: string, vmid: number): Promise<TaskRef> {
    const vm = this.vms.get(vmid);
    if (!vm) return this.makeTask("start", node, "error", "vm not found");
    vm.status = "running";
    return this.makeTask("start", node, this.outcomeFor("start"), this.opts.failNext?.start);
  }

  async deleteVm(node: string, vmid: number): Promise<TaskRef> {
    if (!this.vms.has(vmid)) return this.makeTask("delete", node, "error", "vm not found");
    this.vms.delete(vmid);
    return this.makeTask("delete", node, this.outcomeFor("delete"), this.opts.failNext?.delete);
  }

  async pollTask(ref: TaskRef): Promise<TaskResult> {
    const task = this.tasks.get(ref.upid);
    if (!task) return { status: "error", exitStatus: "unknown task" };
    if (task.pollsRemaining > 0) {
      task.pollsRemaining--;
      return { status: "running" };
    }
    if (task.outcome === "error") {
      return { status: "error", exitStatus: task.exitStatus ?? "task failed" };
    }
    return { status: "ok", exitStatus: "OK" };
  }

  async getGuestAddress(node: string, vmid: number): Promise<Ipv4 | null> {
    const vm = this.vms.get(vmid);
    if (!vm) return null;
    // DHCP readback requires the guest agent (mirrors real behavior / req §18.7).
    if (vm.ipConfig?.includes("ip=dhcp")) {
      if (!vm.guestAgent) return null;
      return vm.dhcpAddress ?? null;
    }
    // Manual/derived address is embedded in ipConfig: ip=A.B.C.D/xx
    const m = vm.ipConfig?.match(/ip=([\d.]+)\//);
    return m ? (m[1] as Ipv4) : null;
  }

  async describeVm(node: string, vmid: number): Promise<VmInfo | null> {
    const vm = this.vms.get(vmid);
    if (!vm) return null;
    return {
      vmid: vm.vmid,
      name: vm.name,
      status: vm.status,
      cores: vm.cores,
      ramMb: vm.ramMb,
      diskGb: vm.diskGb,
    };
  }

  // --- test/helper surface ---
  hasVm(vmid: number): boolean {
    return this.vms.has(vmid);
  }
  allocateVmid(): number {
    while (this.vms.has(this.nextVmid)) this.nextVmid++;
    return this.nextVmid;
  }

  private outcomeFor(kind: keyof NonNullable<FakeProxmoxOptions["failNext"]>): "ok" | "error" {
    return this.opts.failNext?.[kind] ? "error" : "ok";
  }

  private makeTask(
    kind: string,
    node: string,
    outcome: "ok" | "error",
    exitStatus?: string,
  ): TaskRef {
    const upid = `UPID:${node}:${String(++this.upidCounter).padStart(8, "0")}:${kind}`;
    this.tasks.set(upid, {
      upid,
      node,
      pollsRemaining: this.opts.pollsToResolve ?? 2,
      outcome,
      exitStatus,
      kind,
    });
    return { node, upid };
  }
}
