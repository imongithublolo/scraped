"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUp, File as FileIco, FolderPlus, Folder as FolderIco, Home, Trash2 } from "lucide-react";
import { getVfs } from "@/lib/murke/vfs";
import { useWm } from "@/lib/murke/wm";
import type { FsNode } from "@/lib/murke/contracts";

/**
 * File Manager app: navigate the virtual file system, open files in the
 * viewer, create folders/files, delete entries. Shared VFS with the shell.
 */
export default function FilesApp() {
  const vfs = useMemo(() => getVfs(), []);
  const [cwd, setCwd] = useState<string>(vfs.HOME);
  const [, bump] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = useCallback(() => bump((n) => n + 1), []);

  const items = vfs.list(cwd);
  const pretty = vfs.pretty(cwd);

  const openNode = useCallback(
    (n: FsNode) => {
      const abs = vfs.resolve(n.name, cwd);
      if (n.type === "dir") {
        setCwd(abs);
        setSelected(null);
      } else {
        useWm.getState().open("viewer", abs);
      }
    },
    [vfs, cwd]
  );

  const up = useCallback(() => {
    if (cwd === "/") return;
    setCwd(vfs.resolve("..", cwd));
    setSelected(null);
  }, [cwd, vfs]);

  const mkdir = useCallback(() => {
    const name = window.prompt("new folder name:");
    if (!name) return;
    const err = vfs.mkdir(name, cwd);
    refresh();
    if (err) window.alert(err);
  }, [vfs, cwd, refresh]);

  const touch = useCallback(() => {
    const name = window.prompt("new file name:");
    if (!name) return;
    const err = vfs.writeFile(name, "", cwd);
    refresh();
    if (err) window.alert(err);
  }, [vfs, cwd, refresh]);

  const del = useCallback(
    (name: string) => {
      const err = vfs.remove(name, cwd, true);
      refresh();
      setSelected(null);
      if (err) window.alert(err);
    },
    [vfs, cwd, refresh]
  );

  /* keyboard: Backspace goes up */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Backspace") {
        e.preventDefault();
        up();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [up]);

  const btn =
    "flex h-7 items-center gap-1.5 border border-[color-mix(in_srgb,var(--term-fg)_28%,transparent)] px-2 font-mono text-[10.5px] text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)]";

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-1.5">
        <button className={btn} onClick={up} title="up (backspace)" aria-label="parent directory">
          <ArrowUp size={12} aria-hidden="true" />
        </button>
        <button className={btn} onClick={() => setCwd(vfs.HOME)} title="home" aria-label="home">
          <Home size={12} aria-hidden="true" />
        </button>
        <span className="min-w-0 flex-1 truncate border border-[color-mix(in_srgb,var(--term-fg)_18%,transparent)] px-2 py-0.5 font-mono text-[11px] text-[var(--term-dim)]">
          {pretty}
        </span>
        <button className={btn} onClick={mkdir} title="new folder">
          <FolderPlus size={12} aria-hidden="true" />
          <span className="hidden sm:inline">mkdir</span>
        </button>
        <button className={btn} onClick={touch} title="new file">
          <FileIco size={12} aria-hidden="true" />
          <span className="hidden sm:inline">file</span>
        </button>
        <button
          className={btn}
          onClick={() => selected && del(selected)}
          disabled={!selected}
          title="delete selected"
          style={{ opacity: selected ? 1 : 0.4 }}
        >
          <Trash2 size={12} aria-hidden="true" />
        </button>
      </div>

      {/* listing */}
      <div className="murke-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
        {items.length === 0 ? (
          <div className="p-4 font-mono text-[11px] text-[var(--term-dim)]">(empty)</div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1">
            {items.map((n) => {
              const isSel = selected === n.name;
              return (
                <button
                  key={n.name}
                  className={`flex items-center gap-2 rounded-[2px] px-2 py-2 text-left font-mono text-[11.5px] ${
                    isSel
                      ? "bg-[color-mix(in_srgb,var(--term-brand)_28%,transparent)] text-[var(--term-fg)]"
                      : "text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)]"
                  }`}
                  onClick={() => setSelected(n.name)}
                  onDoubleClick={() => openNode(n)}
                  title={n.type === "dir" ? "double-click to open" : "double-click to view"}
                >
                  {n.type === "dir" ? (
                    <FolderIco size={14} className="shrink-0 text-[var(--term-brand)]" aria-hidden="true" />
                  ) : (
                    <FileIco size={14} className="shrink-0 text-[var(--term-dim)]" aria-hidden="true" />
                  )}
                  <span className="truncate">{n.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-3 py-1 font-mono text-[9.5px] text-[var(--term-dim)]">
        {items.length} entries · double-click opens · backspace goes up · shared with dsh
      </div>
    </div>
  );
}
