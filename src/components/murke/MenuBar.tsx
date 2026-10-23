"use client";

/**
 * MenuBar — the ONE macOS-style ribbon. Replaces both the old top chrome
 * header and the bottom status strip: maximum vertical space for the page.
 *
 * Layout mirrors macOS: system menu (the sigil) · focused app menu (bold) ·
 * apps · go · help on the left; sound / crt status items and the clock on
 * the right. Menus are context-aware — the bold app menu follows whatever
 * owns the screen (dsh, files, web, paint, chat, notes), exactly like the
 * menu bar follows the frontmost app on a Mac.
 *
 * Interaction contract:
 *  - click a title to open its menu, click another title to switch (hover
 *    switches too once a menu is open), click outside or Esc to dismiss
 *  - Esc here is ARBITRATED at capture phase: an open menu bar owns Esc;
 *    with no menu open it never intercepts (dialogs/apps keep theirs)
 *  - items that print terminal output hand control back to the shell first
 *    (runInShell closes the takeover, then runs the command on dsh)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScanLine, Volume2, VolumeX } from "lucide-react";
import type { OverlayId, ThemeName, VFSApi } from "@/lib/murke/contracts";
import { NEWTAB_URL } from "@/lib/murke/contracts";
import { THEMES } from "@/lib/murke/themes";
import MurkeMark from "./MurkeMark";

type MenuId = "sys" | "app" | "apps" | "go" | "help";

const THEME_KEYS = Object.keys(THEMES) as ThemeName[];

const APP_ITEMS: Array<{ app: OverlayId; label: string; arg?: string }> = [
  { app: "files", label: "files" },
  { app: "browser", label: "web", arg: NEWTAB_URL },
  { app: "notes", label: "notes" },
  { app: "chat", label: "relay chat" },
  { app: "paint", label: "paint" },
];

/* ---------- dropdown building blocks ---------- */

/** One row inside a dropdown. macOS geometry: check gutter · label · hint. */
function Item({
  onClick,
  checked = false,
  hint,
  disabled = false,
  children,
}: {
  onClick: () => void;
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

/** A menubar title + its dropdown panel (panel opens under the title). */
function Title({
  id,
  isOpen,
  onToggle,
  onHoverSwitch,
  bold = false,
  label,
  aria,
  children,
}: {
  id: MenuId;
  isOpen: boolean;
  onToggle: (id: MenuId) => void;
  onHoverSwitch: (id: MenuId) => void;
  bold?: boolean;
  label: React.ReactNode;
  aria: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex h-full items-stretch">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={aria}
        onClick={() => onToggle(id)}
        onPointerEnter={() => onHoverSwitch(id)}
        className={`${titleCls(isOpen)} ${bold ? "font-bold text-[var(--term-brand)]" : ""}`}
      >
        {label}
      </button>
      {isOpen && (
        <div
          role="menu"
          aria-label={aria}
          className="absolute left-0 top-full z-[70] min-w-[218px] border border-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] bg-[color-mix(in_srgb,var(--term-bg)_94%,transparent)] py-1 shadow-[0_14px_40px_rgba(0,0,0,0.6)] backdrop-blur-md"
        >
          {children}
        </div>
      )}
    </div>
  );
}

/* ---------- the bar ---------- */

export interface MenuBarProps {
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
  crt: boolean;
  setCrt: (v: boolean) => void;
  soundOn: boolean;
  onToggleSound: () => void;
  /** the app that owns the screen right now (null = the terminal dsh) */
  activeApp: OverlayId | null;
  openApp: (app: OverlayId, arg?: string) => void;
  closeApp: () => void;
  /** return to the terminal, then run a shell command there */
  runInShell: (cmd: string) => void;
  onLogout: () => void;
  vfs: VFSApi;
}

export default function MenuBar({
  theme,
  setTheme,
  crt,
  setCrt,
  soundOn,
  onToggleSound,
  activeApp,
  openApp,
  closeApp,
  runInShell,
  onLogout,
  vfs,
}: MenuBarProps) {
  const [open, setOpen] = useState<MenuId | null>(null);
  const [themeSub, setThemeSub] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  /** live mirror of `open` for the always-registered Esc arbiter below */
  const openRef = useRef<MenuId | null>(null);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const closeMenus = useCallback(() => {
    setOpen(null);
    setThemeSub(false);
  }, []);

  /** run an action then dismiss the menus */
  const act = useCallback(
    (fn: () => void) => () => {
      closeMenus();
      fn();
    },
    [closeMenus]
  );

  const onToggleTitle = useCallback(
    (id: MenuId) => {
      if (open === id) {
        closeMenus();
        return;
      }
      setOpen(id);
      if (id !== "sys") setThemeSub(false);
    },
    [open, closeMenus]
  );

  /** macOS behavior: once a menu is open, hovering another title switches */
  const onHoverSwitch = useCallback(
    (id: MenuId) => {
      if (open === null || open === id) return;
      if (id !== "sys") setThemeSub(false);
      setOpen(id);
    },
    [open]
  );

  /* click outside the bar dismisses any open menu */
  useEffect(() => {
    if (open === null) return;
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) closeMenus();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open, closeMenus]);

  /* ESCAPE ARBITRATION — registered ONCE at shell mount (before any overlay
   * app can attach its own listeners) at capture phase. While a menu is
   * open, Esc belongs HERE and nothing else may react to it. With no menu
   * open this never intercepts. The ref keeps listener order stable no
   * matter how often menus open/close. */
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

  /* ---------- the clock (macOS style: weekday date · 24h time) ---------- */

  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    /* the bar mounts client-side only (post-auth shell), so reading the
       clock at mount is hydration-safe; the interval keeps it ticking */
    const tick = () => setNow(new Date());
    const t0 = window.setTimeout(tick, 0);
    const iv = window.setInterval(tick, 5000);
    return () => {
      window.clearTimeout(t0);
      window.clearInterval(iv);
    };
  }, []);

  /* ---------- go-menu places (only folders that actually exist) ---------- */

  const places = useMemo(() => {
    const list = [
      { name: "home", path: "~" },
      { name: "documents", path: "~/Documents" },
      { name: "downloads", path: "~/Downloads" },
      { name: "music", path: "~/Music" },
      { name: "pictures", path: "~/Pictures" },
      { name: "paintings", path: "~/Paintings" },
      { name: "notes", path: "~/notes" },
    ];
    return list.filter((p) => vfs.exists(p.path));
  }, [vfs]);

  const goPlace = useCallback(
    (path: string) => {
      if (activeApp === "files") openApp("files", path);
      else runInShell(`cd ${path}`);
    },
    [activeApp, openApp, runInShell]
  );

  /* display name — matches the apps menu (the browser app is "web") */
  const appName = activeApp === "browser" ? "web" : (activeApp ?? "dsh");

  return (
    <div
      ref={barRef}
      role="menubar"
      aria-label="dsh menu bar"
      className="relative z-[60] flex h-7 shrink-0 items-stretch justify-between gap-1 border-b border-[color-mix(in_srgb,var(--term-fg)_12%,transparent)] bg-[color-mix(in_srgb,var(--term-bg)_78%,transparent)] pl-0.5 pr-1 font-mono backdrop-blur-[8px]"
    >
      {/* ---------- left cluster: system · app · apps · go · help ---------- */}
      <div className="flex min-w-0 items-stretch">
        {/* the sigil menu — the "apple menu" */}
        <Title id="sys" isOpen={open === "sys"} onToggle={onToggleTitle} onHoverSwitch={onHoverSwitch} aria="system menu" label={<MurkeMark theme={theme} height={15} />}>
          <Item onClick={act(() => runInShell("neofetch"))}>about this machine</Item>
          <Sep />
          {/* theme — inline expandable submenu */}
          <button
            type="button"
            role="menuitem"
            aria-expanded={themeSub}
            onClick={() => setThemeSub((v) => !v)}
            className="flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-[7px] text-left text-[11.5px] lowercase tracking-wide text-[color-mix(in_srgb,var(--term-fg)_88%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-brand)_22%,transparent)] hover:text-[var(--term-fg)]"
          >
            <span className="w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">theme</span>
            <span aria-hidden="true" className={`shrink-0 text-[9px] text-[var(--term-dim)] transition-transform ${themeSub ? "rotate-90" : ""}`}>
              ▶
            </span>
          </button>
          {themeSub &&
            THEME_KEYS.map((t) => (
              <button
                key={t}
                type="button"
                role={t === theme ? "menuitemcheckbox" : "menuitem"}
                aria-checked={t === theme}
                onClick={act(() => setTheme(t))}
                className="flex w-full cursor-pointer items-center gap-1.5 py-[6px] pl-6 pr-2.5 text-left text-[11.5px] lowercase tracking-wide text-[color-mix(in_srgb,var(--term-fg)_88%,transparent)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-brand)_22%,transparent)] hover:text-[var(--term-fg)]"
              >
                <span className="w-3.5 shrink-0 text-center text-[10px] leading-none text-[var(--term-brand)]">{t === theme ? "✓" : ""}</span>
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full border border-[color-mix(in_srgb,var(--term-fg)_28%,transparent)]"
                  style={{ backgroundColor: THEMES[t].brand }}
                />
                <span className="min-w-0 flex-1 truncate">{THEMES[t].label}</span>
              </button>
            ))}
          <Item onClick={act(() => setCrt(!crt))} checked={crt}>
            crt scanlines
          </Item>
          <Item onClick={act(onToggleSound)} checked={soundOn}>
            key sounds
          </Item>
          <Sep />
          <Item onClick={act(onLogout)}>log out</Item>
        </Title>

        {/* the focused app menu — bold, like macOS */}
        <Title id="app" bold isOpen={open === "app"} onToggle={onToggleTitle} onHoverSwitch={onHoverSwitch} aria={`${appName} menu`} label={appName}>
          {activeApp === null ? (
            <>
              <Item disabled>version 2.1</Item>
              <Sep />
              <Item onClick={act(() => runInShell("clear"))} hint="⌃L">
                clear screen
              </Item>
              <Item onClick={act(() => runInShell("help"))}>help</Item>
            </>
          ) : activeApp === "web" ? (
            <>
              <Item onClick={act(() => openApp("browser", NEWTAB_URL))}>new window</Item>
              <Sep />
              <Item onClick={act(closeApp)} hint="esc">
                close window
              </Item>
            </>
          ) : (
            <>
              <Item disabled>{appName} window</Item>
              <Sep />
              <Item onClick={act(closeApp)} hint="esc">
                close window
              </Item>
            </>
          )}
        </Title>

        {/* apps — the launchers (no dock: the menu bar IS the dock) */}
        <Title id="apps" isOpen={open === "apps"} onToggle={onToggleTitle} onHoverSwitch={onHoverSwitch} aria="applications menu" label="apps">
          {APP_ITEMS.map((a) => (
            <Item key={a.app} checked={activeApp === a.app} onClick={act(() => openApp(a.app, a.arg))}>
              {a.label}
            </Item>
          ))}
          <Sep />
          <Item onClick={act(() => runInShell("weather"))}>weather</Item>
          <Item disabled={activeApp === null} onClick={act(closeApp)}>
            terminal
          </Item>
        </Title>

        {/* go — the places, nautilus-style */}
        <Title id="go" isOpen={open === "go"} onToggle={onToggleTitle} onHoverSwitch={onHoverSwitch} aria="go to folder menu" label="go">
          {places.map((p) => (
            <Item key={p.path} onClick={act(() => goPlace(p.path))}>
              {p.name}
            </Item>
          ))}
        </Title>

        {/* help */}
        <Title id="help" isOpen={open === "help"} onToggle={onToggleTitle} onHoverSwitch={onHoverSwitch} aria="help menu" label="help">
          <Item onClick={act(() => runInShell("help"))}>open help</Item>
          <Item onClick={act(() => runInShell("credits"))}>credits</Item>
        </Title>
      </div>

      {/* ---------- right cluster: status items + clock ---------- */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={onToggleSound}
          aria-pressed={soundOn}
          aria-label={soundOn ? "disable key sounds" : "enable key sounds"}
          title={`key sounds ${soundOn ? "on" : "off"}`}
          className="cursor-pointer px-1.5 py-1 text-[var(--term-dim)] transition-colors hover:text-[var(--term-fg)]"
        >
          {soundOn ? <Volume2 size={13} aria-hidden="true" /> : <VolumeX size={13} aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => setCrt(!crt)}
          aria-pressed={crt}
          aria-label={crt ? "disable crt scanlines" : "enable crt scanlines"}
          title={`crt scanlines ${crt ? "on" : "off"}`}
          className={`cursor-pointer px-1.5 py-1 transition-colors ${crt ? "text-[var(--term-brand)]" : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"}`}
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
