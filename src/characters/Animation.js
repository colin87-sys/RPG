/**
 * Animation.js — procedural animation for the chibi cast.
 *
 * There are no keyframe clips anywhere in this project and there is a reason
 * beyond the no-external-assets rule: a super-deformed character has almost no
 * articulation to key. No elbows, no knees, no fingers, a face that is four
 * pixels wide in the battle camera. What actually sells motion at that scale is
 * *timing and mass* — the hips leading the shoulders, the head arriving late,
 * the weapon overshooting and settling. All of those are functions of time, and
 * a function is cheaper to author, retarget and retune than a baked curve.
 *
 * ## The evaluation pipeline
 *
 *   clip(prev) ─┐
 *               ├─ cross-fade (cubic) ─ ground solve ─ additive layers ─
 *   clip(cur) ──┘                                       ↓
 *                                    critically-damped smoothing ─ bones
 *
 * Each stage exists for a specific failure it prevents:
 *
 * - **Cross-fade with a cubic ease**, never linear. ART_BIBLE §7.8 forbids any
 *   visible state change under 150 ms of easing; a linear blend has a velocity
 *   discontinuity at both ends and reads as a snap even when it is slow.
 * - **Ground solve.** Foot placement is derived, not authored: given the thigh
 *   and knee angles the ankle's height is exact trigonometry, so the pelvis is
 *   dropped by whatever the *lower* foot needs to stay on the floor. The
 *   vertical bob of a walk then emerges from the gait instead of being a
 *   separate sine that has to be hand-matched to it — which is why hand-tuned
 *   procedural walks usually skate, and this one does not.
 * - **Additive layers** (breathing, look-at, blink) run after the blend so they
 *   survive every state change. A character that stops breathing during an
 *   attack looks like a bug in the blend, not like an attack.
 * - **Critically damped smoothing** on every channel. Damping ratio is exactly
 *   1 and the solver is the closed-form exponential, not Euler integration, so
 *   it is unconditionally stable at any timestep and can never overshoot into
 *   a pose the artist did not author. Overshoot, where wanted, is authored in
 *   the clip's own timeline — that keeps it art-directable instead of being an
 *   emergent property of a stiffness constant.
 *
 * Channel layout is `[rx, ry, rz, px, py, pz]` per bone, as offsets from the
 * bind pose. Because `Rig.js` guarantees every bind rotation is identity, an
 * Euler offset is the pose — there is no bind orientation to pre-multiply, and
 * the same numeric pose reads identically on Bramm and on Emrys.
 *
 * Sign conventions (+Y up, +Z forward, +X to the character's left):
 *   - bones whose child is *above* them (spine, chest, neck, head):
 *     `+rx` leans forward, `+ry` turns left, `+rz` tilts to the right ear.
 *   - bones whose child is *below* them (arms, legs): `+rx` swings backward,
 *     so a forward swing is negative. `rz * side` raises the limb outward.
 *   - `side` is +1 for the character's left, -1 for the right.
 *
 * OWNED BY: characters.
 */
import * as THREE from 'three';
import { rng } from '../core/GameState.js';

const TAU = Math.PI * 2;

/** Channel stride per bone in a pose buffer. */
const CH = 6;

/** Clips the battle and field layers may ask for (ARCHITECTURE.md). */
export const CLIP_NAMES = Object.freeze([
  'idle', 'walk', 'run', 'cast', 'attack', 'hurt', 'victory', 'ko', 'limit',
]);

// ---------------------------------------------------------------- easing

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Hermite; zero velocity at both ends — the only curve allowed for blends. */
const smooth = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
/** Quintic; zero velocity *and* acceleration at the ends, for camera-visible holds. */
const smoother = (x) => { const t = clamp01(x); return t * t * t * (t * (t * 6 - 15) + 10); };
const easeOutCubic = (x) => { const t = clamp01(x); const u = 1 - t; return 1 - u * u * u; };
const easeInCubic = (x) => { const t = clamp01(x); return t * t * t; };
/** Anticipation: dips negative before rising. `k` is the undershoot depth. */
const backIn = (x, k = 1.7) => { const t = clamp01(x); return t * t * ((k + 1) * t - k); };
/** Overshoot then settle. */
const backOut = (x, k = 1.9) => { const t = clamp01(x) - 1; return t * t * ((k + 1) * t + k) + 1; };
/** Windowed pulse: 0 → 1 → 0 across [a, b] with smooth ends. */
function pulse(t, a, b) {
  if (t <= a || t >= b) return 0;
  const u = (t - a) / (b - a);
  return Math.sin(u * Math.PI);
}

/** Deterministic value noise, seeded once per character from `rng`. */
function hash1(i, seed) {
  let h = Math.imul(i | 0, 374761393) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}
function noise1(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  const a = hash1(i, seed);
  const b = hash1(i + 1, seed);
  return (a + (b - a) * s) * 2 - 1;
}

/**
 * Closed-form critically damped spring (Game Programming Gems 4, §1.10).
 * Unconditionally stable for any `dt`, never overshoots, and reaches the
 * target in finite visual time — the three properties a pose smoother needs.
 */
function springStep(state, i, target, omega, dt) {
  const x = state.x[i];
  const v = state.v[i];
  const dx = x - target;
  const temp = (v + omega * dx) * dt;
  const exp = Math.exp(-omega * dt);
  state.v[i] = (v - omega * temp) * exp;
  state.x[i] = target + (dx + temp) * exp;
}

// ------------------------------------------------------------- pose utils

/** Small accessor object handed to clip functions so they read like animation. */
class PoseWriter {
  constructor(index) {
    this.index = index;   // bone name -> slot
    this.buf = null;
  }
  bind(buf) { this.buf = buf; return this; }
  /** Additive Euler write, radians. */
  rot(name, rx, ry, rz) {
    const s = this.index[name];
    if (s === undefined) return;
    const b = s * CH;
    this.buf[b] += rx;
    this.buf[b + 1] += ry;
    this.buf[b + 2] += rz;
  }
  /** Additive translation write, world units. */
  pos(name, px, py, pz) {
    const s = this.index[name];
    if (s === undefined) return;
    const b = s * CH;
    this.buf[b + 3] += px;
    this.buf[b + 4] += py;
    this.buf[b + 5] += pz;
  }
  get(name, ch) {
    const s = this.index[name];
    return s === undefined ? 0 : this.buf[s * CH + ch];
  }
  /** Mirrored write: `fn(side, suffix)` is called for L then R. */
  pair(fn) { fn(1, 'L'); fn(-1, 'R'); }
}

// ------------------------------------------------------------------ clips

/**
 * Every clip is `(p: PoseWriter, c: Context) => void`, writing *offsets from
 * bind*. Context carries clip-local time `t`, normalised progress `u`, the
 * character's metric block, and the per-character motion bias.
 *
 * Clips never touch `hair*`/`cape*` — those belong to the cloth solver — and
 * never write absolute values, only additive offsets, so layering composes.
 */
const CLIPS = {};

/**
 * Idle: a breathing weight-shift, not a static pose with a sine on it.
 *
 * Three periods run against each other on purpose — 3.6 s breath, 11 s weight
 * shift, 7.3 s drift — so the loop never visibly repeats. A single-period idle
 * is the most recognisable tell of procedural animation there is.
 */
CLIPS.idle = {
  duration: 0,
  loop: true,
  plant: true,
  spring: 11,
  fn(p, c) {
    const t = c.t;
    const breath = Math.sin(t * TAU / 3.6);
    const shift = Math.sin(t * TAU / 11.0);
    const drift = noise1(t * 0.42, c.seed);
    const w = c.bias.weight;

    // Weight on alternating legs: the pelvis drops and rolls toward the loaded
    // side and the spine counter-curves, which is the whole read of "standing".
    p.rot('hips', 0.012 * breath, shift * 0.055, shift * 0.075 * w);
    p.pos('hips', shift * 0.008 * c.H, 0, 0);
    p.rot('spine', 0.020 + breath * 0.016, shift * -0.030, shift * -0.045);
    p.rot('chest', 0.008 + breath * 0.022, shift * -0.028, shift * -0.030);
    p.rot('neck', -0.030 - breath * 0.012, drift * 0.05, shift * 0.020);
    p.rot('head', -0.055 - breath * 0.010, drift * 0.10, shift * 0.028 + drift * 0.03);

    p.pair((side, s) => {
      const phase = side > 0 ? 0 : Math.PI * 0.85;
      const swing = Math.sin(t * TAU / 7.3 + phase);
      p.rot(`arm${s}`, -0.06 + swing * 0.035, 0, side * (0.10 + shift * side * 0.05));
      p.rot(`forearm${s}`, -0.24 - swing * 0.05, 0, side * 0.06);
      p.rot(`hand${s}`, 0, 0, side * 0.10);
      // The unloaded leg straightens and the loaded one takes the bend.
      const load = 0.5 + 0.5 * shift * side;
      p.rot(`thigh${s}`, 0.02 - load * 0.05, side * 0.02, side * (0.03 + load * 0.02));
      p.rot(`shin${s}`, load * 0.09, 0, 0);
      p.rot(`foot${s}`, -load * 0.04, 0, 0);
    });

    if (c.hasWeapon) p.rot('weapon', breath * 0.02, 0, drift * 0.03);
  },
};

/** Shared locomotion generator; `walk` and `run` differ only by amplitude. */
function locomotion(p, c, k) {
  const ph = c.t * TAU / k.cycle;
  const s = Math.sin(ph);
  const cs = Math.cos(ph);
  const w = c.bias.weight;

  // Pelvis: yaw *leads*, chest counter-rotates, and the pelvis rolls toward
  // the swing leg. Counter-rotation is the single cue that separates a walk
  // from a marionette; without it the character reads as sliding.
  p.rot('hips', k.lean * 0.35, -k.pelvisYaw * s, k.pelvisRoll * s * w);
  p.pos('hips', k.lateral * s * c.H, 0, 0);
  p.rot('spine', k.lean * 0.4, k.pelvisYaw * 0.55 * s, -k.pelvisRoll * 0.4 * s);
  p.rot('chest', k.lean * 0.35, k.shoulderYaw * s, -k.pelvisRoll * 0.5 * s);
  // The head stabilises the gaze: it counters most of the chest's yaw and
  // bobs a beat behind the body, which is the "arrives late" cue.
  p.rot('neck', -k.lean * 0.35 + k.headBob * Math.cos(ph * 2 - 0.7), -k.shoulderYaw * 0.55 * s, 0);
  p.rot('head', -k.lean * 0.30, -k.shoulderYaw * 0.35 * s, k.pelvisRoll * 0.25 * s);

  p.pair((side, sfx) => {
    const lp = side > 0 ? ph : ph + Math.PI;
    const ls = Math.sin(lp);
    const lc = Math.cos(lp);

    // Legs. `swingUp` is the flight portion of the cycle: the knee only bends
    // while the foot is off the ground, which is what keeps the stance leg
    // straight and the character from crouch-walking.
    const swingUp = Math.max(0, Math.sin(lp - 0.55));
    p.rot(`thigh${sfx}`, -k.hip * ls, side * 0.03, side * 0.04);
    p.rot(`shin${sfx}`, k.knee * swingUp * swingUp + k.kneeBias, 0, 0);
    // Ankle rolls heel-strike → toe-off across the stance half.
    p.rot(`foot${sfx}`, -k.ankle * Math.sin(lp + 1.9) + k.ankleBias, 0, 0);

    // Arms swing opposite the same-side leg, with the forearm trailing by a
    // quarter cycle so the elbow lags the shoulder — free follow-through.
    p.rot(`arm${sfx}`, k.arm * ls + k.armBias, 0, side * (k.armOut + k.armOutSwing * lc));
    p.rot(`forearm${sfx}`, -k.forearm * (0.55 + 0.45 * Math.sin(lp - 1.2)) - k.forearmBias, 0, side * 0.05);
    p.rot(`hand${sfx}`, 0, 0, side * 0.08);
  });

  if (c.hasWeapon) p.rot('weapon', -cs * k.weaponSwing, 0, s * k.weaponSwing * 0.6);
}

CLIPS.walk = {
  duration: 0,
  loop: true,
  plant: true,
  spring: 14,
  /** World units advanced per full cycle — locomotion controllers sync to this. */
  stride(metrics) { return metrics.height * 0.62; },
  fn(p, c) {
    locomotion(p, c, {
      cycle: 1.02 / c.speedScale,
      lean: 0.045, pelvisYaw: 0.10, pelvisRoll: 0.075, shoulderYaw: 0.13,
      lateral: 0.012, headBob: 0.020,
      hip: 0.52, knee: 0.85, kneeBias: 0.05, ankle: 0.22, ankleBias: -0.03,
      arm: 0.34, armBias: -0.02, armOut: 0.11, armOutSwing: 0.03,
      forearm: 0.30, forearmBias: 0.05, weaponSwing: 0.06,
    });
  },
};

CLIPS.run = {
  duration: 0,
  loop: true,
  plant: true,
  spring: 16,
  stride(metrics) { return metrics.height * 0.95; },
  fn(p, c) {
    locomotion(p, c, {
      cycle: 0.60 / c.speedScale,
      lean: 0.30, pelvisYaw: 0.16, pelvisRoll: 0.10, shoulderYaw: 0.24,
      lateral: 0.016, headBob: 0.032,
      hip: 0.88, knee: 1.55, kneeBias: 0.16, ankle: 0.34, ankleBias: -0.06,
      arm: 0.62, armBias: -0.30, armOut: 0.16, armOutSwing: 0.05,
      forearm: 0.95, forearmBias: 0.35, weaponSwing: 0.10,
    });
  },
};

/**
 * Cast: gather, hold, release.
 *
 * The hold is where the read is. Anima is drawn *through the caster's own
 * remembered life* (WORLD_BIBLE §1), so the pose is a bracing one — weight
 * back, chin up, a tremble in the arms — rather than a triumphant one, and the
 * tremble amplitude rises through the hold so the release lands as relief.
 */
CLIPS.cast = {
  duration: 1.55,
  loop: false,
  plant: true,
  spring: 9,
  contact: 0.62,
  fn(p, c) {
    const u = c.u;
    const gather = smooth(u / 0.34);
    const hold = clamp01((u - 0.30) / 0.28) * (1 - smooth((u - 0.58) / 0.14));
    const release = pulse(u, 0.56, 0.80);
    const settle = smooth((u - 0.74) / 0.26);
    const open = gather * (1 - settle);
    const tremble = noise1(c.t * 22, c.seed) * 0.02 * hold;

    p.rot('hips', -0.10 * open + 0.06 * release, 0, 0);
    p.pos('hips', 0, -0.012 * c.H * open, -0.02 * c.H * open + 0.03 * c.H * release);
    p.rot('spine', -0.16 * open + 0.26 * release, 0, 0);
    p.rot('chest', -0.12 * open + 0.22 * release, 0, 0);
    p.rot('neck', 0.16 * open - 0.20 * release, 0, 0);
    p.rot('head', 0.14 * open - 0.16 * release + tremble, 0, 0);

    p.pair((side, s) => {
      // Both hands come up and forward; the off hand stays lower and wider so
      // the pose has a diagonal rather than reading as a symmetrical shrug.
      const lead = side === c.leadSide ? 1 : 0.62;
      p.rot(`arm${s}`, (-1.05 * open - 0.55 * release) * lead + tremble,
        side * 0.10 * open, side * (0.55 * open + 0.20 * release) * lead);
      p.rot(`forearm${s}`, (-1.25 * open + 0.85 * release) * lead - 0.18, 0, side * 0.18 * open);
      p.rot(`hand${s}`, -0.30 * open + 0.45 * release, 0, side * (0.25 * open));
      p.rot(`thigh${s}`, 0.10 * open, 0, side * 0.06);
      p.rot(`shin${s}`, 0.22 * open, 0, 0);
      p.rot(`foot${s}`, -0.10 * open, 0, 0);
    });

    if (c.hasWeapon) p.rot('weapon', -0.5 * open + 0.7 * release, 0, 0.2 * open);
  },
};

/**
 * Attack: anticipation, strike, recovery.
 *
 * Timing is 33% anticipation / 12% strike / 55% recovery. The strike is
 * deliberately the shortest phase and uses `easeInCubic` so the fastest frame
 * is the contact frame — that is where hit-stop and the VFX land, and a strike
 * that decelerates into contact reads as a shove instead of a cut.
 */
CLIPS.attack = {
  duration: 0.88,
  loop: false,
  plant: true,
  spring: 8,
  contact: 0.46,
  fn(p, c) {
    const u = c.u;
    const wind = smooth(u / 0.34) * (1 - clamp01((u - 0.34) / 0.10));
    const strike = easeInCubic(clamp01((u - 0.34) / 0.14)) * (1 - smooth((u - 0.52) / 0.18));
    const follow = smooth((u - 0.48) / 0.22) * (1 - smooth((u - 0.72) / 0.28));
    const lead = c.leadSide;

    p.rot('hips', -0.10 * wind + 0.16 * strike, lead * (0.34 * wind - 0.42 * strike), 0);
    p.pos('hips', 0, -0.02 * c.H * wind, -0.03 * c.H * wind + 0.07 * c.H * strike);
    p.rot('spine', -0.14 * wind + 0.30 * strike, lead * (0.26 * wind - 0.34 * strike), 0);
    p.rot('chest', -0.10 * wind + 0.26 * strike, lead * (0.30 * wind - 0.44 * strike), 0);
    p.rot('neck', 0.12 * wind - 0.14 * strike, lead * -0.12 * wind, 0);
    p.rot('head', 0.10 * wind - 0.20 * strike - 0.10 * follow, lead * -0.20 * wind + lead * 0.10 * strike, 0);

    p.pair((side, s) => {
      const isLead = side === lead;
      if (isLead) {
        p.rot(`arm${s}`, -0.35 * wind - 1.15 * strike - 0.30 * follow, side * 0.30 * wind, side * (0.85 * wind + 0.25 * strike));
        p.rot(`forearm${s}`, -1.30 * wind + 0.95 * strike + 0.20 * follow, 0, side * 0.20 * wind);
        p.rot(`hand${s}`, -0.20 * wind + 0.35 * strike, 0, side * 0.30 * wind);
      } else {
        p.rot(`arm${s}`, 0.45 * wind - 0.35 * strike, 0, side * (0.30 * wind + 0.10 * strike));
        p.rot(`forearm${s}`, -0.55 - 0.30 * wind, 0, side * 0.10);
        p.rot(`hand${s}`, 0, 0, side * 0.10);
      }
      // Lunge: the lead leg drives, the trail leg extends behind.
      const drive = isLead ? 1 : -0.7;
      p.rot(`thigh${s}`, (0.14 * wind - 0.42 * strike) * drive, 0, side * 0.05);
      p.rot(`shin${s}`, 0.30 * wind + (isLead ? 0.10 : 0.45) * strike, 0, 0);
      p.rot(`foot${s}`, -0.12 * wind + 0.18 * strike, 0, 0);
    });

    if (c.hasWeapon) {
      p.rot('weapon', -0.9 * wind + 1.5 * strike + 0.3 * follow, 0, -0.4 * wind + 0.3 * strike);
    }
  },
};

/**
 * Hurt: a hard recoil that arrives in two frames and unwinds over half a
 * second. `backOut` on the unwind gives one small counter-sway — the body
 * rebounding past neutral — which is what makes a hit read as force rather
 * than as an animation state change.
 */
CLIPS.hurt = {
  duration: 0.62,
  loop: false,
  plant: true,
  spring: 13,
  contact: 0.0,
  fn(p, c) {
    const u = c.u;
    const hit = 1 - easeOutCubic(clamp01(u / 0.14));
    const recoil = (1 - backOut(clamp01((u - 0.06) / 0.94))) * 0.9;
    const a = Math.max(hit, recoil);
    const shake = noise1(c.t * 40, c.seed) * 0.05 * hit;

    p.rot('hips', -0.28 * a, 0.10 * a, 0.06 * a);
    p.pos('hips', 0, -0.03 * c.H * a, -0.05 * c.H * a);
    p.rot('spine', -0.32 * a, -0.08 * a, 0);
    p.rot('chest', -0.30 * a, -0.10 * a, 0.05 * a);
    p.rot('neck', 0.30 * a + shake, 0.10 * a, 0);
    p.rot('head', 0.34 * a + shake, 0.14 * a, -0.08 * a);

    p.pair((side, s) => {
      p.rot(`arm${s}`, 0.30 * a, 0, side * (0.42 * a));
      p.rot(`forearm${s}`, -0.75 * a - 0.15, 0, side * 0.15 * a);
      p.rot(`hand${s}`, 0.20 * a, 0, side * 0.10);
      p.rot(`thigh${s}`, 0.28 * a, 0, side * 0.10 * a);
      p.rot(`shin${s}`, 0.40 * a, 0, 0);
      p.rot(`foot${s}`, -0.18 * a, 0, 0);
    });
    if (c.hasWeapon) p.rot('weapon', 0.5 * a, 0, 0.3 * a);
  },
};

/**
 * Victory: a held stance that breathes, not a loop of gestures. It reads best
 * under the battle camera's slow push-in, so the motion is almost all in the
 * torso and the weapon, with the feet planted.
 */
CLIPS.victory = {
  duration: 0,
  loop: true,
  plant: true,
  spring: 8,
  fn(p, c) {
    const t = c.t;
    const enter = smoother(clamp01(t / 0.7));
    const b = Math.sin(t * TAU / 2.9);
    const sway = Math.sin(t * TAU / 4.6);
    const lead = c.leadSide;

    p.rot('hips', 0.02, lead * 0.16 * enter, sway * 0.05);
    p.pos('hips', lead * 0.010 * c.H * enter, 0.006 * c.H * enter * (1 + b * 0.2), 0);
    p.rot('spine', (-0.10 + b * 0.02) * enter, lead * -0.10 * enter, sway * -0.04);
    p.rot('chest', (-0.08 + b * 0.03) * enter, lead * -0.12 * enter, sway * -0.03);
    p.rot('neck', 0.06 * enter, lead * 0.06 * enter, 0);
    p.rot('head', (0.10 + b * 0.02) * enter, lead * 0.10 * enter, sway * 0.03);

    p.pair((side, s) => {
      const isLead = side === lead;
      if (isLead) {
        // Weapon arm up and out — the party's silhouette read for "we won".
        p.rot(`arm${s}`, (-1.55 - b * 0.05) * enter, side * 0.15 * enter, side * 0.75 * enter);
        p.rot(`forearm${s}`, -0.35 * enter, 0, side * 0.25 * enter);
        p.rot(`hand${s}`, -0.15 * enter, 0, side * 0.20 * enter);
      } else {
        p.rot(`arm${s}`, -0.10 * enter, 0, side * (0.22 + sway * 0.03) * enter);
        p.rot(`forearm${s}`, -0.45 * enter, 0, side * 0.12);
        p.rot(`hand${s}`, 0, 0, side * 0.12);
      }
      const load = isLead ? 0.3 : 0.9;
      p.rot(`thigh${s}`, -0.05 * load * enter, side * 0.05 * enter, side * 0.06 * enter);
      p.rot(`shin${s}`, 0.10 * load * enter, 0, 0);
      p.rot(`foot${s}`, -0.05 * load * enter, 0, 0);
    });
    if (c.hasWeapon) p.rot('weapon', (-0.6 + b * 0.04) * enter, 0, 0.2 * enter);
  },
};

/**
 * KO: buckle, then a slow settle held at the floor. Not a ragdoll — a
 * *staged* collapse, because the battle camera needs the body to end in a
 * readable, non-overlapping silhouette next to its still-living party.
 */
CLIPS.ko = {
  duration: 1.15,
  loop: false,
  hold: true,
  plant: false,
  spring: 6,
  fn(p, c) {
    const u = c.u;
    const buckle = smooth(u / 0.30);
    const fall = smooth(clamp01((u - 0.22) / 0.48));
    const land = smooth(clamp01((u - 0.62) / 0.38));
    const H = c.H;

    p.rot('hips', 0.55 * buckle + 0.55 * fall, 0.18 * fall, 0.22 * fall);
    p.pos('hips', 0.04 * H * fall, -0.30 * H * buckle - 0.06 * H * fall, -0.10 * H * fall);
    p.rot('spine', 0.30 * buckle + 0.10 * fall - 0.10 * land, -0.10 * fall, -0.12 * fall);
    p.rot('chest', 0.26 * buckle + 0.12 * fall - 0.08 * land, -0.12 * fall, -0.10 * fall);
    p.rot('neck', -0.25 * buckle - 0.20 * fall, 0.10 * fall, 0);
    p.rot('head', -0.35 * buckle - 0.25 * fall + 0.10 * land, 0.16 * fall, 0.14 * fall);

    p.pair((side, s) => {
      p.rot(`arm${s}`, 0.55 * buckle + 0.35 * fall, 0, side * (0.30 * buckle + 0.35 * fall));
      p.rot(`forearm${s}`, -0.30 * buckle - 0.20 * fall, 0, side * 0.10);
      p.rot(`hand${s}`, 0.25 * fall, 0, 0);
      const fold = side > 0 ? 1 : 0.65;
      p.rot(`thigh${s}`, (-0.75 * buckle - 0.55 * fall) * fold, 0, side * (0.12 + 0.20 * fall));
      p.rot(`shin${s}`, (1.35 * buckle + 0.55 * fall) * fold, 0, 0);
      p.rot(`foot${s}`, -0.30 * fall, 0, side * 0.10);
    });
    if (c.hasWeapon) p.rot('weapon', 0.9 * fall, 0, 0.5 * fall);
  },
};

/**
 * Limit: the game's biggest pose. Anticipation crouch, explosive rise, then a
 * held apex with a slow tremble under it. The apex is held for a third of the
 * clip because the VFX layer plays over it; a pose that keeps moving under a
 * screen-filling effect just muddies the frame.
 */
CLIPS.limit = {
  duration: 1.95,
  loop: false,
  hold: true,
  plant: true,
  spring: 7,
  contact: 0.42,
  fn(p, c) {
    const u = c.u;
    const crouch = smooth(u / 0.22) * (1 - smooth((u - 0.22) / 0.14));
    const rise = smooth(clamp01((u - 0.28) / 0.16));
    const apex = rise * (1 - smooth(clamp01((u - 0.82) / 0.18)));
    const H = c.H;
    const tremble = noise1(c.t * 17, c.seed) * 0.022 * apex;
    const lead = c.leadSide;

    p.rot('hips', 0.42 * crouch - 0.26 * apex, lead * -0.10 * apex, 0);
    p.pos('hips', 0, -0.10 * H * crouch + 0.035 * H * apex, -0.04 * H * crouch + 0.02 * H * apex);
    p.rot('spine', 0.34 * crouch - 0.34 * apex, 0, 0);
    p.rot('chest', 0.28 * crouch - 0.32 * apex + tremble, lead * 0.10 * apex, 0);
    p.rot('neck', -0.20 * crouch + 0.26 * apex, 0, 0);
    p.rot('head', -0.28 * crouch + 0.30 * apex + tremble, lead * -0.08 * apex, 0);

    p.pair((side, s) => {
      const isLead = side === lead;
      p.rot(`arm${s}`, 0.70 * crouch + (isLead ? -2.05 : -0.70) * apex + tremble,
        side * 0.15 * crouch, side * (0.25 * crouch + (isLead ? 0.35 : 0.95) * apex));
      p.rot(`forearm${s}`, -1.10 * crouch + (isLead ? -0.15 : -0.55) * apex, 0, side * 0.25 * apex);
      p.rot(`hand${s}`, -0.25 * crouch + 0.20 * apex, 0, side * 0.20 * apex);
      p.rot(`thigh${s}`, 0.55 * crouch - 0.12 * apex, 0, side * (0.10 + 0.14 * apex));
      p.rot(`shin${s}`, 0.95 * crouch + 0.10 * apex, 0, 0);
      p.rot(`foot${s}`, -0.35 * crouch + 0.05 * apex, 0, 0);
    });
    if (c.hasWeapon) p.rot('weapon', 0.8 * crouch - 1.1 * apex, 0, -0.3 * apex);
  },
};

// ---------------------------------------------------------------- Animator

/**
 * Per-character procedural animator.
 *
 * Contract API (ARCHITECTURE.md):
 *   `play(clip, { loop, fade, speed })`, `update(dt)`, `lookAt(worldPos)`.
 *
 * Extensions, all optional and additive to the contract:
 *   `setLocomotion(speed)` — picks idle/walk/run and matches cycle rate to the
 *     controller's ground speed via each clip's declared stride length, which
 *     is what actually prevents foot skating.
 *   `setWeaponVisible(b)`, `onEvent` — the battle layer's contact hook.
 */
export class Animator {
  /**
   * @param {object} opts
   * @param {Record<string, THREE.Bone>} opts.bones
   * @param {string[]} opts.order bone order from `Rig.buildRig`
   * @param {object} opts.rest bind pose from `Rig.buildRig`
   * @param {object} opts.metrics from `Rig.computeMetrics`
   * @param {object} opts.def roster entry
   * @param {Set<string>} [opts.skip] bones driven by another system (cloth)
   * @param {THREE.Object3D} [opts.irises] iris/pupil group parented to the head bone
   * @param {THREE.Object3D} [opts.lids] blink lids parented to the head bone
   */
  constructor({ bones, order, rest, metrics, def, skip = null, irises = null, lids = null }) {
    this.bones = bones;
    this.order = order;
    this.rest = rest;
    this.metrics = metrics;
    this.def = def;
    this.skip = skip ?? new Set();
    this.irises = irises;
    this.lids = lids;

    this.index = {};
    this.slots = [];
    for (const name of order) {
      if (this.skip.has(name)) continue;
      this.index[name] = this.slots.length;
      this.slots.push(name);
    }
    const n = this.slots.length;

    this._poseA = new Float32Array(n * CH);
    this._poseB = new Float32Array(n * CH);
    this._blend = new Float32Array(n * CH);
    this._spring = { x: new Float32Array(n * CH), v: new Float32Array(n * CH) };
    this._writer = new PoseWriter(this.index);

    this.seed = (rng.next() * 0x7fffffff) | 0;

    // Per-character motion bias. A 51-year-old forgemaster and a 14-year-old
    // mage cannot share a walk cycle amplitude and read as the same world.
    const role = def?.role ?? 'vanguard';
    const biasTable = {
      tank: { weight: 1.35, snap: 0.75, rate: 0.86 },
      vanguard: { weight: 1.0, snap: 1.0, rate: 1.0 },
      striker: { weight: 0.82, snap: 1.28, rate: 1.12 },
      dragoon: { weight: 0.95, snap: 1.12, rate: 1.02 },
      healer: { weight: 0.80, snap: 0.86, rate: 0.94 },
      mage: { weight: 0.72, snap: 0.95, rate: 1.05 },
    };
    this.bias = biasTable[role] ?? biasTable.vanguard;

    // Which hand leads an attack: the weapon hand, mirrored to the ±1 side
    // convention. Everything asymmetric in the clips keys off this.
    const mount = def?.weapon?.mount ?? 'handR';
    this.leadSide = mount.endsWith('L') ? 1 : -1;
    this.hasWeapon = Boolean(bones.weapon);

    this._ctx = {
      t: 0, u: 0, H: metrics.height, seed: this.seed, bias: this.bias,
      leadSide: this.leadSide, hasWeapon: this.hasWeapon, speedScale: 1,
    };

    /** @type {{name:string, clip:object, time:number, speed:number, loop:boolean}} */
    this._cur = this._makeState('idle', { loop: true, speed: 1 });
    this._prev = null;
    this._fadeT = 1;
    this._fadeDur = 1;
    this._contactFired = false;
    this._finished = false;
    this._autoNext = null;
    /** Cycle-rate multiplier for looping clips, set by `setLocomotion`. */
    this._ctxSpeedScale = 1;
    /** Set by `CharacterFactory` so `setWeaponVisible` has something to hide. */
    this.weaponGroup = null;

    // Look-at state: target in world space plus a smoothed aim so the head
    // eases onto a target instead of tracking it rigidly.
    this._lookTarget = null;
    this._lookWeight = 0;
    this._aim = { yaw: 0, pitch: 0 };
    this._aimSpring = { x: new Float32Array(3), v: new Float32Array(3) };

    this._blinkTimer = 1.2 + rng.next() * 2.4;
    this._blinkT = -1;
    this._blinkDouble = false;
    this._lidRest = lids ? lids.position.clone() : null;
    this._irisRest = irises ? irises.position.clone() : null;

    /** Fired at a clip's declared `contact` time: `{ clip, name:'contact' }`. */
    this.onEvent = null;
    /** Fired when a non-looping clip finishes: `{ clip }`. */
    this.onDone = null;

    this.time = 0;
    this._disposed = false;
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
  }

  _makeState(name, { loop, speed }) {
    const clip = CLIPS[name] ?? CLIPS.idle;
    return {
      name: CLIPS[name] ? name : 'idle',
      clip,
      time: 0,
      speed: speed ?? 1,
      loop: loop ?? clip.loop,
    };
  }

  /** Current clip name. */
  get current() { return this._cur.name; }

  /**
   * Start a clip.
   * @param {string} name one of {@link CLIP_NAMES}
   * @param {object} [opts]
   * @param {boolean} [opts.loop] override the clip's own looping
   * @param {number} [opts.fade] cross-fade seconds; 0.18–0.30 is the useful band
   * @param {number} [opts.speed] playback rate multiplier
   * @param {boolean} [opts.restart] replay from 0 even if already current
   */
  play(name, opts = {}) {
    if (this._disposed) return this;
    const clip = CLIPS[name];
    if (!clip) {
      console.warn(`[Animator] unknown clip "${name}"`);
      return this;
    }
    const speed = (opts.speed ?? 1) * this.bias.rate;
    if (this._cur.name === name && !opts.restart) {
      this._cur.speed = speed;
      if (opts.loop !== undefined) this._cur.loop = opts.loop;
      return this;
    }
    // Cross-fade length scales with how far the two poses are apart in intent:
    // a hurt interrupting an idle must be fast or the hit loses its impact,
    // while idle↔walk wants the full quarter second.
    const fade = Math.max(0, opts.fade ?? (name === 'hurt' ? 0.07 : name === 'ko' ? 0.12 : 0.22));
    this._prev = this._cur;
    this._cur = this._makeState(name, { loop: opts.loop, speed });
    this._fadeDur = Math.max(1e-3, fade);
    this._fadeT = fade <= 0 ? 1 : 0;
    this._contactFired = false;
    return this;
  }

  /**
   * Choose and drive a locomotion clip from a ground speed.
   * Cycle rate is derived from the clip's stride length so the feet advance at
   * exactly the rate the controller translates the character — the only
   * reliable cure for skating.
   * @param {number} speed world units per second
   */
  setLocomotion(speed) {
    const H = this.metrics.height;
    const runThreshold = H * 1.55;
    if (speed < H * 0.10) {
      this.play('idle');
      return this;
    }
    const name = speed >= runThreshold ? 'run' : 'walk';
    const clip = CLIPS[name];
    const stride = clip.stride(this.metrics);
    // `speedScale` divides the clip's nominal cycle, so cycles/second = speed/stride.
    const nominalCycle = name === 'run' ? 0.60 : 1.02;
    this.play(name);
    this._cur.speed = 1;
    this._ctxSpeedScale = THREE.MathUtils.clamp((speed / stride) * nominalCycle, 0.45, 2.4);
    return this;
  }

  /**
   * Additive head/eye aim toward a world point, inside a natural limit cone.
   * Pass `null` to release; the head eases back to the clip's own pose.
   * @param {THREE.Vector3|null} worldPos
   * @param {number} [weight] 0..1 strength of the aim
   */
  lookAt(worldPos, weight = 1) {
    if (!worldPos) {
      this._lookTarget = null;
      this._lookWeight = THREE.MathUtils.clamp(weight, 0, 1);
      return this;
    }
    if (!this._lookTarget) this._lookTarget = new THREE.Vector3();
    this._lookTarget.copy(worldPos);
    this._lookWeight = THREE.MathUtils.clamp(weight, 0, 1);
    return this;
  }

  /** Hide or show the weapon mesh group, if the factory registered one. */
  setWeaponVisible(visible) {
    if (this.weaponGroup) this.weaponGroup.visible = visible;
    return this;
  }

  // ----------------------------------------------------------------- update

  update(dt) {
    if (this._disposed || !(dt > 0)) return;
    const d = Math.min(dt, 0.1); // A long stall must not fast-forward a strike.
    this.time += d;

    this._advance(this._cur, d);
    if (this._prev) this._advance(this._prev, d);
    // A finished clip queues its successor rather than calling `play` from
    // inside `_advance`: swapping `_cur` mid-iteration would advance the
    // outgoing clip twice on the frame it retires.
    if (this._autoNext) {
      const next = this._autoNext;
      this._autoNext = null;
      this.play(next, { fade: 0.26 });
    }

    // Cross-fade weight, cubic in and out.
    if (this._fadeT < 1) {
      this._fadeT = Math.min(1, this._fadeT + d / this._fadeDur);
      if (this._fadeT >= 1) this._prev = null;
    }
    const w = smooth(this._fadeT);

    const n = this.slots.length * CH;
    const a = this._poseA;
    const b = this._poseB;
    a.fill(0);
    b.fill(0);
    if (this._prev) this._sample(this._prev, a);
    this._sample(this._cur, b);

    const out = this._blend;
    if (this._prev) {
      for (let i = 0; i < n; i++) out[i] = a[i] + (b[i] - a[i]) * w;
    } else {
      out.set(b);
    }

    if ((this._cur.clip.plant ?? false) || (this._prev && (this._prev.clip.plant ?? false))) {
      this._groundSolve(out);
    }
    this._breathe(out, d);
    this._applyLook(out, d);

    // Spring smoothing. Frequency comes from the dominant clip so a pose clip
    // settles with weight while a walk cycle stays crisp.
    const freq = this._prev
      ? (this._prev.clip.spring ?? 11) + ((this._cur.clip.spring ?? 11) - (this._prev.clip.spring ?? 11)) * w
      : (this._cur.clip.spring ?? 11);
    // A critically damped spring settles in roughly 4/ω seconds, so ω = 6·freq
    // puts a `spring: 11` clip at ~60 ms of follow-through and a `spring: 7`
    // pose clip at ~95 ms — visible weight, still inside the frame budget the
    // battle layer expects between "issue command" and "sword moves".
    const omega = freq * 6 * this.bias.snap;
    for (let i = 0; i < n; i++) springStep(this._spring, i, out[i], omega, d);

    this._writeBones();
    this._blink(d);
  }

  _advance(state, dt) {
    const clip = state.clip;
    const speed = state.speed * (clip.loop ? (this._ctxSpeedScale ?? 1) : 1);
    const before = state.time;
    state.time += dt * speed;

    if (clip.duration > 0) {
      const u0 = before / clip.duration;
      const u1 = state.time / clip.duration;
      if (clip.contact !== undefined && state === this._cur && !this._contactFired
          && u0 < clip.contact && u1 >= clip.contact) {
        this._contactFired = true;
        this.onEvent?.({ clip: state.name, name: 'contact' });
      }
      if (u1 >= 1) {
        if (state.loop) {
          state.time -= clip.duration;
        } else if (state === this._cur) {
          state.time = clip.duration;
          if (!this._finished) {
            this._finished = true;
            this.onDone?.({ clip: state.name });
            if (!clip.hold) this._autoNext = 'idle';
          }
        } else {
          state.time = clip.duration;
        }
      } else if (state === this._cur) {
        this._finished = false;
      }
    }
  }

  _sample(state, buf) {
    const ctx = this._ctx;
    ctx.t = state.time;
    ctx.u = state.clip.duration > 0 ? clamp01(state.time / state.clip.duration) : 0;
    ctx.speedScale = this._ctxSpeedScale ?? 1;
    state.clip.fn(this._writer.bind(buf), ctx);
  }

  /**
   * Derive the pelvis height from the pose so the lower foot stays on the
   * floor. Pure trigonometry on the two-link leg: the ankle sits at
   * `hipY - L1·cos(θ_thigh) - L2·cos(θ_thigh + θ_knee)`, so the drop the body
   * needs is the deficit of whichever ankle ends up lowest.
   */
  _groundSolve(buf) {
    const m = this.metrics;
    const L1 = m.segments.thigh;
    const L2 = m.segments.shin;
    const hipY = m.joints.hips.y;
    const restAnkle = m.joints.footL.y;
    let lowest = Infinity;
    for (const s of ['L', 'R']) {
      const ti = this.index[`thigh${s}`];
      const si = this.index[`shin${s}`];
      if (ti === undefined || si === undefined) continue;
      const a1 = buf[ti * CH];
      const a2 = buf[si * CH];
      const y = hipY - L1 * Math.cos(a1) - L2 * Math.cos(a1 + a2);
      if (y < lowest) lowest = y;
    }
    if (!Number.isFinite(lowest)) return;
    const hi = this.index.hips;
    if (hi === undefined) return;
    // Only ever *lower* the pelvis. Lifting it would let a bent-knee pose
    // hover, and a floating character is a far worse artefact than a slightly
    // sunk foot.
    buf[hi * CH + 4] += Math.min(0, restAnkle - lowest);
  }

  /**
   * Breathing runs as an additive layer at a weight that survives every clip,
   * because ART_BIBLE §7 requires idle poses to breathe and a character who
   * holds their breath through a two-second limit pose reads as frozen.
   */
  _breathe(buf, dt) {
    const amp = this._cur.name === 'ko' ? 0.30 : 1;
    const rate = this._cur.name === 'run' ? 2.4 : this._cur.name === 'hurt' ? 2.0 : 1;
    const b = Math.sin(this.time * TAU * 0.28 * rate);
    const shallow = Math.sin(this.time * TAU * 0.28 * rate + 1.1);
    const ci = this.index.chest;
    const si = this.index.spine;
    if (ci !== undefined) {
      buf[ci * CH] += b * 0.014 * amp;
      buf[ci * CH + 4] += shallow * 0.0022 * this.metrics.height * amp;
    }
    if (si !== undefined) buf[si * CH] += b * 0.008 * amp;
  }

  /**
   * Additive head aim with a limit cone, split across neck, head and chest so
   * the turn comes from the body rather than snapping the skull around. Eyes
   * lead the head by design — they reach full deflection at a third of the
   * angle, which is how real gaze shifts read and why the iris offset here is
   * worth its two draw calls.
   */
  _applyLook(buf, dt) {
    const headBone = this.bones.head;
    let yaw = 0;
    let pitch = 0;
    let weight = 0;

    if (this._lookTarget && headBone) {
      headBone.updateMatrixWorld(false);
      this._v.setFromMatrixPosition(headBone.matrixWorld);
      this._v.subVectors(this._lookTarget, this._v);
      const parent = headBone.parent;
      if (parent) {
        this._q.setFromRotationMatrix(parent.matrixWorld).invert();
        this._v.applyQuaternion(this._q);
      }
      const len = this._v.length();
      if (len > 1e-4) {
        this._v.divideScalar(len);
        yaw = Math.atan2(this._v.x, this._v.z);
        pitch = -Math.asin(THREE.MathUtils.clamp(this._v.y, -1, 1));
        // Natural limit cone. Beyond it the aim falls off rather than clamping
        // hard, so a target passing behind the character does not stick the
        // head at its extreme — it releases.
        const YAW_LIMIT = 1.15;   // ~66°
        const PITCH_LIMIT = 0.55; // ~32°
        const over = Math.max(Math.abs(yaw) / YAW_LIMIT, Math.abs(pitch) / PITCH_LIMIT);
        weight = this._lookWeight * (over <= 1 ? 1 : Math.max(0, 1 - (over - 1) * 1.6));
        yaw = THREE.MathUtils.clamp(yaw, -YAW_LIMIT, YAW_LIMIT);
        pitch = THREE.MathUtils.clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
      }
    }

    const omega = TAU * 2.2;
    springStep(this._aimSpring, 0, yaw * weight, omega, dt);
    springStep(this._aimSpring, 1, pitch * weight, omega, dt);
    springStep(this._aimSpring, 2, weight, omega, dt);
    const y = this._aimSpring.x[0];
    const p = this._aimSpring.x[1];
    this._aim.yaw = y;
    this._aim.pitch = p;

    const hi = this.index.head;
    const ni = this.index.neck;
    const ci = this.index.chest;
    if (hi !== undefined) { buf[hi * CH] += p * 0.60; buf[hi * CH + 1] += y * 0.55; }
    if (ni !== undefined) { buf[ni * CH] += p * 0.28; buf[ni * CH + 1] += y * 0.25; }
    if (ci !== undefined) { buf[ci * CH] += p * 0.12; buf[ci * CH + 1] += y * 0.20; }

    if (this.irises && this._irisRest) {
      const r = this.metrics.eye.width;
      this.irises.position.set(
        this._irisRest.x + THREE.MathUtils.clamp(y * 1.9, -0.9, 0.9) * r * 0.16,
        this._irisRest.y + THREE.MathUtils.clamp(-p * 1.9, -0.9, 0.9) * r * 0.14,
        this._irisRest.z,
      );
    }
  }

  /**
   * Blinks. Deterministic interval, occasional doubles, and a 110 ms close —
   * fast enough that it reads as life rather than as a sleepy character. The
   * lid is a sliding cap rather than a deforming lid because at 80 px the
   * silhouette of the closure is all that survives anyway.
   */
  _blink(dt) {
    if (!this.lids || !this._lidRest) return;
    if (this._blinkT >= 0) {
      this._blinkT += dt;
      const D = 0.11;
      if (this._blinkT >= D) {
        if (this._blinkDouble) {
          this._blinkDouble = false;
          this._blinkT = 0;
        } else {
          this._blinkT = -1;
          this._blinkTimer = 2.4 + hash1((this.time * 1000) | 0, this.seed) * 3.4;
        }
      }
      const u = clamp01(this._blinkT / 0.11);
      const close = Math.sin(u * Math.PI);
      this.lids.position.y = this._lidRest.y - close * this.metrics.eye.height * 1.15;
      this.lids.visible = close > 0.02;
      return;
    }
    this.lids.visible = false;
    this._blinkTimer -= dt;
    if (this._blinkTimer <= 0) {
      this._blinkT = 0;
      this._blinkDouble = hash1((this.time * 977) | 0, this.seed) < 0.22;
    }
  }

  _writeBones() {
    const x = this._spring.x;
    for (let i = 0; i < this.slots.length; i++) {
      const bone = this.bones[this.slots[i]];
      if (!bone) continue;
      const b = i * CH;
      const rest = this.rest[this.slots[i]];
      this._e.set(x[b], x[b + 1], x[b + 2], 'YXZ');
      bone.quaternion.copy(rest.quaternion).multiply(this._q.setFromEuler(this._e));
      bone.position.set(
        rest.position.x + x[b + 3],
        rest.position.y + x[b + 4],
        rest.position.z + x[b + 5],
      );
    }
  }

  dispose() {
    this._disposed = true;
    this._lookTarget = null;
    this.onEvent = null;
    this.onDone = null;
  }
}

export default Animator;
