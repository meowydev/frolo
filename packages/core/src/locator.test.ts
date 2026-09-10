import { describe, it, expect } from "vitest";
import type { Locator } from "@frolo/contracts";
import { rankLocators, resolveLocators, locatorScore } from "./locator.js";

describe("locator ranking", () => {
  it("ranks role+name above generated id and coordinates", () => {
    const locs: Locator[] = [
      { by: "coordinates", x: 10, y: 20, lastResort: true },
      { by: "id", value: "ext-a1b2c3d4", generated: true },
      { by: "role", role: "textbox", name: "External port" },
    ];
    const ranked = rankLocators(locs);
    expect(ranked[0]!.by).toBe("role");
    expect(ranked[ranked.length - 1]!.by).toBe("coordinates");
  });

  it("distrusts generated ids relative to stable ids", () => {
    expect(locatorScore({ by: "id", value: "x", generated: false })).toBeGreaterThan(
      locatorScore({ by: "id", value: "x", generated: true }),
    );
  });
});

describe("locator resolution", () => {
  const locs: Locator[] = [
    { by: "role", role: "textbox", name: "Port" },
    { by: "label", text: "Port" },
    { by: "id", value: "gen-xyz", generated: true },
  ];

  it("picks the highest-ranked unique match", () => {
    const res = resolveLocators(locs, (loc) => (loc.by === "role" ? 1 : 5));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.locator.by).toBe("role");
  });

  it("falls to a lower strategy if the best is not unique", () => {
    const res = resolveLocators(locs, (loc) => (loc.by === "label" ? 1 : 3));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.locator.by).toBe("label");
  });

  it("stops on ambiguous (multiple matches, none unique)", () => {
    const res = resolveLocators(locs, () => 2);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("ambiguous");
  });

  it("stops on missing (no matches)", () => {
    const res = resolveLocators(locs, () => 0);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing");
  });
});
