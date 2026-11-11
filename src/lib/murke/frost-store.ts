"use client";

/**
 * frost-store — the settings behind the Frost shell (1:1 with the user's
 * Material New Tab design files). Deliberately tiny: glass formula knobs,
 * search bar dims, engines, shortcuts, wallpaper, floating controls.
 * Persisted to localStorage on every change; nothing else survives.
 */

import { create } from "zustand";

export interface FrostEngine {
  id: string;
  name: string;
  /** query url template, `%s`-style end-append; "" = urls only, words have
      nowhere to go; null = the smart default (urls direct, words → ddg) */
  q: string | null;
  /** optional custom icon url (settings › search › engine editor) */
  icon?: string;
}

export interface FrostShortcut {
  id: string;
  name: string;
  url: string;
  icon?: string;
}

/* ---------- home widgets (the editor's palette) ---------- */

export type FrostWidgetKind = "clock" | "oneko" | "battery" | "text" | "music" | "weather" | "notes";

export interface FrostWidgetSettings {
  /** clock — any Google Font family name */
  font?: string;
  /** clock — 24-hour */
  format24?: boolean;
  /** clock — show seconds */
  seconds?: boolean;
  /** clock — IANA timezone (""/undefined = device local) */
  tz?: string;
  /** text widget body */
  text?: string;
  /** text widget font size (px) */
  size?: number;
  /** text widget color */
  color?: "white" | "black";
  /** weather — location override ("" = auto by ip) */
  place?: string;
  /** notes — the note body */
  note?: string;
}

export interface FrostWidget {
  id: string;
  kind: FrostWidgetKind;
  /** left edge, % of viewport width */
  x: number;
  /** top edge, % of viewport height */
  y: number;
  /** width, px (clamped on render) */
  w: number;
  /** height, px */
  h: number;
  /** stacking, 1..99 */
  z: number;
  settings: FrostWidgetSettings;
}

export interface FrostSettings {
  /* glass — the exact formula knobs from home.css (percent units) */
  glass: {
    transparency: number; // 0..100
    blur: number; // 0..100
    brightness: number; // 50..200
    saturation: number; // 0..150
  };
  searchBar: {
    radius: number; // 0..100
    height: number; // 50..200
    width: number; // 50..200
  };
  shortcutsStyle: {
    radius: number; // 0..100
    size: number; // 50..150
    fontColor: "black" | "white" | "transparent";
  };
  engines: FrostEngine[];
  /** the engine picked in the bar */
  engine: string;
  /** keyboard modifiers → engine (settings › search) */
  modifiers: { def: string; ctrl: string; shift: string; ctrlShift: string };
  shortcuts: FrostShortcut[];
  /** wallpaper url (or data url) — never empty (the default backdrop) */
  wallpaper: string;
  /** blur applied to the wallpaper, 0..100 */
  wallpaperBlur: number;
  /** the home layout's widgets + the snap-to-grid toggle */
  homeLayout: { widgets: FrostWidget[]; grid: boolean };
  /** where the user pinned the search cluster — null = dead center */
  searchPos: { x: number; y: number } | null;
  /** floating nav + devtools buttons */
  floatingControls: boolean;
  /** fade the floating buttons to near-invisible when idle */
  idleFade: boolean;
}

export const FROST_KEY = "frost.settings.v1";

export const DEFAULT_ENGINES: FrostEngine[] = [
  // "Frost" IS the web search — google's serp is a JS-only shell no proxy
  // can run, so plain words open the NATIVE results page (real google
  // answers via the googlethis scraper, server-side — instant, styled,
  // honest) while urls browse direct through the relay. The mark is the
  // frost snowflake — this is frost's own engine, not murke's.
  { id: "web", name: "Frost", q: null },
  { id: "wikipedia", name: "Wikipedia", q: "https://en.wikipedia.org/wiki/Special:Search?search=" },
  // NORMAL duckduckgo — the full site through the proxy, not the lite mirror
  { id: "duck", name: "DuckDuckGo", q: "https://duckduckgo.com/?q=" },
  { id: "youtube", name: "YouTube", q: "https://www.youtube.com/results?search_query=" },
  { id: "translate", name: "Translate", q: "https://translate.google.com/?sl=auto&tl=auto&text=" },
];

/** the wallpapers — the user's own set: the default backdrop from their
 *    design file, the ramiel still, and the seven wallhaven picks. The
 *    AI-generated stills are retired. */
export const WALLPAPERS: string[] = [
  "/wallpapers/frost.webp",
  "/wallpapers/ramiel.jpg",
  "/wallpapers/wallhaven-3q3z9d.jpg",
  "/wallpapers/wallhaven-3q7j3v.png",
  "/wallpapers/wallhaven-4o3mm5.jpg",
  "/wallpapers/wallhaven-d8vvlo.png",
  "/wallpapers/wallhaven-ne8xvk.jpg",
  "/wallpapers/wallhaven-q6xzy7.jpg",
  "/wallpapers/wallhaven-x8w2ed.jpg",
];

/** wallpapers retired with v1.4 — the AI-generated stills nobody picked.
 *    A saved store pointing at one (or at v1.3's white default) lands back
 *    on the real default backdrop. */
const RETIRED_WALLPAPERS = [
  "",
  "/wallpapers/dunes.jpg",
  "/wallpapers/glacier.jpg",
  "/wallpapers/inferno.jpg",
  "/wallpapers/violet.jpg",
];

/** the default backdrop — the user's own image from their design file */
export const DEFAULT_WALLPAPER = "/wallpapers/frost.webp";

export const DEFAULT_SETTINGS: FrostSettings = {
  // glassier by default: more see-through, more blur, a touch more color
  glass: { transparency: 84, blur: 62, brightness: 103, saturation: 125 },
  searchBar: { radius: 100, height: 85, width: 120 },
  shortcutsStyle: { radius: 100, size: 95, fontColor: "white" },
  engines: DEFAULT_ENGINES,
  engine: "web",
  modifiers: { def: "web", ctrl: "web", shift: "web", ctrlShift: "web" },
  shortcuts: [],
  wallpaper: DEFAULT_WALLPAPER,
  wallpaperBlur: 0,
  homeLayout: { widgets: [], grid: false },
  searchPos: null,
  floatingControls: true,
  idleFade: true,
};

/** the pre-glassy defaults — a saved store that still carries these exact
 *    knobs was never hand-tuned, so it earns the new glass untouched */
const OLD_GLASS = { transparency: 77, blur: 40, brightness: 104, saturation: 100 };

/** localStorage key behind the first-boot search-bar tip */
export const FROST_TIP_KEY = "frost.tip.v1";

function sanitize(raw: unknown): FrostSettings {
  const s = (raw ?? {}) as Partial<FrostSettings>;
  const clamp = (v: unknown, lo: number, hi: number, d: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    glass: (() => {
      const g = {
        transparency: clamp(s.glass?.transparency, 0, 100, DEFAULT_SETTINGS.glass.transparency),
        blur: clamp(s.glass?.blur, 0, 100, DEFAULT_SETTINGS.glass.blur),
        brightness: clamp(s.glass?.brightness, 50, 200, DEFAULT_SETTINGS.glass.brightness),
        saturation: clamp(s.glass?.saturation, 0, 150, DEFAULT_SETTINGS.glass.saturation),
      };
      // untouched pre-glassy store → the new glassier defaults
      if (
        g.transparency === OLD_GLASS.transparency &&
        g.blur === OLD_GLASS.blur &&
        g.brightness === OLD_GLASS.brightness &&
        g.saturation === OLD_GLASS.saturation
      ) {
        return { ...DEFAULT_SETTINGS.glass };
      }
      return g;
    })(),
    searchBar: {
      radius: clamp(s.searchBar?.radius, 0, 100, DEFAULT_SETTINGS.searchBar.radius),
      height: clamp(s.searchBar?.height, 50, 200, DEFAULT_SETTINGS.searchBar.height),
      width: clamp(s.searchBar?.width, 50, 200, DEFAULT_SETTINGS.searchBar.width),
    },
    shortcutsStyle: {
      radius: clamp(s.shortcutsStyle?.radius, 0, 100, DEFAULT_SETTINGS.shortcutsStyle.radius),
      size: clamp(s.shortcutsStyle?.size, 50, 150, DEFAULT_SETTINGS.shortcutsStyle.size),
      fontColor:
        s.shortcutsStyle?.fontColor === "black" || s.shortcutsStyle?.fontColor === "transparent"
          ? s.shortcutsStyle.fontColor
          : "white",
    },
    engines:
      Array.isArray(s.engines) && s.engines.length > 0
        ? s.engines
            .filter((e) => e && typeof e.id === "string" && typeof e.name === "string")
            .map((e) => {
              // migrate engines forward: a known engine saved with a query
              // url that no longer matches the default adopts the default
              const def = DEFAULT_ENGINES.find((d) => d.id === e.id);
              // duckduckgo graduated from the lite mirror to the real site
              if (e.id === "duck" && typeof e.q === "string" && e.q.includes("lite.duckduckgo.com")) {
                return { id: e.id, name: "DuckDuckGo", q: def?.q ?? DEFAULT_ENGINES[2].q, icon: e.icon };
              }
              const q = typeof e.q === "string" && e.q && !(def && def.q === null) ? e.q : def ? def.q : typeof e.q === "string" ? e.q : null;
              // the web engine graduated from "the web" → "Google" →
              // "Frost" — carry the rename over saved stores
              const name =
                e.id === "web" && (e.name === "the web" || e.name === "Google")
                  ? def?.name ?? e.name
                  : e.name;
              return {
                id: e.id,
                name,
                q,
                icon: typeof e.icon === "string" && e.icon ? e.icon : undefined,
              };
            })
        : DEFAULT_ENGINES,
    engine: typeof s.engine === "string" ? s.engine : "web",
    modifiers: {
      def: typeof s.modifiers?.def === "string" ? s.modifiers.def : "web",
      ctrl: typeof s.modifiers?.ctrl === "string" ? s.modifiers.ctrl : "web",
      shift: typeof s.modifiers?.shift === "string" ? s.modifiers.shift : "web",
      ctrlShift: typeof s.modifiers?.ctrlShift === "string" ? s.modifiers.ctrlShift : "web",
    },
    shortcuts: Array.isArray(s.shortcuts)
      ? s.shortcuts
          .filter((c) => c && typeof c.name === "string" && typeof c.url === "string")
          .map((c, i) => ({
            id: typeof c.id === "string" ? c.id : `sc-${i}-${Date.now()}`,
            name: c.name,
            url: c.url,
            icon: typeof c.icon === "string" ? c.icon : undefined,
          }))
      : [],
    wallpaper: (() => {
      const w = typeof s.wallpaper === "string" ? s.wallpaper : "";
      if (RETIRED_WALLPAPERS.includes(w)) return DEFAULT_WALLPAPER;
      return w || DEFAULT_WALLPAPER;
    })(),
    wallpaperBlur: clamp(s.wallpaperBlur, 0, 100, 0),
    searchPos:
      s.searchPos && typeof s.searchPos.x === "number" && typeof s.searchPos.y === "number"
        ? { x: clamp(s.searchPos.x, 2, 98, 50), y: clamp(s.searchPos.y, 2, 98, 45) }
        : null,
    homeLayout: {
      widgets: Array.isArray(s.homeLayout?.widgets)
        ? s.homeLayout?.widgets
            .filter((w) => w && typeof w.id === "string" && typeof w.kind === "string")
            .map((w, i) => ({
              id: w.id,
              kind: w.kind as FrostWidgetKind,
              x: clamp(w.x, 0, 100, 8),
              y: clamp(w.y, 0, 100, 12),
              w: clamp(w.w, 56, 1400, 260),
              h: clamp(w.h, 48, 1000, 160),
              z: clamp(w.z, 1, 9, (i % 9) + 1),
              settings: {
                font: typeof w.settings?.font === "string" ? w.settings.font : undefined,
                format24: w.settings?.format24 === true,
                seconds: w.settings?.seconds === true,
                tz: typeof w.settings?.tz === "string" ? w.settings.tz : undefined,
                text: typeof w.settings?.text === "string" ? w.settings.text : undefined,
                size: clamp(w.settings?.size, 10, 96, 22),
                color: w.settings?.color === "black" ? "black" : "white",
                place: typeof w.settings?.place === "string" ? w.settings.place : undefined,
                note: typeof w.settings?.note === "string" ? w.settings.note : undefined,
              },
            }))
        : [],
      grid: s.homeLayout?.grid === true,
    },
    floatingControls: s.floatingControls !== false,
    idleFade: s.idleFade !== false,
  };
}

/** compress + read a picked wallpaper image the Frost way (canvas → webp).
 *  Falls back to the object url when canvas/quota refuse (session-only). */
export function compressWallpaper(
  file: File,
  quality = 100,
  maxH = 2000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxH / Math.max(img.height, 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no canvas");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/webp", quality / 100);
        URL.revokeObjectURL(objectUrl);
        resolve(dataUrl);
      } catch {
        resolve(objectUrl); // keep the object url for this session
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("could not read that image"));
    };
    img.src = objectUrl;
  });
}

export interface FrostStoreState {
  settings: FrostSettings;
  hydrated: boolean;
  hydrate: () => void;
  set: (patch: Partial<FrostSettings> | ((s: FrostSettings) => Partial<FrostSettings>)) => void;
}

/** the frost store — one module-level zustand machine, hook-shaped like useOS */
export const frostStore = create<FrostStoreState>((setState, getState) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,
  hydrate: () => {
    try {
      const raw = localStorage.getItem(FROST_KEY);
      if (raw) setState({ settings: sanitize(JSON.parse(raw)) });
    } catch {
      /* defaults live on */
    }
    setState({ hydrated: true });
  },
  set: (patch) => {
    const cur = getState().settings;
    const next = { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) };
    setState({ settings: next });
    try {
      localStorage.setItem(FROST_KEY, JSON.stringify(next));
    } catch {
      /* private mode — session only */
    }
  },
}));

/** resolve the engine for a search, honoring keyboard modifiers.
    The engine picked in the bar IS the default (1:1 with the design);
    ctrl/shift/ctrlShift override per the settings › search table. */
export function engineFor(
  s: FrostSettings,
  mods: { ctrl: boolean; shift: boolean },
): FrostEngine {
  const id = mods.ctrl && mods.shift
    ? s.modifiers.ctrlShift
    : mods.ctrl
      ? s.modifiers.ctrl
      : mods.shift
        ? s.modifiers.shift
        : s.engine || s.modifiers.def;
  return (
    s.engines.find((e) => e.id === id) ??
    s.engines.find((e) => e.id === s.engine) ??
    s.engines[0] ??
    DEFAULT_ENGINES[0]
  );
}
