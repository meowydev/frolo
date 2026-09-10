#!/usr/bin/env node
// Dev launcher (req: root `pnpm dev` starts API + web and prints the exact local
// URL). Runs the Fastify server (built) on :4512 and the Vite dev server (which
// proxies /api to the server), then prints where to open the panel.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverEntry = join(root, "packages/server/dist/bin/frolo-server.js");
const UI_PORT = 5273;

if (!existsSync(serverEntry)) {
  console.error("Server is not built yet. Run `pnpm build` first, then `pnpm dev`.");
  process.exit(1);
}

const children = [];
function run(name, cmd, args, env) {
  const child = spawn(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env } });
  child.on("exit", (code) => {
    console.log(`[${name}] exited with ${code}`);
    shutdown();
  });
  children.push(child);
  return child;
}
function shutdown() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// API server on :4512 with a local dev data dir (mock mode).
run("api", process.execPath, [serverEntry], {
  FROLO_PORT: "4512",
  FROLO_HOST: "127.0.0.1",
  FROLO_DATA_DIR: join(root, ".dev-data"),
  // No FROLO_WEB_ROOT in dev — Vite serves the UI and proxies /api.
});

// Vite dev server for the web panel.
run("web", "pnpm", ["--filter", "@frolo/ui", "dev"]);

setTimeout(() => {
  console.log("\n────────────────────────────────────────────────────────");
  console.log(`  Frolo (dev) — open the panel at:  http://localhost:${UI_PORT}`);
  console.log(`  API is on http://localhost:4512 (proxied via the UI)`);
  console.log("────────────────────────────────────────────────────────\n");
}, 1500);
