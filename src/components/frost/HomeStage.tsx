"use client";

/**
 * HomeStage — the Frost home and its tabbed browsing world.
 *
 * The home is 1:1 with home.html: the wallpaper backdrop, the glass pill
 * search bar (engine logo → slide-in engine picker → field → magnifier),
 * the shortcut row under it, the white context menus, the first-boot tip.
 * Browsing is TABS now: every tab owns one persistent scramjet frame
 * (hidden while inactive — switching is instant, state survives), the
 * active tab fills the screen borderless with the floating corner chrome:
 * nav trio · the omnibox · tabs button · devtools. Back/forward rides a
 * clean blur wipe; the tabs button springs up the carousel.
 *
 * The proxy engine is a module-level singleton, created the first time the
 * home exists and warmed immediately.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScramjetProxy } from "@/lib/murke/proxy";
import type { ProxyEngine, ProxyFrameHandle } from "@/lib/murke/contracts";
import { engineFor, frostStore, compressWallpaper, FROST_TIP_KEY, DEFAULT_WALLPAPER, type FrostShortcut } from "@/lib/murke/frost-store";
import { normalizeTarget } from "@/lib/murke/commands";
import { unlockProxyWorker } from "@/lib/murke/auth";
import BareFrame from "./BareFrame";
import FrostControls from "./FrostControls";
import FrostDevtools from "./FrostDevtools";
import FrostNativeSearch from "./FrostNativeSearch";
import FrostSettings, { ShortcutEditor, type FrostTab } from "./FrostSettings";
import FrostUrlBar from "./FrostUrlBar";
import FrostCarousel from "./FrostCarousel";
import type { FrostTabInfo } from "./frost-tab-info";
import { WidgetBoard, widgetDefaults, GRID_STEP } from "./widgets/FrostWidgets";
import WidgetEditor from "./widgets/WidgetEditor";
import { EngineGlyph } from "./EngineGlyph";
import { ShortcutGlyph } from "./ShortcutGlyph";
import type { FrostWidget, FrostWidgetKind } from "@/lib/murke/frost-store";

/** the proxy engine — born with the home, never before */
let proxyEngine: ProxyEngine | null = null;
function ensureProxy(): ProxyEngine {
  if (!proxyEngine) proxyEngine = new ScramjetProxy();
  return proxyEngine;
}

/** urls browse direct no matter the engine; plain words use the engine —
    the frost engine (q=null) answers on its own frost:// results page */
function engineTarget(engineQ: string | null, s: string): string {
  const looksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(s);
  if (looksUrl) return normalizeTarget(s);
  if (!engineQ) return `frost://search?q=${encodeURIComponent(s)}`;
  return engineQ + encodeURIComponent(s);
}

/** the native results page marker — plain words under the smart (q-less)
    frost engine open frost://search, the page this app renders itself */
function nativeQueryOf(url: string | null): string | null {
  if (!url || !url.startsWith("frost://search?")) return null;
  try {
    const q = new URL(url).searchParams.get("q");
    return q ?? null;
  } catch {
    return null;
  }
}

/** rows of shortcuts (8 per row, like the extension) → --n-row */
function rowsFor(n: number): number {
  return n <= 0 ? 0 : Math.max(1, Math.ceil(n / 8));
}

/** tab ids — a counter, monotonically, per session */
let tabSeq = 0;
const newTabId = () => `tab-${Date.now().toString(36)}-${++tabSeq}`;

export default function HomeStage() {
  const proxy = ensureProxy();

  const settings = frostStore((s) => s.settings);
  const hydrate = frostStore((s) => s.hydrate);
  const patch = frostStore((s) => s.set);

  /* settings hydrates after first paint — keep the root vars honest */
  const s = settings;

  /* ---------- tabs ---------- */

  const [tabs, setTabs] = useState<FrostTabInfo[]>(() => [{ id: newTabId(), url: null, title: "New Tab" }]);
  /* the first tab is active from the very first paint (every tab mutation
     sets the active id itself — no sync effect needed) */
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeId) ?? tabs[0],
    [tabs, activeId],
  );
  const browsing = activeTab?.url !== null && activeTab?.url !== undefined;

  /* every tab's live frame handle — the controls + devtools ride the active one */
  const [frames, setFrames] = useState<Record<string, ProxyFrameHandle | null>>({});
  const activeFrame = frames[activeTab?.id ?? ""] ?? null;

  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<FrostTab>("appearance");
  const [devtools, setDevtools] = useState(false);
  const [carousel, setCarousel] = useState(false);
  /* the home editor — drag/resize/delete widgets + the palette */
  const [editor, setEditor] = useState(false);
  const [editorSel, setEditorSel] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; shortcut?: FrostShortcut } | null>(null);
  const ctxRef = useRef<HTMLDivElement | null>(null);
  const [idle, setIdle] = useState(false);
  /* the design's popups: shortcut creator/editor + wallpaper picker —
     they open straight from the context menus, not via settings */
  const [editing, setEditing] = useState<FrostShortcut | null | undefined>(undefined); // undefined = closed
  const [wpPicker, setWpPicker] = useState(false);
  const [wpDrag, setWpDrag] = useState(false);
  const wpFileRef = useRef<HTMLInputElement>(null);
  const idleTimer = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  /* the first-boot tip under the search bar — once, ever */
  const [tip, setTip] = useState(false);

  /* the back/forward blur wipe — armed on the nav buttons, cleared when
     the frame answers (or a beat later, whichever comes first) */
  const [navBlur, setNavBlur] = useState(false);
  const navBlurTimer = useRef<number>(0);
  const startNavBlur = useCallback(() => {
    window.clearTimeout(navBlurTimer.current);
    setNavBlur(true);
    navBlurTimer.current = window.setTimeout(() => setNavBlur(false), 900);
  }, []);
  const stopNavBlur = useCallback(() => {
    window.clearTimeout(navBlurTimer.current);
    setNavBlur(false);
  }, []);

  /* warm the engine the moment the home exists — searches must be instant */
  useEffect(() => {
    const t = window.setTimeout(() => {
      void proxy.init().catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(t);
  }, [proxy]);

  /* keep the proxy's service-worker gate open while the shell lives —
     the unlock TTLs out ~10 min after the last refresh, so a lingering
     worker can never outlive the session that earned it */
  useEffect(() => {
    const iv = window.setInterval(() => unlockProxyWorker(), 4 * 60_000);
    return () => window.clearInterval(iv);
  }, []);

  /* activity → the floating controls come back; silence → they melt.
     The parent world listens here; keys inside the proxied page arrive
     through BareFrame's onFrameKey (the frame owns the pointer+keys). */
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  }, []);
  useEffect(() => {
    if (!browsing || !s.idleFade) {
      window.clearTimeout(idleTimer.current);
      return;
    }
    // start the melt clock directly — a sync setState here would cascade
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
    const evs: Array<keyof WindowEventMap> = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"];
    for (const ev of evs) window.addEventListener(ev, wake, { passive: true });
    return () => {
      window.clearTimeout(idleTimer.current);
      for (const ev of evs) window.removeEventListener(ev, wake);
    };
  }, [browsing, s.idleFade, wake]);
  const onFrameKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.type === "keydown") wake();
      /* keys typed inside the proxied page re-dispatch on the parent
         window — the shell's own listeners (esc → home, the carousel's
         arrows/enter) hear them exactly as if focus sat on the parent.
         Keys typed into the PAGE'S OWN fields stay there (an esc in a
         site's search box must not hurl the user home). */
      if (e.type !== "keydown") return;
      const t = e.target as HTMLElement | null;
      const inField =
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable);
      if (inField) return;
      try {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: e.key,
            bubbles: true,
            cancelable: true,
          }),
        );
      } catch {
        /* older browsers without the constructor — nothing dramatic */
      }
    },
    [wake],
  );

  useEffect(() => {
    hydrate();
    try {
      if (!localStorage.getItem(FROST_TIP_KEY)) {
        const t = window.setTimeout(() => setTip(true), 1100);
        return () => window.clearTimeout(t);
      }
    } catch {
      /* private mode — show it anyway, it just won't persist */
      const t = window.setTimeout(() => setTip(true), 1100);
      return () => window.clearTimeout(t);
    }
  }, [hydrate]);

  const dismissTip = useCallback(() => {
    setTip(false);
    try {
      localStorage.setItem(FROST_TIP_KEY, "1");
    } catch {
      /* session only */
    }
  }, []);

  /* ---------- tab plumbing ---------- */

  const setTabUrl = useCallback((id: string, url: string | null) => {
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, url } : t)));
  }, []);

  const setTabMeta = useCallback((id: string, url: string, title: string) => {
    setTabs((ts) =>
      ts.map((t) => (t.id === id ? { ...t, url, title: title || t.title || hostLabel(url) } : t)),
    );
  }, []);

  /* every load + urlchange a tab reports: bookkeeping + the wipe's end */
  const onNavigateFor = useCallback(
    (id: string) => (realUrl: string, title: string) => {
      setTabMeta(id, realUrl, title);
      if (id === (activeTab?.id ?? "")) stopNavBlur();
    },
    [setTabMeta, activeTab, stopNavBlur],
  );

  /* SPA pages retitle without navigating — a quiet poll keeps the tab titles honest */
  useEffect(() => {
    const iv = window.setInterval(() => {
      setTabs((ts) => {
        let changed = false;
        const next = ts.map((t) => {
          const h = frames[t.id];
          if (!h || !t.url) return t;
          try {
            const title = (h.el as HTMLIFrameElement).contentDocument?.title?.trim();
            if (title && title !== t.title) {
              changed = true;
              return { ...t, title };
            }
          } catch {
            /* cross-origin moment — skip this beat */
          }
          return t;
        });
        return changed ? next : ts;
      });
    }, 3000);
    return () => window.clearInterval(iv);
  }, [frames]);

  const openNewTab = useCallback(() => {
    const fresh: FrostTabInfo = { id: newTabId(), url: null, title: "New Tab" };
    setTabs((ts) => [...ts, fresh]);
    setActiveId(fresh.id);
    setCarousel(false);
    setDevtools(false);
    window.setTimeout(() => inputRef.current?.focus(), 80);
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const next = tabs.filter((t) => t.id !== id);
      if (next.length === 0) {
        // a frost with zero tabs is not a frost — a fresh new tab appears
        const fresh: FrostTabInfo = { id: newTabId(), url: null, title: "New Tab" };
        setTabs([fresh]);
        setActiveId(fresh.id);
      } else {
        setTabs(next);
        if (id === activeId) {
          setActiveId(next[Math.min(idx, next.length - 1)].id);
        }
      }
      setCarousel(false);
    },
    [tabs, activeId],
  );

  const activateTab = useCallback((id: string) => {
    setActiveId(id);
    setCarousel(false);
    setDevtools(false);
    stopNavBlur();
  }, [stopNavBlur]);

  /* ---------- navigation ---------- */

  /* the search ripple — armed at the moment of a search, it sweeps the
     screen from the bar (or the click) and the results/site reveal
     through the expanding circle */
  const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null);
  const rippleSeq = useRef(0);
  const revealRef = useRef<HTMLDivElement | null>(null);
  const armRipple = useCallback((x?: number, y?: number) => {
    let ox = x;
    let oy = y;
    if (ox === undefined || oy === undefined) {
      const r = barRef.current?.getBoundingClientRect();
      ox = r ? r.left + r.width / 2 : window.innerWidth / 2;
      oy = r ? r.top + r.height / 2 : window.innerHeight / 2;
    }
    setRipple({ x: ox, y: oy, id: ++rippleSeq.current });
  }, []);

  /* when a ripple is armed and the browsing world mounts, the new view
     is revealed through an expanding clip-path circle from the same
     origin — the page literally pours out of the search */
  useEffect(() => {
    if (!ripple || !browsing) return;
    const el = revealRef.current;
    if (el && "animate" in el) {
      const { x, y } = ripple;
      const R =
        Math.hypot(
          Math.max(x, window.innerWidth - x),
          Math.max(y, window.innerHeight - y),
        ) + 60;
      try {
        el.animate(
          [
            { clipPath: `circle(0px at ${x}px ${y}px)` },
            { clipPath: `circle(${R}px at ${x}px ${y}px)` },
          ],
          { duration: 720, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      } catch {
        /* clip-path animation unsupported — the page just appears */
      }
    }
    const t = window.setTimeout(() => setRipple(null), 1000);
    return () => window.clearTimeout(t);
  }, [ripple, browsing]);

  const go = useCallback(
    (raw: string, mods: { ctrl: boolean; shift: boolean }, origin?: { x: number; y: number }) => {
      const q = raw.trim();
      if (!q || !activeTab) return;
      const eng = engineFor(s, mods);
      armRipple(origin?.x, origin?.y);
      setTabUrl(activeTab.id, engineTarget(eng.q, q));
      setPickerOpen(false);
    },
    [s, activeTab, setTabUrl, armRipple],
  );

  const home = useCallback(() => {
    if (activeTab) setTabUrl(activeTab.id, null);
    setDevtools(false);
    setCarousel(false);
    stopNavBlur();
    window.setTimeout(() => inputRef.current?.focus(), 60);
  }, [activeTab, setTabUrl, stopNavBlur]);

  /* esc: editor → carousel → settings → wallpaper → home */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") {
        if (editor) {
          setEditor(false);
          setEditorSel(null);
          return;
        }
        if (carousel) {
          setCarousel(false);
          return;
        }
        if (settingsOpen) {
          setSettingsOpen(false);
          return;
        }
        if (wpPicker) {
          setWpPicker(false);
          return;
        }
        if (browsing) {
          e.preventDefault();
          home();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [carousel, settingsOpen, wpPicker, browsing, home, editor]);

  /* ---------- widget plumbing (the home editor's canvas) ---------- */

  const addWidget = useCallback(
    (kind: FrostWidgetKind) => {
      // functional patch — reads the LIVE layout, so rapid-fire palette
      // clicks can never overwrite each other with a stale snapshot
      const w = widgetDefaults(kind, frostStore.getState().settings.homeLayout.widgets.length);
      patch((cur) => ({
        homeLayout: {
          widgets: [...cur.homeLayout.widgets, w],
          grid: cur.homeLayout.grid,
        },
      }));
      setEditorSel(w.id);
    },
    [patch],
  );

  const changeWidget = useCallback(
    (id: string, p: Partial<FrostWidget>) => {
      patch((cur) => ({
        homeLayout: {
          widgets: cur.homeLayout.widgets.map((w) => (w.id === id ? { ...w, ...p } : w)),
          grid: cur.homeLayout.grid,
        },
      }));
    },
    [patch],
  );

  const deleteWidget = useCallback(
    (id: string) => {
      patch((cur) => ({
        homeLayout: { widgets: cur.homeLayout.widgets.filter((w) => w.id !== id), grid: cur.homeLayout.grid },
      }));
      setEditorSel(null);
    },
    [patch],
  );

  const setGrid = useCallback(
    (on: boolean) => patch((cur) => ({ homeLayout: { widgets: cur.homeLayout.widgets, grid: on } })),
    [patch],
  );

  /* engine picker: outside click dismisses */
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [pickerOpen]);

  /* context menus: outside pointerdown + esc dismiss. The menu itself is
     exempt — a press inside it (on a menu item) must survive to its click,
     otherwise the item unmounts before the click and NOTHING opens
     (settings / add shortcut / wallpaper picker all dead). */
  useEffect(() => {
    if (!ctx) return;
    const onDown = (e: PointerEvent) => {
      if (ctxRef.current?.contains(e.target as Node)) return;
      setCtx(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtx(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ctx]);

  const openSettings = useCallback((tab: FrostTab) => {
    setCtx(null);
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, [setCtx, setSettingsTab, setSettingsOpen]);

  /* the wallpaper picker's file path — same compression the settings use */
  const pickWallpaper = useCallback(
    (file: File) => {
      compressWallpaper(file)
        .then((url) => patch({ wallpaper: url }))
        .catch(() => undefined); // quiet — the picker stays, nothing happened
    },
    [patch],
  );

  /* ---------- the movable search cluster ---------- */

  /* drag the search cluster anywhere — the grip sits above the bar and
     fades in on hover; the live position persists in the store. Grid on:
     the cluster's center snaps to the 24px grid, so it lines up with the
     widgets. */
  const dragCluster = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rect = barRef.current?.getBoundingClientRect();
      const origin = rect
        ? { x: ((rect.left + rect.width / 2) / vw) * 100, y: ((rect.top + rect.height / 2) / vh) * 100 }
        : { x: 50, y: 45 };
      const startX = e.clientX;
      const startY = e.clientY;
      const onMove = (ev: PointerEvent) => {
        let px = (origin.x / 100) * vw + (ev.clientX - startX);
        let py = (origin.y / 100) * vh + (ev.clientY - startY);
        if (s.homeLayout.grid) {
          px = Math.round(px / GRID_STEP) * GRID_STEP;
          py = Math.round(py / GRID_STEP) * GRID_STEP;
        }
        const x = (px / vw) * 100;
        const y = (py / vh) * 100;
        patch({ searchPos: { x: Math.min(96, Math.max(4, x)), y: Math.min(92, Math.max(6, y)) } });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [patch, s.homeLayout.grid],
  );

  const openShortcut = useCallback(
    (c: FrostShortcut, origin?: { x: number; y: number }) => {
      if (!activeTab) return;
      armRipple(origin?.x, origin?.y);
      setTabUrl(activeTab.id, engineTarget(null, c.url));
    },
    [activeTab, setTabUrl, armRipple],
  );

  /* ---------- design tokens (the exact custom properties) ---------- */

  const rootStyle = useMemo(
    () =>
      ({
        /* the formula: slider % → the unitless factors home.css squares/
           multiplies itself. blur 40 → 0.4 (NOT sqrt — the css already
           does the b·b in blur(30px·b·b)) */
        "--glass-blur": String(s.glass.blur / 100),
        "--glass-brightness": String(s.glass.brightness / 100),
        "--glass-saturation": String(s.glass.saturation / 100),
        "--glass-transparency": String(s.glass.transparency / 100),
        "--search-bar-height": String(s.searchBar.height / 100),
        "--search-bar-radius": String(s.searchBar.radius / 100),
        "--search-bar-width": String(s.searchBar.width / 100),
        "--search-bar-font-color": "black",
        "--shortcut-radius": String(s.shortcutsStyle.radius / 100),
        "--shortcut-size": String(s.shortcutsStyle.size / 100),
        "--shortcut-font-color":
          s.shortcutsStyle.fontColor === "black"
            ? "black"
            : s.shortcutsStyle.fontColor === "transparent"
              ? "transparent"
              : "white",
      }) as React.CSSProperties,
    [s],
  );

  const selectedEngine = useMemo(
    () => s.engines.find((e) => e.id === s.engine) ?? s.engines[0],
    [s.engines, s.engine],
  );

  const nRow = rowsFor(s.shortcuts.length);

  return (
    <main
      className="frost-root fixed inset-0 overflow-hidden"
      style={{ ...rootStyle, backgroundColor: "#000" }}
      aria-label="frost home"
      onContextMenu={(e) => {
        // the general menu — add shortcut / set wallpaper / settings
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* the wallpaper backdrop — the user's own default, never white;
          blur softens it when asked */}
      <div
        className="frost-backdrop frost-full-screen"
        style={{
          backgroundColor: "#0d1015",
          backgroundImage: `url(${s.wallpaper || DEFAULT_WALLPAPER})`,
          filter: s.wallpaperBlur > 0 ? `blur(${(s.wallpaperBlur / 100) * 22}px)` : undefined,
          transform: s.wallpaperBlur > 0 ? "scale(1.06)" : undefined,
        }}
        aria-hidden="true"
      />

      {/* every browsing tab's frame — mounted, hidden while inactive so
          each tab keeps its scroll, session and history alive */}
      {tabs
        .filter((t) => t.url !== null)
        .map((t) => {
          const active = t.id === (activeTab?.id ?? "");
          return (
            <div
              key={t.id}
              ref={active ? revealRef : undefined}
              className="frost-full-screen"
              style={{
                zIndex: 10,
                visibility: active ? "visible" : "hidden",
                pointerEvents: active ? "auto" : "none",
              }}
            >
              {nativeQueryOf(t.url) !== null ? (
                <div className="frost-full-screen" style={{ overflowY: "auto" }}>
                  <FrostNativeSearch
                    query={nativeQueryOf(t.url) ?? ""}
                    onOpen={(target) => setTabUrl(t.id, engineTarget(null, target))}
                    active={active}
                  />
                </div>
              ) : (
                <div
                  className={`frost-full-screen frost-frame ${active && navBlur ? "frost-frame-blurred" : ""}`}
                  style={{ background: "#fff" }}
                >
                  <BareFrame
                    url={t.url as string}
                    proxy={proxy}
                    onFrame={(h) =>
                      setFrames((f) => {
                        const n = { ...f };
                        if (h) n[t.id] = h;
                        else delete n[t.id];
                        return n;
                      })
                    }
                    onFrameKey={onFrameKey}
                    onFrameWake={wake}
                    onNavigate={onNavigateFor(t.id)}
                  />
                </div>
              )}
            </div>
          );
        })}

      {/* the home's widgets — always where the user pinned them. The
          board carries the change callback in VIEW mode too — that's what
          lets the notes widget be typed on straight from the home */}
      {!browsing && !editor && (
        <WidgetBoard widgets={s.homeLayout.widgets} editing={false} onChange={changeWidget} />
      )}

      {/* the home editor — the canvas + the right-side palette */}
      {!browsing && editor && (
        <WidgetEditor
          widgets={s.homeLayout.widgets}
          selectedId={editorSel}
          onSelect={setEditorSel}
          onAdd={addWidget}
          onChange={changeWidget}
          onDelete={deleteWidget}
          grid={s.homeLayout.grid}
          onGrid={setGrid}
          onDone={() => {
            setEditor(false);
            setEditorSel(null);
          }}
        />
      )}

      {/* the container — bar + grip + tip + shortcuts, dead center until
          the user drags it somewhere else (the grip fades in on hover).
          pointer-events NONE on the frame itself — the widgets underneath
          must stay clickable — and AUTO on the interactive bits. */}
      {!browsing && (
      <div
        className={s.searchPos ? "frost-container" : "frost-container frost-full-screen"}
        style={{
          zIndex: 11,
          pointerEvents: "none",
          ...(editor ? { opacity: 0.3, filter: "blur(1px)" } : {}),
          ...(s.searchPos
            ? {
                position: "absolute",
                left: `${s.searchPos.x}%`,
                top: `${s.searchPos.y}%`,
                transform: "translate(-50%, -50%)",
              }
            : {}),
        }}
      >
        <div ref={barRef} style={{ position: "relative", pointerEvents: "auto" }}>
          {/* the grip — edit mode only: grab it to move the search anywhere */}
          {editor && (
            <div
              className="frost-cluster-grip frost-cluster-grip-on"
              role="button"
              aria-label="move the search bar"
              title="drag to move"
              onPointerDown={dragCluster}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
                <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
                <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
              </svg>
            </div>
          )}
          <div
            className="frost-search-bar frost-glass frost-subtle-elevation"
            role="search"
            style={{ position: "relative" }}
          >
            <button
              type="button"
              className="frost-engine"
              onClick={() => setPickerOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              aria-label={`search engine: ${selectedEngine?.name ?? "frost"}`}
              title={`search with ${selectedEngine?.name ?? "frost"}`}
            >
              {selectedEngine && <EngineGlyph engine={selectedEngine} />}
            </button>

            <input
              ref={inputRef}
              type="text"
              className="frost-search-text"
              value={query}
              placeholder="Search the web"
              aria-label="search the web"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  go(query, { ctrl: e.ctrlKey, shift: e.shiftKey });
                }
              }}
            />

            <button
              type="button"
              className="frost-search-glass"
              tabIndex={-1}
              aria-label="search"
              onClick={(e) => go(query, { ctrl: false, shift: false }, { x: e.clientX, y: e.clientY })}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M0 0h24v24H0V0z" fill="none" />
                <path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 001.48-5.34c-.47-2.78-2.79-5-5.59-5.34a6.505 6.505 0 00-7.27 7.27c.34 2.8 2.56 5.12 5.34 5.59a6.5 6.5 0 005.34-1.48l.27.28v.79l4.25 4.25c.41.41 1.08.41 1.49 0 .41-.41.41-1.08 0-1.49L15.5 14zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
              </svg>
            </button>

            {/* the engine picker — slides in from the left, white, low elevation */}
            <div
              className={`frost-engine-picker frost-white-background frost-low-elevation ${pickerOpen ? "frost-engine-picker-visible" : ""}`}
              role="menu"
              aria-label="search engines"
              style={{ borderRadius: "calc(32px * var(--search-bar-height) * var(--search-bar-radius))" }}
            >
              {s.engines.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="menuitem"
                  className="frost-engine"
                  aria-label={`engine ${e.name}`}
                  title={e.name}
                  onClick={() => {
                    patch({ engine: e.id });
                    setPickerOpen(false);
                    window.setTimeout(() => inputRef.current?.focus(), 30);
                  }}
                >
                  <EngineGlyph engine={e} />
                </button>
              ))}
            </div>
          </div>

          {/* the first-boot tip — right under the bar, once, ever */}
          {tip && (
            <div className="frost-tip" role="status" aria-label="tip">
              <div className="frost-tip-card frost-glass frost-low-elevation">
                <span className="frost-tip-text">Right-click the home to customise</span>
                <button type="button" className="frost-tip-ok" onClick={dismissTip}>
                  OK
                </button>
              </div>
            </div>
          )}
        </div>

        {/* shortcuts — the row(s) under the bar (only when there are any) */}
        {s.shortcuts.length > 0 && (
          <div className="frost-shortcut-container" style={{ ["--n-row" as string]: nRow, pointerEvents: "auto" }}>
            {s.shortcuts.map((c) => (
              <a
                key={c.id}
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  openShortcut(c, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtx({ x: e.clientX, y: e.clientY, shortcut: c });
                }}
              >
                <div className="frost-shortcut">
                  <div
                    className="frost-icon frost-glass frost-subtle-elevation"
                    style={{ overflow: "hidden" }}
                  >
                    {c.icon ? (
                      <img src={c.icon} alt="" />
                    ) : (
                      <ShortcutGlyph url={c.url} name={c.name} />
                    )}
                  </div>
                  <div className="frost-shortcut-name">{c.name}</div>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
      )}

      {/* the keyboard user's door to the general menu (invisible until
          focused — 1:1 with the extension's #nav-context-menu) */}
      {!browsing && !settingsOpen && (
        <button
          type="button"
          className="frost-nav-context-menu frost-button frost-subtle-roundness frost-subtle-elevation"
          onClick={(e) => {
            const r = (e.target as HTMLElement).getBoundingClientRect();
            setCtx({ x: Math.max(12, r.left - 140), y: Math.max(12, r.top - 160) });
          }}
        >
          Open Context Menu
        </button>
      )}

      {/* floating corner chrome — nav trio · omnibox · tabs · devtools */}
      {browsing && s.floatingControls && (
        <>
          <FrostControls
            onBack={() => {
              startNavBlur();
              activeFrame?.back();
            }}
            onForward={() => {
              startNavBlur();
              activeFrame?.forward();
            }}
            onHome={home}
            onReload={() => {
              startNavBlur();
              activeFrame?.reload();
            }}
            onTabs={() => setCarousel((c) => !c)}
            tabsOpen={carousel}
            tabCount={tabs.length}
            onDevtools={() => setDevtools((d) => !d)}
            devtoolsOpen={devtools}
            idle={idle && s.idleFade}
          />
          <FrostUrlBar
            url={activeTab?.url ?? ""}
            engines={s.engines}
            selectedId={s.engine}
            onPickEngine={(id) => patch({ engine: id })}
            onGo={(text, mods) => {
              const eng = engineFor(s, mods);
              if (activeTab) setTabUrl(activeTab.id, engineTarget(eng.q, text));
            }}
            idle={idle && s.idleFade}
          />
        </>
      )}

      {/* the <> sheet */}
      {browsing && devtools && <FrostDevtools frame={activeFrame} onClose={() => setDevtools(false)} />}

      {/* the search ripple — rings that sweep the screen as the new view
          pours out of the bar */}
      {ripple && (
        <div
          className="frost-ripple"
          style={{ ["--rx" as string]: `${ripple.x}px`, ["--ry" as string]: `${ripple.y}px` }}
          aria-hidden="true"
        >
          <span className="frost-ripple-tint" />
          <span className="frost-ripple-ring" />
          <span className="frost-ripple-ring frost-ripple-ring2" />
        </div>
      )}

      {/* the tabs carousel — spring up, scroll through, pick */}
      <FrostCarousel
        open={carousel}
        tabs={tabs}
        activeId={activeTab?.id ?? ""}
        onActivate={activateTab}
        onClose={closeTab}
        onNew={openNewTab}
        onRequestClose={() => setCarousel(false)}
        frameFor={(id) => frames[id] ?? null}
      />

      {/* the shortcut context menu */}
      {ctx?.shortcut && (
        <div
          ref={ctxRef}
          className="frost-context-menu frost-white-background frost-low-elevation frost-low-roundness frost-menu-visible"
          role="menu"
          style={{ left: ctx.x, top: ctx.y, display: "block" }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="frost-menu-item"
            role="menuitem"
            onClick={() => {
              // open in a real new tab — through the relay, not out of it
              const sc = ctx.shortcut;
              if (!sc) return;
              const target = engineTarget(null, sc.url);
              try {
                window.open(`/scramjet/${encodeURIComponent(target)}`, "_blank");
              } catch {
                openShortcut(sc);
              }
              setCtx(null);
            }}
          >
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <path d="M18 19H6c-.55 0-1-.45-1-1V6c0-.55.45-1 1-1h5c.55 0 1-.45 1-1s-.45-1-1-1H5a2 2 0 00-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-6c0-.55-.45-1-1-1s-1 .45-1 1v5c0 .55-.45 1-1 1zM14 4c0 .55.45 1 1 1h2.59l-9.13 9.13a.996.996 0 101.41 1.41L19 6.41V9c0 .55.45 1 1 1s1-.45 1-1V4c0-.55-.45-1-1-1h-5c-.55 0-1 .45-1 1z" fill="#666" />
            </svg>
            <span> Open in New Tab </span>
          </button>
          <button
            type="button"
            className="frost-menu-item"
            role="menuitem"
            onClick={async () => {
              const sc = ctx.shortcut;
              if (!sc) return;
              try {
                await navigator.clipboard.writeText(sc.url);
              } catch {
                /* clipboard denied — nothing dramatic */
              }
              setCtx(null);
            }}
          >
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <path fill="none" d="M0 0h24v24H0z" />
              <path d="M15 20H5V7c0-.55-.45-1-1-1s-1 .45-1 1v13c0 1.1.9 2 2 2h10c.55 0 1-.45 1-1s-.45-1-1-1zm5-4V4c0-1.1-.9-2-2-2H9c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h9c1.1 0 2-.9 2-2zm-2 0H9V4h9v12z" fill="#666" />
            </svg>
            <span> Copy Link </span>
          </button>
          <button
            type="button"
            className="frost-menu-item"
            role="menuitem"
            onClick={() => {
              // edit this shortcut — the design's #shortcut-editor popup
              setCtx(null);
              setEditing(ctx.shortcut ?? null);
            }}
          >
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <path d="M3 17.46v3.04c0 .28.22.5.5.5h3.04c.13 0 .26-.05.35-.15L17.81 9.94l-3.75-3.75L3.15 17.1c-.1.1-.15.22-.15.36zM20.71 7.04a.996.996 0 000-1.41l-2.34-2.34a.996.996 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="#666" />
            </svg>
            <span> Edit Shortcut </span>
          </button>
        </div>
      )}

      {/* the general context menu */}
      {ctx && !ctx.shortcut && (
        <div
          ref={ctxRef}
          className="frost-context-menu frost-white-background frost-low-elevation frost-low-roundness frost-menu-visible"
          role="menu"
          style={{ left: ctx.x, top: ctx.y, display: "block" }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button type="button" className="frost-menu-item" role="menuitem" onClick={() => { setCtx(null); setEditor(true); }}>
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 000-1.41l-2.34-2.34a.996.996 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" fill="#666" />
            </svg>
            <span> Edit Home </span>
          </button>
          <button type="button" className="frost-menu-item" role="menuitem" onClick={() => { setCtx(null); setEditing(null); }}>
            <svg viewBox="0 0 20 20" width="24" height="24" aria-hidden="true">
              <path fill="none" d="M0 0h20v20H20z" />
              <path d="M15 7.25c.41 0 .75-.34.75-.75v-.75h.75c.41 0 .75-.34.75-.75s-.34-.75-.75-.75h-.75V3.5c0-.41-.34-.75-.75-.75s-.75.34-.75.75v.75h-.75c-.41 0-.75.34-.75.75s.34.75.75.75h.75v.75c0 .41.34.75.75.75zm0 8.27c0 .71-.71 1.19-1.37.93L10 15l-3.63 1.45A.999.999 0 015 15.52V4.5C5 3.67 5.67 3 6.5 3h5.04A3.89 3.89 0 0011 5c0 2.21 1.79 4 4 4v6.52z" fill="#666" />
            </svg>
            <span> Add Shortcut </span>
          </button>
          <button type="button" className="frost-menu-item" role="menuitem" onClick={() => { setCtx(null); setWpPicker(true); }}>
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <path d="M4 5c0-.55.45-1 1-1h5c.55 0 1-.45 1-1s-.45-1-1-1H4c-1.1 0-2 .9-2 2v6c0 .55.45 1 1 1s1-.45 1-1V5zm5.61 8.49l-2.96 3.7c-.26.33-.03.81.39.81H17a.5.5 0 00.4-.8l-2-2.67c-.2-.27-.6-.27-.8 0l-1.63 2.18-2.58-3.22a.5.5 0 00-.78 0zM17 8.5c0-.83-.67-1.5-1.5-1.5S14 7.67 14 8.5s.67 1.5 1.5 1.5S17 9.33 17 8.5zM20 2h-6c-.55 0-1 .45-1 1s.45 1 1 1h5c.55 0 1 .45 1 1v5c0 .55.45 1 1 1s1-.45 1-1V4c0-1.1-.9-2-2-2zm0 17c0 .55-.45 1-1 1h-5c-.55 0-1 .45-1 1s.45 1 1 1h6c1.1 0 2-.9 2-2v-6c0-.55-.45-1-1-1s-1 .45-1 1v5zM3 13c-.55 0-1 .45-1 1v6c0 1.1.9 2 2 2h6c.55 0 1-.45 1-1s-.45-1-1-1H5c-.55 0-1-.45-1-1v-5c0-.55-.45-1-1-1z" fill="#666" />
            </svg>
            <span> Set Wallpaper </span>
          </button>
          <button type="button" className="frost-menu-item" role="menuitem" onClick={() => openSettings("appearance")}>
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
              <path fill="none" d="M0 0h24v24H0z" />
              <path d="M19.5 12c0-.23-.01-.45-.03-.68l1.86-1.41c.4-.3.51-.86.26-1.3l-1.87-3.23a.987.987 0 00-1.25-.42l-2.15.91c-.37-.26-.76-.49-1.17-.68l-.29-2.31c-.06-.5-.49-.88-.99-.88h-3.73c-.51 0-.94.38-1 .88l-.29 2.31c-.41.19-.8.42-1.17.68l-2.15-.91c-.46-.2-1-.02-1.25.42L2.41 8.62c-.25.44-.14.99.26 1.3l1.86 1.41a7.343 7.343 0 000 1.35l-1.86 1.41c-.4.3-.51.86-.26 1.3l1.87 3.23c.25.44.79.62 1.25.42l2.15-.91c.37.26.76.49 1.17.68l.29 2.31c.06.5.49.88.99.88h3.73c.5 0 .93-.38.99-.88l.29-2.31c.41-.19.8-.42 1.17-.68l2.15.91c.46.2 1 .02 1.25-.42l1.87-3.23c.25-.44.14-.99-.26-1.3l-1.86-1.41c.03-.23.04-.45.04-.68zm-7.46 3.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z" fill="#666" />
            </svg>
            <span> Settings </span>
          </button>
        </div>
      )}

      {/* settings — the full-page sheet, 1:1 with settings.html */}
      {settingsOpen && (
        <FrostSettings
          tab={settingsTab}
          onTab={setSettingsTab}
          settings={s}
          patch={patch}
          onClose={() => setSettingsOpen(false)}
          onOpenEditor={() => {
            setSettingsOpen(false);
            setEditor(true);
          }}
        />
      )}

      {/* the design's #shortcut-creator / #shortcut-editor — straight from
          the context menu, centered, white, high elevation */}
      {editing !== undefined && (
        <ShortcutEditor
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSave={(sc) => {
            const exists = s.shortcuts.some((x) => x.id === sc.id);
            patch({
              shortcuts: exists
                ? s.shortcuts.map((x) => (x.id === sc.id ? sc : x))
                : [...s.shortcuts, sc],
            });
            setEditing(undefined);
          }}
          onDelete={
            editing
              ? (id) => {
                  patch({ shortcuts: s.shortcuts.filter((x) => x.id !== id) });
                  setEditing(undefined);
                }
              : undefined
          }
        />
      )}

      {/* the design's #wallpaper-picker — Load File / drag-drop, centered */}
      {wpPicker && (
        <div
          className="frost-popup-wrap"
          role="dialog"
          aria-label="set wallpaper"
          onPointerDown={(e) => {
            // click outside the popup dismisses it
            if (e.target === e.currentTarget) setWpPicker(false);
          }}
        >
          <div
            className={`frost-popup frost-white-background frost-high-elevation frost-high-roundness frost-wallpaper-picker frost-show-popup ${wpDrag ? "frost-dragover" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setWpDrag(true);
            }}
            onDragLeave={() => setWpDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setWpDrag(false);
              setWpPicker(false);
              const f = e.dataTransfer.files?.[0];
              if (f) pickWallpaper(f);
            }}
          >
            <button
              type="button"
              className="frost-popup-button frost-button frost-subtle-elevation frost-subtle-roundness"
              onClick={() => wpFileRef.current?.click()}
            >
              Load File
            </button>
            <div className="frost-popup-text">Or drag and drop an image</div>
            <input
              ref={wpFileRef}
              type="file"
              accept="image/*"
              className="sr-only"
              aria-label="load wallpaper file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickWallpaper(f);
                setWpPicker(false);
                e.target.value = "";
              }}
            />
          </div>
        </div>
      )}
    </main>
  );
}

/** a fallback tab label from a url */
function hostLabel(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return raw;
  }
}
