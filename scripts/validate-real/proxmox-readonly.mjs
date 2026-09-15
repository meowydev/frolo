#!/usr/bin/env node
// CONTROLLED real-Proxmox validation — READ-ONLY.
//
// This connects to a REAL Proxmox host and performs ONLY read operations:
//   1) validate() the connection (GET node status)
//   2) list templates
//   3) list VMs
// It never clones, configures, starts, or deletes anything. It is NOT part of
// `pnpm test` — it lives outside the vitest globs and only runs when you invoke
// it explicitly with the connection env vars set.
//
// Required env:
//   FROLO_VALIDATE_HOST         https URL, e.g. https://pve.example:8006
//   FROLO_VALIDATE_NODE         node name, e.g. pve
//   FROLO_VALIDATE_TOKEN_ID     restricted API token id, e.g. frolo@pve!validate
//   FROLO_VALIDATE_TOKEN_SECRET the token secret
// Optional:
//   FROLO_VALIDATE_CERT_SHA256  pinned leaf-cert SHA-256 (hex) for self-signed
//
// Usage:
//   pnpm --filter @frolo/providers-proxmox exec node ../../scripts/validate-real/proxmox-readonly.mjs
// or from the repo root after `pnpm run build:packages`:
//   node scripts/validate-real/proxmox-readonly.mjs
//
// SAFETY: use a RESTRICTED API token (PVEAuditor or a custom read role is enough
// for the read-only checks). Nothing here mutates your infrastructure.

import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FAIL: ${name} is required. See the header of this script for the full env list.`);
    process.exit(2);
  }
  return v;
}

// Resolve the built @frolo/providers-proxmox from the workspace.
async function loadProvider() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "packages", "providers-proxmox", "package.json"),
    join(here, "..", "..", "package.json"),
  ].filter(existsSync);
  for (const pkg of candidates) {
    try {
      const r = createRequire(pkg);
      const entry = r.resolve("@frolo/providers-proxmox");
      return await import(pathToFileURL(entry).href);
    } catch {
      /* try next */
    }
  }
  return import("@frolo/providers-proxmox");
}

async function main() {
  const host = req("FROLO_VALIDATE_HOST");
  const node = req("FROLO_VALIDATE_NODE");
  const tokenId = req("FROLO_VALIDATE_TOKEN_ID");
  const tokenSecret = req("FROLO_VALIDATE_TOKEN_SECRET");
  const pinnedCertSha256 = process.env.FROLO_VALIDATE_CERT_SHA256 || undefined;

  if (!/^https:\/\//.test(host)) {
    console.error("FAIL: FROLO_VALIDATE_HOST must be an https:// URL.");
    process.exit(2);
  }

  let mod;
  try {
    mod = await loadProvider();
  } catch (err) {
    console.error("FAIL: could not load @frolo/providers-proxmox (run `pnpm run build:packages` first):", err?.message ?? err);
    process.exit(2);
  }
  const { RealProxmoxProvider, NodeHttpsTransport } = mod;

  const provider = new RealProxmoxProvider(
    { host, node, tokenId, tokenSecret, pinnedCertSha256 },
    new NodeHttpsTransport(),
  );

  console.log(`[validate] READ-ONLY checks against ${host} (node ${node})`);
  if (pinnedCertSha256) console.log(`[validate] pinning cert SHA-256 ${pinnedCertSha256.slice(0, 16)}…`);

  // 1) validate (GET node status) — the first and cheapest read.
  const report = await provider.validate();
  console.log(`[validate] node status OK: ${JSON.stringify(report)}`);

  // 2) templates
  const templates = await provider.listTemplates(node);
  console.log(`[validate] templates (${templates.length}):`);
  for (const t of templates) console.log(`  - vmid ${t.vmid} "${t.name}" cloudInit=${t.cloudInit}`);

  // 3) VMs
  const vms = await provider.listVms(node);
  console.log(`[validate] VMs (${vms.length}):`);
  for (const v of vms) console.log(`  - vmid ${v.vmid} "${v.name}" status=${v.status}`);

  console.log("\nOK: read-only Proxmox validation succeeded. No infrastructure was modified.");
}

main().catch((err) => {
  console.error("FAIL:", err?.message ?? err);
  process.exit(1);
});
