/**
 * Audio playback glue between the invidious resolver and the howler
 * music singleton. Shared by the `music yt` command and the MusicPane.
 *
 * DOCTRINE — INVIDIOUS, FULL LENGTH, NO IFRAMES (the embed-first era is
 * over): every play resolves against the instance pool from the USER'S
 * OWN BROWSER (residential ip — instances wall datacenters, not people),
 * then hands the player a chain of REAL byte urls:
 *
 *   1. /api/stream?u=<best audio>   — same-origin pipe (COEP-proof, Range)
 *   2. <best audio> direct          — instance proxy is CORS-*, browser-carried
 *   3. /api/stream?u=<muxed>        — video bytes as a last audio source
 *   4. <muxed> direct
 *   5. alternate audio format
 *
 * The howler player walks DOWN the chain on its own when a link refuses
 * to load/play (watchdog + failover in player.ts). When the whole chain
 * is dead the track errors out honestly — there is NO 30s-preview
 * fallback anywhere in this system anymore.
 *
 * Every link carries an explicit howler format hint — howler refuses any
 * extension-less url BEFORE fetching a byte. Instance-proxy urls expire
 * (~6h local proxy, faster in practice), so every PLAY resolves fresh
 * and stale queue replays re-resolve via the player's refresher hook.
 */

import { musicPlayer, type ChainLink } from "./player";
import { fmtOf } from "./inv";
import { resolveYt, type YtMedia } from "./yt";

/** same-origin pipe wrapper for remote urls — native-engine urls are
 *  already ours (relative) and pass through untouched */
export function pipeUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? `/api/stream?u=${encodeURIComponent(u)}` : u;
}

/** the ordered src chain for a resolved yt audio track (deduped, hinted) */
export function buildAudioChain(media: YtMedia): ChainLink[] {
  const chain: ChainLink[] = [];
  const push = (url: string, fmt: string) => {
    if (url && !chain.some((l) => l.url === url)) chain.push({ url, fmt });
  };
  const audioFmt = media.audioQuality && media.audioQuality !== "none" ? "m4a" : "m4a";
  if (media.audioUrl) {
    push(pipeUrl(media.audioUrl), audioFmt);
    push(media.audioUrl, audioFmt);
  }
  for (const s of (media.sources ?? []).slice(0, 2)) {
    push(pipeUrl(s.url), "mp4");
    push(s.url, "mp4");
  }
  return chain;
}

export type YtAudioResult =
  | { ok: true; media: YtMedia }
  | { ok: false; live: boolean; error: string; media?: YtMedia };

/** memoized background resolves — one resolve per videoId per session */
const resolveMemo = new Map<string, Promise<YtMedia>>();

function resolveOnce(videoId: string): Promise<YtMedia> {
  let p = resolveMemo.get(videoId);
  if (!p) {
    p = resolveYt(videoId);
    resolveMemo.set(videoId, p);
    // a dead resolve must not poison the memo forever — retry next play
    p.catch(() => resolveMemo.delete(videoId));
  }
  return p;
}

/**
 * Play a youtube video/id through the music singleton as a FULL-LENGTH
 * invidious stream. Resolves first (the browser race is fast), then
 * starts playback with the whole chain in place — a 30s preview is
 * impossible by construction. Live streams have no static bytes: they
 * report { ok:false, live:true }.
 */
export async function playYtVideo(
  videoId: string,
  opts?: { trackId?: string; name?: string },
): Promise<YtAudioResult> {
  if (typeof window === "undefined") {
    return { ok: false, live: false, error: "player unavailable outside the browser" };
  }
  let media: YtMedia;
  try {
    media = await resolveOnce(videoId);
  } catch (e) {
    return {
      ok: false,
      live: false,
      error: e instanceof Error ? e.message : "invidious resolve failed",
    };
  }
  if (!media.audioUrl && (media.sources ?? []).length === 0) {
    return { ok: false, live: true, error: "live stream — no static bytes", media };
  }
  const id = opts?.trackId ?? `yt:${videoId}`;
  const name = opts?.name ?? (media.title || videoId);
  const chain = buildAudioChain(media);
  if (chain.length === 0) {
    return { ok: false, live: true, error: "no playable formats", media };
  }
  const started = musicPlayer.playExternal(id, name, chain[0].url, {
    fmt: chain[0].fmt,
    videoId,
    fallbacks: chain.slice(1),
  });
  if (!started) return { ok: false, live: false, error: "player refused the stream" };
  return { ok: true, media };
}

/** player hook — stale yt tracks resolve fresh here before replay */
async function refreshYtTrack(videoId: string, id: string, name: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  resolveMemo.delete(videoId);
  const r = await playYtVideo(videoId, { trackId: id, name });
  return r.ok;
}

/** attach resolved stream links BEHIND an already-playing track (the
 *  embed-first strategy: youtube's player carries the song, and these
 *  links sit in the chain for the rare video whose embed refuses). */
export async function attachYtFallbacks(trackId: string, videoId: string): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const media = await resolveOnce(videoId);
    const chain = buildAudioChain(media);
    if (chain.length > 0) musicPlayer.addFallbacks(trackId, chain);
  } catch {
    /* the embed is playing — the fallbacks were a nice-to-have */
  }
}

// idempotent: both consumers import this module, the last registration wins
if (typeof window !== "undefined") {
  musicPlayer.setRefresher(refreshYtTrack);
  musicPlayer.setFallbackProvider(async (_id, videoId) => {
    // last gasp before an honest error: ONE fresh resolve — instances
    // fail transiently, and a retry from the same egress often lands.
    // Returns [] on failure (never hands back dead urls — no loops).
    if (!videoId) return [];
    try {
      resolveMemo.delete(videoId);
      const media = await resolveYt(videoId);
      return buildAudioChain(media);
    } catch {
      return [];
    }
  });
}
