import React, { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Chip from "@mui/material/Chip";
import Table from "@mui/material/Table";
import TableHead from "@mui/material/TableHead";
import TableBody from "@mui/material/TableBody";
import TableRow from "@mui/material/TableRow";
import TableCell from "@mui/material/TableCell";
import { api } from "../api.js";
import type { AuditEntry } from "@frolo/contracts";

export function VaultAudit(): JSX.Element {
  const [vault, setVault] = useState<{ unlocked: boolean; recordCount: number; formatVersion: number } | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  useEffect(() => {
    api.vaultStatus().then(setVault).catch(() => {});
    api.listAudit().then(setAudit).catch(() => {});
  }, []);

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>Vault & audit</Typography>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Vault</Typography>
          {vault ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip label={vault.unlocked ? "unlocked" : "locked"} color={vault.unlocked ? "success" : "error"} size="small" />
              <Typography variant="body2" color="text.secondary">{vault.recordCount} encrypted record(s) · format v{vault.formatVersion}</Typography>
            </Stack>
          ) : <Typography color="text.secondary">Checking…</Typography>}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Secrets are encrypted with AES-256-GCM. The master key is stored with 0600 permissions in
            the data volume; SQLite holds no secret values.
          </Typography>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>Audit history</Typography>
          <Table size="small">
            <TableHead>
              <TableRow><TableCell>When</TableCell><TableCell>Actor</TableCell><TableCell>Action</TableCell><TableCell>Subject</TableCell><TableCell>Detail</TableCell></TableRow>
            </TableHead>
            <TableBody>
              {audit.map((a) => (
                <TableRow key={a.id}>
                  <TableCell sx={{ fontFamily: "monospace" }}>{a.at.slice(0, 19).replace("T", " ")}</TableCell>
                  <TableCell>{a.actor}</TableCell>
                  <TableCell><Chip label={a.action} size="small" /></TableCell>
                  <TableCell>{a.subject}</TableCell>
                  <TableCell sx={{ color: "text.secondary" }}>{a.detailSanitized}</TableCell>
                </TableRow>
              ))}
              {audit.length === 0 && <TableRow><TableCell colSpan={5}>No audit entries yet.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </Box>
  );
}
