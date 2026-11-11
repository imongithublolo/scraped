import { NextRequest, NextResponse } from "next/server";
import { adminFromRequest, sha256Gate, writeSiteSettings } from "@/lib/murke/admin-store";

/**
 * POST /api/admin/password { password } (admin bearer) -> { ok }
 *
 * Replaces the ENTIRE SITE's gate password. Writes the salted sha256 into
 * the site store; /api/auth consults it on every login, so the change is
 * live for everyone on the next attempt.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!adminFromRequest(req)) {
    return NextResponse.json({ ok: false, error: "denied" }, { status: 401 });
  }
  let password: unknown = null;
  try {
    const body = (await req.json()) as { password?: unknown };
    password = body?.password;
  } catch {
    /* fallthrough */
  }
  if (typeof password !== "string" || password.length < 3 || password.length > 128) {
    return NextResponse.json({ ok: false, error: "password must be 3-128 characters" }, { status: 400 });
  }
  await writeSiteSettings({ hash: sha256Gate(password) }, "admin/password");
  return NextResponse.json({ ok: true });
}
