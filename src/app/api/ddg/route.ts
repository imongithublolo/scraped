import { NextRequest } from "next/server";

/**
 * GET /api/ddg?q=<query>  →  REAL web results, DuckDuckGo first.
 *
 * Primary path: the SERVER scrapes DDG's own html/lite endpoints — no
 * third parties, exactly the results duckduckgo.com serves. Reality
 * check: DDG anomaly-walls datacenter ips (202 + challenge page), so when
 * the wall bites we fall back to the platform's hosted web_search and
 * LABEL it honestly (`engine: "fallback"`) — the browser shows which
 * engine actually answered. No more lying search box either way.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export interface DdgResult {
  title: string;
  url: string;
  snippet: string;
}

/* ------------------------------ parsing ------------------------------ */

/** decode the /l/?uddg=<encoded> redirect wrapper into the real target */
function unwrapDdg(href: string): string {
  try {
    if (href.startsWith("//")) href = "https:" + href;
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return u.toString();
  } catch {
    return href;
  }
}

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

function parseHtmlEndpoint(html: string): DdgResult[] {
  const out: DdgResult[] = [];
  // organic links + their snippets, in document order
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

function parseLiteEndpoint(html: string): DdgResult[] {
  const out: DdgResult[] = [];
  // lite table: <a rel="nofollow" href="…uddg=…" class='result-link'>title</a>
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

/* ------------------------------- fetch ------------------------------- */

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function fetchDdg(endpoint: string, query: string, timeoutMs = 4500): Promise<DdgResult[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}?q=${encodeURIComponent(query)}&kl=wt-wt`, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cache: "no-store",
      signal: ctrl.signal,
    });
    // 202 = the anomaly wall dressed as a page — treat as empty
    if (res.status === 202 || !res.ok) return [];
    const html = await res.text();
    return endpoint.includes("/html") ? parseHtmlEndpoint(html) : parseLiteEndpoint(html);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** the platform's hosted web search — the honest fallback when DDG walls
 *  this server's ip. Zero config, same shape as a DDG hit. */
async function platformSearch(query: string): Promise<DdgResult[]> {
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const res = (await zai.functions.invoke("web_search", { query, num: 20 })) as Array<{
      url?: string;
      name?: string;
      snippet?: string;
    }>;
    const out: DdgResult[] = [];
    for (const r of res ?? []) {
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
const cache = new Map<string, { at: number; results: DdgResult[]; engine: string }>();

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

  /* 1. the real thing — ddg's own endpoints from this server, raced in
        parallel (a walled endpoint burns its timeout alone) */
  const [htmlHits, liteHits] = await Promise.all([
    fetchDdg("https://html.duckduckgo.com/html/", q),
    fetchDdg("https://lite.duckduckgo.com/lite/", q),
  ]);
  let results = htmlHits.length > 0 ? htmlHits : liteHits;
  let engine = "duckduckgo";
  /* 2. the honest fallback — ddg anomaly-walls datacenter ips */
  if (results.length === 0) {
    results = await platformSearch(q);
    if (results.length > 0) engine = "fallback";
  }

  if (results.length === 0) {
    return Response.json(
      { ok: false, error: "no engine answered — ddg is walled from this server and the fallback failed too" },
      { status: 502 },
    );
  }
  cache.set(q, { at: Date.now(), results, engine });
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return Response.json({ ok: true, engine, results });
}
