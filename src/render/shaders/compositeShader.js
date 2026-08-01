/**
 * compositeShader.js — chromatic aberration, impact flash, tone map, LUT grade,
 * film grain and vignette, in that order, in one pass.
 *
 * The chain order mandated by ARCHITECTURE.md is preserved exactly; what is
 * *not* preserved is one render target per stage. These four stages are all
 * pure per-pixel arithmetic with no neighbourhood dependency beyond aberration's
 * three taps, so splitting them would cost three additional full-resolution
 * half-float round trips — on a 1080p browser target that is roughly 50 MB/frame
 * of pure bandwidth bought for zero image-quality difference. Each stage keeps
 * its own uniforms and its own enable flag, so they remain independently
 * tunable and independently switchable from `setQuality`.
 *
 * Colour-space discipline, which is where most post chains quietly go wrong:
 *  - input is linear HDR (the renderer's tone mapping is disabled by PostFX so
 *    bloom can read above 1.0),
 *  - the flash is added *before* the tone map so it rolls off filmically
 *    instead of clipping to a flat white rectangle,
 *  - the LUT is applied *after* sRGB encoding, because a grade authored as
 *    lift/gamma/gain is a display-referred operation and applying it to linear
 *    values crushes midtone hue,
 *  - grain and vignette follow in that same display-referred space, so grain
 *    amplitude is perceptually uniform rather than invisible in the shadows,
 *  - the pass therefore outputs already-encoded sRGB. Nothing downstream may
 *    encode again.
 *
 * `uGradeAmount` exists so a diagnostic render (the silhouette check) can run
 * the exposure + ACES + sRGB encode this pass owns — without which the frame
 * would be raw linear HDR and unreadable — while skipping the creative grade
 * entirely. Aberration, grain and vignette are zeroed by their own uniforms on
 * that path, so a diagnostic frame is a straight tone-mapped beauty buffer.
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

  // --- impact flash (pre-tonemap, so it blows out on the shoulder) -------
  color += uFlash;

  // --- 8a. exposure + filmic tone map ------------------------------------
  color = acesFilmic(color * uExposure);

  // --- 8b. grade: encode, then cross-faded LUT ---------------------------
  vec3 e = srgbEncode(color);
  vec3 gA = sampleLutStrip(uLutA, e, uLutSize);
  vec3 gB = sampleLutStrip(uLutB, e, uLutSize);
  e = mix(e, mix(gA, gB, uLutMix), uGradeAmount);

  // --- 9. film grain -----------------------------------------------------
  // Luminance-weighted with a 4L(1-L) envelope: maximum in the mids, zero at
  // both ends. Grain in the blacks reads as sensor noise and destroys the
  // crushed-shadow value structure; grain in the highlights crawls on rims.
  float g = hash12(gl_FragCoord.xy + vec2(uGrainSeed, uGrainSeed * 1.618)) - 0.5;
  float L = luma(e);
  float env = 4.0 * L * (1.0 - L);
  e += g * uGrain * env;

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
