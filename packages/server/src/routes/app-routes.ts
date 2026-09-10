// Application API routes (req: authenticated Fastify API mirroring the former
// IPC surface). All routes require an authenticated session; mutations also pass
// the global CSRF + Origin checks registered on the app.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";
import { requireAuth } from "../security.js";

export function registerAppRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: requireAuth };
  const c = ctx.controller;

  app.get("/api/mode", auth, async () => c.getMode());

  app.get("/api/templates", auth, async (req) => {
    const q = (req.query ?? {}) as { node?: string };
    return c.listTemplates(q.node ?? "pve");
  });
  app.get("/api/vms", auth, async (req) => {
    const q = (req.query ?? {}) as { node?: string };
    return c.listVms(q.node ?? "pve");
  });
  app.get("/api/recipes", auth, async () => c.listRecipes());

  app.get("/api/deployments", auth, async () => c.listDeployments());
  app.post("/api/deployments", auth, async (req, reply) =>
    guard(reply, () => c.createDeployment(req.body)),
  );
  app.get("/api/deployments/:id", auth, async (req, reply) =>
    guard(reply, () => c.getDeployment(id(req))),
  );
  app.get("/api/deployments/:id/plan", auth, async (req, reply) =>
    guard(reply, () => c.previewPlan(id(req))),
  );
  app.post("/api/deployments/:id/run", auth, async (req, reply) =>
    guardAsync(reply, () => c.runDeployment(id(req))),
  );
  app.post("/api/deployments/:id/retry", auth, async (req, reply) =>
    guardAsync(reply, () => c.retryDeployment(id(req))),
  );
  app.get("/api/deployments/:id/transitions", auth, async (req, reply) =>
    guard(reply, () => c.listTransitions(id(req))),
  );
  app.get("/api/deployments/:id/logs", auth, async (req, reply) =>
    guard(reply, () => c.listLogs(id(req))),
  );
  app.get("/api/deployments/:id/operations", auth, async (req, reply) =>
    guard(reply, () => c.listOperations(id(req))),
  );
  app.get("/api/deployments/:id/mappings", auth, async (req, reply) =>
    guard(reply, () => c.listMappings(id(req))),
  );

  // Confirmation-gated mutations. The UI must have shown the review + collected
  // an explicit confirmation before calling these.
  app.post("/api/deployments/:id/expose", auth, async (req, reply) =>
    guardAsync(reply, () => c.confirmAndExpose(id(req), { confirmed: true })),
  );
  app.post("/api/deployments/:id/delete", auth, async (req, reply) =>
    guardAsync(reply, () => c.confirmAndDelete(id(req), { confirmed: true })),
  );

  // Profiles / routers / chains
  app.get("/api/network-profiles", auth, async () => c.listNetworkProfiles());
  app.post("/api/network-profiles", auth, async (req, reply) =>
    guard(reply, () => {
      c.saveNetworkProfile(req.body);
      return { ok: true };
    }),
  );
  app.get("/api/routers/:id", auth, async (req, reply) => guard(reply, () => c.getRouterProfile(id(req))));
  app.post("/api/routers", auth, async (req, reply) =>
    guard(reply, () => {
      c.saveRouterProfile(req.body as never);
      return { ok: true };
    }),
  );
  app.post("/api/routers/:id/credentials", auth, async (req, reply) =>
    guardAsync(reply, async () => {
      const b = (req.body ?? {}) as { username?: string; password?: string };
      await c.setRouterCredentials(id(req), b.username ?? "", b.password ?? "");
      return { ok: true };
    }),
  );
  app.get("/api/chains/:id", auth, async (req, reply) => guard(reply, () => c.getRouterChain(id(req))));
  app.post("/api/chains", auth, async (req, reply) =>
    guard(reply, () => {
      c.saveRouterChain(req.body as never);
      return { ok: true };
    }),
  );

  // Vault + audit
  app.get("/api/vault/status", auth, async () => c.vaultStatus());
  app.get("/api/audit", auth, async () => c.listAudit());

  // Licensing
  app.get("/api/license/entitlements", auth, async () => c.getEntitlements());
  app.get("/api/license/device-code", auth, async () => ({ code: await c.getDeviceCode() }));
  app.post("/api/license/install", auth, async (req, reply) =>
    guardAsync(reply, async () => {
      const b = (req.body ?? {}) as { license?: unknown };
      return c.installLicense(typeof b.license === "string" ? b.license : JSON.stringify(b.license));
    }),
  );
}

function id(req: FastifyRequest): string {
  const p = req.params as { id?: string };
  if (!p.id) throw new Error("missing id");
  return p.id;
}

// Wrap a sync controller call, mapping thrown errors to 400 with a sanitized
// message (the controller already sanitizes its own errors).
function guard<T>(reply: FastifyReply, fn: () => T): T | FastifyReply {
  try {
    return fn();
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
}
async function guardAsync<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
}
