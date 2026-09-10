import { describe, it, expect } from "vitest";
import type { GuestTarget } from "@frolo/contracts";
import { RealGuestProvider, HostKeyMismatch, type SshTransport, type SshResult } from "./real.js";

// A fake SSH transport that records commands and never opens a socket.
class FakeSsh implements SshTransport {
  commands: string[] = [];
  presentedFp = "SHA256:server-key";
  files = new Map<string, string>();
  nginxRunning = false;

  async connect(): Promise<{ presentedHostKeyFingerprint: string }> {
    return { presentedHostKeyFingerprint: this.presentedFp };
  }
  async exec(command: string): Promise<SshResult> {
    this.commands.push(command);
    if (command.includes("systemctl restart 'nginx'")) this.nginxRunning = true;
    return { code: 0, stdout: "", stderr: "" };
  }
  async httpGet(_path: string): Promise<{ status: number; body: string }> {
    return this.nginxRunning ? { status: 200, body: "FROLO-OK-x" } : { status: 502, body: "" };
  }
  async close(): Promise<void> {}
}

const target: GuestTarget = {
  address: "10.0.0.5",
  sshUser: "ubuntu",
  privateKeyRef: "guest_private_key:dep1",
  hostKeyFingerprint: "SHA256:server-key",
  guestAgentAvailable: true,
};

function providerWith(ssh: FakeSsh): RealGuestProvider {
  return new RealGuestProvider({
    resolvePrivateKey: async () => "FAKE-KEY",
    transport: ssh,
  });
}

describe("RealGuestProvider (fake SSH, no sockets)", () => {
  it("runs recipe ops as fixed non-arbitrary commands", async () => {
    const ssh = new FakeSsh();
    const p = providerWith(ssh);
    await p.waitReachable(target, 1000);
    await p.run(target, { type: "pkg.install", packages: ["nginx"] });
    await p.run(target, { type: "file.write", path: "/var/www/html/index.html", contentRef: "x" }, "<html>FROLO-OK-x</html>");
    await p.run(target, { type: "service.enable", name: "nginx" });
    await p.run(target, { type: "service.start", name: "nginx" });
    expect(ssh.commands.some((c) => c.includes("apt-get install -y 'nginx'"))).toBe(true);
    expect(ssh.commands.some((c) => c.includes("systemctl enable 'nginx'"))).toBe(true);
    const res = await p.httpGet(target, "/");
    expect(res.status).toBe(200);
  });

  it("enforces TOFU host-key verification", async () => {
    const ssh = new FakeSsh();
    ssh.presentedFp = "SHA256:DIFFERENT";
    const p = providerWith(ssh);
    await expect(p.waitReachable(target, 1000)).rejects.toThrow(HostKeyMismatch);
  });
});
