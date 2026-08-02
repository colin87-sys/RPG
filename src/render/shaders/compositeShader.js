/**
 * compositeShader.js — chromatic aberration, the depth-keyed value structure,
 * impact flash, tone map, LUT grade, film grain and vignette, in that order, in
 * one pass.
 *
 * The chain order mandated by ARCHITECTURE.md is preserved exactly; what is
 * *not* preserved is one render target per stage. These stages are all pure
 * per-pixel arithmetic with no neighbourhood dependency beyond aberration's
 * taps, so splitting them would cost several additional full-resolution
 * half-float round trips — on a 1080p browser target that is roughly 50 MB/frame
 * of pure bandwidth bought for zero image-quality difference. Each stage keeps
 * its own uniforms and its own enable flag, so they remain independently
 * tunable and independently switchable from `setQuality`.
 *
 * ## The value structure, and why it lives here
 *
 * ART_BIBLE §6 and REFERENCE_TARGET §3 both ask for one thing: **dark foreground
 * framing, bright midground subject, atmospheric-perspective background.** A
 * named LUT grade cannot express that and never could — a colour cube is a
 * function of colour alone, so it applies the identical transform to a hero's
 * cheek and to the sky forty metres behind them. Measured on the shipped frame
 * the relationship was running exactly backwards: sky L 170, mist L 149, party
 * L 80, foreground ground L 18. The cast was the darkest, lowest-chroma object
 * on screen and the foreground was a black void with grain crawling in it.
 *
 * The fix is not a different set of grade numbers, it is a different *operator*:
 * the grade is now **depth-keyed**. Window depth is resolved to a view distance
 * and split into three smoothly-feathered zones anchored on the live focal plane
 * — which PostFX already tracks, and which scenes already park on the party —
 * and each zone is given its own treatment:
 *
 *  - **subject band** — partial removal of the scene's own aerial perspective
 *    (an exact `FogExp2` un-mix, so the cast stops being washed toward the mist
 *    colour), an exposure lift before the tone map, then extra contrast about a
 *    low pivot and extra chroma after it. This is what makes the cast the
 *    highest-value, highest-chroma, highest-contrast object in frame.
 *  - **foreground** — a tinted lift that pulls the crushed near ground off the
 *    floor so it frames the shot as a dark *shape* rather than as a hole.
 *  - **background** — a haze lift plus a desaturation, so the stage keeps its
 *    brightness but drops below the cast in chroma and in local contrast.
 *
 * Zone weights are smooth in depth but the depth buffer is not smooth *across a
 * silhouette*, so the transition at a character's edge is one pixel wide and
 * reads as part of the contour rather than as a halo. FXAA resolves it.
 *
 * Colour-space discipline, which is where most post chains quietly go wrong:
 *  - input is linear HDR (the renderer's tone mapping is disabled by PostFX so
 *    bloom can read above 1.0),
 *  - the un-mix and the subject exposure lift are applied in that linear space,
 *    because fog is composited linearly and because an exposure change has to
 *    roll off on the filmic shoulder instead of clipping,
 *  - the flash is added *before* the tone map so it rolls off filmically
 *    instead of clipping to a flat white rectangle,
 *  - the LUT is applied *after* sRGB encoding, because a grade authored as
 *    lift/gamma/gain is a display-referred operation and applying it to linear
 *    values crushes midtone hue,
 *  - the zonal trims land *after* the LUT. That ordering is deliberate: the
 *    value structure is a compositional guarantee that must hold under `dusk`,
 *    `battle` and `boss` alike, and a grade with contrast 1.18 applied on top of
 *    a lifted foreground would simply crush it back down again,
 *  - grain and vignette follow in that same display-referred space, so grain
 *    amplitude is perceptually uniform rather than invisible in the shadows,
 *  - the pass therefore outputs already-encoded sRGB. Nothing downstream may
 *    encode again.
 *
 * `uGradeAmount` exists so a diagnostic render (the silhouette check) can run
 * the exposure + ACES + sRGB encode this pass owns — without which the frame
 * would be raw linear HDR and unreadable — while skipping the creative grade
 * entirely. Aberration, the value structure, grain and vignette are zeroed by
 * their own uniforms on that path, so a diagnostic frame is a straight
 * tone-mapped beauty buffer.
 */
import { GLSL_POST_COMMON, GLSL_ACES, GLSL_LUT } from './postCommon.js';

export const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uResolution;

// Total R<->B separation at the frame CORNER, as a fraction of frame *width*.
// A fraction, not pixels: lateral chromatic aberration is a property of the
// lens' image circle, so the same glass fringes the same amount of the picture
// at any capture resolution. ART_BIBLE §6 steady state is 0.0012.
uniform float uAberration;
uniform vec3 uFlash;            // additive HDR, already scaled by its decay
uniform float uExposure;

uniform sampler2D uLutA;        // grade we are fading from
uniform sampler2D uLutB;        // grade we are fading to
uniform float uLutMix;
uniform float uLutSize;
uniform float uGradeAmount;     // 1 = graded, 0 = diagnostic passthrough

uniform float uGrain;
uniform float uGrainSeed;

uniform float uVignette;
uniform float uVignetteOffset;
uniform vec3 uVignetteColor;

// --- depth-keyed value structure ---------------------------------------------
uniform sampler2D tDepth;
uniform vec2 uCamNearFar;
// Master weight. 0 on a diagnostic frame and on any orthographic camera, for
// which the perspective depth reconstruction below is simply wrong.
uniform float uStructure;
uniform float uSubjectDistance;   // metres to the focal plane; the party lives here
uniform vec2 uSubjectBand;        // x = flat-top half width, y = feather, metres
uniform float uSubjectGain;       // linear exposure lift on the subject band
uniform float uSubjectContrast;   // display-referred, about SUBJECT_PIVOT
uniform float uSubjectSaturation;
uniform float uSubjectGrain;      // grain multiplier on the cast; ~0 keeps skin clean
uniform float uDehaze;            // fraction of the scene fog un-mixed on the band
uniform vec3 uFogColor;           // linear working space, straight off scene.fog
uniform float uFogDensity;        // FogExp2 density; 0 disables the un-mix
uniform vec3 uForeLift;           // display-referred tinted floor for the foreground
uniform vec3 uFarLift;            // display-referred haze floor for the background
uniform float uFarSaturation;

varying vec2 vUv;

${GLSL_POST_COMMON}
${GLSL_ACES}
${GLSL_LUT}

// Radius, as a fraction of the half-diagonal, inside which aberration is
// identically zero. The centre-40% box of a 16:9 frame has its own corners at
// r = 0.400 of the half-diagonal, so 0.45 encloses the whole of it with margin:
// faces, hair silhouettes and every UI glyph composed on a thirds intersection
// sit in a region where the weight is not "small", it is exactly 0.0.
const float CA_INNER = 0.45;

// Sub-half-pixel separation cannot resolve as colour: the three channels land
// inside one bilinear footprint. Skipping the gather there is both a bandwidth
// win and the guarantee that the frame centre is bit-identical to a render with
// aberration switched off.
const float CA_MIN_SEPARATION_PX = 0.5;

// Taps across the dispersion, not across the channels. See the loop below.
#define CA_TAPS 5

// Pivot for the subject band's contrast expansion, in display-referred units.
// Deliberately below the grade's 0.435 midtone pivot: rotating about a *low*
// pivot lifts the lit side further than it drops the shadow side, which is the
// hard terminator ANIME_PIPELINE §2 asks for rather than a symmetric S-curve
// that would just re-crush the cel shadow the character shader worked to place.
const float SUBJECT_PIVOT = 0.42;

void main() {
  // --- 7. chromatic aberration ------------------------------------------
  // Work in pixels, not UV. A radial offset built from raw UV deltas is
  // anisotropic on a non-square frame — it fringes ~1.8x harder vertically at
  // 16:9 — which is why the old formulation put visible colour on frame content
  // well inboard of the edge while the corners still looked under-done.
  vec2 px = (vUv - 0.5) * uResolution;
  float rpx = length(px);
  float rn = rpx / (length(uResolution) * 0.5);   // 0 at centre, exactly 1 at the corner

  // Squared smoothstep. The plain curve leaves a long shallow toe that spreads
  // a fraction of a pixel of separation across the whole mid-field, and a
  // fraction of a pixel is all it takes to split a one-pixel-wide hair spike
  // into magenta and cyan. Squaring collapses that toe so the effect lives in
  // the outer ~25% of the image, which is what ART_BIBLE §7 means by "felt at
  // the edge" rather than "seen on the subject".
  float w = smoothstep(CA_INNER, 1.0, rn);
  w *= w;

  // The previous formulation carried its strength as "pixels at the corner" and
  // then displaced red by that much *and* blue by the same amount the other way,
  // so the real separation was double the number in the uniform: 3.4 px on a
  // 1280-wide frame, i.e. 0.0026 of frame width against a specced 0.0012. Half
  // the fix for the fringing the art director flagged is simply measuring the
  // thing the bible measures.
  float sepPx = uAberration * uResolution.x * w;
  vec3 color;

  // Branching around the taps is safe despite the implicit-derivative rule:
  // tDiffuse is a LinearFilter target with no mip chain, so there is no LOD for
  // divergent control flow to get wrong.
  if (sepPx < CA_MIN_SEPARATION_PX) {
    color = texture2D(tDiffuse, vUv).rgb;
  } else {
    // Spectral integration rather than three hard channel taps.
    //
    // The classic red-here / blue-there formulation is not dispersion, it is
    // three displaced *copies* of the image, and the moment the offset passes a
    // pixel any thin high-contrast feature reads as a hard magenta/cyan double
    // edge instead of as glass. Sampling the whole spread and weighting each tap
    // by a Gaussian channel response reconstructs a continuous ramp, so even a
    // multi-pixel impact spike reads as a lens smearing light. In the limit of
    // zero offset every tap collapses onto the same texel and the result is
    // identical to a plain fetch, so there is no bias to correct for.
    vec2 dir = px / max(rpx, 1e-4);
    vec2 offUv = dir * (sepPx * 0.5) / uResolution;   // half-separation, per axis

    vec3 accum = vec3(0.0);
    vec3 wsum = vec3(0.0);
    for (int i = 0; i < CA_TAPS; i++) {
      float t = float(i) * (2.0 / float(CA_TAPS - 1)) - 1.0;   // -1 (blue end) .. +1 (red end)
      // sigma chosen so a tap half a step off-peak still carries 22% weight but
      // the opposite end of the spectrum carries 0.2% — a soft dispersion tail
      // without turning the outer frame into a blur.
      vec3 dt = vec3(t - 1.0, t, t + 1.0);
      vec3 sw = exp(-dt * dt * 6.0);
      accum += texture2D(tDiffuse, vUv + offUv * t).rgb * sw;
      wsum += sw;
    }
    color = accum / wsum;
  }

  // --- 7b. depth zones ---------------------------------------------------
  // One depth fetch drives every zonal decision in this pass. It is taken at
  // vUv rather than at the aberrated tap positions on purpose: aberration is
  // identically zero across the inner 45% of the frame and sub-pixel outside it,
  // so re-fetching depth per tap would cost four extra samples to move a zone
  // boundary by less than a pixel.
  float wFore = 0.0;
  float wSubject = 0.0;
  float wFar = 0.0;
  float zView = 0.0;
  if (uStructure > 0.0) {
    zView = -viewZFromDepth(texture2D(tDepth, vUv).x, uCamNearFar.x, uCamNearFar.y);
    float hw = max(0.05, uSubjectBand.x);
    float feather = max(0.05, uSubjectBand.y);
    // A plateau rather than a bump: every party member in the staggered
    // diagonal, and the enemy opposite them, must get the *same* treatment or
    // the stagger itself would read as a lighting inconsistency.
    wFore = 1.0 - smoothstep(uSubjectDistance - hw - feather, uSubjectDistance - hw, zView);
    wFar = smoothstep(uSubjectDistance + hw, uSubjectDistance + hw + feather, zView);
    wSubject = (1.0 - wFore) * (1.0 - wFar);
    wFore *= uStructure;
    wFar *= uStructure;
    wSubject *= uStructure;
  }

  // --- 7c. un-mix the scene's own aerial perspective off the cast ---------
  // The characters were measured at (67,82,93) — less saturated than the pine
  // trees behind them — because the same fog that is *correctly* washing the
  // distance is also sitting on them. Rather than weakening the fog globally
  // (which would cost the atmospheric perspective that is the best thing in the
  // frame), invert it analytically over the subject band only.
  //
  // three composites FogExp2 as mix(surface, fog, 1 - exp(-(d*z)^2)), so the
  // surface radiance is recoverable exactly, and re-mixing at a reduced density
  // leaves the cast sitting in thinner air than the stage behind it.
  float dehaze = uDehaze * wSubject;
  if (dehaze > 1e-3 && uFogDensity > 0.0) {
    float fd = uFogDensity * zView;
    // Clamped short of 1.0 because the division below is unbounded as f -> 1.
    // The band never reaches that depth, but a scene that parks the focal plane
    // in the fog bank must degrade rather than produce infinities.
    float f = min(0.95, 1.0 - exp(-fd * fd));
    vec3 surface = max((color - uFogColor * f) / max(1e-3, 1.0 - f), vec3(0.0));
    color = mix(surface, uFogColor, f * (1.0 - dehaze));
  }

  // --- 7d. subject exposure (linear, so ACES rolls it off) ----------------
  // Solved, not guessed: the shipped lit side landed at display 0.314, which is
  // ACES input 0.150; display 0.52 — the middle of the 130-150 band the review
  // asks for — is ACES input 0.315. The ratio is 2.1.
  color *= mix(1.0, uSubjectGain, wSubject);

  // --- impact flash (pre-tonemap, so it blows out on the shoulder) -------
  color += uFlash;

  // --- 8a. exposure + filmic tone map ------------------------------------
  color = acesFilmic(color * uExposure);

  // --- 8b. grade: encode, then cross-faded LUT ---------------------------
  vec3 e = srgbEncode(color);
  vec3 gA = sampleLutStrip(uLutA, e, uLutSize);
  vec3 gB = sampleLutStrip(uLutB, e, uLutSize);
  e = mix(e, mix(gA, gB, uLutMix), uGradeAmount);

  // --- 8c. zonal trims (after the grade — see the header) -----------------
  // Branched, not weighted, so a diagnostic frame is bit-identical to one
  // rendered with this stage absent: every operator below is an algebraic
  // identity at zero weight, but "algebraic identity" is not "the same float".
  if (uStructure > 0.0) {
    // Contrast first, then saturation, matching the order inside the grade
    // itself so the two operators compose predictably instead of fighting over
    // hue.
    float contrast = mix(1.0, uSubjectContrast, wSubject);
    e = vec3(SUBJECT_PIVOT) + (e - vec3(SUBJECT_PIVOT)) * contrast;

    // The zones are disjoint, so one multiply carries both trims: the cast
    // gains chroma, the stage loses it. Chroma — not luminance — is the
    // discriminator the reference actually uses; FFBE skies are brighter than
    // its heroes, but its heroes are always the most saturated thing on screen.
    float sat = mix(1.0, uSubjectSaturation, wSubject) * mix(1.0, uFarSaturation, wFar);
    float sl = luma(e);
    e = vec3(sl) + (e - vec3(sl)) * sat;

    // Tinted lifts. lift + e * (1 - lift) pins white and maps black onto the
    // lift colour, so the foreground stops being a void and the background
    // stops holding deep darks that compete with the cast — without either one
    // clipping. Both colours carry a hue: ART_BIBLE's no-grey-shadows rule
    // applies to a lifted floor exactly as it applies to a rendered one.
    vec3 lift = uForeLift * wFore + uFarLift * wFar;
    e = lift + e * (1.0 - lift);
    e = clamp(e, 0.0, 1.0);
  }

  // --- 9. film grain -----------------------------------------------------
  // Gated to the midtones by a pair of smoothsteps rather than by the old
  // 4L(1-L) parabola. The parabola still carries a quarter of full amplitude at
  // L = 0.07, which is precisely where the crushed foreground sits and precisely
  // where the review found "noise still visible inside it" — grain there reads
  // as sensor noise, not as film. The upper gate keeps it off blown rims, where
  // it crawls.
  //
  // The subject band is additionally scaled to near zero: ANIME_PIPELINE's
  // absolute rule is that no procedural noise may touch a character surface, and
  // a full-screen grain field is still noise on a character surface.
  float g = hash12(gl_FragCoord.xy + vec2(uGrainSeed, uGrainSeed * 1.618)) - 0.5;
  float L = luma(e);
  float env = smoothstep(0.08, 0.30, L) * (1.0 - smoothstep(0.70, 0.94, L));
  e += g * uGrain * mix(1.0, uSubjectGrain, wSubject) * env;

  // --- 10. vignette ------------------------------------------------------
  // Slightly elliptical (taller than wide) so it hugs a 16:9 frame instead of
  // cutting circular corners, and it darkens *toward the teal-black floor*
  // rather than toward black — the shadow rule applies here too.
  vec2 vv = (vUv - 0.5) * vec2(2.0, 2.24) / max(0.25, uVignetteOffset);
  float vr = length(vv);
  float inner = smoothstep(1.45, 0.55, vr);
  float v = 1.0 - uVignette * (1.0 - inner);
  e = mix(uVignetteColor, e, v);

  gl_FragColor = vec4(clamp(e, 0.0, 1.0), 1.0);
}
`;
