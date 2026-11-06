"use client";

/**
 * EngineGlyph — the engine icons, 1:1 with the user's design files:
 * the extension mixes its own filled Material glyphs (globe, YouTube)
 * with the REAL brand logos (Wikipedia's enwiki mark, DuckDuckGo's duck,
 * Google Translate's favicon). Every asset is served from our own origin
 * (public/frost/icons) — nothing leaves the page, nothing breaks behind
 * school filters. Custom engines use their saved icon, falling back to
 * the quiet search mark.
 */

import type { FrostEngine } from "@/lib/murke/frost-store";

/** the local, real-logo asset set — the web engine wears the FROST mark
    (this is frost's own search, not google's, not murke's) */
export const ENGINE_ICONS: Record<string, string> = {
  web: "/frost/icons/frost.svg",
  wikipedia: "/frost/icons/enwiki.svg",
  duck: "/frost/icons/duckduckgo.svg",
  youtube: "/frost/icons/youtube.svg",
  translate: "/frost/icons/translate.ico",
  google: "/frost/icons/google.svg",
};

export function EngineGlyph({ engine }: { engine: FrostEngine }) {
  // a custom engine with a saved icon shows it first
  const local = ENGINE_ICONS[engine.id];
  const src = engine.icon || local;
  if (src) {
    return <img src={src} alt="" draggable={false} />;
  }
  return engine.q === null ? <GlobeGlyph /> : <SearchGlyph />;
}

const stroke = {
  fill: "none",
  stroke: "#555",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** the frost snowflake as a component glyph — the mark of the frost
    engine and fresh tabs */
export function FrostGlyph(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...p}>
      <path
        fill="url(#frost-glyph-g)"
        opacity={0.95}
        d="M12 2a1 1 0 0 1 1 1v2.6l1.8-1.05a1 1 0 1 1 1 1.73L14 7.6V11l3-1.73.2-2.3a1 1 0 1 1 2 .17l-.13 1.5 1.3-.75a1 1 0 0 1 1 1.73l-1.3.75 1.43.5a1 1 0 1 1-.67 1.89l-2.2-.78L15 13l2.63 1.52 2.2-.78a1 1 0 1 1 .67 1.89l-1.43.5 1.3.75a1 1 0 0 1-1 1.73l-1.3-.75.13 1.5a1 1 0 1 1-2 .17L17 18.73 14 17v3.4l1.8 1.05a1 1 0 1 1-1 1.73L13 22.4V23a1 1 0 1 1-2 0v-.6l-1.8 1.05a1 1 0 1 1-1-1.73L10 20.4V17l-3 1.73-.2 2.3a1 1 0 1 1-2-.17l.13-1.5-1.3.75a1 1 0 0 1-1-1.73l1.3-.75-1.43-.5a1 1 0 1 1 .67-1.89l2.2.78L9 13l-2.63-1.52-2.2.78a1 1 0 1 1-.67-1.89l1.43-.5-1.3-.75a1 1 0 0 1 1-1.73l1.3.75-.13-1.5a1 1 0 1 1 2-.17l.2 2.3L10 7.6V4.4L8.2 3.35a1 1 0 1 1 1-1.73L11 2.6V3a1 1 0 0 1 1-1z"
      />
      <defs>
        <linearGradient id="frost-glyph-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6EC1FF" />
          <stop offset="1" stopColor="#2F7CF6" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** the filled Material "language" globe — 1:1 with the design's globe.svg */
export function GlobeGlyph(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...p}>
      <path
        fill="#555"
        d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.92 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.987 7.987 0 0 1 5.08 16zm2.95-8H5.08a7.987 7.987 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z"
      />
    </svg>
  );
}

/** the filled Material YouTube mark — 1:1 with the design's YouTube.svg */
export function YtGlyph(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...p}>
      <path
        fill="#555"
        d="M21.58 7.19c-.23-.86-.91-1.54-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.81.42c-.86.23-1.54.91-1.77 1.77C2 8.75 2 12 2 12s0 3.25.42 4.81c.23.86.91 1.54 1.77 1.77C5.75 19 12 19 12 19s6.25 0 7.81-.42c.86-.23 1.54-.91 1.77-1.77C22 15.25 22 12 22 12s0-3.25-.42-4.81zM10 15.5v-7l6 3.5-6 3.5z"
      />
    </svg>
  );
}

export function SearchGlyph(p: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...p}>
      <circle cx="10.5" cy="10.5" r="6" {...stroke} />
      <path d="M15 15l5.5 5.5" {...stroke} />
    </svg>
  );
}
