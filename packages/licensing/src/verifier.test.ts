import { describe, it, expect } from "vitest";
import { createDevIssuer } from "./dev-issuer.js";
import { verifyLicense, computeEntitlements } from "./verifier.js";

const DAY = 24 * 60 * 60 * 1000;

describe("license verifier", () => {
  it("verifies a valid dev license as active", () => {
    const issuer = createDevIssuer();
    const now = new Date("2026-01-01T00:00:00Z");
    const lic = issuer.issue({ subject: "device-123", tier: "advanced_user", issuedAt: now });
    const status = verifyLicense(lic, [issuer.publicKey], now, { allowDevKeys: true });
    expect(status.state).toBe("active");
    if (status.state === "active") expect(status.tier).toBe("advanced_user");
  });

  it("uses 35-day validity by default and enters grace after expiry", () => {
    const issuer = createDevIssuer();
    const issuedAt = new Date("2026-01-01T00:00:00Z");
    const lic = issuer.issue({ subject: "d", tier: "powerfullness", issuedAt });

    // Day 36 (1 day after 35-day expiry) => grace (5-day window)
    const day36 = new Date(issuedAt.getTime() + 36 * DAY);
    const grace = verifyLicense(lic, [issuer.publicKey], day36, { allowDevKeys: true });
    expect(grace.state).toBe("grace");

    // Day 41 (>35+5) => expired
    const day41 = new Date(issuedAt.getTime() + 41 * DAY);
    const expired = verifyLicense(lic, [issuer.publicKey], day41, { allowDevKeys: true });
    expect(expired.state).toBe("expired");
  });

  it("rejects a tampered payload", () => {
    const issuer = createDevIssuer();
    const now = new Date("2026-01-01T00:00:00Z");
    const lic = issuer.issue({ subject: "d", tier: "home", issuedAt: now });
    const tampered = {
      ...lic,
      payload: { ...lic.payload, tier: "powerfullness" as const },
    };
    const status = verifyLicense(tampered, [issuer.publicKey], now, { allowDevKeys: true });
    expect(status.state).toBe("invalid");
  });

  it("rejects dev keys when dev keys are not allowed (production build)", () => {
    const issuer = createDevIssuer();
    const now = new Date("2026-01-01T00:00:00Z");
    const lic = issuer.issue({ subject: "d", tier: "advanced_user", issuedAt: now });
    const status = verifyLicense(lic, [issuer.publicKey], now, { allowDevKeys: false });
    expect(status.state).toBe("invalid");
  });

  it("rejects an unknown key id", () => {
    const a = createDevIssuer();
    const b = createDevIssuer();
    const now = new Date("2026-01-01T00:00:00Z");
    const lic = a.issue({ subject: "d", tier: "home", issuedAt: now });
    // verify with only b's key -> keyId matches (same DEV_KEY_ID) but signature fails
    const status = verifyLicense(lic, [b.publicKey], now, { allowDevKeys: true });
    expect(status.state).toBe("invalid");
  });
});

describe("entitlements", () => {
  it("home has core + teach mode only", () => {
    const ent = computeEntitlements({ state: "none", tier: "home" });
    expect(ent.effectiveTier).toBe("home");
    expect(ent.features.core_deployment).toBe(true);
    expect(ent.features.teach_mode).toBe(true);
    expect(ent.features.multi_router_chains).toBe(false);
  });

  it("expired reverts to home but explanation reassures nothing is deleted", () => {
    const ent = computeEntitlements({
      state: "expired",
      tier: "home",
      previousTier: "powerfullness",
      expiredAt: "2026-02-01T00:00:00Z",
      licenseId: "x",
    });
    expect(ent.effectiveTier).toBe("home");
    expect(ent.explanation.toLowerCase()).toContain("nothing was deleted");
  });

  it("grace keeps paid tier active", () => {
    const ent = computeEntitlements({
      state: "grace",
      tier: "advanced_user",
      expiresAt: "2026-02-01T00:00:00Z",
      graceEndsAt: "2026-02-06T00:00:00Z",
      licenseId: "x",
    });
    expect(ent.effectiveTier).toBe("advanced_user");
    expect(ent.features.multi_router_chains).toBe(true);
  });
});
