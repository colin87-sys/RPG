/**
 * LookdevScene — the calibration stage *and* the battle stage.
 *
 * Two jobs in one scene, deliberately, because they have to agree:
 *
 *  1. **Calibration bay**: the roughness/metalness sphere grid, the named-
 *     material bar and the chibi scale proxy. If the game looks wrong, this
 *     tells you which layer is lying — sky, probe, lighting rig, texture
 *     pipeline or post chain.
 *  2. **Battle stage**: the game's default party staged as
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
 * silhouettes. **The plate is mostly none of those things**, and where it
 * disagrees the plate wins:
 *
 *  - The plate shows **no enemy in frame** — its party addresses something off
 *    the right edge. This stage does carry one, because a battle staging that
 *    cannot show what is being fought is not reviewable, and §2's "dramatically
 *    larger enemy mass on the left" is the one part of the prose the plate does
 *    not actually contradict; it simply declines to show it. So the plate's
 *    *device* is kept and mirrored: the threat sits at the left edge, cropped by
 *    it, larger than anything in the line, and the line addresses it. See
 *    {@link ENCOUNTER}.
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
  buildConiferTree, buildBroadleafTree, buildBoulderCluster, buildFlowerPatch,
  buildSeedGrass, buildGroundCover,
  updateFlora, setFloraWind, FLORA_PALETTE,
} from './Flora.js';
import { buildCreature } from './Bestiary.js';

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
 * Where the material bar stands.
 *
 * The bar used to run *along* the bay's z axis with its camera at the end of
 * the row, so the nine cubes stacked one behind another in perspective and the
 * far six were a smear behind the near one — a diagnostic that cannot be read
 * is not a diagnostic. It now runs along X and is shot broadside, which means
 * it needs its own patch of ground clear of the sphere grid's sightline: nine
 * cubes at 0.95 m pitch is 7.6 m wide, and 9 m west of the grid puts the whole
 * row outside the `sphere-grid` pose's 3.4 m half-width at that depth.
 *
 * A `CLEARING` constant used to sit here, punching a hole in the treeline so it
 * could not grow through the calibration installations. It is gone because the
 * belt no longer scatters over an annulus that reaches them — every tree line is
 * now a bounded disc well north of the stage, and `_floraMask` rejects anything
 * at `z ≥ camZ + 1` outright, which covers the bay's z = 30 by a wide margin.
 * A guard against a condition that can no longer arise reads as a live
 * constraint, which is worse than no guard at all.
 */
const BAR = { x: -43, z: 31 };

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
 * y ≈ 430, which is 29% of frame and the closest the staged line leaves room
 * for.
 */
const BANK = { from: 1.2, to: -22, height: 3.1, inner: 4.5, outer: 9.0 };

/**
 * Front edge of the flower bed, in world z.
 *
 * Everything the bed is made of is scattered about a centre *behind* the line,
 * but with a radius large enough to reach past it, so the bed needs a hard
 * front plane or lavender grows through the cast. 0.5 m sits 1.7 m behind the
 * deepest figure (Kite at z = 2.23), which on the plate is about where the
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
 * edges are feathered, because a hard boundary between bare earth and mown
 * grass is the one thing real ground never has.
 *
 * **Half the width, and pushed a further 0.6 m out.** At 4.5 m the band was not
 * a track, it was a *field* of bare earth: measured on the shipped capture it
 * covered the whole bottom-left eighth of the frame in warm tan, and it is the
 * single largest area of exposed soil in an image whose reference has none worth
 * the name. The plate does carry a path in that corner — but it is narrow, it is
 * grassed over along its middle, and it is gone by a third of the way up the
 * frame. 2.2 m wide from `x0 = −1.6` reproduces that: a wedge in the extreme
 * corner, out of frame by z = 4.3, and the grass mask now *thins* over it rather
 * than clearing it (see `_floraMask`), so it reads as worn ground rather than as
 * a hole in the meadow.
 *
 * ## Re-solved against the plate's own boundary, not re-argued
 *
 * The note above is right that the plate's track is not a field of soil, and it
 * is wrong about where the track *is* — a width was tuned when the error was in
 * the band's position, so no capture of this stage has ever had a visible path
 * in it. Widening a band whose near edge already sits behind the lens changes
 * nothing on screen: `t` runs from the band's far edge (up-frame) to its near
 * one, and at 2.2 m the near edge was at z ≈ 7.1, i.e. half a metre from the
 * camera and well past the 5.4 m at which the frustum's lower edge leaves the
 * ground. Every metre of that width was spent off the bottom of the image.
 *
 * The far edge is the one the eye reads, so it is solved through two points
 * measured off `bravely01.jpg`. Its worn ground is bounded above by a line from
 * (0, 760) to (1150, 1080) of 1920 × 1080. Un-projecting both through this
 * camera — depression = `STAGE.pitch + atan(ndc_y · tan(fov/2))`, ground range
 * = `camY / tan(depression)` — puts them at world (−2.56, 3.65) and (0.28,
 * 5.40). That is a slope of 0.62 in z per metre of x, and `z = 4.23 + 0.62·(x +
 * 1.6)` passes through both to within a centimetre. `width` then only has to be
 * large enough that the near edge clears the lens: 3.96 m does at frame left, so
 * 4.2 with the feather outside it.
 *
 * The number matters because the track is where the plate's foreground gets its
 * light. Over that region the plate reads p50 **(120,132,82), V 0.52, hue 74°**
 * against the mown lawn beside it at V 0.47 / hue 86°, and it is 9% of the
 * image. Our own foreground came back V 0.35 at hue 131° — two thirds of a stop
 * dark and 57° cold — and a track that never appeared is a large part of why.
 *
 * The feather comes up with the band. 1.4 m across a boundary running the width
 * of the bottom-left corner is the same *proportion* of soft edge the 1.0 m
 * feather gave the old 2.2 m band, and the plate's own transition from lawn to
 * wear is not resolvable as an edge anywhere along its length.
 */
const PATH = { x0: -1.6, z0: 4.23, dx: 0.62, dz: 1.0, feather: 1.4, width: 4.2 };

/**
 * How much of the lawn a fully-covered path fragment actually removes.
 *
 * Not 1. A track through a meadow is *worn*, not sterilised: the plate's own
 * shows grass standing in it, thinner and shorter than the lawn beside it but
 * continuous, and the boundary you read is a density change rather than an edge.
 * Clearing the band outright is what turned our path into a tan plate with a
 * hard rim, and it is the other half of why the corner read as bare soil.
 *
 * 0.28 rather than 0.35, together with the near lawn's own thinning below. The
 * survival fraction only decides what the track looks like *relative to* the
 * lawn density it is cut out of, and that density has come down — at 0.35 of a
 * 250/m² turf the track still carried 87 blades/m², which is more grass than the
 * plate's untrodden lawn has and is why no capture of this stage has ever shown
 * a path.
 *
 * **0.18.** With the band re-solved onto the plate's own boundary the track
 * finally appears, and it is still not carrying its light: measured over the
 * bottom-left corner (0–380, 930–1080) the plate reads **(167, 148, 112), hue
 * 39°, V 0.65** and ours came back (123, 134, 105) at hue 83° / V 0.53 — green
 * still the dominant channel where the plate's is red. A worn track is worn:
 * the plate's does carry grass, but as isolated survivors, not as a thinner
 * lawn.
 */
const PATH_GRASS_SURVIVAL = 0.18;

/**
 * Where the cherry stands, how tall it is, and how high its petals drift.
 *
 * Module scope because two things need it and must not disagree: `_buildMeadow`
 * plants the tree, and `_buildMotes` seeds the falling petals in a column
 * around it. A petal cloud that has drifted away from the tree that shed it is
 * the failure this constant exists to make impossible.
 *
 * **Moved back and inboard, from (−6.0, −2.2) at 3.6 m.** Two reasons, and the
 * first is that the creature now stands where the tree used to project: at the
 * old station the canopy covered px −301 → 417 of 1920 and the encounter owns
 * px −57 → 249, so the frame's largest silhouette would have been read against
 * a pink mass at the same depth-order ambiguity a review cannot resolve.
 *
 * The second is that the old placement was wrong against the plate anyway. The
 * plate's blossom is a **background** mass: it sits behind the flower bed, its
 * canopy runs off the top-left corner, and its lower edge stops well above the
 * party's heads — measured, y 90 → 560 of 1080 with the nearest head at 326. At
 * (−3.6, −4.5) and 3.2 m the canopy spans px 232 → 806 and y 15 → 265, which
 * puts it above the heads (320–383) and hard against the top edge, and leaves
 * the encounter its own column of frame.
 *
 * **`height` 4.4 → 5.4, and only the height.** At 4.4 the canopy crested at
 * y ≈ 50 and left an open pale sky strip along x 0 → 560 of the top edge, which
 * is the one corner the plate closes hardest — its blossom runs *off* the top
 * left rather than stopping under it. Growing the tree rather than moving it
 * nearer is deliberate: a metre of extra trunk raises the crown without lowering
 * the canopy's underside, and the underside is the constraint, because it has to
 * stay clear of Auren's crown at y 325. Measured on the 4.4 m capture that
 * clearance was 75 px, and a taller tree at the same station keeps it.
 */
const CHERRY = { x: -5.9, z: -6.4, height: 5.4, spread: 1.55, drift: 4.6 };

/**
 * Grey slate, as a multiplier on whatever `props/RockForms.js` authored.
 *
 * That module writes the plate's *facet relationship* — a pale weathered top
 * over a cleaved blue side — and the relationship is right; what it cannot know
 * is the exposure of the frame it lands in. Measured on our own capture the wall
 * renders p50 sRGB 180+ where the plate's top band reads **p50 57 at 0.53
 * saturation**, so the rock is better than a stop hot and comes back as chalk
 * against a meadow that is correctly keyed. Two rounds of staging notes in
 * `_buildMeadow` record the consequence: the wall could not be allowed to grow,
 * because every extra block *lifted* the top of frame instead of closing it.
 *
 * `0xc2c6d6` multiplied in linear light takes the up-faces' `#b4bcc6` to about
 * `#8a96ab` and the cleaved sides' `#55617e` to `#3d4a66` — the plate's own
 * values to within a few code points, with the facet contrast untouched because
 * a multiply is the one operation that cannot change a ratio.
 *
 * **It shipped a stop hot anyway, and this is the corrected value.** Sampled
 * across eight 60 px boxes along the wall's lit band the capture read a mean of
 * V 0.55 at S 0.20–0.31, against `bravely01.jpg`'s massif at **V 0.36, S 0.52**
 * — half again too bright and half as chromatic, which is why our rock came back
 * as pale lilac card and the plate's reads as wet slate. The arithmetic the
 * paragraph above relies on is what makes the fix a single number: because the
 * tint multiplies in linear light, the *displayed* value scales by the tint's own
 * sRGB code point, so V 0.55 → 0.36 is a flat 0.65 ×. Applied per channel as
 * 0.62 / 0.68 / 0.76 rather than uniformly, which spends the same value drop on
 * widening the red-to-blue gap and lands the saturation on the plate's 0.52
 * instead of leaving it at 0.25.
 *
 * **`0x3e5c89`, and the correction above landed roughly half of what it claimed.**
 * Re-measured on the shipped capture over the wall's own band (x 560–900,
 * y 40–180) against the plate's massif (x 560–900, y 60–200):
 *
 * | | med sRGB | hue | sat | val |
 * |---|---|---|---|---|
 * | plate | (32, 58, 96) | 216° | **0.67** | **0.38** |
 * | ours  | (62, 85, 114) | 214° | 0.46 | 0.45 |
 *
 * The hue is landed — that part worked — and the value and the chroma are not:
 * still a fifth too bright at two thirds of the plate's saturation, so the wall
 * reads as blue-grey card rather than as the dark, wet, saturated mass that is
 * the plate's whole upper third. By the same power-law identity the note above
 * establishes, the displayed ratio *is* the sRGB ratio on the tint, so the fix
 * is the measured per-channel ratio applied to the tint in place: 32/62, 58/85,
 * 96/114 = 0.52 / 0.68 / 0.84 on `0x7887a3`.
 *
 * This is also what the upper third needs compositionally. `_buildMeadow`'s belt
 * notes record two rounds spent fighting a sky band that would not close; a
 * massif at V 0.45 against a sky at V 0.40 has no silhouette to close it with,
 * and at V 0.38 it does.
 *
 * **`0x2a538a`, spending the last of the gap on chroma rather than on value.**
 * Re-measured after the frame went sharp — the far-field defocus was flattening
 * the wall's own facet distribution, so the box above had been sampling a blur —
 * the massif (x 430–900, y 60–240) now reads (44, 63, 91) against the plate's
 * (25, 55, 92): **hue 216° against 213° and V 0.36 against 0.36, both landed**,
 * with saturation 0.52 against 0.73 the only term left. Saturation at fixed
 * value is a statement about the *gap between channels*, so the residual is
 * spent entirely on red — 25/44, 55/63, 92/91 on the previous tint — which
 * takes the wall from blue-grey to the deep cleaved blue the plate's is, without
 * moving the value the paragraph above solved for.
 */
const ROCK_TINT = 0x2a538a;

/**
 * The same slate at the bed's depth rather than at the massif's.
 *
 * {@link ROCK_TINT} is measured on rock standing 18 m out through its own aerial
 * haze, and the mid-ground clusters sit at 5–12 m where that haze has not
 * happened yet — the identical argument {@link NEAR_STONE_TINT} makes at 4 m,
 * one depth band in. Applying the massif's value there would put 2 m blocks at
 * V 0.38 immediately behind a party keyed at V 0.5+, which reads as holes in the
 * bed rather than as stone in it.
 *
 * **`0x7d8ba4`, and the first attempt at this constant put it far too near the
 * massif.** At `0x5b6f94` the mid-ground blocks rendered V 0.35–0.39 — the
 * massif's own value, twelve metres nearer — and with the bed no longer
 * defocused they resolved as isolated dark wedges standing in bright violet.
 * The plate has nothing like that: zoom its bed and the only rock inside it is
 * a pale grey shoulder at (820–1000, 100–250) that is *lighter* than the
 * flowers around it, because a boulder at the bed's depth is in the same direct
 * sun the bed is. Value, not size, is what made ours read as debris.
 *
 * So this sits a shade *above* the tint `RockForms` authors rather than below
 * it, and the near stations shrink with it so the block crests the lavender by
 * a head instead of standing clear of it.
 */
const MID_ROCK_TINT = 0x7d8ba4;

/**
 * The same slate, four metres from the lens instead of eighteen.
 *
 * {@link ROCK_TINT} is a *cool* blue-grey and that is not a property of the
 * stone, it is a property of the twenty metres of air in front of it — the same
 * shift that puts the plate's own massif at hue 218° while the rock chips
 * scattered on its lawn read warm. Applied to a stone at the party's feet it
 * produces the defect the capture shows: a 67 px blue lozenge on grass at hue
 * 92°, the only object below the horizon that is not green, warm-grey or violet.
 *
 * Warmer and half a stop lighter, because a near stone is in direct sun with a
 * lawn bouncing green into its undersides rather than in a distant mass's own
 * shade. The facet contrast is untouched, as with `ROCK_TINT`, because a
 * multiply cannot change a ratio.
 */
const NEAR_STONE_TINT = 0x9a9384;

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
 *     Whoever stands in the line has to fit inside that 5.4 m, and it is the
 *     constraint that decides how many of them there can be: see the four-figure
 *     note below.
 *  2. **Heads land on a level line and cannot be separated vertically.** A
 *     camera at crown height projects every crown to the horizon row regardless
 *     of depth, so depth buys *feet* separation and nothing else. Horizontal
 *     clearance therefore has to be real: at these depths a head is 0.065–0.095
 *     of `ndc` across and the slot pitch is 0.337, so the nearest pair of skulls
 *     clears by 3.5×.
 *
 * `face` is **degrees the head ends up off the lens axis** — 0 is straight down
 * the barrel, 90 is dead profile — and it is the single control over whether
 * this stage has faces in it. Measured on the plate the four figures sit 43°,
 * 45°, 59° and 75° off the lens, near profile for the armoured lead and
 * three-quarter front for the casters, and the column below reproduces that
 * spread rather than putting everyone at one flattering angle.
 *
 * It replaced a `turn` column that stated the rotation *back toward the lens
 * from the threat bearing*, and the replacement is the correction that made the
 * mirrored staging viable at all. A turn is only equivalent to a presentation
 * angle when the threat and the camera are on opposite sides of the figure,
 * which was true while the threat was off the right edge and every slot sat
 * left of the axis. Move the threat to the left and both are on the *same*
 * side: the same `turn` values then measured 106°, 67°, 68°, 63°, 60° and 34°
 * off the lens — the party leader shipped as the back of a skull, and nothing
 * about the column said so. Authoring the presentation angle directly makes the
 * number that matters the number that is written down, and it holds whatever
 * the threat bearing or the slot's screen position later become.
 *
 * ## Where the two ends of the line are pinned
 *
 * Staging the encounter (see {@link ENCOUNTER}) costs frame width, and the
 * budget is fixed at both ends: the creature has to be *at* the left edge to be
 * the thing the line is addressing, and the HP/MP/BP stack owns everything past
 * `ndc` +0.56 — measured on the plate, whose own rightmost figure centres at
 * +0.49 with only her bow under the stack. The line therefore spans `ndc`
 * −0.52 → +0.49, Kite centring exactly where the plate's archer does, and
 * Auren's silhouette starting at −0.63 where the creature's ends. The
 * alternative — a wider lens — would have shrunk the near figure below the
 * plate's measured 39% of frame height, which is the one number this whole file
 * is solved against.
 *
 * ## The recession, and the 35° that is not available
 *
 * Measured on `bravely01.jpg` the plate's four figures' feet land at y 745,
 * 755, 800 and 870 — a **monotone recession** from the figure nearest the
 * threat (Adelle, frame right, feet lowest) back to the one furthest from it
 * (Seth, frame left). Our threat is at frame *left*, so the same run is
 * mirrored: Auren nearest, Kite deepest, 1.30 m of depth across the line and
 * every adjacent pair separated in z as well as in x. A line at one station —
 * which is what an order chosen only to stagger the feet produces — reads as a
 * row of cut-outs pinned to a backdrop, because every silhouette then meets the
 * meadow at the same depth and nothing overlaps anything.
 *
 * The review asked for the camera to sit **35° off the party line** and that is
 * not reachable at this frame's other constraints, which is worth writing down
 * rather than silently missing. The line's world width is fixed by the near
 * figure's frame height (see the invariant above) at 3.16 m here; the depth run
 * is bounded by the frame-height band the plate itself holds, 0.29–0.39, which
 * at this party's 1.00–1.19 m height spread allows depths of 4.20–5.50 and no
 * more. `atan(1.30 / 3.16)` is **22.4°**, and buying the remaining 13° costs
 * either a rear figure under 0.24 of frame height — below the size at which a
 * chibi's painted eyes resolve at all — or a wider lens, which flattens the
 * compression that is the plate's most distinctive property. 22.4° is what the
 * frame has; it is two thirds of the ask and it is the whole of what the
 * geometry permits.
 *
 * `face` keeps the plate's *ordering* — the figure nearest the threat is the
 * most profile and the far end is the most frontal — but the column is
 * compressed into 42°–58° against the plate's 43°–75° spread, because the
 * plate's 75° sits on a head 148 px tall and ours are 90. At 68° a chibi's near
 * eye is fully occluded by its own cheek mass; 58° is where both eyes are still
 * presented, so it is the profile end of the range rather than a midpoint.
 *
 * ## Four figures, not six — the largest correction in this table
 *
 * Every number above was solved for a six-slot line and every one of them held;
 * what did not hold is the premise. Measured on the shipped capture the six
 * silhouettes sat at an `ndc` pitch of **0.212** against the plate's **0.37**,
 * i.e. the line was packed to 57% of the reference spacing, adjacent
 * silhouettes touched or overlapped at four of the five joins, and the two
 * right-hand figures stood underneath the HUD stack rather than beside it. None
 * of that is reachable by moving slots: constraint (1) above fixes the world
 * width at 3.4 m once the near figure's frame height is chosen, so a six-figure
 * line at plate spacing does not exist at the plate's own figure size. One of
 * the two had to give, and the frame height is the number the whole file is
 * solved against.
 *
 * The plate stages **four**, `roster.js` declares a four-strong
 * `DEFAULT_PARTY` (and this line is that party), and `BattleUI` renders one row
 * per member — so six was also what made our HUD stack 720 px tall against the
 * plate's 455 and pushed it up over the treeline. Staging the game's own default
 * party fixes the composition, the HUD height and the frame budget at once: two
 * skinned rigs are the most expensive pair of objects in the scene, and dropping
 * them is what pays for the lawn density and the rock mass below.
 *
 * At four slots the pitch is **0.337 of `ndc`** — the plate's 0.37 to within a
 * silhouette's width — and world separations run 0.87 / 1.05 / 1.24 m against a
 * chibi's ~0.50 m shoulder, i.e. two full character widths of air at the tight
 * end. Frame heights land 0.39 / 0.30 / 0.29 / 0.29 against the plate's 0.39 →
 * 0.30, and the line's recession is `atan(1.30 / 3.16)` = **22.4°**, which is
 * the same angle the six-slot solve reached and for the same reasons.
 *
 * Composition is by id rather than by roster order: Auren leads at the threat
 * end because he is the party's vanguard and the tallest thing in the line, and
 * Emrys takes the second slot because at 1.00 m he is the shortest and a near
 * slot is the only place his frame height stays inside the run's band.
 */
const PARTY = [
  { id: 'auren', ndc: -0.520, depth: 4.20, face: 58 },
  { id: 'emrys', ndc: -0.183, depth: 4.63, face: 54 },
  { id: 'seren', ndc:  0.153, depth: 5.06, face: 48 },
  { id: 'kite',  ndc:  0.490, depth: 5.50, face: 42 },
];

/**
 * The staged encounter — one creature from `world/Bestiary.js`, at the left edge.
 *
 * Authored in the same (screen x, view depth) space as {@link PARTY} and solved
 * through the same {@link stagePlacement}, because the only thing that matters
 * about an enemy's position is where it lands in frame relative to the line.
 *
 *  - **The quadruped, not the floater.** This is the correction the review found
 *    as "an abstract spiked-ball enemy", and it was a real constraint rather
 *    than a preference: the glassmane measured **1.79 × as long as it was tall**,
 *    which broadside at a threatening frame height is 0.87 of `ndc` — 43% of the
 *    image — and no arrangement of a party line and a HUD stack leaves that.
 *    The floater fitted, and what shipped was a ribbed dome with no head, no
 *    limbs and no front. `Bestiary`'s stance rebuild fixes the *cause*: the
 *    animal now stands at 1.48 long per unit of height, and at the yaw this
 *    staging presents it at, 0.55 of `ndc`. A frame whose antagonist has a face,
 *    ears, four legs and a tail is worth the width.
 *  - **`height` 2.05 m against a 1.00–1.19 m line** — 1.72 × the tallest figure
 *    staged, which is the review's "~1.5 × character height" taken against the
 *    tallest member rather than the shortest. Bigger than anything in the
 *    line in world metres by a wide margin while sitting 2.7 m further from the
 *    lens, so it holds 0.34 of frame height against Auren's 0.39: the frame
 *    reads it as *large and further away*, which is the depth relationship an
 *    enemy needs, rather than as merely close.
 *  - **`ndc` −0.92, `depth` 8.20.** The pair is solved together against two hard
 *    edges. With `turnToLens` applied it stands at a heading of 42°, at which
 *    its projected silhouette is 2.63 m across — 0.496 of `ndc`, spanning
 *    −1.168 → −0.672 — and Auren's own silhouette starts at −0.63, so the two
 *    clear by 40 px and never overlap. `ndc` came out from −0.88 with the
 *    four-slot line: that line puts its lead 0.02 further left, which had closed
 *    the old 22 px gap to nothing. The 34% of the creature past the left
 *    edge is the plate's own device (it puts its threat entirely off-frame)
 *    taken one step in. The depth is what makes that fit: at the previous
 *    staging's 5.60 the same animal covers 0.73 of `ndc` and buries the leader.
 *  - **It stands on the lawn, a metre in front of the bed's front edge.** Not an
 *    accident of the solve: at 2.05 m its belly line is 0.9 m and the bed's
 *    lavender runs to 1.5, so an animal placed *in* the flowers loses all four
 *    legs to them — and legs are half of what makes this creature legible as an
 *    animal rather than as the abstract mass it replaced. The bed rising behind
 *    it supplies the depth relationship instead.
 *
 * `hover` is the metres of vertical travel the idle bob covers, and `bobRate`
 * its radians per second. Everything in `buildCreature` is merged into three
 * meshes with no rig, so the root is the only thing there is to animate. For the
 * floater that was a drift; for a standing animal it is **breathing** — 14 mm at
 * 1.05 rad/s, an order under the bell's 55 mm, because a quadruped whose whole
 * body rises and falls by a hand's width is a quadruped that is hovering.
 */
const ENCOUNTER = {
  id: 'glassmane',
  /**
   * **`ndc` −0.80 and `depth` 8.40 — the animal is now wholly inside the frame.**
   *
   * The previous pair deliberately let 34% of the creature fall past the left
   * edge, on the reasoning that the plate keeps its own threat entirely
   * off-frame and cropping one in is that device taken a step further. That
   * reasoning survives its own restyle badly: the whole point of rebuilding this
   * animal in the cast's language — rounded muscle, fur ranks, one accent, no
   * crystal — is that the frame can *see* it, and a silhouette whose hindquarter
   * and tail are outside the image is a silhouette a review cannot grade.
   *
   * Solved against the same two edges as before, with the numbers re-read off
   * the rebuilt buffers rather than inherited: the animal measures **1.40 × as
   * long as it is tall** (down from 1.48 with the mane's shards gone), so at
   * 1.80 m it is 2.52 m long and 0.82 m wide, and at the 23° off-lens heading
   * the staging delivers it projects to 1.75 m. At 8.40 m of depth that is 0.323
   * of `ndc`, spanning **−0.961 → −0.639**: 0.039 of clear frame at the left
   * edge and 0.009 of daylight before Auren's silhouette starts at −0.63.
   *
   * `height` 1.80 rather than 2.05 is what buys that, and it costs nothing the
   * staging needs. Against the tallest figure in the line it is still 1.51 ×,
   * and because it stands 4.2 m deeper it holds 0.29 of frame height against
   * Auren's 0.39 — the frame reads it as *large and further away*, which is the
   * depth relationship an enemy needs, rather than as merely close.
   */
  ndc: -0.80,
  depth: 8.40,
  height: 1.80,
  hover: 0.014,
  bobRate: 1.05,
  /**
   * Degrees the animal is turned back **toward the lens** from the bearing it
   * would face if it were simply aimed at the party's centroid.
   *
   * **Zero, and it is the staging rather than the constant that changed.** The
   * column was written when the creature stood at `ndc` −0.92 and 8.20 m, where
   * aiming it at the line left it 27° off the lens and turning it 14° back
   * shortened its projected silhouette enough to fit. From the four-slot line's
   * centroid at (0.07, 2.89) the new station is on a bearing that already
   * delivers **23° off the lens** with no correction at all — a frontal
   * three-quarter that presents the face, both amber-lined ears, the near
   * foreleg and the mane's near rank, with the body receding behind.
   *
   * Adding a turn on top of that would take it *past* square: the clamp in
   * `_buildEncounter` caps the turn at the bearing gap precisely to stop that,
   * so a non-zero value here would simply square the animal up to the lens and
   * hide its own length behind its chest. Zero is the value that keeps it
   * addressing the party, which is the one thing the pose has to say.
   */
  turnToLens: 0,
  /** Fixed, so two captures of this stage dress the creature identically —
   *  `buildCreature` seeds its mottle and its tendril drift off this. */
  seed: 0x5c0a11ed,
};

/** Ground position of the staged creature, solved against the same frame. */
const ENCOUNTER_PLACE = stagePlacement(ENCOUNTER);

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
 * What the party is addressing — a point far off the **left** edge of frame,
 * on the bearing the staged creature stands on.
 *
 * The plate's party faces frame-right at a threat the composition never
 * reveals; this stage's threat is real and at the left edge, so the whole
 * address is mirrored. The anchor is deliberately *not* the creature itself,
 * and the requirements that decide that are specific:
 *
 *  - **Far.** At 25 m the four slots' headings to it converge inside 5°, so the
 *    line reads as watching one thing. Aimed at the creature 6 m away they fan
 *    by 25°, and the near-left figure ends up in dead profile while the
 *    far-right one is nearly frontal.
 *  - **On the creature's bearing, and re-solved every time either end moves.**
 *    From the four-slot centroid (0.07, 2.89) the encounter stands at −125.6°,
 *    because it is both further left and 3.4 m *deeper* than the line rather
 *    than level with it. The anchor is therefore placed by extending that exact
 *    bearing to 25 m rather than by keeping a coordinate: a stale anchor has the
 *    whole party watching a point tens of degrees off the only thing in frame to
 *    watch, which is the kind of defect that survives a review because nothing
 *    in the picture says what the party is *supposed* to be looking at. Dropping
 *    two slots moved the centroid 0.4 m and the bearing 1.7°, and this constant
 *    moved with it.
 *  - **Off frame**, at `ndc` ≈ −2.4, so the aim point itself never has to be
 *    modelled — the creature occupies the near end of the same bearing.
 *  - **At 1.10 m**, between the cast's own ~1.0 m eye line and the staged
 *    creature's eye at 1.14 m, so the look-at tilts no head measurably up or
 *    down and the party is not looking over the animal's head.
 *
 * That the anchor is now *deeper* than the line is fine where it would not have
 * been under the old `turn` column, and the distinction is worth keeping: `turn`
 * stated a rotation relative to the threat bearing, so a bearing past profile
 * cost it its whole range. {@link presentationRotation} solves for an absolute
 * presentation angle and subtracts whatever the gaze contributes, so it delivers
 * the authored `face` from any anchor position at all.
 */
const GAZE_ANCHOR = new THREE.Vector3(-20.26, 1.10, -11.67);

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
 * How much of the body-to-target yaw gap the **head** actually ends up carrying.
 *
 * `GAZE_WEIGHT` is what `Animator.lookAt` is *told*; this is what the head bone
 * is measured to do with it, and the two are not the same number because the
 * aim is split across chest, neck and head and each joint is separately damped
 * and clamped. Read off the built rig on the shipped stage — head world forward
 * against root rotation, six figures — the head carried 0.02, 0.24, 0.24, 0.34,
 * 0.39 and 0.41 of the gap, mean 0.27. (The spread is the idle clip's own head
 * motion riding on top; it is a few degrees at chibi scale and there is no
 * useful way to cancel it from out here.)
 *
 * The staging needs the *forward* solve — given a wanted head bearing, what root
 * rotation delivers it — so it needs this constant and not `GAZE_WEIGHT`. Using
 * 0.6 here would over-rotate every figure by 15–25° toward the lens, which on
 * the left of the line is the difference between a three-quarter and a frontal
 * mugshot.
 */
const LOOK_YAW_SHARE = 0.27;

/**
 * Root rotation that presents a slot's head `face` degrees off the lens axis.
 *
 * Three bearings meet here, all measured in the rig's convention (+Z forward,
 * so a bearing is `atan2(dx, dz)`):
 *
 *  - `camBearing` — from the figure to the camera. This is what "off the lens"
 *    is measured against, and it is emphatically *not* zero: a figure at the
 *    left of frame sees the camera off to its right, and at the stage lens that
 *    offset runs to 23°. Ignoring it is what let the previous `turn` column
 *    look correct on paper and ship a figure at 106°.
 *  - `gazeBearing` — from the figure to {@link GAZE_ANCHOR}, i.e. where the
 *    look-at will drag the head.
 *  - the solve — the head lands at `body + share · (gaze − body)`, so requiring
 *    it to land at `camBearing − face` inverts to the expression below.
 *
 * @param {{x:number,z:number}} place ground position of the figure
 * @param {number} faceDeg wanted head angle off the lens, degrees; positive
 *   turns the head toward frame-left, which is where this stage's threat is.
 */
function presentationRotation(place, faceDeg) {
  const camBearing = Math.atan2(STAGE.camX - place.x, STAGE.camZ - place.z);
  const gazeBearing = headingTo(place, GAZE_ANCHOR);
  const wantHead = camBearing - (faceDeg * Math.PI) / 180;
  return (wantHead - LOOK_YAW_SHARE * gazeBearing) / (1 - LOOK_YAW_SHARE);
}

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
   * `dofShader.js` carries a far-field *floor* keyed on `log2(z / focus)`, so
   * past a couple of multiples of the focal plane it applies a fixed defocus
   * that closing the aperture cannot reach — by design, since physical far CoC
   * saturates and the composer needs some way to soften a horizon.
   *
   * **`bokeh: 0` is no longer the off switch for that floor, and `defocus` is.**
   * `PostFX` split the two deliberately (see its `DOF_FAR_FLOOR_FRACTION`) so a
   * scene could ask for a sharp stage without also giving up the physical CoC,
   * and the floor now defaults to its full authored strength for any pose that
   * does not say otherwise. Every meadow pose in this table was written against
   * the old conflated behaviour, so until this line existed they were all
   * shipping 10.3 px of guaranteed background blur that their `bokeh: 0` was
   * documented — wrongly — as suppressing.
   *
   * 0.45 is measured rather than chosen. Laplacian variance over the plate's bed
   * directly behind its archer (x 1250–1900, y 200–420) is **345**; ours over
   * the equivalent band came back **133**, i.e. the plate's bed carries 2.6 × our
   * detail, while over the boulder wall the two agree to within 15% (180 against
   * 153). So the far band is right and the *bed* is being softened by a floor
   * meant for a horizon. At 0.45 the floor is 4.6 px: the bed sits 0.42 of the
   * way up the ramp and gets 1.9 px, which is under the composite's 0.75–3 px
   * blend threshold and therefore effectively sharp, while the treeline and the
   * massif saturate the ramp and keep most of the authored softness.
   */
  battle: {
    pos: [STAGE.camX, STAGE.camY, STAGE.camZ], look: STAGE_LOOK,
    fov: STAGE.fov, focus: 5.0, aperture: 22, bokeh: 0, defocus: 0.45, grade: 'battle',
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
   * sheet's command framing duly shipped the line with its leader missing:
   * "crop at the edges" is a claim about a shoulder, not about losing a cast
   * member. 0.70 m puts him at −0.94 — cropped down one arm and
   * still read as a figure — and holds the rear slot inside the right edge,
   * where the HUD stack overlays rather than replaces it.
   */
  lineup: {
    pos: [STAGE.camX, STAGE.camY, STAGE.camZ - 0.70], look: [STAGE.camX, STAGE_AIM_Y, STAGE.camZ - 0.70 - STAGE.aimDist],
    fov: STAGE.fov, focus: 4.3, aperture: 22, bokeh: 0, defocus: 0.45, grade: 'battle',
  },
  /** Battle station, battle lens, rendered as a **matte**. The silhouette check
   *  has to be run on the shipped composition or it is checking nothing — and
   *  it has to be run on actual mattes or it is checking nothing either. See
   *  `_enterMatte`. */
  silhouette: {
    pos: [STAGE.camX, STAGE.camY, STAGE.camZ], look: STAGE_LOOK,
    // `defocus: 0` and not merely a low value: this pose grades a silhouette on
    // its contour, and any blur at all on the rear slots' edges means the check
    // is reading the composer rather than the shapes. See {@link MATTE}.
    fov: STAGE.fov, focus: 5.0, aperture: 22, bokeh: 0, defocus: 0, grade: 'neutral', silhouette: true,
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
     * **0.62 m, and the head is 0.31 m — not the 0.44 m this note used to
     * assert.** Measured on the shipped capture rather than estimated: Auren's
     * crown-to-chin ran y 90 → 560 of 1080, i.e. 43.5% of a frame covering
     * 0.72 m, which is 0.313 m of head. That is what a 4.3-head chibi 1.16 m
     * tall actually has, hair shell included, and it meant the pose was
     * delivering a 43% head where the note claimed 61% — still a torso shot with
     * a face in it, which is the exact defect the note was written to fix.
     *
     * 0.62 m puts the head at **50%** of frame height with the crown at y 139
     * and the chin at y 679, so there is a quarter of the frame above the hair
     * and a shoulder's worth of costume below the jaw. It does not go tighter
     * because `aim.up` lifts the eyes off centre: at 0.55 m the crown lands at
     * y 30 and a breath of the idle clip crops it.
     */
    frame: 0.62,
    // Camera 5 cm under the eye line: ART_BIBLE §5.4's "hero shots slightly
    // low", and on a chibi it also stops the 12°-down battle habit from
    // reading as a look down at a child.
    rise: -0.05,
    // Aim below and to one side of the eyes, which pushes the subject up and to
    // frame left: eyes land just over the upper third and the head is off the
    // centreline (§5.2). Signs matter — the aim point *is* frame centre, so a
    // negative `up` puts the eyes above it.
    // Scaled with `frame` above, so the thirds placement is the same fraction
    // of the image it was at 0.72 m rather than drifting up as the shot tightens.
    aim: { right: 0.10, up: -0.07 },
    // f/11, not f/8. Focus rides the head bone (see `poseCamera`), so the plane
    // is on the eyes by construction; what the stop has to buy is enough depth
    // that the whole 0.44 m skull — brow to ear to jaw — is inside it. At this
    // range everything past two metres is still gone entirely, so the
    // background stays as soft as REFERENCE §3 requires.
    // 4.0 is `PostFX`'s own `DEFAULT_BOKEH_SCALE`, restated rather than omitted:
    // `setDof` defaults the argument to whatever the *last* pose left behind,
    // and every meadow pose leaves 0 there. Omitting it would ship a portrait
    // with a pin-sharp 40 m background, which is the one frame in the sheet
    // that genuinely wants its background gone. `defocus` is deliberately not
    // set for the same reason in the other direction: this is the one pose that
    // wants the full authored far-field floor, and 1 is what it gets by default.
    fov: 34, aperture: 11.0, bokeh: 4.0, grade: 'battle',
  },
  /**
   * The three-quarter reverse — the meadow itself, with the line as its subject
   * rather than its centre.
   *
   * Station point is east of the stage looking north-west, so the camera is
   * ~40° off the battle axis and the two frames share no geometry: here the
   * cast is seen along the line rather than across it, the mid-ground boulders
   * and the broadleaf close the left edge and the boulder wall the top. (The
   * cherry used to do that job; it moved out to the plate's own corner station,
   * which puts it behind this camera's left shoulder.) It exists to prove the
   * meadow is a *place* — that the bed has depth behind the line and the bank
   * has form — rather than a backdrop painted at one bearing.
   */
  wide: {
    pos: [7.40, 1.95, 8.90], look: [-1.20, 0.85, 0.60],
    fov: 44, focus: 8.5, aperture: 16.0, bokeh: 0, defocus: 0.45, grade: 'battle',
  },
  /** Sky-dominant landscape for the day-cycle sweep, shot over the bank so the
   *  meadow's crest and the sky above it both carry the hour. */
  horizon: {
    pos: [-2.20, 1.70, 9.60], look: [4.40, 5.60, -24.0],
    fov: 50, focus: 14, aperture: 16, bokeh: 0, defocus: 0.45, grade: 'battle',
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
 * What is left is the only question the pass asks: are these four shapes
 * distinguishable.
 *
 * Two stages of the chain the diagnostic path does *not* drop have to be
 * neutralised from here, because PostFX has no way to know it is looking at a
 * matte. DOF stays enabled, so the pose carries `bokeh: 0` *and* `defocus: 0` —
 * the far-field floor in `dofShader.js` is keyed on depth ratio and is no longer
 * scaled by the aperture or by `bokeh`, so zeroing the lens alone would leave
 * the rear slots' contours blurred and the check would grade a silhouette on a
 * blur. And the HUD is DOM, so `_enterMatte` hides it.
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
 * and the shipped frame had none: every pair of boots met the terrain with no
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
    /** @type {ReturnType<typeof buildCreature>|null} the staged encounter. */
    this._encounter = null;
    this._encounterBaseY = 0;
    this._encounterHeading = 0;
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
    this._buildEncounter(forge);

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

    // Cloned so the conditioning stays local; the clone shares the forge's
    // textures and the forge guards those against `disposeTree`.
    //
    // `color` is **white** and stays white. The floor's albedo is now the pair
    // of measured colours in the fragment injection below, and the forge's
    // grass fBm is demoted to a *multiplier* around 1 — the same discipline
    // `Flora.js` documents at length for its own materials, and for the same
    // reason: two greens multiplied give a black lawn, which is most of how the
    // previous stage floor ended up at L≈18 with no value left to shadow.
    // Repeat 900, not 400. 900 m / 900 is one tile per metre, and the tile is
    // what supplies the streaking *between* the grass instances — the plate's
    // near lawn resolves directional strokes about 6 cm long, and the finest
    // feature an fBm can put inside a 2.25 m tile is nearer 30 cm. One tile per
    // metre lands those strokes at 7–8 cm at the party's own depth. It costs
    // nothing: `repeat` is a uniform on maps the forge already built, and the
    // period is still far shorter than the frame is wide, so no tile boundary
    // can land in shot twice.
    this.groundMaterial = forge.material('grass', { repeat: 900 }).clone();
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
   * (The table is a summary of the calls below and every entry in it is read
   * back off them, because a layout note that has drifted from the layout is
   * worse than none — this one had the cherry, the conifer, the wall and the
   * belt all at stations they had been moved off.)
   *
   * | element | world | why there |
   * |---|---|---|
   * | mown lawn | (0, 3) r 15, 22 k | the cast stands on it; 4.5–8.5 cm blades at 31/m², short enough that the line's boots resolve |
   * | near turf | (0, 4.2) r 3.2, 5.2 k | 160/m² and *shorter* than the field behind it, over the 6 m the lens resolves |
   * | ground cover | (0, 2) r 13 and (0, 4) r 3.6 | low leaves pooling between the blades as patch-scale value break, under the eye's resolution as individual leaves |
   * | dirt path | extreme bottom-left, see `_pathness` | a 3.2 m worn track in the one corner no figure stands on, thinned rather than cleared |
   * | near flower drift | lavender (2.35, 4.55) r 0.85 | the plate's one piece of foreground flora: a violet band in the right eighth, under the HUD |
   * | bed, front band | (0, −1.5) r 6–8.5 | starts 1.7 m behind the deepest figure, so nothing grows through the line |
   * | tulip drifts | (−3.1, −1.9), (2.6, −2.3), (−0.4, −3.4) r 1.5 | three single-colour stands at the bed's near edge, placed rather than left to the scatter |
   * | bed, main mass | (0, −5.5) r 9–11 | at that depth the frame is 7 m of half-width, so one field fills it edge to edge |
   * | mid-ground rock ×4 | (−2.9, −4.9), (2.7, −5.6), (−8.5, −12.5), (6.6, −9.0) | 1.9–2.3 m blocks cresting the bed in the gaps between figures, mossed on top |
   * | near stones ×2 | (4.2, 5.0), (−5.0, 4.2) | scale cues at the frame's lower corners; the only rock in frame with no moss on it |
   * | cherry | (−5.9, −6.4) h 5.4 | a background mass whose canopy runs off the top-left corner, as the plate's does |
   * | broadleaf ×2 | (3.6, −8.5) and (6.9, −7.4) | the plate's two mid-right trees, above and behind the bed's right half |
   * | boulder massif | (−1.8, −17.4) size 7.4 | the dominant upper-third mass: 268 px tall, 1.1 of `ndc` wide |
   * | far belt | (0, −30) r 16, 10 + 10 | the treeline, *behind* the bank rather than standing in for it |
   *
   * ## The depth bands, and why the layering is the point
   *
   * Read down that table and it is five bands, not a scatter: near turf and
   * stones at 3–6 m, a lavender drift crossing the bottom-right corner at 5 m,
   * the bed's front band with its three placed tulip stands at 2–5 m behind the
   * line, the lavender mass and the mid-ground boulders at 5–9 m, then the trees
   * and the massif. Every one of them overlaps its neighbour in plan, so the
   * frame reads depth by *occlusion* at five stations rather than by haze —
   * which is exactly how the plate does it, and it is why the fog multiplier
   * here is very nearly off.
   *
   * The near bands are deliberately the *quietest* of the five, and that is the
   * plate's arrangement rather than a budget compromise. Its foreground carries
   * no flower, no discrete blade and no prop larger than a fist; what it carries
   * is a value gradient — masked over `bravely01.jpg`, the ground runs V 0.30 at
   * the party's feet to **V 0.52** at the bottom edge and warms 116° → 74° of
   * hue as it does, i.e. it opens into direct sun and a worn track. Depth in the
   * bottom third of that frame is made of light, not of objects.
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
    // the whole image and burying the cast. The battle lens first meets
    // the ground 2.2 m out (`atan` of the frustum's lower edge against
    // `STAGE.camY`), so anything nearer than `LAWN_NEAR_LIMIT` cannot be seen
    // as ground at all and can only ever be seen as a wall of grass.
    //
    // Blades are also shortened from the preset's 0.09–0.17 m. That range is
    // right for the plate at the plate's distance, but the plate's own lawn
    // resolves as *streaks* with no discrete blade anywhere, and at 2.2 m a
    // 0.17 m blade is 15% of frame height.
    //
    // **26 000 blades, not 13 000, and this is the correction the near ground
    // needed most.** `buildGrassField`'s own lawn preset is 34 000 over a 14 m
    // radius — 55 blades per m² — and this call had been carrying 13 000 over 15
    // m, which is **18**. A third of the intended coverage is not a thinner lawn,
    // it is a different material: every blade stands alone with bare ground
    // around it, so the eye resolves each one as an object and the floor reads as
    // sparse plastic spikes pushed into mud. Everything the builder does to make
    // a blade read as a *streak* — the 1.25 reach, the 0.85 droop, the flat taper,
    // all documented at length in `Flora.js` — depends on blades overlapping
    // their neighbours, and at 18/m² they cannot reach each other.
    //
    // 26 000 over 15 m is 37/m², two thirds of the preset's density on a field
    // that is 15% larger, and the near cut-off below still discards everything
    // inside 2.2 m. The extra 13 000 instances are one draw call and no new
    // material; what they cost is vertex work, and it is paid for several times
    // over by the two rigs the four-slot line gave back, by eight fewer belt
    // trees and by six fewer boulders.
    //
    // ## The blades are shorter, and the density is not what was wrong
    //
    // Everything above is about *coverage* and it is correct. What no pass has
    // checked is the height against the figures standing in it: at 0.115 m times
    // the builder's 1.4 × variance the tallest blade is 0.16 m, which on a 1.00 m
    // caster is a sixth of her whole body and buries every boot in the line. On
    // the plate the party's feet are fully drawn and their soles meet the ground
    // — the lawn there reaches maybe an ankle's third — and it is *because* the
    // feet resolve that the line reads as standing on the meadow rather than
    // wading in it.
    //
    // 0.045–0.085 m tops out at 0.12 m, which is under Emrys's boot cuff. The
    // coverage that costs is bought back in the only place it is free: the floor
    // underneath. Measured, the stage floor's own albedo renders at hue 87° /
    // V 0.46 against the plate's near ground at hue 86° / V 0.47 — it is
    // *already* the plate's lawn — while the region as shipped read hue 131° /
    // V 0.35, because 35 000 blades of a cooler, darker green were standing
    // between the lens and it. Letting a little more floor through is the same
    // edit as putting the boots back and as warming the foreground.
    plant(buildGrassField, 0, 3.0, {
      preset: 'lawn', radius: 15, count: 22000, falloff: 0.62, distanceGrowth: 0.9,
      height: [0.045, 0.085],
      mask: (x, z) => (z + 3.0 > LAWN_NEAR_LIMIT ? 0 : this._floraMask(x, z + 3.0)),
    });
    /**
     * The near turf — a second, much denser lawn over the 6 m the lens actually
     * resolves, and the direct answer to "no bare ground in the foreground".
     *
     * A single field cannot deliver this. Density is uniform per unit *area*, so
     * a count that covers the bottom of frame at 2.2 m — where one square metre
     * of ground is 90 000 px — is a count that also plants a hundred thousand
     * blades out at 15 m, where the same square metre is 400 px and the ground
     * is already covered by the far field's larger blades. The field above holds
     * the whole floor at 37 blades/m²; this one adds 250/m² over the disc in
     * front of the line and nothing anywhere else, which is 9 000 instances for
     * the region that carries the criterion rather than 90 000 for the frame.
     *
     * Blades are also taller here (0.09–0.16 m against 0.065–0.115) and drawn on
     * the same wide arc band, so at 2.2 m each one lies across two or three of
     * its neighbours. Coverage is an overlap problem, not a count problem, and
     * height buys overlap at no instance cost.
     *
     * ## Halved, and shorter than the field behind it — the plate has no
     * foreground blade in it at all
     *
     * The paragraphs above solve "no bare ground in the foreground" and they
     * solve it, but against the wrong target. Zoom `bravely01.jpg`'s bottom third
     * and there is no discrete blade anywhere in it: the surface carries fine
     * directional streaking and a worn track and nothing else, and its Laplacian
     * variance is 558 against our 163 — the plate's foreground has *more* detail
     * than ours while having no grass geometry in it, because its detail is
     * tonal (sun, wear, the track) rather than a mat of 250 objects per square
     * metre averaging to one flat green.
     *
     * So this layer stops trying to be a hedge and goes back to being turf:
     * 160/m² at 0.055–0.10 m, i.e. shorter than the far field rather than taller,
     * which is what a mown lawn actually does in perspective (the near blades
     * subtend more, so they need *less* height to cover the same screen area).
     * It is also the largest fill-rate saving available on this stage — these are
     * the blades that cover the bottom of a 1080p frame at two metres — and the
     * capture budget is what pays for the bed behind them.
     */
    plant(buildGrassField, 0, 4.2, {
      preset: 'lawn', radius: 3.2, count: 5200, falloff: 0.25, distanceGrowth: 0.35,
      // Capped so the tallest draw — the range's top times the builder's 1.4 ×
      // height variance — is 0.14 m, which at the 2.2 m the frustum's lower edge
      // meets the ground is 9% of frame height: a texture on the floor rather
      // than a band standing in front of it.
      height: [0.055, 0.10],
      mask: (x, z) => (z + 4.2 > LAWN_NEAR_LIMIT ? 0 : this._floraMask(x, z + 4.2)),
    });

    // --- ground cover, in front of and around the line ----------------------
    // The fifth species and the only one that lives on the party's own side of
    // the bed. On the plate the floor the cast stands on is not one green: broad
    // low leaves pool between the grass in patches a metre across, and that
    // mottling is most of what stops 200 000 px of lawn reading as felt — which
    // is exactly what ours did. Same near cut-off as the lawn, for the same
    // reason.
    plant(buildGroundCover, 0, 2.0, {
      radius: 13, count: 1500, size: [0.12, 0.26], falloff: 0.5,
      mask: (x, z) => (z + 2.0 > LAWN_NEAR_LIMIT ? 0 : this._floraMask(x, z + 2.0)),
    });
    // The same species again, over the near disc only, and *smaller* here rather
    // than larger.
    //
    // A rosette is the cheapest coverage in the module — five broad leaves laid
    // almost flat, so one hides roughly its own footprint of ground where a blade
    // hides a stroke — and at 0.24–0.46 m that footprint is the size of a
    // character's head. Two metres from the lens the shipped drift resolved as
    // discrete palm-shaped leaves scattered over the bottom of frame, which is a
    // *species* the plate's foreground does not contain; the mottling this layer
    // exists to supply is a patch-scale value break, and it only reads as one
    // while the individual leaf stays under the eye's resolution. 0.13–0.24 m at
    // 170/m² is that break; the count halves with the size because the two
    // multiply into the same covered area.
    plant(buildGroundCover, 0, 4.0, {
      radius: 3.6, count: 700, size: [0.13, 0.24], falloff: 0.3,
      mask: (x, z) => (z + 4.0 > LAWN_NEAR_LIMIT ? 0 : this._floraMask(x, z + 4.0)),
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
    /**
     * The bed is now **interleaved drifts of three lavender variants**, not one
     * field of one plant.
     *
     * The review's finding was that our bed is "a monoculture … one lavender
     * spike instanced into a wall", and it was right for a reason no density or
     * palette change reaches: two `buildLavender` calls at one height range and
     * one hue produce one plant repeated 7 200 times, and a hundred metres of
     * one plant is a wall whatever colour it is. The plate's own bed separates
     * into drifts — a cold indigo run behind, a warm red-violet one catching the
     * sun in front, a shorter denser mat at the margin — across a 26° hue spread
     * and a 40% height spread, and the *boundaries between drifts* are as much
     * of the read as the flowers.
     *
     * So each band is planted three times at three heights and three `hueShift`
     * values, each with its own scatter (and therefore its own clump seeds), on
     * radii that deliberately overlap so the drifts interpenetrate rather than
     * banding. Total spike count comes **down** from 7 200 to 5 400: the variety
     * is free, and the 1 800 spikes it gives back pay for the two new species
     * and the extra tulips below.
     *
     * The near band is where a raceme is actually resolvable — 3 cm at 9 m is
     * 5 px, against 2 px at the mass's depth — so it keeps the highest density
     * and the least grass to hide it.
     */
    const lavenderDrifts = [
      { r: 6.5, n: 900, h: [1.15, 1.45], hue: +0.85 },
      { r: 6.0, n: 700, h: [0.95, 1.25], hue: -0.70 },
      { r: 7.2, n: 600, h: [1.05, 1.35], hue: +0.10 },
    ];
    for (const d of lavenderDrifts) {
      plant(buildLavender, 0, -1.5, {
        radius: d.r, count: d.n, height: d.h, hueShift: d.hue,
        falloff: 0.35, foliage: 0.55, mask: behindLine(-1.5),
      });
    }
    // Tulips and wildflowers take the same cut-off as everything else in the
    // bed. Without it their scatter reaches the lens: a 0.085 m tulip head a
    // metre from the glass is a 200 px white blob over the cast's boots, which
    // is what the previous capture shipped across its whole bottom edge.
    //
    // **Height 0.66–0.92 m, not 0.42–0.62.** This module's own header records
    // the plate measurement — "heads sit just under the lavender tips" — and
    // then shipped a range that puts every tulip head 40 cm *below* the bottom
    // of the racemes, where nothing in the frame can see it. That single number
    // is why our bed has no red in it: the flowers were built, coloured and
    // scattered correctly and then planted underneath the plant they were meant
    // to punctuate. The count comes up with the height, because a red accent
    // that appears once per 30 lavender is not an accent, it is a blemish.
    //
    // **Height 0.52–1.10 m, not 0.66–0.92.** A uniform draw over a 26 cm range
    // has a standard deviation of 7.5 cm, so 400 flowers all arrive within a
    // hand's width of each other and the bed's tulips ship as a *stripe*: a
    // horizontal red line across the frame at one screen row, which is what the
    // capture shows and is the same defect the lavender's height tiers were
    // added to fix. The plate's tulips run from below the lavender's basal
    // foliage to level with its racemes, so the range is opened to cover that
    // and the band becomes a drift with depth in it.
    plant(buildTulips, 0, -1.2, {
      radius: 7.5, count: 420, height: [0.52, 1.10], clumping: 0.72,
      mask: behindLine(-1.2),
    });
    /**
     * Named tulip drifts, on top of the scattered ones.
     *
     * `clumping` gives the bed's tulips drifts of a *statistical* size — a dozen
     * flowers around each of forty seeds — and that is right for the mass and
     * wrong for the read. On the plate the tulips that carry the frame are three
     * or four dense stands of thirty-odd heads at the bed's near edge, each one
     * of a single colour, and it is the *saturation of a patch* that makes them
     * legible at 18 px rather than the presence of red somewhere in the field.
     * A random seed cannot be relied on to put one of those where the
     * composition needs it, so the three that matter are placed.
     *
     * Stations are chosen against the frame: two flank the party line at the
     * bed's front edge where a head is largest, and the third sits behind and
     * between the two centre figures so the band has a third depth in it.
     */
    for (const drift of [
      { x: -3.10, z: -1.9, n: 130, colors: [FLORA_PALETTE.TULIP_RED], weights: [1] },
      { x: 2.60, z: -2.3, n: 120, colors: [FLORA_PALETTE.TULIP_WHITE], weights: [1] },
      { x: -0.40, z: -3.4, n: 110, colors: [FLORA_PALETTE.TULIP_ORANGE], weights: [1] },
    ]) {
      plant(buildTulips, drift.x, drift.z, {
        radius: 1.5, count: drift.n, height: [0.58, 1.12],
        colors: drift.colors, weights: drift.weights,
        falloff: 0.2, clumping: 0.4,
      });
    }
    plant(buildFlowerPatch, 0, -0.6, { radius: 8.0, count: 360, mask: behindLine(-0.6) });
    // Seed grass through the near band — the bed's top edge. See
    // `Flora.buildSeedGrass`: this is the species that stands *above* the
    // lavender, so it is what stops the bed cresting on one flat line.
    plant(buildSeedGrass, 0, -2.2, {
      radius: 7.0, count: 420, height: [1.30, 1.80], mask: behindLine(-2.2),
    });

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
    // rule. So the mass sits 2.5 m forward of where it started, at a 10 m
    // radius, and the meadow grass sharing that ground is shorter than it.
    //
    // Counts come down 3 200 → 2 800 across the three drifts, and the mass is
    // *denser* for it. `Flora.buildLavender` now empties a tenth of every drift
    // in coherent voids and draws its heights from three discrete tiers, so the
    // same violet is delivered by fewer, more varied plants standing in a bed
    // you can see through — which is the plate's arrangement and was the whole
    // of the "uniform wall" finding. The 400 spikes given back pay for the near
    // turf above.
    for (const d of [
      { r: 10.0, n: 1200, h: [0.95, 1.45], hue: -0.55 },
      { r: 9.0, n: 900, h: [1.10, 1.60], hue: +0.75 },
      { r: 11.0, n: 700, h: [0.85, 1.25], hue: +0.15 },
    ]) {
      plant(buildLavender, 0, -5.5, {
        radius: d.r, count: d.n, height: d.h, hueShift: d.hue,
        falloff: 0.4, foliage: 0.55, mask: behindLine(-5.5),
      });
    }
    plant(buildTulips, 0, -5.0, {
      radius: 9, count: 800, height: [0.62, 1.24], clumping: 0.72,
      mask: behindLine(-5.0),
    });
    plant(buildSeedGrass, 0, -6.0, {
      radius: 10.5, count: 640, height: [1.35, 1.90], mask: behindLine(-6.0),
    });
    /**
     * The bed's right-hand wing, and the last hole the sharp background exposed.
     *
     * The mass above is a disc about the view axis, so its reach in `ndc` *falls*
     * with depth: at z = −5.5 an 11 m radius covers the frame edge to edge, and
     * at z = −13 the frame is 13.6 m of half-width and the same disc has stopped
     * three metres short of it. What shows through the gap is the bank's own
     * grassy crest and the sky over it — measured at (1560–1900, 150–280) it
     * reads (69, 83, 101), hue 214° / V 0.40, against the plate's (31, 56, 52) at
     * hue 170° / V 0.22. That is the only band of the upper third still reading
     * as daylight rather than as mass; the frame's top 200 px as a whole now
     * matches the plate to within two code points on every channel.
     *
     * A wing rather than a wider mass because the correction is directional: the
     * left half of that depth is already closed by the cherry and the massif, and
     * growing the central disc to reach 13 m would plant nine hundred spikes
     * behind them to place four hundred here. It takes the deep tier's colder
     * hue, since at 20 m it is read as the same drift receding rather than as a
     * separate bed.
     */
    plant(buildLavender, 10.5, -11.5, {
      radius: 5.5, count: 460, height: [1.05, 1.55], hueShift: -0.35,
      falloff: 0.45, foliage: 0.5, mask: behindLine(-11.5),
    });

    // --- foreground framing --------------------------------------------------
    // The plate's bed does not stop at the party line: at frame right it comes
    // forward past the archer and her boots are *in* it, and the bottom-right
    // sixth of the image is flowers crossing in front of the cast. That is the
    // depth cue our frame had nowhere else — every other layer is strictly
    // behind the line, so the party read as pasted onto the meadow rather than
    // standing in it.
    //
    // **Sized against the frame, not against the plant.** At z ≈ 4.5 the lens is
    // 3.1 m from the ground it stands on and the frame is 2.0 m of half-width,
    // so a 0.5 m flower there covers 22% of frame *height* — the first capture
    // of this drift put lavender and tulips over half the party from the waist
    // down and into the HUD column. 0.26–0.40 m covers 12–18%,
    // which is a band along the bottom edge rather than a hedge, and the whole
    // drift is pushed right to x 2.1 so its visible half sits in the corner the
    // HUD stack already owns instead of over a face.
    //
    // (The other half of that failure was a real bug in `buildLavender`, whose
    // basal leaves were an absolute height regardless of the plant's — see the
    // note on `leafScale` there. Both had to go: shrinking the drift alone would
    // have left metre-tall leaves around 30 cm flowers.)
    //
    // ## The frame-left drift is gone, and it was the worst object in the frame
    //
    // Three near drifts shipped here: a violet band under the HUD at frame right,
    // and a tulip stand with its own lavender skirt at frame left, put there on
    // the argument that "the tulips' job is to be the frame's one readable
    // flower". Measured on the shipped capture, that stand covered x 0 → 700 of
    // 1920 and y 590 → 1080 — **a sixth of the whole image**, with single tulip
    // heads 150 px across, larger than any character's head in the line and the
    // first thing the eye lands on.
    //
    // The plate has nothing of the kind. Its bottom-left quadrant is open worn
    // ground and its *only* foreground flora is a strip of lavender hard against
    // the right edge, x 1770 → 1920, i.e. the last 8% of the width and entirely
    // behind the HUD column. The reasoning that put the tulips at frame left is
    // sound about depth and wrong about the reference: the plate buys its
    // foreground depth from the track and the value falloff across the lawn, not
    // from a flower in front of the lens, and a bed crossing in front of the
    // party is a thing it does at frame *right* and behind the archer's knee.
    //
    // So both left-hand drifts go, and the remaining band is trimmed to the
    // plate's own extent. At (2.35, 4.55) with a 0.85 m radius it spans `ndc`
    // 0.76 → 1.0 — the right eighth, under the stack — against the 0.43 → 1.0 it
    // covered before, which had it standing between the lens and Kite.
    plant(buildLavender, 2.35, 4.55, {
      radius: 0.85, count: 110, height: [0.26, 0.40], hueShift: +0.6, falloff: 0.2, foliage: 0.7,
    });

    // --- trees --------------------------------------------------------------
    // **520 puffs and 520 loose rosettes, not 1 200 rosettes.** See
    // `Flora.buildBlossomTree`: the canopy is now built of soft blossom clumps
    // with a value gradient through each and the pink arriving per clump, and
    // the petal rosettes are demoted to a fringe on their outer shells. The old
    // count was chosen to make an *opaque* mass out of objects 4 px across,
    // which is a way of paying 146 k triangles for a pink fog; the puffs deliver
    // the mass and the clumped silhouette the plate has for half of that.
    //
    // Moved out to (−5.9, −6.4) and grown to 4.4 m, which is the plate's own
    // placement rather than a compromise around the encounter. Measured there,
    // the blossom is a **corner** mass: x 0 → 640 of 1920 and y 90 → 560, i.e.
    // it runs off the top-left edge and its lower limit stops well above the
    // party's heads. At this station the canopy spans `ndc` −1.03 → −0.29 with
    // its crown past the top edge, and the creature — dark hide, 6 m nearer —
    // stands against it in the strongest value contrast in the frame.
    plant(buildBlossomTree, CHERRY.x, CHERRY.z, {
      height: CHERRY.height, spread: CHERRY.spread, clusters: 520, petalFringe: 520,
    });
    // The broadleaf, camera-right and behind the bed. The plate has **two** tree
    // species and we shipped one twenty-two times; this is the other, and its
    // rounded lobed crown against the cedars' notched tiers is the cheapest
    // depth cue available in the upper third of frame. `fringe` is on because
    // this one is close enough for a leaf to be several pixels.
    plant(buildBroadleafTree, 3.6, -8.5, {
      count: 1, height: 5.4, spread: 1.16, lobes: 16, fringe: 220,
    });
    // Frame right used to carry a lone conifer here, and it was the least
    // plate-like object in the capture: a hard-edged 4.6 m cone of notched tiers
    // filling x 1700→1920 from the top edge down to y 500, next to a HUD stack
    // that is itself all straight lines. `bravely01.jpg` has no conifer anywhere
    // near its right edge — it has a second broadleaf, trunk visible, rounded
    // crown running off the top corner — so this is that tree instead. Cedars
    // are not banished, they are simply where the plate keeps them: in the belt
    // below, at a distance where a notched silhouette reads as variety rather
    // than as a Christmas tree.
    plant(buildBroadleafTree, 6.9, -7.4, {
      count: 1, height: 5.0, spread: 1.10, lobes: 15, fringe: 160,
    });
    /**
     * The tree that closes the top right, and the hole it closes only became
     * visible once the background stopped being defocused.
     *
     * Measured on the sharp capture, the band at (1560–1900, 150–280) reads
     * (50, 64, 95) — hue 221°, V 0.37, i.e. *sky* — where the plate's same band
     * reads (31, 56, 52) at hue 170° and V 0.22, i.e. dense shaded foliage. The
     * cause is geometric rather than a missing layer: the belt below scatters
     * over a 16–17 m radius about z = −30, and at that depth the battle frustum
     * is 24.3 m of half-width, so past `ndc` 0.7 there is no belt at all and the
     * bank's own grassy crest and the sky above it show through. Every earlier
     * round of belt tuning was measuring the top 200 px as one number, which
     * averages that corner away.
     *
     * A tree rather than more lavender because of where the hole is: at 20 m out
     * the band sits 2.6–4.0 m above the ground, and the bed's tallest raceme is
     * 1.6. Only a crown reaches it. One at (11.0, −13.5) spans `ndc` 0.62 → 1.05
     * with its canopy from y 120 to y 330, which covers the measured gap and
     * runs off the right edge as the plate's own right-hand foliage does.
     */
    plant(buildBroadleafTree, 11.0, -13.5, {
      count: 1, height: 5.6, spread: 1.22, lobes: 14, fringe: 120,
    });
    // The belt. A 34 m scatter about z = −27 reached forward to z = +7, i.e.
    // to within a metre of the lens, and the first capture duly shipped conifers
    // standing in the flower bed at four times the party's height. It then went
    // to z = −44 at 5.4 m, which fixed that and created the opposite defect:
    // measured on the capture, the top 200 px of frame is **71% sky** against
    // the plate's **7%**, and reads p50 178 / saturation 0.15 against the
    // plate's 57 / 0.53. The plate has no sky band at all — its upper third is a
    // dark saturated mass of rock, foliage and hillside, and that mass is most
    // of what gives the frame a lid.
    //
    // z = −30 at 7.0 m puts the belt's crowns off the top edge and its trunks at
    // y 229, so the band above the bed is treeline rather than haze, and at
    // 14 m nearer the fog takes far less of its chroma. Measured across the
    // change, the top 200 px went from 71% sky to **31%**. It is also
    // **cheaper**: 22 trees at this height merge to 43 k triangles against the
    // 51 k the previous 26 cost, which is the trade this file owes the capture
    // budget for the boulders and the creature.
    //
    // **Half of it is broadleaf now.** Twenty-two copies of one silhouette is
    // the definition of the monoculture the review found, and a treeline is the
    // one place in the frame where a second species costs nothing: the broadleaf
    // is authored at unit height and instanced, so eleven of them are three draw
    // calls, and its bare crown (`fringe: 0` — at 25 m a sprig is under a pixel
    // and the lobes carry the whole read) is *cheaper* per tree than the cedar
    // it replaces. The two scatters share a centre and overlapping radii so the
    // species interleave rather than occupying two halves of the horizon.
    //
    // Down from 11 + 11 to 10 + 10. The belt's job is to be a lid, and at 22 it
    // was over-delivering: the band above the bed came back a solid green mass
    // with no sky in it at all, where the plate lets daylight through between its
    // crowns in three places. Twenty is where both measurements sit — the band
    // still closes and the gaps are the plate's, not a hole — and it is two trees
    // of the most expensive geometry on the stage given back toward the lawn
    // density below. (8 + 8 was tried first and went too far the other way; the
    // sky fraction of the top 200 px came back at 25% against the plate's 11%.)
    //
    // The radii come out to 20 and 22 from 16 and 17, and the broadleaf count
    // with them, for the reason recorded on the mid-right tree above: at z = −30
    // the frame is 24.3 m of half-width and a 16 m scatter simply does not reach
    // the frame's outer sixth on either side. Widening rather than adding is
    // what keeps this affordable — the same 10 conifers over a 57% larger disc
    // are the same geometry and the same three draw calls, and the belt's job is
    // to be a lid rather than a wood, so the density it loses in the middle is
    // density the bank and the massif were already covering.
    plant(buildConiferTree, 0, -30, { count: 10, radius: 20, height: 7.0 });
    plant(buildBroadleafTree, 1.5, -29, {
      count: 13, radius: 22, height: 6.4, spread: 1.20, lobes: 12, fringe: 0,
    });

    // --- rock ---------------------------------------------------------------
    // **Forward from z = −26 to z = −18, and up from `size` 2.8 to 5.0.** The
    // previous station was solved for a bed that then grew: with the bank at
    // 3.1 m the lavender at the mass's far edge crests at screen y 115, and a
    // 2.8 m block at z = −26 tops out at y 89 — a 26 px ribbon of grey that the
    // shipped capture duly showed as a single pale speck near x 1200 and
    // nothing else. The plate's boulders are the *dominant* mass of its upper
    // third, y 20 → 230 of 1080.
    //
    // At z = −18 the same block tops out at y 15 and its base sits at y 201, so
    // it clears the bed's crest by a hundred pixels of angular grey across most
    // of the frame width. The radius comes in with it, 11 → 8: the cluster's
    // near rim reaches `centre + radius`, and at 11 that put the blocks at
    // z = −7, i.e. inside the flower bed. At 8 the whole scatter lives between
    // z = −26 and −10, which is behind the bed's far half and half-buried in
    // its near half — which is exactly how the plate's wall meets its meadow.
    //
    // **`size` is not a height, and that is what the first move at 3.0 got
    // wrong.** Measured on the built cluster, `size: 3.0` produces a bounding
    // box 1.74 m tall: the option is a *typical block* dimension that the
    // builder then varies and half-buries, so the wall stood barely taller than
    // the lavender in front of it and the capture came back with a couple of
    // grey specks. 5.0 measures 2.91 m, which at this depth is 181 px of frame —
    // the band the plate actually shows. The whole cluster is 558 triangles
    // across 23 instances at any size, so the correction is free.
    //
    // The value defect that used to cap the wall's height is fixed rather than
    // worked around: every cluster now carries {@link ROCK_TINT}, which brings
    // the rock from the near-white it rendered at down onto the plate's own
    // measured slate without touching the facet contrast. That is what makes the
    // two **mid-ground** clusters below viable — grey rock at 5 m has to be grey.
    //
    // **Fewer, bigger, and packed to a fifth of the spread.** Twelve blocks over
    // a 16 m diameter is one block every 1.3 m against a 2.9 m block, so nothing
    // touched anything: the capture shipped a row of separate pale pyramids
    // standing shoulder to shoulder along the bed's crest — a picket fence, and
    // the most artificial thing in the frame. The plate's wall is the opposite
    // arrangement. It is a *pile*: three or four masses that interpenetrate, each
    // several times the size of ours, with the cleaved faces of one running into
    // the weathered top of the next and no gap anywhere.
    //
    // 9 blocks at `size` 7.4 (a 4.3 m box, by the same measured 0.58 m per unit
    // of `size` the paragraph above establishes) over a 12.4 m spread guarantees
    // that: the mean centre spacing is 1.4 m against a 4.3 m block, so every one
    // of them is inside its neighbour. In frame it is 268 px tall against the
    // plate's own 210 px band, and 1.1 of `ndc` wide, which is the dominant
    // upper-third mass the plate has and our row of pyramids was not. It is also
    // nine instances rather than twelve.
    //
    // The spread came back out from 4.6 m after the first capture of the packed
    // arrangement: at that radius the pile was correct and *narrow*, a 380 px
    // island with open sky either side of it, and the sky fraction of the top
    // 200 px measured 25% against the plate's 11%. A massif has to be wide enough
    // to be the lid as well as dense enough to be a pile.
    plant(buildBoulderCluster, -1.8, -17.4, {
      count: 9, radius: 6.2, size: 7.4, chips: 22, tint: ROCK_TINT, crease: 0.050,
    });
    // The right-hand outcrop, same treatment: 4 interlocking blocks rather than
    // 5 loose ones. It sits behind the broadleaf and only its shoulder is ever
    // in frame, so it is sized to read as *more of the same formation* seen past
    // a tree rather than as a second, smaller, separate pile.
    plant(buildBoulderCluster, 9.5, -16, {
      count: 4, radius: 3.0, size: 6.0, chips: 12, tint: ROCK_TINT, crease: 0.050,
    });
    // Mid-ground rock, half-buried in the bed either side of the line.
    //
    // The far wall is 20 m out and reads as *landscape*; the plate also carries
    // boulders at the bed's own depth — a grey mass immediately behind and
    // between its figures, with lavender growing over its foot — and those are
    // what give the meadow a middle distance at all. Without them our bed ran
    // from the party straight to the horizon with nothing but flowers in
    // between, so there was no scale reference anywhere in the 15 m the eye
    // spends most of its time in. `size` 2.4 measures ~1.4 m of block, i.e. a
    // head over the lavender it sits in and a head under the party's own
    // silhouettes at that depth.
    //
    // **Five stations, not two, and every one of them mossed.** Two clusters at
    // one depth read as a matched pair of props; the plate's mid-ground rock is
    // a *scatter* — blocks at four or five different depths and sizes with
    // flowers growing between them, so the eye is given a stepped run of scale
    // references from the party's own depth back to the wall. The moss is what
    // ties them to the meadow: every one of these has grass growing at its foot
    // and a green wash on its crown, which is the relationship
    // `Flora.creaseFacets` was written for and the reason grey rock at 5 m no
    // longer reads as dropped-in card.
    //
    // **Sized to crest the bed, and stationed in the gaps between figures.**
    // `size: 2.4` measures ~1.4 m of block and the lavender standing around it
    // runs to 1.6, so the first pass buried every mid-ground boulder it planted:
    // the capture has flowers where the rock is and no rock anywhere. 3.2–3.6
    // measures 1.9–2.1 m, a head clear of the tallest raceme and still a head
    // under the party's own silhouettes at that depth, which is the relationship
    // the plate shows.
    //
    // The stations are solved in `ndc` rather than in metres. At the bed's depth
    // the frame is 8.2 m of half-width, and the four figures centre at −0.52,
    // −0.18, +0.15 and +0.49 — so the gaps the eye can actually see through are
    // at −0.35 and +0.32, which is where the two near clusters go. A boulder
    // directly behind a figure is a boulder nobody will ever know was built.
    for (const r of [
      { x: -2.90, z: -4.9, n: 4, radius: 2.2, size: 2.9, chips: 10 },
      { x: 2.70, z: -5.6, n: 3, radius: 1.9, size: 2.6, chips: 8 },
      // Deeper, and in the one gap the left of the frame has: the creature's
      // silhouette ends at `ndc` −0.64 and Auren's begins at −0.63, and this
      // lands at −0.65 and 20 m out, so it fills the seam between them with a
      // mass at a third station rather than standing behind either.
      { x: -8.50, z: -12.5, n: 3, radius: 2.4, size: 4.0, chips: 8 },
      { x: 6.60, z: -9.0, n: 2, radius: 1.6, size: 2.6, chips: 6 },
    ]) {
      plant(buildBoulderCluster, r.x, r.z, {
        count: r.n, radius: r.radius, size: r.size, chips: r.chips, tint: MID_ROCK_TINT,
        // Chips stay inside their own cluster's footprint. `buildBoulderCluster`
        // defaults `chipRadius` to `radius * 3`, which is right for a massif
        // standing alone on open ground and wrong for a boulder half-buried in a
        // flower bed 5 m behind a party: at 3 × the (−2.9, −4.9) cluster throws
        // slivers forward to z = +1.7, i.e. out of the bed and onto the mown
        // lawn between the figures. Measured on the capture, two of them landed
        // at (−1.67, −0.23) and (1.29, −0.23) and rendered as 70 px blue slabs
        // lying on grass between Auren and Emrys and between Seren and Kite —
        // the same near-level-facet sky reflection the near stones were cut for,
        // arriving by a different route. Inside the bed the lavender covers them
        // and they do what they are for: breaking the block's foot into rubble.
        chipRadius: r.radius * 1.2,
        // Deeper creasing than the far massif's default. Crease depth is a
        // fraction of the block, so a 2 m mid-ground boulder gets 8 cm of relief
        // at the default against the massif's 22 cm — and it sits at a third of
        // the distance, where the eye is actually reading the surface rather
        // than the mass. 0.045 puts both at roughly the same number of pixels
        // of step, which is what "the same rock, nearer" has to mean.
        crease: 0.045,
      });
    }
    /**
     * Loose stones on the mown grass, as the plate keeps them — small enough to
     * be scale cues rather than props.
     *
     * They take {@link NEAR_STONE_TINT} rather than {@link ROCK_TINT} and a
     * quarter of the moss, and both are the same correction. `ROCK_TINT` is
     * solved for a massif standing 18 m out in its own aerial haze: it is a
     * *cool blue-grey*, and that is right there and wrong at four metres, where
     * the same stone is in direct sun with a green lawn bouncing into its
     * undersides. Measured on the capture, a 20 cm block at (−2.9, 3.2) came
     * back as a 67 px lozenge at hue 213° sitting on grass at hue 92° — the only
     * blue object below the horizon, and the first thing the eye finds in the
     * near lawn.
     *
     * They also shrink by a quarter. A scale cue works by being *unremarkable*;
     * at 0.42 the largest of them was reading as a boulder that had rolled into
     * the foreground.
     */
    // The corners and the party's own depth, and *not* the bottom centre. A
    // 17 cm block at (0.8, 4.9) sits 2.4 m from the lens on the frame's vertical
    // axis, where it is 60 px of flat blue-grey lozenge in the middle of the
    // bottom edge — measured on the capture, the single most conspicuous object
    // in the near lawn and the only thing in it that is not green. A scale cue
    // belongs where the eye is already travelling, not where it lands first.
    //
    // ## Two stations, and no chips inside four metres
    //
    // The station at (−2.9, 3.2) shipped the same defect the paragraph above
    // moved a stone out of the bottom centre to avoid, and moving it was not
    // enough. Measured on the capture it renders a 170 × 55 px lozenge centred
    // at `ndc` −0.80 reading **(64, 99, 168)** — a saturated cornflower blue on
    // a lawn at hue 131°, and *bluer and brighter than the tint it was given*.
    // `NEAR_STONE_TINT` is a warm grey and it cannot produce that, so the colour
    // is not albedo: a near-level facet four metres from the lens returns the
    // zenith straight down the barrel, and at this scene's probe intensity that
    // reflection out-runs the diffuse. No albedo correction reaches it.
    //
    // The two mid-frame stations are therefore dropped, and `chips` with them —
    // `createStoneChipGeometry` builds a slab a quarter as tall as it is long,
    // which is the shape most likely to present exactly that facet. What is left
    // is the plate's own arrangement: a couple of small pale stones out at the
    // frame's lower corners, the largest 0.24 m, far enough off axis that the
    // reflected direction is meadow rather than sky, and small enough that the
    // eye reads them as ground litter rather than as props.
    for (const s of [
      { x: 4.2, z: 5.0, n: 3, radius: 1.1, size: 0.24 },
      { x: -5.0, z: 4.2, n: 2, radius: 0.9, size: 0.21 },
    ]) {
      plant(buildBoulderCluster, s.x, s.z, {
        count: s.n, radius: s.radius, size: s.size, chips: 0,
        tint: NEAR_STONE_TINT, moss: 0.25,
      });
    }

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
   *     front edge, and a disc per character would give it a scalloped one.
   */
  _floraMask(x, z) {
    if (z > FLORA_FRONT_EDGE && z < STAGE.camZ + 1.0) {
      // In front of the bed line: only the lawn lives here, and it thins over
      // the track rather than stopping at it — see {@link PATH_GRASS_SURVIVAL}.
      return 1 - this._pathness(x, z) * (1 - PATH_GRASS_SURVIVAL);
    }
    if (z >= STAGE.camZ + 1.0) return 0; // behind the lens
    return 1;
  }

  /**
   * How much of the dirt path covers `(x, z)`, 0 → 1.
   *
   * A feathered band in the ground (not a half-plane — see {@link PATH}, which
   * owns both edges), oriented to enter the bottom-left corner of the battle
   * frame and leave at the left edge, which is where the plate's track runs and,
   * not coincidentally, the one part of the floor no figure stands on. Shared by
   * the ground's fragment colour and by the grass mask, so the worn patch and
   * the painted patch are the same patch.
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
    // The creature is included, and it is the reason this loop reads a list
    // rather than PARTY_PLACES directly. It stands 3.5 m west of and 4.1 m
    // beyond the leftmost party slot, i.e. outside the buffer the line alone
    // would size — and the ground shader resolves everything outside the buffer
    // to *no* occlusion, so the omission would not fail loudly, it would just quietly
    // ship the largest thing in frame standing on nothing.
    for (const p of [...PARTY_PLACES, ENCOUNTER_PLACE]) {
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
      //
      // 0.62, up from 0.45, and the number came off the plate rather than off a
      // preference. Over the meadow floor beneath the party (x 300–1300,
      // y 850–1050) `bravely01.jpg` reads p1 **37** sRGB — its shadowed grass
      // never goes near black, because a sunlit lawn under a 49° key is still
      // lit by the whole sky where the sun is blocked. The shipped capture read
      // p1 **1** over the same region. Two terms make that floor and only one
      // of them is this file's: the cascades' own occlusion is `Lighting`'s, and
      // this pool was multiplying what the cascades had already taken.
      uContactTint: { value: new THREE.Color(LIGHT.SHADOW_TINT).multiplyScalar(0.62) },
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
      // The value has been walked up twice. 0x5f7233 → 0x66763f lifted the red
      // channel against a measured saturation of 0.587 where the plate's mown
      // lawn (x 300–1300, y 850–1050) reads 0.483, and left the green where
      // `Flora.js` had measured it.
      //
      // **0x8c9869, up again from 0x66763f, and the previous value was chasing
      // the wrong statistic.** Both of the notes above compare *our floor* with
      // *the plate's floor* at p50, and at p50 the two do agree tolerably. What
      // they never compared is the top of the distribution, and that is where the
      // whole difference lives: over x 300–1300, y 850–1050 the plate reads p50
      // (96,119,90) and p90 **(151,156,98)** — a sunlit lawn whose highlights run
      // most of the way to white — while the shipped capture read p50 (66,88,53)
      // and p90 **(77,104,49)**. A 74-code-point gap at p90 against a 30-point
      // gap at p50 is not a hue error, it is a floor with no *lit* end to its
      // range at all, and it is why the bottom third of our frame read as damp
      // moss under a bright sky.
      //
      // Lifting the albedo 1.37 × moves the whole distribution rather than its
      // middle, which is what the measurement asks for; the shading model then
      // puts the shadowed end back where p50 already was.
      //
      // **0x939855 — the lift's own follow-up, on the blue channel.** With the
      // value correct the region mean over the same box came back
      // (90.7, 116.2, 80.0) against the plate's (97.2, 117.6, 66.0): V exact at
      // 0.46, and green exact, but B/G **0.69 against 0.56** and hue 102° against
      // 84°. Our lawn was the right brightness and 18° too cold — a green lit by
      // a blue sky rather than a green lit by the sun, which is the one thing a
      // meadow at midday must not be. The excess arrives through the ambient and
      // the probe, and the albedo's blue channel is the lever this file owns:
      // 0x69 → 0x55 is the 0.81 × that takes rendered B/G to the plate's 0.56,
      // and 0x8c → 0x93 the 1.05 × that takes R/G to its 0.82. Green is
      // deliberately untouched, so the value the paragraph above solved for does
      // not move. Saturation lands at 0.44 — the plate's own, measured.
      uLawnColor: { value: new THREE.Color(0x939855) },
      /**
       * The track, brought down to **1.23 × the lawn's luminance** from 1.39 ×.
       *
       * The measurement this was authored from — the plate's track at p90
       * `#ae9d79` — is still the target and is unchanged; what was wrong is that
       * a p90 was being used as the albedo for a surface whose *whole* visible
       * area sits in the frame's brightest, most open region. Against a lawn
       * albedo of `#939855` the old value put the track two thirds of a stop
       * up, so the corner it occupies was the lightest thing below the horizon
       * and the eye read it as the frame's subject. On the plate the same
       * relationship is barely a third of a stop: its path is *warmer* than the
       * grass, and only marginally brighter.
       *
       * The hue is untouched — the warm/cool split between track and lawn is
       * the read, and it is the one this stage got right first time.
       *
       * **`0xd8b489`, and the paragraph above was tuning against a track that
       * was not on screen.** It reasons entirely from a comparison with the lawn
       * *albedo*, which is the wrong comparison: what the eye judges is the
       * rendered corner, and until {@link PATH} was re-solved onto the plate's
       * own boundary no capture had one. With the band in frame the corner reads
       * (123, 134, 105) — hue 83°, V 0.53, green still the dominant channel —
       * against the plate's (167, 148, 112) at hue 39° and V 0.65. The lift is
       * spent almost entirely on red (1.14 ×) with a touch on green (1.07 ×) and
       * none on blue, which is what turns a pale green-grey into bleached earth
       * rather than simply making it brighter.
       */
      uPathColor: { value: new THREE.Color(0xd8b489) },
      // Nominal 0.32 and swing 0.55, down from 0.35 / 0.85.
      //
      // The swing is what the eye was reading as *blotches*: at 0.85 the fBm
      // drove the floor over a 0.55–1.45 range, i.e. a factor of 2.6 between the
      // light and dark ends of a pattern whose features were metre-scale at the
      // old repeat, so the near ground carried dark smears a body-width across
      // that no lawn has. The plate's mown grass varies too, but between patches
      // of *streaking*, not in metre-wide pools. 0.55 halves the excursion into
      // tiling variation the eye reads as surface rather than as staining, and
      // the nominal comes down with it so the texture's own mean maps to 1.0
      // instead of to a net darkening.
      uGroundDetail: { value: new THREE.Vector2(0.32, 0.55) },
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
   * Build the staged party and run them across the middle of frame —
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
      // Solved, not authored — see {@link presentationRotation}. The rig's
      // forward is **+Z** (`CharacterFactory`'s `hairlinePhi` states the
      // convention outright, "+Z (forward) is theta = pi/2"), so every bearing
      // in that solve is already in rig space and the result goes straight on
      // the root.
      character.root.rotation.y = presentationRotation(place, slot.face);
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

  /**
   * Stage the encounter — see {@link ENCOUNTER} for every number below.
   *
   * `Bestiary.buildCreature` returns a merged, unrigged root whose origin sits
   * on the ground with +Z facing, so placement is a position, a `rotation.y` and
   * nothing else. Three things still have to be done here and none of them are
   * the module's to do:
   *
   *  - **`lighting` and `forge` are passed on.** The first aliases the rig's
   *    key/rim uniform objects into the hide material, which is what re-keys the
   *    creature on a time-of-day change without a per-frame call; the second
   *    binds the leather normal/roughness maps. A creature built without them
   *    renders flat and stops tracking the clock.
   *  - **`outline: false`.** The same reference correction `_buildCast` records:
   *    measured across four clean silhouette crossings the plate shows no value
   *    trough at a contour, so nothing on this stage carries an ink line. It
   *    also drops the hull, which is the one place a vertex is paid for twice.
   *  - **It joins the contact projector.** The buffer is sized from the staged
   *    footprints (see `_buildContactShadows`), so the creature has to be
   *    enrolled or the one thing in frame that is *not* touching the ground
   *    would be the only thing without a shadow under it — and a floater with no
   *    pool beneath it reads as a sticker rather than as a body in the scene.
   *
   * It faces the party's centroid rather than the gaze anchor: the anchor is
   * 18 m out for the party's own convergence and aiming the creature at it would
   * point it past its own target and out of frame.
   */
  _buildEncounter(forge) {
    const creature = buildCreature(ENCOUNTER.id, {
      seed: ENCOUNTER.seed,
      height: ENCOUNTER.height,
      lighting: this.lighting,
      forge,
      outline: false,
    });
    const place = ENCOUNTER_PLACE;
    const y = groundHeight(place.x, place.z);
    creature.root.position.set(place.x, y, place.z);
    // Aimed at the line, then turned back toward the lens — see
    // `ENCOUNTER.turnToLens`. The camera bearing is measured from the creature's
    // own station rather than assumed to be straight down -Z, for the same
    // reason `presentationRotation` measures it for every party slot: at the
    // left edge of a 40° frame the lens sits 30° off the world axis, and
    // ignoring that is how a stated presentation angle ships as something else.
    // Clamped to the gap rather than added blind: a later restaging that put the
    // creature nearly square to the lens would otherwise have `turnToLens` carry
    // it *past* square and start closing the far side of the head, which is the
    // opposite of what the constant is for.
    const camBearing = Math.atan2(STAGE.camX - place.x, STAGE.camZ - place.z);
    const aimed = headingTo(place, PARTY_CENTROID);
    const gap = camBearing - aimed;
    const turn = Math.min((ENCOUNTER.turnToLens * Math.PI) / 180, Math.abs(gap));
    this._encounterHeading = aimed + Math.sign(gap) * turn;
    creature.root.rotation.y = this._encounterHeading;
    this.scene.add(creature.root);
    LookdevScene._markContactCasters(creature.root);
    this._encounter = creature;
    this._encounterBaseY = y;
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
      // `bokeh` is the third argument and it is only half the lens now. It
      // scales the *physical* CoC — the near field, the highlight discs, the
      // softening of anything at subject depth — and `PostFX` has split the
      // far-field floor off it into `setBackgroundDefocus`, because the two
      // answer different questions and every pose in this table wants a
      // different pair of answers. `bokeh: 0` alone therefore no longer buys a
      // sharp background, and until `defocus` existed every meadow pose here
      // was silently shipping the full authored 10.3 px of it.
      //
      // Undefined means 1 — the authored atmosphere — so a pose that has not
      // thought about its background gets PostFX's own composition rather than
      // an accidental sharp horizon.
      postfx.setDof(solved.focus, pose.aperture, pose.bokeh);
      postfx.setBackgroundDefocus(pose.defocus ?? 1);
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
    // The creature is a subject, not scenery: "are these shapes
    // distinguishable" is a question about the encounter as a whole, and a
    // creature left in full colour would also be the only lit thing in a frame
    // whose premise is two values.
    if (this._encounter) matte(this._encounter.root);

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
    // second. Feeding that straight into four verlet cloth rigs means 15
    // substeps each and a visible whip; clamping keeps the pose stable and
    // costs nothing at real frame rates.
    const step = Math.min(dt, 1 / 30);
    for (const c of this.cast) c.update(step);

    const t = this.engine.elapsed;

    // The creature is one merged buffer per material with no skeleton, so the
    // root is the whole animation budget — which for something that hovers is
    // enough. Driven off `engine.elapsed` rather than integrated, so a capture
    // lands on the same phase every run and the contact pool below it (which
    // renders from the live transform) matches the pose it is under.
    if (this._encounter) {
      const bob = Math.sin(t * ENCOUNTER.bobRate);
      this._encounter.root.position.y = this._encounterBaseY + bob * ENCOUNTER.hover;
      // A slow yaw drift about the facing, a third of the bob's rate so the two
      // never lock into one period and read as a mechanism.
      this._encounter.root.rotation.y = this._encounterHeading
        + Math.sin(t * ENCOUNTER.bobRate * 0.31) * 0.09;
    }

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
    // Same contract as a character and the same reason: `buildCreature` owns
    // three geometries and three materials that `Scene.track` never saw.
    this._encounter?.dispose();
    this._encounter = null;
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
