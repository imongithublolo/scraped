"use client";

/**
 * GcPane — the ACCOUNT side of the chat: register/login, persistent GCs and
 * message history. Everything flows through /api/chat/{auth,rooms,messages}
 * and lives in JSON files (murke-chat/accounts.json + messages.json) via the
 * server's gitHubStore — GitHub Contents API when GITHUB_TOKEN is set, an
 * identical sqlite KV mirror when not. Session = token+username in
 * localStorage; the server keeps token→user (30d expiry) inside accounts.json.
 *
 * Mounted by ChatPane under the "gc" tab; the anonymous relay tab is untouched.
 * Polling only — rooms every 6s, active room messages every 3s (no websockets).
 * Pure theme vars: --term-bg/fg/dim/hi/brand/err. No gradients, no blues.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** localStorage key holding { token, username } — ChatPane also reads it to pick the default tab. */
export const GC_AUTH_KEY = "murke.chat.account";
const AUTH_KEY = GC_AUTH_KEY;
const BORDER = "border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)]";
const BORDER_FAINT = "border-[color-mix(in_srgb,var(--term-fg)_15%,transparent)]";
const SCROLLBAR =
  "[scrollbar-width:thin] [scrollbar-color:color-mix(in_srgb,var(--term-fg)_30%,transparent)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--term-fg)_25%,transparent)]";

interface Session {
  token: string;
  username: string;
}

interface GcInfo {
  id: string;
  name: string;
  creator: string;
  created: number;
  count: number;
  joined: boolean;
}

interface GcMsg {
  id: string;
  from: string;
  name: string;
  text: string;
  ts: number;
}

type Mode = "github" | "local";

const ROOMS_EVERY_MS = 6000;
const MSGS_EVERY_MS = 3000;

async function chatApi(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    /* non-json error page — body stays empty */
  }
  return { status: res.status, body };
}

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const obj: unknown = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return null;
    const { token, username } = obj as Record<string, unknown>;
    if (typeof token !== "string" || typeof username !== "string") return null;
    return { token, username };
  } catch {
    return null;
  }
}

function writeSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(AUTH_KEY, JSON.stringify(s));
    else localStorage.removeItem(AUTH_KEY);
  } catch {
    /* private mode — session just won't survive a refresh */
  }
}

const fieldCls =
  "w-full border-b bg-transparent pb-1 font-mono text-base outline-none transition-colors border-[color-mix(in_srgb,var(--term-brand)_55%,transparent)] text-[var(--term-fg)] placeholder:text-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] focus:border-[var(--term-brand)]";
const smallFieldCls =
  "min-w-0 flex-1 border-b bg-transparent pb-0.5 text-[12px] outline-none border-[color-mix(in_srgb,var(--term-brand)_45%,transparent)] placeholder:text-[color-mix(in_srgb,var(--term-fg)_25%,transparent)]";
const ghostBtn =
  "cursor-pointer text-[11px] text-[var(--term-dim)] transition-colors hover:text-[var(--term-brand)] md:text-xs";

export default function GcPane({ onClose, onSwitchRelay }: { onClose: () => void; onSwitchRelay: () => void }) {
  const [phase, setPhase] = useState<"boot" | "gate" | "in">("boot");
  const [session, setSession] = useState<Session | null>(null);
  const [display, setDisplay] = useState("");
  const [mode, setMode] = useState<Mode | null>(null);

  /* gate fields */
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [gateBusy, setGateBusy] = useState(false);

  /* rooms + thread */
  const [rooms, setRooms] = useState<GcInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<GcMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [gcName, setGcName] = useState("");
  const [joinName, setJoinName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  const msgsRef = useRef<GcMsg[]>([]);
  msgsRef.current = msgs;

  /* ---------- boot: storage mode + stored session ---------- */
  useEffect(() => {
    let dead = false;
    void chatApi("/api/chat/status").then(({ body }) => {
      if (dead) return;
      if (body.mode === "github" || body.mode === "local") setMode(body.mode);
    });
    const stored = readSession();
    if (!stored) {
      setPhase("gate");
      return;
    }
    void chatApi("/api/chat/auth", {
      method: "POST",
      body: JSON.stringify({ op: "me", token: stored.token }),
    }).then(({ status, body }) => {
      if (dead) return;
      if (status === 200 && body.ok === true) {
        setSession(stored);
        setDisplay(typeof body.display === "string" ? body.display : stored.username);
        setPhase("in");
      } else {
        writeSession(null);
        setPhase("gate");
      }
    });
    return () => {
      dead = true;
    };
  }, []);

  const expire = useCallback((msg: string) => {
    writeSession(null);
    setSession(null);
    setRooms([]);
    setMsgs([]);
    setActiveId(null);
    setError(msg);
    setPhase("gate");
  }, []);

  /* ---------- rooms polling (6s) ---------- */
  useEffect(() => {
    if (phase !== "in" || !session) return;
    let dead = false;
    const pull = async (): Promise<void> => {
      const s = sessionRef.current;
      if (!s) return;
      try {
        const { status, body } = await chatApi(`/api/chat/rooms?token=${encodeURIComponent(s.token)}`);
        if (dead) return;
        if (status === 401) {
          expire("session expired — log in again");
          return;
        }
        if (body.ok === true && Array.isArray(body.rooms)) {
          setRooms(body.rooms as GcInfo[]);
        }
      } catch {
        /* offline — keep polling */
      }
    };
    void pull();
    const t = setInterval(() => void pull(), ROOMS_EVERY_MS);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [phase, session, expire]);

  /* ---------- messages polling for the open room (3s, since=last ts) ---------- */
  useEffect(() => {
    if (phase !== "in" || !session || !activeId) return;
    let dead = false;
    setMsgs([]);
    const pull = async (): Promise<void> => {
      const s = sessionRef.current;
      const room = activeRef.current;
      if (!s || !room) return;
      try {
        // payload stays small: first open pulls the kept log, later polls ask
        // only for ts > last seen
        const cur = msgsRef.current;
        const since = cur.length > 0 ? cur[cur.length - 1].ts : undefined;
        const { status, body } = await chatApi(
          `/api/chat/messages?room=${encodeURIComponent(room)}&token=${encodeURIComponent(s.token)}${
            since !== undefined ? `&since=${since}` : ""
          }`,
        );
        if (dead) return;
        if (status === 401) {
          expire("session expired — log in again");
          return;
        }
        if (body.ok === true && Array.isArray(body.messages)) {
          const incoming = body.messages as GcMsg[];
          setMsgs((prev) => {
            const map = new Map(prev.map((m) => [m.id, m]));
            for (const m of incoming) map.set(m.id, m);
            const merged = [...map.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
            return merged.length > 200 ? merged.slice(merged.length - 200) : merged;
          });
        }
      } catch {
        /* offline — keep polling */
      }
    };
    void pull();
    const t = setInterval(() => void pull(), MSGS_EVERY_MS);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [phase, session, activeId, expire]);

  /* sticky bottom autoscroll, same contract as the relay log */
  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  }, []);

  /* ---------- auth actions ---------- */
  const submitGate = useCallback(
    async (op: "login" | "register") => {
      if (gateBusy) return;
      const username = name.trim().toLowerCase();
      if (!/^[a-z0-9_-]{3,16}$/.test(username)) {
        setError("name: 3-16 chars, a-z 0-9 _ -");
        return;
      }
      if (pass.length < 4) {
        setError("password: 4+ chars");
        return;
      }
      setGateBusy(true);
      setError(null);
      try {
        const { status, body } = await chatApi("/api/chat/auth", {
          method: "POST",
          body: JSON.stringify({ op, username, password: pass }),
        });
        if (body.ok === true && typeof body.token === "string") {
          const s = { token: body.token, username };
          writeSession(s);
          setSession(s);
          setDisplay(typeof body.display === "string" ? body.display : username);
          setName("");
          setPass("");
          setPhase("in");
        } else {
          setError(typeof body.error === "string" ? body.error : `${op} failed (${status})`);
        }
      } catch {
        setError("network dead — try again");
      } finally {
        setGateBusy(false);
      }
    },
    [gateBusy, name, pass],
  );

  const logout = useCallback(async () => {
    const s = sessionRef.current;
    if (s) {
      try {
        await chatApi("/api/chat/auth", { method: "POST", body: JSON.stringify({ op: "logout", token: s.token }) });
      } catch {
        /* best effort — local session dies regardless */
      }
    }
    writeSession(null);
    setSession(null);
    setDisplay("");
    setRooms([]);
    setMsgs([]);
    setActiveId(null);
    setError(null);
    setPhase("gate");
  }, []);

  /* ---------- room actions ---------- */
  const openRoom = useCallback(
    async (room: GcInfo) => {
      const s = sessionRef.current;
      if (!s) return;
      if (!room.joined) {
        try {
          const { body } = await chatApi("/api/chat/rooms", {
            method: "POST",
            body: JSON.stringify({ op: "join", token: s.token, name: room.name }),
          });
          if (body.ok !== true) {
            setError(typeof body.error === "string" ? body.error : "join failed");
            return;
          }
        } catch {
          setError("join failed — network dead");
          return;
        }
      }
      setError(null);
      stickRef.current = true;
      setActiveId(room.id);
    },
    [],
  );

  const createRoom = useCallback(async () => {
    const s = sessionRef.current;
    const nm = gcName.trim().slice(0, 24);
    if (!s) return;
    if (!nm) {
      setCreating(false);
      setGcName("");
      return;
    }
    try {
      const { body } = await chatApi("/api/chat/rooms", {
        method: "POST",
        body: JSON.stringify({ op: "create", token: s.token, name: nm }),
      });
      if (body.ok === true && typeof body.room === "object" && body.room !== null) {
        const room = body.room as { id: string; name: string };
        setCreating(false);
        setGcName("");
        setError(null);
        stickRef.current = true;
        setActiveId(room.id);
      } else {
        setError(typeof body.error === "string" ? body.error : "group failed");
      }
    } catch {
      setError("group failed — network dead");
    }
  }, [gcName]);

  const joinRoomByName = useCallback(async () => {
    const s = sessionRef.current;
    const nm = joinName.trim().slice(0, 24);
    if (!s || !nm) return;
    try {
      const { body } = await chatApi("/api/chat/rooms", {
        method: "POST",
        body: JSON.stringify({ op: "join", token: s.token, name: nm }),
      });
      if (body.ok === true && typeof body.room === "object" && body.room !== null) {
        const room = body.room as { id: string; name: string };
        setJoinName("");
        setError(null);
        stickRef.current = true;
        setActiveId(room.id);
      } else {
        setError(typeof body.error === "string" ? body.error : "no such room");
      }
    } catch {
      setError("join failed — network dead");
    }
  }, [joinName]);

  /* ---------- speak ---------- */
  const send = useCallback(async () => {
    const s = sessionRef.current;
    const room = activeRef.current;
    const text = draft.trim();
    if (!s || !room || !text) return;
    try {
      const { status, body } = await chatApi("/api/chat/messages", {
        method: "POST",
        body: JSON.stringify({ token: s.token, room, text }),
      });
      if (status === 401) {
        expire("session expired — log in again");
        return;
      }
      if (body.ok === true && typeof body.message === "object" && body.message !== null) {
        const m = body.message as GcMsg;
        setMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
        setDraft("");
        setError(null);
      } else {
        setError(typeof body.error === "string" ? body.error : "message failed");
      }
    } catch {
      setError("message failed — network dead");
    }
  }, [draft, expire]);

  const onKeyDownDraft = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const modeBadge = mode === null ? "…" : mode;

  /* ---------- phase: gate (register / login) ---------- */
  if (phase !== "in") {
    return (
      <div className="flex h-full w-full flex-col bg-[var(--term-bg)] font-mono text-sm text-[var(--term-fg)]">
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="w-full max-w-xs">
            <div className="mb-6 flex items-center gap-3 text-[10px] uppercase tracking-[0.35em]">
              <button type="button" onClick={onSwitchRelay} className={`${ghostBtn} uppercase tracking-[0.35em]`}>
                relay
              </button>
              <span className="text-[var(--term-brand)]">accounts</span>
              <span className="ml-auto text-[var(--term-dim)]">[{modeBadge}]</span>
            </div>
            {phase === "boot" ? (
              <p className="text-[12px] text-[var(--term-dim)]">checking session…</p>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitGate("login");
                }}
                noValidate
              >
                <label
                  htmlFor="murke-chat-account-name"
                  className="block text-[11px] uppercase tracking-[0.35em] text-[var(--term-brand)]"
                >
                  murke handle
                </label>
                <input
                  id="murke-chat-account-name"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={16}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="chat account username"
                  placeholder="a-z 0-9 _ -"
                  className={`mt-4 ${fieldCls}`}
                />
                <label
                  htmlFor="murke-chat-account-pass"
                  className="mt-5 block text-[11px] uppercase tracking-[0.35em] text-[var(--term-brand)]"
                >
                  password
                </label>
                <input
                  id="murke-chat-account-pass"
                  type="password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      onClose();
                    }
                  }}
                  maxLength={128}
                  autoComplete="off"
                  aria-label="chat account password"
                  placeholder="4+ chars, hashed (scrypt)"
                  className={`mt-4 ${fieldCls}`}
                />
                <div className="mt-6 flex items-center gap-4">
                  <button
                    type="submit"
                    disabled={gateBusy}
                    className="cursor-pointer border px-3 py-1 text-[11px] uppercase tracking-[0.25em] transition-colors border-[color-mix(in_srgb,var(--term-brand)_55%,transparent)] text-[var(--term-brand)] hover:bg-[color-mix(in_srgb,var(--term-brand)_15%,transparent)] disabled:opacity-50"
                  >
                    login
                  </button>
                  <button
                    type="button"
                    disabled={gateBusy}
                    onClick={() => void submitGate("register")}
                    className="cursor-pointer border px-3 py-1 text-[11px] uppercase tracking-[0.25em] transition-colors border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] text-[var(--term-dim)] hover:border-[var(--term-fg)] hover:text-[var(--term-fg)] disabled:opacity-50"
                  >
                    register
                  </button>
                </div>
                <p className="mt-3 min-h-4 text-[10px] text-[var(--term-err)]" role="alert">
                  {error ?? ""}
                </p>
              </form>
            )}
            <p className="mt-6 text-[10px] leading-relaxed text-[var(--term-dim)]">
              accounts + gcs + history persist in files
              {mode === "local" ? " (local mirror — GITHUB_TOKEN missing)" : " in github · murke-chat/*.json"} · esc
              back
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- phase: in — persistent gcs ---------- */
  const activeRoom = rooms.find((r) => r.id === activeId) ?? null;
  const where = activeRoom ? `#${activeRoom.name}` : "no room open";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--term-bg)] font-mono text-xs text-[var(--term-fg)] md:text-sm">
      <header className={`flex shrink-0 items-center gap-3 border-b px-3 py-1.5 ${BORDER}`}>
        <span className="font-bold tracking-[0.3em] text-[var(--term-brand)]">chat</span>
        <span className="min-w-0 truncate text-[10px] text-[var(--term-dim)] md:text-xs" aria-live="polite">
          {where} · {display || session?.username} · [{modeBadge}]
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onSwitchRelay} title="anonymous relay" className={ghostBtn}>
            [relay]
          </button>
          <button type="button" onClick={() => void logout()} title="log out" className={ghostBtn}>
            [logout]
          </button>
        </span>
      </header>

      {error && <div className="shrink-0 px-3 py-1 text-[11px] text-[var(--term-err)]">{error}</div>}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="persistent groups"
          className={`flex shrink-0 items-center gap-x-3 gap-y-1 overflow-x-auto border-b px-3 py-2 md:w-[220px] md:flex-col md:items-stretch md:overflow-x-hidden md:overflow-y-auto md:border-b-0 md:border-r md:px-3 md:py-3 ${BORDER} ${SCROLLBAR}`}
        >
          <div className="hidden shrink-0 items-center justify-between md:flex">
            <span className="text-[10px] uppercase tracking-[0.25em] text-[var(--term-dim)]">gcs</span>
            <button
              type="button"
              onClick={() => setCreating(true)}
              title="new persistent group"
              aria-label="new persistent group"
              className={ghostBtn}
            >
              +gc
            </button>
          </div>
          {creating && (
            <div className="hidden items-center gap-1 md:flex">
              <input
                autoFocus
                value={gcName}
                onChange={(e) => setGcName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void createRoom();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setCreating(false);
                    setGcName("");
                  }
                }}
                placeholder="#name"
                maxLength={24}
                spellCheck={false}
                aria-label="persistent group name"
                className={smallFieldCls}
              />
            </div>
          )}
          {rooms.length === 0 && (
            <span className="hidden px-1 py-1 text-[11px] text-[var(--term-dim)] md:block">
              no gcs yet — +gc opens one
            </span>
          )}
          {rooms.map((r) => {
            const isActive = r.id === activeId;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => void openRoom(r)}
                title={`#${r.name} · by ${r.creator} · ${r.count} members`}
                className={`block w-full truncate px-1.5 py-1 text-left text-[12px] transition-colors cursor-pointer ${
                  isActive
                    ? "bg-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] text-[var(--term-fg)]"
                    : r.joined
                      ? "text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)]"
                      : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"
                }`}
              >
                <span className={r.joined ? "text-[var(--term-brand)]" : ""} aria-hidden="true">
                  {r.joined ? "#" : "+"}
                </span>{" "}
                {r.name}
                <span className="float-right text-[10px] text-[var(--term-dim)]">{r.count}</span>
              </button>
            );
          })}
          <div className="hidden items-center gap-1 pt-1 md:flex">
            <input
              value={joinName}
              onChange={(e) => setJoinName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void joinRoomByName();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setJoinName("");
                }
              }}
              placeholder="join #name"
              maxLength={24}
              spellCheck={false}
              aria-label="join gc by name"
              className={smallFieldCls}
            />
            <button type="button" onClick={() => void joinRoomByName()} title="join by name" className={ghostBtn}>
              →
            </button>
          </div>
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            ref={logRef}
            onScroll={onLogScroll}
            className={`min-h-0 flex-1 overflow-y-auto px-3 py-2 leading-relaxed ${SCROLLBAR}`}
          >
            {!activeRoom ? (
              <p className="py-1 text-[var(--term-dim)]">
                <span className="text-[var(--term-hi)]">▚</span> pick a gc on the left — or +gc / join #name
              </p>
            ) : msgs.length === 0 ? (
              <p className="py-1 text-[var(--term-dim)]">
                <span className="text-[var(--term-hi)]">▚</span> #{activeRoom.name} is silent — history lives here
                forever (last 200)
              </p>
            ) : null}
            {msgs.map((m) => {
              const mine = m.from === session?.username;
              return (
                <div key={m.id} className={mine ? "whitespace-pre-wrap break-words py-px pl-4" : "whitespace-pre-wrap break-words py-px"}>
                  <span className={mine ? "text-[var(--term-dim)]" : "text-[var(--term-brand)]"}>
                    {mine ? "you> " : `${m.name}> `}
                  </span>
                  <span>{m.text}</span>
                </div>
              );
            })}
          </div>

          <div className={`flex shrink-0 items-center gap-2 border-t px-3 py-2 ${BORDER}`}>
            <span className="shrink-0 text-[var(--term-dim)]">speak&gt;</span>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDownDraft}
              spellCheck={false}
              autoComplete="off"
              aria-label="gc message"
              placeholder={activeRoom ? "…" : "open a gc first"}
              disabled={!activeRoom}
              className="min-w-0 flex-1 bg-transparent outline-none text-[var(--term-fg)] placeholder:text-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] disabled:opacity-50"
            />
          </div>

          <footer className={`shrink-0 border-t px-3 py-1 text-[10px] text-[var(--term-dim)] ${BORDER_FAINT}`}>
            logged-in only · gcs + history saved to {mode === "local" ? "local mirror" : "github file"} · +gc opens ·
            +name joins · 3s polling · esc back
          </footer>
        </div>
      </div>
    </div>
  );
}
