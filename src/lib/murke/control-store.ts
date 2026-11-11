/**
 * murke control channel — the admin's live hand on a user's screen.
 *
 * Everything here is in-memory RIGHT NOW state (globalThis so dev HMR
 * keeps it): cursor position, click queue, notice flash, kick flag and
 * the screen-view request bit. The user's desktop polls GET /api/control
 * (~1s) and reacts; the admin app pushes via POST /api/admin/control.
 */

export interface CtrlCursor {
  /** normalized 0..1 across the user's viewport */
  x: number;
  y: number;
  at: number;
}

export interface CtrlState {
  cursor: CtrlCursor | null;
  /** one-shot click delivery — cleared when the client picks it up */
  click: CtrlCursor | null;
  /** one-shot notice flash */
  notice: { text: string; at: number } | null;
  /** epoch ms of the kick — the client treats a fresh kick as "you're out" */
  kickAt: number | null;
  /** admin is watching this screen — client should capture + ship frames */
  screenWant: boolean;
  screenWantAt: number;
  /** admin → client filesystem operations waiting to be executed */
  fsInbox: FsRequest[];
  /** client's answers, keyed by rid — the admin polls them out */
  fsOut: Map<string, FsResult>;
}

/* ---------- admin fs channel — the admin's hands on their files ---------- */

export type FsOp = "list" | "read" | "write" | "mkdir" | "remove";

export interface FsRequest {
  rid: string;
  op: FsOp;
  path: string;
  /** write only — utf-8 text */
  content?: string;
  at: number;
}

export interface FsResult {
  rid: string;
  ok: boolean;
  /** list → { entries }; read → { content, size, mime } (or { tooBig }) */
  data?: unknown;
  error?: string;
  at: number;
}

const FS_INBOX_MAX = 8;
const FS_OUT_MAX = 24;
const FS_REQ_TTL_MS = 45_000;
const FS_RES_TTL_MS = 3 * 60_000;

function newRid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** queue an fs op for the client — returns the rid the admin polls for */
export function queueFsOp(id: string, op: FsOp, path: string, content?: string): string {
  const st = entry(id);
  if (st.fsInbox.length >= FS_INBOX_MAX) st.fsInbox.shift();
  const rid = newRid();
  st.fsInbox.push({ rid, op, path: path.slice(0, 1024), content, at: Date.now() });
  return rid;
}

/** the client takes (and removes) the oldest live op on its 1s poll */
export function takeFsOp(id: string): FsRequest | null {
  const st = CTRL.get(id);
  if (!st) return null;
  const now = Date.now();
  while (st.fsInbox.length > 0) {
    const req = st.fsInbox.shift() as FsRequest;
    if (now - req.at <= FS_REQ_TTL_MS) return req;
  }
  return null;
}

/** the client posts a result back */
export function pushFsRes(id: string, res: FsResult): void {
  const st = entry(id);
  if (st.fsOut.size >= FS_OUT_MAX) {
    const oldest = st.fsOut.keys().next().value;
    if (oldest) st.fsOut.delete(oldest);
  }
  st.fsOut.set(res.rid, { ...res, at: Date.now() });
}

/** the admin collects a result by rid */
export function getFsRes(id: string, rid: string): FsResult | null {
  return CTRL.get(id)?.fsOut.get(rid) ?? null;
}

const g = globalThis as typeof globalThis & { __murkeControl?: Map<string, CtrlState> };
const CTRL: Map<string, CtrlState> = (g.__murkeControl ??= new Map());

const KICK_TTL_MS = 60_000; // a kick stays "fresh" this long for the client
const CURSOR_TTL_MS = 6_000; // stale cursor fades off their screen
const STALE_TTL_MS = 5 * 60_000; // idle control entries get reaped

function entry(id: string): CtrlState {
  let st = CTRL.get(id);
  if (!st) {
    st = { cursor: null, click: null, notice: null, kickAt: null, screenWant: false, screenWantAt: 0, fsInbox: [], fsOut: new Map() };
    CTRL.set(id, st);
  }
  return st;
}

function reap(): void {
  const now = Date.now();
  for (const [k, st] of CTRL) {
    if (st.fsInbox.length && st.fsInbox.some((r) => now - r.at > FS_REQ_TTL_MS)) {
      st.fsInbox = st.fsInbox.filter((r) => now - r.at <= FS_REQ_TTL_MS);
    }
    for (const [rid, res] of st.fsOut) if (now - res.at > FS_RES_TTL_MS) st.fsOut.delete(rid);
    const newest = Math.max(
      st.cursor?.at ?? 0,
      st.click?.at ?? 0,
      st.notice?.at ?? 0,
      st.kickAt ?? 0,
      st.screenWantAt,
      st.fsInbox[st.fsInbox.length - 1]?.at ?? 0,
      st.fsOut.size ? Math.max(...[...st.fsOut.values()].map((r) => r.at)) : 0,
    );
    if (now - newest > STALE_TTL_MS) CTRL.delete(k);
  }
}

export function getControl(id: string): CtrlState {
  return entry(id);
}

export function setCursor(id: string, x: number, y: number): void {
  entry(id).cursor = { x, y, at: Date.now() };
}

export function queueClick(id: string, x: number, y: number): void {
  entry(id).click = { x, y, at: Date.now() };
}

export function setNotice(id: string, text: string): void {
  entry(id).notice = { text: text.slice(0, 200), at: Date.now() };
}

export function kick(id: string): void {
  const st = entry(id);
  st.kickAt = Date.now();
  st.screenWant = false;
  st.cursor = null;
}

export function isKicked(id: string): boolean {
  const at = CTRL.get(id)?.kickAt;
  return typeof at === "number" && Date.now() - at < KICK_TTL_MS;
}

export function setScreenWant(id: string, on: boolean): void {
  const st = entry(id);
  st.screenWant = on;
  st.screenWantAt = on ? Date.now() : 0;
  if (!on) st.cursor = null;
}

/** what the user's poll consumes — click + notice are one-shot */
export function pollControl(id: string): {
  kicked: boolean;
  cursor: CtrlCursor | null;
  click: CtrlCursor | null;
  notice: string | null;
  screenWant: boolean;
} {
  const st = entry(id);
  const now = Date.now();
  const click = st.click && now - st.click.at < 10_000 ? st.click : null;
  st.click = null; // deliver once
  const notice = st.notice && now - st.notice.at < 30_000 ? st.notice.text : null;
  if (st.notice && now - st.notice.at >= 30_000) st.notice = null;
  const cursor = st.cursor && now - st.cursor.at < CURSOR_TTL_MS ? st.cursor : null;
  reap();
  return {
    kicked: typeof st.kickAt === "number" && now - st.kickAt < KICK_TTL_MS,
    cursor,
    click,
    notice,
    screenWant: st.screenWant && now - st.screenWantAt < STALE_TTL_MS,
  };
}
