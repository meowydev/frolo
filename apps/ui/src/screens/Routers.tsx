import React, { useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import { api } from "../api.js";
import { useSnackbar } from "../ui/Snackbars.js";
import type { RouterProfile } from "@frolo/contracts";

export function Routers(): JSX.Element {
  const { notify } = useSnackbar();
  const [profile, setProfile] = useState<RouterProfile>({
    id: "archer", name: "Archer C6U", baseUrl: "https://192.168.10.1", scheme: "https", kind: "real",
  });
  const [creds, setCreds] = useState({ username: "", password: "" });

  async function saveProfile(): Promise<void> {
    try {
      await api.saveRouter(profile);
      notify(`Saved router "${profile.name}"`, "success");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Save failed", "error");
    }
  }
  async function saveCreds(): Promise<void> {
    try {
      await api.setRouterCredentials(profile.id, creds.username, creds.password);
      setCreds({ username: "", password: "" });
      notify("Credentials stored in the encrypted vault", "success");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Save failed", "error");
    }
  }

  return (
    <Box sx={{ maxWidth: 720 }}>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>Router profiles</Typography>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Profile</Typography>
          <Stack spacing={2}>
            <TextField label="Id" value={profile.id} onChange={(e) => setProfile({ ...profile, id: e.target.value })} />
            <TextField label="Name" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
            <TextField label="Base URL" value={profile.baseUrl} onChange={(e) => setProfile({ ...profile, baseUrl: e.target.value })} />
            <TextField select label="Scheme" value={profile.scheme} onChange={(e) => setProfile({ ...profile, scheme: e.target.value as RouterProfile["scheme"] })}>
              <MenuItem value="https">https</MenuItem>
              <MenuItem value="http">http</MenuItem>
            </TextField>
            <Button variant="outlined" onClick={saveProfile}>Save profile</Button>
          </Stack>
        </CardContent>
      </Card>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Credentials (vault only)</Typography>
          <Stack spacing={2}>
            <TextField label="Router username" value={creds.username} onChange={(e) => setCreds({ ...creds, username: e.target.value })} />
            <TextField label="Router password" type="password" value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })} />
            <Alert severity="info">
              Recorded workflows reference {"{{router_username}}"} and {"{{router_password}}"} — never the values.
            </Alert>
            <Button variant="outlined" onClick={saveCreds} disabled={!creds.username || !creds.password}>Store credentials</Button>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Teach Mode</Typography>
          <Typography variant="body2" color="text.secondary">
            Teach Mode records how you create a port-forward in your router's web UI, then replays it
            with ranked semantic locators. If a target is missing or ambiguous, Frolo stops and asks
            you to repair the step rather than guessing. Password fields are recorded as variable
            references only — the typed value is never captured.
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
}
