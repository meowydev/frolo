#!/usr/bin/env node
// Chromium launch smoke test (req: prove Chromium launches in the container).
//
// Launches the Playwright-managed Chromium headless, renders a trivial page,
// and verifies it can read the DOM back. Exits 0 on success, non-zero on
// failure. This is the exact browser router Teach Mode / replay uses, so a
// green run means the runtime image has Chromium + all its shared libraries.
//
// `playwright` is a dependency of @frolo/providers-router, so this script must
// run in a context where that resolves. Two supported invocations:
//   1) pnpm --filter @frolo/providers-router exec node scripts/chromium-smoke.mjs
//   2) inside the container:  node --input-type=... (see run() below) OR run
//      from /app/packages/providers-router so Node resolves the dependency.
//
// To keep resolution robust across pnpm's isolated store and the container's
// copied node_modules, we resolve `playwright` starting from the router
// package's own directory when available, and fall back to a bare import.

import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

async function loadPlaywright() {
  const here = dirname(fileURLToPath(import.meta.url));
  // Candidate roots that own `playwright` in a normal checkout or the image.
  const candidates = [
    join(here, "..", "packages", "providers-router", "package.json"), // repo/container
    join(here, "..", "package.json"), // repo root (hoisted fallback)
  ].filter(existsSync);

  for (const pkgJson of candidates) {
    try {
      const req = createRequire(pkgJson);
      const entry = req.resolve("playwright");
      const mod = await import(pathToFileURL(entry).href);
      // Depending on whether Node resolves the CJS entry or the package's ESM
      // exports, `chromium` may be a named export or live on `default`.
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return { chromium };
    } catch {
      /* try next */
    }
  }
  // Last resort: bare import (hoisted node_modules).
  const mod = await import("playwright");
  return { chromium: mod.chromium ?? mod.default?.chromium };
}

let chromium;
try {
  ({ chromium } = await loadPlaywright());
  if (!chromium) throw new Error("playwright resolved but chromium export missing");
} catch (err) {
  console.error("FAIL: could not import playwright:", err?.message ?? err);
  process.exit(2);
}

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    // In a container the process typically runs without user namespaces, so
    // --no-sandbox is required. Acceptable for a launch capability check.
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent("<!doctype html><title>frolo-chromium-smoke</title><h1 id=x>ok</h1>");
  const title = await page.title();
  const text = await page.textContent("#x");
  const version = browser.version();
  if (title !== "frolo-chromium-smoke" || text !== "ok") {
    console.error(`FAIL: unexpected DOM (title=${title}, text=${text})`);
    process.exit(1);
  }
  console.log(`OK: Chromium ${version} launched and rendered a page.`);
} catch (err) {
  console.error("FAIL: Chromium did not launch:", err?.message ?? err);
  process.exit(1);
} finally {
  await browser?.close().catch(() => {});
}
