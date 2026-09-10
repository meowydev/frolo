import { describe, it, expect } from "vitest";
import type { TaskRef } from "@frolo/contracts";
import { FakeProxmoxProvider } from "./fake.js";

async function pollToEnd(p: FakeProxmoxProvider, ref: TaskRef) {
  let r = await p.pollTask(ref);
  let guard = 0;
  while (r.status === "running" && guard++ < 20) r = await p.pollTask(ref);
  return r;
}

describe("FakeProxmoxProvider", () => {
  it("lists only QEMU cloud-init templates", async () => {
    const p = new FakeProxmoxProvider();
    const templates = await p.listTemplates("pve");
    expect(templates.length).toBeGreaterThanOrEqual(2);
    expect(templates.every((t) => t.kind === "qemu-template" && t.cloudInit)).toBe(true);
  });

  it("clone returns a task that resolves asynchronously (not instantly ok)", async () => {
    const p = new FakeProxmoxProvider({ pollsToResolve: 2 });
    const vmid = p.allocateVmid();
    const ref = await p.cloneTemplate({ node: "pve", templateVmid: 9000, newVmid: vmid, name: "web" });
    // First poll should still be running.
    expect((await p.pollTask(ref)).status).toBe("running");
    expect((await pollToEnd(p, ref)).status).toBe("ok");
    expect(p.hasVm(vmid)).toBe(true);
  });

  it("configure with DHCP yields a readback address only with guest agent", async () => {
    const p = new FakeProxmoxProvider();
    const vmid = p.allocateVmid();
    await pollToEnd(p, await p.cloneTemplate({ node: "pve", templateVmid: 9000, newVmid: vmid, name: "web" }));
    await pollToEnd(
      p,
      await p.configureVm({
        node: "pve",
        vmid,
        cores: 2,
        ramMb: 2048,
        diskGb: 10,
        hostname: "web",
        ipConfig: "ip=dhcp",
        sshUser: "ubuntu",
        sshPublicKey: "ssh-ed25519 AAAA...",
      }),
    );
    const addr = await p.getGuestAddress("pve", vmid);
    expect(addr).toMatch(/^192\.168\.7\./);
  });

  it("scripted failure resolves the task to error", async () => {
    const p = new FakeProxmoxProvider({ failNext: { clone: "disk full" } });
    const vmid = p.allocateVmid();
    const ref = await p.cloneTemplate({ node: "pve", templateVmid: 9000, newVmid: vmid, name: "web" });
    const res = await pollToEnd(p, ref);
    expect(res.status).toBe("error");
    expect(res.exitStatus).toBe("disk full");
  });

  it("delete removes the VM and describeVm reflects it (reconciliation)", async () => {
    const p = new FakeProxmoxProvider();
    const vmid = p.allocateVmid();
    await pollToEnd(p, await p.cloneTemplate({ node: "pve", templateVmid: 9000, newVmid: vmid, name: "web" }));
    expect(await p.describeVm("pve", vmid)).not.toBeNull();
    await pollToEnd(p, await p.deleteVm("pve", vmid));
    expect(await p.describeVm("pve", vmid)).toBeNull();
  });
});
