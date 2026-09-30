/**
 * Mixer: sfx / music / ui buses -> shared code-generated reverb -> DC blocker ->
 * master compressor (limiter) -> soft ceiling at -1 dBFS -> volume -> destination.
 * Works on any BaseAudioContext, so the offline check measures the real chain.
 */
import { MASTER_CEILING } from './levels';
import { amp, ceilingCurve, clamp, dbToGain, filt, holdAt, reverbImpulse, shaper } from './dsp';

export interface MixLevels {
  sfx: number;
  ui: number;
  music: number;
  reverbReturn: number;
  sfxReverbSend: number;
  musicReverbSend: number;
  volume: number;
}

/** Default bus levels (linear). Documented in Docs/AUDIO.md. */
export const MIX_LEVELS: MixLevels = {
  sfx: 0.8,
  ui: 0.6,
  music: 0.36,
  reverbReturn: 0.5,
  sfxReverbSend: 0.12,
  musicReverbSend: 1.0,
  volume: 1.0,
};

export type BusName = 'sfx' | 'ui' | 'music';

export class Mixer {
  readonly ctx: BaseAudioContext;
  readonly sfx: GainNode;
  readonly ui: GainNode;
  /** music bus input (the MusicPlayer connects here) */
  readonly music: GainNode;
  /** music reverb send input (pad / arp connect here) */
  readonly musicReverb: GainNode;
  private readonly musicDuck: GainNode;
  private readonly volume: GainNode;
  private readonly all: AudioNode[] = [];
  private duckUntil = -1;
  private duckDepth = 1;

  constructor(ctx: BaseAudioContext, levels: MixLevels = MIX_LEVELS) {
    this.ctx = ctx;
    const n = <T extends AudioNode>(x: T): T => (this.all.push(x), x);
    this.sfx = n(amp(ctx, levels.sfx));
    this.ui = n(amp(ctx, levels.ui));
    this.music = n(amp(ctx, levels.music));
    this.musicDuck = n(amp(ctx, 1));
    this.musicReverb = n(amp(ctx, levels.musicReverbSend));
    const sum = n(amp(ctx, 1));
    const reverb = n(ctx.createConvolver());
    reverb.normalize = true;
    reverb.buffer = reverbImpulse(ctx, 1.6, 1.3, 7, 0.55);
    const revRet = n(amp(ctx, levels.reverbReturn));
    const sfxSend = n(amp(ctx, levels.sfxReverbSend));

    this.sfx.connect(sum);
    this.sfx.connect(sfxSend);
    sfxSend.connect(reverb);
    this.ui.connect(sum);
    this.music.connect(this.musicDuck);
    this.musicDuck.connect(sum);
    this.musicReverb.connect(reverb);
    reverb.connect(revRet);
    revRet.connect(sum);

    const dc = n(filt(ctx, 'highpass', MASTER_CEILING.dcHz, 0.707));
    const comp = n(ctx.createDynamicsCompressor());
    comp.threshold.value = MASTER_CEILING.compThresholdDb;
    comp.knee.value = MASTER_CEILING.compKneeDb;
    comp.ratio.value = MASTER_CEILING.compRatio;
    comp.attack.value = MASTER_CEILING.compAttackS;
    comp.release.value = MASTER_CEILING.compReleaseS;
    const ceil = n(shaper(ctx, ceilingCurve(MASTER_CEILING.knee, MASTER_CEILING.ceiling), 'none'));
    this.volume = n(amp(ctx, clamp(levels.volume, 0, 1)));
    sum.connect(dc);
    dc.connect(comp);
    comp.connect(ceil);
    ceil.connect(this.volume);
    this.volume.connect(ctx.destination);
  }

  /** Output volume 0..1 (after the ceiling, so it can never push past -1 dBFS). */
  setVolume(v: number, at = this.ctx.currentTime): void {
    this.volume.gain.setTargetAtTime(clamp(v, 0, 1), at, 0.02);
  }

  setBus(bus: BusName, v: number, at = this.ctx.currentTime): void {
    this[bus].gain.setTargetAtTime(Math.max(0, v), at, 0.02);
  }

  /** Duck the music bus by amountDb for `seconds` (30 ms attack, 350 ms release). Overlapping ducks keep the deepest / longest. */
  duck(amountDb: number, seconds: number, at = this.ctx.currentTime): void {
    let depth = dbToGain(-Math.abs(amountDb));
    let until = at + Math.max(0, seconds);
    const active = at < this.duckUntil;
    if (active) {
      depth = Math.min(depth, this.duckDepth);
      until = Math.max(until, this.duckUntil);
    }
    const p = this.musicDuck.gain;
    holdAt(p, at, active ? this.duckDepth : 1);
    p.linearRampToValueAtTime(depth, at + 0.03);
    p.setValueAtTime(depth, until);
    p.linearRampToValueAtTime(1, until + 0.35);
    this.duckDepth = depth;
    this.duckUntil = until;
  }

  dispose(): void {
    for (const x of this.all) {
      try {
        x.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.all.length = 0;
  }
}
