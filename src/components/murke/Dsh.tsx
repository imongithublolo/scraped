"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  OutputKind,
  OutputLine,
  ProxyEngine,
  SoundEngine,
  SynthEngine,
} from "@/lib/murke/contracts";
import { LS } from "@/lib/murke/contracts";
import { getVfs } from "@/lib/murke/vfs";
import { mountAllGlobes } from "@/lib/murke/globe";
import { commandNames, findCommand, historyRef } from "@/lib/murke/commands";
import { MURKE_ART_HTML, themeArt } from "@/lib/murke/murke-art";
import { getThemeDef } from "@/lib/murke/themes";
import { useOS, useThemeKey } from "@/lib/murke/os-store";
import MurkeArt from "./MurkeArt";

export interface DshProps {
  sound: SoundEngine;
  synth: SynthEngine;
  proxy: ProxyEngine;
  onLogout: () => void;
}

/** One-line hint under the logo. Everything else lives in `help`. */
const WELCOME_HINT = "help — commands · proxy <url> — browse · credits — who built it";

/** The quick launcher printed under the hint — every entry is CLICKABLE
 *  (the shell stamps data-cmd on each command). One line, no icons, no
 *  clutter: a desktop's worth of apps in a single terminal-native row. */
const QUICK_APPS: Array<{ cmd: string; label: string }> = [
  { cmd: "files", label: "file manager" },
  { cmd: "newtab", label: "browse" },
  { cmd: "notes", label: "notes" },
  { cmd: "chat", label: "relay chat" },
  { cmd: "paint", label: "paint" },
  { cmd: "weather", label: "weather" },
];

function quickAppsHtml(): string {
  return (
    `<span style="color:var(--term-dim)">quick · </span>` +
    QUICK_APPS.map(
      (a) =>
        `<span data-cmd="${a.cmd}" role="button" tabindex="-1" title="run ${a.cmd}" style="color:var(--term-brand);cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px">${a.cmd}</span>` +
        `<span style="color:var(--term-dim)"> ${a.label}</span>`,
    ).join(`<span style="color:var(--term-dim)"> · </span>`)
  );
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

/**
 * A printed-HTML block (raw trusted html from commands). MEMOIZED — and
 * this is load-bearing for anything hosting a canvas (the weather globe):
 * React 19's setProp re-writes dangerouslySetInnerHTML whenever the DOM's
 * current innerHTML differs from the prop string. three.js stamps its
 * canvases (data-engine + width/height buffers), so an un-memoized block
 * gets re-set EVERY render pass — the canvas is destroyed and remounted
 * ~once a second, i.e. THE FLASH. Memo bails out on identical props and
 * the DOM is left entirely alone.
 */
const HtmlBlock = memo(function HtmlBlock({ html }: { html: string }) {
  return (
    <div
      className="font-mono leading-[1.4] text-[var(--term-fg)]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

/**
 * dsh — the murke terminal, now as a desktop APP WINDOW. Ghost
 * tab-completion, ↑/↓ history, sticky-bottom autoscroll, 1.06s block
 * cursor. Apps launch as their own mac-style windows via the OS store;
 * the terminal keeps being the machine's heart.
 */
export default function Dsh({ sound, synth, proxy, onLogout }: DshProps) {
  const vfs = useMemo(() => getVfs(), []);

  /* theme + crt live in the OS store now (the settings app owns the knobs) */
  const theme = useThemeKey();
  const setTheme = useOS((s) => s.setTheme);
  const crt = useOS((s) => s.settings.crt);
  const patchCrt = useOS((s) => s.patchCrt);
  const openApp = useOS((s) => s.openApp);

  const [lines, setLines] = useState<OutputLine[]>([]);
  const idRef = useRef(1);
  const [input, setInput] = useState("");
  const [caret, setCaret] = useState(0);
  const [ghost, setGhost] = useState("");
  const [cwd, setCwd] = useState(getVfs().HOME);
  const [busy, setBusy] = useState(false);
  const [booted, setBooted] = useState(false);
  /** active ask() prompt — the shell borrows the input line until it resolves */
  const [askState, setAskState] = useState<{
    label: string;
    mask: boolean;
    resolve: (v: string) => void;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const histRef = useRef<string[]>([]);
  const histIdxRef = useRef<number | null>(null);
  const draftRef = useRef("");
  const busyRef = useRef(false);
  const cwdRef = useRef<string>(cwd);
  const bootedRef = useRef(false);
  const askRef = useRef(askState);
  useEffect(() => {
    busyRef.current = busy;
    cwdRef.current = cwd;
    bootedRef.current = booted;
    askRef.current = askState;
  }, [busy, cwd, booted, askState]);

  /* ---------- ask — masked input prompt (passwords) ---------- */

  const ask = useCallback((label: string, opts?: { mask?: boolean }) => {
    return new Promise<string>((resolve) => {
      setGhost("");
      setAskState({ label, mask: Boolean(opts?.mask), resolve });
      window.setTimeout(() => inputRef.current?.focus(), 30);
    });
  }, []);

  /* ---------- output helpers ---------- */

  const print = useCallback((text = "", kind: OutputKind = "out") => {
    setLines((prev) => {
      const next = [...prev, { id: idRef.current++, kind, text }];
      return next.length > 800 ? next.slice(next.length - 600) : next;
    });
  }, []);

  const printHTML = useCallback((html: string, fit = true, block = false) => {
    setLines((prev) => [...prev, { id: idRef.current++, kind: "out", text: "", html, fit, block }]);
  }, []);

  /** clear wipes the screen AND re-prints the murke textart logo. The devil
   *  sigil is exclusive to the neofetch command — nowhere else. Also Ctrl+L. */
  const clear = useCallback(() => {
    setLines([
      { id: idRef.current++, kind: "out", text: "", html: themeArt(MURKE_ART_HTML, getThemeDef(themeRef.current).art), logo: true, logoArt: "murke" },
      { id: idRef.current++, kind: "dim", text: "" },
    ]);
  }, []);

  /* the clear callback reads the theme through a ref so it never goes stale */
  const themeRef = useRef(theme);
  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

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

  /* ---------- welcome block: the sigil and one line. that's it. ---------- */

  useEffect(() => {
    const out: OutputLine[] = [];
    // the boot intro: the murke textart — the devil sigil lives ONLY in neofetch
    out.push({ id: idRef.current++, kind: "out", text: "", html: themeArt(MURKE_ART_HTML, getThemeDef(theme).art), logo: true, logoArt: "murke" });
    out.push({ id: idRef.current++, kind: "dim", text: "" });
    out.push({ id: idRef.current++, kind: "dim", text: WELCOME_HINT });
    // the app launcher — clickable, one row, terminal-native
    out.push({ id: idRef.current++, kind: "out", text: "", html: quickAppsHtml(), fit: false });
    out.push({ id: idRef.current++, kind: "dim", text: "" });
    setLines(out);
    setBooted(true);
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
    // theme intentionally not a dep: the recolor effect below owns it
  }, [vfs]);

  /* theme switch recolors the intro block in place — themes feel alive */
  useEffect(() => {
    setLines((prev) =>
      prev.map((l) =>
        l.logo
          ? {
              ...l,
              html: themeArt(MURKE_ART_HTML, getThemeDef(theme).art),
            }
          : l,
      )
    );
  }, [theme]);

  /* ---------- pre-warm the proxy engine (scripts, sw, transport) ---------- */

  useEffect(() => {
    const t = window.setTimeout(() => {
      void proxy.init().catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [proxy]);

  /* ---------- autoscroll (pinned-to-bottom unless the user scrolls up) ---------- */

  const stickRef = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      // Only RE-ARM here. Font swaps / scroll-anchoring / refits can shift
      // scrollTop without any user gesture — if a scroll event could disarm
      // the pin, a late webfont would permanently break autoscroll. Disarm
      // happens exclusively on real upward gestures below.
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) stickRef.current = true;
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stickRef.current = false;
    };

    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? null;
      if (touchY !== null && y !== null && y > touchY + 8) stickRef.current = false; // finger dragged down
      touchY = y;
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines, ghost, busy]);

  /* the shell re-applies printHTML blocks on re-render (innerHTML), which
     wipes mounted globes — every render pass re-mounts fresh canvas slots */
  useEffect(() => {
    const t = window.setTimeout(mountAllGlobes, 80);
    return () => window.clearTimeout(t);
  });

  /* art blocks re-fit their font after mount — re-anchor when they announce it */
  useEffect(() => {
    const refit = () => {
      const el2 = scrollRef.current;
      if (el2 && stickRef.current) el2.scrollTop = el2.scrollHeight;
    };
    window.addEventListener("murke-art-resized", refit);
    return () => window.removeEventListener("murke-art-resized", refit);
  }, []);

  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el) return;
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  /* ---------- window-world plumbing ---------- */

  /* "open in terminal" from the file manager — raise the terminal and jump to that folder */
  useEffect(() => {
    const onCd = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (typeof detail !== "string" || !detail) return;
      setCwd(getVfs().resolve(detail));
      openApp("dsh");
      window.setTimeout(() => inputRef.current?.focus(), 40);
    };
    window.addEventListener("murke-cd", onCd);
    return () => window.removeEventListener("murke-cd", onCd);
  }, [openApp]);

  /* the menu bar / desktop hand commands here: focus terminal → run */
  useEffect(() => {
    const onRun = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      if (typeof cmd !== "string" || !cmd || !bootedRef.current) return;
      inputRef.current?.focus();
      void dispatchRef.current?.(cmd);
    };
    window.addEventListener("murke-run", onRun);
    return () => window.removeEventListener("murke-run", onRun);
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
    },
    [computeCompletion]
  );

  /* ---------- command context ---------- */

  const ctx = useMemo(
    () => ({
      print,
      printHTML,
      clear,
      ask,
      getCwd: () => cwdRef.current,
      setCwd: (p: string) => setCwd(p),
      openApp: (app, arg, opts) => openApp(app, arg, opts),
      vfs,
      theme,
      setTheme,
      crt,
      patchCrt,
      sound,
      synth,
      proxy,
      logout: onLogout,
    }),
    [print, printHTML, clear, ask, vfs, theme, setTheme, crt, patchCrt, sound, synth, proxy, onLogout, openApp]
  );

  /* ---------- dispatch ---------- */

  const dispatch = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      print(`guest@murke:${vfs.pretty(cwdRef.current)}$ ${trimmed}`);
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
    [print, pushHistory, ctx, vfs]
  );

  /* menu-bar items that print terminal output arrive via the murke-run event
     (registered early, above) — it reads the freshest dispatch through a ref */
  const dispatchRef = useRef<((cmd: string) => Promise<void>) | null>(null);
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  /* ---------- input events ---------- */

  const submit = useCallback(() => {
    const raw = input;
    setInput("");
    setCaret(0);
    setGhost("");
    void dispatch(raw);
  }, [input, dispatch]);

  /* clickable printed output: commands may stamp data-cmd="..." on spans —
     one delegated listener runs them through the same dispatch path */
  const runDataCmd = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = (e.target as HTMLElement).closest("[data-cmd]");
      if (!el) return;
      const cmd = el.getAttribute("data-cmd");
      if (!cmd) return;
      e.preventDefault();
      sound.key();
      void dispatch(cmd);
    },
    [dispatch, sound],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!bootedRef.current) return;

      /* ---------- ask mode: the prompt owns the keyboard ---------- */
      const asking = askRef.current;
      if (asking) {
        if (e.key === "Enter") {
          e.preventDefault();
          sound.enter();
          const v = input;
          // echo the answered prompt — masked answers print asterisks only
          print(`${asking.label}${asking.mask ? "*".repeat(v.length) : v}`, "dim");
          setInput("");
          setCaret(0);
          setGhost("");
          setAskState(null);
          asking.resolve(v);
          return;
        }
        if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
          e.preventDefault();
          print(`${asking.label}^C`, "dim");
          setInput("");
          setCaret(0);
          setGhost("");
          setAskState(null);
          asking.resolve("");
          return;
        }
        return; // swallow arrows/tab/etc while a prompt is live
      }

      if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        clear();
        return;
      }
      if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        print(`guest@murke:${vfs.pretty(cwdRef.current)}$ ${input}^C`);
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
      if (!askRef.current) refreshGhost(v, pos); // no completion ghosts mid-prompt
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
      onClick={() => {
        inputRef.current?.focus();
      }}
    >
      {/* output */}
      <div
        ref={scrollRef}
        onClick={runDataCmd}
        className="murke-scroll murke-glow-soft murke-ember-halo min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 pt-2 text-[12.5px] leading-[1.4]"
        aria-live="polite"
      >
        <div ref={contentRef}>
          {lines.map((l) =>
            l.html !== undefined ? (
              l.block ? (
                <HtmlBlock key={l.id} html={l.html} />
              ) : l.fit === false ? (
                <pre
                  key={l.id}
                  className="murke-scroll whitespace-pre overflow-x-auto font-mono leading-[1.4] text-[var(--term-fg)]"
                  dangerouslySetInnerHTML={{ __html: l.html }}
                />
              ) : (
                <MurkeArt key={l.id} html={l.html} />
              )
            ) : (
              <pre key={l.id} className={`whitespace-pre-wrap break-words font-mono ${kindClass(l.kind)}`}>
                {l.text || " "}
              </pre>
            )
          )}
          {busy && <pre className="font-mono text-[var(--term-dim)]">▓ processing…</pre>}
        </div>
      </div>

      {/* prompt line — dark console floor so input stays readable over the fire */}
      <div className="murke-glow bg-[color-mix(in_srgb,var(--term-bg)_72%,transparent)] px-3 pb-1.5 pt-1 text-[12.5px] leading-[1.4]">
        {askState ? (
          <pre className="whitespace-pre-wrap break-words font-mono">
            <span className="font-bold text-[var(--term-brand)]">{askState.label}</span>
            {askState.mask ? (
              <>
                <span className="text-[var(--term-fg)]">{"*".repeat(input.length)}</span>
                <span className="murke-cursor bg-[var(--term-fg)] text-[var(--term-bg)]">{"\u00a0"}</span>
              </>
            ) : (
              <>
                <span className="text-[var(--term-fg)]">{before}</span>
                <span className="murke-cursor bg-[var(--term-fg)] text-[var(--term-bg)]">{at || "\u00a0"}</span>
                <span className="text-[var(--term-fg)]">{after}</span>
              </>
            )}
          </pre>
        ) : (
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
        )}
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
