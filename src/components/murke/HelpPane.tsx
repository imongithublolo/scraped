"use client";

import { useEffect, useRef } from "react";
import { listCommands } from "@/lib/murke/commands";
import type { ThemeName } from "@/lib/murke/contracts";

const CATEGORY_TITLES: Record<string, string> = {
  fs: "FILE SYSTEM",
  apps: "APPLICATIONS",
  system: "SYSTEM",
  fun: "MISC",
};

/**
 * man(1)-style manual for murkesh. Scrollable, q/esc closes.
 */
export default function HelpPane({
  onClose,
  theme,
}: {
  onClose: () => void;
  theme: ThemeName;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    el?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      const el = scrollRef.current;
      if (!el) return;
      if (e.key === "q") {
        e.preventDefault();
        onClose();
      } else if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        el.scrollTop += 28;
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        el.scrollTop -= 28;
      } else if (e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        el.scrollTop += el.clientHeight * 0.85;
      } else if (e.key === "PageUp") {
        e.preventDefault();
        el.scrollTop -= el.clientHeight * 0.85;
      } else if (e.key === "g") {
        e.preventDefault();
        el.scrollTop = 0;
      } else if (e.key === "G") {
        e.preventDefault();
        el.scrollTop = el.scrollHeight;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cmds = listCommands();
  const groups = ["fs", "apps", "system", "fun"] as const;

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-[var(--term-bg)] text-[var(--term-fg)]" dir="ltr">
      <div
        ref={scrollRef}
        tabIndex={0}
        className="murke-scroll murke-glow-soft flex-1 overflow-y-auto px-4 py-3 text-[12.5px] leading-[1.45] outline-none"
      >
        <pre className="whitespace-pre-wrap font-mono">
{`MURKESH(1)                  MURKE Proxy OS                  MURKESH(1)

NAME
     murkesh — terminal shell of the MURKE proxy OS

SYNOPSIS
     murkesh command [arguments]

DESCRIPTION
     murkesh is the only interface this machine offers. It runs against
     a virtual file system persisted in your browser, drives the local
     chiptune synth, the ascii paint editor, the chat relay and — the
     reason you are here — a full scramjet web proxy over a wisp
     transport.

     Everything is monochrome on purpose. The phosphor color is set
     with theme(1).`}
        </pre>

        {groups.map((g) => (
          <div key={g} className="mt-5">
            <div className="mb-1 tracking-[0.25em] text-[var(--term-dim)]">
              {"─".repeat(4)} {CATEGORY_TITLES[g]}
            </div>
            <table className="w-full border-collapse font-mono">
              <tbody>
                {cmds
                  .filter((c) => c.category === g)
                  .map((c) => (
                    <tr key={c.name} className="align-top">
                      <td className="py-[1px] pr-4 whitespace-nowrap">
                        <span className="font-bold">{c.name}</span>
                        <span className="text-[var(--term-dim)]">{" " + c.usage.slice(c.name.length)}</span>
                      </td>
                      <td className="py-[1px] text-[var(--term-dim)]">{c.desc}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}

        <pre className="mt-5 whitespace-pre-wrap font-mono">
{`KEYS
     Tab            complete command / path (ghost text shows the guess)
     ↑ / ↓          walk command history
     Ctrl+L         clear the screen
     Ctrl+C         abandon the current line
     Esc            close the active pane

FILES
     /etc/motd            message of the day
     ~/readme.txt         what this machine is
     ~/music/*.mod        chiptune library (play(1))
     ~/paintings/         output of paint(1)
     /var/log/murke.log   boot log

ENVIRONMENT
     MURKE_GATE_PASSWORD       /api/auth, salted sha256, server side only
     WISP_RELAY                see proxy(1) 'wisp' subcommand

DIAGNOSTICS
     proxy status    probes the wisp relay and prints latency
     neofetch        vibes

BUGS
     The cursor blinks at exactly 1.06 seconds. This is not a bug.

MURKE 1.0                        ${new Date().toISOString().slice(0, 10)}                    MURKESH(1)`}
        </pre>
      </div>
      <div className="flex items-center justify-between border-t border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-4 py-1.5 text-[11.5px] text-[var(--term-dim)]">
        <span>MURKESH(1) · phosphor: {theme}</span>
        <span>j/k scroll · space pgdn · q close</span>
      </div>
    </div>
  );
}
