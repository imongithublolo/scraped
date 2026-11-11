"use client";

/**
 * BareFrame — one raw scramjet frame, edge to edge. No tabs, no chrome of
 * its own: the site IS the screen. Mounted ONCE PER TAB (key={tab id}):
 * the frame survives every navigation inside the tab — the url prop drives
 * `handle.go()` when it changes, so back/forward state, scroll and session
 * live as long as the tab does. Inactive tabs keep their frames mounted
 * but hidden (visibility, not display) — switching is instant.
 *
 * Keyboard inside the frame: the proxy engine can swap the frame's window
 * object under our feet while it navigates, so the bind re-attaches on
 * every load, after every go() and on a slow self-heal tick — document
 * capture (real typing) plus the window object (direct dispatch). The
 * parent world hears every key through onFrameKey.
 *
 * A 2px loading strip is the only murke thing that ever exists — it
 * dissolves the moment the frame answers.
 */

import { useEffect, useRef, useState } from "react";
import type { ProxyEngine, ProxyFrameHandle } from "@/lib/murke/contracts";

export default function BareFrame({
  url,
  proxy,
  onFrame,
  onFrameKey,
  onFrameWake,
  onNavigate,
}: {
  /** where this tab should be — changes are driven through handle.go() */
  url: string;
  proxy: ProxyEngine;
  /** hand the live frame handle up (history back/forward, devtools) */
  onFrame?: (h: ProxyFrameHandle | null) => void;
  /** every keydown inside the proxied page, wherever focus sits */
  onFrameKey?: (e: KeyboardEvent) => void;
  /** pointer/wheel life inside the proxied page — the parent's floating
   *  chrome melts on idle and ONLY a movement inside the frame can bring
   *  it back (pointer events over an iframe never reach the parent
   *  window — without this relay the controls would stay melted forever) */
  onFrameWake?: () => void;
  /** every load + urlchange: the real url and the document title (for the
      tab rail, the omnibox and the blur transition's end) */
  onNavigate?: (realUrl: string, title: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const keyRef = useRef(onFrameKey);
  useEffect(() => {
    keyRef.current = onFrameKey;
  }, [onFrameKey]);
  const wakeRef = useRef(onFrameWake);
  useEffect(() => {
    wakeRef.current = onFrameWake;
  }, [onFrameWake]);
  const navRef = useRef(onNavigate);
  useEffect(() => {
    navRef.current = onNavigate;
  }, [onNavigate]);

  /* the live handle + the last url we drove it to. url prop changes after
     creation navigate the SAME frame — the tab keeps its history. */
  const handleRef = useRef<ProxyFrameHandle | null>(null);
  const lastNav = useRef("");
  const urlRef = useRef(url);

  const report = (h: ProxyFrameHandle | null) => {
    if (!h) return;
    try {
      navRef.current?.(h.getUrl() || lastNav.current, titleOf(h));
    } catch {
      /* mid-swap — the next load reports again */
    }
  };

  useEffect(() => {
    urlRef.current = url;
    const h = handleRef.current;
    if (!h || !url) return;
    // the frame may already be there on its own (link clicks, redirects
    // reported back through onNavigate) — never replay a navigation the
    // tab performed itself
    let live = "";
    try {
      live = h.getUrl();
    } catch {
      live = "";
    }
    if (url === live) {
      lastNav.current = url;
      return;
    }
    if (url !== lastNav.current) {
      lastNav.current = url;
      // deferred — a sync setState here would cascade renders (the go()
      // below re-entering the effect chain is enough to coordinate)
      queueMicrotask(() => setLoading(true));
      h.go(url);
    }
  }, [url]);

  useEffect(() => {
    let dead = false;
    let el: HTMLIFrameElement | null = null;
    // loading starts true (fresh mount per tab)
    const wiredWins = new WeakSet<Window>();
    const wiredDocs = new WeakSet<Document>();

    const forward = (e: Event): void => {
      keyRef.current?.(e as KeyboardEvent);
    };

    /* the wake relay — pointer/wheel life from inside the frame, throttled
       to the browser's own event cadence (a no-op when the parent ignores
       it, which is most of the time) */
    let lastWake = 0;
    const forwardWake = (): void => {
      const now = Date.now();
      if (now - lastWake < 120) return;
      lastWake = now;
      wakeRef.current?.();
    };

    /* bind the CURRENT window+document of the frame — idempotent */
    const bind = (): void => {
      if (dead || !el) return;
      try {
        const w = el.contentWindow;
        const d = el.contentDocument;
        if (!w || !d) return;
        void w.location.href; // same-origin probe — cross-origin throws
        if (!wiredWins.has(w)) {
          wiredWins.add(w);
          w.addEventListener("keydown", forward);
          w.addEventListener("pointermove", forwardWake, { passive: true });
          w.addEventListener("pointerdown", forwardWake, { passive: true });
          w.addEventListener("wheel", forwardWake, { passive: true });
          w.addEventListener("touchstart", forwardWake, { passive: true });
        }
        if (!wiredDocs.has(d)) {
          wiredDocs.add(d);
          d.addEventListener("keydown", forward, true);
          d.addEventListener("pointermove", forwardWake, { passive: true, capture: true });
          d.addEventListener("wheel", forwardWake, { passive: true, capture: true });
          d.addEventListener("touchstart", forwardWake, { passive: true, capture: true });
        }
      } catch {
        /* cross-origin or torn down — the next tick retries */
      }
    };
    const heal = window.setInterval(bind, 700);

    void (async () => {
      try {
        const ok = await proxy.init();
        if (dead) return;
        if (!ok.ok) {
          setLoading(false);
          return; // stays blank — never reveals what this machine is
        }
        const handle = proxy.createFrame();
        handleRef.current = handle;
        el = handle.el as HTMLIFrameElement;
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.border = "0";
        el.style.display = "block";
        el.addEventListener("load", () => {
          setLoading(false);
          bind(); // every load can mean a fresh window — rebind immediately
          report(handle);
        });
        if (hostRef.current && !dead) hostRef.current.appendChild(el);
        handle.onUrl(() => {
          setLoading(false);
          report(handle);
        });
        onFrame?.(handle);
        if (urlRef.current) {
          lastNav.current = urlRef.current;
          handle.go(urlRef.current);
        }
        bind();
      } catch {
        if (!dead) setLoading(false);
      }
    })();
    return () => {
      dead = true;
      window.clearInterval(heal);
      handleRef.current = null;
      onFrame?.(null);
      // the frame dies with its host — no explicit teardown
    };
  }, [proxy]);

  return (
    <div className="relative h-full w-full bg-white">
      <div ref={hostRef} className="h-full w-full" />
      {loading && (
        <div className="absolute left-0 top-0 z-10 h-[2px] w-full overflow-hidden" aria-hidden="true">
          <div className="frost-bare-loading h-full w-1/3 rounded-full" />
        </div>
      )}
    </div>
  );
}

/** the proxied document's <title> — same-origin through the relay, so it
    reads directly; cross-origin moments answer "" quietly */
function titleOf(h: ProxyFrameHandle): string {
  try {
    const el = h.el as HTMLIFrameElement;
    return el.contentDocument?.title?.trim() ?? "";
  } catch {
    return "";
  }
}
