import type { ThemeName } from "./contracts";

/**
 * Themes own the ENTIRE color scheme — every surface, border, glow and ascii
 * block derives from the six term vars + the art palette below. Every theme
 * ALSO owns a living three.js backdrop scene (bgKind) rendered under the
 * glass: fire for hell, dust for amber/bone, a black hole for void, acid
 * rain for toxic, a blood moon for blood, snowfall for frost, dead-channel
 * static for static, a violet nebula for classic. minimal stays bare.
 */
export type BackgroundKind =
  | "fire"
  | "emberdust"
  | "bonedust"
  | "blackhole"
  | "acidrain"
  | "bloodmoon"
  | "snowfall"
  | "deadstatic"
  | "nebula"
  | "none";

/** Palette slots used to recolor the vendored ASCII art per theme. */
export interface ArtPalette {
  base: string;
  light: string;
  hi: string;
  white: string;
  dim: string;
  /** mid-dark shade (the "55" gray in the owner's art) */
  shadow: string;
}

export interface ThemeDef {
  name: ThemeName;
  label: string;
  bg: string;
  fg: string;
  dim: string;
  err: string;
  /** brand accent — the identity color of the theme */
  brand: string;
  /** highlight — brightest UI tone (headings, active states) */
  hi: string;
  /** which three.js backdrop burns behind the glass ("none" = bare glass) */
  bgKind: BackgroundKind;
  /** bare-bones AMOLED mode: no glow, no chrome tint, no overlays */
  bare?: boolean;
  art: ArtPalette;
}

export const THEMES: Record<ThemeName, ThemeDef> = {
  hell: {
    name: "hell",
    label: "hellfire (bsd red)",
    bg: "#0a0103",
    fg: "#ff6b61",
    dim: "#8f3d36",
    err: "#ff2f2f",
    brand: "#e03131",
    hi: "#ffb454",
    bgKind: "fire",
    art: { base: "#AA0000", light: "#FF5555", hi: "#FFFF55", white: "#FFFFFF", dim: "#AAAAAA", shadow: "#5c1414" },
  },
  amber: {
    name: "amber",
    label: "phosphor amber",
    bg: "#070300",
    fg: "#ffb000",
    dim: "#9a6a00",
    err: "#ff5555",
    brand: "#ff8c00",
    hi: "#ffe28a",
    bgKind: "emberdust",
    art: { base: "#8a3d00", light: "#ffb000", hi: "#ffe28a", white: "#fff3d6", dim: "#9a6a00", shadow: "#5c3400" },
  },
  bone: {
    name: "bone",
    label: "bone white",
    bg: "#0c0908",
    fg: "#e8e2df",
    dim: "#8b7f7c",
    err: "#ff5555",
    brand: "#d8cfc9",
    hi: "#ffffff",
    bgKind: "bonedust",
    art: { base: "#9c8f8d", light: "#dcd4d2", hi: "#ffffff", white: "#ffffff", dim: "#6b615f", shadow: "#4a4341" },
  },
  minimal: {
    name: "minimal",
    label: "minimal (amoled)",
    bg: "#000000",
    fg: "#e8e8e8",
    dim: "#7a7a7a",
    err: "#ff5555",
    brand: "#ffffff",
    hi: "#ffffff",
    bgKind: "none",
    bare: true,
    art: { base: "#cfcfcf", light: "#ffffff", hi: "#ffffff", white: "#ffffff", dim: "#8a8a8a", shadow: "#3a3a3a" },
  },
  void: {
    name: "void",
    label: "void (black hole)",
    bg: "#030006",
    fg: "#c9a6f5",
    dim: "#5c3d7a",
    err: "#ff4dd8",
    brand: "#9d5cff",
    hi: "#f2e2ff",
    bgKind: "blackhole",
    art: { base: "#4a1466", light: "#a24de0", hi: "#e9b8ff", white: "#f3e8ff", dim: "#6e5a86", shadow: "#33184a" },
  },
  toxic: {
    name: "toxic",
    label: "toxic rain",
    bg: "#020600",
    fg: "#58ff7a",
    dim: "#2c7a3f",
    err: "#baff45",
    brand: "#00cc44",
    hi: "#ccff00",
    bgKind: "acidrain",
    art: { base: "#0a5c1e", light: "#22c55e", hi: "#a3e635", white: "#dcffe4", dim: "#3d7a4a", shadow: "#0f3d1a" },
  },
  blood: {
    name: "blood",
    label: "blood moon",
    bg: "#050000",
    fg: "#ff8a80",
    dim: "#7a2e2a",
    err: "#ff1a1a",
    brand: "#d40000",
    hi: "#ffd7b0",
    bgKind: "bloodmoon",
    art: { base: "#6e0000", light: "#d40000", hi: "#ff6b4a", white: "#ffe3dc", dim: "#7a3a34", shadow: "#4a0808" },
  },
  frost: {
    name: "frost",
    label: "hellfrost",
    bg: "#010608",
    fg: "#a8e6f0",
    dim: "#4a7a85",
    err: "#ff88aa",
    brand: "#35c4d7",
    hi: "#eaffff",
    bgKind: "snowfall",
    art: { base: "#1a5c6e", light: "#5fc9dd", hi: "#b0f0ff", white: "#eafcff", dim: "#5a7d88", shadow: "#123d4a" },
  },
  static: {
    name: "static",
    label: "dead channel",
    bg: "#030303",
    fg: "#d8d8d8",
    dim: "#6a6a6a",
    err: "#ffffff",
    brand: "#bdbdbd",
    hi: "#ffffff",
    bgKind: "deadstatic",
    art: { base: "#5a5a5a", light: "#9a9a9a", hi: "#d8d8d8", white: "#ffffff", dim: "#444444", shadow: "#2e2e2e" },
  },
  classic: {
    name: "classic",
    label: "classic (gunmetal purple)",
    bg: "#0b0a0e",
    fg: "#d6d2de",
    dim: "#6e6a78",
    err: "#ff5c8a",
    brand: "#a05cff",
    hi: "#eae6f2",
    bgKind: "nebula",
    art: { base: "#7a3ff2", light: "#b28aff", hi: "#e4d5ff", white: "#f7f4ff", dim: "#8e8a98", shadow: "#35313f" },
  },
};

export const THEME_ORDER: ThemeName[] = [
  "hell",
  "amber",
  "bone",
  "minimal",
  "void",
  "toxic",
  "blood",
  "frost",
  "static",
  "classic",
];

export function isThemeName(v: string): v is ThemeName {
  return THEME_ORDER.includes(v as ThemeName);
}

/** Inline style object applied to the OS root so every window can use the vars. */
export function themeVars(t: ThemeName): React.CSSProperties {
  const def = THEMES[t];
  return {
    ["--term-bg" as string]: def.bg,
    ["--term-fg" as string]: def.fg,
    ["--term-dim" as string]: def.dim,
    ["--term-err" as string]: def.err,
    ["--term-brand" as string]: def.brand,
    ["--term-hi" as string]: def.hi,
    backgroundColor: def.bg,
    color: def.fg,
  };
}
