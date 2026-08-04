/**
 * skyModel.js — the CPU mirror of the dome's scattering integral.
 *
 * This exists for one reason: `Lighting.js` drives the key light from
 * `sky.sunColor`, and the scene fog has to be the colour of the horizon the
 * dome is actually painting. Reading pixels back from the GPU to find that out
 * would stall the pipeline every frame, so the same integral is evaluated here
 * at a handful of directions instead — a few hundred `exp()` calls, once per
 * `setTimeOfDay` plus one horizon probe per frame.
 *
 * It is a deliberate duplication of `skyAtmosphere.js`. The two must stay in
 * step; the constants below and the ones in `GLSL_ATMOSPHERE_CONST` are the
 * same numbers in the same units (kilometres), and the integration scheme —
 * quadratic sample placement, half-segment optical depth, soft ground shadow,
 * isotropic second-order surrogate — is line-for-line the same. If you change
 * one, change the other, or the light rig will start lying about the sky.
 */

/** Kilometre-scale planetary constants. See skyAtmosphere.js for why km. */
export const ATMO = {
  RG: 6360.0,
  RA: 6420.0,
  HR: 8.0,
  HM: 1.2,
  OZ_CENTRE: 25.0,
  OZ_WIDTH: 15.0,
  /**
   * Bruneton's coefficients, converted to per-kilometre. The blue channel is
   * noticeably stronger than the older Nishita numbers, which is what gives a
   * deep zenith and a genuinely red sunset rather than a pink one.
   */
  BETA_R: [5.802e-3, 13.558e-3, 33.1e-3],
  /** Mie is grey by definition — aerosols are large compared to wavelength. */
  BETA_M: 3.996e-3,
  /** Single-scattering albedo of atmospheric aerosol is ~0.9, so extinction > scattering. */
  MIE_ALBEDO: 0.9,
  /** Ozone absorbs but never scatters; it is what keeps twilight blue. */
  BETA_O: [0.650e-3, 1.881e-3, 0.085e-3],
};

const INV_4PI = 0.07957747154594;
const THREE_16PI = 0.05968310365946;

function phaseRayleigh(mu) {
  return THREE_16PI * (1.0 + mu * mu);
}

function phaseHG(mu, g) {
  const g2 = g * g;
  const d = 1.0 + g2 - 2.0 * g * mu;
  return (INV_4PI * (1.0 - g2)) / (d * Math.sqrt(Math.max(1e-4, d)));
}

/** Far root of the ray/sphere intersection, or -1 on a miss. */
function raySphereFar(ox, oy, oz, dx, dy, dz, radius) {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b + Math.sqrt(disc);
}

function raySphereNear(ox, oy, oz, dx, dy, dz, radius) {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b - Math.sqrt(disc);
}

/** Rayleigh / Mie / ozone density at altitude h (km), relative to sea level. */
function density(h, out) {
  out[0] = Math.exp(-h / ATMO.HR);
  out[1] = Math.exp(-h / ATMO.HM);
  out[2] = Math.max(0, 1 - Math.abs(h - ATMO.OZ_CENTRE) / ATMO.OZ_WIDTH);
  return out;
}

const _d = [0, 0, 0];
const _odL = [0, 0, 0];

/** Optical-depth triple from p toward the sun, out to the top of atmosphere. */
function sunOpticalDepth(px, py, pz, sx, sy, sz, steps, out) {
  const tEnd = raySphereFar(px, py, pz, sx, sy, sz, ATMO.RA);
  if (tEnd <= 0) {
    out[0] = out[1] = out[2] = 1e6;
    return out;
  }
  const dt = tEnd / steps;
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < steps; i++) {
    const t = dt * (i + 0.5);
    const qx = px + sx * t;
    const qy = py + sy * t;
    const qz = pz + sz * t;
    const h = Math.max(0, Math.hypot(qx, qy, qz) - ATMO.RG);
    density(h, _d);
    a += _d[0];
    b += _d[1];
    c += _d[2];
  }
  out[0] = a * dt;
  out[1] = b * dt;
  out[2] = c * dt;
  return out;
}

/** Soft planet shadow; see `atmGroundShadow` in skyAtmosphere.js. */
function groundShadow(px, py, pz, sx, sy, sz) {
  const b = px * sx + py * sy + pz * sz;
  if (b >= 0) return 1;
  const perp = Math.sqrt(Math.max(0, px * px + py * py + pz * pz - b * b));
  const lo = ATMO.RG - 3.0;
  const hi = ATMO.RG + 9.0;
  const x = Math.min(1, Math.max(0, (perp - lo) / (hi - lo)));
  return x * x * (3 - 2 * x);
}

/**
 * Parameters shared by every evaluation. `Sky` rebuilds this whenever the
 * weather or time of day moves, so the model and the shader always agree on
 * turbidity, anisotropy and the second-order surrogate.
 */
export function makeAtmosphereParams({
  turbidity = 1,
  mieG = 0.76,
  /**
   * Not a physical irradiance — a calibration scale. Solved numerically so the
   * unmodified integral lands within a factor of ~1.4 of every ART_BIBLE
   * zenith and horizon key across the day, which keeps the tints that finish
   * the job close to unity and therefore keeps the sky physical.
   */
  sunIrradiance = 6,
  multiScatter = [0, 0, 0],
  altitude = 0.2,
  viewSteps = 12,
  lightSteps = 4,
} = {}) {
  const betaM = ATMO.BETA_M * turbidity;
  return {
    betaR: ATMO.BETA_R,
    betaM: [betaM, betaM, betaM],
    betaMe: [
      betaM / ATMO.MIE_ALBEDO,
      betaM / ATMO.MIE_ALBEDO,
      betaM / ATMO.MIE_ALBEDO,
    ],
    betaO: ATMO.BETA_O,
    mieG,
    sunIrradiance,
    multiScatter,
    altitude,
    viewSteps,
    lightSteps,
  };
}

/** exp(-(betaR*od.r + betaMe*od.m + betaO*od.o)) into `out`. */
export function extinction(od, p, out) {
  for (let i = 0; i < 3; i++) {
    out[i] = Math.exp(-(p.betaR[i] * od[0] + p.betaMe[i] * od[1] + p.betaO[i] * od[2]));
  }
  return out;
}

/**
 * In-scattered radiance along a view ray, mirroring `atmScatter` exactly.
 * `rd` and `sunDir` must be unit length. Writes linear RGB into `out`.
 */
export function skyRadiance(rd, sunDir, p, out) {
  const ox = 0;
  const oy = ATMO.RG + p.altitude;
  const oz = 0;
  const [dx, dy, dz] = rd;
  const [sx, sy, sz] = sunDir;

  let tMax = raySphereFar(ox, oy, oz, dx, dy, dz, ATMO.RA);
  const tGround = raySphereNear(ox, oy, oz, dx, dy, dz, ATMO.RG);
  if (tGround > 0) tMax = Math.min(tMax, tGround);
  if (!(tMax > 0)) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }

  const mu = dx * sx + dy * sy + dz * sz;
  const pr = phaseRayleigh(mu);
  const pm = phaseHG(mu, p.mieG);

  const od = [0, 0, 0];
  const trView = [0, 0, 0];
  const trLight = [0, 0, 0];
  const sumR = [0, 0, 0];
  const sumM = [0, 0, 0];
  const sumMs = [0, 0, 0];

  let prevX = 0;
  for (let i = 0; i < p.viewSteps; i++) {
    const x1 = (i + 1) / p.viewSteps;
    const t0 = tMax * prevX * prevX;
    const t1 = tMax * x1 * x1;
    const dt = t1 - t0;
    const tm = 0.5 * (t0 + t1);
    const qx = ox + dx * tm;
    const qy = oy + dy * tm;
    const qz = oz + dz * tm;
    const h = Math.max(0, Math.hypot(qx, qy, qz) - ATMO.RG);
    density(h, _d);
    const dR = _d[0] * dt;
    const dM = _d[1] * dt;
    const dO = _d[2] * dt;

    od[0] += dR * 0.5;
    od[1] += dM * 0.5;
    od[2] += dO * 0.5;
    extinction(od, p, trView);
    od[0] += dR * 0.5;
    od[1] += dM * 0.5;
    od[2] += dO * 0.5;

    sunOpticalDepth(qx, qy, qz, sx, sy, sz, p.lightSteps, _odL);
    extinction(_odL, p, trLight);
    const shadow = groundShadow(qx, qy, qz, sx, sy, sz);

    for (let c = 0; c < 3; c++) {
      const tr = trView[c] * trLight[c] * shadow;
      sumR[c] += dR * tr;
      sumM[c] += dM * tr;
      sumMs[c] += dR * trView[c];
    }

    prevX = x1;
  }

  for (let c = 0; c < 3; c++) {
    out[c] = (p.betaR[c] * sumR[c] * pr + p.betaM[c] * sumM[c] * pm) * p.sunIrradiance
           + p.betaR[c] * sumMs[c] * p.multiScatter[c];
  }
  return out;
}

/**
 * Transmittance from the observer to space along `sunDir` — i.e. exactly the
 * factor the dome applies to the sun disc. Below the horizon it returns zero,
 * matching the disc's geometric occlusion by the planet.
 */
export function sunTransmittance(sunDir, p, out) {
  const oy = ATMO.RG + p.altitude;
  const [sx, sy, sz] = sunDir;
  if (raySphereNear(0, oy, 0, sx, sy, sz, ATMO.RG) > 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  sunOpticalDepth(0, oy, 0, sx, sy, sz, Math.max(6, p.lightSteps * 2), _odL);
  return extinction(_odL, p, out);
}
