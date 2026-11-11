"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { useOS } from "@/lib/murke/os-store";
import { PwaIcon } from "./AppIcon";

/**
 * AddAppDialog — the "add app…" flow behind the desktop / dock / launchpad
 * right-click menus. Name + url (+ an optional uploaded icon) → an installed
 * web app on the dock, launchpad, spotlight and the start menu at once.
 * The icon upload reads any image as a data url (capped 400kb by the store)
 * so the tile is the user's OWN art, not a favicon gamble.
 */

function newAppId(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID().slice(0, 8);
  } catch {
    /* fallthrough */
  }
  return Math.random().toString(36).slice(2, 10);
}

function appColor(name: string, url: string): string {
  let h = 0;
  const s = name + url;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 62% 52%)`;
}

/** normalize what the user typed into a real url (no proxy encoding here —
    the pwa view encodes at load time) */
function toUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withProto);
    if (u.hostname.includes(".")) return u.toString();
    return null;
  } catch {
    return null;
  }
}

export default function AddAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [icon, setIcon] = useState<string | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /* reset on each open — state-adjusted during render (the dock's pattern;
     an effect body calling setState trips the cascading-render rule) */
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName("");
      setUrl("");
      setIcon(undefined);
      setErr(null);
    }
  }

  /* focus the name field once mounted */
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => nameRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const previewUrl = toUrl(url);

  const pickIcon = (f: File | undefined | null) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setErr("that file is not an image");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result : "";
      if (data.length > 400_000) {
        // downscale big art through a canvas so localStorage stays healthy
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          const side = 128;
          c.width = side;
          c.height = side;
          const ctx = c.getContext("2d");
          if (!ctx) return;
          const scale = Math.max(side / img.width, side / img.height);
          const w = img.width * scale;
          const h = img.height * scale;
          ctx.drawImage(img, (side - w) / 2, (side - h) / 2, w, h);
          setIcon(c.toDataURL("image/png"));
          setErr(null);
        };
        img.onerror = () => setErr("could not read that image");
        img.src = data;
        return;
      }
      setIcon(data);
      setErr(null);
    };
    reader.onerror = () => setErr("could not read that file");
    void reader.readAsDataURL(f);
  };

  const submit = () => {
    const n = name.trim();
    if (!n) {
      setErr("give it a name");
      return;
    }
    if (!previewUrl) {
      setErr("that url does not look right — try e.g. carletonwoodworking.com");
      return;
    }
    useOS.getState().addCustomApp({
      id: newAppId(),
      name: n.slice(0, 24),
      url: previewUrl,
      color: appColor(n, previewUrl),
      ...(icon ? { icon } : {}),
    });
    onClose();
  };

  const inputCls =
    "w-full rounded-md border bg-transparent px-2.5 py-1.5 text-[12.5px] text-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)] focus:border-[var(--term-brand)]";

  return (
    <>
      {/* click-away */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-[129]"
        onClick={onClose}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div
        role="dialog"
        aria-label="add app"
        className="fixed left-1/2 top-1/2 z-[130] w-[320px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl p-4 shadow-[0_30px_90px_rgba(0,0,0,0.62)]"
        style={{
          border: "1px solid color-mix(in srgb, var(--term-fg) 16%, transparent)",
          background: "color-mix(in srgb, var(--term-bg) 70%, transparent)",
          backdropFilter: "blur(30px) saturate(1.7) brightness(1.1)",
          WebkitBackdropFilter: "blur(30px) saturate(1.7) brightness(1.1)",
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[13px] font-bold lowercase tracking-wide text-[var(--term-fg)]">add app</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="cursor-pointer rounded p-1 text-[var(--term-dim)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_10%,transparent)] hover:text-[var(--term-fg)]"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>

        {/* icon picker — click the tile to upload */}
        <div className="mb-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            aria-label="upload an icon"
            className="group relative h-14 w-14 shrink-0 cursor-pointer overflow-hidden rounded-xl border"
            style={{
              borderColor: "color-mix(in srgb, var(--term-fg) 20%, transparent)",
              background: icon ? undefined : "color-mix(in srgb, var(--term-fg) 7%, transparent)",
            }}
          >
            {icon ? (
              <img src={icon} alt="" className="h-full w-full object-cover" draggable={false} />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[var(--term-dim)]">
                <Upload size={17} strokeWidth={1.8} aria-hidden="true" />
              </span>
            )}
            <span className="pointer-events-none absolute inset-0 hidden items-center justify-center bg-black/45 text-[9px] font-bold lowercase tracking-wider text-white group-hover:flex">
              change
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] lowercase text-[var(--term-dim)]">
              {icon ? "custom icon — tap to replace" : previewUrl ? "no icon yet — we grab the site's favicon" : "optional icon — any image"}
            </div>
            {previewUrl && (
              <div className="mt-1.5 flex items-center gap-2">
                <PwaIcon url={previewUrl} name={name || "site"} size={26} skin="mac" glass icon={icon} />
                <span className="truncate text-[10px] text-[var(--term-dim)]">{new URL(previewUrl).hostname}</span>
              </div>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => pickIcon(e.target.files?.[0])}
          />
        </div>

        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="name — e.g. spotify"
          aria-label="app name"
          maxLength={24}
          spellCheck={false}
          autoComplete="off"
          className={`${inputCls} mb-2`}
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="address — e.g. open.spotify.com"
          aria-label="app address"
          spellCheck={false}
          autoComplete="off"
          className={`${inputCls} mb-1`}
        />
        {err && <p className="mt-1 text-[10.5px] text-[var(--term-err)]">{err}</p>}

        <button
          type="button"
          onClick={submit}
          className="mt-3 w-full cursor-pointer rounded-md py-1.5 text-[11.5px] font-bold lowercase tracking-wide transition-transform hover:scale-[1.01]"
          style={{ background: "var(--term-brand)", color: "var(--term-bg)" }}
        >
          add to dock
        </button>
      </div>
    </>
  );
}

/** open the dialog from anywhere (dock / launchpad / desktop menus) */
export function requestAddApp(): void {
  try {
    window.dispatchEvent(new CustomEvent("murke-add-app"));
  } catch {
    /* nothing listening — fine */
  }
}
