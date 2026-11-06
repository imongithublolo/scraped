/**
 * PIPED FALLBACK — the second resolver family behind invidious.
 *
 * Invidious is the doctrine; piped instances are the safety net. Their
 * /streams endpoint returns muxed streams (video+audio in one file) and
 * — the interesting part — LBRY (odysee CDN) mirrors that are NOT walled
 * from datacenter egress and ship `Access-Control-Allow-Origin: *`.
 * When every invidious instance walls an egress, this family still makes
 * sound and picture. Used by the client (yt.ts resolveYt) and the server
 * (yt-resolve.ts) as the middle tier of the resolve chain.
 *
 * No iframes, no embeds — plain byte urls like everywhere else.
 */

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** ordered pool — private.coffee is verified-live (streams + bytes) */
export const PIPED_INSTANCES: string[] = [
  "https://api.piped.private.coffee",
  "https://pipedapi.ducks.party",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.reallyaweso.me",
];

export interface PipedStream {
  url: string;
  quality: string;
  mime: string;
}

export interface PipedMedia {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  /** muxed (video+audio) streams — regular googlevideo-proxy itags first,
   *  raw LBRY renditions LAST (those are the full-size originals, often
   *  gigabytes — a <video>/<audio> element chokes on them) */
  muxed: PipedStream[];
  /** adaptive HLS manifest (odysee/LBRY) — hls.js territory */
  hlsUrl?: string;
}

interface PipedStreamRaw {
  url?: string;
  mimeType?: string;
  quality?: string;
  bitrate?: number;
  videoOnly?: boolean;
  format?: string;
}

interface PipedStreamsRaw {
  title?: string;
  uploader?: string;
  duration?: number;
  audioStreams?: PipedStreamRaw[];
  videoStreams?: PipedStreamRaw[];
  livestream?: boolean;
}

/** one instance attempt — null on any failure (walled/dead/bot page) */
async function fromInstance(base: string, videoId: string): Promise<PipedMedia | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(`${base}/streams/${encodeURIComponent(videoId)}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": UA },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return null;
    const j = (await res.json()) as PipedStreamsRaw;
    if (j.livestream) return null; // lives don't resolve to static bytes here
    const raws = [...(j.videoStreams ?? []), ...(j.audioStreams ?? [])];
    const muxed: PipedStream[] = [];
    let hlsUrl: string | undefined;
    for (const s of raws) {
      if (s.videoOnly === true) continue; // video WITHOUT audio — useless here
      if (typeof s.url !== "string" || !/^https?:\/\//i.test(s.url)) continue;
      const mime = (s.mimeType ?? "").split(";")[0].trim().toLowerCase();
      if (mime.includes("mpegurl")) {
        // HLS manifest (odysee carries one) — adaptive, sane sizes
        if (!hlsUrl) hlsUrl = s.url;
        continue;
      }
      if (!mime.startsWith("video/mp4") && !mime.startsWith("audio/mp4") && !mime.startsWith("audio/mpeg"))
        continue; // webm/opus muxed variants decode fine in <video> but keep it mp4-simple
      muxed.push({ url: s.url, quality: s.quality ?? "auto", mime });
    }
    // ORDER MATTERS: googlevideo-via-pipedproxy itags (18/22 — normal-size
    // renditions) first; raw LBRY/odysee renditions LAST — those are the
    // full-size originals (the 4K remaster of one music video ships an
    // 11GB mp4) that stall every media element.
    const isOdysee = (u: string) => /odycdn\.com|odysee/i.test(u);
    muxed.sort((a, b) => Number(isOdysee(a.url)) - Number(isOdysee(b.url)));
    const seen = new Set<string>();
    const dedup = muxed.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
    if (dedup.length === 0 && !hlsUrl) return null;
    return {
      videoId,
      title: typeof j.title === "string" ? j.title : videoId,
      author: typeof j.uploader === "string" ? j.uploader : "youtube",
      durationSec: typeof j.duration === "number" && j.duration > 0 ? Math.round(j.duration) : 0,
      muxed: dedup,
      ...(hlsUrl ? { hlsUrl } : {}),
    };
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.error(`[piped] ${base} failed: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve via the piped pool. RACE: first instance to return a usable
 * media wins. Null when every instance failed.
 */
export async function pipedResolve(videoId: string): Promise<PipedMedia | null> {
  return new Promise<PipedMedia | null>((resolve) => {
    let pending = PIPED_INSTANCES.length;
    let settled = false;
    for (const base of PIPED_INSTANCES) {
      fromInstance(base, videoId)
        .then((m) => {
          if (settled) return;
          if (m) {
            settled = true;
            resolve(m);
            return;
          }
          if (--pending === 0 && !settled) {
            settled = true;
            resolve(null);
          }
        })
        .catch(() => {
          if (settled) return;
          if (--pending === 0 && !settled) {
            settled = true;
            resolve(null);
          }
        });
    }
  });
}
