"use client";

/** CRT scanline overlay (toggleable via the `crt` command). */
export default function CrtOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden" aria-hidden="true">
      <div className="absolute inset-0 murke-scanlines" />
      <div className="absolute inset-0 murke-vignette" />
      <div className="absolute inset-x-0 top-0 h-[9%] murke-scanbeam" />
    </div>
  );
}
