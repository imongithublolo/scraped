"use client";

import { useEffect, useState } from "react";
import { MURKE_ART_HTML, themeArt } from "@/lib/murke/murke-art";
import { THEMES, isThemeName } from "@/lib/murke/themes";
import { LS } from "@/lib/murke/contracts";
import type { ThemeName } from "@/lib/murke/contracts";

/** MURKE_ART_HTML geometry (rows × cols) — used to scale the mark. */
const ROWS = 10;
const LEADING = 1.17;

function readStoredTheme(): ThemeName {
  try {
    const raw = localStorage.getItem(LS.settings);
    if (raw) {
      const s = JSON.parse(raw) as { theme?: unknown };
      if (typeof s.theme === "string" && isThemeName(s.theme)) return s.theme;
    }
  } catch {
    /* ignore */
  }
  return "hell";
}

/**
 * The murke textart AS the brand mark. This is the exact art the `murke`
 * command prints — scaled down to badge size, recolored live with the
 * active theme. THE top-left logo (chrome bar).
 *
 * Pass `theme` when the caller already owns the theme state (chrome bar);
 * omit it anywhere else — the mark then reads the persisted settings and
 * follows `murke-theme` events fired on every theme switch.
 */
export default function MurkeMark({
  theme,
  height = 22,
  className = "",
  title = "murke",
}: {
  theme?: ThemeName;
  height?: number;
  className?: string;
  title?: string;
}) {
  const [fallbackTheme, setFallbackTheme] = useState<ThemeName>(() => readStoredTheme());

  /* theme-less mode: follow the live switch events (initial value came from
     the persisted settings — the shell gates on hydration, so this runs
     client-side before any pane ever paints) */
  useEffect(() => {
    if (theme) return;
    const onTheme = (e: Event) => {
      const t = (e as CustomEvent<unknown>).detail;
      if (typeof t === "string" && isThemeName(t)) setFallbackTheme(t);
    };
    window.addEventListener("murke-theme", onTheme);
    return () => window.removeEventListener("murke-theme", onTheme);
  }, [theme]);

  const active = theme ?? fallbackTheme;
  const html = themeArt(MURKE_ART_HTML, THEMES[active].art);
  const fontSize = height / (ROWS * LEADING);

  return (
    <span
      className={`inline-flex shrink-0 select-none items-center overflow-hidden ${className}`}
      role="img"
      aria-label={title}
      title={title}
      style={{ height }}
      aria-hidden={title ? undefined : true}
    >
      <pre
        aria-hidden="true"
        className="m-0 font-mono"
        style={{
          fontSize: `${fontSize.toFixed(2)}px`,
          lineHeight: LEADING,
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </span>
  );
}
