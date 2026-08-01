/**
 * skyClouds.js — two lit, domain-warped cloud decks.
 *
 * The reference frames never show a bare sky, so the cloud system is not an
 * optional garnish: `clear` weather still carries ~42% coverage and the decks
 * stay legible at night. A full volumetric raymarch would buy detail the game
 * cannot afford at 60 Hz behind a battle scene, so this is layered fBm — but
 * lit properly rather than pasted on:
 *
 *  - Each deck is a spherical shell, not a plane. A flat plane stretches to
 *    infinity at the horizon and smears; the shell compresses correctly and
 *    genuinely ends at a ~150 km horizon, which is most of what sells scale.
 *  - Two levels of domain warping turn fBm's uniform "cottage cheese" into
 *    sheared billows with curled edges, and animating the warp (rather than
 *    scrolling the field) makes the clouds *evolve* instead of slide.
 *  - Sunward transmittance is marched inside the slab, so the sun-facing
 *    edge gets a real silver lining from the Mie forward lobe and the
 *    underside genuinely darkens.
 *  - The light colour handed in is the transmitted sun colour, which is
 *    already red at sunset — that is what puts the sunset on the undersides
 *    without a special case.
 */

export const GLSL_CLOUDS = /* glsl */ `
/**
 * Low-frequency warp vector. Sampled once per pixel per deck and reused by the
 * sunward shadow taps: those taps sit a few hundred metres away, far inside one
 * wavelength of the warp field, so re-evaluating it there costs four times the
 * noise for a difference nobody can see.
 */
vec2 cloudWarp(vec2 uv, float t) {
  vec2 w1 = vec2(
    fbm2(uv * 0.55 + vec2(t * 0.013, 0.0), 3),
    fbm2(uv * 0.55 + vec2(5.71, -t * 0.011), 3)) - 0.5;
  vec2 w2 = vec2(
    fbm2(uv * 1.30 + w1 * 2.2, 3),
    fbm2(uv * 1.30 + w1 * 2.2 + 9.23, 3)) - 0.5;
  return w1 * 1.5 + w2 * 1.9;
}

/**
 * Coverage-remapped density. The remap subtracts the coverage threshold and
 * rescales rather than simply multiplying: multiplying fades the entire field
 * toward transparent (a haze), whereas subtract-and-rescale dissolves the field
 * from the edges inward, which is how a clearing sky actually behaves.
 */
float cloudField(vec2 uv, vec2 warp, float coverage, float detailAmt, int oct) {
  float base = fbm2(uv + warp, oct);
  float d = clamp((base - (1.0 - coverage)) / max(0.06, coverage), 0.0, 1.0);
  if (detailAmt > 0.0) {
    // Erosion by a higher octave, weighted toward the boundary. Cores stay
    // solid, edges shred into wisps — the single cheapest cue that a cloud is
    // made of droplets and not of geometry.
    float detail = fbm2(uv * 4.7 + warp * 2.0, 3);
    d = clamp(d - detail * detailAmt * (1.0 - d) * 1.4, 0.0, 1.0);
  }
  return d;
}

/**
 * Shade one deck.
 *
 * alt is the shell altitude in km, thick the slab thickness used for optical
 * depth, scale the horizontal size of one noise unit in km. Returns rgb in the
 * same linear units as the atmosphere, with coverage in the alpha channel.
 */
vec4 cloudDeck(vec3 ro, vec3 rd, float alt, float thick, float scale,
               float coverage, float densityMul, float detailAmt, int oct,
               vec2 aniso, vec3 skyBehind, float hazeDistance) {
  if (coverage <= 0.001) return vec4(0.0);

  float t = raySphere(ro, rd, AT_RG + alt).y;
  if (t <= 0.0) return vec4(0.0);

  vec3 p = ro + rd * t;
  vec2 uv = (p.xz / scale) * aniso + uWind * uTime;

  vec2 warp = cloudWarp(uv, uTime);
  float d = cloudField(uv, warp, coverage, detailAmt, oct);
  if (d <= 0.002) return vec4(0.0);

  // Sunward march. The horizontal step is thickness / sin(elevation), clamped
  // so a sun on the horizon does not demand a 100 km step — beyond about 12
  // degrees of elevation the deck is edge-lit anyway and the clamp is what
  // produces the long, low, side-lit look of a sunset deck.
  vec3 L = uCloudLightDir;
  float ly = max(0.20, abs(L.y));
  vec2 sunStep = (L.xz / scale) * (thick / ly) * aniso / float(SKY_CLOUD_SHADOW_STEPS);
  float od = 0.0;
  for (int i = 1; i <= SKY_CLOUD_SHADOW_STEPS; i++) {
    od += cloudField(uv + sunStep * float(i), warp, coverage, 0.0, 3);
  }
  od *= thick / float(SKY_CLOUD_SHADOW_STEPS);

  // Extinction per kilometre of slab. 1.6 /km against a 1.5 km cumulus slab
  // puts a fully-covered core at ~90% opacity while wisps stay translucent,
  // which is the range where the powder term still has something to sculpt.
  float extinction = uCloudAbsorb * densityMul * 1.6;
  float lightT = exp(-od * extinction);

  // Powder / Beer's-law pair. Beer alone makes dense cores read as flat white
  // cut-outs; the powder term re-darkens the interior so billows keep their
  // form, which is exactly the sculptural cloud shape the reference shows.
  float depth = d * thick;
  float beer = exp(-depth * extinction);
  float powder = 1.0 - exp(-depth * extinction * 2.0);

  float mu = dot(rd, L);
  // Cloud droplets are far larger than air molecules: g climbs to ~0.85 and a
  // weak back lobe survives. That forward lobe *is* the silver lining.
  float phase = phaseDual(mu, 0.85, 0.22);

  // 1.1 rather than a physical normalisation on the phase: the forward lobe of
  // HG(0.85) peaks near 5, so this puts a cloud staring into the sun about 15x
  // brighter than one edge-on. Any more and the silver lining stops being a rim
  // and becomes a blown-out hole in the deck.
  vec3 lit = uCloudLightColor * lightT * (0.35 + 1.1 * phase) * (0.30 + 0.70 * powder);

  // Ambient: sky above, ground bounce plus the sunset underlight below. The
  // underlight is what keeps a dusk deck from going to a dead silhouette.
  vec3 amb = mix(uCloudUnderlight, uCloudAmbient, 0.5 + 0.5 * rd.y) * (0.35 + 0.65 * (1.0 - powder));

  vec3 col = (lit + amb) * uCloudTint;

  // Lightning lights the deck from inside, so it is added *before* the alpha
  // and is modulated by density: the bright cell is the thick one.
  if (uLightning > 0.001) {
    float ang = acos(clamp(dot(normalize(rd), uLightningDir), -1.0, 1.0));
    col += uLightningColor * uLightning * exp(-ang * ang * 9.0) * (0.25 + 1.6 * d);
  }

  float alpha = clamp((1.0 - beer) * smoothstep(0.0, 0.06, d), 0.0, 1.0);

  // Aerial perspective. Clouds near the horizon are tens of kilometres away and
  // must wash into the sky behind them or the deck reads as a painted ceiling.
  float haze = 1.0 - exp(-t / hazeDistance);
  col = mix(col, skyBehind, haze * 0.88);
  alpha *= 1.0 - haze * 0.55;

  return vec4(col, alpha);
}
`;
