import React from "react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Chip from "@mui/material/Chip";
import Alert from "@mui/material/Alert";
import type { OobeState } from "../Oobe.js";

export function ReviewStep({ state }: { state: OobeState }): JSX.Element {
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Mode", value: <Chip size="small" label={state.mode === "mock" ? "Try Frolo safely (mock)" : "Real Proxmox"} color={state.mode === "mock" ? "secondary" : "primary"} /> },
    { label: "Administrator", value: state.adminCreated ? "Created" : "Not created" },
    { label: "Recovery code", value: state.recoveryConfirmed ? "Saved & confirmed" : "Pending" },
    { label: "Proxmox connection", value: state.proxmoxValidated ? `Validated (node ${state.node})` : "Not validated" },
    { label: "Network profile", value: state.networkConfigured ? "Configured" : "Default" },
    { label: "Router chain", value: state.skippedRouter ? "Skipped (configure later)" : "Configured" },
    { label: "Nginx gateway", value: state.skippedGateway ? "Skipped (configure later)" : "Configured" },
  ];
  return (
    <Stack spacing={2}>
      <Typography variant="h6">Review your setup</Typography>
      <Alert severity="info">Nothing has been created on your infrastructure. Finishing saves these settings and opens your dashboard.</Alert>
      <List dense>
        {rows.map((r) => (
          <ListItem key={r.label} divider>
            <ListItemText primary={r.label} />
            {typeof r.value === "string" ? <Typography variant="body2" color="text.secondary">{r.value}</Typography> : r.value}
          </ListItem>
        ))}
      </List>
    </Stack>
  );
}
