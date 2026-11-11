import { LS } from "./contracts";

/**
 * Murke gate auth — memoryless by design.
 *
 * The password is verified on every page load; NOTHING is stored. No token,
 * no session, no "remember me". Refresh, reopen, return from another tab —
 * the blank gate is always waiting.
 *
 * - Preferred path: server verifies the password (POST /api/auth). The client
 *   ships zero password material; the server compares a salted SHA-256
 *   digest with a timing-safe compare.
 * - Fallback: if the API is unreachable (e.g. static hosting), compare the
 *   SHA-256 of the input against an embedded salted digest via WebCrypto.
 */

/** sha256("murke-proxy::" + DEFAULT_PASSWORD) — overridden by the admin app's site hash / GATE_PASSWORD_HASH env. */
export const FALLBACK_HASH = "3e2322ca75db09664f87a9ef0e28440899d3d2ed0998071623126fa7de989494";
/** sha256("murke-proxy::" + "..0") — the lite door (offline fallback). */
export const LITE_FALLBACK_HASH = "a39187fce46eea8506d4fff6233fbd185915db1f786d7172b5afc13c7aa3148c";
export const HASH_SALT = "murke-proxy::";

export type SessionKind = "server" | "local";

/** login() result — truthiness still means "let them in"; `lite` says the
    ..0 door was used: proxy only, never the OS. */
export interface AuthResult {
  kind: SessionKind;
  lite?: boolean;
}

/** this load's session token — MEMORY ONLY (never localStorage, never a
 *  cookie the client can read). It exists so the authed shell can unlock
 *  the proxy's service worker (see unlockProxyWorker); it dies with the
 *  page, exactly like the gate. */
let sessionToken: string | null = null;

/** open the /scramjet gate in the proxy's service worker: hand the token
 *  over postMessage — the SW verifies it against /api/auth before it
 *  serves anything. Safe to call any time; no-op before login. */
export function unlockProxyWorker(): void {
  if (!sessionToken || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const send = (w: ServiceWorker | null | undefined) => {
    try {
      w?.postMessage({ type: "frost-unlock", token: sessionToken });
    } catch {
      /* a dead worker — the next controllerchange retries */
    }
  };
  send(navigator.serviceWorker.controller);
  void navigator.serviceWorker.ready
    .then((reg) => {
      send(reg.active);
      send(reg.installing);
      send(reg.waiting);
    })
    .catch(() => undefined);
  // a worker that activates later (first registration) hears it too
  navigator.serviceWorker.addEventListener("controllerchange", unlockProxyWorker);
}

/** Scrub any session artifacts left by older builds. */
export function wipeSession(): void {
  try {
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
  for (const key of [LS.legacy.session, LS.legacy.daemonSession]) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Verify the password. Server first; embedded digests as offline fallback.
    Returns null on refusal; `{ lite: true }` when the ..0 door opened. */
export async function login(password: string): Promise<AuthResult | null> {
  try {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      const j = (await res.json().catch(() => null)) as { lite?: boolean; token?: string } | null;
      // keep the token in memory — it unlocks the proxy's service worker
      if (typeof j?.token === "string" && j.token.length > 8) sessionToken = j.token;
      return { kind: "server", lite: Boolean(j?.lite) };
    }
    // ANY server answer (401 wrong pwd, 423 lockdown) is authoritative —
    // never fall through to the local digest when the server spoke
    return null;
  } catch {
    /* network error -> local fallback below */
  }

  const hex = await sha256Hex(HASH_SALT + password);
  if (hex === FALLBACK_HASH) return { kind: "local" };
  if (hex === LITE_FALLBACK_HASH) return { kind: "local", lite: true };
  return null;
}
