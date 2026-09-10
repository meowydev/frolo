// Pre-recorded fixture workflows (req §14.5a). These contain ONLY variable
// references and fixed non-secret values — never a real credential. Password
// fields use fillSecret with a var binding; no keystrokes/values are stored.

import type { Workflow } from "@frolo/contracts";

// Fixture A: clean labelled form. Login + create/find/delete.
export function fixtureAWorkflows(routerProfileId: string): Workflow[] {
  return [
    {
      id: `${routerProfileId}:login`,
      routerProfileId,
      kind: "login",
      version: 1,
      steps: [
        { kind: "navigate", locators: [], meta: { url: "/portforward" } },
        {
          kind: "fill",
          locators: [{ by: "label", text: "Username" }, { by: "role", role: "textbox", name: "Username" }],
          binding: { kind: "var", name: "router_username" },
          meta: {},
        },
        {
          kind: "fillSecret",
          locators: [{ by: "label", text: "Password" }, { by: "role", role: "textbox", name: "Password" }],
          binding: { kind: "var", name: "router_password" },
          meta: { note: "password field — value never recorded" },
        },
        { kind: "click", locators: [{ by: "role", role: "button", name: "Sign in" }], meta: {} },
        { kind: "waitLoad", locators: [], meta: {} },
      ],
    },
    {
      id: `${routerProfileId}:create`,
      routerProfileId,
      kind: "create",
      version: 1,
      steps: [
        { kind: "fill", locators: [{ by: "label", text: "Rule name" }], binding: { kind: "var", name: "rule_name" }, meta: {} },
        { kind: "fill", locators: [{ by: "label", text: "External port" }], binding: { kind: "var", name: "external_port" }, meta: {} },
        { kind: "fill", locators: [{ by: "label", text: "Internal IP" }], binding: { kind: "var", name: "internal_ip" }, meta: {} },
        { kind: "fill", locators: [{ by: "label", text: "Internal port" }], binding: { kind: "var", name: "internal_port" }, meta: {} },
        { kind: "select", locators: [{ by: "label", text: "Protocol" }], binding: { kind: "var", name: "protocol" }, meta: {} },
        { kind: "click", locators: [{ by: "role", role: "button", name: "Add rule" }], meta: {} },
        { kind: "expectSuccess", locators: [{ by: "role", role: "status", name: "Rule added" }], meta: {} },
        { kind: "verifyRule", locators: [], binding: { kind: "var", name: "rule_name" }, meta: {} },
      ],
    },
    {
      id: `${routerProfileId}:find`,
      routerProfileId,
      kind: "find",
      version: 1,
      steps: [{ kind: "verifyRule", locators: [], binding: { kind: "var", name: "rule_name" }, meta: {} }],
    },
    {
      id: `${routerProfileId}:delete`,
      routerProfileId,
      kind: "delete",
      version: 1,
      steps: [
        { kind: "verifyRule", locators: [], binding: { kind: "var", name: "rule_name" }, meta: { note: "locate before delete" } },
        { kind: "click", locators: [{ by: "role", role: "button", name: "Add rule" }], meta: { note: "delete action in model" } },
      ],
    },
  ];
}

// Fixture B: generated ids, nested nav, loading, confirm dialog. Locators rely
// on role+name / label / data-testid — never on the generated ids.
export function fixtureBWorkflows(routerProfileId: string): Workflow[] {
  return [
    {
      id: `${routerProfileId}:login`,
      routerProfileId,
      kind: "login",
      version: 1,
      steps: [
        { kind: "enterFrame", locators: [], meta: { frame: "authFrame" } },
        { kind: "fill", locators: [{ by: "dataAttr", attr: "data-field", value: "user" }, { by: "role", role: "textbox", name: "Login" }], binding: { kind: "var", name: "router_username" }, meta: { frame: "authFrame" } },
        { kind: "fillSecret", locators: [{ by: "dataAttr", attr: "data-field", value: "pass" }, { by: "role", role: "textbox", name: "Login password" }], binding: { kind: "var", name: "router_password" }, meta: { frame: "authFrame", note: "password — never recorded" } },
      ],
    },
    {
      id: `${routerProfileId}:create`,
      routerProfileId,
      kind: "create",
      version: 1,
      steps: [
        { kind: "navigate", locators: [], meta: { url: "/advanced/nat" } },
        { kind: "waitLoad", locators: [], meta: { note: "wait for spinner" } },
        { kind: "fill", locators: [{ by: "dataAttr", attr: "data-testid", value: "rule-name" }, { by: "label", text: "Description" }], binding: { kind: "var", name: "rule_name" }, meta: {} },
        { kind: "fill", locators: [{ by: "dataAttr", attr: "data-testid", value: "ext-port" }, { by: "label", text: "WAN port" }], binding: { kind: "var", name: "external_port" }, meta: {} },
        { kind: "fill", locators: [{ by: "dataAttr", attr: "data-testid", value: "int-ip" }, { by: "label", text: "LAN host" }], binding: { kind: "var", name: "internal_ip" }, meta: {} },
        { kind: "fill", locators: [{ by: "dataAttr", attr: "data-testid", value: "int-port" }, { by: "label", text: "LAN port" }], binding: { kind: "var", name: "internal_port" }, meta: {} },
        { kind: "select", locators: [{ by: "dataAttr", attr: "data-testid", value: "proto" }, { by: "label", text: "Protocol" }], binding: { kind: "var", name: "protocol" }, meta: {} },
        { kind: "click", locators: [{ by: "dataAttr", attr: "data-testid", value: "apply" }, { by: "role", role: "button", name: "Apply" }], meta: {} },
        { kind: "confirmDialog", locators: [], meta: { note: "confirm Apply new NAT rule?" } },
        { kind: "verifyRule", locators: [], binding: { kind: "var", name: "rule_name" }, meta: {} },
      ],
    },
    {
      id: `${routerProfileId}:find`,
      routerProfileId,
      kind: "find",
      version: 1,
      steps: [{ kind: "verifyRule", locators: [], binding: { kind: "var", name: "rule_name" }, meta: {} }],
    },
    {
      id: `${routerProfileId}:delete`,
      routerProfileId,
      kind: "delete",
      version: 1,
      steps: [
        { kind: "navigate", locators: [], meta: { url: "/advanced/nat" } },
        { kind: "waitLoad", locators: [], meta: {} },
        { kind: "verifyRule", locators: [], binding: { kind: "var", name: "rule_name" }, meta: {} },
      ],
    },
  ];
}
