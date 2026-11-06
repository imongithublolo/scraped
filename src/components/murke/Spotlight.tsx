"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { File, Folder, Search } from "lucide-react";
import type { AppId } from "@/lib/murke/contracts";
import { listApps, searchFiles, type AppEntry, type FileHit } from "@/lib/murke/appindex";
import { useOS } from "@/lib/murke/os-store";
import AppIcon, { PwaIcon } from "./AppIcon";
import { FrostLayer } from "./GlassDefs";

/**
 * Spotlight — the cmd/ctrl+k search palette (hotkey + the "murke-spotlight"
 * CustomEvent live in the Dock, which owns the open/close contract through
 * this component's props).
 *
 * One frosted panel, top-center: a search row, then "applications" and
 * "files" sections. Empty query = a quick-launch pad (first apps + the most
 * recent files, mtime desc). Arrow keys walk a wrapped selection, Enter
 * launches (apps via openApp, files via previews, folders via finder), Esc
 * or a backdrop click dismisses.
 */

type AppRow = { kind: "app"; entry: AppEntry };
type FileRow = { kind: "file"; hit: FileHit };
type Row = AppRow | FileRow;

export default function Spotlight({ open, onClose }: { open: boolean; onClose: () => void }) {
  /* render gate + animation state — stays mounted while fading out */
  const [render, setRender] = useState(open);
  const [shown, setShown] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  const customApps = useOS((s) => s.settings.customApps);
  const iconGlass = useOS((s) => s.settings.glass.enabled && s.settings.glass.iconGlass);
  const openApp = useOS((s) => s.openApp);

  const apps = useMemo(() => listApps(customApps), [customApps]);
  const needle = q.trim().toLowerCase();

  /* apps first, then files — the flattened row order keyboard nav walks */
  const appRows: AppRow[] = useMemo(() => {
    const hits = needle ? apps.filter((a) => a.label.toLowerCase().includes(needle)) : apps;
    return hits.slice(0, needle ? 8 : 6).map((entry) => ({ kind: "app" as const, entry }));
  }, [apps, needle]);

  const fileRows: FileRow[] = useMemo(
    () => searchFiles(q, needle ? 8 : 4).map((hit) => ({ kind: "file" as const, hit })),
    [q, needle],
  );

  const rows = useMemo(() => [...appRows, ...fileRows], [appRows, fileRows]);

  /* open/close transitions — state-adjusted during render (the dock's
     autohide pattern): the render gate + search reset flip synchronously
     with the prop; the zoom-in rAF and the delayed unmount live in the
     effects below */
  const [lastOpen, setLastOpen] = useState(open);
  if (lastOpen !== open) {
    setLastOpen(open);
    if (open) {
      setRender(true);
      setShown(false);
      setQ("");
      setSel(0);
    } else {
      setShown(false);
    }
  }

  /* focus the search field once mounted */
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  /* mount / unmount animation — keep rendered while the fade-out runs */
  useEffect(() => {
    if (!open) {
      const t = window.setTimeout(() => setRender(false), 150);
      return () => window.clearTimeout(t);
    }
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open]);

  const launch = useCallback(
    (row: Row) => {
      if (row.kind === "app") {
        if (row.entry.kind === "custom") openApp("pwa", row.entry.id);
        else openApp(row.entry.id as AppId);
      } else if (row.hit.dir) {
        openApp("files", row.hit.path);
      } else {
        openApp("preview", row.hit.path);
      }
      onClose();
    },
    [openApp, onClose],
  );

  /* keyboard while open: esc closes, arrows walk (wrap), enter launches */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (rows.length ? (s + 1) % rows.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (rows.length ? (s - 1 + rows.length) % rows.length : 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const row = rows[sel];
        if (row) launch(row);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, rows, sel, launch, onClose]);

  /* keep the walking selection visible */
  useEffect(() => {
    rowRefs.current.get(sel)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!render) return null;

  const dimInk = "color-mix(in srgb, var(--term-fg) 42%, transparent)";
  const rowStyle = (active: boolean): React.CSSProperties => ({
    background: active
      ? "color-mix(in srgb, var(--term-brand) 26%, transparent)"
      : "transparent",
    color: "var(--term-fg)",
    borderRadius: 8,
    marginInline: 6,
  });

  const renderAppRow = (row: AppRow, i: number) => {
    const idx = i;
    const custom = row.entry.kind === "custom" ? customApps.find((c) => c.id === row.entry.id) : undefined;
    return (
      <button
        key={`a-${row.entry.id}`}
        ref={(el) => {
          if (el) rowRefs.current.set(idx, el);
          else rowRefs.current.delete(idx);
        }}
        type="button"
        role="option"
        aria-selected={sel === idx}
        onMouseEnter={() => setSel(idx)}
        onClick={() => launch(row)}
        className="flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left transition-colors"
        style={rowStyle(sel === idx)}
      >
        {custom ? (
          <PwaIcon url={custom.url} name={custom.name} size={22} skin="mac" glass={iconGlass} icon={custom.icon} />
        ) : (
          <AppIcon app={row.entry.id as AppId} size={22} skin="mac" glass={iconGlass} translucent />
        )}
        <span className="truncate text-[12.5px] lowercase">{row.entry.label}</span>
      </button>
    );
  };

  const renderFileRow = (row: FileRow, i: number) => {
    const idx = appRows.length + i;
    return (
      <button
        key={`f-${row.hit.path}`}
        ref={(el) => {
          if (el) rowRefs.current.set(idx, el);
          else rowRefs.current.delete(idx);
        }}
        type="button"
        role="option"
        aria-selected={sel === idx}
        onMouseEnter={() => setSel(idx)}
        onClick={() => launch(row)}
        className="flex w-[calc(100%-12px)] cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left transition-colors"
        style={rowStyle(sel === idx)}
      >
        <span className="flex w-5 shrink-0 items-center justify-center" style={{ color: dimInk }}>
          {row.hit.dir ? <Folder size={14} strokeWidth={2} aria-hidden="true" /> : <File size={14} strokeWidth={2} aria-hidden="true" />}
        </span>
        <span className="shrink-0 truncate text-[12.5px] lowercase">{row.hit.name}</span>
        <span className="ml-auto min-w-0 truncate pl-3 text-[10.5px] lowercase" style={{ color: dimInk }}>
          {row.hit.path}
        </span>
      </button>
    );
  };

  return (
    <>
      {/* click-away backdrop (sits just below the panel) */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-[129]"
        onClick={onClose}
        onContextMenu={(e) => e.preventDefault()}
      />

      <div
        role="dialog"
        aria-label="spotlight"
        className="fixed left-1/2 z-[130] w-[580px] max-w-[92vw] overflow-hidden rounded-2xl shadow-[0_30px_90px_rgba(0,0,0,0.62)]"
        style={{
          top: "18vh",
          border: "1px solid color-mix(in srgb, var(--term-fg) 16%, transparent)",
          background: "color-mix(in srgb, var(--term-bg) 58%, transparent)",
          /* frost on the FrostLayer sibling — the glass result icons inside
             refract it for real (a panel-level backdrop-filter would be a
             backdrop root and they'd sample nothing) */
          boxShadow:
            "0 30px 90px rgba(0,0,0,0.62), inset 0 0 0 1px rgba(255,255,255,0.07), inset 0 1.5px 0.5px -0.5px rgba(255,255,255,0.38), inset 0 -1px 1px -1px rgba(255,255,255,0.1)",
          opacity: shown ? 1 : 0,
          transform: shown ? "translate(-50%, 0) scale(1)" : "translate(-50%, 0) scale(0.97)",
          transition: "opacity 150ms ease, transform 150ms cubic-bezier(.32,.72,.34,1)",
        }}
      >
        {/* the panel's frost, as a sibling layer the glass icons refract */}
        <FrostLayer filter="blur(34px) saturate(1.9) brightness(1.14)" />

        {/* specular sheen — the same glass skin the dock wears */}
        <span
          aria-hidden="true"
          className="murke-glass-sheen pointer-events-none absolute inset-0 rounded-[inherit]"
        />

        {/* search row */}
        <div
          className="relative flex items-center gap-2.5 border-b px-3.5"
          style={{ borderColor: "color-mix(in srgb, var(--term-fg) 12%, transparent)" }}
        >
          <Search size={15} strokeWidth={2} aria-hidden="true" style={{ color: dimInk }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            placeholder="spotlight search"
            aria-label="spotlight search"
            spellCheck={false}
            autoComplete="off"
            className="h-11 w-full bg-transparent text-[13px] lowercase tracking-wide outline-none placeholder:text-[color-mix(in_srgb,var(--term-fg)_40%,transparent)]"
            style={{ color: "var(--term-fg)" }}
          />
        </div>

        {/* results — applications, then files */}
        <div className="murke-scroll relative max-h-[320px] overflow-y-auto py-1" role="listbox" aria-label="spotlight results">
          {rows.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12px] lowercase" style={{ color: dimInk }}>
              no results
            </p>
          ) : (
            <>
              {appRows.length > 0 && (
                <>
                  <div
                    className="px-3 pb-1 pt-1.5 font-mono text-[10px] lowercase tracking-wider"
                    style={{ color: dimInk }}
                  >
                    applications
                  </div>
                  {appRows.map((r, i) => renderAppRow(r, i))}
                </>
              )}
              {fileRows.length > 0 && (
                <>
                  <div
                    className="px-3 pb-1 pt-1.5 font-mono text-[10px] lowercase tracking-wider"
                    style={{ color: dimInk }}
                  >
                    files
                  </div>
                  {fileRows.map((r, i) => renderFileRow(r, i))}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
