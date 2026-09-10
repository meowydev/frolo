import React from "react";
import Chip from "@mui/material/Chip";
import type { DeploymentState } from "@frolo/contracts";

export function StateChip({ state }: { state: DeploymentState }): JSX.Element {
  const color: "success" | "error" | "warning" | "default" =
    state === "Ready" ? "success" : state === "Failed" ? "error" : state === "Queued" ? "default" : "warning";
  return <Chip label={state} color={color} size="small" />;
}
