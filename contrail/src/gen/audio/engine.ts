/**
 * AudioEngine: the game's single audio entry point.
 *   sfx / ui voices -> buses -> reverb -> DC blocker -> compressor -> -1 dBFS ceiling -> volume
 *   music (MusicPlayer) -> music bus -> duck gain -> same master chain
 * Voice limiting per SFX (+ global cap, oldest stolen with a 15 ms fade), minimum
 * retrigger gap, auto-ducking of music under warning / explosionBig / parry.
 * Variation is seeded (Rng), never Math.random. Muted => no AudioContext at all.
 */
import { Rng } from '../../core/rng';
import { clamp } from './dsp';
import { Mixer, type BusName } from './mixer';
import { MusicPlayer } from './music';
import { SFX, SFX_INFO, type SfxName, type SfxVoice } from './sfx';

export interface PlayOpts {
  /** stereo position -1..1 */
  pan?: number;
  /** linear gain multiplier (default 1) */
  gain?: number;
  /** frequency multiplier (default 1); for lockTone use lockPitch(index) */
  pitch?: number;
  /** variation seed; default = next value of the engine's seeded stream */
  seed?: number;
  /** sustained recipes only: length in seconds */
  durationS?: number;
}

export interface SfxHandle {
  /** fade out now (sustained sounds) */
  release(): void;
}

export const MAX_VOICES = 48;

interface VoiceRec {
  name: SfxName;
  start: number;
  end: number;
  level: number;
  gain: GainNode;
  pan: StereoPannerNode | null;
  voice: SfxVoice;
  dead: boolean;
}

export interface VoiceStats {
  requested: number;
  played: number;
  dropped: number;
  stolen: number;
}

/** Voice allocation + auto-duck on any BaseAudioContext (the offline check uses it with explicit times). */
export class VoiceManager {
  private voices: VoiceRec[] = [];
  private lastStart: Partial<Record<SfxName, number>> = {};
  private rng: Rng;
  readonly stats: VoiceStats = { requested: 0, played: 0, dropped: 0, stolen: 0 };

  constructor(readonly ctx: BaseAudioContext, readonly mixer: Mixer, seed = 0xc0a7) {
    this.rng = new Rng(seed);
  }

  play(name: SfxName, opts: PlayOpts, at: number): VoiceRec | null {
    const info = SFX_INFO[name];
    const recipe = SFX[name];
    this.stats.requested++;
    const level = clamp(opts.gain ?? 1, 0, 4);
    if (!info || !recipe || level <= 0) return null;
    const last = this.lastStart[name];
    if (last !== undefined && at - last < info.minGapS && at >= last) {
      this.stats.dropped++;
      return null;
    }
    this.purge();
    let count = 0;
    let oldest: VoiceRec | null = null;
    let active = 0;
    let oldestAny: VoiceRec | null = null;
    for (const v of this.voices) {
      if (v.dead || v.end <= at || v.start > at) continue;
      active++;
      if (!oldestAny || v.start < oldestAny.start) oldestAny = v;
      if (v.name === name) {
        count++;
        if (!oldest || v.start < oldest.start) oldest = v;
      }
    }
    if (count >= info.maxVoices && oldest) this.steal(oldest, at);
    else if (active >= MAX_VOICES && oldestAny) this.steal(oldestAny, at);

    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = level;
    let pan: StereoPannerNode | null = null;
    const bus = info.bus === 'ui' ? this.mixer.ui : this.mixer.sfx;
    if (opts.pan) {
      pan = ctx.createStereoPanner();
      pan.pan.value = clamp(opts.pan, -1, 1);
      g.connect(pan);
      pan.connect(bus);
    } else g.connect(bus);
    const seed = opts.seed ?? this.rng.nextU32();
    const voice = recipe(ctx, g, at, { pitch: clamp(opts.pitch ?? 1, 0.25, 4), gain: 1, rng: new Rng(seed), durationS: opts.durationS });
    const rec: VoiceRec = { name, start: at, end: voice.end, level, gain: g, pan, voice, dead: false };
    this.voices.push(rec);
    this.lastStart[name] = at;
    this.stats.played++;
    if (info.duck) this.mixer.duck(info.duck.db, info.duck.s, at);
    return rec;
  }

  release(rec: VoiceRec, at: number): void {
    if (rec.dead) return;
    if (rec.voice.release) {
      rec.voice.release(at);
      rec.end = Math.min(rec.end, at + 0.3);
    } else this.steal(rec, at);
  }

  private steal(v: VoiceRec, at: number): void {
    v.gain.gain.cancelScheduledValues(at);
    v.gain.gain.setValueAtTime(v.level, at);
    v.gain.gain.linearRampToValueAtTime(0, at + 0.015);
    v.end = Math.min(v.end, at + 0.02);
    this.stats.stolen++;
  }

  /** Disconnect voices that finished (by the context's real clock). */
  purge(): void {
    const now = this.ctx.currentTime;
    let w = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.end + 0.1 < now) {
        v.dead = true;
        v.gain.disconnect();
        v.pan?.disconnect();
      } else this.voices[w++] = v;
    }
    this.voices.length = w;
  }

  activeCount(at: number): number {
    let c = 0;
    for (const v of this.voices) if (!v.dead && v.start <= at && v.end > at) c++;
    return c;
  }
}

export interface EngineOptions {
  muted?: boolean;
  seed?: number;
}

export class AudioEngine {
  readonly ctx: AudioContext | null;
  readonly music: MusicPlayer;
  private readonly mixer: Mixer | null;
  private readonly voices: VoiceManager | null;
  private disposed = false;
  private gestureHandler: (() => void) | null = null;
  private static readonly GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;

  constructor(opts: { muted?: boolean; seed?: number } = {}) {
    let ctx: AudioContext | null = null;
    if (!opts.muted && typeof window !== 'undefined') {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        try {
          ctx = new AC({ latencyHint: 'interactive' });
        } catch {
          ctx = null;
        }
      }
    }
    this.ctx = ctx;
    this.mixer = ctx ? new Mixer(ctx) : null;
    const seed = opts.seed ?? 1;
    this.voices = ctx && this.mixer ? new VoiceManager(ctx, this.mixer, seed ^ 0xc0a7) : null;
    this.music = new MusicPlayer(ctx, this.mixer?.music ?? null, this.mixer?.musicReverb ?? null, seed);
    if (ctx && typeof window !== 'undefined') {
      this.gestureHandler = () => void this.unlock();
      for (const e of AudioEngine.GESTURES) window.addEventListener(e, this.gestureHandler, { capture: true, passive: true });
    }
  }

  /** true once the context is running (after a user gesture) */
  get unlocked(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Resume the context; call from (or rely on the auto-installed) first user gesture. */
  async unlock(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch {
      return;
    }
    if (ctx.state === 'running') this.removeGestures();
  }

  play(name: SfxName, opts?: { pan?: number; gain?: number; pitch?: number; seed?: number; durationS?: number }): void {
    const ctx = this.ctx;
    if (!ctx || !this.voices || this.disposed || ctx.state !== 'running') return;
    this.voices.play(name, opts ?? {}, ctx.currentTime + 0.004);
  }

  /** Start a sustained sound (driftWhine, bossBeamCharge, laserTelegraph...) and release it later. */
  hold(name: SfxName, opts: PlayOpts = {}): SfxHandle | null {
    const ctx = this.ctx;
    if (!ctx || !this.voices || this.disposed || ctx.state !== 'running') return null;
    const rec = this.voices.play(name, { ...opts, durationS: opts.durationS ?? 600 }, ctx.currentTime + 0.004);
    if (!rec) return null;
    const vm = this.voices;
    return { release: () => vm.release(rec, ctx.currentTime + 0.004) };
  }

  setMasterVolume(v: number): void {
    this.mixer?.setVolume(v);
  }

  setBusVolume(bus: BusName, v: number): void {
    this.mixer?.setBus(bus, v);
  }

  /** Duck the music bus by amountDb for `seconds`. */
  duck(amountDb: number, seconds: number): void {
    this.mixer?.duck(amountDb, seconds);
  }

  get voiceStats(): VoiceStats | null {
    return this.voices?.stats ?? null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeGestures();
    this.music.dispose();
    this.mixer?.dispose();
    if (this.ctx) void this.ctx.close().catch(() => undefined);
  }

  private removeGestures(): void {
    if (!this.gestureHandler || typeof window === 'undefined') return;
    for (const e of AudioEngine.GESTURES) window.removeEventListener(e, this.gestureHandler, { capture: true });
    this.gestureHandler = null;
  }
}

export type { SfxName } from './sfx';
export { lockPitch, SFX_NAMES } from './sfx';
export type { MusicStage } from './music';
