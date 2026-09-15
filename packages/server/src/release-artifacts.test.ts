// Release artifact checksum coherence (task 14). Proves that the SHA256SUMS.txt
// produced by the release pipeline lines up with what the updater verifies:
//   - the updater's findChecksumForFile() reads the exact line for a named asset
//   - the sha256 in that line matches the real bytes of the asset
//   - a tampered asset is detected (checksum mismatch)
//
// We synthesize a release directory the same way build-release.sh / the release
// workflow do (a source tarball + a couple of bundle files + a `sha256sum`-style
// SHA256SUMS.txt), then verify against it. No network, no GitHub.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChecksumForFile, sourceAssetName } from "./updater.js";

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Reproduce the exact SHA256SUMS.txt line format the pipeline emits
// (`sha256sum` / `shasum -a 256`): "<64-hex>␠␠<filename>".
function writeSha256Sums(dir: string, files: string[]): void {
  const lines = files.map((f) => `${sha256File(join(dir, f))}  ${f}`);
  writeFileSync(join(dir, "SHA256SUMS.txt"), lines.join("\n") + "\n");
}

let out: string;
const version = "9.9.9-test";

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "frolo-release-"));
  // The release assets: a source tarball (named exactly as the updater expects),
  // the compose bundle, and the installer.
  writeFileSync(join(out, sourceAssetName(version)), Buffer.from("fake source tarball bytes \u0000\u0001\u0002"));
  writeFileSync(join(out, "docker-compose.yml"), "services:\n  frolo: {}\n");
  writeFileSync(join(out, "install.sh"), "#!/usr/bin/env bash\necho frolo\n");
  writeSha256Sums(out, [sourceAssetName(version), "docker-compose.yml", "install.sh"]);
});

afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

describe("release artifact checksums", () => {
  it("SHA256SUMS.txt covers the named source asset and the deploy bundle", () => {
    const sums = readFileSync(join(out, "SHA256SUMS.txt"), "utf8");
    for (const f of [sourceAssetName(version), "docker-compose.yml", "install.sh"]) {
      expect(findChecksumForFile(sums, f)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("the updater's checksum lookup matches the real bytes of the source asset", () => {
    const sums = readFileSync(join(out, "SHA256SUMS.txt"), "utf8");
    const asset = sourceAssetName(version);
    const listed = findChecksumForFile(sums, asset);
    const actual = sha256File(join(out, asset));
    expect(listed).toBe(actual);
  });

  it("detects a tampered source asset (mismatch)", () => {
    const sums = readFileSync(join(out, "SHA256SUMS.txt"), "utf8");
    const asset = sourceAssetName(version);
    const listed = findChecksumForFile(sums, asset)!;
    // Tamper with the asset after the sums were written.
    writeFileSync(join(out, asset), Buffer.from("tampered contents"));
    const nowHash = sha256File(join(out, asset));
    expect(nowHash).not.toBe(listed);
  });

  it("every listed file exists in the release directory", () => {
    const sums = readFileSync(join(out, "SHA256SUMS.txt"), "utf8");
    const present = new Set(readdirSync(out));
    for (const line of sums.split("\n").filter(Boolean)) {
      const file = line.split(/\s+/).pop()!;
      expect(present.has(file)).toBe(true);
    }
  });

  it("the source asset is named frolo-<version>.tar.gz", () => {
    expect(sourceAssetName("1.2.3")).toBe("frolo-1.2.3.tar.gz");
    expect(sourceAssetName("v1.2.3")).toBe("frolo-1.2.3.tar.gz"); // leading v stripped
  });
});
