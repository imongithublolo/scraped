/**
 * Weather for the dsh terminal — real data, terminal-drawn drama.
 * fetchUserGeo() fixes the USER'S real position — the browser's own
 * geolocation (gps/wifi) when permitted, ipwho.is as the fallback — and
 * fetchWeather() pulls from /api/weather (open-meteo + wttr.in + met.no
 * upstream). renderWeatherHTML() typesets the payload as one fixed-width
 * block of colored text: a NORMAL weather icon (emoji — the ascii icon art
 * is retired), a stat grid, a 24h temperature chart, rain odds bars, a
 * wind rose, the outlook range bars, and a globe (see globe.ts) that dives
 * to the caller's coordinates.
 */

export interface WeatherCurrent {
  tempC: number;
  feelsC: number;
  humidity: number;
  windKmh: number;
  pressure: number;
  code: number;
  condition: string;
  gustKmh?: number;
  windDirDeg?: number;
  precipMm?: number;
  precipPct?: number;
  cloudPct?: number;
  uvIndex?: number;
  visibilityKm?: number;
  dewC?: number;
  isDay?: boolean;
}

export interface WeatherDay {
  date: string; // YYYY-MM-DD
  hi: number;
  lo: number;
  code: number;
  condition: string;
  precipPct?: number;
  uvMax?: number;
  windMaxKmh?: number;
}

export interface WeatherHour {
  hour: number;
  tempC: number;
  precipPct: number;
  /** cloud cover % — drives the globe's hover cloud graph + the ascii chart */
  cloudPct?: number;
}

export interface WeatherNow {
  place: string; // "<city>, <CC>"
  lat?: number;
  lon?: number;
  /** where the coordinate fix came from — shown in the POSITION legend */
  geoSrc?: "gps" | "ip";
  current: WeatherCurrent;
  /** FOUR FUTURE days — tomorrow through day+4, today is never included. */
  daily: WeatherDay[];
  /** next 24h starting at the current local hour (open-meteo only) */
  hourly?: WeatherHour[];
  sun?: { sunrise: string; sunset: string } | null;
}

interface IpGeo {
  success: boolean;
  city: string;
  country_code: string;
  latitude: number;
  longitude: number;
}

function isIpGeo(v: unknown): v is IpGeo {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.success === true &&
    typeof o.city === "string" &&
    typeof o.country_code === "string" &&
    typeof o.latitude === "number" &&
    Number.isFinite(o.latitude) &&
    typeof o.longitude === "number" &&
    Number.isFinite(o.longitude)
  );
}

let geoCache: { at: number; geo: IpGeo | null } | null = null;

/**
 * Geolocate the caller's own IP straight from the browser. Fast and silent
 * (no permission prompt) — it names the forecast place and backs up the
 * gps fix. Memoized for 5 minutes.
 */
async function clientIpGeo(): Promise<IpGeo | null> {
  if (geoCache && Date.now() - geoCache.at < 300_000) return geoCache.geo;
  let geo: IpGeo | null = null;
  try {
    const res = await fetch("https://ipwho.is/", {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (res.ok) {
      const data: unknown = await res.json();
      geo = isIpGeo(data) ? data : null;
    }
  } catch {
    geo = null;
  }
  geoCache = { at: Date.now(), geo };
  return geo;
}

/* ---------- the USER's real position (gps first, ip backup) ---------- */

export interface UserGeo {
  lat: number;
  lon: number;
  src: "gps" | "ip";
}

const GEO_LS = "murke.geo.v1";
const GEO_TTL = 600_000; // a position fix is good for 10 minutes

interface CachedGeo {
  lat: number;
  lon: number;
  src: "gps" | "ip";
  at: number;
}

function readGeoCache(): CachedGeo | null {
  try {
    const raw = localStorage.getItem(GEO_LS);
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedGeo;
    if (typeof c.lat === "number" && typeof c.lon === "number" && Date.now() - c.at < GEO_TTL) return c;
  } catch {
    /* private mode / corrupt — ignore */
  }
  return null;
}

function writeGeoCache(g: CachedGeo): void {
  try {
    localStorage.setItem(GEO_LS, JSON.stringify(g));
  } catch {
    /* ignore */
  }
}

/**
 * The browser's OWN fix — wifi/cell triangulation or gps. This is what
 * makes the globe go to the user's ACTUAL spot: ip geolocation can land
 * miles away (vpn egress, isp nat in another city). Resolves null on
 * denial/error/timeout (or insecure contexts without the api). A 'denied'
 * permission state skips the wait entirely; an unanswered prompt is cut
 * off at 7s so `weather` never hangs on it.
 */
function browserGps(): Promise<CachedGeo | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return resolve(null);
    try {
      navigator.permissions
        ?.query({ name: "geolocation" as PermissionName })
        .then((st) => {
          if (st.state === "denied") resolve(null); // never asks again — straight to ip
        })
        .catch(() => {}); // permissions api quirk (safari) — just try below
    } catch {
      /* ignore */
    }
    let done = false;
    const finish = (g: CachedGeo | null): void => {
      if (done) return;
      done = true;
      resolve(g);
    };
    const timer = window.setTimeout(() => finish(null), 7000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        window.clearTimeout(timer);
        finish({ lat: pos.coords.latitude, lon: pos.coords.longitude, src: "gps", at: Date.now() });
      },
      () => {
        window.clearTimeout(timer);
        finish(null);
      },
      { timeout: 6500, maximumAge: 60_000, enableHighAccuracy: false },
    );
  });
}

let userGeoPromise: Promise<UserGeo | null> | null = null;

/**
 * The USER's own coordinates — the globe's fly-to target and the forecast
 * point. One fix per page load (module-level promise), a 10-minute
 * localStorage cache across reloads: the permission prompt happens once,
 * not on every `weather`. Order: cache → browser gps → ipwho.is.
 */
export function fetchUserGeo(): Promise<UserGeo | null> {
  if (!userGeoPromise) {
    userGeoPromise = (async (): Promise<UserGeo | null> => {
      const cached = readGeoCache();
      if (cached) return { lat: cached.lat, lon: cached.lon, src: cached.src };
      const gps = await browserGps();
      if (gps) {
        writeGeoCache(gps);
        return { lat: gps.lat, lon: gps.lon, src: "gps" };
      }
      const ip = await clientIpGeo();
      if (ip) {
        const g: CachedGeo = { lat: ip.latitude, lon: ip.longitude, src: "ip", at: Date.now() };
        writeGeoCache(g);
        return { lat: g.lat, lon: g.lon, src: "ip" };
      }
      return null;
    })().catch(() => null);
  }
  return userGeoPromise;
}

/** Fetches current + the next four days (tomorrow onward). Null on failure. */
export async function fetchWeather(city?: string): Promise<WeatherNow | null> {
  const fetchApi = async (qs: string): Promise<WeatherNow | null> => {
    try {
      const res = await fetch(`/api/weather${qs}`);
      if (!res.ok) return null;
      const data: unknown = await res.json();
      return isWeatherNow(data) ? data : null;
    } catch {
      return null;
    }
  };

  if (city) return fetchApi(`?city=${encodeURIComponent(city)}`);

  // no city: fix the USER's position (gps when allowed, else their ip —
  // both browser-side), then ask the api purely for the forecast there.
  // the ip lookup also names the place; gps wins for the coordinates.
  const [geo, ipGeo] = await Promise.all([fetchUserGeo(), clientIpGeo()]);
  const lat = geo?.lat ?? ipGeo?.latitude;
  const lon = geo?.lon ?? ipGeo?.longitude;
  if (typeof lat === "number" && typeof lon === "number") {
    const label = ipGeo ? `${ipGeo.city}, ${ipGeo.country_code}` : "your spot";
    const w = await fetchApi(`?lat=${lat}&lon=${lon}&place=${encodeURIComponent(label)}`);
    if (w) return w;
  }
  // last resort: let the server try (xff header -> its own egress ip)
  return fetchApi("");
}

/* ---------- type guard (strict, optional fields lenient) ---------- */

function isWeatherNow(v: unknown): v is WeatherNow {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.place !== "string" || typeof o.current !== "object" || o.current === null) return false;
  const c = o.current as Record<string, unknown>;
  if (!num(c.tempC) || !num(c.feelsC) || !num(c.humidity) || !num(c.windKmh) || !num(c.pressure) || !num(c.code)) {
    return false;
  }
  if (typeof c.condition !== "string") return false;
  if (!Array.isArray(o.daily) || o.daily.length === 0) return false;
  for (const d of o.daily) {
    if (typeof d !== "object" || d === null) return false;
    const dd = d as Record<string, unknown>;
    if (typeof dd.date !== "string" || !num(dd.hi) || !num(dd.lo) || !num(dd.code) || typeof dd.condition !== "string") {
      return false;
    }
  }
  return true;
}

function num(x: unknown): boolean {
  return typeof x === "number" && Number.isFinite(x);
}

/* ---------- colored ascii rendering ---------- */

const V = {
  dim: "var(--term-dim)",
  fg: "var(--term-fg)",
  hi: "var(--term-hi)",
  brand: "var(--term-brand)",
  err: "var(--term-err)",
};

type Seg = { c: string; t: string; raw?: boolean };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One terminal row of colored segments; pad() keeps fixed-width alignment. */
class Row {
  private segs: Seg[] = [];
  private w = 0;
  add(c: string, t: string): this {
    if (!t) return this;
    this.segs.push({ c, t });
    this.w += t.length;
    return this;
  }
  /** pre-escaped html segment (emoji icons) — counted as ~2 monospace cells */
  raw(html: string): this {
    this.segs.push({ c: "", t: html, raw: true });
    this.w += 2;
    return this;
  }
  /** the tail filler gets the dim tone so blank space never stares back */
  pad(width: number): this {
    if (this.w < width) {
      this.segs.push({ c: V.dim, t: " ".repeat(width - this.w) });
      this.w = width;
    }
    return this;
  }
  html(): string {
    return this.segs.map((s) => (s.raw ? s.t : `<span style="color:${s.c}">${esc(s.t)}</span>`)).join("");
  }
}

/* ---------- condition icons — NORMAL weather icons (emoji) ----------
   The old 7-row ascii icon art is retired: a real glyph reads instantly
   and never breaks the grid. Day/night variants for the clear skies. */

function emojiFor(c: WeatherCurrent): string {
  const s = c.condition.toLowerCase();
  const night = c.isDay === false;
  if (s.includes("thunderstorm")) return "\u26A1"; // ⚡
  if (s.includes("snow")) return "\u2744\uFE0F"; // ❄️
  if (s.includes("freezing") || s.includes("sleet")) return "\uD83C\uDF28\uFE0F"; // 🌨️
  if (s.includes("rain") || s.includes("drizzle") || s.includes("shower")) return "\uD83C\uDF27\uFE0F"; // 🌧️
  if (s.includes("fog") || s.includes("mist")) return "\uD83C\uDF2B\uFE0F"; // 🌫️
  if (s.includes("partly")) return night ? "\u2601\uFE0F" : "\u26C5"; // ☁️ / ⛅
  if (s.includes("overcast") || s.includes("cloud")) return "\u2601\uFE0F"; // ☁️
  return night ? "\uD83C\uDF19" : "\u2600\uFE0F"; // 🌙 / ☀️
}

/* ---------- small helpers ---------- */

const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const DIR_ARROWS: Record<string, string> = {
  N: "↑", NE: "↗", E: "→", SE: "↘", S: "↓", SW: "↙", W: "←", NW: "↖",
};

function compass8(deg: number | undefined): string {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return "·";
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return DIRS[idx];
}

function weekday(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? "???" : ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][d.getDay()];
}

function c2f(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

function degLat(lat: number): string {
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}`;
}
function degLon(lon: number): string {
  return `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
}

/* ---------- the eight-block bar scale ---------- */

const EIGHTHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** block char for a 0..1 fill inside one row cell */
function block(frac: number): string {
  if (frac <= 0) return " ";
  const idx = Math.min(8, Math.max(1, Math.round(frac * 8)));
  return EIGHTHS[idx];
}

const WIDTH = 62;

function rule(r: Row, ch = "─"): void {
  r.add(V.dim, ch.repeat(WIDTH - 1));
  r.pad(WIDTH);
}

/* ---------- main renderer ---------- */

/** Typesets a WeatherNow into ONE colored html block (fixed width, 62 cols). */
export function renderWeatherHTML(w: WeatherNow): string {
  const c = w.current;
  const rows: string[] = [];

  /* header */
  const head = new Row();
  head.add(V.brand, "▚ ");
  head.add(V.hi, "SKY ▸ ");
  head.add(V.fg, w.place.toUpperCase().slice(0, 40));
  head.pad(WIDTH);
  rows.push(head.html());

  /* icon + stat grid, side by side */
  const stats: Array<Array<[string, string]>> = [
    [[V.hi, `${c.tempC.toFixed(1)}°C`.padStart(6) + " "], [V.fg, `${c2f(c.tempC)}°F`], [V.dim, `  feels ${c.feelsC.toFixed(1)}°C`]],
    [[V.fg, c.condition.slice(0, 30)]],
    [
      [V.fg, "wind "],
      [V.brand, `${c.windKmh} km/h ${compass8(c.windDirDeg)}`],
      ...(typeof c.gustKmh === "number" ? ([[V.dim, ` · gust ${c.gustKmh}`]] as Array<[string, string]>) : []),
    ],
    [
      [V.fg, "rain "],
      [V.brand, `${typeof c.precipMm === "number" ? c.precipMm.toFixed(1) : "0.0"} mm`],
      ...(w.hourly?.length ? ([[V.dim, " · "], [V.brand, `${w.hourly[0].precipPct}%`], [V.dim, " next hr"]] as Array<[string, string]>) : []),
    ],
    [
      [V.fg, "hum "], [V.brand, `${c.humidity}%`],
      ...(typeof c.dewC === "number" ? ([[V.dim, " · dew "], [V.fg, `${c.dewC.toFixed(1)}°C`]] as Array<[string, string]>) : []),
    ],
    [
      [V.fg, "pres "], [V.brand, `${c.pressure} hPa`],
      ...(typeof c.uvIndex === "number" ? ([[V.dim, " · uv "], [V.fg, String(c.uvIndex)]] as Array<[string, string]>) : []),
    ],
    [
      [V.fg, "vis "], [V.brand, typeof c.visibilityKm === "number" ? `${c.visibilityKm} km` : "—"],
      [V.dim, " · clouds "], [V.fg, typeof c.cloudPct === "number" ? `${c.cloudPct}%` : "—"],
      ...(w.sun ? ([[V.dim, " · ↑"], [V.hi, w.sun.sunrise], [V.dim, " ↓"], [V.hi, w.sun.sunset]] as Array<[string, string]>) : []),
    ],
  ];
  const emoji = emojiFor(c);
  for (let i = 0; i < stats.length; i++) {
    const r = new Row();
    if (i === 0) {
      // the condition icon leads the stat grid — a real glyph, not ascii
      r.add(V.dim, "  ");
      r.raw(`<span aria-hidden="true" style="font-size:1.45em;vertical-align:middle">${emoji}</span>`);
      r.add(V.dim, "  ");
    } else {
      r.add(V.dim, "      ");
    }
    for (const [col, t] of stats[i] ?? []) r.add(col, t);
    r.pad(WIDTH);
    rows.push(r.html());
  }

  const div = new Row();
  rule(div);
  rows.push(div.html());

  /* 24h temperature chart — 24 double-width bars, 6 rows, eighth-blocks */
  const hourly = w.hourly ?? [];
  if (hourly.length >= 6) {
    const temps = hourly.map((h) => h.tempC);
    const tMax = Math.max(...temps);
    const tMin = Math.min(...temps);
    const span = Math.max(1, tMax - tMin);
    const ROWS = 6;
    const r = new Row();
    r.add(V.dim, " ");
    r.add(V.fg, "TEMPERATURE · NEXT 24H");
    r.pad(WIDTH - 12);
    r.add(V.hi, `▴${Math.round(tMax)}°`);
    r.add(V.dim, " ");
    r.add(V.dim, `▾${Math.round(tMin)}°`);
    r.pad(WIDTH);
    rows.push(r.html());
    const colColor = (t: number): string => {
      const f = (t - tMin) / span;
      return f > 0.66 ? V.hi : f > 0.33 ? V.brand : V.dim;
    };
    for (let row = 0; row < ROWS; row++) {
      const r2 = new Row();
      r2.add(V.dim, "  ");
      for (const t of temps) {
        const frac = (t - tMin) / span; // 0..1
        const cellTop = 1 - row / ROWS; // this row's ceiling (1 at top row)
        const fill = Math.max(0, Math.min(1, (frac - (cellTop - 1 / ROWS)) * ROWS));
        r2.add(colColor(t), block(fill) + block(fill));
      }
      r2.pad(WIDTH);
      rows.push(r2.html());
    }
    const lbl = new Row();
    lbl.add(V.dim, "  ");
    const marks = new Map<number, string>();
    for (const i of [0, 6, 12, 18]) {
      if (i < hourly.length) marks.set(i * 2, `${String(hourly[i].hour).padStart(2, "0")}`);
    }
    for (let col = 0; col < 48; col++) {
      lbl.add(V.dim, marks.get(col) ?? " ");
    }
    lbl.pad(WIDTH);
    rows.push(lbl.html());
  }

  /* cloud cover — 12h sky density, every 2h. ░ clear → ▊ overcast */
  const cloudHours = hourly.filter((h) => typeof h.cloudPct === "number");
  if (cloudHours.length >= 4) {
    const ccNow = cloudHours[0].cloudPct ?? 0;
    const headC = new Row();
    headC.add(V.dim, " ");
    headC.add(V.fg, "CLOUD COVER · 12H");
    headC.pad(WIDTH - 10);
    headC.add(V.dim, "now ");
    headC.add(V.brand, `${ccNow}%`);
    headC.pad(WIDTH);
    rows.push(headC.html());
    const ROWS_C = 4;
    for (let row = 0; row < ROWS_C; row++) {
      const r2 = new Row();
      r2.add(V.dim, "  ");
      for (const h of cloudHours) {
        const pct = (h.cloudPct ?? 0) / 100;
        const cellTop = 1 - row / ROWS_C;
        const fill = Math.max(0, Math.min(1, (pct - (cellTop - 1 / ROWS_C)) * ROWS_C));
        // cloud texture: denser glyphs as the sky fills
        const glyph = fill <= 0 ? " " : fill < 0.34 ? "░" : fill < 0.67 ? "▒" : fill < 0.95 ? "▓" : "█";
        r2.add(V.fg, glyph + glyph);
      }
      r2.pad(WIDTH);
      rows.push(r2.html());
    }
    const lblC = new Row();
    lblC.add(V.dim, "  ");
    const marksC = new Map<number, string>();
    for (const i of [0, 3, 6, 9]) {
      if (i < cloudHours.length) marksC.set(i * 2, `${String(cloudHours[i].hour).padStart(2, "0")}`);
    }
    for (let col = 0; col < Math.min(24, cloudHours.length * 2); col++) {
      lblC.add(V.dim, marksC.get(col) ?? " ");
    }
    lblC.pad(WIDTH);
    rows.push(lblC.html());
  }

  /* rain odds bars (12h, every 2h) + wind rose, side by side */
  if (hourly.length >= 4) {
    const rainRows: string[][] = [];
    for (let i = 0; i < 12 && i < hourly.length; i += 2) {
      const h = hourly[i];
      const filled = Math.round((h.precipPct / 100) * 14);
      rainRows.push([
        `${String(h.hour).padStart(2, "0")}h `,
        "█".repeat(filled) + "░".repeat(14 - filled),
        ` ${String(h.precipPct).padStart(3)}%`,
      ]);
    }
    const dir = compass8(c.windDirDeg);
    const rose: string[] = ["   N   ", " ↖ ╱↑╲ ↗ ", "W←─✦─→E", " ↙ ╲↓╱ ↘ ", "   S   "];
    const head = new Row();
    head.add(V.dim, " ");
    head.add(V.fg, "RAIN ODDS · 12H");
    head.pad(24);
    head.add(V.dim, " ");
    head.add(V.fg, "WIND ROSE");
    head.pad(WIDTH);
    rows.push(head.html());
    const body = Math.max(rainRows.length, rose.length + 1);
    for (let i = 0; i < body; i++) {
      const r = new Row();
      r.add(V.dim, " ");
      const rain = rainRows[i];
      if (rain) {
        r.add(V.dim, rain[0]);
        r.add(V.brand, rain[1]);
        r.add(V.dim, rain[2]);
      }
      r.pad(24);
      r.add(V.dim, " ");
      if (i < rose.length) {
        for (const ch of rose[i]) {
          const isActive = ch === DIR_ARROWS[dir];
          const isCardinal = "NSEW".includes(ch);
          const isPin = ch === "✦";
          r.add(isPin ? V.fg : isActive ? V.brand : isCardinal ? V.fg : V.dim, ch);
        }
      } else {
        r.add(V.brand, `→ ${c.windKmh} km/h ${dir}`);
        if (typeof c.gustKmh === "number") r.add(V.dim, ` · gust ${c.gustKmh}`);
      }
      r.pad(WIDTH);
      rows.push(r.html());
    }
  }

  const div2 = new Row();
  rule(div2);
  rows.push(div2.html());

  /* outlook — 4 days with range bars */
  if (w.daily.length > 0) {
    const r = new Row();
    r.add(V.dim, " ");
    r.add(V.fg, "OUTLOOK");
    r.pad(WIDTH);
    rows.push(r.html());
    const gLo = Math.min(...w.daily.map((d) => d.lo));
    const gHi = Math.max(...w.daily.map((d) => d.hi));
    const gSpan = Math.max(1, gHi - gLo);
    const BAR = 16;
    for (const d of w.daily) {
      const r2 = new Row();
      r2.add(V.dim, "  ");
      r2.add(V.fg, weekday(d.date));
      r2.add(V.dim, " ");
      r2.add(V.hi, `${String(d.hi).padStart(3)}°`);
      r2.add(V.dim, " ");
      for (let k = 0; k < BAR; k++) {
        const pos = gLo + ((k + 0.5) * gSpan) / BAR;
        r2.add(V.brand, pos >= d.lo && pos <= d.hi ? "█" : "·");
      }
      r2.add(V.dim, " ");
      r2.add(V.dim, `${String(d.lo).padStart(3)}°`);
      r2.add(V.dim, "  ");
      r2.add(V.fg, d.condition.slice(0, 16).padEnd(16));
      if (typeof d.precipPct === "number") {
        r2.add(V.dim, " ");
        r2.add(V.brand, `${d.precipPct}%`);
      }
      r2.pad(WIDTH);
      rows.push(r2.html());
    }
  }

  /* the position block — the spinning three.js globe to the right owns the
     visual; this is its legend (kept short, command-response style) */
  const hasFix = typeof w.lat === "number" && typeof w.lon === "number";
  const posHead = new Row();
  rule(posHead);
  rows.push(posHead.html());
  const ph = new Row();
  ph.add(V.dim, " ");
  ph.add(V.fg, "POSITION");
  ph.pad(14);
  ph.add(
    V.hi,
    hasFix
      ? `${degLat(w.lat as number)} ${degLon(w.lon as number)}${w.geoSrc ? ` · ${w.geoSrc === "gps" ? "gps fix" : "ip fix"}` : ""}`
      : "position unknown",
  );
  ph.pad(WIDTH);
  rows.push(ph.html());
  const pl = new Row();
  pl.add(V.dim, " ");
  pl.add(V.dim, hasFix ? "drag sideways to spin \u00b7 it dives to your spot and shows the sky" : "ip locate failed");
  pl.pad(WIDTH);
  rows.push(pl.html());
  const pp = new Row();
  pp.add(V.dim, " ");
  pp.add(V.hi, w.place.slice(0, 44));
  pp.pad(WIDTH);
  rows.push(pp.html());

  /* footer */
  const foot = new Row();
  foot.add(V.dim, " open-meteo · wttr.in · met.no");
  foot.pad(WIDTH);
  rows.push(foot.html());

  return rows.join("\n");
}

/* ---------- globe info-card attributes ---------- */

function attrEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Preformatted data-* attributes for the globe's info card (see globe.ts):
 * temperature, condition, wind, rain and humidity — html-attribute-safe.
 */
export function weatherCardAttrs(w: WeatherNow): string {
  const c = w.current;
  const t = ` data-temp="${attrEsc(`${c.tempC.toFixed(1)}°C`)}"`;
  const cond = ` data-cond="${attrEsc(c.condition.slice(0, 40))}"`;
  const dir = compass8(c.windDirDeg);
  const wind = ` data-wind="${attrEsc(dir === "·" ? `${c.windKmh} km/h` : `${c.windKmh} km/h ${dir}`)}"`;
  const rain = ` data-rain="${attrEsc(`${(typeof c.precipMm === "number" ? c.precipMm : 0).toFixed(1)} mm`)}"`;
  const hum = ` data-hum="${attrEsc(`${c.humidity}%`)}"`;
  return t + cond + wind + rain + hum;
}
