/**
 * SFX recipes (oscillator + noise + filter + envelope [+ waveshaper]).
 * Each recipe is `(ctx, out, t0, params) => SfxVoice` and works in both
 * AudioContext and OfflineAudioContext. Variation is seeded (params.rng).
 * Tonal cues are consonant with the music key (A minor): parry chime A5/E6/A6,
 * lock tones on the A minor pentatonic, pickup on C major (relative major).
 */
import { Rng } from '../../core/rng';
import { amp, chain, driveCurve, envAD, envASR, filt, glide, holdAt, midiToHz, noise, noiseBank, shaper, tone } from './dsp';

export const SFX_NAMES = [
  'cannon', 'lockTone', 'missileLaunch', 'missileImpact', 'explosionSmall', 'explosionBig', 'parry',
  'rollWhoosh', 'driftWhine', 'wingtrail', 'shieldRefill', 'hitTaken', 'warning', 'uiMove', 'uiConfirm',
  'bossBeamCharge', 'laserTelegraph', 'pickup', 'stageClear', 'gameOver',
] as const;
export type SfxName = (typeof SFX_NAMES)[number];

export interface SfxParams {
  /** frequency multiplier (1 = nominal) */
  pitch: number;
  /** linear gain multiplier on the nominal level */
  gain: number;
  /** seeded variation stream */
  rng: Rng;
  /** sustained sounds (driftWhine, bossBeamCharge, laserTelegraph): scheduled length in seconds */
  durationS?: number;
}

export interface SfxVoice {
  /** context time when every node of the voice has stopped */
  end: number;
  /** early release for sustained sounds */
  release?: (at: number) => void;
}

export type SfxRecipe = (ctx: BaseAudioContext, out: AudioNode, t0: number, p: SfxParams) => SfxVoice;

export interface SfxInfo {
  /** nominal length in seconds (sustained: default length) */
  durationS: number;
  bus: 'sfx' | 'ui';
  maxVoices: number;
  /** repeats closer than this are dropped (same-frame pile-ups) */
  minGapS: number;
  /** auto-duck of the music bus */
  duck?: { db: number; s: number };
  sustained?: boolean;
  summary: string;
  event: string;
}

export const SFX_INFO: Record<SfxName, SfxInfo> = {
  cannon: { durationS: 0.07, bus: 'sfx', maxVoices: 3, minGapS: 0.035, summary: 'HP white-noise snap + square chirp 2.4k->820 Hz + 210->95 Hz body, 60 ms', event: 'cannonFire' },
  lockTone: { durationS: 0.14, bus: 'sfx', maxVoices: 4, minGapS: 0.04, summary: 'triangle+sine blip gliding up 3 semitones into A minor pentatonic step (pitch = lockPitch(index))', event: 'lockAdded' },
  missileLaunch: { durationS: 1.0, bus: 'sfx', maxVoices: 4, minGapS: 0.05, summary: 'ignition pop (BP noise + 150->60 Hz thump) + pink-noise whoosh sweeping 500->3.2k->1.6k Hz + rising saw rocket tone', event: 'missileFire' },
  missileImpact: { durationS: 0.6, bus: 'sfx', maxVoices: 6, minGapS: 0.03, summary: 'HP crack + brown-noise body (LP 900->300 Hz) + 125->44 Hz thump', event: 'missileHit' },
  explosionSmall: { durationS: 0.9, bus: 'sfx', maxVoices: 6, minGapS: 0.03, summary: 'pink burst LP 3.8k->450 Hz + 100->36 Hz thump + HP crackle', event: 'enemyKilled (big=false)' },
  explosionBig: { durationS: 2.6, bus: 'sfx', maxVoices: 3, minGapS: 0.08, duck: { db: 6, s: 0.7 }, summary: 'sub thump 68->28 Hz saturated + brown burst LP 5.2k->260 Hz + BP crack + crackle tail + pink rumble', event: 'enemyKilled (big=true)' },
  parry: { durationS: 1.3, bus: 'sfx', maxVoices: 2, minGapS: 0.06, duck: { db: 5, s: 0.35 }, summary: 'harmonic chime A5 E6 A6 E7 A7 (beating copy) + HP noise ting', event: 'parry' },
  rollWhoosh: { durationS: 0.55, bus: 'sfx', maxVoices: 2, minGapS: 0.08, summary: 'pink noise BP 380->2.4k->700 Hz with 19 Hz rotor flutter + air band', event: 'roll (and boost at pitch 0.75)' },
  driftWhine: { durationS: 1.4, bus: 'sfx', maxVoices: 1, minGapS: 0.1, sustained: true, summary: 'spool-up 0.55->1x of 660 Hz detuned saws + 2nd-harmonic sine, 6.2 Hz vibrato, BP 1.4k + turbine noise band; stationary sustain, loopable via hold()', event: 'drift {active}' },
  wingtrail: { durationS: 1.5, bus: 'sfx', maxVoices: 1, minGapS: 0.2, summary: 'resonant saw sweep 110->880 Hz / LP 300->7k + pink whoosh + tremolo shimmer A6 E7 A7', event: 'wingtrail' },
  shieldRefill: { durationS: 0.75, bus: 'sfx', maxVoices: 2, minGapS: 0.15, summary: 'soft sine+triangle rise 330->880 Hz, 16 Hz tremolo, LP 3k', event: 'shieldRefill / comboChanged {refill}' },
  hitTaken: { durationS: 0.55, bus: 'sfx', maxVoices: 2, minGapS: 0.06, summary: 'saturated brown-noise crunch LP 1.3k + 160->55 Hz thump + two C6 alarm blips', event: 'playerHit' },
  warning: { durationS: 1.05, bus: 'sfx', maxVoices: 1, minGapS: 0.5, duck: { db: 8, s: 1.0 }, summary: 'klaxon: 2 pulses of saw A4->C5 whoop + square fifth, saturated, BP 1.2k', event: 'warning {on}' },
  uiMove: { durationS: 0.06, bus: 'ui', maxVoices: 2, minGapS: 0.03, summary: 'A6 triangle tick + HP noise tick, 40 ms', event: 'uiMove' },
  uiConfirm: { durationS: 0.32, bus: 'ui', maxVoices: 2, minGapS: 0.05, summary: 'two-note square blip E6 -> A6 with sine body', event: 'uiConfirm' },
  bossBeamCharge: { durationS: 2.0, bus: 'sfx', maxVoices: 2, minGapS: 0.2, sustained: true, summary: 'saw+square fifth rising 70->560 Hz, resonant LP 220->6.5k, tremolo 5->30 Hz, rising noise band, crescendo', event: 'bossPhase / boss beam telegraph' },
  laserTelegraph: { durationS: 0.7, bus: 'sfx', maxVoices: 3, minGapS: 0.05, sustained: true, summary: 'thin sine pair 2.3->2.75 kHz (9 Hz beat) + 34 Hz vibrato, HP 1.2k', event: 'laserTelegraph' },
  pickup: { durationS: 0.42, bus: 'sfx', maxVoices: 3, minGapS: 0.05, summary: 'C6 E6 G6 C7 triangle arpeggio with octave sparkle', event: 'pickup' },
  stageClear: { durationS: 2.8, bus: 'sfx', maxVoices: 1, minGapS: 1, summary: 'brass-saw stabs F -> G -> A major (bVI-bVII-I) + bass + cymbal swell + shimmer', event: 'stageClear' },
  gameOver: { durationS: 3.0, bus: 'sfx', maxVoices: 1, minGapS: 1, summary: 'descending E4 C4 A3 with closing LP + A/E drone tape-stop + brown wash', event: 'playerDown' },
};

/** A minor pentatonic steps above A5 for lock index 0..7. */
export const LOCK_STEPS = [0, 3, 5, 7, 10, 12, 15, 17] as const;
/** Pitch multiplier for the lock tone of lock `index` (0-based). */
export function lockPitch(index: number): number {
  const i = Math.max(0, Math.min(LOCK_STEPS.length - 1, Math.floor(index)));
  return Math.pow(2, LOCK_STEPS[i] / 12);
}

// ------------------------------------------------------------------ recipes
const jit = (p: SfxParams, j: number): number => p.pitch * p.rng.range(1 - j, 1 + j);

const cannon: SfxRecipe = (ctx, out, t0, p) => {
  const P = jit(p, 0.05), G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const end = t0 + 0.07;
  const n = noise(ctx, nb.white, t0, end, r);
  const hp = filt(ctx, 'highpass', 2600 * P, 0.8);
  const pk = filt(ctx, 'peaking', 5200 * P, 1.2, 6);
  const ng = amp(ctx);
  envAD(ng.gain, t0, 0.0008, 0.028, 0.5 * G);
  chain(n, hp, pk, ng, out);
  const o = tone(ctx, 'square', 2400 * P, t0, end);
  o.frequency.exponentialRampToValueAtTime(820 * P, t0 + 0.025);
  const lp = filt(ctx, 'lowpass', 6000, 0.7);
  const og = amp(ctx);
  envAD(og.gain, t0, 0.0008, 0.035, 0.14 * G);
  chain(o, lp, og, out);
  const b = tone(ctx, 'sine', 210 * P, t0, end);
  b.frequency.exponentialRampToValueAtTime(95 * P, t0 + 0.04);
  const bg = amp(ctx);
  envAD(bg.gain, t0, 0.001, 0.05, 0.3 * G);
  chain(b, bg, out);
  return { end };
};

const lockTone: SfxRecipe = (ctx, out, t0, p) => {
  const f = 880 * p.pitch, G = p.gain;
  const end = t0 + 0.14;
  const o = tone(ctx, 'triangle', f * 0.84, t0, end);
  o.frequency.exponentialRampToValueAtTime(f, t0 + 0.025);
  const o2 = tone(ctx, 'sine', f * 2 * 0.84, t0, end);
  o2.frequency.exponentialRampToValueAtTime(f * 2, t0 + 0.025);
  const g = amp(ctx);
  envAD(g.gain, t0, 0.003, 0.11, 0.42 * G);
  const g2 = amp(ctx);
  envAD(g2.gain, t0, 0.003, 0.06, 0.12 * G);
  chain(o, g, out);
  chain(o2, g2, out);
  return { end };
};

const missileLaunch: SfxRecipe = (ctx, out, t0, p) => {
  const P = jit(p, 0.06), G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const end = t0 + 1.0;
  const n1 = noise(ctx, nb.white, t0, t0 + 0.12, r);
  const bp1 = filt(ctx, 'bandpass', 1300 * P, 0.9);
  const g1 = amp(ctx);
  envAD(g1.gain, t0, 0.001, 0.09, 0.9 * G);
  chain(n1, bp1, g1, out);
  const th = tone(ctx, 'sine', 150 * P, t0, t0 + 0.2);
  th.frequency.exponentialRampToValueAtTime(60 * P, t0 + 0.12);
  const gt = amp(ctx);
  envAD(gt.gain, t0, 0.002, 0.16, 0.45 * G);
  chain(th, gt, out);
  const n2 = noise(ctx, nb.pink, t0, end, r);
  const bp2 = filt(ctx, 'bandpass', 500 * P, 1.3);
  glide(bp2.frequency, 500 * P, 3200 * P, t0, t0 + 0.5);
  bp2.frequency.exponentialRampToValueAtTime(1600 * P, t0 + 0.98);
  const g2 = amp(ctx);
  g2.gain.setValueAtTime(0, t0);
  g2.gain.linearRampToValueAtTime(1.4 * G, t0 + 0.12);
  g2.gain.exponentialRampToValueAtTime(Math.max(1e-5, 1.4 * G * 1e-3), end - 0.01);
  g2.gain.linearRampToValueAtTime(0, end);
  chain(n2, bp2, g2, out);
  const rt = tone(ctx, 'sawtooth', 170 * P, t0 + 0.02, end);
  rt.frequency.exponentialRampToValueAtTime(330 * P, t0 + 0.6);
  const lp = filt(ctx, 'lowpass', 1400 * P, 1);
  const g3 = amp(ctx);
  envAD(g3.gain, t0 + 0.02, 0.04, 0.8, 0.1 * G);
  chain(rt, lp, g3, out);
  return { end };
};

const missileImpact: SfxRecipe = (ctx, out, t0, p) => {
  const P = jit(p, 0.08), G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const end = t0 + 0.6;
  const n = noise(ctx, nb.white, t0, t0 + 0.1, r);
  const hp = filt(ctx, 'highpass', 1800 * P, 0.7);
  const g = amp(ctx);
  envAD(g.gain, t0, 0.001, 0.07, 0.7 * G);
  chain(n, hp, g, out);
  const b = noise(ctx, nb.brown, t0, end, r);
  const lp = filt(ctx, 'lowpass', 900 * P, 0.9);
  glide(lp.frequency, 900 * P, 300 * P, t0, t0 + 0.35);
  const bg = amp(ctx);
  envAD(bg.gain, t0, 0.003, 0.45, 1.1 * G);
  chain(b, lp, bg, out);
  const th = tone(ctx, 'sine', 125 * P, t0, end);
  th.frequency.exponentialRampToValueAtTime(44 * P, t0 + 0.16);
  const tg = amp(ctx);
  envAD(tg.gain, t0, 0.002, 0.4, 0.7 * G);
  chain(th, tg, out);
  return { end };
};

const explosionSmall: SfxRecipe = (ctx, out, t0, p) => {
  const P = jit(p, 0.08), G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const end = t0 + 0.9;
  const n = noise(ctx, nb.pink, t0, end, r);
  const lp = filt(ctx, 'lowpass', 3800 * P, 0.8);
  glide(lp.frequency, 3800 * P, 450 * P, t0, t0 + 0.5);
  const g = amp(ctx);
  envAD(g.gain, t0, 0.003, 0.75, 1.1 * G);
  chain(n, lp, g, out);
  const th = tone(ctx, 'sine', 100 * P, t0, end);
  th.frequency.exponentialRampToValueAtTime(36 * P, t0 + 0.3);
  const tg = amp(ctx);
  envAD(tg.gain, t0, 0.002, 0.5, 0.75 * G);
  chain(th, tg, out);
  const c = noise(ctx, nb.crackle, t0, end, r);
  const hp = filt(ctx, 'highpass', 2200 * P, 0.7);
  const cg = amp(ctx);
  cg.gain.setValueAtTime(0, t0);
  cg.gain.linearRampToValueAtTime(0.5 * G, t0 + 0.1);
  cg.gain.exponentialRampToValueAtTime(Math.max(1e-5, 0.5 * G * 1e-3), end - 0.05);
  cg.gain.linearRampToValueAtTime(0, end - 0.04);
  chain(c, hp, cg, out);
  return { end };
};

const explosionBig: SfxRecipe = (ctx, out, t0, p) => {
  const P = jit(p, 0.06), G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const end = t0 + 2.6;
  // sub thump, saturated for small-speaker harmonics
  const sub = tone(ctx, 'sine', 68 * P, t0, end);
  sub.frequency.exponentialRampToValueAtTime(28 * P, t0 + 0.7);
  const sg = amp(ctx);
  envAD(sg.gain, t0, 0.004, 1.4, 0.9 * G);
  const sat = shaper(ctx, driveCurve(2.5));
  const slp = filt(ctx, 'lowpass', 500, 0.7);
  chain(sub, sg, sat, slp, out);
  // noise burst
  const b = noise(ctx, nb.brown, t0, end, r);
  const blp = filt(ctx, 'lowpass', 5200 * P, 0.7);
  glide(blp.frequency, 5200 * P, 260 * P, t0, t0 + 1.4);
  const bg = amp(ctx);
  envAD(bg.gain, t0, 0.006, 2.0, 1.3 * G);
  chain(b, blp, bg, out);
  // crack
  const w = noise(ctx, nb.white, t0, t0 + 0.4, r);
  const bp = filt(ctx, 'bandpass', 1600 * P, 0.7);
  const wg = amp(ctx);
  envAD(wg.gain, t0, 0.001, 0.3, 0.6 * G);
  chain(w, bp, wg, out);
  // crackle tail
  const c = noise(ctx, nb.crackle, t0, end, r);
  const chp = filt(ctx, 'highpass', 1500, 0.7);
  const cpk = filt(ctx, 'peaking', 4000, 1, 4);
  const cg = amp(ctx);
  cg.gain.setValueAtTime(0, t0);
  cg.gain.linearRampToValueAtTime(0.55 * G, t0 + 0.35);
  cg.gain.exponentialRampToValueAtTime(Math.max(1e-5, 0.55 * G * 1e-3), end - 0.1);
  cg.gain.linearRampToValueAtTime(0, end - 0.09);
  chain(c, chp, cpk, cg, out);
  // rumble
  const ru = noise(ctx, nb.pink, t0, end, r);
  const rlp = filt(ctx, 'lowpass', 180, 0.7);
  const rg = amp(ctx);
  envAD(rg.gain, t0, 0.05, 2.3, 0.6 * G);
  chain(ru, rlp, rg, out);
  return { end };
};

const parry: SfxRecipe = (ctx, out, t0, p) => {
  const f = 880 * p.pitch, G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const end = t0 + 1.3;
  const ratios = [1, 1.5, 2, 3, 4];
  const amps = [0.4, 0.26, 0.24, 0.13, 0.08];
  const decays = [1.2, 0.9, 0.8, 0.5, 0.35];
  for (let i = 0; i < ratios.length; i++) {
    const o = tone(ctx, 'sine', f * ratios[i], t0, end);
    const g = amp(ctx);
    envAD(g.gain, t0, 0.002, decays[i], amps[i] * G);
    chain(o, g, out);
  }
  const o2 = tone(ctx, 'sine', f * 2, t0, end, 6);
  const g2 = amp(ctx);
  envAD(g2.gain, t0, 0.002, 0.9, 0.12 * G);
  chain(o2, g2, out);
  const n = noise(ctx, nb.white, t0, t0 + 0.06, r);
  const hp = filt(ctx, 'highpass', 6000, 0.7);
  const ng = amp(ctx);
  envAD(ng.gain, t0, 0.0005, 0.03, 0.35 * G);
  chain(n, hp, ng, out);
  return { end };
};

const rollWhoosh: SfxRecipe = (ctx, out, t0, p) => {
  const P = jit(p, 0.06), G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const end = t0 + 0.55;
  const n = noise(ctx, nb.pink, t0, end, r);
  const bp = filt(ctx, 'bandpass', 380 * P, 1.6);
  glide(bp.frequency, 380 * P, 2400 * P, t0, t0 + 0.22);
  bp.frequency.exponentialRampToValueAtTime(700 * P, t0 + 0.5);
  const flutter = amp(ctx, 0.65);
  const lfo = tone(ctx, 'sine', 19, t0, end);
  const depth = amp(ctx, 0.35);
  chain(lfo, depth);
  depth.connect(flutter.gain);
  const g = amp(ctx);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(2.2 * G, t0 + 0.2);
  g.gain.exponentialRampToValueAtTime(Math.max(1e-5, 2.2 * G * 1e-3), end - 0.01);
  g.gain.linearRampToValueAtTime(0, end);
  chain(n, bp, flutter, g, out);
  const a = noise(ctx, nb.white, t0, end, r);
  const bp2 = filt(ctx, 'bandpass', 760 * P, 3);
  glide(bp2.frequency, 760 * P, 4800 * P, t0, t0 + 0.22);
  bp2.frequency.exponentialRampToValueAtTime(1400 * P, t0 + 0.5);
  const ag = amp(ctx, 0.3);
  chain(a, bp2, ag, g);
  return { end };
};

const driftWhine: SfxRecipe = (ctx, out, t0, p) => {
  const P = jit(p, 0.02), G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const dur = p.durationS ?? SFX_INFO.driftWhine.durationS;
  const f = 660 * P;
  const stopAt = t0 + dur + 0.3;
  const o1 = tone(ctx, 'sawtooth', f * 0.55, t0, stopAt);
  const o2 = tone(ctx, 'sawtooth', f * 0.55 * 1.006, t0, stopAt);
  const o3 = tone(ctx, 'sine', f * 1.1, t0, stopAt);
  o1.frequency.exponentialRampToValueAtTime(f, t0 + 0.35);
  o2.frequency.exponentialRampToValueAtTime(f * 1.006, t0 + 0.35);
  o3.frequency.exponentialRampToValueAtTime(f * 2, t0 + 0.35);
  const lfo = tone(ctx, 'sine', 6.2, t0, stopAt);
  const vib = amp(ctx, 14);
  lfo.connect(vib);
  vib.connect(o1.detune);
  vib.connect(o2.detune);
  vib.connect(o3.detune);
  const bp = filt(ctx, 'bandpass', 1400 * P, 2.5);
  const sg = amp(ctx, 0.5);
  chain(o1, bp);
  chain(o2, bp);
  chain(bp, sg);
  const hg = amp(ctx, 0.12);
  chain(o3, hg);
  const tn = noise(ctx, nb.white, t0, stopAt, r);
  const tbp = filt(ctx, 'bandpass', 3400 * P, 5);
  const tg = amp(ctx, 0.35);
  chain(tn, tbp, tg);
  const env = amp(ctx);
  sg.connect(env);
  hg.connect(env);
  tg.connect(env);
  env.connect(out);
  const pk = 0.9 * G;
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(pk, t0 + 0.08);
  env.gain.setValueAtTime(pk, t0 + dur);
  env.gain.linearRampToValueAtTime(0, t0 + dur + 0.25);
  const srcs = [o1, o2, o3, lfo, tn];
  return {
    end: stopAt,
    release: (at: number) => {
      holdAt(env.gain, at, pk);
      env.gain.linearRampToValueAtTime(0, at + 0.2);
      for (const s of srcs) s.stop(at + 0.25);
    },
  };
};

const wingtrail: SfxRecipe = (ctx, out, t0, p) => {
  const P = jit(p, 0.02), G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const end = t0 + 1.5;
  const s1 = tone(ctx, 'sawtooth', 110 * P, t0, end);
  const s2 = tone(ctx, 'sawtooth', 110 * P * 1.01, t0, end);
  s1.frequency.exponentialRampToValueAtTime(880 * P, t0 + 0.9);
  s2.frequency.exponentialRampToValueAtTime(880 * P * 1.01, t0 + 0.9);
  const lp = filt(ctx, 'lowpass', 300, 7);
  glide(lp.frequency, 300, 7000, t0, t0 + 0.9);
  const sg = amp(ctx);
  sg.gain.setValueAtTime(0, t0);
  sg.gain.linearRampToValueAtTime(0.22 * G, t0 + 0.08);
  sg.gain.setValueAtTime(0.22 * G, t0 + 0.9);
  sg.gain.exponentialRampToValueAtTime(Math.max(1e-5, 0.22 * G * 1e-3), t0 + 1.4);
  sg.gain.linearRampToValueAtTime(0, t0 + 1.41);
  chain(s1, lp);
  chain(s2, lp);
  chain(lp, sg, out);
  const n = noise(ctx, nb.pink, t0, end, r);
  const bp = filt(ctx, 'bandpass', 400, 0.9);
  glide(bp.frequency, 400, 4200, t0, t0 + 0.9);
  const ng = amp(ctx);
  ng.gain.setValueAtTime(0, t0);
  ng.gain.linearRampToValueAtTime(1.0 * G, t0 + 0.7);
  ng.gain.exponentialRampToValueAtTime(Math.max(1e-5, 1e-3 * G), t0 + 1.3);
  ng.gain.linearRampToValueAtTime(0, t0 + 1.31);
  chain(n, bp, ng, out);
  const trem = amp(ctx, 0.5);
  const lfo = tone(ctx, 'sine', 12, t0, end);
  const dep = amp(ctx, 0.5);
  chain(lfo, dep);
  dep.connect(trem.gain);
  const sh = amp(ctx);
  sh.gain.setValueAtTime(0, t0 + 0.35);
  sh.gain.linearRampToValueAtTime(0.5 * G, t0 + 0.9);
  sh.gain.exponentialRampToValueAtTime(Math.max(1e-5, 0.5 * G * 1e-3), t0 + 1.49);
  sh.gain.linearRampToValueAtTime(0, end);
  for (const [hz, a, det] of [[1760, 0.3, 0], [1760, 0.2, 7], [2637, 0.2, -5], [3520, 0.12, 4]] as const) {
    const o = tone(ctx, 'sine', hz * P, t0 + 0.3, end, det);
    const g = amp(ctx, a);
    chain(o, g, trem);
  }
  chain(trem, sh, out);
  return { end };
};

const shieldRefill: SfxRecipe = (ctx, out, t0, p) => {
  const P = p.pitch, G = p.gain;
  const end = t0 + 0.75;
  const o = tone(ctx, 'sine', 330 * P, t0, end);
  const o2 = tone(ctx, 'triangle', 660 * P, t0, end);
  o.frequency.exponentialRampToValueAtTime(880 * P, t0 + 0.55);
  o2.frequency.exponentialRampToValueAtTime(1760 * P, t0 + 0.55);
  const g2 = amp(ctx, 0.25);
  chain(o2, g2);
  const lp = filt(ctx, 'lowpass', 3000, 0.7);
  o.connect(lp);
  g2.connect(lp);
  const trem = amp(ctx, 0.75);
  const lfo = tone(ctx, 'sine', 16, t0, end);
  const dep = amp(ctx, 0.25);
  chain(lfo, dep);
  dep.connect(trem.gain);
  const g = amp(ctx);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.45 * G, t0 + 0.4);
  g.gain.exponentialRampToValueAtTime(Math.max(1e-5, 0.45 * G * 1e-3), t0 + 0.72);
  g.gain.linearRampToValueAtTime(0, t0 + 0.73);
  chain(lp, trem, g, out);
  return { end };
};

const hitTaken: SfxRecipe = (ctx, out, t0, p) => {
  const P = jit(p, 0.06), G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const end = t0 + 0.55;
  const b = noise(ctx, nb.brown, t0, t0 + 0.35, r);
  const pre = amp(ctx, 3);
  const sat = shaper(ctx, driveCurve(5));
  const lp = filt(ctx, 'lowpass', 1300 * P, 1.2);
  const bg = amp(ctx);
  envAD(bg.gain, t0, 0.002, 0.25, 0.55 * G);
  chain(b, pre, sat, lp, bg, out);
  const w = noise(ctx, nb.white, t0, t0 + 0.15, r);
  const bp = filt(ctx, 'bandpass', 700 * P, 1);
  const wg = amp(ctx);
  envAD(wg.gain, t0, 0.001, 0.12, 0.35 * G);
  chain(w, bp, wg, out);
  const th = tone(ctx, 'sine', 160 * P, t0, t0 + 0.35);
  th.frequency.exponentialRampToValueAtTime(55 * P, t0 + 0.12);
  const tg = amp(ctx);
  envAD(tg.gain, t0, 0.002, 0.28, 0.8 * G);
  chain(th, tg, out);
  const al = tone(ctx, 'square', midiToHz(84), t0 + 0.15, end);
  const abp = filt(ctx, 'bandpass', 1400, 2);
  const ag = amp(ctx);
  ag.gain.setValueAtTime(0, t0);
  envASR(ag.gain, t0 + 0.16, 0.003, t0 + 0.215, 0.008, 0.22 * G);
  envASR(ag.gain, t0 + 0.27, 0.003, t0 + 0.325, 0.008, 0.22 * G);
  chain(al, abp, ag, out);
  return { end };
};

const warning: SfxRecipe = (ctx, out, t0, p) => {
  const P = p.pitch, G = p.gain;
  const end = t0 + 1.05;
  const o1 = tone(ctx, 'sawtooth', 440 * P, t0, end);
  const o2 = tone(ctx, 'square', 660 * P, t0, end);
  const g2 = amp(ctx, 0.35);
  chain(o2, g2);
  const mixN = amp(ctx, 0.6);
  o1.connect(mixN);
  g2.connect(mixN);
  const sat = shaper(ctx, driveCurve(3));
  const bp = filt(ctx, 'bandpass', 1200, 1.1);
  const lp = filt(ctx, 'lowpass', 3500, 0.7);
  const env = amp(ctx);
  env.gain.setValueAtTime(0, t0);
  for (let k = 0; k < 2; k++) {
    const ts = t0 + k * 0.52, te = ts + 0.4;
    glide(o1.frequency, 440 * P, 523.25 * P, ts, ts + 0.3);
    glide(o2.frequency, 660 * P, 784 * P, ts, ts + 0.3);
    envASR(env.gain, ts, 0.015, te - 0.04, 0.04, 0.55 * G);
  }
  chain(mixN, sat, bp, lp, env, out);
  return { end };
};

const uiMove: SfxRecipe = (ctx, out, t0, p) => {
  const G = p.gain, nb = noiseBank(ctx);
  const end = t0 + 0.06;
  const o = tone(ctx, 'triangle', 1760 * p.pitch, t0, end);
  const g = amp(ctx);
  envAD(g.gain, t0, 0.001, 0.05, 0.9 * G);
  chain(o, g, out);
  const n = noise(ctx, nb.white, t0, t0 + 0.02, p.rng);
  const hp = filt(ctx, 'highpass', 6000, 0.7);
  const ng = amp(ctx);
  envAD(ng.gain, t0, 0.0005, 0.008, 0.5 * G);
  chain(n, hp, ng, out);
  return { end };
};

const uiConfirm: SfxRecipe = (ctx, out, t0, p) => {
  const P = p.pitch, G = p.gain;
  const end = t0 + 0.32;
  const notes: [number, number, number][] = [[1318.5, 0, 0.08], [1760, 0.07, 0.2]];
  const lp = filt(ctx, 'lowpass', 4000, 0.7);
  lp.connect(out);
  for (const [hz, dt, d] of notes) {
    const o = tone(ctx, 'square', hz * P, t0 + dt, end);
    const g = amp(ctx);
    envAD(g.gain, t0 + dt, 0.002, d, 0.16 * G);
    chain(o, g, lp);
    const s = tone(ctx, 'sine', (hz / 2) * P, t0 + dt, end);
    const sg = amp(ctx);
    envAD(sg.gain, t0 + dt, 0.002, d, 0.3 * G);
    chain(s, sg, lp);
  }
  return { end };
};

const bossBeamCharge: SfxRecipe = (ctx, out, t0, p) => {
  const P = p.pitch, G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const dur = p.durationS ?? SFX_INFO.bossBeamCharge.durationS;
  const end = t0 + dur + 0.1;
  const o1 = tone(ctx, 'sawtooth', 70 * P, t0, end);
  const o2 = tone(ctx, 'square', 105 * P, t0, end, 8);
  o1.frequency.exponentialRampToValueAtTime(560 * P, t0 + dur);
  o2.frequency.exponentialRampToValueAtTime(840 * P, t0 + dur);
  const g2 = amp(ctx, 0.4);
  chain(o2, g2);
  const lp = filt(ctx, 'lowpass', 220, 9);
  glide(lp.frequency, 220, 6500, t0, t0 + dur);
  o1.connect(lp);
  g2.connect(lp);
  const n = noise(ctx, nb.white, t0, end, r);
  const nbp = filt(ctx, 'bandpass', 600, 1.5);
  glide(nbp.frequency, 600, 7000, t0, t0 + dur);
  const ng = amp(ctx);
  glide(ng.gain, 0.05, 0.5, t0, t0 + dur);
  chain(n, nbp, ng);
  const trem = amp(ctx, 0.55);
  const lfo = tone(ctx, 'sine', 5, t0, end);
  lfo.frequency.exponentialRampToValueAtTime(30, t0 + dur);
  const dep = amp(ctx, 0.45);
  chain(lfo, dep);
  dep.connect(trem.gain);
  lp.connect(trem);
  ng.connect(trem);
  const env = amp(ctx);
  const pk = 0.5 * G;
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(pk * 0.12, t0 + 0.05);
  env.gain.exponentialRampToValueAtTime(Math.max(1e-5, pk), t0 + dur);
  env.gain.linearRampToValueAtTime(0, t0 + dur + 0.06);
  chain(trem, env, out);
  const srcs = [o1, o2, n, lfo];
  return {
    end,
    release: (at: number) => {
      holdAt(env.gain, at, pk);
      env.gain.linearRampToValueAtTime(0, at + 0.06);
      for (const s of srcs) s.stop(at + 0.08);
    },
  };
};

const laserTelegraph: SfxRecipe = (ctx, out, t0, p) => {
  const P = p.pitch, G = p.gain;
  const dur = p.durationS ?? SFX_INFO.laserTelegraph.durationS;
  const end = t0 + dur + 0.08;
  const o1 = tone(ctx, 'sine', 2300 * P, t0, end);
  const o2 = tone(ctx, 'sine', 2300 * P * 1.004, t0, end);
  const o3 = tone(ctx, 'triangle', 1150 * P, t0, end);
  glide(o1.frequency, 2300 * P, 2750 * P, t0, t0 + dur, false);
  glide(o2.frequency, 2300 * P * 1.004, 2750 * P * 1.004, t0, t0 + dur, false);
  glide(o3.frequency, 1150 * P, 1375 * P, t0, t0 + dur, false);
  const lfo = tone(ctx, 'sine', 34, t0, end);
  const vib = amp(ctx, 18);
  lfo.connect(vib);
  vib.connect(o1.detune);
  vib.connect(o2.detune);
  const g3 = amp(ctx, 0.25);
  chain(o3, g3);
  const hp = filt(ctx, 'highpass', 1200, 0.7);
  o1.connect(hp);
  o2.connect(hp);
  g3.connect(hp);
  const env = amp(ctx);
  const pk = 0.2 * G;
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(pk * 0.6, t0 + 0.03);
  env.gain.linearRampToValueAtTime(pk, t0 + dur);
  env.gain.linearRampToValueAtTime(0, t0 + dur + 0.05);
  chain(hp, env, out);
  const srcs = [o1, o2, o3, lfo];
  return {
    end,
    release: (at: number) => {
      holdAt(env.gain, at, pk);
      env.gain.linearRampToValueAtTime(0, at + 0.04);
      for (const s of srcs) s.stop(at + 0.06);
    },
  };
};

const pickup: SfxRecipe = (ctx, out, t0, p) => {
  const P = p.pitch, G = p.gain;
  const end = t0 + 0.42;
  const notes = [84, 88, 91, 96];
  notes.forEach((m, i) => {
    const t = t0 + i * 0.045;
    const f = midiToHz(m) * P;
    const o = tone(ctx, 'triangle', f, t, end);
    const g = amp(ctx);
    envAD(g.gain, t, 0.002, 0.2, 0.3 * G);
    chain(o, g, out);
    const s = tone(ctx, 'sine', f * 2, t, end);
    const sg = amp(ctx);
    envAD(sg.gain, t, 0.002, 0.12, 0.08 * G);
    chain(s, sg, out);
  });
  return { end };
};

/** Brass-like saw stab used by stings. */
function stab(ctx: BaseAudioContext, out: AudioNode, midi: number, t: number, hold: number, rel: number, level: number, bright: number): void {
  const f = midiToHz(midi);
  const lp = filt(ctx, 'lowpass', 700, 2);
  lp.frequency.setValueAtTime(700, t);
  lp.frequency.exponentialRampToValueAtTime(4200 * bright, t + 0.03);
  lp.frequency.exponentialRampToValueAtTime(1800 * bright, t + 0.25);
  const g = amp(ctx);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + 0.012);
  g.gain.exponentialRampToValueAtTime(level * 0.6, t + 0.2);
  g.gain.setValueAtTime(level * 0.6, Math.max(t + 0.2, hold));
  g.gain.exponentialRampToValueAtTime(Math.max(1e-5, level * 1e-3), Math.max(t + 0.2, hold) + rel);
  g.gain.linearRampToValueAtTime(0, Math.max(t + 0.2, hold) + rel + 0.01);
  const stopAt = Math.max(t + 0.2, hold) + rel + 0.02;
  for (const d of [-7, 7]) chain(tone(ctx, 'sawtooth', f, t, stopAt, d), lp);
  chain(lp, g, out);
}

const stageClear: SfxRecipe = (ctx, out, t0, p) => {
  const G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const end = t0 + 2.8;
  const chords: [number[], number, number][] = [
    [[65, 69, 72], 41, 0],
    [[67, 71, 74], 43, 0.24],
    [[69, 73, 76, 81], 45, 0.48],
  ];
  for (const [notes, bass, dt] of chords) {
    const last = dt > 0.4;
    const t = t0 + dt;
    const hold = last ? t0 + 1.1 : t + 0.2;
    const rel = last ? 1.5 : 0.08;
    for (const m of notes) stab(ctx, out, m, t, hold, rel, 0.11 * G, 1);
    stab(ctx, out, bass, t, hold, rel, 0.2 * G, 0.4);
  }
  const n = noise(ctx, nb.white, t0, end, r);
  const hp = filt(ctx, 'highpass', 6500, 0.7);
  const ng = amp(ctx);
  ng.gain.setValueAtTime(0, t0);
  ng.gain.linearRampToValueAtTime(0.3 * G, t0 + 0.5);
  ng.gain.exponentialRampToValueAtTime(Math.max(1e-5, 0.3 * G * 1e-3), end - 0.05);
  ng.gain.linearRampToValueAtTime(0, end - 0.04);
  chain(n, hp, ng, out);
  const trem = amp(ctx, 0.6);
  const lfo = tone(ctx, 'sine', 9, t0, end);
  const dep = amp(ctx, 0.4);
  chain(lfo, dep);
  dep.connect(trem.gain);
  const sh = amp(ctx);
  envAD(sh.gain, t0 + 0.55, 0.15, 2.0, 0.12 * G);
  for (const m of [93, 100]) chain(tone(ctx, 'sine', midiToHz(m), t0 + 0.5, end), trem);
  chain(trem, sh, out);
  return { end };
};

const gameOver: SfxRecipe = (ctx, out, t0, p) => {
  const G = p.gain, nb = noiseBank(ctx), r = p.rng;
  const end = t0 + 3.0;
  const lp = filt(ctx, 'lowpass', 2400, 1.5);
  glide(lp.frequency, 2400, 450, t0, t0 + 2.6);
  lp.connect(out);
  const mel: [number, number, number][] = [[64, 0, 0.3], [60, 0.32, 0.3], [57, 0.64, 2.2]];
  for (const [m, dt, d] of mel) {
    const t = t0 + dt;
    const f = midiToHz(m);
    const g = amp(ctx);
    envAD(g.gain, t, 0.01, d, 0.3 * G);
    chain(tone(ctx, 'triangle', f, t, t + d + 0.03), g, lp);
    const g2 = amp(ctx);
    envAD(g2.gain, t, 0.01, d, 0.07 * G);
    chain(tone(ctx, 'sawtooth', f, t, t + d + 0.03, 5), g2, lp);
  }
  const dlp = filt(ctx, 'lowpass', 700, 1);
  glide(dlp.frequency, 700, 150, t0 + 0.64, end);
  const dg = amp(ctx);
  dg.gain.setValueAtTime(0, t0 + 0.64);
  dg.gain.linearRampToValueAtTime(0.35 * G, t0 + 0.8);
  dg.gain.setValueAtTime(0.35 * G, t0 + 1.8);
  dg.gain.linearRampToValueAtTime(0, end - 0.02);
  for (const m of [45, 52]) {
    const o = tone(ctx, 'sawtooth', midiToHz(m), t0 + 0.64, end);
    o.frequency.setValueAtTime(midiToHz(m), t0 + 1.8);
    o.frequency.exponentialRampToValueAtTime(midiToHz(m) * 0.5, end - 0.05);
    chain(o, dlp);
  }
  chain(dlp, dg, out);
  const w = noise(ctx, nb.brown, t0, end, r);
  const wlp = filt(ctx, 'lowpass', 400, 0.7);
  const wg = amp(ctx);
  wg.gain.setValueAtTime(0, t0);
  wg.gain.linearRampToValueAtTime(0.5 * G, t0 + 1.5);
  wg.gain.linearRampToValueAtTime(0, end - 0.02);
  chain(w, wlp, wg, out);
  return { end };
};

export const SFX: Record<SfxName, SfxRecipe> = {
  cannon, lockTone, missileLaunch, missileImpact, explosionSmall, explosionBig, parry, rollWhoosh, driftWhine,
  wingtrail, shieldRefill, hitTaken, warning, uiMove, uiConfirm, bossBeamCharge, laserTelegraph, pickup,
  stageClear, gameOver,
};

/** Params with defaults (pitch 1, gain 1, seeded rng). */
export function sfxParams(seed = 1, pitch = 1, gain = 1, durationS?: number): SfxParams {
  return { pitch, gain, rng: new Rng(seed), durationS };
}
