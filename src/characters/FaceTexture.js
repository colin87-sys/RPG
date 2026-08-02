/**
 * FaceTexture.js — the painted anime face, drawn with the 2D canvas API.
 *
 * The face is a **painted texture on a 3D head**, not modelled features: a
 * modelled lash line takes the lighting, so its ink weight brightens on the lit
 * side and vanishes on the shadow side and no amount of tuning recovers what a
 * *drawn* line has for free.
 *
 * ## Measured off the plates as *luminance*, not as outlines
 *
 * `docs/BRAVELY_REFERENCE.md`, `docs/ANIME_PIPELINE.md` and
 * `docs/REFERENCE_TARGET.md` were transcribed by eye before the client's
 * screenshots were in the repository, and their face numbers are wrong. An
 * earlier pass on this file corrected the *sizes* against the plates and still
 * shipped faces an art director scored as "effectively blank". The reason the
 * size correction was not enough is visible only in a numeric readout, so this
 * pass took one — a luma dump of Gloria's near eye in `bravely01.jpg`,
 * x 656–686, y 385–405, against skin at luma 181–190:
 *
 * ```
 *      … 178 181 179 173 177 179 153 118  62   8  11   9  21  26  24  20  23  16  40  81 131 119 …
 *      … 179 186 182 178 186 171 100  23   8  36 126 101  44  29  31  37  56 103  92  59 139 207 …
 *      … 178 186 186 181 187 181 132  73 125 132 176 120  47  29  42  46  61  44  40  52 118 178 …
 * ```
 *
 * The eye is **one dark mass**. Ink runs x 662→680 and y 389→401 — 19 × 13 px,
 * aspect **1.46** — and inside it the iris/pupil block covers 13 × 11 px at luma
 * **8–50 against skin at 185**, i.e. a four-to-one value drop over two thirds of
 * the eye's width and *the whole* of its height. The only bright pixels in the
 * eye are the sclera wedge at the outer canthus (luma 190–215, brighter than the
 * skin) and one glint. Adelle reads identically at x 1400–1425, y 435–455.
 *
 * That is the measurement the previous pass missed. It had the eye's *outline*
 * right and drew a pale saturated iris at 0.56 of the aperture width floating in
 * a field of white sclera, which at the battle camera's ~90 px head averages to
 * skin. What the plate has, and what this file now draws, is:
 *
 * | quantity                  | plate (Gloria / Adelle)     | here |
 * |---|---|---|
 * | eye ink                   | 19 × 13 px, aspect 1.46     | `eyeW` 0.29 × `eyeH` 0.235, family aspect 1.14–1.34 |
 * | iris block                | 13 × 11 px = 0.96 of the aperture height | `irisFill` 0.92–1.00 of the **aperture height** |
 * | iris luma vs skin         | 8–50 vs 185 (0.04–0.27)     | every ramp stop forced under `IRIS_MAX_LUMA` |
 * | sclera                    | 190–215, *above* skin       | cool near-white, unmixed |
 * | catch-light               | one, hard, upper-outboard-lit | one, hard, screen-left on both eyes |
 * | lash bar                  | 3 px on a 13 px eye         | 0.26–0.32 of the ink height |
 * | brow                      | 3 px, 1–3 px of clear skin  | `browClear` 0.16 of the ink height |
 * | eye line                  | 0.56 of crown→chin          | `eyeY` 0.56 confirmed |
 * | nose base                 | 0.60 of the eye→mouth span  | `noseY` 0.705 confirmed |
 *
 * The corrections that follow, and the value each replaces:
 *
 *  1. **The eye is solved from its height, not its width.** `eyeH` is the drawn
 *     ink height and the family aspect *widens* it. Solving the other way round
 *     — which is what produced a 2.45-aspect `narrow` family — lets a small-eyed
 *     character fall to an 8 px slit at battle range whatever the width says.
 *     No family may exceed 1.34 now, against the plate's measured 1.46.
 *  2. **The iris is a disc as tall as the aperture**, not 0.56 of its width, and
 *     every stop of its ramp is clamped under a fraction of the skin's own
 *     luminance. A saturated hue at parity with skin has no read at 90 px; the
 *     plate's iris is essentially black with a hue in it.
 *  3. **The catch-light does not mirror.** It was authored in the eye's mirrored
 *     frame, so the two eyes lit from opposite sides — which is what a viewer
 *     reads as "no highlight" rather than as two. One light, one side.
 *  4. **Brow, mouth and nose are pushed to ink weight.** All three were tuned
 *     against a 1024² canvas viewed flat and are being read at ~90 px through a
 *     lit toon surface that lifts midtones; the plate's marks are near-black.
 *  5. **No hard terminator and no outline.** Unchanged and still correct: the
 *     plate faces carry a long, low-amplitude warm gradient and nothing else.
 *     See `FORM`.
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
 * missing. At the 128² mip a 0.235 eye is 30 texels tall, so the lash bar is
 * seven of them and the catch-light three — but the *screen* is coarser than the
 * mip the sampler picks, so every floor here is set to what survives a further
 * halving rather than to what is merely non-zero.
 */
const MIN_PX = Object.freeze({
  ring: 1.0, highlight: 2.6, lash: 3.2, pupil: 2.2,
  brow: 2.8, mouth: 2.4, lid: 1.2, crease: 1.0, nose: 2.2,
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
  /** Eye centre height. 0.56 of crown→chin; the plates read 0.56–0.59. */
  eyeY: 0.56,
  /**
   * Inner-left eye centre; the other sits at `1 - eyeX`.
   *
   * This number is not free: it is bounded above by taste and below by geometry.
   *
   * `Rig` gives the plate `halfX = head.rx * 0.95` on a square of
   * `head.rx * 2.28`, so the mesh only ever samples `u ∈ [0.083, 0.917]` — a
   * painted feature past 0.417 of the texture from the centreline is *never
   * drawn on the head at all* — and the plate's rim starts diving inside the
   * skull at `buryFrom` 0.92 of that, i.e. 0.383.
   *
   * The eye pair's outboard reach is `halfSpan + inkW/2 + flick`, and this pass
   * spends a third of the budget on a wider eye (0.29 against 0.26). 0.268 is
   * what is left: the widest reach in the roster is Emrys (`eye` 1.16,
   * `eyeSpacing` 1.05, `round`) — 0.383 to the outer corner of the ink, which
   * clears `buryFrom` exactly, and 0.39 to the tip of the lash flick, which is
   * the only mark allowed into the dive because it tapers to nothing there. The
   * previous 0.255 put Emrys' *iris* at 0.42, off the sampled plate entirely,
   * which is one of the reasons his outer eye had no read.
   */
  eyeX: 0.270,
  /**
   * Nominal eye ink **width**.
   *
   * Consumed here only as documentation of what the families average to — the
   * painter solves the width from the height and the family aspect (see
   * `eyeFrame`) — but `Rig` reads it directly to size the hair guard band, so it
   * has to state the real drawn width. The roster spans 0.279 (Yshara, almond)
   * to 0.299 (Kirella, sharp).
   */
  eyeW: 0.29,
  /**
   * Eye ink **height**, and the dimension the whole eye is now solved from.
   *
   * Gloria's ink is 13 px on an 89 px crown→chin, and `Rig` builds the plate at
   * 2.28 `rx` against a head 0.80 as wide as it is tall, so her eye is 0.16 of
   * the square. This is 0.235 — deliberately half again the plate's ratio.
   *
   * The plate is a 1080p render of a face lit for the shot; ours is read at ~90
   * px through a toon surface with a rim term that lifts the whole face, and the
   * eye has to survive both the mip chain and a three-quarter yaw that
   * foreshortens it horizontally. Matching the plate's *ratio* is what produced
   * the 8 px slit the review measured. Matching its *read* costs this much.
   */
  eyeH: 0.235,
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
   * The plates read 1–3 px of clear skin on a 13 px eye. At 0.10 of a 13 px ink
   * height that is 1.3 px — inside the plate's band on paper, but the brow and
   * the lash are the two heaviest marks on the face and at the battle camera's
   * ~90 px head a single texel of skin between them filters away, leaving one
   * four-pixel black bar per eye. That bar is a large part of what the review
   * read as "closed-eye squint lines". 0.16 buys a little over three screen
   * pixels of clear skin, which is the smallest gap that stays a gap.
   */
  browClear: 0.16,
  /**
   * Nose base. 0.60 of the way from the eye line to the mouth line — the single
   * most consistent measurement in the set (Elvis 0.59, Gloria 0.62, Adelle
   * 0.63).
   */
  noseY: 0.705,
  /** Mouth line. */
  mouthY: 0.795,
  /**
   * Mouth width. ~0.6 of the eye's ink width: the plates read 0.46 (Gloria,
   * pursed and three-quarter), 0.68 (Adelle) and 0.77 (Elvis). The published
   * 0.08 was 0.31 eye widths and is the "token mouth" the client rejected.
   */
  mouthW: 0.175,
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
 *   `aspect`     the drawn **ink** width : height. Gloria measures 1.46 and she
 *                is the roundest face in the plate, so 1.34 is the ceiling here
 *                and the families differ by a fifth rather than by the 1.55–2.45
 *                spread the previous pass authored. A 2.45 aspect on a 0.17 eye
 *                is a 6 px slit at the battle camera whatever its width says,
 *                and four of the six characters were inside a texel of that.
 *   `widen`      ink width trim once the aspect has widened the height. It only
 *                exists to keep the widest eye off the plate's buried rim (see
 *                `FACE_LAYOUT.eyeX`); identity lives in `aspect`.
 *   `lidSplit`   share of the aperture height that sits above the lid line
 *   `irisFill`   iris diameter as a fraction of the **aperture height**, not of
 *                its width. Gloria's iris block is 11 px in a 11.5 px aperture.
 *                Every family is therefore near 1: what distinguishes them is
 *                the aperture the iris is being clipped by, which is the whole
 *                point of having families.
 *   `flick`      lash overhang past the outer corner, × the eye half-width. The
 *                plates barely flick at all — Gloria's is 2 px on a 19 px eye —
 *                and the flick is the outermost ink on the face, so it is also
 *                what the plate's dive zone eats first.
 */
const EYE_SHAPES = Object.freeze({
  narrow: Object.freeze({ round: 0.05, aspect: 1.34, widen: 0.96, lidSplit: 0.46, cornerDrop: 0.18, lowerDepth: 0.62, lash: 0.32, flick: 0.12, tilt: 0.13, irisFill: 0.92, crease: 0.85 }),
  sharp:  Object.freeze({ round: 0.32, aspect: 1.26, widen: 1.01, lidSplit: 0.50, cornerDrop: 0.14, lowerDepth: 0.74, lash: 0.30, flick: 0.10, tilt: 0.09, irisFill: 0.95, crease: 0.55 }),
  almond: Object.freeze({ round: 0.62, aspect: 1.20, widen: 1.00, lidSplit: 0.54, cornerDrop: 0.10, lowerDepth: 0.86, lash: 0.28, flick: 0.07, tilt: 0.05, irisFill: 0.98, crease: 0.25 }),
  round:  Object.freeze({ round: 1.00, aspect: 1.14, widen: 0.98, lidSplit: 0.56, cornerDrop: 0.04, lowerDepth: 0.96, lash: 0.26, flick: 0.05, tilt: 0.01, irisFill: 1.00, crease: 0.00 }),
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
 * The thicknesses are up by a third on the previous pass. The plate's brows are
 * 3 px on an 89 px head — 0.034 of the square — and ours were authored at 0.023
 * for the gentle family, which is 2 px before the mip chain gets to it and one
 * after. A brow is a *mark*, and a mark that is one pixel wide is a smudge.
 */
const BROW_STYLES = Object.freeze({
  hard:   Object.freeze({ thick: 0.042, arch: 0.12, tilt: -0.07, drop: 0.008, gain: 1.35, mouth: -0.005, mouthW: 1.12 }),
  level:  Object.freeze({ thick: 0.037, arch: 0.28, tilt: 0.00, drop: 0.000, gain: 1.30, mouth: 0.000, mouthW: 1.00 }),
  gentle: Object.freeze({ thick: 0.033, arch: 0.50, tilt: 0.05, drop: -0.006, gain: 1.30, mouth: 0.007, mouthW: 0.92 }),
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
  full:      Object.freeze({ moustache: 1.00, chin: 1.00, jaw: 1.00, alpha: 0.58 }),
  goatee:    Object.freeze({ moustache: 0.85, chin: 1.00, jaw: 0.18, alpha: 0.56 }),
  moustache: Object.freeze({ moustache: 1.00, chin: 0.00, jaw: 0.00, alpha: 0.52 }),
  stubble:   Object.freeze({ moustache: 0.70, chin: 0.85, jaw: 0.95, alpha: 0.24 }),
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
  // Sixteen steps rather than eight. The ratios this pass asks for are three to
  // four times deeper than the last one's, and eight steps of 22% bottom out at
  // 0.14 of the input — not enough to take Seren's near-white hair down to the
  // 0.14-of-skin the brow now demands, which silently left her browless.
  for (let i = 0; i < 16 && lumOf(out) > target; i++) out = darken(out, 0.22);
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
    mixHex(pal.lash ?? 0x14181f, pal.hairShade ?? 0x241f1c, 0.22), skin, 0.055,
  );

  const iris = pal.eye ?? 0x5fb8b0;
  /**
   * The three stops of the iris ramp, each forced under a fraction of the
   * character's own skin luminance.
   *
   * This is the single change that turns the eye back into a mark. Gloria's iris
   * block reads luma 8–50 against skin at 185 — 0.04 to 0.27 — and ours were
   * being drawn at `saturate(iris, 1.3)`, which for Emrys' orange and Seren's
   * cyan lands *above* their skin. A shape at parity with its background has no
   * silhouette at any resolution, and no amount of lash weight around it helps.
   *
   * Clamping against the character's own skin rather than against a constant is
   * what keeps the rule true for Kirella's dark skin as well as Seren's pale
   * one: the ratio is a contrast requirement, not a colour.
   *
   * The hue survives because `saturate` runs before the clamp and `darken`
   * multiplies in linear light, so what comes out is a black with an unambiguous
   * cast rather than a grey — exactly what the plate's brown and blue irises are.
   */
  const irisTop = ensureDarkerThan(mixHex(saturate(iris, 1.20), lash, 0.55), skin, 0.05);
  const irisMid = ensureDarkerThan(saturate(iris, 1.45), skin, 0.19);
  // The foot takes its hue from the roster's `eyeCore` where one is authored —
  // that field exists to say what the lit bottom of this character's iris is
  // made of — and only its *value* is overridden.
  // 0.42 rather than a deeper clamp: the foot is the only part of the iris with
  // room for chroma, and driving all three stops to near-black turns a blue eye
  // and an orange eye into the same dark hole. Below half the skin's luminance
  // the disc still reads as a mark; above it, it does not.
  const irisFoot = ensureDarkerThan(saturate(mixHex(iris, pal.eyeCore ?? iris, 0.5), 1.25), skin, 0.42);
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
    // The rim across the iris's lower arc, one step under its foot so the disc
    // has an edge where it meets the lower lid. The plates show no ring around
    // the whole iris; they show this.
    irisRing: ensureDarkerThan(mixHex(irisFoot, lash, 0.35), skin, 0.14),
    // Near-black. A pupil mixed back toward the iris hue reads as a warm brown
    // smudge that barely separates.
    pupil: mixHex(0x07090d, iris, 0.03),
    lash,
    // 0.14 rather than 0.32. The brow and the mouth are the two marks a viewer
    // reads a face's *expression* from at battle range, and both were sitting at
    // a third of the skin's luminance — visible on a flat canvas, and lifted
    // most of the way back to skin by the toon surface's diffuse wrap and rim
    // term once it is on a head. They are ink; ink is near-black.
    brow: ensureDarkerThan(darken(hairBase, 0.30), skin, 0.14),
    // The mouth is an ink stroke from the same hair-darkened family as the brow,
    // held one step darker because at battle range it is the only mark below the
    // eyes. It is *not* mixed out of `skinShade`: a mouth that is not the darkest
    // thing on the lower face is a blemish, not a mouth.
    mouth: ensureDarkerThan(darken(hairBase, 0.30), skin, 0.11),
    // The lit lower lip. The plates all show it — a warm, slightly desaturated
    // band directly under the lip line — and it is what stops the mouth reading
    // as a scratch.
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
    // 0.26–0.32 of the ink height. Gloria's bar is 3 px on a 13 px eye (0.23)
    // and hers is the lightest in the plate; ours has to clear a texel floor at
    // the mip the battle camera samples *and* survive the toon surface lifting
    // it, so the band starts where the plate's ends.
    lashWeight: shape.lash + rng.jitter(0.010),
    lashFlick: shape.flick,
    browThick: browStyle.thick,                // fraction of eye ink height
    browArch: browStyle.arch + rng.jitter(0.03),
    browDrop: browStyle.drop,                  // toward the eye
    mouthCurveBias: browStyle.mouth,
    mouthWidthBias: browStyle.mouthW,
    highlightJitter: rng.jitter(0.05),

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
 * The lash bar's thickness profile along the spine: thin where it leaves the
 * inner corner, heaviest just past the apex, still heavy at the outer corner,
 * then tapering to a point through the flick. This asymmetry — heavy outer,
 * light inner — is what gives an anime eye its direction, and it is visible in
 * every plate face.
 */
function lashProfile(s, flick) {
  if (s <= 1) {
    const a = clamp01(s / 0.42);
    const rise = lerp(0.26, 1, a * a * (3 - 2 * a));
    const fall = 1 - 0.14 * clamp01((s - 0.55) / 0.45);
    return rise * fall;
  }
  const k = clamp01((s - 1) / Math.max(flick, 1e-3));
  return 0.80 * (1 - k) * (1 - k);
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
    const y = -p.x * sa + p.y * ca - f.lashTh * 0.45 * lashProfile(s, t.lashFlick);
    if (y < top) top = y;
  }
  return top;
}

/**
 * One eye, drawn back to front. Called with the context already translated to
 * the eye centre and mirrored so that +x points at the outer corner.
 *
 * `side` is that mirror's sign (+1 for the character's screen-right eye), and it
 * exists for exactly one mark: the catch-light, which must land on the same
 * *screen* side of both irises because there is one key light. See step 8.
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

  ctx.save();
  aperture();
  ctx.clip();

  // 1 — sclera. Cool at the top, where the lash's cast shadow would sit.
  const sc = ctx.createLinearGradient(0, -hu, 0, hl);
  sc.addColorStop(0, cssHex(t.scleraTop));
  sc.addColorStop(1, cssHex(t.scleraBottom));
  ctx.fillStyle = sc;
  ctx.fillRect(-hw * 1.6, -hw * 1.8, hw * 3.2, hw * 3.6);

  // 2 — the iris: a disc that fills the aperture top to bottom, so the lids clip
  // it, and stops short of both canthi, so the sclera stays visible there.
  //
  // Three stops, all forced under a fraction of this character's skin luminance
  // in `faceTraits` (see `irisTop`). The ramp runs dark → mid → light *downward*,
  // which is the plate's read: the lash casts a shadow across the top third of
  // the iris and the bottom catches the bounce. The stop positions are pulled
  // toward the top — 0.34 and 0.72 rather than an even split — because on the
  // plate the dark band is short and the lit foot is broad, and an even ramp
  // reads as a gradient rather than as a shadow.
  const ig = ctx.createLinearGradient(0, iy - irisR, 0, iy + irisR);
  ig.addColorStop(0, cssHex(t.irisTop));
  ig.addColorStop(0.34, cssHex(t.irisMid));
  ig.addColorStop(0.72, cssHex(t.irisFoot));
  ig.addColorStop(1, cssHex(t.irisFoot));
  ctx.fillStyle = ig;
  ctx.beginPath();
  ctx.arc(ix, iy, irisR, 0, Math.PI * 2);
  ctx.fill();

  // 3 — the iris rim, across the **lower arc only**. The plates show no dark
  // ring around the whole iris; what they show is the lower edge settling as the
  // bright bottom of the iris meets the lid. A full ring merges with the lash
  // bar under any downsample and turns the eye into a flat disc with a black
  // outline — the ink weight the client rejected.
  const ringW = atLeast(irisR * 0.09, MIN_PX.ring);
  ctx.strokeStyle = cssRgba(t.irisRing, 0.85);
  ctx.lineWidth = ringW;
  ctx.beginPath();
  ctx.arc(ix, iy, irisR - ringW * 0.5, 0.18 * Math.PI, 0.82 * Math.PI);
  ctx.stroke();

  // 4 — pupil: near-black, and *large*. At 0.34 of the iris radius against an
  // iris that was itself 0.44 of the aperture, the pupil used to be a mark four
  // texels across at the mip the battle camera samples, which is under the
  // filter's own footprint. It is now 0.42 of an iris twice the size, and since
  // the iris around it is near-black too the pair reads as one deep pupil with a
  // coloured corona — which is what the plate reads as.
  const pupilRX = atLeast(irisR * 0.42 * x.pupil, MIN_PX.pupil);
  const pupilRY = Math.min(pupilRX * 1.16, irisR * 0.88);
  ctx.fillStyle = cssHex(t.pupil);
  ctx.beginPath();
  ctx.ellipse(ix, iy, pupilRX, pupilRY, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 5 — the upper lash bar, deliberately *outside* the clip: it has to overhang
  // the outer corner, and it is the heaviest black in the face.
  const spine = samplePolyline((s, o) => lidPoint(g, s, flickLen, o), 0, 1 + t.lashFlick, 30);
  ctx.fillStyle = cssHex(t.lash);
  // Straddling the lid line — 45% above, 55% below — keeps the ink weight while
  // leaving the white. Dropping the bar into the aperture instead is what used
  // to make a lash specified at 20% of the eye height eat half the visible eye.
  ribbon(ctx, spine, f.lashTh, (u) => lashProfile(u * (1 + t.lashFlick), t.lashFlick), 0.45);
  ctx.fill();

  // 6 — the eyelid crease. Elvis has an unmistakable one in `bravely01.jpg`: a
  // fine warm line a couple of pixels above the lash, following it and dying
  // before the inner corner. It is what makes an adult eye read as an adult eye,
  // and the round-eyed children correctly have none (`crease` 0).
  if (t.creaseStrength > 0.02) {
    // Offset by a little over the bar's own upper half-thickness, and no more.
    // The multiplier used to be 0.95–1.60 of the whole bar, which was a couple
    // of texels while the bar was thin; against the heavier bar this pass draws
    // it lifted the crease clear of the socket and printed a second, fainter
    // brow above the real one on every adult face.
    const creaseSpine = samplePolyline((s, o) => {
      lidPoint(g, s, flickLen, o);
      o.y -= f.lashTh * (0.62 + 0.30 * t.creaseStrength);
      return o;
    }, 0.28, 0.98, 12);
    ctx.fillStyle = cssRgba(t.crease, 0.55 * t.creaseStrength + 0.25);
    ribbon(ctx, creaseSpine, atLeast(f.lashTh * 0.26, MIN_PX.crease),
      (u) => Math.sin(clamp01(u) * Math.PI) * 0.7 + 0.3);
    ctx.fill();
  }

  ctx.save();
  aperture();
  ctx.clip();

  // 7 — lower lid: a thin warm line along the outer half only, far lighter than
  // the lash bar, which is what keeps it a lid rather than an eye bag.
  ctx.strokeStyle = cssRgba(mixHex(t.lash, t.skinShade, 0.42), 0.85);
  ctx.lineWidth = atLeast(f.inkH * 0.055, MIN_PX.lid);
  ctx.lineCap = 'round';
  ctx.beginPath();
  smoothPath(ctx, samplePolyline((s, o) => lowerPoint(g, s, o), 0.04, 0.48, 10));
  ctx.stroke();

  /**
   * 8 — the catch-light. **One**, hard-edged, pure, upper-left on screen.
   *
   * Two things were wrong with it and one was invisible on a flat canvas. It was
   * authored in the eye's *mirrored* frame — `+x` is outboard on both sides — so
   * the two eyes carried highlights on opposite sides of their irises, which no
   * single light source can produce and which a viewer reads not as two
   * highlights but as none. `side` undoes the mirror for this one mark, so both
   * glints sit on the screen-left of their iris, matching a key from that side.
   *
   * It is also bigger: 0.26 of the iris *diameter* against the 0.20 measured on
   * the plate, because the plate's is measured on a 1080p render of a face
   * filling a tenth of the frame and ours has to survive a mip fetch at 90 px.
   *
   * It is placed against the **visible aperture**, not against the iris: the
   * iris fills the aperture, so a mark parked at a fixed fraction of the iris
   * radius sits *under the lash bar*. Solving for the first row the lash does
   * not cover, then clamping the disc inside the iris, lands it in the same
   * quadrant on every face however narrow the family is.
   */
  const visTop = -hu + f.lashTh * 0.55;
  const bigR = atLeast(irisR * 0.26, MIN_PX.highlight);
  const bigX = clamp(ix - side * irisR * (0.34 + t.highlightJitter),
    ix - irisR + bigR * 1.12, ix + irisR - bigR * 1.12);
  const bigY = Math.max(iy - irisR * 0.30, visTop + bigR * 1.05);

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  // Pure, not tinted. The glint is the only pixel on the face allowed to be
  // brighter than the sclera, and the sclera is already a cool near-white; a
  // "slightly cool white" highlight on top of it is the same colour twice.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(bigX, bigY, bigR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

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
  const arch = -t.browArch * th * 2.2;
  const cx = lerp(inX, outX, 0.42);
  const cy = lerp(inY, outY, 0.42) + arch;

  const norm = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const l = Math.hypot(dx, dy) || 1;
    return { x: dy / l, y: -dx / l };
  };
  const nIn = norm(inX, inY, cx, cy);
  const nMid = norm(inX, inY, outX, outY);
  const nOut = norm(cx, cy, outX, outY);
  const tIn = th * 0.46;
  const tMid = th * 0.42;
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
 * The nose.
 *
 * The client's rejection said "no nose", and it was literally true: the old
 * build drew a 1%-wide dot and only for characters with `eye < 1.05`. Every face
 * in every plate has one, and it is built from four soft marks and no line:
 *
 *  1. a lit ridge running down from between the brows, which is what actually
 *     makes the form read (Adelle's is the clearest — a pale band above the base
 *     at y 108–111 of `bravely04.jpg`);
 *  2. a warm shadow under the tip, ~0.42 of an eye width across (Elvis 10 px on
 *     a 26 px eye, Adelle 11 on 25);
 *  3. two small nostril darkenings inside it;
 *  4. on the older faces only, a pair of faint bridge shadows flanking the
 *     ridge.
 *
 * Every mark is a gradient with no hard edge anywhere, because the plate's nose
 * has no outline and an outlined one reads as a cartoon snout at this scale.
 */
function drawNose(ctx, t, S, f) {
  const k = t.noseStrength;
  const y = FACE_LAYOUT.noseY * S;
  const cx = S * 0.5;
  const w = Math.max(f.inkW * 0.42, MIN_PX.nose * 2);
  const h = w * 0.34;
  // The ridge is short. Running it up to the brows — which is what an anatomy
  // diagram would do — puts a pale stripe down the middle of a face whose whole
  // value range is a few percent wide, and it reads as a seam, not as a nose.
  const ridgeH = w * (0.9 + 1.1 * k);

  // 4 — bridge shading, drawn first so the base sits on top of it. Only the
  // older faces get it; on Adelle's frontal plate there is no bridge at all.
  if (k > 0.34) {
    const bridgeA = (k - 0.34) * 0.24;
    for (const side of [-1, 1]) {
      const bx = cx + side * w * 0.42;
      const bg = ctx.createLinearGradient(bx - w * 0.24, 0, bx + w * 0.24, 0);
      bg.addColorStop(0, cssRgba(t.skinShade, 0));
      bg.addColorStop(0.5, cssRgba(t.skinShade, bridgeA));
      bg.addColorStop(1, cssRgba(t.skinShade, 0));
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.ellipse(bx, y - ridgeH * 0.45, w * 0.24, ridgeH * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 1 — the lit ridge, sitting between the bridge shadows. Barely there: this is
  // form, not a mark, and at battle range it only has to keep the base shadow
  // from reading as a smudge floating on the cheek.
  const ridge = ctx.createRadialGradient(cx, y - ridgeH * 0.45, 0, cx, y - ridgeH * 0.45, ridgeH * 0.6);
  ridge.addColorStop(0, cssRgba(0xffffff, 0.045 + 0.075 * k));
  ridge.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = ridge;
  ctx.beginPath();
  ctx.ellipse(cx, y - ridgeH * 0.45, w * 0.34, ridgeH * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();

  // 2 — the base shadow: the mark that actually says "nose". Wider than tall,
  // warm, soft on every edge.
  //
  // `skinShade` is clamped to 0.80–0.88 of the skin's luminance by `FORM`, so
  // even at full alpha this mark is a 15% value drop — which is the right ceiling
  // for a nose and the reason its alpha can be pushed to opacity without the
  // face acquiring a snout. At the old 0.52 it was a 6% drop, i.e. under one
  // 8-bit step per channel by the time the mip chain had halved it twice.
  const base = ctx.createRadialGradient(cx, y, 0, cx, y, w * 0.5);
  base.addColorStop(0, cssRgba(t.skinShade, Math.min(1, 0.80 + 0.20 * k)));
  base.addColorStop(0.55, cssRgba(t.skinShade, 0.54 + 0.34 * k));
  base.addColorStop(1, cssRgba(t.skinShade, 0));
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.ellipse(cx, y, w * 0.5, h, 0, 0, Math.PI * 2);
  ctx.fill();

  // 3 — nostrils. The only part of the nose with real value contrast, and even
  // here it is a soft mark: a hard pair of dots reads as a pig snout.
  const nr = Math.max(w * 0.16, MIN_PX.nose * 0.5);
  const nostril = darken(t.skinShade, 0.52);
  for (const side of [-1, 1]) {
    const nx = cx + side * w * 0.28;
    const ng = ctx.createRadialGradient(nx, y, 0, nx, y, nr);
    ng.addColorStop(0, cssRgba(nostril, 0.55 + 0.40 * k));
    ng.addColorStop(1, cssRgba(nostril, 0));
    ctx.fillStyle = ng;
    ctx.beginPath();
    ctx.ellipse(nx, y + h * 0.14, nr, nr * 0.68, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * The mouth: a tapered lens with a lit lower lip, and no outline.
 *
 * Three things are being fixed against the plates at once. It is **0.6 of an eye
 * width** rather than 0.31 — the plates read 11 px (Gloria), 17 (Adelle) and 20
 * (Elvis) against eyes of 24, 25 and 26. It is **thickest in the middle**, like
 * every drawn mouth, rather than a constant-width stroke. And it has a **lit
 * lower lip** directly beneath it, which every plate shows and which is what
 * stops the mark reading as a scratch on the chin.
 *
 * The pipeline prose forbids "lips, teeth, an outlined opening". The images
 * disagree on the lower lip — it is plainly there on all four faces — so the lip
 * is drawn and the teeth are not.
 */
function drawMouth(ctx, t, x, S, f) {
  // Width and curvature carry the same personality the brow does, so the six
  // mouths are not one stamp at six hues.
  const w = FACE_LAYOUT.mouthW * S * x.mouthWidth * t.mouthWidthBias;
  const y = FACE_LAYOUT.mouthY * S;
  const c = (x.mouthCurve + t.mouthCurveBias) * S;
  const cx = S * 0.5;
  // 0.022 of the square rather than 0.019, and the taper below is sharper to pay
  // for it. Gloria's lip line is 2 px of luma 120 on an 89 px head against skin
  // at 185; the weight the review found missing is in the *value* (see
  // `traits.mouth`, now clamped to 0.11 of the skin's luminance) rather than in
  // the thickness — a blunt stroke a third thicker than this reads as a lozenge
  // stuck on the chin, which is exactly what a first pass at it produced.
  const th = atLeast(S * 0.022, MIN_PX.mouth);

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

  // The lit lower lip first, so the ink stroke sits on top of it. Offset by a
  // little over the stroke's own thickness and slightly narrower, which is the
  // relationship the plates show.
  const lip = spine.map((p) => ({ x: cx + (p.x - cx) * 0.82, y: p.y + th * 1.15 }));
  ctx.fillStyle = cssRgba(t.lip, 0.62);
  ribbon(ctx, lip, th * 1.25, (u) => Math.sin(clamp01(u) * Math.PI) ** 0.7);
  ctx.fill();

  // The lip line. Heaviest in the middle, tapering to a point at both corners —
  // and a touch heavier below the spine than above, because the upper lip's edge
  // is the sharper of the two.
  ctx.fillStyle = cssHex(t.mouth);
  ribbon(ctx, spine, th, (u) => 0.06 + 0.94 * Math.sin(clamp01(u) * Math.PI) ** 1.05, 0.42);
  ctx.fill();

  // An open mouth is a darker lens under the line, never an outlined hole.
  if (x.mouthOpen > 0.01) {
    const openH = th * 2.6 * x.mouthOpen;
    ctx.fillStyle = cssRgba(darken(t.mouth, 0.25), 0.72);
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
     * The lower stop is what keeps the rim reconciliation's guarantee: the field
     * is gone well before the plate's edge, because the painted beard covers the
     * jaw only and the mass below the chin is the 3D beard in `roster.hair`.
     */
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of top) {
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
    // The ramp ends where the island clip closes on the centreline, so the field
    // fades out *into* its own boundary instead of being sliced by it. Running
    // it to the canvas edge instead — which is what the previous pass did to
    // avoid spending the beard's vertical budget on the ramp — left the fill at
    // 85% alpha where the ellipse cut it, printing a hard smiling arc across the
    // jaw. The flatter growth boundary this pass draws frees enough room to
    // afford the ramp and still have mass on the chin.
    const foot = S * 0.920;
    const head = lo - gap * 0.2;
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
    const mw = FACE_LAYOUT.mouthW * S * 2.3;
    const my = lerp(noseY, mouthY, 0.56);
    const a = fh.alpha * fh.moustache * 0.55;
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
    const vg = ctx.createLinearGradient(0, S * 0.44, 0, S * 0.99);
    vg.addColorStop(0, cssRgba(t.skinShade, 0));
    vg.addColorStop(0.42, cssRgba(t.skinShade, 0.10));
    vg.addColorStop(1, cssRgba(t.skinShade, 0.62));
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

  // Cheek warmth: a broad mark on the cheekbone. It sits *below* the eye's
  // envelope on purpose — overlapping it reads as an under-eye shadow, which is
  // the grubby look the brief forbids — and it stays a bloom rather than a
  // blush, because none of the plate faces has a blush; what they have is a warm
  // settling where the cheek turns.
  //
  // Its peak is 0.30 rather than 0.11 and it is a third wider. At 90 px a 0.11
  // alpha over a hue only a third of the way from `skinShade` to red is well
  // under an 8-bit step, so the previous mark was arithmetically absent from the
  // texture; the review's "cheek does not read at 90 px" was literal.
  const bloom = mixHex(t.skinShade, 0xff6a5e, 0.42);
  const bloomR = S * 0.115;
  for (const side of [-1, 1]) {
    const bx = S * (0.5 + side * 0.245);
    const by = S * 0.685;
    const bg = ctx.createRadialGradient(bx, by, 0, bx, by, bloomR);
    bg.addColorStop(0, cssRgba(bloom, 0.24));
    bg.addColorStop(0.6, cssRgba(bloom, 0.12));
    bg.addColorStop(1, cssRgba(bloom, 0));
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.ellipse(bx, by, bloomR, bloomR * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
  }

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
