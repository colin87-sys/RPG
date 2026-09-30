/**
 * Enemy behaviours (rail space). Each pattern moves the enemy and may fire
 * through the Combat interface. Numbers: DESIGN.md enemy table via tuning.
 */
import type { Enemy, EnemyKind } from './sim';
import type { Rng } from '../core/rng';

export interface EnemyDef {
  hp: number;
  radius: number;
  value: number;
  big: boolean;
  contactDamage: number;
}

export const ENEMY_DEFS: Record<EnemyKind, EnemyDef> = {
  caltrop: { hp: 3, radius: 1.1, value: 100, big: false, contactDamage: 10 },
  dart: { hp: 6, radius: 2.4, value: 200, big: false, contactDamage: 25 },
  sniper: { hp: 10, radius: 2.8, value: 400, big: false, contactDamage: 25 },
  strider: { hp: 60, radius: 6.0, value: 1500, big: true, contactDamage: 25 },
  bulwark: { hp: 2400, radius: 60, value: 10000, big: true, contactDamage: 40 },
};

/** What behaviours can do to the world. Implemented by Game. */
export interface Combat {
  playerU: number; // always 0 (player sits at u = 0)
  playerX: number;
  playerY: number;
  fireRateMul: number;
  rng: Rng;
  fireBullet(u: number, x: number, y: number, vu: number, vx: number, vy: number, radius?: number): void;
  /** returns laser id */
  startLaser(owner: number, u: number, x: number, y: number, tu: number, tx: number, ty: number, kind: 'laser' | 'boss', sweep?: { dx: number; dy: number }): number;
}

const cubic = (a: number, b: number, c: number, d: number, t: number) => {
  const it = 1 - t;
  return it * it * it * a + 3 * it * it * t * b + 3 * it * t * t * c + t * t * t * d;
};

/** Aim a bullet from (u,x,y) at the player with speed v; returns velocity. */
function aimAt(c: Combat, u: number, x: number, y: number, v: number, spreadX = 0, spreadY = 0) {
  const du = c.playerU - u, dx = c.playerX + spreadX - x, dy = c.playerY + spreadY - y;
  const l = Math.hypot(du, dx, dy) || 1;
  return { vu: (du / l) * v, vx: (dx / l) * v, vy: (dy / l) * v };
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
    case 'dart': {
      // enter, hold at a standoff distance while strafing, burst-fire, then peel away
      const holdU = b.p[0], sx = b.p[1], sy = b.p[2], holdT = b.p[3], side = b.p[4];
      if (b.phase === 0) {
        e.u += (holdU - e.u) * (1 - Math.exp(-dt / 0.6));
        e.x += (sx - e.x) * (1 - Math.exp(-dt / 0.8));
        e.y += (sy - e.y) * (1 - Math.exp(-dt / 0.8));
        if (Math.abs(e.u - holdU) < 4) { b.phase = 1; b.phaseT = 0; b.fireT = 0.6; }
      } else if (b.phase === 1) {
        b.phaseT += dt;
        const px = e.x;
        e.x = sx + Math.sin(b.phaseT * 1.3 + side) * 7;
        e.y = sy + Math.sin(b.phaseT * 0.9 + side * 2) * 2.5;
        e.vx = (e.x - px) / Math.max(dt, 1e-4);
        e.roll = -e.vx * 0.05;
        b.fireT -= dt * c.fireRateMul;
        if (b.fireT <= 0) {
          b.fireT = 1.6;
          b.index = 3; // shots left in burst
          b.phaseT += 0;
        }
        if (b.index > 0) {
          b.p[7] -= dt;
          if (b.p[7] <= 0) {
            b.p[7] = 0.11;
            b.index--;
            const v = aimAt(c, e.u - 2, e.x, e.y, 60, c.rng.signed() * 1.5, c.rng.signed() * 1.0);
            c.fireBullet(e.u - 2, e.x, e.y, v.vu, v.vx, v.vy);
          }
        }
        if (b.phaseT > holdT) { b.phase = 2; b.phaseT = 0; }
      } else {
        // peel away: climb and pull ahead fast
        b.phaseT += dt;
        e.vu = 30 + b.phaseT * 60;
        e.vy = 12;
        e.vx = side > 0 ? 18 : -18;
        e.u += e.vu * dt; e.x += e.vx * dt; e.y += e.vy * dt;
        e.roll += (side > 0 ? -1 : 1) * dt * 2;
        if (e.u > 320) { e.escaped = true; return false; }
      }
      e.yaw = 0;
      return true;
    }
    case 'sniper': {
      // hold at the side, telegraph (0.7 s) then beam (0.4 s), repeat
      const hu = b.p[0], hx = b.p[1], hy = b.p[2], cycles = b.p[3];
      e.u += (hu - e.u) * (1 - Math.exp(-dt / 0.7));
      e.x += (hx - e.x) * (1 - Math.exp(-dt / 0.9));
      e.y += (hy + Math.sin(e.age * 1.1) * 1.2 - e.y) * (1 - Math.exp(-dt / 0.9));
      b.phaseT += dt * c.fireRateMul;
      if (b.phase === 0 && b.phaseT > 1.4) {
        // start telegraph aimed at the player's current position (fixed line)
        b.laserId = c.startLaser(e.id, e.u - 2, e.x, e.y, c.playerU, c.playerX, c.playerY, 'laser');
        b.phase = 1;
        b.phaseT = 0;
      } else if (b.phase === 1 && b.phaseT > 0.7 + 0.4 + 1.6) {
        b.index++;
        b.phase = 0;
        b.phaseT = 0;
        if (b.index >= cycles) b.phase = 2;
      } else if (b.phase === 2) {
        e.vu = 40;
        e.u += e.vu * dt;
        e.y += 10 * dt;
        if (e.u > 300) { e.escaped = true; return false; }
      }
      return true;
    }
    case 'strider': {
      // hover centre-ish, spread shots every 2.2 s, diagonal laser sweeps, turns to expose its back
      const hu = b.p[0], hx = b.p[1], hy = b.p[2];
      e.u += (hu - e.u) * (1 - Math.exp(-dt / 1.2));
      e.x += (hx + Math.sin(e.age * 0.6 + b.index) * 5 - e.x) * (1 - Math.exp(-dt / 1.0));
      e.y += (hy + Math.sin(e.age * 1.7 + b.index) * 1.5 - e.y) * (1 - Math.exp(-dt / 0.6));
      b.fireT -= dt * c.fireRateMul;
      if (b.fireT <= 0 && e.age > 1.5) {
        b.fireT = 2.2;
        for (let i = -2; i <= 2; i++) {
          const v = aimAt(c, e.u - 3, e.x, e.y + 2, 45, i * 4.5, Math.abs(i) * -0.8);
          c.fireBullet(e.u - 3, e.x, e.y + 2, v.vu, v.vx, v.vy, 0.5);
        }
      }
      b.phaseT += dt * c.fireRateMul;
      if (b.phaseT > 5.5 && e.age > 3) {
        b.phaseT = 0;
        // diagonal sweep from a lower corner across the window
        const fromLeft = c.rng.chance(0.5);
        const sx = fromLeft ? -22 : 22;
        c.startLaser(e.id, e.u - 3, e.x, e.y + 1, 0, sx, -12, 'laser', { dx: -sx * 1.6, dy: 20 });
      }
      // weak point: periodically turns away (back exposed) for 1.8 s
      b.p[8] += dt;
      const cycle = b.p[8] % 7.0;
      b.phase = cycle > 5.2 ? 1 : 0; // 1 = back exposed
      e.yaw += ((b.phase ? Math.PI : 0) - e.yaw) * (1 - Math.exp(-dt / 0.25));
      if (e.age > b.p[3]) {
        // retreat if still alive at the end of its segment
        e.u += 50 * dt;
        e.y += 8 * dt;
        if (e.u > 320) { e.escaped = true; return false; }
      }
      return true;
    }
    default:
      return true;
  }
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
