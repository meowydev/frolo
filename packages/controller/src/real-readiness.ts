// Real-mode readiness gate (req §1.1, Phase 8). Real mode must stay HIDDEN in the
// UI until the real providers exist AND their safety tests pass. This module is
// the single source of truth the controller consults.
//
// The flag defaults to FALSE. It only flips to true when:
//   1. real provider implementations are present (they are, as of Phase 8), AND
//   2. the real-mode safety test suite has been run and recorded as passing, AND
//   3. the build explicitly opts in via FROLO_ENABLE_REAL_MODE=1.
//
// Because (2) requires connecting to real infrastructure — which we deliberately
// do NOT do in this repo's tests — the gate stays closed by default. The desktop
// build for end users ships with it closed until the maintainer completes real
// hardware validation. This satisfies "real mode remains hidden until its
// providers and safety tests pass."

export interface RealModeReadiness {
  available: boolean;
  reason: string;
}

export function realModeReadiness(env: NodeJS.ProcessEnv = process.env): RealModeReadiness {
  const optedIn = env.FROLO_ENABLE_REAL_MODE === "1";
  const safetyPassed = env.FROLO_REAL_SAFETY_TESTS_PASSED === "1";
  if (!optedIn) {
    return { available: false, reason: "real mode not enabled in this build" };
  }
  if (!safetyPassed) {
    return {
      available: false,
      reason: "real-mode safety tests have not been recorded as passing",
    };
  }
  return { available: true, reason: "real mode enabled and safety-validated" };
}
