import { describe, it, expect } from "vitest";
import type { DeploymentState } from "@frolo/contracts";
import {
  canTransition,
  assertTransition,
  nextState,
  computeRetryState,
  isTerminal,
} from "./state-machine.js";

describe("state machine transitions", () => {
  it("allows the happy path forward transitions", () => {
    expect(canTransition("Queued", "Cloning")).toBe(true);
    expect(canTransition("Cloning", "Configuring")).toBe(true);
    expect(canTransition("Configuring", "Booting")).toBe(true);
    expect(canTransition("Booting", "Installing")).toBe(true);
    expect(canTransition("Installing", "Checking")).toBe(true);
    expect(canTransition("Checking", "Exposing")).toBe(true);
    expect(canTransition("Checking", "Ready")).toBe(true);
    expect(canTransition("Exposing", "Ready")).toBe(true);
  });

  it("allows Failed from any active step", () => {
    const active: DeploymentState[] = [
      "Queued",
      "Cloning",
      "Configuring",
      "Booting",
      "Installing",
      "Checking",
      "Exposing",
    ];
    for (const s of active) expect(canTransition(s, "Failed")).toBe(true);
  });

  it("forbids illegal transitions and skipping steps", () => {
    expect(canTransition("Queued", "Booting")).toBe(false);
    expect(canTransition("Cloning", "Ready")).toBe(false);
    expect(canTransition("Ready", "Cloning")).toBe(false);
    expect(() => assertTransition("Queued", "Ready")).toThrow();
  });

  it("has no transition out of Failed (infra preserved)", () => {
    for (const s of [
      "Queued",
      "Cloning",
      "Configuring",
      "Booting",
      "Installing",
      "Checking",
      "Exposing",
      "Ready",
      "Failed",
    ] as DeploymentState[]) {
      expect(canTransition("Failed", s)).toBe(false);
    }
  });

  it("nextState skips Exposing when there is no exposure", () => {
    expect(nextState("Checking", false)).toBe("Ready");
    expect(nextState("Checking", true)).toBe("Exposing");
    expect(nextState(null, false)).toBe("Cloning");
    expect(nextState("Installing", false)).toBe("Checking");
    expect(nextState("Exposing", true)).toBe("Ready");
  });

  it("computeRetryState resumes at earliest unconfirmed step", () => {
    const confirmed = new Set<DeploymentState>(["Cloning"]);
    expect(computeRetryState(confirmed, false)).toBe("Configuring");
    const allButExpose = new Set<DeploymentState>([
      "Cloning",
      "Configuring",
      "Booting",
      "Installing",
      "Checking",
    ]);
    expect(computeRetryState(allButExpose, true)).toBe("Exposing");
    expect(computeRetryState(allButExpose, false)).toBe("Ready");
  });

  it("marks Ready and Failed as terminal", () => {
    expect(isTerminal("Ready")).toBe(true);
    expect(isTerminal("Failed")).toBe(true);
    expect(isTerminal("Cloning")).toBe(false);
  });
});
