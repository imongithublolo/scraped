import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/music/search?q=<query>
 *
 * Spotify-style track metadata search WITHOUT any auth — backed by the
 * public iTunes Search API (no key, no oauth, generous limits). Returns
 * normalized rows the launcher resolves into full streams via the yt
 * chain (the 30s iTunes preview rides along as the fallback).
 *
 * Upstream goes through fetch4 (explicit IPv4 — this sandbox's undici
 * flaps on v6). Nothing is stored; this route is a lookup table.
 */

import { fetch4 } from "@/lib/http4";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ITunesHit {
  artistId?: number;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackTimeMillis?: number;
  artworkUrl100?: string;
  previewUrl?: string;
  trackViewUrl?: string;
}

export interface MusicSearchHit {
  id: string;
  title: string;
  artist: string;
  /** itunes artist id — /api/music/artist profiles are keyed on it */
  artistId: string;
  album: string;
  durationSec: number;
  /** 300x300 cover (upscaled from the 100x100 the API returns) */
  artwork: string;
  /** 30s m4a preview — the launcher's always-makes-sound fallback */
  previewUrl: string;
  trackUrl: string;
}

/** normalize one itunes row — shared verbatim by the search route and the
 *  artist-profile route so both hand the client the exact same shape */
export function normalizeItunesHit(r: ITunesHit): MusicSearchHit | null {
  if (typeof r.trackId !== "number" || typeof r.trackName !== "string") return null;
  return {
    id: String(r.trackId),
    title: r.trackName,
    artist: typeof r.artistName === "string" ? r.artistName : "unknown artist",
    artistId: typeof r.artistId === "number" ? String(r.artistId) : "",
    album: typeof r.collectionName === "string" ? r.collectionName : "",
    durationSec:
      typeof r.trackTimeMillis === "number" && r.trackTimeMillis > 0
        ? Math.round(r.trackTimeMillis / 1000)
        : 0,
    artwork:
      typeof r.artworkUrl100 === "string"
        ? r.artworkUrl100.replace("100x100", "300x300")
        : "",
    previewUrl: typeof r.previewUrl === "string" ? r.previewUrl : "",
    trackUrl: typeof r.trackViewUrl === "string" ? r.trackViewUrl : "",
  };
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return NextResponse.json(
      { ok: false, error: "music search: pass ?q=<query> (2+ chars)" },
      { status: 400 },
    );
  }

  try {
    const url = `https://itunes.apple.com/search?media=music&entity=song&limit=25&term=${encodeURIComponent(q)}`;
    const res = await fetch4(url, {
      headers: { Accept: "application/json" },
      timeoutMs: 12000,
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `itunes search failed (${res.status})` },
        { status: 502 },
      );
    }
    const data = (await res.json().catch(() => null)) as { results?: ITunesHit[] } | null;
    if (data === null || !Array.isArray(data.results)) {
      return NextResponse.json(
        { ok: false, error: "itunes: bad search response" },
        { status: 502 },
      );
    }

    const results: MusicSearchHit[] = [];
    for (const r of data.results) {
      const hit = normalizeItunesHit(r);
      if (hit) results.push(hit);
    }

    return NextResponse.json({ ok: true, results });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "itunes search failed" },
      { status: 502 },
    );
  }
}
