// Updater tests. Fully offline: a fake UpdaterIo supplies canned GitHub
// responses, a canned tarball, and records the sequence of transactional steps.
// No network, no real build, no restart, no filesystem writes to real paths.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  SourceUpdater,
  compareVersions,
  findSourceChecksum,
  normalizeTag,
  type UpdaterIo,
  type UpdaterConfig,
} from "./updater.js";

function sha256hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// A programmable fake IO. Callers set the release list, the tarball bytes, and
// per-step behaviors (e.g. force health-check failure to exercise rollback).
class FakeIo implements UpdaterIo {
  steps: string[] = [];
  currentTarget: string | null = "/opt/frolo/releases/0.1.0-beta.1";
  staged = new Set<string>();
  json: Record<string, unknown> = {};
  text: Record<string, string> = {};
  bytes: Record<string, Uint8Array> = {};
  healthResults: boolean[] = []; // consumed per healthCheck call
  buildShouldFail = false;

  async fetchJson(url: string): Promise<unknown> {
    // Longest matching key wins so "/releases/tags/x" beats "/releases".
    const key = Object.keys(this.json)
      .filter((k) => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`no canned json for ${url}`);
    return this.json[key];
  }
  async fetchText(url: string): Promise<string> {
    const key = Object.keys(this.text).find((k) => url.includes(k));
    if (!key) throw new Error(`no canned text for ${url}`);
    return this.text[key]!;
  }
  async fetchBytes(url: string): Promise<Uint8Array> {
    const key = Object.keys(this.bytes).find((k) => url.includes(k));
    if (!key) throw new Error(`no canned bytes for ${url}`);
    return this.bytes[key]!;
  }
  async extractTarGz(_archive: Uint8Array, destDir: string): Promise<void> {
    this.steps.push(`extract:${destDir}`);
  }
  async runBuild(cwd: string): Promise<void> {
    this.steps.push(`build:${cwd}`);
    if (this.buildShouldFail) throw new Error("build failed");
  }
  async readCurrentTarget(): Promise<string | null> {
    return this.currentTarget;
  }
  async pointCurrentTo(targetDir: string): Promise<void> {
    this.steps.push(`point:${targetDir}`);
    this.currentTarget = targetDir;
  }
  async restartService(): Promise<void> {
    this.steps.push("restart");
  }
  async healthCheck(): Promise<boolean> {
    const r = this.healthResults.shift();
    this.steps.push(`health:${r ?? true}`);
    return r ?? true;
  }
  async ensureDir(path: string): Promise<void> {
    this.steps.push(`ensureDir:${path}`);
  }
  async pathExists(path: string): Promise<boolean> {
    return this.staged.has(path);
  }
  now(): string {
    return "2026-01-01T00:00:00.000Z";
  }
}

const cfg: UpdaterConfig = {
  repo: "meowydev/frolo",
  currentVersion: "0.1.0-beta.1",
  releasesRoot: "/opt/frolo/releases",
  currentLink: "/opt/frolo/current",
  healthTimeoutMs: 1000,
};

function seedRelease(io: FakeIo, tag: string, archive: Uint8Array, opts: { prerelease?: boolean } = {}) {
  const checksums = `${sha256hex(archive)}  frolo-${normalizeTag(tag)}.tar.gz\n`;
  io.text["SHA256SUMS"] = checksums;
  io.bytes["tarball"] = archive;
  const release = {
    tag_name: tag,
    name: tag,
    published_at: "2026-01-01T00:00:00Z",
    prerelease: Boolean(opts.prerelease),
    draft: false,
    tarball_url: "https://api.github.com/tarball",
    assets: [{ name: "SHA256SUMS", browser_download_url: "https://example/SHA256SUMS" }],
  };
  io.json["/releases"] = [release];
  io.json[`/releases/tags/${tag}`] = release;
}

describe("version comparison", () => {
  it("orders releases and prereleases", () => {
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0); // release > prerelease
    expect(compareVersions("0.1.0-beta.2", "0.1.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0-beta.1", "0.1.0-beta.2")).toBeLessThan(0);
  });
});

describe("findSourceChecksum", () => {
  it("finds the tag tarball checksum", () => {
    const sums = "aa".repeat(32) + "  frolo-0.1.0-beta.2.tar.gz\n" + "bb".repeat(32) + "  other.zip";
    expect(findSourceChecksum(sums, "0.1.0-beta.2")).toBe("aa".repeat(32));
  });
  it("returns null when there is no tar.gz entry", () => {
    expect(findSourceChecksum("bb".repeat(32) + "  frolo.zip", "1.0.0")).toBeNull();
  });
});

describe("SourceUpdater.checkForUpdates", () => {
  it("reports an available update for a newer tagged release", async () => {
    const io = new FakeIo();
    const archive = new Uint8Array([1, 2, 3]);
    seedRelease(io, "0.1.0-beta.2", archive);
    const up = new SourceUpdater(cfg, io);
    const status = await up.checkForUpdates();
    expect(status.updateAvailable).toBe(true);
    expect(status.latest?.tag).toBe("0.1.0-beta.2");
  });

  it("ignores prereleases on the stable channel", async () => {
    const io = new FakeIo();
    seedRelease(io, "0.2.0-beta.1", new Uint8Array([1]), { prerelease: true });
    const up = new SourceUpdater(cfg, io);
    const status = await up.checkForUpdates();
    expect(status.updateAvailable).toBe(false);
    expect(status.latest).toBeUndefined();
  });
});

describe("SourceUpdater.applyUpdate", () => {
  it("refuses a non-tag ref (never installs an unpinned branch)", async () => {
    const io = new FakeIo();
    const up = new SourceUpdater(cfg, io);
    const res = await up.applyUpdate("main");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/only tagged releases/i);
    // Nothing was extracted/built/swapped.
    expect(io.steps.filter((s) => s.startsWith("extract"))).toHaveLength(0);
  });

  it("refuses to install when the checksum does not match", async () => {
    const io = new FakeIo();
    const archive = new Uint8Array([9, 9, 9]);
    seedRelease(io, "0.1.0-beta.2", archive);
    io.text["SHA256SUMS"] = "00".repeat(32) + "  frolo-0.1.0-beta.2.tar.gz"; // wrong
    const up = new SourceUpdater(cfg, io);
    const res = await up.applyUpdate("0.1.0-beta.2");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/checksum mismatch/i);
    expect(io.steps.filter((s) => s.startsWith("extract"))).toHaveLength(0);
  });

  it("installs transactionally: extract -> build -> swap -> restart -> health", async () => {
    const io = new FakeIo();
    const archive = new Uint8Array([1, 2, 3, 4]);
    seedRelease(io, "0.1.0-beta.2", archive);
    io.healthResults = [true];
    const up = new SourceUpdater(cfg, io);
    const res = await up.applyUpdate("0.1.0-beta.2");
    expect(res.ok).toBe(true);
    // Ordered steps.
    const order = io.steps.filter((s) => /^(extract|build|point|restart|health)/.test(s));
    expect(order[0]).toMatch(/^extract:/);
    expect(order[1]).toMatch(/^build:/);
    expect(order[2]).toBe("point:/opt/frolo/releases/0.1.0-beta.2");
    expect(order[3]).toBe("restart");
    expect(order[4]).toBe("health:true");
    expect(io.currentTarget).toBe("/opt/frolo/releases/0.1.0-beta.2");
  });

  it("auto-rolls back to the previous release when the health check fails", async () => {
    const io = new FakeIo();
    const archive = new Uint8Array([5, 6, 7]);
    seedRelease(io, "0.1.0-beta.2", archive);
    // First health check (new release) fails; second (rollback) succeeds.
    io.healthResults = [false, true];
    const up = new SourceUpdater(cfg, io);
    const res = await up.applyUpdate("0.1.0-beta.2");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.rolledBack).toBe(true);
    // current was pointed to the new release, then back to the previous one.
    expect(io.steps).toContain("point:/opt/frolo/releases/0.1.0-beta.2");
    expect(io.steps).toContain("point:/opt/frolo/releases/0.1.0-beta.1");
    expect(io.currentTarget).toBe("/opt/frolo/releases/0.1.0-beta.1");
  });

  it("rolls back when the build fails (before any swap)", async () => {
    const io = new FakeIo();
    const archive = new Uint8Array([2, 2]);
    seedRelease(io, "0.1.0-beta.2", archive);
    io.buildShouldFail = true;
    io.healthResults = [true]; // rollback health
    const up = new SourceUpdater(cfg, io);
    const res = await up.applyUpdate("0.1.0-beta.2");
    expect(res.ok).toBe(false);
    // No swap to the new release happened.
    expect(io.steps).not.toContain("point:/opt/frolo/releases/0.1.0-beta.2");
    // current stays on the previous release.
    expect(io.currentTarget).toBe("/opt/frolo/releases/0.1.0-beta.1");
  });
});
