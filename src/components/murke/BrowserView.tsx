"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Home,
  Loader2,
  MoreVertical,
  PanelBottomClose,
  Plus,
  RotateCw,
  Search,
  X,
} from "lucide-react";
import type { ProxyEngine, ProxyFrameHandle, ThemeName, WispStatus } from "@/lib/murke/contracts";
import { LS, NEWTAB_URL } from "@/lib/murke/contracts";
import { THEMES, THEME_ORDER, isThemeName } from "@/lib/murke/themes";
import { getVfs } from "@/lib/murke/vfs";
import { fetchIntoVfs, formatBytes } from "@/lib/murke/fetch-file";

const PREFIX_RE = /^\/scramjet\//;

/** Cosmetic chrome version shown on the new-tab wordmark. */
const BROWSER_VERSION = "v2.1";

/** Boxy chrome tokens — sharp corners, hard 1px borders, zero rounding. */
const BOX_BORDER = "border-[color-mix(in_srgb,var(--term-fg)_28%,transparent)]";
const BOX_HOVER = "hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]";
const BOX_BTN =
  "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center border border-transparent text-[var(--term-fg)] transition-colors hover:border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] disabled:opacity-30 disabled:hover:border-transparent disabled:hover:bg-transparent";

/* TV-static noise tile, animated by shifting the tile in hard steps. */
const NOISE_CSS = `
.nb-noise{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");animation:nb-jitter .9s steps(6) infinite}
@keyframes nb-jitter{0%{background-position:0 0}16%{background-position:-42px 18px}33%{background-position:26px -36px}50%{background-position:-18px -24px}66%{background-position:38px 30px}83%{background-position:-30px 8px}100%{background-position:0 0}}
@media (prefers-reduced-motion:reduce){.nb-noise{animation:none}}
`;

/** Shared alt+` (exit) + alt+t (new tab) handler (top window + proxied frame windows). */
function frameKey(this: Window, e: KeyboardEvent) {
  if (e.altKey && (e.code === "Backquote" || e.key === "`")) {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("murke-close-browser"));
  } else if (e.altKey && (e.key === "t" || e.key === "T")) {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent("murke-browser-newtab"));
  }
}

/** Pin a proxy frame to the content area. Frames are absolutely stacked and
 *  shown/hidden via display — visibility is binary, never flow-dependent. */
function positionFrame(handle: ProxyFrameHandle): void {
  const s = handle.el.style;
  s.position = "absolute";
  s.inset = "0";
}

/** Decode a scramjet-routed URL back to something human readable.
 *  Frames report ABSOLUTE urls (http://thishost/scramjet/<encoded>) once
 *  navigation happens inside the frame — take whatever follows the LAST
 *  /scramjet/ marker and decode it once, so the omnibox shows the real
 *  target url instead of leaking the host origin. */
function displayUrl(u: string): string {
  if (!u) return "";
  if (u === NEWTAB_URL) return "";
  try {
    const marker = "/scramjet/";
    const idx = u.lastIndexOf(marker);
    const rest = idx >= 0 ? u.slice(idx + marker.length) : u.replace(PREFIX_RE, "");
    return decodeURIComponent(rest);
  } catch {
    return u;
  }
}

/** Short tab label: hostname of the (decoded) url. */
function tabTitle(u: string): string {
  if (!u || u === NEWTAB_URL) return "new tab";
  const shown = displayUrl(u);
  try {
    return new URL(shown).hostname.replace(/^www\./, "") || "new tab";
  } catch {
    return shown.slice(0, 24) || "new tab";
  }
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

/** Tab = pure data. The imperative frames live in framesRef so React
 *  state never holds DOM handles. url === "" (or NEWTAB_URL) = new tab page. */
interface Tab {
  id: number;
  /** last known url (scramjet-encoded or target) */
  url: string;
  /** what the address bar shows */
  address: string;
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
  /** Show only `activeId`'s frame (pass a foreign id to hide them all). */
  toggleAll(activeId: number): void {
    for (const [tid, handle] of this.map) {
      handle.el.style.display = tid === activeId ? "" : "none";
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

function readFrameless(): boolean {
  try {
    return localStorage.getItem(LS.frameless) === "1";
  } catch {
    return false;
  }
}

function writeFrameless(v: boolean): void {
  try {
    localStorage.setItem(LS.frameless, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/**
 * Browser takeover — a REAL browser chrome, boxy edition: hard corners,
 * hard borders. tab strip (tabs + plus) → toolbar (back fwd reload home |
 * omnibox | menu) → content (boxy new-tab page or the proxied frame) →
 * status bar. The ⋮ menu owns themes, crt/sound, FRAMELESS and pop-out.
 * Frameless hides every strip: the site IS the screen; hovering the top
 * edge reveals a slim recover bar. Alt+` returns to dsh; ✕ always does.
 */
export default function BrowserView({
  url,
  proxy,
  sound,
  crt,
  setCrt,
  theme,
  setTheme,
  onClose,
}: {
  url: string;
  proxy: ProxyEngine;
  sound: SoundLike;
  crt: boolean;
  setCrt: (v: boolean) => void;
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const initial = url === NEWTAB_URL ? "" : url;
  const [tabs, setTabs] = useState<Tab[]>([{ id: 1, url: initial, address: initial }]);
  const [activeId, setActiveId] = useState(1);
  const [state, setState] = useState<"init" | "ok" | "error">("init");
  const [error, setError] = useState<string>("");
  const [draft, setDraft] = useState(displayUrl(initial));
  const [sndOn, setSndOn] = useState(sound.enabled);
  const [menuOpen, setMenuOpen] = useState(false);
  /** download popover: pull the current page (or any url) into ~/Downloads */
  const [dlOpen, setDlOpen] = useState(false);
  const dlOpenRef = useRef(false);
  useEffect(() => {
    dlOpenRef.current = dlOpen;
  }, [dlOpen]);
  const [dlUrl, setDlUrl] = useState("");
  const [dlState, setDlState] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [dlMsg, setDlMsg] = useState("");
  const [frameless, setFrameless] = useState<boolean>(() => readFrameless());
  /** frameless: the recover bar shows while the pointer stalks the top edge */
  const [reveal, setReveal] = useState(false);
  const nextIdRef = useRef(2);
  /** tabId -> live frame (never in React state) */
  const frames = useMemo(() => new FrameStore(), []);
  /** latest tab list / active id for listeners (synced post-render) */
  const tabsRef = useRef<Tab[]>(tabs);
  const activeRef = useRef(activeId);
  useEffect(() => {
    tabsRef.current = tabs;
    activeRef.current = activeId;
  });

  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const activeIsNew = !active?.address;

  /** run the download: stream the url through /api/fetch-file into the fs */
  const runDownload = useCallback(
    async (rawUrl: string) => {
      const target = rawUrl.trim();
      if (!target) return;
      setDlState("busy");
      setDlMsg("");
      try {
        const meta = await fetchIntoVfs(target, getVfs(), { dir: "~/Downloads" });
        setDlState("ok");
        setDlMsg(`${meta.name} — ${formatBytes(meta.size)}`);
      } catch (e) {
        setDlState("err");
        setDlMsg(e instanceof Error ? e.message : "download failed");
      }
    },
    [],
  );

  const patchTab = useCallback((id: number, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  /* INVARIANT: a tab with no url IS the new-tab page — it must never sit on
   * top of a live frame. Whenever the active tab is a new tab, every frame
   * hides. (This is the overlay bug: newTab() used to flip activeId without
   * hiding the previous tab's iframe, so the old page stayed visible under
   * the new-tab page.) */
  useEffect(() => {
    if (activeIsNew) frames.toggleAll(activeId);
  }, [activeIsNew, activeId, frames]);

  /* The omnibox always reflects the ACTIVE tab — unless the user is mid-edit
   * (input focused), in which case their draft is left alone. */
  const omniboxRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = omniboxRef.current;
    if (el && document.activeElement === el) return;
    setDraft(tabs.find((t) => t.id === activeId)?.address ?? "");
  }, [tabs, activeId]);

  /** wire a frame's onUrl so tab title + address follow navigation */
  const attachUrlListener = useCallback(
    (tabId: number, handle: ProxyFrameHandle) => {
      handle.onUrl((u) => {
        patchTab(tabId, { url: u, address: displayUrl(u) });
      });
    },
    [patchTab],
  );

  /* ---------- mount: init proxy, build the first frame ---------- */

  useEffect(() => {
    let dead = false;
    (async () => {
      const r = await proxy.init();
      if (dead) return;
      if (!r.ok) {
        setError(r.error ?? "proxy failed to initialize");
        setState("error");
        return;
      }
      try {
        const first = tabsRef.current[0];
        if (first.address) {
          const handle = proxy.createFrame();
          positionFrame(handle);
          attachUrlListener(first.id, handle);
          if (hostRef.current && !hostRef.current.contains(handle.el)) {
            hostRef.current.appendChild(handle.el);
          }
          frames.set(first.id, handle);
          handle.go(first.url);
        }
        setState("ok");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    })();
    return () => {
      dead = true;
      frames.clear();
    };
  }, [proxy, attachUrlListener, frames]);

  /* ---------- frame creation for lazy tabs ---------- */

  const ensureFrame = useCallback(
    (tabId: number): ProxyFrameHandle | null => {
      const existing = frames.get(tabId);
      if (existing) return existing;
      if (state !== "ok") return null;
      const handle = proxy.createFrame();
      positionFrame(handle);
      attachUrlListener(tabId, handle);
      if (hostRef.current && !hostRef.current.contains(handle.el)) {
        hostRef.current.appendChild(handle.el);
      }
      // new frames start hidden unless they belong to the active tab
      if (tabId !== activeRef.current) handle.el.style.display = "none";
      frames.set(tabId, handle);
      return handle;
    },
    [proxy, state, attachUrlListener, frames],
  );

  /* ---------- navigation ---------- */

  const go = useCallback(
    (raw: string) => {
      const s = raw.trim();
      if (!s) return;
      const looksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+/i.test(s);
      const target = looksUrl
        ? /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
          ? s
          : "https://" + s
        : "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(s);
      const id = activeRef.current;
      const handle = ensureFrame(id);
      if (!handle) return;
      setState("ok");
      patchTab(id, { url: target, address: target });
      handle.go(target);
      if (handle.el.style.display === "none") handle.el.style.display = "";
      frames.toggleAll(id); // hide every other frame, reveal this one
      sound.key();
    },
    [ensureFrame, patchTab, frames, sound],
  );

  /** back to the new-tab page: hide the frame, blank the tab */
  const goHome = useCallback(() => {
    const id = activeRef.current;
    const handle = frames.get(id);
    if (handle) handle.el.style.display = "none";
    patchTab(id, { url: "", address: "" });
    setDraft("");
    sound.key();
  }, [frames, patchTab, sound]);

  /* ---------- tab lifecycle ---------- */

  const newTab = useCallback(() => {
    const id = nextIdRef.current++;
    setTabs((prev) => [...prev, { id, url: "", address: "" }]);
    // the new tab is its OWN page — hide the previous tab's frame right now,
    // otherwise the old site stays painted underneath the new-tab page
    frames.toggleAll(id);
    setActiveId(id);
    setDraft("");
    sound.key();
  }, [sound, frames]);

  const closeTab = useCallback(
    (id: number) => {
      frames.remove(id);
      const rest = tabsRef.current.filter((t) => t.id !== id);
      if (rest.length === 0) {
        onClose();
        return;
      }
      const nextActive = activeRef.current === id ? rest[rest.length - 1].id : activeRef.current;
      setTabs(rest);
      if (nextActive !== activeRef.current) {
        frames.toggleAll(nextActive);
        setActiveId(nextActive);
      }
      sound.key();
    },
    [onClose, sound, frames],
  );

  const switchTab = useCallback(
    (id: number) => {
      if (id === activeRef.current) return;
      frames.toggleAll(id);
      setActiveId(id);
      sound.key();
    },
    [sound, frames],
  );

  /* ---------- alt+` close, alt+t new tab, everywhere ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.code === "Backquote" || e.key === "`")) {
        e.preventDefault();
        onClose();
      } else if (e.altKey && (e.key === "t" || e.key === "T")) {
        e.preventDefault();
        newTab();
      } else if (e.key === "Escape" && menuOpen) {
        setMenuOpen(false);
      } else if (e.key === "Escape" && dlOpenRef.current) {
        setDlOpen(false);
      }
    };
    const onCustom = () => onClose();
    const onCustomNewTab = () => newTab();
    window.addEventListener("keydown", onKey);
    window.addEventListener("murke-close-browser", onCustom);
    window.addEventListener("murke-browser-newtab", onCustomNewTab);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("murke-close-browser", onCustom);
      window.removeEventListener("murke-browser-newtab", onCustomNewTab);
    };
  }, [onClose, menuOpen, newTab]);

  /* re-attach alt+` into every frame periodically (a fresh document drops
     listeners). Runs once: the interval sweep finds new frames on its own,
     and effect re-runs were the crash — the cleanup touches Windows that
     turned cross-origin once their frame was removed. */
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

  /* The sw's PROXY FAULT page postMessages its parent. On a fault we make
   * the engine forget its cached transport and re-probe everything — if
   * another transport is healthy the frame reload lands on it, and the
   * user never sees a second fault page. */
  const faultRef = useRef<{ url: string; at: number } | null>(null);
  useEffect(() => {
    let busy = false;
    const onMsg = (e: MessageEvent) => {
      try {
        if (e.origin !== window.location.origin) return;
        const d = e.data as { __murkeProxyFault?: boolean; url?: string } | null;
        if (!d || d.__murkeProxyFault !== true) return;
        const url = d.url ?? "";
        const last = faultRef.current;
        // one heal per url per 10s — the retry link covers stubborn cases
        if (last && last.url === url && Date.now() - last.at < 10_000) return;
        faultRef.current = { url, at: Date.now() };
        if (busy) return;
        busy = true;
        void (async () => {
          try {
            if (typeof proxy.revalidate === "function") await proxy.revalidate();
            // reload the frame that faulted; unknown url → the active one
            let target = url ? frames.all().find((h) => h.getUrl() === url) : undefined;
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

  /* ---------- address bar ---------- */

  const startEditing = () => {
    setDraft(active?.address ?? "");
  };

  const onAddressKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
      go(draft);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(active?.address ?? "");
      (e.target as HTMLInputElement).blur();
    } else {
      if (e.key === " ") sound.space();
      else if (e.key === "Backspace") sound.backspace();
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) sound.key();
    }
  };

  const popOut = () => {
    const handle = frames.get(activeRef.current);
    const u = handle?.getUrl() || active?.url;
    if (u && u !== NEWTAB_URL) window.open(u, "_blank", "noopener");
    setMenuOpen(false);
  };

  const toggleFrameless = useCallback(() => {
    setFrameless((v) => {
      writeFrameless(!v);
      return !v;
    });
    setMenuOpen(false);
    setReveal(false);
    sound.key();
  }, [sound]);

  /* ---------- shared toolbar row (used by framed chrome + frameless bar) ---------- */

  const toolbar = (compact: boolean) => (
    <>
      <button className={BOX_BTN} onClick={() => frames.get(activeId)?.back()} title="back" aria-label="back">
        <ChevronLeft size={15} />
      </button>
      <button className={BOX_BTN} onClick={() => frames.get(activeId)?.forward()} title="forward" aria-label="forward">
        <ChevronRight size={15} />
      </button>
      <button className={BOX_BTN} onClick={() => frames.get(activeId)?.reload()} title="reload" aria-label="reload">
        <RotateCw size={13} />
      </button>
      <button className={BOX_BTN} onClick={goHome} title="new tab page" aria-label="home">
        <Home size={13} />
      </button>

      {/* omnibox */}
      <div
        className={`mx-1 flex min-w-0 flex-1 items-center gap-2 border ${BOX_BORDER} bg-[color-mix(in_srgb,var(--term-fg)_5%,transparent)] px-2 py-1 focus-within:border-[color-mix(in_srgb,var(--term-brand)_65%,transparent)]`}
      >
        <Search size={11} className="shrink-0 text-[var(--term-dim)]" aria-hidden="true" />
        <input
          ref={omniboxRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={startEditing}
          onKeyDown={onAddressKeyDown}
          placeholder={state === "init" ? "connecting…" : "search or type a url"}
          spellCheck={false}
          aria-label="browser address"
          className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)]"
        />
      </div>

      {/* download — pull a file into the file manager */}
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => {
            setDlOpen((v) => {
              if (!v) {
                // prefill with the page the user is actually on
                const current = active?.address ?? "";
                setDlUrl(current && current !== NEWTAB_URL ? current : "");
                setDlState("idle");
                setDlMsg("");
              }
              setMenuOpen(false);
              return !v;
            });
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
            <div className="fixed inset-0 z-40" onClick={() => setDlOpen(false)} aria-hidden="true" />
            <div
              className={`absolute right-0 top-8 z-50 w-72 border ${BOX_BORDER} bg-[var(--term-bg)] p-2.5 font-mono shadow-[0_10px_34px_rgba(0,0,0,0.65)]`}
              role="dialog"
              aria-label="download file"
            >
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
                  void runDownload(dlUrl);
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
                <button
                  type="submit"
                  disabled={dlState === "busy" || !dlUrl.trim()}
                  className="mt-1.5 flex w-full cursor-pointer items-center justify-center gap-2 border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] py-1.5 text-[11px] hover:bg-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] disabled:opacity-40"
                >
                  {dlState === "busy" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                  {dlState === "busy" ? "fetching…" : "fetch into files"}
                </button>
              </form>
              {dlMsg && (
                <p className={`mt-1.5 break-all text-[10.5px] ${dlState === "err" ? "text-[var(--term-err)]" : "text-[var(--term-fg)]"}`}>
                  {dlState === "ok" ? "↓ " : ""}
                  {dlMsg}
                </p>
              )}
              {dlState === "ok" && <p className="mt-0.5 text-[10px] text-[var(--term-dim)]">open the file manager: run `files` in the shell</p>}
            </div>
          </>
        )}
      </div>

      {/* menu */}
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          title="menu"
          aria-label="browser menu"
          aria-expanded={menuOpen}
          className={`${BOX_BTN} ${menuOpen ? "border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]" : ""}`}
        >
          <MoreVertical size={15} />
        </button>
        {menuOpen && (
          <>
            {/* click-away layer */}
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden="true" />
            <div
              className={`absolute right-0 top-8 z-50 w-60 border ${BOX_BORDER} bg-[var(--term-bg)] p-2 font-mono shadow-[0_10px_34px_rgba(0,0,0,0.65)]`}
            >
              <div className="px-1 pb-1 text-[9.5px] uppercase tracking-widest text-[var(--term-dim)]">theme</div>
              <div className="flex flex-wrap gap-1 px-1 pb-2">
                {THEME_ORDER.map((t) => (
                  <button
                    key={t}
                    type="button"
                    title={THEMES[t].label}
                    aria-label={`theme ${t}`}
                    aria-pressed={theme === t}
                    onClick={() => {
                      if (isThemeName(t)) setTheme(t);
                      sound.key();
                    }}
                    className={`h-4 w-4 cursor-pointer border transition-transform hover:scale-110 ${
                      theme === t ? "border-[var(--term-fg)]" : "border-transparent"
                    }`}
                    style={{ backgroundColor: THEMES[t].brand }}
                  />
                ))}
              </div>
              <div className={`border-t ${BORDER_FAINT} pt-1`} />
              <MenuRow
                label="key sounds"
                value={sndOn ? "on" : "off"}
                onClick={() => {
                  sound.setEnabled(!sound.enabled);
                  setSndOn(sound.enabled);
                }}
              />
              <MenuRow label="crt scanlines" value={crt ? "on" : "off"} onClick={() => setCrt(!crt)} />
              <MenuRow
                label="frameless"
                value={frameless ? "on" : "off"}
                onClick={toggleFrameless}
                title="hide all chrome — the site is the screen (hover the top edge to get the bar back)"
              />
              <div className={`border-t ${BORDER_FAINT} pt-1`} />
              <button
                type="button"
                onClick={popOut}
                disabled={!active?.address}
                className="flex w-full cursor-pointer items-center gap-2 px-1.5 py-1 text-left text-[11px] text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] disabled:opacity-40"
              >
                <ExternalLink size={12} /> pop out this tab
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex w-full cursor-pointer items-center gap-2 px-1.5 py-1 text-left text-[11px] text-[var(--term-err)] hover:bg-[color-mix(in_srgb,var(--term-err)_10%,transparent)]"
              >
                <X size={12} /> close browser
              </button>
              {compact && (
                <button
                  type="button"
                  onClick={toggleFrameless}
                  className="mt-1 flex w-full cursor-pointer items-center gap-2 border-t border-transparent px-1.5 py-1 text-left text-[11px] text-[var(--term-dim)] hover:text-[var(--term-fg)]"
                >
                  <PanelBottomClose size={12} /> leave frameless
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* close — the corner ✕, always within reach */}
      <button
        type="button"
        onClick={onClose}
        title="close browser (alt+`)"
        aria-label="close browser"
        className={`${BOX_BTN} text-[var(--term-err)] hover:border-[color-mix(in_srgb,var(--term-err)_45%,transparent)] hover:bg-[color-mix(in_srgb,var(--term-err)_10%,transparent)]`}
      >
        <X size={15} />
      </button>
    </>
  );

  return (
    <div className="fixed inset-x-0 top-7 bottom-0 z-50 flex flex-col bg-[var(--term-bg)]" role="dialog" aria-label="proxied browser">
      {!frameless && (
        <>
          {/* ---------- tab strip ---------- */}
          <div className="flex shrink-0 items-end gap-1 overflow-x-auto px-2 pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {tabs.map((t) => {
              const isActive = t.id === activeId;
              return (
                <div
                  key={t.id}
                  className={`group flex max-w-[200px] min-w-[120px] shrink-0 items-center gap-1 border px-2 py-1.5 text-[11px] ${
                    isActive
                      ? `border-[color-mix(in_srgb,var(--term-brand)_50%,transparent)] border-b-transparent bg-[color-mix(in_srgb,var(--term-brand)_10%,transparent)] text-[var(--term-fg)]`
                      : `border-transparent text-[var(--term-dim)] hover:border-[color-mix(in_srgb,var(--term-fg)_18%,transparent)] hover:text-[var(--term-fg)]`
                  }`}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0"
                    style={{ backgroundColor: t.address ? "var(--term-brand)" : "var(--term-dim)" }}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    onClick={() => switchTab(t.id)}
                    title={t.address || "new tab"}
                    className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono"
                  >
                    {tabTitle(t.url)}
                  </button>
                  <button
                    type="button"
                    onClick={() => closeTab(t.id)}
                    aria-label={`close tab ${tabTitle(t.url)}`}
                    className="cursor-pointer px-0.5 opacity-40 transition-opacity hover:bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)] hover:opacity-100 group-hover:opacity-70"
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={newTab}
              aria-label="new tab"
              title="new tab"
              className="mb-0.5 flex shrink-0 cursor-pointer items-center border border-transparent px-1.5 py-1 text-[var(--term-dim)] transition-colors hover:border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] hover:text-[var(--term-fg)]"
            >
              <Plus size={13} />
            </button>
          </div>

          {/* ---------- toolbar ---------- */}
          <div className={`flex shrink-0 items-center gap-1 border-b ${BOX_BORDER} px-2 py-1.5`}>
            {toolbar(false)}
          </div>
        </>
      )}

      {/* ---------- frameless: hover the top edge, the bar drops in ---------- */}
      {frameless && (
        <div className="absolute inset-x-0 top-0 z-40 h-2" onMouseEnter={() => setReveal(true)} aria-hidden="true" />
      )}
      {frameless && reveal && (
        <div
          className={`absolute inset-x-0 top-0 z-50 flex items-center gap-1 border-b ${BOX_BORDER} bg-[var(--term-bg)] px-2 py-1.5 shadow-[0_6px_24px_rgba(0,0,0,0.55)]`}
          onMouseLeave={() => setReveal(false)}
        >
          <span className="mr-1 shrink-0 font-mono text-[11px] font-bold lowercase tracking-[0.25em] text-[var(--term-brand)]" title="murke proxy">
            murke
          </span>
          {toolbar(true)}
          <button
            type="button"
            onClick={toggleFrameless}
            title="leave frameless"
            aria-label="leave frameless"
            className={BOX_BTN}
          >
            <PanelBottomClose size={14} />
          </button>
        </div>
      )}

      {/* ---------- content ---------- */}
      {state === "error" ? (
        <div className="murke-scroll flex flex-1 flex-col items-center justify-center gap-2 overflow-auto p-5 text-center">
          <div className="font-mono text-[13px] font-bold text-[var(--term-err)]">proxy offline</div>
          <div className="max-w-[64ch] font-mono text-[11px] leading-relaxed text-[var(--term-dim)]">{error}</div>
          <div className="max-w-[64ch] font-mono text-[11px] leading-relaxed text-[var(--term-dim)]">
            fix: <span className="text-[var(--term-fg)]">proxy wisp &lt;wisp-url&gt;</span> from the terminal — or open
            the new tab page and set a transport in settings, then retry
          </div>
        </div>
      ) : (
        <div className="relative flex-1 overflow-hidden bg-[var(--term-bg)]">
          {/* every tab's frame lives here; hidden ones just display:none */}
          <div ref={hostRef} className="absolute inset-0" />
          {activeIsNew && state === "ok" && (
            <NewTabPage
              onGo={go}
              onExit={onClose}
              proxy={proxy}
              frameless={frameless}
              onFrameless={toggleFrameless}
            />
          )}
          {state === "init" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--term-bg)]">
              <div className="font-mono text-[11px] text-[var(--term-dim)]">connecting…</div>
            </div>
          )}
        </div>
      )}

      {/* ---------- status bar ---------- */}
      {!frameless && (
        <div
          className={`flex shrink-0 items-center justify-between gap-3 border-t ${BORDER_FAINT} px-3 py-1 font-mono text-[9.5px] text-[var(--term-dim)]`}
        >
          <span className="truncate">scramjet · relay+wisp auto-probe — alt+` returns</span>
          <span className="shrink-0">
            {tabs.length} tab{tabs.length === 1 ? "" : "s"}
          </span>
        </div>
      )}
    </div>
  );
}

/* ================= menu row ================= */

const BORDER_FAINT = "border-[color-mix(in_srgb,var(--term-fg)_15%,transparent)]";

function MenuRow({
  label,
  value,
  onClick,
  title,
}: {
  label: string;
  value: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={value === "on"}
      title={title}
      className="flex w-full cursor-pointer items-center justify-between px-1.5 py-1 text-left text-[11px] text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)]"
    >
      <span>{label}</span>
      <span className="text-[var(--term-dim)]">{value}</span>
    </button>
  );
}

/* ================= new tab page ================= */

const NOISE_TILE =
  "relative isolate overflow-hidden bg-[color-mix(in_srgb,var(--term-fg)_4%,transparent)]";

/**
 * Boxy new tab — the ACTIVE tab's own initial page (it is tab state, never an
 * overlay): murke // browser wordmark + live transport chip, boxed clock with
 * seconds, centered duckduckgo search (the lite endpoint — the one path that
 * renders through every transport), a quick-link grid that navigates THIS tab,
 * compact transport settings (wisp override / frameless) and key hints.
 * Solid background (frames live under it), theme colored, crisp mono, no
 * gradients, no emojis.
 */
function NewTabPage({
  onGo,
  onExit,
  proxy,
  frameless,
  onFrameless,
}: {
  onGo: (q: string) => void;
  onExit: () => void;
  proxy: ProxyEngine;
  frameless: boolean;
  onFrameless: () => void;
}) {
  const [now, setNow] = useState(() => new Date());
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<WispStatus | null>(null);
  const [override, setOverride] = useState(() => {
    try {
      return localStorage.getItem(LS.wisp) ?? "";
    } catch {
      return "";
    }
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const iv = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(iv);
  }, []);

  /* live transport status (the engine caches, so this is cheap) */
  useEffect(() => {
    let dead = false;
    const run = () => {
      void proxy
        .status()
        .then((s) => {
          if (!dead) setStatus(s);
        })
        .catch(() => undefined);
    };
    run();
    const iv = window.setInterval(run, 8000);
    return () => {
      dead = true;
      window.clearInterval(iv);
    };
  }, [proxy]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (q.trim()) onGo(q.trim());
  };

  const applyOverride = () => {
    setSaving(true);
    proxy.setWispOverride(override.trim() || null);
    // let the engine forget the old winner, then re-probe
    window.setTimeout(() => {
      void proxy
        .status()
        .then((s) => setStatus(s))
        .finally(() => setSaving(false));
    }, 50);
  };

  const boxHead = "border-b border-[color-mix(in_srgb,var(--term-fg)_22%,transparent)] px-3 py-1.5 text-[10px] uppercase tracking-[0.3em] text-[var(--term-dim)]";

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");

  return (
    <div className="murke-scroll absolute inset-0 overflow-y-auto bg-[var(--term-bg)]">
      <style>{NOISE_CSS}</style>
      {/* faint tv-static glued to the viewport — no gradients, barely there */}
      <div className="nb-noise pointer-events-none fixed inset-0 opacity-[0.05]" aria-hidden="true" />
      <div className="relative mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4 px-4 py-6 sm:py-10">
        {/* wordmark + live transport chip */}
        <header className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-[12.5px] font-bold lowercase tracking-[0.3em] text-[var(--term-brand)]">
            murke <span className="text-[var(--term-dim)]">{"//"}</span> browser
            <span className="ml-2 align-middle font-normal tracking-normal text-[var(--term-dim)] text-[9.5px]">
              {BROWSER_VERSION}
            </span>
          </span>
          <span
            className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--term-dim)]"
            aria-label="proxy transport status"
          >
            {status?.ok ? (
              <>
                <span className="mr-1.5 inline-block h-1.5 w-1.5 bg-[var(--term-brand)]" aria-hidden="true" />
                <span className="text-[var(--term-fg)]">{status.transport ?? "relay"}</span>
                {typeof status.latencyMs === "number" ? ` · ${status.latencyMs}ms` : ""}
              </>
            ) : (
              "transport probing…"
            )}
          </span>
        </header>

        {/* clock — big, crisp, seconds dimmed */}
        <section className={`border ${BOX_BORDER} px-4 py-8 text-center ${NOISE_TILE} sm:py-10`} aria-label="clock">
          <div
            className="font-mono text-5xl font-bold tabular-nums tracking-tight text-[var(--term-fg)] sm:text-7xl"
            role="timer"
            aria-label="current time"
          >
            {hh}
            <span className="text-[var(--term-dim)]">:</span>
            {mm}
            <span className="text-[var(--term-dim)]">:{ss}</span>
          </div>
          <div className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.4em] text-[var(--term-dim)]">
            {now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
          </div>
        </section>

        {/* search — the hero; enter routes through the proxy (ddg lite for terms) */}
        <form onSubmit={submit} role="search" className={`border ${BOX_BORDER} ${NOISE_TILE}`}>
          <div className={boxHead}>search · duckduckgo</div>
          <div className="flex items-center gap-2 px-3 py-3">
            <Search size={14} className="shrink-0 text-[var(--term-dim)]" aria-hidden="true" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="search the web or type a url — enter to go"
              spellCheck={false}
              aria-label="search or url"
              className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[var(--term-fg)] outline-none placeholder:text-[color-mix(in_srgb,var(--term-fg)_30%,transparent)]"
            />
            <button
              type="submit"
              className={`shrink-0 cursor-pointer border ${BOX_BORDER} px-3 py-1 font-mono text-[11px] text-[var(--term-fg)] transition-colors hover:border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)] hover:text-[var(--term-brand)]`}
            >
              go_
            </button>
          </div>
        </form>

        {/* quick links — square tiles, label + hostname; each navigates THIS tab */}
        <nav aria-label="quick links" className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {QUICK_LINKS.map((l) => (
            <button
              key={l.label}
              type="button"
              onClick={() => onGo(l.url)}
              title={l.url}
              className={`cursor-pointer border ${BOX_BORDER} px-2.5 py-2 text-left font-mono transition-colors hover:border-[color-mix(in_srgb,var(--term-brand)_55%,transparent)] hover:bg-[color-mix(in_srgb,var(--term-brand)_10%,transparent)]`}
            >
              <span className="block truncate text-[11.5px] text-[var(--term-fg)]">{l.label}</span>
              <span className="block truncate text-[9px] text-[var(--term-dim)]">{l.host}</span>
            </button>
          ))}
        </nav>

        {/* transport settings — compact */}
        <section className={`border ${BOX_BORDER} ${NOISE_TILE}`} aria-label="proxy transport settings">
          <div className={boxHead}>proxy transport</div>
          <div className="flex flex-col gap-2 px-3 py-2.5 font-mono text-[11px]">
            <div className="flex items-center gap-2">
              <span className={`shrink-0 border ${BOX_BORDER} px-1.5 py-0.5 text-[10px] text-[var(--term-dim)]`}>
                {status?.ok ? (status.transport ?? "relay") : "offline"}
              </span>
              <span className="min-w-0 flex-1 truncate text-[var(--term-dim)]">
                {status?.ok ? status.wispUrl : (status?.error ?? "probing relay, then wisp…")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={override}
                onChange={(e) => setOverride(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyOverride();
                  }
                }}
                placeholder="wss://your-wisp-server/wisp/  (empty = auto-probe)"
                spellCheck={false}
                aria-label="wisp transport override"
                className="min-w-0 flex-1 border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] bg-transparent px-2 py-1 text-[var(--term-fg)] outline-none placeholder:text-[color-mix(in_srgb,var(--term-fg)_28%,transparent)] focus:border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)]"
              />
              <button
                type="button"
                onClick={applyOverride}
                disabled={saving}
                className={`shrink-0 cursor-pointer border ${BOX_BORDER} px-2.5 py-1 text-[11px] text-[var(--term-fg)] transition-colors hover:border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)] hover:text-[var(--term-brand)] disabled:opacity-50`}
              >
                {saving ? "…" : "set"}
              </button>
              <button
                type="button"
                onClick={onFrameless}
                aria-pressed={frameless}
                title="frameless — hide all chrome, the site is the screen"
                className={`shrink-0 cursor-pointer border px-2.5 py-1 text-[11px] transition-colors ${
                  frameless
                    ? "border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)] text-[var(--term-brand)]"
                    : `${BOX_BORDER} text-[var(--term-dim)] hover:text-[var(--term-fg)]`
                }`}
              >
                frameless:{frameless ? "on" : "off"}
              </button>
            </div>
            <p className="text-[9.5px] leading-relaxed text-[var(--term-dim)]">
              auto-probe: same-origin relay (test-forwarded first) → gateway wisp → public mercury wisp. pin any
              wisp:// ws:// wss:// url to skip the probe.
            </p>
          </div>
        </section>

        {/* hints + exit */}
        <footer className="flex flex-wrap items-center justify-between gap-2 font-mono text-[9.5px] text-[var(--term-dim)]">
          <span>
            alt+` exit · alt+t new tab · scramjet over relay / wisp
          </span>
          <button
            type="button"
            onClick={onExit}
            className="cursor-pointer transition-colors hover:text-[var(--term-fg)]"
          >
            [exit to dsh]
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Structural subset of SoundEngine so the toolbar can toggle + chirp. */
interface SoundLike {
  readonly enabled: boolean;
  setEnabled(v: boolean): void;
  key(): void;
  space(): void;
  enter(): void;
  backspace(): void;
}
