/**
 * murke-ai — image generation. POST { prompt, size? } -> { ok, b64, size }.
 * Free, keyless (for the user): z-ai-web-dev-sdk, backend only.
 */
import { NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SIZES = ["1024x1024", "768x1344", "864x1152", "1344x768", "1152x864", "1440x720", "720x1440"] as const;
type ImgSize = (typeof SIZES)[number];

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { prompt?: unknown; size?: unknown };
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 1200) : "";
    if (!prompt) {
      return NextResponse.json({ ok: false, error: "no prompt" }, { status: 400 });
    }
    const size = typeof body.size === "string" && (SIZES as readonly string[]).includes(body.size) ? (body.size as ImgSize) : "1024x1024";

    const zai = await ZAI.create();
    const res = await zai.images.generations.create({ prompt, size });
    const b64 = res.data?.[0]?.base64;
    if (!b64) {
      return NextResponse.json({ ok: false, error: "the engine returned no image" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, b64, size });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "image generation failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
