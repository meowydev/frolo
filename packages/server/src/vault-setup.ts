// Vault key + recovery code setup (req: generate and safely store the local
// vault key; recovery code shown once, confirmed, never logged).
//
// Model: the vault master key is a random 256-bit key held by the keychain
// adapter (FileKeychain on the server). At setup we ALSO derive a human-readable
// recovery code and store a wrapped copy of the master key so the operator can
// restore the vault on a new machine by entering the recovery code. The recovery
// code itself is shown once and never persisted in plaintext or logged.

import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

export interface RecoveryArtifacts {
  // Shown to the user ONCE. Never logged, never stored in plaintext.
  recoveryCode: string;
  // Stored on disk: the master key encrypted under a key derived from the
  // recovery code. Useless without the recovery code.
  wrappedKey: WrappedKey;
}

export interface WrappedKey {
  v: 1;
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64
  authTag: string; // base64
}

// Format a random buffer as groups like FROLO-XXXX-XXXX-XXXX-XXXX.
function formatRecoveryCode(): string {
  const raw = randomBytes(10).toString("hex").toUpperCase();
  const groups = raw.match(/.{1,4}/g) ?? [];
  return `FROLO-${groups.join("-")}`;
}

// Given the vault master key, produce a recovery code and a wrapped copy.
export function createRecovery(masterKey: Buffer): RecoveryArtifacts {
  const recoveryCode = formatRecoveryCode();
  const salt = randomBytes(16);
  const kek = scryptSync(recoveryCode, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  const ct = Buffer.concat([cipher.update(masterKey), cipher.final()]);
  const wrappedKey: WrappedKey = {
    v: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: ct.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
  return { recoveryCode, wrappedKey };
}

// Recover the master key from a recovery code + wrapped blob. Throws on a wrong
// code (GCM auth failure) — fail closed.
export function unwrapWithRecovery(recoveryCode: string, wrapped: WrappedKey): Buffer {
  const salt = Buffer.from(wrapped.salt, "base64");
  const kek = scryptSync(recoveryCode, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(wrapped.iv, "base64"));
  decipher.setAuthTag(Buffer.from(wrapped.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(wrapped.ciphertext, "base64")),
    decipher.final(),
  ]);
}
