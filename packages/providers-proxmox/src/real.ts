// Real Proxmox provider (req §2, §11.6, Phase 8). Talks to a Proxmox VE API over
// HTTPS using a dedicated restricted API token. TLS validation is ON by default;
// a user-approved certificate fingerprint may be pinned for ONE connection
// (never a global rejectUnauthorized=false).
//
// SAFETY: This provider only connects when actually invoked. Real mode stays
// hidden in the UI until the Phase 8 safety tests pass, and NO test in this repo
// points it at a real host. All secret material (the token secret) is supplied
// by the caller from the vault and is never logged.

import { createHash } from "node:crypto";
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

export interface RealProxmoxConfig {
  host: string; // e.g. "https://pve.example:8006"
  node: string;
  tokenId: string; // e.g. "frolo@pve!deploy"
  tokenSecret: string; // supplied from the vault; never logged
  // If set, the server certificate's SHA-256 fingerprint MUST match this pinned
  // value (self-signed homelab certs). If unset, standard CA validation applies.
  pinnedCertSha256?: string;
}

// A minimal HTTP transport seam so the provider is unit-testable without a real
// TLS socket. The real desktop app supplies a fetch/undici-based transport that
// enforces the certificate pin; tests supply a fake transport and NEVER a socket.
export interface HttpsTransport {
  request(input: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: string;
    // The transport must verify the pinned fingerprint if provided.
    pinnedCertSha256?: string;
  }): Promise<{ status: number; json: unknown; certSha256?: string }>;
}

export class CertificatePinMismatch extends Error {}

export class RealProxmoxProvider implements ProxmoxProvider {
  constructor(
    private readonly config: RealProxmoxConfig,
    private readonly transport: HttpsTransport,
  ) {}

  private authHeader(): Record<string, string> {
    // PVEAPIToken=USER@REALM!TOKENID=SECRET — sanitizer redacts this pattern if
    // it ever reaches a log, but we never log headers.
    return {
      Authorization: `PVEAPIToken=${this.config.tokenId}=${this.config.tokenSecret}`,
    };
  }

  private async call(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const res = await this.transport.request({
      method,
      path: `${this.config.host}/api2/json${path}`,
      headers: { ...this.authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body: body ? new URLSearchParams(body as Record<string, string>).toString() : undefined,
      pinnedCertSha256: this.config.pinnedCertSha256,
    });
    // Defense in depth: if the transport reported the cert fingerprint, verify it.
    if (this.config.pinnedCertSha256 && res.certSha256 && res.certSha256 !== this.config.pinnedCertSha256) {
      throw new CertificatePinMismatch("Proxmox certificate fingerprint does not match the pinned value");
    }
    if (res.status >= 400) {
      throw new Error(`Proxmox API ${method} ${path} failed with status ${res.status}`);
    }
    return res.json;
  }

  async validate(): Promise<CapabilityReport> {
    const data = (await this.call("GET", `/nodes/${this.config.node}/status`)) as { data?: unknown };
    return {
      ok: Boolean(data),
      node: this.config.node,
      canClone: true,
      canConfigure: true,
      canStart: true,
      canDelete: true,
      detail: "connected to Proxmox node",
    };
  }

  async listTemplates(node: string): Promise<TemplateInfo[]> {
    const data = (await this.call("GET", `/nodes/${node}/qemu`)) as { data?: RawVm[] };
    return (data.data ?? [])
      .filter((v) => v.template === 1)
      .map((v) => ({
        vmid: v.vmid,
        name: v.name ?? `vm-${v.vmid}`,
        kind: "qemu-template" as const,
        cloudInit: true, // determined more precisely via config in a follow-up
        osHint: undefined,
      }));
  }

  async listVms(node: string): Promise<VmInfo[]> {
    const data = (await this.call("GET", `/nodes/${node}/qemu`)) as { data?: RawVm[] };
    return (data.data ?? [])
      .filter((v) => v.template !== 1)
      .map((v) => ({
        vmid: v.vmid,
        name: v.name ?? `vm-${v.vmid}`,
        status: v.status === "running" ? "running" : v.status === "stopped" ? "stopped" : "unknown",
        cores: v.cpus,
        ramMb: v.maxmem ? Math.round(v.maxmem / (1024 * 1024)) : undefined,
        diskGb: v.maxdisk ? Math.round(v.maxdisk / (1024 * 1024 * 1024)) : undefined,
      }));
  }

  async cloneTemplate(req: CloneRequest): Promise<TaskRef> {
    const upid = await this.callForUpid("POST", `/nodes/${req.node}/qemu/${req.templateVmid}/clone`, {
      newid: req.newVmid,
      name: req.name,
      full: 1,
    });
    return { node: req.node, upid };
  }

  async configureVm(req: ConfigureRequest): Promise<TaskRef> {
    // cloud-init user + key + ipconfig + resources.
    await this.call("POST", `/nodes/${req.node}/qemu/${req.vmid}/config`, {
      cores: req.cores,
      memory: req.ramMb,
      ciuser: req.sshUser,
      sshkeys: encodeURIComponent(req.sshPublicKey),
      ipconfig0: req.ipConfig,
      name: req.hostname,
    });
    // config is synchronous in Proxmox; represent as an already-complete task.
    return { node: req.node, upid: `SYNC:${req.node}:configure:${req.vmid}` };
  }

  async startVm(node: string, vmid: number): Promise<TaskRef> {
    const upid = await this.callForUpid("POST", `/nodes/${node}/qemu/${vmid}/status/start`);
    return { node, upid };
  }

  async deleteVm(node: string, vmid: number): Promise<TaskRef> {
    const upid = await this.callForUpid("DELETE", `/nodes/${node}/qemu/${vmid}`);
    return { node, upid };
  }

  async pollTask(ref: TaskRef): Promise<TaskResult> {
    if (ref.upid.startsWith("SYNC:")) return { status: "ok", exitStatus: "OK" };
    const data = (await this.call("GET", `/nodes/${ref.node}/tasks/${encodeURIComponent(ref.upid)}/status`)) as {
      data?: { status?: string; exitstatus?: string };
    };
    const status = data.data?.status;
    if (status === "running") return { status: "running" };
    const exit = data.data?.exitstatus ?? "";
    return exit === "OK" ? { status: "ok", exitStatus: exit } : { status: "error", exitStatus: exit || "task failed" };
  }

  async getGuestAddress(node: string, vmid: number): Promise<Ipv4 | null> {
    // Requires the QEMU guest agent for DHCP readback (req §18.6/18.7).
    try {
      const data = (await this.call(
        "GET",
        `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`,
      )) as { data?: { result?: AgentIface[] } };
      for (const iface of data.data?.result ?? []) {
        for (const addr of iface["ip-addresses"] ?? []) {
          if (addr["ip-address-type"] === "ipv4" && !addr["ip-address"].startsWith("127.")) {
            return addr["ip-address"];
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async describeVm(node: string, vmid: number): Promise<VmInfo | null> {
    try {
      const data = (await this.call("GET", `/nodes/${node}/qemu/${vmid}/status/current`)) as {
        data?: { name?: string; status?: string; cpus?: number; maxmem?: number; maxdisk?: number };
      };
      const d = data.data;
      if (!d) return null;
      return {
        vmid,
        name: d.name ?? `vm-${vmid}`,
        status: d.status === "running" ? "running" : d.status === "stopped" ? "stopped" : "unknown",
        cores: d.cpus,
        ramMb: d.maxmem ? Math.round(d.maxmem / (1024 * 1024)) : undefined,
        diskGb: d.maxdisk ? Math.round(d.maxdisk / (1024 * 1024 * 1024)) : undefined,
      };
    } catch {
      return null;
    }
  }

  private async callForUpid(method: string, path: string, body?: Record<string, unknown>): Promise<string> {
    const data = (await this.call(method, path, body)) as { data?: string };
    if (typeof data.data !== "string") throw new Error("Proxmox did not return a task UPID");
    return data.data;
  }
}

// Compute a SHA-256 fingerprint from a DER certificate buffer (helper for the
// pinning flow: shown to the user for approval).
export function certFingerprint(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex");
}

interface RawVm {
  vmid: number;
  name?: string;
  status?: string;
  template?: number;
  cpus?: number;
  maxmem?: number;
  maxdisk?: number;
}
interface AgentIface {
  "ip-addresses"?: { "ip-address-type": string; "ip-address": string }[];
}
