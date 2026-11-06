"use client";

/**
 * SystemTray — the REAL status cluster, measured not guessed:
 *
 *  - wifi: Network Information API (UA estimate) PLUS live probes — a
 *    204 ping timed 5× (median + jitter = actual round-trip to this
 *    server), a known-size transfer timed end-to-end (actual throughput),
 *    and a server-side ipwho.is lookup of the CALLER's forwarded ip
 *    (actual public ip / isp / location). The icon tiers read the
 *    measured latency when we have it, the UA estimate when we don't.
 *  - battery: Battery Status API (level, charging, charge/discharge
 *    estimates) drawn as a custom pill with the PERCENT INSIDE the
 *    battery body — the old icon+text pair wrapped into two 24px lines
 *    and poked out of the 28px menu bar (the "top bar broken" bug).
 *  - bluetooth: the PWA way — navigator.bluetooth.requestDevice, the
 *    browser's own device picker, which is exactly as funny as it sounds.
 *
 * Every item pops a glass sheet with the live values. Everything degrades
 * honestly: no SSID (the platform hides it), battery only where the UA
 * ships the API (Chromium), bluetooth needs the secure context + gesture.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bluetooth,
  EthernetPort,
  RefreshCw,
  Wifi,
  WifiHigh,
  WifiLow,
  WifiZero,
  WifiOff,
} from "lucide-react";

/* ------------------------------ hooks ------------------------------ */

interface NetworkInfo {
  online: boolean;
  /** "slow-2g" | "2g" | "3g" | "4g" — the UA's own estimate */
  effectiveType: string | null;
  /** megabits/sec estimate */
  downlink: number | null;
  /** round-trip time estimate, ms */
  rtt: number | null;
  /** "wifi" | "cellular" | "ethernet" | … when the UA tells us */
  type: string | null;
  supported: boolean;
}

function useNetwork(): NetworkInfo {
  const [info, setInfo] = useState<NetworkInfo>(() => {
    const c = typeof navigator !== "undefined" ? (navigator as Navigator & { connection?: unknown }).connection : null;
    return {
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      effectiveType: null,
      downlink: null,
      rtt: null,
      type: null,
      supported: Boolean(c),
    };
  });

  useEffect(() => {
    const read = () => {
      const c = (navigator as Navigator & {
        connection?: { effectiveType?: string; downlink?: number; rtt?: number; type?: string };
      }).connection;
      const next: NetworkInfo = {
        online: navigator.onLine,
        effectiveType: c?.effectiveType ?? null,
        downlink: typeof c?.downlink === "number" ? c.downlink : null,
        rtt: typeof c?.rtt === "number" ? c.rtt : null,
        type: c?.type ?? null,
        supported: Boolean(c),
      };
      /* only re-render when something actually changed (the api fires
         change events and we also poll — no point churning the bar) */
      setInfo((prev) =>
        prev.online === next.online &&
        prev.effectiveType === next.effectiveType &&
        prev.downlink === next.downlink &&
        prev.rtt === next.rtt &&
        prev.type === next.type &&
        prev.supported === next.supported
          ? prev
          : next,
      );
    };
    read();
    const c = (navigator as Navigator & { connection?: EventTarget }).connection;
    c?.addEventListener?.("change", read);
    window.addEventListener("online", read);
    window.addEventListener("offline", read);
    const iv = window.setInterval(read, 15000);
    return () => {
      c?.removeEventListener?.("change", read);
      window.removeEventListener("online", read);
      window.removeEventListener("offline", read);
      window.clearInterval(iv);
    };
  }, []);

  return info;
}

/* --------------------- real-measurement probes --------------------- */

interface NetIdentity {
  ok: boolean;
  ip: string | null;
  isp: string | null;
  org: string | null;
  asn: number | null;
  city: string | null;
  region: string | null;
  country: string | null;
  scope: "visitor" | "server";
  ts: number;
}

/** /api/net/info is cached server-side; mirror that here so re-mounting
    the tray (skin swaps, hot reloads) never re-hammers the lookup */
let infoCache: { at: number; data: NetIdentity } | null = null;
let infoInFlight = false;
const INFO_TTL = 10 * 60 * 1000;

interface ProbeState {
  /** median round-trip to this server, ms — measured, not estimated */
  latencyMs: number | null;
  /** mean |Δ| between consecutive samples, ms */
  jitterMs: number | null;
  latencyAt: number;
  /** measured download throughput to this server, Mb/s */
  mbps: number | null;
  mbpsKb: number;
  mbpsAt: number;
  downBusy: boolean;
  info: NetIdentity | null;
  probeLatency: () => Promise<void>;
  probeThroughput: (kb?: number) => Promise<void>;
  ensureInfo: (force?: boolean) => Promise<void>;
}

function useNetProbes(): ProbeState {
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [jitterMs, setJitterMs] = useState<number | null>(null);
  const [latencyAt, setLatencyAt] = useState(0);
  const [mbps, setMbps] = useState<number | null>(null);
  const [mbpsKb, setMbpsKb] = useState(0);
  const [mbpsAt, setMbpsAt] = useState(0);
  const [downBusy, setDownBusy] = useState(false);
  const [info, setInfo] = useState<NetIdentity | null>(null);

  const latBusy = useRef(false);
  const downBusyRef = useRef(false);

  /** 204 ping × (1 warmup + 4 timed) → median + jitter. The warmup soaks
      connection setup so the samples are pure path latency. */
  const probeLatency = useCallback(async () => {
    if (latBusy.current) return;
    latBusy.current = true;
    try {
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const res = await fetch(`/api/net/ping?t=${Date.now()}-${i}`, { cache: "no-store" });
        await res.arrayBuffer();
        if (i > 0) samples.push(performance.now() - t0);
      }
      if (samples.length) {
        const sorted = [...samples].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        /* median absolute deviation — a single GC pause or a spiky first
           sample can't poison it the way a plain mean can */
        const dev = samples.map((s) => Math.abs(s - med)).sort((a, b) => a - b);
        const mad = dev[Math.floor(dev.length / 2)];
        setLatencyMs(med);
        setJitterMs(mad);
        setLatencyAt(Date.now());
      }
    } catch {
      /* offline / blocked — keep the last good numbers */
    } finally {
      latBusy.current = false;
    }
  }, []);

  /** timed transfer of a known-size payload → real Mb/s to this server */
  const probeThroughput = useCallback(async (kb = 256) => {
    if (downBusyRef.current) return;
    downBusyRef.current = true;
    setDownBusy(true);
    try {
      const t0 = performance.now();
      const res = await fetch(`/api/net/down?kb=${kb}&t=${Date.now()}`, { cache: "no-store" });
      const buf = await res.arrayBuffer();
      const ms = performance.now() - t0;
      if (buf.byteLength > 0 && ms > 0) {
        setMbps((buf.byteLength * 8) / (ms / 1000) / 1e6);
        setMbpsKb(kb);
        setMbpsAt(Date.now());
      }
    } catch {
      /* keep the last good number */
    } finally {
      downBusyRef.current = false;
      setDownBusy(false);
    }
  }, []);

  /** caller's public ip / isp / location (server resolves the forwarded ip) */
  const ensureInfo = useCallback(async (force = false) => {
    if (!force && infoCache && Date.now() - infoCache.at < INFO_TTL) {
      setInfo(infoCache.data);
      return;
    }
    if (infoInFlight) return;
    infoInFlight = true;
    try {
      const res = await fetch(`/api/net/info?t=${Date.now()}`, { cache: "no-store" });
      const data = (await res.json()) as NetIdentity;
      infoCache = { at: Date.now(), data };
      setInfo(data);
    } catch {
      /* leave whatever we had */
    } finally {
      infoInFlight = false;
    }
  }, []);

  /* latency is cheap — auto-probe on mount, every 30s, and on reconnect.
     throughput + identity are heavier: throughput once on mount (a single
     256 kb transfer) then on demand; identity on first sheet open. */
  useEffect(() => {
    void probeLatency();
    const t = window.setTimeout(() => void probeThroughput(256), 1200);
    const iv = window.setInterval(() => void probeLatency(), 30000);
    const onUp = () => void probeLatency();
    window.addEventListener("online", onUp);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(iv);
      window.removeEventListener("online", onUp);
    };
  }, [probeLatency, probeThroughput]);

  return { latencyMs, jitterMs, latencyAt, mbps, mbpsKb, mbpsAt, downBusy, info, probeLatency, probeThroughput, ensureInfo };
}

interface BatteryInfo {
  supported: boolean;
  level: number | null; // 0..1
  charging: boolean | null;
  /** seconds to full / empty, when the UA provides them */
  chargingTime: number | null;
  dischargingTime: number | null;
}

function useBattery(): BatteryInfo {
  const [info, setInfo] = useState<BatteryInfo>({ supported: false, level: null, charging: null, chargingTime: null, dischargingTime: null });

  useEffect(() => {
    type BatteryManager = EventTarget & {
      level: number;
      charging: boolean;
      chargingTime: number;
      dischargingTime: number;
    };
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
    if (!nav.getBattery) return;
    let dead = false;
    let bat: BatteryManager | null = null;
    const read = () => {
      if (!bat || dead) return;
      setInfo({
        supported: true,
        level: bat.level,
        charging: bat.charging,
        chargingTime: Number.isFinite(bat.chargingTime) && bat.chargingTime > 0 ? bat.chargingTime : null,
        dischargingTime: Number.isFinite(bat.dischargingTime) && bat.dischargingTime > 0 ? bat.dischargingTime : null,
      });
    };
    void nav
      .getBattery()
      .then((b) => {
        if (dead) return;
        bat = b;
        read();
        b.addEventListener("levelchange", read);
        b.addEventListener("chargingchange", read);
        b.addEventListener("chargingtimechange", read);
        b.addEventListener("dischargingtimechange", read);
      })
      .catch(() => undefined);
    return () => {
      dead = true;
      if (bat) {
        bat.removeEventListener("levelchange", read);
        bat.removeEventListener("chargingchange", read);
        bat.removeEventListener("chargingtimechange", read);
        bat.removeEventListener("dischargingtimechange", read);
      }
    };
  }, []);

  return info;
}

/* --------------------------- presentation --------------------------- */

function hhmm(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** the wifi/ethernet icon — REAL wifi arcs (the old cellular-bar Signal*
    glyphs read as garbage at 13px), tiered by MEASURED latency when we
    have a probe, the UA's own estimates as the fallback */
export function NetIcon({
  net,
  latencyMs,
  size = 13,
}: {
  net: NetworkInfo;
  latencyMs?: number | null;
  size?: number;
}) {
  if (!net.online) return <WifiOff size={size} aria-hidden="true" />;
  if (net.type === "ethernet") return <EthernetPort size={size} aria-hidden="true" />;
  const q = (() => {
    if (typeof latencyMs === "number") {
      /* real path latency: fast → strong, slow → weak, never "zero" while online */
      if (latencyMs <= 55) return 3;
      if (latencyMs <= 130) return 2;
      return 1;
    }
    /* fallback: the UA's coarse estimate */
    if (net.effectiveType === "4g" && (net.downlink ?? 0) >= 8) return 3;
    if (net.effectiveType === "4g" || (net.downlink ?? 0) >= 2.5) return 2;
    if (net.effectiveType === "3g" || (net.downlink ?? 0) > 0) return 1;
    return 0;
  })();
  const Icon = q >= 3 ? Wifi : q === 2 ? WifiHigh : q === 1 ? WifiLow : WifiZero;
  return <Icon size={size} aria-hidden="true" />;
}

/**
 * BatteryPill — the battery AS the readout: outline + nub, a level fill,
 * and the percentage INSIDE the body (bolt inside when charging — the
 * sheet and tooltip carry the number then). Custom SVG because no icon
 * font ships "text inside a battery", and because the old lucide-icon +
 * side-text pair was what overflowed the menu bar.
 */
export function BatteryPill({
  level,
  charging,
  size = 14,
}: {
  level: number;
  charging: boolean;
  size?: number;
}) {
  const W = 34;
  const H = 16;
  const pct = Math.round(Math.min(1, Math.max(0, level)) * 100);
  const low = pct < 20 && !charging;

  const stroke = low ? "var(--term-err)" : "var(--term-fg)";
  const fill = charging ? "var(--term-brand)" : low ? "var(--term-err)" : "var(--term-fg)";
  const fillW = Math.max(1.6, 25.8 * Math.min(1, Math.max(0.02, level)));

  return (
    <svg
      width={(W / H) * size}
      height={size}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      {/* nub */}
      <rect x="31.3" y="5.8" width="2.1" height="4.4" rx="1" fill={stroke} fillOpacity={low ? 0.85 : 0.6} />
      {/* body outline */}
      <rect
        x="0.7"
        y="1.7"
        width="29.6"
        height="12.6"
        rx="3.8"
        fill="none"
        stroke={stroke}
        strokeOpacity={low ? 0.85 : 0.6}
        strokeWidth="1.4"
      />
      {/* level fill */}
      {level > 0.015 && (
        <rect
          x="2.6"
          y="3.6"
          width={fillW}
          height="8.8"
          rx="1.9"
          fill={fill}
          fillOpacity={charging ? 0.85 : low ? 0.5 : 0.26}
        />
      )}
      {charging ? (
        <>
          {/* bolt at the left + digits beside it — percent stays visible
              even while charging (just without the % sign to make room) */}
          <path d="M8.9 3.2 L4.6 8.4 L7.4 8.4 L6.2 12.8 L10.6 7.5 L7.7 7.5 Z" fill={fill} fillOpacity={0.95} />
          <text
            x="19.4"
            y="11.4"
            textAnchor="middle"
            fontSize="8.8"
            fontWeight="650"
            fill={stroke}
            style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", userSelect: "none" }}
          >
            {pct}
          </text>
        </>
      ) : (
        <text
          x="15.5"
          y="11.4"
          textAnchor="middle"
          fontSize="8.8"
          fontWeight="650"
          fill={stroke}
          style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", userSelect: "none" }}
        >
          {pct}%
        </text>
      )}
    </svg>
  );
}

function sheetStyle(): React.CSSProperties {
  return {
    background: "color-mix(in srgb, var(--term-bg) 88%, transparent)",
    backdropFilter: "blur(26px) saturate(1.5)",
    WebkitBackdropFilter: "blur(26px) saturate(1.5)",
    boxShadow: "0 20px 55px -12px rgba(0,0,0,0.55), inset 0 0 0 1px color-mix(in srgb, var(--term-fg) 12%, transparent)",
  };
}

/* ------------------------------ tray ------------------------------ */

export interface TrayItemProps {
  /** visual density — the mac menubar wants 13px, the windows tray 14px */
  size?: number;
  /** which way the sheet pops — the menu bar drops down, the taskbar flips up */
  drop?: "down" | "up";
}

/** one shared glass popover wrapper */
function TraySheet({
  open,
  onClose,
  align,
  drop = "down",
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  align: "left" | "right";
  drop?: "down" | "up";
  label: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`absolute z-[96] w-64 rounded-2xl p-3.5 text-[12px] ${drop === "down" ? "top-full mt-2" : "bottom-full mb-2"}`}
      style={{ ...sheetStyle(), [align === "right" ? "right" : "left"]: 0 }}
    >
      {children}
    </div>
  );
}

const rowCls = "flex items-center justify-between gap-3 py-1";
const rowKey = "text-[11px] text-[var(--term-dim)]";
const rowVal = "text-[11.5px] text-[var(--term-fg)] text-right";

/** wifi — the real connection: measured latency + throughput + identity */
export function TrayWifi({ size = 13, sheetAlign = "right", drop = "down" }: TrayItemProps & { sheetAlign?: "left" | "right" }) {
  const net = useNetwork();
  const { latencyMs, jitterMs, mbps, mbpsKb, downBusy, info, probeLatency, probeThroughput, ensureInfo } = useNetProbes();
  const [open, setOpen] = useState(false);
  const [retest, setRetest] = useState(false);

  const onToggle = useCallback(() => {
    setOpen((o) => {
      const next = !o;
      if (next) {
        void probeLatency();
        void ensureInfo();
        /* refresh a stale throughput number, never re-burn bandwidth for a fresh one */
        if (mbps === null) void probeThroughput(256);
      }
      return next;
    });
  }, [probeLatency, ensureInfo, probeThroughput, mbps]);

  const runRetest = useCallback(() => {
    setRetest(true);
    void probeLatency().then(() => setRetest(false));
    void probeThroughput(384);
    void ensureInfo(true);
  }, [probeLatency, probeThroughput, ensureInfo]);

  const title = !net.online
    ? "network: offline"
    : latencyMs !== null
      ? `network — ${Math.round(latencyMs)} ms round trip${mbps !== null ? ` · ${mbps.toFixed(1)} Mb/s` : ""}`
      : `${net.type === "ethernet" ? "ethernet" : "wifi"} — ${net.effectiveType ?? "connected"}`;

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`network: ${net.online ? "online" : "offline"}${latencyMs !== null ? `, ${Math.round(latencyMs)} ms` : ""}`}
        title={title}
        className={`flex shrink-0 cursor-pointer items-center justify-center px-1.5 py-1 leading-none transition-colors ${net.online ? "text-[var(--term-dim)] hover:text-[var(--term-fg)]" : "text-[var(--term-err)]"}`}
      >
        <NetIcon net={net} latencyMs={latencyMs} size={size} />
      </button>
      <TraySheet open={open} onClose={() => setOpen(false)} align={sheetAlign} drop={drop} label="network status">
        <div className="mb-2 flex items-center gap-2">
          <NetIcon net={net} latencyMs={latencyMs} size={15} />
          <span className="text-[12.5px] font-semibold text-[var(--term-fg)]">{net.online ? "wi-fi" : "offline"}</span>
          <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${net.online ? "text-[var(--term-brand)]" : "text-[var(--term-err)]"}`}>
            {net.online ? "connected" : "down"}
          </span>
        </div>
        <div className={rowCls}>
          <span className={rowKey}>round trip</span>
          <span className={rowVal}>
            {latencyMs !== null ? (
              <>
                {Math.round(latencyMs)} ms{jitterMs !== null && <span className="text-[var(--term-dim)]"> ± {Math.round(jitterMs)}</span>}
              </>
            ) : net.online ? (
              "measuring…"
            ) : (
              "—"
            )}
          </span>
        </div>
        <div className={rowCls}>
          <span className={rowKey}>throughput</span>
          <span className={rowVal}>
            {downBusy ? "testing…" : mbps !== null ? `${mbps.toFixed(1)} Mb/s` : net.online ? "—" : "—"}
          </span>
        </div>
        <div className={rowCls}>
          <span className={rowKey}>public ip</span>
          <span className={rowVal} title={info?.scope === "server" ? "server egress — the gateway hid your ip header" : "your ip, resolved server-side"}>
            {info?.ok && info.ip ? info.ip : "—"}
          </span>
        </div>
        {(info?.isp || info?.org) && (
          <div className={rowCls}>
            <span className={rowKey}>network</span>
            <span className={rowVal}>{info.isp || info.org}</span>
          </div>
        )}
        {(info?.city || info?.country) && (
          <div className={rowCls}>
            <span className={rowKey}>location</span>
            <span className={rowVal}>{[info.city, info.region, info.country].filter(Boolean).join(", ")}</span>
          </div>
        )}
        <div className={rowCls}>
          <span className={rowKey}>browser estimate</span>
          <span className="text-right text-[10.5px] text-[var(--term-dim)]">
            {net.effectiveType ?? "—"}
            {net.downlink !== null ? ` · ${net.downlink} Mb/s` : ""}
          </span>
        </div>
        <button
          type="button"
          onClick={runRetest}
          disabled={retest || downBusy}
          className="mt-2 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--term-fg)_18%,transparent)] py-1.5 text-[11.5px] text-[var(--term-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] disabled:cursor-default disabled:opacity-40"
        >
          <RefreshCw size={11} aria-hidden="true" className={retest || downBusy ? "animate-spin" : undefined} />
          {retest || downBusy ? "probing…" : "re-run probes"}
        </button>
        <p className="mt-2 border-t border-[color-mix(in_srgb,var(--term-fg)_10%,transparent)] pt-2 text-[10px] leading-relaxed text-[var(--term-dim)]">
          live: 204 ping ×4, timed {mbpsKb || 256} kb transfer, ipwho.is lookup — the sandbox still hides the ssid.
        </p>
      </TraySheet>
    </div>
  );
}

/** battery — the real one, level + charging + estimates, percent INSIDE */
export function TrayBattery({ size = 14, sheetAlign = "right", drop = "down" }: TrayItemProps & { sheetAlign?: "left" | "right" }) {
  const bat = useBattery();
  const [open, setOpen] = useState(false);
  if (!bat.supported) {
    return (
      <span
        className="flex shrink-0 cursor-default items-center justify-center px-1.5 py-1 leading-none text-[var(--term-dim)] opacity-40"
        title="battery api unavailable in this browser"
        aria-label="battery unavailable"
      >
        <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" style={{ display: "block" }}>
          <rect x="1" y="4.5" width="12" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.5" />
          <rect x="14" y="6.5" width="1.6" height="3" rx="0.8" fill="currentColor" fillOpacity="0.5" />
        </svg>
      </span>
    );
  }
  const pct = bat.level !== null ? Math.round(bat.level * 100) : null;
  const low = pct !== null && pct < 20 && !bat.charging;
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`battery ${pct ?? "?"} percent${bat.charging ? ", charging" : ""}`}
        title={pct !== null ? `battery ${pct}%${bat.charging ? " — charging" : ""}` : "battery"}
        className={`flex shrink-0 cursor-pointer items-center justify-center px-1.5 py-1 leading-none transition-colors ${low ? "text-[var(--term-err)]" : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"}`}
      >
        {bat.level !== null && <BatteryPill level={bat.level} charging={Boolean(bat.charging)} size={size} />}
      </button>
      <TraySheet open={open} onClose={() => setOpen(false)} align={sheetAlign} drop={drop} label="battery status">
        <div className="mb-2 flex items-center gap-2">
          {bat.level !== null && <BatteryPill level={bat.level} charging={Boolean(bat.charging)} size={17} />}
          <span className="text-[12.5px] font-semibold text-[var(--term-fg)]">{pct !== null ? `${pct}%` : "battery"}</span>
          <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${bat.charging ? "text-[var(--term-brand)]" : "text-[var(--term-dim)]"}`}>
            {bat.charging ? "charging" : "on battery"}
          </span>
        </div>
        {bat.charging && bat.chargingTime !== null && (
          <div className={rowCls}>
            <span className={rowKey}>full in</span>
            <span className={rowVal}>{hhmm(bat.chargingTime)}</span>
          </div>
        )}
        {!bat.charging && bat.dischargingTime !== null && (
          <div className={rowCls}>
            <span className={rowKey}>empty in</span>
            <span className={rowVal}>{hhmm(bat.dischargingTime)}</span>
          </div>
        )}
        <div className={rowCls}>
          <span className={rowKey}>source</span>
          <span className={rowVal}>{bat.charging ? "ac power" : "internal battery"}</span>
        </div>
        <p className="mt-2 border-t border-[color-mix(in_srgb,var(--term-fg)_10%,transparent)] pt-2 text-[10px] leading-relaxed text-[var(--term-dim)]">
          live from the battery status api — this machine's real numbers.
        </p>
      </TraySheet>
    </div>
  );
}

/** bluetooth — the PWA way: the browser's own device picker (lol) */
export function TrayBluetooth({ size = 13, sheetAlign = "right", drop = "down" }: TrayItemProps & { sheetAlign?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "picking" | "err">("idle");
  const [err, setErr] = useState("");

  const supported = typeof navigator !== "undefined" && "bluetooth" in navigator;

  const pick = useCallback(async () => {
    if (!supported) return;
    setState("picking");
    setErr("");
    try {
      type BtDevice = { name?: string; id?: string };
      const nav = navigator as Navigator & {
        bluetooth?: { requestDevice: (o: { acceptAllDevices: boolean }) => Promise<BtDevice> };
      };
      const d = await nav.bluetooth!.requestDevice({ acceptAllDevices: true });
      setDevice(d.name || d.id?.slice(0, 12) || "unnamed device");
      setState("idle");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/cancel|dismiss/i.test(msg)) {
        setState("idle");
      } else {
        setState("err");
        setErr(msg.slice(0, 140));
      }
    }
  }, [supported]);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`bluetooth${device ? `: ${device}` : ""}`}
        title={supported ? "bluetooth — pick a device (pwa style)" : "bluetooth needs a secure context + chromium"}
        className={`flex shrink-0 cursor-pointer items-center justify-center px-1.5 py-1 leading-none transition-colors ${
          device ? "text-[var(--term-brand)]" : "text-[var(--term-dim)] hover:text-[var(--term-fg)]"
        }`}
      >
        <Bluetooth size={size} aria-hidden="true" />
      </button>
      <TraySheet open={open} onClose={() => setOpen(false)} align={sheetAlign} drop={drop} label="bluetooth">
        <div className="mb-2 flex items-center gap-2">
          <Bluetooth size={15} aria-hidden="true" />
          <span className="text-[12.5px] font-semibold text-[var(--term-fg)]">bluetooth</span>
          <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${device ? "text-[var(--term-brand)]" : "text-[var(--term-dim)]"}`}>
            {device ? "paired" : supported ? "pwa" : "n/a"}
          </span>
        </div>
        {device && (
          <div className={rowCls}>
            <span className={rowKey}>device</span>
            <span className={rowVal}>{device}</span>
          </div>
        )}
        <button
          type="button"
          onClick={() => void pick()}
          disabled={!supported || state === "picking"}
          className="mt-2 w-full cursor-pointer rounded-full border border-[color-mix(in_srgb,var(--term-fg)_18%,transparent)] py-1.5 text-[11.5px] text-[var(--term-fg)] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_8%,transparent)] disabled:cursor-default disabled:opacity-40"
        >
          {state === "picking" ? "waiting for the picker…" : device ? "pair another device" : "pair a device"}
        </button>
        {state === "err" && <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--term-err)]">{err}</p>}
        <p className="mt-2 border-t border-[color-mix(in_srgb,var(--term-fg)_10%,transparent)] pt-2 text-[10px] leading-relaxed text-[var(--term-dim)]">
          the web bluetooth api — the browser's own chooser, no root, no stack. pwa bluetooth, lol.
        </p>
      </TraySheet>
    </div>
  );
}
