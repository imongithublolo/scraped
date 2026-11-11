import { NextResponse } from "next/server";
import { storeInfo } from "@/lib/murke/chat-file-store";

/**
 * GET /api/chat/status — the storage mode ping.
 *
 * -> { ok: true, mode: "github" | "local", repo, prefix, files: string[] }
 *
 * mode "github": GITHUB_TOKEN is set — accounts/GCs/messages live as real
 * committed files (murke-chat/accounts.json, murke-chat/messages.json) in the
 * repo, so a registered account is genuinely "saved in a file in github".
 * mode "local": token missing — the identical JSON blobs are mirrored into
 * the local sqlite ChatStore KV instead (sandbox / revoked token).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const info = storeInfo();
  return NextResponse.json({
    ok: true,
    ...info,
    files: [`${info.prefix}/accounts.json`, `${info.prefix}/messages.json`],
  });
}
