"use client";

/**
 * frame-keys — the shell's ears, extended into every same-origin child frame.
 *
 * Keyboard events never cross document boundaries: the moment the user
 * clicks inside the proxied page (the scramjet iframe — which is the whole
 * point of this site), keydowns live and die inside the frame and the OS
 * shell goes deaf — the spotlight hotkey, everything. This relay walks the
 * frame tree (same-origin only; cross-origin frames stay untouched and
 * silent), attaches one keydown listener per reachable window, and forwards
 * every event to the parent-world handler.
 *
 * Rescans are lazy and cheap: on every forwarded event, on top-document
 * mutations and on a slow interval, so frames that spawn frames get heard
 * too. An explicit Set keeps the wiring idempotent (one listener per window,
 * ever) and lets stop() detach everything it attached.
 */

export interface FrameKeysHandle {
  stop: () => void;
}

export const FRAME_WINDOW_EVENT = "frost-frame-window";

/** BareFrame announces each frame's FINAL window through this — the
    browsing-context window can be swapped by the proxy engine during
    navigation, and a scan that ran before the swap wired a dead object. */
export function announceFrameWindow(win: Window | null): void {
  if (!win) return;
  try {
    window.dispatchEvent(new CustomEvent(FRAME_WINDOW_EVENT, { detail: win }));
  } catch {
    /* a dead window — nothing to announce */
  }
}

export function watchFrameKeys(
  handler: (e: KeyboardEvent) => void,
  opts: { intervalMs?: number } = {},
): FrameKeysHandle {
  const wired = new Set<Window>();
  const intervalMs = opts.intervalMs ?? 1500;

  const onKey = (e: Event): void => {
    scan(); // lazy rescan — a frame we just heard from may have grown children
    handler(e as KeyboardEvent);
  };

  /** wire one window if same-origin and not yet wired; false = cross-origin */
  const listen = (win: Window | null): boolean => {
    if (!win) return false;
    try {
      void win.location.href; // same-origin probe — cross-origin throws
    } catch {
      return false;
    }
    if (wired.has(win)) return true;
    wired.add(win);
    win.addEventListener("keydown", onKey);
    return true;
  };

  const scan = (): void => {
    if (!listen(window)) return; // never — but keeps types honest
    const walk = (win: Window, depth: number): void => {
      if (depth > 4) return; // frame trees are shallow in practice
      let doc: Document;
      try {
        doc = win.document;
      } catch {
        return;
      }
      for (const el of Array.from(doc.querySelectorAll("iframe,frame"))) {
        let inner: Window | null = null;
        try {
          if (el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement) {
            inner = el.contentWindow;
          }
        } catch {
          /* cross-origin — the relay stays outside */
        }
        if (listen(inner)) walk(inner as Window, depth + 1);
      }
    };
    walk(window, 0);
  };

  /* announced frames wire instantly — the scan stays as the safety net */
  const onAnnounce = (e: Event): void => {
    const win = (e as CustomEvent<Window>).detail;
    if (listen(win)) scan(); // and pick up anything nested inside it
  };
  window.addEventListener(FRAME_WINDOW_EVENT, onAnnounce);

  const mo = new MutationObserver(scan);
  scan();
  mo.observe(document.documentElement, { childList: true, subtree: true });
  const timer = window.setInterval(scan, intervalMs);

  return {
    stop: () => {
      window.clearInterval(timer);
      window.removeEventListener(FRAME_WINDOW_EVENT, onAnnounce);
      mo.disconnect();
      for (const win of wired) {
        try {
          win.removeEventListener("keydown", onKey);
        } catch {
          /* a dead frame — nothing to detach */
        }
      }
      wired.clear();
    },
  };
}
