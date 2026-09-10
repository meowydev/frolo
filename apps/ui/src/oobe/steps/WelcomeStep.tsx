import React from "react";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";

export function WelcomeStep(): JSX.Element {
  return (
    <Stack spacing={2}>
      <Typography variant="h6">Welcome to Frolo</Typography>
      <Typography variant="body1" color="text.secondary">
        Frolo is a friendly panel that deploys applications onto your Proxmox server. It clones a
        template, configures the VM, installs a recipe, checks it works, and can open ports through
        your routers.
      </Typography>
      <Alert severity="info">
        Frolo controls real local infrastructure on your network. This short setup creates your
        administrator account and connects Frolo to your Proxmox server. Nothing is created, changed,
        or deleted during setup — Frolo only reads and validates.
      </Alert>
    </Stack>
  );
}
