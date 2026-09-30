/**
 * Hit pops (VFX lane B, readability upgrade #4): very short (0.08-0.15 s) white star-burst
 * flashes at hit points with a quick expanding ring. Additive, unsorted, ONE draw call.
 * A minimum on-screen size keeps pops readable at range.
 */
import * as THREE from 'three';
import { palette } from '../../style/tokens';
import { Rng } from '../../core/rng';
import { ParticleBatch, SHAPE } from './particles';

export interface HitPopParams {
  name: string;
  life: [number, number];
  /** world size (m) before the screen-size floor */
  size: number;
  /** minimum projected size, fraction of viewport height */
  minScreen: number;
  heat: number;
  core: string;
  rays: string;
}

export const HIT_POP_DEFAULT: HitPopParams = {
  name: 'default',
  life: [0.08, 0.15],
  size: 2.6,
  minScreen: 0.035,
  heat: 3.0,
  core: palette.hitFlash,
  rays: palette.burstYellow,
};

export interface HitPopOptions {
  /** size multiplier (kill pops ~1.6) */
  scale?: number;
  /** ray colour token (default burstYellow; player-side hits could use playerShotHalo) */
  color?: string;
}

const _c = new THREE.Color();

export class HitPops {
  readonly group = new THREE.Group();
  readonly batch: ParticleBatch;
  readonly params: HitPopParams;
  private readonly cap: number;
  private head = 0;
  private readonly rng: Rng;
  private readonly alive: Uint8Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly p: Float32Array;
  private readonly w: Float32Array;
  private readonly rot: Float32Array;
  private readonly col: Float32Array; // ray rgb
  private readonly core = new Float32Array(3);

  constructor(capacity = 64, params: HitPopParams = HIT_POP_DEFAULT, seed = 11) {
    this.cap = Math.max(4, Math.floor(capacity));
    this.params = params;
    this.rng = new Rng(seed);
    this.batch = new ParticleBatch(this.cap, { sort: false, name: 'hit-pops', renderOrder: 4, look: { minScreen: params.minScreen, nearFade: [0.0, 0.5] } });
    this.group.name = 'HitPops';
    this.group.add(this.batch.mesh);
    const c = this.cap;
    this.alive = new Uint8Array(c);
    this.age = new Float32Array(c);
    this.life = new Float32Array(c);
    this.p = new Float32Array(c * 3);
    this.w = new Float32Array(c);
    this.rot = new Float32Array(c);
    this.col = new Float32Array(c * 3);
    _c.set(params.core);
    this.core[0] = _c.r * params.heat;
    this.core[1] = _c.g * params.heat;
    this.core[2] = _c.b * params.heat;
  }

  spawn(pos: THREE.Vector3, opts: HitPopOptions = {}): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    const r = this.rng;
    this.alive[i] = 1;
    this.age[i] = 0;
    this.life[i] = r.range(this.params.life[0], this.params.life[1]);
    this.p[i * 3] = pos.x; this.p[i * 3 + 1] = pos.y; this.p[i * 3 + 2] = pos.z;
    this.w[i] = this.params.size * (opts.scale ?? 1) * r.range(0.9, 1.1);
    this.rot[i] = r.range(-0.35, 0.35);
    _c.set(opts.color ?? this.params.rays);
    const h = this.params.heat * 0.7;
    this.col[i * 3] = _c.r * h; this.col[i * 3 + 1] = _c.g * h; this.col[i * 3 + 2] = _c.b * h;
  }

  update(dt: number, camera: THREE.Camera): void {
    const b = this.batch, out = b.data, C = this.core;
    b.begin();
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const a = (this.age[i] += dt);
      if (a >= this.life[i]) {
        this.alive[i] = 0;
        continue;
      }
      const t = a / this.life[i];
      const grow = 0.55 + 0.45 * (1 - (1 - Math.min(1, t * 2.5)) ** 2);
      const alpha = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;
      const o = b.alloc();
      if (o < 0) break;
      const i3 = i * 3;
      out[o] = this.p[i3]; out[o + 1] = this.p[i3 + 1]; out[o + 2] = this.p[i3 + 2]; out[o + 3] = this.w[i] * grow;
      out[o + 4] = C[0]; out[o + 5] = C[1]; out[o + 6] = C[2]; out[o + 7] = alpha;
      out[o + 8] = this.col[i3]; out[o + 9] = this.col[i3 + 1]; out[o + 10] = this.col[i3 + 2]; out[o + 11] = 0;
      out[o + 12] = 0; out[o + 13] = 0; out[o + 14] = 0; out[o + 15] = 1;
      out[o + 16] = this.rot[i]; out[o + 17] = SHAPE.STAR; out[o + 18] = 0; out[o + 19] = t;
    }
    b.finish(camera);
  }

  clear(): void {
    this.alive.fill(0);
    this.batch.geometry.instanceCount = 0;
    this.batch.mesh.visible = false;
  }

  dispose(): void {
    this.batch.dispose();
  }
}
