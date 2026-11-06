"use client";

import { useEffect, useState } from "react";
import { MURKE_ART_COLS, MURKE_ART_HTML, MURKE_ART_ROWS, themeArt } from "@/lib/murke/murke-art";
import { getThemeDef, resolveThemeKey } from "@/lib/murke/themes";
import { LS } from "@/lib/murke/contracts";

/* geometry of the vendored art — a mono cell is ~0.6em wide, 1.17em tall */
const LEADING = 1.17;
const CELL_W = 0.6;
const ART_ASPECT = (MURKE_ART_COLS * CELL_W) / (MURKE_ART_ROWS * LEADING);

/** theme registry key — builtins, "@light/@dark" variants, "custom:<id>" */
type ThemeKey = string;

function readStoredTheme(): ThemeKey {
  try {
    const raw = localStorage.getItem(LS.settings);
    if (raw) {
      const s = JSON.parse(raw) as { theme?: unknown; themeMode?: unknown; customThemeId?: unknown };
      if (typeof s.theme === "string") {
        return resolveThemeKey({
          theme: s.theme as never,
          themeMode: s.themeMode === "light" ? "light" : "dark",
          customThemeId: typeof s.customThemeId === "string" ? s.customThemeId : null,
        });
      }
    }
  } catch {
    /* ignore */
  }
  return "hell";
}

/**
 * The murke textart AS a mark. Renders at its NATURAL aspect ratio (cols ×
 * 0.6em over rows × 1.17em) so the logo is never squished — callers pick a
 * height and the width follows. Used wherever the full sigil shows big
 * enough to be legible (settings about panel, boot).
 *
 * Pass `theme` when the caller owns theme state; omit it and the mark reads
 * the persisted settings and follows `murke-theme` switch events.
 */
export default function MurkeMark({
  theme,
  height = 22,
  className = "",
  title = "murke",
}: {
  theme?: ThemeKey;
  height?: number;
  className?: string;
  title?: string;
}) {
  const [fallbackTheme, setFallbackTheme] = useState<ThemeKey>(() => readStoredTheme());

  useEffect(() => {
    if (theme) return;
    const onTheme = (e: Event) => {
      const t = (e as CustomEvent<unknown>).detail;
      if (typeof t === "string") setFallbackTheme(t);
    };
    window.addEventListener("murke-theme", onTheme);
    return () => window.removeEventListener("murke-theme", onTheme);
  }, [theme]);

  const active = theme ?? fallbackTheme;
  const html = themeArt(MURKE_ART_HTML, getThemeDef(active).art);
  const fontSize = height / (MURKE_ART_ROWS * LEADING);

  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center overflow-hidden ${className}`}
      role="img"
      aria-label={title}
      title={title}
      style={{ height, width: Math.round(height * ART_ASPECT) }}
      aria-hidden={title ? undefined : true}
    >
      <pre
        aria-hidden="true"
        className="m-0 font-mono"
        style={{
          fontSize: `${fontSize.toFixed(2)}px`,
          lineHeight: LEADING,
          letterSpacing: 0,
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </span>
  );
}

/**
 * Wordmark — the menu-bar logo. Tiny ASCII at bar height is unreadable mush
 * (the "squished logo" problem), so the top bar uses this instead: the name
 * in crisp bold mono with the theme's brand color and a blinking block
 * cursor. The full art still gets its hero moments in boot + about.
 */
export function Wordmark({ theme }: { theme?: ThemeKey }) {
  const [fallbackTheme, setFallbackTheme] = useState<ThemeKey>(() => readStoredTheme());

  useEffect(() => {
    if (theme) return;
    const onTheme = (e: Event) => {
      const t = (e as CustomEvent<unknown>).detail;
      if (typeof t === "string") setFallbackTheme(t);
    };
    window.addEventListener("murke-theme", onTheme);
    return () => window.removeEventListener("murke-theme", onTheme);
  }, [theme]);

  const active = theme ?? fallbackTheme;
  const def = getThemeDef(active);
  return (
    <span
      className="inline-flex select-none items-baseline gap-px text-[12.5px] font-bold lowercase tracking-[0.12em]"
      role="img"
      aria-label="murke"
      title="murke"
    >
      <span style={{ color: def.brand }}>murke</span>
      <span className="murke-cursor px-px" style={{ backgroundColor: def.brand, color: def.bg }}>
        &nbsp;
      </span>
    </span>
  );
}
