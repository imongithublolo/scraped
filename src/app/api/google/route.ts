import { NextRequest } from "next/server";

/**
 * GET /api/google?q=<query>  →  REAL Google results.
 *
 * Primary engine: the `googlethis` scraper library (no api key, no
 * third party) — it pulls google's own html SERP exactly as a browser
 * receives it. When google serves its JS-only shell instead (its
 * datacenter-ip wall), we fall back to the platform's hosted web_search
 * and LABEL it honestly (`engine: "fallback"`) — the results page shows
 * which engine actually answered. This is the engine behind frost:// —
 * the Frost search, powered by google.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export interface GoogleResult {
  title: string;
  url: string;
  snippet: string;
}

/** googlethis — real google scrape (works wherever google serves html) */
async function googleThis(query: string): Promise<GoogleResult[]> {
  try {
    const googlethis = (await import("googlethis")).default;
    const res = await googlethis.search(query, {
      safe: false,
      parse_ads: false,
      axios_config: {
        timeout: 8000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
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

/** the platform's hosted web search — the honest fallback when google's
 *  js-shell wall bites this server's ip. Same shape as a google hit. */
async function platformSearch(query: string): Promise<GoogleResult[]> {
  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const res = (await zai.functions.invoke("web_search", { query, num: 20 })) as Array<{
      url?: string;
      name?: string;
      snippet?: string;
    }>;
    const out: GoogleResult[] = [];
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

  /* 1. the real thing — google's own serp via googlethis */
  let results = await googleThis(q);
  let engine = "google";
  /* 2. the honest fallback — google's js-only wall on datacenter ips */
  if (results.length === 0) {
    results = await platformSearch(q);
    if (results.length > 0) engine = "fallback";
  }

  if (results.length === 0) {
    return Response.json(
      { ok: false, error: "google did not answer and the fallback failed too" },
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
