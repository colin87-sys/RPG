/**
 * Sky lane parameter types and the named variant sets.
 * Colours are palette token references (ColorRef), resolved through
 * src/style/color.ts; no colour literals live in this lane.
 */
import { palette, type PaletteKey, type StageId } from '../../../style/tokens';
import { mix } from '../../../style/color';
import { tvec } from '../../../style/color';
import type * as THREE from 'three';

/** A palette token, or a mix of two tokens [a, b, t] (t = 0 -> a). */
export type ColorRef = PaletteKey | [PaletteKey, PaletteKey, number];

export function resolveColor(c: ColorRef): string {
  if (typeof c === 'string') return palette[c];
  return mix(palette[c[0]], palette[c[1]], c[2]);
}
export function colorVec(c: ColorRef, k = 1): THREE.Vector3 {
  return tvec(resolveColor(c), k);
}
/** Collect the token names a params object references (for manifests). */
export function tokensIn(obj: unknown, out = new Set<string>()): Set<string> {
  if (typeof obj === 'string' && obj in palette) out.add(obj);
  else if (Array.isArray(obj)) obj.forEach((o) => tokensIn(o, out));
  else if (obj && typeof obj === 'object') Object.values(obj).forEach((o) => tokensIn(o, out));
  return out;
}

export interface SkyDomeParams {
  /** elevation (sin) width of the horizon colour band */
  horizonBand: number;
  /** colour just above the horizon band (blends into sky mid) */
  bandColor: ColorRef;
  /** elevation (sin) over which the band colour blends into sky mid */
  bandSpan: number;
  /** multiplier on stage sky.sunSize (angular radius) */
  sunScale: number;
  sunIntensity: number;
  glowInner: ColorRef;
  glowOuter: ColorRef;
  /** angular size (radians) of the outer halo */
  glowSize: number;
  /** horizontal stretch of the halo along the horizon (1 = round) */
  glowStretch: number;
  /** multiplier on stage sky.sunGlow */
  glowStrength: number;
  cirrus: number;
  cirrusColor: ColorRef;
  /** painterly soft posterisation 0..1 */
  banding: number;
  bandSteps: number;
  /** gradient wobble from low-frequency noise */
  wobble: number;
}

export interface CloudFieldParams {
  /** wrap window length along -Z (m) and how far behind the camera it starts */
  depth: number;
  back: number;
  fadeFar: number; // fade-in length at the far end (m)
  fadeNear: number; // puffs closer than this (view depth, m) fade out
  corridorX: number; // clear half-width around x = 0
  corridorY: number; // clear half-height around y = 0
  seaY: number;
  towersPerKm: number;
  banksPerKm: number;
  humpsPerKm: number;
  wispsPerKm: number;
  towerHeight: [number, number];
  towerWidth: [number, number];
  bankLength: [number, number];
  bankHeight: [number, number];
  /** lateral distance of cluster edges beyond the corridor (m) */
  lateral: [number, number];
  /** lateral spread of sea humps (m, each side) */
  humpSpread: number;
  opacity: number;
  lit: ColorRef;
  mid: ColorRef;
  shadow: ColorRef;
  rim: ColorRef;
  /** forward-scatter rim when looking toward the key light (backlit edges) */
  backlit: number;
  rimPower: number;
  /** how much the cluster-level normal overrides the per-puff normal */
  clusterNormal: number;
  /** 0 = soft wrap lighting, 1 = shared toon ramp */
  toon: number;
  /** translucency lift of the half-lambert term (clouds scatter light into their shadow side) */
  lift: number;
  /** headwind (m/s, clouds drift toward +Z) */
  wind: number;
  /** per-wrap lateral re-shuffle (m) so the field does not repeat */
  cycleShift: number;
}

export interface CloudSeaParams {
  y: number;
  size: number; // plane edge (m)
  scale: number; // metres per noise tile
  stretchX: number; // >1 stretches features along X (banded sea)
  bump: number;
  lit: ColorRef;
  mid: ColorRef;
  shadow: ColorRef;
  rim: ColorRef;
  backlit: number;
  drift: number; // m/s of noise advection
  contrast: number;
  /** vertical billow displacement (m, crest to trough) */
  amp: number;
  /** sky bounce into the lit-side shadows (0..1) */
  bounce: number;
  /** 0 = broad swells only, 1 = medium cumulus lumps unioned on top */
  lumps: number;
  /** self-shadow sample spacing (m, squared per step) and strength */
  shadowStep: number;
  shadowAmt: number;
}

export interface CloudBandParams {
  count: number;
  /** wrap = bands approach and recycle; follow = fixed distances that follow the camera */
  mode: 'wrap' | 'follow';
  spacing: number; // m between bands (wrap) or between follow distances
  start: number; // first band distance (follow) / near fade distance (wrap)
  back: number;
  topY: [number, number];
  height: number; // body height below the top (m)
  domeWidth: number; // big dome width (m)
  domeAmp: number;
  detailWidth: number;
  detailAmp: number;
  body: ColorRef;
  lit: ColorRef;
  shadow: ColorRef;
  rim: ColorRef;
  rimWidth: number; // m below the silhouette where the rim glows
  rimStrength: number;
  /** forward-scatter power toward the key light (azimuth focus of the rim) */
  rimFocus: number;
  opacity: number;
  drift: number;
  /** extra silhouette softness with distance */
  soft: number;
  /** bands fade out toward this height (set to the cloud-sea y so they sink into it) */
  floorY: number;
  floorFade: number;
}

export interface SkyVistaParams {
  stage: StageId;
  sky: SkyDomeParams;
  clouds: CloudFieldParams;
  sea: CloudSeaParams;
  bands: CloudBandParams;
}

/** In-scatter toward the sun added on top of the shared fog (one per stage). */
export interface HazeParams {
  color: ColorRef;
  strength: number;
  power: number;
}
export const STAGE_HAZE: Record<StageId, HazeParams> = {
  cloudgate: { color: 'cloudCream', strength: 0.22, power: 6 },
  violetTide: { color: 'sunsetHorizon', strength: 0.22, power: 7 },
  wreckfield: { color: 'planetYellow', strength: 0.1, power: 8 },
};

export type VariantId = 'A' | 'B' | 'C';

// ---------------------------------------------------------------- Cloudgate
const cgSky: SkyDomeParams = {
  horizonBand: 0.07,
  bandColor: ['skyHorizon', 'skyDay', 0.3],
  bandSpan: 0.3,
  sunScale: 1,
  sunIntensity: 1.5,
  glowInner: 'sunCore',
  glowOuter: ['skyHorizon', 'cloudCream', 0.6],
  glowSize: 0.45,
  glowStretch: 1,
  glowStrength: 1,
  cirrus: 0.2,
  cirrusColor: 'cloudCream',
  banding: 0.55,
  bandSteps: 7,
  wobble: 0.025,
};

const cgClouds: CloudFieldParams = {
  depth: 3200,
  back: 160,
  fadeFar: 700,
  fadeNear: 70,
  corridorX: 45,
  corridorY: 25,
  seaY: -48,
  towersPerKm: 7,
  banksPerKm: 8,
  humpsPerKm: 36,
  wispsPerKm: 3,
  towerHeight: [110, 260],
  towerWidth: [110, 200],
  bankLength: [180, 420],
  bankHeight: [35, 80],
  lateral: [10, 650],
  humpSpread: 1400,
  opacity: 1,
  lit: 'cloudCream',
  mid: 'cloudMid',
  shadow: ['cloudShadow', 'skyZenith', 0.2],
  rim: 'sunCore',
  backlit: 0.7,
  rimPower: 3,
  clusterNormal: 0.45,
  toon: 0.45,
  lift: 0.16,
  wind: 3,
  cycleShift: 120,
};

const cgSea: CloudSeaParams = {
  y: -48,
  size: 16000,
  scale: 220,
  stretchX: 1.0,
  bump: 10,
  lit: 'cloudCream',
  mid: ['cloudMid', 'cloudCream', 0.25],
  shadow: ['cloudMid', 'cloudShadow', 0.6],
  rim: 'sunCore',
  backlit: 0.1,
  drift: 1.5,
  contrast: 2.4,
  amp: 40,
  bounce: 0.3,
  lumps: 1,
  shadowStep: 8,
  shadowAmt: 0.5,
};

const cgBands: CloudBandParams = {
  count: 3,
  mode: 'follow',
  spacing: 450,
  start: 1000,
  back: 0,
  topY: [-10, 60],
  height: 150,
  domeWidth: 260,
  domeAmp: 120,
  detailWidth: 70,
  detailAmp: 28,
  body: 'cloudMid',
  lit: 'cloudCream',
  shadow: 'cloudShadow',
  rim: 'sunCore',
  rimWidth: 30,
  rimStrength: 0.15,
  rimFocus: 3,
  opacity: 0.95,
  drift: 0,
  soft: 4,
  floorY: -48,
  floorFade: 30,
};

export const CLOUDGATE_VARIANTS: Record<VariantId, SkyVistaParams> = {
  // A: sparse towers, lots of open sky
  A: {
    stage: 'cloudgate',
    sky: { ...cgSky },
    clouds: { ...cgClouds, towersPerKm: 4, banksPerKm: 1.5, humpsPerKm: 22, wispsPerKm: 1, corridorX: 60, towerHeight: [150, 320], towerWidth: [120, 210], lateral: [20, 1000] },
    sea: { ...cgSea },
    bands: { ...cgBands, topY: [-20, 30], domeAmp: 90 },
  },
  // B: medium banks
  B: {
    stage: 'cloudgate',
    sky: { ...cgSky },
    clouds: { ...cgClouds },
    sea: { ...cgSea },
    bands: { ...cgBands },
  },
  // C: dense, narrow corridor
  C: {
    stage: 'cloudgate',
    sky: { ...cgSky, cirrus: 0.1 },
    clouds: {
      ...cgClouds,
      towersPerKm: 13,
      banksPerKm: 9,
      humpsPerKm: 30,
      wispsPerKm: 8,
      corridorX: 28,
      towerHeight: [110, 300],
      towerWidth: [100, 200],
      lateral: [2, 420],
    },
    sea: { ...cgSea, bump: 10 },
    bands: { ...cgBands, topY: [10, 80], domeAmp: 150 },
  },
};

// ---------------------------------------------------------------- Violet Tide
const vtSky: SkyDomeParams = {
  horizonBand: 0.03,
  bandColor: ['sunsetMagenta', 'sunsetZenith', 0.35],
  bandSpan: 0.05,
  sunScale: 1.25,
  sunIntensity: 2.2,
  glowInner: ['sunCore', 'sunsetHorizon', 0.35],
  glowOuter: ['sunsetMagenta', 'sunsetZenith', 0.35],
  glowSize: 0.16,
  glowStretch: 0.4,
  glowStrength: 0.7,
  cirrus: 0.08,
  cirrusColor: ['sunsetIndigo', 'sunsetMagenta', 0.3],
  banding: 0.6,
  bandSteps: 8,
  wobble: 0.02,
};

const vtClouds: CloudFieldParams = {
  ...cgClouds,
  seaY: -50,
  towersPerKm: 3,
  towerHeight: [150, 280],
  towerWidth: [200, 340],
  banksPerKm: 3,
  humpsPerKm: 14,
  wispsPerKm: 0,
  bankHeight: [18, 40],
  bankLength: [200, 500],
  lateral: [30, 900],
  humpSpread: 1200,
  corridorX: 50,
  lit: ['sunsetIndigo', 'sunsetMagenta', 0.35],
  mid: 'sunsetCloudDark',
  shadow: ['sunsetCloudDark', 'emblemBlack', 0.4],
  rim: ['sunsetHorizon', 'sunCore', 0.3],
  backlit: 0.9,
  rimPower: 5,
  clusterNormal: 0.35,
  toon: 0.4,
  lift: 0.0,
  wind: 2,
};

const vtSea: CloudSeaParams = {
  y: -50,
  size: 16000,
  scale: 300,
  stretchX: 2.6,
  bump: 12,
  lit: ['sunsetCloudDark', 'sunsetMagenta', 0.16],
  mid: 'sunsetCloudDark',
  shadow: ['sunsetCloudDark', 'emblemBlack', 0.5],
  rim: ['sunsetHorizon', 'sunsetMagenta', 0.3],
  backlit: 0.3,
  drift: 1,
  contrast: 2.0,
  amp: 22,
  bounce: 0.08,
  lumps: 0.6,
  shadowStep: 10,
  shadowAmt: 0.6,
};

const vtBands: CloudBandParams = {
  count: 14,
  mode: 'wrap',
  spacing: 180,
  start: 60,
  back: 40,
  topY: [-48, -38],
  height: 45,
  domeWidth: 60,
  domeAmp: 10,
  detailWidth: 20,
  detailAmp: 4,
  body: 'sunsetCloudDark',
  lit: ['sunsetCloudDark', 'sunsetMagenta', 0.35],
  shadow: ['sunsetCloudDark', 'emblemBlack', 0.45],
  rim: ['sunsetHorizon', 'sunsetMagenta', 0.25],
  rimWidth: 5,
  rimStrength: 1.1,
  rimFocus: 4,
  opacity: 1,
  drift: 1.5,
  soft: 0.6,
  floorY: -50,
  floorFade: 7,
};

export const VIOLET_VARIANTS: Record<VariantId, SkyVistaParams> = {
  // A: medium band spacing, large sun, narrow band
  A: {
    stage: 'violetTide',
    sky: { ...vtSky },
    clouds: { ...vtClouds },
    sea: { ...vtSea },
    bands: { ...vtBands },
  },
  // B: tight bands, bigger sun, narrowest horizon band
  B: {
    stage: 'violetTide',
    sky: { ...vtSky, sunScale: 1.6, horizonBand: 0.018, glowSize: 0.2 },
    clouds: { ...vtClouds },
    sea: { ...vtSea },
    bands: { ...vtBands, count: 20, spacing: 120, domeAmp: 8, height: 38 },
  },
  // C: wide bold bands, smaller sun, wider horizon band
  C: {
    stage: 'violetTide',
    sky: { ...vtSky, sunScale: 0.95, horizonBand: 0.04, glowSize: 0.14 },
    clouds: { ...vtClouds, banksPerKm: 2 },
    sea: { ...vtSea },
    bands: { ...vtBands, count: 10, spacing: 270, domeAmp: 16, domeWidth: 95, height: 60, rimWidth: 7 },
  },
};

export const SKY_VARIANTS: Partial<Record<StageId, Record<VariantId, SkyVistaParams>>> = {
  cloudgate: CLOUDGATE_VARIANTS,
  violetTide: VIOLET_VARIANTS,
};
