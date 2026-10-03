/**
 * GLSL noise helpers for the World lane (WebGL2 / GLSL ES 3.0: integer hash).
 * Prefix wf* avoids clashes with other chunks.
 */
export const GLSL_NOISE = /* glsl */ `
uint wfHashU(uint x) {
  x ^= x >> 16u; x *= 2146121005u; x ^= x >> 15u; x *= 2221713035u; x ^= x >> 16u;
  return x;
}
float wfHash3(vec3 p) {
  ivec3 i = ivec3(p);
  uint h = wfHashU(uint(i.x) + wfHashU(uint(i.y) + wfHashU(uint(i.z) + 1013904223u)));
  return float(h) * (1.0 / 4294967296.0);
}
float wfHash2(vec2 p) { return wfHash3(vec3(p, 17.0)); }
float wfNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = wfHash3(i);
  float b = wfHash3(i + vec3(1.0, 0.0, 0.0));
  float c = wfHash3(i + vec3(0.0, 1.0, 0.0));
  float d = wfHash3(i + vec3(1.0, 1.0, 0.0));
  float e = wfHash3(i + vec3(0.0, 0.0, 1.0));
  float g = wfHash3(i + vec3(1.0, 0.0, 1.0));
  float h = wfHash3(i + vec3(0.0, 1.0, 1.0));
  float k = wfHash3(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
const mat3 WF_ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
float wfFbm3(vec3 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 6; k++) {
    if (k >= oct) break;
    s += a * wfNoise3(p);
    p = WF_ROT * p * 2.03 + vec3(11.7, 3.1, 7.9);
    a *= 0.5;
  }
  return s;
}
`;
