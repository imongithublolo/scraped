import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { NextRequest } from "next/server";
import {
  blockedTarget,
  browserHeaders,
  faultHtml,
  fetchEgress,
  isDowngradeHost,
  looksLikeBotWall,
  sameOriginOk,
  UA,
} from "@/lib/server/egress";
import { wispRequest } from "@/lib/server/wisp-upstream";

/**
 * THE PROXY RELAY — rebuilt from the ground up.
 *
 * Scramjet's service worker hands every proxied request to a baremux
 * transport. The httpx transport POSTs HERE; this route performs the real
 * upstream request from the server's egress and streams the bytes back.
 * The wire protocol is the transport's contract and does not change:
 *
 *   request   x-relay-target / x-relay-method / x-relay-h-<name> headers,
 *             body streamed through untouched
 *   response  x-relay-meta {status,statusText}, x-relay-rh-<name> headers,
 *             set-cookie forwarded natively, body untouched
 *   GET /     health probe (the client's status check runs a REAL forward
 *             through this endpoint before trusting it)
 *
 * Upstream strategy, in order:
 *   1. direct fetch from this server's egress (undici, IPv4-pinned),
 *      following redirects server-side with a per-host cookie jar —
 *      many anti-bot flows are exactly 301 → set-cookie → refetch → page.
 *   2. when that is refused/blocked (datacenter ranges get challenged),
 *      the same request tunnels through a wisp upstream whose egress is
 *      a residential-grade pipe (see wisp-upstream.ts).
 *
 * Challenge pages and downgrade redirects are treated as walls, not
 * content: the route serves the PROXY FAULT page, whose postMessage makes
 * the browser chrome revalidate its transport. The user sees a blink.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Hop-by-hop + local-only headers never forwarded upstream. */
const STRIP_UPSTREAM = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 6;

export async function GET() {
  return Response.json({ ok: true, relay: "egress+visp", ts: Date.now() });
}

/* ------------------------------------------------------------------ */
/* request assembly                                                    */
/* ------------------------------------------------------------------ */

interface UpstreamRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  signal: AbortSignal;
}

/** Build the sanitized upstream header set from the transport's envelope. */
function upstreamHeaders(req: NextRequest, url: URL): Record<string, string> {
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    if (k.startsWith("x-relay-h-")) {
      const name = k.slice(10);
      headers[name] = headers[name] ? headers[name] + ", " + v : v;
    }
  });
  headers["host"] = url.host;
  // a headless/automation UA is an instant anomaly flag — normalize
  if (!headers["user-agent"] || /headless/i.test(headers["user-agent"])) headers["user-agent"] = UA;
  if (!headers["accept-language"]) headers["accept-language"] = "en-US,en;q=0.9";
  // plain bytes only: the SW hands the body to the page untouched
  headers["accept-encoding"] = "identity";
  for (const name of Object.keys(headers)) {
    if (STRIP_UPSTREAM.has(name)) delete headers[name];
  }
  // stale cookies minted on a DIFFERENT egress IP are exactly what
  // anti-bot layers flag — the redirect follower keeps its own jar
  delete headers["cookie"];
  // browser-context headers (sec-*, priority, x-scramjet) are wrong or
  // telltale coming from a server fetch
  for (const name of Object.keys(headers)) {
    if (name.startsWith("sec-") || name === "priority" || name.startsWith("x-scramjet")) delete headers[name];
  }
  return browserHeaders(headers);
}

/** Read the (bounded) request body — the direct + wisp attempts share it. */
async function readBodyCapped(req: NextRequest, cap = 8_000_000): Promise<Buffer | null> {
  if (!req.body) return null;
  const reader = Readable.fromWeb(req.body as unknown as import("node:stream/web").ReadableStream);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of reader) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > cap) {
      chunks.push(buf.subarray(0, buf.length - (total - cap)));
      return Buffer.concat(chunks);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ */
/* the two upstream hops                                               */
/* ------------------------------------------------------------------ */

/** Hop 1 — undici fetch from this server's egress (IPv4 pinned, short
 *  deadline so a walled hop falls through to the wisp attempt quickly). */
async function directFetch(r: UpstreamRequest): Promise<Awaited<ReturnType<typeof fetchEgress>>> {
  const headers: Record<string, string> = { ...r.headers };
  delete headers["content-length"];
  return fetchEgress(
    r.url.toString(),
    {
      method: r.method,
      headers,
      body: r.body && r.body.length > 0 ? new Uint8Array(r.body) : undefined,
      redirect: "manual",
      signal: r.signal,
    },
    16_000,
  );
}

/** Hop 2 — same request through the wisp tunnel (real-world egress). */
async function wispFetch(r: UpstreamRequest): Promise<IncomingMessage> {
  const headers: Record<string, string> = { ...r.headers };
  delete headers["content-length"];
  const res = await wispRequest({ url: r.url, method: r.method, headers, body: r.body, signal: r.signal });
  return res;
}

/* ------------------------------------------------------------------ */
/* redirect following (server-side, per-host cookie jar)               */
/* ------------------------------------------------------------------ */

interface FollowResult {
  status: number;
  headers: Headers;
  body: ReadableStream | Buffer | null;
  finalUrl: URL;
  via: "direct" | "wisp";
}

/* undici hands back node-stream-web ReadableStream types — same bytes,
   different type hole; one cast at the boundary keeps the pipeline honest */
type WebBody = import("stream/web").ReadableStream;
const toWebBody = (s: WebBody | null): ReadableStream | null => (s ? (s as unknown as ReadableStream) : null);

/**
 * Normalize any response header shape (undici Headers / DOM Headers /
 * RawHeaders) into one real Headers. instanceof is USELESS here: the npm
 * undici class and node's global Headers are different class objects.
 */
function normalize(h: RawHeaders | Headers): Headers {
  if (h instanceof RawHeaders) return h.toHeaders();
  const out = new Headers();
  (h as unknown as Headers).forEach((value, name) => {
    const n = name.toLowerCase();
    if (n === "content-encoding") return; // bodies are plain bytes
    if (n === "set-cookie") out.append("set-cookie", value);
    else out.set(n, value);
  });
  return out;
}

/** set-cookie values out of a normalized Headers. */
function collectSetCookies(h: Headers): string[] {
  try {
    return (h as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  } catch {
    return [];
  }
}

/**
 * Follow the redirect chain on one transport with a per-host cookie jar.
 * Throws a labeled Error when a hop is a bot-wall / downgrade.
 */
async function followRedirects(
  start: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  signal: AbortSignal,
  via: "direct" | "wisp",
): Promise<FollowResult> {
  let url = start;
  let m = method;
  let b = body;
  const jar = new Map<string, Map<string, string>>();

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const h = { ...headers };
    const jarForHost = jar.get(url.hostname);
    if (jarForHost && jarForHost.size > 0) {
      h["cookie"] = [...jarForHost.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }

    const req: UpstreamRequest = { url, method: m, headers: h, body: b, signal };
    let status: number;
    let resHeaders: Headers; // always normalized before use (see normalize)
    let resBody: ReadableStream | null;

    if (via === "direct") {
      const res = await directFetch(req);
      status = res.status;
      resHeaders = normalize(res.headers as unknown as RawHeaders | Headers);
      resBody = toWebBody(res.body as WebBody | null);
    } else {
      const res = await wispFetch(req);
      status = res.statusCode ?? 0;
      resHeaders = normalize(new RawHeaders(res.rawHeaders));
      resBody = status === 204 || status === 304 ? null : toWebBody(Readable.toWeb(res) as unknown as WebBody);
    }

    if (!REDIRECT_STATUSES.has(status)) {
      // final hop — sniff html bodies of challenge-sized responses
      const ct = resHeaders.get("content-type") ?? "";
      if ([403, 429, 503, 202].includes(status) && ct.toLowerCase().includes("text/html") && resBody) {
        const text = await readStreamCapped(resBody, 2_000_000);
        const hit = looksLikeBotWall(status, ct, text);
        if (hit) throw new Error("upstream bot-wall: " + hit);
        return { status, headers: resHeaders, body: Buffer.from(text, "utf8"), finalUrl: url, via };
      }
      return { status, headers: resHeaders, body: resBody, finalUrl: url, via };
    }

    // redirect hop: harvest cookies, resolve location, decide
    const setCookies = collectSetCookies(resHeaders);
    const ck = jar.get(url.hostname) ?? new Map<string, string>();
    for (const sc of setCookies) {
      const pair = sc.split(";")[0] ?? "";
      const idx = pair.indexOf("=");
      if (idx > 0) ck.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
    jar.set(url.hostname, ck);

    const loc = resHeaders.get("location") || undefined;
    if (!loc) {
      // degenerate redirect (no location) — surface it as the final answer;
      // the caller guards against handing scramjet a 3xx without location
      return { status, headers: resHeaders, body: resBody, finalUrl: url, via };
    }
    const next = new URL(loc, url);
    if (resBody) void drainStream(resBody);

    // a bounce onto the no-JS mirror = we were soft-blocked (only when we
    // STARTED from the main host — fetching lite.ddg directly is legitimate)
    if (via === "direct" && hop === 0 && isDowngradeHost(next) && !isDowngradeHost(start)) {
      throw new Error("upstream bot-wall: downgrade redirect");
    }

    if ((status === 303 || (status === 301 && m === "POST")) && m !== "HEAD") {
      m = "GET";
      b = null;
    }
    url = next;
  }
  throw new Error("too many redirects");
}

/** Minimal multi-value header map over rawIncomingHeaders pairs. */
class RawHeaders {
  private map = new Map<string, string[]>();
  constructor(pairs: string[]) {
    for (let i = 0; i < pairs.length; i += 2) {
      const name = pairs[i].toLowerCase();
      const value = pairs[i + 1] ?? "";
      const list = this.map.get(name) ?? [];
      list.push(value);
      this.map.set(name, list);
    }
  }
  get(name: string): string {
    return this.map.get(name.toLowerCase())?.[0] ?? "";
  }
  all(name: string): string[] {
    return this.map.get(name.toLowerCase()) ?? [];
  }
  toHeaders(): Headers {
    const out = new Headers();
    for (const [name, values] of this.map) {
      if (name === "content-encoding") continue; // bodies are plain bytes
      if (name === "set-cookie") for (const v of values) out.append("set-cookie", v);
      else out.set(name, values.join(", "));
    }
    return out;
  }
}

async function readStreamCapped(stream: ReadableStream, cap: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= cap) break;
      }
    }
  } catch {
    /* best effort */
  }
  if (total < cap) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c.subarray(0, Math.min(c.byteLength, total - off)), off);
    off += c.byteLength;
    if (off >= total) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

async function drainStream(stream: ReadableStream): Promise<void> {
  try {
    await stream.cancel();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* response framing (the transport's wire contract)                    */
/* ------------------------------------------------------------------ */

function relayHeaders(status: number, statusText: string, headers: Headers): Headers {
  const out = new Headers();
  out.set("x-relay-meta", JSON.stringify({ status, statusText }));
  out.set("Cache-Control", "no-store");
  headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (n === "set-cookie") out.append("set-cookie", value);
    else if (n === "content-encoding") return;
    else out.append("x-relay-rh-" + n, value);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* route                                                               */
/* ------------------------------------------------------------------ */

export async function POST(req: NextRequest) {
  const origin = sameOriginOk(req);
  if (!origin.ok) return Response.json({ ok: false, error: origin.error }, { status: 403 });

  const targetRaw = (req.headers.get("x-relay-target") ?? "").trim();
  const method = (req.headers.get("x-relay-method") ?? "GET").toUpperCase();
  if (!/^https?:\/\//i.test(targetRaw)) {
    return Response.json({ ok: false, error: "missing x-relay-target" }, { status: 400 });
  }
  let url: URL;
  try {
    url = new URL(targetRaw);
  } catch {
    return Response.json({ ok: false, error: "bad target url" }, { status: 400 });
  }
  if (blockedTarget(url)) {
    return Response.json({ ok: false, error: "blocked target" }, { status: 403 });
  }

  const headers = upstreamHeaders(req, url);
  const body = await readBodyCapped(req);

  /* attempt 1 — direct egress; attempt 2 — wisp tunnel on any wall/failure */
  let result: FollowResult | null = null;
  let failure: Error | null = null;
  try {
    result = await followRedirects(url, method, headers, body, req.signal, "direct");
  } catch (e) {
    failure = e instanceof Error ? e : new Error("relay failed");
  }

  if (!result) {
    try {
      result = await followRedirects(url, method, headers, body, req.signal, "wisp");
      failure = null;
    } catch (e) {
      failure = failure ?? (e instanceof Error ? e : new Error("relay failed"));
    }
  }

  if (!result) {
    const msg = failure?.message ?? "relay failed";
    if (msg.startsWith("upstream bot-wall")) {
      const host = url.hostname || "site";
      return new Response(
        faultHtml(
          msg + "\nboth the relay egress and the wisp fallback were challenged (" + host + ")",
          targetRaw,
        ),
        { status: 502, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "x-relay-fault": "bot-wall" } },
      );
    }
    return Response.json({ ok: false, error: msg }, { status: 502 });
  }

  /* never hand scramjet a 3xx without a usable Location — its redirect
     decoder explodes on a missing header (the every-website-broken crash) */
  if (result.status >= 300 && result.status < 400) {
    const loc = result.headers.get("location");
    const usable = typeof loc === "string" && loc.length > 0 && (() => { try { new URL(loc, result!.finalUrl); return true; } catch { return false; } })();
    if (!usable) {
      return new Response(
        faultHtml("upstream answered " + result.status + " with no redirect target (" + url.hostname + ")", targetRaw),
        { status: 502, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
      );
    }
  }

  const statusText = result.status === 200 ? "OK" : "";
  const respBody: BodyInit | null =
    result.body instanceof Buffer ? new Uint8Array(result.body) : (result.body as BodyInit | null);
  return new Response(respBody, {
    status: result.status,
    headers: relayHeaders(result.status, statusText, result.headers),
  });
}
