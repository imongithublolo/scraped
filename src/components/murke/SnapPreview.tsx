"use client";

import type { ReactElement } from "react";
import { useOS } from "@/lib/murke/os-store";
import { describeZone } from "@/lib/murke/snap";

/**
 * SnapPreview — the translucent hyprland-style zone overlay. While a window
 * drag is armed over an edge/corner, the store holds `snapPreview` and this
 * overlay paints the zone the drop would land in: 1px brand border, 14%
 * brand wash, 2px backdrop blur. Rect changes (zone switches mid-drag)
 * glide via a 140ms ease transition; arming fades in. Pure indicator —
 * pointer-events-none, the actual snap happens in MacWindow / snapWindow.
 *
 * Desktop mounts this once, next to the window layer.
 */
export default function SnapPreview(): ReactElement | null {
  const preview = useOS((s) => s.snapPreview);
  const show = useOS((s) => s.settings.wm.snapPreview);
  if (!show || !preview) return null;
  const { rect, zone } = preview;
  return (
    <div
      aria-hidden="true"
      title={describeZone(zone)}
      className="murke-snap-preview pointer-events-none absolute z-[95] rounded-[10px] font-mono backdrop-blur-[2px]"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        border: "1px solid color-mix(in srgb, var(--term-brand) 55%, transparent)",
        background: "color-mix(in srgb, var(--term-brand) 14%, transparent)",
        transition: "left 140ms ease, top 140ms ease, width 140ms ease, height 140ms ease",
        animation: "murke-snap-in 160ms ease both",
      }}
    >
      <span
        className="absolute inset-0 flex items-center justify-center text-[11px] lowercase tracking-[0.18em]"
        style={{ color: "color-mix(in srgb, var(--term-brand) 85%, transparent)" }}
      >
        {describeZone(zone).replace(/^snap /, "")}
      </span>
      <style>{`@keyframes murke-snap-in { from { opacity: 0; } to { opacity: 1; } }`}</style>
    </div>
  );
}
