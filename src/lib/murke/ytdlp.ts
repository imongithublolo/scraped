/**
 * YT-DLP ENGINE — the native, zero-third-party media backbone.
 *
 * SERVER ONLY (node runtime). This is the direct answer to the invidious
 * problem: public instances wall datacenter ips, so instead of scraping
 * someone else's proxy we run yt-dlp RIGHT HERE and pipe the bytes
 * straight to the client over stdout (`-o -`) — nothing ever touches the
 * disk. No cobalt, no invidious, no piped, no embeds — just yt-dlp and
 * the youtube cdn.
 *
 * Two transports, chosen per request by the route:
 *
 *   pipe  — `yt-dlp -f <fmt> -o - <url>` streamed straight from the
 *           child's stdout. The literal ask. No Range support (a pipe
 *           can't rewind), so scrubbing rides the player's own buffer.
 *   proxy — yt-dlp resolves (JSON), we fetch the chosen format's cdn url
 *           SERVER-SIDE with Range passthrough and stream it out. Full
 *           seeking, byte-exact 206s — the cdn url is ip-locked to
 *           whoever asked, and that's us, so this only works in-process.
 *
 * BOT WALL REALITY: youtube flags datacenter ips ("sign in to confirm
 * you're not a bot"). When the default client is refused we rotate
 * through the alternate player clients (android_vr, tv, ios) — whichever
 * one the local ip can pass is remembered for the process lifetime. If
 * EVERY client is walled the error surfaces honestly; the operator can
 * then drop a cookies file via YTDLP_COOKIES_FILE (native youtube
 * session, no third party) and/or route yt-dlp through their own proxy
 * via YTDLP_EXTRA_ARGS (e.g. `--proxy http://...`). On a residential or
 * unflagged server the plain pipe just works.
 *
 * The binary is resolved once (env override → PATH → the usual venv
 * spots → `python3 -m yt_dlp`) and cached. Everything here spawns and
 * streams — no npm fetch layer, no api keys.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/* ------------------------------ types ------------------------------- */

export interface DlpHit {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  live?: boolean;
}

export interface DlpFormat {
  formatId: string;
  ext: string;
  height?: number;
  /** audio bitrate kbps when reported */
  abr?: number;
  vcodec: string;
  acodec: string;
  /** exact bytes when youtube reports them */
  filesize?: number;
  url?: string;
}

export interface DlpInfo {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  isLive: boolean;
  /** muxed (progressive video+audio) heights, best first */
  muxedHeights: number[];
  /** video-only heights that ffmpeg can merge with bestaudio, best first */
  mergeHeights: number[];
  /** best audio bitrate, "129k" style — "none" when silent */
  audioQuality: string;
  formats: DlpFormat[];
}

/* --------------------------- binary lookup --------------------------- */

interface Engine {
  cmd: string;
  baseArgs: string[];
}

let engineCache: Promise<Engine | null> | null = null;

function candidates(): string[] {
  const home = homedir();
  return [
    process.env.YTDLP_PATH ?? "",
    "yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    "/opt/homebrew/bin/yt-dlp",
    path.join(home, ".local/bin/yt-dlp"),
    path.join(home, ".venv/bin/yt-dlp"),
    "/home/z/.venv/bin/yt-dlp",
  ].filter(Boolean);
}

async function probeEngine(): Promise<Engine | null> {
  for (const cmd of candidates()) {
    const ok = await new Promise<boolean>((done) => {
      const p = spawn(cmd, ["--version"], { stdio: "ignore" });
      p.on("error", () => done(false));
      p.on("close", (code) => done(code === 0));
      setTimeout(() => {
        p.kill("SIGKILL");
        done(false);
      }, 8000).unref();
    });
    if (ok) return { cmd, baseArgs: [] };
  }
  // last gasp: python module form
  for (const py of ["python3", "/home/z/.venv/bin/python3", "/usr/bin/python3"]) {
    const ok = await new Promise<boolean>((done) => {
      const p = spawn(py, ["-m", "yt_dlp", "--version"], { stdio: "ignore" });
      p.on("error", () => done(false));
      p.on("close", (code) => done(code === 0));
      setTimeout(() => {
        p.kill("SIGKILL");
        done(false);
      }, 12000).unref();
    });
    if (ok) return { cmd: py, baseArgs: ["-m", "yt_dlp"] };
  }
  return null;
}

/** the resolved engine — null when yt-dlp isn't installed on this host */
export function getEngine(): Promise<Engine | null> {
  if (!engineCache) engineCache = probeEngine();
  return engineCache;
}

/* ----------------------------- arguments ----------------------------- */

/** player clients to rotate through when the wall bites */
const CLIENTS = ["default", "android_vr", "tv", "ios"] as const;
let goodClient: string | null = null;

function commonArgs(): string[] {
  const args = ["--no-playlist", "--no-warnings", "--no-progress", "--no-color"];
  if (process.env.YTDLP_COOKIES_FILE && existsSync(process.env.YTDLP_COOKIES_FILE)) {
    args.push("--cookies", process.env.YTDLP_COOKIES_FILE);
  }
  if (process.env.YTDLP_EXTRA_ARGS) {
    // operator escape hatch: extra flags split on whitespace (e.g. --proxy …)
    args.push(...process.env.YTDLP_EXTRA_ARGS.trim().split(/\s+/));
  }
  return args;
}

function clientArgs(client: string): string[] {
  if (client === "default") return [];
  return ["--extractor-args", `youtube:player_client=${client}`];
}

export function isBotWall(stderr: string): boolean {
  return /sign in to confirm|not a bot|confirm you.?re not/i.test(stderr);
}

/* ------------------------------ spawn -------------------------------- */

interface RunOut {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** buffered run with a hard deadline — for JSON extraction */
function runEngine(args: string[], deadlineMs: number): Promise<RunOut> {
  return new Promise(async (resolve) => {
    const engine = await getEngine();
    if (!engine) {
      resolve({ code: -1, stdout: "", stderr: "yt-dlp is not installed on the server" });
      return;
    }
    const child = spawn(engine.cmd, [...engine.baseArgs, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) child.kill("SIGKILL");
    }, deadlineMs);
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    };
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) => {
      err += String(e);
      finish(-1);
    });
    child.on("close", (code) => finish(code));
  });
}

/* ------------------------------- search ------------------------------ */

interface FlatEntry {
  id?: string;
  title?: string;
  duration?: number;
  channel?: string;
  uploader?: string;
  live_status?: string;
}

/** ytsearch via yt-dlp's own flat extractor — works even where the player
 *  api is walled, because it scrapes the results page only. */
export async function ytdlpSearch(query: string, limit = 20): Promise<DlpHit[] | null> {
  const n = Math.max(1, Math.min(30, Math.round(limit)));
  const r = await runEngine(
    [...commonArgs(), "-J", "--flat-playlist", `ytsearch${n}:${query}`],
    30000,
  );
  if (r.code !== 0 || !r.stdout.trim()) return null;
  let data: { entries?: FlatEntry[] };
  try {
    data = JSON.parse(r.stdout) as { entries?: FlatEntry[] };
  } catch {
    return null;
  }
  const hits: DlpHit[] = [];
  for (const e of data.entries ?? []) {
    if (typeof e.id !== "string" || typeof e.title !== "string" || !e.title.trim()) continue;
    hits.push({
      videoId: e.id,
      title: e.title,
      author: typeof e.channel === "string" && e.channel ? e.channel : typeof e.uploader === "string" ? e.uploader : "youtube",
      durationSec: typeof e.duration === "number" && e.duration > 0 ? Math.round(e.duration) : 0,
      live: e.live_status === "is_live" || undefined,
    });
  }
  return hits.length > 0 ? hits : null;
}

/* -------------------------------- info ------------------------------- */

interface RawFormat {
  format_id?: string;
  ext?: string;
  height?: number;
  abr?: number;
  vcodec?: string;
  acodec?: string;
  filesize?: number;
  url?: string;
  protocol?: string;
}

interface RawInfo {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  is_live?: boolean;
  url?: string;
  manifest_url?: string;
  formats?: RawFormat[];
}

function parseInfo(raw: RawInfo): DlpInfo | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  const formats: DlpFormat[] = [];
  const muxedHeights = new Set<number>();
  const mergeHeights = new Set<number>();
  let bestAbr = 0;
  for (const f of raw.formats ?? []) {
    if (typeof f.format_id !== "string") continue;
    // streamable http(s) only — fragmented dash/m3u8 pipes badly
    const proto = f.protocol ?? "https";
    if (proto.includes("m3u8") || proto.includes("dash")) continue;
    const vc = f.vcodec ?? "none";
    const ac = f.acodec ?? "none";
    const height = typeof f.height === "number" && f.height > 0 ? f.height : undefined;
    if (vc !== "none" && ac !== "none" && height) muxedHeights.add(height);
    if (vc !== "none" && height) mergeHeights.add(height);
    if (ac !== "none" && typeof f.abr === "number" && f.abr > bestAbr) bestAbr = f.abr;
    formats.push({
      formatId: f.format_id,
      ext: f.ext ?? "mp4",
      height,
      abr: typeof f.abr === "number" ? f.abr : undefined,
      vcodec: vc,
      acodec: ac,
      filesize: typeof f.filesize === "number" && f.filesize > 0 ? f.filesize : undefined,
      url: typeof f.url === "string" && /^https?:\/\//i.test(f.url) ? f.url : undefined,
    });
  }
  const desc = (a: number, b: number) => b - a;
  return {
    videoId: raw.id,
    title: typeof raw.title === "string" && raw.title ? raw.title : raw.id,
    author: (typeof raw.channel === "string" && raw.channel) || (typeof raw.uploader === "string" && raw.uploader) || "youtube",
    durationSec: typeof raw.duration === "number" && raw.duration > 0 ? Math.round(raw.duration) : 0,
    isLive: raw.is_live === true,
    muxedHeights: [...muxedHeights].sort(desc),
    mergeHeights: [...mergeHeights].sort(desc),
    audioQuality: bestAbr > 0 ? `${Math.round(bestAbr)}k` : "none",
    formats,
  };
}

const INFO_TTL = 90_000;
const infoCache = new Map<string, { at: number; info: DlpInfo }>();

export function normalizeYtInput(u: string): string | null {
  const s = u.trim();
  if (/^[\w-]{11}$/.test(s)) return `https://www.youtube.com/watch?v=${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  const m = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/.exec(s);
  return m ? `https://www.youtube.com/watch?v=${m[1]}` : null;
}

/**
 * Resolve metadata + formats, rotating player clients when the bot wall
 * bites. The winning client is remembered for the process lifetime so a
 * warm server never pays the rotation tax twice.
 */
export async function ytdlpInfo(input: string, deadlineMs = 26_000): Promise<DlpInfo | null> {
  const url = normalizeYtInput(input);
  if (!url) return null;
  const key = /([\w-]{11})\.?.*$/.exec(url)?.[1]?.slice(0, 11) ?? url;
  const cached = infoCache.get(key);
  if (cached && Date.now() - cached.at < INFO_TTL) return cached.info;

  const order = goodClient ? [goodClient, ...CLIENTS.filter((c) => c !== goodClient)] : [...CLIENTS];
  const perClient = Math.max(6000, Math.floor(deadlineMs / order.length));
  let lastErr = "";
  for (const client of order) {
    const r = await runEngine(
      [...commonArgs(), ...clientArgs(client), "-J", url],
      perClient,
    );
    if (r.code === 0 && r.stdout.trim()) {
      try {
        const info = parseInfo(JSON.parse(r.stdout) as RawInfo);
        if (info) {
          goodClient = client;
          infoCache.set(key, { at: Date.now(), info });
          return info;
        }
      } catch {
        /* json glitch — try the next client */
      }
    }
    lastErr = r.stderr || lastErr;
    // a wall on this client is worth rotating; anything else usually isn't
    if (!isBotWall(r.stderr) && r.code !== 0 && !/unable to download|http error 5|temporarily/i.test(r.stderr)) {
      break;
    }
  }
  if (lastErr) throw new Error(cleanErr(lastErr));
  return null;
}

/** strip yt-dlp's log noise down to the sentence that matters */
export function cleanErr(stderr: string): string {
  const lines = stderr.split("\n").filter((l) => l.startsWith("ERROR") || l.includes("Sign in"));
  const msg = (lines[lines.length - 1] ?? stderr.split("\n").filter(Boolean).pop() ?? "yt-dlp failed")
    .replace(/^ERROR:\s*/, "")
    .replace(/\s*\[youtube\]\s*[\w-]+:\s*/, " ")
    .trim();
  if (isBotWall(msg)) {
    return `${msg} — youtube is walling this server's ip. set YTDLP_COOKIES_FILE to a netscape cookies export (native, no third party) or point YTDLP_EXTRA_ARGS at your own proxy.`;
  }
  return msg.slice(0, 300) || "yt-dlp failed";
}

/* ------------------------------- stream ------------------------------ */

export interface PipeSelection {
  selector: string;
  ext: string;
  mime: string;
  /** true when the selector needs an ffmpeg merge (bv+ba) */
  merge: boolean;
}

/** pick the yt-dlp format selector for a stream request */
export function pickSelector(info: DlpInfo, kind: "audio" | "muxed", height?: number): PipeSelection {
  if (kind === "audio") {
    return { selector: "bestaudio[ext=m4a]/bestaudio/best", ext: "m4a", mime: "audio/mp4", merge: false };
  }
  const h = height ?? 0;
  // progressive (muxed) first — a single stream pipes clean without ffmpeg
  const prog = info.muxedHeights.filter((x) => x <= h);
  if (prog.length > 0) {
    const cap = Math.max(...prog);
    return {
      selector: `b[height<=${cap}]/b`,
      ext: "mp4",
      mime: "video/mp4",
      merge: false,
    };
  }
  // merge territory — needs ffmpeg on the host; yt-dlp muxes to stdout.
  // mkv is the pipe-native container (real header, streamable, and every
  // browser worth the name plays its vp9/av1 + opus/aac payloads)
  const merge = info.mergeHeights.filter((x) => x <= h);
  if (merge.length > 0) {
    const cap = Math.max(...merge);
    return {
      selector: `bv*[height<=${cap}]+ba/b[height<=${cap}]/b`,
      ext: "mkv",
      mime: "video/x-matroska",
      merge: true,
    };
  }
  // honest fallback: whatever plays
  return { selector: "b/bv*+ba/b", ext: "mkv", mime: "video/x-matroska", merge: true };
}

/** the chosen format's direct cdn url (proxy mode) — null when absent */
export function pickDirectUrl(info: DlpInfo, kind: "audio" | "muxed", height?: number): { url: string; mime: string } | null {
  const okProto = (f: DlpFormat) => Boolean(f.url);
  if (kind === "audio") {
    const cands = info.formats
      .filter((f) => f.acodec !== "none" && f.vcodec === "none" && okProto(f))
      .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0));
    const f = cands[0];
    if (!f?.url) return null;
    return { url: f.url, mime: f.ext === "webm" ? "audio/webm" : "audio/mp4" };
  }
  const h = height ?? Infinity;
  const cands = info.formats
    .filter((f) => f.vcodec !== "none" && f.acodec !== "none" && okProto(f) && f.height && f.height <= h)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  const f = cands[0];
  if (!f?.url) return null;
  return { url: f.url, mime: f.ext === "webm" ? "video/webm" : "video/mp4" };
}

/** in-flight children cap — a public os shouldn't fork-bomb itself */
let activePipes = 0;

/**
 * Spawn `yt-dlp -f <selector> -o - <url>` and hand back the child.
 * The caller owns the stdout pipe and MUST kill() on client disconnect —
 * nothing is ever buffered to disk anywhere in this path.
 */
export async function spawnPipe(
  input: string,
  selector: string,
  extraArgs: string[] = [],
): Promise<{ child: ReturnType<typeof spawn>; stderr: () => string } | null> {
  if (activePipes >= 6) return null;
  const engine = await getEngine();
  if (!engine) return null;
  const url = normalizeYtInput(input);
  if (!url) return null;
  const child = spawn(engine.cmd, [...engine.baseArgs, ...commonArgs(), ...extraArgs, "-f", selector, "-o", "-", url], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  activePipes += 1;
  child.on("close", () => {
    activePipes -= 1;
  });
  child.on("error", () => {
    activePipes -= 1;
  });
  let errTail = "";
  child.stderr?.on("data", (c: Buffer) => {
    errTail = (errTail + c.toString()).slice(-2000);
  });
  return { child, stderr: () => errTail };
}
