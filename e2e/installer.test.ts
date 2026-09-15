// Installer safety checks (req: installer rerun; uninstall never deletes data
// unless explicitly requested). The installer is a bash + Docker script that we
// cannot fully execute in CI without Docker, so these tests validate the
// script's SAFETY INVARIANTS structurally: valid bash, rerun-safe (idempotent
// mkdir/compose up), and that data deletion is gated behind an explicit flag.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const installScript = join(root, "install/install.sh");
const script = readFileSync(installScript, "utf8");

describe("install.sh safety", () => {
  it("is valid bash", () => {
    // `bash -n` parses without executing. Throws on syntax error.
    expect(() => execFileSync("bash", ["-n", installScript])).not.toThrow();
  });

  it("supports the amd64 beta image and rejects unsupported architectures", () => {
    expect(script).toMatch(/x86_64\|amd64/);
    expect(script).toMatch(/this Frolo beta image supports amd64/);
  });

  it("is rerun-safe (idempotent create + compose up)", () => {
    expect(script).toMatch(/mkdir -p .*FROLO_DIR/);
    // Only writes .env if it does not already exist.
    expect(script).toMatch(/if \[ ! -f "\$\{FROLO_DIR\}\/\.env" \]/);
    expect(script).toMatch(/compose up -d/);
  });

  it("uninstall preserves data unless --remove-data is given", () => {
    // The volume/dir removal must be guarded by the explicit flag.
    expect(script).toMatch(/--remove-data/);
    expect(script).toMatch(/docker volume rm .*DATA_VOLUME/);
    // The guard: removal only inside the --remove-data branch.
    const uninstall = script.slice(script.indexOf("cmd_uninstall()"));
    const flagIdx = uninstall.indexOf('"--remove-data"');
    const rmIdx = uninstall.indexOf("docker volume rm");
    expect(flagIdx).toBeGreaterThan(-1);
    expect(rmIdx).toBeGreaterThan(flagIdx); // rm appears after the flag check
  });

  it("provides update, backup, restore, and diagnostics commands", () => {
    for (const cmd of ["cmd_update", "cmd_backup", "cmd_restore", "cmd_diagnostics"]) {
      expect(script).toContain(cmd);
    }
  });

  it("waits for the health check and prints the ready URL", () => {
    expect(script).toMatch(/\/api\/health/);
    expect(script).toMatch(/Frolo is ready at http:\/\//);
  });

  it("does not bundle or generate signing keys", () => {
    expect(script).not.toMatch(/PRIVATE KEY/);
    expect(script).not.toMatch(/signing[_-]?key/i);
  });

  it("uses the real meowydev/frolo repo and image (no placeholder org)", () => {
    expect(script).not.toMatch(/meowerity/);
    expect(script).toMatch(/ghcr\.io\/meowydev\/frolo/);
    expect(script).toMatch(/meowydev\/frolo/);
  });

  it("update <tag> fetches a checksum-verified release bundle before restart", () => {
    // The tagged-update path downloads the bundle + checksums and verifies them.
    expect(script).toMatch(/\/releases/);
    expect(script).toMatch(/\/download\/\$\{tag\}/);
    expect(script).toMatch(/SHA256SUMS\.txt/);
    expect(script).toMatch(/shasum -a 256 -c/);
    // Refuses to proceed if verification fails.
    expect(script).toMatch(/Checksum verification failed/);
  });
});

describe("release artifacts + compose", () => {
  const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
  const buildRelease = readFileSync(join(root, "scripts/build-release.sh"), "utf8");

  it("compose + build-release reference meowydev/frolo (no placeholder org)", () => {
    expect(compose).not.toMatch(/meowerity/);
    expect(compose).toMatch(/ghcr\.io\/meowydev\/frolo/);
    expect(buildRelease).not.toMatch(/meowerity/);
    expect(buildRelease).toMatch(/ghcr\.io\/meowydev\/frolo/);
  });

  it("build-release publishes a checksum-verified source archive for the updater", () => {
    expect(buildRelease).toMatch(/frolo-\$\{VERSION\}\.tar\.gz/);
    expect(buildRelease).toMatch(/SHA256SUMS\.txt/);
    expect(buildRelease).toMatch(/git archive/);
  });
});
