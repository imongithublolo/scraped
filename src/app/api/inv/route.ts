import { NextRequest } from "next/server";

/**
 * GET /api/inv?op=search&q=...    → { ok, hits: InvHit[] }
 * GET /api/inv?op=resolve&id=...  → { ok, media: InvMedia }
 *
 * Server-side race over the invidious instance pool — the fallback for
 * when the browser's own race comes up empty (proxied browsers, strict
 * extensions, sandboxed egress). fetch4 rides the global IPv4 dispatcher
 * (instrumentation), which un-hangs instances that stall on v6.
 *
 * Same parsers as the client (invParseHits / invParseDetail) — identical
 * shapes on both paths.
 */

import { fetch4 } from "@/lib/http4";
import { INV_INSTANCES, invParseDetail, invParseHits, type InvHit, type InvMedia } from "@/lib/murke/inv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

async function getJson(base: string, path: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const res = await fetch4(`${base}${path}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      timeoutMs,
    });
    if (res.status !== 200) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return null; // challenge pages ship html
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** first-hit-wins race across the whole instance pool */
async function race<T>(
  pathOf: (base: string) => string,
  parse: (data: unknown) => T | null,
  timeoutMs = 9000,
): Promise<T | null> {
  let pending = INV_INSTANCES.length;
  if (pending === 0) return null;
  return new Promise<T | null>((resolve) => {
    let settled = false;
    for (const base of INV_INSTANCES) {
      getJson(base, pathOf(base), timeoutMs)
        .then((data) => {
          if (settled) return;
          const parsed = data !== null ? parse(data) : null;
          if (parsed !== null) {
            settled = true;
            resolve(parsed);
            return;
          }
          if (--pending === 0 && !settled) {
            settled = true;
            resolve(null);
          }
        })
        .catch(() => {
          if (settled) return;
          if (--pending === 0 && !settled) {
            settled = true;
            resolve(null);
          }
        });
    }
  });
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const op = sp.get("op");

  if (op === "search") {
    const q = (sp.get("q") ?? "").trim();
    if (!q) return Response.json({ ok: false, error: "missing q" }, { status: 400 });
    const hits = await race<InvHit[]>(
      () => `/api/v1/search?q=${encodeURIComponent(q)}&type=video&page=1`,
      invParseHits,
    );
    if (!hits) return Response.json({ ok: false, error: "every instance failed" }, { status: 502 });
    return Response.json({ ok: true, hits });
  }

  if (op === "resolve") {
    const id = (sp.get("id") ?? "").trim();
    if (!/^[\w-]{11}$/.test(id)) return Response.json({ ok: false, error: "bad id" }, { status: 400 });
    const media = await race<InvMedia>(
      () => `/api/v1/videos/${encodeURIComponent(id)}`,
      invParseDetail,
      11000,
    );
    if (!media) return Response.json({ ok: false, error: "every instance failed" }, { status: 502 });
    return Response.json({ ok: true, media });
  }

  return Response.json({ ok: false, error: "unknown op" }, { status: 400 });
}
