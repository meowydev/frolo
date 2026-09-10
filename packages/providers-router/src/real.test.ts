import { describe, it, expect } from "vitest";
import type { Locator, VarBindings, Workflow } from "@frolo/contracts";
import { RealRouterProvider, type PageDriver } from "./real.js";

// A fake page driver modeling a simple router page. Never launches a browser.
class FakePage implements PageDriver {
  private values = new Map<string, string>();
  private rules = new Set<string>();
  dialogOpen = false;
  // elements keyed by a label locator text
  labels = new Set(["Rule name", "External port", "Internal IP", "Internal port", "Protocol"]);

  async goto(): Promise<void> {}
  async countMatches(loc: Locator): Promise<number> {
    if (loc.by === "label") return this.labels.has(loc.text) ? 1 : 0;
    if (loc.by === "role" && loc.role === "button") return 1;
    return 0;
  }
  async fill(loc: Locator, value: string): Promise<void> {
    if (loc.by === "label") this.values.set(loc.text, value);
  }
  async select(loc: Locator, value: string): Promise<void> {
    if (loc.by === "label") this.values.set(loc.text, value);
  }
  async check(): Promise<void> {}
  async click(): Promise<void> {
    const name = this.values.get("Rule name");
    if (name) this.rules.add(name);
  }
  async enterFrame(): Promise<void> {}
  async waitForLoad(): Promise<void> {}
  async acceptDialog(): Promise<void> {
    this.dialogOpen = false;
  }
  async hasDialog(): Promise<boolean> {
    return this.dialogOpen;
  }
  async ruleExists(ruleName: string): Promise<boolean> {
    return this.rules.has(ruleName);
  }
  async close(): Promise<void> {}
}

const trust = { scheme: "http" as const };
const vars: VarBindings = {
  rule_name: "frolo-web",
  external_port: "8080",
  internal_ip: "192.168.10.50",
  internal_port: "8080",
  protocol: "tcp",
};

function createWorkflow(): Workflow {
  return {
    id: "w",
    routerProfileId: "r",
    kind: "create",
    version: 1,
    steps: [
      { kind: "fill", locators: [{ by: "label", text: "Rule name" }], binding: { kind: "var", name: "rule_name" }, meta: {} },
      { kind: "fill", locators: [{ by: "label", text: "External port" }], binding: { kind: "var", name: "external_port" }, meta: {} },
      { kind: "click", locators: [{ by: "role", role: "button", name: "Add" }], meta: {} },
      { kind: "verifyRule", locators: [], binding: { kind: "var", name: "rule_name" }, meta: {} },
    ],
  };
}

describe("RealRouterProvider (fake page driver, no browser)", () => {
  it("replays a workflow and creates + verifies a rule using ranked locators", async () => {
    const page = new FakePage();
    const p = new RealRouterProvider({ openDriver: async () => page });
    const report = await p.replay(createWorkflow(), vars, trust);
    expect(report.ok).toBe(true);
    expect(await page.ruleExists("frolo-web")).toBe(true);
  });

  it("refuses to guess on a missing target", async () => {
    const page = new FakePage();
    const p = new RealRouterProvider({ openDriver: async () => page });
    const broken: Workflow = {
      id: "b", routerProfileId: "r", kind: "create", version: 1,
      steps: [{ kind: "fill", locators: [{ by: "label", text: "Nonexistent" }], binding: { kind: "var", name: "rule_name" }, meta: {} }],
    };
    const report = await p.replay(broken, vars, trust);
    expect(report.ok).toBe(false);
    expect(report.repair?.reason).toBe("missing");
  });

  it("stops on a manual checkpoint", async () => {
    const page = new FakePage();
    const p = new RealRouterProvider({ openDriver: async () => page });
    const manual: Workflow = {
      id: "m", routerProfileId: "r", kind: "login", version: 1,
      steps: [{ kind: "manualCheckpoint", locators: [], meta: { manualReason: "captcha" } }],
    };
    const report = await p.replay(manual, vars, trust);
    expect(report.ok).toBe(false);
    expect(report.repair?.reason).toBe("manual");
  });
});
