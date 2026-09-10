// Teach Mode recorder (req §8). Captures a user's demonstration into Recorded
// steps with MULTIPLE locator strategies per element, distrusting generated ids
// and never storing password values. The recorder is driven by an abstract
// "capture event" stream so it is fully testable without launching Chromium; the
// real Playwright provider (Phase 8) feeds it real capture events.

import type { Locator, RecordedStep, StepKind } from "@frolo/contracts";

// A raw capture event as observed in the page (what a Playwright injected script
// or the real provider would report). It carries every attribute the recorder
// can turn into a locator strategy.
export interface CaptureEvent {
  kind: StepKind;
  // Element attributes (any subset may be present):
  role?: string;
  accName?: string;
  label?: string;
  id?: string;
  name?: string;
  dataAttrs?: Record<string, string>;
  nearbyHeading?: string;
  nearbyRow?: string;
  domPath?: string;
  // Coordinates, only used as an explicitly-marked last resort.
  coordinates?: { x: number; y: number };
  // Navigation / frame / dialog metadata:
  url?: string;
  frame?: string;
  note?: string;
  manualReason?: string;
  // For password fields the raw value is NEVER provided to the recorder.
  isSecret?: boolean;
}

// Heuristic: does an id look generated (random/hashy) rather than stable?
export function looksGenerated(id: string): boolean {
  // Long hex-ish blob (e.g. "a1b2c3d4e5", "deadbeefcafe").
  if (/^[0-9a-f]{8,}$/i.test(id)) return true;
  // Any token that mixes letters AND digits with no separating word boundary
  // (e.g. "z91k", "x8f2a") is treated as generated. Human-readable ids like
  // "username", "ext-port", "rule-name" have no digit-in-word mixing.
  for (const segment of id.split(/[-_.]/)) {
    if (segment.length >= 3 && /[a-z]/i.test(segment) && /\d/.test(segment)) {
      return true;
    }
  }
  return false;
}

// Build the ranked list of locator strategies for a capture event. Order here is
// insertion order; replay re-ranks by trust. Coordinates are added only when no
// semantic strategy is available, and always flagged lastResort.
export function buildLocators(ev: CaptureEvent): Locator[] {
  const locs: Locator[] = [];
  if (ev.role) locs.push({ by: "role", role: ev.role, name: ev.accName });
  if (ev.label) locs.push({ by: "label", text: ev.label });
  if (ev.dataAttrs) {
    for (const [attr, value] of Object.entries(ev.dataAttrs)) {
      locs.push({ by: "dataAttr", attr, value });
    }
  }
  if (ev.name) locs.push({ by: "name", value: ev.name });
  if (ev.id) locs.push({ by: "id", value: ev.id, generated: looksGenerated(ev.id) });
  if (ev.nearbyHeading) locs.push({ by: "nearbyText", text: ev.nearbyHeading, relation: "heading" });
  if (ev.nearbyRow) locs.push({ by: "nearbyText", text: ev.nearbyRow, relation: "row" });
  if (ev.domPath) locs.push({ by: "domPath", path: ev.domPath });

  const hasSemantic = locs.length > 0;
  if (!hasSemantic && ev.coordinates) {
    locs.push({ by: "coordinates", x: ev.coordinates.x, y: ev.coordinates.y, lastResort: true });
  }
  return locs;
}

// Turn a capture event into a RecordedStep. Password fields become fillSecret
// with a var binding and NEVER a value (req §8.7-8.9, §11.4).
export function toRecordedStep(ev: CaptureEvent): RecordedStep {
  const step: RecordedStep = {
    kind: ev.isSecret && ev.kind === "fill" ? "fillSecret" : ev.kind,
    locators: buildLocators(ev),
    meta: {
      url: ev.url,
      frame: ev.frame,
      note: ev.note,
      manualReason: ev.manualReason,
    },
  };
  if (step.kind === "fillSecret") {
    // Bind to the router password by default; the user can re-map in the UI.
    step.binding = { kind: "var", name: "router_password" };
  }
  return step;
}

// Accumulate a recording from a sequence of capture events.
export class RecordingSession {
  private readonly steps: RecordedStep[] = [];

  record(ev: CaptureEvent): RecordedStep {
    const step = toRecordedStep(ev);
    this.steps.push(step);
    return step;
  }

  getSteps(): RecordedStep[] {
    return [...this.steps];
  }
}
