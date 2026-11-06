"use client";

/**
 * FrostWidgets — the home's widget world.
 *
 * Seven kinds, every one a glass card the user drags, resizes (8-way
 * handles) and deletes in the editor (WidgetEditor.tsx):
 *
 *   clock    the time + date, any Google Font, any timezone
 *   oneko    the classic sprite cat — chases the cursor, naps, scratches
 *   battery  the device battery — Apple-minimal: the % and a charge pill
 *   text     whatever the user types
 *   music    a full liquid-glass player — yt search, queue, seek, volume
 *   weather  Apple's weather widget, 1:1 — live place / temp / H:L
 *   notes    Apple's notes widget, 1:1 — the yellow-marked card
 *
 * The board renders them in view mode (fixed to their saved spots); the
 * editor renders the same cards with drag/resize affordances + optional
 * snap-to-grid.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { FrostWidget, FrostWidgetKind, FrostWidgetSettings } from "@/lib/murke/frost-store";
import { attachYtFallbacks } from "@/lib/murke/yt-audio";
import { musicPlayer, type PlayerNow } from "@/lib/murke/player";
import {
  Search as SearchIcon,
  ChevronDown,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
} from "lucide-react";

/** the snap-to-grid step (px) — widgets and the search bar line up to it */
export const GRID_STEP = 24;

/* ------------------------------------------------------------------ */
/* glass letters — Apple's thick, offset glass typography             */
/* ------------------------------------------------------------------ */

/** the self-hosted thick rounded face behind the glass-letter look
    (Baloo 2 variable, /fonts/FrostGlass.var.woff2 — see globals.css) */
export const FROST_GLASS_FONT = "Frost Glass";

/** renders children twice: a blurred ghost nudged down-right (the offset
    thickness) under a gradient-filled face (the glass). Used by the clock,
    the text widget and the battery digits. */
export function GlassText({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={`frost-glass-text ${className}`}>
      <span className="frost-glass-off" aria-hidden="true">
        {children}
      </span>
      <span className="frost-glass-face">{children}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* the registry                                                        */
/* ------------------------------------------------------------------ */

export interface WidgetDef {
  kind: FrostWidgetKind;
  label: string;
  hint: string;
  w: number;
  h: number;
  /** smallest sensible size */
  minW: number;
  minH: number;
}

export const WIDGET_DEFS: WidgetDef[] = [
  { kind: "clock", label: "Clock", hint: "any timezone", w: 300, h: 170, minW: 130, minH: 80 },
  { kind: "oneko", label: "Oneko", hint: "follows your cursor", w: 180, h: 120, minW: 110, minH: 70 },
  { kind: "battery", label: "Battery", hint: "device charge", w: 220, h: 150, minW: 100, minH: 74 },
  { kind: "text", label: "Text", hint: "glass letters", w: 260, h: 140, minW: 100, minH: 56 },
  { kind: "music", label: "Music", hint: "search + play", w: 340, h: 250, minW: 200, minH: 140 },
  { kind: "weather", label: "Weather", hint: "live conditions", w: 320, h: 168, minW: 180, minH: 120 },
  { kind: "notes", label: "Notes", hint: "quick notes", w: 260, h: 300, minW: 130, minH: 130 },
];

export function widgetDefaults(kind: FrostWidgetKind, i: number): FrostWidget {
  const def = WIDGET_DEFS.find((d) => d.kind === kind) ?? WIDGET_DEFS[0];
  return {
    id: `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    // spawn spread across the home (coprime steps — consecutive adds land
    // far apart, clear of each other and mostly clear of the search bar)
    x: 4 + ((i * 17) % 84),
    y: 5 + ((i * 29) % 62),
    w: def.w,
    h: def.h,
    // widgets live UNDER the search world (container z-11) — always
    z: 1 + (i % 9),
    settings:
      kind === "clock"
        ? { font: FROST_GLASS_FONT, format24: false, seconds: false }
        : kind === "text"
          ? { text: "type something…", size: 22, color: "white" }
          : kind === "weather"
            ? { place: "" }
            : kind === "notes"
              ? { note: "" }
              : {},
  };
}

/* ------------------------------------------------------------------ */
/* google fonts (the clock's wardrobe)                                 */
/* ------------------------------------------------------------------ */

/** curated Google Fonts for the picker — any other name works too */
export const GOOGLE_FONTS: string[] = [
  /* the classics — clean UI sans */
  "Inter", "Roboto", "Poppins", "Montserrat", "Lato", "Rubik", "Nunito",
  "Ubuntu", "Archivo", "Cabin", "Figtree", "IBM Plex Sans", "Josefin Sans",
  "Karla", "Lexend", "Manrope", "Raleway", "Work Sans", "DM Sans", "Heebo",
  "Outfit", "Overpass", "Sora", "Urbanist", "Jost", "Chivo", "Dosis",
  "Assistant", "Signika", "Barlow", "Barlow Condensed", "PT Sans",
  "Libre Franklin", "Merriweather Sans", "Alegreya Sans", "Source Sans 3",
  "Space Grotesk", "Balsamiq Sans",
  /* serif — bookish, editorial */
  "Playfair Display", "Merriweather", "DM Serif Display", "Bodoni Moda",
  "Cormorant Garamond", "EB Garamond", "Lora", "Noto Serif", "Cardo",
  "Crimson Pro", "Domine", "Frank Ruhl Libre", "Libre Baskerville",
  "Old Standard TT", "PT Serif", "Quattrocento", "Source Serif 4",
  "Vollkorn", "Alegreya", "Young Serif", "Zilla Slab", "Roboto Slab",
  "Prata", "Marcellus", "Rokkitt", "Slabo 27px",
  /* script + handwriting */
  "Pacifico", "Dancing Script", "Caveat", "Satisfy", "Lobster",
  "Lobster Two", "Great Vibes", "Kaushan Script", "Parisienne",
  "Sacramento", "Shadows Into Light", "Indie Flower", "Chewy",
  "Permanent Marker", "Luckiest Guy",
  /* display + big statement faces */
  "Oswald", "Bebas Neue", "Anton", "Abril Fatface", "Alfa Slab One",
  "Bungee", "Concert One", "Fjalla One", "Fugaz One", "Righteous",
  "Staatliches", "Teko", "Titan One", "Yeseva One", "Fredoka",
  "Comfortaa", "Quicksand", "Kanit", "Prompt", "Exo 2", "Syne",
  "Unbounded", "Michroma", "Orbitron", "Oxanium", "Russo One",
  "Chakra Petch", "Philosopher", "Cinzel", "Cinzel Decorative",
  "Hammersmith One", "Major Mono Display", "Monoton",
  /* mono — the terminal wardrobe */
  "JetBrains Mono", "Fira Code", "Courier Prime", "IBM Plex Mono",
  "Inconsolata", "PT Mono", "Roboto Mono", "Ubuntu Mono", "VT323",
  "Press Start 2P", "Silkscreen", "Pixelify Sans", "Special Elite",
  "Tenor Sans",
];

/** the picker's list — the frost glass face first, then the Google Fonts */
export const FONT_CHOICES: string[] = [FROST_GLASS_FONT, ...GOOGLE_FONTS];

/** every IANA zone the browser knows — the clock's timezone picker */
export function timezones(): string[] {
  try {
    const anyIntl = Intl as typeof Intl & { supportedValuesOf?: (k: string) => string[] };
    if (typeof anyIntl.supportedValuesOf === "function") {
      const zones = anyIntl.supportedValuesOf("timeZone");
      if (Array.isArray(zones) && zones.length > 0) return zones;
    }
  } catch {
    /* fall through to the curated list */
  }
  return [
    "UTC", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
    "Europe/Rome", "Europe/Amsterdam", "Europe/Stockholm", "Europe/Warsaw",
    "Europe/Athens", "Europe/Moscow", "Europe/Istanbul", "Africa/Cairo",
    "Africa/Lagos", "Africa/Johannesburg", "Asia/Dubai", "Asia/Karachi",
    "Asia/Kolkata", "Asia/Dhaka", "Asia/Bangkok", "Asia/Singapore",
    "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Tokyo", "Asia/Seoul",
    "Australia/Perth", "Australia/Adelaide", "Australia/Sydney",
    "Pacific/Auckland", "America/Sao_Paulo", "America/Argentina/Buenos_Aires",
    "America/New_York", "America/Toronto", "America/Chicago", "America/Mexico_City",
    "America/Denver", "America/Los_Angeles", "America/Vancouver", "America/Anchorage",
    "Pacific/Honolulu",
  ];
}

/** the human label of an IANA zone — "Europe/London" → "London" */
export function zoneLabel(tz: string): string {
  const last = tz.split("/").pop() ?? tz;
  return last.replace(/_/g, " ");
}

/** inject (once) the css2 <link> for a family; harmless when offline.
    The frost glass face is self-hosted — it needs no link. */
const fontLinks = new Set<string>();
export function ensureGoogleFont(family: string): void {
  const fam = family.trim();
  if (!fam || fam === "Inter" || fam === FROST_GLASS_FONT || fontLinks.has(fam)) return;
  fontLinks.add(fam);
  try {
    const id = "frost-gf-" + fam.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, "+")}:wght@200;300;400;500&display=swap`;
    document.head.appendChild(link);
  } catch {
    /* offline — the stack falls back to Inter */
  }
}

/* ------------------------------------------------------------------ */
/* clock — any font, any timezone                                      */
/* ------------------------------------------------------------------ */

export function ClockWidget({ settings }: { settings: FrostWidgetSettings }) {
  const [now, setNow] = useState(() => new Date());
  const font = settings.font?.trim() || FROST_GLASS_FONT;
  useEffect(() => {
    ensureGoogleFont(font);
  }, [font]);
  useEffect(() => {
    const iv = window.setInterval(() => setNow(new Date()), settings.seconds ? 1000 : 15_000);
    return () => window.clearInterval(iv);
  }, [settings.seconds]);

  const tz = settings.tz?.trim() ? settings.tz.trim() : undefined;
  const timeFmt = new Intl.DateTimeFormat(undefined, {
    ...(tz ? { timeZone: tz } : {}),
    hour: settings.format24 ? "2-digit" : "numeric",
    minute: "2-digit",
    hour12: !settings.format24,
  });
  const secFmt = new Intl.DateTimeFormat(undefined, {
    ...(tz ? { timeZone: tz } : {}),
    second: "2-digit",
  });
  const dateFmt = new Intl.DateTimeFormat(undefined, {
    ...(tz ? { timeZone: tz } : {}),
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const hhmm = timeFmt.format(now);
  // formatToParts keeps AM/PM out of the minute slot ("7:36 PM" would
  // otherwise leak the day-period into mm)
  const parts = timeFmt.formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour")?.value ?? hhmm.split(":")[0] ?? "";
  const minPart = parts.find((p) => p.type === "minute")?.value ?? hhmm.split(":")[1] ?? "";
  const dayPeriod = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  const hh = hourPart;
  const mm = minPart;
  const ss = settings.seconds ? secFmt.format(now) : "";
  // the frost glass face is self-hosted; every other family rides css2
  const family =
    font === FROST_GLASS_FONT
      ? `"${FROST_GLASS_FONT}", var(--frost-glass-font), var(--frost-font), sans-serif`
      : `'${font.replace(/'/g, "")}', "${FROST_GLASS_FONT}", var(--frost-font), sans-serif`;
  // the glass-letter treatment belongs to the frost glass face alone —
  // every other font renders as itself, plain
  const glass = font === FROST_GLASS_FONT;

  const time = (
    <>
      {hh}
      <span className="frost-wg-clock-colon">:</span>
      {mm}
      {settings.seconds && <span className="frost-wg-clock-sec">{ss}</span>}
      {dayPeriod && <span className="frost-wg-clock-ampm">{dayPeriod}</span>}
    </>
  );

  return (
    <div className="frost-wg frost-wg-clock" style={{ fontFamily: family }}>
      <div className="frost-wg-clock-time">
        {glass ? <GlassText>{time}</GlassText> : <span className="frost-wg-clock-plain">{time}</span>}
      </div>
      <div className="frost-wg-clock-date">
        <span>{dateFmt.format(now)}</span>
        {tz && <span className="frost-wg-clock-tz">{zoneLabel(tz)}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* oneko — a faithful port of adryd325/oneko.js (MIT)                  */
/* ------------------------------------------------------------------ */

const ONEKO_SPRITE_SETS: Record<string, number[][]> = {
  idle: [[-3, -3]],
  alert: [[-7, -3]],
  scratchSelf: [[-5, 0], [-6, 0], [-7, 0]],
  scratchWallN: [[0, 0], [0, -1]],
  scratchWallS: [[-7, -1], [-6, -2]],
  scratchWallE: [[-2, -2], [-2, -3]],
  scratchWallW: [[-4, 0], [-4, -1]],
  tired: [[-3, -2]],
  sleeping: [[-2, 0], [-2, -1]],
  N: [[-1, -2], [-1, -3]],
  NE: [[0, -2], [0, -3]],
  E: [[-3, 0], [-3, -1]],
  SE: [[-5, -1], [-5, -2]],
  S: [[-6, -3], [-7, -2]],
  SW: [[-5, -3], [-6, -1]],
  W: [[-4, -2], [-4, -3]],
  NW: [[-1, 0], [-1, -1]],
};

/** the cat lives at module level — exactly one, ever */
let onekoRefCount = 0;
let onekoTeardown: (() => void) | null = null;

function onekoStart(spawnX: number, spawnY: number): void {
  const el = document.createElement("div");
  el.ariaHidden = "true";
  el.style.width = "32px";
  el.style.height = "32px";
  el.style.position = "fixed";
  el.style.pointerEvents = "none";
  el.style.imageRendering = "pixelated";
  el.style.zIndex = "2147483000";
  el.style.backgroundImage = "url(/frost/oneko.gif)";
  document.body.appendChild(el);

  let posX = Math.max(16, Math.min(window.innerWidth - 16, spawnX));
  let posY = Math.max(16, Math.min(window.innerHeight - 16, spawnY));
  let mouseX = posX;
  let mouseY = posY - 60;
  let frame = 0;
  let idleTime = 0;
  let idleAnimation: string | null = null;
  let idleFrame = 0;
  let raf = 0;
  let lastTs = 0;
  const speed = 10;

  const setSprite = (name: string, f: number) => {
    const set = ONEKO_SPRITE_SETS[name];
    if (!set) return;
    const s = set[f % set.length] ?? [-3, -3];
    el.style.backgroundPosition = `${s[0] * 32}px ${s[1] * 32}px`;
  };
  const place = () => {
    el.style.left = `${posX - 16}px`;
    el.style.top = `${posY - 16}px`;
  };
  const resetIdle = () => {
    idleAnimation = null;
    idleFrame = 0;
  };
  const idle = () => {
    idleTime += 1;
    if (idleTime > 10 && Math.floor(Math.random() * 200) === 0 && idleAnimation === null) {
      const options = ["sleeping", "scratchSelf"];
      if (posX < 32) options.push("scratchWallW");
      if (posY < 32) options.push("scratchWallN");
      if (posX > window.innerWidth - 32) options.push("scratchWallE");
      if (posY > window.innerHeight - 32) options.push("scratchWallS");
      idleAnimation = options[Math.floor(Math.random() * options.length)] ?? null;
    }
    switch (idleAnimation) {
      case "sleeping":
        if (idleFrame < 8) setSprite("tired", 0);
        else {
          setSprite("sleeping", Math.floor(idleFrame / 4));
          if (idleFrame > 192) resetIdle();
        }
        break;
      case "scratchWallN":
      case "scratchWallS":
      case "scratchWallE":
      case "scratchWallW":
      case "scratchSelf":
        setSprite(idleAnimation, idleFrame);
        if (idleFrame > 9) resetIdle();
        break;
      default:
        setSprite("idle", 0);
        return;
    }
    idleFrame += 1;
  };
  const step = () => {
    frame += 1;
    const diffX = posX - mouseX;
    const diffY = posY - mouseY;
    const distance = Math.sqrt(diffX ** 2 + diffY ** 2);
    if (distance < speed || distance < 48) {
      idle();
      return;
    }
    idleAnimation = null;
    idleFrame = 0;
    if (idleTime > 1) {
      setSprite("alert", 0);
      idleTime = Math.min(idleTime, 7);
      idleTime -= 1;
      return;
    }
    let direction = diffY / distance > 0.5 ? "N" : "";
    direction += diffY / distance < -0.5 ? "S" : "";
    direction += diffX / distance > 0.5 ? "W" : "";
    direction += diffX / distance < -0.5 ? "E" : "";
    setSprite(direction, frame);
    posX -= (diffX / distance) * speed;
    posY -= (diffY / distance) * speed;
    posX = Math.min(Math.max(16, posX), window.innerWidth - 16);
    posY = Math.min(Math.max(16, posY), window.innerHeight - 16);
    place();
  };
  const onFrame = (ts: number) => {
    if (!el.isConnected) return;
    if (!lastTs) lastTs = ts;
    if (ts - lastTs > 100) {
      lastTs = ts;
      step();
    }
    raf = window.requestAnimationFrame(onFrame);
  };
  const onMouse = (e: MouseEvent) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  };
  document.addEventListener("mousemove", onMouse, { passive: true });
  setSprite("idle", 0);
  place();
  raf = window.requestAnimationFrame(onFrame);
  onekoTeardown = () => {
    window.cancelAnimationFrame(raf);
    document.removeEventListener("mousemove", onMouse);
    el.remove();
    onekoTeardown = null;
  };
}

/** mount-side acquire: the first oneko widget claims THE cat */
export function useOneko(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const spawn: [number, number] = [
      Math.round(window.innerWidth * 0.72),
      Math.round(window.innerHeight * 0.62),
    ];
    if (onekoRefCount === 0) onekoStart(spawn[0], spawn[1]);
    onekoRefCount += 1;
    return () => {
      onekoRefCount = Math.max(0, onekoRefCount - 1);
      if (onekoRefCount === 0 && onekoTeardown) onekoTeardown();
    };
  }, [active]);
}

/** the widget card itself — invisible in view mode (the cat is global) */
export function OnekoWidget({ editing }: { editing: boolean }) {
  useOneko(!editing);
  if (!editing) return null;
  return (
    <div className="frost-wg frost-wg-oneko">
      <div
        className="frost-wg-oneko-sprite"
        style={{ backgroundImage: "url(/frost/oneko.gif)", backgroundPosition: "-96px -96px" }}
        aria-hidden="true"
      />
      <span>oneko — follows your cursor</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* battery — Apple-clean: the number, the pill, nothing else           */
/* ------------------------------------------------------------------ */

interface BatteryState {
  level: number; // 0..1
  charging: boolean;
  supported: boolean;
}

export function useBattery(): BatteryState {
  const [state, setState] = useState<BatteryState>({ level: 1, charging: false, supported: false });
  useEffect(() => {
    interface BatteryManagerLike extends EventTarget {
      level: number;
      charging: boolean;
    }
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
    if (!nav.getBattery) return;
    let dead = false;
    let battery: BatteryManagerLike | null = null;
    const read = () => {
      if (dead || !battery) return;
      setState({ level: battery.level, charging: battery.charging, supported: true });
    };
    void nav.getBattery().then((b) => {
      if (dead) return;
      battery = b;
      read();
      b.addEventListener("levelchange", read);
      b.addEventListener("chargingchange", read);
    });
    return () => {
      dead = true;
      if (battery) {
        battery.removeEventListener("levelchange", read);
        battery.removeEventListener("chargingchange", read);
      }
    };
  }, []);
  return state;
}

export function BatteryWidget() {
  const { level, charging, supported } = useBattery();
  const pct = Math.round(level * 100);
  return (
    <div className="frost-wg frost-wg-battery" role="status" aria-label={`battery ${pct} percent${charging ? ", charging" : ""}`}>
      {supported ? (
        <div className="frost-wg-batt">
          {/* the number — big, glass, the hero of the card */}
          <div className="frost-wg-batt-num">
            <GlassText>
              {pct}
              <span className="frost-wg-batt-unit">%</span>
            </GlassText>
          </div>
          {/* the full-width thin horizontal outline — the battery level,
              its inside filled to the current percentage */}
          <div className="frost-wg-batt-shell" aria-hidden="true">
            <div className="frost-wg-batt-fill" style={{ width: `${pct > 0 ? Math.max(3.5, pct) : 0}%` }} />
            {charging && (
              <svg className="frost-wg-batt-bolt" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13l0-8z" />
              </svg>
            )}
          </div>
          <span className="frost-wg-batt-nub" aria-hidden="true" />
          <span className="frost-wg-batt-state">{charging ? "charging" : "on battery"}</span>
        </div>
      ) : (
        <div className="frost-wg-batt-na">battery unavailable</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* text                                                                */
/* ------------------------------------------------------------------ */

export function TextWidget({ settings }: { settings: FrostWidgetSettings }) {
  const dark = settings.color === "black";
  return (
    <div
      className={`frost-wg frost-wg-text ${dark ? "frost-wg-text-dark" : ""}`}
      style={{ fontSize: settings.size ?? 22 }}
    >
      {(settings.text ?? "").split("\n").map((line, i) => (
        <GlassText key={i} className="frost-wg-text-line">
          {line || "\u00A0"}
        </GlassText>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* music — liquid glass, lucide icons, zero emojis                     */
/* ------------------------------------------------------------------ */

interface YtHit {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  thumb: string;
}

/** a song's artwork — the CDN first, then our same-origin /api/artwork
    relay when the browser refuses the cross-origin image (COEP corners,
    hard filters). Only truly dead art hides. */
function MusicThumb({ src, alt = "" }: { src: string; alt?: string }) {
  const [stage, setStage] = useState<"direct" | "relay" | "dead">(
    src ? "direct" : "dead",
  );
  if (stage === "dead" || !src) {
    return <span className="frost-wg-music-note-dot" aria-hidden="true" />;
  }
  return (
    <img
      src={stage === "direct" ? src : `/api/artwork?u=${encodeURIComponent(src)}`}
      alt={alt}
      loading="lazy"
      onError={() => setStage(stage === "direct" ? "relay" : "dead")}
    />
  );
}

export function MusicWidget({ widgetId }: { widgetId: string }) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<YtHit[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [queue, setQueue] = useState<YtHit[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(true);
  const [now, setNow] = useState<PlayerNow | null>(null);
  const [playing, setPlaying] = useState(false);

  /* player mirror — the singleton ticks, the widget reflects */
  useEffect(() => {
    const sync = () => {
      setNow(musicPlayer.current());
      setPlaying(musicPlayer.playing());
    };
    sync();
    musicPlayer.onTick(sync);
    musicPlayer.onEnded(() => {
      // autoplay-next: the queue marches on
      setQueue((q) => {
        const cur = musicPlayer.current();
        const idx = q.findIndex((t) => `yt:${t.videoId}` === cur?.id);
        const next = q[idx + 1];
        if (next) void play(next);
        return q;
      });
    });
    return () => {
      musicPlayer.onTick(null);
      musicPlayer.onEnded(null);
    };
  }, []);

  const play = async (hit: YtHit) => {
    setCurrentId(hit.videoId);
    setNote(null);
    /* EMBED-FIRST — youtube's own hidden player carries the track from
       the user's own connection (no resolver, no datacenter wall, full
       length, instant start). Resolved stream links are attached behind
       it as fallbacks for the rare embed-refusing video. */
    const trackId = `yt:${hit.videoId}`;
    const started = musicPlayer.playExternal(trackId, hit.title, `embed:${hit.videoId}`, {
      videoId: hit.videoId,
    });
    if (!started) setNote("player refused the stream");
    else void attachYtFallbacks(trackId, hit.videoId);
    setNow(musicPlayer.current());
    setPlaying(musicPlayer.playing());
  };

  const search = async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setNote(null);
    setResults(null);
    try {
      const res = await fetch(`/api/yt2?search=${encodeURIComponent(q)}`);
      const j = (await res.json()) as { ok: boolean; results?: YtHit[]; error?: string };
      if (j.ok && j.results) {
        setResults(j.results.slice(0, 12));
        setQueue(j.results.slice(0, 12));
      } else {
        setResults([]);
        setNote(j.error ?? "no results");
      }
    } catch {
      setResults([]);
      setNote("search failed");
    } finally {
      setSearching(false);
    }
  };

  const seekTo = (sec: number) => musicPlayer.seek(sec);
  const setVolume = (pct: number) => musicPlayer.volume(pct);
  const toggle = () => {
    // optimistic — the player's embed state now updates in the same tick,
    // but the button still reads the intent, never a stale half-second
    const willPlay = !musicPlayer.playing();
    musicPlayer.togglePause();
    setPlaying(willPlay);
  };
  const step = (dir: 1 | -1) => {
    const idx = queue.findIndex((t) => t.videoId === currentId);
    const next = queue[idx + dir];
    if (next) void play(next);
  };
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const currentTrack = queue.find((t) => t.videoId === currentId) ?? null;
  const progress = now && now.durationSec > 0 ? (now.positionSec / now.durationSec) * 100 : 0;

  return (
    <div className="frost-wg frost-wg-music" data-widget={widgetId}>
      {/* search — glass field, lucide mark */}
      {showSearch ? (
        <div className="frost-wg-music-search">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <SearchIcon className="frost-wg-mic-searchicon" aria-hidden="true" />
            <input
              type="text"
              value={query}
              placeholder="search music…"
              aria-label="search music"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" aria-label="search" disabled={searching}>
              {searching ? <span className="frost-wg-mic-spin" aria-hidden="true" /> : <SearchIcon aria-hidden="true" />}
            </button>
          </form>
          <button type="button" className="frost-wg-music-toggle" onClick={() => setShowSearch(false)} aria-label="hide search">
            <ChevronDown aria-hidden="true" />
          </button>
        </div>
      ) : (
        <button type="button" className="frost-wg-music-open" onClick={() => setShowSearch(true)} aria-label="show search">
          <SearchIcon aria-hidden="true" />
          <span>search</span>
        </button>
      )}

      {/* results list */}
      {results && (
        <div className="frost-wg-music-list">
          {results.map((hit) => (
            <button
              key={hit.videoId}
              type="button"
              className={`frost-wg-music-row ${hit.videoId === currentId ? "frost-wg-music-row-live" : ""}`}
              onClick={() => {
                // the live row is the play/pause toggle — replaying it from
                // zero (what a fresh play used to do) is never wanted
                if (hit.videoId === currentId) toggle();
                else void play(hit);
                setShowSearch(false);
              }}
            >
              <span className="frost-wg-music-thumb" aria-hidden="true">
                <MusicThumb src={hit.thumb} alt="" />
              </span>
              <span className="frost-wg-music-meta">
                <span className="frost-wg-music-title">{hit.title}</span>
                <span className="frost-wg-music-artist">{hit.author}</span>
              </span>
              <span className="frost-wg-music-dur">{fmt(hit.durationSec)}</span>
            </button>
          ))}
          {results.length === 0 && <div className="frost-wg-music-empty">{note ?? "nothing found"}</div>}
        </div>
      )}

      {/* the player — liquid glass, icon transport */}
      <div className="frost-wg-music-player">
        <div className="frost-wg-music-now" title={currentTrack?.title ?? ""}>
          {currentTrack ? (
            <>
              <span className="frost-wg-music-now-title">{currentTrack.title}</span>
              <span className="frost-wg-music-now-artist">{currentTrack.author}</span>
            </>
          ) : (
            <span className="frost-wg-music-now-artist">nothing playing</span>
          )}
        </div>
        <div className="frost-wg-music-seek">
          <span className="frost-wg-music-time">{now ? fmt(now.positionSec) : "0:00"}</span>
          <input
            type="range"
            min={0}
            max={Math.max(1, now?.durationSec ?? 1)}
            value={Math.min(now?.positionSec ?? 0, now?.durationSec ?? 1)}
            aria-label="seek"
            onChange={(e) => seekTo(Number(e.target.value))}
            style={{ "--frost-fill": `${progress}%` } as React.CSSProperties}
          />
          <span className="frost-wg-music-time">{now?.durationSec ? fmt(now.durationSec) : "–:––"}</span>
        </div>
        <div className="frost-wg-music-ctrl">
          <button type="button" onClick={() => step(-1)} aria-label="previous" disabled={!currentTrack}>
            <SkipBack aria-hidden="true" />
          </button>
          <button type="button" className="frost-wg-music-play" onClick={toggle} aria-label={playing ? "pause" : "play"} disabled={!currentTrack}>
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </button>
          <button type="button" onClick={() => step(1)} aria-label="next" disabled={!currentTrack}>
            <SkipForward aria-hidden="true" />
          </button>
          <span className="frost-wg-music-vol" aria-hidden="true">
            <Volume2 aria-hidden="true" />
            <input
              type="range"
              min={0}
              max={100}
              defaultValue={musicPlayer.volumePct() || 80}
              aria-label="volume"
              onChange={(e) => setVolume(Number(e.target.value))}
              style={{ "--frost-fill": `${musicPlayer.volumePct() || 80}%` } as React.CSSProperties}
            />
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* weather — Apple's widget, 1:1                                       */
/* ------------------------------------------------------------------ */

interface WeatherPayload {
  ok: boolean;
  place?: string;
  current?: {
    tempC: number;
    code: number;
    condition: string;
    isDay?: boolean;
  };
  daily?: { date: string; hi: number; lo: number; code: number; condition: string }[];
  error?: string;
}

/** the SF-Symbol-ish condition mark — sun, moon, clouds, rain, snow… */
export function WeatherMark({ code, isDay, size = 30 }: { code: number; isDay?: boolean; size?: number }) {
  const s = { width: size, height: size };
  if (code >= 95) {
    // thunderstorm — cloud + bolt + rain
    return (
      <svg viewBox="0 0 32 32" style={s} fill="none" aria-hidden="true">
        <path d="M8 14a5 5 0 0 1 9.6-1.9A4.5 4.5 0 1 1 20 21H10a4 4 0 0 1-2-7z" fill="rgba(255,255,255,.92)" />
        <path d="M17.5 21.5l-3.4 5h2.4l-1.2 4 4.4-5.6h-2.6l1.4-3.4z" fill="#FFD60A" />
      </svg>
    );
  }
  if (code >= 71 && code <= 86) {
    // snow — cloud + flakes
    return (
      <svg viewBox="0 0 32 32" style={s} fill="none" aria-hidden="true">
        <path d="M8 14a5 5 0 0 1 9.6-1.9A4.5 4.5 0 1 1 20 21H10a4 4 0 0 1-2-7z" fill="rgba(255,255,255,.92)" />
        <path d="M12 24.5v4M10.5 26.5h3M20 24.5v4M18.5 26.5h3" stroke="rgba(255,255,255,.95)" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
    // rain — cloud + drops
    return (
      <svg viewBox="0 0 32 32" style={s} fill="none" aria-hidden="true">
        <path d="M8 13a5 5 0 0 1 9.6-1.9A4.5 4.5 0 1 1 20 20H10a4 4 0 0 1-2-7z" fill="rgba(255,255,255,.92)" />
        <path d="M13 23l-1.5 4M19 23l-1.5 4" stroke="rgba(255,255,255,.85)" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (code >= 45) {
    // fog — cloud + lines
    return (
      <svg viewBox="0 0 32 32" style={s} fill="none" aria-hidden="true">
        <path d="M8 12a5 5 0 0 1 9.6-1.9A4.5 4.5 0 1 1 20 19H10a4 4 0 0 1-2-7z" fill="rgba(255,255,255,.85)" />
        <path d="M9 23h14M11 26h10" stroke="rgba(255,255,255,.7)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (code >= 2) {
    // partly cloudy — sun behind a cloud (moon at night)
    return (
      <svg viewBox="0 0 32 32" style={s} fill="none" aria-hidden="true">
        {isDay ? (
          <circle cx="21" cy="11" r="5.4" fill="#FFD60A" opacity="0.2" />
        ) : (
          <path d="M22.6 6.3a5.2 5.2 0 1 0 3.4 6.6 4.2 4.2 0 1 1-3.4-6.6z" fill="rgba(255,255,255,.75)" />
        )}
        <path d="M7 19a5 5 0 0 1 9.6-1.9A4.5 4.5 0 1 1 19 26H9a4 4 0 0 1-2-7z" fill="rgba(255,255,255,.94)" />
        {isDay && <circle cx="20.5" cy="11" r="3.2" fill="#FFD60A" />}
      </svg>
    );
  }
  if (code >= 1) {
    // mostly clear
    return (
      <svg viewBox="0 0 32 32" style={s} fill="none" aria-hidden="true">
        <path d="M7 19a5 5 0 0 1 9.6-1.9A4.5 4.5 0 1 1 19 26H9a4 4 0 0 1-2-7z" fill="rgba(255,255,255,.85)" />
        {isDay ? <circle cx="23" cy="9" r="4" fill="#FFD60A" opacity="0.9" /> : null}
      </svg>
    );
  }
  // clear — full sun or moon
  return isDay ? (
    <svg viewBox="0 0 32 32" style={s} fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="6.2" fill="#FFD60A" />
      <g stroke="#FFD60A" strokeWidth="1.8" strokeLinecap="round">
        <path d="M16 4.4v3.4M16 24.2v3.4M4.4 16h3.4M24.2 16h3.4M7.8 7.8l2.4 2.4M21.8 21.8l2.4 2.4M24.2 7.8l-2.4 2.4M10.2 21.8l-2.4 2.4" />
      </g>
    </svg>
  ) : (
    <svg viewBox="0 0 32 32" style={s} fill="none" aria-hidden="true">
      <path d="M19.5 5.5A10.5 10.5 0 1 0 26.5 19 8.5 8.5 0 0 1 19.5 5.5z" fill="rgba(255,255,255,.95)" />
      <path d="M23 9.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" fill="rgba(255,255,255,.9)" />
    </svg>
  );
}

export function WeatherWidget({ settings }: { settings: FrostWidgetSettings }) {
  const [data, setData] = useState<WeatherPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const place = settings.place?.trim() ?? "";
  const key = place || "@auto";

  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const url = place ? `/api/weather?city=${encodeURIComponent(place)}` : "/api/weather";
        const res = await fetch(url);
        const j = (await res.json()) as WeatherPayload;
        if (dead) return;
        if (j.ok && j.current) {
          setData(j);
          setError(null);
        } else {
          setError(j.error ?? "could not read the weather");
        }
      } catch {
        if (!dead) setError("the weather service did not answer");
      }
    };
    void load();
    const iv = window.setInterval(load, 15 * 60_000);
    return () => {
      dead = true;
      window.clearInterval(iv);
    };
  }, [key]);  

  const cur = data?.current;
  const today = data?.daily?.[0];
  const isDay = cur?.isDay !== false;
  const code = cur?.code ?? 0;

  return (
    <div
      className={`frost-wg frost-wg-weather ${isDay ? "frost-wg-weather-day" : "frost-wg-weather-night"}`}
      role="status"
      aria-label={cur ? `weather in ${data?.place}: ${Math.round(cur.tempC)} degrees, ${cur.condition}` : "weather"}
    >
      {cur ? (
        <>
          <div className="frost-wg-weather-top">
            <span className="frost-wg-weather-place">{data?.place}</span>
            <WeatherMark code={code} isDay={isDay} size={30} />
          </div>
          <div className="frost-wg-weather-temp">
            {Math.round(cur.tempC)}
            <span className="frost-wg-weather-deg">°</span>
          </div>
          <div className="frost-wg-weather-bottom">
            <span className="frost-wg-weather-cond">{cur.condition}</span>
            {today && (
              <span className="frost-wg-weather-hilo">
                H:<b>{Math.round(today.hi)}°</b> L:<b>{Math.round(today.lo)}°</b>
              </span>
            )}
          </div>
        </>
      ) : (
        <div className="frost-wg-weather-loading">
          {error ?? "reading the sky…"}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* notes — glassy, colorless, editable right on the home               */
/* ------------------------------------------------------------------ */

export function NotesWidget({
  settings,
  editing,
  onNote,
}: {
  settings: FrostWidgetSettings;
  /** true inside the home editor — the card is a drag target, not a page */
  editing?: boolean;
  /** write-back — present in view mode, absent in the editor */
  onNote?: (text: string) => void;
}) {
  const note = settings.note ?? "";
  const editable = !editing && !!onNote;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number>(0);
  const [live, setLive] = useState(note);

  /* uncontrolled body — React must never re-type under the caret. Sync
     only when the text genuinely changed elsewhere (the editor panel)
     and the field isn't focused. */
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !editable) return;
    if (document.activeElement === el) return;
    if (el.innerText.replace(/\n$/, "") !== note) el.innerText = note;
  }, [note, editable]);

  useEffect(() => {
    setLive(note);
  }, [note]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const commit = (text: string) => {
    setLive(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onNote?.(text), 350);
  };

  /* note-taking ergonomics — Tab indents (the browser default walks focus
     out of the widget); the count line keeps words honest */
  const words = live.trim() ? live.trim().split(/\s+/).length : 0;
  const chars = live.length;

  return (
    <div className="frost-wg frost-wg-notes" role="note" aria-label="notes widget">
      <div className="frost-wg-notes-head">
        {/* the colorless glass note-mark — a little page + lines */}
        <svg className="frost-wg-notes-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4.5" y="2.5" width="15" height="19" rx="3.2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7.5h8M8 11h8M8 14.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.7" />
        </svg>
        <span className="frost-wg-notes-title">Notes</span>
        {editable && (live.trim() || undefined) && (
          <button
            type="button"
            className="frost-wg-notes-clear"
            aria-label="clear the note"
            title="clear note"
            onClick={() => {
              const el = bodyRef.current;
              if (el) el.innerText = "";
              commit("");
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
            </svg>
          </button>
        )}
      </div>
      {editable ? (
        <div
          ref={bodyRef}
          className="frost-wg-notes-body frost-wg-notes-editable"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="notes — editable"
          data-placeholder="write something…"
          onInput={(e) => commit((e.target as HTMLDivElement).innerText)}
          onBlur={(e) => {
            window.clearTimeout(timer.current);
            onNote?.((e.target as HTMLDivElement).innerText);
          }}
          onContextMenu={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Tab") {
              // indent inside the note — the default would abandon the
              // field and strand the caret
              e.preventDefault();
              document.execCommand("insertText", false, "  ");
            }
          }}
          spellCheck={false}
        />
      ) : (
        <div className="frost-wg-notes-body">
          {note.trim() ? (
            note.split("\n").map((line, i) => (
              <span key={i} className="frost-wg-notes-line">{line || "\u00A0"}</span>
            ))
          ) : (
            <span className="frost-wg-notes-line frost-wg-notes-empty">write something…</span>
          )}
        </div>
      )}
      <div className="frost-wg-notes-foot" aria-hidden="true">
        <span>{words === 1 ? "1 word" : `${words} words`}</span>
        <span>·</span>
        <span>{chars === 1 ? "1 char" : `${chars} chars`}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the board (view + edit modes)                                       */
/* ------------------------------------------------------------------ */

export function WidgetBody({
  widget,
  editing,
  onSettings,
}: {
  widget: FrostWidget;
  editing: boolean;
  /** live settings write-back — the notes widget types on the home */
  onSettings?: (patch: Partial<FrostWidgetSettings>) => void;
}) {
  switch (widget.kind) {
    case "clock":
      return <ClockWidget settings={widget.settings} />;
    case "oneko":
      return <OnekoWidget editing={editing} />;
    case "battery":
      return <BatteryWidget />;
    case "text":
      return <TextWidget settings={widget.settings} />;
    case "music":
      return <MusicWidget widgetId={widget.id} />;
    case "weather":
      return <WeatherWidget settings={widget.settings} />;
    case "notes":
      return (
        <NotesWidget
          settings={widget.settings}
          editing={editing}
          onNote={onSettings ? (text) => onSettings({ note: text }) : undefined}
        />
      );
    default:
      return null;
  }
}

/** snap a pixel position to the grid step */
function snapPx(px: number, step: number): number {
  return Math.round(px / step) * step;
}

export function WidgetBoard({
  widgets,
  editing,
  selectedId,
  onSelect,
  onChange,
  onDelete,
  grid,
}: {
  widgets: FrostWidget[];
  editing: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onChange?: (id: string, patch: Partial<FrostWidget>) => void;
  onDelete?: (id: string) => void;
  /** snap moves to the grid while editing */
  grid?: boolean;
}) {
  const ordered = useMemo(() => [...widgets].sort((a, b) => a.z - b.z), [widgets]);
  if (widgets.length === 0) return null;

  return (
    <>
      {ordered.map((w) => {
        const selected = editing && w.id === selectedId;
        const def = WIDGET_DEFS.find((d) => d.kind === w.kind);
        return (
          <div
            key={w.id}
            className={`frost-widget ${editing ? "frost-widget-editing" : ""} ${selected ? "frost-widget-selected" : ""}`}
            style={{
              // stay fully on-screen: the left/top clamp against the
              // widget's own box so a desktop-pinned card never hangs off
              // a phone-sized viewport
              left: `min(${w.x}%, max(0px, calc(100vw - ${w.w}px - 8px)))`,
              top: `min(${w.y}%, max(0px, calc(100vh - ${w.h}px - 8px)))`,
              width: `min(${w.w}px, calc(100vw - 24px))`,
              height: w.kind === "oneko" && !editing ? 0 : w.h,
              zIndex: w.z,
            }}
            onPointerDown={
              editing
                ? (e) => {
                    e.stopPropagation();
                    onSelect?.(w.id);
                    startDrag(e, w);
                  }
                : undefined
            }
          >
            <WidgetBody
              widget={w}
              editing={editing}
              onSettings={
                onChange
                  ? (p) => onChange(w.id, { settings: { ...w.settings, ...p } })
                  : undefined
              }
            />

            {editing && (
              <>
                {/* the red trash — corner, only while selected */}
                {selected && onDelete && (
                  <button
                    type="button"
                    className="frost-widget-trash"
                    aria-label={`delete ${w.kind} widget`}
                    title="delete widget"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(w.id);
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                    </svg>
                  </button>
                )}
                {/* eight resize grips — every edge and corner, big targets */}
                {selected && onChange && (
                  <>
                    {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const).map((dir) => (
                      <div
                        key={dir}
                        className={`frost-widget-handle frost-widget-handle-${dir}`}
                        aria-label={`resize ${w.kind} widget from ${dir}`}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          startResize(e, w, dir, def);
                        }}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        );
      })}
    </>
  );

  /* drag — the widget follows the pointer, saved as % of the viewport.
     Grid on: the widget's top-left snaps to GRID_STEP cells. Every move
     broadcasts "frost-widget-drag" so the editor's palette can dodge the
     cursor (see WidgetEditor). */
  function startDrag(e: React.PointerEvent, w: FrostWidget) {
    if (!onChange) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = w.x;
    const oy = w.y;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dodge = (x: number, y: number, active: boolean) => {
      window.dispatchEvent(new CustomEvent("frost-widget-drag", { detail: { x, y, active } }));
    };
    dodge(startX, startY, true);
    const onMove = (ev: PointerEvent) => {
      let px = (ox / 100) * vw + (ev.clientX - startX);
      let py = (oy / 100) * vh + (ev.clientY - startY);
      if (grid) {
        px = snapPx(px, GRID_STEP);
        py = snapPx(py, GRID_STEP);
      }
      const x = Math.min(100, Math.max(0, (px / vw) * 100));
      const y = Math.min(100, Math.max(0, (py / vh) * 100));
      onChange(w.id, { x, y });
      dodge(ev.clientX, ev.clientY, true);
    };
    const onUp = (ev: PointerEvent) => {
      dodge(ev.clientX, ev.clientY, false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /* resize — 8 directions: edges move one axis, corners both. The
     opposite side stays pinned. Grid on: sizes snap to GRID_STEP. */
  function startResize(
    e: React.PointerEvent,
    w: FrostWidget,
    dir: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw",
    def?: WidgetDef,
  ) {
    if (!onChange) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const ow = w.w;
    const oh = w.h;
    const ox = w.x;
    const oy = w.y;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minW = def?.minW ?? 120;
    const minH = def?.minH ?? 80;
    const onMove = (ev: PointerEvent) => {
      let dx = ev.clientX - startX;
      let dy = ev.clientY - startY;
      if (grid) {
        dx = snapPx(ow + dx, GRID_STEP) - ow;
        dy = snapPx(oh + dy, GRID_STEP) - oh;
      }
      const east = dir.includes("e");
      const south = dir.includes("s");
      const north = dir.includes("n");
      const west = dir.includes("w");
      let nw = ow;
      let nh = oh;
      let nx = ox;
      let ny = oy;
      if (east) nw = Math.max(minW, Math.min(1400, ow + dx));
      if (west) {
        nw = Math.max(minW, Math.min(1400, ow - dx));
        nx = Math.min(100, Math.max(0, ox + ((ow - nw) / vw) * 100));
      }
      if (south) nh = Math.max(minH, Math.min(1000, oh + dy));
      if (north) {
        nh = Math.max(minH, Math.min(1000, oh - dy));
        ny = Math.min(100, Math.max(0, oy + ((oh - nh) / vh) * 100));
      }
      onChange(w.id, { w: nw, h: nh, x: nx, y: ny });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
}
