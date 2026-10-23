"use client";

/**
 * MURKE Proxy — PaintPane, mspaint-style.
 * A real pixel canvas with a tool rail (pencil / brush / spray / eraser /
 * fill / picker + line / rect / rounded-rect / ellipse / triangle / star),
 * the classic two-row color palette plus custom + recent colors, an
 * outline-vs-filled toggle for shapes, brush opacity, image import, png
 * download, undo/redo and save to ~/paintings as a png data url.
 *
 * Pointer events cover mouse + touch. Shapes preview live while dragging
 * and commit on release. The pane owns Escape via the shell overlay
 * handler — ctrl+z undo, ctrl+y / ctrl+shift+z redo, bare letters pick
 * tools (b/e/f/l/r/o/s/t/p).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Brush,
  Circle,
  Download,
  Eraser,
  ImagePlus,
  PaintBucket,
  Pencil,
  Pipette,
  Redo2,
  Save,
  Slash,
  SprayCan,
  Square,
  Squircle,
  Star,
  Trash2,
  Triangle,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";

const CANVAS_W = 800;
const CANVAS_H = 500;
const HISTORY_MAX = 30;
const RECENT_MAX = 8;
const RRECT_RADIUS = 10;

/** MS-paint-ish palette: row 1 = darks, row 2 = brights. */
const PALETTE: string[] = [
  "#000000", "#7f7f7f", "#880015", "#ed1c24", "#ff7f27", "#fff200", "#22b14c", "#00a2e8",
  "#3f48cc", "#a349a4", "#ffffff", "#c3c3c3", "#b97a57", "#ffaec9", "#ffc90e", "#efe4b0",
  "#b5e61d", "#99d9ea", "#7092be", "#c8bfe7",
];

const SIZES = [1, 3, 6, 12] as const;

type Tool =
  | "pencil" | "brush" | "spray" | "eraser" | "fill" | "picker"
  | "line" | "rect" | "rrect" | "ellipse" | "triangle" | "star";

const TOOLS: Array<{ id: Tool; icon: LucideIcon; label: string; title: string }> = [
  { id: "pencil", icon: Pencil, label: "pencil", title: "pencil — 1px freehand" },
  { id: "brush", icon: Brush, label: "brush", title: "brush — thick freehand (b)" },
  { id: "spray", icon: SprayCan, label: "spray", title: "spray — airbrush, hold to build up" },
  { id: "eraser", icon: Eraser, label: "erase", title: "eraser (e)" },
  { id: "fill", icon: PaintBucket, label: "fill", title: "flood fill (f)" },
  { id: "picker", icon: Pipette, label: "pick", title: "color picker (p)" },
  { id: "line", icon: Slash, label: "line", title: "line (l)" },
  { id: "rect", icon: Square, label: "rect", title: "rectangle (r)" },
  { id: "rrect", icon: Squircle, label: "round", title: "rounded rectangle" },
  { id: "ellipse", icon: Circle, label: "oval", title: "ellipse (o)" },
  { id: "triangle", icon: Triangle, label: "tri", title: "triangle (t)" },
  { id: "star", icon: Star, label: "star", title: "star (s)" },
];

const isShape = (t: Tool) =>
  t === "line" || t === "rect" || t === "rrect" || t === "ellipse" || t === "triangle" || t === "star";

/** keys that switch tools (no modifier held, not while typing) */
const KEY_TOOLS: Record<string, Tool> = {
  b: "brush", e: "eraser", f: "fill", l: "line",
  r: "rect", o: "ellipse", s: "star", t: "triangle", p: "picker",
};

const BORDER_LINE = "border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)]";

interface Pt {
  x: number;
  y: number;
}

function sanitizeName(raw: string): string {
  return raw.replace(/[/\\]+/g, "").trim().slice(0, 64);
}

/** rounded-rect via arcTo (canvas roundRect support is still spotty in lib.dom) */
function roundedRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  g.moveTo(x + rad, y);
  g.lineTo(x + w - rad, y);
  g.arcTo(x + w, y, x + w, y + rad, rad);
  g.lineTo(x + w, y + h - rad);
  g.arcTo(x + w, y + h, x + w - rad, y + h, rad);
  g.lineTo(x + rad, y + h);
  g.arcTo(x, y + h, x, y + h - rad, rad);
  g.lineTo(x, y + rad);
  g.arcTo(x, y, x + rad, y, rad);
  g.closePath();
}

export default function PaintPane({
  onClose,
  onSave,
}: {
  onClose: () => void;
  /** (name, png-data-url) — dsh writes it into ~/paintings */
  onSave: (name: string, content: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [color, setColor] = useState("#ed1c24");
  const [size, setSize] = useState<number>(3);
  const [opacity, setOpacity] = useState<number>(100);
  const [shapeFill, setShapeFill] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [pos, setPos] = useState<Pt>({ x: 0, y: 0 });

  /** undo / redo stacks of png data urls (compressed — ImageData would eat ram) */
  const historyRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  /** drag state */
  const drawingRef = useRef(false);
  const startRef = useRef<Pt>({ x: 0, y: 0 });
  /** pristine snapshot for shape previews + translucent-freehand redraws */
  const previewBaseRef = useRef<ImageData | null>(null);
  /** polyline of the current freehand stroke (only used when opacity < 100) */
  const pointsRef = useRef<Pt[]>([]);
  /** spray keeps stamping while the pointer is held still */
  const sprayTimerRef = useRef<number | null>(null);
  const lastPosRef = useRef<Pt>({ x: 0, y: 0 });
  const fileRef = useRef<HTMLInputElement>(null);

  const ctx = useCallback((): CanvasRenderingContext2D | null => {
    return canvasRef.current?.getContext("2d", { willReadFrequently: true }) ?? null;
  }, []);

  /* seed the canvas white once */
  useEffect(() => {
    const c = canvasRef.current;
    const g = ctx();
    if (!c || !g) return;
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, CANVAS_W, CANVAS_H);
    g.lineJoin = "round";
    g.lineCap = "round";
  }, [ctx]);

  /* never leave a spray timer running behind us */
  useEffect(() => {
    return () => {
      if (sprayTimerRef.current !== null) window.clearInterval(sprayTimerRef.current);
    };
  }, []);

  /* ---------- history ---------- */

  /** snapshot BEFORE a mutation; any new mutation kills the redo stack */
  const pushHistory = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    historyRef.current.push(c.toDataURL("image/png"));
    if (historyRef.current.length > HISTORY_MAX) historyRef.current.shift();
    redoRef.current = [];
  }, []);

  const restore = useCallback(
    (dataUrl: string) => {
      const g = ctx();
      if (!g) return;
      const img = new Image();
      img.onload = () => {
        g.clearRect(0, 0, CANVAS_W, CANVAS_H);
        g.drawImage(img, 0, 0);
      };
      img.src = dataUrl;
    },
    [ctx],
  );

  const undo = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const snap = historyRef.current.pop();
    if (!snap) return;
    redoRef.current.push(c.toDataURL("image/png"));
    if (redoRef.current.length > HISTORY_MAX) redoRef.current.shift();
    restore(snap);
  }, [restore]);

  const redo = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const snap = redoRef.current.pop();
    if (!snap) return;
    historyRef.current.push(c.toDataURL("image/png"));
    if (historyRef.current.length > HISTORY_MAX) historyRef.current.shift();
    restore(snap);
  }, [restore]);

  const clear = useCallback(() => {
    const g = ctx();
    if (!g) return;
    pushHistory();
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }, [ctx, pushHistory]);

  /* ---------- colors ---------- */

  /** remember the last non-palette colors used */
  const addRecent = useCallback((hex: string) => {
    const c = hex.toLowerCase();
    setRecents((prev) => {
      if (PALETTE.some((p) => p.toLowerCase() === c)) return prev;
      return [hex, ...prev.filter((p) => p.toLowerCase() !== c)].slice(0, RECENT_MAX);
    });
  }, []);

  /* ---------- coordinate mapping (canvas is css-scaled) ---------- */

  const toCanvas = useCallback((e: { clientX: number; clientY: number }): Pt => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * CANVAS_W),
      y: Math.round(((e.clientY - r.top) / r.height) * CANVAS_H),
    };
  }, []);

  /* ---------- flood fill (stack scan, tolerance 32) ---------- */

  const floodFill = useCallback(
    (p: Pt) => {
      const g = ctx();
      const c = canvasRef.current;
      if (!g || !c) return;
      const img = g.getImageData(0, 0, CANVAS_W, CANVAS_H);
      const data = img.data;
      const idx = (x: number, y: number) => (y * CANVAS_W + x) * 4;
      const start = idx(p.x, p.y);
      const target = [data[start], data[start + 1], data[start + 2], data[start + 3]];
      const hex = color.replace("#", "");
      const fill = [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        255,
      ];
      if (target.every((v, i) => v === fill[i])) return;
      const near = (i: number) =>
        Math.abs(data[i] - target[0]) <= 32 &&
        Math.abs(data[i + 1] - target[1]) <= 32 &&
        Math.abs(data[i + 2] - target[2]) <= 32 &&
        Math.abs(data[i + 3] - target[3]) <= 32;
      const stack: Array<[number, number]> = [[p.x, p.y]];
      while (stack.length > 0) {
        const [x, y] = stack.pop() as [number, number];
        if (x < 0 || y < 0 || x >= CANVAS_W || y >= CANVAS_H) continue;
        const i = idx(x, y);
        if (!near(i)) continue;
        data[i] = fill[0];
        data[i + 1] = fill[1];
        data[i + 2] = fill[2];
        data[i + 3] = fill[3];
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }
      g.putImageData(img, 0, 0);
    },
    [ctx, color],
  );

  /* ---------- spray (airbrush) ---------- */

  const sprayStamp = useCallback(
    (g: CanvasRenderingContext2D, p: Pt) => {
      g.fillStyle = color;
      g.globalAlpha = opacity / 100;
      const radius = 8 + size * 2;
      const dots = 8 + size * 2;
      for (let i = 0; i < dots; i++) {
        const ang = Math.random() * Math.PI * 2;
        const rad = Math.sqrt(Math.random()) * radius;
        g.fillRect(
          Math.round(p.x + Math.cos(ang) * rad),
          Math.round(p.y + Math.sin(ang) * rad),
          1,
          1,
        );
      }
      g.globalAlpha = 1;
    },
    [color, opacity, size],
  );

  /* ---------- freehand (whole-polyline redraw for translucent strokes) ---------- */

  const strokeFreehand = useCallback(
    (g: CanvasRenderingContext2D) => {
      const pts = pointsRef.current;
      if (pts.length === 0) return;
      g.strokeStyle = tool === "eraser" ? "#ffffff" : color;
      g.lineWidth = tool === "pencil" ? 1 : tool === "eraser" ? size * 2 : size;
      g.globalAlpha = opacity / 100;
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 1) {
        g.lineTo(pts[0].x + 0.01, pts[0].y + 0.01);
      } else {
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      }
      g.stroke();
      g.globalAlpha = 1;
    },
    [color, opacity, size, tool],
  );

  /* ---------- shape rendering (previews + commits share it) ---------- */

  const drawShape = useCallback(
    (g: CanvasRenderingContext2D, a: Pt, b: Pt) => {
      const minX = Math.min(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      const cx = minX + w / 2;
      const cy = minY + h / 2;
      g.strokeStyle = color;
      g.fillStyle = color;
      g.lineWidth = size;
      g.globalAlpha = opacity / 100;
      g.beginPath();
      if (tool === "line") {
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
      } else if (tool === "rect") {
        g.rect(minX, minY, w, h);
      } else if (tool === "rrect") {
        roundedRectPath(g, minX, minY, w, h, RRECT_RADIUS);
      } else if (tool === "ellipse") {
        g.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      } else if (tool === "triangle") {
        g.moveTo(cx, minY);
        g.lineTo(minX, minY + h);
        g.lineTo(minX + w, minY + h);
        g.closePath();
      } else if (tool === "star") {
        for (let i = 0; i < 10; i++) {
          const ang = -Math.PI / 2 + i * (Math.PI / 5);
          const f = i % 2 === 0 ? 1 : 0.4;
          const px = cx + (w / 2) * f * Math.cos(ang);
          const py = cy + (h / 2) * f * Math.sin(ang);
          if (i === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.closePath();
      }
      if (tool !== "line" && shapeFill) g.fill();
      g.stroke();
      g.globalAlpha = 1;
    },
    [color, opacity, shapeFill, size, tool],
  );

  /* ---------- pointer handlers ---------- */

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (saving) return;
    const c = canvasRef.current;
    const g = ctx();
    if (!c || !g) return;
    const p = toCanvas(e);

    if (tool === "picker") {
      const d = g.getImageData(p.x, p.y, 1, 1).data;
      const hex =
        "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      setColor(hex);
      addRecent(hex); // picking is not a mutation — no history touch
      return;
    }

    c.setPointerCapture(e.pointerId);
    startRef.current = p;
    pushHistory();

    if (tool === "fill") {
      floodFill(p);
      return;
    }
    if (isShape(tool)) {
      previewBaseRef.current = g.getImageData(0, 0, CANVAS_W, CANVAS_H);
      drawingRef.current = true;
      return;
    }
    if (tool === "spray") {
      drawingRef.current = true;
      lastPosRef.current = p;
      sprayStamp(g, p);
      sprayTimerRef.current = window.setInterval(() => {
        const g2 = ctx();
        if (g2) sprayStamp(g2, lastPosRef.current);
      }, 30);
      return;
    }
    // freehand start
    drawingRef.current = true;
    pointsRef.current = [p];
    if (opacity < 100) {
      // translucent strokes need base + full redraw so alpha never compounds
      previewBaseRef.current = g.getImageData(0, 0, CANVAS_W, CANVAS_H);
      strokeFreehand(g);
    } else {
      // fast path: a dot
      g.strokeStyle = tool === "eraser" ? "#ffffff" : color;
      g.lineWidth = tool === "pencil" ? 1 : tool === "eraser" ? size * 2 : size;
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(p.x + 0.01, p.y + 0.01);
      g.stroke();
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toCanvas(e);
    setPos(p);
    if (!drawingRef.current) return;
    const g = ctx();
    if (!g) return;
    if (isShape(tool)) {
      const base = previewBaseRef.current;
      if (base) g.putImageData(base, 0, 0);
      drawShape(g, startRef.current, p);
      return;
    }
    if (tool === "spray") {
      lastPosRef.current = p;
      sprayStamp(g, p);
      return;
    }
    if (opacity < 100) {
      const base = previewBaseRef.current;
      if (base) g.putImageData(base, 0, 0);
      pointsRef.current.push(p);
      strokeFreehand(g);
      return;
    }
    g.strokeStyle = tool === "eraser" ? "#ffffff" : color;
    g.lineWidth = tool === "pencil" ? 1 : tool === "eraser" ? size * 2 : size;
    g.lineTo(p.x, p.y);
    g.stroke();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const wasDrawing = drawingRef.current;
    drawingRef.current = false;
    if (sprayTimerRef.current !== null) {
      window.clearInterval(sprayTimerRef.current);
      sprayTimerRef.current = null;
    }
    const g = ctx();
    if (!g || !wasDrawing) return;
    if (isShape(tool)) {
      // restore the pristine base, then commit at the same alpha as the preview
      const base = previewBaseRef.current;
      if (base) g.putImageData(base, 0, 0);
      drawShape(g, startRef.current, toCanvas(e));
    }
    previewBaseRef.current = null;
    pointsRef.current = [];
  };

  /* ---------- import / download / save ---------- */

  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const c = canvasRef.current;
      const g = ctx();
      if (!c || !g) return;
      pushHistory();
      const scale = Math.min(CANVAS_W / img.naturalWidth, CANVAS_H / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      g.globalAlpha = 1;
      g.drawImage(img, (CANVAS_W - w) / 2, (CANVAS_H - h) / 2, w, h);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  const download = () => {
    const c = canvasRef.current;
    if (!c) return;
    const a = document.createElement("a");
    a.download = (sanitizeName(name) || "painting") + ".png";
    a.href = c.toDataURL("image/png");
    a.click();
  };

  const commitSave = () => {
    const clean = sanitizeName(name);
    if (!clean) return;
    const c = canvasRef.current;
    if (!c) return;
    try {
      onSave(clean.endsWith(".png") ? clean : clean + ".png", c.toDataURL("image/png"));
    } finally {
      setSaving(false);
      setName("");
    }
  };

  /* ctrl+z undo · ctrl+y / ctrl+shift+z redo · bare letters pick tools */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && k === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (drawingRef.current) return; // never swap tools mid-stroke
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const next = KEY_TOOLS[k];
      if (next) setTool(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const toolBtn =
    "flex w-8 h-8 items-center justify-center border text-[13px] transition-colors cursor-pointer select-none";
  const actBtn = `flex cursor-pointer items-center gap-1 border px-2 py-0.5 text-[11px] transition-colors hover:bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)] ${BORDER_LINE}`;
  const toggleBtn = (active: boolean) =>
    `flex h-5 w-5 items-center justify-center border cursor-pointer ${
      active
        ? "border-[var(--term-brand)] bg-[color-mix(in_srgb,var(--term-brand)_25%,transparent)] text-[var(--term-fg)]"
        : "border-[color-mix(in_srgb,var(--term-fg)_20%,transparent)] text-[var(--term-dim)] hover:text-[var(--term-fg)]"
    }`;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[var(--term-bg)] font-mono text-xs text-[var(--term-fg)]">
      {/* header */}
      <div className={`flex shrink-0 items-center justify-between gap-3 border-b px-3 py-1.5 ${BORDER_LINE}`}>
        <span className="font-bold tracking-widest text-[var(--term-brand)]">PAINT</span>
        <span className="truncate text-[10px] text-[var(--term-dim)]">
          mspaint but terminal · save drops a png in ~/paintings
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="close paint"
          className="cursor-pointer border border-[color-mix(in_srgb,var(--term-fg)_30%,transparent)] p-0.5 hover:bg-[color-mix(in_srgb,var(--term-fg)_12%,transparent)]"
        >
          <X size={11} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* tool rail */}
        <div
          className="flex w-10 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r py-2 md:w-12"
          role="toolbar"
          aria-label="paint tools"
        >
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.title}
              aria-pressed={tool === t.id}
              aria-label={t.label}
              onClick={() => setTool(t.id)}
              className={`${toolBtn} ${
                tool === t.id
                  ? "border-[var(--term-brand)] bg-[color-mix(in_srgb,var(--term-brand)_25%,transparent)] text-[var(--term-fg)]"
                  : "border-[color-mix(in_srgb,var(--term-fg)_20%,transparent)] text-[var(--term-dim)] hover:text-[var(--term-fg)]"
              }`}
            >
              <t.icon size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
          ))}
        </div>

        {/* canvas area */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-1 items-center justify-center overflow-hidden p-2">
            <canvas
              ref={canvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              className="max-h-full max-w-full cursor-crosshair touch-none border border-[color-mix(in_srgb,var(--term-fg)_35%,transparent)] bg-white"
              aria-label="paint canvas"
            />
          </div>

          {/* palette + options row */}
          <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-2 py-1.5 ${BORDER_LINE}`}>
            <span
              className="h-6 w-10 shrink-0 border border-[color-mix(in_srgb,var(--term-fg)_40%,transparent)]"
              style={{ backgroundColor: color }}
              title={`current color ${color}`}
              aria-label={`current color ${color}`}
            />
            <div className="grid shrink-0 grid-flow-col grid-rows-2 gap-0.5">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  title={c}
                  aria-label={`pick color ${c}`}
                  className={`h-4 w-4 border cursor-pointer ${
                    color.toLowerCase() === c.toLowerCase()
                      ? "border-[var(--term-fg)]"
                      : "border-black/30"
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            {/* custom color */}
            <label
              title="custom color"
              className="relative h-4 w-4 shrink-0 cursor-pointer border border-black/30"
              style={{ backgroundColor: color }}
            >
              <input
                type="color"
                value={color}
                onChange={(e) => {
                  const v = e.target.value;
                  setColor(v);
                  addRecent(v);
                }}
                aria-label="custom color"
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </label>
            {/* recent non-palette colors */}
            {recents.length > 0 && (
              <div className="flex shrink-0 items-center gap-0.5" title="recent colors">
                {recents.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    title={c}
                    aria-label={`recent color ${c}`}
                    className={`h-4 w-4 border cursor-pointer ${
                      color.toLowerCase() === c.toLowerCase()
                        ? "border-[var(--term-fg)]"
                        : "border-black/30"
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            )}
            <span className={BORDER_LINE + " mx-1 h-4 w-px"} />
            {/* outline vs filled shapes */}
            <span className="text-[10px] text-[var(--term-dim)]">shape</span>
            <button
              type="button"
              onClick={() => setShapeFill(false)}
              aria-pressed={!shapeFill}
              aria-label="outline shapes"
              title="outline (stroke only)"
              className={toggleBtn(!shapeFill)}
            >
              <Square size={11} strokeWidth={2} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setShapeFill(true)}
              aria-pressed={shapeFill}
              aria-label="filled shapes"
              title="filled (fill + stroke)"
              className={toggleBtn(shapeFill)}
            >
              <Square size={11} strokeWidth={2} fill="currentColor" aria-hidden="true" />
            </button>
            <span className={BORDER_LINE + " mx-1 h-4 w-px"} />
            <span className="text-[10px] text-[var(--term-dim)]">size</span>
            {SIZES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSize(s)}
                aria-pressed={size === s}
                title={`stroke ${s}px`}
                className={`cursor-pointer border px-1.5 py-0.5 text-[10px] ${
                  size === s
                    ? "border-[var(--term-brand)] text-[var(--term-fg)]"
                    : "border-[color-mix(in_srgb,var(--term-fg)_20%,transparent)] text-[var(--term-dim)]"
                }`}
              >
                {s}
              </button>
            ))}
            <span className={BORDER_LINE + " mx-1 h-4 w-px"} />
            <span className="text-[10px] text-[var(--term-dim)]">alpha</span>
            <input
              type="range"
              min={10}
              max={100}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              title={`brush opacity ${opacity}%`}
              aria-label="brush opacity"
              className="w-20 cursor-pointer accent-[var(--term-brand)]"
            />
            <span className="w-9 text-right text-[10px] text-[var(--term-dim)]">{opacity}%</span>
            <span className="ml-auto truncate text-[10px] text-[var(--term-dim)]">
              {pos.x},{pos.y}
            </span>
          </div>
        </div>
      </div>

      {/* action bar */}
      <div className={`flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-1.5 ${BORDER_LINE}`}>
        {/* stays mounted so the file ref survives save mode */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={onImportFile}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
        {saving ? (
          <>
            <span className="text-[var(--term-dim)]">filename:</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitSave();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setSaving(false);
                  setName("");
                }
              }}
              spellCheck={false}
              autoComplete="off"
              placeholder="untitled"
              className="w-52 bg-transparent text-[var(--term-fg)] caret-[var(--term-fg)] outline-none placeholder:text-[var(--term-dim)]"
            />
            <span className="text-[var(--term-dim)]">enter save · esc cancel</span>
          </>
        ) : (
          <>
            <button type="button" onClick={undo} title="undo (ctrl+z)" className={actBtn}>
              <Undo2 size={11} strokeWidth={2} aria-hidden="true" />
              undo
            </button>
            <button type="button" onClick={redo} title="redo (ctrl+y or ctrl+shift+z)" className={actBtn}>
              <Redo2 size={11} strokeWidth={2} aria-hidden="true" />
              redo
            </button>
            <button type="button" onClick={clear} title="wipe the canvas" className={actBtn}>
              <Trash2 size={11} strokeWidth={2} aria-hidden="true" />
              clear
            </button>
            <span className={BORDER_LINE + " h-4 w-px"} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              title="import an image (fit inside the canvas)"
              className={actBtn}
            >
              <ImagePlus size={11} strokeWidth={2} aria-hidden="true" />
              import
            </button>
            <button type="button" onClick={download} title="download png to your machine" className={actBtn}>
              <Download size={11} strokeWidth={2} aria-hidden="true" />
              download
            </button>
            <button type="button" onClick={() => setSaving(true)} title="save png to ~/paintings" className={actBtn}>
              <Save size={11} strokeWidth={2} aria-hidden="true" />
              save
            </button>
            <span className="ml-auto truncate text-[10px] text-[var(--term-dim)]">
              b/e/f/l/r/o/s/t/p tools · ctrl+z undo · ctrl+y redo · drag shapes · esc quits
            </span>
          </>
        )}
      </div>
    </div>
  );
}
