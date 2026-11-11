import { NextRequest, NextResponse } from "next/server";
import { pollControl, pushFsRes, takeFsOp, type FsRequest } from "@/lib/murke/control-store";

/**
 * GET /api/control?id=<client id> -> { ok, kicked, cursor, click, notice, screenWant, fsOp, interval }
 * POST /api/control { id, fsRes:{ rid, ok, data?, error? } } -> { ok }
 *
 * The user side of the control channel — every authenticated desktop
 * polls this ~every second. It carries the admin's cursor (rendered
 * green + rounded on their screen), queued clicks, notice flashes, the
 * kick flag, the screen-view request AND queued filesystem operations
 * (list/read/write/mkdir/remove) the desktop executes on its own VFS.
 * The client answers an fs op by POSTing the result back here.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (id.length < 6 || id.length > 64) {
    return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });
  }
  const ctl = pollControl(id);
  const fsOp: FsRequest | null = takeFsOp(id);
  return NextResponse.json(
    { ok: true, ...ctl, fsOp, interval: 1000 },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  let body: { id?: unknown; fsRes?: { rid?: unknown; ok?: unknown; data?: unknown; error?: unknown } } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad body" }, { status: 400 });
  }
  const id = typeof body.id === "string" && body.id.length >= 6 && body.id.length <= 64 ? body.id : null;
  if (!id) return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });

  if (body.fsRes && typeof body.fsRes.rid === "string" && body.fsRes.rid.length <= 64) {
    const data = body.fsRes.data;
    /* guard the pipe: listings/reads are small text; anything monstrous is dropped */
    const payload = typeof data === "string" ? data.slice(0, 900_000) : data;
    pushFsRes(id, {
      rid: body.fsRes.rid,
      ok: body.fsRes.ok === true,
      data: payload,
      error: typeof body.fsRes.error === "string" ? body.fsRes.error.slice(0, 300) : undefined,
      at: Date.now(),
    });
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
