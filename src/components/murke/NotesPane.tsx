"use client";

/**
 * notes — rich notes manager, word-processor style.
 * Formatted notes live in ~/notes as .html (bold/italic/lists/align/headings
 * + a little color); plain .txt files still open as plain text. Everything
 * goes through the virtual file system, so `cat`/`rm` in dsh see them too.
 * Ctrl+S saves. Esc is handled by the shell overlay handler.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVfs } from "@/lib/murke/vfs";

const BORDER = "border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)]";
const BORDER_FAINT = "border-[color-mix(in_srgb,var(--term-fg)_14%,transparent)]";
const NOTES_DIR = "~/notes";

/** Colors offered by the text-color button (fixed, terminal-safe). */
const INK_COLORS = ["#ff5555", "#ffb454", "#ffff55", "#22c55e", "#5fc9dd", "#e8e8e8", "#0a0a0a"];

/** Very small sanitizer: the note is the user's own document, but scripts
 *  have no business in it. Runs on load and on save. */
function scrub(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<script[^>]*\/?>/gi, "")
    .replace(/ on[a-z]+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

export default function NotesPane({ onClose }: { onClose: () => void }) {
  const vfs = useMemo(() => getVfs(), []);

  const listNoteFiles = useCallback((): string[] => {
    return vfs
      .list(NOTES_DIR)
      .filter((n) => n.type === "file")
      .map((n) => n.name)
      .sort();
  }, [vfs]);

  const readNote = useCallback(
    (name: string): string => vfs.readFile(`${NOTES_DIR}/${name}`) ?? "",
    [vfs]
  );

  /* the VFS is a synchronous module singleton — seed state straight from it
     during first render; no effect churn needed */
  vfs.mkdir(NOTES_DIR, undefined, true); // idempotent external-system sync
  const initialFiles = listNoteFiles();
  const firstFile = initialFiles[0] ?? null;

  const [files, setFiles] = useState<string[]>(initialFiles);
  const [active, setActive] = useState<string | null>(firstFile);
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const areaRef = useRef<HTMLDivElement>(null);
  /** true when the active file is rich (.html) */
  const rich = (active ?? "").endsWith(".html");

  /* load active note into the contentEditable (ref — avoids controlled
     contentEditable churn; native undo stays intact) */
  const loadIntoEditor = useCallback(
    (name: string) => {
      const el = areaRef.current;
      if (!el) return;
      const raw = readNote(name);
      if (name.endsWith(".html")) {
        el.innerHTML = scrub(raw) || "";
      } else {
        el.textContent = raw;
      }
    },
    [readNote]
  );

  useEffect(() => {
    if (firstFile) loadIntoEditor(firstFile);
    areaRef.current?.focus();
    // run once on mount — seeding from the synchronous VFS
  }, []);

  const refresh = useCallback((): string[] => {
    const items = listNoteFiles();
    setFiles(items);
    return items;
  }, [listNoteFiles]);

  const openFile = useCallback(
    (name: string) => {
      setActive(name);
      setDirty(false);
      setError("");
      // contentEditable children render after state — load on the next tick
      window.setTimeout(() => {
        loadIntoEditor(name);
        areaRef.current?.focus();
      }, 0);
    },
    [loadIntoEditor]
  );

  const currentContent = useCallback((): string => {
    const el = areaRef.current;
    if (!el || !active) return "";
    return active.endsWith(".html") ? scrub(el.innerHTML) : el.innerText;
  }, [active]);

  const save = useCallback(() => {
    if (!active) return;
    const err = vfs.writeFile(`${NOTES_DIR}/${active}`, currentContent());
    if (err) {
      setError(err);
      return;
    }
    setDirty(false);
    refresh();
  }, [active, currentContent, vfs, refresh]);

  const createFile = useCallback(() => {
    const name = newName.trim().replace(/\.(txt|html)$/, "");
    if (!name) return;
    const safe = `${name.replace(/[^\w.-]/g, "_").slice(0, 40)}.html`;
    if (files.includes(safe)) {
      setError(`notes: '${safe}' already exists`);
      return;
    }
    const err = vfs.writeFile(`${NOTES_DIR}/${safe}`, "");
    if (err) {
      setError(err);
      return;
    }
    refresh();
    setActive(safe);
    setDirty(false);
    setCreating(false);
    setNewName("");
    setError("");
    window.setTimeout(() => {
      if (areaRef.current) areaRef.current.innerHTML = "";
      areaRef.current?.focus();
    }, 0);
  }, [newName, files, vfs, refresh]);

  const deleteFile = useCallback(() => {
    if (!active) return;
    const err = vfs.remove(`${NOTES_DIR}/${active}`);
    if (err) {
      setError(err);
      return;
    }
    const items = refresh();
    const first = items[0] ?? null;
    setActive(first);
    setDirty(false);
    window.setTimeout(() => {
      if (first) loadIntoEditor(first);
      else if (areaRef.current) {
        areaRef.current.innerHTML = "";
        areaRef.current.textContent = "";
      }
    }, 0);
  }, [active, vfs, refresh, loadIntoEditor]);

  /* ---------- word-processor commands (execCommand — pragmatic, universal) */

  const exec = useCallback(
    (cmd: string, value?: string) => {
      if (!rich) return;
      areaRef.current?.focus();
      document.execCommand(cmd, false, value);
      setDirty(true);
      setError("");
    },
    [rich]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  };

  const tb =
    "cursor-pointer px-1.5 py-0.5 text-[11px] transition-colors select-none " +
    "text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] disabled:opacity-30 disabled:hover:bg-transparent";
  const tbSep = "mx-0.5 h-4 w-px shrink-0 bg-[color-mix(in_srgb,var(--term-fg)_25%,transparent)]";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--term-bg)] font-mono text-xs text-[var(--term-fg)] md:text-[13px]" onKeyDown={onKeyDown}>
      {/* header */}
      <div className={`flex shrink-0 items-center justify-between gap-3 border-b px-3 py-1.5 ${BORDER}`}>
        <span className="text-[var(--term-brand)]">notes — ~/notes</span>
        <div className="flex items-center gap-1.5">
          <button type="button" className={tb + " border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)]"} onClick={() => setCreating(true)}>
            new
          </button>
          <button type="button" className={tb + " border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)]"} onClick={save} disabled={!active}>
            save{dirty ? "*" : ""}
          </button>
          <button type="button" className={tb + " border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)]"} onClick={deleteFile} disabled={!active}>
            del
          </button>
          <button type="button" className={tb + " border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)]"} onClick={onClose} aria-label="close notes">
            ✕
          </button>
        </div>
      </div>

      {/* word-style format toolbar */}
      <div className={`flex shrink-0 flex-wrap items-center gap-0.5 border-b px-2 py-1 ${BORDER_FAINT}`} role="toolbar" aria-label="text formatting">
        <button type="button" className={tb} style={{ fontWeight: 700 }} onClick={() => exec("bold")} disabled={!rich} title="bold (ctrl+b)">
          B
        </button>
        <button type="button" className={tb} style={{ fontStyle: "italic" }} onClick={() => exec("italic")} disabled={!rich} title="italic (ctrl+i)">
          I
        </button>
        <button type="button" className={`${tb} underline`} onClick={() => exec("underline")} disabled={!rich} title="underline (ctrl+u)">
          U
        </button>
        <button type="button" className={`${tb} line-through`} onClick={() => exec("strikeThrough")} disabled={!rich} title="strikethrough">
          S
        </button>
        <span className={tbSep} />
        <button type="button" className={tb} onClick={() => exec("insertUnorderedList")} disabled={!rich} title="bullet list">
          • list
        </button>
        <button type="button" className={tb} onClick={() => exec("insertOrderedList")} disabled={!rich} title="numbered list">
          1. list
        </button>
        <span className={tbSep} />
        <button type="button" className={tb} onClick={() => exec("justifyLeft")} disabled={!rich} title="align left">
          ⇤
        </button>
        <button type="button" className={tb} onClick={() => exec("justifyCenter")} disabled={!rich} title="align center">
          ↔
        </button>
        <button type="button" className={tb} onClick={() => exec("justifyRight")} disabled={!rich} title="align right">
          ⇥
        </button>
        <span className={tbSep} />
        <button type="button" className={`${tb} font-bold`} onClick={() => exec("formatBlock", "<h1>")} disabled={!rich} title="heading 1">
          H1
        </button>
        <button type="button" className={`${tb} font-bold`} onClick={() => exec("formatBlock", "<h2>")} disabled={!rich} title="heading 2">
          H2
        </button>
        <button type="button" className={tb} onClick={() => exec("formatBlock", "<p>")} disabled={!rich} title="plain paragraph">
          ¶
        </button>
        <span className={tbSep} />
        {INK_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={tb}
            style={{ backgroundColor: c, width: 16, height: 16, padding: 0 }}
            onClick={() => exec("foreColor", c)}
            disabled={!rich}
            title={`ink ${c}`}
            aria-label={`set ink color ${c}`}
          />
        ))}
        <span className={tbSep} />
        <button type="button" className={tb} onClick={() => exec("removeFormat")} disabled={!rich} title="clear formatting">
          clear
        </button>
        {!rich && active && (
          <span className="ml-2 text-[10px] text-[var(--term-dim)]">
            plain .txt — formatting saves to new .html notes
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* file list */}
        <nav aria-label="note files" className={`w-40 shrink-0 overflow-y-auto border-r p-2 md:w-52 ${BORDER} murke-scroll`}>
          <div className="mb-1 text-[10px] tracking-widest text-[var(--term-dim)]">FILES</div>
          {files.length === 0 && <div className="text-[11px] text-[var(--term-dim)]">(empty — hit new)</div>}
          {files.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => openFile(f)}
              className={`block w-full truncate px-1.5 py-1 text-left text-[12px] transition-colors ${
                f === active
                  ? "bg-[color-mix(in_srgb,var(--term-fg)_14%,transparent)] text-[var(--term-fg)]"
                  : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"
              }`}
            >
              {f}
            </button>
          ))}
        </nav>

        {/* editor */}
        <div className="flex min-w-0 flex-1 flex-col">
          {creating ? (
            <div className={`flex items-center gap-2 border-b px-3 py-1.5 ${BORDER}`}>
              <span className="text-[var(--term-dim)]">new note:</span>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    createFile();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setCreating(false);
                    setNewName("");
                  }
                }}
                placeholder="untitled"
                spellCheck={false}
                aria-label="note name"
                className="min-w-0 flex-1 bg-transparent text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)]"
              />
              <span className="text-[10px] text-[var(--term-dim)]">.html · enter ok · esc cancel</span>
            </div>
          ) : (
            <div className={`flex items-center justify-between border-b px-3 py-1.5 text-[11px] text-[var(--term-dim)] ${BORDER_FAINT}`}>
              <span>{active ?? "no file selected"}</span>
              <span>{dirty ? "unsaved changes — ctrl+s" : "ctrl+s saves"}</span>
            </div>
          )}
          {error && (
            <div className="px-3 py-1 text-[11px] text-[var(--term-err)]">{error}</div>
          )}
          <div
            ref={areaRef}
            contentEditable={!!active && !creating}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="note content"
            data-placeholder={active ? "" : "select or create a note…"}
            onInput={() => {
              setDirty(true);
              setError("");
            }}
            spellCheck={false}
            className="murke-scroll notes-doc min-h-0 flex-1 overflow-y-auto p-4 leading-relaxed outline-none"
          />
        </div>
      </div>
    </div>
  );
}
