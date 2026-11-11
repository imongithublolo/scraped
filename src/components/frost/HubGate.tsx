"use client";

/**
 * HubGate — the site everyone sees: hub.hertswoodacademy.org, fullscreen,
 * borderless. A real static rip of the hub served from our own origin
 * (public/hub/index.html): same-origin, instant, pixel-perfect — the live
 * hub is a Google Sites JS app whose runtime dies through any proxy relay
 * (broken rewrites → blank tiles), so the landing is a ripped snapshot
 * instead. Every link inside it opens a real new tab, exactly like the
 * school site would.
 *
 * There is no login screen, no logo, nothing. The konami code
 * (↑ ↑ ↓ ↓ ← → ← → B A) — typed on the hub page itself or on the parent —
 * fades in a hyper-minimal input capsule: one glass pill, no labels.
 * pokito00 → the Frost shell. Anything else → a quiet shake, emptied.
 * Escape → back to the hub, capsule gone, nothing ever happened.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { login, unlockProxyWorker } from "@/lib/murke/auth";
import { watchFrameKeys } from "@/lib/murke/frame-keys";
import { useKonamiHandler } from "./useKonami";

/** the ripped hub — same-origin static copy, served by this app itself */
export const HUB_RIP = "/hub/index.html";

export default function HubGate({ onAuth }: { onAuth: () => void }) {
  const [capsule, setCapsule] = useState(false);
  const [value, setValue] = useState("");
  const [shake, setShake] = useState(false);
  const [checking, setChecking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /* the konami code, heard on the parent window AND inside the hub frame —
     the rip is same-origin, so the frame-keys relay reaches it wherever
     focus sits */
  const konami = useKonamiHandler(
    useCallback(() => {
      setCapsule(true);
    }, []),
  );
  useEffect(() => {
    const relay = watchFrameKeys(konami);
    return () => relay.stop();
  }, [konami]);

  /* focus the capsule the moment it exists */
  useEffect(() => {
    if (!capsule) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [capsule]);

  const submit = useCallback(async () => {
    if (checking) return;
    const pw = value;
    if (!pw) return;
    setChecking(true);
    const res = await login(pw);
    setChecking(false);
    if (res) {
      // the password opened the gate — unlock the proxy's service worker
      // too (the in-memory token rides a postMessage; the SW verifies it)
      unlockProxyWorker();
      onAuth();
      return;
    }
    // quiet refusal — shake, empty, stay on the hub
    setValue("");
    setShake(true);
    window.setTimeout(() => setShake(false), 320);
  }, [value, checking, onAuth]);

  /* esc dismisses the capsule */
  useEffect(() => {
    if (!capsule) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setCapsule(false);
        setValue("");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capsule]);

  return (
    <main className="frost-root fixed inset-0 overflow-hidden bg-white" aria-label="hub">
      <iframe
        src={HUB_RIP}
        title="Student Hub"
        className="frost-full-screen"
        style={{ border: 0 }}
        allow="fullscreen"
      />

      {capsule && (
        <div className="frost-capsule-wrap" role="dialog" aria-label="authenticate">
          <form
            className={`frost-capsule frost-glass ${shake ? "frost-capsule-shake" : ""}`}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {/* type="text" + CSS disc masking: never wakes the password
                manager, looks identical to a password dot field */}
            <input
              ref={inputRef}
              type="text"
              value={value}
              disabled={checking}
              aria-label="password"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              name="frost-capsule-input"
              placeholder="······"
              style={{ WebkitTextSecurity: "disc" } as React.CSSProperties}
              onChange={(e) => setValue(e.target.value)}
            />
          </form>
        </div>
      )}
    </main>
  );
}
