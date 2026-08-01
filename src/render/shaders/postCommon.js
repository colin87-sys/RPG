/**
 * postCommon.js — GLSL building blocks shared by every stage of the post chain.
 *
 * Exported as source strings rather than registered into `THREE.ShaderChunk`
 * because that registry is global state; the post chain is the only consumer of
 * these helpers and polluting the chunk namespace would make them everyone's
 * problem (the sky module made the same call for the same reason).
 *
 * Dialect: GLSL ES 1.00 spelling (`varying`, `texture2D`, `gl_FragColor`).
 * three 0.185 rewrites ShaderMaterial sources to `#version 300 es` with
 * compatibility defines, so this spelling is the portable one — but GLSL 3.00's
 * strict type rules still apply, hence every literal carries an explicit `.0`.
 */

/**
 * Fullscreen vertex shader.
 *
 * `FullScreenQuad` draws a single oversized triangle whose clip-space positions
 * are already in [-1,3]; running them through projection/modelView would be
 * three wasted matrix multiplies per vertex and would make the pass depend on
 * the state of a camera it does not own. Writing clip space directly is both
 * cheaper and immune to anyone mutating that camera.
 */
export const POST_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Straight blit. Used once per frame to move the beauty buffer into the
 *  composer's ping-pong chain; see PostFX.BeautyPass for why that indirection
 *  exists rather than rendering the scene into the chain directly. */
export const COPY_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
`;

/** Colour, noise and depth utilities used by two or more passes. */
export const GLSL_POST_COMMON = /* glsl */ `
const float TAU = 6.28318530718;
const float GOLDEN_ANGLE = 2.39996322973;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }

/**
 * Interleaved gradient noise (Jimenez, "Next Generation Post Processing").
 * One dot product and two fracts — the cheapest per-pixel decorrelated dither
 * that exists, and unlike a blue-noise texture it costs zero bandwidth in a
 * chain that is already bandwidth-bound. Deterministic in screen space, which
 * matters: the capture harness must reproduce a frame exactly.
 */
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/** Whiter hash than IGN — used for grain, where structure would read as pattern. */
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/**
 * Window-space depth to view-space Z (negative, OpenGL convention).
 * Only valid for a perspective projection; every camera in the game is one.
 */
float viewZFromDepth(float d, float near, float far) {
  float ndc = d * 2.0 - 1.0;
  return -(2.0 * near * far) / (far + near - ndc * (far - near));
}

/**
 * Full view-space position from depth via the inverse projection. Preferred
 * over reconstructing from FOV and aspect because it stays correct if a scene
 * hands us an off-centre or oblique frustum (cutscene cameras do).
 */
vec3 viewPosFromDepth(vec2 uv, float d, mat4 invProj) {
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = invProj * clip;
  return v.xyz / v.w;
}

/** IEC 61966-2-1 transfer functions. Written out rather than relying on
 *  three's colorspace_fragment include, which only resolves against the
 *  *current render target's* colour space and is therefore an identity
 *  function everywhere except the final blit to the default framebuffer. */
vec3 srgbEncode(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(0.4166666667)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
vec3 srgbDecode(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
`;

/**
 * ACES filmic tone mapping — Stephen Hill's RRT+ODT fit, byte-for-byte the same
 * curve three's `ACESFilmicToneMapping` applies. Matching it exactly matters:
 * the renderer's tone mapping is switched off so bloom can read HDR, and every
 * other module was lit and graded against this curve. The `/ 0.6` exposure
 * scale is three's, kept so `renderer.toneMappingExposure` keeps meaning what
 * the art bible's time-of-day table says it means.
 */
export const GLSL_ACES = /* glsl */ `
const mat3 ACES_INPUT = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);
const mat3 ACES_OUTPUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);
vec3 rrtAndOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFilmic(vec3 color) {
  color = ACES_INPUT * (color / 0.6);
  color = rrtAndOdtFit(color);
  color = ACES_OUTPUT * color;
  return clamp(color, 0.0, 1.0);
}
`;

/**
 * Colour-cube lookup from a horizontally tiled strip (N slices of NxN).
 *
 * A `Data3DTexture` would be the obvious storage, but `sampler3D` forces the
 * whole material onto the GLSL 3.00 code path in three, and a strip gets the
 * identical result with hardware bilinear inside each slice plus one manual
 * lerp across slices. Every tap is inset by half a texel so bilinear filtering
 * can never bleed across a slice boundary.
 */
export const GLSL_LUT = /* glsl */ `
vec3 sampleLutStrip(sampler2D lut, vec3 c, float n) {
  c = clamp(c, 0.0, 1.0);
  float sliceW = 1.0 / n;              // width of one slice in strip UV
  float texelW = sliceW / n;           // width of one texel in strip UV
  float zPos = c.b * (n - 1.0);
  float z0 = floor(zPos);
  float z1 = min(z0 + 1.0, n - 1.0);
  float zf = zPos - z0;
  float xIn = (0.5 + c.r * (n - 1.0)) * texelW;
  float y = (0.5 + c.g * (n - 1.0)) / n;
  vec3 a = texture2D(lut, vec2(z0 * sliceW + xIn, y)).rgb;
  vec3 b = texture2D(lut, vec2(z1 * sliceW + xIn, y)).rgb;
  return mix(a, b, zf);
}
`;
