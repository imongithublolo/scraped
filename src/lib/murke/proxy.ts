import type { ProxyEngine, ProxyFrameHandle, WispStatus } from "./contracts";
import { LS } from "./contracts";
import { unlockProxyWorker } from "./auth";

/**
 * Scramjet client wiring — rebuilt clean.
 *
 * Boot order (matches the official scramjet-app flow):
 *   1. load /scram/scramjet.all.js  → window.$scramjetLoadController
 *   2. load /baremux/index.js       → window.BareMux
 *   3. register /sw.js, wait until a worker CONTROLS the page
 *   4. ScramjetController.init() (bounded — a wedged IDB must not hang)
 *   5. BareMuxConnection.setTransport(<winner>)
 *   6. controller.createFrame().go(url)
 *
 * TWO transports, probed in order, first real win arms:
 *
 *   relay  /httpx/index.mjs   every proxied request POSTs to the same-origin
 *                             /api/relay route (server-side egress, works
 *                             wherever THIS app runs — must EARN its slot
 *                             with a real end-to-end forward, not just a
 *                             health check)
 *   wisp   /epoxy/index.mjs   full wisp websocket transport (epoxy-tls).
 *                             The proven path on static/serverless deploys:
 *                             the browser tunnels to a wisp server whose
 *                             egress isn't a bot-walled datacenter range.
 *
 * `proxy wisp <url>` pins any wisp:// ws:// wss:// or http(s) relay url;
 * `proxy wisp clear` returns to the auto-probe.
 */

interface ScramjetFrameLike extends EventTarget {
  frame: HTMLIFrameElement;
  go(url: string | URL): void;
  back(): void;
  forward(): void;
  reload(): void;
  get url(): URL;
}

interface ScramjetControllerLike {
  init(): Promise<void>;
  createFrame(frame?: HTMLIFrameElement): ScramjetFrameLike;
  encodeUrl(url: string | URL): string;
  /** present on current scramjet builds — used by the popup capture */
  decodeUrl?(url: string | URL): string | URL;
}

interface BareMuxConnectionLike {
  getTransport(): Promise<string | undefined>;
  setTransport(path: string, args?: unknown[]): Promise<void>;
}

declare global {
  interface Window {
    $scramjetLoadController?: () => { ScramjetController: new (cfg: unknown) => ScramjetControllerLike };
    BareMux?: { BareMuxConnection: new (workerPath: string) => BareMuxConnectionLike };
    __DAEMON_CONFIG__?: { relay?: string; wisp?: string };
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "1") return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(`failed to load ${src}`)));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve();
    };
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

const SCRAM_DB = "$scramjet";
const SCRAMJET_STORES = ["config", "cookies", "redirectTrackers", "referrerPolicies", "publicSuffixList"];
const ASSET_V = "v=20261022a";
let idbPatched = false;

/** The public wisp server that backs the proxy when nothing else answers. */
const PUBLIC_WISP = "wisp://wisp.mercurywork.shop/";

/**
 * Normalize any wisp-flavored url into a WebSocket url the browser can open.
 * On an https page an insecure ws:// is mixed content — upgrade to wss://.
 */
export function toWsUrl(raw: string): string {
  const u = raw.trim();
  let out: string;
  if (/^wisps:\/\//i.test(u)) out = "wss://" + u.slice(8);
  else if (/^wisp:\/\//i.test(u)) out = "ws://" + u.slice(7);
  else if (/^wss?:\/\//i.test(u)) out = u;
  else if (/^https:\/\//i.test(u)) out = "wss://" + u.slice(8);
  else if (/^http:\/\//i.test(u)) out = "ws://" + u.slice(7);
  else out = "wss://" + u.replace(/^\/+/, "");
  if (typeof location !== "undefined" && location.protocol === "https:" && out.startsWith("ws://")) {
    out = "wss://" + out.slice(5);
  }
  return out;
}

/** True when the string points at a wisp websocket server. */
export function isWispUrl(raw: string): boolean {
  return /^(wisp|wisps|wss?|https?):\/\//i.test(raw.trim());
}

/**
 * Patch indexedDB.open BEFORE scramjet loads: inject a store-creating
 * upgrade handler into every "$scramjet" open. Scramjet's own helper opens
 * the DB with no upgrade handler — if that wins the race against the
 * controller's schema-open, the DB is born at v1 with zero stores and
 * every controller init fails forever. (PROTOTYPE-level: scramjet's
 * helpers reach IDBFactory.prototype.open via .call() and bypass instance
 * overrides entirely.)
 */
function patchScramjetIdb(): void {
  if (idbPatched || typeof indexedDB === "undefined") return;
  idbPatched = true;
  const proto = IDBFactory.prototype as unknown as {
    open: (name: string, version?: number) => IDBOpenDBRequest;
  };
  const origOpen = proto.open;
  proto.open = function (this: IDBFactory, name: string, version?: number) {
    const rq = origOpen.call(this, name, version);
    if (name === SCRAM_DB) {
      rq.addEventListener("upgradeneeded", () => {
        const db = rq.result;
        for (const store of SCRAMJET_STORES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      });
    }
    return rq;
  };
}

/** One transport candidate the auto-probe can arm. */
type Candidate = { kind: "relay"; url: string } | { kind: "wisp"; url: string };

export class ScramjetProxy implements ProxyEngine {
  private controller: ScramjetControllerLike | null = null;
  private connection: BareMuxConnectionLike | null = null;
  private initPromise: Promise<{ ok: boolean; error?: string }> | null = null;
  /** the transport that last passed its probe (kind + url for the UI) */
  private cached: { candidate: Candidate; at: number } | null = null;

  getWispOverride(): string | null {
    try {
      return localStorage.getItem(LS.wisp);
    } catch {
      return null;
    }
  }

  /**
   * Decode a scramjet-encoded url (an /scramjet/… path a popup tried to
   * escape with) back to the original address. Scramjet v1's own
   * decodeUrl does not roundtrip its percent-encoding form, so decode
   * directly: the payload after the prefix IS encodeURIComponent of the
   * target. Best-effort — anything that doesn't decode comes back as-is.
   */
  decode(url: string): string {
    try {
      const c = this.controller as ScramjetControllerLike | null;
      const viaLib = c?.decodeUrl?.(url);
      const libStr = viaLib ? String(viaLib) : "";
      if (/^https?:\/\//i.test(libStr)) return libStr;
    } catch {
      /* fall through to the manual decode */
    }
    const marker = "/scramjet/";
    const idx = url.lastIndexOf(marker);
    const payload = idx >= 0 ? url.slice(idx + marker.length) : url;
    try {
      return decodeURIComponent(payload);
    } catch {
      return payload;
    }
  }

  setWispOverride(url: string | null): void {
    try {
      if (url) localStorage.setItem(LS.wisp, url);
      else localStorage.removeItem(LS.wisp);
    } catch {
      /* ignore */
    }
    this.cached = null;
  }

  /** The pinned override, classified. */
  private overrideCandidate(): Candidate | null {
    const v = this.getWispOverride();
    if (!v || !isWispUrl(v)) return null;
    return /^https?:\/\//i.test(v) ? { kind: "relay", url: v } : { kind: "wisp", url: v };
  }

  /**
   * Every candidate worth probing, override first. Order matters:
   *  - on localhost the same-origin relay goes first (instant there)
   *  - on a real deploy the public wisp goes first (real egress beats
   *    serverless IP ranges that sites bot-wall), relay as fallback
   */
  private candidates(): Candidate[] {
    const out: Candidate[] = [];
    const push = (c: Candidate | null | undefined) => {
      if (c && !out.some((o) => o.kind === c.kind && o.url === c.url)) out.push(c);
    };
    push(this.overrideCandidate());
    try {
      const w = window.__DAEMON_CONFIG__?.wisp;
      if (w) push({ kind: "wisp", url: w });
      const r = window.__DAEMON_CONFIG__?.relay;
      if (r) push({ kind: "relay", url: r });
    } catch {
      /* ignore */
    }
    let local = false;
    try {
      local = /^(localhost|127\.0\.0\.1|\[::1\]|.*\.localhost)$/i.test(location.hostname);
    } catch {
      /* no location (ssr) */
    }
    if (local) {
      // sandbox: same-origin relay is instant, gateway wisp is reachable
      push({ kind: "relay", url: "/api/relay" });
      try {
        push({ kind: "wisp", url: `wisp://${location.host}/?XTransformPort=3031` });
      } catch {
        /* no location — skipped */
      }
      push({ kind: "wisp", url: PUBLIC_WISP });
    } else {
      // the relay outranks raw wisp everywhere: it carries a real
      // browser-shaped forwarder whose second hop tunnels through a wisp
      // upstream when a site walls the datacenter egress — the same
      // residential pipe, minus the rate-limits that shred images
      push({ kind: "relay", url: "/api/relay" });
      push({ kind: "wisp", url: PUBLIC_WISP });
    }
    return out;
  }

  /**
   * Relay probe — a REAL end-to-end forward, not just the health GET.
   * Serverless hosts can answer /api/relay fine and still fail every
   * actual proxied request; forwarding https://example.com/ through the
   * relay here catches exactly that before the browser ever navigates.
   */
  private async probeRelay(base: string, timeoutMs = 12000): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const t0 = performance.now();
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "x-relay-target": "https://example.com/", "x-relay-method": "GET" },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      if (!res.ok) return { ok: false, error: `relay answered ${res.status}` };
      const text = await res.text();
      if (!/Example Domain/i.test(text)) return { ok: false, error: "relay forward came back wrong" };
      return { ok: true, latencyMs: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "relay probe failed" };
    }
  }

  /** Wisp probe — the server must accept and open the websocket handshake. */
  private async probeWisp(url: string, timeoutMs = 7000): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    const t0 = performance.now();
    return new Promise((resolve) => {
      let settled = false;
      let ws: WebSocket | null = null;
      const done = (ok: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        resolve(
          ok
            ? { ok: true, latencyMs: Math.round(performance.now() - t0) }
            : { ok: false, error: error ?? "wisp unreachable" },
        );
      };
      try {
        ws = new WebSocket(toWsUrl(url));
      } catch (e) {
        done(false, e instanceof Error ? e.message : "bad wisp url");
        return;
      }
      const timer = window.setTimeout(() => done(false, "wisp handshake timed out"), timeoutMs);
      ws.onopen = () => {
        window.clearTimeout(timer);
        done(true);
      };
      ws.onerror = () => {
        window.clearTimeout(timer);
        done(false, "wisp server refused the socket");
      };
      ws.onclose = () => {
        window.clearTimeout(timer);
        done(false, "wisp server closed the socket");
      };
    });
  }

  private probe(c: Candidate): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    return c.kind === "relay" ? this.probeRelay(c.url) : this.probeWisp(c.url);
  }

  /** Probe candidates in order; first healthy one wins (2min cache). */
  async status(): Promise<WispStatus> {
    if (this.cached && Date.now() - this.cached.at < 120_000) {
      return {
        ok: true,
        wispUrl: this.cached.candidate.url,
        transport: this.cached.candidate.kind,
      };
    }
    for (const c of this.candidates()) {
      const r = await this.probe(c);
      if (r.ok) {
        this.cached = { candidate: c, at: Date.now() };
        return { ok: true, wispUrl: c.url, transport: c.kind, latencyMs: r.latencyMs };
      }
    }
    return {
      ok: false,
      wispUrl: null,
      error:
        "no proxy transport answered — tried the same-origin relay and every wisp server (set one with `proxy wisp <url>`)",
    };
  }

  init(): Promise<{ ok: boolean; error?: string }> {
    if (!this.initPromise) {
      this.initPromise = this.doInit()
        .catch((e: unknown) => ({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }))
        .then((r) => {
          if (!r.ok) {
            // never cache a failed init — the transport may simply have
            // been down for a moment; the next call starts clean
            this.initPromise = null;
            this.controller = null;
            this.connection = null;
          }
          return r;
        });
    }
    return this.initPromise;
  }

  /**
   * Fault-driven revalidation: forget the cached transport winner, drop the
   * init memo and re-probe everything. The browser chrome calls this when a
   * proxied frame reports a PROXY FAULT — if another transport is healthy,
   * the frame reload lands on it and the user never sees a second fault.
   */
  async revalidate(): Promise<WispStatus> {
    this.cached = null;
    this.initPromise = null;
    this.connection = null;
    const s = await this.status();
    if (s.ok) {
      try {
        await this.init();
      } catch {
        /* the fault page + retry link still cover us */
      }
    }
    return s;
  }

  /**
   * Heal a poisoned "$scramjet" schema (born storeless) BEFORE the
   * controller opens its kept-alive connection: unregister the SW (its
   * leaked IDB connections block deletes), delete, rebuild complete.
   * Slow/blocked opens are left alone — deleting a healthy DB on a slow
   * machine is how the churn started.
   */
  private async ensureIdbSchema(): Promise<void> {
    try {
      const dbs = (await indexedDB.databases?.()) ?? [];
      const entry = dbs.find((d) => d.name === SCRAM_DB);
      if (!entry) {
        // absent: CREATE IT COMPLETE right now
        await new Promise<void>((resolve) => {
          try {
            const rq = indexedDB.open(SCRAM_DB);
            rq.onupgradeneeded = () => {
              const d = rq.result;
              for (const s of SCRAMJET_STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
            };
            const t = window.setTimeout(resolve, 4000);
            rq.onsuccess = () => {
              window.clearTimeout(t);
              rq.result.close();
              resolve();
            };
            rq.onerror = rq.onblocked = () => {
              window.clearTimeout(t);
              resolve();
            };
          } catch {
            resolve();
          }
        });
        return;
      }
      if (entry.version !== 1) return; // unknown shape — leave it alone
      const opened = await new Promise<{ ok: boolean; db?: IDBDatabase }>((resolve) => {
        try {
          const rq = indexedDB.open(SCRAM_DB, 1);
          const t = window.setTimeout(() => resolve({ ok: false }), 5000);
          rq.onupgradeneeded = () => {
            const d = rq.result;
            for (const s of SCRAMJET_STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
          };
          rq.onsuccess = () => {
            window.clearTimeout(t);
            const d = rq.result;
            const healthy = d.objectStoreNames.contains("config");
            d.close();
            resolve({ ok: healthy });
          };
          rq.onerror = () => {
            window.clearTimeout(t);
            resolve({ ok: false });
          };
          rq.onblocked = () => {
            window.clearTimeout(t);
            resolve({ ok: false });
          };
        } catch {
          resolve({ ok: false });
        }
      });
      if (opened.ok) return; // healthy
      // positively poisoned → kill the SW, rebuild, continue
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
        await new Promise<void>((resolve) => {
          const t = window.setTimeout(resolve, 6000);
          const iv = window.setInterval(() => {
            void navigator.serviceWorker.getRegistrations().then((regs2) => {
              if (regs2.length === 0) {
                window.clearInterval(iv);
                window.clearTimeout(t);
                resolve();
              }
            });
          }, 250);
        });
      } catch {
        /* unregister is best effort */
      }
      await new Promise<boolean>((resolve) => {
        try {
          const rq = indexedDB.deleteDatabase(SCRAM_DB);
          const t = window.setTimeout(() => resolve(false), 3000);
          rq.onsuccess = () => {
            window.clearTimeout(t);
            resolve(true);
          };
          rq.onerror = () => {
            window.clearTimeout(t);
            resolve(true);
          };
          rq.onblocked = () => {
            window.clearTimeout(t);
            resolve(false);
          };
        } catch {
          resolve(false);
        }
      });
      // rebuilt automatically by the next open (patched prototype)
    } catch {
      /* best effort — controller.init() will surface a real error if any */
    }
  }

  private async doInit(): Promise<{ ok: boolean; error?: string }> {
    if (typeof navigator !== "undefined" && !("serviceWorker" in navigator)) {
      return { ok: false, error: "service workers unsupported in this browser" };
    }

    patchScramjetIdb();
    // heal any poisoned "$scramjet" schema BEFORE the SW exists again and
    // before the controller opens its (kept-alive) DB connection
    await this.ensureIdbSchema();

    await Promise.all([loadScript(`/scram/scramjet.all.js?${ASSET_V}`), loadScript(`/baremux/index.js?${ASSET_V}`)]);

    if (!window.$scramjetLoadController || !window.BareMux) {
      return { ok: false, error: "scramjet runtime failed to load (missing globals)" };
    }

    // register the sw first so it installs while the controller warms up
    try {
      await navigator.serviceWorker.register("/sw.js");
    } catch {
      /* a stale registration error must not kill init */
    }
    // wait until a worker actually CONTROLS this page before any frame
    // navigates: the first /scramjet/ document fetch can otherwise be
    // orphaned mid hand-off (the classic "first open hangs on white").
    try {
      await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 6000))]);
    } catch {
      /* best effort — the frame retry covers the rest */
    }
    // the gate: hand the (in-memory) session token to the worker so it
    // opens /scramjet — verified server-side, dies with the page
    try {
      unlockProxyWorker();
    } catch {
      /* never let the unlock break init */
    }

    if (!this.controller) {
      const { ScramjetController } = window.$scramjetLoadController();
      this.controller = new ScramjetController({
        files: {
          wasm: `/scram/scramjet.wasm.wasm?${ASSET_V}`,
          all: `/scram/scramjet.all.js?${ASSET_V}`,
          sync: `/scram/scramjet.sync.js?${ASSET_V}`,
        },
      });
      // bounded: a wedged IDB must not leave the browser stuck on
      // "connecting…" forever — fail and let init() retry
      await Promise.race([
        this.controller.init(),
        new Promise((_, reject) =>
          window.setTimeout(() => reject(new Error("proxy init timed out — retrying")), 20000),
        ),
      ]);
    }

    const pick = await this.status();
    if (!pick.ok || !pick.wispUrl) {
      return { ok: false, error: pick.error ?? "no proxy transport answered" };
    }
    const candidate = this.cached!.candidate;

    if (!this.connection) {
      this.connection = new window.BareMux.BareMuxConnection("/baremux/worker.js?v=20261021a");
    }
    // ALWAYS (re)set the transport: getTransport() only reports the PATH,
    // not its args — a lingering shared worker can hold a transport pointed
    // at a dead endpoint and every proxied request hangs. Idempotent+cheap.
    if (candidate.kind === "relay") {
      await this.connection.setTransport("/httpx/index.mjs", [{ relay: candidate.url }]);
    } else {
      await this.connection.setTransport("/epoxy/index.mjs", [{ wisp: toWsUrl(candidate.url) }]);
    }

    return { ok: true };
  }

  createFrame(): ProxyFrameHandle {
    if (!this.controller) throw new Error("proxy not initialized — run init() first");
    const frame: ScramjetFrameLike = this.controller.createFrame();
    const el = frame.frame;
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.border = "0";
    el.style.background = "transparent";
    /* fullscreen video inside proxied pages (youtube etc) + clipboard handoff */
    el.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write");
    el.allowFullscreen = true;
    let lastUrl = "";

    const handle: ProxyFrameHandle = {
      el,
      go: (url: string) => frame.go(url),
      back: () => frame.back(),
      forward: () => frame.forward(),
      reload: () => frame.reload(),
      getUrl: () => lastUrl,
      onUrl: (cb) => {
        frame.addEventListener("urlchange", () => {
          try {
            lastUrl = unwrapScramjetUrl(frame.url?.toString() ?? "");
          } catch {
            /* ignore */
          }
          cb(lastUrl);
        });
      },
    };
    return handle;
  }
}

/** the REAL url out of a scramjet-encoded one — the tab rail, the omnibox
 *    and the favicon fetcher all speak real urls. Anything that is not a
 *    scramjet path comes back untouched. */
export function unwrapScramjetUrl(raw: string): string {
  const marker = "/scramjet/";
  const idx = raw.lastIndexOf(marker);
  if (idx < 0) return raw;
  try {
    const real = decodeURIComponent(raw.slice(idx + marker.length));
    return /^https?:\/\//i.test(real) ? real : raw;
  } catch {
    return raw;
  }
}
