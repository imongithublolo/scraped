"use client";

import { create } from "zustand";
import type { AppId } from "./contracts";

/**
 * DAEMON window manager.
 * Single store for all desktop windows: geometry, stacking order,
 * minimize/maximize state. Windows are single-instance per app; opening an
 * already-open app focuses it (and can update its props).
 */

export interface WinProps {
  /** browser: target url · viewer: vfs path */
  arg?: string;
  /** bumped on every (re)open so apps can re-read external state */
  nonce?: number;
}

export interface WinState {
  id: string;
  app: AppId;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  props: WinProps;
}

interface WmStore {
  windows: WinState[];
  topZ: number;
  activeId: string | null;
  open(app: AppId, arg?: string): void;
  close(id: string): void;
  focus(id: string): void;
  minimize(id: string): void;
  toggleMinimize(id: string): void;
  toggleMaximize(id: string): void;
  setBounds(id: string, b: Partial<Pick<WinState, "x" | "y" | "w" | "h">>): void;
  closeAll(): void;
}

interface AppMeta {
  title: string;
  w: number;
  h: number;
}

export const APP_META: Record<AppId, AppMeta> = {
  terminal: { title: "Terminal", w: 700, h: 460 },
  browser: { title: "Browser", w: 900, h: 560 },
  files: { title: "File Manager", w: 680, h: 440 },
  viewer: { title: "File Viewer", w: 620, h: 420 },
  help: { title: "Help", w: 640, h: 500 },
  credits: { title: "Credits", w: 460, h: 380 },
  paint: { title: "Paint", w: 660, h: 470 },
  chat: { title: "Chat", w: 640, h: 440 },
};

const TASKBAR_H = 48;
const CASCADE = 28;

let seq = 1;

function isMobile(): boolean {
  try {
    return window.innerWidth < 700 || window.innerHeight < 560;
  } catch {
    return false;
  }
}

function clampBounds(b: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const w = Math.min(b.w, vw - 8);
  const h = Math.min(b.h, vh - TASKBAR_H - 8);
  const x = Math.min(Math.max(b.x, 4 - w + 80), Math.max(vw - w - 4, 4));
  const y = Math.min(Math.max(b.y, 4), Math.max(vh - TASKBAR_H - 40, 4));
  return { x, y, w, h };
}

export const useWm = create<WmStore>((set, get) => ({
  windows: [],
  topZ: 10,
  activeId: null,

  open(app, arg) {
    const existing = get().windows.find((w) => w.app === app);
    if (existing) {
      set((s) => ({
        topZ: s.topZ + 1,
        activeId: existing.id,
        windows: s.windows.map((w) =>
          w.id === existing.id
            ? {
                ...w,
                z: s.topZ + 1,
                minimized: false,
                props: {
                  arg: arg !== undefined ? arg : w.props.arg,
                  nonce: Date.now(),
                },
              }
            : w
        ),
      }));
      return;
    }

    const meta = APP_META[app];
    const n = get().windows.length;
    const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
    const vh = typeof window !== "undefined" ? window.innerHeight : 800;
    const mobile = isMobile();
    const raw = {
      x: mobile ? 0 : Math.min(60 + (n % 6) * CASCADE, Math.max(vw - meta.w - 12, 8)),
      y: mobile ? 0 : Math.min(48 + (n % 6) * CASCADE, Math.max(vh - TASKBAR_H - meta.h - 12, 8)),
      w: meta.w,
      h: meta.h,
    };
    const bounds = mobile ? { x: 0, y: 0, w: vw, h: vh - TASKBAR_H } : clampBounds(raw);
    const id = `${app}-${seq++}`;
    set((s) => ({
      topZ: s.topZ + 1,
      activeId: id,
      windows: [
        ...s.windows,
        {
          id,
          app,
          title: meta.title,
          x: bounds.x,
          y: bounds.y,
          w: bounds.w,
          h: bounds.h,
          z: s.topZ + 1,
          minimized: false,
          maximized: mobile,
          props: { arg, nonce: Date.now() },
        },
      ],
    }));
  },

  close(id) {
    set((s) => {
      const rest = s.windows.filter((w) => w.id !== id);
      const nextTop = rest.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0];
      return { windows: rest, activeId: nextTop?.id ?? null };
    });
  },

  focus(id) {
    set((s) => {
      const win = s.windows.find((w) => w.id === id);
      if (!win) return s;
      if (s.activeId === id && !win.minimized) return s;
      return {
        topZ: s.topZ + 1,
        activeId: id,
        windows: s.windows.map((w) => (w.id === id ? { ...w, z: s.topZ + 1, minimized: false } : w)),
      };
    });
  },

  minimize(id) {
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, minimized: true } : w)),
      activeId: s.activeId === id ? null : s.activeId,
    }));
  },

  toggleMinimize(id) {
    const win = get().windows.find((w) => w.id === id);
    if (!win) return;
    if (win.minimized || get().activeId !== id) get().focus(id);
    else get().minimize(id);
  },

  toggleMaximize(id) {
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, maximized: !w.maximized } : w)),
    }));
  },

  setBounds(id, b) {
    set((s) => ({
      windows: s.windows.map((w) => (w.id === id ? { ...w, ...clampBounds({ x: w.x, y: w.y, w: w.w, h: w.h, ...b }) } : w)),
    }));
  },

  closeAll() {
    set({ windows: [], activeId: null });
  },
}));
