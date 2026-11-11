"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProxyEngine, ProxyFrameHandle } from "@/lib/murke/contracts";

const PREFIX_RE = /^\/scramjet\//;

/** Decode a scramjet-routed URL back to something human readable. */
function displayUrl(u: string): string {
  try {
    const withoutPrefix = u.replace(PREFIX_RE, "");
    return decodeURIComponent(withoutPrefix);
  } catch {
    return u;
  }
}

/**
 * Browser app: a real windowed Scramjet browser. The proxy engine must be
 * initialized once (lazily awaited here) before frames can ride the relay.
 */
export default function BrowserApp({ url, proxy }: { url: string; proxy: ProxyEngine }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<ProxyFrameHandle | null>(null);
  const [state, setState] = useState<"init" | "ok" | "error">("init");
  const [error, setError] = useState<string>("");
  const [current, setCurrent] = useState<string>(url);
  const [address, setAddress] = useState<string>(url);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      const r = await proxy.init();
      if (dead) return;
      if (!r.ok) {
        setError(r.error ?? "proxy failed to initialize");
        setState("error");
        return;
      }
      try {
        const handle = proxy.createFrame();
        frameRef.current = handle;
        handle.onUrl((u) => {
          setCurrent(u);
          setAddress(displayUrl(u));
        });
        if (hostRef.current && !hostRef.current.contains(handle.el)) {
          hostRef.current.appendChild(handle.el);
        }
        handle.go(url);
        setCurrent("");
        setAddress(url);
        setState("ok");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setState("error");
      }
    })();
    return () => {
      dead = true;
      frameRef.current?.el.remove();
      frameRef.current = null;
    };
  }, [url]);

  const go = useCallback((raw: string) => {
    const s = raw.trim();
    if (!s) return;
    const looksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+/i.test(s);
    const target = looksUrl
      ? /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
        ? s
        : "https://" + s
      : "https://duckduckgo.com/?q=" + encodeURIComponent(s);
    setState("ok");
    setCurrent("");
    setAddress(target);
    frameRef.current?.go(target);
  }, []);

  const btn =
    "shrink-0 border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] px-2 py-0.5 text-[11px] text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_15%,transparent)]";

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-1.5">
        <button className={btn} onClick={() => frameRef.current?.back()} title="back" aria-label="back">
          &larr;
        </button>
        <button className={btn} onClick={() => frameRef.current?.forward()} title="forward" aria-label="forward">
          &rarr;
        </button>
        <button className={btn} onClick={() => frameRef.current?.reload()} title="reload" aria-label="reload">
          ⟳
        </button>
        {editing ? (
          <input
            autoFocus
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setEditing(false);
                go(address);
              } else if (e.key === "Escape") {
                setEditing(false);
                setAddress(displayUrl(current) || url);
              }
            }}
            onBlur={() => setEditing(false)}
            spellCheck={false}
            className="min-w-0 flex-1 border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] bg-transparent px-2 py-0.5 font-mono text-[11px] text-[var(--term-fg)] outline-none"
            aria-label="browser address"
          />
        ) : (
          <button
            className="min-w-0 flex-1 truncate border border-[color-mix(in_srgb,var(--term-fg)_20%,transparent)] px-2 py-0.5 text-left font-mono text-[11px] text-[var(--term-dim)] hover:text-[var(--term-fg)]"
            onClick={() => setEditing(true)}
            title="edit address"
          >
            {state === "init" ? "negotiating with relay…" : displayUrl(current) || address}
          </button>
        )}
        <button
          className={btn}
          title="open in a real new tab"
          aria-label="open externally"
          onClick={() => {
            const u = current || frameRef.current?.getUrl() || url;
            if (u) window.open(u, "_blank", "noopener");
          }}
        >
          ↗
        </button>
      </div>

      {/* content */}
      {state === "error" ? (
        <div className="murke-scroll flex flex-1 flex-col items-center justify-center gap-2 overflow-auto p-5 text-center">
          <div className="font-mono text-[13px] font-bold text-[var(--term-err)]">TRANSPORT FAILED</div>
          <div className="max-w-[64ch] font-mono text-[11px] leading-relaxed text-[var(--term-dim)]">{error}</div>
          <div className="max-w-[64ch] font-mono text-[11px] leading-relaxed text-[var(--term-dim)]">
            the wisp relay (server/index.mjs) must be reachable. from the terminal:
            <br />
            <span className="text-[var(--term-fg)]">proxy wisp wss://your-relay/wisp/</span>
            <br />
            or set it permanently in public/config.js
          </div>
        </div>
      ) : (
        <div className="relative flex-1 overflow-hidden bg-black">
          {state === "init" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <div className="font-mono text-[11px] text-[var(--term-dim)]">
                arming scramjet · loading wasm transport · riding wisp…
              </div>
            </div>
          )}
          <div ref={hostRef} className="absolute inset-0" />
        </div>
      )}

      <div className="shrink-0 border-t border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-3 py-1 font-mono text-[9.5px] text-[var(--term-dim)]">
        scramjet · traffic rides the wisp relay · nothing tracked, nothing kept
      </div>
    </div>
  );
}
