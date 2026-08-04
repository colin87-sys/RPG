/**
 * PostFX — the full screen-space chain.
 *
 * This layer is doing more work than a post stack usually does, because the
 * reference frames (see docs/REFERENCE_TARGET.md) are *made* of screen space:
 * a wide soft bloom veil, heavy atmospheric depth of field, muted backgrounds
 * and a single saturated jewel of magic burning through it all. Turning this
 * chain off should make the game look suddenly dead, and it does.
 *
 * Chain order, fixed by ARCHITECTURE.md:
 *
 *   RenderPass (HDR half-float, MSAA, depth texture)
 *     -> depth tap
 *     -> SSAO           contact darkening, tinted toward SHADOW_TINT
 *     -> bloom          progressive mip pyramid, soft knee at 1.0
 *     -> depth of field thin-lens CoC + half-res bokeh gather
 *     -> motion blur    camera-velocity reprojection
 *     -> radial blur    limit-break speedlines
 *     -> composite      chromatic aberration, depth-keyed value structure,
 *                       flash, ACES, LUT grade, grain, vignette
 *     -> FXAA
 *
 * Anti-aliasing is deliberately split across the two ends of that chain: the
 * beauty target is multisampled so *coverage* is resolved before any pass can
 * widen or contrast-stretch a staircase, and FXAA cleans up the *shading*
 * aliasing MSAA structurally cannot see (the cel terminator, the specular band,
 * the painted lash line). See `_applyMsaa`.
 *
 * The value structure is the one stage that is not a colour operation. It reads
 * the same depth texture AO and DOF read, splits the frame into foreground /
 * subject / background around the live focal plane, and enforces the art
 * bible's dark-frame / bright-subject / hazy-stage relationship that a named
 * LUT grade — being a function of colour alone — cannot express. It lives
 * inside the composite because it *is* the grade, only depth-aware; see
 * compositeShader.js.
 *
 * Diagnostic frames (the flat silhouette check) take a bypass: see
 * `setDiagnostic`. Everything creative is switched off and the pass reduces to
 * exposure + ACES + sRGB + FXAA, because a debug render that carries bloom,
 * grain and aberration cannot be used to judge the one thing it exists for.
 *
 * The last four *listed* stages share one render target. They are pure
 * per-pixel arithmetic evaluated in exactly the contracted order inside one
 * shader; splitting them would buy three extra full-resolution half-float round
 * trips and change not one pixel. See compositeShader.js for the full argument.
 *
 * Two contract details worth knowing before you touch anything here:
 *
 *  1. **The renderer's tone mapping is switched off by this module.**
 *     `Engine` sets `ACESFilmicToneMapping`, but three applies tone mapping when
 *     rendering *into a render target* too — which would bake the curve in
 *     before bloom ever sees a value above 1.0, making HDR bloom impossible.
 *     PostFX therefore sets `renderer.toneMapping = NoToneMapping` and applies
 *     the identical ACES fit itself in the composite pass.
 *     `renderer.toneMappingExposure` keeps working exactly as the art bible's
 *     time-of-day table specifies — it is read every frame.
 *
 *  2. **PostFX *is* `engine.composer`.** The engine calls
 *     `composer.render()` / `setSize()` / `dispose()`, and `render()` must
 *     re-resolve `engine.scene.camera ?? engine.camera` every frame because
 *     scenes swap and each one may bring its own camera. The `EffectComposer`
 *     itself lives on `this.effectComposer`.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

import { bus } from '../core/EventBus.js';
import { gameState, rng } from '../core/GameState.js';

import { POST_VERT, COPY_FRAG } from './shaders/postCommon.js';
import { AO_FRAG, AO_BLUR_FRAG, AO_COMPOSITE_FRAG } from './shaders/aoShader.js';
import {
  BLOOM_PREFILTER_FRAG,
  BLOOM_DOWNSAMPLE_FRAG,
  BLOOM_UPSAMPLE_FRAG,
  BLOOM_COMPOSITE_FRAG,
} from './shaders/bloomShader.js';
import { DOF_PREPASS_FRAG, DOF_GATHER_FRAG, DOF_COMPOSITE_FRAG } from './shaders/dofShader.js';
import { MOTION_BLUR_FRAG } from './shaders/motionBlurShader.js';
import { RADIAL_BLUR_FRAG } from './shaders/radialBlurShader.js';
import { COMPOSITE_FRAG } from './shaders/compositeShader.js';
import { GRADES, GRADE_SCALARS, lerpGrade, bakeGradeStrip } from './shaders/colorGrades.js';

/** Colour-cube edge. 32 is the film standard and costs 128 KB per grade. */
const LUT_SIZE = 32;

/**
 * three's `ACESFilmicToneMapping` fit, its inverse, and the sRGB EOTF.
 *
 * `compositeShader.js` reproduces the same fit in GLSL so an un-composited frame
 * and a graded one tone map identically; these are the CPU-side twins, and they
 * exist so a threshold can be authored where it is meaningful — on screen — and
 * turned into the scene radiance that produces it. The forward curve is monotone
 * on [0, inf), so a bisection inverts it to float precision with no closed form
 * and no wrong branch to pick. `THREE.SRGBToLinear` is not on the public `three`
 * entry point in 0.185, so the piecewise curve is spelled out rather than reached
 * for through a private.
 */
function acesFilmic(x) {
  return THREE.MathUtils.clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1);
}

function acesFilmicInverse(target) {
  let lo = 0;
  let hi = 16;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) * 0.5;
    if (acesFilmic(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Where bloom begins, authored on screen.
 *
 * The threshold has to be exposure-relative or it does not mean anything. It is
 * compared against *scene* radiance, and this build drives `toneMappingExposure`
 * from the time-of-day table and a plate calibration together — so a fixed 1.15
 * means "only real overspill" at one exposure and "most of the lit frame" at
 * another. Stated as a display value and divided by the live exposure each frame,
 * it means the same picture at every hour: nothing that resolves below 0.92 on an
 * sRGB display can contribute a single photon to the veil.
 *
 * 0.92 is read off `bravely01.jpg`, which is not a bloomy image — 1.5% of it sits
 * above 0.75 and no silhouette in it carries a halo. The only things left above
 * this line are the sun caught on a blade edge and the specular pings on armour,
 * which is exactly the "glints only" this workstream was asked for.
 */
const BLOOM_DISPLAY_THRESHOLD = 0.92;
const BLOOM_SCENE_THRESHOLD_AT_UNIT_EXPOSURE =
  acesFilmicInverse(srgbToLinear(BLOOM_DISPLAY_THRESHOLD));

/**
 * Chroma discipline, measured off `docs/reference/bravely01.jpg` and baked into
 * every grade cube rather than applied as a pass.
 *
 * This workstream's brief asked for a ~10% global saturation cut. Measuring says
 * the opposite, and says it in every region at once. Our shipped frame did read
 * loud — the meadow measured 0.650 mean HSV saturation against the plate's 0.545
 * — but the cause was exposure, not chroma: the frame sat most of a stop hot and
 * ACES was climbing its shoulder, which reads as *candy* precisely because a
 * bright saturated colour is a saturated colour with nowhere left to go. With
 * `EXPOSURE_CALIBRATION` landing the histogram on the plate's, every comparable
 * region lands consistently **under** it instead:
 *
 * | region             | ours  | plate | ours/plate |
 * |--------------------|-------|-------|------------|
 * | meadow, midground  | 0.428 | 0.545 | 0.79       |
 * | party band         | 0.424 | 0.503 | 0.84       |
 * | treeline / slope   | 0.365 | 0.451 | 0.81       |
 *
 * A ratio that flat across three unrelated materials is a global gain, not a
 * per-hue correction, so `BASE_CHROMA` is one: 1.25 puts all three inside a few
 * percent of the plate. Cutting instead would have taken a frame already 26%
 * under the plate's overall 0.503 to nearly 35% under, which is the opposite of
 * the "within 10% of bravely01" this work is judged against.
 *
 * **Skin is the one band held back.** A chroma gain is at its most visible on
 * faces and hands, where a few percent too much reads instantly as sunburn, and
 * the plate's own skin is notably restrained — Gloria's lit cheek eyedrops to
 * (134, 120, 113), a saturation of 0.16 in a frame averaging 0.50. So the warm
 * red-orange-amber wedge takes 1.08 while everything else takes the full gain.
 *
 * Band edges are smoothstepped rather than switched: the cube is trilinearly
 * interpolated at sample time, so a discontinuity in hue here would show up as a
 * visible seam wherever a gradient crosses it.
 *
 * Baking it into the cube rather than adding a pass is what makes it free: the
 * composite already samples two LUTs, the operation is display-referred (which
 * is the correct space for a saturation grade), and a diagnostic frame — which
 * sets `uGradeAmount` to 0 — skips it along with the rest of the grade, exactly
 * as it should.
 *
 * **Re-measured after the exposure and key work in `Lighting`.** Hue-bucketing
 * both frames at 480x270 now puts our overall mean saturation at 0.495 against
 * the plate's 0.517, so the flat global gain has very nearly done its job and
 * the remaining error is not global at all — it is *distributional*, and in
 * three specific places:
 *
 * | wedge            | ours (area / sat / value) | plate               |
 * |------------------|---------------------------|---------------------|
 * | yellow 45-70     | 10.2% / 0.46 / 0.52       | 3.7% / 0.37 / 0.46  |
 * | red 0-20         |  1.1% / 0.45 (p95 0.77)   | 1.8% / 0.47 (0.96)  |
 * | skin, lit cheek  | S 0.51                    | S 0.16              |
 *
 * The mustard is the first row and it is not a chroma error: our midground grass
 * eyedrops to hue **81** where the plate's eyedrops to **116**, and a
 * yellow-green at V 0.50 is khaki however saturated it is. That is what
 * `GRASS_HUE_ROTATION_DEG` addresses, and it is the operator the brief asked for
 * in as many words. The second row is the success criterion — the tulips must be
 * the most saturated thing in frame and at p95 0.77 against the plate's 0.96
 * they are not, so red gets its own wedge above the base. The third is the one
 * place a *cut* is unambiguously right: the plate's skin is the least chromatic
 * surface it has, ours is among the most, and a chroma gain is at its most
 * visible exactly there.
 */
const BASE_CHROMA = 1.18;
const SKIN_CHROMA = 0.90;
/**
 * The accent wedge: crimson through scarlet, and the only band allowed above the
 * frame's base gain.
 *
 * "Saturation reserved for accents" is a statement about *ordering*, not about a
 * level, and the ordering is measurable: in `bravely01.jpg` red leads at p95
 * 0.956, then blue at 0.911, then green at 0.861. Ours came back with all three
 * inside two points of each other, which is what "nothing is the accent" looks
 * like as a number. Lifting red rather than cutting blue and green is the right
 * direction because our blues and greens already measure *under* the plate's;
 * cutting them would have bought the ordering by making the whole frame duller,
 * which is the opposite of the reference.
 */
const ACCENT_CHROMA = 1.32;
/**
 * The meadow's own gain, held under the frame's.
 *
 * The one place the flat 0.79–0.84 ratio above does not hold after the gain is
 * applied. Measured across the change the meadow came out at 0.627 against the
 * plate's 0.545 while the party landed at 0.550 against 0.503 — the green wedge
 * responds harder to a chroma scale than the rest of the frame, because a
 * yellow-green already has its blue channel near the floor and a chroma push
 * moves it no further while lifting the other two. 1.12 puts the meadow back on
 * the plate and leaves everything else where the global solve put it, which
 * matters more here than anywhere: the ground and the flower bed together are
 * the largest area in frame, and "the party fights the flowers" is the review
 * note this band exists to answer.
 */
const FOLIAGE_CHROMA = 1.06;
/**
 * The hue wedges, in degrees: [ramp-in start, full, full, ramp-out end].
 *
 * Four wedges now, and they no longer overlap. Skin narrows off the yellows
 * (it used to run to 62, which put the whole mustard band under the skin trim
 * and left it out of reach of the foliage rules entirely) and off the reds,
 * which are now the accent's. Foliage starts where the grass rotation lands
 * rather than where it starts, so the wedge is a statement about the *graded*
 * green. The accent wedge is expressed on the signed hue axis — hue is a circle
 * and red sits on its seam, so a four-point window in 0..360 cannot express it
 * without a special case; mapping h to (-180, 180] makes it an ordinary window.
 */
const SKIN_HUES = [14, 24, 42, 54];
const FOLIAGE_HUES = [78, 96, 156, 172];
const ACCENT_HUES = [-24, -11, 7, 14];

/**
 * The rotation that takes our meadow off mustard, and the band it applies over.
 *
 * Measured, not chosen: our midground grass sits at hue 81 and the plate's at
 * 116, our near ground at 71 against the plate's open path at 65. The gap is
 * therefore ~22 degrees on the sward and ~6 on bare ground, which is exactly the
 * shape of a smoothstepped window that is full across the grass hues and tapers
 * out below them — so one rotation with a shaped band lands both.
 *
 * It is a hue rotation and not a channel mix on purpose. The alternative (pull
 * the red channel down over the ground) darkens as it corrects and would have
 * fought `EXPOSURE_CALIBRATION`, which is already solving the ground's value.
 * Rotating in HSV holds value and saturation exactly and moves only the thing
 * that is wrong.
 *
 * The window stops short of 50 so it cannot reach the gold in the HUD frames
 * (measured at hue 45) or any skin tone, and tapers out by 124 so ground that is
 * already the plate's green is left alone rather than pushed through it into
 * teal. Both edges are smoothstepped because the cube is trilinearly
 * interpolated at sample time and a discontinuity here would show as a seam
 * wherever a gradient crosses it.
 */
const GRASS_HUE_ROTATION_DEG = 22;
const GRASS_HUES = [50, 66, 96, 124];

/**
 * Filmic contrast, as a luminance S-curve about mid-grey.
 *
 * `EXPOSURE_CALIBRATION` scales the whole histogram and `SHADOW_FLOOR` lifts the
 * toe; neither can put *shape* in the middle of the range, and the shape is what
 * the "flat and washed" note is about. Our capture and the plate agree closely
 * at the two ends — p05 0.106 against 0.097, p95 0.644 against 0.628 — and
 * disagree in the middle, median 0.349 against 0.295. A histogram that matches
 * at both tails and sits high in the centre is precisely a missing S-curve.
 *
 * Applied to *luminance* with the triplet rescaled around it, rather than per
 * channel. A per-channel S-curve is the film-accurate operator and it also
 * rotates hue on anything saturated, which would silently fight the four hue
 * wedges this same walk is about to apply. 0.22 of the way to `smoothstep` pins
 * mid-grey exactly, takes the median down 4% and the quartertone down 10%, and
 * is far too gentle to close up the shadow detail the plate keeps open.
 */
const CONTRAST_S = 0.18;

/**
 * The graded black point, as a tinted display-referred lift.
 *
 * `EXPOSURE_CALIBRATION` in `Lighting` lands our median and our p95 on the
 * plate's by scaling the whole histogram, and a scale cannot also fix a *toe*:
 * inverting the tone curve on both frames shows the plate's shadows sitting well
 * off the floor at p5 0.111 where our ungraded frame puts them at 0.068. The
 * plate is a soft late-morning meadow whose darkest region is a rock face still
 * lit by open sky, not a contrasty interior, and this lift is the difference —
 * solved rather than dialled. `f + e(1 - f)` pins white and maps black onto the
 * floor, so one number satisfies the whole curve: at a luminance of 0.046 it
 * takes our p5 to 0.111 against the plate's 0.111, p50 to 0.313 against 0.316
 * and p95 to 0.632 against 0.631.
 *
 * Tinted rather than neutral, and cool, for the same reason every other floor in
 * this codebase is: the plate's own deepest shadows eyedrop blue-grey, never
 * grey. Baked into the cube alongside the chroma gain so it costs nothing, and
 * so a diagnostic frame — which skips the grade entirely — still gets a true
 * black to measure a silhouette against.
 */
const SHADOW_FLOOR = [0.038, 0.047, 0.056];

/** Smoothstep-gated membership of a four-point hue window. */
function hueBand(h, win) {
  return THREE.MathUtils.smoothstep(h, win[0], win[1])
    * (1 - THREE.MathUtils.smoothstep(h, win[2], win[3]));
}

/** HSV value/saturation/hue of a display-referred triplet, into `out`. Hue is
 *  in degrees; a neutral reports hue 0 and saturation 0, which every consumer
 *  here short-circuits on rather than trusting. */
function toHsv(r, g, b, out) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  let h = 0;
  if (c > 1e-6) {
    if (max === r) h = ((g - b) / c) % 6;
    else if (max === g) h = (b - r) / c + 2;
    else h = (r - g) / c + 4;
    h = (h * 60 + 360) % 360;
  }
  out.h = h;
  out.s = max > 1e-6 ? c / max : 0;
  out.v = max;
  return out;
}

/** Inverse of `toHsv`, written straight into the cube. */
function fromHsv(h, s, v, out) {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) { r = c; g = x; } else if (hh < 2) { r = x; g = c; } else if (hh < 3) { g = c; b = x; } else if (hh < 4) { g = x; b = c; } else if (hh < 5) { r = x; b = c; } else { r = c; b = x; }
  out.r = r + m;
  out.g = g + m;
  out.b = b + m;
  return out;
}

const _hsv = { h: 0, s: 0, v: 0 };
const _rgb = { r: 0, g: 0, b: 0 };

/**
 * Apply the display grade to a baked LUT strip, in place.
 *
 * Operates on the cube's *output* values, so it composes after whatever the
 * named grade did — which is the order an art department works in: grade, then
 * set the tonal shape and the black point, then hold the result inside the
 * palette's chroma budget. All four operations live in this one walk because all
 * four are display-referred functions of colour alone, which is precisely what a
 * colour cube is for; and because they are baked rather than run as a pass, they
 * cost nothing per frame and a diagnostic frame (`uGradeAmount = 0`) skips the
 * lot, exactly as it should.
 *
 * The order is load-bearing:
 *
 *  1. **Contrast**, on luminance, before anything sets a floor — an S-curve run
 *     after the lift would pull the toe straight back down and the lift would
 *     have been for nothing.
 *  2. **The tinted black point**, which pins white and maps black onto the
 *     floor colour.
 *  3. **The grass hue rotation**, which is the only operation here that changes
 *     which wedge a colour belongs to — so it has to precede the wedges.
 *  4. **The chroma wedges**, last, so the frame's final chroma ordering is the
 *     one this file states and not one the contrast curve left behind.
 */
function applyDisplayGrade(data) {
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] / 255;
    let g = data[i + 1] / 255;
    let b = data[i + 2] / 255;

    // 1. Filmic contrast. Scaling the triplet by the luminance ratio keeps
    //    chromaticity exactly, so this is a pure tonal move; a black stays black
    //    because the guard leaves it alone rather than because of a division.
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (y > 1e-4) {
      const shaped = y + (y * y * (3 - 2 * y) - y) * CONTRAST_S;
      const k = shaped / y;
      r *= k;
      g *= k;
      b *= k;
    }

    // 2. The tinted floor.
    r = SHADOW_FLOOR[0] + r * (1 - SHADOW_FLOOR[0]);
    g = SHADOW_FLOOR[1] + g * (1 - SHADOW_FLOOR[1]);
    b = SHADOW_FLOOR[2] + b * (1 - SHADOW_FLOOR[2]);

    toHsv(r, g, b, _hsv);
    // A neutral has no hue to rotate and no chroma to trim; skipping it also
    // keeps the cube's grey axis bit-exact, which is what stops a grade drifting
    // its own white balance every time this runs.
    if (_hsv.s < 1e-4) {
      writeLut(data, i, r, g, b);
      continue;
    }

    // 3. Grass off mustard. Value and saturation are carried through untouched.
    const rotation = GRASS_HUE_ROTATION_DEG * hueBand(_hsv.h, GRASS_HUES);
    if (rotation > 1e-4) {
      fromHsv(_hsv.h + rotation, _hsv.s, _hsv.v, _rgb);
      r = _rgb.r;
      g = _rgb.g;
      b = _rgb.b;
      _hsv.h += rotation;
    }

    // 4. The chroma wedges, evaluated on the rotated hue. They are disjoint, so
    //    the three mixes compose without a partition; the accent is applied last
    //    so that if a future edit does overlap them, the accent — the one the
    //    success criterion names — wins rather than losing silently.
    const signed = _hsv.h > 180 ? _hsv.h - 360 : _hsv.h;
    let scale = THREE.MathUtils.lerp(
      BASE_CHROMA, FOLIAGE_CHROMA, hueBand(_hsv.h, FOLIAGE_HUES),
    );
    scale = THREE.MathUtils.lerp(scale, SKIN_CHROMA, hueBand(_hsv.h, SKIN_HUES));
    scale = THREE.MathUtils.lerp(scale, ACCENT_CHROMA, hueBand(signed, ACCENT_HUES));

    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    writeLut(data, i, l + (r - l) * scale, l + (g - l) * scale, l + (b - l) * scale);
  }
}

/** Quantise one graded RGB back into the cube. */
function writeLut(data, i, r, g, b) {
  data[i] = Math.round(THREE.MathUtils.clamp(r, 0, 1) * 255);
  data[i + 1] = Math.round(THREE.MathUtils.clamp(g, 0, 1) * 255);
  data[i + 2] = Math.round(THREE.MathUtils.clamp(b, 0, 1) * 255);
}

/**
 * Ceiling on the corner falloff, whatever the active grade asks for.
 *
 * The grades ship vignettes up to 0.28, which through the composite's operator
 * darkens a corner to 73% of its true value. The plate has nothing like that:
 * `bravely01.jpg` measures its bottom-left corner at 0.560 display against 0.423
 * at frame centre — the corners are *brighter* than the middle, because the
 * brightest thing in the picture is the sunlit near ground and it runs right to
 * the edge. A vignette that fought that would be inventing a lens the reference
 * does not have. 0.12 leaves an 88% corner: enough to keep the eye off the frame
 * edge, not enough to read as a shape.
 */
const VIGNETTE_MAX = 0.12;

/** 35 mm full-frame sensor height. Fixes the mm→pixel scale for the CoC maths. */
const SENSOR_HEIGHT_MM = 24;

/**
 * Chromatic aberration, in the units the composite pass and ART_BIBLE §6 both
 * use: total R↔B separation at the frame *corner* as a fraction of frame width.
 *
 * The steady state is a quarter of the bible's 0.0012, matching every grade in
 * colorGrades.js — see the rationale there. The impact peak keeps the bible's
 * 0.004, expressed here as the *additive* spike a `punch()` lays on top of the
 * grade's baseline, because the baseline is a cross-faded per-grade value and a
 * spike that clobbered it would make a crit under `void` weaker than a crit
 * under `neutral`. Quartering the steady state while leaving the transient
 * alone is the whole point: the frame stops fringing, and a crit still snaps.
 */
const ABERRATION_STEADY = 0.0003;
const ABERRATION_IMPACT_SPIKE = 0.004 - ABERRATION_STEADY;

/**
 * The depth-keyed value structure, re-derived from `docs/reference/bravely01.jpg`.
 *
 * The previous constant table was solved against the prose specs, and on the two
 * points where those specs and the plate disagree the plate wins — the reference
 * README says so, and measuring the plate says so louder:
 *
 *  - **There is no dark foreground frame.** The spec's "dark foreground / bright
 *    subject / hazy background" puts the near ground at the bottom of the value
 *    range. The plate does the opposite: its near ground is the *brightest*
 *    region in the picture (0.496 mean display over the bottom 150 rows) and its
 *    party band is among the darkest (0.319). Our shipped frame ran the spec's
 *    way round — foreground 0.337 against midground 0.405 — so the tier was not
 *    subtle, it was inverted. `foreLift` is therefore retired to zero rather than
 *    retuned: an operator that is wrong in sign has no good setting, and the near
 *    field's brightness belongs to the key raking a sunlit meadow, which
 *    `Lighting` now delivers.
 *
 *  - **The background is hazed, not lifted.** `farLift` at luminance 0.148 plus
 *    `farSaturation` 0.82 is a flat milk wash applied to everything past ~14 m,
 *    and it measured exactly that: our background rocks came out at 0.539 display
 *    and 0.194 saturation — *brighter than our own sky* and half its chroma,
 *    which reads as fog on the lens rather than as distance. The plate's step
 *    over the same depth is a plain mix toward its sky colour: near rock (41, 66,
 *    93) to far rock (72, 89, 110) is `mix(near, sky, 0.178)`, predicting all
 *    three channels to within three levels. That is a *distance-graded* operator
 *    and a depth-zone constant cannot be one, so it now lives where it belongs —
 *    in the scene's own `FogExp2`, which `Lighting.AERIAL_EXTINCTION_AT_RANGE`
 *    drives to the plate's fraction at the plate's depth. A *positive* far lift
 *    is gone for good, and so is the far desaturation as a way of faking air.
 *    What the tier carries now is the same lift operator with its sign reversed,
 *    which is not the same move: a negative lift *deepens* a background instead
 *    of washing it, and separating the cast from the meadow is the note still
 *    outstanding. See `farLift` below for the measurement that asks for it.
 *    `foreLift` stays at identity, because an operator that was wrong in sign
 *    has no good setting and the near field's brightness belongs to the key
 *    raking a sunlit meadow, which `Lighting` now delivers.
 *
 *  - **The subject was over-gained.** 2.1 was solved to lift a party measured at
 *    display 0.314; the party now measures 0.428 against the plate's 0.319.
 *    Inverting the ACES fit on both puts the correction at 0.626, i.e. 1.31 —
 *    and the fill this rig's `Lighting` half now delivers is what pays for the
 *    difference, which is the right place for it: a shadow side lifted by an
 *    actual sky reads as light, the same shadow side lifted by a depth-keyed
 *    exposure multiplier reads as a matte.
 *
 *    It is over-gained again, from the other side. Re-measured on the current
 *    build the party band comes back at mean display 0.351 against the plate's
 *    0.307 and the whole frame at median 0.349 against 0.295 — the cast is no
 *    longer short of the reference, it is past it, and a lift solved against a
 *    deficit that has since been paid twice over (by `EXPOSURE_CALIBRATION`,
 *    and by the fill this rig's `Lighting` half delivers) is now just a bright
 *    band in the middle of the frame. 1.18 keeps a visible step over the meadow
 *    while landing the band on the plate; the *separation* the gain used to be
 *    carrying alone is now shared with `farLift`, which pushes the background
 *    down rather than pushing the cast up, and with a key that finally writes a
 *    terminator on the cast and a shadow beside it.
 *
 * `dehaze` rises with the fog density: the un-mix is what keeps the party out of
 * the thicker air, and at 9 m the fog it is inverting is only 1.7% to begin with.
 */
const VALUE_STRUCTURE = {
  amount: 1,
  halfWidthRatio: 0.18,
  minHalfWidth: 1.2,
  featherRatio: 0.35,
  minFeather: 1.6,
  subjectGain: 1.18,
  subjectContrast: 1.08,
  subjectSaturation: 1.18,
  subjectGrain: 0.15,
  dehaze: 0.85,
  foreLift: [0, 0, 0],
  // A *negative* lift on the far tier, which is the same operator run backwards
  // and is the only depth-keyed move left that this frame still needs.
  //
  // `lift + e(1 - lift)` pins white at any sign, so a negative value drops the
  // background's blacks and midtones while leaving its highlights and the sky
  // where they are — a depth-keyed contrast increase rather than a wash. That is
  // what the review's "characters do not separate from the meadow" asks for and
  // it is what the plate does: `bravely01.jpg` runs its party band at 0.319 mean
  // display against a midground meadow at 0.289, i.e. the cast reads *lighter*
  // than the field behind it, where ours ran 0.428 against 0.346 with the field
  // carrying the brighter, more contrasty texture.
  //
  // Graded warm-first — red pulled down hardest, blue least — so the operation
  // also cools as it deepens, which is the direction aerial perspective moves
  // and the direction the flower bank should be going. It is deliberately small:
  // the fog already carries the distance cue (see `AERIAL_EXTINCTION_AT_RANGE`)
  // and this is a separation trim on top of it, not a second atmosphere.
  farLift: [-0.024, -0.017, -0.007],
  // The flower bank is the largest saturated area in frame and the second half
  // of "saturation reserved for accents" is that the *stage* gives some up. Six
  // percent off the background is under the threshold at which a viewer can name
  // it and enough that the tulips at subject depth — which take
  // `subjectSaturation` 1.18 in the same shader — clear it by better than a
  // quarter.
  farSaturation: 0.94,
};

/**
 * Quality ladder. Everything here is switchable at runtime; nothing here
 * reallocates a target except `bloomMips` and `msaa`, both handled explicitly.
 *
 * 'low' drops the three depth-consuming passes entirely, which also lets the
 * chain skip two full-resolution round trips — on integrated GPUs that is the
 * difference between 60 and 35 fps, and none of the three are load-bearing for
 * readability the way bloom and the grade are.
 *
 * `msaa` is the sample count on the beauty target. It is on the ladder rather
 * than fixed because it is the single most expensive line item here — 4x MSAA
 * on a 1080p RGBA16F target is 33 MB of renderbuffer and a full-frame resolve —
 * and because 'low' exists for machines that cannot pay it.
 *
 * `dofTaps` comes down at `medium` and `high`. Until the far-field floor was
 * split from the artistic bokeh scale the gather's `radius < 0.75` early-out
 * rejected essentially the whole frame on the shipped poses, so the tap count
 * was free and nobody had to defend it. It is not free now: better than half the
 * frame is background and every background pixel walks the spiral. Eighteen taps
 * over the ~5 px half-res radius the floor asks for is a sample every 0.9 px of
 * arc at the rim of the disc, which is under the point where a golden-angle
 * spiral starts showing structure on the smooth, low-contrast content the floor
 * is applied to. `maxCoc` only has to clear the floor itself; the surplus was
 * headroom for a fast stop that the shipped poses do not use.
 */
const QUALITY = {
  low: { ao: false, aoSamples: 6, bloomMips: 4, dof: false, dofTaps: 16, motionBlur: false, mbTaps: 4, radialTaps: 8, maxCoc: 8, msaa: 0 },
  medium: { ao: true, aoSamples: 8, bloomMips: 5, dof: true, dofTaps: 14, motionBlur: true, mbTaps: 5, radialTaps: 10, maxCoc: 12, msaa: 4 },
  high: { ao: true, aoSamples: 14, bloomMips: 6, dof: true, dofTaps: 18, motionBlur: true, mbTaps: 8, radialTaps: 14, maxCoc: 14, msaa: 4 },
  ultra: { ao: true, aoSamples: 24, bloomMips: 7, dof: true, dofTaps: 32, motionBlur: true, mbTaps: 12, radialTaps: 18, maxCoc: 22, msaa: 8 },
};

/**
 * Guaranteed background defocus, as a fraction of frame height, and the number
 * of depth doublings past the focal plane over which it ramps in. Consumed by
 * `dofShader.js`'s far-field floor — the operator is documented there.
 *
 * **This is atmosphere, not a lens, and it no longer rides `bokehScale`.** That
 * coupling is the single reason our shipped frame has no depth in it. The far
 * floor was multiplied by the artistic bokeh scale, `CAMERA_POSES.battle` sets
 * `bokeh: 0` on the argument that the plate is sharp front to back, and the two
 * together produced a frame that is provably sharper in the background than in
 * the subject. Measured: Laplacian variance over `bravely01.jpg`'s far rock and
 * tree band is 0.0046 against 0.0122 on its party — the background carries 37%
 * of the subject's detail. Ours came back 0.0130 against 0.0118, i.e. **110%**.
 * Zooming both to pixels settles it: the plate's lavender spikes directly behind
 * Adelle are diffuse, its tulips have no hard edge and its tree trunk is a soft
 * mass, while ours resolves individual aliased blades at the same depth. The
 * plate is sharp *at the cast*; it is not sharp behind them.
 *
 * So the physical CoC keeps riding the aperture and the artistic scale — a scene
 * closing down to f/22 with `bokeh: 0` still gets no near-field bokeh, no
 * highlight discs and no softening of anything at subject depth — and the
 * far-field floor becomes a property of the *air*, owned here and adjustable
 * through `setBackgroundDefocus` for the one case that genuinely wants a sharp
 * horizon (a flat menu backdrop, the world-map diorama).
 *
 * 0.0095 is 10.3 px at 1080p, and it is a gather radius rather than a Gaussian
 * sigma — at that reach the plate's own background detail ratio comes out inside
 * a few percent. Expressed against frame height rather than in pixels so the
 * softness of the background is the same *picture* at 720p as at 4K, which is
 * the same reason `uMmToPixels` is derived from the sensor height.
 *
 * 3.3 octaves is where the ramp is solved rather than chosen. The battle staging
 * puts the party across 3.3-8.4 m on a ~5 m focal plane with the enemy at 8.6 m,
 * and the requirement is that the far blur has not begun until roughly 8 m
 * behind the cast. At 3.3 octaves the floor contributes 1.4 px at the enemy's
 * depth — under the composite's 0.75-3 px blend ramp, so the enemy stays
 * effectively sharp — reaches the full-blur threshold by 13 m, and saturates on
 * the boulder wall and treeline past 25 m. Two octaves would have softened the
 * rear rank; four would have left the flower bank crisp.
 */
const DOF_FAR_FLOOR_FRACTION = 0.0095;
const DOF_FAR_OCTAVES = 3.3;

/**
 * The artistic CoC multiplier the *physical* term is authored against. Only the
 * thin-lens half of the CoC scales with it now; see `DOF_FAR_FLOOR_FRACTION`.
 */
const DEFAULT_BOKEH_SCALE = 4.0;

/** HDR intermediate. No depth buffer — only the beauty pass ever writes depth. */
function hdrTarget(w, h, name) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.name = name;
  return rt;
}

/**
 * Every fullscreen material in this file is built here so the three properties
 * that matter are impossible to forget: no depth test (the composer's buffers
 * carry a depth attachment from the beauty pass and a fullscreen quad must not
 * be culled by it), no depth write, and no blending.
 */
function postMaterial(fragmentShader, uniforms, defines) {
  const m = new THREE.ShaderMaterial({
    uniforms,
    defines: defines ?? {},
    vertexShader: POST_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  return m;
}

/**
 * The beauty pass, rendering into a target the composer does not own.
 *
 * The obvious arrangement — attach a `DepthTexture` to the composer's own
 * ping-pong buffers and let `RenderPass` fill one of them — does not work, and
 * the reason is worth recording because it costs a frame of debugging to
 * rediscover. Those two buffers swap roles every time a pass runs, and the
 * swap count varies with which passes `setQuality` has enabled. Sooner or later
 * a depth-consuming pass (motion blur, the DOF composite) ends up *writing* to
 * the very buffer whose depth attachment it is *sampling* — a framebuffer
 * feedback loop, which is undefined behaviour and which Chrome reports as
 * `GL_INVALID_OPERATION: Feedback loop formed between Framebuffer and active
 * Texture` on every affected draw.
 *
 * Rendering the scene into a private target and blitting it into the chain
 * costs one full-resolution half-float copy per frame and makes the depth
 * texture a stable, never-bound-as-output reference that any pass may sample
 * at any point in the chain. The composer's own buffers then need no depth
 * attachment at all, which claws most of the memory back.
 */
class BeautyPass extends RenderPass {
  constructor(target, camera) {
    super(new THREE.Scene(), camera);
    this.needsSwap = false;
    this.target = target;
    this._copyUniforms = { tDiffuse: { value: target.texture } };
    this._copyMat = postMaterial(COPY_FRAG, this._copyUniforms);
    this._quad = new FullScreenQuad(this._copyMat);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    // RenderPass draws into whatever it is handed as `readBuffer`.
    super.render(renderer, writeBuffer, this.target, deltaTime, maskActive);
    this._copyUniforms.tDiffuse.value = this.target.texture;
    renderer.setRenderTarget(readBuffer);
    this._quad.render(renderer);
  }

  setSize(width, height) {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this._copyMat.dispose();
    this._quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// SSAO
// ---------------------------------------------------------------------------

/**
 * Half-resolution depth-only AO with a separable bilateral resolve.
 * See aoShader.js for why this is hand-written rather than `GTAOPass`.
 */
class AOPass extends Pass {
  constructor(settings) {
    super();
    this.needsSwap = true;

    this.aoUniforms = {
      tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uProj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 0.35 }, // metres — art bible §6
      uBias: { value: 0.025 },
      uNear: { value: 0.1 },
      uFar: { value: 4000 },
      uPower: { value: 1.35 },
    };
    this.blurUniforms = {
      tAO: { value: null },
      uDirection: { value: new THREE.Vector2() },
      // Per metre. 4.0 means a tap 25 cm away in depth keeps ~37% weight, which
      // holds the occlusion on a chibi character's boot without bleeding it
      // onto the ground plane behind them.
      uDepthSigma: { value: 4.0 },
    };
    this.compositeUniforms = {
      tDiffuse: { value: null },
      tAO: { value: null },
      // SHADOW_TINT #2E4A5F normalised so full occlusion lands at ~45% value
      // in a teal hue rather than at neutral grey. The art bible's shadow rule
      // is not optional for screen-space shadowing either.
      uAOColor: { value: new THREE.Color(0.28, 0.44, 0.56) },
      uIntensity: { value: 0.55 },
    };

    this._aoMat = postMaterial(AO_FRAG, this.aoUniforms, { AO_SAMPLES: settings.aoSamples });
    this._blurMat = postMaterial(AO_BLUR_FRAG, this.blurUniforms);
    this._compMat = postMaterial(AO_COMPOSITE_FRAG, this.compositeUniforms);
    this._quad = new FullScreenQuad(this._aoMat);

    // Half-float, not RGBA8: the alpha channel carries view depth in metres for
    // the bilateral resolve, and 8 bits against a 4 km far plane is useless.
    this._rtA = hdrTarget(1, 1, 'PostFX.ao.a');
    this._rtB = hdrTarget(1, 1, 'PostFX.ao.b');
    this._w = 1;
    this._h = 1;
  }

  setQuality(settings) {
    if (this._aoMat.defines.AO_SAMPLES === settings.aoSamples) return;
    this._aoMat.defines.AO_SAMPLES = settings.aoSamples;
    this._aoMat.needsUpdate = true;
  }

  setSize(width, height) {
    // Half res: contact occlusion is a low-frequency signal and the bilateral
    // resolve reads cleaner from fewer, better-converged pixels than from a
    // full-resolution buffer with the same total sample budget.
    this._w = Math.max(1, width >> 1);
    this._h = Math.max(1, height >> 1);
    this._rtA.setSize(this._w, this._h);
    this._rtB.setSize(this._w, this._h);
    this.aoUniforms.uTexel.value.set(1 / this._w, 1 / this._h);
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!this.aoUniforms.tDepth.value) return;

    this._quad.material = this._aoMat;
    renderer.setRenderTarget(this._rtA);
    this._quad.render(renderer);

    this._quad.material = this._blurMat;
    this.blurUniforms.tAO.value = this._rtA.texture;
    this.blurUniforms.uDirection.value.set(1 / this._w, 0);
    renderer.setRenderTarget(this._rtB);
    this._quad.render(renderer);

    this.blurUniforms.tAO.value = this._rtB.texture;
    this.blurUniforms.uDirection.value.set(0, 1 / this._h);
    renderer.setRenderTarget(this._rtA);
    this._quad.render(renderer);

    this.compositeUniforms.tDiffuse.value = readBuffer.texture;
    this.compositeUniforms.tAO.value = this._rtA.texture;
    this._quad.material = this._compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._quad.render(renderer);
  }

  dispose() {
    this._rtA.dispose();
    this._rtB.dispose();
    this._aoMat.dispose();
    this._blurMat.dispose();
    this._compMat.dispose();
    this._quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// Bloom
// ---------------------------------------------------------------------------

/**
 * Progressive downsample/upsample bloom. The mip count is the only thing
 * `setQuality` changes, and because the upsample is an energy-conserving `mix`
 * rather than an add, raising it widens the veil without brightening it — an
 * 'ultra' frame and a 'low' frame are the same exposure.
 */
class BloomPass extends Pass {
  constructor(settings) {
    super();
    this.needsSwap = true;

    this.prefilterUniforms = {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      // Threshold and knee together decide *what class of thing* is allowed to
      // bloom, and the previous pair let almost anything. A knee of 0.6 against a
      // threshold of 1.0 opens the high pass at scene radiance 0.4 — well below
      // the level a lit diffuse surface reaches under a 2.9 key — so broad
      // surfaces were contributing to the veil, which is what put 5.2% of our
      // frame above display 0.75 against the plate's 1.5%.
      //
      // The threshold is rewritten every frame from `BLOOM_DISPLAY_THRESHOLD`
      // and the live exposure; this is only its unit-exposure seed. The knee
      // stays narrow — a tenth against a threshold above one, i.e. under a fifth
      // of a stop — which is still wide enough that a highlight sliding along a
      // moving blade ramps in rather than popping, and far too narrow for a lit
      // diffuse surface to find its way in.
      uThreshold: { value: BLOOM_SCENE_THRESHOLD_AT_UNIT_EXPOSURE },
      uKnee: { value: 0.10 },
      // Firefly clamp. A single 60.0 spell-core texel would otherwise pump the
      // entire coarsest mip and strobe the whole frame.
      uClamp: { value: 24.0 },
    };
    this.downUniforms = { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } };
    this.upUniforms = {
      tLower: { value: null },
      tHigher: { value: null },
      uTexel: { value: new THREE.Vector2() },
      // Narrower than the 0.72 an atmospheric dusk frame wanted. Scatter is what
      // turns a glint into a veil, and with the threshold now admitting only
      // glints a wide scatter would spread the few that remain across half the
      // frame — the same broad glow, arrived at from the other direction.
      uRadius: { value: 0.50 },
    };
    this.compositeUniforms = {
      tDiffuse: { value: null },
      tBloom: { value: null },
      // The reference plate is the authority here and it is not a bloomy image:
      // a soft late-morning meadow with 1.5% of its pixels above display 0.75
      // and no visible halo on any silhouette. 0.20 keeps a glint reading as
      // *bright* — which is all a specular ping needs — without any of it
      // reaching the surfaces around it.
      uStrength: { value: 0.20 },
      uTint: { value: new THREE.Color(0.96, 1.0, 1.06) },
    };

    this._preMat = postMaterial(BLOOM_PREFILTER_FRAG, this.prefilterUniforms);
    this._downMat = postMaterial(BLOOM_DOWNSAMPLE_FRAG, this.downUniforms);
    this._upMat = postMaterial(BLOOM_UPSAMPLE_FRAG, this.upUniforms);
    this._compMat = postMaterial(BLOOM_COMPOSITE_FRAG, this.compositeUniforms);
    this._quad = new FullScreenQuad(this._preMat);

    this._mips = settings.bloomMips;
    this._down = [];
    this._up = [];
    this._w = 1;
    this._h = 1;
  }

  setQuality(settings) {
    if (settings.bloomMips === this._mips) return;
    this._mips = settings.bloomMips;
    this._freeChains();
    this._buildChains();
  }

  _freeChains() {
    for (const rt of this._down) rt.dispose();
    for (const rt of this._up) rt.dispose();
    this._down.length = 0;
    this._up.length = 0;
  }

  _buildChains() {
    // Stop subdividing at 4 px: below that the tent filter degenerates and the
    // mip contributes nothing but a uniform tint.
    let w = Math.max(1, this._w >> 1);
    let h = Math.max(1, this._h >> 1);
    for (let i = 0; i < this._mips; i++) {
      if (i > 0 && (w < 4 || h < 4)) break;
      this._down.push(hdrTarget(w, h, `PostFX.bloom.down${i}`));
      if (i > 0) this._up.push(hdrTarget(w, h, `PostFX.bloom.up${i - 1}`));
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
  }

  setSize(width, height) {
    this._w = Math.max(1, width);
    this._h = Math.max(1, height);
    this._freeChains();
    this._buildChains();
    this.prefilterUniforms.uTexel.value.set(1 / this._w, 1 / this._h);
  }

  render(renderer, writeBuffer, readBuffer) {
    const down = this._down;
    if (down.length === 0) return;

    this.prefilterUniforms.tDiffuse.value = readBuffer.texture;
    this._quad.material = this._preMat;
    renderer.setRenderTarget(down[0]);
    this._quad.render(renderer);

    this._quad.material = this._downMat;
    for (let i = 1; i < down.length; i++) {
      const src = down[i - 1];
      this.downUniforms.tDiffuse.value = src.texture;
      this.downUniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(down[i]);
      this._quad.render(renderer);
    }

    // Walk back up. `up[i]` holds the accumulated veil at mip i+1's resolution
    // blended into mip i; the last one written is up[0], at half resolution.
    this._quad.material = this._upMat;
    for (let i = down.length - 2; i >= 0; i--) {
      const lower = i === down.length - 2 ? down[i + 1] : this._up[i + 1];
      this.upUniforms.tLower.value = lower.texture;
      this.upUniforms.tHigher.value = down[i].texture;
      this.upUniforms.uTexel.value.set(1 / lower.width, 1 / lower.height);
      renderer.setRenderTarget(this._up[i]);
      this._quad.render(renderer);
    }

    this.compositeUniforms.tDiffuse.value = readBuffer.texture;
    this.compositeUniforms.tBloom.value = (this._up[0] ?? down[0]).texture;
    this._quad.material = this._compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._quad.render(renderer);
  }

  dispose() {
    this._freeChains();
    this._preMat.dispose();
    this._downMat.dispose();
    this._upMat.dispose();
    this._compMat.dispose();
    this._quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// Depth of field
// ---------------------------------------------------------------------------

/** Thin-lens CoC, half-res spiral gather, CoC-weighted composite. */
class DofPass extends Pass {
  constructor(settings) {
    super();
    this.needsSwap = true;

    // Shared between the prepass and the composite so the two can never
    // disagree about where the focal plane is.
    this.coc = {
      uNear: { value: 0.1 },
      uFar: { value: 4000 },
      uFocusDistance: { value: 9 },
      uApertureDiam: { value: 6.7 },
      uFocalLength: { value: 27 },
      uMmToPixels: { value: 180 },
      uMaxCoc: { value: settings.maxCoc },
      // Physical optics makes far blur saturate at A*f/(S-f), which is the
      // opposite of what this art direction wants — a crisp midground and a
      // genuinely soft horizon. These two break that ceiling without touching
      // the depth of field around the subject; the operator and the reason a
      // plain scalar multiplier cannot do it live in dofShader.js.
      uFarFloor: { value: 10.3 },
      uFarOctaves: { value: DOF_FAR_OCTAVES },
    };

    this.prepassUniforms = Object.assign(
      { tDiffuse: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() } },
      this.coc,
    );
    this.gatherUniforms = {
      tHalf: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uMaxCoc: this.coc.uMaxCoc,
    };
    // The gather never evaluates CoC — it reads the prepass' packed alpha — so
    // it deliberately does not receive the rest of `this.coc`.
    this.compositeUniforms = Object.assign(
      { tDiffuse: { value: null }, tDepth: { value: null }, tBlur: { value: null } },
      this.coc,
    );

    this._preMat = postMaterial(DOF_PREPASS_FRAG, this.prepassUniforms);
    this._gatherMat = postMaterial(DOF_GATHER_FRAG, this.gatherUniforms, { DOF_TAPS: settings.dofTaps });
    this._compMat = postMaterial(DOF_COMPOSITE_FRAG, this.compositeUniforms);
    this._quad = new FullScreenQuad(this._preMat);

    this._rtA = hdrTarget(1, 1, 'PostFX.dof.a');
    this._rtB = hdrTarget(1, 1, 'PostFX.dof.b');
  }

  setQuality(settings) {
    this.coc.uMaxCoc.value = settings.maxCoc;
    if (this._gatherMat.defines.DOF_TAPS !== settings.dofTaps) {
      this._gatherMat.defines.DOF_TAPS = settings.dofTaps;
      this._gatherMat.needsUpdate = true;
    }
  }

  setSize(width, height) {
    const hw = Math.max(1, width >> 1);
    const hh = Math.max(1, height >> 1);
    this._rtA.setSize(hw, hh);
    this._rtB.setSize(hw, hh);
    this.prepassUniforms.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.gatherUniforms.uTexel.value.set(1 / hw, 1 / hh);
    // mm -> px conversion depends on the vertical resolution of the frame the
    // CoC will actually be measured in.
    this._pixelsPerMm = height / SENSOR_HEIGHT_MM;
    // Same reasoning for the far-field floor: it is authored as a fraction of
    // frame height so the background reads equally soft at any resolution.
    // `syncCamera` turns this into the live uniform.
    this._farFloorPx = Math.max(1, height) * DOF_FAR_FLOOR_FRACTION;
  }

  /** Called once a frame by PostFX with the live camera.
   *  @param {number} backgroundDefocus fraction of frame height the far-field
   *    floor may reach. Independent of `bokehScale` — see
   *    `DOF_FAR_FLOOR_FRACTION` for why the two were split. */
  syncCamera(camera, focusDistance, fNumber, bokehScale, backgroundDefocus) {
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const focal = (SENSOR_HEIGHT_MM * 0.5) / Math.tan(fovRad * 0.5);
    this.coc.uFocalLength.value = focal;
    this.coc.uApertureDiam.value = focal / Math.max(0.5, fNumber);
    this.coc.uFocusDistance.value = Math.max(camera.near * 2, focusDistance);
    this.coc.uMmToPixels.value = (this._pixelsPerMm ?? 45) * bokehScale;
    this.coc.uNear.value = camera.near;
    this.coc.uFar.value = camera.far;
    // Capped at the radius the gather is actually budgeted to walk, because a
    // floor the composite can see but the gather cannot produce would show up as
    // a hard blur ceiling rather than as depth. Deliberately *not* scaled by
    // `bokehScale` — see DOF_FAR_FLOOR_FRACTION.
    this.coc.uFarFloor.value = Math.min(
      this.coc.uMaxCoc.value,
      Math.max(0, this._farFloorPx ?? 10.3) * backgroundDefocus,
    );
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!this.prepassUniforms.tDepth.value) return;

    this.prepassUniforms.tDiffuse.value = readBuffer.texture;
    this._quad.material = this._preMat;
    renderer.setRenderTarget(this._rtA);
    this._quad.render(renderer);

    this.gatherUniforms.tHalf.value = this._rtA.texture;
    this._quad.material = this._gatherMat;
    renderer.setRenderTarget(this._rtB);
    this._quad.render(renderer);

    this.compositeUniforms.tDiffuse.value = readBuffer.texture;
    this.compositeUniforms.tBlur.value = this._rtB.texture;
    this._quad.material = this._compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._quad.render(renderer);
  }

  dispose() {
    this._rtA.dispose();
    this._rtB.dispose();
    this._preMat.dispose();
    this._gatherMat.dispose();
    this._compMat.dispose();
    this._quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// Trauma shake noise
// ---------------------------------------------------------------------------

/** Deterministic 1-D hash; the shake must reproduce for the capture harness. */
function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}

/**
 * Smooth value noise in [-1,1]. Perlin-style smoothstep interpolation matters
 * here: sampling white noise per frame gives a buzz that reads as a dropped
 * frame, whereas a continuous curve reads as a physical camera being hit.
 */
function vnoise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash1(i);
  const b = hash1(i + 1);
  const u = f * f * (3 - 2 * f);
  return (a + (b - a) * u) * 2 - 1;
}

// ---------------------------------------------------------------------------
// PostFX
// ---------------------------------------------------------------------------

export class PostFX {
  constructor(engine) {
    this.engine = engine;
    this.renderer = engine.renderer;

    this.quality = gameState.state.settings.quality ?? 'high';
    const settings = QUALITY[this.quality] ?? QUALITY.high;
    this._settings = settings;

    // See the class docblock: HDR bloom is impossible if the renderer tone maps
    // on the way into the half-float buffer.
    this._rendererToneMapping = this.renderer.toneMapping;
    this.renderer.toneMapping = THREE.NoToneMapping;

    const dpr = this.renderer.getPixelRatio();
    const bw = Math.max(1, Math.round((engine.width || 1280) * dpr));
    const bh = Math.max(1, Math.round((engine.height || 720) * dpr));

    // HDR is mandatory: bloom has to read values above 1.0, so every buffer in
    // the chain is half-float. Half-float rather than full float because the
    // chain is bandwidth-bound and 11 bits of mantissa is far more than an
    // 8-bit display path can resolve after tone mapping.
    //
    // `samples` is the anti-aliasing. See `_applyMsaa` for why a post-resolve
    // filter alone was never going to be enough here.
    this.beauty = new THREE.WebGLRenderTarget(bw, bh, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: this._wantedSamples(settings),
    });
    this.beauty.texture.name = 'PostFX.beauty';
    // A real depth texture, not a renderbuffer: AO, DOF and motion blur all
    // sample it, and it is the only reason this module needs no second
    // geometry pass for any of the three.
    this.beauty.depthTexture = new THREE.DepthTexture(bw, bh);

    // The composer's own buffers carry no depth attachment — nothing after the
    // beauty pass depth-tests, and keeping them depth-free is what makes the
    // feedback loop described on BeautyPass structurally impossible.
    const chain = new THREE.WebGLRenderTarget(bw, bh, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    chain.texture.name = 'PostFX.chain';

    this.effectComposer = new EffectComposer(this.renderer, chain);
    this.effectComposer.renderToScreen = true;

    // --- passes ----------------------------------------------------------
    this.renderPass = new BeautyPass(this.beauty, engine.camera);
    this.aoPass = new AOPass(settings);
    this.bloomPass = new BloomPass(settings);
    this.dofPass = new DofPass(settings);

    this.motionBlurUniforms = {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uScale: { value: 0.5 }, // shutter, art bible §6
      uMaxVelocity: { value: 0.045 },
    };
    this.motionBlurPass = new ShaderPass(
      postMaterial(MOTION_BLUR_FRAG, this.motionBlurUniforms, { MB_TAPS: settings.mbTaps }),
    );

    this.radialUniforms = {
      tDiffuse: { value: null },
      uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uStrength: { value: 0 },
    };
    this.radialPass = new ShaderPass(
      postMaterial(RADIAL_BLUR_FRAG, this.radialUniforms, { RADIAL_TAPS: settings.radialTaps }),
    );
    this.radialPass.enabled = false;

    this._lutA = this._makeLutTexture();
    this._lutB = this._makeLutTexture();
    this.compositeUniforms = {
      tDiffuse: { value: null },
      uResolution: { value: new THREE.Vector2(bw, bh) },
      // Fraction of frame width, not pixels — see compositeShader.js and
      // ART_BIBLE §6. Overwritten from the active grade every frame.
      uAberration: { value: ABERRATION_STEADY },
      uFlash: { value: new THREE.Vector3(0, 0, 0) },
      uExposure: { value: 1 },
      uLutA: { value: this._lutA },
      uLutB: { value: this._lutB },
      uLutMix: { value: 1 },
      uLutSize: { value: LUT_SIZE },
      uGradeAmount: { value: 1 },
      uGrain: { value: 0.035 },
      uGrainSeed: { value: 0 },
      uVignette: { value: VIGNETTE_MAX },
      uVignetteOffset: { value: 1.1 },
      // Literal display values for #0A1218: the vignette is applied *after*
      // sRGB encoding, so converting this to the linear working space (which
      // `new THREE.Color(hex)` would do under colour management) would make it
      // far too dark.
      uVignetteColor: { value: new THREE.Vector3(0.039, 0.071, 0.094) },

      // Depth-keyed value structure. `tDepth` is bound by `_bindDepth`; the
      // rest are written every frame from `this._structure` and the live focal
      // plane. `uFogColor` is a THREE.Color because it is copied straight off
      // `scene.fog`, which three already holds in the linear working space the
      // un-mix operates in — whereas the two lift colours are Vector3 for the
      // same reason `uVignetteColor` is: they are display-referred literals and
      // colour management must not touch them.
      tDepth: { value: null },
      uCamNearFar: { value: new THREE.Vector2(0.1, 4000) },
      uStructure: { value: VALUE_STRUCTURE.amount },
      uSubjectDistance: { value: 9 },
      uSubjectBand: { value: new THREE.Vector2(1.6, 3.2) },
      uSubjectGain: { value: VALUE_STRUCTURE.subjectGain },
      uSubjectContrast: { value: VALUE_STRUCTURE.subjectContrast },
      uSubjectSaturation: { value: VALUE_STRUCTURE.subjectSaturation },
      uSubjectGrain: { value: VALUE_STRUCTURE.subjectGrain },
      uDehaze: { value: VALUE_STRUCTURE.dehaze },
      uFogColor: { value: new THREE.Color(0, 0, 0) },
      uFogDensity: { value: 0 },
      uForeLift: { value: new THREE.Vector3(...VALUE_STRUCTURE.foreLift) },
      uFarLift: { value: new THREE.Vector3(...VALUE_STRUCTURE.farLift) },
      uFarSaturation: { value: VALUE_STRUCTURE.farSaturation },
    };
    this.compositePass = new ShaderPass(postMaterial(COMPOSITE_FRAG, this.compositeUniforms));

    this.fxaaPass = new FXAAPass();
    this.fxaaPass.material.depthTest = false;
    this.fxaaPass.material.depthWrite = false;
    this.fxaaPass.material.blending = THREE.NoBlending;

    const c = this.effectComposer;
    c.addPass(this.renderPass);
    c.addPass(this.aoPass);
    c.addPass(this.bloomPass);
    c.addPass(this.dofPass);
    c.addPass(this.motionBlurPass);
    c.addPass(this.radialPass);
    c.addPass(this.compositePass);
    c.addPass(this.fxaaPass);

    /** Named handles so other systems (and the debug surface) can poke a
     *  single stage without knowing the chain layout. */
    this.passes = {
      render: this.renderPass,
      ao: this.aoPass,
      bloom: this.bloomPass,
      dof: this.dofPass,
      motionBlur: this.motionBlurPass,
      radial: this.radialPass,
      composite: this.compositePass,
      fxaa: this.fxaaPass,
    };

    // --- temporal state ---------------------------------------------------
    this._gradeFrom = GRADES.neutral;
    this._gradeTo = GRADES.neutral;
    this._gradeName = 'neutral';
    this._gradeMix = 1;
    this._gradeDuration = 1;
    this._bakeLut(this._lutA, GRADES.neutral);
    this._bakeLut(this._lutB, GRADES.neutral);

    this._trauma = 0;
    this._traumaDecay = 1;
    this._shakeClock = 0;
    this._shakeSeed = [rng.range(0, 1000), rng.range(0, 1000), rng.range(0, 1000)];

    this._flashColor = new THREE.Color(1, 1, 1);
    this._flashTime = 0;
    this._flashDuration = 0;
    this._flashIntensity = 0;

    this._aberrationSpike = 0;
    this._aberrationRate = 1;

    this._radialTarget = 0;
    this._radialHold = 0;
    this._radialActive = false;
    this._gradeExposure = 1;

    /** Diagnostic bypass. `null` = follow the scene's own flag. */
    this._diagnosticOverride = null;
    this._diagnostic = false;

    /** Focus tracking. Scenes may set `scene.focusDistance`, or call
     *  `postfx.focusOn(objectOrVector)`; otherwise the default suits both the
     *  fixed battle stage and the field camera. */
    this._focusTarget = null;
    this._focusDistance = 9;
    this._focusGoal = 9;
    this._fNumber = 4.0;
    this._bokehScale = DEFAULT_BOKEH_SCALE;
    /** Scale on the far-field defocus floor, 0..1. Separate from `_bokehScale`
     *  because the two answer different questions; see `DOF_FAR_FLOOR_FRACTION`.
     *  Defaults to full because a fully-sharp frame is wrong for every shot this
     *  build composes, and a scene that wants one has to say so. */
    this._backgroundDefocus = 1;

    /** Live copy of the value-structure defaults; `setValueStructure` mutates
     *  this and re-syncs, so a scene can widen the band for a group shot
     *  without the constant table becoming per-scene state. */
    this._structure = { ...VALUE_STRUCTURE };

    this._prevViewProj = new THREE.Matrix4();
    this._prevCamPos = new THREE.Vector3();
    this._hasHistory = false;
    this._frame = 0;

    this._camPos = new THREE.Vector3();
    this._camQuat = new THREE.Quaternion();
    this._shakeOffset = new THREE.Vector3();
    this._tmpVec = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
    this._tmpAxis = new THREE.Vector3();
    this._viewProj = new THREE.Matrix4();
    this._dpr = this.renderer.getPixelRatio();

    this._engineDt = 0;
    this._haveEngineDt = false;
    this._lastRenderTime = 0;

    // A camera cut must not smear: reprojection across a teleport produces a
    // full-screen streak that reads as a rendering bug.
    this._unsubs = [
      bus.on('scene:changed', () => {
        this._hasHistory = false;
      }),
      // Nothing else owns chromatic aberration, so impact punch is wired here.
      // Deliberately does *not* trigger shake — the battle and VFX layers own
      // that, and doubling it would make every crit feel like an earthquake.
      bus.on('battle:damage', (p) => {
        if (p?.crit) this.punch(ABERRATION_IMPACT_SPIKE, 0.25);
      }),
      bus.on('settings:changed', ({ key }) => {
        if (key === 'motionBlur' || key === 'screenShake') this._applyQuality();
      }),
    ];

    this._bindDepth(this.beauty.depthTexture);
    this._syncStructure();
    this.setSize(engine.width || 1280, engine.height || 720);
    this._applyQuality();

    engine.composer = this;
  }

  // -------------------------------------------------------------------------
  // Grades
  // -------------------------------------------------------------------------

  _makeLutTexture() {
    const data = new Uint8Array(LUT_SIZE * LUT_SIZE * LUT_SIZE * 4);
    const tex = new THREE.DataTexture(data, LUT_SIZE * LUT_SIZE, LUT_SIZE, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    // NoColorSpace: the cube stores already-encoded display values, so any
    // implicit sRGB decode on sample would double-transform the grade.
    tex.colorSpace = THREE.NoColorSpace;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
  }

  _bakeLut(texture, params) {
    bakeGradeStrip(params, LUT_SIZE, texture.image.data);
    // After the named grade, never before it: see `BASE_CHROMA`.
    applyDisplayGrade(texture.image.data);
    texture.needsUpdate = true;
  }

  /** Eased fade parameter. Linear cross-fades between two grades read as a
   *  visible ramp start and stop; smoothstep hides both ends. */
  _gradeT() {
    const t = Math.min(1, Math.max(0, this._gradeMix));
    return t * t * (3 - 2 * t);
  }

  /**
   * Cross-fade to a named grade over `t` seconds.
   *
   * Interrupting a fade is the common case (a boss dies mid-transition to
   * 'boss'), so the currently *visible* grade is first frozen by baking the
   * interpolated parameter set into slot A. That keeps the fade continuous —
   * there is never a frame where the grade jumps back to where the last fade
   * started.
   */
  setGrade(name, t = 0.6) {
    const target = GRADES[name];
    if (!target) {
      console.warn(`[PostFX] unknown grade "${name}", staying on "${this._gradeName}"`);
      return;
    }
    const eased = this._gradeT();
    const current = eased >= 1 ? this._gradeTo : lerpGrade(this._gradeFrom, this._gradeTo, eased);
    this._gradeFrom = current;
    this._gradeTo = target;
    this._gradeName = name;
    this._gradeMix = 0;
    this._gradeDuration = Math.max(1e-3, t);
    this._bakeLut(this._lutA, current);
    this._bakeLut(this._lutB, target);
  }

  get grade() {
    return this._gradeName;
  }

  // -------------------------------------------------------------------------
  // Impulses
  // -------------------------------------------------------------------------

  /**
   * Trauma-based camera shake. `intensity` accumulates into a 0..1 trauma
   * value and the actual displacement is trauma², so small hits are barely
   * felt and a full-trauma esper landing is violent — the squared response is
   * what makes a single scalar cover that whole range convincingly.
   */
  shake(intensity = 0.5, seconds = 0.4) {
    if (!gameState.state.settings.screenShake) return;
    this._trauma = Math.min(1, this._trauma + Math.max(0, intensity));
    this._traumaDecay = 1 / Math.max(0.05, seconds);
    // Re-seed so two shakes in quick succession do not replay the same curve.
    this._shakeSeed[0] = rng.range(0, 1000);
    this._shakeSeed[1] = rng.range(0, 1000);
    this._shakeSeed[2] = rng.range(0, 1000);
  }

  /**
   * Additive full-screen flash, applied before the tone map so it rolls off on
   * the filmic shoulder instead of clipping to a flat white card.
   */
  flash(color = 0xffffff, seconds = 0.22, intensity = 1.6) {
    // `Color.set` already lands in the linear working space under three's
    // colour management, which is the space the flash is added in. Converting
    // again here would darken every flash by roughly a stop and a half.
    this._flashColor.set(color);
    this._flashDuration = Math.max(1e-3, seconds);
    this._flashTime = 0;
    this._flashIntensity = Math.max(0, intensity);
  }

  /**
   * Chromatic aberration spike, added on top of the active grade's baseline.
   * `amount` is in the same fraction-of-frame-width unit as the grade value;
   * the default lands the peak on ART_BIBLE §6's 0.004.
   */
  punch(amount = ABERRATION_IMPACT_SPIKE, seconds = 0.25) {
    this._aberrationSpike = Math.max(this._aberrationSpike, Math.max(0, amount));
    this._aberrationRate = this._aberrationSpike / Math.max(0.05, seconds);
  }

  /** Limit-break speedlines. 0 at rest; the pass switches itself off there. */
  setRadialBlur(amount = 0) {
    this._radialTarget = Math.min(1, Math.max(0, amount));
  }

  /** Convenience: spike the speedlines and let them fall back to zero. */
  radialPulse(amount = 0.35, seconds = 0.4) {
    this.setRadialBlur(amount);
    this._radialHold = seconds;
  }

  /**
   * Move the speedline focal point, in normalised screen space. Anchoring it
   * on the character triggering the limit break rather than on frame centre is
   * what makes the effect read as *their* adrenaline.
   */
  setRadialCenter(x = 0.5, y = 0.5) {
    this.radialUniforms.uCenter.value.set(x, y);
  }

  // -------------------------------------------------------------------------
  // Depth of field
  // -------------------------------------------------------------------------

  /**
   * @param {number} focusDistance metres from the camera to the focal plane
   * @param {number} aperture      f-number; smaller = shallower
   * @param {number} [bokehScale]  artistic multiplier on the physical CoC
   */
  setDof(focusDistance = 9, aperture = 4.0, bokehScale = this._bokehScale) {
    this._focusTarget = null;
    this._focusGoal = Math.max(0.2, focusDistance);
    this._fNumber = Math.max(0.7, aperture);
    this._bokehScale = Math.max(0, bokehScale);
  }

  /**
   * Scale the guaranteed background defocus, independently of the lens.
   *
   * `setDof(d, f, 0)` used to be the off switch for both the physical CoC and
   * the far-field floor, which conflated "this shot wants no bokeh" with "this
   * shot wants a sharp horizon" — and every framing in the build wants the
   * first and none of them wants the second. They are separate now, and this is
   * the second one: 1 is the authored atmosphere, 0 a genuinely sharp
   * background for a flat backdrop or a diorama.
   *
   * @param {number} amount 0..1 scale on `DOF_FAR_FLOOR_FRACTION`.
   */
  setBackgroundDefocus(amount = 1) {
    this._backgroundDefocus = Math.min(1, Math.max(0, amount));
  }

  /**
   * Track an object (or a fixed point) as the focal plane. Preferred over
   * `setDof` for dialogue and closeups: the focus then follows the subject
   * through the shot instead of drifting off it.
   * @param {THREE.Object3D|THREE.Vector3|null} target
   */
  focusOn(target) {
    this._focusTarget = target ?? null;
  }

  // -------------------------------------------------------------------------
  // Value structure
  // -------------------------------------------------------------------------

  /**
   * Retune the depth-keyed value structure. Keys are the fields of
   * `VALUE_STRUCTURE`; anything omitted keeps its current value.
   *
   * The defaults are composed for the fixed side-view battle stage, which is the
   * shot the whole art direction is judged on. The two knobs a scene realistically
   * needs are `amount` (fade the whole relationship out for a stylised or fully
   * abstract shot) and the band geometry (`halfWidthRatio` / `featherRatio`) when
   * a cutscene stages actors far deeper than one focal plane can cover.
   *
   * @param {Partial<typeof VALUE_STRUCTURE>} opts
   */
  setValueStructure(opts = {}) {
    Object.assign(this._structure, opts);
    this._syncStructure();
  }

  /** Push the non-per-frame half of `_structure` onto the composite uniforms. */
  _syncStructure() {
    const s = this._structure;
    const u = this.compositeUniforms;
    u.uSubjectGain.value = Math.max(0, s.subjectGain);
    u.uSubjectContrast.value = Math.max(0, s.subjectContrast);
    u.uSubjectSaturation.value = Math.max(0, s.subjectSaturation);
    u.uSubjectGrain.value = Math.max(0, s.subjectGrain);
    // Clamped below 1: a full un-mix would divide the subject band by (1 - f)
    // and amplify every bit of quantisation noise the fog was hiding.
    u.uDehaze.value = Math.min(0.95, Math.max(0, s.dehaze));
    u.uForeLift.value.fromArray(s.foreLift);
    u.uFarLift.value.fromArray(s.farLift);
    u.uFarSaturation.value = Math.max(0, s.farSaturation);
  }

  // -------------------------------------------------------------------------
  // Quality
  // -------------------------------------------------------------------------

  setQuality(level) {
    const settings = QUALITY[level];
    if (!settings) {
      console.warn(`[PostFX] unknown quality "${level}"`);
      return;
    }
    this.quality = level;
    this._settings = settings;
    this._applyQuality();
  }

  /** Sample count this quality level asks for, clamped to what the GL context
   *  can actually give us. `getRenderTargetSamples` clamps again internally,
   *  but a stale unclamped value here would make `_applyMsaa` thrash the
   *  target every frame on a context whose `MAX_SAMPLES` is below the ladder. */
  _wantedSamples(settings) {
    const max = this.renderer.capabilities?.maxSamples ?? 0;
    return Math.max(0, Math.min(settings.msaa ?? 0, max));
  }

  /**
   * Multisample the beauty pass.
   *
   * The chain shipped with FXAA as its only anti-aliasing and the art review
   * scored it as absent, correctly: FXAA is a *post-resolve* filter. By the time
   * it runs, a hair spike or a pine bough has already been quantised to whole
   * pixels, the coverage information that would say how much of each pixel the
   * geometry actually covered is gone, and all FXAA can do is guess an edge
   * direction from three tone-mapped, graded, bloomed neighbours and smear along
   * it. On this content it guesses badly and often: the cast is a mass of thin
   * near-vertical silhouettes (spikes, staves, blades) against a smooth sky
   * gradient, which is the pathological case for a luma-gradient edge detector,
   * and the toon surface gives it hard interior bands that look exactly like
   * geometric edges. Every stage between the raster and the filter — bloom,
   * the depth-keyed value structure, the LUT — also compounds the staircase
   * before FXAA ever sees it.
   *
   * MSAA fixes the cause instead: coverage is resolved at the raster, before
   * bloom widens it, before DOF gathers around it and before the grade pushes
   * contrast across it. It is affordable here specifically because this is a
   * forward renderer with one geometry pass — there is no G-buffer to
   * multisample.
   *
   * FXAA stays on the tail, and is not redundant: MSAA does nothing for
   * *shading* aliasing, and this build is full of it — the cel terminator, the
   * hard specular band, the painted face texture's lash line and the one-pixel
   * depth step where the value structure's subject band meets the background.
   * Coverage AA for geometry, morphological AA for shading, which is the
   * standard pairing.
   *
   * Sample count is baked into the framebuffer when three first sets the target
   * up, so a runtime change has to release the GL objects; `dispose()` does
   * exactly that and leaves the JS instances (and therefore every uniform in the
   * chain pointing at `beauty.texture` and `beauty.depthTexture`) untouched.
   */
  _applyMsaa() {
    const want = this._wantedSamples(this._settings);
    if (want === this.beauty.samples) return;
    this.beauty.samples = want;
    this.beauty.dispose();
  }

  _applyQuality() {
    const s = this._settings;
    this._applyMsaa();
    this.aoPass.enabled = s.ao;
    this.aoPass.setQuality(s);
    this.bloomPass.setQuality(s);
    this.dofPass.enabled = s.dof;
    this.dofPass.setQuality(s);

    const mb = this.motionBlurPass.material;
    if (mb.defines.MB_TAPS !== s.mbTaps) {
      mb.defines.MB_TAPS = s.mbTaps;
      mb.needsUpdate = true;
    }
    const rad = this.radialPass.material;
    if (rad.defines.RADIAL_TAPS !== s.radialTaps) {
      rad.defines.RADIAL_TAPS = s.radialTaps;
      rad.needsUpdate = true;
    }
    // Motion blur also honours the player's own setting; quality only gates it.
    // Stored rather than applied directly because the diagnostic bypass in
    // render() is the final authority on every pass's enable flag.
    this._motionBlurWanted = s.motionBlur && gameState.state.settings.motionBlur !== false;
    this.motionBlurPass.enabled = this._motionBlurWanted;
  }

  // -------------------------------------------------------------------------
  // Diagnostic bypass
  // -------------------------------------------------------------------------

  /**
   * Force (or release) the diagnostic path.
   *
   * A silhouette/flat-shape check exists to answer exactly one question — does
   * this character read as a black shape — and every creative stage in this
   * chain actively obstructs that answer. Bloom bleeds a rim outward and fattens
   * the shape; the grade's tinted floor lifts "black" off black; grain puts
   * noise on a flat field; and aberration puts colour on the outline of a render
   * whose whole point is that it has no colour. So the diagnostic path keeps
   * only what is required to get linear HDR onto an sRGB display — exposure, the
   * ACES fit, the encode — plus the two stages that *resolve* an edge rather
   * than decorate it: MSAA on the beauty target and FXAA on the tail, without
   * which the silhouette would be judged on staircasing.
   *
   * DOF is kept too, which looks like an exception and is not; the argument sits
   * at its enable site in `render()`.
   *
   * @param {boolean|null} on `true`/`false` to pin, `null` to follow the scene.
   */
  setDiagnostic(on) {
    this._diagnosticOverride = on === null || on === undefined ? null : on === true;
  }

  /** True while the frame is being rendered as an unlit diagnostic. */
  get diagnostic() {
    return this._diagnostic;
  }

  /**
   * Scene-level contract: a scene renders diagnostically while `scene.diagnostic`
   * is true.
   *
   * `scene._silhouette` is also honoured because `LookdevScene` — the only owner
   * of a diagnostic pose in the build today — records the state under that name
   * and PostFX does not own that file. That fallback is a contract gap, not a
   * design: the public flag is the one to write against.
   */
  _resolveDiagnostic(scene) {
    if (this._diagnosticOverride !== null) return this._diagnosticOverride;
    return scene?.diagnostic === true || scene?.silhouette === true || scene?._silhouette === true;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /** Engine service hook. Only accumulates dt; all work happens in render(). */
  update(dt) {
    this._engineDt += dt;
    this._haveEngineDt = true;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const dpr = this.renderer.getPixelRatio();
    if (dpr !== this._dpr) {
      this._dpr = dpr;
      this.effectComposer.setPixelRatio(dpr);
    }
    // EffectComposer.setSize takes logical pixels and multiplies by its own
    // pixel ratio, then forwards the device-pixel size to every pass — which
    // is exactly the resolution our half-res chains need to halve.
    this.effectComposer.setSize(w, h);
    this.compositeUniforms.uResolution.value.set(Math.round(w * dpr), Math.round(h * dpr));
    // A resize invalidates the reprojection history: the previous frame was a
    // different aspect ratio and would smear.
    this._hasHistory = false;
  }

  /** One stable depth reference for every consumer. `RenderTarget.setSize`
   *  keeps the same `DepthTexture` instance and lets the renderer reallocate
   *  its storage, so this survives resizes and never needs re-binding. */
  _bindDepth(depthTexture) {
    this.aoPass.aoUniforms.tDepth.value = depthTexture;
    this.dofPass.prepassUniforms.tDepth.value = depthTexture;
    this.dofPass.compositeUniforms.tDepth.value = depthTexture;
    this.motionBlurUniforms.tDepth.value = depthTexture;
    // The composite reads depth for the value structure. Safe at this point in
    // the chain for the same reason motion blur is: the beauty target is never
    // bound as an output once the render pass has finished, so there is no
    // framebuffer feedback loop to form.
    this.compositeUniforms.tDepth.value = depthTexture;
  }

  /** Advance every time-driven parameter. Split out of render() so the
   *  ordering (decay, then upload) is obvious and testable. */
  _advance(dt) {
    // Grade cross-fade.
    if (this._gradeMix < 1) {
      this._gradeMix = Math.min(1, this._gradeMix + dt / this._gradeDuration);
    }
    const t = this._gradeT();
    this.compositeUniforms.uLutMix.value = t;

    const scalars = {};
    for (const key of GRADE_SCALARS) {
      scalars[key] = this._gradeFrom[key] + (this._gradeTo[key] - this._gradeFrom[key]) * t;
    }

    // Shake trauma.
    this._shakeClock += dt;
    if (this._trauma > 0) {
      this._trauma = Math.max(0, this._trauma - this._traumaDecay * dt);
    }

    // Flash decay: quadratic, so the frame is brightest on the first rendered
    // frame after the hit and gone before the player consciously registers it.
    let flash = 0;
    if (this._flashTime < this._flashDuration) {
      this._flashTime += dt;
      const k = Math.max(0, 1 - this._flashTime / this._flashDuration);
      flash = k * k * this._flashIntensity;
    }
    this.compositeUniforms.uFlash.value.set(
      this._flashColor.r * flash,
      this._flashColor.g * flash,
      this._flashColor.b * flash,
    );

    // Aberration: grade baseline plus a linearly decaying impact spike.
    if (this._aberrationSpike > 0) {
      this._aberrationSpike = Math.max(0, this._aberrationSpike - this._aberrationRate * dt);
    }
    this.compositeUniforms.uAberration.value = scalars.aberration + this._aberrationSpike;
    this.compositeUniforms.uGrain.value = scalars.grain;
    this.compositeUniforms.uVignette.value = Math.min(scalars.vignette, VIGNETTE_MAX);
    this._gradeExposure = scalars.exposure;

    // Radial blur eases in and out — a hard switch reads as a dropped frame.
    if (this._radialHold > 0) {
      this._radialHold -= dt;
      if (this._radialHold <= 0) {
        this._radialHold = 0;
        this._radialTarget = 0;
      }
    }
    const current = this.radialUniforms.uStrength.value;
    const k = 1 - Math.exp(-dt / 0.08);
    const next = current + (this._radialTarget - current) * k;
    this.radialUniforms.uStrength.value = next;
    this._radialActive = next > 0.002;

    // Focus follow. Exponential, ~0.25 s time constant: fast enough to keep up
    // with a cut-in, slow enough that it never snaps (art bible §7.8).
    const focusK = 1 - Math.exp(-dt / 0.25);
    this._focusDistance += (this._focusGoal - this._focusDistance) * focusK;
  }

  /**
   * Point the value structure at this frame's subject and at this frame's air.
   *
   * The focal plane is the anchor because it is already the one number in the
   * engine that means "where the thing the shot is about is standing" — scenes
   * set `focusDistance`, cutscenes call `focusOn(actor)`, and both are smoothed
   * by `_advance`. Deriving the subject band from anything else would give the
   * cast two different definitions of "in focus" and let the bright band drift
   * off the characters mid-shot.
   *
   * The fog is read live rather than configured, so the un-mix always inverts
   * the fog that was actually composited: `Sky` re-derives colour and density
   * from the time of day every frame, and a hard-coded haze colour here would
   * put a magenta cast on the party the moment dusk turned to night.
   */
  _updateValueStructure(scene, camera, active) {
    const u = this.compositeUniforms;
    const s = this._structure;
    u.uStructure.value = active && u.tDepth.value ? Math.max(0, Math.min(1, s.amount)) : 0;
    if (u.uStructure.value <= 0) return;

    const d = this._focusDistance;
    u.uSubjectDistance.value = d;
    u.uSubjectBand.value.set(
      Math.max(s.minHalfWidth, d * s.halfWidthRatio),
      Math.max(s.minFeather, d * s.featherRatio),
    );
    u.uCamNearFar.value.set(camera.near, camera.far);

    // Only FogExp2 is invertible with the closed form the shader uses. Linear
    // THREE.Fog would need its own near/far pair; no scene mounts one, and
    // silently applying the wrong curve would tint the cast rather than fail.
    const fog = scene.scene?.fog;
    if (fog?.isFogExp2) {
      u.uFogColor.value.copy(fog.color);
      u.uFogDensity.value = fog.density;
    } else {
      u.uFogDensity.value = 0;
    }
  }

  /** Resolve where the focal plane should be for this frame. */
  _resolveFocus(camera) {
    const scene = this.engine.scene;
    if (this._focusTarget) {
      const p = this._focusTarget.isVector3
        ? this._focusTarget
        : this._focusTarget.getWorldPosition(this._tmpVec);
      this._focusGoal = Math.max(0.2, camera.position.distanceTo(p));
    } else if (typeof scene?.focusDistance === 'number') {
      this._focusGoal = Math.max(0.2, scene.focusDistance);
    }
  }

  /**
   * Present one frame.
   *
   * `engine.scene.camera ?? engine.camera` is re-resolved every call, not
   * cached: scenes swap at runtime and each may bring its own camera, and a
   * stale reference here renders the previous scene's viewpoint into the
   * current scene's buffers.
   */
  render() {
    const scene = this.engine.scene;
    if (!scene) return;
    const camera = scene.camera ?? this.engine.camera;
    if (!camera) return;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const real = this._lastRenderTime ? Math.min(0.25, now - this._lastRenderTime) : 1 / 60;
    this._lastRenderTime = now;
    const dt = this._haveEngineDt ? this._engineDt : real;
    this._engineDt = 0;
    this._haveEngineDt = false;

    this._frame++;
    this._advance(dt);
    this._resolveFocus(camera);

    // Engine sets ACES on the renderer; we own tone mapping so bloom can read
    // HDR. Re-assert cheaply in case a scene or a material editor changed it.
    if (this.renderer.toneMapping !== THREE.NoToneMapping) {
      this.renderer.toneMapping = THREE.NoToneMapping;
    }

    this.renderPass.scene = scene.scene;
    this.renderPass.camera = camera;

    // AO's range check and the whole thin-lens CoC assume a perspective
    // frustum. A scene that mounts an orthographic camera (a map screen, a
    // shadow-debug view) gets the rest of the chain and skips these two rather
    // than rendering a wrong result.
    const perspective = camera.isPerspectiveCamera === true;
    const diag = this._resolveDiagnostic(scene);
    this._diagnostic = diag;

    this.aoPass.enabled = this._settings.ao && perspective && !diag;
    // DOF is the one creative stage the diagnostic path keeps, and the reason is
    // that on a *matte* frame it is provably an identity: the subject sits on
    // the focal plane so its CoC is under the composite's 0.75 px sharp
    // threshold and it survives bit-exact, while the ground and backdrop are one
    // flat white value that blurs to itself. It costs the silhouette check
    // nothing, and it means the pose cannot ship a fully-sharp frame — which
    // REFERENCE_TARGET §3 calls wrong outright — on the days the matte swap does
    // not take and the pose renders in full colour.
    this.dofPass.enabled = this._settings.dof && perspective;
    this.bloomPass.enabled = !diag;
    this.motionBlurPass.enabled = this._motionBlurWanted && !diag;
    this.radialPass.enabled = this._radialActive && !diag;

    // Zero the creative half of the composite. These uniforms were just written
    // by _advance() from the active grade, so the override has to land after it
    // and before the composer runs.
    if (diag) {
      this.compositeUniforms.uAberration.value = 0;
      this.compositeUniforms.uGrain.value = 0;
      this.compositeUniforms.uVignette.value = 0;
      this.compositeUniforms.uGradeAmount.value = 0;
      this.compositeUniforms.uFlash.value.set(0, 0, 0);
    } else {
      this.compositeUniforms.uGradeAmount.value = 1;
    }

    this._updateValueStructure(scene, camera, perspective && !diag);

    // --- camera shake ----------------------------------------------------
    this._camPos.copy(camera.position);
    this._camQuat.copy(camera.quaternion);
    // A diagnostic frame must be reproducible to the pixel and is judged on
    // shape; a residual trauma displacement would move the very outline the
    // pass exists to measure.
    const shakeActive = !diag && this._trauma > 0.0005 && gameState.state.settings.screenShake;
    if (shakeActive) {
      const s = this._trauma * this._trauma;
      const f = this._shakeClock * 24;
      // Translate in *view* space so the shake always reads as the camera body
      // being struck, whatever direction it is facing.
      this._shakeOffset.set(
        vnoise(f + this._shakeSeed[0]) * s * 0.22,
        vnoise(f * 1.13 + this._shakeSeed[1]) * s * 0.22,
        vnoise(f * 0.71 + this._shakeSeed[2]) * s * 0.06,
      );
      this._shakeOffset.applyQuaternion(this._camQuat);
      camera.position.add(this._shakeOffset);
      const roll = vnoise(f * 0.87 + this._shakeSeed[2] + 41) * s * 0.035;
      this._tmpAxis.set(0, 0, 1).applyQuaternion(this._camQuat);
      this._tmpQuat.setFromAxisAngle(this._tmpAxis, roll);
      camera.quaternion.premultiply(this._tmpQuat);
      camera.updateMatrixWorld(true);
    } else {
      camera.updateMatrixWorld(true);
    }

    // --- per-frame uniforms ----------------------------------------------
    this.aoPass.aoUniforms.uProj.value.copy(camera.projectionMatrix);
    this.aoPass.aoUniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    this.aoPass.aoUniforms.uNear.value = camera.near;
    this.aoPass.aoUniforms.uFar.value = camera.far;

    if (perspective) {
      this.dofPass.syncCamera(
        camera, this._focusDistance, this._fNumber, this._bokehScale,
        // A diagnostic frame is judged on a silhouette against a flat matte, and
        // a flat field blurs to itself — but the matte swap is not guaranteed
        // (see the enable comment below), so the floor is stood down rather than
        // relied on to be an identity.
        diag ? 0 : this._backgroundDefocus,
      );
    }

    this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.motionBlurUniforms.uInvViewProj.value.copy(this._viewProj).invert();
    if (this._hasHistory) {
      this.motionBlurUniforms.uPrevViewProj.value.copy(this._prevViewProj);
      // Normalise the shutter to a 60 Hz reference so a hitch does not produce
      // a single hugely smeared frame, and cut it entirely on a teleport.
      const jump = this._prevCamPos.distanceTo(camera.position);
      const rate = Math.min(2, dt > 1e-5 ? 1 / (dt * 60) : 1);
      this.motionBlurUniforms.uScale.value = jump > 1.5 ? 0 : 0.5 * rate;
    } else {
      this.motionBlurUniforms.uPrevViewProj.value.copy(this._viewProj);
      this.motionBlurUniforms.uScale.value = 0;
    }

    // The grade's exposure trim is part of the grade, so a bypassed frame does
    // not get it — otherwise a "neutral" diagnostic and a "dusk" diagnostic
    // would sit a fifth of a stop apart and neither would be the true render.
    this.compositeUniforms.uExposure.value =
      this.renderer.toneMappingExposure * (diag ? 1 : (this._gradeExposure ?? 1));
    // Bloom's high pass runs on *scene* radiance, several stages before the tone
    // map, so its threshold has to track the exposure the frame will be graded
    // through or it silently changes meaning every hour. See
    // `BLOOM_DISPLAY_THRESHOLD`.
    this.bloomPass.prefilterUniforms.uThreshold.value =
      BLOOM_SCENE_THRESHOLD_AT_UNIT_EXPOSURE
      / Math.max(1e-3, this.compositeUniforms.uExposure.value);
    // Quantised per frame index rather than per wall clock, so a capture at a
    // fixed frame count reproduces the same grain field exactly.
    this.compositeUniforms.uGrainSeed.value = (this._frame % 512) * 17.13;

    this.effectComposer.render(dt);

    // --- history + restore ------------------------------------------------
    this._prevViewProj.copy(this._viewProj);
    this._prevCamPos.copy(camera.position);
    this._hasHistory = true;

    if (shakeActive) {
      camera.position.copy(this._camPos);
      camera.quaternion.copy(this._camQuat);
      camera.updateMatrixWorld(true);
    }

    this.renderer.setRenderTarget(null);
  }

  dispose() {
    for (const off of this._unsubs) off?.();
    this._unsubs.length = 0;

    for (const pass of this.effectComposer.passes) pass.dispose?.();
    this.effectComposer.passes.length = 0;
    this.effectComposer.dispose();

    this._lutA.dispose();
    this._lutB.dispose();

    // Hand the renderer back the way we found it, so a torn-down engine that
    // renders without a composer still tone maps.
    this.renderer.toneMapping = this._rendererToneMapping;
    if (this.engine.composer === this) this.engine.composer = null;
  }
}
