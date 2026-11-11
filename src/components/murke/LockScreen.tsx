"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { login } from "@/lib/murke/auth";
import { useOS } from "@/lib/murke/os-store";

/**
 * LockScreen — the mac-style lock thrown over the live desktop.
 *
 * Self-managed: mounts as null, arms itself quietly, and drops the veil when
 *   - the tab hides (visibilitychange — instant),
 *   - the window blurs (700ms grace so alt-tab flicker doesn't lock),
 *   - anything dispatches "murke-lock" (menubar button → requestLock()).
 *
 * settings › lock screen owns the behavior: autoLock gates the two
 * AUTOMATIC triggers (the manual menubar lock always works), and the veil
 * itself is customizable — blur, dim, clock, date, hint and the face
 * (material you = roboto flex, or the terminal mono).
 *
 * Locked: the real wallpaper refracts through a blur veil (backdrop-filter is
 * inline — the css pipeline compiles that property down to -webkit-only form
 * which chromium rejects, see GlassDefs), a huge ticking clock up top, and in
 * the lower third the password hairline. One click or keystroke anywhere wakes
 * the password hairline — the waking keystroke itself lands in the field (focus
 * happens synchronously inside the capture handler, before the key's default
 * action runs). Wrong password → waaapi shake + red hairline; right password
 * → the whole overlay fades straight back into the desktop.
 */

type Stage = "hint" | "input";

/** pure modifier keys never wake the field */
const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "ContextMenu",
  "Fn",
  "FnLock",
  "Hyper",
  "Symbol",
  "OS",
]);

const pad2 = (n: number) => String(n).padStart(2, "0");

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** ask the lock screen to lock — safe from any browser context */
export function requestLock(): void {
  try {
    window.dispatchEvent(new CustomEvent("murke-lock"));
  } catch {
    /* nothing listening — fine */
  }
}

export default function LockScreen() {
  const [locked, setLocked] = useState(false);
  const [stage, setStage] = useState<Stage>("hint");
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState(false);
  const [fading, setFading] = useState(false);
  const [shown, setShown] = useState(false); // drives the fade-in once mounted
  const [clock, setClock] = useState<Date | null>(null);

  /* settings › lock screen — read live so sliders move while unlocked */
  const ls = useOS((s) => s.settings.lockscreen);

  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // synchronous mirrors — handlers must read truth, not last render
  const lockedRef = useRef(false);
  const stageRef = useRef<Stage>("hint");
  const checkingRef = useRef(false);
  const fadingRef = useRef(false);
  const mountedRef = useRef(false);
  const fadeTimerRef = useRef<number | null>(null);
  const errTimerRef = useRef<number | null>(null);

  const setStageSafe = useCallback((s: Stage) => {
    stageRef.current = s;
    setStage(s);
  }, []);

  /* ---------- locking ---------- */

  const lock = useCallback(() => {
    if (lockedRef.current || fadingRef.current) return;
    lockedRef.current = true;
    // the desktop loses the keyboard the instant the veil drops
    try {
      (document.activeElement as HTMLElement | null)?.blur();
    } catch {
      /* ignore */
    }
    setStageSafe("hint");
    setValue("");
    setErr(false);
    setChecking(false);
    checkingRef.current = false;
    setFading(false);
    setShown(false);
    setClock(new Date());
    setLocked(true);
  }, [setStageSafe]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current);
      if (errTimerRef.current !== null) window.clearTimeout(errTimerRef.current);
    };
  }, []);

  /* lock triggers — visibility (instant), window blur (700ms grace),
     "murke-lock" custom event (instant). the first two honor the
     autoLock setting; the manual event always locks. */
  useEffect(() => {
    // already hidden at mount (background-tab preload) — check on the next
    // tick so the effect body stays free of synchronous setState
    const initial = window.setTimeout(() => {
      if (document.hidden && ls.autoLock) lock();
    }, 0);
    let grace: number | null = null;
    const arm = () => {
      if (!ls.autoLock) return;
      if (grace !== null) window.clearTimeout(grace);
      grace = window.setTimeout(() => {
        grace = null;
        lock();
      }, 700);
    };
    const disarm = () => {
      if (grace !== null) {
        window.clearTimeout(grace);
        grace = null;
      }
    };
    const onVis = () => {
      if (document.hidden && ls.autoLock) lock();
    };
    const onLockEvt = () => lock();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", arm);
    window.addEventListener("focus", disarm);
    window.addEventListener("murke-lock", onLockEvt);
    return () => {
      window.clearTimeout(initial);
      disarm();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", arm);
      window.removeEventListener("focus", disarm);
      window.removeEventListener("murke-lock", onLockEvt);
    };
  }, [lock, ls.autoLock]);

  /* live clock — ticks the whole time the veil is up (lock() stamps the
     first reading; the interval takes over a second later) */
  useEffect(() => {
    if (!locked) return;
    const id = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(id);
  }, [locked]);

  /* fade-in: double rAF so one frame paints at opacity 0 first, otherwise
     the transition is skipped and the lock pops in */
  useEffect(() => {
    if (!locked) return;
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => setShown(true));
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
    };
  }, [locked]);

  /* block page scroll behind the veil */
  useEffect(() => {
    if (!locked) return;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevOverscroll = body.style.overscrollBehavior;
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    return () => {
      body.style.overflow = prevOverflow;
      body.style.overscrollBehavior = prevOverscroll;
    };
  }, [locked]);

  /* wake handlers — any keystroke or pointer press reveals the field.
     capture phase on window: runs before every other listener. */
  useEffect(() => {
    if (!locked) return;

    const wake = () => {
      if (stageRef.current !== "input") setStageSafe("input");
      // synchronous: the waking keydown's default action (the character
      // itself) fires after dispatch and lands in the focused field
      try {
        inputRef.current?.focus();
      } catch {
        /* ignore */
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (fadingRef.current) return;
      if (e.key === "Tab") {
        // nothing behind the veil is reachable — keep focus home
        e.preventDefault();
        e.stopPropagation();
        wake();
        return;
      }
      if (MODIFIER_KEYS.has(e.key)) return;
      if (stageRef.current !== "hint") return;
      // the lock eats the keystroke, but never preventDefault: the key's
      // default action must still run so the typed character lands
      e.stopPropagation();
      wake();
    };

    const onPointer = (e: PointerEvent) => {
      if (fadingRef.current) return;
      const input = inputRef.current;
      const onField =
        e.target instanceof Node && input !== null && (input === e.target || input.contains(e.target));
      if (onField) return; // native caret placement stays intact
      // canceling pointerdown kills the compatibility mouse events, so the
      // press can't slide focus into the desktop underneath
      e.preventDefault();
      wake();
    };

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [locked, setStageSafe]);

  /* ---------- unlocking ---------- */

  const submit = async () => {
    if (checkingRef.current || fadingRef.current || !lockedRef.current) return;
    const pw = value;
    if (pw.length === 0) return;
    checkingRef.current = true;
    setChecking(true);
    const kind = await login(pw);
    checkingRef.current = false;
    if (!mountedRef.current) return;
    setChecking(false);

    if (kind) {
      // authenticated — dissolve back into the desktop
      if (errTimerRef.current !== null) {
        window.clearTimeout(errTimerRef.current);
        errTimerRef.current = null;
      }
      try {
        inputRef.current?.blur();
      } catch {
        /* ignore */
      }
      fadingRef.current = true;
      setFading(true);
      fadeTimerRef.current = window.setTimeout(() => {
        fadeTimerRef.current = null;
        fadingRef.current = false;
        lockedRef.current = false;
        setFading(false);
        setLocked(false);
        setStageSafe("hint");
        setValue("");
        setErr(false);
        setChecking(false);
      }, 370);
      return;
    }

    // rejected — clear the field, shake, flash the hairline red
    setValue("");
    setErr(true);
    if (!prefersReducedMotion() && wrapRef.current) {
      try {
        wrapRef.current.animate(
          [
            { transform: "translateX(0)" },
            { transform: "translateX(-9px)" },
            { transform: "translateX(8px)" },
            { transform: "translateX(-5px)" },
            { transform: "translateX(0)" },
          ],
          { duration: 340, easing: "ease-out" },
        );
      } catch {
        /* ancient engine — skip the shake */
      }
    }
    if (errTimerRef.current !== null) window.clearTimeout(errTimerRef.current);
    errTimerRef.current = window.setTimeout(() => {
      errTimerRef.current = null;
      if (mountedRef.current) setErr(false);
    }, 900);
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (value.length > 0) {
        setValue("");
      } else {
        setStageSafe("hint");
        try {
          inputRef.current?.blur();
        } catch {
          /* ignore */
        }
      }
    }
  };

  if (!locked) return null;

  const time = clock ? `${pad2(clock.getHours())}:${pad2(clock.getMinutes())}` : "";
  const date = clock
    ? clock.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
    : "";

  /* the veil follows settings — blur, dim; the face follows the font pick */
  const face =
    ls.font === "material"
      ? "var(--font-material-you), system-ui, sans-serif"
      : undefined; // undefined → the wrapper's font-mono

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="lock screen"
      className={`fixed inset-0 z-[200] flex select-none flex-col items-center overflow-hidden font-mono ${
        fading ? "pointer-events-none" : ""
      }`}
      style={{
        opacity: fading ? 0 : shown ? 1 : 0,
        transition: "opacity 360ms ease",
        background: `color-mix(in srgb, var(--term-bg) ${ls.dim}%, transparent)`,
        backdropFilter: `blur(${ls.blur}px) saturate(1.35) brightness(0.62)`,
        WebkitBackdropFilter: `blur(${ls.blur}px) saturate(1.35) brightness(0.62)`,
        fontFamily: face,
        touchAction: "none",
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* clock — upper third */}
      {ls.showClock && (
        <div className="mt-[15vh] flex flex-col items-center gap-3">
          <div className="murke-ember-halo text-center text-[86px] font-light leading-none tracking-tight text-[var(--term-fg)] tabular-nums md:text-[108px]">
            {time}
          </div>
          {ls.showDate && (
            <div className="murke-ember-halo text-[15px] font-light lowercase tracking-[0.1em] text-[color-mix(in_srgb,var(--term-fg)_74%,transparent)] md:text-[16px]">
              {date}
            </div>
          )}
        </div>
      )}

      {/* user — lower third */}
      <div className="mt-auto mb-[15vh] flex flex-col items-center gap-3">
        {/* hint <-> hairline input — one slot, cross-fade between them */}
        <div className="relative mt-1 flex h-8 w-[230px] items-end justify-center">
          <p
            aria-hidden={stage !== "hint"}
            className={`absolute inset-x-0 bottom-1.5 text-center text-[11px] lowercase tracking-[0.18em] text-[var(--term-dim)] transition-opacity duration-200 ${
              stage === "hint" ? "opacity-100 motion-safe:animate-pulse" : "pointer-events-none opacity-0"
            } ${ls.showHint ? "" : "hidden"}`}
          >
            click or type to unlock
          </p>
          <div
            ref={wrapRef}
            aria-hidden={stage !== "input"}
            className={`absolute inset-x-0 bottom-0 transition-all duration-200 ${
              stage === "input" ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0"
            }`}
          >
            {/* type="text" + css dot-masking, same trick as the gate: a real
                type="password" makes chrome pop its save-password bubble.
                name/id avoid password-ish tokens for the same reason. */}
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onInputKeyDown}
              aria-label="password"
              tabIndex={-1}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              name="murke-lock-input"
              id="murke-lock-input"
              className="h-7 w-full select-text border-b bg-transparent text-center font-mono text-[13px] tracking-[0.3em] text-[var(--term-fg)] outline-none"
              style={
                {
                  caretColor: "transparent",
                  WebkitTextSecurity: "disc",
                  borderBottomColor: err
                    ? "rgba(239, 68, 68, 0.6)"
                    : "color-mix(in srgb, var(--term-fg) 35%, transparent)",
                  opacity: checking ? 0.6 : 1,
                  transition: "opacity 150ms ease, border-color 180ms ease",
                } as React.CSSProperties
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
