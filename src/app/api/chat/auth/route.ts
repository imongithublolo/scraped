import { NextRequest, NextResponse } from "next/server";
import { loginUser, logoutUser, registerUser, userForToken, displayFor } from "@/lib/murke/chat-accounts";
import { storeInfo } from "@/lib/murke/chat-file-store";

/**
 * POST /api/chat/auth — account sessions for the persistent GC chat.
 *
 * { op: "register", username, password, display? } -> 200 { ok, token, username, display, mode }
 *                                                    | 409 name taken | 429 rate-limited | 400 bad input
 * { op: "login",    username, password }           -> 200 { ok, token, username, display, mode } | 401 wrong creds
 * { op: "logout",   token }                        -> 200 { ok } (token deleted from accounts.json)
 * { op: "me",       token }                        -> 200 { ok, username, display, mode } | 401 not logged in
 *
 * Passwords are scrypt-hashed (node:crypto) before they touch the store —
 * only salt+hash ever persist. Tokens are random 32-byte hex, kept in the
 * SAME accounts.json under `tokens`, expiring after ~30 days. Register is
 * rate-limited to 5/min/IP in-memory.
 *
 * mode = "github" (GITHUB_TOKEN set — accounts live in murke-chat/accounts.json
 * in the repo) | "local" (no token — mirrored into the sqlite ChatStore KV).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* register rate limit: max 5 per minute per IP, in-memory ring */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const registerHits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (registerHits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    registerHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  registerHits.set(ip, hits);
  if (registerHits.size > 500) {
    for (const [k, v] of registerHits) if (v.every((t) => now - t >= WINDOW_MS)) registerHits.delete(k);
  }
  return false;
}

function fail(error: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

async function storeFailOr(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    const detail = err instanceof Error ? err.message : "store unavailable";
    return fail(`store unavailable: ${detail}`, 503);
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

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const mode = storeInfo().mode;

  switch (body.op) {
    case "register": {
      if (rateLimited(ip)) return fail("slow down — max 5 registers/min", 429);
      return storeFailOr(async () => {
        const res = await registerUser(body.username, body.display, body.password);
        if (!res.ok) return fail(res.error, res.error === "name is taken" ? 409 : 400);
        return NextResponse.json({ ...res, mode });
      });
    }
    case "login": {
      return storeFailOr(async () => {
        const res = await loginUser(body.username, body.password);
        if (!res.ok) return fail(res.error, 401);
        return NextResponse.json({ ...res, mode });
      });
    }
    case "logout": {
      return storeFailOr(async () => {
        await logoutUser(body.token);
        return NextResponse.json({ ok: true, mode });
      });
    }
    case "me": {
      return storeFailOr(async () => {
        const username = await userForToken(body.token);
        if (!username) return fail("not logged in", 401);
        const display = await displayFor(username);
        return NextResponse.json({ ok: true, username, display, mode });
      });
    }
    default:
      return fail("unknown op", 400);
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: false, error: "post only" }, { status: 405 });
}
