/**
 * skyCommon.js — GLSL building blocks shared by every stage of the sky dome.
 *
 * These are exported as source strings rather than as `#include` chunks because
 * three's chunk registry is global state; the sky is the only consumer of these
 * functions and polluting `THREE.ShaderChunk` would make them everyone's
 * problem. Concatenation order is owned by `skyFragment.js`.
 *
 * Everything here is hash-based. Not one texture fetch happens in the sky, which
 * is both the project's asset rule and — for a dome that covers every pixel of
 * every outdoor frame — the cheaper choice on tile-based hardware anyway.
 *
 * Written in GLSL ES 1.00 dialect. three 0.185 rewrites ShaderMaterial sources
 * to `#version 300 es` with compatibility defines (`varying`, `gl_FragColor`,
 * `texture2D`), so the 1.00 spelling is correct and portable here — but the
 * 3.00 type rules still apply, which is why every literal is explicitly float.
 */

/** Ray/sphere intersection, phase functions and the small maths utilities. */
export const GLSL_MATH = /* glsl */ `
const float INV_4PI  = 0.07957747154594;
const float THREE_16PI = 0.05968310365946;   // 3 / (16 pi), Rayleigh normalisation

/**
 * Roots of the intersection between a ray and a sphere centred on the origin.
 * Returns (near, far); an inverted interval (x > y) means "missed", which the
 * callers test with a single comparison instead of an extra bool.
 */
vec2 raySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return vec2(1.0, -1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

/** Rayleigh phase — molecular scattering is nearly symmetric fore and aft. */
float phaseRayleigh(float mu) {
  return THREE_16PI * (1.0 + mu * mu);
}

/**
 * Henyey-Greenstein. Mie scattering off aerosols is violently forward-peaked
 * (g ~ 0.76 in clean air, dropping as droplets grow), and that forward lobe is
 * exactly the bright aureole that wraps the sun and the silver lining on a
 * cloud edge. Without it the sky is a flat blue ball.
 */
float phaseHG(float mu, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * mu;
  return INV_4PI * (1.0 - g2) / (denom * sqrt(max(1e-4, denom)));
}

/** Two-lobe phase: a forward lobe for the aureole, a weak back lobe for glow. */
float phaseDual(float mu, float g, float backMix) {
  return mix(phaseHG(mu, g), phaseHG(mu, -0.28), backMix);
}

/** 2D rotation, used to decorrelate fbm octaves so the field has no grain. */
mat2 rot2(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}
`;

/**
 * Hashes and value noise.
 *
 * The hashes are the "hash without sine" family: pure fract/dot arithmetic with
 * no trig. Sine-based hashes are the usual shadertoy shortcut but their output
 * depends on the driver's sin() precision, which means the star field would
 * differ between an Intel iGPU and a discrete NVIDIA card — unacceptable when
 * the screenshot harness has to reproduce frames exactly.
 */
export const GLSL_NOISE = /* glsl */ `
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

/** Quintic fade — C2 continuous, so fbm derivatives never show grid creases. */
vec2 fade2(vec2 f) { return f * f * f * (f * (f * 6.0 - 15.0) + 10.0); }
vec3 fade3(vec3 f) { return f * f * f * (f * (f * 6.0 - 15.0) + 10.0); }

float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fade2(fract(p));
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fade3(fract(p));
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

/**
 * fBm with a per-octave rotation. The rotation matters more than the octave
 * count: without it every octave shares the same axis-aligned lattice and the
 * result reads as a plaid weave rather than as cloud.
 */
float fbm2(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  mat2 m = rot2(0.517);
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise2(p);
    norm += amp;
    p = m * p * 2.02 + 11.7;
    amp *= 0.5;
  }
  return sum / max(1e-4, norm);
}

float fbm3(vec3 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise3(p);
    norm += amp;
    p = p * 2.04 + vec3(7.3, 13.1, 5.9);
    amp *= 0.5;
  }
  return sum / max(1e-4, norm);
}
`;

/**
 * Cube-face parameterisation of a direction.
 *
 * The obvious way to tile a sphere for a star field is lat/long, which bunches
 * cells savagely at the poles and gives the zenith a visible drain-hole of
 * stars. Projecting onto the dominant cube face instead keeps cell solid angle
 * within about 1.7x across the whole sphere, which is invisible.
 */
export const GLSL_CUBEUV = /* glsl */ `
vec2 dirToCubeUV(vec3 d, out float face) {
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) {
    face = d.x > 0.0 ? 0.0 : 1.0;
    return vec2(d.z, d.y) / a.x;
  }
  if (a.y >= a.z) {
    face = d.y > 0.0 ? 2.0 : 3.0;
    return vec2(d.x, d.z) / a.y;
  }
  face = d.z > 0.0 ? 4.0 : 5.0;
  return vec2(d.x, d.y) / a.z;
}
`;
