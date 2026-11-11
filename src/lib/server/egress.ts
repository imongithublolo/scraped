/**
 * EGRESS — shared upstream plumbing for the proxy backend.
 *
 * Every server-side fetch that leaves this app (the /api/relay forwarder,
 * the /api/fetch-file downloader) comes through here so the rules live in
 * exactly one place:
 *
 *   - IPv4 sockets only (this stack wedges on v6 — see instrumentation.ts)
 *   - SSRF guard: loopback / private / link-local targets are refused
 *   - a browser-shaped UA, no headless fingerprints, identity encoding
 *   - bot-wall sniffing: challenge pages are detected, never served
 *   - the PROXY FAULT page contract shared with public/sw.js
 */

import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

/** Chrome-on-Windows UA — the least remarkable fingerprint there is. */
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** undici agent pinned to IPv4 with sane timeouts (short connect — walls
 *  must fall through to the wisp hop fast, not dead-air the browser). */
export const EGRESS_AGENT = new Agent({
  connect: { family: 4, timeout: 4_000 },
  headersTimeout: 12_000,
  bodyTimeout: 300_000,
  // pooling headroom (undici 8): a page's image burst opens dozens of
  // sockets to one CDN at once, and warm keep-alive sockets between pages
  // skip the repeat TCP+TLS handshake per asset
  connections: 64,
  keepAliveTimeout: 30_000,
});

/** Never let the egress touch loopback / private / link-local space. */
export function blockedTarget(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) {
    return true;
  }
  if (h === "[::1]" || h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
  }
  return false;
}

/** Undici fetch through the IPv4 agent with an abort + overall deadline. */
export function fetchEgress(url: string, init: UndiciRequestInit = {}, timeoutMs = 60_000): ReturnType<typeof undiciFetch> {
  const signal = init.signal ?? undefined;
  const timer = new AbortController();
  const onAbort = () => timer.abort(new Error("egress timeout"));
  const t = setTimeout(onAbort, timeoutMs);
  if (signal) {
    if (signal.aborted) timer.abort(new Error("client aborted"));
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return undiciFetch(url, {
    ...init,
    signal: timer.signal,
    dispatcher: EGRESS_AGENT,
  }).finally(() => {
    clearTimeout(t);
    signal?.removeEventListener("abort", onAbort);
  });
}

/** Chrome 131's client-hint set — every real Chrome request carries these;
 *    their absence next to a Chrome UA is a quiet bot flag. */
export const SEC_CH_UA = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';

/** A minimal browser-shaped header set for a navigation-ish request.
 *  Encoding is deliberately NOT forced to identity — a "Chrome" that asks
 *  for uncompressed HTML is a loud bot fingerprint (google 302-bounces it
 *  after a request or two). undici decodes gzip/deflate/br/zstd itself. */
export function browserHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "user-agent": UA,
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "gzip, deflate, br, zstd",
    "upgrade-insecure-requests": "1",
    "sec-ch-ua": SEC_CH_UA,
    "sec-ch-ua-mobile": "?0",
    'sec-ch-ua-platform': '"Windows"',
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* bot-wall sniffing                                                   */
/* ------------------------------------------------------------------ */

/** Challenge-page fingerprints (lowercase). */
export const BOT_WALL_MARKERS = [
  "captcha",
  "challenge-platform",
  "captcha-delivery",
  "px-captcha",
  "perimeterx",
  "datadome",
  "just a moment",
  "anomaly",
  "unusual traffic",
  "blocked because",
  "access to this page has been denied",
  "request has been blocked",
  "are you a human",
  "bot verification",
  "enable javascript and cookies to continue",
  "too many requests",
  "too many reqs",
  "wikimedia error",
];

/**
 * True when a response smells like an anti-bot challenge: 403/429/503/202
 * with an HTML body carrying one of the markers.
 */
export function looksLikeBotWall(status: number, contentType: string, bodyText: string): string | null {
  const ct = (contentType || "").toLowerCase();
  if (![403, 429, 503, 202].includes(status) || !ct.includes("text/html")) return null;
  const text = bodyText.toLowerCase();
  return BOT_WALL_MARKERS.find((m) => text.includes(m)) ?? null;
}

/**
 * Redirect downgrades: hops that mean the upstream SOFT-BLOCKED us instead
 * of serving the real page (duckduckgo bounces datacenter egress onto its
 * no-JS lite/html mirrors).
 */
export const DOWNGRADE_HOSTS = ["lite.duckduckgo.com", "html.duckduckgo.com", "duckduckgo.com/html"];
export function isDowngradeHost(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  return DOWNGRADE_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

/** A downgrade redirect, carrying the mirror it bounced to — the ladder
 *    remembers it and serves that mirror as the last resort when every
 *    transport is walled (a working lite page beats a fault page). */
export class DowngradeError extends Error {
  constructor(public target: URL) {
    super("upstream bot-wall: downgrade redirect");
    this.name = "DowngradeError";
  }
}

/* ------------------------------------------------------------------ */
/* shared fault page (same contract as public/sw.js)                   */
/* ------------------------------------------------------------------ */

/* the Hertswood Academy crest — inlined so the fault page stays whole
 * (same asset the service worker's page carries) */
const HUB_LOGO =
  "data:image/png;base64,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";

/** The fault page — the school's own clothes (crest, masthead, Student
 *  Hub tab title), never a "frost proxy" tell. It posts to the browser
 *  chrome so it can revalidate, and keeps the raw fault text collapsed
 *  for debugging. */
export function faultHtml(msg: string, url: string): string {
  const ENT: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;" };
  const safe = String(msg).replace(/[<>&]/g, (c) => ENT[c] ?? c);
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Student Hub (this page could not load)</title>" +
    "<style>" +
    "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:#f4f5f7;color:#1f2430;font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif}" +
    "header{background:#7a1f3d;color:#fff;padding:13px 22px;display:flex;align-items:center;gap:14px;box-shadow:0 2px 10px rgba(0,0,0,.18)}" +
    "header img{width:42px;height:42px;border-radius:6px;background:#fff;padding:2px}" +
    "header .school b{display:block;font-size:17px;letter-spacing:.02em;line-height:1.2}" +
    "header .school span{font-size:12px;opacity:.85}" +
    "main{flex:1;display:flex;align-items:center;justify-content:center;padding:28px 16px}" +
    ".card{background:#fff;max-width:560px;width:100%;border-radius:14px;border-top:6px solid #c9a227;box-shadow:0 12px 40px rgba(15,20,40,.12),0 2px 6px rgba(15,20,40,.06);padding:38px 34px;text-align:center}" +
    ".card .crest{width:88px;height:88px;margin:0 auto 12px;display:block}" +
    "h1{font-size:24px;margin:0 0 8px;color:#7a1f3d}" +
    ".msg{font-size:15.5px;line-height:1.55;color:#4a5160;margin:0 0 22px}" +
    ".btn{display:inline-block;background:#7a1f3d;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 32px;border-radius:999px;border:0;cursor:pointer}" +
    ".btn:hover{background:#5e152e}" +
    "details{margin-top:22px;text-align:left}summary{cursor:pointer;font-size:12.5px;color:#8a93a3}" +
    "pre{margin:8px 0 0;font-size:10.5px;color:#8f3d36;white-space:pre-wrap;background:#faf7f8;border:1px solid #efe4e8;border-radius:8px;padding:10px 12px;max-height:140px;overflow:auto}" +
    "</style></head><body>" +
    '<header><img alt="Hertswood Academy crest" src="' + HUB_LOGO + '"><div class="school"><b>Hertswood Academy</b><span>Student Hub</span></div></header>' +
    "<main><div class=\"card\">" +
    '<img class="crest" alt="" src="' + HUB_LOGO + '">' +
    "<h1>This page could not load</h1>" +
    '<p class="msg">The Student Hub could not reach this page. Check your connection and try again — everything else is safe.</p>' +
    '<button class="btn" onclick="location.reload()">Try again</button>' +
    "<details><summary>Technical details</summary><pre>" + safe + "</pre></details>" +
    "</div></main>" +
    "<script>try{parent.postMessage({__murkeProxyFault:true,url:" +
    JSON.stringify(String(url || "")) +
    "},location.origin)}catch(e){}\u003c/script>" +
    "</body></html>"
  );
}

/** Same-origin guard: accept any host our own proxy chain advertises. */
export function sameOriginOk(req: Request): { ok: boolean; error?: string } {
  const origin = req.headers.get("origin");
  if (!origin) return { ok: true }; // same-origin GET/POST without Origin
  try {
    const originHost = new URL(origin).host;
    const allowed = new Set<string>();
    const addHost = (v: string | null | undefined) => {
      if (!v) return;
      for (const part of v.split(",")) {
        const h = part.trim();
        if (h) allowed.add(h);
      }
    };
    addHost(req.headers.get("host"));
    addHost(req.headers.get("x-forwarded-host"));
    return allowed.has(originHost) ? { ok: true } : { ok: false, error: "cross-origin request denied" };
  } catch {
    return { ok: false, error: "bad origin" };
  }
}
