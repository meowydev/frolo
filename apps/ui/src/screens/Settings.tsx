// Settings screen: software updates + real-mode Proxmox connections. Both are
// honest about observed status — no fabricated "connected" states. Real mode is
// only offered when the server reports it is available (env readiness gate), and
// switching modes clearly tells the operator a restart is required.

import React, { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import Divider from "@mui/material/Divider";
import Alert from "@mui/material/Alert";
import FormControlLabel from "@mui/material/FormControlLabel";
import Checkbox from "@mui/material/Checkbox";
import Table from "@mui/material/Table";
import TableHead from "@mui/material/TableHead";
import TableBody from "@mui/material/TableBody";
import TableRow from "@mui/material/TableRow";
import TableCell from "@mui/material/TableCell";
import LinearProgress from "@mui/material/LinearProgress";
import {
  api,
  type RuntimeInfo,
  type ProxmoxConnectionDto,
  type UpdateStatusDto,
  type UpdateProgressDto,
} from "../api.js";
import { useSnackbar } from "../ui/Snackbars.js";

export function Settings(): JSX.Element {
  return (
    <Box>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>
        Settings
      </Typography>
      <UpdatesCard />
      <Box sx={{ height: 16 }} />
      <ConnectionsCard />
    </Box>
  );
}

function UpdatesCard(): JSX.Element {
  const { notify } = useSnackbar();
  const [status, setStatus] = useState<UpdateStatusDto | null>(null);
  const [progress, setProgress] = useState<UpdateProgressDto | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.updateStatus().then(setStatus).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const check = async () => {
    setBusy(true);
    try {
      setStatus(await api.checkForUpdates());
    } catch (e) {
      notify(String((e as Error).message), "error");
    } finally {
      setBusy(false);
    }
  };

  const apply = async (tag: string) => {
    setBusy(true);
    // Poll phase while the install runs.
    const timer = setInterval(() => {
      api.updateProgress().then(setProgress).catch(() => {});
    }, 700);
    try {
      const res = await api.applyUpdate(tag);
      if (res.ok) notify(`Updated to ${res.tag}. The panel will reconnect after restart.`, "success");
      else notify(`Update failed: ${res.error}${res.rolledBack ? " (rolled back)" : ""}`, "error");
    } catch (e) {
      notify(String((e as Error).message), "error");
    } finally {
      clearInterval(timer);
      setBusy(false);
      refresh();
    }
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
          Software updates
        </Typography>
        {!status ? (
          <Typography color="text.secondary">Checking…</Typography>
        ) : status.managedExternally ? (
          <Alert severity="info">
            Updates are managed outside the panel for this deployment. {status.reason} To update a
            Docker install, run <code>install.sh update</code> on the host.
          </Alert>
        ) : (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Chip label={`current ${status.currentVersion}`} size="small" />
              <Chip label={status.channel ?? "stable"} size="small" variant="outlined" />
              {status.updateAvailable ? (
                <Chip label={`update available: ${status.latest?.tag}`} color="secondary" size="small" />
              ) : (
                <Chip label="up to date" color="success" size="small" />
              )}
            </Stack>
            {status.lastError && <Alert severity="warning">Last check: {status.lastError}</Alert>}
            <Typography variant="body2" color="text.secondary">
              Frolo installs a specific signed-off release tag from source, verifies its checksum,
              builds it, then switches over and health-checks. If the new version is unhealthy it
              automatically rolls back. Only tagged releases are installable — never an unpinned branch.
            </Typography>
            {busy && progress && (
              <Box>
                <Typography variant="body2">
                  {progress.phase}: {progress.message}
                </Typography>
                <LinearProgress sx={{ mt: 0.5 }} />
              </Box>
            )}
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" onClick={check} disabled={busy}>
                Check now
              </Button>
              {status.updateAvailable && status.latest && (
                <Button variant="contained" color="secondary" onClick={() => apply(status.latest!.tag)} disabled={busy}>
                  Install {status.latest.tag}
                </Button>
              )}
            </Stack>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

function ConnectionsCard(): JSX.Element {
  const { notify } = useSnackbar();
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [connections, setConnections] = useState<ProxmoxConnectionDto[]>([]);
  const [form, setForm] = useState({ name: "", host: "", node: "", tokenId: "", tokenSecret: "", certFingerprint: "", pinned: false });
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api.runtime().then(setRuntime).catch(() => {});
    api.listConnections().then((r) => setConnections(r.connections)).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const fetchFingerprint = async () => {
    if (!form.host) return;
    setBusy(true);
    try {
      const { fingerprint } = await api.fetchFingerprint(form.host);
      setForm((f) => ({ ...f, certFingerprint: fingerprint.fingerprintSha256, pinned: true }));
      notify(`Fetched certificate fingerprint. Review it before pinning.`, "info");
    } catch (e) {
      notify(String((e as Error).message), "error");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.saveConnection(form);
      notify("Connection saved. The API token is stored encrypted in the vault.", "success");
      setForm({ name: "", host: "", node: "", tokenId: "", tokenSecret: "", certFingerprint: "", pinned: false });
      refresh();
    } catch (e) {
      notify(String((e as Error).message), "error");
    } finally {
      setBusy(false);
    }
  };

  const validate = async (id: string) => {
    setBusy(true);
    try {
      await api.validateConnection(id);
      notify("Connection validated (read-only). No infrastructure was changed.", "success");
    } catch (e) {
      notify(String((e as Error).message), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await api.deleteConnection(id);
      notify("Connection removed.", "info");
      refresh();
    } catch (e) {
      notify(String((e as Error).message), "error");
    } finally {
      setBusy(false);
    }
  };

  const enableReal = async (id: string) => {
    setBusy(true);
    try {
      const r = await api.enableRealMode(id);
      notify(r.restartRequired ? "Real mode will activate after a restart." : "Real mode enabled.", "success");
      refresh();
    } catch (e) {
      notify(String((e as Error).message), "error");
    } finally {
      setBusy(false);
    }
  };

  const disableReal = async () => {
    setBusy(true);
    try {
      const r = await api.disableRealMode();
      notify(r.restartRequired ? "Mock mode will resume after a restart." : "Back in mock mode.", "info");
      refresh();
    } catch (e) {
      notify(String((e as Error).message), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="subtitle1" fontWeight={700}>
            Proxmox connections (real mode)
          </Typography>
          {runtime && (
            <Chip
              label={`running: ${runtime.effectiveMode}`}
              color={runtime.effectiveMode === "real" ? "secondary" : "default"}
              size="small"
            />
          )}
        </Stack>

        {runtime && !runtime.realModeReady && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Real mode is not enabled on this controller. {runtime.realModeReason} You can still add and
            save connections here; they stay inert until real mode is turned on by the operator.
          </Alert>
        )}

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Adding a connection stores only non-secret metadata in the database. The API token is
          encrypted in the vault. Nothing contacts your Proxmox host until you explicitly click
          “Validate” or fetch a certificate fingerprint.
        </Typography>

        <Stack spacing={1.5} sx={{ mb: 2 }}>
          <TextField label="Name" size="small" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <TextField label="Host (https://pve:8006)" size="small" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
          <TextField label="Node" size="small" value={form.node} onChange={(e) => setForm({ ...form, node: e.target.value })} />
          <TextField label="Token ID (e.g. frolo@pve!deploy)" size="small" value={form.tokenId} onChange={(e) => setForm({ ...form, tokenId: e.target.value })} />
          <TextField label="Token secret" type="password" size="small" value={form.tokenSecret} onChange={(e) => setForm({ ...form, tokenSecret: e.target.value })} />
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField label="Pinned cert SHA-256" size="small" fullWidth value={form.certFingerprint} onChange={(e) => setForm({ ...form, certFingerprint: e.target.value })} />
            <Button onClick={fetchFingerprint} disabled={busy || !form.host}>Fetch</Button>
          </Stack>
          <FormControlLabel
            control={<Checkbox checked={form.pinned} onChange={(e) => setForm({ ...form, pinned: e.target.checked })} />}
            label="Pin this certificate"
          />
          <Box>
            <Button variant="contained" onClick={save} disabled={busy || !form.name}>
              Save connection
            </Button>
          </Box>
        </Stack>

        <Divider sx={{ my: 2 }} />

        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Host</TableCell>
              <TableCell>Node</TableCell>
              <TableCell>Pinned</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {connections.map((c) => {
              const active = runtime?.activeConnectionId === c.id && runtime?.desiredMode === "real";
              return (
                <TableRow key={c.id}>
                  <TableCell>
                    {c.name} {active && <Chip label="active" color="secondary" size="small" sx={{ ml: 0.5 }} />}
                  </TableCell>
                  <TableCell sx={{ fontFamily: "monospace" }}>{c.host}</TableCell>
                  <TableCell>{c.node}</TableCell>
                  <TableCell>{c.pinned ? "yes" : "no"}</TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={1} justifyContent="flex-end">
                      <Button size="small" onClick={() => validate(c.id)} disabled={busy}>
                        Validate
                      </Button>
                      {runtime?.realModeReady &&
                        (active ? (
                          <Button size="small" color="warning" onClick={disableReal} disabled={busy}>
                            Disable real
                          </Button>
                        ) : (
                          <Button size="small" color="secondary" onClick={() => enableReal(c.id)} disabled={busy}>
                            Enable real
                          </Button>
                        ))}
                      <Button size="small" color="error" onClick={() => remove(c.id)} disabled={busy || active}>
                        Delete
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              );
            })}
            {connections.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>No connections yet.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
