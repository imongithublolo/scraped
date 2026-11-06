"use client";

/**
 * useKonamiHandler — the ↑ ↑ ↓ ↓ ← → ← → B A code as a stable key
 * handler. The caller feeds it keydowns from wherever they come: the
 * parent window and (via BareFrame's onFrameKey) from inside the proxied
 * page — where focus lives almost all the time.
 */

import { useCallback, useEffect, useRef } from "react";

export const KONAMI = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "b",
  "a",
];

export function useKonamiHandler(onDone: () => void): (e: KeyboardEvent) => void {
  const cbRef = useRef(onDone);
  useEffect(() => {
    cbRef.current = onDone;
  }, [onDone]);
  const idxRef = useRef(0);

  return useCallback((e: KeyboardEvent) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === KONAMI[idxRef.current]) {
      idxRef.current += 1;
      if (idxRef.current === KONAMI.length) {
        idxRef.current = 0;
        cbRef.current();
      }
    } else {
      idxRef.current = k === KONAMI[0] ? 1 : 0;
    }
  }, []);
}
