/**
 * Palette.js — the Vesper colour system, as data.
 *
 * Every number here is transcribed from docs/ART_BIBLE.md. Nothing in this file
 * is an aesthetic decision made locally: if a value looks wrong on screen the
 * fix is a conversation about the bible, not an edit here. Modules that need a
 * colour import it from here rather than typing a hex literal, so that a single
 * change to the art direction propagates to sky, lighting, materials, VFX and
 * UI in one commit.
 *
 * Colour maths convention: all mixing, ramp sampling and temperature work is
 * done in **linear light**, because interpolating in sRGB darkens and desaturates
 * mid-tones (the classic muddy-green between yellow and blue). Hex constants are
 * sRGB as authored; `hexToLinear` is the only door between the two spaces, and
 * these helpers deliberately do not depend on `THREE.ColorManagement` being
 * enabled so texture generation produces identical bytes either way.
 *
 * OWNED BY: art.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------- transfer

/** IEC 61966-2-1 sRGB EOTF. */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Inverse sRGB EOTF. */
export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

const _lut = new Float32Array(256);
for (let i = 0; i < 256; i++) _lut[i] = srgbToLinear(i / 255);

/** Byte-domain sRGB decode via lookup — texture loops call this millions of times. */
export function byteToLinear(b) {
  return _lut[b & 255];
}

/**
 * Encode LUT. `linearToSrgb` is a `Math.pow` and this function runs three times
 * per texel across every map in the game — roughly eight million calls for a
 * single scene's worth of 512² surfaces, where `pow` alone measured at 44 ms per
 * map. 8192 entries with linear interpolation puts the reconstruction error
 * below 0.2/255, which is under the quantisation step it is feeding.
 */
const ENC_BITS = 8192;
const _enc = new Float32Array(ENC_BITS + 1);
for (let i = 0; i <= ENC_BITS; i++) _enc[i] = linearToSrgb(i / ENC_BITS) * 255;

/** Linear float -> sRGB byte, clamped. The single encode point for every map. */
export function linearToByte(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  const f = v * ENC_BITS;
  const i = f | 0;
  const t = f - i;
  return (_enc[i] + (_enc[i + 1] - _enc[i]) * t + 0.5) | 0;
}

/** Decompose an sRGB hex into linear RGB. `out` is a 3-element array-like. */
export function hexToLinear(hex, out = [0, 0, 0]) {
  out[0] = _lut[(hex >> 16) & 255];
  out[1] = _lut[(hex >> 8) & 255];
  out[2] = _lut[hex & 255];
  return out;
}

/** Decompose an sRGB hex into normalised sRGB floats (no transfer applied). */
export function hexToSrgb(hex, out = [0, 0, 0]) {
  out[0] = ((hex >> 16) & 255) / 255;
  out[1] = ((hex >> 8) & 255) / 255;
  out[2] = (hex & 255) / 255;
  return out;
}

/** Recompose linear RGB into an sRGB hex. */
export function linearToHex(r, g, b) {
  return (linearToByte(r) << 16) | (linearToByte(g) << 8) | linearToByte(b);
}

/** Rec.709 relative luminance of a **linear** triple. */
export function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** A `THREE.Color` from a palette hex. Always returns a fresh instance — the
 *  palette must never hand out an object a caller can mutate underneath others. */
export function color(hex) {
  return new THREE.Color(hex);
}

// ------------------------------------------------------------ §2.1 lighting

/**
 * Light and atmosphere keys (ART_BIBLE §2.1).
 * `SHADOW_TINT` is load-bearing: §2.1's shadow rule forbids any zero-saturation
 * ambient term, and every fill/hemisphere colour in the game is expected to be
 * pushed through `applyShadowRule` before it reaches a light.
 */
export const LIGHT = Object.freeze({
  KEY_SUN: 0xffd9a3,
  BOUNCE_GROUND: 0xd9a06b,
  SHADOW_TINT: 0x2e4a5f,
  RING_GLOW: 0x5fb8b0,
  FOG_NEAR: 0x6e93a6,
  FOG_FAR: 0xc4b49a,
});

/** §2.3 value structure — the tinted floor lift, never pure black. */
export const TEAL_BLACK = 0x0a1218;

/** Minimum saturation permitted in any shadow-region colour (§2.1). */
export const MIN_SHADOW_SATURATION = 0.15;

// ------------------------------------------------------------ §2.2 elements

/**
 * Elemental accents (ART_BIBLE §2.2). These are the only colours in the game
 * permitted to reach full chroma or exceed 1.0 emissive. `emissive` is the
 * pre-tonemap HDR intensity band for spell cores; ambient props use `propGlow`.
 */
export const ELEMENT = Object.freeze({
  fire: { accent: 0xff6b2b, core: 0xffd08a, fringe: 0xff9e5e },
  ice: { accent: 0x7de3ff, core: 0xeafbff, fringe: 0xa8d8ff },
  lightning: { accent: 0xffe95c, core: 0xffffff, fringe: 0xb98cff },
  water: { accent: 0x3fa9f5, core: 0xa8e4ff, fringe: 0x2e7fbd },
  earth: { accent: 0xc98f3f, core: 0xf2d9a6, fringe: 0x8a6a3a },
  wind: { accent: 0x8fe6a0, core: 0xe6ffee, fringe: 0x5fb8b0 },
  light: { accent: 0xfff0b8, core: 0xffffff, fringe: 0xffc24d },
  dark: { accent: 0x8c4dd9, core: 0x2b1245, fringe: 0xd94d8c },
});

export const EMISSIVE_SPELL_CORE = Object.freeze({ min: 2.5, max: 6.0 });
export const EMISSIVE_PROP = Object.freeze({ min: 1.2, max: 1.8 });

/** Look up an element's colour set; unknown names fall back to `light`. */
export function element(name) {
  return ELEMENT[name] ?? ELEMENT.light;
}

// --------------------------------------------------------- §3 time of day

/**
 * The four time-of-day keys (ART_BIBLE §3). `t` wraps at 1.0.
 * `ambient` is the summed hemisphere+probe contribution relative to a key
 * light of 3.0; `exposure` drives `renderer.toneMappingExposure`.
 */
export const TIME_KEYS = Object.freeze([
  Object.freeze({
    t: 0.0, name: 'night',
    sun: 0xa8c8e8, sunIntensity: 0.9,
    zenith: 0x0b1226, horizon: 0x1e3050,
    fog: 0x16283c, fogDensity: 0.0035,
    exposure: 1.25, ambient: 0.18,
    ringAlpha: 1.0, sunElevationDeg: -8,
  }),
  Object.freeze({
    t: 0.25, name: 'dawn',
    sun: 0xff9e5e, sunIntensity: 2.2,
    zenith: 0x2a3e66, horizon: 0xffb37e,
    fog: 0xc58a6b, fogDensity: 0.0045,
    exposure: 1.05, ambient: 0.35,
    ringAlpha: 0.15, sunElevationDeg: 8,
  }),
  Object.freeze({
    t: 0.5, name: 'noon',
    sun: 0xffead0, sunIntensity: 3.0,
    zenith: 0x33628f, horizon: 0xbfd9e2,
    fog: 0xa8c4cc, fogDensity: 0.0018,
    exposure: 1.0, ambient: 0.55,
    ringAlpha: 0.0, sunElevationDeg: 62,
  }),
  Object.freeze({
    t: 0.75, name: 'dusk',
    sun: 0xff6b3d, sunIntensity: 2.4,
    zenith: 0x35275e, horizon: 0xff9e6b,
    fog: 0x8a5e7a, fogDensity: 0.0055,
    exposure: 1.15, ambient: 0.3,
    ringAlpha: 0.6, sunElevationDeg: 6,
  }),
]);

/** The game's default field time — §3 calls dusk the hero key. */
export const HERO_TIME_OF_DAY = 0.72;

const _tmpA = [0, 0, 0];
const _tmpB = [0, 0, 0];

/**
 * Interpolate the time-of-day keys at `t` (0..1, wrapping). Colours are mixed
 * in linear light per §3 and returned as sRGB hex so callers can hand them
 * straight to `THREE.Color`. Scalars interpolate linearly except fog density,
 * which is interpolated geometrically — density is a multiplicative optical
 * quantity and a linear blend between 0.0018 and 0.0055 reads as a visible
 * step at the midpoint.
 */
export function sampleTimeOfDay(t) {
  const x = ((t % 1) + 1) % 1;
  const n = TIME_KEYS.length;
  const span = 1 / n;
  const i = Math.min(n - 1, Math.floor(x / span));
  const j = (i + 1) % n;
  const a = TIME_KEYS[i];
  const b = TIME_KEYS[j];
  // Smoothstep the blend: a linear ramp between keys makes the sun colour
  // visibly "arrive" at each key, which reads as a lighting pop in a timelapse.
  const raw = (x - i * span) / span;
  const f = raw * raw * (3 - 2 * raw);
  return {
    from: a.name,
    to: b.name,
    blend: f,
    sun: mixHex(a.sun, b.sun, f),
    sunIntensity: a.sunIntensity + (b.sunIntensity - a.sunIntensity) * f,
    zenith: mixHex(a.zenith, b.zenith, f),
    horizon: mixHex(a.horizon, b.horizon, f),
    fog: mixHex(a.fog, b.fog, f),
    fogDensity: a.fogDensity * Math.pow(b.fogDensity / a.fogDensity, f),
    exposure: a.exposure + (b.exposure - a.exposure) * f,
    ambient: a.ambient + (b.ambient - a.ambient) * f,
    ringAlpha: a.ringAlpha + (b.ringAlpha - a.ringAlpha) * f,
    sunElevationDeg: a.sunElevationDeg + (b.sunElevationDeg - a.sunElevationDeg) * f,
  };
}

/** Mix two sRGB hexes in linear light. */
export function mixHex(hexA, hexB, t) {
  hexToLinear(hexA, _tmpA);
  hexToLinear(hexB, _tmpB);
  return linearToHex(
    _tmpA[0] + (_tmpB[0] - _tmpA[0]) * t,
    _tmpA[1] + (_tmpB[1] - _tmpA[1]) * t,
    _tmpA[2] + (_tmpB[2] - _tmpA[2]) * t,
  );
}

// ----------------------------------------------------------- §4 materials

/**
 * Per-surface physical specification (ART_BIBLE §4). `albedo` is the **linear
 * luminance** band the base map must stay inside; Textures.js rescales every
 * generated albedo into this band so exposure and GI stay predictable and no
 * surface can quietly become a light source.
 */
export const SURFACE_SPEC = Object.freeze({
  stone: { roughness: [0.72, 0.92], metalness: 0, albedo: [0.18, 0.42] },
  marble: { roughness: [0.25, 0.45], metalness: 0, albedo: [0.55, 0.8] },
  wood: { roughness: [0.55, 0.75], metalness: 0, albedo: [0.22, 0.45] },
  bark: { roughness: [0.8, 0.95], metalness: 0, albedo: [0.1, 0.25] },
  foliage: { roughness: [0.45, 0.65], metalness: 0, albedo: [0.12, 0.3] },
  cloth: { roughness: [0.75, 0.95], metalness: 0, albedo: [0.2, 0.55] },
  silk: { roughness: [0.3, 0.5], metalness: 0, albedo: [0.3, 0.65] },
  leather: { roughness: [0.5, 0.7], metalness: 0, albedo: [0.1, 0.3] },
  steel: { roughness: [0.3, 0.55], metalness: 1, albedo: [0.5, 0.6] },
  // §4 gives gold as a tint range rather than a band; #FFC24D and #D9964A have
  // linear luminances of 0.598 and 0.374, so those are the numbers. Pushing the
  // ceiling any higher only clips the red channel and flattens the polish.
  gold: { roughness: [0.2, 0.4], metalness: 1, albedo: [0.374, 0.598] },
  crystal: { roughness: [0.05, 0.15], metalness: 0, albedo: [0.35, 0.7] },
  water: { roughness: [0.02, 0.1], metalness: 0, albedo: [0.02, 0.08] },
  skin: { roughness: [0.38, 0.55], metalness: 0, albedo: [0.35, 0.55] },
  // --- terrain -------------------------------------------------------------
  // The three ground surfaces carry a `maxSat` the other surfaces do not, and
  // their albedo bands are far narrower than a photographic material would want.
  // Both come from REFERENCE_TARGET §3: "environment saturation sits **below**
  // character and VFX saturation. The background is a stage, never competition."
  //
  // That is a measurable constraint, not a mood, and until now nothing enforced
  // it. `fitAlbedoBand` rescales luminance but holds chroma ratios exactly, so a
  // generator authored from saturated soil-and-blade colours produced a ground
  // whose chroma beat every character in frame — the review's "screaming red/
  // green fBm carpet", with the eye landing on the floor before the cast. A
  // luminance band alone cannot prevent that; only a chroma ceiling can.
  //
  // Band widths are solved in display space rather than picked, and every band
  // is **narrowed or widened about its own midpoint**, never lowered. Sand's
  // 0.34→0.445 linear encodes to sRGB 161→182, a 21-unit spread against the old
  // band's 55, and the ground macro layer's ±12% multiplicative drift takes it
  // to about 35 — inside the 40-unit terrain budget. Holding the midpoint is
  // what matters: LookdevScene calibrated its contact-shadow lift against the
  // stage floor's *value*, and a band that also dropped brightness would have
  // taken those shadows back out while fixing the contrast.
  //
  // `maxSat` is HSV saturation measured on the *encoded* triple, the way it
  // would be eyedropped; `chromaClamp` derives the linear channel ratio that
  // enforces it, and lands within about 0.01 of the authored figure.
  sand: { roughness: [0.55, 0.85], metalness: 0, albedo: [0.34, 0.445], maxSat: 0.22 },
  // Grass is the one terrain surface the 0.22 chroma ceiling is now wrong for.
  // That number comes from REFERENCE_TARGET §3 ("environment saturation sits
  // below character saturation"), which BRAVELY_REFERENCE §5 supersedes for the
  // field: "bright, sharp, saturated ... crisp green grass with visible blade
  // detail". At 0.22 the generator's greens are clamped to a grey-green that no
  // consumer was willing to use, which is *why* the stage floor and the blade
  // instances both ended up hand-authoring their own hexes and drifting apart.
  // 0.40 is the chroma the derived `MEADOW` family actually carries, so the
  // ceiling stops rewriting the family and starts only bounding it.
  //
  // The luminance band widens about its own midpoint (0.224 → 0.228, i.e. the
  // floor's overall level is unchanged) from a 0.082 spread to 0.120. §4's
  // total-variation budget was spent when the macro layer stacked on top of the
  // detail map; the stage floor discards the macro layer entirely, so the detail
  // map is the only value structure the largest area in frame has, and at 0.082
  // it had none — the review's "dead value structure ... chalky". The contrast
  // that caused the old moiré lived in the *height* field and stays where it is.
  grass: { roughness: [0.5, 0.8], metalness: 0, albedo: [0.168, 0.288], maxSat: 0.40 },
  dirt: { roughness: [0.78, 0.96], metalness: 0, albedo: [0.14, 0.215], maxSat: 0.2 },
});

/** Surface-specific tints called out by name in §4. */
export const SURFACE_TINT = Object.freeze({
  MOSS: 0x5e7a4a,
  MARBLE_RIM: 0xeae2d4,
  FOLIAGE_LIT: 0x6b8f4a,
  FOLIAGE_UNDER: 0x3d5c33,
  SILK_SPEC: 0xffe9d0,
  GOLD_BRIGHT: 0xffc24d,
  GOLD_DEEP: 0xd9964a,
  GOLD_GRIME: 0x4a3418,
  WATER_ABSORB: 0x0e3a42,
  SKIN_RIM: 0xff9e7a,
  PRACTICAL: 0xffb36b,
});

/** §4 global rule: env contribution per material class. */
export const ENV_INTENSITY = Object.freeze({ default: 0.6, metal: 1.0, crystal: 1.0, cloth: 0.25 });

// ------------------------------------------------------- the field's ground

/**
 * The one colour family the meadow floor is built from: terrain, blades, soil.
 *
 * It exists because the same material was being authored independently in three
 * modules — `Textures.genGrass` carried its own soil and blade hexes,
 * `LookdevScene` its own `uLawnColor`, and `Flora.js` its own `GRASS_ROOT`/
 * `GRASS_TIP` — and three independent authors of one surface do not drift by
 * accident, they drift by construction. Measured on the shipped stage frame the
 * floor came out at hue 68° (yellow-green) while the blades growing out of it
 * averaged 110–160° with a tail past 200°: two unrelated hues, which is why the
 * review read the field as "green mud with plastic shards stuck in it" rather
 * than as grass.
 *
 * `GROUND` is therefore the only authored colour on this surface. The blade
 * ramp and the bare soil are **derived** from it by {@link bladeRamp} and
 * {@link MEADOW_SOIL}, so a blade cannot leave the terrain's hue family — the
 * guarantee is structural rather than a thing a reviewer has to catch.
 *
 * The palette's teal is deliberately absent here. `REFERENCE_TARGET` §4's cyan
 * dominance is carried by the atmosphere and the rim (`FOG_NEAR`, `RING_GLOW`),
 * where its job is to separate a subject from its background. Inside a ground
 * material it is not a rim, it is a second hue, and the eye reads two hues in
 * one surface as two materials.
 */
export const MEADOW = Object.freeze({
  /**
   * Lawn albedo. The reference plate's mown lawn measures `#7e9659` at p90 of a
   * hue-masked region; that is a *rendered* value under a high warm key, and an
   * albedo is not, so what is authored here is the same colour a stop down.
   */
  GROUND: 0x5f7233,
  /** The worn track through it, measured the same way over the plate's path. */
  PATH: 0xd8c096,
});

/**
 * Root and tip colours for a grass blade, derived from the ground it grows out
 * of so the two can only ever be one material at two values.
 *
 * The shape of the derivation is what a blade actually does under a key light:
 * the tip is the part that clears its neighbours, so it is **lighter and a
 * little more chromatic**; the base sits inside the sward's own occlusion, so it
 * is **much darker and slightly cooler** — cooler *within the green family*, a
 * rotation of a dozen degrees toward the blue-green side, not a push toward
 * cyan. Both operations run about the ground's own chromaticity, so no setting
 * of these parameters can produce a hue the terrain does not already contain.
 *
 * @param {number} [ground] sRGB hex of the terrain the blades grow from.
 * @param {Object} [opts]
 * @param {number} [opts.lift=0.13] tip luminance gain over the terrain.
 * @param {number} [opts.tipChroma=1.10] tip saturation about its own luminance.
 * @param {number} [opts.rootValue=0.42] base luminance as a fraction of terrain.
 * @param {number} [opts.rootChroma=1.12] base saturation — shadow gains chroma
 *   as it loses value, per §2.1.
 * @param {number} [opts.rootCool=12] base hue rotation, in degrees, toward the
 *   cool side of the family.
 * @returns {{root:number, tip:number}} sRGB hexes.
 */
export function bladeRamp(ground = MEADOW.GROUND, opts = {}) {
  const {
    lift = 0.13, tipChroma = 1.10,
    rootValue = 0.42, rootChroma = 1.12, rootCool = 12,
  } = opts;
  return {
    tip: scaleValue(saturate(ground, tipChroma), 1 + lift),
    root: scaleValue(saturate(hueRotate(ground, rootCool), rootChroma), rootValue),
  };
}

/**
 * The mown lawn the cast stands on, and the unmown tufts behind them.
 *
 * One family, two readings of it. The bed's blades are longer, stand deeper in
 * their own shade and are seen mostly side-on rather than end-on, so their base
 * runs darker and their tips carry less of the key than the lawn's do — which is
 * exactly the separation the reference plate shows between its lawn and its bed.
 * The difference between them is now four numbers on one derivation rather than
 * four independently eyedropped hexes, so the two presets cannot separate in hue
 * however far they separate in value.
 */
export const LAWN_BLADE = Object.freeze(bladeRamp(MEADOW.GROUND));
export const MEADOW_BLADE = Object.freeze(bladeRamp(MEADOW.GROUND, {
  lift: 0.05, tipChroma: 1.04, rootValue: 0.28, rootCool: 16,
}));

/**
 * Bare earth between the blades: the family, darkened, warmed and taken down in
 * chroma. Never an authored brown — an unrelated hue under the sward is half of
 * what made the old tile read as two materials at texel scale.
 */
export const MEADOW_SOIL = saturate(temperatureShift(scaleValue(MEADOW.GROUND, 0.52), 0.45, 0.85), 0.66);

/** Sun-bleached blades scattered through a summer lawn — the family, lifted and
 *  swung warm. A straw that is not a member of this family reads as litter. */
export const MEADOW_DRY = saturate(temperatureShift(scaleValue(MEADOW.GROUND, 1.42), 0.7, 1.0), 0.78);

// -------------------------------------------------------------- §6 grades

/**
 * Named grades for `PostFX.setGrade` (ART_BIBLE §6). Kept here rather than in
 * PostFX so the colour contract lives in one file; PostFX consumes it.
 *
 * **`grain` is 0 in every grade, and that is a pipeline rule rather than a
 * taste setting.** ANIME_PIPELINE's absolute rule is that no procedural noise
 * touches a character surface, because on a character it reads as dirt — and a
 * full-screen film-grain pass is a procedural noise texture on every character
 * surface in the frame, applied after all the work that made those surfaces
 * flat. The composite's luminance envelope (`4L(1-L)`, peaking in the mids)
 * puts the *maximum* amplitude exactly on skin, which is why the review found
 * the lead's face speckled orange-on-orange at 3×; and against a cel band —
 * a genuinely constant colour region several hundred pixels across — even the
 * small residual on hair reads as mottling, because there is nothing else in
 * that region for the eye to attribute the variation to.
 *
 * Grain exists to sell photographic capture. This target is drawn, not shot.
 * Nothing else in the chain depends on it: the composite dithers its own 8-bit
 * quantisation with interleaved gradient noise, and the toon material dithers
 * its bands, so removing grain costs no banding.
 */
export const GRADE = Object.freeze({
  default: {
    shadowTint: 0x2e4a5f, shadowAmount: 0.6,
    highlightTint: 0xffd9a3, highlightAmount: 0.45,
    saturation: 1.05, contrast: 1.06, grain: 0, vignette: 0.28, aberration: 0.0012,
  },
  sorrow: {
    shadowTint: 0x22384a, shadowAmount: 0.65,
    highlightTint: 0xc9d6dd, highlightAmount: 0.4,
    saturation: 0.85, contrast: 1.04, grain: 0, vignette: 0.3, aberration: 0.0012,
  },
  ember: {
    shadowTint: 0x33221f, shadowAmount: 0.55,
    highlightTint: 0xffb36b, highlightAmount: 0.5,
    saturation: 1.08, contrast: 1.08, grain: 0, vignette: 0.34, aberration: 0.0014,
  },
  void: {
    shadowTint: 0x2b1245, shadowAmount: 0.7,
    highlightTint: 0xd6c8ff, highlightAmount: 0.4,
    saturation: 0.98, contrast: 1.1, grain: 0, vignette: 0.32, aberration: 0.002,
  },
  verdant: {
    shadowTint: 0x27423a, shadowAmount: 0.6,
    highlightTint: 0x7a9e6b, highlightAmount: 0.45,
    saturation: 1.06, contrast: 1.05, grain: 0, vignette: 0.28, aberration: 0.0012,
  },
});

// ------------------------------------------------------------- ramp system

/**
 * A gradient ramp: sorted stops of `{ t, hex }` sampled in linear light.
 * VFX colour lookup, toon shading bands and sky gradients all come from here,
 * so there is exactly one interpolation policy in the codebase.
 */
export class Ramp {
  /**
   * @param {Array<{t:number, hex:number, a?:number}>} stops sorted ascending by t
   */
  constructor(stops) {
    this.stops = [...stops].sort((a, b) => a.t - b.t);
    this._lin = this.stops.map((s) => hexToLinear(s.hex, [0, 0, 0]));
    this._alpha = this.stops.map((s) => (s.a === undefined ? 1 : s.a));
  }

  /** Sample into `out` as linear RGB + alpha. */
  sample(t, out = [0, 0, 0, 1]) {
    const s = this.stops;
    const n = s.length;
    if (t <= s[0].t) {
      out[0] = this._lin[0][0]; out[1] = this._lin[0][1]; out[2] = this._lin[0][2];
      out[3] = this._alpha[0];
      return out;
    }
    if (t >= s[n - 1].t) {
      const l = this._lin[n - 1];
      out[0] = l[0]; out[1] = l[1]; out[2] = l[2];
      out[3] = this._alpha[n - 1];
      return out;
    }
    let i = 0;
    while (i < n - 2 && t > s[i + 1].t) i++;
    const a = s[i], b = s[i + 1];
    const f = (t - a.t) / (b.t - a.t || 1e-6);
    const la = this._lin[i], lb = this._lin[i + 1];
    out[0] = la[0] + (lb[0] - la[0]) * f;
    out[1] = la[1] + (lb[1] - la[1]) * f;
    out[2] = la[2] + (lb[2] - la[2]) * f;
    out[3] = this._alpha[i] + (this._alpha[i + 1] - this._alpha[i]) * f;
    return out;
  }

  /** Sample and return an sRGB hex — convenient for lights and UI. */
  sampleHex(t) {
    const c = this.sample(t);
    return linearToHex(c[0], c[1], c[2]);
  }
}

export function makeRamp(stops) {
  return new Ramp(stops);
}

/**
 * The canonical VFX ramps. Structure is always the same and it is deliberate:
 * a near-white core at t=0 (this is what bloom catches), the saturated accent
 * in the middle third (this is the colour the player names the spell by), and
 * a dark, transparent tail (this is what keeps additive stacking from washing
 * the frame to white). Deviating from that shape is what makes procedural VFX
 * look like coloured smoke instead of magic.
 */
export function elementRamp(name) {
  const e = element(name);
  return new Ramp([
    { t: 0.0, hex: e.core, a: 1.0 },
    { t: 0.18, hex: e.core, a: 1.0 },
    { t: 0.42, hex: e.accent, a: 0.95 },
    { t: 0.72, hex: e.fringe, a: 0.55 },
    { t: 1.0, hex: TEAL_BLACK, a: 0.0 },
  ]);
}

/**
 * A soft toon shading ramp (REFERENCE_TARGET §1: broad lit region, soft
 * terminator, coloured shadow, mandatory rim).
 *
 * The shadow end is pushed toward `SHADOW_TINT` and the lit end toward
 * `KEY_SUN`, so the ramp itself carries the warm-to-cool gradient the bible
 * demands — a character lit through this ramp cannot produce a grey shadow
 * even if the fill light is misconfigured.
 */
export function toonRamp(bands = 3, { shadow = LIGHT.SHADOW_TINT, lit = LIGHT.KEY_SUN, warmth = 0.55 } = {}) {
  // The ramp is a *multiplier* on the character's albedo, indexed by N·L, so
  // its value axis runs 0.40 (deep shade) to 1.0 (full key) rather than to
  // black — a toon shadow that goes to zero kills the silhouette read the
  // reference depends on.
  //
  // Hue and value are computed separately, and that separation is the whole
  // trick. Mixing `SHADOW_TINT` toward `KEY_SUN` in linear light at t = 0.15
  // produces a *neutral grey*, because the key colour's magnitude is fifteen
  // times the shadow's and swamps its chroma long before the mix looks warm.
  // Normalising both endpoints to unit luminance first, mixing chromaticity,
  // and applying the value afterwards is what keeps the shadow band decisively
  // teal — which §2.1 requires, and which every character in the game inherits.
  const sChroma = hexToLinear(shadow, [0, 0, 0]);
  const lChroma = hexToLinear(lit, [0, 0, 0]);
  for (const c of [sChroma, lChroma]) {
    const y = luminance(c[0], c[1], c[2]) || 1e-6;
    c[0] /= y; c[1] /= y; c[2] /= y;
  }

  const stops = [];
  const softness = 0.055; // width of each terminator, in ramp space
  const bandColor = (v) => {
    // Hue arrives later than value (exponent > 1) so the darkest band sits in
    // the shadow tint rather than at a midpoint.
    const t = Math.pow(v, 1 + warmth);
    const linVal = srgbToLinear(0.4 + 0.6 * v);
    let r = (sChroma[0] + (lChroma[0] - sChroma[0]) * t) * linVal;
    let g = (sChroma[1] + (lChroma[1] - sChroma[1]) * t) * linVal;
    let b = (sChroma[2] + (lChroma[2] - sChroma[2]) * t) * linVal;
    // Unit-luminance chroma can exceed 1.0 in a single channel at the warm end.
    // Letting it clip would shift the hue of the brightest band only, putting a
    // visible colour step at the top of an otherwise smooth ramp; scaling the
    // whole triple down loses a fraction of value instead, which nobody sees.
    const m = Math.max(r, g, b);
    if (m > 1) {
      r /= m; g /= m; b /= m;
    }
    return linearToHex(r, g, b);
  };

  for (let i = 0; i < bands; i++) {
    const lo = i / bands;
    const hi = (i + 1) / bands;
    // Band value is biased toward the light end so the lit region reads broad
    // and the shadow reads as one decisive mass — the chibi look, not a
    // continuous falloff with steps in it.
    const v = Math.pow((i + 0.65) / bands, 0.78);
    const hex = bandColor(v);
    stops.push({ t: i > 0 ? lo + softness : 0, hex });
    stops.push({ t: Math.max(lo + softness + 1e-3, hi - softness), hex });
  }
  stops.push({ t: 1, hex: bandColor(1) });
  return new Ramp(stops);
}

// ------------------------------------------------------- colour operations

const _hsl = { h: 0, s: 0, l: 0 };

/**
 * Colour temperature shift. `amount` in [-1, 1] — negative is cooler (toward
 * ~4000 K blue), positive warmer (toward ~9000 K amber). Luminance is preserved
 * exactly, so a temperature push never changes the exposure of a shot; it only
 * changes its mood. That separation is why grading and lighting can be tuned
 * independently.
 */
export function temperatureShift(hex, amount, strength = 1) {
  const lin = hexToLinear(hex, [0, 0, 0]);
  const before = luminance(lin[0], lin[1], lin[2]);
  const k = 6500 * Math.pow(2, -amount * 0.85);
  const w = kelvinToLinear(k, [0, 0, 0]);
  const r = lin[0] * (1 + (w[0] - 1) * strength);
  const g = lin[1] * (1 + (w[1] - 1) * strength);
  const b = lin[2] * (1 + (w[2] - 1) * strength);
  const after = luminance(r, g, b) || 1e-6;
  const s = before / after;
  return linearToHex(r * s, g * s, b * s);
}

/**
 * Blackbody colour at `kelvin`, normalised to unit luminance, in linear space.
 * Tanner Helland's piecewise fit — accurate to a couple of percent across
 * 1000–12000 K, which is well inside what a tonemapped frame can show.
 */
export function kelvinToLinear(kelvin, out = [0, 0, 0]) {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const rl = srgbToLinear(Math.min(255, Math.max(0, r)) / 255);
  const gl = srgbToLinear(Math.min(255, Math.max(0, g)) / 255);
  const bl = srgbToLinear(Math.min(255, Math.max(0, b)) / 255);
  const y = luminance(rl, gl, bl) || 1e-6;
  out[0] = rl / y;
  out[1] = gl / y;
  out[2] = bl / y;
  return out;
}

/**
 * Value-preserving hue rotation.
 *
 * Uses the luminance-preserving hue matrix (the same one SVG's `feColorMatrix
 * hueRotate` defines) rather than an HSL round trip: HSL's "lightness" is not
 * perceptual, so rotating hue in HSL swings a yellow to a blue of identical L
 * but half the apparent brightness — which is exactly how a palette drifts out
 * of the value structure §2.3 demands. Applied in linear space with an explicit
 * luminance renormalisation afterwards for the residual error.
 */
export function hueRotate(hex, degrees) {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const lin = hexToLinear(hex, [0, 0, 0]);
  const before = luminance(lin[0], lin[1], lin[2]);
  const m00 = 0.213 + c * 0.787 - s * 0.213;
  const m01 = 0.715 - c * 0.715 - s * 0.715;
  const m02 = 0.072 - c * 0.072 + s * 0.928;
  const m10 = 0.213 - c * 0.213 + s * 0.143;
  const m11 = 0.715 + c * 0.285 + s * 0.14;
  const m12 = 0.072 - c * 0.072 - s * 0.283;
  const m20 = 0.213 - c * 0.213 - s * 0.787;
  const m21 = 0.715 - c * 0.715 + s * 0.715;
  const m22 = 0.072 + c * 0.928 + s * 0.072;
  let r = m00 * lin[0] + m01 * lin[1] + m02 * lin[2];
  let g = m10 * lin[0] + m11 * lin[1] + m12 * lin[2];
  let b = m20 * lin[0] + m21 * lin[1] + m22 * lin[2];
  r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);
  const after = luminance(r, g, b) || 1e-6;
  const k = before / after;
  return linearToHex(r * k, g * k, b * k);
}

/**
 * Strip the value out of a colour and keep only its chromaticity, as a linear
 * triple normalised to unit Rec.709 luminance.
 *
 * The result is a *tint multiplier*: multiplying an albedo by it rotates the
 * hue without moving the surface's luminance, so a colour push cannot leak into
 * the value structure §2.3 pins down. `toonRamp` does this inline for its two
 * endpoints and the ground macro layer does it for its dry/damp tints — same
 * reason both times, so it lives here rather than twice.
 */
export function unitChroma(hex, out = [0, 0, 0]) {
  hexToLinear(hex, out);
  const y = luminance(out[0], out[1], out[2]) || 1e-6;
  out[0] /= y;
  out[1] /= y;
  out[2] /= y;
  return out;
}

/**
 * Linear channel ratio (min/max) that corresponds to an HSV saturation ceiling
 * on the *encoded* triple.
 *
 * `maxSat` in `SURFACE_SPEC` is authored the way an art director reads a colour
 * picker: HSV `S = 1 - min/max` on the sRGB values. The enforcement, though, has
 * to happen in linear light, because that is where the generators work and it is
 * the only space in which desaturating about the luminance axis leaves the
 * luminance alone. Over the mid-tones every ground surface lives in, the sRGB
 * transfer is well approximated by a 1/2.2 power, so `min/max` in sRGB is
 * `(min/max)^(1/2.2)` in linear and the ceiling inverts to `(1 - S)^2.2`.
 *
 * Approximate rather than exact on purpose. Measured against the real piecewise
 * transfer over the ground surfaces' luminance range, the realised saturation
 * lands about 0.01 above the authored ceiling — a third of a display unit on the
 * minority channel, and worth far less than a closed form is worth to a loop
 * that runs a million times per surface.
 */
export function saturationRatio(maxSat) {
  return Math.pow(1 - Math.min(1, Math.max(0, maxSat)), 2.2);
}

/**
 * Collapse a linear triple's chroma about its luminance axis until the channel
 * ratio clears `ratio` (from `saturationRatio`). Luminance is exactly preserved:
 * every channel moves along the line through the achromatic point, so the
 * Rec.709 weighted sum is unchanged and a value structure fitted beforehand
 * survives untouched.
 *
 * Solving for the scale rather than iterating: with `y` the luminance and the
 * extremes `lo`/`hi`, `y + k(lo - y) = ratio * (y + k(hi - y))` gives
 * `k = y(1 - ratio) / (ratio(hi - y) - (lo - y))`, whose denominator is strictly
 * positive whenever the colour is not already achromatic.
 *
 * @param {Float32Array|number[]} rgb linear triple, modified in place
 * @param {number} i index of the first channel
 * @param {number} ratio minimum permitted min/max channel ratio
 */
export function chromaClamp(rgb, i, ratio) {
  const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
  const hi = r > g ? (r > b ? r : b) : (g > b ? g : b);
  if (hi <= 1e-6) return;
  const lo = r < g ? (r < b ? r : b) : (g < b ? g : b);
  if (lo >= hi * ratio) return;
  const y = luminance(r, g, b);
  const denom = ratio * (hi - y) - (lo - y);
  if (denom <= 1e-9) return;
  const k = Math.min(1, Math.max(0, (y * (1 - ratio)) / denom));
  rgb[i] = y + (r - y) * k;
  rgb[i + 1] = y + (g - y) * k;
  rgb[i + 2] = y + (b - y) * k;
}

/**
 * Scale a colour's luminance by `k`, holding its chromaticity exactly.
 *
 * The companion to `saturate`: between them a colour family can be walked in
 * value and in chroma independently, which is the whole basis of deriving a
 * material's light and dark members from one authored colour instead of
 * eyedropping each of them separately and hoping they stay related.
 *
 * A gain that would clip the majority channel scales the whole triple down
 * instead of letting one channel saturate — clipping is a hue shift, and a hue
 * shift is precisely what this function exists to prevent.
 */
export function scaleValue(hex, k) {
  const lin = hexToLinear(hex, [0, 0, 0]);
  let r = lin[0] * k, g = lin[1] * k, b = lin[2] * k;
  const m = Math.max(r, g, b);
  if (m > 1) {
    r /= m; g /= m; b /= m;
  }
  return linearToHex(r, g, b);
}

/** Saturate (>1) or desaturate (<1) about the luminance axis, in linear light. */
export function saturate(hex, amount) {
  const lin = hexToLinear(hex, [0, 0, 0]);
  const y = luminance(lin[0], lin[1], lin[2]);
  return linearToHex(
    y + (lin[0] - y) * amount,
    y + (lin[1] - y) * amount,
    y + (lin[2] - y) * amount,
  );
}

/**
 * Enforce the §2.1 shadow rule on a colour destined for an ambient, hemisphere
 * or fill term: push it toward `SHADOW_TINT` until its saturation clears the
 * 0.15 floor. Lighting and every material's cavity tint run through this, which
 * is why no shadow in the game can be eyedropped as grey.
 */
export function applyShadowRule(hex, bias = 0.5) {
  let out = mixHex(hex, LIGHT.SHADOW_TINT, bias);
  const c = new THREE.Color();
  c.setHex(out, THREE.SRGBColorSpace);
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  if (_hsl.s < MIN_SHADOW_SATURATION) {
    // Still too neutral (a near-black or near-white input). Blend further
    // rather than boosting saturation, so hue stays inside ±8° of 206°.
    const extra = Math.min(0.95, (MIN_SHADOW_SATURATION - _hsl.s) * 4);
    out = mixHex(out, LIGHT.SHADOW_TINT, extra);
  }
  return out;
}

/**
 * §2.3 black crush: map 0 to a tinted floor instead of 0. Applied to any
 * generated albedo dark end so a large dark surface is teal-black, not dead.
 */
export function crushBlacks(hex, floor = 0.02) {
  const lin = hexToLinear(hex, [0, 0, 0]);
  const f = hexToLinear(TEAL_BLACK, [0, 0, 0]);
  return linearToHex(
    f[0] * floor + lin[0] * (1 - floor),
    f[1] * floor + lin[1] * (1 - floor),
    f[2] * floor + lin[2] * (1 - floor),
  );
}

/**
 * Rescale a linear RGB triple so its luminance lands inside `[lo, hi]`,
 * preserving chroma ratios. Textures.js applies this per texel against
 * `SURFACE_SPEC[key].albedo`, which is how the bible's albedo bands become a
 * guarantee rather than an aspiration.
 */
export function clampAlbedo(rgb, lo, hi) {
  const y = luminance(rgb[0], rgb[1], rgb[2]);
  if (y < 1e-5) {
    rgb[0] = rgb[1] = rgb[2] = lo;
    return rgb;
  }
  const target = y < lo ? lo : y > hi ? hi : y;
  const k = target / y;
  rgb[0] *= k;
  rgb[1] *= k;
  rgb[2] *= k;
  return rgb;
}

/** Convenience for lighting rigs: the fog pair as THREE.Colors. */
export function fogColors() {
  return { near: color(LIGHT.FOG_NEAR), far: color(LIGHT.FOG_FAR) };
}

/** Everything the palette exports, grouped, for debug overlays and tooling. */
export const PALETTE = Object.freeze({
  LIGHT, ELEMENT, TIME_KEYS, SURFACE_SPEC, SURFACE_TINT, GRADE, TEAL_BLACK, ENV_INTENSITY,
  MEADOW, LAWN_BLADE, MEADOW_BLADE, MEADOW_SOIL, MEADOW_DRY,
});
