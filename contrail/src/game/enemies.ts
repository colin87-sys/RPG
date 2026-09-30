/**
 * Enemy behaviours (rail space). Each pattern moves the enemy and may fire
 * through the Combat interface. Every number lives in src/data/tuning.ts
 * (T.enemies = ENEMY_DEFS, T.behaviour = per-pattern timings).
 */
import type { Enemy, EnemyKind } from './sim';
import type { Rng } from '../core/rng';
import { T } from '../data/tuning';

export interface EnemyDef {
  hp: number;
  radius: number;
  value: number;
  big: boolean;
  contactDamage: number;
}

export const ENEMY_DEFS: Record<EnemyKind, EnemyDef> = T.enemies;

/** What behaviours can do to the world. Implemented by Game. */
export interface Combat {
  playerU: number; // always 0 (player sits at u = 0)
  playerX: number;
  playerY: number;
  /** player lateral velocity (m/s), for leading shots */
  playerVX: number;
  playerVY: number;
  fireRateMul: number;
  rng: Rng;
  fireBullet(u: number, x: number, y: number, vu: number, vx: number, vy: number, radius?: number, damage?: number): void;
  /** returns laser id */
  startLaser(
    owner: number, u: number, x: number, y: number, tu: number, tx: number, ty: number, kind: 'laser' | 'boss',
    sweep?: { dx: number; dy: number }, opts?: { telegraph?: number; fire?: number },
  ): number;
  /** spawn extra enemies mid-fight (boss drone waves) */
  spawnWave(specs: SpawnSpec[]): void;
  /** a boss entered a new phase (1..3) */
  bossPhase(phase: number): void;
}

const cubic = (a: number, b: number, c: number, d: number, t: number) => {
  const it = 1 - t;
  return it * it * it * a + 3 * it * it * t * b + 3 * it * t * t * c + t * t * t * d;
};
const ease = (tau: number, dt: number) => 1 - Math.exp(-dt / tau);

/** Aim a bullet from (u,x,y) at the player with speed v; returns velocity. */
function aimAt(c: Combat, u: number, x: number, y: number, v: number, spreadX = 0, spreadY = 0, lead = 0) {
  // lead: fraction of the player's lateral velocity to anticipate over the flight time
  const tof = Math.abs(u - c.playerU) / v;
  const du = c.playerU - u, dx = c.playerX + c.playerVX * tof * lead + spreadX - x, dy = c.playerY + c.playerVY * tof * lead + spreadY - y;
  const l = Math.hypot(du, dx, dy) || 1;
  return { vu: (du / l) * v, vx: (dx / l) * v, vy: (dy / l) * v };
}

/** Rail-space positions of a BULWARK's weak points (written into out, returns count). */
export function weakPointsOf(e: Enemy, out: { u: number; x: number; y: number }[]): number {
  const W = T.behaviour.bulwark.weakPoints;
  for (let i = 0; i < W.length; i++) {
    const o = out[i] ?? (out[i] = { u: 0, x: 0, y: 0 });
    o.u = e.u + W[i][0]; o.x = e.x + W[i][1]; o.y = e.y + W[i][2];
  }
  return W.length;
}

/**
 * Advance one enemy by world dt. Returns false when it has left the field.
 */
export function updateEnemy(e: Enemy, dt: number, c: Combat): boolean {
  const b = e.b;
  e.age += dt;
  if (e.flash > 0) e.flash--;
  switch (b.pattern) {
    case 'chain': {
      // cubic Bezier through rail space, members delayed along the same path
      const tau = e.age - b.delay;
      const dur = b.p[12];
      if (tau < 0) {
        e.u = b.p[2];
        e.x = b.p[0];
        e.y = b.p[1];
        e.vu = e.vx = e.vy = 0;
        return true;
      }
      const t = Math.min(1, tau / dur);
      const nu = cubic(b.p[2], b.p[5], b.p[8], b.p[11], t);
      const nx = cubic(b.p[0], b.p[3], b.p[6], b.p[9], t);
      const ny = cubic(b.p[1], b.p[4], b.p[7], b.p[10], t);
      e.vu = (nu - e.u) / Math.max(dt, 1e-4);
      e.vx = (nx - e.x) / Math.max(dt, 1e-4);
      e.vy = (ny - e.y) / Math.max(dt, 1e-4);
      e.u = nu; e.x = nx; e.y = ny;
      e.roll += dt * 5.5; // caltrops spin
      e.yaw = Math.atan2(e.vx, -e.vu);
      if (t >= 1) {
        e.escaped = true;
        return false;
      }
      return true;
    }
    case 'ring': {
      // caltrop net: n members on a circle around the player's position that
      // closes to a point at u = 0 (tracking stops at trackUntilU so it can be escaped)
      const R = T.behaviour.caltropRing;
      const n = b.p[0];
      const t = e.age / R.duration;
      const pu = e.u;
      e.u = R.startU + (R.endU - R.startU) * t;
      if (e.u > R.trackUntilU) {
        b.ax += (c.playerX - b.ax) * ease(R.trackTau, dt);
        b.ay += (c.playerY - b.ay) * ease(R.trackTau, dt);
      }
      const r = R.radius0 * Math.max(0, e.u) / R.startU;
      const a = (b.index / n) * Math.PI * 2 + e.age * R.spin * (b.p[1] || 1);
      const px = e.x, py = e.y;
      e.x = b.ax + Math.cos(a) * r;
      e.y = b.ay + Math.sin(a) * r;
      e.vu = (e.u - pu) / Math.max(dt, 1e-4);
      e.vx = (e.x - px) / Math.max(dt, 1e-4);
      e.vy = (e.y - py) / Math.max(dt, 1e-4);
      e.roll += dt * 5.5;
      if (t >= 1) { e.escaped = true; return false; }
      return true;
    }
    case 'dart': {
      // enter, hold at a standoff distance while strafing, burst-fire, then peel away
      const D = T.behaviour.dart;
      const holdU = b.p[0], sx = b.p[1], sy = b.p[2], holdT = b.p[3], side = b.p[4];
      if (b.phase === 0) {
        // approach fire: single aimed shots once within range
        if (e.u < D.approachRange) {
          b.fireT -= dt * c.fireRateMul;
          if (b.fireT <= 0) {
            b.fireT = D.approachInterval;
            const v = aimAt(c, e.u - 2, e.x, e.y, D.bulletSpeed, c.rng.signed() * D.approachJitterX, c.rng.signed() * D.approachJitterY, D.lead);
            c.fireBullet(e.u - 2, e.x, e.y, v.vu, v.vx, v.vy);
          }
        }
        e.u += (holdU - e.u) * ease(D.enterTauU, dt);
        e.x += (sx - e.x) * ease(D.enterTauXY, dt);
        e.y += (sy - e.y) * ease(D.enterTauXY, dt);
        if (Math.abs(e.u - holdU) < 4) { b.phase = 1; b.phaseT = 0; b.fireT = D.firstBurst; }
      } else if (b.phase === 1) {
        b.phaseT += dt;
        const px = e.x;
        e.x = sx + Math.sin(b.phaseT * D.strafeFreq + side) * D.strafeAmp;
        e.y = sy + Math.sin(b.phaseT * D.bobFreq + side * 2) * D.bobAmp;
        e.vx = (e.x - px) / Math.max(dt, 1e-4);
        e.roll = -e.vx * 0.05;
        b.fireT -= dt * c.fireRateMul;
        if (b.fireT <= 0) {
          b.fireT = D.burstInterval;
          b.index = D.burstCount; // shots left in burst
        }
        if (b.index > 0) {
          b.p[7] -= dt;
          if (b.p[7] <= 0) {
            b.p[7] = D.burstGap;
            b.index--;
            const fan = (b.index - (D.burstCount - 1) / 2) * D.fanStep; // lateral fan centred on the player
            const lead = D.burstLeadMax * (1 - b.index / Math.max(1, D.burstCount - 1)); // first shot lead 0 -> last shot full lead
            const v = aimAt(c, e.u - 2, e.x, e.y, D.bulletSpeed, fan + c.rng.signed() * D.burstJitter, c.rng.signed() * D.burstJitter, lead);
            c.fireBullet(e.u - 2, e.x, e.y, v.vu, v.vx, v.vy);
          }
        }
        if (b.phaseT > holdT) { b.phase = 2; b.phaseT = 0; }
      } else {
        // peel away: climb and pull ahead fast
        b.phaseT += dt;
        e.vu = D.peelSpeed + b.phaseT * D.peelAccel;
        e.vy = D.peelClimb;
        e.vx = side > 0 ? D.peelSide : -D.peelSide;
        e.u += e.vu * dt; e.x += e.vx * dt; e.y += e.vy * dt;
        e.roll += (side > 0 ? -1 : 1) * dt * 2;
        if (e.u > 320) { e.escaped = true; return false; }
      }
      e.yaw = 0;
      return true;
    }
    case 'strafe': {
      // squadron crossing the corridor line-abreast (p: [holdU, y, dir]); fires while inside
      const S = T.behaviour.dartStrafe;
      const hu = b.p[0], hy = b.p[1], dir = b.p[2];
      e.u += (hu - e.u) * ease(0.5, dt);
      e.y += (hy + Math.sin(e.age * 2 + b.index) * 1.2 - e.y) * ease(0.4, dt);
      e.vx = dir * S.speed;
      e.x += e.vx * dt;
      e.roll = -dir * 0.6;
      e.yaw = 0;
      if (Math.abs(e.x) < S.fireHalfWidth) {
        b.fireT -= dt * c.fireRateMul;
        if (b.fireT <= 0) {
          b.fireT = S.interval;
          const v = aimAt(c, e.u - 2, e.x, e.y, S.bulletSpeed, c.rng.signed() * S.jitter, c.rng.signed() * S.jitter, S.lead);
          c.fireBullet(e.u - 2, e.x, e.y, v.vu, v.vx, v.vy);
          const w = aimAt(c, e.u - 2, e.x, e.y, S.bulletSpeed, c.rng.signed() * S.jitter, c.rng.signed() * S.jitter, S.pairLead);
          c.fireBullet(e.u - 2, e.x, e.y, w.vu, w.vx, w.vy);
        }
      }
      if (dir * e.x > S.exitX) { e.escaped = true; return false; }
      return true;
    }
    case 'sniper': {
      // hold at the side, telegraph then beam, repeat. p[4] = 1: the beam sweeps across the window
      const S = T.behaviour.sniper, L = T.laser;
      const hu = b.p[0], hx = b.p[1], hy = b.p[2], cycles = b.p[3], sweep = b.p[4];
      e.u += (hu - e.u) * ease(S.holdTauU, dt);
      e.x += (hx - e.x) * ease(S.holdTauXY, dt);
      e.y += (hy + Math.sin(e.age * 1.1) * S.bobAmp - e.y) * ease(S.holdTauXY, dt);
      b.phaseT += dt * c.fireRateMul;
      if (b.phase === 0 && b.phaseT > S.settle) {
        if (sweep) {
          // horizontal sweep at the player's height, starting on the sniper's side
          const W = T.behaviour.sniperSweep;
          const from = hx >= 0 ? W.spanX : -W.spanX;
          b.laserId = c.startLaser(e.id, e.u - 2, e.x, e.y, c.playerU, from, c.playerY, 'laser', { dx: -from * 2, dy: 0 }, { fire: W.fire });
        } else {
          // telegraph aimed at the player's current position (fixed line)
          b.laserId = c.startLaser(e.id, e.u - 2, e.x, e.y, c.playerU, c.playerX, c.playerY, 'laser');
        }
        b.phase = 1;
        b.phaseT = 0;
      } else if (b.phase === 1 && b.phaseT > L.telegraph + (sweep ? T.behaviour.sniperSweep.fire : L.fire) + S.cooldown) {
        b.index++;
        b.phase = 0;
        b.phaseT = 0;
        if (b.index >= cycles) b.phase = 2;
      } else if (b.phase === 2) {
        e.vu = S.exitSpeed;
        e.u += e.vu * dt;
        e.y += S.exitClimb * dt;
        if (e.u > 300) { e.escaped = true; return false; }
      }
      return true;
    }
    case 'strider': {
      // hover centre-ish, spread shots, diagonal laser sweeps, turns to expose its back
      const S = T.behaviour.strider;
      const hu = b.p[0], hx = b.p[1], hy = b.p[2];
      e.u += (hu - e.u) * ease(1.2, dt);
      e.x += (hx + Math.sin(e.age * 0.6 + b.index) * 5 - e.x) * ease(1.0, dt);
      e.y += (hy + Math.sin(e.age * 1.7 + b.index) * 1.5 - e.y) * ease(0.6, dt);
      b.fireT -= dt * c.fireRateMul;
      if (b.fireT <= 0 && e.age > S.warmup) {
        b.fireT = S.spreadInterval;
        b.p[9] = S.spreadRows * S.spreadCount; // shots queued for this volley
        b.p[10] = 0;
      }
      // fire the volley as a sweeping stream (one orb every spreadStagger s), so the wall
      // spreads in depth instead of stacking into one on-screen column (M2 review D-3)
      if (b.p[9] > 0) {
        b.p[10] -= dt;
        while (b.p[9] > 0 && b.p[10] <= 0) {
          const k = S.spreadRows * S.spreadCount - b.p[9];
          const r = Math.floor(k / S.spreadCount), col = k % S.spreadCount;
          const i = (r % 2 ? S.spreadCount - 1 - col : col) - (S.spreadCount - 1) / 2; // serpentine sweep
          const ry = (r - (S.spreadRows - 1) / 2) * S.spreadRowDY, rx = r % 2 ? S.spreadStepX / 2 : 0;
          const v = aimAt(c, e.u - 3, e.x, e.y + 2, S.bulletSpeed, i * S.spreadStepX + rx, ry + Math.abs(i) * -S.spreadDropY, S.lead);
          c.fireBullet(e.u - 3, e.x, e.y + 2, v.vu, v.vx, v.vy, S.bulletRadius, S.bulletDamage);
          b.p[9]--;
          b.p[10] += S.spreadStagger;
        }
      }
      if (e.age <= dt) b.phaseT = -(b.index % 3) * S.sweepStagger; // squad members never sweep together
      b.phaseT += dt * c.fireRateMul;
      if (b.phaseT > S.sweepInterval && e.age > 3) {
        b.phaseT = 0;
        // diagonal sweep from a lower corner across the window
        const fromLeft = c.rng.chance(0.5);
        const sx = fromLeft ? -S.sweepFromX : S.sweepFromX;
        c.startLaser(e.id, e.u - 3, e.x, e.y + 1, 0, sx, S.sweepFromY, 'laser', { dx: -sx * S.sweepSpanMul, dy: S.sweepRise });
      }
      // weak point: periodically turns away (back exposed)
      b.p[8] += dt;
      const cycle = b.p[8] % S.weakCycle;
      b.phase = cycle > S.weakOpenAfter ? 1 : 0; // 1 = back exposed
      e.yaw += ((b.phase ? Math.PI : 0) - e.yaw) * ease(0.25, dt);
      if (e.age > b.p[3]) {
        // retreat if still alive at the end of its segment
        e.u += S.retreatSpeed * dt;
        e.y += S.retreatClimb * dt;
        if (e.u > 320) { e.escaped = true; return false; }
      }
      return true;
    }
    case 'bulwark':
      return updateBulwark(e, dt, c);
    default:
      return true;
  }
}

// ---------------------------------------------------------------- BULWARK

/**
 * Capital boss. State: b.phase = 1..3 (by HP), b.phaseT = attack clock,
 * b.index = beams fired in the current volley, b.fireT = vent barrage timer,
 * p[0] = drone wave timer, p[1] = 0 attacking / 1 recovering, p[2] = wall gap,
 * p[3] = arrived flag, p[4] = barrage alternation, p[5] = wall alternation.
 */
function updateBulwark(e: Enemy, dt: number, c: Combat): boolean {
  const B = T.behaviour.bulwark, L = T.laser;
  const b = e.b;
  // phase by HP (never goes back)
  const want = e.hp > B.phaseHp[0] ? 1 : e.hp > B.phaseHp[1] ? 2 : 3;
  if (b.phase === 0) { b.phase = 1; c.bossPhase(1); }
  if (want > b.phase) {
    b.phase = want;
    c.bossPhase(want);
    // a phase change always opens a recovery window
    b.p[1] = 1; b.phaseT = 0; b.index = 0;
    b.fireT = 1.5;
  }
  // movement: arrive from far above, then hold ahead-above with a slow sway
  const hu = b.phase === 3 ? B.phase3U : B.holdU, hy = b.phase === 3 ? B.phase3Y : B.holdY;
  e.u += (hu - e.u) * ease(B.arriveTau, dt);
  e.y += (hy - e.y) * ease(B.arriveTau, dt);
  const px = e.x;
  e.x += (Math.sin(e.age * B.swayFreq * Math.PI * 2) * B.swayX - e.x) * ease(1.5, dt);
  e.vx = (e.x - px) / Math.max(dt, 1e-4);
  e.roll = -e.vx * 0.01;
  e.yaw = 0;
  if (!b.p[3]) {
    if (Math.abs(e.u - B.holdU) > 12) return true;
    b.p[3] = 1; b.phaseT = 0; b.p[1] = 1; b.fireT = B.ventInterval; b.p[0] = 2;
  }
  const em = B.emitters;
  const emit = (i: number, tx: number, ty: number, sweep?: { dx: number; dy: number }, opts?: { telegraph?: number; fire?: number }) => {
    const o = em[i % em.length];
    c.startLaser(e.id, e.u + o[0], e.x + o[1], e.y + o[2], c.playerU, tx, ty, 'boss', sweep, opts);
  };
  b.phaseT += dt * c.fireRateMul;

  // --- beams ---
  if (b.p[1] === 1) {
    // recovery window: no beams
    const rec = b.phase === 1 ? B.p1Recover : b.phase === 2 ? B.p2Recover : B.p3Recover;
    if (b.phaseT > rec) { b.p[1] = 0; b.phaseT = 0; b.index = 0; }
  } else if (b.phase < 3) {
    // aimed volleys: beams one after another at the player's current position
    const n = b.phase === 1 ? B.p1Beams : B.p2Beams;
    if (b.index < n && b.phaseT >= b.index * B.p1BeamGap) {
      const lead = b.index % 2 ? B.beamLead : 0; // odd beams cut off where the player is heading
      emit(b.index * 2 + (b.phase === 2 ? 1 : 0), c.playerX + c.playerVX * lead, c.playerY + c.playerVY * lead, undefined, { telegraph: B.p1Telegraph });
      b.index++;
    }
    if (b.index >= n && b.phaseT > (n - 1) * B.p1BeamGap + B.p1Telegraph + L.fire) { b.p[1] = 1; b.phaseT = 0; }
  } else {
    // phase 3: sweeping wall of beams with one gap; alternates horizontal / vertical walls
    if (b.index === 0) {
      b.index = 1;
      const vertical = (b.p[5] = 1 - b.p[5]) === 1; // vertical line of beams sweeping sideways
      const gap = c.rng.range(-1, 1) * (vertical ? 3 : 9);
      b.p[2] = gap;
      let k = 0;
      const half = B.p3Gap / 2;
      const dirS = b.p[4] ? -1 : 1; // sweep direction alternates
      for (let side = -1; side <= 1; side += 2) {
        for (let j = 0; j < B.p3Beams / 2; j++) {
          const off = gap + side * (half + j * B.p3Spacing);
          if (vertical) emit(k++, -dirS * B.p3Sweep / 2, off, { dx: dirS * B.p3Sweep, dy: 0 }, { telegraph: B.p3Telegraph, fire: B.p3Fire });
          else emit(k++, off, dirS * B.p3Sweep / 2, { dx: 0, dy: -dirS * B.p3Sweep }, { telegraph: B.p3Telegraph, fire: B.p3Fire });
        }
      }
      b.p[4] = 1 - b.p[4];
    }
    if (b.phaseT > B.p3Telegraph + B.p3Fire) { b.p[1] = 1; b.phaseT = 0; b.index = 0; }
  }

  // --- vent barrages (phase 2+) ---
  if (b.phase >= 2) {
    b.fireT -= dt * c.fireRateMul;
    if (b.fireT <= 0) {
      b.fireT = b.phase === 2 ? B.ventInterval : B.p3VentInterval;
      const ou = e.u - 30, ox = e.x, oy = e.y - 14;
      const alt = (b.p[6] = 1 - b.p[6]);
      for (let r = 0; r < B.ventRows; r++) {
        for (let i = 0; i < B.ventPerRow; i++) {
          const along = (i - (B.ventPerRow - 1) / 2) * B.ventSpreadX;
          const across = (r === 0 ? -1 : 1) * B.ventRowDY;
          // A: two rows above/below the player; B: two columns left/right
          const sx = alt ? along : across * 1.2, sy = alt ? across : along * 0.55;
          const v = aimAt(c, ou, ox, oy, B.ventSpeed, sx, sy, 0);
          c.fireBullet(ou, ox, oy, v.vu, v.vx, v.vy, B.ventRadius);
        }
      }
    }
    // drone waves (phase 2 only: phase 3 offers no easy chain to refill the shield)
    b.p[0] -= dt;
    if (b.p[0] <= 0 && b.phase === 2) {
      b.p[0] = B.waveInterval;
      const s = c.rng.chance(0.5) ? 1 : -1;
      c.spawnWave(chainSpecs(B.waveSize, [[e.x + s * 30, e.y - 20, e.u - 40], [s * 26, 10, 110], [-s * 14, -2, 50], [-s * 30, -10, -25]], 5.0));
    }
  }
  return true;
}

/** Spawn helpers used by stage scripts. They only fill fields; Game allocates. */
export interface SpawnSpec {
  kind: EnemyKind;
  pattern: string;
  u: number;
  x: number;
  y: number;
  delay?: number;
  index?: number;
  p?: number[];
}

/** Build a caltrop chain: n members along a Bezier from (x0,y0,u0) to (x3,y3,u3). */
export function chainSpecs(n: number, pts: [number, number, number][], dur: number, spacing = 0.16): SpawnSpec[] {
  const out: SpawnSpec[] = [];
  const p = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    p[i * 3] = pts[i][0];
    p[i * 3 + 1] = pts[i][1];
    p[i * 3 + 2] = pts[i][2];
  }
  p[12] = dur;
  for (let i = 0; i < n; i++) out.push({ kind: 'caltrop', pattern: 'chain', u: pts[0][2], x: pts[0][0], y: pts[0][1], delay: i * spacing, index: i, p: p.slice() });
  return out;
}

/** Caltrop net of n members closing on the player (Wreckfield). spin: +1 / -1. */
export function ringSpecs(n: number, spin = 1): SpawnSpec[] {
  const R = T.behaviour.caltropRing;
  const out: SpawnSpec[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ kind: 'caltrop', pattern: 'ring', u: R.startU, x: Math.cos(a) * R.radius0, y: Math.sin(a) * R.radius0, index: i, p: [n, spin] });
  }
  return out;
}

/** Dart squadron crossing the corridor line-abreast at distance holdU (Violet Tide). dir +1 = left to right. */
export function strafeSpecs(n: number, holdU: number, y: number, dir: 1 | -1): SpawnSpec[] {
  const S = T.behaviour.dartStrafe;
  const out: SpawnSpec[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ kind: 'dart', pattern: 'strafe', u: holdU + 40 + i * 6, x: -dir * (48 + i * S.spacing), y: y + 6, index: i, p: [holdU + i * 6, y, dir] });
  }
  return out;
}
