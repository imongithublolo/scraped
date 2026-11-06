"use client";

/**
 * murke vm — the terminal's virtual-machine registry.
 *
 * `vm create` provisions an Ubuntu 24.04 LTS instance "on the vercel edge"
 * (region iad1) and `vm open` attaches a fullscreen console to it. The
 * registry lives in localStorage — instances survive reloads, and the
 * console itself is a full simulated Ubuntu userland (VmApp).
 *
 * Provisioning/deleting requires the VM admin code — checked in the shell
 * via a masked prompt; it never touches this module.
 */

import { LS } from "./contracts";

export const VM_OS = "ubuntu-24.04-lts";
export const VM_REGION = "iad1";
export const VM_SIZES = ["micro-1gb", "small-2gb", "standard-4gb"] as const;
export type VmSize = (typeof VM_SIZES)[number];

export interface VmInstance {
  id: string;
  name: string;
  os: string;
  size: VmSize;
  region: string;
  /** private vnet address handed out at create time */
  ip: string;
  status: "running" | "stopped";
  createdAt: number;
  /** ms accumulated while attached — the console feeds this back */
  uptimeMs: number;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

function load(): VmInstance[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LS.vms);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (v): v is VmInstance =>
        typeof (v as VmInstance)?.id === "string" &&
        typeof (v as VmInstance)?.name === "string" &&
        typeof (v as VmInstance)?.ip === "string",
    );
  } catch {
    return [];
  }
}

function save(vms: VmInstance[]): void {
  try {
    localStorage.setItem(LS.vms, JSON.stringify(vms));
  } catch {
    /* quota — ignore */
  }
}

export function listVms(): VmInstance[] {
  return load().sort((a, b) => a.createdAt - b.createdAt);
}

export function findVm(name: string): VmInstance | undefined {
  const n = name.trim().toLowerCase();
  return load().find((v) => v.name === n || v.id === n);
}

export function validVmName(name: string): boolean {
  return NAME_RE.test(name.trim());
}

/** Provision a new Ubuntu VM. Returns the instance (or null when the name is taken). */
export function createVm(name: string, size: VmSize): VmInstance | null {
  const n = name.trim().toLowerCase();
  if (!NAME_RE.test(n)) return null;
  const vms = load();
  if (vms.some((v) => v.name === n)) return null;
  // stable private ip off the creation timestamp
  const t = Date.now() % 0xffff;
  const ip = `10.14.${(t >> 8) & 0xff}.${t & 0xff}`;
  const vm: VmInstance = {
    id: `vm-${t.toString(36)}-${Math.floor(Math.random() * 46656).toString(36)}`,
    name: n,
    os: VM_OS,
    size,
    region: VM_REGION,
    ip,
    status: "running",
    createdAt: Date.now(),
    uptimeMs: 0,
  };
  vms.push(vm);
  save(vms);
  return vm;
}

export function patchVm(name: string, patch: Partial<Pick<VmInstance, "status" | "uptimeMs">>): VmInstance | null {
  const n = name.trim().toLowerCase();
  const vms = load();
  const i = vms.findIndex((v) => v.name === n || v.id === n);
  if (i < 0) return null;
  vms[i] = { ...vms[i], ...patch };
  save(vms);
  return vms[i];
}

export function deleteVm(name: string): boolean {
  const n = name.trim().toLowerCase();
  const vms = load();
  const next = vms.filter((v) => v.name !== n && v.id !== n);
  if (next.length === vms.length) return false;
  save(next);
  return true;
}

/** "2m 14s" style age for listings */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
