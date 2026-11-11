"use client";

/**
 * Taskbar — the WINDOWS skin's whole shell. Where the mac skin has a top
 * menu bar + floating dock, the windows theme ships THIS: one full-width
 * fluent strip pinned to the bottom edge.
 *
 *  - centered cluster: start (theme-tinted windows glyph) + every app +
 *    separator + settings; hover raises a soft tile, running apps carry a
 *    small underline (brand + wider when active) — win11 convention
 *  - right tray: key sounds, crt, and the stacked clock (time over date)
 *  - start menu: acrylic panel with a working search filter, the pinned
 *    grid, and a footer with the user chip + quick dark/light + power
 *  - everything speaks the same OS store the dock does — click to launch,
 *    click a running app to minimize/restore
 *  - chrome font is Segoe (var(--chrome-font)) — the skin owns the type too
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ScanLine,
  Volume2,
  VolumeX,
  Search,
  Power,
  Settings as SettingsIcon,
  Moon,
  Sun,
  FileText,
  type LucideIcon,
} from "lucide-react";
import type { AppId, CustomApp, SoundEngine, TaskbarSettings } from "@/lib/murke/contracts";
import { DOCK_APPS } from "./Dock";
import AppIcon, { PwaIcon } from "./AppIcon";
import { FrostLayer } from "./GlassDefs";
import { TrayBattery, TrayBluetooth, TrayWifi } from "./SystemTray";
import { useOS } from "@/lib/murke/os-store";

/* ---------- glyph: the windows flag, drawn in the theme brand ---------- */
function WinGlyph({ size = 15 }: { size?: number }) {
  const cell = Math.round(size * 0.42);
  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0"
      style={{ gridTemplateColumns: `${cell}px ${cell}px`, gap: Math.max(1.5, size * 0.09) }}
    >
      {Array.from({ length: 4 }).map((_, i) => (
        <span key={i} className="rounded-[1.5px]" style={{ width: cell, height: cell, background: "var(--term-brand)" }} />
      ))}
    </span>
  );
}

/* ---------- one taskbar button ---------- */
function TaskButton({
  label,
  running,
  active,
  onClick,
  icon: Icon,
  appId,
  custom,
  letter,
  color,
  iconSize,
}: {
  label: string;
  running: boolean;
  active: boolean;
  onClick: () => void;
  icon?: LucideIcon;
  /** the real icon art (AppIcon) when provided and theming is off */
  appId?: AppId;
  /** installed web app — the site's actual favicon */
  custom?: CustomApp;
  letter?: string;
  color?: string;
  iconSize: number;
}) {
  const themeIcons = useOS((s) => s.settings.dock.themeIcons);
  const iconGlass = useOS((s) => s.settings.glass.enabled && s.settings.glass.iconGlass);
  const glyph = Math.round(iconSize * (iconSize >= 20 ? 1.05 : 1.1));
  const realIcon = custom ? (
    <PwaIcon url={custom.url} name={custom.name} size={glyph} skin="win" theme={themeIcons} glass={iconGlass} icon={custom.icon} />
  ) : appId && !themeIcons ? (
    <AppIcon app={appId} size={glyph} skin="win" theme={false} glass={iconGlass} />
  ) : null;
  return (
    <button
      type="button"
      aria-label={`${label}${running ? " — running" : ""}`}
      title={label}
      onClick={onClick}
      className="group relative flex h-[40px] w-9 cursor-pointer flex-col items-center justify-center rounded-md transition-colors sm:w-[44px]"
      style={{ background: "transparent" }}
      onPointerEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--term-fg) 9%, transparent)")}
      onPointerLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {realIcon ? (
        <span className="sm:hidden" aria-hidden="true">{realIcon}</span>
      ) : Icon ? (
        <Icon size={glyph - 2} strokeWidth={1.7} aria-hidden="true" className="sm:hidden" style={{ color: "var(--term-fg)" }} />
      ) : (
        <span
          aria-hidden="true"
          className="flex items-center justify-center rounded-[5px] font-bold text-white sm:hidden"
          style={{ width: glyph - 2, height: glyph - 2, fontSize: glyph * 0.52, background: color ?? "var(--term-brand)" }}
        >
          {letter}
        </span>
      )}
      {realIcon ? (
        <span className="hidden sm:block" aria-hidden="true">{realIcon}</span>
      ) : Icon ? (
        <Icon size={glyph} strokeWidth={1.7} aria-hidden="true" className="hidden sm:block" style={{ color: "var(--term-fg)" }} />
      ) : (
        <span
          aria-hidden="true"
          className="hidden items-center justify-center rounded-[5px] font-bold text-white sm:flex"
          style={{ width: glyph, height: glyph, fontSize: glyph * 0.52, background: color ?? "var(--term-brand)" }}
        >
          {letter}
        </span>
      )}
      {/* running underline — win11 style */}
      <span
        aria-hidden="true"
        className="absolute bottom-[3px] rounded-full transition-all"
        style={{
          width: active ? 16 : running ? 7 : 0,
          height: 3,
          backgroundColor: active ? "var(--term-brand)" : "color-mix(in srgb, var(--term-fg) 55%, transparent)",
          opacity: running ? 1 : 0,
        }}
      />
    </button>
  );
}

/* start-menu tile — the dock's OWN icon art (AppIcon/PwaIcon, same glass +
   translucent treatment), just at start-menu size */
function StartTile({ appId, custom }: { appId?: AppId; custom?: CustomApp }) {
  const themeIcons = useOS((s) => s.settings.dock.themeIcons);
  const iconGlass = useOS((s) => s.settings.glass.enabled && s.settings.glass.iconGlass);
  if (custom) {
    return <PwaIcon url={custom.url} name={custom.name} size={34} skin="win" theme={themeIcons} glass={iconGlass} icon={custom.icon} />;
  }
  if (appId) return <AppIcon app={appId} size={34} skin="win" glass={iconGlass} translucent theme={themeIcons} />;
  return null;
}

/* ---------- start menu ---------- */
function StartMenu({
  onClose,
  onLogout,
  barHeight,
}: {
  onClose: () => void;
  onLogout: () => void;
  /** rides the live taskbar height so the menu never overlaps the bar */
  barHeight: number;
}) {
  const [q, setQ] = useState("");
  const customApps = useOS((s) => s.settings.customApps);
  const themeMode = useOS((s) => s.settings.themeMode);
  const openApp = useOS((s) => s.openApp);
  const menuRef = useRef<HTMLDivElement>(null);
  const [recent, setRecent] = useState<Array<{ path: string; mtime: number; dir: boolean }>>([]);

  /* outside pointerdown + Esc dismiss (capture, like the menubar) */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  /* recommended — the freshest files in the user's own file system */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const { ensureVfs } = await import("@/lib/murke/vfs");
        const vfs = await ensureVfs();
        const out: Array<{ path: string; mtime: number; dir: boolean }> = [];
        const walk = (p: string, depth: number) => {
          if (depth > 4 || out.length > 80) return;
          let nodes: ReturnType<typeof vfs.list> = [];
          try {
            nodes = vfs.list(p);
          } catch {
            return;
          }
          for (const n of nodes) {
            if (n.name.startsWith(".")) continue;
            const fp = `${p === "/" ? "" : p}/${n.name}`;
            if (n.type === "dir") walk(fp, depth + 1);
            else out.push({ path: fp, mtime: n.mtime, dir: false });
          }
        };
        walk(vfs.HOME, 0);
        out.sort((a, b) => b.mtime - a.mtime);
        if (alive) setRecent(out.slice(0, 6));
      } catch {
        /* fs unavailable — recommended stays empty */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const go = useCallback(
    (app: AppId, arg?: string) => {
      openApp(app, arg);
      onClose();
    },
    [openApp, onClose],
  );

  const goCustom = useCallback(
    (app: CustomApp) => {
      openApp("pwa", app.id);
      onClose();
    },
    [openApp, onClose],
  );

  /* every app the dock has (same icons, same labels) + youtube + settings */
  const pins: Array<{ key: string; label: string; appId?: AppId; custom?: CustomApp; run: () => void }> = [
    ...DOCK_APPS.map((a) => ({ key: a.id, label: a.label, appId: a.id, run: () => go(a.id) })),
    { key: "watch", label: "youtube", appId: "watch" as AppId, run: () => go("watch") },
    { key: "settings", label: "settings", appId: "settings" as AppId, run: () => go("settings") },
    ...customApps.map((a) => ({
      key: a.id,
      label: a.name,
      custom: a,
      run: () => goCustom(a),
    })),
  ];
  const needle = q.trim().toLowerCase();
  const shownPins = needle ? pins.filter((p) => p.label.toLowerCase().includes(needle)) : pins;
  const shownRecent = (needle ? recent.filter((r) => r.path.toLowerCase().includes(needle)) : recent).slice(0, 6);
  const firstPin = shownPins[0];
  const firstFile = shownRecent[0];

  return (
    <div
      ref={menuRef}
      role="dialog"
      aria-label="start menu"
      data-start-menu=""
      className="absolute left-1/2 z-[95] w-[600px] max-w-[94vw] -translate-x-1/2 overflow-hidden rounded-xl border shadow-[0_24px_70px_rgba(0,0,0,0.5)]"
      style={{
        fontFamily: "var(--chrome-font)",
        bottom: barHeight + 8,
        borderColor: "color-mix(in srgb, var(--term-fg) 12%, transparent)",
        background: "color-mix(in srgb, var(--term-bg) 88%, transparent)",
        /* frost lives on the FrostLayer sibling below — a panel-level
           backdrop-filter would blind the glass icon tiles inside */
      }}
    >
      <FrostLayer filter="blur(28px) saturate(1.5)" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (firstPin) firstPin.run();
          else if (firstFile) go(firstFile.dir ? "files" : "preview", firstFile.path);
        }}
        className="relative"
      >
        {/* search */}
        <div className="px-6 pt-5">
          <div
            className="flex items-center gap-2 rounded-full border px-3.5 py-[7px]"
            style={{ borderColor: "color-mix(in srgb, var(--term-fg) 14%, transparent)", background: "color-mix(in srgb, var(--term-fg) 5%, transparent)" }}
          >
            <Search size={14} aria-hidden="true" className="shrink-0 text-[var(--term-dim)]" />
            <input
              autoFocus
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="search apps and files"
              aria-label="search apps and files"
              className="w-full bg-transparent text-[13px] text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)]"
            />
          </div>
        </div>

        {/* pinned grid — every dock app, same art as the dock */}
        <div className="px-6 pb-3 pt-4">
          <div className="mb-2.5 flex items-baseline justify-between">
            <span className="text-[12.5px] font-semibold text-[var(--term-fg)]">pinned</span>
            <span className="text-[11px] text-[var(--term-dim)]">{shownPins.length} app{shownPins.length === 1 ? "" : "s"}</span>
          </div>
          {shownPins.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-[12px] text-[var(--term-dim)]" style={{ borderColor: "color-mix(in srgb, var(--term-fg) 16%, transparent)" }}>
              no apps match “{q}”
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-1 sm:grid-cols-6">
              {shownPins.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={p.run}
                  className="flex cursor-pointer flex-col items-center gap-1.5 rounded-md px-1 py-3 transition-colors"
                  onPointerEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--term-fg) 8%, transparent)")}
                  onPointerLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  {p.custom ? <StartTile custom={p.custom} /> : <StartTile appId={p.appId} />}
                  <span className="w-full truncate text-center text-[11px] text-[color-mix(in_srgb,var(--term-fg)_82%,transparent)]">{p.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* recommended — recent files, straight into previews */}
        <div className="px-6 pb-4">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[12.5px] font-semibold text-[var(--term-fg)]">recommended</span>
            <span className="text-[11px] text-[var(--term-dim)]">recent files</span>
          </div>
          {shownRecent.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-[12px] text-[var(--term-dim)]" style={{ borderColor: "color-mix(in srgb, var(--term-fg) 16%, transparent)" }}>
              {needle ? "no files match" : "nothing yet — files you touch land here"}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {shownRecent.map((r) => {
                const name = r.path.split("/").pop() ?? r.path;
                const dir = r.path.replace(/\/[^/]+$/, "") || "/";
                return (
                  <button
                    key={r.path}
                    type="button"
                    onClick={() => go(r.dir ? "files" : "preview", r.path)}
                    className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors"
                    onPointerEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--term-fg) 8%, transparent)")}
                    onPointerLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <FileText size={17} strokeWidth={1.7} aria-hidden="true" className="shrink-0 text-[var(--term-brand)]" />
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] leading-tight text-[var(--term-fg)]">{name}</span>
                      <span className="block truncate text-[10px] leading-tight text-[var(--term-dim)]">{dir.replace("/home/guest", "~")}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </form>

      {/* footer — user + quick mode + power */}
      <div
        className="relative flex items-center gap-2 border-t px-5 py-3"
        style={{
          borderColor: "color-mix(in srgb, var(--term-fg) 9%, transparent)",
          background: "color-mix(in srgb, var(--term-fg) 4%, transparent)",
        }}
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
          style={{ background: "color-mix(in srgb, var(--term-brand) 30%, var(--term-bg))", color: "var(--term-fg)" }}
        >
          g
        </span>
        <span className="text-[12.5px] text-[var(--term-fg)]">guest</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => useOS.getState().toggleThemeMode()}
          aria-label={themeMode === "light" ? "switch to dark mode" : "switch to light mode"}
          title={themeMode === "light" ? "dark mode" : "light mode"}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--term-dim)] transition-colors hover:text-[var(--term-fg)]"
          onPointerEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--term-fg) 9%, transparent)")}
          onPointerLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {themeMode === "light" ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => {
            onClose();
            onLogout();
          }}
          aria-label="log out"
          title="log out"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--term-dim)] transition-colors hover:text-[var(--term-err)]"
          onPointerEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--term-fg) 9%, transparent)")}
          onPointerLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <Power size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/* ---------- the bar ---------- */

export interface TaskbarProps {
  sound: SoundEngine;
  onToggleSound: () => void;
  onLogout: () => void;
}

export default function Taskbar({ sound, onToggleSound, onLogout }: TaskbarProps) {
  const customApps = useOS((s) => s.settings.customApps);
  const windows = useOS((s) => s.windows);
  const activeId = useOS((s) => s.activeId);
  const openApp = useOS((s) => s.openApp);
  const toggleMinimize = useOS((s) => s.toggleMinimize);
  const patchCrt = useOS((s) => s.patchCrt);
  const crtOn = useOS((s) => s.settings.crt.enabled);
  const tb: TaskbarSettings = useOS((s) => s.settings.taskbar);
  const tbHeight = Math.round(tb.height);

  const [startOpen, setStartOpen] = useState(false);
  const [peek, setPeek] = useState(false);
  const startWrapRef = useRef<HTMLDivElement>(null);

  /* start closes when the pointer lands anywhere outside (start button +
     center cluster + THE MENU ITSELF count as inside — the menu is a
     sibling fixed layer, so mark it with data-start-menu and honor it here;
     without this a pin unmounts on pointerdown and its click never fires) */
  useEffect(() => {
    if (!startOpen) return;
    const onDown = (e: PointerEvent) => {
      if (startWrapRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest("[data-start-menu]")) return;
      setStartOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [startOpen]);

  const running = useMemo(() => {
    const m = new Map<AppId, { id: number; min: boolean }>();
    for (const w of windows) if (!w.closing && !m.has(w.app)) m.set(w.app, { id: w.id, min: w.min });
    return m;
  }, [windows]);

  const runningPwa = useMemo(() => {
    const m = new Map<string, { id: number; min: boolean }>();
    for (const w of windows) if (w.app === "pwa" && w.arg && !w.closing) m.set(w.arg, { id: w.id, min: w.min });
    return m;
  }, [windows]);

  const activate = useCallback(
    (app: AppId) => {
      const win = running.get(app);
      if (!win) openApp(app);
      else toggleMinimize(win.id);
    },
    [openApp, toggleMinimize, running],
  );

  const openCustom = useCallback(
    (app: CustomApp) => {
      const win = runningPwa.get(app.id);
      if (!win) openApp("pwa", app.id);
      else toggleMinimize(win.id);
    },
    [openApp, toggleMinimize, runningPwa],
  );

  /* clock */
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    const t0 = window.setTimeout(tick, 0);
    const iv = window.setInterval(tick, 5000);
    return () => {
      window.clearTimeout(t0);
      window.clearInterval(iv);
    };
  }, []);

  return (
    <>
      {/* start menu floats above the bar */}
      {startOpen && (
        <div className="pointer-events-none fixed inset-0 z-[94]">
          <div className="pointer-events-auto absolute inset-x-0 bottom-0">
            <StartMenu onClose={() => setStartOpen(false)} onLogout={onLogout} barHeight={tbHeight} />
          </div>
        </div>
      )}

      {/* autohide summon strip — poke the bottom edge to reveal the bar */}
      {tb.autohide && !peek && !startOpen && (
        <div
          aria-hidden="true"
          className="fixed inset-x-0 bottom-0 z-[94] h-2"
          onPointerEnter={() => setPeek(true)}
        />
      )}

      <nav
        aria-label="taskbar"
        className="fixed inset-x-0 bottom-0 z-[95] flex items-center justify-between border-t pl-2 pr-1"
        onPointerLeave={() => tb.autohide && setPeek(false)}
        style={{
          fontFamily: "var(--chrome-font)",
          height: tbHeight,
          borderColor: "color-mix(in srgb, var(--term-fg) 9%, transparent)",
          background: `color-mix(in srgb, var(--term-bg) ${tb.opacity}%, transparent)`,
          /* frost on the FrostLayer sibling — keeps the glass icon tiles
             inside the strip able to refract the real backdrop */
          transform: tb.autohide && !peek && !startOpen ? "translateY(100%)" : "none",
          transition: "transform 220ms cubic-bezier(.32,.72,.34,1)",
        }}
      >
        <FrostLayer filter={`blur(${tb.blur}px) saturate(1.5)`} />

        {/* start + pins — center (win11) or left (classic), by settings */}
        <div
          className="absolute top-0 flex h-full items-center gap-0.5 overflow-x-auto"
          style={{
            maxWidth: "calc(100vw - 88px)",
            scrollbarWidth: "none",
            left: tb.alignment === "left" ? 8 : "50%",
            transform: tb.alignment === "left" ? "none" : "translateX(-50%)",
          }}
          ref={startWrapRef}
        >
          <button
            type="button"
            aria-label="start"
            aria-expanded={startOpen}
            title="start"
            onClick={() => setStartOpen((o) => !o)}
            className="flex h-[40px] w-9 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors sm:w-[44px]"
            onPointerEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--term-fg) 9%, transparent)")}
            onPointerLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <WinGlyph size={17} />
          </button>

          {DOCK_APPS.map((a) => {
            const win = running.get(a.id);
            return (
              <TaskButton
                key={a.id}
                label={a.label}
                running={Boolean(win)}
                active={Boolean(win && win.id === activeId && !win.min)}
                onClick={() => activate(a.id)}
                icon={a.icon}
                appId={a.id}
                iconSize={tb.iconSize}
              />
            );
          })}

          {/* installed web apps */}
          {customApps.map((app) => {
            const win = runningPwa.get(app.id);
            return (
              <TaskButton
                key={app.id}
                label={app.name}
                running={Boolean(win)}
                active={Boolean(win && win.id === activeId && !win.min)}
                onClick={() => openCustom(app)}
                custom={app}
                letter={app.name.trim().charAt(0).toUpperCase() || "?"}
                color={app.color}
                iconSize={tb.iconSize}
              />
            );
          })}

          <span
            aria-hidden="true"
            className="mx-1 h-[22px] w-px shrink-0 sm:block"
            style={{ background: "color-mix(in srgb, var(--term-fg) 16%, transparent)" }}
          />
          <TaskButton
            label="settings"
            running={running.has("settings")}
            active={running.get("settings")?.id === activeId}
            onClick={() => activate("settings")}
            icon={SettingsIcon}
            appId="settings"
            iconSize={tb.iconSize}
          />
        </div>

        {/* right tray — the REAL system tray, then sounds/crt, then the clock */}
        <div className="relative ml-auto flex shrink-0 items-center gap-0.5">
          {tb.showTray && (
            <>
              <TrayWifi size={14} sheetAlign="right" drop="up" />
              <TrayBluetooth size={14} sheetAlign="right" drop="up" />
              <TrayBattery size={15} sheetAlign="right" drop="up" />
              <span aria-hidden="true" className="mx-0.5 hidden h-4 w-px sm:block" style={{ background: "color-mix(in srgb, var(--term-fg) 14%, transparent)" }} />
              <button
                type="button"
                onClick={onToggleSound}
                aria-pressed={sound.enabled}
                aria-label={sound.enabled ? "disable key sounds" : "enable key sounds"}
                title={`key sounds ${sound.enabled ? "on" : "off"}`}
                className="hidden h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--term-dim)] transition-colors hover:text-[var(--term-fg)] sm:flex"
                onPointerEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--term-fg) 9%, transparent)")}
                onPointerLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {sound.enabled ? <Volume2 size={14} aria-hidden="true" /> : <VolumeX size={14} aria-hidden="true" />}
              </button>
              <button
                type="button"
                onClick={() => patchCrt({ enabled: !crtOn })}
                aria-pressed={crtOn}
                aria-label={crtOn ? "disable crt effects" : "enable crt effects"}
                title={`crt ${crtOn ? "on" : "off"} — settings has the full tube`}
                className={`hidden h-8 w-8 cursor-pointer items-center justify-center rounded-md transition-colors sm:flex ${
                  crtOn ? "text-[var(--term-brand)]" : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"
                }`}
                onPointerEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--term-fg) 9%, transparent)")}
                onPointerLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <ScanLine size={14} aria-hidden="true" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setStartOpen(false);
              openApp("settings", "about");
            }}
            aria-label="date and time — open about"
            title="date and time"
            className="flex h-10 cursor-pointer flex-col items-end justify-center rounded-md px-2 leading-tight transition-colors"
            onPointerEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--term-fg) 9%, transparent)")}
            onPointerLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <span className="whitespace-nowrap text-[12px] tabular-nums text-[var(--term-fg)]">
              {now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "--:--"}
            </span>
            {tb.showDate && (
              <span className="hidden whitespace-nowrap text-[10.5px] tabular-nums text-[var(--term-dim)] sm:block">
                {now ? now.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" }) : "--/--/----"}
              </span>
            )}
          </button>
        </div>
      </nav>
    </>
  );
}
