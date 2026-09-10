// Real Playwright-backed PageDriver for router Teach Mode replay + recording
// (Task 3). Playwright is an OPTIONAL dependency, dynamically imported so the
// package builds and unit-tests run without it. Tests use a fake PageDriver and
// never launch a browser; this driver only runs when a real deployment exposes
// ports through a real router.
//
// Key behaviors:
//  - Maps our semantic Locator model to Playwright locators (role/label/name/
//    data-attr/id/nearby-text/dom-path). Coordinates are the explicit last
//    resort and are only used when present.
//  - countMatches() returns the number of matching elements so the shared core
//    resolver can refuse to act on missing/ambiguous targets.
//  - NEVER stores passwords: this driver only receives already-resolved values
//    from the provider at replay time; recording emits variable references.
//  - Teach Mode can open a VISIBLE window (headless:false); replay defaults to
//    headless. Per-profile TLS trust: for self-signed routers we allow the
//    browser context to ignore HTTPS errors ONLY when a pin is configured.

import type { Locator, RouterTrust } from "@frolo/contracts";
import type { PageDriver, RealRouterConfig } from "./real.js";

// Structural subset of the Playwright API we use, so this file type-checks
// without @playwright/test types installed.
interface PwLocator {
  count(): Promise<number>;
  first(): PwLocator;
  fill(value: string): Promise<void>;
  click(): Promise<void>;
  check(): Promise<void>;
  selectOption(value: string): Promise<void>;
  getByText(text: string): PwLocator;
}
interface PwFrameLike {
  goto?(url: string): Promise<unknown>;
  getByRole(role: string, opts?: { name?: string }): PwLocator;
  getByLabel(text: string): PwLocator;
  locator(selector: string): PwLocator;
  getByText(text: string): PwLocator;
  waitForLoadState(state?: string): Promise<void>;
  frameLocator?(selector: string): PwFrameLike;
}
interface PwPage extends PwFrameLike {
  goto(url: string): Promise<unknown>;
  on(event: string, cb: (dialog: { accept(): Promise<void>; message(): string }) => void): void;
  mouse: { click(x: number, y: number): Promise<void> };
  close(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}

export interface PlaywrightOptions {
  headless?: boolean; // false for visible Teach Mode recording
}

export class PlaywrightPageDriver implements PageDriver {
  private frame: PwFrameLike;
  private pendingDialog: { accept(): Promise<void>; message(): string } | null = null;

  constructor(
    private readonly browser: PwBrowser,
    private readonly context: PwContext,
    private readonly page: PwPage,
  ) {
    this.frame = page;
    page.on("dialog", (d) => {
      this.pendingDialog = d;
    });
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url);
    this.frame = this.page;
  }
  async countMatches(loc: Locator): Promise<number> {
    const pw = this.toPw(loc);
    if (!pw) return 0;
    try {
      return await pw.count();
    } catch {
      return 0;
    }
  }
  async fill(loc: Locator, value: string): Promise<void> {
    await this.resolve(loc).fill(value);
  }
  async select(loc: Locator, value: string): Promise<void> {
    await this.resolve(loc).selectOption(value);
  }
  async check(loc: Locator): Promise<void> {
    await this.resolve(loc).check();
  }
  async click(loc: Locator): Promise<void> {
    if (loc.by === "coordinates") {
      await this.page.mouse.click(loc.x, loc.y);
      return;
    }
    await this.resolve(loc).click();
  }
  async enterFrame(frame: string): Promise<void> {
    if (this.page.frameLocator) {
      this.frame = this.page.frameLocator(frameSelector(frame)) as unknown as PwFrameLike;
    }
  }
  async waitForLoad(): Promise<void> {
    await this.frame.waitForLoadState?.("networkidle");
  }
  async acceptDialog(): Promise<void> {
    if (this.pendingDialog) {
      await this.pendingDialog.accept();
      this.pendingDialog = null;
    }
  }
  async hasDialog(): Promise<boolean> {
    return this.pendingDialog !== null;
  }
  async ruleExists(ruleName: string): Promise<boolean> {
    try {
      return (await this.frame.getByText(ruleName).count()) > 0;
    } catch {
      return false;
    }
  }
  async close(): Promise<void> {
    await this.page.close().catch(() => {});
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  private resolve(loc: Locator): PwLocator {
    const pw = this.toPw(loc);
    if (!pw) throw new Error(`cannot resolve locator by ${loc.by}`);
    return pw.first();
  }

  // Map our Locator model onto a Playwright locator on the current frame.
  private toPw(loc: Locator): PwLocator | null {
    const f = this.frame;
    switch (loc.by) {
      case "role":
        return f.getByRole(loc.role, loc.name ? { name: loc.name } : undefined);
      case "label":
        return f.getByLabel(loc.text);
      case "name":
        return f.locator(`[name=${cssQuote(loc.value)}]`);
      case "dataAttr":
        return f.locator(`[${loc.attr}=${cssQuote(loc.value)}]`);
      case "id":
        return f.locator(`#${cssEscapeId(loc.value)}`);
      case "nearbyText":
        return f.getByText(loc.text);
      case "domPath":
        return f.locator(loc.path);
      case "coordinates":
        return null; // handled directly in click()
    }
  }
}

// Factory that opens a real Playwright chromium driver. Used by the server's
// real composition. Playwright is dynamically imported (optional dep).
export function makePlaywrightRouterConfig(opts: PlaywrightOptions = {}): RealRouterConfig {
  return {
    async openDriver(routerUrl: string, trust: RouterTrust): Promise<PageDriver> {
      const specifier = "playwright";
      const pw = (await import(specifier)) as unknown as {
        chromium: { launch(o?: Record<string, unknown>): Promise<PwBrowser> };
      };
      const browser = await pw.chromium.launch({ headless: opts.headless ?? true });
      // Only ignore HTTPS errors when the user has pinned a fingerprint for this
      // router (self-signed homelab UIs). Otherwise keep TLS validation on.
      const context = await browser.newContext({
        ignoreHTTPSErrors: trust.scheme === "https" && Boolean(trust.pinnedCertFingerprint),
      });
      const page = await context.newPage();
      if (routerUrl) await page.goto(routerUrl);
      return new PlaywrightPageDriver(browser, context, page);
    },
  };
}

function frameSelector(frame: string): string {
  // Accept a raw selector, an iframe name, or a #id.
  if (frame.startsWith("#") || frame.includes("[") || frame.includes(" ")) return frame;
  return `iframe[name=${cssQuote(frame)}], #${cssEscapeId(frame)}`;
}
function cssQuote(v: string): string {
  return `"${v.replace(/"/g, '\\"')}"`;
}
function cssEscapeId(v: string): string {
  return v.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
