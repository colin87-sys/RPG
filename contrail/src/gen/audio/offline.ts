/**
 * Offline audio check (GAME_FORGE W8 "verification without ears").
 * Renders every SFX (own OfflineAudioContext, 48 kHz stereo, through the game's
 * VoiceManager + Mixer) and the music loop (one loop + 1 s seam) at intensity
 * 0.25 / 0.6 / 1.0 (Cloudgate) plus 0.6 for Violet Tide and Wreckfield, then
 * measures peak / RMS / DC / clipping / loop seam and draws an STFT spectrogram
 * (1024 Hann, hop 256, log-frequency 30 Hz-16 kHz, token colour map).
 * Status: agent-verified numerically, pending owner review (not audible to the agent).
 */
import { palette } from '../../style/tokens';
import { hexToRgb, withAlpha } from '../../style/color';
import { VoiceManager } from './engine';
import { Mixer } from './mixer';
import { gainToDb } from './dsp';
import { LOOP_S, renderLoopOffline, type MusicStage } from './music';
import { SFX_INFO, SFX_NAMES, lockPitch, type SfxName } from './sfx';

export const CHECK_SR = 48000;

export const AUDIO_TARGETS = {
  peakMaxDbfs: -1,
  dcMax: 0.01,
  sfxRms: [-30, -10] as [number, number],
  musicRms: [-24, -12] as [number, number],
  musicRmsAtIntensity: 0.6,
  seamDbMax: 3,
  seamJumpMax: 0.1,
  /** SFX "active part": 10 ms frames within 20 dB of the loudest frame */
  gateDb: -20,
  frameS: 0.01,
} as const;

export interface AudioCheckResult {
  name: string;
  kind: 'sfx' | 'music';
  durationS: number;
  peakDbfs: number;
  /** sfx: gated active-part RMS; music: RMS over one full loop */
  rmsDbfs: number;
  /** worst channel mean */
  dcOffset: number;
  clipping: boolean;
  /** music only (null for sfx) */
  loopSeamOk: boolean | null;
  spectrogramPng: string;
  // extras
  activeS?: number;
  intensity?: number;
  stage?: MusicStage;
  seamDeltaDb?: number;
  seamJump?: number;
  note?: string;
  pass: boolean;
  fails: string[];
  renderMs: number;
}

// ------------------------------------------------------------------ analysis
export interface BufferStats {
  peakDbfs: number;
  rmsDbfs: number;
  dcOffset: number;
  clipping: boolean;
  activeS: number;
}

function rmsRange(chs: Float32Array[], a: number, b: number): number {
  let p = 0, n = 0;
  for (const d of chs)
    for (let i = Math.max(0, a); i < Math.min(d.length, b); i++) {
      p += d[i] * d[i];
      n++;
    }
  return Math.sqrt(p / Math.max(1, n));
}

export function analyseBuffer(buf: AudioBuffer, kind: 'sfx' | 'music', loopS = 0): BufferStats {
  const chs: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  let peak = 0, dc = 0;
  for (const d of chs) {
    let s = 0;
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      s += d[i];
    }
    const m = s / d.length;
    if (Math.abs(m) > Math.abs(dc)) dc = m;
  }
  let rms: number, activeS: number;
  if (kind === 'music') {
    rms = rmsRange(chs, 0, Math.round(loopS * buf.sampleRate));
    activeS = loopS;
  } else {
    const fl = Math.round(AUDIO_TARGETS.frameS * buf.sampleRate);
    const nf = Math.floor(buf.length / fl);
    const fp = new Float64Array(nf);
    let maxP = 0;
    for (let f = 0; f < nf; f++) {
      let p = 0;
      for (const d of chs) for (let i = f * fl; i < (f + 1) * fl; i++) p += d[i] * d[i];
      fp[f] = p / (fl * chs.length);
      if (fp[f] > maxP) maxP = fp[f];
    }
    const gate = maxP * Math.pow(10, AUDIO_TARGETS.gateDb / 10);
    let sum = 0, cnt = 0, first = -1, last = -1;
    for (let f = 0; f < nf; f++)
      if (fp[f] >= gate && fp[f] > 0) {
        sum += fp[f];
        cnt++;
        if (first < 0) first = f;
        last = f;
      }
    rms = Math.sqrt(sum / Math.max(1, cnt));
    activeS = first < 0 ? 0 : (last - first + 1) * AUDIO_TARGETS.frameS;
  }
  return { peakDbfs: gainToDb(peak), rmsDbfs: gainToDb(rms), dcOffset: dc, clipping: peak >= 1.0, activeS };
}

export function seamCheck(buf: AudioBuffer, loopS: number): { deltaDb: number; jump: number; ok: boolean } {
  const chs: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  const L = Math.round(loopS * buf.sampleRate);
  const w = Math.round(0.05 * buf.sampleRate);
  const a = rmsRange(chs, 0, w), b = rmsRange(chs, L, L + w);
  const deltaDb = Math.abs(gainToDb(a) - gainToDb(b));
  let jump = 0;
  for (const d of chs) jump = Math.max(jump, Math.abs(d[L] - d[L - 1]));
  return { deltaDb, jump, ok: deltaDb <= AUDIO_TARGETS.seamDbMax && jump <= AUDIO_TARGETS.seamJumpMax };
}

// ------------------------------------------------------------------ spectrogram
class FFT {
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;
  constructor(readonly n: number) {
    const bits = Math.log2(n) | 0;
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
  }
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size)
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step], s = this.sin[k * step];
          const a = i + k, b = a + half;
          const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
    }
  }
}

/** music strips are dense and mean-pooled: brighter top of the dB scale so kicks / bass lines separate */
export const MUSIC_DB_HI = 0;
const SPEC = { n: 1024, hop: 256, fLo: 30, fHi: 16000, dbLo: -100, dbHi: -12 };
/** dB colour ramp built from tokens: spaceDeep -> hudLine -> hudText -> burstYellow -> burstWhite */
const RAMP: [number, string][] = [
  [0, palette.spaceDeep],
  [0.35, palette.hudLine],
  [0.6, palette.hudText],
  [0.82, palette.burstYellow],
  [1, palette.burstWhite],
];
let lut: Uint8ClampedArray | null = null;
function colourLut(): Uint8ClampedArray {
  if (lut) return lut;
  lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < RAMP.length - 2 && t > RAMP[k + 1][0]) k++;
    const [t0, c0] = RAMP[k], [t1, c1] = RAMP[k + 1];
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    const a = hexToRgb(c0), b = hexToRgb(c1);
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = Math.round((a[j] + (b[j] - a[j]) * u) * 255);
  }
  return lut;
}

/** CSS colour of the spectrogram ramp at t in 0..1 (legend bars). */
export function rampColour(t: number): string {
  const l = colourLut();
  const i = Math.round(Math.min(1, Math.max(0, t)) * 255) * 3;
  return `rgb(${l[i]},${l[i + 1]},${l[i + 2]})`;
}

/** STFT spectrogram of a (stereo) buffer drawn to a PNG data URL with a name label. */
export function spectrogramPng(buf: AudioBuffer, label: string, width = 480, height = 240, sub = '', dbHi = SPEC.dbHi): string {
  const { n, hop } = SPEC;
  const sr = buf.sampleRate;
  const len = buf.length;
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const frames = Math.max(1, Math.ceil(Math.max(0, len - n) / hop) + 1);
  const fft = new FFT(n);
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const re = new Float64Array(n), im = new Float64Array(n);
  const bins = n / 2 + 1;
  const col = new Float32Array(bins);
  const norm = n / 4;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(width, height);
  const lutc = colourLut();
  // row -> fractional bin (log frequency)
  const rowLo = new Float32Array(height), rowHi = new Float32Array(height);
  const binHz = sr / n;
  for (let y = 0; y < height; y++) {
    const v0 = (height - 1 - y) / height, v1 = (height - y) / height;
    rowLo[y] = (SPEC.fLo * Math.pow(SPEC.fHi / SPEC.fLo, v0)) / binHz;
    rowHi[y] = (SPEC.fLo * Math.pow(SPEC.fHi / SPEC.fLo, v1)) / binHz;
  }
  for (let x = 0; x < width; x++) {
    const f0 = Math.floor((x * frames) / width);
    const f1 = Math.max(f0 + 1, Math.floor(((x + 1) * frames) / width));
    const pool = f1 - f0 > 3 ? 'mean' : 'max';
    col.fill(pool === 'mean' ? 0 : -200);
    for (let f = f0; f < f1; f++) {
      const o = f * hop;
      for (let i = 0; i < n; i++) {
        const j = o + i;
        re[i] = j < len ? 0.5 * (L[j] + R[j]) * win[i] : 0;
        im[i] = 0;
      }
      fft.transform(re, im);
      for (let k = 0; k < bins; k++) {
        const mag = Math.hypot(re[k], im[k]) / norm;
        if (pool === 'mean') col[k] += mag * mag;
        else {
          const db = 20 * Math.log10(mag + 1e-12);
          if (db > col[k]) col[k] = db;
        }
      }
    }
    if (pool === 'mean') for (let k = 0; k < bins; k++) col[k] = 10 * Math.log10(col[k] / (f1 - f0) + 1e-24);
    for (let y = 0; y < height; y++) {
      const a = rowLo[y], b = rowHi[y];
      let db: number;
      if (b - a < 1) {
        const c = (a + b) / 2, k = Math.min(bins - 2, Math.floor(c)), u = c - k;
        db = col[k] * (1 - u) + col[k + 1] * u;
      } else {
        db = -200;
        for (let k = Math.ceil(a); k <= Math.min(bins - 1, Math.floor(b)); k++) if (col[k] > db) db = col[k];
      }
      const t = Math.min(1, Math.max(0, (db - SPEC.dbLo) / (dbHi - SPEC.dbLo)));
      const ci = Math.round(t * 255) * 3, p = (y * width + x) * 4;
      img.data[p] = lutc[ci];
      img.data[p + 1] = lutc[ci + 1];
      img.data[p + 2] = lutc[ci + 2];
      img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // frequency grid
  g.font = '10px ui-monospace, Menlo, Consolas, monospace';
  g.textBaseline = 'bottom';
  for (const [hz, txt] of [[100, '100'], [1000, '1k'], [10000, '10k']] as const) {
    const y = height - 1 - (Math.log(hz / SPEC.fLo) / Math.log(SPEC.fHi / SPEC.fLo)) * height;
    g.fillStyle = withAlpha(palette.hudValue, 0.22);
    g.fillRect(0, Math.round(y), width, 1);
    g.fillStyle = withAlpha(palette.hudValue, 0.7);
    g.fillText(txt, 3, y - 1);
  }
  // label
  g.font = 'bold 13px ui-monospace, Menlo, Consolas, monospace';
  const txt = sub ? `${label}  ${sub}` : label;
  const tw = g.measureText(txt).width + 10;
  g.fillStyle = withAlpha(palette.spaceDeep, 0.8);
  g.fillRect(width - tw, 0, tw, 18);
  g.fillStyle = palette.hudValue;
  g.textBaseline = 'middle';
  g.fillText(txt, width - tw + 5, 9);
  return canvas.toDataURL('image/png');
}

// ------------------------------------------------------------------ renders
/** How each SFX is exercised in the check (most: one shot at 20 ms). */
export const SFX_DEMO: Partial<Record<SfxName, { times: number[]; pitch?: number[]; note: string }>> = {
  cannon: { times: [0, 1, 2, 3, 4, 5, 6].map((i) => 0.02 + i / 14), note: '7 shots @14/s' },
  lockTone: { times: [0, 1, 2, 3].map((i) => 0.02 + i * 0.1), pitch: [0, 1, 2, 3].map(lockPitch), note: 'locks 1-4' },
};

const TAIL_S = 0.4;
/**
 * Silent pre-roll before every offline render: Chromium's DynamicsCompressor
 * ramps up over ~100 ms after a context starts (measured: -8 dB in the first
 * 50 ms on a steady tone). In the game the mixer exists long before any cue,
 * so the check lets the master chain settle, then crops the pre-roll away.
 */
export const PRE_ROLL_S = 0.3;

/** Copy of `buf` from `startS` on. */
export function cropBuffer(buf: AudioBuffer, startS: number): AudioBuffer {
  const a = Math.round(startS * buf.sampleRate);
  const len = Math.max(1, buf.length - a);
  const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: len, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(a, a + len), c);
  return out;
}

async function renderSfx(name: SfxName, seed: number): Promise<AudioBuffer> {
  const info = SFX_INFO[name];
  const demo = SFX_DEMO[name];
  const times = demo?.times ?? [0.02];
  const len = Math.ceil((PRE_ROLL_S + times[times.length - 1] + info.durationS + TAIL_S) * CHECK_SR);
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: len, sampleRate: CHECK_SR });
  const vm = new VoiceManager(ctx, new Mixer(ctx), seed);
  times.forEach((t, i) => vm.play(name, { pitch: demo?.pitch?.[i] ?? 1, seed: seed + i }, PRE_ROLL_S + t));
  return cropBuffer(await ctx.startRendering(), PRE_ROLL_S);
}

export interface CheckOptions {
  sfxSize?: [number, number];
  musicSize?: [number, number];
  /** restrict to these item names (debug) */
  only?: string[];
  seed?: number;
}

export const MUSIC_CHECKS: { stage: MusicStage; intensity: number }[] = [
  { stage: 'cloudgate', intensity: 0.25 },
  { stage: 'cloudgate', intensity: 0.6 },
  { stage: 'cloudgate', intensity: 1.0 },
  { stage: 'violetTide', intensity: 0.6 },
  { stage: 'wreckfield', intensity: 0.6 },
];

function judge(r: AudioCheckResult): void {
  const T = AUDIO_TARGETS;
  const f: string[] = [];
  if (r.peakDbfs > T.peakMaxDbfs) f.push('peak');
  if (r.clipping) f.push('clip');
  if (Math.abs(r.dcOffset) >= T.dcMax) f.push('dc');
  if (r.kind === 'sfx' && (r.rmsDbfs < T.sfxRms[0] || r.rmsDbfs > T.sfxRms[1])) f.push('rms');
  if (r.kind === 'music') {
    if (r.intensity === T.musicRmsAtIntensity && (r.rmsDbfs < T.musicRms[0] || r.rmsDbfs > T.musicRms[1])) f.push('rms');
    if (!r.loopSeamOk) f.push('seam');
  }
  r.fails = f;
  r.pass = f.length === 0;
}

export async function renderForCheck(opts: CheckOptions = {}): Promise<AudioCheckResult[]> {
  const seed = opts.seed ?? 1;
  const [sw, sh] = opts.sfxSize ?? [480, 240];
  const [mw, mh] = opts.musicSize ?? [960, 240];
  const out: AudioCheckResult[] = [];
  const want = (n: string) => !opts.only || opts.only.includes(n);
  for (const name of SFX_NAMES) {
    if (!want(name)) continue;
    const t0 = performance.now();
    const buf = await renderSfx(name, seed);
    const st = analyseBuffer(buf, 'sfx');
    const note = SFX_DEMO[name]?.note;
    const r: AudioCheckResult = {
      name, kind: 'sfx', durationS: buf.duration, peakDbfs: st.peakDbfs, rmsDbfs: st.rmsDbfs, dcOffset: st.dcOffset,
      clipping: st.clipping, loopSeamOk: null, spectrogramPng: '', activeS: st.activeS, note, pass: false, fails: [], renderMs: 0,
    };
    r.spectrogramPng = spectrogramPng(buf, name, sw, sh, `${buf.duration.toFixed(2)}s${note ? ' ' + note : ''}`);
    r.renderMs = Math.round(performance.now() - t0);
    judge(r);
    out.push(r);
  }
  for (const m of MUSIC_CHECKS) {
    const name = `music ${m.stage} x${m.intensity}`;
    if (!want(name) && !want('music')) continue;
    const t0 = performance.now();
    const seconds = LOOP_S + 1;
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil((PRE_ROLL_S + seconds) * CHECK_SR), sampleRate: CHECK_SR });
    const buf = cropBuffer(await renderLoopOffline(ctx, seconds, m.intensity, m.stage, { seed, startAt: PRE_ROLL_S }), PRE_ROLL_S);
    const st = analyseBuffer(buf, 'music', LOOP_S);
    const seam = seamCheck(buf, LOOP_S);
    const r: AudioCheckResult = {
      name, kind: 'music', durationS: buf.duration, peakDbfs: st.peakDbfs, rmsDbfs: st.rmsDbfs, dcOffset: st.dcOffset,
      clipping: st.clipping, loopSeamOk: seam.ok, spectrogramPng: '', intensity: m.intensity, stage: m.stage,
      seamDeltaDb: seam.deltaDb, seamJump: seam.jump, activeS: st.activeS, pass: false, fails: [], renderMs: 0,
    };
    r.spectrogramPng = spectrogramPng(buf, name, mw, mh, `${LOOP_S.toFixed(2)}s loop +1s`, MUSIC_DB_HI);
    r.renderMs = Math.round(performance.now() - t0);
    judge(r);
    out.push(r);
  }
  return out;
}

// ------------------------------------------------------------------ mixer checks
export interface MixerCheck {
  duckTargetDb: number;
  duckMeasuredDb: number;
  cannonSinglePeakDbfs: number;
  cannonHeldPeakDbfs: number;
  cannonHeldRmsDbfs: number;
  voiceStress: { requested: number; played: number; dropped: number; stolen: number; maxActive: number; maxVoices: number };
}

/**
 * Ducking: music (cloudgate 0.6) rendered with and without a mixer.duck(8 dB, 1 s)
 * at 3.0 s; RMS ratio over 3.1-3.9 s = measured duck depth.
 * Held cannon: 28 shots (2 s at 14/s) vs one shot; peak may grow <= 3 dB (at most two shots overlap).
 * Voice stress: 24 explosionSmall requests over 0.2 s.
 */
export async function checkMixer(seed = 1): Promise<MixerCheck> {
  const secs = 5;
  const mk = () => new OfflineAudioContext({ numberOfChannels: 2, length: (PRE_ROLL_S + secs) * CHECK_SR, sampleRate: CHECK_SR });
  const plain = cropBuffer(await renderLoopOffline(mk(), secs, 0.6, 'cloudgate', { seed, startAt: PRE_ROLL_S }), PRE_ROLL_S);
  const ducked = cropBuffer(
    await renderLoopOffline(mk(), secs, 0.6, 'cloudgate', { seed, startAt: PRE_ROLL_S, onMixer: (mx) => mx.duck(8, 1.0, PRE_ROLL_S + 3.0) }),
    PRE_ROLL_S,
  );
  const seg = (b: AudioBuffer) => rmsRange([b.getChannelData(0), b.getChannelData(1)], Math.round(3.1 * CHECK_SR), Math.round(3.9 * CHECK_SR));
  const duckMeasuredDb = gainToDb(seg(ducked)) - gainToDb(seg(plain));

  const octx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil((PRE_ROLL_S + 0.5) * CHECK_SR), sampleRate: CHECK_SR });
  new VoiceManager(octx, new Mixer(octx), seed).play('cannon', {}, PRE_ROLL_S + 0.02);
  const one = cropBuffer(await octx.startRendering(), PRE_ROLL_S);
  const hctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil((PRE_ROLL_S + 2.6) * CHECK_SR), sampleRate: CHECK_SR });
  const hvm = new VoiceManager(hctx, new Mixer(hctx), seed);
  for (let i = 0; i < 28; i++) hvm.play('cannon', {}, PRE_ROLL_S + 0.02 + i / 14);
  const held = cropBuffer(await hctx.startRendering(), PRE_ROLL_S);
  const hs = analyseBuffer(held, 'sfx');

  const sctx = new OfflineAudioContext({ numberOfChannels: 2, length: CHECK_SR, sampleRate: CHECK_SR });
  const svm = new VoiceManager(sctx, new Mixer(sctx), seed);
  let maxActive = 0;
  for (let i = 0; i < 24; i++) {
    const t = 0.02 + i * (0.2 / 24);
    svm.play('explosionSmall', {}, t);
    maxActive = Math.max(maxActive, svm.activeCount(t));
  }
  return {
    duckTargetDb: -8,
    duckMeasuredDb,
    cannonSinglePeakDbfs: analyseBuffer(one, 'sfx').peakDbfs,
    cannonHeldPeakDbfs: hs.peakDbfs,
    cannonHeldRmsDbfs: hs.rmsDbfs,
    voiceStress: { ...svm.stats, maxActive, maxVoices: SFX_INFO.explosionSmall.maxVoices },
  };
}
