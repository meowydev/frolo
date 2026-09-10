import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import { api } from "../api.js";
import { useSnackbar } from "../ui/Snackbars.js";
import type { PreviewPlanResult } from "@frolo/contracts";
import type { TemplateInfo, Recipe } from "@frolo/contracts";

export function NewDeployment(): JSX.Element {
  const nav = useNavigate();
  const { notify } = useSnackbar();
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [preview, setPreview] = useState<PreviewPlanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: "web-01",
    templateVmid: 9000,
    cores: 2,
    ramMb: 2048,
    diskGb: 10,
    hostname: "web-01",
    sshUser: "ubuntu",
    netMode: "dhcp" as "dhcp" | "manual" | "vmid",
    recipeId: "builtin.nginx",
  });

  useEffect(() => {
    api.listTemplates().then(setTemplates).catch(() => {});
    api.listRecipes().then((r) => setRecipes(r.map((x) => x.recipe))).catch(() => {});
  }, []);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function review(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const dep = await api.createDeployment({
        name: form.name,
        connectionId: "local",
        templateVmid: Number(form.templateVmid),
        cores: Number(form.cores),
        ramMb: Number(form.ramMb),
        diskGb: Number(form.diskGb),
        hostname: form.hostname,
        sshUser: form.sshUser,
        networkProfileId: `net-${form.netMode}`,
        recipeId: form.recipeId,
      });
      setPreview(await api.previewPlan(dep.id));
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not build plan", "error");
    } finally {
      setBusy(false);
    }
  }

  async function confirmRun(): Promise<void> {
    if (!preview || busy) return;
    setBusy(true);
    try {
      await api.runDeployment(preview.deployment.id);
      nav(`/deployments/${preview.deployment.id}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Deployment failed to start", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ maxWidth: 720 }}>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>New deployment</Typography>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Basics</Typography>
          <Stack spacing={2}>
            <TextField label="Name" value={form.name} onChange={(e) => set("name", e.target.value)} fullWidth />
            <TextField label="Hostname" value={form.hostname} onChange={(e) => set("hostname", e.target.value)} fullWidth />
            <TextField select label="Template" value={form.templateVmid} onChange={(e) => set("templateVmid", Number(e.target.value))} fullWidth>
              {templates.map((t) => <MenuItem key={t.vmid} value={t.vmid}>{t.name} ({t.vmid})</MenuItem>)}
            </TextField>
            <TextField label="Cloud-init user" value={form.sshUser} onChange={(e) => set("sshUser", e.target.value)} fullWidth />
          </Stack>
        </CardContent>
      </Card>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Resources & network</Typography>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField label="vCPU" type="number" value={form.cores} onChange={(e) => set("cores", Number(e.target.value))} />
            <TextField label="RAM (MB)" type="number" value={form.ramMb} onChange={(e) => set("ramMb", Number(e.target.value))} />
            <TextField label="Disk (GB)" type="number" value={form.diskGb} onChange={(e) => set("diskGb", Number(e.target.value))} />
          </Stack>
          <TextField select label="Addressing" value={form.netMode} onChange={(e) => set("netMode", e.target.value as typeof form.netMode)} sx={{ mt: 2 }} fullWidth>
            <MenuItem value="dhcp">DHCP</MenuItem>
            <MenuItem value="vmid">VM-ID-derived</MenuItem>
          </TextField>
        </CardContent>
      </Card>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Recipe</Typography>
          <TextField select value={form.recipeId} onChange={(e) => set("recipeId", e.target.value)} fullWidth>
            {recipes.map((r) => <MenuItem key={r.id} value={r.id}>{r.name} v{r.version}</MenuItem>)}
          </TextField>
        </CardContent>
      </Card>

      <Button variant="contained" onClick={review} disabled={busy}>Review plan</Button>

      <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Review plan — {preview?.deployment.plan.name}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Nothing has changed yet. Frolo will perform exactly these steps.
          </Typography>
          <List dense>
            {preview?.steps.map((s, i) => (
              <ListItem key={i} divider><ListItemText primary={s} /></ListItem>
            ))}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPreview(null)} disabled={busy}>Cancel</Button>
          <Button variant="contained" onClick={confirmRun} disabled={busy}>Confirm & deploy</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
