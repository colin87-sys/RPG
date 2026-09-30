/**
 * Gameplay tuning: every number from Docs/DESIGN.md lives here (single source in code).
 * Tags: [O] observed, [R] reported, [A] assumption (tune in scripted playtests;
 * log every change in Docs/DECISIONS.md and DESIGN.md).
 */
export const T = {
  camera: {
    back: 20, // m behind the craft [A: seed said 9; refs show craft at ~15-20% of frame width]
    up: 5, // m above [A]
    fov: 68, // deg [A]
    followX: 0.72, // camera follows this fraction of the craft's lateral offset
    followY: 0.72,
    lag: 0.12, // s time constant of camera follow
    rollFraction: 0.3, // camera rolls 30% of craft bank [O/A]
    lookAhead: 42, // m ahead the camera looks at
    shakeMax: 0.15, // m [A]
    shakeDecay: 0.35, // s [A]
    fovKickBoost: 8, // deg added while boosting
  },
  rail: {
    speed: 45, // m/s baseline [A]
    boostMul: 1.6,
    brakeMul: 0.5,
    stageLength: 8100, // m (~180 s at baseline) [A]
  },
  move: {
    windowX: 16, // +/- m around the rail [A]
    windowY: 9, // +/- m [A]
    maxLateralSpeed: 22, // m/s [A]
    reticleDist: 60, // m ahead where the reticle sits
    reticleWindowX: 24, // +/- m at reticleDist
    reticleWindowY: 14,
    reticleSpeed: 34, // m/s reticle travel under full stick
    craftLag: 0.18, // s time constant: craft trails the reticle [O]
    bankMax: (65 * Math.PI) / 180, // [O/A]
    bankPerLateralSpeed: 0.045, // rad per m/s of lateral velocity
    pitchPerVerticalSpeed: 0.02,
  },
  cannon: {
    rate: 14, // shots/s [A]
    damage: 1,
    speed: 260, // m/s [A]
    range: 220, // m [A]
    radius: 0.35, // hit radius of a shot (m)
    spread: 0.004, // rad jitter
  },
  missiles: {
    maxLocks: 8, // [R]
    lockInterval: 0.1, // s per lock while reticle within lockRadiusPx [A]
    lockRadiusPx: 60, // at 1080p, scales with height [A]
    speed: 110, // m/s [A]
    turnRate: (240 * Math.PI) / 180, // rad/s [A]
    damage: 6, // [A]
    ammo: 6, // [A]
    ammoRegen: 12, // s per missile [A]
    launchStagger: 0.06, // s between missiles in a salvo
    maxFlight: 4.5, // s before self-destruct
  },
  boost: { duration: 0.7, exposed: 0.5, exposedDamageMul: 1.25, cooldown: 5, deflectCone: 0.6 },
  brake: { magnetRadius: 35, damageMul: 1.3 },
  roll: {
    duration: 0.45, // s [R/A]
    parryWindow: 0.2, // s from roll start [A]
    charges: 3, // [A] fix for spam
    rechargeEach: 2.0, // s [A]
    missRecovery: 0.25, // s [A]
    parryShield: 3,
    parryScore: 50,
    lateralBurst: 14, // m/s sideways impulse during a roll
  },
  drift: {
    maxDuration: 1.4, // s [A]
    timeScale: 0.35, // world time scale while drifting [A]
    steering: 0.35, // steering authority [A]
    capsuleRadius: 3, // m exhaust hitbox [R/A]
    capsuleLength: 14, // m
    tickDamage: 4, // per tick [A]
    tickRate: 15, // Hz
    recharge: 9, // s [A]
  },
  wingtrail: {
    spin: 0.9, // s full 360 [R/A]
    timeScale: 0.5,
    ringMax: 45, // m radius [O/A]
    ringGrow: 0.7, // s [O]
    damageSmall: 8,
    damageBossWeak: 30,
    killsToCharge: 40,
    timeToCharge: 14, // s [A]
  },
  shield: { max: 100, invuln: 0.6 },
  combo: {
    window: 2.0, // s [A]
    perKill: 0.6,
    cap: 3.0,
    refillThreshold: 4, // kills [R]
    refillPerS: 5, // shield/s while combo alive [R]
    multPerChain: 0.1,
    multCap: 5,
  },
  damage: { bullet: 6, collision: 25, laserPerS: 18, bossBeamPerS: 30 },
  score: { parry: 50, shieldBonusPerPoint: 10, timeBonusMax: 5000 },
  rank: { S: 0.9, A: 0.7, B: 0.5 }, // fraction of par
  difficulty: {
    easy: { hp: 0.8, fireRate: 0.8 },
    normal: { hp: 1.0, fireRate: 1.0 },
    hard: { hp: 1.3, fireRate: 1.3 },
  },
  feedback: {
    hitStopMissile: 0.04, // s [A]
    hitStopBossWeak: 0.06,
    hitFlashFrames: 2,
    chromaBase: 0.0015,
    chromaHit: 0.006,
    chromaRing: 0.008,
  },
} as const;

export type Difficulty = keyof typeof T.difficulty;
