import type { FsDir, FsFile, FsNode } from "./contracts";
import { LS } from "./contracts";

/**
 * DAEMON virtual file system — IndexedDB backed.
 *
 * The tree (structure + text file contents) lives in memory and is written
 * through to IndexedDB on every mutation, so the whole terminal keeps its
 * synchronous `vfs.xxx()` API. Binary payloads (downloads, uploads, paint
 * saves) are stored as real Blobs in a sibling object store, keyed by path —
 * `writeFileBlob` / `readFileBlob` are the async door into that side.
 *
 * Why IndexedDB and not localStorage: localStorage caps out around 5MB and
 * forces base64 for anything binary. IDB gives us hundreds of megabytes and
 * native Blob storage, which is what a file manager that downloads from the
 * real web needs.
 *
 * Legacy migration: the old localStorage tree (daemon.vfs.3) is imported on
 * first boot, then removed. Paint dataURLs are decoded into real png blobs.
 */

const DB_NAME = "daemon-vfs";
const DB_VERSION = 1;
const STORE_META = "meta"; // key "tree" -> the FsDir root
const STORE_BLOBS = "blobs"; // key path -> Blob
const TREE_KEY = "tree";

/* ---------- seed tree ---------- */

function dir(name: string, children: Record<string, FsNode> = {}): FsDir {
  return { type: "dir", name, children, mtime: Date.now() };
}

function file(name: string, content: string): FsFile {
  return { type: "file", name, content, mtime: Date.now() };
}

function seedTree(): FsDir {
  const motd = [
    "daemon proxy — quickstart",
    "",
    "  proxy <url>     browse the real web",
    "  files           the file manager",
    "  help            every command, man-page style",
    "  neofetch        system info",
    "  credits         who built it",
  ].join("\n");

  const readme = [
    "daemon proxy",
    "",
    "a red terminal living in a browser tab.",
    "everything here is simulated except the proxy:",
    "scramjet over a streaming relay, carrying real traffic.",
    "",
    "files live for real — upload them, download them off",
    "the web through the proxy, drag them in, take them back out.",
    "",
    "built by b29s (dan) and GLM — see: credits",
  ].join("\n");

  const notes = [
    "- tab completes. arrows recall. esc forgives.",
    "- files opens the file manager — drag files onto it to upload.",
    "- fetch <url> pulls any file off the web into ~/Downloads.",
    "- alt+` closes the browser takeover.",
  ].join("\n");

  const credits = [
    "DAEMON PROXY",
    "",
    "  developed by",
    "    b29s (dan)   <3",
    "    GLM    <3",
    "",
    "  proxy core: scramjet (mercury workshop)",
  ].join("\n");

  return dir("/", {
    bin: dir("bin", {
      dsh: file("dsh", "[binary] daemon shell v2.2"),
      scramjet: file("scramjet", "[binary] scramjet transport agent"),
    }),
    etc: dir("etc", {
      issue: file("issue", "DAEMON PROXY \\r \\n (tty1)\n"),
      motd: file("motd", motd),
      passwd: file(
        "passwd",
        "root:x:0:0:sysop:/:/bin/dsh\nguest:x:1000:1000:anonymous:/:/bin/dsh\ndaemon:x:666:666:daemon:/:/sbin/nologin\n",
      ),
    }),
    home: dir("home", {
      guest: dir("guest", {
        Documents: dir("Documents", {
          "readme.txt": file("readme.txt", readme),
          "notes.txt": file("notes.txt", notes),
          "credits.txt": file("credits.txt", credits),
        }),
        Downloads: dir("Downloads", {}),
        /* music ships empty since previews took over playback — drop your
           own audio in (or stream urls in the previews app) */
        Music: dir("Music", {}),
        Pictures: dir("Pictures", {}),
        Paintings: dir("Paintings", {
          "welcome.txt": file("welcome.txt", "paint draws here — saved canvases land in this folder as real pngs.\n"),
        }),
        notes: dir("notes", {}),
        /* the dock's trash — deleted files land here */
        ".Trash": dir(".Trash", {}),
      }),
    }),
    var: dir("var", {
      log: dir("log", {
        "daemon.log": file(
          "daemon.log",
          "[0.000] vfs mounted (indexeddb)\n[0.112] scramjet armed\n[0.340] relay transport handshake ok\n",
        ),
      }),
    }),
  });
}

/* ---------- IndexedDB plumbing ---------- */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, DB_VERSION);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error ?? new Error("idb open failed"));
    rq.onblocked = () => reject(new Error("idb blocked"));
  });
}

function idbGet<T>(db: IDBDatabase, store: string, key: string | IDBKeyRange): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const rq = db.transaction(store, "readonly").objectStore(store).get(key);
    rq.onsuccess = () => resolve(rq.result as T | undefined);
    rq.onerror = () => reject(rq.error ?? new Error("idb get failed"));
  });
}

function idbPut(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const rq = db.transaction(store, "readwrite").objectStore(store).put(value, key);
    rq.onsuccess = () => resolve();
    rq.onerror = () => reject(rq.error ?? new Error("idb put failed"));
  });
}

function idbDelete(db: IDBDatabase, store: string, key: string | IDBKeyRange): Promise<void> {
  return new Promise((resolve, reject) => {
    const rq = db.transaction(store, "readwrite").objectStore(store).delete(key);
    rq.onsuccess = () => resolve();
    rq.onerror = () => reject(rq.error ?? new Error("idb delete failed"));
  });
}

function idbClear(db: IDBDatabase, store: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const rq = db.transaction(store, "readwrite").objectStore(store).clear();
    rq.onsuccess = () => resolve();
    rq.onerror = () => reject(rq.error ?? new Error("idb clear failed"));
  });
}

function idbKeys(db: IDBDatabase, store: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const rq = db.transaction(store, "readonly").objectStore(store).getAllKeys();
    rq.onsuccess = () => resolve((rq.result as unknown[]).map(String));
    rq.onerror = () => reject(rq.error ?? new Error("idb keys failed"));
  });
}

/** dataURL -> Blob (legacy paint saves arrive as base64 text). */
async function dataUrlToBlob(dataUrl: string): Promise<Blob | null> {
  try {
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch {
    return null;
  }
}

/** Validate a parsed legacy tree shape. */
function isTree(v: unknown): v is FsDir {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as FsDir).type === "dir" &&
    typeof (v as FsDir).children === "object"
  );
}

export class VFS {
  static readonly HOME = "/home/guest";
  /** Instance-level alias required by the VFSApi contract. */
  readonly HOME = VFS.HOME;
  private root: FsDir;
  private db: IDBDatabase | null = null;
  private saveQueued = false;
  private listeners = new Set<() => void>();

  constructor(root?: FsDir) {
    this.root = root ?? seedTree();
  }

  /**
   * Boot: open IDB, restore the tree (or migrate the localStorage one),
   * decode any legacy base64 paint files into blobs. Resolves once the
   * in-memory tree is final — the shell waits for this before rendering.
   */
  async hydrate(): Promise<void> {
    if (typeof indexedDB === "undefined") return; // SSR safety — never rendered
    try {
      this.db = await openDb();
    } catch {
      return; // private mode etc — memory-only session
    }
    try {
      const stored = await idbGet<FsDir>(this.db, STORE_META, TREE_KEY);
      if (isTree(stored)) {
        this.root = stored;
        /* migration: ~/.Trash must exist for the dock's trash (older trees
           predate it) — create it in place, persist, done */
        const home = this.getNode(VFS.HOME);
        if (home?.type === "dir" && !home.children[".Trash"]) {
          home.children[".Trash"] = dir(".Trash", {});
          await this.persistNow();
        }
        return;
      }
    } catch {
      /* fall through to migration */
    }
    // first boot on the IDB backend: import the localStorage tree if present
    try {
      const raw = localStorage.getItem(LS.vfs);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (isTree(parsed)) {
          this.root = parsed;
          // legacy paint dataURLs -> real blobs in the blob store
          const paintDir = this.getNode("/home/guest/paintings") ?? this.getNode("/home/guest/Paintings");
          if (paintDir && paintDir.type === "dir") {
            for (const child of Object.values(paintDir.children)) {
              if (child.type === "file" && child.content.startsWith("data:image")) {
                const blob = await dataUrlToBlob(child.content);
                if (blob && this.db) await idbPut(this.db, STORE_BLOBS, this.absOf(child), blob);
              }
            }
          }
          localStorage.removeItem(LS.vfs);
        }
      }
    } catch {
      /* corrupted store -> fresh seed */
    }
    this.pruneLegacyMusic();
    await this.persistNow();
  }

  /** one-time cleanup: the seeded chiptune .mods left with the old music app.
      idempotent — anything the user added with these exact names also goes,
      per the explicit "make that section empty" call. */
  private pruneLegacyMusic(): void {
    const legacy = ["bootloader.mod", "phreaker.mod", "midnight_waves.mod", "dialup_dreams.mod", "kernel_panik.mod"];
    const music = this.getNode("/home/guest/Music");
    if (!music || music.type !== "dir") return;
    let removed = false;
    for (const name of legacy) {
      if (music.children[name]) {
        delete music.children[name];
        removed = true;
      }
    }
    if (removed) music.mtime = Date.now();
  }

  /** The absolute path of a node found anywhere in the tree (legacy migration). */
  private absOf(node: FsNode, from: FsDir = this.root, prefix = ""): string {
    for (const [name, child] of Object.entries(from.children)) {
      const p = prefix + "/" + name;
      if (child === node) return p;
      if (child.type === "dir") {
        const deep = this.absOf(node, child, p);
        if (deep !== "?") return deep;
      }
    }
    return "?";
  }

  /* ---------- persistence ---------- */

  /** Coalesce bursts of mutations into one write a tick later. */
  private persist(): void {
    if (this.saveQueued || !this.db) return;
    this.saveQueued = true;
    queueMicrotask(() => {
      this.saveQueued = false;
      void this.persistNow();
    });
  }

  private async persistNow(): Promise<void> {
    if (!this.db) return;
    try {
      await idbPut(this.db, STORE_META, TREE_KEY, this.root);
    } catch {
      /* quota / private mode — memory-only */
    }
  }

  reset(): void {
    this.root = seedTree();
    if (this.db) {
      void idbClear(this.db, STORE_BLOBS).catch(() => undefined);
      this.persist();
    }
    this.emit();
  }

  /* ---------- change notifications (file manager <-> terminal sync) ---------- */

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* a dead listener must not kill the rest */
      }
    }
    try {
      // cross-pane sync in the same tab (terminal status bar, file manager)
      window.dispatchEvent(new CustomEvent("murke-vfs-change"));
    } catch {
      /* ignore */
    }
  }

  /* ---------- path helpers (synchronous, same API as before) ---------- */

  /** Normalize a user-supplied path against cwd. Returns absolute path. */
  resolve(path: string, cwd: string = VFS.HOME): string {
    let p = (path ?? "").trim();
    if (p === "" || p === "~") return VFS.HOME;
    if (p.startsWith("~/")) p = VFS.HOME + p.slice(1);
    if (!p.startsWith("/")) p = (cwd === "/" ? "" : cwd) + "/" + p;
    const out: string[] = [];
    for (const part of p.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return "/" + out.join("/");
  }

  pretty(abs: string): string {
    if (abs === VFS.HOME) return "~";
    if (abs.startsWith(VFS.HOME + "/")) return "~" + abs.slice(VFS.HOME.length);
    return abs;
  }

  getNode(path: string, cwd: string = VFS.HOME): FsNode | null {
    const abs = this.resolve(path, cwd);
    if (abs === "/") return this.root;
    let node: FsNode = this.root;
    for (const part of abs.split("/").filter(Boolean)) {
      if (node.type !== "dir") return null;
      const next: FsNode | undefined = node.children[part];
      if (!next) return null;
      node = next;
    }
    return node;
  }

  list(path: string, cwd: string = VFS.HOME): FsNode[] {
    const node = this.getNode(path, cwd);
    if (!node || node.type !== "dir") return [];
    return Object.values(node.children).sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  private parentOf(abs: string): { parent: FsDir | null; name: string } {
    const parts = abs.split("/").filter(Boolean);
    const name = parts.pop() ?? "";
    let node: FsNode = this.root;
    for (const part of parts) {
      if (node.type !== "dir") return { parent: null, name };
      const next = node.children[part];
      if (!next) return { parent: null, name };
      node = next;
    }
    return { parent: node.type === "dir" ? node : null, name };
  }

  /** True when a path already exists — used to dedupe upload/download names. */
  exists(path: string, cwd: string = VFS.HOME): boolean {
    return this.getNode(path, cwd) !== null;
  }

  /** `file (2).txt`, `file (3).txt` … first free sibling name. */
  uniqueName(dirPath: string, desired: string, cwd: string = VFS.HOME): string {
    const node = this.getNode(dirPath, cwd);
    if (!node || node.type !== "dir") return desired;
    if (!node.children[desired]) return desired;
    const dot = desired.lastIndexOf(".");
    const base = dot > 0 ? desired.slice(0, dot) : desired;
    const ext = dot > 0 ? desired.slice(dot) : "";
    for (let i = 2; i < 1000; i++) {
      const cand = `${base} (${i})${ext}`;
      if (!node.children[cand]) return cand;
    }
    return `${base}-${Date.now()}${ext}`;
  }

  /* ---------- mutations ---------- */

  mkdir(path: string, cwd: string = VFS.HOME, recursive = false): string | null {
    const abs = this.resolve(path, cwd);
    if (abs === "/") return "mkdir: '/' already exists";
    if (this.getNode(abs)) return `mkdir: cannot create '${path}': File exists`;

    const parts = abs.split("/").filter(Boolean);
    let node: FsDir = this.root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const existing = node.children[part];
      if (existing) {
        if (existing.type !== "dir") return `mkdir: cannot create '${path}': Not a directory`;
        if (i === parts.length - 1) return `mkdir: cannot create '${path}': File exists`;
        node = existing;
      } else {
        if (i < parts.length - 1 && !recursive) return `mkdir: cannot create '${path}': No such file or directory`;
        const nd = dir(part);
        node.children[part] = nd;
        node = nd;
      }
    }
    node.mtime = Date.now();
    this.persist();
    this.emit();
    return null;
  }

  writeFile(path: string, content: string, cwd: string = VFS.HOME): string | null {
    const abs = this.resolve(path, cwd);
    const { parent, name } = this.parentOf(abs);
    if (!parent) return `write: cannot write '${path}': No such file or directory`;
    if (name === "") return "write: invalid file name";
    const existing = parent.children[name];
    if (existing && existing.type === "dir") return `write: '${path}' is a directory`;
    if (existing && existing.type === "file") {
      existing.content = content;
      existing.mtime = Date.now();
    } else {
      parent.children[name] = file(name, content);
    }
    parent.mtime = Date.now();
    this.persist();
    this.emit();
    return null;
  }

  readFile(path: string, cwd: string = VFS.HOME): string | null {
    const node = this.getNode(path, cwd);
    if (!node) return null;
    if (node.type === "dir") return null;
    return node.content;
  }

  remove(path: string, cwd: string = VFS.HOME, recursive = false): string | null {
    const abs = this.resolve(path, cwd);
    if (abs === "/") return "rm: refusing to remove '/'";
    if (abs === VFS.HOME) return "rm: refusing to remove home directory";
    const node = this.getNode(abs);
    if (!node) return `rm: cannot remove '${path}': No such file or directory`;
    if (node.type === "dir" && Object.keys(node.children).length > 0 && !recursive) {
      return `rm: cannot remove '${path}': Is a directory (use rm -r)`;
    }
    const { parent, name } = this.parentOf(abs);
    if (!parent) return `rm: cannot remove '${path}'`;
    delete parent.children[name];
    parent.mtime = Date.now();
    if (this.db) void idbDelete(this.db, STORE_BLOBS, abs).catch(() => undefined);
    this.persist();
    this.emit();
    return null;
  }

  /**
   * Rename/move a node (text + blob side effects handled). Returns an error
   * string or null. Used by the file manager's rename, drag-move and
   * duplicate actions.
   */
  move(from: string, to: string, cwd: string = VFS.HOME): string | null {
    const absFrom = this.resolve(from, cwd);
    const absTo = this.resolve(to, cwd);
    if (absFrom === "/" || absFrom === VFS.HOME) return "mv: refusing to move that";
    if (absTo === "/") return "mv: invalid destination";
    if (absTo.startsWith(absFrom + "/")) return "mv: cannot move a directory into itself";
    if (absFrom === absTo) return null;
    const node = this.getNode(absFrom);
    if (!node) return `mv: cannot find '${from}'`;
    const fromParent = this.parentOf(absFrom);
    if (!fromParent.parent) return `mv: cannot find '${from}'`;
    const { parent: toParent, name: toName } = this.parentOf(absTo);
    if (!toParent) return `mv: destination '${to}' does not exist`;
    if (toParent.children[toName]) return `mv: '${to}' already exists`;
    delete fromParent.parent.children[fromParent.name];
    node.name = toName;
    node.mtime = Date.now();
    toParent.children[toName] = node;
    fromParent.parent.mtime = Date.now();
    toParent.mtime = Date.now();
    if (this.db) {
      // move the blob (if any) alongside — fire and forget
      void idbGet<Blob>(this.db, STORE_BLOBS, absFrom)
        .then((blob) => {
          if (!blob || !this.db) return;
          return idbPut(this.db, STORE_BLOBS, absTo, blob).then(() =>
            idbDelete(this.db!, STORE_BLOBS, absFrom),
          );
        })
        .catch(() => undefined);
    }
    this.persist();
    this.emit();
    return null;
  }

  /* ---------- binary side (async — real Blobs in IndexedDB) ---------- */

  /** Store binary content as a file. Replaces any existing file at the path. */
  async writeFileBlob(path: string, blob: Blob, cwd: string = VFS.HOME): Promise<string | null> {
    const abs = this.resolve(path, cwd);
    const { parent, name } = this.parentOf(abs);
    if (!parent) return `write: cannot write '${path}': No such directory`;
    if (!name) return "write: invalid file name";
    const existing = parent.children[name];
    if (existing && existing.type === "dir") return `write: '${path}' is a directory`;
    const f: FsFile = {
      type: "file",
      name,
      content: "",
      mtime: Date.now(),
      ...(blob.type ? { mime: blob.type } : {}),
      ...(blob.size ? { size: blob.size } : {}),
    };
    parent.children[name] = f;
    parent.mtime = Date.now();
    if (this.db) {
      try {
        await idbPut(this.db, STORE_BLOBS, abs, blob);
      } catch {
        return `write: could not store '${path}' (storage full?)`;
      }
    }
    this.persist();
    this.emit();
    return null;
  }

  /** Read the binary payload of a file (null when none — text-only file). */
  async readFileBlob(path: string, cwd: string = VFS.HOME): Promise<Blob | null> {
    if (!this.db) return null;
    const abs = this.resolve(path, cwd);
    try {
      return (await idbGet<Blob>(this.db, STORE_BLOBS, abs)) ?? null;
    } catch {
      return null;
    }
  }

  /** Every path that carries a blob (used by wipe / stats). */
  async blobPaths(): Promise<string[]> {
    if (!this.db) return [];
    try {
      return await idbKeys(this.db, STORE_BLOBS);
    } catch {
      return [];
    }
  }

  /** Approximate stored size across text + blobs (for the status bar). */
  async usedBytes(): Promise<number> {
    let total = 0;
    const walk = (d: FsDir): void => {
      for (const child of Object.values(d.children)) {
        if (child.type === "dir") walk(child);
        else total += child.size ?? new Blob([child.content]).size;
      }
    };
    walk(this.root);
    try {
      if (navigator?.storage?.estimate) {
        const est = await navigator.storage.estimate();
        if (typeof est.usage === "number" && est.usage > 0) return est.usage;
      }
    } catch {
      /* ignore */
    }
    return total;
  }
}

/* ---------- shared instance (terminal, files app, paint saves) ---------- */

let sharedVfs: VFS | null = null;
let hydratePromise: Promise<VFS> | null = null;

/**
 * Process-wide VFS so every window edits the same file system. Sync access
 * for the terminal — returns the (seeded) instance immediately; `ensureVfs`
 * should be awaited once by the shell before the UI renders so the restored
 * tree is what everyone sees.
 */
export function getVfs(): VFS {
  if (!sharedVfs) sharedVfs = new VFS();
  return sharedVfs;
}

/** Hydrate the shared VFS from IndexedDB exactly once. */
export function ensureVfs(): Promise<VFS> {
  const vfs = getVfs();
  if (!hydratePromise) {
    hydratePromise = (async () => {
      try {
        await vfs.hydrate();
      } catch {
        /* memory-only session */
      }
      return vfs;
    })();
  }
  return hydratePromise;
}
