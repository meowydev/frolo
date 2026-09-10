import React, { useState } from "react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import { api } from "../../api.js";
import { useSnackbar } from "../../ui/Snackbars.js";

export function AdminStep({
  done,
  onCreated,
}: {
  done: boolean;
  onCreated: (recoveryCode: string) => void;
}): JSX.Element {
  const { notify } = useSnackbar();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < 10;

  async function create(): Promise<void> {
    if (busy) return;
    if (password !== confirm) {
      notify("Passwords do not match", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await api.createAdmin(username.trim(), password);
      onCreated(res.recoveryCode);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not create administrator", "error");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Stack spacing={2}>
        <Typography variant="h6">Administrator created</Typography>
        <Alert severity="success">Your administrator account is ready. Continue to your recovery code.</Alert>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h6">Create the first administrator</Typography>
      <Typography variant="body2" color="text.secondary">
        This is your local Frolo account. Your password is hashed with scrypt and never stored in
        plain text.
      </Typography>
      <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
      <TextField
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={tooShort}
        helperText={tooShort ? "At least 10 characters" : "At least 10 characters"}
        autoComplete="new-password"
        required
      />
      <TextField
        label="Confirm password"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={mismatch}
        helperText={mismatch ? "Passwords do not match" : " "}
        autoComplete="new-password"
        required
      />
      <Button
        variant="contained"
        disabled={busy || username.trim().length < 3 || password.length < 10 || password !== confirm}
        onClick={create}
      >
        {busy ? "Creating…" : "Create administrator"}
      </Button>
    </Stack>
  );
}
