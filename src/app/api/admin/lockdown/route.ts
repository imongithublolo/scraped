import { NextRequest, NextResponse } from "next/server";
import { adminFromRequest, readSiteSettings, writeSiteSettings } from "@/lib/murke/admin-store";

/**
 * GET  /api/admin/lockdown (admin bearer) -> { ok, lockdown }
 * POST /api/admin/lockdown { on: boolean } (admin bearer) -> { ok, lockdown }
 *
 * Lockdown is the kill switch: while it is on, /api/auth refuses every
 * login and the gate shows the lock page. The admin app itself keeps
 * working so the admin can lift it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!adminFromRequest(req)) {
    return NextResponse.json({ ok: false, error: "denied" }, { status: 401 });
  }
  const site = await readSiteSettings();
  return NextResponse.json({ ok: true, lockdown: site.lockdown });
}

export async function POST(req: NextRequest) {
  if (!adminFromRequest(req)) {
    return NextResponse.json({ ok: false, error: "denied" }, { status: 401 });
  }
  let on: unknown = null;
  try {
    const body = (await req.json()) as { on?: unknown };
    on = body?.on;
  } catch {
    /* fallthrough */
  }
  if (typeof on !== "boolean") {
    return NextResponse.json({ ok: false, error: "on must be a boolean" }, { status: 400 });
  }
  const site = await writeSiteSettings({ lockdown: on }, "admin/lockdown");
  return NextResponse.json({ ok: true, lockdown: site.lockdown });
}
