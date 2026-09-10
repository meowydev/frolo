// OOBE — first-run setup with a Material stepper (req §OOBE). Steps: Welcome →
// Mode → Create admin → Recovery code → Proxmox (skippable in mock) → Network →
// Router (skippable) → Gateway (skippable) → Review → Finish. Non-secret progress
// is saved so a reload resumes. No infrastructure is created during OOBE.

import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Stepper from "@mui/material/Stepper";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import { api } from "../api.js";
import { useSnackbar } from "../ui/Snackbars.js";
import { WelcomeStep } from "./steps/WelcomeStep.js";
import { ModeStep } from "./steps/ModeStep.js";
import { AdminStep } from "./steps/AdminStep.js";
import { RecoveryStep } from "./steps/RecoveryStep.js";
import { ProxmoxStep } from "./steps/ProxmoxStep.js";
import { NetworkStep } from "./steps/NetworkStep.js";
import { OptionalStep } from "./steps/OptionalStep.js";
import { ReviewStep } from "./steps/ReviewStep.js";

export interface OobeState {
  mode: "mock" | "real";
  adminCreated: boolean;
  recoveryConfirmed: boolean;
  proxmoxValidated: boolean;
  networkConfigured: boolean;
  skippedRouter: boolean;
  skippedGateway: boolean;
  recoveryCode?: string; // held in memory only, shown once
  node: string;
}

const STEP_KEYS = ["welcome", "mode", "admin", "recovery", "proxmox", "network", "router", "gateway", "review"] as const;
type StepKey = (typeof STEP_KEYS)[number];

const STEP_LABELS: Record<StepKey, string> = {
  welcome: "Welcome",
  mode: "Mode",
  admin: "Administrator",
  recovery: "Recovery code",
  proxmox: "Proxmox",
  network: "Network",
  router: "Router",
  gateway: "Gateway",
  review: "Review",
};

export function Oobe({ onDone }: { onDone: () => void }): JSX.Element {
  const nav = useNavigate();
  const { notify } = useSnackbar();
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<OobeState>({
    mode: "mock",
    adminCreated: false,
    recoveryConfirmed: false,
    proxmoxValidated: false,
    networkConfigured: false,
    skippedRouter: false,
    skippedGateway: false,
    node: "pve",
  });

  // Resume non-secret progress on load.
  useEffect(() => {
    api.setupState().then((s) => {
      if (s.completed) {
        onDone();
        nav("/", { replace: true });
        return;
      }
      const p = s.progress as Partial<OobeState> & { step?: number };
      setState((prev) => ({
        ...prev,
        mode: (p.mode as "mock" | "real") ?? prev.mode,
        node: (p.node as string) ?? prev.node,
        recoveryConfirmed: Boolean(p.recoveryConfirmed),
        networkConfigured: Boolean(p.networkConfigured),
        skippedRouter: Boolean(p.skippedRouter),
        skippedGateway: Boolean(p.skippedGateway),
        adminCreated: Boolean(s.hasAccount),
      }));
      if (typeof p.step === "number") setActive(Math.min(p.step, STEP_KEYS.length - 1));
    });
  }, [nav, onDone]);

  const persist = useCallback(
    (patch: Record<string, unknown>) => {
      // Never send secret fields to the server.
      const { recoveryCode: _omit, ...safe } = { ...patch } as Record<string, unknown>;
      void _omit;
      api.saveProgress({ ...safe }).catch(() => {});
    },
    [],
  );

  const key = STEP_KEYS[active]!;
  const isMock = state.mode === "mock";

  const goNext = (patch?: Partial<OobeState>) => {
    const next = Math.min(active + 1, STEP_KEYS.length - 1);
    setState((s) => ({ ...s, ...patch }));
    setActive(next);
    persist({ step: next, mode: patch?.mode ?? state.mode, node: patch?.node ?? state.node });
  };
  const goBack = () => setActive((a) => Math.max(a - 1, 0));

  async function finish(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await api.completeSetup();
      notify("Setup complete. Welcome to Frolo!", "success");
      onDone();
      nav("/", { replace: true });
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not finish setup", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ display: "grid", placeItems: "center", minHeight: "100vh", p: 2 }}>
      <Paper sx={{ width: 760, maxWidth: "100%", p: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h5" fontWeight={700}>Frolo setup</Typography>
          <Chip label="beta" size="small" color="secondary" />
        </Stack>

        <Stepper activeStep={active} alternativeLabel sx={{ mb: 3, display: { xs: "none", sm: "flex" } }}>
          {STEP_KEYS.map((k) => (
            <Step key={k}>
              <StepLabel>{STEP_LABELS[k]}</StepLabel>
            </Step>
          ))}
        </Stepper>

        <Box sx={{ minHeight: 260 }}>
          {key === "welcome" && <WelcomeStep />}
          {key === "mode" && <ModeStep value={state.mode} onChange={(mode) => setState((s) => ({ ...s, mode }))} />}
          {key === "admin" && (
            <AdminStep
              done={state.adminCreated}
              onCreated={(recoveryCode) => goNext({ adminCreated: true, recoveryCode })}
            />
          )}
          {key === "recovery" && (
            <RecoveryStep
              recoveryCode={state.recoveryCode}
              onConfirmed={() => goNext({ recoveryConfirmed: true })}
            />
          )}
          {key === "proxmox" && (
            <ProxmoxStep
              isMock={isMock}
              onValidated={(node) => setState((s) => ({ ...s, proxmoxValidated: true, node }))}
            />
          )}
          {key === "network" && (
            <NetworkStep onSaved={() => setState((s) => ({ ...s, networkConfigured: true }))} />
          )}
          {key === "router" && (
            <OptionalStep
              title="Router chain (optional)"
              description="Frolo can open ports through your routers using Teach Mode. You can set this up later — skip for now if you're just getting started."
            />
          )}
          {key === "gateway" && (
            <OptionalStep
              title="Nginx gateway (optional)"
              description="Frolo can manage an Nginx reverse-proxy gateway. This is optional and can be configured later."
            />
          )}
          {key === "review" && <ReviewStep state={state} />}
        </Box>

        <Stack direction="row" spacing={1} justifyContent="space-between" sx={{ mt: 3 }}>
          <Button onClick={goBack} disabled={active === 0 || busy}>Back</Button>
          <Stack direction="row" spacing={1}>
            {(key === "router" || key === "gateway") && (
              <Button
                variant="outlined"
                disabled={busy}
                onClick={() =>
                  goNext(key === "router" ? { skippedRouter: true } : { skippedGateway: true })
                }
              >
                Skip
              </Button>
            )}
            {key !== "review" && key !== "admin" && key !== "recovery" && (
              <Button variant="contained" disabled={busy} onClick={() => goNext()}>
                Continue
              </Button>
            )}
            {key === "review" && (
              <Button variant="contained" color="success" disabled={busy} onClick={finish}>
                {busy ? "Finishing…" : "Finish"}
              </Button>
            )}
          </Stack>
        </Stack>
      </Paper>
    </Box>
  );
}
