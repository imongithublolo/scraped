"use client";

/**
 * murke-ai — the AI sidekick panel inside the proxied browser.
 *
 * A faithful port of the murke extension's agent core to the proxy browser:
 * terminal-styled chat, the page observed as text + numbered elements (the
 * frames are same-origin through scramjet), action tags executed against
 * the live frame ([GOTO] [SCROLL] [CLICK] [TYPE] [IMAGE]), and an agent
 * loop that re-observes after acting — one observation at a time, capped.
 * Brain = /api/ai/chat + /api/ai/image (z-ai sdk, keyless for the user).
 *
 * Ephemeral by design: the conversation dies with the browser overlay.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SoundEngine } from "@/lib/murke/contracts";
import { md } from "@/lib/murke/ai-md";
import {
  observationToText,
  parseActions,
  observePage,
  runAction,
  waitForLoad,
  type ParsedAction,
} from "@/lib/murke/ai-page";

const VERSION = "1.5.0";

interface AiMsgUser {
  id: string;
  kind: "user";
  text: string;
}
interface AiMsgAi {
  id: string;
  kind: "ai";
  html: string;
  chips: string[];
}
interface AiMsgSys {
  id: string;
  kind: "sys";
  text: string;
}
interface AiMsgErr {
  id: string;
  kind: "err";
  text: string;
}
interface AiMsgImage {
  id: string;
  kind: "image";
  b64: string;
  prompt: string;
}
type AiMsg = AiMsgUser | AiMsgAi | AiMsgSys | AiMsgErr | AiMsgImage;

interface Turn {
  role: "user" | "assistant";
  content: string;
}

const BORDER = "border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)]";
const SCROLLBAR =
  "[scrollbar-width:thin] [scrollbar-color:color-mix(in_srgb,var(--term-fg)_30%,transparent)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--term-fg)_25%,transparent)]";

/** `[IMAGE: prompt | 1024x1024]` arg -> { prompt, size }. */
function splitImageArg(arg: string): { prompt: string; size?: string } {
  const bar = arg.lastIndexOf("|");
  if (bar > 0) {
    const size = arg.slice(bar + 1).trim();
    if (/^\d{3,4}x\d{3,4}$/.test(size)) return { prompt: arg.slice(0, bar).trim(), size };
  }
  return { prompt: arg };
}

function chipLabel(a: ParsedAction): string {
  switch (a.kind) {
    case "goto":
      return `goto ${a.arg}`;
    case "scroll":
      return `scroll ${a.arg || "down"}`;
    case "click":
      return `click ${a.arg}`;
    case "type":
      return `type into ${a.arg}`;
    case "image":
      return `paint image`;
  }
}

async function genImage(
  prompt: string,
  size?: string,
): Promise<{ ok: true; b64: string } | { ok: false; error: string }> {
  try {
    const r = await fetch("/api/ai/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, size }),
      signal: AbortSignal.timeout(120_000),
    });
    const j = (await r.json()) as { ok?: boolean; b64?: string; error?: string };
    if (j.ok && j.b64) return { ok: true, b64: j.b64 };
    return { ok: false, error: j.error ?? "image engine failed" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "image engine unreachable" };
  }
}

const QUICK = ["summarize this page", "extract the links", "what is this site?", "paint a red cube"];

export default function MurkeAiPane({
  onClose,
  getFrame,
  navigate,
  address,
  sound,
}: {
  onClose: () => void;
  getFrame: () => HTMLIFrameElement | null;
  navigate: (url: string) => void;
  address: string;
  sound: SoundEngine;
}) {
  const [msgs, setMsgs] = useState<AiMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);

  const idRef = useRef(0);
  const logRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  /** api-side turns (raw model text kept, tags included) */
  const convoRef = useRef<Turn[]>([]);
  const abortRef = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const push = useCallback((m: Omit<AiMsgUser, "id"> | Omit<AiMsgAi, "id"> | Omit<AiMsgSys, "id"> | Omit<AiMsgErr, "id"> | Omit<AiMsgImage, "id">) => {
    setMsgs((prev) => {
      const next = [...prev, { ...m, id: `m${++idRef.current}` } as AiMsg];
      return next.length > 160 ? next.slice(next.length - 160) : next;
    });
  }, []);

  const host = (() => {
    try {
      return address ? new URL(address.startsWith("http") ? address : `https://${address}`).hostname.replace(/^www\./, "") : "";
    } catch {
      return address.slice(0, 30);
    }
  })();

  /* boot lines — the power-on beat, zero api cost */
  useEffect(() => {
    const t1 = setTimeout(() => push({ kind: "sys", text: `murke-ai v${VERSION} online — engine: z-core (keyless)` }), 250);
    const t2 = setTimeout(
      () => push({ kind: "sys", text: "i read this page as text, act on it, and paint images. ask away." }),
      800,
    );
    const t3 = setTimeout(() => setBooting(false), 900);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [push]);

  /* sticky autoscroll */
  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [msgs, busy]);

  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  }, []);

  /* chat links navigate the proxied tab instead of leaving the app */
  const onLogClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const a = (e.target as HTMLElement).closest("a[data-goto]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("data-goto");
      if (!href) return;
      navigate(href);
      push({ kind: "sys", text: `link -> ${href}` });
    },
    [navigate, push],
  );

  /* ---------- the agent loop ---------- */

  const agentLoop = useCallback(async () => {
    abortRef.current = false;
    setBusy(true);
    const MAX_HOPS = 4;
    let stopped = false;
    let capped = false;
    try {
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        if (abortRef.current) {
          stopped = true;
          break;
        }

        const frame = getFrame();
        const obs = observePage(frame);
        const page = obs
          ? {
              title: obs.title,
              url: obs.url,
              text: obs.text,
              elements: obs.elements.map((e) => `${e.n}. <${e.tag}> ${e.label}${e.href ? ` -> ${e.href}` : ""}`).join("\n"),
            }
          : { title: "", url: "", text: "", elements: "" };
        if (hop > 0) push({ kind: "sys", text: obs ? `· observing ${obs.title || obs.url}` : "· observing (page unreadable)" });

        const r = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: convoRef.current, page }),
          signal: AbortSignal.timeout(90_000),
        });
        const j = (await r.json()) as { ok?: boolean; text?: string; error?: string };
        if (!j.ok || typeof j.text !== "string") {
          push({ kind: "err", text: j.error ?? "the engine is not answering" });
          break;
        }

        const { text, actions } = parseActions(j.text);
        convoRef.current = [...convoRef.current.slice(-13), { role: "assistant", content: j.text }];
        push({ kind: "ai", html: md(text || "(acts silently)"), chips: actions.map(chipLabel) });

        if (actions.length === 0) break;

        let navigated = false;
        let painted = false;
        for (const a of actions) {
          if (abortRef.current) {
            stopped = true;
            break;
          }
          if (a.kind === "image") {
            painted = true;
            const { prompt, size } = splitImageArg(a.arg);
            push({ kind: "sys", text: `· painting "${prompt.slice(0, 60)}"…` });
            const img = await genImage(prompt, size);
            if (img.ok) push({ kind: "image", b64: img.b64, prompt });
            else push({ kind: "err", text: `image failed: ${img.error}` });
            continue;
          }
          const res = await runAction(getFrame(), a);
          if (a.kind === "goto") {
            push({ kind: "sys", text: `· goto ${res.detail}` });
            navigate(res.detail);
            navigated = true;
          } else if (res.ok) {
            push({ kind: "sys", text: `· ${a.kind} ✓ ${res.detail}` });
            if (res.navigated) navigated = true;
          } else {
            push({ kind: "sys", text: `· ${a.kind} ✗ ${res.detail}` });
          }
        }

        if (painted && !navigated) break; // a painting ends the turn
        if (navigated) {
          push({ kind: "sys", text: "· waiting for the page…" });
          const ok = await waitForLoad(getFrame());
          if (!ok) push({ kind: "sys", text: "· page is slow — reading what loaded" });
        }
        // continue: feed the fresh observation back as an implicit turn
        if (hop === MAX_HOPS - 1) {
          capped = true;
          break;
        }
        convoRef.current = [...convoRef.current, { role: "user", content: "(continue the task — fresh observation attached)" }];
      }
      if (stopped) push({ kind: "sys", text: "· stopped" });
      else if (capped) push({ kind: "sys", text: "· step cap — say “continue” to keep going" });
    } catch (e) {
      push({ kind: "err", text: e instanceof Error ? e.message : "the loop died" });
    } finally {
      setBusy(false);
    }
  }, [getFrame, navigate, push]);

  const send = useCallback(
    (raw?: string) => {
      const text = (raw ?? draft).trim();
      if (!text || busyRef.current) return;
      sound.key();
      setDraft("");

      /* slash commands */
      if (text === "/help") {
        push({
          kind: "sys",
          text: "commands — /clear wipe · /page re-read the page · /image <prompt> [WxH] paint · /goto <url> navigate · /stop is the ■ while i work",
        });
        return;
      }
      if (text === "/clear") {
        setMsgs([]);
        convoRef.current = [];
        push({ kind: "sys", text: "· wiped" });
        return;
      }
      if (text.startsWith("/page")) {
        const obs = observePage(getFrame());
        if (!obs) {
          push({ kind: "sys", text: "· nothing readable loaded" });
        } else {
          push({
            kind: "sys",
            text: `· ${obs.title || "(untitled)"} — ${obs.url}\n· ${obs.text.length} chars, ${obs.elements.length} elements`,
          });
        }
        return;
      }
      if (text.startsWith("/image ")) {
        const { prompt, size } = splitImageArg(text.slice(7));
        if (!prompt) {
          push({ kind: "err", text: "/image needs a prompt" });
          return;
        }
        setBusy(true);
        push({ kind: "sys", text: `· painting "${prompt.slice(0, 60)}"…` });
        genImage(prompt, size).then((img) => {
          if (img.ok) push({ kind: "image", b64: img.b64, prompt });
          else push({ kind: "err", text: `image failed: ${img.error}` });
          setBusy(false);
        });
        return;
      }
      if (text.startsWith("/goto ")) {
        const u = text.slice(6).trim();
        navigate(u);
        push({ kind: "sys", text: `· goto ${u}` });
        return;
      }
      if (text === "/stop") {
        abortRef.current = true;
        return;
      }

      push({ kind: "user", text });
      convoRef.current = [...convoRef.current.slice(-13), { role: "user", content: text }];
      void agentLoop();
    },
    [draft, sound, push, getFrame, navigate, agentLoop],
  );

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else {
      if (e.key === " ") sound.space();
      else if (e.key === "Backspace") sound.backspace();
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) sound.key();
    }
  };

  const saveImage = (b64: string, prompt: string) => {
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `murke-ai-${prompt.replace(/[^\w]+/g, "-").slice(0, 30) || "image"}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      /* private mode etc */
    }
  };

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-full flex-col border-l bg-[color-mix(in_srgb,var(--term-bg)_92%,transparent)] font-mono text-[12px] text-[var(--term-fg)] backdrop-blur-sm sm:w-[380px]">
      {/* header */}
      <header className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 ${BORDER}`}>
        <span className="font-bold tracking-[0.25em] text-[var(--term-brand)]">murke-ai</span>
        <span className="min-w-0 truncate text-[10px] text-[var(--term-dim)]">
          {host ? `watching ${host}` : "no page"}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => send("/clear")}
            className="text-[10px] text-[var(--term-dim)] transition-colors hover:text-[var(--term-fg)]"
          >
            [clear]
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="close murke-ai"
            className="px-1 text-[var(--term-dim)] transition-colors hover:text-[var(--term-brand)]"
          >
            ✕
          </button>
        </span>
      </header>

      {/* log */}
      <div ref={logRef} onScroll={onLogScroll} onClick={onLogClick} className={`min-h-0 flex-1 overflow-y-auto px-3 py-2 leading-relaxed ${SCROLLBAR}`}>
        {msgs.map((m) => {
          if (m.kind === "user") {
            return (
              <div key={m.id} className="whitespace-pre-wrap break-words py-px">
                <span className="text-[var(--term-dim)]">&gt; </span>
                <span>{m.text}</span>
              </div>
            );
          }
          if (m.kind === "sys") {
            return (
              <div key={m.id} className="whitespace-pre-wrap py-px pl-3 text-[11px] italic text-[var(--term-dim)]">
                {m.text}
              </div>
            );
          }
          if (m.kind === "err") {
            return (
              <div key={m.id} className="py-px pl-3 text-[11px] text-[var(--term-err)]">
                ✗ {m.text}
              </div>
            );
          }
          if (m.kind === "image") {
            return (
              <div key={m.id} className="my-1 pl-1">
                <img
                  src={`data:image/png;base64,${m.b64}`}
                  alt={m.prompt}
                  className="max-h-64 w-full cursor-pointer border object-contain"
                  style={{ borderColor: "color-mix(in srgb, var(--term-fg) 25%, transparent)" }}
                  onClick={() => saveImage(m.b64, m.prompt)}
                />
                <div className="mt-0.5 text-[10px] text-[var(--term-dim)]">
                  {m.prompt.slice(0, 70)} · click to save
                </div>
              </div>
            );
          }
          /* ai */
          return (
            <div key={m.id} className="py-0.5">
              <div
                className="murke-ai-md break-words [&_a]:text-[var(--term-hi)] [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_blockquote]:text-[var(--term-dim)] [&_code]:bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)] [&_code]:px-1 [&_h4]:font-bold [&_h4]:text-[var(--term-hi)] [&_li]:ml-4 [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:px-2 [&_pre]:py-1 [&_strong]:text-[var(--term-hi)] [&_ul]:list-disc [&_ol]:list-decimal"
                dangerouslySetInnerHTML={{ __html: m.html }}
              />
              {m.chips.length > 0 && (
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {m.chips.map((c, i) => (
                    <span
                      key={i}
                      className="border px-1.5 py-px text-[10px] text-[var(--term-dim)]"
                      style={{ borderColor: "color-mix(in srgb, var(--term-fg) 25%, transparent)" }}
                    >
                      → {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {booting && <div className="py-px pl-3 text-[11px] italic text-[var(--term-dim)]">· powering on…</div>}
        {busy && (
          <div className="py-px pl-3 text-[11px] text-[var(--term-dim)]" aria-live="polite">
            thinking<span className="ml-0.5 inline-block"><span className="inline-block animate-bounce [animation-delay:0ms]">.</span><span className="inline-block animate-bounce [animation-delay:150ms]">.</span><span className="inline-block animate-bounce [animation-delay:300ms]">.</span></span>
          </div>
        )}
      </div>

      {/* quick chips */}
      {!booting && msgs.length < 6 && (
        <div className="flex shrink-0 flex-wrap gap-1 px-3 pb-1 pt-1.5">
          {QUICK.map((q) => (
            <button
              key={q}
              type="button"
              disabled={busy}
              onClick={() => send(q)}
              className="border px-1.5 py-0.5 text-[10px] text-[var(--term-dim)] transition-colors hover:text-[var(--term-fg)] disabled:opacity-40"
              style={{ borderColor: "color-mix(in srgb, var(--term-fg) 25%, transparent)" }}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* composer */}
      <div className={`flex shrink-0 items-center gap-2 border-t px-3 py-2 ${BORDER}`}>
        <span className="shrink-0 text-[var(--term-dim)]">ai&gt;</span>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          aria-label="murke-ai message"
          placeholder={busy ? "working — ■ /stop" : "ask about this page…"}
          className="min-w-0 flex-1 bg-transparent outline-none text-[var(--term-fg)] placeholder:text-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] disabled:opacity-50"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => {
              abortRef.current = true;
            }}
            className="shrink-0 px-1 text-[11px] text-[var(--term-err)]"
            title="stop"
          >
            ■
          </button>
        ) : (
          <button type="button" onClick={() => send()} className="shrink-0 px-1 text-[11px] text-[var(--term-dim)] hover:text-[var(--term-fg)]" aria-label="send">
            ⏎
          </button>
        )}
      </div>

      <footer className={`shrink-0 border-t px-3 py-1 text-[9.5px] text-[var(--term-dim)] ${BORDER} border-[color-mix(in_srgb,var(--term-fg)_15%,transparent)]`}>
        enter send · /help · alt+i toggles me · i only touch the page you see
      </footer>
    </div>
  );
}
