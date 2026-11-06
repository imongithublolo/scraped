import { NextRequest, NextResponse } from "next/server";
import { adminFromRequest } from "@/lib/murke/admin-store";
import { getFsRes } from "@/lib/murke/control-store";

/**
 * GET /api/admin/fs?id=<session>&rid=<request id>  (admin bearer)
 *
 * Poll for the answer to a queued filesystem op. The client executes the
 * op on its own VFS (via the 1s control poll) and posts the result back;
 * this route hands it to the admin panel: { ok, done, res? }.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminFromRequest(req)) {
    return NextResponse.json({ ok: false, error: "denied" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const rid = req.nextUrl.searchParams.get("rid") ?? "";
  if (id.length < 6 || id.length > 64 || !rid || rid.length > 64) {
    return NextResponse.json({ ok: false, error: "bad id/rid" }, { status: 400 });
  }
  const res = getFsRes(id, rid);
  return NextResponse.json(
    { ok: true, done: res !== null, res },
    { headers: { "Cache-Control": "no-store" } },
  );
}
