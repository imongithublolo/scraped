/* frost proxy service worker — canonical scramjet wiring, rebuilt clean.
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

/* the Hertswood Academy crest (public/hub/favicon-196.png) — inlined so the
 * offline page stays whole with zero network. Re-embed after changing it:
 *   base64 -w0 public/hub/favicon-196.png
 */
const HUB_LOGO =
  "data:image/png;base64,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";
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
 * 4.5 THE GATE + THE PRETTY URL.
 *
 * GATE: /scramjet/* only serves password-authed sessions. /api/auth
 * sets the frost_gate cookie (HttpOnly, HMAC-signed, session-scoped)
 * on every successful login; same-origin requests — the shell's
 * iframes, the transport's relay hops — carry it automatically. No
 * cookie → the lock page, never the proxy. The relay independently
 * verifies the cookie server-side, so even a hand-crafted cookie dies
 * at the pipe.
 *
 * PRETTY URL: top-level navigations to /scramjet/<percent-encoded>
 * bounce ONCE to the decoded path — the address bar then reads
 * origin/scramjet/https://example.com/ instead of the encoded mush.
 * The codec is encodeURIComponent/decodeURIComponent, so the decoded
 * path decodes to itself: reloads, history and shared links of the
 * pretty url all serve. %, ? and # stay escaped (they must survive a
 * second decode). Only document navigations — iframes keep the
 * encoded form (no address bar to dress).
 * ------------------------------------------------------------------ */
/* the unlock — the authed page hands the SW its session token via
   postMessage (chromium hides the Cookie header from FetchEvent.request,
   so the cookie itself is unreadable here). The token is verified
   server-side against /api/auth before the gate opens; the flag lives
   in the SW's memory only — the worker dying re-locks, exactly like
   the gate's memoryless design. */
let gateOpenUntil = 0;
const GATE_TTL = 10 * 60 * 1000; // one unlock keeps the gate open 10 min
self.addEventListener("message", (event) => {
  try {
    const d = event.data;
    if (d && d.type === "frost-unlock" && typeof d.token === "string" && d.token.length > 8) {
      fetch("/api/auth", { headers: { authorization: "Bearer " + d.token }, cache: "no-store" })
        .then((r) => {
          if (r.ok) gateOpenUntil = Date.now() + GATE_TTL;
        })
        .catch(() => {});
    }
  } catch {
    /* never let a message break the worker */
  }
});

function lockHtml() {
  return (
    '<!doctype html><meta charset="utf-8"><title>frost</title>' +
    '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d12;color:#e8ecf2;font-family:-apple-system,BlinkMacSystemFont,' + "'" + 'Segoe UI' + "'" + ',Roboto,sans-serif">' +
    '<div style="text-align:center">' +
    '<svg width="44" height="44" viewBox="0 0 24 24" style="opacity:.9"><path fill="#6EC1FF" d="M12 2a1 1 0 0 1 1 1v2.6l1.8-1.05a1 1 0 1 1 1 1.73L14 7.6V11l3-1.73.2-2.3a1 1 0 1 1 2 .17l-.13 1.5 1.3-.75a1 1 0 0 1 1 1.73l-1.3.75 1.43.5a1 1 0 1 1-.67 1.89l-2.2-.78L15 13l2.63 1.52 2.2-.78a1 1 0 1 1 .67 1.89l-1.43.5 1.3.75a1 1 0 0 1-1 1.73l-1.3-.75.13 1.5a1 1 0 1 1-2 .17L17 18.73 14 17v3.4l1.8 1.05a1 1 0 1 1-1 1.73L13 22.4V23a1 1 0 1 1-2 0v-.6l-1.8 1.05a1 1 0 1 1-1-1.73L10 20.4V17l-3 1.73-.2 2.3a1 1 0 1 1-2-.17l.13-1.5-1.3.75a1 1 0 0 1-1-1.73l1.3-.75-1.43-.5a1 1 0 1 1 .67-1.89l2.2.78L9 13l-2.63-1.52-2.2.78a1 1 0 1 1-.67-1.89l1.43-.5-1.3-.75a1 1 0 0 1 1-1.73l1.3.75-.13-1.5a1 1 0 1 1 2-.17l.2 2.3L10 7.6V4.4L8.2 3.35a1 1 0 1 1 1-1.73L11 2.6V3a1 1 0 0 1 1-1z"/></svg>' +
    '<div style="margin-top:18px;font-size:17px;font-weight:600">frost is locked</div>' +
    '<div style="margin-top:6px;font-size:13px;color:#8a93a3">sign in on the site to use the proxy</div>' +
    '<a href="/" style="display:inline-block;margin-top:18px;font-size:13px;color:#6EC1FF;text-decoration:none">go to the site</a>' +
    '</div></body>'
  );
}

/** the decoded, address-bar-friendly form of a /scramjet/ path — or
    null when it is already pretty / undecodable. */
function prettyScramjetPath(pathname) {
  const marker = "/scramjet/";
  if (!pathname.startsWith(marker)) return null;
  const payload = pathname.slice(marker.length);
  if (!payload) return null;
  if (!/%[0-9a-f]{2}/i.test(payload)) return null; // already pretty
  let decoded;
  try {
    decoded = decodeURIComponent(payload);
  } catch {
    return null;
  }
  // %, ? and # must stay escaped — they have to survive a second decode
  const safe = decoded.replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/#/g, "%23");
  if (safe === payload || !safe) return null;
  return marker + safe;
}

/* ------------------------------------------------------------------ *
 * 4. fault pages (the only window into the SW's internals a user gets)
 * ------------------------------------------------------------------ */
function faultHtml(msg, url) {
  /* THE OFFLINE PAGE — the proxy's fault surface wears the school's own
   * clothes: Hertswood Academy crest, Student Hub masthead, and a tab
   * title that says the truth ("you are offline — get online to get back
   * to studying") instead of leaking what sits under the hub. The crest
   * rides inline as a data URI so the page is whole with zero network.
   * The raw fault text survives in a collapsed <details> for debugging,
   * and the shell still hears __murkeProxyFault so it can revalidate. */
  const safe = String(msg).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  const logo = HUB_LOGO;
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Student Hub (you are offline — get online to get back to studying)</title>" +
    "<script>if(!navigator.onLine){document.title='Student Hub (you are offline — get online to get back to studying)'}else{document.title='Student Hub (this page could not load)'}<\/script>" +
    "<style>" +
    "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:#f4f5f7;color:#1f2430;font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif}" +
    "header{background:#7a1f3d;color:#fff;padding:13px 22px;display:flex;align-items:center;gap:14px;box-shadow:0 2px 10px rgba(0,0,0,.18)}" +
    "header img{width:42px;height:42px;border-radius:6px;background:#fff;padding:2px}" +
    "header .school b{display:block;font-size:17px;letter-spacing:.02em;line-height:1.2}" +
    "header .school span{font-size:12px;opacity:.85}" +
    "main{flex:1;display:flex;align-items:center;justify-content:center;padding:28px 16px}" +
    ".card{background:#fff;max-width:560px;width:100%;border-radius:14px;border-top:6px solid #c9a227;box-shadow:0 12px 40px rgba(15,20,40,.12),0 2px 6px rgba(15,20,40,.06);padding:38px 34px;text-align:center}" +
    ".card .crest{width:88px;height:88px;margin:0 auto 12px;display:block}" +
    "h1{font-size:24px;margin:0 0 8px;color:#7a1f3d}" +
    ".msg{font-size:15.5px;line-height:1.55;color:#4a5160;margin:0 0 22px}" +
    ".btn{display:inline-block;background:#7a1f3d;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 32px;border-radius:999px;border:0;cursor:pointer}" +
    ".btn:hover{background:#5e152e}" +
    "details{margin-top:22px;text-align:left}summary{cursor:pointer;font-size:12.5px;color:#8a93a3}" +
    "pre{margin:8px 0 0;font-size:10.5px;color:#8f3d36;white-space:pre-wrap;background:#faf7f8;border:1px solid #efe4e8;border-radius:8px;padding:10px 12px;max-height:140px;overflow:auto}" +
    "footer{text-align:center;font-size:11.5px;color:#9aa1ad;padding:14px}" +
    "</style></head><body>" +
    '<header><img alt="Hertswood Academy crest" src="' + logo + '"><div class="school"><b>Hertswood Academy</b><span>Student Hub</span></div></header>' +
    "<main><div class=\"card\">" +
    '<img class="crest" alt="" src="' + logo + '">' +
    "<h1 id=\"frost-h\">You're offline</h1>" +
    '<p class="msg" id="frost-m">Get back online to get back to studying — the Student Hub needs an internet connection to open this page. Your work here is safe.</p>' +
    '<button class="btn" onclick="location.reload()">Try again</button>' +
    "<details><summary>Technical details</summary><pre>" + safe + "</pre></details>" +
    "</div></main>" +
    "<footer>Hertswood Academy · Student Hub</footer>" +
    "<script>" +
    "try{parent.postMessage({__murkeProxyFault:true,url:" + JSON.stringify(String(url || location.href)) + "},location.origin)}catch(e){}" +
    "if(!navigator.onLine){var h=document.getElementById('frost-h');if(h)h.textContent=\"You're offline\";}" +
    "else{var h2=document.getElementById('frost-h');var m2=document.getElementById('frost-m');if(h2)h2.textContent='This page could not load';if(m2)m2.textContent='The Student Hub could not reach this page. Check your connection and try again.';}" +
    "<\/script></body></html>"
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
  /* THE SHIM EXEMPTION — /ytframe.html is the COEP-free window hosting
   * youtube's OWN player (the always-works music path). Everything it
   * loads — the iframe_api script, the youtube-nocookie embed iframe —
   * must ride the USER'S direct connection. The catch-all below would
   * yank each one into the proxy, and the player's postMessage channel
   * dies on the origin mismatch (the "music doesn't work" root cause:
   * the api never signalled, the watchdog failed over, nothing played).
   * Requests whose client IS the shim pass straight through. */
  try {
    if (event.clientId) {
      const shimClient = await self.clients.get(event.clientId);
      if (shimClient && shimClient.url.indexOf("/ytframe.html") >= 0) {
        return fetch(event.request);
      }
    }
  } catch {
    /* fall through to the normal pipeline */
  }

  let routed = false;
  try {
    routed = new URL(event.request.url).pathname.startsWith("/scramjet/");
  } catch {
    routed = false;
  }

  /* THE GATE — every /scramjet/ request needs the unlocked flag */
  if (routed && Date.now() > gateOpenUntil) {
    return new Response(lockHtml(), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  /* THE PRETTY URL — top-level navigations bounce once to the decoded
     path so the address bar shows the real url */
  if (routed && event.request.destination === "document") {
    try {
      const reqUrl = new URL(event.request.url);
      const pretty = prettyScramjetPath(reqUrl.pathname);
      if (pretty) {
        return Response.redirect(new URL(pretty, self.location.origin).toString(), 307);
      }
    } catch {
      /* fall through to the normal pipeline */
    }
  }

  try {
    // THE CATCH-ALL — the escape hatch google's own JS looks for. A page
    // inside the proxy that assigns a RAW absolute url (frame-busters,
    // sg_ss re-appenders, redirect chains scramjet's hooks miss) would
    // otherwise navigate the frame to the real site: cross-origin,
    // cookie-blind, captcha-prone, invisible to the chrome. Every
    // cross-origin http(s) request from a controlled page instead bounces
    // straight back into the proxy — the frame never leaves home.
    const reqUrl = new URL(event.request.url);
    const isHttp = reqUrl.protocol === "http:" || reqUrl.protocol === "https:";
    if (
      isHttp &&
      reqUrl.origin !== self.location.origin &&
      !reqUrl.pathname.startsWith("/scramjet/")
    ) {
      const wrapped =
        "/scramjet/" + encodeURIComponent(reqUrl.toString());
      return Response.redirect(new URL(wrapped, self.location.origin).toString(), 307);
    }
  } catch {
    /* fall through to the normal pipeline */
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
  event.waitUntil(
    (async () => {
      /* THE GREAT PURGE — every site open must land on the CURRENT worker.
       * Old caches (whatever a previous version stashed away) are deleted
       * wholesale on activation, so a fresh deploy's offline mode takes
       * over the instant the worker swaps in — no stale copies survive. */
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        /* no cache storage — nothing to purge */
      }
      await self.clients.claim();
    })(),
  );
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
