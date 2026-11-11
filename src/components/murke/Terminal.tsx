"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  OutputKind,
  OutputLine,
  PaneKind,
  ProxyEngine,
  SoundEngine,
  SynthEngine,
  ThemeName,
} from "@/lib/murke/contracts";
import { LS } from "@/lib/murke/contracts";
import { VFS } from "@/lib/murke/vfs";
import { commandNames, findCommand, historyRef, listCommands } from "@/lib/murke/commands";
import { MURKE_ART_HTML } from "@/lib/murke/murke-art";
import { isThemeName } from "@/lib/murke/themes";
import HelpPane from "./HelpPane";
import PaintPane from "./PaintPane";
import ChatPane from "./ChatPane";
import ProxyPane from "./ProxyPane";
import MurkeArt from "./MurkeArt";

export interface TerminalProps {
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
  crt: boolean;
  setCrt: (v: boolean) => void;
  sound: SoundEngine;
  synth: SynthEngine;
  proxy: ProxyEngine;
  onLogout: () => void;
}

const BOOT_LOG = [
  "[  OK  ] reached target phosphor.warmup",
  "[  OK  ] mounted /dev/vfs0 on /",
  "[  OK  ] keyboard sfx pool ready (opt-in: sound on)",
  "[  OK  ] cursor sync locked at 1.06s",
  "[  OK  ] scramjet transport armed",
  "[  OK  ] wisp relay handshake",
  "[ WARN ] fence detected. ignoring.",
];

const TIPS = [
  "tip: 'help' opens the manual — tab completes, ↑ recalls",
  "tip: 'proxy <url>' carries you past the fence",
  "tip: 'sound on' gives the keys their thock",
];

interface PaneState {
  kind: Exclude<PaneKind, null>;
  arg?: string;
}

function kindClass(k: OutputKind): string {
  switch (k) {
    case "err":
      return "text-[var(--term-err)] font-bold";
    case "dim":
      return "text-[var(--term-dim)]";
    case "ok":
      return "text-[var(--term-fg)] font-bold";
    default:
      return "text-[var(--term-fg)]";
  }
}

export default function Terminal({
  theme,
  setTheme,
  crt,
  setCrt,
  sound,
  synth,
  proxy,
  onLogout,
}: TerminalProps) {
  const vfsRef = useRef<VFS | null>(null);
  if (vfsRef.current === null && typeof window !== "undefined") {
    vfsRef.current = VFS.load();
  }
  const vfs = vfsRef.current ?? new VFS(); // SSR fallback (never rendered)

  const [lines, setLines] = useState<OutputLine[]>([]);
  const idRef = useRef(1);
  const [input, setInput] = useState("");
  const [caret, setCaret] = useState(0);
  const [ghost, setGhost] = useState("");
  const [ghostOptions, setGhostOptions] = useState<string[]>([]);
  const [cwd, setCwd] = useState(VFS.HOME);
  const [pane, setPane] = useState<PaneState | null>(null);
  const [busy, setBusy] = useState(false);
  const [booted, setBooted] = useState(false);
  const [now, setNow] = useState<{ name: string; elapsed: number; total: number } | null>(null);
  const [clock, setClock] = useState("--:--:--");
  const [wispLabel, setWispLabel] = useState<string>("wisp:?");

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const histRef = useRef<string[]>([]);
  const histIdxRef = useRef<number | null>(null);
  const draftRef = useRef("");
  const paneRef = useRef<PaneState | null>(null);
  const busyRef = useRef(false);
  const cwdRef = useRef<string>(cwd);
  useEffect(() => {
    paneRef.current = pane;
    busyRef.current = busy;
    cwdRef.current = cwd;
  }, [pane, busy, cwd]);

  /* ---------- output helpers ---------- */

  const print = useCallback((text = "", kind: OutputKind = "out") => {
    setLines((prev) => {
      const next = [...prev, { id: idRef.current++, kind, text }];
      return next.length > 800 ? next.slice(next.length - 600) : next;
    });
  }, []);

  const printHTML = useCallback((html: string) => {
    setLines((prev) => [...prev, { id: idRef.current++, kind: "out", text: "", html }]);
  }, []);

  const clear = useCallback(() => setLines([]), []);

  /* ---------- history persistence ---------- */

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS.history);
      if (raw) histRef.current = JSON.parse(raw) as string[];
    } catch {
      /* ignore */
    }
    historyRef.current = histRef.current;
  }, []);

  const pushHistory = useCallback((cmd: string) => {
    const h = histRef.current;
    if (h[h.length - 1] === cmd) return;
    h.push(cmd);
    if (h.length > 100) h.splice(0, h.length - 100);
    try {
      localStorage.setItem(LS.history, JSON.stringify(h));
    } catch {
      /* ignore */
    }
    historyRef.current = h;
  }, []);

  /* ---------- boot sequence ---------- */

  useEffect(() => {
    const timers: number[] = [];
    let done = false; // boot fully rendered (animated or skipped)

    const bootBlock = (): OutputLine[] => {
      const out: OutputLine[] = [];
      // boot log + motd + tips, then the logo LAST so it rests in full view
      for (const l of BOOT_LOG) out.push({ id: idRef.current++, kind: "out", text: l });
      out.push({ id: idRef.current++, kind: "dim", text: "" });
      const motd = vfs.readFile("/etc/motd") ?? "";
      for (const l of motd.split("\n")) out.push({ id: idRef.current++, kind: "out", text: l });
      out.push({ id: idRef.current++, kind: "dim", text: "" });
      for (const t of TIPS) out.push({ id: idRef.current++, kind: "dim", text: t });
      out.push({ id: idRef.current++, kind: "dim", text: "" });
      out.push({ id: idRef.current++, kind: "out", text: "", html: MURKE_ART_HTML });
      return out;
    };

    const finishInstant = () => {
      if (done) return; // animated boot already finished — nothing to skip
      done = true;
      for (const t of timers) clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      // replace any partial boot output with the complete block (no duplicates)
      setLines(bootBlock);
      setBooted(true);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    };

    const startAnimatedBoot = () => {
      if (done) return;
      BOOT_LOG.forEach((l, i) => {
        timers.push(window.setTimeout(() => print(l, "out"), 320 + i * 95));
      });
      timers.push(
        window.setTimeout(
          () => {
            print("", "dim");
            const motd = vfs.readFile("/etc/motd") ?? "";
            for (const l of motd.split("\n")) print(l, "out");
            print("", "dim");
            TIPS.forEach((t, i) => timers.push(window.setTimeout(() => print(t, "dim"), i * 140)));
            timers.push(
              window.setTimeout(() => {
                print("", "dim");
                printHTML(MURKE_ART_HTML); // logo lands in view as the final boot line
                done = true;
                window.removeEventListener("keydown", onKey);
                setBooted(true);
                window.setTimeout(() => inputRef.current?.focus(), 30);
              }, TIPS.length * 140 + 60)
            );
          },
          320 + BOOT_LOG.length * 95 + 100
        )
      );
    };

    const onKey = () => finishInstant();
    window.addEventListener("keydown", onKey);

    /* wait for the mono webfont so the logo fits with final metrics — no refit jump */
    let fallbackTimer = 0;
    if (typeof document !== "undefined" && document.fonts?.status === "loaded") {
      startAnimatedBoot();
    } else {
      fallbackTimer = window.setTimeout(startAnimatedBoot, 1500);
      void document.fonts?.ready.then(() => {
        window.clearTimeout(fallbackTimer);
        if (!done) startAnimatedBoot();
      });
    }

    return () => {
      done = true;
      window.clearTimeout(fallbackTimer);
      for (const t of timers) clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  /* ---------- wisp status probe (status bar) ---------- */

  useEffect(() => {
    let dead = false;
    const probe = async () => {
      const s = await proxy.status();
      if (dead) return;
      setWispLabel(s.ok ? `wisp:ok${typeof s.latencyMs === "number" ? ` ${s.latencyMs}ms` : ""}` : "wisp:--");
    };
    const t = window.setTimeout(probe, 1500);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [proxy]);

  /* ---------- now playing + clock ---------- */

  useEffect(() => {
    const iv = setInterval(() => {
      setClock(new Date().toLocaleTimeString("en-GB", { hour12: false }));
      const np = synth.nowPlaying();
      setNow((prev) => {
        if (!np) return null;
        const same = prev !== null && prev.name === np.name;
        return { name: np.name, elapsed: same ? prev.elapsed : 0, total: np.lengthSec };
      });
    }, 500);
    return () => clearInterval(iv);
  }, [synth]);

  useEffect(() => {
    synth.onTick((t) => {
      setNow({ name: t.name, elapsed: t.elapsed, total: t.total });
    });
    return () => synth.onTick(null);
  }, [synth]);

  /* ---------- autoscroll (sticky-bottom: never yanks the user upward) ---------- */

  const stickRef = useRef(true);
  const lastShRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let prevTop = 0;

    const onScroll = () => {
      const sh = el.scrollHeight;
      const st = el.scrollTop;
      const fromBottom = sh - st - el.clientHeight;
      if (sh !== lastShRef.current) {
        // scroll fired by a layout clamp (content resized) — not a user scroll
        lastShRef.current = sh;
        prevTop = st;
        return;
      }
      // re-stick only when scrolling DOWN into the bottom zone; any upward
      // movement (wheel, touch, scrollbar) leaves the bottom for good
      stickRef.current = st > prevTop + 1 && fromBottom < 96;
      prevTop = st;
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stickRef.current = false; // user scrolled up — leave the bottom
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines, ghost, busy]);

  /* follow the bottom when content reflows (font swap / art refit) while stuck */
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el) return;
    const ro = new ResizeObserver(() => {
      lastShRef.current = el.scrollHeight; // keep the clamp-detection baseline fresh
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  /* ---------- completion ---------- */

  const computeCompletion = useCallback(
    (text: string, pos: number): { ghost: string; options: string[] } => {
      if (pos !== text.length) return { ghost: "", options: [] };
      const m = /(\S*)$/.exec(text);
      const tok = m ? m[1] : "";
      const before = text.slice(0, text.length - tok.length);
      const isFirst = before.trim().length === 0;
      const pool: string[] = [];
      if (isFirst) pool.push(...commandNames());
      for (const n of vfs.list(cwd)) pool.push(n.type === "dir" ? n.name + "/" : n.name);
      const matches = pool.filter((p) => p.startsWith(tok) && p.length > tok.length);
      if (matches.length === 0) return { ghost: "", options: [] };
      let lcp = matches[0];
      for (const p of matches) {
        let i = 0;
        while (i < lcp.length && i < p.length && lcp[i] === p[i]) i++;
        lcp = lcp.slice(0, i);
      }
      if (lcp.length <= tok.length) return { ghost: "", options: matches.slice(0, 14) };
      return { ghost: lcp.slice(tok.length), options: matches.length > 1 ? matches.slice(0, 14) : [] };
    },
    [vfs, cwd]
  );

  const refreshGhost = useCallback(
    (text: string, pos: number) => {
      const r = computeCompletion(text, pos);
      setGhost(r.ghost);
      setGhostOptions([]);
    },
    [computeCompletion]
  );

  /* ---------- command context ---------- */

  const ctx = useMemo(
    () => ({
      print,
      printHTML,
      clear,
      getCwd: () => cwdRef.current,
      setCwd: (p: string) => setCwd(p),
      openPane: (kind: Exclude<PaneKind, null>, arg?: string) => {
        setPane({ kind, arg });
        inputRef.current?.blur();
      },
      closePane: () => {
        setPane(null);
        window.setTimeout(() => inputRef.current?.focus(), 30);
      },
      vfs,
      theme,
      setTheme,
      crt,
      setCrt,
      sound,
      synth,
      proxy,
      logout: onLogout,
    }),
    [print, printHTML, clear, vfs, theme, setTheme, crt, setCrt, sound, synth, proxy, onLogout]
  );

  /* ---------- dispatch ---------- */

  const dispatch = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      print(`guest@murke:${vfs.pretty(cwd)}$ ${trimmed}`);
      if (!trimmed) return;
      pushHistory(trimmed);
      histIdxRef.current = null;
      draftRef.current = "";

      // simple && chaining: run segments left to right, stop on error
      const segments = trimmed
        .split("&&")
        .map((s) => s.trim())
        .filter(Boolean);
      let errored = false;
      for (const seg of segments) {
        if (errored) break;
        const parts = seg.split(/\s+/);
        const name = parts[0];
        const args = parts.slice(1);
        const def = findCommand(name);
        if (!def) {
          const pool = commandNames();
          const near = pool.find((c) => c.startsWith(name[0])) ?? "help";
          print(`murkesh: command not found: ${name} — try '${near}' or 'help'`, "err");
          errored = true;
          break;
        }
        setBusy(true);
        try {
          await def.run(args, ctx);
        } catch (e) {
          print(`murkesh: internal error: ${e instanceof Error ? e.message : String(e)}`, "err");
          errored = true;
        } finally {
          setBusy(false);
        }
      }
    },
    [print, pushHistory, cwd, vfs, ctx]
  );

  /* ---------- input events ---------- */

  const submit = useCallback(() => {
    const raw = input;
    setInput("");
    setCaret(0);
    setGhost("");
    setGhostOptions([]);
    void dispatch(raw);
  }, [input, dispatch]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (paneRef.current !== null) {
        // panes own the keyboard; keep the hidden input empty
        e.preventDefault();
        return;
      }
      if (!booted) return; // boot can be skipped by any key; ignore input until done

      if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        clear();
        return;
      }
      if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        print(`guest@murke:${vfs.pretty(cwd)}$ ${input}^C`);
        setInput("");
        setCaret(0);
        setGhost("");
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        sound.enter();
        submit();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const r = computeCompletion(input, caret);
        if (r.ghost) {
          const next = input.slice(0, caret) + r.ghost;
          setInput(next);
          const np = next.length;
          setCaret(np);
          setGhost("");
          setGhostOptions([]);
        } else if (r.options.length > 0) {
          print("  " + r.options.join("   "), "dim");
        }
        sound.key();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const h = histRef.current;
        if (h.length === 0) return;
        if (histIdxRef.current === null) draftRef.current = input;
        const idx = histIdxRef.current === null ? h.length - 1 : Math.max(0, histIdxRef.current - 1);
        histIdxRef.current = idx;
        setInput(h[idx]);
        setCaret(h[idx].length);
        refreshGhost(h[idx], h[idx].length);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const h = histRef.current;
        if (histIdxRef.current === null) return;
        const idx = Math.min(h.length, histIdxRef.current + 1);
        if (idx === h.length) {
          histIdxRef.current = null;
          const d = draftRef.current;
          setInput(d);
          setCaret(d.length);
          refreshGhost(d, d.length);
        } else {
          histIdxRef.current = idx;
          setInput(h[idx]);
          setCaret(h[idx].length);
          refreshGhost(h[idx], h[idx].length);
        }
        return;
      }
      if (e.key === "ArrowRight" && caret === input.length && ghost) {
        // right arrow at EOL accepts the ghost completion too
        e.preventDefault();
        setInput(input + ghost);
        setCaret(input.length + ghost.length);
        setGhost("");
        return;
      }
      if (e.key === "Escape") {
        setInput("");
        setCaret(0);
        setGhost("");
        return;
      }

      // key audio
      if (e.key === " ") sound.space();
      else if (e.key === "Backspace") sound.backspace();
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) sound.key();
    },
    [booted, caret, clear, computeCompletion, cwd, ghost, input, print, refreshGhost, sound, submit, vfs]
  );

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (paneRef.current !== null) {
        e.target.value = "";
        return;
      }
      const v = e.target.value;
      setInput(v);
      const pos = e.target.selectionStart ?? v.length;
      setCaret(pos);
      refreshGhost(v, pos);
    },
    [refreshGhost]
  );

  const onSelect = useCallback(
    (e: React.SyntheticEvent<HTMLInputElement>) => {
      const pos = (e.target as HTMLInputElement).selectionStart ?? caret;
      setCaret(pos);
      refreshGhost(input, pos);
    },
    [caret, input, refreshGhost]
  );

  /* ---------- pane close ---------- */

  const closePane = useCallback(() => {
    setPane(null);
    window.setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const onSavePaint = useCallback(
    (name: string, content: string) => {
      const safe = name.replace(/[\/\\]/g, "_").slice(0, 64) || "untitled.txt";
      const path = "~/paintings/" + safe;
      const err = vfs.writeFile(path, content, cwd);
      if (err) print(err, "err");
      else print(`saved ${vfs.pretty(vfs.resolve(path, cwd))}`, "ok");
      closePane();
    },
    [vfs, cwd, print, closePane]
  );

  /* ---------- render ---------- */

  const before = input.slice(0, caret);
  const at = input.slice(caret, caret + 1);
  const after = input.slice(caret + 1);
  const showGhost = ghost && caret === input.length;

  const nowLabel = now
    ? `♪ ${now.name} ${Math.floor(now.elapsed / 60)}:${String(Math.floor(now.elapsed % 60)).padStart(2, "0")}`
    : null;

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      onClick={() => {
        if (paneRef.current === null) inputRef.current?.focus();
      }}
    >
      {/* output */}
      <div
        ref={scrollRef}
        className="murke-scroll murke-glow-soft min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 pt-2 text-[13px] leading-[1.4]"
        aria-live="polite"
      >
        <div ref={contentRef}>
          {lines.map((l) =>
            l.html !== undefined ? (
              <MurkeArt key={l.id} html={l.html} />
            ) : (
              <pre key={l.id} className={`whitespace-pre-wrap break-words font-mono ${kindClass(l.kind)}`}>
                {l.text || " "}
              </pre>
            )
          )}
          {busy && <pre className="font-mono text-[var(--term-dim)]">▓ processing…</pre>}
        </div>
      </div>

      {/* prompt line */}
      <div className="murke-glow px-3 pb-2 pt-1 text-[13px] leading-[1.4]">
        <pre className="whitespace-pre-wrap break-words font-mono">
          <span className="font-bold text-[var(--term-brand)]">guest@murke</span>
          <span className="text-[var(--term-dim)]">:</span>
          <span className="text-[var(--term-fg)]">{vfs.pretty(cwd)}</span>
          <span className="text-[var(--term-dim)]">$ </span>
          <span className="text-[var(--term-fg)]">{before}</span>
          <span className="murke-cursor bg-[var(--term-fg)] text-[var(--term-bg)]">{at || "\u00a0"}</span>
          <span className="text-[var(--term-fg)]">{after}</span>
          {showGhost && <span className="murke-ghost text-[var(--term-fg)]">{ghost}</span>}
        </pre>
      </div>

      {/* status bar */}
      <div className="flex items-center justify-between gap-2 border-t border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-3 py-1.5 text-[11px] text-[var(--term-dim)]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="murke-glow font-bold text-[var(--term-brand)]">MURKE</span>
          <span className="hidden sm:inline">v1.0</span>
          <span className="truncate">│ {vfs.pretty(cwd)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {nowLabel && <span className="hidden text-[var(--term-fg)] md:inline">{nowLabel}</span>}
          <span className="hidden sm:inline">│ theme:{theme}</span>
          <span className="hidden sm:inline">│ crt:{crt ? "on" : "off"}</span>
          <span className="hidden sm:inline">│ sfx:{sound.enabled ? "on" : "off"}</span>
          <span>│ {wispLabel}</span>
          <span>│ {clock}</span>
        </div>
      </div>

      {/* hidden capture input — click-transparent so wheel/touch/selection reach the output; root onClick refocuses */}
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onSelect={onSelect}
        aria-label="terminal input"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="pointer-events-none absolute inset-0 z-10 h-full w-full cursor-default bg-transparent text-base text-transparent opacity-0 outline-none"
        style={{ caretColor: "transparent" }}
      />

      {/* panes */}
      {pane?.kind === "help" && <HelpPane onClose={closePane} theme={theme} />}
      {pane?.kind === "paint" && <PaintPane onClose={closePane} onSave={onSavePaint} />}
      {pane?.kind === "chat" && <ChatPane onClose={closePane} />}
      {pane?.kind === "proxy" && (
        <ProxyPane key={pane.arg ?? "default"} url={pane.arg ?? "https://duckduckgo.com"} proxy={proxy} onClose={closePane} />
      )}
    </div>
  );
}
