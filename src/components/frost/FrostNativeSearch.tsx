"use client";

/**
 * FrostNativeSearch — the Frost engine's results page (frost://search).
 * Plain words typed into the bar with the Frost engine open THIS instead
 * of a proxied page: the server answers with REAL google results (the
 * googlethis scraper — /api/google — no captcha walls, no proxy hop
 * between you and the answer) and they render here as liquid glass rows
 * floating on a frosted panel over live water — the flowing-waves shader
 * — under the frost snowflake. A result click hands the url to the proxy
 * like any other browse.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import InteractiveWaveShader from "@/components/ui/flowing-waves-shader";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/* the water is ambience — users who prefer less motion get the calm dark
   backdrop instead of the live shader (tracked live via the media query) */
const reduceMotionSubscribe = (onChange: () => void) => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};
const reduceMotionSnapshot = () =>
  typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const reduceMotionServer = () => true;

export default function FrostNativeSearch({
  query,
  onOpen,
  active = true,
}: {
  query: string;
  onOpen: (url: string) => void;
  /** false while the tab is backgrounded — the water pauses with it */
  active?: boolean;
}) {
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const calm = useSyncExternalStore(
    reduceMotionSubscribe,
    reduceMotionSnapshot,
    reduceMotionServer,
  );

  useEffect(() => {
    // the stage remounts this component per query (key={url}) — the null
    // start IS the reset, no synchronous setState needed here
    let dead = false;
    fetch(`/api/google?q=${encodeURIComponent(query)}`)
      .then((r) => r.json())
      .then((j: { ok: boolean; results?: SearchResult[]; engine?: string }) => {
        if (dead) return;
        if (j.ok && j.results) {
          setResults(j.results);
          if (j.engine === "fallback") setNote("answered by the fallback index");
        } else {
          setResults([]);
          setNote("no results came back");
        }
      })
      .catch(() => {
        if (!dead) setNote("the search backend did not answer");
      });
    return () => {
      dead = true;
    };
  }, [query]);

  return (
    <div className="frost-native-search" role="main" aria-label={`results for ${query}`}>
      {/* the water — a live shader sea the results float on */}
      {!calm && (
        <div className="frost-native-sea" aria-hidden="true">
          <InteractiveWaveShader paused={!active} />
        </div>
      )}
      <h1 className="frost-native-title">
        <svg viewBox="0 0 24 24" className="frost-native-mark" aria-hidden="true">
          <path
            fill="url(#frost-native-g)"
            d="M12 2a1 1 0 0 1 1 1v2.6l1.8-1.05a1 1 0 1 1 1 1.73L14 7.6V11l3-1.73.2-2.3a1 1 0 1 1 2 .17l-.13 1.5 1.3-.75a1 1 0 0 1 1 1.73l-1.3.75 1.43.5a1 1 0 1 1-.67 1.89l-2.2-.78L15 13l2.63 1.52 2.2-.78a1 1 0 1 1 .67 1.89l-1.43.5 1.3.75a1 1 0 0 1-1 1.73l-1.3-.75.13 1.5a1 1 0 1 1-2 .17L17 18.73 14 17v3.4l1.8 1.05a1 1 0 1 1-1 1.73L13 22.4V23a1 1 0 1 1-2 0v-.6l-1.8 1.05a1 1 0 1 1-1-1.73L10 20.4V17l-3 1.73-.2 2.3a1 1 0 1 1-2-.17l.13-1.5-1.3.75a1 1 0 0 1-1-1.73l1.3-.75-1.43-.5a1 1 0 1 1 .67-1.89l2.2.78L9 13l-2.63-1.52-2.2.78a1 1 0 1 1-.67-1.89l1.43-.5-1.3-.75a1 1 0 0 1 1-1.73l1.3.75-.13-1.5a1 1 0 1 1 2-.17l.2 2.3L10 7.6V4.4L8.2 3.35a1 1 0 1 1 1-1.73L11 2.6V3a1 1 0 0 1 1-1z"
          />
          <defs>
            <linearGradient id="frost-native-g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#6EC1FF" />
              <stop offset="1" stopColor="#2F7CF6" />
            </linearGradient>
          </defs>
        </svg>
        <span className="frost-native-query">{query}</span>
        {note && <span className="frost-native-note"> — {note}</span>}
      </h1>
      {/* the frost panel — frosted glass the results sit on, over the water */}
      <div className="frost-native-panel">
        <div className="frost-native-list">
          {results === null &&
            [0, 1, 2, 3, 4].map((i) => <div key={i} className="frost-native-row frost-native-skeleton frost-native-glass" />)}
          {results?.map((r) => (
            <button
              key={r.url}
              type="button"
              className="frost-native-row frost-native-glass"
              onClick={() => onOpen(r.url)}
            >
              <span className="frost-native-row-host">{hostOf(r.url)}</span>
              <span className="frost-native-row-title">{r.title}</span>
              {r.snippet && <span className="frost-native-row-snippet">{r.snippet}</span>}
            </button>
          ))}
          {results?.length === 0 && !note && <div className="frost-native-note">nothing found</div>}
        </div>
      </div>
    </div>
  );
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}
