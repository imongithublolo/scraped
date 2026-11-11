/**
 * INVIDIOUS CLIENT — the one media backend for music + watch.
 *
 * WHY CLIENT-FIRST: invidious instances wall datacenter egress (the server
 * AND vercel get 403/challenge pages), but the USER'S BROWSER rides a
 * residential ip that instances answer happily. Their API ships
 * `Access-Control-Allow-Origin: *`, so the browser can search, resolve
 * channels AND read /videos directly — no server in the loop at all.
 * The server chain (/api/yt) is the fallback for when the browser itself
 * is proxied/walled (scramjet frames, weird extensions).
 *
 * STREAMS: youtube stream urls are IP-locked to whoever asked. Invidious
 * rewrites them through the instance's own proxy with `local=true` — those
 * URLs play from ANYWHERE. Every format url here is normalized to
 * local=true. Bytes flow either through our same-origin pipe
 * (/api/stream — survives COEP, handles Range) or straight from the
 * instance (CORS-clean) as fallback links.
 *
 * NOTHING here is an iframe — no embeds, no youtube player. Just JSON
 * APIs and byte urls.
 */

/* ------------------------------- types ------------------------------- */

export interface InvHit {
  videoId: string;
  title: string;
  author: string;
  authorId: string;
  lengthSec: number;
  /** ~360p/720p i.ytimg thumb — always proxied through /api/artwork */
  thumb?: string;
  live?: boolean;
}

export interface InvFormat {
  url: string;
  itag: string;
  mime: string;
  /** bits per second when the instance reports it */
  bitrate: number;
  qualityLabel: string;
  /** "audio" | "muxed" | "video" */
  kind: "audio" | "muxed" | "video";
}

export interface InvMedia {
  videoId: string;
  title: string;
  author: string;
  authorId: string;
  lengthSec: number;
  live: boolean;
  /** audio-only formats, best first */
  audio: InvFormat[];
  /** muxed (video+audio in one file) formats, best first */
  muxed: InvFormat[];
  /** video-only adaptive formats, best first (no sound — advanced use) */
  video: InvFormat[];
  /** HLS manifest (live streams) — hls.js feeds it */
  hlsUrl?: string;
}

/* ----------------------------- instances ----------------------------- */

/**
 * Instance pool, most-reliable-first. The whole pool RACES — a dead,
 * challenge-walled or empty instance costs nothing. Cloudflare-walled
 * ones (403 from datacenter ips) answer real browsers, so they stay in.
 */
export const INV_INSTANCES: string[] = [
  "https://inv.nadeko.net",
  "https://yewtu.be",
  "https://invidious.nerdvpn.de",
  "https://invidious.private.coffee",
  "https://iv.melmac.space",
  "https://invidious.materialio.us",
  "https://invidious.jing.rocks",
  "https://invidious.f5.si",
  "https://iv.duti.dev",
  "https://invidious.privacyredirect.com",
  "https://invidious.reallyaweso.me",
  "https://invidious.dhusch.de",
  "https://invidious.perennialte.ch",
  "https://invidious.protokolla.fi",
];

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/* -------------------------- instance health --------------------------- */

/**
 * Instances die constantly, so every op runs against a LIVE pool, not the
 * raw list. Two signals feed it:
 *
 *  1. PROBE — one cheap /api/v1/stats.json ping per instance (3.5s cap,
 *     all in parallel, cached for 5 min). Marks outright-dead hosts before
 *     any real traffic so searches don't stall on corpses.
 *  2. STRIKES — every real op that exhausts the pool marks each participant
 *     failed; two strikes inside the TTL drops an instance from the pool
 *     until the next probe revives it. A winner clears its record.
 *
 * If health says everything is dead the FULL pool races anyway (honest
 * attempt beats giving up), and the /api/inv server race stays behind
 * everything as the last resort.
 */

const HEALTH_TTL_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 3500;
const STRIKES_TO_SKIP = 2;
/** tiny + rarely-walled; existence of any JSON proves the v1 api answers */
const PROBE_PATH = "/api/v1/stats.json?fields=software";

interface InstanceHealth {
  alive: boolean;
  at: number;
  strikes: number;
}

const health = new Map<string, InstanceHealth>();
/** in-flight probe shared by concurrent callers */
let probeRun: Promise<{ alive: number; total: number }> | null = null;

function countAlive(): number {
  return INV_INSTANCES.filter((b) => health.get(b)?.alive === true).length;
}

function healthSnapshot(): { alive: number; total: number } {
  return { alive: countAlive(), total: INV_INSTANCES.length };
}

/** a winner is healthy by definition — forget its strikes */
function noteSuccess(base: string): void {
  health.set(base, { alive: true, at: Date.now(), strikes: 0 });
}

/** the pool exhausted on this op — every participant takes a strike */
function noteFailure(base: string): void {
  const h = health.get(base) ?? { alive: true, at: Date.now(), strikes: 0 };
  h.strikes += 1;
  h.at = Date.now();
  if (h.strikes >= STRIKES_TO_SKIP) h.alive = false;
  health.set(base, h);
}

/**
 * Probe every stale instance in parallel (cheap, cached). Never throws;
 * on total probe failure the pool simply stays unfiltered.
 */
export async function probeInstances(
  onStatus?: (msg: string) => void,
): Promise<{ alive: number; total: number }> {
  const now = Date.now();
  const allDead = countAlive() === 0 && health.size > 0;
  const newest = Math.max(...INV_INSTANCES.map((b) => health.get(b)?.at ?? 0), 0);
  /** a believed-dead pool re-probes every 30s so recovery is quick;
   *  a healthy pool only re-probes after the TTL */
  const reprobeAll =
    allDead && now - newest > 30_000 ? INV_INSTANCES : INV_INSTANCES.filter((b) => {
      const h = health.get(b);
      return !h || now - h.at > HEALTH_TTL_MS;
    });
  if (reprobeAll.length === 0) return healthSnapshot();
  if (probeRun) return probeRun;
  onStatus?.(`checking ${INV_INSTANCES.length} invidious instances…`);
  probeRun = (async () => {
    await Promise.all(
      reprobeAll.map(async (b) => {
        const alive = (await getJson<unknown>(b, PROBE_PATH, PROBE_TIMEOUT_MS)) !== null;
        health.set(b, { alive, at: Date.now(), strikes: 0 });
      }),
    );
    probeRun = null;
    return healthSnapshot();
  })();
  return probeRun;
}

/**
 * shared status plumbing — ops report what the pool is doing so the UI can
 * show "searching… 7 of 14 instances alive" instead of a silent hang.
 */
export type InvStatusFn = (msg: string) => void;

async function ensureProbed(onStatus?: InvStatusFn): Promise<{ alive: number; total: number }> {
  return probeInstances(onStatus);
}

/* --------------------------- url plumbing ---------------------------- */

/** youtube stream urls must ride the instance proxy — force local=true */
export function normalizeStreamUrl(raw: string): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (/googlevideo\.com$/i.test(u.hostname) && !u.searchParams.has("local")) {
      u.searchParams.set("local", "true");
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/** i.ytimg thumb for a video id (loads through /api/artwork in the UI) */
export function ytThumb(videoId: string, quality: "mq" | "hq" | "maxres" = "hq"): string {
  const file =
    quality === "mq" ? "mqdefault.jpg" : quality === "maxres" ? "maxresdefault.jpg" : "hqdefault.jpg";
  return `https://i.ytimg.com/vi/${videoId}/${file}`;
}

/** same-origin image proxy — thumbs never hotlink, so they ALWAYS load */
export function artUrl(src: string): string {
  return `/api/artwork?u=${encodeURIComponent(src)}`;
}

/* ------------------------------- race -------------------------------- */

/** fetch JSON from one instance with a hard timeout; null on any failure */
async function getJson<T>(base: string, path: string, timeoutMs: number): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
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

/**
 * Race the LIVE instance pool (health-filtered); the FIRST parser that
 * returns a non-empty value wins. Losers are abandoned (their abort timers
 * clean up). When the whole pool exhausts, every participant takes a strike
 * so the next op skips the corpses. If health filtered everyone out, the
 * full list races anyway — an honest attempt beats a guaranteed null.
 */
async function raceInstances<T>(
  pathOf: (base: string) => string,
  parse: (data: unknown) => T | null,
  timeoutMs = 6000,
): Promise<T | null> {
  const candidates = INV_INSTANCES.filter((b) => health.get(b)?.alive !== false);
  const bases = candidates.length > 0 ? candidates : INV_INSTANCES;
  return new Promise<T | null>((resolve) => {
    let pending = bases.length;
    let settled = false;
    if (pending === 0) {
      resolve(null);
      return;
    }
    for (const base of bases) {
      getJson<unknown>(base, pathOf(base), timeoutMs)
        .then((data) => {
          if (settled) return;
          const parsed = data !== null ? parse(data) : null;
          if (parsed !== null) {
            settled = true;
            noteSuccess(base);
            resolve(parsed);
            return;
          }
          if (--pending === 0 && !settled) {
            settled = true;
            for (const b of bases) noteFailure(b);
            resolve(null);
          }
        })
        .catch(() => {
          if (settled) return;
          if (--pending === 0 && !settled) {
            settled = true;
            for (const b of bases) noteFailure(b);
            resolve(null);
          }
        });
    }
  });
}

/* ------------------------------ parsing ------------------------------ */

interface RawThumb {
  quality?: string;
  url?: string;
}
interface RawVideo {
  type?: string;
  title?: string;
  videoId?: string;
  author?: string;
  authorId?: string;
  lengthSeconds?: number;
  liveNow?: boolean;
  videoThumbnails?: RawThumb[];
}
interface RawFormat {
  itag?: string;
  url?: string;
  type?: string;
  bitrate?: string | number;
  qualityLabel?: string;
  quality?: string;
  audioQuality?: string;
  container?: string;
  encoding?: string;
}
interface RawVideoDetail {
  title?: string;
  videoId?: string;
  author?: string;
  authorId?: string;
  lengthSeconds?: number;
  liveNow?: boolean;
  adaptiveFormats?: RawFormat[];
  formatStreams?: RawFormat[];
  videoThumbnails?: RawThumb[];
  hlsUrl?: string;
}

function pickThumb(v: RawVideo | RawVideoDetail): string | undefined {
  // ALWAYS the canonical i.ytimg thumb: invidious instances rewrite thumbs
  // onto their own host (/vi/<id>/...), which our /api/artwork allowlist
  // rightly refuses — i.ytimg.com is allowed, stable, and never walled.
  return typeof v.videoId === "string" && v.videoId ? ytThumb(v.videoId, "hq") : undefined;
}

export function invParseHits(data: unknown): InvHit[] | null {
  if (!Array.isArray(data)) return null;
  const hits: InvHit[] = [];
  for (const it of data as RawVideo[]) {
    if (it.type !== "video") continue;
    if (typeof it.videoId !== "string" || typeof it.title !== "string" || !it.title.trim()) continue;
    hits.push({
      videoId: it.videoId,
      title: it.title,
      author: typeof it.author === "string" && it.author ? it.author : "youtube",
      authorId: typeof it.authorId === "string" ? it.authorId : "",
      lengthSec:
        typeof it.lengthSeconds === "number" && it.lengthSeconds > 0 ? Math.round(it.lengthSeconds) : 0,
      thumb: pickThumb(it),
      live: it.liveNow === true,
    });
  }
  return hits.length > 0 ? hits : null;
}

function bitrateOf(f: RawFormat): number {
  const n = typeof f.bitrate === "string" ? parseInt(f.bitrate, 10) : f.bitrate;
  return Number.isFinite(n) ? Number(n) : 0;
}

/** normalize one raw format into our shape (kind derived from mime) */
function parseFormat(f: RawFormat, kind: InvFormat["kind"]): InvFormat | null {
  if (typeof f.url !== "string" || !/^https?:\/\//i.test(f.url)) return null;
  const mime = (f.type ?? "").split(";")[0].trim();
  return {
    url: normalizeStreamUrl(f.url),
    itag: String(f.itag ?? ""),
    mime: mime || "video/mp4",
    bitrate: bitrateOf(f),
    qualityLabel: f.qualityLabel ?? f.quality ?? (kind === "audio" ? "audio" : ""),
    kind,
  };
}

/** audio rank: m4a/mp4 first (universal decode), then webm opus, best bitrate */
function audioRank(f: InvFormat): number {
  const m = f.mime.toLowerCase();
  const isM4a = m.startsWith("audio/mp4") || m.includes("aac");
  const isOpus = m.includes("webm") || m.includes("opus");
  const tier = isM4a ? 0 : isOpus ? 1 : 2;
  return tier * 1_000_000_000 - f.bitrate;
}

export function invParseDetail(data: unknown): InvMedia | null {
  if (typeof data !== "object" || data === null) return null;
  const v = data as RawVideoDetail;
  if (typeof v.videoId !== "string" || !v.videoId) return null;
  const audio: InvFormat[] = [];
  const video: InvFormat[] = [];
  for (const f of v.adaptiveFormats ?? []) {
    const mime = (f.type ?? "").split(";")[0].trim().toLowerCase();
    if (mime.startsWith("audio/")) {
      const fmt = parseFormat(f, "audio");
      if (fmt) audio.push(fmt);
    } else if (mime.startsWith("video/")) {
      const fmt = parseFormat(f, "video");
      if (fmt) video.push(fmt);
    }
  }
  const muxed: InvFormat[] = [];
  for (const f of v.formatStreams ?? []) {
    const fmt = parseFormat(f, "muxed");
    if (fmt) muxed.push(fmt);
  }
  audio.sort((a, b) => audioRank(a) - audioRank(b));
  // itag 22 (720p) before 18 (360p) — higher bitrate first inside a tier
  muxed.sort((a, b) => b.bitrate - a.bitrate);
  video.sort((a, b) => b.bitrate - a.bitrate);
  const hlsUrl =
    typeof v.hlsUrl === "string" && v.hlsUrl.startsWith("http") ? normalizeStreamUrl(v.hlsUrl) : undefined;
  if (audio.length === 0 && muxed.length === 0 && !hlsUrl) return null; // live/drm/unplayable
  return {
    videoId: v.videoId,
    title: typeof v.title === "string" ? v.title : v.videoId,
    author: typeof v.author === "string" && v.author ? v.author : "youtube",
    authorId: typeof v.authorId === "string" ? v.authorId : "",
    lengthSec:
      typeof v.lengthSeconds === "number" && v.lengthSeconds > 0 ? Math.round(v.lengthSeconds) : 0,
    live: v.liveNow === true,
    audio,
    muxed,
    video,
    hlsUrl,
  };
}

/* ------------------------------- API --------------------------------- */

/** the /api/inv server race — fallback when the browser itself is walled.
 *  Hard client-side timeout: the route's own pool race can legitimately
 *  take ~12s (11s resolve deadline), but it must never hang the UI. */
const SERVER_FALLBACK_TIMEOUT_MS = 16_000;

async function serverFallback<T>(path: string): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SERVER_FALLBACK_TIMEOUT_MS);
  try {
    const res = await fetch(path, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as { ok?: boolean; hits?: T; media?: T };
    if (!j || j.ok !== true) return null;
    return (j.hits ?? j.media ?? null) as T | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Search videos. NATIVE yt-dlp ENGINE FIRST ("ytp") — our own box runs
 *  yt-dlp and streams the bytes itself, zero third parties anywhere. The
 *  public invidious pool only catches what the engine refuses (live-only
 *  streams the pipe can't serve). */
export async function invSearch(query: string, onStatus?: InvStatusFn): Promise<InvHit[] | null> {
  const native = await nativeHits(query, onStatus);
  if (native) return native;
  onStatus?.("native engine gave up — falling back to the public instance pool…");
  const q = encodeURIComponent(query);
  const direct = await raceInstances<InvHit[]>(() => `/api/v1/search?q=${q}&type=video&page=1`, invParseHits);
  if (direct) return direct;
  return serverFallback<InvHit[]>(`/api/inv?op=search&q=${q}`);
}

/** Full video detail (formats). NATIVE yt-dlp ENGINE FIRST ("ytp") —
 *  our server resolves and streams the media itself. Public invidious
 *  instances only catch live-only videos, which the native pipe refuses. */
export async function invResolve(videoId: string, onStatus?: InvStatusFn): Promise<InvMedia | null> {
  const native = await nativeMedia(videoId, onStatus);
  if (native) return native;
  onStatus?.("native engine gave up — falling back to the public instance pool…");
  const direct = await raceInstances<InvMedia>(
    () => `/api/v1/videos/${encodeURIComponent(videoId)}`,
    invParseDetail,
    7000,
  );
  if (direct) return direct;
  return serverFallback<InvMedia>(`/api/inv?op=resolve&id=${encodeURIComponent(videoId)}`);
}

/** One channel's uploads (artist pages). Null when every instance failed. */
export async function invChannel(authorId: string): Promise<InvHit[] | null> {
  const id = encodeURIComponent(authorId);
  await probeInstances();
  return raceInstances<InvHit[]>(
    () => `/api/v1/channels/${id}/videos`,
    invParseHits,
    8000,
  );
}

/** Search channels (artist lookup by name). Null when every instance failed. */
export async function invSearchChannels(query: string): Promise<InvHit[] | null> {
  const q = encodeURIComponent(query);
  await probeInstances();
  return raceInstances<InvHit[]>(() => `/api/v1/search?q=${q}&type=channel&page=1`, (data) => {
    if (!Array.isArray(data)) return null;
    const out: InvHit[] = [];
    for (const it of data as RawVideo[]) {
      if (it.type !== "channel") continue;
      if (typeof it.authorId !== "string" || typeof it.author !== "string") continue;
      out.push({
        videoId: "",
        title: it.author,
        author: it.author,
        authorId: it.authorId,
        lengthSec: 0,
        thumb: pickThumb(it),
      });
    }
    return out.length > 0 ? out : null;
  });
}

/* --------------------------- source chains ---------------------------- */

/**
 * Ordered playback chain for an INVOLUTE audio play (music). The pipe
 * leads (same-origin, COEP-proof, Range-aware); the direct instance url
 * rides behind it (CORS-*, browser-carried when our server is walled);
 * alternates trail. Every link is a REAL byte url — no embeds anywhere.
 */
export interface ChainLink {
  url: string;
  fmt?: string;
}

export function audioChainFrom(media: InvMedia): ChainLink[] {
  const links: ChainLink[] = [];
  const push = (url: string, fmt: string) => {
    if (url && !links.some((l) => l.url === url)) links.push({ url, fmt });
  };
  /** absolute urls ride the same-origin pipe; relative (native engine)
   *  urls are already ours and must not be double-wrapped */
  const wrap = (u: string) => (isNativeUrl(u) ? u : `/api/stream?u=${encodeURIComponent(u)}`);
  const audio = media.audio[0];
  const altAudio = media.audio[1];
  const muxed = media.muxed[0];
  if (audio) {
    push(wrap(audio.url), fmtOf(audio.mime));
    push(audio.url, fmtOf(audio.mime));
  }
  if (muxed) {
    push(wrap(muxed.url), fmtOf(muxed.mime));
    push(muxed.url, fmtOf(muxed.mime));
  }
  if (altAudio) {
    push(wrap(altAudio.url), fmtOf(altAudio.mime));
    push(altAudio.url, fmtOf(altAudio.mime));
  }
  return links;
}

/* ------------------------- native yt-dlp engine ----------------------- */

/**
 * THE ENGINE ("ytp"): /api/ytdlp runs yt-dlp on our own box — no third
 * parties anywhere. The stream urls it hands back are RELATIVE
 * (same-origin, our bytes), so they play from anywhere our origin does;
 * chains below must not re-wrap them in /api/stream (that pipe only takes
 * absolute urls). Used FIRST for everything; invidious only backstops it.
 */

async function nativeFetchJson(path: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, { cache: "no-store", signal: ctrl.signal });
    const j = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (!res.ok || !j || j.ok !== true) return null;
    return j as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface NativeHit {
  videoId?: string;
  title?: string;
  author?: string;
  durationSec?: number;
  live?: boolean;
}

/** native search — the FIRST choice; null when the engine is missing/walled */
async function nativeHits(query: string, onStatus?: InvStatusFn): Promise<InvHit[] | null> {
  onStatus?.("searching with the native yt-dlp engine (ytp)…");
  const j = await nativeFetchJson(`/api/ytdlp?search=${encodeURIComponent(query)}&limit=20`, 34_000);
  const hits = (j?.hits ?? null) as NativeHit[] | null;
  if (!Array.isArray(hits)) return null;
  const out: InvHit[] = [];
  for (const h of hits) {
    if (typeof h.videoId !== "string" || typeof h.title !== "string") continue;
    out.push({
      videoId: h.videoId,
      title: h.title,
      author: typeof h.author === "string" && h.author ? h.author : "youtube",
      authorId: "",
      lengthSec: typeof h.durationSec === "number" && h.durationSec > 0 ? Math.round(h.durationSec) : 0,
      thumb: ytThumb(h.videoId, "hq"),
      live: h.live === true,
    });
  }
  return out.length > 0 ? out : null;
}

interface NativeInfo {
  videoId?: string;
  title?: string;
  author?: string;
  durationSec?: number;
  isLive?: boolean;
  muxedHeights?: number[];
  mergeHeights?: number[];
  audioQuality?: string;
}

/** dlp stream urls are RELATIVE — chains must skip the /api/stream wrap */
function isNativeUrl(u: string): boolean {
  return u.startsWith("/");
}

function dlf(url: string, itag: string, mime: string, qualityLabel: string, kind: InvFormat["kind"]): InvFormat {
  return { url, itag, mime, bitrate: 0, qualityLabel, kind };
}

/**
 * native resolve — synthesize an InvMedia whose urls are our own engine:
 *   audio[0] proxy (Range/seek), audio[1] pipe (`-o -` stdout),
 *   muxed: proxy per progressive height, then pipe per playable height
 *   (ffmpeg merge lives behind the pipe variants).
 * null when the engine is down, walled, or the video is live-only.
 */
async function nativeMedia(videoId: string, onStatus?: InvStatusFn): Promise<InvMedia | null> {
  onStatus?.("resolving with the native yt-dlp engine (ytp)…");
  const j = await nativeFetchJson(`/api/ytdlp?info=1&u=${encodeURIComponent(videoId)}`, 34_000);
  if (!j || typeof j.videoId !== "string") return null;
  const info = j as NativeInfo;
  const id = info.videoId as string;
  const audio: InvFormat[] = [];
  if (info.audioQuality && info.audioQuality !== "none") {
    audio.push(dlf(`/api/ytdlp?u=${id}&kind=audio&mode=proxy`, "dl-a", "audio/mp4", "audio", "audio"));
    audio.push(dlf(`/api/ytdlp?u=${id}&kind=audio&mode=pipe`, "dl-b", "audio/mp4", "audio", "audio"));
  }
  const muxed: InvFormat[] = [];
  for (const h of (info.muxedHeights ?? []).slice(0, 4)) {
    muxed.push(dlf(`/api/ytdlp?u=${id}&kind=muxed&h=${h}&mode=proxy`, `dl-h${h}`, "video/mp4", `${h}p`, "muxed"));
  }
  const heights = [...new Set([...(info.muxedHeights ?? []), ...(info.mergeHeights ?? [])])]
    .sort((a, b) => b - a)
    .slice(0, 4);
  for (const h of heights) {
    muxed.push(dlf(`/api/ytdlp?u=${id}&kind=muxed&h=${h}&mode=pipe`, `dlp-h${h}`, "video/mp4", `${h}p`, "muxed"));
  }
  if (audio.length === 0 && muxed.length === 0) return null; // live-only / nothing
  return {
    videoId: id,
    title: typeof info.title === "string" && info.title ? info.title : id,
    author: typeof info.author === "string" && info.author ? info.author : "youtube",
    authorId: "",
    lengthSec: typeof info.durationSec === "number" && info.durationSec > 0 ? Math.round(info.durationSec) : 0,
    live: info.isLive === true,
    audio,
    muxed,
    video: [],
  };
}

/** video chain for watch — muxed (video+audio) formats, best first */
export function videoChainFrom(media: InvMedia): { quality: string; url: string }[] {
  const out: { quality: string; url: string }[] = [];
  for (const f of media.muxed) {
    out.push({ quality: f.qualityLabel || f.itag, url: f.url });
  }
  // last-resort: video-only adaptive stream (silent picture is better than
  // nothing and the chain below it still has muxed audio fallbacks in the
  // caller when provided) — kept LAST so it never preempts real playback
  for (const f of media.video.slice(0, 1)) {
    if (!out.some((o) => o.url === f.url)) {
      out.push({ quality: `${f.qualityLabel || f.itag} (no audio)`, url: f.url });
    }
  }
  return out;
}

/** howler format hint from a mime */
export function fmtOf(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("mp4") || m.includes("aac") || m.includes("m4a")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  return "mp4";
}
