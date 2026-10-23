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
  connect: { family: 4, timeout: 8_000 },
  headersTimeout: 12_000,
  bodyTimeout: 300_000,
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

/** A minimal browser-shaped header set for a navigation-ish request. */
export function browserHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "user-agent": UA,
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "identity",
    "upgrade-insecure-requests": "1",
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

/* ------------------------------------------------------------------ */
/* shared fault page (same contract as public/sw.js)                   */
/* ------------------------------------------------------------------ */

/** The PROXY FAULT page — posts to the browser chrome so it revalidates. */
export function faultHtml(msg: string, url: string): string {
  const ENT: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;" };
  const safe = String(msg).replace(/[<>&]/g, (c) => ENT[c] ?? c);
  return (
    '<!doctype html><meta charset="utf-8"><title>daemon proxy</title><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0103;color:#ff6b61;font-family:ui-monospace,Menlo,monospace"><div style="text-align:center;max-width:80ch"><div style="font-size:13px;letter-spacing:.2em">PROXY FAULT</div><pre style="margin-top:10px;font-size:11px;color:#8f3d36;white-space:pre-wrap;text-align:left">' +
    safe +
    "</pre>" +
    '<div style="margin-top:14px;font-size:11px"><a href="#" onclick="location.reload();return false" style="color:#ffb454">[ retry ]</a></div>' +
    "<script>try{parent.postMessage({__murkeProxyFault:true,url:" +
    JSON.stringify(String(url || "")) +
    "},location.origin)}catch(e){}\u003c/script>" +
    "</div></body>"
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
