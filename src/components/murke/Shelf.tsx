"use client";

/**
 * Shelf — the CHROMEOS desktop shell (the third skin).
 *
 * One full-width translucent shelf pinned to the bottom edge, Google-style:
 *  - centered cluster: the launcher circle + every app as a CIRCLE tile
 *    (AppIcon skin "cros"), running apps carry the little under-dot
 *  - right status area: the real system tray (wifi / bluetooth / battery)
 *    + the clock — clicking the whole cluster opens Quick Settings
 *  - launcher bubble: search + the full app grid, floats above the shelf
 *  - quick settings: wifi chip, PWA bluetooth pairing, dark/light,
 *    brightness slider (REAL — dims the screen with an overlay), volume,
 *    settings + power row — everything a chromebook footer should have
 *
 * Glass reads the shared engine (settings › glass); icons read the dock
 * settings (size / labels / indicator) so the knobs keep working.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bluetooth as BtIcon,
  Moon,
  Power,
  Search,
  Settings as SettingsIcon,
  Sun,
  Volume2,
  VolumeX,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import type { AppId, CustomApp, SoundEngine } from "@/lib/murke/contracts";
import { DOCK_APPS } from "./Dock";
import AppIcon, { PwaIcon } from "./AppIcon";
import { FrostLayer, useGlass } from "./GlassDefs";
import { TrayBattery, TrayBluetooth, TrayWifi } from "./SystemTray";
import { useOS } from "@/lib/murke/os-store";

/* --------------------------- launcher glyph --------------------------- */

function LauncherGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.9" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    </svg>
  );
}

/* ------------------------------ launcher ------------------------------ */

function Launcher({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const customApps = useOS((s) => s.settings.customApps);
  const dock = useOS((s) => s.settings.dock);
  const iconGlass = useOS((s) => s.settings.glass.enabled && s.settings.glass.iconGlass);
  const openApp = useOS((s) => s.openApp);
  const ref = useRef<HTMLDivElement>(null);
  const glass = useGlass({ distort: false, weight: 0.25 });

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
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

  const pins: Array<{ key: string; label: string; app?: AppId; custom?: CustomApp }> = [
    ...DOCK_APPS.map((a) => ({ key: a.id, label: a.label, app: a.id })),
    ...customApps.map((a) => ({ key: a.id, label: a.name, custom: a })),
    { key: "settings", label: "settings", app: "settings" as AppId },
  ];
  const needle = q.trim().toLowerCase();
  const shown = needle ? pins.filter((p) => p.label.toLowerCase().includes(needle)) : pins;

  const run = (p: (typeof pins)[number]) => {
    if (p.app) openApp(p.app);
    else if (p.custom) openApp("pwa", p.custom.id);
    onClose();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="launcher"
      className="absolute bottom-[66px] left-1/2 z-[96] w-[560px] max-w-[94vw] -translate-x-1/2 overflow-hidden rounded-[24px] p-4"
      style={{
        fontFamily: "var(--chrome-font)",
        background: glass.enabled
          ? `color-mix(in srgb, var(--term-bg) ${Math.max(62, glass.alpha)}%, transparent)`
          : "var(--term-bg)",
        /* frost on the FrostLayer sibling — the 40px glass circles inside
           refract it for real */
        boxShadow: "0 30px 80px -18px rgba(0,0,0,0.55), inset 0 0 0 1px color-mix(in srgb, var(--term-fg) 10%, transparent)",
      }}
    >
      <FrostLayer filter={glass.filter} />

      {/* search */}
      <div
        className="relative mb-4 flex items-center gap-2.5 rounded-full px-4 py-2.5"
        style={{ background: "color-mix(in srgb, var(--term-fg) 7%, transparent)" }}
      >
        <Search size={15} aria-hidden="true" className="shrink-0 text-[var(--term-dim)]" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown[0]) run(shown[0]);
          }}
          placeholder="search your device…"
          aria-label="search apps"
          className="w-full bg-transparent text-[13.5px] text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)]"
        />
      </div>

      {/* app grid — circles */}
      {shown.length === 0 ? (
        <p className="relative py-6 text-center text-[12px] text-[var(--term-dim)]">nothing matches “{q}”</p>
      ) : (
        <div className="relative grid grid-cols-4 gap-1 sm:grid-cols-6">
          {shown.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => run(p)}
              className="flex cursor-pointer flex-col items-center gap-1.5 rounded-2xl px-1 py-3 transition-colors"
              onPointerEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--term-fg) 8%, transparent)")}
              onPointerLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {p.app ? (
                <AppIcon app={p.app} size={40} skin="cros" glass={iconGlass} theme={dock.themeIcons} />
              ) : p.custom ? (
                <PwaIcon url={p.custom.url} name={p.custom.name} size={40} skin="cros" glass={iconGlass} theme={dock.themeIcons} color={p.custom.color} />
              ) : null}
              <span className="w-full truncate text-center text-[11px] text-[color-mix(in_srgb,var(--term-fg)_80%,transparent)]">{p.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* --------------------------- quick settings --------------------------- */

function QsChip({
  on,
  label,
  icon: Icon,
  onClick,
  wide,
}: {
  on?: boolean;
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`flex cursor-pointer items-center gap-2.5 rounded-full px-3.5 py-2.5 text-[12px] transition-colors ${
        wide ? "col-span-2" : ""
      }`}
      style={{
        background: on
          ? "var(--term-brand)"
          : "color-mix(in srgb, var(--term-fg) 8%, transparent)",
        color: on ? "#ffffff" : "var(--term-fg)",
      }}
    >
      <Icon size={15} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function QuickSettings({
  onClose,
  sound,
  onLogout,
}: {
  onClose: () => void;
  sound: SoundEngine;
  onLogout: () => void;
}) {
  const themeMode = useOS((s) => s.settings.themeMode);
  const openApp = useOS((s) => s.openApp);
  const [brightness, setBrightness] = useState(100);
  const [volume, setVolume] = useState(70);
  const ref = useRef<HTMLDivElement>(null);
  const glass = useGlass({ distort: false, weight: 0.25 });

  /* outside dismiss */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
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

  /* brightness — the honest kind: a real dimming overlay over the desktop */
  useEffect(() => {
    let el = document.getElementById("murke-dim") as HTMLDivElement | null;
    if (!el) {
      el = document.createElement("div");
      el.id = "murke-dim";
      el.style.cssText = "position:fixed;inset:0;z-index:93;pointer-events:none;background:#000;opacity:0;transition:opacity 140ms ease";
      document.body.appendChild(el);
    }
    el.style.opacity = String((1 - brightness / 100) * 0.72);
    return () => {
      el?.remove();
    };
  }, [brightness]);

  const sliderCls =
    "w-full cursor-pointer accent-[var(--term-brand)]";

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="quick settings"
      className="absolute bottom-[66px] right-2 z-[96] w-[340px] max-w-[94vw] rounded-[24px] p-4"
      style={{
        fontFamily: "var(--chrome-font)",
        background: glass.enabled
          ? `color-mix(in srgb, var(--term-bg) ${Math.max(62, glass.alpha)}%, transparent)`
          : "var(--term-bg)",
        backdropFilter: glass.filter ?? undefined,
        WebkitBackdropFilter: glass.filter ?? undefined,
        boxShadow: "0 30px 80px -18px rgba(0,0,0,0.55), inset 0 0 0 1px color-mix(in srgb, var(--term-fg) 10%, transparent)",
      }}
    >
      {/* user + actions */}
      <div className="mb-3 flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
          style={{ background: "color-mix(in srgb, var(--term-brand) 28%, var(--term-bg))", color: "var(--term-fg)" }}
        >
          g
        </span>
        <span className="text-[12.5px] text-[var(--term-fg)]">guest</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="settings"
          title="settings"
          onClick={() => {
            openApp("settings");
            onClose();
          }}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-[var(--term-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_9%,transparent)] hover:text-[var(--term-fg)]"
        >
          <SettingsIcon size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="log out"
          title="log out"
          onClick={() => {
            onClose();
            onLogout();
          }}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-[var(--term-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_9%,transparent)] hover:text-[var(--term-err)]"
        >
          <Power size={15} aria-hidden="true" />
        </button>
      </div>

      {/* chip grid — wifi / bluetooth / theme */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <QsChip on label="wi-fi" icon={Wifi} />
        <QsChip label="bluetooth" icon={BtIcon} onClick={() => pickBtDevice()} />
        <QsChip
          label={themeMode === "light" ? "dark theme" : "light theme"}
          icon={themeMode === "light" ? Moon : Sun}
          onClick={() => useOS.getState().toggleThemeMode()}
        />
        <QsChip
          on={sound.enabled}
          label={sound.enabled ? "sounds on" : "sounds off"}
          icon={sound.enabled ? Volume2 : VolumeX}
          onClick={() => sound.setEnabled(!sound.enabled)}
        />
      </div>

      {/* sliders — brightness is REAL (dims the screen) */}
      <div className="mb-1 flex items-center gap-2.5">
        <Sun size={14} aria-hidden="true" className="shrink-0 text-[var(--term-dim)]" />
        <input
          type="range"
          min={20}
          max={100}
          value={brightness}
          onChange={(e) => setBrightness(Number(e.target.value))}
          aria-label="screen brightness"
          className={sliderCls}
        />
        <span className="w-9 shrink-0 text-right text-[10.5px] tabular-nums text-[var(--term-dim)]">{brightness}%</span>
      </div>
      <div className="flex items-center gap-2.5">
        {volume === 0 ? (
          <VolumeX size={14} aria-hidden="true" className="shrink-0 text-[var(--term-dim)]" />
        ) : (
          <Volume2 size={14} aria-hidden="true" className="shrink-0 text-[var(--term-dim)]" />
        )}
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            /* the engine is binary on/off — 0 silences it, anything else restores */
            if (sound.enabled !== v > 0) sound.setEnabled(v > 0);
          }}
          aria-label="volume"
          className={sliderCls}
        />
        <span className="w-9 shrink-0 text-right text-[10.5px] tabular-nums text-[var(--term-dim)]">{volume}%</span>
      </div>
    </div>
  );
}

/** pwa bluetooth, one more time, from the quick settings chip */
function pickBtDevice(): void {
  type BtNav = Navigator & { bluetooth?: { requestDevice: (o: { acceptAllDevices: boolean }) => Promise<{ name?: string }> } };
  const nav = navigator as BtNav;
  void nav.bluetooth?.requestDevice({ acceptAllDevices: true }).catch(() => undefined);
}

/* ------------------------------- shelf ------------------------------- */

export interface ShelfProps {
  sound: SoundEngine;
  onLogout: () => void;
}

export default function Shelf({ sound, onLogout }: ShelfProps) {
  const dock = useOS((s) => s.settings.dock);
  const customApps = useOS((s) => s.settings.customApps);
  const iconGlass = useOS((s) => s.settings.glass.enabled && s.settings.glass.iconGlass);
  const windows = useOS((s) => s.windows);
  const activeId = useOS((s) => s.activeId);
  const openApp = useOS((s) => s.openApp);
  const toggleMinimize = useOS((s) => s.toggleMinimize);
  const glass = useGlass({ distort: true, weight: 0.4 });

  const [launcherOpen, setLauncherOpen] = useState(false);
  const [qsOpen, setQsOpen] = useState(false);
  const [peek, setPeek] = useState(!dock.autohide);
  const [lastAuto, setLastAuto] = useState(dock.autohide);
  if (lastAuto !== dock.autohide) {
    setLastAuto(dock.autohide);
    setPeek(!dock.autohide);
  }

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

  const size = dock.iconSize + 10; /* circle tiles run a touch bigger */
  const hidden = dock.autohide && !peek;

  const ShelfButton = ({
    label,
    running: isRunning,
    active,
    onClick,
    children,
  }: {
    label: string;
    running: boolean;
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }) => (
    <button
      type="button"
      aria-label={`${label}${isRunning ? " — running" : ""}`}
      title={dock.labels ? undefined : label}
      onClick={onClick}
      className="group relative flex shrink-0 cursor-pointer flex-col items-center justify-center rounded-full transition-transform hover:scale-[1.07] active:scale-95"
      style={{ width: size, height: size }}
    >
      {dock.labels && (
        <span
          className="pointer-events-none absolute whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] opacity-0 transition-opacity group-hover:opacity-100"
          style={{
            top: -(size + 6),
            background: "color-mix(in srgb, var(--term-bg) 90%, transparent)",
            color: "var(--term-fg)",
            boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--term-fg) 14%, transparent)",
          }}
        >
          {label}
        </span>
      )}
      {children}
      {dock.indicator !== "none" && isRunning && (
        <span
          aria-hidden="true"
          className="absolute rounded-full"
          style={{
            bottom: 1.5,
            width: dock.indicator === "line" ? Math.round(size * 0.4) : 4,
            height: dock.indicator === "line" ? 2.5 : 4,
            background: active ? "var(--term-brand)" : "color-mix(in srgb, var(--term-fg) 55%, transparent)",
          }}
        />
      )}
    </button>
  );

  return (
    <>
      {/* launcher + quick settings float above the shelf */}
      {launcherOpen && <Launcher onClose={() => setLauncherOpen(false)} />}
      {qsOpen && <QuickSettings onClose={() => setQsOpen(false)} sound={sound} onLogout={onLogout} />}

      {/* autohide reveal strip */}
      {dock.autohide && (
        <div
          aria-hidden="true"
          className="fixed inset-x-0 bottom-0 z-[94] h-2"
          onPointerEnter={() => setPeek(true)}
        />
      )}

      <nav
        aria-label="chromeos shelf"
        className="fixed inset-x-0 bottom-0 z-[95] flex items-center justify-between border-t px-2"
        onPointerEnter={() => dock.autohide && setPeek(true)}
        onPointerLeave={() => {
          if (dock.autohide) setPeek(false);
        }}
        style={{
          fontFamily: "var(--chrome-font)",
          height: 56,
          borderColor: "color-mix(in srgb, var(--term-fg) 8%, transparent)",
          background: glass.enabled
            ? `color-mix(in srgb, var(--term-bg) ${Math.max(46, glass.alpha)}%, transparent)`
            : "var(--term-bg)",
          /* frost on the FrostLayer sibling — keeps the glass shelf icons
             inside able to refract the real backdrop */
          transform: hidden ? "translateY(100%)" : "none",
          transition: "transform 240ms cubic-bezier(.32,.72,.34,1)",
        }}
      >
        <FrostLayer filter={glass.filter} />

        {/* centered cluster: launcher + apps */}
        <div
          className="absolute top-0 flex h-full items-center gap-0.5 overflow-x-auto"
          style={{ left: "50%", transform: "translateX(-50%)", maxWidth: "calc(100vw - 190px)", scrollbarWidth: "none" }}
        >
          <button
            type="button"
            aria-label="launcher"
            aria-expanded={launcherOpen}
            title="launcher"
            onClick={() => {
              setQsOpen(false);
              setLauncherOpen((o) => !o);
            }}
            className="flex h-[38px] w-[38px] shrink-0 cursor-pointer items-center justify-center rounded-full transition-transform hover:scale-[1.07] active:scale-95"
            style={{ background: "color-mix(in srgb, var(--term-fg) 9%, transparent)", color: "var(--term-fg)" }}
          >
            <LauncherGlyph size={17} />
          </button>

          {DOCK_APPS.map((a) => {
            const win = running.get(a.id);
            return (
              <ShelfButton
                key={a.id}
                label={a.label}
                running={Boolean(win)}
                active={Boolean(win && win.id === activeId && !win.min)}
                onClick={() => activate(a.id)}
              >
                <AppIcon app={a.id} size={size - 10} skin="cros" glass={iconGlass} theme={dock.themeIcons} />
              </ShelfButton>
            );
          })}

          {customApps.map((app) => {
            const win = runningPwa.get(app.id);
            return (
              <ShelfButton
                key={app.id}
                label={app.name}
                running={Boolean(win)}
                active={Boolean(win && win.id === activeId && !win.min)}
                onClick={() => openCustom(app)}
              >
                <PwaIcon
                  url={app.url}
                  name={app.name}
                  size={size - 10}
                  skin="cros"
                  glass={iconGlass}
                  theme={dock.themeIcons}
                  color={app.color}
                />
              </ShelfButton>
            );
          })}
        </div>

        {/* right status area — the real tray (independent pickers) + the
            clock/chevron, which opens quick settings */}
        <div className="relative ml-auto flex h-full shrink-0 items-center">
          <TrayWifi size={14} sheetAlign="right" />
          <TrayBluetooth size={14} sheetAlign="right" />
          <TrayBattery size={15} sheetAlign="right" />
          <button
            type="button"
            onClick={() => {
              setLauncherOpen(false);
              setQsOpen((o) => !o);
            }}
            aria-expanded={qsOpen}
            aria-label="quick settings and clock"
            title="quick settings"
            className="flex h-full cursor-pointer items-center gap-1.5 px-2.5 transition-colors"
            onPointerEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--term-fg) 7%, transparent)")}
            onPointerLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <span className="whitespace-nowrap text-[11.5px] tabular-nums text-[var(--term-fg)]">
              {now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "--:--"}
            </span>
            <span
              aria-hidden="true"
              className="inline-block h-[5px] w-[5px] rounded-full"
              style={{ background: qsOpen ? "var(--term-brand)" : "color-mix(in srgb, var(--term-fg) 45%, transparent)" }}
            />
          </button>
        </div>
      </nav>
    </>
  );
}
