#!/usr/bin/env node
// Frolo source-based update CLI (terminal control for the same updater the panel
// uses). Requires FROLO_RELEASE_ROOT to point at the release layout
// (<root>/releases + <root>/current). Only installs TAGGED releases.
//
//   frolo-update check              # list the latest applicable release
//   frolo-update apply <tag>        # install a specific tag transactionally
//
// Prints each phase as it runs and exits non-zero on failure (after any
// auto-rollback). No secrets or signing keys are involved.

import { FROLO_VERSION } from "../app.js";
import { SourceUpdater } from "../updater.js";
import { makeNodeUpdaterIo, updaterLayout } from "../updater-node.js";

async function main(): Promise<void> {
  const root = process.env.FROLO_RELEASE_ROOT;
  if (!root) {
    process.stderr.write(
      "FROLO_RELEASE_ROOT is not set. The source updater only applies to source deployments;\n" +
        "Docker installs update by pulling a new image tag (see install.sh update).\n",
    );
    process.exit(2);
  }
  const layout = updaterLayout(root);
  const updater = new SourceUpdater(
    {
      repo: "meowydev/frolo",
      currentVersion: FROLO_VERSION,
      releasesRoot: layout.releasesRoot,
      currentLink: layout.currentLink,
      allowPrerelease: process.env.FROLO_UPDATE_PRERELEASE === "1",
      githubToken: process.env.FROLO_GITHUB_TOKEN,
    },
    makeNodeUpdaterIo({
      currentLink: layout.currentLink,
      restartCommand: process.env.FROLO_RESTART_COMMAND,
      restartArgs: process.env.FROLO_RESTART_ARGS?.split(" ").filter(Boolean),
    }),
  );

  const cmd = process.argv[2] ?? "check";
  if (cmd === "check") {
    const s = await updater.checkForUpdates();
    if (s.lastError) {
      process.stderr.write(`Update check failed: ${s.lastError}\n`);
      process.exit(1);
    }
    if (s.updateAvailable && s.latest) {
      process.stdout.write(`Update available: ${s.latest.tag} (current ${s.currentVersion})\n`);
      process.stdout.write(`Run: frolo-update apply ${s.latest.tag}\n`);
    } else {
      process.stdout.write(`Frolo is up to date (${s.currentVersion}).\n`);
    }
    return;
  }

  if (cmd === "apply") {
    const tag = process.argv[3];
    if (!tag) {
      process.stderr.write("Usage: frolo-update apply <tag>\n");
      process.exit(2);
    }
    // Poll progress on an interval so the operator sees each phase.
    const timer = setInterval(() => {
      const p = updater.getProgress();
      if (p.phase !== "idle") process.stdout.write(`  [${p.phase}] ${p.message}\n`);
    }, 500);
    const result = await updater.applyUpdate(tag);
    clearInterval(timer);
    if (result.ok) {
      process.stdout.write(`\nUpdated to ${result.tag}.\n`);
      return;
    }
    process.stderr.write(
      `\nUpdate failed: ${result.error}${result.rolledBack ? " (rolled back to the previous release)" : ""}\n`,
    );
    process.exit(1);
  }

  process.stderr.write("Usage: frolo-update [check|apply <tag>]\n");
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`frolo-update error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
