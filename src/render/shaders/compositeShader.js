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
 */
import { GLSL_POST_COMMON, GLSL_ACES, GLSL_LUT } from './postCommon.js';

export const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uResolution;

uniform float uAberration;      // px of R/B separation at the frame corner
uniform vec3 uFlash;            // additive HDR, already scaled by its decay
uniform float uExposure;

uniform sampler2D uLutA;        // grade we are fading from
uniform sampler2D uLutB;        // grade we are fading to
uniform float uLutMix;
uniform float uLutSize;

uniform float uGrain;
uniform float uGrainSeed;

uniform float uVignette;
uniform float uVignetteOffset;
uniform vec3 uVignetteColor;

varying vec2 vUv;

${GLSL_POST_COMMON}
${GLSL_ACES}
${GLSL_LUT}

void main() {
  // --- 7. chromatic aberration ------------------------------------------
  // Radial and edge-weighted. Real lenses have essentially zero lateral
  // chromatic error on axis, and the art bible forbids fringing near frame
  // centre where the UI and faces live, so the centre 40% is untouched.
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d) * 4.0;                 // 1.0 at edge midpoints
  float w = smoothstep(0.40, 1.35, r2);
  vec2 off = d * (uAberration * w) / (uResolution * 0.5);

  vec3 color;
  color.r = texture2D(tDiffuse, vUv + off).r;
  color.g = texture2D(tDiffuse, vUv).g;
  color.b = texture2D(tDiffuse, vUv - off).b;

  // --- impact flash (pre-tonemap, so it blows out on the shoulder) -------
  color += uFlash;

  // --- 8a. exposure + filmic tone map ------------------------------------
  color = acesFilmic(color * uExposure);

  // --- 8b. grade: encode, then cross-faded LUT ---------------------------
  vec3 e = srgbEncode(color);
  vec3 gA = sampleLutStrip(uLutA, e, uLutSize);
  vec3 gB = sampleLutStrip(uLutB, e, uLutSize);
  e = mix(gA, gB, uLutMix);

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
