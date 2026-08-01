/**
 * aoShader.js — depth-only hemisphere ambient occlusion, bilateral blur, composite.
 *
 * Why hand-written instead of three's `GTAOPass`/`SSAOPass`: both of them run a
 * second full geometry pass to produce a normal buffer. In a scene with skinned
 * chibi rigs, cloth sims and instanced foliage that is a genuine doubling of
 * draw calls for an effect the art bible caps at intensity 0.55. Reconstructing
 * the normal from depth costs four extra depth taps and is indistinguishable at
 * this strength, so the whole pass runs off the depth attachment the beauty
 * pass already wrote.
 *
 * The estimator is a cosine-weighted hemisphere sampler (Ritschel-style):
 * kernel directions come from a golden-ratio low-discrepancy sequence rotated
 * per pixel by interleaved gradient noise, then the noise is resolved by a
 * depth-aware separable blur. Everything runs at half resolution — contact
 * shadows are a low-frequency signal and the upsample is invisible at 0.55.
 *
 * Art-bible contract: this darkens *and tints toward* SHADOW_TINT #2E4A5F.
 * Multiplying by grey would violate the "no neutral shadow" rule outright.
 */
import { POST_VERT, GLSL_POST_COMMON } from './postCommon.js';

export { POST_VERT };

export const AO_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform mat4 uProj;
uniform vec2 uTexel;        // 1 / AO-buffer resolution
uniform float uRadius;      // world-space sample radius, metres
uniform float uBias;        // view-space bias against depth-precision acne
uniform float uNear;
uniform float uFar;
uniform float uPower;
varying vec2 vUv;

${GLSL_POST_COMMON}

/**
 * Normal from depth using the *nearest* of each opposing neighbour pair. The
 * naive central difference smears a normal across every silhouette, which shows
 * up as a bright halo around characters — exactly the artefact this style
 * cannot afford, since characters are the only crisp thing in frame.
 */
vec3 normalFromDepth(vec2 uv, vec3 P) {
  vec2 dx = vec2(uTexel.x, 0.0);
  vec2 dy = vec2(0.0, uTexel.y);
  vec3 l = viewPosFromDepth(uv - dx, texture2D(tDepth, uv - dx).x, uInvProj);
  vec3 r = viewPosFromDepth(uv + dx, texture2D(tDepth, uv + dx).x, uInvProj);
  vec3 d = viewPosFromDepth(uv - dy, texture2D(tDepth, uv - dy).x, uInvProj);
  vec3 u = viewPosFromDepth(uv + dy, texture2D(tDepth, uv + dy).x, uInvProj);
  vec3 ddx = (abs(l.z - P.z) < abs(r.z - P.z)) ? (P - l) : (r - P);
  vec3 ddy = (abs(d.z - P.z) < abs(u.z - P.z)) ? (P - d) : (u - P);
  vec3 n = normalize(cross(ddx, ddy));
  // View-space normals always face the camera; the cross product's winding
  // flips across the "nearest neighbour" branches, so normalise the sign.
  return (n.z < 0.0) ? -n : n;
}

void main() {
  float depth = texture2D(tDepth, vUv).x;
  // Far plane means sky. Occluding the sky would put a grey ring around every
  // silhouette, which is the single most common SSAO failure in shipped games.
  if (depth >= 0.9999) { gl_FragColor = vec4(1.0, 1.0, 1.0, uFar); return; }

  vec3 P = viewPosFromDepth(vUv, depth, uInvProj);
  vec3 N = normalFromDepth(vUv, P);

  // Orthonormal basis around N. The rotation angle is per-pixel so the kernel
  // decorrelates spatially; the blur below turns that into smooth gradient.
  float rot = ign(gl_FragCoord.xy) * TAU;
  vec3 up = abs(N.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(up, N));
  vec3 B = cross(N, T);

  float occlusion = 0.0;
  for (int i = 0; i < AO_SAMPLES; i++) {
    float fi = float(i) + 0.5;
    // Golden-ratio stratification: u1 walks the radius, u2 the azimuth. This
    // beats a uniform random kernel at low sample counts by a wide margin.
    float u1 = fi / float(AO_SAMPLES);
    float u2 = fract(fi * 0.7548776662);
    float r = sqrt(u1);
    float phi = u2 * TAU + rot;
    // Cosine-weighted hemisphere direction, then a radius ramp so samples
    // cluster near the shading point — contact darkening, not global AO.
    vec3 dir = T * (r * cos(phi)) + B * (r * sin(phi)) + N * sqrt(max(0.0, 1.0 - u1));
    float scale = mix(0.15, 1.0, u1 * u1);
    vec3 sp = P + dir * (uRadius * scale);

    vec4 clip = uProj * vec4(sp, 1.0);
    vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;

    float sd = texture2D(tDepth, suv).x;
    if (sd >= 0.9999) continue;
    float sz = viewZFromDepth(sd, uNear, uFar);

    // Range check kills the classic "distant wall occludes near object" halo.
    float range = smoothstep(0.0, 1.0, uRadius / max(0.0001, abs(P.z - sz)));
    occlusion += (sz >= sp.z + uBias ? 1.0 : 0.0) * range;
  }

  float ao = 1.0 - occlusion / float(AO_SAMPLES);
  ao = pow(clamp(ao, 0.0, 1.0), uPower);
  // Alpha carries view depth in *metres*, not normalised — hence the half-float
  // AO buffer. Packed into 8 bits against a 4 km far plane, one quantisation
  // step would be 15 m and the bilateral weight below would be meaningless.
  gl_FragColor = vec4(ao, ao, ao, -P.z);
}
`;

/**
 * Separable depth-aware blur. A plain Gaussian would bleed occlusion across
 * silhouettes; weighting each tap by depth similarity keeps the contact
 * shadow welded to the object that casts it.
 */
export const AO_BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform vec2 uDirection;   // texel-sized step, horizontal or vertical
uniform float uDepthSigma; // falloff per metre of depth disagreement
varying vec2 vUv;

${GLSL_POST_COMMON}

void main() {
  vec4 c = texture2D(tAO, vUv);
  float centerDepth = c.a;
  // 9-tap binomial kernel; the weights are the row of Pascal's triangle so the
  // response is a true Gaussian without storing a lookup.
  const float W[5] = float[5](0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
  float sum = c.r * W[0];
  float total = W[0];
  for (int i = 1; i < 5; i++) {
    for (int s = 0; s < 2; s++) {
      vec2 off = uDirection * float(i) * (s == 0 ? 1.0 : -1.0);
      vec4 t = texture2D(tAO, vUv + off);
      float dw = exp(-abs(t.a - centerDepth) * uDepthSigma);
      float w = W[i] * dw;
      sum += t.r * w;
      total += w;
    }
  }
  float ao = sum / max(total, 1e-4);
  gl_FragColor = vec4(ao, ao, ao, centerDepth);
}
`;

/**
 * Composite. The occluded colour is not `color * ao` but a lerp toward a dark
 * teal, so full occlusion lands on SHADOW_TINT's hue rather than on grey — the
 * art bible's shadow rule applies to screen-space shadowing too.
 */
export const AO_COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tAO;
uniform vec3 uAOColor;
uniform float uIntensity;
varying vec2 vUv;

void main() {
  vec4 base = texture2D(tDiffuse, vUv);
  float ao = texture2D(tAO, vUv).r;
  float occ = clamp((1.0 - ao) * uIntensity, 0.0, 1.0);
  vec3 tinted = base.rgb * mix(vec3(1.0), uAOColor, occ);
  gl_FragColor = vec4(tinted, base.a);
}
`;
