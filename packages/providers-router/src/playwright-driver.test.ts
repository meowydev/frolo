import { describe, it, expect } from "vitest";
import type { Locator } from "@frolo/contracts";
import { PlaywrightPageDriver } from "./playwright-driver.js";

// A fake Playwright page that records how our Locator model is translated into
// Playwright locator calls, WITHOUT launching a browser. Each getBy*/locator
// call returns a fake locator whose count() is controlled by a routing table.
type Call = { kind: string; arg?: unknown; opts?: unknown };

function fakePage(matchCounts: Record<string, number>) {
  const calls: Call[] = [];
  let lastKey = "";
  const filled: Record<string, string> = {};
  const clicked: string[] = [];

  const mkLoc = (key: string) => {
    lastKey = key;
    const self: Record<string, unknown> = {
      count: async () => matchCounts[key] ?? 0,
      first: () => self,
      fill: async (v: string) => void (filled[key] = v),
      click: async () => void clicked.push(key),
      check: async () => void clicked.push(`check:${key}`),
      selectOption: async (v: string) => void (filled[key] = v),
      getByText: (t: string) => mkLoc(`text:${t}`),
    };
    return self;
  };

  const page: Record<string, unknown> = {
    goto: async () => {},
    on: () => {},
    mouse: { click: async () => {} },
    waitForLoadState: async () => {},
    getByRole: (role: string, opts?: { name?: string }) => {
      calls.push({ kind: "role", arg: role, opts });
      return mkLoc(`role:${role}:${opts?.name ?? ""}`);
    },
    getByLabel: (t: string) => {
      calls.push({ kind: "label", arg: t });
      return mkLoc(`label:${t}`);
    },
    locator: (sel: string) => {
      calls.push({ kind: "locator", arg: sel });
      return mkLoc(`sel:${sel}`);
    },
    getByText: (t: string) => {
      calls.push({ kind: "text", arg: t });
      return mkLoc(`text:${t}`);
    },
  };
  return { page, calls, filled, clicked, lastKey: () => lastKey };
}

function driver(f: ReturnType<typeof fakePage>): PlaywrightPageDriver {
  // The driver only needs `page`; browser/context are used at close().
  const noop = { close: async () => {} } as unknown as never;
  return new PlaywrightPageDriver(noop, noop, f.page as never);
}

describe("PlaywrightPageDriver locator mapping (no browser)", () => {
  it("maps role+name, label, name, data-attr, and id locators", async () => {
    const f = fakePage({});
    const d = driver(f);
    const locs: Locator[] = [
      { by: "role", role: "textbox", name: "External port" },
      { by: "label", text: "Rule name" },
      { by: "name", value: "external_port" },
      { by: "dataAttr", attr: "data-testid", value: "apply" },
      { by: "id", value: "z91k-ap", generated: true },
    ];
    for (const loc of locs) await d.countMatches(loc);
    const kinds = f.calls.map((c) => `${c.kind}:${String(c.arg)}`);
    expect(kinds).toContain("role:textbox");
    expect(kinds).toContain("label:Rule name");
    expect(kinds.some((k) => k.startsWith("locator:[name="))).toBe(true);
    expect(kinds.some((k) => k.includes("data-testid="))).toBe(true);
    expect(kinds.some((k) => k.startsWith("locator:#"))).toBe(true);
  });

  it("countMatches reflects the DOM (drives refuse-to-guess upstream)", async () => {
    const f = fakePage({ "role:button:Apply": 1, "label:Missing": 0 });
    const d = driver(f);
    expect(await d.countMatches({ by: "role", role: "button", name: "Apply" })).toBe(1);
    expect(await d.countMatches({ by: "label", text: "Missing" })).toBe(0);
  });

  it("fill routes the value to the resolved element (values are ephemeral)", async () => {
    const f = fakePage({});
    const d = driver(f);
    await d.fill({ by: "label", text: "Rule name" }, "frolo-web");
    expect(f.filled["label:Rule name"]).toBe("frolo-web");
  });

  it("ruleExists uses text search", async () => {
    const f = fakePage({ "text:frolo-web": 1 });
    const d = driver(f);
    expect(await d.ruleExists("frolo-web")).toBe(true);
    const f2 = fakePage({ "text:absent": 0 });
    const d2 = driver(f2);
    expect(await d2.ruleExists("absent")).toBe(false);
  });
});
