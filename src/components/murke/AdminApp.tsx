"use client";

/**
 * AdminApp — opens ONLY from the terminal (`admin` + the permanent pwd).
 * The token lives in sessionStorage, so the panel is temporary by design:
 * close the tab and the session is gone.
 *
 * Dense on purpose — every pixel is info or an action:
 *   users        live sessions: ip · device · activity · searches · files,
 *                per-row actions [view] [files] [kick] [ban]
 *   view         their screen, live-ish frames; your cursor rides their
 *                screen (green rounded), click to click, notice to flash
 *   files        their file system, live: browse · read · edit · write ·
 *                mkdir · delete — executed on their machine via the 1s
 *                control poll and answered back over /api/admin/fs
 *   site         lockdown switch · gate password · ban list w/ unban
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { ADMIN_SESSION_KEY } from "@/lib/murke/commands";

interface PresenceUser {
  id: string;
  ip: string;
  ua: string;
  firstSeen: number;
  lastSeen: number;
  history: Array<{ t: string; u: string }>;
  files: Array<{ p: string; s?: number }>;
  screen?: string;
  screenAt?: number;
  activity?: string;
}

interface SiteBan {
  ip: string;
  id: string;
  at: number;
  by: string;
}

interface UsersPayload {
  users?: PresenceUser[];
  bans?: SiteBan[];
  lockdown?: boolean;
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function uaShort(ua: string): string {
  const browser = /Edg\//.test(ua) ? "edge" : /OPR\//.test(ua) ? "opera" : /Chrome\//.test(ua) ? "chrome" : /Safari\//.test(ua) ? "safari" : /Firefox\//.test(ua) ? "firefox" : "browser";
  const os = /Android/.test(ua) ? "android" : /iPhone|iPad/.test(ua) ? "ios" : /Windows/.test(ua) ? "windows" : /Mac OS/.test(ua) ? "mac" : /Linux/.test(ua) ? "linux" : "device";
  return `${browser}·${os}`;
}

async function post(token: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; banned?: string; rid?: string }> {
  try {
    const res = await fetch("/api/admin/control", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => null)) as { error?: string; banned?: string; rid?: string } | null;
    return { ok: res.ok, error: j?.error, banned: j?.banned, rid: j?.rid };
  } catch {
    return { ok: false, error: "no answer" };
  }
}

export default function AdminApp() {
  const [token, setToken] = useState<string | null>(null);
  const [pwd, setPwd] = useState("");
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [authing, setAuthing] = useState(false);

  /* ---------- auth ---------- */

  useEffect(() => {
    try {
      const t = sessionStorage.getItem(ADMIN_SESSION_KEY);
      if (t) setToken(t);
    } catch {
      /* ignore */
    }
  }, []);

  const reauth = async () => {
    if (!pwd.trim() || authing) return;
    setAuthing(true);
    setAuthErr(null);
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pwd: pwd.trim() }),
      });
      const j = (await res.json().catch(() => null)) as { token?: string } | null;
      if (res.ok && j?.token) {
        try {
          sessionStorage.setItem(ADMIN_SESSION_KEY, j.token);
        } catch {
          /* ignore */
        }
        setToken(j.token);
        setPwd("");
      } else {
        setAuthErr("denied — that is not the permanent pwd");
      }
    } catch {
      setAuthErr("the server did not answer");
    } finally {
      setAuthing(false);
    }
  };

  if (!token) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--term-bg)] p-6">
        <div className="w-full max-w-xs">
          <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.3em] text-[var(--term-dim)]">
            <ShieldCheck size={14} aria-hidden="true" /> admin access
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void reauth();
            }}
          >
            <input
              type="text"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              placeholder="permanent pwd"
              aria-label="permanent admin pwd"
              disabled={authing}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className={`w-full border bg-transparent px-2 py-1.5 font-mono text-[12px] text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)] focus:border-[var(--term-brand)] ${"border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)]"}`}
              style={{ WebkitTextSecurity: "disc" } as React.CSSProperties}
            />
            <button
              type="submit"
              disabled={authing || !pwd.trim()}
              className="mt-2 w-full cursor-pointer border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] py-1.5 font-mono text-[11.5px] text-[var(--term-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] disabled:opacity-40"
            >
              {authing ? "checking…" : "unlock"}
            </button>
          </form>
          {authErr && <p className="mt-2 font-mono text-[10.5px] text-[var(--term-err)]">{authErr}</p>}
        </div>
      </div>
    );
  }

  return <AdminPanel token={token} />;
}

/* ================= the panel ================= */

function AdminPanel({ token }: { token: string }) {
  const [section, setSection] = useState<"users" | "site">("users");
  const [viewing, setViewing] = useState<string | null>(null); // user id on the view screen
  const [fileUser, setFileUser] = useState<string | null>(null); // user id in the fs browser
  const [data, setData] = useState<UsersPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/users", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const j = (await res.json().catch(() => null)) as UsersPayload | null;
      if (!res.ok || !j) throw new Error(`status ${res.status}`);
      setData(j);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "poll failed");
    }
  }, [token]);

  useEffect(() => {
    void load();
    const iv = window.setInterval(() => void load(), viewing ? 2500 : 5000);
    return () => window.clearInterval(iv);
  }, [load, viewing]);

  const users = data?.users ?? [];
  const bans = data?.bans ?? [];
  const viewingUser = viewing ? users.find((u) => u.id === viewing) ?? null : null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--term-bg)] font-mono" role="region" aria-label="admin app">
      {/* header — dense stats strip */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[color-mix(in_srgb,var(--term-fg)_20%,transparent)] px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.3em] text-[var(--term-dim)]">
          <ShieldCheck size={13} className="text-[var(--term-brand)]" aria-hidden="true" /> admin
        </span>
        <span className="text-[10.5px] text-[var(--term-fg)]">
          sessions <b className="text-[var(--term-brand)]">{users.length}</b>
        </span>
        <span className="text-[10.5px] text-[var(--term-fg)]">
          bans <b className={bans.length ? "text-[var(--term-err)]" : ""}>{bans.length}</b>
        </span>
        <span className="text-[10.5px] text-[var(--term-fg)]">
          lockdown <b className={data?.lockdown ? "text-[var(--term-err)]" : "text-[var(--term-brand)]"}>{data?.lockdown === undefined ? "…" : data.lockdown ? "ON" : "off"}</b>
        </span>
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          onClick={() => {
            setSection("users");
            setFileUser(null);
          }}
          aria-pressed={section === "users"}
          className={`cursor-pointer rounded px-2 py-0.5 text-[10.5px] transition-colors ${section === "users" ? "bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)] text-[var(--term-fg)]" : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"}`}
        >
          users
        </button>
        <button
          type="button"
          onClick={() => {
            setSection("site");
            setViewing(null);
            setFileUser(null);
          }}
          aria-pressed={section === "site"}
          className={`cursor-pointer rounded px-2 py-0.5 text-[10.5px] transition-colors ${section === "site" ? "bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)] text-[var(--term-fg)]" : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"}`}
        >
          site
        </button>
        <button type="button" onClick={() => void load()} aria-label="refresh now" className="cursor-pointer text-[var(--term-dim)] hover:text-[var(--term-fg)]">
          <RefreshCw size={12} aria-hidden="true" />
        </button>
      </div>

      {err && <p className="px-3 pt-2 text-[10.5px] text-[var(--term-err)]">{err}</p>}

      {fileUser ? (
        <FsBrowser token={token} user={users.find((u) => u.id === fileUser) ?? null} onBack={() => setFileUser(null)} />
      ) : viewing ? (
        <ViewScreen
          token={token}
          user={viewingUser}
          onBack={() => setViewing(null)}
          onActed={() => void load()}
          onFiles={setFileUser}
        />
      ) : section === "users" ? (
        <UsersSection token={token} users={users} onView={setViewing} onFiles={setFileUser} onActed={() => void load()} />
      ) : (
        <SiteSection token={token} bans={bans} onActed={() => void load()} />
      )}
    </div>
  );
}

/* ---------- live users: dense rows, actions inline ---------- */

function UsersSection({
  token,
  users,
  onView,
  onFiles,
  onActed,
}: {
  token: string;
  users: PresenceUser[];
  onView: (id: string) => void;
  onFiles: (id: string) => void;
  onActed: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const act = async (id: string, kind: "kick" | "ban") => {
    const r = await post(token, { id, [kind]: true });
    setMsg(kind === "ban" ? (r.ok && r.banned ? `${r.banned} banned — the gate refuses them now` : r.error ? `ban failed: ${r.error}` : "banned") : r.ok ? "kicked — they are looking at a red screen" : r.error ? `kick failed: ${r.error}` : "kicked");
    onActed();
  };

  return (
    <div className="murke-scroll min-h-0 flex-1 overflow-y-auto p-2">
      {msg && (
        <div className="mb-2 flex items-center gap-2 rounded border border-[color-mix(in_srgb,var(--term-brand)_40%,transparent)] px-2 py-1 text-[10.5px] text-[var(--term-brand)]">
          <span className="min-w-0 flex-1">{msg}</span>
          <button type="button" onClick={() => setMsg(null)} className="cursor-pointer text-[var(--term-dim)] hover:text-[var(--term-fg)]" aria-label="dismiss">
            ✕
          </button>
        </div>
      )}
      {users.length === 0 && <p className="p-2 text-[11px] text-[var(--term-dim)]">nobody is here — desktops appear while open (ping 25s)</p>}

      <ul className="space-y-1.5">
        {users.map((u) => {
          const isOpen = open === u.id;
          const fresh = Date.now() - u.lastSeen < 40_000;
          return (
            <li key={u.id} className="rounded-lg border border-[color-mix(in_srgb,var(--term-fg)_14%,transparent)]">
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${fresh ? "bg-[var(--term-brand)] shadow-[0_0_6px_var(--term-brand)]" : "bg-neutral-600"}`}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : u.id)}
                  aria-expanded={isOpen}
                  className="min-w-0 flex-1 cursor-pointer text-left"
                >
                  <span className="block truncate text-[12px] text-[var(--term-fg)]">
                    {u.ip}
                    <span className="ml-2 text-[9.5px] text-[var(--term-dim)]">{uaShort(u.ua)}</span>
                  </span>
                  <span className="block truncate text-[9.5px] text-[var(--term-dim)]">
                    {u.activity ?? "…"} · seen {timeAgo(u.lastSeen)} · since {timeAgo(u.firstSeen)} · {u.history.length} searches · {u.files.length} files
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(u.ip).catch(() => undefined)}
                    aria-label={`copy ip ${u.ip}`}
                    className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-dim)] transition-colors hover:text-[var(--term-fg)]"
                  >
                    copy
                  </button>
                  <button type="button" onClick={() => onView(u.id)} className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)]">
                    view
                  </button>
                  <button type="button" onClick={() => onFiles(u.id)} className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)]">
                    files
                  </button>
                  <button type="button" onClick={() => void act(u.id, "kick")} className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-brand)_45%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-brand)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-brand)_15%,transparent)]">
                    kick
                  </button>
                  <button type="button" onClick={() => void act(u.id, "ban")} className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-err)_45%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-err)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-err)_15%,transparent)]">
                    ban
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="grid gap-3 border-t border-[color-mix(in_srgb,var(--term-fg)_10%,transparent)] px-3 py-2 sm:grid-cols-2">
                  <div className="min-w-0">
                    <div className="mb-1 text-[9.5px] uppercase tracking-[0.25em] text-[var(--term-dim)]">search history</div>
                    {u.history.length === 0 ? (
                      <p className="text-[10.5px] text-[var(--term-dim)]">none</p>
                    ) : (
                      <ul className="murke-scroll max-h-44 space-y-1 overflow-y-auto pr-1">
                        {u.history.map((h, i) => (
                          <li key={`${i}-${h.u}`} className="min-w-0">
                            <span className="block truncate text-[10.5px] text-[var(--term-fg)]">{h.t}</span>
                            <span className="block truncate text-[9px] text-[var(--term-dim)]">{h.u}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="mb-1 text-[9.5px] uppercase tracking-[0.25em] text-[var(--term-dim)]">files app</div>
                    {u.files.length === 0 ? (
                      <p className="text-[10.5px] text-[var(--term-dim)]">none</p>
                    ) : (
                      <ul className="murke-scroll max-h-44 space-y-1 overflow-y-auto pr-1">
                        {u.files.map((f) => (
                          <li key={f.p} className="flex min-w-0 items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--term-fg)]">{f.p}</span>
                            {typeof f.s === "number" && f.s > 0 && <span className="shrink-0 text-[9px] text-[var(--term-dim)]">{(f.s / 1024).toFixed(1)}k</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <p className="text-[9px] text-[var(--term-dim)] sm:col-span-2">
                    id {u.id.slice(0, 10)} · device: {u.ua}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ---------- view screen — their screen, your cursor on it ---------- */

function ViewScreen({
  token,
  user,
  onBack,
  onActed,
  onFiles,
}: {
  token: string;
  user: PresenceUser | null;
  onBack: () => void;
  onActed: () => void;
  onFiles: (id: string) => void;
}) {
  const [notice, setNotice] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [mirror, setMirror] = useState<{ x: number; y: number } | null>(null);
  const [big, setBig] = useState(false); // edge-to-edge theater view
  const [, tickNow] = useState(0); // re-tick the frame-age readout every second
  const lastSent = useRef(0);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const watchId = user?.id ?? null;

  /* live frame-age ticker while the view is open */
  useEffect(() => {
    const t = window.setInterval(() => tickNow((n) => (n + 1) % 1000), 1000);
    return () => window.clearInterval(t);
  }, []);

  /* tell the server we're watching — the client starts shipping frames */
  useEffect(() => {
    if (!watchId) return;
    void post(token, { id: watchId, screenWant: true });
    return () => {
      void post(token, { id: watchId, screenWant: false });
    };
  }, [token, watchId]);

  /* a fresh poke re-arms a stale capture loop on their machine */
  const pokeFrame = useCallback(() => {
    if (!watchId) return;
    void post(token, { id: watchId, screenWant: false });
    window.setTimeout(() => void post(token, { id: watchId, screenWant: true }), 250);
    setMsg("asking their machine for a fresh frame…");
  }, [token, watchId]);

  const sendCursor = (x: number, y: number) => {
    if (!user) return;
    setMirror({ x, y });
    const now = Date.now();
    const prev = lastPos.current;
    const moved = !prev || Math.abs(prev.x - x) > 0.004 || Math.abs(prev.y - y) > 0.004;
    if (!moved && now - lastSent.current < 1200) return;
    if (now - lastSent.current < 140 && !moved) return;
    lastSent.current = now;
    lastPos.current = { x, y };
    void post(token, { id: user.id, cursor: { x, y } });
  };

  const sendClick = (x: number, y: number) => {
    if (!user) return;
    void post(token, { id: user.id, click: { x, y }, cursor: { x, y } });
  };

  const sendNotice = async () => {
    if (!user || !notice.trim()) return;
    await post(token, { id: user.id, notice: notice.trim() });
    setMsg(`notice sent — "${notice.trim()}"`);
    setNotice("");
  };

  const act = async (kind: "kick" | "ban") => {
    if (!user) return;
    const r = await post(token, { id: user.id, [kind]: true });
    setMsg(kind === "ban" ? (r.ok && r.banned ? `${r.banned} banned` : r.error ? `ban failed: ${r.error}` : "banned") : "kicked");
    onActed();
    if (r.ok) onBack();
  };

  const norm = (e: React.MouseEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  return (
    <div className="murke-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
      {/* toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button type="button" onClick={onBack} className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-0.5 text-[10.5px] text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]">
          ← back
        </button>
        {user && (
          <button type="button" onClick={() => onFiles(user.id)} className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-0.5 text-[10.5px] text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]">
            their files →
          </button>
        )}
        <span className="text-[11px] text-[var(--term-fg)]">{user ? user.ip : "session gone"}</span>
        {user && <span className="text-[9.5px] text-[var(--term-dim)]">{user.activity ?? ""}</span>}
        {user?.screenAt && <span className="text-[9.5px] text-[var(--term-brand)]">frame {timeAgo(user.screenAt)} ago</span>}
        <span className="min-w-0 flex-1" />
        <button type="button" onClick={pokeFrame} disabled={!user} className={"cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)] disabled:opacity-40"}>
          frame now
        </button>
        <button
          type="button"
          onClick={() => setBig((v) => !v)}
          aria-pressed={big}
          className={"cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]"}
        >
          {big ? "shrink" : "theater"}
        </button>
        <button type="button" onClick={() => void act("kick")} className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-brand)_45%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-brand)] hover:bg-[color-mix(in_srgb,var(--term-brand)_15%,transparent)]">
          kick
        </button>
        <button type="button" onClick={() => void act("ban")} className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-err)_45%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-err)] hover:bg-[color-mix(in_srgb,var(--term-err)_15%,transparent)]">
          ban
        </button>
      </div>

      {msg && <p className="shrink-0 text-[10px] text-[var(--term-brand)]">{msg}</p>}

      {/* the screen — move: your cursor lands on theirs (green rounded); click: clicks for real */}
      <div
        className={`relative mx-auto w-full shrink-0 overflow-hidden rounded-lg border border-[color-mix(in_srgb,var(--term-fg)_20%,transparent)] bg-black ${big ? "max-w-none" : "max-w-3xl"}`}
        onMouseMove={(e) => {
          if (!e.isTrusted) return; // synthetic clicks loop back — ignore them
          const { x, y } = norm(e, e.currentTarget);
          sendCursor(x, y);
        }}
        onMouseLeave={() => {
          lastPos.current = null;
          setMirror(null);
        }}
        onClick={(e) => {
          if (!e.isTrusted) return;
          const { x, y } = norm(e, e.currentTarget);
          sendClick(x, y);
        }}
        role="application"
        aria-label="their screen — move your cursor onto it to control"
      >
        {user?.screen ? (
          <img src={user.screen} alt={`screen of ${user.ip}`} className="block w-full select-none" style={{ imageRendering: "auto" }} draggable={false} />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center text-[11px] text-[var(--term-dim)]">
            {user ? "waiting for their first frame — captures start when this panel is open…" : "session gone — back to the list"}
          </div>
        )}
        {/* your cursor, mirrored — the same green rounded arrow they see */}
        {mirror && (
          <svg aria-hidden="true" className="pointer-events-none absolute z-10" style={{ left: `calc(${mirror.x * 100}% - 2px)`, top: `calc(${mirror.y * 100}% - 2px)`, width: 22, height: 22 }} viewBox="0 0 24 24">
            <path d="M5.5 2.8 L18.5 11.2 L12.4 12.6 L15.4 19.2 L12.2 20.6 L9.3 14 L5.5 17.4 Z" fill="#00e676" stroke="#0a3d22" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
        )}
        <span className="pointer-events-none absolute bottom-1.5 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[8.5px] uppercase tracking-[0.2em] text-[#00e676]">control — your cursor is on their screen</span>
        {user?.screenAt && (
          <span className="pointer-events-none absolute left-2 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[8.5px] lowercase tracking-[0.14em] text-[var(--term-fg)]">live · {timeAgo(user.screenAt)} ago</span>
        )}
      </div>

      {/* notice sender */}
      <form
        className="flex shrink-0 items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void sendNotice();
        }}
      >
        <input
          type="text"
          value={notice}
          onChange={(e) => setNotice(e.target.value)}
          placeholder="flash a message on their screen…"
          aria-label="notice message"
          maxLength={200}
          className="min-w-0 flex-1 border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] bg-transparent px-2 py-1 text-[11.5px] text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)] focus:border-[var(--term-brand)]"
        />
        <button type="submit" disabled={!notice.trim() || !user} className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-brand)_45%,transparent)] px-2.5 py-1 text-[10.5px] text-[var(--term-brand)] disabled:opacity-40">
          send
        </button>
      </form>

      {/* their data while you watch */}
      {user && (
        <div className="grid shrink-0 gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1 text-[9.5px] uppercase tracking-[0.25em] text-[var(--term-dim)]">search history</div>
            {user.history.length === 0 ? (
              <p className="text-[10px] text-[var(--term-dim)]">none</p>
            ) : (
              <ul className="murke-scroll max-h-32 space-y-1 overflow-y-auto pr-1">
                {user.history.map((h, i) => (
                  <li key={`${i}-${h.u}`} className="min-w-0">
                    <span className="block truncate text-[10px] text-[var(--term-fg)]">{h.t}</span>
                    <span className="block truncate text-[8.5px] text-[var(--term-dim)]">{h.u}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-[9.5px] uppercase tracking-[0.25em] text-[var(--term-dim)]">files app</div>
            {user.files.length === 0 ? (
              <p className="text-[10px] text-[var(--term-dim)]">none</p>
            ) : (
              <ul className="murke-scroll max-h-32 space-y-1 overflow-y-auto pr-1">
                {user.files.map((f) => (
                  <li key={f.p} className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--term-fg)]">{f.p}</span>
                    {typeof f.s === "number" && f.s > 0 && <span className="shrink-0 text-[8.5px] text-[var(--term-dim)]">{(f.s / 1024).toFixed(1)}k</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- site: lockdown · password · bans ---------- */

function SiteSection({ token, bans, onActed }: { token: string; bans: SiteBan[]; onActed: () => void }) {
  const [lockdown, setLockdown] = useState<boolean | null>(null);
  const [busyLock, setBusyLock] = useState(false);
  const [lockMsg, setLockMsg] = useState<string | null>(null);
  const [banMsg, setBanMsg] = useState<string | null>(null);
  const [confirmUnbanAll, setConfirmUnbanAll] = useState(false);

  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [busyPw, setBusyPw] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/lockdown", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        const j = (await res.json().catch(() => null)) as { lockdown?: boolean } | null;
        if (!dead && res.ok && j) setLockdown(Boolean(j.lockdown));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      dead = true;
    };
  }, [token]);

  const toggleLockdown = async () => {
    if (busyLock || lockdown === null) return;
    setBusyLock(true);
    setLockMsg(null);
    try {
      const res = await fetch("/api/admin/lockdown", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ on: !lockdown }),
      });
      const j = (await res.json().catch(() => null)) as { lockdown?: boolean } | null;
      if (res.ok && j) {
        setLockdown(Boolean(j.lockdown));
        setLockMsg(j.lockdown ? "lockdown ON — the gate refuses every login" : "lockdown OFF — logins accepted again");
      } else {
        setLockMsg("the site store refused — try again");
      }
    } catch {
      setLockMsg("the server did not answer");
    } finally {
      setBusyLock(false);
    }
  };

  const changePassword = async () => {
    if (busyPw) return;
    setPwMsg(null);
    if (pw1.length < 3) {
      setPwMsg({ ok: false, text: "too short — at least 3 characters" });
      return;
    }
    if (pw1 !== pw2) {
      setPwMsg({ ok: false, text: "the two entries do not match" });
      return;
    }
    setBusyPw(true);
    try {
      const res = await fetch("/api/admin/password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: pw1 }),
      });
      if (res.ok) {
        setPwMsg({ ok: true, text: `gate password changed — '${pw1}' is live for everyone` });
        setPw1("");
        setPw2("");
      } else {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        setPwMsg({ ok: false, text: j?.error ?? `refused (${res.status})` });
      }
    } catch {
      setPwMsg({ ok: false, text: "the server did not answer" });
    } finally {
      setBusyPw(false);
    }
  };

  const unban = async (ip: string) => {
    await post(token, { unban: ip });
    onActed();
  };

  const unbanAll = async () => {
    if (bans.length === 0) return;
    // one click = everyone out of ban jail; the toast says so
    const r = await post(token, { unbanAll: true });
    setBanMsg(r.ok ? "every ban lifted — the gate lets everyone through again" : r.error ?? "unban all failed");
    onActed();
  };

  const inputCls =
    "w-full border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)] focus:border-[var(--term-brand)]";

  return (
    <div className="murke-scroll min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
      {/* lockdown */}
      <section aria-label="lockdown" className="flex flex-wrap items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] px-3 py-2">
        <span className="min-w-0 flex-1 text-[12px] text-[var(--term-fg)]">
          lockdown <span className="text-[10px] text-[var(--term-dim)]">— site off for everyone, `admin` still works</span>
        </span>
        <button
          type="button"
          onClick={() => void toggleLockdown()}
          disabled={busyLock || lockdown === null}
          aria-pressed={lockdown === true}
          className={`cursor-pointer rounded-md border px-3 py-1 text-[11px] transition-colors disabled:opacity-40 ${
            lockdown
              ? "border-[color-mix(in_srgb,var(--term-err)_60%,transparent)] bg-[color-mix(in_srgb,var(--term-err)_18%,transparent)] text-[var(--term-err)]"
              : "border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]"
          }`}
        >
          {lockdown === null ? "…" : lockdown ? "lift lockdown" : "take the site down"}
        </button>
        {lockMsg && <p className="w-full text-[10px] text-[var(--term-brand)]">{lockMsg}</p>}
      </section>

      {/* password */}
      <section aria-label="site password" className="rounded-lg border border-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] p-3">
        <div className="mb-2 text-[12px] text-[var(--term-fg)]">
          gate password <span className="text-[10px] text-[var(--term-dim)]">— one password for every visitor</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            type="text"
            value={pw1}
            onChange={(e) => setPw1(e.target.value)}
            placeholder="new site password"
            aria-label="new site password"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className={inputCls}
            style={{ WebkitTextSecurity: "disc" } as React.CSSProperties}
          />
          <input
            type="text"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            placeholder="repeat it"
            aria-label="repeat new site password"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className={inputCls}
            style={{ WebkitTextSecurity: "disc" } as React.CSSProperties}
          />
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void changePassword()}
            disabled={busyPw || !pw1 || !pw2}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[11.5px] font-bold transition-transform hover:scale-[1.02] disabled:cursor-default disabled:opacity-40 disabled:hover:scale-100"
            style={{ background: "var(--term-brand)", color: "var(--term-bg)" }}
          >
            <ShieldCheck size={13} aria-hidden="true" /> {busyPw ? "writing…" : "change it"}
          </button>
          {pwMsg && <p className={`min-w-0 flex-1 text-[10.5px] ${pwMsg.ok ? "text-[var(--term-brand)]" : "text-[var(--term-err)]"}`}>{pwMsg.text}</p>}
        </div>
      </section>

      {/* ban list */}
      <section aria-label="banned machines" className="rounded-lg border border-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 text-[12px] text-[var(--term-fg)]">
            banned machines <span className="text-[10px] text-[var(--term-dim)]">— {bans.length ? `${bans.length} refused at the gate` : "none"}</span>
          </span>
          {bans.length > 0 &&
            (confirmUnbanAll ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmUnbanAll(false);
                    void unbanAll();
                  }}
                  className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-err)_60%,transparent)] bg-[color-mix(in_srgb,var(--term-err)_15%,transparent)] px-2.5 py-0.5 text-[10.5px] font-bold text-[var(--term-err)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-err)_25%,transparent)]"
                >
                  confirm — unban all {bans.length}
                </button>
                <button type="button" onClick={() => setConfirmUnbanAll(false)} className={"cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-dim)] hover:text-[var(--term-fg)]"}>
                  cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmUnbanAll(true)}
                className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-brand)_50%,transparent)] px-2.5 py-0.5 text-[10.5px] font-bold text-[var(--term-brand)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-brand)_15%,transparent)]"
              >
                unban all
              </button>
            ))}
        </div>
        {banMsg && (
          <div className="mb-2 flex items-center gap-2 rounded border border-[color-mix(in_srgb,var(--term-brand)_40%,transparent)] px-2 py-1 text-[10.5px] text-[var(--term-brand)]">
            <span className="min-w-0 flex-1">{banMsg}</span>
            <button type="button" onClick={() => setBanMsg(null)} className="cursor-pointer text-[var(--term-dim)] hover:text-[var(--term-fg)]" aria-label="dismiss">
              ✕
            </button>
          </div>
        )}
        {bans.length === 0 ? (
          <p className="text-[10.5px] text-[var(--term-dim)]">nobody is banned</p>
        ) : (
          <ul className="space-y-1">
            {bans.map((b) => (
              <li key={b.ip} className="group flex items-center gap-2 rounded border border-[color-mix(in_srgb,var(--term-err)_25%,transparent)] px-2.5 py-1.5 transition-colors hover:border-[color-mix(in_srgb,var(--term-err)_45%,transparent)]">
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--term-err)]" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--term-fg)]">
                  {b.ip}
                  <span className="ml-2 text-[9px] text-[var(--term-dim)]">
                    banned {timeAgo(b.at)} ago{b.by ? ` · by ${b.by}` : ""}
                    {b.id ? ` · ${b.id.slice(0, 10)}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard?.writeText(b.ip).catch(() => undefined)}
                  aria-label={`copy ${b.ip}`}
                  className="shrink-0 cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-fg)_20%,transparent)] px-2 py-0.5 text-[9.5px] text-[var(--term-dim)] opacity-0 transition-opacity hover:text-[var(--term-fg)] group-hover:opacity-100"
                >
                  copy
                </button>
                <button
                  type="button"
                  onClick={() => void unban(b.ip)}
                  className="shrink-0 cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-brand)_50%,transparent)] px-3 py-0.5 text-[10.5px] font-bold text-[var(--term-brand)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-brand)_15%,transparent)]"
                >
                  unban
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ---------- their files — browse · read · edit · write · mkdir · delete ---------- */

interface FsEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
  mtime: number;
}

interface FsData {
  entries?: FsEntry[];
  content?: string;
  size?: number;
  mime?: string;
  tooBig?: boolean;
}

function FsBrowser({ token, user, onBack }: { token: string; user: PresenceUser | null; onBack: () => void }) {
  const [path, setPath] = useState("~");
  const [pathInput, setPathInput] = useState("~");
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ path: string; content: string; size: number; binary: boolean } | null>(null);
  const [creating, setCreating] = useState<"file" | "folder" | null>(null);
  const [newName, setNewName] = useState("");
  const [newContent, setNewContent] = useState("");
  const watchId = user?.id ?? null;

  const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

  /** queue an op on their machine and wait for the answer — their desktop
   *  answers over the 1s control poll, so expect ~1-2s round trips */
  const fsReq = useCallback(
    async (op: "list" | "read" | "write" | "mkdir" | "remove", p: string, content?: string): Promise<{ ok: boolean; data?: FsData; error?: string }> => {
      if (!watchId) return { ok: false, error: "their session is gone" };
      try {
        const r0 = await post(token, { id: watchId, fs: { op, path: p, content } });
        if (!r0.ok || !r0.rid) return { ok: false, error: r0.error ?? "could not queue the op" };
        for (let i = 0; i < 14; i++) {
          await sleep(1100);
          try {
            const res = await fetch(`/api/admin/fs?id=${encodeURIComponent(watchId)}&rid=${encodeURIComponent(r0.rid)}`, {
              headers: { Authorization: `Bearer ${token}` },
              cache: "no-store",
            });
            const j = (await res.json().catch(() => null)) as { done?: boolean; res?: { ok?: boolean; data?: FsData; error?: string } } | null;
            if (j?.done && j.res) return { ok: j.res.ok === true, data: j.res.data, error: j.res.error };
          } catch {
            /* transient — keep polling */
          }
        }
        return { ok: false, error: "their machine never answered — is it still open?" };
      } catch {
        return { ok: false, error: "no answer" };
      }
    },
    [token, watchId],
  );

  const browse = useCallback(
    async (p: string) => {
      setBusy(`listing ${p}…`);
      setErr(null);
      setStatus(null);
      setEdit(null);
      setCreating(null);
      const r = await fsReq("list", p);
      setBusy(null);
      if (!r.ok) {
        setErr(r.error ?? "list failed");
        return;
      }
      setEntries(r.data?.entries ?? []);
      setPath(p);
      setPathInput(p);
    },
    [fsReq],
  );

  useEffect(() => {
    if (!watchId) return;
    /* deferred — their machine answers over the control poll, never inline */
    const t = window.setTimeout(() => void browse("~"), 40);
    return () => window.clearTimeout(t);
  }, [watchId, browse]);

  const join = (name: string) => (path === "~" ? `~/${name}` : `${path}/${name}`);

  const openFile = async (p: string) => {
    setBusy(`reading ${p}…`);
    setErr(null);
    setStatus(null);
    const r = await fsReq("read", p);
    setBusy(null);
    if (!r.ok) {
      setErr(r.error ?? "read failed");
      return;
    }
    if (r.data?.tooBig) {
      setErr(`too big to edit (${Math.round((r.data.size ?? 0) / 1024)}k) — the editor carries text under 800k`);
      return;
    }
    const content = r.data?.content ?? "";
    const size = r.data?.size ?? 0;
    setEdit({ path: p, content, size, binary: size > 0 && content.length === 0 });
  };

  const saveEdit = async () => {
    if (!edit) return;
    setBusy(`writing ${edit.path}…`);
    const r = await fsReq("write", edit.path, edit.content);
    setBusy(null);
    if (!r.ok) {
      setErr(r.error ?? "write failed");
      return;
    }
    setStatus(`saved — ${edit.path} is rewritten on their machine`);
    setEdit(null);
    void browse(path);
  };

  const removeIt = async (p: string) => {
    setBusy(`deleting ${p}…`);
    const r = await fsReq("remove", p);
    setBusy(null);
    if (!r.ok) {
      setErr(r.error ?? "delete failed");
      return;
    }
    setStatus(`deleted — ${p}`);
    void browse(path);
  };

  const makeIt = async () => {
    const name = newName.trim();
    if (!name || !creating) return;
    const p = join(name);
    setBusy(creating === "folder" ? `making folder ${p}…` : `writing ${p}…`);
    const r = creating === "folder" ? await fsReq("mkdir", p) : await fsReq("write", p, newContent);
    setBusy(null);
    if (!r.ok) {
      setErr(r.error ?? "create failed");
      return;
    }
    setStatus(creating === "folder" ? `folder created — ${p}` : `file created — ${p}`);
    setCreating(null);
    setNewName("");
    setNewContent("");
    void browse(path);
  };

  const fmtSize = (s?: number) => (typeof s === "number" && s > 0 ? (s >= 1024 ? `${(s / 1024).toFixed(1)}k` : `${s}b`) : "");
  const fmtTime = (t: number) => {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const inputCls =
    "min-w-0 border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] bg-transparent px-2 py-1 text-[11.5px] text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)] focus:border-[var(--term-brand)]";
  const btnCls =
    "cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)] disabled:opacity-40";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color-mix(in_srgb,var(--term-fg)_12%,transparent)] px-2 py-1.5">
        <button type="button" onClick={onBack} className={btnCls}>
          ← back
        </button>
        <span className="text-[11px] text-[var(--term-fg)]">{user ? user.ip : "session gone"}</span>
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const p = pathInput.trim();
            if (p) void browse(p);
          }}
        >
          <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} placeholder="~" aria-label="path on their machine" className={`${inputCls} flex-1 font-mono`} />
          <button type="submit" className={btnCls}>
            go
          </button>
        </form>
        <button type="button" onClick={() => void browse(path)} disabled={!user} className={btnCls}>
          refresh
        </button>
        <button
          type="button"
          onClick={() => {
            setCreating(creating === "file" ? null : "file");
            setErr(null);
            setStatus(null);
            setNewName("");
            setNewContent("");
          }}
          disabled={!user}
          className={btnCls}
        >
          + file
        </button>
        <button
          type="button"
          onClick={() => {
            setCreating(creating === "folder" ? null : "folder");
            setErr(null);
            setStatus(null);
            setNewName("");
          }}
          disabled={!user}
          className={btnCls}
        >
          + folder
        </button>
      </div>

      {/* status strip */}
      <div className="shrink-0 px-2 pt-1.5 text-[10px]">
        {busy && <span className="text-[var(--term-dim)]">{busy}</span>}
        {err && <span className="text-[var(--term-err)]">{err}</span>}
        {status && <span className="text-[var(--term-brand)]">{status}</span>}
        {!busy && !err && !status && <span className="text-[var(--term-dim)]">their real file system — every change lands live · ~1-2s per op</span>}
      </div>

      {/* editor / creator / listing */}
      {edit ? (
        <div className="flex min-h-0 flex-1 flex-col p-2">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--term-fg)]">{edit.path}</span>
            <span className="text-[9.5px] text-[var(--term-dim)]">{edit.binary ? "binary — nothing to edit" : `${edit.size}b`}</span>
            {!edit.binary && (
              <button
                type="button"
                onClick={() => void saveEdit()}
                disabled={Boolean(busy)}
                className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-brand)_45%,transparent)] px-2.5 py-0.5 text-[10.5px] text-[var(--term-brand)] hover:bg-[color-mix(in_srgb,var(--term-brand)_15%,transparent)] disabled:opacity-40"
              >
                save on their machine
              </button>
            )}
            <button type="button" onClick={() => setEdit(null)} className={btnCls}>
              close
            </button>
          </div>
          <textarea
            value={edit.content}
            onChange={(e) => setEdit({ ...edit, content: e.target.value })}
            readOnly={edit.binary}
            spellCheck={false}
            aria-label={`editing ${edit.path}`}
            className="murke-scroll min-h-0 flex-1 resize-none rounded border border-[color-mix(in_srgb,var(--term-fg)_18%,transparent)] bg-black/30 p-2 font-mono text-[11.5px] leading-relaxed text-[var(--term-fg)] outline-none focus:border-[var(--term-brand)]"
          />
        </div>
      ) : (
        <div className="murke-scroll min-h-0 flex-1 overflow-y-auto p-2">
          {creating && (
            <form
              className="mb-2 rounded-lg border border-[color-mix(in_srgb,var(--term-brand)_35%,transparent)] p-2"
              onSubmit={(e) => {
                e.preventDefault();
                void makeIt();
              }}
            >
              <div className="mb-1.5 text-[10px] uppercase tracking-[0.25em] text-[var(--term-dim)]">
                {creating === "folder" ? "new folder in" : "new file in"} {path}
              </div>
              <div className="flex items-center gap-2">
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="name" aria-label="new name" autoFocus className={`${inputCls} min-w-0 flex-1 font-mono`} />
                <button type="submit" disabled={!newName.trim() || Boolean(busy)} className="cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-brand)_45%,transparent)] px-2.5 py-1 text-[10.5px] text-[var(--term-brand)] disabled:opacity-40">
                  create
                </button>
                <button type="button" onClick={() => setCreating(null)} className={btnCls}>
                  cancel
                </button>
              </div>
              {creating === "file" && (
                <textarea
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="content (optional — plain text)"
                  aria-label="new file content"
                  rows={5}
                  spellCheck={false}
                  className="murke-scroll mt-2 w-full resize-y rounded border border-[color-mix(in_srgb,var(--term-fg)_18%,transparent)] bg-black/30 p-2 font-mono text-[11.5px] text-[var(--term-fg)] outline-none focus:border-[var(--term-brand)]"
                />
              )}
            </form>
          )}

          {!user && <p className="p-2 text-[11px] text-[var(--term-dim)]">their session dropped off the board — nothing to browse</p>}
          {user && entries === null && !busy && <p className="p-2 text-[11px] text-[var(--term-dim)]">listing…</p>}
          {entries !== null && entries.length === 0 && <p className="p-2 text-[11px] text-[var(--term-dim)]">{path} is empty</p>}

          {entries !== null && entries.length > 0 && (
            <ul className="space-y-0.5">
              {path !== "~" && (
                <li>
                  <button
                    type="button"
                    onClick={() => void browse(path.replace(/\/[^/]+$/, "") || "~")}
                    className="w-full cursor-pointer rounded px-2 py-1 text-left font-mono text-[11.5px] text-[var(--term-dim)] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)]"
                  >
                    ↑ ..
                  </button>
                </li>
              )}
              {entries.map((n) => (
                <li key={n.name} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[color-mix(in_srgb,var(--term-fg)_7%,transparent)]">
                  <span aria-hidden="true" className={`shrink-0 font-mono text-[10px] ${n.type === "dir" ? "text-[var(--term-brand)]" : "text-[var(--term-dim)]"}`}>
                    {n.type === "dir" ? "dir " : "file"}
                  </span>
                  <button
                    type="button"
                    onClick={() => (n.type === "dir" ? void browse(join(n.name)) : void openFile(join(n.name)))}
                    className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-[11.5px] text-[var(--term-fg)]"
                    aria-label={`${n.type === "dir" ? "open folder" : "open file"} ${n.name}`}
                  >
                    {n.name}
                    {n.type === "dir" ? "/" : ""}
                  </button>
                  <span className="shrink-0 text-[9px] tabular-nums text-[var(--term-dim)]">{fmtSize(n.size)}</span>
                  <span className="hidden shrink-0 text-[9px] tabular-nums text-[var(--term-dim)] sm:block">{fmtTime(n.mtime)}</span>
                  {n.type === "file" && (
                    <button type="button" onClick={() => void openFile(join(n.name))} className={`${btnCls} shrink-0`}>
                      edit
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void removeIt(join(n.name))}
                    disabled={Boolean(busy)}
                    className="shrink-0 cursor-pointer rounded border border-[color-mix(in_srgb,var(--term-err)_45%,transparent)] px-2 py-0.5 text-[10px] text-[var(--term-err)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-err)_15%,transparent)] disabled:opacity-40"
                  >
                    del
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
