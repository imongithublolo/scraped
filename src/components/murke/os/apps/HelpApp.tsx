"use client";

import { useMemo } from "react";
import { listCommands } from "@/lib/murke/commands";

const CATEGORY_TITLES: Record<string, string> = {
  fs: "FILE SYSTEM",
  apps: "APPLICATIONS",
  system: "SYSTEM",
  fun: "MISC",
};

/**
 * Help app: the dsh manual, man(1)-style. Fully scrollable.
 */
export default function HelpApp() {
  const cmds = useMemo(() => listCommands(), []);
  const groups = ["fs", "apps", "system", "fun"] as const;
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  return (
    <div className="flex h-full flex-col" dir="ltr">
      <div className="murke-scroll murke-glow-soft min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[12px] leading-[1.45]">
        <pre className="whitespace-pre-wrap font-mono">
{`DSH(1)                      DAEMON OS                      DSH(1)

NAME
     dsh — terminal shell of DAEMON OS

SYNOPSIS
     dsh command [arguments]

DESCRIPTION
     dsh is the hellfire shell. It runs against a virtual file
     system persisted in your browser, drives the chiptune synth,
     the ascii paint editor, the chat relay and — the reason you
     are here — a full scramjet web proxy over a wisp transport.

     Every application also opens as a window: use the taskbar at
     the bottom of the screen, or the icons on the desktop.

     The phosphor color is set with theme(1): hell (bsd red),
     amber, bone.`}
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
{`THE DESKTOP
     taskbar        start menu (▲), open windows, tray
     windows        drag the titlebar · double-click maximizes ·
                    corner grip resizes · — minimizes · ✕ closes
     files/viewer   file manager and read-only viewer apps
     browser        windowed scramjet browser (proxy(1))

KEYS
     Tab            complete command / path (ghost text shows the guess)
     ↑ / ↓          walk command history
     Ctrl+L         clear the screen
     Ctrl+C         abandon the current line

FILES
     /etc/motd            message of the day
     ~/readme.txt         what this machine is
     ~/credits.txt        the two who built it
     ~/music/*.mod        chiptune library (play(1))
     ~/paintings/         output of paint(1)
     /var/log/daemon.log  boot log

DIAGNOSTICS
     proxy status    probes the wisp relay and prints latency
     neofetch        vitals, with beastie watching

BUGS
     The cursor blinks at exactly 1.06 seconds. This is not a bug.

DAEMON 2.0                       ${today}                       DSH(1)`}
        </pre>
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-4 py-1.5 text-[10.5px] text-[var(--term-dim)]">
        <span>DSH(1) · DAEMON OS</span>
        <span>scroll freely — this page is all man</span>
      </div>
    </div>
  );
}
