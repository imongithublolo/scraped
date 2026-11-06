"use client";

/**
 * previews — the Apple-Previews/Quick-Look-style viewer. One window that
 * opens EVERYTHING: images, video, audio, pdf, text/code/markdown from the
 * vfs, plus two streaming modes — youtube (paste a link, watch inline) and
 * music (the ~/Music library + any stream url).
 *
 *   arg = "yt" | "music" | a vfs path ("~/Pictures/x.png")
 *
 * Layout is quick look: slim frosted toolbar (nav arrows, segmented
 * library|youtube|music control, centered title, download right), the
 * media floating on a dimmed stage, and the sibling rail as an OPTIONAL
 * overlay panel toggled from the toolbar. Arrows/keys step through the
 * folder like Quick Look.
 *
 * Streaming rides the invidious pool with health tracking (inv.ts): dead
 * instances are probed out fast, the live count surfaces in the status
 * line, and failures land on honest errors with retry buttons.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  FileAudio,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Headphones,
  ListMusic,
  Loader2,
  Monitor,
  Music2,
  PanelLeft,
  Pause,
  Play,
  Radio,
  Repeat,
  RotateCw,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Video,
  Volume2,
  X,
  Youtube,
} from "lucide-react";
import type { FsNode } from "@/lib/murke/contracts";
import { ensureVfs, getVfs, type VFS } from "@/lib/murke/vfs";
import { formatBytes } from "@/lib/murke/fetch-file";
import {
  artUrl,
  audioChainFrom,
  invResolve,
  invSearch,
  videoChainFrom,
  ytThumb,
  type ChainLink,
  type InvHit,
  type InvMedia,
} from "@/lib/murke/inv";

const BORDER = "border-[color-mix(in_srgb,var(--term-fg)_18%,transparent)]";
const BORDER_FAINT = "border-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]";
const BTN =
  "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center border border-transparent text-[var(--term-fg)] transition-colors hover:border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] disabled:pointer-events-none disabled:opacity-25";

/* previewable extensions — generous on purpose (task: "open more files") */
const IMG_RE = /\.(png|apng|jpe?g|jfif|pjpeg|gif|webp|svg|bmp|ico|avif)$/i;
const AUDIO_RE = /\.(mp3|wav|ogg|oga|opus|m4a|m4b|flac|aac|aif|aiff|mka|webm)$/i;
const VIDEO_RE = /\.(mp4|webm|mkv|mov|m4v|ogv|3gp)$/i;
const PDF_RE = /\.pdf$/i;
const MD_RE = /\.(md|mdx|markdown)$/i;
const CODE_RE = /\.(js|mjs|cjs|jsx|ts|tsx|py|c|cpp|h|rs|go|java|kt|swift|dart|zig|scala|ex|exs|erl|hs|jl|r|sh|rb|php|lua|sql|json|ya?ml|toml|xml|html?|css|scss|vue|svelte|astro|graphql|gql|prisma|gradle|cmake|patch|diff|ps1|bat|cmd|conf|ini|env)$/i;
const TEXT_RE = /\.(txt|text|log|csv|tsv|list|nfo|license|readme|cfg|properties|rst)$/i;

/** floating-media styling — the quick look look */
const FLOAT_SHADOW = "0 18px 48px -12px rgba(0, 0, 0, 0.45), 0 4px 14px -6px rgba(0, 0, 0, 0.3)";
const MEDIA_RING = "1px solid color-mix(in srgb, var(--term-fg) 12%, transparent)";

type Mode = "file" | "yt" | "music";

function kindOf(name: string): "image" | "audio" | "video" | "pdf" | "md" | "code" | "text" | "bin" {
  if (IMG_RE.test(name)) return "image";
  if (AUDIO_RE.test(name)) return "audio";
  if (VIDEO_RE.test(name)) return "video";
  if (PDF_RE.test(name)) return "pdf";
  if (MD_RE.test(name)) return "md";
  if (CODE_RE.test(name)) return "code";
  if (TEXT_RE.test(name)) return "text";
  return "bin";
}

const KIND_ICON: Record<string, typeof File> = {
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  pdf: FileText,
  md: FileText,
  code: FileCode2,
  text: FileText,
  bin: File,
};

function kindLabel(k: string): string {
  return { image: "image", audio: "audio", video: "video", pdf: "pdf document", md: "markdown", code: "source code", text: "plain text", bin: "file" }[k] ?? "file";
}

/** youtube id out of any common url shape (watch, youtu.be, shorts, embed) */
function ytId(raw: string): string | null {
  const s = raw.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get("v");
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/\/(shorts|embed|live)\/([\w-]{11})/);
    if (m) return m[2];
  } catch {
    /* not a url */
  }
  return null;
}

function fmtDur(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "live";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

const YT_HIST_KEY = "daemon.previews.yt.v2";
const MUS_VOL_KEY = "daemon.previews.vol";

interface HistEntry {
  id: string;
  title: string;
  author: string;
}

function pushYtHist(e: HistEntry): HistEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(YT_HIST_KEY) ?? "[]") as HistEntry[];
    const next = [e, ...raw.filter((x) => x && x.id !== e.id)].slice(0, 12);
    localStorage.setItem(YT_HIST_KEY, JSON.stringify(next));
    return next;
  } catch {
    return [e];
  }
}
function loadYtHist(): HistEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(YT_HIST_KEY) ?? "[]") as HistEntry[];
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === "string").slice(0, 12) : [];
  } catch {
    return [];
  }
}

/** always loads: i.ytimg thumbs ride the same-origin artwork pipe */
function thumbUrl(videoId: string): string {
  return artUrl(ytThumb(videoId, "mq"));
}

/** walk the vfs for audio files (music library) — shallow-ish, capped */
function collectMusic(vfs: VFS): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = [];
  const walk = (dir: string, depth: number) => {
    if (out.length > 500 || depth > 4) return;
    for (const node of vfs.list(dir)) {
      const p = `${dir}/${node.name}`;
      if (node.type === "dir") walk(p, depth + 1);
      else if (AUDIO_RE.test(node.name)) out.push({ path: p, name: node.name });
    }
  };
  walk(vfs.HOME, 0);
  return out;
}

export default function PreviewApp({ arg }: { arg?: string }) {
  const [tick, setTick] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(() => (arg === "yt" || arg === "music" ? arg : "file"));
  const [path, setPath] = useState<string | null>(() => (arg && arg !== "yt" && arg !== "music" ? getVfs().resolve(arg) : null));

  /* react to relaunch-with-arg (openApp forwards new args to a live window)
     — the state-adjust-during-render pattern, not an effect */
  const [lastArg, setLastArg] = useState(arg);
  if (lastArg !== arg) {
    setLastArg(arg);
    if (arg === "yt" || arg === "music") {
      setMode(arg);
    } else if (arg) {
      const abs = getVfs().resolve(arg);
      const node = getVfs().getNode(abs);
      if (node && node.type === "file") {
        setMode("file");
        setPath(abs);
      }
    }
  }

  useEffect(() => {
    let alive = true;
    void ensureVfs().then(() => alive && setTick((t) => t + 1));
    return () => {
      alive = false;
    };
  }, []);

  const vfs = getVfs();
  const node = useMemo(() => {
    void tick;
    return path ? vfs.getNode(path) : null;
  }, [path, vfs, tick]);

  const file = node && node.type === "file" ? node : null;
  const kind = file ? kindOf(file.name) : null;

  /* siblings for the rail — same folder, previewable first */
  const siblings = useMemo(() => {
    void tick;
    if (!path) return [];
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const dirNode = vfs.getNode(dir);
    if (!dirNode || dirNode.type !== "dir") return [];
    return Object.values(dirNode.children).filter((n) => n.type === "file");
  }, [path, vfs, tick]);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!path) return;
      const idx = siblings.findIndex((n) => `${path.slice(0, path.lastIndexOf("/"))}/${n.name}` === path);
      if (idx === -1) return;
      const next = siblings[(idx + dir + siblings.length) % siblings.length];
      if (next) setPath(`${path.slice(0, path.lastIndexOf("/"))}/${next.name}`);
    },
    [path, siblings],
  );

  /* keyboard: arrows step through the folder */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== "file" || !path) return;
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, path, step]);

  const download = useCallback(async () => {
    if (!path || !file) return;
    const blob = (await vfs.readFileBlob(path)) ?? new Blob([file.content], { type: file.mime ?? "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, [path, file, vfs]);

  const title = mode === "file" ? (file?.name ?? "previews") : mode === "yt" ? "youtube" : "music";

  const segments: Array<{ id: Mode; label: string; icon: typeof Folder }> = [
    { id: "file", label: "library", icon: Folder },
    { id: "yt", label: "youtube", icon: Youtube },
    { id: "music", label: "music", icon: Music2 },
  ];

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden bg-[var(--glass-bg,var(--term-bg))] text-[12.5px] text-[var(--term-fg)]"
      style={{ fontFamily: "var(--chrome-font)" }}
    >
      {/* toolbar — slim + frosted, quick look style: arrows · segmented · title · actions */}
      <header
        className={`relative z-30 flex h-10 shrink-0 items-center gap-1 border-b px-2 ${BORDER_FAINT}`}
        style={{
          background: "color-mix(in srgb, var(--term-bg) 78%, transparent)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
        }}
      >
        {mode === "file" && (
          <span className="flex shrink-0 items-center gap-0.5 pr-1">
            <button type="button" className={BTN} onClick={() => step(-1)} disabled={siblings.length <= 1} aria-label="previous file" title="previous (←)">
              <ChevronLeft size={15} />
            </button>
            <button type="button" className={BTN} onClick={() => step(1)} disabled={siblings.length <= 1} aria-label="next file" title="next (→)">
              <ChevronRight size={15} />
            </button>
          </span>
        )}

        {/* segmented control — library | youtube | music */}
        <div
          className="flex shrink-0 items-center gap-0.5 rounded-full p-0.5"
          style={{ background: "color-mix(in srgb, var(--term-fg) 8%, transparent)" }}
          role="tablist"
          aria-label="previews mode"
        >
          {segments.map((s) => {
            const on = mode === s.id;
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setMode(s.id)}
                className={`flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                  on ? "text-[var(--term-fg)]" : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"
                }`}
                style={on ? { background: "var(--term-bg)", boxShadow: "0 1px 4px rgba(0, 0, 0, 0.22)" } : undefined}
              >
                <Icon size={12} aria-hidden="true" />
                <span className={on ? "" : "hidden sm:inline"}>{s.label}</span>
              </button>
            );
          })}
        </div>

        {/* optional side panel — the quick look rail lives here now */}
        <button
          type="button"
          className={BTN}
          onClick={() => setPanelOpen((v) => !v)}
          aria-pressed={panelOpen}
          title={panelOpen ? "hide the side panel" : "show the side panel"}
          aria-label="toggle side panel"
        >
          <PanelLeft size={14} />
        </button>

        {/* centered title — the open file, or the mode */}
        <div className="min-w-0 flex-1 px-2 text-center">
          <span className="inline-block max-w-full truncate align-middle text-[11.5px] text-[var(--term-dim)]" title={title}>
            {title}
          </span>
        </div>

        <span className="flex shrink-0 items-center gap-1.5">
          {mode === "file" && file && (
            <>
              <span className="hidden shrink-0 text-[10px] text-[var(--term-dim)] md:block">
                {kindLabel(kind ?? "bin")} · {formatBytes(file.size ?? file.content.length)}
              </span>
              <button type="button" className={BTN} onClick={() => void download()} title="save to your downloads" aria-label="download file">
                <Download size={14} />
              </button>
            </>
          )}
        </span>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {/* optional overlay panel — the quick look rail (siblings / mode hints) */}
        {panelOpen && (
          <aside
            className="absolute inset-y-0 left-0 z-20 flex w-60 shrink-0 flex-col overflow-y-auto border-r backdrop-blur-xl"
            style={{
              background: "color-mix(in srgb, var(--term-bg) 82%, transparent)",
              borderColor: "color-mix(in srgb, var(--term-fg) 10%, transparent)",
            }}
            aria-label="previews rail"
          >
            <div
              className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b px-2.5 py-1 backdrop-blur-xl"
              style={{
                background: "color-mix(in srgb, var(--term-bg) 85%, transparent)",
                borderColor: "color-mix(in srgb, var(--term-fg) 10%, transparent)",
              }}
            >
              <span className="truncate text-[10px] text-[var(--term-dim)]">
                {mode === "file"
                  ? siblings.length
                    ? `this folder · ${siblings.length}`
                    : "this folder"
                  : mode === "yt"
                    ? "about youtube"
                    : "about music"}
              </span>
              <button type="button" className={BTN} onClick={() => setPanelOpen(false)} aria-label="close panel" title="close">
                <X size={13} />
              </button>
            </div>
            {mode === "file" ? (
              siblings.length ? (
                siblings.map((n) => {
                  const p = `${path?.slice(0, path.lastIndexOf("/")) ?? ""}/${n.name}`;
                  const Icon = KIND_ICON[kindOf(n.name)];
                  const on = p === path;
                  return (
                    <button
                      key={n.name}
                      type="button"
                      onClick={() => setPath(p)}
                      className={`flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] transition-colors ${
                        on ? "bg-[color-mix(in_srgb,var(--term-brand)_16%,transparent)] text-[var(--term-fg)]" : "text-[var(--term-dim)] hover:bg-[color-mix(in_srgb,var(--term-fg)_7%,transparent)] hover:text-[var(--term-fg)]"
                      }`}
                    >
                      <Icon size={13} strokeWidth={1.7} className={on ? "shrink-0 text-[var(--term-brand)]" : "shrink-0 opacity-60"} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{n.name}</span>
                    </button>
                  );
                })
              ) : (
                <p className="px-3 py-3 text-[11px] leading-relaxed text-[var(--term-dim)]">
                  open something from <span className="text-[var(--term-fg)]">library</span> — double-click any file and it lands here.
                </p>
              )
            ) : (
              <p className="px-3 py-3 text-[11px] leading-relaxed text-[var(--term-dim)]">
                {mode === "yt"
                  ? "search youtube or paste a link — powered by ytp, our own yt-dlp engine. the bytes stream from this server, no instances, no embeds."
                  : "search youtube for music — powered by ytp, our own yt-dlp engine. full tracks, no previews. local files below."}
              </p>
            )}
          </aside>
        )}

        {/* stage */}
        <div className="relative min-w-0 flex-1 overflow-hidden">
          {mode === "file" && <FileStage key={path ?? "none"} file={file} kind={kind} path={path} />}
          {mode === "yt" && <YoutubeStage />}
          {mode === "music" && <MusicStage />}
        </div>
      </div>
    </div>
  );
}

/* ================= file stage ================= */

function FileStage({
  file,
  kind,
  path,
}: {
  file: Extract<FsNode, { type: "file" }> | null;
  kind: "image" | "audio" | "video" | "pdf" | "md" | "code" | "text" | "bin" | null;
  path: string | null;
}) {
  const vfs = getVfs();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  /* text content is already in memory for text nodes — blob-backed text
     (uploads) loads through the effect below. remount (key=path) resets. */
  const [text, setText] = useState<string | null>(() =>
    file && (kind === "text" || kind === "code" || kind === "md") ? file.content || "" : null,
  );
  const [err, setErr] = useState<string | null>(null);

  /* load binary payloads (and blob-backed text) — every setState lands after
     an await, and the keyed remount above means we start clean */
  useEffect(() => {
    let dead = false;
    let made: string | null = null;
    if (!file || !path || !kind) return;
    void (async () => {
      try {
        if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf") {
          const blob = await vfs.readFileBlob(path);
          if (dead) return;
          if (!blob) {
            setErr("no binary payload stored for this file");
            return;
          }
          made = URL.createObjectURL(blob);
          setBlobUrl(made);
        } else if (kind === "text" || kind === "code" || kind === "md") {
          if ((file.content ?? "").length > 0) return; // already have it
          if ((file.size ?? 0) > 1_000_000) {
            setErr("file too large to preview — download it instead");
            return;
          }
          const blob = await vfs.readFileBlob(path);
          if (dead) return;
          if (blob) {
            if (blob.size > 1_000_000) {
              setErr("file too large to preview — download it instead");
              return;
            }
            setText(await blob.text());
          }
        }
      } catch {
        if (!dead) setErr("could not open this file");
      }
    })();
    return () => {
      dead = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [file, path, kind, vfs]);

  if (!file || !kind || !path) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <Folder size={46} strokeWidth={1} className="text-[var(--term-dim)] opacity-40" aria-hidden="true" />
        <p className="text-[var(--term-dim)]">nothing open</p>
        <p className="text-[10.5px] text-[var(--term-dim)] opacity-70">double-click a file in the files app — or drop straight onto it</p>
      </div>
    );
  }

  if (err) {
    return (
      <Center>
        <File size={40} strokeWidth={1} className="text-[var(--term-dim)] opacity-50" aria-hidden="true" />
        <p className="text-[var(--term-err)]">{err}</p>
        <p className="truncate text-[10.5px] text-[var(--term-dim)]">{file.name}</p>
      </Center>
    );
  }

  switch (kind) {
    case "image":
      return (
        <Stage>
          {blobUrl ? (
            <img
              src={blobUrl}
              alt={file.name}
              className="max-h-full max-w-full rounded-xl object-contain"
              style={{ boxShadow: FLOAT_SHADOW, outline: MEDIA_RING }}
              draggable={false}
            />
          ) : (
            <Loader2 size={22} className="animate-spin text-[var(--term-dim)]" aria-hidden="true" />
          )}
        </Stage>
      );
    case "video":
      return (
        <Stage>
          {blobUrl ? (
            <video
              src={blobUrl}
              controls
              autoPlay
              className="max-h-full max-w-full rounded-xl"
              style={{ boxShadow: FLOAT_SHADOW, outline: MEDIA_RING }}
            />
          ) : (
            <Loader2 size={22} className="animate-spin text-[var(--term-dim)]" aria-hidden="true" />
          )}
        </Stage>
      );
    case "audio":
      return (
        <Stage>
          <div className="flex w-full max-w-md flex-col items-center gap-5">
            <div
              className="flex h-36 w-36 items-center justify-center rounded-3xl"
              style={{
                background: "color-mix(in srgb, var(--term-brand) 14%, transparent)",
                outline: "1px solid color-mix(in srgb, var(--term-brand) 40%, transparent)",
                boxShadow: FLOAT_SHADOW,
              }}
            >
              <FileAudio size={58} strokeWidth={1.2} className="text-[var(--term-brand)]" aria-hidden="true" />
            </div>
            <p className="max-w-full truncate text-[12.5px]">{file.name}</p>
            {blobUrl && <audio src={blobUrl} controls autoPlay className="w-full" />}
          </div>
        </Stage>
      );
    case "pdf":
      return (
        <Stage>
          {blobUrl ? (
            <div className="h-full w-full overflow-hidden rounded-xl" style={{ boxShadow: FLOAT_SHADOW, outline: MEDIA_RING }}>
              <iframe src={blobUrl} title={file.name} className="h-full w-full border-0 bg-white" />
            </div>
          ) : (
            <Loader2 size={22} className="animate-spin text-[var(--term-dim)]" aria-hidden="true" />
          )}
        </Stage>
      );
    case "md":
    case "code":
    case "text":
      return (
        <Stage>
          {/* the document page — a floating card like preview.app */}
          <div
            className="flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-xl"
            style={{ background: "var(--term-bg)", boxShadow: FLOAT_SHADOW, outline: MEDIA_RING }}
          >
            <pre
              className={`min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-5 text-[12px] leading-relaxed sm:p-7 ${
                kind === "code" ? "" : "font-mono"
              }`}
            >
              {text ?? ""}
            </pre>
          </div>
        </Stage>
      );
    default:
      return (
        <Center>
          <File size={40} strokeWidth={1} className="text-[var(--term-dim)] opacity-50" aria-hidden="true" />
          <p className="text-[var(--term-dim)]">no inline view for this type</p>
          <p className="max-w-[80%] truncate text-[10.5px] text-[var(--term-dim)] opacity-70">{file.name}</p>
        </Center>
      );
  }
}

const Stage = ({ children }: { children: React.ReactNode }) => (
  <div
    className="relative flex h-full w-full items-center justify-center overflow-hidden p-4 sm:p-8"
    style={{ background: "color-mix(in srgb, var(--term-fg) 3%, transparent)" }}
  >
    {children}
  </div>
);

const Center = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full flex-col items-center justify-center gap-2.5 text-center">{children}</div>
);

/* ============ youtube — invidious end to end, zero embeds ============ */

interface YtActive {
  media: InvMedia;
  title: string;
  author: string;
}

function YoutubeStage() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [results, setResults] = useState<InvHit[] | null>(null);
  const [hist, setHist] = useState<HistEntry[]>(() => loadYtHist());
  const [active, setActive] = useState<YtActive | null>(null);
  /** what failed last, so the retry button can replay it honestly */
  const [failed, setFailed] = useState<
    | { kind: "search"; q: string }
    | { kind: "open"; id: string; meta?: { title?: string; author?: string } }
    | null
  >(null);

  const search = useCallback(async (q: string) => {
    setErr("");
    setActive(null);
    setFailed(null);
    setBusy(true);
    setNote(`searching “${q}”…`);
    const hits = await invSearch(q, setNote);
    setBusy(false);
    setNote("");
    if (!hits) {
      setFailed({ kind: "search", q });
      setErr(`nothing could search “${q}” — the native engine refused and the fallback pool is walled too`);
      return;
    }
    setResults(hits);
  }, []);

  const openId = useCallback(async (id: string, meta?: { title?: string; author?: string }) => {
    setErr("");
    setFailed(null);
    setBusy(true);
    setNote("resolving streams…");
    setResults(null);
    const media = await invResolve(id, setNote);
    setBusy(false);
    setNote("");
    if (!media) {
      setFailed({ kind: "open", id, meta });
      setErr("the native yt-dlp engine refused this one and every fallback instance is walled too");
      return;
    }
    const title = meta?.title || media.title;
    const author = meta?.author || media.author;
    setActive({ media, title, author });
    setHist(pushYtHist({ id, title, author }));
  }, []);

  const retry = () => {
    if (busy || !failed) return;
    const f = failed;
    setFailed(null);
    if (f.kind === "search") void search(f.q);
    else void openId(f.id, f.meta);
  };

  const submit = () => {
    const q = input.trim();
    if (!q || busy) return;
    const id = ytId(q);
    if (id) void openId(id);
    else void search(q);
  };

  return (
    <div className="flex h-full flex-col">
      {/* omnibox — a search query or any youtube url shape */}
      <form
        className={`flex shrink-0 items-center gap-2 border-b px-3 py-2 ${BORDER_FAINT}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Youtube size={15} className="shrink-0 text-[var(--term-brand)]" aria-hidden="true" />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="search youtube — or paste a watch / youtu.be / shorts link"
          aria-label="youtube search or url"
          className="min-w-0 flex-1 rounded-full bg-[color-mix(in_srgb,var(--term-fg)_6%,transparent)] px-3.5 py-1.5 text-[12px] outline-none transition-colors placeholder:text-[var(--term-dim)] focus:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]"
        />
        <button
          type="submit"
          disabled={busy}
          className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-105 disabled:pointer-events-none disabled:opacity-40"
          style={{ background: "var(--term-brand)", color: "var(--term-bg)" }}
          aria-label={busy ? "working…" : "go"}
        >
          {busy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Search size={12} aria-hidden="true" />}
        </button>
      </form>

      {note && (
        <p className="flex shrink-0 items-center gap-2 px-3 py-1.5 text-[11px] text-[var(--term-dim)]">
          <Loader2 size={11} className="animate-spin" aria-hidden="true" /> {note}
        </p>
      )}
      {err && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-1.5">
          <p className="min-w-0 flex-1 text-[11px] text-[var(--term-err)]">{err}</p>
          {failed && !busy && (
            <button
              type="button"
              onClick={retry}
              className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] ${BORDER}`}
            >
              <RotateCw size={11} aria-hidden="true" /> retry
            </button>
          )}
        </div>
      )}

      {active ? (
        <YtPlayer key={active.media.videoId} active={active} onClose={() => setActive(null)} />
      ) : results && results.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {results.map((hit) => (
              <button
                key={hit.videoId}
                type="button"
                onClick={() => void openId(hit.videoId, { title: hit.title, author: hit.author })}
                className={`flex cursor-pointer flex-col overflow-hidden rounded-xl border text-left transition-all hover:-translate-y-px hover:shadow-lg ${BORDER} hover:bg-[color-mix(in_srgb,var(--term-fg)_6%,transparent)]`}
              >
                <span className="relative block aspect-video w-full shrink-0 overflow-hidden bg-[color-mix(in_srgb,var(--term-fg)_6%,transparent)]">
                  <img
                    src={thumbUrl(hit.videoId)}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                  {hit.live ? (
                    <span className="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-[color-mix(in_srgb,var(--term-err)_85%,transparent)] px-1.5 py-0.5 text-[9px] font-bold text-white">
                      <Radio size={9} aria-hidden="true" /> live
                    </span>
                  ) : hit.lengthSec > 0 ? (
                    <span className="absolute bottom-1 right-1 rounded bg-[color-mix(in_srgb,var(--term-bg)_82%,transparent)] px-1.5 py-0.5 text-[9px] tabular-nums">
                      {fmtDur(hit.lengthSec)}
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0 px-2 py-1.5">
                  <span className="line-clamp-2 block text-[11.5px] leading-snug">{hit.title}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-[var(--term-dim)]">{hit.author}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : results && results.length === 0 ? (
        <Center>
          <Search size={34} strokeWidth={1} className="text-[var(--term-dim)] opacity-40" aria-hidden="true" />
          <p className="text-[var(--term-dim)]">nothing found — try fewer words</p>
        </Center>
      ) : (
        /* idle — recents */
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto p-4 text-center">
          <Video size={40} strokeWidth={1} className="shrink-0 text-[var(--term-dim)] opacity-40" aria-hidden="true" />
          <p className="text-[var(--term-dim)]">search above — or jump back into something you watched</p>
          {hist.length > 0 && (
            <div className="grid w-full max-w-2xl gap-1.5 text-left">
              {hist.slice(0, 6).map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => void openId(h.id, { title: h.title, author: h.author })}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_6%,transparent)]"
                  style={{ borderColor: "color-mix(in srgb, var(--term-fg) 14%, transparent)" }}
                >
                  <img src={thumbUrl(h.id)} alt="" loading="lazy" className="h-8 w-14 shrink-0 rounded object-cover" draggable={false} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px]">{h.title}</span>
                    <span className="block truncate text-[10px] text-[var(--term-dim)]">{h.author}</span>
                  </span>
                  <Play size={12} className="shrink-0 text-[var(--term-dim)]" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * the player. attempts = every playable byte url in order — each muxed
 * quality through the same-origin pipe first, then direct from the
 * instance, then audio-only chains as the last resort. onError walks the
 * list; the quality menu jumps straight to a label; lives ride hls.js.
 */
function YtPlayer({ active, onClose }: { active: YtActive; onClose: () => void }) {
  const { media, title, author } = active;
  const isLive = media.live || Boolean(media.hlsUrl);

  const attempts = useMemo(() => {
    const chain = videoChainFrom(media);
    const videoOnes = chain.filter((f) => !f.quality.includes("no audio"));
    /** absolute urls ride the same-origin pipe; relative urls (native
     *  yt-dlp engine) are already ours — wrap only what needs it */
    const wrap = (u: string) => (/^https?:\/\//i.test(u) ? `/api/stream?u=${encodeURIComponent(u)}` : u);
    const out: { label: string; url: string; audio: boolean }[] = [];
    for (const f of videoOnes) {
      out.push({ label: f.quality, url: wrap(f.url), audio: false });
    }
    for (const f of videoOnes) {
      out.push({ label: f.quality, url: f.url, audio: false });
    }
    for (const f of media.audio) {
      out.push({ label: "audio only", url: wrap(f.url), audio: true });
      out.push({ label: "audio only", url: f.url, audio: true });
    }
    return out;
  }, [media]);

  const [sel, setSel] = useState(0);
  const [fatal, setFatal] = useState(false);

  /** unique video quality labels → first attempt index carrying them */
  const qualityMenu = useMemo(() => {
    const seen = new Map<string, number>();
    attempts.forEach((a, i) => {
      if (!a.audio && !seen.has(a.label)) seen.set(a.label, i);
    });
    return [...seen.entries()];
  }, [attempts]);

  const onFatal = useCallback(() => setFatal(true), []);
  const current = attempts[Math.min(sel, Math.max(0, attempts.length - 1))];
  const isAudioOnly = current?.audio ?? false;

  if (!isLive && attempts.length === 0) {
    return (
      <Center>
        <Video size={36} strokeWidth={1} className="text-[var(--term-dim)] opacity-50" aria-hidden="true" />
        <p className="text-[var(--term-dim)]">no playable stream — the instance pool came up empty</p>
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded-md border px-3 py-1 text-[11px]"
          style={{ borderColor: "color-mix(in srgb, var(--term-fg) 25%, transparent)" }}
        >
          back
        </button>
      </Center>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* context strip — frosted */}
      <div
        className={`flex shrink-0 items-center gap-2 border-b px-2 py-1.5 ${BORDER_FAINT}`}
        style={{
          background: "color-mix(in srgb, var(--term-bg) 75%, transparent)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
        }}
      >
        <button type="button" className={BTN} onClick={onClose} aria-label="back" title="back">
          <ChevronLeft size={14} />
        </button>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11.5px]">{title}</span>
          <span className="block truncate text-[10px] text-[var(--term-dim)]">
            {author}
            {isLive ? " · live" : current ? ` · ${isAudioOnly ? "audio only" : current.label}` : ""}
          </span>
        </span>
        {isLive && (
          <span
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold text-white"
            style={{ background: "color-mix(in srgb, var(--term-err) 80%, transparent)" }}
          >
            <Radio size={9} aria-hidden="true" /> live
          </span>
        )}
        {!isLive && attempts.some((a) => a.audio) && (
          <button
            type="button"
            className={BTN}
            aria-pressed={isAudioOnly}
            title={isAudioOnly ? "switch to video" : "audio only"}
            onClick={() => {
              const target = isAudioOnly
                ? attempts.findIndex((a) => !a.audio)
                : attempts.findIndex((a) => a.audio);
              if (target >= 0) setSel(target);
            }}
          >
            {isAudioOnly ? <Monitor size={14} /> : <Headphones size={14} />}
          </button>
        )}
        {!isLive && qualityMenu.length > 1 && !isAudioOnly && (
          <select
            value={current && !current.audio ? current.label : qualityMenu[0][0]}
            onChange={(e) => {
              const i = attempts.findIndex((a) => a.label === e.target.value);
              if (i >= 0) setSel(i);
            }}
            aria-label="quality"
            className="h-7 shrink-0 cursor-pointer rounded-md border bg-transparent px-1.5 text-[10.5px] outline-none"
            style={{ borderColor: "color-mix(in srgb, var(--term-fg) 20%, transparent)", color: "var(--term-fg)", background: "var(--term-bg)" }}
          >
            {qualityMenu.map(([label]) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* stage — a floating rounded frame on a dimmed backdrop */}
      <div className="min-h-0 flex-1 p-3 sm:p-5" style={{ background: "color-mix(in srgb, var(--term-fg) 4%, transparent)" }}>
        <div
          className="relative mx-auto h-full w-full max-w-5xl overflow-hidden rounded-xl bg-black"
          style={{ boxShadow: FLOAT_SHADOW, outline: MEDIA_RING }}
        >
          {isLive && media.hlsUrl ? (
            <LiveHls
              url={media.hlsUrl}
              pipedUrl={`/api/stream?u=${encodeURIComponent(media.hlsUrl)}`}
              onFatal={onFatal}
            />
          ) : current ? (
            <video
              key={sel}
              src={current.url}
              controls
              autoPlay
              playsInline
              className="absolute inset-0 h-full w-full"
              onError={() => {
                if (sel < attempts.length - 1) setSel(sel + 1);
                else setFatal(true);
              }}
            />
          ) : null}
          {fatal && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center"
              style={{ background: "color-mix(in srgb, var(--term-bg) 94%, transparent)" }}
            >
              <Video size={34} strokeWidth={1} className="text-[var(--term-dim)] opacity-50" aria-hidden="true" />
              <p className="text-[var(--term-err)]">every source gave up on this one</p>
              <p className="text-[10.5px] text-[var(--term-dim)]">the engine is rate-limited or walled — give it a moment and retry</p>
              <button
                type="button"
                className="mt-1 flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1 text-[11px] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)]"
                style={{ borderColor: "color-mix(in srgb, var(--term-fg) 25%, transparent)" }}
                onClick={() => {
                  setFatal(false);
                  setSel(0);
                }}
              >
                <RotateCw size={11} aria-hidden="true" /> retry
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * hls.js transport for live streams — <video src> can't touch an m3u8.
 * Direct manifest first (instances ship CORS-*); on a fatal network error
 * reroute through the same-origin pipe once, then give up honestly.
 */
function LiveHls({ url, pipedUrl, onFatal }: { url: string; pipedUrl: string; onFatal: () => void }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [viaPipe, setViaPipe] = useState(false);

  useEffect(() => {
    let disposed = false;
    let inst: { destroy: () => void } | null = null;
    const el = ref.current;
    if (!el) return;
    void (async () => {
      const mod = await import("hls.js");
      const Hls = mod.default;
      if (disposed) return;
      if (!Hls.isSupported()) {
        el.src = url; // safari plays hls natively
        return;
      }
      const hls = new Hls({ liveDurationInfinity: true, backBufferLength: 90 });
      inst = hls;
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        hls.destroy();
        inst = null;
        if (!viaPipe) setViaPipe(true);
        else onFatal();
      });
      hls.attachMedia(el);
      hls.loadSource(viaPipe ? pipedUrl : url);
    })();
    return () => {
      disposed = true;
      inst?.destroy();
    };
  }, [url, pipedUrl, viaPipe, onFatal]);

  return <video ref={ref} controls autoPlay playsInline className="absolute inset-0 h-full w-full" />;
}

/* ============ music — invidious search + local library ============ */

type Track = { kind: "inv"; hit: InvHit } | { kind: "local"; path: string; name: string };

function MusicStage() {
  const vfs = getVfs();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [tickL, setTickL] = useState(0);
  useEffect(() => {
    void ensureVfs().then(() => setTickL((t) => t + 1));
  }, []);

  const library = useMemo(() => collectMusic(vfs), [vfs, tickL]);
  const localTracks: Track[] = useMemo(
    () => library.map((t) => ({ kind: "local" as const, path: t.path, name: t.name })),
    [library],
  );

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InvHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState("");
  const [failedSearch, setFailedSearch] = useState<string | null>(null);
  const [failedTrack, setFailedTrack] = useState<number | null>(null);
  const invTracks: Track[] = useMemo(
    () => (results ?? []).map((hit) => ({ kind: "inv" as const, hit })),
    [results],
  );
  const queue = useMemo(() => [...invTracks, ...localTracks], [invTracks, localTracks]);
  const queueRef = useRef<Track[]>(queue);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState<number>(() => {
    const v = Number(localStorage.getItem(MUS_VOL_KEY));
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.85;
  });
  const [shuffle, setShuffle] = useState(false);
  const [loop, setLoop] = useState(false);

  /* current source: resolved invidious formats, or a local blob url */
  const [media, setMedia] = useState<InvMedia | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [linkIdx, setLinkIdx] = useState(0);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const localUrlRef = useRef<string | null>(null);
  const loadTicket = useRef(0);

  useEffect(() => {
    return () => {
      if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
    };
  }, []);

  const links: ChainLink[] = useMemo(() => {
    if (media) return audioChainFrom(media);
    if (localUrl) return [{ url: localUrl }];
    return [];
  }, [media, localUrl]);

  const current = idx >= 0 && idx < queue.length ? queue[idx] : null;
  const nowTitle = current ? (current.kind === "inv" ? current.hit.title : current.name) : "nothing playing";
  const nowSub = current ? (current.kind === "inv" ? current.hit.author : vfs.pretty(current.path)) : "";
  const nowThumb = current && current.kind === "inv" ? thumbUrl(current.hit.videoId) : null;

  /** select + load a queue row (list overrides the live queue for fresh searches) */
  const playAt = useCallback(async (i: number, list?: Track[]) => {
    const q = list ?? queueRef.current;
    const it = q[i];
    if (!it) return;
    const ticket = ++loadTicket.current;
    setIdx(i);
    setErr("");
    setPos(0);
    setDur(0);
    setLinkIdx(0);
    setPlaying(true);
    if (it.kind === "local") {
      setMedia(null);
      setNote("");
      const blob = await vfs.readFileBlob(it.path);
      if (ticket !== loadTicket.current) return;
      if (!blob) {
        setFailedTrack(null);
        setErr("could not read this file");
        setPlaying(false);
        return;
      }
      setFailedTrack(null);
      if (localUrlRef.current) URL.revokeObjectURL(localUrlRef.current);
      const url = URL.createObjectURL(blob);
      localUrlRef.current = url;
      setLocalUrl(url);
    } else {
      setLocalUrl(null);
      setMedia(null);
      setNote(`resolving “${it.hit.title}”…`);
      const m = await invResolve(it.hit.videoId, setNote);
      if (ticket !== loadTicket.current) return;
      setNote("");
      if (!m) {
        setFailedTrack(i);
        setErr("couldn't resolve this one — instances down and the native engine refused too");
        setPlaying(false);
        return;
      }
      setFailedTrack(null);
      setMedia(m);
    }
  }, [vfs]);

  const runSearch = async (q: string) => {
    if (!q || searching) return;
    setSearchErr("");
    setFailedSearch(null);
    setSearching(true);
    const hits = await invSearch(q, setNote);
    setSearching(false);
    setNote("");
    if (!hits) {
      setFailedSearch(q);
      setSearchErr("search failed everywhere — the native engine refused and the fallback pool is walled too");
      return;
    }
    setResults(hits);
    if (hits.length > 0) {
      void playAt(0, hits.map((hit) => ({ kind: "inv" as const, hit })));
    }
  };

  const stepTrack = useCallback(
    (d: 1 | -1) => {
      if (queue.length === 0) return;
      if (shuffle && queue.length > 1) {
        let n = idx;
        while (n === idx) n = Math.floor(Math.random() * queue.length);
        void playAt(n);
        return;
      }
      void playAt((idx + d + queue.length) % queue.length);
    },
    [queue.length, idx, shuffle, playAt],
  );

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  }, []);

  /* src assignment + play/pause mirror — one effect, no split-brain */
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (links.length === 0) return;
    const u = links[Math.min(linkIdx, links.length - 1)].url;
    if (el.src !== new URL(u, location.href).href) {
      el.src = u;
      el.load();
    }
    if (playing) void el.play().catch(() => undefined);
  }, [links, linkIdx, playing]);

  useEffect(() => {
    const el = audioRef.current;
    if (el) el.volume = vol;
    localStorage.setItem(MUS_VOL_KEY, String(vol));
  }, [vol]);

  const onAudioError = useCallback(() => {
    if (linkIdx < links.length - 1) {
      setLinkIdx((i) => i + 1);
      return;
    }
    setErr("playback failed — every source gave up");
    setPlaying(false);
  }, [linkIdx, links.length]);

  const fmtTime = (s: number) => (Number.isFinite(s) && s > 0 ? fmtDur(s) : "0:00");

  const row = (t: Track, i: number) => {
    const on = i === idx;
    const isInv = t.kind === "inv";
    return (
      <button
        key={isInv ? `inv-${t.hit.videoId}` : `local-${t.path}`}
        type="button"
        onClick={() => (on ? toggle() : void playAt(i))}
        className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
          on ? "bg-[color-mix(in_srgb,var(--term-brand)_14%,transparent)] text-[var(--term-fg)]" : "text-[var(--term-dim)] hover:bg-[color-mix(in_srgb,var(--term-fg)_6%,transparent)] hover:text-[var(--term-fg)]"
        }`}
      >
        <span className="flex h-8 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-[color-mix(in_srgb,var(--term-fg)_7%,transparent)]">
          {isInv ? (
            <img src={thumbUrl(t.hit.videoId)} alt="" loading="lazy" className="h-8 w-9 object-cover" draggable={false} />
          ) : (
            <FileAudio size={14} className="opacity-60" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px]">{isInv ? t.hit.title : t.name}</span>
          <span className="block truncate text-[10px] text-[var(--term-dim)]">
            {isInv ? t.hit.author : vfs.pretty(t.path)}
          </span>
        </span>
        <span className="shrink-0 text-[9.5px] tabular-nums opacity-60">
          {isInv && t.hit.lengthSec > 0 ? fmtDur(t.hit.lengthSec) : on && playing ? <Play size={10} aria-hidden="true" /> : ""}
        </span>
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* the hidden element does all the work (library + invidious) */}
      <audio
        ref={audioRef}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDur(e.currentTarget.duration)}
        onEnded={() => stepTrack(1)}
        onError={onAudioError}
        loop={loop}
        className="hidden"
      />

      {/* now playing */}
      <div className={`shrink-0 border-b px-3 py-2.5 ${BORDER_FAINT}`}>
        <div className="flex items-center gap-2.5">
          <button type="button" className={BTN} onClick={() => stepTrack(-1)} disabled={!current} aria-label="previous track">
            <SkipBack size={14} />
          </button>
          <button
            type="button"
            onClick={toggle}
            disabled={!current}
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-105 disabled:pointer-events-none disabled:opacity-25"
            style={{ background: "var(--term-brand)", color: "var(--term-bg)" }}
            aria-label={playing ? "pause" : "play"}
          >
            {playing ? <Pause size={16} /> : <Play size={16} className="translate-x-px" />}
          </button>
          <button type="button" className={BTN} onClick={() => stepTrack(1)} disabled={!current} aria-label="next track">
            <SkipForward size={14} />
          </button>

          {nowThumb && (
            <img src={nowThumb} alt="" className="h-9 w-9 shrink-0 rounded object-cover" draggable={false} />
          )}

          <div className="ml-1 min-w-0 flex-1">
            <p className="truncate text-[12px]">{nowTitle}</p>
            {nowSub && <p className="truncate text-[10px] text-[var(--term-dim)]">{nowSub}</p>}
            <div className="mt-1 flex items-center gap-2">
              <span className="w-9 shrink-0 text-right text-[9.5px] tabular-nums text-[var(--term-dim)]">{fmtTime(pos)}</span>
              <input
                type="range"
                min={0}
                max={dur || 0}
                step={0.1}
                value={Math.min(pos, dur || 0)}
                onChange={(e) => {
                  const el = audioRef.current;
                  if (el) el.currentTime = Number(e.target.value);
                }}
                aria-label="seek"
                className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full outline-none"
                style={{
                  background: `linear-gradient(to right, var(--term-brand) ${dur ? (pos / dur) * 100 : 0}%, color-mix(in srgb, var(--term-fg) 18%, transparent) 0)`,
                }}
              />
              <span className="w-9 shrink-0 text-[9.5px] tabular-nums text-[var(--term-dim)]">{fmtTime(dur)}</span>
            </div>
          </div>

          <button type="button" className={BTN} onClick={() => setShuffle((v) => !v)} aria-pressed={shuffle} title="shuffle" style={shuffle ? { color: "var(--term-brand)" } : undefined}>
            <Shuffle size={13} />
          </button>
          <button type="button" className={BTN} onClick={() => setLoop((v) => !v)} aria-pressed={loop} title="repeat" style={loop ? { color: "var(--term-brand)" } : undefined}>
            <Repeat size={13} />
          </button>
          <span className="hidden items-center gap-1.5 sm:flex">
            <Volume2 size={13} className="text-[var(--term-dim)]" aria-hidden="true" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={vol}
              onChange={(e) => setVol(Number(e.target.value))}
              aria-label="volume"
              className="h-1 w-16 cursor-pointer appearance-none rounded-full outline-none"
              style={{ background: `linear-gradient(to right, var(--term-fg) ${vol * 100}%, color-mix(in srgb, var(--term-fg) 18%, transparent) 0)` }}
            />
          </span>
        </div>
        {note && (
          <p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-[var(--term-dim)]">
            <Loader2 size={10} className="animate-spin" aria-hidden="true" /> {note}
          </p>
        )}
        {err && (
          <div className="mt-1 flex items-center gap-2">
            <p className="min-w-0 flex-1 text-[10.5px] text-[var(--term-err)]">{err}</p>
            {failedTrack !== null && (
              <button
                type="button"
                onClick={() => {
                  const i = failedTrack;
                  setFailedTrack(null);
                  void playAt(i);
                }}
                className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10.5px] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] ${BORDER}`}
              >
                <RotateCw size={10} aria-hidden="true" /> retry
              </button>
            )}
          </div>
        )}
      </div>

      {/* invidious search */}
      <form
        className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 ${BORDER_FAINT}`}
        onSubmit={(e) => {
          e.preventDefault();
          void runSearch(query.trim());
        }}
      >
        <Search size={13} className="shrink-0 text-[var(--term-dim)]" aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search youtube — full tracks via invidious, no previews"
          aria-label="music search"
          className="min-w-0 flex-1 rounded-full bg-[color-mix(in_srgb,var(--term-fg)_6%,transparent)] px-3.5 py-1 text-[11.5px] outline-none transition-colors placeholder:text-[var(--term-dim)] focus:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]"
        />
        <button
          type="submit"
          disabled={searching}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-105 disabled:pointer-events-none disabled:opacity-40"
          style={{ background: "var(--term-brand)", color: "var(--term-bg)" }}
          aria-label={searching ? "searching…" : "search"}
        >
          {searching ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <Search size={11} aria-hidden="true" />}
        </button>
      </form>
      {searchErr && (
        <div className="flex shrink-0 items-center gap-2 px-3 py-1">
          <p className="min-w-0 flex-1 text-[10.5px] text-[var(--term-err)]">{searchErr}</p>
          {failedSearch && !searching && (
            <button
              type="button"
              onClick={() => void runSearch(failedSearch)}
              className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10.5px] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] ${BORDER}`}
            >
              <RotateCw size={10} aria-hidden="true" /> retry
            </button>
          )}
        </div>
      )}

      {/* queue — search results on top, your files below */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {queue.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Music2 size={36} strokeWidth={1} className="text-[var(--term-dim)] opacity-40" aria-hidden="true" />
            <p className="text-[var(--term-dim)]">search a track above — full songs via invidious, no 30s previews</p>
            <p className="text-[10.5px] text-[var(--term-dim)] opacity-70">drop audio files into ~/Music and they show up here too</p>
          </div>
        ) : (
          <>
            {invTracks.length > 0 && (
              <p
                className={`sticky top-0 z-10 mx-0.5 mb-0.5 flex items-center gap-1.5 rounded-md border-b px-2.5 py-1 text-[9.5px] font-bold tracking-wider text-[var(--term-dim)] backdrop-blur-xl ${BORDER_FAINT}`}
                style={{ background: "color-mix(in srgb, var(--term-bg) 85%, transparent)" }}
              >
                <Youtube size={10} aria-hidden="true" /> invidious results
              </p>
            )}
            {invTracks.map((t, i) => row(t, i))}
            {localTracks.length > 0 && (
              <p
                className={`sticky top-0 z-10 mx-0.5 mb-0.5 flex items-center gap-1.5 rounded-md border-b px-2.5 py-1 text-[9.5px] font-bold tracking-wider text-[var(--term-dim)] backdrop-blur-xl ${BORDER_FAINT}`}
                style={{ background: "color-mix(in srgb, var(--term-bg) 85%, transparent)" }}
              >
                <ListMusic size={10} aria-hidden="true" /> your files
              </p>
            )}
            {localTracks.map((t, i) => row(t, invTracks.length + i))}
          </>
        )}
      </div>
    </div>
  );
}
