"use client";

import { useEffect, useState } from "react";
import type { WallpaperChoice } from "@/lib/murke/contracts";
import { getThemeDef } from "@/lib/murke/themes";
import { customWallpaperUrl, presetById } from "@/lib/murke/wallpapers";
import ThemeBackground from "./ThemeBackground";

/** Custom upload — keyed remount per path keeps the blob-url load simple. */
function CustomWallpaper({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void customWallpaperUrl(path).then((u) => {
      if (alive && u) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  if (!url) return null;
  return <div className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center" style={{ backgroundImage: `url(${url})` }} role="img" aria-label="custom wallpaper" />;
}

/**
 * Wallpaper — the desktop's own background, independent of the terminal
 * themes: the theme's living scene by default, a bundled still, or an
 * uploaded image stored in the VFS blob store. The terminal (and its
 * windows) keep following the theme; this layer is pure desktop.
 */
export default function Wallpaper({ theme, choice }: { theme: string; choice: WallpaperChoice }) {
  const def = getThemeDef(theme);

  /* theme scene (default) */
  if (choice.kind === "scene") {
    if (def.bgKind === "none") return null;
    return <ThemeBackground key={theme} theme={theme} />;
  }

  /* bundled preset still — a stale id (removed preset) falls back to the
     theme's living scene so the desktop is never a black void */
  if (choice.kind === "preset") {
    const p = presetById(choice.id);
    if (!p) return <ThemeBackground key={theme} theme={theme} />;
    return (
      <div
        className="pointer-events-none absolute inset-0 z-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${p.url})` }}
        role="img"
        aria-label="wallpaper"
      />
    );
  }

  /* user upload from the VFS */
  if (choice.kind === "custom") {
    return <CustomWallpaper key={choice.path} path={choice.path} />;
  }

  return null;
}
