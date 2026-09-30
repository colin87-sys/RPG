/**
 * Generative synth-rock loop. 140 BPM, A minor, 16-bar loop (4 chords x 2 bars,
 * played twice; second half = variation B + fill). Four intensity layers:
 * pad (continuous legato detuned saws -> LP), bass pulse (1/8, filtered saw),
 * percussion (noise/sine kit), arpeggio (1/16). Stage flavour changes timbre,
 * progression and groove; tempo and key are fixed. Humanised timing and
 * velocity come from Rng seeded per (stage, bar).
 * Scheduler: setTimeout tick (25 ms) + ctx.currentTime lookahead (0.2 s).
 */
import { Rng, hashString } from '../../core/rng';
import { amp, chain, clamp, driveCurve, envAD, filt, midiToHz, noise, noiseBank, shaper, smoothstep, tone } from './dsp';
import { Mixer } from './mixer';

export type MusicStage = 'cloudgate' | 'violetTide' | 'wreckfield';
export const MUSIC_STAGES: readonly MusicStage[] = ['cloudgate', 'violetTide', 'wreckfield'];
export const MUSIC_BPM = 140;
export const MUSIC_KEY = 'A minor (Aeolian)';
export const STEPS_PER_BAR = 16;
export const LOOP_BARS = 16;
export const STEP_S = 60 / MUSIC_BPM / 4;
export const BAR_S = STEP_S * STEPS_PER_BAR;
/** one full loop in seconds (16 bars at 140 BPM = 27.43 s) */
export const LOOP_S = BAR_S * LOOP_BARS;

interface Chord {
  name: string;
  roman: string;
  bass: number;
  pad: number[];
  arp: number[];
}
const ch = (name: string, roman: string, bass: number, pad: number[], arp: number[]): Chord => ({ name, roman, bass, pad, arp });
const Am = ch('Am', 'i', 33, [57, 60, 64, 69], [69, 72, 76, 81]);
const F = ch('F', 'VI', 29, [57, 60, 65, 69], [65, 69, 72, 77]);
const C = ch('C', 'III', 36, [55, 60, 64, 67], [67, 72, 76, 79]);
const G = ch('G', 'VII', 31, [55, 59, 62, 67], [67, 71, 74, 79]);
const Dm = ch('Dm', 'iv', 38, [57, 62, 65, 69], [62, 65, 69, 74]);
const E2 = ch('E', 'V', 40, [56, 59, 64, 68], [64, 68, 71, 76]);
const E1 = ch('E', 'V', 28, [56, 59, 64, 68], [64, 68, 71, 76]);
const Bb = ch('Bb', 'bII', 34, [58, 62, 65, 70], [65, 70, 74, 77]);

export interface StageFlavour {
  progression: Chord[];
  bass: { wave: OscillatorType; cutoff: number; q: number; sub: number; drive: number; pattern: number[]; hi: number[] };
  arp: { wave: OscillatorType; cutoff: number; q: number; decay: number; octave: number; a: number[]; b: number[]; delay: number };
  pad: { wave: OscillatorType; detune: number; cutoff: number; q: number };
  drums: { kick: number[]; snare: number[]; hatHp: number; kickHi: number; kickLo: number; snareHz: number };
}

export const FLAVOURS: Record<MusicStage, StageFlavour> = {
  cloudgate: {
    progression: [Am, F, C, G],
    bass: { wave: 'sawtooth', cutoff: 1000, q: 5, sub: 0.5, drive: 1.2, pattern: [0, 0, 0, 0, 0, 0, 0, 0], hi: [0, 0, 12, 0, 0, 0, 12, 0] },
    arp: { wave: 'square', cutoff: 2600, q: 2, decay: 0.16, octave: 0, a: [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 4, 3, 2, 1], b: [0, 2, 1, 3, 2, 4, 3, 5, 0, 2, 1, 3, 2, 4, 3, 2], delay: 0.22 },
    pad: { wave: 'sawtooth', detune: 11, cutoff: 1800, q: 0.9 },
    drums: { kick: [0, 8, 10], snare: [4, 12], hatHp: 7500, kickHi: 150, kickLo: 46, snareHz: 190 },
  },
  violetTide: {
    progression: [Am, F, Dm, E2],
    bass: { wave: 'sawtooth', cutoff: 750, q: 3, sub: 0.8, drive: 1, pattern: [0, 0, 12, 0, 0, 0, 12, 0], hi: [0, 12, 0, 12, 0, 12, 7, 12] },
    arp: { wave: 'triangle', cutoff: 3200, q: 1, decay: 0.24, octave: 0, a: [0, -1, 2, 1, -1, 3, 2, -1, 0, -1, 2, 1, 4, 3, 2, -1], b: [4, -1, 3, 2, -1, 1, 2, -1, 3, -1, 2, 1, 0, 1, 2, -1], delay: 0.35 },
    pad: { wave: 'sawtooth', detune: 18, cutoff: 1300, q: 0.8 },
    drums: { kick: [0, 6, 8], snare: [4, 12], hatHp: 6500, kickHi: 130, kickLo: 44, snareHz: 175 },
  },
  wreckfield: {
    progression: [Am, Bb, G, E1],
    bass: { wave: 'square', cutoff: 650, q: 6, sub: 0.6, drive: 2, pattern: [0, 0, 0, 0, 0, 7, 0, 12], hi: [0, 12, 0, 0, 12, 7, 0, 12] },
    arp: { wave: 'sawtooth', cutoff: 1700, q: 4, decay: 0.12, octave: -12, a: [0, 0, -1, 2, 0, -1, 3, -1, 0, 0, -1, 1, 0, -1, 2, 3], b: [0, 0, -1, 2, 0, -1, 3, 4, 0, 0, -1, 1, 5, -1, 4, 3], delay: 0.18 },
    pad: { wave: 'sawtooth', detune: 25, cutoff: 950, q: 1.4 },
    drums: { kick: [0, 3, 8, 11], snare: [4, 12], hatHp: 9000, kickHi: 160, kickLo: 42, snareHz: 205 },
  },
};

/** Base (full) level of each layer, before the intensity curve. */
export const LAYER_LEVELS = { pad: 0.2, bass: 0.34, perc: 0.62, arp: 0.13 };

export interface LayerGains {
  pad: number;
  bass: number;
  perc: number;
  arp: number;
}
/** Intensity (0..1) -> layer gain multipliers (documented in Docs/AUDIO.md). */
export function layerGains(x: number, out: LayerGains = { pad: 0, bass: 0, perc: 0, arp: 0 }): LayerGains {
  out.pad = 1 - 0.25 * smoothstep(0.5, 1, x);
  out.bass = smoothstep(0.05, 0.35, x);
  out.perc = smoothstep(0.3, 0.6, x);
  out.arp = smoothstep(0.5, 0.8, x);
  return out;
}

// ------------------------------------------------------------------ voices
class Pad {
  private oscs: OscillatorNode[] = [];
  private filter: BiquadFilterNode;
  private out: GainNode;
  private cutoff: number;
  constructor(private ctx: BaseAudioContext, dest: AudioNode, fl: StageFlavour, chord: Chord, t0: number, energy: number, fadeIn: number) {
    const l = amp(ctx, 1 / 8), r = amp(ctx, 1 / 8);
    const pl = ctx.createStereoPanner(), pr = ctx.createStereoPanner();
    pl.pan.value = -0.45;
    pr.pan.value = 0.45;
    const sum = amp(ctx, 1);
    chain(l, pl, sum);
    chain(r, pr, sum);
    for (let v = 0; v < 4; v++)
      for (let k = 0; k < 2; k++) {
        const o = ctx.createOscillator();
        o.type = fl.pad.wave;
        o.frequency.setValueAtTime(midiToHz(chord.pad[v]), t0);
        o.detune.setValueAtTime((k ? 1 : -1) * fl.pad.detune + (v - 1.5) * 2, t0);
        o.connect(k ? r : l);
        o.start(t0);
        this.oscs.push(o);
      }
    this.cutoff = fl.pad.cutoff;
    this.filter = filt(ctx, 'lowpass', this.cutoff * (0.7 + 0.5 * energy), fl.pad.q);
    this.out = amp(ctx, 0);
    this.out.gain.setValueAtTime(0, t0);
    this.out.gain.linearRampToValueAtTime(1, t0 + fadeIn);
    chain(sum, this.filter, this.out, dest);
  }
  setChord(chord: Chord, t: number, energy: number): void {
    for (let v = 0; v < 4; v++)
      for (let k = 0; k < 2; k++) this.oscs[v * 2 + k].frequency.setTargetAtTime(midiToHz(chord.pad[v]), t, 0.03);
    const c = this.cutoff * (0.7 + 0.5 * energy);
    this.filter.frequency.setTargetAtTime(c * 1.7, t, 0.04);
    this.filter.frequency.setTargetAtTime(c, t + 0.3, 0.5);
  }
  stop(t: number, fade: number): void {
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, Math.max(0.005, fade / 4));
    for (const o of this.oscs) o.stop(t + fade + 0.05);
  }
}

/** One running arrangement (a stage flavour) on one context. */
class MusicGraph {
  readonly stage: MusicStage;
  private fl: StageFlavour;
  private master: GainNode;
  private layers: { pad: GainNode; bass: GainNode; perc: GainNode; arp: GainNode };
  private arpIn: GainNode;
  private kickIn: GainNode;
  private hatIn: GainNode;
  private bassIn: GainNode;
  private pad: Pad;
  private g: LayerGains = { pad: 0, bass: 0, perc: 0, arp: 0 };
  private x: number;
  private hum = new Float32Array(16 * 5);
  private kickMask = new Uint8Array(16);
  private snareMask = new Uint8Array(16);
  private nodes: AudioNode[] = [];
  private startT: number;

  constructor(private ctx: BaseAudioContext, dest: AudioNode, send: AudioNode | null, stage: MusicStage, private seed: number, t0: number, intensity: number, fadeIn: number, firstBar = 0) {
    this.stage = stage;
    this.fl = FLAVOURS[stage];
    this.x = clamp(intensity, 0, 1);
    this.startT = t0;
    for (const k of this.fl.drums.kick) this.kickMask[k] = 1;
    for (const k of this.fl.drums.snare) this.snareMask[k] = 1;
    const n = <T extends AudioNode>(v: T): T => (this.nodes.push(v), v);
    this.master = n(amp(ctx, 1));
    this.master.connect(dest);
    layerGains(this.x, this.g);
    this.layers = {
      pad: n(amp(ctx, LAYER_LEVELS.pad * this.g.pad)),
      bass: n(amp(ctx, LAYER_LEVELS.bass * this.g.bass)),
      perc: n(amp(ctx, LAYER_LEVELS.perc * this.g.perc)),
      arp: n(amp(ctx, LAYER_LEVELS.arp * this.g.arp)),
    };
    for (const k of ['pad', 'bass', 'perc', 'arp'] as const) this.layers[k].connect(this.master);
    // shared per-layer processing (one shaper / panner per layer, not per note)
    this.kickIn = n(amp(ctx, 1));
    chain(this.kickIn, n(shaper(ctx, driveCurve(1.6), 'none')), this.layers.perc);
    this.hatIn = n(amp(ctx, 1));
    const hp = n(ctx.createStereoPanner());
    hp.pan.value = 0.25;
    chain(this.hatIn, hp, this.layers.perc);
    this.bassIn = n(amp(ctx, 1));
    chain(this.bassIn, n(shaper(ctx, driveCurve(this.fl.bass.drive), 'none')), this.layers.bass);
    // arp: dotted-8th feedback delay (post layer gain, so it fades with the layer)
    this.arpIn = n(amp(ctx, 1));
    this.arpIn.connect(this.layers.arp);
    const delay = n(ctx.createDelay(1));
    delay.delayTime.value = STEP_S * 3;
    const fb = n(amp(ctx, 0.32));
    const dlp = n(filt(ctx, 'lowpass', 2500, 0.7));
    const wet = n(amp(ctx, this.fl.arp.delay));
    const wp = n(ctx.createStereoPanner());
    wp.pan.value = -0.3;
    this.layers.arp.connect(delay);
    chain(delay, dlp, fb, delay);
    chain(dlp, wet, wp, this.master);
    if (send) {
      const s = n(amp(ctx, 0.35));
      this.layers.pad.connect(s);
      this.layers.arp.connect(s);
      s.connect(send);
    }
    const bar = firstBar % LOOP_BARS;
    this.pad = new Pad(ctx, this.layers.pad, this.fl, this.chordAt(bar), t0, this.x, fadeIn);
  }

  private chordAt(bar: number): Chord {
    return this.fl.progression[(bar >> 1) % 4];
  }

  setIntensity(x: number, t: number, tc = 0.6): void {
    this.x = clamp(x, 0, 1);
    layerGains(this.x, this.g);
    const L = this.layers;
    L.pad.gain.setTargetAtTime(LAYER_LEVELS.pad * this.g.pad, t, tc);
    L.bass.gain.setTargetAtTime(LAYER_LEVELS.bass * this.g.bass, t, tc);
    L.perc.gain.setTargetAtTime(LAYER_LEVELS.perc * this.g.perc, t, tc);
    L.arp.gain.setTargetAtTime(LAYER_LEVELS.arp * this.g.arp, t, tc);
  }

  private beginBar(absBar: number, bar: number, t: number): void {
    const r = new Rng(hashString(`${this.stage}:${absBar}`, this.seed));
    const h = this.hum;
    for (let s = 0; s < 16; s++) {
      h[s * 5] = r.gauss(0.003); // hats
      h[s * 5 + 1] = r.gauss(0.002); // snare
      h[s * 5 + 2] = r.gauss(0.002); // arp
      h[s * 5 + 3] = r.gauss(0.0013); // bass / kick
      h[s * 5 + 4] = 0.86 + 0.14 * r.next(); // velocity
    }
    if (bar % 2 === 0 && t > this.startT + 0.001) this.pad.setChord(this.chordAt(bar), t, this.x);
  }

  /** Schedule absolute 16th-step n at context time t. */
  scheduleStep(n: number, t: number): void {
    const loopSteps = LOOP_BARS * 16;
    const sl = n % loopSteps;
    const bar = (sl / 16) | 0;
    const s = sl % 16;
    if (s === 0) this.beginBar((n / 16) | 0, bar, t);
    const ctx = this.ctx, fl = this.fl, x = this.x, h = this.hum, g = this.g;
    const T = (off: number) => Math.max(this.startT, t + off);
    const vel = h[s * 5 + 4];
    const chord = this.chordAt(bar);
    const half = bar >= 8;
    if (g.perc > 0.001) {
      const out = this.layers.perc;
      if (this.kickMask[s]) kick(ctx, this.kickIn, s === 0 ? t : T(h[s * 5 + 3]), vel, fl);
      const fill = x >= 0.7 && ((bar === 15 && s >= 8) || (bar === 7 && s >= 12));
      if (fill) snare(ctx, out, T(h[s * 5 + 1]), 0.35 + 0.45 * ((s - 8) / 7), fl, this.seed + n);
      else if (this.snareMask[s] && x >= 0.42) snare(ctx, out, T(h[s * 5 + 1]), vel, fl, this.seed + n);
      const open = s === 14 && bar % 2 === 1 && x >= 0.6;
      if (s % 2 === 0) hat(ctx, this.hatIn, T(h[s * 5]), (s % 4 === 2 ? 0.8 : 0.6) * vel, open, fl, this.seed + n);
      else if (x >= 0.85) hat(ctx, this.hatIn, T(h[s * 5]), 0.38 * vel, false, fl, this.seed + n);
      if (s === 0 && (bar === 0 || bar === 8) && x >= 0.75) crash(ctx, out, t, 0.7, this.seed + n);
    }
    if (g.bass > 0.001 && s % 2 === 0) {
      const pat = x >= 0.75 && half ? fl.bass.hi : fl.bass.pattern;
      bassNote(ctx, this.bassIn, s === 0 ? t : T(h[s * 5 + 3]), STEP_S * 2 * 0.82, chord.bass + pat[s >> 1], (s === 0 ? 1 : 0.9) * vel, fl, x);
    }
    if (g.arp > 0.001) {
      const k = (half ? fl.arp.b : fl.arp.a)[s];
      if (k >= 0) {
        const m = chord.arp[k % 4] + (k >= 4 ? 12 : 0) + fl.arp.octave;
        arpNote(ctx, this.arpIn, T(h[s * 5 + 2]), m, vel * (s % 4 === 0 ? 1 : 0.8), fl, x);
      }
    }
  }

  /** Fade the whole arrangement out from t over `fade` seconds and stop the pad. */
  fadeOut(t: number, fade: number): void {
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(1, t);
    this.master.gain.linearRampToValueAtTime(0, t + fade);
    this.pad.stop(t, fade);
  }

  disconnect(): void {
    for (const v of this.nodes) {
      try {
        v.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
}

// ------------------------------------------------------------------ kit + synth voices
function kick(ctx: BaseAudioContext, out: AudioNode, t: number, vel: number, fl: StageFlavour): void {
  const o = tone(ctx, 'sine', fl.drums.kickHi, t, t + 0.45);
  o.frequency.exponentialRampToValueAtTime(fl.drums.kickLo, t + 0.075);
  const g = amp(ctx);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.0015);
  g.gain.setValueAtTime(vel, t + 0.03);
  g.gain.exponentialRampToValueAtTime(vel * 1e-3, t + 0.42);
  g.gain.linearRampToValueAtTime(0, t + 0.43);
  chain(o, g, out);
  const n = noise(ctx, noiseBank(ctx).white, t, t + 0.03, new Rng((t * 1000) | 0));
  const hp = filt(ctx, 'highpass', 2500, 0.7);
  const ng = amp(ctx);
  envAD(ng.gain, t, 0.0005, 0.012, 0.18 * vel);
  chain(n, hp, ng, out);
}

function snare(ctx: BaseAudioContext, out: AudioNode, t: number, vel: number, fl: StageFlavour, seed: number): void {
  const n = noise(ctx, noiseBank(ctx).white, t, t + 0.25, new Rng(seed));
  const bp = filt(ctx, 'bandpass', 1900, 0.7);
  const hp = filt(ctx, 'highpass', 900, 0.7);
  const g = amp(ctx);
  envAD(g.gain, t, 0.001, 0.19, 0.55 * vel);
  chain(n, bp, hp, g, out);
  const o = tone(ctx, 'triangle', fl.drums.snareHz, t, t + 0.15);
  o.frequency.exponentialRampToValueAtTime(fl.drums.snareHz * 0.8, t + 0.04);
  const og = amp(ctx);
  envAD(og.gain, t, 0.001, 0.1, 0.35 * vel);
  chain(o, og, out);
}

function hat(ctx: BaseAudioContext, out: AudioNode, t: number, vel: number, open: boolean, fl: StageFlavour, seed: number): void {
  const d = open ? 0.3 : 0.045;
  const n = noise(ctx, noiseBank(ctx).white, t, t + d + 0.02, new Rng(seed));
  const hp = filt(ctx, 'highpass', fl.drums.hatHp, 0.8);
  const pk = filt(ctx, 'peaking', 10000, 1, 4);
  const g = amp(ctx);
  envAD(g.gain, t, 0.0005, d, 0.3 * vel);
  chain(n, hp, pk, g, out);
}

function crash(ctx: BaseAudioContext, out: AudioNode, t: number, vel: number, seed: number): void {
  const n = noise(ctx, noiseBank(ctx).white, t, t + 1.7, new Rng(seed));
  const hp = filt(ctx, 'highpass', 4500, 0.7);
  const g = amp(ctx);
  envAD(g.gain, t, 0.002, 1.6, 0.25 * vel);
  chain(n, hp, g, out);
}

function bassNote(ctx: BaseAudioContext, out: AudioNode, t: number, dur: number, midi: number, vel: number, fl: StageFlavour, energy: number): void {
  const f = midiToHz(midi);
  const o = tone(ctx, fl.bass.wave, f, t, t + dur + 0.04);
  const sub = tone(ctx, 'sine', f, t, t + dur + 0.04);
  const sg = amp(ctx, fl.bass.sub);
  const cut = fl.bass.cutoff * (0.7 + 0.6 * energy);
  const lp = filt(ctx, 'lowpass', cut * 2.2, fl.bass.q);
  lp.frequency.setValueAtTime(cut * 2.2, t);
  lp.frequency.exponentialRampToValueAtTime(cut * 0.45, t + 0.12);
  const g = amp(ctx);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.004);
  g.gain.exponentialRampToValueAtTime(vel * 0.55, t + dur);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.025);
  chain(o, lp);
  chain(sub, sg, lp);
  chain(lp, g, out);
}

function arpNote(ctx: BaseAudioContext, out: AudioNode, t: number, midi: number, vel: number, fl: StageFlavour, energy: number): void {
  const d = fl.arp.decay;
  const o = tone(ctx, fl.arp.wave, midiToHz(midi), t, t + d + 0.02);
  const cut = fl.arp.cutoff * (0.6 + 0.8 * energy);
  const lp = filt(ctx, 'lowpass', cut * 2, fl.arp.q);
  lp.frequency.setValueAtTime(cut * 2, t);
  lp.frequency.exponentialRampToValueAtTime(cut, t + 0.06);
  const g = amp(ctx);
  envAD(g.gain, t, 0.002, d, vel);
  chain(o, lp, g, out);
}

// ------------------------------------------------------------------ player
const LOOKAHEAD_S = 0.2;
const TICK_MS = 25;

export class MusicPlayer {
  private graph: MusicGraph | null = null;
  private _stage: MusicStage = 'cloudgate';
  private _intensity = 0.3;
  private _playing = false;
  private pendingStage: MusicStage | null = null;
  private step = 0;
  private nextTime = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: BaseAudioContext | null,
    private readonly dest: AudioNode | null,
    private readonly send: AudioNode | null = null,
    private readonly seed = 1,
  ) {}

  get playing(): boolean {
    return this._playing;
  }
  get stage(): MusicStage {
    return this._stage;
  }
  get intensity(): number {
    return this._intensity;
  }

  start(): void {
    if (!this.ctx || !this.dest || this._playing) return;
    this._playing = true;
    const t0 = this.ctx.currentTime + 0.06;
    this.step = 0;
    this.nextTime = t0;
    this.pendingStage = null;
    this.graph = new MusicGraph(this.ctx, this.dest, this.send, this._stage, this.seed, t0, this._intensity, 0.02);
    this.tick();
  }

  stop(fadeS = 0.8): void {
    if (!this._playing) return;
    this._playing = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const g = this.graph;
    this.graph = null;
    if (g && this.ctx) this.retire(g, this.ctx.currentTime, Math.max(0.02, fadeS));
  }

  setIntensity(x: number): void {
    this._intensity = clamp(x, 0, 1);
    if (this.graph && this.ctx) this.graph.setIntensity(this._intensity, this.ctx.currentTime);
  }

  /** Change flavour; while playing, crossfades at the next bar line (bar position is kept). */
  setStage(id: MusicStage): void {
    if (!FLAVOURS[id]) return;
    if (this._playing) {
      if (id !== (this.graph?.stage ?? this._stage)) this.pendingStage = id;
      else this.pendingStage = null;
    }
    this._stage = id;
  }

  dispose(): void {
    this.stop(0.05);
  }

  private retire(g: MusicGraph, t: number, fade: number): void {
    g.fadeOut(t, fade);
    setTimeout(() => g.disconnect(), (fade + 0.5) * 1000);
  }

  private tick = (): void => {
    if (!this._playing || !this.ctx || !this.dest || !this.graph) return;
    const now = this.ctx.currentTime;
    if (this.nextTime < now - 0.05) {
      const skip = Math.ceil((now - this.nextTime) / STEP_S);
      this.step += skip;
      this.nextTime += skip * STEP_S;
    }
    while (this.nextTime < now + LOOKAHEAD_S) {
      if (this.pendingStage && this.step % 16 === 0) {
        const old = this.graph;
        this.graph = new MusicGraph(this.ctx, this.dest, this.send, this.pendingStage, this.seed, this.nextTime, this._intensity, BAR_S * 0.5, this.step / 16);
        this.retire(old, this.nextTime, BAR_S * 0.5);
        this.pendingStage = null;
      }
      this.graph.scheduleStep(this.step, this.nextTime);
      this.step++;
      this.nextTime += STEP_S;
    }
    this.timer = setTimeout(this.tick, TICK_MS);
  };
}

export interface OfflineMusicOptions {
  seed?: number;
  /** context time at which the loop's bar 0 starts (silent pre-roll before it) */
  startAt?: number;
  /** called with the mixer before rendering (e.g. to schedule a duck) */
  onMixer?: (mixer: Mixer) => void;
}

/**
 * Render `seconds` of the loop (from bar 0, starting at opts.startAt) into an
 * OfflineAudioContext through the game's own mixer chain. Returns the buffer.
 */
export async function renderLoopOffline(
  ctx: OfflineAudioContext,
  seconds: number,
  intensity: number,
  stage: MusicStage,
  opts: OfflineMusicOptions = {},
): Promise<AudioBuffer> {
  const t0 = opts.startAt ?? 0;
  const mixer = new Mixer(ctx);
  opts.onMixer?.(mixer);
  const g = new MusicGraph(ctx, mixer.music, mixer.musicReverb, stage, opts.seed ?? 1, t0, intensity, 0.01);
  const steps = Math.ceil(seconds / STEP_S);
  for (let n = 0; n < steps; n++) g.scheduleStep(n, t0 + n * STEP_S);
  g.fadeOut(Math.max(t0, t0 + seconds - 0.03), 0.03);
  return ctx.startRendering();
}
