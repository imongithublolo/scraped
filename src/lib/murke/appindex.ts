/**
 * appindex — the shared app + file search index behind launchpad and
 * spotlight.
 *
 * Deliberately plain (no React): `listApps` describes every launchable app
 * (dock-ordered built-ins + settings + the user's installed web apps) and
 * `searchFiles` walks the user's own VFS for substring path matches, newest
 * first. Both are cheap, synchronous and never throw — a broken file system
 * just means empty results.
 */

import { APP_META, DOCK_ORDER } from "./appmeta";
import type { AppId } from "./contracts";
import { useOS } from "./os-store";
import { getVfs } from "./vfs";

export interface AppEntry {
  id: string;
  label: string;
  kind: "builtin" | "custom";
}

export interface FileHit {
  path: string;
  name: string;
  dir: boolean;
  mtime: number;
}

/** the dock order, then settings — the launchpad/spotlight app universe */
const BUILTIN_IDS: AppId[] = [...DOCK_ORDER, "settings"];

/** vanilla zustand read (same pattern as presence-snap / os-store helpers) */
function customAppsNow(): Array<{ id: string; name: string }> {
  try {
    return useOS.getState().settings.customApps;
  } catch {
    return [];
  }
}

/**
 * Every launchable app: built-ins in DOCK_ORDER + settings (labels from
 * APP_META), then the user's installed web apps. `customApps` can be passed
 * by components that already subscribe to the store; without it the current
 * store state is read.
 */
export function listApps(customApps?: Array<{ id: string; name: string }>): AppEntry[] {
  const apps: AppEntry[] = BUILTIN_IDS.map((id) => ({
    id,
    label: APP_META[id]?.label ?? id,
    kind: "builtin",
  }));
  for (const a of customApps ?? customAppsNow()) {
    apps.push({ id: a.id, label: a.name, kind: "custom" });
  }
  return apps;
}

/* ---------- file search ---------- */

const WALK_DEPTH = 4;
const NODE_CAP = 400;

/**
 * Substring search over the user's file system (case-insensitive, matched
 * against the pretty "~/…" path). Walks from ~ depth-first (hidden entries
 * skipped), collects at most NODE_CAP hits, sorted newest-first. An empty
 * query matches everything — which IS the "recent files" list. Never throws.
 */
export function searchFiles(query: string, limit = 8): FileHit[] {
  try {
    const vfs = getVfs();
    const needle = query.trim().toLowerCase();
    const out: FileHit[] = [];
    const walk = (p: string, depth: number): void => {
      if (depth > WALK_DEPTH || out.length >= NODE_CAP) return;
      let nodes: ReturnType<typeof vfs.list>;
      try {
        nodes = vfs.list(p);
      } catch {
        return;
      }
      for (const n of nodes) {
        if (out.length >= NODE_CAP) return;
        if (n.name.startsWith(".")) continue; /* hidden dirs/files (.git, .Trash…) */
        const abs = `${p === "/" ? "" : p}/${n.name}`;
        const pretty = vfs.pretty(abs);
        if (!needle || pretty.toLowerCase().includes(needle)) {
          out.push({ path: pretty, name: n.name, dir: n.type === "dir", mtime: n.mtime ?? 0 });
        }
        if (n.type === "dir") walk(abs, depth + 1);
      }
    };
    walk(vfs.HOME, 0);
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, limit);
  } catch {
    return [];
  }
}
