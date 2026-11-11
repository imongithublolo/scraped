"use client";

/**
 * watch — the youtube app. THE METHOD THAT WORKS:
 *
 *  - SEARCH rides our own server (/api/yt2): it fetches youtube.com/results
 *    and parses ytInitialData — no invidious, no piped, no yt-dlp.
 *  - PLAYBACK uses the OFFICIAL youtube embed player (youtube-nocookie)
 *    inside an iframe. The video bytes come from the USER'S OWN connection
 *    to youtube's CDN — never through a proxy, never from a datacenter IP —
 *    which is exactly why this works when every resolver was walled.
 *  - chrome stays murke: terminal palette, queue with next/prev, fullscreen.
 *
 * arg: "q:<query>" pre-runs a search · "v:<videoId>" plays straight away ·
 * undefined lands on the search home.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Maximize, Minimize, Pause, Play, Search, SkipForward, X } from "lucide-react";
import { useOS } from "@/lib/murke/os-store";

interface YtHit {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  thumb: string;
  live?: boolean;
}

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** id from any youtube url, or the bare id */
function extractId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/.exec(s);
  return m?.[1] ?? null;
}

export default function WatchApp({ arg, onClose }: { arg?: string; onClose: () => void }) {
  /* ---------- state ---------- */
  const [query, setQuery] = useState(arg?.startsWith("q:") ? arg.slice(2) : "");
  const [phase, setPhase] = useState<"home" | "loading" | "results" | "error">("home");
  const [hits, setHits] = useState<YtHit[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [cur, setCur] = useState<YtHit | null>(null);
  const [playing, setPlaying] = useState(false);
  const [fs, setFs] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* ---------- search ---------- */

  const runSearch = useCallback(async (q: string) => {
    const needle = q.trim();
    if (!needle) return;
    const directId = extractId(needle);
    if (directId) {
      // a pasted link/id plays immediately
      setPhase("loading");
      setErr(null);
      try {
        const res = await fetch(`/api/yt2?u=${encodeURIComponent(directId)}`, { cache: "no-store" });
        const j = (await res.json().catch(() => null)) as { title?: string; author?: string } | null;
        setCur({
          videoId: directId,
          title: j?.title ?? directId,
          author: j?.author ?? "youtube",
          durationSec: 0,
          thumb: "",
        });
        setPlaying(true);
      } catch {
        setCur({ videoId: directId, title: directId, author: "youtube", durationSec: 0, thumb: "" });
        setPlaying(true);
      }
      return;
    }
    setPhase("loading");
    setErr(null);
    try {
      const res = await fetch(`/api/yt2?search=${encodeURIComponent(needle)}`, { cache: "no-store" });
      const j = (await res.json().catch(() => null)) as { ok?: boolean; results?: YtHit[]; error?: string } | null;
      if (!res.ok || !j?.ok || !Array.isArray(j.results) || j.results.length === 0) {
        setPhase("error");
        setErr(j?.error ?? `search failed (${res.status})`);
        return;
      }
      setHits(j.results.filter((h) => h.videoId && /^[\w-]{11}$/.test(h.videoId)).slice(0, 24));
      setPhase("results");
    } catch (e) {
      setPhase("error");
      setErr(e instanceof Error ? e.message : "search failed");
    }
  }, []);

  /* arg-driven boot: q: searches, v: plays (deferred so the effect body
     itself stays setState-free) */
  useEffect(() => {
    if (!arg) return;
    const t = window.setTimeout(() => {
      if (arg.startsWith("v:")) {
        const id = arg.slice(2);
        if (/^[\w-]{11}$/.test(id)) {
          setCur({ videoId: id, title: id, author: "youtube", durationSec: 0, thumb: "" });
          setPlaying(true);
        }
      } else if (arg.startsWith("q:") && arg.slice(2).trim()) {
        void runSearch(arg.slice(2));
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, [arg, runSearch]);

  /* ---------- queue ---------- */

  const qIdx = cur ? hits.findIndex((h) => h.videoId === cur.videoId) : -1;
  const next = qIdx >= 0 ? hits[qIdx + 1] ?? null : hits[0] ?? null;

  const playHit = (h: YtHit) => {
    setCur(h);
    setPlaying(true);
  };

  /* ---------- fullscreen ---------- */

  const toggleFs = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void stage.requestFullscreen().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onFs = () => setFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /* ---------- the embed player ---------- */

  const embedSrc = cur
    ? `https://www.youtube-nocookie.com/embed/${cur.videoId}?autoplay=${playing ? 1 : 0}&rel=1&modestbranding=1&playsinline=1`
    : "";

  const stage = (
    <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
      {cur ? (
        <iframe
          key={cur.videoId}
          src={embedSrc}
          title={cur.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          allowFullScreen
          className="h-full w-full border-0"
          aria-label={`youtube player — ${cur.title}`}
        />
      ) : (
        <div className="px-6 text-center text-[11px] text-[var(--term-dim)]">
          search youtube above — results play through youtube's own embed player, straight from their cdn to you
        </div>
      )}
    </div>
  );

  const backToList = () => {
    setPlaying(false);
    setCur(null);
    if (hits.length === 0) setPhase("home");
    else setPhase("results");
    window.setTimeout(() => inputRef.current?.focus(), 30);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--term-bg)]" role="region" aria-label="youtube watch app">
      {/* header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--term-fg)_22%,transparent)] px-2 py-1 text-[10.5px]">
        {cur ? (
          <button
            type="button"
            onClick={backToList}
            aria-label="back to results"
            title="back to results"
            className="cursor-pointer rounded p-1 text-[var(--term-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] hover:text-[var(--term-fg)]"
          >
            <ArrowLeft size={13} aria-hidden="true" />
          </button>
        ) : (
          <Search size={13} className="shrink-0 text-[var(--term-brand)]" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-[var(--term-brand)]">
          watch — {cur ? cur.title : "youtube, the method that works"}
        </span>
        {cur && (
          <button
            type="button"
            onClick={toggleFs}
            aria-label={fs ? "exit fullscreen" : "fullscreen"}
            title="fullscreen (youtube's own button works too)"
            className="cursor-pointer rounded p-1 text-[var(--term-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] hover:text-[var(--term-fg)]"
          >
            {fs ? <Minimize size={13} aria-hidden="true" /> : <Maximize size={13} aria-hidden="true" />}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="close watch"
          title="close (esc)"
          className="cursor-pointer rounded p-1 text-[var(--term-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] hover:text-[var(--term-fg)]"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      {/* search row */}
      <form
        className="flex shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] px-2 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          setPlaying(false);
          setCur(null);
          void runSearch(query);
        }}
      >
        <Search size={12} className="shrink-0 text-[var(--term-dim)]" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search youtube — or paste a link / id"
          aria-label="search youtube"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] bg-transparent px-2 py-1 text-[11.5px] text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)] focus:border-[var(--term-brand)]"
        />
        <button
          type="submit"
          disabled={phase === "loading" || !query.trim()}
          aria-label="run search"
          className="cursor-pointer border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] px-2.5 py-1 text-[10.5px] text-[var(--term-fg)] transition-colors hover:border-[var(--term-brand)] hover:text-[var(--term-brand)] disabled:opacity-40"
        >
          {phase === "loading" ? "…" : "run"}
        </button>
      </form>

      {/* stage + list */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {stage}

        {/* results / home / error rail */}
        <div className="murke-scroll max-h-[46vh] w-full shrink-0 overflow-y-auto border-t border-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] p-2 lg:max-h-none lg:w-[340px] lg:border-l lg:border-t-0">
          {phase === "loading" && (
            <div className="space-y-2" aria-label="searching">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex animate-pulse gap-2">
                  <div className="h-10 w-16 shrink-0 rounded bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]" />
                  <div className="flex-1 space-y-1 py-1">
                    <div className="h-2 w-4/5 rounded bg-[color-mix(in_srgb,var(--term-fg)_9%,transparent)]" />
                    <div className="h-2 w-2/5 rounded bg-[color-mix(in_srgb,var(--term-fg)_6%,transparent)]" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {phase === "error" && (
            <div className="rounded-lg border border-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] p-3">
              <p className="text-[11px] text-[var(--term-err)]">{err}</p>
              <button
                type="button"
                onClick={() => void runSearch(query)}
                className="mt-2 cursor-pointer rounded-full border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-3 py-1 text-[10.5px] text-[var(--term-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)]"
              >
                retry
              </button>
            </div>
          )}

          {phase === "home" && (
            <div className="px-1 py-3 text-[10.5px] leading-relaxed text-[var(--term-dim)]">
              <p className="mb-2 text-[var(--term-fg)]">how this plays:</p>
              <p>· the search runs on murke's server — it reads youtube's own results page</p>
              <p>· playback is youtube's official embed — the stream flows from their cdn straight to you</p>
              <p>· no proxies in the middle, so nothing gets walled</p>
              <p className="mt-2">type above and hit run.</p>
            </div>
          )}

          {phase === "results" && (
            <ul className="space-y-1">
              {hits.map((h, i) => {
                const isCur = cur?.videoId === h.videoId;
                return (
                  <li key={`${h.videoId}-${i}`}>
                    <button
                      type="button"
                      onClick={() => playHit(h)}
                      aria-label={`play ${h.title}`}
                      title={isCur ? "now playing" : h.title}
                      className={`flex w-full cursor-pointer items-center gap-2 border-l-2 px-1.5 py-1 text-left text-[10.5px] transition-colors ${
                        isCur
                          ? "border-[var(--term-brand)] bg-[color-mix(in_srgb,var(--term-brand)_12%,transparent)] text-[var(--term-brand)]"
                          : "border-transparent text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)]"
                      }`}
                    >
                      <span className="relative block h-9 w-16 shrink-0 overflow-hidden rounded bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]">
                        {h.thumb ? (
                          <img src={h.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
                        ) : null}
                        {h.durationSec > 0 && (
                          <span className="absolute bottom-0 right-0 bg-black/70 px-0.5 text-[7.5px] text-white">
                            {fmtDuration(h.durationSec)}
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{h.title}</span>
                        <span className="block truncate text-[9.5px] text-[var(--term-dim)]">{h.author}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {/* queue footer — next in the results */}
          {cur && next && (
            <button
              type="button"
              onClick={() => playHit(next)}
              className="mt-2 flex w-full cursor-pointer items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] px-2 py-1.5 text-left text-[10.5px] text-[var(--term-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_6%,transparent)] hover:text-[var(--term-fg)]"
            >
              <SkipForward size={11} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">up next — {next.title}</span>
            </button>
          )}
        </div>
      </div>

      {/* playing chip — fake controls are honest: youtube's player owns transport */}
      {cur && (
        <div className="flex shrink-0 items-center gap-2 border-t border-[color-mix(in_srgb,var(--term-fg)_22%,transparent)] px-2 py-1 text-[9.5px] text-[var(--term-dim)]">
          <span className="flex h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: playing ? "var(--term-brand)" : "var(--term-dim)" }} aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            {playing ? "streaming from youtube's cdn" : "paused — press play in the player"} · {cur.author}
          </span>
          <button
            type="button"
            onClick={() => setPlaying((v) => !v)}
            aria-label={playing ? "pause" : "play"}
            title="play/pause (reload-safe)"
            className="cursor-pointer rounded p-0.5 transition-colors hover:text-[var(--term-fg)]"
          >
            {playing ? <Pause size={11} aria-hidden="true" /> : <Play size={11} aria-hidden="true" />}
          </button>
        </div>
      )}
    </div>
  );
}
