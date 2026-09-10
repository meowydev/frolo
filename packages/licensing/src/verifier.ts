// Offline signed-license verifier (req: monetization). The desktop app ships
// ONLY the public key(s). This module verifies an Ed25519 signature over the
// canonical payload and computes entitlements. It never contains a private key.

import { verify as edVerify } from "node:crypto";
import type {
  Entitlements,
  Feature,
  FroloTier,
  LicenseStatus,
  PublicVerificationKey,
  SignedLicense,
} from "@frolo/contracts";
import { FEATURES, TIER_DISPLAY_NAMES, signedLicenseSchema } from "@frolo/contracts";
import { canonicalJson } from "./canonical.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

// Verify the signature and time-window; produce a LicenseStatus. `now` is
// injectable for testing.
export function verifyLicense(
  signed: unknown,
  keys: PublicVerificationKey[],
  now: Date,
  opts: { allowDevKeys: boolean },
): LicenseStatus {
  const parsed = signedLicenseSchema.safeParse(signed);
  if (!parsed.success) {
    return { state: "invalid", tier: "home", reason: "malformed license" };
  }
  const license = parsed.data as SignedLicense;

  if (license.alg !== "ed25519") {
    return { state: "invalid", tier: "home", reason: "unsupported algorithm" };
  }

  const key = keys.find((k) => k.keyId === license.payload.keyId);
  if (!key) {
    return { state: "invalid", tier: "home", reason: "unknown key id" };
  }
  if (key.environment === "development" && !opts.allowDevKeys) {
    return {
      state: "invalid",
      tier: "home",
      reason: "development license rejected in production build",
    };
  }

  // Verify signature over canonical payload.
  const message = Buffer.from(canonicalJson(license.payload), "utf8");
  let ok = false;
  try {
    const pub = createEd25519PublicKey(key.publicKey);
    ok = edVerify(null, message, pub, b64urlToBuf(license.signature));
  } catch {
    ok = false;
  }
  if (!ok) {
    return { state: "invalid", tier: "home", reason: "bad signature" };
  }

  const issued = Date.parse(license.payload.issuedAt);
  const expires = Date.parse(license.payload.expiresAt);
  if (Number.isNaN(issued) || Number.isNaN(expires)) {
    return { state: "invalid", tier: "home", reason: "bad dates" };
  }
  const t = now.getTime();
  if (t < issued) {
    return { state: "invalid", tier: "home", reason: "not yet valid" };
  }

  const graceEnds = expires + license.payload.graceDays * DAY_MS;

  if (t <= expires) {
    return {
      state: "active",
      tier: license.payload.tier,
      expiresAt: license.payload.expiresAt,
      licenseId: license.payload.licenseId,
    };
  }
  if (t <= graceEnds) {
    return {
      state: "grace",
      tier: license.payload.tier,
      expiresAt: license.payload.expiresAt,
      graceEndsAt: new Date(graceEnds).toISOString(),
      licenseId: license.payload.licenseId,
    };
  }
  // Expired: revert entitlements to Home. Never touches infra (req).
  return {
    state: "expired",
    tier: "home",
    previousTier: license.payload.tier,
    expiredAt: license.payload.expiresAt,
    licenseId: license.payload.licenseId,
  };
}

// Node's crypto needs a KeyObject; build one from a raw 32-byte ed25519 public
// key by wrapping it in the DER SubjectPublicKeyInfo prefix.
import { createPublicKey } from "node:crypto";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function createEd25519PublicKey(b64urlRaw: string) {
  const raw = b64urlToBuf(b64urlRaw);
  if (raw.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

// Which tiers include which features. Home features are always on.
const TIER_FEATURES: Record<FroloTier, Feature[]> = {
  home: ["core_deployment", "teach_mode"],
  advanced_user: [
    "core_deployment",
    "teach_mode",
    "multi_router_chains",
    "parallel_deployments",
    "deployment_templates_export",
  ],
  powerfullness: [
    "core_deployment",
    "teach_mode",
    "multi_router_chains",
    "parallel_deployments",
    "deployment_templates_export",
    "unlimited_router_hops",
    "priority_recipe_catalog",
    "advanced_audit_export",
  ],
};

function featureMap(tier: FroloTier): Record<Feature, boolean> {
  const on = new Set(TIER_FEATURES[tier]);
  const map = {} as Record<Feature, boolean>;
  for (const f of FEATURES) map[f] = on.has(f);
  return map;
}

export function computeEntitlements(status: LicenseStatus): Entitlements {
  // effectiveTier: active/grace keep the paid tier; expired/invalid/none => home.
  let effectiveTier: FroloTier;
  let explanation: string;

  switch (status.state) {
    case "active":
      effectiveTier = status.tier;
      explanation = `${TIER_DISPLAY_NAMES[status.tier]} is active until ${humanDate(status.expiresAt)}.`;
      break;
    case "grace":
      effectiveTier = status.tier;
      explanation =
        `${TIER_DISPLAY_NAMES[status.tier]} expired on ${humanDate(status.expiresAt)}. ` +
        `You are in the grace period until ${humanDate(status.graceEndsAt)}. ` +
        `Renew via Boosty to keep paid conveniences. Your VMs, mappings, recipes and deployments are untouched.`;
      break;
    case "expired":
      effectiveTier = "home";
      explanation =
        `Your ${TIER_DISPLAY_NAMES[status.previousTier]} subscription expired on ${humanDate(status.expiredAt)}. ` +
        `Paid conveniences are paused and Frolo is back on the free Frolo Home tier. ` +
        `Nothing was deleted or stopped — your VMs, router mappings, recipes, files and deployments are exactly as you left them. ` +
        `Renew via Boosty to re-enable paid features.`;
      break;
    case "invalid":
      effectiveTier = "home";
      explanation =
        `That license could not be verified (${status.reason}). Running on the free Frolo Home tier. ` +
        `Nothing was changed on your infrastructure.`;
      break;
    case "none":
    default:
      effectiveTier = "home";
      explanation = `Running on the free Frolo Home tier. Local deployment and Teach Mode are included.`;
      break;
  }

  return {
    status,
    effectiveTier,
    features: featureMap(effectiveTier),
    explanation,
  };
}

function humanDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}
