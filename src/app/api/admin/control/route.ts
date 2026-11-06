import { NextRequest, NextResponse } from "next/server";
import { adminFromRequest, addBan, removeBan, clearAllBans } from "@/lib/murke/admin-store";
import { kick, queueClick, queueFsOp, setCursor, setNotice, setScreenWant, type FsOp } from "@/lib/murke/control-store";
import { PRESENCE } from "../users/route";

/**
 * POST /api/admin/control  (admin bearer)
 *
 * The admin's live hand on a user's machine:
 *   { id, cursor:{x,y} }   move my cursor on their screen (0..1 viewport)
 *   { id, click:{x,y} }    dispatch a real click there
 *   { id, notice:"..." }   flash a message on their screen
 *   { id, screenWant:b }   start / stop watching their screen
 *   { id, fs:{op,path,content?} }  queue a filesystem op on their machine
 *                                  (list|read|write|mkdir|remove) → { rid }
 *   { id, kick:true }      boot them off + drop them from the cache
 *   { id, ban:true }       ban their ip (persists in the site store)
 *   { unban:"1.2.3.4" }    lift a ban
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!adminFromRequest(req)) {
    return NextResponse.json({ ok: false, error: "denied" }, { status: 401 });
  }

  let body: {
    id?: unknown;
    cursor?: { x?: unknown; y?: unknown };
    click?: { x?: unknown; y?: unknown };
    notice?: unknown;
    screenWant?: unknown;
    kick?: unknown;
    ban?: unknown;
    unban?: unknown;
    unbanAll?: unknown;
    fs?: { op?: unknown; path?: unknown; content?: unknown };
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad body" }, { status: 400 });
  }

  /* unban works without a target session — one ip or ALL of them */
  if (typeof body.unban === "string" && body.unban.trim()) {
    const bans = await removeBan(body.unban.trim(), "admin");
    return NextResponse.json({ ok: true, bans }, { headers: { "Cache-Control": "no-store" } });
  }
  if (body.unbanAll === true) {
    const bans = await clearAllBans("admin");
    return NextResponse.json({ ok: true, bans, cleared: true }, { headers: { "Cache-Control": "no-store" } });
  }

  const id = typeof body.id === "string" && body.id.length >= 6 && body.id.length <= 64 ? body.id : null;
  if (!id) return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });

  /* filesystem op — queue it, hand back the rid to poll /api/admin/fs with */
  if (body.fs && typeof body.fs === "object") {
    const OPS: FsOp[] = ["list", "read", "write", "mkdir", "remove"];
    const op = typeof body.fs.op === "string" && (OPS as string[]).includes(body.fs.op) ? (body.fs.op as FsOp) : null;
    const path = typeof body.fs.path === "string" && body.fs.path.trim() ? body.fs.path.trim() : null;
    if (!op || !path) return NextResponse.json({ ok: false, error: "bad fs op" }, { status: 400 });
    let content: string | undefined;
    if (op === "write") {
      if (typeof body.fs.content !== "string") return NextResponse.json({ ok: false, error: "write needs content" }, { status: 400 });
      content = body.fs.content.length > 2_000_000 ? body.fs.content.slice(0, 2_000_000) : body.fs.content;
    }
    const rid = queueFsOp(id, op, path, content);
    return NextResponse.json({ ok: true, rid }, { headers: { "Cache-Control": "no-store" } });
  }

  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

  if (body.cursor) {
    const x = num(body.cursor.x);
    const y = num(body.cursor.y);
    if (x !== null && y !== null) setCursor(id, x, y);
  }
  if (body.click) {
    const x = num(body.click.x);
    const y = num(body.click.y);
    if (x !== null && y !== null) queueClick(id, x, y);
  }
  if (typeof body.notice === "string" && body.notice.trim()) setNotice(id, body.notice.trim());
  if (typeof body.screenWant === "boolean") setScreenWant(id, body.screenWant);

  if (body.kick === true) {
    kick(id);
    PRESENCE.delete(id); // from the cache — off the board at once
  }
  if (body.ban === true) {
    const s = PRESENCE.get(id);
    const ip = s?.ip ?? "";
    if (ip) {
      const bans = await addBan(ip, id, "admin");
      kick(id);
      PRESENCE.delete(id);
      return NextResponse.json({ ok: true, banned: ip, bans }, { headers: { "Cache-Control": "no-store" } });
    }
    kick(id);
    return NextResponse.json({ ok: false, error: "unknown ip — kicked only" }, { headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
