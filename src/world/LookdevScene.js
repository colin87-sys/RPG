/**
 * LookdevScene — the calibration stage *and* the battle stage.
 *
 * Two jobs in one scene, deliberately, because they have to agree:
 *
 *  1. **Calibration bay**: the roughness/metalness sphere grid, the named-
 *     material bar and the chibi scale proxy. If the game looks wrong, this
 *     tells you which layer is lying — sky, probe, lighting rig, texture
 *     pipeline or post chain.
 *  2. **Battle stage**: the six roster characters staged as
 *     `docs/reference/bravely01.jpg` stages its party — a loose line across the
 *     middle of frame in a bright, sharp, sunlit flower meadow.
 *
 * The two never share a framing, and the constraint runs one way: the bay is
 * parked far to the south-west, *behind* every stage camera's station point,
 * so composition is never negotiated against it.
 *
 * ## What changed against the prose specs, and why
 *
 * `REFERENCE_TARGET.md` §2/§3 and `ANIME_PIPELINE.md` describe this frame as a
 * staggered diagonal on the right, facing a dramatically larger enemy mass on
 * the left, in a dark misty landscape whose background elements are near
 * silhouettes. **The plate is none of those things**, and the plate wins:
 *
 *  - There is **no enemy in frame**. The party addresses something off the
 *    right edge; the read is four (here six) figures and the meadow they stand
 *    in. The husk creature this stage used to carry was the largest single
 *    departure from the reference and is gone with the rest of the fiction it
 *    served.
 *  - The line runs **across the frame**, not along a diagonal into one corner,
 *    and the camera sits at roughly the cast's own eye height. That is what
 *    puts every head on a near-level line and every pair of feet on a *staggered*
 *    one — measured on the plate, the four heads span y≈280–330 of 1080 while
 *    the feet span y≈745–870.
 *  - The nearest figure occupies **39% of frame height** (knight, y326→y745),
 *    not the 23–30% §2 specifies, and the run recedes to ~25% at the back.
 *  - There is **no mist and no aerial perspective worth the name**: individual
 *    lavender florets resolve at the far edge of the bed. The mist bank and the
 *    3× fog multiplier both went with it.
 *  - The light is a **high, warm, front-left key under a blue sky**, not a
 *    low dusk contre-jour.
 *
 * The camera looks down -Z with no yaw, so screen-right is world +X and the
 * line is solvable on paper instead of by nudging. Slots are authored as
 * (screen x, depth along the view axis) and converted to world coordinates by
 * `stagePlacement`, which is what keeps every figure's *frame height* — the
 * number actually measured off the plate — under authorial control rather than
 * emergent from hand-placed metres.
 *
 * OWNED BY: integration. Foundation modules are validated here before they
 * are wired into FieldScene or BattleScene.
 */
import * as THREE from 'three';
import { Scene } from '../core/Engine.js';
import { gameState, Rng } from '../core/GameState.js';
import { Sky } from '../render/Sky.js';
import { Lighting } from '../render/Lighting.js';
import { buildCharacter } from '../characters/CharacterFactory.js';
import { LIGHT } from '../art/Palette.js';
import { makeNoise, smootherstep } from '../art/noise.js';
import {
  buildGrassField, buildLavender, buildTulips, buildBlossomTree,
  buildConiferTree, buildBoulderCluster, buildFlowerPatch,
  updateFlora, setFloraWind, FLORA_PALETTE,
} from './Flora.js';

/**
 * Stage frame — solved against `bravely01.jpg` rather than against the prose.
 *
 * Every number here is a composition constraint, and each is derived from a
 * measurement on the plate rather than chosen:
 *
 *  - `camY` **1.24 m** against a 1.00–1.19 m cast, i.e. a shade above the tallest
 *    crown. This is the single most important number in the file. On the plate
 *    the four heads sit within 50 px of each other while the four pairs of feet
 *    span 125 px, and there is exactly one camera height that does that: eye
 *    level. Below it heads fan out and feet converge; well above it the frame
 *    becomes the map-view this stage used to ship.
 *  - `pitch` **9°** down. For a level-rolled camera the horizon's NDC height is
 *    `tan(pitch) / tan(fov/2)` = 0.435, i.e. 28% down from the top edge, which
 *    is where the meadow's far bank crests on the plate once the bank's own
 *    rise is added (see `groundHeight`). "Only a slight downward tilt" is a
 *    statement about this number and it is deliberately half what the old
 *    diagonal staging needed.
 *  - `fov` **40°**. The plate's line is visibly compressed — the far figures are
 *    barely smaller than the near ones — and a 48° lens over the same depth run
 *    shrinks the back of the line by half again as much.
 *  - `camX` **0**, because the line is now centred in frame instead of pushed
 *    into one half of it.
 *
 * Note the invariant those first two imply: the world *width* available to the
 * line is fixed once the nearest figure's frame height is chosen, and is
 * independent of the focal length. At `f = 0.39` of frame height for a 1.19 m
 * figure the half-width is `aspect · H / 2f` = 2.7 m either side of the axis,
 * which is what sets the slot pitch in {@link PARTY}.
 */
const STAGE = {
  camX: 0.00,
  camY: 1.24,
  camZ: 7.60,
  pitch: 9,       // degrees down
  aimDist: 5.20,  // where the view axis crosses the aim height
  fov: 40,
};

/**
 * The stage clock.
 *
 * `HERO_TIME_OF_DAY` is 0.72 — the dusk key, and the reason every previous
 * capture of this stage came back mauve. The plate is a clear, high, warm day
 * under a blue zenith, so the stage runs its own hour and publishes it.
 *
 * 0.56 rather than a clean 0.50 for two reasons, both read off the plate.
 * First elevation: `Sky` puts noon at 62°, which is close enough to overhead
 * that a painted face loses its eye sockets to its own brow shadow; 0.56
 * interpolates to **48.6°**, which is where the plate's figures are keyed.
 * Second azimuth: `Sky` solves it as `90° − (t − 0.25)·360°`, so the sun crosses
 * from screen-right to screen-left at t = 0.5 — and on the plate the key is
 * unambiguously front-**left** (every figure's screen-left plane is the lit
 * one). 0.56 puts the sun at −21.6° of azimuth and 48.6° up, i.e. high, behind
 * the lens and over its left shoulder. The colour cost is 24% of the way toward
 * the dusk key, which reads as warm sunlight rather than as evening.
 */
const STAGE_TIME_OF_DAY = 0.56;

/** Aim point of the battle axis, derived so the pitch is exact. */
const STAGE_PITCH_RAD = (STAGE.pitch * Math.PI) / 180;
const STAGE_AIM_Y = STAGE.camY - STAGE.aimDist * Math.tan(STAGE_PITCH_RAD);
const STAGE_LOOK = [STAGE.camX, STAGE_AIM_Y, STAGE.camZ - STAGE.aimDist];

/**
 * Calibration bay origin.
 *
 * South-west and well behind every stage station point (all of which sit at
 * z ≤ 9.8 looking north or north-west), so no shipped framing can catch it and
 * no shipped framing has to be bent to avoid it.
 */
const BAY = { x: -34, z: 30 };

/**
 * Where the material bar stands, and the clearing the treeline is kept out of.
 *
 * The bar used to run *along* the bay's z axis with its camera at the end of
 * the row, so the nine cubes stacked one behind another in perspective and the
 * far six were a smear behind the near one — a diagnostic that cannot be read
 * is not a diagnostic. It now runs along X and is shot broadside, which means
 * it needs its own patch of ground clear of the sphere grid's sightline: nine
 * cubes at 0.95 m pitch is 7.6 m wide, and 9 m west of the grid puts the whole
 * row outside the `sphere-grid` pose's 3.4 m half-width at that depth.
 *
 * `CLEARING` then has to cover both installations: the far conifer belt
 * scatters over an annulus centred on the battle stage whose outer radius
 * swallows the bay whole, so without an explicit hole trees grow through the
 * sphere grid and the one frame whose job is reading material response becomes
 * unreadable.
 */
const BAR = { x: -43, z: 31 };
const CLEARING = { x: -39, z: 30.5, radius: 15 };

/**
 * Multiplier on the ART_BIBLE §3 fog density, via the hook Sky publishes.
 *
 * This was **3.0**, on `REFERENCE_TARGET` §3's "heavy atmospheric perspective
 * is the signature". The plate says otherwise and says it unambiguously:
 * individual lavender florets and individual tulip petals are resolvable at the
 * *far* edge of the bed, twenty-odd metres back, and the boulder wall behind
 * that still carries full-contrast facet edges. There is no signature haze in
 * this reference; there is a clear day.
 *
 * 0.9 is therefore very nearly "off", chosen to leave the far conifer belt a
 * touch of desaturation and nothing else. At the stage hour that is a density of
 * ~0.0021/m: `FogExp2` removes 0.6% of contrast at 40 m, where 3.0 removed 6%,
 * and only reaches a visible 13% at 200 m — which is past everything except the
 * horizon skirt.
 */
const FOG_SCALE = 0.9;

/** Shared height-field noise. Module scope because `BAY` and the stage-level
 *  plateau both need to sample it before any instance exists. */
const STAGE_SEED = 0x10057ade;
const STAGE_NOISE = makeNoise(STAGE_SEED);

/** Centre and extent of the levelled battle stage, in world metres. */
const STAGE_PLATEAU = { x: 0, z: 2.6, inner: 6.5, outer: 22 };

/**
 * The bank the meadow climbs behind the party.
 *
 * The plate is not shot on a table. Its flower bed sits on ground that rises
 * away from the lens: the bed's near edge is level with the cast's boots and
 * its far edge is a good half a character-height above their heads, which is
 * what lets a 1.2 m lavender plant read against *sky* at the back of the bed
 * instead of against more lavender. Without it the bed's silhouette collapses
 * onto one flat top edge at the horizon line — every plant of the same height
 * projects to the same screen row when the camera is at that height, which is
 * exactly the eye-level camera this staging just committed to.
 *
 * Solved in z rather than in radius so the ground under the party stays dead
 * level while the ground behind them climbs, and its *rate* is set by how much
 * frame the bed has to fill rather than by how a hillside ought to look. On the
 * plate the flower bed occupies y ≈ 180–650 of 1080 — 44% of the image — and no
 * bed standing on level ground can do that from an eye-level camera, because
 * every plant of the same height then projects to the same screen row. At 3.1 m
 * over 22 m the far bed's racemes reach y ≈ 113 and its near edge sits at
 * y ≈ 430, which is 29% of frame and the closest a six-figure line leaves room
 * for.
 */
const BANK = { from: 1.2, to: -22, height: 3.1, inner: 4.5, outer: 9.0 };

/**
 * Front edge of the flower bed, in world z.
 *
 * Everything the bed is made of is scattered about a centre *behind* the line,
 * but with a radius large enough to reach past it, so the bed needs a hard
 * front plane or lavender grows through the cast. 0.5 m sits 1.3 m behind the
 * deepest figure (Yshara at z = 1.77), which on the plate is about where the
 * bed starts relative to the archer.
 */
const FLORA_FRONT_EDGE = 0.5;

/**
 * How close to the lens the lawn is allowed to grow, in world z.
 *
 * The battle frustum's lower edge meets the ground 2.2 m out, so this is the
 * nearest z that can ever be seen as *floor*. Grass in front of it is not
 * foreground, it is an obstruction: at half a metre from the glass a 10 cm
 * blade fills the frame. Expressed in world z rather than as a radius because
 * the camera has no yaw and the constraint is purely one of depth.
 */
const LAWN_NEAR_LIMIT = STAGE.camZ - 2.2;

/**
 * The dirt path, as a half-plane in the ground with a feathered edge.
 *
 * `0 < (z − z0)·dz − (x − x0)·dx < width` is path — a **band**, not a
 * half-plane. The half-plane the first pass shipped is unbounded to the left,
 * so the track did not enter the corner and leave, it covered the entire
 * western half of the world: the capture shows a tan plain running to the
 * horizon behind the cast. A track has two edges.
 *
 * The coefficients tilt the band so it enters the bottom-left corner of the
 * battle frame and passes out at the left edge, which is the one region of
 * floor no figure stands on and exactly where the plate puts its own. Both
 * edges are feathered over 1.2 m, because a hard boundary between bare earth
 * and mown grass is the one thing real ground never has.
 */
const PATH = { x0: -1.0, z0: 4.8, dx: 0.75, dz: 1.0, feather: 1.2, width: 4.5 };

/**
 * Where the cherry stands, and how high its petals drift.
 *
 * Module scope because two things need it and must not disagree: `_buildMeadow`
 * plants the tree, and `_buildMotes` seeds the falling petals in a column
 * around it. A petal cloud that has drifted away from the tree that shed it is
 * the failure this constant exists to make impossible.
 */
const CHERRY = { x: -6.0, z: -2.2, height: 3.6, drift: 4.2 };

/**
 * The ground's analytic height field.
 *
 * Shared by the mesh displacement and by everything planted on it, so a prop
 * can never float or sink — sampling a displaced mesh back would mean either
 * a raycast per instance or an index lookup that silently breaks the first
 * time the tessellation changes.
 *
 * The plateau is a hard requirement of the staging, not a convenience: the
 * party's line is solved in screen space against a **flat** floor, and a metre
 * of terrain swell under one flank re-sorts it and tilts the contact pool. It
 * levels the 6.5 m the cast and the near lawn occupy and ramps back into the
 * rolling field by 22 m.
 */
function groundHeight(x, z) {
  const n = STAGE_NOISE;
  // 1.2 m of swell, not 9. At 9 the noise is the landform and the bank is a
  // rounding error on it: sampled along the view axis the old field fell to
  // −4.2 m by 40 m out, so the meadow's far half was a *depression*, the crest
  // never appeared, and the frame's whole top third was sky. The bank is the
  // landform this staging needs; the swell's job is only to keep the far field
  // from reading as a machined plane.
  const swell = n.fbm3(x * 0.0032, 0, z * 0.0032, { octaves: 4, gain: 0.55 }) * 1.2;
  const ripple = n.fbm3(x * 0.055, 11, z * 0.055, { octaves: 3, gain: 0.5 }) * 0.09;
  const r = Math.hypot(x - STAGE_PLATEAU.x, z - STAGE_PLATEAU.z);
  const flat = smootherstep(STAGE_PLATEAU.inner, STAGE_PLATEAU.outer, r);
  // Rises only *behind* the stage (decreasing z), on its own much tighter
  // radial falloff. Riding the swell's `flat` — as the first pass did — is what
  // made the bank invisible: that ramp is not complete until 22 m, so at the
  // bed's own depth it was still delivering 12% of the climb and the horizon
  // came back flat. The two ramps answer different questions (where may the
  // terrain noise live, and where does the meadow start climbing) and cannot
  // share a curve.
  const bankFall = smootherstep(BANK.inner, BANK.outer, r);
  const bank = smootherstep(BANK.from, BANK.to, z) * BANK.height * bankFall;
  // The ripple keeps a floor even on the plateau: a mathematically level floor
  // is one uniform value across the bottom of frame, with no form for the
  // grade to work on.
  return swell * flat + bank + ripple * Math.max(0.15, flat);
}

/**
 * Ground elevation under the calibration bay.
 *
 * The bay sits outside the stage plateau, on open rolling terrain, so its
 * elevation is whatever the height field says. Everything in the bay — props
 * and its two camera stations alike — is authored in bay-local metres and
 * lifted by this, which is what keeps the material bar sitting *on* the ground
 * instead of buried in or hovering over it after the bay is moved.
 */
const BAY_Y = groundHeight(BAY.x, BAY.z);

/** Same, for the material bar's own patch — the bay's terrain rolls over 9 m. */
const BAR_Y = groundHeight(BAR.x, BAR.z);

/** Half-width of the battle frustum per metre of depth, at STAGE.fov / 16:9. */
const TAN_HALF_H = Math.tan((STAGE.fov * Math.PI) / 360) * (16 / 9);

/**
 * Ground position for a stage slot, solved in the battle frame's screen space.
 *
 * `ndc` is the wanted horizontal position (0 = centre, ±1 = frame edge) and
 * `depth` the distance along the *pitched* view axis to the figure's feet.
 * Because the camera has no yaw and no roll its right vector is exactly world
 * +X, so screen x is linear in world x at a given depth; the z solve has to
 * undo the pitch, which is the `cos`/`sin` pair below. Getting that wrong is
 * how a "12° camera" ends up with figures 40 cm off their intended frame
 * height at the back of the diagonal.
 */
function stagePlacement(slot) {
  const zDrop = (slot.depth - STAGE.camY * Math.sin(STAGE_PITCH_RAD)) / Math.cos(STAGE_PITCH_RAD);
  return {
    x: STAGE.camX + slot.ndc * TAN_HALF_H * slot.depth,
    z: STAGE.camZ - zDrop,
  };
}

/**
 * The line — **one loose rank across the middle of frame**, measured off the
 * plate rather than composed against §2's staggered diagonal.
 *
 * The plate's four figures span x ≈ 380 → 1450 px of 1920, i.e. `ndc` −0.60 to
 * +0.51, with the nearest at 39% of frame height and the furthest at ~30%. That
 * is a *line*, not a diagonal into a corner, and its depth variation is small —
 * enough to stagger the feet, not enough to shrink the back of the run.
 *
 * Two constraints then fall out of the eye-level camera, and they are what fix
 * the numbers below:
 *
 *  1. **The world width is not negotiable.** Once the nearest figure's frame
 *     height `f` is chosen, the half-width the frame covers at that figure's
 *     depth is `aspect · H / 2f` — 2.71 m here — *whatever* the focal length.
 *     Six figures have to fit in that, which is a slot pitch of ~0.83 m against
 *     a ~0.25 m personal radius each.
 *  2. **Heads land on a level line and cannot be separated vertically.** A
 *     camera at crown height projects every crown to the horizon row regardless
 *     of depth, so depth buys *feet* separation and nothing else. Horizontal
 *     clearance therefore has to be real: at these depths a head is 0.065–0.095
 *     of `ndc` across and the slot pitch is 0.26, so the nearest pair of skulls
 *     clears by 2.9×.
 *
 * Depths alternate near/far by ~1.1 m so the feet run staggers instead of
 * ruling a line across the frame, and the *shortest* characters (Emrys 1.00 m,
 * Seren 1.06 m) take near slots so the run's frame heights stay inside
 * 0.25–0.39 rather than fanning out with the roster's own 19% height spread.
 *
 * `turn` is how far the figure rotates **back toward the lens** from squaring
 * up to the threat, and it is the single control over whether this stage has
 * faces in it. Measured on the plate the four figures sit 43°, 45°, 59° and 75°
 * off the lens — near profile for the armoured lead, three-quarter front for
 * the casters — and the values below reproduce that spread rather than putting
 * everyone at one flattering angle.
 */
const PARTY = [
  { id: 'auren',  ndc: -0.78, depth: 4.15, turn: 0.35 },
  { id: 'bramm',  ndc: -0.52, depth: 5.30, turn: 0.70 },
  { id: 'seren',  ndc: -0.26, depth: 4.45, turn: 0.85 },
  { id: 'kite',   ndc:  0.02, depth: 5.60, turn: 0.55 },
  { id: 'emrys',  ndc:  0.28, depth: 4.75, turn: 0.62 },
  { id: 'yshara', ndc:  0.54, depth: 5.95, turn: 0.80 },
];

/** Ground positions of every staged figure, solved once against the frame. */
const PARTY_PLACES = PARTY.map(stagePlacement);

/**
 * Horizontal half-width a standing figure actually occupies.
 *
 * Shoulder joint out to the outside of a hanging hand — i.e. the widest thing
 * the idle pose swings through, which is what "limbs interpenetrate" is about.
 * Read from the rig's solved metrics rather than assumed, so a roster entry
 * with a `shoulder` or `limb` proportion multiplier is measured, not guessed.
 */
function personalRadius(character) {
  const m = character.metrics;
  return Math.abs(m.joints.shoulderL.x) + m.girth.arm * 2 + m.girth.hand;
}

/**
 * Spawn-time capsule separation for the staged party.
 *
 * The authored ranks above already clear this by ~70 cm, so on a healthy
 * table it is a no-op that runs once at mount. It exists because the table is
 * the thing people edit: a slot nudged for composition has no way to know how
 * wide the rig it is positioning turned out to be, and the failure mode is
 * silent and only visible as an arm passing through a torso in a capture.
 *
 * Symmetric push along the separation axis, relaxed rather than solved in one
 * step so a three-way pile-up resolves instead of ping-ponging between two of
 * its members. Positions are in the ground plane; the camera looks down -Z
 * with no yaw, so a push is spread across screen-x and depth in the ratio the
 * overlap itself dictates, which keeps the recession order intact.
 *
 * @param {Array<{x:number,z:number}>} places authored ground positions
 * @param {number[]} radii per-figure {@link personalRadius}
 * @param {number} [clearance] extra metres demanded between two silhouettes
 */
function separateStagePlaces(places, radii, clearance = 0.10, iterations = 12) {
  const out = places.map((p) => ({ x: p.x, z: p.z }));
  for (let pass = 0; pass < iterations; pass++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const want = radii[i] + radii[j] + clearance;
        let dx = out[j].x - out[i].x;
        let dz = out[j].z - out[i].z;
        let d = Math.hypot(dx, dz);
        if (d >= want) continue;
        // Two figures authored on the same spot have no separation axis to
        // resolve along. Screen-right is the axis this staging is composed in,
        // so it is the deterministic fallback rather than a random one.
        if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
        const push = (want - d) * 0.5;
        out[i].x -= (dx / d) * push;
        out[i].z -= (dz / d) * push;
        out[j].x += (dx / d) * push;
        out[j].z += (dz / d) * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

/** Centre of mass of the line. */
const PARTY_CENTROID = {
  x: PARTY_PLACES.reduce((a, p) => a + p.x, 0) / PARTY_PLACES.length,
  z: PARTY_PLACES.reduce((a, p) => a + p.z, 0) / PARTY_PLACES.length,
};

/** Heading from `a` to `b` in the rig's convention, where +Z is forward. */
function headingTo(a, b) {
  return Math.atan2(b.x - a.x, b.z - a.z);
}

/**
 * What the party is addressing — a point **off the right edge of frame**.
 *
 * The plate shows no enemy at all: all four figures face frame-right at a
 * threat the composition never reveals, and that off-screen address is most of
 * what stops the frame reading as a lineup. So this stage no longer builds one
 * either. What it needs instead is a stable aim point, and the requirements on
 * it are specific:
 *
 *  - **Far.** At 18 m the six slots' headings to it converge inside 6°, so the
 *    line reads as watching one thing. At 6 m they fan by 25° and the near-left
 *    figure ends up in dead profile while the far-right one is nearly frontal.
 *  - **Off frame.** 18 m out on the +X axis is `ndc` ≈ 2.8 at the stage lens,
 *    i.e. far outside the right edge, so nothing has to be modelled there.
 *  - **At eye height**, so the look-at tilts no head up or down. 1.0 m is the
 *    cast's own eye line.
 */
const GAZE_ANCHOR = new THREE.Vector3(18.0, 1.00, 2.00);

/**
 * How much of the way to the gaze anchor the head is allowed to travel.
 *
 * Not 1. `Animator._applyLook` distributes the aim across chest, neck and head,
 * so a full-weight look drags the whole upper body around with it and cancels
 * the `turn` that opened the figure to camera in the first place. At 0.6 the
 * head leads the body toward the threat by ~8° — enough that the party reads as
 * watching something rather than posing — while the face stays inside 45° of
 * the lens, which is where a chibi's eyes still read as eyes.
 */
const GAZE_WEIGHT = 0.6;

/**
 * A camera pose is a composition (ART_BIBLE §5), so each entry carries its
 * focal plane and its grade as well as its coordinates. `silhouette` flips the
 * stage into the flattened-value check the same section mandates.
 */
const CAMERA_POSES = {
  /**
   * The shipped frame: the plate's staging, at the plate's lens height.
   *
   * Party across the middle of frame at 25–39% of frame height in an address
   * that runs from near-profile to three-quarter front, the meadow bank behind
   * them, the boulder wall and the sky above that.
   *
   * **f/22 and `bokeh: 0`, not f/6.3.** This is the largest single change to
   * the pose table and it is a reference correction, not a taste call: the
   * plate is sharp from the cast's boots to the far edge of the boulder wall,
   * and it resolves individual florets at both. `REFERENCE_TARGET` §3's
   * "backgrounds are soft" is simply not true of this image.
   *
   * The stop alone no longer buys that, and this is the trap worth recording:
   * `dofShader.js` now carries a far-field *floor* keyed on `log2(z / focus)`,
   * so past a couple of multiples of the focal plane it applies a fixed defocus
   * that closing the aperture cannot reach — by design, since physical far CoC
   * saturates and the composer needs some way to soften a horizon. `bokeh: 0`
   * is the documented off switch for both terms at once, and it is the only
   * thing that keeps the treeline as crisp as the plate has it while the same
   * chain still runs the portrait below at its authored softness.
   */
  battle: {
    pos: [STAGE.camX, STAGE.camY, STAGE.camZ], look: STAGE_LOOK,
    fov: STAGE.fov, focus: 5.0, aperture: 22, bokeh: 0, grade: 'battle',
  },
  /**
   * Command framing: the same axis, pushed in.
   *
   * This is the frame a player reads ability names against, so it runs tighter
   * than the shipped stage and lets the outermost figures crop at the edges.
   * Same near-pinhole stop and the same reason.
   *
   * **0.70 m of push, not 1.35.** A push along the view axis scales every
   * slot's screen position by `d / (d − push)`, and it does so hardest on the
   * *nearest* figure — which on this line is the lead. At 1.35 m Auren's slot
   * ran from `ndc` −0.78 out to −1.16, i.e. wholly outside the frame, and the
   * sheet's command framing duly shipped five of six characters with the party
   * leader missing: "crop at the edges" is a claim about a shoulder, not about
   * losing a cast member. 0.70 m puts him at −0.94 — cropped down one arm and
   * still read as a figure — and holds the rear slot inside the right edge,
   * where the HUD stack overlays rather than replaces it.
   */
  lineup: {
    pos: [STAGE.camX, STAGE.camY, STAGE.camZ - 0.70], look: [STAGE.camX, STAGE_AIM_Y, STAGE.camZ - 0.70 - STAGE.aimDist],
    fov: STAGE.fov, focus: 4.3, aperture: 22, bokeh: 0, grade: 'battle',
  },
  /** Battle station, battle lens, rendered as a **matte**. The silhouette check
   *  has to be run on the shipped composition or it is checking nothing — and
   *  it has to be run on actual mattes or it is checking nothing either. See
   *  `_enterMatte`. */
  silhouette: {
    pos: [STAGE.camX, STAGE.camY, STAGE.camZ], look: STAGE_LOOK,
    fov: STAGE.fov, focus: 5.0, aperture: 22, bokeh: 0, grade: 'neutral', silhouette: true,
  },
  /**
   * Auren, head and shoulders, front three-quarter — the portrait.
   *
   * Solved at pose time from the live head bone rather than authored as a
   * station point, and that is not convenience: this frame's entire job is to
   * put one face on screen large enough to judge the eye build, so the one
   * thing it cannot afford is to be aimed at where the head *used* to be. A
   * hard-coded station is correct only until someone re-solves the diagonal,
   * changes a `turn`, or moves the gaze anchor — and every one of those has
   * happened at least once already, which is how the previous build ended up
   * framing the back of a skull. Deriving the station from `bones.head` means
   * the shot cannot come loose from its subject.
   *
   * `swing` is the fraction of the way from the head's own facing axis around
   * to the battle camera's bearing. At 0.55 the lens sits ~28° off the face
   * normal: far enough that the head reads as a volume with a lit side and a
   * shadow side rather than as a flat mask, close enough that both eyes and
   * both brows are fully presented. The remaining terms place him on the
   * upper-left thirds intersection (ART_BIBLE §5.2) and just under eye line
   * (§5.4, "hero shots slightly low").
   *
   * Focus is the camera-to-eye distance, computed with the station — not a
   * constant that a later staging change could leave sitting on the treeline.
   * f/8 on a 34 mm lens at ~1.1 m has ~6 cm of depth at the focal plane, so the
   * face is crisp from brow to chin while the 40 m background is gone entirely.
   *
   * Graded `dusk`, not `memory`. `memory` is the flashback timing — lifted
   * milky blacks, saturation 0.68, contrast 0.90 — and this is the one frame
   * in the sheet whose job is to let someone judge the toon terminator, the
   * rim envelope and the eye build. Judging any of those through a faded
   * print is judging the grade. `dusk` is the key the scene is actually lit
   * at (ART_BIBLE §3, t = 0.72), so the portrait is timed to its own hour.
   */
  'hero-closeup': {
    subject: 'auren',
    // The lens sits 45% of the way from the face's own normal round to the
    // battle camera's bearing, i.e. ~22° off axis. Enough that the skull reads
    // as a volume with a lit side and a shadow side; close enough that both
    // eyes, both brows and both lash flicks are fully presented, which is the
    // only reason this frame exists. Anything past ~35° starts to foreshorten
    // the far eye, and a painted face has no geometry to compensate with.
    swing: 0.45,
    /**
     * Metres of subject height the lens covers — the framing is authored as a
     * *size*, not as a station distance, because "head and shoulders" is a
     * statement about the subject and the range that produces it depends on the
     * focal length and on whose head it is.
     *
     * A chibi's crown-to-shoulder run is ~0.50 m and the head alone ~0.44 m, so
     * 0.72 m frames the portrait with a shoulder's worth of costume under it
     * and the head at ~61% of frame height. The previous 0.95 m put the head at
     * 44% — a torso shot with a face in it, which is not enough face to judge
     * an eye build on, and this frame's entire job is judging the eye build.
     */
    frame: 0.72,
    // Camera 5 cm under the eye line: ART_BIBLE §5.4's "hero shots slightly
    // low", and on a chibi it also stops the 12°-down battle habit from
    // reading as a look down at a child.
    rise: -0.05,
    // Aim below and to one side of the eyes, which pushes the subject up and to
    // frame left: eyes land just over the upper third and the head is off the
    // centreline (§5.2). Signs matter — the aim point *is* frame centre, so a
    // negative `up` puts the eyes above it.
    aim: { right: 0.12, up: -0.10 },
    // f/11, not f/8. Focus rides the head bone (see `poseCamera`), so the plane
    // is on the eyes by construction; what the stop has to buy is enough depth
    // that the whole 0.44 m skull — brow to ear to jaw — is inside it. At this
    // range everything past two metres is still gone entirely, so the
    // background stays as soft as REFERENCE §3 requires.
    // 4.0 is `PostFX`'s own `DEFAULT_BOKEH_SCALE`, restated rather than omitted:
    // `setDof` defaults the argument to whatever the *last* pose left behind,
    // and every meadow pose leaves 0 there. Omitting it would ship a portrait
    // with a pin-sharp 40 m background, which is the one frame in the sheet
    // that genuinely wants its background gone.
    fov: 34, aperture: 11.0, bokeh: 4.0, grade: 'battle',
  },
  /**
   * The three-quarter reverse — the meadow itself, with the line as its subject
   * rather than its centre.
   *
   * Station point is east of the stage looking north-west, so the camera is
   * ~40° off the battle axis and the two frames share no geometry: here the
   * cast is seen along the line rather than across it, the cherry tree closes
   * the left edge and the boulder wall the top. It exists to prove the meadow
   * is a *place* — that the bed has depth behind the line and the bank has form
   * — rather than a backdrop painted at one bearing.
   */
  wide: {
    pos: [7.40, 1.95, 8.90], look: [-1.20, 0.85, 0.60],
    fov: 44, focus: 8.5, aperture: 16.0, bokeh: 0, grade: 'battle',
  },
  /** Sky-dominant landscape for the day-cycle sweep, shot over the bank so the
   *  meadow's crest and the sky above it both carry the hour. */
  horizon: {
    pos: [-2.20, 1.70, 9.60], look: [4.40, 5.60, -24.0],
    fov: 50, focus: 14, aperture: 16, bokeh: 0, grade: 'battle',
  },
  'sphere-grid': {
    pos: [BAY.x, BAY_Y + 2.1, BAY.z + 7.2], look: [BAY.x, BAY_Y + 2.0, BAY.z],
    fov: 34, focus: 7.2, aperture: 5.6, grade: 'neutral',
  },
  /**
   * Broadside on the material bar. 6.6 m back at 40° shows 8.5 m of frame width
   * against a 7.6 m row, so every cube is the same size and the same distance
   * from the key — which is the only arrangement in which two library materials
   * can actually be compared. f/4 keeps the row itself crisp while the treeline
   * beyond the clearing goes soft, so the frame still carries the scene's own
   * depth grammar instead of reading as a turntable.
   */
  materials: {
    pos: [BAR.x, BAR_Y + 1.30, BAR.z + 7.6], look: [BAR.x, BAR_Y + 0.42, BAR.z + 1.0],
    fov: 40, focus: 6.6, aperture: 4.0, grade: 'neutral',
  },
};

/** Outer radius and rim rise of the fogged horizon skirt, in metres. */
const SKIRT_RADIUS = 9000;
const SKIRT_RISE = 62;

/**
 * How far the scene pulls Sky's fog colour back toward the palette's near teal.
 *
 * Down from 0.34. It was fighting the dusk key's mauve, which at 3× density was
 * the largest area of chroma in frame; at the stage hour the sampled fog is
 * already a pale blue-grey and at 0.9× density it is only really visible on the
 * horizon skirt. A light bias keeps that band reading as distance rather than
 * as a painted line, and anything stronger tints the sky's own base of the dome.
 */
const FOG_NEAR_TEAL = new THREE.Color(LIGHT.FOG_NEAR);
const FOG_COOLING = 0.18;

/**
 * The matte pass — the shot named `cast-silhouette` actually rendering mattes.
 *
 * It used to be a *lighting* trick: kill the key, the fill, the rim and the
 * cascade lights, rake one dim back-key across the party and hope the toon
 * surface resolved to black. It never did, and it never could. A toon shader's
 * shadow term is an additive tint inside `RE_Direct`, so it lifts the unlit
 * hemisphere in proportion to *every* light in the scene — drive the back-key
 * hard enough to rake an edge and you have also filled the face it is meant to
 * leave black. Below that there is a floor inside the surface itself that
 * survives a scene with no light in it at all. The shipped frame was therefore
 * the full-colour cast standing on flat beige, which is a picture of the
 * problem rather than a test of it: the distinctiveness check this pose exists
 * to run could not be evaluated, which is exactly what the review found.
 *
 * A matte is not a lighting state, it is a *material* state, so that is what
 * this now is: every cast surface swaps to unlit black, the ground to unlit
 * white, the sky, the meadow and the petals drop out, and the backdrop is
 * cleared to the same white. Nothing in the frame can then be anything but 0 or
 * 1, whatever the rig, the probe or the toon shader are doing — and PostFX's
 * diagnostic path (which this pose already triggers) has bloom, grain, vignette
 * and the grade off, so nothing downstream can lift black off black either.
 * What is left is the only question the pass asks: are these six shapes
 * distinguishable.
 *
 * Two stages of the chain the diagnostic path does *not* drop have to be
 * neutralised from here, because PostFX has no way to know it is looking at a
 * matte. DOF stays enabled, so the pose carries `bokeh: 0` — otherwise the
 * far-field floor in `dofShader.js`, which is keyed on depth ratio and not on
 * aperture, would soften the rear slots' edges and the check would grade a
 * silhouette on a blur. And the HUD is DOM, so `_enterMatte` hides it.
 */
const MATTE = {
  subject: 0x000000,
  ground: 0xffffff,
  /**
   * Radiance multiplier on the white.
   *
   * The diagnostic path still tone-maps — it has to, because that is the only
   * way linear HDR reaches an sRGB display — and ACES maps a linear 1.0 to
   * about 0.80. Left there the "white" ground ships at 235, which is a light
   * grey, and a check whose entire premise is two values should ship two
   * values. 4.0 sits far enough up the curve that the ground and the background
   * clear both resolve to 255 while staying well inside float range.
   */
  gain: 4.0,
};

/**
 * Contact shadows — a top-down occlusion projector, not a decal.
 *
 * BRAVELY §7 requires "ground visible beneath them with soft contact shadows"
 * and the shipped frame had none: six pairs of boots met the terrain with no
 * occlusion darkening at all.
 *
 * The cascades cannot supply it, at this hour least of all. `STAGE_TIME_OF_DAY`
 * puts the sun 48.6° up and front-left, so every cast shadow rakes away behind
 * its own figure and there is nothing whatsoever under the feet — and unlike a
 * low key it cannot even be leaned on, because a high sun is exactly what the
 * plate has. The previous answer was a radial decal sprite per character, and
 * it failed for a reason no amount of tuning reaches: a decal is a *transparent
 * overlay*, drawn after the ground and therefore after the ground's own
 * shading, so it composites against a surface that has already been lit and
 * fogged instead of darkening the light itself. Measured on the shipped frame
 * it moved the floor under the party by 16%, which is below the threshold at
 * which an eye reads contact at all.
 *
 * So the technique is replaced rather than tuned. Occlusion is now *rendered*:
 *
 *  1. every staged figure is drawn from an orthographic station directly above
 *     the stage into a small depth buffer (`MeshDepthMaterial`, so the skinned
 *     party comes through posed, not in bind pose);
 *  2. a resolve pass turns depth into occlusion, weighting each occluder by how
 *     close to the floor it is — boots contribute fully, hips a third, heads
 *     the broad ambient floor and no more;
 *  3. two separable Gaussian passes open that into a real penumbra;
 *  4. the ground material multiplies its own outgoing light by the result.
 *
 * Because it lands *inside* the ground's shading it is darkened by nothing and
 * washed out by nothing: fog then sits over it exactly as it sits over the rest
 * of the floor, which is what depth is supposed to do to a shadow. It also
 * cannot z-fight, cannot be buried by terrain tessellation, and follows the
 * animation for free.
 *
 * The first build of this projector produced a *correct* buffer that was
 * invisible on screen, and the reason is worth recording because it is a trap
 * the arithmetic hides. Its penumbra was two hex rings 1.8 and 4.2 texels out,
 * i.e. ~12 cm — narrower than a boot. A pool that never extends past the
 * silhouette that threw it is a pool the camera cannot see, because the figure
 * standing in it occludes the whole thing — and at this stage's 9° down-angle,
 * shallower than the staging it was first tuned against, the only part of a
 * contact shadow that reaches the lens is a thin crescent *outside* the body.
 * The blur is therefore not a smoothing step, it is the step that makes the
 * shadow visible at all, and it is sized against the figure (a 1.15 m chibi) —
 * not against the texel grid.
 */
const CONTACT = {
  /** Occlusion buffer edge. 384 over ~12.8 m of stage is ~3.3 cm per texel —
   *  finer than a chibi's boot, which is the smallest thing that must read. */
  size: 384,
  /** Metres of slack around the staged figures, so a weapon or a cape carried
   *  outside the formation still projects and no figure sits on the buffer's
   *  clamp edge. */
  margin: 2.2,
  /** Ortho station height. Must clear the tallest occluder or its crown clips
   *  and the pass reports the figure as absent. The cast tops out at 1.19 m,
   *  so 5.6 m is deliberate headroom rather than a fit: it is what lets a slot
   *  be restaged, or a mount or a set piece be parked on the stage, without the
   *  contact pass silently dropping it. */
  camHeight: 5.6,
  /** Lowest world y the projector can see. The plateau is level at 0; the
   *  slack keeps the 8-bit depth range off the floor value itself. */
  floor: -0.8,
  /** Metres over which an occluder's contribution halves as it rises. 0.30 is
   *  boot-to-shin on a chibi, so the dark core still comes from what is actually
   *  touching the ground while a hem or a trailing skirt reads as half-contact. */
  falloff: 0.30,
  /** Floor contribution from anything overhead at any height. This is what the
   *  plate's broad soft ellipse *is*: a body occludes the sky over its whole
   *  footprint, not only where it touches. At 0.15 the pool was a boot-print;
   *  at 0.38 it is a figure's shadow with a boot-print inside it, which is also
   *  what keeps a wide silhouette — a skirt, a cape, a shield held off the hip —
   *  from standing on nothing but the two dots its boots report. */
  ambient: 0.38,
  /** Peak fraction of the way to `tint` the ground is driven. */
  strength: 1.0,
  /** Penumbra sigma in texels — 6.2 texels is ~21 cm, so the pool reaches about
   *  two boot-widths past the silhouette and a crescent of it clears the body
   *  from the battle camera. Run separably (H then V), which is nine taps a
   *  pass against the eighty-one a comparable 2D kernel would cost. */
  blurSigma: 6.2,
  /** Gamma on the resolved occlusion. Below 1 it lifts the penumbra's midtones,
   *  which is what turns a mathematically-correct-but-invisible gradient into a
   *  pool with a readable edge. Less lift is needed now that `ambient` carries
   *  the broad pool on its own. */
  gain: 0.78,
};

/**
 * Render layer the occlusion pass draws.
 *
 * A layer rather than a second scene: the party has to stay in the main graph
 * to be lit, shadowed and posed, and a parallel graph holding
 * the same meshes is the kind of duplication that goes stale the first time
 * someone adds a prop. The projector camera is set to *only* this layer, so
 * the sky dome, the terrain and the whole meadow are excluded without touching
 * them.
 */
const CONTACT_LAYER = 5;

export class LookdevScene extends Scene {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {Object} [opts]
   * @param {string} [opts.pose='battle'] pose the scene opens on. The capture
   *   harness shoots whatever is on screen when `gotoLookdev` resolves, so the
   *   entry pose *is* a deliverable — see `main.js`.
   */
  constructor(engine, opts = {}) {
    super(engine);
    /** Isolated stream: the shared `rng` is consumed by combat and VFX too, and
     *  the stage dressing must be byte-identical between captures regardless. */
    this.rng = new Rng(STAGE_SEED);
    this.noise = STAGE_NOISE;
    /** @type {Array<ReturnType<typeof buildCharacter>>} */
    this.cast = [];
    /** @type {THREE.Object3D[]} Flora roots, each carrying its own `dispose`. */
    this._flora = [];
    this.focusDistance = 8;
    this._silhouette = false;
    /** @type {Map<THREE.Mesh, THREE.Material|THREE.Material[]>} matte swaps */
    this._matteSwap = new Map();
    /** @type {THREE.Object3D[]} hidden for the duration of the matte pass */
    this._matteHidden = [];
    this._entryPose = opts.pose && opts.pose in CAMERA_POSES ? opts.pose : 'battle';
    this._pose = this._entryPose;
  }

  /**
   * PostFX's scene-level diagnostic contract (`PostFX._resolveDiagnostic`).
   *
   * It also reads the private `_silhouette` as a documented fallback; publishing
   * the flag properly is what closes that gap, and it is what the matte pass
   * relies on to get bloom, DOF, grain, vignette and the grade out of the way.
   */
  get silhouette() {
    return this._silhouette;
  }

  async mount() {
    const engine = this.engine;
    const forge = engine.get('art');

    this.camera = new THREE.PerspectiveCamera(STAGE.fov, engine.camera.aspect, 0.08, 4000);

    // A calibration stage lit at an arbitrary hour calibrates nothing, so the
    // scene owns the clock on entry and publishes it back so the debug hook and
    // any later scene agree with what is on screen. See {@link STAGE_TIME_OF_DAY}
    // for why this is not the palette's `HERO_TIME_OF_DAY`.
    gameState.state.timeOfDay = STAGE_TIME_OF_DAY;

    this.sky = this.track(new Sky(engine));
    this.sky.fogDensityScale = FOG_SCALE;
    this.sky.addTo(this.scene);
    this.sky.setTimeOfDay(STAGE_TIME_OF_DAY);
    engine.register('sky', this.sky);

    this.lighting = this.track(new Lighting(engine, this.sky));
    // The whole battle stage fits inside a 20 m box. The rig's 120 m default is
    // sized for an open field, and under the VSM filter core selects that range
    // is actively harmful: VSM stores depth *moments* in half float, so the
    // wider the light-space depth range the coarser the variance, and a chibi's
    // 1.1 m of occluder disappears into the noise floor as light bleed. 60 m
    // halves the range and doubles the near cascade's texel density at the same
    // map size, which is what puts a readable shadow back under the party.
    this.lighting.setShadowDistance(60);
    this.lighting.addTo(this.scene);
    engine.register('lighting', this.lighting);

    // The fog cooling has to land *after* the rig has run, and the rig ticks as
    // a service — i.e. after `Scene.update`. Registering immediately behind
    // `lighting` is the only ordering that survives without reaching into
    // Lighting's internals. The occlusion projector rides the same slot for the
    // same reason: it has to draw the cast *after* `Scene.update` has posed it
    // and *before* the frame renders.
    engine.register('lookdev-stage', {
      update: () => {
        this._afterRig();
        this._renderContactShadows();
      },
    });

    this._refreshEnvironment(forge);

    // Before the ground: `_buildGround` splices the occlusion buffer into the
    // terrain shader, so the render target and its uniform block have to exist
    // by the time that material is authored.
    this._buildContactShadows();
    this._buildGround(forge);
    this._buildMeadow(forge);
    this._buildMotes(forge);
    this._buildMatteMaterials();

    this._buildSphereGrid(forge);
    this._buildMaterialBar(forge);
    this._buildScaleProxy(forge);

    this._buildCast(forge);

    // Every character material was created after `addTo`, so the CSM patch has
    // to be re-applied or the party sums all four cascade lights unattenuated.
    this.lighting.refreshMaterials();
    this.lighting.sync();

    engine.get('vfx')?.addTo(this.scene);
    this.poseCamera(this._entryPose);
    this._mountHud();
  }

  /**
   * Put the HP/MP/BP stack on screen.
   *
   * The plate carries the party HUD, so a capture of this stage without it is a
   * capture of half the frame — the right-hand stack is 22% of the image width
   * and the only thing balancing a line that runs left-of-centre.
   *
   * `BattleUI` shows itself on `scene:changed` for any scene that declares a
   * string `encounterId`, and it deliberately identifies a battle by that
   * property rather than by class name (which the production build minifies).
   * `Engine.setScene` emits `scene:changed` *after* `mount` resolves, so a
   * `show()` from in here would be undone a moment later — declaring the
   * property is the documented way in, and it is honest: this scene is the
   * battle staging, and `poseCamera('battle')` is its shipped frame.
   *
   * The roster ids are handed over directly; `BattleUI.setParty` normalises ids,
   * roster entries and live combat actors alike and fills the stats from the
   * roster, which is exactly the fallback path a capture wants.
   */
  _mountHud() {
    this.encounterId = 'lookdev-stage';
    const ui = this.engine.get('ui');
    if (!ui?.battle) return;
    ui.battle.setParty(PARTY.map((slot) => slot.id));
    ui.battle.show();
  }

  /* --------------------------------------------------------------- probe */

  /**
   * Rebuild the specular probe from the live dome.
   *
   * Without this the sphere grid's metal row is lit only by the analytic rig,
   * which has no directional environment at all — metal renders as a dark ball
   * with one highlight, which is exactly the "metal is black" failure this
   * scene exists to catch. The forge caches on the sky's time-of-day, so
   * calling it again after a clock change is cheap when nothing moved and
   * correct when something did.
   */
  _refreshEnvironment(forge = this.engine.get('art')) {
    const env = forge?.environment?.(this.sky);
    if (!env) return;
    this._environment = env;
    // A sky dome is an enormous area source and the PMREM of it arrives at unit
    // intensity. Left there it out-runs the key on every upward-facing surface,
    // faces lose their modelling to a flat white, and the whole frame goes pale.
    //
    // 0.6 was measured against the *dusk* dome. This stage runs at 48° of sun
    // under a clear blue zenith, which is several times brighter, and the first
    // capture at 0.6 came back exactly as that arithmetic predicts: a milky,
    // desaturated frame with a blue cast on every green and blown speculars on
    // the armour. 0.28 restores the key's authority over form while leaving the
    // metal row a real reflection to show, which is the one thing the probe is
    // here for. Trimming the probe rather than the exposure (§3 pins that per
    // hour) or the per-material intensities (§4 pins those per surface) keeps
    // the correction in the one place that is genuinely scene-local.
    this.scene.environmentIntensity = 0.28;
    if (!this._silhouette) this.scene.environment = env;
  }

  /* -------------------------------------------------------------- terrain */

  /** Instance-side alias of the module height field — see {@link groundHeight}. */
  _groundHeight(x, z) {
    return groundHeight(x, z);
  }

  /**
   * Ground: 900 m of gently rolling grassland, plus a fogged skirt to the
   * visible horizon.
   *
   * Large enough that the plane's own edge is buried far inside the fog
   * (FogExp2 at the scaled dusk key reaches unity around 250 m), and displaced rather
   * than flat because a mathematically level plane under a low sun produces a
   * single uniform value across the entire lower half of frame — no form, no
   * shadow information, and nothing for the atmospheric gradient to grade.
   */
  _buildGround(forge) {
    const SIZE = 900;
    const SEG = 128;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this._groundHeight(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();
    this.track(geo);

    // Repeat is solved from texel density, not taste: 900 m / 400 puts one
    // tile every 2.25 m, which at the chibi scale is roughly one tile per two
    // body heights — fine enough that the near ground carries detail, coarse
    // enough that the tiling period never lands inside a single frame.
    // Cloned so the conditioning stays local; the clone shares the forge's
    // textures and the forge guards those against `disposeTree`.
    //
    // `color` is **white** and stays white. The floor's albedo is now the pair
    // of measured colours in the fragment injection below, and the forge's
    // grass fBm is demoted to a *multiplier* around 1 — the same discipline
    // `Flora.js` documents at length for its own materials, and for the same
    // reason: two greens multiplied give a black lawn, which is most of how the
    // previous stage floor ended up at L≈18 with no value left to shadow.
    this.groundMaterial = forge.material('grass', { repeat: 400 }).clone();
    this.groundMaterial.color.setRGB(1, 1, 1);
    this.groundMaterial.envMapIntensity = 0.35;
    // The contact projector and the floor's own value/chroma conditioning both
    // land here, in the terrain's shading. Installed as an *own* hook, which is
    // also what makes it survive: `Lighting` chains whatever own
    // `onBeforeCompile` a material arrived with behind the cascade hook, and
    // reads nothing off the prototype.
    this.groundMaterial.onBeforeCompile = (shader) => this._injectStageFloor(shader);
    // The forge's ground materials all answer `aw-ground-1`, which is correct
    // for them and wrong for this one: three keys the program cache on that
    // string, so sharing it would hand a field-scene ground this shader or
    // vice versa.
    this.groundMaterial.customProgramCacheKey = () => 'aw-lookdev-stage-floor';
    this.track(this.groundMaterial);
    const ground = new THREE.Mesh(geo, this.groundMaterial);
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.ground = ground;
    this.scene.add(ground);

    // Beyond the displaced plane the sky dome renders its own below-horizon
    // ground colour, unfogged — which shows up as a hard dark band exactly at
    // the horizon. A fully-fogged skirt out to 9 km closes the gap: at this
    // density every fragment of it resolves to 100% fog, so it is literally the
    // fog colour and joins the terrain with no seam, whatever the hour.
    const skirt = new THREE.RingGeometry(SIZE * 0.44, SKIRT_RADIUS, 96, 1);
    skirt.rotateX(-Math.PI / 2);
    // Lift the outer rim into a very shallow cone. The dome's own atmosphere
    // model puts a dark band immediately under the geometric horizon (the
    // planet's limb at the observer's altitude), and a flat skirt's silhouette
    // sits *below* it, so the band survives as a hard dark line across every
    // frame. Raising the rim by SKIRT_RISE tilts the skirt's horizon about
    // 0.4° above level — a slope no viewer can perceive, and since every
    // fragment out there is 100% fog it simply reads as the haze bank meeting
    // the sky, which is what the reference frames show anyway.
    {
      const sp = skirt.getAttribute('position');
      for (let i = 0; i < sp.count; i++) {
        const r = Math.hypot(sp.getX(i), sp.getZ(i));
        const t = (r - SIZE * 0.44) / (SKIRT_RADIUS - SIZE * 0.44);
        sp.setY(i, t * SKIRT_RISE);
      }
      skirt.computeVertexNormals();
    }
    this.track(skirt);
    const skirtMaterial = this.track(new THREE.MeshBasicMaterial({
      color: new THREE.Color(LIGHT.FOG_FAR),
      fog: true,
    }));
    const skirtMesh = new THREE.Mesh(skirt, skirtMaterial);
    skirtMesh.position.y = -1.5;
    skirtMesh.name = 'horizon-skirt';
    skirtMesh.frustumCulled = false;
    this.scene.add(skirtMesh);
    this.skirt = skirtMesh;
  }

  /**
   * The meadow — every plant in the shipped frame, built by `world/Flora.js`.
   *
   * This replaces a 260-instance fogged conifer treeline and two banks of
   * hand-merged grass blades. Both were built to `REFERENCE_TARGET` §3's
   * "background elements are near-silhouettes with very little internal
   * detail", and `bravely01.jpg` shows the exact opposite: a bed dense enough
   * that lavender racemes, tulip heads and individual blades all resolve at its
   * far edge, in front of a sharp boulder wall, under a clear sky.
   *
   * ## Layout, and the arithmetic behind it
   *
   * Everything is placed by where it has to land *in frame*, then converted to
   * metres through the same lens the party is staged with (`TAN_HALF_H`):
   *
   * | element | world | why there |
   * |---|---|---|
   * | mown lawn | (0, 3) r 15 | the cast stands on it; blades 9–17 cm so boots clear it, as they do on the plate |
   * | dirt path | bottom-left, see `_pathness` | the plate's warm path enters the bottom-left corner and leaves frame at the left edge |
   * | bed, front band | (0, −1.5) r 9 | starts 1.8 m behind the deepest figure, so nothing grows through the line |
   * | bed, main mass | (0, −8) r 14 | at that depth the frame is 14 m of half-width, so one field fills it edge to edge |
   * | cherry | (−6.0, −2.2) h 3.6 | `ndc` −0.93 and its crown at `ndc_y` +0.93: the canopy closes the upper-left corner exactly as the plate's does |
   * | conifer | (5.4, −6.0) h 4.6 | the plate's one mid-right tree, above and behind the bed's right half |
   * | boulder wall | (−1, −13.5) size 2.6 | spans `ndc_y` 0.46→0.83, i.e. the top third, at 2.3× character height |
   * | far belt | (0, −27) r 34 | the treeline, now *behind* the bank rather than standing in for it |
   *
   * ## Why nothing is faded out with distance
   *
   * The old treeline shrank its instances' contrast into the fog by construction
   * — it was drawn in `bark`, near-black, specifically so it would read as a
   * silhouette. Flora's builders instead hold their albedo and let *density*
   * fall off with radius while blade size rises, which is what keeps the far
   * edge of the bed detailed at a fraction of the near edge's cost. Combined
   * with `FOG_SCALE` 0.9 that is the plate's own depth grammar: layers separate
   * by overlap and by scale, not by haze.
   */
  _buildMeadow(forge) {
    const group = new THREE.Group();
    group.name = 'meadow';
    const shared = { rng: this.rng, lighting: this.lighting, forge };

    /**
     * Drop a Flora root at a world offset.
     *
     * Every builder scatters about its own origin *and* samples `heightAt` in
     * that same local frame, so a group cannot simply be translated after the
     * fact — its plants would keep the elevation of the origin they were grown
     * at. Composing the offset into the callbacks and into the transform is the
     * only arrangement where both agree, and it is why `heightAt`/`mask` are
     * built here rather than passed in by the caller.
     */
    const plant = (build, ox, oz, opts) => {
      const root = build({
        ...shared,
        heightAt: (x, z) => groundHeight(x + ox, z + oz),
        mask: (x, z) => this._floraMask(x + ox, z + oz),
        ...opts,
      });
      root.position.set(ox, 0, oz);
      group.add(root);
      this._flora.push(root);
      return root;
    };

    // --- the lawn the cast stands on ---------------------------------------
    // 15 m covers everything the battle lens sees of the floor (the frame is
    // 9.7 m wide at the bed's front edge) with the near half at full density.
    //
    // The near cut-off is not cosmetic. A field centred on the stage with a
    // 15 m radius reaches to z = 18, i.e. ten metres *behind* the lens, and a
    // 0.12 m blade half a metre in front of the glass covers most of the frame:
    // the first capture of this meadow is a picture of that, blades crossing
    // the whole image and burying six characters. The battle lens first meets
    // the ground 2.2 m out (`atan` of the frustum's lower edge against
    // `STAGE.camY`), so anything nearer than `LAWN_NEAR_LIMIT` cannot be seen
    // as ground at all and can only ever be seen as a wall of grass.
    //
    // Blades are also shortened from the preset's 0.09–0.17 m. That range is
    // right for the plate at the plate's distance, but the plate's own lawn
    // resolves as *streaks* with no discrete blade anywhere, and at 2.2 m a
    // 0.17 m blade is 15% of frame height.
    plant(buildGrassField, 0, 3.0, {
      preset: 'lawn', radius: 15, count: 13000, falloff: 0.62, distanceGrowth: 0.9,
      height: [0.055, 0.105],
      mask: (x, z) => (z + 3.0 > LAWN_NEAR_LIMIT ? 0 : this._floraMask(x, z + 3.0)),
    });

    // --- the bed -----------------------------------------------------------
    // Front band first: shorter and sparser, so the bed's near edge reads as a
    // ragged margin rather than as a wall that starts at full height.
    // The bed must stop behind the cast line. A radius large enough to fill the
    // frame also reaches forward past z = 0 and, at meadow height, plants
    // metre-tall blades between the lens and the party — which buries the whole
    // read. `mask` is the clean fix: keep the radius that fills frame, reject
    // every sample that lands in front of the line. Local z here, so the cutoff
    // is expressed relative to each field's own centre.
    const behindLine = (centreZ) => (x, z) => (z + centreZ > -1.6 ? 0 : 1);

    plant(buildGrassField, 0, -1.5, {
      preset: 'meadow', radius: 8.5, count: 2200, height: [0.38, 0.72], falloff: 0.5,
      mask: behindLine(-1.5),
    });
    // The near band is where a raceme is actually resolvable — 3 cm at 9 m is
    // 5 px, against 2 px at the mass's depth — so it carries the highest
    // density in the meadow (20 plants/m²) and the least grass to hide it.
    plant(buildLavender, 0, -1.5, {
      radius: 6.5, count: 2600, height: [1.05, 1.40], falloff: 0.35, mask: behindLine(-1.5),
    });
    // Tulips and wildflowers take the same cut-off as everything else in the
    // bed. Without it their scatter reaches the lens: a 0.085 m tulip head a
    // metre from the glass is a 200 px white blob over the cast's boots, which
    // is what the previous capture shipped across its whole bottom edge.
    plant(buildTulips, 0, -1.2, { radius: 7.5, count: 260, mask: behindLine(-1.2) });
    plant(buildFlowerPatch, 0, -0.6, { radius: 8.0, count: 320, mask: behindLine(-0.6) });

    // The mass. One field at 14 m fills the frame edge-to-edge at its own depth,
    // which is why the bed does not need a second cluster either side.
    plant(buildGrassField, 0, -5.5, {
      preset: 'meadow', radius: 10, count: 4200, height: [0.45, 0.85], falloff: 0.45,
      mask: behindLine(-5.5),
    });
    // Density *and* proximity, in that order of importance.
    //
    // A lavender raceme is 3 cm across — measured off the built geometry, not
    // guessed — so at the 15 m the mass first sat at, one plant is under three
    // pixels wide and 3 000 of them over a 380 m² disc simply average into the
    // grass behind: the capture's purple pixel fraction over the bed's band came
    // out 0.003 against the plate's 0.080. The plate's own bed is both *nearer*
    // (its front edge is a metre behind the archer) and far denser, and it is
    // the only thing behind the cast — grass is the exception in it, not the
    // rule. So the mass moves 2.5 m forward, tightens to a 10 m radius, gains
    // half again as many plants (16/m²), and the meadow grass sharing that
    // ground drops by 40% and gets shorter so the racemes stand clear of it.
    plant(buildLavender, 0, -5.5, {
      radius: 10, count: 4600, falloff: 0.4, mask: behindLine(-5.5),
    });
    plant(buildTulips, 0, -5.0, { radius: 9, count: 560, mask: behindLine(-5.0) });

    // --- trees --------------------------------------------------------------
    // 1200 clusters, not 420. The plate's cherry is an opaque mass of blossom
    // with the branch structure only glimpsed inside it; at 420 the armature is
    // the read and the tree looks dead. Clusters are instanced off the branch
    // segments they grew on, so the extra density is one draw call either way.
    plant(buildBlossomTree, CHERRY.x, CHERRY.z, {
      height: CHERRY.height, spread: 1.25, clusters: 1200,
    });
    plant(buildConiferTree, 5.4, -6.0, { count: 1, height: 4.6 });
    // The belt. A 34 m scatter about z = −27 reached forward to z = +7, i.e.
    // to within a metre of the lens, and the first capture duly shipped conifers
    // standing in the flower bed at four times the party's height. Pushed back
    // and tightened so the whole annulus lives behind the bank's crest, where a
    // treeline belongs: it reads as the far side of the valley.
    plant(buildConiferTree, 0, -44, { count: 26, radius: 20, height: 5.4 });

    // --- rock ---------------------------------------------------------------
    // On the crest, not in the bed. The wall has to read *above* the lavender —
    // it is the only thing in the plate's upper third besides the treeline and
    // the sky — and with the bank in place that means standing it at the top of
    // the climb rather than halfway up it. From z = −26 it spans y 75→349 of
    // which the bed hides everything below 130, leaving exactly the band of
    // angular grey the reference shows.
    plant(buildBoulderCluster, -1.0, -26, { count: 11, radius: 11, size: 2.8, chips: 30 });
    plant(buildBoulderCluster, 10.5, -22, { count: 5, radius: 5, size: 2.1, chips: 14 });
    // The plate keeps a few loose stones on the mown grass in the near corners.
    // Small enough to be scale cues rather than props.
    plant(buildBoulderCluster, 4.2, 5.0, { count: 3, radius: 1.1, size: 0.42, chips: 10 });
    plant(buildBoulderCluster, -5.0, 4.2, { count: 2, radius: 0.9, size: 0.36, chips: 8 });

    this.scene.add(group);
    this.meadow = group;
    // Take ownership of the gust so two captures at the same seed produce the
    // same bend; `update` drives it from the scene's own clamped step.
    setFloraWind({ direction: { x: 0.88, y: 0.42 }, strength: 0.75, time: 0 });
  }

  /**
   * Keep-probability for anything planted on the stage.
   *
   * Two exclusions, both of which have to be honoured by *every* builder or the
   * frame contradicts itself:
   *
   *  1. **The path.** Grass growing down the middle of a bare track is the
   *     tell that the track is painted on rather than walked on.
   *  2. **The cast's own footprint.** The bed's builders are centred behind the
   *     line but their scatter radius reaches past it, and a lavender spike
   *     growing out of a character's chest is the single most expensive defect
   *     this frame can ship. The cut-off is a plane just behind the deepest
   *     figure rather than a per-character disc: the plate's bed has a clean
   *     front edge, and six discs would give it a scalloped one.
   */
  _floraMask(x, z) {
    if (z > FLORA_FRONT_EDGE && z < STAGE.camZ + 1.0) {
      // In front of the bed line: only the lawn lives here, and only off-path.
      return 1 - this._pathness(x, z);
    }
    if (z >= STAGE.camZ + 1.0) return 0; // behind the lens
    return 1;
  }

  /**
   * How much of the dirt path covers `(x, z)`, 0 → 1.
   *
   * A half-plane in the ground with a 1.2 m feather, oriented to enter the
   * bottom-left corner of the battle frame and leave at the left edge — which
   * is where the plate's path runs and, not coincidentally, the one part of the
   * floor no figure stands on. Shared by the ground's vertex colour and by the
   * grass mask so the bare patch and the painted patch are the same patch.
   */
  _pathness(x, z) {
    const t = (z - PATH.z0) * PATH.dz - (x - PATH.x0) * PATH.dx;
    return smootherstep(0, PATH.feather, t)
      * (1 - smootherstep(PATH.width, PATH.width + PATH.feather, t));
  }

  /**
   * Blossom drift — the petals coming off the cherry, not a magic effect.
   *
   * This used to be 900 additive teal "glasspetals" scattered over a 50 × 40 m
   * box at up to 7.5 m of altitude, on ART_BIBLE §5's "persistent ambient
   * particles". At the dusk key they read as fireflies; under a midday sky they
   * would read as dust on the lens. `bravely01.jpg` has no ambient particle
   * layer at all — `bravely04.jpg` has drifting petals, and they are *pink*,
   * *few*, and *under* the canopy that shed them.
   *
   * So the cloud is retargeted rather than deleted: 180 petals in a 7 m column
   * around the cherry, alpha-blended in the blossom's own measured pink instead
   * of added in teal, and small enough to be motion rather than sparkle. Where
   * they land in frame is now a property of where the tree is, which is the
   * only way this stays right after the tree moves.
   */
  _buildMotes(forge) {
    const COUNT = 180;
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    const rng = this.rng;
    this._moteSeed = new Float32Array(COUNT * 3);
    const pink = new THREE.Color(FLORA_PALETTE.BLOSSOM);
    const pale = new THREE.Color(FLORA_PALETTE.BLOSSOM_PALE);
    const c = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = CHERRY.x + rng.range(-3.0, 3.0);
      pos[i * 3 + 1] = rng.range(0.05, CHERRY.drift);
      pos[i * 3 + 2] = CHERRY.z + rng.range(-2.6, 2.6);
      c.copy(pink).lerp(pale, rng.next());
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      this._moteSeed[i * 3] = rng.range(0, 6.28);
      this._moteSeed[i * 3 + 1] = rng.range(0.05, 0.20);   // fall rate
      this._moteSeed[i * 3 + 2] = rng.range(0.25, 0.8);    // sway amplitude
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.track(geo);
    const mat = this.track(new THREE.PointsMaterial({
      map: forge.texture('mote'),
      size: 0.055,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      // Normal alpha, not additive: a petal in daylight *occludes* what is
      // behind it. Additive is a light source, and 180 of them over a bright
      // sky would only wash it out.
      opacity: 0.85,
      depthWrite: false,
      fog: true,
    }));
    const points = new THREE.Points(geo, mat);
    points.name = 'glasspetals';
    points.frustumCulled = false;
    points.renderOrder = 7;
    this.scene.add(points);
    this.motes = points;
  }

  /**
   * Materials for the matte pass. See {@link MATTE}.
   *
   * `MeshBasicMaterial` with `fog: false` is the whole point: nothing about
   * these can be lifted or tinted by the rig, the probe, the atmosphere or the
   * toon surface's shadow floor, so the frame the check is run on is guaranteed
   * to be two values.
   */
  _buildMatteMaterials() {
    this.matteSubject = this.track(new THREE.MeshBasicMaterial({
      name: 'matte-subject', color: MATTE.subject, fog: false,
    }));
    this.matteGround = this.track(new THREE.MeshBasicMaterial({
      name: 'matte-ground', color: MATTE.ground, fog: false,
    }));
    this.matteGround.color.multiplyScalar(MATTE.gain);
    this.matteBackground = new THREE.Color(MATTE.ground).multiplyScalar(MATTE.gain);
  }

  /* ----------------------------------------------------- contact occlusion */

  /**
   * Allocate the occlusion projector described on {@link CONTACT}.
   *
   * Two render targets and one orthographic station, both sized from the staged
   * placements rather than from constants, so re-authoring the line cannot walk
   * a figure off the edge of its own shadow.
   */
  _buildContactShadows() {
    let minX = Infinity; let maxX = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;
    for (const p of PARTY_PLACES) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    // Square, because the buffer is square: a non-square footprint would give
    // the two axes different texel densities and the penumbra would be an
    // ellipse everywhere.
    const half = Math.max(maxX - minX, maxZ - minZ) * 0.5 + CONTACT.margin;
    const cx = (minX + maxX) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const span = half * 2;

    const camera = new THREE.OrthographicCamera(-half, half, half, -half,
      0.02, CONTACT.camHeight - CONTACT.floor);
    camera.position.set(cx, CONTACT.camHeight, cz);
    // `up` = -Z, so the camera's right axis is world +X and its up axis is
    // world -Z. That makes the buffer's uv a plain affine function of world xz
    // — see the ground injection — instead of something that has to be derived
    // from the view matrix at every fragment.
    camera.up.set(0, 0, -1);
    camera.lookAt(cx, 0, cz);
    camera.layers.set(CONTACT_LAYER);
    camera.updateMatrixWorld(true);

    const targetOpts = {
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      // Clamped so the resolve pass's blur taps at the border repeat the edge
      // instead of wrapping the far side of the stage into frame.
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };
    const depth = this.track(new THREE.WebGLRenderTarget(CONTACT.size, CONTACT.size, targetOpts));
    depth.texture.name = 'contact-depth';
    const occlusion = this.track(new THREE.WebGLRenderTarget(CONTACT.size, CONTACT.size, {
      ...targetOpts, depthBuffer: false,
    }));
    occlusion.texture.name = 'contact-occlusion';

    // `BasicDepthPacking` writes `1 - depth` straight into the red channel, so
    // the resolve pass reads a linear height with no unpacking. RGBA packing
    // would buy 24-bit precision this does not need: the range is 6.4 m and the
    // falloff is 0.22 m, so an 8-bit step of 2.5 cm is a ninth of the smallest
    // feature the shadow has.
    //
    // `GreaterDepth` — with the depth buffer cleared to 0 — is the part that
    // makes this a contact shadow at all. The default test keeps the surface
    // *nearest* the projector, which looking straight down at a chibi is its
    // head: the buffer then reports "occluder at 0.95 m" across the whole
    // footprint, the height weighting all but erases it, and the result is the
    // faint even smudge the first pass of this produced. Keeping the *farthest*
    // surface instead reports the sole under a boot and the underside of the
    // hem under a skirt — which is the geometry that is actually in contact
    // with the ground.
    const depthMaterial = this.track(new THREE.MeshDepthMaterial({
      depthPacking: THREE.BasicDepthPacking,
      depthFunc: THREE.GreaterDepth,
    }));

    // Ping-pong partner for the separable blur. Same options; the chain is
    // resolve → occlusion, blur H → scratch, blur V → occlusion, so the buffer
    // the ground samples is always `occlusion`.
    const scratch = this.track(new THREE.WebGLRenderTarget(CONTACT.size, CONTACT.size, {
      ...targetOpts, depthBuffer: false,
    }));
    scratch.texture.name = 'contact-scratch';

    const range = camera.far - camera.near;
    const fullscreenVertex = /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4( position.xy, 0.0, 1.0 );
        }`;

    const resolve = this.track(new THREE.ShaderMaterial({
      name: 'contact-resolve',
      uniforms: {
        uDepth: { value: depth.texture },
        // Station height, near plane and depth range, so the shader can turn
        // the red channel back into a world height.
        uProjector: { value: new THREE.Vector3(CONTACT.camHeight, camera.near, range) },
        uShape: { value: new THREE.Vector2(CONTACT.falloff, CONTACT.ambient) },
      },
      vertexShader: fullscreenVertex,
      fragmentShader: /* glsl */`
        uniform sampler2D uDepth;
        uniform vec3 uProjector;
        uniform vec2 uShape;
        varying vec2 vUv;

        void main() {
          float r = texture2D( uDepth, vUv ).r;
          // The buffer is cleared to black, and an occluder standing on the
          // floor still reads ~0.13 here, so this rejects *empty* texels rather
          // than merely low ones.
          float occ = 0.0;
          if ( r >= 0.02 ) {
            float y = uProjector.x - uProjector.y - ( 1.0 - r ) * uProjector.z;
            occ = uShape.y + ( 1.0 - uShape.y ) * exp2( - max( y, 0.0 ) / uShape.x );
          }
          gl_FragColor = vec4( vec3( occ ), 1.0 );
        }`,
      depthTest: false,
      depthWrite: false,
    }));

    // Nine-tap Gaussian, run once per axis. Separable is not merely cheaper
    // than the 2D kernel of the same width (18 taps against 81) — it is what
    // makes a penumbra this wide affordable at all, and a penumbra this wide is
    // the whole reason the previous ring blur produced an invisible shadow.
    const taps = 4;
    const step = CONTACT.blurSigma * 0.6;
    const offsets = [];
    const weights = [];
    for (let i = -taps; i <= taps; i++) {
      const d = i * step;
      offsets.push(d / CONTACT.size);
      weights.push(Math.exp(-0.5 * (d / CONTACT.blurSigma) ** 2));
    }
    const wsum = weights.reduce((a, b) => a + b, 0);
    const blurSource = (axis, gamma) => /* glsl */`
        uniform sampler2D uSource;
        varying vec2 vUv;
        void main() {
          float total = 0.0;
          ${offsets.map((o, i) => `total += texture2D( uSource, vUv + vec2( ${axis === 'x' ? `${o.toFixed(6)}, 0.0` : `0.0, ${o.toFixed(6)}`} ) ).r * ${(weights[i] / wsum).toFixed(6)};`).join('\n          ')}
          gl_FragColor = vec4( vec3( ${gamma ? `pow( total, ${CONTACT.gain.toFixed(3)} )` : 'total'} ), 1.0 );
        }`;

    // The gamma rides the *second* pass only: applying it before the blur would
    // shape a hard-edged footprint and then smear the shaped result, which is
    // not the same curve and lifts the core as much as the penumbra.
    const blurX = this.track(new THREE.ShaderMaterial({
      name: 'contact-blur-x',
      uniforms: { uSource: { value: occlusion.texture } },
      vertexShader: fullscreenVertex,
      fragmentShader: blurSource('x', false),
      depthTest: false,
      depthWrite: false,
    }));
    const blurY = this.track(new THREE.ShaderMaterial({
      name: 'contact-blur-y',
      uniforms: { uSource: { value: scratch.texture } },
      vertexShader: fullscreenVertex,
      fragmentShader: blurSource('y', true),
      depthTest: false,
      depthWrite: false,
    }));

    const quadGeo = this.track(new THREE.PlaneGeometry(2, 2));
    const quadScene = new THREE.Scene();
    const quad = new THREE.Mesh(quadGeo, resolve);
    quad.frustumCulled = false;
    quadScene.add(quad);

    this._contact = {
      camera, depth, occlusion, scratch, depthMaterial, quadScene, quad,
      resolve, blurX, blurY,
      quadCamera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
      clear: new THREE.Color(),
    };

    /**
     * The uniform block the ground shader reads. `uContactArea` carries the
     * buffer's world origin as (minX, maxZ, 1/span) — maxZ rather than minZ
     * because the projector's up axis is -Z, so v runs the other way.
     */
    this._contactUniforms = {
      uContactMap: { value: occlusion.texture },
      uContactArea: { value: new THREE.Vector3(cx - half, cz + half, 1 / span) },
      // A *transmission* colour, not a paint colour: the factor the ground's
      // own outgoing light is multiplied by where the shadow is fully closed.
      // Deep, because the stage floor is now a *bright* sunlit lawn and a pool
      // that only takes a fifth off it does not read as contact at all. Tinted
      // rather than neutral per ART_BIBLE §2.1, and the tint does real work —
      // SHADOW_TINT attenuates red about four times harder than blue, so the
      // pool cools as it darkens instead of going grey.
      uContactTint: { value: new THREE.Color(LIGHT.SHADOW_TINT).multiplyScalar(0.45) },
      uContactStrength: { value: CONTACT.strength },
      /**
       * Floor albedo — two measured colours and a detail multiplier.
       *
       * Read off `bravely01.jpg`: the mown lawn's p90 is `#7e9659` over 200 491
       * masked pixels and the track's is a warm `#ae9d79`. Those are *rendered*
       * values, so what goes in as albedo is a stop brighter — the shading
       * model is expected to produce the measured result from it, which is the
       * same discipline `Flora.js` applies to every plant in the bed. The old
       * conditioning drove both toward one cool grey level, which is why the
       * previous stage floor was the same value everywhere and the plate's
       * lawn/track contrast could not exist on it.
       *
       * The forge's grass fBm stays, but only as `uGroundDetail`: a multiplier
       * centred on 1 whose swing is `y` about a nominal texture luminance `x`,
       * clamped so no fBm extreme can drive the floor to black or to white. It
       * supplies tiling variation and nothing else.
       */
      uLawnColor: { value: new THREE.Color(0x5f7233) },
      uPathColor: { value: new THREE.Color(0xd8c096) },
      uGroundDetail: { value: new THREE.Vector2(0.35, 0.85) },
      /** `(x0, z0, dx, dz)` of {@link PATH}, plus its feather, evaluated per
       *  fragment so the boundary is exact instead of quantised to the 7 m
       *  terrain tessellation the 900 m plane can afford. */
      uPathLine: { value: new THREE.Vector4(PATH.x0, PATH.z0, PATH.dx, PATH.dz) },
      uPathFeather: { value: PATH.feather },
      /** The band's far edge and its feathered end, so the track has two sides. */
      uPathBand: { value: new THREE.Vector2(PATH.width, PATH.width + PATH.feather) },
    };
  }

  /**
   * Enrol a staged figure with the projector.
   *
   * Outline hulls are skipped: an inverted hull is a copy of the mesh pushed
   * out along its own normals, so enrolling it would fatten every shadow by the
   * line weight and — worse — do it in *screen* pixels, which is a quantity the
   * projector's orthographic view has no meaning for.
   */
  static _markContactCasters(root) {
    root.traverse((o) => {
      if (!o.isMesh || o.userData?.isOutlineHull) return;
      o.layers.enable(CONTACT_LAYER);
    });
  }

  /**
   * Draw this frame's occlusion, as a service tick ahead of the main render.
   *
   * Every piece of renderer state this touches is stashed and restored: the
   * composer runs immediately afterwards against the same renderer, and a
   * leaked override material or clear colour would take the whole frame with
   * it. Shadow-map auto-update is suppressed for the pass because `render`
   * would otherwise re-run all four cascades for a camera that has no lights
   * in its layer at all.
   */
  _renderContactShadows() {
    const c = this._contact;
    if (!c || this._silhouette) return;
    const renderer = this.engine.renderer;
    const scene = this.scene;

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevAutoClear = renderer.autoClear;
    renderer.getClearColor(c.clear);
    const prevClearAlpha = renderer.getClearAlpha();

    scene.overrideMaterial = c.depthMaterial;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    // Black is "nothing overhead": `BasicDepthPacking` writes `1 - depth`, so a
    // cleared texel decodes as the far plane and `occAt` rejects it outright.
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(c.depth);
    // Cleared to 0 rather than 1, to pair with the material's `GreaterDepth`.
    // Done by hand because `render`'s own auto-clear would use the renderer's
    // standing clear depth and quietly undo it.
    renderer.state.buffers.depth.setClear(0);
    renderer.clear(true, true, false);
    renderer.autoClear = false;
    renderer.render(scene, c.camera);
    renderer.autoClear = prevAutoClear;
    renderer.state.buffers.depth.setClear(1);

    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;

    // Resolve, then blur separably. The quad carries one material at a time
    // rather than three quads carrying one each: the geometry, the camera and
    // the scene are identical for all three passes, and three copies of the
    // same object is three things to keep in step.
    c.quad.material = c.resolve;
    renderer.setRenderTarget(c.occlusion);
    renderer.render(c.quadScene, c.quadCamera);
    c.quad.material = c.blurX;
    renderer.setRenderTarget(c.scratch);
    renderer.render(c.quadScene, c.quadCamera);
    c.quad.material = c.blurY;
    renderer.setRenderTarget(c.occlusion);
    renderer.render(c.quadScene, c.quadCamera);

    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(c.clear, prevClearAlpha);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
  }

  /**
   * Condition the stage floor and splice the occlusion buffer into its shading.
   *
   * Two injections, at the two points in the standard fragment where each one
   * is the right operation:
   *
   *  - **Albedo** immediately after `<color_fragment>`, i.e. on `diffuseColor`
   *    before a single light has touched it. The lawn/track split is a
   *    statement about the *surface*, so it has to happen before the lighting
   *    rather than being painted onto the final pixel, where it would take the
   *    key's own modelling with it. Evaluating the track's boundary here — from
   *    the world position the vertex stage already forwards — is also the only
   *    way to get a 1.2 m feather onto a 900 m plane tessellated at 7 m.
   *  - **Occlusion** on `outgoingLight` immediately before `<opaque_fragment>`,
   *    which is after every light has been summed and *before* fog — so the
   *    shadow is a real reduction in the light leaving the surface and the
   *    atmosphere then washes it with distance exactly as it washes everything
   *    else. That ordering is the entire reason this reads where a blended
   *    decal did not.
   */
  _injectStageFloor(shader) {
    Object.assign(shader.uniforms, this._contactUniforms);
    shader.vertexShader = `varying vec3 vAwGround;\n${shader.vertexShader}`.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
	vAwGround = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
    );
    shader.fragmentShader = `uniform sampler2D uContactMap;
uniform vec3 uContactArea;
uniform vec3 uContactTint;
uniform float uContactStrength;
uniform vec3 uLawnColor;
uniform vec3 uPathColor;
uniform vec2 uGroundDetail;
uniform vec4 uPathLine;
uniform float uPathFeather;
uniform vec2 uPathBand;
varying vec3 vAwGround;
${shader.fragmentShader}`
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
	// The forge's grass fBm, demoted to a multiplier around 1. Clamped, so no
	// extreme of the noise can drive the floor to black or blow it out — it is
	// tiling variation, not the albedo.
	float lum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	float detail = clamp( 1.0 + ( lum - uGroundDetail.x ) * uGroundDetail.y, 0.55, 1.45 );
	float pathT = ( vAwGround.z - uPathLine.y ) * uPathLine.w - ( vAwGround.x - uPathLine.x ) * uPathLine.z;
	float onPath = smoothstep( 0.0, uPathFeather, pathT )
		* ( 1.0 - smoothstep( uPathBand.x, uPathBand.y, pathT ) );
	diffuseColor.rgb = mix( uLawnColor, uPathColor, onPath ) * detail;
}`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
	vec2 cUv = vec2( vAwGround.x - uContactArea.x, uContactArea.y - vAwGround.z ) * uContactArea.z;
	// The buffer covers the stage, not the 900 m field, so everything outside
	// it has to resolve to *no* occlusion rather than to the clamped border.
	vec2 inside = step( vec2( 0.0 ), cUv ) * step( cUv, vec2( 1.0 ) );
	float occ = texture2D( uContactMap, cUv ).r * inside.x * inside.y * uContactStrength;
	outgoingLight *= mix( vec3( 1.0 ), uContactTint, occ );
}
#include <opaque_fragment>`,
      );
  }

  /* --------------------------------------------------------------- staging */

  /**
   * Build the six roster characters and stage them across the middle of frame —
   * see {@link PARTY} for the measurements the line is solved against.
   *
   * `lighting` is passed so `ToonMaterial` aliases the rig's key/rim uniform
   * objects — that is what makes the whole party re-key on a time-of-day change
   * without a per-frame call — and `forge` so the toon ramp and detail normals
   * come from the shared library instead of the shader's internal fallback.
   *
   * **`outline: false`.** The inverted hull is off, and this is the second
   * reference correction in the file. `ANIME_PIPELINE` §4 specifies a 1.5–2.5 px
   * ink line and this stage used to ask for 2.5. Measured across four clean
   * silhouette crossings on the plate — hat against foliage, pauldron against
   * lavender, boot against the path, hair against sky — **not one shows a value
   * trough at the contour**: the darkest edge pixel on the hair crossing is 34
   * against a sky of 37, i.e. inside the noise. There is no ink line in this
   * reference, and a 2.5 px one on a 300 px figure was the single loudest thing
   * the client saw. `Outline.js` now also ships `enabled: false` by default; not
   * asking for it here is what makes the two agree.
   */
  _buildCast(forge) {
    const group = new THREE.Group();
    group.name = 'cast';

    // Built before they are placed, because the separation pass needs each
    // rig's solved reach and that only exists once the character does.
    const built = PARTY.map((slot) => buildCharacter(slot.id, forge, {
      lighting: this.lighting, outline: false,
      // The stage owns grounding now — see `_buildContactShadows`. The
      // factory's per-character decal is a second, weaker copy of the same
      // idea, and stacking the two only double-darkens the floor with the
      // wrong shape.
      contactShadow: false,
    }));
    const places = separateStagePlaces(PARTY_PLACES, built.map(personalRadius));

    PARTY.forEach((slot, i) => {
      const place = places[i];
      const character = built[i];
      character.root.position.set(place.x, groundHeight(place.x, place.z), place.z);
      // Square up to the off-frame threat, then swing `turn` radians back
      // toward the lens. The rig's forward is **+Z** — `CharacterFactory`'s
      // `hairlinePhi` states the convention outright, "+Z (forward) is
      // theta = pi/2" — so `headingTo` is already in rig space. The threat is
      // now to frame *right* (+X), i.e. a heading near +π/2, and the camera
      // stands on +Z, so opening toward the lens is a **subtraction**. Getting
      // that sign wrong turns the whole line away from the camera and ships six
      // painted faces pointing off-frame.
      character.root.rotation.y = headingTo(place, GAZE_ANCHOR) - slot.turn;
      // Idle is already playing from the factory; restate it so the clip is
      // explicit at the call site and a future pose change is one edit.
      character.animator.play('idle', { fade: 0 });
      // Every head tracks the same off-frame point, which is what makes a line
      // read as watching something rather than as posing for a portrait — and
      // it is the only cue the plate gives that there is anything to fight.
      // Partial weight, so the look leads the body without dragging the chest
      // round with it and undoing `turn` — see GAZE_WEIGHT.
      character.animator.lookAt?.(GAZE_ANCHOR, GAZE_WEIGHT);
      group.add(character.root);
      LookdevScene._markContactCasters(character.root);
      this.cast.push(character);
    });
    this.scene.add(group);
    this.castGroup = group;
    this.hero = this.cast[0];
  }

  /** 7x3 roughness/metalness grid — the standard PBR sanity check. */
  _buildSphereGrid(forge) {
    const group = new THREE.Group();
    group.name = 'sphere-grid';
    const geo = new THREE.SphereGeometry(0.36, 48, 32);
    this.track(geo);
    // Not a bare colour: ART_BIBLE §7.1 forbids an unmapped Standard material
    // anywhere in a build, and a probe sphere with no normal detail cannot show
    // whether the normal pipeline is even connected.
    const detail = forge.texture('marble/normal', { repeat: 2 });
    for (let m = 0; m < 3; m++) {
      for (let r = 0; r < 7; r++) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0xbfc6cc,
          roughness: r / 6,
          metalness: m / 2,
          normalMap: detail,
          normalScale: new THREE.Vector2(0.18, 0.18),
          envMapIntensity: 1,
        });
        this.track(mat);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(BAY.x + (r - 3) * 0.9, BAY_Y + 1.35 + m * 0.85, BAY.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
    }
    this.scene.add(group);
  }

  /**
   * A row of the named library materials, so texture work is legible.
   *
   * Laid out across the `materials` camera rather than away from it, and each
   * cube seated on the height field rather than on one sampled elevation: the
   * bay's ground rolls by several centimetres over the row's 7.6 m, which is
   * enough for the end cubes to hover or sink and for their contact shadows to
   * disagree with everything else in the bay.
   *
   * The 25° yaw is deliberate and uniform — a cube presented square-on shows
   * one lit face and no form, so every entry is turned enough to put a lit
   * face, a terminator and a shadow face in the same silhouette.
   */
  _buildMaterialBar(forge) {
    const keys = ['stone', 'marble', 'wood', 'bark', 'cloth', 'leather', 'steel', 'gold', 'crystal'];
    const SIZE = 0.72;
    const PITCH = 0.95;
    const geo = new THREE.BoxGeometry(SIZE, SIZE, SIZE);
    this.track(geo);
    const group = new THREE.Group();
    group.name = 'material-bar';
    keys.forEach((key, i) => {
      const mesh = new THREE.Mesh(geo, forge.material(key));
      const x = BAR.x + (i - (keys.length - 1) / 2) * PITCH;
      const z = BAR.z;
      mesh.position.set(x, this._groundHeight(x, z) + SIZE * 0.5, z);
      mesh.rotation.y = 0.44;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    });
    this.scene.add(group);
  }

  /**
   * Chibi scale proxy — 3.25 heads tall, matching REFERENCE_TARGET.md.
   * Kept alongside the real cast so a factory regression that changes body
   * proportions shows up as a mismatch against a fixed reference, not as a
   * vague feeling that the party got taller.
   */
  _buildScaleProxy(forge) {
    const group = new THREE.Group();
    group.name = 'scale-proxy';
    const mat = this.track(new THREE.MeshStandardMaterial({
      color: 0x9aa4ae,
      roughness: 0.62,
      metalness: 0,
      normalMap: forge.texture('cloth/normal', { repeat: 3 }),
      normalScale: new THREE.Vector2(0.35, 0.35),
    }));
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.26, 8, 24), mat);
    body.position.y = 0.35;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.225, 32, 24), mat);
    head.position.y = 0.9;
    for (const m of [body, head]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.track(m.geometry);
      group.add(m);
    }
    group.position.set(BAY.x + 2.4, BAY_Y, BAY.z + 1.2);
    this.scene.add(group);
    this.proxy = group;
  }

  /* ---------------------------------------------------------------- poses */

  poseCamera(name) {
    // Unknown names fall back to the shipped battle frame rather than to a
    // diagnostic one: a typo in a capture scenario should still produce the
    // frame someone is trying to look at.
    const pose = CAMERA_POSES[name] ?? CAMERA_POSES.battle;
    this._pose = name in CAMERA_POSES ? name : 'battle';
    this._setSilhouette(pose.silhouette === true);

    // Two kinds of entry live in the table. Most are station points, authored
    // in world metres because their subject is the stage itself and the stage
    // does not move. `subject` poses are solved here instead, against the live
    // head bone of a named character, because their subject is a face and a
    // face's world position is downstream of the diagonal, of `turn`, and of
    // wherever the gaze anchor ended up — three numbers that have each moved
    // more than once. A portrait aimed at a constant is a portrait that goes
    // stale silently.
    const solved = pose.subject ? this._solveSubjectPose(pose) : pose;

    this.camera.position.set(...solved.pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(...solved.look);
    this.camera.fov = pose.fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    // PostFX reads `scene.focusDistance` every frame; setting both it and the
    // aperture means a pose change is a lens change, which is what the bible's
    // "a pose is a composition" clause actually asks for.
    this.focusDistance = solved.focus;
    const postfx = this.engine.get('postfx');
    if (postfx) {
      // Order matters: `setDof` clears any tracked target, so the subject
      // hand-off has to follow it. A station pose leaves the target cleared,
      // which is correct — its focal plane is a place in the world, not a face.
      //
      // `bokeh` is the third argument and closing the aperture is not a
      // substitute for it. `DofPass` carries a *far-field floor* — a guaranteed
      // 9.2 px of background defocus that ramps in over three depth doublings
      // past the focal plane, independent of the f-number — so an f/22 stage
      // still ships a soft cherry tree at 12 m, which is exactly what the first
      // capture of this staging showed. Passing 0 zeroes both the physical CoC
      // and that floor, which `PostFX` documents as the way a scene that wants
      // a genuinely sharp stage asks for one. The plate is sharp from the
      // near boots to the far boulders, so the meadow poses ask for it and the
      // portrait — the one frame that wants its background gone — does not.
      postfx.setDof(solved.focus, pose.aperture, pose.bokeh);
      if (solved.focusTarget) postfx.focusOn(solved.focusTarget);
      postfx.setGrade(pose.grade ?? 'battle', 0);
    }
    // The rig fits its cascades to the active camera; a cut without this leaves
    // the first frame after the cut shadowed for the previous framing.
    this.lighting?.sync();
  }

  /**
   * Turn a subject-relative portrait spec into a station point and an aim.
   *
   * The head bone's world quaternion already carries everything that decides
   * where the face points — the root's `turn`, the idle clip's own upper-body
   * motion, and the spring-damped look-at — so taking its forward axis is the
   * only way to be sure the lens ends up in front of a face rather than in
   * front of where the body happens to be aimed. `swing` then slews that axis
   * a fraction of the way round to the battle camera's bearing, which is what
   * turns a flat frontal mugshot into a lit three-quarter without needing a
   * second key light.
   *
   * `range` is measured from the head, not from the feet, so the frame does not
   * change size when the roster's heights do; `rise` and `aim` are in the same
   * units, i.e. metres at the subject, so the thirds placement holds at any
   * focal length.
   *
   * Falls back to the battle frame if the named subject is not on stage — a
   * portrait of nobody would otherwise point the camera at the origin and ship
   * a frame of empty grass.
   */
  _solveSubjectPose(pose) {
    const subject = this.cast.find((c) => c.def?.id === pose.subject) ?? this.hero;
    const head = subject?.bones?.head;
    if (!head) return CAMERA_POSES.battle;

    // The animator writes bone rotations during `update`, so the matrices are
    // one flush behind whenever a pose change lands between ticks.
    subject.root.updateMatrixWorld(true);
    const quat = head.getWorldQuaternion(new THREE.Quaternion());

    // Aim at the **painted eye line**, not at the head bone.
    //
    // The bone sits at the top of the neck, roughly a third of a head-radius
    // below where the eyes are drawn, and `Rig.computeMetrics` already solves
    // the eye line's height from `FACE_LAYOUT.eyeY` so the geometry and the
    // texture cannot disagree about it. Reading it back here is what makes this
    // a portrait of a face rather than of a jaw: the framing, the thirds
    // placement and — most importantly — the focal plane are all measured to
    // the feature the frame exists to show. Carrying the offset through the
    // head's world quaternion keeps it correct while the idle clip and the
    // look-at are turning the skull.
    const m = subject.metrics;
    const eye = new THREE.Vector3(
      0,
      (m?.eye?.y ?? 0) - (m?.joints?.head?.y ?? 0),
      // Forward to the skull surface, so the plane sits on the painted eye
      // rather than inside the cranium — at f/11 that is a third of the
      // available depth of field.
      m?.head?.rz ? m.head.rz * 0.86 : 0,
    ).applyQuaternion(quat).add(new THREE.Vector3().setFromMatrixPosition(head.matrixWorld));

    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
    facing.y = 0;
    if (facing.lengthSq() < 1e-6) facing.set(0, 0, 1);
    facing.normalize();

    // Bearings, not vectors: slerping two horizontal directions is an angular
    // lerp, and doing it in angle space keeps the result unit-length for free
    // and cannot degenerate when the two happen to be antiparallel.
    const faceBearing = Math.atan2(facing.x, facing.z);
    const camBearing = Math.atan2(STAGE.camX - eye.x, STAGE.camZ - eye.z);
    // Shortest way round, so a subject facing near the ±π seam does not swing
    // the long way and put the lens behind its own head.
    let delta = camBearing - faceBearing;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    const bearing = faceBearing + delta * pose.swing;

    // `frame` is metres of subject height; the range that delivers it is pure
    // trigonometry on the pose's own lens, so changing the focal length
    // re-solves the distance instead of silently re-cropping the portrait.
    const range = pose.frame !== undefined
      ? pose.frame / (2 * Math.tan((pose.fov * Math.PI) / 360))
      : pose.range;

    const pos = [
      eye.x + Math.sin(bearing) * range,
      eye.y + pose.rise,
      eye.z + Math.cos(bearing) * range,
    ];
    // Camera right on the ground plane. The view axis is -(sin b, 0, cos b),
    // so `cross(view, up)` is (cos b, 0, -sin b): pushing the aim point along
    // it slides the subject to frame *left*, which is the direction `aim.right`
    // is authored in.
    const rx = Math.cos(bearing);
    const rz = -Math.sin(bearing);
    const look = [
      eye.x + rx * pose.aim.right,
      eye.y + pose.aim.up,
      eye.z + rz * pose.aim.right,
    ];
    const focus = Math.hypot(pos[0] - eye.x, pos[1] - eye.y, pos[2] - eye.z);
    // `focusOn` is what actually keeps the eyes sharp: the subject breathes and
    // the look-at springs, so a focal plane pinned to one frame's measurement
    // drifts off the face within a second. The scalar is still returned because
    // PostFX needs somewhere to start from before the tracker's first tick.
    return { pos, look, focus, focusTarget: head };
  }

  /** Enter or leave the matte pass. See {@link MATTE}. */
  _setSilhouette(on) {
    if (on === this._silhouette) return;
    this._silhouette = on;
    if (on) this._enterMatte();
    else this._exitMatte();
  }

  /**
   * Render the shipped battle composition as flat black shapes on flat white.
   *
   * Every subject surface swaps to one unlit black material and the ground to
   * one unlit white one, so no shading path — cascade, probe, toon shadow floor,
   * emissive crown, unlit catch-light — can put a value anywhere between the
   * two. That is a stronger guarantee than the previous approach could give at
   * any tuning, and it is a much shorter one: the old version had to hunt down
   * every individually-unlit mesh in the cast by material identity and hide it,
   * which is a list that goes stale the moment a character gains a rune or a
   * lantern. A material swap has no list.
   *
   * Outline hulls are hidden rather than swapped. A hull is the mesh pushed out
   * along its normals by a *screen-space* width, so leaving it in would fatten
   * every silhouette by the ink weight — measuring shapes through their own
   * outline is measuring the outline.
   *
   * Everything that is not a subject or the floor leaves frame: the sky dome,
   * the horizon skirt, the whole meadow and the petals. A silhouette check
   * wants an empty backdrop, and the background clear carries the same white as
   * the ground so the horizon line goes with them.
   *
   * The HUD goes with them, and it is the one occluder this pass cannot reach
   * by hiding an `Object3D`: `BattleUI` is DOM composited over the canvas, so
   * no material swap and no `visible` flag touches it. Left up it costs the
   * check both of its premises at once — the right-hand stack is opaque gold,
   * green and blue over a frame whose entire claim is that it holds two values,
   * and at 22% of frame width it lands squarely on the rear slot, so the party
   * member most at risk of an indistinct silhouette is the one the diagnostic
   * cannot see. `_exitMatte` puts it back, because every other pose in the
   * sheet is a shipped composition and the plate carries the stack.
   */
  _enterMatte() {
    const hide = (obj) => {
      if (!obj || !obj.visible) return;
      obj.visible = false;
      this._matteHidden.push(obj);
    };
    const matte = (root) => {
      root.traverse((o) => {
        if (!o.isMesh) return;
        if (o.userData?.isOutlineHull) { hide(o); return; }
        this._matteSwap.set(o, o.material);
        o.material = this.matteSubject;
      });
    };

    matte(this.castGroup);

    this._matteSwap.set(this.ground, this.ground.material);
    this.ground.material = this.matteGround;
    this.ground.receiveShadow = false;

    hide(this.sky?.mesh);
    hide(this.skirt);
    hide(this.meadow);
    hide(this.motes);

    this.engine.get('ui')?.battle?.hide();

    this._sceneBackground = this.scene.background;
    this.scene.background = this.matteBackground;
    this.scene.environment = null;
  }

  /** Undo {@link _enterMatte}, restoring every material and visibility flag. */
  _exitMatte() {
    for (const [mesh, material] of this._matteSwap) mesh.material = material;
    this._matteSwap.clear();
    for (const obj of this._matteHidden) obj.visible = true;
    this._matteHidden.length = 0;
    this.ground.receiveShadow = true;
    this.scene.background = this._sceneBackground ?? null;
    this.scene.environment = this._environment ?? null;
    // Unconditional, and safe: `show()` is idempotent, and the stack is only
    // ever hidden here in the first place because `_mountHud` put it up.
    this.engine.get('ui')?.battle?.show();
  }

  /**
   * Runs as a service registered directly after `lighting`, i.e. once the rig
   * has already written this frame's state.
   */
  _afterRig() {
    // ART_BIBLE §2.1 specifies a *two-ended* fog: FOG_NEAR cool teal at ground
    // level and short distances, FOG_FAR warm parchment at horizon distance,
    // "so depth reads as cool→warm". `FogExp2` carries one colour, and Sky
    // drives it from the time-of-day table. A light bias toward the cool end is
    // the closest a single-colour fog gets to the specified pair — see
    // FOG_COOLING for why it is now light rather than heavy.
    const fog = this.scene.fog;
    if (fog) fog.color.lerp(FOG_NEAR_TEAL, FOG_COOLING);
  }

  setTimeOfDay(t) {
    this.sky?.setTimeOfDay(t);
    // The probe is baked from the dome, so it is stale the instant the clock
    // moves; without this the metal row keeps reflecting the previous hour.
    this._refreshEnvironment();
    this.lighting?.sync();
  }

  /* ----------------------------------------------------------------- tick */

  update(dt) {
    // Sky and Lighting tick as registered services; calling them here as well
    // would double-integrate the weather crossfade and the rig easing.

    // Under SwiftShader the first textured frames can take a quarter of a
    // second. Feeding that straight into six verlet cloth rigs means 15
    // substeps each and a visible whip; clamping keeps the pose stable and
    // costs nothing at real frame rates.
    const step = Math.min(dt, 1 / 30);
    for (const c of this.cast) c.update(step);

    const t = this.engine.elapsed;

    // Drive the meadow's gust from the same clamped step the cloth runs on.
    // Flora falls back to a wall clock of its own if nobody claims it, which is
    // right for a scene that just drops flora in and wrong for a capture: two
    // runs at the same seed have to bend the same way.
    updateFlora(step);

    const pos = this.motes.geometry.getAttribute('position');
    const seed = this._moteSeed;
    for (let i = 0; i < pos.count; i++) {
      const phase = seed[i * 3];
      const fall = seed[i * 3 + 1];
      const sway = seed[i * 3 + 2];
      let y = pos.getY(i) - fall * step;
      if (y < 0.02) y += CHERRY.drift;
      pos.setY(i, y);
      // Petals are flat and light: they scull sideways as they fall rather
      // than dropping straight, which is the whole reason to animate them.
      pos.setX(i, pos.getX(i) + Math.sin(t * 0.55 + phase) * sway * step);
      pos.setZ(i, pos.getZ(i) + Math.cos(t * 0.41 + phase * 1.7) * sway * 0.6 * step);
    }
    pos.needsUpdate = true;
  }

  resize(w, h) {
    if (!this.camera) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async unmount() {
    // The portrait pose hands PostFX a live head bone to track. Dropping the
    // cast without clearing it would leave the composer measuring its focal
    // plane against a disposed skeleton in whatever scene comes next.
    this.engine.get('postfx')?.focusOn(null);
    // Leave the matte pass before anything is torn down, so every mesh is
    // holding its own material again when `disposeTree` walks the graph — a
    // scene unmounted mid-diagnostic would otherwise hand the sweep six copies
    // of one shared material and none of the originals.
    this._setSilhouette(false);
    for (const c of this.cast) c.dispose();
    this.cast.length = 0;
    // Flora's builders own their own geometry and materials and hand back a
    // `dispose()` for them. `Scene.track` never saw them, so this is the only
    // place they can be released — a meadow is 200k+ triangles across a dozen
    // instanced meshes and leaking it once per scene change is not survivable.
    for (const root of this._flora) root.userData?.dispose?.();
    this._flora.length = 0;
    this.engine.get('ui')?.battle?.hide();
    // Both projector targets, its depth material, the resolve shader and the
    // quad geometry are tracked. Dropping the handle is what stops the service
    // tick — which has already been unregistered below — from ever finding a
    // disposed render target if a teardown races a frame.
    this._contact = null;
    this._contactUniforms = null;
    // Services outlive the scene that registered them; leaving a disposed rig
    // in the registry would hand the next scene a dead CSM.
    for (const name of ['sky', 'lighting', 'lookdev-stage']) {
      this.engine.services.delete(name);
    }
    this.scene.environment = null;
    this._environment = null;
    await super.unmount();
  }
}
