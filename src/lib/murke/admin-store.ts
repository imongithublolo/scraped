import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * murke admin — server side of the admin app.
 *
 *  - the PERMANENT admin pwd (never changeable from the UI) unlocks the
 *    admin session: POST /api/admin/auth mints a short-lived HMAC token.
 *  - site settings (gate password hash + lockdown) persist through the
 *    same GitHub-Contents backing store the chat uses, so they survive
 *    serverless cold starts; a local SQLite KV answers when the token env
 *    is absent.
 *
 * ADMIN_PWD priority: env ADMIN_PWD > built-in default (310554).
 */

const DEFAULT_ADMIN_PWD = "310554";
const ADMIN_TTL_MS = 30 * 60 * 1000;
const SALT = "murke-proxy::";

export function adminSecret(): string {
  return process.env.SESSION_SECRET || "murke-local-dev-secret-change-me";
}

function adminPwd(): string {
  return process.env.ADMIN_PWD || DEFAULT_ADMIN_PWD;
}

export function checkAdminPwd(pwd: unknown): boolean {
  if (typeof pwd !== "string" || pwd.length === 0) return false;
  const a = Buffer.from(pwd);
  const b = Buffer.from(adminPwd());
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(payload: string): string {
  return createHmac("sha256", adminSecret()).update(payload).digest("base64url");
}

/** Mint a short-lived admin token. */
export function makeAdminToken(): string {
  const payload = Buffer.from(JSON.stringify({ role: "admin", exp: Date.now() + ADMIN_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Verify an admin token (Bearer or raw). */
export function checkAdminToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, mac] = parts;
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { role?: string; exp?: number };
    return data.role === "admin" && typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

export function adminFromRequest(req: Request): boolean {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : h.trim();
  return checkAdminToken(token);
}

export function sha256Gate(password: string): string {
  // the salt is identical to the gate's so a changed password flows
  // straight into /api/auth's comparison
  return createHash("sha256").update(SALT + password).digest("hex");
}

/* ---------- bans ---------- */

export async function isBannedIp(ip: string): Promise<boolean> {
  if (!ip || ip === "unknown") return false;
  const site = await readSiteSettings();
  return site.bans.some((b) => b.ip === ip);
}

export async function addBan(ip: string, id: string, by: string): Promise<SiteBan[]> {
  const site = await readSiteSettings();
  const bans = site.bans.filter((b) => b.ip !== ip);
  bans.unshift({ ip, id, at: Date.now(), by });
  const next = await writeSiteSettings({ bans: bans.slice(0, 200) }, by);
  return next.bans;
}

export async function removeBan(ip: string, by: string): Promise<SiteBan[]> {
  const site = await readSiteSettings();
  const next = await writeSiteSettings({ bans: site.bans.filter((b) => b.ip !== ip) }, by);
  return next.bans;
}

/** lift every ban at once — the big red button in the admin's ban list */
export async function clearAllBans(by: string): Promise<SiteBan[]> {
  const next = await writeSiteSettings({ bans: [] }, by);
  return next.bans;
}

/* ---------- site settings store (github-backed, sqlite fallback) ---------- */

export interface SiteBan {
  ip: string;
  id: string;
  at: number;
  by: string;
}

export interface SiteSettings {
  /** sha256(SALT + gatePassword) — null = the built-in default is in charge */
  hash: string | null;
  lockdown: boolean;
  /** banned machines: refused at the gate, at /api/auth, everywhere */
  bans: SiteBan[];
  updatedAt: number;
  updatedBy: string;
}

const DEFAULT_SITE: SiteSettings = { hash: null, lockdown: false, bans: [], updatedAt: 0, updatedBy: "system" };

const REPO = process.env.GITHUB_CHAT_REPO || "imongithublolo/scraped";
const FILE = "site.json";
const PREFIX = "murke-admin";
const BRANCH = process.env.GITHUB_CHAT_BRANCH || "";
const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;

function ghHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ""}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "murke-os-admin",
    "Content-Type": "application/json",
  };
}

function ghUrl(): string {
  const [owner, repo] = REPO.split("/");
  const ref = BRANCH ? `?ref=${encodeURIComponent(BRANCH)}` : "";
  return `${API}/repos/${owner}/${repo}/contents/${PREFIX}/${FILE}${ref}`;
}

function githubMode(): boolean {
  return Boolean(process.env.GITHUB_TOKEN);
}

/** In-memory mirror — cuts a read off every hot path, survives within an instance. */
let memo: { data: SiteSettings; at: number } | null = null;

export async function readSiteSettings(): Promise<SiteSettings> {
  if (memo && Date.now() - memo.at < 4000) return memo.data;
  let data: SiteSettings = DEFAULT_SITE;
  try {
    if (githubMode()) {
      const res = await fetch(ghUrl(), { headers: ghHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
      if (res.status === 404) data = DEFAULT_SITE;
      else if (res.ok) {
        const body = (await res.json()) as { content?: string; encoding?: string };
        const raw = body.encoding === "base64" && typeof body.content === "string" ? Buffer.from(body.content, "base64").toString("utf8") : "";
        data = raw.trim() ? ({ ...DEFAULT_SITE, ...(JSON.parse(raw) as SiteSettings) } as SiteSettings) : DEFAULT_SITE;
        if (!Array.isArray(data.bans)) data.bans = [];
      }
    } else {
      const { db } = await import("@/lib/db");
      const row = await db.chatStore.findUnique({ where: { key: `${PREFIX}/${FILE}` } });
      data = row?.value ? ({ ...DEFAULT_SITE, ...(JSON.parse(row.value) as SiteSettings) } as SiteSettings) : DEFAULT_SITE;
      if (!Array.isArray(data.bans)) data.bans = [];
    }
  } catch {
    data = memo?.data ?? DEFAULT_SITE; // backend hiccup → last known good
  }
  memo = { data, at: Date.now() };
  return data;
}

export async function writeSiteSettings(patch: Partial<SiteSettings>, updatedBy: string): Promise<SiteSettings> {
  const cur = await readSiteSettings();
  const next: SiteSettings = { ...cur, ...patch, updatedAt: Date.now(), updatedBy };
  memo = { data: next, at: Date.now() };
  if (githubMode()) {
    // read-for-sha, then put; one conflict retry
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(ghUrl(), { headers: ghHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
      const sha = res.ok ? ((await res.json()) as { sha?: string }).sha ?? null : null;
      const put = await fetch(ghUrl(), {
        method: "PUT",
        headers: ghHeaders(),
        body: JSON.stringify({
          message: `murke-admin: site settings update (${updatedBy})`,
          content: Buffer.from(JSON.stringify(next), "utf8").toString("base64"),
          ...(sha ? { sha } : {}),
          ...(BRANCH ? { branch: BRANCH } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
      if (put.ok || (put.status !== 409 && put.status !== 422)) break;
    }
  } else {
    const { db } = await import("@/lib/db");
    const key = `${PREFIX}/${FILE}`;
    await db.chatStore.upsert({ where: { key }, update: { value: JSON.stringify(next) }, create: { key, value: JSON.stringify(next) } });
  }
  return next;
}
