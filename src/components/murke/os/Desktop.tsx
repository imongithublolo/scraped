"use client";

import { useEffect } from "react";
import { FileText, FolderOpen, Globe, Heart, HelpCircle, SquareTerminal } from "lucide-react";
import { useWm } from "@/lib/murke/wm";
import { getVfs } from "@/lib/murke/vfs";
import type { AppId, ThemeName } from "@/lib/murke/contracts";
import Window from "./Window";
import Taskbar from "./Taskbar";
import TerminalApp from "./apps/TerminalApp";
import BrowserApp from "./apps/BrowserApp";
import FilesApp from "./apps/FilesApp";
import ViewerApp from "./apps/ViewerApp";
import HelpApp from "./apps/HelpApp";
import CreditsApp from "./apps/CreditsApp";
import PaintPane from "../PaintPane";
import ChatPane from "../ChatPane";
import type { SoundEngine, SynthEngine, ProxyEngine } from "@/lib/murke/contracts";

const DESK_ICONS: Array<{ app: AppId; label: string; icon: typeof Globe }> = [
  { app: "terminal", label: "Terminal", icon: SquareTerminal },
  { app: "browser", label: "Browser", icon: Globe },
  { app: "files", label: "Files", icon: FolderOpen },
  { app: "help", label: "Help", icon: HelpCircle },
  { app: "credits", label: "Credits", icon: Heart },
  { app: "viewer", label: "Viewer", icon: FileText },
];

/**
 * DAEMON desktop: wallpaper, launcher icons, live windows, taskbar.
 */
export default function Desktop({
  sound,
  synth,
  proxy,
  theme,
  setTheme,
  crt,
  setCrt,
  onLogout,
}: {
  sound: SoundEngine;
  synth: SynthEngine;
  proxy: ProxyEngine;
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
  crt: boolean;
  setCrt: (v: boolean) => void;
  onLogout: () => void;
}) {
  const windows = useWm((s) => s.windows);
  const open = useWm((s) => s.open);

  /* keep the sandbox wisp relay alive (no-op outside dev) */
  useEffect(() => {
    const t = window.setTimeout(() => {
      void fetch("/api/relay", { method: "POST" }).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, []);

  const renderApp = (app: AppId, arg?: string, winId?: string, winNonce?: number) => {
    switch (app) {
      case "terminal":
        return (
          <TerminalApp
            sound={sound}
            synth={synth}
            proxy={proxy}
            theme={theme}
            setTheme={setTheme}
            crt={crt}
            setCrt={setCrt}
            onLogout={onLogout}
          />
        );
      case "browser":
        return <BrowserApp url={arg ?? "https://duckduckgo.com"} proxy={proxy} />;
      case "files":
        return <FilesApp />;
      case "viewer":
        return <ViewerApp path={arg ?? "~/readme.txt"} nonce={winNonce} onClose={winId ? () => useWm.getState().close(winId) : undefined} />;
      case "help":
        return <HelpApp />;
      case "credits":
        return <CreditsApp />;
      case "paint":
        return (
          <PaintPane
            onClose={winId ? () => useWm.getState().close(winId) : () => undefined}
            onSave={(name, content) => {
              const safe = name.replace(/[\/\\]/g, "_").slice(0, 64) || "untitled.txt";
              getVfs().writeFile("~/paintings/" + safe, content);
            }}
          />
        );
      case "chat":
        return <ChatPane onClose={winId ? () => useWm.getState().close(winId) : () => undefined} />;
    }
  };

  return (
    <div className="daemon-wall relative h-full w-full overflow-hidden">
      {/* faint sigil watermark */}
      <div
        className="pointer-events-none absolute inset-0 flex items-center justify-center select-none"
        aria-hidden="true"
      >
        <span
          className="text-[42vw] font-bold leading-none text-[color-mix(in_srgb,var(--term-brand)_7%,transparent)] sm:text-[30vw]"
          style={{ fontFamily: "var(--font-geist-mono), monospace" }}
        >
          ▲
        </span>
      </div>

      {/* desktop icons */}
      <nav className="absolute left-2 top-2 z-0 flex flex-col gap-1" aria-label="desktop shortcuts">
        {DESK_ICONS.map(({ app, label, icon: Icon }) => (
          <button
            key={app}
            className="daemon-desk-icon flex w-[86px] flex-col items-center gap-1 rounded-[3px] border border-transparent px-1 py-2 text-center font-mono text-[9.5px] uppercase tracking-[0.14em] text-[var(--term-fg)]"
            onClick={() => open(app)}
            onDoubleClick={() => open(app)}
            aria-label={`open ${label}`}
          >
            <Icon size={20} className="text-[var(--term-brand)]" aria-hidden="true" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </nav>

      {/* windows */}
      {windows.map((w) => (
        <Window key={w.id} win={w}>
          {renderApp(w.app, w.props.arg, w.id, w.props.nonce)}
        </Window>
      ))}

      <Taskbar sound={sound} proxy={proxy} crt={crt} setCrt={setCrt} onLock={onLogout} />
    </div>
  );
}
