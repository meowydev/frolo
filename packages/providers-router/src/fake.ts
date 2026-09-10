// Fake router provider (req §9, §14.3-4). Replays taught workflows against a
// RouterFixture using core's ranked locator resolution. It:
//  - refuses to guess: ambiguous/missing target => stop + repair request (§9.2/3)
//  - resolves credential vars from provided bindings (from the vault) (§9.4)
//  - never logs secret values (bindings are consumed, not stored)
//  - handles loading waits, frames, confirmation dialogs, manual checkpoints
//  - verifies the rule exists for verifyRule / find (§9.5)

import type {
  RouterProvider,
  RouterTrust,
  TeachSession,
  ReplayReport,
  RuleExistence,
  VarBindings,
  Workflow,
  RecordedStep,
} from "@frolo/contracts";
import { resolveLocators } from "@frolo/core";
import { countMatches, findMatch } from "./dom-model.js";
import type { RouterFixture } from "./fixtures.js";

export interface FakeRouterOptions {
  // If true, drain loading ticks automatically on waitLoad.
  autoDrainLoading?: boolean;
}

export class FakeRouterProvider implements RouterProvider {
  constructor(
    private readonly fixture: RouterFixture,
    private readonly opts: FakeRouterOptions = {},
  ) {}

  async openTeachWindow(routerUrl: string, _trust: RouterTrust): Promise<TeachSession> {
    return { id: `teach-${Date.now()}`, routerUrl };
  }

  // Recording is implemented by the real provider (Phase 7). The fake exposes
  // the pre-recorded fixture workflows instead of live recording.
  async *record(_session: TeachSession): AsyncIterable<RecordedStep> {
    // no-op for the fake; recording is a Phase 7 concern
  }

  async replay(workflow: Workflow, vars: VarBindings, _trust: RouterTrust): Promise<ReplayReport> {
    let stepsRun = 0;
    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i]!;
      const outcome = this.runStep(step, vars);
      if (!outcome.ok) {
        return {
          ok: false,
          stepsRun,
          repair: { stepIndex: i, reason: outcome.reason, detail: outcome.detail },
          detailSanitized: `step ${i} (${step.kind}) needs repair: ${outcome.detail}`,
        };
      }
      stepsRun++;
    }
    return { ok: true, stepsRun };
  }

  async probeRule(workflow: Workflow, vars: VarBindings, _trust: RouterTrust): Promise<RuleExistence> {
    const ruleName = vars["rule_name"];
    if (!ruleName) return { exists: false, detailSanitized: "no rule_name binding" };
    // For fixture B, ensure we're on the advanced page + loading drained.
    for (const step of workflow.steps) {
      if (step.kind === "navigate" && step.meta.url) this.fixture.navigate(step.meta.url);
      if (step.kind === "waitLoad") this.drainLoading();
    }
    return { exists: this.fixture.hasRule(ruleName) };
  }

  // --- internal ---
  private runStep(
    step: RecordedStep,
    vars: VarBindings,
  ): { ok: true } | { ok: false; reason: "missing" | "ambiguous" | "manual"; detail: string } {
    switch (step.kind) {
      case "navigate":
        if (step.meta.url) this.fixture.navigate(step.meta.url);
        return { ok: true };
      case "waitLoad":
        this.drainLoading();
        return { ok: true };
      case "enterFrame":
        // Frame entry is modeled implicitly (elements carry a frame tag).
        return { ok: true };
      case "manualCheckpoint":
        // Not auto-replayed (req §8.2b): stop and ask the user to perform it.
        return { ok: false, reason: "manual", detail: step.meta.manualReason ?? "manual step" };
      case "confirmDialog": {
        const page = this.fixture.page();
        if (!page.pendingDialog) {
          return { ok: false, reason: "missing", detail: "no confirmation dialog present" };
        }
        this.fixture.confirmDialog();
        return { ok: true };
      }
      case "verifyRule": {
        const ruleName = vars["rule_name"];
        if (!ruleName) return { ok: false, reason: "missing", detail: "no rule_name binding" };
        if (!this.fixture.hasRule(ruleName)) {
          return { ok: false, reason: "missing", detail: "expected rule not found" };
        }
        return { ok: true };
      }
      case "expectSuccess":
      case "click":
      case "fill":
      case "fillSecret":
      case "select":
      case "check": {
        // Resolve the target element using ranked locators; refuse to guess.
        const page = this.fixture.page();
        const res = resolveLocators(step.locators, (loc) => countMatches(page.elements, loc));
        if (!res.ok) {
          return { ok: false, reason: res.reason, detail: res.detail };
        }
        const el = findMatch(page.elements, res.locator)!;
        // Apply the action.
        if (step.kind === "click" || step.kind === "expectSuccess") {
          this.fixture.click(el.ref);
        } else if (step.kind === "check") {
          this.fixture.setChecked(el.ref, true);
        } else {
          // fill / fillSecret / select: resolve the value from the binding.
          const value = this.resolveBinding(step, vars);
          if (value === null) {
            return { ok: false, reason: "missing", detail: "no value for binding" };
          }
          this.fixture.setValue(el.ref, value);
        }
        return { ok: true };
      }
    }
  }

  private resolveBinding(step: RecordedStep, vars: VarBindings): string | null {
    const b = step.binding;
    if (!b) return null;
    if (b.kind === "fixed") return b.value;
    if (b.kind === "ask") return vars["__ask__"] ?? null;
    // var binding — resolved from the provided bindings (which the controller
    // fills from the vault for credential vars). Never logged here.
    return vars[b.name] ?? null;
  }

  private drainLoading(): void {
    let guard = 0;
    while (this.fixture.tickLoading() && guard++ < 10) {
      /* keep ticking until loaded */
    }
  }
}
