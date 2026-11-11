"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppId,
  OutputKind,
  OutputLine,
  ProxyEngine,
  SoundEngine,
  SynthEngine,
  ThemeName,
} from "@/lib/murke/contracts";
import { LS } from "@/lib/murke/contracts";
import { getVfs } from "@/lib/murke/vfs";
import { commandNames, findCommand, historyRef } from "@/lib/murke/commands";
import { MURKE_ART_HTML } from "@/lib/murke/murke-art";
import { useWm } from "@/lib/murke/wm";
import MurkeArt from "../../MurkeArt";

export interface TerminalAppProps {
  theme: ThemeName;
  setTheme: (t: ThemeName) => void;
  crt: boolean;
  setCrt: (v: boolean) => void;
  sound: SoundEngine;
  synth: SynthEngine;
  proxy: ProxyEngine;
  onLogout: () => void;
}

const TIPS = [
  "tip: 'neofetch' shows the daemon's vitals — tab completes, ↑ recalls",
  "tip: 'proxy <url>' carries you past the fence",
  "tip: 'sound on' gives the keys their thock (off by default)",
];

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

/**
 * dsh — the daemon shell, hosted in its own desktop window.
 * Same bones as the classic build: ghost tab-completion, ↑/↓ history,
 * sticky-bottom autoscroll, 1.06s cursor — now dispatching apps as windows.
 */
export default function TerminalApp({ theme, setTheme, crt, setCrt, sound, synth, proxy, onLogout }: TerminalAppProps) {
  const vfs = useMemo(() => getVfs(), []);

  const [lines, setLines] = useState<OutputLine[]>([]);
  const idRef = useRef(1);
  const [input, setInput] = useState("");
  const [caret, setCaret] = useState(0);
  const [ghost, setGhost] = useState("");
  const [ghostOptions, setGhostOptions] = useState<string[]>([]);
  const [cwd, setCwd] = useState(getVfs().HOME);
  const [busy, setBusy] = useState(false);
  const [booted, setBooted] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const histRef = useRef<string[]>([]);
  const histIdxRef = useRef<number | null>(null);
  const draftRef = useRef("");
  const busyRef = useRef(false);
  const cwdRef = useRef<string>(cwd);
  const bootedRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
    cwdRef.current = cwd;
    bootedRef.current = booted;
  }, [busy, cwd, booted]);

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

  /* ---------- welcome block (the boot screen already did the theatrics) ---------- */

  useEffect(() => {
    const out: OutputLine[] = [];
    const motd = vfs.readFile("/etc/motd") ?? "";
    for (const l of motd.split("\n")) out.push({ id: idRef.current++, kind: "out", text: l });
    out.push({ id: idRef.current++, kind: "dim", text: "" });
    for (const t of TIPS) out.push({ id: idRef.current++, kind: "dim", text: t });
    out.push({ id: idRef.current++, kind: "dim", text: "" });
    out.push({ id: idRef.current++, kind: "out", text: "", html: MURKE_ART_HTML });
    setLines(out);
    setBooted(true);
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

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
        lastShRef.current = sh;
        prevTop = st;
        return;
      }
      stickRef.current = st > prevTop + 1 && fromBottom < 96;
      prevTop = st;
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stickRef.current = false;
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

  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el) return;
    const ro = new ResizeObserver(() => {
      lastShRef.current = el.scrollHeight;
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
      openApp: (app: Exclude<AppId, null>, arg?: string) => {
        useWm.getState().open(app, arg);
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
      print(`guest@daemon:${vfs.pretty(cwdRef.current)}$ ${trimmed}`);
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
          print(`dsh: command not found: ${name} — try '${near}' or 'help'`, "err");
          errored = true;
          break;
        }
        setBusy(true);
        try {
          await def.run(args, ctx);
        } catch (e) {
          print(`dsh: internal error: ${e instanceof Error ? e.message : String(e)}`, "err");
          errored = true;
        } finally {
          setBusy(false);
        }
      }
    },
    [print, pushHistory, ctx]
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
      if (!bootedRef.current) return;

      if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        clear();
        return;
      }
      if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        print(`guest@daemon:${vfs.pretty(cwdRef.current)}$ ${input}^C`);
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

      // key audio (opt-in only — defaults off)
      if (e.key === " ") sound.space();
      else if (e.key === "Backspace") sound.backspace();
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) sound.key();
    },
    [caret, clear, computeCompletion, ghost, input, print, refreshGhost, sound, submit, vfs]
  );

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
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

  /* ---------- render ---------- */

  const before = input.slice(0, caret);
  const at = input.slice(caret, caret + 1);
  const after = input.slice(caret + 1);
  const showGhost = ghost && caret === input.length;

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      onClick={() => inputRef.current?.focus()}
    >
      {/* output */}
      <div
        ref={scrollRef}
        className="murke-scroll murke-glow-soft min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 pt-2 text-[12.5px] leading-[1.4]"
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
      <div className="murke-glow px-3 pb-1.5 pt-1 text-[12.5px] leading-[1.4]">
        <pre className="whitespace-pre-wrap break-words font-mono">
          <span className="font-bold text-[var(--term-brand)]">guest@daemon</span>
          <span className="text-[var(--term-dim)]">:</span>
          <span className="text-[var(--term-fg)]">{vfs.pretty(cwd)}</span>
          <span className="text-[var(--term-dim)]">$ </span>
          <span className="text-[var(--term-fg)]">{before}</span>
          <span className="murke-cursor bg-[var(--term-fg)] text-[var(--term-bg)]">{at || "\u00a0"}</span>
          <span className="text-[var(--term-fg)]">{after}</span>
          {showGhost && <span className="murke-ghost text-[var(--term-fg)]">{ghost}</span>}
        </pre>
      </div>

      {/* slim status strip */}
      <div className="flex items-center justify-between gap-2 border-t border-[color-mix(in_srgb,var(--term-fg)_20%,transparent)] px-3 py-1 text-[10px] text-[var(--term-dim)]">
        <span className="murke-glow font-bold tracking-[0.2em] text-[var(--term-brand)]">DSH</span>
        <span className="truncate">{vfs.pretty(cwd)}</span>
        <span className="hidden shrink-0 sm:inline">{ghostOptions.length > 0 ? `${ghostOptions.length} matches` : `theme:${theme}`}</span>
      </div>

      {/* hidden capture input — click-transparent so wheel/touch/selection reach the output */}
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
    </div>
  );
}
