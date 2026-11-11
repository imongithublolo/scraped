import { NextRequest, NextResponse } from "next/server";
import { adminFromRequest, readSiteSettings } from "@/lib/murke/admin-store";

/**
 * GET /api/admin/users (admin bearer) -> { ok, users }
 *
 * Live presence: every authenticated desktop pings /api/presence ~every
 * 25s with a snapshot of its browser search history + files app listing.
 * This route hands that back to the admin — sessions not seen for 3
 * minutes drop off the board. In-memory per instance: presence is about
 * RIGHT NOW, not history.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface PresenceSnapshot {
  history?: Array<{ t: string; u: string }>;
  files?: Array<{ p: string; s?: number }>;
  screen?: unknown;
  activity?: unknown;
}

export interface PresenceSession {
  id: string;
  ip: string;
  ua: string;
  firstSeen: number;
  lastSeen: number;
  history: Array<{ t: string; u: string }>;
  files: Array<{ p: string; s?: number }>;
  /** last jpeg frame of their screen (data url) — set when the admin watches */
  screen?: string;
  screenAt?: number;
  /** what they're doing — open apps + focused one */
  activity?: string;
}

/** presence lives on globalThis so dev HMR doesn't wipe it */
const g = globalThis as typeof globalThis & { __murkePresence?: Map<string, PresenceSession> };
export const PRESENCE: Map<string, PresenceSession> = (g.__murkePresence ??= new Map());

const SESSION_TTL_MS = 3 * 60 * 1000;
const MAX_HISTORY = 40;
const MAX_FILES = 80;

export function recordPresence(
  id: string,
  ip: string,
  ua: string,
  snap: PresenceSnapshot,
): PresenceSession {
  const now = Date.now();
  const prev = PRESENCE.get(id);
  const session: PresenceSession = {
    id,
    ip,
    ua,
    firstSeen: prev?.firstSeen ?? now,
    lastSeen: now,
    history: Array.isArray(snap.history) ? snap.history.slice(0, MAX_HISTORY) : prev?.history ?? [],
    files: Array.isArray(snap.files) ? snap.files.slice(0, MAX_FILES) : prev?.files ?? [],
    screen: typeof snap.screen === "string" && snap.screen.startsWith("data:image") && snap.screen.length <= 700_000 ? snap.screen : prev?.screen,
    screenAt: typeof snap.screen === "string" ? now : prev?.screenAt,
    activity: typeof snap.activity === "string" ? snap.activity.slice(0, 140) : prev?.activity,
  };
  PRESENCE.set(id, session);
  // prune while we're here
  for (const [k, s] of PRESENCE) {
    if (now - s.lastSeen > SESSION_TTL_MS) PRESENCE.delete(k);
  }
  return session;
}

export async function GET(req: NextRequest) {
  if (!adminFromRequest(req)) {
    return NextResponse.json({ ok: false, error: "denied" }, { status: 401 });
  }
  const now = Date.now();
  const users = [...PRESENCE.values()]
    .filter((s) => now - s.lastSeen <= SESSION_TTL_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen);
  const site = await readSiteSettings();
  return NextResponse.json({ ok: true, users, bans: site.bans, lockdown: site.lockdown, serverTime: now });
}
