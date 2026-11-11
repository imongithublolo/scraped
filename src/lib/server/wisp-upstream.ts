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
import zlib from "node:zlib";
import { Duplex, PassThrough, type Readable } from "node:stream";
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

/** A finished wisp hop: plain-byte body + raw header pairs (already
 *  content-encoding-stripped when we decoded the body ourselves). */
export interface WispHop {
  status: number;
  statusText: string;
  rawHeaders: string[];
  body: Readable;
}

/** The decompressor for one upstream content-encoding, or null when the
 *  body is already plain bytes. zstd needs Node ≥ 24's zlib. */
function decompressorFor(encoding: string): ReturnType<typeof zlib.createGunzip> | null {
  const enc = encoding.trim().toLowerCase();
  if (enc === "gzip" || enc === "x-gzip") return zlib.createGunzip();
  if (enc === "deflate") return zlib.createInflate();
  if (enc === "br") return zlib.createBrotliDecompress();
  if (enc === "zstd" && typeof zlib.createZstdDecompress === "function") return zlib.createZstdDecompress();
  return null;
}

/**
 * Perform `args` over the wisp tunnel; resolves with the hop's status,
 * raw header pairs and a PLAIN-BYTE body — compressed upstream answers
 * are decoded here (the wire contract to the SW is always plain bytes
 * with content-encoding stripped) so the relay can advertise a real
 * browser accept-encoding instead of the bot-tell "identity".
 *
 * A wisp stream occasionally stalls before any response byte (the public
 * upstream's egress route blackholes a target for one stream, then serves
 * the next one fine). Since every rejection here happens BEFORE headers,
 * a single fresh-stream retry converts most of those stalls into hits —
 * the caller never sees the hiccup.
 */
export async function wispRequest(args: WispRequestArgs): Promise<WispHop> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // the retried stream gets a slightly longer leash — one more chance to
    // land before the ladder moves on to the other transport
    const attemptArgs = attempt === 0 ? args : { ...args, timeoutMs: Math.max(args.timeoutMs ?? 45_000, 24_000) };
    try {
      return await wispRequestOnce(attemptArgs, attempt === 0 ? 6_500 : undefined);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : "";
      if (/aborted/i.test(msg)) throw e; // the caller hung up — stop
      if (attempt === 0) continue;
    }
  }
  throw lastErr;
}

/** One shot over the tunnel. `headerDeadlineMs` (when given) rejects early
 *  if the upstream hasn't even sent headers — a stalled stream must not
 *  hold the browser for the full body budget. */
async function wispRequestOnce(args: WispRequestArgs, headerDeadlineMs?: number): Promise<WispHop> {
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

  return new Promise<WispHop>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const clearTimers = () => {
      clearTimeout(overallTimer);
      if (headerTimer) clearTimeout(headerTimer);
    };

    const overallTimer = setTimeout(() => {
      done(() => {
        ureq.destroy(new Error("wisp upstream timeout"));
        reject(new Error("wisp upstream timeout"));
      });
    }, timeoutMs);

    // headers-must-arrive leash — a stalled stream fails fast here and the
    // wrapper's fresh-stream retry takes over
    const headerTimer = headerDeadlineMs
      ? setTimeout(() => {
          done(() => {
            clearTimers();
            ureq.destroy(new Error("wisp upstream header timeout"));
            reject(new Error("wisp upstream header timeout"));
          });
        }, headerDeadlineMs)
      : null;

    const onAbort = () => {
      done(() => {
        clearTimers();
        ureq.destroy(new Error("client aborted"));
        reject(new Error("client aborted"));
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    ureq.on("response", (res) => {
      if (headerTimer) clearTimeout(headerTimer);
      signal?.removeEventListener("abort", onAbort);
      done(() => {
        // decode compressed bodies HERE — the relay hands plain bytes on
        const pairs = (res.rawHeaders as unknown as string[]).slice();
        const encIdx = pairs.findIndex((v, i) => i % 2 === 0 && v.toLowerCase() === "content-encoding");
        const enc = encIdx >= 0 ? (pairs[encIdx + 1] ?? "") : "";
        const dec = decompressorFor(enc);
        const noBody = res.statusCode === 204 || res.statusCode === 304 || method === "HEAD";
        if (!dec || noBody) {
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            rawHeaders: encIdx >= 0 && dec ? pairs.filter((_, i) => i !== encIdx && i !== encIdx + 1) : pairs,
            body: res,
          });
          return;
        }
        // spill the compressed bytes through the decompressor — on a
        // mid-stream decode error the body errors (the ladder retries)
        const body = res.pipe(dec as unknown as NodeJS.ReadWriteStream) as unknown as Readable;
        pairs.splice(encIdx, 2);
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          rawHeaders: pairs,
          body,
        });
      });
    });
    ureq.on("error", (e) => {
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      done(() => reject(e));
    });
    socket.on("error", (e) => {
      done(() => {
        clearTimers();
        ureq.destroy(e);
        reject(e instanceof Error ? e : new Error("wisp tunnel error"));
      });
    });

    if (body && body.length > 0) ureq.end(body);
    else ureq.end();
  });
}
