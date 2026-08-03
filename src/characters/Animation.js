/**
 * Animation.js — procedural animation for the chibi cast.
 *
 * There are no keyframe clips anywhere in this project, and the reason is not
 * the no-external-assets rule: it is that what sells motion on a stylised
 * character is *timing and mass* — the hips leading the shoulders, the head
 * arriving late, the weapon overshooting and settling — and all of those are
 * functions of time. A function is cheaper to author, retarget and retune than
 * a baked curve, and it retargets across a roster whose limb lengths differ by
 * a quarter without anyone re-keying anything.
 *
 * This file used to justify itself instead by claiming the cast had "no elbows,
 * no knees, no fingers" to key. That is no longer true and was never the real
 * argument. The rig rebuilt against `docs/reference/bravely01.jpg` has a set
 * elbow and knee that fold, a deltoid, and five digits per hand; the clips here
 * pose all of them, and `_softenJoints` exists precisely because a joint that
 * can be seen must never be caught straight.
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
 * The idle stance table — one entry per way of standing in `bravely01.jpg`.
 *
 * ### Why the idle is a table and not a clip
 *
 * The plate's four figures do not share a pose. The knight is in a deep crouch
 * with his sword up across his chest and both elbows at shoulder height; the
 * hat-mage stands almost straight with her rapier low and behind her and her
 * free hand raised in front of her sternum; the staff-mage carries a two-handed
 * haft on a hard diagonal, high hand at the shoulder and low hand across the
 * opposite hip; the archer is coiled — bow arm out and down, draw hand cocked
 * back at the hip, shoulders turned a long way off her feet. Those are four
 * *characters*, and one parametric "combat idle" with a per-character amplitude
 * multiplier cannot be any of them. A single idle across six characters is why
 * a lineup reads as a row of the same doll in different colours, and no amount
 * of costume work fixes it, because silhouette beats colour at battle distance.
 *
 * So each entry below is a whole stance: the trunk's twist and lean, how deep
 * the legs sit, how far apart and how staggered the feet are, and a full arm
 * pose for the weapon arm and the free arm separately. The breathing, the weight
 * shift and the drift are shared — those are life, not character.
 *
 * ### Conventions (see the file header)
 *
 * All angles are radians, additive from bind. On a limb bone `+rx` swings
 * backward, so a forward reach is negative; `rz` is multiplied by `side` at the
 * call site so a positive `roll` lifts the limb *outward* on either side. Arm
 * poses are written for the weapon arm (`lead`) and the free arm (`off`) rather
 * than for left and right, so a left-handed character gets the mirror for free.
 *
 * `yaw` is the shoulder-over-hip twist, and its sign is not arbitrary: the stage
 * squares each character to the threat and then adds a positive `rotation.y` to
 * open them toward the lens, so **positive yaw here continues that opening**.
 * The hips take a share of it backwards and the chest the rest forwards, which
 * is the diagonal every plate figure stands on and — with the stage's 20–46° —
 * what puts the whole cast at a genuine three-quarter body angle instead of the
 * near-profile the review measured.
 *
 * ### The arm numbers are solved, not dialled
 *
 * Seven joint angles per arm reach one hand position and one weapon direction,
 * and the map between them is not something a human reads off a screenshot —
 * the shoulder's three rotations and the elbow's one *compose*, so raising a
 * hand in front of the chest by flexing shoulder and elbow together rotates the
 * fist through 127° and points the weapon at the floor behind the character.
 * That is not hypothetical: it is what the previous idle did, and every held
 * weapon in the cast raked backward and down out of it.
 *
 * So the pose was stated as a *goal* — where the weapon hand sits, in fractions
 * of body height, and which way the blade points — and the seven angles were
 * solved for it offline by simulated annealing over the real bind rig and the
 * real `'YXZ'` composition, under joint limits (shoulder ±1.7/±0.6/−0.4…1.35,
 * elbow flexion only and never under 0.45 rad, wrist ±0.6) with penalties on
 * extreme wrist and shoulder values. The residuals are all under 0.02 H of hand
 * position. The goals, taken off the plate:
 *
 * | stance    | weapon hand (x, y, z)/H | blade direction        |
 * |-----------|-------------------------|------------------------|
 * | `guard`   | ( 0.00, 0.60, 0.13)     | up 25°, back over the shoulder |
 * | `carry`   | (−0.04, 0.55, 0.14)     | up 38°, back — the plate's staff diagonal |
 * | `present` | ( 0.13, 0.42, −0.02)    | near vertical, trailing |
 * | `channel` | ( 0.10, 0.51, 0.13)     | vertical                |
 *
 * ### `aim`, and why the weapon direction stopped being one of the angles
 *
 * The seven-angle solve above places the *hand*. It cannot reliably place the
 * *weapon*, because where the weapon points is the hand's orientation composed
 * with the haft's own carry rotation — a per-character number authored in
 * `roster.js` and baked into the mesh by `CharacterFactory.buildWeapon` — and
 * the two were solved independently. The result was measurable in a lineup:
 * `guard` and `carry` differ by 0.3 rad at the shoulder and nothing else, yet
 * the lance rose across its owner's head on a clean diagonal while the sword
 * raked backward and down out of the fist at hip height, because the two
 * weapons carry at −0.34/+0.15 and +0.20/+0.45. Every plate figure's weapon
 * breaks its own head silhouette; three of our four did not, and no amount of
 * shoulder tuning was going to fix a term the shoulder does not contain.
 *
 * So the direction is stated rather than emerging: `aim` is where the haft
 * points in **character space** (+X the character's left, +Y up, +Z toward the
 * threat), and `_aimWeapon` solves the wrist for it every frame against the
 * pose the arm actually ended up in. The arm angles below therefore only have
 * to put the fist somewhere plausible; the haft's direction is a property of
 * the stance, is the same on every character standing in it, and survives a
 * retune of the roster's carry angles.
 *
 * The correction is spent across the forearm and the wrist and capped at each
 * ({@link FOREARM_AIM_LIMIT}, {@link AIM_LIMIT}), so it can bend an arm and can
 * never break one — a goal the arm cannot reach comes out partly satisfied and
 * still anatomical, which is the right failure.
 *
 * Retuning a stance means changing the goal and re-solving, not nudging the
 * angles: nudge one and the weapon swings somewhere nobody asked for.
 */
const STANCES = {
  /**
   * The knight. Deep crouch, feet wide, sword carried up and back over the
   * weapon shoulder — the most closed and lowest of the four, and the one that
   * has to read as *braced*.
   */
  guard: {
    yaw: 0.50, lean: 0.10, crouch: 0.32, open: 0.245, stagger: 0.19, breath: 0.9,
    // Blade up and back across the weapon shoulder, so it crosses the head from
    // the near side — `bravely01.jpg`'s knight, whose sword climbs out of frame
    // past his own ear.
    aim: [-0.30, 0.90, -0.31],
    lead: { pitch: -0.72, yaw: 0.34, roll: -0.30, elbow: -1.62, wrist: [0.55, -0.03, 0.50] },
    // The off hand comes across onto the hilt below the lead one: the plate's
    // knight has both hands on the sword and that is most of what makes the
    // stance read as braced rather than as posed.
    off: { pitch: -0.86, yaw: 0.62, roll: -0.34, elbow: -1.36, wrist: [0.24, 0, 0.30] },
  },
  /**
   * The staff-mage. Upright, weight back, a two-handed haft on a long diagonal:
   * weapon hand high at the near shoulder, free hand lower and across.
   */
  carry: {
    yaw: 0.44, lean: 0.05, crouch: 0.13, open: 0.175, stagger: 0.13, breath: 1.0,
    // The long forward diagonal: haft low behind the hip, head of the weapon up
    // past the far shoulder. This is the one stance whose weapon already read,
    // and the aim is that read stated explicitly so it survives a retune.
    aim: [0.16, 0.66, 0.74],
    lead: { pitch: -0.34, yaw: 0.04, roll: -0.34, elbow: -1.44, wrist: [0.62, -0.08, 0.52] },
    off: { pitch: -0.52, yaw: 0.58, roll: -0.34, elbow: -1.24, wrist: [0.10, 0, 0.14] },
  },
  /**
   * The hat-mage. Nearly straight-legged, feet close, weapon low and trailing
   * with the blade near vertical, free hand raised in front of the sternum. The
   * lightest stance in the set; its contrast against `guard` is what makes a
   * lineup read as a party.
   */
  present: {
    yaw: 0.42, lean: 0.02, crouch: 0.06, open: 0.115, stagger: 0.09, breath: 1.15,
    // Near vertical and trailing a few degrees, so the staff head stands clear
    // above the hat and the shaft runs down past the hip — the hat-mage's
    // silhouette, which is a vertical line broken by a head.
    aim: [0.02, 0.96, 0.28],
    lead: { pitch: 0.16, yaw: 0.26, roll: 0.10, elbow: -0.86, wrist: [0.05, 0, -0.11] },
    off: { pitch: -0.63, yaw: -0.04, roll: 0.04, elbow: -1.65, wrist: [-0.22, 0, 0.16] },
  },
  /**
   * The archer. The most twisted of the four: bow arm out and down toward the
   * threat, draw hand cocked back at the hip, so the shoulder line sits a long
   * way off the pelvis and the whole figure reads as loaded.
   */
  ready: {
    yaw: 0.62, lean: 0.07, crouch: 0.24, open: 0.205, stagger: 0.21, breath: 1.0,
    // No `aim`: this stance belongs to a character whose weapon is slung across
    // the back, and a fitting on the chest has no wrist to aim it with. Its
    // silhouette read is bought in `Rig.buildChainMetrics`, which now carries a
    // back mount at the shoulder line instead of at the ribs.
    lead: { pitch: -0.72, yaw: -0.22, roll: 0.34, elbow: -0.62, wrist: [-0.12, 0, 0.10] },
    off: { pitch: 0.52, yaw: 0.05, roll: -0.02, elbow: -0.72, wrist: [0.08, 0, -0.10] },
  },
  /**
   * No plate figure — the forge-hand archetype, for a character whose weapon is
   * strapped to a forearm and whose hands are therefore both free. Both fists up
   * and in, weight forward over a wide base: the only stance in the set that
   * leans *into* the threat rather than sitting back off it.
   */
  brawl: {
    yaw: 0.40, lean: 0.15, crouch: 0.28, open: 0.265, stagger: 0.14, breath: 0.85,
    // No `aim` — the weapon is bolted to a forearm. Its read is bought by the
    // guard height instead: the lead forearm comes up to the cheek so the
    // piston stands beside the head, which is a boxer's guard and the only way
    // a forearm fitting can break a head silhouette.
    lead: { pitch: -1.66, yaw: -0.10, roll: 0.28, elbow: -1.90, wrist: [-0.20, 0, 0.16] },
    off: { pitch: -0.86, yaw: 0.34, roll: -0.20, elbow: -1.44, wrist: [-0.12, 0, 0.10] },
  },
  /**
   * The caster. The hat-mage's raised hand pushed all the way: book or focus
   * held out in front in the weapon hand, free hand lifted high and open beside
   * the head. Reads at a hundred pixels, which is the test.
   */
  channel: {
    yaw: 0.46, lean: -0.06, crouch: 0.09, open: 0.145, stagger: 0.09, breath: 1.2,
    // A tome has a spine, and a spine held upright and canted toward the reader
    // is what "casting from a book" looks like. Raised to the jaw by the arm
    // pose below, it breaks the head silhouette on the near side.
    aim: [0.30, 0.90, 0.31],
    lead: { pitch: -1.02, yaw: 0.52, roll: 0.28, elbow: -1.10, wrist: [0.34, -0.20, -0.30] },
    off: { pitch: -1.28, yaw: -0.42, roll: 0.44, elbow: -1.62, wrist: [-0.30, 0, 0.20] },
  },
};

/**
 * How far `_aimWeapon` may turn a wrist to satisfy a stance's `aim`.
 *
 * A cap rather than a solve because the alternative failure is worse than the
 * one it prevents. Without it a goal the shoulder cannot support is reached by
 * folding the hand back on the forearm, which at battle distance reads as a
 * broken wrist — and unlike a weapon pointing slightly wrong, a broken wrist is
 * not something the eye forgives. 1.25 rad is about the limit of a real wrist's
 * combined flexion and deviation, so a pose that needs more is a pose whose arm
 * angles are wrong, and it comes out visibly under-rotated rather than
 * dislocated.
 */
const AIM_LIMIT = 1.25;

/**
 * The forearm's share of the same correction — see `_aimWeapon`.
 *
 * Held to a third of a radian because the elbow is the joint the eye checks. A
 * wrist bent past its neutral reads as effort; a forearm rolled the same amount
 * reads as a broken arm, because the upper arm beside it did not move. Nineteen
 * degrees is enough to take the worst residual in the table (0.60 rad on the
 * caster) down to something a wrist can finish, and small enough that the elbow
 * still folds where the stance put it.
 */
const FOREARM_AIM_LIMIT = 0.34;

/**
 * Which stance a character stands in.
 *
 * Keyed on the weapon first, because a stance is mostly a consequence of what is
 * in the hands, and on the role only as the fallback for a weapon this table has
 * not met — so a new roster entry still gets a considered pose rather than the
 * generic one.
 */
const STANCE_BY_WEAPON = {
  sword: 'guard', axe: 'guard', greatsword: 'guard',
  lance: 'carry', spear: 'carry', halberd: 'carry', staff: 'carry',
  chimestaff: 'present', rapier: 'present', wand: 'present',
  grimoire: 'channel', tome: 'channel', focus: 'channel',
  bow: 'ready', chakram: 'ready', dagger: 'ready',
  piston: 'brawl', gauntlet: 'brawl',
};
const STANCE_BY_ROLE = {
  tank: 'brawl', vanguard: 'guard', striker: 'ready',
  dragoon: 'carry', healer: 'present', mage: 'channel',
};

function stanceFor(def) {
  const byWeapon = STANCES[STANCE_BY_WEAPON[def?.weapon?.kind]];
  if (byWeapon) return byWeapon;
  return STANCES[STANCE_BY_ROLE[def?.role]] ?? STANCES.guard;
}

/**
 * Idle: the character's own combat stance from {@link STANCES}, breathing.
 *
 * What is shared across every stance, because it is true of all four plate
 * figures and is life rather than character:
 *
 * - **Both knees are bent, always.** Not one of the four has a locked leg, and a
 *   locked leg is most of why our cast read as "simplified": a straight limb has
 *   no interior shape at all. `crouch` only says *how* bent.
 * - **The weight sits on the back foot** — the weapon-side one, which `stagger`
 *   has already placed behind — and stays there. It used to alternate fully
 *   from side to side over eleven seconds, which is a rocking motion nobody in a
 *   fight makes; the shift now only modulates a standing bias.
 * - **The trunk breathes about two and a half degrees** at the chest, on a 3.6 s
 *   period, against an 11 s weight drift and a 7.3 s noise wander. Three
 *   mutually irrational periods so the loop never visibly repeats — a
 *   single-period idle is the most recognisable tell of procedural animation
 *   there is.
 * - **A two-second sway** on top of all of it. The other three periods are slow
 *   enough that a two-second glance at the frame — which is what a player
 *   actually gives a battle line between commands — sees no motion at all, and
 *   a still figure among grass that moves reads as a paused game. The sway is
 *   the fast term: a small lateral drift of the pelvis with the shoulders and
 *   head counter-rolling a beat behind it, which is a body keeping its balance
 *   rather than a body being animated. It is deliberately the *smallest*
 *   amplitude of the four, because at this rate anything larger is a fidget.
 */
CLIPS.idle = {
  duration: 0,
  loop: true,
  plant: true,
  spring: 11,
  aimWeapon: true,
  fn(p, c) {
    const t = c.t;
    const st = c.stance;
    const breath = Math.sin(t * TAU / 3.6) * st.breath;
    const shift = Math.sin(t * TAU / 11.0);
    const drift = noise1(t * 0.42, c.seed);
    // The 2 s sway, and its lagged partner. A quarter-period of lag is what
    // makes the shoulders trail the hips instead of moving as one board.
    const sway = Math.sin(t * TAU / 2.0);
    const swayLag = Math.sin(t * TAU / 2.0 - 0.55);
    const w = c.bias.weight;
    const lead = c.leadSide;

    // The trunk. `yaw` is split so the pelvis stays squarer to the threat than
    // the shoulders — a third of it backwards at the hips, the rest forwards up
    // the spine — which is the diagonal the plate stands on. The roll and the
    // pelvis drop follow the loaded leg, which is what "standing" actually is.
    p.rot('hips', st.lean * 0.25 + 0.012 * breath, -st.yaw * 0.30 + shift * 0.045,
      shift * 0.070 * w + sway * 0.018 * w);
    p.pos('hips', shift * 0.007 * c.H + sway * 0.0032 * c.H, 0, 0);
    p.rot('spine', st.lean * 0.40 + 0.014 * breath, st.yaw * 0.40 + shift * -0.025,
      shift * -0.042 - swayLag * 0.012);
    p.rot('chest', st.lean * 0.35 + 0.038 * breath, st.yaw * 0.60 + shift * -0.022,
      shift * -0.028 - swayLag * 0.010);
    // The neck gives a little of the yaw back so the head does not lead the
    // chest round; `lookAt` layers the actual gaze on top of this.
    p.rot('neck', -0.030 - breath * 0.012, -st.yaw * 0.10 + drift * 0.05, shift * 0.020);
    p.rot('head', -0.045 - breath * 0.010, -st.yaw * 0.12 + drift * 0.10,
      shift * 0.028 + drift * 0.03 + swayLag * 0.014);

    p.pair((side, s) => {
      const isLead = side === lead;
      const a = isLead ? st.lead : st.off;
      // Opposite phases so the two arms never sway in lockstep, which is the
      // other classic procedural tell.
      const swing = Math.sin(t * TAU / 7.3 + (isLead ? 0 : Math.PI * 0.85));

      // `yaw` is authored as "across the body", so it takes the side's sign; a
      // positive yaw carries either hand toward the character's centreline.
      p.rot(`arm${s}`, a.pitch + swing * 0.030, -side * a.yaw, side * (a.roll + swing * 0.025));
      p.rot(`forearm${s}`, a.elbow - swing * 0.045, 0, side * 0.05);
      // The wrist is what sets the *weapon's* angle. Rotating the `weapon` bone
      // would do it too and would be wrong: the fist is modelled closed around
      // the haft at a fixed bore, so turning the weapon inside the hand slides
      // it straight out through the fingers. Turning the hand takes the grip
      // with it.
      p.rot(`hand${s}`, a.wrist[0], a.wrist[1], side * a.wrist[2]);

      // Legs. `open` splays the whole leg from the hip so the feet sit apart and
      // the knees follow, rather than translating the ankles and leaving two
      // parallel tubes. Measured on the plate, the staff-mage's boots span
      // 0.325 H outer-to-outer standing still, which is what the 0.13–0.26 band
      // above is calibrated to.
      const open = st.open + shift * side * 0.014;
      // The weapon-side foot goes back; the free-side foot leads.
      const stagger = isLead ? st.stagger : -st.stagger * 1.15;
      // Weight stays on the back foot, with the slow shift only modulating how
      // much: 0.55–0.95 on the loaded leg against 0.05–0.45 on the free one.
      const load = isLead ? 0.75 + 0.20 * shift : 0.25 - 0.20 * shift;
      p.rot(`thigh${s}`, stagger * 0.55 - 0.06 - st.crouch * 0.42 - load * 0.05,
        side * 0.03, side * open);
      p.rot(`shin${s}`, 0.13 + st.crouch * 0.80 + load * 0.09, 0, 0);
      p.rot(`foot${s}`, -0.07 - st.crouch * 0.36 - load * 0.04, 0, side * open * 0.35);
    });

    // Kept tiny on purpose — see the wrist note above. This is the haft
    // trembling in the fist, not the character aiming it.
    if (c.hasWeapon) p.rot('weapon', breath * 0.016, 0, drift * 0.024);
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

/**
 * Stride length, in world units per full cycle.
 *
 * Measured against the **leg**, not against total height. A gait is a pendulum
 * problem: how far a step carries you is set by how long your legs are and how
 * far they swing, and nothing else. Expressing it as a fraction of height only
 * worked while every character had the same head-to-leg ratio, and the roster's
 * `legLength` multiplier already ranges 0.84–1.10 across the cast — so the short
 * -legged characters were being asked for a stride they physically could not
 * reach, and made up the difference by skating. 1.65 leg-lengths per cycle is
 * the human walking ratio; 2.5 is a jog.
 */
const strideFor = (metrics, k) => (metrics.segments.thigh + metrics.segments.shin) * k;

CLIPS.walk = {
  duration: 0,
  loop: true,
  plant: true,
  spring: 14,
  /** World units advanced per full cycle — locomotion controllers sync to this. */
  stride(metrics) { return strideFor(metrics, 1.65); },
  fn(p, c) {
    locomotion(p, c, {
      cycle: 1.02 / c.speedScale,
      // Shoulder counter-yaw is up and pelvis yaw down against the old values.
      // The torso is a third longer than it was — the head no longer eats 0.29 H
      // of the figure — so the same angle at the chest now moves the shoulders
      // visibly further, and the same angle at the hips moves them less relative
      // to a longer trunk. The *displacement* is what reads, not the angle.
      lean: 0.045, pelvisYaw: 0.085, pelvisRoll: 0.070, shoulderYaw: 0.17,
      lateral: 0.012, headBob: 0.018,
      // Thigh swing at ±24°, which is the human walking figure. 0.52 rad was
      // ±30°, a march. `kneeBias` is the floor the stance leg keeps: with real
      // knees in the mesh a locked one is now visible, and no plate figure has
      // one.
      hip: 0.42, knee: 0.88, kneeBias: 0.12, ankle: 0.22, ankleBias: -0.04,
      // Negative `armOut`: the bind pose supplies ten degrees of splay and the
      // plate's walking arms hang closer than that, not wider.
      arm: 0.32, armBias: -0.04, armOut: -0.04, armOutSwing: 0.03,
      forearm: 0.30, forearmBias: 0.10, weaponSwing: 0.06,
    });
  },
};

CLIPS.run = {
  duration: 0,
  loop: true,
  plant: true,
  spring: 16,
  stride(metrics) { return strideFor(metrics, 2.50); },
  fn(p, c) {
    locomotion(p, c, {
      cycle: 0.60 / c.speedScale,
      lean: 0.30, pelvisYaw: 0.14, pelvisRoll: 0.095, shoulderYaw: 0.30,
      lateral: 0.016, headBob: 0.030,
      hip: 0.78, knee: 1.55, kneeBias: 0.22, ankle: 0.34, ankleBias: -0.07,
      arm: 0.58, armBias: -0.34, armOut: -0.01, armOutSwing: 0.05,
      forearm: 0.95, forearmBias: 0.40, weaponSwing: 0.10,
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
        // The off arm drops *against* the ribs rather than standing off them:
        // the bind pose already carries the plate's ten degrees of splay, and a
        // victory pose reads from the one raised arm, not from two.
        p.rot(`arm${s}`, -0.10 * enter, 0, side * (0.06 + sway * 0.03) * enter);
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
    // The pelvis drop is tuned against the folded-leg trigonometry, and it had
    // to come up. With the thighs at -1.3 rad and the shins at +1.9, the ankles
    // now sit about 0.183 H below the hips rather than the 0.175 H the old
    // proportions gave — and the legs themselves are a different length — so the
    // -0.215 H this used to fall to put the boots 0.04 H under the floor on
    // every character. `plant` is false on this clip, deliberately (a corpse is
    // not standing on anything), which means nothing downstream catches it: the
    // number here is the only thing holding the body above the ground.
    //
    // It is also what a revive blends *out of*, so a drop that is too deep
    // drags the feet under the floor through the whole cross-fade as well.
    p.pos('hips', 0.04 * H * fall, -0.112 * H * buckle - 0.026 * H * fall, -0.10 * H * fall);
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
   * @param {THREE.Vector3} [opts.weaponAxis] the held weapon's long axis in the
   *        holding hand's frame, from `CharacterFactory.buildWeapon`
   * @param {string} [opts.weaponMount] `handL`/`handR` when the weapon is held
   */
  constructor({
    bones, order, rest, metrics, def, skip = null, irises = null, lids = null,
    weaponAxis = null, weaponMount = null,
  }) {
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

    /** This character's standing stance — see {@link STANCES}. */
    this.stance = stanceFor(def);

    // ---- weapon aiming (see `_aimWeapon`) --------------------------------
    //
    // The chain is walked off the live bones rather than read from a table of
    // parent names: `Rig` owns the hierarchy, and a second copy of it here
    // would be a silent source of wrong answers the first time a shoulder stub
    // is added or removed.
    const held = weaponMount === 'handL' || weaponMount === 'handR' ? weaponMount : null;
    this._aimHand = held && bones[held] ? bones[held] : null;
    this._aimChain = [];
    if (this._aimHand) {
      for (let b = this._aimHand.parent; b && b.isBone; b = b.parent) this._aimChain.push(b);
      this._aimChain.reverse();
    }
    this._aimAxis = weaponAxis ? new THREE.Vector3().copy(weaponAxis).normalize() : null;
    this._aimGoal = this.stance.aim
      ? new THREE.Vector3(this.stance.aim[0], this.stance.aim[1], this.stance.aim[2]).normalize()
      : null;

    this._ctx = {
      t: 0, u: 0, H: metrics.height, seed: this.seed, bias: this.bias,
      leadSide: this.leadSide, hasWeapon: this.hasWeapon, speedScale: 1,
      stance: this.stance,
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
    // Scratch for `_groundSolve`'s three-bone chain: pelvis, thigh, shin, and
    // reused by `_aimWeapon`, which runs after it in the same frame.
    this._qh = new THREE.Quaternion();
    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._qi = new THREE.Quaternion();
    this._va = new THREE.Vector3();
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

    this._softenJoints(out);
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
    // After the bones, because it is solved against the pose that shipped —
    // spring smoothing included — rather than against the pose that was asked
    // for. Weighted by how much of the frame belongs to a clip that wants it,
    // so a cross-fade into an attack releases the aim on the same curve the
    // rest of the body changes on.
    const wantCur = this._cur.clip.aimWeapon ? 1 : 0;
    const wantPrev = this._prev ? (this._prev.clip.aimWeapon ? 1 : 0) : wantCur;
    this._aimWeapon(wantPrev + (wantCur - wantPrev) * w);
    this._blink(d);
  }

  /**
   * Point a held weapon where the stance says it points.
   *
   * Seven arm angles place a fist; they do not place a haft, because the haft's
   * direction is the fist's orientation composed with a carry rotation baked
   * into the weapon mesh from `roster.js` (see {@link STANCES}'s note on `aim`).
   * Those two were authored independently, and the cast showed it: identical
   * arm poses carried a lance across the head and a sword backwards into the
   * ground. This closes the loop.
   *
   * ### The solve
   *
   * `Rig` guarantees every bind rotation is identity, so the rotation of any
   * bone in character space is just the product of its ancestors' local
   * quaternions — no bind orientations to unwind, no world matrices to be up to
   * date. With `Qc` that product for the hand's parent and `Qh` the hand's own
   * local rotation, the haft currently points along `Qc·Qh·axis`; the swing
   * `Qf` that takes it to the goal is the minimal rotation between the two, and
   * the hand rotation that realises it is
   *
   * ```
   * Qh' = Qc⁻¹ · Qf · Qc · Qh
   * ```
   *
   * because `Qc·Qh' = Qf·Qc·Qh` by construction. Rotating the **hand** and not
   * the `weapon` bone is deliberate and is the same argument the idle's wrist
   * channel carries: the fist is modelled closed around the haft at a fixed
   * bore, so turning the weapon inside the hand slides it out through the
   * fingers, while turning the hand takes the grip with it.
   *
   * ### Why it is two joints and not one
   *
   * A wrist alone cannot carry it. Measured on the settled idle, the authored
   * arm poses left the sword 0.36 rad short of its goal, the tome 0.60 and the
   * lance 0.57 — all past {@link AIM_LIMIT}, so all three shipped truncated and
   * the lance in particular stood up vertical when the stance asked for a
   * diagonal. Spending the first part of the swing at the **forearm** and the
   * rest at the wrist is both anatomically what an arm does when it presents
   * something and enough authority to land every goal in the table, at half the
   * wrist deflection. The forearm's own share is capped harder, because an
   * elbow that rolls too far reads as a broken arm from any angle where the
   * upper arm is visible.
   *
   * The swing is capped at each joint and scaled by `weight`, so this stays a
   * correction rather than an override: it cannot reach a pose the arm did not
   * nearly reach on its own, and it cannot snap.
   */
  _aimWeapon(weight) {
    const hand = this._aimHand;
    const goal = this._aimGoal;
    const axis = this._aimAxis;
    if (!hand || !goal || !axis || weight <= 1e-3) return;
    const chain = this._aimChain;

    // Pass one at the forearm, pass two at the wrist. Each pass re-measures
    // where the haft actually points, so the second is solving the residual of
    // the first rather than a share of a stale total. A hand with no bone
    // ancestors cannot happen on a rig this file would be handed, and skipping
    // the first pass rather than indexing past the end is what keeps that true
    // of a rig it would not.
    if (chain.length > 0) {
      this._aimJoint(chain.length - 1, chain[chain.length - 1], FOREARM_AIM_LIMIT, weight);
    }
    this._aimJoint(chain.length, hand, AIM_LIMIT, weight);
  }

  /**
   * One pass of the aim solve, absorbed at `bone`, whose own ancestors are the
   * first `n` links of the hand chain.
   *
   * The *measurement* is always the full chain through the hand — that is where
   * the weapon hangs — while the *application* is at whichever joint is
   * spending this pass. Split out of `_aimWeapon` because the algebra is
   * identical at both joints and writing it twice is how the two would drift
   * apart.
   */
  _aimJoint(n, bone, limit, weight) {
    const chain = this._aimChain;
    const qFull = this._qh.identity();
    for (const b of chain) qFull.multiply(b.quaternion);
    qFull.multiply(this._aimHand.quaternion);
    const cur = this._v.copy(this._aimAxis).applyQuaternion(qFull);

    const goal = this._aimGoal;
    const angle = Math.acos(THREE.MathUtils.clamp(cur.dot(goal), -1, 1));
    if (angle < 1e-3) return;
    const swing = this._va.crossVectors(cur, goal);
    // Exactly opposed vectors have no unique swing axis. It cannot happen from
    // any authored stance — the goals are all within a right angle of the pose
    // the arm reaches — and leaving the frame alone is the only answer that
    // does not pick an arbitrary plane.
    if (swing.lengthSq() < 1e-12) return;
    swing.normalize();

    const qAnc = this._q1.identity();
    for (let i = 0; i < n; i++) qAnc.multiply(chain[i].quaternion);
    this._q2.setFromAxisAngle(swing, Math.min(angle, limit) * weight);
    this._qi.copy(qAnc).invert();
    // q' = Qa⁻¹ · Qfix · Qa · q, so that Qa·q' = Qfix·Qa·q — the bone's own
    // rotation in character space gains exactly the corrective swing.
    bone.quaternion.premultiply(qAnc).premultiply(this._q2).premultiply(this._qi);
  }

  _advance(state, dt) {
    const clip = state.clip;
    // `_ctxSpeedScale` is deliberately *not* applied here. It shortens the
    // locomotion clip's own cycle length inside the clip function; applying it
    // to the clock as well would square the rate and make a jog look like a
    // sprint played at double speed.
    const speed = state.speed;
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
   * No limb is ever allowed to lock, and none is ever allowed to hyperextend.
   *
   * A systematic rule rather than a floor written into eight clips, because it
   * is a property of the *body*, not of any pose: knees bend one way and elbows
   * bend one way, and a straight one is a pose no living thing holds. It matters
   * now in a way it did not before — the mesh has an actual elbow and knee in it
   * (see `CharacterFactory.buildLimb`), and a joint with volume that never flexes
   * reads worse than no joint at all, because the eye can see what it is for.
   *
   * The floors are small: 3.4° at the knee and 2.9° at the elbow, applied only
   * against the direction each joint cannot physically go. Every clip in the
   * file already poses well past them, so this changes nothing that was authored
   * and catches everything that was not — including the zero pose a cross-fade
   * passes through and the neutral a look-at layer leaves behind.
   */
  _softenJoints(buf) {
    for (const s of ['L', 'R']) {
      const knee = this.index[`shin${s}`];
      if (knee !== undefined && buf[knee * CH] < 0.06) buf[knee * CH] = 0.06;
      const elbow = this.index[`forearm${s}`];
      if (elbow !== undefined && buf[elbow * CH] > -0.05) buf[elbow * CH] = -0.05;
    }
  }

  /**
   * Derive the pelvis height from the pose so the lower foot stays on the floor.
   *
   * Forward kinematics on the real two-link leg, in the sagittal plane:
   *
   * ```
   * ankleY = thighY + Rx(θ₁)·d₁ + Rx(θ₁+θ₂)·d₂        (y component)
   * ```
   *
   * where `d₁` and `d₂` are the *bind offsets* hip→knee and knee→ankle, read
   * straight off the rig. This used to assume `d = (0, −L, 0)` — a leg hanging
   * dead straight — and collapsed to `hipY − L₁cos θ₁ − L₂cos(θ₁+θ₂)`. The rig
   * now sets the knee forward off the hip→ankle chord so the joint has a hinge
   * plane, which makes that assumption wrong in a way that silently *disables
   * the solver*: the straight-leg formula puts the bind ankle below where it
   * really is, so `restAnkle − lowest` came out positive at every pose, `min(0,…)`
   * clipped it to zero, and the pelvis never dropped. Every gait would have gone
   * flat — no weight, no bob — while looking like a tuning problem.
   *
   * Taking the offsets from the rig makes the identity exact instead: at a zero
   * pose this returns the bind ankle to the last bit, whatever the pre-bend is.
   *
   * ### Why it runs the full three-bone chain rather than the sagittal one
   *
   * It used to compose the thigh and shin as scalar rotations about +X, which is
   * exact only for a leg that swings in the sagittal plane. Every stance in
   * {@link STANCES} splays the hip outward by 7–15° so the feet sit apart, and
   * an outward splay *shortens the leg vertically* by `L(1 − cos θ)` — up to
   * 1.4% of body height, six pixels at battle framing, which the solver could
   * not see and therefore did not compensate. The whole cast stood that far off
   * the grass, which at a grazing camera angle reads as the shadow having come
   * unstuck rather than as the character hovering, and is correspondingly hard
   * to attribute.
   *
   * Composing the actual pose quaternions — pelvis, thigh, shin — costs three
   * quaternion multiplies per leg per frame and is exact for any pose, including
   * the pelvis roll that the sagittal form also ignored.
   */
  _groundSolve(buf) {
    const J = this.metrics.joints;
    const e = this._e;
    const qh = this._qh;
    const q1 = this._q1;
    const q2 = this._q2;
    const v = this._v;
    const hi = this.index.hips;

    // The pelvis's own rotation, about the hips joint. Absent from the index
    // (nothing writes it) it is identity, which is what `set(0,0,0)` gives.
    //
    // **`'YXZ'`, matching the application loop.** The pose buffer's three
    // channels are composed as YXZ when they are written onto a bone, so a
    // solver reading the same channels in three.js's default XYZ is not
    // predicting the pose that ships — and for a splayed leg, where the Y and Z
    // terms are both non-zero, the two orders disagree by degrees.
    if (hi !== undefined) e.set(buf[hi * CH], buf[hi * CH + 1], buf[hi * CH + 2], 'YXZ');
    else e.set(0, 0, 0, 'YXZ');
    qh.setFromEuler(e);

    let lowest = Infinity;
    for (const s of ['L', 'R']) {
      const ti = this.index[`thigh${s}`];
      const si = this.index[`shin${s}`];
      if (ti === undefined || si === undefined) continue;
      const hip = J[`thigh${s}`];
      const knee = J[`shin${s}`];
      const ankle = J[`foot${s}`];
      e.set(buf[ti * CH], buf[ti * CH + 1], buf[ti * CH + 2], 'YXZ');
      q1.setFromEuler(e).premultiply(qh);
      e.set(buf[si * CH], buf[si * CH + 1], buf[si * CH + 2], 'YXZ');
      q2.setFromEuler(e).premultiply(q1);

      // hips → hip socket, rotated by the pelvis; then each segment by its own
      // accumulated rotation. Only the y component matters for ground contact.
      v.set(hip.x - J.hips.x, hip.y - J.hips.y, hip.z - J.hips.z).applyQuaternion(qh);
      let y = J.hips.y + v.y;
      v.set(knee.x - hip.x, knee.y - hip.y, knee.z - hip.z).applyQuaternion(q1);
      y += v.y;
      v.set(ankle.x - knee.x, ankle.y - knee.y, ankle.z - knee.z).applyQuaternion(q2);
      y += v.y;
      if (y < lowest) lowest = y;
    }
    if (!Number.isFinite(lowest)) return;
    if (hi === undefined) return;
    // Only ever *lower* the pelvis. Lifting it would let a bent-knee pose hover,
    // and a floating character is a far worse artefact than a slightly sunk foot.
    buf[hi * CH + 4] += Math.min(0, J.footL.y - lowest);
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
      const slide = this.metrics.eye.height * 1.06;
      this.lids.position.y = this._lidRest.y - close * slide;
      // The lid rides a sphere, so a pure vertical slide would sink it into the
      // skull by the time it reaches the eye's lower edge. Pushing forward by
      // ~0.38 of the slide tracks the head's curvature closely enough that the
      // lid stays proud of the iris across the whole blink.
      this.lids.position.z = this._lidRest.z + close * slide * 0.38;
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
