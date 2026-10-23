"use client";

import { useCallback, useEffect, useState } from "react";
import GateScreen from "./GateScreen";
import BootScreen from "./BootScreen";
import Dsh from "./Dsh";
import CrtOverlay from "./CrtOverlay";
import ThemeBackground from "./ThemeBackground";
import { MechanicalSound } from "@/lib/murke/sound";
import { ChiptuneSynth } from "@/lib/murke/synth";
import { ScramjetProxy } from "@/lib/murke/proxy";
import { wipeSession } from "@/lib/murke/auth";
import { bootRef } from "@/lib/murke/commands";
import { ensureVfs } from "@/lib/murke/vfs";
import type { ProxyEngine, SoundEngine, SynthEngine, ThemeName } from "@/lib/murke/contracts";
import { LS } from "@/lib/murke/contracts";
import { THEMES, isThemeName, themeVars } from "@/lib/murke/themes";

interface Settings {
  theme: ThemeName;
  crt: boolean;
}

const DEFAULT_SETTINGS: Settings = { theme: "hell", crt: true };

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
 * Murke Proxy — phase machine: blank gate → boot ceremony → fullscreen dsh.
 *
 * The gate is MEMORYLESS: every fresh page load starts from blank and the
 * password is demanded again. Nothing about the session survives — only the
 * harmless preferences (theme / crt) persist. The 200ms phosphor fade and
 * the shared engine instances live here.
 */
export default function MurkeOS() {
  const [phase, setPhase] = useState<"gate" | "boot" | "shell">("gate");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [fading, setFading] = useState(false);
  /** true once the saved look preferences have been read from storage —
      the persist effect must not run before this or it clobbers the saved
      theme with the default before the restore ever sees it */
  const [hydrated, setHydrated] = useState(false);
  /** true once the IndexedDB file system is loaded — the shell must not
      render before this or the terminal/files app would flash the seed tree */
  const [vfsReady, setVfsReady] = useState(false);
  const { theme, crt } = settings;

  /* scrub any session artifacts + restore look preferences + load the fs */
  useEffect(() => {
    let alive = true;
    void ensureVfs().then(() => {
      if (alive) setVfsReady(true);
    });
    void (async () => {
      await Promise.resolve();
      wipeSession();
      try {
        const raw = localStorage.getItem(LS.settings);
        if (raw) {
          const s = JSON.parse(raw) as Partial<Settings>;
          if (typeof s.theme === "string" && isThemeName(s.theme) && typeof s.crt === "boolean") {
            if (alive) setSettings({ theme: s.theme, crt: s.crt });
          }
        }
      } catch {
        /* ignore */
      } finally {
        if (alive) setHydrated(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* persist whenever settings change (only after the restore tick) */
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(LS.settings, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings, hydrated]);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  /** Theme switch: fade the screen out for 200ms, swap phosphor, fade back in. */
  const setTheme = useCallback(
    (t: ThemeName) => {
      setFading(true);
      // announce the switch — theme-less listeners (globes, panes) follow it
      window.dispatchEvent(new CustomEvent("murke-theme", { detail: t }));
      window.setTimeout(() => {
        updateSettings({ theme: t });
        setFading(false);
      }, 200);
    },
    [updateSettings]
  );

  const setCrt = useCallback((v: boolean) => updateSettings({ crt: v }), [updateSettings]);

  const onAuth = useCallback(() => {
    ensureEngines();
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
    setPhase("gate");
  }, []);

  if (phase === "gate") {
    return <GateScreen onAuth={onAuth} />;
  }

  /* boot screen stays up until both the ceremony AND the fs hydrate finish */
  if (phase === "boot" || !vfsReady) {
    return <BootScreen onDone={onBootDone} theme={theme} />;
  }

  /* Engines must exist for every non-gate render — idempotent, so calling it
     here too makes the shell immune to module reloads nulling the cache. */
  ensureEngines();
  const sound = soundEngine!;
  const synth = synthEngine!;
  const proxy = proxyEngine!;
  const tdef = THEMES[theme];
  const hasBg = tdef.bgKind !== "none";

  return (
    <main
      className="murke-root fixed inset-0 flex min-h-screen flex-col overflow-hidden"
      style={{
        ...themeVars(theme),
        /* translucent phosphor glass — the backdrop bleeds through; text wins
           because every scene shader keeps its own brightness down */
        backgroundColor: hasBg ? "color-mix(in srgb, var(--term-bg) 88%, transparent)" : tdef.bg,
      }}
      data-bare={tdef.bare ? "true" : undefined}
      aria-label="murke proxy terminal"
    >
      {/* themed backdrop (shell owns the full screen after boot) */}
      {hasBg && <ThemeBackground key={theme} theme={theme} />}
      {/* ember scrim — output text near the floor must stay legible over the scene */}
      {phase === "shell" && hasBg && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-52 bg-gradient-to-t from-[color-mix(in_srgb,var(--term-bg)_78%,transparent)] to-transparent"
          aria-hidden="true"
        />
      )}
      {/* no flicker here: whole-layer opacity animations composite the iframe
          every frame while browsing — the single biggest "proxy feels slow" tax */}
      <div className={`murke-fade relative z-10 min-h-0 flex-1 ${fading ? "opacity-0" : "opacity-100"}`}>
        <Dsh
          sound={sound}
          synth={synth}
          proxy={proxy}
          theme={theme}
          setTheme={setTheme}
          crt={crt}
          setCrt={setCrt}
          onLogout={onLogout}
        />
      </div>
      {crt && !tdef.bare && <CrtOverlay />}
    </main>
  );
}
