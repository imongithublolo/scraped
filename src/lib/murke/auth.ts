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

/** sha256("murke-proxy::" + DEFAULT_PASSWORD) — change via GATE_PASSWORD_HASH env. */
export const FALLBACK_HASH = "acc674ea28b0086b7082aa9d7b965e7864e850d686fb82676c2600b054134902";
export const HASH_SALT = "murke-proxy::";

export type SessionKind = "server" | "local";

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

/** Verify the password. Server first; embedded digest as offline fallback. */
export async function login(password: string): Promise<SessionKind | null> {
  try {
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) return "server";
    // 401/403 -> wrong password, do NOT fall through to the local check
    if (res.status === 401 || res.status === 403) return null;
  } catch {
    /* network error -> local fallback below */
  }

  const hex = await sha256Hex(HASH_SALT + password);
  if (hex === FALLBACK_HASH) return "local";
  return null;
}
