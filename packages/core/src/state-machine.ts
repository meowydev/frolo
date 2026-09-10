// Deployment state machine (req §6). Pure logic: given a current state and an
// event, compute the next state. Enforces allowed transitions, task-result
// gating semantics, Failed-preserves-infra, and the retry entry point.

import type { DeploymentState } from "@frolo/contracts";

// Allowed forward transitions. Failed is reachable from any active step.
const FORWARD: Record<DeploymentState, DeploymentState[]> = {
  Queued: ["Cloning", "Failed"],
  Cloning: ["Configuring", "Failed"],
  Configuring: ["Booting", "Failed"],
  Booting: ["Installing", "Failed"],
  Installing: ["Checking", "Failed"],
  // Checking -> Exposing (if chain) or Ready (no exposure)
  Checking: ["Exposing", "Ready", "Failed"],
  Exposing: ["Ready", "Failed"],
  Ready: [],
  Failed: [], // retry re-enters via computeRetryState, not a direct transition
};

export function canTransition(
  from: DeploymentState,
  to: DeploymentState,
): boolean {
  return FORWARD[from]?.includes(to) ?? false;
}

export function assertTransition(
  from: DeploymentState,
  to: DeploymentState,
): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal deployment transition: ${from} -> ${to}`);
  }
}

// The ordered "steps" of a deployment and the state each enters.
export const STEP_ORDER: DeploymentState[] = [
  "Cloning",
  "Configuring",
  "Booting",
  "Installing",
  "Checking",
  "Exposing",
];

// Given the last confirmed-successful step (by journal), and whether the plan
// has exposure, compute the next state to run. Used both for normal advance and
// retry (req §6.7). Returns "Ready" when all needed steps are confirmed.
export function nextState(
  lastConfirmed: DeploymentState | null,
  hasExposure: boolean,
): DeploymentState {
  const steps = hasExposure
    ? STEP_ORDER
    : STEP_ORDER.filter((s) => s !== "Exposing");
  if (lastConfirmed === null) return steps[0]!;
  const idx = steps.indexOf(lastConfirmed);
  if (idx === -1) {
    // lastConfirmed was Ready/Failed/Queued; treat as start.
    return steps[0]!;
  }
  const next = steps[idx + 1];
  return next ?? "Ready";
}

// Retry (req §6.7, §19.6): re-enter at the earliest step whose journal entry is
// not 'succeeded'. `confirmedSteps` is the set of steps confirmed successful.
export function computeRetryState(
  confirmedSteps: Set<DeploymentState>,
  hasExposure: boolean,
): DeploymentState {
  const steps = hasExposure
    ? STEP_ORDER
    : STEP_ORDER.filter((s) => s !== "Exposing");
  for (const step of steps) {
    if (!confirmedSteps.has(step)) return step;
  }
  return "Ready";
}

// Failed always preserves infrastructure — there is intentionally no transition
// from Failed to any destructive action here. Deletion is a separate,
// explicitly-confirmed flow handled by the orchestrator.
export function isTerminal(state: DeploymentState): boolean {
  return state === "Ready" || state === "Failed";
}
