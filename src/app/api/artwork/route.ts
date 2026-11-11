import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/artwork?u=<media image url>
 *
 * Same-origin re-serve for thumbnails (youtube i.ytimg via invidious hits)
 * and album art. The <img> tags load the CDN directly first; when a
 * browser/extension (or a COEP corner case) refuses the CDN, the UI
 * retries THROUGH this route — same bytes, our origin.
 *
 * Host allowlist: only the media CDNs. The bytes stream through with a
 * long immutable cache (artwork never changes for a given url).
 */

import { fetch4 } from "@/lib/http4";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED =
  /(^|\.)(mzstatic\.com|ytimg\.com|googleusercontent\.com|ggpht\.com)$/i;

export async function GET(req: NextRequest) {
  const u = (req.nextUrl.searchParams.get("u") ?? "").trim();
  let host = "";
  try {
    host = new URL(u).hostname;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid url" }, { status: 400 });
  }
  if (!/^https?:\/\//i.test(u) || !ALLOWED.test(host)) {
    return NextResponse.json({ ok: false, error: "host not allowed" }, { status: 400 });
  }

  try {
    const upstream = await fetch4(u, {
      headers: { Accept: "image/*,*/*" },
      timeoutMs: 12000,
    });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ ok: false, error: `upstream ${upstream.status}` }, { status: 502 });
    }
    const headers = new Headers();
    const type = upstream.headers.get("content-type") ?? "image/jpeg";
    headers.set("Content-Type", type.startsWith("image/") ? type : "image/jpeg");
    const len = upstream.headers.get("content-length");
    if (len) headers.set("Content-Length", len);
    // thumb urls are content-addressed — immutable
    headers.set("Cache-Control", "public, max-age=604800, immutable");
    return new Response(upstream.body, { status: 200, headers });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "artwork fetch failed" },
      { status: 502 },
    );
  }
}
