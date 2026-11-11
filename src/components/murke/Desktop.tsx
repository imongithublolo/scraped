"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProxyEngine, SoundEngine, SynthEngine } from "@/lib/murke/contracts";
import { useOS } from "@/lib/murke/os-store";
import { resolveTheme, resolveThemeKey, themeVars } from "@/lib/murke/themes";
import { crtVars } from "@/lib/murke/crtfx";
import MenuBar from "./MenuBar";
import Dock from "./Dock";
import Taskbar from "./Taskbar";
import MacWindow from "./MacWindow";
import SnapPreview from "./SnapPreview";
import GlassDefs, { glassStyle } from "./GlassDefs";
import { useWmHotkeys } from "./wm-hotkeys";
import Wallpaper from "./Wallpaper";
import CrtFx from "./CrtFx";
import Dsh from "./Dsh";
import FilesPane from "./FilesPane";
import BrowserView from "./BrowserView";
import NotesPane from "./NotesPane";
import ChatPane from "./ChatPane";
import PaintPane from "./PaintPane";
import SettingsApp from "./SettingsApp";
import PreviewApp from "./PreviewApp";
import PwaAppView from "./PwaAppView";
import VmApp from "./VmApp";
import AdminApp from "./AdminApp";
import WatchApp from "./WatchApp";
import ControlChannel from "./ControlChannel";
import LockScreen from "./LockScreen";
import AddAppDialog, { requestAddApp } from "./AddAppDialog";
import { buildPresenceSnapshot, clientId } from "@/lib/murke/presence-snap";
import { getVfs } from "@/lib/murke/vfs";

export interface DesktopProps {
  sound: SoundEngine;
  synth: SynthEngine;
  proxy: ProxyEngine;
  onLogout: () => void;
}

/** stable-ish id for installed web apps */
function newAppId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID().slice(0, 8);
  } catch {
    /* fallthrough */
  }
  return Math.random().toString(36).slice(2, 10);
}

/** deterministic tile hue for an installed app (name+url) */
function appColor(name: string, url: string): string {
  let h = 0;
  const s = name + url;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 62% 52%)`;
}

/**
 * Desktop — the mac-style shell. Wallpaper under everything, app windows
 * floating above it, the dock at the bottom and the menu bar on top. The
 * terminal is just one of the apps. Owns: settings hydration, the theme
 * fade, WM hotkeys, run-in-shell plumbing, and the desktop right-click menu.
 */
export default function Desktop({ sound, synth, proxy, onLogout }: DesktopProps) {
  const settings = useOS((s) => s.settings);
  const windows = useOS((s) => s.windows);
  const activeId = useOS((s) => s.activeId);
  const openApp = useOS((s) => s.openApp);
  const hydrateSettings = useOS((s) => s.hydrateSettings);

  /* window-management hotkeys (super+arrows, alt+tab, …) */
  useWmHotkeys();

  /* restore persisted settings exactly once, before first paint of windows */
  useEffect(() => {
    hydrateSettings();
  }, [hydrateSettings]);

  /* first boot lands in the terminal — it's the heart of this machine */
  useEffect(() => {
    const t = window.setTimeout(() => openApp("dsh"), 60);
    return () => window.clearTimeout(t);
  }, [openApp]);

  /* ---------- presence ping — the admin app's "who is using" feed ----------
     every 25s the desktop posts a snapshot: browser search history + the
     files app listing + this device's stable id + what's open. the server
     pairs it with the request ip / user-agent. fails silently — presence
     is best-effort. the admin's live control channel (cursor / screen /
     kick) rides on its own loop in <ControlChannel>. */
  useEffect(() => {
    const ping = () => {
      try {
        const body = JSON.stringify({ id: clientId(), ...buildPresenceSnapshot() });
        void fetch("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
          cache: "no-store",
        }).catch(() => undefined);
      } catch {
        /* ignore */
      }
    };

    const first = window.setTimeout(ping, 4000);
    const iv = window.setInterval(ping, 25_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(iv);
    };
  }, []);

  /* ---------- popup capture — proxied frames never open REAL browser tabs ----------
     a frame's window.open / target=_blank dispatches "murke-capture-popup"
     { raw, winId }; decode it and route it to the top-most browser window as
     a new TAB — or a brand-new browser window when none is open. */
  useEffect(() => {
    const onCapture = (e: Event) => {
      const d = (e as CustomEvent<{ raw?: string; winId?: number }>).detail;
      const raw = (d?.raw ?? "").trim();
      if (!raw) return;
      let url = raw;
      try {
        const dec = proxy.decode?.(raw);
        if (dec) url = dec;
      } catch {
        /* keep the raw url */
      }
      const st = useOS.getState();
      const browserWins = st.windows
        .filter((w) => w.app === "browser" && !w.closing)
        .sort((a, b) => b.z - a.z);
      if (browserWins.length > 0) {
        const target = browserWins[0];
        st.focusWindow(target.id);
        window.dispatchEvent(new CustomEvent("murke-browser-open", { detail: { url, winId: target.id } }));
      } else {
        st.openApp("browser", url);
      }
    };
    window.addEventListener("murke-capture-popup", onCapture);
    return () => window.removeEventListener("murke-capture-popup", onCapture);
  }, [proxy]);

  /* keep every window inside the viewport when it resizes / rotates */
  useEffect(() => {
    let t = 0;
    const onResize = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => useOS.getState().reflowWindows(), 120);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  /* dock geometry changes (size / position / autohide) reflow the windows —
     and so does a SKIN swap (menu bar + dock vs taskbar reserves) */
  useEffect(() => {
    const unsub = useOS.subscribe((s, prev) => {
      if (
        s.settings.dock.iconSize !== prev.settings.dock.iconSize ||
        s.settings.dock.position !== prev.settings.dock.position ||
        s.settings.dock.autohide !== prev.settings.dock.autohide
      ) {
        useOS.getState().reflowWindows();
        return;
      }
      /* theme identity changed → the chrome may have changed with it */
      if (
        s.settings.theme !== prev.settings.theme ||
        s.settings.themeMode !== prev.settings.themeMode ||
        s.settings.customThemeId !== prev.settings.customThemeId
      ) {
        useOS.getState().reflowWindows();
      }
    });
    return unsub;
  }, []);

  /* theme fade — 200ms phosphor swap, driven straight from the store
     subscription (DOM-only: no re-render involved in the fade itself) */
  const fadeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = fadeRef.current;
    const unsub = useOS.subscribe((s, prev) => {
      const a = resolveThemeKey(s.settings);
      const b = resolveThemeKey(prev.settings);
      if (a === b) return;
      window.dispatchEvent(new CustomEvent("murke-theme", { detail: a }));
      if (!el) return;
      el.style.opacity = "0";
      window.setTimeout(() => {
        el.style.opacity = "1";
      }, 200);
    });
    return unsub;
  }, []);

  /* window controls overlay — when murke runs as an INSTALLED app with WCO,
     the native title-bar controls overlay the top of the screen; shift the
     menu bar below them via a css var (setting-gated, 0 when not installed) */
  useEffect(() => {
    type Wco = {
      visible: boolean;
      getTitlebarAreaRect(): DOMRect;
      addEventListener(t: string, cb: () => void): void;
      removeEventListener(t: string, cb: () => void): void;
    };
    const wco = (navigator as Navigator & { windowControlsOverlay?: Wco }).windowControlsOverlay;
    const apply = () => {
      const on = useOS.getState().settings.pwa.wco && (wco?.visible ?? false);
      const inset = on && wco ? Math.max(0, Math.round(wco.getTitlebarAreaRect().height)) : 0;
      document.documentElement.style.setProperty("--murke-wco-inset", `${inset}px`);
    };
    apply();
    const unsub = useOS.subscribe(apply);
    wco?.addEventListener("geometrychange", apply);
    return () => {
      unsub();
      wco?.removeEventListener("geometrychange", apply);
    };
  }, []);

  /* focus the terminal window, then run a command there (menu bar / dock help) */
  const runInShell = useCallback(
    (cmd: string) => {
      openApp("dsh");
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent("murke-run", { detail: cmd }));
      }, 180);
    },
    [openApp],
  );

  /* install-a-site-as-app (the browser's PWA addon) */
  const installApp = useCallback((name: string, url: string) => {
    useOS.getState().addCustomApp({ id: newAppId(), name, url, color: appColor(name, url) });
  }, []);

  /* ---------- the add-app dialog (desktop / dock / launchpad menus) ---------- */
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setAddOpen(true);
    window.addEventListener("murke-add-app", onOpen);
    return () => window.removeEventListener("murke-add-app", onOpen);
  }, []);

  /* ---------- desktop right-click menu ---------- */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ctxMenu]);

  const themeKey = resolveThemeKey(settings);
  const tdef = resolveTheme(settings);
  const light = Boolean(tdef.light);
  /** the active theme's desktop chrome — mac keeps menubar+dock, win ships
      the fluent taskbar */
  const skin = tdef.skin === "win" ? ("win" as const) : ("mac" as const);

  /* the shared glass surface var — app panes paint var(--glass-bg) so the
     window's backdrop-filter refracts the wallpaper through them */
  const glass = settings.glass;
  const glassBg = glass.enabled
    ? `color-mix(in srgb, ${tdef.bg} ${Math.max(42, 100 - glass.tint)}%, transparent)`
    : tdef.bg;

  const renderApp = (win: (typeof windows)[number]) => {
    switch (win.app) {
      case "dsh":
        return <Dsh sound={sound} synth={synth} proxy={proxy} onLogout={onLogout} />;
      case "files":
        return <FilesPane arg={win.arg} />;
      case "browser":
        return <BrowserView key={win.id} winId={win.id} url={win.arg ?? "murke://newtab"} proxy={proxy} sound={sound} onInstallApp={installApp} />;
      case "notes":
        return <NotesPane />;
      case "chat":
        return <ChatPane onClose={() => useOS.getState().closeWindow(win.id)} />;
      case "paint":
        return (
          <PaintPane
            onSave={(name, content) => {
              void (async () => {
                const safe = name.replace(/[\/\\]/g, "_").slice(0, 64) || "untitled.png";
                try {
                  const blob = await (await fetch(content)).blob();
                  const vfs = getVfs();
                  vfs.mkdir("~/Paintings", undefined, true);
                  const final = vfs.uniqueName("~/Paintings", safe);
                  const err = await vfs.writeFileBlob("~/Paintings/" + final, blob);
                  if (err) console.error("paint save:", err);
                } catch {
                  /* decode failure — ignore */
                }
              })();
            }}
          />
        );
      case "settings":
        return <SettingsApp sound={sound} proxy={proxy} />;
      case "preview":
        return <PreviewApp arg={win.arg} />;
      case "pwa":
        return <PwaAppView key={win.id} arg={win.arg} proxy={proxy} />;
      case "vm":
        return <VmApp key={win.id} vmName={win.arg ?? "vm"} onClose={() => useOS.getState().closeWindow(win.id)} />;
      case "admin":
        return <AdminApp />;
      case "watch":
        return <WatchApp arg={win.arg} onClose={() => useOS.getState().closeWindow(win.id)} />;
    }
  };

  return (
    <main
      className="murke-root fixed inset-0 overflow-hidden"
      style={{
        ...themeVars(tdef),
        ...crtVars(settings.crt, light),
        backgroundColor: tdef.bg,
        ["--glass-bg" as string]: glassBg,
      }}
      data-light={light ? "true" : undefined}
      data-skin={skin}
      aria-label="murke desktop"
      onContextMenu={(e) => {
        /* only the bare desktop gets the context menu — windows/apps keep theirs */
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* shared liquid-glass filter bank (SVG defs, paints nothing) */}
      <GlassDefs />

      {/* wallpaper */}
      <Wallpaper theme={themeKey} choice={settings.wallpaper} />

      {/* window layer — click-transparent so the bare desktop (wallpaper)
          still receives clicks + the right-click menu; windows opt back in */}
      <div ref={fadeRef} className="murke-fade pointer-events-none absolute inset-0 z-10">
        {windows.map((win) => (
          <MacWindow key={win.id} win={win} focused={win.id === activeId && !win.min} skin={skin}>
            {renderApp(win)}
          </MacWindow>
        ))}
      </div>

      {/* hyprland-style snap target preview */}
      <SnapPreview />

      {/* the shell chrome — the theme decides which desktop this is */}
      {skin === "win" ? (
        <Taskbar sound={sound} onToggleSound={() => sound.setEnabled(!sound.enabled)} onLogout={onLogout} />
      ) : (
        <>
          <MenuBar sound={sound} onToggleSound={() => sound.setEnabled(!sound.enabled)} runInShell={runInShell} onLogout={onLogout} />
          <Dock />
        </>
      )}

      {/* desktop right-click menu */}
      {ctxMenu && (
        <div
          role="menu"
          aria-label="desktop menu"
          className="absolute z-[90] min-w-[190px] rounded-md border py-1 font-mono shadow-[0_14px_40px_rgba(0,0,0,0.6)]"
          style={{
            ...glassStyle(false),
            left: Math.min(ctxMenu.x, (typeof window !== "undefined" ? window.innerWidth : 1280) - 210),
            top: Math.min(ctxMenu.y, (typeof window !== "undefined" ? window.innerHeight : 800) - 170),
            borderColor: "color-mix(in srgb, var(--term-fg) 14%, transparent)",
            background: "color-mix(in srgb, var(--term-bg) 88%, transparent)",
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {[
            { label: "add app…", fn: () => requestAddApp() },
            { label: "change wallpaper…", fn: () => openApp("settings", "wallpaper") },
            { label: light ? "switch to dark" : "switch to light", fn: () => useOS.getState().toggleThemeMode() },
            { label: "dock settings…", fn: () => openApp("settings", "dock") },
            { label: "open settings…", fn: () => openApp("settings") },
            { label: "new terminal window", fn: () => openApp("dsh") },
            { label: "about this machine", fn: () => openApp("settings", "about") },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setCtxMenu(null);
                item.fn();
              }}
              className="flex w-full cursor-pointer items-center px-3 py-[7px] text-left text-[11.5px] lowercase tracking-wide text-[color-mix(in_srgb,var(--term-fg)_88%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-brand)_22%,transparent)] hover:text-[var(--term-fg)]"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}

      {/* the tube — above everything, never intercepts */}
      <CrtFx crt={settings.crt} light={light} />

      {/* the admin's live hand — cursor / notices / screen view / kick */}
      <ControlChannel onLogout={onLogout} />

      {/* mac-style lock screen — the tab losing focus locks the machine */}
      <LockScreen />

      {/* add app — one dialog for the desktop, dock and launchpad menus */}
      <AddAppDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </main>
  );
}
