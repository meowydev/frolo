import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildContext, type AppContext } from "./context.js";
import { buildApp } from "./app.js";
import { createDevIssuer } from "@frolo/licensing";

let ctx: AppContext;
let app: FastifyInstance;

async function setup(licenseKeys = []) {
  ctx = await buildContext({ inMemory: true, dataDir: "/tmp", licenseKeys, allowDevLicenseKeys: true });
  app = await buildApp(ctx, { secureCookies: false, dataDir: "/tmp", inMemory: true });
  await app.ready();
}

// Parse Set-Cookie headers into a name->value map.
function cookies(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
  const out: Record<string, string> = {};
  for (const c of list) {
    const [pair] = c.split(";");
    const [k, v] = pair!.split("=");
    out[k!] = v!;
  }
  return out;
}
function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

describe("Frolo server", () => {
  beforeEach(() => setup());
  afterEach(async () => {
    await app.close();
    ctx.close();
  });

  it("serves an unauthenticated health check", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("rejects unauthorized API requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/deployments" });
    expect(res.statusCode).toBe(401);
  });

  it("reports no account before first-run setup", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/state" });
    expect(res.json()).toEqual({ hasAccount: false, setupComplete: false });
  });

  it("creates the first admin and returns a recovery code exactly once", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/create-admin",
      payload: { username: "admin", password: "correct horse battery" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.account.username).toBe("admin");
    expect(body.recoveryCode).toMatch(/^FROLO-/);
    // Session + CSRF cookies issued.
    const jar = cookies(res);
    expect(jar.frolo_session).toBeTruthy();
    expect(jar.frolo_csrf).toBeTruthy();

    // A second create-admin is refused.
    const res2 = await app.inject({
      method: "POST",
      url: "/api/setup/create-admin",
      payload: { username: "admin2", password: "another good passphrase" },
    });
    expect(res2.statusCode).toBe(409);
  });

  it("rejects weak passwords", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/create-admin",
      payload: { username: "admin", password: "short" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("enforces CSRF on authenticated mutations", async () => {
    // Create admin -> get session cookie.
    const created = await app.inject({
      method: "POST",
      url: "/api/setup/create-admin",
      payload: { username: "admin", password: "correct horse battery" },
    });
    const jar = cookies(created);

    // Mutation WITHOUT the CSRF header is rejected.
    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/network-profiles",
      headers: { cookie: cookieHeader(jar) },
      payload: { id: "n", name: "dhcp", mode: "dhcp" },
    });
    expect(noCsrf.statusCode).toBe(403);

    // WITH the CSRF header it succeeds.
    const withCsrf = await app.inject({
      method: "POST",
      url: "/api/network-profiles",
      headers: { cookie: cookieHeader(jar), "x-frolo-csrf": jar.frolo_csrf },
      payload: { id: "n", name: "dhcp", mode: "dhcp" },
    });
    expect(withCsrf.statusCode).toBe(200);
  });

  it("logs in, resolves the session, and logs out", async () => {
    // Create admin.
    await app.inject({
      method: "POST",
      url: "/api/setup/create-admin",
      payload: { username: "admin", password: "correct horse battery" },
    });
    // Login fresh.
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "correct horse battery" },
    });
    expect(login.statusCode).toBe(200);
    const jar = cookies(login);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieHeader(jar) } });
    expect(me.json().account.username).toBe("admin");
    // Logout revokes the session.
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: cookieHeader(jar), "x-frolo-csrf": jar.frolo_csrf },
    });
    expect(logout.statusCode).toBe(200);
    const me2 = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieHeader(jar) } });
    expect(me2.json().account).toBeNull();
  });

  it("rejects a bad password and rate-limits repeated attempts", async () => {
    await app.inject({
      method: "POST",
      url: "/api/setup/create-admin",
      payload: { username: "admin", password: "correct horse battery" },
    });
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "wrong" },
        remoteAddress: "203.0.113.9",
      });
      last = r.statusCode;
    }
    expect(last).toBe(429); // rate limited after too many attempts
  });
});
