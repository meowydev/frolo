// Public entitlement contract (req: monetization).
//
// IMPORTANT SECURITY NOTE:
// - The desktop app contains ONLY the public verification key.
// - The private signing key lives exclusively in a separate, closed-source
//   issuer service. It MUST NEVER appear in this repository, builds, fixtures,
//   logs, or tests. See docs/PRIVATE_SERVICE_BOUNDARY.md.
// - Because distributed client code can be inspected, entitlement authenticity
//   is protected by asymmetric signatures, not by hiding client logic.

export const FROLO_TIERS = ["home", "advanced_user", "powerfullness"] as const;
export type FroloTier = (typeof FROLO_TIERS)[number];

// Human-facing tier names (spelling intentional per product decision).
export const TIER_DISPLAY_NAMES: Record<FroloTier, string> = {
  home: "Frolo Home",
  advanced_user: "Frolo AdvancedUser",
  powerfullness: "Frolo Powerfullness",
};

// Features that can be gated. Home always includes core deployment + Teach Mode.
export const FEATURES = [
  // Home (free) — always available:
  "core_deployment",
  "teach_mode",
  // AdvancedUser:
  "multi_router_chains",
  "parallel_deployments",
  "deployment_templates_export",
  // Powerfullness:
  "unlimited_router_hops",
  "priority_recipe_catalog",
  "advanced_audit_export",
] as const;
export type Feature = (typeof FEATURES)[number];

// The signed license payload. Everything the verifier needs, plus binding.
export interface LicensePayload {
  // Schema version of the entitlement contract.
  v: 1;
  // Opaque Frolo account or device code the supporter provided on Boosty.
  subject: string;
  tier: FroloTier;
  // ISO timestamps. issuedAt <= now; expiresAt defines paid validity (req: 35d).
  issuedAt: string;
  expiresAt: string;
  // Grace period in days after expiresAt where conveniences still work (req: 5d).
  graceDays: number;
  // Unique license id for audit / revocation-list use by the private service.
  licenseId: string;
  // Which key issued this (e.g. "dev-fake-2026", "prod-2026"). Lets the app
  // refuse dev keys in production builds.
  keyId: string;
}

// The distributable license file: base64url(payload) + detached signature.
export interface SignedLicense {
  payload: LicensePayload;
  // base64url Ed25519 signature over the canonical JSON of `payload`.
  signature: string;
  // Which algorithm was used. Only "ed25519" is accepted in v1.
  alg: "ed25519";
}

// Result of offline verification inside the desktop app.
export type LicenseStatus =
  | { state: "none"; tier: "home" }
  | { state: "active"; tier: FroloTier; expiresAt: string; licenseId: string }
  | {
      state: "grace";
      tier: FroloTier;
      expiresAt: string;
      graceEndsAt: string;
      licenseId: string;
    }
  | {
      state: "expired";
      // Expired reverts entitlements to Home; VMs/mappings/etc are untouched.
      tier: "home";
      previousTier: FroloTier;
      expiredAt: string;
      licenseId: string;
    }
  | { state: "invalid"; tier: "home"; reason: string };

export interface Entitlements {
  status: LicenseStatus;
  effectiveTier: FroloTier;
  features: Record<Feature, boolean>;
  // A short, honest, user-facing explanation of the current status.
  explanation: string;
}

// Public key material shipped in the app (NON-SECRET).
export interface PublicVerificationKey {
  keyId: string;
  alg: "ed25519";
  // base64url raw public key.
  publicKey: string;
  // Marks dev/test keys so production builds can refuse them.
  environment: "development" | "production";
}
