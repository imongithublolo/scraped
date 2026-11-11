import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/music/artist?id=<itunes artist id>
 *
 * Artist profile for the music pane — backed by the public iTunes Lookup
 * API (`lookup?id=…&entity=song&limit=60`, no key, no oauth). The first
 * result is the artist entity (name + primary genre; iTunes ships no
 * artist artwork for music, so the cover falls back to the first track's).
 * Tracks are normalized EXACTLY like /api/music/search via the shared
 * normalizeItunesHit, so the pane renders them with the same row shape.
 *
 * Upstream goes through fetch4 (explicit IPv4 — this sandbox's undici
 * flaps on v6). Nothing is stored; this route is a lookup table.
 */

import { fetch4 } from "@/lib/http4";
import { normalizeItunesHit, type MusicSearchHit } from "../search/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ITunesLookupResult {
  wrapperType?: string;
  artistName?: string;
  primaryGenreName?: string;
  artistArtworkUrl100?: string;
  trackId?: number;
  trackName?: string;
  collectionName?: string;
  trackTimeMillis?: number;
  artworkUrl100?: string;
  previewUrl?: string;
  trackViewUrl?: string;
  artistId?: number;
}

export interface MusicArtistProfile {
  id: string;
  name: string;
  genre: string;
  /** artist cover when itunes ships one, else the first track's artwork */
  artwork: string;
}

export async function GET(req: NextRequest) {
  const id = (req.nextUrl.searchParams.get("id") ?? "").trim();
  if (!/^\d+$/.test(id)) {
    return NextResponse.json(
      { ok: false, error: "music artist: pass ?id=<itunes artist id>" },
      { status: 400 },
    );
  }

  try {
    const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=song&limit=60`;
    const res = await fetch4(url, {
      headers: { Accept: "application/json" },
      timeoutMs: 12000,
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `itunes lookup failed (${res.status})` },
        { status: 502 },
      );
    }
    const data = (await res.json().catch(() => null)) as { results?: ITunesLookupResult[] } | null;
    if (data === null || !Array.isArray(data.results)) {
      return NextResponse.json(
        { ok: false, error: "itunes: bad lookup response" },
        { status: 502 },
      );
    }

    let name = "";
    let genre = "";
    let artistArt = "";
    const results: MusicSearchHit[] = [];
    for (const r of data.results) {
      if (r.wrapperType === "artist") {
        if (typeof r.artistName === "string") name = r.artistName;
        if (typeof r.primaryGenreName === "string") genre = r.primaryGenreName;
        if (typeof r.artistArtworkUrl100 === "string") {
          artistArt = r.artistArtworkUrl100.replace("100x100", "300x300");
        }
        continue;
      }
      const hit = normalizeItunesHit(r);
      if (hit) results.push(hit);
    }

    // no artist entity in the payload — derive what we can from the tracks.
    // cover/name prefer a track from the artist's OWN album: entity=song
    // lookups also return features, and someone else's cover art is worse
    // than no art. itunes lookup itself ships no artist artwork.
    const own = results.find((h) => h.artistId === id) ?? results[0];
    if (!name && own) name = own.artist;
    if (!artistArt && own) artistArt = own.artwork;

    if (!name && results.length === 0) {
      return NextResponse.json(
        { ok: false, error: "music artist: unknown artist id" },
        { status: 404 },
      );
    }

    const artist: MusicArtistProfile = {
      id,
      name,
      genre,
      artwork: artistArt,
    };
    return NextResponse.json({ ok: true, artist, results });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "itunes lookup failed" },
      { status: 502 },
    );
  }
}
