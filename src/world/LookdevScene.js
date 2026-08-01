/**
 * LookdevScene — the calibration stage *and* the battle stage.
 *
 * Two jobs in one scene, deliberately, because they have to agree:
 *
 *  1. **Calibration bay**: the roughness/metalness sphere grid, the named-
 *     material bar and the chibi scale proxy. If the game looks wrong, this
 *     tells you which layer is lying — sky, probe, lighting rig, texture
 *     pipeline or post chain.
 *  2. **Battle stage**: the six roster characters staged exactly as
 *     REFERENCE_TARGET.md §2 describes a battle frame — a loose staggered
 *     diagonal on the **right**, facing left, against an **enemy mass on the
 *     left** that is dramatically larger than they are. This is the frame the
 *     art-direction critics judge, so it is composed to ART_BIBLE §5 rather
 *     than merely populated: three depth layers, a foreground occluder,
 *     thirds placement and visible atmospheric separation.
 *
 * The two never share a framing, and the constraint runs one way: the bay is
 * parked far to the south-west, *behind* every stage camera's station point,
 * so composition is never negotiated against it. An earlier layout put the bay
 * due west of the stage, which silently forbade every camera that looks west —
 * i.e. every reverse angle — and that is backwards: the diagnostic set should
 * bend around the shipped frame, not the other way round.
 *
 * The battle camera looks down -Z with no yaw, so screen-right is world +X and
 * the staggered diagonal is solvable on paper instead of by nudging. Slots are
 * authored as (screen x, depth along the view axis) and converted to world
 * coordinates by `stagePlacement`, which is what keeps every figure's *frame
 * height* — the number REFERENCE §2 actually specifies — under authorial
 * control rather than emergent from hand-placed metres.
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
import { LIGHT, ELEMENT, HERO_TIME_OF_DAY } from '../art/Palette.js';
import { makeNoise, smootherstep } from '../art/noise.js';

/**
 * Stage frame — the fixed side view of REFERENCE_TARGET §2.
 *
 * Every number here is a composition constraint rather than a preference:
 *
 *  - `pitch` 12° sits inside §2's "elevated ~10–18°". It is also the only
 *    control over where the horizon lands, because for a level-rolled camera
 *    the horizon's NDC height is exactly `tan(pitch) / tan(fov/2)` — 0.48 here,
 *    i.e. 74% up the frame. Steeper would push the sky out; shallower would
 *    walk the horizon toward frame centre, which ART_BIBLE §7.12 forbids.
 *  - `fov` 48° is mid-band of §2's "roughly 45–55°" and of ART_BIBLE §5.3's
 *    wide-lens range.
 *  - `camY` / `aimDist` are then the only free variables, and they are set so
 *    the party lands at 23–30% of frame height and the enemy boss at 41%.
 */
const STAGE = {
  camX: 1.90,     // camera x; party to the right of it, enemy mass to the left
  camY: 2.00,
  camZ: 8.40,
  pitch: 12,      // degrees down
  aimDist: 6.00,  // where the view axis crosses the aim height
  fov: 48,
};

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
 * `CLEARING` then has to cover both installations. The treeline scatters over
 * an annulus centred on the battle stage whose outer radius (240 m) swallows
 * the bay whole, so without an explicit hole conifers grow through the sphere
 * grid — which is what the previous captures show, and it makes the one frame
 * whose job is reading material response unreadable.
 */
const BAR = { x: -43, z: 31 };
const CLEARING = { x: -39, z: 30.5, radius: 15 };

/**
 * Multiplier on the ART_BIBLE §3 fog density, via the hook Sky publishes.
 *
 * The bible's densities (0.0018 noon … 0.0055 dusk) are authored for a world
 * where the subject is 1.75 m tall. Ours is 1.1 m, and every distance in the
 * staging shrinks with it — at 0.0055 the fog has removed 2% of contrast by
 * 25 m, where §5.5 requires layers to be *visibly* separating. Scaling the
 * density is exactly what `fogDensityScale` exists for, and it is the single
 * biggest contributor to REFERENCE §3's "heavy atmospheric perspective is the
 * signature": at 3× the treeline reads as the near-silhouette the reference
 * frames show instead of a fully-lit forest. Higher than 3 was tried and
 * rejected — past that the fog's own chroma becomes the largest area in frame
 * and the shot stops being a scene with haze in it.
 */
const FOG_SCALE = 3.0;

/** Shared height-field noise. Module scope because `BAY` and the stage-level
 *  plateau both need to sample it before any instance exists. */
const STAGE_SEED = 0x10057ade;
const STAGE_NOISE = makeNoise(STAGE_SEED);

/** Centre and extent of the levelled battle stage, in world metres. */
const STAGE_PLATEAU = { x: 1.2, z: 1.4, inner: 9.5, outer: 30 };

/**
 * The ground's analytic height field.
 *
 * Shared by the mesh displacement and by everything planted on it, so a prop
 * can never float or sink — sampling a displaced mesh back would mean either
 * a raycast per instance or an index lookup that silently breaks the first
 * time the tessellation changes.
 *
 * The plateau is a hard requirement of the staging, not a convenience: the
 * party's staggered diagonal and the enemy mass are solved in screen space
 * against a **flat** floor, and a metre of terrain swell under one flank
 * re-sorts the whole diagonal and tilts the contact decals. It therefore
 * levels the full 9.5 m stage radius — both sides, not just the party's —
 * and ramps back into the rolling field by 30 m, which is beyond the treeline's
 * inner limit so the horizon still reads as landscape rather than as a table.
 */
function groundHeight(x, z) {
  const n = STAGE_NOISE;
  const swell = n.fbm3(x * 0.0032, 0, z * 0.0032, { octaves: 4, gain: 0.55 }) * 9.0;
  const ripple = n.fbm3(x * 0.055, 11, z * 0.055, { octaves: 3, gain: 0.5 }) * 0.09;
  const r = Math.hypot(x - STAGE_PLATEAU.x, z - STAGE_PLATEAU.z);
  const flat = smootherstep(STAGE_PLATEAU.inner, STAGE_PLATEAU.outer, r);
  // The ripple keeps a floor even on the plateau: a mathematically level floor
  // under a low sun is one uniform value across the bottom of frame, with no
  // form for the grade to work on.
  return swell * flat + ripple * Math.max(0.15, flat);
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
 * The staggered diagonal, solved in screen space and converted back to world.
 *
 * `ndc` climbs monotonically while `depth` zig-zags, which is what turns a
 * straight rank into the loose diagonal REFERENCE §2 describes: no two
 * characters share a screen column, and the rear ranks read *higher* in frame
 * because the camera looks down. The depth band 4.40–5.15 m is not taste — it
 * is what puts every silhouette between 23% and 30% of frame height, which is
 * the size the reference stages a party at. Order is front-line first, exactly
 * like `gameState.party`.
 *
 * The band tops out at 0.84 rather than 0.90, and that ceiling is measured, not
 * chosen: `ndc` positions a figure's *root*, and at these depths a chibi plus
 * its weapon and cape spans about ±0.11 either side of it. The previous 0.90
 * therefore put the rear-rank silhouette's outer edge past 1.0 and the last
 * character in the diagonal shipped with its shoulder sliced off by the frame
 * edge in every stage capture. 0.84 leaves a ~0.05 margin, which survives the
 * widest cape in the roster.
 *
 * The **spacing** was then opened from 0.115 to 0.134 against that same ceiling,
 * by starting the run at 0.17 instead of 0.26. That is not aesthetics either: at
 * 4.6 m the battle frustum is 3.64 m of half-width, so a 0.6 m chibi-plus-hair
 * is 0.165 of `ndc` wide and the old pitch guaranteed every neighbour overlapped.
 * The staged captures show the consequence — the rear three fused into one mass
 * and three of the six faces were behind someone else's hair. At 0.134 the
 * overlap is a shoulder rather than a head, which is what a staggered diagonal
 * is supposed to look like.
 *
 * `turn` is how far the figure rotates **back toward the lens** from the axis
 * it would face if it squared up to the threat, and it is the single control
 * over whether this stage has faces in it. A party that simply addresses the
 * enemy line presents its cheek to a side camera at best and the back of its
 * skull at worst, which is exactly what the previous build shipped: the eye
 * build, the brows and every gram of the chibi read live on the front hemisphere
 * of a near-spherical head, so a figure 60°-plus off the lens is, visually, an
 * ovoid. Turning the body 15–23° off the threat axis puts every leading eye on
 * camera while leaving the address to the enemy legible, and it is the same
 * cheat a stage director uses to keep an actor open to the house.
 */
const PARTY = [
  { id: 'auren',  ndc: 0.17, depth: 4.40, turn: 0.40 },
  { id: 'kite',   ndc: 0.31, depth: 4.92, turn: 0.52 },
  { id: 'yshara', ndc: 0.45, depth: 4.52, turn: 0.36 },
  { id: 'bramm',  ndc: 0.58, depth: 5.12, turn: 0.48 },
  { id: 'seren',  ndc: 0.71, depth: 4.62, turn: 0.34 },
  { id: 'emrys',  ndc: 0.84, depth: 5.20, turn: 0.50 },
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
   * Party right at 23–30% of frame height in a three-quarter front address,
   * enemy mass left with the boss at 46% and the vanguard husk cropped into the
   * near-left corner, horizon on the upper third at 74%. Focus sits at 4.8 m,
   * on the party's 4.4–5.2 m band rather than split between it and the boss:
   * the faces are the subject of this frame, and f/5.6 still leaves the boss at
   * 8.6 m legible — the reference's backgrounds are soft, its combatants are
   * not.
   */
  battle: {
    pos: [STAGE.camX, STAGE.camY, STAGE.camZ], look: STAGE_LOOK,
    fov: STAGE.fov, focus: 4.8, aperture: 5.6, grade: 'battle',
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
    fov: 44, focus: 3.9, aperture: 4.0, grade: 'battle',
  },
  /** Battle station, battle lens, values flattened. The silhouette check has
   *  to be run on the shipped composition or it is checking nothing. */
  silhouette: {
    pos: [STAGE.camX, STAGE.camY, STAGE.camZ], look: STAGE_LOOK,
    fov: STAGE.fov, focus: 5.0, aperture: 22, grade: 'neutral', silhouette: true,
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

/** Outer radius and rim rise of the fogged horizon skirt, in metres. */
const SKIRT_RADIUS = 9000;
const SKIRT_RISE = 62;

/** How far the scene pulls Sky's fog colour back toward the palette's near teal. */
const FOG_NEAR_TEAL = new THREE.Color(LIGHT.FOG_NEAR);
const FOG_COOLING = 0.34;

/** Ambient fill left burning in silhouette mode: enough to see form, not value. */
const SILHOUETTE_FILL = 0.015;

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
    this._entryPose = opts.pose && opts.pose in CAMERA_POSES ? opts.pose : 'battle';
    this._pose = this._entryPose;
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

    // Silhouette mode has to overwrite the rig *after* it has run, and the rig
    // ticks as a service — i.e. after `Scene.update`. Registering the override
    // as a service immediately behind `lighting` is the only ordering that
    // survives without reaching into Lighting's internals.
    engine.register('lookdev-stage', { update: () => this._afterRig() });

    this._refreshEnvironment(forge);

    this._buildGround(forge);
    this._buildTreeline(forge);
    this._buildForeground(forge);
    this._buildMist(forge);
    this._buildMotes(forge);
    this._buildBacklight();

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
    // the forge guards those against `disposeTree`. ART_BIBLE §2.3 wants ~15%
    // of the frame below 0.08 — a ground plane returned at full albedo under a
    // 2.4-intensity dusk key lands the entire lower half in the midtones and
    // the shot goes flat, so the stage floor is pulled down and cooled.
    this.groundMaterial = forge.material('grass', { repeat: 400 }).clone();
    this.groundMaterial.color.setRGB(0.52, 0.58, 0.60);
    this.groundMaterial.envMapIntensity = 0.35;
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

    // The silhouette check needs the backdrop to hold value while the subjects
    // lose it, so the ground swaps to an unlit mid-tone. Tinted parchment, not
    // grey — ART_BIBLE §7.2 has no exemption for diagnostic frames.
    this.groundSilhouetteMaterial = this.track(new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xc4b49a).multiplyScalar(0.62),
      fog: true,
    }));
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

    // Three fades, all of them fixing the same class of defect: a billboarded
    // card is a *quad*, and any straight edge of that quad that ends up inside
    // the frame is read instantly as a rectangle lying across the shot.
    //
    // 1. **Ground fade.** This is the one that actually mattered. A card is a
    //    vertical plane and its lower half is *below* the terrain, so the
    //    ground in front of it wins the depth test — and the intersection of a
    //    plane with a near-level floor is a straight line, which is why the
    //    reverse-angle frame had a razor-sharp horizontal cut across the mist
    //    at ground level. No amount of softening the sprite touches it, because
    //    the edge is the depth buffer's, not the texture's. Fading by world
    //    height retires each card before it reaches the floor, and as a bonus
    //    it is what actually makes the bank *pool*: density now ramps in over
    //    the first half metre instead of being uniform top to bottom.
    // 2. **Radial edge mask**, so a card's own border can never show even where
    //    nothing occludes it — elliptical in world space, because the cards are
    //    scaled non-uniformly, which is the right shape for a puff anyway.
    // 3. **Camera-proximity fade**, for cards close enough that their unmasked
    //    middle fills the lens.
    //
    // All three multiply the *whole* premultiplied RGBA, which is the correct
    // operator for this blend: it lerps the fragment toward the destination
    // rather than toward black.
    mat.onBeforeCompile = (shader) => {
      // Restored by 5 m — closer than any card the compositions rely on — and
      // opening at 1.2 m, well outside the 0.08 m near plane so no card is ever
      // clipped part-way through its fade.
      shader.uniforms.uMistNearFade = { value: new THREE.Vector2(1.2, 5.0) };
      // The stage plateau is level at y = 0, so -0.20 is comfortably under the
      // floor and 0.38 m is ankle height on a 1.15 m chibi — high enough to
      // hide the depth cut, low enough that the bank still reads as pooling on
      // the ground rather than as a band floating over it.
      shader.uniforms.uMistGroundFade = { value: new THREE.Vector2(-0.20, 0.38) };
      shader.vertexShader = `varying float vMistDepth;\nvarying float vMistY;\nvarying vec2 vMistUv;\n${shader.vertexShader}`.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
	vMistDepth = - mvPosition.z;
	vMistY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;
	vMistUv = uv;`,
      );
      shader.fragmentShader = `uniform vec2 uMistNearFade;\nuniform vec2 uMistGroundFade;\nvarying float vMistDepth;\nvarying float vMistY;\nvarying vec2 vMistUv;\n${shader.fragmentShader}`
        .replace(
          '#include <dithering_fragment>',
          `gl_FragColor *= smoothstep( 0.50, 0.18, length( vMistUv - vec2( 0.5 ) ) )
		* smoothstep( uMistGroundFade.x, uMistGroundFade.y, vMistY )
		* smoothstep( uMistNearFade.x, uMistNearFade.y, vMistDepth );
	#include <dithering_fragment>`,
        );
    };
    // three keys its program cache on defines and material class, not on
    // `onBeforeCompile`; without an explicit key this material and any other
    // `MeshBasicMaterial` with the same defines would share one compiled
    // program and whichever compiled first would win.
    mat.customProgramCacheKey = () => 'aw-mist-nearfade';
    this.mistMaterial = mat;

    const geo = new THREE.PlaneGeometry(1, 1);
    this.track(geo);
    const group = new THREE.Group();
    group.name = 'mist';
    const rng = this.rng;
    this._mistCards = [];
    // Two populations. The low bank pools at ankle height across the whole
    // stage — REFERENCE §3's mist "pooling low to the ground". The tall bank
    // sits behind the party and in front of the treeline, which is what gives
    // the cast a bright field to silhouette against instead of tree trunks.
    for (let i = 0; i < 46; i++) {
      const tall = i >= 30;
      const card = new THREE.Mesh(geo, mat);
      const w = tall ? rng.range(16, 34) : rng.range(6, 17);
      card.scale.set(w, w * (tall ? rng.range(0.28, 0.45) : rng.range(0.18, 0.30)), 1);
      // Spans the whole stage including the enemy half. An earlier layout
      // folded everything west of -12 back east to keep haze off the
      // calibration bay; with the bay moved south that fold only served to
      // strip the mist off the enemy mass, which is the one place REFERENCE §3
      // most wants it — a boss rising out of a bank reads as a threat, a boss
      // standing on clean grass reads as a prop.
      card.position.set(
        rng.range(MIST_SPAN.west, MIST_SPAN.east),
        tall ? rng.range(1.4, 3.4) : rng.range(0.18, 0.85),
        tall ? rng.range(-26, -6) : rng.range(-16, 11),
      );
      card.renderOrder = 6;
      group.add(card);
      this._mistCards.push({ mesh: card, drift: rng.range(0.05, 0.16), phase: rng.range(0, 6.28) });
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
   * The silhouette pass's only light: a hard back-key from beyond the party,
   * raking toward camera. Off in every other pose.
   */
  _buildBacklight() {
    // Modest, deliberately. The toon shader's tinted shadow gradient is an
    // additive term inside `RE_Direct`, so it scales with *every* light in the
    // scene including this one — drive the backlight hard and the party stops
    // being black and starts being navy, which defeats the whole check.
    const light = new THREE.DirectionalLight(0xdfe8ff, 1.9);
    light.position.set(6.5, 5.0, -22);
    light.target.position.set(4.0, 0.6, 1.0);
    light.castShadow = false;
    light.visible = false;
    this.scene.add(light, light.target);
    this.backLight = light;
  }

  /* --------------------------------------------------------------- staging */

  /**
   * Contact-shadow decal for the figures that have no rig of their own.
   *
   * The cascades give the stage a real cast shadow, but at the dusk key the sun
   * is 6° above the horizon, so that shadow lands several metres downwind and
   * nothing anchors the feet — a figure reads as a sticker layer pasted onto
   * the terrain. A radial decal under it is the grounding the reference frames
   * show, and because it is authored rather than derived it survives any change
   * of hour.
   *
   * **Multiplicative, not blended.** A decal that lerps the destination toward
   * a fixed tint is only a shadow where the ground is brighter than the tint;
   * on the crushed stage floor (§2.3 puts ~15% of the frame under 0.08) a
   * SHADOW_TINT decal is *brighter* than what it lands on, so each figure got a
   * teal puddle glowing under its boots. `MultiplyBlending` over a
   * premultiplied fragment resolves to `dst * mix(1, tint, coverage)` — a true
   * attenuation that can only ever darken, at any hour and over any ground
   * albedo. (three refuses `MultiplyBlending` without `premultipliedAlpha`,
   * because the operator is only correct on a premultiplied source.)
   *
   * @param {number} x @param {number} z ground position
   * @param {number} radius footprint radius in metres
   */
  _contactDecal(forge, x, z, radius) {
    if (!this._decalGeo) {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.rotateX(-Math.PI / 2);
      this._decalGeo = this.track(geo);
      this._decalMat = this.track(new THREE.MeshBasicMaterial({
        alphaMap: forge.texture('glow'),
        // The multiplier the ground is driven to at full coverage. Teal rather
        // than neutral because §2.1 forbids a zero-saturation shadow term, and
        // this one is literally a shadow.
        color: new THREE.Color(LIGHT.SHADOW_TINT).multiplyScalar(1.35),
        transparent: true,
        opacity: 0.78,
        premultipliedAlpha: true,
        blending: THREE.MultiplyBlending,
        depthWrite: false,
        // Unfogged and untonemapped: this is a *modulation* of pixels that have
        // already been fogged and graded, so putting it through either stage a
        // second time would double-apply them.
        fog: false,
        toneMapped: false,
      }));
    }
    const blob = new THREE.Mesh(this._decalGeo, this._decalMat);
    // Squashed along Z because the key rakes almost horizontally: a circular
    // pool under a 6° sun is the one shape it cannot be.
    blob.scale.set(radius, 1, radius * 0.86);
    blob.position.set(x, groundHeight(x, z) + 0.012, z);
    blob.renderOrder = 2;
    return blob;
  }

  /**
   * Build the six roster characters and stage them on the right of the battle
   * frame, in the staggered diagonal REFERENCE §2 specifies.
   *
   * `lighting` is passed so `ToonMaterial` aliases the rig's key/rim uniform
   * objects — that is what makes the whole party re-key on a time-of-day change
   * without a per-frame call — and `forge` so the toon ramp and detail normals
   * come from the shared library instead of the shader's internal fallback.
   */
  _buildCast(forge) {
    const group = new THREE.Group();
    group.name = 'cast';
    PARTY.forEach((slot, i) => {
      const place = PARTY_PLACES[i];
      const character = buildCharacter(slot.id, forge, {
        lighting: this.lighting, outline: true, outlineWidth: OUTLINE_PIXELS,
      });
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
      // No stage decal here. `buildCharacter` now ships its own contact shadow —
      // a body blob plus two foot blobs that track the feet and fade as they
      // lift, which is strictly better than a static disc because it survives
      // animation. Adding a second one on top was double-darkening the ground
      // and, at 1.35 × height, drawing a pool wider than the figure standing in
      // it. The husks keep `_contactDecal` because they have no rig to carry one.
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
      group.add(this._contactDecal(forge, place.x, place.z, spec.height * 0.62));
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

    /**
     * Tapered limb segment between two points.
     *
     * Capped, not open-ended, even though both ends are buried inside the body
     * or a paw. An inverted-hull outline renders the *back* faces of whatever
     * it wraps, so an open tube hands it a clear view straight down the bore
     * and the hull paints the far wall as a flat plate hanging in mid-air —
     * which is exactly what the first render of this creature showed.
     */
    const bone = (a, b, ra, rb) => {
      const d = new THREE.Vector3().subVectors(b, a);
      const len = d.length();
      const g = new THREE.CylinderGeometry(rb, ra, len, 10, 1, false);
      g.translate(0, len * 0.5, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), d.normalize(),
      ));
      g.translate(a.x, a.y, a.z);
      parts.push(g);
    };
    const paw = (x, y, z, r) => {
      const g = new THREE.SphereGeometry(r, 14, 10);
      g.scale(1.0, 0.86, 1.25);
      g.translate(x, y, z);
      parts.push(g);
    };

    for (const s of [1, -1]) {
      // Forelimbs are straighter and planted well forward of the shoulder, so
      // the whole mass leans into the party's half of the stage.
      bone(new THREE.Vector3(s * 0.190, 0.500, 0.235),
        new THREE.Vector3(s * 0.245, 0.280, 0.358), 0.100, 0.076);
      bone(new THREE.Vector3(s * 0.245, 0.280, 0.358),
        new THREE.Vector3(s * 0.250, 0.095, 0.382), 0.076, 0.058);
      paw(s * 0.250, 0.078, 0.400, 0.086);
      // Hind legs fold under the haunch — a crouch loaded to spring.
      bone(new THREE.Vector3(s * 0.185, 0.340, -0.100),
        new THREE.Vector3(s * 0.215, 0.170, -0.205), 0.104, 0.076);
      bone(new THREE.Vector3(s * 0.215, 0.170, -0.205),
        new THREE.Vector3(s * 0.202, 0.090, -0.060), 0.076, 0.062);
      paw(s * 0.200, 0.076, -0.038, 0.084);
    }

    const merged = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    merged.computeVertexNormals();
    return merged;
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

  /**
   * Flatten the frame to black shapes (ART_BIBLE §5.6): kill every front light,
   * hold the backdrop at value with an unlit ground, and rake a single hard key
   * in from behind the party so the edges separate.
   */
  _setSilhouette(on) {
    if (on === this._silhouette) return;
    this._silhouette = on;

    this.scene.environment = on ? null : (this._environment ?? null);
    this.backLight.visible = on;
    this.mist.visible = !on;
    this.motes.visible = !on;
    this.ground.material = on ? this.groundSilhouetteMaterial : this.groundMaterial;
    this.ground.receiveShadow = !on;
    // Catch-lights and rune glow are unlit by design, so they survive a
    // blackout as bright specks and break the read.
    for (const c of this.cast) {
      for (const mesh of c.root.children) {
        if (mesh.material === c.materials.glow) mesh.visible = !on;
      }
      c.bones.head.traverse((o) => {
        if (o.isMesh && o.material === c.materials.glow) o.visible = !on;
      });
    }
    // Same treatment for the husks: the eyes are unlit and the crown is
    // emissive, so both survive a blackout and would put four bright violet
    // specks on the one frame whose entire job is reading pure black shapes.
    for (const e of this.enemies) {
      for (const child of e.root.children) {
        if (child.material === this.huskEyeMaterial) child.visible = !on;
      }
    }
    if (this.crownMaterial) this.crownMaterial.emissiveIntensity = on ? 0 : 1.5;
    // `rimBoost` is the rig's own multiplier, so the toon rim goes with it and
    // no material has to be touched.
    this.lighting.rimBoost = on ? 0 : 1;
    this.lighting.sync();
  }

  /**
   * Runs as a service registered directly after `lighting`, i.e. once the rig
   * has already written this frame's state. In silhouette mode it zeroes the
   * front-lighting terms the rig just published — both the analytic lights and
   * the uniform block the toon materials read.
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

    if (!this._silhouette) return;
    const L = this.lighting;
    if (!L) return;
    for (const l of L.csm?.lights ?? []) l.intensity = 0;
    L.fill.intensity = SILHOUETTE_FILL;
    L.rim.intensity = 0;
    const u = L.uniforms;
    u.uKeyColor.value.setRGB(0, 0, 0);
    u.uRimColor.value.setRGB(0, 0, 0);
    u.uFillSky.value.copy(L.fill.color).multiplyScalar(SILHOUETTE_FILL);
    u.uFillGround.value.copy(L.fill.groundColor).multiplyScalar(SILHOUETTE_FILL);
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
      m.mesh.position.y += Math.sin(t * 0.21 + m.phase) * 0.0009;
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
    for (const c of this.cast) c.dispose();
    this.cast.length = 0;
    // The husks own nothing `track` is not already holding — geometry,
    // materials and the shared outline material are all tracked — so this is
    // only about dropping the references the tick loop walks.
    this.enemies.length = 0;
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
