import type { CustomTheme, ThemeName } from "./contracts";

/**
 * Themes own the ENTIRE color scheme — every surface, border, glow and ascii
 * block derives from the six term vars + the art palette below. Every theme
 * ALSO owns a living backdrop scene (bgKind) rendered behind the glass:
 * fire for hell, dust for amber/bone, a black hole for void, acid rain for
 * toxic, a blood moon for blood, snowfall for frost, dead-channel static for
 * static, a violet nebula for classic — and, for the light side, a sunrise
 * for dawn, drifting paper dust for linen and a pale aurora for glacier.
 * minimal stays bare.
 *
 * v3: themes are grouped into CATEGORIES (own vibe each), every scheme can
 * be flipped dark/light with a derived variant, and users can author their
 * own schemes (CustomTheme) which build a full ThemeDef from six colors.
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
  | "sunrise"
  | "paperdust"
  | "lightaurora"
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

/** Theme categories — each has its own vibe. */
export type ThemeCategory =
  | "originals"
  | "minimal"
  | "apple"
  | "windows"
  | "materialyou"
  | "pastel"
  | "earthy"
  | "custom";

export const CATEGORY_META: Record<ThemeCategory, { label: string; desc: string }> = {
  originals: { label: "originals", desc: "the classic murke phosphor set" },
  minimal: { label: "minimal", desc: "no color, all signal" },
  apple: { label: "apple", desc: "cupertino chrome — menubar + dock + traffic lights" },
  windows: { label: "windows", desc: "fluent chrome — taskbar + start + window controls" },
  materialyou: { label: "material you", desc: "tonal, soft, rounded" },
  pastel: { label: "pastel", desc: "soft-focus colorways" },
  earthy: { label: "earthy", desc: "terracotta · olive · sand · clay · sage" },
  custom: { label: "yours", desc: "schemes you mixed yourself" },
};

/**
 * The desktop CHROME a theme ships with. "mac" = menu bar + liquid-glass
 * dock + traffic-light windows; "win" = fluent taskbar + start menu +
 * square window controls. The theme owns EVERYTHING — colors AND chrome —
 * so picking a scheme restyles the whole desktop in one go.
 */
export type OsSkin = "mac" | "win";

/** chrome font stack per skin — windows uses the Segoe line, mac the mono line */
const CHROME_FONT: Record<OsSkin, string> = {
  mac: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
  win: '"Segoe UI Variable Text", "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif',
};

export interface ThemeDef {
  name: string;
  label: string;
  bg: string;
  fg: string;
  dim: string;
  err: string;
  /** brand accent — the identity color of the theme */
  brand: string;
  /** highlight — brightest UI tone (headings, active states) */
  hi: string;
  /** which backdrop burns behind the glass ("none" = bare glass) */
  bgKind: BackgroundKind;
  /** bare-bones AMOLED mode: no glow, no chrome tint, no overlays */
  bare?: boolean;
  /** light themes flip the whole world pale — windows, chrome and CRT adapt */
  light?: boolean;
  /** the desktop chrome this theme ships with (default "mac") */
  skin?: OsSkin;
  art: ArtPalette;
  /** which category this scheme belongs to (set via THEME_CATS for builtins) */
  category?: ThemeCategory;
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

  /* ---------- the light side — pale glass, ink text, daylight scenes ---------- */

  dawn: {
    name: "dawn",
    label: "dawn paper (light)",
    bg: "#f7f0e5",
    fg: "#43342a",
    dim: "#a58f7c",
    err: "#c92a2a",
    brand: "#d9480f",
    hi: "#1d1712",
    bgKind: "sunrise",
    light: true,
    art: { base: "#d9480f", light: "#e8590c", hi: "#a61e4d", white: "#3b2f27", dim: "#b08968", shadow: "#ffd8a8" },
  },
  linen: {
    name: "linen",
    label: "linen & ink (light)",
    bg: "#f5f3ef",
    fg: "#33312e",
    dim: "#8f8b84",
    err: "#b02525",
    brand: "#5f7d54",
    hi: "#17150f",
    bgKind: "paperdust",
    light: true,
    art: { base: "#5f7d54", light: "#7fb069", hi: "#8a9a5b", white: "#2b2925", dim: "#a39c90", shadow: "#d6d2c4" },
  },
  glacier: {
    name: "glacier",
    label: "glacier mint (light)",
    bg: "#eef3f5",
    fg: "#26383e",
    dim: "#7e959c",
    err: "#c0392b",
    brand: "#0b7285",
    hi: "#10181c",
    bgKind: "lightaurora",
    light: true,
    art: { base: "#0b7285", light: "#3bc9db", hi: "#1098ad", white: "#1c2b33", dim: "#8fa8ad", shadow: "#ccedf2" },
  },

  /* ---------- apple — cupertino-clean, frosted, quiet ---------- */

  cupertino: {
    name: "cupertino",
    label: "cupertino (light)",
    bg: "#f5f5f7",
    fg: "#1d1d1f",
    dim: "#86868b",
    err: "#e30000",
    brand: "#6e6e73",
    hi: "#111114",
    bgKind: "lightaurora",
    light: true,
    art: { base: "#6e6e73", light: "#8e8e93", hi: "#48484a", white: "#1d1d1f", dim: "#aeaeb2", shadow: "#d8d8dc" },
  },
  sequoia: {
    name: "sequoia",
    label: "sequoia (dark)",
    bg: "#161618",
    fg: "#e9e9ee",
    dim: "#7f7f87",
    err: "#ff453a",
    brand: "#98989d",
    hi: "#f5f5f7",
    bgKind: "none",
    art: { base: "#7c7c84", light: "#b8b8c0", hi: "#e9e9ee", white: "#f5f5f7", dim: "#5a5a62", shadow: "#2a2a2e" },
  },
  midnight: {
    name: "midnight",
    label: "midnight",
    bg: "#0b0d10",
    fg: "#d5d9de",
    dim: "#646a72",
    err: "#ff453a",
    brand: "#9ba1a8",
    hi: "#eef1f4",
    bgKind: "none",
    art: { base: "#6a7078", light: "#9ba1a8", hi: "#d5d9de", white: "#eef1f4", dim: "#484d54", shadow: "#1e2126" },
  },

  /* ---------- material you — tonal, soft, rounded ---------- */

  myoubasil: {
    name: "myoubasil",
    label: "material you · basil",
    bg: "#121510",
    fg: "#e2e6d8",
    dim: "#7c826d",
    err: "#ffb4a8",
    brand: "#aecf8f",
    hi: "#f4f7ea",
    bgKind: "none",
    art: { base: "#7d9a5e", light: "#aecf8f", hi: "#d3e8b4", white: "#f4f7ea", dim: "#5c654c", shadow: "#2a331f" },
  },
  myouspice: {
    name: "myouspice",
    label: "material you · spice",
    bg: "#171210",
    fg: "#f2e5de",
    dim: "#8a746a",
    err: "#ffb4a0",
    brand: "#e8a488",
    hi: "#fff0e8",
    bgKind: "none",
    art: { base: "#b8755c", light: "#e8a488", hi: "#ffcdb6", white: "#fff0e8", dim: "#6e584c", shadow: "#3d2a20" },
  },
  myoucloud: {
    name: "myoucloud",
    label: "material you · cloud (light)",
    bg: "#f2f3f5",
    fg: "#41474d",
    dim: "#737a80",
    err: "#b3261e",
    brand: "#6b7680",
    hi: "#1b1f23",
    bgKind: "paperdust",
    light: true,
    art: { base: "#6b7680", light: "#93a0ab", hi: "#49525a", white: "#2b3138", dim: "#9aa4ad", shadow: "#d6dade" },
  },

  /* ---------- pastel — soft-focus colorways ---------- */

  sakura: {
    name: "sakura",
    label: "sakura (light)",
    bg: "#fbf1f4",
    fg: "#554a4f",
    dim: "#a08b91",
    err: "#d4506e",
    brand: "#e39cb0",
    hi: "#2f262a",
    bgKind: "lightaurora",
    light: true,
    art: { base: "#e39cb0", light: "#f0bccb", hi: "#c9708a", white: "#4a3d42", dim: "#b89aa3", shadow: "#f9dde5" },
  },
  mintcream: {
    name: "mintcream",
    label: "mint cream (light)",
    bg: "#f0f7f2",
    fg: "#3c4f44",
    dim: "#7f9488",
    err: "#c25b5b",
    brand: "#86c9a4",
    hi: "#1e2b23",
    bgKind: "lightaurora",
    light: true,
    art: { base: "#86c9a4", light: "#b0deca", hi: "#5da884", white: "#33443a", dim: "#a3bfb1", shadow: "#dcefe4" },
  },
  lavenderhaze: {
    name: "lavenderhaze",
    label: "lavender haze",
    bg: "#201d2b",
    fg: "#e4dff2",
    dim: "#837c99",
    err: "#ff9ec6",
    brand: "#b9a8ea",
    hi: "#f2eefa",
    bgKind: "none",
    art: { base: "#8f7dc4", light: "#b9a8ea", hi: "#d8cdf6", white: "#f2eefa", dim: "#655d7d", shadow: "#332d47" },
  },

  /* ---------- earthy — terracotta · olive · sand · clay · sage ---------- */

  terracotta: {
    name: "terracotta",
    label: "terracotta",
    bg: "#170d09",
    fg: "#efd3c2",
    dim: "#93705f",
    err: "#ff6b4a",
    brand: "#cf7350",
    hi: "#ffe9dc",
    bgKind: "emberdust",
    art: { base: "#a35538", light: "#cf7350", hi: "#efa07e", white: "#ffe9dc", dim: "#7a5544", shadow: "#4a2417" },
  },
  olive: {
    name: "olive",
    label: "olive green",
    bg: "#10130b",
    fg: "#d9dfc2",
    dim: "#79805c",
    err: "#d98f62",
    brand: "#97a657",
    hi: "#f1f4da",
    bgKind: "bonedust",
    art: { base: "#6f7c3c", light: "#97a657", hi: "#bcc977", white: "#f1f4da", dim: "#565e3a", shadow: "#2c3218" },
  },
  warmsand: {
    name: "warmsand",
    label: "warm sand (light)",
    bg: "#f4eddd",
    fg: "#55503e",
    dim: "#9b937a",
    err: "#ad5f3c",
    brand: "#b39869",
    hi: "#2b2819",
    bgKind: "paperdust",
    light: true,
    art: { base: "#b39869", light: "#cbb489", hi: "#8f7748", white: "#443f2e", dim: "#b3a98e", shadow: "#e8dfc9" },
  },
  claybrown: {
    name: "claybrown",
    label: "clay brown",
    bg: "#151009",
    fg: "#e6cfb4",
    dim: "#8a755c",
    err: "#e07b52",
    brand: "#ab7b52",
    hi: "#f9ecda",
    bgKind: "emberdust",
    art: { base: "#7d5837", light: "#ab7b52", hi: "#d0a878", white: "#f9ecda", dim: "#5c4a34", shadow: "#322312" },
  },
  sage: {
    name: "sage",
    label: "sage (light)",
    bg: "#edf1e8",
    fg: "#3f4a3a",
    dim: "#7e8b76",
    err: "#b5654f",
    brand: "#8ba585",
    hi: "#212a1e",
    bgKind: "lightaurora",
    light: true,
    art: { base: "#8ba585", light: "#acc4a6", hi: "#6d8a66", white: "#333f2e", dim: "#a9b8a2", shadow: "#dde6d7" },
  },

  /* ---------- windows — fluent chrome: taskbar + start, square controls ---------- */

  win11: {
    name: "win11",
    label: "windows 11 (light)",
    bg: "#f3f3f3",
    fg: "#1b1b1b",
    dim: "#5f5f5f",
    err: "#c42b1c",
    brand: "#0067c0",
    hi: "#101010",
    bgKind: "lightaurora",
    light: true,
    skin: "win",
    art: { base: "#0067c0", light: "#4cc2ff", hi: "#005ba1", white: "#1b1b1b", dim: "#8a8a8a", shadow: "#cfe4f5" },
  },
  winfluent: {
    name: "winfluent",
    label: "windows fluent (dark)",
    bg: "#202020",
    fg: "#f2f2f2",
    dim: "#9d9d9d",
    err: "#ff99a4",
    brand: "#4cc2ff",
    hi: "#ffffff",
    bgKind: "nebula",
    skin: "win",
    art: { base: "#2b5797", light: "#4cc2ff", hi: "#a9d7f5", white: "#f2f2f2", dim: "#6b6b6b", shadow: "#12283a" },
  },

  /* ---------- chromeos — RETIRED (the google shelf shell is gone) ---------- */
};

export const THEME_ORDER: ThemeName[] = [
  "hell",
  "amber",
  "toxic",
  "blood",
  "void",
  "frost",
  "classic",
  "dawn",
  "linen",
  "glacier",
  "bone",
  "minimal",
  "static",
  "cupertino",
  "sequoia",
  "midnight",
  "myoubasil",
  "myouspice",
  "myoucloud",
  "sakura",
  "mintcream",
  "lavenderhaze",
  "terracotta",
  "olive",
  "warmsand",
  "claybrown",
  "sage",
  "win11",
  "winfluent",
];

/** category of every builtin scheme — "own vibe" grouping */
const THEME_CATS: Record<ThemeName, ThemeCategory> = {
  hell: "originals",
  amber: "originals",
  toxic: "originals",
  blood: "originals",
  void: "originals",
  frost: "originals",
  classic: "originals",
  dawn: "originals",
  linen: "originals",
  glacier: "originals",
  bone: "minimal",
  minimal: "minimal",
  static: "minimal",
  cupertino: "apple",
  sequoia: "apple",
  midnight: "apple",
  myoubasil: "materialyou",
  myouspice: "materialyou",
  myoucloud: "materialyou",
  sakura: "pastel",
  mintcream: "pastel",
  lavenderhaze: "pastel",
  terracotta: "earthy",
  olive: "earthy",
  warmsand: "earthy",
  claybrown: "earthy",
  sage: "earthy",
  win11: "windows",
  winfluent: "windows",
};

for (const t of THEME_ORDER) THEMES[t].category = THEME_CATS[t];

export const LIGHT_THEMES: ThemeName[] = [
  "dawn",
  "linen",
  "glacier",
  "cupertino",
  "myoucloud",
  "sakura",
  "mintcream",
  "warmsand",
  "sage",
  "win11",
];

/** the desktop chrome a resolved def carries ("mac" when unset) */
export function skinOf(def: ThemeDef | undefined | null): OsSkin {
  if (def?.skin === "win") return "win";
  return "mac";
}

export function isThemeName(v: string): v is ThemeName {
  return THEME_ORDER.includes(v as ThemeName);
}

/* ------------------------------------------------------------------ */
/* color math — small, dependency-free, deterministic                  */
/* ------------------------------------------------------------------ */

interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function hexToHsl(hex: string): Hsl {
  let m = hex.replace("#", "").trim();
  if (m.length === 3) m = m.split("").map((c) => c + c).join("");
  if (m.length !== 6 || /[^0-9a-f]/i.test(m)) return { h: 0, s: 0, l: 0 };
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function hslToHex({ h, s, l }: Hsl): string {
  const hh = ((h % 1) + 1) % 1;
  const ss = Math.min(1, Math.max(0, s));
  const ll = Math.min(1, Math.max(0, l));
  if (ss === 0) {
    const v = Math.round(ll * 255);
    return "#" + v.toString(16).padStart(2, "0").repeat(3);
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const f = (t0: number) => {
    let t = (t0 % 1 + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return "#" + to(f(hh + 1 / 3)) + to(f(hh)) + to(f(hh - 1 / 3));
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** lighten (>0) or darken (<0) a hex color by a fraction of the way to white/black */
export function shade(hex: string, amount: number): string {
  const c = hexToHsl(hex);
  return hslToHex({ h: c.h, s: c.s, l: clamp01(c.l + amount) });
}

/** push lightness toward an absolute target while keeping hue/sat character */
function toL(hex: string, l: number, satScale = 1): string {
  const c = hexToHsl(hex);
  return hslToHex({ h: c.h, s: clamp01(c.s * satScale), l: clamp01(l) });
}

/** perceptual-ish luminance (0..1) — decides what "light" means for customs */
export function luminance(hex: string): number {
  let m = hex.replace("#", "");
  if (m.length === 3) m = m.split("").map((c) => c + c).join("");
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/* ------------------------------------------------------------------ */
/* derived dark/light variants + custom schemes                        */
/* ------------------------------------------------------------------ */

/**
 * Derive the opposite variant of a scheme. A dark theme goes pale-tinted
 * with ink text (brand darkened for contrast); a light theme goes deep
 * with lifted text. Scenes and art palettes re-derive automatically.
 */
export function deriveVariant(def: ThemeDef, wantLight: boolean): ThemeDef {
  if (Boolean(def.light) === wantLight) return def;
  const keepBare = def.bare === true;
  if (wantLight) {
    const bg = toL(def.brand, 0.955, 0.28);
    const fg = toL(def.fg, 0.24, 0.55);
    const dim = toL(def.fg, 0.52, 0.4);
    const err = toL(def.err, 0.42, 0.85);
    const brand = toL(def.brand, 0.42, 0.95);
    const hi = toL(def.fg, 0.14, 0.6);
    return {
      ...def,
      name: def.name + "@light",
      label: def.label + " · light",
      bg,
      fg,
      dim,
      err,
      brand,
      hi,
      light: true,
      art: { base: brand, light: toL(def.brand, 0.3, 0.95), hi: toL(def.hi, 0.38, 0.8), white: fg, dim: toL(def.dim, 0.55, 0.45), shadow: toL(def.brand, 0.86, 0.35) },
    };
  }
  const bg = toL(def.brand, 0.045, 0.75);
  const fg = toL(def.fg, 0.82, 0.9);
  const dim = toL(def.fg, 0.44, 0.55);
  const err = toL(def.err, 0.62, 0.95);
  const brand = toL(def.brand, 0.6, 0.95);
  const hi = toL(def.hi, 0.92, 0.7);
  return {
    ...def,
    name: def.name + "@dark",
    label: def.label + " · dark",
    bg,
    fg,
    dim,
    err,
    brand,
    hi,
    light: false,
    bare: keepBare,
    art: { base: toL(def.brand, 0.45, 0.9), light: fg, hi: toL(def.hi, 0.88, 0.75), white: "#f5f2ee", dim: toL(def.dim, 0.5, 0.5), shadow: toL(def.brand, 0.16, 0.6) },
  };
}

/** Build a full ThemeDef from a user-authored six-color scheme. */
export function customThemeDef(ct: CustomTheme): ThemeDef {
  const brand = ct.brand;
  return {
    name: "custom:" + ct.id,
    label: ct.name,
    bg: ct.bg,
    fg: ct.fg,
    dim: ct.dim,
    err: ct.err,
    brand,
    hi: ct.hi,
    bgKind: ct.bgKind,
    light: ct.light,
    skin: ct.skin === "win" ? "win" : "mac",
    category: "custom",
    art: {
      base: brand,
      light: shade(brand, 0.18),
      hi: ct.hi,
      white: ct.fg,
      dim: ct.dim,
      shadow: shade(brand, Boolean(ct.light) ? 0.42 : -0.35),
    },
  };
}

/* ------------------------------------------------------------------ */
/* theme registry + resolution (the ONE way to get a ThemeDef)         */
/* ------------------------------------------------------------------ */

type ThemeKey = string;

const registry = new Map<ThemeKey, ThemeDef>();
for (const t of THEME_ORDER) registry.set(t, THEMES[t]);

/** every def lookup goes through here — builtins, derived variants, customs */
export function getThemeDef(key: ThemeKey): ThemeDef {
  const hit = registry.get(key);
  if (hit) return hit;
  /* "<builtin>@light|@dark" — derive + cache */
  const at = key.lastIndexOf("@");
  if (at > 0) {
    const base = key.slice(0, at);
    const mode = key.slice(at + 1);
    const def = registry.get(base);
    if (def && (mode === "light" || mode === "dark")) {
      const derived = deriveVariant(def, mode === "light");
      registry.set(key, derived);
      return derived;
    }
  }
  return THEMES.hell;
}

/** cache custom schemes into the registry (idempotent, called by the store) */
export function registerCustomThemes(list: CustomTheme[]): void {
  for (const ct of list) registry.set("custom:" + ct.id, customThemeDef(ct));
}

export interface ThemeSelection {
  theme: ThemeName;
  themeMode: "dark" | "light";
  customThemeId: string | null;
}

/** the active registry key for a settings selection */
export function resolveThemeKey(sel: Pick<ThemeSelection, "theme" | "themeMode" | "customThemeId">): ThemeKey {
  if (sel.customThemeId) return "custom:" + sel.customThemeId;
  const nativeLight = Boolean(THEMES[sel.theme]?.light);
  if (sel.themeMode === "light") return nativeLight ? sel.theme : sel.theme + "@light";
  return nativeLight ? sel.theme + "@dark" : sel.theme;
}

/** the active ThemeDef for a settings selection */
export function resolveTheme(sel: Pick<ThemeSelection, "theme" | "themeMode" | "customThemeId">): ThemeDef {
  return getThemeDef(resolveThemeKey(sel));
}

/** Inline style object applied to the OS root so every window can use the vars. */
export function themeVars(keyOrDef: ThemeKey | ThemeDef): React.CSSProperties {
  const def = typeof keyOrDef === "string" ? getThemeDef(keyOrDef) : keyOrDef;
  return {
    ["--term-bg" as string]: def.bg,
    ["--term-fg" as string]: def.fg,
    ["--term-dim" as string]: def.dim,
    ["--term-err" as string]: def.err,
    ["--term-brand" as string]: def.brand,
    ["--term-hi" as string]: def.hi,
    /* chrome font follows the skin — Segoe for windows, mono for mac */
    ["--chrome-font" as string]: CHROME_FONT[skinOf(def)],
    backgroundColor: def.bg,
    color: def.fg,
  };
}
