import React, { useState } from "react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Chip from "@mui/material/Chip";
import { api } from "../../api.js";
import { useSnackbar } from "../../ui/Snackbars.js";
import type { TemplateInfo } from "@frolo/contracts";

// Connect + validate a Proxmox server (read-only, no mutation). In mock mode the
// fields are prefilled and validation exercises the simulation.
export function ProxmoxStep({
  isMock,
  onValidated,
}: {
  isMock: boolean;
  onValidated: (node: string) => void;
}): JSX.Element {
  const { notify } = useSnackbar();
  const [host, setHost] = useState(isMock ? "https://mock-proxmox.local:8006" : "");
  const [node, setNode] = useState("pve");
  const [tokenId, setTokenId] = useState(isMock ? "frolo@pve!mock" : "");
  const [tokenSecret, setTokenSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [seededMock, setSeededMock] = useState(false);

  async function test(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (isMock && !seededMock) {
        await api.tryMock();
        setSeededMock(true);
      }
      const res = await api.validateProxmox({ host, node, tokenId, tokenSecret });
      setTemplates(res.templates);
      notify(`Connection OK — detected ${res.templatesDetected} cloud-init template(s)`, "success");
      onValidated(node);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Validation failed", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h6">Connect your Proxmox server</Typography>
      {isMock ? (
        <Alert severity="info">
          Mock mode: these fields are prefilled and validation uses a built-in simulation. No real
          Proxmox server is contacted.
        </Alert>
      ) : (
        <Alert severity="info">
          Use a dedicated, restricted Proxmox API token. Frolo validates the connection read-only —
          it does not create, change, or delete anything during setup. If the server uses a
          self-signed certificate you'll be able to review and pin its fingerprint.
        </Alert>
      )}
      <TextField label="Proxmox host URL" value={host} onChange={(e) => setHost(e.target.value)} placeholder="https://pve.example:8006" />
      <TextField label="Node" value={node} onChange={(e) => setNode(e.target.value)} />
      <TextField label="API token id" value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="frolo@pve!deploy" />
      <TextField
        label="API token secret"
        type="password"
        value={tokenSecret}
        onChange={(e) => setTokenSecret(e.target.value)}
        helperText="Stored only in the encrypted vault — never in logs or setup progress."
      />
      <Button variant="outlined" onClick={test} disabled={busy}>
        {busy ? "Testing…" : "Test connection"}
      </Button>
      {templates && (
        <Alert severity="success">
          Detected templates:{" "}
          {templates.length === 0 ? "none" : templates.map((t) => <Chip key={t.vmid} label={`${t.name} (${t.vmid})`} size="small" sx={{ mr: 0.5 }} />)}
        </Alert>
      )}
    </Stack>
  );
}
