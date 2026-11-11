"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MurkeArt from "./MurkeArt";
import { MURKE_ART_HTML, themeArt } from "@/lib/murke/murke-art";
import { THEMES } from "@/lib/murke/themes";
import type { ThemeName } from "@/lib/murke/contracts";

/**
 * Murke boot sequence — short, and DRESSED FOR THE THEME.
 * Every color comes from the active theme's palette (no hardcoded hell-reds),
 * the tagline names the theme, and the loading bar burns in the brand color.
 * Any key skips it.
 */

const BOOT_LINES: Array<[string, string]> = [
  ["[ ok ]", "filesystem"],
  ["[ ok ]", "scramjet"],
  ["[ ok ]", "wisp relay"],
];

const BAR_WIDTH = 26;
const BOOT_MS = 2100;

export default function BootScreen({ onDone, theme }: { onDone: () => void; theme: ThemeName }) {
  const [pct, setPct] = useState(0);
  const [lineCount, setLineCount] = useState(0);
  const [fading, setFading] = useState(false);
  const doneRef = useRef(false);
  const rafRef = useRef(0);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    cancelAnimationFrame(rafRef.current);
    setFading(true);
    window.setTimeout(onDone, 260);
  }, [onDone]);

  useEffect(() => {
    const t0 = performance.now();
    let stallUntil = 0;

    const tick = () => {
      if (doneRef.current) return;
      const el = performance.now() - t0;
      // one short stall for texture, then run out
      if (el > 900 && stallUntil === 0) stallUntil = performance.now() + 180;
      const paused = performance.now() < stallUntil ? 260 : 0;
      const p = Math.min(100, Math.max(0, ((el - paused) / BOOT_MS) * 100));
      setPct(p);
      setLineCount(Math.min(BOOT_LINES.length, Math.floor((p / 100) * (BOOT_LINES.length + 0.5))));
      if (p >= 100) {
        finish();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    const skip = () => finish();
    window.addEventListener("keydown", skip);
    window.addEventListener("pointerdown", skip);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("keydown", skip);
      window.removeEventListener("pointerdown", skip);
    };
  }, [finish]);

  const t = THEMES[theme];
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  const showBar = pct > 4;
  const color = (c: string) => ({ color: c });

  return (
    <div
      className={`fixed inset-0 z-50 overflow-hidden bg-black transition-opacity duration-300 ${
        fading ? "opacity-0" : "opacity-100"
      }`}
      role="status"
      aria-label="murke proxy booting"
    >
      <div className="daemon-grain pointer-events-none absolute -inset-16 opacity-[0.11]" aria-hidden="true" />
      <div className="murke-vignette pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative flex h-full flex-col items-center justify-center gap-4 px-3">
        {/* the intro: the murke textart, recolored for THIS theme */}
        <div className="w-full max-w-[860px]" aria-hidden="true">
          <MurkeArt html={themeArt(MURKE_ART_HTML, t.art)} label="murke" />
        </div>

        {/* theme tagline + loading bar */}
        <div className="flex w-full max-w-[560px] flex-col items-center gap-2 font-mono">
          <div
            className="text-[10px] lowercase tracking-[0.42em]"
            style={{ color: t.dim }}
            aria-hidden="true"
          >
            {t.label}
          </div>
          <div className="w-full text-center text-[13px] leading-none" style={color(t.fg)}>
            <span style={color(t.art.shadow)}>[</span>
            <span style={color(t.brand)}>{bar}</span>
            <span style={color(t.art.shadow)}>] </span>
            <span className="inline-block w-[42px] text-right" style={color(t.hi)}>
              {Math.floor(pct)}%
            </span>
          </div>
          <div className="h-[54px] w-full overflow-hidden px-2 text-[10.5px] leading-[1.5] sm:px-6">
            {BOOT_LINES.slice(0, lineCount).map(([tag, msg], i) => (
              <div key={i} className="whitespace-pre">
                <span style={color(t.brand)}>{tag}</span> <span style={color(t.dim)}>{msg}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="absolute bottom-6 text-[10px] tracking-[0.25em]" style={{ color: t.art.shadow }}>
          {showBar ? "press any key to skip" : ""}
        </div>
      </div>
    </div>
  );
}
