import { NextRequest, NextResponse } from "next/server";
import { createGc, joinGc, listGcs, userForToken } from "@/lib/murke/chat-accounts";
import { storeInfo } from "@/lib/murke/chat-file-store";

/**
 * /api/chat/rooms — persistent GCs (accounts.json is the source of truth, so
 * the list survives restarts/cold starts like everything else in the file).
 *
 * GET  ?token= (or Authorization: Bearer) -> 200 { ok, mode, rooms: GcInfo[] }
 *      GcInfo = { id, name, creator, created, count, joined }
 * POST { op: "create", token, name } -> 200 { ok, room: { id, name } } | 400/409
 * POST { op: "join",   token, name } -> 200 { ok, room: { id, name } } | 404 no such room
 *      (join is idempotent; membership = usernames list on the GC)
 *
 * Any logged-in account can create a GC; others join by NAME (case-insensitive).
 * Every room response also carries `mode` (github | local) for the status ping.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(error: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

function tokenFromReq(req: NextRequest, body?: Record<string, unknown>): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  if (body && typeof body.token === "string") return body.token;
  return req.nextUrl.searchParams.get("token");
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = tokenFromReq(req);
  try {
    const username = await userForToken(token);
    if (!username) return fail("not logged in", 401);
    const rooms = await listGcs(username);
    return NextResponse.json({ ok: true, mode: storeInfo().mode, rooms });
  } catch (err) {
    return fail(`store unavailable: ${err instanceof Error ? err.message : "read failed"}`, 503);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return fail("bad json", 400);
  }
  const token = tokenFromReq(req, body);
  try {
    const username = await userForToken(token);
    if (!username) return fail("not logged in", 401);
    const mode = storeInfo().mode;

    if (body.op === "create") {
      const res = await createGc(username, body.name);
      if (!res.ok) return fail(res.error, res.error === "that name already exists" ? 409 : 400);
      return NextResponse.json({ ...res, mode });
    }
    if (body.op === "join") {
      const res = await joinGc(username, body.name);
      if (!res.ok) return fail(res.error, res.error === "no such room" ? 404 : 400);
      return NextResponse.json({ ...res, mode });
    }
    return fail("unknown op", 400);
  } catch (err) {
    return fail(`store unavailable: ${err instanceof Error ? err.message : "write failed"}`, 503);
  }
}
