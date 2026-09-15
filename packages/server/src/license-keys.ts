// Production public license-key loader (req: load 1+ Ed25519 PUBLIC verification
// keys from a mounted JSON file or an env var; NEVER a private key; fail safe to
// the free Home tier when nothing valid is configured).
//
// Sources, in priority order:
//   1) FROLO_LICENSE_KEYS_FILE  — path to a JSON file (mounted read-only)
//   2) FROLO_LICENSE_KEYS       — inline JSON
//
// Accepted JSON shapes (both work):
//   [ { keyId, alg:"ed25519", publicKey, environment } , ... ]
//   { "keys": [ ... ] }
//
// A key is accepted only if it is a well-formed PublicVerificationKey with a
// 32-byte base64url ed25519 public key. Anything that smells like a PRIVATE key
// (PEM markers, a `privateKey` field, an oversized blob) is rejected outright so
// an operator can never accidentally mount a signing secret into the app. If no
// valid key loads, we return [] and log a warning — the verifier then keeps the
// app on Home features (fail safe), never crashing.

import { readFileSync } from "node:fs";
import type { PublicVerificationKey } from "@frolo/contracts";

export interface LoadResult {
  keys: PublicVerificationKey[];
  // Non-fatal messages describing why individual entries were skipped, plus the
  // source that was used. Logged by the caller; never contains key material.
  warnings: string[];
  source: "file" | "env" | "none";
}

const PRIVATE_KEY_MARKERS = [
  "PRIVATE KEY",
  "BEGIN OPENSSH PRIVATE",
  "BEGIN RSA PRIVATE",
  "BEGIN EC PRIVATE",
  "BEGIN DSA PRIVATE",
];

export function loadPublicLicenseKeys(env: NodeJS.ProcessEnv = process.env): LoadResult {
  const warnings: string[] = [];

  let raw: string | undefined;
  let source: LoadResult["source"] = "none";
  const file = env.FROLO_LICENSE_KEYS_FILE?.trim();
  const inline = env.FROLO_LICENSE_KEYS?.trim();

  if (file) {
    try {
      raw = readFileSync(file, "utf8");
      source = "file";
    } catch (err) {
      warnings.push(`could not read FROLO_LICENSE_KEYS_FILE (${file}): ${errMsg(err)}`);
    }
  }
  if (raw === undefined && inline) {
    raw = inline;
    source = "env";
  }

  if (raw === undefined || raw === "") {
    return { keys: [], warnings, source: "none" };
  }

  // Guard: refuse the whole payload if it contains private-key material.
  const upper = raw.toUpperCase();
  if (PRIVATE_KEY_MARKERS.some((m) => upper.includes(m))) {
    warnings.push(
      "license key source contains PRIVATE KEY material and was REJECTED in full. " +
        "Only public verification keys belong in the app; keep signing keys in the private frolo-server.",
    );
    return { keys: [], warnings, source };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnings.push(`license key source is not valid JSON: ${errMsg(err)}`);
    return { keys: [], warnings, source };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.keys)
      ? parsed.keys
      : null;
  if (!list) {
    warnings.push('license key source must be an array or { "keys": [...] }');
    return { keys: [], warnings, source };
  }

  const keys: PublicVerificationKey[] = [];
  list.forEach((entry, i) => {
    const v = validateKey(entry, i);
    if (typeof v === "string") warnings.push(v);
    else keys.push(v);
  });

  if (keys.length === 0) {
    warnings.push("no valid production public license keys were loaded; running on the free Home tier.");
  }
  return { keys, warnings, source };
}

// Returns a validated key, or an error string describing why it was rejected.
function validateKey(entry: unknown, index: number): PublicVerificationKey | string {
  if (!isRecord(entry)) return `key[${index}]: not an object`;
  // Explicitly reject any field that would indicate a private key.
  if ("privateKey" in entry || "d" in entry || "secret" in entry) {
    return `key[${index}]: contains a private-key field and was rejected`;
  }
  const keyId = entry.keyId;
  const alg = entry.alg;
  const publicKey = entry.publicKey;
  const environment = entry.environment ?? "production";

  if (typeof keyId !== "string" || keyId.length === 0) return `key[${index}]: missing keyId`;
  if (alg !== "ed25519") return `key[${index}] (${keyId}): alg must be "ed25519"`;
  if (typeof publicKey !== "string" || publicKey.length === 0) return `key[${index}] (${keyId}): missing publicKey`;
  if (environment !== "production" && environment !== "development") {
    return `key[${index}] (${keyId}): environment must be "production" or "development"`;
  }
  // A raw ed25519 public key is exactly 32 bytes. Decode base64url and check.
  let decoded: Buffer;
  try {
    decoded = Buffer.from(publicKey, "base64url");
  } catch {
    return `key[${index}] (${keyId}): publicKey is not valid base64url`;
  }
  if (decoded.length !== 32) {
    return `key[${index}] (${keyId}): publicKey must decode to 32 bytes (got ${decoded.length}) — is this a raw ed25519 public key?`;
  }
  return { keyId, alg: "ed25519", publicKey, environment };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
