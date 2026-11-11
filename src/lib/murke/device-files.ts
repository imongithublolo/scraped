"use client";

/**
 * device files — the File System Access API side of the file manager.
 * "access your files within the website": connect a real folder from the
 * host machine, browse it, and pull anything (or everything) into the vfs.
 *
 *   connectFolder()  — directory picker (readwrite so we can also delete)
 *   importDeviceFile — copy one file into the vfs (backup, keeps subfolders)
 *   deleteDeviceFile — remove the original from the host (backup+delete)
 *   save/load/clear  — the connection handle persists in idb, so the folder
 *                      survives reloads (re-grant needed per session)
 */

import type { VFS } from "./vfs";

/* ---------- minimal structural types (lib.dom coverage varies) ---------- */

export interface DirHandleLike {
  name: string;
  kind: "directory";
  values(): AsyncIterableIterator<FileHandleLike | DirHandleLike>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  queryPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

interface FileHandleLike {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}

export interface DeviceFile {
  handle: FileHandleLike;
  /** path relative to the connected folder root */
  path: string;
  name: string;
  size: number;
  lastModified: number;
}

export interface DeviceConn {
  name: string;
  dir: DirHandleLike;
  files: DeviceFile[];
  /** true when the walk hit the safety cap */
  truncated: boolean;
}

const CAP = 600;
const DEPTH = 8;

export function fsaSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/* ---------- connect + walk ---------- */

export async function connectFolder(): Promise<DeviceConn> {
  const w = window as unknown as { showDirectoryPicker(o?: { mode?: "readwrite" }): Promise<DirHandleLike> };
  if (!w.showDirectoryPicker) throw new Error("this browser has no file system access api");
  const dir = await w.showDirectoryPicker({ mode: "readwrite" });
  const conn = await walkConn(dir);
  return conn;
}

export async function walkConn(dir: DirHandleLike): Promise<DeviceConn> {
  const files: DeviceFile[] = [];
  let truncated = false;
  const walk = async (d: DirHandleLike, prefix: string, depth: number): Promise<void> => {
    if (files.length >= CAP || depth > DEPTH) {
      truncated = true;
      return;
    }
    for await (const entry of d.values()) {
      if (files.length >= CAP || depth > DEPTH) {
        truncated = true;
        return;
      }
      const p = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "file") {
        try {
          const f = await (entry as FileHandleLike).getFile();
          files.push({ handle: entry as FileHandleLike, path: p, name: entry.name, size: f.size, lastModified: f.lastModified });
        } catch {
          /* unreadable entry — skip it */
        }
      } else if (entry.kind === "directory" && !entry.name.startsWith(".")) {
        await walk(entry as DirHandleLike, p, depth + 1);
      }
    }
  };
  await walk(dir, "", 0);
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return { name: dir.name, dir, files, truncated };
}

/* ---------- permission ---------- */

export async function connPermission(dir: DirHandleLike, mode: "read" | "readwrite", request: boolean): Promise<boolean> {
  try {
    const q = dir.queryPermission ? await dir.queryPermission({ mode }) : "granted";
    if (q === "granted") return true;
    if (!request) return false;
    const r = dir.requestPermission ? await dir.requestPermission({ mode }) : "denied";
    return r === "granted";
  } catch {
    return false;
  }
}

/* ---------- handle persistence (idb) ---------- */

const DB_NAME = "daemon.device";
const STORE = "handles";
const KEY = "root";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => {
      if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE);
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error ?? new Error("idb open failed"));
  });
}

export async function saveConnHandle(dir: DirHandleLike): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(dir as unknown as unknown, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* private mode — connection just won't persist */
  }
}

export async function loadConnHandle(): Promise<DirHandleLike | null> {
  try {
    const db = await openDb();
    const dir = await new Promise<DirHandleLike | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const rq = tx.objectStore(STORE).get(KEY);
      rq.onsuccess = () => resolve(rq.result as DirHandleLike | undefined);
      rq.onerror = () => reject(rq.error);
    });
    db.close();
    return dir ?? null;
  } catch {
    return null;
  }
}

export async function clearConnHandle(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* ignore */
  }
}

/* ---------- import (backup) + delete original ---------- */

/**
 * sanitized subfolder segments for a device-relative path (everything
 * before the file name). "." / ".." / empty segments are dropped, each
 * one is flattened (no separators), trimmed and capped at 80 chars.
 */
export function deviceSubfolders(path: string): string[] {
  const segs: string[] = [];
  for (const raw of path.split("/").slice(0, -1)) {
    if (raw === "." || raw === "..") continue;
    const seg = raw.replace(/[/\\]/g, "_").trim().slice(0, 80);
    if (seg) segs.push(seg);
  }
  return segs;
}

/** copy one device file into the vfs, rebuilding its nested folder
    structure under destDir. returns an error string or null. */
export async function importDeviceFile(f: DeviceFile, vfs: VFS, destDir: string): Promise<string | null> {
  try {
    const file = await f.handle.getFile();
    if (file.size > 512 * 1024 * 1024) return `${f.path}: over the 512mb safety cap`;
    let target = destDir;
    const segs = deviceSubfolders(f.path);
    if (segs.length) {
      target = `${destDir}/${segs.join("/")}`;
      const existing = vfs.getNode(target);
      if (!existing) {
        const merr = vfs.mkdir(target, undefined, true);
        if (merr && !vfs.getNode(target)) return `${f.path}: ${merr}`;
      } else if (existing.type !== "dir") {
        return `${f.path}: a file blocks the folder ${segs.join("/")}`;
      }
    }
    const name = vfs.uniqueName(target, f.name.replace(/[/\\]/g, "_").slice(0, 120) || "file");
    return await vfs.writeFileBlob(`${target}/${name}`, file);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** delete the original on the host (the "backup and remove" flow). */
export async function deleteDeviceFile(conn: DeviceConn, f: DeviceFile): Promise<string | null> {
  try {
    /* root.removeEntry only takes a direct child name, so walk the tree
       by re-acquiring directory handles along the relative path */
    const parts = f.path.split("/");
    let cur: DirHandleLike = conn.dir;
    for (const seg of parts.slice(0, -1)) {
      let found: DirHandleLike | null = null;
      for await (const entry of cur.values()) {
        if (entry.kind === "directory" && entry.name === seg) {
          found = entry as DirHandleLike;
          break;
        }
      }
      if (!found) return `${f.path}: parent folder vanished`;
      cur = found;
    }
    await cur.removeEntry(parts[parts.length - 1]);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/* status strings for the ui */
export function deviceSummary(conn: DeviceConn): string {
  return `${conn.files.length} file${conn.files.length === 1 ? "" : "s"}${conn.truncated ? " (capped)" : ""}`;
}
