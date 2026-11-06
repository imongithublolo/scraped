"use client";

/**
 * MURKE Proxy — chat pane ("chat" command). Real multi-user relay.
 *
 * Talks plain HTTP polling to /api/chat — the relay lives inside the
 * Next.js server itself now (in-memory, same semantics the socket.io
 * mini-service had), so it works identically on `next dev` and on Vercel.
 * Never an absolute URL, never a port. The relay is a dumb hub over
 * ROOMS: #global (everyone), public GCs, and 1:1 DMs. It never stores a
 * message — the log below is component state only and dies on refresh.
 *
 * Phase 1 — name gate: blank input joins as "anon" by default.
 * Phase 2 — sidebar (online users → click to DM · rooms → click to switch
 *           · +gc to open a group) + per-room log + speak line.
 *
 * SSR-safe: no window/sessionStorage access at render time; fetches and
 * timers only exist inside effects and handlers. All timers are cleaned up
 * on unmount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatTransport } from "@/lib/murke/chat-client";
import GcPane, { GC_AUTH_KEY } from "./GcPane";

/** sessionStorage key holding the chosen handle (removed by [rename]). */
export const CHAT_NAME_KEY = "murke.chat.name";

const MAX_NAME = 16;
const MAX_LOG_ENTRIES = 250;
const TYPING_VISIBLE_MS = 2500;
const TYPING_SEND_THROTTLE_MS = 1500;

type ConnState = "connecting" | "connected" | "offline";
type ChatTab = "relay" | "gc";

interface UserEntry {
  id: string;
  name: string;
}

interface RoomInfo {
  id: string;
  kind: "global" | "gc" | "dm";
  name: string;
  peers: string[];
  count: number;
  private?: boolean;
  isAdmin?: boolean;
  members?: string[];
}

/**
 * One rendered log line. `mine` is snapshotted at append time: the id set
 * only updates on (re)join, so ownership must be decided while it is
 * current, not at render time.
 */
type LogEntry =
  | { key: string; kind: "msg"; mine: boolean; name: string; text: string }
  | { key: string; kind: "sys"; text: string };

type NewLogEntry =
  | { kind: "msg"; mine: boolean; name: string; text: string }
  | { kind: "sys"; text: string };

const BORDER = "border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)]";
const BORDER_FAINT = "border-[color-mix(in_srgb,var(--term-fg)_15%,transparent)]";
const SCROLLBAR =
  "[scrollbar-width:thin] [scrollbar-color:color-mix(in_srgb,var(--term-fg)_30%,transparent)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--term-fg)_25%,transparent)]";

/* ---------- helpers ---------- */

/** Mirrors the server sanitizer: strip control chars, collapse ws, trim, cap 16. */
function sanitizeHandle(raw: string): string {
  const stripped = raw.replace(/[\u0000-\u001F\u007F]/g, " ");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_NAME ? collapsed.slice(0, MAX_NAME).trim() : collapsed;
}

/** Subtle left/right jolt — Web Animations, self-cleaning, no keyframes needed. */
function shake(el: HTMLElement | null): void {
  if (!el || typeof el.animate !== "function") return;
  el.animate(
    [
      { transform: "translateX(0px)" },
      { transform: "translateX(-6px)" },
      { transform: "translateX(6px)" },
      { transform: "translateX(-3px)" },
      { transform: "translateX(3px)" },
      { transform: "translateX(0px)" },
    ],
    { duration: 300, easing: "ease-in-out" },
  );
}

function isUser(u: unknown): u is UserEntry {
  return (
    typeof u === "object" &&
    u !== null &&
    typeof (u as UserEntry).id === "string" &&
    typeof (u as UserEntry).name === "string"
  );
}

function isRoom(r: unknown): r is RoomInfo {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    (o.kind === "global" || o.kind === "gc" || o.kind === "dm") &&
    typeof o.name === "string" &&
    Array.isArray(o.peers) &&
    typeof o.count === "number"
  );
}

function roomLabel(r: RoomInfo): string {
  if (r.kind === "global") return "#global";
  if (r.kind === "gc") return `#${r.name}${r.private ? " ·pv" : ""}`;
  return r.peers.length > 0 ? `@${r.peers.join(", ")}` : "@…";
}

/** `name> text` (others) · dim `you> text` (mine) · dim italic sys. */
function LogLine({ entry }: { entry: LogEntry }) {
  if (entry.kind === "sys") {
    return (
      <div className="py-px pl-4 italic text-[var(--term-dim)]">· {entry.text}</div>
    );
  }
  if (entry.mine) {
    return (
      <div className="whitespace-pre-wrap break-words py-px pl-4">
        <span className="text-[var(--term-dim)]">you&gt; </span>
        <span>{entry.text}</span>
      </div>
    );
  }
  return (
    <div className="whitespace-pre-wrap break-words py-px">
      <span className="text-[var(--term-brand)]">{entry.name}&gt; </span>
      <span>{entry.text}</span>
    </div>
  );
}

export default function ChatPane({ onClose }: { onClose: () => void }) {
  /* tab: anonymous relay (below, untouched) vs accounts + persistent gcs */
  const [tab, setTab] = useState<ChatTab>(() => {
    if (typeof window === "undefined") return "relay";
    try {
      return localStorage.getItem(GC_AUTH_KEY) ? "gc" : "relay";
    } catch {
      return "relay";
    }
  });

  /* gate state */
  const [draftHandle, setDraftHandle] = useState("");
  const [gateError, setGateError] = useState<string | null>(null);

  /* room state */
  const [conn, setConn] = useState<ConnState>("connecting");
  const [me, setMe] = useState<UserEntry | null>(null);
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [activeRoom, setActiveRoom] = useState<string>("global");
  /** roomId -> log (each log lives only as long as the page does) */
  const [logs, setLogs] = useState<Record<string, LogEntry[]>>({});
  /** roomId -> latest typer */
  const [typing, setTyping] = useState<Record<string, string>>({});
  /** rooms with traffic you haven't looked at */
  const [unread, setUnread] = useState<Record<string, boolean>>({});
  const [draft, setDraft] = useState("");
  const [creatingGc, setCreatingGc] = useState(false);
  const [gcName, setGcName] = useState("");
  const [gcPrivate, setGcPrivate] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [error, setError] = useState<string | null>(null);

  /* refs */
  const transportRef = useRef<ChatTransport | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const gateFormRef = useRef<HTMLFormElement | null>(null);
  const stickRef = useRef(true);
  const typingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTypingSentRef = useRef(0);
  const mineIdsRef = useRef<ReadonlySet<string>>(new Set());
  const keyCounterRef = useRef(0);
  const activeRoomRef = useRef<string>("global");
  activeRoomRef.current = activeRoom;
  const draftRef = useRef("");
  draftRef.current = draft;

  const nextKey = useCallback(() => {
    keyCounterRef.current += 1;
    return `l${keyCounterRef.current}`;
  }, []);

  const pushEntry = useCallback(
    (roomId: string, entry: NewLogEntry) => {
      setLogs((prev) => {
        const list = prev[roomId] ?? [];
        const next: LogEntry[] = [
          ...list,
          { ...entry, key: `r${roomId}-${nextKey()}` } as LogEntry,
        ];
        return {
          ...prev,
          [roomId]: next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next,
        };
      });
    },
    [nextKey],
  );

  /* mount-free handle adoption: read sessionStorage lazily, once */
  const [handle, setHandle] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(CHAT_NAME_KEY);
      return typeof raw === "string" ? sanitizeHandle(raw) || null : null;
    } catch {
      return null;
    }
  });

  /*
   * The transport lives exactly as long as `handle` does. Sync failures
   * keep polling ("offline"); an "unknown-client" reply (server restarted
   * or the sweeper ate us) makes it re-join with the stored handle — which
   * is what makes rejoin automatic, same as socket.io used to.
   */
  useEffect(() => {
    if (!handle) return;
    let disposed = false;

    const transport = new ChatTransport({
      onState: (s) => {
        if (disposed) return;
        setConn(s);
        if (s === "offline") setTyping({});
      },
      onJoined: (ack) => {
        if (disposed) return;
        if (ack.ok !== true || !isUser(ack.me) || !Array.isArray(ack.users)) return;
        mineIdsRef.current = new Set(mineIdsRef.current).add(ack.me.id);
        setMe(ack.me);
        setUsers(ack.users.filter(isUser));
        if (Array.isArray(ack.rooms)) {
          const list = ack.rooms.filter(isRoom);
          setRooms(list);
          setActiveRoom((cur) => (list.some((r) => r.id === cur) ? cur : "global"));
        }
      },
      onUsers: (list) => {
        if (disposed) return;
        setUsers(list.filter(isUser));
      },
      onRooms: (list) => {
        if (disposed) return;
        const next = list.filter(isRoom);
        setRooms(next);
        setActiveRoom((cur) => (next.some((r) => r.id === cur) ? cur : "global"));
      },
      onEvent: (e) => {
        if (disposed) return;
        if (e.type === "msg") {
          const room = typeof e.room === "string" ? e.room : "global";
          const from = typeof e.from === "string" ? e.from : "";
          const name = typeof e.name === "string" ? e.name : "";
          const text = typeof e.text === "string" ? e.text : "";
          if (!from || !name || !text) return;
          pushEntry(room, { kind: "msg", mine: mineIdsRef.current.has(from), name, text });
          if (room !== activeRoomRef.current) setUnread((u) => ({ ...u, [room]: true }));
        } else if (e.type === "sys") {
          const room = typeof e.room === "string" ? e.room : "global";
          const text = typeof e.text === "string" ? e.text : "";
          if (!text) return;
          pushEntry(room, { kind: "sys", text });
        } else if (e.type === "typing") {
          const room = typeof e.room === "string" ? e.room : "global";
          const name = typeof e.name === "string" ? e.name : "";
          if (!name) return;
          setTyping((t) => ({ ...t, [room]: name }));
          const timers = typingTimersRef.current;
          const prev = timers.get(room);
          if (prev) clearTimeout(prev);
          timers.set(
            room,
            setTimeout(() => {
              timers.delete(room);
              setTyping((t) => {
                const { [room]: _gone, ...rest } = t;
                return rest;
              });
            }, TYPING_VISIBLE_MS),
          );
        }
      },
    });
    transportRef.current = transport;
    transport.join(handle);

    return () => {
      disposed = true;
      transport.close();
      if (transportRef.current === transport) transportRef.current = null;
      for (const t of typingTimersRef.current.values()) clearTimeout(t);
      typingTimersRef.current.clear();
    };
  }, [handle, pushEntry]);

  const activeRoomInfo = useMemo(
    () => rooms.find((r) => r.id === activeRoom) ?? null,
    [rooms, activeRoom],
  );
  const activeLog = logs[activeRoom] ?? [];
  const activeTyping = typing[activeRoom] ?? null;

  /* sticky-bottom autoscroll: follow new lines unless the reader scrolled up */
  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [activeLog, activeTyping]);

  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  }, []);

  /* gate submit — blank joins as anon (server default), exactly as promised */
  const submitHandle = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const clean = sanitizeHandle(draftHandle) || "anon";
      try {
        sessionStorage.setItem(CHAT_NAME_KEY, clean);
      } catch {
        /* private mode — join anyway, the name just won't survive a refresh */
      }
      setGateError(null);
      setDraftHandle("");
      setHandle(clean);
    },
    [draftHandle],
  );

  /* [rename]: wipe the handle and everything room-shaped; back to the gate */
  const rename = useCallback(() => {
    transportRef.current?.close();
    transportRef.current = null;
    try {
      sessionStorage.removeItem(CHAT_NAME_KEY);
    } catch {
      /* ignore */
    }
    mineIdsRef.current = new Set();
    setMe(null);
    setUsers([]);
    setRooms([]);
    setLogs({});
    setTyping({});
    setUnread({});
    setActiveRoom("global");
    setConn("connecting");
    setHandle(null);
  }, []);

  /* [leave]: walk out of a gc — server buries it if we were the last one in */
  const leaveGc = useCallback((roomId: string) => {
    const transport = transportRef.current;
    if (!transport) return;
    transport.leave(roomId, (ack) => {
      if (ack.ok !== true) {
        setError(ack.error ?? "can't leave that");
        return;
      }
      setError(null);
      setLogs((prev) => {
        const { [roomId]: _gone, ...rest } = prev;
        return rest;
      });
      setUnread((u) => {
        const { [roomId]: _dip, ...rest } = u;
        return rest;
      });
      setActiveRoom((cur) => (cur === roomId ? "global" : cur));
      stickRef.current = true;
    });
  }, []);

  const openRoom = useCallback(
    (roomId: string) => {
      if (roomId === activeRoomRef.current) return;
      const transport = transportRef.current;
      const room = rooms.find((r) => r.id === roomId);
      if (transport && room?.kind === "gc") {
        transport.joinRoom(roomId, (ack) => {
          if (ack.ok !== true) {
            setError(ack.error ?? "can't join that");
            return;
          }
        });
      }
      setActiveRoom(roomId);
      setUnread((u) => ({ ...u, [roomId]: false }));
      stickRef.current = true;
    },
    [rooms],
  );

  const openDm = useCallback((userId: string) => {
    const transport = transportRef.current;
    if (!transport) return;
    transport.dm(userId, (ack) => {
      if (ack.ok !== true || !ack.roomId) {
        setError(ack.error ?? "dm failed");
        return;
      }
      setError(null);
      setActiveRoom(ack.roomId);
      setUnread((u) => ({ ...u, [ack.roomId as string]: false }));
      stickRef.current = true;
    });
  }, []);

  const createGc = useCallback(() => {
    const name = gcName.trim().slice(0, 24);
    const transport = transportRef.current;
    if (!transport) return;
    if (!name) {
      setCreatingGc(false);
      setGcName("");
      setGcPrivate(false);
      return;
    }
    transport.gc(name, gcPrivate, (ack) => {
      if (ack.ok !== true || !ack.room) {
        setError(ack.error ?? "group failed");
        return;
      }
      setError(null);
      setCreatingGc(false);
      setGcName("");
      setGcPrivate(false);
      setActiveRoom(ack.room.id);
      stickRef.current = true;
    });
  }, [gcName, gcPrivate]);

  /** private gc, admin: manually add a person by handle */
  const addToGc = useCallback((roomId: string) => {
    const name = inviteName.trim();
    const transport = transportRef.current;
    if (!transport || !name) return;
    transport.gcAdd(roomId, name, (ack) => {
      if (ack.ok !== true) {
        setError(ack.error ?? "add failed");
        return;
      }
      setError(null);
      setInviteName("");
    });
  }, [inviteName]);

  /** private gc, admin: cast someone out */
  const kickFrom = useCallback((roomId: string, name: string) => {
    transportRef.current?.gcKick(roomId, name, (ack) => {
      if (ack.ok !== true) setError(ack.error ?? "kick failed");
      else setError(null);
    });
  }, []);

  /** admin buries the room outright */
  const buryGc = useCallback((roomId: string) => {
    transportRef.current?.bury(roomId, (ack) => {
      if (ack.ok !== true) {
        setError(ack.error ?? "bury failed");
        return;
      }
      setError(null);
      setLogs((prev) => {
        const { [roomId]: _gone, ...rest } = prev;
        return rest;
      });
      setUnread((u) => {
        const { [roomId]: _dip, ...rest } = u;
        return rest;
      });
      setActiveRoom((cur) => (cur === roomId ? "global" : cur));
    });
  }, []);

  /* no local append — the relay echoes our own msg back via sync, us included */
  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    const transport = transportRef.current;
    if (!transport) return;
    transport.msg(activeRoomRef.current, text);
    setDraft("");
  }, [draft]);

  const onDraftChange = useCallback((value: string) => {
    setDraft(value);
    const transport = transportRef.current;
    if (!transport || !transport.connected || !value.trim()) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_SEND_THROTTLE_MS) return;
    lastTypingSentRef.current = now;
    transport.typing(activeRoomRef.current);
  }, []);

  const onMsgKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  /* ---------- phase 0: accounts tab — login/register + persistent gcs ---------- */
  if (tab === "gc") {
    return <GcPane onClose={onClose} onSwitchRelay={() => setTab("relay")} />;
  }

  /* ---------- phase 1: name gate ---------- */
  if (!handle) {
    return (
      <div className="flex h-full w-full flex-col bg-[var(--glass-bg,var(--term-bg))] font-mono text-sm text-[var(--term-fg)]">
        <div className="flex flex-1 items-center justify-center px-6">
          <form ref={gateFormRef} onSubmit={submitHandle} noValidate className="w-full max-w-xs">
            <div className="mb-6 flex items-center gap-3 text-[10px] uppercase tracking-[0.35em]">
              <span className="text-[var(--term-brand)]">relay</span>
              <button
                type="button"
                onClick={() => setTab("gc")}
                className="cursor-pointer uppercase tracking-[0.35em] text-[var(--term-dim)] transition-colors hover:text-[var(--term-brand)]"
              >
                accounts
              </button>
            </div>
            <label
              htmlFor="murke-chat-handle"
              className="block text-[11px] uppercase tracking-[0.35em] text-[var(--term-brand)]"
            >
              choose your handle
            </label>
            <input
              id="murke-chat-handle"
              autoFocus
              value={draftHandle}
              onChange={(e) => setDraftHandle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
              maxLength={MAX_NAME}
              spellCheck={false}
              autoComplete="off"
              aria-describedby="murke-chat-hint"
              placeholder="anon"
              className="mt-4 w-full border-b bg-transparent pb-1 font-mono text-base outline-none transition-colors border-[color-mix(in_srgb,var(--term-brand)_55%,transparent)] text-[var(--term-fg)] placeholder:text-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] focus:border-[var(--term-brand)]"
            />
            <p id="murke-chat-hint" className="mt-2 text-[10px] text-[var(--term-dim)]">
              {gateError ?? "enter to join · blank = anon · 16 chars max · esc back"}
            </p>
          </form>
        </div>
      </div>
    );
  }

  /* ---------- phase 2: the rooms ---------- */
  const connLabel =
    conn === "connected" ? "connected" : conn === "connecting" ? "connecting" : "offline — reconnecting…";
  const where = activeRoomInfo ? roomLabel(activeRoomInfo) : "#global";

  const sidebarItem =
    "block w-full truncate px-1.5 py-1 text-left text-[12px] transition-colors cursor-pointer";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--glass-bg,var(--term-bg))] font-mono text-xs text-[var(--term-fg)] md:text-sm">
      {/* header strip — identity + close live in the window chrome */}
      <header className={`flex shrink-0 items-center gap-3 border-b px-3 py-1.5 ${BORDER}`}>
        <span className="min-w-0 truncate text-[10px] text-[var(--term-dim)] md:text-xs" aria-live="polite">
          {connLabel} · {where}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab("gc")}
            title="accounts + persistent gcs (saved to github file)"
            className="text-[10px] text-[var(--term-dim)] transition-colors hover:text-[var(--term-fg)] md:text-xs"
          >
            [gc]
          </button>
          <button
            type="button"
            onClick={rename}
            title="change handle"
            className="text-[10px] text-[var(--term-dim)] transition-colors hover:text-[var(--term-fg)] md:text-xs"
          >
            [rename]
          </button>
        </span>
      </header>

      {error && (
        <div className="shrink-0 px-3 py-1 text-[11px] text-[var(--term-err)]">{error}</div>
      )}

      {/* private gc roster strip — invisible rooms, admin-managed membership */}
      {activeRoomInfo?.private && (
        <div className={`flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-[11px] ${BORDER_FAINT}`}>
          <span className="text-[var(--term-brand)]">private</span>
          <span className="text-[var(--term-dim)]">
            {activeRoomInfo.isAdmin ? "you hold the keys —" : "admin:"} {activeRoomInfo.members?.join(", ") || "…"}
          </span>
          {activeRoomInfo.isAdmin && (
            <span className="ml-auto flex items-center gap-1">
              <input
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addToGc(activeRoomInfo.id);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setInviteName("");
                  }
                }}
                placeholder="+ handle"
                maxLength={MAX_NAME}
                spellCheck={false}
                aria-label="add member by handle"
                className="w-24 border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] bg-transparent px-1.5 py-0.5 text-[11px] outline-none placeholder:text-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] focus:border-[color-mix(in_srgb,var(--term-brand)_55%,transparent)]"
              />
              <button
                type="button"
                onClick={() => addToGc(activeRoomInfo.id)}
                title="add this handle to the private room"
                className="cursor-pointer px-1 text-[var(--term-dim)] transition-colors hover:text-[var(--term-brand)]"
              >
                add
              </button>
              {(activeRoomInfo.members ?? [])
                .filter((m) => m.toLowerCase() !== (me?.name.toLowerCase() ?? ""))
                .map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => kickFrom(activeRoomInfo.id, m)}
                    title={`cast out ${m}`}
                    aria-label={`cast out ${m}`}
                    className="cursor-pointer px-0.5 text-[var(--term-dim)] transition-colors hover:text-[var(--term-err)]"
                  >
                    {m}×
                  </button>
                ))}
            </span>
          )}
        </div>
      )}

      {/* body: sidebar 200px on md+, roster row on narrow */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="rooms and people"
          className={`flex shrink-0 items-center gap-x-3 gap-y-1 overflow-x-auto border-b px-3 py-2 md:w-[200px] md:flex-col md:items-stretch md:overflow-x-hidden md:overflow-y-auto md:border-b-0 md:border-r md:px-3 md:py-3 ${BORDER} ${SCROLLBAR}`}
        >
          {/* rooms section */}
          <div className="hidden shrink-0 items-center justify-between md:flex">
            <span className="text-[10px] uppercase tracking-[0.25em] text-[var(--term-dim)]">rooms</span>
            <button
              type="button"
              onClick={() => setCreatingGc(true)}
              title="new group chat"
              aria-label="new group chat"
              className="cursor-pointer px-1 text-[11px] text-[var(--term-dim)] transition-colors hover:text-[var(--term-brand)]"
            >
              +gc
            </button>
          </div>
          {creatingGc && (
            <div className="hidden items-center gap-1 md:flex">
              <input
                autoFocus
                value={gcName}
                onChange={(e) => setGcName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    createGc();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setCreatingGc(false);
                    setGcName("");
                    setGcPrivate(false);
                  }
                }}
                placeholder="#name"
                maxLength={24}
                spellCheck={false}
                aria-label="group name"
                className="min-w-0 flex-1 border-b bg-transparent pb-0.5 text-[12px] outline-none border-[color-mix(in_srgb,var(--term-brand)_45%,transparent)] placeholder:text-[color-mix(in_srgb,var(--term-fg)_25%,transparent)]"
              />
              <button
                type="button"
                onClick={() => setGcPrivate((v) => !v)}
                aria-pressed={gcPrivate}
                title="private — only people you manually add ever see it"
                className={`shrink-0 border px-1 py-0.5 text-[10px] transition-colors ${
                  gcPrivate
                    ? "border-[color-mix(in_srgb,var(--term-brand)_60%,transparent)] text-[var(--term-brand)]"
                    : "border-[color-mix(in_srgb,var(--term-fg)_20%,transparent)] text-[var(--term-dim)] hover:text-[var(--term-fg)]"
                }`}
              >
                pv
              </button>
            </div>
          )}
          {rooms.map((r) => {
            const isActive = r.id === activeRoom;
            const main = (
              <button
                key={r.id}
                type="button"
                onClick={() => openRoom(r.id)}
                className={`${sidebarItem} ${
                  isActive
                    ? "bg-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] text-[var(--term-fg)]"
                    : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"
                }`}
                title={roomLabel(r)}
              >
                {r.kind === "dm" ? "@" : r.kind === "global" ? "▚" : "#"} {roomLabel(r).slice(1)}
                {unread[r.id] && !isActive ? (
                  <span className="ml-1 text-[var(--term-brand)]" aria-hidden="true">●</span>
                ) : null}
                <span className="float-right text-[10px] text-[var(--term-dim)]">{r.count}</span>
              </button>
            );
            if (r.kind !== "gc") return main;
            /* gcs get a leave × (sibling, never nested inside the room button);
               private gcs the admin owns also get a bury ×† (kill outright) */
            return (
              <div key={r.id} className="flex min-w-0 items-center">
                {main}
                {r.private && r.isAdmin && (
                  <button
                    type="button"
                    onClick={() => buryGc(r.id)}
                    title={`bury #${r.name} (delete for everyone)`}
                    aria-label={`bury #${r.name}`}
                    className="shrink-0 px-0.5 text-[11px] text-[var(--term-dim)] transition-colors hover:text-[var(--term-err)]"
                  >
                    †
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => leaveGc(r.id)}
                  title={r.private ? `leave #${r.name} (the admin must re-add you)` : `leave #${r.name}`}
                  aria-label={`leave #${r.name}`}
                  className="shrink-0 px-1 text-[11px] text-[var(--term-dim)] transition-colors hover:text-[var(--term-err)]"
                >
                  ×
                </button>
              </div>
            );
          })}

          {/* online section */}
          <span className="hidden shrink-0 whitespace-nowrap pt-2 text-[10px] uppercase tracking-[0.25em] text-[var(--term-dim)] md:block">
            online — {users.length} <span className="normal-case tracking-normal">(click to dm)</span>
          </span>
          {users.map((u) => {
            const mine = me !== null && u.id === me.id;
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => !mine && openDm(u.id)}
                title={mine ? "you" : `dm @${u.name}`}
                className={`${sidebarItem} ${mine ? "cursor-default text-[var(--term-dim)]" : "text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]"}`}
              >
                <span className="text-[var(--term-brand)]" aria-hidden="true">▪</span> {u.name}
                {mine ? " (you)" : ""}
              </button>
            );
          })}
        </nav>

        {/* main column: log / typing / speak / footer */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            ref={logRef}
            onScroll={onLogScroll}
            className={`min-h-0 flex-1 overflow-y-auto px-3 py-2 leading-relaxed ${SCROLLBAR}`}
          >
            {activeLog.length === 0 ? (
              <p className="py-1 text-[var(--term-dim)]">
                <span className="text-[var(--term-hi)]">▚</span> {where} is silent — speak and it lives
              </p>
            ) : null}
            {activeLog.map((entry) => (
              <LogLine key={entry.key} entry={entry} />
            ))}
          </div>

          <div className="h-5 shrink-0 px-3 text-[10px] text-[var(--term-dim)] md:text-xs">
            {activeTyping ? (
              <span aria-live="polite">
                {activeTyping} is typing
                <span className="ml-0.5 inline-block">
                  <span className="inline-block animate-bounce [animation-delay:0ms]">.</span>
                  <span className="inline-block animate-bounce [animation-delay:150ms]">.</span>
                  <span className="inline-block animate-bounce [animation-delay:300ms]">.</span>
                </span>
              </span>
            ) : null}
          </div>

          <div className={`flex shrink-0 items-center gap-2 border-t px-3 py-2 ${BORDER}`}>
            <span className="shrink-0 text-[var(--term-dim)]">speak&gt;</span>
            <input
              autoFocus
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={onMsgKeyDown}
              spellCheck={false}
              autoComplete="off"
              aria-label="chat message"
              placeholder="…"
              className="min-w-0 flex-1 bg-transparent outline-none text-[var(--term-fg)] placeholder:text-[color-mix(in_srgb,var(--term-fg)_25%,transparent)]"
            />
          </div>

          <footer
            className={`shrink-0 border-t px-3 py-1 text-[10px] text-[var(--term-dim)] ${BORDER_FAINT}`}
          >
            enter send · esc back · click a name to dm · +gc opens a group (pv = private, admin adds people) · × leaves · † buries · logs vanish on refresh
          </footer>
        </div>
      </div>
    </div>
  );
}
