/**
 * httpx — a baremux BareTransport with NO wisp dependency.
 *
 * Loaded by BareMuxConnection.setTransport("/httpx/index.mjs", [{ relay }]).
 * Implements the exact surface the libcurl transport exposed:
 *
 *   constructor(args)
 *   ready: boolean
 *   init(): Promise<void>
 *   meta(): Promise<void>
 *   request(remote, method, body, headers, signal)
 *       → { body, headers: Record<string, string[]>, status, statusText }
 *   connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror)
 *       → [send(data), close(code, reason)]
 *
 * Every request is POSTed to the same-origin relay (/api/relay), which
 * streams to the real upstream server-side. WebSockets degrade to a native
 * connection (fine for the vast majority of sites; no wisp relay needed).
 *
 * HARD RULE: status never leaves the valid [200, 599] band. A relay
 * network error becomes a synthetic 502 with a readable body — scramjet
 * feeds the transport result straight into `new Response(...)`, and a
 * status of 0 there explodes with
 * "Failed to construct 'Response': The status provided (0) is outside the
 * range [200, 599]" and takes the whole page down with it.
 */

const MIN_STATUS = 200;
const MAX_STATUS = 599;

function clampStatus(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n < MIN_STATUS || n > MAX_STATUS) return 502;
  return Math.floor(n);
}

function textStream(text) {
  return new Blob([text]).stream();
}

class HttpxTransport {
  ready = true;

  constructor(args) {
    this.relay = (args && args.relay) || "/api/relay";
  }

  async init() {}

  async meta() {}

  async request(remote, method, body, headers, signal) {
    const relayHeaders = {
      "x-relay-target": remote.href,
      "x-relay-method": method,
    };

    if (headers) {
      const push = (name, value) => {
        const n = String(name).toLowerCase();
        if (!n || n === "host" || n === "content-length" || n.startsWith("x-relay-")) return;
        const key = "x-relay-h-" + n;
        relayHeaders[key] = relayHeaders[key] ? relayHeaders[key] + ", " + value : String(value);
      };
      if (typeof headers.forEach === "function") {
        headers.forEach((v, k) => push(k, v));
      } else {
        for (const [k, v] of Object.entries(headers)) push(k, v);
      }
    }

    const init = {
      method: "POST",
      headers: relayHeaders,
      redirect: "manual",
      signal,
    };
    if (body != null) {
      init.body = body;
      if (typeof body.pipeTo === "function" || typeof body.getReader === "function") {
        init.duplex = "half";
      }
    }

    let resp;
    try {
      resp = await fetch(this.relay, init);
    } catch (e) {
      // relay unreachable — a readable 502 keeps the pipeline alive and the
      // fault page (sw.js) tells the user what actually happened
      const why = e && e.message ? String(e.message) : "relay unreachable";
      return {
        body: textStream(
          '<!doctype html><meta charset="utf-8"><body style="background:#0a0103;color:#ff6b61;font-family:monospace">relay unreachable: ' +
            why.replace(/[<>&]/g, "") +
            "</body>",
        ),
        headers: { "content-type": ["text/html; charset=utf-8"], "cache-control": ["no-store"] },
        status: 502,
        statusText: "relay unreachable",
      };
    }

    let meta = { status: clampStatus(resp.status), statusText: resp.statusText };
    try {
      const raw = resp.headers.get("x-relay-meta");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          meta = {
            ...meta,
            ...parsed,
            status: clampStatus(parsed.status ?? meta.status),
            statusText: typeof parsed.statusText === "string" ? parsed.statusText : meta.statusText,
          };
        }
      }
    } catch {
      /* keep transport-level meta */
    }

    const out = {};
    resp.headers.forEach((v, k) => {
      if (k.startsWith("x-relay-rh-")) {
        const name = k.slice(11);
        if (!out[name]) out[name] = [v];
        else out[name].push(v);
      }
    });
    if (typeof resp.headers.getSetCookie === "function") {
      const sc = resp.headers.getSetCookie();
      if (sc.length > 0) out["set-cookie"] = sc;
    }

    return {
      body: resp.body,
      headers: out,
      status: meta.status,
      statusText: meta.statusText,
    };
  }

  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    // Best effort: native WebSocket. Browsers don't enforce CORS on
    // WebSockets, so most gateways accept it; strictly-origin-checked
    // sockets are out of reach without a wisp relay.
    let ws;
    try {
      ws = new WebSocket(url.toString(), protocols);
    } catch {
      onerror("");
      return [
        () => undefined,
        () => undefined,
      ];
    }
    ws.binaryType = "arraybuffer";
    ws.onopen = () => onopen("");
    ws.onmessage = (ev) => onmessage(ev.data);
    ws.onerror = () => onerror("");
    ws.onclose = (ev) => onclose(ev.code ?? 1006, ev.reason ?? "");
    return [
      (data) => {
        if (ws.readyState === 1) ws.send(data);
      },
      (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {
          /* already closing */
        }
      },
    ];
  }
}

export default HttpxTransport;
