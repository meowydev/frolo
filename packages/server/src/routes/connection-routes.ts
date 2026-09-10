// Real-mode connection management + runtime-mode routes (req: real connection
// CRUD — add / validate read-only / pin cert / select node — plus explicit
// real-mode enablement).
//
// SAFETY GUARANTEES
// - Adding a connection stores NON-SECRET metadata in SQLite and the API token
//   secret ONLY in the vault (SecretRefs.proxmoxToken). The secret is never
//   logged, echoed back, or written to setup progress.
// - No infrastructure is contacted implicitly. Two endpoints reach the network,
//   and ONLY when the operator explicitly invokes them:
//     * POST /api/connections/fetch-fingerprint  (TLS handshake to read the leaf
//       cert fingerprint for the operator to review + pin — read-only)
//     * POST /api/connections/:id/validate        (read-only Proxmox validate())
//   Neither is called during OOBE automatically.
// - Enabling real mode only records the desired runtime config; providers are
//   rebound on the next controller start, so the response tells the operator a
//   restart is required. This keeps a running mock controller from silently
//   switching to real infrastructure mid-session.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";
import { requireAuth } from "../security.js";
import { SecretRefs } from "@frolo/vault";
import {
  RealProxmoxProvider,
  NodeHttpsTransport,
  fetchCertFingerprint,
} from "@frolo/providers-proxmox";
import { realModeReadiness } from "@frolo/controller";
import type { ProxmoxConnection } from "@frolo/contracts";
import { randomUUID } from "node:crypto";

export function registerConnectionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: requireAuth };

  // Current runtime state: what mode the controller was built in, whether real
  // mode is even permitted (readiness gate), and the persisted desired config.
  app.get("/api/runtime", auth, async () => {
    const readiness = realModeReadiness();
    const cfg = ctx.store.getRuntimeConfig();
    return {
      effectiveMode: ctx.effectiveMode,
      desiredMode: cfg.mode,
      activeConnectionId: cfg.activeConnectionId,
      realModeReady: readiness.available,
      realModeReason: readiness.reason,
    };
  });

  // List configured connections (metadata only — never secrets).
  app.get("/api/connections", auth, async () => ({
    connections: ctx.store.listConnections(),
  }));

  // Add or update a connection. The token secret is stored in the vault only.
  app.post("/api/connections", auth, async (req, reply) => {
    const b = (req.body ?? {}) as {
      id?: unknown;
      name?: unknown;
      host?: unknown;
      node?: unknown;
      tokenId?: unknown;
      tokenSecret?: unknown;
      certFingerprint?: unknown;
      pinned?: unknown;
    };
    const name = str(b.name);
    const host = str(b.host);
    const node = str(b.node);
    const tokenId = str(b.tokenId);
    const tokenSecret = typeof b.tokenSecret === "string" ? b.tokenSecret : "";
    if (!name) return reply.code(400).send({ error: "name is required" });
    if (!/^https:\/\//i.test(host)) return reply.code(400).send({ error: "host must be an https:// URL" });
    if (!node) return reply.code(400).send({ error: "node is required" });
    if (!tokenId) return reply.code(400).send({ error: "tokenId is required (e.g. frolo@pve!deploy)" });

    const id = str(b.id) || randomUUID();
    const conn: ProxmoxConnection = {
      id,
      name,
      host,
      node,
      tokenId,
      certFingerprint: str(b.certFingerprint) || undefined,
      pinned: b.pinned === true,
      createdAt: ctx.store.getConnection(id)?.createdAt ?? new Date().toISOString(),
    };
    ctx.store.saveConnection(conn);

    // Store/replace the token secret only when a non-empty value is supplied so
    // editing metadata doesn't wipe an existing secret.
    if (tokenSecret) {
      ctx.sanitizer.register(tokenSecret);
      await ctx.vault.put(SecretRefs.proxmoxToken(id), tokenSecret);
    }
    return { connection: conn, tokenStored: Boolean(tokenSecret) };
  });

  // Delete a connection (metadata + vault secret). Explicit operator action.
  app.delete("/api/connections/:id", auth, async (req, reply) => {
    const cid = id(req);
    const conn = ctx.store.getConnection(cid);
    if (!conn) return reply.code(404).send({ error: "no such connection" });
    // If this connection is the active real-mode target, refuse to delete until
    // the operator switches back to mock — prevents a dangling real config.
    const cfg = ctx.store.getRuntimeConfig();
    if (cfg.mode === "real" && cfg.activeConnectionId === cid) {
      return reply.code(409).send({ error: "connection is the active real-mode target; disable real mode first" });
    }
    ctx.store.deleteConnection(cid);
    if (await ctx.vault.has(SecretRefs.proxmoxToken(cid))) {
      await ctx.vault.remove(SecretRefs.proxmoxToken(cid));
    }
    return { ok: true };
  });

  // Fetch the server's leaf certificate SHA-256 fingerprint for the operator to
  // review and pin. This performs a TLS handshake (read-only) and is only run on
  // an explicit click. It does NOT authenticate or read any Proxmox data.
  app.post("/api/connections/fetch-fingerprint", auth, async (req, reply) => {
    const b = (req.body ?? {}) as { host?: unknown };
    const host = str(b.host);
    if (!/^https:\/\//i.test(host)) return reply.code(400).send({ error: "host must be an https:// URL" });
    try {
      const fingerprint = await fetchCertFingerprint(host);
      return { fingerprint };
    } catch (err) {
      return reply.code(400).send({ error: ctx.sanitizer.sanitize(err) });
    }
  });

  // Read-only validation of a stored connection against the REAL Proxmox API.
  // Requires the token secret in the vault. Explicit operator action only; runs
  // even while the controller is in mock mode so the operator can verify before
  // switching. It only calls the provider's read-only validate() — no mutations.
  app.post("/api/connections/:id/validate", auth, async (req, reply) => {
    const cid = id(req);
    const conn = ctx.store.getConnection(cid);
    if (!conn) return reply.code(404).send({ error: "no such connection" });
    const tokenRef = SecretRefs.proxmoxToken(cid);
    if (!(await ctx.vault.has(tokenRef))) {
      return reply.code(400).send({ error: "no API token stored for this connection" });
    }
    const tokenSecret = await ctx.vault.get(tokenRef);
    ctx.sanitizer.register(tokenSecret);
    const provider = new RealProxmoxProvider(
      {
        host: conn.host,
        node: conn.node,
        tokenId: conn.tokenId,
        tokenSecret,
        pinnedCertSha256: conn.certFingerprint,
      },
      new NodeHttpsTransport(),
    );
    try {
      const report = await provider.validate();
      return { report };
    } catch (err) {
      return reply.code(400).send({ error: ctx.sanitizer.sanitize(err) });
    }
  });

  // Select the Proxmox node for a stored connection.
  app.post("/api/connections/:id/select-node", auth, async (req, reply) => {
    const cid = id(req);
    const conn = ctx.store.getConnection(cid);
    if (!conn) return reply.code(404).send({ error: "no such connection" });
    const b = (req.body ?? {}) as { node?: unknown };
    const node = str(b.node);
    if (!node) return reply.code(400).send({ error: "node is required" });
    ctx.store.saveConnection({ ...conn, node });
    return { ok: true, node };
  });

  // Enable real mode: record the desired runtime config. Requires the readiness
  // gate to be open, a configured connection, and its token secret in the vault.
  // Providers rebind on restart, so the response asks the operator to restart.
  app.post("/api/runtime/enable-real", auth, async (req, reply) => {
    const readiness = realModeReadiness();
    if (!readiness.available) {
      return reply.code(409).send({ error: `real mode is not available: ${readiness.reason}` });
    }
    const b = (req.body ?? {}) as { connectionId?: unknown };
    const cid = str(b.connectionId);
    const conn = ctx.store.getConnection(cid);
    if (!conn) return reply.code(400).send({ error: "unknown connectionId" });
    if (!(await ctx.vault.has(SecretRefs.proxmoxToken(cid)))) {
      return reply.code(400).send({ error: "connection has no API token stored" });
    }
    ctx.store.setRuntimeConfig({ mode: "real", activeConnectionId: cid });
    return { ok: true, restartRequired: ctx.effectiveMode !== "real" };
  });

  // Return to mock mode. Also rebinds on restart.
  app.post("/api/runtime/disable-real", auth, async () => {
    ctx.store.setRuntimeConfig({ mode: "mock", activeConnectionId: null });
    return { ok: true, restartRequired: ctx.effectiveMode === "real" };
  });
}

function id(req: FastifyRequest): string {
  const p = req.params as { id?: string };
  if (!p.id) throw new Error("missing id");
  return p.id;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export { FastifyReply };
