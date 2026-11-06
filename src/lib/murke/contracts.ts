/**
 * Murke Proxy — shared contracts for the shell.
 * Every module builds against these types. Keep shapes stable.
 */
import type { BackgroundKind, OsSkin } from "./themes";

export type { BackgroundKind, OsSkin };

export type ThemeName =
  | "hell"
  | "amber"
  | "bone"
  | "minimal"
  | "void"
  | "toxic"
  | "blood"
  | "frost"
  | "static"
  | "classic"
  | "dawn"
  | "linen"
  | "glacier"
  | "cupertino"
  | "sequoia"
  | "midnight"
  | "myoubasil"
  | "myouspice"
  | "myoucloud"
  | "sakura"
  | "mintcream"
  | "lavenderhaze"
  | "terracotta"
  | "olive"
  | "warmsand"
  | "claybrown"
  | "sage"
  | "win11"
  | "winfluent";

/**
 * Desktop applications. Every one runs inside a draggable mac-style window;
 * the terminal is just another app (dsh).
 *
 *  - "preview" — the Apple-Previews-style viewer (every file type + streams)
 *  - "pwa"     — installed web apps; MULTI-instance: one window per custom
 *                app, keyed by `arg` = the CustomApp id. They open chrome-less
 *                (no tabs/omnibox — the browser is invisible).
 */
export type AppId =
  | "dsh"
  | "files"
  | "browser"
  | "notes"
  | "chat"
  | "paint"
  | "settings"
  | "preview"
  | "pwa"
  | "vm"
  | "admin"
  | "watch";

/**
 * Custom "PWA addon" apps — user-installed web apps. They live in the dock
 * and open in the browser app at their url (usually a web-app style site).
 */
export interface CustomApp {
  /** stable id (nanoid-ish) — also used as React key */
  id: string;
  name: string;
  url: string;
  /** tile hue for the dock letter tile */
  color: string;
  /** user-uploaded icon — a small data: url (resized to 128px on upload) */
  icon?: string;
}

/** Sentinel the shell uses to land on the browser's new-tab page. */
export const NEWTAB_URL = "murke://newtab";

export type OutputKind = "out" | "err" | "dim" | "ok";

export interface OutputLine {
  id: number;
  kind: OutputKind;
  /** Plain text (rendered with React text nodes — safe). */
  text: string;
  /** Trusted HTML (only ever set from vendored art constants). */
  html?: string;
  /** Auto-fit the html block to the terminal width (logo art). Default true. */
  fit?: boolean;
  /** Render as a styled <div> block (flex layouts, canvases) instead of <pre>. */
  block?: boolean;
  /** Marks the welcome logo so a theme switch can recolor it in place. */
  logo?: boolean;
  /** Which brand art this line carries — the theme recolor effect needs to know. */
  logoArt?: "murke" | "devil";
}

/* ---------- Virtual file system ---------- */

export interface FsFile {
  type: "file";
  name: string;
  content: string;
  mtime: number;
  /** binary payload present in the blob store (writeFileBlob sets this) */
  size?: number;
  /** mime type of the binary payload */
  mime?: string;
}

export interface FsDir {
  type: "dir";
  name: string;
  children: Record<string, FsNode>;
  mtime: number;
}

export type FsNode = FsFile | FsDir;

/* ---------- Sound engine ---------- */

export interface SoundEngine {
  readonly enabled: boolean;
  setEnabled(v: boolean): void;
  key(): void;
  space(): void;
  enter(): void;
  backspace(): void;
}

/* ---------- Chiptune synth ---------- */

export interface TrackInfo {
  id: string;
  name: string;
  bpm: number;
  lengthSec: number;
}

export interface SynthTick {
  id: string;
  name: string;
  elapsed: number;
  total: number;
}

export interface SynthEngine {
  list(): TrackInfo[];
  /** Returns false when the track id is unknown. */
  play(id: string): boolean;
  stop(): void;
  nowPlaying(): TrackInfo | null;
  onTick(cb: ((t: SynthTick) => void) | null): void;
}

/* ---------- Proxy (scramjet over relay/wisp) ---------- */

export interface WispStatus {
  ok: boolean;
  wispUrl: string | null;
  /** which transport won the probe: same-origin relay or a wisp websocket */
  transport?: "relay" | "wisp";
  latencyMs?: number;
  error?: string;
}

export interface ProxyFrameHandle {
  el: HTMLIFrameElement;
  go(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  getUrl(): string;
  onUrl(cb: (url: string) => void): void;
}

export interface ProxyEngine {
  /** Loads scramjet/baremux scripts, registers the service worker and arms the HTTP relay transport. Idempotent. */
  init(): Promise<{ ok: boolean; error?: string }>;
  /** Probes the relay endpoint and reports latency. */
  status(): Promise<WispStatus>;
  /** Fault-driven re-probe: forget the cached transport, re-test everything, re-arm. Optional. */
  revalidate?(): Promise<WispStatus>;
  /** Overrides the relay endpoint (persisted to localStorage). Pass null to clear. */
  setWispOverride(url: string | null): void;
  getWispOverride(): string | null;
  /** Decodes a scramjet-encoded url back to the original (popup capture). Optional. */
  decode?(url: string): string;
  /** Creates a proxied frame. Must be called after init() resolves ok. */
  createFrame(): ProxyFrameHandle;
}

/* ---------- OS settings (persisted) ---------- */

/** CRT engine knobs — all 0..1. Rendered by CrtFx as CSS-var driven layers. */
export interface CrtSettings {
  enabled: boolean;
  scanlines: number;
  glow: number;
  curvature: number;
  flicker: number;
  noise: number;
  aberration: number;
}

/** Desktop wallpaper — the theme's living scene, a bundled image, or a VFS upload. */
export type WallpaperChoice =
  | { kind: "scene" }
  | { kind: "preset"; id: string }
  | { kind: "custom"; path: string };

/* ---------- Themes v3: categories, dark/light, custom schemes ---------- */

/**
 * A user-authored color scheme. The six core colors are the whole identity —
 * the art palette, scenes and chrome all derive from them. `light` decides
 * which side of the toggle the scheme sits on.
 */
export interface CustomTheme {
  id: string;
  name: string;
  bg: string;
  fg: string;
  dim: string;
  err: string;
  brand: string;
  hi: string;
  bgKind: BackgroundKind;
  light: boolean;
  /** which desktop chrome the scheme ships with (default "mac") */
  skin?: OsSkin;
}

/** Dock behavior + look — all live-tweakable from settings > dock. */
export interface DockSettings {
  /** icon tile edge in px (24..56) */
  iconSize: number;
  magnify: boolean;
  /** genie growth cap under the pointer (0..0.7) */
  magnifyAmount: number;
  /** slide away when unused, reveal at the screen edge */
  autohide: boolean;
  position: "bottom" | "left" | "right";
  /** icons recolor to the active theme instead of fixed app colors */
  themeIcons: boolean;
  /** glass panel opacity, 20..95 (%) */
  opacity: number;
  /** backdrop blur, 0..40 px */
  blur: number;
  /** panel corner radius, 6..32 px */
  radius: number;
  /** running-app marker style */
  indicator: "dot" | "line" | "none";
  /** hover labels above the tiles */
  labels: boolean;
}

/** The WINDOWS skin's taskbar — settings > dock shows these instead of the
 *  mac dock knobs when the active theme ships the fluent shell. */
export interface TaskbarSettings {
  /** center the pinned cluster (win11 default) or hug the left edge (classic) */
  alignment: "center" | "left";
  /** slide away; a hover strip at the bottom edge summons it back */
  autohide: boolean;
  /** the stacked time/date — date line can go */
  showDate: boolean;
  /** app glyph edge in px (16..24) inside the 40px buttons */
  iconSize: number;
  /** bar height, 44..64 px */
  height: number;
  /** acrylic opacity, 20..100 (%) */
  opacity: number;
  /** acrylic blur, 0..40 px */
  blur: number;
  /** right tray (key sounds + crt toggles) */
  showTray: boolean;
}

/**
 * PWA platform capabilities (settings › apps › web app platform).
 * `runOnLogin` registers a periodic background sync when the app is
 * installed; `wco` applies Window Controls Overlay insets when the desktop
 * runs as an installed app; the three hardware toggles gate the
 * requestDevice()/requestPort() probes.
 */
export interface PwaSettings {
  runOnLogin: boolean;
  wco: boolean;
  usb: boolean;
  bt: boolean;
  serial: boolean;
}

/** Window manager (hyprland-flavored) knobs. */
export interface WmSettings {
  /** drag-to-edge snapping with zones (halves / quarters / max) */
  snap: boolean;
  /** show the translucent zone preview while dragging */
  snapPreview: boolean;
  /** super+arrows / super+q·f·t / alt+tab */
  hotkeys: boolean;
}

/**
 * The liquid-glass engine — every surface that CAN be glass reads these.
 * `enabled=false` collapses everything back to opaque panels (visibility
 * first); the sliders tune how glassy the glass is.
 */
export interface GlassSettings {
  /** master switch — off means solid panels everywhere */
  enabled: boolean;
  /** backdrop blur in px, 0..44 */
  blur: number;
  /** how much the wallpaper bleeds through, 0..60 (%) of transparency */
  tint: number;
  /** backdrop saturation, 100..220 (%) */
  saturate: number;
  /** REAL frosted-glass icon tiles — actual backdrop-filter frost the
   *  wallpaper shows through (gated on `enabled` too) */
  iconGlass: boolean;
}

/**
 * The mac-style lock screen — settings › lock screen.
 * `enabled` gates only the AUTOMATIC locks (tab hidden, window blurred);
 * the menubar lock button and the `murke-lock` event always work.
 */
export interface LockscreenSettings {
  /** auto-lock when the tab hides or the window loses focus */
  autoLock: boolean;
  /** frosted-veil backdrop blur, 0..44 px */
  blur: number;
  /** how dark the veil sits over the desktop, 0..80 (%) */
  dim: number;
  /** the big ticking clock */
  showClock: boolean;
  /** the lowercase date line under the clock */
  showDate: boolean;
  /** "click or type to unlock" hint */
  showHint: boolean;
  /** material you (roboto flex) or the terminal mono */
  font: "material" | "mono";
}

export interface OsSettings {
  theme: ThemeName;
  /** dark or light — flips the whole scheme with a derived variant */
  themeMode: "dark" | "light";
  /** when set, overrides theme/themeMode with a user scheme */
  customThemeId: string | null;
  customThemes: CustomTheme[];
  crt: CrtSettings;
  wallpaper: WallpaperChoice;
  dock: DockSettings;
  /** the windows skin's taskbar knobs (settings › dock flips content by skin) */
  taskbar: TaskbarSettings;
  wm: WmSettings;
  pwa: PwaSettings;
  customApps: CustomApp[];
  /** the liquid-glass engine (settings › glass) */
  glass: GlassSettings;
  /** the mac-style lock screen (settings › lock screen) */
  lockscreen: LockscreenSettings;
}

/* ---------- Command context ---------- */

export interface CommandContext {
  print(text?: string, kind?: OutputKind): void;
  /**
   * Prompt the operator for a line of input (passwords, confirmations).
   * `mask` renders * characters instead of the typed text. Ctrl+C resolves
   * with an empty string and prints ^C. The answer is never pushed to history.
   */
  ask(label: string, opts?: { mask?: boolean }): Promise<string>;
  /** Trusted HTML only (vendored art). fit=false keeps the block at shell font
   *  size; block=true renders as a styled <div> (flex/canvas layouts). */
  printHTML(html: string, fit?: boolean, block?: boolean): void;
  clear(): void;
  getCwd(): string;
  setCwd(p: string): void;
  /** Open (or focus) an app window. Single instance per app. opts.zoom opens it maximized. */
  openApp(app: AppId, arg?: string, opts?: { zoom?: boolean }): void;
  vfs: VFSApi;
  /** resolved theme registry key — "hell", "dawn@dark", "custom:ab12" */
  theme: string;
  setTheme(t: ThemeName): void;
  crt: CrtSettings;
  patchCrt(patch: Partial<CrtSettings>): void;
  sound: SoundEngine;
  synth: SynthEngine;
  proxy: ProxyEngine;
  logout(): void;
}

/* Minimal structural subset of the VFS class so modules can type against it. */
export interface VFSApi {
  resolve(path: string, cwd?: string): string;
  getNode(path: string, cwd?: string): FsNode | null;
  list(path: string, cwd?: string): FsNode[];
  mkdir(path: string, cwd?: string, recursive?: boolean): string | null;
  writeFile(path: string, content: string, cwd?: string): string | null;
  readFile(path: string, cwd?: string): string | null;
  remove(path: string, cwd?: string, recursive?: boolean): string | null;
  move(from: string, to: string, cwd?: string): string | null;
  exists(path: string, cwd?: string): boolean;
  uniqueName(dirPath: string, desired: string, cwd?: string): string;
  /** binary side — real blobs in IndexedDB */
  writeFileBlob(path: string, blob: Blob, cwd?: string): Promise<string | null>;
  readFileBlob(path: string, cwd?: string): Promise<Blob | null>;
  pretty(path: string): string;
  HOME: string;
}

/* ---------- Command registry ---------- */

export interface CommandDef {
  name: string;
  usage: string;
  desc: string;
  category: "fs" | "apps" | "system" | "fun";
  run(args: string[], ctx: CommandContext): void | Promise<void>;
}

/** Client storage keys (single source of truth). No session key anymore —
 *  the gate demands the password on every fresh page load, by design.
 *  vfs is versioned: bumping it reseeds everyone onto the new seed tree. */
export const LS = {
  vfs: "daemon.vfs.3",
  settings: "daemon.settings.v3",
  history: "daemon.history",
  wisp: "daemon.relay",
  /** provisioned VMs (the `vm` command's instance list) */
  vms: "murke.vm.list",
  /** one-time dock-shrink migration flag (v2 default 40 → v3 default 32) */
  dockShrink: "daemon.dockshrink",
  /** browser frameless mode: "1" = no chrome, the site IS the screen */
  frameless: "daemon.frameless",
  legacy: {
    vfs: "murke.vfs",
    session: "murke.session",
    daemonSession: "daemon.session",
  },
} as const;
