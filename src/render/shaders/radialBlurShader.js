/**
 * radialBlurShader.js — centre-weighted speedlines for limit breaks.
 *
 * Two things separate a good radial blur from the "zoom blur" filter look:
 * the centre must stay perfectly sharp (the player is reading the character
 * that just triggered the break), and the streaks must desaturate slightly
 * outward so they read as light smear rather than as a smudged copy of the
 * frame. Both are handled here; at `uStrength == 0` the pass is disabled on the
 * JS side entirely so it costs nothing at rest.
 */
import { GLSL_POST_COMMON } from './postCommon.js';

export const RADIAL_BLUR_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uCenter;
uniform float uStrength;   // 0 at rest, ~0.35 on limit-release
varying vec2 vUv;

${GLSL_POST_COMMON}

void main() {
  vec2 delta = vUv - uCenter;
  float r = length(delta);
  // Protected centre: nothing inside 12% of the frame radius moves at all.
  float falloff = smoothstep(0.12, 0.62, r);
  float amount = uStrength * falloff;

  vec4 base = texture2D(tDiffuse, vUv);
  if (amount < 0.001) { gl_FragColor = base; return; }

  float jitter = ign(gl_FragCoord.xy);
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < RADIAL_TAPS; i++) {
    float t = (float(i) + jitter) / float(RADIAL_TAPS);
    // Sampling toward the centre (scale < 1) rather than away from it keeps
    // the streaks anchored on the focal point instead of dragging the frame
    // edges inward, which would wobble the UI safe area.
    float scale = 1.0 - t * 0.30 * amount;
    vec3 s = texture2D(tDiffuse, uCenter + delta * scale).rgb;
    float w = 1.0 - t * 0.55;
    sum += s * w;
    total += w;
  }
  vec3 streaks = sum / total;

  // Slight outward desaturation: energy, not a smeared photograph.
  float l = luma(streaks);
  streaks = mix(streaks, vec3(l), amount * 0.25);

  gl_FragColor = vec4(mix(base.rgb, streaks, amount), base.a);
}
`;
