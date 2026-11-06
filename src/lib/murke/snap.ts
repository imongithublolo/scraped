/**
 * snap.ts — pure zone math for hyprland-style window snapping.
 *
 * A drag ends over one of nine zones: the four edge strips (left/right half,
 * bottom half, top edge = maximize) and the four 44×44 corner boxes that
 * take precedence over the strips (tl/tr/bl/br quarters). Nothing outside
 * the desktop bounds resolves to a zone.
 *
 * Kept free of any store import (type-only) so it stays trivially testable
 * and reusable — the store owns preview state + the actual snapWindow write.
 */

import type { SnapZone } from "./os-store";

/** the visible desktop area, menu bar / dock aware (from os-store.desktopBounds) */
export interface ZoneBounds {
  vw: number;
  vh: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** edge strip thickness in px — how close to an edge counts as "on the edge" */
export const EDGE = 14;
/** corner box size in px — 44×44 hot corners win over the edge strips */
export const CORNER = 44;

/** given a pointer position, which snap zone (if any) does it arm? */
export type DragZoneCheck = (x: number, y: number) => SnapZone | null;

/**
 * Build a zone checker for a given desktop bounds. `edge` / `corner` are
 * configurable so tests / settings can tune the hit areas.
 */
export function makeZoneChecker(b: ZoneBounds, edge: number = EDGE, corner: number = CORNER): DragZoneCheck {
  const l = b.left;
  const r = b.vw - b.right;
  const t = b.top;
  const bt = b.bottom;
  return (x: number, y: number): SnapZone | null => {
    /* only inside the desktop bounds */
    if (x < l || x > r || y < t || y > bt) return null;
    /* corner boxes take precedence over the edge strips */
    if (x <= l + corner && y <= t + corner) return "tl";
    if (x >= r - corner && y <= t + corner) return "tr";
    if (x <= l + corner && y >= bt - corner) return "bl";
    if (x >= r - corner && y >= bt - corner) return "br";
    /* edge strips — top edge maximizes (hyprland behavior) */
    if (x <= l + edge) return "left";
    if (x >= r - edge) return "right";
    if (y <= t + edge) return "max";
    if (y >= bt - edge) return "bottom";
    return null;
  };
}

/** human-readable description, e.g. "snap left half" — for aria/title text */
export function describeZone(z: SnapZone): string {
  switch (z) {
    case "left":
      return "snap left half";
    case "right":
      return "snap right half";
    case "top":
      return "snap top half";
    case "bottom":
      return "snap bottom half";
    case "tl":
      return "snap top-left quarter";
    case "tr":
      return "snap top-right quarter";
    case "bl":
      return "snap bottom-left quarter";
    case "br":
      return "snap bottom-right quarter";
    case "max":
      return "snap maximize";
  }
}
