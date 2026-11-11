import type { SynthEngine, SynthTick, TrackInfo } from "./contracts";

/**
 * Tiny WebAudio chiptune engine. Songs are step patterns (8th notes):
 *   "a3 c4 e4 -"  -> note tokens; "-" sustains previous, "." is a rest.
 * Lead = square wave, bass = triangle, one step per 8th note.
 */

interface SongDef {
  id: string;
  name: string;
  bpm: number;
  lead: string;
  bass: string; // quarter notes
  wave?: OscillatorType;
}

const N: Record<string, number> = { c: 0, "c#": 1, db: 1, d: 2, "d#": 3, eb: 3, e: 4, f: 5, "f#": 6, gb: 6, g: 7, "g#": 8, ab: 8, a: 9, "a#": 10, bb: 10, b: 11 };

function noteFreq(token: string): number | null {
  const m = /^([a-g](?:#|b)?)(-?\d)$/.exec(token.toLowerCase());
  if (!m) return null;
  const semi = N[m[1]];
  const oct = parseInt(m[2], 10);
  const midi = (oct + 1) * 12 + semi;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function parseSteps(s: string): (number | null | "-")[] {
  return s
    .trim()
    .split(/\s+/)
    .map((t) => (t === "-" ? "-" : t === "." ? null : noteFreq(t)));
}

const SONGS: SongDef[] = [
  {
    id: "bootloader.mod",
    name: "bootloader.mod",
    bpm: 132,
    lead: `a3 c4 e4 a4 e4 c4 a3 .   f3 a3 c4 f4 c4 a3 f3 .
            g3 b3 d4 g4 d4 b3 g3 .   e3 g#3 b3 e4 b3 g#3 e3 .`,
    bass: `a2 a2 f2 f2   g2 g2 e2 e2`,
  },
  {
    id: "phreaker.mod",
    name: "phreaker.mod",
    bpm: 140,
    lead: `d4 . f4 d4 a4 . g4 f4   c4 . e4 c4 g4 . f4 e4
            bb3 . d4 bb3 f4 . e4 d4  a3 . c4 a3 e4 . d4 c4
            d4 . f4 d4 a4 . g4 f4   c4 . e4 c4 g4 . f4 e4
            bb3 c4 d4 f4 e4 d4 c4 .  a3 c4 d4 e4 f4 . . .`,
    bass: `d2 d2 c2 c2   bb1 bb1 a1 a1   d2 d2 c2 c2   bb1 bb1 a1 a1`,
  },
  {
    id: "midnight_waves.mod",
    name: "midnight_waves.mod",
    bpm: 96,
    lead: `f3 . a3 c4 f4 . c4 a3   d4 . f4 a4 f4 . d4 a3
            bb3 . d4 f4 bb4 . f4 d4  c4 . e4 g4 c5 . g4 e4
            f3 . a3 c4 f4 . c4 a3   d4 . f4 a4 f4 . d4 a3
            bb3 . d4 f4 bb4 . f4 d4  c4 e4 g4 bb4 a4 . . .`,
    bass: `f2 . f2 .   d2 . d2 .   bb1 . bb1 .  c2 . c2 .
            f2 . f2 .   d2 . d2 .   bb1 . bb1 .  c2 . c2 .`,
  },
  {
    id: "dialup_dreams.mod",
    name: "dialup_dreams.mod",
    bpm: 172,
    lead: `e4 g4 b4 e5 b4 g4 e4 .   c4 e4 g4 c5 g4 e4 c4 .
            a3 c4 e4 a4 c5 a4 e4 c4  b3 d#4 f#4 b4 d#5 b4 f#4 d#4
            e4 g4 b4 e5 b4 g4 e4 .   c4 e4 g4 c5 g4 e4 c4 .
            a3 c4 e4 a4 c5 a4 e4 c4  b3 e4 f#4 g#4 b4 . . .`,
    bass: `e2 e2 c2 c2   a1 a1 b1 b1   e2 e2 c2 c2   a1 a1 b1 b1`,
  },
  {
    id: "kernel_panik.mod",
    name: "kernel_panik.mod",
    bpm: 150,
    wave: "sawtooth",
    lead: `c4 . c4 eb4 c4 . bb3 c4  g3 . g3 bb3 g3 . f3 g3
            f3 . f3 ab3 f3 . eb3 f3  b3 . b3 d4 b3 . a3 b3
            c4 . c4 eb4 c4 . bb3 c4  g3 . g3 bb3 g3 . f3 g3
            f3 ab3 b3 eb4 d4 bb3 a3 g3 f3 eb3 . . . . . .`,
    bass: `c2 . c2 .   g1 . g1 .   f1 . f1 .   b1 . b1 .
            c2 . c2 .   g1 . g1 .   f1 . f1 .   b1 . g1 .`,
  },
];

export class ChiptuneSynth implements SynthEngine {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private song: SongDef | null = null;
  private leadSteps: (number | null | "-")[] = [];
  private bassSteps: (number | null | "-")[] = [];
  private totalSteps = 0;
  private stepDur = 0;
  private nextTime = 0;
  private stepIdx = 0;
  private startedAt = 0;
  private tickCb: ((t: SynthTick) => void) | null = null;
  private lastTickEmit = 0;

  private ensure(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ac) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      try {
        this.ac = new AC();
      } catch {
        return null;
      }
      this.master = this.ac.createGain();
      this.master.gain.value = 0.16;
      this.master.connect(this.ac.destination);
    }
    if (this.ac.state === "suspended") void this.ac.resume();
    return this.ac;
  }

  list(): TrackInfo[] {
    return SONGS.map((s) => {
      const steps = parseSteps(s.lead).length;
      return { id: s.id, name: s.name, bpm: s.bpm, lengthSec: Math.round((steps * (60 / s.bpm / 2)) * 10) / 10 };
    });
  }

  nowPlaying(): TrackInfo | null {
    if (!this.song) return null;
    const steps = this.leadSteps.length;
    return {
      id: this.song.id,
      name: this.song.name,
      bpm: this.song.bpm,
      lengthSec: Math.round(steps * this.stepDur * 10) / 10,
    };
  }

  onTick(cb: ((t: SynthTick) => void) | null): void {
    this.tickCb = cb;
  }

  play(id: string): boolean {
    const song = SONGS.find((s) => s.id === id || s.name === id || s.id.replace(/\.mod$/, "") === id.replace(/\.mod$/, ""));
    if (!song) return false;
    const ac = this.ensure();
    if (!ac) return false;

    this.stop();

    this.song = song;
    this.leadSteps = parseSteps(song.lead);
    this.bassSteps = parseSteps(song.bass);
    this.stepDur = 60 / song.bpm / 2;
    this.totalSteps = Math.max(this.leadSteps.length, this.bassSteps.length * 2);
    this.stepIdx = 0;
    this.startedAt = ac.currentTime;
    this.nextTime = ac.currentTime + 0.06;

    this.timer = setInterval(() => this.schedule(), 90);
    this.schedule();
    return true;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.song = null;
    if (this.tickCb) {
      // final tick so the status bar clears
    }
  }

  private schedule(): void {
    const ac = this.ac;
    const song = this.song;
    if (!ac || !song || !this.master) return;
    const horizon = ac.currentTime + 0.4;
    while (this.nextTime < horizon) {
      const i = this.stepIdx;
      const t = this.nextTime;

      const li = i % this.leadSteps.length;
      const tok = this.leadSteps[li];
      if (typeof tok === "number") this.blip(tok, t, song.wave ?? "square", 0.5);
      else if (tok === "-" && typeof this.leadSteps[(li - 1 + this.leadSteps.length) % this.leadSteps.length] === "number") {
        /* sustain — handled by note length below; ignore for simplicity */
      }

      if (i % 2 === 0) {
        const bi = (i / 2) % this.bassSteps.length;
        const btok = this.bassSteps[bi];
        if (typeof btok === "number") this.blip(btok, t, "triangle", 0.42);
      }

      this.stepIdx = (this.stepIdx + 1) % this.totalSteps;
      this.nextTime += this.stepDur;
    }

    if (this.tickCb && this.song) {
      const now = performance.now();
      if (now - this.lastTickEmit > 240) {
        this.lastTickEmit = now;
        const total = this.totalSteps * this.stepDur;
        const elapsed = (ac.currentTime - this.startedAt) % total;
        this.tickCb({ id: this.song.id, name: this.song.name, elapsed, total });
      }
    }
  }

  private blip(freq: number, at: number, wave: OscillatorType, vol: number): void {
    const ac = this.ac!;
    const osc = ac.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, at);

    const g = ac.createGain();
    const hold = Math.max(this.stepDur * 0.92, 0.09);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.006);
    g.gain.setValueAtTime(vol * 0.85, at + hold * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, at + hold);

    osc.connect(g).connect(this.master!);
    osc.start(at);
    osc.stop(at + hold + 0.02);
  }
}
