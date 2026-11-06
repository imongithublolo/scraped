"use client";

/**
 * VmApp — a BOOTABLE VM. The `vm open` console is no longer just a serial
 * pipe: it is a small graphical machine that boots through a phase machine
 *
 *     post → grub → plymouth → desktop        (and  desktop → halted → close)
 *
 *   - "post"     SeaBIOS-style text POST (~1.7s): memory count-up, UUID,
 *                "Booting from Hard Disk..." — any key/click jumps to the
 *                boot menu with the countdown paused
 *   - "grub"     graphical GNU GRUB 2.12 menu, 8s auto-boot countdown,
 *                keyboard (↑/↓/enter) + mouse (click an entry to boot)
 *   - "plymouth" ubuntu splash — ring logo, dot loader, 2.6s
 *   - "desktop"  a graphical mini-OS: top bar (activities · clock · power),
 *                left dock, and draggable internal windows running the two
 *                consoles as apps:
 *                  · Terminal       → SimConsole  (simulated Ubuntu 24.04 shell)
 *                  · Serial console → RealConsole (v86 real x86 boot)
 *   - "halted"   a `system halted.` beat, then the window detaches
 *
 * PRESERVED from the old build: the whole v86 loader plumbing (loadV86,
 * V86_ASSETS, scriptPromise, fetchBuffer), RealConsole and SimConsole
 * verbatim (now memo-wrapped so window drags stay smooth), and the uptime
 * accounting effect that patches accumulated ms into the vm registry on
 * detach. If v86 can't run, RealConsole reports fallback — the desktop
 * raises a dismissible amber banner and auto-opens a Terminal window so
 * the user is never dead-ended.
 *
 * The machine's identity (name, ip, size, region) comes from the vm
 * registry (arg = vm name). Consoles are ephemeral: closing the window
 * powers the machine off; `vm open` boots it fresh.
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Cpu, Power, RotateCcw, Settings, SquareTerminal, Volume2, X } from "lucide-react";
import { findVm, fmtAge, patchVm, VM_OS } from "@/lib/murke/vm";

/* ================= shared console chrome ================= */

const CLS: Record<string, string> = {
  dim: "text-[#9d9a92]",
  ok: "text-[#4ec9b0] font-bold",
  err: "text-[#f0704a] font-bold",
  brand: "text-[#e95420] font-bold",
  warn: "text-[#e3b341]",
};

/* ================= boot phase machine ================= */

type Phase = "post" | "grub" | "plymouth" | "desktop" | "halted";

/** POST memory count-up target, per registry size (KB) */
const POST_MEM_K: Record<string, number> = {
  "micro-1gb": 1048576,
  "small-2gb": 2097152,
  "standard-4gb": 4194304,
};

const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MO = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** top-bar clock — `fri nov 3  20:51` (two spaces, lowercase) */
function fmtClock(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}  ${hh}:${mm}`;
}

/** deterministic uuid-ish hex id derived from the vm ip + name */
function uuidFromIp(ip: string, name: string): string {
  const o = ip.split(".").map((n) => Number.parseInt(n, 10) & 0xff);
  let s =
    ((o[0] ?? 10) * 0x9e3779b1 +
      (o[1] ?? 14) * 0x85ebca77 +
      (o[2] ?? 0) * 0xc2b2ae35 +
      (o[3] ?? 1) * 0x27d4eb2f) >>>
    0;
  for (let i = 0; i < name.length; i++) s = Math.imul(s ^ name.charCodeAt(i), 0x1000193) >>> 0;
  const part = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s.toString(16).padStart(8, "0").slice(0, 4);
  };
  return `${part()}${part()}-${part()}-${part()}-${part()}-${part()}${part()}${part()}`;
}

/** stable small hash for per-machine window offsets */
function nameHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/* ================= POST screen ================= */

function PostScreen({
  uuid,
  memK,
  onBoot,
  onMenu,
}: {
  uuid: string;
  memK: number;
  onBoot: () => void;
  onMenu: () => void;
}) {
  const [step, setStep] = useState(0);
  const [mem, setMem] = useState(0);
  const doneRef = useRef(false);

  const go = useCallback(
    (menu: boolean) => {
      if (doneRef.current) return;
      doneRef.current = true;
      if (menu) onMenu();
      else onBoot();
    },
    [onBoot, onMenu],
  );

  useEffect(() => {
    const ts = [
      window.setTimeout(() => setStep(1), 70),
      window.setTimeout(() => setStep(2), 280),
      window.setTimeout(() => setStep(3), 480),
      window.setTimeout(() => setStep(4), 1360),
      window.setTimeout(() => go(false), 1780),
    ];
    return () => ts.forEach((t) => window.clearTimeout(t));
  }, [go]);

  /* memory count-up — the POST number rolls up over a few frames, then OK */
  useEffect(() => {
    if (step !== 3) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 470);
      setMem(Math.round(memK * p));
      if (p < 1) raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [step, memK]);

  /* any key jumps to the boot menu (grub opens with its countdown paused) */
  useEffect(() => {
    const key = () => go(true);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go]);

  return (
    <div
      className="relative h-full w-full cursor-default bg-black p-4 font-mono text-[12px] leading-[1.55] text-[#c9c4b8]"
      onPointerDown={() => go(true)}
      role="region"
      aria-label="firmware post"
    >
      {step >= 1 && <pre className="whitespace-pre-wrap">SeaBIOS (version murke-1.16.2-vm)</pre>}
      {step >= 2 && (
        <pre className="whitespace-pre-wrap">
          Machine UUID: <span className="text-[#4ec9b0]">{uuid}</span>
        </pre>
      )}
      {step >= 3 && (
        <pre className="whitespace-pre-wrap">
          Testing system memory: {mem}K
          {mem >= memK && <span className="font-bold text-[#4ec9b0]"> OK</span>}
        </pre>
      )}
      {step >= 4 && <pre className="whitespace-pre-wrap">Booting from Hard Disk...</pre>}

      <div className="absolute bottom-3 right-4 text-[10.5px] lowercase text-[#6e6a61]">press any key for the boot menu</div>
    </div>
  );
}

/* ================= GRUB menu ================= */

const GRUB_SECONDS = 8;

const GRUB_ENTRIES = [
  { label: "Ubuntu", disabled: false },
  { label: "Advanced options for Ubuntu", disabled: false },
  { label: "System setup", disabled: true },
] as const;

function GrubMenu({ startPaused, onBoot }: { startPaused: boolean; onBoot: () => void }) {
  const [sel, setSel] = useState(0);
  const [paused, setPaused] = useState(startPaused);
  const [left, setLeft] = useState(GRUB_SECONDS);
  const [note, setNote] = useState<string | null>(null);
  const selRef = useRef(0);
  const noteTimerRef = useRef<number | null>(null);
  const bootedRef = useRef(false);

  useEffect(() => {
    selRef.current = sel;
  }, [sel]);

  const boot = useCallback(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    onBoot();
  }, [onBoot]);

  const showNote = useCallback(() => {
    setNote("not available on this machine");
    if (noteTimerRef.current !== null) window.clearTimeout(noteTimerRef.current);
    noteTimerRef.current = window.setTimeout(() => setNote(null), 1200);
  }, []);

  useEffect(
    () => () => {
      if (noteTimerRef.current !== null) window.clearTimeout(noteTimerRef.current);
    },
    [],
  );

  /* auto-boot countdown — arrow keys move, enter boots, any other key cancels */
  useEffect(() => {
    if (paused) return;
    const t = window.setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearInterval(t);
  }, [paused]);

  useEffect(() => {
    if (paused || left > 0) return;
    /* the countdown only ever auto-boots Ubuntu (disabled entries can't) */
    boot();
  }, [left, paused, boot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (s + 1) % GRUB_ENTRIES.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s + GRUB_ENTRIES.length - 1) % GRUB_ENTRIES.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (GRUB_ENTRIES[selRef.current].disabled) showNote();
        else boot();
      } else {
        setPaused(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [boot, showNote]);

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center px-4"
      style={{ background: "linear-gradient(to bottom, #17130f, #0c0a08)" }}
      role="region"
      aria-label="grub boot menu"
    >
      <div className="w-full max-w-[560px] overflow-hidden rounded-lg border border-white/[0.08] bg-black/35 shadow-[0_24px_70px_rgba(0,0,0,0.6)]">
        <div className="border-b border-white/[0.08] px-4 py-3 text-center font-mono text-[12.5px] tracking-wide text-[#c9c4b8]">
          GNU GRUB&nbsp; version 2.12
        </div>
        <div role="listbox" aria-label="boot entries" className="py-2">
          {GRUB_ENTRIES.map((en, i) => (
            <button
              key={en.label}
              type="button"
              role="option"
              aria-selected={sel === i}
              onClick={() => (en.disabled ? showNote() : boot())}
              className={`relative flex w-full cursor-pointer items-center px-4 py-2 text-left font-mono text-[12px] transition-colors ${
                sel === i ? "bg-white/[0.07] text-[#f0ece4]" : "text-[#a8a396] hover:bg-white/[0.03]"
              }`}
            >
              {sel === i && <span aria-hidden="true" className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r bg-[#e95420]" />}
              <span className="pl-2">{en.label}</span>
              {en.disabled && <span className="ml-auto pl-3 text-[10px] lowercase text-[#6e6a61]">unavailable</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 flex h-4 items-center justify-center font-mono text-[11px] lowercase">
        {note ? (
          <span className="text-[#e3b341]">{note}</span>
        ) : (
          !paused && (
            <span className="text-[#9d9a92]">
              will boot &quot;{GRUB_ENTRIES[sel].label}&quot; in <span className="tabular-nums">{left}s</span>
            </span>
          )
        )}
      </div>
      <div className="mt-1.5 text-center font-mono text-[10.5px] lowercase text-[#6e6a61]">use ↑ and ↓ to select · enter to boot</div>
    </div>
  );
}

/* ================= plymouth splash ================= */

const PLY_CSS = `
@keyframes murke-vm-ply {
  0%, 100% { opacity: 0.16; transform: scale(0.78); }
  50% { opacity: 1; transform: scale(1); }
}
.murke-vm-ply-dot { animation: murke-vm-ply 1.08s ease-in-out infinite; }
`;

function Plymouth({ ip, onDone }: { ip: string; onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, 2600);
    return () => window.clearTimeout(t);
  }, [onDone]);

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-7"
      style={{ background: "#1b1016" }}
      role="status"
      aria-label="ubuntu boot splash"
    >
      <style dangerouslySetInnerHTML={{ __html: PLY_CSS }} />
      <div aria-hidden="true" className="flex h-11 w-11 items-center justify-center rounded-full border-[5px] border-[#e95420]">
        <div className="h-2.5 w-2.5 rounded-full bg-[#e95420]" />
      </div>
      <div aria-hidden="true" className="flex gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="murke-vm-ply-dot h-1.5 w-1.5 rounded-full bg-[#e95420]"
            style={{ animationDelay: `${(i * 0.14).toFixed(2)}s` }}
          />
        ))}
      </div>
      <div className="text-center">
        <div className="font-mono text-[13px] lowercase text-[#9d9a92]">ubuntu 16.04.6 lts</div>
        <div className="mt-1 font-mono text-[10px] lowercase text-[#9d9a92]/60">murke-vm {ip}</div>
      </div>
    </div>
  );
}

/* ================= halted ================= */

function HaltedScreen({ onExit }: { onExit: () => void }) {
  /* read the latest onClose through a ref so a parent re-render can't reset the timer */
  const exitRef = useRef(onExit);
  useEffect(() => {
    exitRef.current = onExit;
  });
  useEffect(() => {
    const t = window.setTimeout(() => exitRef.current(), 900);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="flex h-full w-full items-center justify-center bg-black font-mono text-[12px] text-[#57534e]" role="status">
      system halted.
    </div>
  );
}

/* ================= desktop building blocks ================= */

type WinKind = "terminal" | "serial" | "settings";

interface VmWin {
  id: number;
  kind: WinKind;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

const WIN_SIZES: Record<WinKind, { w: number; h: number }> = {
  terminal: { w: 560, h: 360 },
  serial: { w: 560, h: 360 },
  settings: { w: 400, h: 340 },
};

const WIN_TITLES: Record<WinKind, string> = {
  terminal: "terminal",
  serial: "serial console",
  settings: "settings",
};

const MAX_WINDOWS = 4;

const WALLPAPER: React.CSSProperties = {
  background:
    "radial-gradient(640px 420px at 86% 10%, rgba(233,84,32,0.08), transparent 70%)," +
    "radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.42) 100%)," +
    "linear-gradient(165deg, #1e1815 0%, #191512 52%, #120e0b 100%)",
};

/* window + banner mount fade — scoped keyframes, uniquely murke-vm-* prefixed */
const DESKTOP_CSS = `
@keyframes murke-vm-win-in {
  from { opacity: 0; transform: translateY(6px) scale(0.985); }
  to { opacity: 1; transform: none; }
}
.murke-vm-win { animation: murke-vm-win-in 170ms ease-out backwards; }
`;

function VmWindow({
  win,
  focused,
  title,
  onFocus,
  onHeaderDown,
  onHeaderMove,
  onHeaderEnd,
  onClose,
  children,
}: {
  win: VmWin;
  focused: boolean;
  title: string;
  onFocus: (id: number) => void;
  onHeaderDown: (e: React.PointerEvent, win: VmWin) => void;
  onHeaderMove: (e: React.PointerEvent) => void;
  onHeaderEnd: () => void;
  onClose: (id: number) => void;
  children: React.ReactNode;
}) {
  return (
    <section
      role="dialog"
      aria-label={title}
      className="murke-vm-win absolute flex flex-col overflow-hidden rounded-md border shadow-[0_18px_50px_rgba(0,0,0,0.55)]"
      style={{
        left: win.x,
        top: win.y,
        width: win.w,
        height: win.h,
        zIndex: 10 + win.z,
        borderColor: focused ? "rgba(233,84,32,0.4)" : "rgba(255,255,255,0.1)",
        background: "rgba(20,15,12,0.96)",
      }}
      onPointerDown={() => onFocus(win.id)}
    >
      {/* drag header */}
      <div
        className="flex h-7 shrink-0 cursor-grab items-center gap-2 border-b border-white/[0.07] bg-black/40 px-2.5 active:cursor-grabbing"
        onPointerDown={(e) => onHeaderDown(e, win)}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderEnd}
        onPointerCancel={onHeaderEnd}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] lowercase tracking-wide text-[#c9c4b8]">{title}</span>
        <button
          type="button"
          aria-label={`close ${title}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onClose(win.id)}
          className="cursor-pointer rounded p-1 text-[#9d9a92] transition-colors hover:bg-white/10 hover:text-[#e8e4dd]"
        >
          <X size={11} aria-hidden="true" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </section>
  );
}

function DockButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onClick}
        className="flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-xl text-[#c9c4b8] transition-colors hover:bg-white/10 hover:text-[#e95420]"
      >
        {icon}
      </button>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded border border-white/10 bg-black/85 px-1.5 py-0.5 font-mono text-[10px] lowercase text-[#c9c4b8] opacity-0 transition-opacity group-hover:opacity-100"
      >
        {label}
      </span>
    </div>
  );
}

function SettingsPanel({
  host,
  ip,
  size,
  region,
  baseUptimeMs,
  mountedAt,
  onRestart,
  onShutdown,
}: {
  host: string;
  ip: string;
  size: string;
  region: string;
  baseUptimeMs: number;
  mountedAt: number;
  onRestart: () => void;
  onShutdown: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => (n + 1) % 1000000), 1000);
    return () => window.clearInterval(t);
  }, []);
  const uptime = fmtAge(baseUptimeMs + Math.max(0, Date.now() - mountedAt));

  return (
    <div className="murke-scroll min-h-0 flex-1 overflow-y-auto p-4 font-mono text-[11.5px] lowercase text-[#c9c4b8]">
      <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <span className="text-[#6e6a61]">name</span>
        <span className="truncate">{host}</span>
        <span className="text-[#6e6a61]">address</span>
        <span className="tabular-nums">{ip}</span>
        <span className="text-[#6e6a61]">size</span>
        <span>{size}</span>
        <span className="text-[#6e6a61]">region</span>
        <span>vercel-{region}</span>
        <span className="text-[#6e6a61]">uptime</span>
        <span className="tabular-nums">{uptime}</span>
      </div>

      <div className="mt-4 border-t border-white/[0.08] pt-3">
        <div className="text-[#6e6a61]">operating system</div>
        <div className="mt-1.5">ubuntu 16.04.6 lts (x86, v86)</div>
        <div className="mt-0.5">simulated ubuntu 24.04 shell</div>
        <div className="mt-1.5 text-[10.5px] text-[#6e6a61]">registry image: {VM_OS}</div>
      </div>

      <div className="mt-5 flex gap-2">
        <button
          type="button"
          onClick={onRestart}
          className="flex cursor-pointer items-center gap-1.5 rounded border border-white/15 px-2.5 py-1.5 transition-colors hover:border-[#e95420]/50 hover:bg-[#e95420]/10 hover:text-[#e8e4dd]"
        >
          <RotateCcw size={11} aria-hidden="true" /> restart
        </button>
        <button
          type="button"
          onClick={onShutdown}
          className="flex cursor-pointer items-center gap-1.5 rounded border border-white/15 px-2.5 py-1.5 transition-colors hover:border-[#e95420]/50 hover:bg-[#e95420]/10 hover:text-[#e8e4dd]"
        >
          <Power size={11} aria-hidden="true" /> shut down
        </button>
      </div>
    </div>
  );
}

/* ================= VmApp ================= */

export default function VmApp({ vmName, onClose }: { vmName: string; onClose: () => void }) {
  /* machine identity — read the registry once at attach (the old build
     re-read per render; with draggable windows re-rendering constantly,
     once is right) */
  const [vm] = useState(() => findVm(vmName));
  const host = vm?.name ?? vmName;
  const ip = vm?.ip ?? "10.14.0.1";
  const size = vm?.size ?? "micro-1gb";
  const region = vm?.region ?? "iad1";
  const uuid = uuidFromIp(ip, host);
  const memK = POST_MEM_K[size] ?? 1048576;

  /* ---- boot phase machine ---- */
  const [phase, setPhase] = useState<Phase>("post");
  const [grubPaused, setGrubPaused] = useState(false);

  const toGrubAuto = useCallback(() => {
    setGrubPaused(false);
    setPhase("grub");
  }, []);
  const toGrubMenu = useCallback(() => {
    setGrubPaused(true);
    setPhase("grub");
  }, []);
  const toPlymouth = useCallback(() => setPhase("plymouth"), []);
  const toDesktop = useCallback(() => setPhase("desktop"), []);

  /* accumulate console uptime into the registry when the window detaches
     (preserved from the old build) */
  const startedRef = useRef(Date.now());
  useEffect(() => {
    const vm0 = vm;
    const started = Date.now();
    return () => {
      if (vm0) patchVm(vm0.name, { uptimeMs: (vm0.uptimeMs ?? 0) + (Date.now() - started) });
    };
  }, [vm]);

  /* ---- internal windows ---- */
  const [windows, setWindows] = useState<VmWin[]>([]);
  const windowsRef = useRef<VmWin[]>([]);
  const idRef = useRef(1);
  const zRef = useRef(0);
  const areaRef = useRef<HTMLDivElement>(null);
  const autoOpenedRef = useRef(false);

  const focusWin = useCallback((id: number) => {
    const ws = windowsRef.current;
    if (ws.length === 0) return;
    const topZ = Math.max(...ws.map((w) => w.z));
    const target = ws.find((w) => w.id === id);
    if (!target || target.z === topZ) return;
    zRef.current = topZ + 1;
    windowsRef.current = ws.map((w) => (w.id === id ? { ...w, z: zRef.current } : w));
    setWindows(windowsRef.current);
  }, []);

  const closeWin = useCallback((id: number) => {
    windowsRef.current = windowsRef.current.filter((w) => w.id !== id);
    setWindows(windowsRef.current);
  }, []);

  const openWin = useCallback(
    (kind: WinKind) => {
      const existing = windowsRef.current.find((w) => w.kind === kind);
      if (existing) {
        focusWin(existing.id);
        return;
      }
      if (windowsRef.current.length >= MAX_WINDOWS) return;
      const area = areaRef.current;
      const aw = area?.clientWidth ?? 760;
      const ah = area?.clientHeight ?? 460;
      /* fit small viewports, keep the requested size otherwise */
      const w = Math.min(WIN_SIZES[kind].w, Math.max(240, aw - 20));
      const h = Math.min(WIN_SIZES[kind].h, Math.max(180, ah - 20));
      const off = (nameHash(vmName) % 4) * 24;
      const cascade = windowsRef.current.length * 26;
      const x = clamp(Math.round((aw - w) / 2) - 70 + off + cascade, 10, Math.max(10, aw - w - 10));
      const y = clamp(Math.round((ah - h) / 2) - 60 + off + cascade, 10, Math.max(10, ah - h - 10));
      zRef.current += 1;
      const win: VmWin = { id: idRef.current++, kind, x, y, w, h, z: zRef.current };
      windowsRef.current = [...windowsRef.current, win];
      setWindows(windowsRef.current);
    },
    [focusWin, vmName],
  );

  /* ---- window dragging (pointer-captured header, clamped to bounds) ---- */
  const dragRef = useRef<{ id: number; px: number; py: number; x: number; y: number; w: number; h: number; aw: number; ah: number } | null>(
    null,
  );

  const onHeaderDown = useCallback((e: React.PointerEvent, win: VmWin) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const area = areaRef.current;
    dragRef.current = {
      id: win.id,
      px: e.clientX,
      py: e.clientY,
      x: win.x,
      y: win.y,
      w: win.w,
      h: win.h,
      aw: area?.clientWidth ?? 0,
      ah: area?.clientHeight ?? 0,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onHeaderMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const nx = clamp(d.x + (e.clientX - d.px), 0, Math.max(0, d.aw - d.w));
    const ny = clamp(d.y + (e.clientY - d.py), 0, Math.max(0, d.ah - d.h));
    const ws = windowsRef.current;
    const cur = ws.find((w) => w.id === d.id);
    if (!cur || (cur.x === nx && cur.y === ny)) return;
    windowsRef.current = ws.map((w) => (w.id === d.id ? { ...w, x: nx, y: ny } : w));
    setWindows(windowsRef.current);
  }, []);

  const onHeaderEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

  /* ---- power actions ---- */
  const [powerOpen, setPowerOpen] = useState(false);

  /** note shown when the real x86 boot gave up — explains the fallback honestly */
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);

  const restart = useCallback(() => {
    windowsRef.current = [];
    setWindows([]);
    zRef.current = 0;
    setFallbackNote(null);
    setPowerOpen(false);
    setGrubPaused(false);
    autoOpenedRef.current = false;
    setPhase("post");
  }, []);

  const shutdown = useCallback(() => {
    setPowerOpen(false);
    setPhase("halted");
  }, []);

  /* ---- fallback banner ---- */
  const handleFallback = useCallback(
    (why: string) => {
      setFallbackNote(`real x86 boot unavailable (${why}) — the simulated shell took over`);
      /* don't dead-end the user: if the terminal isn't already open, open it */
      if (!windowsRef.current.some((w) => w.kind === "terminal")) openWin("terminal");
    },
    [openWin],
  );

  /* ---- live clock (10s cadence is plenty) ---- */
  const [clock, setClock] = useState(() => fmtClock(new Date()));
  useEffect(() => {
    if (phase !== "desktop") return;
    setClock(fmtClock(new Date()));
    const t = window.setInterval(() => setClock(fmtClock(new Date())), 10_000);
    return () => window.clearInterval(t);
  }, [phase]);

  /* the desktop boots into one terminal window, offset per machine so
     multiple vms don't stack identically */
  useEffect(() => {
    if (phase !== "desktop" || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    openWin("terminal");
  }, [phase, openWin]);

  /* ---- render by phase ---- */
  if (phase === "post") return <PostScreen uuid={uuid} memK={memK} onBoot={toGrubAuto} onMenu={toGrubMenu} />;
  if (phase === "grub") return <GrubMenu startPaused={grubPaused} onBoot={toPlymouth} />;
  if (phase === "plymouth") return <Plymouth ip={ip} onDone={toDesktop} />;
  if (phase === "halted") return <HaltedScreen onExit={onClose} />;

  const topZ = windows.reduce((m, w) => Math.max(m, w.z), 0);
  const mountedAt = startedRef.current;
  const baseUptime = vm?.uptimeMs ?? 0;

  return (
    <div
      className="relative flex h-full w-full cursor-default flex-col overflow-hidden"
      style={WALLPAPER}
      role="region"
      aria-label={`ubuntu desktop ${host}`}
    >
      <style dangerouslySetInnerHTML={{ __html: DESKTOP_CSS }} />

      {/* top bar */}
      <header
        className="relative z-40 flex h-7 shrink-0 select-none items-center gap-1 px-2"
        style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" }}
      >
        <button
          type="button"
          onClick={() => openWin("settings")}
          className="cursor-pointer rounded px-2 py-0.5 text-[11px] lowercase text-[#c9c4b8] transition-colors hover:bg-white/10 hover:text-[#e8e4dd]"
        >
          Activities
        </button>
        <span
          aria-live="off"
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-pre font-mono text-[11px] lowercase tabular-nums text-[#c9c4b8]"
        >
          {clock}
        </span>
        <span className="flex-1" />
        <span title="no audio device" aria-hidden="true" className="p-1 text-[#9d9a92]">
          <Volume2 size={13} />
        </span>
        <div className="relative">
          <button
            type="button"
            aria-label="power menu"
            aria-expanded={powerOpen}
            onPointerDown={() => setPowerOpen((o) => !o)}
            className="cursor-pointer rounded p-1 text-[#c9c4b8] transition-colors hover:bg-white/10 hover:text-[#e8e4dd]"
          >
            <Power size={13} aria-hidden="true" />
          </button>
          {powerOpen && (
            <>
              {/* click-away */}
              <div aria-hidden="true" className="fixed inset-0" onPointerDown={() => setPowerOpen(false)} />
              <div
                role="menu"
                aria-label="power options"
                className="absolute right-0 top-full z-10 mt-1.5 w-44 overflow-hidden rounded-md border border-white/10 py-1 font-mono text-[11px] lowercase"
                style={{
                  background: "rgba(20,16,13,0.92)",
                  backdropFilter: "blur(14px)",
                  WebkitBackdropFilter: "blur(14px)",
                  boxShadow: "0 12px 34px rgba(0,0,0,0.5)",
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPowerOpen(false);
                    openWin("serial");
                  }}
                  className="block w-full cursor-pointer px-3 py-1.5 text-left text-[#c9c4b8] transition-colors hover:bg-[#e95420]/15 hover:text-[#e8e4dd]"
                >
                  serial console
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={restart}
                  className="block w-full cursor-pointer px-3 py-1.5 text-left text-[#c9c4b8] transition-colors hover:bg-[#e95420]/15 hover:text-[#e8e4dd]"
                >
                  restart
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={shutdown}
                  className="block w-full cursor-pointer px-3 py-1.5 text-left text-[#c9c4b8] transition-colors hover:bg-[#e95420]/15 hover:text-[#e8e4dd]"
                >
                  shut down
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* fallback banner (dismissible) */}
      {fallbackNote && (
        <div className="murke-vm-win relative z-30 flex shrink-0 items-center gap-2 border-b border-[#e3b341]/30 bg-[#e3b341]/10 px-3 py-1 font-mono text-[10.5px] text-[#e3b341]">
          <span className="min-w-0 flex-1 truncate">{fallbackNote}</span>
          <button
            type="button"
            aria-label="dismiss notice"
            onClick={() => setFallbackNote(null)}
            className="cursor-pointer rounded p-0.5 transition-colors hover:bg-[#e3b341]/20"
          >
            <X size={11} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* desktop area — windows + dock; isolate keeps their z-order inside */}
      <div ref={areaRef} className="relative isolate min-h-0 flex-1">
        {windows.map((w) => (
          <VmWindow
            key={w.id}
            win={w}
            focused={w.z === topZ}
            title={WIN_TITLES[w.kind]}
            onFocus={focusWin}
            onHeaderDown={onHeaderDown}
            onHeaderMove={onHeaderMove}
            onHeaderEnd={onHeaderEnd}
            onClose={closeWin}
          >
            {w.kind === "terminal" && <SimConsole host={host} ip={ip} size={size} />}
            {w.kind === "serial" && <RealConsole host={host} onFallback={handleFallback} />}
            {w.kind === "settings" && (
              <SettingsPanel
                host={host}
                ip={ip}
                size={size}
                region={region}
                baseUptimeMs={baseUptime}
                mountedAt={mountedAt}
                onRestart={restart}
                onShutdown={shutdown}
              />
            )}
          </VmWindow>
        ))}

        {/* left dock */}
        <nav
          aria-label="vm dock"
          className="absolute left-2 top-1/2 z-[400] flex -translate-y-1/2 select-none flex-col gap-1 rounded-2xl border border-white/[0.08] p-1.5"
          style={{ background: "rgba(255,255,255,0.06)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}
        >
          <DockButton icon={<SquareTerminal size={15} aria-hidden="true" />} label="terminal" onClick={() => openWin("terminal")} />
          <DockButton icon={<Cpu size={15} aria-hidden="true" />} label="serial console" onClick={() => openWin("serial")} />
          <DockButton icon={<Settings size={15} aria-hidden="true" />} label="settings" onClick={() => openWin("settings")} />
          <div aria-hidden="true" className="mx-auto my-0.5 h-px w-5 bg-white/15" />
          <DockButton icon={<RotateCcw size={15} aria-hidden="true" />} label="restart" onClick={restart} />
          <DockButton icon={<Power size={15} aria-hidden="true" />} label="shut down" onClick={shutdown} />
        </nav>
      </div>
    </div>
  );
}

/* ================= REAL MODE — v86 ================= */

/* minimal typings over the vendored libv86.js */
interface V86Bus {
  register(event: string, fn: (payload?: unknown) => void): void;
}
interface V86Instance {
  bus: V86Bus;
  /** v86 ≥0.5.4xx: write a string into COM1 */
  serial0_send(data: string): void;
  /** fallback: serial_send_bytes(port, bytes) */
  serial_send_bytes?(port: number, data: ArrayLike<number>): void;
  destroy(): void;
  stop(): void;
}
type V86Ctor = new (opts: Record<string, unknown>) => V86Instance;

declare global {
  interface Window {
    V86?: V86Ctor;
  }
}

const V86_SCRIPT = "/vm/libv86.js";
const V86_ASSETS = {
  bios: "/vm/bios/seabios.bin",
  vgabios: "/vm/bios/vgabios.bin",
  kernel: "/vm/vmlinuz-virt",
  initrd: "/vm/initramfs-ubuntu.img.gz",
};

/** mirrors on jsdelivr — the npm build is byte-identical to the vendored
 *  files, so if /vm/* is unreachable (bot-wall, cold CDN, school filter)
 *  the generic pieces still come down and the machine still boots */
const V86_CDN = "https://cdn.jsdelivr.net/npm/v86@latest";
const V86_FALLBACK: Record<string, string> = {
  [V86_ASSETS.bios]: `${V86_CDN}/bios/seabios.bin`,
  [V86_ASSETS.vgabios]: `${V86_CDN}/bios/vgabios.bin`,
};

let scriptPromise: Promise<V86Ctor> | null = null;

/** load libv86.js once per page — local first, jsdelivr mirror second */
function loadV86(): Promise<V86Ctor> {
  if (typeof WebAssembly === "undefined") return Promise.reject(new Error("no WebAssembly"));
  if (window.V86) return Promise.resolve(window.V86);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<V86Ctor>((resolve, reject) => {
    const attach = (src: string, onFail: () => void) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => {
        if (window.V86) resolve(window.V86);
        else onFail();
      };
      s.onerror = onFail;
      document.head.appendChild(s);
    };
    attach(V86_SCRIPT, () => {
      // local copy unreachable — the public npm mirror ships the same bytes
      attach(`${V86_CDN}/build/libv86.js`, () => reject(new Error("libv86 failed to load")));
    });
  });
  return scriptPromise;
}

/** fetch with byte progress + automatic retries (cache-busted) and an
 *  optional mirror url — v86 gets buffers we already hold */
async function fetchBuffer(
  url: string,
  onProgress: (loaded: number, total: number) => void,
  mirror?: string,
): Promise<ArrayBuffer> {
  const attempts: Array<{ url: string; cache: RequestCache }> = [
    { url, cache: "force-cache" },
    { url, cache: "reload" },
    { url: `${url}${url.includes("?") ? "&" : "?"}r=${Date.now()}`, cache: "no-store" },
    ...(mirror ? [{ url: mirror, cache: "no-store" } as { url: string; cache: RequestCache }] : []),
  ];
  let lastErr: Error = new Error(`${url}: unreachable`);
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, { cache: a.cache });
      if (!res.ok) {
        lastErr = new Error(`${a.url}: ${res.status}${res.status === 403 ? " (blocked)" : ""}`);
        continue;
      }
      const total = Number(res.headers.get("content-length") ?? 0);
      if (!res.body || !total) return res.arrayBuffer();
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress(loaded, total);
      }
      const out = new Uint8Array(loaded);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out.buffer;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr;
}

const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

const RealConsole = memo(function RealConsole({ host, onFallback }: { host: string; onFallback: (why: string) => void }) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"loading" | "booting" | "live" | "dead">("loading");
  const [progress, setProgress] = useState<{ label: string; pct: number } | null>(null);
  const [input, setInput] = useState("");
  const [attempt, setAttempt] = useState(0);
  /** fetch/boot failure — surfaced with a retry instead of silently degrading */
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const emuRef = useRef<V86Instance | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const liveRef = useRef(false);
  /** pending serial bytes — flushed on a rAF cadence so a chatty boot
      doesn't re-render the console for every byte */
  const pendingRef = useRef("");
  const flushRef = useRef<number | null>(null);
  /** restored collapsed \r fragments (progress spinners) */
  const linesRef = useRef<string[]>([]);

  const pushBytes = useCallback((chunk: string) => {
    pendingRef.current += chunk;
    if (flushRef.current !== null) return;
    flushRef.current = window.setTimeout(() => {
      flushRef.current = null;
      const raw = pendingRef.current;
      pendingRef.current = "";
      // normalize: strip ansi, collapse \r overwrites into line churn
      const clean = raw
        .replace(ANSI_RE, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
      const cur = linesRef.current;
      const parts = (cur.join("\n") + clean).split("\n");
      if (parts.length > 600) parts.splice(0, parts.length - 500);
      linesRef.current = parts;
      setText(parts.join("\n"));
    }, 80);
  }, []);

  useEffect(() => {
    let dead = false;
    let emu: V86Instance | null = null;

    void (async () => {
      try {
        setPhase("loading");
        setLoadErr(null);
        setProgress({ label: "seabios", pct: 0 });
        const [bios, vgabios, kernel, initrd] = await Promise.all([
          fetchBuffer(V86_ASSETS.bios, (l, t) => setProgress({ label: "seabios", pct: (l / t) * 100 }), V86_FALLBACK[V86_ASSETS.bios]),
          fetchBuffer(V86_ASSETS.vgabios, (l, t) => setProgress({ label: "vgabios", pct: (l / t) * 100 }), V86_FALLBACK[V86_ASSETS.vgabios]),
          fetchBuffer(V86_ASSETS.kernel, (l, t) => setProgress({ label: "kernel (vmlinuz-virt)", pct: (l / t) * 100 })),
          fetchBuffer(V86_ASSETS.initrd, (l, t) =>
            setProgress({ label: "ubuntu rootfs (initramfs)", pct: (l / t) * 100 }),
          ),
        ]);
        if (dead) return;

        const V86 = await loadV86();
        if (dead) return;

        setPhase("booting");
        setProgress(null);
        pushBytes("v86: x86 machine armed — seabios posts, kernel 6.6.14-virt + ubuntu userspace loading\r\n");

        // hidden screen container — the emulator wants a DOM target even headless
        const screen = document.createElement("div");
        screen.style.display = "none";
        const txt = document.createElement("div");
        const cnv = document.createElement("div");
        screen.appendChild(txt);
        screen.appendChild(cnv);
        document.body.appendChild(screen);

        emu = new V86({
          // the wasm comes down OUR pipe too — retries + the jsdelivr mirror,
          // so an unreachable /vm/v86.wasm can never silently kill the boot
          wasm_fn: async (imports: Record<string, unknown>) => {
            const buf = await fetchBuffer("/vm/v86.wasm", () => undefined, `${V86_CDN}/build/v86.wasm`);
            const { instance } = await WebAssembly.instantiate(buf, imports as unknown as WebAssembly.Imports);
            return instance.exports;
          },
          memory_size: 512 * 1024 * 1024,
          vga_memory_size: 8 * 1024 * 1024,
          screen_container: screen,
          bios: { buffer: bios },
          vga_bios: { buffer: vgabios },
          bzimage: { buffer: kernel },
          initrd: { buffer: initrd },
          cmdline: `console=ttyS0 hostname=${host}`,
          acpi: false,
          autostart: true,
        });
        emuRef.current = emu;
        // debug/ops handle — lets the console be poked from devtools
        (window as unknown as { __murkeV86?: V86Instance }).__murkeV86 = emu;

        emu.bus.register("serial0-output-byte", (payload) => {
          const byte = payload as number;
          if (typeof byte !== "number") return;
          pushBytes(String.fromCharCode(byte));
          if (!liveRef.current) {
            // the /init banner marks a live userspace shell
            if (linesRef.current.join("\n").includes("murke vm -- Ubuntu")) {
              liveRef.current = true;
              setPhase("live");
              window.setTimeout(() => inputRef.current?.focus(), 60);
            }
          }
        });
        emu.bus.register("emulator-crashed", () => {
          if (dead) return;
          pushBytes("\r\n[ machine crashed — the simulated shell takes over ]\r\n");
          onFallback("emulator crashed");
        });
        emu.bus.register("download-error", () => undefined);
      } catch (e) {
        if (dead) return;
        const msg = e instanceof Error ? e.message : "unknown boot error";
        pushBytes(`\r\n[ the machine could not start: ${msg} ]\r\n`);
        setLoadErr(msg);
      }
    })();

    return () => {
      dead = true;
      try {
        emu?.destroy();
      } catch {
        /* ignore */
      }
      emuRef.current = null;
    };
  }, [attempt, host, pushBytes, onFallback]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, phase]);

  const send = useCallback((data: string) => {
    const emu = emuRef.current;
    if (!emu) return;
    if (typeof emu.serial0_send === "function") emu.serial0_send(data);
    else if (emu.serial_send_bytes) {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      emu.serial_send_bytes(0, bytes);
    }
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!emuRef.current) return;
    const k = e.key;
    let out: string | null = null;
    if (k === "Enter") out = "\r";
    else if (k === "Backspace") out = "\x7f";
    else if (k === "Tab") out = "\t";
    else if (e.ctrlKey && k.toLowerCase() === "c") out = "\x03";
    else if (e.ctrlKey && k.toLowerCase() === "d") out = "\x04";
    else if (e.ctrlKey && k.toLowerCase() === "l") out = "\x0c";
    else if (e.ctrlKey && k.toLowerCase() === "u") out = "\x15";
    else if (e.ctrlKey && k.toLowerCase() === "w") out = "\x17";
    else if (k === "ArrowUp") out = "\x1b[A";
    else if (k === "ArrowDown") out = "\x1b[B";
    else if (k === "ArrowRight") out = "\x1b[C";
    else if (k === "ArrowLeft") out = "\x1b[D";
    else if (k === "Home") out = "\x1b[H";
    else if (k === "End") out = "\x1b[F";
    else if (k === "Escape") out = "\x1b";
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) out = k;

    if (out !== null) {
      e.preventDefault();
      send(out);
      // local echo for the visible input line is OFF — the guest shell
      // echoes over serial itself (real terminal semantics)
      setInput("");
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="murke-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 pt-2 leading-[1.42]"
        aria-live="polite"
        onClick={() => inputRef.current?.focus()}
      >
        <pre className="whitespace-pre-wrap break-words">{text || " "}</pre>
        {phase === "live" && (
          <pre className="whitespace-pre-wrap">
            {/* the guest shell echoes its own prompt over serial — this is
                just the caret so typing feels attached to the console */}
            <span className="ml-px inline-block h-[1.05em] w-[0.6em] translate-y-[0.18em] animate-pulse bg-[#e8e4dd]" aria-hidden="true" />
          </pre>
        )}
      </div>

      {/* load/boot overlay */}
      {(phase === "loading" || phase === "booting") && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#16100c]/94 px-6 text-center">
          <div className="text-[13px] font-bold tracking-[0.2em] text-[#e95420]">
            {loadErr ? "MACHINE UNREACHABLE" : phase === "loading" ? "FETCHING DISKS" : "POWERING ON"}
          </div>
          {loadErr ? (
            <>
              <p className="max-w-[420px] font-mono text-[11px] leading-relaxed text-[#f0704a]">{loadErr}</p>
              <p className="max-w-[420px] text-[10.5px] leading-relaxed text-[#9d9a92]">
                the vm disks live on this site (/vm/*) — a school filter, vpn or the cdn can block them. retries + a
                mirror were tried already.
              </p>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    liveRef.current = false;
                    linesRef.current = [];
                    setText("");
                    setAttempt((n) => n + 1);
                  }}
                  className="cursor-pointer rounded border border-[#e95420]/50 px-3 py-1.5 text-[11px] text-[#e8e4dd] transition-colors hover:bg-[#e95420]/15"
                >
                  retry boot
                </button>
                <button
                  type="button"
                  onClick={() => onFallback(loadErr)}
                  className="cursor-pointer rounded border border-white/15 px-3 py-1.5 text-[11px] text-[#9d9a92] transition-colors hover:bg-white/10"
                >
                  use simulated shell
                </button>
              </div>
            </>
          ) : progress ? (
            <>
              <div className="h-1.5 w-56 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-[#e95420] transition-[width] duration-150" style={{ width: `${Math.min(100, progress.pct)}%` }} />
              </div>
              <div className="text-[10.5px] text-[#9d9a92]">
                {progress.label} — {Math.round(progress.pct)}%
              </div>
            </>
          ) : (
            <div className="animate-pulse text-[10.5px] text-[#9d9a92]">seabios posts · kernel decompresses · systemd-less init runs…</div>
          )}
          {!loadErr && <div className="text-[10px] text-[#9d9a92]">the whole pc runs in your browser — first boot takes a little while</div>}
        </div>
      )}

      {phase === "dead" && <div className="px-3 pb-2 text-[10.5px] text-[#f0704a]">the machine is off — close and reopen the console</div>}

      {/* capture input — keystrokes ride the emulated COM port */}
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={() => undefined}
        onKeyDown={onKeyDown}
        aria-label="vm serial console input"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="pointer-events-none absolute inset-0 z-0 h-full w-full cursor-default bg-transparent text-base text-transparent opacity-0 outline-none"
        style={{ caretColor: "transparent" }}
      />
    </div>
  );
});

/* ================= SIMULATED MODE (fallback) ================= */

const BOOT_LINES: Array<{ text: string; cls?: keyof typeof CLS }> = [
  { text: "[  0.000000] Linux version 6.8.0-45-generic (buildd@vercel) #45-Ubuntu SMP PREEMPT_DYNAMIC" },
  { text: "[  0.512733] virtio_blk virtio2: [vda] 25165824 512-byte logical blocks (12.9 GB)" },
  { text: "[  0.719812] EXT4-fs (vda2): mounted filesystem with ordered data mode" },
  { text: "[  0.902441] systemd[1]: Detected virtualization kvm." },
  { text: "[  0.903875] systemd[1]: Detected architecture x86-64." },
  { text: "[  OK  ] Started Journal Service.", cls: "ok" },
  { text: "[  OK  ] Reached target Local File Systems.", cls: "ok" },
  { text: "[  OK  ] Started Network Configuration.", cls: "ok" },
  { text: "[  OK  ] Started OpenBSD Secure Shell server.", cls: "ok" },
  { text: "[  OK  ] Reached target Multi-User System.", cls: "ok" },
  { text: "[  OK  ] Reached target Graphical Interface.", cls: "ok" },
];

const MOTD = [
  "Welcome to Ubuntu 24.04 LTS (GNU/Linux 6.8.0-45-generic x86_64)",
  "",
  " * Documentation:  https://help.ubuntu.com",
  " * Support:        https://ubuntu.com/pro",
  "",
  "System information as of right now:",
];

interface SimLine {
  id: number;
  text: string;
  cls?: keyof typeof CLS;
  html?: string;
}

const SEED_FILES: Record<string, string> = {
  "/home/ubuntu/README.md":
    "# vm\n\nthis machine lives on the vercel edge.\nprovisioned through the murke terminal.\n\nwrite things with `echo \"text\" > file.txt`\n",
  "/etc/hostname": "vm\n",
  "/etc/os-release": 'PRETTY_NAME="Ubuntu 24.04 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n',
};

const SimConsole = memo(function SimConsole({ host, ip, size }: { host: string; ip: string; size: string }) {
  const [lines, setLines] = useState<SimLine[]>([]);
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<"boot" | "live">("boot");
  const [sudoMode, setSudoMode] = useState(false);
  const [files, setFiles] = useState<Record<string, string>>({ ...SEED_FILES });
  const [cwd, setCwd] = useState("/home/ubuntu");
  const [hist, setHist] = useState<string[]>([]);
  const idRef = useRef(1);
  const bootStartRef = useRef(Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const histIdxRef = useRef<number | null>(null);

  const print = useCallback((text = "", cls?: keyof typeof CLS) => {
    setLines((prev) => {
      const next = [...prev, { id: idRef.current++, text, cls }];
      return next.length > 900 ? next.slice(next.length - 700) : next;
    });
  }, []);

  const printHTMLLine = useCallback((html: string) => {
    setLines((prev) => [...prev, { id: idRef.current++, text: "", html }]);
  }, []);

  const runBoot = useCallback(() => {
    setPhase("boot");
    bootStartRef.current = Date.now();
    setLines([]);
    let i = 0;
    const step = () => {
      if (i < BOOT_LINES.length) {
        const b = BOOT_LINES[i++];
        print(b.text, b.cls);
        window.setTimeout(step, 70 + Math.random() * 90);
        return;
      }
      print("", "dim");
      print(`Ubuntu 24.04 LTS ${host} tty1`, "dim");
      print("", "dim");
      print(`${host} login: ubuntu (automatic login)`, "dim");
      print("", "dim");
      for (const l of MOTD) print(l, l.startsWith("  ") ? "dim" : undefined);
      print(`  ${host}: ${ip}`, "dim");
      print("", "dim");
      print("Last login: just now from the murke terminal", "dim");
      print("type `help` for the guest-vm command list", "dim");
      print("", "dim");
      setPhase("live");
      window.setTimeout(() => inputRef.current?.focus(), 40);
    };
    window.setTimeout(step, 120);
  }, [host, ip, print]);

  useEffect(() => {
    runBoot();
  }, [runBoot]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, input, phase]);

  const resolvePath = useCallback(
    (p: string): string => {
      if (!p) return cwd;
      const abs = p.startsWith("/") ? p : `${cwd}/${p}`;
      const parts: string[] = [];
      for (const seg of abs.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
      }
      return "/" + parts.join("/");
    },
    [cwd],
  );

  const shortCwd = cwd.startsWith("/home/ubuntu") ? "~" + cwd.slice("/home/ubuntu".length) : cwd;

  const run = useCallback(
    async (raw: string) => {
      const line = raw.trim();
      print(`ubuntu@${host}:${shortCwd}$ ${line}`);
      if (!line) return;
      setHist((h) => (h[h.length - 1] === line ? h : [...h, line].slice(-100)));
      histIdxRef.current = null;

      let asSudo = false;
      let body = line;
      if (body.startsWith("sudo ")) {
        asSudo = true;
        body = body.slice(5).trim();
        if (!body) {
          print("usage: sudo <command>", "dim");
          return;
        }
        print(`[sudo] password for ubuntu: ********`, "dim");
        setSudoMode(true);
      }
      const [cmd, ...args] = body.split(/\s+/);
      const arg = args.join(" ");
      const stop = () => {
        if (asSudo) setSudoMode(false);
      };

      switch (cmd) {
        case "help":
          print("guest vm — ubuntu 24.04 lts (simulated console)", "brand");
          for (const l of [
            "ls · cd · pwd · cat <file> · echo <text> [> file]",
            "mkdir <dir> · touch <file> · rm <file>",
            "whoami · uname [-a] · uptime · free [-h] · df [-h]",
            "apt update | apt install <pkg> · ps · top",
            "neofetch · history · clear · sudo <cmd>",
            "reboot · poweroff · exit",
          ])
            print("  " + l, "dim");
          stop();
          return;
        case "ls": {
          const target = resolvePath(arg || ".");
          const keys = Object.keys(files).filter((k) => (target === "/" ? true : k === target || k.startsWith(target + "/")));
          if (keys.length === 0 && arg && !arg.startsWith("-")) {
            print(`ls: cannot access '${arg}': No such file or directory`, "err");
            stop();
            return;
          }
          const depth = target === "/" ? 1 : target.split("/").length + 1;
          const names = new Set<string>();
          for (const k of keys) {
            const rel = k.slice(target === "/" ? 1 : target.length + 1);
            if (!rel) continue;
            names.add(rel.split("/")[0] + (k.split("/").length > depth ? "/" : ""));
          }
          if (names.size === 0) print("", "dim");
          else print([...names].sort().join("   "));
          stop();
          return;
        }
        case "cd": {
          const t = resolvePath(arg || "/home/ubuntu");
          if (t === "/etc" || t === "/" || Object.keys(files).some((k) => k === t || k.startsWith(t + "/"))) setCwd(t === "/" ? "/" : t);
          else print(`cd: ${arg}: No such file or directory`, "err");
          stop();
          return;
        }
        case "pwd":
          print(cwd);
          stop();
          return;
        case "whoami":
          print(asSudo ? "root" : "ubuntu");
          stop();
          return;
        case "cat": {
          const t = resolvePath(arg);
          const c = files[t];
          if (c === undefined) print(`cat: ${arg}: No such file or directory`, "err");
          else for (const l of c.split("\n")) print(l);
          stop();
          return;
        }
        case "echo": {
          const m = /^(.*?)\s*>\s*(\S+)$/.exec(arg);
          if (m) {
            const content = m[1].replace(/^["']|["']$/g, "");
            const t = resolvePath(m[2]);
            setFiles((f) => ({ ...f, [t]: content + "\n" }));
            return;
          }
          print(arg.replace(/^["']|["']$/g, ""));
          stop();
          return;
        }
        case "touch": {
          const t = resolvePath(arg);
          if (!arg) print("touch: missing file operand", "err");
          else setFiles((f) => (f[t] === undefined ? { ...f, [t]: "" } : f));
          return;
        }
        case "mkdir": {
          const t = resolvePath(arg.replace(/^-p\s*/, ""));
          if (!t || t === "/") print("mkdir: missing operand", "err");
          else setFiles((f) => ({ ...f, [t + "/.keep"]: "" }));
          return;
        }
        case "rm": {
          const t = resolvePath(arg.replace(/^-[rf]+\s*/g, ""));
          if (!arg) print("rm: missing operand", "err");
          else {
            setFiles((f) => {
              const n = { ...f };
              for (const k of Object.keys(n)) if (k === t || k.startsWith(t + "/")) delete n[k];
              return n;
            });
          }
          return;
        }
        case "uname":
          print(
            args.includes("-a")
              ? `Linux ${host} 6.8.0-45-generic #45-Ubuntu SMP PREEMPT_DYNAMIC x86_64 x86_64 x86_64 GNU/Linux`
              : "Linux",
          );
          stop();
          return;
        case "uptime": {
          const s = Math.max(1, Math.floor((Date.now() - bootStartRef.current) / 1000));
          print(` up ${s < 60 ? `${s} sec` : `${Math.floor(s / 60)} min`},  1 user,  load average: 0.08, 0.03, 0.01`);
          stop();
          return;
        }
        case "free":
          print("               total        used        free      shared  available");
          print("Mem:            981Mi       138Mi       612Mi       1.0Mi       843Mi");
          print("Swap:             0B          0B          0B");
          stop();
          return;
        case "df":
          print("Filesystem     1K-blocks    Used Available Use% Mounted on");
          print("/dev/vda2       12415092  770512 11008932   7% /");
          print("tmpfs             502940       0   502940   0% /dev/shm");
          stop();
          return;
        case "ps":
          print("    PID TTY          TIME CMD");
          print("   1842 pts/0    00:00:00 bash");
          print("   1901 pts/0    00:00:00 ps");
          stop();
          return;
        case "top":
        case "htop":
          print("Tasks: 112 total,   1 running, 111 sleeping");
          print("    PID USER      PR  NI    VIRT    RES  %CPU  %MEM  COMMAND", "dim");
          print("   1128 root      20   0   31240  18400   0.6   1.8  node agent");
          print("      1 root      20   0   16720  10240   0.0   1.0  systemd");
          stop();
          return;
        case "apt": {
          const sub = args[0] ?? "";
          if (sub === "update") {
            print("Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease", "dim");
            print("Reading package lists... Done", "dim");
            print("All packages are up to date.", "ok");
            stop();
            return;
          }
          if (sub === "install") {
            const pkg = args[1];
            if (!pkg) {
              print("apt install: name a package — `apt install htop`", "err");
              stop();
              return;
            }
            print("Reading package lists... Done", "dim");
            await new Promise((r) => setTimeout(r, 420));
            print(`The following NEW packages will be installed:\n  ${pkg}`);
            await new Promise((r) => setTimeout(r, 520));
            print(`Setting up ${pkg} ...`, "dim");
            print(`${pkg} is installed — run it by name.`, "ok");
            stop();
            return;
          }
          print("apt: try `apt update` or `apt install <pkg>`", "err");
          stop();
          return;
        }
        case "neofetch": {
          void (async () => {
            const O = "#e95420";
            const D = "#772953";
            const art = ["         _", "     ---(_)", " _/  ---  \\", "(_) |   |", "  \\  --- _/", "     ---(_)"];
            const info = [
              `ubuntu@${host}`,
              "─────────────",
              "OS: Ubuntu 24.04 LTS x86_64",
              `Host: Vercel Edge VM (${size})`,
              "Kernel: 6.8.0-45-generic",
              `Uptime: ${Math.max(1, Math.floor((Date.now() - bootStartRef.current) / 1000))}s`,
              "Packages: 612 (dpkg)",
              "Shell: bash 5.2.21",
              "Terminal: murke console",
              "CPU: shared vCPU (2) @ 3.0GHz",
              "Memory: 138MiB / 981MiB",
            ];
            const rows = Math.max(art.length, info.length);
            for (let i = 0; i < rows; i++) {
              const a = (art[i] ?? "").padEnd(14);
              const b = info[i] ?? "";
              printHTMLLine(
                `<span style="color:${i < 2 ? O : D}">${a.replace(/ /g, "&nbsp;")}</span><span style="color:var(--term-fg)">${b.replace(/</g, "&lt;")}</span>`,
              );
              await new Promise((r) => setTimeout(r, 30));
            }
          })();
          stop();
          return;
        }
        case "history":
          for (let i = 0; i < hist.length; i++) print(`  ${String(i + 1).padStart(3)}  ${hist[i]}`, "dim");
          stop();
          return;
        case "clear":
          setLines([]);
          stop();
          return;
        case "reboot":
          print("Broadcast message: The system is going down for reboot NOW!", "warn");
          await new Promise((r) => setTimeout(r, 700));
          runBoot();
          return;
        case "poweroff":
        case "shutdown":
        case "halt": {
          print("Broadcast message: The system is going down for poweroff NOW!", "warn");
          await new Promise((r) => setTimeout(r, 700));
          patchVm(host, { status: "stopped" });
          print("[  OK  ] System halted. Close the console or `vm open` to boot again.", "dim");
          return;
        }
        case "exit":
          print("logout — the machine keeps running in the background", "dim");
          return;
        default:
          print(`${cmd}: command not found — 'help' lists the guest commands`, "err");
          stop();
          return;
      }
    },
    [files, cwd, hist, host, print, printHTMLLine, resolvePath, shortCwd, runBoot],
  );

  const submit = () => {
    const v = input;
    setInput("");
    void run(v);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
      return;
    }
    if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      setLines([]);
      return;
    }
    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      print(`ubuntu@${host}:${shortCwd}$ ${input}^C`);
      setInput("");
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (hist.length === 0) return;
      const idx = histIdxRef.current === null ? hist.length - 1 : Math.max(0, histIdxRef.current - 1);
      histIdxRef.current = idx;
      setInput(hist[idx]);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdxRef.current === null) return;
      const idx = Math.min(hist.length, histIdxRef.current + 1);
      if (idx === hist.length) {
        histIdxRef.current = null;
        setInput("");
      } else {
        histIdxRef.current = idx;
        setInput(hist[idx]);
      }
    }
  };

  const prompt = `${sudoMode ? "root" : "ubuntu"}@${host}:${sudoMode ? cwd.replace("/home/ubuntu", "~") : shortCwd}${sudoMode ? "#" : "$"}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="murke-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 pt-2 leading-[1.42]"
        aria-live="polite"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((l) =>
          l.html !== undefined ? (
            <pre key={l.id} className="whitespace-pre-wrap break-words" dangerouslySetInnerHTML={{ __html: l.html }} />
          ) : (
            <pre key={l.id} className={`whitespace-pre-wrap break-words ${l.cls ? CLS[l.cls] : ""}`}>
              {l.text || " "}
            </pre>
          ),
        )}
      </div>

      {phase === "live" && (
        <div
          className="border-t border-[#e95420]/20 bg-[#1b130f]/95 px-3 pb-2 pt-1.5 leading-[1.42]"
          onClick={() => inputRef.current?.focus()}
        >
          <pre className="whitespace-pre-wrap break-words">
            <span className={sudoMode ? "text-[#e3b341] font-bold" : "text-[#4ec9b0] font-bold"}>{prompt}</span> <span>{input}</span>
            <span className="ml-px inline-block h-[1.05em] w-[0.6em] translate-y-[0.18em] animate-pulse bg-[#e8e4dd]" aria-hidden="true" />
          </pre>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label="vm console input"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="pointer-events-none absolute inset-0 h-full w-full cursor-default bg-transparent text-base text-transparent opacity-0 outline-none"
            style={{ caretColor: "transparent" }}
          />
        </div>
      )}
    </div>
  );
});
