/**
 * YouTube plumbing for the dsh commands (watch / music yt / dl) and the
 * panes. INVIDIOUS ONLY — no cobalt, no innertube, no embeds, no iframes.
 *
 * Browser-first: src/lib/murke/inv.ts races the instance pool from the
 * USER'S OWN IP (instances wall datacenters but answer residential ips,
 * and their API is CORS-*). The server chain (/api/yt) is the fallback.
 * Stream urls are instance-proxy (local=true) urls that play from
 * anywhere — through our same-origin /api/stream pipe or directly.
 */

import {
  invChannel,
  invResolve,
  invSearch,
  invSearchChannels,
  ytThumb,
  type InvMedia,
} from "./inv";
import { pipedResolve, type PipedMedia } from "./piped";

export interface YtSearchHit {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  /** channel id — powers the artist page */
  authorId?: string;
  /** i.ytimg thumb url — render through /api/artwork */
  thumb?: string;
  live?: boolean;
}

export interface YtQualitySource {
  quality: string;
  url: string;
  /** instance-proxy urls are CORS-open — loadable by the browser directly */
  direct?: boolean;
}

export interface YtMedia {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  videoUrl: string;
  videoQuality: string;
  audioUrl: string;
  audioQuality: string;
  /** every selectable muxed quality, best first */
  sources?: YtQualitySource[];
  /** HLS manifest — live streams only */
  hlsUrl?: string;
}

function isYtSearchHit(v: unknown): v is YtSearchHit {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.videoId === "string" &&
    typeof o.title === "string" &&
    typeof o.author === "string" &&
    typeof o.durationSec === "number"
  );
}

function isYtMedia(v: unknown): v is YtMedia {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.videoId === "string" &&
    typeof o.title === "string" &&
    typeof o.videoUrl === "string" &&
    typeof o.audioUrl === "string"
  );
}

function looksLikeYtUrl(s: string): boolean {
  return /youtu\.?be/i.test(s) || /^[\w-]{11}$/.test(s.trim());
}

function mediaFromInv(m: InvMedia): YtMedia {
  const audio = m.audio[0];
  const muxed = m.muxed[0];
  return {
    videoId: m.videoId,
    title: m.title,
    author: m.author,
    durationSec: m.lengthSec,
    videoUrl: muxed?.url ?? "",
    videoQuality: muxed?.qualityLabel ?? (muxed ? "muxed" : "none"),
    audioUrl: audio?.url ?? "",
    audioQuality: audio ? `${Math.round(audio.bitrate / 1000)}k` : "none",
    sources: m.muxed.map((f) => ({
      quality: f.qualityLabel || f.itag || "muxed",
      url: f.url,
      direct: true,
    })),
    ...(m.hlsUrl ? { hlsUrl: m.hlsUrl } : {}),
  };
}

function mediaFromPiped(m: PipedMedia): YtMedia {
  const best = m.muxed[0];
  return {
    videoId: m.videoId,
    title: m.title,
    author: m.author,
    durationSec: m.durationSec,
    videoUrl: best?.url ?? "",
    videoQuality: best?.quality ?? "muxed",
    audioUrl: best?.url ?? "", // an <audio> plays the mp4's audio track fine
    audioQuality: "muxed",
    sources: m.muxed.map((f) => ({ quality: f.quality, url: f.url, direct: true })),
    ...(m.hlsUrl ? { hlsUrl: m.hlsUrl } : {}),
  };
}

/** Resolve a youtube url / id into streamable urls (invidious → piped →
 *  server chain). Instance-proxy urls play from anywhere. */
export async function resolveYt(input: string): Promise<YtMedia> {
  const id = looksLikeYtUrl(input)
    ? (/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/.exec(input)?.[1] ??
      (/^[\w-]{11}$/.test(input.trim()) ? input.trim() : ""))
    : input.trim();
  if (!id || !/^[\w-]{11}$/.test(id)) throw new Error("yt: not a youtube url or id");

  // 1. the browser's own race against the invidious pool (residential ip)
  const inv = await invResolve(id).catch(() => null);
  if (inv) return mediaFromInv(inv);

  // 2. the piped pool (its LBRY mirrors dodge walls invidious can't)
  const piped = await pipedResolve(id).catch(() => null);
  if (piped) return mediaFromPiped(piped);

  // 3. server fallback (its egress sometimes answers when ours doesn't)
  const res = await fetch(`/api/yt?u=${encodeURIComponent(id)}`);
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok || typeof data !== "object" || data === null) {
    const msg =
      typeof (data as { error?: unknown })?.error === "string"
        ? (data as { error: string }).error
        : `yt resolve failed (${res.status})`;
    throw new Error(msg);
  }
  if (!isYtMedia(data)) throw new Error("yt: bad resolver response");
  return data;
}

/**
 * Search youtube via invidious. Browser race first, server fallback.
 * Throws with a joined message when EVERY path is walled.
 */
export async function searchYt(query: string): Promise<YtSearchHit[]> {
  let serverErr: unknown = null;

  // 1. the user's browser vs the instance pool — the path that actually works
  try {
    const hits = await invSearch(query);
    if (hits && hits.length > 0) {
      return hits.map((h) => ({
        videoId: h.videoId,
        title: h.title,
        author: h.author,
        durationSec: h.lengthSec,
        authorId: h.authorId || undefined,
        thumb: h.thumb,
        live: h.live || undefined,
      }));
    }
  } catch {
    /* fall through to the server */
  }

  // 2. server chain (different egress — often the second wind)
  try {
    const res = await fetch(`/api/yt?search=${encodeURIComponent(query)}`);
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok || typeof data !== "object" || data === null) {
      const msg =
        typeof (data as { error?: unknown })?.error === "string"
          ? (data as { error: string }).error
          : `yt search failed (${res.status})`;
      throw new Error(msg);
    }
    const results = (data as { results?: unknown }).results;
    if (!Array.isArray(results)) throw new Error("yt: bad search response");
    const hits = results.filter(isYtSearchHit);
    if (hits.length === 0) throw new Error("yt: search came back empty");
    // the server chain doesn't ship thumbs — canonical i.ytimg thumbs keep
    // the rows visual no matter which path answered
    return hits.map((h) => ({ ...h, thumb: h.thumb ?? ytThumb(h.videoId, "hq") }));
  } catch (e) {
    serverErr = e;
  }

  throw new Error(
    serverErr instanceof Error ? serverErr.message : "every invidious instance failed",
  );
}

/** channel uploads for the artist page (browser race → server fallback) */
export async function channelYt(authorId: string): Promise<YtSearchHit[]> {
  try {
    const hits = await invChannel(authorId);
    if (hits && hits.length > 0) {
      return hits.map((h) => ({
        videoId: h.videoId,
        title: h.title,
        author: h.author,
        durationSec: h.lengthSec,
        authorId: h.authorId || undefined,
        thumb: h.thumb,
        live: h.live || undefined,
      }));
    }
  } catch {
    /* fall through */
  }
  const res = await fetch(`/api/yt?channel=${encodeURIComponent(authorId)}`);
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok || typeof data !== "object" || data === null) return [];
  const results = (data as { results?: unknown }).results;
  return Array.isArray(results)
    ? results
        .filter(isYtSearchHit)
        .map((h) => ({ ...h, thumb: h.thumb ?? ytThumb(h.videoId, "hq") }))
    : [];
}

/** channel lookup by name (artist search box) */
export async function findChannels(
  query: string,
): Promise<{ authorId: string; author: string }[]> {
  try {
    const hits = await invSearchChannels(query);
    if (hits && hits.length > 0) {
      return hits.map((h) => ({ authorId: h.authorId, author: h.author }));
    }
  } catch {
    /* fall through */
  }
  const res = await fetch(`/api/yt?artist=${encodeURIComponent(query)}`);
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok || typeof data !== "object" || data === null) return [];
  const results = (data as { results?: unknown }).results;
  return Array.isArray(results)
    ? results.filter(
        (r): r is { authorId: string; author: string } =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as { authorId?: unknown }).authorId === "string",
      )
    : [];
}

/** True when the arg smells like a yt link / id (used to route commands). */
export function isYtInput(s: string): boolean {
  return looksLikeYtUrl(s.trim());
}

/** "3:42" style duration for listings. */
export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
