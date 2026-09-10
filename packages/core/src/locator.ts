// Locator ranking + resolution (req §8.3, §8.4, §9.1–§9.3). Pure logic over an
// abstract "resolver" that reports how many elements each locator matches. The
// real router provider supplies a Playwright-backed resolver; tests supply a
// fake. Decision rule: pick the highest-ranked strategy that matches EXACTLY
// one element. If none does, the step is missing/ambiguous -> stop, do not act.

import type { Locator } from "@frolo/contracts";

// Higher score = more trusted. Generated ids and coordinates are distrusted.
export function locatorScore(loc: Locator): number {
  switch (loc.by) {
    case "role":
      return loc.name ? 100 : 70; // role+name best; role alone weaker
    case "label":
      return 90;
    case "dataAttr":
      return 85;
    case "name":
      return 80;
    case "id":
      return loc.generated ? 20 : 75; // generated ids strongly distrusted
    case "nearbyText":
      return loc.relation === "heading" ? 55 : 50;
    case "domPath":
      return 30;
    case "coordinates":
      return 5; // explicit last resort only
  }
}

export function rankLocators(locators: Locator[]): Locator[] {
  return [...locators].sort((a, b) => locatorScore(b) - locatorScore(a));
}

export type MatchCounter = (loc: Locator) => number;

export type Resolution =
  | { ok: true; locator: Locator }
  | { ok: false; reason: "missing" | "ambiguous"; detail: string };

// Resolve to exactly one element using the best strategy available.
export function resolveLocators(
  locators: Locator[],
  countMatches: MatchCounter,
): Resolution {
  const ranked = rankLocators(locators);
  let sawAny = false;
  let sawMultiple = false;
  for (const loc of ranked) {
    const n = countMatches(loc);
    if (n === 1) {
      return { ok: true, locator: loc };
    }
    if (n > 1) sawMultiple = true;
    if (n >= 1) sawAny = true;
  }
  if (sawMultiple || sawAny) {
    return {
      ok: false,
      reason: "ambiguous",
      detail:
        "no locator uniquely identified the element; refusing to guess (req §9.3)",
    };
  }
  return {
    ok: false,
    reason: "missing",
    detail: "no locator matched any element",
  };
}
