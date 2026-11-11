import { NextRequest } from "next/server";

/**
 * GET /api/stream?u=<encoded media url>
 *
 * Same-origin media pipe for the previews app players (youtube / music,
 * both invidious-fed). The shell ships COOP/COEP headers (the scramjet
 * wasm stack needs cross-origin isolation), which silently blocks
 * cross-origin <audio>/<video> sources that don't opt in with CORP.
 * Streaming through our own origin sidesteps that entirely.
 *
 * The pipe leads every playback chain; the direct instance url rides
 * behind it as the client-side fallback.
 *
 * RANGE EMULATION: some upstreams ignore the Range header and answer 200
 * with the whole body. Browsers NEED 206 semantics to seek. When the
 * upstream ignores a Range request, this route answers 206 itself: it
 * computes the window from the upstream's content-length, discards the
 * skipped bytes server-side and streams exactly the requested slice out.
 *
 * Stores nothing: pure pipe, the upstream body streams straight out.
 */

import { fetch4 } from "@/lib/http4";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** Parse "bytes=N-M" (M optional) — null when absent/malformed. */
function parseRange(range: string | null): { start: number; end: number | null } | null {
  if (!range) return null;
  const m = /^bytes=(\d*)-(\d*)/.exec(range.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    // suffix range: last N bytes — emulate as open-ended (we don't know the
    // size until the upstream answers, so this form only works passthrough)
    return null;
  }
  const start = parseInt(a, 10);
  if (!Number.isFinite(start) || start < 0) return null;
  const end = b === "" ? null : parseInt(b, 10);
  return { start, end: end !== null && Number.isFinite(end) ? end : null };
}

/**
 * Wrap a full upstream body into a byte-window stream [start, end] —
 * everything before `start` is read and discarded, the window streams,
 * then the source is cancelled. This is how seeking survives upstreams
 * that ignore Range.
 */
function sliceStream(
  body: ReadableStream<Uint8Array>,
  start: number,
  length: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let skipped = 0;
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        while (true) {
          if (emitted >= length) {
            ctrl.close();
            void reader.cancel();
            return;
          }
          const { done, value } = await reader.read();
          if (done) {
            if (skipped < start) {
              // upstream ended before the window — surface as an error so the
              // player's fallback chain fires instead of a silent empty body
              ctrl.error(new Error("upstream shorter than the requested range"));
            } else {
              ctrl.close();
            }
            return;
          }
          if (skipped < start) {
            const need = start - skipped;
            if (value.length <= need) {
              skipped += value.length;
              continue;
            }
            const chunk = value.subarray(need);
            skipped = start;
            const out = chunk.length <= length - emitted ? chunk : chunk.subarray(0, length - emitted);
            emitted += out.length;
            ctrl.enqueue(out);
            return;
          }
          const out = value.length <= length - emitted ? value : value.subarray(0, length - emitted);
          emitted += out.length;
          ctrl.enqueue(out);
          return;
        }
      } catch (e) {
        ctrl.error(e instanceof Error ? e : new Error("slice failed"));
      }
    },
    cancel() {
      void reader.cancel();
    },
  });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const u = (params.get("u") ?? "").trim();

  if (!/^https?:\/\//i.test(u)) {
    return Response.json({ ok: false, error: "missing or invalid u" }, { status: 400 });
  }

  const headers: Record<string, string> = { "User-Agent": UA };
  const rawRange = req.headers.get("range");
  const range = parseRange(rawRange);
  /** closed windows can be served exactly; open-ended ones can't be promised */
  const closed = range !== null && range.end !== null;
  if (range) headers.Range = `bytes=${range.start}-${range.end ?? ""}`;

  /** bot-walled upstreams answer "successfully" with a ZERO-length body —
   *  a corpse with a 206. The player would sit silent on a "loaded" src.
   *  Detect it here and treat it like a dead url (honest 502 so the
   *  client's chain walks). */
  const isCorpse = (res: { status: number; headers: Headers }) => {
    if (res.status !== 200 && res.status !== 206) return false;
    const len = res.headers.get("content-length");
    return len === "0" || len === "";
  };

  try {
    const upstream = await fetch4(u, { headers, timeoutMs: 30000 });

    if (isCorpse(upstream)) {
      return Response.json(
        { ok: false, error: "upstream served an empty stream (bot-walled)" },
        { status: 502 },
      );
    }

    /* happy path: the upstream honored Range — pure passthrough with real
       sizes (invidious-proxied googlevideo lives here) */
    if (upstream.status === 206 || !range || upstream.status >= 400) {
      if (!upstream.ok && upstream.status !== 206) {
        return Response.json({ ok: false, error: `upstream ${upstream.status}` }, { status: 502 });
      }
      const out = new Headers();
      const pass = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];
      for (const h of pass) {
        const v = upstream.headers.get(h);
        if (v) out.set(h, v);
      }
      if (!out.has("Accept-Ranges")) out.set("Accept-Ranges", "bytes");
      out.set("Cache-Control", "no-store");
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    /* upstream ignored Range. Play it as a plain progressive 200 — the
       players seek by re-fetching. A plain 200 never lies. Closed windows
       are still served exactly (206 slice) for clients that ask for one. */
    const type = upstream.headers.get("content-type") ?? "video/mp4";
    if (!upstream.body) {
      return Response.json({ ok: false, error: "upstream body gone" }, { status: 502 });
    }

    if (!closed) {
      const out = new Headers();
      out.set("Content-Type", type);
      out.set("Cache-Control", "no-store");
      return new Response(upstream.body, { status: 200, headers: out });
    }

    /* closed window — slice it out for real. The upstream streams from 0;
       we discard to the window, and the declared range carries a `*` total
       because the upstream's own size header is only an estimate. */
    const start = range.start;
    const end = range.end as number;
    const length = end - start + 1;
    if (length <= 0) {
      return new Response(null, { status: 416, headers: { "Content-Range": "bytes */*" } });
    }
    const out = new Headers();
    out.set("Content-Type", type);
    out.set("Content-Range", `bytes ${start}-${end}/*`);
    out.set("Content-Length", String(length));
    out.set("Accept-Ranges", "bytes");
    out.set("Cache-Control", "no-store");
    return new Response(sliceStream(upstream.body, start, length), { status: 206, headers: out });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "stream failed" },
      { status: 502 },
    );
  }
}
