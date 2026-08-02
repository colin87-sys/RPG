/**
 * dofShader.js — thin-lens circle of confusion + half-resolution bokeh gather.
 *
 * three ships `BokehPass`, but it is a single-pass full-resolution gather with
 * a fixed tap count and no near-field handling; at the blur radii this art
 * direction needs (background genuinely soft, characters crisp) it is both slow
 * and prone to sharp foreground silhouettes cutting hard holes in the blur.
 *
 * This is the standard three-stage separated approach:
 *   1. half-res prepass — colour + signed CoC, with the *maximum* |CoC| of the
 *      four contributing texels so near-field blur can expand past the object's
 *      own silhouette instead of being clipped by it.
 *   2. golden-angle spiral gather at half res, each tap accepted in proportion
 *      to whether its own CoC is large enough to physically reach the centre.
 *   3. full-res composite that lerps sharp→blurred by CoC, so anything inside
 *      the depth of field survives at native sharpness.
 *
 * CoC is genuinely thin-lens (focal length derived from the live camera FOV
 * against a 24 mm sensor) rather than a remapped depth ramp, because the
 * reference's "miniature diorama" falloff comes from a *hyperbolic* near/far
 * asymmetry that a linear ramp cannot reproduce. `uBokehScale` then multiplies
 * the physical result: real optics at these subject distances would give barely
 * two pixels of blur, and the look wants ten. The one place the physical model
 * is structurally unable to deliver the look — the saturating far field — is
 * handled by an explicit depth-ratio floor; see the block comment on GLSL_COC.
 */
import { GLSL_POST_COMMON } from './postCommon.js';

/**
 * Shared CoC evaluation — identical maths in the prepass and the composite.
 *
 * ## Why the physical term alone cannot deliver this art direction
 *
 * Thin-lens far-field CoC is hyperbolic in subject distance: as z grows the
 * `(z - s) / z` factor tends to 1 and the whole expression *saturates* at
 * `A·f/(s - f)`. Everything past a few multiples of the focal distance is
 * therefore rendered at one identical, and usually tiny, blur radius. Measured
 * against the shipped battle framing — 50° lens, f/6.3, focal plane at 6.2 m —
 * a pine at 30 m and a pine at 120 m both resolve to about 2.9 px of CoC, i.e.
 * both are effectively sharp, which is exactly the "near and far trees are
 * equally sharp" the art review flagged. The closeup escapes it only because
 * its much longer lens and faster stop move the saturation ceiling up.
 *
 * Scaling the physical term to compensate does not work either, and this is the
 * trap: multiplying CoC by a constant widens the far field and the *depth of
 * field* in equal measure, so buying a soft horizon costs a soft rear rank. The
 * party is staggered across ~5 m in the battle staging and every one of them
 * has to stay crisp.
 *
 * So the far field gets its own operator. REFERENCE_TARGET §3 states the
 * requirement as a relationship rather than as optics — "the background is
 * noticeably soft while characters stay crisp ... a fully-sharp frame is
 * wrong" — and a relationship keyed on *relative* depth expresses it exactly:
 *
 *     floor = uFarFloor · smoothstep over log2(z / s) / uFarOctaves
 *
 * Zero at the focal plane, still under a pixel out to ~1.4× the focal distance
 * (which covers the whole staggered party and the enemy opposite it), and
 * saturating at `uFarFloor` once the background is `2^uFarOctaves` times
 * further away than the subject. Because it is keyed on a *ratio* it needs no
 * per-pose authoring: a 7 m closeup and a 6 m battle stage get the same
 * background separation, which is precisely what the review asked for. Taking
 * the max of it and the physical CoC means a genuinely fast stop still wins
 * where optics would out-blur the floor.
 */
const GLSL_COC = /* glsl */ `
uniform float uNear;
uniform float uFar;
uniform float uFocusDistance;   // metres
uniform float uApertureDiam;    // mm (focal length / f-number)
uniform float uFocalLength;     // mm
uniform float uMmToPixels;      // sensor mm -> screen px, incl. artistic scale
uniform float uMaxCoc;          // px, clamps the gather radius
uniform float uFarFloor;        // px of background defocus guaranteed at depth
uniform float uFarOctaves;      // depth doublings past focus over which it ramps

/** Signed CoC in pixels. Negative = in front of focus (near field). */
float cocPixels(float depth) {
  float zm = -viewZFromDepth(depth, uNear, uFar);   // metres, positive
  float zmm = zm * 1000.0;
  float smm = uFocusDistance * 1000.0;
  float c = uApertureDiam * uFocalLength * (zmm - smm) / max(1e-3, zmm * (smm - uFocalLength));
  float px = c * uMmToPixels;

  // Far-field floor. Applied only behind the focal plane: the near field is
  // already unbounded in z and needs no help, and lifting it would soften a
  // foreground occluder that the composition wants as a hard dark frame.
  if (zm > uFocusDistance) {
    float k = clamp(log2(zm / max(1e-3, uFocusDistance)) / max(0.25, uFarOctaves), 0.0, 1.0);
    px = max(px, uFarFloor * k * k * (3.0 - 2.0 * k));
  }

  return clamp(px, -uMaxCoc, uMaxCoc);
}
`;

/** Half-res colour + CoC prepass. CoC is stored remapped to [0,1] in alpha. */
export const DOF_PREPASS_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uTexel;   // 1 / full-res
varying vec2 vUv;

${GLSL_POST_COMMON}
${GLSL_COC}

void main() {
  vec2 o = uTexel * 0.5;
  vec2 uvs[4];
  uvs[0] = vUv + vec2(-o.x, -o.y);
  uvs[1] = vUv + vec2( o.x, -o.y);
  uvs[2] = vUv + vec2(-o.x,  o.y);
  uvs[3] = vUv + vec2( o.x,  o.y);

  vec3 color = vec3(0.0);
  float coc = 0.0;
  for (int i = 0; i < 4; i++) {
    color += texture2D(tDiffuse, uvs[i]).rgb;
    float c = cocPixels(texture2D(tDepth, uvs[i]).x);
    // Keep the most extreme CoC, sign included: a near-field blur must be
    // allowed to grow outward over a sharp background.
    if (abs(c) > abs(coc)) coc = c;
  }
  color *= 0.25;

  gl_FragColor = vec4(color, coc / uMaxCoc * 0.5 + 0.5);
}
`;

/**
 * Golden-angle spiral gather. The spiral is used instead of a Poisson disc
 * because it needs no uniform array upload and stays uniformly dense for any
 * tap count, which is what lets `setQuality` change DOF_TAPS without retuning.
 */
export const DOF_GATHER_FRAG = /* glsl */ `
uniform sampler2D tHalf;
uniform vec2 uTexel;    // 1 / half-res
uniform float uMaxCoc;  // px, full-res
varying vec2 vUv;

${GLSL_POST_COMMON}

void main() {
  vec4 center = texture2D(tHalf, vUv);
  // Half-res gather, so a full-res CoC of N pixels is N/2 pixels here.
  float centerCoc = (center.a * 2.0 - 1.0) * uMaxCoc;
  float radius = abs(centerCoc) * 0.5;

  if (radius < 0.75) { gl_FragColor = center; return; }

  float rot = ign(gl_FragCoord.xy) * TAU;
  vec3 sum = center.rgb;
  float total = 1.0;

  for (int i = 0; i < DOF_TAPS; i++) {
    float fi = float(i) + 0.5;
    float t = fi / float(DOF_TAPS);
    float rr = sqrt(t) * radius;                 // sqrt keeps the disc uniform
    float ang = fi * GOLDEN_ANGLE + rot;
    vec2 off = vec2(cos(ang), sin(ang)) * rr * uTexel;
    vec4 s = texture2D(tHalf, vUv + off);
    float sc = abs((s.a * 2.0 - 1.0) * uMaxCoc) * 0.5;
    // A tap only contributes if its own circle of confusion is wide enough to
    // physically overlap this pixel. Without this test, sharp foreground
    // objects smear into the blurred background ("colour bleed").
    float w = clamp(sc - rr + 1.0, 0.0, 1.0);
    sum += s.rgb * w;
    total += w;
  }

  gl_FragColor = vec4(sum / total, center.a);
}
`;

/**
 * Full-res composite. The blend ramp starts at 0.75 px so that anything inside
 * the depth of field is bit-exact sharp — characters must never soften, which
 * is the whole reason this pass exists rather than a global blur.
 */
export const DOF_COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform sampler2D tBlur;
varying vec2 vUv;

${GLSL_POST_COMMON}
${GLSL_COC}

void main() {
  vec4 sharp = texture2D(tDiffuse, vUv);
  float coc = cocPixels(texture2D(tDepth, vUv).x);
  vec3 blurred = texture2D(tBlur, vUv).rgb;
  // Near field is allowed to take over faster than far field: a foreground
  // occluder is meant to read as a soft frame, not as a legible object.
  float ramp = coc < 0.0 ? 2.0 : 3.0;
  float blend = smoothstep(0.75, ramp, abs(coc));
  gl_FragColor = vec4(mix(sharp.rgb, blurred, blend), sharp.a);
}
`;
