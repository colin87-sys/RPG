/**
 * CONTRAIL style tokens: the single source of truth for colour, light, fog,
 * shading, VFX, post and UI values. Docs/STYLE_BIBLE.md mirrors these values;
 * the Reviewer checks that they match.
 *
 * Rules:
 * - All game and lab code imports colours from here. No hex literals elsewhere
 *   (derive with helpers in ./color.ts: mix, shade, withAlpha).
 * - Pure data only (no three.js import) so tools and the HUD canvas can use it.
 * - Change a value: update STYLE_BIBLE.md in the same commit and log it in
 *   Docs/DECISIONS.md if it changes the look of an approved board.
 */

/** Base palette. Names follow STYLE_BIBLE section 2. */
export const palette = {
  // Cloudgate (bright day)
  skyDay: '#098EC3', // sky base, mid-height
  skyZenith: '#0A4FB0', // deeper blue straight up
  skyHorizon: '#A9D9EA', // pale cyan near the horizon haze
  cloudCream: '#E9ECD0', // cumulus lit side
  cloudMid: '#C4CCCB', // cumulus mid tone
  cloudShadow: '#7F93AE', // cumulus shadow side (cool blue-violet tint)
  cloudSea: '#DCE3DC', // cloud-sea top surface far away (haze blend target)

  // Violet Tide (sunset)
  sunsetZenith: '#1B1745', // deep blue-violet top of sky
  sunsetIndigo: '#2A1F5A', // cloud layers, mid sky
  sunsetMagenta: '#B24A9C', // lit cloud rims / upper glow
  sunsetHorizon: '#FF8A2A', // narrow hot horizon band
  sunCore: '#FFF3C0', // sun disc
  sunsetCloudDark: '#1E1838', // backlit cloud bodies

  // Wreckfield (dark space)
  spaceDeep: '#071C24', // background field, HUD backing
  spaceNebula: '#0F3A48', // faint teal nebula veil
  planetYellow: '#E8C35A', // distant planet, key/rim light source
  debrisDark: '#11181D', // wreck slabs and asteroids
  debrisRim: '#D9A45A', // warm rim on debris (from planet)

  // Hero craft (KESTREL) and structures
  armourLight: '#C9CFD3', // large light armour panels
  armourSteel: '#52687A', // mid panels
  armourDark: '#1C252D', // underside, intakes, seams
  canopyBlue: '#3FA7E8', // canopy glass accent
  accentOrange: '#E16C26', // emissive inserts, exhaust
  exhaustCore: '#FFE2A8', // exhaust hot core
  emblemBlack: '#0B0D10', // emblem disc

  // Enemies (WARDEN swarm): dark bodies, warm rim, small emissive markers
  enemyBody: '#1A1F26',
  enemyPanel: '#39434E',
  enemyRim: '#FF9A55',
  enemyMarker: '#FF3B2F',
  caltropRed: '#D8262A', // caltrop drone star body
  bossBody: '#141A22',
  bossVent: '#FFB02A',

  // Effects
  burstYellow: '#F9EF00', // explosion core edge, boss beam halo
  burstWhite: '#FFFBE6', // explosion core, beam core
  fireOrange: '#E16C26', // explosion lobes (same hue family as accentOrange)
  smokeLit: '#F2EEE2', // missile smoke lit side
  smokeShadow: '#98A2AE', // missile smoke shadow side
  smokeDark: '#3A3440', // explosion aftermath smoke

  // Gameplay colour coding (colour never carries meaning alone: shapes too)
  hostileCore: '#FFFFFF', // hostile bullet core: white-hot
  hostileHalo: '#FFB21E', // hostile bullet halo: yellow-orange
  hostileOutline: '#2A0E00', // thin dark ring around hostile bullets
  laserRed: '#FF2A1A', // enemy laser halo and telegraph
  playerShotCore: '#E6FDFF', // player fire: cool cyan-white, smaller
  playerShotHalo: '#4FD8FF',
  lockRed: '#FF2B2B', // lock-on square-corner brackets
  pickupGold: '#FFC83A',
  pickupCyan: '#45E6FF',
  hitFlash: '#FFFFFF',

  // HUD (the only green in the frame)
  hudLine: '#2CA72F', // borders
  hudText: '#75E845', // labels and active fills
  hudValue: '#E4F4E0', // numeric values (near-white, slight green)
  hudDim: '#16501A', // inactive fills, ladder ticks
  hudBacking: '#071C24', // translucent band backing (= spaceDeep)
  shieldRed: '#ED2016', // shield bar
  hazardYellow: '#F2D21B', // hazard stripes and warning banner
  hazardBlack: '#0B0B0B',
} as const;

export type PaletteKey = keyof typeof palette;

/** A light: direction points FROM the scene TOWARD the light (world space, Y up, forward = -Z). */
export interface LightToken {
  dir: [number, number, number];
  color: string;
  intensity: number;
}

export interface StageLook {
  name: string;
  sky: {
    zenith: string;
    mid: string;
    horizon: string;
    /** where the mid colour sits, 0 = horizon, 1 = zenith */
    midHeight: number;
    sunColor: string;
    sunSize: number; // angular radius of the disc, radians
    sunGlow: number; // halo strength 0..1
  };
  key: LightToken; // the single key light for the stage
  rim: LightToken; // rim light for silhouette separation
  ambientSky: string; // hemisphere ambient, from above
  ambientGround: string; // hemisphere ambient, from below (bounce)
  ambientIntensity: number;
  fog: {
    color: string;
    density: number; // exp2 density per metre
    heightFalloff: number; // extra fog below cloud-sea level
    far: string; // colour-shifted distance fade target
  };
  /** 60/30/10 split for the Reviewer: dominant field, secondary mass, accents */
  split: { dominant: PaletteKey[]; secondary: PaletteKey[]; accent: PaletteKey[] };
}

const n = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};

/** Per-stage looks. One key-light direction per stage. */
export const stages: Record<'cloudgate' | 'violetTide' | 'wreckfield', StageLook> = {
  cloudgate: {
    name: 'Cloudgate',
    sky: {
      zenith: palette.skyZenith,
      mid: palette.skyDay,
      horizon: palette.skyHorizon,
      midHeight: 0.35,
      sunColor: palette.sunCore,
      sunSize: 0.035,
      sunGlow: 0.55,
    },
    key: { dir: n(-0.45, 0.8, -0.4), color: '#FFF4DC', intensity: 2.6 }, // high-left sun
    rim: { dir: n(0.6, 0.25, 0.75), color: '#CDEBFF', intensity: 1.6 }, // cool back-right rim
    ambientSky: '#6E9CC4',
    ambientGround: '#D8D6C4',
    ambientIntensity: 0.9,
    fog: { color: '#B9D9E6', density: 0.0011, heightFalloff: 0.02, far: palette.skyHorizon },
    split: {
      dominant: ['skyDay', 'skyZenith', 'skyHorizon'],
      secondary: ['cloudCream', 'cloudMid', 'cloudShadow', 'armourDark'],
      accent: ['accentOrange', 'hostileHalo', 'hudLine', 'laserRed'],
    },
  },
  violetTide: {
    name: 'Violet Tide',
    sky: {
      zenith: palette.sunsetZenith,
      mid: palette.sunsetIndigo,
      horizon: palette.sunsetHorizon,
      midHeight: 0.28,
      sunColor: palette.sunCore,
      sunSize: 0.06,
      sunGlow: 1.0,
    },
    key: { dir: n(0.0, 0.1, -1.0), color: '#FFB070', intensity: 2.2 }, // low sun ahead: craft backlit
    rim: { dir: n(0.0, 0.15, -1.0), color: '#FF9A4A', intensity: 2.4 },
    ambientSky: '#3A2E6E',
    ambientGround: '#5A2F58',
    ambientIntensity: 0.8,
    fog: { color: '#5E3A74', density: 0.0014, heightFalloff: 0.025, far: '#5C2A55' },
    split: {
      dominant: ['sunsetZenith', 'sunsetIndigo'],
      secondary: ['sunsetCloudDark', 'sunsetMagenta'],
      accent: ['sunsetHorizon', 'sunCore', 'hostileHalo', 'hudLine'],
    },
  },
  wreckfield: {
    name: 'Wreckfield',
    sky: {
      zenith: '#050F14',
      mid: palette.spaceDeep,
      horizon: palette.spaceNebula,
      midHeight: 0.5,
      sunColor: palette.planetYellow,
      sunSize: 0.12,
      sunGlow: 0.35,
    },
    key: { dir: n(0.7, 0.25, -0.65), color: '#F2C860', intensity: 2.4 }, // distant yellow planet, right-front
    rim: { dir: n(0.7, 0.25, -0.65), color: palette.debrisRim, intensity: 2.0 },
    ambientSky: '#0C2830',
    ambientGround: '#08141A',
    ambientIntensity: 0.6,
    fog: { color: '#0A2229', density: 0.0005, heightFalloff: 0.0, far: palette.spaceNebula },
    split: {
      dominant: ['spaceDeep'],
      secondary: ['debrisDark', 'spaceNebula'],
      accent: ['smokeLit', 'hostileHalo', 'laserRed', 'hudLine', 'planetYellow'],
    },
  },
};

export type StageId = keyof typeof stages;

/** Toon ramp for hull shading: stops of (lightness 0..1 -> multiplier), generated to a 1D texture by code. */
export const shading = {
  ramp: [
    { at: 0.0, value: 0.18 }, // core shadow (tinted cool via ambient)
    { at: 0.38, value: 0.32 },
    { at: 0.46, value: 0.72 }, // soft terminator
    { at: 0.8, value: 0.95 },
    { at: 1.0, value: 1.08 }, // lit highlight
  ],
  shadowTint: '#3A4A78', // shadows shift toward cool blue-violet
  highlightTint: '#FFF6E2', // highlights shift toward warm cream
  rimPower: 3.0, // fresnel exponent
  rimStrength: 0.9,
  seamWidth: 0.012, // panel seam line width in metres
  seamDarkness: 0.55, // 0 = invisible, 1 = black
  outline: { enabled: true, widthHero: 0.035, widthEnemy: 0.05, color: '#0B0F14' },
  specular: { power: 48, strength: 0.35 },
} as const;

/** VFX language (numbers from DESIGN.md; colours from palette). */
export const vfx = {
  smoke: { lifeS: 5.0, widthStart: 0.8, widthEnd: 3.0, puffsPerS: 30, lit: palette.smokeLit, shadow: palette.smokeShadow },
  explosion: {
    core: palette.burstWhite,
    coreEdge: palette.burstYellow,
    lobe: palette.fireOrange,
    smoke: palette.smokeDark,
    growS: 0.3,
    growScale: 3,
    lobes: [6, 10] as [number, number],
    sparks: [20, 40] as [number, number],
  },
  shockRing: { thicknessFrac: 0.03, rgbOffsetFrac: [0.004, 0.008] as [number, number], growS: [0.7, 1.3] as [number, number], screenFrac: [0.3, 0.65] as [number, number], fadeTailFrac: 0.3 },
  speedStreaks: { count: 200, color: '#FFFFFF', edgeBoost: 1.8 },
  beam: { coreWidth: 0.6, haloWidth: 3.0, core: palette.burstWhite, haloEnemy: palette.laserRed, haloBoss: palette.burstYellow, telegraphS: 0.7 },
  hostileBullet: { core: palette.hostileCore, halo: palette.hostileHalo, outline: palette.hostileOutline, minFrameHeightFrac: 0.018, atDistance: 60 },
  playerShot: { core: palette.playerShotCore, halo: palette.playerShotHalo },
  hitFlashFrames: 2,
} as const;

/** Post stack (analogue video). A 'clean' toggle disables everything but tone mapping for harness captures. */
export const post = {
  exposure: 1.0,
  bloom: { threshold: 0.85, strength: 0.6, radius: 0.6 },
  vignette: 0.25,
  chroma: { base: 0.0015, hit: 0.006, ring: 0.008 },
  scanlines: { lines: 540, opacity: 0.06 },
  grain: 0.04,
  grade: { lift: '#0A0C18', gamma: 1.0, gain: '#FFF8EC', saturation: 1.08 },
} as const;

/** HUD layout (fractions of frame) and line weights (px at 1080p, scaled by height/1080). */
export const hud = {
  bandTop: 0.085, // measured 8.5% (REF_VERIFICATION)
  bandBottom: 0.09,
  sideMargin: 0.012,
  ladderX: 0.975,
  ladderTop: 0.14,
  ladderBottom: 0.59,
  pilotFrame: { x: 0.838, y: 0.655, w: 0.107, h: 0.245 },
  lineWidth: 2,
  backingAlpha: 0.3, // measured scrim ~0.3 black
  glyphHeightLabel: 0.012, // tiny corner labels
  glyphHeightValue: 0.024, // score, weapon name
  reticleRadius: 0.06, // fraction of frame height
  lockBracketSize: 0.035,
  colors: {
    line: palette.hudLine,
    text: palette.hudText,
    value: palette.hudValue,
    dim: palette.hudDim,
    backing: palette.hudBacking,
    shield: palette.shieldRed,
    hazard: palette.hazardYellow,
    hazardDark: palette.hazardBlack,
    lock: palette.lockRed,
    danger: palette.shieldRed,
  },
} as const;

/** Scale table (metres). */
export const scale = {
  pilot: 1.8,
  kestrelLength: 12,
  kestrelSpan: 9,
  caltrop: 1.4,
  dart: 7,
  sniper: 8,
  strider: 16,
  bulwarkSpan: 220,
} as const;
