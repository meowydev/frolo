// Fastify app assembly (req: authenticated Fastify API + SSE; health check;
// graceful shutdown handled by the bin entry). Binds to 4512 by default and to
// the LAN; never opens a router mapping to expose itself.

import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import type { AppContext } from "./context.js";
import { registerSessionResolver, checkCsrf, checkOrigin } from "./security.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerSetupRoutes } from "./routes/setup-routes.js";
import { registerAppRoutes } from "./routes/app-routes.js";
import { registerConnectionRoutes } from "./routes/connection-routes.js";
import { registerUpdateRoutes } from "./routes/update-routes.js";
import { registerEventStream } from "./events-sse.js";

export interface AppOptions {
  secureCookies: boolean; // true behind an HTTPS reverse proxy
  dataDir: string;
  inMemory?: boolean;
  // Extra hostnames allowed as request Origin (in addition to any host header).
  allowedOrigins?: string[];
  // Reflected to the UI so it can show the plain-HTTP LAN warning.
  behindTls?: boolean;
  // Absolute path to the built web panel (static files). Omit in dev/tests.
  webRoot?: string;
}

export const FROLO_VERSION = "0.1.0-beta.1";

export async function buildApp(ctx: AppContext, opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // we route all logging through the sanitizer, not Fastify's logger
    trustProxy: true, // correct client IP behind a reverse proxy for rate limiting
    bodyLimit: 1_000_000,
  });

  await app.register(cookie);

  // Resolve sessions on every request.
  registerSessionResolver(app, ctx);

  // Global CSRF + Origin checks for state-changing requests. Login/setup are
  // included; the initial CSRF cookie is issued on first GET below.
  const allowed = opts.allowedOrigins ?? ["localhost", "127.0.0.1"];
  app.addHook("preHandler", (req, reply, done) => checkOrigin(allowed)(req, reply, done));
  app.addHook("preHandler", (req, reply, done) => {
    // Exempt login + create-admin from CSRF token (no session/cookie yet), but
    // they are still protected by Origin checks + rate limiting.
    const path = req.url.split("?")[0] ?? "";
    const exempt =
      path === "/api/auth/login" ||
      path === "/api/setup/create-admin";
    if (exempt) {
      done();
      return;
    }
    checkCsrf(req, reply, done);
  });

  // Health check (unauthenticated) for Docker + installer.
  app.get("/api/health", async () => ({
    status: "ok",
    version: FROLO_VERSION,
    mode: ctx.controller.getMode().mode,
  }));

  // Runtime info the UI needs before login (drives HTTP-vs-HTTPS warning).
  app.get("/api/info", async () => ({
    version: FROLO_VERSION,
    beta: true,
    behindTls: Boolean(opts.behindTls),
  }));

  registerAuthRoutes(app, ctx, opts.secureCookies);
  registerSetupRoutes(app, ctx, {
    secureCookies: opts.secureCookies,
    dataDir: opts.dataDir,
    inMemory: opts.inMemory,
  });
  registerAppRoutes(app, ctx);
  registerConnectionRoutes(app, ctx);
  registerUpdateRoutes(app, ctx);
  registerEventStream(app, ctx);

  // Serve the built React web panel (production) with SPA fallback. Skipped when
  // no build dir is provided (e.g. dev server proxies the API instead).
  if (opts.webRoot) {
    const staticPlugin = (await import("@fastify/static")).default;
    await app.register(staticPlugin, { root: opts.webRoot, wildcard: false });
    // SPA fallback: any non-API GET returns index.html so client routing works.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  return app;
}
