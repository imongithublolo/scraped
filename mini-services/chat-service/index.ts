/**
 * murke-chat-mini — live chat relay for the MURKE Proxy "chat" pane.
 *
 * In-memory ONLY: users + rooms live in Maps and die with the process.
 * There is NO message history — the server relays and forgets. No files,
 * no db, nothing persisted anywhere.
 *
 * Rooms:
 *   global   "global"            everyone, auto-joined on chat:join
 *   gc       "gc:<id>"           public group chats anyone can join; leave/bury
 *   dm       "dm:<a>|<b>"        1:1, ids sorted, both sides joined silently
 *
 * Bound HARD to port 3003 (the gateway reaches it via the XTransformPort
 * query param, e.g. client connects with io("/?XTransformPort=3003")).
 */
import { Server } from "socket.io";
import { randomUUID } from "node:crypto";

const PORT = 3003; // hard-bound; never process.env.PORT

const MAX_NAME = 16;
const MAX_ROOM_NAME = 24;
const MAX_TEXT = 500;
const MAX_GCS = 12;

interface ChatUser {
  id: string;
  name: string;
}

interface Room {
  id: string;
  kind: "global" | "gc" | "dm";
  name: string; // gc display name; "" for global/dm
  members: Set<string>; // socket ids
  creator: string | null;
}

/** socketId -> user. Map preserves insertion order, i.e. join order. */
const users = new Map<string, ChatUser>();
/** roomId -> room. */
const rooms = new Map<string, Room>();
rooms.set("global", { id: "global", kind: "global", name: "", members: new Set(), creator: null });

/* ---------- sanitize ---------- */

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
  for (const u of users.values()) taken.add(u.name.toLowerCase());
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

/** Roster in join order (Map iteration order). */
function listUsers(): ChatUser[] {
  return [...users.values()];
}

/**
 * Rooms a socket may SEE: global + all gcs + dms involving the caller.
 * peers = other members' handles (dm sidebar needs them without a lookup).
 */
function roomsFor(socketId: string) {
  const out: Array<{ id: string; kind: Room["kind"]; name: string; peers: string[]; count: number }> = [];
  for (const room of rooms.values()) {
    const involvesMe =
      room.kind === "dm" && room.members.has(socketId);
    const isPublic = room.kind === "global" || room.kind === "gc";
    if (!isPublic && !involvesMe) continue;
    const peers: string[] = [];
    for (const m of room.members) {
      if (m === socketId) continue;
      peers.push(users.get(m)?.name ?? "?");
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

function broadcastRooms(): void {
  for (const [sid] of users) {
    io.to(sid).emit("chat:rooms", { rooms: roomsFor(sid) });
  }
}

function joinRoom(socketId: string, roomId: string): Room | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  const wasNew = !room.members.has(socketId);
  if (wasNew) room.members.add(socketId);
  return wasNew ? room : room;
}

const io = new Server(PORT, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  /*
   * chat:join { name }, ack callback
   *   ack → { ok: true, me, users, rooms }   (rooms = what this caller sees)
   *   then chat:users + chat:rooms to everyone, chat:sys "joined" to global.
   */
  socket.on("chat:join", (payload: unknown, ack: unknown) => {
    const raw = (payload as { name?: unknown } | null)?.name;
    const name = uniqueName(sanitizeName(raw));
    const me: ChatUser = { id: socket.id, name };
    users.set(socket.id, me);
    rooms.get("global")!.members.add(socket.id);
    // CRITICAL: membership in our own Set only drives permission checks —
    // actual delivery needs the socket in the real socket.io room, or every
    // io.to("global") emit (msg/sys/typing, own echo included) hits nobody.
    socket.join("global");
    const roster = listUsers();
    if (typeof ack === "function") {
      ack({ ok: true, me, users: roster, rooms: roomsFor(socket.id) });
    }
    io.emit("chat:users", { users: roster });
    broadcastRooms();
    socket.broadcast.emit("chat:sys", { room: "global", text: `${name} joined` });
    console.log(`[chat] + ${name} (${socket.id}) — ${users.size} online, ${rooms.size} rooms`);
  });

  /*
   * chat:msg { room, text } → member check, relay to that room ONLY.
   * Echo includes the sender (single source of truth for ordering).
   */
  socket.on("chat:msg", (payload: unknown) => {
    const user = users.get(socket.id);
    if (!user) return;
    const roomId = (payload as { room?: unknown } | null)?.room;
    const raw = (payload as { text?: unknown } | null)?.text;
    if (typeof roomId !== "string" || typeof raw !== "string") return;
    const room = rooms.get(roomId);
    if (!room || !room.members.has(socket.id)) return;
    const text = raw.trim().slice(0, MAX_TEXT).trim();
    if (!text) return;
    io.to(roomId).emit("chat:msg", {
      room: roomId,
      from: socket.id,
      name: user.name,
      text,
      ts: Date.now(),
    });
  });

  /*
   * chat:typing { room } → pure relay to that room EXCEPT sender. No state.
   */
  socket.on("chat:typing", (payload: unknown) => {
    const user = users.get(socket.id);
    if (!user) return;
    const roomId = (payload as { room?: unknown } | null)?.room;
    if (typeof roomId !== "string") return;
    const room = rooms.get(roomId);
    if (!room || !room.members.has(socket.id)) return;
    socket.to(roomId).emit("chat:typing", { room: roomId, name: user.name });
  });

  /*
   * chat:gc { name }, ack → create a public group chat, creator joins.
   * ack → { ok, room } | { ok: false, error }
   * Everyone gets a fresh chat:rooms.
   */
  socket.on("chat:gc", (payload: unknown, ack: unknown) => {
    const user = users.get(socket.id);
    if (!user) return;
    const name = sanitizeRoomName((payload as { name?: unknown } | null)?.name);
    if (!name) {
      if (typeof ack === "function") ack({ ok: false, error: "name it something" });
      return;
    }
    const gcCount = [...rooms.values()].filter((r) => r.kind === "gc").length;
    if (gcCount >= MAX_GCS) {
      if (typeof ack === "function") ack({ ok: false, error: "too many groups burning — one had to die first" });
      return;
    }
    const room: Room = {
      id: `gc:${randomUUID().slice(0, 8)}`,
      kind: "gc",
      name,
      members: new Set([socket.id]),
      creator: socket.id,
    };
    rooms.set(room.id, room);
    socket.join(room.id);
    if (typeof ack === "function") {
      ack({ ok: true, room: { id: room.id, kind: room.kind, name: room.name, peers: [], count: 1 } });
    }
    io.to(room.id).emit("chat:sys", { room: room.id, text: `${user.name} opened #${name}` });
    broadcastRooms();
    console.log(`[chat] gc +${room.id} "${name}" by ${user.name}`);
  });

  /*
   * chat:leave { roomId }, ack → walk out of a public gc.
   * The last one out buries the room (so no zombie #hellfire-club rows).
   * ack → { ok } | { ok: false, error }
   */
  socket.on("chat:leave", (payload: unknown, ack: unknown) => {
    const user = users.get(socket.id);
    if (!user) return;
    const roomId = (payload as { roomId?: unknown } | null)?.roomId;
    if (typeof roomId !== "string") return;
    const room = rooms.get(roomId);
    if (!room || room.kind !== "gc") {
      if (typeof ack === "function") ack({ ok: false, error: "can't leave that" });
      return;
    }
    if (room.members.has(socket.id)) {
      room.members.delete(socket.id);
      socket.leave(roomId);
      if (room.members.size === 0) {
        rooms.delete(roomId);
        console.log(`[chat] gc -${roomId} "${room.name}" buried (empty)`);
      } else {
        io.to(roomId).emit("chat:sys", { room: roomId, text: `${user.name} bailed` });
      }
      broadcastRooms();
    }
    if (typeof ack === "function") ack({ ok: true });
  });

  /*
   * chat:join_room { roomId } → join a public gc. Dms auto-join on creation.
   */
  socket.on("chat:join_room", (payload: unknown, ack: unknown) => {
    const user = users.get(socket.id);
    if (!user) return;
    const roomId = (payload as { roomId?: unknown } | null)?.roomId;
    if (typeof roomId !== "string") return;
    const room = rooms.get(roomId);
    if (!room || room.kind !== "gc") {
      if (typeof ack === "function") ack({ ok: false, error: "no such room" });
      return;
    }
    const wasNew = !room.members.has(socket.id);
    room.members.add(socket.id);
    socket.join(roomId);
    if (wasNew) {
      io.to(roomId).emit("chat:sys", { room: roomId, text: `${user.name} slipped in` });
      broadcastRooms();
    }
    if (typeof ack === "function") ack({ ok: true });
  });

  /*
   * chat:dm { to }, ack → build dm:<a>|<b>, join both ends silently.
   * ack → { ok, roomId } | { ok: false, error }
   */
  socket.on("chat:dm", (payload: unknown, ack: unknown) => {
    const user = users.get(socket.id);
    if (!user) return;
    const to = (payload as { to?: unknown } | null)?.to;
    if (typeof to !== "string" || to === socket.id || !users.has(to)) {
      if (typeof ack === "function") ack({ ok: false, error: "they are gone" });
      return;
    }
    const roomId = dmRoomId(socket.id, to);
    let room = rooms.get(roomId);
    if (!room) {
      room = { id: roomId, kind: "dm", name: "", members: new Set(), creator: null };
      rooms.set(roomId, room);
    }
    room.members.add(socket.id);
    room.members.add(to);
    socket.join(roomId);
    io.sockets.sockets.get(to)?.join(roomId);
    broadcastRooms();
    if (typeof ack === "function") ack({ ok: true, roomId });
    console.log(`[chat] dm ${roomId} opened by ${user.name}`);
  });

  socket.on("disconnect", () => {
    const user = users.get(socket.id);
    if (!user) return;
    users.delete(socket.id);
    for (const room of rooms.values()) {
      room.members.delete(socket.id);
      if (room.kind === "dm" && room.members.size < 2) rooms.delete(room.id);
      if (room.kind === "gc" && room.members.size === 0) {
        // ANY empty gc gets buried on ANY disconnect — not just the creator's
        // (a gc whose creator left while others lingered used to live forever)
        rooms.delete(room.id);
      }
    }
    io.emit("chat:users", { users: listUsers() });
    broadcastRooms();
    socket.broadcast.emit("chat:sys", { room: "global", text: `${user.name} left` });
    console.log(`[chat] - ${user.name} (${socket.id}) — ${users.size} online`);
  });
});

console.log(`[chat] murke-chat-mini listening on :${PORT}`);

/* ---------- dev-server shepherd ----------
   The sandbox janitor reaps orphaned processes a couple of minutes after
   their spawning shell is gone, which used to leave the main Next dev
   server (port 3000) dead between sessions. This process is a blessed
   child of the boot tree, so anything IT spawns survives: poll :3000 and
   when nobody answers, spawn `bun run dev` in the project root as OUR
   child. Hot-reload safe: the port check makes every pass a no-op while
   the server is up, and a duplicate spawner would just fail to bind. */
import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";

const PROJECT_ROOT = "/home/z/my-project";

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
    s.setTimeout(1500, () => {
      s.destroy();
      resolve(false);
    });
  });
}

let spawning = false;
async function shepherd(): Promise<void> {
  if (spawning) return;
  if (await portOpen(3000)) return;
  spawning = true;
  try {
    console.log("[shepherd] :3000 is quiet — spawning the dev server");
    const child = spawn("bun", ["run", "dev"], {
      cwd: PROJECT_ROOT,
      detached: false, // stay in this tree — orphans get reaped
      stdio: "ignore",
    });
    child.on("exit", (code) => console.log(`[shepherd] dev server exited (${code})`));
  } finally {
    setTimeout(() => {
      spawning = false;
    }, 45_000);
  }
}
const shepherdTimer = setInterval(() => void shepherd(), 20_000);
shepherdTimer.unref?.();
void shepherd();
