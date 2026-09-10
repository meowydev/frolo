// DEVELOPMENT-ONLY fake license issuer (req: monetization).
//
// ┌───────────────────────────────────────────────────────────────────────┐
// │  THIS IS NOT THE PRODUCTION ISSUER.                                     │
// │  - Keys generated here are marked environment: "development" and use a  │
// │    keyId prefixed "dev-fake-". Production builds refuse them.           │
// │  - The REAL private signing key lives ONLY in a separate, closed-source │
// │    service and must never be committed here (see                        │
// │    docs/PRIVATE_SERVICE_BOUNDARY.md).                                   │
// │  - This module exists so the app and tests can exercise the verifier    │
// │    without any production secret.                                       │
// └───────────────────────────────────────────────────────────────────────┘

import {
  generateKeyPairSync,
  sign as edSign,
  type KeyObject,
} from "node:crypto";
import type {
  FroloTier,
  LicensePayload,
  PublicVerificationKey,
  SignedLicense,
} from "@frolo/contracts";
import { canonicalJson } from "./canonical.js";

export const DEV_KEY_ID = "dev-fake-ed25519";

export interface DevIssuer {
  publicKey: PublicVerificationKey;
  issue(input: {
    subject: string;
    tier: FroloTier;
    issuedAt?: Date;
    validityDays?: number; // default 35 (req)
    graceDays?: number; // default 5 (req)
    licenseId?: string;
  }): SignedLicense;
}

// Extract the raw 32-byte ed25519 public key from a KeyObject (strip SPKI DER).
function rawPublicKey(pub: KeyObject): Buffer {
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  return der.subarray(der.length - 32);
}

// Guard: the dev issuer must never run in a production build. It is enabled ONLY
// when an explicit dev flag is present (FROLO_DEV=1 / FROLO_ALLOW_DEV_LICENSE_KEYS=1)
// or when NODE_ENV is not "production". Tests may bypass this via
// createDevIssuer({ force: true }). Production containers set NODE_ENV=production
// and no dev flag, so any accidental call throws instead of minting a key.
export function devIssuerAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FROLO_ALLOW_DEV_LICENSE_KEYS === "1") return true;
  if (env.FROLO_DEV === "1") return true;
  return env.NODE_ENV !== "production";
}

export interface CreateDevIssuerOptions {
  // Test-only escape hatch to construct the issuer regardless of environment.
  force?: boolean;
}

// Create a fresh, ephemeral dev issuer. The private key exists only in memory
// for the lifetime of the process (tests / local dev). It is never persisted.
export function createDevIssuer(opts: CreateDevIssuerOptions = {}): DevIssuer {
  if (!opts.force && !devIssuerAllowed()) {
    throw new Error(
      "createDevIssuer is disabled in production builds. Dev-fake licenses are refused. " +
        "Use the private frolo-server issuer for real licenses, or set FROLO_DEV=1 for local development.",
    );
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub: PublicVerificationKey = {
    keyId: DEV_KEY_ID,
    alg: "ed25519",
    publicKey: rawPublicKey(publicKey).toString("base64url"),
    environment: "development",
  };

  return {
    publicKey: pub,
    issue(input) {
      const issuedAt = input.issuedAt ?? new Date();
      const validityDays = input.validityDays ?? 35;
      const graceDays = input.graceDays ?? 5;
      const expiresAt = new Date(
        issuedAt.getTime() + validityDays * 24 * 60 * 60 * 1000,
      );
      const payload: LicensePayload = {
        v: 1,
        subject: input.subject,
        tier: input.tier,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        graceDays,
        licenseId: input.licenseId ?? `dev-${Date.now()}`,
        keyId: DEV_KEY_ID,
      };
      const message = Buffer.from(canonicalJson(payload), "utf8");
      const signature = edSign(null, message, privateKey).toString("base64url");
      return { payload, signature, alg: "ed25519" };
    },
  };
}
