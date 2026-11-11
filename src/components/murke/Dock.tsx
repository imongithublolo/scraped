"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Eye,
  Folder,
  Globe,
  LayoutGrid,
  MessagesSquare,
  Palette,
  Settings as SettingsIcon,
  SquareTerminal,
  StickyNote,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { AppId, CustomApp } from "@/lib/murke/contracts";
import { DOCK_ORDER } from "@/lib/murke/appmeta";
import { useOS } from "@/lib/murke/os-store";
import { watchFrameKeys } from "@/lib/murke/frame-keys";
import AppIcon, { PwaIcon, TRANSLUCENT_TILE, glassTileStyle } from "./AppIcon";
import { FrostLayer, supportsGlassDistort } from "./GlassDefs";
import Launchpad from "./Launchpad";
import Spotlight from "./Spotlight";
import { requestAddApp } from "./AddAppDialog";

/**
 * Dock v4 — liquid glass, truly macOS, fully tunable.
 *
 *  - glass: backdrop refracted through the shared SVG displacement filter
 *    (GlassDefs) + blur + saturation, a specular sheen skin and hairline
 *    inner highlights (.murke-glass* in globals.css). opacity / blur /
 *    radius are live settings now.
 *  - size: settings.dock.iconSize (24..56) — default 32, tight 3px chrome
 *  - magnification FIXED: the old version clipped the pop (overflow-x-auto
 *    coerces overflow-y to auto) and neighbors overlapped; now the strip
 *    never clips and every magnified icon PUSHES its neighbors aside like
 *    the real macOS genie — displacement = Σ (scale_j-1)·r/2 signed by side.
 *    growth cap is settings.dock.magnifyAmount (0.08..0.7).
 *  - position: bottom | left | right; autohide: slides away, an 8px reveal
 *    strip at that edge brings it back (the sentinel stays mounted so a
 *    quick graze can't strand the dock on screen — it hides on leave)
 *  - indicator: dot | line | none; hover labels toggleable
 *  - custom apps ("PWA addon"): letter tiles after the separator
 */

export interface DockApp {
  id: AppId;
  label: string;
  icon: LucideIcon;
}

/** right-click target — a dock item, an installed app, or the bare dock */
interface DockCtx {
  x: number;
  y: number;
  appId: string;
  label: string;
  running: boolean;
  pwa?: CustomApp;
  /** the dock panel itself (background menu) */
  bg?: boolean;
}

/** shared with the windows taskbar (same apps, different chrome) */
export const DOCK_APPS: DockApp[] = [
  { id: "dsh", label: "terminal", icon: SquareTerminal },
  { id: "files", label: "finder", icon: Folder },
  { id: "browser", label: "web", icon: Globe },
  { id: "preview", label: "previews", icon: Eye },
  { id: "notes", label: "notes", icon: StickyNote },
  { id: "chat", label: "relay chat", icon: MessagesSquare },
  { id: "paint", label: "paint", icon: Palette },
];

export default function Dock() {
  const dock = useOS((s) => s.settings.dock);
  const customApps = useOS((s) => s.settings.customApps);
  /* real glass icon tiles — the "glassy icons" knob under the glass master */
  const iconGlass = useOS((s) => s.settings.glass.enabled && s.settings.glass.iconGlass);
  const windows = useOS((s) => s.windows);
  const activeId = useOS((s) => s.activeId);
  const openApp = useOS((s) => s.openApp);
  const toggleMinimize = useOS((s) => s.toggleMinimize);
  const focusWindow = useOS((s) => s.focusWindow);
  const closeWindow = useOS((s) => s.closeWindow);

  /* backdrop refraction is a Chromium trick — decide once */
  const [distort] = useState(supportsGlassDistort);

  /* launchpad / spotlight / dock context menu */
  const [launchpadOpen, setLaunchpadOpen] = useState(false);
  const [spotOpen, setSpotOpen] = useState(false);
  const [ctx, setCtx] = useState<DockCtx | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  /* autohide visibility — reset whenever the setting flips (state-adjusted
     during render per the React "you might not need an effect" pattern) */
  const [peek, setPeek] = useState(!dock.autohide);
  const [lastAuto, setLastAuto] = useState(dock.autohide);
  if (lastAuto !== dock.autohide) {
    setLastAuto(dock.autohide);
    setPeek(!dock.autohide);
  }

  const running = useMemo(() => {
    const m = new Map<AppId, { id: number; min: boolean }>();
    for (const w of windows) if (!w.closing && !m.has(w.app)) m.set(w.app, { id: w.id, min: w.min });
    return m;
  }, [windows]);

  /* running installed apps (pwa windows keyed by their CustomApp id) */
  const runningPwa = useMemo(() => {
    const m = new Map<string, { id: number; min: boolean }>();
    for (const w of windows) if (w.app === "pwa" && w.arg && !w.closing) m.set(w.arg, { id: w.id, min: w.min });
    return m;
  }, [windows]);

  const activate = useCallback(
    (app: AppId) => {
      const win = running.get(app);
      if (!win) openApp(app);
      else toggleMinimize(win.id);
    },
    [openApp, toggleMinimize, running],
  );

  const openCustom = useCallback(
    (app: CustomApp) => {
      /* installed apps run STANDALONE — their own chrome-less window, not a
         browser tab. openApp("pwa", id) is multi-instance keyed by the id. */
      const win = runningPwa.get(app.id);
      if (!win) openApp("pwa", app.id);
      else toggleMinimize(win.id);
    },
    [openApp, toggleMinimize, runningPwa],
  );

  /* ---------- right-click context menus (mac-style, glassy) ---------- */
  const openItemCtx = useCallback(
    (e: React.MouseEvent, key: string, label: string, pwa?: CustomApp) => {
      e.preventDefault();
      e.stopPropagation();
      const win = pwa ? runningPwa.get(key) : running.get(key as AppId);
      setCtx({ x: e.clientX, y: e.clientY, appId: key, label, running: Boolean(win), pwa });
    },
    [running, runningPwa],
  );

  const focusFirst = useCallback(
    (appId: string, pwa?: CustomApp) => {
      const win = pwa ? runningPwa.get(pwa.id) : running.get(appId as AppId);
      if (win) focusWindow(win.id);
    },
    [running, runningPwa, focusWindow],
  );

  const quitApp = useCallback(
    (appId: string, pwa?: CustomApp) => {
      for (const w of windows) {
        if (w.closing) continue;
        if (pwa ? w.app === "pwa" && w.arg === pwa.id : w.app === appId) closeWindow(w.id);
      }
    },
    [windows, closeWindow],
  );

  /* click-away + esc dismiss the menu (capture, like the menubar) */
  useEffect(() => {
    if (!ctx) return;
    const onDown = (e: PointerEvent) => {
      if (!ctxRef.current?.contains(e.target as Node)) setCtx(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setCtx(null);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ctx]);

  /* spotlight hotkeys — cmd/ctrl+k toggles from the parent document AND
     from inside every same-origin frame (the proxied page owns focus most
     of the time; without the frame relay the palette is dead exactly when
     it's needed most). "murke-spotlight" events open it. */
  useEffect(() => {
    const relay = watchFrameKeys((e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSpotOpen((v) => !v);
      }
    });
    const onOpen = () => setSpotOpen(true);
    const onLaunchpad = () => setLaunchpadOpen(true);
    window.addEventListener("murke-spotlight", onOpen);
    window.addEventListener("murke-launchpad", onLaunchpad);
    return () => {
      relay.stop();
      window.removeEventListener("murke-spotlight", onOpen);
      window.removeEventListener("murke-launchpad", onLaunchpad);
    };
  }, []);

  /* ---------- genie magnification (feedback-loop free) ---------- */
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  /** captured base geometry per item — measured while UNtransformed */
  const baseRef = useRef<Map<string, { c: number }>>(new Map());
  const rafRef = useRef(0);
  const size = dock.iconSize;
  const horizontal = dock.position === "bottom";
  /** genie growth cap from settings — 0 disables the pop entirely */
  const growCap = dock.magnify ? Math.max(0, dock.magnifyAmount) : 0;

  const captureBases = useCallback(() => {
    const m = new Map<string, { c: number }>();
    for (const [id, el] of itemRefs.current) {
      if (!el) continue;
      /* reset before measuring so we never capture a transformed state */
      el.style.transition = "none";
      el.style.transform = "";
      const r = el.getBoundingClientRect();
      m.set(id, { c: horizontal ? r.left + r.width / 2 : r.top + r.height / 2 });
    }
    baseRef.current = m;
  }, [horizontal]);

  const magnify = useCallback(
    (mp: number | null) => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        /* rest state — everything glides home */
        if (mp === null || growCap < 0.02) {
          for (const el of itemRefs.current.values()) {
            if (!el) continue;
            el.style.transition = "transform 190ms cubic-bezier(.32,.72,.34,1)";
            el.style.transform = "";
          }
          return;
        }

        /* gaussian falloff from the pointer to every icon's base center */
        const falloff = Math.max(46, size * 2);
        const scales = new Map<string, number>();
        for (const [id, base] of baseRef.current) {
          const k = Math.exp(-(((mp - base.c) / falloff) ** 2));
          scales.set(id, 1 + growCap * k);
        }
        /* the genie: every magnified icon displaces ALL other icons away
           from itself by half its growth — the strip physically widens
           around the cursor instead of icons piling onto each other */
        for (const [id, el] of itemRefs.current) {
          if (!el) continue;
          const base = baseRef.current.get(id);
          if (!base) continue;
          const scale = scales.get(id) ?? 1;
          const grow = scale - 1;
          let shift = 0;
          for (const [jId, jBase] of baseRef.current) {
            if (jId === id) continue;
            const jGrow = (scales.get(jId) ?? 1) - 1;
            if (jGrow < 0.01) continue;
            shift += (base.c > jBase.c ? 1 : -1) * jGrow * (size / 2);
          }
          if (grow < 0.004 && Math.abs(shift) < 0.3) {
            if (el.style.transform) {
              el.style.transition = "transform 120ms ease";
              el.style.transform = "";
            }
            continue;
          }
          const lift = horizontal ? (grow / Math.max(0.05, growCap)) * 7 : 0;
          const disp = shift.toFixed(2);
          const up = (-lift).toFixed(2);
          el.style.transition = "none";
          el.style.transform = horizontal
            ? `translate(${disp}px, ${up}px) scale(${scale.toFixed(3)})`
            : /* vertical dock: +Y is "away" whether the strip is left or right */
              `translate(0px, ${disp}px) scale(${scale.toFixed(3)})`;
        }
      });
    },
    [growCap, horizontal, size],
  );

  const onStripEnter = useCallback(() => {
    if (!dock.magnify) return;
    captureBases();
  }, [captureBases, dock.magnify]);

  const onStripMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dock.magnify) return;
      magnify(horizontal ? e.clientX : e.clientY);
    },
    [dock.magnify, horizontal, magnify],
  );

  const onStripLeave = useCallback(() => {
    magnify(null);
  }, [magnify]);

  /* clean up any lingering transform on unmount */
  useEffect(() => {
    const refs = itemRefs.current;
    return () => {
      for (const el of refs.values()) {
        el.style.transform = "";
        el.style.transition = "";
      }
    };
  }, []);

  /* ---------- launch bounce — one-shot genie hop on new windows ---------- */
  const prevKeysRef = useRef<Set<string> | null>(null);
  const bounceTimers = useRef<Map<string, number>>(new Map());
  const bounce = useCallback((key: string) => {
    const el = itemRefs.current.get(key);
    if (!el) return;
    const pending = bounceTimers.current.get(key);
    if (pending !== undefined) window.clearTimeout(pending);
    el.classList.remove("murke-dock-bounce");
    void el.offsetWidth; /* reflow so a re-trigger restarts the animation */
    el.classList.add("murke-dock-bounce");
    const t = window.setTimeout(() => {
      el.classList.remove("murke-dock-bounce");
      bounceTimers.current.delete(key);
    }, 950);
    bounceTimers.current.set(key, t);
  }, []);

  useEffect(() => {
    /* live dock keys: built-in app ids + pwa entries keyed by custom app id */
    const keys = new Set<string>();
    for (const w of windows) {
      if (w.closing) continue;
      keys.add(w.app === "pwa" && w.arg ? w.arg : w.app);
    }
    const prev = prevKeysRef.current;
    if (prev) {
      for (const k of keys) if (!prev.has(k)) bounce(k);
    }
    prevKeysRef.current = keys;
  }, [windows, bounce]);

  useEffect(() => {
    const timers = bounceTimers.current;
    return () => {
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
    };
  }, []);

  /* ---------- geometry per position ---------- */
  const hidden = dock.autohide && !peek;

  const glassShadow =
    "0 14px 36px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.055), inset 0 1.5px 0.5px -0.5px rgba(255,255,255,0.3), inset 0 -1px 1px -1px rgba(255,255,255,0.07)";

  /* slide direction when hidden */
  const hideTransform = horizontal
    ? `translate(-50%, ${hidden ? "calc(100% + 14px)" : "0%"})`
    : dock.position === "left"
      ? `translate(${hidden ? "calc(-100% - 14px)" : "0%"}, -50%)`
      : `translate(${hidden ? "calc(100% + 14px)" : "0%"}, -50%)`;

  /* reveal strip — the 8px sentinel that summons an autohidden dock */
  const stripPos: React.CSSProperties = horizontal
    ? { left: 0, right: 0, bottom: 0, height: 8 }
    : dock.position === "left"
      ? { left: 0, top: 0, bottom: 0, width: 8 }
      : { right: 0, top: 0, bottom: 0, width: 8 };

  /* icon tiles are FROSTED GLASS — with the glassy-icons knob on they're
     REAL glass (actual backdrop-filter frost, see-through); without it
     they fall back to the flat translucent wash. themeIcons swaps in the
     brand tint (glass keeps a brand-tinted frost). */
  const tileStyle = (): React.CSSProperties => {
    if (iconGlass) {
      return {
        ...glassTileStyle(size),
        borderColor: "color-mix(in srgb, #ffffff 30%, transparent)",
      };
    }
    return {
      background: dock.themeIcons
        ? "color-mix(in srgb, var(--term-brand) 20%, var(--term-bg))"
        : TRANSLUCENT_TILE.background,
      borderColor: "color-mix(in srgb, var(--term-fg) 18%, transparent)",
      boxShadow: dock.themeIcons ? undefined : TRANSLUCENT_TILE.boxShadow,
    };
  };

  const iconColor = dock.themeIcons ? "var(--term-fg)" : "#fff";

  const renderItem = (opts: {
    key: string;
    label: string;
    running: boolean;
    active: boolean;
    onClick: () => void;
    icon?: LucideIcon;
    /** the AppId — when set, the icon is the REAL art (not a bare glyph) */
    appId?: AppId;
    /** installed web app — renders the site's ACTUAL favicon */
    pwa?: CustomApp;
    letter?: string;
  }) => {
    return (
      <button
        key={opts.key}
        ref={(el) => {
          if (el) itemRefs.current.set(opts.key, el);
          else itemRefs.current.delete(opts.key);
        }}
        type="button"
        aria-label={`${opts.label}${opts.running ? " — running" : ""}`}
        onClick={opts.onClick}
        onContextMenu={(e) => openItemCtx(e, opts.key, opts.label, opts.pwa)}
        className="dock-item group relative flex shrink-0 cursor-pointer flex-col items-center"
        style={{
          width: horizontal ? size + 6 : undefined,
          height: horizontal ? undefined : size + 6,
          justifyContent: "center",
          transformOrigin: horizontal ? "bottom center" : dock.position === "left" ? "left center" : "right center",
        }}
      >
        {/* hover label */}
        {dock.labels && (
          <span
            className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border px-2 py-0.5 text-[10.5px] lowercase tracking-wide opacity-0 transition-opacity group-hover:opacity-100"
            style={{
              ...(horizontal
                ? { bottom: size + 12 }
                : dock.position === "left"
                  ? { left: size + 12 }
                  : { right: size + 12 }),
              borderColor: "color-mix(in srgb, var(--term-fg) 18%, transparent)",
              background: "color-mix(in srgb, var(--term-bg) 88%, transparent)",
              color: "var(--term-fg)",
            }}
          >
            {opts.label}
          </span>
        )}
        {/* tile — the real icon art, or the themed glyph when recolor is on */}
        {opts.pwa ? (
          <PwaIcon
            url={opts.pwa.url}
            name={opts.pwa.name}
            size={size}
            skin="mac"
            theme={dock.themeIcons}
            glass={iconGlass}
            icon={opts.pwa.icon}
          />
        ) : opts.appId && !dock.themeIcons ? (
          <AppIcon app={opts.appId} size={size} skin="mac" glass={iconGlass} translucent />
        ) : (
          <span
            aria-hidden="true"
            className="relative flex items-center justify-center overflow-hidden rounded-[9px] border shadow-[0_3px_10px_rgba(0,0,0,0.3)] transition-shadow group-hover:shadow-[0_5px_16px_rgba(0,0,0,0.45)]"
            style={{ ...tileStyle(), width: size, height: size }}
          >
            {opts.icon ? (
              <opts.icon size={Math.round(size * 0.52)} strokeWidth={1.9} style={{ color: iconColor }} aria-hidden="true" />
            ) : (
              <span
                className="font-bold lowercase"
                style={{ color: dock.themeIcons ? "var(--term-fg)" : "#fff", fontSize: Math.round(size * 0.42) }}
              >
                {opts.letter}
              </span>
            )}
          </span>
        )}
        {/* running indicator — dot / line / none */}
        {dock.indicator !== "none" && (
          <span
            aria-hidden="true"
            className="rounded-full transition-all"
            style={
              dock.indicator === "line"
                ? {
                    width: opts.running ? Math.round(size * 0.48) : 0,
                    height: 2.5,
                    marginTop: horizontal ? 3 : 0,
                    marginLeft: horizontal ? 0 : 3,
                    backgroundColor: opts.active ? "var(--term-brand)" : "var(--term-fg)",
                    opacity: opts.running ? (opts.active ? 0.95 : 0.45) : 0,
                  }
                : {
                    width: 3,
                    height: 3,
                    marginTop: horizontal ? 2 : 0,
                    marginLeft: horizontal ? 0 : 2,
                    backgroundColor: "var(--term-fg)",
                    opacity: opts.running ? (opts.active ? 0.95 : 0.4) : 0,
                  }
            }
          />
        )}
      </button>
    );
  };

  return (
    <>
      {/* reveal sentinel for autohide — ALWAYS mounted while autohide is on:
          a quick graze that never reaches the bar must still HIDE it again
          (the old version unmounted the sentinel on peek and a graze left
          the dock stranded on screen forever) */}
      {dock.autohide && (
        <div
          aria-hidden="true"
          className="fixed z-[79]"
          style={stripPos}
          onPointerEnter={() => setPeek(true)}
          onPointerLeave={() => setPeek(false)}
        />
      )}

      <nav
        aria-label="dock"
        className="fixed z-[80] flex border"
        style={{
          /* frost is NOT on the panel itself — it's the FrostLayer sibling
             below, so the glass icon tiles' own backdrop-filters sample it
             (a panel-level backdrop-filter would be a backdrop root and
             the tiles would refract nothing) */
          borderColor: "color-mix(in srgb, var(--term-fg) 13%, transparent)",
          background: `color-mix(in srgb, var(--term-bg) ${dock.opacity}%, transparent)`,
          boxShadow: glassShadow,
          /* NO overflow — clipping here is what killed the magnification pop */
          ...(horizontal
            ? { bottom: 5, left: "50%", borderRadius: dock.radius, maxWidth: "calc(100vw - 10px)", padding: "3px 5px" }
            : dock.position === "left"
              ? { left: 5, top: "50%", borderRadius: dock.radius, maxHeight: "calc(100vh - 36px)", padding: "5px 3px" }
              : { right: 5, top: "50%", borderRadius: dock.radius, maxHeight: "calc(100vh - 36px)", padding: "5px 3px" }),
          flexDirection: horizontal ? "row" : "column",
          alignItems: horizontal ? "flex-end" : "center",
          transform: hideTransform,
          transformOrigin: horizontal ? "bottom center" : dock.position === "left" ? "left center" : "right center",
          transition: "transform 260ms cubic-bezier(.32,.72,.34,1), opacity 200ms ease",
          opacity: hidden ? 0 : 1,
          pointerEvents: hidden ? "none" : "auto",
        }}
        onPointerLeave={() => {
          if (dock.autohide) setPeek(false);
          onStripLeave();
        }}
        onContextMenu={(e) => {
          /* the dock panel itself — background menu (item menus stopPropagation) */
          e.preventDefault();
          setCtx({ x: e.clientX, y: e.clientY, appId: "", label: "dock", running: false, bg: true });
        }}
      >
        {/* the panel's frost, as a sibling layer the glass tiles refract */}
        <FrostLayer
          filter={
            distort
              ? `url(#murke-glass-distort) blur(${dock.blur}px) saturate(1.65) brightness(1.08)`
              : `blur(${dock.blur}px) saturate(1.55) brightness(1.07)`
          }
        />

        {/* specular skin — under the icons, over the refracted backdrop */}
        <span aria-hidden="true" className="murke-glass-sheen pointer-events-none absolute inset-0 rounded-[inherit]" />

        <div
          className="relative flex min-w-0"
          style={{ flexDirection: horizontal ? "row" : "column", alignItems: horizontal ? "flex-end" : "center" }}
          onPointerEnter={onStripEnter}
          onPointerMove={onStripMove}
        >
          {/* launchpad — the fullscreen app grid, always first in the strip */}
          {renderItem({
            key: "launchpad",
            label: "launchpad",
            running: false,
            active: false,
            /* the state flip rides a CustomEvent (like the spotlight hotkey):
               a setState straight in the tile's onClick mounts the fullscreen
               overlay mid-dispatch and React 19 discards the whole pass */
            onClick: () => window.dispatchEvent(new CustomEvent("murke-launchpad")),
            icon: LayoutGrid,
          })}

          {DOCK_APPS.map((a) => {
            const win = running.get(a.id);
            return renderItem({
              key: a.id,
              label: a.label,
              running: Boolean(win),
              active: Boolean(win && win.id === activeId && !win.min),
              onClick: () => activate(a.id),
              icon: a.icon,
              appId: a.id,
            });
          })}

          {/* custom "installed" web apps — the PWA addon shelf (favicons are
              the real site logos; the letter fallback wears the frosted tile) */}
          {customApps.map((app) => {
            const win = runningPwa.get(app.id);
            return renderItem({
              key: app.id,
              label: app.name,
              running: Boolean(win),
              active: Boolean(win && win.id === activeId && !win.min),
              onClick: () => openCustom(app),
              pwa: app,
              letter: app.name.trim().charAt(0).toUpperCase() || "?",
            });
          })}
        </div>

        {/* separator + settings */}
        <span
          aria-hidden="true"
          className="relative shrink-0"
          style={{
            backgroundColor: "color-mix(in srgb, var(--term-fg) 16%, transparent)",
            ...(horizontal ? { width: 1, height: size * 0.72, margin: "0 4px", alignSelf: "center" } : { height: 1, width: size * 0.72, margin: "4px 0", alignSelf: "center" }),
          }}
        />
        {renderItem({
          key: "settings",
          label: "settings",
          running: running.has("settings"),
          active: Boolean(running.get("settings")?.id === activeId),
          onClick: () => activate("settings" as AppId),
          icon: SettingsIcon,
          appId: "settings",
        })}

        {/* trash — opens the finder at the hidden trash folder */}
        {renderItem({
          key: "trash",
          label: "trash",
          running: false,
          active: false,
          onClick: () => openApp("files", "~/.Trash"),
          icon: Trash2,
        })}
      </nav>

      {/* right-click context menu — dock items + the dock background */}
      {ctx &&
        (() => {
          const isLauncher = ctx.appId === "launchpad" || ctx.appId === "trash";
          const appish = !ctx.bg && !isLauncher;
          const items: Array<{ label: string; disabled?: boolean; run: () => void }> = [];
          if (appish) {
            items.push({ label: "show", disabled: !ctx.running, run: () => focusFirst(ctx.appId, ctx.pwa) });
            items.push({ label: "quit", disabled: !ctx.running, run: () => quitApp(ctx.appId, ctx.pwa) });
          }
          const pwa = ctx.pwa;
          if (pwa) {
            items.push({ label: "open in browser", run: () => openApp("browser", pwa.url) });
            /* one click gone — off the dock, launchpad, spotlight and the
               start menu at once (they all read the same app list) */
            items.push({
              label: "remove from dock",
              run: () => {
                quitApp(pwa.id, pwa);
                useOS.getState().removeCustomApp(pwa.id);
              },
            });
          }
          items.push({ label: ctx.bg ? "dock settings\u2026" : "options", run: () => openApp("settings", "dock") });
          items.push({ label: "add app\u2026", run: () => requestAddApp() });
          const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
          const vh = typeof window !== "undefined" ? window.innerHeight : 800;
          return (
            <div
              ref={ctxRef}
              role="menu"
              aria-label={`${ctx.label} menu`}
              className="fixed z-[110] min-w-[160px] rounded-lg border py-1 font-mono text-[11px] lowercase shadow-[0_14px_40px_rgba(0,0,0,0.55)]"
              style={{
                left: Math.max(4, Math.min(ctx.x, vw - 176)),
                top: Math.max(4, Math.min(ctx.y, vh - 52 - items.length * 30)),
                borderColor: "color-mix(in srgb, var(--term-fg) 14%, transparent)",
                background: "color-mix(in srgb, var(--term-bg) 88%, transparent)",
                backdropFilter: "blur(14px) saturate(1.4)",
                WebkitBackdropFilter: "blur(14px) saturate(1.4)",
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setCtx(null);
                    item.run();
                  }}
                  className={`flex w-full items-center px-3 py-[7px] text-left tracking-wide transition-colors ${
                    item.disabled
                      ? "cursor-default opacity-35"
                      : "cursor-pointer hover:bg-[color-mix(in_srgb,var(--term-brand)_20%,transparent)]"
                  }`}
                  style={{ color: "var(--term-fg)" }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          );
        })()}

      {/* the spotlight palette + the launchpad grid */}
      <Launchpad open={launchpadOpen} onClose={() => setLaunchpadOpen(false)} />
      <Spotlight open={spotOpen} onClose={() => setSpotOpen(false)} />
    </>
  );
}
