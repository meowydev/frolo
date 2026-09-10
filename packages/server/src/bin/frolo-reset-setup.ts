#!/usr/bin/env node
// Safe setup-reset (req: preserves deployed infrastructure, requires local
// terminal access). This runs ON the Frolo VM against the data directory — it is
// NOT an HTTP endpoint, so it cannot be triggered remotely. It clears the admin
// account, sessions, and OOBE completion so first-run setup can be redone. It
// does NOT touch deployment records, VMs, router mappings, recipes, or the vault
// contents — deployed infrastructure is preserved.

import Database from "better-sqlite3";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { AuthStore } from "../auth/auth-store.js";

const DATA_DIR = process.env.FROLO_DATA_DIR ?? "/opt/frolo/data";

async function confirm(question: string): Promise<boolean> {
  // Require an interactive TTY: refuses to run when piped/non-interactive so it
  // cannot be scripted remotely.
  if (!process.stdin.isTTY) {
    process.stderr.write("Refusing to reset: this command requires an interactive local terminal.\n");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

async function main(): Promise<void> {
  const dbPath = join(DATA_DIR, "frolo.sqlite");
  if (!existsSync(dbPath)) {
    process.stderr.write(`No Frolo database found at ${dbPath}.\n`);
    process.exit(1);
    return;
  }
  process.stdout.write(
    "This will reset Frolo's first-run setup: the administrator account, all\n" +
      "sessions, and OOBE completion will be cleared so you can set up again.\n" +
      "Your deployments, VMs, router mappings, recipes, and vault are PRESERVED.\n\n",
  );
  const ok = await confirm('Type "yes" to reset setup: ');
  if (!ok) {
    process.stdout.write("Aborted. Nothing was changed.\n");
    process.exit(0);
    return;
  }
  const db = new Database(dbPath);
  const authStore = new AuthStore(db);
  authStore.resetSetup();
  db.close();
  process.stdout.write("Setup has been reset. Restart Frolo and open the panel to run OOBE again.\n");
}

main().catch((err) => {
  process.stderr.write(`Reset failed: ${err}\n`);
  process.exit(1);
});
