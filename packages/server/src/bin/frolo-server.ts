#!/usr/bin/env node
// Frolo server entry point. Binds to :4512 on all LAN interfaces by default,
// prints the exact access URL, and shuts down gracefully. It NEVER opens a
// router mapping to expose itself — LAN-only unless the operator puts it behind
// their own reverse proxy.

import { networkInterfaces } from "node:os";
import { buildContext } from "../context.js";
import { buildApp, FROLO_VERSION } from "../app.js";

const PORT = Number(process.env.FROLO_PORT ?? 4512);
const HOST = process.env.FROLO_HOST ?? "0.0.0.0"; // LAN by default
const DATA_DIR = process.env.FROLO_DATA_DIR ?? "/opt/frolo/data";
const BEHIND_TLS = process.env.FROLO_BEHIND_TLS === "1";
const WEB_ROOT = process.env.FROLO_WEB_ROOT; // set by the container image

async function main(): Promise<void> {
  const ctx = await buildContext({ dataDir: DATA_DIR });

  // Reconcile any operations left unresolved by a prior crash.
  await ctx.controller.reconcileOnStartup();

  const app = await buildApp(ctx, {
    secureCookies: BEHIND_TLS,
    behindTls: BEHIND_TLS,
    dataDir: DATA_DIR,
    webRoot: WEB_ROOT,
    allowedOrigins: lanOrigins(),
  });

  await app.listen({ port: PORT, host: HOST });

  const ip = firstLanIp();
  process.stdout.write(
    `\nFrolo ${FROLO_VERSION} is ready at http://${ip}:${PORT}\n` +
      `(LAN access only — put it behind an HTTPS reverse proxy for remote use)\n\n`,
  );

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\nReceived ${signal}, shutting down gracefully…\n`);
    try {
      await app.close();
      ctx.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

function firstLanIp(): string {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "localhost";
}

function lanOrigins(): string[] {
  const origins = ["localhost", "127.0.0.1"];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) origins.push(net.address);
    }
  }
  if (process.env.FROLO_ALLOWED_ORIGINS) {
    origins.push(...process.env.FROLO_ALLOWED_ORIGINS.split(",").map((s) => s.trim()));
  }
  return origins;
}

main().catch((err) => {
  process.stderr.write(`Frolo failed to start: ${err}\n`);
  process.exit(1);
});
