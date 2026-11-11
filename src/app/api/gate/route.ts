import { NextRequest, NextResponse } from "next/server";
import { readSiteSettings, isBannedIp } from "@/lib/murke/admin-store";

/**
 * GET /api/gate -> { lockdown: boolean, banned: boolean }
 *
 * Public status bits the gate reads before it starts listening —
 * lockdown turns the login screen into the lock page; banned turns it
 * into the ban page for that ip.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const ip = (fwd.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim();
  const site = await readSiteSettings();
  const banned = await isBannedIp(ip);
  return NextResponse.json(
    { lockdown: site.lockdown, banned },
    { headers: { "Cache-Control": "no-store" } },
  );
}
