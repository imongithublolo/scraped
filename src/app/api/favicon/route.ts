import { NextRequest } from "next/server";

/**
 * GET /api/favicon?u=<site url>  →  the site's ACTUAL favicon, re-served
 * same-origin so installed-app tiles show the real logo instead of a
 * letter tile. Zero third parties: the SERVER asks the site itself —
 * first /favicon.ico, then a <link rel="icon"> parse of the homepage.
 *
 * Small in-process cache (favicons never change mid-session) with a
 * negative cache so a site without one doesn't get hammered.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const TTL = 6 * 60 * 60_000;
const cache = new Map<string, { at: number; data: ArrayBuffer | null; mime: string }>();

const ICON_MIME = /^image\/(png|jpe?g|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon|avif)$/i;

function originOf(u: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function fetchBytes(url: string): Promise<{ ok: boolean; data?: ArrayBuffer; mime?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "image/*,*/*" },
      redirect: "follow",
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false };
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!ICON_MIME.test(mime)) return { ok: false };
    const data = await res.arrayBuffer();
    if (data.byteLength === 0 || data.byteLength > 1_500_000) return { ok: false };
    return { ok: true, data, mime };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** pull the icon href out of the homepage markup (apple-touch first) */
async function linkIconFor(origin: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(origin, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 200_000);
    const hrefs: string[] = [];
    const re = /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const tag = m[0];
      const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
      if (!href) continue;
      // prefer the biggest/apple-touch icons; push to front
      const big = /apple-touch-icon|180x180|192x192|512x512/i.test(tag);
      if (big) hrefs.unshift(href);
      else hrefs.push(href);
    }
    for (const href of hrefs.slice(0, 4)) {
      try {
        const abs = new URL(href, origin).toString();
        if (/^https?:\/\//i.test(abs)) return abs;
      } catch {
        /* skip */
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const u = (req.nextUrl.searchParams.get("u") ?? "").trim();
  const origin = originOf(u);
  if (!origin) {
    return Response.json({ ok: false, error: "invalid url" }, { status: 400 });
  }

  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < TTL) {
    if (!hit.data) return Response.json({ ok: false, error: "no icon" }, { status: 404 });
    return new Response(hit.data, {
      headers: { "Content-Type": hit.mime, "Cache-Control": "public, max-age=21600" },
    });
  }

  // 1. the well-known path, 2. the markup's <link rel=icon>
  let found = await fetchBytes(`${origin}/favicon.ico`);
  if (!found.ok) {
    const link = await linkIconFor(origin);
    if (link) found = await fetchBytes(link);
  }

  if (!found.ok || !found.data) {
    cache.set(origin, { at: Date.now(), data: null, mime: "" });
    return Response.json({ ok: false, error: "no icon" }, { status: 404 });
  }
  cache.set(origin, { at: Date.now(), data: found.data, mime: found.mime ?? "image/png" });
  if (cache.size > 300) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return new Response(found.data, {
    headers: { "Content-Type": found.mime ?? "image/png", "Cache-Control": "public, max-age=21600" },
  });
}
