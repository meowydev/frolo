// Abstract DOM model for router fixtures. It captures exactly the attributes a
// locator can match against, so the same `resolveLocators` logic used at real
// replay (Playwright) can be exercised deterministically in tests. Fixture A is
// a clean labelled form; fixture B uses generated ids, nested navigation,
// loading states, and a confirmation dialog.

import type { Locator } from "@frolo/contracts";

export interface DomElement {
  ref: string; // stable internal handle for the model
  role?: string;
  accName?: string; // accessible name
  label?: string; // associated <label> text
  id?: string;
  idGenerated?: boolean;
  name?: string; // name / data-* attribute value
  dataAttrs?: Record<string, string>;
  nearbyHeading?: string;
  nearbyRow?: string;
  // frame this element lives in (undefined = top document)
  frame?: string;
  // current value (for inputs/selects/checkboxes)
  value?: string;
  checked?: boolean;
}

export interface DomPage {
  url: string;
  // elements currently present in the DOM
  elements: DomElement[];
  // whether a loading state is currently active (fixture B)
  loading?: boolean;
  // a pending confirmation dialog (fixture B)
  pendingDialog?: { message: string };
}

// Count how many elements match a single locator (the MatchCounter for core).
export function countMatches(elements: DomElement[], loc: Locator): number {
  return elements.filter((el) => matches(el, loc)).length;
}

export function findMatch(elements: DomElement[], loc: Locator): DomElement | null {
  const hits = elements.filter((el) => matches(el, loc));
  return hits.length === 1 ? hits[0]! : null;
}

function matches(el: DomElement, loc: Locator): boolean {
  switch (loc.by) {
    case "role":
      if (el.role !== loc.role) return false;
      if (loc.name === undefined) return true;
      return el.accName === loc.name;
    case "label":
      return el.label === loc.text;
    case "id":
      return el.id === loc.value;
    case "name":
      return el.name === loc.value;
    case "dataAttr":
      return el.dataAttrs?.[loc.attr] === loc.value;
    case "nearbyText":
      return loc.relation === "heading"
        ? el.nearbyHeading === loc.text
        : el.nearbyRow === loc.text;
    case "domPath":
      // model treats domPath as an opaque ref match
      return el.ref === loc.path;
    case "coordinates":
      // coordinates never match in the model (last resort only, real DOM)
      return false;
  }
}
