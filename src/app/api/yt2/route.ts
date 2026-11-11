import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/yt2?search=<query>   → youtube results, scraped from youtube.com
 * GET /api/yt2?u=<id|url>       → metadata (oEmbed) for one video
 *
 * THE NEW METHOD — no invidious, no piped, no yt-dlp, no third parties:
 *  - SEARCH: this server fetches youtube.com/results directly and parses
 *    the ytInitialData blob out of the HTML. YouTube serves the search page
 *    to servers far more readily than it serves player APIs.
 *  - PLAYBACK: the client plays through the OFFICIAL embed player
 *    (youtube-nocookie.com) inside the watch app — the bytes come from the
 *    USER'S OWN connection, so no datacenter IP ever has to touch the
 *    player. Videos play; seeking, quality and fullscreen are youtube's
 *    own controls.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface YtHit {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  thumb: string;
  live?: boolean;
}

interface Renderer {
  videoRenderer?: {
    videoId?: string;
    title?: { runs?: Array<{ text?: string }> };
    ownerText?: { runs?: Array<{ text?: string }> };
    longBylineText?: { runs?: Array<{ text?: string }> };
    lengthText?: { simpleText?: string };
    thumbnail?: { thumbnails?: Array<{ url?: string; width?: number }> };
    liveBroadcastContent?: string;
  };
  lockupViewModel?: {
    contentId?: string;
    metadata?: {
      lockupMetadataViewModel?: {
        title?: { content?: string };
        byline?: {
          metadataParts?: Array<{ text?: { content?: string } }>;
        };
      };
    };
    contentImage?: {
      thumbnailViewModel?: {
        image?: { sources?: Array<{ url?: string; width?: number }> };
        overlays?: Array<{
          thumbnailOverlayBadgeViewModel?: {
            thumbnailBadges?: Array<{ thumbnailBadgeViewModel?: { text?: string } }>;
          };
        }>;
      };
    };
  };
}

/** walk any json depth-first, collecting video renderers (new + legacy shapes) */
function collectRenderers(node: unknown, out: Renderer[], depth = 0): void {
  if (!node || typeof node !== "object" || depth > 22) return;
  if (Array.isArray(node)) {
    for (const v of node) collectRenderers(v, out, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  if (o.videoRenderer || o.lockupViewModel) out.push(o as Renderer);
  for (const k of Object.keys(o)) collectRenderers(o[k], out, depth + 1);
}

function parseDur(s: string | undefined): number {
  if (!s) return 0;
  // "3:42" / "1:02:03" / "LIVE"
  if (/live/i.test(s)) return 0;
  const parts = s.split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

function extractInitialData(html: string): unknown {
  const m =
    /var ytInitialData\s*=\s*(\{[\s\S]+?\});<\/script>/.exec(html) ??
    /window\["ytInitialData"\]\s*=\s*(\{[\s\S]+?\});<\/script>/.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const search = (p.get("search") ?? "").trim();
  const u = (p.get("u") ?? "").trim();

  /* ---------------- search: scrape youtube.com/results ---------------- */
  if (search) {
    try {
      const res = await fetch(
        `https://www.youtube.com/results?search_query=${encodeURIComponent(search)}&sp=EgIQAQ%253D%253D`,
        {
          headers: {
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            Accept: "text/html",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) {
        return NextResponse.json({ ok: false, error: `youtube answered ${res.status}` }, { status: 502 });
      }
      const html = await res.text();
      const data = extractInitialData(html);
      if (!data) {
        return NextResponse.json(
          { ok: false, error: "youtube page arrived without data (consent wall?) — retry" },
          { status: 502 },
        );
      }
      const renderers: Renderer[] = [];
      collectRenderers(data, renderers);

      const seen = new Set<string>();
      const hits: YtHit[] = [];
      for (const r of renderers) {
        if (r.videoRenderer?.videoId) {
          const v = r.videoRenderer;
          const vid = v.videoId;
          if (!vid || seen.has(vid)) continue;
          seen.add(vid);
          const title = v.title?.runs?.map((x) => x.text ?? "").join("") || "untitled";
          const author = v.ownerText?.runs?.[0]?.text ?? v.longBylineText?.runs?.[0]?.text ?? "youtube";
          const dur = parseDur(v.lengthText?.simpleText);
          const live = v.liveBroadcastContent === "LIVE";
          const thumbs = (v.thumbnail?.thumbnails ?? []).filter((t) => t.url);
          const thumb = thumbs.length > 0 ? (thumbs[thumbs.length - 1]?.url as string) : "";
          hits.push({ videoId: vid, title, author, durationSec: live ? 0 : dur, thumb, live: live || undefined });
        } else if (r.lockupViewModel?.contentId && r.lockupViewModel.contentId.length === 11) {
          const v = r.lockupViewModel;
          const vid = v.contentId;
          if (!vid || seen.has(vid)) continue;
          seen.add(vid);
          const meta = v.metadata?.lockupMetadataViewModel;
          const title = meta?.title?.content ?? "untitled";
          const author = meta?.byline?.metadataParts?.[0]?.text?.content ?? "youtube";
          const badge =
            v.contentImage?.thumbnailViewModel?.overlays?.[0]?.thumbnailOverlayBadgeViewModel?.thumbnailBadges?.[0]
              ?.thumbnailBadgeViewModel?.text;
          const live = /live/i.test(badge ?? "");
          const thumbs = (v.contentImage?.thumbnailViewModel?.image?.sources ?? []).filter((t) => t.url);
          const thumb = thumbs.length > 0 ? (thumbs[thumbs.length - 1]?.url as string) : "";
          hits.push({ videoId: vid, title, author, durationSec: 0, thumb, live: live || undefined });
        }
        if (hits.length >= 24) break;
      }
      if (hits.length === 0) {
        return NextResponse.json({ ok: false, error: "search came back empty — youtube served no videos" }, { status: 404 });
      }
      return NextResponse.json({ ok: true, engine: "yt-scrape", results: hits });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "youtube scrape failed" }, { status: 502 });
    }
  }

  /* ---------------- metadata: oEmbed (title/author for one id) -------- */
  if (u) {
    const m = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/.exec(u);
    const id = m ? m[1] : /^[-\w]{11}$/.test(u) ? u : null;
    if (!id) return NextResponse.json({ ok: false, error: "not a youtube url or id" }, { status: 400 });
    try {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`,
        {
          headers: { "User-Agent": UA, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(12_000),
        },
      );
      if (!res.ok) {
        return NextResponse.json({ ok: true, videoId: id, title: id, author: "youtube", embeddable: false });
      }
      const j = (await res.json()) as { title?: string; author_name?: string };
      return NextResponse.json({
        ok: true,
        videoId: id,
        title: j.title ?? id,
        author: j.author_name ?? "youtube",
        embeddable: true,
      });
    } catch {
      return NextResponse.json({ ok: true, videoId: id, title: id, author: "youtube", embeddable: false });
    }
  }

  return NextResponse.json({ ok: false, error: "pass ?search=<query> or ?u=<id|url>" }, { status: 400 });
}
