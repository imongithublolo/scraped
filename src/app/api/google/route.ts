import { NextRequest } from "next/server";

/**
 * GET /api/google?q=<query>  →  REAL web results, wherever this runs.
 *
 * The engine chain is ordered by where the code is running, because the
 * walls differ by egress ip:
 *
 *   · LOCAL/CONTAINER — google serves its html serp to us, so the
 *     `googlethis` scraper leads and the platform's hosted web_search
 *     backs it up.
 *   · VERCEL (`process.env.VERCEL`) — google serves datacenter ips a
 *     js-only shell and the platform sdk doesn't exist there, so BING
 *     (which happily serves html to datacenters) leads, with the ddg
 *     html/lite race and mojeek behind it.
 *
 * Whatever answers, the route labels it honestly (`engine: "bing"` etc.)
 * and the results page prints "answered by …" — no lying search box.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export interface GoogleResult {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ON_VERCEL = process.env.VERCEL === "1";

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** fetch a serp with a hard timeout — engines that stall burn alone */
async function grabHtml(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cache: "no-store",
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------- bing ------------------------------- */

/** bing wraps outbound links in /ck/a — the real target rides along
 *  base64-encoded in the u=a1… param. Direct hrefs pass straight through. */
function unwrapBing(href: string): string {
  try {
    const h = href.replace(/&amp;/g, "&");
    if (!/bing\.com\/ck\/a/i.test(h)) return /^https?:\/\//i.test(h) ? h : "";
    const u = new URL(h);
    const enc = u.searchParams.get("u") ?? "";
    if (!enc.startsWith("a1")) return "";
    const b64 = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const dec = atob(pad);
    return /^https?:\/\//i.test(dec) ? dec : "";
  } catch {
    return "";
  }
}

async function bingSearch(query: string): Promise<GoogleResult[]> {
  const html = await grabHtml(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20&setlang=en`, 7000);
  if (!html) return [];
  const out: GoogleResult[] = [];
  const blockRe = /<li[^>]+class="[^"]*b_algo[^"]*"[\s\S]*?<\/li>/g;
  const blocks = html.match(blockRe) ?? [];
  for (const b of blocks) {
    const a = /<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    const url = unwrapBing(a[1]);
    const title = stripTags(a[2]);
    if (!title || !url) continue;
    if (out.some((x) => x.url === url)) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(b);
    out.push({ title, url, snippet: p ? stripTags(p[1]) : "" });
    if (out.length >= 20) break;
  }
  return out;
}

/* ------------------------------- mojeek ------------------------------ */

async function mojeekSearch(query: string): Promise<GoogleResult[]> {
  const html = await grabHtml(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}`, 6000);
  if (!html) return [];
  const out: GoogleResult[] = [];
  // result titles live in <h2><a href="…">…</a></h2> (class="title" when
  // present), snippets in the <p class="s"> that follows
  const re = /<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 20) {
    const url = m[1].replace(/&amp;/g, "&");
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    if (/mojeek\.com/i.test(url)) continue;
    if (out.some((x) => x.url === url)) continue;
    const tail = html.slice(re.lastIndex, re.lastIndex + 600);
    const p = /<p[^>]*class="[^"]*s[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(tail);
    out.push({ title, url, snippet: p ? stripTags(p[1]) : "" });
  }
  return out;
}

/* --------------------------- duckduckgo ------------------------------ */

/** decode the /l/?uddg=<encoded> redirect wrapper into the real target */
function unwrapDdg(href: string): string {
  try {
    if (href.startsWith("//")) href = "https:" + href;
    const u = new URL(href.replace(/&amp;/g, "&"), "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return u.toString();
  } catch {
    return href;
  }
}

function parseDdgHtml(html: string): GoogleResult[] {
  const out: GoogleResult[] = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html))) snippets.push(stripTags(sm[1]));
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(html)) && out.length < 30) {
    const url = unwrapDdg(m[1]);
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    if (out.some((r) => r.url === url)) continue;
    out.push({ title, url, snippet: snippets[i] ?? "" });
    i++;
  }
  return out;
}

function parseDdgLite(html: string): GoogleResult[] {
  const out: GoogleResult[] = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html))) snippets.push(stripTags(sm[1]));
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(html)) && out.length < 30) {
    const url = unwrapDdg(m[1]);
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    if (out.some((r) => r.url === url)) continue;
    out.push({ title, url, snippet: snippets[i] ?? "" });
    i++;
  }
  return out;
}

/** the html + lite endpoints raced — a walled endpoint burns alone */
async function ddgSearch(query: string): Promise<GoogleResult[]> {
  const [htmlHits, liteHits] = await Promise.all([
    grabHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`, 6000).then(parseDdgHtml),
    grabHtml(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=wt-wt`, 6000).then(parseDdgLite),
  ]);
  return htmlHits.length > 0 ? htmlHits : liteHits;
}

/* ----------------------------- googlethis ---------------------------- */

/** google's own serp — works wherever google serves html (not vercel) */
async function googleThis(query: string): Promise<GoogleResult[]> {
  try {
    const googlethis = (await import("googlethis")).default;
    const res = await googlethis.search(query, {
      safe: false,
      parse_ads: false,
      axios_config: {
        timeout: 8000,
        headers: {
          "User-Agent": UA,
          "Accept-Language": "en-GB,en;q=0.9",
        },
      },
    });
    const out: GoogleResult[] = [];
    for (const r of res?.results ?? []) {
      if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url)) continue;
      if (!r.title?.trim()) continue;
      if (out.some((x) => x.url === r.url)) continue;
      out.push({ title: r.title, url: r.url, snippet: r.description ?? "" });
      if (out.length >= 20) break;
    }
    return out;
  } catch {
    return [];
  }
}

/* --------------------------- platform sdk ---------------------------- */

/** the hosted web_search — exists only inside the platform container;
 *  hard-capped so a dead sdk can't stall the chain (vercel has no sdk) */
async function platformSearch(query: string): Promise<GoogleResult[]> {
  try {
    const work = (async () => {
      const { default: ZAI } = await import("z-ai-web-dev-sdk");
      const zai = await ZAI.create();
      return (await zai.functions.invoke("web_search", { query, num: 20 })) as Array<{
        url?: string;
        name?: string;
        snippet?: string;
      }>;
    })();
    const cap = new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000));
    const res = (await Promise.race([work, cap])) ?? [];
    const out: GoogleResult[] = [];
    for (const r of res) {
      if (typeof r.url !== "string" || typeof r.name !== "string" || !r.name.trim()) continue;
      if (out.some((x) => x.url === r.url)) continue;
      out.push({ title: r.name, url: r.url, snippet: typeof r.snippet === "string" ? r.snippet : "" });
      if (out.length >= 20) break;
    }
    return out;
  } catch {
    return [];
  }
}

/* ------------------------------- cache ------------------------------- */

const TTL = 120_000;
const cache = new Map<string, { at: number; results: GoogleResult[]; engine: string }>();

/* ------------------------------- route ------------------------------- */

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) {
    return Response.json({ ok: false, error: "missing q" }, { status: 400 });
  }

  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < TTL) {
    return Response.json({ ok: true, engine: hit.engine, results: hit.results, cached: true });
  }

  /* the chain — ordered by the walls of the ip this code runs on.
     Each engine is tried until one returns real results. On vercel the
     google scrape and the platform sdk are dead weight (js-shell wall /
     no platform credentials) — dropping them keeps the all-refused
     worst case well inside maxDuration. */
  const chain: Array<{ engine: string; run: (q: string) => Promise<GoogleResult[]> }> = ON_VERCEL
    ? [
        { engine: "bing", run: bingSearch },
        { engine: "duckduckgo", run: ddgSearch },
        { engine: "mojeek", run: mojeekSearch },
      ]
    : [
        { engine: "google", run: googleThis },
        { engine: "fallback", run: platformSearch },
        { engine: "bing", run: bingSearch },
        { engine: "duckduckgo", run: ddgSearch },
        { engine: "mojeek", run: mojeekSearch },
      ];

  for (const step of chain) {
    let results: GoogleResult[] = [];
    try {
      results = await step.run(q);
    } catch {
      results = [];
    }
    if (results.length > 0) {
      cache.set(q, { at: Date.now(), results, engine: step.engine });
      if (cache.size > 200) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) cache.delete(oldest[0]);
      }
      return Response.json({ ok: true, engine: step.engine, results });
    }
  }

  return Response.json(
    { ok: false, error: "every search engine refused to answer" },
    { status: 502 },
  );
}
