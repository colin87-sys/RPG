/**
 * Optional wiring helper for the Integrator: maps GameEvents to SFX / music.
 * Mapping is documented in Docs/AUDIO.md. Call update(dt) once per frame
 * (no allocations) and setDanger(1 - shield/100) when the shield changes.
 */
import type { EventBus } from '../../core/events';
import type { AudioEngine, SfxHandle } from './engine';
import { clamp } from './dsp';
import { MUSIC_STAGES, type MusicStage } from './music';
import { lockPitch } from './sfx';

/** Music intensity from combo chain, danger (0..1) and boss presence. */
export function musicIntensity(chain: number, danger: number, boss: boolean): number {
  return clamp(0.3 + 0.35 * Math.min(1, chain / 8) + 0.3 * clamp(danger, 0, 1) + (boss ? 0.3 : 0), 0, 1);
}

export interface GameAudioBinding {
  update(dt: number): void;
  /** 0..1, e.g. 1 - shield / 100 */
  setDanger(x: number): void;
  readonly intensity: number;
  dispose(): void;
}

export interface BindOptions {
  /** world position -> stereo pan (-1..1); default centre */
  panOf?: (pos: { x: number; y: number; z: number }) => number;
}

export function bindGameAudio(engine: AudioEngine, bus: EventBus, opts: BindOptions = {}): GameAudioBinding {
  const pan = opts.panOf ?? (() => 0);
  let chain = 0, danger = 0, hitHeat = 0, boss = false, intensity = 0.3, lastSent = -1;
  let drift: SfxHandle | null = null;
  const offs = [
    bus.on('cannonFire', (e) => engine.play('cannon', { pan: pan(e.pos) * 0.5, gain: 1 })),
    bus.on('lockAdded', (e) => engine.play('lockTone', { pitch: lockPitch(e.count - 1) })),
    bus.on('missileFire', () => engine.play('missileLaunch')),
    bus.on('missileHit', (e) => engine.play('missileImpact', { pan: pan(e.pos) })),
    bus.on('enemyKilled', (e) => engine.play(e.big ? 'explosionBig' : 'explosionSmall', { pan: pan(e.pos) })),
    bus.on('playerHit', () => {
      engine.play('hitTaken');
      hitHeat = Math.min(1, hitHeat + 0.35);
    }),
    bus.on('parry', (e) => engine.play('parry', { pan: pan(e.pos) * 0.5 })),
    bus.on('roll', (e) => engine.play('rollWhoosh', { pan: e.dir * 0.4 })),
    bus.on('boost', (e) => e.active && engine.play('rollWhoosh', { pitch: 0.75, gain: 0.8 })),
    bus.on('drift', (e) => {
      if (e.active && !drift) drift = engine.hold('driftWhine');
      else if (!e.active && drift) {
        drift.release();
        drift = null;
      }
    }),
    bus.on('wingtrail', () => engine.play('wingtrail')),
    bus.on('shieldRefill', () => engine.play('shieldRefill')),
    bus.on('comboChanged', (e) => {
      chain = e.chain;
    }),
    bus.on('laserTelegraph', () => engine.play('laserTelegraph')),
    bus.on('warning', (e) => e.on && engine.play('warning')),
    bus.on('pickup', (e) => engine.play('pickup', { pan: pan(e.pos) * 0.5 })),
    bus.on('uiMove', () => engine.play('uiMove')),
    bus.on('uiConfirm', () => engine.play('uiConfirm')),
    bus.on('bossPhase', (e) => {
      boss = e.phase > 0;
      if (boss) engine.play('bossBeamCharge');
    }),
    bus.on('stageStart', (e) => {
      const id = (MUSIC_STAGES as readonly string[]).includes(e.stage) ? (e.stage as MusicStage) : 'cloudgate';
      boss = false;
      chain = 0;
      engine.music.setStage(id);
      engine.music.start();
    }),
    bus.on('stageClear', () => {
      engine.music.stop(0.4);
      engine.play('stageClear');
    }),
    bus.on('playerDown', () => {
      engine.music.stop(0.3);
      drift?.release();
      drift = null;
      engine.play('gameOver');
    }),
  ];
  return {
    update(dt: number) {
      hitHeat = Math.max(0, hitHeat - dt / 3);
      const target = musicIntensity(chain, Math.max(danger, hitHeat), boss);
      intensity += (target - intensity) * Math.min(1, dt * 2);
      if (Math.abs(intensity - lastSent) > 0.02) {
        lastSent = intensity;
        engine.music.setIntensity(intensity);
      }
    },
    setDanger(x: number) {
      danger = clamp(x, 0, 1);
    },
    get intensity() {
      return intensity;
    },
    dispose() {
      for (const off of offs) off();
      drift?.release();
    },
  };
}
