import { NextRequest } from "next/server";

/**
 * GET /api/net/down?kb=<128..1024>
 *
 * A payload of EXACTLY known size (zero-filled buffer) with no-store, so
 * the client can time the transfer and compute real throughput to this
 * server. Default 256 KB — big enough to drown TLS handshakes, small
 * enough to stay polite on metered links.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const kbRaw = Number(req.nextUrl.searchParams.get("kb") ?? "256");
  const kb = Number.isFinite(kbRaw) ? Math.min(1024, Math.max(16, Math.round(kbRaw))) : 256;
  const buf = new Uint8Array(kb * 1024);
  /* touch every page so the OS actually commits it before the wire */
  for (let i = 0; i < buf.length; i += 4096) buf[i] = 0;
  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store",
      "X-Payload-Bytes": String(buf.length),
    },
  });
}
