import { NextResponse } from "next/server";

/**
 * GET /api/net/ping — an empty 204 the client times to measure REAL
 * round-trip latency to this server (no body, no store, no keep-alive
 * tricks; the browser's own connection pool is the network path).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
