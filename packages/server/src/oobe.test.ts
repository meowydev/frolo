import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildContext, type AppContext } from "./context.js";
import { buildApp } from "./app.js";

let ctx: AppContext;
let app: FastifyInstance;

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
const hdr = (jar: Record<string, string>) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

async function fresh() {
  ctx = await buildContext({ inMemory: true, dataDir: "/tmp", allowDevLicenseKeys: true });
  app = await buildApp(ctx, { secureCookies: false, dataDir: "/tmp", inMemory: true });
  await app.ready();
}

describe("OOBE first-run setup", () => {
  beforeEach(fresh);
  afterEach(async () => {
    await app.close();
    ctx.close();
  });

  it("walks the full happy path and marks setup complete", async () => {
    // create admin
    const admin = await app.inject({
      method: "POST",
      url: "/api/setup/create-admin",
      payload: { username: "admin", password: "correct horse battery" },
    });
    const jar = cookies(admin);
    const csrf = { cookie: hdr(jar), "x-frolo-csrf": jar.frolo_csrf };
    expect(admin.json().recoveryCode).toMatch(/^FROLO-/);

    // confirm recovery
    const rec = await app.inject({
      method: "POST",
      url: "/api/setup/confirm-recovery",
      headers: csrf,
      payload: { acknowledged: true },
    });
    expect(rec.statusCode).toBe(200);

    // validate proxmox (read-only) — detects templates
    const validate = await app.inject({
      method: "POST",
      url: "/api/setup/validate-proxmox",
      headers: csrf,
      payload: { host: "https://pve.local", node: "pve", tokenId: "frolo@pve!x", tokenSecret: "SECRET" },
    });
    expect(validate.statusCode).toBe(200);
    expect(validate.json().templatesDetected).toBeGreaterThan(0);

    // network profile
    const net = await app.inject({
      method: "POST",
      url: "/api/setup/network-profile",
      headers: csrf,
      payload: { id: "net-dhcp", name: "DHCP", mode: "dhcp" },
    });
    expect(net.statusCode).toBe(200);

    // complete
    const done = await app.inject({ method: "POST", url: "/api/setup/complete", headers: csrf });
    expect(done.statusCode).toBe(200);
    const state = await app.inject({ method: "GET", url: "/api/setup/state" });
    expect(state.json().completed).toBe(true);
  });

  it("does not create/modify/delete any VM during OOBE", async () => {
    const vmsBefore = await countVms();
    const admin = await app.inject({
      method: "POST",
      url: "/api/setup/create-admin",
      payload: { username: "admin", password: "correct horse battery" },
    });
    const jar = cookies(admin);
    const csrf = { cookie: hdr(jar), "x-frolo-csrf": jar.frolo_csrf };
    await app.inject({ method: "POST", url: "/api/setup/validate-proxmox", headers: csrf, payload: { node: "pve" } });
    await app.inject({ method: "POST", url: "/api/setup/try-mock", headers: csrf });
    await app.inject({ method: "POST", url: "/api/setup/complete", headers: csrf });
    // No deployment was created; VM inventory unchanged.
    expect(ctx.controller.listDeployments()).toHaveLength(0);
    expect(await countVms()).toBe(vmsBefore);
  });

  it("never persists the Proxmox token secret in setup progress", async () => {
    const admin = await app.inject({
      method: "POST",
      url: "/api/setup/create-admin",
      payload: { username: "admin", password: "correct horse battery" },
    });
    const jar = cookies(admin);
    const csrf = { cookie: hdr(jar), "x-frolo-csrf": jar.frolo_csrf };
    await app.inject({
      method: "POST",
      url: "/api/setup/validate-proxmox",
      headers: csrf,
      payload: { node: "pve", tokenSecret: "TOP-SECRET-TOKEN" },
    });
    const state = await app.inject({ method: "GET", url: "/api/setup/state" });
    expect(JSON.stringify(state.json())).not.toContain("TOP-SECRET-TOKEN");
    // But it did record that a token was provided.
    expect(state.json().progress.proxmox.tokenProvided).toBe(true);
  });

  it("resumes interrupted setup from saved non-secret progress", async () => {
    const admin = await app.inject({
      method: "POST",
      url: "/api/setup/create-admin",
      payload: { username: "admin", password: "correct horse battery" },
    });
    const jar = cookies(admin);
    const csrf = { cookie: hdr(jar), "x-frolo-csrf": jar.frolo_csrf };
    await app.inject({
      method: "POST",
      url: "/api/setup/progress",
      headers: csrf,
      payload: { progress: { step: "network", node: "pve", skippedRouter: true } },
    });

    // Progress is persisted in the store (survives a page reload / app restart):
    // a subsequent GET returns the saved non-secret progress. We assert directly
    // against the persisted state to prove a reload would resume the stepper.
    const persisted = ctx.authStore.getSetupState();
    expect(persisted.completed).toBe(false);
    expect(persisted.progress.step).toBe("network");
    expect(persisted.progress.skippedRouter).toBe(true);

    const state = await app.inject({ method: "GET", url: "/api/setup/state" });
    expect(state.json().completed).toBe(false);
    expect(state.json().progress.step).toBe("network");
  });

  it("stores router credentials only in the vault, not in progress", async () => {
    const admin = await app.inject({
      method: "POST",
      url: "/api/setup/create-admin",
      payload: { username: "admin", password: "correct horse battery" },
    });
    const jar = cookies(admin);
    const csrf = { cookie: hdr(jar), "x-frolo-csrf": jar.frolo_csrf };
    await app.inject({ method: "POST", url: "/api/setup/try-mock", headers: csrf });
    await app.inject({
      method: "POST",
      url: "/api/routers/archer/credentials",
      headers: csrf,
      payload: { username: "admin", password: "router-secret-xyz" },
    });
    const state = await app.inject({ method: "GET", url: "/api/setup/state" });
    expect(JSON.stringify(state.json())).not.toContain("router-secret-xyz");
  });
});

async function countVms(): Promise<number> {
  return (await ctx.controller.listVms("pve")).length;
}
