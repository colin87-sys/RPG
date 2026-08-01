/**
 * bloomShader.js — progressive mip-chain bloom (Jimenez / COD:AW "dual filter").
 *
 * `UnrealBloomPass` is deliberately not used. It builds five *independent*
 * Gaussian blurs of one thresholded image and sums them with hand-tuned
 * weights, which at the strengths this art direction wants produces a hard,
 * ringed halo hugging every bright pixel. The reference frames instead show a
 * very wide, very soft, low-amplitude veil — the signature of a progressive
 * downsample/upsample pyramid, where each mip contributes an energy-conserving
 * fraction rather than an additive copy.
 *
 * The chain is: prefilter (soft-knee threshold + Karis average) → N boxed
 * 13-tap downsamples → N 3x3-tent upsamples, each `mix`ed into the mip above
 * with a radius/scatter factor → single additive composite. Because the
 * upsample is a `mix` and not an `add`, total energy is bounded by the
 * prefiltered image no matter how many mips are in flight, so raising the mip
 * count for 'ultra' widens the veil without brightening it.
 */
import { GLSL_POST_COMMON } from './postCommon.js';

/**
 * Soft-knee high pass. A hard `step(threshold)` makes bloom pop on and off as
 * a highlight crosses 1.0, which is extremely visible on a rim light sliding
 * along a moving character. The quadratic knee spreads that transition over
 * [threshold-knee, threshold+knee].
 *
 * The 4-tap Karis average (weight 1/(1+luma) in *display* luma) is applied here
 * rather than in the first downsample so that a single blown pixel — a specular
 * ping on a blade, a spell core sub-pixel — cannot flicker the whole veil.
 */
export const BLOOM_PREFILTER_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uTexel;        // 1 / source resolution
uniform float uThreshold;
uniform float uKnee;
uniform float uClamp;
varying vec2 vUv;

${GLSL_POST_COMMON}

vec3 fetch(vec2 uv) {
  return min(texture2D(tDiffuse, uv).rgb, vec3(uClamp));
}

void main() {
  vec3 a = fetch(vUv + vec2(-uTexel.x, -uTexel.y));
  vec3 b = fetch(vUv + vec2( uTexel.x, -uTexel.y));
  vec3 c = fetch(vUv + vec2(-uTexel.x,  uTexel.y));
  vec3 d = fetch(vUv + vec2( uTexel.x,  uTexel.y));

  float wa = 1.0 / (1.0 + luma(a));
  float wb = 1.0 / (1.0 + luma(b));
  float wc = 1.0 / (1.0 + luma(c));
  float wd = 1.0 / (1.0 + luma(d));
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / max(1e-4, wa + wb + wc + wd);

  float br = maxc(col);
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contribution = max(soft, br - uThreshold) / max(br, 1e-4);

  gl_FragColor = vec4(col * contribution, 1.0);
}
`;

/**
 * 13-tap downsample. The tap pattern is Jimenez's: four inner corner samples
 * weighted 0.5 total plus a 3x3 grid weighted 0.5, which is a partition of
 * unity and therefore free of the "sparkle crawl" a naive bilinear halving
 * produces when the pyramid is animated.
 */
export const BLOOM_DOWNSAMPLE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uTexel;   // 1 / source resolution
varying vec2 vUv;

void main() {
  vec2 t = uTexel;
  vec3 a = texture2D(tDiffuse, vUv + vec2(-2.0 * t.x,  2.0 * t.y)).rgb;
  vec3 b = texture2D(tDiffuse, vUv + vec2( 0.0,        2.0 * t.y)).rgb;
  vec3 c = texture2D(tDiffuse, vUv + vec2( 2.0 * t.x,  2.0 * t.y)).rgb;
  vec3 d = texture2D(tDiffuse, vUv + vec2(-2.0 * t.x,  0.0)).rgb;
  vec3 e = texture2D(tDiffuse, vUv).rgb;
  vec3 f = texture2D(tDiffuse, vUv + vec2( 2.0 * t.x,  0.0)).rgb;
  vec3 g = texture2D(tDiffuse, vUv + vec2(-2.0 * t.x, -2.0 * t.y)).rgb;
  vec3 h = texture2D(tDiffuse, vUv + vec2( 0.0,       -2.0 * t.y)).rgb;
  vec3 i = texture2D(tDiffuse, vUv + vec2( 2.0 * t.x, -2.0 * t.y)).rgb;
  vec3 j = texture2D(tDiffuse, vUv + vec2(-t.x,  t.y)).rgb;
  vec3 k = texture2D(tDiffuse, vUv + vec2( t.x,  t.y)).rgb;
  vec3 l = texture2D(tDiffuse, vUv + vec2(-t.x, -t.y)).rgb;
  vec3 m = texture2D(tDiffuse, vUv + vec2( t.x, -t.y)).rgb;

  vec3 col = e * 0.125;
  col += (a + c + g + i) * 0.03125;
  col += (b + d + f + h) * 0.0625;
  col += (j + k + l + m) * 0.125;
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * 3x3 tent upsample blended into the finer mip. `uRadius` is the scatter:
 * 0 keeps the pyramid tight and punchy, 1 turns it into an even veil. The
 * reference sits high — around 0.7 — which is what gives mist-heavy frames
 * their glow-through-fog quality.
 */
export const BLOOM_UPSAMPLE_FRAG = /* glsl */ `
uniform sampler2D tLower;   // coarser mip being upsampled
uniform sampler2D tHigher;  // finer mip it is blended into
uniform vec2 uTexel;        // 1 / coarser-mip resolution
uniform float uRadius;
varying vec2 vUv;

void main() {
  vec2 t = uTexel;
  vec3 s = texture2D(tLower, vUv + vec2(-t.x,  t.y)).rgb;
  s += texture2D(tLower, vUv + vec2(0.0,   t.y)).rgb * 2.0;
  s += texture2D(tLower, vUv + vec2( t.x,  t.y)).rgb;
  s += texture2D(tLower, vUv + vec2(-t.x,  0.0)).rgb * 2.0;
  s += texture2D(tLower, vUv).rgb * 4.0;
  s += texture2D(tLower, vUv + vec2( t.x,  0.0)).rgb * 2.0;
  s += texture2D(tLower, vUv + vec2(-t.x, -t.y)).rgb;
  s += texture2D(tLower, vUv + vec2(0.0,  -t.y)).rgb * 2.0;
  s += texture2D(tLower, vUv + vec2( t.x, -t.y)).rgb;
  s *= 0.0625;

  vec3 hi = texture2D(tHigher, vUv).rgb;
  gl_FragColor = vec4(mix(hi, s, uRadius), 1.0);
}
`;

/**
 * Additive composite with a mild chromatic tint. The tint is not decoration:
 * the reference's bloom skews faintly cyan in mist and faintly amber around
 * practicals, and biasing the veil toward the Vesper palette keeps a blown
 * white spell core from resolving as a neutral grey smear.
 */
export const BLOOM_COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uStrength;
uniform vec3 uTint;
varying vec2 vUv;

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  gl_FragColor = vec4(base.rgb + bloom * uTint * uStrength, base.a);
}
`;
