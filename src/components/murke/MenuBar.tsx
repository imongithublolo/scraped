"use client";

/**
 * MenuBar — the macOS menu bar of the desktop.
 *
 * Left: the murke wordmark (system menu: about · settings · log out), the
 * bold FOCUSED app menu (window controls, like macOS's frontmost app), go
 * (file manager places) and help. Right: sound + crt status items, clock.
 * Everything reads the OS store directly — the bar is a desktop citizen now,
 * not a terminal appendage.
 *
 * Interaction contract:
 *  - click a title to open its menu, hover switches once open, click
 *    outside or Esc dismisses (Esc ARBITRATED at capture phase — an open
 *    menu owns Esc; with no menu open it never intercepts)
 *  - shell commands (help/credits) go through runInShell: focus/raise the
 *    terminal window, then dispatch the command there
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lock, ScanLine, Search, Volume2, VolumeX } from "lucide-react";
import type { SoundEngine } from "@/lib/murke/contracts";
import { resolveMeta } from "@/lib/murke/appmeta";
import { getVfs } from "@/lib/murke/vfs";
import { useOS } from "@/lib/murke/os-store";
import { resolveThemeKey } from "@/lib/murke/themes";
import { supportsGlassDistort, glassStyle } from "./GlassDefs";
import { TrayBattery, TrayBluetooth, TrayWifi } from "./SystemTray";
import { requestLock } from "./LockScreen";
import { Wordmark } from "./MurkeMark";

type MenuId = "sys" | "app" | "go" | "help";

/* ---------- dropdown building blocks ---------- */

function Item({
  onClick,
  checked = false,
  hint,
  disabled = false,
  children,
}: {
  onClick?: () => void;
  checked?: boolean;
  hint?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role={checked ? "menuitemcheckbox" : "menuitem"}
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-1.5 px-2.5 py-[7px] text-left text-[11.5px] lowercase tracking-wide transition-colors ${
        disabled
          ? "cursor-default text-[var(--term-dim)]"
          : "cursor-pointer text-[color-mix(in_srgb,var(--term-fg)_88%,transparent)] hover:bg-[color-mix(in_srgb,var(--term-brand)_22%,transparent)] hover:text-[var(--term-fg)]"
      }`}
    >
      <span className="w-3.5 shrink-0 text-center text-[10px] leading-none text-[var(--term-brand)]">{checked ? "✓" : ""}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="ml-3 shrink-0 text-[10px] text-[var(--term-dim)]">{hint}</span>}
    </button>
  );
}

function Sep() {
  return <div role="separator" className="mx-2 my-1 border-t border-[color-mix(in_srgb,var(--term-fg)_12%,transparent)]" />;
}

const titleCls = (isOpen: boolean) =>
  `relative flex h-full cursor-pointer items-center whitespace-nowrap px-2.5 text-[11.5px] lowercase tracking-wide transition-colors ${
    isOpen
      ? "bg-[color-mix(in_srgb,var(--term-brand)_24%,transparent)] text-[var(--term-fg)]"
      : "text-[color-mix(in_srgb,var(--term-fg)_85%,transparent)] hover:bg-[color-mix(in_srgb,var(--term-fg)_9%,transparent)] hover:text-[var(--term-fg)]"
  }`;

function Title({
  id,
  isOpen,
  onToggle,
  onHoverSwitch,
  bold = false,
  label,
  aria,
  className = "flex",
  children,
}: {
  id: MenuId;
  isOpen: boolean;
  onToggle: (id: MenuId) => void;
  onHoverSwitch: (id: MenuId) => void;
  bold?: boolean;
  label: React.ReactNode;
  aria: string;
  /** display guard — secondary menus hide below sm so the tray never
      gets squeezed into wrapping (the battery-wrap top bar bug) */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`relative h-full items-stretch ${className}`}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={aria}
        onClick={() => onToggle(id)}
        onPointerEnter={() => onHoverSwitch(id)}
        className={`${titleCls(isOpen)} ${bold ? "font-bold" : ""}`}
      >
        {label}
      </button>
      {isOpen && (
        <div
          role="menu"
          aria-label={aria}
          className="absolute left-0 top-full z-[90] min-w-[218px] rounded-b-md border border-t-0 border-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] py-1 shadow-[0_14px_40px_rgba(0,0,0,0.6)]"
          style={{ background: "color-mix(in srgb, var(--term-bg) 88%, transparent)", ...glassStyle(false) }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/* ---------- the bar ---------- */

export interface MenuBarProps {
  sound: SoundEngine;
  onToggleSound: () => void;
  /** focus the terminal window, then run a shell command there */
  runInShell: (cmd: string) => void;
  onLogout: () => void;
}

export default function MenuBar({ sound, onToggleSound, runInShell, onLogout }: MenuBarProps) {
  const [open, setOpen] = useState<MenuId | null>(null);
  /* backdrop refraction is Chromium-only; pick once */
  const [distort] = useState(supportsGlassDistort);
  const barRef = useRef<HTMLDivElement>(null);
  const openRef = useRef<MenuId | null>(null);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const settings = useOS((s) => s.settings);
  const windows = useOS((s) => s.windows);
  const activeId = useOS((s) => s.activeId);
  const openApp = useOS((s) => s.openApp);
  const minimizeWindow = useOS((s) => s.minimizeWindow);
  const toggleZoom = useOS((s) => s.toggleZoom);
  const closeWindow = useOS((s) => s.closeWindow);
  const patchCrt = useOS((s) => s.patchCrt);

  const active = windows.find((w) => w.id === activeId && !w.min && !w.closing) ?? null;

  const closeMenus = useCallback(() => setOpen(null), []);
  const act = useCallback((fn: () => void) => () => (closeMenus(), fn()), [closeMenus]);

  const onToggleTitle = useCallback(
    (id: MenuId) => setOpen((o) => (o === id ? null : id)),
    [],
  );
  const onHoverSwitch = useCallback(
    (id: MenuId) => {
      setOpen((o) => (o === null || o === id ? o : id));
    },
    [],
  );

  /* click outside dismisses */
  useEffect(() => {
    if (open === null) return;
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) closeMenus();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open, closeMenus]);

  /* ESCAPE ARBITRATION — capture phase, registered ONCE. While a menu is
   * open, Esc belongs HERE and nothing else may react to it. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (openRef.current === null) return;
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeMenus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeMenus]);

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

  /* go-menu places (only folders that actually exist) */
  const vfs = useMemo(() => getVfs(), []);
  const places = useMemo(() => {
    const list = [
      { name: "home", path: "~" },
      { name: "documents", path: "~/Documents" },
      { name: "downloads", path: "~/Downloads" },
      { name: "pictures", path: "~/Pictures" },
      { name: "wallpapers", path: "~/Pictures/Wallpapers" },
      { name: "paintings", path: "~/Paintings" },
      { name: "notes", path: "~/notes" },
    ];
    return list.filter((p) => vfs.exists(p.path));
  }, [vfs]);

  const goPlace = useCallback(
    (path: string) => {
      openApp("files", path);
    },
    [openApp],
  );

  const activeMeta = active ? resolveMeta(active.app, active.arg, settings.customApps) : null;
  const activeAppLabel = activeMeta?.label ?? "desktop";
  const crtOn = settings.crt.enabled;

  return (
    <div
      ref={barRef}
      role="menubar"
      aria-label="murke desktop menu bar"
      className="relative z-[90] flex h-7 shrink-0 items-stretch justify-between gap-1 border-b border-[color-mix(in_srgb,var(--term-fg)_12%,transparent)] pl-1 pr-1 font-mono"
      style={{ background: "color-mix(in srgb, var(--term-bg) 55%, transparent)", ...glassStyle(distort), marginTop: "var(--murke-wco-inset, 0px)" }}
    >
      {/* specular skin */}
      <span aria-hidden="true" className="murke-glass-sheen pointer-events-none absolute inset-0" />
      {/* ---------- left cluster ---------- */}
      <div className="flex min-w-0 items-stretch">
        {/* system menu — the wordmark IS the apple */}
        <Title id="sys" isOpen={open === "sys"} onToggle={onToggleTitle} onHoverSwitch={onHoverSwitch} aria="system menu" label={<Wordmark theme={resolveThemeKey(settings)} />}>
          <Item onClick={act(() => openApp("settings", "about"))}>about this machine</Item>
          <Item onClick={act(() => openApp("settings"))} hint="⌘,">
            settings…
          </Item>
          <Sep />
          <Item onClick={act(() => useOS.getState().toggleThemeMode())}>
            {settings.themeMode === "light" ? "dark mode" : "light mode"}
          </Item>
          <Item onClick={act(onLogout)}>log out</Item>
        </Title>

        {/* focused app menu — bold, like macOS */}
        <Title id="app" bold isOpen={open === "app"} onToggle={onToggleTitle} onHoverSwitch={onHoverSwitch} aria={`${activeAppLabel} menu`} label={activeAppLabel}>
          {!active ? (
            <>
              <Item onClick={act(() => openApp("dsh"))}>new terminal window</Item>
              <Item onClick={act(() => openApp("settings"))}>settings…</Item>
              <Sep />
              <Item disabled>no window focused</Item>
            </>
          ) : (
            <>
              <Item disabled>{activeMeta?.label ?? "window"} window</Item>
              <Sep />
              <Item onClick={act(() => minimizeWindow(active.id))} hint="⌘M">
                minimize
              </Item>
              {!activeMeta?.fixed && (
                <Item onClick={act(() => toggleZoom(active.id))} hint="⌃⌘F">
                  {active.zoom ? "restore" : "zoom"}
                </Item>
              )}
              <Item onClick={act(() => closeWindow(active.id))} hint="esc">
                close window
              </Item>
            </>
          )}
        </Title>

        {/* go — the places (hidden on phones: the tray must not squeeze) */}
        <Title id="go" className="hidden sm:flex" isOpen={open === "go"} onToggle={onToggleTitle} onHoverSwitch={onHoverSwitch} aria="go to folder menu" label="go">
          {places.map((p) => (
            <Item key={p.path} onClick={act(() => goPlace(p.path))}>
              {p.name}
            </Item>
          ))}
        </Title>

        {/* help (hidden on phones alongside go) */}
        <Title id="help" className="hidden sm:flex" isOpen={open === "help"} onToggle={onToggleTitle} onHoverSwitch={onHoverSwitch} aria="help menu" label="help">
          <Item onClick={act(() => runInShell("help"))}>open help</Item>
          <Item onClick={act(() => runInShell("credits"))}>credits</Item>
        </Title>
      </div>

      {/* ---------- right cluster: the REAL system tray + clock ---------- */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => {
            try {
              window.dispatchEvent(new CustomEvent("murke-spotlight"));
            } catch {
              /* ignore */
            }
          }}
          aria-label="open spotlight search"
          title="spotlight search — ⌘K"
          className="cursor-pointer px-1.5 py-1 text-[var(--term-dim)] transition-colors hover:text-[var(--term-fg)]"
        >
          <Search size={13} aria-hidden="true" />
        </button>
        <TrayWifi size={13} />
        <TrayBluetooth size={13} />
        <TrayBattery size={14} />
        <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-[color-mix(in_srgb,var(--term-fg)_14%,transparent)]" />
        <button
          type="button"
          onClick={onToggleSound}
          aria-pressed={sound.enabled}
          aria-label={sound.enabled ? "disable key sounds" : "enable key sounds"}
          title={`key sounds ${sound.enabled ? "on" : "off"}`}
          className="cursor-pointer px-1.5 py-1 text-[var(--term-dim)] transition-colors hover:text-[var(--term-fg)]"
        >
          {sound.enabled ? <Volume2 size={13} aria-hidden="true" /> : <VolumeX size={13} aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={requestLock}
          aria-label="lock the screen"
          title="lock the screen — the tab losing focus locks it too"
          className="cursor-pointer px-1.5 py-1 text-[var(--term-dim)] transition-colors hover:text-[var(--term-fg)]"
        >
          <Lock size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => patchCrt({ enabled: !crtOn })}
          aria-pressed={crtOn}
          aria-label={crtOn ? "disable crt effects" : "enable crt effects"}
          title={`crt ${crtOn ? "on" : "off"} — settings has the full tube`}
          className={`cursor-pointer px-1.5 py-1 transition-colors ${crtOn ? "text-[var(--term-brand)]" : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"}`}
        >
          <ScanLine size={13} aria-hidden="true" />
        </button>
        <span
          className="whitespace-nowrap px-1.5 tabular-nums text-[11px] text-[var(--term-dim)]"
          aria-label="date and time"
          title="local time"
        >
          {now ? (
            <>
              <span className="hidden sm:inline">{now.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" })} </span>
              {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
            </>
          ) : (
            "--:--"
          )}
        </span>
      </div>
    </div>
  );
}
