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
    ammoRegen: 4, // s per missile [A] (was 12: barrages too rare; M2 review had 0/6 ammo in every frame)
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
    parryShield: 1, // [A] T027: was 3 (parries alone refilled ~50 shield per run)
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
  damage: { bullet: 8, collision: 25, laserPerS: 18, bossBeamPerS: 30 },
  /** hostile beams (sniper, strider sweep, boss) */
  laser: {
    telegraph: 0.7, // s thin line before damage [R/A]
    fire: 0.4, // s beam [A]
    sweepFire: 1.0, // s a sweeping beam travels [A]
    width: 1.1, // m hit radius of a small laser
    bossWidth: 3.2, // m hit radius of a boss beam
    overshoot: 120, // m the beam extends past its target
  },
  /** ENEMY_DEFS: hp, hit radius (m), score value, big (health sliver), contact damage */
  enemies: {
    caltrop: { hp: 3, radius: 1.8, value: 100, big: false, contactDamage: 10 }, // r 1.8 readability (T026)
    dart: { hp: 10, radius: 3.0, value: 200, big: false, contactDamage: 25 },
    sniper: { hp: 10, radius: 2.8, value: 400, big: false, contactDamage: 25 },
    strider: { hp: 60, radius: 6.0, value: 1500, big: true, contactDamage: 25 },
    // BULWARK: 3 phases 600/800/1000 [A]; radius is the core hull sphere (weak points sit outside it)
    bulwark: { hp: 2400, radius: 28, value: 10000, big: true, contactDamage: 40 },
  },
  /** enemy behaviour numbers (src/game/enemies.ts reads these) */
  behaviour: {
    dart: {
      approachRange: 190, // m: single aimed shots start inside this distance
      approachInterval: 0.9, // s between approach shots (T027: was 1.1)
      bulletSpeed: 50, // m/s (T027: was 60; slower orbs live longer on screen)
      lead: 0.0, // approach shots: aimed at where the player is (T027: was 0.8)
      burstLeadMax: 1.0, // burst shots bracket from lead 0 (first) to this (last): where you are -> where you will be
      approachJitterX: 1.2, approachJitterY: 0.8, // m aim scatter
      enterTauU: 0.6, enterTauXY: 0.8, // s approach time constants
      strafeAmp: 7, strafeFreq: 1.3, bobAmp: 2.5, bobFreq: 0.9,
      burstInterval: 1.3, // s between bursts [A] (T027: was 1.6)
      burstCount: 4, // (T027: was 3)
      burstGap: 0.11, // s between shots in a burst
      fanStep: 1.6, // m lateral fan between burst shots (T027: was 3.2; the lead bracket separates the shots)
      burstJitter: 0.8,
      firstBurst: 0.2, // s after reaching hold
      peelSpeed: 30, peelAccel: 60, peelClimb: 12, peelSide: 18,
    },
    /** Violet Tide: a squadron crossing the corridor line-abreast, firing as it passes */
    dartStrafe: {
      speed: 26, // m/s lateral crossing speed
      spacing: 11, // m between squadron members along the line
      interval: 0.75, // s between aimed shots per dart while inside the corridor
      fireHalfWidth: 30, // m: only fires while |x| < this
      bulletSpeed: 50,
      lead: 0.3,
      pairLead: 1.1, // each volley is a pair: one at lead, one at this lead (brackets the player's path)
      jitter: 1.0,
      exitX: 75, // m: leaves the field beyond this
    },
    sniper: {
      settle: 1.4, // s between beams (hold before telegraph)
      cooldown: 1.6, // s after the beam
      exitSpeed: 40, exitClimb: 10,
      holdTauU: 0.7, holdTauXY: 0.9, bobAmp: 1.2,
    },
    /** Violet Tide / Wreckfield: sniper beam that sweeps horizontally across the window at player height */
    sniperSweep: { spanX: 26, fire: 1.3 },
    strider: {
      spreadStagger: 0.045, // s between orbs of one volley (sweeping stream)
      warmup: 1.5, // s before the first spread
      spreadInterval: 1.5, // s [A] (T027: was 1.7)
      spreadCount: 9,
      spreadRows: 1, spreadRowDY: 3.2, // T027: two staggered rows (was one row of 7) so a wall cannot be slipped by drifting vertically
      spreadStepX: 4.0, spreadDropY: 0.7, // m fan
      bulletSpeed: 45, bulletRadius: 0.5, lead: 0.5,
      bulletDamage: 8, // T027: big orbs hit harder than dart shots (T.damage.bullet)
      sweepInterval: 5.5, // s between diagonal laser sweeps
      sweepStagger: 1.8, // s offset per squad index so sweeps never stack
      sweepFromX: 22, sweepFromY: -12, sweepSpanMul: 1.6, sweepRise: 20,
      weakCycle: 7.0, weakOpenAfter: 5.2, // s: back exposed for the last 1.8 s of each cycle
      weakMul: 2.5,
      retreatSpeed: 50, retreatClimb: 8,
    },
    /** Wreckfield: caltrop net that surrounds the player and closes on where they were */
    caltropRing: {
      startU: 230, endU: -20, // m
      duration: 5.2, // s from startU to endU
      radius0: 26, // m at startU; shrinks to 0 at u = 0
      spin: 0.9, // rad/s
      trackUntilU: 70, // m: centre follows the player until the ring is this close
      trackTau: 0.5,
    },
    bulwark: {
      arriveU: 420, arriveY: 80, holdU: 150, holdY: 30, // m (rail space)
      phase3U: 130, phase3Y: 26,
      arriveTau: 2.2, // s
      swayX: 9, swayFreq: 0.12, // m, Hz: slow capital-ship drift
      phaseHp: [1800, 1000], // hp thresholds: phase 2 below 1800, phase 3 below 1000 (600/800/1000)
      /** beam emitters (du, dx, dy) relative to the boss centre, rail space */
      emitters: [[-26, -30, -10], [-26, 30, -10], [-34, -12, -16], [-34, 12, -16], [-38, 0, -8]] as readonly (readonly [number, number, number])[],
      /** weak points (du, dx, dy): two belly reactors + chin core; outside the hull sphere */
      weakPoints: [[-24, -18, -14], [-24, 18, -14], [-36, 0, -6]] as readonly (readonly [number, number, number])[],
      weakRadius: 6, // m
      weakMul: 5, // cannon/missile/parry damage multiplier on a weak point [A]
      // phase 1: aimed beam volleys
      p1Beams: 4, p1BeamGap: 0.5, p1Telegraph: 1.0, p1Recover: 2.8,
      beamLead: 0.5, // s of player lateral velocity the aimed beams anticipate (alternate beams only)
      // phase 2: fewer beams + vent barrages + drone waves
      p2Beams: 2, p2Recover: 2.4,
      ventRows: 2, ventPerRow: 11, ventSpreadX: 5.0, ventRowDY: 3.4, ventSpeed: 40, ventRadius: 0.55, ventInterval: 4.2,
      waveInterval: 9, waveSize: 8,
      // phase 3: sweeping wall of beams with one gap
      p3Beams: 6, p3Spacing: 7.5, p3Gap: 15, p3Sweep: 26, p3Fire: 2.2, p3Telegraph: 1.2, p3Recover: 2.6,
      p3VentInterval: 5.5,
      outro: 3.0, // s after the kill before results
    },
  },
  /** Caravan: 120 s score attack over Cloudgate waves (DESIGN Modes) */
  caravan: {
    duration: 120, // s real time
    density: 1.4, // wave schedule compressed by this factor
    par: 60000, // rank par [A]
  },
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
