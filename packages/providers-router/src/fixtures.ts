// Router fixtures A and B (req §14.3, §14.4). Each fixture models a small router
// admin "site" as a state machine of pages, plus the router's actual
// forwarding-rule table. Replaying a taught workflow drives these exactly like
// a real UI would be driven, and the rule table lets `find`/`verify` work.

import type { DomElement, DomPage } from "./dom-model.js";

export interface ForwardingRule {
  name: string;
  externalPort: number;
  internalIp: string;
  internalPort: number;
  protocol: string;
}

export interface RouterFixture {
  kind: "fixtureA" | "fixtureB";
  page(): DomPage;
  navigate(url: string): void;
  // Simulate typing/selecting/checking into a currently-present element.
  setValue(ref: string, value: string): void;
  setChecked(ref: string, checked: boolean): void;
  click(ref: string): void;
  // Confirm a pending dialog (fixture B).
  confirmDialog(): void;
  // Router rule table:
  rules(): ForwardingRule[];
  hasRule(name: string): boolean;
  // Advance any loading state (fixture B). Returns true if still loading.
  tickLoading(): boolean;
  reset(): void;
}

// --- Fixture A: clean, labelled single-page form ---------------------------
export class RouterFixtureA implements RouterFixture {
  kind = "fixtureA" as const;
  private ruleTable: ForwardingRule[] = [];
  private form = { name: "", ext: "", ip: "", intp: "", proto: "TCP", user: "", pass: "" };
  private loggedIn = false;

  page(): DomPage {
    const els: DomElement[] = [
      { ref: "a.user", role: "textbox", accName: "Username", label: "Username", id: "username", name: "username" },
      { ref: "a.pass", role: "textbox", accName: "Password", label: "Password", id: "password", name: "password" },
      { ref: "a.login", role: "button", accName: "Sign in", id: "login-btn" },
      { ref: "a.name", role: "textbox", accName: "Rule name", label: "Rule name", id: "rule-name", name: "rule_name" },
      { ref: "a.ext", role: "textbox", accName: "External port", label: "External port", id: "ext-port", name: "external_port" },
      { ref: "a.ip", role: "textbox", accName: "Internal IP", label: "Internal IP", id: "int-ip", name: "internal_ip" },
      { ref: "a.intp", role: "textbox", accName: "Internal port", label: "Internal port", id: "int-port", name: "internal_port" },
      { ref: "a.proto", role: "combobox", accName: "Protocol", label: "Protocol", id: "protocol", name: "protocol" },
      { ref: "a.save", role: "button", accName: "Add rule", id: "save-btn" },
      { ref: "a.success", role: "status", accName: "Rule added", nearbyHeading: "Port Forwarding" },
    ];
    return { url: "/portforward", elements: els };
  }

  navigate(_url: string): void {}
  setValue(ref: string, value: string): void {
    if (ref === "a.name") this.form.name = value;
    else if (ref === "a.ext") this.form.ext = value;
    else if (ref === "a.ip") this.form.ip = value;
    else if (ref === "a.intp") this.form.intp = value;
    else if (ref === "a.proto") this.form.proto = value;
    else if (ref === "a.user") this.form.user = value;
    else if (ref === "a.pass") this.form.pass = value;
  }
  setChecked(): void {}
  click(ref: string): void {
    if (ref === "a.login") this.loggedIn = true;
    if (ref === "a.save") {
      this.ruleTable.push({
        name: this.form.name,
        externalPort: Number(this.form.ext),
        internalIp: this.form.ip,
        internalPort: Number(this.form.intp),
        protocol: this.form.proto,
      });
    }
  }
  confirmDialog(): void {}
  rules(): ForwardingRule[] {
    return this.ruleTable;
  }
  hasRule(name: string): boolean {
    return this.ruleTable.some((r) => r.name === name);
  }
  deleteRule(name: string): void {
    this.ruleTable = this.ruleTable.filter((r) => r.name !== name);
  }
  tickLoading(): boolean {
    return false;
  }
  reset(): void {
    this.ruleTable = [];
    this.loggedIn = false;
  }
}

// --- Fixture B: generated ids, nested nav, loading, confirm dialog ----------
export class RouterFixtureB implements RouterFixture {
  kind = "fixtureB" as const;
  private ruleTable: ForwardingRule[] = [];
  private form = { name: "", ext: "", ip: "", intp: "", proto: "tcp" };
  private currentUrl = "/";
  private loadingTicks = 0;
  private dialog: { message: string } | null = null;
  private pendingSave = false;

  page(): DomPage {
    // Nested navigation: advanced page only reachable after navigating there.
    const onAdvanced = this.currentUrl.includes("/advanced/nat");
    const els: DomElement[] = [];
    // Generated-id inputs; the ONLY reliable locators are role+name/label/data.
    els.push(
      { ref: "b.user", role: "textbox", accName: "Login", id: "x8f2a-usr", idGenerated: true, dataAttrs: { "data-field": "user" }, frame: "authFrame" },
      { ref: "b.pass", role: "textbox", accName: "Login password", id: "x8f2a-pwd", idGenerated: true, dataAttrs: { "data-field": "pass" }, frame: "authFrame" },
    );
    if (onAdvanced && !this.loadingTicks) {
      els.push(
        { ref: "b.name", role: "textbox", accName: "Description", label: "Description", id: "z91k-nm", idGenerated: true, dataAttrs: { "data-testid": "rule-name" }, nearbyHeading: "NAT / Port Forwarding" },
        { ref: "b.ext", role: "textbox", accName: "WAN port", label: "WAN port", id: "z91k-ep", idGenerated: true, dataAttrs: { "data-testid": "ext-port" } },
        { ref: "b.ip", role: "textbox", accName: "LAN host", label: "LAN host", id: "z91k-ip", idGenerated: true, dataAttrs: { "data-testid": "int-ip" } },
        { ref: "b.intp", role: "textbox", accName: "LAN port", label: "LAN port", id: "z91k-lp", idGenerated: true, dataAttrs: { "data-testid": "int-port" } },
        { ref: "b.proto", role: "combobox", accName: "Protocol", label: "Protocol", id: "z91k-pr", idGenerated: true, dataAttrs: { "data-testid": "proto" } },
        { ref: "b.save", role: "button", accName: "Apply", id: "z91k-ap", idGenerated: true, dataAttrs: { "data-testid": "apply" } },
      );
    }
    return {
      url: this.currentUrl,
      elements: els,
      loading: this.loadingTicks > 0,
      pendingDialog: this.dialog ?? undefined,
    };
  }

  navigate(url: string): void {
    this.currentUrl = url;
    // Navigating to the advanced page triggers a loading spinner.
    if (url.includes("/advanced/nat")) this.loadingTicks = 2;
  }
  setValue(ref: string, value: string): void {
    if (ref === "b.name") this.form.name = value;
    else if (ref === "b.ext") this.form.ext = value;
    else if (ref === "b.ip") this.form.ip = value;
    else if (ref === "b.intp") this.form.intp = value;
    else if (ref === "b.proto") this.form.proto = value;
  }
  setChecked(): void {}
  click(ref: string): void {
    if (ref === "b.save") {
      // Saving opens a confirmation dialog first.
      this.dialog = { message: "Apply new NAT rule?" };
      this.pendingSave = true;
    }
  }
  confirmDialog(): void {
    if (this.pendingSave) {
      this.ruleTable.push({
        name: this.form.name,
        externalPort: Number(this.form.ext),
        internalIp: this.form.ip,
        internalPort: Number(this.form.intp),
        protocol: this.form.proto,
      });
      this.pendingSave = false;
    }
    this.dialog = null;
  }
  rules(): ForwardingRule[] {
    return this.ruleTable;
  }
  hasRule(name: string): boolean {
    return this.ruleTable.some((r) => r.name === name);
  }
  deleteRule(name: string): void {
    this.ruleTable = this.ruleTable.filter((r) => r.name !== name);
  }
  tickLoading(): boolean {
    if (this.loadingTicks > 0) this.loadingTicks--;
    return this.loadingTicks > 0;
  }
  reset(): void {
    this.ruleTable = [];
    this.currentUrl = "/";
    this.loadingTicks = 0;
    this.dialog = null;
    this.pendingSave = false;
  }
}
