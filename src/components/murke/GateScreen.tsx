"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { login } from "@/lib/murke/auth";
import { ADMIN_SESSION_KEY } from "@/lib/murke/commands";
import { ScramjetProxy } from "@/lib/murke/proxy";
import type { ProxyFrameHandle } from "@/lib/murke/contracts";

/**
 * The gate. Completely blank — no logo, no input box, no hints.
 * The password is typed blind and submitted with Enter.
 * Wrong input silently clears. Correct input fades through to the OS.
 *
 * LOCKDOWN: when the admin kill switch is on, the gate refuses to listen —
 * a quiet lock line replaces the input and /api/auth would refuse anyway.
 * BANNED: a banned ip gets THE HUB — the school's own portal fills the
 * screen, loaded through this site's own proxy engine (hub.hertswood-
 * academy.org refuses plain framing with X-Frame-Options: DENY, but the
 * scramjet relay strips frame guards, so the page renders for real).
 * Nothing of murke remains visible — it IS the school hub now.
 *
 * ADMIN BYPASS: the konami code (↑ ↑ ↓ ↓ ← → ← → B A) typed on the ban or
 * lockdown screen reveals the bypass password panel — the permanent admin
 * pwd mints an admin token (POST /api/admin/auth) and the session opens
 * with it; /api/auth honors a valid admin token above bans + lockdown.
 * The code is heard both on the gate document AND inside the proxied hub
 * frame (same-origin through the relay), so it works wherever focus sits.
 *
 * THE LITE DOOR: "..0" typed at the gate doesn't open the OS — it fades
 * straight into the borderless proxy (simple mode, lite). No boot, no
 * dock, no terminal: exactly the fullscreen proxy, nothing else.
 */

/** hub.hertswoodacademy.org fills the screen for banned machines */
const HUB_URL = "https://hub.hertswoodacademy.org/";

/** the code: ↑ ↑ ↓ ↓ ← → ← → B A */
const KONAMI = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "b",
  "a",
];

export default function GateScreen({ onAuth }: { onAuth: (lite?: boolean) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [flash, setFlash] = useState(false); // 1-frame flicker on wrong entry
  const [locked, setLocked] = useState(false);
  const [banned, setBanned] = useState(false);

  /* admin bypass — konami reveals the panel; the token opens the site */
  const [bypassOpen, setBypassOpen] = useState(false);
  const [bypassPwd, setBypassPwd] = useState("");
  const [bypassErr, setBypassErr] = useState<string | null>(null);
  const [bypassBusy, setBypassBusy] = useState(false);
  const bypassInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    let dead = false;
    void (async () => {
      try {
        const res = await fetch("/api/gate", { cache: "no-store" });
        if (!dead && res.ok) {
          const j = (await res.json()) as { lockdown?: boolean; banned?: boolean };
          if (j.banned) setBanned(true);
          else if (j.lockdown) setLocked(true);
        }
      } catch {
        /* gate works offline */
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  /* an admin token left in sessionStorage (the admin app or a previous
     bypass this tab) is enough to open the gate above any ban/lockdown */
  useEffect(() => {
    let dead = false;
    void (async () => {
      let token: string | null = null;
      try {
        token = sessionStorage.getItem(ADMIN_SESSION_KEY);
      } catch {
        /* ignore */
      }
      if (!token) return;
      try {
        const res = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adminToken: token }),
        });
        if (!dead && res.ok) onAuth();
      } catch {
        /* ignore — normal gate flow continues */
      }
    })();
    return () => {
      dead = true;
    };
  }, [onAuth]);

  const submit = useCallback(async () => {
    if (checking || locked || banned) return;
    const pw = value;
    if (pw.length === 0) return;
    setChecking(true);
    const res = await login(pw);
    setChecking(false);
    if (res) {
      onAuth(res.lite);
    } else {
      // silent rejection: clear + imperceptible flicker
      setValue("");
      setFlash(true);
      window.setTimeout(() => setFlash(false), 60);
    }
  }, [value, checking, locked, banned, onAuth]);

  /* ---------- konami ---------- */
  useEffect(() => {
    if (!banned && !locked) return;
    let idx = 0;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === KONAMI[idx]) {
        idx += 1;
        if (idx === KONAMI.length) {
          idx = 0;
          setBypassOpen(true);
          window.setTimeout(() => bypassInputRef.current?.focus(), 60);
        }
      } else {
        idx = k === KONAMI[0] ? 1 : 0;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [banned, locked]);

  /* ---------- the bypass ---------- */
  const submitBypass = useCallback(async () => {
    if (bypassBusy) return;
    const pwd = bypassPwd.trim();
    if (!pwd) return;
    setBypassBusy(true);
    setBypassErr(null);
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pwd }),
      });
      if (!res.ok) {
        setBypassErr("wrong — this screen never existed");
        setBypassPwd("");
        return;
      }
      const j = (await res.json().catch(() => null)) as { token?: string } | null;
      if (j?.token) {
        try {
          sessionStorage.setItem(ADMIN_SESSION_KEY, j.token);
        } catch {
          /* ignore */
        }
        // the admin token rides the normal login — bans + lockdown bow out
        const auth = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ adminToken: j.token }),
        });
        if (auth.ok) {
          onAuth();
          return;
        }
        setBypassErr("the site refused the token — try again");
      } else {
        setBypassErr("the site did not answer");
      }
    } catch {
      setBypassErr("no answer");
    } finally {
      setBypassBusy(false);
    }
  }, [bypassPwd, bypassBusy, onAuth]);

  /* ---------- banned machines see THE HUB (through our own proxy) ---------- */
  if (banned && !bypassOpen) {
    return <BannedHub onKonami={() => {
      setBypassOpen(true);
      window.setTimeout(() => bypassInputRef.current?.focus(), 60);
    }} />;
  }

  return (
    <div
      className={`fixed inset-0 z-50 bg-black ${flash ? "opacity-95" : "opacity-100"} transition-opacity duration-150`}
      onClick={() => {
        if (!locked) inputRef.current?.focus();
      }}
      role="presentation"
    >
      {/* lockdown — the site is off */}
      {locked && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="font-mono text-[12px] lowercase tracking-[0.35em] text-neutral-500">
            site locked by the administrator
          </p>
        </div>
      )}
      {/* type="text" + CSS dot-masking: a real type="password" input makes
          Chrome's password manager pop a save-password bubble over the
          gate. Masked text never triggers it, and looks identical. */}
      <input
        ref={inputRef}
        type="text"
        value={value}
        disabled={checking || locked || banned}
        aria-label="authenticate"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        name="murke-gate-input"
        id="murke-gate-input"
        className="absolute inset-0 h-full w-full cursor-default bg-transparent px-0 text-base text-black opacity-0 outline-none"
        style={{ caretColor: "transparent", WebkitTextSecurity: "disc" } as React.CSSProperties}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
      />

      {/* konami → the bypass panel — quiet, glassy, deniable */}
      {bypassOpen && (
        <div
          role="dialog"
          aria-label="admin bypass"
          className="absolute left-1/2 top-1/2 z-10 w-[260px] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-4 font-mono"
          style={{
            borderColor: "rgba(255,255,255,0.14)",
            background: "rgba(12,12,12,0.88)",
            backdropFilter: "blur(18px) saturate(1.3)",
            WebkitBackdropFilter: "blur(18px) saturate(1.3)",
            boxShadow: "0 24px 70px rgba(0,0,0,0.6)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="mb-2 text-[10px] uppercase tracking-[0.3em] text-neutral-500">admin bypass</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitBypass();
            }}
          >
            <input
              ref={bypassInputRef}
              type="text"
              value={bypassPwd}
              onChange={(e) => setBypassPwd(e.target.value)}
              placeholder="permanent pwd"
              aria-label="admin bypass pwd"
              disabled={bypassBusy}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="w-full border border-white/20 bg-transparent px-2 py-1.5 text-[12px] text-white outline-none placeholder:text-neutral-600 focus:border-white/50"
              style={{ WebkitTextSecurity: "disc" } as React.CSSProperties}
            />
            <button
              type="submit"
              disabled={bypassBusy || !bypassPwd.trim()}
              className="mt-2 w-full cursor-pointer border border-white/25 bg-white/5 py-1.5 text-[11px] text-white transition-colors hover:bg-white/15 disabled:opacity-40"
            >
              {bypassBusy ? "checking…" : "bypass"}
            </button>
          </form>
          {bypassErr && <p className="mt-2 text-[10px] text-red-500">{bypassErr}</p>}
          <button
            type="button"
            onClick={() => {
              setBypassOpen(false);
              setBypassPwd("");
              setBypassErr(null);
              inputRef.current?.focus();
            }}
            className="mt-2 w-full cursor-pointer text-[9.5px] lowercase tracking-[0.2em] text-neutral-600 hover:text-neutral-400"
          >
            esc — back
          </button>
        </div>
      )}
      {/* esc collapses the bypass */}
      <EscWatcher active={bypassOpen} onEsc={() => setBypassOpen(false)} />
    </div>
  );
}

/** tiny esc listener for the bypass panel — kept out of the main tree so
    the gate's own key handling never races it */
function EscWatcher({ active, onEsc }: { active: boolean; onEsc: () => void }) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onEsc();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onEsc]);
  return null;
}

/** konami listener attachable to ANY window (the gate's or the hub frame's) */
function useKonamiIn(win: Window | null, onDone: () => void): void {
  const cbRef = useRef(onDone);
  useEffect(() => {
    cbRef.current = onDone;
  }, [onDone]);
  useEffect(() => {
    if (!win) return;
    let idx = 0;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === KONAMI[idx]) {
        idx += 1;
        if (idx === KONAMI.length) {
          idx = 0;
          cbRef.current();
        }
      } else {
        idx = k === KONAMI[0] ? 1 : 0;
      }
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [win]);
}

/**
 * BannedHub — the banned machine's whole world: hub.hertswoodacademy.org
 * rendered through this site's own proxy engine. The hub refuses plain
 * iframes (X-Frame-Options: DENY + a Google-Sites frame-ancestors CSP) but
 * the scramjet relay strips those guards, so the REAL page loads. Until the
 * proxy engine is warm the screen is a quiet blank — indistinguishable from
 * any slow portal. The konami code works on the gate document and inside
 * the hub frame itself (same-origin through the relay).
 */
function BannedHub({ onKonami }: { onKonami: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [frameWin, setFrameWin] = useState<Window | null>(null);
  useKonamiIn(window, onKonami);
  useKonamiIn(frameWin, onKonami);

  useEffect(() => {
    let dead = false;
    let handle: ProxyFrameHandle | null = null;
    const proxy = new ScramjetProxy();

    void (async () => {
      // boot the proxy engine for this page — the same stack the OS uses
      const ok = await proxy.init().then((r) => r.ok).catch(() => false);
      if (dead) return;
      if (!ok) return; // stays blank — never reveals what this machine is
      try {
        handle = proxy.createFrame();
        const el = handle.el as HTMLIFrameElement;
        el.style.width = "100%";
        el.style.height = "100%";
        if (hostRef.current) hostRef.current.appendChild(el);
        handle.onUrl(() => {
          try {
            setFrameWin(el.contentWindow);
          } catch {
            /* cross-origin frames never see this — relay keeps it same-origin */
          }
        });
        try {
          setFrameWin(el.contentWindow);
        } catch {
          /* ignore */
        }
        handle.go(HUB_URL);
      } catch {
        /* blank stays */
      }
    })();

    return () => {
      dead = true;
      // no explicit teardown — the frame dies with the document
      void handle;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-white" role="presentation" aria-label="hub">
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
