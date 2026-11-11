"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppId, CustomApp } from "@/lib/murke/contracts";
import { listApps } from "@/lib/murke/appindex";
import { useOS } from "@/lib/murke/os-store";
import AppIcon, { PwaIcon } from "./AppIcon";
import { FrostLayer } from "./GlassDefs";
import { requestAddApp } from "./AddAppDialog";

/**
 * Launchpad — the fullscreen app grid behind the dock's first tile.
 *
 * macOS behavior: the whole screen frosts over while the grid zooms in
 * softly; a top-center search narrows the grid live; a tile click launches
 * the app (built-ins via openApp, installed web apps via openApp("pwa", id))
 * and dismisses. Esc / backdrop click / launching all close it.
 *
 * The grid wears the SAME icon art as the dock — AppIcon (glass translucent)
 * for built-ins, the real favicon PwaIcon for installed apps.
 *
 * Right-click gives every tile a mac-style menu: built-ins get "show in
 * dock options"; installed apps get "remove from launchpad" (gone from the
 * dock + spotlight + start menu too — one app list everywhere), and the
 * grid's backdrop offers "add app…".
 *
 * Mount contract: the component renders exactly while `open` is true (no
 * internal render gate — a render-phase gate + delayed unmount proved
 * fragile under React 19's discrete-event flushing). The entrance plays a
 * plain CSS keyframe on mount; closing is instant.
 */

interface CtxMenu {
  x: number;
  y: number;
  app?: CustomApp;
}

export default function Launchpad({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [ctx, setCtx] = useState<CtxMenu | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  const customApps = useOS((s) => s.settings.customApps);
  const themeIcons = useOS((s) => s.settings.dock.themeIcons);
  const iconGlass = useOS((s) => s.settings.glass.enabled && s.settings.glass.iconGlass);
  const openApp = useOS((s) => s.openApp);

  const apps = useMemo(() => listApps(customApps), [customApps]);
  const needle = q.trim().toLowerCase();
  const shownApps = useMemo(
    () => (needle ? apps.filter((a) => a.label.toLowerCase().includes(needle)) : apps),
    [apps, needle],
  );

  /* Esc closes even when the search input is not focused; autofocus on open */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (ctx) setCtx(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(t);
    };
  }, [open, onClose, ctx]);

  /* click-away kills the tile context menu */
  useEffect(() => {
    if (!ctx) return;
    const onDown = (e: PointerEvent) => {
      if (!ctxRef.current?.contains(e.target as Node)) setCtx(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [ctx]);

  const launch = (entry: { id: string; kind: "builtin" | "custom" }) => {
    if (entry.kind === "custom") openApp("pwa", entry.id);
    else openApp(entry.id as AppId);
    onClose();
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="launchpad"
      className="fixed inset-0 z-[120] flex flex-col items-center"
      onClick={(e) => {
        /* backdrop click closes — tiles and the search field stay alive */
        const t = e.target as HTMLElement;
        if (!t.closest("button") && !t.closest("input")) onClose();
      }}
      onContextMenu={(e) => {
        /* bare grid → the add-app menu (tiles stopPropagation with theirs) */
        const t = e.target as HTMLElement;
        if (t.closest("button") || t.closest("input") || t.closest("[role=menu]")) return;
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
      style={{
        background: "color-mix(in srgb, var(--term-bg) 62%, transparent)",
        /* frost on the FrostLayer sibling below — a panel-level backdrop-
           filter would be a backdrop root and blind the 56px glass tiles */
        animation: "murke-launchpad-in 190ms cubic-bezier(.32,.72,.34,1) both",
      }}
    >
      <FrostLayer filter="blur(40px) saturate(1.45)" />

      {/* top-center search */}
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search"
        aria-label="search apps"
        spellCheck={false}
        autoComplete="off"
        className="relative mt-[7vh] h-9 w-72 rounded-full border px-4 text-[13px] lowercase tracking-wide outline-none placeholder:text-[color-mix(in_srgb,var(--term-fg)_40%,transparent)]"
        style={{
          background: "color-mix(in srgb, var(--term-fg) 8%, transparent)",
          borderColor: "color-mix(in srgb, var(--term-fg) 16%, transparent)",
          color: "var(--term-fg)",
        }}
      />

      {/* the grid — responsive, centered, same icon art as the dock */}
      <div className="murke-scroll relative mt-10 w-full max-w-4xl flex-1 overflow-y-auto px-6 pb-16">
        {shownApps.length === 0 ? (
          <p
            className="pt-16 text-center font-mono text-[12px] lowercase tracking-wide"
            style={{ color: "color-mix(in srgb, var(--term-fg) 45%, transparent)" }}
          >
            no apps match
          </p>
        ) : (
          <div className="grid grid-cols-4 place-items-center gap-x-2 gap-y-7 sm:grid-cols-6 lg:grid-cols-8">
            {shownApps.map((a) => {
              const custom: CustomApp | undefined =
                a.kind === "custom" ? customApps.find((c) => c.id === a.id) : undefined;
              return (
                <button
                  key={a.id}
                  type="button"
                  aria-label={`open ${a.label}`}
                  onClick={() => launch(a)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (custom) setCtx({ x: e.clientX, y: e.clientY, app: custom });
                  }}
                  className="group flex cursor-pointer flex-col items-center gap-2 rounded-xl p-2 outline-none transition-transform duration-150 hover:scale-[1.08] focus-visible:scale-[1.08]"
                >
                  {custom ? (
                    <PwaIcon
                      url={custom.url}
                      name={custom.name}
                      size={56}
                      skin="mac"
                      theme={themeIcons}
                      glass={iconGlass}
                      icon={custom.icon}
                    />
                  ) : (
                    <AppIcon app={a.id as AppId} size={56} skin="mac" glass={iconGlass} translucent theme={themeIcons} />
                  )}
                  <span
                    className="max-w-[76px] truncate text-center text-[11px] lowercase leading-tight"
                    style={{ color: "var(--term-fg)" }}
                  >
                    {a.label}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* tile context menu — remove installed apps, add new ones */}
      {ctx && (() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const items: Array<{ label: string; danger?: boolean; run: () => void }> = ctx.app
          ? [
              { label: "open \"" + ctx.app.name + "\"", run: () => { openApp("pwa", ctx.app!.id); onClose(); } },
              { label: "open in browser", run: () => { openApp("browser", ctx.app!.url); onClose(); } },
              { label: "remove from launchpad", danger: true, run: () => useOS.getState().removeCustomApp(ctx.app!.id) },
            ]
          : [
              { label: "add app…", run: () => requestAddApp() },
            ];
        return (
          <div
            ref={ctxRef}
            role="menu"
            aria-label="launchpad menu"
            className="fixed z-[140] min-w-[170px] rounded-lg py-1 font-mono text-[11px] lowercase shadow-[0_14px_40px_rgba(0,0,0,0.55)]"
            style={{
              left: Math.max(4, Math.min(ctx.x, vw - 186)),
              top: Math.max(4, Math.min(ctx.y, vh - 52 - items.length * 30)),
              border: "1px solid color-mix(in srgb, var(--term-fg) 14%, transparent)",
              background: "color-mix(in srgb, var(--term-bg) 88%, transparent)",
              backdropFilter: "blur(16px) saturate(1.5)",
              WebkitBackdropFilter: "blur(16px) saturate(1.5)",
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setCtx(null);
                  item.run();
                }}
                className="flex w-full cursor-pointer items-center px-3 py-[7px] text-left tracking-wide transition-colors hover:bg-[color-mix(in_srgb,var(--term-brand)_20%,transparent)]"
                style={{ color: item.danger ? "var(--term-err)" : "var(--term-fg)" }}
              >
                {item.label}
              </button>
            ))}
          </div>
        );
      })()}
    </div>
  );
}
