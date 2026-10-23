#!/usr/bin/env node
/**
 * DAEMON wisp relay — standalone proxy backend.
 *
 * Scramjet (client-side, vendored into the Next.js app) tunnels all of its
 * HTTP(S) traffic through this server using the Wisp websocket protocol.
 * Vercel cannot host persistent websockets, so this ships as a separate
 * service: deploy it to Railway / Render / Fly.io / any VPS, then point the
 * frontend at it (`proxy wisp wss://<host>/wisp/` or public/config.js).
 *
 *   node index.mjs                 # PORT=3031 HOST=0.0.0.0 by default
 *   WISP_UDP=1 node index.mjs      # also allow UDP streams (QUIC/HTTP3)
 *
 * Health check: GET /health
 */

import http from "node:http";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const PORT = parseInt(process.env.PORT || "3031", 10);
const HOST = process.env.HOST || "0.0.0.0";

logging.set_level(process.env.WISP_LOG ? logging[process.env.WISP_LOG] : logging.INFO);

/* ------------------------------------------------------------------ *
 * Race fix (upstream bug): AsyncQueue.close() wipes queued-but-
 * unconsumed data. When a remote server answers fast and half-closes
 * (very common for plain HTTP), the socket `data` + `end` + `close`
 * events can batch before the consumer task resumes — the response
 * was destroyed and every stream died with close reason 2 (Voluntary).
 *
 * We can't import AsyncQueue (not exported), but ServerStream is, so
 * we harden the live queue instances at stream setup time: close()
 * must only wake waiters, and get() must drain remaining data before
 * reporting EOF. Works under bun and node alike.
 * ------------------------------------------------------------------ */
function hardenQueue(q) {
  if (!q || q.__daemon_harden) return;
  q.__daemon_harden = true;
  let closed = false;

  const origClose = q.close.bind(q);
  q.close = function () {
    closed = true;
    let cb;
    // wake all waiters — but never destroy queued data
    while ((cb = q.get_callbacks.shift())) cb();
    while ((cb = q.put_callbacks.shift())) cb();
    void origClose;
  };

  q.get = async function () {
    if (q.size > 0) return q.get_now();
    if (closed) return null; // EOF only once the queue is truly drained
    await new Promise((resolve) => q.get_callbacks.push(resolve));
    return q.get_now();
  };
}

const ServerStream = wisp.ServerStream;
if (ServerStream && ServerStream.prototype) {
  const origSetup = ServerStream.prototype.setup;
  ServerStream.prototype.setup = async function () {
    if (this.socket) hardenQueue(this.socket.data_queue);
    hardenQueue(this.send_buffer);
    return origSetup.call(this);
  };
}

Object.assign(wisp.options, {
  allow_udp_streams: process.env.WISP_UDP === "1",
  allow_tcp_streams: true,
  // block access to private network ranges from client sessions
  allow_private_ips: process.env.WISP_ALLOW_PRIVATE === "1",
  allow_loopback_ips: process.env.WISP_ALLOW_LOOPBACK === "1",
  dns_method: "lookup",
  // prefer IPv4 — many sandboxed/container hosts advertise broken IPv6 routes
  dns_result_order: process.env.WISP_DNS_ORDER || "ipv4first",
  dns_servers: (process.env.WISP_DNS || "1.1.1.3,1.0.0.3").split(",").map((s) => s.trim()),
  // optional: hostname_blacklist: [/\.gov$/, /\.mil$/],
});

const startedAt = Date.now();

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(
      JSON.stringify({
        ok: true,
        service: "daemon-wisp-relay",
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        udp: process.env.WISP_UDP === "1",
      })
    );
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("daemon wisp relay — websockets speak here (/wisp/)\n");
});

httpServer.on("upgrade", (req, socket, head) => {
  // Normalize the upgrade path: query strings (e.g. gateway port hints like
  // ?XTransformPort=3031) must not leak into the wisp path check, which
  // decides between the wisp protocol (trailing slash) and wsproxy mode.
  try {
    req.url = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    /* keep raw url */
  }
  // route every websocket upgrade to the wisp handler
  wisp.routeRequest(req, socket, head);
});

httpServer.on("clientError", (_err, socket) => {
  try {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } catch {
    /* ignore */
  }
});

httpServer.listen(PORT, HOST, () => {
  logging.info(`daemon wisp relay listening on ${HOST}:${PORT} (path: any — typically /wisp/)`);
});
