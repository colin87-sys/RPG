/**
 * FaceTexture.js — the painted anime face, drawn with the 2D canvas API.
 *
 * This module exists because of ANIME_PIPELINE §1: **the face is a painted
 * texture, not geometry**. The first cast modelled eyes, brows and mouth as
 * projected decal discs on the skull and shaded them with the body's material.
 * That is the single largest reason the review read "AI slop, nothing like
 * anime": modelled features take the lighting, so the eye's dark outline
 * brightens on the lit side and vanishes on the shadow side, the catch-light
 * cannot stay a constant white, and no amount of tuning recovers the ink weight
 * that a *drawn* lash line has for free.
 *
 * Everything here is authored the way a 2D animator authors a face:
 *
 *   - **Flat colour and hard edges.** No noise, ever (ANIME_PIPELINE's absolute
 *     rule). The only gradients in the file are the ones the spec asks for — the
 *     sclera's cool tint, the iris body, the cheek blush, and the cel shadow
 *     band, whose ramp is 6% of its radius wide precisely so it stays a hard
 *     terminator. Each is a deliberate painted mark, not a lighting effect.
 *   - **The eye is seven stacked layers in a fixed order.** §1 "The eye, drawn
 *     back to front" is reproduced literally, because each layer's read depends
 *     on the one under it: the iris ring only works over a gradient iris, the
 *     highlights only work over a dark pupil, and the lash bar only works when
 *     it is the heaviest black on the face.
 *   - **Bold enough to survive 80 px.** REFERENCE_TARGET §1 puts a head at
 *     roughly eighty pixels in the battle camera, so the whole face is about
 *     that tall on screen. Every feature is sized against that: the lash bar
 *     lands at ~5 screen pixels, the iris at ~20, the large highlight at ~2.5.
 *     Anything subtler than that is invisible where it matters and is not drawn.
 *
 * Per-character identity is *derived from `roster.js`*, never from a table keyed
 * by id — a new party member must get a coherent face without an edit here. It
 * is derived from five channels rather than one: `proportions.eyeShape` and
 * `proportions.brow` select a construction family (see `EYE_SHAPES` and
 * `BROW_STYLES`), and `eye`, `eyeSpacing` and `browAngle` modulate it. The
 * earlier build collapsed all of that onto a single roundness scalar, which is
 * why the review found "all six faces are the same layout recoloured": one
 * scalar can only slide one shape along one axis. Bramm's narrow, low-browed
 * glare and Seren's tall round one are now different drawings, not one drawing
 * at two sizes.
 *
 * Determinism: the micro-variation that stops the six looking rubber-stamped is
 * driven by an `Rng` seeded from the character id, following the same convention
 * as `art/Textures.js`. Seeding from the key rather than sharing the global
 * stream makes a face independent of the order scenes happen to build in, which
 * is what keeps a capture reproducible.
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
 * 1024, not 512. The review measured the lash line, the iris rim and the mouth
 * arc as "soft and mushy" at closeup, and the cause is sampling rather than
 * drawing: the closeup camera magnifies the face plate to roughly the texture's
 * own resolution, so at 512 every rasterised curve is being stretched. 1024
 * supersamples the highest-contrast edge in the game for 4 MB a head, and
 * `buildFaceTexture` pairs it with a **hand-drawn mip chain** so the battle
 * camera does not throw that crispness away again (see the note there).
 */
export const FACE_TEXTURE_SIZE = 1024;

/**
 * Minimum feature sizes **in texels of the level being drawn**.
 *
 * These are what make a hand-authored mip chain worth having. A box-filtered
 * 128² mip of a 1024² face averages the 12%-wide iris ring and the catch-light
 * into the iris around them — which is exactly the review's "the iris ring is
 * entirely absent" and "catch-lights ~12% of iris radius, tinted pink", both
 * measured off a *downscaled* frame. Redrawing each level with every feature
 * held above a texel floor keeps the ring and the catch-light as real, opaque,
 * full-contrast marks at the size the battle camera actually samples.
 */
const MIN_PX = Object.freeze({
  ring: 1.25, highlight: 2.0, highlightSmall: 1.1, lash: 2.5,
  pupil: 2.0, brow: 2.0, mouth: 1.5, lid: 1.0,
});

const atLeast = (v, floor) => (v < floor ? floor : v);

/**
 * ANIME_PIPELINE §1 layout table, verbatim, in fractions of the texture with
 * the origin at the top-left. The head's front UV island maps onto this square.
 *
 * The table's positions and sizes are authoritative over its prose note that
 * the gap is "one eye width" — centres 0.40 apart with 0.26-wide eyes leave a
 * gap of 0.14, and the wider-set alternative pushes the eyes off the front of
 * the skull once the UV island is projected.
 */
export const FACE_LAYOUT = Object.freeze({
  eyeY: 0.56,     // eye centre height
  eyeX: 0.30,     // inner-left eye centre; the other sits at 1 - eyeX
  eyeW: 0.26,
  eyeH: 0.30,
  browGap: 0.13,  // clearance from the eye's top edge to the brow's spine
  browW: 0.9,     // × eye width
  mouthY: 0.80,
  mouthW: 0.08,
  noseY: 0.72,
});

/**
 * Expression set. Same layout every time — only brow angle, brow height, eye
 * openness, lower-lid raise and mouth curvature move. That constraint is what
 * keeps four expressions looking like one character rather than four.
 *
 * `browTilt` is added to the roster's `browAngle` in the roster's own sign
 * convention (positive = gentle). `mouthCurve` is a fraction of the texture and
 * positive bows the mouth downward on screen, which reads as a smile.
 */
const EXPRESSIONS = Object.freeze({
  neutral:    Object.freeze({ open: 1.00, lidRaise: 0.00, browLift: 0.000, browTilt:  0.00, browThick: 1.00, mouthCurve: 0.010, mouthWidth: 1.00, pupil: 1.00 }),
  determined: Object.freeze({ open: 0.90, lidRaise: 0.06, browLift: -0.026, browTilt: -0.30, browThick: 1.10, mouthCurve: -0.005, mouthWidth: 1.15, pupil: 0.88 }),
  hurt:       Object.freeze({ open: 0.64, lidRaise: 0.24, browLift: 0.022, browTilt:  0.38, browThick: 0.94, mouthCurve: -0.022, mouthWidth: 0.92, pupil: 1.12 }),
  joy:        Object.freeze({ open: 1.05, lidRaise: 0.12, browLift: 0.030, browTilt:  0.12, browThick: 1.00, mouthCurve: 0.042, mouthWidth: 1.55, pupil: 1.06 }),
});

/** Canonical expression names, in review order. */
export const EXPRESSION_NAMES = Object.freeze(Object.keys(EXPRESSIONS));

/**
 * Eye-shape families, keyed by `roster.proportions.eyeShape`.
 *
 * The previous build derived every shape dial from a single `roundness` scalar,
 * and the review's verdict was blunt: "all six faces are the same layout
 * recoloured — same eye shape, same brow angle, same mouth arc". A scalar can
 * only slide one shape along one axis, so six characters came out as six points
 * on one line. These are four genuinely different *constructions* — a slit, a
 * raked wedge, a leaf and a circle — and they differ in aperture height, width,
 * corner drop, lid depth, tilt and iris fill at once, which is what makes them
 * read as different eyes rather than as one eye at different sizes.
 *
 * The roster already carries the key (`'narrow' | 'sharp' | 'almond' | 'round'`)
 * and documented it as intent-only. It is a real input now; `pickEyeShape`
 * still falls back to deriving a family for any entry that omits it, so the
 * roster stays the source of truth and a new character cannot crash the painter.
 *
 *   `openU` / `openL`  aperture half-heights, as fractions of the envelope
 *   `widen`            aperture width multiplier — narrow eyes are *wider* than
 *                      tall, round ones nearly circular
 *   `tilt`             rotation of the whole eye, outer corner up (radians)
 *   `irisFill`         iris diameter as a fraction of aperture width; > 1 means
 *                      the circle is deliberately clipped by the lids, which is
 *                      how an anime iris gets its size without a floating disc
 */
const EYE_SHAPES = Object.freeze({
  narrow: Object.freeze({ round: 0.05, widen: 1.12, openU: 0.60, openL: 0.60, cornerDrop: 0.21, lowerDepth: 0.46, lash: 0.215, flick: 0.34, tilt: 0.15, irisFill: 0.92 }),
  sharp:  Object.freeze({ round: 0.32, widen: 1.06, openU: 0.80, openL: 0.74, cornerDrop: 0.16, lowerDepth: 0.66, lash: 0.215, flick: 0.30, tilt: 0.11, irisFill: 0.96 }),
  almond: Object.freeze({ round: 0.62, widen: 1.00, openU: 0.90, openL: 0.86, cornerDrop: 0.11, lowerDepth: 0.80, lash: 0.195, flick: 0.18, tilt: 0.05, irisFill: 1.00 }),
  round:  Object.freeze({ round: 1.00, widen: 0.94, openU: 1.00, openL: 0.98, cornerDrop: 0.05, lowerDepth: 0.98, lash: 0.180, flick: 0.10, tilt: 0.01, irisFill: 1.04 }),
});

/**
 * Brow families, keyed by `roster.proportions.brow`.
 *
 * ANIME_PIPELINE §1: "angle carries personality: down-inner = determined,
 * up-inner = gentle, flat = cool". The roster's `browAngle` was already being
 * read, but at unity gain a 0.26 rad brow moves its inner end by 2% of the face
 * and the whole cast reads level. `gain` is the multiplier that makes the
 * roster's authored intent actually visible, and thickness/arch/height separate
 * a blunt determined brow from a fine arched one on three more channels.
 *
 *   `drop` is added *toward* the eye, so a hard brow sits low and crowds the lid.
 */
const BROW_STYLES = Object.freeze({
  hard:   Object.freeze({ thick: 0.080, arch: 0.04, tilt: -0.10, drop: 0.014, gain: 1.9, mouth: -0.006, mouthW: 1.12 }),
  level:  Object.freeze({ thick: 0.062, arch: 0.15, tilt: 0.00, drop: 0.000, gain: 1.7, mouth: 0.000, mouthW: 1.00 }),
  gentle: Object.freeze({ thick: 0.046, arch: 0.32, tilt: 0.07, drop: -0.012, gain: 1.7, mouth: 0.008, mouthW: 0.92 }),
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
 * Seren and Emrys have near-white hair, so the spec's "hair darkened 25%" brow
 * lands within a few percent of their skin and the brow — half the expression —
 * disappears at battle range. Darkening until a fixed luminance ratio is met
 * fixes that for pale hair without touching the dark-haired characters, whose
 * brows already clear the threshold on the first test.
 */
function ensureDarkerThan(hex, against, ratio) {
  const target = lumOf(against) * ratio;
  let out = hex;
  for (let i = 0; i < 8 && lumOf(out) > target; i++) out = darken(out, 0.22);
  return out;
}

/**
 * ANIME_PIPELINE §1's skin: "`#F7DCC4` warm pale as a base".
 *
 * The review sampled the lead's cheek at `#EE9070` — a saturated plastic orange
 * — because the painter used the roster's `palette.skin` neat, and those values
 * (`0xd9a882` for Auren, `0x8a5a44` for Kite) were authored as *body* tones for
 * a lit surface, not as the flat albedo of a painted face. Under the toon
 * shader's lit band they gain both value and chroma and land well outside the
 * warm-pale family the spec names.
 *
 * So the spec value is the anchor and the roster tone survives as an offset from
 * it: a heavy mix toward `#F7DCC4` plus a chroma trim. That keeps the cast's
 * skin *relationships* — Seren still reads paler than Kite, who still reads
 * darker than Auren — while putting every one of them inside the pipeline's
 * envelope instead of only near it.
 */
const SPEC_SKIN = 0xf7dcc4;
const SPEC_SKIN_SHADE = 0xe0a98f;

function paintedSkin(hex) {
  return saturate(mixHex(hex ?? SPEC_SKIN, SPEC_SKIN, 0.68), 0.87);
}

/**
 * The face's painted shadow band, held inside §2's face clamp.
 *
 * §2 asks the face's shadow term to be clamped "to a minimum of ~0.75" — a
 * *floor*, not a pin at 1.0, and the review found the face "a uniform orange
 * disc with zero form" because it was effectively pinned. The shader's floor is
 * not this module's to set; the painted band is, and a painted jaw shadow is how
 * 2D animation has always given a flat face volume anyway. This forces the band
 * colour into that same 0.75–0.90 luminance window relative to the base, so the
 * face gains form without ever carving dark.
 */
function clampShadowBand(hex, skin, lo = 0.75, hi = 0.90) {
  const base = lumOf(skin);
  let out = hex;
  for (let i = 0; i < 8 && lumOf(out) < base * lo; i++) out = mixHex(out, skin, 0.25);
  for (let i = 0; i < 8 && lumOf(out) > base * hi; i++) out = darken(out, 0.10);
  return out;
}

// ---------------------------------------------------------------- traits

/**
 * Turn a roster entry into the dozen numbers the painter needs.
 *
 * `roundness` is the master dial: 1 is a tall, soft, deeply-curved eye with a
 * heavy lash and a fine brow, 0 is a narrow, hard, shallow one with a blunt
 * brow. It is derived from the two roster fields that already encode exactly
 * that intent — a large `eye` multiplier and a gentle (positive) `browAngle`
 * both push toward round — so Seren lands at ~0.94, Emrys ~0.86, Auren ~0.26
 * and Bramm at the floor without a per-character special case anywhere.
 *
 * NOTE on the brow sign: `roster.js`'s comment says positive = "outer end
 * lifted", but its data says positive = gentle (Seren +0.14, an oracle; Bramm
 * -0.26, a grieving smith). ANIME_PIPELINE §1 defines the shapes as "down-inner
 * = determined, up-inner = gentle". The data and the pipeline agree, so the
 * convention used here is **positive raises the inner end**, and the roster's
 * prose is the thing that is wrong.
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

  const skin = paintedSkin(pal.skin);
  // §1 wants the lash "tinted toward the hair colour rather than pure #000" —
  // but Seren's and Emrys's hair shade is a *light* grey, and the naive mix
  // lifts their lash to a mid-grey that stops being the heaviest black in the
  // face. Tint, then force it back under a near-black luminance ceiling: the
  // hue survives, the weight is non-negotiable.
  const lash = ensureDarkerThan(
    mixHex(pal.lash ?? 0x14181f, pal.hairShade ?? 0x241f1c, 0.22), skin, 0.055,
  );

  const iris = pal.eye ?? 0x5fb8b0;
  const skinShade = clampShadowBand(mixHex(pal.skinShade ?? SPEC_SKIN_SHADE, SPEC_SKIN_SHADE, 0.7), skin);

  return {
    round,
    eyeScale,
    spacing: clamp(p.eyeSpacing ?? 1, 0.85, 1.2),
    browAngle,

    skin,
    skinShade,
    // §1 gives the sclera as a cool near-white ramp; the roster's per-character
    // sclera only tints it — at 0.12 rather than 0.25, because the review read
    // the old mix as "a pinkish sclera" and a warm white kills the cool-white
    // read that separates an anime eye from a plastic one.
    scleraTop: mixHex(0xf4f7fa, pal.sclera ?? 0xf2ede2, 0.12),
    scleraBottom: mixHex(0xe4eaf2, pal.sclera ?? 0xf2ede2, 0.12),
    iris,
    irisCore: pal.eyeCore ?? mixHex(iris, 0xffffff, 0.6),
    // §1's "one detail that does most of the work". A *saturated* 45% darkening
    // of the iris hue with only a trace of lash in it: mixing the ring most of
    // the way to the lash colour (what this used to do) makes a black rim that
    // merges with the lash bar under any downsample, and the eye loses the
    // concentric read that says "anime iris" rather than "amber disc".
    irisRing: mixHex(darken(saturate(iris, 1.3), 0.45), lash, 0.16),
    // Near-black. The old pupil was 18% of the way back to the iris hue and the
    // review found it "a warm brown pupil that barely separates".
    pupil: mixHex(0x07090d, iris, 0.03),
    lash,
    brow: ensureDarkerThan(darken(pal.hair ?? 0x4a3d33, 0.25), skin, 0.32),
    mouth: ensureDarkerThan(mixHex(skinShade, lash, 0.5), skin, 0.34),

    // Shape dials, now sourced from the eye-shape and brow families rather than
    // from one roundness scalar. The small jitter keeps two characters sharing
    // a family from looking rubber-stamped.
    widen: shape.widen,
    openU: shape.openU,
    openL: shape.openL,
    irisFill: shape.irisFill,
    eyeTilt: shape.tilt + rng.jitter(0.018),   // outer corner up
    cornerDrop: shape.cornerDrop,              // outer corner sits below the inner
    lowerDepth: shape.lowerDepth,              // how deep the lower lid bows
    // §1: 18–22% of eye height. Measured against the *aperture* now, not the
    // envelope, and split evenly across the lid line instead of dropping 82% of
    // it into the white — the two errors that together made the review measure
    // "roughly 45% of eye height" and call every character heavy-lidded.
    lashWeight: shape.lash + rng.jitter(0.008),
    lashFlick: shape.flick,
    browThick: browStyle.thick,                // fraction of face height
    browArch: browStyle.arch + rng.jitter(0.02),
    browDrop: browStyle.drop,                  // toward the eye
    mouthCurveBias: browStyle.mouth,
    mouthWidthBias: browStyle.mouthW,
    highlightJitter: rng.jitter(0.04),
    // A nose dot is invisible at battle range and only ever reads in a portrait.
    // The two youngest faces go without: absence of a nose is a childhood cue.
    nose: eyeScale < 1.05,
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
 * the "smiling eyes" of joy and determination) be independent without moving
 * the iris — the iris keeps the full-open size and is simply occluded more.
 */
function eyeGeometry(hw, hu, hl, t) {
  const inY = -hu * t.cornerDrop * 0.55;
  const outY = hl * t.cornerDrop;
  // Sharp eyes put the apex further inboard, which lengthens the outer half
  // into a taper; round eyes keep it near the middle for a dome.
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
 * Straight `lineTo` chains facet visibly on a 30 px-thick black bar; this costs
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
 * The lash bar's thickness profile along the spine: thin where it leaves the
 * inner corner, heaviest just past the apex, still heavy at the outer corner,
 * then tapering to a point through the flick. This asymmetry — heavy outer,
 * light inner — is what gives an anime eye its direction.
 */
function lashProfile(s, flick) {
  if (s <= 1) {
    const a = clamp01(s / 0.42);
    const rise = lerp(0.30, 1, a * a * (3 - 2 * a));
    const fall = 1 - 0.16 * clamp01((s - 0.55) / 0.45);
    return rise * fall;
  }
  const k = clamp01((s - 1) / Math.max(flick, 1e-3));
  return 0.84 * (1 - k) * (1 - k);
}

// ------------------------------------------------------------------ painting

/**
 * One eye, drawn back to front exactly as ANIME_PIPELINE §1 orders it.
 * Called with the context already translated to the eye centre and mirrored so
 * that +x points at the outer corner.
 */
function drawEye(ctx, t, x, S) {
  // The whole eye rotates: outer corner up. Tilt is one of the strongest
  // identity channels an anime face has and the previous build had none of it,
  // which is half of why the review saw "the same eye shape" six times.
  ctx.save();
  ctx.rotate(-t.eyeTilt);

  const hw = (FACE_LAYOUT.eyeW * t.eyeScale * t.widen * S) / 2;
  const hh = (FACE_LAYOUT.eyeH * t.eyeScale * S) / 2;
  // The 0.26 × 0.30 cell from the layout table is the eye's *envelope* — lash
  // bar included. The aperture inside it is set by the shape family: a narrow
  // eye opens to 60% of the envelope and comes out well wider than tall, a
  // round one opens to nearly all of it and comes out near-circular.
  const hu0 = hh * t.openU;
  const hl0 = hh * t.openL;
  const hu = hu0 * x.open;
  const hl = hl0 * (1 - x.lidRaise);
  const g = eyeGeometry(hw, hu, hl, t);
  const flickLen = hw * t.lashFlick * 2;

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
  ctx.fillRect(-hw * 1.6, -hh * 1.8, hw * 3.2, hh * 3.6);

  // 2 — iris. Sized against the aperture *width* and deliberately allowed to
  // run past the lids, which the clip then cuts: that is how an anime iris gets
  // to be enormous without turning into a floating disc with white all round
  // it. The cap keeps a slit eye's circle from outgrowing its own aperture.
  // Deriving it from the full-open aperture rather than the current one is what
  // lets a squint occlude the iris instead of shrinking it.
  const irisR = Math.min(hw * t.irisFill * 0.92, (hu0 + hl0) * 0.60);
  const ix = -hw * 0.03;
  const iy = hh * 0.02;
  const ig = ctx.createLinearGradient(0, iy - irisR, 0, iy + irisR);
  // The dark top band is the lash's cast shadow. Kept short and no longer
  // near-black — run it deep and the eye reads heavy-lidded, which is the note
  // the review wrote against every character in the party.
  ig.addColorStop(0, cssHex(darken(mixHex(t.iris, t.lash, 0.34), 0.04)));
  ig.addColorStop(0.34, cssHex(saturate(t.iris, 1.15)));
  ig.addColorStop(0.62, cssHex(saturate(t.iris, 1.32)));
  ig.addColorStop(1, cssHex(mixHex(t.iris, t.irisCore, 0.55)));
  ctx.fillStyle = ig;
  ctx.beginPath();
  ctx.arc(ix, iy, irisR, 0, Math.PI * 2);
  ctx.fill();

  // 3 — the darker iris ring. §1: "this one detail does most of the work".
  // 12% of the iris radius with a texel floor, so it is still a ring and not a
  // smudge at the mip level the battle camera samples.
  const ringW = atLeast(irisR * 0.12, MIN_PX.ring);
  ctx.strokeStyle = cssHex(t.irisRing);
  ctx.lineWidth = ringW;
  ctx.beginPath();
  ctx.arc(ix, iy, irisR - ringW * 0.5, 0, Math.PI * 2);
  ctx.stroke();

  // 4 — pupil: 35% of the iris width, taller than wide, and near-black.
  const pupilR = atLeast(irisR * 0.35 * x.pupil, MIN_PX.pupil);
  ctx.fillStyle = cssHex(t.pupil);
  ctx.beginPath();
  ctx.ellipse(ix, iy, pupilR, pupilR * 1.28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 5 — the upper lash bar. Deliberately *outside* the clip: it has to overhang
  // the outer corner, and it is the heaviest black in the face.
  const lashTh = atLeast((hu0 + hl0) * t.lashWeight, MIN_PX.lash);
  const spine = samplePolyline((s, o) => lidPoint(g, s, flickLen, o), 0, 1 + t.lashFlick, 30);
  const top = [];
  const bot = [];
  for (let i = 0; i < spine.length; i++) {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(spine.length - 1, i + 1)];
    let nx = b.y - a.y;
    let ny = -(b.x - a.x);
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    const th = lashTh * lashProfile((i / (spine.length - 1)) * (1 + t.lashFlick), t.lashFlick);
    // Straddle the lid line, 45% above and 55% below. The old 18/82 split
    // dropped nearly the whole bar into the aperture, so a lash specified at
    // ~20% of eye height ate close to half the visible eye — the review's
    // "every character reads heavy-lidded and sullen". Sitting on the line
    // keeps the ink weight while giving the white back.
    top.push({ x: spine[i].x + nx * th * 0.45, y: spine[i].y + ny * th * 0.45 });
    bot.push({ x: spine[i].x - nx * th * 0.55, y: spine[i].y - ny * th * 0.55 });
  }
  ctx.fillStyle = cssHex(t.lash);
  ctx.beginPath();
  smoothPath(ctx, top);
  bot.reverse();
  smoothPath(ctx, bot, false);
  ctx.closePath();
  ctx.fill();

  ctx.save();
  aperture();
  ctx.clip();

  // 6 — lower lid: thin, soft, and only along the outer half. Any heavier and
  // it stops reading as a lid and starts reading as an eye bag.
  ctx.strokeStyle = cssRgba(mixHex(t.lash, t.skinShade, 0.42), 0.7);
  ctx.lineWidth = atLeast(hh * 2 * 0.035, MIN_PX.lid);
  ctx.lineCap = 'round';
  ctx.beginPath();
  smoothPath(ctx, samplePolyline((s, o) => lowerPoint(g, s, o), 0.03, 0.48, 10));
  ctx.stroke();

  // 7 — highlights. §1 puts the large one at 22% of the iris radius, fully
  // opaque white, in the upper-*outer* quadrant, with a smaller lower-inner
  // companion. Drawn dead last, with `globalAlpha` and the composite mode
  // reset, so nothing above can tint them — the review measured them as pink,
  // which is what a catch-light becomes once anything is allowed to blend over
  // it or once a box-filtered mip averages it into the iris.
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(ix + irisR * (0.36 + t.highlightJitter), iy - irisR * 0.38, atLeast(irisR * 0.24, MIN_PX.highlight), 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ix - irisR * 0.38, iy + irisR * (0.46 - t.highlightJitter), atLeast(irisR * 0.11, MIN_PX.highlightSmall), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

/**
 * One brow: a short tapered stroke, thick at the inner end. Built as two
 * offset quadratics rather than a stroked line so the taper is real — a
 * constant-width brow reads as a marker mark, not a brow.
 *
 * Drawn in the same mirrored frame as the eye, so -x is the inner end.
 */
function drawBrow(ctx, t, x, halfW, S) {
  // The brow follows the eye's tilt at reduced gain: locking it level while the
  // eye rakes reads as a mistake, matching it exactly reads as a decal.
  ctx.save();
  ctx.rotate(-t.eyeTilt * 0.6);

  const bw = halfW * 2 * FACE_LAYOUT.browW;
  const th = atLeast(t.browThick * S * x.browThick, MIN_PX.brow);
  // Positive angle raises the inner end (see the sign note in `faceTraits`).
  const ang = t.browAngle + x.browTilt;
  const inX = -bw / 2;
  const outX = bw / 2;
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
  const tIn = th * 0.5;
  const tMid = th * 0.42;
  const tOut = th * 0.06;

  ctx.fillStyle = cssHex(t.brow);
  ctx.beginPath();
  ctx.moveTo(inX + nIn.x * tIn, inY + nIn.y * tIn);
  ctx.quadraticCurveTo(cx + nMid.x * tMid, cy + nMid.y * tMid, outX + nOut.x * tOut, outY + nOut.y * tOut);
  ctx.lineTo(outX - nOut.x * tOut, outY - nOut.y * tOut);
  ctx.quadraticCurveTo(cx - nMid.x * tMid, cy - nMid.y * tMid, inX - nIn.x * tIn, inY - nIn.y * tIn);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * The mouth: one curve, nothing else. §1 is explicit that any more detail —
 * lips, teeth, an outlined opening — breaks the style on sight.
 */
function drawMouth(ctx, t, x, S) {
  // Width and curvature carry the same personality the brow does — a hard brow
  // gets a wider, flatter, slightly downturned line, a gentle one a shorter and
  // softly upturned arc — so the six mouths are not one stamp at six hues.
  const w = FACE_LAYOUT.mouthW * S * x.mouthWidth * t.mouthWidthBias;
  const y = FACE_LAYOUT.mouthY * S;
  const c = (x.mouthCurve + t.mouthCurveBias) * S;
  ctx.strokeStyle = cssHex(t.mouth);
  ctx.lineWidth = atLeast(S * 0.014, MIN_PX.mouth);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(S * 0.5 - w / 2, y - c * 0.25);
  ctx.quadraticCurveTo(S * 0.5, y + c * 2, S * 0.5 + w / 2, y - c * 0.25);
  ctx.stroke();
}

/**
 * Paint a complete face into `ctx`, filling the square `[0,size]²`.
 *
 * Exported separately from `buildFaceTexture` so the same drawing can go into
 * an atlas cell: translate the context to the cell origin and call this with
 * the cell's edge length.
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

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Flat skin, then **one painted cel band**. ANIME_PIPELINE §1 gives the base
  // as a single warm-pale value and §2 clamps the face's *shader* shadow to a
  // 0.75 floor — which left the face with no form at all, and the review read
  // it as "a uniform orange disc". The band below is the painted half of that
  // contract: a jaw-and-temple shadow in the spec's warm rose-tan, held inside
  // the same 0.75–0.90 window by `clampShadowBand`, with a terminator 5% of the
  // radius wide so it is a hard cel edge rather than a PBR gradient.
  //
  // Geometry is an ellipse centred above the eye line: it closes under the jaw
  // and wraps the temples where the skull turns away, and stays inside 86% of
  // the plate radius, past which `CharacterFactory`'s face plate is buried in
  // the skull and nothing painted here would be visible anyway.
  if (opts.background !== false) {
    ctx.fillStyle = cssHex(t.skin);
    ctx.fillRect(0, 0, S, S);

    // Half-axes 0.52 × 0.50 of the square about (0.50, 0.38): the terminator
    // crosses the centre line at y ≈ 0.82 — below the mouth at 0.80, above the
    // plate's buried rim — and grazes the temples just outside the eye cells.
    const bandR = S * 0.52;
    ctx.save();
    ctx.translate(S * 0.5, S * 0.38);
    ctx.scale(1, 1.04);
    const band = ctx.createRadialGradient(0, 0, 0, 0, 0, bandR);
    band.addColorStop(0, cssRgba(t.skinShade, 0));
    band.addColorStop(0.88, cssRgba(t.skinShade, 0));
    band.addColorStop(0.94, cssRgba(t.skinShade, 1));
    band.addColorStop(1, cssRgba(t.skinShade, 1));
    ctx.fillStyle = band;
    ctx.fillRect(-S, -S, S * 2, S * 2);
    ctx.restore();
  }

  // Cheek blush: a painted mark on the cheekbone, warm and tight. It sits
  // *below* the eye's envelope on purpose — overlapping it reads as an
  // under-eye shadow, which is the grubby, smudged look the brief forbids.
  // Pushed toward rose rather than using `skinShade` neat, because the shade
  // tone is a shadow colour and a shadow on a cheek is not a blush.
  const blush = mixHex(t.skinShade, 0xff6a5e, 0.38);
  const blushR = S * 0.085;
  for (const side of [-1, 1]) {
    const bx = S * (0.5 + side * 0.315);
    const by = S * 0.745;
    const bg = ctx.createRadialGradient(bx, by, 0, bx, by, blushR);
    bg.addColorStop(0, cssRgba(blush, 0.13));
    bg.addColorStop(0.6, cssRgba(blush, 0.06));
    bg.addColorStop(1, cssRgba(blush, 0));
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.ellipse(bx, by, blushR, blushR * 0.66, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const halfSpanX = (0.5 - FACE_LAYOUT.eyeX) * t.spacing;
  const halfW = (FACE_LAYOUT.eyeW * t.eyeScale * t.widen * S) / 2;
  const halfH = (FACE_LAYOUT.eyeH * t.eyeScale * S) / 2;
  const eyeCy = FACE_LAYOUT.eyeY * S;
  // `browDrop` is the family's own height offset — a hard brow crowds the lid,
  // a gentle one sits high and clear of it.
  const browY = eyeCy - halfH - (FACE_LAYOUT.browGap + x.browLift - t.browDrop) * S;

  for (const side of [-1, 1]) {
    const cx = S * (0.5 + side * halfSpanX);
    // Mirroring is what lets both eyes and both brows come from one authored
    // shape with "+x is outboard" — the alternative is every sign written twice.
    ctx.save();
    ctx.translate(cx, eyeCy);
    ctx.scale(side, 1);
    drawEye(ctx, t, x, S);
    ctx.restore();

    ctx.save();
    ctx.translate(cx, browY);
    ctx.scale(side, 1);
    drawBrow(ctx, t, x, halfW, S);
    ctx.restore();
  }

  // Nose: at most a dot, per §1's layout table. It exists for portrait range
  // and is deliberately below the threshold of visibility in battle.
  if (t.nose) {
    ctx.fillStyle = cssRgba(t.skinShade, 0.55);
    ctx.beginPath();
    ctx.ellipse(S * 0.5, FACE_LAYOUT.noseY * S, S * 0.010, S * 0.007, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawMouth(ctx, t, x, S);
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
  const w = FACE_LAYOUT.eyeW * t.eyeScale * t.widen;
  const h = FACE_LAYOUT.eyeH * t.eyeScale;
  return {
    eyeCenterY: FACE_LAYOUT.eyeY,
    eyeHalfSpan: (0.5 - FACE_LAYOUT.eyeX) * t.spacing,
    eyeWidth: w,
    eyeHeight: h,
    eyeTilt: t.eyeTilt,
    browY: FACE_LAYOUT.eyeY - h / 2 - (FACE_LAYOUT.browGap + x.browLift - t.browDrop),
    mouthY: FACE_LAYOUT.mouthY,
    roundness: t.round,
    skin: t.skin,
    lash: t.lash,
  };
}

// ------------------------------------------------------------------ textures

/**
 * Texture cache. Faces are immutable per (character, expression, size), the
 * roster is frozen, and a party of four with four expressions is sixteen 512²
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
 * This is the real fix for the review's "under-resolved for the closeup camera
 * … the iris ring is entirely absent". Both notes were measured off a frame in
 * which the face plate was minified, so the GPU was sampling a mip — and a
 * box-filtered mip is precisely a machine for destroying a 12%-wide ring, a 22%
 * catch-light and a hard lash edge, because averaging is what it does. Neither
 * a bigger level 0 nor `LinearFilter` alone can help: level 0 is not the level
 * being read.
 *
 * Redrawing every level from the same vector description, with each feature
 * held above `MIN_PX` texels, means the 128² mip the battle camera actually
 * samples is itself a crisp painted face — ring present, catch-light opaque,
 * lash still the heaviest black — rather than an average of one. A complete
 * chain down to 1×1 is emitted so the texture is mip-complete under both of
 * three's upload paths (`texStorage2D` sizes its allocation from this length).
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
 * Every expression for one character, keyed by name — what a character rig
 * wants to hold so swapping expressions is a material `map` assignment with no
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
 * Rows are characters and columns expressions, so a reviewer reads identity
 * down and performance across — the two questions the review actually asks
 * ("are these six different people?", "does hurt read as hurt?").
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
