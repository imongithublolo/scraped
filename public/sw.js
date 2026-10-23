/* DAEMON proxy service worker — canonical scramjet wiring, rebuilt clean.
 *
 * Shape: patch IDB → load scramjet → feed the bare-client its port →
 * route + fetch with a deadline → sanitize → answer. The two exotic blocks
 * (the IDB prototype patch and the baremuxinit port feed) are NOT optional:
 * scramjet 1.1.0 silently wedges without both on every browser we tested.
 */

/* ------------------------------------------------------------------ *
 * 1. THE IDB SCHEMA PATCH.
 * Scramjet's helpers open the "$scramjet" DB with NO upgrade handler —
 * if that open wins the race on a fresh browser, the DB is born at v1
 * with zero stores and every later controller init throws forever. This
 * prototype-level patch (helpers call IDBFactory.prototype.open via
 * .call(), bypassing instance overrides) makes every "$scramjet" open
 * create the stores, whoever opens first.
 * ------------------------------------------------------------------ */
const SCRAM_DB = "$scramjet";
const SCRAMJET_STORES = ["config", "cookies", "redirectTrackers", "referrerPolicies", "publicSuffixList"];
(() => {
  const proto = IDBFactory.prototype;
  const origOpen = proto.open;
  proto.open = function (name, version) {
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
})();

/* Bump when any /scram|/baremux asset changes — busts stale immutable
 * entries in browsers that saw an older cache header. */
const ASSET_V = "v=20261022a";

importScripts("/scram/scramjet.all.js?" + ASSET_V);

/* Ring-buffer the SW's console.error: scramjet swallows its own internal
 * failures and answers with a bare empty 500 — the fault pages read this
 * buffer so the real stack reaches the user. */
const SW_ERR_RING = [];
(() => {
  const orig = console.error.bind(console);
  console.error = (...args) => {
    try {
      SW_ERR_RING.push(
        args
          .map((a) => {
            const s = a && (a.stack || a.message) ? String(a.stack || a.message) : String(a);
            return s.slice(0, 400);
          })
          .join(" | "),
      );
      if (SW_ERR_RING.length > 12) SW_ERR_RING.shift();
    } catch {
      /* never break logging */
    }
    orig(...args);
  };
})();
function swErrDiag() {
  return SW_ERR_RING.length ? "sw errors:\n" + SW_ERR_RING.join("\n") : "sw errors: (none captured)";
}

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

/* ------------------------------------------------------------------ *
 * 2. THE BARE-CLIENT PORT FEED.
 * Scramjet's internal bare client waits for a {"$scramjet$type":
 * "baremuxinit", port} message on the SW global — nothing in the stock
 * wiring sends one in this context (the senders are Worker/SharedWorker
 * construction wrappers that never fire here). Without the port,
 * scramjet.fetch() dies with a bare empty 500 while the transport is
 * perfectly healthy. Feed it ourselves: open our own channel to the
 * bare-mux SharedWorker (the same one the page's setTransport arms)
 * and hand the live port to scramjet's client.
 * ------------------------------------------------------------------ */
globalThis.__daemonPortFed = false;
async function feedScramjetClientPort() {
  if (globalThis.__daemonPortFed) return;
  globalThis.__daemonPortFed = true;
  try {
    const worker = new SharedWorker("/baremux/worker.js?v=20261021a", "bare-mux-worker");
    const port = worker.port;
    port.start();
    // make sure a transport is armed before the client fires requests —
    // if the page hasn't armed one yet, arm the same-origin relay
    const code = await (await fetch("/baremux/index.js", { cache: "no-store" })).text();
    (0, eval)(code);
    try {
      const conn = new self.BareMux.BareMuxConnection("/baremux/worker.js?v=20261021a");
      if (!(await conn.getTransport())) {
        const conn2 = new self.BareMux.BareMuxConnection("/baremux/worker.js?v=20261021a");
        await conn2.setTransport("/httpx/index.mjs", [{ relay: "/api/relay" }]);
      }
    } catch {
      /* arming is best-effort — the page normally does it */
    }
    self.dispatchEvent(new MessageEvent("message", { data: { $scramjet$type: "baremuxinit", port } }));
  } catch {
    globalThis.__daemonPortFed = false; // try again on the next fetch
  }
}

/* ------------------------------------------------------------------ *
 * 3. IDB health (install-time heal only — never delete at fetch time: a
 * delete blocked by any open connection stays PENDING and wedges every
 * later open. The page side owns healing before its controller opens.)
 * ------------------------------------------------------------------ */
function openWithSchema() {
  return new Promise((resolve) => {
    try {
      const rq = indexedDB.open(SCRAM_DB, 1);
      const t = setTimeout(() => resolve(null), 4000);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        for (const store of SCRAMJET_STORES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      };
      rq.onsuccess = () => {
        clearTimeout(t);
        resolve(rq.result);
      };
      rq.onerror = () => {
        clearTimeout(t);
        resolve(null);
      };
      rq.onblocked = () => {
        clearTimeout(t);
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
}

async function healSchemaAtInstall() {
  const db = await openWithSchema();
  if (db) {
    const healthy = db.objectStoreNames.contains("config");
    db.close();
    if (healthy) return;
    // positively poisoned (open ok, config missing) → rebuild once
    await new Promise((resolve) => {
      const rq = indexedDB.deleteDatabase(SCRAM_DB);
      const t = setTimeout(resolve, 4000);
      rq.onsuccess = rq.onerror = rq.onblocked = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
  const rebuilt = await openWithSchema();
  if (rebuilt) rebuilt.close();
}

let schemaHealthy = false;
async function schemaOk() {
  if (schemaHealthy) return true;
  const db = await openWithSchema();
  if (db) {
    const healthy = db.objectStoreNames.contains("config");
    db.close();
    if (healthy) {
      schemaHealthy = true;
      return true;
    }
  }
  return false;
}

function withTimeout(p, ms) {
  return Promise.race([Promise.resolve(p), new Promise((_, reject) => setTimeout(() => reject(new Error("sw timeout")), ms))]);
}

/* ------------------------------------------------------------------ *
 * 4. fault pages (the only window into the SW's internals a user gets)
 * ------------------------------------------------------------------ */
function faultHtml(msg, url) {
  const safe = String(msg).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  return (
    '<!doctype html><meta charset="utf-8"><title>daemon proxy</title><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0103;color:#ff6b61;font-family:ui-monospace,Menlo,monospace"><div style="text-align:center;max-width:80ch"><div style="font-size:13px;letter-spacing:.2em">PROXY FAULT</div><pre style="margin-top:10px;font-size:11px;color:#8f3d36;white-space:pre-wrap;text-align:left">' +
    safe +
    "</pre>" +
    '<div style="margin-top:14px;font-size:11px"><a href="#" onclick="location.reload();return false" style="color:#ffb454">[ retry ]</a></div>' +
    // tell the browser chrome — it revalidates the transport and reloads us
    "<script>try{parent.postMessage({__murkeProxyFault:true,url:" +
    JSON.stringify(String(url || location.href)) +
    "},location.origin)}catch(e){}\u003c/script>" +
    "</div></body>"
  );
}

function configDiag() {
  try {
    const c = scramjet && scramjet.config;
    if (!c) return "cfg: NOT LOADED";
    return (
      "cfg: loaded, prefix=" + c.prefix +
      ", codec=" + (c.codec ? "yes" : "MISSING") +
      ", files=" + (c.files && c.files.wasm ? "yes" : "MISSING")
    );
  } catch (e) {
    return "cfg: diag failed " + (e && e.message);
  }
}

/* ------------------------------------------------------------------ *
 * 5. THE RENDER GUARD.
 * (a) NOSNIFF/PLAINTEXT: some transport paths hand back navigations with
 *     a missing or text/plain content-type while carrying nosniff —
 *     Chrome then renders the (fully rewritten) HTML as SOURCE TEXT.
 *     A proxied page is our own same-origin mirror; force the right type.
 * (b) COEP MISMATCH: the shell runs crossOriginIsolated (COEP:
 *     credentialless) and scramjet stamps proxied documents require-corp,
 *     which then blocks every cross-origin no-CORS subresource the URL
 *     rewriter missed — the page loads unstyled. Rewrite to credentialless
 *     on EVERY routed response (styles/scripts too, not just navigations).
 * ------------------------------------------------------------------ */
function sanitizeResponse(res, event) {
  try {
    const isNav =
      event.request.mode === "navigate" ||
      event.request.destination === "document" ||
      event.request.destination === "iframe";
    if (res.status < 200 || res.status >= 400) return res;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const coep = (res.headers.get("cross-origin-embedder-policy") || "").toLowerCase();
    const needsCoepFix = coep === "require-corp" || coep === "credentialless; report-to=\"default\"";
    const nosniff = (res.headers.get("x-content-type-options") || "").toLowerCase() === "nosniff";
    const broken = isNav && (!ct || ct.startsWith("text/plain"));
    if (!broken && !needsCoepFix && !(isNav && nosniff)) return res;
    const headers = new Headers(res.headers);
    if (broken) headers.set("Content-Type", "text/html; charset=utf-8");
    if (needsCoepFix) headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    if (isNav && nosniff) headers.delete("X-Content-Type-Options");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch {
    return res; // never let the guard itself break a page
  }
}

/* ------------------------------------------------------------------ *
 * 6. the fetch pipeline
 * ------------------------------------------------------------------ */
async function handleRequest(event) {
  let routed = false;
  try {
    routed = new URL(event.request.url).pathname.startsWith("/scramjet/");
  } catch {
    routed = false;
  }
  try {
    await withTimeout(schemaOk(), 5000);
    await withTimeout(scramjet.loadConfig(), 4000);
    // a stalled port feed must not wedge the request forever — race it;
    // the client picks the port up on the next fetch
    await Promise.race([feedScramjetClientPort(), new Promise((r) => setTimeout(r, 8000))]);
    if (scramjet.config && scramjet.route(event)) {
      try {
        // bounded: a transport that never answers must not spin the tab —
        // fail into the fault page (retry link) instead
        const res = await Promise.race([
          scramjet.fetch(event),
          new Promise(
            (_, reject) =>
              setTimeout(
                () => reject(new Error("transport did not answer within 30s — the relay or wisp upstream is stalled")),
                30000,
              ),
          ),
        ]);
        // scramjet swallows transport errors and resolves with a bare empty
        // 500 (no headers, no body) — surface the real fault instead
        if (res.status === 500 && !res.headers.get("content-type")) {
          return new Response(
            faultHtml(
              "transport request failed inside the worker (scramjet returned an empty 500)\n" +
                "url: " +
                event.request.url +
                "\n" +
                configDiag() +
                "\n" +
                swErrDiag(),
              event.request.url,
            ),
            { status: 502, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
          );
        }
        return sanitizeResponse(res, event);
      } catch (e) {
        // surface the real transport error inside the frame — a bare 500
        // with no body makes the proxy impossible to debug
        const msg = (e && (e.stack || e.message || String(e))).toString().slice(0, 400);
        return new Response(faultHtml(msg + "\n" + configDiag() + "\n" + swErrDiag(), event.request.url), {
          status: 502,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    }
  } catch (e) {
    // schema/loadConfig stalled — a routed request must never leak to the
    // host app's 404; unrouted requests fall through to plain fetch
    if (routed) {
      const why = e instanceof Error ? e.message : String(e ?? "unknown");
      return new Response(faultHtml(why + "\n" + configDiag(), event.request.url), {
        status: 502,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  }
  return fetch(event.request);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await healSchemaAtInstall().catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    (async () => {
      try {
        return await handleRequest(event);
      } catch (e) {
        // FINAL safety net — nothing below handleRequest may surface as a
        // failed response in the proxied frame
        const msg = (e && (e.stack || e.message || String(e))).toString().slice(0, 400);
        return new Response(faultHtml("sw:\n" + msg, event.request.url), {
          status: 502,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    })(),
  );
});
