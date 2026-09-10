import React, { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Stepper from "@mui/material/Stepper";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import { api, subscribeEvents } from "../api.js";
import { useSnackbar } from "../ui/Snackbars.js";
import { StateChip } from "../ui/StateChip.js";
import type { Deployment, DeploymentLogLine, DeploymentState, DeploymentTransition } from "@frolo/contracts";

const STEP_ORDER: DeploymentState[] = ["Queued", "Cloning", "Configuring", "Booting", "Installing", "Checking", "Exposing", "Ready"];

export function DeploymentDetails(): JSX.Element {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { notify } = useSnackbar();
  const [dep, setDep] = useState<Deployment | null>(null);
  const [transitions, setTransitions] = useState<DeploymentTransition[]>([]);
  const [logs, setLogs] = useState<DeploymentLogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    const [d, t, l] = await Promise.all([api.getDeployment(id), api.listTransitions(id), api.listLogs(id)]);
    setDep(d);
    setTransitions(t);
    setLogs(l);
  }, [id]);

  useEffect(() => {
    refresh().catch((e) => notify(e instanceof Error ? e.message : "Load failed", "error"));
    const off = subscribeEvents((e) => {
      if ("deploymentId" in e && e.deploymentId === id) refresh().catch(() => {});
    });
    return off;
  }, [id, refresh, notify]);

  if (!dep) return <LinearProgress />;

  const activeStep = STEP_ORDER.indexOf(dep.state);
  const inProgress = dep.state !== "Ready" && dep.state !== "Failed";
  const reached = new Set(transitions.map((t) => t.to));

  async function retry(): Promise<void> {
    setBusy(true);
    try {
      await api.retryDeployment(id);
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : "Retry failed", "error");
    } finally {
      setBusy(false);
    }
  }
  async function del(): Promise<void> {
    setBusy(true);
    try {
      await api.deleteDeployment(id);
      setConfirmDelete(false);
      notify("Deployment deleted", "success");
      nav("/");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Delete failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ maxWidth: 820 }}>
      <Button onClick={() => nav("/")} sx={{ mb: 1 }}>← Deployments</Button>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h5" fontWeight={700}>{dep.plan.name}</Typography>
        <StateChip state={dep.state} />
      </Stack>

      {inProgress && <LinearProgress sx={{ mb: 2 }} />}

      {(dep.localAddress || dep.publicAddressSim) && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Addresses</Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap">
              {dep.localAddress && <Chip label={`Local: ${dep.localAddress}`} />}
              {dep.publicAddressSim && <Chip color="secondary" label={`Public (sim): ${dep.publicAddressSim}`} />}
            </Stack>
          </CardContent>
        </Card>
      )}

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Timeline</Typography>
          <Stepper activeStep={activeStep} orientation="vertical">
            {STEP_ORDER.map((step) => {
              if (step === "Exposing" && !reached.has("Exposing") && !(dep.plan.chainId && dep.plan.exposure)) return null;
              const t = [...transitions].reverse().find((x) => x.to === step);
              return (
                <Step key={step} completed={reached.has(step) && step !== dep.state}>
                  <StepLabel error={dep.state === "Failed" && step === dep.state} optional={t ? <Typography variant="caption" color="text.secondary">{t.reasonSanitized}</Typography> : undefined}>
                    {step}
                  </StepLabel>
                </Step>
              );
            })}
          </Stepper>
          {dep.state === "Failed" && (
            <Typography variant="body2" color="error" sx={{ mt: 1 }}>
              Failed — Frolo preserved your infrastructure. Nothing was deleted. You can retry safely.
            </Typography>
          )}
        </CardContent>
      </Card>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Observed log</Typography>
          <Box sx={{ fontFamily: "monospace", fontSize: 13, maxHeight: 260, overflow: "auto" }}>
            {logs.map((l) => (
              <div key={l.id} style={{ color: l.level === "error" ? "#e53935" : l.level === "warn" ? "#f9a825" : undefined }}>
                <span style={{ opacity: 0.6 }}>{l.at.slice(11, 19)} </span>
                {l.messageSanitized}
              </div>
            ))}
            {logs.length === 0 && <Typography color="text.secondary" variant="body2">No log lines yet.</Typography>}
          </Box>
        </CardContent>
      </Card>

      <Stack direction="row" spacing={1}>
        {dep.state === "Failed" && <Button variant="contained" onClick={retry} disabled={busy}>Retry</Button>}
        <Button color="error" variant="outlined" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete deployment</Button>
      </Stack>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)}>
        <DialogTitle>Delete {dep.plan.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Frolo will remove any router mappings in reverse order, then delete the VM. This cannot
            be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</Button>
          <Button color="error" variant="contained" onClick={del} disabled={busy}>Confirm delete</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
