// Missing-runtime-dependency behavior (task 14). The router driver dynamically
// loads the optional `playwright` dependency. If it is absent or malformed, the
// driver must fail with a CLEAR, actionable error — never hang or throw an
// opaque module-resolution stack. We inject a fake loader to simulate each case
// deterministically, with no real browser.

import { describe, it, expect } from "vitest";
import { makePlaywrightRouterConfig } from "./playwright-driver.js";
import type { RouterTrust } from "@frolo/contracts";

const trust: RouterTrust = { scheme: "http" };

describe("router driver: missing/broken playwright dependency", () => {
  it("surfaces a clear error when the dependency cannot be loaded", async () => {
    const cfg = makePlaywrightRouterConfig({
      loadPlaywright: async () => {
        throw new Error("Cannot find package 'playwright'");
      },
    });
    await expect(cfg.openDriver("http://192.168.0.1", trust)).rejects.toThrow(
      /requires the optional 'playwright' dependency/i,
    );
  });

  it("errors clearly when the module loads but has no chromium export", async () => {
    const cfg = makePlaywrightRouterConfig({
      loadPlaywright: async () => ({}), // resolved, but no chromium
    });
    await expect(cfg.openDriver("http://192.168.0.1", trust)).rejects.toThrow(
      /chromium export is unavailable/i,
    );
  });

  it("launches via the injected module when present (no real browser)", async () => {
    const calls: Record<string, unknown> = {};
    const fakeBrowser = {
      async newContext(o?: Record<string, unknown>) {
        calls.contextOpts = o;
        return {
          async newPage() {
            return {
              async goto(url: string) {
                calls.goto = url;
              },
              on() {},
              mouse: { async click() {} },
              async close() {},
            };
          },
          async close() {},
        };
      },
      async close() {},
      version() {
        return "fake";
      },
    };
    const cfg = makePlaywrightRouterConfig({
      loadPlaywright: async () => ({
        chromium: {
          async launch(o?: Record<string, unknown>) {
            calls.launchOpts = o;
            return fakeBrowser as never;
          },
        },
      }),
    });

    const driver = await cfg.openDriver("http://192.168.0.1", trust);
    expect(driver).toBeTruthy();
    // Launched headless with the container-safe sandbox flags.
    expect((calls.launchOpts as { headless?: boolean }).headless).toBe(true);
    expect((calls.launchOpts as { args?: string[] }).args).toContain("--no-sandbox");
    expect(calls.goto).toBe("http://192.168.0.1");
    // Plain http: never ignores HTTPS errors.
    expect((calls.contextOpts as { ignoreHTTPSErrors?: boolean }).ignoreHTTPSErrors).toBe(false);
  });

  it("only ignores HTTPS errors when a cert fingerprint is pinned", async () => {
    const seen: Record<string, unknown> = {};
    const cfg = makePlaywrightRouterConfig({
      loadPlaywright: async () => ({
        chromium: {
          async launch() {
            return {
              async newContext(o?: Record<string, unknown>) {
                seen.opts = o;
                return {
                  async newPage() {
                    return { async goto() {}, on() {}, mouse: { async click() {} }, async close() {} };
                  },
                  async close() {},
                };
              },
              async close() {},
            } as never;
          },
        },
      }),
    });

    await cfg.openDriver("https://192.168.0.1", { scheme: "https", pinnedCertFingerprint: "aa:bb" });
    expect((seen.opts as { ignoreHTTPSErrors?: boolean }).ignoreHTTPSErrors).toBe(true);
  });
});
