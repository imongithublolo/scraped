import type { SoundEngine } from "./contracts";
import { LS } from "./contracts";

/**
 * Mechanical-keyboard SFX synthesized with WebAudio.
 * Opt-in: disabled until setEnabled(true). Context is created lazily on first
 * user gesture so autoplay policies are satisfied.
 */

type Ctx = AudioContext;

export class MechanicalSound implements SoundEngine {
  private _enabled = false;
  private ctx: Ctx | null = null;
  private noiseBuf: AudioBuffer | null = null;

  constructor() {
    try {
      this._enabled = localStorage.getItem(LS.settings + ".sfx") === "1";
    } catch {
      /* private mode */
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(v: boolean): void {
    this._enabled = v;
    try {
      localStorage.setItem(LS.settings + ".sfx", v ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (v) {
      this.ensure();
      // tiny confirmation tick
      this.thock(1800, 0.05, 0.09);
    }
  }

  private ensure(): Ctx | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      try {
        this.ctx = new AC();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    if (!this.noiseBuf) {
      const len = Math.floor(this.ctx.sampleRate * 0.04);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        // exponential-ish decay noise burst
        const t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.2);
      }
      this.noiseBuf = buf;
    }
    return this.ctx;
  }

  /** bandpassed noise click — the "key" sound */
  private click(freq: number, gain: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.noiseBuf || !this._enabled) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.25;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq * (0.92 + Math.random() * 0.16);
    bp.Q.value = 1.1;

    const g = ctx.createGain();
    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.045);

    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + 0.05);
  }

  /** low sine thock — enter / space bottom-out */
  private thock(freq: number, gain: number, dur: number): void {
    const ctx = this.ensure();
    if (!ctx || !this._enabled) return;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq * (0.96 + Math.random() * 0.08), ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, ctx.currentTime + dur);

    const g = ctx.createGain();
    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.01);
  }

  key(): void {
    this.click(2600, 0.12);
  }
  space(): void {
    this.click(1400, 0.1);
    this.thock(170, 0.05, 0.06);
  }
  enter(): void {
    this.click(2100, 0.14);
    this.thock(150, 0.12, 0.09);
  }
  backspace(): void {
    this.click(3300, 0.11);
  }
}
