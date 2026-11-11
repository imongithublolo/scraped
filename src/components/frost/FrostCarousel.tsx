"use client";

/**
 * FrostCarousel — the tab overview, a stacked 3D deck (the carousel-07
 * design): a transparent drag surface drives a spring-settled progress
 * value, and every card floats at its wrapped offset — x drift,
 * rotation, rise, scale and edge fade all read straight off that one
 * motion value.
 *
 * Each card IS a tab, rendered as pure liquid glass: favicon, title, url
 * and a live RAM meter — NO screenshot capture (html2canvas clones the
 * whole proxied document on the main thread; that was the lag). The
 * deck opens instantly and a click always lands: a drag/scroll suppresses
 * activation only for the instant it happened, never permanently.
 *
 * "+ New Tab" is NOT a card in the deck — it's a real button riding the
 * overlay's corner. The deck itself is fully keyboard-driven: ←/→ walk
 * the cards, Enter activates the centered one, Esc drops the overlay.
 * Keys typed INSIDE a proxied page reach the deck too (the stage
 * re-dispatches frame keys while the overview is up).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useTransform,
  type MotionValue,
  type PanInfo,
} from "framer-motion";
import { GlobeGlyph } from "./EngineGlyph";
import type { FrostTabInfo } from "./frost-tab-info";

/* ------------------------------------------------------------------ */
/* the deck's physics — straight from carousel-07                      */
/* ------------------------------------------------------------------ */

interface CarouselConfig {
  distanceDivisor: number;
  velocityDivisor: number;
  sensitivity: number;
  xMultiplier: number;
  yMultiplier: number;
  rotationMultiplier: number;
  scaleReduction: number;
}

const getCarouselConfig = (width: number): CarouselConfig => {
  if (width < 640) {
    return { distanceDivisor: 120, velocityDivisor: 500, sensitivity: 180, xMultiplier: 90, yMultiplier: 20, rotationMultiplier: 8, scaleReduction: 0.06 };
  }
  if (width < 1024) {
    return { distanceDivisor: 160, velocityDivisor: 650, sensitivity: 220, xMultiplier: 130, yMultiplier: 30, rotationMultiplier: 10, scaleReduction: 0.09 };
  }
  return { distanceDivisor: 200, velocityDivisor: 800, sensitivity: 250, xMultiplier: 170, yMultiplier: 40, rotationMultiplier: 12, scaleReduction: 0.12 };
};

const OVERLAY_SPRING = { type: "spring" as const, stiffness: 340, damping: 30, mass: 0.9 };
const DECK_SPRING = { type: "spring" as const, stiffness: 200, damping: 30, mass: 1 };

/* a click right after a REAL drag/scroll must not activate a card — but
   only for a breath. The old sticky boolean stayed set after any wheel
   tick, so the first click after scrolling did nothing at all (the
   "clicking it doesn't open the tab" bug). */
let lastInteractAt = 0;
const markInteract = () => {
  lastInteractAt = Date.now();
};
const clickIsReal = () => Date.now() - lastInteractAt > 160;

/* ------------------------------------------------------------------ */
/* the deck                                                            */
/* ------------------------------------------------------------------ */

/** a tab's rough memory weight — DOM size drives it; the active tab's
    live JS heap, when the browser exposes one, sharpens the number */
function tabRam(nodes: number, liveHeapMb: number | null): number {
  const est = 1.4 + nodes / 900;
  return liveHeapMb !== null ? Math.max(est, liveHeapMb * 0.28) : est;
}

/* ------------------------------------------------------------------ */
/* the snowflake + favicon (shared with the rail)                      */
/* ------------------------------------------------------------------ */

/** a minimal snowflake — the mark of a fresh new tab */
export function SnowGlyph(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...p}>
      <path
        fill="currentColor"
        d="M12 2a1 1 0 0 1 1 1v2.6l1.8-1.05a1 1 0 1 1 1 1.73L14 7.6V11l3-1.73.2-2.3a1 1 0 1 1 2 .17l-.13 1.5 1.3-.75a1 1 0 0 1 1 1.73l-1.3.75 1.43.5a1 1 0 1 1-.67 1.89l-2.2-.78L15 13l2.63 1.52 2.2-.78a1 1 0 1 1 .67 1.89l-1.43.5 1.3.75a1 1 0 0 1-1 1.73l-1.3-.75.13 1.5a1 1 0 1 1-2 .17L17 18.73 14 17v3.4l1.8 1.05a1 1 0 1 1-1 1.73L13 22.4V23a1 1 0 1 1-2 0v-.6l-1.8 1.05a1 1 0 1 1-1-1.73L10 20.4V17l-3 1.73-.2 2.3a1 1 0 1 1-2-.17l.13-1.5-1.3.75a1 1 0 0 1-1-1.73l1.3-.75-1.43-.5a1 1 0 1 1 .67-1.89l2.2.78L9 13l-2.63-1.52-2.2.78a1 1 0 1 1-.67-1.89l1.43-.5-1.3-.75a1 1 0 0 1 1-1.73l1.3.75-.13-1.5a1 1 0 1 1 2-.17l.2 2.3L10 7.6V4.4L8.2 3.35a1 1 0 1 1 1-1.73L11 2.6V3a1 1 0 0 1 1-1z"
        opacity={0.9}
      />
    </svg>
  );
}

/** one tab's favicon — the site's real one, same-origin, quiet fallback */
export function TabFavicon({ url, size = 28 }: { url: string | null; size?: number }) {
  const ref = useRef<HTMLImageElement>(null);
  if (url === null) {
    return (
      <span className="frost-tab-glyph" style={{ width: size, height: size }} aria-hidden="true">
        <SnowGlyph />
      </span>
    );
  }
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    origin = "";
  }
  return (
    <span className="frost-tab-glyph" style={{ width: size, height: size }} aria-hidden="true">
      {origin ? (
        <img
          ref={ref}
          src={`/api/favicon?u=${encodeURIComponent(origin)}`}
          alt=""
          draggable={false}
          onError={() => {
            ref.current?.remove();
          }}
        />
      ) : (
        <GlobeGlyph />
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* the deck                                                            */
/* ------------------------------------------------------------------ */

export default function FrostCarousel({
  open,
  tabs,
  activeId,
  onActivate,
  onClose,
  onNew,
  onRequestClose,
  frameFor,
}: {
  open: boolean;
  tabs: FrostTabInfo[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onRequestClose: () => void;
  /** live frame handles — previews and ram read from the real iframes */
  frameFor?: (id: string) => { el: HTMLIFrameElement } | null | undefined;
}) {
  const scrollProgress = useMotionValue(0);
  const startProgress = useRef(0);
  /* client-only tree (HomeStage is ssr:false) — window is safe to read here */
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 0,
  );
  const [ram, setRam] = useState<Record<string, number>>({});
  const wrapRef = useRef<HTMLDivElement>(null);

  const total = tabs.length;

  /* open on the active card, focus the overlay so keys land */
  useEffect(() => {
    if (!open) return;
    const idx = Math.max(0, tabs.findIndex((t) => t.id === activeId));
    scrollProgress.set(idx);
    lastInteractAt = 0; // a fresh open always trusts the first click
    window.setTimeout(() => wrapRef.current?.focus(), 50);
  }, [open, activeId, tabs, scrollProgress]);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const config = useMemo(() => getCarouselConfig(windowWidth), [windowWidth]);

  /* the ram meters tick while the deck is up */
  useEffect(() => {
    if (!open) return;
    const read = () => {
      const next: Record<string, number> = {};
      let liveHeapMb: number | null = null;
      const perfMem = (
        performance as Performance & { memory?: { usedJSHeapSize: number } }
      ).memory;
      if (perfMem) liveHeapMb = perfMem.usedJSHeapSize / 1_048_576;
      for (const t of tabs) {
        if (t.url === null) continue;
        try {
          const handle = frameFor?.(t.id);
          const doc = handle ? handle.el.contentDocument : null;
          const nodes = doc ? doc.querySelectorAll("*").length : 0;
          next[t.id] = tabRam(nodes, t.id === activeId ? liveHeapMb : null);
        } catch {
          next[t.id] = 2.4; // cross-origin moment — the floor estimate
        }
      }
      setRam(next);
    };
    read();
    const iv = window.setInterval(read, 2500);
    return () => window.clearInterval(iv);
  }, [open, tabs, activeId]);  

  /* trackpad + wheel — see the native listener below (the settle timer's
     ref is declared there; a grab cancels any pending settle) */
  const handleDragStart = useCallback(() => {
    startProgress.current = scrollProgress.get();
    wheelSettle.current = 0; // a grab cancels any pending wheel settle
  }, [scrollProgress]);

  /* the deck spins FOREVER — progress is unbounded and every card reads
     its wrapped offset, so ← ← ← wraps around the end and back */
  const handleDrag = useCallback(
    (_: unknown, info: PanInfo) => {
      if (Math.abs(info.offset.x) > 6) markInteract();
      const delta = -info.delta.x / config.sensitivity;
      scrollProgress.set(scrollProgress.get() + delta);
    },
    [config.sensitivity, scrollProgress],
  );

  const handleDragEnd = useCallback(
    (_: unknown, info: PanInfo) => {
      const distanceShift = -info.offset.x / config.distanceDivisor;
      const velocityShift = -info.velocity.x / config.velocityDivisor;
      let totalShift = Math.round(distanceShift + velocityShift);
      totalShift = Math.max(-4, Math.min(4, totalShift));
      animate(scrollProgress, Math.round(startProgress.current) + totalShift, DECK_SPRING);
    },
    [config, scrollProgress],
  );

  /* trackpad + wheel — a NATIVE listener on the overlay (React's
     delegated onWheel never fires through the motion components):
     horizontal two-finger swipes (deltaX) drive the deck, plain wheels
     fall back to deltaY. Momentum events stream in; once they pause the
     deck springs to the nearest card. */
  const wheelSettle = useRef<number>(0);
  useEffect(() => {
    if (!open) return;
    const el = wrapRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      const delta = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      markInteract(); // a click in the same breath must not pick a card
      window.clearTimeout(wheelSettle.current);
      scrollProgress.set(scrollProgress.get() + delta / 90);
      wheelSettle.current = window.setTimeout(() => {
        animate(scrollProgress, Math.round(scrollProgress.get()), DECK_SPRING);
      }, 140);
    };
    el.addEventListener("wheel", onWheelNative, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheelNative);
      window.clearTimeout(wheelSettle.current);
    };
  }, [open, scrollProgress]);

  /* the keyboard — arrows walk, enter picks, esc drops. Capture-phase on
     window: it hears keys typed over the parent page AND the synthetic
     events the stage re-dispatches from inside the proxied frame. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onRequestClose();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        animate(scrollProgress, Math.round(scrollProgress.get()) + dir, DECK_SPRING);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const idx = ((Math.round(scrollProgress.get()) % total) + total) % total;
        const tab = tabs[idx];
        if (tab) onActivate(tab.id);
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onRequestClose, total, tabs, scrollProgress, onActivate]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={wrapRef}
          className="frost-carousel-wrap"
          tabIndex={-1}
          role="dialog"
          aria-label="tabs overview — arrow keys to browse, enter to switch, escape to close"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) onRequestClose();
          }}
        >
          <motion.div
            className="frost-carousel"
            initial={{ scale: 0.55, opacity: 0, y: 64 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.72, opacity: 0, y: 48 }}
            transition={OVERLAY_SPRING}
          >
            <div className="frost-carousel-hint" aria-hidden="true">
              scroll, drag or ← → to spin · enter to switch · esc to close
            </div>
            {/* the deck IS the drag surface: one gesture drives every
                card's wrapped offset — unbounded, so the deck spins forever
                in both directions; the spring settles after release */}
            <motion.div
              className="frost-deck"
              drag="x"
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0}
              dragMomentum={false}
              onDragStart={handleDragStart}
              onDrag={handleDrag}
              onDragEnd={handleDragEnd}
            >
              {tabs.map((t, i) => (
                <DeckCard
                  key={t.id}
                  tab={t}
                  index={i}
                  total={total}
                  progress={scrollProgress}
                  config={config}
                  ram={ram[t.id]}
                  isActive={t.id === activeId}
                  onActivate={onActivate}
                  onClose={onClose}
                />
              ))}
            </motion.div>
          </motion.div>

          {/* + New Tab — a real BUTTON, not a card in the deck */}
          <button type="button" className="frost-carousel-new" onClick={onNew} aria-label="new tab" title="New Tab">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
            <span>New Tab</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/* one card                                                            */
/* ------------------------------------------------------------------ */

interface DeckCardProps {
  tab: FrostTabInfo;
  index: number;
  total: number;
  progress: MotionValue<number>;
  config: CarouselConfig;
  ram: number | undefined;
  isActive: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

function DeckCard({ tab, index, total, progress, config, ram, isActive, onActivate, onClose }: DeckCardProps) {
  /* wrapped offset — reads the unbounded progress modulo the deck, then
     folds to the shortest path so card N-1 sits just left of card 0 */
  const offset = useTransform(progress, (p) => {
    if (total <= 0) return 0;
    let diff = (index - p) % total;
    if (diff > total / 2) diff -= total;
    if (diff < -total / 2) diff += total;
    return diff;
  });

  const x = useTransform(offset, (o) => o * config.xMultiplier);
  const rotate = useTransform(offset, (o) => (Math.abs(o) < 0.05 ? 0 : o * config.rotationMultiplier));
  const y = useTransform(offset, (o) => (Math.abs(o) < 0.05 ? 0 : Math.abs(o) * config.yMultiplier));
  const scale = useTransform(offset, (o) => 1 - Math.min(1.6, Math.abs(o)) * config.scaleReduction);
  /* neighbors stay visible — only the far background of a big deck fades
     (small decks keep every card on screen while they spin) */
  const opacity = useTransform(offset, (o) => {
    const a = Math.abs(o);
    if (a <= 1.7) return 1;
    return Math.max(0, 1 - (a - 1.7) / 1.3);
  });
  const zIndex = useTransform(offset, (o) => Math.round(100 - Math.abs(o) * 10));
  const veil = useTransform(offset, [-2, -0.5, 0, 0.5, 2], [0.5, 0.2, 0, 0.2, 0.5]);
  const labelOpacity = useTransform(offset, [-0.5, 0, 0.5], [0, 1, 0]);

  const mb = ram ?? 0;
  const fill = Math.min(100, Math.max(4, (mb / 64) * 100));
  const hot = mb > 32;

  return (
    <motion.div
      style={{ x, rotate, y, scale, opacity, zIndex }}
      className={`frost-deck-card ${isActive ? "frost-deck-card-active" : ""}`}
      onClick={() => {
        if (!clickIsReal()) return;
        onActivate(tab.id);
      }}
    >
      {/* the tab's face — its favicon riding liquid glass (no screenshots:
          rasterizing the proxied page was the whole lag) */}
      <div className="frost-deck-shot" aria-hidden="true">
        <span className="frost-deck-shot-fallback">
          <TabFavicon url={tab.url} size={46} />
        </span>
      </div>

      <motion.div style={{ opacity: veil }} className="frost-deck-veil" aria-hidden="true" />
      <div className="frost-deck-shade" aria-hidden="true" />

      <span className="frost-deck-badge">{isActive ? "active" : hostOf(tab.url) || "tab"}</span>

      <button
        type="button"
        className="frost-deck-x"
        role="button"
        aria-label={`close ${tab.title || "tab"}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
      </button>

      <div className="frost-deck-info">
        <motion.div style={{ opacity: labelOpacity }} className="frost-deck-info-in">
          <div className="frost-deck-title">{tab.title || hostOf(tab.url) || "New Tab"}</div>
          <div className="frost-deck-url">{tab.url === null ? "start fresh" : hostOf(tab.url)}</div>
        </motion.div>
        {/* the minimal ram meter */}
        <div className="frost-deck-ram" aria-label={`about ${mb.toFixed(1)} megabytes`}>
          <div className="frost-deck-ram-track">
            <div className={`frost-deck-ram-fill ${hot ? "frost-deck-ram-hot" : ""}`} style={{ width: `${fill}%` }} />
          </div>
          <span className="frost-deck-ram-val">{tab.url === null ? "idle" : `≈ ${mb.toFixed(1)} MB`}</span>
        </div>
      </div>
    </motion.div>
  );
}

function hostOf(raw: string | null): string {
  if (!raw) return "";
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0] || raw;
  }
}
