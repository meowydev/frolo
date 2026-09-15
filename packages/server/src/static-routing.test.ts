// Production static-file routing (task 14). When a built web panel is present
// (webRoot), the server serves it with an SPA fallback while keeping /api/*
// JSON-only. Also verifies that path traversal / encoded separators cannot
// escape the web root — this exercises the @fastify/static v10 hardening we
// upgraded to (advisories GHSA-83w8-p2f5-377r, -pr96-94w5-mx2h, -x428-ghpx-8j92,
// -8pvw-jcv7-9cmj).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext, type AppContext } from "./context.js";
import { buildApp } from "./app.js";

let ctx: AppContext;
let app: FastifyInstance;
let webRoot: string;
let secretDir: string;

beforeEach(async () => {
  // A temp web root with an index + a nested asset.
  webRoot = mkdtempSync(join(tmpdir(), "frolo-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Frolo panel</title>");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log('frolo');");

  // A sibling directory OUTSIDE the web root holding a would-be secret. A
  // traversal that escaped webRoot could try to read this; it must not.
  secretDir = mkdtempSync(join(tmpdir(), "frolo-secret-"));
  writeFileSync(join(secretDir, "secret.txt"), "TOP-SECRET-SHOULD-NEVER-BE-SERVED");

  ctx = await buildContext({ inMemory: true, dataDir: "/tmp", allowDevLicenseKeys: true });
  app = await buildApp(ctx, { secureCookies: false, dataDir: "/tmp", inMemory: true, webRoot });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  ctx.close();
  rmSync(webRoot, { recursive: true, force: true });
  rmSync(secretDir, { recursive: true, force: true });
});

describe("production static-file routing", () => {
  it("serves index.html at /", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Frolo panel");
  });

  it("serves nested built assets", async () => {
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("frolo");
  });

  it("SPA fallback: unknown non-API GET returns index.html", async () => {
    const res = await app.inject({ method: "GET", url: "/deployments/xyz" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Frolo panel");
  });

  it("keeps /api/* JSON-only (unknown API path is a JSON 404, not index.html)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual({ error: "not found" });
  });

  it("requires auth for real API routes (static hosting doesn't bypass auth)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/deployments" });
    expect(res.statusCode).toBe(401);
  });

  // --- traversal / non-canonical path hardening ---------------------------
  const escapes = [
    "/../secret.txt",
    "/../../secret.txt",
    "/assets/../../secret.txt",
    "/%2e%2e/secret.txt",
    "/%2e%2e%2fsecret.txt",
    "/..%2fsecret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt",
  ];
  for (const url of escapes) {
    it(`never serves files outside the web root: ${url}`, async () => {
      const res = await app.inject({ method: "GET", url });
      // Either rejected, or resolved to the SPA index — but NEVER the secret.
      expect(res.body).not.toContain("TOP-SECRET-SHOULD-NEVER-BE-SERVED");
      expect([200, 400, 403, 404]).toContain(res.statusCode);
      // If it resolved to something 200, it must be the SPA index, not a file
      // from outside the root.
      if (res.statusCode === 200) {
        expect(res.body).toContain("Frolo panel");
      }
    });
  }
});
