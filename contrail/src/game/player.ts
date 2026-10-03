/**
 * Player controller in rail space: reticle, craft offset with lag, bank/pitch,
 * and the special-move state machines (roll/parry, wingtrail).
 * Controls were simplified on owner request: drift, boost and brake were removed; the
 * cannon auto-fires; one ROLL input (direction from the stick).
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
  yaw: number; // facing yaw (rad), eases back to 0
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
  // wingtrail
  wingtrail: number; // s remaining of the spin
  wingCharge: number; // 0..1
  wingKills: number;
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
    wingtrail: 0, wingCharge: 0, wingKills: 0,
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
  wingtrailStarted: boolean;
}

/**
 * Advance the player by real dt (the player is not slowed by bullet time; world
 * systems use worldDt). `aimToRail` maps an NDC mouse aim to reticle rail coords.
 */
export function updatePlayer(
  p: PlayerState,
  inp: InputFrame,
  edges: { roll: boolean; wing: boolean },
  dt: number,
  aimToRail: ((ndcX: number, ndcY: number) => { x: number; y: number }) | null,
): PlayerEvents {
  const ev: PlayerEvents = { rollStarted: false, wingtrailStarted: false };
  const M = T.move;

  // --- direct craft control (owner feedback: old reticle-first steering felt slow) ---
  // Stick/keys set a target velocity; the craft reaches it in ~accelTime. The mouse sets a
  // target position that the craft chases hard. The reticle then leads the craft.
  let dvx: number, dvy: number;
  if (inp.aim && aimToRail) {
    const target = aimToRail(inp.aim.x, inp.aim.y);
    const txm = clamp((target.x / M.reticleWindowX) * M.windowX, -M.windowX, M.windowX);
    const tym = clamp((target.y / M.reticleWindowY) * M.windowY, -M.windowY, M.windowY);
    dvx = clamp((txm - p.x) / M.mouseChase, -M.maxLateralSpeed, M.maxLateralSpeed);
    dvy = clamp((tym - p.y) / M.mouseChase, -M.maxLateralSpeed, M.maxLateralSpeed);
  } else {
    dvx = inp.moveX * M.maxLateralSpeed;
    dvy = inp.moveY * M.maxLateralSpeed * M.verticalSpeedMul;
  }
  const accel = approach(M.accelTime, dt);
  p.vx += (dvx - p.vx) * accel;
  p.vy += (dvy - p.vy) * accel;
  // roll adds a sideways burst
  const burst = p.rolling > 0 ? p.rollDir * T.roll.lateralBurst * Math.sin((p.rollAge / T.roll.duration) * Math.PI) : 0;
  p.x += (p.vx + burst) * dt;
  p.y += p.vy * dt;
  // soft walls: stop velocity into the edge
  if (p.x > M.windowX) { p.x = M.windowX; if (p.vx > 0) p.vx = 0; }
  if (p.x < -M.windowX) { p.x = -M.windowX; if (p.vx < 0) p.vx = 0; }
  if (p.y > M.windowY) { p.y = M.windowY; if (p.vy > 0) p.vy = 0; }
  if (p.y < -M.windowY) { p.y = -M.windowY; if (p.vy < 0) p.vy = 0; }
  // reticle: ahead of the craft, leading in the direction of motion
  const sx = M.reticleWindowX / M.windowX, sy = M.reticleWindowY / M.windowY;
  const rtx = clamp(p.x * sx + p.vx * M.reticleLead, -M.reticleWindowX, M.reticleWindowX);
  const rty = clamp(p.y * sy + p.vy * M.reticleLead, -M.reticleWindowY, M.reticleWindowY);
  const rk = approach(0.05, dt);
  p.rx += (rtx - p.rx) * rk;
  p.ry += (rty - p.ry) * rk;

  // --- bank & pitch (spring-ish smoothing toward targets) ---
  const bankTarget = clamp(p.vx * M.bankPerLateralSpeed, -M.bankMax, M.bankMax);
  p.bank += (bankTarget - p.bank) * approach(0.08, dt);
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
  } else if (edges.roll && p.rollCharges > 0 && p.rollRecovery <= 0 && p.wingtrail <= 0) {
    p.rolling = T.roll.duration;
    p.rollAge = 0;
    // one ROLL input: toward the held stick, else the way the craft is drifting, else right
    p.rollDir = inp.rollDir !== 0 ? inp.rollDir : inp.moveX < -0.2 ? -1 : inp.moveX > 0.2 ? 1 : p.vx < -2 ? -1 : 1;
    p.rollParried = false;
    if (p.rollCharges === T.roll.charges) p.rollRecharge = T.roll.rechargeEach;
    p.rollCharges--;
    ev.rollStarted = true;
  }

  p.yaw += (0 - p.yaw) * approach(0.1, dt);

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
    if (edges.wing && p.wingCharge >= 1 && p.rolling <= 0) {
      p.wingtrail = T.wingtrail.spin;
      p.wingCharge = 0;
      p.wingKills = 0;
      ev.wingtrailStarted = true;
    }
  }

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

/** True while the parry window of a roll is open. */
export function parryOpen(p: PlayerState): boolean {
  return p.rolling > 0 && p.rollAge <= T.roll.parryWindow;
}
