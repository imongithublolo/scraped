"use client";

/**
 * FrostSettings — 1:1 with the user's settings.html: a left tab rail
 * (Appearance · Search · Shortcuts · Wallpaper · About) and a white panel
 * sheet with the exact same sections: Glass knobs, Search bar dims,
 * Shortcuts style, the engines table (drag to sort + editor), keyboard
 * modifiers, shortcut table + editor, the Wallpaper tab (the only place
 * the wallpapers exist) with Load File / drag-drop / webp-style
 * compression knobs, and the About panel.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { EngineGlyph } from "./EngineGlyph";
import { ShortcutGlyph } from "./ShortcutGlyph";
import {
  WALLPAPERS,
  compressWallpaper,
  type FrostEngine,
  type FrostShortcut,
  type FrostSettings,
} from "@/lib/murke/frost-store";

export type FrostTab = "appearance" | "search" | "shortcuts" | "editor" | "wallpaper" | "about";

/* ---------- slider row (1:1 with the .slider markup) ---------- */

/* the design's own tab icons — the extension's filled Material glyphs,
   inline so they render identically with zero network */
const MATERIAL_ICONS: Record<FrostTab, React.ReactNode> = {
  appearance: (
    <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
  ),
  search: (
    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
  ),
  shortcuts: <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />,
  editor: (
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 000-1.41l-2.34-2.34a.996.996 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
  ),
  wallpaper: (
    <path d="M4 4h7V2H4c-1.1 0-2 .9-2 2v7h2V4zm6 9l-4 5h12l-3-4-2.03 2.71L10 13zm7-4.5c0-.83-.67-1.5-1.5-1.5S14 7.67 14 8.5s.67 1.5 1.5 1.5S17 9.33 17 8.5zM20 2h-7v2h7v7h2V4c0-1.1-.9-2-2-2zm0 18h-7v2h7c1.1 0 2-.9 2-2v-7h-2v7zM4 13H2v7c0 1.1.9 2 2 2h7v-2H4v-7z" />
  ),
  about: <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />,
};

function SliderRow({
  label,
  value,
  unit,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  unit?: string;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const step = max - min >= 100 ? (max > 150 ? 5 : 1) : 1;
  const bump = (d: number) => onChange(Math.min(max, Math.max(min, value + d)));
  return (
    <>
      <h2>{label} -</h2>
      <h2 className="frost-value" style={{ fontWeight: 250 }}>
        {value}
      </h2>
      <h2 style={{ fontWeight: 250, display: "inline-block" }}>{unit ?? "%"}</h2>
      <div className="frost-slider">
        <div className="frost-square frost-button frost-low-roundness" data-minus="" onClick={() => bump(-step)} role="button" aria-label={`${label} minus`}>
          -
        </div>
        <div className="frost-square frost-button frost-low-roundness" data-plus="" onClick={() => bump(step)} role="button" aria-label={`${label} plus`}>
          +
        </div>
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          aria-label={label}
          style={{ background: `linear-gradient(90deg, var(--black) ${pct}%, var(--grey) ${pct}%)` }}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <div className="frost-button frost-low-roundness" onClick={() => onChange(min <= 0 && max >= 100 && unit === undefined ? Math.round((min + max) / 2) : value)} role="button" aria-label={`${label} reset`}>
          Reset
        </div>
      </div>
    </>
  );
}

/* ---------- engine editor popup ---------- */

function EngineEditor({
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  initial: FrostEngine | null;
  onSave: (e: FrostEngine) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [base, setBase] = useState(initial?.q ?? "");
  const [sep, setSep] = useState(initial?.id === "web" ? "%20" : "+");
  const [icon, setIcon] = useState(initial?.icon ?? "");
  const [confirmDel, setConfirmDel] = useState(false);

  return (
    <div className="frost-popup frost-high-roundness frost-white-background frost-show-popup" role="dialog" aria-label="engine editor">
      <center>
        <h1 style={{ fontSize: 28, fontWeight: 350 }}>Engine Editor</h1>
      </center>
      <h2>Name</h2>
      <input type="text" className="frost-low-roundness" placeholder="eg. Google" value={name} onChange={(e) => setName(e.target.value)} />
      <h2>Base URL</h2>
      <input type="text" className="frost-low-roundness" placeholder="https://www.google.com/search?q=" value={base} onChange={(e) => setBase(e.target.value)} />
      <h2>Separator</h2>
      <h3 style={{ fontWeight: 350 }}>This separates the search terms in the URL</h3>
      <input type="text" className="frost-low-roundness" placeholder="+" value={sep} onChange={(e) => setSep(e.target.value)} />
      <h2>Icon URL</h2>
      <input type="text" className="frost-low-roundness" placeholder="Link to icon image file" value={icon} onChange={(e) => setIcon(e.target.value)} />
      <div className="frost-button-container">
        {initial && onDelete && (
          <button type="button" className="frost-button frost-low-roundness frost-delete-button" onClick={() => setConfirmDel(true)}>
            Delete
          </button>
        )}
        <button type="button" className="frost-button frost-low-roundness" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="frost-button frost-low-roundness frost-save-button"
          disabled={!name.trim()}
          onClick={() =>
            onSave({
              id: initial?.id ?? `eng-${Date.now()}`,
              name: name.trim(),
              q: base.trim() ? base.trim() + (sep.trim() || "+") : null,
              icon: icon.trim() || undefined,
            })
          }
        >
          Save
        </button>
      </div>
      {confirmDel && initial && onDelete && (
        <div className="frost-popup frost-high-roundness frost-white-background frost-show-popup" style={{ maxWidth: 360 }} role="alertdialog" aria-label="confirm delete engine">
          <h2 style={{ fontWeight: 350 }}>Are you sure you want to delete this search engine?</h2>
          <div className="frost-button-container">
            <button type="button" className="frost-button frost-low-roundness" onClick={() => setConfirmDel(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="frost-button frost-low-roundness frost-delete-button"
              onClick={() => {
                onDelete(initial.id);
                onClose();
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- shortcut editor popup (shared with the home stage — the
   design's #shortcut-creator opens straight from the context menu) ---------- */

export function ShortcutEditor({
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  initial: FrostShortcut | null;
  onSave: (s: FrostShortcut) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "");
  const [confirmDel, setConfirmDel] = useState(false);

  return (
    <div className="frost-popup frost-high-roundness frost-white-background frost-show-popup" role="dialog" aria-label="shortcut editor">
      <center>
        <h1 style={{ fontSize: 28, fontWeight: 350 }}>{initial ? "Edit Shortcut" : "Create Shortcut"}</h1>
      </center>
      <h2>Shortcut Name</h2>
      <input type="text" className="frost-low-roundness" placeholder="Enter a name for the shortcut" value={name} onChange={(e) => setName(e.target.value)} />
      <h2>Shortcut Link</h2>
      <input type="text" className="frost-low-roundness" placeholder="https://example.com/page" value={url} onChange={(e) => setUrl(e.target.value)} />
      <h2>Custom Icon {initial ? "" : "(Optional)"}</h2>
      <input type="text" className="frost-low-roundness" placeholder="Enter a link to an icon" value={icon} onChange={(e) => setIcon(e.target.value)} />
      <div className="frost-button-container">
        {initial && onDelete && (
          <button type="button" className="frost-button frost-low-roundness frost-delete-button" onClick={() => setConfirmDel(true)}>
            Delete
          </button>
        )}
        <button type="button" className="frost-button frost-low-roundness" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="frost-button frost-low-roundness frost-save-button"
          disabled={!name.trim() || !url.trim()}
          onClick={() => onSave({ id: initial?.id ?? `sc-${Date.now()}`, name: name.trim(), url: url.trim(), icon: icon.trim() || undefined })}
        >
          {initial ? "Save" : "Create"}
        </button>
      </div>
      {confirmDel && initial && onDelete && (
        <div className="frost-popup frost-high-roundness frost-white-background frost-show-popup" style={{ maxWidth: 360 }} role="alertdialog" aria-label="confirm delete shortcut">
          <h2 style={{ fontWeight: 350 }}>Are you sure you want to delete this shortcut?</h2>
          <div className="frost-button-container">
            <button type="button" className="frost-button frost-low-roundness" onClick={() => setConfirmDel(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="frost-button frost-low-roundness frost-delete-button"
              onClick={() => {
                onDelete(initial.id);
                onClose();
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- main settings ---------- */

export default function FrostSettings({
  tab,
  onTab,
  settings,
  patch,
  onClose,
  onOpenEditor,
}: {
  tab: FrostTab;
  onTab: (t: FrostTab) => void;
  settings: FrostSettings;
  patch: (p: Partial<FrostSettings> | ((s: FrostSettings) => Partial<FrostSettings>)) => void;
  onClose: () => void;
  /** the Editor tab's door into the home editor mode */
  onOpenEditor: () => void;
}) {
  const [engineEdit, setEngineEdit] = useState<FrostEngine | null | undefined>(undefined); // undefined = closed
  const [shortcutEdit, setShortcutEdit] = useState<FrostShortcut | null | undefined>(undefined);
  const dragEngine = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [wpQuality, setWpQuality] = useState(100);
  const [wpMaxH, setWpMaxH] = useState(2000);
  const [wpNote, setWpNote] = useState("");

  const set = patch; // the store's action — stable by design

  /* compress + store a picked image (the Frost "image optimization" path) */
  const storeFile = useCallback(
    (file: File) => {
      compressWallpaper(file, wpQuality, wpMaxH)
        .then((url) => {
          set({ wallpaper: url });
          setWpNote("wallpaper saved");
        })
        .catch(() => setWpNote("could not read that image"));
    },
    [set, wpMaxH, wpQuality],
  );

  const engines = settings.engines;
  const reorder = useMemo(
    () => (from: string, to: string) => {
      if (from === to) return;
      const list = [...engines];
      const fi = list.findIndex((e) => e.id === from);
      const ti = list.findIndex((e) => e.id === to);
      if (fi < 0 || ti < 0) return;
      const [moved] = list.splice(fi, 1);
      list.splice(ti, 0, moved);
      set({ engines: list });
    },
    [engines, set],
  );

  const tabIcon = (t: FrostTab) => (
    <svg viewBox="0 0 24 24" width={24} height={24} aria-hidden="true" style={{ fill: "currentColor" }}>
      {MATERIAL_ICONS[t]}
    </svg>
  );

  const TABS: FrostTab[] = ["appearance", "search", "shortcuts", "editor", "wallpaper", "about"];
  const LABEL: Record<FrostTab, string> = {
    appearance: "Appearance",
    search: "Search",
    shortcuts: "Shortcuts",
    editor: "Editor",
    wallpaper: "Wallpaper",
    about: "About",
  };

  return (
    <div className="frost-full-screen" style={{ zIndex: 45 }} role="dialog" aria-label="settings">
      <div className="frost-settings-content">
        <div className="frost-tabs frost-white-background frost-low-elevation frost-medium-roundness">
          {TABS.map((t) => (
            <button key={t} type="button" className={`frost-tab ${tab === t ? "frost-tab-select" : ""}`} onClick={() => onTab(t)}>
              {tabIcon(t)}
              <span> {LABEL[t]} </span>
            </button>
          ))}
        </div>

        <div className="frost-settings-main frost-white-background frost-subtle-elevation frost-medium-roundness">
          {/* ---------------- appearance ---------------- */}
          {tab === "appearance" && (
            <div className="frost-panel">
              <div className="frost-panel-header">
                <h1>Glass</h1>
              </div>
              <SliderRow label="Transparency" value={settings.glass.transparency} min={0} max={100} onChange={(v) => set({ glass: { ...settings.glass, transparency: v } })} />
              <SliderRow label="Blur" value={settings.glass.blur} min={0} max={100} onChange={(v) => set({ glass: { ...settings.glass, blur: v } })} />
              <SliderRow label="Brightness" value={settings.glass.brightness} min={50} max={200} onChange={(v) => set({ glass: { ...settings.glass, brightness: v } })} />
              <SliderRow label="Saturation" value={settings.glass.saturation} min={0} max={150} onChange={(v) => set({ glass: { ...settings.glass, saturation: v } })} />

              <div className="frost-panel-header" style={{ marginTop: 24 }}>
                <h1>Search bar</h1>
              </div>
              <SliderRow label="Rounded Corners" value={settings.searchBar.radius} min={0} max={100} onChange={(v) => set({ searchBar: { ...settings.searchBar, radius: v } })} />
              <SliderRow label="Height" value={settings.searchBar.height} min={50} max={200} onChange={(v) => set({ searchBar: { ...settings.searchBar, height: v } })} />
              <SliderRow label="Width" value={settings.searchBar.width} min={50} max={200} onChange={(v) => set({ searchBar: { ...settings.searchBar, width: v } })} />
              <h3 style={{ marginTop: 8 }}>Note: The width of the search bar will not exceed 90% of the browser&apos;s width.</h3>

              <div className="frost-panel-header" style={{ marginTop: 24 }}>
                <h1>Shortcuts</h1>
              </div>
              <SliderRow label="Rounded Corners" value={settings.shortcutsStyle.radius} min={0} max={100} onChange={(v) => set({ shortcutsStyle: { ...settings.shortcutsStyle, radius: v } })} />
              <SliderRow label="Size" value={settings.shortcutsStyle.size} min={50} max={150} onChange={(v) => set({ shortcutsStyle: { ...settings.shortcutsStyle, size: v } })} />
              <div className="frost-flex-row" style={{ margin: "12px 0" }}>
                <h2>Font Color</h2>
                <select
                  className="frost-input frost-low-roundness"
                  style={{ width: "auto", fontSize: 16, padding: "6px 10px" }}
                  value={settings.shortcutsStyle.fontColor}
                  aria-label="shortcut font color"
                  onChange={(e) => set({ shortcutsStyle: { ...settings.shortcutsStyle, fontColor: e.target.value as FrostSettings["shortcutsStyle"]["fontColor"] } })}
                >
                  <option value="black">Black</option>
                  <option value="white">White</option>
                  <option value="transparent">Transparent</option>
                </select>
              </div>

              <div className="frost-panel-header" style={{ marginTop: 24 }}>
                <h1>Floating Controls</h1>
              </div>
              <div className="frost-flex-row" style={{ margin: "12px 0" }}>
                <h2>Corner Buttons</h2>
                <select
                  className="frost-input frost-low-roundness"
                  style={{ width: "auto", fontSize: 16, padding: "6px 10px" }}
                  value={settings.floatingControls ? "show" : "hide"}
                  aria-label="floating controls"
                  onChange={(e) => set({ floatingControls: e.target.value === "show" })}
                >
                  <option value="show">Show</option>
                  <option value="hide">Hide</option>
                </select>
              </div>
              <div className="frost-flex-row" style={{ margin: "12px 0" }}>
                <h2>Fade When Idle</h2>
                <select
                  className="frost-input frost-low-roundness"
                  style={{ width: "auto", fontSize: 16, padding: "6px 10px" }}
                  value={settings.idleFade ? "fade" : "always"}
                  aria-label="fade when idle"
                  onChange={(e) => set({ idleFade: e.target.value === "fade" })}
                >
                  <option value="fade">Fade</option>
                  <option value="always">Always visible</option>
                </select>
              </div>
              <h3>Back / forward / home ride the bottom-left corner, devtools &lt;&gt; the bottom-right. When idle they go almost invisible.</h3>

              <div className="frost-panel-header" style={{ marginTop: 24 }}>
                <h1>Wallpaper Blur</h1>
              </div>
              <SliderRow label="Blur" value={settings.wallpaperBlur} min={0} max={100} onChange={(v) => set({ wallpaperBlur: v })} />
              <h3>Softens the wallpaper behind the glass — 0% keeps it crisp.</h3>
              <br />
            </div>
          )}

          {/* ---------------- search ---------------- */}
          {tab === "search" && (
            <div className="frost-panel">
              <div className="frost-panel-header">
                <h1>Search Engines</h1>
              </div>
              <h3 style={{ marginTop: 0 }}>Drag to sort</h3>
              <div
                className="frost-low-roundness frost-subtle-elevation"
                style={{ background: "white", borderRadius: 8 }}
              >
                {engines.map((e) => (
                  <div
                    key={e.id}
                    className="frost-engine-tab frost-low-roundness"
                    draggable
                    onDragStart={() => (dragEngine.current = e.id)}
                    onDragOver={(ev) => {
                      ev.preventDefault();
                      if (dragEngine.current) reorder(dragEngine.current, e.id);
                    }}
                    onDragEnd={() => (dragEngine.current = null)}
                  >
                    <EngineGlyph engine={e} />
                    <div>{e.name}</div>
                    <button type="button" className="frost-button frost-low-roundness" onClick={() => setEngineEdit(e)}>
                      Edit
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className="frost-button frost-low-roundness" style={{ width: "fit-content", margin: "16px 0px" }} onClick={() => setEngineEdit(null)}>
                Add Search Engine
              </button>

              <div className="frost-panel-header" style={{ marginTop: 24 }}>
                <h1>Keyboard Modifiers</h1>
              </div>
              {(
                [
                  ["Default", "def"],
                  ["Ctrl", "ctrl"],
                  ["Shift", "shift"],
                  ["Ctrl + Shift", "ctrlShift"],
                ] as const
              ).map(([label, key]) => (
                <div className="frost-flex-row" key={key} style={{ margin: "8px 0" }}>
                  <h2>{label}</h2>
                  <select
                    className="frost-input frost-low-roundness"
                    style={{ width: "auto", fontSize: 16, padding: "6px 10px" }}
                    value={settings.modifiers[key]}
                    aria-label={`${label} engine`}
                    onChange={(ev) => set({ modifiers: { ...settings.modifiers, [key]: ev.target.value } })}
                  >
                    {engines.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <br />
            </div>
          )}

          {/* ---------------- shortcuts ---------------- */}
          {tab === "shortcuts" && (
            <div className="frost-panel">
              <div className="frost-panel-header">
                <h1>Shortcuts</h1>
              </div>
              {settings.shortcuts.length === 0 ? (
                <h3 style={{ marginTop: 0 }}>
                  Shortcuts let you quickly get to the sites you use most often. Use the button below to add some!
                </h3>
              ) : (
                <h3 style={{ marginTop: 0 }}>Drag to sort</h3>
              )}
              <div className="frost-low-roundness frost-subtle-elevation" style={{ background: "white", borderRadius: 8 }}>
                {settings.shortcuts.map((c) => (
                  <div
                    key={c.id}
                    className="frost-engine-tab frost-low-roundness"
                    draggable
                    onDragStart={() => (dragEngine.current = c.id)}
                    onDragOver={(ev) => {
                      ev.preventDefault();
                      if (!dragEngine.current) return;
                      const list = [...settings.shortcuts];
                      const fi = list.findIndex((x) => x.id === dragEngine.current);
                      const ti = list.findIndex((x) => x.id === c.id);
                      if (fi < 0 || ti < 0 || fi === ti) return;
                      const [moved] = list.splice(fi, 1);
                      list.splice(ti, 0, moved);
                      set({ shortcuts: list });
                    }}
                    onDragEnd={() => (dragEngine.current = null)}
                  >
                    <span style={{ padding: 8, display: "flex" }}>
                      {c.icon ? (
                        
                        <img src={c.icon} alt="" width={32} height={32} style={{ objectFit: "contain" }} />
                      ) : (
                        <span style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          <ShortcutGlyph url={c.url} name={c.name} />
                        </span>
                      )}
                    </span>
                    <div>{c.name}</div>
                    <button type="button" className="frost-button frost-low-roundness" onClick={() => setShortcutEdit(c)}>
                      Edit
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className="frost-button frost-low-roundness" style={{ width: "fit-content", margin: "16px 0px" }} onClick={() => setShortcutEdit(null)}>
                Add Shortcut
              </button>
            </div>
          )}

          {/* ---------------- editor ---------------- */}
          {tab === "editor" && (
            <div className="frost-panel">
              <div className="frost-panel-header">
                <h1>Home Editor</h1>
              </div>
              <h3 style={{ marginTop: 0 }}>
                Drag widgets anywhere on the home, resize them from the two rounded corners, delete
                with the red trash. The right-side menu previews every widget you can add — clock
                (any Google font, borderless), the oneko cat, battery, custom text and a full music
                player. In here the search bar and the tabs rail are movable too: grab the little
                dot grip above the search bar, or the tabs rail's header, and pin them wherever you
                like — the tab arrow rides along.
              </h3>
              <div className="frost-flex-row" style={{ margin: "16px 0", gap: 12 }}>
                <button type="button" className="frost-button frost-low-roundness frost-save-button" style={{ width: "fit-content" }} onClick={onOpenEditor}>
                  Open Editor
                </button>
                <span style={{ fontSize: 14, opacity: 0.6, alignSelf: "center" }}>
                  {settings.homeLayout.widgets.length} widget{settings.homeLayout.widgets.length === 1 ? "" : "s"} on the home — or right-click the home → Edit Home.
                </span>
              </div>
              <br />
            </div>
          )}

          {/* ---------------- wallpaper ---------------- */}
          {tab === "wallpaper" && (
            <div className="frost-panel">
              <div className="frost-panel-header">
                <h1>Wallpaper</h1>
              </div>
              <div className="frost-wallpaper-preview frost-low-elevation frost-medium-roundness">
                <img src={settings.wallpaper} alt="current wallpaper" />
              </div>
              <div className="frost-wallpaper-grid">
                {WALLPAPERS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={settings.wallpaper === w ? "frost-wp-selected" : ""}
                    style={{ backgroundImage: `url(${w})` }}
                    aria-label={`wallpaper ${w.split("/").pop()}`}
                    onClick={() => set({ wallpaper: w })}
                  />
                ))}
              </div>

              <div className="frost-panel-header" style={{ marginTop: 24 }}>
                <h1>Wallpaper Blur</h1>
              </div>
              <SliderRow label="Blur" value={settings.wallpaperBlur} min={0} max={100} onChange={(v) => set({ wallpaperBlur: v })} />
              <h3>Softens the wallpaper behind the glass — 0% keeps it crisp. (The same knob lives in Appearance.)</h3>

              <button type="button" className="frost-button frost-low-roundness" style={{ margin: "16px 0px", width: "fit-content" }} onClick={() => fileRef.current?.click()}>
                Load File
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="sr-only"
                aria-label="load wallpaper file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) storeFile(f);
                  e.target.value = "";
                }}
              />
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) storeFile(f);
                }}
                className={dragOver ? "frost-low-roundness" : "frost-low-roundness"}
                style={{
                  padding: "14px 16px",
                  textAlign: "center",
                  fontWeight: 250,
                  fontSize: 15,
                  background: dragOver ? "rgba(0,0,0,0.06)" : "rgba(0,0,0,0.03)",
                  transition: "background 0.2s",
                }}
                aria-label="drop wallpaper here"
              >
                Or drag and drop an image
                {wpNote && <span style={{ opacity: 0.6 }}> — {wpNote}</span>}
              </div>

              <div className="frost-panel-header" style={{ marginTop: 24 }}>
                <h1>Image Optimization</h1>
              </div>
              <h3 style={{ marginTop: -4 }}>
                Loaded wallpapers are saved in the efficient WebP format, allowing for significantly faster
                loading speeds every time you open the site. The factory settings are a great balance between
                performance and quality.
              </h3>
              <SliderRow label="Quality" value={wpQuality} min={20} max={100} onChange={setWpQuality} />
              <SliderRow label="Maximum Height" value={wpMaxH} unit="pixels" min={480} max={4000} onChange={setWpMaxH} />
              <br />
            </div>
          )}

          {/* ---------------- about ---------------- */}
          {tab === "about" && (
            <div className="frost-panel">
              <h1>Frost v1.4.0</h1>
              <h3>Made by b29s and GLM-5.3</h3>
              <br />
            </div>
          )}
        </div>
      </div>

      {/* engine editor popup */}
      {engineEdit !== undefined && (
        <EngineEditor
          initial={engineEdit}
          onClose={() => setEngineEdit(undefined)}
          onSave={(eng) => {
            const exists = engines.some((x) => x.id === eng.id);
            set({ engines: exists ? engines.map((x) => (x.id === eng.id ? eng : x)) : [...engines, eng] });
            setEngineEdit(undefined);
          }}
          onDelete={
            engineEdit
              ? (id) => {
                  const rest = engines.filter((x) => x.id !== id);
                  set({ engines: rest.length ? rest : settings.engines });
                }
              : undefined
          }
        />
      )}

      {/* shortcut editor popup */}
      {shortcutEdit !== undefined && (
        <ShortcutEditor
          initial={shortcutEdit}
          onClose={() => setShortcutEdit(undefined)}
          onSave={(sc) => {
            const exists = settings.shortcuts.some((x) => x.id === sc.id);
            set({
              shortcuts: exists
                ? settings.shortcuts.map((x) => (x.id === sc.id ? sc : x))
                : [...settings.shortcuts, sc],
            });
            setShortcutEdit(undefined);
          }}
          onDelete={
            shortcutEdit
              ? (id) => set({ shortcuts: settings.shortcuts.filter((x) => x.id !== id) })
              : undefined
          }
        />
      )}

      {/* close button — quiet, top right */}
      <button
        type="button"
        onClick={onClose}
        aria-label="close settings"
        className="frost-float-btn frost-white-background frost-subtle-elevation"
        style={{ position: "absolute", top: 14, right: 14, zIndex: 50 }}
      >
        <X width={16} height={16} aria-hidden="true" />
      </button>
    </div>
  );
}
