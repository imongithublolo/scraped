"use client";

/**
 * watch — the terminal-native video pane. INVIDIOUS END TO END, ZERO
 * IFRAMES: every youtube video is resolved by the user's own browser
 * racing the invidious instance pool (server chain behind it), and the
 * muxed stream plays as a plain same-origin piped <video> — no youtube
 * player, no embeds, no popups.
 *
 * PLAYBACK ORDER — direct-first: instance-proxy urls are CORS-open, so
 * the BROWSER carries the bytes (no serverless 60s streaming cap, no
 * double bandwidth); our /api/stream same-origin pipe picks up the slack
 * when the instance refuses the browser. Dead sources walk the quality
 * list, then the pipe, then ONE fresh re-resolve, then an honest error.
 * Lives ride hls.js off the instance's own manifest.
 *
 * CHROME — THIN by design: tight bars, small buttons, [rw] [PLAY] [ff]
 * with play dead-center between rewind and fast-forward (prev/next hug
 * the edges), timeline after, settings + fullscreen pinned right.
 * rewind / fast-forward: tap = ±10s, HOLD = warp (ff: timelapse tunnel,
 * rw: paused scanback) under the full-screen warp field. The search
 * panel is a scrollable thumbnailed list — every hit visible, click to
 * resolve + play. Fullscreen hides all chrome; moving the mouse reveals
 * the overlay UI, which fades away again until the next move.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  FastForward,
  ListMusic,
  Maximize,
  Minimize,
  Pause,
  Play,
  Rewind,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  VolumeX,
  X,
} from "lucide-react";
import type { VideoPick, VideoQualitySource, VideoSource } from "@/lib/murke/contracts";
import { artUrl } from "@/lib/murke/inv";
import { fmtDuration, isYtInput, resolveYt, searchYt, type YtSearchHit } from "@/lib/murke/yt";

const SPEEDS = [0.5, 0.75, 1, 1.5, 2] as const;
const FF_WARP_RATE = 4; // fast-forward hold — playbackRate
const RW_STEP = 1.2; // rewind warp: seconds per step
const RW_TICK_MS = 90; // rewind warp: step interval
const HOLD_MS = 260; // press-and-hold threshold before warp engages
const SEARCH_DEBOUNCE_MS = 450;
const FS_HIDE_MS = 2600; // fullscreen UI hides again after this idle

/* warp field — radial speed streaks + starfield + scanlines, all theme vars */
const WARP_CSS = `
.vp-warp-streaks{background:repeating-conic-gradient(from 0deg at 50% 50%,transparent 0deg,transparent 1.6deg,color-mix(in srgb,var(--term-fg) 22%,transparent) 2deg,color-mix(in srgb,var(--term-brand) 34%,transparent) 2.4deg,transparent 2.8deg,transparent 5.4deg);animation:vp-warp-zoom .58s linear infinite;opacity:.75}
.vp-warp-stars{background-image:radial-gradient(1px 1px at 11% 24%,color-mix(in srgb,var(--term-fg) 85%,transparent) 50%,transparent 51%),radial-gradient(1.5px 1.5px at 74% 18%,color-mix(in srgb,var(--term-fg) 70%,transparent) 50%,transparent 51%),radial-gradient(1px 1px at 58% 67%,color-mix(in srgb,var(--term-fg) 80%,transparent) 50%,transparent 51%),radial-gradient(1.5px 1.5px at 33% 82%,color-mix(in srgb,var(--term-fg) 65%,transparent) 50%,transparent 51%),radial-gradient(1px 1px at 87% 55%,color-mix(in srgb,var(--term-fg) 75%,transparent) 50%,transparent 51%),radial-gradient(1px 1px at 44% 9%,color-mix(in srgb,var(--term-fg) 60%,transparent) 50%,transparent 51%);animation:vp-warp-zoom .85s linear infinite;opacity:.8}
.vp-warp-scan{background:repeating-linear-gradient(to bottom,transparent 0 3px,color-mix(in srgb,var(--term-fg) 6%,transparent) 3px 4px);animation:vp-warp-flicker .16s steps(2) infinite}
.vp-warp-vig{background:radial-gradient(ellipse at center,transparent 26%,color-mix(in srgb,var(--term-bg) 82%,transparent) 100%)}
.vp-warp-glow{text-shadow:0 0 18px color-mix(in srgb,var(--term-brand) 70%,transparent),0 0 70px color-mix(in srgb,var(--term-brand) 40%,transparent);animation:vp-warp-pulse .5s ease-in-out infinite}
.vp-warp-back .vp-warp-streaks,.vp-warp-back .vp-warp-stars{animation-direction:reverse}
@keyframes vp-warp-zoom{from{transform:scale(.22)}to{transform:scale(2.8)}}
@keyframes vp-warp-flicker{50%{opacity:.5}}
@keyframes vp-warp-pulse{50%{opacity:.8;transform:scale(1.035)}}
@media (prefers-reduced-motion:reduce){.vp-warp-streaks,.vp-warp-stars,.vp-warp-scan,.vp-warp-glow{animation:none}}
`;

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "--:--";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface Playing {
  src: string;
  title: string;
  videoId?: string;
  remote: boolean;
  sources?: VideoQualitySource[];
}

export default function VideoPane({
  src,
  title,
  remote,
  videoId,
  playlist,
  sources,
  onClose,
}: VideoSource & { onClose: () => void }) {
  const [cur, setCur] = useState<Playing>({
    src,
    title: title || "session media",
    videoId,
    remote: Boolean(remote),
    sources,
  });
  const [srcIdx, setSrcIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [note, setNote] = useState<{ key: string; text: string } | null>(null);
  const [loadingNext, setLoadingNext] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [results, setResults] = useState<YtSearchHit[]>([]);
  const [qPlaylist, setQPlaylist] = useState<VideoPick[]>([]);
  const [warp, setWarp] = useState<null | "ff" | "rw">(null);
  const [warpOut, setWarpOut] = useState(false);
  const [holding, setHolding] = useState<null | "ff" | "rw">(null);
  const [fs, setFs] = useState(false);
  /** fullscreen UI visibility — poked by pointer activity, fades when idle */
  const [fsShown, setFsShown] = useState(true);
  /** true while the <video> is muted by autoplay policy — chip unmutes */
  const [needSound, setNeedSound] = useState(false);
  /** true when the direct instance url failed and we dropped back to the
   *  same-origin server pipe (some instances lack CORS on videoplayback) */
  const [directMode, setDirectMode] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  /** dead-src retry bookkeeping, keyed to the current play url */
  const retryRef = useRef({ key: "", tries: 0 });
  /** position + play state to restore after a quality/source swap */
  const pendingRef = useRef<{ seek: number | null; play: boolean }>({ seek: null, play: false });
  const holdTimerRef = useRef<number | null>(null);
  const rwTimerRef = useRef<number | null>(null);
  const holdingRef = useRef<null | "ff" | "rw">(null);
  const warpRef = useRef<null | "ff" | "rw">(null);
  const lastWarpRef = useRef<"ff" | "rw">("ff");
  const wasPlayingRef = useRef(false);
  /** eats the synthetic click that follows a press-and-hold release */
  const suppressClickRef = useRef(false);
  const searchingRef = useRef(false);
  const fsHideTimerRef = useRef<number | null>(null);
  /** resolve bookkeeping — one fresh re-resolve per video on stream death */
  const resolveRef = useRef({ id: "", tried: false, redone: false });

  /* every selectable quality (best first) */
  const srcList: VideoQualitySource[] =
    cur.sources && cur.sources.length > 0
      ? cur.sources
      : cur.src
        ? [{ quality: "auto", url: cur.src, direct: !cur.remote }]
        : [];
  const activeIdx = Math.min(srcIdx, Math.max(0, srcList.length - 1));
  const active = srcList[activeIdx];
  /** HLS manifest (live streams) — hls.js carries it, not <video src> */
  const isHls = Boolean(active?.hls || (/\.m3u8($|\?)/i.test(active?.url ?? "") && cur.remote));
  /* DIRECT-FIRST: invidious instance-proxy urls are CORS-*, so the browser
     carries the stream itself — no serverless cap, no double bandwidth.
     The same-origin pipe (directMode) picks up when the instance refuses
     the browser. RELATIVE sources are already the pipe — never re-wrap. */
  const [hlsPiped, setHlsPiped] = useState(false);
  const activeIsPipeSrc = Boolean(active?.url.startsWith("/"));
  const usePipe = Boolean(
    cur.remote && !isHls && !activeIsPipeSrc && (directMode || !active?.direct),
  );
  const playUrl = active
    ? isHls
      ? hlsPiped
        ? `/api/stream?u=${encodeURIComponent(active.url)}`
        : active.url
      : usePipe
        ? `/api/stream?u=${encodeURIComponent(active.url)}`
        : active.url
    : "";
  /** a youtube id with nothing to play yet — the resolver owns the screen */
  const needsResolve = Boolean(cur.videoId) && !cur.src && !(cur.sources && cur.sources.length > 0);

  /* the queue: in-player search results win, else the playlist that came in */
  const queue: VideoPick[] = qPlaylist.length > 0 ? qPlaylist : playlist ?? [];
  const qIdx = cur.videoId ? queue.findIndex((p) => p.videoId === cur.videoId) : -1;
  const nextPick = qIdx >= 0 ? (queue[qIdx + 1] ?? null) : null;
  const prevPick = qIdx > 0 ? (queue[qIdx - 1] ?? null) : null;

  const applyMedia = useCallback((m: Playing) => {
    retryRef.current = { key: "", tries: 0 };
    pendingRef.current = { seek: null, play: false };
    setSrcIdx(0);
    setNote(null);
    setNeedSound(false);
    setDirectMode(false);
    setHlsPiped(false);
    setTime(0);
    setDuration(0);
    setCur(m);
  }, []);

  /* ---------- transport actions ---------- */

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, []);

  const seekTo = useCallback((sec: number) => {
    const el = videoRef.current;
    if (el) el.currentTime = Math.max(0, sec);
  }, []);

  const seekBy = useCallback((delta: number) => {
    const el = videoRef.current;
    if (el) el.currentTime = Math.max(0, el.currentTime + delta);
  }, []);

  const applyRate = useCallback((r: number) => {
    setRate(r);
    if (videoRef.current) videoRef.current.playbackRate = r;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void stage.requestFullscreen().catch(() => undefined);
  }, []);

  /** one tap anywhere grants audio for the policy-muted stream */
  const claimSound = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    try {
      el.muted = false;
      setNeedSound(false);
      if (el.paused) void el.play().catch(() => undefined);
    } catch {
      /* ignore */
    }
  }, []);

  /* ---------- invidious resolve for bare youtube ids ---------- */

  useEffect(() => {
    if (!needsResolve || !cur.videoId) return;
    const id = cur.videoId;
    const book = resolveRef.current;
    if (book.id === id && book.tried) return; // already failed for this id
    let dead = false;
    book.id = id;
    book.tried = true;
    setResolving(true);
    void (async () => {
      try {
        const media = await resolveYt(id);
        if (dead) return;
        /* live streams: only the manifest exists (invidious hlsUrl).
           Regular videos: the muxed formats (video+audio in one file,
           best first) — with the adaptive manifest (when a resolver
           offers one) appended as a resilient fallback source. */
        const list: VideoQualitySource[] = [...(media.sources ?? [])];
        if (media.hlsUrl) {
          list.push({ quality: list.length > 0 ? "adaptive hls" : "live", url: media.hlsUrl, hls: true, direct: true });
        }
        if (list.length === 0) throw new Error("no playable formats");
        applyMedia({
          src: "",
          title:
            cur.title && cur.title !== "session media"
              ? cur.title
              : `${media.title} — ${media.author}`,
          videoId: media.videoId,
          remote: true,
          sources: list,
        });
        setNote(null);
      } catch (e) {
        if (dead) return;
        setNote({
          key: id,
          text: `invidious resolve failed — ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        if (!dead) setResolving(false);
      }
    })();
    return () => {
      dead = true;
    };
  }, [needsResolve, cur.videoId, cur.src, cur.sources, cur.title, applyMedia]);

  /* keep the latest queue pick / loop reachable from media callbacks */
  const nextPickRef = useRef<VideoPick | null>(null);
  nextPickRef.current = nextPick;
  const loadingNextRef = useRef(false);
  loadingNextRef.current = loadingNext;
  const loopRef = useRef(false);
  loopRef.current = loop;
  const rollIntoRef = useRef<((p: VideoPick) => void) | null>(null);

  /* ---------- yt search (player-side, scrollable) ---------- */

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (!q || searchingRef.current) return;
    searchingRef.current = true;
    setSearching(true);
    setSearchErr(null);
    try {
      if (isYtInput(q)) {
        // a url / id pasted into the box plays straight away — resolve then play
        let id = q.trim();
        const m = /(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/.exec(q);
        if (m) id = m[1];
        resolveRef.current = { id, tried: false, redone: false };
        applyMedia({ src: "", title: id, videoId: id, remote: false });
        return;
      }
      const hits = await searchYt(q);
      setResults(hits.filter((h) => !h.live).slice(0, 24));
      if (hits.length === 0) setSearchErr("search came back empty — different words?");
    } catch (e) {
      setSearchErr(e instanceof Error ? e.message : String(e));
    } finally {
      searchingRef.current = false;
      setSearching(false);
    }
  }, [applyMedia]);

  const playPick = (hit: YtSearchHit) => {
    if (resolving || resolvingId) return;
    setSearchErr(null);
    resolveRef.current = { id: hit.videoId, tried: false, redone: false };
    setQPlaylist(results.length > 0 ? results.slice(0, 24) : [hit]);
    applyMedia({
      src: "",
      title: `${hit.title} — ${hit.author}`,
      videoId: hit.videoId,
      remote: false,
    });
  };

  const rollInto = async (pick: VideoPick) => {
    if (resolving || loadingNext || resolvingId) return;
    setResolvingId(pick.videoId);
    setLoadingNext(true);
    try {
      resolveRef.current = { id: pick.videoId, tried: false, redone: false };
      applyMedia({
        src: "",
        title: `${pick.title} — ${pick.author}`,
        videoId: pick.videoId,
        remote: false,
      });
    } finally {
      setLoadingNext(false);
      setResolvingId(null);
    }
  };
  rollIntoRef.current = rollInto;

  /* ---------- warp mode (press-and-hold ff / rw) ---------- */

  function engageWarp(mode: "ff" | "rw") {
    if (warpRef.current) return;
    warpRef.current = mode;
    lastWarpRef.current = mode;
    const el = videoRef.current;
    if (!el) {
      warpRef.current = null;
      return;
    }
    wasPlayingRef.current = !el.paused;
    if (mode === "ff") {
      void el.play().catch(() => undefined);
    } else {
      // <video> can't play backwards — rapid stepping IS the rewind
      el.pause();
      rwTimerRef.current = window.setInterval(() => {
        const v = videoRef.current;
        if (v) v.currentTime = Math.max(0, v.currentTime - RW_STEP);
      }, RW_TICK_MS);
    }
    setWarp(mode);
  }

  function releaseWarp() {
    if (!warpRef.current) return;
    warpRef.current = null;
    if (rwTimerRef.current !== null) {
      window.clearInterval(rwTimerRef.current);
      rwTimerRef.current = null;
    }
    const el = videoRef.current;
    if (el) {
      el.playbackRate = rateRef.current;
      if (wasPlayingRef.current) void el.play().catch(() => undefined);
      else el.pause();
    }
    setWarp(null);
    setWarpOut(true);
    window.setTimeout(() => setWarpOut(false), 420);
  }

  const rateRef = useRef(1);
  rateRef.current = rate;

  function finishHold() {
    const mode = holdingRef.current;
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdingRef.current = null;
    setHolding(null);
    // the synthetic click trailing the release must not double-seek
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 250);
    if (warpRef.current) {
      releaseWarp();
      return;
    }
    if (mode) {
      // a tap, not a hold — plain 10s seek
      seekBy(mode === "ff" ? 10 : -10);
    }
  }

  function beginHold(mode: "ff" | "rw") {
    if (holdingRef.current || warpRef.current) return;
    claimSound();
    holdingRef.current = mode;
    setHolding(mode);
    suppressClickRef.current = true;
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      engageWarp(mode);
    }, HOLD_MS);
  }

  /* ---------- media pipeline handlers ---------- */

  const onLoadedMeta = () => {
    const el = videoRef.current;
    if (!el) return;
    const p = pendingRef.current;
    if (p.seek !== null) {
      try {
        el.currentTime = p.seek;
      } catch {
        /* seek before data — ignore */
      }
    }
    el.playbackRate = warp === "ff" ? FF_WARP_RATE : rate;
    el.loop = loop;
    if (p.play) {
      void el.play().catch(() => undefined);
    } else {
      // first play: honor autoplay policy — if sound is refused, start
      // muted and let the chip hand it back on the first gesture
      void el.play().catch(() => {
        el.muted = true;
        void el
          .play()
          .then(() => setNeedSound(true))
          .catch(() => undefined);
      });
    }
    pendingRef.current = { seek: null, play: false };
  };

  const onError = () => {
    if (!playUrl) return;
    const el = videoRef.current;
    const st = retryRef.current;
    if (st.key !== playUrl) {
      st.key = playUrl;
      st.tries = 0;
    }
    // 1. one-or-two dead-src retries on the same url
    if (st.tries < 2) {
      st.tries += 1;
      setNote({ key: playUrl, text: `upstream hiccup — retrying (${st.tries}/2)…` });
      if (el) el.load();
      return;
    }
    // 2. fall back to the next quality in sources
    const fallback = srcList[activeIdx + 1];
    if (fallback) {
      const nextPipe = Boolean(cur.remote && !fallback.url.startsWith("/") && (directMode || !fallback.direct));
      const nextKey = nextPipe ? `/api/stream?u=${encodeURIComponent(fallback.url)}` : fallback.url;
      pendingRef.current = {
        seek: el && el.currentTime > 0 ? el.currentTime : null,
        play: el ? !el.paused : true,
      };
      retryRef.current = { key: nextKey, tries: 0 };
      setSrcIdx(activeIdx + 1);
      setNote({ key: nextKey, text: `source dead — falling back to ${fallback.quality}` });
      return;
    }
    // 2.5 the direct instance url refused the browser — drop to the
    //     same-origin server pipe
    if (!directMode && cur.remote && active && !active.url.startsWith("/")) {
      const key = active ? `/api/stream?u=${encodeURIComponent(active.url)}` : "";
      pendingRef.current = {
        seek: el && el.currentTime > 0 ? el.currentTime : null,
        play: el ? !el.paused : true,
      };
      retryRef.current = { key, tries: 0 };
      setDirectMode(true);
      setNote({ key, text: "instance refused — rerouting through the server pipe" });
      return;
    }
    // 3. ONE fresh re-resolve — instance-proxy urls expire and a new
    //    race often picks a healthier instance
    if (cur.videoId && !resolveRef.current.redone) {
      resolveRef.current = { id: cur.videoId, tried: false, redone: true };
      setNote({ key: cur.videoId, text: "stream dead — re-resolving via invidious…" });
      applyMedia({ src: "", title: cur.title, videoId: cur.videoId, remote: false });
      return;
    }
    // 4. surface the real failure
    setNote({
      key: playUrl,
      text: "stream dead — every source gave up; try again in a moment",
    });
  };

  const switchQuality = (i: number) => {
    setMenuOpen(false);
    const el = videoRef.current;
    if (!el || i === activeIdx || !srcList[i]) return;
    pendingRef.current = {
      seek: el.currentTime > 0 ? el.currentTime : null,
      play: !el.paused,
    };
    retryRef.current = { key: "", tries: 0 };
    setSrcIdx(i);
    setNote(null);
  };

  /* ---------- effects ---------- */

  /* playbackRate: x4 while ff-warping, else the menu rate */
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.playbackRate = warp === "ff" ? FF_WARP_RATE : rate;
  }, [warp, rate, playUrl]);

  /* loop */
  useEffect(() => {
    const el = videoRef.current;
    if (el) el.loop = loop;
  }, [loop, playUrl]);

  /* ---------- hls.js transport — the LIVE-stream method ----------
     <video src> cannot touch an HLS playlist; hls.js re-muxes it through
     MSE. The manifest/segments come from the instance proxy (CORS *) —
     hlsPiped reroutes them through /api/stream only when that refuses. */
  const hlsRef = useRef<{ destroy: () => void } | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!isHls || !playUrl || !el) {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      return;
    }
    let dead = false;
    let owned: { destroy: () => void } | null = null;
    void (async () => {
      try {
        const mod = await import("hls.js");
        if (dead) return;
        const Hls = mod.default;
        const live = videoRef.current;
        if (!live) return;
        if (!Hls.isSupported()) {
          /* Safari / iOS play HLS natively */
          live.src = playUrl;
          void live.play().catch(() => undefined);
          return;
        }
        const hls = new Hls({ liveDurationInfinity: true, backBufferLength: 90 });
        owned = hls;
        hlsRef.current = hls;
        hls.attachMedia(live);
        hls.loadSource(playUrl);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          const v = videoRef.current;
          if (!v) return;
          void v.play().catch(() => {
            /* autoplay policy — start muted, the chip hands sound back */
            v.muted = true;
            void v
              .play()
              .then(() => setNeedSound(true))
              .catch(() => undefined);
          });
        });
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (!data.fatal) return;
          if (!hlsPiped && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            setHlsPiped(true);
            setNote({ key: playUrl, text: "live manifest refused — rerouting through the server pipe" });
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          setNote({ key: playUrl, text: "live stream dropped — try again in a moment" });
          hls.destroy();
          if (hlsRef.current === hls) hlsRef.current = null;
        });
      } catch {
        if (!dead) setNote({ key: playUrl, text: "hls engine failed to load — live unavailable" });
      }
    })();
    return () => {
      dead = true;
      if (owned) {
        owned.destroy();
        if (hlsRef.current === owned) hlsRef.current = null;
      }
    };
  }, [isHls, playUrl, hlsPiped]);

  useEffect(() => {
    const onFs = () => {
      const now = Boolean(document.fullscreenElement);
      setFs(now);
      if (now) pokeFs();
      else setFsShown(true);
    };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /* fullscreen UI: reveal on pointer movement, fade when idle */
  const pokeFs = useCallback(() => {
    setFsShown(true);
    if (fsHideTimerRef.current !== null) window.clearTimeout(fsHideTimerRef.current);
    fsHideTimerRef.current = window.setTimeout(() => setFsShown(false), FS_HIDE_MS);
  }, []);

  /* release holds anywhere — the pointer may leave the button mid-hold */
  useEffect(() => {
    if (!holding) return;
    const up = () => finishHold();
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [holding]);

  /* settings menu closes on any outside press */
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  /* transport keys — capture phase so Esc can eat the menu before the
     shell's own Escape handler closes the whole overlay */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (menuOpen) {
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen(false);
          return;
        }
        if (searchOpen) {
          e.preventDefault();
          e.stopPropagation();
          setSearchOpen(false);
          return;
        }
        if (fs) {
          e.preventDefault();
          e.stopPropagation();
          void document.exitFullscreen().catch(() => undefined);
          return;
        }
        return; // nothing open — the shell closes the overlay, as before
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          claimSound();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          claimSound();
          seekBy(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          claimSound();
          seekBy(5);
          break;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menuOpen, searchOpen, fs, togglePlay, seekBy, toggleFullscreen, claimSound]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  /* debounced live search while the panel is open */
  useEffect(() => {
    if (!searchOpen) return;
    const q = query.trim();
    if (q.length < 2) return;
    const t = window.setTimeout(() => void runSearch(q), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, searchOpen, runSearch]);

  /* timers die with the pane */
  useEffect(
    () => () => {
      if (rwTimerRef.current !== null) window.clearInterval(rwTimerRef.current);
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
      if (fsHideTimerRef.current !== null) window.clearTimeout(fsHideTimerRef.current);
    },
    [],
  );

  /* ---------- chrome bits — THIN: tight bars, small buttons ---------- */

  const tbtn =
    "flex h-6 w-6 cursor-pointer items-center justify-center border border-transparent text-[var(--term-fg)] transition-colors hover:border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] hover:text-[var(--term-brand)] disabled:cursor-not-allowed disabled:opacity-35";
  const tbtnPlay =
    "flex h-6 w-7 cursor-pointer items-center justify-center border border-[color-mix(in_srgb,var(--term-brand)_45%,transparent)] bg-[color-mix(in_srgb,var(--term-brand)_14%,transparent)] text-[var(--term-brand)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-brand)_24%,transparent)]";
  const hbtn =
    "flex h-5 w-5 cursor-pointer items-center justify-center text-[var(--term-fg)] transition-colors hover:text-[var(--term-brand)]";
  const sliderTrack =
    "h-1 w-full cursor-pointer appearance-none rounded bg-[color-mix(in_srgb,var(--term-fg)_18%,transparent)] accent-[var(--term-brand)]";
  const mrow = (on: boolean) =>
    `flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)] ${
      on ? "text-[var(--term-brand)]" : "text-[var(--term-fg)]"
    }`;
  const menuHead =
    "border-b border-[color-mix(in_srgb,var(--term-fg)_18%,transparent)] px-2 pb-1 pt-2 text-[10px] tracking-[0.3em] text-[var(--term-dim)]";
  const speedLabel = (v: number) => (v === 2 ? "2x — timelapse" : `${v}x`);

  const onSearchSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void runSearch(query);
  };

  const warpMode = lastWarpRef.current;
  const warpVisible = warp !== null || warpOut;

  /* the seek bar + clock */
  const seekRow = (
    <>
      <span className="w-[86px] shrink-0 text-[9.5px] text-[var(--term-dim)]" aria-label="position">
        {fmtTime(time)} / {duration > 0 ? fmtTime(duration) : "--:--"}
      </span>
      <input
        type="range"
        min={0}
        max={1000}
        value={duration > 0 ? Math.round((time / duration) * 1000) : 0}
        disabled={duration <= 0}
        aria-label="seek"
        onChange={(e) => {
          claimSound();
          seekTo((Number(e.target.value) / 1000) * duration);
        }}
        className={`${sliderTrack} min-w-[90px] flex-1 disabled:cursor-not-allowed [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--term-brand)]`}
      />
    </>
  );

  /* settings menu — quality (file sources) + speed + loop */
  const settingsMenu = menuOpen && (
    <div className="murke-scroll absolute bottom-full right-0 z-30 mb-2 max-h-[60vh] w-56 overflow-y-auto border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-[var(--term-bg)] text-[11px] shadow-[0_8px_24px_rgba(0,0,0,0.55)]">
      <div className={menuHead}>QUALITY</div>
      {srcList.length > 1 || (srcList.length === 1 && srcList[0].quality !== "auto") ? (
        srcList.map((s, i) => (
          <button
            key={`${s.quality}-${i}`}
            type="button"
            onClick={() => switchQuality(i)}
            aria-label={`quality ${s.quality}`}
            title={`switch to ${s.quality}`}
            className={mrow(i === activeIdx)}
          >
            <span className="w-3 shrink-0">{i === activeIdx ? ">" : ""}</span>
            <span className="min-w-0 flex-1 truncate">{s.quality}</span>
            {i === activeIdx && <span className="text-[10px] text-[var(--term-dim)]">active</span>}
          </button>
        ))
      ) : (
        <div className="flex items-center gap-2 px-2 py-1.5 text-[var(--term-dim)]">
          <span className="w-3 shrink-0">{">"}</span>
          <span className="min-w-0 flex-1 truncate">auto — single source</span>
          <span className="text-[10px]">locked</span>
        </div>
      )}
      <div className={menuHead}>SPEED</div>
      {SPEEDS.map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => {
            applyRate(v);
            setMenuOpen(false);
          }}
          aria-label={`playback speed ${speedLabel(v)}`}
          title={`playback speed ${speedLabel(v)}`}
          className={mrow(rate === v)}
        >
          <span className="w-3 shrink-0">{rate === v ? ">" : ""}</span>
          <span className="min-w-0 flex-1 truncate">{speedLabel(v)}</span>
        </button>
      ))}
      <div className={menuHead}>LOOP</div>
      <button
        type="button"
        onClick={() => setLoop((v) => !v)}
        aria-label="toggle loop"
        title={loop ? "loop on — click to disable" : "loop off — click to enable"}
        className={mrow(loop)}
      >
        <span className="w-3 shrink-0">{loop ? ">" : ""}</span>
        <span className="min-w-0 flex-1 truncate">loop this video</span>
        <span className="text-[10px] text-[var(--term-dim)]">{loop ? "on" : "off"}</span>
      </button>
      <div className="h-1.5" />
    </div>
  );

  /* the transport row — THIN and centered: [rw] [PLAY] [ff] with play
     EXACTLY between rewind and fast-forward; prev/next hug the edges,
     the timeline follows, settings + fullscreen pinned RIGHT. */
  const transportRow = (
    <div className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-0.5 text-[10.5px] text-[var(--term-fg)]">
      <button
        type="button"
        disabled={!prevPick}
        onClick={() => prevPick && void rollInto(prevPick)}
        aria-label="previous in queue"
        title={prevPick ? `prev: ${prevPick.title}` : "no previous in queue"}
        className={tbtn}
      >
        <SkipBack className="h-3 w-3" aria-hidden />
      </button>
      {/* CENTER CLUSTER — rw · PLAY · ff, play dead-center */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="rewind 10s — hold to scan back"
          title="rewind -10s (hold: warp scanback)"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            beginHold("rw");
          }}
          onContextMenu={(e) => {
            if (holding || warp) e.preventDefault();
          }}
          className={`${tbtn} touch-none select-none ${
            holding === "rw" || warp === "rw"
              ? "border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)] text-[var(--term-brand)]"
              : ""
          }`}
        >
          <Rewind className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => {
            if (suppressClickRef.current) return;
            claimSound();
            togglePlay();
          }}
          aria-label={playing ? "pause" : "play"}
          title="play/pause (space)"
          className={tbtnPlay}
        >
          {playing ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
        </button>
        <button
          type="button"
          aria-label="fast-forward 10s — hold for timelapse"
          title="forward +10s (hold: warp timelapse)"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            beginHold("ff");
          }}
          onContextMenu={(e) => {
            if (holding || warp) e.preventDefault();
          }}
          className={`${tbtn} touch-none select-none ${
            holding === "ff" || warp === "ff"
              ? "border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)] text-[var(--term-brand)]"
              : ""
          }`}
        >
          <FastForward className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <button
        type="button"
        disabled={!nextPick}
        onClick={() => nextPick && void rollInto(nextPick)}
        aria-label="next in queue"
        title={nextPick ? `next: ${nextPick.title}` : "no next in queue"}
        className={tbtn}
      >
        <SkipForward className="h-3 w-3" aria-hidden />
      </button>
      {seekRow}
      {/* RIGHT cluster: settings, fullscreen */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <div className="relative" ref={menuWrapRef}>
          <button
            type="button"
            onClick={() => {
              setMenuOpen((v) => !v);
              claimSound();
            }}
            aria-expanded={menuOpen}
            aria-label="player settings"
            title="settings — quality, speed, loop"
            className={`${tbtn} ${menuOpen ? "text-[var(--term-brand)]" : ""}`}
          >
            <Settings className="h-3.5 w-3.5" aria-hidden />
          </button>
          {settingsMenu}
        </div>
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={fs ? "exit fullscreen" : "fullscreen"}
          title="fullscreen (f)"
          className={tbtn}
        >
          {fs ? <Minimize className="h-3.5 w-3.5" aria-hidden /> : <Maximize className="h-3.5 w-3.5" aria-hidden />}
        </button>
      </div>
    </div>
  );

  const headerRow = (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-1 text-[10.5px] text-[var(--term-fg)]">
      <span className="min-w-0 truncate text-[var(--term-brand)]">watch — {cur.title}</span>
      <span className="flex shrink-0 items-center gap-1">
        {needsResolve || resolving ? (
          <span className="text-[9.5px] text-[var(--term-dim)]">[resolving]</span>
        ) : (
          active && <span className="text-[9.5px] text-[var(--term-dim)]">[{active.quality}]</span>
        )}
        <button
          type="button"
          onClick={() => {
            setSearchOpen((v) => !v);
            setMenuOpen(false);
          }}
          aria-expanded={searchOpen}
          aria-label="toggle search panel"
          title="search youtube"
          className={`${hbtn} ${searchOpen ? "text-[var(--term-brand)]" : ""}`}
        >
          <Search className="h-3 w-3" aria-hidden />
        </button>
        <button type="button" onClick={onClose} aria-label="close player" title="close (esc)" className={hbtn}>
          <X className="h-3 w-3" aria-hidden />
        </button>
      </span>
    </div>
  );

  const searchBody = (
    <>
      <div className="px-2 py-1.5 text-[10.5px] text-[var(--term-fg)]">
        <form className="flex items-center gap-2" onSubmit={onSearchSubmit}>
          <Search className="h-3 w-3 shrink-0 text-[var(--term-dim)]" aria-hidden />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search youtube — enter runs it"
            aria-label="search youtube"
            spellCheck={false}
            className="h-5.5 min-w-0 flex-1 border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-transparent px-1.5 text-[10.5px] text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)] focus:border-[var(--term-brand)]"
          />
          <button
            type="submit"
            disabled={searching}
            aria-label="run search"
            title="run search (enter)"
            className="h-5.5 cursor-pointer border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] px-2 text-[10px] transition-colors hover:border-[var(--term-brand)] hover:text-[var(--term-brand)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {searching ? "…" : "run"}
          </button>
        </form>
        {searchErr && <div className="pt-1 text-[10px] text-[var(--term-err)]">{searchErr}</div>}
        {/* scrollable — every hit reachable, thumbs re-served same-origin */}
        <div className="murke-scroll mt-1 max-h-[42vh] overflow-y-auto">
          {searching && results.length === 0 && (
            <div className="animate-pulse py-2 text-center text-[10px] text-[var(--term-dim)]">searching…</div>
          )}
          {!searching && results.length === 0 && !searchErr && (
            <div className="py-2 text-center text-[10px] text-[var(--term-dim)]">
              no results yet — type above, enter to run
            </div>
          )}
          {results.map((hit, i) => {
            const isCur = cur.videoId === hit.videoId;
            return (
              <button
                key={`${hit.videoId}-${i}`}
                type="button"
                disabled={Boolean(resolvingId)}
                onClick={() => void playPick(hit)}
                aria-label={`play ${hit.title}`}
                title={isCur ? "now playing" : `play: ${hit.title}`}
                className={`flex w-full cursor-pointer items-center gap-2 border-l-2 px-1 py-1 text-left text-[10.5px] transition-colors disabled:cursor-wait ${
                  isCur
                    ? "border-[var(--term-brand)] bg-[color-mix(in_srgb,var(--term-brand)_12%,transparent)] text-[var(--term-brand)]"
                    : "border-transparent hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]"
                }`}
              >
                <span className="relative block h-8 w-14 shrink-0 overflow-hidden bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]">
                  {hit.thumb ? (
                    <img
                      src={artUrl(hit.thumb)}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                  <span className="absolute bottom-0 right-0 bg-black/70 px-0.5 text-[8px] text-white">
                    {fmtDuration(hit.durationSec)}
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {resolvingId === hit.videoId ? <span className="animate-pulse">loading…</span> : hit.title}
                  </span>
                  <span className="block truncate text-[9.5px] text-[var(--term-dim)]">{hit.author}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );

  const stage = (
    <div
      ref={stageRef}
      onMouseMove={pokeFs}
      onTouchStart={pokeFs}
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black"
    >
      {playUrl ? (
        <video
          ref={videoRef}
          /* hls.js owns the media pipeline for live streams — no src attr,
             it attaches via MSE; setting one would fight the engine */
          src={isHls ? undefined : playUrl}
          crossOrigin={isHls ? undefined : "anonymous"}
          autoPlay
          playsInline
          onError={onError}
          onLoadedMetadata={onLoadedMeta}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onDurationChange={(e) =>
            setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)
          }
          onEnded={() => {
            if (warpRef.current) releaseWarp();
            if (nextPick && !loadingNext) void rollInto(nextPick);
          }}
          className="h-full w-full object-contain"
        />
      ) : needsResolve ? (
        <div className="flex flex-col items-center gap-2">
          <div className="animate-pulse font-mono text-[10.5px] text-[var(--term-dim)]">
            resolving via invidious…
          </div>
        </div>
      ) : (
        <div className="px-6 text-center text-[11px] text-[var(--term-dim)]">
          {note && note.key === cur.videoId
            ? note.text
            : "no playable source — open the search panel above or run watch <query> in the shell"}
        </div>
      )}

      {/* full-screen warp field — ff timelapse / rw scanback */}
      {warpVisible && (
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 z-40 select-none overflow-hidden font-mono ${
            warpMode === "rw" ? "vp-warp-back" : ""
          } ${warpOut ? "opacity-0 transition-opacity duration-300" : "opacity-100"}`}
        >
          <div className="vp-warp-streaks absolute inset-[-60%]" />
          <div className="vp-warp-stars absolute inset-[-60%]" />
          <div className="vp-warp-scan absolute inset-0" />
          <div className="vp-warp-vig absolute inset-0" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
            <div className="vp-warp-glow text-[17vh] font-bold leading-none tracking-[0.18em] text-[var(--term-brand)]">
              {warpMode === "rw" ? "RW" : "FF"}
            </div>
            <div className="tracking-[0.35em] text-[var(--term-hi)]">
              {warpMode === "rw" ? "<< SCANBACK" : "TIMELAPSE >>"}
            </div>
          </div>
        </div>
      )}

      {/* autoplay muted the stream — one tap hands the sound back */}
      {needSound && (
        <button
          type="button"
          onClick={claimSound}
          aria-label="enable sound"
          title="autoplay started muted — click for sound"
          className="absolute right-4 top-4 z-30 flex cursor-pointer items-center gap-2 border border-[color-mix(in_srgb,var(--term-brand)_55%,transparent)] bg-[color-mix(in_srgb,var(--term-bg)_85%,transparent)] px-2.5 py-1.5 font-mono text-[10.5px] text-[var(--term-fg)] transition-colors hover:text-[var(--term-brand)]"
        >
          <VolumeX className="h-3 w-3" aria-hidden /> tap for sound
        </button>
      )}
    </div>
  );

  const statusRow = (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-0 text-[9px] text-[var(--term-dim)]">
      <span className="min-w-0 truncate">
        {note && (note.key === playUrl || note.key === cur.videoId)
          ? note.text
          : isHls
            ? "live — hls.js carries the manifest · space play"
            : directMode
              ? "server pipe — streamed through /api/stream · space play · hold ff/rw to warp"
              : cur.remote
                ? "instance direct — the browser carries the stream · space play · hold ff/rw to warp"
                : "session cache — gone when the page is gone"}
      </span>
      {nextPick && (
        <button
          type="button"
          disabled={loadingNext}
          onClick={() => void rollInto(nextPick)}
          aria-label={`play next: ${nextPick.title}`}
          title={`up next: ${nextPick.title}`}
          className="flex shrink-0 cursor-pointer items-center gap-1 truncate text-[9.5px] text-[var(--term-dim)] transition-colors hover:text-[var(--term-brand)] disabled:opacity-50"
        >
          <ListMusic className="h-3 w-3" aria-hidden />
          {loadingNext ? "loading…" : `next: ${nextPick.title.slice(0, 38)}`}
        </button>
      )}
    </div>
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-[var(--term-bg)] font-mono">
      <style>{WARP_CSS}</style>

      {/* header — stable slot; in fullscreen it becomes the auto-hide top bar */}
      <div
        onMouseMove={pokeFs}
        className={
          fs
            ? `absolute inset-x-0 top-0 z-40 border-b border-white/10 bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300 ${
                fsShown ? "opacity-100" : "pointer-events-none opacity-0"
              }`
            : "contents"
        }
      >
        {headerRow}
      </div>

      {/* search panel — stable slot; overlays the stage in fullscreen */}
      <div
        onMouseMove={pokeFs}
        className={
          searchOpen
            ? fs
              ? "absolute inset-x-0 top-[26px] z-40 border-b border-white/10 bg-[color-mix(in_srgb,var(--term-bg)_92%,transparent)] shadow-[0_10px_30px_rgba(0,0,0,0.6)]"
              : "contents"
            : "hidden"
        }
      >
        {searchBody}
      </div>

      {/* stage — never unmounts, so playback survives fullscreen transitions */}
      {stage}

      {/* transport — stable slot; in fullscreen it becomes the auto-hide bottom bar */}
      <div
        onMouseMove={pokeFs}
        className={
          fs
            ? `absolute inset-x-0 bottom-0 z-40 border-white/10 bg-gradient-to-t from-black/85 via-black/60 to-transparent transition-opacity duration-300 ${
                fsShown ? "opacity-100" : "pointer-events-none opacity-0"
              }`
            : "contents"
        }
      >
        {transportRow}
      </div>

      {/* status line — hidden while fullscreen */}
      <div className={fs ? "hidden" : "contents"}>{statusRow}</div>
    </div>
  );
}
