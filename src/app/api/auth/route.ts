import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readSiteSettings, checkAdminToken } from "@/lib/murke/admin-store";

/**
 * MURKE gate auth.
 *
 * POST /api/auth  { password }            -> { token }  (HMAC-signed session)
 * POST /api/auth  { adminToken }          -> { token }  (admin bypass — bans
 *                                          + lockdown bow to a valid admin
 *                                          token; this is how the konami
 *                                          bypass on the gate gets in)
 * GET  /api/auth  Authorization: Bearer t -> { valid }
 *
 * The password never ships to the client. Verification compares a salted
 * SHA-256 digest against, in order: the admin-set hash (site store, written
 * by the admin app), GATE_PASSWORD_HASH (env), or the built-in default.
 * Set GATE_PASSWORD_HASH + SESSION_SECRET in production.
 *   hash = sha256("murke-proxy::" + yourPassword)
 *   node scripts/hash-password.mjs <newpassword>
 *
 * LOCKDOWN: while the admin app's kill switch is on, every login is
 * refused with 423 — the gate turns into the lock page.
 *
 * THE LITE DOOR: the password "..0" never opens the OS — it answers with
 * { lite: true } and the gate morphs into the borderless proxy (simple
 * mode). A separate permanent key, checked under the same ban + lockdown
 * guards, so the decoy obeys the same master switches as everything else.
 */

const SALT = "murke-proxy::";
const DEFAULT_HASH = "3e2322ca75db09664f87a9ef0e28440899d3d2ed0998071623126fa7de989494"; // "Miku!3"
const LITE_HASH = "a39187fce46eea8506d4fff6233fbd185915db1f786d7172b5afc13c7aa3148c"; // "..0"
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function secret(): string {
  return process.env.SESSION_SECRET || "murke-local-dev-secret-change-me";
}

async function expectedHash(): Promise<string> {
  const site = await readSiteSettings();
  if (site.hash && /^[0-9a-f]{64}$/.test(site.hash)) return site.hash.toLowerCase();
  return (process.env.GATE_PASSWORD_HASH || DEFAULT_HASH).toLowerCase();
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function makeToken(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, mac] = parts;
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { exp?: number };
    return typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "denied" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: Request): Promise<Response> {
  let password: unknown = null;
  let adminToken: unknown = null;
  try {
    const body = (await req.json()) as { password?: unknown; adminToken?: unknown };
    password = body?.password;
    adminToken = body?.adminToken;
  } catch {
    return unauthorized();
  }

  /* an admin token outranks every gate bit — bans + lockdown included.
     this is the konami bypass path; the token only exists after the
     permanent admin pwd cleared /api/admin/auth. */
  if (typeof adminToken === "string" && adminToken.length > 0 && checkAdminToken(adminToken)) {
    return new Response(JSON.stringify({ token: makeToken(), admin: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": `frost_gate=${makeToken()}; Path=/; SameSite=Lax; HttpOnly`,
      },
    });
  }

  if (typeof password !== "string" || password.length === 0) return unauthorized();

  const site = await readSiteSettings();
  if (site.lockdown) {
    return new Response(JSON.stringify({ error: "locked" }), {
      status: 423,
      headers: { "Content-Type": "application/json" },
    });
  }

  /* banned machines are refused before the password even matters */
  {
    const fwd = req.headers.get("x-forwarded-for") ?? "";
    const ip = (fwd.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim();
    const { isBannedIp } = await import("@/lib/murke/admin-store");
    if (await isBannedIp(ip)) {
      return new Response(JSON.stringify({ error: "banned" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const got = createHash("sha256").update(SALT + password).digest("hex");
  const expected = await expectedHash();
  if (/^[0-9a-f]{64}$/.test(expected) &&
      timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"))) {
    return authed(makeToken());
  }

  /* the lite door — "..0": the proxy, and ONLY the proxy */
  if (timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(LITE_HASH, "hex"))) {
    return authed(makeToken(), true);
  }

  return unauthorized();
}

/** a successful login — the token rides BOTH the json (legacy callers)
 *  AND the frost_gate session cookie: the cookie is what the proxy's
 *  service worker and the relay check, so /scramjet + /api/relay only
 *  ever serve password-authed sessions. Session cookie (no Max-Age):
 *  closing the browser forgets it, exactly like the gate itself. */
function authed(token: string, lite = false): Response {
  const body = JSON.stringify(lite ? { token, lite: true } : { token });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `frost_gate=${token}; Path=/; SameSite=Lax; HttpOnly`,
    },
  });
}

export async function GET(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const valid = token.length > 0 && verifyToken(token);
  if (!valid) return unauthorized();
  return new Response(JSON.stringify({ valid: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
