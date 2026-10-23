/**
 * WISP UPSTREAM for the proxy relay — server-only.
 *
 * The same-origin relay (/api/relay) normally forwards upstream over a
 * plain socket FROM THIS SERVER's egress. On serverless hosts (Vercel)
 * that egress is a datacenter range the big sites bot-wall: duckduckgo
 * 202s, google captchas, CDNs challenge. This module gives the relay a
 * second hop: it opens a WISP websocket to a public wisp server
 * (mercury workshop by default) whose EGRESS does the real fetching,
 * and rides a raw TCP stream through it — TLS terminated END-TO-END
 * between this function and the target (wisp only forwards bytes).
 *
 * Implementation: a wisp ClientStream wrapped in a node Duplex; for
 * https the Duplex feeds tls.connect() so node's http client speaks
 * HTTP/1.1 over the tunnel exactly like it does over a real socket.
 *
 * The connection is a lazily-created singleton per serverless instance:
 * one websocket handshake, then every request multiplexes a new stream
 * over it (that is also why this path is FASTER than a fresh direct
 * request after the first hit).
 */
import { client as wispClient } from "@mercuryworkshop/wisp-js/client";
import tls from "node:tls";
import http from "node:http";
import { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";

export const WISP_UPSTREAM_URL = process.env.RELAY_WISP_UPSTREAM || "wss://wisp.mercurywork.shop/";

type Conn = InstanceType<typeof wispClient.ClientConnection>;
type Stream = InstanceType<typeof wispClient.ClientConnection>["create_stream"] extends (...args: never[]) => infer R ? R : never;

let conn: Conn | null = null;
let connecting: Promise<Conn> | null = null;

/** Live wisp connection (rebuilt transparently when the socket dies). */
async function getConnection(): Promise<Conn> {
  if (conn) return conn;
  if (connecting) return connecting;
  connecting = new Promise<Conn>((resolve, reject) => {
    const c = new wispClient.ClientConnection(WISP_UPSTREAM_URL);
    const timer = setTimeout(() => {
      connecting = null;
      try {
        c.close();
      } catch {
        /* ignore */
      }
      reject(new Error("wisp upstream connect timeout"));
    }, 9000);
    c.onopen = () => {
      clearTimeout(timer);
      conn = c;
      connecting = null;
      resolve(c);
    };
    c.onerror = () => {
      clearTimeout(timer);
      if (conn === c) conn = null;
      connecting = null;
      reject(new Error("wisp upstream refused the socket"));
    };
    c.onclose = () => {
      if (conn === c) conn = null;
    };
  });
  return connecting;
}

/** Wrap a wisp ClientStream as a node Duplex socket. */
function streamToDuplex(stream: Stream): Duplex {
  const queue: Buffer[] = [];
  let ended = false;
  let waiting: ((err: Error | null, chunk?: Buffer) => void) | null = null;

  stream.onmessage = (data: Uint8Array | ArrayBuffer) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(null, buf);
    } else {
      queue.push(buf);
    }
  };
  stream.onclose = () => {
    ended = true;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(null);
    }
  };

  return new Duplex({
    read() {
      if (queue.length > 0) this.push(queue.shift());
      else if (ended) this.push(null);
      else
        waiting = (err, chunk) => {
          if (err) this.destroy(err);
          else this.push(chunk ?? null);
        };
    },
    write(chunk, _enc, cb) {
      try {
        stream.send(Buffer.from(chunk as Uint8Array));
        cb();
      } catch (e) {
        cb(e instanceof Error ? e : new Error("wisp stream send failed"));
      }
    },
    final(cb) {
      try {
        stream.close(0x01);
      } catch {
        /* ignore */
      }
      cb();
    },
    destroy(_err, cb) {
      try {
        stream.close(0x01);
      } catch {
        /* ignore */
      }
      cb();
    },
  });
}

export interface WispRequestArgs {
  url: URL;
  method: string;
  headers: Record<string, string>;
  /** Buffered request body (GET/HEAD → null). */
  body: Buffer | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Perform `args` over the wisp tunnel; resolves with the node
 * IncomingMessage (status, rawHeaders, streaming body) — the exact same
 * shape the direct path produces.
 */
export async function wispRequest(args: WispRequestArgs): Promise<IncomingMessage> {
  const { url, method, headers, body, timeoutMs = 45_000, signal } = args;
  const connection = await getConnection();

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const stream = connection.create_stream(url.hostname, port, "tcp");
  const duplex = streamToDuplex(stream);

  const socket =
    url.protocol === "https:"
      ? tls.connect({ socket: duplex, servername: url.hostname, rejectUnauthorized: true })
      : duplex;

  /* the wisp server grants the buffer (CONTINUE) asynchronously — the
     ClientStream buffers writes until then, so writing immediately is safe.
     For https targets the socket is ALREADY the TLS tunnel, so node's plain
     http client speaks HTTP/1.1 over it (the url is presented as http:). */
  const requestUrl =
    url.protocol === "https:" ? new URL("http://" + url.host + url.pathname + url.search) : url;
  const ureq = http.request(requestUrl, {
    method,
    headers,
    createConnection: () => socket,
    agent: false,
  });

  return new Promise<IncomingMessage>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      done(() => {
        ureq.destroy(new Error("wisp upstream timeout"));
        reject(new Error("wisp upstream timeout"));
      });
    }, timeoutMs);

    const onAbort = () => {
      done(() => {
        clearTimeout(timer);
        ureq.destroy(new Error("client aborted"));
        reject(new Error("client aborted"));
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    ureq.on("response", (res) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      done(() => resolve(res));
    });
    ureq.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      done(() => reject(e));
    });
    socket.on("error", (e) => {
      done(() => {
        clearTimeout(timer);
        ureq.destroy(e);
        reject(e instanceof Error ? e : new Error("wisp tunnel error"));
      });
    });

    if (body && body.length > 0) ureq.end(body);
    else ureq.end();
  });
}
