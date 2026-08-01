/**
 * Rig.js — chibi skeleton construction and the body metric that everything
 * else in `src/characters` measures itself against.
 *
 * The bone names are fixed by ARCHITECTURE.md and are not negotiable:
 * `root, hips, spine, chest, neck, head, shoulderL/R, armL/R, forearmL/R,
 * handL/R, thighL/R, shinL/R, footL/R`, plus optional `hair0..n`, `cape0..n`
 * and `weapon`. The *proportions* however are the ones from REFERENCE_TARGET
 * §1 — super-deformed, ~3.1 heads tall — not a realistic humanoid.
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
 * Chibi station table — every value a fraction of total height H.
 *
 * These are the numbers REFERENCE_TARGET §1 constrains, transcribed once:
 * head diameter 0.32 H puts the figure at 3.1 heads; the head *mass* including
 * hair lands near 0.38 H, which is the "35–40% of total height" the reference
 * reports (it measures the silhouette, not the skull). The hips at 0.385 H
 * give a leg that is barely a third of the body — the single strongest chibi
 * cue, and the one most often got wrong by scaling a realistic rig down.
 */
const F = Object.freeze({
  // 0.295 rather than 0.32. The silhouette head *mass* — what a critic actually
  // measures — is the skull plus the hair shell plus whatever the style piles on
  // top, not the skull alone. At 0.32 the measured figure came out near 2.4
  // heads, i.e. a head mass of ~42% of height, outside REFERENCE_TARGET §1's
  // 35–40% band and well under its 3.0–3.5 heads. Dropping the skull to 0.295
  // and capping the hair shell's swell (see `CharacterFactory.buildHair`) puts
  // the measured mass at ~0.34 H, which is 2.95–3.1 heads depending on style.
  headDiameter: 0.295,
  hipY: 0.400,
  neckGap: 0.020,      // chin to neck joint; the neck is nearly hidden
  spineT: 0.30,        // fraction of the hips→neck span
  chestT: 0.66,
  shoulderT: 0.80,
  ankleY: 0.046,

  shoulderX: 0.098,
  armSplay: 0.244,     // radians off vertical for the A-pose (~14°)
  upperArm: 0.115,
  foreArm: 0.105,
  thighX: 0.058,
  upperLeg: 0.520,     // fraction of the hips→ankle drop consumed by the thigh

  neckR: 0.052,
  chestRX: 0.118, chestRZ: 0.088,
  waistR: 0.096,
  hipRX: 0.114, hipRZ: 0.092,
  armR: 0.042, elbowR: 0.036, wristR: 0.029,
  handR: 0.058,
  thighR: 0.058, kneeR: 0.050, ankleR: 0.042,
  // The boot has to be visibly *wider than the ankle it caps* or the leg tube's
  // end cap pokes through and the character reads as a flat-cut stump — the
  // single clearest tell of an unfinished proxy. `footWidth * 0.5` is the boot's
  // half-width in `CharacterFactory.buildBoot`, so 0.104 gives 0.052 against an
  // ankle radius of 0.042: a 24% overhang all the way round.
  footLen: 0.158, footWidth: 0.104, footHeight: 0.074,
});

/** Fallback so a malformed `def` still produces a body rather than throwing. */
const FALLBACK_PROPORTIONS = Object.freeze({
  height: 1.16, headScale: 1, legLength: 1, shoulder: 1, chest: 1, hip: 1,
  limb: 1, arm: 1, hand: 1, foot: 1, eye: 1, eyeSpacing: 1, browAngle: 0,
});

const v3 = (x, y, z) => ({ x, y, z });
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

  // Arms: splayed A-pose, offsets carried entirely in translation.
  const sx = Math.sin(F.armSplay);
  const cy = Math.cos(F.armSplay);
  const upper = H * F.upperArm * p.arm;
  const fore = H * F.foreArm * p.arm;

  const shoulderX = H * F.shoulderX * p.shoulder;
  const armX = shoulderX + H * 0.020 * p.shoulder;
  const armY = shoulderY - H * 0.034;
  const elbowX = armX + upper * sx;
  const elbowY = armY - upper * cy;
  const wristX = elbowX + fore * sx;
  const wristY = elbowY - fore * cy;

  const thighX = H * F.thighX * p.hip;

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
    forearmL: v3(elbowX, elbowY, 0),
    handL: v3(wristX, wristY, 0),

    shoulderR: v3(-shoulderX, shoulderY, 0),
    armR: v3(-armX, armY, 0),
    forearmR: v3(-elbowX, elbowY, 0),
    handR: v3(-wristX, wristY, 0),

    thighL: v3(thighX, hipY - H * 0.012, 0),
    shinL: v3(thighX * 1.04, kneeY, 0),
    footL: v3(thighX * 1.08, ankleY, 0),

    thighR: v3(-thighX, hipY - H * 0.012, 0),
    shinR: v3(-thighX * 1.04, kneeY, 0),
    footR: v3(-thighX * 1.08, ankleY, 0),
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
    hand: H * F.handR * p.hand,
    thigh: H * F.thighR * limb,
    knee: H * F.kneeR * limb,
    ankle: H * F.ankleR * limb,
  };

  const foot = {
    length: H * F.footLen * p.foot,
    width: H * F.footWidth * p.foot,
    height: H * F.footHeight * p.foot,
  };

  const head = {
    center: v3(0, headCY, 0),
    // Slightly wider than tall, slightly shallow front-to-back: REFERENCE
    // §1 calls the head "near-spherical, slightly wider than tall", and the
    // shallow Z is what keeps a 3/4 battle-camera view from reading as a ball.
    rx: headR * 1.06,
    ry: headR,
    rz: headR * 0.97,
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
     * (0 = chin, 1 = crown). Narrows the lower third into a jaw and widens the
     * upper middle into a cranium; both are small, because REFERENCE §1 wants
     * "near-spherical", but without them the head is a ball and the character
     * reads as a doll rather than as a person drawn small.
     */
    profile(v) {
      const jaw = 1 - Math.pow(clamp01((0.34 - v) / 0.34), 1.6) * 0.20;
      const cranium = 1 + Math.pow(clamp01((v - 0.55) / 0.30), 2) * 0.045;
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
  //    for it. Height sets the scale: 1.90 head-radii runs from just below the
  //    crown to just past the chin, which is the region a drawn face occupies.
  //  - **The vertical placement is solved from the layout table.**
  //    `FACE_LAYOUT.eyeY` puts the painted eye line 56% down the square, and
  //    that has to coincide with the anatomical eye line — so the plate's top
  //    edge is *derived* from the eye line, not guessed at. Retune either and
  //    they stay locked together.
  const faceSize = head.ry * 1.90;
  // 0.17 ry below the head's centre. Eyes sit low on a chibi skull — the
  // convention that reads as "young" — and this places the pair 58.5% of the
  // way from crown to chin, which is what `FACE_LAYOUT.eyeY`'s 0.56 is aiming
  // at once the plate's small overhang above the crown is accounted for.
  const eyeY = headCY - head.ry * 0.17;
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
     * Plate extent. Deliberately *not* square.
     *
     * The face texture is square, but the region of skull that can carry it
     * without the projector running out of cross-section is not: the skull
     * narrows hard toward the chin, so a plate as tall as it is wide runs its
     * lower corners past the jaw's half-width, where the projection's `acos`
     * saturates and the texture piles up into the smear the review saw as a
     * "truncated" eye. Capping the height at 0.88 ry and solving the width
     * against the *local* cross-section (see `CharacterFactory.buildFacePlate`)
     * removes the saturation entirely rather than tuning around it.
     */
    halfX: head.ry * 0.98,
    halfY: head.ry * 0.88,
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
    head,
    ear,
    hairline: Object.freeze(hairline),
    eye,
    face,
    segments: {
      upperArm: upper, foreArm: fore,
      thigh: legDrop * F.upperLeg, shin: legDrop * (1 - F.upperLeg),
      torso,
    },
    chains: buildChainMetrics(def, { head, joints, girth, H }),
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
function buildChainMetrics(def, { head, joints, girth, H }) {
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
    if (mount === 'back') {
      chains.weapon = { parent: 'chest', position: v3(0, girth.chestZ * 0.6, -girth.chestZ * 1.25) };
    } else if (joints[mount]) {
      chains.weapon = { parent: mount, position: v3(0, -girth.hand * 0.10, girth.hand * 0.35) };
    } else {
      chains.weapon = { parent: 'handR', position: v3(0, 0, girth.hand * 0.35) };
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
 * `sigma` is the falloff radius of that segment's influence and is derived from
 * the limb's own girth rather than being a constant: a fat thigh must capture
 * vertices further from its axis than a wrist does, or the wrist steals the
 * forearm's surface and the elbow shears. Torso segments get a deliberately
 * generous sigma so the chest/spine/hips blend is soft — a chibi torso is one
 * continuous mass and any visible banding across it reads as a modelling error.
 *
 * @param {object} rig result of {@link buildRig}
 * @returns {Array<{index:number, name:string, a:THREE.Vector3, b:THREE.Vector3, sigma:number}>}
 */
export function skinSegments(rig) {
  const { metrics, order, rest } = rig;
  const g = metrics.girth;
  const H = metrics.height;

  // name -> [tip position, influence radius]. A segment runs from the bone to
  // its "tip"; leaf bones get a synthetic tip along their natural extension so
  // hands and feet still have an axis rather than collapsing to a point.
  const J = metrics.joints;
  const tips = {
    hips: [J.spine, g.hipX * 1.35],
    spine: [J.chest, g.waist * 1.5],
    chest: [J.neck, g.chestX * 1.35],
    neck: [J.head, g.neck * 2.2],
    head: [{ x: 0, y: metrics.head.crownY, z: 0 }, metrics.head.rx * 1.6],

    shoulderL: [J.armL, g.arm * 2.0], shoulderR: [J.armR, g.arm * 2.0],
    armL: [J.forearmL, g.arm * 1.5], armR: [J.forearmR, g.arm * 1.5],
    forearmL: [J.handL, g.elbow * 1.5], forearmR: [J.handR, g.elbow * 1.5],
    handL: [extend(J.forearmL, J.handL, g.hand * 1.6), g.hand * 1.7],
    handR: [extend(J.forearmR, J.handR, g.hand * 1.6), g.hand * 1.7],

    thighL: [J.shinL, g.thigh * 1.5], thighR: [J.shinR, g.thigh * 1.5],
    shinL: [J.footL, g.knee * 1.4], shinR: [J.footR, g.knee * 1.4],
    footL: [{ x: J.footL.x, y: J.footL.y * 0.4, z: J.footL.z + metrics.foot.length * 0.55 }, metrics.foot.width * 1.5],
    footR: [{ x: J.footR.x, y: J.footR.y * 0.4, z: J.footR.z + metrics.foot.length * 0.55 }, metrics.foot.width * 1.5],
  };

  const out = [];
  for (let i = 0; i < order.length; i++) {
    const name = order[i];
    const spec = tips[name];
    if (!spec) continue; // root, hair*, cape* and weapon are bound explicitly.
    const a = rest[name].world;
    const b = new THREE.Vector3(spec[0].x, spec[0].y, spec[0].z);
    out.push({ index: i, name, a, b, sigma: Math.max(spec[1], H * 0.02) });
  }
  return out;
}

/** Extend the a→b direction past b by `dist`, for synthetic leaf-bone tips. */
function extend(a, b, dist) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  return { x: b.x + (dx / len) * dist, y: b.y + (dy / len) * dist, z: b.z + (dz / len) * dist };
}
