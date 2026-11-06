"use client";

import { useMemo } from "react";
import { getVfs } from "@/lib/murke/vfs";

/**
 * File Viewer app: read-only text view of a VFS file. Shared VFS with the
 * shell — content re-reads whenever the window is (re)opened (nonce bump).
 */
export default function ViewerApp({ path, nonce, onClose }: { path: string; nonce?: number; onClose?: () => void }) {
  const vfs = useMemo(() => getVfs(), []);

  const { content, err } = useMemo(() => {
    const node = vfs.getNode(path);
    if (!node) return { content: null, err: `no such file: ${path}` };
    if (node.type === "dir") return { content: null, err: `${path} is a directory — open it in the file manager` };
    return { content: node.content, err: null };
  }, [path, nonce, vfs]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--term-brand)]">{vfs.pretty(path)}</span>
        {onClose && (
          <button
            className="shrink-0 border border-[color-mix(in_srgb,var(--term-fg)_28%,transparent)] px-2 py-0.5 font-mono text-[10px] text-[var(--term-fg)] hover:bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)]"
            onClick={onClose}
            title="close viewer"
          >
            close
          </button>
        )}
      </div>
      {err ? (
        <div className="flex flex-1 items-center justify-center p-4 font-mono text-[12px] text-[var(--term-err)]">{err}</div>
      ) : (
        <div className="murke-scroll min-h-0 flex-1 overflow-auto px-3 py-2">
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5] text-[var(--term-fg)]">
            {content ?? ""}
          </pre>
        </div>
      )}
      <div className="shrink-0 border-t border-[color-mix(in_srgb,var(--term-fg)_25%,transparent)] px-3 py-1 font-mono text-[9.5px] text-[var(--term-dim)]">
        read-only · edit via dsh (echo &gt; file) · {content != null ? `${content.split("\n").length} lines` : "—"}
      </div>
    </div>
  );
}
