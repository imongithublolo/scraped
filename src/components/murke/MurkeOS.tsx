"use client";

import { useCallback, useEffect, useState } from "react";
import GateScreen from "./GateScreen";
import BootScreen from "./BootScreen";
import Desktop from "./Desktop";
import { MechanicalSound } from "@/lib/murke/sound";
import { ChiptuneSynth } from "@/lib/murke/synth";
import { ScramjetProxy } from "@/lib/murke/proxy";
import { wipeSession } from "@/lib/murke/auth";
import { bootRef } from "@/lib/murke/commands";
import { ensureVfs } from "@/lib/murke/vfs";
import SimpleProxy from "./SimpleProxy";
import type { ProxyEngine, SoundEngine, SynthEngine, ThemeName } from "@/lib/murke/contracts";
import { LS } from "@/lib/murke/contracts";
import { isThemeName } from "@/lib/murke/themes";

/* Engine singletons — no React state involved. */
let soundEngine: SoundEngine | null = null;
let synthEngine: SynthEngine | null = null;
let proxyEngine: ProxyEngine | null = null;
function ensureEngines(): void {
  if (!soundEngine) soundEngine = new MechanicalSound();
  if (!synthEngine) synthEngine = new ChiptuneSynth();
  if (!proxyEngine) proxyEngine = new ScramjetProxy();
}

/**
 * Murke OS — phase machine: blank gate → boot ceremony → the DESKTOP.
 *
 * The gate is MEMORYLESS: every fresh page load starts from blank and the
 * password is demanded again. Nothing about the session survives — only the
 * harmless preferences (theme / crt / wallpaper) persist via the OS store.
 * The shared engine instances live here; the desktop owns windows, dock,
 * menu bar, wallpaper and the CRT tube.
 */
export default function MurkeOS() {
  const [phase, setPhase] = useState<"gate" | "boot" | "shell">("gate");
  /** the ..0 door — proxy only, never the OS; no boot ceremony, no vfs wait */
  const [lite, setLite] = useState(false);
  /** true once the IndexedDB file system is loaded — the shell must not
      render before this or the terminal/files app would flash the seed tree */
  const [vfsReady, setVfsReady] = useState(false);

  /* scrub any session artifacts + load the fs */
  useEffect(() => {
    let alive = true;
    void ensureVfs().then(() => {
      if (alive) setVfsReady(true);
    });
    void (async () => {
      await Promise.resolve();
      wipeSession();
    })();
    return () => {
      alive = false;
    };
  }, []);

  const onAuth = useCallback((lite?: boolean) => {
    ensureEngines();
    if (lite) {
      // the lite door — straight into the borderless proxy: no boot, no OS
      setLite(true);
      setPhase("shell");
      return;
    }
    setLite(false);
    setPhase("boot");
  }, []);

  const onBootDone = useCallback(() => {
    bootRef.at = Date.now();
    // the boot ceremony outlasts the IDB load in practice; if it somehow
    // hasn't, hold the boot screen until the file system is final
    void ensureVfs().then(() => setPhase("shell"));
  }, []);

  const onLogout = useCallback(() => {
    wipeSession();
    synthEngine?.stop();
    setLite(false);
    setPhase("gate");
  }, []);

  /* the lite door skips the boot screen AND the vfs wait — the proxy needs
     neither, and every extra pixel of murke chrome would give it away */
  if (phase === "shell" && lite) {
    ensureEngines();
    return (
      <SimpleProxy
        sound={soundEngine!}
        synth={synthEngine!}
        proxy={proxyEngine!}
        onLogout={onLogout}
        lite
      />
    );
  }

  if (phase === "gate") {
    return <GateScreen onAuth={onAuth} />;
  }

  /* boot screen stays up until both the ceremony AND the fs hydrate finish */
  if (phase === "boot" || !vfsReady) {
    /* the persisted theme colors the boot screen (settings may not be
       hydrated into the store yet — read the blob directly) */
    let theme: ThemeName = "hell";
    try {
      const raw = localStorage.getItem(LS.settings);
      if (raw) {
        const s = JSON.parse(raw) as { theme?: string };
        if (typeof s.theme === "string" && isThemeName(s.theme)) theme = s.theme;
      }
    } catch {
      /* ignore */
    }
    return <BootScreen onDone={onBootDone} theme={theme} />;
  }

  /* Engines must exist for every non-gate render — idempotent, so calling it
     here too makes the shell immune to module reloads nulling the cache. */
  ensureEngines();
  const sound = soundEngine!;
  const synth = synthEngine!;
  const proxy = proxyEngine!;

  return <Desktop sound={sound} synth={synth} proxy={proxy} onLogout={onLogout} />;
}
