/**
 * Explosions (VFX lane B). Per DESIGN: core sphere grows 1x -> 3x in 0.3 s, white-yellow
 * (burstWhite -> burstYellow) to orange (fireOrange); 6-10 lumpy lobes offset radially that
 * cool into dark smoke (smokeDark); many small spherical blooms popping within ~0.3 s;
 * tumbling shards; 20-40 sparks (sparks.ts). Fire colours are HDR (> 1) to feed bloom.
 *
 * Deterministic from seed. Pooled: one sorted ParticleBatch (fire + smoke, 1 draw call)
 * plus one Sparks batch (1 draw call). No per-frame allocation (spawn() allocates one Rng).
 */
import * as THREE from 'three';
import { palette, vfx } from '../../style/tokens';
import { mix, shade } from '../../style/color';
import { Rng } from '../../core/rng';
import { ParticleBatch, SHAPE, type ParticleLook, linearRGB, ease } from './particles';
import { Sparks } from './sparks';

export type ExplosionKind = 'small' | 'big' | 'boss';

export interface ExplosionParams {
  name: string;
  /** initial core radius as a fraction of `size` (grows x growScale over growS) */
  coreStart: number;
  /** HDR intensities of the fire ramp keys: hot, mid, cool, ember */
  heat: [number, number, number, number];
  /** fire ramp tokens: [inner, outer] per key (hot, mid, cool, ember) */
  ramp: [[string, string], [string, string], [string, string], [string, string]];
  lobes: [number, number];
  /** lobe offset (x size) and lobe diameter (x size) */
  lobeDist: [number, number];
  lobeSize: [number, number];
  blooms: number;
  bloomSize: [number, number];
  flakes: number;
  smoke: number;
  smokeLife: [number, number];
  smokeOpacity: number;
  sparks: number;
  /** flash glow strength (0 = none) */
  flash: number;
  /** fire occlusion (1 = opaque fire keeps saturation on bright sky, 0 = additive) */
  fireOcc: number;
  look: Partial<ParticleLook>;
}

const base: ExplosionParams = {
  name: 'A-anime',
  coreStart: 0.42,
  heat: [5.0, 2.6, 1.7, 0.9],
  ramp: [
    [palette.burstWhite, palette.burstYellow],
    [palette.burstYellow, palette.fireOrange],
    [mix(palette.fireOrange, palette.burstYellow, 0.35), palette.fireOrange],
    [palette.fireOrange, mix(palette.fireOrange, palette.smokeDark, 0.55)],
  ],
  lobes: [vfx.explosion.lobes[0] + 1, vfx.explosion.lobes[1]],
  lobeDist: [1.0, 1.7],
  lobeSize: [1.1, 1.7],
  blooms: 22,
  bloomSize: [0.3, 0.75],
  flakes: 8,
  smoke: 9,
  smokeLife: [1.2, 2.3],
  smokeOpacity: 0.88,
  sparks: 30,
  flash: 0.8,
  fireOcc: 0.8,
  look: {
    normalStrength: 0.85,
    stylize: 0.7,
    term: 0.42,
    soft: 0.28,
    keyTint: 0.3,
    ambTint: 0.4,
    backlight: 0.3,
    rim: 0.15,
    edgeDarken: 0.1,
    fireCore: 1.4,
    nearFade: [0.5, 5.0],
  },
};

/** Variants: A anime (saturated yellow -> orange, many blooms), B hot-white (whiter core, heavier smoke), C ember (redder ramp, more shards/sparks, longer smoke). */
export const EXPLOSION_VARIANTS: Record<'A' | 'B' | 'C', ExplosionParams> = {
  A: base,
  B: {
    ...base,
    name: 'B-hot-white',
    coreStart: 0.5,
    heat: [7.0, 3.4, 2.0, 0.9],
    ramp: [
      [palette.burstWhite, palette.burstWhite],
      [palette.burstWhite, palette.burstYellow],
      [palette.burstYellow, palette.fireOrange],
      [palette.fireOrange, mix(palette.fireOrange, palette.smokeDark, 0.6)],
    ],
    lobes: [vfx.explosion.lobes[0], vfx.explosion.lobes[0] + 2],
    lobeSize: [1.5, 2.3],
    blooms: 14,
    smoke: 12,
    smokeOpacity: 0.95,
    sparks: 24,
    flash: 1.2,
    look: { ...base.look, fireCore: 0.9 },
  },
  C: {
    ...base,
    name: 'C-ember',
    heat: [4.0, 2.2, 1.5, 0.8],
    ramp: [
      [palette.burstYellow, palette.fireOrange],
      [mix(palette.burstYellow, palette.fireOrange, 0.4), palette.fireOrange],
      [palette.fireOrange, mix(palette.fireOrange, palette.shieldRed, 0.5)],
      [mix(palette.fireOrange, palette.shieldRed, 0.4), mix(palette.shieldRed, palette.smokeDark, 0.6)],
    ],
    lobes: [vfx.explosion.lobes[1] - 1, vfx.explosion.lobes[1]],
    blooms: 28,
    flakes: 14,
    smokeLife: [1.6, 2.9],
    sparks: vfx.explosion.sparks[1],
    flash: 0.6,
    look: { ...base.look, fireCore: 1.8 },
  },
};

const KIND = {
  small: { count: 0.6, sparks: vfx.explosion.sparks[0], life: 0.8, subs: 0 },
  big: { count: 1.0, sparks: 30, life: 1.0, subs: 0 },
  boss: { count: 1.3, sparks: vfx.explosion.sparks[1], life: 1.3, subs: 3 },
} as const;

const T_FLASH = 0, T_CORE = 1, T_LOBE = 2, T_BLOOM = 3, T_FLAKE = 4, T_SMOKE = 5;
const PER_EXPLOSION = 64;
const MAX_PENDING = 32;

export interface ExplosionSpawnOptions {
  size: number;
  kind: ExplosionKind;
  seed?: number;
}

export class Explosions {
  readonly group = new THREE.Group();
  readonly batch: ParticleBatch;
  readonly sparks: Sparks;
  readonly params: ExplosionParams;
  private readonly cap: number;
  private head = 0;
  private time = 0;
  private seedCounter = 0;
  private readonly ownsSparks: boolean;
  // SoA particle state
  private readonly type: Uint8Array;
  private readonly alive: Uint8Array;
  private readonly birth: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array; // explosion size S
  private readonly c: Float32Array; // explosion centre xyz
  private readonly dir: Float32Array; // unit dir xyz
  private readonly a: Float32Array; // generic params (4 per particle)
  private readonly spin: Float32Array; // rot0, spin
  private readonly cell: Uint8Array;
  // ramp colours (linear): 4 keys x inner/outer x rgb
  private readonly rampC = new Float32Array(24);
  private readonly smokeLit: Float32Array;
  private readonly smokeShd: Float32Array;
  private readonly flakeC: Float32Array;
  private readonly flashC: Float32Array;
  private readonly flashC2: Float32Array;
  private readonly tmp = new Float32Array(6);
  // pending sub-bursts (boss)
  private readonly pend = new Float32Array(MAX_PENDING * 6); // t, x, y, z, size, seed
  private readonly pendOn = new Uint8Array(MAX_PENDING);
  private readonly sparkPos = new THREE.Vector3();

  constructor(capacity = 48, params: ExplosionParams = EXPLOSION_VARIANTS.A, sparks?: Sparks) {
    this.params = params;
    this.cap = Math.max(1, Math.floor(capacity)) * PER_EXPLOSION;
    this.batch = new ParticleBatch(this.cap, { sort: true, look: params.look, name: `explosions-${params.name}`, renderOrder: 2 });
    this.ownsSparks = !sparks;
    this.sparks = sparks ?? new Sparks(Math.max(1, Math.floor(capacity)) * 40, undefined, 101);
    this.group.name = 'Explosions';
    this.group.add(this.batch.mesh);
    if (this.ownsSparks) this.group.add(this.sparks.group);
    const n = this.cap;
    this.type = new Uint8Array(n);
    this.alive = new Uint8Array(n);
    this.birth = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size = new Float32Array(n);
    this.c = new Float32Array(n * 3);
    this.dir = new Float32Array(n * 3);
    this.a = new Float32Array(n * 4);
    this.spin = new Float32Array(n * 2);
    this.cell = new Uint8Array(n);
    for (let k = 0; k < 4; k++) {
      const [ih, oh] = params.ramp[k];
      const h = params.heat[k];
      this.rampC.set(linearRGB(ih, h), k * 6);
      this.rampC.set(linearRGB(oh, h * 0.8), k * 6 + 3);
    }
    this.smokeLit = linearRGB(mix(palette.smokeDark, palette.smokeShadow, 0.3));
    this.smokeShd = linearRGB(shade(palette.smokeDark, 0.55));
    this.flakeC = linearRGB(palette.fireOrange, 1.6);
    this.flashC = linearRGB(palette.burstWhite, 1.6);
    this.flashC2 = linearRGB(palette.burstYellow, 0.9);
  }

  /** Detonate at pos (group-local). size ~ enemy radius in metres. */
  spawn(pos: THREE.Vector3, opts: ExplosionSpawnOptions): void {
    const seed = opts.seed ?? 0x3e11 + this.seedCounter++ * 7919;
    this.detonate(pos.x, pos.y, pos.z, opts.size, opts.kind, seed, 0);
  }

  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    // pending sub-bursts
    for (let k = 0; k < MAX_PENDING; k++) {
      if (!this.pendOn[k]) continue;
      const o = k * 6;
      if (this.time >= this.pend[o]) {
        this.pendOn[k] = 0;
        this.detonate(this.pend[o + 1], this.pend[o + 2], this.pend[o + 3], this.pend[o + 4], 'big', this.pend[o + 5] >>> 0, 1);
      }
    }
    const p = this.params, b = this.batch, out = b.data, R = this.rampC, T = this.tmp;
    b.begin();
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const age = this.time - this.birth[i];
      if (age < 0) continue; // delayed
      const life = this.life[i];
      if (age >= life) {
        this.alive[i] = 0;
        continue;
      }
      const t = age / life;
      const S = this.size[i];
      const i3 = i * 3, i4 = i * 4;
      const cx = this.c[i3], cy = this.c[i3 + 1], cz = this.c[i3 + 2];
      const dx = this.dir[i3], dy = this.dir[i3 + 1], dz = this.dir[i3 + 2];
      const A0 = this.a[i4], A1 = this.a[i4 + 1], A2 = this.a[i4 + 2], A3 = this.a[i4 + 3];
      let x = cx, y = cy, z = cz, w = S, alpha = 1, lit = 0, occ = p.fireOcc, shape: number = SHAPE.PUFF0;
      let ir = 0, ig = 0, ib = 0, or = 0, og = 0, ob = 0;
      const rot = this.spin[i * 2] + this.spin[i * 2 + 1] * age;
      switch (this.type[i]) {
        case T_FLASH: {
          shape = SHAPE.GLOW;
          w = S * (7 + 2 * t) * A0;
          alpha = p.flash * (1 - t) * (1 - t);
          ir = this.flashC[0]; ig = this.flashC[1]; ib = this.flashC[2];
          or = this.flashC2[0]; og = this.flashC2[1]; ob = this.flashC2[2];
          occ = 0;
          break;
        }
        case T_CORE: {
          shape = SHAPE.DISC;
          const g = ease.outCubic(Math.min(1, age / vfx.explosion.growS));
          w = 2 * p.coreStart * S * (1 + (vfx.explosion.growScale - 1) * g);
          fireRamp(R, age / (vfx.explosion.growS * 1.5), T);
          ir = T[0]; ig = T[1]; ib = T[2]; or = T[3]; og = T[4]; ob = T[5];
          alpha = age < vfx.explosion.growS ? 1 : 1 - ease.smooth(vfx.explosion.growS, life, age);
          occ = p.fireOcc * 0.6;
          break;
        }
        case T_LOBE: {
          // A0 = dist (x S), A1 = diameter (x S), A2 = fire duration (s)
          const g = ease.outCubic(Math.min(1, age / 0.32));
          const r = S * A0 * (0.45 + 0.55 * g) + S * 0.25 * t;
          x = cx + dx * r; y = cy + dy * r + S * 0.15 * t * t; z = cz + dz * r;
          w = S * A1 * (0.5 + 0.5 * ease.outCubic(Math.min(1, age / 0.36))) * (1 + 0.35 * t);
          fireRamp(R, age / A2, T);
          lit = ease.smooth(0.5, 0.85, t);
          ir = T[0] + (this.smokeLit[0] - T[0]) * lit; ig = T[1] + (this.smokeLit[1] - T[1]) * lit; ib = T[2] + (this.smokeLit[2] - T[2]) * lit;
          or = T[3] + (this.smokeShd[0] - T[3]) * lit; og = T[4] + (this.smokeShd[1] - T[4]) * lit; ob = T[5] + (this.smokeShd[2] - T[5]) * lit;
          alpha = t < 0.6 ? 1 : 1 - ease.smooth(0.6, 1, t);
          occ = p.fireOcc + (1 - p.fireOcc) * lit;
          shape = this.cell[i];
          break;
        }
        case T_BLOOM: {
          // A0 = dist (x S), A1 = diameter (x S), A2 = outward speed (x S /s)
          const r = S * (A0 + A2 * age);
          x = cx + dx * r; y = cy + dy * r; z = cz + dz * r;
          w = S * A1 * (0.35 + 0.65 * ease.outQuad(Math.min(1, t / 0.3))) * (1 - 0.2 * t);
          fireRamp(R, 0.15 + t * 0.85, T);
          ir = T[0]; ig = T[1]; ib = T[2]; or = T[3]; og = T[4]; ob = T[5];
          alpha = t < 0.55 ? 1 : 1 - ease.smooth(0.55, 1, t);
          shape = SHAPE.DISC;
          break;
        }
        case T_FLAKE: {
          // A0 = speed (x S /s), A1 = diameter (x S), A2 = drag, A3 = seed
          const k = (1 - Math.exp(-A2 * age)) / A2;
          const r = S * (0.4 + A0 * k);
          x = cx + dx * r; y = cy + dy * r - S * 0.4 * age * age; z = cz + dz * r;
          w = S * A1;
          const cool = 1 - 0.7 * t;
          ir = this.flakeC[0] * cool; ig = this.flakeC[1] * cool * cool; ib = this.flakeC[2] * cool;
          or = ir * 0.55; og = ig * 0.45; ob = ib * 0.5;
          lit = 0.3;
          alpha = t < 0.7 ? 1 : 1 - ease.smooth(0.7, 1, t);
          occ = 1;
          shape = SHAPE.SHARD;
          break;
        }
        default: {
          // T_SMOKE: A0 = start dist (x S), A1 = diameter (x S), A2 = drift speed (x S /s)
          const k = (1 - Math.exp(-1.4 * age)) / 1.4;
          const r = S * (A0 + A2 * k);
          x = cx + dx * r; y = cy + dy * r + S * 0.25 * age; z = cz + dz * r;
          w = S * A1 * (1 + 1.3 * ease.outQuad(t));
          // glowing from within at first, then plain dark smoke
          const glow = 1 - ease.smooth(0.0, 0.35, age);
          ir = this.smokeLit[0] + (R[18] - this.smokeLit[0]) * glow * 0.6;
          ig = this.smokeLit[1] + (R[19] - this.smokeLit[1]) * glow * 0.6;
          ib = this.smokeLit[2] + (R[20] - this.smokeLit[2]) * glow * 0.6;
          or = this.smokeShd[0]; og = this.smokeShd[1]; ob = this.smokeShd[2];
          lit = 1 - glow * 0.5;
          const fi = ease.smooth(0, 0.22, age);
          alpha = p.smokeOpacity * fi * (t < 0.45 ? 1 : 1 - ease.smooth(0.45, 1, t));
          occ = 1;
          shape = this.cell[i];
          break;
        }
      }
      const o = b.alloc();
      if (o < 0) break;
      out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w;
      out[o + 4] = ir; out[o + 5] = ig; out[o + 6] = ib; out[o + 7] = alpha;
      out[o + 8] = or; out[o + 9] = og; out[o + 10] = ob; out[o + 11] = lit;
      out[o + 12] = 0; out[o + 13] = 0; out[o + 14] = 0; out[o + 15] = 1;
      out[o + 16] = rot; out[o + 17] = shape; out[o + 18] = occ; out[o + 19] = A3;
    }
    b.finish(camera);
    if (this.ownsSparks) this.sparks.update(dt, camera);
  }

  clear(): void {
    this.alive.fill(0);
    this.pendOn.fill(0);
    this.sparks.clear();
    this.batch.geometry.instanceCount = 0;
    this.batch.mesh.visible = false;
  }

  dispose(): void {
    this.batch.dispose();
    if (this.ownsSparks) this.sparks.dispose();
  }

  private detonate(x: number, y: number, z: number, S: number, kind: ExplosionKind, seed: number, depth: number): void {
    const p = this.params;
    const K = KIND[kind];
    const r = new Rng(seed);
    const cnt = (n: number) => Math.max(1, Math.round(n * K.count));
    this.add(T_FLASH, r, x, y, z, S, 0, 0.1, 1, 0, 0, 0);
    this.add(T_CORE, r, x, y, z, S, 0, vfx.explosion.growS * 1.55, 0, 0, 0, 0);
    const nl = r.int(p.lobes[0], p.lobes[1]) + (kind === 'boss' ? 2 : 0);
    for (let k = 0; k < nl; k++)
      this.add(T_LOBE, r, x, y, z, S, r.range(0, 0.06), r.range(0.75, 1.0) * K.life,
        r.range(p.lobeDist[0], p.lobeDist[1]), r.range(p.lobeSize[0], p.lobeSize[1]), r.range(0.5, 0.66), 0);
    const nb = cnt(p.blooms);
    for (let k = 0; k < nb; k++) {
      const u = r.next();
      const dist = 1.1 + 2.1 * u;
      this.add(T_BLOOM, r, x, y, z, S, 0.02 + 0.26 * u * r.range(0.6, 1), r.range(0.12, 0.22),
        dist, r.range(p.bloomSize[0], p.bloomSize[1]), r.range(0.5, 2.0), 0);
    }
    const nf = cnt(p.flakes);
    for (let k = 0; k < nf; k++)
      this.add(T_FLAKE, r, x, y, z, S, r.range(0, 0.03), r.range(0.35, 0.7) * K.life,
        r.range(2.5, 6.0), r.range(0.22, 0.42), r.range(2.0, 3.5), r.next());
    const ns = cnt(p.smoke) + (kind === 'boss' ? 4 : 0);
    for (let k = 0; k < ns; k++)
      this.add(T_SMOKE, r, x, y, z, S, r.range(0.24, 0.38), r.range(p.smokeLife[0], p.smokeLife[1]) * K.life,
        r.range(0.2, 1.1), r.range(1.4, 2.1), r.range(0.4, 1.0), 0);
    // sparks
    this.sparkPos.set(x, y, z);
    const nsp = depth > 0 ? Math.round(K.sparks * 0.5) : Math.round((K.sparks * p.sparks) / 30);
    this.sparks.spawnBurst(this.sparkPos, nsp, 26 * Math.sqrt(S), palette.burstYellow, { seed: seed ^ 0x5a5a, width: Math.max(1.0, Math.sqrt(S) * 1.3) });
    // boss: staggered secondary detonations
    if (depth === 0 && K.subs > 0) {
      for (let s = 0; s < K.subs; s++) {
        let slot = -1;
        for (let k = 0; k < MAX_PENDING; k++) if (!this.pendOn[k]) { slot = k; break; }
        if (slot < 0) break;
        let ux = r.gauss(), uy = r.gauss(), uz = r.gauss();
        const ul = Math.hypot(ux, uy, uz) || 1;
        const d = S * r.range(1.1, 1.8);
        const o = slot * 6;
        this.pend[o] = this.time + 0.12 + s * 0.14 + r.range(0, 0.05);
        this.pend[o + 1] = x + (ux / ul) * d;
        this.pend[o + 2] = y + (uy / ul) * d;
        this.pend[o + 3] = z + (uz / ul) * d;
        this.pend[o + 4] = S * r.range(0.55, 0.7);
        this.pend[o + 5] = (seed + 101 * (s + 1)) >>> 0;
        this.pendOn[slot] = 1;
      }
    }
  }

  private add(type: number, r: Rng, x: number, y: number, z: number, S: number, delay: number, life: number,
    a0: number, a1: number, a2: number, a3: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.alive[i] = 1;
    this.type[i] = type;
    this.birth[i] = this.time + delay;
    this.life[i] = life;
    this.size[i] = S;
    const i3 = i * 3, i4 = i * 4;
    this.c[i3] = x; this.c[i3 + 1] = y; this.c[i3 + 2] = z;
    let ux = r.gauss(), uy = r.gauss(), uz = r.gauss();
    const ul = Math.hypot(ux, uy, uz) || 1;
    this.dir[i3] = ux / ul; this.dir[i3 + 1] = uy / ul; this.dir[i3 + 2] = uz / ul;
    this.a[i4] = type === T_FLASH ? 1 : a0; this.a[i4 + 1] = a1; this.a[i4 + 2] = a2; this.a[i4 + 3] = a3;
    this.spin[i * 2] = r.range(0, Math.PI * 2);
    this.spin[i * 2 + 1] = type === T_FLAKE ? r.signed() * 12 : r.signed() * 0.6;
    this.cell[i] = r.int(0, 3);
  }
}

/** Piecewise fire ramp over u in [0, 1]: keys at 0, 0.35, 0.7, 1 -> writes inner rgb, outer rgb. */
function fireRamp(R: Float32Array, u: number, out: Float32Array): void {
  const x = u <= 0 ? 0 : u >= 1 ? 1 : u;
  let k = 0, f = 0;
  if (x < 0.35) { k = 0; f = x / 0.35; } else if (x < 0.7) { k = 1; f = (x - 0.35) / 0.35; } else { k = 2; f = (x - 0.7) / 0.3; }
  const a = k * 6, b = (k + 1) * 6;
  for (let j = 0; j < 6; j++) out[j] = R[a + j] + (R[b + j] - R[a + j]) * f;
}

export const EXPLOSION_TOKENS = ['burstWhite', 'burstYellow', 'fireOrange', 'smokeDark', 'smokeShadow', 'shieldRed'] as const;
