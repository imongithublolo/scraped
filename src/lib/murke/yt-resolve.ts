/**
 * SERVER-SIDE INVIDIOUS RESOLVER — shared by /api/yt and /api/stream.
 *
 * This is the FALLBACK layer: the browser races invidious instances
 * itself (src/lib/murke/inv.ts — residential ip beats the bot walls),
 * and when that can't run (CLI before mount, proxied frames) the server
 * walks the same pool from its own egress. Whatever fails here still has
 * the browser path in front of it — that's the point.
 *
 * Every stream url is forced onto the instance proxy (local=true) so the
 * bytes play from any egress. No cobalt, no innertube, no embeds, no
 * iframes — invidious, then the piped LBRY fallback, then an honest
 * error.
 */

import { INV_INSTANCES, normalizeStreamUrl } from "./inv";
import { pipedResolve } from "./piped";

export interface YtSearchHit {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
}

export interface YtQualitySource {
  quality: string;
  url: string;
  direct?: boolean;
  embed?: boolean;
}

export interface YtResolution {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  videoUrl: string;
  videoQuality: string;
  audioUrl: string;
  audioQuality: string;
  sources?: YtQualitySource[];
  embed?: boolean;
  hlsUrl?: string;
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/* ------------------------------ plumbing ------------------------------ */

async function getJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": UA },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return null; // challenge pages ship html
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** walk the pool sequentially (server calls are cheap to serialize) */
async function walkInstances<T>(
  pathOf: (base: string) => string,
  pick: (data: unknown, base: string) => T | null,
  timeoutMs = 9000,
): Promise<T | null> {
  for (const base of INV_INSTANCES) {
    const data = await getJson<unknown>(`${base}${pathOf(base)}`, timeoutMs);
    if (data === null) continue;
    const out = pick(data, base);
    if (out !== null) return out;
  }
  return null;
}

/* ------------------------------- parsing ------------------------------ */

interface InvSearchItem {
  type?: string;
  videoId?: string;
  title?: string;
  author?: string;
  authorId?: string;
  lengthSeconds?: number;
  liveNow?: boolean;
}

interface InvFormat {
  itag?: string;
  url?: string;
  type?: string;
  bitrate?: string | number;
  qualityLabel?: string;
  quality?: string;
}

interface InvDetail {
  title?: string;
  videoId?: string;
  author?: string;
  authorId?: string;
  lengthSeconds?: number;
  liveNow?: boolean;
  adaptiveFormats?: InvFormat[];
  formatStreams?: InvFormat[];
  hlsUrl?: string;
}

function bitrateOf(f: InvFormat): number {
  const n = typeof f.bitrate === "string" ? parseInt(f.bitrate, 10) : f.bitrate;
  return Number.isFinite(n) ? Number(n) : 0;
}

function parseDetail(data: unknown, base: string): YtResolution | null {
  if (typeof data !== "object" || data === null) return null;
  const v = data as InvDetail;
  if (typeof v.videoId !== "string" || !v.videoId) return null;
  const audio: InvFormat[] = [];
  const muxed: InvFormat[] = [];
  const videoOnly: InvFormat[] = [];
  for (const f of v.adaptiveFormats ?? []) {
    const mime = (f.type ?? "").split(";")[0].trim().toLowerCase();
    if (mime.startsWith("audio/")) audio.push(f);
    else if (mime.startsWith("video/")) videoOnly.push(f);
  }
  for (const f of v.formatStreams ?? []) muxed.push(f);
  audio.sort((a, b) => bitrateOf(b) - bitrateOf(a));
  muxed.sort((a, b) => bitrateOf(b) - bitrateOf(a));
  videoOnly.sort((a, b) => bitrateOf(b) - bitrateOf(a));
  const hlsUrl =
    typeof v.hlsUrl === "string" && v.hlsUrl.startsWith("http") ? normalizeStreamUrl(v.hlsUrl) : undefined;
  if (audio.length === 0 && muxed.length === 0 && !hlsUrl) return null; // live / none

  const bestAudio = audio[0];
  const bestMuxed = muxed[0];
  const audioUrl = bestAudio ? normalizeStreamUrl(bestAudio.url ?? "") : "";
  const videoUrl = bestMuxed ? normalizeStreamUrl(bestMuxed.url ?? "") : "";

  const sources: YtQualitySource[] = muxed
    .filter((f) => f.url)
    .map((f) => ({
      quality: f.qualityLabel ?? f.quality ?? String(f.itag ?? "muxed"),
      url: normalizeStreamUrl(f.url as string),
      direct: true, // instance-proxy urls are CORS-open — the browser can carry them
    }))
    .slice(0, 6);

  return {
    videoId: v.videoId,
    title: typeof v.title === "string" ? v.title : v.videoId,
    author: typeof v.author === "string" && v.author ? v.author : "youtube",
    durationSec:
      typeof v.lengthSeconds === "number" && v.lengthSeconds > 0 ? Math.round(v.lengthSeconds) : 0,
    videoUrl,
    videoQuality: bestMuxed?.qualityLabel ?? bestMuxed?.quality ?? (videoUrl ? "muxed" : "none"),
    audioUrl,
    audioQuality: bestAudio ? `${Math.round(bitrateOf(bestAudio) / 1000)}k` : "none",
    sources: videoUrl ? sources : sources.slice(0, 6),
    ...(hlsUrl ? { hlsUrl } : {}),
  };
}

/* ------------------------------- cache -------------------------------- */

const RESOLVE_TTL = 4 * 60_000;
const RESOLVE_CACHE = new Map<string, { at: number; hit: YtResolution }>();

/* ------------------------------- resolve ------------------------------ */

export function extractVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m =
    /(?:v=|\/watch\/|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/.exec(s);
  return m ? m[1] : null;
}

/** Resolve a video id (server egress). Null when every instance failed. */
export async function resolveVideo(
  id: string,
  opts?: { fresh?: boolean },
): Promise<YtResolution | null> {
  if (!opts?.fresh) {
    const cached = RESOLVE_CACHE.get(id);
    if (cached && Date.now() - cached.at < RESOLVE_TTL) return cached.hit;
  }
  RESOLVE_CACHE.delete(id);
  // 1. the invidious pool from this egress
  const hit = await walkInstances<YtResolution>(
    (base) => `${base}/api/v1/videos/${encodeURIComponent(id)}`,
    (data, base) => parseDetail(data, base),
    11000,
  );
  if (hit) {
    RESOLVE_CACHE.set(id, { at: Date.now(), hit });
    return hit;
  }
  // 2. the piped pool — its LBRY mirrors dodge walls invidious can't
  const p = await pipedResolve(id).catch(() => null);
  if (p) {
    const best = p.muxed[0];
    const phit: YtResolution = {
      videoId: p.videoId,
      title: p.title,
      author: p.author,
      durationSec: p.durationSec,
      videoUrl: best?.url ?? "",
      videoQuality: best?.quality ?? "muxed",
      audioUrl: best?.url ?? "",
      audioQuality: "muxed",
      sources: p.muxed.map((f) => ({ quality: f.quality, url: f.url, direct: true })),
      ...(p.hlsUrl ? { hlsUrl: p.hlsUrl } : {}),
    };
    RESOLVE_CACHE.set(id, { at: Date.now(), hit: phit });
    return phit;
  }
  return null;
}

/* -------------------------------- search ------------------------------ */

function parseSearch(data: unknown): YtSearchHit[] | null {
  if (!Array.isArray(data)) return null;
  const items = (data as InvSearchItem[])
    .filter((i) => i.type === "video" && typeof i.videoId === "string" && typeof i.title === "string")
    .map((i) => ({
      videoId: i.videoId as string,
      title: i.title as string,
      author: typeof i.author === "string" ? i.author : "youtube",
      durationSec: Number(i.lengthSeconds) || 0,
    }));
  return items.length > 0 ? items : null;
}

export async function searchVideos(query: string): Promise<YtSearchHit[]> {
  const q = encodeURIComponent(query);
  return (
    (await walkInstances<YtSearchHit[]>(
      () => `/api/v1/search?q=${q}&type=video&page=1`,
      parseSearch,
    )) ?? []
  );
}

/** channel uploads — the artist page fallback */
export async function channelVideos(authorId: string): Promise<YtSearchHit[]> {
  const id = encodeURIComponent(authorId);
  return (
    (await walkInstances<YtSearchHit[]>(
      () => `/api/v1/channels/${id}/videos`,
      parseSearch,
      11000,
    )) ?? []
  );
}

/** channel lookup by name — the artist search fallback */
export async function searchChannels(
  query: string,
): Promise<{ authorId: string; author: string }[]> {
  const q = encodeURIComponent(query);
  const data = await walkInstances<{ authorId: string; author: string }[]>(
    () => `/api/v1/search?q=${q}&type=channel&page=1`,
    (raw) => {
      if (!Array.isArray(raw)) return null;
      const out = (raw as InvSearchItem[])
        .filter((i) => i.type === "channel" && typeof i.authorId === "string")
        .map((i) => ({ authorId: i.authorId as string, author: i.author ?? "" }));
      return out.length > 0 ? out : null;
    },
  );
  return data ?? [];
}

/* -------------------------- /api/stream?yt= --------------------------- */

const STREAM_URL_CACHE = new Map<string, { url: string; until: number }>();

/**
 * Streamable url for a video (kind="audio" → best audio, kind="muxed" →
 * best muxed). Short-lived url cache; `fresh` re-resolves (upstream died).
 */
export async function resolveStreamUrl(
  id: string,
  kind: "audio" | "muxed",
  fresh = false,
): Promise<string | null> {
  const key = `${id}:${kind}`;
  if (!fresh) {
    const c = STREAM_URL_CACHE.get(key);
    if (c && Date.now() < c.until) return c.url;
  }
  STREAM_URL_CACHE.delete(key);
  const hit = await resolveVideo(id, { fresh });
  if (!hit) return null;
  const url = kind === "muxed" ? hit.videoUrl : hit.audioUrl;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  STREAM_URL_CACHE.set(key, { url, until: Date.now() + 120_000 });
  return url;
}
