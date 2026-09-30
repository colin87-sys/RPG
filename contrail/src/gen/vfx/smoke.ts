/**
 * Missile smoke trails (VFX lane B): thick, pale, cream-white puffy ropes.
 *
 * - Instanced camera-facing puffs from the shared lumpy puff atlas (particles.ts), lit by
 *   the shared rig: lit side smokeLit toward uKeyDir, shadow side smokeShadow, slight fog.
 * - Emission is distance-based (a puff every `spacing` metres of travel relative to the air)
 *   with DESIGN's 30 puffs/s as a time-based floor. At missile speed (110 m/s) a pure 30/s rate
 *   leaves 3.7 m gaps between 0.8 m puffs, i.e. dots; young puffs are also stretched along the
 *   path so the head of the trail reads as a continuous line.
 * - Puffs grow widthStart -> widthEnd over life (5 s), drift, wobble coherently along the
 *   trail and fade near end of life.
 * - ONE draw call per SmokeTrails; no per-frame allocation.
 *
 * Space: positions passed to emit() are in the group's local space. Parent `group` to the
 * world (world-static smoke) or to a rail frame (smoke persists in view; use `wind` to let
 * it slide back).
 */
import * as THREE from 'three';
import { vfx } from '../../style/tokens';
import { Rng } from '../../core/rng';
import { ParticleBatch, type ParticleLook, linearRGB } from './particles';

export interface SmokeParams {
  name: string;
  lifeS: number;
  widthStart: number;
  widthEnd: number;
  /** growth curve exponent: w = w0 + (w1 - w0) * (1 - (1 - t)^growth) */
  growth: number;
  /** minimum time-based emission rate (DESIGN: 30 puffs/s) */
  puffsPerS: number;
  /** distance between puffs along the path (m, relative to the air) */
  spacing: number;
  /** safety cap of puffs per emit() call */
  maxPerStep: number;
  /** puff centre opacity */
  opacity: number;
  /** young-puff elongation along the path: length = spacing * stretch (relaxes as the puff grows) */
  stretch: number;
  /** emission position jitter, fraction of widthStart */
  jitter: number;
  /** random drift speed (m/s), decays with drag */
  spread: number;
  drag: number;
  /** buoyant rise (m/s) */
  rise: number;
  /** coherent wobble amplitude at end of life (m) and spatial frequency along the trail (1/m) */
  turbulence: number;
  turbFreq: number;
  /** per-puff size randomisation (+/- fraction) */
  sizeJitter: number;
  /** max spin (rad/s) */
  spin: number;
  fadeInS: number;
  /** fraction of life over which the puff fades out */
  fadeOut: number;
  /** opacity lost as the puff expands (0..1) */
  thinning: number;
  /** brightness jitter per puff (+/- fraction) */
  shadeJitter: number;
  lit: string;
  shadow: string;
  look: Partial<ParticleLook>;
}

const base: SmokeParams = {
  name: 'A-rope',
  lifeS: vfx.smoke.lifeS,
  widthStart: vfx.smoke.widthStart,
  widthEnd: vfx.smoke.widthEnd,
  growth: 2.4,
  puffsPerS: vfx.smoke.puffsPerS,
  spacing: 0.85,
  maxPerStep: 12,
  opacity: 0.9,
  stretch: 1.9,
  jitter: 0.18,
  spread: 0.45,
  drag: 0.6,
  rise: 0,
  turbulence: 0.55,
  turbFreq: 0.09,
  sizeJitter: 0.14,
  spin: 0.25,
  fadeInS: 0.06,
  fadeOut: 0.4,
  thinning: 0.3,
  shadeJitter: 0.04,
  lit: vfx.smoke.lit,
  shadow: vfx.smoke.shadow,
  look: {
    normalStrength: 0.75,
    stylize: 0.75,
    term: 0.4,
    soft: 0.3,
    frontBias: 0.15,
    keyTint: 0.3,
    ambTint: 0.35,
    backlight: 0.55,
    rim: 0.1,
    edgeDarken: 0.12,
    density: 1.0,
    nearFade: [0.4, 4.0],
  },
};

/** Variants: A rope (reference-faithful), B cumulus (chunky, high contrast), C wisp (soft, warm, streaky). */
export const SMOKE_VARIANTS: Record<'A' | 'B' | 'C', SmokeParams> = {
  A: base,
  B: {
    ...base,
    name: 'B-cumulus',
    spacing: 1.0,
    opacity: 1.0,
    jitter: 0.32,
    sizeJitter: 0.25,
    turbulence: 0.8,
    spin: 0.4,
    thinning: 0.2,
    look: { ...base.look, normalStrength: 1.0, term: 0.44, soft: 0.17, keyTint: 0.22, ambTint: 0.45, backlight: 0.35, rim: 0.18, edgeDarken: 0.22 },
  },
  C: {
    ...base,
    name: 'C-wisp',
    spacing: 0.7,
    opacity: 0.72,
    stretch: 2.6,
    growth: 1.8,
    jitter: 0.12,
    turbulence: 1.3,
    turbFreq: 0.06,
    thinning: 0.45,
    look: { ...base.look, normalStrength: 0.5, term: 0.38, soft: 0.4, keyTint: 0.5, ambTint: 0.25, backlight: 1.0, rim: 0.08, edgeDarken: 0.05 },
  },
};

/** Thin variant for the player's exhaust contrail (use its own SmokeTrails; set `wind` to the rail speed in a rail frame). */
export const SMOKE_EXHAUST: SmokeParams = {
  ...base,
  name: 'exhaust-thin',
  lifeS: 1.6,
  widthStart: 0.22,
  widthEnd: 1.1,
  growth: 2.0,
  puffsPerS: 60,
  spacing: 0.32,
  maxPerStep: 40,
  opacity: 0.55,
  stretch: 2.4,
  jitter: 0.1,
  spread: 0.2,
  turbulence: 0.25,
  turbFreq: 0.2,
  thinning: 0.4,
  look: { ...base.look, normalStrength: 0.55, edgeDarken: 0.05, nearFade: [0.2, 2.0] },
};

const MAX_TRAILS = 64;

interface Trail {
  id: number;
  active: boolean;
  hasLast: boolean;
  lx: number;
  ly: number;
  lz: number;
  carry: number;
  since: number;
  arc: number;
  phase: number;
}

export class SmokeTrails {
  readonly group = new THREE.Group();
  readonly batch: ParticleBatch;
  readonly params: SmokeParams;
  /** air drift in group-local space (m/s), e.g. (0, 0, +railSpeed) for exhaust in a rail frame */
  readonly wind = new THREE.Vector3();
  private readonly cap: number;
  private time = 0;
  private head = 0;
  private nextId = 1;
  private readonly rng: Rng;
  private readonly trails: Trail[] = [];
  // SoA puff state
  private readonly alive: Uint8Array;
  private readonly birth: Float32Array;
  private readonly life: Float32Array;
  private readonly p0: Float32Array; // x,y,z
  private readonly v0: Float32Array; // x,y,z
  private readonly tan: Float32Array; // x,y,z
  private readonly w0: Float32Array;
  private readonly w1: Float32Array;
  private readonly rot: Float32Array; // rot0, spin
  private readonly arc: Float32Array;
  private readonly ph: Float32Array;
  private readonly cell: Uint8Array;
  private readonly shadeK: Float32Array;
  private readonly litC: Float32Array;
  private readonly shdC: Float32Array;
  private liveCount = 0;

  constructor(capacityPuffs = 3000, params: SmokeParams = SMOKE_VARIANTS.A, seed = 1) {
    this.cap = Math.max(16, Math.floor(capacityPuffs));
    this.params = params;
    this.rng = new Rng(seed);
    this.batch = new ParticleBatch(this.cap, { sort: true, look: params.look, name: `smoke-${params.name}`, renderOrder: 1 });
    this.group.name = 'SmokeTrails';
    this.group.add(this.batch.mesh);
    const c = this.cap;
    this.alive = new Uint8Array(c);
    this.birth = new Float32Array(c);
    this.life = new Float32Array(c);
    this.p0 = new Float32Array(c * 3);
    this.v0 = new Float32Array(c * 3);
    this.tan = new Float32Array(c * 3);
    this.w0 = new Float32Array(c);
    this.w1 = new Float32Array(c);
    this.rot = new Float32Array(c * 2);
    this.arc = new Float32Array(c);
    this.ph = new Float32Array(c);
    this.cell = new Uint8Array(c);
    this.shadeK = new Float32Array(c);
    this.litC = linearRGB(params.lit);
    this.shdC = linearRGB(params.shadow);
    for (let i = 0; i < MAX_TRAILS; i++)
      this.trails.push({ id: 0, active: false, hasLast: false, lx: 0, ly: 0, lz: 0, carry: 0, since: 0, arc: 0, phase: 0 });
  }

  /** Live puff count (for perf HUD / tests). */
  get puffs(): number {
    return this.liveCount;
  }

  startTrail(): number {
    let slot = -1;
    let oldest = Infinity;
    for (let i = 0; i < MAX_TRAILS; i++) {
      const t = this.trails[i];
      if (!t.active) {
        slot = i;
        break;
      }
      if (t.id < oldest) {
        oldest = t.id;
        slot = i;
      }
    }
    const t = this.trails[slot];
    t.id = this.nextId++;
    t.active = true;
    t.hasLast = false;
    t.carry = 0;
    t.since = 0;
    t.arc = 0;
    t.phase = this.rng.range(0, Math.PI * 2);
    return t.id;
  }

  endTrail(trailId: number): void {
    const t = this.find(trailId);
    if (t) t.active = false;
  }

  /** Call every step while the emitter flies. pos in group-local space. */
  emit(trailId: number, pos: THREE.Vector3, dt: number): void {
    const t = this.find(trailId);
    if (!t) return;
    const p = this.params;
    if (!t.hasLast) {
      this.spawn(t, pos.x, pos.y, pos.z, 0, 0, 0, 0);
      t.hasLast = true;
      t.lx = pos.x;
      t.ly = pos.y;
      t.lz = pos.z;
      return;
    }
    const dx = pos.x - t.lx, dy = pos.y - t.ly, dz = pos.z - t.lz;
    const rx = dx - this.wind.x * dt, ry = dy - this.wind.y * dt, rz = dz - this.wind.z * dt;
    const d = Math.hypot(rx, ry, rz);
    const inv = d > 1e-6 ? 1 / d : 0;
    const tx = rx * inv, ty = ry * inv, tz = rz * inv;
    const sp = p.spacing;
    let s = sp - t.carry;
    let emitted = 0;
    let lastF = 0;
    while (s <= d && emitted < p.maxPerStep) {
      const f = s / d;
      this.spawn(t, t.lx + dx * f, t.ly + dy * f, t.lz + dz * f, (1 - f) * dt, tx, ty, tz);
      t.arc += sp;
      lastF = f;
      s += sp;
      emitted++;
    }
    if (emitted > 0) {
      t.carry = Math.max(0, d - (s - sp));
      t.since = (1 - lastF) * dt;
    } else {
      t.carry += d;
      t.since += dt;
    }
    if (t.since >= 1 / p.puffsPerS) {
      this.spawn(t, pos.x, pos.y, pos.z, 0, tx, ty, tz);
      t.since = 0;
      t.carry = 0;
    }
    t.lx = pos.x;
    t.ly = pos.y;
    t.lz = pos.z;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;
    const p = this.params;
    const b = this.batch;
    const out = b.data;
    const wx = this.wind.x, wy = this.wind.y + p.rise, wz = this.wind.z;
    const L = this.litC, S = this.shdC;
    b.begin();
    let live = 0;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const age = this.time - this.birth[i];
      const life = this.life[i];
      if (age >= life) {
        this.alive[i] = 0;
        continue;
      }
      live++;
      const t = age / life;
      const g = 1 - Math.pow(1 - t, p.growth);
      const w = this.w0[i] + (this.w1[i] - this.w0[i]) * g;
      const k = (1 - Math.exp(-p.drag * age)) / p.drag;
      // coherent wobble: phase from the arc position so neighbours move together
      const A = p.turbulence * Math.sqrt(t);
      const th = this.arc[i] * p.turbFreq * 6.2831853 + this.ph[i];
      const i3 = i * 3;
      const x = this.p0[i3] + this.v0[i3] * k + wx * age + A * Math.sin(th + age * 0.9);
      const y = this.p0[i3 + 1] + this.v0[i3 + 1] * k + wy * age + A * Math.sin(th * 0.83 + 2.1 + age * 0.7);
      const z = this.p0[i3 + 2] + this.v0[i3 + 2] * k + wz * age + A * 0.6 * Math.sin(th * 1.21 + 4.2 + age * 0.8);
      const fin = t > 1 - p.fadeOut ? 1 - smooth01((t - (1 - p.fadeOut)) / p.fadeOut) : 1;
      const fi = age < p.fadeInS ? age / p.fadeInS : 1;
      const alpha = p.opacity * fi * fin * (1 - p.thinning * t);
      const stretch = Math.max(1, (p.spacing * p.stretch) / w);
      const hasTan = this.tan[i3] !== 0 || this.tan[i3 + 1] !== 0 || this.tan[i3 + 2] !== 0;
      const sk = this.shadeK[i];
      const o = b.alloc();
      if (o < 0) break;
      out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w;
      out[o + 4] = L[0] * sk; out[o + 5] = L[1] * sk; out[o + 6] = L[2] * sk; out[o + 7] = alpha;
      out[o + 8] = S[0] * sk; out[o + 9] = S[1] * sk; out[o + 10] = S[2] * sk; out[o + 11] = 1;
      out[o + 12] = this.tan[i3]; out[o + 13] = this.tan[i3 + 1]; out[o + 14] = this.tan[i3 + 2];
      out[o + 15] = hasTan ? stretch : 1;
      out[o + 16] = this.rot[i * 2] + this.rot[i * 2 + 1] * age; out[o + 17] = this.cell[i];
      out[o + 18] = 1; out[o + 19] = (i % 97) / 97;
    }
    this.liveCount = live;
    b.finish(camera);
  }

  /** Remove every puff and trail (stage restart). */
  clear(): void {
    this.alive.fill(0);
    for (const t of this.trails) t.active = false;
    this.liveCount = 0;
    this.batch.begin();
    this.batch.geometry.instanceCount = 0;
    this.batch.mesh.visible = false;
  }

  dispose(): void {
    this.batch.dispose();
  }

  private find(id: number): Trail | null {
    for (let i = 0; i < MAX_TRAILS; i++) {
      const t = this.trails[i];
      if (t.id === id && t.active) return t;
    }
    return null;
  }

  private spawn(t: Trail, x: number, y: number, z: number, ageOffset: number, tx: number, ty: number, tz: number): void {
    const p = this.params, r = this.rng;
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.alive[i] = 1;
    this.birth[i] = this.time - ageOffset;
    this.life[i] = p.lifeS * r.range(0.85, 1.1);
    const j = p.jitter * p.widthStart;
    const i3 = i * 3;
    this.p0[i3] = x + r.signed() * j;
    this.p0[i3 + 1] = y + r.signed() * j;
    this.p0[i3 + 2] = z + r.signed() * j;
    const sp = p.spread * r.range(0.3, 1);
    // random direction (normalised gaussian-ish)
    let ux = r.gauss(), uy = r.gauss(), uz = r.gauss();
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    this.v0[i3] = ux * sp;
    this.v0[i3 + 1] = uy * sp;
    this.v0[i3 + 2] = uz * sp;
    this.tan[i3] = tx;
    this.tan[i3 + 1] = ty;
    this.tan[i3 + 2] = tz;
    const sj = p.sizeJitter;
    this.w0[i] = p.widthStart * r.range(1 - sj, 1 + sj);
    this.w1[i] = p.widthEnd * r.range(1 - sj, 1 + sj);
    this.rot[i * 2] = r.range(0, Math.PI * 2);
    this.rot[i * 2 + 1] = r.signed() * p.spin;
    this.arc[i] = t.arc;
    this.ph[i] = t.phase;
    this.cell[i] = r.int(0, 3);
    this.shadeK[i] = 1 + r.signed() * p.shadeJitter;
  }
}

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** Tokens this module reads (for manifests). */
export const SMOKE_TOKENS = ['smokeLit', 'smokeShadow'] as const;
