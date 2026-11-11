import { Readable } from "node:stream";
import http2 from "node:http2";
import zlib from "node:zlib";
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import {
  blockedTarget,
  browserHeaders,
  DowngradeError,
  faultHtml,
  fetchEgress,
  isDowngradeHost,
  looksLikeBotWall,
  sameOriginOk,
  UA,
} from "@/lib/server/egress";
import { wispRequest, type WispHop } from "@/lib/server/wisp-upstream";

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
 *   1. HTTP/2 fetch from this server's egress (node:http2, h2 with proper
 *      pseudo-headers) — Cloudflare & co. fingerprint undici's HTTP/1.1
 *      shape and answer a managed challenge to it, while the SAME request
 *      over h2 sails through (proven on slowroads.io: h1 403 "Just a
 *      moment…", h2 200). Falls back to undici when h2 is not viable.
 *   2. undici fetch (HTTP/1.1, IPv4-pinned), following redirects
 *      server-side with a per-host cookie jar — many anti-bot flows are
 *      exactly 301 → set-cookie → refetch → page.
 *   3. when that is refused/blocked (datacenter ranges get challenged),
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

/* ------------------------------------------------------------------ */
/* per-host transport routing — the speed fix                          */
/* ------------------------------------------------------------------ */

/** hosts learned to need one transport keep using it: a datacenter-walled
 *    image CDN answers its 403 challenge once, and every other image on
 *    the page rides the wisp pipe straight away — no failed direct hop
 *    per asset. TTL'd so a host can re-earn its route. */
interface Route {
  via: "direct" | "wisp";
  at: number;
}
const ROUTES = new Map<string, Route>();
const ROUTE_TTL = 10 * 60_000;

/** hosts that wall datacenter egress on principle — the relay never pays
 *    their direct-hop tax, not even on a cold boot. googleusercontent
 *    (photos/avatars behind google results) 403s anything that isn't a
 *    residential-looking hit. (duckduckgo used to live here too, but the
 *    public wisp egress is now DDG-walled with a cookieless 301-to-self
 *    loop — seeding it wisp-first only ever bought the loop tax, so DDG
 *    rides the natural direct-first order + loop detection instead.) */
const SEED_WISP_SUFFIXES = ["googleusercontent.com"];

function routeFor(host: string): Route | null {
  const r = ROUTES.get(host);
  if (r) {
    if (Date.now() - r.at > ROUTE_TTL) {
      ROUTES.delete(host);
    } else {
      return r;
    }
  }
  const h = host.toLowerCase();
  for (const seed of SEED_WISP_SUFFIXES) {
    if (h === seed || h.endsWith("." + seed)) return { via: "wisp", at: Infinity };
  }
  return null;
}

function rememberRoute(host: string, via: "direct" | "wisp"): void {
  const prev = ROUTES.get(host);
  ROUTES.set(
    host,
    prev && prev.via === via ? { ...prev, at: Date.now() } : { via, at: Date.now() },
  );
  trimRoutes();
}

function trimRoutes(): void {
  // the map is tiny (hosts, not urls) — trim ancient entries opportunistically
  if (ROUTES.size > 512) {
    const now = Date.now();
    for (const [h, r] of ROUTES) if (now - r.at > ROUTE_TTL) ROUTES.delete(h);
  }
}

/* ------------------------------------------------------------------ */
/* the relay's own cookie jar — server-side, per host, per transport    */
/* ------------------------------------------------------------------ */

/** Scramjet's browser-side cookie store drops Secure cookies on http
 *    origins and hands back cookies minted on other egress IPs — sessions
 *    never stick and google's JS bounce-loops on its own sg_ss. The jar
 *    keeps every cookie on the pipe that minted it: same host, same
 *    transport, sent on every non-media request. This is what makes
 *    sessions (and logins) actually survive the proxy. */
interface JarCookie {
  value: string;
  via: "direct" | "wisp";
  at: number;
}
const JAR = new Map<string, Map<string, JarCookie>>();
const JAR_TTL = 6 * 60 * 60_000;

/** cookies that must never ride a request even if a response offered them:
 *    none today — kept as the hook for future poison lists. */
const POISON_COOKIES = new Set<string>([]);

/** hosts the jar refuses: google's anon session state is exactly what its
 *    anomaly score keys on — a cookie-bearing client that re-navigates sei
 *    tokens gets sorried, while the same url cookieless answers clean.
 *    Search reliability wins over google session persistence. */
function jarSkipped(host: string): boolean {
  const h = host.toLowerCase();
  return h === "google.com" || h.endsWith(".google.com");
}

/** the cookie header for this host on this transport (null = none) */
function jarCookieHeader(host: string, via: "direct" | "wisp"): string | null {
  if (jarSkipped(host)) return null;
  const jar = JAR.get(host);
  if (!jar || jar.size === 0) return null;
  const now = Date.now();
  const parts: string[] = [];
  for (const [name, c] of jar) {
    if (POISON_COOKIES.has(name.toLowerCase())) {
      jar.delete(name);
      continue;
    }
    if (now - c.at > JAR_TTL) {
      jar.delete(name);
      continue;
    }
    if (c.via !== via) continue;
    parts.push(`${name}=${c.value}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** harvest a response's set-cookies into the jar under their minting pipe */
function jarAbsorb(host: string, via: "direct" | "wisp", headers: Headers): void {
  if (jarSkipped(host)) return;
  const sc = collectSetCookies(headers);
  if (sc.length === 0) return;
  const jar = JAR.get(host) ?? new Map<string, JarCookie>();
  for (const cookie of sc) {
    const pair = cookie.split(";")[0] ?? "";
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (POISON_COOKIES.has(name.toLowerCase())) continue; // never store the flag
    if (!value) {
      jar.delete(name); // cleared server-side
      continue;
    }
    jar.set(name, { value, via, at: Date.now() });
  }
  JAR.set(host, jar);
  if (JAR.size > 300) {
    const now = Date.now();
    for (const [h, jar2] of JAR) {
      let alive = false;
      for (const c of jar2.values()) {
        if (now - c.at <= JAR_TTL) {
          alive = true;
          break;
        }
      }
      if (!alive) JAR.delete(h);
    }
  }
}

/** media-ish targets — the requests whose 403/429 answers mean "wrong
 *    egress", not "gone": hotlink-walled CDNs gate by IP+referer while the
 *    asset itself is fine. These earn a wisp retry before giving up. */
function isMediaish(url: URL, accept: string): boolean {
  if (/^image\//i.test(accept.trim())) return true;
  return /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp|woff2?|ttf|otf|mp4|webm|m3u8)(\?|$)/i.test(url.pathname);
}

export async function GET() {
  return Response.json({ ok: true, relay: "egress+visp", ts: Date.now() });
}

/* ------------------------------------------------------------------ */
/* server-side asset cache — the repeat-view speed win                 */
/* ------------------------------------------------------------------ */

/** Content types worth holding in memory: images, fonts, media, styles
 *  and scripts — the long-tail assets every page re-requests on every
 *  view. Documents, xhr and JSON stay uncached (personalized). */
const CACHEABLE_CT =
  /^(?:image\/|font\/|video\/|audio\/|text\/css(?:;|$)|application\/javascript(?:;|$)|text\/javascript(?:;|$)|application\/font-woff)/i;

/** css/js GETs are cache candidates too — no accept hint, but the
 *  extension says so. */
const CSS_JS_EXT = /\.(?:css|js|mjs)(?:\?|$)/i;

const CACHE_BODY_CAP = 8_000_000; // per-entry body cap
const CACHE_MAX_BYTES = 64_000_000; // whole-cache byte budget
const CACHE_DEFAULT_TTL = 10 * 60_000; // upstream silent → 10 min
const CACHE_MAX_TTL = 24 * 60 * 60_000; // ceiling on upstream max-age

interface CacheEntry {
  body: Buffer;
  status: number;
  statusText: string;
  /** normalized upstream headers — relayHeaders re-derives the wire set */
  headers: Headers;
  expires: number;
  bytes: number;
}

/** insertion-ordered Map = a free LRU (touch = delete + re-set) */
const CACHE = new Map<string, CacheEntry>();
let cacheBytes = 0;

/** one upstream fetch per cacheable url while it is in flight — a burst
 *  of duplicate requests awaits a single shared fetch. */
const INFLIGHT = new Map<string, Promise<AttemptOutcome>>();

function cacheGet(key: string): CacheEntry | null {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) {
    CACHE.delete(key);
    cacheBytes -= e.bytes;
    return null;
  }
  CACHE.delete(key);
  CACHE.set(key, e); // LRU touch
  return e;
}

function cachePut(key: string, e: CacheEntry): void {
  const prev = CACHE.get(key);
  if (prev) cacheBytes -= prev.bytes;
  CACHE.set(key, e);
  cacheBytes += e.bytes;
  // trim oldest-first until the budget holds
  while (cacheBytes > CACHE_MAX_BYTES) {
    const oldest = CACHE.keys().next().value;
    if (oldest === undefined) break;
    const v = CACHE.get(oldest);
    CACHE.delete(oldest);
    if (!v) break;
    cacheBytes -= v.bytes;
  }
  if (cacheBytes < 0) cacheBytes = 0;
}

/** Upstream cache-control → server-cache TTL, or null when the upstream
 *  forbids caching (no-store / no-cache / private / max-age=0). */
function upstreamCacheTtl(cc: string): number | null {
  const directives = cc
    .toLowerCase()
    .split(",")
    .map((d) => d.split("=")[0].trim());
  if (directives.some((d) => d === "no-store" || d === "no-cache" || d === "private")) return null;
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cc);
  const secs = m ? Number(m[1]) : null;
  if (secs !== null && secs <= 0) return null;
  return Math.min(secs !== null ? secs * 1000 : CACHE_DEFAULT_TTL, CACHE_MAX_TTL);
}

/** Downstream cache-control for cacheable assets: upstream max-age
 *  capped at a day, 1h when upstream is silent. Documents keep no-store. */
function downstreamCacheControl(cc: string): string {
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cc);
  const secs = Math.min(m ? Number(m[1]) : 3600, 86_400);
  return `public, max-age=${secs}`;
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
function upstreamHeaders(req: NextRequest, url: URL, method: string): { headers: Record<string, string>; media: boolean } {
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
  for (const name of Object.keys(headers)) {
    if (STRIP_UPSTREAM.has(name)) delete headers[name];
  }
  // the transport already stripped content-encoding handling from its side;
  // compression is negotiated fresh below (undici + wisp both decode)
  delete headers["accept-encoding"];
  // real browsers send NO Origin on a GET navigation — the transport's
  // rewritten one (the target's own origin) is a fabrication upstream
  if (method === "GET" || method === "HEAD") delete headers["origin"];
  const media = isMediaish(url, headers["accept"] ?? "");
  // media rides clean: no cookies (CDN cookies minted on another egress IP
  // are an anomaly flag), referer repaired below. Documents and xhr keep
  // their cookies — session-gated sites need them.
  if (media) delete headers["cookie"];
  // the transport's sec-fetch-* headers describe OUR origin's frame, not a
  // plausible direct hit on the target — same-origin claims with no matching
  // cookie story are exactly what google's anomaly score hates. Stripped:
  // the proven-good request shape is gzip + UA + accept, nothing clever.
  for (const name of Object.keys(headers)) {
    if (
      name === "priority" ||
      name.startsWith("x-scramjet") ||
      name.startsWith("sec-")
    ) {
      delete headers[name];
    }
  }
  // upgrade-insecure-requests is a navigation-only header — a real browser
  // never sends it on an image or an xhr
  if (!/^text\/html/.test(headers["accept"] ?? "")) delete headers["upgrade-insecure-requests"];
  fixReferer(headers, url);
  return { headers: browserHeaders(headers), media };
}

/**
 * Referer repair — the silent image killer. Scramjet hands subresource
 * requests a referer pointing at OUR origin (/scramjet/<encoded page>),
 * and hotlink-protected image CDNs answer every one of those with 403
 * (or a 1px GIF). A real browser would send the real page's url: decode
 * the proxied page back out and present that. Media with no referer at
 * all gets the target's own origin — the second-most-plausible sender.
 * And a referer that decodes to nothing but our own shell (the frost
 * home, the omnibox — an address-bar navigation) is DELETED outright:
 * real browsers send no referer at all when you type a url, and google's
 * anti-bot walls a foreign origin there instantly.
 */
function fixReferer(headers: Record<string, string>, url: URL): void {
  const ref = headers["referer"];
  const accept = headers["accept"] ?? "";
  const isMedia = /^image\//i.test(accept.trim()) || /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)(\?|$)/i.test(url.pathname);
  if (ref && ref.includes("/scramjet/")) {
    // our own encoded page url → the page the user is really on
    try {
      const marker = "/scramjet/";
      const payload = ref.slice(ref.lastIndexOf(marker) + marker.length);
      const real = decodeURIComponent(payload.split("#")[0] ?? "");
      if (/^https?:\/\//i.test(real)) {
        const asUrl = new URL(real);
        // a referer from a DIFFERENT site than the image host is exactly
        // what hotlink protection expects — keep the real page origin
        headers["referer"] = asUrl.origin + asUrl.pathname;
        return;
      }
    } catch {
      /* fall through */
    }
  }
  if (isMedia) {
    headers["referer"] = url.origin + "/";
    return;
  }
  // anything left is our own shell, not a real upstream page — typed
  // navigations carry no referer at all
  delete headers["referer"];
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

/* ------------------- hop 1a — the HTTP/2 fetch --------------------- *
 * node's undici speaks HTTP/1.1 and carries a TLS/h2 fingerprint that
 * Cloudflare's managed challenge reads instantly: the same url that a
 * plain curl (HTTP/2) or a real browser answers 200 comes back
 * 403 "Just a moment…" from undici. node:http2 with browser-shaped
 * pseudo-headers passes that gate — so every https hop LEADS with h2
 * and only falls back to undici when h2 itself is not viable.
 * ------------------------------------------------------------------ */

/** per-origin session pool — one handshake reused across a page's
 *  dozens of subresources; swept for idle sessions on a quiet timer */
const H2_POOL = new Map<string, { session: http2.ClientHttp2Session; at: number }>();
const H2_IDLE_MS = 12_000;
const H2_POOL_MAX = 10;
let h2Sweeper: ReturnType<typeof setInterval> | null = null;

function h2Sweep(): void {
  const now = Date.now();
  for (const [origin, entry] of H2_POOL) {
    if (now - entry.at > H2_IDLE_MS || entry.session.destroyed || entry.session.closed) {
      H2_POOL.delete(origin);
      try {
        entry.session.close();
      } catch {
        /* already going away */
      }
    }
  }
  if (H2_POOL.size === 0 && h2Sweeper) {
    clearInterval(h2Sweeper);
    h2Sweeper = null;
  }
}

function h2PoolPut(origin: string, session: http2.ClientHttp2Session): void {
  H2_POOL.set(origin, { session, at: Date.now() });
  if (!h2Sweeper) h2Sweeper = setInterval(h2Sweep, 4000);
  // unref: a warmed pool must never hold the function open
  h2Sweeper.unref?.();
}

function h2PoolTake(origin: string): http2.ClientHttp2Session | null {
  const entry = H2_POOL.get(origin);
  if (!entry) return null;
  H2_POOL.delete(origin);
  if (entry.session.destroyed || entry.session.closed || entry.session.connecting) {
    try {
      entry.session.close();
    } catch {
      /* ignore */
    }
    return null;
  }
  return entry.session;
}

/** h2 pseudo/forbidden headers — never copied from the plain header set */
const H2_DROP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "content-length",
]);

/**
 * One h2 hop. Resolves with a web Response whose body is a live stream
 * (already decompressed — the pipeline expects plain bytes). Resolves
 * null when h2 is not viable (plain-http target, handshake refused,
 * protocol error) so the caller falls back to undici without ceremony.
 */
async function h2Fetch(r: UpstreamRequest, timeoutMs: number): Promise<Response | null> {
  if (r.url.protocol !== "https:") return null;
  const origin = r.url.origin;
  const path = r.url.pathname + r.url.search;

  const run = async (session: http2.ClientHttp2Session): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers)) {
      const name = k.toLowerCase();
      if (H2_DROP.has(name)) continue;
      headers[name] = v;
    }
    const stream = session.request({
      ":method": r.method,
      ":path": path,
      ":authority": r.url.host,
      ":scheme": "https",
      ...headers,
    });
    if (r.signal) {
      const onAbort = () => {
        try {
          stream.close(http2.constants.NGHTTP2_CANCEL);
        } catch {
          /* ignore */
        }
      };
      if (r.signal.aborted) onAbort();
      else r.signal.addEventListener("abort", onAbort, { once: true });
    }

    let respHeaders: http2.IncomingHttpHeaders = {};
    const status: number = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          stream.close(http2.constants.NGHTTP2_CANCEL);
        } catch {
          /* ignore */
        }
        reject(new Error("h2 response headers timed out"));
      }, timeoutMs);
      stream.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      stream.once("response", (h) => {
        clearTimeout(timer);
        respHeaders = h;
        const st = Number(h[":status"] ?? 0);
        if (!st) reject(new Error("h2 response carried no :status"));
        else resolve(st);
      });
      if (r.body && r.body.length > 0) stream.end(r.body);
      else stream.end();
    });

    // response headers — h2 names are already lowercase; array values join
    const out = new Headers();
    let setCookies: string[] = [];
    for (const [name, value] of Object.entries(respHeaders)) {
      if (name.startsWith(":")) continue;
      const vals = Array.isArray(value) ? value : [value];
      if (name === "set-cookie") setCookies = setCookies.concat(vals.map(String));
      else if (name === "content-encoding" || name === "content-length") continue;
      else for (const v of vals) if (v != null) out.append(name, String(v));
    }

    // decompress if the server compressed anyway (we never ask for it)
    let body: NodeJS.ReadableStream = stream;
    const enc = String((respHeaders["content-encoding"] as string) ?? "").toLowerCase();
    if (enc.includes("br")) body = stream.pipe(zlib.createBrotliDecompress());
    else if (enc.includes("gzip")) body = stream.pipe(zlib.createGunzip());
    else if (enc.includes("deflate")) body = stream.pipe(zlib.createInflate());

    for (const sc of setCookies) out.append("set-cookie", sc);
    return new Response(Readable.toWeb(body) as unknown as ReadableStream, {
      status,
      headers: out,
    });
  };

  /* pooled session first, fresh handshake second — both bounded */
  const pooled = h2PoolTake(origin);
  if (pooled) {
    try {
      return await run(pooled);
    } catch {
      try {
        pooled.close();
      } catch {
        /* ignore */
      }
      /* fall through to a fresh handshake */
    }
  }
  try {
    const session = http2.connect(origin, { settings: { enablePush: false } });
    session.setTimeout(timeoutMs);
    const res = await run(session);
    if (!session.destroyed && !session.closed && H2_POOL.size < H2_POOL_MAX) h2PoolPut(origin, session);
    else session.close();
    return res;
  } catch {
    /* h2 not viable here — undici takes the hop */
    return null;
  }
}

/** Hop 1 — https leads with HTTP/2 (the fingerprint that passes), undici
 *  (HTTP/1.1, IPv4-pinned) backs it up. Short deadline so a walled hop
 *  falls through to the wisp attempt quickly. */
async function directFetch(r: UpstreamRequest): Promise<Awaited<ReturnType<typeof fetchEgress>>> {
  const headers: Record<string, string> = { ...r.headers };
  delete headers["content-length"];
  const viaH2 = await h2Fetch(r, 16_000).catch(() => null);
  if (viaH2) return viaH2 as unknown as Awaited<ReturnType<typeof fetchEgress>>;
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

/** Hop 2 — same request through the wisp tunnel (real-world egress).
    Bounded: a wedged wisp upstream must fall through fast — the browser
    is holding a spinner, not a patient friend. The hop arrives with a
    PLAIN-BYTE body (compressed answers decoded inside wisp-upstream). */
async function wispFetch(r: UpstreamRequest): Promise<WispHop> {
  const headers: Record<string, string> = { ...r.headers };
  delete headers["content-length"];
  const deadline = new AbortController();
  const onAbort = () => deadline.abort(new Error("wisp hop deadline"));
  const timer = setTimeout(onAbort, 22_000);
  if (r.signal) {
    if (r.signal.aborted) onAbort();
    else r.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await wispRequest({
      url: r.url,
      method: r.method,
      headers,
      body: r.body,
      signal: deadline.signal,
    });
  } finally {
    clearTimeout(timer);
  }
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
 * Throws a labeled Error when a hop is a bot-wall / downgrade / loop.
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
  /* every (method, url) already visited on this chain — a repeat is a wall,
   *    not a path. The classic shape: a 301 whose Location IS the requested
   *    url, cookieless, forever (duckduckgo's current treatment of walled
   *    egress). Two requests and we're out, instead of six hops of the same
   *    301 times four ladder attempts. The method rides the key so a legit
   *    POST→303→GET on the same url still passes. */
  const seen = new Set<string>();

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const hopKey = m + " " + url.toString();
    if (seen.has(hopKey)) {
      throw new Error("upstream bot-wall: redirect loop (" + url.hostname + ")");
    }
    seen.add(hopKey);
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
      status = res.status;
      resHeaders = normalize(new RawHeaders(res.rawHeaders));
      resBody = status === 204 || status === 304 ? null : toWebBody(Readable.toWeb(res.body) as unknown as WebBody);
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
    // STARTED from the main host — fetching lite.ddg directly is legitimate).
    // The ladder remembers the mirror and serves it as the last resort when
    // every transport is walled — a working lite page beats a fault page.
    if (via === "direct" && hop === 0 && isDowngradeHost(next) && !isDowngradeHost(start)) {
      throw new DowngradeError(next);
    }
    // google's sorry interstitial rides 302 → /sorry/… → 200 — the wall
    // lives at the PATH, not the status. Catch the hop itself.
    if (next.pathname.startsWith("/sorry") || next.hostname === "sorry.google.com") {
      throw new Error("upstream bot-wall: sorry redirect");
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

/** Read a stream fully into a Buffer, giving up (and cancelling) past
 *  `cap` bytes — the cache's bounded body reader. */
async function readStreamBytes(stream: ReadableStream, cap: number): Promise<{ buf: Buffer | null; complete: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return { buf: Buffer.concat(chunks), complete: true };
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total > cap) break;
      }
    }
  } catch {
    return { buf: null, complete: false };
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  return { buf: null, complete: false };
}

/* ------------------------------------------------------------------ */
/* response framing (the transport's wire contract)                    */
/* ------------------------------------------------------------------ */

/** headers that must NEVER ride into the rewritten document: upstream CSP
 *    nonces die in scramjet's rewriter (every script blocked → blank page,
 *    google's enablejs loop), and X-Frame-Options DENY would kill the
 *    same-origin proxy frame itself. The SW owns the final policy. */
const STRIP_DOWNSTREAM = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "report-to",
  "reporting-endpoints",
  "x-frame-options",
]);

function relayHeaders(status: number, statusText: string, headers: Headers): Headers {
  const out = new Headers();
  out.set("x-relay-meta", JSON.stringify({ status, statusText }));
  // cacheable assets earn a real downstream cache-control (the SW and the
  // browser may reuse them); documents and personalized answers keep no-store
  const ct = headers.get("content-type") ?? "";
  const cc = headers.get("cache-control") ?? "";
  out.set(
    "Cache-Control",
    CACHEABLE_CT.test(ct) && upstreamCacheTtl(cc) !== null ? downstreamCacheControl(cc) : "no-store",
  );
  headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (n === "set-cookie") out.append("set-cookie", value);
    else if (n === "content-encoding") return;
    else if (STRIP_DOWNSTREAM.has(n)) return;
    else out.append("x-relay-rh-" + n, value);
  });
  return out;
}

/** Serve a stored entry — the same wire shape as a live answer plus a
 *  debug marker. Stored entries never carry set-cookie. */
function respondFromCache(entry: CacheEntry): Response {
  const headers = relayHeaders(entry.status, entry.statusText, entry.headers);
  headers.set("x-relay-cache", "hit");
  return new Response(new Uint8Array(entry.body), { status: entry.status, headers });
}

/**
 * Buffer a finished result's body (tee'd, capped) so coalesced siblings
 * can share it, and store it in the cache when every safety gate passes:
 * 200, cacheable content-type, cache-permitting cache-control, no
 * set-cookie, under the body cap. On success the result's body is swapped
 * to the buffered bytes (a Buffer serves without re-streaming); when
 * buffering is declined the body stays a live stream, untouched.
 */
async function bufferResult(key: string, r: FollowResult, allowStore: boolean): Promise<void> {
  try {
    const body = r.body;
    if (!body || typeof (body as ReadableStream).getReader !== "function") return; // already buffered or empty
    const cl = Number(r.headers.get("content-length") ?? NaN);
    if (Number.isFinite(cl) && cl > CACHE_BODY_CAP) return; // too big — stream through

    const [client, mine] = (body as ReadableStream).tee();
    const read = await readStreamBytes(mine, CACHE_BODY_CAP);
    if (!read.complete || !read.buf || read.buf.byteLength === 0) {
      r.body = client; // oversized or died mid-body — stream what we have
      return;
    }
    r.body = read.buf;
    void client.cancel().catch(() => undefined);

    if (!allowStore) return;
    if (r.status !== 200) return; // never cache walls, faults or errors
    const ct = r.headers.get("content-type") ?? "";
    if (!CACHEABLE_CT.test(ct)) return;
    const ttl = upstreamCacheTtl(r.headers.get("cache-control") ?? "");
    if (ttl === null) return;
    if (collectSetCookies(r.headers).length > 0) return;
    cachePut(key, {
      body: read.buf,
      status: r.status,
      statusText: "OK",
      headers: r.headers,
      expires: Date.now() + ttl,
      bytes: read.buf.byteLength,
    });
  } catch {
    /* caching is strictly best-effort — never fail a response over it */
  }
}

/* ------------------------------------------------------------------ */
/* the upstream attempt (shared by every path)                         */
/* ------------------------------------------------------------------ */

interface AttemptOutcome {
  result: FollowResult | null;
  walledResult: FollowResult | null;
  failure: Error | null;
}

const coalescedFailure = (): AttemptOutcome => ({ result: null, walledResult: null, failure: new Error("relay failed") });

/**
 * Attempts in learned order: hosts this server has already met go straight
 * to the transport that worked. A wisp-learned host never pays the direct
 * 403 tax again; a direct-friendly host never waits on a dead socket.
 * Each transport gets its jar cookies first, then a cookieless retry
 * before switching pipes — a poisoned cookie is the classic wall.
 */
/* ------------------------------------------------------------------ */
/* per-host media pacing — the burst damper                            */
/* ------------------------------------------------------------------ */

/** a page firing 60 <img> tags at one CDN is the classic rate-limit
 *    trigger; 8 concurrent media fetches per host keeps CDNs happy and
 *    converts bursts into a smooth stream. */
const MEDIA_GATE = new Map<string, { active: number; queue: Array<() => void> }>();
const MEDIA_GATE_MAX = 8;
const MEDIA_GATE_WAIT_MS = 25_000;

async function withMediaGate<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const g = MEDIA_GATE.get(host) ?? { active: 0, queue: [] };
  MEDIA_GATE.set(host, g);
  if (g.active >= MEDIA_GATE_MAX) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const i = g.queue.indexOf(resolve);
        if (i >= 0) g.queue.splice(i, 1);
        resolve(); // waited long enough — go anyway
      }, MEDIA_GATE_WAIT_MS);
      g.queue.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  g.active += 1;
  try {
    return await fn();
  } finally {
    g.active = Math.max(0, g.active - 1);
    const next = g.queue.shift();
    if (next) next();
    if (g.active === 0 && g.queue.length === 0) MEDIA_GATE.delete(host);
  }
}

async function attemptUpstream(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  media: boolean,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  if (media) {
    // pace media bursts per host — everything else runs as before
    return withMediaGate(url.hostname, () => attemptLadder(url, method, headers, body, media, signal));
  }
  return attemptLadder(url, method, headers, body, media, signal);
}

/** transient socket weather — an edge SYN-dropping a connect (duckduckgo's
 *    front door does this under load), a reset mid-handshake, a dns hiccup.
 *    These retry on a fresh socket instead of burning the transport. */
function isTransientNetError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const cause = e.cause;
  const causeMsg = cause instanceof Error ? cause.message : String(cause ?? "");
  const causeCode = (cause as { code?: string } | null | undefined)?.code ?? "";
  return (
    /fetch failed/i.test(e.message) ||
    /connect timeout/i.test(causeMsg) ||
    /ECONNRESET|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENOTFOUND|EPIPE/i.test(causeCode)
  );
}

async function attemptLadder(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
  media: boolean,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  const out: AttemptOutcome = { result: null, walledResult: null, failure: null };
  const pref = routeFor(url.hostname)?.via ?? null;
  const first: "direct" | "wisp" = pref === "wisp" ? "wisp" : "direct";
  const second = first === "direct" ? "wisp" : "direct";
  const attempts: Array<{ via: "direct" | "wisp"; noCookies: boolean }> = [{ via: first, noCookies: false }];
  if (!media) attempts.push({ via: first, noCookies: true });
  attempts.push({ via: second, noCookies: false });
  if (!media) attempts.push({ via: second, noCookies: true });
  // a transport that just bot-walled or dead-aired this target will do it
  // again — skip its remaining attempts and let the other pipe answer
  const deadVia = new Set<"direct" | "wisp">();
  // the no-JS mirror a direct hop bounced to (duckduckgo's lite) — kept for
  //    the last-resort serve below
  let downgrade: URL | null = null;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  for (let i = 0; i < attempts.length; i++) {
    const { via, noCookies } = attempts[i];
    if (deadVia.has(via)) continue;
    // the browser's own cookie header never rides (stale-egress poison);
    // the relay's jar supplies the session, and only on the pipe that
    // minted it
    const h = { ...headers };
    delete h["cookie"];
    if (!media && !noCookies) {
      const jc = jarCookieHeader(url.hostname, via);
      if (jc) h["cookie"] = jc;
    }
    // media rate-limits (429s on image bursts) are transient, not walls:
    // two quick retries with a beat between convert most of them
    for (let tryIdx = 0; tryIdx < 3; tryIdx++) {
      try {
        const r = await followRedirects(url, method, h, body, signal, via);
        // a 403/429 on media is a wall, not an answer — the next transport
        // (usually the residential wisp pipe) gets the asset
        const walled = media && (r.status === 403 || r.status === 429);
        if (!walled) {
          out.result = r;
          rememberRoute(url.hostname, via);
          // the session lives on the pipe that minted it
          if (!media) jarAbsorb(url.hostname, via, r.headers);
          break;
        }
        if (r.status === 429 && tryIdx < 2 && !signal.aborted) {
          await sleep(750);
          continue;
        }
        out.walledResult = r;
        if (!out.failure) out.failure = new Error(`upstream ${r.status} for media (${via})`);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "relay failed";
        // remember the mirror a downgrade bounce pointed at — the last
        // resort below may still serve it
        if (e instanceof DowngradeError && !downgrade) downgrade = e.target;
        // a rate-limit wall on media deserves the same short backoff retry
        if (media && /too many request/i.test(msg) && tryIdx < 2 && !signal.aborted) {
          await sleep(750);
          continue;
        }
        // transient SOCKET weather — an edge SYN-dropping a connect, a
        // reset mid-handshake, a dns hiccup — is not a wall and must not
        // burn the transport: a fresh socket (undici reconnects per fetch)
        // usually lands on the next try
        if (isTransientNetError(e) && tryIdx < 2 && !signal.aborted) {
          await sleep(350);
          continue;
        }
        // a bot-wall means the session this pipe carries is BURNED — google
        // keeps challenging the exact cookie state that just got flagged.
        // Purge it: the next attempt starts cookie-fresh (the identity that
        // actually works), and a healthy session re-mints its cookies.
        if (/bot-wall|sorry redirect/i.test(msg)) JAR.delete(url.hostname);
        out.failure = out.failure ?? (e instanceof Error ? e : new Error("relay failed"));
        // transport-level failures (walls, dead sockets, timeouts) poison
        // the pipe for THIS target — the noCookies retry on the same pipe
        // would just pay the same tax again. Only redirect loops can be
        // cookie-driven, so they alone keep the same-pipe retry.
        if (msg !== "too many redirects") deadVia.add(via);
        break;
      }
    }
    if (out.result) break;
  }

  /* LAST RESORT — every transport is walled, but a direct hop once bounced
   *    to a no-JS mirror (duckduckgo → lite). That mirror is a real, working
   *    page: serve it rather than the fault screen. Starting FROM the mirror
   *    keeps the downgrade check quiet. */
  if (!out.result && downgrade && !signal.aborted) {
    try {
      const h = { ...headers };
      delete h["cookie"];
      const jc = jarCookieHeader(downgrade.hostname, "direct");
      if (jc) h["cookie"] = jc;
      const r = await followRedirects(downgrade, method, h, body, signal, "direct");
      const walled = media && (r.status === 403 || r.status === 429);
      if (!walled) {
        out.result = r;
        rememberRoute(url.hostname, "direct");
      }
    } catch {
      /* the fault page covers us */
    }
  }
  return out;
}

/** Frame a finished attempt into the transport's wire response (or the
 *  fault page) — the exact contract the old inline tail of POST had. */
function finalizeResponse(out: AttemptOutcome, url: URL, targetRaw: string, cacheState?: string): Response {
  const result = out.result ?? out.walledResult ?? null;

  if (!result) {
    const msg = out.failure?.message ?? "relay failed";
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
  const headers = relayHeaders(result.status, statusText, result.headers);
  if (cacheState) headers.set("x-relay-cache", cacheState);
  return new Response(respBody, { status: result.status, headers });
}

/* ------------------------------------------------------------------ */
/* the gate — frost_gate cookie verification                          */
/* ------------------------------------------------------------------ */

/** the frost_gate cookie's HMAC token — verified exactly like /api/auth
 *  verifies its Bearer tokens. Returns "" when absent/invalid. */
function gateToken(req: NextRequest): string {
  const cookie = req.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)frost_gate=([^;]+)/.exec(cookie);
  const token = m?.[1]?.trim() ?? "";
  if (!token) return "";
  try {
    const secret =
      process.env.SESSION_SECRET || "murke-local-dev-secret-change-me";
    const [payload, mac] = token.split(".");
    if (!payload || !mac) return "";
    const expected = createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return "";
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      exp?: number;
    };
    if (typeof data.exp !== "number" || data.exp <= Date.now()) return "";
    return token;
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* route                                                               */
/* ------------------------------------------------------------------ */

export async function POST(req: NextRequest) {
  const origin = sameOriginOk(req);
  if (!origin.ok) return Response.json({ ok: false, error: origin.error }, { status: 403 });

  /* THE GATE — the relay only forwards for password-authed sessions.
     /api/auth sets the frost_gate cookie (HttpOnly, HMAC-signed session
     token); the proxy stack's same-origin fetches carry it. Without it,
     no forwarding — the scramjet worker may be lingering in a browser
     that once authed, but the pipe stays shut. */
  {
    const gate = gateToken(req);
    if (!gate) {
      return Response.json({ ok: false, error: "gate closed — sign in first" }, { status: 401 });
    }
  }

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
  // google's sg_ss is a session-bound token google's OWN js appends to the
  // serp url and then expects to find — url AND SG_SS cookie together. With
  // the per-pipe jar holding the cookie, the handshake validates and the
  // page settles; stripping either side makes google re-append forever
  // (the bounce-loop). Only the malformed shape (google's js concatenating
  // it INTO the q value) is cleaned.
  if (url.hostname.endsWith("google.com") && url.pathname === "/search") {
    const q = url.searchParams.get("q");
    if (q && q.includes("?sg_ss=")) url.searchParams.set("q", q.split("?sg_ss=")[0] ?? q);
  }

  const { headers, media } = upstreamHeaders(req, url, method);
  const body = await readBodyCapped(req);

  /* cacheable GETs (images, fonts, styles, scripts) — the repeat-view
     fast path. One upstream fetch per url while it is in flight; every
     later view is answered from memory. Documents, xhr and POSTs never
     enter this branch: their streaming + cookie behavior is exactly what
     it always was. */
  if (method === "GET" && (media || CSS_JS_EXT.test(url.pathname))) {
    const key = "GET " + url.toString();
    for (let round = 0; round < 3; round++) {
      const hit = cacheGet(key);
      if (hit) return respondFromCache(hit);

      const running = INFLIGHT.get(key);
      if (!running) {
        const p = (async () => {
          // abort-decoupled: one sibling disconnecting must not kill the
          // upstream fetch every other sibling (and the cache) waits on
          const out = await attemptUpstream(url, method, headers, body, media, new AbortController().signal);
          const r = out.result ?? out.walledResult;
          if (r) await bufferResult(key, r, out.result !== null);
          return out;
        })().finally(() => {
          INFLIGHT.delete(key);
        });
        INFLIGHT.set(key, p);
        const out = await p.catch(coalescedFailure);
        return finalizeResponse(out, url, targetRaw, "miss");
      }

      // a sibling is already fetching this exact url — its buffered
      // answer (or the cache entry it lands) is ours too
      const out = await running.catch(coalescedFailure);
      const shared = out.result ?? out.walledResult ?? null;
      if (shared && shared.body instanceof Buffer) {
        return finalizeResponse(out, url, targetRaw, "miss");
      }
      // the sibling's answer streamed through unbuffered (oversized) — go
      // around: become the leader or hit the fresh cache entry next round
    }
    // pathological repeat of unshareable answers — fall through to the
    // classic streaming path below
  }

  const out = await attemptUpstream(url, method, headers, body, media, req.signal);
  return finalizeResponse(out, url, targetRaw);
}
