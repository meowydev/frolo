// AtomicFileStore implementations.

import { rename, writeFile, readFile, open, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { AtomicFileStore } from "./vault.js";

// Real: temp file -> fsync -> rename (atomic on the same filesystem) (§20.3).
export class NodeAtomicFileStore implements AtomicFileStore {
  async read(path: string): Promise<string | null> {
    if (!existsSync(path)) return null;
    return readFile(path, "utf8");
  }

  async writeAtomic(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, contents, { mode: 0o600 });
    // fsync the temp file so the bytes hit disk before rename.
    const fh = await open(tmp, "r+");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(path);
  }
}

// In-memory: models atomicity by only assigning the full string on success.
// A `failNextWrite` knob lets tests assert the vault is not corrupted on crash.
export class InMemoryFileStore implements AtomicFileStore {
  private files = new Map<string, string>();
  failNextWrite = false;

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeAtomic(path: string, contents: string): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      // Simulate a crash mid-write: the previous contents remain intact.
      throw new Error("simulated write failure");
    }
    this.files.set(path, contents);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}
