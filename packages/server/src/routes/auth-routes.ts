// Auth routes: login, logout, session info. First-admin creation lives in the
// setup routes (OOBE). Login is rate-limited per IP and issues a session +
// CSRF cookie pair.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { hashPassword, verifyPassword, validatePasswordStrength } from "../auth/password.js";
import {
  SESSION_COOKIE,
  CSRF_COOKIE,
  SESSION_TTL_MS,
  sessionCookieOptions,
  csrfCookieOptions,
  newCsrfToken,
  requireAuth,
} from "../security.js";

const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, secureCookies: boolean): void {
  // Whether any admin exists yet (drives first-run UI). Unauthenticated.
  app.get("/api/auth/state", async () => {
    const setup = ctx.authStore.getSetupState();
    return {
      hasAccount: ctx.authStore.hasAnyAccount(),
      setupComplete: setup.completed,
    };
  });

  // Who am I. Returns the account or null.
  app.get("/api/auth/me", async (req) => {
    return { account: req.account ?? null };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const ip = clientIp(req);
    if (!ctx.authStore.registerLoginAttempt(ip, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)) {
      return reply.code(429).send({ error: "too many login attempts; try again later" });
    }
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    const account = ctx.authStore.getAccountByUsername(username);
    // Always run a hash comparison to avoid user-enumeration timing differences.
    const ok = account
      ? await verifyPassword(password, account.passwordHash)
      : await verifyPassword(password, DUMMY_HASH);
    if (!account || !ok) {
      return reply.code(401).send({ error: "invalid username or password" });
    }
    ctx.authStore.clearLoginAttempts(ip);
    issueSession(reply, ctx, account.id, secureCookies);
    return { account: { id: account.id, username: account.username, role: account.role } };
  });

  app.post("/api/auth/logout", { preHandler: requireAuth }, async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) ctx.authStore.revokeSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return { ok: true };
  });

  // Revoke every session for the current account ("log out everywhere").
  app.post("/api/auth/logout-all", { preHandler: requireAuth }, async (req, reply) => {
    ctx.authStore.revokeAllForAccount(req.account!.id);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return { ok: true };
  });
}

// Shared helpers reused by setup routes when creating the first admin.
export function issueSession(reply: import("fastify").FastifyReply, ctx: AppContext, accountId: string, secure: boolean): void {
  const token = ctx.authStore.createSession(accountId, SESSION_TTL_MS);
  const csrf = newCsrfToken();
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(secure));
  reply.setCookie(CSRF_COOKIE, csrf, csrfCookieOptions(secure));
}

export { hashPassword, validatePasswordStrength };

function clientIp(req: import("fastify").FastifyRequest): string {
  return req.ip || "unknown";
}

// A fixed dummy scrypt hash of a random value, used only for timing-equalization
// on unknown usernames. Not a real credential.
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
