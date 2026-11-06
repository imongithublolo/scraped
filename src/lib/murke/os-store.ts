"use client";

import { create } from "zustand";
import type {
  AppId,
  CrtSettings,
  CustomApp,
  CustomTheme,
  DockSettings,
  GlassSettings,
  LockscreenSettings,
  OsSettings,
  PwaSettings,
  TaskbarSettings,
  ThemeName,
  WallpaperChoice,
  WmSettings,
} from "./contracts";
import { LS } from "./contracts";
import { APP_META, MENUBAR_H, DOCK_MARGIN } from "./appmeta";
import { DEFAULT_CRT, sanitizeCrt } from "./crtfx";
import { isThemeName, registerCustomThemes, resolveTheme, resolveThemeKey, skinOf } from "./themes";
import type { OsSkin } from "./themes";

/**
 * The OS store — windows AND settings in one zustand machine.
 *
 * Window model: single instance per app (macOS-style). openApp focuses an
 * existing window or creates one with a cascade offset. Every window owns
 * x/y/w/h/z + minimized/zoom flags; the frontmost (highest z) is "active"
 * and drives the bold app menu in the menu bar.
 *
 * WM model (hyprland-flavored): dragging a window into an edge/corner zone
 * previews a translucent snap target (snapPreview) and dropping applies it
 * (snapWindow). Hotkeys (super+arrows, alt+tab) live in wm-hotkeys.ts and
 * drive the same actions.
 *
 * Settings model: OsSettings persisted to localStorage on every change
 * (v3 shape; v2 {theme,crt,wallpaper} and v1 {theme,crt:boolean} migrate).
 */

export interface WinState {
  id: number;
  app: AppId;
  /** launch argument — files path, browser url, settings section… */
  arg?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  min: boolean;
  /** zoomed = fills the desktop between menu bar and dock */
  zoom: boolean;
  /** geometry before zoom — restored on unzoom */
  pre?: { x: number; y: number; w: number; h: number };
  /** set true for the closing animation; the window unmounts 150ms later */
  closing?: boolean;
}

/* ---------- snap zones (hyprland-flavored) ---------- */

export type SnapZone = "left" | "right" | "top" | "bottom" | "tl" | "tr" | "bl" | "br" | "max";

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapPreviewState {
  zone: SnapZone;
  rect: SnapRect;
}

/** The rect a zone covers inside the current desktop bounds. */
export function zoneRect(zone: SnapZone, b: { vw: number; vh: number; top: number; bottom: number }): SnapRect {
  const gap = 6;
  const midX = Math.round(b.vw / 2);
  const midY = Math.round((b.top + b.bottom) / 2);
  const full = { x: gap, y: b.top + gap, w: b.vw - gap * 2, h: b.bottom - b.top - gap * 2 };
  switch (zone) {
    case "max":
    case "top":
      return full;
    case "left":
      return { x: gap, y: b.top + gap, w: midX - gap * 2, h: b.bottom - b.top - gap * 2 };
    case "right":
      return { x: midX + gap, y: b.top + gap, w: b.vw - midX - gap * 2, h: b.bottom - b.top - gap * 2 };
    case "bottom":
      return { x: gap, y: midY + gap, w: b.vw - gap * 2, h: b.bottom - midY - gap * 2 };
    case "tl":
      return { x: gap, y: b.top + gap, w: midX - gap * 2, h: midY - b.top - gap * 2 };
    case "tr":
      return { x: midX + gap, y: b.top + gap, w: b.vw - midX - gap * 2, h: midY - b.top - gap * 2 };
    case "bl":
      return { x: gap, y: midY + gap, w: midX - gap * 2, h: b.bottom - midY - gap * 2 };
    case "br":
      return { x: midX + gap, y: midY + gap, w: b.vw - midX - gap * 2, h: b.bottom - midY - gap * 2 };
  }
}

/* ---------- settings helpers ---------- */

export const DEFAULT_DOCK: DockSettings = {
  iconSize: 32,
  magnify: true,
  magnifyAmount: 0.36,
  autohide: false,
  position: "bottom",
  themeIcons: true,
  opacity: 42,
  blur: 22,
  radius: 16,
  indicator: "dot",
  labels: true,
};
export const DEFAULT_TASKBAR: TaskbarSettings = {
  alignment: "center",
  autohide: false,
  showDate: true,
  iconSize: 20,
  height: 52,
  opacity: 72,
  blur: 26,
  showTray: true,
};
export const DEFAULT_WM: WmSettings = { snap: true, snapPreview: true, hotkeys: true };
export const DEFAULT_PWA: PwaSettings = { runOnLogin: false, wco: true, usb: true, bt: true, serial: true };
export const DEFAULT_GLASS: GlassSettings = { enabled: true, blur: 24, tint: 30, saturate: 165, iconGlass: true };
export const DEFAULT_LOCKSCREEN: LockscreenSettings = {
  autoLock: true,
  blur: 38,
  dim: 42,
  showClock: true,
  showDate: true,
  showHint: true,
  font: "material",
};

function sanitizeDock(raw: unknown): DockSettings {
  const d = (raw ?? {}) as Partial<DockSettings>;
  let iconSize =
    typeof d.iconSize === "number" && d.iconSize >= 24 && d.iconSize <= 56 ? Math.round(d.iconSize) : DEFAULT_DOCK.iconSize;
  /* one-time shrink: 40 was the v2 default; carry everyone down to 32 unless
     they've already re-picked a size after this migration */
  try {
    if (!localStorage.getItem(LS.dockShrink)) {
      localStorage.setItem(LS.dockShrink, "1");
      if (iconSize === 40) iconSize = DEFAULT_DOCK.iconSize;
    }
  } catch {
    /* private mode */
  }
  const clamp = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
  return {
    iconSize,
    magnify: typeof d.magnify === "boolean" ? d.magnify : DEFAULT_DOCK.magnify,
    magnifyAmount: clamp(d.magnifyAmount, 0.08, 0.7, DEFAULT_DOCK.magnifyAmount),
    autohide: typeof d.autohide === "boolean" ? d.autohide : DEFAULT_DOCK.autohide,
    position: d.position === "left" || d.position === "right" ? d.position : "bottom",
    themeIcons: typeof d.themeIcons === "boolean" ? d.themeIcons : DEFAULT_DOCK.themeIcons,
    opacity: clamp(d.opacity, 20, 95, DEFAULT_DOCK.opacity),
    blur: clamp(d.blur, 0, 40, DEFAULT_DOCK.blur),
    radius: clamp(d.radius, 6, 32, DEFAULT_DOCK.radius),
    indicator: d.indicator === "line" || d.indicator === "none" ? d.indicator : "dot",
    labels: typeof d.labels === "boolean" ? d.labels : DEFAULT_DOCK.labels,
  };
}

function sanitizeTaskbar(raw: unknown): TaskbarSettings {
  const t = (raw ?? {}) as Partial<TaskbarSettings>;
  const clamp = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
  return {
    alignment: t.alignment === "left" ? "left" : "center",
    autohide: typeof t.autohide === "boolean" ? t.autohide : DEFAULT_TASKBAR.autohide,
    showDate: typeof t.showDate === "boolean" ? t.showDate : DEFAULT_TASKBAR.showDate,
    iconSize:
      typeof t.iconSize === "number" && t.iconSize >= 16 && t.iconSize <= 24
        ? Math.round(t.iconSize)
        : DEFAULT_TASKBAR.iconSize,
    height: clamp(t.height, 44, 64, DEFAULT_TASKBAR.height),
    opacity: clamp(t.opacity, 20, 100, DEFAULT_TASKBAR.opacity),
    blur: clamp(t.blur, 0, 40, DEFAULT_TASKBAR.blur),
    showTray: typeof t.showTray === "boolean" ? t.showTray : DEFAULT_TASKBAR.showTray,
  };
}

function sanitizeWm(raw: unknown): WmSettings {
  const w = (raw ?? {}) as Partial<WmSettings>;
  return {
    snap: typeof w.snap === "boolean" ? w.snap : DEFAULT_WM.snap,
    snapPreview: typeof w.snapPreview === "boolean" ? w.snapPreview : DEFAULT_WM.snapPreview,
    hotkeys: typeof w.hotkeys === "boolean" ? w.hotkeys : DEFAULT_WM.hotkeys,
  };
}

function sanitizePwa(raw: unknown): PwaSettings {
  const p = (raw ?? {}) as Partial<PwaSettings>;
  return {
    runOnLogin: typeof p.runOnLogin === "boolean" ? p.runOnLogin : DEFAULT_PWA.runOnLogin,
    wco: typeof p.wco === "boolean" ? p.wco : DEFAULT_PWA.wco,
    usb: typeof p.usb === "boolean" ? p.usb : DEFAULT_PWA.usb,
    bt: typeof p.bt === "boolean" ? p.bt : DEFAULT_PWA.bt,
    serial: typeof p.serial === "boolean" ? p.serial : DEFAULT_PWA.serial,
  };
}

function sanitizeGlass(raw: unknown): GlassSettings {
  const g = (raw ?? {}) as Partial<GlassSettings>;
  const clamp = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
  return {
    enabled: typeof g.enabled === "boolean" ? g.enabled : DEFAULT_GLASS.enabled,
    blur: clamp(g.blur, 0, 44, DEFAULT_GLASS.blur),
    tint: clamp(g.tint, 0, 60, DEFAULT_GLASS.tint),
    saturate: clamp(g.saturate, 100, 220, DEFAULT_GLASS.saturate),
    iconGlass: typeof g.iconGlass === "boolean" ? g.iconGlass : DEFAULT_GLASS.iconGlass,
  };
}

function sanitizeLockscreen(raw: unknown): LockscreenSettings {
  const l = (raw ?? {}) as Partial<LockscreenSettings>;
  const clamp = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
  return {
    autoLock: typeof l.autoLock === "boolean" ? l.autoLock : DEFAULT_LOCKSCREEN.autoLock,
    blur: clamp(l.blur, 0, 44, DEFAULT_LOCKSCREEN.blur),
    dim: clamp(l.dim, 0, 80, DEFAULT_LOCKSCREEN.dim),
    showClock: typeof l.showClock === "boolean" ? l.showClock : DEFAULT_LOCKSCREEN.showClock,
    showDate: typeof l.showDate === "boolean" ? l.showDate : DEFAULT_LOCKSCREEN.showDate,
    showHint: typeof l.showHint === "boolean" ? l.showHint : DEFAULT_LOCKSCREEN.showHint,
    font: l.font === "mono" ? "mono" : "material",
  };
}

function sanitizeCustomApps(raw: unknown): CustomApp[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomApp[] = [];
  for (const a of raw) {
    const app = a as Partial<CustomApp>;
    if (typeof app?.id === "string" && typeof app?.name === "string" && typeof app?.url === "string") {
      // uploaded icons: data:image urls only, capped so localStorage stays healthy
      const icon =
        typeof app.icon === "string" && app.icon.startsWith("data:image/") && app.icon.length <= 400_000
          ? app.icon
          : undefined;
      out.push({
        id: app.id,
        name: app.name,
        url: app.url,
        color: typeof app.color === "string" ? app.color : "#8a8a8a",
        ...(icon ? { icon } : {}),
      });
    }
  }
  return out.slice(0, 12);
}

function sanitizeCustomThemes(raw: unknown): CustomTheme[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomTheme[] = [];
  const hex = (v: unknown, fb: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : fb);
  for (const t of raw) {
    const c = t as Partial<CustomTheme>;
    if (typeof c?.id === "string" && typeof c?.name === "string" && c.name.trim()) {
      out.push({
        id: c.id,
        name: c.name.slice(0, 24),
        bg: hex(c.bg, "#070707"),
        fg: hex(c.fg, "#e8e8e8"),
        dim: hex(c.dim, "#8a8a8a"),
        err: hex(c.err, "#ff5555"),
        brand: hex(c.brand, "#ff8c00"),
        hi: hex(c.hi, "#ffffff"),
        bgKind: typeof c.bgKind === "string" ? (c.bgKind as CustomTheme["bgKind"]) : "none",
        light: Boolean(c.light),
        skin: c.skin === "win" ? ("win" as const) : ("mac" as const),
      });
    }
  }
  return out.slice(0, 24);
}

function loadSettings(): OsSettings {
  const fallback: OsSettings = {
    theme: "hell",
    themeMode: "dark",
    customThemeId: null,
    customThemes: [],
    crt: { ...DEFAULT_CRT },
    wallpaper: { kind: "scene" },
    dock: { ...DEFAULT_DOCK },
    taskbar: { ...DEFAULT_TASKBAR },
    wm: { ...DEFAULT_WM },
    pwa: { ...DEFAULT_PWA },
    customApps: [],
    glass: { ...DEFAULT_GLASS },
    lockscreen: { ...DEFAULT_LOCKSCREEN },
  };
  if (typeof window === "undefined") return fallback;
  try {
    let raw = localStorage.getItem(LS.settings);
    if (!raw) {
      /* v2/v1 migration — pull what we can out of the old blob */
      const v2 = localStorage.getItem("daemon.settings.v2");
      if (v2) raw = v2;
    }
    if (!raw) return fallback;
    const s = JSON.parse(raw) as Record<string, unknown>;
    const theme = typeof s.theme === "string" && isThemeName(s.theme) ? s.theme : fallback.theme;
    /* v1 migration: crt was a plain boolean toggle */
    const crtRaw = typeof s.crt === "boolean" ? { enabled: s.crt } : (s.crt as Partial<CrtSettings> | undefined);
    const crt = sanitizeCrt(crtRaw);
    const wp = s.wallpaper as WallpaperChoice | undefined;
    const wallpaper =
      wp && (wp.kind === "scene" || (wp.kind === "preset" && typeof wp.id === "string") || (wp.kind === "custom" && typeof wp.path === "string"))
        ? wp
        : fallback.wallpaper;
    const themeMode = s.themeMode === "light" ? "light" : "dark";
    const customThemeId = typeof s.customThemeId === "string" ? s.customThemeId : null;
    const customThemes = sanitizeCustomThemes(s.customThemes);
    registerCustomThemes(customThemes);
    return {
      theme,
      themeMode,
      customThemeId: customThemes.some((c) => c.id === customThemeId) ? customThemeId : null,
      customThemes,
      crt,
      wallpaper,
      dock: sanitizeDock(s.dock),
      taskbar: sanitizeTaskbar(s.taskbar),
      wm: sanitizeWm(s.wm),
      pwa: sanitizePwa(s.pwa),
      customApps: sanitizeCustomApps(s.customApps),
      glass: sanitizeGlass(s.glass),
      lockscreen: sanitizeLockscreen(s.lockscreen),
    };
  } catch {
    return fallback;
  }
}

function saveSettings(s: OsSettings): void {
  try {
    localStorage.setItem(LS.settings, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

/* ---------- geometry: menu bar + dock aware ---------- */

/** How much room the dock claims, from live settings. */
function dockReserve(dock: DockSettings): { bottom: number; side: number } {
  if (dock.autohide) return { bottom: 10, side: 10 };
  const pad = DOCK_MARGIN + dock.iconSize + 20;
  return dock.position === "bottom" ? { bottom: pad, side: 12 } : { bottom: 12, side: pad };
}

/** the windows taskbar's reserve — full-width bottom strip, no menubar */
const TASKBAR_RESERVE = 54;

/** the active theme's desktop chrome — drives shell geometry everywhere */
export function activeSkin(): OsSkin {
  return skinOf(resolveTheme(useOS.getState().settings));
}

export function desktopBounds(): { vw: number; vh: number; top: number; bottom: number; left: number; right: number } {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  /* window-controls-overlay (installed pwa) shifts everything below the titlebar */
  let wco = 0;
  try {
    wco = parseInt(document.documentElement.style.getPropertyValue("--murke-wco-inset") || "0", 10) || 0;
  } catch {
    /* ignore */
  }
  /* windows skin: fluent taskbar at the bottom, no top menu bar */
  if (activeSkin() === "win") {
    return { vw, vh, top: wco, bottom: vh - TASKBAR_RESERVE, left: 0, right: 0 };
  }
  const dock = useOS.getState().settings.dock;
  const r = dockReserve(dock);
  return {
    vw,
    vh,
    top: MENUBAR_H + wco,
    bottom: vh - r.bottom,
    left: dock.position === "left" ? r.side : 0,
    right: dock.position === "right" ? r.side : 0,
  };
}

/** zoom rect for a window — fills the desktop between menubar/dock/side dock */
export function zoomRect(): SnapRect {
  const b = desktopBounds();
  const x = b.left + (b.left ? 6 : 6);
  const w = b.vw - b.left - b.right - 12;
  return { x, y: b.top + 4, w: Math.max(200, w), h: Math.max(160, b.bottom - b.top - 10) };
}

interface OSState {
  windows: WinState[];
  topZ: number;
  nextId: number;
  activeId: number | null;
  settings: OsSettings;
  /** live snap target while a drag is in flight (null = no preview) */
  snapPreview: SnapPreviewState | null;

  openApp(app: AppId, arg?: string, opts?: { zoom?: boolean }): void;
  closeWindow(id: number): void;
  focusWindow(id: number): void;
  minimizeWindow(id: number): void;
  toggleMinimize(id: number): void;
  toggleZoom(id: number): void;
  moveWindow(id: number, x: number, y: number): void;
  resizeWindow(id: number, w: number, h: number, x?: number, y?: number): void;

  setSnapPreview(zone: SnapZone | null): void;
  /** snap a window into a zone (the hyprland drop) */
  snapWindow(id: number, zone: SnapZone): void;
  /** focus the next/previous window in z-order (alt+tab) */
  cycleFocus(dir: 1 | -1): void;

  setTheme(t: ThemeName): void;
  setThemeMode(m: "dark" | "light"): void;
  toggleThemeMode(): void;
  applyCustomTheme(id: string): void;
  saveCustomTheme(t: CustomTheme): void;
  deleteCustomTheme(id: string): void;
  patchCrt(patch: Partial<CrtSettings>): void;
  setWallpaper(w: WallpaperChoice): void;
  patchDock(patch: Partial<DockSettings>): void;
  patchTaskbar(patch: Partial<TaskbarSettings>): void;
  patchWm(patch: Partial<WmSettings>): void;
  patchPwa(patch: Partial<PwaSettings>): void;
  patchGlass(patch: Partial<GlassSettings>): void;
  patchLockscreen(patch: Partial<LockscreenSettings>): void;
  addCustomApp(app: CustomApp): void;
  removeCustomApp(id: string): void;
  patchSettings(patch: Partial<OsSettings>): void;
  hydrateSettings(): void;
  /** clamp every window into the current viewport (fired on resize) */
  reflowWindows(): void;
}

/** center-ish cascade placement for a fresh window */
function place(app: AppId, n: number): { x: number; y: number; w: number; h: number } {
  const meta = APP_META[app];
  const { vw, top, bottom, left, right } = desktopBounds();
  const small = vw < 700;
  const availW = Math.max(240, vw - left - right - 24);
  const w = Math.min(meta.w, availW);
  const h = Math.min(meta.h, bottom - top - 16);
  const step = 28;
  const offset = (n * step) % 120;
  const x = small ? Math.max(4, Math.round((availW - w) / 2) + left) : Math.max(left + 4, Math.min(vw - right - w - 8, Math.round((vw - left - right - w) / 2) + left + offset - 60));
  const y = small ? top + 6 : Math.max(top + 4, Math.min(bottom - h - 8, top + 34 + offset));
  return { x, y, w, h };
}

export const useOS = create<OSState>((set, get) => ({
  windows: [],
  topZ: 10,
  nextId: 1,
  activeId: null,
  snapPreview: null,
  settings: {
    theme: "hell",
    themeMode: "dark",
    customThemeId: null,
    customThemes: [],
    crt: { ...DEFAULT_CRT },
    wallpaper: { kind: "scene" },
    dock: { ...DEFAULT_DOCK },
    taskbar: { ...DEFAULT_TASKBAR },
    wm: { ...DEFAULT_WM },
    pwa: { ...DEFAULT_PWA },
    customApps: [],
    glass: { ...DEFAULT_GLASS },
    lockscreen: { ...DEFAULT_LOCKSCREEN },
  },

  openApp: (app, arg, opts) => {
    const st = get();
    /* "pwa" is multi-instance: one window per installed app (arg = app id).
       Everything else stays macOS single-instance. */
    const existing = st.windows.find((w) => w.app === app && (app !== "pwa" || w.arg === arg));
    if (existing) {
      /* already running: unminimize + focus (+ forward the arg) */
      const z = st.topZ + 1;
      set({
        topZ: z,
        activeId: existing.id,
        windows: st.windows.map((w) =>
          w.id === existing.id ? { ...w, z, min: false, closing: false, arg: arg !== undefined ? arg : w.arg } : w,
        ),
      });
      return;
    }
    const id = st.nextId;
    const geo = place(app, st.nextId);
    const zoom = opts?.zoom === true || desktopBounds().vw < 700; /* phones: windows open maximized */
    const z = st.topZ + 1;
    set({
      nextId: st.nextId + 1,
      topZ: z,
      activeId: id,
      windows: [...st.windows, { id, app, arg, z, min: false, zoom, x: geo.x, y: geo.y, w: geo.w, h: geo.h }],
    });
  },

  closeWindow: (id) => {
    const st = get();
    const win = st.windows.find((w) => w.id === id);
    if (!win) return;
    set({ windows: st.windows.map((w) => (w.id === id ? { ...w, closing: true } : w)) });
    window.setTimeout(() => {
      const s2 = get();
      const rest = s2.windows.filter((w) => w.id !== id);
      const front = rest.filter((w) => !w.min && !w.closing).sort((a, b) => b.z - a.z)[0];
      set({ windows: rest, activeId: front ? front.id : null });
    }, 150);
  },

  focusWindow: (id) => {
    const st = get();
    if (st.activeId === id) {
      const win = st.windows.find((w) => w.id === id);
      if (win && !win.min) return;
    }
    const z = st.topZ + 1;
    set({
      topZ: z,
      activeId: id,
      windows: st.windows.map((w) => (w.id === id ? { ...w, z, min: false } : w)),
    });
  },

  minimizeWindow: (id) => {
    const st = get();
    const rest = st.windows.filter((w) => w.id !== id && !w.min && !w.closing).sort((a, b) => b.z - a.z)[0];
    set({
      windows: st.windows.map((w) => (w.id === id ? { ...w, min: true } : w)),
      activeId: rest ? rest.id : null,
    });
  },

  toggleMinimize: (id) => {
    const win = get().windows.find((w) => w.id === id);
    if (!win) return;
    if (win.min) get().focusWindow(id);
    else get().minimizeWindow(id);
  },

  toggleZoom: (id) => {
    const st = get();
    const zr = zoomRect();
    set({
      windows: st.windows.map((w) => {
        if (w.id !== id) return w;
        if (w.zoom && w.pre) return { ...w, zoom: false, ...w.pre, pre: undefined };
        return {
          ...w,
          zoom: true,
          pre: { x: w.x, y: w.y, w: w.w, h: w.h },
          ...zr,
        };
      }),
    });
  },

  moveWindow: (id, x, y) => {
    const { vw, vh, top, bottom, left, right } = desktopBounds();
    set({
      windows: get().windows.map((w) => {
        if (w.id !== id) return w;
        /* keep the title bar reachable: 80px visible horizontally, never above the menu bar */
        const cx = Math.min(Math.max(x, left - w.w + 80), vw - right - 80);
        const cy = Math.min(Math.max(y, top), Math.min(bottom, vh - 44));
        return { ...w, x: cx, y: cy, zoom: false };
      }),
    });
  },

  resizeWindow: (id, w0, h0, x0, y0) => {
    const meta = APP_META[get().windows.find((w) => w.id === id)?.app ?? "dsh"];
    const { vw, top, bottom, left, right } = desktopBounds();
    set({
      windows: get().windows.map((w) => {
        if (w.id !== id) return w;
        const nw = Math.min(Math.max(w0, meta.minW), vw - right - w.x - 4);
        const nh = Math.min(Math.max(h0, meta.minH), bottom - w.y - 4);
        return {
          ...w,
          w: nw,
          h: nh,
          x: x0 !== undefined ? Math.max(-nw + 80, Math.min(x0, vw - right - 80)) : w.x,
          y: y0 !== undefined ? Math.max(top, Math.min(y0, bottom - 40)) : w.y,
        };
      }),
    });
  },

  /* ---------- snapping ---------- */

  setSnapPreview: (zone) => {
    if (!zone) {
      if (get().snapPreview) set({ snapPreview: null });
      return;
    }
    const rect = zoneRect(zone, desktopBounds());
    const cur = get().snapPreview;
    if (cur && cur.zone === zone) return;
    set({ snapPreview: { zone, rect } });
  },

  snapWindow: (id, zone) => {
    const rect = zoneRect(zone, desktopBounds());
    set({
      windows: get().windows.map((w) => {
        if (w.id !== id) return w;
        return { ...w, zoom: zone === "max" ? true : w.zoom, pre: zone === "max" ? (w.pre ?? { x: w.x, y: w.y, w: w.w, h: w.h }) : w.pre, ...rect };
      }),
    });
    if (get().snapPreview) set({ snapPreview: null });
  },

  cycleFocus: (dir) => {
    const st = get();
    const live = st.windows.filter((w) => !w.min && !w.closing);
    if (live.length < 2) {
      if (live.length === 1) get().focusWindow(live[0].id);
      return;
    }
    live.sort((a, b) => b.z - a.z);
    const idx = live.findIndex((w) => w.id === st.activeId);
    const next = live[(((idx === -1 ? 0 : idx) + dir) % live.length + live.length) % live.length];
    get().focusWindow(next.id);
  },

  /* ---------- settings ---------- */

  setTheme: (t) => get().patchSettings({ theme: t, customThemeId: null }),
  setThemeMode: (m) => get().patchSettings({ themeMode: m, customThemeId: null }),
  toggleThemeMode: () => get().setThemeMode(get().settings.themeMode === "dark" ? "light" : "dark"),
  applyCustomTheme: (id) => get().patchSettings({ customThemeId: id }),
  saveCustomTheme: (t) => {
    const list = get().settings.customThemes;
    const next = list.some((c) => c.id === t.id) ? list.map((c) => (c.id === t.id ? t : c)) : [...list, t];
    registerCustomThemes([t]);
    get().patchSettings({ customThemes: next, customThemeId: t.id });
  },
  deleteCustomTheme: (id) => {
    const s = get().settings;
    const next = s.customThemes.filter((c) => c.id !== id);
    get().patchSettings({ customThemes: next, customThemeId: s.customThemeId === id ? null : s.customThemeId });
  },
  patchCrt: (patch) => get().patchSettings({ crt: sanitizeCrt({ ...get().settings.crt, ...patch }) }),
  setWallpaper: (w) => get().patchSettings({ wallpaper: w }),
  patchDock: (patch) => get().patchSettings({ dock: sanitizeDock({ ...get().settings.dock, ...patch }) }),
  patchTaskbar: (patch) => get().patchSettings({ taskbar: sanitizeTaskbar({ ...get().settings.taskbar, ...patch }) }),
  patchWm: (patch) => get().patchSettings({ wm: sanitizeWm({ ...get().settings.wm, ...patch }) }),
  patchPwa: (patch) => get().patchSettings({ pwa: sanitizePwa({ ...get().settings.pwa, ...patch }) }),
  patchGlass: (patch) => get().patchSettings({ glass: sanitizeGlass({ ...get().settings.glass, ...patch }) }),
  patchLockscreen: (patch) => get().patchSettings({ lockscreen: sanitizeLockscreen({ ...get().settings.lockscreen, ...patch }) }),
  addCustomApp: (app) => get().patchSettings({ customApps: [...get().settings.customApps.filter((a) => a.id !== app.id), app].slice(0, 12) }),
  removeCustomApp: (id) => get().patchSettings({ customApps: get().settings.customApps.filter((a) => a.id !== id) }),
  patchSettings: (patch) => {
    const next = { ...get().settings, ...patch };
    set({ settings: next });
    saveSettings(next);
  },

  hydrateSettings: () => {
    const s = loadSettings();
    set({ settings: s });
    saveSettings(s);
  },

  reflowWindows: () => {
    const { vw, vh, top, bottom, left, right } = desktopBounds();
    const small = vw < 700;
    const zr = zoomRect();
    set({
      windows: get().windows.map((w) => {
        if (w.zoom || small) {
          /* zoomed windows refill the new bounds; on phones everything maximizes */
          return { ...w, zoom: true, pre: w.pre ?? { x: w.x, y: w.y, w: w.w, h: w.h }, ...zr };
        }
        const maxW = Math.max(160, vw - left - right - 12);
        const nw = Math.min(w.w, maxW);
        const nh = Math.min(w.h, bottom - top - 8);
        return {
          ...w,
          w: nw,
          h: nh,
          x: Math.min(Math.max(w.x, left - nw + 80), Math.max(left + 8, vw - right - 80)),
          y: Math.min(Math.max(w.y, top), Math.min(bottom, vh - 44)),
        };
      }),
    });
  },
}));

/** helper — the window of a given app (single instance) */
export function windowOf(app: AppId): WinState | null {
  return useOS.getState().windows.find((w) => w.app === app) ?? null;
}

/** helper — the active theme registry key for the current settings */
export function activeThemeKey(): string {
  const s = useOS.getState().settings;
  return resolveThemeKey(s);
}

/**
 * React hook — the resolved theme registry key ("hell", "dawn@dark",
 * "custom:ab12"…). Re-renders only when the effective scheme changes.
 */
export function useThemeKey(): string {
  const theme = useOS((s) => s.settings.theme);
  const themeMode = useOS((s) => s.settings.themeMode);
  const customThemeId = useOS((s) => s.settings.customThemeId);
  return resolveThemeKey({ theme, themeMode, customThemeId });
}
