"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useWm, type WinState } from "@/lib/murke/wm";
import { useIsMobile } from "@/hooks/use-mobile";

/**
 * Window chrome: draggable titlebar, resize corner, min/max/close controls.
 * Pointer-capture based dragging that stays glued to the cursor even when it
 * leaves the element. Double-click the titlebar to toggle maximize.
 * On mobile viewports every window renders fullscreen (chrome stays).
 */

const MIN_W = 300;
const MIN_H = 200;

export default function Window({ win, children }: { win: WinState; children: ReactNode }) {
  const { focus, close, minimize, toggleMaximize, setBounds } = useWm();
  const active = useWm((s) => s.activeId === win.id);
  const mobile = useIsMobile();
  const full = win.maximized || mobile;

  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const resizeRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const onTitlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (full) return;
      if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
      focus(win.id);
      dragRef.current = { dx: e.clientX - win.x, dy: e.clientY - win.y };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [focus, full, win.id, win.x, win.y]
  );

  const onTitlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d) return;
      setBounds(win.id, { x: e.clientX - d.dx, y: Math.max(e.clientY - d.dy, 0) });
    },
    [setBounds, win.id]
  );

  const onTitlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onResizeDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (full) return;
      e.stopPropagation();
      focus(win.id);
      resizeRef.current = { x: e.clientX, y: e.clientY, w: win.w, h: win.h };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [focus, full, win.id, win.w, win.h]
  );

  const onResizeMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const r = resizeRef.current;
      if (!r) return;
      setBounds(win.id, {
        w: Math.max(r.w + (e.clientX - r.x), MIN_W),
        h: Math.max(r.h + (e.clientY - r.y), MIN_H),
      });
    },
    [setBounds, win.id]
  );

  const onResizeUp = useCallback(() => {
    resizeRef.current = null;
  }, []);

  /* keep resize capture handlers attached via window while resizing */
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      setBounds(win.id, {
        w: Math.max(r.w + (e.clientX - r.x), MIN_W),
        h: Math.max(r.h + (e.clientY - r.y), MIN_H),
      });
    };
    const up = () => {
      resizeRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [setBounds, win.id]);

  if (win.minimized) return null;

  const geo = full
    ? { left: 0, top: 0, width: "100%", height: "calc(100% - 48px)" }
    : { left: win.x, top: win.y, width: win.w, height: win.h };

  return (
    <section
      className={`daemon-win ${active ? "daemon-win-active" : ""} absolute flex flex-col overflow-hidden rounded-[3px]`}
      style={{ ...geo, zIndex: win.z }}
      onPointerDown={() => focus(win.id)}
      role="dialog"
      aria-label={win.title}
    >
      {/* titlebar */}
      <div
        className={`daemon-titlebar flex h-8 shrink-0 select-none items-center gap-2 border-b border-[color-mix(in_srgb,var(--term-brand)_35%,transparent)] px-2 ${
          full ? "" : "cursor-grab active:cursor-grabbing"
        }`}
        onPointerDown={onTitlePointerDown}
        onPointerMove={onTitlePointerMove}
        onPointerUp={onTitlePointerUp}
        onDoubleClick={() => toggleMaximize(win.id)}
      >
        <span
          className="text-[13px] leading-none text-[var(--term-brand)]"
          style={{ filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--term-brand) 70%, transparent))" }}
          aria-hidden="true"
        >
          ▲
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--term-fg)]">
          {win.title}
        </span>
        <div className="flex items-center gap-1" data-no-drag>
          <button
            className="daemon-win-btn h-5 w-6 font-mono text-[11px] leading-none text-[var(--term-dim)]"
            onClick={() => minimize(win.id)}
            aria-label={`minimize ${win.title}`}
            title="minimize"
          >
            —
          </button>
          <button
            className="daemon-win-btn h-5 w-6 font-mono text-[10px] leading-none text-[var(--term-dim)]"
            onClick={() => toggleMaximize(win.id)}
            aria-label={`maximize ${win.title}`}
            title="maximize"
          >
            □
          </button>
          <button
            className="daemon-win-btn h-5 w-6 font-mono text-[11px] leading-none text-[var(--term-dim)] hover:!bg-[#a11] hover:!text-white"
            onClick={() => close(win.id)}
            aria-label={`close ${win.title}`}
            title="close"
          >
            ✕
          </button>
        </div>
      </div>

      {/* content */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--term-bg)] text-[var(--term-fg)]">{children}</div>

      {/* resize grip */}
      {!full && (
        <div
          className="absolute bottom-0 right-0 z-20 h-4 w-4 cursor-nwse-resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          role="presentation"
          aria-hidden="true"
          style={{
            background:
              "linear-gradient(135deg, transparent 0 50%, color-mix(in srgb, var(--term-brand) 55%, transparent) 50% 55%, transparent 55% 65%, color-mix(in srgb, var(--term-brand) 55%, transparent) 65% 70%, transparent 70% 80%, color-mix(in srgb, var(--term-brand) 55%, transparent) 80% 85%, transparent 85%)",
          }}
        />
      )}
    </section>
  );
}
