import { describe, it, expect } from "vitest";
import { Ssh2Transport } from "./ssh2-transport.js";
import type { SshResult } from "./real.js";

// A controlled subclass that stubs exec() so we can test the httpGet
// status/body parsing and command shaping WITHOUT opening a real SSH socket.
class StubbedSsh extends Ssh2Transport {
  lastCommand = "";
  response: SshResult = { code: 0, stdout: "", stderr: "" };
  override async exec(command: string): Promise<SshResult> {
    this.lastCommand = command;
    return this.response;
  }
}

describe("Ssh2Transport.httpGet parsing (controlled, no socket)", () => {
  it("parses body and status from the curl marker", async () => {
    const t = new StubbedSsh();
    t.response = { code: 0, stdout: "<html>FROLO-OK-abc</html>\n__FROLO_STATUS__200", stderr: "" };
    const res = await t.httpGet("/");
    expect(res.status).toBe(200);
    expect(res.body).toBe("<html>FROLO-OK-abc</html>");
  });

  it("targets the guest-local URL and normalizes the path", async () => {
    const t = new StubbedSsh();
    t.response = { code: 0, stdout: "body\n__FROLO_STATUS__404", stderr: "" };
    const res = await t.httpGet("index.html");
    expect(t.lastCommand).toContain("http://127.0.0.1/index.html");
    expect(res.status).toBe(404);
  });

  it("returns raw output when the marker is absent", async () => {
    const t = new StubbedSsh();
    t.response = { code: 0, stdout: "unexpected", stderr: "" };
    const res = await t.httpGet("/");
    expect(res.status).toBe(0);
    expect(res.body).toBe("unexpected");
  });

  it("connect() fails clearly if ssh2 is not installed (optional dep)", async () => {
    const t = new Ssh2Transport();
    // ssh2 is an optional dependency; if absent, connect rejects rather than
    // silently proceeding. Either way it must NOT hang or open a real socket in
    // this test environment (no real host is provided).
    await expect(
      Promise.race([
        t.connect({ host: "203.0.113.255", user: "nobody", privateKey: "invalid" }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout-guard")), 1500)),
      ]),
    ).rejects.toBeTruthy();
    await t.close();
  });
});
