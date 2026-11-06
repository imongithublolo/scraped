/**
 * fetch4 — node:https GET with `family: 4`.
 *
 * Why: this sandbox's undici (node global fetch) can hang connecting to
 * some hosts (happy-eyeballs never lands on v4), while an explicit IPv4
 * socket connects instantly. Every server-side upstream fetch for media
 * (yt resolve / stream pipe / session download) goes through here.
 *
 * Streams: the returned Response body is the live upstream socket, so
 * Range passthrough (206) and big files flow without buffering.
 */
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

interface Fetch4Init {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** optional outer abort signal (caller cancel) */
  signal?: AbortSignal;
  maxRedirects?: number;
  /** POST/PUT support (innertube player API etc.) — body sent verbatim */
  method?: string;
  body?: string;
}

function viaHttps(url: URL, init: Fetch4Init, redirects: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? "GET",
        headers: { "User-Agent": "Mozilla/5.0", ...(init.headers ?? {}) },
        family: 4,
        servername: url.hostname,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && loc && redirects < (init.maxRedirects ?? 5)) {
          res.resume(); // drain
          let next: URL;
          try {
            next = new URL(loc, url);
          } catch (e) {
            reject(e instanceof Error ? e : new Error("bad redirect"));
            return;
          }
          viaHttps(next, init, redirects + 1).then(resolve, reject);
          return;
        }
        resolve(res);
      },
    );
    req.setTimeout(init.timeoutMs ?? 20000, () => {
      req.destroy(new Error(`connect timeout (${url.host})`));
    });
    if (init.signal) {
      const onAbort = () => req.destroy(new Error("aborted"));
      if (init.signal.aborted) onAbort();
      else init.signal.addEventListener("abort", onAbort, { once: true });
    }
    req.on("error", reject);
    if (init.body != null) req.write(init.body);
    req.end();
  });
}

function toWebResponse(res: IncomingMessage): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(", "));
  }
  const status = res.statusCode ?? 502;
  const body = status === 204 || status === 304 ? null : (Readable.toWeb(res) as unknown as ReadableStream);
  return new Response(body, { status, headers });
}

/** GET a url over explicit IPv4 https; the body streams straight through. */
export async function fetch4(rawUrl: string, init: Fetch4Init = {}): Promise<Response> {
  const url = new URL(rawUrl);
  const res = await viaHttps(url, init, 0);
  return toWebResponse(res);
}

/** POST JSON over explicit IPv4 https; parses the JSON response. */
export async function postJson4<T>(
  rawUrl: string,
  body: unknown,
  init: Fetch4Init = {},
): Promise<T | null> {
  try {
    const res = await viaHttps(new URL(rawUrl), {
      ...init,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      body: JSON.stringify(body),
    }, 0);
    if ((res.statusCode ?? 500) >= 400) return null;
    const text = await new Response(Readable.toWeb(res) as unknown as ReadableStream).text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** fetch4 + JSON parse + ok check. Null on any failure. */
export async function getJson4<T>(url: string, timeoutMs = 10000): Promise<T | null> {
  try {
    const res = await fetch4(url, { timeoutMs, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
