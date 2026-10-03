/**
 * Simulation data: plain pooled structs in RAIL SPACE (u ahead, x right, y up).
 * No three.js objects here except scratch vectors; the view layer reads these.
 */

export type EnemyKind = 'caltrop' | 'dart' | 'sniper' | 'strider' | 'bulwark';

export interface Enemy {
  id: number;
  alive: boolean;
  kind: EnemyKind;
  hp: number;
  maxHp: number;
  u: number;
  x: number;
  y: number;
  vu: number;
  vx: number;
  vy: number;
  /** facing yaw/roll for the view (radians) */
  yaw: number;
  roll: number;
  age: number; // world-scaled seconds since spawn
  radius: number;
  value: number;
  /** hit flash timer (frames of white remaining) */
  flash: number;
  /** locks assigned and not yet resolved by missiles */
  locks: number;
  /** behaviour parameters (pattern id, path params, timers) */
  b: BehaviourState;
  /** set when killed this frame, for the view to spawn an explosion once */
  justDied: boolean;
  /** last weapon that damaged it */
  lastHitBy: string;
  /** big enemies show a health sliver */
  big: boolean;
  /** wingtrail ring already hit this enemy (per ring id) */
  ringHit: number;
  /** leaves the field without dying (counts as escaped) */
  escaped: boolean;
}

export interface BehaviourState {
  pattern: string;
  /** chain/formation index and delay */
  index: number;
  delay: number;
  /** path parameters */
  p: number[];
  fireT: number;
  phase: number;
  phaseT: number;
  /** anchor point for hover patterns */
  ax: number;
  ay: number;
  au: number;
  laserId: number;
}

export interface Bullet {
  alive: boolean;
  u: number;
  x: number;
  y: number;
  vu: number;
  vx: number;
  vy: number;
  radius: number;
  age: number;
  life: number;
  /** reflected by a parry: now friendly */
  friendly: boolean;
  damage: number;
}

export interface Shot {
  alive: boolean;
  u: number;
  x: number;
  y: number;
  vu: number;
  vx: number;
  vy: number;
  travelled: number;
  damage: number;
}

export interface Missile {
  alive: boolean;
  u: number;
  x: number;
  y: number;
  vu: number;
  vx: number;
  vy: number;
  targetId: number;
  age: number;
  launchDelay: number;
  trailId: number;
  /** world-space position history is emitted by the view (smoke) */
  seed: number;
}

export interface Laser {
  id: number;
  alive: boolean;
  /** emitter enemy id (-1 = boss/static) */
  owner: number;
  u0: number;
  x0: number;
  y0: number;
  /** unit direction in rail space */
  du: number;
  dx: number;
  dy: number;
  length: number;
  state: 'telegraph' | 'fire' | 'off';
  t: number; // time in current state
  telegraphS: number;
  fireS: number;
  width: number; // hit radius
  kind: 'laser' | 'boss';
  damagePerS: number;
}

export interface Pickup {
  alive: boolean;
  kind: 'shield' | 'missile';
  u: number;
  x: number;
  y: number;
  vu: number;
  age: number;
}

export function makeEnemy(id: number): Enemy {
  return {
    id, alive: false, kind: 'caltrop', hp: 0, maxHp: 0, u: 0, x: 0, y: 0, vu: 0, vx: 0, vy: 0,
    yaw: 0, roll: 0, age: 0, radius: 1, value: 0, flash: 0, locks: 0,
    b: { pattern: '', index: 0, delay: 0, p: new Array(16).fill(0), fireT: 0, phase: 0, phaseT: 0, ax: 0, ay: 0, au: 0, laserId: -1 },
    justDied: false, lastHitBy: '', big: false, ringHit: -1, escaped: false,
  };
}

export function makeBullet(): Bullet {
  return { alive: false, u: 0, x: 0, y: 0, vu: 0, vx: 0, vy: 0, radius: 0.4, age: 0, life: 6, friendly: false, damage: 6 };
}

export function makeShot(): Shot {
  return { alive: false, u: 0, x: 0, y: 0, vu: 0, vx: 0, vy: 0, travelled: 0, damage: 1 };
}

export function makeMissile(): Missile {
  return { alive: false, u: 0, x: 0, y: 0, vu: 0, vx: 0, vy: 0, targetId: -1, age: 0, launchDelay: 0, trailId: -1, seed: 0 };
}

export function makeLaser(id: number): Laser {
  return {
    id, alive: false, owner: -1, u0: 0, x0: 0, y0: 0, du: 0, dx: 0, dy: 1, length: 250,
    state: 'off', t: 0, telegraphS: 0.7, fireS: 0.4, width: 1.1, kind: 'laser', damagePerS: 18,
  };
}

export function makePickup(): Pickup {
  return { alive: false, kind: 'shield', u: 0, x: 0, y: 0, vu: 0, age: 0 };
}

/** Distance squared from point P to segment A + t*D (|D| = 1, t in [0, len]). */
export function segDistSq(
  pu: number, px: number, py: number,
  au: number, ax: number, ay: number,
  du: number, dx: number, dy: number, len: number,
): number {
  const wu = pu - au, wx = px - ax, wy = py - ay;
  let t = wu * du + wx * dx + wy * dy;
  if (t < 0) t = 0;
  else if (t > len) t = len;
  const cu = au + du * t - pu, cx = ax + dx * t - px, cy = ay + dy * t - py;
  return cu * cu + cx * cx + cy * cy;
}
