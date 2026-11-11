"use client";

/**
 * FrostUrlBar — the omnibox that rides the bottom edge while browsing,
 * centered between the nav trio and the tabs/devtools cluster. Idle it
 * shows the live url of the active tab; a click flips it into search mode
 * with the engine selector sitting EXACTLY where the home bar keeps it
 * (left glyph → slide-in picker → field → magnifier). Enter drives the
 * active tab; urls browse direct, words go to the picked engine.
 */

import { useEffect, useRef, useState } from "react";
import { EngineGlyph } from "./EngineGlyph";
import type { FrostEngine } from "@/lib/murke/frost-store";

/** the url as a human reads it: scheme + www stripped, middle-ellipsized */
export function prettyUrl(raw: string): string {
  let u = raw;
  try {
    const asUrl = new URL(raw);
    u = asUrl.hostname.replace(/^www\./, "") + asUrl.pathname + asUrl.search + asUrl.hash;
  } catch {
    u = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  }
  if (u.length <= 64) return u;
  return u.slice(0, 40) + "…" + u.slice(-18);
}

export default function FrostUrlBar({
  url,
  engines,
  selectedId,
  onPickEngine,
  onGo,
}: {
  url: string;
  engines: FrostEngine[];
  selectedId: string;
  onPickEngine: (id: string) => void;
  /** resolve + drive the active tab (the stage owns engineTarget) */
  onGo: (text: string, mods: { ctrl: boolean; shift: boolean }) => void;
  /** accepted for signature parity — the url bar never melts: it is
      information, not a button (browsers keep the address bar visible) */
  idle?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = engines.find((e) => e.id === selectedId) ?? engines[0];

  /* entering edit mode preloads the field with the current url — edit-in-place,
     like every real omnibox */
  const startEditing = () => {
    setText(url || "");
    setEditing(true);
    setPickerOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 30);
  };

  const submit = (mods: { ctrl: boolean; shift: boolean }) => {
    const q = text.trim();
    setEditing(false);
    setPickerOpen(false);
    if (!q) return;
    onGo(q, mods);
  };

  /* outside click collapses both the picker and edit mode */
  useEffect(() => {
    if (!editing && !pickerOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setEditing(false);
        setPickerOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [editing, pickerOpen]);

  return (
    <div
      ref={rootRef}
      className={`frost-urlbar frost-glass ${editing ? "frost-urlbar-editing" : ""}`}
      role="group"
      aria-label="address bar"
    >
      {/* the engine selector — exactly where the main search keeps it */}
      <button
        type="button"
        className="frost-urlbar-engine"
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        aria-label={`search engine: ${selected?.name ?? "google"}`}
        title={`search with ${selected?.name ?? "google"}`}
        onClick={() => {
          if (editing) setPickerOpen((o) => !o);
          else startEditing();
        }}
      >
        {selected && <EngineGlyph engine={selected} />}
      </button>

      {editing ? (
        <input
          ref={inputRef}
          type="text"
          className="frost-urlbar-text"
          value={text}
          placeholder="Search or enter address"
          aria-label="search or enter address"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit({ ctrl: e.ctrlKey, shift: e.shiftKey });
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setEditing(false);
              setPickerOpen(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="frost-urlbar-display"
          title={url}
          onClick={startEditing}
        >
          <span className="frost-urlbar-host">{hostOf(url)}</span>
          <span className="frost-urlbar-path">{pathOf(url)}</span>
        </button>
      )}

      <button
        type="button"
        className="frost-urlbar-go"
        tabIndex={-1}
        aria-label={editing ? "go" : "edit address"}
        onClick={() => (editing ? submit({ ctrl: false, shift: false }) : startEditing())}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M0 0h24v24H0V0z" fill="none" />
          <path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 001.48-5.34c-.47-2.78-2.79-5-5.59-5.34a6.505 6.505 0 00-7.27 7.27c.34 2.8 2.56 5.12 5.34 5.59a6.5 6.5 0 005.34-1.48l.27.28v.79l4.25 4.25c.41.41 1.08.41 1.49 0 .41-.41.41-1.08 0-1.49L15.5 14zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
        </svg>
      </button>

      {/* the engine picker — slides in from the left, like the home bar's */}
      <div
        className={`frost-urlbar-picker frost-low-elevation ${pickerOpen ? "frost-urlbar-picker-visible" : ""}`}
        role="menu"
        aria-label="search engines"
      >
        {engines.map((e) => (
          <button
            key={e.id}
            type="button"
            role="menuitem"
            className="frost-urlbar-engine"
            aria-label={`engine ${e.name}`}
            title={e.name}
            onClick={() => {
              onPickEngine(e.id);
              setPickerOpen(false);
              window.setTimeout(() => inputRef.current?.focus(), 30);
            }}
          >
            <EngineGlyph engine={e} />
          </button>
        ))}
      </div>
    </div>
  );
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0] || raw;
  }
}

function pathOf(raw: string): string {
  try {
    const u = new URL(raw);
    return (u.pathname === "/" ? "" : u.pathname) + u.search + u.hash;
  } catch {
    return "";
  }
}
