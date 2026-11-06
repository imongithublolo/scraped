"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  FolderOpen,
  Globe,
  HelpCircle,
  Heart,
  MessageSquare,
  Palette,
  SquareTerminal,
  Lock,
  Volume2,
  VolumeX,
  Tv,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useWm, type WinState } from "@/lib/murke/wm";
import type { AppId, ProxyEngine, SoundEngine } from "@/lib/murke/contracts";

const APP_LIST: Array<{ app: AppId; label: string; icon: typeof Globe }> = [
  { app: "terminal", label: "Terminal", icon: SquareTerminal },
  { app: "browser", label: "Browser", icon: Globe },
  { app: "files", label: "File Manager", icon: FolderOpen },
  { app: "help", label: "Help", icon: HelpCircle },
  { app: "credits", label: "Credits", icon: Heart },
  { app: "paint", label: "Paint", icon: Palette },
  { app: "chat", label: "Chat", icon: MessageSquare },
  { app: "viewer", label: "File Viewer", icon: FileText },
];

function AppIcon({ app, className }: { app: AppId; className?: string }) {
  const item = APP_LIST.find((a) => a.app === app);
  const Icon = item?.icon ?? FileText;
  return <Icon className={className} size={13} aria-hidden="true" />;
}

/**
 * Bottom taskbar: sigil start-menu, open-window buttons, status tray.
 */
export default function Taskbar({
  sound,
  proxy,
  crt,
  setCrt,
  onLock,
}: {
  sound: SoundEngine;
  proxy: ProxyEngine;
  crt: boolean;
  setCrt: (v: boolean) => void;
  onLock: () => void;
}) {
  const { windows, activeId, open, toggleMinimize } = useWm();
  const [menuOpen, setMenuOpen] = useState(false);
  const [clock, setClock] = useState("--:--:--");
  const [wisp, setWisp] = useState<{ ok: boolean; ms?: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const iv = setInterval(() => setClock(new Date().toLocaleTimeString("en-GB", { hour12: false })), 500);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    let dead = false;
    const probe = async () => {
      const s = await proxy.status();
      if (!dead) setWisp({ ok: s.ok, ms: s.latencyMs });
    };
    const t = window.setTimeout(probe, 1200);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [proxy]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  const launch = (app: AppId) => {
    open(app);
    setMenuOpen(false);
  };

  const visible = useMemo(() => windows.filter((w) => !w.minimized).length, [windows]);

  const winBtn = (w: WinState) => {
    const isActive = activeId === w.id && !w.minimized;
    return (
      <button
        key={w.id}
        className={`daemon-taskbtn flex h-9 min-w-0 max-w-[170px] flex-1 items-center gap-1.5 border-b-2 border-transparent px-2 font-mono text-[10.5px] text-[var(--term-fg)] sm:max-w-[200px] ${
          isActive ? "daemon-taskbtn-active" : w.minimized ? "opacity-55" : ""
        }`}
        onClick={() => toggleMinimize(w.id)}
        title={w.title}
        aria-pressed={isActive}
      >
        <AppIcon app={w.app} />
        <span className="truncate uppercase tracking-[0.12em]">{w.title}</span>
      </button>
    );
  };

  return (
    <>
      {/* start menu */}
      {menuOpen && (
        <div
          ref={menuRef}
          className="daemon-startmenu absolute bottom-[52px] left-2 z-[9000] w-[240px] rounded-[3px] p-1.5"
          role="menu"
          aria-label="applications"
        >
          <div className="mb-1 px-2 py-1 font-mono text-[9.5px] tracking-[0.3em] text-[var(--term-dim)]">
            DAEMON//OS — APPS
          </div>
          {APP_LIST.filter((a) => a.app !== "viewer").map(({ app, label, icon: Icon }) => (
            <button
              key={app}
              className="daemon-startitem flex w-full items-center gap-2.5 rounded-[2px] px-2 py-2 text-left font-mono text-[11px] text-[var(--term-fg)]"
              onClick={() => launch(app)}
              role="menuitem"
            >
              <Icon size={14} className="shrink-0 text-[var(--term-brand)]" aria-hidden="true" />
              <span className="uppercase tracking-[0.14em]">{label}</span>
            </button>
          ))}
          <div className="my-1 border-t border-[color-mix(in_srgb,var(--term-brand)_25%,transparent)]" />
          <button
            className="daemon-startitem flex w-full items-center gap-2.5 rounded-[2px] px-2 py-2 text-left font-mono text-[11px] text-[var(--term-err)]"
            onClick={() => {
              setMenuOpen(false);
              onLock();
            }}
            role="menuitem"
          >
            <Lock size={14} className="shrink-0" aria-hidden="true" />
            <span className="uppercase tracking-[0.14em]">Lock</span>
          </button>
        </div>
      )}

      <footer
        className="daemon-taskbar absolute inset-x-0 bottom-0 z-[8000] flex h-12 items-stretch gap-1 px-1.5 pb-[env(safe-area-inset-bottom)]"
        aria-label="taskbar"
      >
        {/* start */}
        <button
          className="daemon-taskbtn flex w-11 items-center justify-center rounded-[2px]"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-label="start menu"
          title="start"
        >
          <span
            className="text-[17px] leading-none text-[var(--term-brand)]"
            style={{ filter: "drop-shadow(0 0 7px color-mix(in srgb, var(--term-brand) 75%, transparent))" }}
            aria-hidden="true"
          >
            ▲
          </span>
        </button>

        {/* open windows */}
        <div className="flex min-w-0 flex-1 items-stretch gap-1">{windows.map(winBtn)}</div>

        {/* tray */}
        <div className="flex shrink-0 items-center gap-1.5 px-1 font-mono text-[10px] text-[var(--term-dim)]">
          {visible > 0 && <span className="hidden sm:inline">{visible} win</span>}
          <button
            className="daemon-taskbtn flex h-8 items-center gap-1 rounded-[2px] px-1.5"
            onClick={() => sound.setEnabled(!sound.enabled)}
            aria-label={sound.enabled ? "mute keys" : "unmute keys"}
            title={`keyboard sfx ${sound.enabled ? "on" : "off"} (off by default)`}
          >
            {sound.enabled ? (
              <Volume2 size={13} className="text-[var(--term-fg)]" aria-hidden="true" />
            ) : (
              <VolumeX size={13} aria-hidden="true" />
            )}
          </button>
          <button
            className="daemon-taskbtn flex h-8 items-center gap-1 rounded-[2px] px-1.5"
            onClick={() => setCrt(!crt)}
            aria-pressed={crt}
            aria-label="toggle scanlines"
            title={`scanlines ${crt ? "on" : "off"}`}
          >
            <Tv size={13} className={crt ? "text-[var(--term-fg)]" : ""} aria-hidden="true" />
          </button>
          <span
            className="flex h-8 items-center gap-1 px-0.5"
            title={wisp ? (wisp.ok ? `wisp relay ok${wisp.ms != null ? ` · ${wisp.ms}ms` : ""}` : "wisp relay offline") : "probing relay…"}
          >
            {wisp?.ok ? (
              <Wifi size={13} className="text-[#3f7a44]" aria-hidden="true" />
            ) : (
              <WifiOff size={13} className="text-[var(--term-err)]" aria-hidden="true" />
            )}
            {wisp?.ok && wisp.ms != null && <span className="hidden md:inline">{wisp.ms}ms</span>}
          </span>
          <span className="tabular-nums tracking-[0.08em] text-[var(--term-fg)]">{clock}</span>
        </div>
      </footer>
    </>
  );
}
