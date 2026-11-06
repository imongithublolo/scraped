"use client";

/**
 * FrostOS — the whole site:
 *
 *   1. HUB — everyone lands on hub.hertswoodacademy.org, fullscreen,
 *      borderless: a static rip of the real hub from our own origin.
 *      This is the site. Nothing else loads — no proxy, no engine.
 *   2. KONAMI (↑ ↑ ↓ ↓ ← → ← → B A) — anywhere (hub page included) fades
 *      in the hyper-minimal input capsule.
 *   3. pokito00 — the capsule dissolves into the BOOT: pure black, the
 *      snowflake mark, a Mac-style progress bar — and in that window
 *      every asset the shell needs (wallpapers, marks, the oneko sprite,
 *      the HomeStage chunk) warms, so the world after it is snappy.
 *   4. The bar fills → the Frost home: the glass search bar, shortcuts,
 *      widgets, the borderless proxy, floating corner controls. No
 *      chrome, no waiting.
 *
 * Memoryless: every fresh load starts back on the hub.
 */

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import FrostBoot from "./FrostBoot";
import HubGate from "./HubGate";

const HomeStage = dynamic(() => import("./HomeStage"), {
  ssr: false,
  loading: () => null,
});

type Phase = "hub" | "boot" | "home";

export default function FrostOS() {
  const [phase, setPhase] = useState<Phase>("hub");

  /* INSTANT WORKER REFRESH — every site open pings the service worker
     for an update RIGHT NOW (browsers otherwise check on their own
     schedule, up to a day late). A new deploy's sw.js answers, the
     worker swaps in (skipWaiting) and purges the old caches on
     activate — the new offline mode is live from this visit on. */
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const t = window.setTimeout(() => {
      navigator.serviceWorker
        .getRegistration()
        .then((r) => (r ? r.update() : undefined))
        .catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(t);
  }, []);

  /* the password unlocks the boot sequence — the hub IS the first paint,
     the boot animation is the bridge into the shell */
  const onAuth = useCallback(() => setPhase((p) => (p === "hub" ? "boot" : p)), []);
  const onBoot = useCallback(() => setPhase("home"), []);

  if (phase === "hub") {
    return <HubGate onAuth={onAuth} />;
  }
  if (phase === "boot") {
    return <FrostBoot onDone={onBoot} />;
  }
  return <HomeStage />;
}
