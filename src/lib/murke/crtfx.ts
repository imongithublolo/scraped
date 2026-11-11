import type { CrtSettings } from "./contracts";

/**
 * crtfx — the murke CRT engine.
 *
 * A vendored mini-lib modeled on classic CRT shader packs: every effect the
 * old scanline overlay hard-coded is now a NAMED, TUNABLE parameter rendered
 * through CSS custom properties (see CrtFx.tsx + globals.css). The Settings
 * app exposes presets plus per-channel sliders; the engine itself is pure
 * data — no DOM, no React, trivially testable.
 *
 *   scanlines   dark line raster (multiply blend — adapts to light themes)
 *   glow        phosphor bleed on text (text-shadow strength)
 *   curvature   corner rounding + edge shading of the whole tube
 *   flicker     AC-line brightness jitter of the entire screen
 *   noise       animated grain sheet (VHS-style static)
 *   aberration  RGB fringe on the horizontal axis
 */

export type CrtPresetId = "subtle" | "standard" | "tube" | "custom";

export interface CrtPreset {
  id: CrtPresetId;
  label: string;
  desc: string;
  values: Omit<CrtSettings, "enabled">;
}

export const CRT_PRESETS: CrtPreset[] = [
  {
    id: "subtle",
    label: "subtle",
    desc: "a whisper of raster — retina-friendly",
    values: { scanlines: 0.16, glow: 0.22, curvature: 0, flicker: 0, noise: 0.03, aberration: 0 },
  },
  {
    id: "standard",
    label: "standard",
    desc: "the classic murke look",
    values: { scanlines: 0.3, glow: 0.5, curvature: 0.18, flicker: 0.1, noise: 0.06, aberration: 0.12 },
  },
  {
    id: "tube",
    label: "deep tube",
    desc: "1987 — glass curves, hum and hiss",
    values: { scanlines: 0.52, glow: 0.85, curvature: 0.55, flicker: 0.32, noise: 0.14, aberration: 0.4 },
  },
];

export const DEFAULT_CRT: CrtSettings = { enabled: false, ...CRT_PRESETS[1].values };

/** Nearest preset for a settings blob (the Settings app uses this to highlight). */
export function presetFor(s: CrtSettings): CrtPresetId {
  for (const p of CRT_PRESETS) {
    let same = true;
    for (const k of Object.keys(p.values) as Array<keyof typeof p.values>) {
      if (Math.abs(p.values[k] - s[k]) > 0.011) {
        same = false;
        break;
      }
    }
    if (same) return p.id;
  }
  return "custom";
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Sanitize a partial CRT patch from storage/UI into safe 0..1 values. */
export function sanitizeCrt(raw: Partial<CrtSettings> | undefined, base: CrtSettings = DEFAULT_CRT): CrtSettings {
  const s = { ...base, ...(raw ?? {}) };
  return {
    enabled: Boolean(s.enabled),
    scanlines: clamp01(Number(s.scanlines)),
    glow: clamp01(Number(s.glow)),
    curvature: clamp01(Number(s.curvature)),
    flicker: clamp01(Number(s.flicker)),
    noise: clamp01(Number(s.noise)),
    aberration: clamp01(Number(s.aberration)),
  };
}

/**
 * Map the engine state onto the --crt-* custom properties CrtFx consumes.
 * Flicker is expressed as an amplitude so the CSS animation can jitter
 * around 1.0 without ever collapsing the screen to black.
 */
export function crtVars(s: CrtSettings, light: boolean): Record<string, string> {
  return {
    ["--crt-scan" as string]: String(s.enabled ? s.scanlines : 0),
    ["--crt-glow" as string]: String(s.enabled ? s.glow : 0),
    ["--crt-curve" as string]: String(s.enabled ? s.curvature : 0),
    ["--crt-flicker" as string]: String(s.enabled ? s.flicker : 0),
    ["--crt-noise" as string]: String(s.enabled ? s.noise : 0),
    ["--crt-aberr" as string]: String(s.enabled ? s.aberration : 0),
    /* light tubes raster dark-gray (multiply), dark tubes stay pure black */
    ["--crt-scan-color" as string]: light ? "rgba(20, 24, 28, 1)" : "rgba(0, 0, 0, 1)",
    /* light tubes get a warm glass edge instead of a cold one */
    ["--crt-edge-color" as string]: light ? "rgba(120, 84, 40, 1)" : "rgba(0, 0, 0, 1)",
  };
}
