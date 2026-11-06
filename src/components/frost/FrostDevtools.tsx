"use client";

/**
 * FrostDevtools — the <> sheet. A quiet bottom drawer that reads the live
 * proxied document (same-origin through the relay): current url, node
 * count, and the full HTML in a scrollable pre. Refresh re-grabs; close
 * collapses. Nothing here announces murke.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProxyFrameHandle } from "@/lib/murke/contracts";
import { unwrapScramjetUrl } from "@/lib/murke/proxy";

export default function FrostDevtools({
  frame,
  onClose,
}: {
  frame: ProxyFrameHandle | null;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [html, setHtml] = useState("");
  const [nodes, setNodes] = useState(0);
  const preRef = useRef<HTMLPreElement>(null);

  const grab = useCallback(() => {
    try {
      const el = frame?.el as HTMLIFrameElement | undefined;
      const doc = el?.contentDocument;
      if (!doc) {
        setUrl(el ? "frame busy — try refresh" : "no frame");
        setHtml("");
        setNodes(0);
        return;
      }
      setUrl(unwrapScramjetUrl(doc.location?.href ?? ""));
      setHtml(doc.documentElement?.outerHTML ?? "");
      setNodes(doc.querySelectorAll("*").length);
    } catch {
      setUrl("frame not readable");
      setHtml("");
      setNodes(0);
    }
  }, [frame]);

  useEffect(() => {
    const first = window.setTimeout(grab, 0); // deferred — no cascading render
    const t = window.setInterval(grab, 4000); // keep the url line honest
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [grab]);

  /* esc closes the sheet */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <section className="frost-devtools" role="dialog" aria-label="devtools">
      <div className="frost-devtools-head">
        <span aria-hidden="true">&lt;&gt;</span>
        <span className="frost-devtools-url">{url || "—"}</span>
        <span aria-hidden="true">{nodes} nodes</span>
        <button type="button" onClick={grab} aria-label="refresh devtools">
          refresh
        </button>
        <button type="button" onClick={onClose} aria-label="close devtools">
          close
        </button>
      </div>
      <pre ref={preRef} className="frost-devtools-body">
        {html || "—"}
      </pre>
    </section>
  );
}
