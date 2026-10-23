/**
 * murke chat accounts — the persistent layer behind the account chat:
 * usernames + scrypt-hashed passwords, session tokens, group chats and
 * per-GC message logs, ALL stored as JSON files through chat-file-store
 * (GitHub contents API on imongithublolo/scraped, local sqlite KV mirror
 * when GITHUB_TOKEN is absent). No plaintext password ever leaves this
 * module; only `salt`/`hash` end up in accounts.json.
 *
 * Concurrency: every mutation is a read-modify-write under a per-file
 * mutex (`storeLock`) — GET first (the sha is required for updates on
 * GitHub), mutate, PUT; on a 409/stale-sha conflict the whole RMW is
 * retried ONCE with a fresh GET before giving up.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { StoreConflict, storeLock, storeRead, storeWrite } from "./chat-file-store";

const ACCOUNTS_FILE = "accounts.json";
const MESSAGES_FILE = "messages.json";

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days
const MSG_CAP = 200; // last 200 messages kept per GC
const MAX_GCS = 30;
const MAX_TEXT = 500;
const SCRYPT_KEYLEN = 64;

/* ---------- persisted shapes ---------- */

export interface StoredUser {
  u: string; // username, lowercase, the id
  d: string; // display name as typed
  s: string; // scrypt salt (hex)
  h: string; // scrypt hash (hex)
  c: number; // created ts
}

export interface StoredToken {
  u: string; // username
  e: number; // expiry ts
}

export interface StoredGc {
  id: string; // gc_<8 hex>
  n: string; // display name
  by: string; // creator username
  c: number; // created ts
  members: string[]; // usernames (lowercase), creator first
}

export interface AccountsFile {
  users: StoredUser[];
  tokens: Record<string, StoredToken>; // token hex -> { u, e }
  gcs: StoredGc[];
}

export interface StoredMsg {
  id: string;
  from: string; // username
  name: string; // display name at send time
  text: string;
  ts: number;
}

export interface MessagesFile {
  rooms: Record<string, StoredMsg[]>;
}

const EMPTY_ACCOUNTS: AccountsFile = { users: [], tokens: {}, gcs: [] };

/* ---------- sanitize ---------- */

export function normalizeUsername(raw: unknown): string | null {
  const name = String(typeof raw === "string" ? raw : "")
    .toLowerCase()
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  return /^[a-z0-9_-]{3,16}$/.test(name) ? name : null;
}

function sanitizeDisplay(raw: unknown, fallback: string): string {
  const d = String(typeof raw === "string" ? raw : "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16)
    .trim();
  return d.length > 0 ? d : fallback;
}

export function sanitizeGcName(raw: unknown): string {
  return String(typeof raw === "string" ? raw : "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24)
    .trim();
}

/* ---------- passwords (scrypt, node:crypto only) ---------- */

function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return { salt, hash };
}

function verifyPassword(password: string, salt: string, hash: string): boolean {
  try {
    const test = scryptSync(password, salt, SCRYPT_KEYLEN);
    const ref = Buffer.from(hash, "hex");
    return ref.length === test.length && timingSafeEqual(ref, test);
  } catch {
    return false;
  }
}

/* ---------- shape guards (files on disk may be anything) ---------- */

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asUser(v: unknown): StoredUser | null {
  if (!isPlainObj(v)) return null;
  if (typeof v.u !== "string" || typeof v.s !== "string" || typeof v.h !== "string") return null;
  return {
    u: v.u,
    d: sanitizeDisplay(v.d, v.u),
    s: v.s,
    h: v.h,
    c: typeof v.c === "number" ? v.c : 0,
  };
}

function asGc(v: unknown): StoredGc | null {
  if (!isPlainObj(v)) return null;
  if (typeof v.id !== "string" || typeof v.n !== "string" || typeof v.by !== "string") return null;
  return {
    id: v.id,
    n: v.n,
    by: v.by,
    c: typeof v.c === "number" ? v.c : 0,
    members: Array.isArray(v.members) ? v.members.filter((m): m is string => typeof m === "string") : [],
  };
}

function asAccounts(data: unknown): AccountsFile {
  if (!isPlainObj(data)) return { ...EMPTY_ACCOUNTS };
  const tokens: Record<string, StoredToken> = {};
  if (isPlainObj(data.tokens)) {
    for (const [tok, v] of Object.entries(data.tokens)) {
      if (!isPlainObj(v)) continue;
      if (typeof v.u !== "string" || typeof v.e !== "number") continue;
      tokens[tok] = { u: v.u, e: v.e };
    }
  }
  return {
    users: Array.isArray(data.users)
      ? data.users.map(asUser).filter((u): u is StoredUser => u !== null)
      : [],
    tokens,
    gcs: Array.isArray(data.gcs) ? data.gcs.map(asGc).filter((g): g is StoredGc => g !== null) : [],
  };
}

function asMessages(data: unknown): MessagesFile {
  const rooms: Record<string, StoredMsg[]> = {};
  if (isPlainObj(data) && isPlainObj(data.rooms)) {
    for (const [id, list] of Object.entries(data.rooms)) {
      if (!Array.isArray(list)) continue;
      rooms[id] = list
        .map((m): StoredMsg | null => {
          if (!isPlainObj(m)) return null;
          if (typeof m.id !== "string" || typeof m.from !== "string" || typeof m.text !== "string") return null;
          return {
            id: m.id,
            from: m.from,
            name: sanitizeDisplay(m.name, m.from),
            text: m.text,
            ts: typeof m.ts === "number" ? m.ts : 0,
          };
        })
        .filter((m): m is StoredMsg => m !== null);
    }
  }
  return { rooms };
}

/* ---------- read-modify-write core (mutex + GET-first + one conflict retry) ---------- */

/** rmw: mutex per file -> read (sha) -> mutate -> write; 409 retries once with a fresh GET. */
async function rmw<TFile, TOut>(
  file: string,
  parse: (data: unknown) => TFile,
  message: string,
  mutate: (cur: TFile) => { next: TFile; dirty: boolean; out: TOut },
): Promise<TOut> {
  return storeLock(file, async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { data, sha } = await storeRead(file);
      const cur = parse(data);
      const res = mutate(cur);
      if (res.dirty) {
        try {
          await storeWrite(file, res.next, sha, message);
        } catch (err) {
          if (err instanceof StoreConflict && attempt === 0) continue; // lost a race — fresh GET, try again
          throw err;
        }
      }
      return res.out;
    }
    throw new StoreConflict();
  });
}

/** prune expired tokens in place; returns true when something changed. */
function pruneTokens(f: AccountsFile, now: number): boolean {
  let dirty = false;
  for (const [tok, t] of Object.entries(f.tokens)) {
    if (t.e <= now) {
      delete f.tokens[tok];
      dirty = true;
    }
  }
  return dirty;
}

/* ---------- public ops ---------- */

export type AuthOk = { ok: true; token: string; username: string; display: string };
export type AuthFail = { ok: false; error: string };

export async function registerUser(rawName: unknown, rawDisplay: unknown, password: unknown): Promise<AuthOk | AuthFail> {
  const username = normalizeUsername(rawName);
  if (!username) return { ok: false, error: "name must be 3-16 chars: a-z 0-9 _ -" };
  const pw = typeof password === "string" ? password : "";
  if (pw.length < 4 || pw.length > 128) return { ok: false, error: "password must be 4-128 chars" };
  const display = sanitizeDisplay(rawDisplay, username);
  const { salt, hash } = hashPassword(pw);

  return rmw<AccountsFile, AuthOk | AuthFail>(
    ACCOUNTS_FILE,
    asAccounts,
    `murke-chat: register ${username}`,
    (f) => {
      if (f.users.some((u) => u.u === username)) {
        return { next: f, dirty: false, out: { ok: false as const, error: "name is taken" } };
      }
      const user: StoredUser = { u: username, d: display, s: salt, h: hash, c: Date.now() };
      const next: AccountsFile = { users: [...f.users, user], tokens: { ...f.tokens }, gcs: f.gcs };
      pruneTokens(next, Date.now());
      const token = issueToken(next, username);
      return {
        next,
        dirty: true,
        out: { ok: true as const, token, username, display },
      };
    },
  );
}

export async function loginUser(rawName: unknown, password: unknown): Promise<AuthOk | AuthFail> {
  const username = normalizeUsername(rawName);
  const pw = typeof password === "string" ? password : "";
  if (!username || !pw) return { ok: false, error: "wrong name or password" };

  return rmw<AccountsFile, AuthOk | AuthFail>(
    ACCOUNTS_FILE,
    asAccounts,
    `murke-chat: login ${username}`,
    (f) => {
      const user = f.users.find((u) => u.u === username);
      if (!user || !verifyPassword(pw, user.s, user.h)) {
        return { next: f, dirty: false, out: { ok: false as const, error: "wrong name or password" } };
      }
      pruneTokens(f, Date.now());
      const token = issueToken(f, username);
      return { next: f, dirty: true, out: { ok: true as const, token, username, display: user.d } };
    },
  );
}

export async function logoutUser(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || !token) return false;
  return rmw(
    ACCOUNTS_FILE,
    asAccounts,
    "murke-chat: logout",
    (f) => {
      if (!(token in f.tokens)) return { next: f, dirty: false, out: false }; // unknown token — nothing to do
      delete f.tokens[token];
      return { next: f, dirty: true, out: true };
    },
  );
}

/** token -> username, or null. Read-only; expiry enforced here. */
export async function userForToken(token: unknown): Promise<string | null> {
  if (typeof token !== "string" || token.length < 16) return null;
  const { data } = await storeRead(ACCOUNTS_FILE);
  const f = asAccounts(data);
  const t = f.tokens[token];
  if (!t || t.e <= Date.now()) return null;
  return t.u;
}

export async function displayFor(username: string): Promise<string> {
  const { data } = await storeRead(ACCOUNTS_FILE);
  const f = asAccounts(data);
  return f.users.find((u) => u.u === username)?.d ?? username;
}

function issueToken(f: AccountsFile, username: string): string {
  const token = randomBytes(32).toString("hex");
  f.tokens[token] = { u: username, e: Date.now() + TOKEN_TTL_MS };
  return token;
}

/* ---------- GCs ---------- */

export interface GcInfo {
  id: string;
  name: string;
  creator: string;
  created: number;
  count: number;
  joined: boolean;
}

export type GcOk = { ok: true; room: { id: string; name: string } };
export type GcFail = { ok: false; error: string };

export async function createGc(username: string, rawName: unknown): Promise<GcOk | GcFail> {
  const name = sanitizeGcName(rawName);
  if (!name) return { ok: false, error: "name it something" };
  return rmw<AccountsFile, GcOk | GcFail>(
    ACCOUNTS_FILE,
    asAccounts,
    `murke-chat: open #${name}`,
    (f) => {
      if (f.gcs.some((g) => g.n.toLowerCase() === name.toLowerCase())) {
        return { next: f, dirty: false, out: { ok: false as const, error: "that name already exists" } };
      }
      if (f.gcs.length >= MAX_GCS) {
        return { next: f, dirty: false, out: { ok: false as const, error: "too many groups — bury one first" } };
      }
      const gc: StoredGc = {
        id: `gc_${randomBytes(4).toString("hex")}`,
        n: name,
        by: username,
        c: Date.now(),
        members: [username],
      };
      const next: AccountsFile = { users: f.users, tokens: f.tokens, gcs: [...f.gcs, gc] };
      return { next, dirty: true, out: { ok: true as const, room: { id: gc.id, name: gc.n } } };
    },
  );
}

export async function joinGc(username: string, rawName: unknown): Promise<GcOk | GcFail> {
  const name = sanitizeGcName(rawName);
  if (!name) return { ok: false, error: "join what?" };
  return rmw<AccountsFile, GcOk | GcFail>(
    ACCOUNTS_FILE,
    asAccounts,
    `murke-chat: join #${name}`,
    (f) => {
      const gc = f.gcs.find((g) => g.n.toLowerCase() === name.toLowerCase());
      if (!gc) return { next: f, dirty: false, out: { ok: false as const, error: "no such room" } };
      if (gc.members.includes(username)) {
        return { next: f, dirty: false, out: { ok: true as const, room: { id: gc.id, name: gc.n } } };
      }
      gc.members.push(username);
      return { next: f, dirty: true, out: { ok: true as const, room: { id: gc.id, name: gc.n } } };
    },
  );
}

/** join by room id (used when clicking a listed room you are not in yet). */
export async function joinGcById(username: string, roomId: string): Promise<GcOk | GcFail> {
  return rmw<AccountsFile, GcOk | GcFail>(
    ACCOUNTS_FILE,
    asAccounts,
    "murke-chat: join room",
    (f) => {
      const gc = f.gcs.find((g) => g.id === roomId);
      if (!gc) return { next: f, dirty: false, out: { ok: false as const, error: "no such room" } };
      if (gc.members.includes(username)) {
        return { next: f, dirty: false, out: { ok: true as const, room: { id: gc.id, name: gc.n } } };
      }
      gc.members.push(username);
      return { next: f, dirty: true, out: { ok: true as const, room: { id: gc.id, name: gc.n } } };
    },
  );
}

export async function listGcs(username: string): Promise<GcInfo[]> {
  const { data } = await storeRead(ACCOUNTS_FILE);
  const f = asAccounts(data);
  return f.gcs.map((g) => ({
    id: g.id,
    name: g.n,
    creator: g.by,
    created: g.c,
    count: g.members.length,
    joined: g.members.includes(username),
  }));
}

export async function gcExists(roomId: string): Promise<boolean> {
  const { data } = await storeRead(ACCOUNTS_FILE);
  return asAccounts(data).gcs.some((g) => g.id === roomId);
}

/* ---------- messages ---------- */

export async function listMessages(roomId: string, since?: number): Promise<StoredMsg[]> {
  const { data } = await storeRead(MESSAGES_FILE);
  const f = asMessages(data);
  const list = f.rooms[roomId] ?? [];
  if (typeof since === "number" && Number.isFinite(since)) {
    return list.filter((m) => m.ts > since);
  }
  return list;
}

export async function postMessage(
  username: string,
  display: string,
  roomId: string,
  rawText: unknown,
): Promise<{ ok: true; message: StoredMsg } | { ok: false; error: string }> {
  const text = String(typeof rawText === "string" ? rawText : "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, MAX_TEXT)
    .trim();
  if (!text) return { ok: false, error: "say something" };

  // room check + auto-join live in accounts.json; the message itself in messages.json
  const joined = await joinGcById(username, roomId);
  if (joined.ok !== true) return { ok: false, error: joined.error };

  const message: StoredMsg = {
    id: `m_${randomBytes(6).toString("hex")}`,
    from: username,
    name: display,
    text,
    ts: Date.now(),
  };
  await rmw<MessagesFile, { ok: true; message: StoredMsg }>(
    MESSAGES_FILE,
    asMessages,
    `murke-chat: msg in ${roomId}`,
    (f) => {
      const list = f.rooms[roomId] ?? [];
      const grown = [...list, message];
      const next: MessagesFile = {
        rooms: { ...f.rooms, [roomId]: grown.length > MSG_CAP ? grown.slice(grown.length - MSG_CAP) : grown },
      };
      return { next, dirty: true, out: { ok: true as const, message } };
    },
  );
  return { ok: true, message };
}
