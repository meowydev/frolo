// Keychain adapters store the vault's random 256-bit master key (req §20.2).
// The real desktop app uses the OS credential store; tests use the in-memory
// fake. Neither the key nor any secret is written to SQLite.

import type { KeychainAdapter } from "@frolo/contracts";

// In-memory keychain for tests and headless mock runs. NOT for production.
export class InMemoryKeychain implements KeychainAdapter {
  private readonly store = new Map<string, Buffer>();

  async getKey(account: string): Promise<Buffer | null> {
    return this.store.get(account) ?? null;
  }
  async setKey(account: string, key: Buffer): Promise<void> {
    this.store.set(account, Buffer.from(key));
  }
  async deleteKey(account: string): Promise<void> {
    this.store.delete(account);
  }
}

// File-backed keychain for the self-hosted server (headless Linux VM, no OS
// credential store). The 256-bit master key is stored base64 in a file with
// 0600 permissions inside Frolo's data directory. This is the standard model
// for a single-tenant appliance: the key file and the vault sit on the same
// protected volume, and a printed recovery code lets the operator re-derive the
// key on restore. The key file is NEVER logged and NEVER placed in SQLite.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export class FileKeychain implements KeychainAdapter {
  constructor(private readonly keyFilePath: string) {}

  private accountPath(account: string): string {
    return `${this.keyFilePath}.${account}`;
  }

  async getKey(account: string): Promise<Buffer | null> {
    const p = this.accountPath(account);
    if (!existsSync(p)) return null;
    return Buffer.from(readFileSync(p, "utf8").trim(), "base64");
  }
  async setKey(account: string, key: Buffer): Promise<void> {
    const p = this.accountPath(account);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, key.toString("base64"), { mode: 0o600 });
    chmodSync(p, 0o600);
  }
  async deleteKey(account: string): Promise<void> {
    const p = this.accountPath(account);
    if (existsSync(p)) writeFileSync(p, "", { mode: 0o600 });
  }
}

// Real OS keychain adapter. Kept dependency-light: it lazily loads `keytar`
// (an optional dependency in the desktop app) so this package stays testable
// without native modules. Documented for Phase 8 wiring.
export class OsKeychain implements KeychainAdapter {
  constructor(private readonly service = "com.frolo.vault") {}

  private async keytar(): Promise<{
    getPassword(s: string, a: string): Promise<string | null>;
    setPassword(s: string, a: string, p: string): Promise<void>;
    deletePassword(s: string, a: string): Promise<boolean>;
  }> {
    // Dynamic import via a computed specifier so tsc does not statically resolve
    // the optional native module (it is only present in the packaged desktop app).
    const specifier = "keytar";
    const mod = (await import(specifier)) as unknown as { default?: unknown };
    return (mod.default ?? mod) as never;
  }

  async getKey(account: string): Promise<Buffer | null> {
    const kt = await this.keytar();
    const v = await kt.getPassword(this.service, account);
    return v ? Buffer.from(v, "base64") : null;
  }
  async setKey(account: string, key: Buffer): Promise<void> {
    const kt = await this.keytar();
    await kt.setPassword(this.service, account, key.toString("base64"));
  }
  async deleteKey(account: string): Promise<void> {
    const kt = await this.keytar();
    await kt.deletePassword(this.service, account);
  }
}
