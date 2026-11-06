import { NextRequest, NextResponse } from "next/server";
import { recordPresence } from "@/app/api/admin/users/route";

/**
 * POST /api/presence { id, history?, files? } -> { ok, interval }
 *
 * Authenticated desktops ping this on a timer so the admin app can show
 * who is online, from which ip, with a look at their search history and
 * the files app listing. The snapshot rides in the body; the ip comes
 * from the proxy headers. No auth token (the gate is the auth) — the
 * payload is read-only state the browser already shares with itself.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { id?: unknown; history?: unknown; files?: unknown; screen?: unknown; activity?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* keep empty */
  }
  const id = typeof body.id === "string" && body.id.length >= 6 && body.id.length <= 64 ? body.id : null;
  if (!id) return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });

  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const ip = (fwd.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim();
  const ua = (req.headers.get("user-agent") ?? "unknown").slice(0, 180);

  recordPresence(
    id,
    ip,
    ua,
    {
      history: Array.isArray(body.history) ? body.history : [],
      files: Array.isArray(body.files) ? body.files : [],
      screen: typeof body.screen === "string" ? body.screen : undefined,
      activity: typeof body.activity === "string" ? body.activity : undefined,
    },
  );
  return NextResponse.json({ ok: true, interval: 25_000 }, { headers: { "Cache-Control": "no-store" } });
}
