/**
 * Murke Proxy — shared contracts for the shell.
 * Every module builds against these types. Keep shapes stable.
 */

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
  | "classic";

/** Fullscreen takeovers the shell can launch (no windows — the app IS the screen). */
export type OverlayId = "browser" | "paint" | "chat" | "notes" | "files";

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
  /** Creates a proxied frame. Must be called after init() resolves ok. */
  createFrame(): ProxyFrameHandle;
}

/* ---------- Command context ---------- */

export interface CommandContext {
  print(text?: string, kind?: OutputKind): void;
  /** Trusted HTML only (vendored art). fit=false keeps the block at shell font
   *  size; block=true renders as a styled <div> (flex/canvas layouts). */
  printHTML(html: string, fit?: boolean, block?: boolean): void;
  clear(): void;
  getCwd(): string;
  setCwd(p: string): void;
  /** Launch a fullscreen takeover (browser / paint / chat). Esc or ✕ returns to dsh. */
  openOverlay(app: OverlayId, arg?: string): void;
  vfs: VFSApi;
  theme: ThemeName;
  setTheme(t: ThemeName): void;
  crt: boolean;
  setCrt(v: boolean): void;
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
  settings: "daemon.settings.v1",
  history: "daemon.history",
  wisp: "daemon.relay",
  /** browser frameless mode: "1" = no chrome, the site IS the screen */
  frameless: "daemon.frameless",
  legacy: {
    vfs: "murke.vfs",
    session: "murke.session",
    daemonSession: "daemon.session",
  },
} as const;
