"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { login } from "@/lib/murke/auth";

/**
 * The gate. Completely blank — no logo, no input box, no hints.
 * The password is typed blind and submitted with Enter.
 * Wrong input silently clears. Correct input fades through to the OS.
 */
export default function GateScreen({ onAuth }: { onAuth: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [flash, setFlash] = useState(false); // 1-frame flicker on wrong entry

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(async () => {
    if (checking) return;
    const pw = value;
    if (pw.length === 0) return;
    setChecking(true);
    const kind = await login(pw);
    setChecking(false);
    if (kind) {
      onAuth();
    } else {
      // silent rejection: clear + imperceptible flicker
      setValue("");
      setFlash(true);
      window.setTimeout(() => setFlash(false), 60);
    }
  }, [value, checking, onAuth]);

  return (
    <div
      className={`fixed inset-0 z-50 bg-black ${flash ? "opacity-95" : "opacity-100"} transition-opacity duration-150`}
      onClick={() => inputRef.current?.focus()}
      role="presentation"
    >
      {/* type="text" + CSS dot-masking: a real type="password" input makes
          Chrome's password manager pop a save-password bubble over the
          gate. Masked text never triggers it, and looks identical. */}
      <input
        ref={inputRef}
        type="text"
        value={value}
        disabled={checking}
        aria-label="authenticate"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        name="murke-gate-input"
        id="murke-gate-input"
        className="absolute inset-0 h-full w-full cursor-default bg-transparent px-0 text-base text-black opacity-0 outline-none"
        style={{ caretColor: "transparent", WebkitTextSecurity: "disc" } as React.CSSProperties}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
      />
    </div>
  );
}
