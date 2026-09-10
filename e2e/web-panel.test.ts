// End-to-end web-panel tests (req: first setup, interrupted setup recovery,
// login/logout, mock deployment full Nginx flow, service restart, persistent
// data, expired license preserves infra, unauthorized API rejection).
//
// These drive the real Fastify app (via inject) against a FILE-BACKED context in
// a temp dir, so "service restart" and "persistent data" can be verified by
// closing the app+context and reopening a new one over the same data dir.
// Everything runs in mock mode — no real infrastructure is touched.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext, buildApp, type AppContext } from "@frolo/server";
import { createDevIssuer } from "@frolo/licensing";

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  dataDir: string;
}

function parseCookies(res: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
  const out: Record<string, string> = {};
  for (const c of list) {
    const [pair] = c.split(";");
    const [k, v] = pair!.split("=");
    if (v === "" ) delete out[k!];
    else out[k!] = v!;
  }
  return out;
}
const cookieHeader = (jar: Record<string, string>) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

async function open(dataDir: string, licenseKeys: Parameters<typeof buildContext>[0]["licenseKeys"] = []): Promise<Harness> {
  const ctx = await buildContext({ dataDir, licenseKeys, allowDevLicenseKeys: true });
  const app = await buildApp(ctx, { secureCookies: false, dataDir });
  await app.ready();
  return { app, ctx, dataDir };
}
async function close(h: Harness): Promise<void> {
  await h.app.close();
  h.ctx.close();
}

// Complete first-run setup and return an authenticated cookie jar.
async function completeSetup(h: Harness): Promise<Record<string, string>> {
  const admin = await h.app.inject({
    method: "POST",
    url: "/api/setup/create-admin",
    payload: { username: "admin", password: "correct horse battery" },
  });
  const jar = parseCookies(admin);
  const csrf = { cookie: cookieHeader(jar), "x-frolo-csrf": jar.frolo_csrf };
  await h.app.inject({ method: "POST", url: "/api/setup/confirm-recovery", headers: csrf, payload: { acknowledged: true } });
  await h.app.inject({ method: "POST", url: "/api/setup/try-mock", headers: csrf });
  await h.app.inject({ method: "POST", url: "/api/setup/network-profile", headers: csrf, payload: { id: "net-dhcp", name: "DHCP", mode: "dhcp" } });
  await h.app.inject({ method: "POST", url: "/api/setup/complete", headers: csrf });
  return jar;
}

let dataDir: string;
let h: Harness;

describe("Frolo web panel — e2e", () => {
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "frolo-e2e-"));
    h = await open(dataDir);
  });
  afterEach(async () => {
    await close(h);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("first setup: creates admin, returns recovery code once, completes", async () => {
    const before = await h.app.inject({ method: "GET", url: "/api/auth/state" });
    expect(before.json()).toEqual({ hasAccount: false, setupComplete: false });

    const jar = await completeSetup(h);
    expect(jar.frolo_session).toBeTruthy();

    const after = await h.app.inject({ method: "GET", url: "/api/auth/state" });
    expect(after.json().setupComplete).toBe(true);
  });

  it("rejects unauthorized API requests", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/deployments" });
    expect(res.statusCode).toBe(401);
  });

  it("interrupted setup recovery: resumes non-secret progress after a restart", async () => {
    const admin = await h.app.inject({
      method: "POST",
      url: "/api/setup/create-admin",
      payload: { username: "admin", password: "correct horse battery" },
    });
    const jar = parseCookies(admin);
    await h.app.inject({
      method: "POST",
      url: "/api/setup/progress",
      headers: { cookie: cookieHeader(jar), "x-frolo-csrf": jar.frolo_csrf },
      payload: { progress: { step: 4, node: "pve", skippedGateway: true } },
    });

    // Simulate a service restart: close and reopen over the same data dir.
    await close(h);
    h = await open(dataDir);

    const state = await h.app.inject({ method: "GET", url: "/api/setup/state" });
    expect(state.json().completed).toBe(false);
    expect(state.json().hasAccount).toBe(true); // admin persisted
    expect(state.json().progress.step).toBe(4);
    expect(state.json().progress.skippedGateway).toBe(true);
  });

  it("login and logout", async () => {
    await completeSetup(h);
    const login = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery" } });
    expect(login.statusCode).toBe(200);
    const jar = parseCookies(login);
    const me = await h.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieHeader(jar) } });
    expect(me.json().account.username).toBe("admin");
    const logout = await h.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: cookieHeader(jar), "x-frolo-csrf": jar.frolo_csrf } });
    expect(logout.statusCode).toBe(200);
    const me2 = await h.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieHeader(jar) } });
    expect(me2.json().account).toBeNull();
  });

  it("mock deployment: full Nginx flow reaches Ready with a local address", async () => {
    const jar = await completeSetup(h);
    const csrf = { cookie: cookieHeader(jar), "x-frolo-csrf": jar.frolo_csrf };

    const dep = (await h.app.inject({
      method: "POST",
      url: "/api/deployments",
      headers: csrf,
      payload: {
        name: "web-01",
        connectionId: "local",
        templateVmid: 9000,
        cores: 2,
        ramMb: 2048,
        diskGb: 10,
        hostname: "web-01",
        sshUser: "ubuntu",
        networkProfileId: "net-dhcp",
        recipeId: "builtin.nginx",
      },
    })).json() as { id: string };

    const run = await h.app.inject({ method: "POST", url: `/api/deployments/${dep.id}/run`, headers: csrf });
    expect(run.statusCode).toBe(200);
    expect(run.json().state).toBe("Ready");
    expect(run.json().localAddress).toMatch(/^192\.168\.7\./);

    const transitions = (await h.app.inject({
      method: "GET",
      url: `/api/deployments/${dep.id}/transitions`,
      headers: { cookie: cookieHeader(jar) },
    })).json() as { to: string }[];
    expect(transitions.map((t) => t.to)).toEqual([
      "Queued", "Cloning", "Configuring", "Booting", "Installing", "Checking", "Ready",
    ]);
  });

  it("service restart + persistent data: a Ready deployment survives a restart", async () => {
    const jar = await completeSetup(h);
    const csrf = { cookie: cookieHeader(jar), "x-frolo-csrf": jar.frolo_csrf };
    const dep = (await h.app.inject({
      method: "POST",
      url: "/api/deployments",
      headers: csrf,
      payload: {
        name: "persist-01", connectionId: "local", templateVmid: 9000, cores: 1, ramMb: 1024,
        diskGb: 8, hostname: "persist-01", sshUser: "ubuntu", networkProfileId: "net-dhcp", recipeId: "builtin.nginx",
      },
    })).json() as { id: string };
    await h.app.inject({ method: "POST", url: `/api/deployments/${dep.id}/run`, headers: csrf });

    // Restart the service over the same data dir.
    await close(h);
    h = await open(dataDir);

    // Log in again (session cookie survives, but exercise a fresh login too).
    const login = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "correct horse battery" } });
    const jar2 = parseCookies(login);
    const list = (await h.app.inject({ method: "GET", url: "/api/deployments", headers: { cookie: cookieHeader(jar2) } })).json() as { id: string; state: string; plan: { name: string } }[];
    const found = list.find((d) => d.id === dep.id);
    expect(found).toBeTruthy();
    expect(found!.state).toBe("Ready"); // persisted across restart
    expect(found!.plan.name).toBe("persist-01");
  });
});

describe("Frolo web panel — expired license preserves infrastructure", () => {
  it("keeps a Ready deployment after the license expires", async () => {
    const issuer = createDevIssuer();
    const dir = mkdtempSync(join(tmpdir(), "frolo-e2e-lic-"));
    const harness = await open(dir, [issuer.publicKey]);
    try {
      const jar = await completeSetup(harness);
      const csrf = { cookie: cookieHeader(jar), "x-frolo-csrf": jar.frolo_csrf };

      // Deploy locally (no exposure — Home tier is fine).
      const dep = (await harness.app.inject({
        method: "POST", url: "/api/deployments", headers: csrf,
        payload: { name: "lic-01", connectionId: "local", templateVmid: 9000, cores: 1, ramMb: 1024, diskGb: 8, hostname: "lic-01", sshUser: "ubuntu", networkProfileId: "net-dhcp", recipeId: "builtin.nginx" },
      })).json() as { id: string };
      await harness.app.inject({ method: "POST", url: `/api/deployments/${dep.id}/run`, headers: csrf });

      // Install an already-expired license.
      const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      await harness.app.inject({
        method: "POST", url: "/api/license/install", headers: csrf,
        payload: { license: JSON.stringify(issuer.issue({ subject: "d", tier: "advanced_user", issuedAt: longAgo })) },
      });
      const ent = (await harness.app.inject({ method: "GET", url: "/api/license/entitlements", headers: { cookie: cookieHeader(jar) } })).json();
      expect(ent.status.state).toBe("expired");
      expect(ent.effectiveTier).toBe("home");

      // The deployment is untouched.
      const d = (await harness.app.inject({ method: "GET", url: `/api/deployments/${dep.id}`, headers: { cookie: cookieHeader(jar) } })).json();
      expect(d.state).toBe("Ready");
    } finally {
      await close(harness);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
