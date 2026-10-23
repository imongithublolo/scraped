import { NextRequest, NextResponse } from "next/server";
import {
  bury,
  dm,
  gc,
  gcAdd,
  gcKick,
  join,
  joinRoom,
  leave,
  msg,
  sync,
  touch,
  typing,
} from "@/lib/murke/chat-store";

/**
 * POST /api/chat — the whole murke chat relay behind one endpoint.
 *
 * { op: "join",      clientId, name }      -> { ok, me, users, rooms, cursor }
 * { op: "sync",      clientId, cursor }    -> { ok, cursor, users, rooms, events }
 *                                           | { ok: false, error: "unknown-client" }
 * { op: "msg",       clientId, room, text }   -> { ok } | { ok: false, error }
 * { op: "typing",    clientId, room }         -> { ok } | { ok: false, error }
 * { op: "dm",        clientId, to }           -> { ok, roomId } | { ok: false, error }
 * { op: "gc",        clientId, name, private?}  -> { ok, room } | { ok: false, error }
 * { op: "gc_add",    clientId, roomId, name }   -> { ok } | { ok: false, error }  (private gc admin)
 * { op: "gc_kick",   clientId, roomId, name }   -> { ok } | { ok: false, error }  (private gc admin)
 * { op: "bury",      clientId, roomId }         -> { ok } | { ok: false, error }  (private gc admin)
 * { op: "leave",     clientId, roomId }       -> { ok } | { ok: false, error }
 * { op: "join_room", clientId, roomId }       -> { ok } | { ok: false, error }
 *
 * State lives in lib/murke/chat-store (memory only, globalThis stash — no
 * db, no files, no side process, so this works the same on `next dev` and
 * on Vercel serverless, which the old socket.io mini-service never could).
 * Every op refreshes the caller's lastSeen — polling IS the heartbeat.
 * Bad shape / unknown op -> 400. Unknown clientId -> 200 { ok: false } so
 * the browser transport can see "unknown-client" and re-join itself.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bad(error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status: 400 });
}

function gone(): NextResponse {
  return NextResponse.json({ ok: false, error: "unknown-client" });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("bad json");
  }
  if (typeof body !== "object" || body === null) return bad("bad body");
  const b = body as Record<string, unknown>;

  const clientId = b.clientId;
  if (typeof clientId !== "string" || clientId.length === 0) return bad("missing clientId");

  switch (b.op) {
    case "join": {
      if (typeof b.name !== "string") return bad("bad name");
      return NextResponse.json(join(clientId, b.name));
    }
    case "sync": {
      if (typeof b.cursor !== "number" || !Number.isFinite(b.cursor)) return bad("bad cursor");
      return NextResponse.json(sync(clientId, b.cursor));
    }
    case "msg": {
      if (typeof b.room !== "string" || typeof b.text !== "string") return bad("bad room/text");
      if (!touch(clientId)) return gone();
      return NextResponse.json(msg(clientId, b.room, b.text));
    }
    case "typing": {
      if (typeof b.room !== "string") return bad("bad room");
      if (!touch(clientId)) return gone();
      return NextResponse.json(typing(clientId, b.room));
    }
    case "dm": {
      if (typeof b.to !== "string") return bad("bad to");
      if (!touch(clientId)) return gone();
      return NextResponse.json(dm(clientId, b.to));
    }
    case "gc": {
      if (typeof b.name !== "string") return bad("bad name");
      if (!touch(clientId)) return gone();
      return NextResponse.json(gc(clientId, b.name, b.private === true));
    }
    case "gc_add": {
      if (typeof b.roomId !== "string" || typeof b.name !== "string") return bad("bad room/name");
      if (!touch(clientId)) return gone();
      return NextResponse.json(gcAdd(clientId, b.roomId, b.name));
    }
    case "gc_kick": {
      if (typeof b.roomId !== "string" || typeof b.name !== "string") return bad("bad room/name");
      if (!touch(clientId)) return gone();
      return NextResponse.json(gcKick(clientId, b.roomId, b.name));
    }
    case "bury": {
      if (typeof b.roomId !== "string") return bad("bad roomId");
      if (!touch(clientId)) return gone();
      return NextResponse.json(bury(clientId, b.roomId));
    }
    case "leave": {
      if (typeof b.roomId !== "string") return bad("bad roomId");
      if (!touch(clientId)) return gone();
      return NextResponse.json(leave(clientId, b.roomId));
    }
    case "join_room": {
      if (typeof b.roomId !== "string") return bad("bad roomId");
      if (!touch(clientId)) return gone();
      return NextResponse.json(joinRoom(clientId, b.roomId));
    }
    default:
      return bad("unknown op");
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: false, error: "post only" }, { status: 405 });
}
