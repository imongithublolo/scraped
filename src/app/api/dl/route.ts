import { NextRequest, NextResponse } from "next/server";
import { fetch4 } from "@/lib/http4";
import { randomUUID } from "node:crypto";

/**
 * Session downloads — RAM-only media cache keyed to a browser session id.
 *
 * POST { url, sid } -> server fetches the media (80MB cap), keeps it in a
 *                      module-level Map, answers { ok, id, name, type, size }.
 * GET  ?sid=&id=    -> serves bytes (Accept-Ranges + 206 slicing for seeking).
 * GET  ...&meta=1   -> { ok, name, type, size }, no body.
 *
 * Nothing ever touches disk or db. Lazy sweep each request: items older
 * than 45min dropped, 160MB per sid enforced evicting oldest first.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DlItem {
  id: string;
  name: string;
  type: string;
  bytes: Buffer;
  ts: number;
}

/** sid -> (id -> item). Lives as long as the process does. */
const sessions = new Map<string, Map<string, DlItem>>();

const MAX_FILE_BYTES = 80 * 1024 * 1024; // hard cap per download
const MAX_SID_BYTES = 160 * 1024 * 1024; // cap per session
const ITEM_TTL_MS = 45 * 60 * 1000; // 45min
const FETCH_TIMEOUT_MS = 90_000;

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const EXT_BY_TYPE: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "weba",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function extFor(type: string): string {
  const mapped = EXT_BY_TYPE[type];
  if (mapped) return mapped;
  const sub = type.split("/")[1]?.replace(/[^a-z0-9]/gi, "");
  return sub || "bin";
}

function pickType(rawContentType: string): string {
  return rawContentType.split(";")[0].trim().toLowerCase();
}

function nameFromUrl(u: URL, type: string): string {
  const seg = u.pathname.split("/").filter(Boolean).pop();
  if (seg) {
    const base = decodeURIComponent(seg)
      .replace(/[^\w.\- ()[\]]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120);
    if (base) return base;
  }
  return `media-${Date.now()}.${extFor(type)}`;
}

/** Drop stale items, then enforce the per-session byte cap (evict oldest). */
function sweep(): void {
  const now = Date.now();
  for (const [sid, bucket] of sessions) {
    let total = 0;
    for (const [id, item] of bucket) {
      if (now - item.ts > ITEM_TTL_MS) bucket.delete(id);
      else total += item.bytes.byteLength;
    }
    if (bucket.size === 0) {
      sessions.delete(sid);
      continue;
    }
    if (total > MAX_SID_BYTES) {
      const oldest = [...bucket.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (const [id, item] of oldest) {
        if (total <= MAX_SID_BYTES) break;
        bucket.delete(id);
        total -= item.bytes.byteLength;
      }
      if (bucket.size === 0) sessions.delete(sid);
    }
  }
}

class TooLargeError extends Error {}

/** Streams the body into memory while guarding the 80MB cap mid-read. */
async function readCapped(res: Response): Promise<Buffer> {
  const body = res.body;
  if (!body) throw new Error("empty response from upstream");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_FILE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError("too large — 80MB max per file");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function POST(req: NextRequest) {
  sweep();
  try {
    const raw: unknown = await req.json().catch(() => null);
    const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const sid = typeof body.sid === "string" ? body.sid.trim().slice(0, 128) : "";
    // optional friendly name (yt titles etc) — sanitized when present
    const customName =
      typeof body.name === "string" ? body.name.replace(/[/\\"\u0000-\u001F]/g, "_").trim().slice(0, 120) : "";
    if (!url || !sid) {
      return NextResponse.json({ ok: false, error: "need url + sid" }, { status: 400 });
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return NextResponse.json({ ok: false, error: "invalid url" }, { status: 400 });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return NextResponse.json({ ok: false, error: "only http/https urls" }, { status: 400 });
    }

    const res = await fetch4(parsed.toString(), {
      headers: { "User-Agent": BROWSER_UA, Accept: "*/*" },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `upstream responded ${res.status}` }, { status: 502 });
    }

    const type = pickType(res.headers.get("content-type") ?? "");
    const acceptable =
      type.startsWith("audio/") || type.startsWith("video/") || type.startsWith("image/") || type === "application/octet-stream";
    if (!acceptable) {
      return NextResponse.json(
        { ok: false, error: "not a direct media url — paste a link that ends in .mp3/.mp4/etc" },
        { status: 415 },
      );
    }

    const lenHeader = res.headers.get("content-length");
    const len = lenHeader ? Number.parseInt(lenHeader, 10) : Number.NaN;
    if (Number.isFinite(len) && len > MAX_FILE_BYTES) {
      return NextResponse.json({ ok: false, error: "too large — 80MB max per file" }, { status: 413 });
    }

    let bytes: Buffer;
    try {
      bytes = await readCapped(res);
    } catch (e) {
      if (e instanceof TooLargeError) {
        return NextResponse.json({ ok: false, error: e.message }, { status: 413 });
      }
      throw e;
    }
    if (bytes.byteLength === 0) {
      return NextResponse.json({ ok: false, error: "empty response from upstream" }, { status: 502 });
    }

    const item: DlItem = {
      id: randomUUID(),
      name: customName || nameFromUrl(parsed, type),
      type: type || "application/octet-stream",
      bytes,
      ts: Date.now(),
    };
    let bucket = sessions.get(sid);
    if (!bucket) {
      bucket = new Map();
      sessions.set(sid, bucket);
    }
    bucket.set(item.id, item);
    sweep(); // enforce session cap right after adding

    return NextResponse.json({ ok: true, id: item.id, name: item.name, type: item.type, size: item.bytes.byteLength });
  } catch (e) {
    const msg =
      e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
        ? "upstream timed out (30s)"
        : e instanceof Error
          ? e.message
          : "download failed";
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  sweep();
  const sp = req.nextUrl.searchParams;
  const sid = (sp.get("sid") ?? "").slice(0, 128);
  const id = sp.get("id") ?? "";
  const item = sid ? sessions.get(sid)?.get(id) : undefined;
  if (!item) {
    return NextResponse.json({ ok: false, error: "unknown id" }, { status: 404 });
  }
  const size = item.bytes.byteLength;

  if (sp.get("meta") === "1") {
    return NextResponse.json({ ok: true, name: item.name, type: item.type, size });
  }

  const baseHeaders: Record<string, string> = {
    "Content-Type": item.type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Disposition": `inline; filename="${item.name.replace(/["\\]/g, "_")}"`,
  };

  const rangeHeader = req.headers.get("range");
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    const rangeInvalid = new NextResponse(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
    if (!m || (m[1] === "" && m[2] === "")) return rangeInvalid;

    let start: number;
    let end: number;
    if (m[1] === "") {
      const n = Number.parseInt(m[2], 10);
      if (!Number.isFinite(n) || n <= 0) return rangeInvalid;
      start = Math.max(0, size - n); // suffix range: last N bytes
      end = size - 1;
    } else {
      start = Number.parseInt(m[1], 10);
      end = m[2] === "" ? size - 1 : Math.min(Number.parseInt(m[2], 10), size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return rangeInvalid;
    }

    const slice = item.bytes.subarray(start, end + 1);
    return new NextResponse(new Uint8Array(slice), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(slice.byteLength),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
    });
  }

  return new NextResponse(new Uint8Array(item.bytes), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}
