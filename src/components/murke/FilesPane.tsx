"use client";

/**
 * files — the file manager. GNOME Files spirit, terminal phosphor body:
 * a Places sidebar, back/forward/up history, breadcrumb path, grid/list
 * views, right-click menus, properties, clipboard (cut/copy/paste),
 * drag-and-drop uploads from the host OS, drag-to-move inside the tree,
 * an in-os text editor for text-like files, "get from url" (pulls files
 * off the web through the proxy backend)
 * and per-file download back to the host. Everything minimal, everything
 * keyboard-driven where it counts.
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FilePlus2,
  FileText,
  FileVideo,
  Folder,
  FolderDown,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  Info,
  Link2,
  List,
  LayoutGrid,
  Loader2,
  MoreVertical,
  PanelLeft,
  PenLine,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  SquareDashed,
  SquarePen,
  Terminal,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import type { FsNode } from "@/lib/murke/contracts";
import { ensureVfs, getVfs, type VFS } from "@/lib/murke/vfs";
import { FETCH_MAX_BYTES, fetchIntoVfs, formatBytes } from "@/lib/murke/fetch-file";
import { useOS } from "@/lib/murke/os-store";
import {
  clearConnHandle,
  connectFolder,
  connPermission,
  deleteDeviceFile,
  deviceSubfolders,
  fsaSupported,
  importDeviceFile,
  loadConnHandle,
  saveConnHandle,
  walkConn,
  type DeviceConn,
  type DeviceFile,
  type DirHandleLike,
} from "@/lib/murke/device-files";

const BORDER = "border-[color-mix(in_srgb,var(--term-fg)_22%,transparent)]";
const BORDER_FAINT = "border-[color-mix(in_srgb,var(--term-fg)_12%,transparent)]";
const BTN =
  "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center border border-transparent text-[var(--term-fg)] transition-colors hover:border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] disabled:pointer-events-none disabled:opacity-25";
const BTN_ACTIVE = "border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]";

/* view prefs (single keys — survive reloads like real file managers) */
const PREF_VIEW = "daemon.files.view";
const PREF_HIDDEN = "daemon.files.hidden";
const PREF_SORT = "daemon.files.sort";
const PREF_SB = "daemon.files.sidebar";

function pref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function setPref(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

/* ---------------- Places (the sidebar) ---------------- */

interface Place {
  label: string;
  path: string;
  icon: typeof Home;
  /** auto-create the standard folders on first visit */
  mkdir?: boolean;
}

const PLACES: Place[] = [
  { label: "Home", path: "~/", icon: Home },
  { label: "Documents", path: "~/Documents", icon: FileText, mkdir: true },
  { label: "Downloads", path: "~/Downloads", icon: Download, mkdir: true },
  { label: "Music", path: "~/Music", icon: FileAudio, mkdir: true },
  { label: "Pictures", path: "~/Pictures", icon: FileImage, mkdir: true },
  { label: "Paintings", path: "~/Paintings", icon: FolderOpen, mkdir: true },
  { label: "Import", path: "~/Import", icon: FolderDown, mkdir: true },
  { label: "notes", path: "~/notes", icon: PenLine, mkdir: true },
];
const SYSTEM_PLACES: Place[] = [
  { label: "Filesystem", path: "/", icon: Folder },
  { label: "etc", path: "/etc", icon: Folder },
  { label: "logs", path: "/var/log", icon: Folder },
];

/* ---------------- icons + labels ---------------- */

const IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const AUDIO_RE = /\.(mp3|wav|ogg|m4a|flac|mod|xm|s3m|it|opus)$/i;
const VIDEO_RE = /\.(mp4|webm|mkv|avi|mov|wmv|flv)$/i;
const ARCHIVE_RE = /\.(zip|tar|gz|tgz|bz2|xz|7z|rar|iso)$/i;
const CODE_RE = /\.(js|jsx|ts|tsx|py|c|cpp|h|hpp|rs|go|java|kt|sh|bash|rb|php|lua|sql|json|ya?ml|toml|xml|html?|css|scss)$/i;
const TEXT_RE = /\.(txt|md|log|conf|ini|cfg|env|list|csv|tsv|nfo|license|readme)$/i;
const PDF_RE = /\.pdf$/i;
const MD_RE = /\.md$/i;
/** in-os editor cap — anything bigger gets refused before the dialog opens */
const EDIT_MAX_BYTES = 2 * 1024 * 1024;

/* the standard home folders carry their place icon in the grid too —
   recognizable at a glance, exactly like GNOME Files */
const PLACE_ICON: Record<string, typeof File> = Object.fromEntries(
  PLACES.map((p) => [p.label, p.icon]),
);

function iconFor(node: FsNode): typeof File {
  if (node.type === "dir") return PLACE_ICON[node.name] ?? Folder;
  if (IMG_RE.test(node.name)) return FileImage;
  if (AUDIO_RE.test(node.name)) return FileAudio;
  if (VIDEO_RE.test(node.name)) return FileVideo;
  if (ARCHIVE_RE.test(node.name)) return FileArchive;
  if (CODE_RE.test(node.name)) return FileCode2;
  if (TEXT_RE.test(node.name) || /\.(pdf)$/i.test(node.name)) return FileText;
  return File;
}

function isTextual(name: string): boolean {
  return TEXT_RE.test(name) || CODE_RE.test(name) || /\.(html?)$/i.test(name);
}

/** anything the previews app can open — double-click routes there */
function isViewable(name: string): boolean {
  return (
    IMG_RE.test(name) ||
    AUDIO_RE.test(name) ||
    VIDEO_RE.test(name) ||
    PDF_RE.test(name) ||
    MD_RE.test(name) ||
    CODE_RE.test(name) ||
    TEXT_RE.test(name) ||
    /\.(html?)$/i.test(name)
  );
}

/** Display size: stored blob size when present, char length for text. */
function nodeSize(node: FsNode): number {
  if (node.type === "dir") return -1;
  return node.size ?? node.content.length;
}

/** size cell: "—" for dirs, item count for dirs in list view */
function sizeLabel(node: FsNode): string {
  if (node.type === "dir") return `${Object.keys(node.children).length} items`;
  return formatBytes(nodeSize(node));
}

function kindLabel(node: FsNode): string {
  if (node.type === "dir") return "folder";
  const ext = node.name.includes(".") ? node.name.split(".").pop()!.toLowerCase() : "";
  if (!ext) return "file";
  const names: Record<string, string> = {
    png: "png image", jpg: "jpeg image", jpeg: "jpeg image", gif: "gif image", webp: "webp image",
    svg: "svg image", txt: "plain text", md: "markdown", log: "log", json: "json", js: "javascript",
    ts: "typescript", tsx: "typescript react", py: "python", sh: "shell script", html: "html",
    css: "css", mp3: "audio", wav: "audio", ogg: "audio", mod: "chiptune module", zip: "zip archive",
    tar: "tar archive", gz: "gzip archive", pdf: "pdf document", mp4: "video", webm: "video",
  };
  return names[ext] ?? `${ext} file`;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `yesterday ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

/* ---------------- dialogs ---------------- */

type Dialog =
  | { kind: "newFolder" }
  | { kind: "newFile" }
  | { kind: "rename"; from: string }
  | { kind: "url" }
  | { kind: "props"; path: string }
  | { kind: "delete"; names: string[] }
  | { kind: "edit"; path: string; name: string; text: string }
  | null;

interface ContextMenuState {
  x: number;
  y: number;
  /** names (children of cwd) the menu targets; empty = background menu */
  targets: string[];
}

export default function FilesPane({ arg }: { arg?: string }) {
  const vfsRef = useRef<VFS | null>(null);
  const [ready, setReady] = useState(false);

  /* history */
  const [hist, setHist] = useState<string[]>(() => {
    const start = arg ? getVfs().resolve(arg) : getVfs().HOME;
    return [getVfs().getNode(start)?.type === "dir" ? start : getVfs().HOME];
  });
  const [hidx, setHidx] = useState(0);
  const cwd = hist[hidx] ?? getVfs().HOME;

  /* view state */
  const [view, setView] = useState<"grid" | "list">(() => (pref(PREF_VIEW, "grid") === "list" ? "list" : "grid"));
  const [showHidden, setShowHidden] = useState(() => pref(PREF_HIDDEN, "0") === "1");
  const [sort, setSort] = useState<"name" | "size" | "date">(() => {
    const v = pref(PREF_SORT, "name");
    return v === "size" || v === "date" ? v : "name";
  });
  const [sidebar, setSidebar] = useState(() => pref(PREF_SB, "1") === "1");
  const [query, setQuery] = useState("");
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<{ mode: "copy" | "cut"; dir: string; names: string[] } | null>(null);

  /* overlays */
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [kebab, setKebab] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null);

  /* drag & drop */
  const [osDrag, setOsDrag] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // folder name for internal moves

  /* device connection (file system access api) */
  const [device, setDevice] = useState<DeviceConn | null>(null);
  const [devicePending, setDevicePending] = useState<{ name: string } | null>(null);
  const [deviceBusy, setDeviceBusy] = useState<string | null>(null);
  const [deviceErr, setDeviceErr] = useState("");
  const [showDevice, setShowDevice] = useState(false);
  const pendingDirRef = useRef<DirHandleLike | null>(null);
  const [fsa] = useState(fsaSupported);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const vfs = vfsRef.current ?? getVfs();
  vfsRef.current = vfs;

  /* hydrate the IDB store once, then subscribe to every mutation */
  useEffect(() => {
    let alive = true;
    void ensureVfs().then((v) => {
      if (!alive) return;
      vfsRef.current = v;
      setTick((t) => t + 1);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const off = vfs.onChange(() => setTick((t) => t + 1));
    const onWin = () => setTick((t) => t + 1);
    window.addEventListener("murke-vfs-change", onWin);
    return () => {
      off();
      window.removeEventListener("murke-vfs-change", onWin);
    };
  }, [vfs]);

  /* storage estimate for the status bar */
  useEffect(() => {
    void (async () => {
      try {
        const est = await navigator.storage?.estimate?.();
        if (est) setStorage({ used: est.usage ?? 0, quota: est.quota ?? 0 });
      } catch {
        /* ignore */
      }
    })();
  }, [tick]);

  const say = useCallback((text: string, bad = false) => {
    setNotice({ text, bad });
    window.setTimeout(() => {
      setNotice((n) => (n?.text === text ? null : n));
    }, 2600);
  }, []);

  /* ---------------- navigation ---------------- */

  const navigate = useCallback(
    (path: string) => {
      const abs = vfs.resolve(path, cwd);
      const node = vfs.getNode(abs);
      if (!node || node.type !== "dir") {
        say(`no such folder: ${vfs.pretty(abs)}`, true);
        return;
      }
      setShowDevice(false);
      const next = [...hist.slice(0, hidxRef.current + 1), abs];
      hidxRef.current = next.length - 1;
      setHist(next);
      setHidx(next.length - 1);
      setSelected(new Set());
      setQuery("");
      setMenu(null);
    },
    [vfs, cwd, hist, say]
  );

  /* hidx ref mirrors state inside the async setHist above */
  const hidxRef = useRef(0);

  /* relaunch-with-arg (dock trash, `files <path>` on a live window): when a
     new arg arrives that resolves to a directory, navigate to it */
  const lastArgRef = useRef(arg);
  useEffect(() => {
    if (arg === lastArgRef.current || !arg) return;
    lastArgRef.current = arg;
    try {
      const target = getVfs().resolve(arg);
      if (getVfs().getNode(target)?.type !== "dir") return;
      setHist((h) => {
        const next = [...h, target].slice(-60);
        hidxRef.current = next.length - 1;
        return next;
      });
      setHidx(hidxRef.current);
      setSelected(new Set());
      setQuery("");
    } catch {
      /* bad arg — keep the current folder */
    }
  }, [arg]);
  useEffect(() => {
    hidxRef.current = hidx;
  }, [hidx]);

  const goBack = useCallback(() => {
    if (hidxRef.current > 0) {
      const i = hidxRef.current - 1;
      hidxRef.current = i;
      setHidx(i);
      setSelected(new Set());
      setQuery("");
    }
  }, []);
  const goForward = useCallback(() => {
    if (hidxRef.current < hist.length - 1) {
      const i = hidxRef.current + 1;
      hidxRef.current = i;
      setHidx(i);
      setSelected(new Set());
      setQuery("");
    }
  }, [hist.length]);
  const goUp = useCallback(() => {
    if (cwd !== "/") navigate("..");
  }, [cwd, navigate]);

  /* ---------------- listing ---------------- */

  const entries = useMemo(() => {
    void tick; // recompute on every vfs mutation
    void ready;
    const node = vfs.getNode(cwd);
    if (!node || node.type !== "dir") return [];
    let items = Object.values(node.children);
    if (!showHidden) items = items.filter((n) => !n.name.startsWith("."));
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      items = items.filter((n) => n.name.toLowerCase().includes(q));
    }
    const dirFirst = (a: FsNode, b: FsNode) => (a.type === b.type ? 0 : a.type === "dir" ? -1 : 1);
    items.sort((a, b) => {
      const d = dirFirst(a, b);
      if (d) return d;
      if (sort === "size") return nodeSize(b) - nodeSize(a);
      if (sort === "date") return b.mtime - a.mtime;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    return items;
  }, [vfs, cwd, showHidden, query, sort, tick, ready]);

  const stats = useMemo(() => {
    void tick;
    const node = vfs.getNode(cwd);
    if (!node || node.type !== "dir") return { all: 0, hidden: 0 };
    const all = Object.keys(node.children);
    return { all: all.length, hidden: all.filter((n) => n.startsWith(".")).length };
  }, [vfs, cwd, tick]);

  /* ---------------- selection ---------------- */

  const select = useCallback((name: string, additive: boolean) => {
    setSelected((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      if (additive && prev.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);
  const selectAll = useCallback(() => {
    setSelected(new Set(entries.map((e) => e.name)));
  }, [entries]);
  const clearSel = useCallback(() => setSelected(new Set()), []);

  const firstSelected = useMemo(() => {
    for (const name of selected) {
      const node = vfs.getNode(`${cwd}/${name}`);
      if (node) return { name, node };
    }
    return null;
  }, [selected, vfs, cwd]);

  /* ---------------- operations ---------------- */

  const doDelete = useCallback(
    async (names: string[]) => {
      let failed = 0;
      const trashDir = vfs.resolve("~/.Trash");
      for (const name of names) {
        /* move to ~/.Trash (macOS-style) — files DELETED FROM the trash go
           for real; anything the move drops on falls back to a hard delete */
        const from = `${cwd}/${name}`;
        if (cwd !== trashDir && vfs.getNode(from)?.type === "dir") {
          const dest = `${trashDir}/${vfs.uniqueName(trashDir, name)}`;
          if (!vfs.move(from, dest)) continue;
        }
        const err = vfs.remove(`${cwd}/${name}`, undefined, true);
        if (err) failed++;
      }
      setSelected(new Set());
      setDialog(null);
      const toTrash = cwd !== trashDir;
      say(
        failed
          ? `${failed} item${failed > 1 ? "s" : ""} could not be removed`
          : toTrash
            ? `moved ${names.length} item${names.length > 1 ? "s" : ""} to the trash`
            : `deleted ${names.length} item${names.length > 1 ? "s" : ""} for good`,
        failed > 0,
      );
    },
    [vfs, cwd, say]
  );

  const doRename = useCallback(
    (from: string, to: string) => {
      const clean = to.trim();
      if (!clean || clean === from) {
        setDialog(null);
        return;
      }
      if (/[/\\]/.test(clean) || clean === "." || clean === "..") {
        say("names cannot contain / or \\ or be . or ..", true);
        return;
      }
      const err = vfs.move(`${cwd}/${from}`, `${cwd}/${clean}`);
      if (err) say(err, true);
      else {
        say(`renamed to ${clean}`);
        setSelected(new Set([clean]));
      }
      setDialog(null);
    },
    [vfs, cwd, say]
  );

  const doNewFolder = useCallback(
    (name: string) => {
      const clean = name.trim().replace(/[/\\]/g, "_");
      setDialog(null);
      if (!clean || clean === "." || clean === "..") return;
      const finalName = vfs.uniqueName(cwd, clean);
      const err = vfs.mkdir(`${cwd}/${finalName}`, undefined, false);
      if (err) say(err, true);
      else {
        say(`folder ${finalName} created`);
        setSelected(new Set([finalName]));
      }
    },
    [vfs, cwd, say]
  );

  const doPaste = useCallback(
    async (targetDir?: string) => {
      const dir = targetDir ?? cwd;
      if (!clipboard) return;
      const results: string[] = [];
      for (const name of clipboard.names) {
        const from = `${clipboard.dir}/${name}`;
        const dest = `${dir}/${vfs.uniqueName(dir, name)}`;
        if (clipboard.mode === "copy") {
          // deep copy through JSON (text) + blob reads (binary)
          const node = vfs.getNode(from);
          if (!node) continue;
          if (node.type === "dir") {
            const err = vfs.mkdir(dest, undefined, true);
            if (!err) {
              const walk = (srcDir: string, dstDir: string) => {
                for (const child of vfs.list(srcDir)) {
                  if (child.type === "dir") {
                    vfs.mkdir(`${dstDir}/${child.name}`, undefined, true);
                    walk(`${srcDir}/${child.name}`, `${dstDir}/${child.name}`);
                  } else {
                    const text = vfs.readFile(`${srcDir}/${child.name}`);
                    vfs.writeFile(`${dstDir}/${child.name}`, text ?? "", undefined);
                    void vfs.readFileBlob(`${srcDir}/${child.name}`).then((b) => {
                      if (b) void vfs.writeFileBlob(`${dstDir}/${child.name}`, b);
                    });
                  }
                }
              };
              walk(from, dest);
              results.push(name);
            }
          } else {
            const text = vfs.readFile(from) ?? "";
            if (vfs.writeFile(dest, text)) continue;
            const blob = await vfs.readFileBlob(from);
            if (blob) await vfs.writeFileBlob(dest, blob);
            results.push(name);
          }
        } else {
          const err = vfs.move(from, dest);
          if (!err) results.push(name);
        }
      }
      if (clipboard.mode === "cut") {
        setClipboard(null);
        setSelected(new Set()); // the cut items left this folder
      }
      say(results.length ? `${clipboard.mode === "copy" ? "copied" : "moved"} ${results.length} item${results.length > 1 ? "s" : ""}` : "nothing to paste", results.length === 0);
    },
    [clipboard, cwd, vfs, say]
  );

  const doDuplicate = useCallback(
    async (names: string[]) => {
      for (const name of names) {
        const node = vfs.getNode(`${cwd}/${name}`);
        if (!node) continue;
        const dot = name.lastIndexOf(".");
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        const dest = `${cwd}/${vfs.uniqueName(cwd, `${base} (copy)${ext}`)}`;
        if (node.type === "dir") {
          if (vfs.mkdir(dest, undefined, true)) continue;
          const walk = (srcDir: string, dstDir: string) => {
            for (const child of vfs.list(srcDir)) {
              if (child.type === "dir") {
                vfs.mkdir(`${dstDir}/${child.name}`, undefined, true);
                walk(`${srcDir}/${child.name}`, `${dstDir}/${child.name}`);
              } else {
                vfs.writeFile(`${dstDir}/${child.name}`, vfs.readFile(`${srcDir}/${child.name}`) ?? "");
                void vfs.readFileBlob(`${srcDir}/${child.name}`).then((b) => {
                  if (b) void vfs.writeFileBlob(`${dstDir}/${child.name}`, b);
                });
              }
            }
          };
          walk(`${cwd}/${name}`, dest);
        } else {
          vfs.writeFile(dest, node.content);
          const blob = await vfs.readFileBlob(`${cwd}/${name}`);
          if (blob) await vfs.writeFileBlob(dest, blob);
        }
      }
      say(`duplicated ${names.length} item${names.length > 1 ? "s" : ""}`);
    },
    [vfs, cwd, say]
  );

  const downloadToHost = useCallback(
    async (names: string[]) => {
      for (const name of names) {
        const node = vfs.getNode(`${cwd}/${name}`);
        if (!node || node.type !== "file") continue;
        const blob = (await vfs.readFileBlob(`${cwd}/${name}`)) ?? new Blob([node.content], { type: node.mime ?? "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = node.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      say(`saved ${names.length} file${names.length > 1 ? "s" : ""} to your downloads`);
    },
    [vfs, cwd, say]
  );

  const uploadFiles = useCallback(
    async (files: File[], dir?: string) => {
      const target = dir ?? cwd;
      let ok = 0;
      let failed = 0;
      for (const f of files) {
        if (f.size > FETCH_MAX_BYTES) {
          failed++;
          continue;
        }
        const name = vfs.uniqueName(target, f.name.replace(/[/\\]/g, "_").slice(0, 120) || "file");
        const err = await vfs.writeFileBlob(`${target}/${name}`, f);
        if (err) failed++;
        else ok++;
      }
      if (files.length) {
        say(
          failed
            ? `${ok} uploaded · ${failed} failed (over the ${formatBytes(FETCH_MAX_BYTES)} limit?)`
            : `uploaded ${ok} file${ok > 1 ? "s" : ""} → ${vfs.pretty(target)}`,
          failed > 0,
        );
      }
    },
    [vfs, cwd, say]
  );

  const doFetchUrl = useCallback(
    async (url: string) => {
      const clean = url.trim();
      setDialog(null);
      if (!clean) return;
      if (!/^https?:\/\//i.test(clean)) {
        say("give a full http(s) url", true);
        return;
      }
      setBusy("fetching");
      try {
        const meta = await fetchIntoVfs(clean, vfs, { dir: cwd });
        say(`saved ${meta.name} — ${formatBytes(meta.size)}`);
      } catch (e) {
        say(e instanceof Error ? e.message : "fetch failed", true);
      } finally {
        setBusy(null);
      }
    },
    [vfs, cwd, say]
  );

  /* ---------------- device (file system access api) ---------------- */

  /* silent reconnect: a persisted folder handle comes back granted */
  useEffect(() => {
    if (!fsa) return;
    void (async () => {
      try {
        const dir = await loadConnHandle();
        if (!dir) return;
        if (await connPermission(dir, "readwrite", false)) {
          setDevice(await walkConn(dir));
        } else {
          pendingDirRef.current = dir;
          setDevicePending({ name: dir.name });
        }
      } catch {
        /* stale handle — ignore */
      }
    })();
  }, [fsa]);

  const connectDevice = useCallback(async () => {
    setDeviceErr("");
    setDeviceBusy("connecting");
    try {
      const conn = await connectFolder();
      setDevice(conn);
      setDevicePending(null);
      pendingDirRef.current = null;
      void saveConnHandle(conn.dir);
      setShowDevice(true);
      say(`connected ${conn.name} — ${conn.files.length} files`);
    } catch (e) {
      const err = e as Error;
      if (err.name !== "AbortError") setDeviceErr(err.message || "could not connect");
    } finally {
      setDeviceBusy(null);
    }
  }, [say]);

  const reconnectDevice = useCallback(async () => {
    const dir = pendingDirRef.current;
    if (!dir) return;
    setDeviceErr("");
    setDeviceBusy("connecting");
    try {
      if (!(await connPermission(dir, "readwrite", true))) {
        setDeviceErr("permission denied — connect the folder again");
        return;
      }
      const conn = await walkConn(dir);
      setDevice(conn);
      setDevicePending(null);
      pendingDirRef.current = null;
      setShowDevice(true);
      say(`reconnected ${conn.name}`);
    } catch {
      setDeviceErr("that folder is gone — connect it again");
    } finally {
      setDeviceBusy(null);
    }
  }, [say]);

  const disconnectDevice = useCallback(() => {
    void clearConnHandle();
    pendingDirRef.current = null;
    setDevice(null);
    setDevicePending(null);
    setShowDevice(false);
    say("disconnected device folder");
  }, [say]);

  /** backup into the vfs — one file or the whole folder; optionally wipe
      the originals afterwards (the "backup & delete" flow) */
  const importFromDevice = useCallback(
    async (files: DeviceFile[], wipe: boolean) => {
      if (!device) return;
      const dest = vfs.resolve(`~/Import/${device.name.replace(/[/\\]/g, "_").slice(0, 48) || "device"}`);
      vfs.mkdir(dest, undefined, true);
      /* folders the batch will add (importDeviceFile only creates missing ones) */
      const subDirs = new Set<string>();
      for (const f of files) {
        const segs = deviceSubfolders(f.path);
        if (segs.length) subDirs.add(segs.join("/"));
      }
      let newDirs = 0;
      for (const d of subDirs) {
        if (!vfs.getNode(`${dest}/${d}`)) newDirs++;
      }
      let ok = 0;
      let failed = 0;
      const wipedPaths = new Set<string>();
      for (let i = 0; i < files.length; i++) {
        setDeviceBusy(`backing up ${i + 1}/${files.length}`);
        const err = await importDeviceFile(files[i], vfs, dest);
        if (err) failed++;
        else {
          ok++;
          if (wipe) {
            const derr = await deleteDeviceFile(device, files[i]);
            if (derr) failed++;
            else wipedPaths.add(files[i].path);
          }
        }
      }
      setDeviceBusy(null);
      if (wipe) {
        /* drop only the entries whose originals really went away */
        setDevice({ ...device, files: device.files.filter((f) => !wipedPaths.has(f.path)) });
      }
      say(
        `backed up ${ok} file${ok === 1 ? "" : "s"}${newDirs ? ` · ${newDirs} folder${newDirs === 1 ? "" : "s"} created` : ""} → ${vfs.pretty(dest)}${wipe ? " · originals deleted" : ""}${failed ? ` · ${failed} failed` : ""}`,
        failed > 0,
      );
    },
    [device, vfs, say],
  );

  const importOne = useCallback(
    async (f: DeviceFile, wipe: boolean) => {
      if (!device) return;
      setDeviceBusy(`backing up ${f.name}`);
      const dest = vfs.resolve(`~/Import/${device.name.replace(/[/\\]/g, "_").slice(0, 48) || "device"}`);
      vfs.mkdir(dest, undefined, true);
      const segs = deviceSubfolders(f.path);
      const makesFolder = segs.length > 0 && !vfs.getNode(`${dest}/${segs.join("/")}`);
      const err = await importDeviceFile(f, vfs, dest);
      if (!err && wipe) {
        const derr = await deleteDeviceFile(device, f);
        if (derr) setDeviceErr(derr);
        else setDevice({ ...device, files: device.files.filter((x) => x.path !== f.path) });
      }
      setDeviceBusy(null);
      say(err ? err : `backed up ${f.name}${makesFolder ? " — folder created" : ""}${wipe ? " · original deleted" : ""}`, Boolean(err));
    },
    [device, vfs, say],
  );

  /* ---------------- new empty file ---------------- */

  const doNewFile = useCallback(
    (name: string) => {
      const clean = name.trim().replace(/[/\\]/g, "_");
      setDialog(null);
      if (!clean || clean === "." || clean === "..") return;
      const finalName = vfs.uniqueName(cwd, clean);
      const err = vfs.writeFile(`${cwd}/${finalName}`, "");
      if (err) say(err, true);
      else {
        say(`created ${finalName}`);
        setSelected(new Set([finalName]));
      }
    },
    [vfs, cwd, say],
  );

  const openNode = useCallback(
    (node: FsNode) => {
      if (node.type === "dir") {
        navigate(node.name);
        return;
      }
      /* everything the previews app opens goes there — images, audio,
         video, pdf, text/code/markdown. one viewer for every type. */
      if (isViewable(node.name)) {
        useOS.getState().openApp("preview", `${cwd}/${node.name}`);
        return;
      }
      // binary without a viewer: straight to the host
      void downloadToHost([node.name]);
    },
    [navigate, cwd, downloadToHost]
  );

  /* ---------------- in-os text editor ---------------- */

  /** open one text-like file in the built-in editor — refuses anything
      too large or binary (nul byte in the first 4kb) before it opens */
  const openEdit = useCallback(
    async (name: string) => {
      const path = `${cwd}/${name}`;
      const node = vfs.getNode(path);
      if (!node || node.type !== "file") return;
      const declared = node.size ?? node.content.length;
      if (declared > EDIT_MAX_BYTES) {
        say(`${name} is ${formatBytes(declared)} — too big to edit (2mb max)`, true);
        return;
      }
      let text = vfs.readFile(path) ?? "";
      const blob = await vfs.readFileBlob(path);
      if (blob) {
        if (blob.size > EDIT_MAX_BYTES) {
          say(`${name} is ${formatBytes(blob.size)} — too big to edit (2mb max)`, true);
          return;
        }
        text = await blob.text(); // uploaded files live in the blob store, not in content
      }
      if (text.slice(0, 4096).includes("\u0000")) {
        say(`${name} looks binary — the editor only opens text files`, true);
        return;
      }
      setMenu(null);
      setKebab(false);
      setDialog({ kind: "edit", path, name, text });
    },
    [vfs, cwd, say],
  );

  /* ---------------- keyboard ---------------- */

  /* ESCAPE ARBITRATION — capture phase, registered before the shell's own
   * overlay-level Escape (which would close the whole app). While a dialog,
   * a menu, the kebab or a live selection is present, Escape belongs HERE:
   * dialogs/menus close themselves, otherwise the selection clears. Never
   * lets the shell slam the app shut mid-interaction. Fields INSIDE the
   * pane treat Escape as local (blur); fields outside (the shell's hidden
   * capture input) must not swallow the deselect. */
  const paneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (dialog || menu || kebab) {
        e.stopPropagation(); // the dialog/menu handlers own the close
        return;
      }
      const t = e.target as HTMLElement | null;
      const inField = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable === true;
      const insidePane = paneRef.current?.contains(t as Node) ?? false;
      if (inField && insidePane) {
        // a real field of this app (filter box, name forms) — Escape is local
        e.preventDefault();
        e.stopPropagation();
        t.blur();
        return;
      }
      if (selected.size) {
        e.preventDefault();
        e.stopPropagation();
        clearSel();
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [dialog, menu, kebab, selected, clearSel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement)?.isContentEditable;
      if (inField || dialog) return;
      if (e.key === "Backspace") {
        e.preventDefault();
        goUp();
      } else if (e.key === "Delete" && selected.size) {
        e.preventDefault();
        setDialog({ kind: "delete", names: [...selected] });
      } else if (e.key === "F2" && selected.size === 1 && firstSelected) {
        e.preventDefault();
        setDialog({ kind: "rename", from: firstSelected.name });
      } else if (e.key === "Enter" && selected.size === 1 && firstSelected) {
        e.preventDefault();
        void openNode(firstSelected.node);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selected.size) {
        setClipboard({ mode: "copy", dir: cwd, names: [...selected] });
        say(`copied ${selected.size} item${selected.size > 1 ? "s" : ""}`);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && selected.size) {
        setClipboard({ mode: "cut", dir: cwd, names: [...selected] });
        say(`cut ${selected.size} item${selected.size > 1 ? "s" : ""}`);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && clipboard) {
        void doPaste();
      } else if (e.key === "/" && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, selected, firstSelected, clipboard, cwd, clearSel, goUp, openNode, selectAll, doPaste, say]);

  /* search focus with Ctrl+F too (without clashing with the shell).
     while a dialog is up the keys belong to it — the editor textarea
     keeps native ctrl+f (browser find) instead of jumping behind the modal */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        if (dialog) return;
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);

  /* ---------------- drag & drop ---------------- */

  const onDragOverMain = useCallback((e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    if (types.includes("application/x-daemon-move")) return; // internal — handled by folders
    if (types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOsDrag(true);
    }
  }, []);
  const onDragLeaveMain = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setOsDrag(false);
  }, []);
  const onDropMain = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setOsDrag(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length) void uploadFiles(files);
    },
    [uploadFiles]
  );

  const onItemDragStart = useCallback((e: React.DragEvent, name: string) => {
    const names = selected.has(name) ? [...selected] : [name];
    if (!selected.has(name)) setSelected(new Set(names));
    e.dataTransfer.setData("application/x-daemon-move", JSON.stringify({ dir: cwd, names }));
    e.dataTransfer.effectAllowed = "move";
  }, [selected, cwd]);

  const onFolderDragOver = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes("application/x-daemon-move")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget((e.currentTarget as HTMLElement).dataset.name ?? null);
    }
  }, []);
  const onFolderDrop = useCallback(
    (e: React.DragEvent) => {
      const folder = (e.currentTarget as HTMLElement).dataset.name ?? "";
      const raw = e.dataTransfer.getData("application/x-daemon-move");
      setDropTarget(null);
      if (!raw || !folder) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        const { dir, names } = JSON.parse(raw) as { dir: string; names: string[] };
        let moved = 0;
        for (const name of names) {
          if (dir === cwd && name === folder) continue;
          const err = vfs.move(`${dir}/${name}`, `${cwd}/${folder}/${name}`);
          if (!err) moved++;
        }
        if (moved) {
          say(`moved ${moved} item${moved > 1 ? "s" : ""} into ${folder}`);
          if (dir === cwd) setSelected(new Set()); // those names left this folder
        }
      } catch {
        /* bad payload — ignore */
      }
    },
    [vfs, cwd, say]
  );

  /* ---------------- context menu ---------------- */

  const openMenu = useCallback((e: React.MouseEvent, targets: string[]) => {
    e.preventDefault();
    e.stopPropagation();
    if (targets.length === 1 && !selected.has(targets[0])) setSelected(new Set(targets));
    setMenu({ x: e.clientX, y: e.clientY, targets });
  }, [selected]);

  const menuItems = useMemo(() => {
    if (!menu) return [];
    const t = menu.targets;
    if (t.length === 0) {
      // background menu
      const items: Array<{ label: string; icon: typeof File; run?: () => void; sep?: boolean; disabled?: boolean }> = [
        { label: "New Folder", icon: FolderPlus, run: () => setDialog({ kind: "newFolder" }) },
        { label: "New Text File", icon: FilePlus2, run: () => setDialog({ kind: "newFile" }) },
        { label: "Paste", icon: ClipboardPaste, disabled: !clipboard, run: () => void doPaste() },
        { label: "Upload Files…", icon: Upload, run: () => fileInputRef.current?.click() },
        { label: "Get from URL…", icon: Link2, run: () => setDialog({ kind: "url" }) },
        { label: "sep1", icon: File, sep: true },
        { label: "Select All", icon: SquareDashed, run: selectAll },
        { label: showHidden ? "Hide Hidden Files" : "Show Hidden Files", icon: File, run: () => { setShowHidden((v) => { setPref(PREF_HIDDEN, v ? "0" : "1"); return !v; }); } },
        { label: "Refresh", icon: RefreshCw, run: () => setTick((x) => x + 1) },
        { label: "sep2", icon: File, sep: true },
        { label: "Folder Properties", icon: Info, run: () => setDialog({ kind: "props", path: cwd }) },
      ];
      return items;
    }
    const multi = t.length > 1;
    const first = t.length === 1 ? vfs.getNode(`${cwd}/${t[0]}`) : null;
    const items: Array<{ label: string; icon: typeof File; run?: () => void; sep?: boolean; disabled?: boolean }> = [
      ...(first && !multi ? [{ label: "Open", icon: ExternalLink, run: () => void openNode(first) }] : []),
      ...(first && !multi && first.type === "file" && isTextual(first.name)
        ? [{ label: "Edit", icon: SquarePen, run: () => void openEdit(first.name) }]
        : []),
      ...(first?.type === "dir" && !multi
        ? [{ label: "Open in Terminal", icon: Terminal, run: () => { window.dispatchEvent(new CustomEvent("murke-cd", { detail: vfs.resolve(`${cwd}/${first.name}`) })); } }]
        : []),
      ...(first && !multi ? [{ label: "sep0", icon: File, sep: true }] : []),
      ...(t.every((n) => vfs.getNode(`${cwd}/${n}`)?.type === "file")
        ? [{ label: multi ? `Download ${t.length} Files` : "Download", icon: Download, run: () => void downloadToHost(t) }]
        : []),
      { label: "Cut", icon: Scissors, run: () => { setClipboard({ mode: "cut", dir: cwd, names: t }); say(`cut ${t.length} item${t.length > 1 ? "s" : ""}`); } },
      { label: "Copy", icon: Copy, run: () => { setClipboard({ mode: "copy", dir: cwd, names: t }); say(`copied ${t.length} item${t.length > 1 ? "s" : ""}`); } },
      ...(first && !multi ? [{ label: "sep1", icon: File, sep: true }] : []),
      ...(first && !multi ? [{ label: "Rename…", icon: PenLine, run: () => setDialog({ kind: "rename", from: first.name }) }] : []),
      { label: "Duplicate", icon: Copy, run: () => void doDuplicate(t) },
      ...(first && !multi ? [{ label: "sep2", icon: File, sep: true }] : []),
      ...(first && !multi ? [{ label: "Properties", icon: Info, run: () => setDialog({ kind: "props", path: `${cwd}/${first.name}` }) }] : []),
      { label: multi ? `Delete ${t.length} Items` : "Delete", icon: Trash2, run: () => setDialog({ kind: "delete", names: t }) },
    ];
    return items;
  }, [menu, vfs, cwd, clipboard, showHidden, openNode, openEdit, downloadToHost, doPaste, doDuplicate, selectAll, say]);

  /* auto-create standard home folders so the sidebar never dead-ends */
  useEffect(() => {
    for (const p of PLACES) {
      if (p.mkdir && !vfs.getNode(p.path)) vfs.mkdir(p.path, undefined, true);
    }
  }, [vfs, tick]);

  /* focus the name field when a naming dialog opens */
  useEffect(() => {
    if (dialog && (dialog.kind === "newFolder" || dialog.kind === "newFile" || dialog.kind === "rename" || dialog.kind === "url")) {
      window.setTimeout(() => nameInputRef.current?.select(), 30);
    }
  }, [dialog]);

  /* ---------------- render helpers ---------------- */

  const crumbs = useMemo(() => {
    const parts = cwd.split("/").filter(Boolean);
    const acc: string[] = [];
    for (const p of parts) acc.push((acc[acc.length - 1] ?? "") + "/" + p);
    return acc; // absolute paths of each segment
  }, [cwd]);

  const clipboardHint = clipboard
    ? `${clipboard.mode === "cut" ? "cut" : "copied"} ${clipboard.names.length} → ${vfs.pretty(clipboard.dir)}`
    : "";
  /* the toolbar edit action targets the one selected text-like file */
  const selNode = firstSelected?.node;
  const canEdit = Boolean(selNode && selNode.type === "file" && isTextual(selNode.name));

  /* ------------------------------ render ------------------------------ */

  return (
    <div ref={paneRef} className="flex h-full w-full flex-col bg-[var(--glass-bg,var(--term-bg))] font-mono text-[12.5px] text-[var(--term-fg)]">
      <div className="flex min-h-0 flex-1">
        {/* sidebar */}
        {sidebar && (
          <nav className={`hidden w-44 shrink-0 flex-col overflow-y-auto border-r px-1.5 py-2 sm:flex ${BORDER_FAINT}`} aria-label="places">
            <p className="px-2 pb-1 pt-1 text-[9.5px] uppercase tracking-[0.25em] text-[var(--term-dim)]">Places</p>
            {PLACES.map((p) => (
              <PlaceRow key={p.path} place={p} active={!showDevice && cwd === vfs.resolve(p.path)} onClick={() => navigate(p.path)} />
            ))}
            <p className="px-2 pb-1 pt-3 text-[9.5px] uppercase tracking-[0.25em] text-[var(--term-dim)]">System</p>
            {SYSTEM_PLACES.map((p) => (
              <PlaceRow key={p.path} place={p} active={!showDevice && cwd === vfs.resolve(p.path)} onClick={() => navigate(p.path)} />
            ))}
            <p className="px-2 pb-1 pt-3 text-[9.5px] uppercase tracking-[0.25em] text-[var(--term-dim)]">Device</p>
            {device && (
              <button
                type="button"
                onClick={() => setShowDevice(true)}
                className={`flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-[12px] transition-colors ${
                  showDevice ? "bg-[color-mix(in_srgb,var(--term-brand)_16%,transparent)] text-[var(--term-fg)]" : "text-[var(--term-dim)] hover:bg-[color-mix(in_srgb,var(--term-fg)_7%,transparent)] hover:text-[var(--term-fg)]"
                }`}
                aria-current={showDevice ? "page" : undefined}
              >
                <HardDrive size={13} strokeWidth={1.7} className={showDevice ? "text-[var(--term-brand)]" : "opacity-70"} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{device.name}</span>
              </button>
            )}
            {devicePending && (
              <button
                type="button"
                onClick={() => void reconnectDevice()}
                className="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-[12px] text-[var(--term-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_7%,transparent)] hover:text-[var(--term-fg)]"
              >
                <HardDrive size={13} strokeWidth={1.7} className="opacity-70" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">reconnect {devicePending.name}…</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => void connectDevice()}
              disabled={!fsa || deviceBusy === "connecting"}
              className="mt-1 flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-[11.5px] text-[var(--term-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_7%,transparent)] hover:text-[var(--term-fg)] disabled:pointer-events-none disabled:opacity-40"
            >
              {deviceBusy === "connecting" ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Plus size={13} strokeWidth={1.7} aria-hidden="true" />}
              <span className="min-w-0 flex-1 truncate">{device ? "connect another…" : "connect folder…"}</span>
            </button>
            {!fsa && <p className="px-2 pb-1 pt-1 text-[9.5px] leading-snug text-[var(--term-dim)] opacity-70">needs a chromium browser — file system access api</p>}
          </nav>
        )}

        {/* main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* toolbar */}
          <div className={`flex shrink-0 items-center gap-1 border-b px-2 py-1.5 ${BORDER_FAINT}`}>
            <button type="button" className={`${BTN} ${hidx > 0 ? "" : "opacity-25"}`} onClick={goBack} disabled={hidx === 0} title="back" aria-label="go back">
              <ArrowLeft size={14} />
            </button>
            <button type="button" className={`${BTN} ${hidx < hist.length - 1 ? "" : "opacity-25"}`} onClick={goForward} disabled={hidx >= hist.length - 1} title="forward" aria-label="go forward">
              <ArrowRight size={14} />
            </button>
            <button type="button" className={`${BTN} ${cwd === "/" ? "opacity-25" : ""}`} onClick={goUp} disabled={cwd === "/"} title="parent folder (backspace)" aria-label="go up">
              <ArrowUp size={14} />
            </button>

            {/* breadcrumb — or the device bar when a device folder is open */}
            {showDevice && device ? (
              <div className={`mx-1 flex min-w-0 flex-1 items-center gap-2 border px-2 py-1 ${BORDER_FAINT}`} role="navigation" aria-label="device folder">
                <HardDrive size={12} className="shrink-0 text-[var(--term-brand)]" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[11.5px]">
                  {device.name} <span className="text-[var(--term-dim)]">· {device.files.length} file{device.files.length === 1 ? "" : "s"} on your machine</span>
                </span>
                <button
                  type="button"
                  onClick={() => void importFromDevice(device.files, false)}
                  disabled={Boolean(deviceBusy) || device.files.length === 0}
                  className={`shrink-0 cursor-pointer border px-2 py-0.5 text-[10.5px] transition-colors hover:bg-[color-mix(in_srgb,var(--term-brand)_14%,transparent)] disabled:pointer-events-none disabled:opacity-40 ${BORDER}`}
                >
                  back up all
                </button>
                <button
                  type="button"
                  onClick={() => void importFromDevice(device.files, true)}
                  disabled={Boolean(deviceBusy) || device.files.length === 0}
                  className="shrink-0 cursor-pointer border border-[color-mix(in_srgb,var(--term-err)_45%,transparent)] px-2 py-0.5 text-[10.5px] text-[var(--term-err)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-err)_12%,transparent)] disabled:pointer-events-none disabled:opacity-40"
                >
                  back up & delete originals
                </button>
                <button
                  type="button"
                  onClick={disconnectDevice}
                  className="shrink-0 cursor-pointer p-0.5 text-[var(--term-dim)] hover:text-[var(--term-err)]"
                  title="disconnect folder"
                  aria-label="disconnect device folder"
                >
                  <XCircle size={13} />
                </button>
              </div>
            ) : (
              <div className={`mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto border px-2 py-1 ${BORDER_FAINT}`} role="navigation" aria-label="path">
                <button
                  type="button"
                  onClick={() => navigate("/")}
                  className="shrink-0 cursor-pointer p-0.5 text-[var(--term-dim)] hover:text-[var(--term-fg)]"
                  title="/"
                >
                  <Home size={12} />
                </button>
                {crumbs.map((p, i) => (
                  <span key={p} className="flex shrink-0 items-center">
                    <ChevronRight size={10} className="text-[var(--term-dim)] opacity-60" />
                    <button
                      type="button"
                      onClick={() => navigate(p)}
                      className={`cursor-pointer whitespace-nowrap px-1 py-0.5 hover:text-[var(--term-hi)] ${i === crumbs.length - 1 ? "text-[var(--term-fg)]" : "text-[var(--term-dim)]"}`}
                    >
                      {p.split("/").pop()}
                    </button>
                  </span>
                ))}
                {crumbs.length === 0 && <span className="px-1 text-[var(--term-dim)]">/</span>}
              </div>
            )}

            {/* search — filters the device list too */}
            <div className={`flex h-7 items-center gap-1.5 border px-2 ${BORDER_FAINT}`}>
              <Search size={12} className="shrink-0 text-[var(--term-dim)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter"
                aria-label={showDevice ? "filter device files" : "filter current folder"}
                className="w-20 bg-transparent text-[11.5px] outline-none placeholder:text-[var(--term-dim)] focus:w-32 sm:w-24 sm:focus:w-40"
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} className="cursor-pointer text-[var(--term-dim)] hover:text-[var(--term-fg)]" aria-label="clear filter">
                  <X size={11} />
                </button>
              )}
            </div>

            <button type="button" className={`${BTN} ${view === "grid" ? BTN_ACTIVE : ""}`} onClick={() => { setView("grid"); setPref(PREF_VIEW, "grid"); }} title="grid view" aria-pressed={view === "grid"}>
              <LayoutGrid size={14} />
            </button>
            <button type="button" className={`${BTN} ${view === "list" ? BTN_ACTIVE : ""}`} onClick={() => { setView("list"); setPref(PREF_VIEW, "list"); }} title="list view" aria-pressed={view === "list"}>
              <List size={14} />
            </button>
            <button type="button" className={`${BTN} ${sidebar ? BTN_ACTIVE : ""} hidden sm:flex`} onClick={() => { setSidebar((v) => { setPref(PREF_SB, v ? "0" : "1"); return !v; }); }} title="toggle sidebar" aria-pressed={sidebar}>
              <PanelLeft size={14} />
            </button>
            <button
              type="button"
              className={BTN}
              onClick={() => {
                if (canEdit && firstSelected) void openEdit(firstSelected.name);
              }}
              disabled={!canEdit}
              title="edit selected text file"
              aria-label="edit selected text file"
            >
              <SquarePen size={14} />
            </button>
            <button type="button" className={BTN} onClick={() => fileInputRef.current?.click()} title="upload files into this folder" aria-label="upload files">
              <Upload size={14} />
            </button>

            {/* kebab */}
            <div className="relative">
              <button
                type="button"
                className={`${BTN} ${kebab ? BTN_ACTIVE : ""}`}
                onClick={() => { setKebab((v) => !v); setMenu(null); }}
                title="menu"
                aria-label="file manager menu"
                aria-expanded={kebab}
              >
                <MoreVertical size={14} />
              </button>
              {kebab && (
                <FloatingMenu
                  items={[
                    { label: "New Folder", icon: FolderPlus, run: () => setDialog({ kind: "newFolder" }) },
                    { label: "Get from URL…", icon: Link2, run: () => setDialog({ kind: "url" }) },
                    { label: "sep-a", icon: File, sep: true },
                    { label: "Select All", icon: SquareDashed, run: selectAll },
                    { label: showHidden ? "Hide Hidden Files" : "Show Hidden Files", icon: File, run: () => { setShowHidden((v) => { setPref(PREF_HIDDEN, v ? "0" : "1"); return !v; }); } },
                    {
                      label: sort === "name" ? "Sort: Name" : sort === "size" ? "Sort: Size" : "Sort: Modified",
                      icon: RefreshCw,
                      run: () => setSort((s) => { const next = s === "name" ? "size" : s === "size" ? "date" : "name"; setPref(PREF_SORT, next); return next; }),
                    },
                    { label: "sep-b", icon: File, sep: true },
                    { label: "Paste", icon: ClipboardPaste, disabled: !clipboard, run: () => void doPaste() },
                    { label: "Folder Properties", icon: Info, run: () => setDialog({ kind: "props", path: cwd }) },
                  ]}
                  onClose={() => setKebab(false)}
                  anchorRight
                />
              )}
            </div>
          </div>

          {/* content */}
          <div
            className={`relative min-h-0 flex-1 overflow-y-auto ${osDrag && !showDevice ? "outline-2 outline-dashed outline-[var(--term-brand)]" : ""}`}
            onDragOver={showDevice ? undefined : onDragOverMain}
            onDragLeave={showDevice ? undefined : onDragLeaveMain}
            onDrop={showDevice ? undefined : onDropMain}
            onClick={(e) => {
              if (e.target === e.currentTarget) clearSel();
            }}
            onContextMenu={(e) => !showDevice && openMenu(e, [])}
            role="main"
            aria-label={showDevice ? "device files" : "folder contents"}
          >
            {showDevice && device ? (
              /* ---------------- device view — the connected host folder ---------------- */
              (() => {
                const q = query.trim().toLowerCase();
                const rows = q ? device.files.filter((f) => f.path.toLowerCase().includes(q)) : device.files;
                if (rows.length === 0) {
                  return (
                    <div className="flex h-full flex-col items-center justify-center gap-3 select-none">
                      <HardDrive size={44} strokeWidth={1} className="text-[var(--term-dim)] opacity-50" aria-hidden="true" />
                      <p className="text-[var(--term-dim)]">{query ? "nothing matches that filter" : "no files in that folder"}</p>
                      <p className="text-[10.5px] text-[var(--term-dim)] opacity-70">back up everything with the buttons above · or per-file below</p>
                    </div>
                  );
                }
                return (
                  <div className="px-2 py-1.5">
                    <div className={`flex items-center gap-2 border-b px-2 pb-1 text-[9.5px] uppercase tracking-[0.18em] text-[var(--term-dim)] ${BORDER_FAINT}`}>
                      <span className="flex-1">name</span>
                      <span className="hidden w-44 shrink-0 sm:block">location</span>
                      <span className="w-20 shrink-0 text-right">size</span>
                      <span className="w-44 shrink-0 text-right">actions</span>
                    </div>
                    {rows.map((f) => (
                      <div key={f.path} className="flex items-center gap-2 border-b border-transparent px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_6%,transparent)]">
                        <File size={15} strokeWidth={1.6} className="shrink-0 opacity-80" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate" title={f.path}>{f.name}</span>
                        <span className="hidden w-44 shrink-0 truncate text-[10.5px] text-[var(--term-dim)] sm:block">{f.path.slice(0, f.path.lastIndexOf("/")) || "."}</span>
                        <span className="w-20 shrink-0 text-right text-[10.5px] text-[var(--term-dim)]">{formatBytes(f.size)}</span>
                        <span className="flex w-44 shrink-0 items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => void importOne(f, false)}
                            disabled={Boolean(deviceBusy)}
                            className={`cursor-pointer border px-1.5 py-0.5 text-[10px] transition-colors hover:bg-[color-mix(in_srgb,var(--term-brand)_14%,transparent)] disabled:pointer-events-none disabled:opacity-40 ${BORDER}`}
                          >
                            back up
                          </button>
                          <button
                            type="button"
                            onClick={() => void importOne(f, true)}
                            disabled={Boolean(deviceBusy)}
                            className="cursor-pointer border border-[color-mix(in_srgb,var(--term-err)_45%,transparent)] px-1.5 py-0.5 text-[10px] text-[var(--term-err)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-err)_12%,transparent)] disabled:pointer-events-none disabled:opacity-40"
                          >
                            back up + delete
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                );
              })()
            ) : entries.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 select-none">
                <FolderOpen size={44} strokeWidth={1} className="text-[var(--term-dim)] opacity-50" />
                <p className="text-[var(--term-dim)]">{query ? "nothing matches that filter" : "this folder is empty"}</p>
                <p className="text-[10.5px] text-[var(--term-dim)] opacity-70">drag files here · double-click opens previews · right-click for more</p>
              </div>
            ) : view === "grid" ? (
              <div className="grid gap-1 p-3 [grid-template-columns:repeat(auto-fill,minmax(104px,1fr))]">
                {entries.map((node) => {
                  const Icon = iconFor(node);
                  const sel = selected.has(node.name);
                  return (
                    <button
                      type="button"
                      key={node.name}
                      data-name={node.type === "dir" ? node.name : undefined}
                      draggable
                      onDragStart={(e) => onItemDragStart(e, node.name)}
                      onDragOver={node.type === "dir" ? onFolderDragOver : undefined}
                      onDragLeave={node.type === "dir" ? () => setDropTarget((d) => (d === node.name ? null : d)) : undefined}
                      onDrop={node.type === "dir" ? onFolderDrop : undefined}
                      onClick={(e) => { e.stopPropagation(); select(node.name, e.ctrlKey || e.metaKey); }}
                      onDoubleClick={() => void openNode(node)}
                      onContextMenu={(e) => openMenu(e, [node.name])}
                      className={`group flex cursor-pointer flex-col items-center gap-1.5 border px-2 py-3 text-center transition-colors ${
                        sel
                          ? "border-[color-mix(in_srgb,var(--term-brand)_55%,transparent)] bg-[color-mix(in_srgb,var(--term-brand)_14%,transparent)]"
                          : "border-transparent hover:bg-[color-mix(in_srgb,var(--term-fg)_7%,transparent)]"
                      } ${dropTarget === node.name ? "border-dashed !border-[var(--term-brand)] bg-[color-mix(in_srgb,var(--term-brand)_10%,transparent)]" : ""}`}
                      aria-label={node.name}
                    >
                      <Icon size={30} strokeWidth={1.4} className={node.type === "dir" ? "text-[var(--term-brand)]" : "text-[var(--term-fg)] opacity-85"} />
                      <span className="line-clamp-2 w-full break-all text-[11px] leading-tight opacity-90">{node.name}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-2 py-1.5">
                <div className={`flex items-center gap-2 border-b px-2 pb-1 text-[9.5px] uppercase tracking-[0.18em] text-[var(--term-dim)] ${BORDER_FAINT}`}>
                  <span className="flex-1">name</span>
                  <span className="w-24 shrink-0 text-right">size</span>
                  <span className="w-40 shrink-0 text-right">modified</span>
                </div>
                {entries.map((node) => {
                  const Icon = iconFor(node);
                  const sel = selected.has(node.name);
                  return (
                    <button
                      type="button"
                      key={node.name}
                      data-name={node.type === "dir" ? node.name : undefined}
                      draggable
                      onDragStart={(e) => onItemDragStart(e, node.name)}
                      onDragOver={node.type === "dir" ? onFolderDragOver : undefined}
                      onDragLeave={node.type === "dir" ? () => setDropTarget((d) => (d === node.name ? null : d)) : undefined}
                      onDrop={node.type === "dir" ? onFolderDrop : undefined}
                      onClick={(e) => { e.stopPropagation(); select(node.name, e.ctrlKey || e.metaKey); }}
                      onDoubleClick={() => void openNode(node)}
                      onContextMenu={(e) => openMenu(e, [node.name])}
                      className={`flex w-full cursor-pointer items-center gap-2 border-b border-transparent px-2 py-1.5 text-left transition-colors ${
                        sel
                          ? "bg-[color-mix(in_srgb,var(--term-brand)_14%,transparent)] outline outline-1 outline-[color-mix(in_srgb,var(--term-brand)_50%,transparent)]"
                          : "hover:bg-[color-mix(in_srgb,var(--term-fg)_7%,transparent)]"
                      } ${dropTarget === node.name ? "outline outline-1 outline-dashed outline-[var(--term-brand)]" : ""}`}
                      aria-label={node.name}
                    >
                      <Icon size={15} strokeWidth={1.6} className={`shrink-0 ${node.type === "dir" ? "text-[var(--term-brand)]" : "opacity-80"}`} />
                      <span className="min-w-0 flex-1 truncate">{node.name}</span>
                      <span className="w-24 shrink-0 text-right text-[11px] text-[var(--term-dim)]">{sizeLabel(node)}</span>
                      <span className="hidden w-40 shrink-0 text-right text-[11px] text-[var(--term-dim)] md:block">{fmtDate(node.mtime)}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* os drag overlay */}
            {osDrag && (
              <div className="pointer-events-none absolute inset-3 flex items-center justify-center bg-[color-mix(in_srgb,var(--term-bg)_80%,transparent)]">
                <div className={`flex flex-col items-center gap-2 border-2 border-dashed px-10 py-8 ${BORDER}`}>
                  <Upload size={26} className="text-[var(--term-brand)]" />
                  <p className="text-[var(--term-fg)]">drop to upload into {vfs.pretty(cwd)}</p>
                </div>
              </div>
            )}
          </div>

          {/* status bar */}
          <div className={`flex shrink-0 items-center justify-between gap-3 border-t px-3 py-1 text-[10px] text-[var(--term-dim)] ${BORDER_FAINT}`}>
            <span className="shrink-0">
              {stats.all} item{stats.all === 1 ? "" : "s"}
              {stats.hidden > 0 && !showHidden ? ` · ${stats.hidden} hidden` : ""}
            </span>
            <span className={`min-w-0 flex-1 truncate text-center ${notice?.bad || deviceErr ? "text-[var(--term-err)]" : notice ? "text-[var(--term-fg)]" : ""}`}>
              {busy === "fetching" ? "downloading…" : (deviceBusy ?? (notice?.text ?? (clipboardHint || deviceErr || "")))}
            </span>
            <span className="shrink-0">
              {selected.size > 0 ? `${selected.size} selected` : storage ? `${formatBytes(storage.used)} stored` : ""}
            </span>
          </div>
        </div>
      </div>

      {/* right-click menu */}
      {menu && <ContextMenu state={menu} items={menuItems} onClose={() => setMenu(null)} />}

      {/* hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void uploadFiles(files);
          e.target.value = "";
        }}
        aria-hidden="true"
      />

      {/* ---------------- dialogs ---------------- */}
      {dialog?.kind === "newFolder" && (
        <Modal title="new folder" onClose={() => setDialog(null)}>
          <NameForm
            inputRef={nameInputRef}
            initial="untitled folder"
            placeholder="folder name"
            submitLabel="create"
            onCancel={() => setDialog(null)}
            onSubmit={doNewFolder}
          />
        </Modal>
      )}
      {dialog?.kind === "newFile" && (
        <Modal title="new text file" onClose={() => setDialog(null)}>
          <NameForm
            inputRef={nameInputRef}
            initial="untitled.txt"
            placeholder="file name"
            submitLabel="create"
            onCancel={() => setDialog(null)}
            onSubmit={doNewFile}
          />
        </Modal>
      )}
      {dialog?.kind === "rename" && (
        <Modal title={`rename ${dialog.from}`} onClose={() => setDialog(null)}>
          <NameForm inputRef={nameInputRef} initial={dialog.from} placeholder="new name" submitLabel="rename" onCancel={() => setDialog(null)} onSubmit={(n) => doRename(dialog.from, n)} />
        </Modal>
      )}
      {dialog?.kind === "url" && (
        <Modal title="get from url" onClose={() => setDialog(null)}>
          <p className="mb-3 text-[11px] text-[var(--term-dim)]">
            pulls the file off the web through the proxy and stores it in {vfs.pretty(cwd)}.
          </p>
          <NameForm inputRef={nameInputRef} initial="" placeholder="https://…" submitLabel="fetch" url onCancel={() => setDialog(null)} onSubmit={(u) => void doFetchUrl(u)} />
        </Modal>
      )}
      {dialog?.kind === "delete" && (
        <Modal title={dialog.names.length > 1 ? `delete ${dialog.names.length} items?` : `delete ${dialog.names[0]}?`} onClose={() => setDialog(null)}>
          <p className="mb-4 text-[11.5px] text-[var(--term-dim)]">this cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <button type="button" className={`cursor-pointer border px-3 py-1.5 text-[11.5px] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] ${BORDER}`} onClick={() => setDialog(null)}>
              cancel
            </button>
            <button
              type="button"
              className="cursor-pointer border border-[color-mix(in_srgb,var(--term-err)_60%,transparent)] bg-[color-mix(in_srgb,var(--term-err)_18%,transparent)] px-3 py-1.5 text-[11.5px] text-[var(--term-err)] hover:bg-[color-mix(in_srgb,var(--term-err)_28%,transparent)]"
              onClick={() => void doDelete(dialog.names)}
            >
              delete
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === "props" && <PropsDialog path={dialog.path} vfs={vfs} onClose={() => setDialog(null)} />}
      {dialog?.kind === "edit" && (
        <EditDialog
          path={dialog.path}
          name={dialog.name}
          initial={dialog.text}
          vfs={vfs}
          onClose={() => setDialog(null)}
          onSaved={(bytes) => {
            setDialog(null);
            setTick((t) => t + 1); // refresh the listing (size + mtime changed)
            say(`saved ${dialog.name} — ${formatBytes(bytes)}`);
          }}
        />
      )}
    </div>
  );
}

/* ================= subcomponents ================= */

function PlaceRow({ place, active, onClick }: { place: Place; active: boolean; onClick: () => void }) {
  const Icon = place.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-[12px] transition-colors ${
        active ? "bg-[color-mix(in_srgb,var(--term-brand)_16%,transparent)] text-[var(--term-fg)]" : "text-[var(--term-dim)] hover:bg-[color-mix(in_srgb,var(--term-fg)_7%,transparent)] hover:text-[var(--term-fg)]"
      }`}
      aria-current={active ? "page" : undefined}
    >
      <Icon size={13} strokeWidth={1.7} className={active ? "text-[var(--term-brand)]" : "opacity-70"} />
      <span className="truncate">{place.label}</span>
    </button>
  );
}

interface MenuItem {
  label: string;
  icon: typeof File;
  run?: () => void;
  sep?: boolean;
  disabled?: boolean;
}

function FloatingMenu({
  items,
  onClose,
  x,
  y,
  anchorRight,
}: {
  items: MenuItem[];
  onClose: () => void;
  /** fixed coordinates (context menu) — when omitted the menu anchors right */
  x?: number;
  y?: number;
  anchorRight?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // capture + stopPropagation: the menu consumes Escape so the shell's
    // overlay-level handler never slams the whole app shut
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const style: React.CSSProperties =
    x !== undefined && y !== undefined
      ? {
          left: Math.min(x, window.innerWidth - 230),
          top: Math.min(y, window.innerHeight - 40 - items.length * 28),
        }
      : { right: 8, top: 64 };

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[70] min-w-[196px] border bg-[color-mix(in_srgb,var(--term-bg)_97%,transparent)] py-1 shadow-[0_8px_32px_rgba(0,0,0,0.55)]"
      style={style}
    >
      {items.map((it, i) =>
        it.sep ? (
          <div key={`sep${i}`} className={`my-1 border-t ${BORDER_FAINT}`} />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.run?.();
            }}
            className={`flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors ${
              it.disabled
                ? "opacity-30"
                : "text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-brand)_16%,transparent)]"
            }`}
          >
            <it.icon size={13} strokeWidth={1.7} className={it.disabled ? "" : "text-[var(--term-brand)] opacity-80"} />
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

function ContextMenu({ state, items, onClose }: { state: ContextMenuState; items: MenuItem[]; onClose: () => void }) {
  return <FloatingMenu items={items} onClose={onClose} x={state.x} y={state.y} />;
}

function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-label={title}
        className={`w-full ${wide ? "max-w-2xl" : "max-w-sm"} border bg-[var(--term-bg)] p-4 shadow-[0_16px_64px_rgba(0,0,0,0.7)] ${BORDER}`}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[12px] font-bold tracking-[0.18em] uppercase">{title}</h2>
          <button type="button" onClick={onClose} className={BTN} aria-label="close dialog">
            <X size={13} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const NameForm = function NameForm({
  initial,
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  url,
  inputRef,
}: {
  initial: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  url?: boolean;
  inputRef: React.Ref<HTMLInputElement>;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        autoFocus
        inputMode={url ? "url" : "text"}
        autoComplete="off"
        spellCheck={false}
        className={`w-full border bg-transparent px-2.5 py-2 text-[12.5px] outline-none focus:border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)] ${BORDER}`}
      />
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          className={`cursor-pointer border px-3 py-1.5 text-[11.5px] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] ${BORDER}`}
          onClick={onCancel}
        >
          cancel
        </button>
        <button
          type="submit"
          className="cursor-pointer border border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)] bg-[color-mix(in_srgb,var(--term-brand)_16%,transparent)] px-3 py-1.5 text-[11.5px] hover:bg-[color-mix(in_srgb,var(--term-brand)_28%,transparent)]"
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
};

function PropsIcon({ node }: { node: FsNode }) {
  // createElement (not JSX) — the lucide icon set is stable, but the lint
  // rule can't tell an icon lookup from component creation
  return createElement(iconFor(node), {
    size: 38,
    strokeWidth: 1.2,
    className: node.type === "dir" ? "text-[var(--term-brand)]" : "opacity-85",
  });
}

function PropsDialog({ path, vfs, onClose }: { path: string; vfs: VFS; onClose: () => void }) {
  const node = vfs.getNode(path);
  if (!node) return null;
  const rows: Array<[string, string]> =
    node.type === "dir"
      ? [
          ["name", node.name],
          ["kind", "folder"],
          ["location", vfs.pretty(path.split("/").slice(0, -1).join("/") || "/")],
          ["items", `${Object.keys(node.children).length}`],
          ["modified", fmtDate(node.mtime)],
        ]
      : [
          ["name", node.name],
          ["kind", kindLabel(node)],
          ["size", formatBytes(nodeSize(node))],
          ["location", vfs.pretty(path.split("/").slice(0, -1).join("/") || "/")],
          ["modified", fmtDate(node.mtime)],
          ...(node.mime ? ([["type", node.mime]] as Array<[string, string]>) : []),
          ...(node.size !== undefined ? ([["storage", "binary blob (indexeddb)"]] as Array<[string, string]>) : []),
        ];
  return (
    <Modal title="properties" onClose={onClose}>
      <div className="flex items-start gap-3">
        <PropsIcon node={node} />
        <dl className="min-w-0 flex-1 space-y-1.5 text-[11.5px]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="w-20 shrink-0 text-[var(--term-dim)]">{k}</dt>
              <dd className="min-w-0 flex-1 break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Modal>
  );
}

function EditDialog({
  path,
  name,
  initial,
  vfs,
  onClose,
  onSaved,
}: {
  path: string;
  name: string;
  initial: string;
  vfs: VFS;
  onClose: () => void;
  onSaved: (bytes: number) => void;
}) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const dirty = text !== initial;

  /** save through the blob side so text and binary storage stay consistent */
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const werr = await vfs.writeFileBlob(path, new Blob([text], { type: "text/plain;charset=utf-8" }));
    setSaving(false);
    if (werr) setErr(werr);
    else onSaved(new TextEncoder().encode(text).length);
  };

  return (
    <Modal title={`edit ${name}`} wide onClose={onClose}>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (err) setErr("");
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void save();
          }
        }}
        spellCheck={false}
        autoFocus
        aria-label={`editing ${name}`}
        className={`h-[46vh] w-full resize-y overflow-y-auto border bg-transparent px-2.5 py-2 font-mono text-[12px] leading-relaxed outline-none focus:border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)] ${BORDER}`}
      />
      {err && (
        <p className="mt-2 text-[11px] text-[var(--term-err)]" role="alert">
          {err}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--term-dim)]">
          {text.length} chars{dirty ? " · unsaved changes" : ""} · ctrl+s saves
        </span>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className={`cursor-pointer border px-3 py-1.5 text-[11.5px] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] ${BORDER}`}
            onClick={onClose}
          >
            cancel
          </button>
          <button
            type="button"
            disabled={saving || !dirty}
            className="cursor-pointer border border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)] bg-[color-mix(in_srgb,var(--term-brand)_16%,transparent)] px-3 py-1.5 text-[11.5px] hover:bg-[color-mix(in_srgb,var(--term-brand)_28%,transparent)] disabled:pointer-events-none disabled:opacity-40"
            onClick={() => void save()}
          >
            {saving ? "saving…" : "save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

