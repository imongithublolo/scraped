"use client";

/**
 * GlassDefs — the shared SVG filter bank behind the OS "liquid glass",
 * plus the SETTINGS-DRIVEN glass engine every surface reads.
 *
 * The dock / menu bar / windows refract their backdrop through a soft
 * noise field (feTurbulence → feDisplacementMap), which bends what's
 * behind the glass at the edges — the liquid part of the look — before
 * blur/saturation finish the job. Chromium resolves url(#…) inside
 * backdrop-filter; every other engine gets plain blur via the same
 * helper (glassStyle).
 *
 * The filter is applied as an INLINE style on purpose: the CSS pipeline
 * (lightningcss) compiles `backdrop-filter` down to -webkit-only form,
 * which Chromium rejects — inline styles bypass that mangling.
 *
 * SETTINGS: useOS().settings.glass owns the whole engine — a master
 * toggle (off = solid panels everywhere), a blur slider, a tint slider
 * (how much wallpaper bleeds through) and a saturation slider. The
 * useGlass() hook re-renders consumers when any knob moves.
 *
 * Rendered ONCE by the Desktop shell; w/h 0 so it never paints.
 */

import { useMemo } from "react";
import { useOS } from "@/lib/murke/os-store";

export default function GlassDefs() {
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" style={{ position: "absolute", pointerEvents: "none" }}>
      <defs>
        <filter id="murke-glass-distort" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
          {/* slow, low-frequency ripple — reads as glass thickness, not noise */}
          <feTurbulence type="fractalNoise" baseFrequency="0.006 0.011" numOctaves="2" seed="92" result="ripple" />
          <feGaussianBlur in="ripple" stdDeviation="1.1" result="rippleSoft" />
          <feDisplacementMap in="SourceGraphic" in2="rippleSoft" scale="26" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
}

/** Chromium is the only engine that resolves url(#…) inside backdrop-filter.
 *  Guarded for SSR. Set once per component (useState) — the UA never flips. */
export function supportsGlassDistort(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Chrom(e|ium)/.test(navigator.userAgent);
}

/* ------------------------- the glass engine ------------------------- */

export interface GlassOpts {
  /** default true — the liquid displacement filter (chromium only) */
  distort?: boolean;
  /** extra opacity multiplier 0..1 layered over the tint (panel-specific) */
  weight?: number;
  /** when set, OVERRIDES the master switch (surfaces that must stay readable) */
  force?: boolean;
}

/**
 * Build the inline backdrop-filter + tint from the live glass settings.
 * Returns null-ish values when glass is OFF so callers fall back to solid
 * panels. Re-renders on any glass knob change.
 */
export function useGlass(opts: GlassOpts = {}): {
  enabled: boolean;
  filter: string | null;
  /** panel alpha: how OPAQUE the panel is (100 = solid) */
  alpha: number;
  saturate: number;
} {
  const glass = useOS((s) => s.settings.glass);
  return useMemo(() => {
    const enabled = (opts.force ?? glass.enabled) && glass.blur > 0;
    if (!enabled) return { enabled: false, filter: null, alpha: 100, saturate: 100 };
    const distort = opts.distort ?? true;
    const w = opts.weight ?? 1;
    const plain = `blur(${Math.round(glass.blur)}px) saturate(${Math.round((glass.saturate - 100) / 100 + 1.05)})`;
    const juicy = `url(#murke-glass-distort) blur(${Math.round(Math.max(8, glass.blur - 3))}px) saturate(${Math.round((glass.saturate - 100) / 100 + 1.1)}) brightness(1.06)`;
    const filter = distort ? juicy : plain;
    // tint 0..60 → panel alpha 100..40, weighted by the caller's preference
    const alpha = Math.round((100 - glass.tint * w) * 10) / 10;
    return { enabled: true, filter, alpha, saturate: glass.saturate };
  }, [glass.blur, glass.tint, glass.saturate, glass.enabled, opts.distort, opts.force, opts.weight]);
}

/** Backward-compatible inline liquid-glass backdrop (non-settings callers). */
export function glassStyle(distort: boolean): React.CSSProperties {
  const v = distort
    ? "url(#murke-glass-distort) blur(13px) saturate(1.65) brightness(1.08)"
    : "blur(16px) saturate(1.55) brightness(1.07)";
  return { backdropFilter: v, WebkitBackdropFilter: v };
}

/** apply a useGlass() result to a style object that already has background */
export function applyGlass(
  style: React.CSSProperties,
  g: { enabled: boolean; filter: string | null; alpha: number; saturate: number },
  varName = "--term-bg",
): React.CSSProperties {
  if (!g.enabled || g.filter === null) {
    return { ...style, background: `var(${varName})`, backdropFilter: undefined, WebkitBackdropFilter: undefined };
  }
  return {
    ...style,
    background: `color-mix(in srgb, var(${varName}) ${g.alpha}%, transparent)`,
    backdropFilter: g.filter,
    WebkitBackdropFilter: g.filter,
  };
}

/**
 * FrostLayer — a panel's frost as a SIBLING layer, never the panel's own
 * backdrop-filter. Why: an element with backdrop-filter is a "backdrop
 * root", and a DESCENDANT's backdrop-filter (the real glass icon tiles)
 * samples nothing through it — chromium blurs away an empty snapshot.
 * Painted as the panel's first child instead, the frost lands on the
 * canvas BENEATH the icon tiles, so their own backdrop-filters refract
 * it for real — glass-on-glass, verified in chromium.
 *
 * Render nothing when there's no filter (glass off → solid panels).
 */
export function FrostLayer({ filter }: { filter: string | null | undefined }) {
  if (!filter) return null;
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-[inherit]"
      style={{ backdropFilter: filter, WebkitBackdropFilter: filter }}
    />
  );
}
