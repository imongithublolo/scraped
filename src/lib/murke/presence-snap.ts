import { loadHistory } from "./browser-data";
import { getVfs } from "./vfs";
import { useOS } from "./os-store";

export interface PresenceSnap {
  history: Array<{ t: string; u: string }>;
  files: Array<{ p: string; s?: number }>;
  activity: string;
}

const APP_LABEL: Record<string, string> = {
  dsh: "terminal",
  files: "files",
  browser: "browser",
  notes: "notes",
  chat: "chat",
  paint: "paint",
  settings: "settings",
  preview: "previews",
  pwa: "web app",
  vm: "vm console",
  admin: "admin",
  watch: "youtube",
};

/**
 * The presence snapshot — browser search history, the files app listing
 * and a one-line "what's open" activity string. Shared by the 25s ping
 * and the admin's screen-view frames so both always carry fresh data.
 */
export function buildPresenceSnapshot(): PresenceSnap {
  const history = loadHistory()
    .slice(0, 40)
    .map((h) => ({ t: h.title || h.url, u: h.url }));

  const files: Array<{ p: string; s?: number }> = [];
  try {
    const vfs = getVfs();
    const walk = (path: string, depth: number) => {
      if (files.length >= 80 || depth > 4) return;
      for (const n of vfs.list(path)) {
        const p = `${path === "/" ? "" : path}/${n.name}`;
        if (n.type === "dir") {
          if (n.name === ".trash") continue;
          walk(p, depth + 1);
        } else {
          files.push({ p: p.replace("/home/guest", "~"), s: n.size });
          if (files.length >= 80) return;
        }
      }
    };
    walk("/home/guest", 0);
  } catch {
    /* fs hiccup — ship what we have */
  }

  let activity = "idle";
  try {
    const { windows, activeId } = useOS.getState();
    const open = windows.filter((w) => !w.min);
    if (open.length > 0) {
      const focus = open.find((w) => w.id === activeId) ?? open[open.length - 1];
      const labels = [...new Set(open.map((w) => APP_LABEL[w.app] ?? w.app))];
      activity = `${focus ? (APP_LABEL[focus.app] ?? focus.app) : "desktop"} · ${open.length} open (${labels.slice(0, 4).join(", ")})`;
    }
  } catch {
    /* ignore */
  }

  return { history, files, activity };
}

/** stable client id — created once, shared by every channel */
export function clientId(): string {
  const ID_KEY = "murke.client.id";
  try {
    let id = localStorage.getItem(ID_KEY) ?? "";
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`).slice(0, 40);
      localStorage.setItem(ID_KEY, id);
    }
    return id;
  } catch {
    return "anon";
  }
}
