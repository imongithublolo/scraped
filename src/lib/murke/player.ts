import { Howl, Howler } from "howler";

import { embedPlay, embedStop, type EmbedController } from "./embed-audio";

/**
 * Howler-backed music singleton for dsh ("music").
 *
 * SESSION-ONLY: the list starts empty. Every track arrives at runtime via
 * playExternal (the launcher's youtube resolver, `music yt`, …) and lives
 * in a newest-first session queue capped at 50, deduped by id. Nothing
 * persists past the page.
 *
 * PLAYBACK CHAIN (direct-first, mirrors VideoPane): tracks may hand in
 * `fallbacks` — urls tried IN ORDER when the current src refuses to load
 * (dead cobalt tunnel → same-origin /api/stream pipe → muxed tunnel → …).
 * The browser carries the stream whenever the source is CORS-clean
 * (cobalt tunnels ship access-control-allow-origin: *); the pipe only
 * picks up the slack. COEP: credentialless blocks no-cors cross-origin
 * media, so every html5 audio node howler builds is CORS-marked up front
 * (see corsifyAudio below — howler 2.2.4 has no crossOrigin option).
 *
 * FRESHNESS: cobalt tunnels embed exp= and die after ~10 minutes. yt
 * tracks remember their videoId; play() on a stale track asks the
 * registered refresher (yt-audio.ts) for a fresh resolve instead of
 * replaying a corpse.
 *
 * FAILURE SURFACE: the player never dies silently — a source that can't
 * load/play walks the fallback chain; when the chain is exhausted,
 * onError fires so the UI can say so.
 *
 * onTick(cb): fires on howler play/pause/stop/end/load plus every 1s
 * while playing. onEnded(cb): natural end only (autoplay-next).
 * clear(): halts playback and wipes the session queue.
 */

export interface PlayerTrack {
  id: string;
  name: string;
}

export interface PlayerNow {
  id: string;
  name: string;
  positionSec: number;
  durationSec: number;
  /** how the active src is carried: direct CORS tunnel, our server pipe,
   *  or youtube's own embed player (the always-works fallback) */
  mode: "direct" | "pipe" | "embed" | null;
}

/** one link of a playback source chain */
export interface ChainLink {
  url: string;
  /** howler format hint — REQUIRED for extension-less urls (tunnels,
   *  pipes): howler refuses any src it cannot guess a codec for, before
   *  a single byte is fetched ("No file extension was found") */
  fmt?: string;
}

export interface PlayExternalOpts {
  /** yt video id backing this track — enables stale re-resolve on replay */
  videoId?: string;
  /** howler format hint for the primary url ("mp3" / "mp4" / "m4a") */
  fmt?: string;
  /** links tried in order when the primary src fails to load/play */
  fallbacks?: ChainLink[];
}

export interface MusicPlayerApi {
  list(): PlayerTrack[];
  /** Starts (or resumes) a track. False when the id is unknown / not in a browser. */
  play(id: string): boolean;
  /** Registers (or reuses) a session-only track and plays it.
   *  url must already be loadable (direct CORS tunnel or same-origin pipe). */
  playExternal(id: string, name: string, url: string, opts?: PlayExternalOpts): boolean;
  /** Appends links to the END of a track's fallback chain (used to attach
   *  resolved stream urls AFTER an embed-first track already started). */
  addFallbacks(id: string, links: ChainLink[]): void;
  /** Drops a track from the session queue (stops it if playing). */
  remove(id: string): void;
  pause(): void;
  resume(): void;
  stop(): void;
  togglePause(): void;
  playing(): boolean;
  current(): PlayerNow | null;
  /** Jump to a position in seconds (no-op when nothing is loaded). */
  seek(sec: number): void;
  /** 0..100 as last set via volume(). */
  volumePct(): number;
  /** 0..100, clamped. */
  volume(v: number): void;
  /** Register a re-render callback (null to detach). */
  onTick(cb: (() => void) | null): void;
  /** Single-slot hook for natural track end — autoplay-next etc (null to detach). */
  onEnded(cb: (() => void) | null): void;
  /** Single-slot hook when a track's whole source chain is exhausted (null to detach). */
  onError(cb: ((t: { id: string; name: string }) => void) | null): void;
  /** Late-chain provider — called when a track's fallback list runs dry
   *  BEFORE the error is surfaced; resolves with additional links (or
   *  []) after an await. This is what lets the embed-first chain start
   *  instantly and still receive the resolver's streams seconds later. */
  setFallbackProvider(fn: ((id: string, videoId: string | null) => Promise<ChainLink[]>) | null): void;
  /** Registers the fresh-resolve provider for stale yt tracks (null to detach). */
  setRefresher(fn: ((videoId: string, id: string, name: string) => Promise<boolean>) | null): void;
  /** Stops playback and wipes the session queue. */
  clear(): void;
}

interface TrackDef {
  id: string;
  name: string;
  src: string;
  /** howler format hint for src (extension-less tunnels/pipes need it);
   *  "embed" marks the youtube-embed engine link (src = "embed:<videoId>") */
  fmt: string | null;
  howl: Howl | null;
  /** the embed engine controller when THIS track plays via youtube's player */
  embedCtl: EmbedController | null;
  /** the shim reported autoplay-with-sound was refused — waiting for a tap */
  embedBlocked: boolean;
  knownDuration: number;
  videoId: string | null;
  /** epoch ms of the resolve that produced `src` — drives stale re-resolve */
  resolvedAt: number;
  /** remaining links to try when src dies */
  fallbacks: ChainLink[];
  /** every url this track has already tried — the provider must not
   *  hand them back (that made the chain loop dead links for minutes) */
  tried: Set<string>;
  /** the late-chain provider was already consulted for this track */
  providerUsed: boolean;
  /** watchdog timer — a src that neither loads nor plays in time is dead */
  watchdog: ReturnType<typeof setTimeout> | null;
  /** playerror retries already spent on the current src */
  playRetries: number;
  /** true once THIS src audibly started — a paused-after-playing howl is
   *  alive even when its stream never reports a duration */
  hasPlayed: boolean;
  /** true once the embed shim sent ANY message (ready/tick/blocked/error)
   *  — a silent shim is a blocked frame, failed over fast */
  embedSignaled: boolean;
}

/** a yt track older than this gets a fresh resolve before replay */
const STALE_MS = 6 * 60_000;
/** a src that hasn't loaded (metadata) nor started playing within this window dies */
const LOAD_DEADLINE_MS = 12_000;

/** session queue cap — newest first, deduped by id */
const QUEUE_CAP = 50;

/* COEP: credentialless refuses no-cors cross-origin audio, and cobalt
   tunnels are CORS-* — so html5 audio nodes must request in CORS mode
   (crossOrigin="anonymous") to load them at all. Howler 2.2.4 creates
   its nodes with bare `new Audio()` and offers no crossOrigin option,
   so the constructor is wrapped once, before any Howl exists: every
   node gets crossOrigin set BEFORE howler assigns src (required —
   setting it afterwards has no effect on the request). Same-origin and
   CORS-* sources are unaffected; WebAudio paths never touch this. */
function corsifyAudio(): void {
  if (typeof window === "undefined") return;
  const Native = window.Audio;
  const marker = "__murkeCorsAudio";
  if (!Native || (Native as unknown as Record<string, unknown>)[marker]) return;
  const Patched = function (...args: ConstructorParameters<typeof Audio>) {
    const el = new Native(...args);
    el.crossOrigin = "anonymous";
    return el;
  } as unknown as typeof Audio;
  Patched.prototype = Native.prototype; // instanceof Audio keeps working
  (Patched as unknown as Record<string, unknown>)[marker] = true;
  window.Audio = Patched;
}
corsifyAudio();

/** which carry-mode a src url is on */
function srcMode(url: string): "direct" | "pipe" | "embed" | null {
  if (url.startsWith("embed:")) return "embed";
  if (/^https?:\/\//i.test(url)) return "direct";
  if (url.startsWith("/api/stream")) return "pipe";
  return null;
}

class MusicPlayer implements MusicPlayerApi {
  private currentId: string | null = null;
  private volumePctVal = 80;
  private tickCb: (() => void) | null = null;
  private endedCb: (() => void) | null = null;
  private errorCb: ((t: { id: string; name: string }) => void) | null = null;
  private refresher: ((videoId: string, id: string, name: string) => Promise<boolean>) | null = null;
  /** consulted when a track's fallback list runs dry (late resolve) */
  private fallbackProvider:
    | ((id: string, videoId: string | null) => Promise<ChainLink[]>)
    | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** ids with a re-resolve in flight — double-play guards */
  private refreshing: Set<string> = new Set();
  /** session-only tracks added at runtime (launcher / youtube audio etc) — newest first */
  private external: TrackDef[] = [];

  list(): PlayerTrack[] {
    return this.external.map((t) => ({ id: t.id, name: t.name }));
  }

  play(id: string): boolean {
    const t = this.byId(id);
    if (!t || typeof window === "undefined") return false;
    // stale yt track (tunnel dead or dying): ask for a fresh resolve — the
    // refresher re-enters through playExternal with a new chain when it lands
    if (
      t.videoId &&
      Date.now() - t.resolvedAt > STALE_MS &&
      this.refresher &&
      !this.refreshing.has(id)
    ) {
      this.refreshing.add(id);
      const vid = t.videoId;
      const name = t.name;
      void this.refresher(vid, id, name)
        .catch(() => false)
        .then((ok) => {
          this.refreshing.delete(id);
          if (ok) return;
          // refresh failed — replay the old corpse; if it's truly dead the
          // chain walks itself and onError surfaces the truth
          this.startTrack(this.byId(id), id);
        });
      return true;
    }
    this.startTrack(t, id);
    return true;
  }

  playExternal(id: string, name: string, url: string, opts?: PlayExternalOpts): boolean {
    if (typeof window === "undefined" || !url) return false;
    let t = this.byId(id);
    if (!t) {
      t = {
        id,
        name,
        src: url,
        fmt: opts?.fmt ?? null,
        howl: null,
        embedCtl: null,
        embedBlocked: false,
        embedSignaled: false,
        knownDuration: 0,
        videoId: opts?.videoId ?? null,
        resolvedAt: Date.now(),
        fallbacks: [...(opts?.fallbacks ?? [])],
        tried: new Set([url]),
        providerUsed: false,
        watchdog: null,
        playRetries: 0,
        hasPlayed: false,
      };
      this.external = [t, ...this.external.filter((x) => x.id !== id)].slice(0, QUEUE_CAP);
    } else {
      const chainChanged = t.src !== url;
      if (chainChanged) {
        // same id replayed with a new source (preview → full upgrade, or a
        // fresh resolve): an existing howl keeps its old src — swap it out
        t.src = url;
        t.fmt = opts?.fmt ?? null;
        t.knownDuration = 0;
        t.playRetries = 0;
        t.hasPlayed = false;
        t.resolvedAt = Date.now();
        t.providerUsed = false;
        t.tried = new Set([url]);
        if (t.howl) {
          if (this.currentId === id) t.howl.stop();
          this.killHowl(t);
        }
        if (t.embedCtl) {
          t.embedCtl.destroy();
          t.embedCtl = null;
        }
        t.embedBlocked = false;
      }
      if (opts?.videoId !== undefined) t.videoId = opts.videoId;
      if (opts?.fallbacks !== undefined) t.fallbacks = [...opts.fallbacks];
      if (name) t.name = name;
    }
    return this.startTrack(t, id);
  }

  /** attach late-resolved stream links behind a track that already plays
   *  (the embed-first doctrine: playback starts on the videoId alone and
   *  the resolver's streams join the chain whenever they arrive) */
  addFallbacks(id: string, links: ChainLink[]): void {
    const t = this.byId(id);
    if (!t || links.length === 0) return;
    const seen = new Set([t.src, ...t.tried, ...t.fallbacks.map((f) => f.url)]);
    for (const l of links) {
      if (!l?.url || seen.has(l.url)) continue;
      seen.add(l.url);
      t.fallbacks.push(l);
    }
  }

  remove(id: string): void {
    const t = this.byId(id);
    if (!t) return;
    if (t.watchdog) clearTimeout(t.watchdog);
    if (this.currentId === id) {
      if (t.howl) t.howl.stop();
      if (t.embedCtl) {
        t.embedCtl.destroy();
        t.embedCtl = null;
      }
      this.currentId = null;
    }
    this.external = this.external.filter((x) => x.id !== id);
    this.notify();
  }

  pause(): void {
    const t = this.byId(this.currentId);
    if (t?.embedCtl) {
      t.embedCtl.pause();
      return;
    }
    const h = this.curHowl();
    if (h && h.playing()) h.pause();
  }

  resume(): void {
    const t = this.byId(this.currentId);
    if (t?.embedCtl) {
      // a tap after a blocked autoplay is a real gesture — the embed plays
      t.embedCtl.resume();
      this.armWatchdog(t);
      return;
    }
    const h = this.curHowl();
    if (h && !h.playing()) h.play();
  }

  stop(): void {
    const t = this.byId(this.currentId);
    if (t?.howl) t.howl.stop();
    if (t?.embedCtl) {
      t.embedCtl.destroy();
      t.embedCtl = null;
    }
    if (t) this.clearWatchdog(t);
    this.currentId = null;
    this.notify();
  }

  togglePause(): void {
    if (this.playing()) this.pause();
    else this.resume();
  }

  playing(): boolean {
    const t = this.byId(this.currentId);
    if (t?.embedCtl) return t.embedCtl.playing();
    const h = this.curHowl();
    return !!h && h.playing();
  }

  current(): PlayerNow | null {
    const t = this.byId(this.currentId);
    if (!t) return null;
    let positionSec = 0;
    if (t.embedCtl) {
      positionSec = t.embedCtl.time();
      const d = t.embedCtl.dur();
      if (d > 0) t.knownDuration = d;
    } else if (t.howl) {
      const s = t.howl.seek();
      if (typeof s === "number" && Number.isFinite(s) && s >= 0) positionSec = s;
      const d = t.howl.duration();
      if (Number.isFinite(d) && d > 0) t.knownDuration = d;
    }
    return {
      id: t.id,
      name: t.name,
      positionSec,
      durationSec: t.knownDuration,
      mode: srcMode(t.src),
    };
  }

  volume(v: number): void {
    const pct = Math.max(0, Math.min(100, Math.round(v)));
    this.volumePctVal = pct;
    if (typeof window !== "undefined") Howler.volume(pct / 100);
    const cur = this.byId(this.currentId);
    if (cur?.embedCtl) cur.embedCtl.setVolume(pct);
  }

  volumePct(): number {
    return this.volumePctVal;
  }

  seek(sec: number): void {
    const t = this.byId(this.currentId);
    if (t?.embedCtl) {
      t.embedCtl.seek(Math.max(0, sec));
      this.notify();
      return;
    }
    const h = this.curHowl();
    if (!h) return;
    try {
      h.seek(Math.max(0, sec));
    } catch {
      /* streams that refuse to seek yet — silently ignored */
    }
    this.notify();
  }

  onTick(cb: (() => void) | null): void {
    this.tickCb = cb;
    this.notify();
  }

  onEnded(cb: (() => void) | null): void {
    this.endedCb = cb;
  }

  onError(cb: ((t: { id: string; name: string }) => void) | null): void {
    this.errorCb = cb;
  }

  setRefresher(fn: ((videoId: string, id: string, name: string) => Promise<boolean>) | null): void {
    this.refresher = fn;
  }

  setFallbackProvider(
    fn: ((id: string, videoId: string | null) => Promise<ChainLink[]>) | null,
  ): void {
    this.fallbackProvider = fn;
  }

  clear(): void {
    for (const t of this.external) {
      if (t.watchdog) clearTimeout(t.watchdog);
      if (t.howl) {
        t.howl.stop();
        this.killHowl(t);
      }
      if (t.embedCtl) {
        t.embedCtl.destroy();
        t.embedCtl = null;
      }
    }
    embedStop();
    this.currentId = null;
    this.external = [];
    this.refreshing.clear();
    this.notify();
  }

  /* ---------- internals ---------- */

  private byId(id: string | null): TrackDef | undefined {
    if (!id) return undefined;
    return this.external.find((t) => t.id === id);
  }

  private curHowl(): Howl | null {
    return this.byId(this.currentId)?.howl ?? null;
  }

  /** begin (or resume) playback of a registered track */
  private startTrack(t: TrackDef | undefined, id: string): boolean {
    if (!t || typeof window === "undefined") return false;
    if (this.currentId !== id) {
      const prev = this.byId(this.currentId);
      if (prev?.howl) prev.howl.stop();
      if (prev?.embedCtl) {
        prev.embedCtl.destroy();
        prev.embedCtl = null;
      }
      this.clearWatchdog(prev);
      this.currentId = id;
    }
    // src = "embed:<videoId>" — youtube's own player carries the track
    // (the always-works last link: user's IP, full length, no resolvers)
    if (t.src.startsWith("embed:")) {
      // THE SAME TRACK, AGAIN — a live embed that already holds a
      // position (paused mid-song, or buffering) must RESUME where it
      // sits; rebuilding the iframe would replay the song from zero
      // (the "play restarts it" bug). Only a dead/never-started embed
      // earns a fresh startEmbed.
      if (t.embedCtl && (t.embedCtl.time() > 0 || t.embedCtl.dur() > 0 || t.embedCtl.playing())) {
        if (!t.embedCtl.playing()) {
          t.embedCtl.resume();
          this.armWatchdog(t);
        }
        this.notify();
        return true;
      }
      this.startEmbed(t);
      this.notify();
      return true;
    }
    if (!t.howl) {
      t.howl = this.makeHowl(t);
      this.armWatchdog(t);
    }
    if (!t.howl.playing()) {
      t.howl.play();
      // resume-after-pause can also stall on a dead upstream — re-arm
      this.armWatchdog(t);
    }
    this.notify();
    return true;
  }

  /** spin up the youtube-embed engine for an "embed:" src */
  private startEmbed(t: TrackDef): void {
    const videoId = t.src.slice("embed:".length);
    if (t.embedCtl) {
      t.embedCtl.destroy();
      t.embedCtl = null;
    }
    t.embedBlocked = false;
    t.knownDuration = 0;
    t.playRetries = 0;
    t.hasPlayed = false;
    t.embedSignaled = false;
    t.embedCtl = embedPlay(videoId, {
      volumePct: this.volumePctVal,
      callbacks: {
        onState: (s) => {
          t.embedSignaled = true;
          if (s.dur > 0) t.knownDuration = s.dur;
          if (s.playing) {
            t.hasPlayed = true;
            t.embedBlocked = false;
            this.clearWatchdog(t);
          }
          this.notify();
        },
        onEnded: () => {
          this.clearWatchdog(t);
          this.notify();
          // the shim's ENDED only fires after real playback — a zero/
          // zero "end" is still treated as a corpse and walks the chain
          if (t.knownDuration <= 0 && (t.embedCtl?.time() ?? 0) <= 0) {
            this.failOver(t);
            return;
          }
          this.endedCb?.(); // natural end — autoplay-next
        },
        onError: () => this.failOver(t),
        onBlocked: () => {
          // autoplay with sound refused — NOT a dead stream. The UI shows
          // paused; the next play tap resumes with sound (real gesture).
          t.embedSignaled = true;
          t.embedBlocked = true;
          this.notify();
        },
      },
    });
    this.armWatchdog(t);
  }

  private makeHowl(t: TrackDef): Howl {
    Howler.volume(this.volumePctVal / 100); // master gain, kept in sync
    return new Howl({
      src: [t.src],
      // extension-less urls (tunnels, pipes) are refused by howler's
      // extension sniffing unless the codec is stated outright
      ...(t.fmt ? { format: [t.fmt] } : {}),
      html5: true,
      onload: () => {
        this.clearWatchdog(t);
        // duration must be tracked even with no UI open (the zero-duration
        // onend guard below depends on it, and tick callbacks are optional)
        const d = t.howl?.duration();
        if (typeof d === "number" && Number.isFinite(d) && d > 0) t.knownDuration = d;
        this.notify(); // duration becomes available → timelines wake up
      },
      onplay: () => {
        this.clearWatchdog(t);
        t.hasPlayed = true;
        this.notify();
      },
      onplayerror: () => {
        // html5 autoplay hiccups replay fine with one more play() call;
        // a genuinely dead src errors twice → walk the chain
        t.playRetries += 1;
        if (t.playRetries <= 1 && t.howl) {
          try {
            t.howl.play();
            return;
          } catch {
            /* fall through to failover */
          }
        }
        this.failOver(t);
      },
      onloaderror: () => this.failOver(t),
      onpause: () => this.notify(),
      onstop: () => this.notify(),
      onend: () => {
        this.clearWatchdog(t);
        this.notify();
        // An empty/bot-walled source (cobalt tunnels answer some requests
        // with 200 + zero bytes) can "end" the moment it loads — position 0,
        // duration 0, no audible playback. That is a dead src, not a natural
        // end: walk the fallback chain instead of firing autoplay-next. A
        // real end always carries a position (streams may never report a
        // duration, so position is the authoritative liveness signal).
        if (t.knownDuration <= 0 && this.safePos(t.howl) <= 0) {
          this.failOver(t);
          return;
        }
        this.endedCb?.(); // natural end only — autoplay-next
      },
    });
  }

  /** the current src is dead — try the next link, else give up loudly.
   *  When the list runs dry, the late-chain provider gets one await to
   *  hand over more links (a background resolve finishing after the
   *  embed died) before the track is declared dead. */
  private async failOver(t: TrackDef): Promise<void> {
    this.clearWatchdog(t);
    let next = t.fallbacks.shift();
    while (next && t.tried.has(next.url)) next = t.fallbacks.shift();
    if (!next && this.fallbackProvider && !t.providerUsed) {
      t.providerUsed = true;
      try {
        const extra = await this.fallbackProvider(t.id, t.videoId);
        const seen = new Set([t.src, ...t.tried, ...t.fallbacks.map((f) => f.url)]);
        t.fallbacks.push(...extra.filter((l) => l?.url && !seen.has(l.url)));
      } catch {
        /* provider failed — the exhaustion below stands */
      }
      next = t.fallbacks.shift();
      while (next && t.tried.has(next.url)) next = t.fallbacks.shift();
    }
    if (!next) {
      if (this.currentId === t.id) this.errorCb?.({ id: t.id, name: t.name });
      this.notify();
      return;
    }
    const wasCurrent = this.currentId === t.id;
    const wasPlaying = wasCurrent
      ? (t.embedCtl?.playing() ?? !!t.howl?.playing())
      : false;
    const resumeAt = wasCurrent
      ? (t.embedCtl?.time() ?? (t.howl ? this.safePos(t.howl) : 0))
      : 0;
    t.src = next.url;
    t.fmt = next.fmt ?? null;
    t.tried.add(next.url);
    t.knownDuration = 0;
    t.playRetries = 0;
    t.hasPlayed = false;
    this.killHowl(t);
    if (t.embedCtl) {
      t.embedCtl.destroy();
      t.embedCtl = null;
    }
    t.embedBlocked = false;
    if (!wasCurrent) return; // background track died — swap silently, play later
    if (t.src.startsWith("embed:")) {
      this.startEmbed(t);
      this.notify();
      return;
    }
    t.howl = this.makeHowl(t);
    t.howl.once("play", () => {
      if (resumeAt > 1 && t.howl) {
        try {
          t.howl.seek(resumeAt);
        } catch {
          /* mid-failover seek best-effort */
        }
      }
    });
    this.armWatchdog(t);
    if (wasPlaying || !t.howl.playing()) t.howl.play();
    this.notify();
  }

  /** a src that neither loads nor PLAYS within the deadline is dead. The
   *  second case matters: a bot-walled upstream can answer 200 with ZERO
   *  bytes — howler marks it "loaded", nothing errors, nothing plays and
   *  the old watchdog (state-only) sat there forever. A loaded howl with
   *  no duration that never audibly played is just a corpse with a 200. */
  private armWatchdog(t: TrackDef): void {
    this.clearWatchdog(t);
    t.watchdog = setTimeout(() => {
      t.watchdog = null;
      if (t.embedCtl) {
        // the embed needs a few seconds to boot (iframe + IFrame API);
        // kill it only when nothing loaded AND it isn't waiting for a tap.
        // A shim that NEVER sent a single message is a blocked frame
        // (browsers without real credentialless support) — fail over fast
        // so the stream links take over without a long silence.
        if (t.embedBlocked) return;
        if (!t.embedSignaled) {
          this.failOver(t);
          return;
        }
        if (t.embedCtl.playing() || t.embedCtl.dur() > 0 || t.embedCtl.time() > 0) return;
        this.failOver(t);
        return;
      }
      if (!t.howl || t.howl.playing()) return;
      if (t.howl.state() !== "loaded") {
        this.failOver(t);
        return;
      }
      const d = t.howl.duration();
      if ((!Number.isFinite(d) || d <= 0) && !t.hasPlayed) this.failOver(t);
    }, LOAD_DEADLINE_MS);
  }

  private clearWatchdog(t: TrackDef | undefined): void {
    if (t?.watchdog) {
      clearTimeout(t.watchdog);
      t.watchdog = null;
    }
  }

  private killHowl(t: TrackDef): void {
    if (!t.howl) return;
    try {
      t.howl.unload();
    } catch {
      /* already gone */
    }
    t.howl = null;
  }

  private safePos(h: Howl | null): number {
    if (!h) return 0;
    try {
      const s = h.seek();
      return typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 0;
    } catch {
      return 0;
    }
  }

  /** Fire the re-render callback and sync the 1s ticker to playback state. */
  private notify(): void {
    const wantTicker = this.tickCb !== null && this.playing();
    if (wantTicker && this.timer === null) {
      this.timer = setInterval(() => this.tickCb?.(), 1000);
    } else if (!wantTicker && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.tickCb?.();
  }
}

export const musicPlayer: MusicPlayerApi = new MusicPlayer();
