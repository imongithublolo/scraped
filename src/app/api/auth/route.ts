import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * MURKE gate auth.
 *
 * POST /api/auth  { password }            -> { token }  (HMAC-signed session)
 * GET  /api/auth  Authorization: Bearer t -> { valid }
 *
 * The password never ships to the client. Verification compares a salted
 * SHA-256 digest against GATE_PASSWORD_HASH (env) or the built-in default.
 * Set GATE_PASSWORD_HASH + SESSION_SECRET in production.
 *   hash = sha256("murke-proxy::" + yourPassword)
 * Generate one with: node scripts/hash-password.mjs <newpassword>
 */

const SALT = "murke-proxy::";
const DEFAULT_HASH = "acc674ea28b0086b7082aa9d7b965e7864e850d686fb82676c2600b054134902"; // "markX99"
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function secret(): string {
  return process.env.SESSION_SECRET || "murke-local-dev-secret-change-me";
}

function expectedHash(): string {
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
  try {
    const body = (await req.json()) as { password?: unknown };
    password = body?.password;
  } catch {
    return unauthorized();
  }
  if (typeof password !== "string" || password.length === 0) return unauthorized();

  const got = createHash("sha256").update(SALT + password).digest("hex");
  const expected = expectedHash();
  let ok = false;
  if (/^[0-9a-f]{64}$/.test(expected)) {
    ok = timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  }
  if (!ok) return unauthorized();

  return new Response(JSON.stringify({ token: makeToken() }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
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
