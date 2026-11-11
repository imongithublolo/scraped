"use client";

/**
 * Credits app: the two who built this place.
 */

function Heart({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block align-middle text-[var(--term-err)]"
      style={{ filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--term-err) 70%, transparent))" }}
      aria-hidden="true"
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
      </svg>
    </span>
  );
}

export default function CreditsApp() {
  return (
    <div className="flex h-full flex-col">
      <div className="murke-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col items-center gap-1 pb-3">
          <span
            className="text-[22px] leading-none text-[var(--term-brand)]"
            style={{ filter: "drop-shadow(0 0 10px color-mix(in srgb, var(--term-brand) 70%, transparent))" }}
            aria-hidden="true"
          >
            ▲
          </span>
          <span className="font-mono text-[10px] font-bold tracking-[0.42em] text-[var(--term-brand)]">DAEMON//OS</span>
          <span className="font-mono text-[9px] tracking-[0.3em] text-[var(--term-dim)]">hellfire build 2.0.6</span>
        </div>

        <div className="border-t border-[color-mix(in_srgb,var(--term-fg)_18%,transparent)] pt-3" />

        <div className="mt-3 space-y-4 font-mono text-[12px] text-[var(--term-fg)]">
          <section>
            <div className="mb-1.5 tracking-[0.25em] text-[var(--term-dim)]">── DEVELOPERS</div>
            <div className="flex items-baseline justify-between py-0.5">
              <span className="font-bold text-[var(--term-hi)]">b29s</span>
              <Heart />
            </div>
            <div className="flex items-baseline justify-between py-0.5">
              <span className="font-bold text-[var(--term-hi)]">GLM</span>
              <Heart />
            </div>
          </section>

          <section>
            <div className="mb-1.5 tracking-[0.25em] text-[var(--term-dim)]">── PROXY CORE</div>
            <div className="text-[var(--term-dim)]">scramjet 1.1 · wisp transport · libcurl wasm</div>
            <div className="text-[var(--term-dim)]">mercury workshop — the real deal</div>
          </section>

          <section>
            <div className="mb-1.5 tracking-[0.25em] text-[var(--term-dim)]">── AESTHETIC</div>
            <div className="text-[var(--term-dim)]">hellfire red · bsd blood · brimstone glow</div>
            <div className="text-[var(--term-dim)]">beastie nods approvingly</div>
          </section>
        </div>

        <pre className="murke-glow mt-5 whitespace-pre text-center font-mono text-[10px] leading-[1.3] text-[var(--term-brand)]">
{`  ██╗  ██╗ ███████╗ ██╗     ██╗
  ██║  ██║ ██╔════╝ ██║     ██║
  ███████║ █████╗   ██║     ██║
  ██╔══██║ ██╔══╝   ██║     ██║
  ██║  ██║ ███████╗ ███████╗ ███████╗
  ╚═╝  ╚═╝ ╚══════╝ ╚══════╝ ╚══════╝`}
        </pre>
        <div className="mt-1 text-center font-mono text-[9px] tracking-[0.35em] text-[var(--term-dim)]">
          {"<3 <3 <3"}
        </div>
      </div>
      <div className="shrink-0 border-t border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-3 py-1 font-mono text-[9.5px] text-[var(--term-dim)]">
        {"with love from the underworld · <3"}
      </div>
    </div>
  );
}
