import { NextRequest, NextResponse } from "next/server";
import { displayFor, gcExists, listMessages, postMessage, userForToken } from "@/lib/murke/chat-accounts";
import { storeInfo } from "@/lib/murke/chat-file-store";

/**
 * /api/chat/messages — per-GC message log, persisted in murke-chat/messages.json
 * (last 200 kept per GC). Token auth: Authorization: Bearer or ?token=/body.
 *
 * GET  ?room=<gcId>&since=<ts>&token= -> 200 { ok, room, mode, messages: StoredMsg[] }
 *      messages ascending; `since` returns only ts > since (small polls),
 *      without it you get the full kept log (≤200).
 * POST { token, room, text } -> 200 { ok, message } | 400 empty | 404 no such room
 *      Posting auto-joins the GC (membership = accounts.json members list).
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
  const roomId = req.nextUrl.searchParams.get("room") ?? "";
  if (!roomId) return fail("which room?", 400);
  const sinceRaw = req.nextUrl.searchParams.get("since");
  const since = sinceRaw !== null && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : undefined;
  try {
    const username = await userForToken(tokenFromReq(req));
    if (!username) return fail("not logged in", 401);
    const messages = await listMessages(roomId, since);
    if (messages.length === 0 && !(await gcExists(roomId))) return fail("no such room", 404);
    return NextResponse.json({ ok: true, mode: storeInfo().mode, room: { id: roomId }, messages });
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
  const roomId = typeof body.room === "string" ? body.room : "";
  if (!roomId) return fail("which room?", 400);
  try {
    const username = await userForToken(tokenFromReq(req, body));
    if (!username) return fail("not logged in", 401);
    const res = await postMessage(username, await display(username), roomId, body.text);
    if (!res.ok) return fail(res.error, res.error === "no such room" ? 404 : 400);
    return NextResponse.json({ ...res, mode: storeInfo().mode });
  } catch (err) {
    return fail(`store unavailable: ${err instanceof Error ? err.message : "write failed"}`, 503);
  }
}
/* display name is resolved per post so renames flow into new lines */
const display = (username: string): Promise<string> => displayFor(username);
