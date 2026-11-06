/**
 * Session downloads — client side helpers.
 * Media lives in server RAM keyed to a per-browser-session id held in
 * sessionStorage. Page refresh = new sid + empty local list (by design).
 */

export interface DlMeta {
  id: string;
  name: string;
  type: string;
  size: number;
}

const SID_KEY = "murke.dl.sid";

/** Module-level cache populated by downloadToSession(). */
let localList: DlMeta[] = [];

/** Stable id for this browser session (sessionStorage-backed). */
export function getSid(): string {
  if (typeof window === "undefined") return "server";
  try {
    let sid = window.sessionStorage.getItem(SID_KEY);
    if (!sid) {
      sid =
        typeof window.crypto?.randomUUID === "function"
          ? window.crypto.randomUUID()
          : `sid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      window.sessionStorage.setItem(SID_KEY, sid);
    }
    return sid;
  } catch {
    return "ephemeral";
  }
}

/** POSTs the url to /api/dl; throws with the server's error text on failure.
 *  name is optional (yt titles) — the server falls back to the url basename. */
export async function downloadToSession(url: string, name?: string): Promise<DlMeta> {
  const res = await fetch("/api/dl", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, sid: getSid(), ...(name ? { name } : {}) }),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok || typeof data !== "object" || data === null) {
    const errMsg =
      typeof (data as { error?: unknown })?.error === "string" ? (data as { error: string }).error : `download failed (${res.status})`;
    throw new Error(errMsg);
  }
  const o = data as Record<string, unknown>;
  if (o.ok !== true || typeof o.id !== "string" || typeof o.name !== "string" || typeof o.type !== "string" || typeof o.size !== "number") {
    throw new Error("download failed — bad response");
  }
  const meta: DlMeta = { id: o.id, name: o.name, type: o.type, size: o.size };
  localList = localList.filter((m) => m.id !== meta.id);
  localList.push(meta);
  return meta;
}

/** Everything downloaded this page-lifetime (newest last). */
export function listDownloads(): DlMeta[] {
  return [...localList];
}

/** URL that streams the stored bytes (supports range requests for seeking). */
export function streamUrl(id: string): string {
  return `/api/dl?sid=${encodeURIComponent(getSid())}&id=${encodeURIComponent(id)}`;
}

/** Removes the item from the local list; server GCs by TTL (45min). */
export function removeDownload(id: string): void {
  localList = localList.filter((m) => m.id !== id);
}

/** "3.4 MB" style formatting. */
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
