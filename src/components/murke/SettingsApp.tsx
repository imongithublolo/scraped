"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Droplets,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  Lock,
  Monitor,
  Palette,
  Plus,
  Speaker,
  Sun,
  Trash2,
  AppWindow,
  Dock as DockIcon,
  SquareMousePointer,
} from "lucide-react";
import type { BackgroundKind, CustomTheme, ProxyEngine, SoundEngine, ThemeName, WallpaperChoice } from "@/lib/murke/contracts";
import { CATEGORY_META, THEME_ORDER, THEMES, customThemeDef, getThemeDef, luminance, resolveTheme, resolveThemeKey } from "@/lib/murke/themes";
import type { ThemeCategory } from "@/lib/murke/themes";
import { CRT_PRESETS, presetFor } from "@/lib/murke/crtfx";
import { WALLPAPER_PRESETS } from "@/lib/murke/wallpapers";
import { bootRef } from "@/lib/murke/commands";
import { getVfs } from "@/lib/murke/vfs";
import { useOS } from "@/lib/murke/os-store";
import MurkeMark from "./MurkeMark";

/**
 * Settings v3 — the real settings app. System-settings layout: a narrow
 * section rail and one content pane. Owns every knob of the OS:
 * appearance (theme categories, the dark/light toggle, custom scheme
 * mixer), desktop wallpaper, the dock (size/position/autohide/icons),
 * window management (hyprland snapping + hotkeys), installed web apps
 * (the PWA addon), the CRT engine, key sounds, and the about panel.
 */

type Section = "appearance" | "wallpaper" | "glass" | "dock" | "windows" | "apps" | "lockscreen" | "crt" | "sound" | "about";

const SECTIONS: Array<{ id: Section; label: string; icon: typeof Sun }> = [
  { id: "appearance", label: "appearance", icon: Palette },
  { id: "wallpaper", label: "wallpaper", icon: ImageIcon },
  { id: "glass", label: "liquid glass", icon: Droplets },
  { id: "dock", label: "dock", icon: DockIcon },
  { id: "windows", label: "windows", icon: SquareMousePointer },
  { id: "apps", label: "apps", icon: AppWindow },
  { id: "lockscreen", label: "lock screen", icon: Lock },
  { id: "crt", label: "crt display", icon: Monitor },
  { id: "sound", label: "sound", icon: Speaker },
  { id: "about", label: "about", icon: Info },
];

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[12.5px] text-[var(--term-fg)]">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-snug text-[var(--term-dim)]">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, ariaLabel }: { on: boolean; onChange: (v: boolean) => void; ariaLabel: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
      className="relative h-[22px] w-[38px] cursor-pointer rounded-full border transition-colors"
      style={{
        borderColor: "color-mix(in srgb, var(--term-fg) 22%, transparent)",
        background: on ? "var(--term-brand)" : "color-mix(in srgb, var(--term-fg) 14%, transparent)",
      }}
    >
      <span
        className="absolute top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow transition-all"
        style={{ left: on ? 19 : 2 }}
      />
    </button>
  );
}

function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (v: number) => string;
}) {
  return (
    <label className="block py-1.5">
      <span className="flex items-center justify-between text-[11.5px]">
        <span className="text-[var(--term-fg)]">{label}</span>
        <span className="tabular-nums text-[var(--term-dim)]">{format ? format(value) : `${Math.round(value * 100)}%`}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="murke-range mt-1 w-full"
      />
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: Array<{ v: T; label: string }>; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex overflow-hidden rounded-md border"
      style={{ borderColor: "color-mix(in srgb, var(--term-fg) 18%, transparent)" }}
    >
      {options.map((o) => {
        const on = o.v === value;
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.v)}
            className={`cursor-pointer px-2.5 py-1 text-[11px] lowercase tracking-wide transition-colors ${
              on ? "text-[var(--term-bg)]" : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"
            }`}
            style={{ background: on ? "var(--term-brand)" : "transparent" }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- theme preview card ---------- */

function ThemeCard({ defKey, on, onClick, badge }: { defKey: string; on: boolean; onClick: () => void; badge?: string }) {
  const def = getThemeDef(defKey);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`cursor-pointer rounded-lg border p-2 text-left transition-all hover:scale-[1.02] ${on ? "ring-1" : ""}`}
      style={{
        borderColor: on ? "var(--term-brand)" : "color-mix(in srgb, var(--term-fg) 14%, transparent)",
        background: "color-mix(in srgb, var(--term-bg) 55%, transparent)",
        boxShadow: on ? "0 0 0 1px var(--term-brand)" : undefined,
      }}
    >
      <span
        className="mb-1.5 flex h-14 w-full items-end rounded-md border p-1.5"
        style={{ background: def.bg, borderColor: `color-mix(in srgb, ${def.fg} 20%, transparent)` }}
      >
        <span className="text-[11px] font-bold" style={{ color: def.fg }}>
          guest@murke
        </span>
        <span className="ml-auto h-2 w-2 rounded-full" style={{ background: def.brand }} />
      </span>
      <span className="block truncate text-[11.5px]">{def.label}</span>
      {badge && (
        <span className="mt-0.5 inline-block rounded px-1 py-px text-[9px] uppercase tracking-wider text-[var(--term-dim)]" style={{ background: "color-mix(in srgb, var(--term-fg) 10%, transparent)" }}>
          {badge}
        </span>
      )}
    </button>
  );
}

/* ---------- custom scheme mixer ---------- */

const BG_KINDS: BackgroundKind[] = [
  "fire",
  "emberdust",
  "bonedust",
  "blackhole",
  "acidrain",
  "bloodmoon",
  "snowfall",
  "deadstatic",
  "nebula",
  "sunrise",
  "paperdust",
  "lightaurora",
  "none",
];

const DEFAULT_DRAFT: Omit<CustomTheme, "id"> = {
  name: "my scheme",
  bg: "#0a0a10",
  fg: "#e8e8e8",
  dim: "#8a8a8a",
  err: "#ff5555",
  brand: "#ffb000",
  hi: "#ffffff",
  bgKind: "none",
  light: false,
  skin: "mac",
};

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 py-1">
      <span className="text-[11.5px] text-[var(--term-fg)]">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] text-[var(--term-dim)]">{value}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
          style={{ boxShadow: "0 0 0 1px color-mix(in srgb, var(--term-fg) 22%, transparent)" }}
        />
      </span>
    </label>
  );
}

function SchemeMixer() {
  const customThemes = useOS((s) => s.settings.customThemes);
  const activeCustomId = useOS((s) => s.settings.customThemeId);
  const [draft, setDraft] = useState<Omit<CustomTheme, "id"> & { id: string | null }>({ ...DEFAULT_DRAFT, id: null });

  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));

  const previewDef = useMemo(() => customThemeDef({ ...draft, id: draft.id ?? "preview" }), [draft]);

  const onBg = (bg: string) => set({ bg, light: luminance(bg) > 0.5 });

  const save = () => {
    const id = draft.id ?? Math.random().toString(36).slice(2, 8);
    const theme: CustomTheme = { ...draft, id, name: draft.name.trim().slice(0, 24) || "my scheme" };
    useOS.getState().saveCustomTheme(theme);
    setDraft({ ...theme });
  };

  const editExisting = (t: CustomTheme) => setDraft({ ...t });

  return (
    <div className="mt-4 rounded-lg border p-3" style={{ borderColor: "color-mix(in srgb, var(--term-fg) 14%, transparent)" }}>
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-[var(--term-dim)]">scheme mixer</div>
        {draft.id && (
          <button
            type="button"
            onClick={() => setDraft({ ...DEFAULT_DRAFT, id: null })}
            className="cursor-pointer text-[10.5px] text-[var(--term-dim)] underline underline-offset-2 hover:text-[var(--term-fg)]"
          >
            new instead
          </button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* left: identity + colors */}
        <div>
          <label className="mb-2 block">
            <span className="mb-0.5 block text-[11px] text-[var(--term-dim)]">name</span>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              maxLength={24}
              className="w-full rounded-md border bg-transparent px-2 py-1 text-[12px] text-[var(--term-fg)] outline-none focus:border-[var(--term-brand)]"
              style={{ borderColor: "color-mix(in srgb, var(--term-fg) 20%, transparent)" }}
              aria-label="scheme name"
            />
          </label>
          <ColorField label="background" value={draft.bg} onChange={onBg} />
          <ColorField label="text" value={draft.fg} onChange={(fg) => set({ fg })} />
          <ColorField label="dim text" value={draft.dim} onChange={(dim) => set({ dim })} />
          <ColorField label="errors" value={draft.err} onChange={(err) => set({ err })} />
          <ColorField label="brand" value={draft.brand} onChange={(brand) => set({ brand })} />
          <ColorField label="highlight" value={draft.hi} onChange={(hi) => set({ hi })} />
          <label className="mt-1.5 block">
            <span className="mb-0.5 block text-[11px] text-[var(--term-dim)]">backdrop scene</span>
            <select
              value={draft.bgKind}
              onChange={(e) => set({ bgKind: e.target.value as BackgroundKind })}
              className="w-full cursor-pointer rounded-md border bg-transparent px-2 py-1 text-[12px] text-[var(--term-fg)] outline-none focus:border-[var(--term-brand)]"
              style={{ borderColor: "color-mix(in srgb, var(--term-fg) 20%, transparent)", background: "var(--term-bg)" }}
              aria-label="backdrop scene"
            >
              {BG_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k === "none" ? "bare glass (no scene)" : k}
                </option>
              ))}
            </select>
          </label>
          <Row label="light scheme" hint="ink-on-paper instead of phosphor-on-black">
            <Toggle on={draft.light} onChange={(light) => set({ light })} ariaLabel="light scheme" />
          </Row>
          <Row label="desktop chrome" hint="mac = menubar + dock · windows = taskbar + start">
            <Segmented
              ariaLabel="desktop chrome"
              value={draft.skin === "win" ? "win" : "mac"}
              options={[
                { v: "mac", label: "mac" },
                { v: "win", label: "windows" },
              ]}
              onChange={(v) => set({ skin: v })}
            />
          </Row>
        </div>

        {/* right: live preview + actions + saved list */}
        <div className="flex flex-col">
          <div className="mb-2 text-[11px] text-[var(--term-dim)]">live preview</div>
          <div className="mb-3 overflow-hidden rounded-lg border" style={{ borderColor: `color-mix(in srgb, ${previewDef.fg} 18%, transparent)` }}>
            <div className="p-3" style={{ background: previewDef.bg, color: previewDef.fg }}>
              <div className="font-mono text-[12px]">
                <span style={{ color: previewDef.brand }}>guest@murke</span>
                <span style={{ color: previewDef.dim }}> ~ $</span> echo hi
              </div>
              <div className="mt-1 font-mono text-[12px]">hi</div>
              <div className="mt-1 font-mono text-[11px]" style={{ color: previewDef.dim }}>
                dim output line
              </div>
              <div className="mt-1 font-mono text-[11px]" style={{ color: previewDef.err }}>
                err: something broke
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              className="cursor-pointer rounded-md px-3 py-1.5 text-[11.5px] font-bold transition-transform hover:scale-[1.03]"
              style={{ background: "var(--term-brand)", color: "var(--term-bg)" }}
            >
              {draft.id ? "update + apply" : "save + apply"}
            </button>
            {draft.id && customThemes.some((t) => t.id === draft.id) && (
              <button
                type="button"
                onClick={() => {
                  useOS.getState().deleteCustomTheme(draft.id!);
                  setDraft({ ...DEFAULT_DRAFT, id: null });
                }}
                className="cursor-pointer rounded-md border px-3 py-1.5 text-[11.5px] transition-colors hover:text-[var(--term-err)]"
                style={{ borderColor: "color-mix(in srgb, var(--term-fg) 20%, transparent)" }}
              >
                delete
              </button>
            )}
          </div>

          {customThemes.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[11px] text-[var(--term-dim)]">saved schemes</div>
              <div className="murke-scroll max-h-40 overflow-y-auto pr-1">
                {customThemes.map((t) => {
                  const on = t.id === activeCustomId;
                  return (
                    <div key={t.id} className="mb-1 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => useOS.getState().applyCustomTheme(t.id)}
                        aria-pressed={on}
                        className="min-w-0 flex-1 cursor-pointer truncate rounded-md border px-2 py-1 text-left text-[11.5px] transition-colors hover:text-[var(--term-fg)]"
                        style={{
                          borderColor: on ? "var(--term-brand)" : "color-mix(in srgb, var(--term-fg) 14%, transparent)",
                          background: on ? "color-mix(in srgb, var(--term-brand) 16%, transparent)" : "transparent",
                        }}
                      >
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: t.brand }} />
                        {t.name}
                        {on && <span className="ml-1.5 text-[9px] uppercase tracking-wider text-[var(--term-brand)]">on</span>}
                      </button>
                      <button
                        type="button"
                        onClick={() => editExisting(t)}
                        aria-label={`edit ${t.name}`}
                        className="cursor-pointer text-[10.5px] text-[var(--term-dim)] underline underline-offset-2 hover:text-[var(--term-fg)]"
                      >
                        edit
                      </button>
                      <button
                        type="button"
                        onClick={() => useOS.getState().deleteCustomTheme(t.id)}
                        aria-label={`delete ${t.name}`}
                        className="cursor-pointer text-[var(--term-dim)] transition-colors hover:text-[var(--term-err)]"
                      >
                        <Trash2 size={12} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const sectionTitle = "mb-3 text-[10.5px] font-bold uppercase tracking-[0.18em] text-[var(--term-dim)]";

export default function SettingsApp({ sound, proxy }: { sound: SoundEngine; proxy: ProxyEngine }) {
  const settings = useOS((s) => s.settings);
  const patchCrt = useOS((s) => s.patchCrt);
  const setWallpaper = useOS((s) => s.setWallpaper);
  const section = (useOS((s) => s.windows.find((w) => w.app === "settings")?.arg ?? "") as Section) || "appearance";

  const [soundOn, setSoundOn] = useState(sound.enabled);
  const [uptime, setUptime] = useState("");
  const [proxyLine, setProxyLine] = useState("probing transport…");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /* custom app form */
  const [appName, setAppName] = useState("");
  const [appUrl, setAppUrl] = useState("");
  /** pending uploaded icon (data url) for the app being added */
  const [appIcon, setAppIcon] = useState<string | null>(null);
  const appIconRef = useRef<HTMLInputElement>(null);
  /** which installed app is getting a new icon (null = the add-form) */
  const [iconTarget, setIconTarget] = useState<string | null>(null);
  const [iconErr, setIconErr] = useState<string | null>(null);

  /* live uptime for the about panel */
  useEffect(() => {
    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - bootRef.at) / 1000));
      const m = Math.floor(s / 60);
      setUptime(m > 0 ? `${m}m ${s % 60}s` : `${s}s`);
    };
    tick();
    const iv = window.setInterval(tick, 1000);
    return () => window.clearInterval(iv);
  }, []);

  /* one-shot transport probe for the about panel */
  useEffect(() => {
    let alive = true;
    void proxy.status().then((st) => {
      if (!alive) return;
      setProxyLine(
        st.ok ? `${st.transport ?? "relay"} · ${st.latencyMs ?? "?"}ms` : `offline — ${st.error ?? "no transport"}`,
      );
    });
    return () => {
      alive = false;
    };
  }, [proxy]);

  const onUpload = async (f: File) => {
    setUploading(true);
    try {
      const vfs = getVfs();
      vfs.mkdir("~/Pictures/Wallpapers", undefined, true);
      const name = vfs.uniqueName("~/Pictures/Wallpapers", f.name || "wallpaper");
      const path = "~/Pictures/Wallpapers/" + name;
      const err = await vfs.writeFileBlob(path, f);
      if (!err) setWallpaper({ kind: "custom", path });
    } finally {
      setUploading(false);
    }
  };

  const pickWallpaper = (w: WallpaperChoice) => setWallpaper(w);
  const activePreset = presetFor(settings.crt);
  const activeDef = resolveTheme(settings);

  /* the dark/light toggle: flips the builtin mode, or the active custom's side */
  const flipMode = (mode: "dark" | "light") => {
    if (settings.customThemeId) {
      const t = settings.customThemes.find((c) => c.id === settings.customThemeId);
      if (t && t.light !== (mode === "light")) useOS.getState().saveCustomTheme({ ...t, light: mode === "light" });
      return;
    }
    useOS.getState().setThemeMode(mode);
  };

  const grouped = useMemo(() => {
    const g: Record<Exclude<ThemeCategory, "custom">, ThemeName[]> = {
      originals: [],
      minimal: [],
      apple: [],
      windows: [],
      materialyou: [],
      pastel: [],
      earthy: [],
    };
    for (const t of THEME_ORDER) g[THEMES[t].category as Exclude<ThemeCategory, "custom">].push(t);
    return g;
  }, []);

  const addCustomApp = () => {
    const name = appName.trim();
    let url = appUrl.trim();
    if (!name || !url) return;
    if (!/^https?:\/\//i.test(url) && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
    try {
      new URL(url);
    } catch {
      return;
    }
    useOS.getState().addCustomApp({
      id: Math.random().toString(36).slice(2, 10),
      name: name.slice(0, 20),
      url,
      color: `hsl(${(name.length * 47) % 360} 62% 52%)`,
      ...(appIcon ? { icon: appIcon } : {}),
    });
    setAppName("");
    setAppUrl("");
    setAppIcon(null);
  };

  /** read an image file and shrink it to a 128px square data url — small
   *  enough for localStorage, big enough for every tile it lands in */
  const pickIconFile = (file: File, target: string | null) => {
    setIconErr(null);
    if (!file.type.startsWith("image/")) {
      setIconErr("that file is not an image");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const N = 128;
          const canvas = document.createElement("canvas");
          canvas.width = N;
          canvas.height = N;
          const g = canvas.getContext("2d");
          if (!g) throw new Error("no canvas");
          // cover-crop to a square so wide logos don't squish
          const side = Math.min(img.width, img.height);
          g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, N, N);
          const dataUrl = canvas.toDataURL("image/png");
          if (dataUrl.length > 400_000) throw new Error("icon too large");
          if (target === null) {
            // destined for the add-an-app form
            setAppIcon(dataUrl);
          } else {
            const app = useOS.getState().settings.customApps.find((a) => a.id === target);
            if (app) useOS.getState().addCustomApp({ ...app, icon: dataUrl });
          }
        } catch (e) {
          setIconErr(e instanceof Error ? e.message : "could not read that image");
        }
      };
      img.onerror = () => setIconErr("could not decode that image");
      img.src = String(reader.result);
    };
    reader.onerror = () => setIconErr("could not read that file");
    reader.readAsDataURL(file);
  };

  /* ---------- web app platform: probes + run-on-login ---------- */

  const [probeLine, setProbeLine] = useState("");
  const [runOnLoginLine, setRunOnLoginLine] = useState("off — murke starts when you open it");

  /** hardware probes — each is a real WebAPI request behind a user gesture */
  const probe = async (kind: "usb" | "bt" | "serial") => {
    setProbeLine("asking the browser…");
    try {
      if (kind === "usb") {
        const usb = (navigator as Navigator & { usb?: { requestDevice(o: { filters: unknown[] }): Promise<{ productName?: string }> } }).usb;
        if (!usb) {
          setProbeLine("web usb — not available in this browser");
          return;
        }
        const dev = await usb.requestDevice({ filters: [] });
        setProbeLine(`web usb — paired: ${dev.productName || "device"}`);
      } else if (kind === "bt") {
        const bt = (navigator as Navigator & { bluetooth?: { requestDevice(o: { acceptAllDevices: boolean }): Promise<{ name?: string }> } }).bluetooth;
        if (!bt) {
          setProbeLine("web bluetooth — not available in this browser");
          return;
        }
        const dev = await bt.requestDevice({ acceptAllDevices: true });
        setProbeLine(`web bluetooth — paired: ${dev.name || "device"}`);
      } else {
        const ser = (navigator as Navigator & { serial?: { requestPort(): Promise<unknown> } }).serial;
        if (!ser) {
          setProbeLine("web serial — not available in this browser");
          return;
        }
        await ser.requestPort();
        setProbeLine("web serial — port granted");
      }
    } catch (e) {
      const err = e as Error;
      setProbeLine(err.name === "NotFoundError" ? "cancelled — no device chosen" : `${err.name}: ${err.message.slice(0, 60)}`);
    }
  };

  /* run on login — register a periodic background sync when supported */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const on = useOS.getState().settings.pwa.runOnLogin;
      if (!on) {
        if (alive) setRunOnLoginLine("off — murke starts when you open it");
        return;
      }
      type PeriodicSync = { register(tag: string, o: { minInterval: number }): Promise<void>; getTags(): Promise<string[]> };
      try {
        const reg = await navigator.serviceWorker?.ready;
        const ps = (reg as (ServiceWorkerRegistration & { periodicSync?: PeriodicSync }) | undefined)?.periodicSync;
        if (!ps) {
          if (alive) setRunOnLoginLine("on — launches in the background once murke is installed (this browser has no periodic sync)");
          return;
        }
        await ps.register("murke-run-on-login", { minInterval: 12 * 60 * 60 * 1000 });
        if (alive) setRunOnLoginLine("on — background launch registered");
      } catch {
        if (alive) setRunOnLoginLine("on — will register once murke is installed to your device");
      }
    })();
    return () => {
      alive = false;
    };
  }, [settings.pwa.runOnLogin]);

  const inputCls =
    "w-full rounded-md border bg-transparent px-2 py-1.5 text-[12px] text-[var(--term-fg)] outline-none focus:border-[var(--term-brand)]";

  return (
    <div className="flex h-full w-full bg-transparent text-[var(--term-fg)]">
      {/* ---------- section rail ---------- */}
      <nav
        aria-label="settings sections"
        className="murke-scroll flex w-[148px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2"
        style={{ borderColor: "color-mix(in srgb, var(--term-fg) 10%, transparent)" }}
      >
        {SECTIONS.map((s) => {
          const on = section === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => useOS.getState().openApp("settings", s.id)}
              aria-current={on ? "page" : undefined}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-[12px] lowercase tracking-wide transition-colors ${
                on ? "text-[var(--term-fg)]" : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"
              }`}
              style={on ? { background: "color-mix(in srgb, var(--term-brand) 24%, transparent)" } : undefined}
            >
              <s.icon size={13} aria-hidden="true" style={{ color: on ? "var(--term-brand)" : undefined }} />
              {s.label}
            </button>
          );
        })}
      </nav>

      {/* ---------- content ---------- */}
      <div className="murke-scroll min-w-0 flex-1 overflow-y-auto p-4">
        {section === "appearance" && (
          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className={sectionTitle + " mb-0"}>theme — {activeDef.label}</div>
              {/* the dark / light toggle */}
              <Segmented
                ariaLabel="dark or light"
                value={settings.customThemeId ? (activeDef.light ? "light" : "dark") : settings.themeMode}
                options={[
                  { v: "dark", label: "dark" },
                  { v: "light", label: "light" },
                ]}
                onChange={flipMode}
              />
            </div>
            <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--term-dim)]">
              a theme restyles EVERYTHING — colors, wallpaper scene, and the desktop chrome itself. apple + originals ship the
              mac shell (menu bar, dock, traffic lights); windows swaps in the fluent shell (taskbar, start menu, square
              controls).
            </p>

            {(["originals", "minimal", "apple", "windows", "materialyou", "pastel", "earthy"] as const).map((cat) => (
              <div key={cat} className="mb-4">
                <div className="mb-1.5 flex items-baseline gap-2">
                  <span className="text-[11px] font-bold lowercase tracking-[0.14em] text-[var(--term-fg)]">{CATEGORY_META[cat].label}</span>
                  <span className="text-[10.5px] text-[var(--term-dim)]">{CATEGORY_META[cat].desc}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {grouped[cat].map((t) => (
                    <ThemeCard
                      key={t}
                      defKey={resolveThemeKey({ theme: t, themeMode: settings.themeMode, customThemeId: null })}
                      on={!settings.customThemeId && settings.theme === t}
                      badge={THEMES[t].skin === "win" ? "windows shell" : undefined}
                      onClick={() => {
                        useOS.getState().setTheme(t);
                        if (THEMES[t].light) useOS.getState().setThemeMode("light");
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* yours */}
            <div className="mb-2 flex items-baseline gap-2">
              <span className="flex items-center gap-1 text-[11px] font-bold lowercase tracking-[0.14em] text-[var(--term-fg)]">
                <LayoutGrid size={11} aria-hidden="true" /> {CATEGORY_META.custom.label}
              </span>
              <span className="text-[10.5px] text-[var(--term-dim)]">{CATEGORY_META.custom.desc}</span>
            </div>
            {settings.customThemes.length > 0 && (
              <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {settings.customThemes.map((t) => (
                  <ThemeCard
                    key={t.id}
                    defKey={"custom:" + t.id}
                    on={settings.customThemeId === t.id}
                    badge={t.skin === "win" ? "windows shell" : t.light ? "light" : undefined}
                    onClick={() => useOS.getState().applyCustomTheme(t.id)}
                  />
                ))}
              </div>
            )}
            <SchemeMixer />
          </div>
        )}

        {section === "wallpaper" && (
          <div>
            <div className={sectionTitle}>desktop wallpaper</div>
            <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--term-dim)]">
              the living scene follows your theme. pick a still, or drop your own image — uploads land in
              ~/Pictures/Wallpapers. the terminal keeps its theme either way.
            </p>

            <button
              type="button"
              onClick={() => pickWallpaper({ kind: "scene" })}
              className={`mb-3 w-full cursor-pointer rounded-lg border p-3 text-left transition-all ${
                settings.wallpaper.kind === "scene" ? "ring-1" : ""
              }`}
              style={{
                borderColor: settings.wallpaper.kind === "scene" ? "var(--term-brand)" : "color-mix(in srgb, var(--term-fg) 14%, transparent)",
                boxShadow: settings.wallpaper.kind === "scene" ? "0 0 0 1px var(--term-brand)" : undefined,
              }}
            >
              <div className="text-[12.5px]">theme scene — {activeDef.label}</div>
              <div className="text-[11px] text-[var(--term-dim)]">the animated backdrop that belongs to your theme</div>
            </button>

            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {WALLPAPER_PRESETS.map((p) => {
                const on = settings.wallpaper.kind === "preset" && settings.wallpaper.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => pickWallpaper({ kind: "preset", id: p.id })}
                    aria-pressed={on}
                    className={`cursor-pointer overflow-hidden rounded-lg border text-left transition-all hover:scale-[1.02] ${
                      on ? "ring-1" : ""
                    }`}
                    style={{
                      borderColor: on ? "var(--term-brand)" : "color-mix(in srgb, var(--term-fg) 14%, transparent)",
                      boxShadow: on ? "0 0 0 1px var(--term-brand)" : undefined,
                    }}
                  >
                    <span className="block h-16 w-full bg-cover bg-center" style={{ backgroundImage: `url(${p.url})` }} role="img" aria-label={p.label || "wallpaper"} />
                    {p.label ? <span className="block truncate px-1.5 py-1 text-[10.5px] lowercase">{p.label}</span> : null}
                  </button>
                );
              })}
            </div>

            <Row
              label="custom image"
              hint={uploading ? "saving to ~/Pictures/Wallpapers…" : "stored in your file system, survives reloads"}
            >
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="cursor-pointer rounded-md border px-3 py-1.5 text-[11.5px] transition-colors"
                style={{
                  borderColor: settings.wallpaper.kind === "custom" ? "var(--term-brand)" : "color-mix(in srgb, var(--term-fg) 20%, transparent)",
                  color: settings.wallpaper.kind === "custom" ? "var(--term-brand)" : "var(--term-fg)",
                }}
              >
                {settings.wallpaper.kind === "custom" ? "choose another…" : "upload…"}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onUpload(f);
                  e.target.value = "";
                }}
              />
            </Row>
            {settings.wallpaper.kind === "custom" && (
              <button
                type="button"
                onClick={() => pickWallpaper({ kind: "scene" })}
                className="mt-1 cursor-pointer text-[11px] text-[var(--term-dim)] underline underline-offset-2 hover:text-[var(--term-fg)]"
              >
                remove custom wallpaper — back to the theme scene
              </button>
            )}
          </div>
        )}

        {section === "glass" && (
          <div>
            <div className={sectionTitle}>liquid glass</div>
            <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--term-dim)]">
              the whole desktop refracts its backdrop through real glass — windows, bars, docks, panels. the browser keeps
              its glass to the top bar and buttons (pages need every pixel of fidelity), and anything that lives on text
              keeps the contrast it needs. flip it off and every surface goes solid.
            </p>

            <Row label="liquid glass" hint="the master switch — off means solid panels everywhere">
              <Toggle on={settings.glass.enabled} onChange={(v) => useOS.getState().patchGlass({ enabled: v })} ariaLabel="liquid glass" />
            </Row>
            <Row label="blur" hint="0 = crystal · 24 = stock · 44 = deep frost">
              <div className="w-40">
                <Slider
                  label="blur"
                  value={settings.glass.blur}
                  min={0}
                  max={44}
                  step={1}
                  format={(v) => `${Math.round(v)}px`}
                  onChange={(v) => useOS.getState().patchGlass({ blur: Math.round(v) })}
                />
              </div>
            </Row>
            <Row label="tint" hint="how much wallpaper bleeds through the panels">
              <div className="w-40">
                <Slider
                  label="tint"
                  value={settings.glass.tint}
                  min={0}
                  max={60}
                  step={1}
                  format={(v) => `${Math.round(v)}%`}
                  onChange={(v) => useOS.getState().patchGlass({ tint: Math.round(v) })}
                />
              </div>
            </Row>
            <Row label="saturation" hint="color punch of the refracted backdrop">
              <div className="w-40">
                <Slider
                  label="saturation"
                  value={settings.glass.saturate}
                  min={100}
                  max={220}
                  step={5}
                  format={(v) => `${Math.round(v)}%`}
                  onChange={(v) => useOS.getState().patchGlass({ saturate: Math.round(v) })}
                />
              </div>
            </Row>
            <Row label="glassy icons" hint="real see-through frost on dock + taskbar icon tiles">
              <Toggle on={settings.glass.iconGlass} onChange={(v) => useOS.getState().patchGlass({ iconGlass: v })} ariaLabel="glassy icons" />
            </Row>
            <Row label="presets" hint="one tap, four vibes">
              <Segmented
                ariaLabel="glass presets"
                value={
                  !settings.glass.enabled
                    ? "off"
                    : settings.glass.blur >= 36 && settings.glass.tint >= 42
                      ? "max"
                      : settings.glass.blur <= 14 && settings.glass.tint <= 22
                        ? "subtle"
                        : "balanced"
                }
                options={[
                  { v: "off", label: "off" },
                  { v: "subtle", label: "subtle" },
                  { v: "balanced", label: "balanced" },
                  { v: "max", label: "max" },
                ]}
                onChange={(v) => {
                  if (v === "off") useOS.getState().patchGlass({ enabled: false });
                  else if (v === "subtle") useOS.getState().patchGlass({ enabled: true, blur: 12, tint: 18, saturate: 140 });
                  else if (v === "max") useOS.getState().patchGlass({ enabled: true, blur: 40, tint: 46, saturate: 190 });
                  else useOS.getState().patchGlass({ enabled: true, blur: 24, tint: 30, saturate: 165 });
                }}
              />
            </Row>
          </div>
        )}

        {section === "lockscreen" && (
          <div>
            <div className={sectionTitle}>lock screen</div>
            <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--term-dim)]">
              the mac-style veil that drops over the desktop when the tab hides or loses focus — or when you hit the lock
              button in the menu bar. unlocking always takes the gate password.
            </p>

            <Row label="auto lock" hint="lock when the tab hides or the window loses focus — off means only the menu-bar lock button locks">
              <Toggle on={settings.lockscreen.autoLock} onChange={(v) => useOS.getState().patchLockscreen({ autoLock: v })} ariaLabel="auto lock" />
            </Row>
            <Row label="face" hint="material you (roboto flex) or the terminal mono">
              <Segmented
                ariaLabel="lock screen font"
                value={settings.lockscreen.font}
                options={[
                  { v: "material", label: "material you" },
                  { v: "mono", label: "mono" },
                ]}
                onChange={(v) => useOS.getState().patchLockscreen({ font: v })}
              />
            </Row>
            <Row label="veil blur" hint="0 = clear glass · 38 = stock frost · 44 = deep">
              <div className="w-40">
                <Slider
                  label="veil blur"
                  value={settings.lockscreen.blur}
                  min={0}
                  max={44}
                  step={1}
                  format={(v) => `${Math.round(v)}px`}
                  onChange={(v) => useOS.getState().patchLockscreen({ blur: Math.round(v) })}
                />
              </div>
            </Row>
            <Row label="veil dim" hint="how dark the veil sits over the wallpaper">
              <div className="w-40">
                <Slider
                  label="veil dim"
                  value={settings.lockscreen.dim}
                  min={0}
                  max={80}
                  step={2}
                  format={(v) => `${Math.round(v)}%`}
                  onChange={(v) => useOS.getState().patchLockscreen({ dim: Math.round(v) })}
                />
              </div>
            </Row>
            <Row label="clock" hint="the big ticking clock, upper third">
              <Toggle on={settings.lockscreen.showClock} onChange={(v) => useOS.getState().patchLockscreen({ showClock: v })} ariaLabel="show clock" />
            </Row>
            <Row label="date under clock" hint="lowercase weekday, month, day">
              <Toggle on={settings.lockscreen.showDate} onChange={(v) => useOS.getState().patchLockscreen({ showDate: v })} ariaLabel="show date on lock screen" />
            </Row>
            <Row label="unlock hint" hint="the pulsing “click or type to unlock” line">
              <Toggle on={settings.lockscreen.showHint} onChange={(v) => useOS.getState().patchLockscreen({ showHint: v })} ariaLabel="show unlock hint" />
            </Row>
            <div className="mt-3 flex items-center gap-2 border-t pt-3" style={{ borderColor: "color-mix(in srgb, var(--term-fg) 10%, transparent)" }}>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent("murke-lock"))}
                className="cursor-pointer rounded-md border px-3 py-1.5 text-[11.5px] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]"
                style={{ borderColor: "color-mix(in srgb, var(--term-fg) 25%, transparent)" }}
              >
                lock now — try it
              </button>
              <span className="text-[10.5px] text-[var(--term-dim)]">the veil previews every change live</span>
            </div>
          </div>
        )}

        {section === "dock" && (
          <div>
            <div className={sectionTitle}>{activeDef.skin === "win" ? "taskbar" : "dock"}</div>
            {activeDef.skin === "win" ? (
              <>
                <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--term-dim)]">
                  the windows shell pins a fluent taskbar to the bottom edge — these knobs shape it. the mac dock has its own
                  section once you switch to a mac-side theme.
                </p>
                <Row label="alignment" hint="centered cluster (win11) or classic left edge">
                  <Segmented
                    ariaLabel="taskbar alignment"
                    value={settings.taskbar.alignment}
                    options={[
                      { v: "center", label: "center" },
                      { v: "left", label: "left" },
                    ]}
                    onChange={(v) => useOS.getState().patchTaskbar({ alignment: v })}
                  />
                </Row>
                <Row label="icon size" hint="16 = refined · 20 = balanced · 24 = chunky">
                  <div className="w-40">
                    <Slider
                      label="size"
                      value={settings.taskbar.iconSize}
                      min={16}
                      max={24}
                      step={1}
                      format={(v) => `${Math.round(v)}px`}
                      onChange={(v) => useOS.getState().patchTaskbar({ iconSize: Math.round(v) })}
                    />
                  </div>
                </Row>
                <Row label="automatically hide" hint="slides away — poke the bottom edge to summon it">
                  <Toggle on={settings.taskbar.autohide} onChange={(v) => useOS.getState().patchTaskbar({ autohide: v })} ariaLabel="autohide taskbar" />
                </Row>
                <Row label="date under clock" hint="the stacked tray clock shows today too">
                  <Toggle on={settings.taskbar.showDate} onChange={(v) => useOS.getState().patchTaskbar({ showDate: v })} ariaLabel="show date" />
                </Row>
                <Row label="bar height" hint="44 = slim · 52 = stock · 64 = tall">
                  <div className="w-40">
                    <Slider
                      label="height"
                      value={settings.taskbar.height}
                      min={44}
                      max={64}
                      step={2}
                      format={(v) => `${Math.round(v)}px`}
                      onChange={(v) => useOS.getState().patchTaskbar({ height: Math.round(v) })}
                    />
                  </div>
                </Row>
                <Row label="acrylic opacity" hint="how much the desktop bleeds through the bar">
                  <div className="w-40">
                    <Slider
                      label="opacity"
                      value={settings.taskbar.opacity}
                      min={20}
                      max={100}
                      step={1}
                      format={(v) => `${Math.round(v)}%`}
                      onChange={(v) => useOS.getState().patchTaskbar({ opacity: Math.round(v) })}
                    />
                  </div>
                </Row>
                <Row label="acrylic blur" hint="0 = flat plate · 40 = frosted glass">
                  <div className="w-40">
                    <Slider
                      label="blur"
                      value={settings.taskbar.blur}
                      min={0}
                      max={40}
                      step={1}
                      format={(v) => `${Math.round(v)}px`}
                      onChange={(v) => useOS.getState().patchTaskbar({ blur: Math.round(v) })}
                    />
                  </div>
                </Row>
                <Row label="system tray" hint="the key-sounds + crt toggles on the right">
                  <Toggle on={settings.taskbar.showTray} onChange={(v) => useOS.getState().patchTaskbar({ showTray: v })} ariaLabel="show system tray" />
                </Row>
              </>
            ) : (
              <>
                <Row label="icon size" hint="24 = tiny · 32 = balanced · 56 = chunky">
                  <div className="w-40">
                    <Slider
                      label="size"
                      value={settings.dock.iconSize}
                      min={24}
                      max={56}
                      step={1}
                      format={(v) => `${Math.round(v)}px`}
                      onChange={(v) => useOS.getState().patchDock({ iconSize: Math.round(v) })}
                    />
                  </div>
                </Row>
                <Row label="position" hint="bottom is the classic; sides free up vertical space">
                  <Segmented
                    ariaLabel="dock position"
                    value={settings.dock.position}
                    options={[
                      { v: "bottom", label: "bottom" },
                      { v: "left", label: "left" },
                      { v: "right", label: "right" },
                    ]}
                    onChange={(v) => useOS.getState().patchDock({ position: v })}
                  />
                </Row>
                <Row label="magnification" hint="genie growth under the pointer">
                  <Toggle on={settings.dock.magnify} onChange={(v) => useOS.getState().patchDock({ magnify: v })} ariaLabel="dock magnification" />
                </Row>
                {settings.dock.magnify && (
                  <Row label="magnify amount" hint="how far the hovered icon pops (0.1 = subtle · 0.7 = wild)">
                    <div className="w-40">
                      <Slider
                        label="grow"
                        value={settings.dock.magnifyAmount}
                        min={0.08}
                        max={0.7}
                        step={0.02}
                        format={(v) => `+${Math.round(v * 100)}%`}
                        onChange={(v) => useOS.getState().patchDock({ magnifyAmount: v })}
                      />
                    </div>
                  </Row>
                )}
                <Row label="automatically hide" hint="slides away — poke the screen edge to summon it">
                  <Toggle on={settings.dock.autohide} onChange={(v) => useOS.getState().patchDock({ autohide: v })} ariaLabel="autohide dock" />
                </Row>
                <Row label="theme icons" hint="tiles recolor to your scheme (off = classic app colors)">
                  <Toggle on={settings.dock.themeIcons} onChange={(v) => useOS.getState().patchDock({ themeIcons: v })} ariaLabel="theme-matching dock icons" />
                </Row>
                <Row label="hover labels" hint="app names float up as you sweep the strip">
                  <Toggle on={settings.dock.labels} onChange={(v) => useOS.getState().patchDock({ labels: v })} ariaLabel="dock hover labels" />
                </Row>
                <Row label="running indicator" hint="how a running app marks itself">
                  <Segmented
                    ariaLabel="dock indicator style"
                    value={settings.dock.indicator}
                    options={[
                      { v: "dot", label: "dot" },
                      { v: "line", label: "line" },
                      { v: "none", label: "none" },
                    ]}
                    onChange={(v) => useOS.getState().patchDock({ indicator: v })}
                  />
                </Row>
                <Row label="glass opacity" hint="how much desktop shows through the panel">
                  <div className="w-40">
                    <Slider
                      label="opacity"
                      value={settings.dock.opacity}
                      min={20}
                      max={95}
                      step={1}
                      format={(v) => `${Math.round(v)}%`}
                      onChange={(v) => useOS.getState().patchDock({ opacity: Math.round(v) })}
                    />
                  </div>
                </Row>
                <Row label="glass blur" hint="0 = clear plate · 40 = deep frost">
                  <div className="w-40">
                    <Slider
                      label="blur"
                      value={settings.dock.blur}
                      min={0}
                      max={40}
                      step={1}
                      format={(v) => `${Math.round(v)}px`}
                      onChange={(v) => useOS.getState().patchDock({ blur: Math.round(v) })}
                    />
                  </div>
                </Row>
                <Row label="corner radius" hint="6 = squared · 32 = pill-adjacent">
                  <div className="w-40">
                    <Slider
                      label="radius"
                      value={settings.dock.radius}
                      min={6}
                      max={32}
                      step={1}
                      format={(v) => `${Math.round(v)}px`}
                      onChange={(v) => useOS.getState().patchDock({ radius: Math.round(v) })}
                    />
                  </div>
                </Row>
              </>
            )}
          </div>
        )}

        {section === "windows" && (
          <div>
            <div className={sectionTitle}>window management</div>
            <Row label="edge snapping" hint="drag a window to an edge or corner — halves, quarters, max">
              <Toggle on={settings.wm.snap} onChange={(v) => useOS.getState().patchWm({ snap: v })} ariaLabel="edge snapping" />
            </Row>
            <Row label="snap preview" hint="translucent ghost shows where the window will land">
              <Toggle on={settings.wm.snapPreview} onChange={(v) => useOS.getState().patchWm({ snapPreview: v })} ariaLabel="snap preview" />
            </Row>
            <Row label="hotkeys" hint="hyprland-style keys — the cheat sheet is below">
              <Toggle on={settings.wm.hotkeys} onChange={(v) => useOS.getState().patchWm({ hotkeys: v })} ariaLabel="window hotkeys" />
            </Row>

            <div className={sectionTitle + " mt-4"}>keybindings</div>
            <div className="rounded-lg border p-3 text-[12px]" style={{ borderColor: "color-mix(in srgb, var(--term-fg) 12%, transparent)" }}>
              {[
                ["super + ←/→", "snap window to left / right half"],
                ["super + ↑", "maximize (top edge)"],
                ["super + ↓", "minimize"],
                ["super + q", "close window"],
                ["super + f", "zoom / restore window"],
                ["super + t · b · e", "terminal · browser · files"],
                ["super + 1…7", "launch app by dock order"],
                ["alt + tab", "cycle windows (shift = backwards)"],
                ["esc", "close the focused window"],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3 py-1">
                  <span className="w-36 shrink-0 text-[var(--term-brand)]">{k}</span>
                  <span className="min-w-0 text-[var(--term-dim)]">{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {section === "apps" && (
          <div>
            <div className={sectionTitle}>installed web apps</div>
            <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--term-dim)]">
              pin any site as an app — it gets a dock tile and opens in its own standalone window, edge to edge, with no
              browser chrome at all. you can also install from the browser itself: ⋮ menu → “install page as app”.
            </p>

            {settings.customApps.length === 0 ? (
              <div className="mb-3 rounded-lg border border-dashed p-4 text-center text-[11.5px] text-[var(--term-dim)]" style={{ borderColor: "color-mix(in srgb, var(--term-fg) 18%, transparent)" }}>
                nothing installed yet — add your first app below
              </div>
            ) : (
              <div className="mb-3 space-y-1.5">
                {settings.customApps.map((app) => (
                  <div
                    key={app.id}
                    className="flex items-center gap-2.5 rounded-lg border p-2"
                    style={{ borderColor: "color-mix(in srgb, var(--term-fg) 12%, transparent)" }}
                  >
                    {/* the icon — click to upload your own */}
                    <button
                      type="button"
                      onClick={() => {
                        setIconTarget(app.id);
                        appIconRef.current?.click();
                      }}
                      title="upload your own icon"
                      aria-label={`upload an icon for ${app.name}`}
                      className="group relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-dashed transition-transform hover:scale-105"
                      style={{
                        borderColor: "color-mix(in srgb, var(--term-fg) 30%, transparent)",
                        background: app.icon ? "transparent" : app.color,
                      }}
                    >
                      {app.icon ? (
                        <img src={app.icon} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="font-bold text-white">{app.name.charAt(0).toUpperCase()}</span>
                      )}
                      <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55 text-[8.5px] font-bold lowercase tracking-wider text-white opacity-0 transition-opacity group-hover:opacity-100">
                        upload
                      </span>
                    </button>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px]">{app.name}</span>
                      <span className="block truncate text-[10.5px] text-[var(--term-dim)]">{app.url}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => useOS.getState().openApp("pwa", app.id)}
                      className="cursor-pointer rounded-md border px-2.5 py-1 text-[11px] transition-colors hover:text-[var(--term-brand)]"
                      style={{ borderColor: "color-mix(in srgb, var(--term-fg) 20%, transparent)" }}
                    >
                      open
                    </button>
                    <button
                      type="button"
                      onClick={() => useOS.getState().removeCustomApp(app.id)}
                      aria-label={`remove ${app.name}`}
                      className="cursor-pointer p-1 text-[var(--term-dim)] transition-colors hover:text-[var(--term-err)]"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-lg border p-3" style={{ borderColor: "color-mix(in srgb, var(--term-fg) 14%, transparent)" }}>
              <div className="mb-2 flex items-center gap-3">
                <div className="text-[11px] text-[var(--term-dim)]">add an app</div>
                <span className="min-w-0 flex-1" />
                {/* icon picker for the app being added */}
                <button
                  type="button"
                  onClick={() => {
                    setIconTarget(null);
                    appIconRef.current?.click();
                  }}
                  title="upload your own icon (png / jpg / svg — any square image)"
                  aria-label="upload an icon for the new app"
                  className="group relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-dashed transition-transform hover:scale-105"
                  style={{ borderColor: "color-mix(in srgb, var(--term-fg) 35%, transparent)" }}
                >
                  {appIcon ? <img src={appIcon} alt="" className="h-full w-full object-cover" /> : <Plus size={14} className="text-[var(--term-dim)]" aria-hidden="true" />}
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55 text-[8.5px] font-bold lowercase tracking-wider text-white opacity-0 transition-opacity group-hover:opacity-100">
                    icon
                  </span>
                </button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  placeholder="name — e.g. spotify"
                  maxLength={20}
                  aria-label="app name"
                  className={inputCls}
                  style={{ borderColor: "color-mix(in srgb, var(--term-fg) 20%, transparent)" }}
                />
                <input
                  type="text"
                  value={appUrl}
                  onChange={(e) => setAppUrl(e.target.value)}
                  placeholder="url — e.g. open.spotify.com"
                  aria-label="app url"
                  className={inputCls}
                  style={{ borderColor: "color-mix(in srgb, var(--term-fg) 20%, transparent)" }}
                />
              </div>
              {iconErr && <p className="mt-1.5 text-[10.5px] text-[var(--term-err)]">{iconErr}</p>}
              <button
                type="button"
                onClick={addCustomApp}
                disabled={!appName.trim() || !appUrl.trim()}
                className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[11.5px] font-bold transition-transform hover:scale-[1.03] disabled:cursor-default disabled:opacity-40 disabled:hover:scale-100"
                style={{ background: "var(--term-brand)", color: "var(--term-bg)" }}
              >
                <Plus size={13} aria-hidden="true" /> install to dock
              </button>
              {/* one hidden picker serves both the form and installed rows */}
              <input
                ref={appIconRef}
                type="file"
                accept="image/*"
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) pickIconFile(f, iconTarget);
                  e.target.value = "";
                }}
              />
            </div>

            <div className={sectionTitle + " mt-5"}>web app platform</div>
            <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--term-dim)]">
              pwa capabilities for murke itself and the apps you install. hardware probes need a chromium browser — and
              most only fully apply once murke is installed to your device from the browser menu.
            </p>
            <div className="rounded-lg border p-3" style={{ borderColor: "color-mix(in srgb, var(--term-fg) 14%, transparent)" }}>
              <Row label="run on login" hint="register a periodic background launch (installed app)">
                <Toggle on={settings.pwa.runOnLogin} onChange={(v) => useOS.getState().patchPwa({ runOnLogin: v })} ariaLabel="run on login" />
              </Row>
              <p className="mb-2 text-[10.5px] text-[var(--term-dim)]">{runOnLoginLine}</p>
              <Row label="window controls overlay" hint="adapt to the native title bar when installed">
                <Toggle on={settings.pwa.wco} onChange={(v) => useOS.getState().patchPwa({ wco: v })} ariaLabel="window controls overlay" />
              </Row>
              <Row label="web usb" hint="let apps talk to usb devices">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!settings.pwa.usb}
                    onClick={() => void probe("usb")}
                    className={`cursor-pointer border px-2 py-0.5 text-[10.5px] disabled:pointer-events-none disabled:opacity-40 ${"border-[color-mix(in_srgb,var(--term-fg)_22%,transparent)]"} hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)]`}
                  >
                    test
                  </button>
                  <Toggle on={settings.pwa.usb} onChange={(v) => useOS.getState().patchPwa({ usb: v })} ariaLabel="web usb" />
                </div>
              </Row>
              <Row label="web bluetooth" hint="pair low-energy bluetooth devices">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!settings.pwa.bt}
                    onClick={() => void probe("bt")}
                    className="cursor-pointer border border-[color-mix(in_srgb,var(--term-fg)_22%,transparent)] px-2 py-0.5 text-[10.5px] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] disabled:pointer-events-none disabled:opacity-40"
                  >
                    test
                  </button>
                  <Toggle on={settings.pwa.bt} onChange={(v) => useOS.getState().patchPwa({ bt: v })} ariaLabel="web bluetooth" />
                </div>
              </Row>
              <Row label="web serial" hint="open ports on serial devices">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!settings.pwa.serial}
                    onClick={() => void probe("serial")}
                    className="cursor-pointer border border-[color-mix(in_srgb,var(--term-fg)_22%,transparent)] px-2 py-0.5 text-[10.5px] hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] disabled:pointer-events-none disabled:opacity-40"
                  >
                    test
                  </button>
                  <Toggle on={settings.pwa.serial} onChange={(v) => useOS.getState().patchPwa({ serial: v })} ariaLabel="web serial" />
                </div>
              </Row>
              {probeLine && <p className="mt-2 text-[10.5px] text-[var(--term-dim)]">{probeLine}</p>}
            </div>
          </div>
        )}

        {section === "crt" && (
          <div>
            <div className={sectionTitle}>crt display</div>
            <Row label="crt effects" hint="scanlines, glow and the whole tube — applied over the entire desktop">
              <Toggle on={settings.crt.enabled} onChange={(v) => patchCrt({ enabled: v })} ariaLabel="toggle crt effects" />
            </Row>

            <div className={sectionTitle + " mt-4"}>presets</div>
            <div className="mb-2 grid grid-cols-3 gap-2">
              {CRT_PRESETS.map((p) => {
                const on = activePreset === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => patchCrt({ enabled: true, ...p.values })}
                    aria-pressed={on}
                    title={p.desc}
                    className={`cursor-pointer rounded-lg border px-2 py-2 text-left text-[11.5px] transition-all ${
                      on ? "text-[var(--term-fg)]" : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"
                    }`}
                    style={{
                      borderColor: on ? "var(--term-brand)" : "color-mix(in srgb, var(--term-fg) 14%, transparent)",
                      background: on ? "color-mix(in srgb, var(--term-brand) 18%, transparent)" : "transparent",
                    }}
                  >
                    {p.label}
                    <span className="mt-0.5 block text-[10px] leading-snug text-[var(--term-dim)]">{p.desc}</span>
                  </button>
                );
              })}
            </div>
            {activePreset === "custom" && (
              <div className="mb-2 text-[10.5px] text-[var(--term-dim)]">custom mix — adjust the channels below</div>
            )}

            <div className="mt-3 columns-1 sm:columns-2 sm:gap-6">
              <Slider label="scanlines" value={settings.crt.scanlines} onChange={(v) => patchCrt({ scanlines: v })} />
              <Slider label="glow" value={settings.crt.glow} onChange={(v) => patchCrt({ glow: v })} />
              <Slider label="curvature" value={settings.crt.curvature} onChange={(v) => patchCrt({ curvature: v })} />
              <Slider label="flicker" value={settings.crt.flicker} onChange={(v) => patchCrt({ flicker: v })} />
              <Slider label="noise" value={settings.crt.noise} onChange={(v) => patchCrt({ noise: v })} />
              <Slider label="aberration" value={settings.crt.aberration} onChange={(v) => patchCrt({ aberration: v })} />
            </div>
          </div>
        )}

        {section === "sound" && (
          <div>
            <div className={sectionTitle}>sound</div>
            <Row label="mechanical key sounds" hint="synthesized thock per keypress — off until you switch it on">
              <Toggle
                on={soundOn}
                ariaLabel="toggle key sounds"
                onChange={(v) => {
                  sound.setEnabled(v);
                  setSoundOn(v);
                }}
              />
            </Row>
            <p className="mt-2 text-[11px] leading-relaxed text-[var(--term-dim)]">
              volume follows your system output. the synth (play command) and the relay chat pings are separate and
              always respect this toggle for key feedback only.
            </p>
          </div>
        )}

        {section === "about" && (
          <div>
            <div className={sectionTitle}>about this machine</div>
            <div className="flex flex-col items-center gap-3 py-4">
              <MurkeMark theme={resolveThemeKey(settings)} height={72} />
              <div className="text-center">
                <div className="text-[15px] font-bold tracking-[0.2em]">MURKE OS</div>
                <div className="text-[11px] text-[var(--term-dim)]">version 3.1 — desktop</div>
              </div>
            </div>
            <div
              className="rounded-lg border p-3 text-[12px]"
              style={{ borderColor: "color-mix(in srgb, var(--term-fg) 12%, transparent)" }}
            >
              {[
                ["shell", "dsh — the murke terminal"],
                ["window server", "mac-style + hyprland snapping"],
                ["proxy", "scramjet over relay/wisp"],
                ["transport", proxyLine],
                ["build", `${process.env.NEXT_PUBLIC_BUILD_SHA || "dev"} · ${process.env.NEXT_PUBLIC_BUILD_TIME || ""}`],
                ["uptime", uptime || "just booted"],
                ["theme", activeDef.label],
                ["installed apps", `${settings.customApps.length} web app${settings.customApps.length === 1 ? "" : "s"}`],
                ["storage", "everything lives on this device"],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3 py-1">
                  <span className="w-28 shrink-0 text-[var(--term-dim)]">{k}</span>
                  <span className="min-w-0 break-words">{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
