// AES-256-GCM vault (req §11.1, §11.2, §20). Exact on-disk format:
//   { header: { formatVersion, cipher: "AES-256-GCM", createdAt },
//     records: { [ref]: { iv, ciphertext, authTag } } }   // all base64
// Master key: random 256-bit, held in the OS keychain. No KDF/salt (§20.2).
// Atomic writes (§20.3), rotation (§20.4), deletion (§20.5), fail-closed (§20.6-7).

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { KeychainAdapter, Vault, VaultStatus } from "@frolo/contracts";

export const VAULT_FORMAT_VERSION = 1;
const KEY_ACCOUNT = "frolo-master-key";
const KEY_ACCOUNT_ROTATING = "frolo-master-key-next";

export interface VaultRecord {
  iv: string; // base64
  ciphertext: string; // base64
  authTag: string; // base64
}
export interface VaultFile {
  header: {
    formatVersion: number;
    cipher: "AES-256-GCM";
    createdAt: string;
  };
  records: Record<string, VaultRecord>;
}

// Injectable, atomic file store. The real desktop app uses the node:fs impl;
// tests use the in-memory impl to assert atomicity/fail-closed behavior.
export interface AtomicFileStore {
  read(path: string): Promise<string | null>;
  // Must write atomically (temp + fsync + rename) so a crash cannot corrupt.
  writeAtomic(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export class VaultLockedError extends Error {}
export class VaultCorruptError extends Error {}

export class Aes256GcmVault implements Vault {
  private key: Buffer | null = null;
  private file: VaultFile | null = null;

  constructor(
    private readonly path: string,
    private readonly keychain: KeychainAdapter,
    private readonly store: AtomicFileStore,
  ) {}

  async unlock(): Promise<void> {
    // Get or create the master key.
    let key = await this.keychain.getKey(KEY_ACCOUNT);
    if (!key) {
      // If a rotation was interrupted, the "next" key may exist (§20.4).
      key = await this.keychain.getKey(KEY_ACCOUNT_ROTATING);
      if (key) {
        await this.keychain.setKey(KEY_ACCOUNT, key);
        await this.keychain.deleteKey(KEY_ACCOUNT_ROTATING);
      }
    }
    if (!key) {
      // First run: generate a new random 256-bit key.
      key = randomBytes(32);
      await this.keychain.setKey(KEY_ACCOUNT, key);
    }
    if (key.length !== 32) {
      throw new VaultLockedError("master key is not 256-bit");
    }
    this.key = key;

    // Load or initialize the file.
    const raw = await this.store.read(this.path);
    if (raw === null) {
      this.file = {
        header: {
          formatVersion: VAULT_FORMAT_VERSION,
          cipher: "AES-256-GCM",
          createdAt: new Date().toISOString(),
        },
        records: {},
      };
      await this.persist();
    } else {
      let parsed: VaultFile;
      try {
        parsed = JSON.parse(raw) as VaultFile;
      } catch {
        // Fail closed: never silently accept unreadable data (§20.6).
        throw new VaultCorruptError("vault file is not valid JSON");
      }
      if (
        parsed.header?.cipher !== "AES-256-GCM" ||
        typeof parsed.records !== "object"
      ) {
        throw new VaultCorruptError("vault file header/records invalid");
      }
      this.file = parsed;
    }
  }

  private ensureUnlocked(): { key: Buffer; file: VaultFile } {
    if (!this.key || !this.file) {
      throw new VaultLockedError("vault is locked; call unlock() first");
    }
    return { key: this.key, file: this.file };
  }

  private async persist(): Promise<void> {
    if (!this.file) throw new VaultLockedError("nothing to persist");
    await this.store.writeAtomic(this.path, JSON.stringify(this.file));
  }

  async put(ref: string, value: string): Promise<void> {
    const { key, file } = this.ensureUnlocked();
    const iv = randomBytes(12); // 96-bit
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    file.records[ref] = {
      iv: iv.toString("base64"),
      ciphertext: ct.toString("base64"),
      authTag: tag.toString("base64"),
    };
    await this.persist();
  }

  async get(ref: string): Promise<string> {
    const { key, file } = this.ensureUnlocked();
    const rec = file.records[ref];
    if (!rec) throw new Error(`no secret for ref: ${ref}`);
    return decryptRecord(key, rec);
  }

  async has(ref: string): Promise<boolean> {
    const { file } = this.ensureUnlocked();
    return Object.prototype.hasOwnProperty.call(file.records, ref);
  }

  async remove(ref: string): Promise<void> {
    const { file } = this.ensureUnlocked();
    if (file.records[ref]) {
      delete file.records[ref];
      await this.persist(); // atomic rewrite without the record (§20.5)
    }
  }

  async status(): Promise<VaultStatus> {
    if (!this.key || !this.file) {
      return { unlocked: false, recordCount: 0, formatVersion: VAULT_FORMAT_VERSION };
    }
    return {
      unlocked: true,
      recordCount: Object.keys(this.file.records).length,
      formatVersion: this.file.header.formatVersion,
    };
  }

  // Key rotation (§20.4): new key -> re-encrypt all -> atomic replace -> drop old.
  async rotateKey(): Promise<void> {
    const { key: oldKey, file } = this.ensureUnlocked();
    const newKey = randomBytes(32);
    // Stage the new key so an interrupted rotation is recoverable.
    await this.keychain.setKey(KEY_ACCOUNT_ROTATING, newKey);

    const reencrypted: Record<string, VaultRecord> = {};
    for (const [ref, rec] of Object.entries(file.records)) {
      const plaintext = decryptRecord(oldKey, rec);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", newKey, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      reencrypted[ref] = {
        iv: iv.toString("base64"),
        ciphertext: ct.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
      };
    }
    this.file = { header: file.header, records: reencrypted };
    await this.persist();
    // Commit: promote the new key, remove staging + old.
    await this.keychain.setKey(KEY_ACCOUNT, newKey);
    await this.keychain.deleteKey(KEY_ACCOUNT_ROTATING);
    this.key = newKey;
  }
}

function decryptRecord(key: Buffer, rec: VaultRecord): string {
  const iv = Buffer.from(rec.iv, "base64");
  const ct = Buffer.from(rec.ciphertext, "base64");
  const tag = Buffer.from(rec.authTag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // Auth tag mismatch -> tampered or wrong key. Fail closed.
    throw new VaultCorruptError("failed to decrypt record (auth tag mismatch)");
  }
}

// Constant-time compare helper (exported for callers comparing fingerprints).
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
