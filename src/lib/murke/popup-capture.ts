/**
 * Popup capture — proxied frames must never escape into REAL browser tabs.
 *
 * Inside a scramjet frame, `window.open` (JS popups) and `<a target="_blank">`
 * links open genuine browser tabs with encoded /service/ urls — the user
 * leaves the OS. This module patches a frame's contentWindow so both paths
 * are captured: the raw (encoded) url is dispatched to the desktop as
 * "murke-capture-popup" { raw, winId }, the desktop decodes it and opens it
 * in an OS browser window/tab instead. The popup call returns a tiny stub
 * window so guest scripts that use the return value keep working.
 *
 * Fresh documents drop the patches (exactly like the in-frame key handler),
 * so callers re-run installPopupCapture on a sweep — a marker symbol keeps
 * re-patching idempotent and cheap.
 */

const CAPTURED = Symbol.for("murke.popup-captured");

/** the stub handed back to guest scripts — truthy, inert, harmless */
function popupStub(): Window {
  const stub = {
    closed: false,
    close() {},
    focus() {},
    blur() {},
    print() {},
    postMessage() {},
    moveTo() {},
    resizeTo() {},
    opener: null,
    location: "about:blank",
  };
  return stub as unknown as Window;
}

function report(raw: string, winId: number): void {
  if (!raw) return;
  try {
    // same-origin frames may touch top; fall back to self just in case
    (window.top ?? window).dispatchEvent(
      new CustomEvent("murke-capture-popup", { detail: { raw, winId } }),
    );
  } catch {
    /* ignore */
  }
}

/**
 * Patch one frame window: `open` + capture-phase anchor click guard.
 * Safe to call repeatedly — the marker symbol makes it a no-op after the
 * first patch of a given window.
 */
export function installPopupCapture(win: Window | null, winId: number): void {
  if (!win) return;
  try {
    const w = win as Window & { [CAPTURED]?: boolean };
    if (w[CAPTURED]) return;
    w[CAPTURED] = true;

    /* JS popups — window.open(...) from guest scripts */
    w.open = ((url?: string | URL, target?: string, features?: string) => {
      const raw = url ? String(url) : "";
      // "_top"/"_self" navigations stay in the frame — only new contexts escape
      const t = (target ?? "").toLowerCase();
      if (raw && t !== "_top" && t !== "_self" && t !== "_parent") report(raw, winId);
      return popupStub();
    }) as typeof w.open;

    /* <a target="_blank"> (and <form target="_blank">) — capture phase,
       before scramjet's own click proxy sends the browser off-site */
    const onClick = (e: MouseEvent) => {
      try {
        if (e.defaultPrevented || e.button !== 0) return;
        const path = e.composedPath();
        for (const node of path) {
          const el = node as Element | null;
          if (!el || typeof el.closest !== "function") continue;
          const a = el.closest("a[target], form[target], area[target]");
          if (!a) continue;
          const tag = a.tagName;
          const t = (a.getAttribute("target") ?? "").toLowerCase();
          if (!t || t === "_self" || t === "_top" || t === "_parent") return;
          const raw =
            tag === "A" ? (a as HTMLAnchorElement).href : tag === "AREA" ? (a as HTMLAreaElement).href : (a as HTMLFormElement).action;
          if (raw) {
            e.preventDefault();
            e.stopPropagation();
            report(raw, winId);
          }
          return;
        }
      } catch {
        /* ignore */
      }
    };
    w.document?.addEventListener("click", onClick, true);
  } catch {
    /* frame not ready / cross-origin — the sweep retries */
  }
}
