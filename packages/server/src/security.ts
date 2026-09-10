// Security middleware (req: protected sessions, secure cookie settings, CSRF,
// login rate limiting, session revocation).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AppContext } from "./context.js";
import type { Account } from "./auth/auth-store.js";

export const SESSION_COOKIE = "frolo_session";
export const CSRF_COOKIE = "frolo_csrf";
export const CSRF_HEADER = "x-frolo-csrf";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

declare module "fastify" {
  interface FastifyRequest {
    account?: Account;
  }
}

export interface SecurityOptions {
  // When true, cookies are marked Secure (behind an HTTPS reverse proxy). On a
  // plain-HTTP LAN this is false so login still works; the UI shows a warning.
  secureCookies: boolean;
}

// Secure cookie attributes. HttpOnly + SameSite=Strict + Path=/.
export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

// The CSRF cookie is readable by JS (double-submit pattern): the client echoes
// it in a header, and the server checks they match. It is NOT HttpOnly.
export function csrfCookieOptions(secure: boolean) {
  return {
    httpOnly: false,
    sameSite: "strict" as const,
    secure,
    path: "/",
  };
}

export function newCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

// Attach an onRequest hook that resolves the session cookie into request.account.
export function registerSessionResolver(app: FastifyInstance, ctx: AppContext): void {
  app.addHook("onRequest", async (req) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const account = ctx.authStore.resolveSession(token);
      if (account) req.account = account;
    }
  });
}

// Guard: require an authenticated session. Use as a route preHandler.
export function requireAuth(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!req.account) {
    reply.code(401).send({ error: "authentication required" });
    return;
  }
  done();
}

// CSRF check for state-changing requests (double-submit cookie). Compares the
// header token to the cookie token in constant time.
export function checkCsrf(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    done();
    return;
  }
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.headers[CSRF_HEADER];
  const header = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!cookieToken || !header || !constantTimeEqual(cookieToken, header)) {
    reply.code(403).send({ error: "invalid CSRF token" });
    return;
  }
  done();
}

// Strict same-origin/Origin check for state-changing requests as defense in
// depth (in addition to CSRF token). Allows requests with no Origin (curl/tests)
// but rejects cross-origin browser requests.
export function checkOrigin(allowedHosts: string[]) {
  return function (req: FastifyRequest, reply: FastifyReply, done: () => void): void {
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      done();
      return;
    }
    const origin = req.headers.origin;
    if (!origin) {
      done();
      return;
    }
    try {
      const host = new URL(origin).host;
      // Accept same host (any port) — LAN access uses IP:4512.
      const hostname = host.split(":")[0]!;
      if (allowedHosts.includes(hostname) || allowedHosts.includes(host)) {
        done();
        return;
      }
    } catch {
      /* fallthrough to reject */
    }
    reply.code(403).send({ error: "cross-origin request rejected" });
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
