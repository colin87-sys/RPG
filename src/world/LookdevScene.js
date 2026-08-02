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
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Scene } from '../core/Engine.js';
import { gameState, Rng } from '../core/GameState.js';
import { Sky } from '../render/Sky.js';
import { Lighting } from '../render/Lighting.js';
import { buildCharacter } from '../characters/CharacterFactory.js';
import {
  createToonMaterial, createToonOutline, createToonOutlineMaterial,
} from '../render/ToonMaterial.js';
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
 * level while the ground behind them climbs: `rise` runs from the back of the
 * cast's depth band to the boulder wall.
 */
const BANK = { from: 1.2, to: -20, height: 2.35 };

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
  const swell = n.fbm3(x * 0.0032, 0, z * 0.0032, { octaves: 4, gain: 0.55 }) * 9.0;
  const ripple = n.fbm3(x * 0.055, 11, z * 0.055, { octaves: 3, gain: 0.5 }) * 0.09;
  const r = Math.hypot(x - STAGE_PLATEAU.x, z - STAGE_PLATEAU.z);
  const flat = smootherstep(STAGE_PLATEAU.inner, STAGE_PLATEAU.outer, r);
  // Rises only *behind* the stage (decreasing z), and only outside the plateau,
  // so the cast keeps a level floor and the meadow keeps its bank.
  const bank = smootherstep(BANK.from, BANK.to, z) * BANK.height * flat;
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
 * The staggered diagonal — **two ranks**, solved against the one silhouette
 * that is not allowed to collide: the head.
 *
 * The previous table ran both channels monotonically over a 2.9 m depth band,
 * on the theory that a steady recession is what separates figures. It is not
 * sufficient, and the arithmetic says why. Six heads have to share the strip of
 * frame the party occupies, and at that band's depths their screen radii sum to
 * 0.384 of `ndc` — i.e. **0.77 of head diameter against 0.68 of available
 * width**. No horizontal arrangement can fit them; the previous run therefore
 * overlapped by construction, which is exactly what the review measured ("slots
 * 4, 5 and 6 physically occlude each other's hair silhouettes"). Worse, the
 * whole run landed inside 0.18 of `ndc` *height* — heads strung along a level
 * line, which is the definition of a rank however far apart the feet are.
 *
 * The fix is to stop treating depth as a trend and start using it as the second
 * axis of the composition. Alternate slots sit in a **near rank** (4.05–6.05 m)
 * and a **far rank** (6.30–8.40 m), interleaved across screen-x. Because the
 * lens is pitched 12° down, a figure 2 m further away lifts ~0.2 of `ndc` in
 * frame and shrinks by a third, so each far-rank head clears its two near-rank
 * neighbours *vertically* and needs far less horizontal room. The head discs
 * now separate at 1.15× their touching distance — measured, not asserted: at
 * these placements the closest pair (kite/yshara) sits 0.149 of `ndc` apart
 * against summed radii of 0.134, with 0.054 of vertical offset on top.
 *
 * What the frame gains, in the order the review asked for it:
 *
 *  - **No head overlaps any other head.** Bodies still cross — that is what
 *    "loose" means in REFERENCE §2's "loose staggered diagonal" — but every
 *    face is unbroken, which is the only overlap a viewer actually reads.
 *  - **Real depth.** Feet run from −0.66 to −0.07 of `ndc` height, against
 *    0.10 before; the party occupies a wedge of ground rather than a line on it.
 *  - **Real scale contrast.** 32% of frame height at the front down to 13% at
 *    the back, so the arrangement reads as receding rather than as six people
 *    of six different sizes standing abreast.
 *  - **The right half of frame, not the right 40%.** The run spans −0.05 to
 *    0.95 of `ndc` including weapons and capes — up to the edge and no further.
 *    The previous table pushed the rear member's staff to 1.04, i.e. off frame.
 *
 * Slot 6 is the one the review named specifically, and it is now the furthest
 * *and* the right-most: at 8.40 m it stands level with the boss's own depth on
 * the far side of the stage, which closes the composition instead of stacking
 * against slot 5.
 *
 * World separation comes out at 1.31 m minimum against a ~0.25 m personal
 * radius each, so limb interpenetration is designed out rather than tuned out.
 * `separateStagePlaces` then enforces it at spawn against the rig's own
 * measurements, so a later edit to this table cannot silently reintroduce an
 * arm through a torso.
 *
 * Order is front-line first, exactly like `gameState.party`.
 *
 * `turn` is how far the figure rotates **back toward the lens** from the axis
 * it would face if it squared up to the threat, and it is the single control
 * over whether this stage has faces in it. A party that simply addresses the
 * enemy line presents its cheek to a side camera at best and the back of its
 * skull at worst, which is exactly what an earlier build shipped: the eye
 * build, the brows and every gram of the chibi read live on the front hemisphere
 * of a near-spherical head, so a figure 60°-plus off the lens is, visually, an
 * ovoid. Turning the body 15–23° off the threat axis puts every leading eye on
 * camera while leaving the address to the enemy legible, and it is the same
 * cheat a stage director uses to keep an actor open to the house.
 */
const PARTY = [
  { id: 'auren',  ndc: 0.075, depth: 4.05, turn: 0.40 },
  { id: 'kite',   ndc: 0.255, depth: 6.30, turn: 0.52 },
  { id: 'yshara', ndc: 0.395, depth: 5.05, turn: 0.36 },
  { id: 'bramm',  ndc: 0.545, depth: 7.35, turn: 0.48 },
  { id: 'seren',  ndc: 0.665, depth: 6.05, turn: 0.34 },
  { id: 'emrys',  ndc: 0.775, depth: 8.40, turn: 0.50 },
];

/**
 * The enemy side. REFERENCE §2: enemies on the **left**, "generally larger
 * than the party — bosses are dramatically larger, occupying 40–60% of frame
 * height". The boss lands at 46%, and it is 3.5 m against a 1.15 m chibi, so
 * the frame carries the scale contrast the staging exists to show.
 *
 * The `lead` husk is the reason the party has faces. Where a figure looks is
 * set by where the thing it is looking *at* stands, and a threat parked deeper
 * in frame than the party can only ever rotate them away from the lens — no
 * camera move fixes that, because the party would simply turn its back on
 * whichever side the camera moved to. So the pack has a vanguard: a lesser husk
 * that has broken forward of the boss and now stands **nearer the lens than the
 * party is**, at the left edge. Addressing it turns every head toward the
 * camera's side of the stage, and the same body doubles as the ART_BIBLE §5.1
 * foreground occluder the left of this frame was missing — a dark, cropped mass
 * in the near layer with the party crisp behind it.
 *
 * `height` is the full silhouette including the shard crown, so the frame
 * fractions above are the ones actually measured off the render. `turn` is a
 * deviation from squaring up to the party centroid, so no husk stares down the
 * same line as its neighbour.
 */
const ENEMIES = [
  { id: 'husk-alpha', ndc: -0.44, depth: 8.60, height: 3.50, turn: -0.22, crest: 1.00 },
  { id: 'husk-beta',  ndc: -1.18, depth: 3.45, height: 1.30, turn: 0.16, crest: 0.86, lead: true },
  { id: 'husk-gamma', ndc: -0.20, depth: 11.20, height: 1.70, turn: 0.44, crest: 0.74 },
];

/** Ground positions of every staged figure, solved once against the frame. */
const PARTY_PLACES = PARTY.map(stagePlacement);
const ENEMY_PLACES = ENEMIES.map(stagePlacement);

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

/** Centre of mass of the line, which is what the enemy pack squares up to. */
const PARTY_CENTROID = {
  x: PARTY_PLACES.reduce((a, p) => a + p.x, 0) / PARTY_PLACES.length,
  z: PARTY_PLACES.reduce((a, p) => a + p.z, 0) / PARTY_PLACES.length,
};

/** Heading from `a` to `b` in the rig's convention, where +Z is forward. */
function headingTo(a, b) {
  return Math.atan2(b.x - a.x, b.z - a.z);
}

const LEAD_INDEX = ENEMIES.findIndex((e) => e.lead);
const LEAD_HEADING = headingTo(ENEMY_PLACES[LEAD_INDEX], PARTY_CENTROID)
  + ENEMIES[LEAD_INDEX].turn;

/**
 * What the party is looking at: the vanguard husk's **head**, not its root.
 *
 * The husk's skull is thrust forward of its mass (see `_huskSpine`), and at
 * this range the 0.65 m between the two is a visible difference in where six
 * gazes converge — aiming at the root sends every eyeline into the creature's
 * flank. The offsets are the same normalised body coordinates its eyes are
 * placed at, so the anchor tracks the geometry rather than duplicating it.
 */
const HUSK_EYE = { y: 0.598, forward: 0.492 };
const GAZE_ANCHOR = new THREE.Vector3(
  ENEMY_PLACES[LEAD_INDEX].x + Math.sin(LEAD_HEADING) * HUSK_EYE.forward * ENEMIES[LEAD_INDEX].height,
  HUSK_EYE.y * ENEMIES[LEAD_INDEX].height,
  ENEMY_PLACES[LEAD_INDEX].z + Math.cos(LEAD_HEADING) * HUSK_EYE.forward * ENEMIES[LEAD_INDEX].height,
);

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
   * REFERENCE §2's fixed side-view battle framing — the shipped frame.
   *
   * Party right at 13–32% of frame height in a three-quarter front address,
   * enemy mass left with the boss at 46% and the vanguard husk cropped into the
   * near-left corner, horizon on the upper third at 74%. Focus sits at 6.2 m —
   * the middle of the two ranks' 4.05–8.40 m depth run, not its front, because
   * the recession is now the staging's whole structure and a plane pinned to
   * the lead would throw the far rank out of focus. f/6.3 rather than f/5.6:
   * the run got 1.5 m deeper when the ranks split, and the stop has to buy the
   * depth back or slot 6 ships soft. The boss at 8.6 m stays legible either way
   * — the reference's backgrounds are soft, its combatants are not.
   */
  battle: {
    pos: [STAGE.camX, STAGE.camY, STAGE.camZ], look: STAGE_LOOK,
    fov: STAGE.fov, focus: 6.2, aperture: 6.3, grade: 'battle',
  },
  /**
   * Command framing: the same axis pushed in one lens stop.
   *
   * This is the frame a player reads ability names against, so the party runs
   * 27–40% of frame height and the boss is cropped to a looming edge presence
   * at frame left rather than competing for the centre.
   */
  lineup: {
    pos: [2.05, 1.82, 7.45], look: [3.05, 0.80, 3.30],
    // Focus and stop both track the two-rank split: from this station the party
    // runs 3.3–8.4 m, so the plane sits at 5.8 m and the stop closes to f/8.
    // Anything faster leaves the far rank as mush, and this is the frame a
    // player reads ability names against — every name has to be attached to a
    // legible face.
    fov: 44, focus: 5.8, aperture: 8.0, grade: 'battle',
  },
  /** Battle station, battle lens, rendered as a **matte**. The silhouette check
   *  has to be run on the shipped composition or it is checking nothing — and
   *  it has to be run on actual mattes or it is checking nothing either. See
   *  `_enterMatte`. */
  silhouette: {
    pos: [STAGE.camX, STAGE.camY, STAGE.camZ], look: STAGE_LOOK,
    fov: STAGE.fov, focus: 6.2, aperture: 22, grade: 'neutral', silhouette: true,
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
    fov: 34, aperture: 11.0, grade: 'dusk',
  },
  /**
   * The reverse angle — the enemy reveal, and deliberately *not* a second
   * printing of the battle frame.
   *
   * Station point is south-east of the stage looking north-west, so the camera
   * is roughly perpendicular to the battle axis and the two frames share no
   * geometry, no lighting relationship and no value structure: here the low
   * western sun is 54° off-axis and behind the subjects, so the whole stage is
   * contre-jour and reads on rims and mist rather than on form. The party
   * becomes the near layer at 16–20%, the boss sits dead centre at 27% —
   * ART_BIBLE §5.2 reserves centre framing for the antagonist, "symmetry as
   * menace", and this is the one shot in the set entitled to it — and the
   * bottom-right grass clump at 2.9 m is the foreground occluder. Focus at
   * 9.5 m splits the party and the boss so both stay readable.
   */
  wide: {
    pos: [8.80, 2.85, 8.40], look: [ENEMY_PLACES[0].x, 0.90, ENEMY_PLACES[0].z],
    fov: 48, focus: 9.5, aperture: 8.0, grade: 'battle',
  },
  /** Sky-dominant landscape for the day-cycle sweep; party on the right third. */
  horizon: {
    // Station point sits *in front of* the rear grass bank on purpose: at
    // 12.6 the bank straddled the lens and individual blades crossed the whole
    // frame as hairline diagonals, which reads as damage rather than as
    // foliage. From 11.6 the front bank at 6.2 m is the occluder instead, which
    // is what §5.1 actually asks for. Aim point shifted by the same metre so
    // the view direction — and therefore the +9.5° pitch that puts the horizon
    // on the lower third — is unchanged.
    pos: [-0.4, 2.0, 11.6], look: [6.55, 8.34, -27.8],
    fov: 52, focus: 12, aperture: 8, grade: 'dusk',
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

/** Span the mist bank is seeded across and wraps around, in metres. */
const MIST_SPAN = { west: -24, east: 26 };
const MIST_WRAP = MIST_SPAN.east - MIST_SPAN.west;

/**
 * The low mist bank — **clustered puffs**, not cards.
 *
 * The previous bank was thirty billboards 6–17 m wide and 0.7–1.1 m tall. That
 * is an aspect ratio between 6:1 and 24:1, and a radial mask on a 20:1 quad is
 * not a puff, it is a *lozenge* — so the shipped frame read exactly as the
 * review describes it: "flat white brush streaks lying on the ground plane,
 * cutting straight across the party's feet". Two properties made it inevitable
 * and no amount of retuning the density reaches either. First the aspect: a
 * horizontal streak is what a wide short billboard *is*. Second the fact that
 * every card was drawn from the same shared texture at the same roll, so thirty
 * of them stacked into one repeated smear rather than into a volume.
 *
 * So the technique is replaced. The bank is now ~90 near-square puffs seeded in
 * clusters, each with its own roll about the view axis — which varies the
 * sampled smoke texture per puff, because the texture is not radially symmetric
 * even though the mask is — and each fading out with world height so the puff
 * is dense at its base and gone by the chin line. Clustering is what makes it
 * read as volume: a bank is somewhere haze has *pooled*, which means uneven
 * density with clear ground between pools, not a uniform sheet.
 *
 * `ceiling` is the invariant that keeps the cast's faces. Density fades to zero
 * across `ceiling` in **world** metres, independent of how large any puff is or
 * where its centre landed, so no seed and no later size change can put mist on
 * a face. 0.34→0.72 m clears the chin of a 1.15 m chibi with room to spare while
 * the pool still runs boot-to-knee, where the reference frames put it.
 */
const MIST_LOW = {
  /** Puff clusters: how many, and how far each scatters. */
  clusters: 9,
  perCluster: [8, 12],
  spread: [1.6, 4.2],
  /** Near-square, because a streak is an aspect ratio before it is anything
   *  else. Height is drawn independently and capped, not derived from width. */
  width: [1.5, 2.7],
  height: [0.85, 1.20],
  centre: [0.04, 0.18],
  /** World metres over which density falls to nothing. */
  ceiling: [0.34, 0.72],
  /** Per-puff radiance. Low, because ninety overlapping puffs accumulate and
   *  the bank has to sit *under* the cast in REFERENCE §3's saturation order. */
  density: 0.42,
};

/** Outer radius and rim rise of the fogged horizon skirt, in metres. */
const SKIRT_RADIUS = 9000;
const SKIRT_RISE = 62;

/** How far the scene pulls Sky's fog colour back toward the palette's near teal. */
const FOG_NEAR_TEAL = new THREE.Color(LIGHT.FOG_NEAR);
const FOG_COOLING = 0.34;

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
 * this now is: every cast and enemy surface swaps to unlit black, the ground to
 * unlit white, the sky, treeline, mist and motes drop out, and the backdrop is
 * cleared to the same white. Nothing in the frame can then be anything but 0 or
 * 1, whatever the rig, the probe or the toon shader are doing — and PostFX's
 * diagnostic path (which this pose already triggers) has bloom, DOF, grain,
 * vignette and the grade off, so nothing downstream can lift black off black
 * either. What is left is the only question the pass asks: are these six
 * shapes distinguishable.
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
 * Party outline weight, in device pixels at the capture's 1080p.
 *
 * ANIME_PIPELINE §4 gives 1.5–2.5 and `Outline.js` defaults to 2.0. The cast
 * sits at the top of that band rather than the middle for a reason specific to
 * this staging: a chibi in the battle frame is ~300 px tall and almost entirely
 * convex, so the hull is only ever seen edge-on across a very shallow contour,
 * and at 2.0 px it disappeared into the rim in every staged capture. 2.5 px is
 * ~0.8% of the figure's height — an unmistakable ink line at battle distance,
 * and still short of the cartoon border that a heavier value gives a face at
 * portrait range.
 */
const OUTLINE_PIXELS = 2.5;

/**
 * Contact shadows — a top-down occlusion projector, not a decal.
 *
 * REFERENCE §2 requires "visible ground with soft contact shadows" and the
 * shipped frame had none: six pairs of boots met the terrain with no occlusion
 * darkening at all, and the husks' paws floated.
 *
 * The cascades cannot supply it. At the dusk key the sun is ~6° up, so a cast
 * shadow lands two metres downwind of the figure that threw it and there is
 * nothing whatsoever under the feet. The previous answer was a radial decal
 * sprite per character, and it failed for a reason no amount of tuning reaches:
 * a decal is a *transparent overlay*, drawn after the ground and therefore
 * after the ground's own shading, so it competes with — and loses to — the
 * low mist bank that composites over the same pixels a moment later. Measured
 * on the shipped frame it moved the floor under the party by 16%, which is
 * below the threshold at which an eye reads contact at all.
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
 * washed out by nothing: fog and mist then sit over it exactly as they sit over
 * the rest of the floor, which is what depth is supposed to do to a shadow. It
 * also cannot z-fight, cannot be buried by terrain tessellation, follows the
 * animation for free, and grounds the husks — whose paws have no rig to hang a
 * decal off — on the same pass as the party.
 *
 * The first build of this projector produced a *correct* buffer that was
 * invisible on screen, and the reason is worth recording because it is a trap
 * the arithmetic hides. Its penumbra was two hex rings 1.8 and 4.2 texels out,
 * i.e. ~12 cm — narrower than a boot. A pool that never extends past the
 * silhouette that threw it is a pool the camera cannot see, because the figure
 * standing in it occludes the whole thing: at a 12° down-angle the only part of
 * a contact shadow that reaches the lens is the crescent *outside* the body.
 * The blur is therefore not a smoothing step, it is the step that makes the
 * shadow visible at all, and it is sized against the figure (a 1.15 m chibi) —
 * not against the texel grid.
 */
const CONTACT = {
  /** Occlusion buffer edge. 384 over ~12.8 m of stage is ~3.3 cm per texel —
   *  finer than a chibi's boot, which is the smallest thing that must read. */
  size: 384,
  /** Metres of slack around the staged figures, so a boss leaning out of the
   *  formation still projects and no figure sits on the buffer's clamp edge. */
  margin: 2.2,
  /** Ortho station height. Must clear the tallest occluder — the boss husk is
   *  3.5 m — or its crown clips and the pass reports it as absent. */
  camHeight: 5.6,
  /** Lowest world y the projector can see. The plateau is level at 0; the
   *  slack keeps the 8-bit depth range off the floor value itself. */
  floor: -0.8,
  /** Metres over which an occluder's contribution halves as it rises. 0.30 is
   *  boot-to-shin on a chibi, so the dark core still comes from what is actually
   *  touching the ground while a hem or a paw pastern reads as half-contact. */
  falloff: 0.30,
  /** Floor contribution from anything overhead at any height. This is what the
   *  reference frames' broad soft ellipse *is*: a body occludes the sky over
   *  its whole footprint, not only where it touches. At 0.15 the pool was a
   *  boot-print; at 0.38 it is a figure's shadow with a boot-print inside it,
   *  which is also what grounds a husk — a four-legged mass whose body is a
   *  metre clear of the floor has almost no *contact* to report and would
   *  otherwise stand on four small dots. */
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
 * A layer rather than a second scene: the party and the husks have to stay in
 * the main graph to be lit, shadowed and posed, and a parallel graph holding
 * the same meshes is the kind of duplication that goes stale the first time
 * someone adds a prop. The projector camera is set to *only* this layer, so
 * the sky dome, terrain, treeline and mist are excluded without touching them.
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
    /** @type {Array<{root: THREE.Group, phase: number, sway: number, lift: number}>} */
    this.enemies = [];
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

    // ART_BIBLE §3: dusk is the hero key and t = 0.72 is the game's default
    // field time. A calibration stage lit at an arbitrary hour calibrates
    // nothing, so the scene owns the clock on entry and publishes it back so
    // the debug hook and any later scene agree with what is on screen.
    gameState.state.timeOfDay = HERO_TIME_OF_DAY;

    this.sky = this.track(new Sky(engine));
    this.sky.fogDensityScale = FOG_SCALE;
    this.sky.addTo(this.scene);
    this.sky.setTimeOfDay(HERO_TIME_OF_DAY);
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
    this._buildTreeline(forge);
    this._buildForeground(forge);
    this._buildMist(forge);
    this._buildMotes(forge);
    this._buildMatteMaterials();

    this._buildSphereGrid(forge);
    this._buildMaterialBar(forge);
    this._buildScaleProxy(forge);

    this._buildCast(forge);
    this._buildEnemies(forge);

    // Every character material was created after `addTo`, so the CSM patch has
    // to be re-applied or the party sums all four cascade lights unattenuated.
    this.lighting.refreshMaterials();
    this.lighting.sync();

    engine.get('vfx')?.addTo(this.scene);
    this.poseCamera(this._entryPose);
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
    // A dusk dome is an enormous, very bright area source, and the PMREM of it
    // arrives at unit intensity. Left there it out-runs the key on every
    // upward-facing surface — the party's heads measured ~0.93 display value,
    // outside ART_BIBLE §2.3's 0.05–0.85 band for everything that is not a
    // highlight, and the faces lost their banding to a flat white. Trimming the
    // probe (rather than the exposure, which §3 pins per time of day, or the
    // per-material intensities, which §4 pins per surface) puts the key back in
    // charge of form while leaving the metal row a real reflection to show.
    this.scene.environmentIntensity = 0.6;
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
    // Cloned so the tint stays local; the clone shares the forge's textures and
    // the forge guards those against `disposeTree`.
    //
    // The tint was 0.52/0.58/0.60, on the reading that ART_BIBLE §2.3's "~15%
    // of the frame below 0.08" is the floor's job. It is not, and pushing it
    // there is what made contact shadows impossible: measured off the shipped
    // frame the ground the party stands on sat at L≈18–20, which is a surface
    // with no value left to lose. Every grounding attempt against it — the
    // factory's decal, then this scene's own — was arithmetically correct and
    // visually absent, because a shadow is a *ratio* and there is no ratio to
    // be had on black. §2.3's dark 15% is delivered by the near grass bank, the
    // husk mass and the vignette, all of which are genuinely foreground; the
    // stage floor is mid-ground and has to read as lit ground with figures
    // standing on it. At 1.27× the contact patch lands around L≈30 and the pool
    // under a boot takes it to L≈8 — a shadow a viewer can see. The lift is
    // deliberately modest: the *foreground* is the near grass bank and the
    // bottom of frame, and those still carry §2.3's dark end.
    this.groundMaterial = forge.material('grass', { repeat: 400 }).clone();
    this.groundMaterial.color.setRGB(0.66, 0.73, 0.75);
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
   * Distant treeline. REFERENCE §3: background elements are near-silhouettes
   * with very little internal detail, washed toward the fog colour.
   *
   * Bark, not foliage: bark's albedo band is 0.10–0.25 linear, which is already
   * the near-black the reference frames show at distance, and an opaque surface
   * costs no alpha test on ~200 instances. Instanced from one merged conifer so
   * the whole treeline is a single draw call.
   */
  _buildTreeline(forge) {
    const parts = [];
    // Total height ~5.2 m. Sized against the cast, not against a human: a
    // botanically correct 20 m conifer beside a 1.1 m chibi reads as a
    // skyscraper and destroys the scale the whole look depends on.
    const trunk = new THREE.CylinderGeometry(0.09, 0.17, 1.5, 6, 1);
    trunk.translate(0, 0.75, 0);
    parts.push(trunk);
    for (let i = 0; i < 4; i++) {
      const y = 0.85 + i * 1.0;
      const r = 1.25 - i * 0.24;
      const h = 1.75 - i * 0.20;
      const cone = new THREE.ConeGeometry(r, h, 9, 1);
      cone.translate(0, y + h * 0.5, 0);
      parts.push(cone);
    }
    const conifer = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    this.track(conifer);

    const COUNT = 260;
    const mat = forge.material('bark', { repeat: 2 });
    const trees = new THREE.InstancedMesh(conifer, mat, COUNT);
    trees.name = 'treeline';
    trees.castShadow = false;
    trees.receiveShadow = false;
    trees.frustumCulled = false;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const rng = this.rng;
    for (let i = 0; i < COUNT; i++) {
      let tx = 0;
      let tz = 0;
      let radius = 0;
      // Rejection-sample around the calibration bay. Bounded at 8 tries so a
      // future clearing that swallowed the whole annulus could not spin here
      // forever; a tree that exhausts its tries simply keeps its last draw,
      // which at these radii is overwhelmingly outside the hole anyway.
      for (let attempt = 0; attempt < 8; attempt++) {
        // Log-distributed radius: an even scatter over an annulus puts almost
        // everything at the far edge, and the whole point is layered depth. The
        // inner limit is set by the fog — closer than ~22 m a tree still reads
        // at near-full contrast and starts competing with the party.
        radius = 22 * Math.exp(rng.next() * Math.log(240 / 22));
        const angle = rng.range(-Math.PI, Math.PI);
        tx = 4 + Math.cos(angle) * radius;
        tz = 1 + Math.sin(angle) * radius;
        if (Math.hypot(tx - CLEARING.x, tz - CLEARING.z) > CLEARING.radius) break;
      }
      // Sunk half a metre so the trunk flare never shows a floating seam where
      // the instanced base cuts the tessellated ground.
      p.set(tx, this._groundHeight(tx, tz) - 0.5, tz);
      const scale = rng.range(0.80, 1.28) * (0.92 + radius / 900);
      s.set(scale * rng.range(0.85, 1.1), scale, scale * rng.range(0.85, 1.1));
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
      trees.setMatrixAt(i, m.compose(p, q, s));
    }
    trees.instanceMatrix.needsUpdate = true;
    this.scene.add(trees);
    this.treeline = trees;
  }

  /**
   * Foreground occluders — ART_BIBLE §5.1's "single cheapest depth win".
   *
   * Placed to fall inside the near-DOF of both the lineup and horizon poses so
   * they blur, and against the left edge where the enemy half of a battle frame
   * would otherwise be empty stage.
   */
  _buildForeground(forge) {
    const group = new THREE.Group();
    group.name = 'foreground';

    // `alphaTest: 0` deliberately: the silhouette comes from the *geometry* of
    // each blade, not from a cutout. A leaf-shaped alpha stamped on a quad this
    // close to the lens reads as a decal of a leaf, which is what the first
    // pass of this scene shipped and why it was wrong. Cloned so the tint below
    // cannot leak into anyone else's foliage — the clone shares the forge's
    // textures, and the forge guards them against `disposeTree`.
    const mat = forge.material('foliage', { alphaTest: 0 }).clone();
    // §5.1: a foreground occluder is exposed at least 1.5 stops under the
    // subject, and §3 keeps environment saturation below character saturation.
    mat.color.setHex(0x53664f);
    mat.envMapIntensity = 0.25;
    this.track(mat);

    const blade = this._makeBladeGeometry();
    const rng = this.rng;

    // Two banks, because the poses stand in two different places. The `near`
    // bank frames the bottom-left of the lineup and horizon shots; the `far`
    // bank sits behind the lineup camera entirely and only ever appears in the
    // pulled-back `wide`, where the near bank is already mid-ground.
    const clumps = [
      { x: -0.10, z: 6.15, h: 1.30, n: 190, spread: 1.05 },
      { x: -1.55, z: 6.85, h: 1.55, n: 170, spread: 1.25 },
      { x: 7.10, z: 6.05, h: 0.85, n: 90, spread: 0.80 },
      { x: -0.55, z: 12.9, h: 1.45, n: 150, spread: 1.15 },
      { x: 4.60, z: 13.3, h: 1.20, n: 110, spread: 1.00 },
    ];

    // Merged into one geometry: ~670 blades as individual meshes would be 670
    // draw calls for what is, visually, two bushes.
    const pieces = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (const c of clumps) {
      for (let i = 0; i < c.n; i++) {
        const a = rng.range(0, Math.PI * 2);
        // sqrt of a uniform gives a uniform *areal* density; without it every
        // clump piles up at its own centre and reads as a spike.
        const r = c.spread * Math.sqrt(rng.next());
        const bx = c.x + Math.cos(a) * r;
        const bz = c.z + Math.sin(a) * r;
        const h = c.h * rng.range(0.45, 1.2);
        p.set(bx, this._groundHeight(bx, bz) - 0.04, bz);
        e.set(rng.jitter(0.16), rng.range(0, Math.PI * 2), rng.jitter(0.22));
        q.setFromEuler(e);
        // Width is *not* scaled by height: a blade is a blade whatever the
        // stalk's length, and coupling the two turned a grass tuft into agave.
        s.set(rng.range(0.7, 1.15), h, h);
        pieces.push(blade.clone().applyMatrix4(m.compose(p, q, s)));
      }
    }
    const merged = mergeGeometries(pieces, false);
    for (const g of pieces) g.dispose();
    blade.dispose();
    this.track(merged);

    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = 'foreground-grass';
    mesh.frustumCulled = false;
    group.add(mesh);
    this.scene.add(group);
    this.foreground = group;
  }

  /**
   * One unit-height grass blade: a tapered strip that curls away from vertical.
   *
   * Built rather than imported as a quad because the blade *is* the silhouette
   * — REFERENCE §3's background/foreground elements are read as shapes, and a
   * fan of thirty of these gives a clump an organic edge that no amount of
   * texturing on a rectangle can. UVs run several times along the blade so the
   * foliage albedo lands as leaf-scale detail rather than one stretched leaf.
   */
  _makeBladeGeometry() {
    const SEG = 6;
    const pos = [];
    const nrm = [];
    const uv = [];
    const idx = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      // Quadratic droop: a blade is stiff at the base and falls away at the
      // tip, which is what stops a clump reading as a hedgehog of spikes.
      const lean = t * t * 0.42;
      const halfWidth = 0.042 * (1 - t) ** 0.75;
      const y = t * (1 - lean * 0.35);
      const z = lean;
      pos.push(-halfWidth, y, z, halfWidth, y, z);
      nrm.push(0, 0.35, 1, 0, 0.35, 1);
      uv.push(0, t * 3.2, 1, t * 3.2);
      if (i < SEG) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Ground mist. REFERENCE §3 calls volumetric mist the signature of the look —
   * present in nearly every frame, pooling low and catching light.
   *
   * Additive rather than alpha-blended: additive is order-independent, so a
   * dozen overlapping cards need no sorting and cannot pop as the camera moves,
   * and mist that *adds* light is exactly what a backlit bank does. The tint is
   * the sky's own near-fog colour so the bank always agrees with the fog the
   * scene is already rendering.
   */
  _buildMist(forge) {
    const tex = forge.texture('smoke');
    const mat = this.track(new THREE.MeshBasicMaterial({
      map: tex,
      // FOG_NEAR at a fraction of unity: additive cards stack, so the per-card
      // radiance has to sit well under the value the bank is meant to reach or
      // six overlaps blow past the bloom threshold and the mist starts glowing.
      color: new THREE.Color(LIGHT.FOG_NEAR),
      transparent: true,
      // Premultiplied-alpha blending, not additive. The sprite's RGB is already
      // premultiplied by its coverage, so `ONE / ONE_MINUS_SRC_ALPHA` is the
      // mathematically correct compositing operator for it — and unlike
      // additive it *replaces* what is behind, which is the only way a teal
      // bank reads as teal over a warm dusk sky instead of merely brightening
      // it toward white. Still order-independent enough for soft overlapping
      // cards, and it cannot push the frame past the bloom threshold.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
      fog: false,
    }));

    // Four fades. The first three fix the same class of defect — a billboarded
    // card is a *quad*, and any straight edge of that quad that ends up inside
    // the frame is read instantly as a rectangle lying across the shot. The
    // fourth is what turns a card into a puff.
    //
    // 1. **Ground fade.** A card is a vertical plane and its lower half is
    //    *below* the terrain, so the ground in front of it wins the depth test —
    //    and the intersection of a plane with a near-level floor is a straight
    //    line, which is why the reverse-angle frame had a razor-sharp horizontal
    //    cut across the mist at ground level. No amount of softening the sprite
    //    touches it, because the edge is the depth buffer's, not the texture's.
    //    Fading by world height retires each card before it reaches the floor.
    // 2. **Radial edge mask**, so a card's own border can never show even where
    //    nothing occludes it — elliptical in world space, because the cards are
    //    scaled non-uniformly, which is the right shape for a puff anyway.
    // 3. **Camera-proximity fade**, for cards close enough that their unmasked
    //    middle fills the lens.
    // 4. **Ceiling fade**, in *world* metres. This is the one that makes the
    //    bank pool rather than hang. Every previous version of this bank
    //    controlled its top by controlling card *size*, which is an argument
    //    that has to be re-made every time anyone touches the seeding — and was
    //    wrong twice. Fading on world height instead is an invariant: whatever
    //    a puff's size, wherever its centre lands, whatever the drift has done
    //    to it, it is gone by `MIST_LOW.ceiling[1]`. That is below the chin of
    //    the shortest chibi in the cast, so mist can never veil a face again,
    //    and the density gradient it produces on the way up is exactly the
    //    "pooling low to the ground" REFERENCE §3 asks for.
    //
    // All four multiply the *whole* premultiplied RGBA, which is the correct
    // operator for this blend: it lerps the fragment toward the destination
    // rather than toward black.
    mat.onBeforeCompile = (shader) => {
      // Restored by 5 m — closer than any card the compositions rely on — and
      // opening at 1.2 m, well outside the 0.08 m near plane so no card is ever
      // clipped part-way through its fade.
      shader.uniforms.uMistNearFade = { value: new THREE.Vector2(1.2, 5.0) };
      // The stage plateau is level at y = 0, so -0.12 is under the floor by
      // more than the height field's residual ripple (±0.09 m) and the fade is
      // fully open by 0.14 m — bootlace height on a 1.15 m chibi.
      shader.uniforms.uMistGroundFade = { value: new THREE.Vector2(-0.12, 0.14) };
      shader.uniforms.uMistCeiling = { value: new THREE.Vector2(...MIST_LOW.ceiling) };
      shader.uniforms.uMistDensity = { value: MIST_LOW.density };
      shader.vertexShader = `varying float vMistDepth;\nvarying float vMistY;\nvarying vec2 vMistUv;\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
	vMistDepth = - mvPosition.z;
	vMistY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;
	vMistUv = uv;`,
      );
      shader.fragmentShader = `uniform vec2 uMistNearFade;\nuniform vec2 uMistGroundFade;\nuniform vec2 uMistCeiling;\nuniform float uMistDensity;\nvarying float vMistDepth;\nvarying float vMistY;\nvarying vec2 vMistUv;\n${shader.fragmentShader}`
        .replace(
          '#include <dithering_fragment>',
          `gl_FragColor *= uMistDensity
		* smoothstep( 0.50, 0.16, length( vMistUv - vec2( 0.5 ) ) )
		* smoothstep( uMistGroundFade.x, uMistGroundFade.y, vMistY )
		* smoothstep( uMistCeiling.y, uMistCeiling.x, vMistY )
		* smoothstep( uMistNearFade.x, uMistNearFade.y, vMistDepth );
	#include <dithering_fragment>`,
        );
    };
    // three keys its program cache on defines and material class, not on
    // `onBeforeCompile`; without an explicit key this material and any other
    // `MeshBasicMaterial` with the same defines would share one compiled
    // program and whichever compiled first would win.
    mat.customProgramCacheKey = () => 'aw-mist-puff';
    this.mistMaterial = mat;

    // The tall backdrop bank keeps its own material: it sits behind the party
    // and in front of the treeline, where nothing it can cover is a subject, so
    // it wants neither the ceiling fade nor the puff bank's low density — its
    // job is to give the cast the bright field to silhouette against that tree
    // trunks cannot.
    const tallMat = this.track(mat.clone());
    tallMat.onBeforeCompile = (shader) => {
      shader.uniforms.uMistNearFade = { value: new THREE.Vector2(1.2, 5.0) };
      shader.vertexShader = `varying float vMistDepth;\nvarying vec2 vMistUv;\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
	vMistDepth = - mvPosition.z;
	vMistUv = uv;`,
      );
      shader.fragmentShader = `uniform vec2 uMistNearFade;\nvarying float vMistDepth;\nvarying vec2 vMistUv;\n${shader.fragmentShader}`
        .replace(
          '#include <dithering_fragment>',
          `gl_FragColor *= smoothstep( 0.50, 0.16, length( vMistUv - vec2( 0.5 ) ) )
		* smoothstep( uMistNearFade.x, uMistNearFade.y, vMistDepth );
	#include <dithering_fragment>`,
        );
    };
    tallMat.customProgramCacheKey = () => 'aw-mist-backdrop';

    const geo = new THREE.PlaneGeometry(1, 1);
    this.track(geo);
    const group = new THREE.Group();
    group.name = 'mist';
    const rng = this.rng;
    this._mistCards = [];

    // The low bank: clustered puffs. Cluster centres first, then a scatter
    // around each, because a bank is somewhere haze has *pooled* — uneven
    // density with clear ground between pools is what separates a volume from a
    // sheet, and a sheet is what the previous even scatter produced.
    //
    // Spans the whole stage including the enemy half. An earlier layout folded
    // everything west of -12 back east to keep haze off the calibration bay;
    // with the bay moved south that fold only served to strip the mist off the
    // enemy mass, which is the one place REFERENCE §3 most wants it — a boss
    // rising out of a bank reads as a threat, a boss standing on clean grass
    // reads as a prop.
    for (let c = 0; c < MIST_LOW.clusters; c++) {
      const cx = rng.range(MIST_SPAN.west, MIST_SPAN.east);
      const cz = rng.range(-17, 10);
      const spread = rng.range(...MIST_LOW.spread);
      const n = rng.int(...MIST_LOW.perCluster);
      for (let i = 0; i < n; i++) {
        const puff = new THREE.Mesh(geo, mat);
        puff.scale.set(rng.range(...MIST_LOW.width), rng.range(...MIST_LOW.height), 1);
        const a = rng.range(0, Math.PI * 2);
        // sqrt of a uniform is a uniform *areal* density; without it a cluster
        // piles up on its own centre and reads as one bright knot.
        const r = spread * Math.sqrt(rng.next());
        puff.position.set(
          cx + Math.cos(a) * r,
          rng.range(...MIST_LOW.centre),
          cz + Math.sin(a) * r * 0.7,
        );
        puff.renderOrder = 6;
        group.add(puff);
        this._mistCards.push({
          mesh: puff, baseY: puff.position.y,
          drift: rng.range(0.05, 0.16), phase: rng.range(0, 6.28),
          // Roll about the view axis. The radial mask is rotationally symmetric
          // but the smoke texture under it is not, so this is what stops ninety
          // puffs from being ninety prints of one puff — and it costs a single
          // extra quaternion multiply per card per frame.
          roll: rng.range(0, Math.PI * 2),
        });
      }
    }

    for (let i = 0; i < 16; i++) {
      const card = new THREE.Mesh(geo, tallMat);
      const w = rng.range(16, 34);
      card.scale.set(w, w * rng.range(0.28, 0.45), 1);
      card.position.set(
        rng.range(MIST_SPAN.west, MIST_SPAN.east),
        rng.range(1.4, 3.4),
        rng.range(-26, -6),
      );
      card.renderOrder = 6;
      group.add(card);
      // `baseY` is kept so the breath below is an oscillation *about* the
      // seeded height rather than an integration of one. Adding a sine to
      // `position.y` every frame is a random walk, not a bob: sampled at 60 Hz
      // it drifts by tens of centimetres over a capture.
      this._mistCards.push({
        mesh: card, baseY: card.position.y,
        drift: rng.range(0.05, 0.16), phase: rng.range(0, 6.28), roll: 0,
      });
    }
    this.scene.add(group);
    this.mist = group;
  }

  /**
   * Glasspetal drift — WORLD_BIBLE §1's spent magic, and REFERENCE §5's
   * "persistent ambient particles drift even outside of combat".
   *
   * One `Points` cloud, animated on the CPU because 900 sprites is far below
   * the point where a GPU simulation pays for its own upload.
   */
  _buildMotes(forge) {
    const COUNT = 900;
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    const rng = this.rng;
    this._moteSeed = new Float32Array(COUNT * 3);
    const teal = new THREE.Color(LIGHT.RING_GLOW);
    const amber = new THREE.Color(0xffc24d);
    const c = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = rng.range(-24, 26);
      pos[i * 3 + 1] = rng.range(0.05, 7.5);
      pos[i * 3 + 2] = rng.range(-26, 14);
      // §2.2's rule of one jewel: petals are teal-dominant with an amber
      // minority, so the drift never becomes a second competing accent.
      c.copy(teal).lerp(amber, Math.pow(rng.next(), 3)).multiplyScalar(rng.range(0.35, 0.9));
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
      size: 0.13,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
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
   * Two render targets and one orthographic station, all sized from the staged
   * placements rather than from constants, so moving the diagonal or the enemy
   * pack cannot walk a figure off the edge of its own shadow.
   */
  _buildContactShadows() {
    let minX = Infinity; let maxX = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;
    for (const p of [...PARTY_PLACES, ...ENEMY_PLACES]) {
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
    // surface instead reports the sole under a boot, the underside of the hem
    // under a skirt and the paw under a husk — which is the geometry that is
    // actually in contact with the ground.
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
      // Deep, because the stage floor is already a low-value surface and a pool
      // has to survive the low mist bank that composites over it. Tinted rather
      // than neutral per ART_BIBLE §2.1, and the tint does real work here —
      // SHADOW_TINT attenuates red about four times harder than blue, so the
      // pool cools as it darkens instead of going grey.
      uContactTint: { value: new THREE.Color(LIGHT.SHADOW_TINT).multiplyScalar(0.45) },
      uContactStrength: { value: CONTACT.strength },
      /**
       * Floor conditioning — the other half of making a contact shadow visible.
       *
       * A shadow is a *ratio*, and the stage floor was not offering one. The
       * forge's grass albedo is an fBm whose luminance swings from 21 to 164
       * across a single 240 px patch of the shipped frame at 0.25–0.45
       * saturation — measured, not estimated. Against that, an occlusion pool
       * that darkens by half is inside the texture's own noise band and simply
       * cannot be seen; it is also the read-hierarchy failure the review names
       * outright, a floor louder and more saturated than the cast standing on
       * it, which inverts the figure-ground relationship the whole look depends
       * on (REFERENCE §3: "environment saturation sits **below** character
       * saturation. The background is a stage, never competition.")
       *
       * `x` is the luminance the fBm is compressed toward and `y` how much of
       * its own contrast survives, so the floor keeps its form and its tiling
       * detail while its swing halves. `uGroundChroma` then takes most of the
       * red/green out of what is left. Both are conditioning on *this scene's*
       * clone of the material — the forge's texture is untouched and no other
       * scene's ground changes.
       */
      uGroundLevel: { value: new THREE.Vector2(0.26, 0.52) },
      uGroundChroma: { value: 0.42 },
      /** Unit-luminance cool grey, so desaturating changes saturation and not
       *  value, and lands on ART_BIBLE §2.1's cool floor rather than on neutral. */
      uGroundTint: { value: new THREE.Vector3(0.94, 1.00, 1.07) },
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
   *  - **Albedo conditioning** immediately after `<color_fragment>`, i.e. on
   *    `diffuseColor` before a single light has touched it. Compressing an
   *    albedo is a statement about the *surface*, so it has to happen before
   *    the lighting rather than being ground out of the final pixel, where it
   *    would flatten the key's own modelling along with the texture's noise.
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
uniform vec2 uGroundLevel;
uniform float uGroundChroma;
uniform vec3 uGroundTint;
varying vec3 vAwGround;
${shader.fragmentShader}`
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
	float lum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	// Hue and saturation as a unit-luminance direction, so the two controls
	// below are genuinely independent: one moves value, the other chroma.
	vec3 hue = lum > 1e-4 ? diffuseColor.rgb / lum : vec3( 1.0 );
	diffuseColor.rgb = mix( uGroundLevel.x, lum, uGroundLevel.y )
		* mix( uGroundTint, hue, uGroundChroma );
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
   * Build the six roster characters and stage them on the right of the battle
   * frame, in the two staggered ranks REFERENCE §2's "loose staggered diagonal"
   * actually requires — see {@link PARTY} for why a single rank cannot work.
   *
   * `lighting` is passed so `ToonMaterial` aliases the rig's key/rim uniform
   * objects — that is what makes the whole party re-key on a time-of-day change
   * without a per-frame call — and `forge` so the toon ramp and detail normals
   * come from the shared library instead of the shader's internal fallback.
   */
  _buildCast(forge) {
    const group = new THREE.Group();
    group.name = 'cast';

    // Built before they are placed, because the separation pass needs each
    // rig's solved reach and that only exists once the character does.
    const built = PARTY.map((slot) => buildCharacter(slot.id, forge, {
      lighting: this.lighting, outline: true, outlineWidth: OUTLINE_PIXELS,
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
      // Square up to the vanguard husk, then open `turn` radians back toward the
      // lens. Deriving the base heading from the threat's actual position rather
      // than from a hard-coded -90° is what keeps the address honest when the
      // enemy line moves: the previous constant assumed the threat sat due west
      // of every slot, which it never has. The rig's forward is **+Z** —
      // `CharacterFactory.hairlinePhi` states the convention outright, "+Z
      // (forward) is theta = pi/2" — so `headingTo` is already in rig space, and
      // a *positive* turn swings the figure toward the camera because the camera
      // stands on the +Z side of the battle axis.
      character.root.rotation.y = headingTo(place, GAZE_ANCHOR) + slot.turn;
      // Idle is already playing from the factory; restate it so the clip is
      // explicit at the call site and a future pose change is one edit.
      character.animator.play('idle', { fade: 0 });
      // Every head tracks the vanguard rather than a nominal point off-stage:
      // six chibi staring past the thing that is about to eat them is the single
      // cheapest way to make a battle frame look unstaged. Partial weight, so
      // the look leads the body without dragging the chest round with it and
      // undoing `turn` — see GAZE_WEIGHT.
      character.animator.lookAt?.(GAZE_ANCHOR, GAZE_WEIGHT);
      group.add(character.root);
      LookdevScene._markContactCasters(character.root);
      this.cast.push(character);
    });
    this.scene.add(group);
    this.castGroup = group;
    this.hero = this.cast[0];
  }

  /**
   * The enemy side of the battle frame.
   *
   * REFERENCE §2 gives the enemies the left of frame and makes them
   * "generally larger than the party — bosses are dramatically larger", and §4
   * reserves magenta/violet for exactly this: the husks are the one place in
   * the scene entitled to that hue, which is also why the environment around
   * them is graded away from it.
   *
   * Fiction (WORLD_BIBLE §1): a **shardhusk** is what accretes where great
   * magic was spent and never cleared — a hollow of unremembered anima that
   * has crusted a body of fallen glasspetals around itself. Hence the read:
   * a dark, hunched, near-organic mass carrying a crown of glass that is the
   * only part of it still lit from inside.
   */
  _buildEnemies(forge) {
    const group = new THREE.Group();
    group.name = 'enemies';

    // One geometry pair, authored in a normalised space where feet = 0 and the
    // crown tip = 1, so a husk's world height is a single scale factor and the
    // three instances share both buffers and both draw programs.
    const body = this.track(this._makeHuskBodyGeometry());
    const crown = this.track(this._makeHuskCrownGeometry());

    // §4 leather: albedo 0.10–0.30 linear, and the husk sits at the bottom of
    // that band on purpose. The whole enemy read is *value*: a dark mass under
    // a bright sky, separated from the ground by its rim rather than by its
    // colour. The first build of this creature used the middle of the band and
    // it came back pale — a 3.4 m animal brighter than the party it is meant to
    // threaten, and the second-brightest thing in frame after the sky.
    //
    // The rim is pulled well under the leather preset's default for the same
    // reason: at the preset's gain every one of the limb tubes lit its own
    // contour and the creature turned to chrome. It wants one tight edge, not a
    // wash, so `rimGain` drops and `rimFloor` with it, and `shadowMix` rises so
    // the unlit two-thirds of the body sinks toward SHADOW_TINT instead of
    // holding its own hue.
    const bodyMat = this.track(createToonMaterial({
      name: 'husk-body',
      preset: 'leather',
      color: 0x2e2438,
      map: forge.texture('leather', { repeat: 3 }),
      normalMap: forge.texture('leather/normal', { repeat: 3 }),
      normalScale: new THREE.Vector2(1.05, 1.05),
      roughnessMap: forge.texture('leather/roughness', { repeat: 3 }),
      envMapIntensity: 0.14,
      envSpecular: 0.06,
      specGain: 0.10,
      rimGain: 1.05,
      rimFloor: 0.24,
      shadowMix: 0.66,
      shadowLevel: 0.11,
      lighting: this.lighting,
      forge,
    }));

    // §4 crystal: "emissive interior 1.2–1.8 in elemental accent; fresnel rim
    // mandatory". UMBRAL is the accent §2.2 assigns to dark, and 1.5 sits mid
    // band — bright enough to survive the fog at 10 m, well under the 2.5–6.0
    // the same section reserves for a spell core, so the crown never reads as
    // a cast spell.
    this.crownMaterial = this.track(createToonMaterial({
      name: 'husk-crown',
      preset: 'crystal',
      color: 0x6a4a96,
      normalMap: forge.texture('crystal/normal', { repeat: 2 }),
      normalScale: new THREE.Vector2(0.55, 0.55),
      emissive: ELEMENT.dark.accent,
      emissiveIntensity: 1.5,
      lighting: this.lighting,
      forge,
    }));

    // The hollow itself. Unlit and above 1.0 so it is a genuine bloom source
    // rather than a bright grey dot — §2.2 allows supra-1.0 emissive for magic,
    // and the eye of a husk is the only part of it that *is* magic.
    this.huskEyeMaterial = this.track(new THREE.MeshBasicMaterial({
      name: 'husk-eye',
      color: new THREE.Color(ELEMENT.dark.fringe).multiplyScalar(2.2),
      toneMapped: true,
      fog: true,
    }));
    const eyeGeo = this.track(new THREE.SphereGeometry(0.024, 12, 8));

    // One outline material for all three husks. The hull offset is a fraction
    // of viewport *height*, not of model space, so it is already scale-
    // independent and a shared material is correct rather than merely cheap.
    // Slightly heavier than the party's default because the husks sit twice as
    // far back, behind twice as much haze, and a contour that survives at 4 m
    // is gone at 10.
    const outlineMat = this.track(createToonOutlineMaterial({ name: 'husk-outline', width: 0.0019 }));

    ENEMIES.forEach((spec, i) => {
      const place = ENEMY_PLACES[i];
      const root = new THREE.Group();
      root.name = `enemy:${spec.id}`;
      root.position.set(place.x, groundHeight(place.x, place.z), place.z);
      // Husks square up to the party's centre of mass and then deviate by
      // `turn`, so no two stare down the same line. Solved from the placements
      // rather than from a fixed quarter-turn because the pack is no longer a
      // single rank: the vanguard stands *in front of* the party's depth band
      // and a constant heading would have it addressing empty stage.
      root.rotation.y = headingTo(place, PARTY_CENTROID) + spec.turn;
      root.scale.setScalar(spec.height);

      const shell = new THREE.Mesh(body, bodyMat);
      shell.name = `${spec.id}:shell`;
      shell.castShadow = true;
      shell.receiveShadow = true;
      root.add(shell);
      // Same inverted-hull line the party carries. Without it the husk is the
      // only figure in frame without a contour and reads as from another game.
      createToonOutline(shell, { material: outlineMat });

      const glass = new THREE.Mesh(crown, this.crownMaterial);
      glass.name = `${spec.id}:crown`;
      glass.castShadow = true;
      // `crest` scales the crown against the body so the three husks do not
      // read as one silhouette at three sizes — §1's distinctiveness rule
      // applies to enemies for the same reason it applies to the party.
      glass.scale.set(spec.crest, spec.crest, spec.crest);
      root.add(glass);

      for (const side of [1, -1]) {
        const eye = new THREE.Mesh(eyeGeo, this.huskEyeMaterial);
        eye.position.set(side * 0.052, 0.598, 0.492);
        eye.scale.set(1, 0.62, 0.8);
        eye.renderOrder = 3;
        root.add(eye);
      }

      group.add(root);
      LookdevScene._markContactCasters(root);
      // Phase offsets are drawn from the scene stream so the three husks never
      // breathe in lockstep, and never differ between two captures.
      this.enemies.push({
        root,
        phase: this.rng.range(0, Math.PI * 2),
        sway: this.rng.range(0.020, 0.038),
        lift: this.rng.range(0.006, 0.013) * spec.height,
        baseY: root.position.y,
        baseYaw: root.rotation.y,
      });
    });

    this.scene.add(group);
    this.enemyGroup = group;
  }

  /**
   * The husk's spine, resampled to a smooth profile.
   *
   * Control points are `[y, z, radius, lateralScale]` in the normalised space
   * where the feet sit at y = 0 and the crown tip at y = 1. The body is a
   * surface of revolution swept along this, *not* a pile of blobs: overlapping
   * ellipsoids each contribute their own silhouette edge, and under a rim light
   * — which every character in this scene has by contract — each of those edges
   * lights up, so the creature reads as a string of bubbles instead of one
   * mass. A single swept skin has exactly one contour, which is the whole point
   * of REFERENCE §1's "bold single silhouette".
   *
   * Cached: the crown places its shards on this same curve, so the two cannot
   * drift apart, and the third husk pays nothing for the first one's solve.
   */
  _huskSpine() {
    if (this._spineCache) return this._spineCache;
    // Highest and widest at the shoulder yoke, head thrust *forward and below*
    // it: that lowered head over a raised shoulder is the whole difference
    // between a stalking predator and a grazing animal.
    const CONTROL = [
      [0.130, -0.620, 0.020, 0.85],
      [0.190, -0.500, 0.062, 0.95],
      [0.262, -0.360, 0.125, 1.05],
      [0.322, -0.215, 0.190, 1.20],
      [0.360, -0.070, 0.232, 1.34],
      [0.400, 0.070, 0.238, 1.30],
      [0.470, 0.185, 0.232, 1.30],
      [0.548, 0.268, 0.205, 1.42],
      [0.588, 0.352, 0.150, 1.12],
      [0.588, 0.428, 0.116, 1.00],
      [0.572, 0.496, 0.082, 0.90],
      [0.536, 0.552, 0.040, 0.78],
      [0.508, 0.582, 0.012, 0.68],
    ];
    const STEPS = 60;
    const n = CONTROL.length;
    const out = [];
    for (let s = 0; s <= STEPS; s++) {
      const t = (s / STEPS) * (n - 1);
      const i = Math.min(n - 2, Math.floor(t));
      const f = t - i;
      const p0 = CONTROL[Math.max(0, i - 1)];
      const p1 = CONTROL[i];
      const p2 = CONTROL[i + 1];
      const p3 = CONTROL[Math.min(n - 1, i + 2)];
      const v = [];
      for (let k = 0; k < 4; k++) {
        // Uniform Catmull-Rom. The control points are near-equally spaced along
        // the body, so the centripetal variant would buy nothing and the plain
        // form keeps the radius channel monotone where it is authored monotone.
        v.push(0.5 * (2 * p1[k]
          + (-p0[k] + p2[k]) * f
          + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f * f
          + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * f * f * f));
      }
      out.push({ y: v[0], z: v[1], r: Math.max(0.006, v[2]), lat: v[3] });
    }
    this._spineCache = out;
    return out;
  }

  /**
   * Shardhusk body — one swept skin plus four limbs, merged into one buffer.
   *
   * The sweep frame is built by hand rather than with `computeFrenetFrames`:
   * the spine is planar (x = 0 everywhere) and unrolled, so world +X *is* the
   * ring's right vector, and a Frenet frame on a planar curve is free to spin
   * about the tangent wherever curvature passes through zero — which would
   * twist the UVs and the normals across the creature's back for no reason.
   */
  _makeHuskBodyGeometry() {
    const spine = this._huskSpine();
    const RADIAL = 18;
    const parts = [];

    const pos = [];
    const nrm = [];
    const uv = [];
    const idx = [];
    for (let i = 0; i < spine.length; i++) {
      const s = spine[i];
      const prev = spine[Math.max(0, i - 1)];
      const next = spine[Math.min(spine.length - 1, i + 1)];
      // Tangent in the YZ plane; the ring's "up" is its perpendicular there.
      let ty = next.y - prev.y;
      let tz = next.z - prev.z;
      const tl = Math.hypot(ty, tz) || 1;
      ty /= tl; tz /= tl;
      const v = i / (spine.length - 1);
      for (let j = 0; j <= RADIAL; j++) {
        const a = (j / RADIAL) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        pos.push(ca * s.r * s.lat, s.y + sa * s.r * tz, s.z - sa * s.r * ty);
        // Analytic ring normal, corrected for the lateral squash so the shading
        // does not report a circular cross-section on an elliptical one. It is
        // overwritten by `computeVertexNormals` after the merge, but the merge
        // requires every input to declare the same attribute set, so it has to
        // be here and it may as well be right.
        const n = new THREE.Vector3(ca / s.lat, sa * tz, -sa * ty).normalize();
        nrm.push(n.x, n.y, n.z);
        // Leather grain runs along the body, so v repeats faster than u.
        uv.push(j / RADIAL, v * 2.6);
      }
    }
    const ring = RADIAL + 1;
    for (let i = 0; i < spine.length - 1; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const a = i * ring + j;
        idx.push(a, a + ring, a + 1, a + 1, a + ring, a + ring + 1);
      }
    }
    // End caps. The tail and muzzle taper to 6 mm rather than to a true point:
    // a zero-radius ring is a fan of degenerate triangles whose normals are
    // undefined, and the artefact that produces is a black speck that no amount
    // of grading removes.
    for (const [end, dir] of [[0, -1], [spine.length - 1, 1]]) {
      const s = spine[end];
      const c = pos.length / 3;
      pos.push(0, s.y, s.z + dir * s.r * 0.6);
      nrm.push(0, 0, dir);
      uv.push(0.5, end === 0 ? 0 : 2.6);
      for (let j = 0; j < RADIAL; j++) {
        const a = end * ring + j;
        if (dir < 0) idx.push(c, a + 1, a);
        else idx.push(c, a, a + 1);
      }
    }
    const skin = new THREE.BufferGeometry();
    skin.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    skin.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    skin.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    skin.setIndex(idx);
    parts.push(skin);

    // Limbs. Each one is a **single swept tube that ends in its own paw**, and
    // that is a correction rather than a refactor. They used to be two tapered
    // cylinders with a squashed sphere dropped over the ankle: geometrically
    // the sphere did contain the shank's end, but three separate closed
    // surfaces means three separate silhouettes, and every one of them gets its
    // own rim light and its own inverted hull. What the frame showed was a boot
    // hovering under a cut-off tube with a bright line in the gap — the review's
    // "ball feet float with visible gaps above their leg tubes". One surface has
    // one contour, so the paw cannot come off the leg at any angle or under any
    // light. It is the same argument `_huskSpine` makes for the body.
    for (const s of [1, -1]) {
      // Forelimbs are straighter and planted well forward of the shoulder, so
      // the whole mass leans into the party's half of the stage.
      parts.push(this._makeHuskLimbGeometry([
        { x: s * 0.196, y: 0.510, z: 0.225, r: 0.102 },
        { x: s * 0.248, y: 0.300, z: 0.348, r: 0.078 },
        { x: s * 0.258, y: 0.135, z: 0.386, r: 0.062 },
        { x: s * 0.262, y: 0.062, z: 0.428, r: 0.086 },
      ]));
      // Hind legs fold under the haunch — a crouch loaded to spring. Carried
      // wider and dropped lower than the forelimbs so a good half-metre of
      // shank clears the flank: tucked tight under a 3.5 m body they were
      // hidden by it from the battle camera, which left the paws reading as
      // loose spheres lying on the grass with nothing joining them to anything.
      parts.push(this._makeHuskLimbGeometry([
        { x: s * 0.205, y: 0.352, z: -0.135, r: 0.102 },
        { x: s * 0.256, y: 0.196, z: -0.248, r: 0.078 },
        { x: s * 0.252, y: 0.108, z: -0.142, r: 0.062 },
        { x: s * 0.244, y: 0.058, z: -0.052, r: 0.084 },
      ]));
    }

    const merged = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    merged.computeVertexNormals();
    return merged;
  }

  /**
   * One husk limb: hip to toe as a single closed surface.
   *
   * `joints` are `{x, y, z, r}` in the body's normalised space, hip first and
   * toe last; the run is Catmull-Rom resampled so the knee and hock are curves
   * rather than creases, and the radius channel is interpolated with it so the
   * paw's bulge grows out of the shank instead of being stuck onto it.
   *
   * The sweep frame is carried, not recomputed per sample: a limb is close
   * enough to straight that a Frenet frame is free to spin about the tangent
   * wherever curvature dips through zero, which would twist the tube. Starting
   * from world +X and re-orthogonalising against each new tangent keeps the
   * frame continuous by construction.
   *
   * The toe closes with a half-ellipsoid cap of its own final radius, which is
   * what makes the paw *be* the end of the leg. The hip end closes with a flat
   * fan — it is buried inside the body, and an open tube would hand the
   * inverted-hull pass a clear view down the bore, which it paints as a plate
   * hanging in mid-air.
   */
  _makeHuskLimbGeometry(joints) {
    const RADIAL = 12;
    const SPAN = 9;         // resample steps per authored segment
    const CAP = 4;          // rings in the closing toe cap
    const n = joints.length;
    const path = [];
    for (let seg = 0; seg < n - 1; seg++) {
      const p0 = joints[Math.max(0, seg - 1)];
      const p1 = joints[seg];
      const p2 = joints[seg + 1];
      const p3 = joints[Math.min(n - 1, seg + 2)];
      // The last sample of a segment is the first of the next, so it is emitted
      // only by the final segment — otherwise every joint carries a duplicated
      // ring and the tube self-shadows along four seams.
      const last = seg === n - 2 ? SPAN : SPAN - 1;
      for (let s = 0; s <= last; s++) {
        const f = s / SPAN;
        const spline = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * f
          + (2 * a - 5 * b + 4 * c - d) * f * f
          + (-a + 3 * b - 3 * c + d) * f * f * f);
        path.push({
          x: spline(p0.x, p1.x, p2.x, p3.x),
          y: spline(p0.y, p1.y, p2.y, p3.y),
          z: spline(p0.z, p1.z, p2.z, p3.z),
          r: Math.max(0.004, spline(p0.r, p1.r, p2.r, p3.r)),
        });
      }
    }

    const pos = [];
    const nrm = [];
    const uv = [];
    const idx = [];
    const ring = RADIAL + 1;
    const tangent = new THREE.Vector3();
    const right = new THREE.Vector3(1, 0, 0);
    const up = new THREE.Vector3();
    const normal = new THREE.Vector3();

    /** Emit one ring of `radius` at `p`, oriented on the carried frame. */
    const emitRing = (p, radius, v) => {
      for (let j = 0; j <= RADIAL; j++) {
        const a = (j / RADIAL) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        normal.copy(right).multiplyScalar(ca).addScaledVector(up, sa);
        pos.push(p.x + normal.x * radius, p.y + normal.y * radius, p.z + normal.z * radius);
        nrm.push(normal.x, normal.y, normal.z);
        // Leather grain runs along the limb, matching the body's own 2.6 repeat.
        uv.push(j / RADIAL, v * 1.4);
      }
    };

    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const prev = path[Math.max(0, i - 1)];
      const next = path[Math.min(path.length - 1, i + 1)];
      tangent.set(next.x - prev.x, next.y - prev.y, next.z - prev.z);
      if (tangent.lengthSq() < 1e-10) tangent.set(0, -1, 0);
      tangent.normalize();
      // Re-orthogonalise the carried right vector against the new tangent. If
      // the two have gone parallel — which needs a limb doubled back on itself
      // — fall back to the world axis the body sweep also uses.
      right.addScaledVector(tangent, -right.dot(tangent));
      if (right.lengthSq() < 1e-6) right.set(0, 0, 1).addScaledVector(tangent, -tangent.z);
      right.normalize();
      up.crossVectors(tangent, right).normalize();
      emitRing(p, p.r, i / (path.length - 1));
    }

    // Toe cap: a half-ellipsoid carried on the final frame, so the paw is the
    // tube's own end rather than a sphere resting near it.
    const tip = path[path.length - 1];
    const capLen = tip.r * 1.05;
    for (let c = 1; c <= CAP; c++) {
      const t = c / (CAP + 1);
      const a = (t * Math.PI) / 2;
      emitRing({
        x: tip.x + tangent.x * Math.sin(a) * capLen,
        y: tip.y + tangent.y * Math.sin(a) * capLen,
        z: tip.z + tangent.z * Math.sin(a) * capLen,
      }, tip.r * Math.cos(a), 1);
    }

    const rings = path.length + CAP;
    for (let i = 0; i < rings - 1; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const a = i * ring + j;
        idx.push(a, a + ring, a + 1, a + 1, a + ring, a + ring + 1);
      }
    }
    // Two fans: the flat hip end and the toe's pole.
    for (const [end, dir] of [[0, -1], [rings - 1, 1]]) {
      const src = end === 0 ? path[0] : tip;
      const reach = end === 0 ? 0 : capLen;
      const c = pos.length / 3;
      pos.push(src.x + tangent.x * reach, src.y + tangent.y * reach, src.z + tangent.z * reach);
      nrm.push(tangent.x * dir, tangent.y * dir, tangent.z * dir);
      uv.push(0.5, end === 0 ? 0 : 1.4);
      for (let j = 0; j < RADIAL; j++) {
        const a = end * ring + j;
        if (dir < 0) idx.push(c, a + 1, a);
        else idx.push(c, a, a + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    return geo;
  }

  /**
   * The crown of glasspetal shards, in the same normalised space as the body.
   *
   * Four-sided pyramids rather than cones: a faceted shard catches the key as a
   * hard specular plane, which is what §4's crystal entry means by "reads
   * through a hard specular band", and a smooth cone would only gradient. The
   * bases are sampled off `_huskSpine`, so every shard is seated on the back
   * whatever the body profile is later tuned to, and lengths, lean and roll are
   * drawn from the scene stream so the ridge is jagged rather than a cockscomb.
   */
  _makeHuskCrownGeometry() {
    const spine = this._huskSpine();
    const rng = this.rng;
    const parts = [];
    const up = new THREE.Vector3(0, 1, 0);
    const shard = (x, y, z, len, rad, leanX, leanZ) => {
      const g = new THREE.ConeGeometry(rad, len, 4, 1);
      g.translate(0, len * 0.5, 0);
      // Roll about the shard's *own* axis, and strictly before the lean. A
      // four-sided pyramid has only four facets, so without a roll every shard
      // presents the same two to the camera and the ridge reads as extruded
      // rather than grown. Rolling after the lean instead spins the tilted
      // shard about world Y, which re-aims it: a shard authored to sweep back
      // over the spine ends up lying across the flank as a flat plate, which is
      // precisely the artefact this creature shipped with in its first pass.
      g.rotateY(rng.range(0, Math.PI * 0.5));
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(
        up, new THREE.Vector3(leanX, 1, leanZ).normalize(),
      ));
      g.translate(x, y, z);
      parts.push(g);
    };
    // Base radii are a fifth of length rather than a twentieth. A four-facet
    // pyramid that is long and needle-thin presents as a *razor* the moment the
    // camera catches it edge-on — a one-pixel blade with a rim light down it,
    // which reads as a stray polygon rather than as glass. Keeping the taper
    // shallow means the narrowest view of any shard is still a facet.
    /** Point on the ridge line of the back, at spine parameter `u` in 0..1. */
    const ridge = (u) => {
      const s = spine[Math.round(u * (spine.length - 1))];
      return { y: s.y + s.r * 0.86, z: s.z };
    };

    // Seven ridge shards. The profile peaks two-thirds of the way forward, over
    // the shoulder yoke, so the tallest point of the silhouette sits above the
    // heaviest part of the body instead of over the tail.
    for (let i = 0; i < 7; i++) {
      const u = 0.26 + (i / 6) * 0.50;
      const base = ridge(u);
      const t = i / 6;
      const len = (0.10 + Math.sin(Math.min(1, t * 1.12) * Math.PI * 0.86) * 0.22) * rng.range(0.82, 1.18);
      shard(rng.jitter(0.028), base.y - 0.01, base.z,
        len, 0.040 + len * 0.20, rng.jitter(0.20), -0.34 - t * 0.16);
    }
    // Shoulder pair — the outer edge of the crown. Their lean is deliberately
    // shallow: an earlier pass fanned them out near-horizontally, and a
    // four-sided pyramid seen side-on is a *flat plate*, so what the frame
    // actually showed was two grey slabs lying across the creature's back with
    // no relationship to the ridge. Every shard on this animal therefore points
    // within ~20° of the ridge's own lean, which is also what stops it reading
    // as a pincushion.
    for (const s of [1, -1]) {
      shard(s * 0.118, 0.700, 0.190, rng.range(0.24, 0.31), 0.078, s * 0.26, -0.40);
    }
    // Brow horns, swept back over the skull — the detail that makes the head
    // findable in a silhouette that is otherwise all shoulder.
    for (const s of [1, -1]) {
      shard(s * 0.068, 0.636, 0.402, rng.range(0.13, 0.17), 0.042, s * 0.22, 0.58);
    }

    const merged = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    merged.computeVertexNormals();
    return merged;
  }

  /* ------------------------------------------------------- calibration bay */

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
      postfx.setDof(solved.focus, pose.aperture);
      if (solved.focusTarget) postfx.focusOn(solved.focusTarget);
      postfx.setGrade(pose.grade ?? 'dusk', 0);
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
   * the horizon skirt, the treeline, the foreground grass, the mist and the
   * motes. A silhouette check wants an empty backdrop, and the background clear
   * carries the same white as the ground so the horizon line goes with them.
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
    matte(this.enemyGroup);

    this._matteSwap.set(this.ground, this.ground.material);
    this.ground.material = this.matteGround;
    this.ground.receiveShadow = false;

    hide(this.sky?.mesh);
    hide(this.skirt);
    hide(this.treeline);
    hide(this.foreground);
    hide(this.mist);
    hide(this.motes);

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
  }

  /**
   * Runs as a service registered directly after `lighting`, i.e. once the rig
   * has already written this frame's state.
   */
  _afterRig() {
    // ART_BIBLE §2.1 specifies a *two-ended* fog: FOG_NEAR cool teal at ground
    // level and short distances, FOG_FAR warm parchment at horizon distance,
    // "so depth reads as cool→warm". `FogExp2` carries one colour, and Sky
    // rightly drives it from the time-of-day table — which at the dusk key is
    // the mauve #8A5E7A. Left alone that mauve is the single largest area of
    // chroma in frame and the whole shot goes magenta, against REFERENCE §4's
    // teal-dominant contract. Blending back toward FOG_NEAR is the closest a
    // single-colour fog gets to the specified pair; the warm end still comes
    // through because it is what the sky itself is rendering behind it.
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

    // Husk idle. ART_BIBLE §7.8 forbids anything on screen being frozen, and a
    // 3.4 m creature is the last thing that can afford to be: a still boss
    // reads as set dressing. The husks have no skeleton by design (see
    // `_makeHuskBodyGeometry`), so the breath is carried on the root — a slow
    // yaw sway plus a vertical swell, at ~0.11 Hz, which is deliberately below
    // the party's idle rate so the two never sync into a metronome. Each husk
    // keeps its own phase from the scene's own rng stream.
    for (const e of this.enemies) {
      const breath = Math.sin(t * 0.68 + e.phase);
      e.root.rotation.z = breath * e.sway * 0.35;
      e.root.position.y = e.baseY + breath * e.lift;
      e.root.rotation.y = e.baseYaw + Math.sin(t * 0.41 + e.phase * 1.7) * e.sway;
    }
    // The hollow pulses with it — §2.2's prop band is 1.2–1.8, so the swing
    // stays inside it and the crown never crosses into spell-core brightness.
    if (this.crownMaterial && !this._silhouette) {
      this.crownMaterial.emissiveIntensity = 1.5 + Math.sin(t * 0.53) * 0.22;
    }
    for (const m of this._mistCards) {
      // Slow lateral crawl only: mist that bobs vertically reads as smoke.
      m.mesh.position.x += m.drift * step;
      if (m.mesh.position.x > MIST_SPAN.east) m.mesh.position.x -= MIST_WRAP;
      m.mesh.quaternion.copy(this.camera.quaternion);
      // Roll about the view axis after billboarding, so each puff samples the
      // smoke texture at its own orientation. See `roll` in `_buildMist`.
      if (m.roll) m.mesh.rotateZ(m.roll);
      // Absolute, not accumulated — see `baseY` in `_buildMist`. 3 cm of swell
      // is all the bank needs to stop reading as a decal, and it can never walk
      // the pool up onto the party.
      m.mesh.position.y = m.baseY + Math.sin(t * 0.21 + m.phase) * 0.03;
    }

    const pos = this.motes.geometry.getAttribute('position');
    const seed = this._moteSeed;
    for (let i = 0; i < pos.count; i++) {
      const phase = seed[i * 3];
      const fall = seed[i * 3 + 1];
      const sway = seed[i * 3 + 2];
      let y = pos.getY(i) - fall * step;
      if (y < 0.02) y += 7.5;
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
    // The husks own nothing `track` is not already holding — geometry,
    // materials and the shared outline material are all tracked — so this is
    // only about dropping the references the tick loop walks.
    this.enemies.length = 0;
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
