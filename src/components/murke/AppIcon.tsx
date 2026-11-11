"use client";

/**
 * AppIcon — ACTUAL app icons, drawn as real SVG art (not bare glyphs),
 * shaped per desktop skin: mac = squircle tiles, windows = rounded
 * squares, cros = circles.
 *
 * Every app gets recognizable brand-style art: the blue Finder folder,
 * the compass, the chrome ring, the notepad with the yellow
 * band, the green chat bubble, the painter's palette, the terminal
 * prompt. `theme` mode flattens everything to the active theme's ink;
 * `translucent` mode swaps the painted tile for a frosted wash one
 * (the dock panel look) and lets the art carry the identity.
 *
 * `glass` mode is REAL glass: the tile itself wears an inline
 * backdrop-filter (frost + saturate + lift) so the frosted backdrop
 * behind it shows THROUGH the tile — see-through, not painted-on.
 * That only samples for real when the surrounding panel's frost is a
 * SIBLING layer (FrostLayer), never when it's the panel's own
 * backdrop-filter — an element with backdrop-filter is a backdrop
 * root, and descendants sample nothing (verified in chromium).
 */

import { useId, useState } from "react";
import type { AppId } from "@/lib/murke/contracts";

export type IconSkin = "mac" | "win" | "cros";

function radiusFor(skin: IconSkin, size: number): string {
  if (skin === "mac") return `${Math.max(4, Math.round(size * 0.24))}px`;
  if (skin === "cros") return "50%";
  return `${Math.max(3, Math.round(size * 0.17))}px`;
}

/* --------------------------- real glass tile --------------------------- */

/**
 * The REAL frosted-glass icon tile: an actual backdrop-filter frost the
 * wallpaper shows through, plus the specular physics — bright top wash,
 * crisp 1px top edge, hairline inner rim, grounding drop shadow. Inline
 * styles on purpose: the css pipeline mangles backdrop-filter into a
 * -webkit-only form chromium rejects.
 */
export function glassTileStyle(size: number): React.CSSProperties {
  const blur = Math.min(9, Math.max(3, Math.round(size * 0.12)));
  const filter = `blur(${blur}px) saturate(1.65) brightness(1.16)`;
  return {
    background:
      "linear-gradient(to bottom, rgba(255,255,255,0.36), rgba(255,255,255,0.13) 32%, rgba(255,255,255,0.05) 56%, rgba(255,255,255,0.17))",
    backdropFilter: filter,
    WebkitBackdropFilter: filter,
    boxShadow:
      "0 3px 10px rgba(0,0,0,0.26), inset 0 0 0 1px rgba(255,255,255,0.26), inset 0 1.5px 0.5px -0.5px rgba(255,255,255,0.6), inset 0 -1px 1px -1px rgba(255,255,255,0.18)",
  };
}

/** themed variant — the same real frost, washed in the theme's brand */
export function themeGlassTileStyle(size: number): React.CSSProperties {
  return {
    ...glassTileStyle(size),
    background:
      "linear-gradient(to bottom, color-mix(in srgb, var(--term-brand) 32%, transparent), color-mix(in srgb, var(--term-brand) 12%, transparent) 34%, color-mix(in srgb, var(--term-bg) 8%, transparent) 58%, color-mix(in srgb, var(--term-brand) 18%, transparent))",
  };
}

/* --------------------------- the glyph art --------------------------- */

function GlyphArt({ app, size }: { app: AppId; size: number }) {
  const s = size;
  /* per-instance gradient id — a fixed id breaks when the same art mounts
     twice (taskbar renders each icon hidden+visible for responsive) and
     the first defs in the DOM sits inside display:none → fill resolves to
     nothing and the folder vanishes */
  const gid = useId();
  switch (app) {
    case "dsh":
      return (
        <span
          aria-hidden="true"
          className="flex items-center justify-center font-bold leading-none"
          style={{ fontFamily: '"SF Mono", Menlo, Consolas, monospace', fontSize: Math.round(s * 0.42), color: "#e8e8ea" }}
        >
          {">_"}
        </span>
      );
    case "files":
      return (
        <svg viewBox="0 0 48 48" width={s} height={s} aria-hidden="true">
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#8fd0f8" />
              <stop offset="1" stopColor="#3f9fe8" />
            </linearGradient>
          </defs>
          <path
            fill={`url(#${gid})`}
            d="M5 13a4 4 0 0 1 4-4h9.2c1.2 0 2.3.5 3.1 1.4L23.6 13H39a4 4 0 0 1 4 4v17a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z"
          />
          <path fill="#ffffff" opacity="0.28" d="M5 18h38v2.6H5z" />
          <path fill="#ffffff" opacity="0.14" d="M5 20.6h38v17.4a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" />
        </svg>
      );
    case "browser":
      /* chrome ring — the browser canon; the compass lives in the mac skin */
      return (
        <svg viewBox="0 0 48 48" width={s} height={s} aria-hidden="true">
          <circle cx="24" cy="24" r="21" fill="#ffffff" />
          <path d="M3 24 A21 21 0 0 1 45 24 L34.5 24 A10.5 10.5 0 0 0 13.5 24 Z" fill="#EA4335" />
          <path d="M3 24 A21 21 0 0 0 24 45 L24 34.5 A10.5 10.5 0 0 1 13.5 24 Z" fill="#34A853" />
          <path d="M45 24 A21 21 0 0 1 24 45 L24 34.5 A10.5 10.5 0 0 0 34.5 24 Z" fill="#FBBC05" />
          <circle cx="24" cy="24" r="10.5" fill="#ffffff" />
          <circle cx="24" cy="24" r="8.2" fill="#4285F4" />
        </svg>
      );
    case "preview":
      return (
        <svg viewBox="0 0 48 48" width={s} height={s} aria-hidden="true">
          <circle cx="24" cy="24" r="16.5" fill="none" stroke="#ffffff" strokeWidth="3.2" />
          <circle cx="24" cy="24" r="6.5" fill="#ffffff" />
          <path d="M36.5 36.5 L43 43" stroke="#ffffff" strokeWidth="4.2" strokeLinecap="round" />
        </svg>
      );
    case "notes":
      return (
        <svg viewBox="0 0 48 48" width={s} height={s} aria-hidden="true">
          <rect x="7" y="5" width="34" height="38" rx="5" fill="#ffffff" />
          <path d="M7 10a5 5 0 0 1 5-5h24a5 5 0 0 1 5 5v5H7z" fill="#f7c948" />
          <g stroke="#c9c9cf" strokeWidth="2.4" strokeLinecap="round">
            <path d="M13 24h22" />
            <path d="M13 31h22" />
            <path d="M13 38h14" />
          </g>
        </svg>
      );
    case "chat":
      return (
        <svg viewBox="0 0 48 48" width={s} height={s} aria-hidden="true">
          <path
            fill="#35c759"
            d="M24 6c10.5 0 19 7 19 15.6 0 8.7-8.5 15.7-19 15.7-2.1 0-4.1-.3-6-.8L9 41l1.9-7.3C7.3 30.8 5 26.6 5 21.6 5 13 13.5 6 24 6z"
          />
          <g fill="#ffffff">
            <circle cx="16.5" cy="21.5" r="2.6" />
            <circle cx="24" cy="21.5" r="2.6" />
            <circle cx="31.5" cy="21.5" r="2.6" />
          </g>
        </svg>
      );
    case "paint":
      return (
        <svg viewBox="0 0 48 48" width={s} height={s} aria-hidden="true">
          <path
            fill="#ffffff"
            d="M24 6c10.5 0 19 6.6 19 14.8 0 5.9-4 8.9-9 8.9h-3.1c-2.4 0-4.3 1.6-4.3 3.6 0 1 .5 1.8 1.1 2.5.6.8 1.1 1.6 1.1 2.6 0 2.1-1.9 3.6-4.3 3.6C14.1 42 5 34.4 5 24.6 5 14 13.5 6 24 6z"
          />
          <circle cx="15" cy="19" r="2.9" fill="#ef4444" />
          <circle cx="24" cy="14.5" r="2.9" fill="#f59e0b" />
          <circle cx="33" cy="19" r="2.9" fill="#3b82f6" />
          <circle cx="14.5" cy="29" r="2.9" fill="#10b981" />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 48 48" width={s} height={s} aria-hidden="true">
          <g fill="none" stroke="#ffffff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="24" cy="24" r="7.2" />
            <path d="M24 5.5v5.4M24 37.1v5.4M5.5 24h5.4M37.1 24h5.4M10.9 10.9l3.8 3.8M33.3 33.3l3.8 3.8M37.1 10.9l-3.8 3.8M14.7 33.3l-3.8 3.8" />
          </g>
        </svg>
      );
    case "watch":
      return (
        <svg viewBox="0 0 48 48" width={s} height={s} aria-hidden="true">
          <rect x="4" y="10" width="40" height="28" rx="7" fill="#ffffff" />
          <path d="M20 18.5 31 24l-11 5.5z" fill="#e62117" />
        </svg>
      );
    default:
      return null;
  }
}

/* ------------------------------ tiles ------------------------------ */

/** frosted tile — the dock panel itself, shrunken: translucent wash,
    hairline rim, soft drop. No gradient anywhere. */
export const TRANSLUCENT_TILE = {
  background: "color-mix(in srgb, var(--term-fg) 9%, transparent)",
  boxShadow:
    "0 2px 6px rgba(0,0,0,0.18), inset 0 0 0 1px color-mix(in srgb, var(--term-fg) 13%, transparent)",
};

const TILES: Record<string, string> = {
  dsh: "linear-gradient(160deg,#3f3f46,#131316)",
  files: "linear-gradient(165deg,#69b8ec,#2f7fc4)",
  browser: "linear-gradient(165deg,#f6f7f9,#dfe3e8)",
  watch: "linear-gradient(165deg,#3a3d42,#141518)",
  preview: "linear-gradient(165deg,#57c8f2,#1273b4)",
  notes: "linear-gradient(165deg,#ffe083,#f0a712)",
  chat: "linear-gradient(165deg,#4ade80,#16a34a)",
  paint: "linear-gradient(165deg,#ff8fb8,#d6336c)",
  settings: "linear-gradient(165deg,#aab2bd,#57606b)",
};

export interface AppIconProps {
  app: AppId;
  size: number;
  /** which desktop the icon is drawn for (decides the tile shape) */
  skin?: IconSkin;
  /** flatten to the active theme instead of the fixed brand colors */
  theme?: boolean;
  /** liquid-glass specular sheen over the tile */
  glass?: boolean;
  /** frosted glass tile (dock-panel look) instead of the painted gradient */
  translucent?: boolean;
}

export default function AppIcon({ app, size, skin = "mac", theme = false, glass = false, translucent = false }: AppIconProps) {
  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: radiusFor(skin, size),
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    overflow: "hidden",
    boxShadow: "0 2px 6px rgba(0,0,0,0.28), inset 0 0 0 1px rgba(255,255,255,0.09)",
  };

  if (theme) {
    /* themed: the theme's own ink — on a real glass tile when glass is on */
    return (
      <span
        aria-hidden="true"
        style={{
          ...base,
          ...(glass
            ? themeGlassTileStyle(size)
            : {
                background: "color-mix(in srgb, var(--term-brand) 22%, var(--term-bg))",
                boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--term-fg) 16%, transparent)",
              }),
        }}
      >
        <AppGlyphMono app={app} size={size} />
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{
        ...base,
        ...(glass
          ? glassTileStyle(size)
          : {
              background: translucent ? TRANSLUCENT_TILE.background : (TILES[app] ?? "#3a3a40"),
              boxShadow: translucent ? TRANSLUCENT_TILE.boxShadow : base.boxShadow,
            }),
      }}
    >
      <GlyphArt app={app} size={Math.round(size * 0.94)} />
    </span>
  );
}

/** monochrome glyph for themed mode — same art, theme ink */
function AppGlyphMono({ app, size }: { app: AppId; size: number }) {
  const ink = "var(--term-fg)";
  switch (app) {
    case "dsh":
      return (
        <span
          aria-hidden="true"
          className="flex items-center justify-center font-bold leading-none"
          style={{ fontFamily: '"SF Mono", Menlo, Consolas, monospace', fontSize: Math.round(size * 0.42), color: ink }}
        >
          {">_"}
        </span>
      );
    case "files":
      return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <path
            fill="none"
            stroke={ink}
            strokeWidth="3.2"
            strokeLinejoin="round"
            d="M7 14a4 4 0 0 1 4-4h8l4 4h14a4 4 0 0 1 4 4v15a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4z"
          />
        </svg>
      );
    case "browser":
      return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <g fill="none" stroke={ink} strokeWidth="3">
            <circle cx="24" cy="24" r="16" />
            <path d="M8 24h32M24 8c-5 5-7 10-7 16s2 11 7 16c5-5 7-10 7-16s-2-11-7-16z" />
          </g>
        </svg>
      );
    case "preview":
      return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <g fill="none" stroke={ink} strokeWidth="3.2" strokeLinecap="round">
            <circle cx="22" cy="22" r="12" />
            <path d="M31.5 31.5 L39 39" />
          </g>
        </svg>
      );
    case "notes":
      return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <g stroke={ink} strokeWidth="3" strokeLinecap="round">
            <path d="M10 8v32M10 8h20l8 8v24M10 20h18M10 28h18M10 36h12" fill="none" />
          </g>
        </svg>
      );
    case "chat":
      return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <path
            fill="none"
            stroke={ink}
            strokeWidth="3.2"
            strokeLinejoin="round"
            d="M24 8c9.9 0 18 6.6 18 14.8S33.9 37.6 24 37.6c-2 0-3.9-.2-5.7-.7L10 41l1.8-6.9C8 31.2 6 27.4 6 22.8 6 14.6 14.1 8 24 8z"
          />
        </svg>
      );
    case "paint":
      return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <path
            fill="none"
            stroke={ink}
            strokeWidth="3.2"
            strokeLinejoin="round"
            d="M24 6c10.5 0 19 6.6 19 14.8 0 5.9-4 8.9-9 8.9h-3.1c-2.4 0-4.3 1.6-4.3 3.6 0 1 .5 1.8 1.1 2.5.6.8 1.1 1.6 1.1 2.6 0 2.1-1.9 3.6-4.3 3.6C14.1 42 5 34.4 5 24.6 5 14 13.5 6 24 6z"
          />
          <circle cx="16" cy="18" r="1.8" fill={ink} />
          <circle cx="24" cy="14" r="1.8" fill={ink} />
          <circle cx="32" cy="18" r="1.8" fill={ink} />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <g fill="none" stroke={ink} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="24" cy="24" r="7.2" />
            <path d="M24 5.5v5.4M24 37.1v5.4M5.5 24h5.4M37.1 24h5.4M10.9 10.9l3.8 3.8M33.3 33.3l3.8 3.8M37.1 10.9l-3.8 3.8M14.7 33.3l-3.8 3.8" />
          </g>
        </svg>
      );
    case "watch":
      return (
        <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
          <g fill="none" stroke={ink} strokeWidth="3.2" strokeLinejoin="round">
            <rect x="5" y="11" width="38" height="26" rx="7" />
            <path d="M20.5 18.5 30 24l-9.5 5.5z" fill={ink} stroke="none" />
          </g>
        </svg>
      );
    default:
      return null;
  }
}

/** favicon tile for INSTALLED web apps — the user's uploaded icon wins,
 *  then the site's real logo (themed on demand); letter fallback covers misses.
 *  `color` (the CustomApp hue) tints the letter tile; glass turns every
 *  branch into the real frosted-glass tile. */
export function PwaIcon({
  url,
  name,
  size,
  skin = "mac",
  theme = false,
  glass = false,
  icon,
  color,
}: {
  url: string;
  name: string;
  size: number;
  skin?: IconSkin;
  theme?: boolean;
  glass?: boolean;
  /** user-uploaded data-url icon from the custom app entry */
  icon?: string;
  /** the CustomApp hue — tints the letter-fallback tile */
  color?: string;
}) {
  const [failed, setFailed] = useState(false);
  const radius = radiusFor(skin, size);
  const letter = name.trim().charAt(0).toUpperCase() || "?";

  if (icon) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          position: "relative",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          ...(glass
            ? glassTileStyle(size)
            : {
                background: "color-mix(in srgb, var(--term-bg) 55%, transparent)",
                boxShadow: "0 2px 6px rgba(0,0,0,0.28), inset 0 0 0 1px rgba(0,0,0,0.08)",
              }),
        }}
      >
        <img
          src={icon}
          alt=""
          draggable={false}
          style={
            glass
              ? { width: "86%", height: "86%", objectFit: "cover", borderRadius: "inherit" }
              : { width: "100%", height: "100%", objectFit: "cover" }
          }
        />
      </span>
    );
  }

  if (theme || failed) {
    const glassTile = glass && !theme;
    return (
      <span
        aria-hidden="true"
        className="flex select-none items-center justify-center font-bold"
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          ...(glassTile
            ? { ...glassTileStyle(size), color: color ? "#fff" : "var(--term-fg)" }
            : {
                background: theme
                  ? "color-mix(in srgb, var(--term-brand) 22%, var(--term-bg))"
                  : color
                    ? `color-mix(in srgb, ${color} 72%, transparent)`
                    : TRANSLUCENT_TILE.background,
                color: theme ? "var(--term-fg)" : "#fff",
                boxShadow: theme
                  ? "inset 0 0 0 1px color-mix(in srgb, var(--term-fg) 16%, transparent)"
                  : TRANSLUCENT_TILE.boxShadow,
              }),
          fontSize: Math.round(size * 0.44),
          position: "relative",
          overflow: "hidden",
        }}
      >
        {letter}
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...(glass
          ? glassTileStyle(size)
          : { background: "#ffffff", boxShadow: "0 2px 6px rgba(0,0,0,0.28), inset 0 0 0 1px rgba(0,0,0,0.08)" }),
      }}
    >
      <img
        src={`/api/favicon?u=${encodeURIComponent(url)}`}
        alt=""
        onError={() => setFailed(true)}
        style={{ width: Math.round(size * 0.72), height: Math.round(size * 0.72), objectFit: "contain" }}
      />
    </span>
  );
}
