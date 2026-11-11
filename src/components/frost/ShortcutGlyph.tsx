"use client";

/**
 * ShortcutGlyph — a shortcut's icon when it has no custom one: the site's
 * REAL favicon, fetched same-origin through /api/favicon (the server asks
 * the site itself — no third-party trackers, works behind school filters).
 * While it loads / if the site has none, a quiet letter tile takes the
 * place — first letter of the shortcut, glass-grey on transparent.
 */

import { useMemo, useState } from "react";

export function ShortcutGlyph({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false);
  const src = useMemo(() => {
    try {
      const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
      return `/api/favicon?u=${encodeURIComponent(u.origin)}`;
    } catch {
      return null;
    }
  }, [url]);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
      />
    );
  }
  return <LetterTile name={name} />;
}

export function LetterTile({ name }: { name: string }) {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <text
        x="12"
        y="16.4"
        textAnchor="middle"
        fontSize="13.5"
        fontWeight={350}
        fontFamily='"Inter Frost", Inter, sans-serif'
        fill="#555"
      >
        {letter}
      </text>
    </svg>
  );
}
