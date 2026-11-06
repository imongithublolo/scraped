"use client";

/**
 * simple — the collapsed murke. `simple` in the terminal folds the whole
 * desktop away and leaves exactly one thing on screen: a borderless glass
 * search bar over the blurred wallpaper, the proxy underneath. Nothing else.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ (engine)  search the web …              (go) │   ← glass, no border
 *   └──────────────────────────────────────────────┘
 *        engine click → picker: anywhere · duckduckgo ·
 *        google · wikipedia · youtube · translate
 *
 *   enter  → the proxied site, FULLSCREEN — no chips, no chrome, no
 *            interruptions. esc returns to the bar.
 *   ⌖      → back to the full os (windows, dock, terminal) — bar state only
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bird,
  BookOpen,
  Check,
  Chrome,
  Globe,
  Home,
  Languages,
  LayoutGrid,
  Search,
  Youtube,
  type LucideIcon,
} from "lucide-react";
import type { ProxyEngine, ProxyFrameHandle, SoundEngine, SynthEngine } from "@/lib/murke/contracts";
import { useOS } from "@/lib/murke/os-store";
import { resolveTheme, resolveThemeKey, themeVars } from "@/lib/murke/themes";
import { crtVars } from "@/lib/murke/crtfx";
import Wallpaper from "./Wallpaper";
import CrtFx from "./CrtFx";
import { normalizeTarget } from "@/lib/murke/commands";

export interface SimpleProxyProps {
  sound: SoundEngine;
  synth: SynthEngine;
  proxy: ProxyEngine;
  onLogout: () => void;
  /** the ..0 door: proxy ONLY — no way back to the full os from here */
  lite?: boolean;
}

/* ---------- search engines (the globe opens this list) ---------- */

interface Engine {
  id: string;
  label: string;
  icon: LucideIcon;
  /** query url template; null = the smart default (urls direct, queries → ddg lite) */
  q: string | null;
}

const ENGINES: Engine[] = [
  { id: "anywhere", label: "anywhere", icon: Globe, q: null },
  { id: "duckduckgo", label: "duckduckgo", icon: Bird, q: "https://lite.duckduckgo.com/lite/?q=" },
  { id: "google", label: "google", icon: Chrome, q: "https://www.google.com/search?q=" },
  { id: "wikipedia", label: "wikipedia", icon: BookOpen, q: "https://en.wikipedia.org/w/index.php?search=" },
  { id: "youtube", label: "youtube", icon: Youtube, q: "https://www.youtube.com/results?search_query=" },
  { id: "translate", label: "translate", icon: Languages, q: "https://translate.google.com/?sl=auto&tl=en&op=translate&text=" },
];

const ENGINE_KEY = "daemon.simple.engine";

function loadEngine(): Engine {
  try {
    const id = localStorage.getItem(ENGINE_KEY);
    return ENGINES.find((e) => e.id === id) ?? ENGINES[0];
  } catch {
    return ENGINES[0];
  }
}

/** urls browse direct no matter the engine; plain words use the engine */
function engineTarget(engine: Engine, raw: string): string {
  const s = raw.trim();
  const looksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(s);
  if (looksUrl || !engine.q) return normalizeTarget(s);
  return engine.q + encodeURIComponent(s);
}

/**
 * BareFrame — one raw proxied frame, edge to edge. No tabs, no omnibox,
 * no murke chrome: the site IS the screen. The engine is pre-warmed by
 * the bar; init() is idempotent so it is simply awaited again here.
 * A 2px theme strip at the very top is the only hint that anything is
 * happening — it dissolves the moment the frame answers.
 */
function BareFrame({ url, proxy }: { url: string; proxy: ProxyEngine }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let dead = false;
    let handle: ProxyFrameHandle | null = null;
    // loading starts true (fresh mount per url — key={url} in the parent)
    void (async () => {
      try {
        const ok = await proxy.init();
        if (dead) return;
        if (!ok.ok) {
          setLoading(false);
          return; // stays blank — never reveals what this machine is
        }
        handle = proxy.createFrame();
        const el = handle.el as HTMLIFrameElement;
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.border = "0";
        el.style.display = "block";
        el.addEventListener("load", () => setLoading(false));
        if (hostRef.current && !dead) hostRef.current.appendChild(el);
        handle.onUrl(() => setLoading(false));
        handle.go(url);
      } catch {
        if (!dead) setLoading(false);
      }
    })();
    return () => {
      dead = true;
      // the frame dies with its host — no explicit teardown
      void handle;
    };
  }, [url, proxy]);

  return (
    <div className="relative h-full w-full bg-white">
      <div ref={hostRef} className="h-full w-full" />
      {loading && (
        <div className="absolute left-0 top-0 z-10 h-[2px] w-full overflow-hidden" aria-hidden="true">
          <div className="murke-bare-loading h-full w-1/3 rounded-full" />
        </div>
      )}
    </div>
  );
}

export default function SimpleProxy({ sound, proxy, onLogout, lite }: SimpleProxyProps) {
  const settings = useOS((s) => s.settings);
  const hydrateSettings = useOS((s) => s.hydrateSettings);

  const [query, setQuery] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [engine, setEngine] = useState<Engine>(() => loadEngine());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cornerHot, setCornerHot] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  /* settings hydrate normally lives in Desktop — simple mode may bypass it */
  useEffect(() => {
    hydrateSettings();
  }, [hydrateSettings]);

  /* pre-warm the proxy engine so the first browse is instant */
  useEffect(() => {
    const t = window.setTimeout(() => {
      void proxy.init().catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(t);
  }, [proxy]);

  /* focus the bar when idle on it */
  useEffect(() => {
    if (!url) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 60);
      return () => window.clearTimeout(t);
    }
  }, [url]);

  /* esc: browsing → the bar · picker open → close picker */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape" && url) {
        e.preventDefault();
        setUrl(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [url]);

  /* engine picker: outside click dismisses */
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [pickerOpen]);

  const go = useCallback(
    (raw: string) => {
      const s = raw.trim();
      if (!s) return;
      sound.enter();
      setUrl(engineTarget(engine, s));
    },
    [sound, engine],
  );

  const pickEngine = useCallback((e: Engine) => {
    setEngine(e);
    setPickerOpen(false);
    try {
      localStorage.setItem(ENGINE_KEY, e.id);
    } catch {
      /* private mode — session-only then */
    }
    window.setTimeout(() => inputRef.current?.focus(), 40);
  }, []);

  const tdef = resolveTheme(settings);
  const light = Boolean(tdef.light);
  const themeKey = resolveThemeKey(settings);
  const EngineIcon = engine.icon;

  return (
    <main
      className="murke-root fixed inset-0 overflow-hidden"
      style={{ ...themeVars(tdef), ...crtVars(settings.crt, light), backgroundColor: tdef.bg }}
      data-light={light ? "true" : undefined}
      data-skin="mac"
      aria-label="murke simple proxy"
    >
      {/* wallpaper, melted into glass */}
      <Wallpaper theme={themeKey} choice={settings.wallpaper} />
      <div
        className="pointer-events-none absolute inset-0 z-[1] backdrop-blur-[64px]"
        style={{
          background:
            "linear-gradient(to bottom, rgba(255,255,255,0.06), rgba(0,0,0,0) 42%, rgba(0,0,0,0.28))",
        }}
        aria-hidden="true"
      />

      {/* the bar — borderless glass, exactly one interruption-free layer */}
      {url === null && (
        <div className="absolute inset-0 z-10 flex items-center justify-center px-4">
          <div ref={barRef} className="relative w-[min(94vw,620px)]">
            <form
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                go(query);
              }}
              className="group flex items-center gap-2.5 rounded-[28px] bg-white/62 py-2.5 pl-2.5 pr-2 shadow-[0_28px_80px_-20px_rgba(0,0,0,0.6),0_2px_14px_rgba(0,0,0,0.14)] backdrop-blur-2xl transition-all duration-300 focus-within:bg-white/78 focus-within:shadow-[0_34px_100px_-18px_rgba(0,0,0,0.68)]"
            >
              {/* engine — click to pick where the words go */}
              <button
                type="button"
                onClick={() => setPickerOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={pickerOpen}
                aria-label={`search engine: ${engine.label}`}
                title={`search with ${engine.label} — click to change`}
                className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-neutral-600 transition-colors hover:bg-neutral-900/8 hover:text-neutral-900"
              >
                <EngineIcon size={19} strokeWidth={1.75} aria-hidden="true" />
              </button>

              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the web"
                aria-label="search the web"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[15px] text-neutral-800 outline-none placeholder:text-neutral-400"
              />

              <button
                type="submit"
                aria-label="search"
                title="search"
                className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-900/8 hover:text-neutral-800"
              >
                <Search size={18} strokeWidth={2} aria-hidden="true" />
              </button>

              {/* the way back to the full os — tiny, quiet, bottom-right of
                  the bar (never in lite: the ..0 door leads nowhere else) */}
              {!lite && (
                <>
                  <span className="w-px shrink-0 self-stretch bg-neutral-900/10" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={onLogout}
                    className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-900/8 hover:text-neutral-900"
                    title="lock — back to the gate"
                    aria-label="lock the session"
                  >
                    <LayoutGrid size={16} strokeWidth={1.9} aria-hidden="true" />
                  </button>
                </>
              )}
            </form>

            {/* engine picker — a quiet glass menu under the bar */}
            {pickerOpen && (
              <div
                role="menu"
                aria-label="search engine"
                className="absolute left-0 top-full z-20 mt-3 w-56 overflow-hidden rounded-2xl bg-white/80 p-1.5 shadow-[0_24px_70px_-16px_rgba(0,0,0,0.55)] backdrop-blur-2xl"
              >
                {ENGINES.map((e) => {
                  const active = e.id === engine.id;
                  const Icon = e.icon;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => pickEngine(e)}
                      className={`flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left text-[13px] transition-colors ${
                        active ? "bg-neutral-900/8 text-neutral-900" : "text-neutral-700 hover:bg-neutral-900/5"
                      }`}
                    >
                      <Icon size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-neutral-500" />
                      <span className="flex-1">{e.label}</span>
                      {active && <Check size={14} strokeWidth={2.25} aria-hidden="true" className="shrink-0 text-neutral-700" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* the proxy — the site IS the screen. no chips, no chrome: fullscreen
          without interruptions. esc returns to the bar (when the page doesn't
          own focus), and a quiet hover strip at the bottom-right edge summons
          the escape chips when it does. */}
      {url !== null && (
        <>
          <div className="absolute inset-0 z-10">
            <BareFrame key={url} url={url} proxy={proxy} />
          </div>

          {/* the corner — invisible until poked. JS pointer state, not css
              :hover: the escape hatch must work on touch / hoverless too */}
          <div
            className="absolute bottom-0 right-0 z-20"
            onPointerEnter={() => setCornerHot(true)}
            onPointerLeave={() => setCornerHot(false)}
          >
            <div className="h-2 w-60" aria-hidden="true" />
            <div
              className="absolute bottom-3 right-3 flex items-center gap-2 transition-opacity duration-200"
              style={{ opacity: cornerHot ? 1 : 0, pointerEvents: cornerHot ? "auto" : "none" }}
            >
              <button
                type="button"
                onClick={() => setUrl(null)}
                className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-white/35 bg-white/65 text-neutral-600 shadow-lg backdrop-blur-xl transition-all hover:bg-white/85 hover:text-neutral-900"
                title="back to search (esc)"
                aria-label="back to search"
              >
                <Home size={17} strokeWidth={1.9} aria-hidden="true" />
              </button>
              {!lite && (
                <button
                  type="button"
                  onClick={onLogout}
                  className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-white/35 bg-white/65 text-neutral-600 shadow-lg backdrop-blur-xl transition-all hover:bg-white/85 hover:text-neutral-900"
                  title="lock — back to the gate"
                  aria-label="lock the session"
                >
                  <LayoutGrid size={17} strokeWidth={1.9} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {/* the tube rides on top, as always */}
      <CrtFx crt={settings.crt} light={light} />
    </main>
  );
}
