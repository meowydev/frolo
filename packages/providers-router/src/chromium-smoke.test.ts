// Chromium launch smoke test as part of the test suite. This proves the exact
// browser the router driver uses can launch and render. It is SKIPPED when the
// Playwright browser binary is not installed (e.g. a fresh checkout that ran
// `pnpm install` with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD), so normal `pnpm test`
// never fails just because browsers aren't downloaded. CI installs Chromium and
// runs the same check; the Docker build bakes in `scripts/chromium-smoke.mjs`.

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

async function loadChromium(): Promise<{
  launch(o?: Record<string, unknown>): Promise<{
    version(): string;
    newContext(): Promise<{ newPage(): Promise<PwPage> }>;
    close(): Promise<void>;
  }>;
} | null> {
  try {
    const req = createRequire(import.meta.url);
    const mod = (await import(req.resolve("playwright"))) as {
      chromium?: unknown;
      default?: { chromium?: unknown };
    };
    return (mod.chromium ?? mod.default?.chromium ?? null) as never;
  } catch {
    return null;
  }
}

interface PwPage {
  setContent(html: string): Promise<void>;
  title(): Promise<string>;
  textContent(sel: string): Promise<string | null>;
}

// Detect whether a browser binary is actually installed (not just the package).
async function browserInstalled(chromium: { executablePath?: () => string }): Promise<boolean> {
  try {
    const { existsSync } = await import("node:fs");
    const p = chromium.executablePath?.();
    return Boolean(p && existsSync(p));
  } catch {
    return false;
  }
}

describe("Chromium launch (router driver browser)", () => {
  it("launches headless Chromium and renders a page (skips if browser not installed)", async () => {
    const chromium = await loadChromium();
    if (!chromium) return; // playwright package missing — nothing to assert
    if (!(await browserInstalled(chromium as never))) return; // browser binary not downloaded

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent("<!doctype html><title>frolo-smoke</title><h1 id=x>ok</h1>");
      expect(await page.title()).toBe("frolo-smoke");
      expect(await page.textContent("#x")).toBe("ok");
      expect(browser.version()).toMatch(/\d+\./);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
