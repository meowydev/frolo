// Public license-key loader (task 6). Verifies: env + file sources, shape
// validation, 32-byte ed25519 check, private-key rejection, and fail-safe
// (empty -> Home tier) behavior. No network, no real keys.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPublicLicenseKeys } from "./license-keys.js";

// A genuine 32-byte ed25519 public key encoded as base64url (raw key only).
function rawEd25519Base64url(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return der.subarray(der.length - 32).toString("base64url");
}

function prodKey() {
  return { keyId: "frolo-prod-1", alg: "ed25519", publicKey: rawEd25519Base64url(), environment: "production" };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "frolo-lic-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadPublicLicenseKeys", () => {
  it("returns no keys and no warnings when nothing is configured", () => {
    const r = loadPublicLicenseKeys({});
    expect(r.keys).toEqual([]);
    expect(r.source).toBe("none");
    expect(r.warnings).toEqual([]);
  });

  it("loads a valid production key from inline env JSON (array form)", () => {
    const k = prodKey();
    const r = loadPublicLicenseKeys({ FROLO_LICENSE_KEYS: JSON.stringify([k]) });
    expect(r.source).toBe("env");
    expect(r.keys).toHaveLength(1);
    expect(r.keys[0]!.keyId).toBe("frolo-prod-1");
    expect(r.keys[0]!.environment).toBe("production");
  });

  it('accepts the { "keys": [...] } object form', () => {
    const r = loadPublicLicenseKeys({ FROLO_LICENSE_KEYS: JSON.stringify({ keys: [prodKey()] }) });
    expect(r.keys).toHaveLength(1);
  });

  it("loads from a file and prefers the file over inline env", () => {
    const fileKey = { ...prodKey(), keyId: "from-file" };
    const p = join(dir, "keys.json");
    writeFileSync(p, JSON.stringify([fileKey]));
    const r = loadPublicLicenseKeys({
      FROLO_LICENSE_KEYS_FILE: p,
      FROLO_LICENSE_KEYS: JSON.stringify([{ ...prodKey(), keyId: "from-env" }]),
    });
    expect(r.source).toBe("file");
    expect(r.keys.map((k) => k.keyId)).toEqual(["from-file"]);
  });

  it("REJECTS the whole payload if it contains PEM private-key material", () => {
    const poisoned =
      "-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----\n" + JSON.stringify([prodKey()]);
    const r = loadPublicLicenseKeys({ FROLO_LICENSE_KEYS: poisoned });
    expect(r.keys).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/PRIVATE KEY material and was REJECTED/i);
  });

  it("rejects an entry that carries a privateKey field", () => {
    const bad = { ...prodKey(), privateKey: "should-not-be-here" };
    const r = loadPublicLicenseKeys({ FROLO_LICENSE_KEYS: JSON.stringify([bad]) });
    expect(r.keys).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/private-key field/i);
  });

  it("rejects a publicKey that does not decode to 32 bytes", () => {
    const bad = { keyId: "x", alg: "ed25519", publicKey: Buffer.from("too-short").toString("base64url"), environment: "production" };
    const r = loadPublicLicenseKeys({ FROLO_LICENSE_KEYS: JSON.stringify([bad]) });
    expect(r.keys).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/32 bytes/);
  });

  it("rejects a non-ed25519 alg", () => {
    const bad = { keyId: "x", alg: "rsa", publicKey: rawEd25519Base64url(), environment: "production" };
    const r = loadPublicLicenseKeys({ FROLO_LICENSE_KEYS: JSON.stringify([bad]) });
    expect(r.keys).toEqual([]);
  });

  it("warns and returns [] on invalid JSON (fail safe)", () => {
    const r = loadPublicLicenseKeys({ FROLO_LICENSE_KEYS: "{not json" });
    expect(r.keys).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/not valid JSON/);
  });

  it("keeps valid keys and warns about the invalid ones (mixed list)", () => {
    const good = prodKey();
    const bad = { keyId: "bad", alg: "ed25519", publicKey: "nope", environment: "production" };
    const r = loadPublicLicenseKeys({ FROLO_LICENSE_KEYS: JSON.stringify([good, bad]) });
    expect(r.keys).toHaveLength(1);
    expect(r.keys[0]!.keyId).toBe("frolo-prod-1");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("only ever produces raw 32-byte keys (sanity vs createPublicKey)", () => {
    const k = prodKey();
    const r = loadPublicLicenseKeys({ FROLO_LICENSE_KEYS: JSON.stringify([k]) });
    // Reconstruct a KeyObject to prove the loaded material is a usable ed25519 key.
    const raw = Buffer.from(r.keys[0]!.publicKey, "base64url");
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const obj = createPublicKey({ key: der, format: "der", type: "spki" });
    expect(obj.asymmetricKeyType).toBe("ed25519");
  });
});
