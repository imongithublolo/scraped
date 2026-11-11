import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/net/info
 *
 * The caller's REAL network identity, resolved server-side:
 *   1. read the visitor ip from x-forwarded-for / x-real-ip (the gateway
 *      and Vercel both set it) and look it up on ipwho.is
 *   2. private / missing header -> bare ipwho.is (server egress — on a
 *      dev box that IS the same network the visitor is on)
 *
 * Returns { ok, ip, isp, org, asn, city, region, country, ts }.
 * 10-minute in-memory cache keyed by the looked-up ip — ipwho.is is free
 * and we intend to keep it that way.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IPWHO_URL = "https://ipwho.is";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

interface IpWhoResult {
  success?: boolean;
  ip?: string;
  city?: string;
  region?: string;
  country?: string;
  connection?: { isp?: string; org?: string; asn?: number };
}

interface NetInfo {
  ok: boolean;
  ip: string | null;
  isp: string | null;
  org: string | null;
  asn: number | null;
  city: string | null;
  region: string | null;
  country: string | null;
  /** whose ip this lookup actually describes */
  scope: "visitor" | "server";
  ts: number;
}

/** long-lived cache — {ip -> info} */
const cache = new Map<string, { at: number; info: NetInfo }>();
const TTL = 10 * 60 * 1000;
const MAX_ENTRIES = 64;

function isPrivateIp(ip: string): boolean {
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|::1$|fc00:|fd00:|fe80:)/i.test(ip)) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export async function GET(req: NextRequest) {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const clientIp =
    xff
      .split(",")[0]
      ?.trim()
      .replace(/^::ffff:/i, "") ||
    req.headers.get("x-real-ip")?.trim() ||
    "";

  const useVisitor = clientIp.length > 0 && !isPrivateIp(clientIp);
  const lookupKey = useVisitor ? clientIp : "__egress__";

  const hit = cache.get(lookupKey);
  if (hit && Date.now() - hit.at < TTL) {
    return NextResponse.json(hit.info, { headers: { "Cache-Control": "no-store" } });
  }

  const url = useVisitor ? `${IPWHO_URL}/${encodeURIComponent(clientIp)}` : IPWHO_URL;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4500);
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ctl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    const raw = (await res.json()) as IpWhoResult;
    const info: NetInfo = {
      ok: raw?.success !== false && !!raw?.ip,
      ip: raw?.ip ?? null,
      isp: raw?.connection?.isp ?? null,
      org: raw?.connection?.org ?? null,
      asn: raw?.connection?.asn ?? null,
      city: raw?.city ?? null,
      region: raw?.region ?? null,
      country: raw?.country ?? null,
      scope: useVisitor ? "visitor" : "server",
      ts: Date.now(),
    };
    if (cache.size > MAX_ENTRIES) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    cache.set(lookupKey, { at: Date.now(), info });
    return NextResponse.json(info, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        ip: null,
        isp: null,
        org: null,
        asn: null,
        city: null,
        region: null,
        country: null,
        scope: useVisitor ? "visitor" : "server",
        ts: Date.now(),
      } satisfies NetInfo,
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
