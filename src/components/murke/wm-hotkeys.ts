"use client";

import { useEffect } from "react";
import type { AppId } from "@/lib/murke/contracts";
import { useOS } from "@/lib/murke/os-store";

/** Super+1..7 launch order (dock-ish) */
const LAUNCH_ORDER: readonly AppId[] = ["dsh", "files", "browser", "notes", "chat", "paint", "settings"] as const;

/**
 * useWmHotkeys — global keyboard tiling for DAEMON OS. Mount once (Desktop),
 * deps []: every event reads fresh state through useOS.getState(), so there
 * is zero re-subscribe churn and settings toggles apply immediately.
 *
 *   Super+←/→        snap active window to left/right half
 *   Super+↑          snap active window to max
 *   Super+↓          minimize active window
 *   Super+T/B/E      open terminal / browser / files
 *   Super+F          zoom (toggle maximize) the active window
 *   Super+Q          close the active window
 *   Super+1..7       launch app by index (LAUNCH_ORDER)
 *   Alt+Tab          cycle window focus forward (Alt+Shift+Tab backward)
 *
 * Arbitration: Alt+Tab and Super combos fire anywhere — including while a
 * text input / textarea / contenteditable is focused — which is exactly the
 * carve-out the WM spec asks for; no other key families are handled here.
 * Snap-like actions (arrows, F, Q) skip e.repeat; Alt+Tab intentionally
 * repeats so held-Alt tab-tapping keeps cycling.
 */
export function useWmHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!useOS.getState().settings.wm.hotkeys) return;

      /* Alt+Tab — window cycling; allowed even in text fields */
      if (e.altKey && e.key === "Tab") {
        e.preventDefault();
        if (!e.repeat) useOS.getState().cycleFocus(e.shiftKey ? -1 : 1);
        return;
      }

      /* everything below is a Super (Meta) combo */
      if (!e.metaKey || e.ctrlKey || e.altKey) return;

      const st = useOS.getState();
      const win = st.activeId != null ? st.windows.find((w) => w.id === st.activeId && !w.closing) : undefined;

      switch (e.code) {
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown":
          e.preventDefault();
          if (e.repeat || !win) return;
          if (e.code === "ArrowDown") st.minimizeWindow(win.id);
          else st.snapWindow(win.id, e.code === "ArrowLeft" ? "left" : e.code === "ArrowRight" ? "right" : "max");
          return;
        case "KeyF":
          e.preventDefault();
          if (e.repeat || !win) return;
          st.toggleZoom(win.id);
          return;
        case "KeyQ":
          e.preventDefault();
          if (e.repeat || !win) return;
          st.closeWindow(win.id);
          return;
        case "KeyT":
          e.preventDefault();
          st.openApp("dsh");
          return;
        case "KeyB":
          e.preventDefault();
          st.openApp("browser");
          return;
        case "KeyE":
          e.preventDefault();
          st.openApp("files");
          return;
        default:
          if (e.key >= "1" && e.key <= "7") {
            e.preventDefault();
            st.openApp(LAUNCH_ORDER[Number(e.key) - 1]);
          }
      }
    };
    window.addEventListener("keydown", onKey, false);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
