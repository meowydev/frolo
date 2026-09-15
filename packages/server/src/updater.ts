// Source-based updater (req: check GitHub releases, download the selected TAGGED
// source archive, verify checksum, build locally, install transactionally,
// restart, health-check, auto-rollback on failure; never an unpinned branch).
//
// DEPLOYMENT MODEL
//   The updater manages a directory layout of immutable release trees plus a
//   `current` symlink the service is launched from:
//
//     <root>/
//       releases/
//         0.1.0-beta.1/      (an extracted, built source tree)
//         0.1.0-beta.2/
//       current -> releases/0.1.0-beta.2
//
//   "Transactional install" means: stage a NEW release directory fully (extract
//   + build), then atomically repoint `current`. If the post-swap health check
//   fails, `current` is repointed back to the previous release (auto-rollback)
//   and the failed staging directory is left in place for diagnostics.
//
// SAFETY
//   - ONLY tagged releases are installable. A ref that is not a release tag (a
//     branch name, "latest", a commit-ish, "main") is refused. This prevents
//     silently running unpinned code.
//   - The source tarball's SHA-256 is verified against the checksum published in
//     the release's SHA256SUMS asset BEFORE anything is extracted or built.
//   - No signing keys or secrets are involved; this updates code only. Persistent
//     data lives outside the release tree and is never touched.
//   - All network + shell + fs access goes through injected seams so tests run
//     fully offline and never execute a real build or restart.

import { createHash } from "node:crypto";

export interface ReleaseInfo {
  tag: string; // e.g. "0.1.0-beta.2"
  name: string;
  publishedAt: string;
  prerelease: boolean;
  // URL of the SOURCE RELEASE ASSET we build from and verify — the exact
  // `frolo-<version>.tar.gz` file uploaded to the release, NOT GitHub's
  // auto-generated tag tarball. The published SHA256SUMS.txt covers THIS file,
  // so this is the only artifact whose checksum can match. Undefined if the
  // release does not attach a source asset (then install is refused).
  sourceAssetUrl?: string;
  // Name of that asset (for matching the SHA256SUMS line, e.g. frolo-1.2.3.tar.gz).
  sourceAssetName?: string;
  // URL of the SHA256SUMS asset, if the release publishes one.
  checksumsUrl?: string;
  body?: string;
}

export interface UpdateStatus {
  currentVersion: string;
  latest?: ReleaseInfo;
  updateAvailable: boolean;
  channel: "stable" | "prerelease";
  lastCheckedAt?: string;
  lastError?: string;
}

export interface UpdateProgress {
  phase:
    | "idle"
    | "checking"
    | "downloading"
    | "verifying"
    | "extracting"
    | "building"
    | "swapping"
    | "restarting"
    | "health-check"
    | "rolling-back"
    | "done"
    | "failed";
  message: string;
  tag?: string;
  at: string;
}

// Injected seams (tests provide fakes; production wires node:fs/https/child_process).
export interface UpdaterIo {
  // HTTP GET returning parsed JSON (GitHub API).
  fetchJson(url: string, headers?: Record<string, string>): Promise<unknown>;
  // HTTP GET returning raw text (SHA256SUMS).
  fetchText(url: string, headers?: Record<string, string>): Promise<string>;
  // HTTP GET returning raw bytes (source tarball).
  fetchBytes(url: string, headers?: Record<string, string>): Promise<Uint8Array>;
  // Extract a .tar.gz buffer into destDir (destDir is created).
  extractTarGz(archive: Uint8Array, destDir: string): Promise<void>;
  // Run a build command inside cwd; rejects on non-zero exit.
  runBuild(cwd: string): Promise<void>;
  // Read the current `current` symlink target (absolute), or null if none.
  readCurrentTarget(): Promise<string | null>;
  // Atomically repoint the `current` symlink to targetDir.
  pointCurrentTo(targetDir: string): Promise<void>;
  // Restart the service so it re-launches from `current`.
  restartService(): Promise<void>;
  // Poll the local health endpoint; resolves true when healthy within timeout.
  healthCheck(timeoutMs: number): Promise<boolean>;
  // Filesystem helpers scoped to the release root.
  ensureDir(path: string): Promise<void>;
  pathExists(path: string): Promise<boolean>;
  now(): string; // ISO timestamp
}

export interface UpdaterConfig {
  repo: string; // "meowydev/frolo"
  currentVersion: string; // FROLO_VERSION of the running build
  releasesRoot: string; // <root>/releases
  currentLink: string; // <root>/current
  allowPrerelease?: boolean;
  githubToken?: string; // optional, for rate limits (never required)
  healthTimeoutMs?: number;
}

const RELEASE_TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/; // semver-ish tag only

export class SourceUpdater {
  private status: UpdateStatus;
  private progress: UpdateProgress;

  constructor(
    private readonly cfg: UpdaterConfig,
    private readonly io: UpdaterIo,
  ) {
    this.status = {
      currentVersion: cfg.currentVersion,
      updateAvailable: false,
      channel: cfg.allowPrerelease ? "prerelease" : "stable",
    };
    this.progress = { phase: "idle", message: "", at: io.now() };
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }
  getProgress(): UpdateProgress {
    return { ...this.progress };
  }

  private setProgress(phase: UpdateProgress["phase"], message: string, tag?: string): void {
    this.progress = { phase, message, tag, at: this.io.now() };
  }

  private ghHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "frolo-updater",
    };
    if (this.cfg.githubToken) h.Authorization = `Bearer ${this.cfg.githubToken}`;
    return h;
  }

  // Query the GitHub releases API and pick the newest applicable TAGGED release.
  async checkForUpdates(): Promise<UpdateStatus> {
    this.setProgress("checking", "Checking for updates…");
    try {
      const url = `https://api.github.com/repos/${this.cfg.repo}/releases`;
      const raw = (await this.io.fetchJson(url, this.ghHeaders())) as GhRelease[];
      const releases = (Array.isArray(raw) ? raw : [])
        .filter((r) => !r.draft)
        .filter((r) => (this.cfg.allowPrerelease ? true : !r.prerelease))
        .filter((r) => RELEASE_TAG_RE.test(r.tag_name))
        .map((r) => toReleaseInfo(r, this.cfg.repo))
        .sort((a, b) => compareVersions(b.tag, a.tag));

      const latest = releases[0];
      this.status = {
        currentVersion: this.cfg.currentVersion,
        latest,
        updateAvailable: Boolean(latest && compareVersions(latest.tag, this.cfg.currentVersion) > 0),
        channel: this.cfg.allowPrerelease ? "prerelease" : "stable",
        lastCheckedAt: this.io.now(),
      };
      this.setProgress("idle", this.status.updateAvailable ? `Update available: ${latest!.tag}` : "Up to date");
      return this.getStatus();
    } catch (err) {
      this.status = { ...this.status, lastCheckedAt: this.io.now(), lastError: errMsg(err) };
      this.setProgress("failed", `Update check failed: ${errMsg(err)}`);
      return this.getStatus();
    }
  }

  // Resolve a specific TAG to an installable release. Refuses non-tags.
  async resolveRelease(tag: string): Promise<ReleaseInfo> {
    if (!RELEASE_TAG_RE.test(tag)) {
      throw new Error(
        `refusing to install "${tag}": only tagged releases may be installed (never a branch or unpinned ref)`,
      );
    }
    const url = `https://api.github.com/repos/${this.cfg.repo}/releases/tags/${encodeURIComponent(tag)}`;
    const r = (await this.io.fetchJson(url, this.ghHeaders())) as GhRelease;
    if (!r || !r.tag_name) throw new Error(`release tag not found: ${tag}`);
    if (r.draft) throw new Error(`refusing to install a draft release: ${tag}`);
    if (r.prerelease && !this.cfg.allowPrerelease) {
      throw new Error(`refusing to install a prerelease (${tag}); enable the prerelease channel first`);
    }
    return toReleaseInfo(r, this.cfg.repo);
  }

  // Download + verify the SOURCE RELEASE ASSET's SHA-256 against the release's
  // SHA256SUMS. We download the exact `frolo-<version>.tar.gz` asset that the
  // checksums file covers — never GitHub's auto-generated tag tarball, whose
  // bytes differ and would always fail verification. Verification happens BEFORE
  // extraction. Returns the verified archive bytes.
  async downloadAndVerify(rel: ReleaseInfo): Promise<{ archive: Uint8Array; sha256: string }> {
    if (!rel.sourceAssetUrl || !rel.sourceAssetName) {
      throw new Error(
        `release ${rel.tag} does not attach a source asset (expected ${sourceAssetName(rel.tag)}); ` +
          `refusing to install — the auto-generated tag tarball is not checksum-verifiable`,
      );
    }
    if (!rel.checksumsUrl) {
      throw new Error(
        `release ${rel.tag} does not publish a SHA256SUMS.txt asset; refusing to install unverifiable source`,
      );
    }

    this.setProgress("downloading", `Downloading ${rel.sourceAssetName}…`, rel.tag);
    const archive = await this.io.fetchBytes(rel.sourceAssetUrl, this.ghHeaders());
    const sha256 = createHash("sha256").update(archive).digest("hex");

    this.setProgress("verifying", "Verifying checksum…", rel.tag);
    const sums = await this.io.fetchText(rel.checksumsUrl, this.ghHeaders());
    // Match the checksum line for THIS asset by its exact filename.
    const expected = findChecksumForFile(sums, rel.sourceAssetName);
    if (!expected) {
      throw new Error(`no checksum for ${rel.sourceAssetName} found in SHA256SUMS.txt for ${rel.tag}`);
    }
    if (expected.toLowerCase() !== sha256.toLowerCase()) {
      throw new Error(
        `checksum mismatch for ${rel.sourceAssetName}: expected ${expected}, got ${sha256} — refusing to install`,
      );
    }
    return { archive, sha256 };
  }

  // Full transactional install of a tag: resolve → download → verify → extract →
  // build → swap `current` → restart → health-check → (rollback on failure).
  async applyUpdate(tag: string): Promise<{ ok: true; tag: string } | { ok: false; error: string; rolledBack: boolean }> {
    const previous = await this.io.readCurrentTarget();
    let staged: string | null = null;
    try {
      const rel = await this.resolveRelease(tag);
      const { archive } = await this.downloadAndVerify(rel);

      const normalized = normalizeTag(rel.tag);
      staged = joinPath(this.cfg.releasesRoot, normalized);
      if (await this.io.pathExists(staged)) {
        throw new Error(`release ${normalized} is already staged; remove it before reinstalling`);
      }

      this.setProgress("extracting", "Extracting source…", rel.tag);
      await this.io.ensureDir(this.cfg.releasesRoot);
      await this.io.extractTarGz(archive, staged);

      this.setProgress("building", "Building…", rel.tag);
      await this.io.runBuild(staged);

      this.setProgress("swapping", "Activating new release…", rel.tag);
      await this.io.pointCurrentTo(staged);

      this.setProgress("restarting", "Restarting service…", rel.tag);
      await this.io.restartService();

      this.setProgress("health-check", "Verifying health…", rel.tag);
      const healthy = await this.io.healthCheck(this.cfg.healthTimeoutMs ?? 60_000);
      if (!healthy) throw new Error("health check failed after restart");

      this.setProgress("done", `Updated to ${rel.tag}`, rel.tag);
      this.status = { ...this.status, currentVersion: normalized, updateAvailable: false };
      return { ok: true, tag: normalized };
    } catch (err) {
      const message = errMsg(err);
      // Auto-rollback: repoint `current` to the previous release and restart.
      let rolledBack = false;
      if (previous) {
        try {
          this.setProgress("rolling-back", `Rolling back to previous release…`, tag);
          await this.io.pointCurrentTo(previous);
          await this.io.restartService();
          const healthy = await this.io.healthCheck(this.cfg.healthTimeoutMs ?? 60_000);
          rolledBack = healthy;
        } catch {
          rolledBack = false;
        }
      }
      this.setProgress("failed", `Update failed: ${message}${rolledBack ? " (rolled back)" : ""}`, tag);
      return { ok: false, error: message, rolledBack };
    }
  }
}

// --- GitHub response shape (only the fields we use) ---
interface GhAsset {
  name: string;
  browser_download_url: string;
}
interface GhRelease {
  tag_name: string;
  name?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  body?: string;
  tarball_url?: string;
  assets?: GhAsset[];
}

// The canonical source-asset filename the updater builds from and the release
// pipeline uploads. Keep this in sync with scripts/build-release.sh + CI.
export function sourceAssetName(tag: string): string {
  return `frolo-${normalizeTag(tag)}.tar.gz`;
}

function toReleaseInfo(r: GhRelease, _repo: string): ReleaseInfo {
  const assets = r.assets ?? [];
  const checksums = assets.find((a) => /^sha256sums(\.txt)?$/i.test(a.name));
  const wanted = sourceAssetName(r.tag_name);
  // Match the named source asset exactly (frolo-<version>.tar.gz). This is the
  // ONLY artifact the checksums cover; we never fall back to tarball_url.
  const source =
    assets.find((a) => a.name.toLowerCase() === wanted.toLowerCase()) ??
    assets.find((a) => /^frolo-.*\.tar\.gz$/i.test(a.name));
  return {
    tag: r.tag_name,
    name: r.name ?? r.tag_name,
    publishedAt: r.published_at ?? "",
    prerelease: Boolean(r.prerelease),
    sourceAssetUrl: source?.browser_download_url,
    sourceAssetName: source?.name,
    checksumsUrl: checksums?.browser_download_url,
    body: r.body,
  };
}

// Parse a SHA256SUMS file and return the checksum for a specific filename.
// Accepts `sha256sum`-style lines: "<64-hex>␠␠<filename>" (the leading "*" that
// coreutils uses for binary mode is tolerated). Matches on the basename so a
// "./frolo-x.tar.gz" or "frolo-x.tar.gz" entry both resolve.
export function findChecksumForFile(sums: string, fileName: string): string | null {
  const target = basename(fileName).toLowerCase();
  const lines = sums.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!m) continue;
    if (basename(m[2]!).toLowerCase() === target) return m[1]!;
  }
  return null;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
}

export function normalizeTag(tag: string): string {
  return tag.replace(/^v/, "");
}

// Compare two semver-ish versions (supports -beta.N style prerelease suffixes).
// Returns >0 if a>b, <0 if a<b, 0 if equal.
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(normalizeTag(a));
  const pb = parseVersion(normalizeTag(b));
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i]! !== pb.nums[i]!) return pa.nums[i]! - pb.nums[i]!;
  }
  // No prerelease outranks a prerelease (1.0.0 > 1.0.0-beta.1).
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && !pb.pre) return 0;
  return comparePre(pa.pre!, pb.pre!);
}

function parseVersion(v: string): { nums: number[]; pre?: string } {
  const [core, pre] = v.split("-", 2);
  const nums = (core ?? "0.0.0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  return { nums, pre };
}

function comparePre(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = Number.parseInt(x, 10);
    const yn = Number.parseInt(y, 10);
    const bothNum = !Number.isNaN(xn) && !Number.isNaN(yn);
    if (bothNum) {
      if (xn !== yn) return xn - yn;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function joinPath(a: string, b: string): string {
  return a.endsWith("/") ? a + b : `${a}/${b}`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
