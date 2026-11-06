import { NextRequest, NextResponse } from "next/server";
import { checkAdminPwd, makeAdminToken } from "@/lib/murke/admin-store";

/**
 * POST /api/admin/auth { pwd } -> { ok, token }
 *
 * Mints a short-lived admin session token. The permanent admin pwd never
 * leaves the server; a wrong pwd is a bare 401. Lockdown does NOT block
 * the admin pwd — the admin must be able to reach the panel to lift it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let pwd: unknown = null;
  try {
    const body = (await req.json()) as { pwd?: unknown };
    pwd = body?.pwd;
  } catch {
    /* fallthrough */
  }
  if (!checkAdminPwd(pwd)) {
    return NextResponse.json({ ok: false, error: "denied" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, token: makeAdminToken() });
}
