/**
 * Desktop wallpapers. Three sources, in priority order per user choice:
 *  - "scene"  the theme's living backdrop (default — the OS looks alive)
 *  - "preset" bundled stills in /public/wallpapers (generated art)
 *  - "custom" an image the user dropped into ~/Pictures/Wallpapers (VFS blob)
 */

export interface WallpaperPreset {
  id: string;
  label: string;
  url: string;
  /** which kind of theme this still pairs with — used for the hint text */
  tone: "dark" | "light";
}

export const WALLPAPER_PRESETS: WallpaperPreset[] = [
  { id: "ramiel", label: "", url: "/wallpapers/ramiel.jpg", tone: "dark" },
  { id: "wh-q6xzy7", label: "", url: "/wallpapers/wallhaven-q6xzy7.jpg", tone: "dark" },
  { id: "wh-x8w2ed", label: "", url: "/wallpapers/wallhaven-x8w2ed.jpg", tone: "dark" },
  { id: "wh-3q7j3v", label: "", url: "/wallpapers/wallhaven-3q7j3v.png", tone: "dark" },
  { id: "wh-ne8xvk", label: "", url: "/wallpapers/wallhaven-ne8xvk.jpg", tone: "dark" },
  { id: "wh-4o3mm5", label: "", url: "/wallpapers/wallhaven-4o3mm5.jpg", tone: "dark" },
  { id: "wh-d8vvlo", label: "", url: "/wallpapers/wallhaven-d8vvlo.png", tone: "dark" },
  { id: "wh-3q3z9d", label: "", url: "/wallpapers/wallhaven-3q3z9d.jpg", tone: "dark" },
];

export function presetById(id: string): WallpaperPreset | null {
  return WALLPAPER_PRESETS.find((p) => p.id === id) ?? null;
}

/* object-URL cache for VFS-backed custom wallpapers (path → blob url) */
const customUrls = new Map<string, string>();

export async function customWallpaperUrl(path: string): Promise<string | null> {
  const hit = customUrls.get(path);
  if (hit) return hit;
  try {
    const { getVfs } = await import("./vfs");
    const blob = await getVfs().readFileBlob(path);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    customUrls.set(path, url);
    return url;
  } catch {
    return null;
  }
}

export function forgetCustomWallpaper(path: string): void {
  const url = customUrls.get(path);
  if (url) URL.revokeObjectURL(url);
  customUrls.delete(path);
}
