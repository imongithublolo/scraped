"use client";

/**
 * pwa — an installed web app running STANDALONE. This is the "invisible
 * browser": the page renders edge-to-edge inside its own mac window with
 * the app's name in the title bar — no tabs, no omnibox, no browser icon,
 * no letter tile. The browser chrome simply doesn't exist here.
 *
 * Traffic still flows through the same scramjet engine the browser uses
 * (init is idempotent and shared), so sites that block direct embedding
 * work exactly like they do in a tab.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Loader2, RotateCw } from "lucide-react";
import type { ProxyFrameHandle, ProxyEngine } from "@/lib/murke/contracts";
import { installPopupCapture } from "@/lib/murke/popup-capture";
import { useOS } from "@/lib/murke/os-store";

type Phase = "init" | "loading" | "ok" | "error";

export default function PwaAppView({ arg, proxy }: { arg?: string; proxy: ProxyEngine }) {
  const customApps = useOS((s) => s.settings.customApps);
  const app = useMemo(() => customApps.find((a) => a.id === arg) ?? null, [customApps, arg]);
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<ProxyFrameHandle | null>(null);
  const [phase, setPhase] = useState<Phase>("init");
  const [err, setErr] = useState("");
  const [nonce, setNonce] = useState(0);

  const boot = useCallback(async () => {
    const url = app?.url;
    if (!url) return;
    setPhase("init");
    setErr("");
    try {
      const r = await proxy.init();
      if (!r.ok) {
        setErr(r.error ?? "proxy failed to initialize");
        setPhase("error");
        return;
      }
      /* fresh window mount: drop any stale frame, hang a new one */
      frameRef.current?.el.remove();
      frameRef.current = null;
      const handle = proxy.createFrame();
      const s = handle.el.style;
      s.position = "absolute";
      s.inset = "0";
      handle.onUrl(() => {
        /* first navigation under the frame = the app has landed */
        setPhase((p) => (p === "ok" ? p : "ok"));
      });
      frameRef.current = handle;
      if (hostRef.current && !hostRef.current.contains(handle.el)) hostRef.current.appendChild(handle.el);
      setPhase("loading");
      handle.go(url);
      /* failsafe: some apps never fire urlchange again (client-side routers) */
      window.setTimeout(() => setPhase((p) => (p === "loading" ? "ok" : p)), 6000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [app, proxy]);

  useEffect(() => {
    if (!app) return;
    /* async so the boot's synchronous setState isn't in the effect body */
    void Promise.resolve().then(boot);
    /* popups must never escape into real browser tabs — sweep the frame the
       same way the browser does (fresh documents drop the patches) */
    const iv = window.setInterval(() => {
      try {
        installPopupCapture(frameRef.current?.el.contentWindow ?? null, -1);
      } catch {
        /* frame not ready */
      }
    }, 900);
    return () => {
      window.clearInterval(iv);
      frameRef.current?.el.remove();
      frameRef.current = null;
    };
  }, [app, proxy, nonce]);

  /* the app was uninstalled while its window is open */
  if (!app) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--term-bg)] font-mono text-[12.5px] text-[var(--term-fg)]">
        <AppWindow size={40} strokeWidth={1} className="text-[var(--term-dim)] opacity-50" aria-hidden="true" />
        <p className="text-[var(--term-dim)]">this app was uninstalled</p>
        <p className="text-[10.5px] text-[var(--term-dim)] opacity-70">close the window — settings › apps manages installed apps</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--term-bg)]">
      {/* the frame host — the app IS the window body */}
      <div ref={hostRef} className="absolute inset-0" aria-label={`${app.name} app content`} />

      {phase !== "ok" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 font-mono text-[12.5px] text-[var(--term-fg)]" style={{ background: "color-mix(in srgb, var(--term-bg) 92%, transparent)" }}>
          {phase === "error" ? (
            <>
              <p className="text-[var(--term-err)]">{err || "could not load the app"}</p>
              <button
                type="button"
                onClick={() => setNonce((n) => n + 1)}
                className="flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11.5px] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)]"
                style={{ borderColor: "color-mix(in srgb, var(--term-fg) 24%, transparent)" }}
              >
                <RotateCw size={12} aria-hidden="true" /> retry
              </button>
            </>
          ) : (
            <>
              <Loader2 size={20} className="animate-spin text-[var(--term-brand)]" aria-hidden="true" />
              <p className="text-[var(--term-dim)]">starting {app.name.toLowerCase()}…</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
