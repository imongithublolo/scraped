/**
 * fetch(1) client side — pull any file off the web into the VFS.
 *
 * The bytes never touch this page's origin restrictions: the request goes to
 * our same-origin /api/fetch-file backend (the same clean egress the proxy
 * browser's relay uses), which streams the upstream response straight back.
 * The blob lands in the IndexedDB file system as a real file.
 */

import type { VFS } from "./vfs";

/** Structural subset the fetcher needs — accepts the full VFS or the
 *  command context's VFSApi alike. */
export interface VfsLike {
  mkdir(path: string, cwd?: string, recursive?: boolean): string | null;
  uniqueName(dirPath: string, desired: string, cwd?: string): string;
  writeFileBlob(path: string, blob: Blob, cwd?: string): Promise<string | null>;
}

export interface FetchFileMeta {
  /** final stored path (~/Downloads/name, deduped) */
  path: string;
  name: string;
  size: number;
  mime: string;
}

/** Hard ceiling — keeps a runaway url from exhausting IDB. */
export const FETCH_MAX_BYTES = 256 * 1024 * 1024; // 256 MB

/** "3.4 MB" style formatting (shared with the terminal). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Best-effort filename from a url (basename without query/hash). */
export function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    const cleaned = base.replace(/[\\/:*?"<>|]/g, "_").trim();
    return cleaned.slice(0, 120) || u.hostname.replace(/^www\./, "");
  } catch {
    return "download";
  }
}

/**
 * Stream a url through /api/fetch-file and store it in the VFS.
 * Throws with a human message when the upstream answers non-2xx or the
 * payload exceeds the ceiling.
 */
export async function fetchIntoVfs(
  url: string,
  vfs: VfsLike,
  opts?: { dir?: string; name?: string },
): Promise<FetchFileMeta> {
  const res = await fetch("/api/fetch-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    let msg = `fetch failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) msg = data.error;
    } catch {
      /* non-json error body — keep the status message */
    }
    throw new Error(msg);
  }

  const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > FETCH_MAX_BYTES) {
    throw new Error(`file is ${formatBytes(len)} — over the ${formatBytes(FETCH_MAX_BYTES)} limit`);
  }

  // header-declared name wins, url basename is the fallback
  let serverName = "";
  try {
    const raw = res.headers.get("x-file-name");
    if (raw) serverName = decodeURIComponent(raw);
  } catch {
    /* ignore */
  }
  const name = (opts?.name || serverName || nameFromUrl(url)).replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);

  const blob = await res.blob();
  if (blob.size > FETCH_MAX_BYTES) {
    throw new Error(`file is ${formatBytes(blob.size)} — over the ${formatBytes(FETCH_MAX_BYTES)} limit`);
  }
  if (blob.size === 0) throw new Error("upstream sent an empty file");

  const dir = opts?.dir ?? "~/Downloads";
  vfs.mkdir(dir, undefined, true);
  const finalName = vfs.uniqueName(dir, name);
  const path = `${dir.replace(/\/$/, "")}/${finalName}`;
  const err = await vfs.writeFileBlob(path, blob);
  if (err) throw new Error(err);

  return { path, name: finalName, size: blob.size, mime };
}
