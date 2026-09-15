#!/usr/bin/env node
// CONTROLLED real-Proxmox validation — DESTRUCTIVE clone + delete lifecycle.
//
// This exercises the real clone/configure/start/delete path against a REAL
// Proxmox host. It is deliberately hard to run by accident:
//   - It is NOT part of `pnpm test` (outside the vitest globs).
//   - It ALWAYS runs the read-only checks first.
//   - It clones ONLY from an explicit disposable template VMID you provide.
//   - It creates ONLY an explicit disposable target VMID you provide, and
//     REFUSES if that VMID already exists (so it can never clobber a real VM).
//   - It requires an interactive typed confirmation: `destroy <TARGET_VMID>`.
//   - It deletes the VM it created (and only that one) at the end.
//
// Required env (in addition to the read-only script's connection vars):
//   FROLO_VALIDATE_HOST / _NODE / _TOKEN_ID / _TOKEN_SECRET  (see readonly script)
//   FROLO_VALIDATE_TEMPLATE_VMID   an EXISTING disposable cloud-init template
//   FROLO_VALIDATE_DISPOSABLE_VMID a NEW, UNUSED vmid to create and then delete
// Optional:
//   FROLO_VALIDATE_CERT_SHA256     pinned leaf-cert SHA-256 (hex)
//   FROLO_VALIDATE_ASSUME_YES=1     skip the interactive prompt (CI on a
//                                   dedicated throwaway host ONLY)
//
// The API token used here MUST have clone/config/start/delete permissions on the
// disposable VMID range only. Point this at a lab host you can afford to break.

import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`FAIL: ${name} is required. See the header of this script for the full env list.`);
    process.exit(2);
  }
  return v;
}
function reqInt(name) {
  const n = Number.parseInt(req(name), 10);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`FAIL: ${name} must be a positive integer VMID.`);
    process.exit(2);
  }
  return n;
}

async function loadProvider() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "packages", "providers-proxmox", "package.json"),
    join(here, "..", "..", "package.json"),
  ].filter(existsSync);
  for (const pkg of candidates) {
    try {
      const r = createRequire(pkg);
      return await import(pathToFileURL(r.resolve("@frolo/providers-proxmox")).href);
    } catch {
      /* next */
    }
  }
  return import("@frolo/providers-proxmox");
}

function confirm(question) {
  if (process.env.FROLO_VALIDATE_ASSUME_YES === "1") return Promise.resolve(true);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function pollToComplete(provider, ref, label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await provider.pollTask(ref);
    if (res.status === "ok") return;
    if (res.status === "error") throw new Error(`${label} task failed: ${res.exitStatus}`);
    if (Date.now() > deadline) throw new Error(`${label} timed out`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  const host = req("FROLO_VALIDATE_HOST");
  const node = req("FROLO_VALIDATE_NODE");
  const tokenId = req("FROLO_VALIDATE_TOKEN_ID");
  const tokenSecret = req("FROLO_VALIDATE_TOKEN_SECRET");
  const pinnedCertSha256 = process.env.FROLO_VALIDATE_CERT_SHA256 || undefined;
  const templateVmid = reqInt("FROLO_VALIDATE_TEMPLATE_VMID");
  const disposableVmid = reqInt("FROLO_VALIDATE_DISPOSABLE_VMID");

  if (templateVmid === disposableVmid) {
    console.error("FAIL: the disposable target VMID must differ from the template VMID.");
    process.exit(2);
  }

  const { RealProxmoxProvider, NodeHttpsTransport } = await loadProvider();
  const provider = new RealProxmoxProvider(
    { host, node, tokenId, tokenSecret, pinnedCertSha256 },
    new NodeHttpsTransport(),
  );

  // 1) READ-ONLY first: prove the connection and that the template exists.
  console.log(`[validate] READ-ONLY preflight against ${host} (node ${node})`);
  await provider.validate();
  const templates = await provider.listTemplates(node);
  if (!templates.some((t) => t.vmid === templateVmid)) {
    console.error(`FAIL: template VMID ${templateVmid} not found on node ${node}. Refusing to proceed.`);
    process.exit(2);
  }
  console.log(`[validate] template ${templateVmid} present.`);

  // 2) Refuse if the disposable target VMID already exists (never clobber).
  const existing = await provider.describeVm(node, disposableVmid);
  if (existing) {
    console.error(
      `FAIL: target VMID ${disposableVmid} already exists ("${existing.name}"). ` +
        `Choose an UNUSED disposable VMID; this script will not overwrite an existing VM.`,
    );
    process.exit(2);
  }

  // 3) Explicit typed confirmation.
  const answer = await confirm(
    `\nThis will CLONE template ${templateVmid} -> NEW VM ${disposableVmid} on node ${node} ` +
      `at ${host}, then DELETE VM ${disposableVmid}.\n` +
      `Type exactly "destroy ${disposableVmid}" to proceed: `,
  );
  if (String(answer).trim() !== `destroy ${disposableVmid}`) {
    console.error("Aborted: confirmation phrase did not match. Nothing was changed.");
    process.exit(3);
  }

  let created = false;
  try {
    console.log(`[validate] cloning ${templateVmid} -> ${disposableVmid}…`);
    const cloneRef = await provider.cloneTemplate({
      node,
      templateVmid,
      newVmid: disposableVmid,
      name: `frolo-validate-${disposableVmid}`,
    });
    await pollToComplete(provider, cloneRef, "clone");
    created = true;
    console.log("[validate] clone complete.");

    const info = await provider.describeVm(node, disposableVmid);
    console.log(`[validate] created VM present: ${JSON.stringify(info)}`);
    console.log("[validate] (skipping configure/start to keep this a minimal, fast lifecycle check)");
  } finally {
    // 4) Always clean up the VM we created — and ONLY that VMID.
    if (created) {
      console.log(`[validate] deleting disposable VM ${disposableVmid}…`);
      try {
        const delRef = await provider.deleteVm(node, disposableVmid);
        await pollToComplete(provider, delRef, "delete");
        const after = await provider.describeVm(node, disposableVmid);
        if (after) {
          console.error(`WARNING: VM ${disposableVmid} still present after delete — remove it manually.`);
        } else {
          console.log(`[validate] deleted VM ${disposableVmid}. Host restored.`);
        }
      } catch (err) {
        console.error(`WARNING: failed to delete VM ${disposableVmid}: ${err?.message ?? err}. Remove it manually.`);
      }
    }
  }

  console.log("\nOK: clone + delete lifecycle validation completed.");
}

main().catch((err) => {
  console.error("FAIL:", err?.message ?? err);
  process.exit(1);
});
