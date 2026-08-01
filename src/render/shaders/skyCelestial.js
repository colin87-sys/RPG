/**
 * skyCelestial.js — everything in the sky that is not air or cloud: the star
 * field, the milky-way band, the shattered moon-ring, the largest surviving
 * shard (rendered as a cratered moon with a physically correct phase), and the
 * aurora curtain.
 *
 * WORLD_BIBLE.md is explicit that Erevane's moon shattered and now hangs as a
 * ring of shards, and ART_BIBLE.md gives that ring an alpha per time-of-day and
 * makes it the night key light. The brief also asks for a cratered moon with a
 * correct phase. Both are rendered, and they are the same object: the ring is
 * the debris field, and the "moon" is Lunareth's largest intact shard riding on
 * it. That is the reading that satisfies the art bible, the world bible and the
 * brief simultaneously, and it is the most distinctive thing in the sky.
 */

export const GLSL_CELESTIAL = /* glsl */ `
/* ---------------------------------------------------------------- stars -- */

/**
 * Blackbody-ish stellar tint. Real naked-eye stars run from ~3000 K (Betelgeuse,
 * orange) to ~12000 K (Rigel, blue-white), with the bulk clustered white; the
 * curve below is weighted so extremes stay rare, because a sky of evenly mixed
 * red and blue stars looks like confetti.
 */
vec3 starTint(float k) {
  vec3 cool = vec3(1.00, 0.71, 0.45);
  vec3 mid  = vec3(1.00, 0.96, 0.92);
  vec3 hot  = vec3(0.70, 0.81, 1.00);
  return k < 0.5 ? mix(cool, mid, smoothstep(0.0, 0.5, k))
                 : mix(mid, hot, smoothstep(0.5, 1.0, k));
}

vec3 starField(vec3 dir) {
  if (uStarFade <= 0.002) return vec3(0.0);

  vec3 d = uStarRot * dir;
  float face;
  vec2 uv = dirToCubeUV(d, face);
  vec2 g = uv * uStarDensity;
  vec2 cell = floor(g);
  vec2 f = fract(g);

  vec3 hs = hash33(vec3(cell, face * 37.0));
  if (hs.z > uStarCoverage) return vec3(0.0);

  // Confined to the middle 60% of the cell so a star's glow never clips at a
  // cell boundary — which is what lets us get away with a single-cell lookup
  // instead of a nine-tap neighbourhood.
  vec2 pos = vec2(0.2) + 0.6 * hs.xy;
  vec2 dp = f - pos;

  // Magnitude distribution. Star counts grow by roughly 4x per magnitude step,
  // so pushing a uniform hash through a high power reproduces the real
  // impression: a handful that dominate, a dust of the rest.
  float mag = pow(hash11(hs.z * 91.7 + face * 13.0), 6.0);

  // Screen-space footprint. Sub-pixel points alias violently as the camera
  // drifts, so the core is never allowed smaller than about a pixel and a half.
  // The upper clamp matters just as much: pos is confined to the middle 60%
  // of the cell, so a glow wider than ~0.14 cell units would be visibly clipped
  // square at the cell boundary when the sky is minified.
  float px = clamp(length(fwidth(g)), 0.02, 0.16);
  float radius = clamp(max(0.045 + 0.06 * mag, px * 0.75), 0.045, 0.14);

  float dsq = dot(dp, dp);
  float core = exp(-dsq / (radius * radius));

  // Diffraction spikes on the brightest few only — long in x, thin in y and
  // vice versa. Purely a lens conceit, but it is what makes a bright star read
  // as bright rather than just large.
  float spikes = mag * mag * 0.30 * (
      exp(-abs(dp.y) * 90.0 - abs(dp.x) * 9.0) +
      exp(-abs(dp.x) * 90.0 - abs(dp.y) * 9.0));

  // Scintillation is an atmospheric effect: strong through the thick air near
  // the horizon, almost absent at the zenith.
  float horizonAir = 1.0 - smoothstep(0.05, 0.55, dir.y);
  float twinkle = 1.0 + 0.5 * horizonAir * sin(uTime * (1.7 + hs.x * 4.0) + hs.y * 47.0);

  // Extinction: the bible fades stars in above horizon +15 degrees (sin ~ 0.26).
  float rise = smoothstep(0.015, 0.26, dir.y);

  float b = (core + spikes) * mag * uStarBrightness * twinkle * rise * uStarFade;
  return starTint(hs.x * 0.6 + hs.y * 0.4) * b;
}

/**
 * Milky way. A gaussian band around a fixed galactic plane, filled with fBm and
 * cut by dark dust lanes. The lanes matter: an unbroken glowing stripe reads as
 * a lens smudge, and the rifts are what make it read as a galaxy.
 */
vec3 milkyWay(vec3 dir) {
  if (uMilkyWay <= 0.002) return vec3(0.0);
  vec3 d = uStarRot * dir;
  float b = dot(d, uGalacticPole);
  float band = exp(-b * b * 34.0);
  if (band < 0.0025) return vec3(0.0);

  float glowN = fbm3(d * 6.5, 5);
  float rift = fbm3(d * 2.7 + 21.7, 4);
  float dust = smoothstep(0.34, 0.62, rift);

  // A faint granular field on top so the band does not look like airbrush.
  float grain = fbm3(d * 46.0, 2);

  float amount = band * (0.30 + 0.85 * glowN) * dust * (0.75 + 0.5 * grain);
  float rise = smoothstep(0.0, 0.28, dir.y);
  vec3 tint = mix(vec3(0.72, 0.80, 1.00), vec3(1.00, 0.93, 0.82), glowN);
  return tint * amount * uMilkyWay * uStarFade * rise;
}

/* -------------------------------------------------------- lunar surface -- */

/**
 * One scale of impact craters.
 *
 * Deliberately a *sum* over the 3x3x3 cell neighbourhood rather than a Worley
 * nearest-feature lookup. A Worley crater field is discontinuous wherever two
 * neighbouring cells disagree about radius or about hosting a crater at all,
 * and once that height field is differentiated into a bump normal the
 * discontinuity shows up as hard facet edges cutting across the terminator —
 * exactly where the eye is looking. Summing profiles that are already zero at
 * the edge of their own support is continuous by construction, and it produces
 * overlapping craters, which is what real regolith looks like.
 *
 * Profile: a bowl plus a raised rim. The rim is the important half — it is what
 * makes a crater field read correctly at the terminator, where rims catch the
 * light while the floors are still dark.
 */
float craterLayer(vec3 pos, float freq) {
  vec3 p = pos * freq;
  vec3 base = floor(p);
  vec3 f = p - base;
  float h = 0.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 o = vec3(float(x), float(y), float(z));
        vec3 cell = base + o;
        vec3 rnd = hash33(cell);
        if (rnd.z > 0.62) continue;              // most cells stay empty
        vec3 jit = hash33(cell + 11.73);
        float r = length(o + jit - f) / (0.30 + 0.55 * rnd.x);
        if (r > 1.4) continue;
        float bowl = -0.55 * (1.0 - smoothstep(0.0, 1.0, r));
        float e = (r - 0.92) / 0.20;
        h += (bowl + 0.42 * exp(-e * e)) * (0.55 + 0.45 * rnd.y);
      }
    }
  }
  return h;
}

/** Height field on the lunar sphere, sampled in the shard's own frame. */
float moonHeight(vec3 worldNormal) {
  vec3 n = uMoonRot * worldNormal;
  return craterLayer(n, 5.0)
       + craterLayer(n, 12.0) * 0.45
       + (fbm3(n * 3.0, 3) - 0.5) * 0.22;
}

/**
 * The shard. Returns premultiplied radiance in rgb and coverage in a, so the
 * caller composites with a single mix.
 */
vec4 moonShard(vec3 rd) {
  if (uMoonFade <= 0.002) return vec4(0.0);

  float cosA = dot(rd, uMoonDir);
  float ang = acos(clamp(cosA, -1.0, 1.0));

  // Wide halo first — it exists outside the disc and is what the bloom pass
  // has to bite on.
  float haloFall = max(0.0, ang - uMoonRadius) / (uMoonRadius * 2.4);
  vec3 halo = uMoonHaloColor * exp(-haloFall * haloFall * 2.2) * uMoonFade;

  if (ang > uMoonRadius * 1.35) return vec4(halo, 0.0);

  float s = clamp(ang / uMoonRadius, 0.0, 1.0);
  // Radial direction across the disc; degenerate exactly at the centre, where
  // the tangent contribution is zero anyway.
  vec3 tangent = rd - uMoonDir * cosA;
  float tl = length(tangent);
  tangent = tl > 1e-5 ? tangent / tl : vec3(0.0);

  // Outward surface normal of the near hemisphere: -M at the disc centre
  // (facing the observer), perpendicular to M at the limb.
  vec3 n = normalize(-uMoonDir * sqrt(max(0.0, 1.0 - s * s)) + tangent * s);

  // Bump normal by central differences of the height field in world tangents.
  vec3 up = abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(n, up));
  vec3 t2 = cross(n, t1);
  float eps = 0.013;
  float h0 = moonHeight(n);
  float hx = moonHeight(normalize(n + t1 * eps));
  float hy = moonHeight(normalize(n + t2 * eps));
  vec3 nb = normalize(n - (t1 * (hx - h0) + t2 * (hy - h0)) * (uMoonBump / eps));

  // Maria: basaltic plains are about half the albedo of the highlands. 0.13 and
  // 0.06 are the real lunar figures, and keeping them honest is why the moon
  // sits just under the bloom threshold instead of being a white sticker.
  float maria = smoothstep(0.42, 0.62, fbm3(uMoonRot * n * 1.9 + 4.3, 4));
  float albedo = mix(0.132, 0.062, maria) * max(0.15, 1.0 + 0.35 * h0);

  // Lommel-Seeliger. Regolith backscatters hard, so the moon shows almost no
  // limb darkening — a Lambert disc looks like a billiard ball and gives the
  // phase away as fake. mu0/(mu0+mu) is the classic cheap fix and is correct.
  float mu0 = max(0.0, dot(nb, uSunDir));
  float muv = max(0.0, dot(nb, -rd));
  float lam = mu0 / max(0.06, mu0 + muv);
  lam *= smoothstep(-0.04, 0.09, dot(nb, uSunDir));   // soften bumpy terminator

  // Ringshine: in Erevane the dark limb is lit by the debris ring, not by a
  // blue planet — so the unlit crescent glows faintly teal.
  vec3 surface = uMoonSunColor * lam * albedo * 16.0
               + uEarthshine * albedo * (1.0 - smoothstep(0.0, 0.30, mu0));

  float aa = max(fwidth(ang) * 1.3, uMoonRadius * 0.008);
  float disc = 1.0 - smoothstep(uMoonRadius - aa, uMoonRadius + aa, ang);

  // The halo only applies outside the disc; adding it under an opaque surface
  // would quietly lift the shard's dark limb and wreck the phase.
  return vec4(surface * disc * uMoonFade + halo * (1.0 - disc), disc * uMoonFade);
}

/* --------------------------------------------------------- the ring ------ */

/**
 * The shattered moon seen edge-on from inside its own orbit: a narrow band on a
 * great circle. Brightness along the band is clumped by fBm (the debris is not
 * uniform) with a high-frequency glint term for individual shards catching the
 * sun, and it is notched where the planet's own shadow crosses it opposite the
 * sun — a detail that costs three instructions and instantly reads as "this is
 * a real orbiting object", not a painted arc.
 */
vec3 moonRing(vec3 rd) {
  if (uRingAlpha <= 0.002) return vec3(0.0);
  float s = dot(rd, uRingAxis);
  float core = exp(-s * s / (2.0 * 0.024 * 0.024));
  float halo = exp(-s * s / (2.0 * 0.105 * 0.105)) * 0.26;
  if (core + halo < 0.002) return vec3(0.0);

  vec3 along = rd - uRingAxis * s;
  float al = length(along);
  if (al < 1e-4) return vec3(0.0);
  along /= al;

  float clump = fbm3(along * 3.4 + 17.3, 4);
  float glint = fbm3(along * 84.0, 2);
  glint = glint * glint * glint;

  float anti = acos(clamp(dot(along, -uSunDir), -1.0, 1.0));
  float notch = 1.0 - 0.80 * exp(-anti * anti / (2.0 * 0.10 * 0.10));

  // Shards on the sunward side of the ring are in forward scatter and flare.
  float fwd = smoothstep(0.55, 1.0, dot(along, uSunDir));
  vec3 tint = mix(uRingColor, uMoonSunColor, fwd * 0.55);

  float rise = smoothstep(-0.12, 0.06, rd.y);   // the ring dips below the horizon
  float amount = (core * (0.45 + 1.0 * clump) + core * glint * 2.2 + halo) * notch * rise;
  return tint * amount * uRingAlpha;
}

/* ----------------------------------------------------------- aurora ------ */

/**
 * A genuine volumetric curtain: the shell between 90 km and 260 km is marched
 * and emission accumulated. The shape comes from an abs()-folded fBm, which
 * produces the sharp creases a curtain has where it folds back on itself, and
 * the fold pattern is itself domain-warped in time so the curtain *travels*
 * along its length rather than boiling in place.
 *
 * Altitude drives colour the way it does in reality: atomic-oxygen green low
 * down, nitrogen crimson-violet at the top, with the sharp lower edge that
 * makes an aurora look like fabric.
 */
vec3 auroraCurtain(vec3 ro, vec3 rd) {
  if (uAurora <= 0.002 || rd.y < 0.015) return vec3(0.0);

  // 90 km and 260 km, in the dome's kilometre units.
  float t0 = raySphere(ro, rd, AT_RG + 90.0).y;
  float t1 = raySphere(ro, rd, AT_RG + 260.0).y;
  if (t1 <= t0) return vec3(0.0);

  vec3 acc = vec3(0.0);
  float dt = (t1 - t0) / float(SKY_AURORA_STEPS);
  for (int i = 0; i < SKY_AURORA_STEPS; i++) {
    vec3 p = ro + rd * (t0 + dt * (float(i) + 0.5));
    float h = clamp((length(p) - AT_RG - 90.0) / 170.0, 0.0, 1.0);
    // One curtain "wavelength" is ~110 km across, which is the scale real
    // auroral arcs fold at.
    vec2 q = p.xz / 110.0;

    vec2 w = vec2(fbm2(q * 0.75 + vec2(uTime * 0.011, 0.0), 3),
                  fbm2(q * 0.75 + vec2(3.7, -uTime * 0.008), 3)) - 0.5;
    float fold = abs(fbm2(q * 1.5 + w * 1.6, 4) * 2.0 - 1.0);
    float curtain = 1.0 - clamp(fold * 3.4, 0.0, 1.0);
    curtain *= curtain;

    // Vertical rays: field-aligned striations, tighter than the fold pattern.
    float rays = 0.5 + 0.5 * vnoise2(vec2(q.x * 26.0 + uTime * 0.04, q.y * 26.0));

    // Sharp bottom edge, long soft top — the signature aurora falloff.
    float profile = smoothstep(0.0, 0.10, h) * (1.0 - smoothstep(0.30, 1.0, h));

    vec3 col = mix(uAuroraLow, uAuroraHigh, smoothstep(0.10, 0.70, h));
    acc += col * curtain * rays * profile;
  }

  // Curtains are optically thin, so this is pure emission — no extinction term.
  // Fade at the horizon where the shell would otherwise integrate to a bright
  // wall hundreds of kilometres deep.
  // dt is in km, so the emission coefficient is per-km; 0.024 puts a strong
  // overhead curtain around 0.6 pre-tonemap, bright enough to read against the
  // night sky and to feed bloom without becoming the whole frame.
  float horizonFade = smoothstep(0.015, 0.20, rd.y);
  return acc * (dt * 0.024) * uAurora * horizonFade;
}
`;
