"use client";

/**
 * The devil sigil — a stroked pentagram, the mark of the house.
 * Vector so it stays razor sharp at any size (chrome bar, newtab, boot).
 */
export default function PentagramMark({
  size = 16,
  className = "",
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="miter"
      strokeLinecap="square"
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* pentagram: every vertex connected to the two non-adjacent ones */}
      <path d="M 12 2.4 L 17.75 20.05 L 2.9 9.15 L 21.1 9.15 L 6.25 20.05 Z" />
    </svg>
  );
}
