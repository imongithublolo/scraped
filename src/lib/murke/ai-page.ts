/**
 * murke-ai — page observation + action execution for the in-app browser.
 *
 * The proxied frames are same-origin (scramjet rewrites every url onto our
 * own host), so the parent can read contentDocument and act on the page —
 * the extension's "ocr mode" ported to the proxy browser: text + a numbered
 * element list instead of screenshots.
 *
 * Everything is best-effort and try/catch-wrapped: a frame can always be
 * mid-navigation, about:blank, or refuse access (SecurityError) — the
 * caller just gets null and murke-ai falls back to plain chat.
 */

const TEXT_CAP = 6000;
const ELEMENT_CAP = 40;
const LABEL_CAP = 72;

export interface PageElement {
  n: number;
  tag: string;
  label: string;
  href?: string;
}

export interface PageObservation {
  title: string;
  url: string;
  text: string;
  elements: PageElement[];
}

/** Touchable elements, in document order, visible only. */
const TOUCHABLE =
  "a[href], button, input, select, textarea, [role='button'], [onclick], summary";

function visible(win: Window, el: HTMLElement): boolean {
  try {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = win.getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") return false;
    return true;
  } catch {
    return false;
  }
}

function labelOf(el: HTMLElement): string {
  const anyEl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (typeof anyEl.value === "string" && anyEl.value.trim()) return anyEl.value.trim();
  const own = el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.getAttribute("title");
  if (own && own.trim()) return own.trim();
  const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  return text.slice(0, LABEL_CAP);
}

/**
 * Read the frame's document: title, url, trimmed visible text and the
 * numbered interactive elements. Returns null when the doc is unusable.
 */
export function observePage(frame: HTMLIFrameElement | null): PageObservation | null {
  try {
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (!doc || !win || !doc.body) return null;
    const url = doc.URL || "";
    if (!url || url === "about:blank") return null;

    const elements: PageElement[] = [];
    const nodes = doc.querySelectorAll<HTMLElement>(TOUCHABLE);
    const seen = new Set<HTMLElement>();
    for (const el of nodes) {
      if (elements.length >= ELEMENT_CAP) break;
      if (seen.has(el)) continue;
      seen.add(el);
      if (!visible(win, el)) continue;
      const tag = el.tagName.toLowerCase();
      const label = labelOf(el);
      if (!label && tag !== "input" && tag !== "select" && tag !== "textarea") continue;
      const href = tag === "a" ? (el as HTMLAnchorElement).href : undefined;
      elements.push({ n: elements.length + 1, tag, label, href });
    }

    const raw = (doc.body.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    const text = raw.slice(0, TEXT_CAP);

    return { title: (doc.title || "").slice(0, 120), url, text, elements };
  } catch {
    return null; // cross-origin, mid-nav, dead frame — murke-ai just can't see
  }
}

/** Compact wire form the API route embeds into the prompt. */
export function observationToText(o: PageObservation): string {
  const lines: string[] = [];
  lines.push(`title: ${o.title || "(untitled)"}`);
  lines.push(`url: ${o.url}`);
  if (o.text) lines.push("", "page text:", o.text);
  else lines.push("", "(no readable text)");
  if (o.elements.length) {
    lines.push("", "interactive elements:");
    for (const el of o.elements) {
      lines.push(`${el.n}. <${el.tag}> ${el.label}${el.href ? ` -> ${el.href}` : ""}`);
    }
  }
  return lines.join("\n");
}

/* ---------- actions ---------- */

export type ActionKind = "goto" | "scroll" | "click" | "type";

export interface ParsedAction {
  kind: ActionKind | "image";
  arg: string;
  extra?: string;
  /** raw tag as the model wrote it */
  raw: string;
}

const TAG_RE = /\[(GOTO|SCROLL|CLICK|TYPE|IMAGE):\s*([^\]]*)\]/gi;

/** Pull action tags out of a model reply; tags are consumed (removed) from the text. */
export function parseActions(reply: string): { text: string; actions: ParsedAction[] } {
  const actions: ParsedAction[] = [];
  const text = reply.replace(TAG_RE, (_m, kind: string, arg: string) => {
    const k = kind.toLowerCase() as ParsedAction["kind"];
    let a = arg.trim();
    let extra: string | undefined;
    if (k === "type") {
      // [TYPE: 7 | "text"] — split the target from the payload
      const bar = a.indexOf("|");
      if (bar >= 0) {
        extra = a
          .slice(bar + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
        a = a.slice(0, bar).trim();
      }
    }
    actions.push({ kind: k, arg: a, extra, raw: `[${kind}: ${arg.trim()}]` });
    return "";
  });
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), actions };
}

export interface ActionResult {
  ok: boolean;
  detail: string;
  /** true when the frame navigated (caller should wait + re-observe) */
  navigated: boolean;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll the frame until the document settles after a navigation. */
export async function waitForLoad(frame: HTMLIFrameElement | null, capMs = 10000): Promise<boolean> {
  if (!frame) return false;
  const start = Date.now();
  await wait(900); // let the navigation actually start
  while (Date.now() - start < capMs) {
    try {
      const doc = frame.contentDocument;
      if (doc && doc.readyState === "complete" && doc.URL !== "about:blank" && doc.body?.innerText) {
        await wait(500); // settle render
        return true;
      }
    } catch {
      /* mid-flight */
    }
    await wait(300);
  }
  return false;
}

/** Execute one parsed action against the frame's live document. */
export async function runAction(frame: HTMLIFrameElement | null, a: ParsedAction): Promise<ActionResult> {
  if (a.kind === "image") return { ok: true, detail: a.arg, navigated: false }; // handled by the caller (API call)
  if (a.kind === "goto") {
    const target = a.arg.startsWith("http") ? a.arg : `https://${a.arg}`;
    return { ok: true, detail: target, navigated: true }; // caller navigates via BrowserView.go
  }
  try {
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (!doc || !win) return { ok: false, detail: "no page", navigated: false };

    if (a.kind === "scroll") {
      const dir = (a.arg || "down").toLowerCase();
      const step = 600;
      if (dir === "top") win.scrollTo({ top: 0 });
      else if (dir === "bottom") win.scrollTo({ top: win.document.documentElement.scrollHeight });
      else if (dir === "up") win.scrollBy({ top: -step });
      else win.scrollBy({ top: step });
      return { ok: true, detail: dir, navigated: false };
    }

    // click / type need the element list from the LAST observation to mean
    // anything — the caller passes the number in arg; re-resolve live.
    const n = parseInt(a.arg, 10);
    const obs = observePage(frame);
    const el = obs?.elements.find((e) => e.n === n);
    if (!el) return { ok: false, detail: `element ${a.arg} not on page`, navigated: false };

    const nodes = doc.querySelectorAll<HTMLElement>(TOUCHABLE);
    const visibleNodes: HTMLElement[] = [];
    for (const node of nodes) {
      if (visibleNodes.length >= ELEMENT_CAP) break;
      if (visible(win, node)) visibleNodes.push(node);
    }
    const target = visibleNodes[n - 1];
    if (!target) return { ok: false, detail: `element ${n} vanished`, navigated: false };

    target.scrollIntoView({ block: "center" });
    await wait(120);

    if (a.kind === "click") {
      target.click();
      return { ok: true, detail: `${el.tag} "${el.label.slice(0, 40)}"`, navigated: true };
    }

    // type: replace the value like the extension does (focus, set, emit events)
    if (a.kind === "type") {
      const text = a.extra ?? "";
      const field = target as HTMLInputElement | HTMLTextAreaElement;
      if (typeof field.value !== "string") {
        return { ok: false, detail: `${el.tag} is not a text field`, navigated: false };
      }
      field.focus();
      const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(field, text);
      const FEvent = (win as unknown as { Event: typeof Event }).Event ?? Event;
      field.dispatchEvent(new FEvent("input", { bubbles: true }));
      field.dispatchEvent(new FEvent("change", { bubbles: true }));
      return { ok: true, detail: `${el.tag} "${el.label.slice(0, 30)}" = "${text.slice(0, 40)}"`, navigated: false };
    }

    return { ok: false, detail: "unknown action", navigated: false };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "action failed", navigated: false };
  }
}
