// Task 8: dev issuer must be gated out of production builds and dev-signed
// licenses must be refused unless an explicit dev flag is set.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevIssuer, devIssuerAllowed } from "./dev-issuer.js";
import { verifyLicense } from "./verifier.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dev issuer production gating", () => {
  it("allows the dev issuer outside production (default test/dev env)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("FROLO_DEV", "");
    vi.stubEnv("FROLO_ALLOW_DEV_LICENSE_KEYS", "");
    expect(devIssuerAllowed()).toBe(true);
    expect(() => createDevIssuer()).not.toThrow();
  });

  it("refuses to create a dev issuer in production without a flag", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FROLO_DEV", "");
    vi.stubEnv("FROLO_ALLOW_DEV_LICENSE_KEYS", "");
    expect(devIssuerAllowed()).toBe(false);
    expect(() => createDevIssuer()).toThrow(/disabled in production/i);
  });

  it("allows the dev issuer in production only with an explicit dev flag", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FROLO_DEV", "1");
    expect(devIssuerAllowed()).toBe(true);
    expect(() => createDevIssuer()).not.toThrow();
  });

  it("can be forced for tests regardless of environment", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FROLO_DEV", "");
    vi.stubEnv("FROLO_ALLOW_DEV_LICENSE_KEYS", "");
    const issuer = createDevIssuer({ force: true });
    expect(issuer.publicKey.environment).toBe("development");
  });

  it("a production verifier (allowDevKeys=false) refuses a dev-signed license", () => {
    const issuer = createDevIssuer({ force: true });
    const now = new Date("2026-01-01T00:00:00Z");
    const lic = issuer.issue({ subject: "d", tier: "powerfullness", issuedAt: now });
    const status = verifyLicense(lic, [issuer.publicKey], now, { allowDevKeys: false });
    expect(status.state).toBe("invalid");
    expect(status.tier).toBe("home");
  });
});
