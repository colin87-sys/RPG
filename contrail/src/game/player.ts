/**
 * Player controller in rail space: reticle, craft offset with lag, bank/pitch,
 * and the special-move state machines (roll/parry, drift, wingtrail, boost, brake).
 * Numbers: src/data/tuning.ts (DESIGN.md).
 */
import { T } from '../data/tuning';
import type { InputFrame } from '../core/input';

export interface PlayerState {
  // reticle on the plane u = reticleDist
  rx: number;
  ry: number;
  // craft offset and velocity
  x: number;
  y: number;
  vx: number;
  vy: number;
  bank: number; // rad, + = right wing down
  pitch: number;
  yaw: number; // drift yaw (rad)
  spin: number; // wingtrail/roll spin angle (rad) added to bank
  shield: number;
  invuln: number; // s remaining
  alive: boolean;
  // roll / parry
  rollCharges: number;
  rollRecharge: number; // s until next charge
  rolling: number; // s remaining in current roll (0 = not rolling)
  rollDir: -1 | 1;
  rollAge: number; // s since roll start
  rollParried: boolean;
  rollRecovery: number; // s of lockout after a whiffed roll
  // drift
  drift: number; // s remaining (0 = inactive)
  driftDir: -1 | 1; // side the craft swings to (fixed at drift start)
  driftCharge: number; // 0..1
  driftHeld: boolean;
  // wingtrail
  wingtrail: number; // s remaining of the spin
  wingCharge: number; // 0..1
  wingKills: number;
  // boost / brake
  boost: number; // s remaining of boost
  boostExposed: number; // s remaining exposed window
  boostCd: number;
  braking: boolean;
  // cannon / missiles
  fireCd: number;
  missiles: number;
  missileRegen: number; // s accumulated toward next missile
  lockHeld: boolean;
  lockTimer: number;
  lockTargets: number[]; // enemy ids (one entry per lock)
  // hit feedback
  hitFlash: number; // 0..1
  damageTaken: number;
}

export function makePlayer(): PlayerState {
  return {
    rx: 0, ry: 0, x: 0, y: 0, vx: 0, vy: 0, bank: 0, pitch: 0, yaw: 0, spin: 0,
    shield: T.shield.max, invuln: 0, alive: true,
    rollCharges: T.roll.charges, rollRecharge: 0, rolling: 0, rollDir: 1, rollAge: 0, rollParried: false, rollRecovery: 0,
    drift: 0, driftDir: 1, driftCharge: 1, driftHeld: false,
    wingtrail: 0, wingCharge: 0, wingKills: 0,
    boost: 0, boostExposed: 0, boostCd: 0, braking: false,
    fireCd: 0, missiles: T.missiles.ammo, missileRegen: 0, lockHeld: false, lockTimer: 0, lockTargets: [],
    hitFlash: 0, damageTaken: 0,
  };
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Exponential approach factor for time constant tau over dt. */
export function approach(tau: number, dt: number): number {
  return 1 - Math.exp(-dt / Math.max(1e-4, tau));
}

export interface PlayerEvents {
  rollStarted: boolean;
  driftStarted: boolean;
  driftEnded: boolean;
  wingtrailStarted: boolean;
  boostStarted: boolean;
}

/**
 * Advance the player by real dt (the player is not slowed by bullet time; world
 * systems use worldDt). `aimToRail` maps an NDC mouse aim to reticle rail coords.
 */
export function updatePlayer(
  p: PlayerState,
  inp: InputFrame,
  edges: { rollL: boolean; rollR: boolean; drift: boolean; wing: boolean; boost: boolean },
  dt: number,
  aimToRail: ((ndcX: number, ndcY: number) => { x: number; y: number }) | null,
): PlayerEvents {
  const ev: PlayerEvents = { rollStarted: false, driftStarted: false, driftEnded: false, wingtrailStarted: false, boostStarted: false };
  const M = T.move;
  const steer = p.drift > 0 ? T.drift.steering : 1;

  // --- reticle ---
  if (inp.aim && aimToRail) {
    const target = aimToRail(inp.aim.x, inp.aim.y);
    const k = approach(0.05, dt);
    p.rx += (clamp(target.x, -M.reticleWindowX, M.reticleWindowX) - p.rx) * k * steer;
    p.ry += (clamp(target.y, -M.reticleWindowY, M.reticleWindowY) - p.ry) * k * steer;
  } else {
    p.rx += inp.moveX * M.reticleSpeed * dt * steer;
    p.ry += inp.moveY * M.reticleSpeed * dt * steer;
  }
  p.rx = clamp(p.rx, -M.reticleWindowX, M.reticleWindowX);
  p.ry = clamp(p.ry, -M.reticleWindowY, M.reticleWindowY);

  // --- craft follows the reticle (lag 0.18 s), lateral speed capped ---
  const tx = (p.rx / M.reticleWindowX) * M.windowX;
  const ty = (p.ry / M.reticleWindowY) * M.windowY;
  const k = approach(M.craftLag, dt);
  let nvx = ((tx - p.x) * k) / dt;
  let nvy = ((ty - p.y) * k) / dt;
  const sp = Math.hypot(nvx, nvy);
  if (sp > M.maxLateralSpeed) {
    nvx *= M.maxLateralSpeed / sp;
    nvy *= M.maxLateralSpeed / sp;
  }
  // roll adds a sideways burst
  if (p.rolling > 0) nvx += p.rollDir * T.roll.lateralBurst * Math.sin((p.rollAge / T.roll.duration) * Math.PI);
  p.vx = nvx;
  p.vy = nvy;
  p.x = clamp(p.x + p.vx * dt, -M.windowX, M.windowX);
  p.y = clamp(p.y + p.vy * dt, -M.windowY, M.windowY);

  // --- bank & pitch (spring-ish smoothing toward targets) ---
  const bankTarget = clamp(p.vx * M.bankPerLateralSpeed, -M.bankMax, M.bankMax);
  p.bank += (bankTarget - p.bank) * approach(0.12, dt);
  const pitchTarget = clamp(p.vy * M.pitchPerVerticalSpeed, -0.35, 0.35);
  p.pitch += (pitchTarget - p.pitch) * approach(0.15, dt);

  // --- roll (parry) charges ---
  if (p.rollCharges < T.roll.charges) {
    p.rollRecharge -= dt;
    if (p.rollRecharge <= 0) {
      p.rollCharges++;
      p.rollRecharge = p.rollCharges < T.roll.charges ? T.roll.rechargeEach : 0;
    }
  }
  if (p.rollRecovery > 0) p.rollRecovery -= dt;
  if (p.rolling > 0) {
    p.rolling -= dt;
    p.rollAge += dt;
    const f = clamp(p.rollAge / T.roll.duration, 0, 1);
    const eased = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2; // easeInOutQuad
    p.spin = p.rollDir * eased * Math.PI * 2;
    if (p.rolling <= 0) {
      p.rolling = 0;
      p.spin = 0;
      if (!p.rollParried) p.rollRecovery = T.roll.missRecovery;
    }
  } else if ((edges.rollL || edges.rollR) && p.rollCharges > 0 && p.rollRecovery <= 0 && p.drift <= 0 && p.wingtrail <= 0) {
    p.rolling = T.roll.duration;
    p.rollAge = 0;
    p.rollDir = edges.rollL ? -1 : 1;
    p.rollParried = false;
    if (p.rollCharges === T.roll.charges) p.rollRecharge = T.roll.rechargeEach;
    p.rollCharges--;
    ev.rollStarted = true;
  }

  // --- drift ---
  if (p.drift > 0) {
    p.drift -= dt;
    const f = 1 - p.drift / T.drift.maxDuration;
    // yaw swings the exhaust sideways/forward; fast ease in, held, eased out
    const env = Math.min(1, f * 6) * Math.min(1, (p.drift / T.drift.maxDuration) * 5 + 0.15);
    p.yaw = p.driftDir * env * 2.1;
    if (p.drift <= 0 || !inp.drift) {
      p.drift = 0;
      p.yaw = 0;
      p.driftCharge = 0;
      ev.driftEnded = true;
    }
  } else {
    p.yaw += (0 - p.yaw) * approach(0.1, dt);
    p.driftCharge = Math.min(1, p.driftCharge + dt / T.drift.recharge);
    if (edges.drift && p.driftCharge >= 1 && p.rolling <= 0 && p.wingtrail <= 0) {
      p.drift = T.drift.maxDuration;
      p.driftDir = p.vx >= 0 ? 1 : -1;
      ev.driftStarted = true;
    }
  }

  // --- wingtrail ---
  if (p.wingtrail > 0) {
    p.wingtrail -= dt;
    const f = clamp(1 - p.wingtrail / T.wingtrail.spin, 0, 1);
    const eased = 1 - Math.pow(1 - f, 3);
    p.spin = eased * Math.PI * 2;
    if (p.wingtrail <= 0) {
      p.wingtrail = 0;
      p.spin = 0;
    }
  } else {
    p.wingCharge = Math.min(1, p.wingCharge + dt / T.wingtrail.timeToCharge);
    if (edges.wing && p.wingCharge >= 1 && p.rolling <= 0 && p.drift <= 0) {
      p.wingtrail = T.wingtrail.spin;
      p.wingCharge = 0;
      p.wingKills = 0;
      ev.wingtrailStarted = true;
    }
  }

  // --- boost / brake ---
  if (p.boost > 0) {
    p.boost -= dt;
    if (p.boost <= 0) {
      p.boost = 0;
      p.boostExposed = T.boost.exposed;
    }
  } else if (p.boostExposed > 0) {
    p.boostExposed -= dt;
  }
  if (p.boostCd > 0) p.boostCd -= dt;
  if (edges.boost && p.boostCd <= 0 && p.boost <= 0) {
    p.boost = T.boost.duration;
    p.boostCd = T.boost.cooldown;
    ev.boostStarted = true;
  }
  p.braking = inp.brake && p.boost <= 0;

  // --- timers ---
  if (p.invuln > 0) p.invuln -= dt;
  if (p.hitFlash > 0) p.hitFlash = Math.max(0, p.hitFlash - dt * 4);
  if (p.missiles < T.missiles.ammo) {
    p.missileRegen += dt;
    if (p.missileRegen >= T.missiles.ammoRegen) {
      p.missileRegen = 0;
      p.missiles++;
    }
  } else p.missileRegen = 0;

  return ev;
}

/** Forward speed multiplier from boost/brake. */
export function speedMul(p: PlayerState): number {
  if (p.boost > 0) return T.rail.boostMul;
  if (p.braking) return T.rail.brakeMul;
  return 1;
}

/** Damage multiplier from exposure (after boost) and braking. */
export function damageMul(p: PlayerState): number {
  let m = 1;
  if (p.boostExposed > 0) m *= T.boost.exposedDamageMul;
  if (p.braking) m *= T.brake.damageMul;
  return m;
}

/** True while the parry window of a roll is open. */
export function parryOpen(p: PlayerState): boolean {
  return p.rolling > 0 && p.rollAge <= T.roll.parryWindow;
}
