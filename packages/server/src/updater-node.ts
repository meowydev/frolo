// Production-backed UpdaterIo using node built-ins. Kept separate from the pure
// SourceUpdater logic so the updater can be unit-tested fully offline with a
// fake UpdaterIo (no network, no build, no restart).
//
// tar extraction uses the optional `tar` dependency, loaded dynamically so the
// package builds without it (same optional-dep pattern as the real providers).
// The build + restart commands are configurable so the source and Docker
// deployment paths can supply the right commands.

import { spawn } from "node:child_process";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { mkdir, symlink, readlink, rm, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { UpdaterIo } from "./updater.js";

export interface NodeUpdaterIoOptions {
  currentLink: string; // absolute path of the `current` symlink
  // Build command run inside a staged release dir (default: pnpm install + build).
  buildCommand?: string;
  buildArgs?: string[];
  // Restart command. In systemd deployments this is e.g. `systemctl restart frolo`.
  restartCommand?: string;
  restartArgs?: string[];
  // Local health URL to poll after restart.
  healthUrl?: string;
}

export function makeNodeUpdaterIo(opts: NodeUpdaterIoOptions): UpdaterIo {
  const currentLink = resolve(opts.currentLink);
  const healthUrl = opts.healthUrl ?? "http://127.0.0.1:4512/api/health";

  return {
    async fetchJson(url, headers) {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return res.json();
    },
    async fetchText(url, headers) {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return res.text();
    },
    async fetchBytes(url, headers) {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async extractTarGz(archive, destDir) {
      await mkdir(destDir, { recursive: true });
      // Dynamically import the optional `tar` dep (avoids static resolution).
      const specifier = "tar";
      const tar = (await import(specifier)) as {
        extract(opts: { cwd: string; strip?: number }): NodeJS.WritableStream;
      };
      await new Promise<void>((resolveP, reject) => {
        const gunzip = createGunzip();
        // GitHub source tarballs wrap everything in a single top-level dir; strip it.
        const extractor = tar.extract({ cwd: destDir, strip: 1 });
        Readable.from(Buffer.from(archive))
          .pipe(gunzip)
          .on("error", reject)
          .pipe(extractor)
          .on("error", reject)
          .on("finish", () => resolveP());
      });
    },
    async runBuild(cwd) {
      const cmd = opts.buildCommand ?? "pnpm";
      const args = opts.buildArgs ?? ["install", "--frozen-lockfile", "&&", "pnpm", "run", "build"];
      // Run install then build as separate spawns to avoid shell parsing of "&&".
      if (!opts.buildCommand) {
        await run("pnpm", ["install", "--frozen-lockfile"], cwd);
        await run("pnpm", ["run", "build"], cwd);
        return;
      }
      await run(cmd, args, cwd);
    },
    async readCurrentTarget() {
      try {
        const target = await readlink(currentLink);
        return resolve(dirname(currentLink), target);
      } catch {
        return null;
      }
    },
    async pointCurrentTo(targetDir) {
      // Atomic symlink swap: create a temp link then rename over `current`.
      const tmp = `${currentLink}.tmp-${process.pid}-${Date.now()}`;
      await mkdir(dirname(currentLink), { recursive: true });
      await symlink(resolve(targetDir), tmp, "dir").catch(async (e) => {
        // On platforms without "dir" type support, retry without it.
        if ((e as NodeJS.ErrnoException).code === "EPERM") {
          await symlink(resolve(targetDir), tmp);
        } else throw e;
      });
      const { rename } = await import("node:fs/promises");
      await rename(tmp, currentLink);
    },
    async restartService() {
      if (!opts.restartCommand) {
        // No restart command configured: the process manager (systemd/Docker)
        // is expected to restart when `current` changes, or the operator does it.
        return;
      }
      await run(opts.restartCommand, opts.restartArgs ?? [], process.cwd());
    },
    async healthCheck(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(healthUrl);
          if (res.ok) return true;
        } catch {
          // not up yet
        }
        await sleep(2000);
      }
      return false;
    },
    async ensureDir(path) {
      await mkdir(path, { recursive: true });
    },
    async pathExists(path) {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    now() {
      return new Date().toISOString();
    },
  };

  function run(cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolveP, reject) => {
      const child = spawn(cmd, args, { cwd, stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolveP();
        else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Convenience layout helper: given a release root, produce the standard paths.
export function updaterLayout(root: string): { releasesRoot: string; currentLink: string } {
  return { releasesRoot: join(root, "releases"), currentLink: join(root, "current") };
}
