"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const BASE_FONT = 12; // px — natural size we measure against
const MAX_GROW = 1.45; // never grow past ~17px on wide screens
const MIN_FONT = 4.5; // px — readable floor on tiny screens

/**
 * Trusted big-block renderer (murke logo, boot art, demon sigil). Auto-scales
 * the font so the art ALWAYS fits the terminal width — never cut off, on any
 * screen. NO frame, NO background: art sits straight on the terminal glass
 * like real TUI output. Re-fits on resize and after fonts load. Also hosts
 * any fixed-width block that must not overflow — pass a label for the aria
 * role.
 */
export default function MurkeArt({ html, label = "murke logo" }: { html: string; label?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const appliedRef = useRef(BASE_FONT);
  const [fontSize, setFontSize] = useState<number | null>(null);

  const fit = useCallback(() => {
    const wrap = wrapRef.current;
    const pre = preRef.current;
    if (!wrap || !pre) return;
    const avail = wrap.clientWidth;
    if (avail <= 4) return;
    // monospace width scales linearly with font-size, so convert the
    // currently-rendered width back to its base-font equivalent
    const cur = appliedRef.current || BASE_FONT;
    const natural = (pre.scrollWidth || 1) * (BASE_FONT / cur);
    const ratio = (avail - 2) / natural;
    const clamped = Math.min(MAX_GROW, Math.max(MIN_FONT / BASE_FONT, ratio));
    const next = Math.round(BASE_FONT * clamped * 100) / 100;
    if (Math.abs(next - cur) < 0.05) return; // settled — avoids loops
    appliedRef.current = next;
    setFontSize(next);
    // announce the resize so scroll hosts can re-anchor (post-layout)
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent("murke-art-resized"));
    });
  }, []);

  useEffect(() => {
    fit();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    // webfont swap changes glyph metrics — refit once fonts settle
    let dead = false;
    void document.fonts?.ready.then(() => {
      if (!dead) fit();
    });
    return () => {
      dead = true;
      ro.disconnect();
    };
  }, [fit]);

  return (
    <div
      ref={wrapRef}
      className="murke-scroll flex justify-center overflow-x-hidden py-1"
      role="img"
      aria-label={label}
    >
      <pre
        ref={preRef}
        className="w-max font-mono leading-[1.17]"
        style={{
          color: "var(--term-fg)",
          fontSize: (fontSize ?? BASE_FONT) + "px",
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
