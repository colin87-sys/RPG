/**
 * skyAtmosphere.js — analytic single-scattering atmosphere, plus the dome's
 * vertex program.
 *
 * The model is the standard Nishita/Bruneton formulation evaluated per pixel:
 * two exponential density profiles (Rayleigh for molecules, Mie for aerosol)
 * plus a tent-shaped ozone layer that absorbs but does not scatter. Radiance is
 * integrated along the view ray with a nested light-ray integral for the sun's
 * transmittance to each sample.
 *
 * Why not Preetham/Hosek (an analytic fit, and far cheaper)? Because those fits
 * are only defined for a sun above the horizon. Half the frames this game cares
 * about — dusk at t=0.72, the whole night cycle, aurora weather — live at or
 * below sun elevation 0, where Preetham produces garbage and the art bible asks
 * for a specific twilight. Integrating for real costs a few dozen exp() per
 * pixel and gets the earth's shadow, the ozone-blue twilight band and the
 * Belt of Venus for free.
 *
 * Three things are deliberately non-textbook:
 *  1. Ozone is included. It contributes nothing at noon and is the entire
 *     reason twilight resolves blue instead of a muddy brown.
 *  2. The planet shadow on the light ray is soft, not a binary hit test. A
 *     binary test bands hard across the terminator at exactly the moment the
 *     player is most likely to be looking at the sky.
 *  3. A cheap second-order scattering surrogate is added. Single scattering
 *     alone leaves the twilight zenith and the inside of an overcast deck
 *     several stops too dark; the real sky gets roughly a third of its
 *     luminance from higher orders.
 */

/**
 * Planetary constants, mirrored exactly by `skyModel.js` on the CPU side.
 *
 * Units are KILOMETRES throughout the sky, and that is not cosmetic. In metres
 * the planet radius is 6.36e6, so `dot(p, p)` lands near 4e13 where a 24-bit
 * float mantissa has an ulp of 2.4e6 — the ray/sphere quadratic then cancels
 * catastrophically and the horizon breaks into rings on any GPU without native
 * fp64. In kilometres the same quantity is 4e7 with an ulp of about 2.4, which
 * costs roughly a metre of accuracy on the horizon distance. Scattering
 * coefficients are therefore per-kilometre (1000x the usual per-metre values).
 */
export const GLSL_ATMOSPHERE_CONST = /* glsl */ `
const float AT_RG = 6360.0;      // ground radius, km
const float AT_RA = 6420.0;      // top of atmosphere, km (60 km thick)
const float AT_HR = 8.0;         // Rayleigh scale height, km
const float AT_HM = 1.2;         // Mie scale height, km
const float AT_OZ_CENTRE = 25.0; // ozone layer centre, km
const float AT_OZ_WIDTH  = 15.0; // ozone tent half-width, km
`;

export const GLSL_ATMOSPHERE = /* glsl */ `
/**
 * Densities at altitude h, relative to sea level.
 *  x — Rayleigh, y — Mie, z — ozone (a tent, not an exponential: ozone is a
 *  layer, and modelling it as exp() puts it in the wrong place entirely).
 */
vec3 atmDensity(float h) {
  return vec3(
    exp(-h / AT_HR),
    exp(-h / AT_HM),
    max(0.0, 1.0 - abs(h - AT_OZ_CENTRE) / AT_OZ_WIDTH));
}

/**
 * Soft planet shadow for a light ray leaving p toward the sun.
 *
 * If the ray's closest approach to the planet centre falls inside the ground
 * sphere the sample is in the earth's shadow. Feathering that test over ~12 km
 * of closest-approach radius approximates the real penumbra (the sun is not a
 * point) and, more importantly, keeps the terminator continuous instead of a
 * stair-stepped edge crawling across the dusk sky.
 */
float atmGroundShadow(vec3 p, vec3 sunDir) {
  float b = dot(p, sunDir);
  if (b >= 0.0) return 1.0;                    // ray climbs away from the planet
  float perp = sqrt(max(0.0, dot(p, p) - b * b));
  return smoothstep(AT_RG - 3.0, AT_RG + 9.0, perp);
}

/** Optical depth (Rayleigh, Mie, ozone) from p to the top of the atmosphere. */
vec3 atmSunOpticalDepth(vec3 p, vec3 sunDir) {
  float tEnd = raySphere(p, sunDir, AT_RA).y;
  if (tEnd <= 0.0) return vec3(1e6);
  vec3 od = vec3(0.0);
  float dt = tEnd / float(SKY_LIGHT_STEPS);
  for (int i = 0; i < SKY_LIGHT_STEPS; i++) {
    vec3 q = p + sunDir * (dt * (float(i) + 0.5));
    od += atmDensity(max(0.0, length(q) - AT_RG));
  }
  return od * dt;
}

/** Extinction for a given optical-depth triple. */
vec3 atmExtinction(vec3 od) {
  return exp(-(uBetaR * od.x + uBetaMe * od.y + uBetaO * od.z));
}

/**
 * Integrate in-scattered radiance along the view ray and return the view
 * transmittance alongside it (the caller needs it to redden the sun disc).
 *
 * Sample placement is quadratic in the ray parameter rather than uniform.
 * A zenith ray exits the atmosphere in 60 km with almost all of its mass in
 * the first 16; a horizon ray runs 600 km and, because altitude grows as
 * t^2/2R along a level ray, has its mass spread over the first ~150. t = tMax*x^2
 * happens to fit both cases with the same sample count, which is why the
 * horizon is not a noisy mess at 14 steps.
 */
void atmScatter(vec3 ro, vec3 rd, vec3 sunDir, float tClamp,
                out vec3 inscatter, out vec3 transmittance) {
  vec2 hitA = raySphere(ro, rd, AT_RA);
  float tMax = hitA.y;
  vec2 hitG = raySphere(ro, rd, AT_RG);
  if (hitG.x > 0.0) tMax = min(tMax, hitG.x);   // do not integrate through rock
  tMax = min(tMax, tClamp);

  if (tMax <= 0.0) {
    inscatter = vec3(0.0);
    transmittance = vec3(1.0);
    return;
  }

  float mu = dot(rd, sunDir);
  float pr = phaseRayleigh(mu);
  float pm = phaseHG(mu, uMieG);

  vec3 odView = vec3(0.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  vec3 sumMs = vec3(0.0);

  float prevX = 0.0;
  for (int i = 0; i < SKY_VIEW_STEPS; i++) {
    float x1 = float(i + 1) / float(SKY_VIEW_STEPS);
    float t0 = tMax * prevX * prevX;
    float t1 = tMax * x1 * x1;
    float dt = t1 - t0;
    vec3 p = ro + rd * (0.5 * (t0 + t1));
    float h = max(0.0, length(p) - AT_RG);
    vec3 d = atmDensity(h) * dt;

    // Half-segment before and after the sample keeps the trapezoidal error
    // symmetric; accumulating the whole segment first darkens the sky by a
    // visible amount at low step counts.
    odView += d * 0.5;
    vec3 trView = atmExtinction(odView);
    odView += d * 0.5;

    vec3 trLight = atmExtinction(atmSunOpticalDepth(p, sunDir))
                 * atmGroundShadow(p, sunDir);
    vec3 tr = trView * trLight;

    sumR += d.x * tr;
    sumM += d.y * tr;

    // Second-order surrogate: isotropic, unshadowed, weighted by how much of
    // the sky dome is still lit. Continuous through sunset, unlike the direct
    // term, which is what stops the twilight sky from falling off a cliff.
    sumMs += d.x * trView;

    prevX = x1;
  }

  transmittance = atmExtinction(odView);
  inscatter = (uBetaR * sumR * pr + uBetaM * sumM * pm) * uSunIrradiance
            + uBetaR * sumMs * uMultiScatter;
}
`;

/**
 * Vertex program.
 *
 * The dome is a unit box that rides on the camera, and `gl_Position.xyww`
 * pins every fragment to NDC depth 1.0. That combination is what makes the
 * "large renderOrder, never z-fights" requirement structurally true rather
 * than a tuning exercise: the sky is literally at the far plane, so no scene
 * geometry can ever be behind it, and no choice of camera.far can clip it.
 */
export const SKY_VERT = /* glsl */ `
varying vec3 vWorldDir;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldDir = world.xyz - cameraPosition;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = clip.xyww;
}
`;
