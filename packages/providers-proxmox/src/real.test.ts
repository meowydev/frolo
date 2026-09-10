import { describe, it, expect } from "vitest";
import { RealProxmoxProvider, CertificatePinMismatch, type HttpsTransport } from "./real.js";

// A fake HTTPS transport. It NEVER opens a socket; it records requests and
// returns canned JSON. This lets us verify the real provider's request shaping,
// auth handling, task polling, and cert-pin enforcement without a real host.
class FakeTransport implements HttpsTransport {
  requests: { method: string; path: string; headers: Record<string, string>; body?: string }[] = [];
  responder: (req: { method: string; path: string }) => { status: number; json: unknown; certSha256?: string };

  constructor(responder: FakeTransport["responder"]) {
    this.responder = responder;
  }
  async request(input: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: string;
    pinnedCertSha256?: string;
  }) {
    this.requests.push({ method: input.method, path: input.path, headers: input.headers, body: input.body });
    return this.responder({ method: input.method, path: input.path });
  }
}

const cfg = {
  host: "https://pve.example:8006",
  node: "pve",
  tokenId: "frolo@pve!deploy",
  tokenSecret: "super-secret-token",
};

describe("RealProxmoxProvider (fake transport, no sockets)", () => {
  it("sends the API token auth header and never a socket", async () => {
    const t = new FakeTransport(() => ({ status: 200, json: { data: {} } }));
    const p = new RealProxmoxProvider(cfg, t);
    await p.validate();
    expect(t.requests[0]!.headers.Authorization).toContain("PVEAPIToken=frolo@pve!deploy=");
  });

  it("lists only templates", async () => {
    const t = new FakeTransport(() => ({
      status: 200,
      json: { data: [
        { vmid: 9000, name: "tmpl", template: 1 },
        { vmid: 100, name: "vm", template: 0, status: "running" },
      ] },
    }));
    const p = new RealProxmoxProvider(cfg, t);
    const templates = await p.listTemplates("pve");
    expect(templates).toHaveLength(1);
    expect(templates[0]!.vmid).toBe(9000);
  });

  it("polls a task to completion", async () => {
    let calls = 0;
    const t = new FakeTransport(({ path }) => {
      if (path.includes("/clone")) return { status: 200, json: { data: "UPID:pve:clone:1" } };
      // task status: running then ok
      calls++;
      return { status: 200, json: { data: { status: calls < 2 ? "running" : "stopped", exitstatus: calls < 2 ? undefined : "OK" } } };
    });
    const p = new RealProxmoxProvider(cfg, t);
    const ref = await p.cloneTemplate({ node: "pve", templateVmid: 9000, newVmid: 101, name: "web" });
    expect((await p.pollTask(ref)).status).toBe("running");
    expect((await p.pollTask(ref)).status).toBe("ok");
  });

  it("enforces a certificate pin mismatch", async () => {
    const t = new FakeTransport(() => ({ status: 200, json: { data: {} }, certSha256: "actual-fingerprint" }));
    const p = new RealProxmoxProvider({ ...cfg, pinnedCertSha256: "expected-different" }, t);
    await expect(p.validate()).rejects.toThrow(CertificatePinMismatch);
  });
});
