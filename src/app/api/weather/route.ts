import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/weather?city=<optional>
 *
 * city given  -> open-meteo geocoding + forecast; any failure falls back to
 *                wttr.in/<city> (free, keyless) -> else 502 / 404
 * lat+lon+place -> straight forecast (the browser already geo-fixed the
 *                  VISITOR's ip client-side; see lib/murke/weather.ts)
 * no params   -> caller IP: x-forwarded-for FIRST -> ipwho.is/<ip>;
 *                bare ipwho.is (server egress) only as the last resort;
 *                still nothing -> 404 "could not locate — pass a city: weather <city>"
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const IPWHO_URL = "https://ipwho.is";
const WTTR_URL = "https://wttr.in";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

interface GeoResult {
  name?: string;
  country_code?: string;
  admin1?: string;
  latitude?: number;
  longitude?: number;
}

interface IpWhoResult {
  success?: boolean;
  city?: string;
  country_code?: string;
  latitude?: number;
  longitude?: number;
}

interface WeatherHour {
  hour: number;
  tempC: number;
  precipPct: number;
}

interface WeatherPayload {
  place: string;
  lat?: number;
  lon?: number;
  current: {
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
  };
  daily: {
    date: string;
    hi: number;
    lo: number;
    code: number;
    condition: string;
    precipPct?: number;
    uvMax?: number;
    windMaxKmh?: number;
  }[];
  /** next 24h starting at the current local hour (open-meteo only) */
  hourly?: WeatherHour[];
  sun?: { sunrise: string; sunset: string } | null;
}

interface OpenMeteoForecast {
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    surface_pressure?: number;
    wind_gusts_10m?: number;
    wind_direction_10m?: number;
    precipitation?: number;
    cloud_cover?: number;
    is_day?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    precipitation_probability?: number[];
    cloud_cover?: number[];
    uv_index?: number[];
    visibility?: number[];
    dew_point_2m?: number[];
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    sunrise?: string[];
    sunset?: string[];
    uv_index_max?: number[];
    precipitation_probability_max?: number[];
    wind_speed_10m_max?: number[];
  };
}

interface WttrResp {
  current_condition?: {
    temp_C?: string;
    FeelsLikeC?: string;
    humidity?: string;
    windspeedKmph?: string;
    pressure?: string;
    weatherCode?: string;
    weatherDesc?: { value?: string }[];
    WindGustKmph?: string;
    winddirDegree?: string;
    precipMM?: string;
    cloudcover?: string;
    uvIndex?: string;
    visibility?: string;
  }[];
  weather?: {
    date?: string;
    maxtempC?: string;
    mintempC?: string;
    astronomy?: { sunrise?: string; sunset?: string }[];
    hourly?: { weatherCode?: string; chanceofrain?: string }[];
  }[];
  nearest_area?: {
    areaName?: { value?: string }[];
    country?: { value?: string }[];
  }[];
}

/** WMO weather interpretation code -> short condition name. */
function wmoCondition(code: number): string {
  if (code === 0) return "clear";
  if (code === 1) return "mostly clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 55) return "drizzle";
  if (code === 56 || code === 57) return "freezing rain";
  if (code >= 61 && code <= 65) return "rain";
  if (code === 66 || code === 67) return "freezing rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code === 95) return "thunderstorm";
  if (code === 96 || code === 99) return "thunderstorm + hail";
  return "unknown";
}

/** wttr.in numeric condition code -> short condition name. */
function wttrCondition(code: number): string {
  if (code === 113) return "clear";
  if (code === 116) return "partly cloudy";
  if (code === 119 || code === 122) return "overcast";
  if (code === 143 || code === 248 || code === 260) return "fog";
  if (code === 176 || code === 293 || code === 386) return "rain showers";
  if (code === 263 || code === 266 || code === 281 || code === 284) return "drizzle";
  if (code === 296 || code === 299 || code === 302) return "rain";
  if (code >= 305 && code <= 308) return "rain";
  if (code === 353 || code === 356 || code === 359) return "rain showers";
  if (code === 200 || code === 389) return "thunderstorm";
  if (code === 392 || code === 395) return "thunderstorm + hail";
  if (code === 179 || code === 323 || code === 326) return "light snow";
  if (code === 227 || code === 230 || code === 332 || code === 338) return "snow";
  if (code === 329 || code === 335) return "snow showers";
  if (code === 317 || code === 320 || code === 362 || code === 365) return "sleet";
  if (code === 368) return "snow showers";
  if (code === 350 || code === 374 || code === 377) return "freezing rain";
  return "overcast";
}

/* ---------- met.no fallback (open-meteo has tight shared-ip quotas) ---------- */

interface MetNoEntry {
  time?: string;
  data?: {
    instant?: { details?: { air_temperature?: number; wind_speed?: number; relative_humidity?: number; air_pressure_at_sea_level?: number } };
    next_6_hours?: { summary?: { symbol_code?: string } };
  };
}

interface MetNoPayload {
  properties?: { timeseries?: MetNoEntry[] };
}

/** met.no symbol_code -> the same short condition names the other providers emit. */
function metNoCondition(code: string): string {
  if (!code) return "overcast";
  if (code.includes("thunder")) return "thunderstorm";
  if (code.includes("sleet")) return "sleet";
  if (code.includes("snow")) return "snow";
  if (code.includes("rain")) return code.includes("showers") ? "rain showers" : "rain";
  if (code.includes("fog")) return "fog";
  if (code.includes("cloud")) return code.includes("partly") ? "partly cloudy" : "overcast";
  if (code.includes("fair")) return "mostly clear";
  if (code.includes("clear")) return "clear";
  return "overcast";
}

function mostCommon(list: string[]): string {
  const counts = new Map<string, number>();
  let best = "";
  let bestN = 0;
  for (const v of list) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

async function fromMetNo(lat: number, lon: number, place: string): Promise<WeatherPayload | null> {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`;
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "murke-proxy/2.1 (terminal weather; contact: b29s)" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as MetNoPayload;
  const ts = data?.properties?.timeseries;
  if (!ts || ts.length === 0) return null;

  const first = ts[0];
  const d0 = first?.data?.instant?.details ?? {};
  const curCode = first?.data?.next_6_hours?.summary?.symbol_code ?? "";

  // rough local-day bucketing from longitude — good enough for hi/lo bars
  const tzShiftMs = (lon / 15) * 3600 * 1000;
  const localDay = (iso: string): string =>
    new Date(new Date(iso).getTime() + tzShiftMs).toISOString().slice(0, 10);
  const today = localDay(new Date().toISOString());

  const byDay = new Map<string, { hi: number; lo: number; codes: string[] }>();
  for (const e of ts) {
    if (!e.time) continue;
    const t = e.data?.instant?.details?.air_temperature;
    if (typeof t !== "number") continue;
    const day = localDay(e.time);
    if (day <= today) continue; // forecast starts TOMORROW
    const slot = byDay.get(day) ?? { hi: -999, lo: 999, codes: [] };
    slot.hi = Math.max(slot.hi, t);
    slot.lo = Math.min(slot.lo, t);
    const code = e.data?.next_6_hours?.summary?.symbol_code;
    if (code) slot.codes.push(code);
    byDay.set(day, slot);
  }
  const daily: WeatherPayload["daily"] = [];
  for (const [date, slot] of byDay) {
    daily.push({
      date,
      hi: Math.round(slot.hi),
      lo: Math.round(slot.lo),
      code: 0,
      condition: metNoCondition(slot.codes.length ? mostCommon(slot.codes) : ""),
    });
    if (daily.length >= 4) break;
  }
  if (daily.length < 2) return null;

  const curCodeNum = 0;
  return {
    place,
    current: {
      tempC: round1(d0.air_temperature ?? 0),
      feelsC: round1(d0.air_temperature ?? 0),
      humidity: Math.round(d0.relative_humidity ?? 0),
      windKmh: Math.round((d0.wind_speed ?? 0) * 3.6),
      pressure: Math.round(d0.air_pressure_at_sea_level ?? 0),
      code: curCodeNum,
      condition: metNoCondition(curCode) || "overcast",
    },
    daily,
  };
}

function isPrivateIp(ip: string): boolean {
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip === "::1" || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) return true;
  return false;
}

async function getJson<T>(url: string, timeoutMs = 15000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/* ---------- providers ---------- */

function hhmm(iso: string | undefined): string | undefined {
  if (typeof iso !== "string" || iso.length < 16) return undefined;
  return iso.slice(11, 16);
}

async function fromOpenMeteo(lat: number, lon: number, place: string): Promise<WeatherPayload | null> {
  const fcUrl =
    `${FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,surface_pressure,wind_gusts_10m,wind_direction_10m,precipitation,cloud_cover,is_day" +
    "&hourly=temperature_2m,precipitation_probability,cloud_cover,uv_index,visibility,dew_point_2m" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max,wind_speed_10m_max" +
    "&forecast_hours=48&forecast_days=5&timezone=auto";
  const fc = await getJson<OpenMeteoForecast & { error?: boolean; reason?: string }>(fcUrl, 20000);
  const cur = fc?.current;
  const daily = fc?.daily;
  // open-meteo signals quota exhaustion with 200 + {error:true, reason}
  if (!cur || fc?.error === true || !daily?.time?.length) return null;

  const curCode = typeof cur.weather_code === "number" ? cur.weather_code : 0;
  const times = daily.time;
  const codes = daily.weather_code;
  const maxes = daily.temperature_2m_max;
  const mins = daily.temperature_2m_min;
  // forecast_days=5 gives today + 4; the forecast starts TOMORROW, so the
  // 4-day claim is real four future days, never "today again".
  const start = times.length > 4 ? 1 : 0;
  const count = Math.min(4, times.length - start);
  const dailyOut: WeatherPayload["daily"] = [];
  for (let i = start; i < start + count; i++) {
    const code = codes && typeof codes[i] === "number" ? codes[i] : 0;
    const pPct = daily.precipitation_probability_max?.[i];
    const uvMax = daily.uv_index_max?.[i];
    const wMax = daily.wind_speed_10m_max?.[i];
    dailyOut.push({
      date: times[i],
      hi: Math.round(maxes?.[i] ?? 0),
      lo: Math.round(mins?.[i] ?? 0),
      code,
      condition: wmoCondition(code),
      ...(typeof pPct === "number" ? { precipPct: Math.round(pPct) } : {}),
      ...(typeof uvMax === "number" ? { uvMax: Math.round(uvMax * 10) / 10 } : {}),
      ...(typeof wMax === "number" ? { windMaxKmh: Math.round(wMax) } : {}),
    });
  }

  // next 24 hourly samples starting at the current local hour
  let hourly: WeatherHour[] | undefined;
  const hTimes = fc.hourly?.time;
  const hTemps = fc.hourly?.temperature_2m;
  const hPops = fc.hourly?.precipitation_probability;
  const hClouds = fc.hourly?.cloud_cover;
  if (hTimes?.length && hTemps?.length) {
    const curHourIso = (cur.time ?? "").slice(0, 13) + ":00";
    let idx = hTimes.findIndex((t) => t >= curHourIso);
    if (idx < 0) idx = 0;
    const out: WeatherHour[] = [];
    for (let i = idx; i < Math.min(idx + 24, hTimes.length); i++) {
      const t = hTemps[i];
      if (typeof t !== "number") continue;
      const cc = hClouds?.[i];
      out.push({
        hour: parseInt(hTimes[i].slice(11, 13), 10) || 0,
        tempC: Math.round(t * 10) / 10,
        precipPct: Math.round(hPops?.[i] ?? 0),
        ...(typeof cc === "number" ? { cloudPct: Math.round(cc) } : {}),
      });
    }
    if (out.length >= 12) hourly = out;
  }

  // instant-spot values pulled from the current local hour
  const spot = (arr: number[] | undefined): number | undefined => {
    if (!arr?.length || !hourly || hourly.length === 0) return undefined;
    return arr[hTimes!.findIndex((t) => t >= (cur.time ?? "").slice(0, 13) + ":00")];
  };
  const uvIdx = spot(fc.hourly?.uv_index);
  const visM = spot(fc.hourly?.visibility);
  const dew = spot(fc.hourly?.dew_point_2m);

  return {
    place,
    lat: Math.round(lat * 100) / 100,
    lon: Math.round(lon * 100) / 100,
    current: {
      tempC: round1(cur.temperature_2m ?? 0),
      feelsC: round1(cur.apparent_temperature ?? 0),
      humidity: Math.round(cur.relative_humidity_2m ?? 0),
      windKmh: Math.round(cur.wind_speed_10m ?? 0),
      pressure: Math.round(cur.surface_pressure ?? 0),
      code: curCode,
      condition: wmoCondition(curCode),
      ...(typeof cur.wind_gusts_10m === "number" ? { gustKmh: Math.round(cur.wind_gusts_10m) } : {}),
      ...(typeof cur.wind_direction_10m === "number" ? { windDirDeg: Math.round(cur.wind_direction_10m) } : {}),
      ...(typeof cur.precipitation === "number" ? { precipMm: round1(cur.precipitation) } : {}),
      ...(typeof cur.cloud_cover === "number" ? { cloudPct: Math.round(cur.cloud_cover) } : {}),
      ...(typeof cur.is_day === "number" ? { isDay: cur.is_day === 1 } : {}),
      ...(typeof uvIdx === "number" ? { uvIndex: Math.round(uvIdx * 10) / 10 } : {}),
      ...(typeof visM === "number" && visM > 0 ? { visibilityKm: Math.round(visM / 1000) } : {}),
      ...(typeof dew === "number" ? { dewC: Math.round(dew * 10) / 10 } : {}),
    },
    daily: dailyOut,
    hourly,
    sun:
      hhmm(daily.sunrise?.[start - 1 < 0 ? 0 : start - 1]) &&
      hhmm(daily.sunset?.[start - 1 < 0 ? 0 : start - 1])
        ? {
            sunrise: hhmm(daily.sunrise![start - 1 < 0 ? 0 : start - 1])!,
            sunset: hhmm(daily.sunset![start - 1 < 0 ? 0 : start - 1])!,
          }
        : null,
  };
}

async function fromWttr(query: string, placeOverride?: string): Promise<WeatherPayload | null> {
  const data = await getJson<WttrResp>(
    `${WTTR_URL}/${encodeURIComponent(query)}?format=j1&lang=en`,
    20000,
  );
  const cur = data?.current_condition?.[0];
  const days = data?.weather;
  if (!cur || !days?.length) return null;

  const area = data.nearest_area?.[0];
  const place =
    placeOverride ??
    ([area?.areaName?.[0]?.value, area?.country?.[0]?.value].filter(Boolean).join(", ") ||
      query);

  const desc = (cur.weatherDesc?.[0]?.value ?? "").trim().toLowerCase();
  const curCode = parseInt(cur.weatherCode ?? "0", 10) || 0;

  // wttr j1 = today + 2; serve only the future ones (2 max from this provider)
  const dailyOut: WeatherPayload["daily"] = days.slice(1, 5).map((d) => {
    const midCode =
      parseInt(d.hourly?.[4]?.weatherCode ?? d.hourly?.[0]?.weatherCode ?? "0", 10) || 0;
    const pops = (d.hourly ?? [])
      .map((h) => parseInt(h.chanceofrain ?? "0", 10))
      .filter((n) => Number.isFinite(n));
    const pPct = pops.length ? Math.round(pops.reduce((a, b) => a + b, 0) / pops.length) : undefined;
    return {
      date: d.date ?? "",
      hi: Math.round(parseFloat(d.maxtempC ?? "0")),
      lo: Math.round(parseFloat(d.mintempC ?? "0")),
      code: midCode,
      condition: wttrCondition(midCode),
      ...(pPct !== undefined ? { precipPct: pPct } : {}),
    };
  });

  const gust = parseInt(cur.WindGustKmph ?? "0", 10);
  const dir = parseInt(cur.winddirDegree ?? "0", 10);
  const uv = parseFloat(cur.uvIndex ?? "0");
  const vis = parseInt(cur.visibility ?? "0", 10);
  const precip = parseFloat(cur.precipMM ?? "0");
  const cloud = parseInt(cur.cloudcover ?? "0", 10);
  const astro = days[0]?.astronomy?.[0];

  return {
    place,
    current: {
      tempC: round1(parseFloat(cur.temp_C ?? "0")),
      feelsC: round1(parseFloat(cur.FeelsLikeC ?? "0")),
      humidity: Math.round(parseInt(cur.humidity ?? "0", 10)),
      windKmh: Math.round(parseInt(cur.windspeedKmph ?? "0", 10)),
      pressure: Math.round(parseInt(cur.pressure ?? "0", 10)),
      code: curCode,
      condition: desc || wttrCondition(curCode),
      ...(gust > 0 ? { gustKmh: gust } : {}),
      ...(dir > 0 ? { windDirDeg: dir } : {}),
      ...(precip > 0 ? { precipMm: round1(precip) } : {}),
      ...(cloud > 0 ? { cloudPct: cloud } : {}),
      ...(uv > 0 ? { uvIndex: Math.round(uv * 10) / 10 } : {}),
      ...(vis > 0 ? { visibilityKm: vis } : {}),
    },
    daily: dailyOut,
    sun: astro ? { sunrise: ampmToHHmm(astro.sunrise), sunset: ampmToHHmm(astro.sunset) } : null,
  };
}

function ampmToHHmm(s: string | undefined): string {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec((s ?? "").trim());
  if (!m) return "--:--";
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/* ---------- handler ---------- */

export async function GET(req: NextRequest) {
  try {
    const city = (req.nextUrl.searchParams.get("city") ?? "").trim();
    const latParam = (req.nextUrl.searchParams.get("lat") ?? "").trim();
    const lonParam = (req.nextUrl.searchParams.get("lon") ?? "").trim();
    const placeParam = (req.nextUrl.searchParams.get("place") ?? "").trim();
    let placeName = "";
    let placeRegion = "";
    let lat = Number.NaN;
    let lon = Number.NaN;

    // client already fixed the visitor's ip geolocation — just forecast it
    const latN = parseFloat(latParam);
    const lonN = parseFloat(lonParam);
    if (Number.isFinite(latN) && Number.isFinite(lonN) && Math.abs(latN) <= 90 && Math.abs(lonN) <= 180) {
      const label = placeParam.slice(0, 64) || `${latN.toFixed(2)}, ${lonN.toFixed(2)}`;
      const payload =
        (await fromOpenMeteo(latN, lonN, label)) ??
        (await fromMetNo(latN, lonN, label)) ??
        (await fromWttr(`${latN},${lonN}`, label));
      if (!payload) {
        return NextResponse.json({ ok: false, error: "weather service unavailable" }, { status: 502 });
      }
      return NextResponse.json({ ok: true, ...payload });
    }

    if (city) {
      const geo = await getJson<{ results?: GeoResult[] }>(
        `${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
      );
      const hit = geo?.results?.[0];
      if (hit && typeof hit.latitude === "number" && typeof hit.longitude === "number") {
        placeName = hit.name ?? city;
        placeRegion = hit.country_code ?? hit.admin1 ?? "";
        lat = hit.latitude;
        lon = hit.longitude;
      }
      // geocode miss/failure is not fatal — wttr.in understands raw city names
      const payload =
        (Number.isFinite(lat) && Number.isFinite(lon)
          ? await fromOpenMeteo(lat, lon, [placeName, placeRegion].filter(Boolean).join(", "))
          : null) ??
        (Number.isFinite(lat) && Number.isFinite(lon)
          ? await fromMetNo(lat, lon, [placeName, placeRegion].filter(Boolean).join(", "))
          : null) ??
        (await fromWttr(city));
      if (!payload) {
        return NextResponse.json({ ok: false, error: "city not found" }, { status: 404 });
      }
      return NextResponse.json({ ok: true, ...payload });
    }

    // no city: locate the CALLER. x-forwarded-for first — that is the
    // visitor's real ip when behind the gateway/proxy; ipwho.is with no
    // argument would only see THIS server's egress ip, so it goes last.
    const xff = req.headers.get("x-forwarded-for") ?? "";
    const clientIp = xff
      .split(",")[0]
      ?.trim()
      .replace(/^::ffff:/i, "") ?? "";
    if (clientIp && !isPrivateIp(clientIp)) {
      const viaHeader = await getJson<IpWhoResult>(`${IPWHO_URL}/${encodeURIComponent(clientIp)}`);
      if (
        viaHeader?.success === true &&
        !!viaHeader.city &&
        typeof viaHeader.latitude === "number" &&
        typeof viaHeader.longitude === "number"
      ) {
        placeName = viaHeader.city;
        placeRegion = viaHeader.country_code ?? "";
        lat = viaHeader.latitude;
        lon = viaHeader.longitude;
      }
    }
    if (!Number.isFinite(lat)) {
      // only reached when no trustworthy client ip exists at all (e.g. local
      // dev) — accept the server egress as a last-ditch guess
      const direct = await getJson<IpWhoResult>(IPWHO_URL);
      if (
        direct?.success === true &&
        !!direct.city &&
        typeof direct.latitude === "number" &&
        typeof direct.longitude === "number"
      ) {
        placeName = direct.city;
        placeRegion = direct.country_code ?? "";
        lat = direct.latitude;
        lon = direct.longitude;
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return NextResponse.json(
        { ok: false, error: "could not locate — pass a city: weather <city>" },
        { status: 404 },
      );
    }

    const label = [placeName, placeRegion].filter(Boolean).join(", ") || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    const payload =
      (await fromOpenMeteo(lat, lon, label)) ??
      (await fromMetNo(lat, lon, label)) ??
      (await fromWttr(`${lat},${lon}`, label));
    if (!payload) {
      return NextResponse.json({ ok: false, error: "weather service unavailable" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, ...payload });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "weather lookup failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
