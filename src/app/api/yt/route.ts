import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/yt?u=<youtube url|11-char id>   → resolve streamable urls
 * GET /api/yt?search=<query>               → search videos
 * GET /api/yt?channel=<authorId>           → a channel's uploads
 * GET /api/yt?artist=<name>                → channel lookup by name
 *
 * Thin route over the server-side INVIDIOUS resolver (yt-resolve.ts).
 * The browser normally resolves via src/lib/murke/inv.ts directly — this
 * route is the fallback when the client can't reach instances. No embeds,
 * no iframes — invidious urls or an honest error.
 */

import {
  channelVideos,
  extractVideoId,
  resolveVideo,
  searchChannels,
  searchVideos,
} from "@/lib/murke/yt-resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const u = (params.get("u") ?? "").trim();
  const search = (params.get("search") ?? "").trim();
  const channel = (params.get("channel") ?? "").trim();
  const artist = (params.get("artist") ?? "").trim();

  if (search) {
    const results = await searchVideos(search);
    if (results.length === 0) {
      return NextResponse.json({ ok: false, error: "yt: search came back empty" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, results: results.slice(0, 24) });
  }

  if (channel) {
    const results = await channelVideos(channel);
    if (results.length === 0) {
      return NextResponse.json({ ok: false, error: "yt: channel came back empty" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, results: results.slice(0, 40) });
  }

  if (artist) {
    const results = await searchChannels(artist);
    if (results.length === 0) {
      return NextResponse.json({ ok: false, error: "yt: no channels found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, results: results.slice(0, 12) });
  }

  if (u) {
    const id = extractVideoId(u);
    if (!id) {
      return NextResponse.json({ ok: false, error: "yt: not a youtube url or id" }, { status: 400 });
    }
    const hit = await resolveVideo(id);
    if (!hit) {
      return NextResponse.json(
        { ok: false, error: "yt: every invidious instance gave up — try again in a moment" },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, ...hit });
  }

  return NextResponse.json(
    { ok: false, error: "yt: pass ?u=<url|id> or ?search=<query>" },
    { status: 400 },
  );
}
