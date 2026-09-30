/**
 * Sparks (VFX lane B): instanced velocity-aligned streaks with colour-over-life and
 * gravity-free drag. Additive (occlusion 0), so no sorting: ONE draw call, no per-frame allocation.
 */
import * as THREE from 'three';
import { palette } from '../../style/tokens';
import { Rng } from '../../core/rng';
import { ParticleBatch, SHAPE } from './particles';

export interface SparkParams {
  name: string;
  /** velocity decay per second: v *= exp(-drag * dt) */
  drag: number;
  life: [number, number];
  /** streak width (m) */
  width: number;
  /** streak length = |v| * streakS + width (motion-blur seconds) */
  streakS: number;
  /** HDR multiplier of the start colour (> 1 feeds bloom) */
  heat: number;
  /** colour the spark cools toward (token) */
  coolTo: string;
  /** additive (0) .. over (1) */
  occlusion: number;
}

export const SPARK_DEFAULT: SparkParams = {
  name: 'default',
  drag: 3.2,
  life: [0.3, 0.7],
  width: 0.16,
  streakS: 0.05,
  heat: 3.0,
  coolTo: palette.fireOrange,
  occlusion: 0.0,
};

export interface SparkBurstOptions {
  seed?: number;
  /** bias direction (unit); with spread < 1 sparks leave in a cone */
  dir?: THREE.Vector3;
  /** 0 = tight cone around dir, 1 = full sphere */
  spread?: number;
  /** life multiplier */
  life?: number;
  /** width multiplier */
  width?: number;
}

const _c = new THREE.Color();

export class Sparks {
  readonly group = new THREE.Group();
  readonly batch: ParticleBatch;
  readonly params: SparkParams;
  private readonly cap: number;
  private head = 0;
  private readonly rng: Rng;
  private readonly alive: Uint8Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly c0: Float32Array;
  private readonly w: Float32Array;
  private readonly cool: Float32Array;
  private readonly white: Float32Array;

  constructor(capacity = 1024, params: SparkParams = SPARK_DEFAULT, seed = 7) {
    this.cap = Math.max(8, Math.floor(capacity));
    this.params = params;
    this.rng = new Rng(seed);
    this.batch = new ParticleBatch(this.cap, { sort: false, name: 'sparks', renderOrder: 3 });
    this.group.name = 'Sparks';
    this.group.add(this.batch.mesh);
    const c = this.cap;
    this.alive = new Uint8Array(c);
    this.age = new Float32Array(c);
    this.life = new Float32Array(c);
    this.p = new Float32Array(c * 3);
    this.v = new Float32Array(c * 3);
    this.c0 = new Float32Array(c * 3);
    this.w = new Float32Array(c);
    this.cool = new Float32Array(3);
    _c.set(params.coolTo);
    this.cool[0] = _c.r;
    this.cool[1] = _c.g;
    this.cool[2] = _c.b;
    _c.set(palette.burstWhite);
    this.white = new Float32Array([_c.r * 0.6, _c.g * 0.6, _c.b * 0.6]);
  }

  /** Emit `count` sparks from pos at up to `speed` m/s, coloured by a token hex. */
  spawnBurst(pos: THREE.Vector3, count: number, speed: number, colorHex: string, opts: SparkBurstOptions = {}): void {
    const r = opts.seed !== undefined ? new Rng(opts.seed) : this.rng;
    const pr = this.params;
    _c.set(colorHex);
    const spread = opts.spread ?? 1;
    const d = opts.dir;
    for (let n = 0; n < count; n++) {
      const i = this.head;
      this.head = (this.head + 1) % this.cap;
      this.alive[i] = 1;
      this.age[i] = 0;
      this.life[i] = r.range(pr.life[0], pr.life[1]) * (opts.life ?? 1);
      let ux = r.gauss(), uy = r.gauss(), uz = r.gauss();
      let ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      if (d && spread < 1) {
        ux = d.x + ux * spread;
        uy = d.y + uy * spread;
        uz = d.z + uz * spread;
        ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul; uy /= ul; uz /= ul;
      }
      const s = speed * r.range(0.35, 1);
      const i3 = i * 3;
      this.p[i3] = pos.x; this.p[i3 + 1] = pos.y; this.p[i3 + 2] = pos.z;
      this.v[i3] = ux * s; this.v[i3 + 1] = uy * s; this.v[i3 + 2] = uz * s;
      const hk = pr.heat * r.range(0.8, 1.2);
      this.c0[i3] = _c.r * hk; this.c0[i3 + 1] = _c.g * hk; this.c0[i3 + 2] = _c.b * hk;
      this.w[i] = pr.width * r.range(0.7, 1.3) * (opts.width ?? 1);
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    const pr = this.params, b = this.batch, out = b.data;
    const damp = Math.exp(-pr.drag * dt);
    const cl = this.cool, wh = this.white;
    b.begin();
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const a = (this.age[i] += dt);
      const life = this.life[i];
      if (a >= life) {
        this.alive[i] = 0;
        continue;
      }
      const i3 = i * 3;
      this.v[i3] *= damp; this.v[i3 + 1] *= damp; this.v[i3 + 2] *= damp;
      this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
      const t = a / life;
      // colour over life: hot token colour -> cooling colour, dimming
      const m = t * t;
      const e = 1 - 0.75 * t;
      const cr = (this.c0[i3] + (cl[0] - this.c0[i3]) * m) * e;
      const cg = (this.c0[i3 + 1] + (cl[1] - this.c0[i3 + 1]) * m) * e;
      const cb = (this.c0[i3 + 2] + (cl[2] - this.c0[i3 + 2]) * m) * e;
      const vx = this.v[i3], vy = this.v[i3 + 1], vz = this.v[i3 + 2];
      const sp = Math.hypot(vx, vy, vz);
      const w = this.w[i] * (1 - 0.4 * t);
      const alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      const o = b.alloc();
      if (o < 0) break;
      out[o] = this.p[i3]; out[o + 1] = this.p[i3 + 1]; out[o + 2] = this.p[i3 + 2]; out[o + 3] = w;
      // inner (core) whiter, outer = spark colour
      out[o + 4] = cr * 1.6 + wh[0] * e; out[o + 5] = cg * 1.6 + wh[1] * e; out[o + 6] = cb * 1.6 + wh[2] * e; out[o + 7] = alpha;
      out[o + 8] = cr; out[o + 9] = cg; out[o + 10] = cb; out[o + 11] = 0;
      out[o + 12] = vx; out[o + 13] = vy; out[o + 14] = vz; out[o + 15] = Math.max(1.001, (sp * pr.streakS + w) / w);
      out[o + 16] = 0; out[o + 17] = SHAPE.STREAK; out[o + 18] = pr.occlusion; out[o + 19] = 0;
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
