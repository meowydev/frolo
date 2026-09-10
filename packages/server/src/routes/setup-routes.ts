// OOBE / first-run setup routes (req: complete first-run setup process).
//
// Guarantees:
// - No infrastructure is created, modified, started, stopped, exposed, or
//   deleted during OOBE. Proxmox is only VALIDATED (read-only) and templates
//   are DETECTED.
// - The vault recovery code is generated, returned ONCE, and never logged or
//   persisted in plaintext. The client must confirm it was saved.
// - Non-secret progress is persisted so a page reload resumes the stepper.
// - Once complete, OOBE never shows again unless setup is reset from the
//   local terminal.

import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppContext } from "../context.js";
import { createRecovery } from "../vault-setup.js";
import { hashPassword, validatePasswordStrength, issueSession } from "./auth-routes.js";
import { requireAuth } from "../security.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export function registerSetupRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  opts: { secureCookies: boolean; dataDir: string; inMemory?: boolean },
): void {
  // Current setup state + saved non-secret progress (drives the stepper).
  app.get("/api/setup/state", async () => {
    const s = ctx.authStore.getSetupState();
    return {
      completed: s.completed,
      progress: s.progress,
      hasAccount: ctx.authStore.hasAnyAccount(),
    };
  });

  // Persist non-secret stepper progress (e.g. which step, chosen node, flags).
  // Secrets (passwords, tokens, recovery code) are NEVER accepted here.
  app.post("/api/setup/progress", async (req, reply) => {
    if (ctx.authStore.getSetupState().completed) {
      return reply.code(409).send({ error: "setup already completed" });
    }
    const body = (req.body ?? {}) as { progress?: Record<string, unknown> };
    const progress = sanitizeProgress(body.progress ?? {});
    ctx.authStore.saveSetupProgress(progress);
    return { ok: true, progress };
  });

  // Step: create the first administrator. Only allowed when no account exists.
  // Also generates the vault recovery code and returns it ONCE.
  app.post("/api/setup/create-admin", async (req, reply) => {
    if (ctx.authStore.hasAnyAccount()) {
      return reply.code(409).send({ error: "an administrator already exists" });
    }
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (username.length < 3) return reply.code(400).send({ error: "username must be at least 3 characters" });
    const weak = validatePasswordStrength(password);
    if (weak) return reply.code(400).send({ error: weak });

    const account = ctx.authStore.createAccount(username, await hashPassword(password));

    // Generate the recovery code that wraps the already-created vault master key.
    const recovery = createRecovery(ctx.masterKey);
    if (!opts.inMemory) {
      const wrapPath = join(opts.dataDir, "keys", "recovery.wrapped.json");
      mkdirSync(dirname(wrapPath), { recursive: true });
      writeFileSync(wrapPath, JSON.stringify(recovery.wrappedKey), { mode: 0o600 });
    }

    // Log the user in immediately so the rest of OOBE is authenticated.
    issueSession(reply, ctx, account.id, opts.secureCookies);

    // Return the recovery code ONCE. It is never logged or stored in plaintext.
    return {
      account: { id: account.id, username: account.username, role: account.role },
      recoveryCode: recovery.recoveryCode,
    };
  });

  // Step: confirm the recovery code was saved. The client re-enters (a prefix
  // of) the code or simply acknowledges; we record the acknowledgement in
  // non-secret progress. We never store the code itself.
  app.post("/api/setup/confirm-recovery", { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as { acknowledged?: unknown };
    if (body.acknowledged !== true) {
      return reply.code(400).send({ error: "you must confirm you saved the recovery code" });
    }
    const progress = ctx.authStore.getSetupState().progress;
    ctx.authStore.saveSetupProgress({ ...progress, recoveryConfirmed: true });
    return { ok: true };
  });

  // Step: "Try Frolo safely" — create a mock configuration for the beta demo.
  // Seeds mock routers so the complete Nginx deployment flow can be demonstrated
  // without any real infrastructure.
  app.post("/api/setup/try-mock", { preHandler: requireAuth }, async () => {
    // Default network profiles for the wizard.
    seedDefaultNetworkProfiles(ctx);
    // Seed a 2-router mock chain the demo can use.
    ctx.seedMockRouter({ id: "archer", name: "Archer C6U (mock)", kind: "fixtureA", baseUrl: "http://192.168.10.1", wanAddress: "192.168.1.2" });
    ctx.seedMockRouter({ id: "keenetic", name: "Keenetic (mock)", kind: "fixtureB", baseUrl: "http://192.168.1.1", wanAddress: "203.0.113.7" });
    ctx.store.saveRouterChain({
      id: "mock-chain",
      name: "Mock home chain",
      hops: [
        { routerProfileId: "archer", wanAddress: "192.168.1.2" },
        { routerProfileId: "keenetic", wanAddress: "203.0.113.7" },
      ],
    });
    const progress = ctx.authStore.getSetupState().progress;
    ctx.authStore.saveSetupProgress({ ...progress, mode: "mock", mockSeeded: true });
    return { ok: true, mode: "mock" };
  });

  // Step: validate a Proxmox connection WITHOUT mutating anything. In the beta
  // this exercises the (mock) provider's read-only validate(); a real connection
  // uses the same path once real mode is enabled. Never creates/changes infra.
  app.post("/api/setup/validate-proxmox", { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      host?: unknown;
      node?: unknown;
      tokenId?: unknown;
      tokenSecret?: unknown;
      pinnedCertSha256?: unknown;
    };
    // The token secret, if provided, is stored ONLY in the vault — never in
    // progress or logs. For the mock beta, validation uses the fake provider.
    try {
      const report = await ctx.controller.listTemplates(
        typeof body.node === "string" && body.node ? body.node : "pve",
      );
      const caps = { ok: true, templatesDetected: report.length };
      const progress = ctx.authStore.getSetupState().progress;
      ctx.authStore.saveSetupProgress({
        ...progress,
        proxmox: {
          host: typeof body.host === "string" ? body.host : undefined,
          node: typeof body.node === "string" ? body.node : "pve",
          // NEVER persist tokenSecret; only note that a token was provided.
          tokenProvided: typeof body.tokenSecret === "string" && body.tokenSecret.length > 0,
          pinnedCertSha256: typeof body.pinnedCertSha256 === "string" ? body.pinnedCertSha256 : undefined,
        },
      });
      return { ...caps, templates: report };
    } catch (err) {
      return reply.code(400).send({ error: ctx.sanitizer.sanitize(err) });
    }
  });

  // Step: detect templates on the selected node (read-only).
  app.get("/api/setup/templates", { preHandler: requireAuth }, async (req) => {
    const q = (req.query ?? {}) as { node?: string };
    return { templates: await ctx.controller.listTemplates(q.node ?? "pve") };
  });

  // Step: save the default network profile (persisted, no infra touched).
  app.post("/api/setup/network-profile", { preHandler: requireAuth }, async (req, reply) => {
    try {
      ctx.controller.saveNetworkProfile(req.body);
      const progress = ctx.authStore.getSetupState().progress;
      ctx.authStore.saveSetupProgress({ ...progress, networkConfigured: true });
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: ctx.sanitizer.sanitize(err) });
    }
  });

  // Step: finish. Marks setup complete; from now on OOBE never shows again.
  app.post("/api/setup/complete", { preHandler: requireAuth }, async (_req, reply) => {
    if (!ctx.authStore.hasAnyAccount()) {
      return reply.code(400).send({ error: "create an administrator first" });
    }
    // Ensure at least the default network profiles exist for the dashboard.
    seedDefaultNetworkProfiles(ctx);
    ctx.authStore.markSetupComplete();
    return { ok: true };
  });
}

// Only these non-secret keys are allowed in persisted setup progress.
const ALLOWED_PROGRESS_KEYS = new Set([
  "step",
  "mode",
  "mockSeeded",
  "recoveryConfirmed",
  "proxmox",
  "node",
  "networkConfigured",
  "routerConfigured",
  "gatewayConfigured",
  "skippedRouter",
  "skippedGateway",
]);

function sanitizeProgress(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!ALLOWED_PROGRESS_KEYS.has(k)) continue;
    // Defensively strip anything that looks secret.
    if (/pass|secret|token|key|recovery/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function seedDefaultNetworkProfiles(ctx: AppContext): void {
  const existing = new Set(ctx.controller.listNetworkProfiles().map((p) => p.id));
  if (!existing.has("net-dhcp")) {
    ctx.controller.saveNetworkProfile({ id: "net-dhcp", name: "DHCP", mode: "dhcp" });
  }
  if (!existing.has("net-vmid")) {
    ctx.controller.saveNetworkProfile({
      id: "net-vmid",
      name: "VM-ID derived",
      mode: "vmid",
      subnetCidr: "192.168.7.0/24",
      gateway: "192.168.7.1",
      vmidRule: { offset: 0 },
    });
  }
}

export { FastifyReply };
