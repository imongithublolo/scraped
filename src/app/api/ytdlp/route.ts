import { NextRequest } from "next/server";

/**
 * GET /api/ytdlp — the NATIVE media engine. yt-dlp runs on this server,
 * the bytes stream straight through, nothing is written to disk.
 *
 *   ?search=<query>&limit=20          → yt-dlp's own ytsearch (flat)
 *   ?info=1&u=<id|url>                → metadata + playable heights
 *   ?u=<id|url>&kind=audio|muxed      → THE STREAM
 *       &h=<height cap>               muxed quality cap (e.g. 720)
 *       &mode=pipe|proxy              pipe: `yt-dlp -o -` stdout, the
 *                                     literal ask — pure pipe, no disk,
 *                                     no Range. proxy: yt-dlp resolves,
 *                                     we fetch the cdn url server-side
 *                                     with Range passthrough (seeking).
 *       &dl=1                         Content-Disposition attachment
 *
 * ZERO third-party APIs: the only parties are this server, yt-dlp, and
 * youtube itself. When youtube's bot wall refuses this server's ip the
 * route answers 502 with the honest reason (and the operator hooks:
 * YTDLP_COOKIES_FILE / YTDLP_EXTRA_ARGS — see lib/murke/ytdlp.ts).
 */

import { cleanErr, pickDirectUrl, pickSelector, spawnPipe, ytdlpInfo, ytdlpSearch } from "@/lib/murke/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const search = (p.get("search") ?? "").trim();
  const u = (p.get("u") ?? "").trim();
  const info = p.get("info") === "1";

  /* ---------------- search: yt-dlp's own ytsearch ---------------- */
  if (search) {
    try {
      const hits = await ytdlpSearch(search, Number(p.get("limit") ?? 20) || 20);
      if (!hits) {
        return Response.json({ ok: false, error: "native engine: search came back empty" }, { status: 502 });
      }
      return Response.json({ ok: true, engine: "yt-dlp", hits });
    } catch (e) {
      return Response.json(
        { ok: false, error: e instanceof Error ? e.message : "native search failed" },
        { status: 502 },
      );
    }
  }

  /* ---------------- info: metadata + heights ---------------- */
  if (info) {
    if (!u) return Response.json({ ok: false, error: "missing u" }, { status: 400 });
    try {
      const d = await ytdlpInfo(u);
      if (!d) return Response.json({ ok: false, error: "native engine: nothing usable for this video" }, { status: 502 });
      return Response.json({ ok: true, engine: "yt-dlp", ...d });
    } catch (e) {
      return Response.json(
        { ok: false, error: e instanceof Error ? e.message : "native resolve failed" },
        { status: 502 },
      );
    }
  }

  /* ---------------- the stream itself ---------------- */
  if (!u) {
    return Response.json(
      { ok: false, error: "pass ?search=, ?info=1&u=, or ?u=&kind=audio|muxed" },
      { status: 400 },
    );
  }
  const kind = p.get("kind") === "audio" ? "audio" : "muxed";
  const height = Number(p.get("h")) || undefined;
  const mode = p.get("mode") === "proxy" ? "proxy" : "pipe";
  const download = p.get("dl") === "1";

  // resolve (cached 90s server-side) — needed for both modes
  let d;
  try {
    d = await ytdlpInfo(u);
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "native resolve failed" },
      { status: 502 },
    );
  }
  if (!d) {
    return Response.json({ ok: false, error: "native engine: nothing usable for this video" }, { status: 502 });
  }
  if (d.isLive) {
    return Response.json({ ok: false, error: "native engine: live streams ride the instance path" }, { status: 502 });
  }

  const safeName = (d.title || "video").replace(/[\r\n"\\]/g, "").slice(0, 80);

  /* ---- proxy mode: server-side fetch of the cdn url, Range honored ---- */
  if (mode === "proxy") {
    const direct = pickDirectUrl(d, kind, height);
    if (!direct) {
      return Response.json(
        { ok: false, error: "no direct cdn url for this quality — try mode=pipe" },
        { status: 502 },
      );
    }
    try {
      const headers: Record<string, string> = {
        // browser-ish client — googlevideo is lenient once the url exists
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        Referer: "https://www.youtube.com/",
      };
      const range = req.headers.get("range");
      if (range) headers.Range = range;
      const upstream = await fetch(direct.url, { headers, cache: "no-store" });
      if (!upstream.ok && upstream.status !== 206) {
        return Response.json(
          { ok: false, error: `cdn answered ${upstream.status} — url may be stale, retry` },
          { status: 502 },
        );
      }
      const out = new Headers();
      for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const v = upstream.headers.get(h);
        if (v) out.set(h, v);
      }
      if (!out.has("Content-Type")) out.set("Content-Type", direct.mime);
      if (!out.has("Accept-Ranges")) out.set("Accept-Ranges", "bytes");
      out.set("Cache-Control", "no-store");
      if (download) out.set("Content-Disposition", `attachment; filename="${safeName}.${kind === "audio" ? "m4a" : "mp4"}"`);
      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch (e) {
      return Response.json(
        { ok: false, error: e instanceof Error ? e.message : "cdn fetch failed" },
        { status: 502 },
      );
    }
  }

  /* ---- pipe mode: yt-dlp -o - straight to the client (the ask) ---- */
  const sel = pickSelector(d, kind, height);
  // merged selectors need a pipe-safe container — mkv streams with a real
  // header (mp4-to-pipe is unseekable and yt-dlp mangles it)
  const spawned = await spawnPipe(u, sel.selector, sel.merge ? ["--merge-output-format", "mkv"] : []);
  if (!spawned) {
    return Response.json(
      { ok: false, error: "yt-dlp unavailable or too many active streams (cap 6)" },
      { status: 503 },
    );
  }
  const { child, stderr } = spawned;

  /* ONE persistent listener from the very first byte — everything buffers
     into `queued` until the Response body exists. The old version read the
     first chunk with .once() (which flips the pipe to flowing), then
     attached a second listener — the header chunk died in that gap and
     browsers got a headless stream. Impossible now. */
  const stdout = child.stdout as NonNullable<typeof child.stdout>;
  const queued: Buffer[] = [];
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let firstResolve: ((b: Buffer | null) => void) | null = null;
  const firstPromise = new Promise<Buffer | null>((r) => (firstResolve = r));
  let gotFirst = false;
  let streamEnded = false;
  let streamErr: Error | null = null;

  const onData = (c: Buffer) => {
    if (!gotFirst) {
      gotFirst = true;
      firstResolve?.(c);
    }
    if (controllerRef) {
      try {
        controllerRef.enqueue(new Uint8Array(c));
      } catch {
        /* closed */
      }
    } else {
      queued.push(c);
    }
  };
  const onEnd = () => {
    streamEnded = true;
    firstResolve?.(null);
    try {
      controllerRef?.close();
    } catch {
      /* already closed */
    }
  };
  const die = () => {
    streamErr = new Error(stderr() || "yt-dlp stream died");
    firstResolve?.(null);
    try {
      controllerRef?.error(streamErr);
    } catch {
      /* already errored */
    }
  };
  stdout.on("data", onData);
  stdout.once("end", onEnd);
  stdout.once("error", die);
  child.once("close", (code) => {
    if (code !== 0 && !streamEnded && !stdout.readableEnded) die();
  });

  // first-chunk gate: a spawn that dies before any byte (bot wall, 404,
  // private video) becomes an honest JSON 502 instead of a silent corpse
  const first = await Promise.race([
    firstPromise,
    new Promise<null>((r) => setTimeout(() => r(null), 20000).unref()),
  ]);
  if (first === null) {
    child.kill("SIGKILL");
    const tail = stderr();
    const msg = tail ? cleanErr(tail) : "yt-dlp produced no bytes for this selector";
    return Response.json({ ok: false, error: msg }, { status: 502 });
  }

  // 60s idle watchdog — a stalled extraction must not pin the child forever
  let idle = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => child.kill("SIGKILL"), 60_000);
  };
  stdout.on("data", () => bump());

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      for (const c of queued.splice(0)) {
        try {
          controller.enqueue(new Uint8Array(c));
        } catch {
          /* closed */
        }
      }
      if (streamEnded) {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      } else if (streamErr) {
        try {
          controller.error(streamErr);
        } catch {
          /* already errored */
        }
      }
    },
    cancel() {
      clearTimeout(idle);
      child.kill("SIGKILL");
    },
  });

  // client navigated away / aborted → stop the download too
  req.signal.addEventListener("abort", () => {
    clearTimeout(idle);
    child.kill("SIGKILL");
  });

  const out = new Headers();
  out.set("Content-Type", sel.mime);
  out.set("Cache-Control", "no-store");
  out.set("X-Native-Engine", "yt-dlp");
  out.set("X-Video-Id", d.videoId);
  if (download) out.set("Content-Disposition", `attachment; filename="${safeName}.${sel.ext}"`);
  return new Response(stream, { status: 200, headers: out });
}
