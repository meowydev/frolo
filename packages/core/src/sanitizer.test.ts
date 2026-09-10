import { describe, it, expect } from "vitest";
import { Sanitizer } from "./sanitizer.js";

describe("Sanitizer", () => {
  it("redacts Authorization headers", () => {
    const s = new Sanitizer();
    expect(s.sanitize("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(s.sanitize("Authorization: Bearer abc.def.ghi")).toContain("[REDACTED]");
  });

  it("redacts Proxmox API tokens", () => {
    const s = new Sanitizer();
    const out = s.sanitize("PVEAPIToken=root@pam!frolo=super-secret-uuid");
    expect(out).not.toContain("super-secret-uuid");
  });

  it("redacts cookies and CSRF tokens", () => {
    const s = new Sanitizer();
    expect(s.sanitize("Cookie: session=deadbeef")).not.toContain("deadbeef");
    expect(s.sanitize("CSRFPreventionToken: 12345:abcdef")).not.toContain("abcdef");
  });

  it("redacts PEM private key blocks", () => {
    const s = new Sanitizer();
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretkeymaterial\n-----END OPENSSH PRIVATE KEY-----";
    const out = s.sanitize(pem);
    expect(out).not.toContain("secretkeymaterial");
  });

  it("redacts key=value secrets", () => {
    const s = new Sanitizer();
    expect(s.sanitize("password=hunter2")).not.toContain("hunter2");
    expect(s.sanitize("token: abc123xyz")).not.toContain("abc123xyz");
  });

  it("redacts registered literal secrets verbatim", () => {
    const s = new Sanitizer();
    s.register("myPlaintextRouterPassword");
    const out = s.sanitize("the value was myPlaintextRouterPassword in a field");
    expect(out).not.toContain("myPlaintextRouterPassword");
    expect(out).toContain("[REDACTED]");
  });

  it("does not redact ordinary text", () => {
    const s = new Sanitizer();
    expect(s.sanitize("Clone task ok (upid UPID:node:0001)")).toContain("Clone task ok");
  });
});
