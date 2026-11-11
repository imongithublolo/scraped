/**
 * murke-chat transport — browser side of the polling chat relay.
 *
 * Replaces socket.io wholesale: one POST /api/chat per action plus a 1.3s
 * sync heartbeat that carries users/rooms/events back in a single response.
 * Relative URL only — the same code works on `next dev` and on Vercel,
 * which is the whole reason socket.io had to go.
 *
 * Reconnect story: network failures just flip state to "offline" and keep
 * polling; an "unknown-client" sync reply (server restarted or the 40s
 * sweeper ate us) stops the loop and re-joins with the stored handle —
 * the polling equivalent of socket.io's reconnect + re-emit chat:join.
 */
import type { ChatEvent, ChatUser, RoomInfo } from "./chat-store";

export type { ChatEvent, ChatUser, RoomInfo };

export type ChatConnState = "connecting" | "connected" | "offline";

export interface ChatJoinAck {
  ok: boolean;
  me: ChatUser;
  users: ChatUser[];
  rooms: RoomInfo[];
}

export interface ChatDmAck {
  ok: boolean;
  roomId?: string;
  error?: string;
}

export interface ChatGcAck {
  ok: boolean;
  room?: RoomInfo;
  error?: string;
}

export interface ChatAck {
  ok: boolean;
  error?: string;
}

export interface ChatTransportHandlers {
  onState(s: ChatConnState): void;
  onJoined(ack: ChatJoinAck): void;
  onUsers(users: ChatUser[]): void;
  onRooms(rooms: RoomInfo[]): void;
  onEvent(e: ChatEvent): void;
}

interface SyncOk {
  ok: true;
  cursor: number;
  users: ChatUser[];
  rooms: RoomInfo[];
  events: ChatEvent[];
}

const SYNC_EVERY_MS = 1300;
const JOIN_RETRY_MS = 3000;

/** Server JSON -> object; the handlers re-guard the shapes they care about. */
function asObject(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

export class ChatTransport {
  /** one uuid per transport instance — the client's whole identity */
  private readonly clientId = crypto.randomUUID();
  private readonly handlers: ChatTransportHandlers;
  private name = "";
  private cursor = 0;
  private conn: ChatConnState = "connecting";
  private timer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** in-flight guard: a slow sync never stacks the next one behind it */
  private syncing = false;
  private closed = false;

  constructor(handlers: ChatTransportHandlers) {
    this.handlers = handlers;
  }

  /** live connection state — the speak line checks it before pinging typing */
  get connected(): boolean {
    return this.conn === "connected";
  }

  /** join with a handle; on failure retries forever every 3s while open. */
  join(name: string): void {
    if (this.closed) return;
    this.name = name;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    void this.post({ op: "join", clientId: this.clientId, name })
      .then((data) => {
        if (this.closed) return;
        const body = asObject(data);
        if (body.ok !== true) {
          this.joinFailed();
          return;
        }
        const ack = body as unknown as {
          cursor?: unknown;
          me: ChatUser;
          users: ChatUser[];
          rooms: RoomInfo[];
        };
        if (typeof ack.cursor === "number" && Number.isFinite(ack.cursor)) this.cursor = ack.cursor;
        this.setConn("connected");
        this.handlers.onJoined({ ok: true, me: ack.me, users: ack.users, rooms: ack.rooms });
        this.startLoop();
        void this.syncTick(); // first sync now, not 1.3s from now
      })
      .catch(() => this.joinFailed());
  }

  msg(room: string, text: string): void {
    void this.post({ op: "msg", clientId: this.clientId, room, text }).catch(() => {
      /* offline — the line dies quietly, same as a socket write to nowhere */
    });
  }

  typing(room: string): void {
    void this.post({ op: "typing", clientId: this.clientId, room }).catch(() => {
      /* ephemeral — nobody mourns a lost typing ping */
    });
  }

  dm(to: string, ack?: (r: ChatDmAck) => void): void {
    void this.post({ op: "dm", clientId: this.clientId, to })
      .then((data) => {
        if (!this.closed && ack) ack(asObject(data) as unknown as ChatDmAck);
      })
      .catch(() => {
        /* no response -> no ack, like socket.io */
      });
  }

  gc(name: string, isPrivate: boolean, ack?: (r: ChatGcAck) => void): void {
    void this.post({ op: "gc", clientId: this.clientId, name, private: isPrivate })
      .then((data) => {
        if (!this.closed && ack) ack(asObject(data) as unknown as ChatGcAck);
      })
      .catch(() => {
        /* no response -> no ack, like socket.io */
      });
  }

  /** private gc, admin only: roster a handle (online now or next join). */
  gcAdd(roomId: string, name: string, ack?: (r: ChatAck) => void): void {
    void this.post({ op: "gc_add", clientId: this.clientId, roomId, name })
      .then((data) => {
        if (!this.closed && ack) ack(asObject(data) as unknown as ChatAck);
      })
      .catch(() => {
        /* no response -> no ack, like socket.io */
      });
  }

  /** private gc, admin only: cast someone out of the roster. */
  gcKick(roomId: string, name: string, ack?: (r: ChatAck) => void): void {
    void this.post({ op: "gc_kick", clientId: this.clientId, roomId, name })
      .then((data) => {
        if (!this.closed && ack) ack(asObject(data) as unknown as ChatAck);
      })
      .catch(() => {
        /* no response -> no ack, like socket.io */
      });
  }

  /** delete a gc outright; private gcs demand the admin. */
  bury(roomId: string, ack?: (r: ChatAck) => void): void {
    void this.post({ op: "bury", clientId: this.clientId, roomId })
      .then((data) => {
        if (!this.closed && ack) ack(asObject(data) as unknown as ChatAck);
      })
      .catch(() => {
        /* no response -> no ack, like socket.io */
      });
  }

  leave(roomId: string, ack?: (r: ChatAck) => void): void {
    void this.post({ op: "leave", clientId: this.clientId, roomId })
      .then((data) => {
        if (!this.closed && ack) ack(asObject(data) as unknown as ChatAck);
      })
      .catch(() => {
        /* no response -> no ack, like socket.io */
      });
  }

  joinRoom(roomId: string, ack?: (r: ChatAck) => void): void {
    void this.post({ op: "join_room", clientId: this.clientId, roomId })
      .then((data) => {
        if (!this.closed && ack) ack(asObject(data) as unknown as ChatAck);
      })
      .catch(() => {
        /* no response -> no ack, like socket.io */
      });
  }

  /** stop everything; the transport is dead after this */
  close(): void {
    this.closed = true;
    this.stopLoop();
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /* ---------- internals ---------- */

  private async post(body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`chat http ${res.status}`);
    return res.json();
  }

  /** fire onState only on real transitions — the heartbeat must not spam */
  private setConn(s: ChatConnState): void {
    if (this.conn === s) return;
    this.conn = s;
    this.handlers.onState(s);
  }

  private joinFailed(): void {
    if (this.closed) return;
    this.setConn("offline");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.join(this.name);
    }, JOIN_RETRY_MS);
  }

  private startLoop(): void {
    this.stopLoop();
    this.timer = setInterval(() => {
      void this.syncTick();
    }, SYNC_EVERY_MS);
  }

  private stopLoop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async syncTick(): Promise<void> {
    if (this.closed || this.syncing) return;
    this.syncing = true;
    try {
      const body = asObject(
        await this.post({ op: "sync", clientId: this.clientId, cursor: this.cursor }),
      );
      if (this.closed) return;
      if (body.ok !== true) {
        if (body.error === "unknown-client") {
          // server lost us (restart / swept) — stop polling, re-join
          this.stopLoop();
          this.setConn("connecting");
          this.join(this.name);
          return;
        }
        this.setConn("offline");
        return; // keep looping
      }
      const ack = body as unknown as SyncOk;
      this.cursor = ack.cursor;
      this.setConn("connected");
      this.handlers.onUsers(ack.users);
      this.handlers.onRooms(ack.rooms);
      for (const e of ack.events) this.handlers.onEvent(e);
    } catch {
      if (!this.closed) this.setConn("offline"); // keep looping
    } finally {
      this.syncing = false;
    }
  }
}
