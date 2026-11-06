"use client";

/**
 * WidgetEditor — the home's edit mode. Fullscreen over the wallpaper:
 * the widgets sit still while the user drags cards, resizes them from
 * eight grips, deletes via the red trash, and pulls fresh ones from the
 * right-side palette. Selecting a widget reveals its settings — plain,
 * Apple-style: switch rows, a pill slider and dropdown pickers.
 *
 * Everything writes straight into the frost store's homeLayout, so the
 * layout survives reloads.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { FrostWidget, FrostWidgetKind, FrostWidgetSettings } from "@/lib/murke/frost-store";
import {
  FONT_CHOICES,
  FROST_GLASS_FONT,
  WIDGET_DEFS,
  WidgetBoard,
  ensureGoogleFont,
  timezones,
  zoneLabel,
} from "./FrostWidgets";

export default function WidgetEditor({
  widgets,
  selectedId,
  onSelect,
  onAdd,
  onChange,
  onDelete,
  onDone,
  grid,
  onGrid,
}: {
  widgets: FrostWidget[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAdd: (kind: FrostWidgetKind) => void;
  onChange: (id: string, patch: Partial<FrostWidget>) => void;
  onDelete: (id: string) => void;
  onDone: () => void;
  /** snap-to-grid toggle (lines up widgets + the search bar) */
  grid: boolean;
  onGrid: (on: boolean) => void;
}) {
  const selected = widgets.find((w) => w.id === selectedId) ?? null;
  const [fontQuery, setFontQuery] = useState("");
  const [fontOpen, setFontOpen] = useState(false);
  const [zoneQuery, setZoneQuery] = useState("");
  const [zoneOpen, setZoneOpen] = useState(false);

  /* THE DODGE — while a widget is dragged toward this palette, the palette
     slides off-screen right, freeing the wall behind it; drop the widget
     there and it springs back. Hysteresis (near/far margins) keeps the
     edge from flickering; drag end always recalls it. */
  const paletteRef = useRef<HTMLElement | null>(null);
  const [dodged, setDodged] = useState(false);
  const dodgeRectRef = useRef<DOMRect | null>(null);
  useEffect(() => {
    /* the resting box with any in-flight return-transition subtracted —
       getBoundingClientRect alone would report the mid-animation box */
    const restingRect = (el: HTMLElement): DOMRect => {
      const r = el.getBoundingClientRect();
      const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform);
      if (m) {
        const p = m[1].split(",").map(parseFloat);
        const tx = p[4] || 0;
        const ty = p[5] || 0;
        return new DOMRect(r.x - tx, r.y - ty, r.width, r.height);
      }
      return r;
    };
    /* distance from a point to the rect's edge (0 when inside) */
    const distTo = (r: DOMRect, x: number, y: number): number => {
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      return Math.hypot(dx, dy);
    };
    const NEAR = 64; // cursor enters the palette's zone → dodge
    const FAR = 210; // clearly away → come back (hysteresis band)
    const onDrag = (e: Event) => {
      const d = (e as CustomEvent<{ x: number; y: number; active: boolean }>).detail;
      if (!d) return;
      const el = paletteRef.current;
      if (!d.active || !el) {
        dodgeRectRef.current = null;
        setDodged(false);
        return;
      }
      if (!dodgeRectRef.current) dodgeRectRef.current = restingRect(el);
      const dist = distTo(dodgeRectRef.current, d.x, d.y);
      setDodged((prev) => (prev ? dist <= FAR : dist <= NEAR));
    };
    window.addEventListener("frost-widget-drag", onDrag);
    return () => window.removeEventListener("frost-widget-drag", onDrag);
  }, []);

  /* dropdowns reset whenever the selection changes (render-time reset —
     the React pattern for adjusting state in response to prop changes) */
  const [lastSel, setLastSel] = useState(selectedId);
  if (lastSel !== selectedId) {
    setLastSel(selectedId);
    setFontOpen(false);
    setZoneOpen(false);
    setFontQuery("");
    setZoneQuery("");
  }

  /* the editor shell is pointer-transparent (the search bar and the
     widgets must all stay grabbable through it) — deselect only
     when a press lands on genuinely empty wallpaper */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest(".frost-widget, .frost-weditor-palette, .frost-cluster-grip, .frost-search-bar")) return;
      onSelect(null);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [onSelect]);

  /* dropdowns close on Escape */
  useEffect(() => {
    if (!fontOpen && !zoneOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFontOpen(false);
        setZoneOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fontOpen, zoneOpen]);

  const font = selected?.settings.font?.trim() || FROST_GLASS_FONT;
  const fontMatches = useMemo(() => {
    const q = fontQuery.trim().toLowerCase();
    return q ? FONT_CHOICES.filter((f) => f.toLowerCase().includes(q)) : FONT_CHOICES;
  }, [fontQuery]);
  /* a query that matches nothing is an offer: any Google font by name */
  const fontCustom =
    fontQuery.trim() && !FONT_CHOICES.some((f) => f.toLowerCase() === fontQuery.trim().toLowerCase())
      ? fontQuery.trim()
      : "";

  /* an open dropdown (or a fresh search) loads the faces it previews */
  useEffect(() => {
    if (!fontOpen) return;
    for (const f of fontMatches) ensureGoogleFont(f);
  }, [fontOpen, fontMatches]);

  /* selecting a widget brings its settings into view */
  const optsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selectedId) return;
    optsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedId]);

  const setSettings = (patch: Partial<FrostWidgetSettings>) => {
    if (!selected) return;
    onChange(selected.id, { settings: { ...selected.settings, ...patch } });
  };

  const zones = useMemo(() => {
    const q = zoneQuery.trim().toLowerCase();
    return q
      ? timezones().filter(
          (z) => z.toLowerCase().includes(q) || zoneLabel(z).toLowerCase().includes(q),
        )
      : timezones();
  }, [zoneQuery]);
  const tz = selected?.settings.tz?.trim() ? selected.settings.tz.trim() : "";

  const applyFont = (name: string) => {
    setSettings({ font: name });
    ensureGoogleFont(name);
    setFontOpen(false);
    setFontQuery("");
  };

  const size = selected?.settings.size ?? 22;

  return (
    <div className="frost-weditor" role="dialog" aria-label="home editor">
      {/* the dim veil — purely visual, pointer-transparent */}
      <div className="frost-weditor-veil" aria-hidden="true" />

      {/* the grid — visible cells while snap is on */}
      {grid && <div className="frost-weditor-grid" aria-hidden="true" />}

      {/* the canvas — widgets themselves (drag/resize handled by board) */}
      <WidgetBoard
        widgets={widgets}
        editing
        selectedId={selectedId}
        onSelect={onSelect}
        onChange={onChange}
        onDelete={onDelete}
        grid={grid}
      />

      {/* the palette — right side, scrollable live previews + settings.
          Slides off-screen while a dragged widget comes at it (the dodge) */}
      <aside
        ref={paletteRef}
        className={`frost-weditor-palette ${dodged ? "frost-weditor-palette-dodged" : ""}`}
        onPointerDown={(e) => {
          e.stopPropagation();
          /* a press outside any dropdown closes them */
          if (!(e.target as HTMLElement).closest(".frost-weditor-pick")) {
            setFontOpen(false);
            setZoneOpen(false);
          }
        }}
        aria-label="widgets"
      >
        <div className="frost-weditor-head">
          <span>Editor</span>
          <button type="button" className="frost-weditor-done" onClick={onDone}>
            Done
          </button>
        </div>

        {/* snap-to-grid — lines up widgets + the search bar */}
        <div className="frost-weditor-gridrow">
          <span className="frost-weditor-gridrow-name">Snap to Grid</span>
          <button
            type="button"
            role="switch"
            aria-checked={grid}
            aria-label="snap to grid"
            className={`frost-weditor-switch ${grid ? "frost-weditor-switch-on" : ""}`}
            onClick={() => onGrid(!grid)}
          >
            <span className="frost-weditor-switch-knob" />
          </button>
        </div>

        <div className="frost-weditor-scroll">
          <div className="frost-weditor-pal-list">
            {WIDGET_DEFS.map((def) => (
              <button
                key={def.kind}
                type="button"
                className="frost-weditor-pal-item"
                onClick={() => onAdd(def.kind)}
                title={`add ${def.label}`}
              >
                <span className="frost-weditor-pal-meta">
                  <span className="frost-weditor-pal-name">{def.label}</span>
                  <span className="frost-weditor-pal-hint">{def.hint}</span>
                </span>
                <span className="frost-weditor-pal-add" aria-hidden="true">
                  +
                </span>
              </button>
            ))}
          </div>

          {/* the selected widget's own settings */}
          {selected && (
            <div className="frost-weditor-opts" ref={optsRef}>
              <div className="frost-weditor-opts-title">{selected.kind} settings</div>

              {selected.kind === "clock" && (
                <>
                  <section className="frost-weditor-sec">
                    <div className="frost-weditor-sec-name">Font</div>
                    <div className="frost-weditor-pick">
                      <button
                        type="button"
                        className={`frost-weditor-picker ${fontOpen ? "frost-weditor-picker-open" : ""}`}
                        onClick={() => {
                          setFontOpen((o) => !o);
                          setZoneOpen(false);
                        }}
                        aria-haspopup="listbox"
                        aria-expanded={fontOpen}
                      >
                        <span
                          className="frost-weditor-picker-main"
                          style={{
                            fontFamily:
                              font === FROST_GLASS_FONT
                                ? `"${FROST_GLASS_FONT}", var(--frost-glass-font), var(--frost-font), sans-serif`
                                : `'${font}', "${FROST_GLASS_FONT}", var(--frost-font), sans-serif`,
                          }}
                        >
                          {font}
                        </span>
                        <PickerChevron />
                      </button>
                      {fontOpen && (
                        <div className="frost-weditor-picker-pop" role="listbox" aria-label="fonts">
                          <input
                            type="text"
                            className="frost-weditor-picker-search"
                            placeholder="Search fonts…"
                            value={fontQuery}
                            autoFocus
                            onChange={(e) => setFontQuery(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") applyFont(fontCustom || fontMatches[0] || font);
                            }}
                          />
                          <div className="frost-weditor-picker-list">
                            {fontCustom && (
                              <button
                                type="button"
                                className="frost-weditor-picker-row frost-weditor-picker-row-custom"
                                onClick={() => applyFont(fontCustom)}
                              >
                                <span className="frost-weditor-picker-main">Use “{fontCustom}”</span>
                              </button>
                            )}
                            {fontMatches.map((f) => (
                              <button
                                key={f}
                                type="button"
                                role="option"
                                aria-selected={f === font}
                                className={`frost-weditor-picker-row ${f === font ? "frost-weditor-picker-row-on" : ""}`}
                                style={{
                                  fontFamily:
                                    f === FROST_GLASS_FONT
                                      ? `"${FROST_GLASS_FONT}", var(--frost-glass-font), var(--frost-font), sans-serif`
                                      : `'${f}', "${FROST_GLASS_FONT}", var(--frost-font), sans-serif`,
                                }}
                                onClick={() => applyFont(f)}
                              >
                                <span className="frost-weditor-picker-main">{f}</span>
                                {f === font && <PickerCheck />}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </section>

                  <section className="frost-weditor-sec">
                    <div className="frost-weditor-sec-name">Time</div>
                    <SwitchRow
                      label="24-hour clock"
                      on={selected.settings.format24 === true}
                      onToggle={(v) => setSettings({ format24: v })}
                    />
                    <SwitchRow
                      label="Show seconds"
                      on={selected.settings.seconds === true}
                      onToggle={(v) => setSettings({ seconds: v })}
                    />
                  </section>

                  <section className="frost-weditor-sec">
                    <div className="frost-weditor-sec-name">Timezone</div>
                    <div className="frost-weditor-pick">
                      <button
                        type="button"
                        className={`frost-weditor-picker ${zoneOpen ? "frost-weditor-picker-open" : ""}`}
                        onClick={() => {
                          setZoneOpen((o) => !o);
                          setFontOpen(false);
                        }}
                        aria-haspopup="listbox"
                        aria-expanded={zoneOpen}
                      >
                        <span className="frost-weditor-picker-main">{tz ? zoneLabel(tz) : "Device default"}</span>
                        <span className="frost-weditor-picker-sub">{tz || "local"}</span>
                        <PickerChevron />
                      </button>
                      {zoneOpen && (
                        <div className="frost-weditor-picker-pop" role="listbox" aria-label="timezones">
                          <input
                            type="text"
                            className="frost-weditor-picker-search"
                            placeholder="Search timezones…"
                            value={zoneQuery}
                            autoFocus
                            onChange={(e) => setZoneQuery(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && zones[0]) {
                                setSettings({ tz: zones[0] });
                                setZoneOpen(false);
                              }
                            }}
                          />
                          <div className="frost-weditor-picker-list">
                            <button
                              type="button"
                              role="option"
                              aria-selected={!tz}
                              className={`frost-weditor-picker-row ${!tz ? "frost-weditor-picker-row-on" : ""}`}
                              onClick={() => {
                                setSettings({ tz: "" });
                                setZoneOpen(false);
                              }}
                            >
                              <span className="frost-weditor-picker-main">Device default</span>
                              {!tz && <PickerCheck />}
                            </button>
                            {zones.map((z) => (
                              <button
                                key={z}
                                type="button"
                                role="option"
                                aria-selected={tz === z}
                                className={`frost-weditor-picker-row ${tz === z ? "frost-weditor-picker-row-on" : ""}`}
                                onClick={() => {
                                  setSettings({ tz: z });
                                  setZoneOpen(false);
                                }}
                              >
                                <span className="frost-weditor-picker-main">{zoneLabel(z)}</span>
                                {tz === z ? <PickerCheck /> : <span className="frost-weditor-picker-sub">{z}</span>}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </section>
                </>
              )}

              {selected.kind === "weather" && (
                <section className="frost-weditor-sec">
                  <div className="frost-weditor-sec-name">Location</div>
                  <label className="frost-weditor-label">
                    City
                    <input
                      type="text"
                      value={selected.settings.place ?? ""}
                      placeholder="auto-locate"
                      onChange={(e) => setSettings({ place: e.target.value })}
                    />
                  </label>
                </section>
              )}

              {selected.kind === "notes" && (
                <section className="frost-weditor-sec">
                  <div className="frost-weditor-sec-name">Note</div>
                  <label className="frost-weditor-label">
                    <textarea
                      rows={6}
                      value={selected.settings.note ?? ""}
                      placeholder="write something…"
                      onChange={(e) => setSettings({ note: e.target.value })}
                    />
                  </label>
                </section>
              )}

              {selected.kind === "text" && (
                <>
                  <section className="frost-weditor-sec">
                    <div className="frost-weditor-sec-name">Text</div>
                    <label className="frost-weditor-label">
                      <textarea
                        rows={3}
                        value={selected.settings.text ?? ""}
                        placeholder="type something…"
                        onChange={(e) => setSettings({ text: e.target.value })}
                      />
                    </label>
                  </section>
                  <section className="frost-weditor-sec">
                    <div className="frost-weditor-sechead">
                      <span className="frost-weditor-sec-name">Size</span>
                      <span className="frost-weditor-sec-val">{size} px</span>
                    </div>
                    <input
                      type="range"
                      className="frost-weditor-range"
                      min={10}
                      max={96}
                      value={size}
                      aria-label="text size"
                      onChange={(e) => setSettings({ size: Number(e.target.value) })}
                      style={{ "--frost-fill": `${((size - 10) / 86) * 100}%` } as CSSProperties}
                    />
                  </section>
                </>
              )}

              <button type="button" className="frost-weditor-delete" onClick={() => onDelete(selected.id)}>
                Delete this widget
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/** an iOS-style row — the label left, the switch right */
function SwitchRow({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <div className="frost-weditor-swrow">
      <span className="frost-weditor-swrow-name">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={`frost-weditor-switch ${on ? "frost-weditor-switch-on" : ""}`}
        onClick={() => onToggle(!on)}
      >
        <span className="frost-weditor-switch-knob" />
      </button>
    </div>
  );
}

/** the dropdown chevron — flips when open */
function PickerChevron() {
  return (
    <svg className="frost-weditor-picker-chev" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M2.5 4.5L6 8l3.5-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** the selected-row checkmark */
function PickerCheck() {
  return (
    <svg className="frost-weditor-picker-check" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M2.5 7.5l3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
