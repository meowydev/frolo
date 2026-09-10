// Server-Sent Events endpoint for live deployment events (req: replace Electron
// IPC live events with WebSocket or SSE). Authenticated; each connected client
// gets sanitized controller events streamed as they occur.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "./context.js";
import { requireAuth } from "./security.js";

export function registerEventStream(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/events", { preHandler: requireAuth }, (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`event: hello\ndata: {"ok":true}\n\n`);

    const unsubscribe = ctx.controller.subscribe((e) => {
      try {
        reply.raw.write(`event: frolo\ndata: ${JSON.stringify(e)}\n\n`);
      } catch {
        /* client went away */
      }
    });

    // Heartbeat so proxies keep the connection open.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`event: ping\ndata: {}\n\n`);
      } catch {
        /* ignore */
      }
    }, 25_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
