"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MurkeArt from "../MurkeArt";
import { MURKE_ART_HTML as MURKE_BOOT_ART } from "@/lib/murke/murke-art";

/**
 * DAEMON boot sequence.
 * Black screen, film grain, the sigil breathing red light, a block loading
 * bar with live kernel-style chatter underneath. Any key/click skips it.
 */

const BOOT_LINES: Array<[string, string]> = [
  ["[ ok ]", "brimstone ignited — thermal gothic online"],
  ["[ ok ]", "vfs mounted on /dev/vfs0"],
  ["[ ok ]", "beastie summoned (daemon(8))"],
  ["[ ok ]", "scramjet transport armed"],
  ["[ ok ]", "wisp relay handshake"],
  ["[ ok ]", "cursor sync locked at 1.06s"],
  ["[ .. ]", "opening the gates"],
];

const BAR_WIDTH = 26;
const BOOT_MS = 3400;

export default function BootScreen({ onDone }: { onDone: () => void }) {
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
      // eased progress with two realistic "stalls" for texture
      if (el > 1250 && stallUntil === 0) stallUntil = performance.now() + 260;
      if (el > 2450 && stallUntil < 2600) stallUntil = performance.now() + 200;
      const paused = performance.now() < stallUntil ? 300 : 0;
      const p = Math.min(100, Math.max(0, ((el - paused) / BOOT_MS) * 100));
      setPct(p);
      setLineCount(Math.min(BOOT_LINES.length, Math.floor((p / 100) * (BOOT_LINES.length + 0.6))));
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

  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  const showBar = pct > 4;

  return (
    <div
      className={`fixed inset-0 z-50 overflow-hidden bg-black transition-opacity duration-300 ${
        fading ? "opacity-0" : "opacity-100"
      }`}
      role="status"
      aria-label="daemon booting"
    >
      {/* visual noise / grain around the logo */}
      <div className="daemon-grain pointer-events-none absolute -inset-16 opacity-[0.13]" aria-hidden="true" />
      <div className="murke-vignette pointer-events-none absolute inset-0" aria-hidden="true" />

      <div className="relative flex h-full flex-col items-center justify-center gap-7 px-3">
        {/* glowing sigil */}
        <div className="daemon-pulse w-full max-w-[860px]" aria-hidden="true">
          <MurkeArt html={MURKE_BOOT_ART} />
        </div>

        <div className="flex flex-col items-center gap-1.5 font-mono">
          <div className="murke-glow text-[11px] font-bold tracking-[0.42em] text-[#e03131]">DAEMON//OS</div>
          <div className="text-[10px] tracking-[0.3em] text-[#5c1d1a]">hellfire build 2.0.6</div>
        </div>

        {/* loading bar */}
        <div className="flex w-full max-w-[560px] flex-col items-center gap-2 font-mono">
          <div className="daemon-bar-glow w-full text-center text-[13px] leading-none text-[#ff6b61]">
            <span className="text-[#5c1d1a]">[</span>
            <span>{bar}</span>
            <span className="text-[#5c1d1a]">]</span>{" "}
            <span className="inline-block w-[42px] text-right text-[#ffb454]">{Math.floor(pct)}%</span>
          </div>
          <div className="h-[38px] w-full overflow-hidden px-2 text-[10.5px] leading-[1.5] sm:px-6">
            {BOOT_LINES.slice(0, lineCount).map(([tag, msg], i) => (
              <div key={i} className="whitespace-pre">
                <span className={tag === "[ .. ]" ? "text-[#ffb454]" : "text-[#3f7a44]"}>{tag}</span>{" "}
                <span className="text-[#6e2a26]">{msg}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="absolute bottom-6 text-[10px] tracking-[0.25em] text-[#3a1210]">
          {showBar ? "press any key to skip" : "waking the beastie…"}
        </div>
      </div>
    </div>
  );
}
