import { NextRequest } from "next/server";
import { blockedTarget, browserHeaders, fetchEgress, looksLikeBotWall, sameOriginOk } from "@/lib/server/egress";

/**
 * FETCH-FILE — the backend behind "download from the proxy into the file
 * manager" (terminal `fetch <url>`, the browser's download menu, the files
 * app "get from url").
 *
 * POST { url } → the upstream response streams straight back with
 * content-type / content-length preserved and an x-file-name header the
 * client can store. No buffering server-side: the bytes flow egress →
 * this route → the browser, which keeps memory flat on big files.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Best-effort filename: content-disposition first, url basename second. */
function pickFilename(disposition: string | null, url: URL): string {
  const safe = (s: string): string => s.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 160);
  if (disposition) {
    // filename*=UTF-8''... wins over plain filename=
    const star = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
    if (star?.[1]) return safe(decodeURIComponent(star[1]));
    const plain = /filename="?([^";]+)"?/.exec(disposition);
    if (plain?.[1]) return safe(plain[1]);
  }
  const base = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  return safe(base) || url.hostname.replace(/^www\./, "");
}

export async function POST(req: NextRequest) {
  const origin = sameOriginOk(req);
  if (!origin.ok) return Response.json({ ok: false, error: origin.error }, { status: 403 });

  let urlStr = "";
  try {
    const body = (await req.json()) as { url?: unknown };
    urlStr = typeof body.url === "string" ? body.url.trim() : "";
  } catch {
    return Response.json({ ok: false, error: "bad request body" }, { status: 400 });
  }
  if (!/^https?:\/\//i.test(urlStr)) {
    return Response.json({ ok: false, error: "give a full http(s) url" }, { status: 400 });
  }
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return Response.json({ ok: false, error: "bad url" }, { status: 400 });
  }
  if (blockedTarget(url)) {
    return Response.json({ ok: false, error: "blocked target" }, { status: 403 });
  }

  // follow redirects (max 5), carrying a fresh browser-shaped header set
  let current = url;
  try {
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetchEgress(
        current.toString(),
        {
          method: "GET",
          redirect: "manual",
          headers: browserHeaders({ referer: current.origin + "/" }),
          signal: req.signal,
        },
        55_000,
      );

      if (REDIRECTS.has(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) {
          return Response.json({ ok: false, error: `upstream redirect ${res.status} with no location` }, { status: 502 });
        }
        current = new URL(loc, current);
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        // challenge sniff — say "blocked", not "404"
        const ct = res.headers.get("content-type") ?? "";
        let text = "";
        if (ct.includes("text/html")) {
          try {
            text = (await res.text()).slice(0, 400_000);
          } catch {
            /* ignore */
          }
        }
        const hit = looksLikeBotWall(res.status, ct, text);
        return Response.json(
          { ok: false, error: hit ? `upstream bot-wall: ${hit}` : `upstream answered ${res.status}` },
          { status: 502 },
        );
      }

      const mime = res.headers.get("content-type") ?? "application/octet-stream";
      const len = res.headers.get("content-length") ?? "";
      const name = pickFilename(res.headers.get("content-disposition"), current);
      const out = new Headers({
        "Content-Type": mime,
        "Cache-Control": "no-store",
        "x-file-name": encodeURIComponent(name),
      });
      if (len) out.set("Content-Length", len);
      return new Response(res.body as unknown as BodyInit | null, { status: 200, headers: out });
    }
    return Response.json({ ok: false, error: "too many redirects" }, { status: 502 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg.includes("timeout") ? "upstream timed out" : msg }, { status: 502 });
  }
}
