/**
 * motionBlurShader.js — camera-velocity reprojection blur.
 *
 * Per-object velocity would need a velocity G-buffer and therefore a second
 * geometry pass over skinned rigs; the art bible explicitly scopes this to
 * camera-only for that reason. Reprojection gives camera motion for free: the
 * depth buffer plus the previous frame's view-projection matrix is enough to
 * recover where each pixel *was*, with no extra draw calls at all.
 *
 * The velocity is computed per frame and then normalised to a 60 Hz reference
 * shutter, so the blur length does not double when the frame rate halves —
 * without that, a hitch produces a smeared frame that reads as a bug.
 */
import { GLSL_POST_COMMON } from './postCommon.js';

export const MOTION_BLUR_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4 uInvViewProj;    // this frame:  clip -> world
uniform mat4 uPrevViewProj;   // last frame:  world -> clip
uniform float uScale;         // shutter angle, frame-rate normalised
uniform float uMaxVelocity;   // clamp, in UV
varying vec2 vUv;

${GLSL_POST_COMMON}

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  float depth = texture2D(tDepth, vUv).x;

  vec4 clip = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = uInvViewProj * clip;
  world /= world.w;

  vec4 prevClip = uPrevViewProj * world;
  // Behind the previous frame's eye: no meaningful history, leave it sharp.
  if (prevClip.w <= 0.0) { gl_FragColor = base; return; }
  vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

  vec2 velocity = (vUv - prevUv) * uScale;
  float len = length(velocity);
  if (len < 1e-4) { gl_FragColor = base; return; }
  if (len > uMaxVelocity) velocity *= uMaxVelocity / len;

  // Jittered taps: a regular tap spacing turns a fast pan into visible ghost
  // copies, whereas a per-pixel offset turns the same error into fine noise
  // that the grain pass later hides completely.
  float jitter = ign(gl_FragCoord.xy) - 0.5;
  vec3 sum = base.rgb;
  float total = 1.0;
  for (int i = 1; i < MB_TAPS; i++) {
    float t = (float(i) + jitter) / float(MB_TAPS);
    vec2 uv = clamp(vUv - velocity * t, vec2(0.0), vec2(1.0));
    // Weight falls off along the trail so the shutter has a soft tail rather
    // than a hard box, which is what makes it read as motion and not as ghosting.
    float w = 1.0 - t * 0.6;
    sum += texture2D(tDiffuse, uv).rgb * w;
    total += w;
  }

  gl_FragColor = vec4(sum / total, base.a);
}
`;
