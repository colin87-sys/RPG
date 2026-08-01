/**
 * skyFragment.js — uniform block, quality defines, and the composite `main()`.
 *
 * Composition order is physical, back to front:
 *   atmosphere in-scatter  ->  art calibration tint
 *   stars + milky way      (behind everything, extinguished near the horizon)
 *   moon-ring, moon shard, aurora   (all above the cloud decks)
 *   sun disc + aureole     (attenuated by the view-ray transmittance)
 *   high cirrus deck, then low cumulus deck
 *   ash overlay, then the below-horizon ground fill
 *
 * Getting that order right is what makes the clouds occlude the sun and the
 * stars, and what makes the aurora sit behind a passing deck instead of on top
 * of it.
 */
import { GLSL_MATH, GLSL_NOISE, GLSL_CUBEUV } from './skyCommon.js';
import { GLSL_ATMOSPHERE_CONST, GLSL_ATMOSPHERE } from './skyAtmosphere.js';
import { GLSL_CLOUDS } from './skyClouds.js';
import { GLSL_CELESTIAL } from './skyCelestial.js';

const UNIFORM_BLOCK = /* glsl */ `
varying vec3 vWorldDir;

uniform float uTime;
uniform float uObserverAltitude;   // km above the ground sphere

// --- atmosphere -----------------------------------------------------------
uniform vec3  uSunDir;
uniform vec3  uBetaR;              // Rayleigh scattering, per km
uniform vec3  uBetaM;              // Mie scattering, per km
uniform vec3  uBetaMe;             // Mie extinction (scattering / single-scatter albedo)
uniform vec3  uBetaO;              // ozone absorption, per km
uniform float uMieG;
uniform float uSunIrradiance;
uniform vec3  uMultiScatter;       // second-order surrogate radiance

// --- art calibration ------------------------------------------------------
uniform vec3  uZenithTint;
uniform vec3  uHorizonTint;
uniform float uHorizonSunward;

// --- sun ------------------------------------------------------------------
uniform vec3  uSunTint;
uniform float uSunAngularRadius;
uniform float uSunDiscIntensity;
uniform float uHaloStrength;

// --- clouds ---------------------------------------------------------------
uniform float uCloudCoverage;
uniform float uCloudCoverageHigh;
uniform float uCloudDensity;
uniform float uCloudAbsorb;
uniform float uCloudAltitude;
uniform float uCloudThickness;
uniform float uCloudDetail;
uniform vec3  uCloudTint;
uniform vec3  uCloudLightDir;
uniform vec3  uCloudLightColor;
uniform vec3  uCloudAmbient;
uniform vec3  uCloudUnderlight;
uniform vec2  uWind;
uniform float uLightning;
uniform vec3  uLightningDir;
uniform vec3  uLightningColor;

// --- stars ----------------------------------------------------------------
uniform mat3  uStarRot;
uniform vec3  uGalacticPole;
uniform float uStarDensity;
uniform float uStarCoverage;
uniform float uStarBrightness;
uniform float uStarFade;
uniform float uMilkyWay;

// --- moon and ring --------------------------------------------------------
uniform vec3  uMoonDir;
uniform mat3  uMoonRot;
uniform float uMoonFade;
uniform float uMoonRadius;
uniform float uMoonBump;
uniform vec3  uMoonSunColor;
uniform vec3  uMoonHaloColor;
uniform vec3  uEarthshine;
uniform vec3  uRingAxis;
uniform vec3  uRingColor;
uniform float uRingAlpha;

// --- weather overlays -----------------------------------------------------
uniform float uAurora;
uniform vec3  uAuroraLow;
uniform vec3  uAuroraHigh;
uniform float uAsh;
uniform vec3  uAshTint;
uniform vec3  uAshEmber;
uniform vec3  uGroundColor;
`;

const MAIN = /* glsl */ `
void main() {
  vec3 rd = normalize(vWorldDir);
  vec3 ro = vec3(0.0, AT_RG + uObserverAltitude, 0.0);

  // Below the horizon the scattering integral terminates on the ground after a
  // few kilometres and collapses to near-black, which would draw a hard dark
  // band under the horizon line in any shot where terrain does not fill the
  // lower frame. Lifting the *sampling* direction to just above the horizon and
  // then blending the whole result toward the ground haze colour keeps the
  // transition continuous and matches the scene fog exactly.
  float below = smoothstep(0.0, -0.05, rd.y);
  vec3 srd = normalize(vec3(rd.x, mix(rd.y, 0.0015, below), rd.z));

  vec3 inscatter, transmit;
  atmScatter(ro, srd, uSunDir, 1.0e9, inscatter, transmit);

  // Physical base, artistic transform. The scattering integral owns all of the
  // angular structure — aureole, azimuthal asymmetry, twilight wedge — and the
  // tint only re-keys the overall chroma so the dome lands on the ART_BIBLE
  // zenith/horizon values for this time of day.
  //
  // The horizon key in the bible describes the *sunward* horizon (dusk is only
  // orange on the side the sun is on), so the horizon tint is blended back
  // toward the zenith tint as the view turns away from the sun. That is what
  // leaves the anti-solar horizon as the pink-over-blue Belt of Venus instead
  // of painting the whole skyline sunset-orange. uHorizonSunward collapses that
  // blend once the sun is genuinely down, where there is no azimuthal asymmetry
  // left to preserve.
  vec2 hv = normalize(vec2(srd.x, srd.z) + 1e-6);
  vec2 hs = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-6);
  float sunward = smoothstep(-0.25, 0.80, dot(hv, hs));
  vec3 horizonTint = mix(uZenithTint, uHorizonTint, mix(1.0, sunward, uHorizonSunward));
  // Blending by sqrt(elevation) rather than linearly keeps most of the dome
  // under the zenith key, which is where the eye judges "what colour is the sky".
  vec3 sky = inscatter * mix(horizonTint, uZenithTint, sqrt(clamp(srd.y, 0.0, 1.0)));

  // --- stars, ring, aurora: everything above the weather -------------------
  sky += starField(srd);
  sky += milkyWay(srd);
  sky += moonRing(srd);
  sky += auroraCurtain(ro, srd);

  vec4 moon = moonShard(srd);
  sky = sky * (1.0 - moon.a) + moon.rgb;

  // --- sun disc -----------------------------------------------------------
  float ang = acos(clamp(dot(rd, uSunDir), -1.0, 1.0));
  float r = ang / uSunAngularRadius;
  // Limb darkening, Eddington form I(mu)/I(0) = 1 - u(1 - mu), with per-channel
  // u because the solar photosphere is cooler at the limb: the edge of the disc
  // genuinely goes orange, and reproducing that is most of what separates a sun
  // from a white circle.
  float mu = sqrt(max(0.0, 1.0 - r * r));
  vec3 limb = vec3(1.0) - vec3(0.42, 0.53, 0.67) * (1.0 - mu);
  float aa = max(fwidth(ang) * 1.3, uSunAngularRadius * 0.02);
  float disc = 1.0 - smoothstep(uSunAngularRadius - aa, uSunAngularRadius + aa, ang);
  // Three-lobe aureole: a tight forward-scatter core, a broad Mie skirt, and a
  // very wide low-amplitude wash. The wide lobe is what the bloom pass picks up
  // and turns into the glare the reference frames have around a low sun.
  float halo = exp(-ang / 0.018) * 0.60
             + exp(-ang / 0.085) * 0.22
             + exp(-ang / 0.330) * 0.05;
  vec3 sunRadiance = transmit * uSunTint * uSunDiscIntensity;
  sky += sunRadiance * (limb * disc + vec3(halo * uHaloStrength));

  // --- cloud decks, far first ---------------------------------------------
  // Cirrus is anisotropic in x: ice crystals are sheared out by the jet into
  // long streaks, and a round-billow cirrus reads as low cloud at the wrong
  // altitude.
  vec4 cirrus = cloudDeck(ro, srd, 8.0, 0.5, 3.6,
                          uCloudCoverageHigh, uCloudDensity * 0.55, uCloudDetail * 0.6,
                          SKY_CLOUD_OCTAVES_HIGH, vec2(0.34, 1.0), sky, 140.0);
  sky = mix(sky, cirrus.rgb, cirrus.a);

  vec4 cumulus = cloudDeck(ro, srd, uCloudAltitude, uCloudThickness, 2.4,
                           uCloudCoverage, uCloudDensity, uCloudDetail,
                           SKY_CLOUD_OCTAVES, vec2(1.0), sky, 55.0);
  sky = mix(sky, cumulus.rgb, cumulus.a);

  // --- ash ----------------------------------------------------------------
  if (uAsh > 0.001) {
    sky = mix(sky, sky * uAshTint, uAsh);
    // Distant burn glow banked against the horizon. Modulated by noise so it
    // reads as several fires rather than a uniform ring.
    float bandF = exp(-max(0.0, srd.y) / 0.075);
    // The epsilon keeps atan defined looking straight up, where bandF is zero
    // anyway but a NaN would still poison the add.
    float variance = 0.45 + 0.55 * fbm2(vec2(atan(srd.z, srd.x + 1e-6) * 2.4, uTime * 0.01), 3);
    sky += uAshEmber * uAsh * bandF * variance;
  }

  // --- ground half-space ---------------------------------------------------
  sky = mix(sky, uGroundColor, below * 0.86);

  gl_FragColor = vec4(max(sky, vec3(0.0)), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Assemble the fragment program for a quality level.
 *
 * Step counts are `#define`d rather than uniforms so the loops unroll and the
 * cost is genuinely paid only at the chosen level. The sky covers every pixel
 * of every outdoor frame, so this is the single most valuable knob in the
 * renderer: `low` is roughly a fifth the ALU of `ultra`.
 */
export const SKY_QUALITY = {
  low:    { view: 8,  light: 2, cloudShadow: 2, cloudOct: 3, cloudOctHigh: 3, aurora: 6 },
  medium: { view: 11, light: 3, cloudShadow: 3, cloudOct: 4, cloudOctHigh: 3, aurora: 9 },
  high:   { view: 14, light: 4, cloudShadow: 4, cloudOct: 5, cloudOctHigh: 4, aurora: 13 },
  ultra:  { view: 20, light: 6, cloudShadow: 6, cloudOct: 6, cloudOctHigh: 5, aurora: 18 },
};

export function buildSkyFragment(level = 'high') {
  const q = SKY_QUALITY[level] ?? SKY_QUALITY.high;
  const defines = [
    `#define SKY_VIEW_STEPS ${q.view}`,
    `#define SKY_LIGHT_STEPS ${q.light}`,
    `#define SKY_CLOUD_SHADOW_STEPS ${q.cloudShadow}`,
    `#define SKY_CLOUD_OCTAVES ${q.cloudOct}`,
    `#define SKY_CLOUD_OCTAVES_HIGH ${q.cloudOctHigh}`,
    `#define SKY_AURORA_STEPS ${q.aurora}`,
  ].join('\n');

  return [
    defines,
    UNIFORM_BLOCK,
    GLSL_ATMOSPHERE_CONST,
    GLSL_MATH,
    GLSL_NOISE,
    GLSL_CUBEUV,
    GLSL_ATMOSPHERE,
    GLSL_CLOUDS,
    GLSL_CELESTIAL,
    MAIN,
  ].join('\n');
}
