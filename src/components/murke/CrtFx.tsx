"use client";

import { memo } from "react";
import type { CrtSettings } from "@/lib/murke/contracts";
import { crtVars } from "@/lib/murke/crtfx";

/**
 * CrtFx — the CRT tube, fully settings-driven.
 *
 * Every layer reads its strength from a --crt-* custom property the engine
 * (crtfx.ts) computes from CrtSettings, so the Settings app can move any
 * knob live with zero re-mounting:
 *
 *   scanlines  repeating raster, multiply-blended (self-adapts to light)
 *   beam       slow rolling refresh band
 *   noise      animated grain sheet
 *   curvature  rounded glass corners + edge shading + faint reflection
 *   flicker    whole-tube brightness jitter (keyframes read the amplitude)
 *   aberration comes through as text-shadow fringes in globals.css
 *
 * Sits ABOVE everything (z-[100]) and is pointer-events-none by law.
 */
const CrtFx = memo(function CrtFx({ crt, light }: { crt: CrtSettings; light: boolean }) {
  if (!crt.enabled) return null;
  return (
    <div
      className="crt-fx pointer-events-none fixed inset-0 z-[100] overflow-hidden"
      aria-hidden="true"
      style={crtVars(crt, light) as React.CSSProperties}
      data-light={light ? "true" : undefined}
    >
      {/* curvature: rounded glass mask + edge shading + a whisper of reflection */}
      {crt.curvature > 0.02 && (
        <>
          <div className="crt-curve-mask absolute inset-0" />
          <div className="crt-curve-edge absolute inset-0" />
        </>
      )}
      {crt.scanlines > 0.02 && <div className="crt-scanlines absolute inset-0" />}
      {crt.noise > 0.02 && <div className="crt-noise absolute inset-0" />}
      {crt.flicker > 0.02 && <div className="crt-flicker absolute inset-0 bg-black" />}
      <div className="crt-beam absolute inset-x-0 top-0 h-[9%]" />
    </div>
  );
});

export default CrtFx;
