import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Grid from "@mui/material/Grid2";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import Fab from "@mui/material/Fab";
import AddIcon from "@mui/icons-material/Add";
import Alert from "@mui/material/Alert";
import { api, subscribeEvents } from "../api.js";
import { StateChip } from "../ui/StateChip.js";
import type { Deployment, Entitlements } from "@frolo/contracts";
import { TIER_DISPLAY } from "../tier.js";

export function Dashboard(): JSX.Element {
  const nav = useNavigate();
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [mode, setMode] = useState<"mock" | "real">("mock");
  const [ent, setEnt] = useState<Entitlements | null>(null);

  const refresh = () => api.listDeployments().then(setDeployments).catch(() => {});

  useEffect(() => {
    refresh();
    api.getMode().then((m) => setMode(m.mode)).catch(() => {});
    api.entitlements().then(setEnt).catch(() => {});
    const off = subscribeEvents(() => refresh());
    return off;
  }, []);

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap">
        <Typography variant="h5" fontWeight={700}>Deployments</Typography>
        <Chip
          label={mode === "mock" ? "Simulated infrastructure (mock)" : "Real Proxmox"}
          color={mode === "mock" ? "secondary" : "primary"}
          size="small"
        />
        {ent && <Chip label={TIER_DISPLAY[ent.effectiveTier]} variant="outlined" size="small" />}
      </Stack>

      {mode === "mock" && (
        <Alert severity="info" sx={{ mb: 2 }}>
          You're exploring Frolo in mock mode. Deployments run against a safe simulation — nothing
          touches real infrastructure.
        </Alert>
      )}

      <Grid container spacing={2}>
        {deployments.map((d) => (
          <Grid key={d.id} size={{ xs: 12, sm: 6, md: 4 }}>
            <Card>
              <CardActionArea onClick={() => nav(`/deployments/${d.id}`)}>
                <CardContent>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
                    <Typography variant="subtitle1" fontWeight={700}>{d.plan.name}</Typography>
                    <StateChip state={d.state} />
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {d.localAddress ? `Local: ${d.localAddress}` : "No address yet"}
                  </Typography>
                  {d.publicAddressSim && (
                    <Typography variant="body2" color="text.secondary">Public (sim): {d.publicAddressSim}</Typography>
                  )}
                </CardContent>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
        {deployments.length === 0 && (
          <Grid size={12}>
            <Card><CardContent><Typography color="text.secondary">No deployments yet. Tap + to create one.</Typography></CardContent></Card>
          </Grid>
        )}
      </Grid>

      <Fab color="primary" aria-label="New deployment" onClick={() => nav("/new")} sx={{ position: "fixed", bottom: 28, right: 28 }}>
        <AddIcon />
      </Fab>
    </Box>
  );
}
