"use client";

/**
 * FrostBoot — the Mac-style warm-up AFTER the password. Pure black, the
 * snowflake mark breathing above a thin rounded progress bar, while every
 * asset the shell will ever need is pulled warm: the nine wallpapers, the
 * engine marks, the oneko sprite, and the HomeStage chunk itself. When
 * the bar fills (or a hard 6s ceiling lands — a dead asset must never
 * wedge the boot), a soft fade hands over to the home.
 */

import { useEffect, useRef, useState } from "react";

/** everything worth pre-warming before the shell appears */
function assets(): string[] {
  const list: string[] = [
    "/frost/oneko.gif",
    "/frost/icons/google.svg",
    "/frost/icons/duckduckgo.svg",
    "/frost/icons/enwiki.svg",
    "/frost/icons/youtube.svg",
    "/frost/icons/translate.ico",
    "/frost/icons/globe.svg",
  ];
  for (const w of [
    "frost.webp",
    "ramiel.jpg",
    "wallhaven-3q3z9d.jpg",
    "wallhaven-3q7j3v.png",
    "wallhaven-4o3mm5.jpg",
    "wallhaven-d8vvlo.png",
    "wallhaven-ne8xvk.jpg",
    "wallhaven-q6xzy7.jpg",
    "wallhaven-x8w2ed.jpg",
  ]) {
    list.push(`/wallpapers/${w}`);
  }
  return list;
}

const MIN_MS = 1500; // the Mac feel — never flash by
const MAX_MS = 6000; // a dead asset must never wedge the boot

export default function FrostBoot({ onDone }: { onDone: () => void }) {
  const [progress, setProgress] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(false);
  const startRef = useRef(0);
  const loadedRef = useRef(0);

  useEffect(() => {
    startRef.current = performance.now();
    const total = assets().length;
    let dead = false;

    /* the bar: eases toward (assets loaded + elapsed floor), never stalls */
    const tick = window.setInterval(() => {
      if (dead || doneRef.current) return;
      const elapsed = performance.now() - startRef.current;
      const timeShare = Math.min(1, elapsed / MIN_MS);
      const assetShare = total > 0 ? loadedRef.current / total : 1;
      // the bar leads with time and lets assets catch up — always moving
      const target = Math.max(timeShare * 0.92, Math.min(assetShare, 0.98));
      setProgress((p) => p + (Math.min(target, 1) - p) * 0.14);
    }, 50);

    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      window.clearInterval(tick);
      // land the bar fully, fade, then hand over
      setProgress(1);
      setLeaving(true);
      window.setTimeout(() => {
        if (!dead) onDone();
      }, 440);
    };

    /* warm every asset; Image() for images, fetch for html */
    const jobs = assets().map(
      (src) =>
        new Promise<void>((resolve) => {
          const settle = () => {
            loadedRef.current += 1;
            resolve();
          };
          if (src.endsWith(".html")) {
            fetch(src, { cache: "force-cache" })
              .then(settle)
              .catch(settle);
            return;
          }
          const img = new Image();
          img.onload = settle;
          img.onerror = settle;
          img.src = src;
        }),
    );

    /* warm the HomeStage chunk in parallel (it is the heaviest byte) */
    jobs.push(
      import("./HomeStage")
        .then(() => {
          loadedRef.current += 1;
        })
        .catch(() => undefined),
    );

    const ceiling = window.setTimeout(finish, MAX_MS);
    Promise.all(jobs).then(() => {
      // honor the minimum duration even on an instant warm cache
      const wait = Math.max(0, MIN_MS - (performance.now() - startRef.current));
      window.setTimeout(() => {
        window.clearTimeout(ceiling);
        finish();
      }, wait);
    });

    return () => {
      dead = true;
      window.clearInterval(tick);
      window.clearTimeout(ceiling);
    };
  }, [onDone]);

  return (
    <main className={`frost-boot ${leaving ? "frost-boot-out" : ""}`} aria-label="starting">
      {/* the mark — breathing, exactly the new-tab logo */}
      <svg className="frost-boot-logo" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 2a1 1 0 0 1 1 1v2.6l1.8-1.05a1 1 0 1 1 1 1.73L14 7.6V11l3-1.73.2-2.3a1 1 0 1 1 2 .17l-.13 1.5 1.3-.75a1 1 0 0 1 1 1.73l-1.3.75 1.43.5a1 1 0 1 1-.67 1.89l-2.2-.78L15 13l2.63 1.52 2.2-.78a1 1 0 1 1 .67 1.89l-1.43.5 1.3.75a1 1 0 0 1-1 1.73l-1.3-.75.13 1.5a1 1 0 1 1-2 .17L17 18.73 14 17v3.4l1.8 1.05a1 1 0 1 1-1 1.73L13 22.4V23a1 1 0 1 1-2 0v-.6l-1.8 1.05a1 1 0 1 1-1-1.73L10 20.4V17l-3 1.73-.2 2.3a1 1 0 1 1-2-.17l.13-1.5-1.3.75a1 1 0 0 1-1-1.73l1.3-.75-1.43-.5a1 1 0 1 1 .67-1.89l2.2.78L9 13l-2.63-1.52-2.2.78a1 1 0 1 1-.67-1.89l1.43-.5-1.3-.75a1 1 0 0 1 1-1.73l1.3.75-.13-1.5a1 1 0 1 1 2-.17l.2 2.3L10 7.6V4.4L8.2 3.35a1 1 0 1 1 1-1.73L11 2.6V3a1 1 0 0 1 1-1z"
        />
      </svg>

      {/* the Mac bar — thin, rounded, quietly filling */}
      <div className="frost-boot-bar" role="progressbar" aria-label="loading" aria-valuenow={Math.round(progress * 100)}>
        <div className="frost-boot-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </main>
  );
}
