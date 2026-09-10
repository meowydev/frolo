import React, { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import { api } from "../api.js";
import { useSnackbar } from "../ui/Snackbars.js";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }): JSX.Element {
  const { notify } = useSnackbar();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [insecure, setInsecure] = useState(false);

  useEffect(() => {
    setInsecure(window.location.protocol === "http:");
    api.info().then((i) => setInsecure(window.location.protocol === "http:" && !i.behindTls)).catch(() => {});
  }, []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return; // prevent double submit
    setBusy(true);
    try {
      await api.login(username, password);
      onLoggedIn();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Login failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ display: "grid", placeItems: "center", minHeight: "100vh", p: 2 }}>
      <Card sx={{ width: 420, maxWidth: "100%" }}>
        <CardContent>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="h5" fontWeight={700}>Frolo</Typography>
            <Chip label="beta" size="small" color="secondary" />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Sign in to your Frolo panel.
          </Typography>

          {insecure && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              You are on plain HTTP. Frolo is intended for a trusted LAN. For remote access, put
              Frolo behind an HTTPS reverse proxy (see the docs). You can still sign in now.
            </Alert>
          )}

          <form onSubmit={submit}>
            <Stack spacing={2}>
              <TextField
                label="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                fullWidth
                required
              />
              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                fullWidth
                required
              />
              <Button type="submit" variant="contained" disabled={busy || !username || !password}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </Stack>
          </form>
        </CardContent>
      </Card>
    </Box>
  );
}
