/**
 * Rig.js — skeleton construction and the body metric that everything else in
 * `src/characters` measures itself against.
 *
 * The bone names are fixed by ARCHITECTURE.md and are not negotiable:
 * `root, hips, spine, chest, neck, head, shoulderL/R, armL/R, forearmL/R,
 * handL/R, thighL/R, shinL/R, footL/R`, plus optional `hair0..n`, `cape0..n`
 * and `weapon`.
 *
 * The *proportions* are measured off the plates — see the table on `F` below.
 * They are measured on the **silhouette head**, skull plus hair or headgear,
 * because that is the shape an eye (or a critic with a ruler) reads as "head",
 * and it is the only measurement the plates and the prose specs can be compared
 * on at all.
 *
 * ## Why the metric lives here and not in the factory
 *
 * Skinning quality is entirely a question of whether the geometry and the bone
 * segments agree about where a joint is. If the factory computed "the knee is
 * 20% up the leg" independently of the rig, every retune of a proportion would
 * silently desynchronise the two and produce candle-wax deformation that looks
 * like a shader bug. So `computeMetrics()` is the only place a body dimension
 * is decided, the rig is built from it, and the mesh generator is handed the
 * same object. There is exactly one number for the knee.
 *
 * ## Two construction rules that keep procedural animation sane
 *
 * 1. **Every bind-pose bone has identity rotation.** Direction is carried by
 *    the bone's translation offset, never by a bind rotation. That means the
 *    animator can author a pose as plain local Euler angles — "swing the thigh
 *    -0.4 about X" — and read the same on every character, instead of having
 *    to pre-multiply an arbitrary bind orientation per bone.
 * 2. **Bind-pose world matrices are computed with the rig at the origin**, and
 *    `THREE.Skeleton` derives its inverses from exactly those. The character
 *    group can then be placed anywhere in the world: `SkinnedMesh` defaults to
 *    `AttachedBindMode`, which refreshes `bindMatrixInverse` from the mesh's
 *    world matrix every frame, so a moving parent does not double-transform.
 *
 * Coordinate convention: +Y up, **+Z forward** (the direction the character
 * faces), +X to the character's *left*. The A-pose splays the arms outward in
 * the XY plane, which is what makes the analytic skin-weight solve in
 * `CharacterFactory` unambiguous — no two bone segments are near-collinear.
 *
 * OWNED BY: characters.
 */
import * as THREE from 'three';
import { FACE_LAYOUT } from './FaceTexture.js';

/**
 * Layer bit every character surface — body, cape, outline hull, contact decal —
 * is enabled on in addition to layer 0.
 *
 * It lives here rather than in `CharacterFactory` only because `Cloth` needs it
 * too and must not import the factory that constructs it. Its purpose is the
 * factory's: it lets a scene name the whole cast in one call, which is what a
 * depth-aware volumetric composite or a cast pass drawn *after* the mist needs
 * in order to exist. Enabling an extra bit changes nothing for a renderer that
 * does not look for it.
 */
export const CAST_LAYER = 3;

/** The contractual core skeleton, in the order used for `skinIndex`. */
export const BONE_NAMES = Object.freeze([
  'root',
  'hips', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'armL', 'forearmL', 'handL',
  'shoulderR', 'armR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL',
  'thighR', 'shinR', 'footR',
]);

/** Parent of each core bone. `root` has none. */
export const BONE_PARENTS = Object.freeze({
  root: null,
  hips: 'root',
  spine: 'hips',
  chest: 'spine',
  neck: 'chest',
  head: 'neck',
  shoulderL: 'chest', armL: 'shoulderL', forearmL: 'armL', handL: 'forearmL',
  shoulderR: 'chest', armR: 'shoulderR', forearmR: 'armR', handR: 'forearmR',
  thighL: 'hips', shinL: 'thighL', footL: 'shinL',
  thighR: 'hips', shinR: 'thighR', footR: 'shinR',
});

/**
 * Station table — every value a fraction of total height H.
 *
 * ## The head measurement, re-taken on the plates against a labelled grid
 *
 * Every previous pass on this file measured the **bare skull** — hairline to
 * chin — and every critic measures the **silhouette head**: the black shape a
 * hair mass or a hat makes over the shoulders. Those two numbers differ by
 * 15–35% on the same figure, which is why this file has swung between "3.1
 * heads" and "4.7 heads" while nothing on screen moved. All the numbers below
 * are the silhouette measure, taken by cropping each figure out of the plate at
 * 2–3× with a 10-pixel labelled grid over it, top of hair/hat → chin, and
 * top of hair/hat → sole:
 *
 * | plate      | figure               | head   | standing | heads |
 * |------------|----------------------|--------|----------|-------|
 * | bravely01  | knight (crouched)    | 100 px |  375 px  | 3.75  |
 * | bravely01  | hat-mage girl        | 105 px |  430 px  | 4.10  |
 * | bravely01  | staff-mage, adult    | 127 px |  522 px  | 4.11  |
 * | bravely01  | archer, black hat    | 133 px |  530 px  | 3.98  |
 * | bravely02  | same girl, fur hat   |  85 px |  285 px  | 3.35  |
 * | bravely05  | ninja (lunging)      | 120 px |  340 px  | 2.83  |
 *
 * So the reference is not one number: a standing figure in an unbulky hat sits
 * at 4.0, and the same cast in winter headgear or in a low combat pose reads
 * 2.8–3.4. **We target 3.35** — `bravely02`'s hat-mage, standing, un-cropped,
 * the most chibi *standing* figure in the set. That is a deliberate pick of the
 * plates' chibi end rather than their mean, because the one thing every review
 * of our cast has agreed on is that the figures read as dolls rather than as
 * drawings, and the head is the single control that moves that read.
 *
 * `headDiameter` is the **skull**, and our own hair shells and styles add 9–11%
 * of skull height on top of it (measured on the built geometry by
 * `auditCharacter.crownRise`), so 0.272 H of skull is 0.299 H of silhouette
 * head — 3.35 heads. `auditCharacter` enforces the band on the silhouette, and
 * that is the number that has to be 3.2–3.7, not this one.
 *
 * ## What the head costs, and where it comes from
 *
 * The crown is pinned to `height`, so the head is paid for out of the trunk:
 * the neck joint drops from 0.749 H to 0.690 H and the torso from 0.324 H to
 * 0.265 H. That is the whole point. A chibi is not a small adult; it is an
 * adult's head on an 18-month-old's trunk, and shortening the trunk is what
 * stops the figure reading as a scale model of a person.
 *
 * It also fixes the shoulder ratio for free, which is why `shoulderX` below is
 * unchanged. `CharacterFactory`'s deltoid cap sits on the arm joint at 0.088 H
 * with a 0.049 H radius, so the shoulder line measures 0.274 H across; against
 * a skull 0.170 H wide that was **1.61 head-widths**, a linebacker. Against the
 * new 0.218 H skull it is **1.26**.
 *
 * The plate's own band, measured the same way — widest point of the hair mass
 * against the garment at the deltoid: the hat-mage is 87 px of head against
 * 88 px of shoulder, i.e. **1.01**; the staff-mage in his coat is 80 against
 * 108, i.e. **1.35**. Girls sit at parity and men a third wider, which is the
 * spread the roster's `shoulder` and `limb` multipliers reproduce around this
 * default — 1.11 on Seren, 1.45 on Bramm.
 *
 * The hips do not move. The legs were never the problem.
 */
const F = Object.freeze({
  // 0.272 H of skull → 0.299 H of silhouette head → 3.35 heads. See above.
  headDiameter: 0.272,
  hipY: 0.425,         // pelvis root; the crotch reads at 0.375 H, the socket above it
  neckGap: 0.038,      // chin to neck joint — the plate has a real, visible neck
  spineT: 0.26,        // fraction of the hips→neck span
  chestT: 0.62,
  // 86% of the way up a trunk that now ends at 0.690 H, i.e. the shoulder joint
  // at 0.653 H and the chin at 0.728 H. Measured on `bravely02`'s hat-mage —
  // the figure the head proportion is taken from — the chin sits at 0.70 of
  // standing height, so the two agree to within a pixel and a half at her size.
  shoulderT: 0.86,
  ankleY: 0.050,

  // Joint separation, *not* silhouette width — the deltoid cap in
  // `CharacterFactory` is what actually draws the shoulder line, and it carries
  // its own radius outboard of this. Held at 0.072 deliberately: see the note
  // above on why growing the head is what lands the shoulder-to-head ratio on
  // the plate's 1.2 without touching the shoulder at all.
  shoulderX: 0.072,
  armSplay: 0.175,     // radians off vertical for the A-pose (~10°)
  upperArm: 0.128,
  foreArm: 0.118,
  // **Pre-bend.** The elbow sits this far behind the shoulder→wrist line and the
  // knee this far in front of the hip→ankle line, as a fraction of H.
  //
  // A bind limb whose three joints are collinear has no hinge plane, and linear
  // blend skinning across a straight joint is exactly the case that pinches: the
  // two segments' influence regions are coaxial, so a bend shears the surface
  // sideways instead of folding it and the cross-section collapses. Half a
  // degree of set is enough to break the degeneracy, but 6–7° also *shows* — the
  // plate's characters have visibly bent arms and soft knees standing still, and
  // a locked-straight limb is one of the tells that reads as "simplified".
  //
  // The animator's ground solve does forward kinematics on the real bind offsets
  // (see `Animation._groundSolve`), so the set costs nothing in foot placement.
  elbowSet: 0.016,
  kneeSet: 0.014,
  thighX: 0.050,
  upperLeg: 0.545,     // femur:tibia ≈ 55:45, measured knee-to-crotch vs knee-to-ankle

  // Girths. Cross-sections read off the plate at the widest ring of each region
  // and halved; the adult male and the girl bracket every value, and the roster's
  // `chest`/`hip`/`limb` multipliers spread the cast back out across the bracket.
  neckR: 0.034,
  chestRX: 0.086, chestRZ: 0.062,
  waistR: 0.064,
  hipRX: 0.076, hipRZ: 0.060,
  armR: 0.031, elbowR: 0.025, wristR: 0.020,
  // The hand is an articulated form, not a mitten, so it is specified as a box
  // rather than as a radius: wrist-to-fingertip, across the knuckles, and
  // through the palm.
  //
  // Re-measured on the staff-mage's gloved right hand in `bravely01`, which
  // spans x 1145→1180 and y 555→600 on a 522-pixel figure: **0.067 H across the
  // knuckles and 0.086 H long**. The length was already right; the width was
  // 0.046 and is the reason the fingers did not read. Four fingers have to fit
  // across it, so a hand a third too narrow makes every finger a third too thin,
  // and at 0.0054 H a finger is under four pixels wide at battle distance —
  // below the threshold where an interior gap survives at all.
  //
  // 0.056 rather than the measured 0.067 because the plate's glove includes a
  // gauntlet flare that our `buildCuff` supplies separately; 0.056 is the hand
  // inside it, and it puts a finger at 5.3 px, which does read.
  handLen: 0.086, handWidth: 0.056, handThick: 0.036,
  thighR: 0.046, kneeR: 0.035, ankleR: 0.027,
  // The boot has to be visibly *wider than the ankle it caps* or the leg tube's
  // end cap pokes through and the character reads as a flat-cut stump. 0.070
  // gives a half-width of 0.035 against an ankle radius of 0.027: a 30% overhang
  // all the way round. The plate's plain shoe is 0.095–0.11 H long and the
  // knight's armoured sabaton 0.17 H — the roster's `foot` multiplier is what
  // separates them, so the base value sits at the unarmoured end.
  footLen: 0.118, footWidth: 0.070, footHeight: 0.052,
});

/** Fallback so a malformed `def` still produces a body rather than throwing. */
const FALLBACK_PROPORTIONS = Object.freeze({
  height: 1.16, headScale: 1, legLength: 1, shoulder: 1, chest: 1, hip: 1,
  limb: 1, arm: 1, hand: 1, foot: 1, eye: 1, eyeSpacing: 1, browAngle: 0,
  stance: 1,
});

const v3 = (x, y, z) => ({ x, y, z });
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const pw = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);

/**
 * The one definition of the skull surface, shared by every consumer.
 *
 * The head is a *profiled superellipsoid*: `eV` squares the vertical section
 * slightly and `profile(v)` narrows the jaw and swells the cranium. Three
 * separate places used to re-derive that shape — the mesh builder, the face
 * projector and the hair shell — and each got it a little different. The hair
 * shell in particular treated the head as a plain ellipsoid, so wherever
 * `profile` swelled the cranium past the shell's inner wall the *scalp erupted
 * through the hair*, which is the mottled "camo" blotching the review found on
 * every head in the cast. There is now exactly one function.
 *
 * `scale` offsets the surface radially about the head centre. The skull is
 * star-shaped about that point, so any `scale > 1` surface **strictly encloses**
 * it: that is the property that makes a hair shell provably incapable of
 * intersecting the scalp, rather than merely tuned not to.
 *
 * @param {object} head `metrics.head`
 * @param {number} theta azimuth; +Z (the face direction) is θ = π/2
 * @param {number} phi latitude in [-π/2, π/2]
 * @param {number} [scale=1] radial offset factor about the head centre
 * @param {{x:number,y:number,z:number}} [out]
 */
export function skullPoint(head, theta, phi, scale = 1, out = { x: 0, y: 0, z: 0 }) {
  const cr = pw(Math.cos(phi), head.eV) * head.profile(phi / Math.PI + 0.5) * scale;
  out.x = head.rx * cr * Math.cos(theta);
  out.y = head.center.y + head.ry * scale * pw(Math.sin(phi), head.eV);
  out.z = head.rz * cr * Math.sin(theta);
  return out;
}

/**
 * How far a point sits from the head centre, measured in skull radii.
 *
 * `1` is exactly on the scalp, `< 1` is buried inside it. Everything that has
 * to keep clear of the head — a hair lock, a beard clump, a collar — tests
 * against this rather than against a hand-written fraction of `head.rx`, which
 * is how locks ended up anchored *inside* the skull and surfacing through the
 * temple.
 *
 * The measure ignores `profile`, which swells the cranium by at most 4.5%; every
 * caller therefore carries a clearance of at least that much on top.
 */
export function skullDepth(head, x, y, z) {
  const dx = x / head.rx;
  const dy = (y - head.center.y) / head.ry;
  const dz = z / head.rz;
  return Math.hypot(dx, dy, dz);
}

/**
 * The hairline, as a function of azimuth — shared by the hair shell, the lock
 * clearance solver and the ear placement.
 *
 * A revolved shell over the skull covers the *face*, so its lower boundary has
 * to ride high across the forehead and drop away at the nape, exactly like a
 * real hairline. `theta` follows `skullPoint`'s convention, so `sin(theta)` is
 * +1 at the face and −1 at the nape.
 *
 * The blend is cubic in the front-facing fraction rather than linear: a linear
 * blend puts the hairline halfway down the cheek at the ears, which reads as a
 * swim cap — one of the specific things the review named.
 */
export function hairlinePhi(theta, frontPhi, backPhi, peak) {
  const f = Math.sin(theta);
  const t = (f + 1) * 0.5;
  const k = t * t * (3 - 2 * t);
  return backPhi + (frontPhi - backPhi) * k - peak * Math.max(0, f) ** 3;
}

/**
 * Resolve a definition's proportions into absolute body dimensions.
 *
 * The vertical solve is deliberately ordered so the *crown stays pinned to
 * `height`* no matter how the head or legs are retuned: the hips are placed
 * from `legLength`, the head is sized from `headScale`, and the torso simply
 * absorbs whatever gap is left. A shorter-legged, bigger-headed character is
 * therefore automatically shorter in the torso, which is exactly how real
 * super-deformed model sheets are drawn, and it means no combination of
 * roster values can produce a figure that is not its stated height.
 *
 * @param {object} def a roster entry (only `proportions`, `hair`, `cape`,
 *                     `weapon` are read)
 * @returns {object} frozen metric block consumed by `buildRig` and `CharacterFactory`
 */
export function computeMetrics(def = {}) {
  const p = { ...FALLBACK_PROPORTIONS, ...(def.proportions ?? {}) };
  const H = p.height;

  const headR = (H * F.headDiameter * p.headScale) * 0.5;
  const crownY = H;
  const headCY = crownY - headR;
  const chinY = headCY - headR;
  const neckY = chinY - F.neckGap * H;

  const hipY = H * F.hipY * p.legLength;
  const torso = Math.max(0.04 * H, neckY - hipY);
  const spineY = hipY + torso * F.spineT;
  const chestY = hipY + torso * F.chestT;
  const shoulderY = hipY + torso * F.shoulderT;

  const ankleY = H * F.ankleY;
  const legDrop = hipY - ankleY;
  const kneeY = ankleY + legDrop * (1 - F.upperLeg);
  const kneeZ = H * F.kneeSet;

  // Arms: splayed A-pose, offsets carried entirely in translation, with the
  // elbow set back off the shoulder→wrist line so the joint has a hinge plane.
  const sx = Math.sin(F.armSplay);
  const cy = Math.cos(F.armSplay);
  const upper = H * F.upperArm * p.arm;
  const fore = H * F.foreArm * p.arm;

  const shoulderX = H * F.shoulderX * p.shoulder;
  const armX = shoulderX + H * 0.016 * p.shoulder;
  const armY = shoulderY - H * 0.026;
  const elbowX = armX + upper * sx;
  const elbowY = armY - upper * cy;
  const elbowZ = -H * F.elbowSet;
  const wristX = elbowX + fore * sx;
  const wristY = elbowY - fore * cy;

  const thighX = H * F.thighX * p.hip;
  /**
   * Stance width, applied below the hip only.
   *
   * The hip sockets stay where the pelvis puts them and the knee and ankle
   * swing outward, so a wide stance is a *bowed* leg rather than a translated
   * one — which is the difference between Bramm reading as "a keg on bowed
   * legs" and reading as the same tube pair everyone else has, moved apart.
   * REFERENCE §1 gives the silhouette no facial or costume detail to work with
   * at eighty pixels, and the gap between two legs is one of the few interior
   * shapes that survives; six identical gaps is six identical figures.
   */
  const stance = p.stance ?? 1;

  /** Bind-pose world positions of the core skeleton. */
  const joints = {
    root: v3(0, 0, 0),
    hips: v3(0, hipY, 0),
    spine: v3(0, spineY, 0),
    chest: v3(0, chestY, 0),
    neck: v3(0, neckY, 0),
    head: v3(0, chinY + headR * 0.18, 0),

    shoulderL: v3(shoulderX, shoulderY, 0),
    armL: v3(armX, armY, 0),
    forearmL: v3(elbowX, elbowY, elbowZ),
    handL: v3(wristX, wristY, 0),

    shoulderR: v3(-shoulderX, shoulderY, 0),
    armR: v3(-armX, armY, 0),
    forearmR: v3(-elbowX, elbowY, elbowZ),
    handR: v3(-wristX, wristY, 0),

    thighL: v3(thighX, hipY - H * 0.012, 0),
    shinL: v3(thighX * 1.04 * stance, kneeY, kneeZ),
    footL: v3(thighX * 1.08 * stance, ankleY, 0),

    thighR: v3(-thighX, hipY - H * 0.012, 0),
    shinR: v3(-thighX * 1.04 * stance, kneeY, kneeZ),
    footR: v3(-thighX * 1.08 * stance, ankleY, 0),
  };

  const limb = p.limb;
  const girth = {
    neck: H * F.neckR * p.chest,
    chestX: H * F.chestRX * p.chest,
    chestZ: H * F.chestRZ * p.chest,
    waist: H * F.waistR * p.chest,
    hipX: H * F.hipRX * p.hip,
    hipZ: H * F.hipRZ * p.hip,
    arm: H * F.armR * limb,
    elbow: H * F.elbowR * limb,
    wrist: H * F.wristR * limb,
    // Retained under its old name because `buildCuff` and `LookdevScene` read
    // it: the palm's half-width, which is what "hand radius" always meant.
    hand: H * F.handWidth * 0.5 * p.hand,
    thigh: H * F.thighR * limb,
    knee: H * F.kneeR * limb,
    ankle: H * F.ankleR * limb,
  };

  const foot = {
    length: H * F.footLen * p.foot,
    width: H * F.footWidth * p.foot,
    height: H * F.footHeight * p.foot,
  };

  /**
   * The hand, as a form with a palm and five digits rather than as a radius.
   *
   * The plate shows gloved hands closed around a haft with the fingers visibly
   * separated — four across the front of the grip and a thumb opposed over
   * them. That is the difference between a character *holding* a weapon and a
   * weapon parented near a mitten, and it is legible at battle distance because
   * the finger gaps are the only interior detail on the whole limb.
   *
   * Proportions are the standard hand canon compressed toward the palm: the
   * knuckle line at 52% of hand length (a realistic hand is 55%), so the digits
   * stay chunky enough to survive the downscale.
   */
  const hand = {
    length: H * F.handLen * p.hand,
    width: H * F.handWidth * p.hand,
    thickness: H * F.handThick * p.hand,
  };
  hand.palm = hand.length * 0.52;
  hand.finger = hand.length - hand.palm;
  // Four fingers across the knuckle line with a gap between each: 4 × 2 r plus
  // three gaps of 0.42 r has to equal the hand's width, which puts r at 0.101 of
  // it. 0.128 overlaps the neighbours slightly on purpose — a real hand's
  // fingers touch at rest, and geometry that touches welds into one silhouette
  // with grooves in it, which is what survives a downscale. Separate tubes with
  // daylight between them do not; they alias into a comb.
  hand.fingerR = hand.width * 0.128;
  hand.thumbR = hand.width * 0.165;

  /**
   * The grip: one definition of where a held haft passes through a fist.
   *
   * This exists because two things have to agree about it and used to be
   * authored separately — the weapon socket in `buildChainMetrics` and the
   * fingers in `CharacterFactory.buildHand`. When they disagree by even a
   * finger radius the hand closes on empty air beside the haft, which is
   * precisely the "weapon floating near the hand" read the client rejected.
   *
   * `axis` points from the fingertips back past the wrist, i.e. roughly +Y, so
   * a weapon authored along +Y from a grip at the origin (`buildWeapon`'s
   * convention) runs up through the fist with no per-weapon correction. The
   * centre is pushed off the hand's own axis along the palm normal by half the
   * palm's thickness plus most of the haft radius, which is where the bore of a
   * closed fist actually is — inside the curled fingers, not on the bone.
   */
  const gripOf = (side) => {
    const sfx = side > 0 ? 'L' : 'R';
    const w = joints[`hand${sfx}`];
    const e = joints[`forearm${sfx}`];
    const len = Math.hypot(w.x - e.x, w.y - e.y, w.z - e.z) || 1;
    const u = { x: (w.x - e.x) / len, y: (w.y - e.y) / len, z: (w.z - e.z) / len };
    // Palm normal: +Z with the hand axis projected out, so the offset is exactly
    // perpendicular to the haft however the A-pose is splayed.
    const d = u.z;
    const n = { x: -u.x * d, y: -u.y * d, z: 1 - u.z * d };
    const nl = Math.hypot(n.x, n.y, n.z) || 1;
    const radius = hand.thickness * 0.46;
    const along = hand.palm * 0.56;
    const off = (hand.thickness * 0.5 + radius * 0.34) / nl;
    return Object.freeze({
      center: v3(
        w.x + u.x * along + n.x * off,
        w.y + u.y * along + n.y * off,
        w.z + u.z * along + n.z * off,
      ),
      axis: v3(-u.x, -u.y, -u.z),
      normal: v3(n.x / nl, n.y / nl, n.z / nl),
      radius,
    });
  };
  const grip = Object.freeze({ L: gripOf(1), R: gripOf(-1) });

  const head = {
    center: v3(0, headCY, 0),
    /**
     * The skull is **narrower than it is tall**, and the plate is unambiguous
     * about it. REFERENCE §1's "near-spherical, slightly wider than tall" is one
     * of the transcription errors the plates exist to correct.
     *
     * Measured on the hat-mage, the cleanest face in `bravely01.jpg`: chin at
     * y = 434, skull crown at y = 350, so 84 px tall; the visible skin runs
     * x = 636 → 690 in a three-quarter view with the far side under hair, which
     * puts the full skull between 58 and 62 px. That is a width-to-height ratio
     * of **0.69–0.74**. The staff-mage gives 0.70 by the same construction. It
     * is not a stylisation quirk either — a real head is 15 cm across and 23 cm
     * chin-to-crown, i.e. 0.65 — and anime widens it only a little.
     *
     * At `rx = 1.06 ry` the old skull was 45% wider than the plate's, which is
     * the direct cause of two of the client's complaints at once: the head read
     * as an oversized ball, and the shoulders read as narrow *because they were
     * being compared to it*. 0.80 sits at the generous end of the measured band
     * — the stylisation direction, and it leaves the face plate room.
     *
     * `rz` follows the skull's own aspect rather than the camera's: real head
     * depth is about 1.12 × its width, and the plate's three-quarter views show
     * that depth clearly in how far the cheek carries before the jaw turns.
     */
    rx: headR * 0.80,
    ry: headR,
    rz: headR * 0.90,
    radius: headR,
    chinY,
    crownY,
    /**
     * The skull is a *superellipsoid*, not an ellipsoid, and the exponent lives
     * here rather than in the mesh builder for one specific reason: the painted
     * face plate is projected onto the skull surface, and if the projector and
     * the mesh disagree about the surface by even half a millimetre the plate
     * sinks into the head and the face renders as fragments. There is exactly
     * one definition of the skull.
     */
    eV: 0.94,
    /**
     * Radial profile along the head's vertical parameter `v` in [0,1]
     * (0 = chin, 1 = crown): the jaw taper and the cranium swell.
     *
     * ### Why the jaw taper moved down and got harder
     *
     * The painted mouth lands at 0.79 of head height (`FACE_LAYOUT.mouthY`
     * resolved against the plate), so everything below `v ≈ 0.21` is bare
     * chin. The old taper spread a gentle 20% narrowing across the whole
     * bottom **third**, which meant the widest part of that blank region was
     * still 92% of full head width: the review's "large blank cream ovoid with
     * roughly 30% of head height below the mouth carrying zero information".
     * A blank region is only a defect if it is *big*, so the fix is to make it
     * small — 32% of narrowing packed into the bottom quarter, on a near-linear
     * curve so the cheek stays full right down to the mouth line and then the
     * silhouette turns in hard. That is a jaw with a chin under it rather than
     * the bottom of an egg, and it removes the dead mass without moving a
     * single painted feature.
     *
     * ### Why the cranium swell shrank
     *
     * `skullDepth` — which every hair, collar and cloth clearance in the
     * project is measured against — is a plain *ellipsoid* metric: it ignores
     * both `profile` and `eV`. So every clearance constant downstream is
     * optimistic by however much this function and the superellipse exponent
     * inflate the real surface, and at the old 4.5% swell the crown scalp sat
     * near 1.06 in that metric while the hair shell's inner wall floor was
     * 1.045 — i.e. the scalp could legitimately stand *outside* the hair over
     * the crown. Holding the swell to 2% keeps the true surface inside the
     * 1.045 the clearance solvers assume (2% swell × the ≤2.1% the `eV = 0.94`
     * superellipse adds ≈ 1.041), so the margins are honest rather than
     * nominal. The crown reads flatter for it, which is the direction
     * REFERENCE §1 wants anyway.
     */
    profile(v) {
      const jaw = 1 - Math.pow(clamp01((0.26 - v) / 0.26), 1.25) * 0.32;
      const cranium = 1 + Math.pow(clamp01((v - 0.52) / 0.28), 2) * 0.020;
      return jaw * cranium;
    },
  };

  // ------------------------------------------------------------- the face
  //
  // ANIME_PIPELINE §1 makes the face a **painted texture**, so the geometry's
  // entire job is to present a correctly placed, correctly scaled square for
  // `FaceTexture` to land on. That square is the "face plate" —
  // `CharacterFactory.buildFacePlate` projects it onto the skull.
  //
  // Two decisions here are what make the painting land where the painter meant
  // it to, and both are solved rather than authored:
  //
  //  - **The plate is square in world units.** `FaceTexture` draws into a square
  //    canvas and positions every feature as a fraction of it, so a plate with
  //    any other aspect stretches the eyes and nothing downstream can correct
  //    for it.
  //  - **The scale is solved from the skull's *width*, not its height.** It used
  //    to be a fixed 1.90 ry, which was safe only while the skull was wider than
  //    it was tall. It is not: the plate's head measures 0.80 wide for 1.00 tall
  //    (see `head.rx`), so a plate 0.95 ry to either side of the nose would have
  //    asked for an `x` a fifth past the temple — the texture's outer columns
  //    smeared down the side of the face, which is the exact defect
  //    `face.halfX`'s ceiling exists to make unreachable. Deriving the square
  //    from `rx` means the widest painted feature lands just inside the skull's
  //    own silhouette at *any* head aspect, which is where the plate's eyes sit.
  //  - **The vertical placement is solved from the layout table.**
  //    `FACE_LAYOUT.eyeY` puts the painted eye line 56% down the square, and
  //    that has to coincide with the anatomical eye line — so the plate's top
  //    edge is *derived* from the eye line, not guessed at. Retune either and
  //    they stay locked together.
  //
  // 2.28 rather than 2.00 so the square's outer 12% a side is blank margin: the
  // plate's own rim has to bury itself inside the skull, and it must do that in
  // texture the painter left empty.
  const faceSize = head.rx * 2.28;
  // 0.12 ry below the head's centre, which puts the painted pair **exactly 56%
  // of the way from crown to chin** — `FACE_LAYOUT.eyeY`'s number, measured on
  // the skull rather than on the texture.
  //
  // It used to be 0.17, i.e. 58.5%, on the reasoning that the plate overhangs
  // the crown a little. It does not: `face.top` is *derived* from this line, so
  // the overhang is a consequence of the offset rather than a correction to it,
  // and the two percent it bought was simply the eye line sitting low. At the
  // battle camera that reads as the face slipping down the skull.
  const eyeY = headCY - head.ry * 0.12;
  const face = {
    /** Edge of the square the face texture maps onto, in world units. */
    size: faceSize,
    /** World Y of the texture's top edge (v = 1) and bottom edge (v = 0). */
    top: eyeY + FACE_LAYOUT.eyeY * faceSize,
    /**
     * Stand-off from the skull, applied purely along **+Z**.
     *
     * Along the normal — which is what this used to do — the offset carries an
     * x and y component that shifts the plate's world position away from the
     * plate coordinate it was solved for, so the UV stops being an exact affine
     * function of position and the painted eye smears by a fraction of a
     * millimetre that grows toward the outer canthus. Along +Z the plate's `x`
     * and `y` are *identically* the texture coordinates, at any tessellation,
     * which is what makes the two eyes provably the same size and the same
     * height. It costs a cosine of the local slope in effective clearance, and
     * the flattening below has already made that slope small where it matters.
     */
    lift: headR * 0.016,
    /**
     * Plate extent. Deliberately *not* square, and **never past `size / 2`**.
     *
     * The face texture is square, but the region of skull that can carry it
     * without the projector running out of cross-section is not: the skull
     * narrows hard toward the chin, so a plate as tall as it is wide runs its
     * lower corners past the jaw's half-width, where the projection saturates
     * and the texture piles up into the smear the review saw as a "truncated"
     * eye. Capping the height at 0.88 ry and solving the width against the
     * *local* cross-section (see `CharacterFactory.buildFacePlate`) removes the
     * saturation entirely rather than tuning around it.
     *
     * The width ceiling is a separate and harder rule. `buildFacePlate` writes
     * `u = 0.5 + ox / size`, so a `halfX` above `size / 2` asks the sampler for
     * a `u` outside [0, 1]. At `ClampToEdge` that is a band of the texture's
     * outermost column smeared down each side of the face, which is the
     * "mask-like band" the review found; at any repeating wrap it would be a
     * second pair of eyes wrapped onto the temple.
     *
     * Both extents are therefore expressed against the *plate*, not against the
     * skull, and both sit strictly inside half of it: 0.95 rx is 0.417 of the
     * square, and 0.47 of the square is 0.94 of `size / 2`. No head aspect and
     * no roster value can push either past the edge, which is what makes the
     * texture clamp a backstop rather than the fix.
     */
    halfX: head.rx * 0.95,
    halfY: Math.min(head.ry * 0.88, faceSize * 0.47),
    /**
     * How far the plate is flattened toward a plane, 0–1.
     *
     * A face painted flat and wrapped onto a sphere foreshortens toward the
     * temples: across the eye pair the skull recedes about 0.19 head-radii, so
     * one eye compresses relative to the other the moment the head turns even
     * slightly — which is exactly the "different sizes at different heights"
     * the review measured. Anime 3D solves this with a deliberately flattened
     * face front (the "face shield"), and so do we: each row of the plate is
     * pulled 62% of the way toward the depth of its own centre column.
     *
     * The construction is bounded by design. The correction is zero on the
     * centreline and can never exceed the row's centre depth, so the plate is
     * incapable of breaking the head's profile silhouette no matter what the
     * proportions are.
     */
    flatten: 0.62,
    /** Radii (as a fraction of plate radius) over which the flattening fades. */
    flatFrom: 0.86,
    flatTo: 0.96,
    /**
     * Where the plate starts diving inside the skull, and by how much.
     *
     * The rim has to be *buried*, not merely coincident: a plate edge on the
     * silhouette prints a bright hard line across the cheek under the mandatory
     * rim light. Scaling the rim ring 8% toward the head centre puts it
     * unambiguously inside a star-shaped solid, so there is no tuning to get
     * wrong. Every painted feature sits inside r = 0.84 (measured across the
     * whole roster), so the dive never touches one.
     */
    buryFrom: 0.92,
    buryDepth: 0.08,
  };
  face.bottom = face.top - faceSize;
  face.centerY = face.top - faceSize * 0.5;

  // Where the painted features land, in world units.
  //
  // Nothing in this file draws them — `FaceTexture` does — but the hair builder
  // has to know: a fringe lock hanging through an eye is the one hair failure
  // that cannot be shaded away. Deriving the clearance from `FACE_LAYOUT`
  // rather than authoring it means no roster value and no retune of the painted
  // layout can put hair over the eyes.
  const eye = {
    y: eyeY,
    halfSpan: (0.5 - FACE_LAYOUT.eyeX) * faceSize * p.eyeSpacing,
    width: FACE_LAYOUT.eyeW * faceSize * p.eye,
    height: FACE_LAYOUT.eyeH * faceSize * p.eye,
    browAngle: p.browAngle,
  };
  // Top of the brow stroke: the eye's upper edge, plus the layout's clearance,
  // plus a half-thickness generous enough for the thickest brow the painter
  // draws (`FaceTexture` tops out near 0.072 of the square).
  eye.browTop = eye.y + eye.height * 0.5 + (FACE_LAYOUT.browGap + 0.045) * faceSize;

  // The region nothing is ever allowed to occlude: the painted eye envelope and
  // a small margin, and nothing else.
  //
  // Deliberately *not* the whole plate, and deliberately not up to the brow. A
  // fringe belongs in front of the forehead, a beard in front of the chin, and
  // an anime fringe routinely crosses the outer corner of the eye — a guard
  // covering those would flatten all three back into the skull and produce a
  // bald forehead. What cannot happen, at any tessellation or proportion, is
  // hair in front of the iris, which is the whole face (REFERENCE §1).
  face.guardTop = eye.y + eye.height * 0.52;
  face.guardBottom = eye.y - eye.height * 0.58;
  /** Half-width of the protected column: the iris pair plus a margin. */
  face.guardX = eye.halfSpan + eye.width * 0.34;

  // ---------------------------------------------------- hairline and ears
  //
  // The hairline is solved here, once, because three consumers need the *same*
  // curve: the hair shell is bounded by it, the lock-clearance solver switches
  // its minimum radius across it, and the ears have to sit below it or they
  // erupt through the hair. Previously only the shell knew where it was.
  const hp = def.hair ?? {};
  const hairline = {
    // Pinned to the painted brow, never authored: clearance above the brow is
    // 7% of a head radius — enough that the shell never touches the stroke,
    // tight enough that no band of bare forehead opens up under it.
    frontPhi: Math.asin(clamp(
      (eye.browTop + head.ry * 0.07 - headCY) / head.ry, -0.98, 0.98,
    )),
    backPhi: -(0.32 + (hp.capDrop ?? 0.5) * 0.95),
    peak: 0.10,
  };
  /** Latitude of the hairline at the ears (θ = 0, the pure side). */
  hairline.earPhi = hairlinePhi(0, hairline.frontPhi, hairline.backPhi, hairline.peak);

  // Ears: small nubs whose only job is to stop the head silhouetting as a
  // perfect circle. They must sit **entirely below the hairline** — an ear that
  // pokes above it punches through the hair shell and mottles the temple, which
  // is half of the blotching the review reported. Solving the top edge from
  // `earPhi` rather than from a fixed fraction of `ry` means no `capDrop` in the
  // roster can reintroduce the defect.
  const earR = head.ry * 0.155;
  const earTop = head.ry * pw(Math.sin(hairline.earPhi), head.eV);
  const ear = {
    cx: head.rx * 0.93,
    cy: headCY + earTop - earR * 1.30,
    cz: -head.rz * 0.06,
    rx: head.rx * 0.17,
    ry: earR,
    rz: head.rz * 0.10,
  };

  return Object.freeze({
    height: H,
    proportions: p,
    joints,
    girth,
    foot,
    hand,
    grip,
    head,
    ear,
    hairline: Object.freeze(hairline),
    eye,
    face,
    // True 3D segment lengths, not the vertical drops they used to be. The
    // elbow and knee are set off their chords now, so `legDrop × upperLeg`
    // under-reports the femur by about 0.3% — small, but it is the number the
    // animator's ground solve and every limb sweep measure themselves against,
    // and there is no reason for it to be an approximation.
    segments: {
      upperArm: dist(joints.armL, joints.forearmL),
      foreArm: dist(joints.forearmL, joints.handL),
      thigh: dist(joints.thighL, joints.shinL),
      shin: dist(joints.shinL, joints.footL),
      torso,
    },
    chains: buildChainMetrics(def, { head, joints, girth, grip, H }),
  });
}

/**
 * Positions for the optional chains — hair, cape and the weapon socket.
 *
 * These are laid out as *world-space polylines* rather than as local offsets
 * because the cloth solver in `Cloth.js` works in world space and needs the
 * rest direction of each link to convert a solved particle position back into
 * a bone rotation. Producing them here keeps the rest lengths and the bone
 * offsets from ever disagreeing.
 */
function buildChainMetrics(def, { head, joints, girth, grip, H }) {
  const chains = { hair: [], cape: [], weapon: null };

  const hair = def.hair ?? {};
  const hairCount = hair.boneCount | 0;
  if (hairCount > 0) {
    // Anchored *outside* the hair shell, not on the skull.
    //
    // The previous anchor at -0.72 rz sat inside the skull volume, so the swept
    // tail geometry bound to it started life buried in the head and emerged
    // through the temple — the "hair ribbons pass straight through the skull"
    // defect. `capScale` is the hair shell's outer radius multiplier, so
    // clearing it by a further 6% guarantees the first link of every chain
    // begins in open air behind the nape regardless of style.
    const shell = Math.max(hair.capScale ?? 1.08, 1.10) * 1.08;
    const start = v3(0, head.center.y + head.ry * 0.22, -head.rz * shell);
    // A braided style keeps a short `backLength` for the mass at the nape *and*
    // a long `braidLength` for the plait itself; the chain must measure the
    // plait, so the braid wins wherever both are present.
    //
    // Measured in **head diameters**, matching every other hair length in the
    // system. Hair is a function of the skull it grows on: the same fraction of
    // body height gives Emrys (head 0.32 of height) and Yshara (0.28) visibly
    // different-looking hair for no authored reason.
    const total = (hair.braidLength ?? hair.backLength ?? 1.2) * head.ry * 2;
    const step = total / hairCount;
    chains.hair.push(start);
    for (let i = 1; i <= hairCount; i++) {
      const t = i / hairCount;
      chains.hair.push(v3(
        0,
        start.y - step * i * (0.86 + 0.14 * t),
        start.z - step * i * 0.30 * (1 - t * 0.5),
      ));
    }
  }

  const cape = def.cape ?? {};
  const capeCount = cape.boneCount | 0;
  if (capeCount > 0) {
    const start = v3(0, joints.chest.y + girth.chestZ * 0.25, -girth.chestZ * 0.95);
    const total = (cape.length ?? 0.35) * H;
    const step = total / capeCount;
    chains.cape.push(start);
    for (let i = 1; i <= capeCount; i++) {
      chains.cape.push(v3(0, start.y - step * i, start.z - step * i * 0.16));
    }
  }

  const weapon = def.weapon ?? null;
  if (weapon) {
    const mount = weapon.mount ?? 'handR';
    // The socket is the *bore of the fist*, solved once in `computeMetrics`, not
    // a hand-authored offset from the wrist. That is what puts the haft between
    // the fingers and the thumb instead of beside them.
    const held = (sfx) => {
      const w = joints[`hand${sfx}`];
      const g = grip[sfx];
      return { parent: `hand${sfx}`, position: v3(g.center.x - w.x, g.center.y - w.y, g.center.z - w.z) };
    };
    if (mount === 'back') {
      chains.weapon = { parent: 'chest', position: v3(0, girth.chestZ * 0.6, -girth.chestZ * 1.25) };
    } else if (mount === 'handL' || mount === 'handR') {
      chains.weapon = held(mount.endsWith('L') ? 'L' : 'R');
    } else if (joints[mount]) {
      // A weapon socketed on a limb rather than held — Bramm's forearm piston.
      // Measured off the *limb*, not off `girth.hand`: the mount has to clear the
      // surface it is strapped to, and the hand is on the other end of it.
      chains.weapon = { parent: mount, position: v3(0, -girth.wrist * 0.4, girth.elbow * 1.35) };
    } else {
      chains.weapon = held('R');
    }
  }

  return chains;
}

/**
 * Build the skeleton for a character definition.
 *
 * @param {object} def roster entry
 * @param {object} [metrics] precomputed metric block (avoids recomputing it
 *                 when the caller already has one)
 * @returns {{root: THREE.Bone, bones: Record<string, THREE.Bone>,
 *            order: string[], skeleton: THREE.Skeleton, metrics: object,
 *            rest: Record<string, {position: THREE.Vector3, quaternion: THREE.Quaternion}>}}
 */
export function buildRig(def, metrics = computeMetrics(def)) {
  const bones = {};
  const order = [];
  const worldOf = {};

  const add = (name, parentName, world) => {
    const bone = new THREE.Bone();
    bone.name = name;
    const parent = parentName ? bones[parentName] : null;
    const pw = parentName ? worldOf[parentName] : { x: 0, y: 0, z: 0 };
    bone.position.set(world.x - pw.x, world.y - pw.y, world.z - pw.z);
    if (parent) parent.add(bone);
    bones[name] = bone;
    worldOf[name] = world;
    order.push(name);
    return bone;
  };

  for (const name of BONE_NAMES) add(name, BONE_PARENTS[name], metrics.joints[name]);

  // --- optional chains ---------------------------------------------------
  const hairPts = metrics.chains.hair;
  for (let i = 1; i < hairPts.length; i++) {
    add(`hair${i - 1}`, i === 1 ? 'head' : `hair${i - 2}`, hairPts[i]);
  }
  const capePts = metrics.chains.cape;
  for (let i = 1; i < capePts.length; i++) {
    add(`cape${i - 1}`, i === 1 ? 'chest' : `cape${i - 2}`, capePts[i]);
  }
  const w = metrics.chains.weapon;
  if (w) {
    const anchor = worldOf[w.parent] ?? worldOf.handR;
    add('weapon', w.parent, v3(anchor.x + w.position.x, anchor.y + w.position.y, anchor.z + w.position.z));
  }

  const root = bones.root;
  // Inverses are captured here, with the rig sitting at the origin. Anything
  // that moves the character afterwards moves bones and mesh together, and
  // AttachedBindMode cancels the duplicate transform on the mesh side.
  root.updateMatrixWorld(true);

  const boneList = order.map((n) => bones[n]);
  const skeleton = new THREE.Skeleton(boneList);

  const rest = {};
  for (const name of order) {
    rest[name] = {
      position: bones[name].position.clone(),
      quaternion: bones[name].quaternion.clone(),
      /** Bind-pose world position — the cloth solver's rest reference. */
      world: new THREE.Vector3(worldOf[name].x, worldOf[name].y, worldOf[name].z),
    };
  }

  return { root, bones, order, skeleton, metrics, rest };
}

/**
 * The bone segments used for analytic skinning, as `{ index, a, b, sigma }`.
 *
 * `sigma` is the falloff radius of that segment's influence. `CharacterFactory`
 * weights a vertex by `exp(-(d/sigma)²)` on the perpendicular distance to the
 * segment, clamped along it — so past a joint the weight decays as
 * `exp(-(s/sigma)²)` in the axial overshoot `s`, and **sigma is therefore the
 * half-width of the blend zone across that joint**, not a vague "influence".
 * Everything below follows from reading it that way.
 *
 * ## Why the limb sigmas came down from 1.4–1.5 r to 1.15 r
 *
 * At 1.5 r the blend across an elbow was three limb-diameters wide, which is
 * most of the forearm. Linear blend skinning shrinks a cross-section by roughly
 * `cos(θ/2)` wherever two bones share it evenly, so a wide blend does not
 * *reduce* the pinch — it smears a 30% volume loss along the whole segment and
 * the limb reads as boneless rubber, which is exactly the "too simplified" the
 * client saw. At 1.15 r the loss is confined to about one diameter either side
 * of the joint, where `CharacterFactory` now puts an explicit elbow and knee
 * ball to fill it. Crease where the anatomy creases; hold volume elsewhere.
 *
 * ## Why the torso sigmas stay generous
 *
 * A trunk is one continuous mass and any visible band across it reads as a
 * modelling error, so hips/spine/chest keep a blend as wide as they are thick.
 *
 * ## `sigmaScale`
 *
 * Garments hang *off* the body — a coat panel can sit an inch clear of the leg
 * that should drive it — so they are solved against the same segments widened
 * uniformly. Without it every vertex past the body's own falloff drops through
 * to the solver's nearest-bone fallback and binds rigidly, which is how a
 * swinging coat tail ends up moving in stair-steps.
 *
 * @param {object} rig result of {@link buildRig}
 * @param {number} [sigmaScale=1] uniform widening of every falloff
 * @returns {Array<{index:number, name:string, a:THREE.Vector3, b:THREE.Vector3, sigma:number}>}
 */
export function skinSegments(rig, sigmaScale = 1) {
  const { metrics, order, rest } = rig;
  const g = metrics.girth;
  const hand = metrics.hand;
  const H = metrics.height;

  // name -> [tip position, blend half-width]. A segment runs from the bone to
  // its "tip"; leaf bones get a synthetic tip along their natural extension so
  // hands and feet still have an axis rather than collapsing to a point.
  const J = metrics.joints;
  const tips = {
    hips: [J.spine, g.hipX * 1.30],
    spine: [J.chest, g.waist * 1.45],
    chest: [J.neck, g.chestX * 1.30],
    neck: [J.head, g.neck * 2.0],
    head: [{ x: 0, y: metrics.head.crownY, z: 0 }, metrics.head.rx * 1.7],

    // The shoulder gets the *same* 1.15 rule as every other joint, and this is
    // the one that used to be wrong by the largest margin. `shoulderL → armL` is
    // a stub about one arm-radius long, so a sigma of 1.9 r reached the better
    // part of the way down the humerus: the whole upper arm was blended roughly
    // evenly between a bone that moves with the arm and a bone that moves with
    // the chest, and lifting the arm sheared it flat. Measured, the surface kept
    // 2–34% of its width at 90°; at 1.15 r it keeps 88–96%. The deltoid mass
    // that genuinely wants a wide blend is a separate surface bound across
    // `chest`, `shoulder` and `arm`, which is where that blend belongs.
    shoulderL: [J.armL, g.arm * 1.15], shoulderR: [J.armR, g.arm * 1.15],
    armL: [J.forearmL, g.arm * 1.15], armR: [J.forearmR, g.arm * 1.15],
    forearmL: [J.handL, g.elbow * 1.15], forearmR: [J.handR, g.elbow * 1.15],
    // The hand's axis now runs to the knuckle line rather than to a synthetic
    // point past the wrist, because there is a palm there to own. The fingers
    // beyond it are inside `hand.width` of that axis and follow it rigidly,
    // which is what a closed grip does.
    handL: [extend(J.forearmL, J.handL, hand.palm), hand.width * 0.80],
    handR: [extend(J.forearmR, J.handR, hand.palm), hand.width * 0.80],

    thighL: [J.shinL, g.thigh * 1.15], thighR: [J.shinR, g.thigh * 1.15],
    shinL: [J.footL, g.knee * 1.15], shinR: [J.footR, g.knee * 1.15],
    footL: [{ x: J.footL.x, y: J.footL.y * 0.4, z: J.footL.z + metrics.foot.length * 0.55 }, metrics.foot.width * 1.3],
    footR: [{ x: J.footR.x, y: J.footR.y * 0.4, z: J.footR.z + metrics.foot.length * 0.55 }, metrics.foot.width * 1.3],
  };

  const out = [];
  const floor = H * 0.012;
  for (let i = 0; i < order.length; i++) {
    const name = order[i];
    const spec = tips[name];
    if (!spec) continue; // root, hair*, cape* and weapon are bound explicitly.
    const a = rest[name].world;
    const b = new THREE.Vector3(spec[0].x, spec[0].y, spec[0].z);
    out.push({ index: i, name, a, b, sigma: Math.max(spec[1], floor) * sigmaScale });
  }
  return out;
}

/** Extend the a→b direction past b by `dist`, for synthetic leaf-bone tips. */
function extend(a, b, dist) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  return { x: b.x + (dx / len) * dist, y: b.y + (dy / len) * dist, z: b.z + (dz / len) * dist };
}
