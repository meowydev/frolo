import React, { useState } from "react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import MenuItem from "@mui/material/MenuItem";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import { api } from "../../api.js";
import { useSnackbar } from "../../ui/Snackbars.js";

// Default network profile. DHCP or VM-ID-derived addressing. No infra touched —
// this only saves a reusable profile.
export function NetworkStep({ onSaved }: { onSaved: () => void }): JSX.Element {
  const { notify } = useSnackbar();
  const [mode, setMode] = useState<"dhcp" | "manual" | "vmid">("dhcp");
  const [subnet, setSubnet] = useState("192.168.7.0/24");
  const [gateway, setGateway] = useState("192.168.7.1");
  const [address, setAddress] = useState("192.168.7.50");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const profile: Record<string, unknown> = { id: `net-${mode}`, name: mode.toUpperCase(), mode };
      if (mode === "manual") Object.assign(profile, { subnetCidr: subnet, gateway, address });
      if (mode === "vmid") Object.assign(profile, { subnetCidr: subnet, gateway, vmidRule: { offset: 0 } });
      await api.saveSetupNetwork(profile);
      setSaved(true);
      onSaved();
      notify("Default network profile saved", "success");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not save profile", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h6">Default network profile</Typography>
      <Typography variant="body2" color="text.secondary">
        How should new VMs get their address? You can change this per deployment later.
      </Typography>
      <TextField select label="Addressing" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
        <MenuItem value="dhcp">DHCP (guest agent readback)</MenuItem>
        <MenuItem value="manual">Manual IPv4</MenuItem>
        <MenuItem value="vmid">VM-ID-derived IPv4</MenuItem>
      </TextField>
      {mode !== "dhcp" && (
        <>
          <TextField label="Subnet (CIDR)" value={subnet} onChange={(e) => setSubnet(e.target.value)} />
          <TextField label="Gateway" value={gateway} onChange={(e) => setGateway(e.target.value)} />
          {mode === "manual" && <TextField label="Address" value={address} onChange={(e) => setAddress(e.target.value)} />}
        </>
      )}
      <Button variant="outlined" onClick={save} disabled={busy}>
        {busy ? "Saving…" : "Save network profile"}
      </Button>
      {saved && <Alert severity="success">Profile saved. Continue when ready.</Alert>}
    </Stack>
  );
}
