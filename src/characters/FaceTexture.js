/**
 * FaceTexture.js — the painted anime face, drawn with the 2D canvas API.
 *
 * The face is a **painted texture on a 3D head**, not modelled features: a
 * modelled lash line takes the lighting, so its ink weight brightens on the lit
 * side and vanishes on the shadow side and no amount of tuning recovers what a
 * *drawn* line has for free.
 *
 * ## Measured off `bravely04.jpg`, the only frontal head in the set
 *
 * `docs/BRAVELY_REFERENCE.md`, `docs/ANIME_PIPELINE.md` and
 * `docs/REFERENCE_TARGET.md` were transcribed by eye before the client's
 * screenshots were in the repository, and their face numbers are wrong. Two
 * earlier passes then measured off `bravely01.jpg`, where **every head is at
 * three-quarters** — so the eye they measured was foreshortened, its aspect was
 * read a fifth too narrow, and the nose and mouth were read too high up a face
 * that was also tipped away from camera. An art director scored the result
 * "saucer-eye faces with bar brows and no nose … heads read as toys".
 *
 * `bravely04.jpg` is Adelle in a near-frontal spell-cast close-up, and it is the
 * plate this pass is built from. Her head measures crown→chin **83 px** (chin at
 * y 128, eye line y 91.5, `eyeY` 0.56 back-solves the crown to y 45) on a face
 * **71 px** wide at the cheekbone. Against that:
 *
 * | quantity          | plate (Adelle, `bravely04`)                | here |
 * |---|---|---|
 * | eye ink           | 20 × 12 px = 0.28 × 0.17 of face width     | `eyeW` 0.199, `eyeH` 0.144 (0.23 × 0.16 of the face) |
 * | eye aspect        | 1.67 (Gloria 1.46 at three-quarters)       | families 1.30–1.58 |
 * | eye centres       | ±20 px = 0.28 of face width from the axis  | `eyeX` 0.256 → 0.28 of the face |
 * | iris ramp         | rgb(47,57,108) top → rgb(89,93,192) foot, i.e. 0.07 → 0.28 of skin's linear luminance | `irisTop` 0.10 → `irisBounce` 0.44, four stops |
 * | brow              | 2 px core, **4 px of clear skin** under it | `thick` 0.016–0.022, `browClear` 0.30 |
 * | brow colour       | rgb(84,43,75) — a dark plum, not black     | hair-derived, clamped to 0.11 of skin |
 * | mouth             | rgb(125,78,72) warm red-brown, lit lip under it (Gloria y 420–425) | `mouth` clamped to 0.22 of skin, tinted rose |
 * | mouth line        | 0.90 of crown→chin                         | `mouthY` 0.835 → 0.81 of crown→chin |
 * | nose base         | 0.82 of crown→chin                         | `noseY` 0.745 → 0.73 of crown→chin |
 * | cheek vs forehead | rgb(211,169,173) against rgb(208,181,188): value held, green and blue pulled | a hue-only blush, per character |
 *
 * The corrections that follow, and what each replaces:
 *
 *  1. **The eye is 42% of its previous area.** 0.199 × 0.144 against 0.29 ×
 *     0.235, and the aspect band moves up to the plate's 1.30–1.58 rather than
 *     down to 1.14–1.34 — the plate's eye is *wider and much shorter* than ours
 *     was. The pair also moves apart (`eyeX` 0.270 → 0.256), which is what
 *     leaves the plate's full eye-width of nose bridge between them.
 *  2. **The iris is constructed, not filled.** Outer rim, a two-tone vertical
 *     ramp, a bounce crescent along its foot, a pupil at a third of its radius,
 *     a hard key glint and a small counter-glint — six marks where there used to
 *     be a gradient and one dot. That structure is the whole difference between
 *     a painted iris and a coloured hole, and it is legible in the plate at 12 px.
 *  3. **The lash is a stroke, not a cap.** 0.16–0.22 of the ink height rather
 *     than 0.26–0.32, weighted to the **outer third** rather than to the apex,
 *     and finished with two or three separate tapered flicks instead of one
 *     ribbon extension.
 *  4. **Brows halve in weight and double their clearance.** The plate's brow is
 *     a 2 px arc with 4 px of clear skin under it; ours was a 3.5% wedge sitting
 *     1.6% clear, which at battle range fused into the lash.
 *  5. **The nose is a tick, not a snout.** A soft V of shadow with one lit dot
 *     above it. The pair of nostril darkenings the previous pass drew is the
 *     single mark that most reliably turned a chibi head into a piglet.
 *  6. **Structure is painted under the features.** A hairline/fringe occlusion,
 *     a hue-only cheek blush and a jaw-side falloff — all bounded inside the
 *     rim reconciliation (see `FORM`) so none of them can print on bare skull.
 *  7. **No hard terminator and no outline.** Unchanged and still correct: the
 *     plate faces carry a long, low-amplitude warm gradient and nothing else.
 *
 * ## Structure
 *
 * Per-character identity is *derived from `roster.js`*, never from a table keyed
 * by id — a new party member must get a coherent face without an edit here.
 * `proportions.eyeShape` and `proportions.brow` select a construction family and
 * `eye`, `eyeSpacing` and `browAngle` modulate it, so two characters sharing a
 * family are still different drawings.
 *
 * Determinism: the micro-variation that stops the six looking rubber-stamped is
 * driven by an `Rng` seeded from the character id, following the same convention
 * as `art/Textures.js`. Seeding from the key rather than sharing the global
 * stream makes a face independent of the order scenes happen to build in, which
 * is what keeps a capture reproducible. There is **no procedural surface noise**
 * anywhere; the one place randomness reaches the canvas is the *outline* of the
 * facial-hair field, which is a shape, not a texture.
 *
 * OWNED BY: characters.
 */
import * as THREE from 'three';
import { Rng } from '../core/GameState.js';
import { ROSTER } from './roster.js';
import { mixHex, saturate, hexToLinear, luminance } from '../art/Palette.js';

/**
 * Default edge of the square face texture.
 *
 * 1024, not 512. The closeup camera magnifies the face plate to roughly the
 * texture's own resolution, so at 512 every rasterised curve is being stretched.
 * 1024 supersamples the highest-contrast edge in the game for 4 MB a head, and
 * `buildFaceTexture` pairs it with a **hand-drawn mip chain** so the battle
 * camera does not throw that crispness away again (see the note there).
 */
export const FACE_TEXTURE_SIZE = 1024;

/**
 * Minimum feature sizes **in texels of the level being drawn**.
 *
 * These are what make a hand-authored mip chain worth having. A box-filtered
 * 128² mip of a 1024² face averages the catch-light and the mouth line into the
 * skin around them. Redrawing each level with every feature held above a texel
 * floor keeps them as real, opaque, full-contrast marks at the size the battle
 * camera actually samples.
 *
 * The floors are the last line of defence for the marks the review found
 * missing, and they matter more after this pass than before it: the eye is 46%
 * of its previous area, so every mark inside it lost a third of its texels. At
 * the 128² mip a 0.150 eye is 19 texels tall, which puts the lash bar at 3.6,
 * the iris at 16 across, the pupil at 2.6 and the counter-glint at 1.3 — the
 * last of those is the only mark in the file that now lives *at* its floor, and
 * it is a hard white dot on near-black, the one mark that survives being small.
 */
const MIN_PX = Object.freeze({
  ring: 1.0, highlight: 2.2, spark: 1.3, lash: 3.0, pupil: 2.0,
  brow: 2.6, mouth: 2.4, lid: 1.2, crease: 1.0, nose: 2.0,
});

const atLeast = (v, floor) => (v < floor ? floor : v);

/**
 * Layout table in fractions of the texture, origin top-left. The head's front
 * UV island maps onto this square, and `Rig.computeMetrics` derives the plate's
 * world placement from `eyeY` so the painted eye line and the anatomical one
 * cannot drift apart.
 *
 * Every number here is measured off the plates — see the table at the top of the
 * file for the pixel counts each one comes from.
 */
export const FACE_LAYOUT = Object.freeze({
  /**
   * Eye centre height, in fractions of the **texture square**.
   *
   * `Rig` derives `face.top` from this number, so the square is not the head:
   * it runs from 0.90 head-radii above centre to 0.92 below, and the skull's
   * crown and chin sit at texture-y −0.054 and 1.042. Every crown→chin ratio
   * quoted in this file is converted through that 1.096 span. 0.56 of the square
   * is 0.56 of crown→chin because the eye line is the fixed point of the
   * mapping — which is the whole reason `Rig` solves the plate from it.
   */
  eyeY: 0.56,
  /**
   * Inner-left eye centre; the other sits at `1 - eyeX`.
   *
   * This number is not free: it is bounded above by geometry and below by the
   * plate's own spacing.
   *
   * `Rig` gives the plate `halfX = head.rx * 0.95` on a square of
   * `head.rx * 2.28`, so the mesh only ever samples `u ∈ [0.083, 0.917]` — a
   * painted feature past 0.417 of the texture from the centreline is *never
   * drawn on the head at all* — and the plate's rim starts diving inside the
   * skull at `buryFrom` 0.92 of that, i.e. 0.383.
   *
   * Adelle's eye centres in `bravely04.jpg` sit 20 px either side of her face
   * axis on a 71 px face — 0.282 of the face width. The painted island is
   * `2 × halfX = 1.90 rx` on a 2.28 rx square, i.e. 0.877 of it, so the plate's
   * spacing is 0.247 of the square and `eyeX` is 0.253. 0.256 is that, rounded
   * outward by the width the reach audit has to spare.
   *
   * The audit, at the roster's widest reach (Emrys: `eye` 1.16, `eyeSpacing`
   * 1.05, `round`): `halfSpan` 0.256 + `inkW`/2 0.103 = 0.359, comfortably
   * inside `buryFrom`. The previous 0.270 sat 0.383 — exactly on the dive — and
   * left barely half an eye width of nose bridge, which is a large part of what
   * made the pair read as one dark band.
   */
  eyeX: 0.256,
  /**
   * Nominal eye ink **width**.
   *
   * Consumed here only as documentation of what the families average to — the
   * painter solves the width from the height and the family aspect (see
   * `eyeFrame`) — but `Rig` reads it directly to size the hair guard band, so it
   * has to state the real drawn width. The roster spans 0.193 (Emrys, round)
   * to 0.215 (Kirella, sharp).
   *
   * Adelle's ink is 20 px on a 71 px face; against the island's 0.877 of the
   * square that is 0.247. This is 0.199 — a fifth under the plate, because our
   * eye is read through a toon surface at a three-quarter yaw that foreshortens
   * it horizontally while leaving its height alone, and an eye matched on width
   * at that yaw is wider *on screen* than the plate's frontal one. It also
   * happens to be where the art-direction note asking for "about a fifth of the
   * face" and the plate's own 0.28 meet: the roster lands 0.22–0.25.
   */
  eyeW: 0.199,
  /**
   * Eye ink **height**, and the dimension the whole eye is solved from.
   *
   * Adelle's ink is 12 px on an 83 px crown→chin — 0.145 of the square once the
   * 1.096 span is taken out. This is 0.144, a whisker under the plate: the
   * roster's `eye` multiplier reaches 1.16, so the tallest eye in the party has
   * to sit at the plate rather than above it.
   *
   * It was 0.235. Two passes read the eye off `bravely01.jpg`, where every head
   * is at three-quarters and *tipped*, and compensated for the resulting slit by
   * inflating the height until it read; what that produced was the saucer the
   * art director measured. The frontal plate says the eye is short and wide, so
   * the legibility budget is spent on aspect (families now run to 1.58) and on
   * the six-mark iris construction rather than on height.
   */
  eyeH: 0.144,
  /**
   * Envelope-relative brow clearance. **Unused by the painter** — `browClear`
   * below does that job — and kept only because `Rig.computeMetrics` derives its
   * hair-clearance guard band from it. The guard stays conservative under the
   * shorter eye: it now clears the drawn brow by more than a tenth of the face.
   */
  browGap: 0.13,
  /**
   * Brow length, × eye ink width. The plate's brows are a little *longer* than
   * the eye and the extra is spent inboard: Gloria 27 px against a 24 px eye,
   * Adelle 28 against 27, both starting 2–3 px inside the eye's inner corner and
   * dying at its outer one. Elvis reads 36 against 26, but he is nearly in
   * profile and his brow is wrapping the brow ridge, so the frontal faces win.
   */
  browW: 1.16,
  /** How far the brow's centre sits inboard of the eye's, × eye ink width. */
  browShift: 0.07,
  /**
   * Where the brow's lowest ink sits above the lash bar's highest, as a fraction
   * of the eye's drawn ink height.
   *
   * Measured to the *ink*, not to the envelope, because every shape family opens
   * to a different fraction of the envelope and a fraction of the cell therefore
   * means something different on each face.
   *
   * Adelle's near brow in `bravely04.jpg` runs y 79–81 at column 336 and her
   * lash starts at y 86: **four rows of clear skin under a twelve-row eye**,
   * 0.33 of the ink height. The published 0.16 was read off `bravely01.jpg`,
   * where the heads are tipped forward and the brow foreshortens down onto the
   * lid, and at battle range it fused the two heaviest marks on the face into
   * one bar per eye. 0.30 is the frontal plate, held a hair under it because our
   * brow carries an arch the plate's flatter one does not.
   */
  browClear: 0.30,
  /**
   * Nose base, in fractions of the square.
   *
   * Adelle's nose tick sits at y 113 on a crown 45 / chin 128 head — 0.82 of
   * crown→chin, which through the square's 1.096 span is 0.845. Gloria's reads
   * the same. This is 0.745 (0.73 of crown→chin): the plate's own number puts
   * the nose inside the ramp where `FORM`'s rim reconciliation is already
   * pulling the texture back to flat skin, so the mark would be half erased.
   * The gain over the published 0.705 is real all the same — it is 0.04 of the
   * square of extra lower face, and the lower face is where the "toy" read
   * lived.
   */
  noseY: 0.745,
  /**
   * Mouth line.
   *
   * The plate puts it at 0.90 of crown→chin (Adelle y 120, Gloria y 422) —
   * texture-y 0.932, which is outside `FORM.rimTo` and therefore unpaintable.
   * 0.835 is the lowest row the island holds at full strength, and it buys a
   * fifth more eye→mouth span than the published 0.795: the plate's lower face
   * is long, and every previous pass drew it short.
   */
  mouthY: 0.835,
  /**
   * Mouth width. Adelle's is 14 px on a 71 px face — 0.197 of the face width,
   * i.e. 0.173 of the square, and 0.70 of her eye's ink width. This is 0.160,
   * which is 0.77 eye widths against the shorter eye this pass draws.
   */
  mouthW: 0.160,
});

/**
 * Expression set. Same layout every time — only brow angle and height, upper-lid
 * closure, lower-lid raise, mouth curvature and mouth width move. That
 * constraint is what keeps four expressions looking like one character rather
 * than four.
 *
 * `browTilt` is added to the roster's `browAngle` in the roster's own sign
 * convention (positive = gentle, inner end raised). `mouthCurve` is a fraction
 * of the texture and positive bows the mouth's centre *downward* on screen,
 * which is what a smile does once the corners are pinned.
 *
 * ## Nothing but `hurt` closes the eye any more
 *
 * `open` scales the upper half of the aperture and `lidRaise` the lower, so the
 * two of them together are the only way the drawn eye can lose height. The
 * previous table spent 12% of it on `determined` and 30% of the lower lid on
 * `joy` — reasonable on a 1024² canvas, and at a 90 px head it is the difference
 * between an eye and a line, because the aperture is what carries the iris and
 * the iris is the only coloured mark on the face. Performance is carried by the
 * brow, the mouth and the pupil instead, all three of which keep their weight at
 * any size. `hurt` is the one expression allowed to squint, and it is a state a
 * capture never sits in.
 */
const EXPRESSIONS = Object.freeze({
  neutral:    Object.freeze({ open: 1.00, lidRaise: 0.00, browLift: 0.000, browTilt:  0.00, browThick: 1.00, mouthCurve: 0.004, mouthWidth: 1.00, mouthOpen: 0.00, pupil: 1.00 }),
  determined: Object.freeze({ open: 1.00, lidRaise: 0.04, browLift: -0.022, browTilt: -0.40, browThick: 1.18, mouthCurve: -0.004, mouthWidth: 1.10, mouthOpen: 0.00, pupil: 0.88 }),
  hurt:       Object.freeze({ open: 0.74, lidRaise: 0.20, browLift: 0.014, browTilt:  0.44, browThick: 0.96, mouthCurve: -0.014, mouthWidth: 0.86, mouthOpen: 0.18, pupil: 1.16 }),
  joy:        Object.freeze({ open: 1.00, lidRaise: 0.16, browLift: 0.022, browTilt:  0.16, browThick: 1.02, mouthCurve: 0.026, mouthWidth: 1.32, mouthOpen: 0.30, pupil: 1.08 }),
});

/** Canonical expression names, in review order. */
export const EXPRESSION_NAMES = Object.freeze(Object.keys(EXPRESSIONS));

/**
 * Eye-shape families, keyed by `roster.proportions.eyeShape`.
 *
 * Four genuinely different *constructions* — a slit, a raked wedge, a leaf and a
 * wide oval — differing in aspect, corner drop, lid depth, tilt, lash weight and
 * iris fill at once. A single roundness scalar can only slide one shape along
 * one axis, which is why six characters used to come out as six points on a
 * line.
 *
 *   `aspect`     the drawn **ink** width : height. Adelle's frontal eye is 20 ×
 *                12 — **1.67** — and Gloria's three-quarter one 1.46, so the
 *                plate's band is 1.45–1.70 and the families run 1.30–1.58
 *                under it. The published 1.14–1.34 came from measuring
 *                foreshortened eyes and is the reason ours read as circles.
 *   `widen`      ink width trim once the aspect has widened the height. It only
 *                exists to keep the widest eye off the plate's buried rim (see
 *                `FACE_LAYOUT.eyeX`); identity lives in `aspect`.
 *   `lidSplit`   share of the aperture height that sits above the lid line
 *   `irisFill`   iris diameter as a fraction of the **aperture height**, not of
 *                its width. Gloria's iris block is 11 px in a 11.5 px aperture.
 *                Every family is therefore near 1 — and at these aspects that
 *                is exactly what *creates* the sclera: a disc as tall as the
 *                aperture covers only two thirds of a 1.5-aspect eye's width,
 *                so the canthal wedges are a consequence of the construction
 *                rather than something the painter has to leave room for.
 *   `flick`      lash overhang past the outer corner, × the eye half-width. The
 *                plates barely flick at all — Gloria's is 2 px on a 19 px eye —
 *                and the flick is the outermost ink on the face, so it is also
 *                what the plate's dive zone eats first.
 *   `lashes`     how many separate tapered flicks the outer corner carries. The
 *                plate draws two or three fine spikes, not one thickened ribbon
 *                end; the count is an identity channel and the softest family
 *                gets the most.
 */
const EYE_SHAPES = Object.freeze({
  narrow: Object.freeze({ round: 0.05, aspect: 1.58, widen: 0.96, lidSplit: 0.46, cornerDrop: 0.18, lowerDepth: 0.62, lash: 0.22, flick: 0.20, tilt: 0.13, irisFill: 0.92, crease: 0.85, lashes: 2 }),
  sharp:  Object.freeze({ round: 0.32, aspect: 1.48, widen: 1.01, lidSplit: 0.50, cornerDrop: 0.14, lowerDepth: 0.74, lash: 0.20, flick: 0.17, tilt: 0.09, irisFill: 0.95, crease: 0.55, lashes: 2 }),
  almond: Object.freeze({ round: 0.62, aspect: 1.39, widen: 1.00, lidSplit: 0.54, cornerDrop: 0.10, lowerDepth: 0.86, lash: 0.18, flick: 0.14, tilt: 0.05, irisFill: 0.98, crease: 0.25, lashes: 3 }),
  round:  Object.freeze({ round: 1.00, aspect: 1.30, widen: 0.98, lidSplit: 0.56, cornerDrop: 0.04, lowerDepth: 0.96, lash: 0.16, flick: 0.11, tilt: 0.01, irisFill: 1.00, crease: 0.00, lashes: 3 }),
});

/**
 * Brow families, keyed by `roster.proportions.brow`.
 *
 * "Angle carries personality: down-inner = determined, up-inner = gentle, flat =
 * cool." The roster's `browAngle` was already being read, but at unity gain a
 * 0.26 rad brow moves its inner end by 2% of the face and the whole cast reads
 * level. `gain` makes the authored intent visible; thickness, arch and drop
 * separate a blunt determined brow from a fine arched one on three more
 * channels.
 *
 * `thick` is a fraction of the **face**, mildly scaled by the eye multiplier in
 * `drawBrow`. Tying it to the eye's ink height instead — which is what an
 * earlier pass did — hands the large-eyed children the heaviest brows in the
 * party, because their eye is half again as tall as Bramm's; the plates put
 * every brow in the set at 2.5–3.5 px whatever the eye under it is doing.
 *
 * `drop` is added *toward* the eye, so a hard brow sits low and crowds the lid.
 *
 * The thicknesses are **halved** against the previous pass. Adelle's brow core
 * is 2 px on an 83 px crown→chin — 0.022 of the square, with the soft edges
 * carrying it to three — and the published 0.033–0.042 was read off a
 * three-quarter plate where the brow wraps the ridge and doubles in apparent
 * width. Combined with the double taper `browOutline` now draws, the ink area
 * of a brow is 40% of what it was, which is what the review's "bar brows" asks
 * for; the *value* stays near-black, because a thin mark has to be dark to
 * survive the mip chain.
 */
const BROW_STYLES = Object.freeze({
  hard:   Object.freeze({ thick: 0.022, arch: 0.22, tilt: -0.07, drop: 0.006, gain: 1.35, mouth: -0.005, mouthW: 1.12 }),
  level:  Object.freeze({ thick: 0.019, arch: 0.42, tilt: 0.00, drop: 0.000, gain: 1.30, mouth: 0.000, mouthW: 1.00 }),
  gentle: Object.freeze({ thick: 0.016, arch: 0.68, tilt: 0.05, drop: -0.005, gain: 1.30, mouth: 0.007, mouthW: 0.92 }),
});

/**
 * Painted facial hair, keyed by a style name.
 *
 * Elvis in `bravely01.jpg` is the evidence: the beard is **not** an ink shape.
 * It is a semi-opaque, desaturated field a little over half-way from skin to
 * hair-shade, with a soft irregular upper edge, laid over the moustache strip
 * and the whole jaw. The 3D beard geometry in `roster.hair` hangs *below* the
 * chin; this is the part of a beard that lives on the face itself, and without
 * it a bearded character reads as a clean-shaven head with a wig glued under it.
 *
 *   `moustache` / `chin` / `jaw`  per-zone opacity multipliers
 *   `alpha`                       peak coverage — never 1, the plate's beard
 *                                 lets skin through everywhere
 */
const FACIAL_HAIR = Object.freeze({
  full:      Object.freeze({ moustache: 1.00, chin: 1.00, jaw: 1.00, alpha: 0.46 }),
  goatee:    Object.freeze({ moustache: 0.85, chin: 1.00, jaw: 0.18, alpha: 0.44 }),
  moustache: Object.freeze({ moustache: 1.00, chin: 0.00, jaw: 0.00, alpha: 0.42 }),
  stubble:   Object.freeze({ moustache: 0.70, chin: 0.85, jaw: 0.95, alpha: 0.20 }),
});

/** Roster key first; otherwise the nearest family to the derived roundness. */
function pickEyeShape(name, round) {
  const named = EYE_SHAPES[name];
  if (named) return named;
  if (round < 0.2) return EYE_SHAPES.narrow;
  if (round < 0.48) return EYE_SHAPES.sharp;
  if (round < 0.8) return EYE_SHAPES.almond;
  return EYE_SHAPES.round;
}

/** Roster key first; otherwise the sign of the authored brow angle. */
function pickBrowStyle(name, angle) {
  return BROW_STYLES[name] ?? (angle < -0.04 ? BROW_STYLES.hard : angle > 0.04 ? BROW_STYLES.gentle : BROW_STYLES.level);
}

/**
 * Which painted facial hair a roster entry gets.
 *
 * Derived, like everything else here, so a new character is covered without an
 * edit to this file: an explicit `facialHair` (on the entry or in its `hair`
 * block) wins, otherwise the hair block's `style` and `beardLength` decide. A
 * short beard is stubble, a long one is a full beard.
 */
function pickFacialHair(def) {
  const hair = def.hair ?? {};
  const named = FACIAL_HAIR[def.facialHair ?? hair.facial];
  if (named) return named;
  if (hair.style !== 'beard') return null;
  const len = hair.beardLength ?? 0;
  if (len >= 0.7) return FACIAL_HAIR.full;
  if (len >= 0.3) return FACIAL_HAIR.goatee;
  return FACIAL_HAIR.stubble;
}

// ------------------------------------------------------------------ plumbing

/**
 * OffscreenCanvas keeps face generation off the DOM — six characters × four
 * expressions is twenty-four canvases and appending real ones would thrash
 * layout. The DOM path is only for environments predating it.
 */
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** FNV-1a over the character id: a stable seed that does not depend on order. */
function seedFor(id) {
  let h = 0x811c9dc5;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;
}

/**
 * How far from the centreline a painted eye's ink may reach, in texture
 * fractions.
 *
 * `Rig.computeMetrics` maps the plate onto `halfX = head.rx * 0.95` of a square
 * `head.rx * 2.28` across, so the mesh only ever samples `u` within 0.417 of the
 * centre — paint outside that is on no triangle — and the plate's rim starts
 * diving inside the skull at `buryFrom` 0.92 of that, i.e. 0.383. 0.405 puts the
 * eye's outer corner inside the sampled region with only the lash flick's
 * tapering tip in the dive, which is the one mark thin enough not to smear.
 *
 * It cannot be imported: `Rig` imports `FACE_LAYOUT` from this file and the
 * dependency must not become a cycle. Same contract as `FORM` below.
 */
const PLATE_REACH = 0.405;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------- colour

function cssHex(hex) {
  return `#${(hex >>> 0).toString(16).padStart(6, '0')}`;
}

function cssRgba(hex, a) {
  const h = hex >>> 0;
  return `rgba(${(h >> 16) & 255},${(h >> 8) & 255},${h & 255},${a})`;
}

/** Multiply toward black. `mixHex` works in linear light, so this is a true
 *  darkening rather than the muddy sRGB-space lerp. */
function darken(hex, amount) {
  return mixHex(hex, 0x000000, amount);
}

const _lin = [0, 0, 0];
function lumOf(hex) {
  hexToLinear(hex, _lin);
  return luminance(_lin[0], _lin[1], _lin[2]);
}

/**
 * Force `hex` far enough below `against` in luminance to survive downscaling.
 *
 * Seren and Emrys have near-white hair, so a brow taken as "hair darkened 25%"
 * lands within a few percent of their skin and half the expression disappears at
 * battle range. Darkening until a fixed luminance ratio is met fixes that for
 * pale hair without touching the dark-haired characters, whose brows already
 * clear the threshold on the first test.
 */
function ensureDarkerThan(hex, against, ratio) {
  const target = lumOf(against) * ratio;
  let out = hex;
  /**
   * Forty-eight steps of 8%, not sixteen of 22%.
   *
   * The coarse step was not a performance choice and it was not free: it
   * *overshoots*. A colour one step above the target lands 22% under it, and for
   * an input far from the target — Auren's pale gold iris against a ratio of
   * 0.10 — the walk takes eleven steps and finishes at 0.084 rather than 0.10.
   * Every ratio in this file therefore meant something between itself and 0.78
   * of itself, depending on the character, which is exactly the kind of slack
   * that makes a measured number stop being a measurement. It is also why the
   * iris ramp collapsed: `irisTop` and the pupil both bottomed out near black on
   * the light-eyed characters, so the pupil had nothing to be dark against.
   *
   * At 8% the worst case lands within 4% of the target and the ratios below can
   * be read straight off the plate.
   */
  for (let i = 0; i < 48 && lumOf(out) > target; i++) out = darken(out, 0.08);
  return out;
}

/**
 * Fallback skin, and the hue anchor for the shading — but **not** an anchor for
 * the base tone.
 *
 * This texture is not a decal floating in front of the head. `CharacterFactory`
 * wraps it onto a face plate that reaches 94% of the skull's half-width at the
 * eye line and runs from the crown to below the jaw, so the plate's outer margin
 * *is* the side of the head, sitting flush against bare skull. The two surfaces
 * share a material preset, a rim envelope and a shadow floor; the only thing
 * that can differ is albedo, and albedo is exactly what this file writes.
 *
 * `CharacterFactory.ALBEDO_BAND` therefore leaves `skin` unbanded on purpose:
 * *"the skull's flat vertex colour has to match the skin the face texture is
 * painted on exactly, or the plate's boundary shows as a patch on the cheek —
 * and the painter reads `palette.skin` raw."* So the base is the roster value,
 * byte for byte. The warm-pale target is honoured where it belongs: the *shadow*
 * is forced toward the rose-tan below rather than being a darkened copy.
 */
const SPEC_SKIN = 0xf7dcc4;
const SPEC_SKIN_SHADE = 0xe0a98f;

/**
 * The face's form shading — a soft gradient, and nothing that could be called a
 * band.
 *
 * The client's note is unambiguous: *"we added a heavy ink outline and hard cel
 * banding; the plate has neither"*, and the plates bear it out. Elvis's cheek in
 * `bravely01.jpg` moves from lit to shaded over roughly a third of the face
 * width with no edge anywhere along it; Adelle's frontal face in `bravely04.jpg`
 * has no terminator at all, only a warm settling under the cheekbones and along
 * the jaw. The previous implementation ran a 3%-wide cel edge in an elliptical
 * frame, which is a hard terminator by construction.
 *
 * What replaces it is two very low-amplitude gradients — one vertical (the lower
 * face settles warm), one at the temples — and then a **rim reconciliation**
 * that returns the texture to flat `palette.skin` before any feature is drawn.
 *
 * ### Why the reconciliation is structural rather than a matter of taste
 *
 * The face plate covers the whole front hemisphere of the skull, so the outer
 * ring of this texture lands on the temples, the crown and the underside of the
 * jaw — surfaces continuous with bare skull, shaded by the toon material and not
 * by the painter. Anything painted out there is a patch of paint on the side of
 * a head, and previous rounds shipped exactly that twice (a maroon patch on the
 * crown, a skin-tone wedge on the temple). **Outside `rimTo` the texture is flat
 * `palette.skin` and nothing else.**
 *
 * `halfW` / `halfH` mirror `Rig.computeMetrics`' `face.halfX / face.size` and
 * `face.halfY / face.size` (0.94 and 0.88 head-radii over a 1.90 head-radius
 * square), rounded *down* so this island is strictly inside the plate for any
 * retune of those numbers. They cannot be imported: `Rig` imports `FACE_LAYOUT`
 * from this file and the dependency must not become a cycle.
 *
 * `buildFacePlate` walks a superellipse of exponent 2.6 in that same frame, and
 * a superellipse strictly contains the ellipse with the same half-axes — so
 * bounding a mark here is a *proof* that it lands inside the plate.
 *
 * The reconciliation runs from `rimFrom` to `rimTo` and is drawn **before** the
 * features, which is what lets the eye pair sit at 0.82 of the plate radius
 * without the rim washing its outer corner back to skin.
 *
 * `rimTo` is 0.92, the same outer bound the previous cel band used, and it is
 * chosen against `Rig`'s `buryFrom`: past 0.92 of the plate radius the plate
 * dives inside the skull, so a mark out there is smeared across the dive. It is
 * also the clip the painted facial hair is bounded by — see `drawFacialHair`,
 * the one mark wide and low enough to reach it.
 */
const FORM = Object.freeze({
  halfW: 0.49, halfH: 0.46,
  rimFrom: 0.80, rimTo: 0.92,
});

/**
 * Hold the painted shading in a narrow window under the base skin.
 *
 * Both failure modes are on record: pinned at parity the face is "a uniform
 * orange disc with zero form", and carved dark it stops being an anime face at
 * all. 0.80–0.88 of the base luminance is a gradient a viewer reads as volume
 * and never as an edge — deliberately shallower than the 0.75–0.82 the old cel
 * band used, because a gradient needs less contrast than a band to read and more
 * contrast than this is what made the old one look like banding.
 */
function clampFormShade(hex, skin, lo = 0.80, hi = 0.88) {
  const base = lumOf(skin);
  let out = hex;
  for (let i = 0; i < 8 && lumOf(out) < base * lo; i++) out = mixHex(out, skin, 0.25);
  for (let i = 0; i < 8 && lumOf(out) > base * hi; i++) out = darken(out, 0.08);
  return out;
}

// ---------------------------------------------------------------- traits

/**
 * Turn a roster entry into the numbers the painter needs.
 *
 * `roundness` is a fallback dial only, used when the roster omits `eyeShape`:
 * a large `eye` multiplier and a gentle (positive) `browAngle` both push toward
 * round, which is exactly the intent those two fields already encode.
 *
 * NOTE on the brow sign: `roster.js`'s comment says positive = "outer end
 * lifted", but its data says positive = gentle (Seren +0.14, an oracle; Bramm
 * -0.26, a grieving smith), and the pipeline defines the shapes as "down-inner =
 * determined, up-inner = gentle". Data and pipeline agree, so the convention
 * here is **positive raises the inner end** and the roster's prose is wrong.
 */
export function faceTraits(def) {
  const p = def.proportions ?? {};
  const pal = def.palette ?? {};
  const eyeScale = clamp(p.eye ?? 1, 0.7, 1.4);
  const authoredAngle = p.browAngle ?? 0;
  const derivedRound = clamp01(0.5 + authoredAngle * 1.8 + (eyeScale - 1) * 1.6);
  const shape = pickEyeShape(p.eyeShape, derivedRound);
  const browStyle = pickBrowStyle(p.brow, authoredAngle);
  // The family fixes the construction; the authored numbers still nudge it, so
  // the two `sharp` characters (Auren at eye 0.96 / brow -0.10, Kite at 1.00 /
  // -0.16) do not come out as the same drawing.
  const round = clamp01(shape.round + (derivedRound - 0.5) * 0.24);
  const rng = new Rng(seedFor(def.id));
  const browAngle = authoredAngle * browStyle.gain + browStyle.tilt;

  const skin = (pal.skin ?? SPEC_SKIN) >>> 0;
  // The lash wants a tint toward the hair rather than pure #000 — but Seren's
  // and Emrys's hair shade is a *light* grey, and the naive mix lifts their lash
  // to a mid-grey that stops being the heaviest black in the face. Tint, then
  // force it back under a near-black luminance ceiling: the hue survives, the
  // weight is non-negotiable.
  const lash = ensureDarkerThan(
    mixHex(pal.lash ?? 0x14181f, pal.hairShade ?? 0x241f1c, 0.22), skin, 0.035,
  );

  const iris = pal.eye ?? 0x5fb8b0;
  /**
   * The four stops of the iris ramp, each forced under a fraction of the
   * character's own skin luminance.
   *
   * Adelle's iris in `bravely04.jpg`, read down column 336, runs rgb(47,57,108)
   * at its top to rgb(89,93,192) at its foot against skin at rgb(220,180,178).
   * In linear light that is **0.07 → 0.28 of the skin's luminance**, and the
   * *whole* of the hue's chroma lives in the bottom third: the top of a plate
   * iris is a near-black with a cast, the bottom is the only part that is
   * recognisably blue, brown or green.
   *
   * That shape is why the ramp gained a fourth stop. Three stops ending at 0.42
   * of skin gave a broad bright foot that at 90 px averaged with the sclera into
   * a pale disc — the "neon teal" the review named on Seren. Ending the ramp
   * proper at 0.24 and putting the chroma into a *bounce crescent* along the
   * iris's lower arc (`irisBounce`, 0.34) keeps the colour identifiable while
   * the disc as a whole stays a dark mark.
   *
   * Clamping against the character's own skin rather than against a constant is
   * what keeps the rule true for Kirella's dark skin as well as Seren's pale
   * one: the ratio is a contrast requirement, not a colour.
   *
   * `saturate` runs at 1.10–1.25 rather than the previous 1.20–1.45. The plate's
   * irises are *deep*, not vivid; pushing chroma before the luminance clamp only
   * makes the clamp work harder and comes back as a fluorescent rim.
   */
  const irisTop = ensureDarkerThan(mixHex(saturate(iris, 1.10), lash, 0.62), skin, 0.10);
  const irisMid = ensureDarkerThan(saturate(iris, 1.20), skin, 0.20);
  // The foot and the bounce take their hue from the roster's `eyeCore` where one
  // is authored — that field exists to say what the lit bottom of this
  // character's iris is made of — and only their *value* is overridden.
  const irisFoot = ensureDarkerThan(saturate(mixHex(iris, pal.eyeCore ?? iris, 0.35), 1.15), skin, 0.30);
  /**
   * The bounce crescent: the lit lower arc of the iris, and the one mark on the
   * face allowed to carry the character's eye colour at full chroma.
   *
   * It is a *crescent*, not a stop on the vertical ramp, because that is what
   * the plate draws — Adelle's brightest iris pixels form an arc inside her
   * lower rim, not a horizontal band — and because a crescent bounded by the
   * rim ring keeps its edge no matter how far the mip chain blurs it.
   */
  const irisBounce = ensureDarkerThan(saturate(mixHex(iris, pal.eyeCore ?? iris, 0.62), 1.25), skin, 0.44);
  // A 40% pull toward the spec rose guarantees the shading reads warm without
  // bleaching the darker-skinned half of the cast, then the value is pinned into
  // the form window relative to *their own* base rather than a universal one.
  const skinShade = clampFormShade(mixHex(pal.skinShade ?? SPEC_SKIN_SHADE, SPEC_SKIN_SHADE, 0.4), skin);

  const hairBase = pal.hair ?? 0x4a3d33;
  const facial = pickFacialHair(def);

  return {
    round,
    eyeScale,
    spacing: clamp(p.eyeSpacing ?? 1, 0.85, 1.2),
    browAngle,

    skin,
    skinShade,
    // A cool near-white ramp; the roster's per-character sclera only tints it, at
    // 0.12 rather than 0.25, because a warm white kills the cool-white read that
    // separates an anime eye from a plastic one.
    scleraTop: mixHex(0xf4f7fa, pal.sclera ?? 0xf2ede2, 0.12),
    scleraBottom: mixHex(0xe4eaf2, pal.sclera ?? 0xf2ede2, 0.12),
    iris,
    irisTop,
    irisMid,
    irisFoot,
    irisBounce,
    /**
     * The rim, and it now goes **all the way round**.
     *
     * The previous pass drew it across the lower arc only, reasoning that a full
     * ring merges with the lash bar under downsampling. That was true of a lash
     * bar at 0.30 of the ink height sitting on an iris that filled the whole
     * aperture; against this pass's 0.16–0.22 lash and a wide-aspect eye the
     * iris has clear sclera either side of it, and the ring is what makes the
     * disc read as a *disc* rather than as a stain. Adelle's is unmistakable —
     * a dark band a pixel wide around a 10 px iris.
     */
    irisRing: ensureDarkerThan(mixHex(irisTop, lash, 0.70), skin, 0.030),
    // Near-black. A pupil mixed back toward the iris hue reads as a warm brown
    // smudge that barely separates.
    pupil: mixHex(0x07090d, iris, 0.03),
    lash,
    // 0.14 rather than 0.32. The brow and the mouth are the two marks a viewer
    // reads a face's *expression* from at battle range, and both were sitting at
    // a third of the skin's luminance — visible on a flat canvas, and lifted
    // most of the way back to skin by the toon surface's diffuse wrap and rim
    // term once it is on a head. They are ink; ink is near-black.
    brow: ensureDarkerThan(mixHex(darken(hairBase, 0.30), 0x54263f, 0.20), skin, 0.11),
    /**
     * The mouth, and it is **warm, not ink**.
     *
     * Gloria's lip line in `bravely01.jpg` (y 423, x 656–661) is rgb(125,78,72)
     * against skin at rgb(208,181,188) — a red-brown at 0.22 of the skin's
     * linear luminance with an unmistakable rose cast. The published value was a
     * hair-derived near-black at 0.11, which is the "grey slit" the review
     * named: at that value the hue is gone and only the darkness reads.
     *
     * Mixing the hair family halfway to a deep rose keeps the character's own
     * colouring in the mark — a black-haired archer still gets a cooler mouth
     * than a chestnut-haired knight — while the clamp guarantees the value.
     */
    mouth: ensureDarkerThan(mixHex(darken(hairBase, 0.22), 0x7d3a34, 0.55), skin, 0.22),
    /** The filled body of the lips, between the ink line and the lit lower edge. */
    mouthFill: ensureDarkerThan(mixHex(skin, 0xb35347, 0.52), skin, 0.46),
    // The lit lower lip. The plates all show it — a warm, slightly desaturated
    // band directly under the lip line (Gloria y 424–425, rgb(190,146,137)) —
    // and it is what stops the mouth reading as a scratch.
    lip: mixHex(skin, 0xd2564e, 0.22),
    // The eyelid crease: a hair-tinted line at a fraction of the lash's weight.
    crease: mixHex(skin, lash, 0.34),

    // Shape dials from the eye-shape and brow families. The small jitter keeps
    // two characters sharing a family from looking rubber-stamped.
    aspect: shape.aspect,
    widen: shape.widen,
    lidSplit: shape.lidSplit,
    irisFill: shape.irisFill,
    creaseStrength: shape.crease,
    eyeTilt: shape.tilt + rng.jitter(0.015),   // outer corner up
    cornerDrop: shape.cornerDrop,              // outer corner sits below the inner
    lowerDepth: shape.lowerDepth,              // how deep the lower lid bows
    // 0.16–0.22 of the ink height. Adelle's lash is 2 rows on a 12-row eye
    // (0.17) and Gloria's 3 on 13 (0.23); the published 0.26–0.32 was a cap over
    // the aperture rather than a stroke along its edge, and it is most of why
    // the eye read as a black lens.
    lashWeight: shape.lash + rng.jitter(0.008),
    lashFlick: shape.flick,
    lashCount: shape.lashes,
    browThick: browStyle.thick,                // fraction of the square
    browArch: browStyle.arch + rng.jitter(0.04),
    browDrop: browStyle.drop,                  // toward the eye
    mouthCurveBias: browStyle.mouth,
    mouthWidthBias: browStyle.mouthW,
    highlightJitter: rng.jitter(0.05),

    /**
     * The cheek blush, as a **hue shift at held value**.
     *
     * Gloria's cheek is rgb(211,169,173) where her forehead is rgb(208,181,188):
     * the red channel is *up* by three and green and blue are down by twelve and
     * fifteen. That is a saturation move, not a shading move, and painting it as
     * a darkened skin tone — which is what `skinShade`-derived blooms do — puts a
     * grey-brown smudge on the cheekbone instead of colour in it.
     *
     * Strength and placement vary per character off the same seeded stream that
     * jitters the lashes, because four faces at battle distance are told apart
     * by their *large soft* marks long before their small sharp ones.
     */
    blush: mixHex(skin, mixHex(0xd8564e, pal.eye ?? 0xd8564e, 0.10), 0.34),
    blushStrength: 0.34 + rng.jitter(0.07),
    blushDrop: rng.jitter(0.012),
    /**
     * The colour the fringe's occlusion is painted in.
     *
     * A shadow cast by *hair* is not a shadow cast by nothing: it carries a
     * little of the hair's own hue by inter-reflection, which is why a blonde's
     * fringe shadow is golden and a black-haired character's is neutral. Mixing
     * 28% of the hair into the form shade is what makes the mark read as
     * occlusion rather than as a bruise, and the clamp keeps it a shadow (0.62
     * of skin) rather than the near-black an unclamped dark hair would give.
     */
    fringeShade: ensureDarkerThan(mixHex(skinShade, mixHex(hairBase, 0x8a5030, 0.55), 0.30), skin, 0.70),
    /**
     * The nose's shadow, and the one form shadow on the face allowed past the
     * `FORM` window.
     *
     * Everything else painted on this head is bounded to 0.80–0.88 of the skin's
     * luminance, because a face whose broad gradients go deeper acquires the cel
     * banding the client rejected. The nose is different in kind: it is a
     * *small* mark cast by a *small* form, so it can carry real contrast without
     * putting an edge anywhere a viewer reads as a terminator. At 0.52 of skin
     * with a red-brown cast it is a step deeper than Adelle's and Gloria's own
     * tips read, which is the toll the toon surface's diffuse wrap charges: it
     * lifts every midtone on the head, and a mark measured flat comes back a
     * third weaker once it is lit.
     */
    noseShade: ensureDarkerThan(mixHex(skinShade, 0x6b3a2c, 0.34), skin, 0.52),

    /**
     * Nose strength. Every face in every plate has one — the old build drew a
     * 0.02-wide dot and suppressed it entirely for `eye >= 1.05`, which is a
     * third of the cast. What actually varies with age is *contrast*: Elvis has
     * a bridge and a defined base, Adelle has a soft shadow and a lit ridge and
     * nothing else, so the small-eyed adults get more of it.
     *
     * The band is 0.34–0.80 rather than 0.16–0.62: the nose is a *shadow*, and a
     * shadow drawn at a sixth strength on a face that the toon surface then lifts
     * is not a shadow at all. Even the softest face in the party now has a base
     * mark a viewer can find at 90 px.
     *
     * What the strength no longer controls is *how many marks there are*. The
     * previous nose was a lit stripe, a wide base shadow and a pair of nostril
     * darkenings, and the nostrils are the mark that turned every chibi head in
     * the party into a piglet. See `drawNose`.
     */
    noseStrength: clamp(1.62 - eyeScale * 0.8, 0.34, 0.80),
    facial,
    facialColour: facial
      ? ensureDarkerThan(mixHex(hairBase, pal.hairShade ?? darken(hairBase, 0.4), 0.55), skin, 0.42)
      : 0,
    // The facial-hair boundary is a *shape*, so its irregularity may be sampled
    // once here and reused; a per-pixel perturbation would be surface noise,
    // which is forbidden outright.
    facialEdge: facial
      ? Array.from({ length: 9 }, () => 1 + rng.jitter(0.16))
      : null,
  };
}

// -------------------------------------------------------------- eye geometry

/**
 * The eye aperture, as an inner-corner → apex → outer-corner spine plus a lower
 * lid closing it. Authored in a local frame where the *outer* corner is +x, so
 * one set of numbers draws both eyes; the caller mirrors for the other side.
 *
 * `hu` and `hl` are separate upper and lower half-heights, which is what lets
 * `open` (a lid coming down from above) and `lidRaise` (a lower lid pushing up,
 * the "smiling eyes" of joy and determination) be independent without moving the
 * iris — the iris keeps its full-open size and is simply occluded more.
 */
function eyeGeometry(hw, hu, hl, t) {
  const inY = -hu * t.cornerDrop * 0.55;
  const outY = hl * t.cornerDrop;
  // Sharp eyes put the apex further inboard, which lengthens the outer half into
  // a taper; round eyes keep it near the middle for a dome.
  const apexX = -hw * (0.10 + 0.22 * (1 - t.round));
  const midY = hl * t.lowerDepth;
  return {
    inX: -hw, inY,
    outX: hw, outY,
    apexX, apexY: -hu,
    c0x: lerp(-hw, apexX, 0.40), c0y: -hu * 0.94,
    c1x: lerp(apexX, hw, 0.52), c1y: -hu * (0.86 + 0.14 * t.round),
    // Solve the quadratic's control so its midpoint lands exactly on the
    // intended lower-lid depth, rather than guessing at a control height.
    c2x: lerp(hw, -hw, 0.45), c2y: 2 * midY - 0.5 * (outY + inY),
  };
}

function quadAt(p0, c, p1, s) {
  const u = 1 - s;
  return u * u * p0 + 2 * u * s * c + s * s * p1;
}

/**
 * Sample the upper-lid spine. `s` ∈ [0,1] runs inner corner → outer corner;
 * `s` > 1 continues past the outer corner along the exit tangent, rotated
 * upward, which is the lash flick.
 */
function lidPoint(g, s, flickLen, out) {
  if (s <= 1) {
    if (s < 0.5) {
      const k = s / 0.5;
      out.x = quadAt(g.inX, g.c0x, g.apexX, k);
      out.y = quadAt(g.inY, g.c0y, g.apexY, k);
    } else {
      const k = (s - 0.5) / 0.5;
      out.x = quadAt(g.apexX, g.c1x, g.outX, k);
      out.y = quadAt(g.apexY, g.c1y, g.outY, k);
    }
    return out;
  }
  // Exit tangent of the second quad, lifted 20° so the flick kicks up.
  let tx = g.outX - g.c1x;
  let ty = g.outY - g.c1y;
  const len = Math.hypot(tx, ty) || 1;
  tx /= len; ty /= len;
  const ca = Math.cos(-0.35), sa = Math.sin(-0.35);
  const rx = tx * ca - ty * sa;
  const ry = tx * sa + ty * ca;
  const d = (s - 1) * flickLen;
  out.x = g.outX + rx * d;
  out.y = g.outY + ry * d;
  return out;
}

function lowerPoint(g, s, out) {
  out.x = quadAt(g.outX, g.c2x, g.inX, s);
  out.y = quadAt(g.outY, g.c2y, g.inY, s);
  return out;
}

/**
 * Emit a smooth path through sampled points: each segment is a quadratic with
 * the sample as its control and the midpoint of the next pair as its endpoint.
 * Straight `lineTo` chains facet visibly on a black bar this heavy; this costs
 * nothing and reads as a drawn curve.
 */
function smoothPath(ctx, pts, move = true) {
  if (pts.length < 2) return;
  if (move) ctx.moveTo(pts[0].x, pts[0].y);
  else ctx.lineTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) * 0.5;
    const my = (pts[i].y + pts[i + 1].y) * 0.5;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}

function samplePolyline(sample, s0, s1, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(sample(s0 + ((s1 - s0) * i) / n, { x: 0, y: 0 }));
  return pts;
}

/**
 * Build a tapered ribbon around a sampled spine: the shape every hand-drawn
 * stroke in this file is made of. `profile(u)` returns the thickness multiplier
 * at parameter u ∈ [0,1] along the sample list, and `above` splits the thickness
 * across the spine.
 */
function ribbon(ctx, spine, thickness, profile, above = 0.5) {
  const top = [];
  const bot = [];
  for (let i = 0; i < spine.length; i++) {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(spine.length - 1, i + 1)];
    let nx = b.y - a.y;
    let ny = -(b.x - a.x);
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    const th = thickness * profile(i / (spine.length - 1));
    top.push({ x: spine[i].x + nx * th * above, y: spine[i].y + ny * th * above });
    bot.push({ x: spine[i].x - nx * th * (1 - above), y: spine[i].y - ny * th * (1 - above) });
  }
  ctx.beginPath();
  smoothPath(ctx, top);
  bot.reverse();
  smoothPath(ctx, bot, false);
  ctx.closePath();
}

/**
 * The lash stroke's thickness profile along the spine.
 *
 * The weight is thrown to the **outer third**: 0.18 of full at the inner
 * corner, still under half at the apex, peaking at `s` 0.74 and only easing off
 * into the corner itself. The published profile peaked at 0.42 — just past the
 * apex, i.e. over the middle of the iris — which is a *cap*, and a cap over the
 * pupil is what a viewer reads as a closed eye.
 *
 * Both plates draw the other shape unambiguously: Adelle's lash is one row deep
 * where it leaves the tear duct and three where it meets the outer canthus, and
 * Gloria's thickens across the same span. It is the asymmetry, not the weight,
 * that gives an anime eye its direction.
 *
 * The tail past `s = 1` is the corner itself closing to a point; the flicks are
 * separate strokes (see `drawLashFlicks`), because a ribbon extension can only
 * ever produce one of them.
 */
function lashProfile(s, flick) {
  if (s <= 1) {
    // A cubic with its maximum at 0.74, floored so the inner corner keeps a
    // visible hairline rather than vanishing into the tear duct.
    const a = clamp01(s / 0.74);
    const rise = a * a * (3 - 2 * a);
    const fall = 1 - 0.30 * clamp01((s - 0.74) / 0.26) ** 2;
    return lerp(0.18, 1, rise) * fall;
  }
  const k = clamp01((s - 1) / Math.max(flick, 1e-3));
  return 0.70 * (1 - k) * (1 - k);
}

// ------------------------------------------------------------------ painting

/**
 * Every derived dimension of one eye, solved **once** for the whole face.
 *
 * A cross-eyed pair — two pupils at different heights — is the kind of defect
 * only a shared solve can make structurally impossible, so both eyes and both
 * brows read this one object and the mirroring downstream is a pure reflection
 * of it. Nothing per-side is derived anywhere else.
 *
 * The ink height is `eyeH` scaled by the roster; the ink width follows from the
 * family's `aspect` and is then trimmed to the plate; and the aperture is what
 * is left after the lash bar takes its share of the top.
 */
function eyeFrame(t, x, S) {
  /**
   * The solve runs **height first**.
   *
   * The previous pass took the width off the envelope and divided by the family
   * aspect, which makes the eye's height the residue of two other numbers. The
   * roster's `eye` multiplier spans 0.84–1.16 and the aspects spanned 1.55–2.45,
   * so Bramm's height came out at 0.089 of the square against Emrys' 0.194 — the
   * *same drawing* varying by a factor of 2.2 in the one dimension the review
   * measured as "too narrow to read".
   *
   * Solving height first makes the floor a property of the construction: every
   * character's ink height is `eyeH × sizeK` and nothing else touches it.
   *
   * `sizeK` compresses the roster's 0.84–1.16 to 0.928–1.072. The full range is
   * a legitimate identity signal on a 1024² canvas and is simply too wide a band
   * to sit above a legibility floor at 90 px; the halved range still separates
   * Emrys from Bramm by 15%, and the families carry the rest.
   */
  const sizeK = 1 + (t.eyeScale - 1) * 0.45;
  const inkH = FACE_LAYOUT.eyeH * sizeK * S;

  /**
   * The width is then **trimmed to fit the plate**, and the height never is.
   *
   * `eyeX`'s note works the reach out for the roster as it stands, but that is
   * an audit, not a guarantee: `eye` is clamped to 1.4 and `eyeSpacing` to 1.2,
   * and a future entry near those bounds reaches 0.43 of the texture — past
   * `Rig`'s 0.417 sampling limit, where the iris is simply not on the head. That
   * failure is invisible in a face sheet and obvious in a battle frame, which is
   * the worst combination a defect can have, so it is made unreachable here.
   *
   * Width is what gives, because height is what legibility is made of: a trimmed
   * eye is a slightly narrower almond, a shortened one is the slit this pass
   * exists to remove.
   */
  const inkW = Math.min(
    inkH * t.aspect * t.widen,
    2 * Math.max(PLATE_REACH * S - (0.5 - FACE_LAYOUT.eyeX) * t.spacing * S, inkH * 0.5),
  );
  const hw = inkW / 2;

  // The lash bar eats into the top of the ink, so the aperture is shorter than
  // the ink by the part of the bar that sits below the lid line.
  const lashTh = atLeast(inkH * t.lashWeight, MIN_PX.lash);
  const apH = Math.max(inkH - lashTh * 0.55, inkH * 0.5);
  const hu0 = apH * t.lidSplit;
  const hl0 = apH * (1 - t.lidSplit);
  const hu = hu0 * x.open;
  const hl = hl0 * (1 - x.lidRaise);

  /**
   * The iris is a **circle as tall as the aperture**.
   *
   * Measured off the luma dump at the top of this file: Gloria's iris block is
   * 13 × 11 px in an 11.5 px aperture, so the disc spans 0.96 of the aperture's
   * height and 0.68 of the ink's width. The previous build sized it at 0.56 of
   * the *width* — 0.44 of the aperture height on the narrow family — which is a
   * small coloured bead in a field of sclera, and a field of sclera is what
   * averages to skin.
   *
   * Sizing off the height and letting the aperture's own aspect decide the width
   * coverage is also what keeps the white canthal wedges without authoring them:
   * the lids meet at both corners, so a disc that exactly fills the middle
   * leaves a triangle of sclera at each end whatever the family is doing.
   *
   * The radius comes off the *full-open* aperture, so a squint occludes the iris
   * instead of shrinking it.
   */
  const irisR = 0.5 * (hu0 + hl0) * t.irisFill;

  /**
   * Iris centre, solved in the *unrotated* frame so that after the eye's tilt it
   * lands exactly on the eye's centre line. Both eyes therefore put their pupil
   * on the same texture row by construction, at any tilt, for any shape family.
   *
   * The small inboard offset survives because the plate is curved and a pupil
   * dead-centre on a face shield reads as walleyed from the battle camera's
   * three-quarter angle; it is applied along the eye's own axis only.
   */
  const inboard = -hw * 0.03;
  const ca = Math.cos(t.eyeTilt);
  const sa = Math.sin(t.eyeTilt);
  return {
    inkW, inkH, hw, hu0, hl0, hu, hl, lashTh, irisR,
    ix: inboard * ca, iy: inboard * sa,
    flickLen: hw * t.lashFlick * 2,
  };
}

/**
 * The topmost texture row the eye's ink reaches, relative to the eye centre and
 * *after* the tilt — i.e. the top of the drawn lash bar, which is what a viewer
 * reads as "the top of the eye" and therefore what the brow must be spaced from.
 * Negative, because +y is down.
 */
function eyeInkTop(t, x, S, f = eyeFrame(t, x, S)) {
  const g = eyeGeometry(f.hw, f.hu, f.hl, t);
  const ca = Math.cos(t.eyeTilt);
  const sa = Math.sin(t.eyeTilt);
  const p = { x: 0, y: 0 };
  let top = 0;
  for (let i = 0; i <= 16; i++) {
    const s = i / 16;
    lidPoint(g, s, f.flickLen, p);
    // Rotation by -eyeTilt, then the bar's own upper half-thickness.
    const y = -p.x * sa + p.y * ca - f.lashTh * 0.42 * lashProfile(s, t.lashFlick);
    if (y < top) top = y;
  }
  return top;
}

/**
 * The lash flicks: two or three separate tapered spikes off the outer corner.
 *
 * Drawn as their own shapes rather than as an extension of the lash ribbon,
 * because a ribbon has one end and the plate has several — Adelle carries three
 * fine spikes off her outer canthus at slightly different rakes, and a single
 * thickened ribbon tail is the mark that reads as an eyeliner wing instead.
 *
 * Each spike leaves the lid's exit tangent at its own angle and length, so the
 * fan spreads; the innermost is the longest and the heaviest, which is what a
 * clump of lashes actually does.
 */
function drawLashFlicks(ctx, g, t, f) {
  const n = t.lashCount;
  if (n < 1 || f.flickLen <= 0) return;

  // Exit tangent of the upper lid's outer quadratic, in the eye's mirrored
  // frame, so a flick always leaves the corner along the stroke it belongs to.
  let tx = g.outX - g.c1x;
  let ty = g.outY - g.c1y;
  const len = Math.hypot(tx, ty) || 1;
  tx /= len; ty /= len;

  ctx.fillStyle = cssHex(t.lash);
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0 : i / (n - 1);
    // Rake: the first spike continues the lid almost straight, the last kicks
    // up hardest. Negative angles rotate upward in a y-down frame. The spread is
    // deliberately narrow — 0.14 rad between neighbours — because a wide fan
    // stops reading as lashes and starts reading as an insect's leg.
    const ang = -0.14 - 0.28 * k;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const dx = tx * ca - ty * sa;
    const dy = tx * sa + ty * ca;
    // The fan starts well inside the corner so the spikes grow *out of* the
    // stroke's own mass rather than being glued to its end. Rooting them at the
    // corner leaves a visible hinge at every join.
    const back = f.hw * 0.16 * (0.4 + k);
    const ox = g.outX - tx * back;
    const oy = g.outY - ty * back;
    const l = f.flickLen * (1.0 - 0.30 * k);
    const w = atLeast(f.lashTh * (0.62 - 0.16 * k), MIN_PX.ring);
    // A three-point spike: two points on the root's normal, one at the tip.
    ctx.beginPath();
    ctx.moveTo(ox - dy * w * 0.5, oy + dx * w * 0.5);
    ctx.quadraticCurveTo(ox + dx * l * 0.55 - dy * w * 0.30,
      oy + dy * l * 0.55 + dx * w * 0.30, ox + dx * l, oy + dy * l);
    ctx.quadraticCurveTo(ox + dx * l * 0.5 + dy * w * 0.34,
      oy + dy * l * 0.5 - dx * w * 0.34, ox + dy * w * 0.5, oy - dx * w * 0.5);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * One eye, drawn back to front. Called with the context already translated to
 * the eye centre and mirrored so that +x points at the outer corner.
 *
 * `side` is that mirror's sign (+1 for the character's screen-right eye), and it
 * exists for the two glints, which must land on the same *screen* side of both
 * irises because there is one key light. See steps 8 and 9.
 *
 * ## What is different from the previous construction
 *
 * The old eye was a gradient-filled disc, a lower-arc rim, a pupil and one white
 * dot inside a heavy black cap. The plate's is six marks, and at 12 px across —
 * the size Adelle's is *printed* at in `bravely04.jpg` — all six are legible:
 * a rim all the way round the iris, a two-tone vertical ramp inside it, a
 * chroma-carrying bounce crescent along its foot, a pupil at a third of its
 * radius, a hard key glint high on the lit side and a small counter-glint low on
 * the other. Nothing here is a tuning of the old shape; the iris is rebuilt.
 */
function drawEye(ctx, t, x, f, side) {
  // The whole eye rotates: outer corner up. Tilt is one of the strongest
  // identity channels an anime face has.
  ctx.save();
  ctx.rotate(-t.eyeTilt);

  const { hw, hu, hl, flickLen, irisR, ix, iy } = f;
  const g = eyeGeometry(hw, hu, hl, t);

  // The aperture, reused as a clip for every layer that must not spill onto skin.
  const aperture = () => {
    ctx.beginPath();
    smoothPath(ctx, samplePolyline((s, o) => lidPoint(g, s, flickLen, o), 0, 1, 18));
    smoothPath(ctx, samplePolyline((s, o) => lowerPoint(g, s, o), 0, 1, 14), false);
    ctx.closePath();
  };

  // The iris disc, reused as a clip so the bounce crescent and the ramp cannot
  // leak past the rim. Solved once: every mark inside the eye is registered to
  // this circle and nothing re-derives it.
  const irisDisc = () => {
    ctx.beginPath();
    ctx.arc(ix, iy, irisR, 0, Math.PI * 2);
  };

  ctx.save();
  aperture();
  ctx.clip();

  // 1 — sclera. Cool at the top, where the lash's cast shadow would sit.
  const sc = ctx.createLinearGradient(0, -hu, 0, hl);
  sc.addColorStop(0, cssHex(t.scleraTop));
  sc.addColorStop(1, cssHex(t.scleraBottom));
  ctx.fillStyle = sc;
  ctx.fillRect(-hw * 1.6, -hw * 1.8, hw * 3.2, hw * 3.6);

  /**
   * 2 — the lash's cast shadow, across the top of the *whole* aperture rather
   * than only across the iris.
   *
   * Both plates show it: the sclera immediately under the upper lid is
   * appreciably darker than the sclera at the lower lid, and the canthal wedge
   * only reaches its full brightness at the outer corner. Without it the white
   * that this pass's wider eye newly exposes glares, and the eye acquires the
   * "wide awake" look the previous, iris-filled construction did not have.
   */
  const cast = ctx.createLinearGradient(0, -hu, 0, -hu + (hu + hl) * 0.62);
  cast.addColorStop(0, cssRgba(t.lash, 0.42));
  cast.addColorStop(1, cssRgba(t.lash, 0));
  ctx.fillStyle = cast;
  ctx.fillRect(-hw * 1.6, -hw * 1.8, hw * 3.2, hw * 3.6);

  // 3 — the iris body: a two-tone vertical ramp, dark above and lit below.
  //
  // Two tones, not three: Adelle's column reads near-black for the top half and
  // then opens out, so the transition wants to be short and low rather than a
  // smooth sweep from top to bottom. The stops sit at 0.30 and 0.68 of the disc.
  const ig = ctx.createLinearGradient(0, iy - irisR, 0, iy + irisR);
  ig.addColorStop(0, cssHex(t.irisTop));
  ig.addColorStop(0.30, cssHex(t.irisTop));
  ig.addColorStop(0.68, cssHex(t.irisMid));
  ig.addColorStop(1, cssHex(t.irisFoot));
  ctx.fillStyle = ig;
  irisDisc();
  ctx.fill();

  // 4 — the bounce crescent: the iris's lit lower arc, and the only mark on the
  // face carrying the character's eye colour at full chroma. Clipped to the disc
  // and drawn as a second circle pushed up and out, which is what produces a
  // crescent that thickens toward the bottom rim without a path to author.
  ctx.save();
  irisDisc();
  ctx.clip();
  const bounceR = irisR * 0.96;
  const bg = ctx.createRadialGradient(ix, iy + irisR * 0.62, 0, ix, iy + irisR * 0.62, bounceR);
  bg.addColorStop(0, cssRgba(t.irisBounce, 0.95));
  bg.addColorStop(0.62, cssRgba(t.irisBounce, 0.55));
  bg.addColorStop(1, cssRgba(t.irisBounce, 0));
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(ix, iy + irisR * 0.34, bounceR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 5 — the rim, all the way round. See `traits.irisRing` for why it is no
  // longer a lower arc: at this aspect the iris has sclera either side of it,
  // and an unclosed ring reads as a smear rather than as an edge.
  const ringW = atLeast(irisR * 0.15, MIN_PX.ring);
  ctx.strokeStyle = cssHex(t.irisRing);
  ctx.lineWidth = ringW;
  ctx.beginPath();
  ctx.arc(ix, iy, irisR - ringW * 0.5, 0, Math.PI * 2);
  ctx.stroke();

  /**
   * 6 — the pupil, at a **third** of the iris radius rather than 0.42 of it.
   *
   * The previous pupil was drawn large on the reasoning that a small one filters
   * away, and against an iris that was itself near-black the pair fused into one
   * hole. With the ramp now opening to 0.30 of skin at its foot and a bounce
   * crescent at 0.44, the pupil has something to be dark *against*, and it is
   * the separation rather than the size that makes it read.
   *
   * The soft halo under it is the plate's: Adelle's pupil does not have a hard
   * edge at the bottom, it dissolves into the iris shadow above the bounce.
   */
  const pupilR = atLeast(irisR * 0.34 * x.pupil, MIN_PX.pupil);
  const halo = ctx.createRadialGradient(ix, iy, pupilR * 0.7, ix, iy, pupilR * 2.1);
  halo.addColorStop(0, cssRgba(t.pupil, 0.55));
  halo.addColorStop(1, cssRgba(t.pupil, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(ix, iy, pupilR * 2.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = cssHex(t.pupil);
  ctx.beginPath();
  ctx.ellipse(ix, iy, pupilR, Math.min(pupilR * 1.14, irisR * 0.82), 0, 0, Math.PI * 2);
  ctx.fill();

  // 7 — lower lid: a thin warm line along the outer half only, far lighter than
  // the lash stroke, which is what keeps it a lid rather than an eye bag.
  ctx.strokeStyle = cssRgba(mixHex(t.lash, t.skinShade, 0.42), 0.85);
  ctx.lineWidth = atLeast(f.inkH * 0.07, MIN_PX.lid);
  ctx.lineCap = 'round';
  ctx.beginPath();
  smoothPath(ctx, samplePolyline((s, o) => lowerPoint(g, s, o), 0.04, 0.52, 10));
  ctx.stroke();

  /**
   * 8 — the key glint. **One**, hard-edged, pure white, high on the lit side.
   *
   * `side` undoes the eye's mirror for this mark alone, so both glints sit on
   * the screen-left of their iris. Authoring it in the mirrored frame — which is
   * what an earlier pass did — lights the two eyes from opposite sides, and a
   * viewer reads that not as two highlights but as none.
   *
   * It is placed against the **visible aperture**, not against the iris: the
   * iris nearly fills the aperture's height, so a mark parked at a fixed
   * fraction of the iris radius sits under the lash. Solving for the first row
   * the lash does not cover, then clamping the disc inside the iris, lands it in
   * the same quadrant on every face however narrow the family is.
   */
  const visTop = -hu + f.lashTh * 0.55;
  const bigR = atLeast(irisR * 0.30, MIN_PX.highlight);
  const bigX = clamp(ix - side * irisR * (0.36 + t.highlightJitter),
    ix - irisR + bigR * 1.15, ix + irisR - bigR * 1.15);
  const bigY = Math.max(iy - irisR * 0.36, visTop + bigR * 1.05);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  // Pure, not tinted. The glint is the only pixel on the face allowed to be
  // brighter than the sclera, and the sclera is already a cool near-white; a
  // "slightly cool white" highlight on top of it is the same colour twice.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(bigX, bigY, bigR, 0, Math.PI * 2);
  ctx.fill();

  /**
   * 9 — the counter-glint: small, low, on the **opposite** side of the pupil,
   * and slightly cool rather than pure.
   *
   * This is the mark that separates a painted iris from a sphere with a sticker
   * on it. Every plate face has it — Adelle's is a pale wedge inside her lower
   * rim, diagonally opposite the key glint — and it is what tells the viewer the
   * eye is a transparent dome with light coming back off its far wall. It is
   * deliberately about a third the key's radius and held under full white, so it
   * reads as bounce and never competes for the highlight.
   */
  const smallR = atLeast(irisR * 0.13, MIN_PX.spark);
  const smallX = clamp(ix + side * irisR * 0.40,
    ix - irisR + smallR * 1.4, ix + irisR - smallR * 1.4);
  const smallY = Math.min(iy + irisR * 0.44, hl - smallR * 1.2);
  ctx.fillStyle = cssRgba(mixHex(0xffffff, t.scleraTop, 0.35), 0.92);
  ctx.beginPath();
  ctx.arc(smallX, smallY, smallR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 10 — the upper lash, deliberately *outside* the clip: it has to overhang the
  // outer corner, and it is the heaviest black in the face. Weighted to the
  // outer third — see `lashProfile`.
  const spine = samplePolyline((s, o) => lidPoint(g, s, flickLen, o), 0, 1, 26);
  ctx.fillStyle = cssHex(t.lash);
  // Straddling the lid line — 42% above, 58% below — keeps the ink weight while
  // leaving the white. Dropping the stroke into the aperture instead is what
  // used to make a lash specified at a fifth of the eye height eat half of it.
  ribbon(ctx, spine, f.lashTh, (u) => lashProfile(u, t.lashFlick), 0.42);
  ctx.fill();

  // 11 — the flicks, as their own fan of spikes.
  drawLashFlicks(ctx, g, t, f);

  // 12 — the eyelid crease. Elvis has an unmistakable one in `bravely01.jpg`: a
  // fine warm line a couple of pixels above the lash, following it and dying
  // before the inner corner. It is what makes an adult eye read as an adult eye,
  // and the round-eyed children correctly have none (`crease` 0).
  if (t.creaseStrength > 0.02) {
    // Offset in units of the *ink height* rather than of the lash thickness.
    // Tying it to the lash meant a family with a fine lash got its crease
    // printed inside its own lash bar; the clearance a crease needs is a
    // property of the eye, not of the stroke that bounds it.
    const creaseSpine = samplePolyline((s, o) => {
      lidPoint(g, s, flickLen, o);
      o.y -= f.lashTh * 0.5 + f.inkH * 0.13;
      return o;
    }, 0.30, 0.98, 12);
    ctx.fillStyle = cssRgba(t.crease, 0.55 * t.creaseStrength + 0.25);
    ribbon(ctx, creaseSpine, atLeast(f.lashTh * 0.30, MIN_PX.crease),
      (u) => Math.sin(clamp01(u) * Math.PI) * 0.7 + 0.3);
    ctx.fill();
  }

  ctx.restore();
}


/**
 * The brow outline: two offset quadratics, so the taper is real — a
 * constant-width brow reads as a marker mark.
 *
 * Authored in the same mirrored frame as the eye (-x is the inner end) and
 * returned rather than drawn, because the *placement* has to know the shape: a
 * brow's angle, arch and thickness move its lowest ink by an appreciable
 * fraction of the eye between families and expressions, and spacing the spine
 * therefore spaces something the viewer cannot see.
 *
 * The whole shape is pushed **inboard** by `browShift`. In the plates the brow
 * begins well inside the eye's inner corner and dies at or just past the outer
 * one; centring a brow on the eye is what made the old ones read as decals.
 *
 * ## The taper runs both ways now
 *
 * The published outline was 0.46 of the thickness at the inner end, 0.42 at the
 * arch and 0.05 at the outer — a wedge, blunt where it starts and pointed where
 * it ends. Both plates draw a brow that comes to a point at *both* ends and
 * carries its weight over the middle: Adelle's is one row at the tear duct, two
 * over the arch and one again as it dies past her outer canthus.
 *
 * The difference is not cosmetic at battle range. A blunt inner end on a brow
 * that also angles down-inboard is a black triangle pointing at the nose, and
 * on the two `hard`-browed characters the pair of them read as a scowl painted
 * across the bridge — which is exactly what "bar brows" describes.
 */
function browOutline(t, x, f, S) {
  const bw = f.inkW * FACE_LAYOUT.browW;
  // A fraction of the face, taken up a little on the larger-eyed faces: a child's
  // brow is finer in absolute terms but not by the full ratio of the eyes.
  const th = atLeast(t.browThick * Math.sqrt(t.eyeScale) * S * x.browThick, MIN_PX.brow);
  const shift = -f.inkW * FACE_LAYOUT.browShift;
  // Positive angle raises the inner end (see the sign note in `faceTraits`).
  const ang = t.browAngle + x.browTilt;
  const inX = shift - bw / 2;
  const outX = shift + bw / 2;
  const inY = -ang * bw * 0.55;
  const outY = ang * bw * 0.28;
  // The arch is a fraction of the brow's **length**, not of its thickness. Tying
  // it to the thickness meant halving the weight halved the curvature too, and a
  // fine straight brow is a pencil line — the arch is what makes it a brow.
  const arch = -t.browArch * bw * 0.075;
  const cx = lerp(inX, outX, 0.44);
  const cy = lerp(inY, outY, 0.44) + arch;

  const norm = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const l = Math.hypot(dx, dy) || 1;
    return { x: dy / l, y: -dx / l };
  };
  const nIn = norm(inX, inY, cx, cy);
  const nMid = norm(inX, inY, outX, outY);
  const nOut = norm(cx, cy, outX, outY);
  const tIn = th * 0.12;
  const tMid = th * 0.50;
  const tOut = th * 0.05;

  return {
    a: { x: inX + nIn.x * tIn, y: inY + nIn.y * tIn },
    b: { x: cx + nMid.x * tMid, y: cy + nMid.y * tMid },
    c: { x: outX + nOut.x * tOut, y: outY + nOut.y * tOut },
    d: { x: outX - nOut.x * tOut, y: outY - nOut.y * tOut },
    e: { x: cx - nMid.x * tMid, y: cy - nMid.y * tMid },
    f: { x: inX - nIn.x * tIn, y: inY - nIn.y * tIn },
  };
}

/**
 * How far the brow's ink reaches *below* its origin, after the tilt.
 *
 * A quadratic is contained in the convex hull of its endpoints and control, so
 * the six outline points bound the shape exactly — no sampling and no slack.
 */
function browDrop(t, x, f, S) {
  const o = browOutline(t, x, f, S);
  const ca = Math.cos(-t.eyeTilt * 0.6);
  const sa = Math.sin(-t.eyeTilt * 0.6);
  let low = -Infinity;
  for (const p of [o.a, o.b, o.c, o.d, o.e, o.f]) {
    const y = p.x * sa + p.y * ca;
    if (y > low) low = y;
  }
  return low;
}

/** Fill the outline from `browOutline` at the current origin. */
function drawBrow(ctx, t, x, f, S) {
  // The brow follows the eye's tilt at reduced gain: locking it level while the
  // eye rakes reads as a mistake, matching it exactly reads as a decal.
  ctx.save();
  ctx.rotate(-t.eyeTilt * 0.6);
  const o = browOutline(t, x, f, S);
  ctx.fillStyle = cssHex(t.brow);
  ctx.beginPath();
  ctx.moveTo(o.a.x, o.a.y);
  ctx.quadraticCurveTo(o.b.x, o.b.y, o.c.x, o.c.y);
  ctx.lineTo(o.d.x, o.d.y);
  ctx.quadraticCurveTo(o.e.x, o.e.y, o.f.x, o.f.y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * The nose: a **V of shadow and one lit dot**, and nothing else.
 *
 * The previous construction was a lit vertical ridge, a wide elliptical base
 * shadow and a pair of nostril darkenings. Every one of those marks is defensible
 * on an anatomy chart and the combination is a snout: two dark dots side by side
 * under a pale stripe is the single most literal way to draw a pig, and at the
 * battle camera's ~90 px head that is what six faces in this party read as.
 *
 * What the plates actually have is smaller and simpler. Adelle's nose in
 * `bravely04.jpg` is one faint chevron of shade about six pixels across with a
 * lit point above it and no nostrils at all — three or four pixels of tonal
 * information total. Gloria's is the same mark with slightly more contrast.
 * There is no bridge, no ridge and no outline; the shadow's own asymmetry
 * (deeper on the shaded side, since the key is from screen-left) is what makes
 * the form turn.
 *
 * So this draws:
 *
 *  1. a soft **V tick** — two overlapping wedges meeting under the tip, the
 *     screen-right one carrying more of the value because that is the shaded
 *     side under a screen-left key;
 *  2. a single small **highlight dot** on the tip directly above it.
 *
 * The V is a *shape*, not a pair of dots: its two arms are joined at the bottom,
 * so however far the mip chain blurs it, it filters toward one mark rather than
 * separating into two.
 */
function drawNose(ctx, t, S, f) {
  const k = t.noseStrength;
  const y = FACE_LAYOUT.noseY * S;
  const cx = S * 0.5;
  // 0.34 of an eye width, i.e. 0.075 of the square. Adelle's tick is 6 px on a
  // 71 px face (0.085 of it) and Gloria's 8 on 54 at three-quarters; a nose that
  // scales with the eye keeps the small-eyed adults from acquiring a button.
  const w = Math.max(f.inkW * 0.40, MIN_PX.nose * 2.2);
  const h = w * 0.78;
  const th = Math.max(w * 0.26, MIN_PX.nose);

  /**
   * 1 — the V. Two tapered arms meeting under the tip, built as one closed path
   * as one closed chevron, so the mark filters toward one shape rather than
   * separating into a pair of nostrils as the mip chain halves it.
   *
   * The arms are **straight and steep**. A first attempt curved them with the
   * concave side up, which at any distance is a smile: the mark sat exactly
   * where a small mouth would and the real mouth 0.09 below it read as a chin
   * crease. Straight arms converging on a point have no other reading.
   *
   * The screen-right arm carries 1.0 of the weight and the screen-left 0.6,
   * because the key light is screen-left everywhere in this file (see the eye's
   * glint), and an asymmetric shadow is the only thing here that says the form
   * casting it has a direction.
   */
  ctx.save();
  const halfW = w * 0.5;
  const apexY = y + th * 0.30;
  const tip = th * 0.35;
  ctx.beginPath();
  ctx.moveTo(cx - halfW, y - h);
  ctx.lineTo(cx, apexY);
  ctx.lineTo(cx + halfW, y - h);
  ctx.lineTo(cx + halfW - tip, y - h);
  ctx.lineTo(cx, apexY - th * 1.30);
  ctx.lineTo(cx - halfW + tip, y - h);
  ctx.closePath();
  ctx.clip();
  // Deepest at the join and fading up both arms, which is where a nose's own
  // occlusion is deepest and why the mark needs no outline.
  const vg = ctx.createRadialGradient(cx, y, 0, cx, y, w * 0.78);
  // `noseShade` rather than `skinShade`. The form shade is clamped to 0.80–0.88
  // of the skin's luminance by `FORM` — a 15% value drop at *full* alpha — and a
  // 15% drop over a mark this small is what the review could not find. The nose
  // is the one place on the face where the shadow is allowed to be a real
  // shadow, because it is the only place with a form small enough to cast one.
  vg.addColorStop(0, cssRgba(t.noseShade, Math.min(1, 0.66 + 0.34 * k)));
  vg.addColorStop(0.55, cssRgba(t.noseShade, 0.44 + 0.30 * k));
  vg.addColorStop(1, cssRgba(t.noseShade, 0.10 * k));
  ctx.fillStyle = vg;
  ctx.fillRect(cx - w, y - h * 1.4, w * 2, h * 2.2);
  // The screen-left arm is lifted back toward skin, so the pair is lit rather
  // than symmetric. Erasing the built shape is cheaper and steadier than
  // drawing two gradients that have to agree along their shared join.
  const lit = ctx.createLinearGradient(cx - w * 0.5, 0, cx + w * 0.1, 0);
  lit.addColorStop(0, cssRgba(t.skin, 0.42));
  lit.addColorStop(1, cssRgba(t.skin, 0));
  ctx.fillStyle = lit;
  ctx.fillRect(cx - w, y - h * 1.4, w * 2, h * 2.2);
  ctx.restore();

  // 2 — the highlight on the tip, immediately above the V's join. One dot, warm
  // white, and small: this is the mark that says the shadow below it belongs to
  // something that sticks out, and any bigger it reads as a shine on a ball.
  const hx = cx - w * 0.10;
  const hy = y - h * 0.42;
  const hr = Math.max(w * 0.22, MIN_PX.nose * 0.5);
  const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, hr);
  hg.addColorStop(0, cssRgba(0xfff4e8, 0.13 + 0.15 * k));
  hg.addColorStop(1, cssRgba(0xfff4e8, 0));
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.ellipse(hx, hy, hr, hr * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * The mouth: a small **tinted shape** with a darker line through it.
 *
 * The published mouth was one near-black stroke over a faint warm ribbon, and
 * the review called it a grey slit — correctly, because at 0.11 of the skin's
 * luminance a hair-derived ink has no hue left in it and the mark is pure value.
 *
 * Gloria's mouth in `bravely01.jpg`, sampled across y 420–425 at x 645–672, is
 * three bands and all three are *warm*:
 *
 * ```
 *   y 421   b6938d  bb928c  b68b85  b38882   ← upper lip, skin pulled toward rose
 *   y 423   ac8580  936861  936660  8e615b  845751  7d4e48   ← the line itself
 *   y 425   b18a85  bf9990  bf978d  bd958b   ← the lit lower lip
 * ```
 *
 * The line bottoms out at rgb(125,78,72) against skin at rgb(208,181,188): 0.22
 * of the skin's linear luminance with a red-brown cast, sitting inside a *body*
 * of tinted lip that is itself a few percent under the surrounding skin. So the
 * construction is body first, then line, then the lit lower edge — three marks,
 * where the previous pass drew two and made the wrong one the darkest.
 *
 * The pipeline prose forbids "lips, teeth, an outlined opening". The images
 * disagree on the lips — they are plainly there on all four faces — so the lips
 * are drawn and the teeth are not.
 */
function drawMouth(ctx, t, x, S, f) {
  // Width and curvature carry the same personality the brow does, so the six
  // mouths are not one stamp at six hues.
  const w = FACE_LAYOUT.mouthW * S * x.mouthWidth * t.mouthWidthBias;
  const y = FACE_LAYOUT.mouthY * S;
  const c = (x.mouthCurve + t.mouthCurveBias) * S;
  const cx = S * 0.5;
  // The *line*'s thickness. 0.016 of the square rather than 0.022: the weight
  // that used to be carried by a thick stroke is now carried by the tinted body
  // around it, and a fine line inside a soft shape is what a drawn mouth is.
  const th = atLeast(S * 0.016, MIN_PX.mouth);

  const spine = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    spine.push({
      x: lerp(cx - w / 2, cx + w / 2, s),
      // A quadratic through the corners with the control at 2× the sag, so the
      // curve's own midpoint lands exactly on the authored curvature.
      y: quadAt(y, y + c * 2, y, s),
    });
  }

  // 1 — the body of the lips: a soft tinted lozenge straddling the line, wider
  // than it and reaching further below than above (the lower lip is the fuller
  // of the two on every plate face). It is a *hue* mark held near skin value, so
  // it never competes with the line for darkness.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, y + c * 0.5 + th * 0.30, w * 0.56, th * 1.30, 0, 0, Math.PI * 2);
  ctx.clip();
  const body = ctx.createLinearGradient(0, y + c * 0.5 - th * 1.3, 0, y + c * 0.5 + th * 1.6);
  body.addColorStop(0, cssRgba(t.mouthFill, 0.10));
  body.addColorStop(0.45, cssRgba(t.mouthFill, 0.46));
  body.addColorStop(1, cssRgba(t.mouthFill, 0.08));
  ctx.fillStyle = body;
  ctx.fillRect(cx - w, y - th * 4, w * 2, th * 8);
  ctx.restore();

  // 2 — the lit lower lip, over the body and under the line. Offset by a little
  // over the line's own thickness and slightly narrower, which is the
  // relationship the plates show.
  const lip = spine.map((p) => ({ x: cx + (p.x - cx) * 0.74, y: p.y + th * 1.05 }));
  ctx.fillStyle = cssRgba(t.lip, 0.58);
  ribbon(ctx, lip, th * 0.85, (u) => Math.sin(clamp01(u) * Math.PI) ** 0.7);
  ctx.fill();

  // 3 — the line: the interior of the mouth, and the darkest mark below the
  // eyes. Heaviest in the middle, tapering to a point at both corners, and a
  // touch heavier below the spine than above because the upper lip's edge is the
  // sharper of the two.
  ctx.fillStyle = cssHex(t.mouth);
  ribbon(ctx, spine, th, (u) => 0.05 + 0.95 * Math.sin(clamp01(u) * Math.PI) ** 1.05, 0.42);
  ctx.fill();

  // An open mouth is a darker lens under the line, never an outlined hole.
  if (x.mouthOpen > 0.01) {
    const openH = th * 3.0 * x.mouthOpen;
    ctx.fillStyle = cssRgba(darken(t.mouth, 0.30), 0.80);
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.34, y + c * 0.5);
    ctx.quadraticCurveTo(cx, y + c * 0.5 + openH * 2, cx + w * 0.34, y + c * 0.5);
    ctx.quadraticCurveTo(cx, y + c * 0.5 + openH * 0.4, cx - w * 0.34, y + c * 0.5);
    ctx.closePath();
    ctx.fill();
  }
}

/**
 * Painted facial hair.
 *
 * Elvis's beard in `bravely01.jpg` is a *field*, not a shape: a desaturated
 * grey-brown roughly 45% darker than his skin, laid over the moustache strip and
 * the whole jaw at around 60% coverage, with a soft irregular upper boundary and
 * no outline of any kind. Painting it here rather than modelling it is what lets
 * a bearded character keep a readable mouth and jawline — the 3D beard in
 * `roster.hair` starts at the chin and says nothing about the face above it.
 *
 * The irregular boundary is built from a handful of seeded radii sampled once in
 * `faceTraits`. That is a *shape* perturbation, drawn as one filled path; it is
 * not surface noise, which is forbidden on a character outright.
 */
function drawFacialHair(ctx, t, S, f) {
  const fh = t.facial;
  const edge = t.facialEdge;
  const cx = S * 0.5;
  const mouthY = FACE_LAYOUT.mouthY * S;
  const noseY = FACE_LAYOUT.noseY * S;
  const gap = mouthY - noseY;
  // The beard spans the *jaw*, not the mouth. Elvis's runs the full width of his
  // face and up past the corner of the eye into the sideburn; sizing it off the
  // eye pair rather than off the mouth is what keeps it a beard instead of a
  // painted-on rectangle around the chin.
  const halfW = S * 0.34;

  ctx.save();

  if (fh.jaw > 0.01 || fh.chin > 0.01) {
    // The jaw mass, used as a clip. Bounding the field by the jaw rather than by
    // the drawn boundary is what keeps it a beard: a free path has to invent a
    // silhouette for the chin, and every attempt at one came out as a crescent
    // hung across the face.
    ctx.save();
    /**
     * The jaw mass, used as a clip — a **tall** lens seated low, not the wide
     * flat one this used to be.
     *
     * At `cy` 0.825 with a 0.135 half-height the clip was a horizontal lens
     * whose own upper arc, intersected with a growth boundary that climbs toward
     * the sideburns, produced a crescent: a smooth brown arc running ear to ear
     * across the middle of the lower face. On Bramm it was the largest mark on
     * the head and it read unmistakably as a grin — and since it sat directly
     * over the lip line it took his actual mouth with it.
     *
     * Seated at 0.86 with a 0.20 half-height the lens's widest row is the jaw
     * rather than the lip, so the mass hangs *below* the mouth where a beard is
     * and the boundary above it is the only edge a viewer sees.
     */
    ctx.beginPath();
    ctx.ellipse(cx, S * 0.86, halfW, S * 0.20, 0, 0, Math.PI * 2);
    ctx.clip();
    // …intersected with the painted island. The beard is the only mark on the
    // face wide *and* low enough to reach the plate's buried rim at the corners
    // of the jaw — measured at an island radius of 1.04 before this clip — and
    // paint out there is paint on the underside of the skull. Bounding it here
    // makes "every painted feature is inside the island" true of the whole file
    // rather than of all of it except one shape. It also gives the field its
    // silhouette for free: the island narrows as it descends, so the beard comes
    // to a chin instead of ending on a flat edge.
    ctx.beginPath();
    ctx.ellipse(cx, S * 0.5, S * FORM.halfW * FORM.rimTo, S * FORM.halfH * FORM.rimTo, 0, 0, Math.PI * 2);
    ctx.clip();

    // The upper boundary: just under the mouth in the middle, rising a little
    // toward the sideburns, with a seeded offset on each control point so the
    // line is irregular the way a growth boundary is. Elvis's is almost flat —
    // six pixels below his lip line, running the full width of the jaw — so the
    // climb is deliberately shallow.
    const top = [];
    for (let i = 0; i < edge.length; i++) {
      const s = i / (edge.length - 1);
      const dx = (s - 0.5) * 2;                       // -1 … 1 across the face
      const away = Math.abs(dx);
      // Zone weight: the chin term owns the middle, the jaw term the sides, so a
      // goatee (jaw ≈ 0) closes to a chin patch without a second code path.
      const zone = lerp(fh.chin, fh.jaw, away * away);
      // Nearly flat. Elvis's boundary in the plate runs six pixels below his lip
      // line straight across the jaw; every degree of climb here is a degree of
      // smile, and the previous 0.62-of-a-gap swing from centre to sideburn was
      // most of the crescent.
      const climb = gap * lerp(-0.06, 0.16, Math.pow(away, 1.5));
      // The raggedness is an absolute offset, not a multiplier on the climb:
      // scaling a term that is near zero in the middle of the face gives a
      // boundary irregular only at its ends, which reads as a wobble in the
      // silhouette rather than as growth.
      const ragged = gap * 1.2 * (edge[i] - 1);
      top.push({ x: cx + dx * halfW * 1.2, y: mouthY - climb + ragged + gap * 2.0 * (1 - zone) });
    }

    /**
     * One fill, with the softness in the *gradient* rather than in a stack of
     * stepped copies.
     *
     * A hard top edge is the one thing a beard must not have — the plate's
     * boundary dissolves over several pixels and reads as hair rather than as a
     * painted mask. The obvious fix, stacking N copies of the path at `alpha/N`,
     * quantises to visible banding at 8 bits per channel. Ramping the fill's own
     * alpha across the band the ragged boundary occupies gives the same
     * dissolve out of a single fill, with the path supplying the irregularity
     * and the gradient supplying the softness.
     *
     * **All** the softness is now at the top.
     *
     * The published ramp faded the field back out at 0.92 of the square as well,
     * to keep it clear of the plate's buried rim. What that produced — visible
     * on Bramm in every capture since — is a field that is transparent above,
     * opaque across one narrow row and transparent again below: a horizontal
     * dark crescent hung across the jaw, which at battle range reads as a grin.
     *
     * The band is unavoidable while the field has a soft edge at *both* ends,
     * because the whole budget between the lip line and the chin is a tenth of
     * the square. So the bottom fade is gone: the field runs solid into the
     * island clip, which is the plate's own rim diving inside the skull, and the
     * mass below the chin is the 3D beard in `roster.hair` meeting it there.
     * The whole vertical budget is spent on the one edge a viewer can see.
     */
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of top) {
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
    // `foot` sits below the island clip on purpose (see above), so the terminal
    // zero stop is never reached and the ramp is a pure dissolve-in.
    const foot = S * 0.980;
    const head = lo - gap * 0.8;
    const fade = ctx.createLinearGradient(0, head, 0, foot);
    const solidAt = clamp01((hi + gap * 0.45 - head) / (foot - head));
    fade.addColorStop(0, cssRgba(t.facialColour, 0));
    fade.addColorStop(solidAt, cssRgba(t.facialColour, fh.alpha));
    fade.addColorStop(Math.max(solidAt, 0.80), cssRgba(t.facialColour, fh.alpha));
    fade.addColorStop(1, cssRgba(t.facialColour, 0));
    ctx.fillStyle = fade;
    ctx.beginPath();
    smoothPath(ctx, top);
    ctx.lineTo(cx + halfW * 1.2, S);
    ctx.lineTo(cx - halfW * 1.2, S);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // The moustache: a separate strip above the mouth, because a beard drawn as
  // one mass over the lip swallows the mouth line and the face loses its lower
  // half at battle range — which is the whole reason the mouth is drawn heavy.
  // It reaches down to the lip so the two fields read as one growth rather than
  // as two stripes with a bandage of skin between them.
  if (fh.moustache > 0.01) {
    /**
     * Wide, soft and pulled clear of the lip.
     *
     * At 1.7 mouth-widths, 0.30 of the nose→mouth gap tall and 0.72 of the
     * field's alpha it was a small hard dark ellipse sitting directly on the lip
     * line — which at any distance is not a moustache, it is an open mouth, and
     * it left the real mouth stroke drawn along its lower edge with nothing to
     * separate the two. Bramm's face read as a hole.
     *
     * 2.3 mouth-widths at 0.55 alpha is the plate's proportion: Elvis's
     * moustache is nearly as wide as his jaw and lets skin through everywhere.
     * Seating it at 0.56 of the gap rather than 0.70 leaves a strip of clear
     * skin above the lip, which is what keeps the mouth a separate mark.
     */
    const mw = FACE_LAYOUT.mouthW * S * 2.0;
    const my = lerp(noseY, mouthY, 0.56);
    const a = fh.alpha * fh.moustache * 0.48;
    const mg = ctx.createRadialGradient(cx, my, 0, cx, my, mw * 0.5);
    mg.addColorStop(0, cssRgba(t.facialColour, a));
    mg.addColorStop(0.45, cssRgba(t.facialColour, a * 0.72));
    mg.addColorStop(1, cssRgba(t.facialColour, 0));
    ctx.fillStyle = mg;
    ctx.beginPath();
    ctx.ellipse(cx, my, mw * 0.5, gap * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * The painted structure under the features: fringe occlusion, cheek blush and
 * a jaw-side falloff.
 *
 * These are the marks the review meant by "no cheek or hairline occlusion
 * gradients, so heads read as toys". A face with nothing between its skin fill
 * and its eyes is a mask; the plates put three broad, soft, *low-contrast*
 * tonal events on every head, and it is those — not the sharp marks — that make
 * a viewer read a skull under the paint.
 *
 * ## Everything here is drawn in island space
 *
 * `FORM`'s rim reconciliation returns the texture to flat `palette.skin`
 * between 0.80 and 0.92 of the plate radius, because past there the plate is
 * sitting flush against bare skull and any paint is a patch on the side of a
 * head. That reconciliation runs *before* these marks, so it cannot erase them
 * — which means the containment has to be a property of how they are drawn.
 *
 * Translating to the plate centre and scaling by `(halfW, halfH)` puts the
 * context in a frame where the island is the **unit circle**, so "this mark
 * never leaves r = 0.80" becomes a statement about a centre and a radius that
 * can be checked by adding two numbers. Each mark below states its own sum. A
 * `clip()` would be the alternative and it is strictly worse: a gradient still
 * at half strength where the clip cuts it prints exactly the hard boundary the
 * reconciliation exists to prevent.
 *
 * Each mark is drawn rotated so its long axis runs *tangentially* — along the
 * hairline, along the jaw — which is both what the anatomy does and what keeps
 * the radial reach small enough to stay inside the budget.
 */
function drawStructure(ctx, t, S) {
  ctx.save();
  ctx.translate(S * 0.5, S * 0.5);
  ctx.scale(S * FORM.halfW, S * FORM.halfH);

  /**
   * Paint one tangentially-elongated soft mark in island space.
   *
   * `cr` is the mark's distance from the plate centre and `ca` its bearing
   * (0 = screen-right, +y = down); `radial` and `tangential` are its half-extents
   * along and across that bearing. The containment condition is exactly
   * `cr + radial <= FORM.rimFrom`, asserted by each caller in its comment.
   */
  const mark = (cr, ca, radial, tangential, colour, stops) => {
    ctx.save();
    ctx.translate(Math.cos(ca) * cr, Math.sin(ca) * cr);
    ctx.rotate(ca);
    ctx.scale(radial, tangential);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (const [at, a] of stops) g.addColorStop(at, cssRgba(colour, a));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  /**
   * 1 — the hairline and fringe occlusion, as **three marks strung along the
   * top arc** rather than one blob on the forehead.
   *
   * Every plate head has the top of its forehead sitting a clear step under the
   * brow ridge, because there is a mass of hair directly in front of it. Ours
   * had the forehead as the *brightest* region of the face, which is what a
   * flat card lit from the front looks like.
   *
   * The arc matters as much as the value. A single wide ellipse centred on the
   * forehead is a cloud — it has a bottom edge running straight across the face
   * and no relationship to where hair actually is. Three overlapping marks at
   * bearings −90° and −90° ± 36° follow the island's own curvature, so the
   * shading dies away down the temples exactly where a fringe parts.
   *
   * Reach: 0.67 + 0.13 = 0.80 for each. The band runs texture-y 0.13 → 0.25,
   * well above the brow at 0.47.
   */
  for (const off of [-0.63, 0, 0.63]) {
    mark(0.67, -Math.PI / 2 + off, 0.13, 0.42, t.fringeShade, [
      [0, 0.27], [0.55, 0.17], [1, 0],
    ]);
  }

  /**
   * 2 — the jaw-side falloff.
   *
   * The plate's cheek does not end at an edge: it turns away over the last
   * fifth of the face and meets the jaw in shade. Without this the painted
   * island reads as a flat disc butted against the skull, which is the "felt
   * doll" note applied to the head.
   *
   * Reach: 0.64 + 0.16 = 0.80, at a bearing of 40° below horizontal — the line
   * of the mandible on a chibi skull. Deliberately the weakest of the three.
   */
  for (const side of [-1, 1]) {
    mark(0.64, side > 0 ? 0.70 : Math.PI - 0.70, 0.16, 0.40, t.skinShade, [
      [0, 0.40], [0.6, 0.24], [1, 0],
    ]);
  }

  /**
   * 3 — the cheek blush: a **hue** mark at held value. See `traits.blush` for
   * the measurement; the short version is that the plate's cheek is the same
   * brightness as its forehead and a different colour, and painting it as a
   * darkened skin tone is what produced a smudge instead of colour.
   *
   * Reach: 0.54 + 0.24 = 0.78. Centred at texture-y 0.656 — under the eye's
   * envelope, over the cheekbone, above the nose tick at 0.745.
   */
  for (const side of [-1, 1]) {
    const ca = Math.atan2(0.34 + t.blushDrop * 3, side * 0.42);
    mark(0.54, ca, 0.24, 0.30, t.blush, [
      [0, t.blushStrength], [0.55, t.blushStrength * 0.52], [1, 0],
    ]);
  }

  ctx.restore();
}

/**
 * Paint a complete face into `ctx`, filling the square `[0,size]²`.
 *
 * Exported separately from `buildFaceTexture` so the same drawing can go into an
 * atlas cell: translate the context to the cell origin and call this with the
 * cell's edge length.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} def   roster entry
 * @param {number} size  edge of the square to fill, in pixels
 * @param {{expression?: string, background?: boolean}} [opts]
 */
export function drawFace(ctx, def, size = FACE_TEXTURE_SIZE, opts = {}) {
  const S = size;
  const t = faceTraits(def);
  const x = EXPRESSIONS[opts.expression] ?? EXPRESSIONS.neutral;
  const f = eyeFrame(t, x, S);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // The shading is painted as a full-plane fill in a scaled frame, so it runs
  // past the square. On a dedicated face texture the canvas bounds crop it; in
  // an atlas cell nothing does, and a character's jaw shading prints across
  // their neighbour. Clipping here makes "fills [0,size]², touches nothing else"
  // a property of the function rather than of how it happens to be called.
  ctx.beginPath();
  ctx.rect(0, 0, S, S);
  ctx.clip();

  if (opts.background !== false) {
    // Flat skin — the roster's own `palette.skin`, so the plate and the skull are
    // one colour (see `SPEC_SKIN`).
    ctx.fillStyle = cssHex(t.skin);
    ctx.fillRect(0, 0, S, S);

    // Form shading, in two soft passes and with no edge in either. See `FORM`.
    //
    // Pass one is vertical: the lower face settles warm from about the nose line
    // down. That is the dominant value move on every plate face and the one that
    // gives a flat painting its jaw.
    // The bottom stop is 0.48, not 0.62. The rim reconciliation returns the
    // texture to flat skin between 0.80 and 0.92 of the plate radius, so the
    // deepest part of this ramp survives only in the band just above it — and at
    // 0.62 that band printed as a distinctly warm crescent across the chin,
    // which on the pale-skinned characters reads as a strap rather than as form.
    // The jaw-side marks in `drawStructure` now carry the modelling this stop
    // was being pushed to do, and they are bounded to stay clear of the ramp.
    const vg = ctx.createLinearGradient(0, S * 0.44, 0, S * 0.99);
    vg.addColorStop(0, cssRgba(t.skinShade, 0));
    vg.addColorStop(0.42, cssRgba(t.skinShade, 0.10));
    vg.addColorStop(1, cssRgba(t.skinShade, 0.48));
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, S, S);

    // Pass two is the temples: the face turns away at the sides long before the
    // plate's rim, and without this the painting reads as a flat card. Both
    // ramps are long on purpose — the whole point of the rebuild is that there
    // is no terminator anywhere on this face.
    for (const side of [-1, 1]) {
      const x0 = S * (0.5 + side * 0.28);
      const x1 = S * (0.5 + side * 0.52);
      const tg = ctx.createLinearGradient(x0, 0, x1, 0);
      tg.addColorStop(0, cssRgba(t.skinShade, 0));
      tg.addColorStop(1, cssRgba(t.skinShade, 0.42));
      ctx.fillStyle = tg;
      ctx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), S);
    }

    /**
     * Rim reconciliation: bring the texture back to flat `palette.skin` before a
     * single feature is drawn.
     *
     * Everything outside `FORM.rimTo` is now the skull's own albedo byte for
     * byte, so the plate has no findable boundary from any angle — the failure
     * that produced both the crown patch and the temple wedge in earlier rounds.
     * Doing it here rather than at the end is what lets the eye pair sit at 0.82
     * of the plate radius without its outer corner being washed out.
     *
     * The frame is squashed by `halfH/halfW` so a radial gradient expresses
     * exactly `hypot(dx/halfW, dy/halfH)`.
     */
    ctx.save();
    ctx.translate(S * 0.5, S * 0.5);
    ctx.scale(1, FORM.halfH / FORM.halfW);
    const rim = ctx.createRadialGradient(0, 0, 0, 0, 0, S * FORM.halfW);
    rim.addColorStop(0, cssRgba(t.skin, 0));
    rim.addColorStop(FORM.rimFrom, cssRgba(t.skin, 0));
    rim.addColorStop(FORM.rimTo, cssRgba(t.skin, 1));
    rim.addColorStop(1, cssRgba(t.skin, 1));
    ctx.fillStyle = rim;
    ctx.fillRect(-S, -S, S * 2, S * 2);
    ctx.restore();
  }

  drawStructure(ctx, t, S);

  const halfSpanX = (0.5 - FACE_LAYOUT.eyeX) * t.spacing;
  const eyeCy = FACE_LAYOUT.eyeY * S;
  // Spaced from the **drawn ink**, not from the layout cell — see
  // `FACE_LAYOUT.browClear`. `browDrop` is the family's own trim on top of it: a
  // hard brow crowds the lid, a gentle one sits high and clear of it.
  const inkTop = eyeInkTop(t, x, S, f);
  const inkHeight = f.hl - inkTop;
  const browY = eyeCy + inkTop - FACE_LAYOUT.browClear * inkHeight
    - browDrop(t, x, f, S) - (x.browLift - t.browDrop) * S;

  // A faint socket shading over the lid. Every plate face has it and it is what
  // seats the eye into the skull instead of printing it on a flat card.
  for (const side of [-1, 1]) {
    const ex = S * (0.5 + side * halfSpanX);
    const sg = ctx.createRadialGradient(ex, eyeCy + inkTop, 0, ex, eyeCy + inkTop, f.inkW * 0.62);
    sg.addColorStop(0, cssRgba(t.skinShade, 0.22));
    sg.addColorStop(1, cssRgba(t.skinShade, 0));
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.ellipse(ex, eyeCy + inkTop, f.inkW * 0.62, f.inkH * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawNose(ctx, t, S, f);
  // Facial hair goes down *before* the mouth: in the plate Elvis's lip line
  // reads straight through his moustache, and painting the field over the mouth
  // instead is what turns a bearded character's lower face into one dark mass at
  // battle range.
  if (t.facial) drawFacialHair(ctx, t, S, f);
  drawMouth(ctx, t, x, S, f);

  for (const side of [-1, 1]) {
    const cx = S * (0.5 + side * halfSpanX);
    // Mirroring is what lets both eyes and both brows come from one authored
    // shape with "+x is outboard" — the alternative is every sign written twice.
    // Both sides consume the same solved `f`, so the pair cannot desync.
    ctx.save();
    ctx.translate(cx, eyeCy);
    ctx.scale(side, 1);
    drawEye(ctx, t, x, f, side);
    ctx.restore();

    ctx.save();
    ctx.translate(cx, browY);
    ctx.scale(side, 1);
    drawBrow(ctx, t, x, f, S);
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Where the painter actually put things, in texture fractions — so the head
 * builder can align its UV island, and the animator can park a blink lid or a
 * gaze offset over the real eye rather than a guessed one.
 */
export function faceMetrics(def, expression = 'neutral') {
  const t = faceTraits(def);
  const x = EXPRESSIONS[expression] ?? EXPRESSIONS.neutral;
  // Solved at the **texture's own size** and divided back down, not at unit
  // size. Every dimension in `eyeFrame` and `browOutline` passes through a
  // `MIN_PX` texel floor, and at S = 1 those floors dominate completely — a
  // 2-texel brow becomes two *face heights* — so a metric taken at unit size
  // reports numbers that have nothing to do with the drawing. Everything else is
  // derived from the same functions the painter uses, because a metric that
  // re-implements the layout is a metric that drifts away from it.
  const S = FACE_TEXTURE_SIZE;
  const f = eyeFrame(t, x, S);
  const inkTop = eyeInkTop(t, x, S, f);
  return {
    eyeCenterY: FACE_LAYOUT.eyeY,
    eyeHalfSpan: (0.5 - FACE_LAYOUT.eyeX) * t.spacing,
    eyeWidth: f.inkW / S,
    eyeHeight: f.inkH / S,
    eyeTilt: t.eyeTilt,
    /** Top of the drawn lash bar — what a viewer reads as the top of the eye. */
    eyeInkTop: FACE_LAYOUT.eyeY + inkTop / S,
    browY: FACE_LAYOUT.eyeY + (inkTop - FACE_LAYOUT.browClear * (f.hl - inkTop)
      - browDrop(t, x, f, S)) / S - (x.browLift - t.browDrop),
    noseY: FACE_LAYOUT.noseY,
    mouthY: FACE_LAYOUT.mouthY,
    roundness: t.round,
    skin: t.skin,
    lash: t.lash,
  };
}

// ------------------------------------------------------------------ textures

/**
 * Texture cache. Faces are immutable per (character, expression, size), the
 * roster is frozen, and a party of four with four expressions is sixteen
 * uploads — building them once and holding them is the whole point.
 */
const _cache = new Map();

function cacheKey(def, expression, size, flipY) {
  return `${def.id}|${expression}|${size}|${flipY ? 1 : 0}`;
}

/**
 * Below this edge the face is redrawn from vector art; at and under it, levels
 * are box-filtered down from the one above. At 32 px the whole head is smaller
 * than the lash bar's texel floor, so redrawing there would produce a face made
 * of nothing but floors — a black smear. Those levels only ever serve extreme
 * minification, where a blurred average is the correct answer.
 */
const MIP_VECTOR_FLOOR = 64;

/**
 * The full mip chain, **drawn** rather than filtered.
 *
 * A box-filtered mip is precisely a machine for destroying a catch-light, a
 * tapered mouth and a hard lash edge, because averaging is what it does. Neither
 * a bigger level 0 nor `LinearFilter` alone can help: level 0 is not the level
 * being read. Redrawing every level from the same vector description, with each
 * feature held above `MIN_PX` texels, means the 128² mip the battle camera
 * actually samples is itself a crisp painted face.
 *
 * A complete chain down to 1×1 is emitted so the texture is mip-complete under
 * both of three's upload paths (`texStorage2D` sizes its allocation from this
 * length).
 */
function drawMipChain(def, expression, size) {
  const levels = [];
  let prev = null;
  for (let s = size; s >= 1; s = Math.floor(s / 2)) {
    const c = makeCanvas(s, s);
    const cx = c.getContext('2d');
    if (s >= MIP_VECTOR_FLOOR || prev === null) {
      drawFace(cx, def, s, { expression });
    } else {
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(prev, 0, 0, s, s);
    }
    levels.push(c);
    prev = c;
  }
  return levels;
}

/**
 * Build (or fetch) the painted face texture for one character and expression.
 *
 * @param {object} def roster entry
 * @param {{size?: number, expression?: string, flipY?: boolean,
 *          anisotropy?: number, cache?: boolean}} [opts]
 * @returns {THREE.CanvasTexture}
 */
export function buildFaceTexture(def, opts = {}) {
  const size = opts.size ?? FACE_TEXTURE_SIZE;
  const expression = EXPRESSIONS[opts.expression] ? opts.expression : 'neutral';
  // Default `true` matches Three's own convention: with v = 1 at the crown of
  // the head island, canvas row 0 (the top of the drawn face) lands there too.
  const flipY = opts.flipY ?? true;
  const key = cacheKey(def, expression, size, flipY);
  if (opts.cache !== false) {
    const hit = _cache.get(key);
    if (hit) return hit;
  }

  const mipmaps = drawMipChain(def, expression, size);

  const tex = new THREE.CanvasTexture(mipmaps[0]);
  tex.name = `face-${def.id}-${expression}`;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = flipY;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  // Hand-authored mips, uploaded level by level (three honours `mipmaps` for a
  // canvas-backed texture and skips its own generation). See `drawMipChain`.
  tex.mipmaps = mipmaps;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // The lash bar is a high-contrast near-black edge across a white field — the
  // exact case that aliases into a crawling grey line under minification, which
  // is what the battle camera does to it. Three clamps this to the device max.
  tex.anisotropy = opts.anisotropy ?? 16;
  tex.needsUpdate = true;

  if (opts.cache !== false) _cache.set(key, tex);
  return tex;
}

/**
 * Every expression for one character, keyed by name — what a character rig wants
 * to hold so swapping expressions is a material `map` assignment with no
 * allocation mid-battle.
 *
 * @returns {Record<string, THREE.CanvasTexture>}
 */
export function buildFaceTextures(def, opts = {}) {
  const out = {};
  for (const name of EXPRESSION_NAMES) out[name] = buildFaceTexture(def, { ...opts, expression: name });
  return out;
}

/**
 * All six faces × all four expressions on one sheet, for the debug capture
 * scenario to review flat.
 *
 * Rows are characters and columns expressions, so a reviewer reads identity down
 * and performance across — the two questions the review actually asks ("are
 * these six different people?", "does hurt read as hurt?").
 */
export function buildFaceSheetTexture(defs = ROSTER, opts = {}) {
  const cell = opts.cell ?? 256;
  const cols = EXPRESSION_NAMES.length;
  const rows = defs.length;
  const pad = Math.round(cell * 0.06);
  const header = Math.round(cell * 0.16);
  const w = cols * cell + pad * (cols + 1);
  const h = rows * cell + pad * (rows + 1) + header;

  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');

  // A neutral slate ground: judging a warm skin tone against white lies about
  // its value, and against black lies the other way.
  ctx.fillStyle = '#2b3138';
  ctx.fillRect(0, 0, w, h);

  const label = (text, x, y, px, align = 'left') => {
    ctx.font = `600 ${px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8eef4';
    ctx.fillText(text, x, y);
  };

  for (let c = 0; c < cols; c++) {
    label(EXPRESSION_NAMES[c].toUpperCase(), pad + c * (cell + pad) + cell / 2, header / 2, Math.round(cell * 0.075), 'center');
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = pad + c * (cell + pad);
      const y0 = header + pad + r * (cell + pad);
      ctx.save();
      ctx.translate(x0, y0);
      drawFace(ctx, defs[r], cell, { expression: EXPRESSION_NAMES[c] });
      ctx.restore();
      if (c === 0) label(defs[r].name, x0 + cell * 0.04, y0 + cell * 0.07, Math.round(cell * 0.062));
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'face-sheet';
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = opts.flipY ?? true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = opts.anisotropy ?? 4;
  tex.needsUpdate = true;
  return tex;
}

/** Release every cached face texture. Call on a full teardown, not a scene swap. */
export function disposeFaceCache() {
  for (const tex of _cache.values()) {
    tex.dispose();
    // The mip chain is a dozen canvases per face and it is reachable only from
    // here; dropping the references is what actually returns the memory, since
    // `dispose()` only frees the GPU side.
    tex.mipmaps = [];
  }
  _cache.clear();
}
