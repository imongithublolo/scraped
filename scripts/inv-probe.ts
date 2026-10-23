/**
 * Probe Invidious instances: search + video resolve + proxied stream bytes.
 * Run: bun scripts/inv-probe.ts
 */
const INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.private.coffee",
  "https://invidious.materialio.us",
  "https://iv.melmac.space",
  "https://invidious.nerdvpn.de",
  "https://yewtu.be",
  "https://invidious.f5.si",
  "https://invidious.jing.rocks",
  "https://invidious.reallyaweso.me",
  "https://invidious.privacyredirect.com",
  "https://iv.duti.dev",
  "https://invidious.protokolla.fi",
  "https://inv.vern.cc",
  "https://invidious.perennialte.ch",
  "https://invidious.dhusch.de",
];

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

async function probe(base: string) {
  const out: string[] = [];
  // 1. search
  try {
    const r = await fetch(`${base}/api/v1/search?q=weeknd&type=video`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) {
      console.log(`${base}  SEARCH ${r.status}`);
      return;
    }
    const j = (await r.json()) as Array<{ videoId?: string; title?: string; lengthSeconds?: number }>;
    const vid = j.find((v) => v.videoId && (v.lengthSeconds ?? 0) > 60);
    out.push(`search ok (${j.length}) first=${vid?.videoId}`);
    if (!vid?.videoId) {
      console.log(`${base}  ${out.join(" ")}  no usable video`);
      return;
    }
    // 2. videos/{id}
    const r2 = await fetch(`${base}/api/v1/videos/${vid.videoId}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!r2.ok) {
      console.log(`${base}  ${out.join(" ")}  VIDEOS ${r2.status}`);
      return;
    }
    const v = (await r2.json()) as {
      title?: string;
      lengthSeconds?: number;
      adaptiveFormats?: Array<{ itag?: string; type?: string; url?: string; bitrate?: string; audioQuality?: string; container?: string; encoding?: string; qualityLabel?: string }>;
      formatStreams?: Array<{ itag?: string; type?: string; url?: string; qualityLabel?: string }>;
    };
    const audio = (v.adaptiveFormats ?? [])
      .filter((f) => (f.type ?? "").startsWith("audio/mp4"))
      .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))[0];
    const muxed = (v.formatStreams ?? []).find((f) => f.itag === "18") ?? (v.formatStreams ?? [])[0];
    out.push(`videos ok len=${v.lengthSeconds} audio=${audio ? "yes" : "NO"} muxed=${muxed ? muxed.itag : "NO"}`);
    // 3. stream bytes check (local=true)
    const pick = audio?.url ?? muxed?.url;
    if (!pick) {
      console.log(`${base}  ${out.join(" ")}  no stream url`);
      return;
    }
    const withLocal = pick.includes("local=") ? pick : `${pick}&local=true`;
    const r3 = await fetch(withLocal, {
      headers: { "User-Agent": UA, Range: "bytes=0-65535" },
      signal: AbortSignal.timeout(15000),
    });
    const buf = await r3.arrayBuffer();
    out.push(`stream ${r3.status} ${buf.byteLength}b ct=${r3.headers.get("content-type")}`);
    console.log(`${base}  ${out.join(" | ")}`);
  } catch (e) {
    console.log(`${base}  ERR ${e instanceof Error ? e.message.slice(0, 80) : e}`);
  }
}

await Promise.all(INSTANCES.map(probe));
