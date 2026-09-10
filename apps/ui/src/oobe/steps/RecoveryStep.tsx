import React, { useState } from "react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Alert from "@mui/material/Alert";
import Paper from "@mui/material/Paper";
import Button from "@mui/material/Button";
import FormControlLabel from "@mui/material/FormControlLabel";
import Checkbox from "@mui/material/Checkbox";
import { api } from "../../api.js";
import { useSnackbar } from "../../ui/Snackbars.js";

// Recovery code is shown ONCE (held in memory only). The user must confirm they
// saved it before continuing. It is never logged or persisted in plaintext.
export function RecoveryStep({
  recoveryCode,
  onConfirmed,
}: {
  recoveryCode?: string;
  onConfirmed: () => void;
}): JSX.Element {
  const { notify } = useSnackbar();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm(): Promise<void> {
    if (busy || !saved) return;
    setBusy(true);
    try {
      await api.confirmRecovery();
      onConfirmed();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not confirm", "error");
    } finally {
      setBusy(false);
    }
  }

  if (!recoveryCode) {
    return (
      <Stack spacing={2}>
        <Typography variant="h6">Recovery code</Typography>
        <Alert severity="info">
          Your recovery code was shown right after creating your administrator account. If you have
          already confirmed it, continue. Otherwise, reset setup from the server terminal to see it
          again.
        </Alert>
        <Button variant="contained" onClick={onConfirmed}>Continue</Button>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h6">Save your vault recovery code</Typography>
      <Alert severity="warning">
        This code is shown once and never again. It lets you restore your encrypted vault on a new
        machine. Store it somewhere safe (a password manager). Frolo never logs it.
      </Alert>
      <Paper variant="outlined" sx={{ p: 2, textAlign: "center", fontFamily: "monospace", fontSize: 20, letterSpacing: 1 }}>
        {recoveryCode}
      </Paper>
      <FormControlLabel
        control={<Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} />}
        label="I have saved my recovery code in a safe place"
      />
      <Button variant="contained" disabled={!saved || busy} onClick={confirm}>
        {busy ? "Confirming…" : "I saved it — continue"}
      </Button>
    </Stack>
  );
}
