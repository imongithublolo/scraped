import type { AppId } from "./contracts";

/**
 * App metadata — geometry + identity. Deliberately component-free so the
 * window-manager store can import it without pulling the whole app tree
 * into the store module.
 */

export interface AppMeta {
  id: AppId;
  label: string;
  /** default window size */
  w: number;
  h: number;
  minW: number;
  minH: number;
  /** the app can't be meaningfully resized (settings) */
  fixed?: boolean;
  /**
   * "tabs" — the app takes over the title bar (its content is portaled into
   * it) and the traffic lights move to the RIGHT edge, browser-style.
   */
  chrome?: "tabs";
}

export const APP_META: Record<AppId, AppMeta> = {
  dsh: { id: "dsh", label: "terminal", w: 900, h: 580, minW: 430, minH: 260 },
  files: { id: "files", label: "finder", w: 860, h: 540, minW: 480, minH: 320 },
  browser: { id: "browser", label: "web", w: 1020, h: 640, minW: 480, minH: 340, chrome: "tabs" },
  notes: { id: "notes", label: "notes", w: 760, h: 520, minW: 420, minH: 300 },
  chat: { id: "chat", label: "relay chat", w: 780, h: 560, minW: 420, minH: 340 },
  paint: { id: "paint", label: "paint", w: 880, h: 600, minW: 520, minH: 380 },
  settings: { id: "settings", label: "settings", w: 720, h: 520, minW: 460, minH: 360, fixed: true },
  preview: { id: "preview", label: "previews", w: 960, h: 620, minW: 480, minH: 340 },
  pwa: { id: "pwa", label: "app", w: 1080, h: 700, minW: 380, minH: 300 },
  vm: { id: "vm", label: "vm", w: 920, h: 620, minW: 460, minH: 320 },
  admin: { id: "admin", label: "admin", w: 860, h: 600, minW: 460, minH: 380, fixed: true },
  watch: { id: "watch", label: "watch", w: 1040, h: 660, minW: 460, minH: 340 },
};

export const DOCK_ORDER: AppId[] = ["dsh", "files", "browser", "watch", "preview", "notes", "chat", "paint"];

/**
 * Resolve the metadata for a window — "pwa" windows carry their identity in
 * the arg (a CustomApp id), so the label comes from the installed app. The
 * window server / menu bar / dock all render through this.
 */
export function resolveMeta(app: AppId, arg: string | undefined, customApps: Array<{ id: string; name: string }>): AppMeta {
  const base = APP_META[app];
  if (app === "pwa" && arg) {
    const app0 = customApps.find((a) => a.id === arg);
    if (app0) return { ...base, label: app0.name.trim().toLowerCase().slice(0, 24) || "app" };
  }
  if (app === "vm" && arg) {
    return { ...base, label: `vm · ${arg.trim().toLowerCase().slice(0, 20)}` };
  }
  return base;
}

/* desktop geometry constants — menu bar on top, dock reserve is dynamic
   (settings-driven, computed in os-store); DOCK_MARGIN is the dock's own
   breathing room from the screen edge */
export const MENUBAR_H = 28;
export const DOCK_MARGIN = 10;
