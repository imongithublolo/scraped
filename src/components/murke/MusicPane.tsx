"use client";

/**
 * music — the terminal-native streaming pane. INVIDIOUS END TO END.
 *
 * SEARCH hits the invidious instance pool raced from the user's own
 * browser (yt.ts — instances wall datacenters, not residential ips), so
 * rows are REAL youtube tracks with real durations. PLAY resolves the
 * video's best audio format (instance-proxy url) and hands the howler
 * singleton a same-origin-pipe-first chain — full length by
 * construction, there is NO 30s preview anywhere in this system.
 * ARTWORK is the video thumbnail re-served same-origin through
 * /api/artwork, so images always load (no hotlinking, no CDN refusals).
 * ARTIST PROFILES: rows carry the channel id — tapping the author opens
 * the channel's uploads right in this pane, "back to results" restores
 * the search instantly (state never left).
 *
 * Bottom bar: transport LEFT (prev, -10s, play/pause, +10s, next), the
 * TIMELINE in the middle, volume + settings on the right. The status
 * surfaces the active carry mode (pipe / direct), errors and hints. No
 * emojis — lucide icons only. Every control is keyboard-reachable and
 * aria-labelled.
 *
 * The pane mirrors the musicPlayer singleton every tick, so CLI control
 * (`music pause`, `music yt …`) visibly moves this UI too.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  FastForward,
  Music2,
  Pause,
  Play,
  Rewind,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  Trash2,
  User,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { musicPlayer, type PlayerNow } from "@/lib/murke/player";
import { artUrl } from "@/lib/murke/inv";
import { channelYt, findChannels, fmtDuration, searchYt, type YtSearchHit } from "@/lib/murke/yt";
import { playYtVideo } from "@/lib/murke/yt-audio";

/** one search hit, normalized for the rows */
interface TrackResult {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  thumb: string;
  durationSec: number;
  live: boolean;
}

interface ArtistProfile {
  id: string;
  name: string;
}

type Note = { text: string; kind: "err" | "dim" };

function toRows(hits: YtSearchHit[]): TrackResult[] {
  return hits
    .filter((h) => h.videoId)
    .map((h) => ({
      id: h.videoId,
      title: h.title,
      artist: h.author || "youtube",
      artistId: h.authorId ?? "",
      thumb: h.thumb ? artUrl(h.thumb) : "",
      durationSec: h.durationSec,
      live: h.live === true,
    }));
}

/** album art / channel art with a same-origin proxy src and an icon fallback */
function ArtImg({
  src,
  alt,
  boxClass,
  icon,
}: {
  src: string;
  alt: string;
  boxClass: string;
  icon: React.ReactNode;
}) {
  const [broken, setBroken] = useState(false);
  const [lastSrc, setLastSrc] = useState(src);
  if (lastSrc !== src) {
    // reset the error state when the src changes — during render, the
    // React-approved way (an effect would cascade)
    setLastSrc(src);
    setBroken(false);
  }
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] ${boxClass}`}
    >
      {broken || !src ? (
        <span className="text-[var(--term-dim)]">{icon}</span>
      ) : (
        <img
          src={src}
          alt={alt}
          className="h-full w-full object-cover"
          onError={() => setBroken(true)}
          loading="lazy"
        />
      )}
    </span>
  );
}

function TrackRow({
  r,
  active,
  playing,
  resolving,
  onPlay,
  onArtist,
}: {
  r: TrackResult;
  active: boolean;
  playing: boolean;
  resolving: boolean;
  onPlay: () => void;
  onArtist: () => void;
}) {
  return (
    <div
      className={`group flex w-full items-center gap-2.5 border-l-2 px-1.5 py-1.5 transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] ${
        active
          ? "border-[var(--term-brand)] bg-[color-mix(in_srgb,var(--term-brand)_8%,transparent)]"
          : "border-transparent"
      }`}
    >
      <button
        type="button"
        onClick={onPlay}
        aria-label={`${active && playing ? "pause" : "play"} ${r.title}`}
        className="relative shrink-0 cursor-pointer overflow-hidden"
      >
        <ArtImg
          src={r.thumb}
          alt=""
          boxClass="h-9 w-16"
          icon={<Music2 size={14} />}
        />
        <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
          {resolving ? (
            <span className="text-[9px] uppercase tracking-widest text-white">…</span>
          ) : active && playing ? (
            <Pause size={13} className="text-white" />
          ) : (
            <Play size={13} className="text-white" />
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={onPlay}
        className="min-w-0 flex-1 cursor-pointer text-left"
        title={r.title}
      >
        <span
          className={`block truncate text-[11px] ${
            active ? "text-[var(--term-brand)]" : "text-[var(--term-fg)]"
          }`}
        >
          {r.title}
        </span>
        <span className="block truncate text-[10px] text-[var(--term-dim)]">
          {r.durationSec > 0 ? `${fmtDuration(r.durationSec)} · ` : ""}
          {r.live ? "live · " : ""}
          {r.artist}
        </span>
      </button>
      <button
        type="button"
        onClick={onArtist}
        aria-label={`open artist ${r.artist}`}
        title="artist profile"
        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-[var(--term-dim)] opacity-0 transition-opacity hover:text-[var(--term-brand)] focus-visible:opacity-100 group-hover:opacity-100"
      >
        <User size={13} />
      </button>
    </div>
  );
}

export default function MusicPane({
  initialQuery,
  onClose,
}: {
  initialQuery?: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TrackResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState<Note | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [cur, setCur] = useState<PlayerNow | null>(null);
  const [queue, setQueue] = useState<{ id: string; name: string }[]>([]);
  const [vol, setVol] = useState(80);
  const [prevVol, setPrevVol] = useState(80);
  const [autoplay, setAutoplay] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  // artist profile — an in-pane view, no new routes/windows; the search
  // results stay in state so "back to results" restores them instantly
  const [artist, setArtist] = useState<ArtistProfile | null>(null);
  const [artistTracks, setArtistTracks] = useState<TrackResult[]>([]);
  const [artistLoading, setArtistLoading] = useState(false);
  /** thumb per queue id — the now-playing artwork comes from here */
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  const seqRef = useRef(0);
  const lastSearchedRef = useRef<string | null>(null);
  const bootedRef = useRef(false);
  const resolvingRef = useRef<Set<string>>(new Set());
  const autoplayRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);

  /* ---------- playing a search hit ---------- */

  const playRow = useCallback(async (row: TrackResult) => {
    if (resolvingRef.current.has(row.id)) return; // no double-resolution
    resolvingRef.current.add(row.id);
    setResolving((r) => ({ ...r, [row.id]: true }));
    setThumbs((t) => ({ ...t, [`yt:${row.id}`]: row.thumb }));
    setNote({ text: `resolving "${row.title}" via invidious…`, kind: "dim" });
    try {
      const r = await playYtVideo(row.id, {
        trackId: `yt:${row.id}`,
        name: `${row.title} — ${row.artist}`,
      });
      if (r.ok) {
        setNote(null);
      } else {
        setNote({ text: `music: ${r.error}`, kind: "err" });
      }
    } catch (e) {
      setNote({
        text: `playback failed — ${e instanceof Error ? e.message : "resolve error"}`,
        kind: "err",
      });
    } finally {
      resolvingRef.current.delete(row.id);
      setResolving((r) => {
        if (!(row.id in r)) return r;
        const next = { ...r };
        delete next[row.id];
        return next;
      });
    }
  }, []);

  /* ---------- search ---------- */

  const runSearch = useCallback(async (raw: string, autoplayFirst: boolean) => {
    const q = raw.trim();
    if (q.length < 2) return;
    lastSearchedRef.current = q;
    const seq = ++seqRef.current;
    setSearching(true);
    setNote(null);
    try {
      const hits = await searchYt(q);
      if (seq !== seqRef.current) return; // a newer search superseded this one
      // a fresh search always lands back on the results list
      setArtist(null);
      setArtistTracks([]);
      const rows = toRows(hits.filter((h) => !h.live));
      setResults(rows);
      setThumbs((t) => {
        const next = { ...t };
        for (const r of rows) next[`yt:${r.id}`] = r.thumb;
        return next;
      });
      if (rows.length === 0) {
        setNote({ text: `nothing found for "${q}"`, kind: "dim" });
      } else if (autoplayFirst) {
        setNote({ text: `auto-playing top hit for "${q}"`, kind: "dim" });
        void playRow(rows[0]);
      }
    } catch (e) {
      if (seq === seqRef.current) {
        setResults([]);
        setNote({
          text: e instanceof Error ? e.message : "search failed — every invidious instance is walled",
          kind: "err",
        });
      }
    } finally {
      if (seq === seqRef.current) setSearching(false);
    }
  }, [playRow]);

  /* ---------- artist profile ---------- */

  const openArtist = useCallback(async (id: string, fallbackName: string) => {
    setArtist({ id, name: fallbackName });
    setArtistTracks([]);
    setArtistLoading(true);
    setNote({ text: `opening artist profile — ${fallbackName}…`, kind: "dim" });
    try {
      let uploads = id ? await channelYt(id) : [];
      if (uploads.length === 0) {
        // no channel id — find the artist by name and try their channel
        const found = await findChannels(fallbackName);
        if (found.length > 0) {
          setArtist({ id: found[0].authorId, name: found[0].author || fallbackName });
          uploads = await channelYt(found[0].authorId);
        }
      }
      const rows = toRows(uploads.filter((h) => !h.live));
      setArtistTracks(rows);
      setThumbs((t) => {
        const next = { ...t };
        for (const r of rows) next[`yt:${r.id}`] = r.thumb;
        return next;
      });
      setNote(rows.length === 0 ? { text: "no uploads found for this artist", kind: "dim" } : null);
    } catch {
      setNote({ text: "artist lookup failed — network error", kind: "err" });
    } finally {
      setArtistLoading(false);
    }
  }, []);

  /** back to the search results — they never left state, so no refetch */
  const closeArtist = useCallback(() => {
    setArtist(null);
    setArtistTracks([]);
  }, []);

  /* ---------- transport ---------- */

  const skip = useCallback((dir: "next" | "prev") => {
    const list = musicPlayer.list();
    if (list.length === 0) return;
    const now = musicPlayer.current();
    const idx = now ? list.findIndex((t) => t.id === now.id) : -1;
    const len = list.length;
    // the queue is newest-first: "next" walks toward older tracks
    // (idx + 1), "prev" back toward newer — same math as the CLI
    const t =
      idx === -1
        ? dir === "next"
          ? list[0]
          : list[len - 1]
        : list[dir === "next" ? (idx + 1) % len : (idx - 1 + len) % len];
    if (t) musicPlayer.play(t.id);
  }, []);

  const nudge = useCallback((delta: number) => {
    const now = musicPlayer.current();
    if (!now) return;
    musicPlayer.seek(Math.max(0, now.positionSec + delta));
  }, []);

  const togglePlay = useCallback(() => {
    if (musicPlayer.current()) {
      musicPlayer.togglePause();
      return;
    }
    const first = musicPlayer.list()[0];
    if (first) musicPlayer.play(first.id);
  }, []);

  const toggleMute = useCallback(() => {
    if (vol > 0) {
      setPrevVol(vol);
      musicPlayer.volume(0);
      setVol(0);
    } else {
      const back = prevVol > 0 ? prevVol : 80;
      musicPlayer.volume(back);
      setVol(back);
    }
  }, [vol, prevVol]);

  const clearQueue = useCallback(() => {
    musicPlayer.clear();
    setMenuOpen(false);
    setNote({ text: "queue cleared — session history wiped", kind: "dim" });
  }, []);

  /* ---------- effects ---------- */

  // boot: `music <search>` preloads the box and auto-plays the top hit
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    setVol(musicPlayer.volumePct());
    setPrevVol(musicPlayer.volumePct() || 80);
    const q = (initialQuery ?? "").trim();
    if (!q) {
      inputRef.current?.focus();
      return;
    }
    setQuery(q);
    void runSearch(q, true);
  }, [initialQuery, runSearch]);

  // live mirror of the player singleton — onTick fires on howler
  // play/pause/stop/end/load plus every 1s while playing, so CLI control
  // (`music pause`, `music yt …`) visibly moves this UI
  useEffect(() => {
    const sync = () => {
      setPlaying(musicPlayer.playing());
      setQueue(musicPlayer.list());
      const now = musicPlayer.current();
      setCur(now);
      setPos(now?.positionSec ?? 0);
      setDur(now?.durationSec ?? 0);
    };
    sync();
    musicPlayer.onTick(sync);
    musicPlayer.onEnded(() => {
      if (autoplayRef.current) skip("next");
    });
    musicPlayer.onError(({ name }) => {
      setNote({
        text: `playback failed — every invidious source gave up ("${name}")`,
        kind: "err",
      });
    });
    return () => {
      musicPlayer.onTick(null);
      musicPlayer.onEnded(null);
      musicPlayer.onError(null);
    };
  }, [skip]);

  useEffect(() => {
    autoplayRef.current = autoplay;
  }, [autoplay]);

  // 400ms debounce as-you-type (Enter searches immediately)
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || q === lastSearchedRef.current) return;
    const t = setTimeout(() => {
      if (q.length < 2 || q === lastSearchedRef.current) return;
      void runSearch(q, false);
    }, 400);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  // the settings menu closes on outside click / Esc
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (menuRef.current?.contains(target)) return;
      if (settingsRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  /* ---------- render ---------- */

  const curId = cur?.id ?? null;
  const nowThumb = curId ? (thumbs[curId] ?? "") : "";
  const nowTitle = cur?.name ?? "";
  const nowSub = nowTitle.includes(" — ") ? nowTitle.slice(nowTitle.indexOf(" — ") + 3) : "";
  const shownPos = scrub !== null ? scrub : pos;
  const mode = cur?.mode ?? null;

  const transportBtn =
    "flex h-8 w-8 cursor-pointer items-center justify-center text-[var(--term-fg)] transition-colors hover:text-[var(--term-hi)]";

  return (
    <div className="flex h-full w-full flex-col bg-[var(--term-bg)] font-mono text-[var(--term-fg)]">
      {/* header — same chrome pattern as the other panes */}
      <div className="flex shrink-0 items-center gap-3 border-b border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-3 py-1.5 text-xs">
        <span className="shrink-0 font-bold tracking-[0.3em] text-[var(--term-brand)]">music</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--term-dim)]">
          {nowTitle
            ? `now — ${nowTitle}`
            : "search a track · full songs via invidious · no previews · try: lofi"}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="close music"
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)]"
        >
          <X size={13} />
        </button>
      </div>

      {/* search */}
      <div className="shrink-0 px-3 pt-3">
        <div className="flex items-center gap-2 border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-[color-mix(in_srgb,var(--term-fg)_5%,transparent)] px-2.5 py-2 focus-within:border-[var(--term-brand)]">
          <Search size={13} className="shrink-0 text-[var(--term-dim)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runSearch(query, false);
              }
            }}
            placeholder="songs, artists…"
            spellCheck={false}
            aria-label="search music"
            className="min-w-0 flex-1 bg-transparent text-xs text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)]"
          />
          {searching && <span className="shrink-0 text-[10px] text-[var(--term-dim)]">searching…</span>}
        </div>
      </div>

      {/* now playing — the big clear block, only while something is loaded */}
      {cur && (
        <div className="shrink-0 px-3 pt-2">
          <div
            aria-label="now playing"
            className="flex items-center gap-3 border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-[color-mix(in_srgb,var(--term-brand)_6%,transparent)] px-3 py-2.5"
          >
            <ArtImg
              key={nowThumb || "none"}
              src={nowThumb}
              alt="artwork"
              boxClass="h-14 w-14 border border-[color-mix(in_srgb,var(--term-fg)_20%,transparent)]"
              icon={<Music2 size={20} />}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`murke-eq shrink-0 ${playing ? "" : "murke-eq-paused"}`}
                >
                  <span />
                  <span />
                  <span />
                </span>
                <span className="shrink-0 text-[9px] uppercase tracking-widest text-[var(--term-brand)]">
                  {playing ? "playing" : "paused"}
                </span>
                <span className="shrink-0 border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] px-1 text-[9px] uppercase tracking-widest text-[var(--term-dim)]">
                  full track
                </span>
              </span>
              <span className="mt-0.5 block truncate text-sm text-[var(--term-hi)]" title={nowTitle}>
                {nowTitle || "—"}
              </span>
              {nowSub && (
                <span className="block truncate text-[10px] text-[var(--term-dim)]">{nowSub}</span>
              )}
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-[10px] text-[var(--term-dim)]">
                {dur > 0
                  ? `${fmtDuration(shownPos)} / ${fmtDuration(dur)}`
                  : shownPos > 0
                    ? `${fmtDuration(shownPos)} · stream`
                    : "buffering…"}
              </span>
              {mode && (
                <span
                  aria-label={`stream mode ${mode}`}
                  className="mt-1 inline-block border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-1 text-[9px] uppercase tracking-widest text-[var(--term-dim)]"
                >
                  {mode === "direct" ? "instance direct" : "server pipe"}
                </span>
              )}
            </span>
          </div>
        </div>
      )}

      {/* results / artist profile — one scroll area, two views */}
      <div className="flex min-h-0 flex-1 flex-col px-3 pt-2">
        <div className="flex shrink-0 items-center justify-between pb-1 text-[10px] uppercase tracking-widest text-[var(--term-dim)]">
          <span>{artist ? "artist profile" : "results"}</span>
          {artist ? (
            <span>{artistTracks.length} tracks</span>
          ) : (
            results.length > 0 && <span>{results.length} tracks</span>
          )}
        </div>
        <div className="murke-scroll min-h-0 flex-1 overflow-y-auto pr-0.5">
          {artist ? (
            <>
              <button
                type="button"
                onClick={closeArtist}
                aria-label="back to search results"
                className="mb-1.5 flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--term-dim)] transition-colors hover:text-[var(--term-brand)]"
              >
                <ArrowLeft size={12} className="shrink-0" />
                <span>back to results</span>
              </button>
              <div className="mb-1 flex items-center gap-3 border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-[color-mix(in_srgb,var(--term-brand)_6%,transparent)] px-3 py-2.5">
                <ArtImg
                  key={artistTracks[0]?.thumb || "none"}
                  src={artistTracks[0]?.thumb || ""}
                  alt={`${artist.name} channel art`}
                  boxClass="h-14 w-14 border border-[color-mix(in_srgb,var(--term-fg)_20%,transparent)]"
                  icon={<User size={20} />}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[9px] uppercase tracking-widest text-[var(--term-brand)]">
                    artist profile
                  </span>
                  <span className="block truncate text-sm text-[var(--term-hi)]" title={artist.name}>
                    {artist.name}
                  </span>
                  <span className="block truncate text-[10px] text-[var(--term-dim)]">
                    {artistLoading ? "loading…" : `${artistTracks.length} tracks`}
                  </span>
                </span>
              </div>
              {artistLoading ? (
                <div className="flex h-20 items-center justify-center text-[11px] text-[var(--term-dim)]">
                  loading artist profile…
                </div>
              ) : artistTracks.length === 0 ? (
                <div className="flex h-20 items-center justify-center text-[11px] text-[var(--term-dim)]">
                  no tracks found for this artist
                </div>
              ) : (
                artistTracks.map((r) => {
                  const active = curId === `yt:${r.id}`;
                  return (
                    <TrackRow
                      key={r.id}
                      r={r}
                      active={active}
                      playing={playing}
                      resolving={Boolean(resolving[r.id])}
                      onPlay={() => void playRow(r)}
                      onArtist={() => void openArtist(r.artistId, r.artist)}
                    />
                  );
                })
              )}
            </>
          ) : results.length === 0 ? (
            <div className="flex h-full min-h-24 flex-col items-center justify-center gap-1.5 text-[11px] text-[var(--term-dim)]">
              <Music2 size={18} className="text-[color-mix(in_srgb,var(--term-fg)_35%,transparent)]" />
              <span>{searching ? "searching…" : "nothing here yet — search to fill the list"}</span>
            </div>
          ) : (
            results.map((r) => {
              const active = curId === `yt:${r.id}`;
              return (
                <TrackRow
                  key={r.id}
                  r={r}
                  active={active}
                  playing={playing}
                  resolving={Boolean(resolving[r.id])}
                  onPlay={() => void playRow(r)}
                  onArtist={() => void openArtist(r.artistId, r.artist)}
                />
              );
            })
          )}
        </div>
      </div>

      {/* queue / recent */}
      <div className="shrink-0 border-t border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-3 pt-1.5">
        <div className="flex items-center justify-between pb-1 text-[10px] uppercase tracking-widest text-[var(--term-dim)]">
          <span>queue / recent</span>
          <span>{queue.length > 0 ? `${queue.length} this session` : "empty"}</span>
        </div>
        <div className="murke-scroll max-h-24 overflow-y-auto pb-1.5 pr-0.5">
          {queue.length === 0 ? (
            <div className="px-1.5 text-[10px] text-[var(--term-dim)]">
              tracks you play land here (newest first) · stale ones re-resolve on replay
            </div>
          ) : (
            queue.map((t) => (
              <div
                key={t.id}
                className={`group flex w-full items-center gap-2 px-1.5 py-1 text-[11px] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] ${
                  t.id === curId ? "text-[var(--term-brand)]" : "text-[var(--term-dim)]"
                }`}
              >
                <Music2 size={11} className="shrink-0" />
                <button
                  type="button"
                  onClick={() => musicPlayer.play(t.id)}
                  aria-label={`play ${t.name}`}
                  title={t.name}
                  className="min-w-0 flex-1 cursor-pointer truncate text-left"
                >
                  {t.name}
                </button>
                {t.id === curId && (
                  <span className="shrink-0 text-[9px] uppercase tracking-widest">now</span>
                )}
                <button
                  type="button"
                  onClick={() => musicPlayer.remove(t.id)}
                  aria-label={`remove ${t.name} from queue`}
                  title="remove"
                  className="shrink-0 cursor-pointer opacity-0 transition-opacity hover:text-[var(--term-err)] group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* inline message line — errors and hints, never alert() */}
      {note && (
        <div
          role="status"
          className={`shrink-0 border-t border-[color-mix(in_srgb,var(--term-fg)_15%,transparent)] px-3 py-1 text-[10px] ${
            note.kind === "err" ? "text-[var(--term-err)]" : "text-[var(--term-dim)]"
          }`}
        >
          {note.text}
        </div>
      )}

      {/* player bar — transport LEFT · timeline MIDDLE · volume + settings RIGHT */}
      <div className="flex shrink-0 items-center gap-3 border-t border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-3 py-2">
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => skip("prev")}
            aria-label="previous track"
            title="prev"
            className={transportBtn}
          >
            <SkipBack size={15} />
          </button>
          <button
            type="button"
            onClick={() => nudge(-10)}
            aria-label="rewind 10 seconds"
            title="-10s"
            className={transportBtn}
          >
            <Rewind size={15} />
          </button>
          <button
            type="button"
            onClick={togglePlay}
            aria-label={playing ? "pause" : "play"}
            title={playing ? "pause" : "play"}
            className="flex h-8 w-8 cursor-pointer items-center justify-center text-[var(--term-brand)] transition-colors hover:text-[var(--term-hi)]"
          >
            {playing ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <button
            type="button"
            onClick={() => nudge(10)}
            aria-label="forward 10 seconds"
            title="+10s"
            className={transportBtn}
          >
            <FastForward size={15} />
          </button>
          <button
            type="button"
            onClick={() => skip("next")}
            aria-label="next track"
            title="next"
            className={transportBtn}
          >
            <SkipForward size={15} />
          </button>
        </div>

        {/* THE timeline — spans the middle, click/drag to seek */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="w-10 shrink-0 text-right text-[10px] text-[var(--term-dim)]">
            {fmtDuration(shownPos)}
          </span>
          <input
            type="range"
            min={0}
            max={dur > 0 ? Math.round(dur) : 0}
            value={dur > 0 ? Math.min(Math.round(shownPos), Math.round(dur)) : 0}
            disabled={dur <= 0}
            aria-label="timeline"
            onChange={(e) => setScrub(Math.max(0, Math.min(Number(e.target.value), Math.round(dur))))}
            onPointerUp={() => {
              if (scrub !== null) {
                musicPlayer.seek(scrub);
                setScrub(null);
              }
            }}
            onKeyUp={(e) => {
              if (e.key.startsWith("Arrow") && scrub !== null) {
                musicPlayer.seek(scrub);
                setScrub(null);
              }
            }}
            onBlur={() => {
              if (scrub !== null) {
                musicPlayer.seek(scrub);
                setScrub(null);
              }
            }}
            className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded bg-[color-mix(in_srgb,var(--term-fg)_18%,transparent)] accent-[var(--term-brand)] disabled:cursor-not-allowed disabled:opacity-40 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--term-brand)]"
          />
          <span className="w-10 shrink-0 text-[10px] text-[var(--term-dim)]">
            {dur > 0 ? fmtDuration(dur) : "--:--"}
          </span>
        </div>

        {/* volume */}
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={toggleMute}
            aria-label={vol > 0 ? "mute" : "unmute"}
            title={vol > 0 ? "mute" : "unmute"}
            className="flex h-8 w-6 cursor-pointer items-center justify-center text-[var(--term-fg)] transition-colors hover:text-[var(--term-hi)]"
          >
            {vol > 0 ? <Volume2 size={14} /> : <VolumeX size={14} />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={vol}
            aria-label="volume"
            title={`volume ${vol}%`}
            onChange={(e) => {
              const v = Math.max(0, Math.min(100, Number(e.target.value)));
              musicPlayer.volume(v);
              setVol(v);
              if (v > 0) setPrevVol(v);
            }}
            className="h-1 w-16 cursor-pointer appearance-none rounded bg-[color-mix(in_srgb,var(--term-fg)_18%,transparent)] accent-[var(--term-brand)] [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--term-brand)]"
          />
        </div>

        {/* settings */}
        <div className="relative shrink-0">
          <button
            ref={settingsRef}
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="player settings"
            aria-expanded={menuOpen}
            className={`flex h-8 w-8 cursor-pointer items-center justify-center transition-colors hover:text-[var(--term-hi)] ${
              menuOpen ? "text-[var(--term-brand)]" : "text-[var(--term-fg)]"
            }`}
          >
            <Settings size={15} />
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              className="absolute bottom-full right-0 z-20 mb-2 w-56 border border-[color-mix(in_srgb,var(--term-fg)_35%,transparent)] bg-[var(--term-bg)] shadow-[0_0_18px_rgba(0,0,0,0.55)]"
            >
              <button
                type="button"
                onClick={() => setAutoplay((a) => !a)}
                className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-[11px] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]"
              >
                <span className="text-[var(--term-fg)]">autoplay next</span>
                <span className={autoplay ? "text-[var(--term-brand)]" : "text-[var(--term-dim)]"}>
                  {autoplay ? "on" : "off"}
                </span>
              </button>
              <div className="border-t border-[color-mix(in_srgb,var(--term-fg)_15%,transparent)]" />
              <button
                type="button"
                onClick={clearQueue}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[11px] text-[var(--term-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-err)_15%,transparent)] hover:text-[var(--term-err)]"
              >
                <Trash2 size={12} className="shrink-0" />
                <span>clear queue</span>
                <span className="ml-auto text-[10px] text-[var(--term-dim)]">{queue.length}</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
