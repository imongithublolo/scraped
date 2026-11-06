"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { MENUBAR_H, resolveMeta } from "@/lib/murke/appmeta";
import type { OsSkin } from "@/lib/murke/themes";
import type { SnapZone, WinState } from "@/lib/murke/os-store";
import { desktopBounds, useOS } from "@/lib/murke/os-store";
import { makeZoneChecker } from "@/lib/murke/snap";
import { useGlass } from "./GlassDefs";

/**
 * MacWindow — macOS-style window chrome around any app body.
 *
 *  - traffic lights: close (red) · minimize (yellow) · zoom (green); glyphs
 *    appear on hover of the light cluster, dots gray out when unfocused
 *  - drag: pointer-captured title bar (iframes can't steal the gesture);
 *    double-click zooms; hyprland-style snapping — dragging into a screen
 *    edge/corner arms a translucent zone preview (SnapPreview), dropping
 *    snaps the window there (edge thresholds in lib/murke/snap.ts)
 *  - resize: right + bottom + corner handles with per-app minimums
 *  - focus: any pointerdown raises the window (store z-order)
 *  - minimize: shrinks toward the dock, then hides; dock click restores
 *  - integrated chrome (meta.chrome === "tabs"): the app portals its own
 *    top bar into the title bar and the traffic lights stay on the LEFT
 *    edge (safari convention) — one bar instead of two
 */

/**
 * The title-bar hand-off: apps with integrated chrome portal their tab strip
 * into this element. null until the window's title bar has mounted.
 */
const TitlebarSlotContext = createContext<HTMLElement | null>(null);

/** Portal target for the app's own top bar (browser tabs etc). */
export function useTitlebarSlot(): HTMLElement | null {
  return useContext(TitlebarSlotContext);
}

/* traffic-light cluster — the mac skin's window controls */
function TrafficLights({ win, meta, focused }: { win: WinState; meta: { fixed?: boolean }; focused: boolean }) {
  const closeWindow = useOS((s) => s.closeWindow);
  const minimizeWindow = useOS((s) => s.minimizeWindow);
  const toggleZoom = useOS((s) => s.toggleZoom);
  const dot = (color: string) => ({ backgroundColor: focused ? color : "#56565a" });
  return (
    <>
      <button
        type="button"
        aria-label="close window"
        onClick={() => closeWindow(win.id)}
        className="mac-light group flex h-3 w-3 cursor-pointer items-center justify-center rounded-full border border-black/25"
        style={dot("#ff5f57")}
      >
        <span className="text-[8px] font-bold leading-none text-black/60 opacity-0 transition-opacity group-hover:opacity-100">✕</span>
      </button>
      <button
        type="button"
        aria-label="minimize window"
        onClick={() => minimizeWindow(win.id)}
        className="mac-light group flex h-3 w-3 cursor-pointer items-center justify-center rounded-full border border-black/25"
        style={dot("#febc2e")}
      >
        <span className="text-[9px] font-bold leading-none text-black/60 opacity-0 transition-opacity group-hover:opacity-100">−</span>
      </button>
      {!meta.fixed && (
        <button
          type="button"
          aria-label={win.zoom ? "restore window" : "zoom window"}
          onClick={() => toggleZoom(win.id)}
          className="mac-light group flex h-3 w-3 cursor-pointer items-center justify-center rounded-full border border-black/25"
          style={dot("#28c840")}
        >
          <span className="text-[8px] font-bold leading-none text-black/60 opacity-0 transition-opacity group-hover:opacity-100">⤢</span>
        </button>
      )}
    </>
  );
}

/* window-controls cluster — the WINDOWS skin's title bar buttons:
   –  □  ✕ as flat squares on the right, close tints the win red */
function WinControls({ win, meta }: { win: WinState; meta: { fixed?: boolean } }) {
  const closeWindow = useOS((s) => s.closeWindow);
  const minimizeWindow = useOS((s) => s.minimizeWindow);
  const toggleZoom = useOS((s) => s.toggleZoom);
  const base =
    "flex h-full w-[44px] cursor-pointer items-center justify-center text-[var(--term-fg)] transition-colors";
  const hover = (el: HTMLElement) => (el.style.background = "color-mix(in srgb, var(--term-fg) 12%, transparent)");
  const leave = (el: HTMLElement) => (el.style.background = "transparent");
  return (
    <div className="flex h-full shrink-0 items-stretch" data-nodrag>
      <button
        type="button"
        aria-label="minimize window"
        onClick={() => minimizeWindow(win.id)}
        className={base}
        onPointerEnter={(e) => hover(e.currentTarget)}
        onPointerLeave={(e) => leave(e.currentTarget)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      {!meta.fixed && (
        <button
          type="button"
          aria-label={win.zoom ? "restore window" : "maximize window"}
          onClick={() => toggleZoom(win.id)}
          className={base}
          onPointerEnter={(e) => hover(e.currentTarget)}
          onPointerLeave={(e) => leave(e.currentTarget)}
        >
          {win.zoom ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
      )}
      <button
        type="button"
        aria-label="close window"
        onClick={() => closeWindow(win.id)}
        className={base}
        onPointerEnter={(e) => {
          e.currentTarget.style.background = "#e81123";
          e.currentTarget.style.color = "#ffffff";
        }}
        onPointerLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "";
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}

export default function MacWindow({
  win,
  focused,
  skin = "mac",
  children,
}: {
  win: WinState;
  focused: boolean;
  /** which chrome the active theme ships — windows swaps the title bar */
  skin?: OsSkin;
  children: React.ReactNode;
}) {
  const focusWindow = useOS((s) => s.focusWindow);
  const resizeWindow = useOS((s) => s.resizeWindow);
  const customApps = useOS((s) => s.settings.customApps);
  const meta = resolveMeta(win.app, win.arg, customApps);

  /** suppress transitions while dragging/resizing so the window tracks 1:1 */
  const [interacting, setInteracting] = useState(false);

  /* integrated chrome: the DOM node the app portals its tab strip into */
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const integrated = meta.chrome === "tabs";

  /* ---------- drag ----------
     NATIVE listeners on the title bar, not React handlers: the browser
     portals its tab strip into the bar, and React synthetic events follow
     the FIBER tree (portal content bubbles through BrowserView, never
     through this title bar). Real DOM events bubble through the real DOM
     (strip → slot → bar), so native listeners see every gesture. */
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);

  /* ---------- drag → snap (hyprland-style) ----------
     zone hits are rAF-throttled; the checker reads live bounds each frame
     so a mid-drag viewport change can't go stale */
  const [snapArmed, setSnapArmed] = useState(false);
  const snapZoneRef = useRef<SnapZone | null>(null);
  const snapRafRef = useRef(0);
  const snapPtRef = useRef({ x: 0, y: 0 });
  const scheduleSnap = useCallback((cx: number, cy: number) => {
    snapPtRef.current = { x: cx, y: cy };
    if (snapRafRef.current) return;
    snapRafRef.current = window.requestAnimationFrame(() => {
      snapRafRef.current = 0;
      if (!dragRef.current?.moved) return;
      if (!useOS.getState().settings.wm.snap) return;
      const p = snapPtRef.current;
      const zone = makeZoneChecker(desktopBounds())(p.x, p.y);
      if (zone === snapZoneRef.current) return;
      snapZoneRef.current = zone;
      setSnapArmed(zone !== null);
      useOS.getState().setSnapPreview(zone);
    });
  }, []);

  /* wire the title-bar gesture listeners once — geometry is read live from
     the store at pointerdown so the effect never goes stale */
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const id = win.id;
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-nodrag]")) return;
      if (e.button !== 0) return;
      const cur = useOS.getState().windows.find((w) => w.id === id);
      if (!cur) return;
      useOS.getState().focusWindow(id);
      dragRef.current = { px: e.clientX, py: e.clientY, x: cur.x, y: cur.y, moved: false };
      setInteracting(true);
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved && Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 3) d.moved = true;
      useOS.getState().moveWindow(id, d.x + (e.clientX - d.px), d.y + (e.clientY - d.py));
      if (d.moved && useOS.getState().settings.wm.snap) scheduleSnap(e.clientX, e.clientY);
    };
    const up = (e: PointerEvent) => {
      if (!dragRef.current) return;
      if (snapRafRef.current) {
        window.cancelAnimationFrame(snapRafRef.current);
        snapRafRef.current = 0;
      }
      const d = dragRef.current;
      dragRef.current = null;
      snapZoneRef.current = null;
      setSnapArmed(false);
      /* flip interacting off first, then write the snap — React batches both,
         so the committed render animates old geometry → zone rect */
      setInteracting(false);
      let zone: SnapZone | null = null;
      if (d?.moved && useOS.getState().settings.wm.snap) {
        zone = makeZoneChecker(desktopBounds())(e.clientX, e.clientY);
      }
      if (zone) useOS.getState().snapWindow(id, zone);
      else useOS.getState().setSnapPreview(null);
    };
    const cancel = () => {
      if (!dragRef.current) return;
      if (snapRafRef.current) {
        window.cancelAnimationFrame(snapRafRef.current);
        snapRafRef.current = 0;
      }
      dragRef.current = null;
      snapZoneRef.current = null;
      setSnapArmed(false);
      setInteracting(false);
      useOS.getState().setSnapPreview(null);
    };
    const dbl = (e: MouseEvent) => {
      /* double-clicking a tab/close/plus must not zoom the window */
      if ((e.target as HTMLElement).closest("[data-nodrag]")) return;
      useOS.getState().toggleZoom(id);
    };
    bar.addEventListener("pointerdown", down);
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", cancel);
    bar.addEventListener("dblclick", dbl);
    return () => {
      bar.removeEventListener("pointerdown", down);
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", cancel);
      bar.removeEventListener("dblclick", dbl);
    };
  }, [scheduleSnap, win.id]);

  /* if this window unmounts mid-drag (closed under the gesture), drop any armed preview */
  useEffect(
    () => () => {
      if (snapRafRef.current) window.cancelAnimationFrame(snapRafRef.current);
      if (snapZoneRef.current) useOS.getState().setSnapPreview(null);
    },
    [],
  );

  /* ---------- resize (direction-aware: right / bottom / corner) ---------- */
  const resizeRef = useRef<{ dir: "r" | "b" | "c"; px: number; py: number; x: number; y: number; w: number; h: number } | null>(null);
  const onResizeDown = useCallback(
    (dir: "r" | "b" | "c") => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      focusWindow(win.id);
      resizeRef.current = { dir, px: e.clientX, py: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h };
      setInteracting(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [focusWindow, win.id, win.x, win.y, win.w, win.h],
  );
  const onResizeMove = useCallback(
    (e: React.PointerEvent) => {
      const d = resizeRef.current;
      if (!d) return;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      const w = d.dir === "b" ? d.w : d.w + dx;
      const h = d.dir === "c" || d.dir === "b" ? d.h + dy : d.h;
      if (d.dir === "c") resizeWindow(win.id, w, h, d.x, d.y);
      else resizeWindow(win.id, w, h);
    },
    [resizeWindow, win.id],
  );
  const onResizeUp = useCallback(() => {
    resizeRef.current = null;
    setInteracting(false);
  }, []);

  /* the window BODY is the glass — wallpaper refracts through it, tuned by
     settings › glass (off = solid panels, visibility first) */
  const bodyGlass = useGlass({ distort: true, weight: 0.8 });

  return (
    <TitlebarSlotContext.Provider value={slotEl}>
    <section
      role="dialog"
      aria-label={meta.label}
      aria-hidden={win.min || undefined}
      inert={win.min || undefined}
      onPointerDown={() => focusWindow(win.id)}
      className={`mac-window absolute flex flex-col overflow-hidden border font-mono ${
        skin === "win" ? "rounded-[8px]" : "rounded-[10px]"
      } ${win.closing ? "mac-window-close" : win.min ? "" : "mac-window-open"}`}
      style={{
        left: win.x,
        top: win.y,
        width: win.w,
        height: win.h,
        zIndex: 10 + win.z,
        borderColor: focused
          ? "color-mix(in srgb, var(--term-fg) 26%, transparent)"
          : "color-mix(in srgb, var(--term-fg) 12%, transparent)",
        boxShadow: `${snapArmed ? "0 0 0 1.5px color-mix(in srgb, var(--term-brand) 60%, transparent), " : ""}${
          focused ? "0 24px 70px rgba(0,0,0,0.55), 0 2px 10px rgba(0,0,0,0.35)" : "0 12px 34px rgba(0,0,0,0.32)"
        }`,
        background: bodyGlass.enabled
          ? `color-mix(in srgb, var(--term-bg) ${Math.max(46, bodyGlass.alpha)}%, transparent)`
          : "var(--term-bg)",
        backdropFilter: bodyGlass.filter ?? undefined,
        WebkitBackdropFilter: bodyGlass.filter ?? undefined,
        transition: interacting
          ? "none"
          : "transform 200ms cubic-bezier(.32,.72,.34,1), opacity 200ms ease, left 120ms ease, top 120ms ease, width 120ms ease, height 120ms ease",
        transform: win.min ? "translateY(48vh) scale(0.06)" : "none",
        opacity: win.min || win.closing ? 0 : 1,
        pointerEvents: win.min ? "none" : "auto",
      }}
    >
      {/* ---------- title bar ---------- */}
      <div
        ref={barRef}
        className={`relative flex h-9 shrink-0 cursor-grab items-center active:cursor-grabbing ${
          skin === "mac" ? (integrated ? "pl-3 pr-2" : "border-b pl-3 pr-3") : "pl-3"
        }`}
        style={{
          fontFamily: skin === "mac" ? undefined : "var(--chrome-font)",
          borderColor: "color-mix(in srgb, var(--term-fg) 12%, transparent)",
          background: "color-mix(in srgb, var(--term-bg) 62%, transparent)",
        }}
      >
        {skin === "mac" ? (
          integrated ? (
            /* browser layout: traffic lights on the LEFT — safari-style — the
               app's tab strip fills the rest of the bar */
            <>
              <div className="mr-2 flex shrink-0 items-center gap-2 pr-1" data-nodrag>
                <TrafficLights win={win} meta={meta} focused={focused} />
              </div>
              <div
                ref={setSlotEl}
                className="flex h-full min-w-0 flex-1 items-stretch overflow-hidden"
              />
            </>
          ) : (
            <>
              {/* traffic lights */}
              <div className="flex items-center gap-2" data-nodrag>
                <TrafficLights win={win} meta={meta} focused={focused} />
              </div>

              {/* centered title */}
              <span
                className={`pointer-events-none absolute left-1/2 -translate-x-1/2 truncate text-[11px] lowercase tracking-[0.14em] ${
                  focused ? "text-[color-mix(in_srgb,var(--term-fg)_78%,transparent)]" : "text-[var(--term-dim)]"
                }`}
              >
                {meta.label}
              </span>
            </>
          )
        ) : (
          /* windows layout: app tabs (browser) or the title on
             the LEFT, flat square controls hugging the right edge */
          <>
            {integrated ? (
              <div ref={setSlotEl} className="flex h-full min-w-0 flex-1 items-stretch overflow-hidden" />
            ) : (
              <>
                <span
                  className={`pointer-events-none max-w-[60%] truncate text-[12px] ${
                    focused ? "text-[color-mix(in_srgb,var(--term-fg)_82%,transparent)]" : "text-[var(--term-dim)]"
                  }`}
                >
                  {meta.label}
                </span>
                <span className="flex-1" />
              </>
            )}
            <WinControls win={win} meta={meta} />
          </>
        )}
      </div>

      {/* ---------- app body ---------- */}
      <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>

      {/* ---------- resize handles ---------- */}
      {!meta.fixed && !win.zoom && (
        <>
          <div
            data-nodrag
            onPointerDown={onResizeDown("r")}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            aria-hidden="true"
            className="absolute bottom-2 right-0 top-9 z-10 w-1.5 cursor-ew-resize"
          />
          <div
            data-nodrag
            onPointerDown={onResizeDown("b")}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            aria-hidden="true"
            className="absolute bottom-0 left-2 right-2 z-10 h-1.5 cursor-ns-resize"
          />
          <div
            data-nodrag
            onPointerDown={onResizeDown("c")}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            onPointerCancel={onResizeUp}
            aria-hidden="true"
            className="absolute bottom-0 right-0 z-10 h-4 w-4 cursor-nwse-resize"
          />
        </>
      )}
    </section>
    </TitlebarSlotContext.Provider>
  );
}

/** menubar-height context for zoom clamps (exported for Desktop) */
export { MENUBAR_H };
