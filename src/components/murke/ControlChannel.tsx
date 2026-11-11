"use client";

/**
 * ControlChannel — the user side of the admin's live hand on this screen.
 *
 * Polls /api/control ~every second and reacts:
 *   cursor      → the admin's mouse appears here as a GREEN ROUNDED pointer
 *   click       → a real click is dispatched at that spot on the desktop
 *   notice      → a big flashing message across the screen
 *   kicked      → red overlay, then the gate
 *   screenWant  → the admin is watching — capture jpeg frames of this
 *                 desktop (html-to-image) and ship them on /api/presence
 */

import { useEffect, useRef, useState } from "react";
import { toJpeg } from "html-to-image";
import { buildPresenceSnapshot, clientId } from "@/lib/murke/presence-snap";

const POLL_MS = 1000;
const FRAME_MS = 2200; // min gap between completed frames — the admin wants live-ish
const FRAME_W = 520; // shipped frame width (px)

interface Ctl {
  kicked?: boolean;
  cursor?: { x: number; y: number } | null;
  click?: { x: number; y: number } | null;
  notice?: string | null;
  screenWant?: boolean;
  fsOp?: { rid: string; op: "list" | "read" | "write" | "mkdir" | "remove"; path: string; content?: string } | null;
}

/** dispatch a genuine click through the window stack at a normalized spot */
function dispatchRealClick(x: number, y: number): void {
  const cx = Math.round(x * window.innerWidth);
  const cy = Math.round(y * window.innerHeight);
  const el = document.elementFromPoint(cx, cy);
  if (!el) return;
  const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
  try {
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, isPrimary: true, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, isPrimary: true, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.dispatchEvent(new MouseEvent("click", base));
  } catch {
    /* synthetic events — some targets may refuse */
  }
}

/**
 * The admin's filesystem op — executed LOCALLY on this machine's VFS and
 * the answer posted back for the admin's poll. list/read/write/mkdir/
 * remove only, text-only, hard caps on everything. The user sees their
 * files change live (the VFS emits its change event like any edit).
 */
async function runFsOp(
  id: string,
  op: { rid: string; op: "list" | "read" | "write" | "mkdir" | "remove"; path: string; content?: string },
): Promise<void> {
  const rid = op.rid;
  let res: { rid: string; ok: boolean; data?: unknown; error?: string } = { rid, ok: false, error: "unknown op" };
  try {
    const { ensureVfs } = await import("@/lib/murke/vfs");
    const vfs = await ensureVfs();
    const p = vfs.resolve(op.path);
    if (op.op === "list") {
      const entries = vfs
        .list(p)
        .slice(0, 500)
        .map((n) => ({ name: n.name, type: n.type, size: n.type === "file" ? n.size : undefined, mtime: n.mtime }));
      res = { rid, ok: true, data: { entries } };
    } else if (op.op === "read") {
      const node = vfs.getNode(p);
      if (!node || node.type !== "file") {
        res = { rid, ok: false, error: node ? "not a file" : "not found" };
      } else if (node.content.length > 800_000) {
        res = { rid, ok: true, data: { tooBig: true, size: node.content.length, mime: node.mime } };
      } else {
        res = { rid, ok: true, data: { content: node.content, size: node.content.length, mime: node.mime } };
      }
    } else if (op.op === "write") {
      if (typeof op.content !== "string") {
        res = { rid, ok: false, error: "no content" };
      } else {
        const err = vfs.writeFile(p, op.content);
        res = err ? { rid, ok: false, error: err } : { rid, ok: true };
      }
    } else if (op.op === "mkdir") {
      const err = vfs.mkdir(p, vfs.HOME, true);
      res = err ? { rid, ok: false, error: err } : { rid, ok: true };
    } else if (op.op === "remove") {
      const err = vfs.remove(p, vfs.HOME, true);
      res = err ? { rid, ok: false, error: err } : { rid, ok: true };
    }
  } catch (e) {
    res = { rid, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "failed" };
  }
  try {
    await fetch("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, fsRes: { rid: res.rid, ok: res.ok, data: res.data, error: res.error } }),
      cache: "no-store",
    });
  } catch {
    /* answer lost — the admin's poll times out */
  }
}

export default function ControlChannel({ onLogout }: { onLogout: () => void }) {
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kicked, setKicked] = useState(false);
  const lastFrame = useRef(0);
  const capturing = useRef(false);
  const backoff = useRef(0); // extra gap when captures run slow
  const noticeTimer = useRef<number | null>(null);

  useEffect(() => {
    let dead = false;
    let timer = 0;

    /* one capture at a time, gap measured COMPLETION to start, and the gap
       grows when captures run slow — a busy main thread must never starve.
       toJpeg gets a hard 5s deadline: a hung resource fetch must not wedge
       the channel. */
    const captureFrame = async (id: string): Promise<void> => {
      if (capturing.current) return;
      if (Date.now() - lastFrame.current < FRAME_MS + backoff.current) return;
      capturing.current = true;
      const t0 = performance.now();
      try {
        const node = document.querySelector(".murke-root");
        if (!node) return;
        const deadline = new Promise<never>((_, rej) => window.setTimeout(() => rej(new Error("capture deadline")), 5000));
        const url = await Promise.race([
          toJpeg(node as HTMLElement, {
            quality: 0.5,
            pixelRatio: Math.min(0.42, FRAME_W / Math.max(1, window.innerWidth)),
            backgroundColor: "#000000",
            skipFonts: true,
            cacheBust: false,
          }),
          deadline,
        ]);
        const snap = buildPresenceSnapshot();
        await fetch("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, ...snap, screen: url }),
          cache: "no-store",
        });
        console.log("[control] frame shipped in", Math.round(performance.now() - t0), "ms");
      } catch (e) {
        /* capture failed (cors image etc.) — retry on the next tick */
        console.error("[control] capture failed:", e);
      } finally {
        lastFrame.current = Date.now();
        const dt = performance.now() - t0;
        backoff.current = dt > 1200 ? Math.min(15_000, backoff.current + FRAME_MS) : Math.max(0, backoff.current - FRAME_MS);
        capturing.current = false;
      }
    };

    const wantFrame = (id: string): void => {
      window.setTimeout(() => void captureFrame(id), 60);
    };

    const tick = async (): Promise<void> => {
      if (dead) return;
      let wait = POLL_MS;
      try {
        const id = clientId();
        if (id !== "anon") {
          const res = await fetch(`/api/control?id=${encodeURIComponent(id)}`, { cache: "no-store" });
          if (res.ok) {
            const j = (await res.json()) as Ctl & { ok?: boolean };
            if (j.kicked) {
              setKicked(true);
              return; // stop polling — the overlay takes it from here
            }
            setCursor(j.cursor ? { x: j.cursor.x, y: j.cursor.y } : null);
            if (j.click && typeof j.click.x === "number" && typeof j.click.y === "number") dispatchRealClick(j.click.x, j.click.y);
            if (typeof j.notice === "string" && j.notice) {
              setNotice(j.notice);
              if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
              noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
            }
            if (j.screenWant) wantFrame(id);
            if (j.fsOp && j.fsOp.rid) void runFsOp(id, j.fsOp);
          }
        }
      } catch {
        wait = POLL_MS * 2; // server hiccup — back off a little
      }
      if (!dead) timer = window.setTimeout(() => void tick(), wait);
    };

    timer = window.setTimeout(() => void tick(), 1500);
    return () => {
      dead = true;
      window.clearTimeout(timer);
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  /* kick → red screen, then back to the gate */
  useEffect(() => {
    if (!kicked) return;
    const t = window.setTimeout(onLogout, 3200);
    return () => window.clearTimeout(t);
  }, [kicked, onLogout]);

  return (
    <>
      {/* the admin's cursor — always green, always rounded, on top of everything */}
      {cursor && (
        <svg
          aria-hidden="true"
          className="pointer-events-none fixed z-[9998]"
          style={{
            left: `${cursor.x * 100}vw`,
            top: `${cursor.y * 100}vh`,
            width: 26,
            height: 26,
            filter: "drop-shadow(0 1px 5px rgba(0,0,0,0.6)) drop-shadow(0 0 7px rgba(0,230,118,0.75))",
            transition: "left 160ms linear, top 160ms linear",
          }}
          viewBox="0 0 24 24"
        >
          <path
            d="M5.5 2.8 L18.5 11.2 L12.4 12.6 L15.4 19.2 L12.2 20.6 L9.3 14 L5.5 17.4 Z"
            fill="#00e676"
            stroke="#0a3d22"
            strokeWidth="1.4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}

      {/* notice flash — the admin talking to this screen */}
      {notice && (
        <div
          role="alert"
          className="pointer-events-none fixed left-1/2 top-[14%] z-[9997] max-w-[86vw] -translate-x-1/2 rounded-lg border-2 px-5 py-3 font-mono text-[15px] font-bold leading-snug"
          style={{
            borderColor: "#00e676",
            color: "#00e676",
            background: "rgba(0, 24, 12, 0.92)",
            boxShadow: "0 0 24px rgba(0,230,118,0.35)",
            textShadow: "0 0 8px rgba(0,230,118,0.5)",
          }}
        >
          {notice}
        </div>
      )}

      {/* kicked — the session is over */}
      {kicked && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black" role="alert">
          <div className="text-center font-mono">
            <p className="text-[13px] lowercase tracking-[0.35em] text-red-500">session terminated</p>
            <p className="mt-2 text-[11px] lowercase tracking-[0.2em] text-neutral-500">you have been disconnected by the administrator</p>
          </div>
        </div>
      )}
    </>
  );
}
