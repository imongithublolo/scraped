import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/news?gl=<CC>&q=<topic>
 *
 * Geo-based headlines for the terminal's `news` command. The browser has
 * usually already fixed the visitor's country client-side (ipwho.is, the
 * same fix weather uses) and passes it as `gl`; without it the route falls
 * back to x-forwarded-for → ipwho.is, and finally the en-US world edition.
 *
 * Source: Google News RSS (keyless). `q` switches to a topic search in the
 * same edition.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** Google News local editions we know exist: cc → [hl, language for ceid]. */
const EDITIONS: Record<string, [string, string]> = {
  US: ["en-US", "en"], GB: ["en-GB", "en"], CA: ["en-CA", "en"], AU: ["en-AU", "en"],
  NZ: ["en-NZ", "en"], IE: ["en-IE", "en"], IN: ["en-IN", "en"], ZA: ["en-ZA", "en"],
  NG: ["en-NG", "en"], KE: ["en-KE", "en"], PH: ["en-PH", "en"], SG: ["en-SG", "en"],
  ES: ["es", "es"], MX: ["es-419", "es"], AR: ["es-419", "es"], CL: ["es-419", "es"],
  CO: ["es-419", "es"], PE: ["es-419", "es"], VE: ["es-419", "es"], UY: ["es-419", "es"],
  EC: ["es-419", "es"], CR: ["es-419", "es"], PA: ["es-419", "es"], DO: ["es-419", "es"],
  GT: ["es-419", "es"], CU: ["es-419", "es"], BO: ["es-419", "es"], PY: ["es-419", "es"],
  DE: ["de", "de"], AT: ["de-AT", "de"], CH: ["de-CH", "de"], LI: ["de", "de"],
  FR: ["fr", "fr"], BE: ["fr-BE", "fr"], LU: ["fr", "fr"], MC: ["fr", "fr"],
  IT: ["it", "it"], PT: ["pt-PT", "pt"], BR: ["pt-BR", "pt"], AO: ["pt-PT", "pt"],
  MZ: ["pt-PT", "pt"], NL: ["nl", "nl"], PL: ["pl", "pl"], SE: ["sv", "sv"],
  NO: ["no", "no"], DK: ["da", "da"], FI: ["fi", "fi"], IS: ["is", "is"],
  RU: ["ru", "ru"], BY: ["ru", "ru"], KZ: ["ru", "ru"], UA: ["uk", "uk"],
  TR: ["tr", "tr"], GR: ["el", "el"], RO: ["ro", "ro"], HU: ["hu", "hu"],
  CZ: ["cs", "cs"], SK: ["sk", "sk"], BG: ["bg", "bg"], HR: ["hr", "hr"],
  RS: ["sr", "sr"], SI: ["sl", "sl"], LT: ["lt", "lt"], LV: ["lv", "lv"],
  EE: ["et", "et"], JP: ["ja", "ja"], KR: ["ko", "ko"], CN: ["zh-Hans", "zh-Hans"],
  TW: ["zh-TW", "zh-TW"], HK: ["zh-HK", "zh-HK"], VN: ["vi", "vi"], TH: ["th", "th"],
  ID: ["id", "id"], MY: ["ms", "ms"], IL: ["he", "he"], SA: ["ar", "ar"],
  AE: ["ar", "ar"], EG: ["ar", "ar"], MA: ["ar", "ar"], DZ: ["ar", "ar"],
  TN: ["ar", "ar"], PK: ["en-PK", "en"], BD: ["bn", "bn"],
};

interface NewsItem {
  title: string;
  url: string;
  source: string;
  date: string;
}

interface NewsPayload {
  ok: true;
  country: string;
  place: string;
  edition: string;
  localized: boolean;
  query: string;
  items: NewsItem[];
}

/** Decode the handful of entities google ships in titles. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => {
      try {
        return String.fromCodePoint(parseInt(d, 10));
      } catch {
        return "";
      }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function extractText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  /* CDATA or escaped — either way this yields the text */
  const raw = m?.[1] ?? "";
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(raw.trim());
  return decodeEntities((cdata ? cdata[1] : raw).trim());
}

function parseRss(xml: string, limit: number): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const b of blocks) {
    const end = b.indexOf("</item>");
    const block = end >= 0 ? b.slice(0, end) : b;
    const title = extractText(block, "title");
    const url = extractText(block, "link");
    const source = extractText(block, "source");
    const date = extractText(block, "pubDate");
    if (!title || !/^https?:\/\//i.test(url)) continue;
    items.push({ title, url, source, date });
    if (items.length >= limit) break;
  }
  return items;
}

function isPrivateIp(ip: string): boolean {
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip === "::1" || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) return true;
  return false;
}

async function detectCountry(req: NextRequest): Promise<{ cc: string; place: string }> {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const clientIp = xff.split(",")[0]?.trim().replace(/^::ffff:/i, "") ?? "";
  if (clientIp && !isPrivateIp(clientIp)) {
    try {
      const res = await fetch(`https://ipwho.is/${encodeURIComponent(clientIp)}`, {
        signal: AbortSignal.timeout(6000),
        cache: "no-store",
        headers: { "User-Agent": UA },
      });
      if (res.ok) {
        const d = (await res.json()) as { success?: boolean; country_code?: string; city?: string };
        if (d.success === true && /^[a-z]{2}$/i.test(d.country_code ?? "")) {
          return { cc: (d.country_code ?? "").toUpperCase(), place: d.city ?? "" };
        }
      }
    } catch {
      /* fall through */
    }
  }
  return { cc: "", place: "" };
}

export async function GET(req: NextRequest) {
  try {
    const glParam = (req.nextUrl.searchParams.get("gl") ?? "").trim().toUpperCase();
    const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 120);

    let cc = /^[A-Z]{2}$/.test(glParam) ? glParam : "";
    let place = "";
    if (!cc) {
      const det = await detectCountry(req);
      cc = det.cc;
      place = det.place;
    }

    const edition = EDITIONS[cc];
    /* unknown country → world edition in english, honestly labeled */
    const gl = edition ? cc : "US";
    const hl = edition ? edition[0] : "en-US";
    const lang = edition ? edition[1] : "en";
    const localized = Boolean(edition) && cc !== "US";

    const rssUrl = q
      ? `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${gl}:${lang}`
      : `https://news.google.com/rss?hl=${hl}&gl=${gl}&ceid=${gl}:${lang}`;

    const res = await fetch(rssUrl, {
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `news feed unreachable (${res.status})` }, { status: 502 });
    }
    const xml = await res.text();
    const items = parseRss(xml, 12);
    if (items.length === 0) {
      return NextResponse.json({ ok: false, error: "no headlines came back" }, { status: 502 });
    }

    const payload: NewsPayload = {
      ok: true,
      country: cc || "US",
      place,
      edition: `${gl}:${hl}`,
      localized,
      query: q,
      items,
    };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, max-age=120" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "news lookup failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
