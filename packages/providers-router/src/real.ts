// Real router provider (req §8, §9, Phase 8). Drives a real router admin UI with
// Playwright to replay taught workflows and record new ones. It reuses the SAME
// core locator ranking (resolveLocators) as the fake, so behavior is identical:
// it ranks matches, refuses to guess on missing/ambiguous targets, handles
// loading/frames/dialogs/manual checkpoints, and never logs secret values.
//
// SAFETY: the browser is injected via a PageDriver seam. The desktop app (main
// process) supplies a Playwright-backed driver that opens a VISIBLE, isolated
// Chromium window and enforces per-profile TLS trust. Tests inject a fake driver
// and NEVER launch a browser. Real mode stays hidden until Phase 8 tests pass.

import type {
  Locator,
  RecordedStep,
  ReplayReport,
  RouterProvider,
  RouterTrust,
  RuleExistence,
  TeachSession,
  VarBindings,
  Workflow,
} from "@frolo/contracts";
import { resolveLocators } from "@frolo/core";

// Abstract page driver: counts locator matches, performs actions, manages frames
// and dialogs. A Playwright implementation lives in the desktop app.
export interface PageDriver {
  goto(url: string): Promise<void>;
  countMatches(loc: Locator): Promise<number>;
  fill(loc: Locator, value: string): Promise<void>;
  select(loc: Locator, value: string): Promise<void>;
  check(loc: Locator): Promise<void>;
  click(loc: Locator): Promise<void>;
  enterFrame(frame: string): Promise<void>;
  waitForLoad(): Promise<void>;
  acceptDialog(): Promise<void>;
  hasDialog(): Promise<boolean>;
  // Does a rule with this name currently exist in the router UI?
  ruleExists(ruleName: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface RealRouterConfig {
  openDriver(routerUrl: string, trust: RouterTrust): Promise<PageDriver>;
}

export class RealRouterProvider implements RouterProvider {
  private drivers = new Map<string, PageDriver>();

  constructor(private readonly config: RealRouterConfig) {}

  async openTeachWindow(routerUrl: string, trust: RouterTrust): Promise<TeachSession> {
    const driver = await this.config.openDriver(routerUrl, trust);
    const id = `teach-${Date.now()}`;
    this.drivers.set(id, driver);
    return { id, routerUrl };
  }

  // Live recording is captured by an injected script in the real driver; that
  // wiring emits CaptureEvents which the recorder turns into RecordedSteps. The
  // provider surface here is the async iterator the controller consumes.
  async *record(_session: TeachSession): AsyncIterable<RecordedStep> {
    // The desktop driver pushes capture events; this generator is fed by it.
    // Left as a no-op stream in the library layer.
  }

  async replay(workflow: Workflow, vars: VarBindings, trust: RouterTrust, routerUrl?: string): Promise<ReplayReport> {
    const driver = await this.config.openDriver(routerUrl ?? "", trust);
    try {
      let stepsRun = 0;
      for (let i = 0; i < workflow.steps.length; i++) {
        const step = workflow.steps[i]!;
        const outcome = await this.runStep(driver, step, vars);
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
    } finally {
      await driver.close();
    }
  }

  async probeRule(workflow: Workflow, vars: VarBindings, trust: RouterTrust, routerUrl?: string): Promise<RuleExistence> {
    const ruleName = vars["rule_name"];
    if (!ruleName) return { exists: false, detailSanitized: "no rule_name binding" };
    const driver = await this.config.openDriver(routerUrl ?? "", trust);
    try {
      for (const step of workflow.steps) {
        if (step.kind === "navigate" && step.meta.url) await driver.goto(step.meta.url);
        if (step.kind === "waitLoad") await driver.waitForLoad();
      }
      return { exists: await driver.ruleExists(ruleName) };
    } finally {
      await driver.close();
    }
  }

  private async runStep(
    driver: PageDriver,
    step: RecordedStep,
    vars: VarBindings,
  ): Promise<{ ok: true } | { ok: false; reason: "missing" | "ambiguous" | "manual"; detail: string }> {
    switch (step.kind) {
      case "navigate":
        if (step.meta.url) await driver.goto(step.meta.url);
        return { ok: true };
      case "waitLoad":
        await driver.waitForLoad();
        return { ok: true };
      case "enterFrame":
        if (step.meta.frame) await driver.enterFrame(step.meta.frame);
        return { ok: true };
      case "manualCheckpoint":
        return { ok: false, reason: "manual", detail: step.meta.manualReason ?? "manual step" };
      case "confirmDialog":
        if (!(await driver.hasDialog())) {
          return { ok: false, reason: "missing", detail: "no confirmation dialog present" };
        }
        await driver.acceptDialog();
        return { ok: true };
      case "verifyRule": {
        const ruleName = vars["rule_name"];
        if (!ruleName) return { ok: false, reason: "missing", detail: "no rule_name binding" };
        return (await driver.ruleExists(ruleName))
          ? { ok: true }
          : { ok: false, reason: "missing", detail: "expected rule not found" };
      }
      case "expectSuccess":
      case "click":
      case "fill":
      case "fillSecret":
      case "select":
      case "check": {
        // Resolve using the SAME ranking as the fake; refuse to guess.
        const resolution = await this.resolveAsync(driver, step.locators);
        if (!resolution.ok) return { ok: false, reason: resolution.reason, detail: resolution.detail };
        const loc = resolution.locator;
        if (step.kind === "click" || step.kind === "expectSuccess") {
          await driver.click(loc);
        } else if (step.kind === "check") {
          await driver.check(loc);
        } else if (step.kind === "select") {
          const value = this.bindingValue(step, vars);
          if (value === null) return { ok: false, reason: "missing", detail: "no value for binding" };
          await driver.select(loc, value);
        } else {
          const value = this.bindingValue(step, vars);
          if (value === null) return { ok: false, reason: "missing", detail: "no value for binding" };
          await driver.fill(loc, value);
        }
        return { ok: true };
      }
    }
  }

  // Async adapter around the pure ranking: gather match counts from the driver,
  // then apply resolveLocators with a synchronous cache.
  private async resolveAsync(
    driver: PageDriver,
    locators: Locator[],
  ): Promise<
    | { ok: true; locator: Locator }
    | { ok: false; reason: "missing" | "ambiguous"; detail: string }
  > {
    const counts = new Map<Locator, number>();
    for (const loc of locators) counts.set(loc, await driver.countMatches(loc));
    return resolveLocators(locators, (loc) => counts.get(loc) ?? 0);
  }

  private bindingValue(step: RecordedStep, vars: VarBindings): string | null {
    const b = step.binding;
    if (!b) return null;
    if (b.kind === "fixed") return b.value;
    if (b.kind === "ask") return vars["__ask__"] ?? null;
    return vars[b.name] ?? null;
  }
}
