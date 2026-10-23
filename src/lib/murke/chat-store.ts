/**
 * murke-chat-store — the in-memory chat engine behind POST /api/chat.
 *
 * A 1:1 port of mini-services/chat-service semantics (rooms, naming, gc
 * bury rules, dm ids) minus socket.io: clients poll `sync` and everything
 * comes back in one response. Memory ONLY — users, rooms and the event
 * ring die with the process. No db, no files, nothing persisted.
 *
 * Stashed on globalThis so `next dev` module reloads don't wipe the room
 * state out from under open browsers. On serverless each lamdba has its
 * own copy — same caveats the socket mini-service had, minus the port.
 *
 * Rooms:
 *   global   "global"            everyone, auto-joined on join
 *   gc       "gc:<id>"           public group chats anyone can join; leave/bury
 *   dm       "dm:<a>|<b>"        1:1, ids sorted, both sides joined silently
 */
import { randomUUID } from "node:crypto";

/* ---------- wire types (single source of truth; chat-client imports these) ---------- */

export interface ChatUser {
  id: string;
  name: string;
}

export interface RoomInfo {
  id: string;
  kind: "global" | "gc" | "dm";
  name: string;
  peers: string[];
  count: number;
  /** private gc: membership is by invite — only the admin adds people */
  private?: boolean;
  /** private gc: the caller owns this room (can add / kick / bury) */
  isAdmin?: boolean;
  /** private gc: the roster (names), members only */
  members?: string[];
}

/** One relayed event. seq is global and monotonic across ALL rooms. */
export interface ChatEvent {
  seq: number;
  type: "msg" | "sys" | "typing";
  room: string;
  from?: string;
  name?: string;
  text?: string;
  ts?: number;
}

export interface JoinAck {
  ok: true;
  me: ChatUser;
  users: ChatUser[];
  rooms: RoomInfo[];
  cursor: number;
}

export interface SyncAck {
  ok: true;
  cursor: number;
  users: ChatUser[];
  rooms: RoomInfo[];
  events: ChatEvent[];
}

export interface OpFail {
  ok: false;
  error: string;
}

/* ---------- constants (lifted straight from the mini-service) ---------- */

const MAX_NAME = 16;
const MAX_ROOM_NAME = 24;
const MAX_TEXT = 500;
const MAX_GCS = 12;
/** lastSeen older than this -> swept; the polling stand-in for "disconnect". */
const LAST_SEEN_MS = 40_000;
/** ring buffer: only the last N events are ever replayed to a syncer. */
const EVENT_BUFFER = 400;

/* ---------- state (globalThis stash, survives dev-server hot reloads) ---------- */

interface StoreUser extends ChatUser {
  lastSeen: number;
}

interface Room {
  id: string;
  kind: RoomInfo["kind"];
  name: string; // gc display name; "" for global/dm
  members: Set<string>; // clientIds (currently online)
  creator: string | null;
  /** private gc? invite-only: the roster rules who ever gets in */
  private?: boolean;
  /** private gc roster — lowercase handles, survives offline members */
  roster?: Set<string>;
  /** private gc admin — lowercase handle */
  admin?: string | null;
}

interface ChatStoreState {
  /** clientId -> user. Map preserves insertion order, i.e. join order. */
  users: Map<string, StoreUser>;
  /** roomId -> room. */
  rooms: Map<string, Room>;
  events: ChatEvent[];
  seq: number;
}

const STATE_KEY = "__murkeChatStore";

function state(): ChatStoreState {
  const g = globalThis as typeof globalThis & { __murkeChatStore?: ChatStoreState };
  if (!g.__murkeChatStore) {
    g.__murkeChatStore = {
      users: new Map(),
      rooms: new Map([
        ["global", { id: "global", kind: "global", name: "", members: new Set<string>(), creator: null }],
      ]),
      events: [],
      seq: 0,
    };
  }
  return g.__murkeChatStore;
}

/* ---------- sanitize (verbatim from the mini-service) ---------- */

function sanitizeName(raw: unknown): string {
  let name = typeof raw === "string" ? raw : "";
  name = name.replace(/[\u0000-\u001F\u007F]/g, " "); // control chars → space
  name = name.replace(/\s+/g, " ").trim();
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME).trim();
  return name.length > 0 ? name : "anon";
}

/** Case-insensitive uniqueness: append "-2", "-3", … until the name is free. */
function uniqueName(base: string): string {
  const taken = new Set<string>();
  for (const u of state().users.values()) taken.add(u.name.toLowerCase());
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`.toLowerCase())) n += 1;
  return `${base}-${n}`;
}

function sanitizeRoomName(raw: unknown): string {
  let name = typeof raw === "string" ? raw : "";
  name = name.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length > MAX_ROOM_NAME) name = name.slice(0, MAX_ROOM_NAME).trim();
  return name;
}

function dmRoomId(a: string, b: string): string {
  return `dm:${[a, b].sort().join("|")}`;
}

/* ---------- internals ---------- */

/** Append one event to the ring; returns its seq. */
function append(evt: Omit<ChatEvent, "seq">): number {
  const s = state();
  s.seq += 1;
  s.events.push({ ...evt, seq: s.seq });
  if (s.events.length > EVENT_BUFFER) s.events.splice(0, s.events.length - EVENT_BUFFER);
  return s.seq;
}

/** Roster in join order (Map iteration order). */
function listUsers(): ChatUser[] {
  return [...state().users.values()].map(({ id, name }) => ({ id, name }));
}

/**
 * Rooms a client may SEE: global + all gcs + dms involving the caller.
 * peers = other members' handles (dm sidebar needs them without a lookup).
 */
function roomsFor(clientId: string): RoomInfo[] {
  const s = state();
  const me = s.users.get(clientId);
  const myName = me ? me.name.toLowerCase() : null;
  const out: RoomInfo[] = [];
  for (const room of s.rooms.values()) {
    const involvesMe = room.kind === "dm" && room.members.has(clientId);
    if (room.kind === "gc" && room.private) {
      // PRIVATE gc: invisible to anyone the admin has not rostered
      if (!myName || !room.roster?.has(myName)) continue;
      const memberNames = [...room.roster].map((n) => {
        const cid = clIdByName(n);
        return (cid ? s.users.get(cid)?.name : undefined) ?? n;
      });
      out.push({
        id: room.id,
        kind: "gc",
        name: room.name,
        peers: [],
        count: room.members.size,
        private: true,
        isAdmin: room.admin === myName,
        members: memberNames,
      });
      continue;
    }
    const isPublic = room.kind === "global" || room.kind === "gc";
    if (!isPublic && !involvesMe) continue;
    const peers: string[] = [];
    for (const m of room.members) {
      if (m === clientId) continue;
      peers.push(s.users.get(m)?.name ?? "?");
    }
    out.push({
      id: room.id,
      kind: room.kind,
      name: room.name,
      peers: room.kind === "dm" ? peers : [],
      count: room.members.size,
    });
  }
  return out;
}

/** lowercase handle -> online clientId (private-gc roster lookups). */
function clIdByName(lowerName: string): string | null {
  for (const [id, u] of state().users) {
    if (u.name.toLowerCase() === lowerName) return id;
  }
  return null;
}

/**
 * Drop everyone whose lastSeen went stale, clean up their memberships and
 * bury what died with them — the polling equivalent of the old socket
 * "disconnect" handler. ANY empty gc is buried; dms die below 2 members.
 */
function sweep(now: number): void {
  const s = state();
  for (const [id, u] of s.users) {
    if (now - u.lastSeen <= LAST_SEEN_MS) continue;
    s.users.delete(id);
    append({ type: "sys", room: "global", text: `${u.name} left` });
    for (const room of s.rooms.values()) {
      room.members.delete(id);
      if (room.kind === "dm" && room.members.size < 2) s.rooms.delete(room.id);
      else if (room.kind === "gc" && room.private) {
        // private gcs live as long as their roster — offline members come back
        if (room.roster && room.roster.size === 0) s.rooms.delete(room.id);
      } else if (room.kind === "gc" && room.members.size === 0) {
        s.rooms.delete(room.id);
      }
    }
  }
}

/* ---------- ops ---------- */

/**
 * Refresh lastSeen + sweep the graveyard. False if the client never joined
 * (or was already swept by someone else's touch). Called on EVERY op —
 * polling is the heartbeat.
 */
export function touch(clientId: string): boolean {
  const s = state();
  const u = s.users.get(clientId);
  const now = Date.now();
  if (u) u.lastSeen = now;
  sweep(now);
  return s.users.has(clientId);
}

/**
 * join: fresh adopt of the sanitized + uniquefied name (re-join = re-adopt,
 * exactly like the old "every connect re-emits chat:join" behavior), into
 * global, and the ack carries everything the client needs in one shot.
 */
export function join(clientId: string, rawName: unknown): JoinAck {
  const s = state();
  const name = uniqueName(sanitizeName(rawName));
  s.users.set(clientId, { id: clientId, name, lastSeen: Date.now() });
  const globalRoom = s.rooms.get("global");
  if (globalRoom) globalRoom.members.add(clientId);
  // private gcs: if the admin rostered this handle, membership resumes on
  // the very first sync — the room simply reappears in their sidebar
  const myLower = name.toLowerCase();
  for (const room of s.rooms.values()) {
    if (room.kind === "gc" && room.private && room.roster?.has(myLower)) {
      room.members.add(clientId);
      append({ type: "sys", room: room.id, text: `${name} is back` });
    }
  }
  const roster = listUsers();
  // "joined" goes out BEFORE the cursor is taken, so the joiner never sees
  // their own line — same as the old socket.broadcast emit.
  append({ type: "sys", room: "global", text: `${name} joined` });
  return { ok: true, me: { id: clientId, name }, users: roster, rooms: roomsFor(clientId), cursor: s.seq };
}

/**
 * sync: the whole transport. touch first (heartbeat + sweep), then replay
 * everything past the caller's cursor. Own typing pings are filtered out —
 * msg echoes DO go to the sender (single source of truth for ordering).
 */
export function sync(clientId: string, cursor: number): SyncAck | OpFail {
  if (!touch(clientId)) return { ok: false, error: "unknown-client" };
  const s = state();
  const events: ChatEvent[] = [];
  for (const e of s.events) {
    if (e.seq <= cursor) continue;
    if (e.type === "typing" && e.from === clientId) continue;
    events.push(e);
  }
  return { ok: true, cursor: s.seq, users: listUsers(), rooms: roomsFor(clientId), events };
}

/** msg: member check, trim+cap, append. Sender gets the echo via sync. */
export function msg(clientId: string, roomId: string, rawText: unknown): { ok: true } | OpFail {
  const s = state();
  const user = s.users.get(clientId);
  if (!user) return { ok: false, error: "unknown-client" };
  const room = s.rooms.get(roomId);
  if (!room || !room.members.has(clientId)) return { ok: false, error: "not in that room" };
  const text = (typeof rawText === "string" ? rawText : "").trim().slice(0, MAX_TEXT).trim();
  if (!text) return { ok: false, error: "say something" };
  append({ type: "msg", room: roomId, from: clientId, name: user.name, text, ts: Date.now() });
  return { ok: true };
}

/** typing: pure relay into the ring; delivery skips the sender. No state. */
export function typing(clientId: string, roomId: string): { ok: true } | OpFail {
  const s = state();
  const user = s.users.get(clientId);
  if (!user) return { ok: false, error: "unknown-client" };
  const room = s.rooms.get(roomId);
  if (!room || !room.members.has(clientId)) return { ok: false, error: "not in that room" };
  append({ type: "typing", room: roomId, from: clientId, name: user.name });
  return { ok: true };
}

/** dm: build dm:<a>|<b>, join both ends silently. No sys noise. */
export function dm(clientId: string, toId: string): { ok: true; roomId: string } | OpFail {
  const s = state();
  const user = s.users.get(clientId);
  if (!user) return { ok: false, error: "unknown-client" };
  if (toId === clientId || !s.users.has(toId)) return { ok: false, error: "they are gone" };
  const roomId = dmRoomId(clientId, toId);
  let room = s.rooms.get(roomId);
  if (!room) {
    room = { id: roomId, kind: "dm", name: "", members: new Set<string>(), creator: null };
    s.rooms.set(roomId, room);
  }
  room.members.add(clientId);
  room.members.add(toId);
  return { ok: true, roomId };
}

/**
 * gc: create a public group chat, creator joins. The last one out buries
 * it (leave/sweep), and there's a hard cap so #hellfire-club can't metastasize.
 */
export function gc(
  clientId: string,
  rawName: unknown,
  isPrivate = false,
): { ok: true; room: RoomInfo } | OpFail {
  const s = state();
  const user = s.users.get(clientId);
  if (!user) return { ok: false, error: "unknown-client" };
  const name = sanitizeRoomName(rawName);
  if (!name) return { ok: false, error: "name it something" };
  let gcCount = 0;
  for (const r of s.rooms.values()) if (r.kind === "gc") gcCount += 1;
  if (gcCount >= MAX_GCS) {
    return { ok: false, error: "too many groups burning — one had to die first" };
  }
  const room: Room = {
    id: `gc:${randomUUID().slice(0, 8)}`,
    kind: "gc",
    name,
    members: new Set<string>([clientId]),
    creator: clientId,
  };
  if (isPrivate) {
    room.private = true;
    room.roster = new Set<string>([user.name.toLowerCase()]);
    room.admin = user.name.toLowerCase();
  }
  s.rooms.set(room.id, room);
  append({ type: "sys", room: room.id, text: `${user.name} opened #${name}${isPrivate ? " (private)" : ""}` });
  return {
    ok: true,
    room: {
      id: room.id,
      kind: room.kind,
      name: room.name,
      peers: [],
      count: 1,
      ...(isPrivate ? { private: true, isAdmin: true, members: [user.name] } : {}),
    },
  };
}

/**
 * gcAdd (private gc, ADMIN only): roster a handle by NAME. Online members
 * join instantly; offline handles are added to the roster and pulled in on
 * their next join. Nobody else ever sees the room exist.
 */
export function gcAdd(clientId: string, roomId: string, rawName: unknown): { ok: true } | OpFail {
  const s = state();
  const user = s.users.get(clientId);
  if (!user) return { ok: false, error: "unknown-client" };
  const room = s.rooms.get(roomId);
  if (!room || room.kind !== "gc" || !room.private) return { ok: false, error: "no such private room" };
  if (room.admin !== user.name.toLowerCase()) return { ok: false, error: "only the admin adds people" };
  const name = sanitizeName(rawName);
  if (!name) return { ok: false, error: "who? give me a handle" };
  const lower = name.toLowerCase();
  if (!room.roster) room.roster = new Set();
  if (room.roster.has(lower) && room.members.size > 0) {
    const online = clIdByName(lower);
    if (online && room.members.has(online)) return { ok: false, error: `${name} is already in` };
  }
  room.roster.add(lower);
  const online = clIdByName(lower);
  if (online) {
    room.members.add(online);
    append({ type: "sys", room: roomId, text: `${user.name} added ${name}` });
  } else {
    append({ type: "sys", room: roomId, text: `${user.name} invited ${name} — they join next time they appear` });
  }
  return { ok: true };
}

/** gcKick (private gc, ADMIN only): cast someone out of the roster. */
export function gcKick(clientId: string, roomId: string, rawName: unknown): { ok: true } | OpFail {
  const s = state();
  const user = s.users.get(clientId);
  if (!user) return { ok: false, error: "unknown-client" };
  const room = s.rooms.get(roomId);
  if (!room || room.kind !== "gc" || !room.private) return { ok: false, error: "no such private room" };
  if (room.admin !== user.name.toLowerCase()) return { ok: false, error: "only the admin casts out" };
  const lower = String(typeof rawName === "string" ? rawName : "").toLowerCase();
  if (!lower) return { ok: false, error: "who? give me a handle" };
  if (lower === room.admin) return { ok: false, error: "the admin cannot be kicked" };
  if (!room.roster?.has(lower)) return { ok: false, error: "they are not in this room" };
  room.roster.delete(lower);
  const online = clIdByName(lower);
  if (online) {
    room.members.delete(online);
    append({ type: "sys", room: roomId, text: `${user.name} cast out ${lower}` });
  } else {
    append({ type: "sys", room: roomId, text: `${user.name} uninvited ${lower}` });
  }
  return { ok: true };
}

/** bury: delete a gc outright. Private gcs demand the admin. */
export function bury(clientId: string, roomId: string): { ok: true } | OpFail {
  const s = state();
  const user = s.users.get(clientId);
  if (!user) return { ok: false, error: "unknown-client" };
  const room = s.rooms.get(roomId);
  if (!room || room.kind !== "gc") return { ok: false, error: "no such room" };
  if (room.private && room.admin !== user.name.toLowerCase()) {
    return { ok: false, error: "only the admin buries a private room" };
  }
  append({ type: "sys", room: roomId, text: `${user.name} buried #${room.name}` });
  s.rooms.delete(roomId);
  return { ok: true };
}

/** leave: walk out of a gc. Private gcs strike you from the roster — only
 *  the admin can add you back. An admin leaving hands the keys over; an
 *  emptied public gc is buried on the spot. */
export function leave(clientId: string, roomId: string): { ok: true } | OpFail {
  const s = state();
  const user = s.users.get(clientId);
  if (!user) return { ok: false, error: "unknown-client" };
  const room = s.rooms.get(roomId);
  if (!room || room.kind !== "gc") return { ok: false, error: "can't leave that" };
  if (room.members.has(clientId)) {
    room.members.delete(clientId);
    if (room.private && room.roster) {
      const myLower = user.name.toLowerCase();
      room.roster.delete(myLower);
      if (room.admin === myLower) {
        const nextAdmin = [...room.roster][0] ?? null;
        room.admin = nextAdmin;
        if (nextAdmin) {
          append({ type: "sys", room: roomId, text: `${user.name} left — ${nextAdmin} holds the keys now` });
        } else {
          append({ type: "sys", room: roomId, text: `${user.name} left — the room died with them` });
        }
      } else {
        append({ type: "sys", room: roomId, text: `${user.name} left the private room` });
      }
      if (room.roster.size === 0) s.rooms.delete(roomId);
    } else if (room.members.size === 0) {
      s.rooms.delete(roomId); // last one out buries it
    } else {
      append({ type: "sys", room: roomId, text: `${user.name} bailed` });
    }
  }
  return { ok: true };
}

/** join_room: join a public gc. Dms auto-join on creation; global is automatic. */
export function joinRoom(clientId: string, roomId: string): { ok: true } | OpFail {
  const s = state();
  const user = s.users.get(clientId);
  if (!user) return { ok: false, error: "unknown-client" };
  const room = s.rooms.get(roomId);
  if (!room || room.kind !== "gc") return { ok: false, error: "no such room" };
  if (room.private) return { ok: false, error: "invite-only — the admin has to add you" };
  const wasNew = !room.members.has(clientId);
  room.members.add(clientId);
  if (wasNew) append({ type: "sys", room: roomId, text: `${user.name} slipped in` });
  return { ok: true };
}
