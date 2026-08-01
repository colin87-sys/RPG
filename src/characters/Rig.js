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
     * here rather than in the mesh builder for one specific reason: the face
     * decals (eyes, brows, mouth) are projected onto the skull surface, and if
     * the projector and the mesh disagree about the surface by even half a
     * millimetre the decals sink into the head and the character renders with
     * partial rings for eyes. There is exactly one definition of the skull.
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

  // Face layout. Eyes sit low on the face — the chibi convention that reads as
  // "young" — and their size is the loudest single knob in the whole system.
  //
  // REFERENCE_TARGET §1: "very large, high-contrast eyes [...] occupying much of
  // the face". A pair at this width spans 1.38 head-radii of a 2.0-radius face,
  // i.e. 69% of the visible face width is eye — which is what makes the read
  // survive at 80 px, where the entire head is 30 px across.
  const eye = {
    halfSpan: head.rx * 0.42 * p.eyeSpacing,
    y: headCY - head.ry * 0.16,
    width: head.rx * 0.54 * p.eye,
    height: head.ry * 0.62 * p.eye,
    browLift: head.ry * 0.42,
    browAngle: p.browAngle,
    browThickness: head.ry * 0.085,
    /**
     * Base stand-off of the face decal stack from the skull, and the spacing
     * between its layers.
     *
     * These are not arbitrary: the eye is five coplanar-ish sheets (outline,
     * sclera, iris, pupil, catch-light) and the mobile ones are a *rigid* mesh
     * on the head bone while the outline is *skinned*, so under a neck bend the
     * two surfaces separate slightly. A gap of 0.9% of a head radius is under a
     * pixel at battle distance, comfortably past depth-buffer precision at
     * closeup range, and small enough that the eye still reads as painted on
     * rather than as a stack of floating discs.
     */
    lift: headR * 0.016,
    layerGap: headR * 0.009,
  };

  return Object.freeze({
    height: H,
    proportions: p,
    joints,
    girth,
    foot,
    head,
    eye,
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
    const shell = (hair.capScale ?? 1.08) * 1.06;
    const start = v3(0, head.center.y + head.ry * 0.22, -head.rz * shell);
    // A braided style keeps a short `backLength` for the mass at the nape *and*
    // a long `braidLength` for the plait itself; the chain must measure the
    // plait, so the braid wins wherever both are present.
    const total = (hair.braidLength ?? hair.backLength ?? 0.4) * H;
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
