/**
 * browser-data — localStorage-backed persistence for the murke browser:
 * navigation history, bookmarks, the tab session and chrome prefs.
 *
 * Every key lives under the daemon.browser.* namespace (the browser owns its
 * data; the OS keeps its own keys in contracts.LS). Every read/write is
 * try/catch wrapped — private mode, quota errors and SSR must never throw.
 *
 * Storage shapes are defensively sanitized on load: a hand-edited or partially
 * corrupted entry degrades to a filtered list instead of crashing chrome.
 */

const K = {
  history: "daemon.browser.history",
  bookmarks: "daemon.browser.bookmarks",
  session: "daemon.browser.session",
  prefs: "daemon.browser.prefs",
} as const;

/** Hard cap on remembered navigations (oldest dropped). */
export const HISTORY_MAX = 500;
/** How many mixed hits searchAll() returns at most. */
export const SEARCH_MAX = 24;

export interface HistoryEntry {
  /** decoded (display) url — portable across hosts, re-navigable via go() */
  url: string;
  /** page <title> when the frame exposed one, else the hostname */
  title: string;
  ts: number;
}

export interface Bookmark {
  url: string;
  label: string;
  ts: number;
}

/** Persisted tab session — urls are display urls; blank tabs say "newtab". */
export interface BrowserSession {
  tabs: string[];
  /** index into tabs of the tab that was active */
  active: number;
  ts: number;
}

export interface BrowserPrefs {
  bookmarksBar: boolean;
}

export interface SearchHit {
  url: string;
  title: string;
  ts: number;
  kind: "bookmark" | "history";
}

/* ---------- raw io (all guarded) ---------- */

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — persistence is best-effort */
  }
}

function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

/* ---------- history ---------- */

function sanitizeHistory(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const e of raw) {
    const h = e as Partial<HistoryEntry>;
    if (typeof h?.url === "string" && h.url && typeof h.title === "string" && typeof h.ts === "number") {
      out.push({ url: h.url, title: h.title.slice(0, 160), ts: h.ts });
    }
  }
  return out.slice(0, HISTORY_MAX);
}

export function loadHistory(): HistoryEntry[] {
  return sanitizeHistory(readJson<unknown>(K.history, []));
}

/** Record a successful navigation. Same-url as the newest entry refreshes it
 *  in place (no duplicate spam while a site redirects through steps). */
export function addHistory(url: string, title: string): void {
  if (!url || !isHttpUrl(url)) return;
  const list = loadHistory();
  const entry: HistoryEntry = { url, title: (title || url).slice(0, 160), ts: Date.now() };
  const idx = list.findIndex((h) => h.url === url);
  if (idx >= 0) list.splice(idx, 1);
  list.unshift(entry);
  writeJson(K.history, list.slice(0, HISTORY_MAX));
}

export function clearHistory(): void {
  writeJson(K.history, []);
}

/* ---------- bookmarks ---------- */

function sanitizeBookmarks(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  const out: Bookmark[] = [];
  for (const e of raw) {
    const b = e as Partial<Bookmark>;
    if (typeof b?.url === "string" && b.url && typeof b.label === "string") {
      out.push({ url: b.url, label: b.label.slice(0, 80) || b.url, ts: typeof b.ts === "number" ? b.ts : 0 });
    }
  }
  return out.slice(0, 200);
}

export function loadBookmarks(): Bookmark[] {
  return sanitizeBookmarks(readJson<unknown>(K.bookmarks, []));
}

/** Newest bookmark first; re-adding a url re-labels and bumps it to the top. */
export function addBookmark(url: string, label: string): void {
  if (!url) return;
  const list = loadBookmarks().filter((b) => b.url !== url);
  list.unshift({ url, label: (label || url).slice(0, 80), ts: Date.now() });
  writeJson(K.bookmarks, list.slice(0, 200));
}

export function removeBookmark(url: string): void {
  writeJson(K.bookmarks, loadBookmarks().filter((b) => b.url !== url));
}

export function isBookmarked(url: string): boolean {
  return loadBookmarks().some((b) => b.url === url);
}

/* ---------- tab session ---------- */

export function loadSession(): BrowserSession | null {
  const s = readJson<Partial<BrowserSession> | null>(K.session, null);
  if (!s || !Array.isArray(s.tabs)) return null;
  const tabs = s.tabs.filter((t): t is string => typeof t === "string").slice(0, 32);
  if (tabs.length === 0) return null;
  const active = typeof s.active === "number" ? Math.min(Math.max(0, Math.round(s.active)), tabs.length - 1) : 0;
  return { tabs, active, ts: typeof s.ts === "number" ? s.ts : 0 };
}

/** Persist the tab list. Blank tabs ("" or the NEWTAB sentinel) store as
 *  "newtab" so a restored tab opens the new-tab page, not a junk url. */
export function saveSession(tabs: string[], active: number): void {
  const clean = tabs
    .filter((t): t is string => typeof t === "string")
    .slice(0, 32)
    .map((t) => (t === "newtab" ? "newtab" : t));
  const clamped = Math.min(Math.max(0, Math.round(active)), Math.max(0, clean.length - 1));
  writeJson(K.session, { tabs: clean, active: clamped, ts: Date.now() });
}

export function clearSession(): void {
  writeJson(K.session, null);
}

/* ---------- chrome prefs ---------- */

export function loadPrefs(): BrowserPrefs {
  const p = readJson<Partial<BrowserPrefs>>(K.prefs, {});
  return { bookmarksBar: p.bookmarksBar === true };
}

export function savePrefs(p: BrowserPrefs): void {
  writeJson(K.prefs, { bookmarksBar: p.bookmarksBar === true });
}

/* ---------- omnibox search ---------- */

function matches(q: string, ...fields: string[]): boolean {
  const needle = q.toLowerCase();
  return fields.some((f) => f.toLowerCase().includes(needle));
}

/**
 * Mixed omnibox search — bookmarks first (they're deliberate), then history,
 * deduped by url with the bookmark's metadata winning. Newest first inside
 * each group. Returns at most SEARCH_MAX hits; the caller trims further.
 */
export function searchAll(query: string): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const b of loadBookmarks()) {
    if (seen.has(b.url)) continue;
    if (matches(q, b.url, b.label)) {
      seen.add(b.url);
      hits.push({ url: b.url, title: b.label, ts: b.ts, kind: "bookmark" });
    }
  }
  for (const h of loadHistory()) {
    if (seen.has(h.url)) continue;
    if (matches(q, h.url, h.title)) {
      seen.add(h.url);
      hits.push({ url: h.url, title: h.title, ts: h.ts, kind: "history" });
    }
  }
  return hits.slice(0, SEARCH_MAX);
}
