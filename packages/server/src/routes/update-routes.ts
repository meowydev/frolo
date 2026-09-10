// Updater API (req: update status + manual controls). All routes require auth.
//
// - GET  /api/update/status    current version + latest known release
// - POST /api/update/check     query GitHub releases now (meowydev/frolo)
// - GET  /api/update/progress  current in-flight phase (for the UI)
// - POST /api/update/apply     install a SPECIFIC tag transactionally
//
// When the deployment has no source release root (Docker/dev), the updater is
// null and these endpoints report that updates are managed externally rather
// than failing confusingly.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { requireAuth } from "../security.js";

export function registerUpdateRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: requireAuth };

  app.get("/api/update/status", auth, async () => {
    if (!ctx.updater) {
      return { managedExternally: true, reason: "This deployment updates by pulling a new image/tag." };
    }
    return { managedExternally: false, ...ctx.updater.getStatus() };
  });

  app.get("/api/update/progress", auth, async () => {
    if (!ctx.updater) return { phase: "idle", message: "external", at: new Date().toISOString() };
    return ctx.updater.getProgress();
  });

  app.post("/api/update/check", auth, async (_req, reply) => {
    if (!ctx.updater) return reply.code(409).send({ error: "updates are managed externally for this deployment" });
    return ctx.updater.checkForUpdates();
  });

  app.post("/api/update/apply", auth, async (req, reply) => {
    if (!ctx.updater) return reply.code(409).send({ error: "updates are managed externally for this deployment" });
    const b = (req.body ?? {}) as { tag?: unknown };
    const tag = typeof b.tag === "string" ? b.tag.trim() : "";
    if (!tag) return reply.code(400).send({ error: "tag is required (only tagged releases may be installed)" });
    const result = await ctx.updater.applyUpdate(tag);
    if (!result.ok) return reply.code(400).send(result);
    return result;
  });
}
