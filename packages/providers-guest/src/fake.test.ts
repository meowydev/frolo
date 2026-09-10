import { describe, it, expect } from "vitest";
import type { GuestTarget } from "@frolo/contracts";
import { FakeGuestProvider } from "./fake.js";

const target: GuestTarget = {
  address: "10.0.0.5",
  sshUser: "ubuntu",
  privateKeyRef: "guest_private_key:dep1",
  guestAgentAvailable: true,
};

describe("FakeGuestProvider", () => {
  it("runs the nginx recipe ops and serves the marker page", async () => {
    const g = new FakeGuestProvider();
    await g.waitReachable(target, 1000);
    expect((await g.run(target, { type: "pkg.install", packages: ["nginx"] })).ok).toBe(true);
    await g.run(
      target,
      { type: "file.write", path: "/var/www/html/index.html", contentRef: "frolo-index" },
      "<html>FROLO-OK-dep1</html>",
    );
    await g.run(target, { type: "service.enable", name: "nginx" });
    await g.run(target, { type: "service.start", name: "nginx" });

    const res = await g.httpGet(target, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("FROLO-OK-dep1");
    expect(g.isEnabled("nginx")).toBe(true);
    expect(g.isRunning("nginx")).toBe(true);
  });

  it("returns 502 before nginx is started", async () => {
    const g = new FakeGuestProvider();
    const res = await g.httpGet(target, "/");
    expect(res.status).toBe(502);
  });

  it("fails host-key verification on mismatch (TOFU)", async () => {
    const g = new FakeGuestProvider({ hostKeyFingerprint: "SHA256:real" });
    await expect(
      g.waitReachable({ ...target, hostKeyFingerprint: "SHA256:different" }, 1000),
    ).rejects.toThrow(/host key mismatch/);
  });

  it("honors the install failure knob", async () => {
    const g = new FakeGuestProvider({ failInstallPackages: ["nginx"] });
    const r = await g.run(target, { type: "pkg.install", packages: ["nginx"] });
    expect(r.ok).toBe(false);
  });

  it("honors the marker-missing knob (verification will fail)", async () => {
    const g = new FakeGuestProvider({ markerMissing: true });
    await g.run(
      target,
      { type: "file.write", path: "/var/www/html/index.html", contentRef: "frolo-index" },
      "<html>FROLO-OK-dep1</html>",
    );
    await g.run(target, { type: "service.start", name: "nginx" });
    const res = await g.httpGet(target, "/");
    expect(res.body).not.toContain("FROLO-OK-dep1");
  });

  it("fails when unreachable", async () => {
    const g = new FakeGuestProvider({ unreachable: true });
    await expect(g.waitReachable(target, 100)).rejects.toThrow();
  });
});
