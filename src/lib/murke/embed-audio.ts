/**
 * THE EMBED AUDIO ENGINE — the always-works playback path.
 *
 * When every stream resolver fails (bot-walled egress, dead instances,
 * IP-locked tunnels), youtube's OWN player still serves itself to the
 * USER's browser: their residential IP, no bot wall, no third party,
 * FULL LENGTH — the real answer to "keeps going to 30s preview".
 *
 * A hidden offscreen iframe hosts the COEP-free /ytframe.html shim, which
 * loads youtube's IFrame API and reports play state over postMessage
 * (see public/ytframe.html for the protocol). This module wraps that in
 * a tiny controller the music player drives exactly like a howl:
 * play/pause/seek/volume + time ticks + ended + error.
 *
 * Only one embed exists at a time (the player has one "current track").
 * The iframe is parked offscreen (not display:none — youtube refuses to
 * start playback in fully hidden frames).
 */

export interface EmbedState {
  time: number;
  dur: number;
  playing: boolean;
}

export interface EmbedCallbacks {
  /** every shim tick (500ms) + immediately on ready */
  onState?: (s: EmbedState) => void;
  /** natural end of the track */
  onEnded?: () => void;
  /** the video cannot be embedded / played at all (deleted, region-locked) */
  onError?: (code: string) => void;
  /** autoplay with sound was refused — the UI should show a "tap to start" */
  onBlocked?: () => void;
}

export interface EmbedController {
  /** 0..100 — mirrors player volume */
  setVolume(pct: number): void;
  pause(): void;
  resume(): void;
  seek(sec: number): void;
  playing(): boolean;
  time(): number;
  dur(): number;
  destroy(): void;
}

let active: {
  videoId: string;
  frame: HTMLIFrameElement;
  state: EmbedState;
  cb: EmbedCallbacks;
  vol: number;
  blocked: boolean;
  dead: boolean;
} | null = null;

function iframeReady(frame: HTMLIFrameElement): boolean {
  try {
    return frame.contentWindow?.document.readyState === "complete";
  } catch {
    // cross-origin document (youtube-nocookie inside) — the frame loaded
    return true;
  }
}

function post(msg: Record<string, unknown>): void {
  if (!active) return;
  try {
    active.frame.contentWindow?.postMessage(msg, window.location.origin);
  } catch {
    /* frame gone */
  }
}

function destroyActive(): void {
  const a = active;
  if (!a) return;
  active = null;
  a.dead = true;
  try {
    a.frame.remove();
  } catch {
    /* already gone */
  }
}

/** true when the CURRENT embed is playing this exact video */
export function embedIsActive(videoId: string): boolean {
  return active?.videoId === videoId;
}

/** singleton start: replaces any existing embed. Resolves once the shim
 *  reports ready (or throws when the shim errors out — bad id, api dead). */
export function embedPlay(
  videoId: string,
  opts?: { volumePct?: number; callbacks?: EmbedCallbacks },
): EmbedController {
  destroyActive();
  const cb = opts?.callbacks ?? {};
  const vol = Math.max(0, Math.min(100, Math.round(opts?.volumePct ?? 80)));

  const frame = document.createElement("iframe");
  frame.src =
    `/ytframe.html?v=${encodeURIComponent(videoId)}` +
    `&vol=${vol}&fallbackmute=0`;
  frame.title = "youtube audio player";
  frame.allow = "autoplay; encrypted-media; picture-in-picture";
  frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  // offscreen but RENDERED — display:none frames never start playback
  frame.style.cssText =
    "position:fixed;left:-99999px;top:0;width:320px;height:180px;border:0;opacity:0.01;pointer-events:none;";

  const st: EmbedState = { time: 0, dur: 0, playing: false };
  const rec = { videoId, frame, state: st, cb, vol, blocked: false, dead: false };
  active = rec;

  window.addEventListener("message", onMessage);

  function onMessage(ev: MessageEvent) {
    const a = active;
    if (!a || a.dead || ev.source !== a.frame.contentWindow) return;
    const d = ev.data as { murkeYt?: string; t?: number; dur?: number; playing?: boolean; code?: string | number };
    if (!d || typeof d.murkeYt !== "string") return;
    switch (d.murkeYt) {
      case "ready":
        cb.onState?.({ ...a.state });
        break;
      case "tick":
        a.state = {
          time: typeof d.t === "number" ? d.t : 0,
          dur: typeof d.dur === "number" ? d.dur : 0,
          playing: d.playing === true,
        };
        if (a.state.playing) a.blocked = false;
        cb.onState?.({ ...a.state });
        break;
      case "ended":
        cb.onEnded?.();
        break;
      case "blocked":
        a.blocked = true;
        cb.onBlocked?.();
        break;
      case "error":
        cb.onError?.(String(d.code ?? "unknown"));
        break;
    }
  }

  function detach() {
    window.removeEventListener("message", onMessage);
  }

  document.body.appendChild(frame);

  return {
    setVolume(pct: number) {
      const v = Math.max(0, Math.min(100, Math.round(pct)));
      rec.vol = v;
      post({ murkeYt: "vol", v });
    },
    pause() {
      post({ murkeYt: "pause" });
      // optimistic — the tick lands within 500ms, but the toggle button
      // must read the INTENDED state the instant it is clicked (the stale
      // true used to make a fast double-click flip pause into resume)
      if (active === rec) rec.state = { ...rec.state, playing: false };
    },
    resume() {
      // resume after a blocked autoplay = a real user gesture on our page —
      // the embed inherits it and plays with sound
      rec.blocked = false;
      post({ murkeYt: "play" });
      if (active === rec) rec.state = { ...rec.state, playing: true };
    },
    seek(sec: number) {
      post({ murkeYt: "seek", t: Math.max(0, sec) });
    },
    playing() {
      return active?.videoId === videoId && rec.state.playing;
    },
    time() {
      return rec.state.time;
    },
    dur() {
      return rec.state.dur;
    },
    destroy() {
      if (active?.videoId === videoId) {
        detach();
        destroyActive();
      }
    },
  };
}

/** stop + remove whatever embed is live (player stop/clear/track swap) */
export function embedStop(): void {
  destroyActive();
}

/** iframe-readiness probe used by the player's watchdog */
export function embedLooksAlive(): boolean {
  if (!active) return false;
  return active.state.playing || active.state.dur > 0 || active.state.time > 0 || iframeReady(active.frame);
}
