"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AppWindow,
  Bird,
  Bookmark,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Chrome,
  Copy,
  Download,
  Globe,
  History,
  Home,
  Languages,
  Loader2,
  MoreVertical,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  Star,
  X,
  Youtube,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import type { ProxyEngine, ProxyFrameHandle, WispStatus } from "@/lib/murke/contracts";
import { NEWTAB_URL } from "@/lib/murke/contracts";
import { installPopupCapture } from "@/lib/murke/popup-capture";
import { getVfs } from "@/lib/murke/vfs";
import { fetchIntoVfs, formatBytes, nameFromUrl } from "@/lib/murke/fetch-file";
import type { Bookmark as BookmarkEntry, HistoryEntry, SearchHit } from "@/lib/murke/browser-data";
import { useTitlebarSlot } from "./MacWindow";
import { useGlass } from "./GlassDefs";
import { normalizeTarget } from "@/lib/murke/commands";
import { useOS } from "@/lib/murke/os-store";
import {
  addBookmark,
  addHistory,
  clearHistory,
  isBookmarked,
  loadBookmarks,
  loadHistory,
  loadPrefs,
  loadSession,
  removeBookmark,
  savePrefs,
  saveSession,
  searchAll,
} from "@/lib/murke/browser-data";

/** Cosmetic chrome version shown on the new-tab wordmark. */
const BROWSER_VERSION = "v4.0";

/** Minimal chrome tokens — soft radii, hairlines, quiet glass. */
const BOX_BORDER = "border-[color-mix(in_srgb,var(--term-fg)_16%,transparent)]";
const BORDER_FAINT = "border-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]";
const BOX_BTN =
  "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--term-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)] disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent";
const BOX_POPOVER = `absolute right-0 top-9 z-50 rounded-xl border ${BOX_BORDER} bg-[color-mix(in_srgb,var(--term-bg)_97%,transparent)] font-mono shadow-[0_18px_50px_rgba(0,0,0,0.5)]`;
const ROW_HOVER = "hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)]";

/* The indeterminate loading-bar slide. */
const CHROME_CSS = `
.nb-progress{position:relative;overflow:hidden}
.nb-progress::after{content:"";position:absolute;top:0;bottom:0;left:0;width:34%;background:var(--term-brand);animation:nb-slide 1s linear infinite}
@keyframes nb-slide{from{transform:translateX(-110%)}to{transform:translateX(330%)}}
@media (prefers-reduced-motion:reduce){.nb-progress::after{animation-duration:2.4s}}
`;

/* ---------- pure helpers ---------- */

const PREFIX_RE = /^\/scramjet\//;

/** Decode a scramjet-routed url back to something human readable.
 *  Frames report ABSOLUTE urls (http://thishost/scramjet/<encoded>) once
 *  navigation happens inside the frame — take whatever follows the LAST
 *  /scramjet/ marker and decode it once, so the omnibox shows the real
 *  target url instead of leaking the host origin. */
function displayUrl(u: string): string {
  if (!u) return "";
  if (u === NEWTAB_URL) return "";
  if (u.startsWith("murke://search?")) {
    try {
      const q = new URL(u).searchParams.get("q") ?? "";
      return decodeURIComponent(q.replace(/\+/g, " "));
    } catch {
      return "duckduckgo";
    }
  }
  try {
    const marker = "/scramjet/";
    const idx = u.lastIndexOf(marker);
    const rest = idx >= 0 ? u.slice(idx + marker.length) : u.replace(PREFIX_RE, "");
    return decodeURIComponent(rest);
  } catch {
    return u;
  }
}

function hostFor(u: string): string {
  if (!u) return "";
  if (u.startsWith("murke://search?")) return "duckduckgo.com";
  const shown = displayUrl(u);
  try {
    return new URL(shown).hostname.replace(/^www\./, "");
  } catch {
    return shown.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] || shown;
  }
}

/** Short tab label: hostname of the (decoded) url. */
function tabTitle(u: string): string {
  if (!u || u === NEWTAB_URL) return "new tab";
  if (u.startsWith("murke://search?")) {
    const shown = displayUrl(u);
    return `${shown || "search"} — duckduckgo`;
  }
  const shown = displayUrl(u);
  return hostFor(shown) || shown.slice(0, 24) || "new tab";
}

/** Search terms go to the REAL DuckDuckGo — ddg works through the relay
 *  now, so the default search is plain duckduckgo.com (proxied like any
 *  other site). The native in-app results page stays as the fallback
 *  engine ("anywhere") for when the wall comes back. */
const DDG_SEARCH = "https://duckduckgo.com/?q=";

function searchUrl(q: string): string {
  return "murke://search?q=" + encodeURIComponent(q);
}

/** Omnibox enter logic: a term (spaces / no dot) → duckduckgo.com through
 *  the proxy, anything url-shaped → normalized with an https:// scheme. */
function resolveInput(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (/^murke:/i.test(s)) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  const hasSpace = /\s/.test(s);
  const hostish = /\.[^\s]/.test(s) || /^localhost(:\d+)?([/?#]|$)/i.test(s);
  if (hasSpace || !hostish) return DDG_SEARCH + encodeURIComponent(s);
  return "https://" + s;
}

/** "5m" / "3h" / "2d" / "Jun 4" — relative timestamps for lists. */
function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** window.stop() on a same-origin frame — cancels an in-flight load. */
function stopFrame(handle: ProxyFrameHandle): void {
  try {
    handle.el.contentWindow?.stop();
  } catch {
    /* cross-origin or not ready — the failsafe timer ends the bar anyway */
  }
}

/* ---------- find in page (css custom highlights, non-destructive) ---------- */

const FIND_STYLE_ID = "murke-find-style";

/** drop every murke-find highlight from a frame's document */
function clearFind(handle: ProxyFrameHandle | null): void {
  try {
    const win = handle?.el.contentWindow as (Window & { CSS?: { highlights?: Map<string, unknown> } }) | null | undefined;
    const doc = win?.document;
    if (!win || !doc) return;
    win.CSS?.highlights?.delete("murke-find");
    win.CSS?.highlights?.delete("murke-find-cur");
    doc.getElementById(FIND_STYLE_ID)?.remove();
  } catch {
    /* cross-origin — nothing to clear */
  }
}

/** highlight every occurrence of `q` in the frame; scrolls to `idx`.
 *  returns the match count (0 = none / unavailable). */
function runFind(handle: ProxyFrameHandle | null, q: string, idx: number): number {
  clearFind(handle);
  if (!q) return 0;
  try {
    const win = handle?.el.contentWindow as (Window & { CSS?: { highlights?: Map<string, unknown>; Highlight?: new (r: Range[]) => unknown } }) | null | undefined;
    const doc = win?.document;
    if (!win || !doc || !doc.body) return 0;

    const ranges: Range[] = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n: Node): number {
        const t = n.nodeValue ?? "";
        if (!t.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const ql = q.toLowerCase();
    let node: Node | null;
    while ((node = walker.nextNode()) && ranges.length < 3000) {
      const text = node.nodeValue ?? "";
      const lower = text.toLowerCase();
      let i = lower.indexOf(ql);
      while (i !== -1 && ranges.length < 3000) {
        const r = doc.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + q.length);
        ranges.push(r);
        i = lower.indexOf(ql, i + q.length);
      }
    }
    if (!ranges.length) return 0;

    const highlights = win.CSS?.highlights;
    /* the Highlight constructor is a window global, not CSS.Highlight */
    const HighlightCtor = (win as Window & { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (highlights && HighlightCtor) {
      if (!doc.getElementById(FIND_STYLE_ID)) {
        const st = doc.createElement("style");
        st.id = FIND_STYLE_ID;
        st.textContent =
          "::highlight(murke-find){background-color:#ffe066;color:#111}" +
          "::highlight(murke-find-cur){background-color:#ff9f1a;color:#111}";
        (doc.head ?? doc.documentElement).appendChild(st);
      }
      /* Highlight's constructor is variadic — it must spread */
      highlights.set("murke-find", new HighlightCtor(...ranges) as unknown);
      const cur = ranges[Math.min(idx, ranges.length - 1)];
      if (cur) {
        highlights.set("murke-find-cur", new HighlightCtor(cur) as unknown);
        const rect = cur.getBoundingClientRect();
        win.scrollTo({ top: win.scrollY + rect.top - win.innerHeight / 3, behavior: "smooth" });
      }
      return ranges.length;
    }

    /* ancient fallback: window.find jumps around but can't count */
    const w = win as Window & { find?: (s: string, cs: boolean, back: boolean) => boolean };
    if (w.find) return w.find(q, false, false) ? 1 : 0;
    return 0;
  } catch {
    return 0;
  }
}

/** Pin a proxy frame to the content area. Frames are absolutely stacked and
 *  shown/hidden via display — visibility is binary, never flow-dependent. */
function positionFrame(handle: ProxyFrameHandle): void {
  const s = handle.el.style;
  s.position = "absolute";
  s.inset = "0";
}

/** Key handler injected INTO proxied frames (fresh documents drop listeners,
 *  a sweep re-attaches). In-frame ctrl+t / alt+t / ctrl+w / ctrl+f / zoom keys
 *  are relayed to the chrome via top-window custom events (same-origin frames
 *  may touch top). */
function frameKey(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  let evt: string | null = null;
  if ((e.altKey && k === "t") || (mod && !e.shiftKey && k === "t")) {
    e.preventDefault();
    evt = "murke-browser-newtab";
  } else if (mod && !e.shiftKey && k === "w") {
    e.preventDefault();
    evt = "murke-browser-closetab";
  } else if (mod && !e.shiftKey && k === "f") {
    e.preventDefault();
    evt = "murke-browser-find";
  } else if (mod && (k === "=" || k === "+")) {
    e.preventDefault();
    evt = "murke-browser-zoom-in";
  } else if (mod && k === "-") {
    e.preventDefault();
    evt = "murke-browser-zoom-out";
  } else if (mod && k === "0") {
    e.preventDefault();
    evt = "murke-browser-zoom-reset";
  }
  if (evt) {
    try {
      window.top?.dispatchEvent(new CustomEvent(evt));
    } catch {
      /* ignore */
    }
  }
}

/* ---------- data types ---------- */

/** Tab = pure data. The imperative frames live in a FrameStore so React
 *  state never holds DOM handles. url === "" = the new-tab page. */
interface Tab {
  id: number;
  /** last known url (scramjet-encoded or target) */
  url: string;
  /** what the address bar shows */
  address: string;
  /** per-tab content zoom (0.5..2, 1 = 100%) */
  zoom?: number;
}

/** Holds the live frames outside React state entirely (the hooks compiler
 *  rightly forbids mutating ref-reachable objects; a class instance's
 *  internals are the escape hatch). */
class FrameStore {
  private map = new Map<number, ProxyFrameHandle>();
  get(id: number): ProxyFrameHandle | undefined {
    return this.map.get(id);
  }
  set(id: number, handle: ProxyFrameHandle): void {
    this.map.set(id, handle);
  }
  remove(id: number): void {
    this.map.get(id)?.el.remove();
    this.map.delete(id);
  }
  /** Show only `activeId`'s frame — and only when `show` (a new-tab active
   *  tab must hide every frame). Visibility is binary; this is THE invariant
   *  that keeps tabs from painting on top of each other. */
  toggleAll(activeId: number, show: boolean): void {
    for (const [tid, handle] of this.map) {
      handle.el.style.display = tid === activeId && show ? "" : "none";
    }
  }
  all(): ProxyFrameHandle[] {
    return [...this.map.values()];
  }
  clear(): void {
    for (const handle of this.map.values()) handle.el.remove();
    this.map.clear();
  }
}

/** Structural subset of SoundEngine so chrome can chirp. */
interface SoundLike {
  readonly enabled: boolean;
  setEnabled(v: boolean): void;
  key(): void;
  space(): void;
  enter(): void;
  backspace(): void;
}

/** Quick links for the new-tab page. The duckduckgo entry uses the LITE
 *  endpoint: static, zero JS-wall, submits results as plain GET — it renders
 *  and SEARCHES through every transport (the JS-heavy duckduckgo homepage
 *  regularly dies behind proxies). */
const QUICK_LINKS: Array<{ label: string; url: string; host: string }> = [
  { label: "duckduckgo", url: "https://lite.duckduckgo.com/lite/", host: "lite.duckduckgo.com" },
  { label: "hacker news", url: "https://news.ycombinator.com", host: "news.ycombinator.com" },
  { label: "wikipedia", url: "https://wikipedia.org", host: "wikipedia.org" },
  { label: "github", url: "https://github.com", host: "github.com" },
  { label: "youtube", url: "https://youtube.com", host: "youtube.com" },
  { label: "reddit", url: "https://reddit.com", host: "reddit.com" },
  { label: "spotify", url: "https://open.spotify.com", host: "open.spotify.com" },
  { label: "twitch", url: "https://twitch.tv", host: "twitch.tv" },
  { label: "discord", url: "https://discord.com/app", host: "discord.com" },
  { label: "gmail", url: "https://mail.google.com", host: "mail.google.com" },
  { label: "x", url: "https://x.com", host: "x.com" },
  { label: "archive", url: "https://archive.org", host: "archive.org" },
];

/* ---------- small shared pieces ---------- */

const NOISE_TILE = "relative isolate overflow-hidden bg-[color-mix(in_srgb,var(--term-fg)_4%,transparent)]";
const BOX_HEAD =
  "border-b border-[color-mix(in_srgb,var(--term-fg)_22%,transparent)] px-3 py-1.5 text-[10px] uppercase tracking-[0.3em] text-[var(--term-dim)]";

/* ---------- the new tab's engines (the globe opens this list) ---------- */

interface TabEngine {
  id: string;
  label: string;
  icon: LucideIcon;
  /** query url template; null = smart default (urls direct, terms → real ddg) */
  q: string | null;
}

const ENGINES: TabEngine[] = [
  { id: "duckduckgo", label: "duckduckgo", icon: Bird, q: DDG_SEARCH },
  { id: "anywhere", label: "anywhere", icon: Globe, q: null },
  { id: "google", label: "google", icon: Chrome, q: "https://www.google.com/search?q=" },
  { id: "wikipedia", label: "wikipedia", icon: BookOpen, q: "https://en.wikipedia.org/w/index.php?search=" },
  { id: "youtube", label: "youtube", icon: Youtube, q: "https://www.youtube.com/results?search_query=" },
  { id: "translate", label: "translate", icon: Languages, q: "https://translate.google.com/?sl=auto&tl=en&op=translate&text=" },
];

const ENGINE_KEY = "daemon.browser.engine";

function loadEngine(): TabEngine {
  try {
    const id = localStorage.getItem(ENGINE_KEY);
    return ENGINES.find((e) => e.id === id) ?? ENGINES[0];
  } catch {
    return ENGINES[0];
  }
}

/** urls browse direct no matter the engine; plain words follow it —
 *  anywhere/duckduckgo land on the NATIVE ddg results page */
function engineTarget(engine: TabEngine, raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const looksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(s);
  if (looksUrl) return normalizeTarget(s);
  if (!engine.q) return searchUrl(s);
  return engine.q + encodeURIComponent(s);
}

/** Favicon-style letter tile — first alnum char of the host on a brand-mix
 *  square. With `icon` set it renders that instead (new-tab tiles get +). */
function LetterTile({ text, size = 16, icon }: { text: string; size?: number; icon?: React.ReactNode }) {
  const ch = (text.replace(/^www\./, "").match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 select-none items-center justify-center rounded-[4px] font-bold"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.56)),
        lineHeight: 1,
        backgroundColor: "color-mix(in srgb, var(--term-brand) 22%, transparent)",
        color: "var(--term-brand)",
      }}
    >
      {icon ?? ch}
    </span>
  );
}

/** The site's ACTUAL icon is gone — every icon in this chrome wears the
 *  theme now. LetterTile is the single look: brand-colored letter squares
 *  that never clash with the terminal palette. */

/** the youtube quick link doesn't go through the proxy wall — it opens the
 *  watch app, whose embed player runs on the user's own connection */
function openWatch(query?: string): void {
  useOS.getState().openApp("watch", query ? `q:${query}` : undefined);
}

function MenuBtn({
  icon: Icon,
  label,
  value,
  hint,
  disabled,
  danger,
  title,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex w-full cursor-pointer items-center gap-2 px-1.5 py-1 text-left text-[11px] ${ROW_HOVER} disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent ${
        danger ? "text-[var(--term-err)]" : "text-[var(--term-fg)]"
      }`}
    >
      <Icon size={12} className="shrink-0 text-[var(--term-dim)]" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {(value ?? hint) && <span className="shrink-0 text-[9px] text-[var(--term-dim)]">{value ?? hint}</span>}
    </button>
  );
}

const MenuSep = () => <div className={`my-1 border-t ${BORDER_FAINT}`} aria-hidden="true" />;

/* ================= main ================= */

/**
 * The murke browser — a real chrome, boxy edition, built to live inside a
 * MacWindow body (h-full w-full flex-col; the OS chrome owns close/zoom).
 *
 * Layout: tab strip (letter tiles + close + plus) → toolbar (nav · omnibox
 * with search dropdown · star · downloads · kebab) → 2px loading bar →
 * optional bookmarks bar → content (stacked proxied frames or the new-tab
 * page) → status strip. History/bookmarks/session persist via browser-data.
 */
export default function BrowserView({
  url,
  winId,
  proxy,
  sound,
  onInstallApp,
}: {
  url: string; // initial url, or the "murke://newtab" sentinel
  /** the OS window id — popup captures are routed to their owner window */
  winId?: number;
  proxy: ProxyEngine;
  sound: SoundLike;
  onInstallApp?: (name: string, url: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const omniboxRef = useRef<HTMLInputElement | null>(null);
  const initial = url === NEWTAB_URL ? "" : url;

  /* ---------- tabs ---------- */
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, url: initial, address: initial }]);
  const [activeId, setActiveId] = useState(1);
  const [draft, setDraft] = useState(displayUrl(initial));
  const nextIdRef = useRef(2);
  /** tabId -> live frame (never in React state) */
  const frames = useMemo(() => new FrameStore(), []);
  /** latest tab list / active id / engine state for listeners (synced post-render) */
  const tabsRef = useRef<Tab[]>(tabs);
  const activeRef = useRef(activeId);
  const stateRef = useRef<"init" | "ok" | "error">("init");
  /** engine-ready flag — set SYNCHRONOUSLY when init resolves, because the
     post-render stateRef sync is too late for the session-restore path */
  const okRef = useRef(false);
  useEffect(() => {
    tabsRef.current = tabs;
    activeRef.current = activeId;
    stateRef.current = state;
  });

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  /** internal pages (new tab, native ddg search) paint over the frame host —
      the frame-invariant treats them exactly like a new tab */
  const activeIsNew = !active?.address || active.address.startsWith("murke://");
  const activeIsSearch = Boolean(active?.address?.startsWith("murke://search?"));

  /* ---------- engine + overlays ---------- */
  const [state, setState] = useState<"init" | "ok" | "error">("init");
  const [error, setError] = useState("");
  const [initNonce, setInitNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** download popover: pull the current page (or any url) into ~/Downloads */
  const [dlOpen, setDlOpen] = useState(false);
  const [dlUrl, setDlUrl] = useState("");
  const [dlName, setDlName] = useState("");
  const [dlState, setDlState] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [dlMsg, setDlMsg] = useState("");
  /** omnibox dropdown */
  const [omniOpen, setOmniOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const [omniHi, setOmniHi] = useState(-1);

  /* find in page + per-tab zoom + tab context menu */
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const [findCount, setFindCount] = useState(0);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; id: number } | null>(null);

  /* the glass top bar — toolbar + buttons only; the CONTENT stays opaque
     because a web page needs every pixel of fidelity it can get */
  const topGlass = useGlass({ distort: false, weight: 0.55 });
  const toolbarStyle: React.CSSProperties = topGlass.enabled
    ? {
        background: `color-mix(in srgb, var(--term-bg) ${Math.max(40, topGlass.alpha)}%, transparent)`,
        backdropFilter: topGlass.filter ?? undefined,
        WebkitBackdropFilter: topGlass.filter ?? undefined,
      }
    : { background: "var(--term-bg)" };

  /* ---------- persisted data (browser-data) ---------- */
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>([]);
  const [prefs, setPrefs] = useState({ bookmarksBar: false });
  const sessionDoneRef = useRef(false);
  /** closed tabs (memory only, newest first) + a renderable count mirror */
  const closedStackRef = useRef<Array<{ url: string; label: string }>>([]);
  const [closedCount, setClosedCount] = useState(0);

  useEffect(() => {
    setHistory(loadHistory());
    setBookmarks(loadBookmarks());
    setPrefs(loadPrefs());
  }, []);

  /* ---------- loading bar ---------- */
  const loadTimerRef = useRef(0);
  const startLoad = useCallback(() => {
    window.clearTimeout(loadTimerRef.current);
    setLoading(true);
    // failsafe: onUrl is the real end signal; never spin forever
    loadTimerRef.current = window.setTimeout(() => setLoading(false), 8000);
  }, []);
  const finishLoad = useCallback(() => {
    window.clearTimeout(loadTimerRef.current);
    setLoading(false);
  }, []);

  /* ---------- history recording ---------- */
  const lastNavRef = useRef(new Map<number, string>());
  const recordNav = useCallback(
    (tabId: number, shown: string, bump = false) => {
      if (!shown || !/^https?:\/\//i.test(shown)) return;
      if (!bump && lastNavRef.current.get(tabId) === shown) return;
      lastNavRef.current.set(tabId, shown);
      let title = "";
      try {
        const t = frames.get(tabId)?.el.contentWindow?.document?.title?.trim();
        if (t) title = t.slice(0, 120);
      } catch {
        /* cross-origin — hostname fallback below */
      }
      if (!title) title = hostFor(shown) || shown.slice(0, 40);
      addHistory(shown, title);
      setHistory(loadHistory());
    },
    [frames],
  );

  /* ---------- frame plumbing ---------- */

  const patchTab = useCallback((id: number, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  /** wire a frame's onUrl so tab title + address follow navigation */
  const attachUrlListener = useCallback(
    (tabId: number, handle: ProxyFrameHandle) => {
      handle.onUrl((u) => {
        const shown = displayUrl(u);
        patchTab(tabId, { url: u, address: shown });
        if (tabId === activeRef.current) finishLoad();
        recordNav(tabId, shown);
        // titles usually land after commit — re-record once to catch them
        window.setTimeout(() => recordNav(tabId, shown, true), 1500);
      });
    },
    [patchTab, recordNav, finishLoad],
  );

  /** THE overlay-bug invariant: only the active tab's frame may be visible,
   *  and a new-tab active tab hides every frame. Applied immediately, in a
   *  rAF and once more shortly after — a frame mounted between ticks cannot
   *  sneak on top of the previous tab. */
  const invariantRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const apply = () => frames.toggleAll(activeId, !activeIsNew);
    invariantRef.current = apply;
    apply();
    const raf = requestAnimationFrame(apply);
    const t = window.setTimeout(apply, 80);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [activeId, activeIsNew, frames]);

  const ensureFrame = useCallback(
    (tabId: number): ProxyFrameHandle | null => {
      const existing = frames.get(tabId);
      if (existing) return existing;
      if (!okRef.current) return null;
      try {
        const handle = proxy.createFrame();
        positionFrame(handle);
        attachUrlListener(tabId, handle);
        if (hostRef.current && !hostRef.current.contains(handle.el)) {
          hostRef.current.appendChild(handle.el);
        }
        // new frames start hidden unless they belong to the active tab
        handle.el.style.display = tabId === activeRef.current ? "" : "none";
        // a duplicated/restored tab carries its zoom
        const t0 = tabsRef.current.find((x) => x.id === tabId);
        if (t0?.zoom) handle.el.style.zoom = String(t0.zoom);
        frames.set(tabId, handle);
        invariantRef.current?.();
        return handle;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
        return null;
      }
    },
    [proxy, frames, attachUrlListener],
  );

  /* ---------- mount: restore session, init proxy, first frame ---------- */

  useEffect(() => {
    let dead = false;
    setState("init");
    okRef.current = false;
    if (!sessionDoneRef.current) {
      sessionDoneRef.current = true;
      /* a caller-requested url (simple mode: the typed search; terminal:
         `proxy <url>`) outranks the stale saved session — the desktop
         relaunch passes the newtab sentinel, so THAT path still restores */
      const sess = loadSession();
      if (sess && !initial) {
        const restored: Tab[] = sess.tabs.map((u, i) => {
          const id = i + 1;
          return !u || u === "newtab" ? { id, url: "", address: "" } : { id, url: u, address: u };
        });
        nextIdRef.current = restored.length + 1;
        tabsRef.current = restored;
        activeRef.current = sess.active + 1;
        setTabs(restored);
        setActiveId(sess.active + 1);
        setDraft(restored[sess.active]?.address ?? "");
      }
    }
    void (async () => {
      let r: { ok: boolean; error?: string };
      try {
        r = await proxy.init();
      } catch (e) {
        r = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      if (dead) return;
      if (!r.ok) {
        setError(r.error ?? "proxy failed to initialize");
        setState("error");
        return;
      }
      okRef.current = true;
      try {
        // retry path: a fresh host div exists — re-hang every surviving frame
        if (hostRef.current) {
          for (const h of frames.all()) {
            if (!hostRef.current.contains(h.el)) hostRef.current.appendChild(h.el);
          }
        }
        const t = tabsRef.current.find((x) => x.id === activeRef.current);
        if (t?.address && !t.address.startsWith("murke://")) {
          const handle = ensureFrame(t.id);
          if (handle) {
            handle.go(t.address);
            startLoad();
          }
        } else {
          window.setTimeout(() => omniboxRef.current?.focus(), 60);
        }
        setState("ok");
        invariantRef.current?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    })();
    return () => {
      dead = true;
    };
  }, [proxy, initNonce, frames, ensureFrame, startLoad]);

  /* unmount (window close): flush the session + drop the frames */
  useEffect(() => {
    return () => {
      try {
        saveSession(
          tabsRef.current.map((t) => t.address || "newtab"),
          Math.max(0, tabsRef.current.findIndex((t) => t.id === activeRef.current)),
        );
      } catch {
        /* ignore */
      }
      frames.clear();
    };
  }, [frames]);

  /* debounced session save while browsing */
  useEffect(() => {
    if (!sessionDoneRef.current) return;
    const t = window.setTimeout(() => {
      saveSession(
        tabs.map((x) => x.address || "newtab"),
        Math.max(0, tabs.findIndex((x) => x.id === activeId)),
      );
    }, 400);
    return () => window.clearTimeout(t);
  }, [tabs, activeId]);

  /* ---------- navigation ---------- */

  const go = useCallback(
    (raw: string) => {
      const raw0 = raw.trim();
      if (!raw0) return;
      const id = activeRef.current;
      /* internal pages (the native ddg results) render in the chrome itself
         — no frame, no navigation, pure tab state. checked BEFORE
         resolveInput, which politely eats murke: schemes. */
      if (raw0.startsWith("murke://")) {
        patchTab(id, { url: raw0, address: raw0 });
        setDraft(displayUrl(raw0));
        finishLoad();
        sound.enter();
        return;
      }
      const target = resolveInput(raw0);
      if (!target) return;
      const handle = ensureFrame(id);
      if (!handle) return;
      patchTab(id, { url: target, address: target });
      setDraft(target);
      startLoad();
      handle.go(target);
      sound.enter();
    },
    [ensureFrame, patchTab, startLoad, finishLoad, sound],
  );

  /** back to the new-tab page: blank the tab — the invariant effect hides the frame */
  const goHome = useCallback(() => {
    const id = activeRef.current;
    patchTab(id, { url: "", address: "" });
    setDraft("");
    finishLoad();
    window.setTimeout(() => omniboxRef.current?.focus(), 0);
    sound.key();
  }, [patchTab, finishLoad, sound]);

  /* ---------- tab lifecycle ---------- */

  const newTab = useCallback(
    (initialUrl?: string) => {
      const id = nextIdRef.current++;
      const u = initialUrl ?? "";
      setTabs((prev) => [...prev, { id, url: u, address: u }]);
      setActiveId(id);
      setDraft(displayUrl(u));
      setOmniOpen(false);
      setTyped(false);
      /* popups land straight in the page — only a blank tab focuses the omnibox */
      if (!u) window.setTimeout(() => omniboxRef.current?.focus(), 30);
      sound.key();
    },
    [sound],
  );

  const closeTab = useCallback(
    (id: number) => {
      const closed = tabsRef.current.find((t) => t.id === id);
      if (closed?.address) {
        closedStackRef.current = [
          { url: closed.address, label: tabTitle(closed.url) },
          ...closedStackRef.current,
        ].slice(0, 10);
        setClosedCount(closedStackRef.current.length);
      }
      frames.remove(id);
      lastNavRef.current.delete(id);
      const rest = tabsRef.current.filter((t) => t.id !== id);
      if (rest.length === 0) {
        // last tab closes back to the new-tab page — the window stays
        const freshId = nextIdRef.current++;
        setTabs([{ id: freshId, url: "", address: "" }]);
        setActiveId(freshId);
        setDraft("");
        window.setTimeout(() => omniboxRef.current?.focus(), 30);
        sound.key();
        return;
      }
      const wasActive = activeRef.current === id;
      let nextActive = activeRef.current;
      if (wasActive) {
        const closedIdx = tabsRef.current.findIndex((t) => t.id === id);
        nextActive = rest[Math.min(closedIdx, rest.length - 1)].id;
      }
      setTabs(rest);
      if (wasActive) {
        setActiveId(nextActive);
        const t = rest.find((x) => x.id === nextActive);
        if (t?.address && !t.address.startsWith("murke://") && !frames.get(nextActive)) {
          const handle = ensureFrame(nextActive);
          if (handle) {
            handle.go(t.address);
            startLoad();
          }
        }
      }
      sound.key();
    },
    [frames, ensureFrame, startLoad, sound],
  );

  const switchTab = useCallback(
    (id: number) => {
      if (id === activeRef.current) return;
      finishLoad();
      setActiveId(id);
      // lazy (re)load: a tab with content but no frame navigates on first view
      const t = tabsRef.current.find((x) => x.id === id);
      if (t?.address && !t.address.startsWith("murke://") && !frames.get(id)) {
        const handle = ensureFrame(id);
        if (handle) {
          handle.go(t.address);
          startLoad();
        }
      }
      sound.key();
    },
    [finishLoad, ensureFrame, frames, startLoad, sound],
  );

  const reopenClosed = useCallback(() => {
    const entry = closedStackRef.current.shift();
    setClosedCount(closedStackRef.current.length);
    if (!entry) return;
    const act = tabsRef.current.find((x) => x.id === activeRef.current);
    if (act && !act.address) {
      go(entry.url); // reuse the empty active tab
    } else {
      const id = nextIdRef.current++;
      setTabs((prev) => [...prev, { id, url: entry.url, address: entry.url }]);
      setActiveId(id);
      const handle = ensureFrame(id);
      if (handle) {
        handle.go(entry.url);
        startLoad();
      }
    }
    sound.key();
  }, [go, ensureFrame, startLoad, sound]);

  /* ---------- find in page ---------- */

  const activeFrameForFind = useCallback((): ProxyFrameHandle | null => frames.get(activeRef.current) ?? null, [frames]);

  const doFind = useCallback(
    (q: string, idx: number) => {
      const count = runFind(activeFrameForFind(), q, idx);
      setFindCount(count);
      setFindIdx(count ? ((idx % count) + count) % count : 0);
    },
    [activeFrameForFind],
  );

  const openFind = useCallback(() => {
    setMenuOpen(false);
    setDlOpen(false);
    setFindOpen(true);
    window.setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 30);
    sound.key();
  }, [sound]);

  const closeFind = useCallback(() => {
    clearFind(activeFrameForFind());
    setFindOpen(false);
    setFindQ("");
    setFindCount(0);
    setFindIdx(0);
  }, [activeFrameForFind]);

  const findNext = useCallback(
    (dir: 1 | -1) => {
      if (!findQ) return;
      const n = findCount ? ((findIdx + dir + findCount) % findCount) : 0;
      doFind(findQ, n);
    },
    [findQ, findCount, findIdx, doFind],
  );

  /* leaving the page or switching tabs invalidates the highlights */
  useEffect(() => {
    if (!findOpen) return;
    clearFind(activeFrameForFind());
    setFindCount(0);
    setFindIdx(0);
    if (findQ) doFind(findQ, 0);
  }, [activeId, findOpen]);

  /* ---------- per-tab zoom ---------- */

  const setZoom = useCallback(
    (z: number) => {
      const nz = Math.min(2, Math.max(0.5, Math.round(z * 10) / 10));
      patchTab(activeRef.current, { zoom: nz });
    },
    [patchTab],
  );

  /* zoom lives on the frame element itself — sync on every tab change */
  useEffect(() => {
    for (const t of tabs) {
      const h = frames.get(t.id);
      if (h) h.el.style.zoom = String(t.zoom ?? 1);
    }
  }, [tabs, frames]);

  /* ---------- duplicate tab + tab context menu ---------- */

  const duplicateTab = useCallback(
    (id: number) => {
      const t = tabsRef.current.find((x) => x.id === id);
      if (!t?.address) return;
      const nid = nextIdRef.current++;
      setTabs((prev) => {
        const idx = prev.findIndex((x) => x.id === id);
        const copy = [...prev];
        copy.splice(idx + 1, 0, { id: nid, url: t.url, address: t.address, zoom: t.zoom });
        return copy;
      });
      setActiveId(nid);
      setDraft(t.address);
      if (!t.address.startsWith("murke://")) {
        const handle = ensureFrame(nid);
        if (handle) {
          handle.el.style.zoom = String(t.zoom ?? 1);
          handle.go(t.address);
          startLoad();
        }
      }
      sound.key();
    },
    [ensureFrame, startLoad, sound],
  );

  /* close the tab ctx menu on any outside interaction */
  useEffect(() => {
    if (!tabCtx) return;
    const close = () => setTabCtx(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [tabCtx]);

  /* ---------- bookmarks + prefs ---------- */

  const bookmarked = useMemo(
    () => !!active?.address && bookmarks.some((b) => b.url === active.address),
    [bookmarks, active?.address],
  );

  const toggleBookmark = useCallback(() => {
    const act = tabsRef.current.find((t) => t.id === activeRef.current);
    const u = act?.address;
    if (!u) return;
    if (isBookmarked(u)) removeBookmark(u);
    else addBookmark(u, tabTitle(act?.url ?? u));
    setBookmarks(loadBookmarks());
    sound.key();
  }, [sound]);

  const toggleBookmarksBar = useCallback(() => {
    setPrefs((p) => {
      const next = { ...p, bookmarksBar: !p.bookmarksBar };
      savePrefs(next);
      return next;
    });
    sound.key();
  }, [sound]);

  /* ---------- downloads ---------- */

  const openDl = useCallback(() => {
    setMenuOpen(false);
    setHistoryOpen(false);
    setDlOpen((v) => {
      if (!v) {
        const act = tabsRef.current.find((t) => t.id === activeRef.current);
        const current = act?.address ?? "";
        setDlUrl(current ? current : "");
        setDlName("");
        setDlState("idle");
        setDlMsg("");
      }
      return !v;
    });
  }, []);

  const runDownload = useCallback(async (rawUrl: string, name?: string) => {
    const target = rawUrl.trim();
    if (!target) return;
    setDlState("busy");
    setDlMsg("");
    try {
      const meta = await fetchIntoVfs(target, getVfs(), { dir: "~/Downloads", name: name?.trim() || undefined });
      setDlState("ok");
      setDlMsg(`${meta.name} — ${formatBytes(meta.size)}`);
    } catch (e) {
      setDlState("err");
      setDlMsg(e instanceof Error ? e.message : "download failed");
    }
  }, []);

  /* ---------- history sheet ---------- */

  const openHistory = useCallback(() => {
    setMenuOpen(false);
    setDlOpen(false);
    setHistory(loadHistory());
    setHistoryOpen(true);
    sound.key();
  }, [sound]);

  /* ---------- keyboard: top-window shortcuts + escape arbitration ---------- */

  const ovRef = useRef({ menu: menuOpen, dl: dlOpen, history: historyOpen, omni: omniOpen, find: findOpen });
  useEffect(() => {
    ovRef.current = { menu: menuOpen, dl: dlOpen, history: historyOpen, omni: omniOpen, find: findOpen };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && !e.shiftKey && k === "t") {
        e.preventDefault();
        e.stopPropagation();
        newTab();
      } else if (mod && e.shiftKey && k === "t") {
        e.preventDefault();
        e.stopPropagation();
        reopenClosed();
      } else if (mod && !e.shiftKey && k === "w") {
        e.preventDefault();
        e.stopPropagation();
        closeTab(activeRef.current);
      } else if (mod && !e.shiftKey && k === "l") {
        e.preventDefault();
        e.stopPropagation();
        setOmniOpen(true);
        setTyped(false);
        omniboxRef.current?.focus();
        omniboxRef.current?.select();
      } else if (mod && !e.shiftKey && k === "f") {
        e.preventDefault();
        e.stopPropagation();
        openFind();
      } else if (mod && (k === "=" || k === "+")) {
        e.preventDefault();
        e.stopPropagation();
        setZoom((tabsRef.current.find((t) => t.id === activeRef.current)?.zoom ?? 1) + 0.1);
      } else if (mod && k === "-") {
        e.preventDefault();
        e.stopPropagation();
        setZoom((tabsRef.current.find((t) => t.id === activeRef.current)?.zoom ?? 1) - 0.1);
      } else if (mod && k === "0") {
        e.preventDefault();
        e.stopPropagation();
        setZoom(1);
      } else if (e.altKey && k === "t") {
        e.preventDefault();
        e.stopPropagation();
        newTab();
      } else if (e.key === "Escape") {
        // innermost overlay wins; with nothing open, Escape belongs to the OS
        const ov = ovRef.current;
        if (ov.history) {
          e.preventDefault();
          e.stopPropagation();
          setHistoryOpen(false);
        } else if (ov.find) {
          e.preventDefault();
          e.stopPropagation();
          closeFind();
        } else if (ov.menu) {
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen(false);
        } else if (ov.dl) {
          e.preventDefault();
          e.stopPropagation();
          setDlOpen(false);
        } else if (ov.omni) {
          e.preventDefault();
          e.stopPropagation();
          setOmniOpen(false);
        }
      }
    };
    const onCustomNewTab = () => newTab();
    /* a captured popup from a proxied frame (or an installed app) routed to
       THIS window opens as a new tab in here — never a real browser tab */
    const onPopupOpen = (e: Event) => {
      const d = (e as CustomEvent<{ url?: string; winId?: number }>).detail;
      if (!d?.url) return;
      if (winId !== undefined && d.winId !== undefined && d.winId !== winId) return;
      newTab(d.url);
    };
    const onCustomCloseTab = () => closeTab(activeRef.current);
    const onCustomFind = () => openFind();
    const onCustomZoom = (e: Event) => {
      const t = e.type;
      const cur = tabsRef.current.find((x) => x.id === activeRef.current)?.zoom ?? 1;
      if (t === "murke-browser-zoom-in") setZoom(cur + 0.1);
      else if (t === "murke-browser-zoom-out") setZoom(cur - 0.1);
      else setZoom(1);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("murke-browser-newtab", onCustomNewTab);
    window.addEventListener("murke-browser-open", onPopupOpen as EventListener);
    window.addEventListener("murke-browser-closetab", onCustomCloseTab);
    window.addEventListener("murke-browser-find", onCustomFind);
    window.addEventListener("murke-browser-zoom-in", onCustomZoom);
    window.addEventListener("murke-browser-zoom-out", onCustomZoom);
    window.addEventListener("murke-browser-zoom-reset", onCustomZoom);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("murke-browser-newtab", onCustomNewTab);
      window.removeEventListener("murke-browser-open", onPopupOpen as EventListener);
      window.removeEventListener("murke-browser-closetab", onCustomCloseTab);
      window.removeEventListener("murke-browser-find", onCustomFind);
      window.removeEventListener("murke-browser-zoom-in", onCustomZoom);
      window.removeEventListener("murke-browser-zoom-out", onCustomZoom);
      window.removeEventListener("murke-browser-zoom-reset", onCustomZoom);
    };
  }, [newTab, reopenClosed, closeTab, openFind, closeFind, setZoom]);

  /* re-attach the in-frame key handler periodically (fresh documents drop listeners) */
  useEffect(() => {
    const attached = new Set<Window>();
    const detachAll = () => {
      for (const w of attached) {
        try {
          w.removeEventListener("keydown", frameKey);
        } catch {
          /* the frame died and took its window's origin with it */
        }
      }
      attached.clear();
    };
    const attach = () => {
      for (const handle of frames.all()) {
        try {
          const win = handle.el.contentWindow ?? null;
          if (win && !attached.has(win)) {
            win.addEventListener("keydown", frameKey);
            attached.add(win);
          }
          /* popups must never escape into real browser tabs — patch this
             frame's open/anchors too (idempotent, marker-guarded) */
          installPopupCapture(win, winId ?? -1);
        } catch {
          /* frame not ready yet */
        }
      }
    };
    const iv = window.setInterval(attach, 800);
    attach();
    return () => {
      window.clearInterval(iv);
      detachAll();
    };
  }, [frames]);

  /* ---------- proxied-frame fault reports → transport failover ---------- */

  const faultRef = useRef<{ url: string; at: number } | null>(null);
  useEffect(() => {
    let busy = false;
    const onMsg = (e: MessageEvent) => {
      try {
        if (e.origin !== window.location.origin) return;
        const d = e.data as { __murkeProxyFault?: boolean; url?: string } | null;
        if (!d || d.__murkeProxyFault !== true) return;
        const faultUrl = d.url ?? "";
        const last = faultRef.current;
        // one heal per url per 10s — the retry link covers stubborn cases
        if (last && last.url === faultUrl && Date.now() - last.at < 10_000) return;
        faultRef.current = { url: faultUrl, at: Date.now() };
        if (busy) return;
        busy = true;
        void (async () => {
          try {
            if (typeof proxy.revalidate === "function") await proxy.revalidate();
            let target = faultUrl ? frames.all().find((h) => h.getUrl() === faultUrl) : undefined;
            if (!target) target = frames.get(activeRef.current);
            target?.reload();
          } finally {
            busy = false;
          }
        })();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [proxy, frames]);

  /* ---------- launch-arg forwarding (`web <url>` with the window open) ---------- */

  const lastPropUrlRef = useRef(url);
  useEffect(() => {
    if (url === lastPropUrlRef.current) return;
    lastPropUrlRef.current = url;
    if (url && url !== NEWTAB_URL) go(url);
  }, [url, go]);

  /* ---------- omnibox ---------- */

  /* the address bar mirrors the ACTIVE tab — unless the user is mid-edit */
  useEffect(() => {
    const el = omniboxRef.current;
    if (el && document.activeElement === el) return;
    setDraft(tabs.find((t) => t.id === activeId)?.address ?? "");
  }, [tabs, activeId]);

  const omniQuery = draft.trim();
  const omniResults = useMemo<SearchHit[]>(
    () => (omniOpen && typed ? searchAll(omniQuery).slice(0, 8) : []),
    [omniOpen, typed, omniQuery],
  );
  const omniRows = omniResults.length + 1; // results + the ddg search row

  const pickOmni = useCallback(
    (target: string) => {
      setOmniOpen(false);
      setTyped(false);
      omniboxRef.current?.blur();
      go(target);
    },
    [go],
  );

  const onOmniKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOmniOpen(true);
      setOmniHi((h) => Math.min(h + 1, omniRows - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOmniHi((h) => Math.max(h - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      sound.enter();
      const q = draft.trim();
      if (omniOpen && omniHi >= 0) {
        pickOmni(omniHi < omniResults.length ? omniResults[omniHi].url : searchUrl(q));
      } else if (q) {
        pickOmni(q);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOmniOpen(false);
      setTyped(false);
      setDraft(active?.address ?? "");
      omniboxRef.current?.blur();
    } else {
      if (e.key === " ") sound.space();
      else if (e.key === "Backspace") sound.backspace();
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) sound.key();
    }
  };

  /* ---------- toolbar actions ---------- */

  const navTo = (dir: "back" | "forward") => {
    const handle = frames.get(activeRef.current);
    if (!handle) return;
    startLoad();
    if (dir === "back") handle.back();
    else handle.forward();
    sound.key();
  };
  const doReload = () => {
    const handle = frames.get(activeRef.current);
    if (!handle) return;
    startLoad();
    handle.reload();
    sound.key();
  };
  const doStop = () => {
    const handle = frames.get(activeRef.current);
    if (handle) stopFrame(handle);
    finishLoad();
    sound.key();
  };

  const installCurrent = () => {
    const act = tabsRef.current.find((t) => t.id === activeRef.current);
    const u = act?.address;
    if (!u || !onInstallApp) return;
    onInstallApp(hostFor(u) || u, u);
    setMenuOpen(false);
  };

  /* ---------- render ---------- */

  /* The tab strip portals into the WINDOW TITLE BAR (MacWindow hands us the
     slot) — tabs become the top bar, mac dots sit on the right, and the
     old "title bar + tab strip" double-deck collapses into one. Fallback:
     render it inline when there's no slot (title bar not mounted yet). */
  const slot = useTitlebarSlot();

  const tabStrip = (
    <div
      role="tablist"
      aria-label="browser tabs"
      className="flex h-full min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        const title = tabTitle(t.url);
        return (
          <div
            key={t.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={-1}
            data-nodrag
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(t.id);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setTabCtx({ x: e.clientX, y: e.clientY, id: t.id });
            }}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault(); // no autoscroll on close-click
            }}
            className={`group relative flex h-[calc(100%-6px)] max-w-[180px] min-w-[96px] shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-[8px] px-2 transition-colors sm:max-w-[200px] ${
              isActive
                ? // raised glass chip — quiet, rounded, quietly lit, sized to the title bar
                  "z-10 bg-[color-mix(in_srgb,var(--term-fg)_9%,transparent)] text-[var(--term-fg)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--term-fg)_10%,transparent)]"
                : `text-[var(--term-dim)] hover:bg-[color-mix(in_srgb,var(--term-fg)_6%,transparent)]`
            }`}
          >
            {/* full-tab hit layer — keeps close X a sibling button (clean a11y) */}
            <button
              type="button"
              onClick={() => switchTab(t.id)}
              title={t.address || "new tab"}
              aria-label={`switch to ${title}`}
              className="absolute inset-0 z-0 cursor-pointer rounded-[8px]"
            />
            {t.address ? (
              t.address.startsWith("murke://search?") ? (
                <Search size={13} className="shrink-0 text-[var(--term-brand)]" aria-hidden="true" />
              ) : (
                <LetterTile text={t.address} size={14} />
              )
            ) : (
              <LetterTile text="" size={14} icon={<Plus size={9} />} />
            )}
            <span
              className={`min-w-0 flex-1 truncate text-left font-mono text-[11px] ${
                isActive ? "text-[var(--term-fg)]" : "text-[var(--term-dim)] group-hover:text-[var(--term-fg)]"
              }`}
            >
              {title}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
              onAuxClick={(e) => e.stopPropagation()}
              aria-label={`close tab ${title}`}
              title="close tab (middle-click works too)"
              className="relative z-10 cursor-pointer rounded-[4px] px-0.5 text-[var(--term-fg)] opacity-30 transition-opacity hover:bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)] hover:opacity-100 group-hover:opacity-70"
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => newTab()}
        aria-label="new tab"
        title="new tab (ctrl+t)"
        data-nodrag
        className="my-[3px] h-[calc(100%-6px)] w-9 shrink-0 cursor-pointer items-center justify-center rounded-[8px] text-[var(--term-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_7%,transparent)] hover:text-[var(--term-fg)]"
      >
        <Plus size={13} />
      </button>
    </div>
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-[var(--term-bg)]" role="region" aria-label="murke browser">
      <style>{CHROME_CSS}</style>

      {/* ---------- tab strip — lives in the window title bar ---------- */}
      {slot ? createPortal(tabStrip, slot) : <div className="flex h-9 shrink-0 items-stretch border-b border-[color-mix(in_srgb,var(--term-fg)_12%,transparent)]">{tabStrip}</div>}

      {/* ---------- toolbar — the glass top bar. content stays opaque: a
              web page needs every pixel of fidelity it can get ---------- */}
      <div
        className="relative z-10 flex shrink-0 items-center gap-1 border-b px-2 py-1.5"
        style={{ ...toolbarStyle, borderColor: "color-mix(in srgb, var(--term-fg) 9%, transparent)" }}
      >
        <button className={BOX_BTN} onClick={() => navTo("back")} disabled={activeIsNew} title="back" aria-label="back">
          <ChevronLeft size={15} />
        </button>
        <button className={BOX_BTN} onClick={() => navTo("forward")} disabled={activeIsNew} title="forward" aria-label="forward">
          <ChevronRight size={15} />
        </button>
        {loading ? (
          <button className={BOX_BTN} onClick={doStop} title="stop" aria-label="stop loading">
            <X size={14} />
          </button>
        ) : (
          <button className={BOX_BTN} onClick={doReload} disabled={activeIsNew} title="reload" aria-label="reload">
            <RotateCw size={13} />
          </button>
        )}
        <button className={BOX_BTN} onClick={goHome} title="new tab page" aria-label="home">
          <Home size={14} />
        </button>

        {/* omnibox + search dropdown — a quiet pill */}
        <div className="relative mx-1 flex min-w-0 flex-1 items-center">
          <div
            className={`flex min-w-0 flex-1 items-center gap-2 rounded-full border ${BOX_BORDER} bg-[color-mix(in_srgb,var(--term-fg)_6%,transparent)] px-3 py-1 transition-colors focus-within:border-[color-mix(in_srgb,var(--term-brand)_50%,transparent)] focus-within:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]`}
          >
            <Search size={11} className="shrink-0 text-[var(--term-dim)]" aria-hidden="true" />
            <input
              ref={omniboxRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setTyped(true);
                setOmniOpen(true);
                setOmniHi(-1);
              }}
              onFocus={() => {
                setOmniOpen(true);
                setTyped(false);
              }}
              onBlur={() => window.setTimeout(() => setOmniOpen(false), 120)}
              onKeyDown={onOmniKeyDown}
              placeholder={state === "init" ? "connecting…" : "search or enter address"}
              spellCheck={false}
              autoComplete="off"
              aria-label="browser address"
              role="combobox"
              aria-expanded={omniOpen && typed && !!omniQuery}
              aria-controls="murke-omni-list"
              className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)]"
            />
            {loading && <Loader2 size={11} className="shrink-0 animate-spin text-[var(--term-dim)]" aria-hidden="true" />}
          </div>

          {omniOpen && typed && omniQuery && (
            <div
              id="murke-omni-list"
              role="listbox"
              aria-label="address suggestions"
              className={`absolute left-0 right-0 top-full z-50 mt-1.5 max-h-[300px] overflow-y-auto rounded-xl border ${BOX_BORDER} bg-[color-mix(in_srgb,var(--term-bg)_97%,transparent)] p-1 font-mono shadow-[0_18px_50px_rgba(0,0,0,0.5)] murke-scroll`}
            >
              {omniResults.map((r, i) => (
                <button
                  key={`${r.kind}-${r.url}`}
                  type="button"
                  role="option"
                  aria-selected={omniHi === i}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickOmni(r.url)}
                  className={`flex w-full items-center gap-2 px-1.5 py-1.5 text-left text-[11px] ${
                    omniHi === i ? "bg-[color-mix(in_srgb,var(--term-brand)_16%,transparent)]" : ROW_HOVER
                  }`}
                >
                  <span
                    className={`shrink-0 border px-1 text-[8.5px] uppercase leading-[1.4] ${
                      r.kind === "bookmark"
                        ? "border-[color-mix(in_srgb,var(--term-brand)_50%,transparent)] text-[var(--term-brand)]"
                        : "border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] text-[var(--term-dim)]"
                    }`}
                  >
                    {r.kind === "bookmark" ? "bm" : "h"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[var(--term-fg)]">{r.title}</span>
                  <span className="max-w-[40%] shrink-0 truncate text-[9.5px] text-[var(--term-dim)]">{r.url}</span>
                </button>
              ))}
              <button
                type="button"
                role="option"
                aria-selected={omniHi === omniResults.length}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickOmni(searchUrl(omniQuery))}
                className={`flex w-full items-center gap-2 px-1.5 py-1.5 text-left text-[11px] ${
                  omniHi === omniResults.length ? "bg-[color-mix(in_srgb,var(--term-brand)_16%,transparent)]" : ROW_HOVER
                }`}
              >
                <Search size={11} className="shrink-0 text-[var(--term-dim)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[var(--term-fg)]">
                  search duckduckgo <span className="text-[var(--term-dim)]">— real results, served native · {omniQuery}</span>
                </span>
              </button>
            </div>
          )}
        </div>

        {/* star — bookmark the current page */}
        <button
          type="button"
          onClick={toggleBookmark}
          disabled={activeIsNew}
          aria-pressed={bookmarked}
          title={bookmarked ? "remove bookmark" : "bookmark this page"}
          aria-label={bookmarked ? "remove bookmark" : "bookmark this page"}
          className={`${BOX_BTN} ${bookmarked ? "text-[var(--term-brand)]" : ""}`}
        >
          <Star size={14} {...(bookmarked ? { fill: "currentColor" } : {})} />
        </button>

        {/* downloads → vfs popover */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              openDl();
            }}
            title="download a file into the file manager"
            aria-label="download file"
            aria-expanded={dlOpen}
            className={`${BOX_BTN} ${dlOpen ? "border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]" : ""}`}
          >
            <Download size={15} />
          </button>
          {dlOpen && (
            <>
              <div className="absolute inset-0 z-40" onClick={() => setDlOpen(false)} aria-hidden="true" />
              <div className={`${BOX_POPOVER} w-80 p-2.5`} role="dialog" aria-label="download file">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[9.5px] uppercase tracking-widest text-[var(--term-dim)]">download → ~/Downloads</span>
                  <button
                    type="button"
                    onClick={() => setDlOpen(false)}
                    className="cursor-pointer text-[var(--term-dim)] hover:text-[var(--term-fg)]"
                    aria-label="close download panel"
                  >
                    <X size={11} />
                  </button>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void runDownload(dlUrl, dlName);
                  }}
                >
                  <input
                    value={dlUrl}
                    onChange={(e) => setDlUrl(e.target.value)}
                    placeholder="https://… file url"
                    spellCheck={false}
                    aria-label="file url to download"
                    className={`w-full border ${BOX_BORDER} bg-transparent px-2 py-1.5 text-[11px] outline-none placeholder:text-[var(--term-dim)] focus:border-[color-mix(in_srgb,var(--term-fg)_45%,transparent)]`}
                  />
                  <input
                    value={dlName}
                    onChange={(e) => setDlName(e.target.value)}
                    placeholder={dlUrl.trim() ? `filename — auto: ${nameFromUrl(dlUrl.trim())}` : "filename (auto)"}
                    spellCheck={false}
                    aria-label="file name"
                    className={`mt-1.5 w-full border ${BOX_BORDER} bg-transparent px-2 py-1.5 text-[11px] outline-none placeholder:text-[var(--term-dim)] focus:border-[color-mix(in_srgb,var(--term-fg)_45%,transparent)]`}
                  />
                  <button
                    type="submit"
                    disabled={dlState === "busy" || !dlUrl.trim()}
                    className="mt-1.5 flex w-full cursor-pointer items-center justify-center gap-2 border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] py-1.5 text-[11px] hover:bg-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] disabled:opacity-40"
                  >
                    {dlState === "busy" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                    {dlState === "busy" ? "fetching…" : "fetch into files"}
                  </button>
                </form>
                {dlState === "busy" && (
                  <div className="nb-progress mt-1.5 h-[3px] bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]" aria-hidden="true" />
                )}
                {dlMsg && (
                  <p className={`mt-1.5 break-all text-[10.5px] ${dlState === "err" ? "text-[var(--term-err)]" : "text-[var(--term-fg)]"}`}>
                    {dlState === "ok" ? "↓ " : ""}
                    {dlMsg}
                  </p>
                )}
                {dlState === "ok" && <p className="mt-0.5 text-[10px] text-[var(--term-dim)]">open the files app from the dock</p>}
              </div>
            </>
          )}
        </div>

        {/* kebab menu */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              setDlOpen(false);
              setMenuOpen((v) => !v);
            }}
            title="menu"
            aria-label="browser menu"
            aria-expanded={menuOpen}
            className={`${BOX_BTN} ${menuOpen ? "border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]" : ""}`}
          >
            <MoreVertical size={15} />
          </button>
          {menuOpen && (
            <>
              <div className="absolute inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden="true" />
              <div className={`${BOX_POPOVER} w-60 p-1.5`} role="menu" aria-label="browser menu">
                <MenuBtn
                  icon={Plus}
                  label="new tab"
                  hint="ctrl+t"
                  onClick={() => {
                    setMenuOpen(false);
                    newTab();
                  }}
                />
                <MenuBtn
                  icon={RotateCcw}
                  label="reopen closed tab"
                  hint="ctrl+shift+t"
                  disabled={closedCount === 0}
                  onClick={() => {
                    setMenuOpen(false);
                    reopenClosed();
                  }}
                />
                <MenuSep />
                <MenuBtn
                  icon={Bookmark}
                  label="bookmarks bar"
                  value={prefs.bookmarksBar ? "on" : "off"}
                  onClick={toggleBookmarksBar}
                />
                <MenuBtn
                  icon={History}
                  label="history…"
                  onClick={openHistory}
                />
                <MenuBtn
                  icon={Download}
                  label="downloads…"
                  onClick={() => {
                    setMenuOpen(false);
                    openDl();
                  }}
                />
                <MenuSep />
                <MenuBtn
                  icon={Search}
                  label="find in page…"
                  hint="ctrl+f"
                  onClick={() => {
                    setMenuOpen(false);
                    openFind();
                  }}
                />
                <MenuBtn
                  icon={Copy}
                  label="duplicate tab"
                  disabled={activeIsNew}
                  onClick={() => {
                    setMenuOpen(false);
                    duplicateTab(activeRef.current);
                  }}
                />
                <MenuBtn
                  icon={ZoomIn}
                  label="zoom in"
                  value={`${Math.round((active?.zoom ?? 1) * 100)}%`}
                  onClick={() => setZoom((active?.zoom ?? 1) + 0.1)}
                />
                <MenuBtn icon={ZoomOut} label="zoom out" onClick={() => setZoom((active?.zoom ?? 1) - 0.1)} />
                <MenuBtn icon={RotateCcw} label="reset zoom" disabled={(active?.zoom ?? 1) === 1} onClick={() => setZoom(1)} />
                {onInstallApp && !activeIsNew && (
                  <>
                    <MenuSep />
                    <MenuBtn
                      icon={AppWindow}
                      label="install page as app"
                      title="adds this site to the dock"
                      onClick={installCurrent}
                    />
                  </>
                )}
                <MenuSep />
                <div className="px-1.5 pb-0.5 pt-0.5 font-mono text-[9px] leading-relaxed text-[var(--term-dim)]">
                  ctrl+t new tab · ctrl+w close tab
                  <br />
                  ctrl+l address · ctrl+shift+t reopen
                  <br />
                  ctrl+f find · ctrl +/-/0 zoom
                  <br />
                  alt+t new tab (inside pages)
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ---------- find in page ---------- */}
      {findOpen && (
        <form
          className={`flex shrink-0 items-center gap-1.5 border-b px-2 py-1 font-mono text-[11px] ${BORDER_FAINT}`}
          onSubmit={(e) => {
            e.preventDefault();
            findNext(1);
          }}
        >
          <Search size={11} className="shrink-0 text-[var(--term-dim)]" aria-hidden="true" />
          <input
            ref={findInputRef}
            value={findQ}
            onChange={(e) => {
              setFindQ(e.target.value);
              doFind(e.target.value, 0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                findNext(-1);
              }
            }}
            placeholder="find in page"
            spellCheck={false}
            aria-label="find in page"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--term-dim)]"
          />
          <span className="shrink-0 tabular-nums text-[var(--term-dim)]">{findQ ? (findCount ? `${findIdx + 1}/${findCount}` : "0/0") : ""}</span>
          <button type="button" className={BOX_BTN} onClick={() => findNext(-1)} title="previous match (shift+enter)" aria-label="previous match">
            <ChevronUp size={12} />
          </button>
          <button type="button" className={BOX_BTN} onClick={() => findNext(1)} title="next match (enter)" aria-label="next match">
            <ChevronDown size={12} />
          </button>
          <button type="button" className={BOX_BTN} onClick={closeFind} title="close (esc)" aria-label="close find bar">
            <X size={12} />
          </button>
        </form>
      )}

      {/* ---------- 2px loading bar ---------- */}
      <div
        className={`relative h-[2px] shrink-0 border-b border-[color-mix(in_srgb,var(--term-fg)_28%,transparent)] ${loading ? "nb-progress" : ""}`}
        aria-hidden="true"
      />

      {/* ---------- bookmarks bar ---------- */}
      {prefs.bookmarksBar && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[color-mix(in_srgb,var(--term-fg)_15%,transparent)] px-2 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {bookmarks.length === 0 ? (
            <span className="font-mono text-[9.5px] text-[var(--term-dim)]">no bookmarks — star a page</span>
          ) : (
            bookmarks.map((b) => (
              <button
                key={b.url}
                type="button"
                onClick={() => go(b.url)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    removeBookmark(b.url);
                    setBookmarks(loadBookmarks());
                  }
                }}
                title={`${b.url} — middle-click to remove`}
                className={`flex max-w-[170px] shrink-0 cursor-pointer items-center gap-1.5 border border-transparent px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--term-fg)] transition-colors hover:border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] hover:bg-[color-mix(in_srgb,var(--term-fg)_7%,transparent)]`}
              >
                <LetterTile text={b.url} size={12} />
                <span className="truncate">{b.label}</span>
              </button>
            ))
          )}
        </div>
      )}

      {/* ---------- content ---------- */}
      {state === "error" ? (
        <div className="murke-scroll flex flex-1 items-center justify-center overflow-auto p-5">
          <div className={`w-full max-w-md border ${BOX_BORDER} bg-[color-mix(in_srgb,var(--term-fg)_3%,transparent)] p-4 font-mono`}>
            <div className="text-[12px] font-bold lowercase text-[var(--term-err)]">proxy offline</div>
            <div className="mt-1.5 break-words text-[11px] leading-relaxed text-[var(--term-dim)]">
              {error || "the proxy engine failed to initialize"}
            </div>
            <div className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--term-dim)]">
              fix: run <span className="text-[var(--term-fg)]">proxy wisp &lt;url&gt;</span> in the terminal, then retry.
            </div>
            <button
              type="button"
              onClick={() => {
                setError("");
                setInitNonce((n) => n + 1);
              }}
              className={`mt-3 cursor-pointer border ${BOX_BORDER} px-3 py-1 text-[11px] text-[var(--term-fg)] transition-colors hover:border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)] hover:text-[var(--term-brand)]`}
            >
              retry init
            </button>
          </div>
        </div>
      ) : (
        <div className="relative flex-1 overflow-hidden bg-[var(--term-bg)]">
          {/* every tab's frame lives here; hidden ones just display:none */}
          <div ref={hostRef} className="absolute inset-0" />
          {activeIsSearch && state === "ok" && (
            <SearchPage q={displayUrl(active?.address ?? "")} onGo={go} />
          )}
          {activeIsNew && !activeIsSearch && state === "ok" && (
            <NewTabPage onGo={go} history={history} bookmarks={bookmarks} />
          )}
          {state === "init" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--term-bg)]">
              <div className="font-mono text-[11px] text-[var(--term-dim)]">
                connecting<span className="animate-pulse">…</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---------- status strip ---------- */}
      <footer
        className={`flex shrink-0 items-center justify-between gap-3 border-t ${BORDER_FAINT} px-2.5 py-[3px] font-mono text-[9.5px] text-[var(--term-dim)]`}
      >
        <span className="truncate">scramjet · relay + wisp auto-probe</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {loading && <span className="inline-block h-1.5 w-1.5 animate-pulse bg-[var(--term-brand)]" aria-hidden="true" />}
          {tabs.length} tab{tabs.length === 1 ? "" : "s"}
        </span>
      </footer>

      {/* ---------- tab context menu ---------- */}
      {tabCtx && (
        <div
          role="menu"
          aria-label="tab menu"
          className={`fixed z-[70] min-w-[150px] border ${BOX_BORDER} bg-[var(--term-bg)] p-1 font-mono shadow-[0_10px_32px_rgba(0,0,0,0.6)]`}
          style={{
            left: Math.min(tabCtx.x, (typeof window !== "undefined" ? window.innerWidth : 1280) - 170),
            top: Math.min(tabCtx.y, (typeof window !== "undefined" ? window.innerHeight : 800) - 110),
          }}
        >
          <MenuBtn
            icon={Copy}
            label="duplicate tab"
            onClick={() => {
              const id = tabCtx.id;
              setTabCtx(null);
              duplicateTab(id);
            }}
          />
          <MenuBtn
            icon={X}
            label="close tab"
            hint="ctrl+w"
            onClick={() => {
              const id = tabCtx.id;
              setTabCtx(null);
              closeTab(id);
            }}
          />
        </div>
      )}

      {/* ---------- history sheet ---------- */}
      {historyOpen && (
        <HistorySheet
          entries={history}
          onClose={() => setHistoryOpen(false)}
          onGo={(u) => {
            setHistoryOpen(false);
            go(u);
          }}
          onClear={() => {
            clearHistory();
            setHistory([]);
          }}
        />
      )}
    </div>
  );
}

/* ================= history sheet ================= */

function HistorySheet({
  entries,
  onClose,
  onGo,
  onClear,
}: {
  entries: HistoryEntry[];
  onClose: () => void;
  onGo: (url: string) => void;
  onClear: () => void;
}) {
  /* mounted fresh on every open (parent renders it conditionally), so the
   * filter + confirm state always starts clean without reset effects */
  const [q, setQ] = useState("");
  const [confirming, setConfirming] = useState(false);

  const needle = q.trim().toLowerCase();
  const list = needle
    ? entries.filter((h) => h.title.toLowerCase().includes(needle) || h.url.toLowerCase().includes(needle))
    : entries;

  return (
    <>
      <div className="absolute inset-0 z-[55]" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-label="history"
        className={`absolute bottom-0 right-0 top-0 z-[60] flex w-[min(22rem,92%)] flex-col border-l ${BOX_BORDER} bg-[var(--term-bg)] font-mono shadow-[-14px_0_40px_rgba(0,0,0,0.5)]`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[color-mix(in_srgb,var(--term-fg)_22%,transparent)] px-3 py-2">
          <span className="text-[10px] uppercase tracking-[0.3em] text-[var(--term-dim)]">
            history <span className="normal-case tracking-normal">· {entries.length}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="close history"
            className="cursor-pointer text-[var(--term-dim)] hover:text-[var(--term-fg)]"
          >
            <X size={12} />
          </button>
        </div>
        <div className="shrink-0 px-3 py-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
            placeholder="filter history…"
            spellCheck={false}
            aria-label="filter history"
            className={`w-full border ${BOX_BORDER} bg-transparent px-2 py-1.5 text-[11px] outline-none placeholder:text-[var(--term-dim)] focus:border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)]`}
          />
        </div>
        <div className="murke-scroll min-h-0 flex-1 overflow-y-auto">
          {list.length === 0 ? (
            <p className="px-3 py-3 text-[10.5px] text-[var(--term-dim)]">
              {entries.length === 0 ? "no history yet — go somewhere" : "no matches"}
            </p>
          ) : (
            list.map((h) => (
              <button
                key={`${h.ts}-${h.url}`}
                type="button"
                onClick={() => onGo(h.url)}
                title={h.url}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${ROW_HOVER}`}
              >
                <LetterTile text={h.url} size={14} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] text-[var(--term-fg)]">{h.title}</span>
                  <span className="block truncate text-[9.5px] text-[var(--term-dim)]">{h.url}</span>
                </span>
                <span className="shrink-0 text-[9px] text-[var(--term-dim)]">{timeAgo(h.ts)}</span>
              </button>
            ))
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[color-mix(in_srgb,var(--term-fg)_22%,transparent)] px-3 py-2">
          {confirming ? (
            <>
              <span className="text-[10.5px] text-[var(--term-err)]">clear all history?</span>
              <span className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    onClear();
                    setConfirming(false);
                  }}
                  className="cursor-pointer border border-[color-mix(in_srgb,var(--term-err)_50%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-err)] hover:bg-[color-mix(in_srgb,var(--term-err)_12%,transparent)]"
                >
                  yes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className={`cursor-pointer border ${BOX_BORDER} px-2 py-0.5 text-[10px] text-[var(--term-fg)] ${ROW_HOVER}`}
                >
                  no
                </button>
              </span>
            </>
          ) : (
            <>
              <span className="text-[9.5px] text-[var(--term-dim)]">{entries.length} entr{entries.length === 1 ? "y" : "ies"}</span>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={entries.length === 0}
                className={`cursor-pointer border ${BOX_BORDER} px-2 py-0.5 text-[10px] text-[var(--term-dim)] transition-colors hover:border-[color-mix(in_srgb,var(--term-err)_50%,transparent)] hover:text-[var(--term-err)] disabled:cursor-default disabled:opacity-40`}
              >
                clear history
              </button>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

/* ================= new tab — the simple page ================= */

/**
 * The ACTIVE tab's own initial page: the simple layout, promoted to be the
 * browser's home. One borderless glass pill over the wallpaper the window
 * already refracts, the engine picker on the globe, real-favicon quick
 * links, quiet history/bookmarks. No boxes, no noise, no chrome —
 * minimalism all the way down.
 */
function NewTabPage({
  onGo,
  history,
  bookmarks,
}: {
  onGo: (q: string) => void;
  history: HistoryEntry[];
  bookmarks: BookmarkEntry[];
}) {
  const [q, setQ] = useState("");
  const [engine, setEngine] = useState<TabEngine>(() => loadEngine());
  const [pickerOpen, setPickerOpen] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* focus the pill when it appears */
  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 80);
    return () => window.clearTimeout(t);
  }, []);

  /* engine picker: outside click dismisses */
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!pillRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [pickerOpen]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const s = q.trim();
    if (s) onGo(engineTarget(engine, s));
  };

  const pickEngine = (e: TabEngine) => {
    setEngine(e);
    setPickerOpen(false);
    try {
      localStorage.setItem(ENGINE_KEY, e.id);
    } catch {
      /* private mode — session-only then */
    }
    window.setTimeout(() => inputRef.current?.focus(), 40);
  };

  const EngineIcon = engine.icon;

  return (
    <div className="murke-scroll absolute inset-0 overflow-y-auto">
      {/* soft scrim for text legibility — the window's own glass already
          refracts the wallpaper behind everything */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background:
            "linear-gradient(to bottom, color-mix(in srgb, var(--term-bg) 2%, transparent), color-mix(in srgb, var(--term-bg) 26%, transparent) 55%, color-mix(in srgb, var(--term-bg) 44%, transparent))",
        }}
      />

      <div className="relative mx-auto flex min-h-full w-full max-w-2xl flex-col items-center px-4 pb-10 pt-[8vh] sm:pt-[10vh]">
        {/* wordmark — quiet */}
        <header className="mb-7 flex items-baseline gap-2" aria-label="murke browser">
          <span className="font-mono text-[12.5px] font-bold lowercase tracking-[0.34em] text-[color-mix(in_srgb,var(--term-fg)_70%,transparent)]">
            murke
          </span>
          <span className="font-mono text-[9.5px] text-[color-mix(in_srgb,var(--term-fg)_36%,transparent)]">
            {BROWSER_VERSION}
          </span>
        </header>

        {/* THE pill — the simple search, exactly as it lived */}
        <div ref={pillRef} className="relative w-[min(94%,560px)]">
          <form
            role="search"
            onSubmit={submit}
            className="flex items-center gap-2.5 rounded-[26px] py-2.5 pl-2.5 pr-2 shadow-[0_26px_80px_-22px_rgba(0,0,0,0.55)] transition-colors focus-within:shadow-[0_32px_90px_-20px_rgba(0,0,0,0.6)]"
            style={{
              background: "color-mix(in srgb, var(--term-fg) 6.5%, transparent)",
              backdropFilter: "blur(22px) saturate(1.45)",
              WebkitBackdropFilter: "blur(22px) saturate(1.45)",
              boxShadow: "0 26px 80px -22px rgba(0,0,0,0.55), inset 0 0 0 1px color-mix(in srgb, var(--term-fg) 13%, transparent)",
            }}
          >
            {/* engine — click the globe to pick where the words go */}
            <button
              type="button"
              onClick={() => setPickerOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              aria-label={`search engine: ${engine.label}`}
              title={`search with ${engine.label} — click to change`}
              className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--term-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_9%,transparent)] hover:text-[var(--term-fg)]"
            >
              <EngineIcon size={19} strokeWidth={1.75} aria-hidden="true" />
            </button>

            <input
              ref={inputRef}
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search the web"
              aria-label="search the web"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--term-fg)] outline-none placeholder:text-[color-mix(in_srgb,var(--term-fg)_38%,transparent)]"
            />

            <button
              type="submit"
              aria-label="search"
              title="search"
              className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--term-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_9%,transparent)] hover:text-[var(--term-fg)]"
            >
              <Search size={17} strokeWidth={2} aria-hidden="true" />
            </button>
          </form>

          {/* engine picker — a quiet glass menu under the pill */}
          {pickerOpen && (
            <div
              role="menu"
              aria-label="search engine"
              className="absolute left-0 top-full z-20 mt-3 w-56 overflow-hidden rounded-2xl p-1.5 shadow-[0_24px_70px_-16px_rgba(0,0,0,0.55)]"
              style={{
                background: "color-mix(in srgb, var(--term-bg) 82%, transparent)",
                backdropFilter: "blur(26px) saturate(1.5)",
                WebkitBackdropFilter: "blur(26px) saturate(1.5)",
                boxShadow: "0 24px 70px -16px rgba(0,0,0,0.55), inset 0 0 0 1px color-mix(in srgb, var(--term-fg) 12%, transparent)",
              }}
            >
              {ENGINES.map((e) => {
                const active = e.id === engine.id;
                const Icon = e.icon;
                return (
                  <button
                    key={e.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => pickEngine(e)}
                    className={`flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] transition-colors ${
                      active
                        ? "bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)] text-[var(--term-fg)]"
                        : "text-[color-mix(in_srgb,var(--term-fg)_74%,transparent)] hover:bg-[color-mix(in_srgb,var(--term-fg)_6%,transparent)]"
                    }`}
                  >
                    <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--term-dim)]" />
                    <span className="flex-1">{e.label}</span>
                    {active && <Check size={14} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-[var(--term-brand)]" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* quick links — themed letter tiles on quiet glass chips (no site
            favicons: they never matched the theme) */}
        <nav aria-label="quick links" className="mt-8 flex w-full flex-wrap items-center justify-center gap-1.5">
          {QUICK_LINKS.map((l) => (
            <button
              key={l.label}
              type="button"
              onClick={() => (l.label === "youtube" ? openWatch() : onGo(l.url))}
              title={l.label === "youtube" ? "open the watch app — youtube that works" : l.url}
              className="flex max-w-[160px] cursor-pointer items-center gap-2 rounded-full px-3 py-1.5 text-[11.5px] transition-all duration-150 hover:-translate-y-0.5"
              style={{
                background: "color-mix(in srgb, var(--term-fg) 5.5%, transparent)",
                boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--term-fg) 11%, transparent)",
              }}
            >
              <LetterTile text={l.label} size={14} />
              <span className="truncate text-[color-mix(in_srgb,var(--term-fg)_78%,transparent)]">{l.label}</span>
            </button>
          ))}
        </nav>

        {/* recent + bookmarks — two quiet text columns, only when non-empty */}
        {(history.length > 0 || bookmarks.length > 0) && (
          <div className="mt-10 grid w-full gap-6 sm:grid-cols-2">
            {history.length > 0 && (
              <section aria-label="recent history">
                <div className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[0.28em] text-[color-mix(in_srgb,var(--term-fg)_40%,transparent)]">
                  recent
                </div>
                <ul>
                  {history.slice(0, 5).map((h) => (
                    <li key={`${h.ts}-${h.url}`}>
                      <button
                        type="button"
                        onClick={() => onGo(h.url)}
                        title={h.url}
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${ROW_HOVER}`}
                      >
                        <LetterTile text={h.url} size={13} />
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[color-mix(in_srgb,var(--term-fg)_74%,transparent)]">
                          {h.title}
                        </span>
                        <span className="shrink-0 text-[9px] text-[color-mix(in_srgb,var(--term-fg)_38%,transparent)]">{timeAgo(h.ts)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {bookmarks.length > 0 && (
              <section aria-label="bookmarks">
                <div className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[0.28em] text-[color-mix(in_srgb,var(--term-fg)_40%,transparent)]">
                  bookmarks
                </div>
                <ul>
                  {bookmarks.slice(0, 5).map((b) => (
                    <li key={b.url}>
                      <button
                        type="button"
                        onClick={() => onGo(b.url)}
                        title={b.url}
                        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left ${ROW_HOVER}`}
                      >
                        <LetterTile text={b.url} size={13} />
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[color-mix(in_srgb,var(--term-fg)_74%,transparent)]">
                          {b.label}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {/* the single quiet hint line */}
        <footer className="mt-auto pt-10 font-mono text-[9px] text-[color-mix(in_srgb,var(--term-fg)_30%,transparent)]">
          ctrl+t new tab · ctrl+l address · duckduckgo served native
        </footer>
      </div>
    </div>
  );
}

/* ================= native duckduckgo results ================= */

interface DdgHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * The murke://search page — REAL DuckDuckGo results, fetched from OUR
 * server (/api/ddg scrapes ddg's own endpoints) and rendered natively.
 * Clicking a result opens it through the proxy like any other page.
 */
function SearchPage({ q, onGo }: { q: string; onGo: (u: string) => void }) {
  const [phase, setPhase] = useState<"load" | "ok" | "err">("load");
  const [results, setResults] = useState<DdgHit[]>([]);
  const [engine, setEngine] = useState("duckduckgo");
  const [err, setErr] = useState("");
  const [nonce, setNonce] = useState(0);
  const needle = q.trim();

  useEffect(() => {
    let dead = false;
    setPhase("load");
    setResults([]);
    setErr("");
    if (!needle) {
      setPhase("err");
      setErr("nothing to search");
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 22000);
    void (async () => {
      try {
        const res = await fetch(`/api/ddg?q=${encodeURIComponent(needle)}`, { cache: "no-store", signal: ctrl.signal });
        const j = (await res.json().catch(() => null)) as { ok?: boolean; results?: DdgHit[]; error?: string; engine?: string } | null;
        if (dead) return;
        if (!res.ok || !j?.ok) {
          setPhase("err");
          setErr(j?.error ?? "the search engine refused — try again in a moment");
          return;
        }
        setResults(Array.isArray(j.results) ? j.results : []);
        setEngine(typeof j.engine === "string" ? j.engine : "duckduckgo");
        setPhase("ok");
      } catch {
        if (!dead) {
          setPhase("err");
          setErr("search failed — try again in a moment");
        }
      } finally {
        window.clearTimeout(timer);
      }
    })();
    return () => {
      dead = true;
      ctrl.abort();
    };
  }, [needle, nonce]);

  return (
    <div className="murke-scroll absolute inset-0 overflow-y-auto bg-[var(--term-bg)]">
      <div className="mx-auto w-full max-w-3xl px-5 pb-12 pt-5">
        {/* header — engine, query, count */}
        <header className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5 font-mono text-[11px] font-bold lowercase tracking-[0.2em] text-[var(--term-brand)]">
            <Search size={13} aria-hidden="true" /> {engine === "fallback" ? "web search" : "duckduckgo"}
          </span>
          <span className="min-w-0 flex-1 truncate text-[15px] text-[var(--term-fg)]">{needle}</span>
          {phase === "ok" && (
            <span className="shrink-0 font-mono text-[10px] text-[var(--term-dim)]">
              {results.length} result{results.length === 1 ? "" : "s"}
              {engine === "fallback" ? " · ddg walled — platform search" : " · served native"}
            </span>
          )}
        </header>

        {phase === "load" && (
          <div className="space-y-5" aria-label="searching">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="animate-pulse space-y-1.5">
                <div className="h-2.5 w-2/5 rounded bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]" />
                <div className="h-2 w-4/5 rounded bg-[color-mix(in_srgb,var(--term-fg)_7%,transparent)]" />
                <div className="h-2 w-3/5 rounded bg-[color-mix(in_srgb,var(--term-fg)_5%,transparent)]" />
              </div>
            ))}
          </div>
        )}

        {phase === "err" && (
          <div className="rounded-xl border border-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] p-4">
            <p className="text-[12px] text-[var(--term-err)]">{err}</p>
            <button
              type="button"
              onClick={() => setNonce((n) => n + 1)}
              className={`mt-3 flex cursor-pointer items-center gap-1.5 rounded-full border ${BOX_BORDER} px-3 py-1 text-[11px] text-[var(--term-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)]`}
            >
              <RotateCw size={11} aria-hidden="true" /> retry
            </button>
          </div>
        )}

        {phase === "ok" && results.length === 0 && (
          <p className="text-[12px] text-[var(--term-dim)]">no results — try different words</p>
        )}

        {phase === "ok" && results.length > 0 && (
          <ol className="space-y-5">
            {results.map((r, i) => {
              let host = r.url;
              try {
                host = new URL(r.url).hostname.replace(/^www\./, "");
              } catch {
                /* keep raw */
              }
              return (
                <li key={`${i}-${r.url}`}>
                  <button
                    type="button"
                    onClick={() => onGo(r.url)}
                    title={r.url}
                    className="group block w-full cursor-pointer text-left"
                  >
                    <span className="mb-0.5 flex items-center gap-2">
                      <LetterTile text={host} size={14} />
                      <span className="truncate text-[11px] text-[var(--term-dim)]">{host}</span>
                    </span>
                    <span className="block truncate text-[14.5px] leading-snug text-[var(--term-fg)] group-hover:text-[var(--term-brand)] group-hover:underline underline-offset-2">
                      {r.title}
                    </span>
                    {r.snippet && (
                      <span className="mt-0.5 line-clamp-2 block text-[12px] leading-relaxed text-[var(--term-dim)]">
                        {r.snippet}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
