/**
 * murke chat file-store — accounts/GCs/messages live in ONE JSON file set
 * ("murke-chat/accounts.json", "murke-chat/messages.json") inside the user's
 * GitHub repo (default imongithublolo/scraped), read/written through the
 * GitHub Contents API. That keeps state alive across serverless cold starts
 * and shared across every instance.
 *
 * When GITHUB_TOKEN is missing (sandbox / revoked token) the exact same JSON
 * blobs are mirrored into the local Prisma SQLite db under a single KV table
 * (model ChatStore) — same contract, same shapes, mode "local". Callers only
 * ever see mode + read/write, never which backend answered.
 *
 * GitHub rules implemented here:
 *  - GET first: the sha returned by GET is REQUIRED for updates (404 → empty
 *    state, first write creates the file without a sha).
 *  - 409 (or a 422 sha mismatch) → conflict: the caller retries once with a
 *    fresh GET (see `mutateFile` in chat-accounts.ts, which is also the only
 *    writer — every read-modify-write runs under a per-file mutex).
 *  - content is base64 both ways.
 */
import { db } from "@/lib/db";

export type StoreMode = "github" | "local";

const REPO = process.env.GITHUB_CHAT_REPO || "imongithublolo/scraped";
const PREFIX = "murke-chat";
const BRANCH = process.env.GITHUB_CHAT_BRANCH || ""; // optional ref override
const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;

/** Which backend is live right now. Token present → real GitHub file. */
export function storeMode(): StoreMode {
  return process.env.GITHUB_TOKEN ? "github" : "local";
}

/** Info for the status ping. */
export function storeInfo(): { mode: StoreMode; repo: string; prefix: string } {
  return { mode: storeMode(), repo: REPO, prefix: PREFIX };
}

export class StoreConflict extends Error {
  constructor() {
    super("store write conflict — sha stale");
    this.name = "StoreConflict";
  }
}

export class StoreFailure extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "StoreFailure";
  }
}

export interface StoredFile {
  /** parsed JSON, or null when the file does not exist (404) */
  data: unknown;
  /** blob sha for updates; null = file absent (create) or local backend */
  sha: string | null;
}

/* ---------- per-file mutex: serialize read-modify-write in this process ---------- */

const locks = new Map<string, Promise<unknown>>();

export function storeLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(file) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

/* ---------- github contents api ---------- */

function ghHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ""}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "murke-os-chat",
    "Content-Type": "application/json",
  };
  if (extra) Object.assign(h, extra);
  return h;
}

function ghUrl(file: string): string {
  const [owner, repo] = REPO.split("/");
  const ref = BRANCH ? `?ref=${encodeURIComponent(BRANCH)}` : "";
  return `${API}/repos/${owner}/${repo}/contents/${PREFIX}/${encodeURIComponent(file)}${ref}`;
}

async function ghRead(file: string): Promise<StoredFile> {
  const res = await fetch(ghUrl(file), {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 404) return { data: null, sha: null }; // file not born yet → empty state
  if (!res.ok) throw new StoreFailure(`github read ${res.status}`);
  const body = (await res.json()) as { content?: string; encoding?: string; sha?: string };
  const raw =
    body.encoding === "base64" && typeof body.content === "string"
      ? Buffer.from(body.content, "base64").toString("utf8")
      : "";
  let data: unknown = null;
  if (raw.trim()) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null; // corrupt file → treat as empty, next write rewrites it clean
    }
  }
  return { data, sha: typeof body.sha === "string" ? body.sha : null };
}

async function ghWrite(file: string, data: unknown, sha: string | null, message: string): Promise<{ sha: string }> {
  const payload: Record<string, unknown> = {
    message,
    content: Buffer.from(JSON.stringify(data), "utf8").toString("base64"),
  };
  if (sha) payload.sha = sha;
  if (BRANCH) payload.branch = BRANCH;
  const res = await fetch(ghUrl(file), {
    method: "PUT",
    headers: ghHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 409 || res.status === 422) throw new StoreConflict(); // stale sha — caller retries with a fresh GET
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new StoreFailure(`github write ${res.status}${text ? `: ${text.slice(0, 140)}` : ""}`);
  }
  const body = (await res.json()) as { content?: { sha?: string } };
  return { sha: typeof body.content?.sha === "string" ? body.content.sha : sha ?? "" };
}

/* ---------- local kv fallback (prisma sqlite, one row per file) ---------- */

async function localRead(file: string): Promise<StoredFile> {
  const row = await db.chatStore.findUnique({ where: { key: `${PREFIX}/${file}` } });
  if (!row) return { data: null, sha: null };
  let data: unknown = null;
  try {
    data = JSON.parse(row.value);
  } catch {
    data = null;
  }
  return { data, sha: null }; // sqlite upsert needs no sha — concurrency handled by the mutex
}

async function localWrite(file: string, data: unknown): Promise<{ sha: string }> {
  const key = `${PREFIX}/${file}`;
  const value = JSON.stringify(data);
  await db.chatStore.upsert({ where: { key }, update: { value }, create: { key, value } });
  return { sha: "local" };
}

/* ---------- public surface ---------- */

export async function storeRead(file: string): Promise<StoredFile> {
  try {
    if (storeMode() === "github") return await ghRead(file);
  } catch (err) {
    if (err instanceof StoreConflict) throw err;
    throw new StoreFailure(err instanceof Error ? err.message : "github read failed");
  }
  return localRead(file);
}

export async function storeWrite(
  file: string,
  data: unknown,
  sha: string | null,
  message: string,
): Promise<{ sha: string }> {
  if (storeMode() === "github") {
    try {
      return await ghWrite(file, data, sha, message);
    } catch (err) {
      if (err instanceof StoreConflict) throw err;
      throw new StoreFailure(err instanceof Error ? err.message : "github write failed");
    }
  }
  return localWrite(file, data);
}
