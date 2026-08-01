/**
 * ToonMaterial — the character shading model.
 *
 * REFERENCE_TARGET §8.4 is the whole brief: "Character shading uses a custom
 * toon-ish material with rim light, not stock `MeshStandardMaterial`.
 * Environments may stay physically based." The *contrast* between the two is
 * load-bearing — it is a large part of why a 3.2-head chibi at eighty pixels
 * tall reads as a character rather than as another prop in the diorama — so
 * this module's job is not merely "make it flat", it is to hold the characters
 * in a different, legible shading language while they stand in, and are lit by,
 * the same physical rig as everything else.
 *
 * ## What this is, mechanically
 *
 * A `MeshStandardMaterial` whose direct BRDF has been replaced through
 * `onBeforeCompile`, and nothing else touched. The reasoning is written out at
 * the top of `shaders/toonSurface.js`; the short version is that the character
 * must inherit cascaded shadows from `render/Lighting.js` (which drives CSM and
 * therefore rewrites the lighting chunks globally), skinning, morph targets,
 * `FogExp2`, PMREM environment maps and ACES tone mapping — and each of those,
 * hand-rolled in a `ShaderMaterial`, is one more place the character can
 * silently drift out of agreement with the world it is standing in.
 *
 * `Lighting.registerMaterial` explicitly captures and chains a material's own
 * `onBeforeCompile` before installing CSM's, which is what makes this legal:
 * CSM's hook runs first, ours second, and neither depends on the other having
 * left a particular chunk in place.
 *
 * ## The six terms, and why each one exists
 *
 *  1. **A cel ramp with an explicit terminator.** N·L is not sliced into equal
 *     bands — the terminator is placed by position (default just above 0), so
 *     the lit side is one broad flat plateau at full key and the band count
 *     subdivides the *shadow* only. That is the difference between a cel look
 *     and a soft Lambert falloff with contours in it; see `toonCommon.js`.
 *  2. **A shadow albedo.** Inside the shadow band the surface colour itself
 *     shifts toward `SHADOW_TINT`, at `shadowMix` (~0.55 by default), with
 *     ART_BIBLE §2.1's saturation floor enforced on the result. A shadow built
 *     purely out of light terms can only travel toward black along the albedo's
 *     own hue line, which is exactly the "darkened desaturated albedo" the look
 *     must not have.
 *  3. **A tinted shadow fill**, layered over that: a warm-to-cool gradient
 *     covering the light deficit, including the deficit caused by a cast shadow,
 *     so form shadow and cast shadow land in the same coloured mass.
 *  4. **Rim.** Fresnel weighted by the rim light's direction so it concentrates
 *     on the back-lit edge, over a floor so the whole silhouette still separates
 *     from the background. REFERENCE_TARGET §1 makes this mandatory in every
 *     frame; ART_BIBLE §5.6 sizes it.
 *  5. **One highlight band**, compiled out entirely on the classes that must not
 *     have one (skin), and Kajiya-Kay anisotropic where the surface has a sweep
 *     direction (hair, blades) so it reads as a stripe following the sculpt
 *     rather than as a round plastic dot. The environment probe reaches
 *     dielectrics as irradiance only — never as a reflection-vector lookup,
 *     which is what produces the sliding mirror hotspot that reads as PBR.
 *  6. **Subsurface wrap**, so faces do not go dead on their shadow side — the
 *     single most common way an oversized chibi head stops reading.
 *
 * ## Contract for consumers
 *
 *   createToonMaterial({ preset, lighting, forge, ... }) -> THREE.MeshStandardMaterial
 *   updateToonUniforms(material, { time, rimColor, ... }) -> material
 *   createToonOutline(sourceMesh, { width, color, ... })  -> THREE.Mesh | THREE.SkinnedMesh
 *
 * Pass `{ lighting }` (the `Lighting` service) and the rig's key/rim uniforms
 * are *aliased*, not copied: the character's rim tracks the rim light that
 * casts it, every frame, at zero per-frame cost and with no possibility of the
 * two disagreeing. Pass `{ forge }` and the shadow gradient comes from
 * `Palette.toonRamp` via `AssetForge`.
 *
 * Nothing here allocates a GPU resource. Ramp textures belong to `AssetForge`
 * and are disposed with it; the materials and geometries this module returns
 * are the caller's to `dispose()`, and `createToonOutline` shares the source
 * geometry rather than cloning it, so the outline must never dispose it.
 *
 * OWNED BY: render/ToonMaterial.js.
 */
import * as THREE from 'three';
import { LIGHT, SURFACE_TINT, MIN_SHADOW_SATURATION, luminance } from '../art/Palette.js';
import {
  TOON_SURFACE_PARS,
  TOON_SURFACE_INIT,
  TOON_SURFACE_COMPOSITE,
} from './shaders/toonSurface.js';
import { TOON_OUTLINE_PARS, TOON_OUTLINE_PROJECT } from './shaders/toonOutline.js';

/* -------------------------------------------------------------------------- */
/* Colour helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A palette hex reduced to pure chromaticity and re-scaled to a chosen
 * luminance.
 *
 * Every "tint" uniform in this material is a *radiance*, not a swatch, and the
 * two are not interchangeable: `SHADOW_TINT #2E4A5F` has a linear luminance of
 * 0.063, so using it raw as a shadow radiance would make the shadow term's
 * strength an accident of how dark the designer happened to pick the swatch.
 * Separating hue from level means the art bible's hex stays authoritative for
 * *colour* while the level stays a tunable number — and it is the same move
 * `Palette.toonRamp` and `Lighting.mixChroma` make, for the same reason, so all
 * three agree about what a shadow looks like.
 */
function chromaAt(hex, level) {
  const c = hex instanceof THREE.Color ? hex.clone() : new THREE.Color(hex);
  const y = luminance(c.r, c.g, c.b) || 1e-6;
  return c.multiplyScalar(level / y);
}

/**
 * A palette hex reduced to pure chromaticity, normalised so its **largest**
 * channel is 1.
 *
 * Distinct from `chromaAt`, and the distinction matters. `chromaAt` produces a
 * *radiance* — something that is added to a light term, so it wants a luminance.
 * This produces a *reflectance* — something that multiplies incoming light, so
 * it must not exceed 1 in any channel or the surface would amplify the light
 * hitting it. Peak-normalising also means a shadow albedo built from it keeps
 * the value the band asked for, leaving hue and value independently controllable
 * (the same separation `Palette.toonRamp` makes, for the same reason).
 */
function chromaUnit(hex) {
  const c = hex instanceof THREE.Color ? hex.clone() : new THREE.Color(hex);
  return c.multiplyScalar(1 / (Math.max(c.r, c.g, c.b) || 1e-6));
}

/** Coerce a hex / `THREE.Color` / array into a fresh `THREE.Color`. */
function toColor(v) {
  if (v instanceof THREE.Color) return v.clone();
  if (Array.isArray(v)) return new THREE.Color(v[0], v[1], v[2]);
  return new THREE.Color(v);
}

/** Coerce a `THREE.Vector3` / array / `{x,y,z}` into a normalised direction. */
function toDirection(v, fallback) {
  const out = new THREE.Vector3();
  if (v instanceof THREE.Vector3) out.copy(v);
  else if (Array.isArray(v)) out.set(v[0], v[1], v[2]);
  else if (v && typeof v === 'object') out.set(v.x ?? 0, v.y ?? 0, v.z ?? 0);
  else return fallback.clone();
  return out.lengthSq() < 1e-8 ? fallback.clone() : out.normalize();
}

/** Coerce a `THREE.Vector2` / array / `{x,y}` pair. */
function toVec2(v, fallback) {
  if (v instanceof THREE.Vector2) return v.clone();
  if (Array.isArray(v)) return new THREE.Vector2(v[0], v[1]);
  if (v && typeof v === 'object') return new THREE.Vector2(v.x ?? fallback.x, v.y ?? fallback.y);
  return fallback.clone();
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Named surface classes.
 *
 * These exist so that six characters authored by different agents cannot end up
 * with six different opinions about what skin looks like. Roughness and
 * metalness are the midpoints of ART_BIBLE §4's bands.
 *
 * Reading the ramp fields:
 *
 *  - `terminator` — where the single decisive edge sits, **in N·L**. Values at
 *    or below zero put it on or past the geometric terminator, which is what
 *    makes the lit region "broad": on a sphere, `terminator = 0.06` still leaves
 *    the plateau covering ~85° either side of the light axis.
 *  - `softness` — the full width of that edge, in N·L. 0.08 is the house value.
 *  - `bands` / `bandSpacing` / `coreStep` — how the *shadow* subdivides. Never
 *    the lit side; a step above the terminator would put the gradient back.
 *  - `shadowMix` — how far the shadow band's albedo travels toward
 *    `SHADOW_TINT`. This is the coloured-shadow control, and it is a
 *    reflectance mix, not a light tint.
 *  - `envSpecular` — gain on the environment probe's specular contribution.
 *    Small for every dielectric class: a toon character drinking a
 *    full-strength probe stops looking hand-painted and starts looking like the
 *    environment reflected in a doll.
 *  - `specGain: 0` removes the highlight from the compiled program outright.
 *
 * `shadowLevel` and `warmLevel` are luminances, not swatch brightnesses — see
 * `chromaAt`. `subsurfaceLevel` 0 disables that term the same way.
 */
export const TOON_PRESETS = Object.freeze({
  generic: {
    bands: 3, terminator: 0.06, softness: 0.08, bandSpacing: 0.22,
    shadowStep: 0.0, coreStep: 0.38,
    shadowLevel: 0.17, warmLevel: 0.14, shadowWarmSpan: 0.45, shadowMix: 0.55,
    subsurfaceLevel: 0.0, subsurfaceWidth: 0.35,
    specColor: 0xffffff, specGain: 0.22, specExponent: 48, specThreshold: 0.45, specSoftness: 0.06,
    rimPower: 2.6, rimGain: 1.7, rimFloor: 0.35,
    roughness: 0.62, metalness: 0.0, envMapIntensity: 0.35, envSpecular: 0.15,
  },

  // The face is the read, and the reference reads it on eyes and brows over a
  // flat cream plane. So: two bands, the terminator pushed *behind* the
  // geometric one so the lit plateau wraps around the cheek, the widest
  // soft edge in the set, and no highlight at all. A specular lobe on a
  // near-spherical chibi cranium is a hotspot that slides with the camera and
  // reads as wet plastic — REFERENCE_TARGET §1 gives skin no gloss, so neither
  // does this. The subsurface band is the warmest in the set because §1 puts
  // 35–40% of the character's height in the head; a dead shadow side there is
  // 40% of the silhouette going flat.
  skin: {
    bands: 2, terminator: -0.02, softness: 0.10, bandSpacing: 0.24,
    shadowStep: 0.0, coreStep: 0.38,
    shadowLevel: 0.19, warmLevel: 0.16, shadowWarmSpan: 0.50, shadowMix: 0.58,
    subsurface: SURFACE_TINT.SKIN_RIM, subsurfaceLevel: 0.18, subsurfaceWidth: 0.55,
    specGain: 0.0,
    rimPower: 2.3, rimGain: 1.8, rimFloor: 0.40,
    roughness: 0.46, metalness: 0.0, envMapIntensity: 0.30, envSpecular: 0.08,
  },

  // "Bold sculpted hair silhouettes [...] reads as carved volume with a glossy
  // highlight band" (REFERENCE_TARGET §1). One band, and it is a *band*: the
  // Kajiya-Kay lobe is constant along the sweep axis and falls off across it, so
  // a high exponent under a tight threshold cuts a hard-edged stripe following
  // the sculpt. A low exponent would smear the same stripe into the broad gloss
  // this preset used to have, which is the "polished plastic" read. Spec tint is
  // §4's silk value.
  hair: {
    bands: 3, terminator: 0.12, softness: 0.07, bandSpacing: 0.20,
    shadowStep: 0.0, coreStep: 0.42,
    shadowLevel: 0.16, warmLevel: 0.13, shadowWarmSpan: 0.40, shadowMix: 0.56,
    subsurfaceLevel: 0.0, subsurfaceWidth: 0.35,
    specColor: SURFACE_TINT.SILK_SPEC, specGain: 1.15, specExponent: 56,
    specThreshold: 0.55, specSoftness: 0.035,
    aniso: true, anisoShift: 0.16,
    rimPower: 2.8, rimGain: 2.2, rimFloor: 0.32,
    roughness: 0.40, metalness: 0.0, envMapIntensity: 0.35, envSpecular: 0.10,
  },

  // Cloth keeps a whisper of sheen — §4's "sheen colour = albedo lightened 20%"
  // — but spread wide and weak. A tight highlight on a coat reads as vinyl.
  cloth: {
    bands: 3, terminator: 0.06, softness: 0.09, bandSpacing: 0.22,
    shadowStep: 0.0, coreStep: 0.36,
    shadowLevel: 0.18, warmLevel: 0.15, shadowWarmSpan: 0.45, shadowMix: 0.55,
    subsurfaceLevel: 0.0, subsurfaceWidth: 0.35,
    specColor: 0xffffff, specGain: 0.06, specExponent: 16, specThreshold: 0.50, specSoftness: 0.20,
    rimPower: 2.4, rimGain: 1.5, rimFloor: 0.38,
    roughness: 0.85, metalness: 0.0, envMapIntensity: 0.25, envSpecular: 0.10,
  },

  leather: {
    bands: 3, terminator: 0.06, softness: 0.08, bandSpacing: 0.22,
    shadowStep: 0.0, coreStep: 0.38,
    shadowLevel: 0.17, warmLevel: 0.14, shadowWarmSpan: 0.42, shadowMix: 0.55,
    subsurfaceLevel: 0.0, subsurfaceWidth: 0.35,
    specColor: 0xffffff, specGain: 0.16, specExponent: 40, specThreshold: 0.42, specSoftness: 0.08,
    rimPower: 2.6, rimGain: 1.6, rimFloor: 0.35,
    roughness: 0.60, metalness: 0.0, envMapIntensity: 0.30, envSpecular: 0.14,
  },

  // §1: "metal (armour, blades) reads through a hard specular band rather than
  // environment reflection". Two bands and a tight, bright highlight; the
  // anisotropy is §4's "metal must show anisotropic highlight direction", and
  // callers holding a weapon should push its blade axis through
  // `updateToonUniforms(mat, { anisoDirection })` each frame. Metal is the one
  // class allowed a real probe reflection, and even there it arrives quantised
  // into plates rather than as a mirror.
  metal: {
    bands: 2, terminator: 0.04, softness: 0.05, bandSpacing: 0.26,
    shadowStep: 0.0, coreStep: 0.40,
    shadowLevel: 0.14, warmLevel: 0.11, shadowWarmSpan: 0.35, shadowMix: 0.48,
    subsurfaceLevel: 0.0, subsurfaceWidth: 0.35,
    specColor: 0xffffff, specGain: 2.0, specExponent: 110, specThreshold: 0.42, specSoftness: 0.05,
    aniso: true, anisoShift: 0.05,
    rimPower: 3.0, rimGain: 2.4, rimFloor: 0.30,
    roughness: 0.42, metalness: 1.0, envMapIntensity: 1.0, envSpecular: 0.85,
  },

  // §1 again: "simple bright iris + dark outline + a specular catch-light".
  // The catch-light is the entire point of this preset — a pinpoint highlight
  // hot enough to clear the bloom threshold on its own. `shadowMix` is nearly
  // off: an iris that turns teal on the shadow side of the face stops being the
  // saturated colour the whole character reads on.
  eye: {
    bands: 2, terminator: -0.25, softness: 0.14, bandSpacing: 0.30,
    shadowStep: 0.0, coreStep: 0.30,
    shadowLevel: 0.10, warmLevel: 0.09, shadowWarmSpan: 0.30, shadowMix: 0.15,
    subsurfaceLevel: 0.0, subsurfaceWidth: 0.35,
    specColor: 0xffffff, specGain: 3.0, specExponent: 220, specThreshold: 0.60, specSoftness: 0.04,
    rimPower: 3.4, rimGain: 1.2, rimFloor: 0.20,
    roughness: 0.20, metalness: 0.0, envMapIntensity: 0.20, envSpecular: 0.30,
  },

  // §4 crystal: interior glow is the caller's `emissive`; this supplies the
  // mandatory fresnel rim and a hard highlight over the top of it.
  crystal: {
    bands: 2, terminator: -0.05, softness: 0.10, bandSpacing: 0.24,
    shadowStep: 0.0, coreStep: 0.34,
    shadowLevel: 0.15, warmLevel: 0.12, shadowWarmSpan: 0.35, shadowMix: 0.40,
    subsurfaceLevel: 0.0, subsurfaceWidth: 0.35,
    specColor: 0xffffff, specGain: 1.4, specExponent: 120, specThreshold: 0.40, specSoftness: 0.06,
    rimPower: 1.6, rimGain: 2.6, rimFloor: 0.30,
    roughness: 0.10, metalness: 0.0, envMapIntensity: 1.0, envSpecular: 1.0,
  },
});

/** Rim focus window on `dot(N, rimDir)`. The negative floor is deliberate: a
 *  surface may face slightly *away* from the rim and still show its wrap, which
 *  is what stops the band from terminating in a visible hard edge halfway round
 *  a cylinder. The ceiling stays well under 1 so the band saturates before the
 *  surface turns fully toward the light and the fresnel has already died. */
const DEFAULT_RIM_FOCUS = new THREE.Vector2(-0.50, 0.35);

/** Window applied to fresnel × focus. Opens at 0.05 rather than 0 to kill the
 *  long low tail `pow()` leaves across the facing side — that tail is what
 *  turns a rim into a wash. Closes at 0.5 so the band reaches full strength in
 *  the outer quarter of the silhouette and stays soft-edged getting there. */
const DEFAULT_RIM_SHAPE = new THREE.Vector2(0.05, 0.50);

/** Default anisotropy axis: world up. Hair falls, blades are worn vertically,
 *  and armour brushing runs with the body — world +Y is right far more often
 *  than it is wrong, and the exceptions are per-frame overrides anyway. */
const DEFAULT_ANISO_DIR = new THREE.Vector3(0, 1, 0);

/** Uniform names aliased from `Lighting.uniforms` when a rig is supplied. These
 *  are rig state, not art state; the spelling must match `Lighting` exactly or
 *  the aliasing silently degrades into private copies nobody updates. */
const RIG_UNIFORMS = ['uKeyColor', 'uRimDirection', 'uRimColor', 'uRimStrength'];

/** The shadow-region hue, as a reflectance. ART_BIBLE §2.1 names the swatch;
 *  peak-normalising turns it into something that can multiply light without
 *  amplifying it, and leaves its value to the band. */
const SHADOW_ALBEDO = chromaUnit(LIGHT.SHADOW_TINT);

/**
 * Saturation the shadow albedo is held at or above.
 *
 * §2.1 sets the legal minimum at `MIN_SHADOW_SATURATION` (0.15). That is a
 * *floor*, and a shadow sitting exactly on it still eyedrops as a grey with a
 * faint cast — which is the observation the rule is trying to prevent, so
 * targeting the floor itself defeats it. The margin also has to clear the point
 * where the albedo→tint line crosses the neutral axis (mix ≈ 0.52 for skin
 * tones), or the guard in `awToonShadowAlbedo` would be inert exactly where it
 * is needed.
 */
const SHADOW_SAT_TARGET = Math.max(MIN_SHADOW_SATURATION, 0.22);

/* -------------------------------------------------------------------------- */
/* Surface material                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build a toon-shaded character material.
 *
 * @param {Object} [opts]
 * @param {string} [opts.preset='generic'] key into {@link TOON_PRESETS}.
 * @param {import('./Lighting.js').Lighting|{uniforms:Object}} [opts.lighting]
 *   the lighting rig (or anything exposing its `uniforms` block). Supplying it
 *   aliases the key/rim uniforms so they track the rig for free.
 * @param {{texture:Function}} [opts.forge] `AssetForge`; used to fetch the
 *   `ramp-toon-<bands>` shadow gradient. Ignored if `rampMap` is given.
 * @param {THREE.Texture|null} [opts.rampMap] explicit shadow-gradient ramp.
 * @param {THREE.ColorRepresentation} [opts.color=0xffffff] base albedo.
 * @param {THREE.Texture} [opts.map] / [opts.normalMap] / [opts.roughnessMap] /
 *   [opts.metalnessMap] / [opts.aoMap] / [opts.alphaMap] / [opts.emissiveMap]
 * @param {number} [opts.bands] 2–4. Subdivides the shadow side only.
 * @param {number} [opts.terminator] position of the main edge, in N·L.
 * @param {number} [opts.softness] full width of that edge, in N·L.
 * @param {number} [opts.shadowMix] 0–1, how far the shadow albedo shifts toward
 *   `SHADOW_TINT`.
 * @param {number} [opts.envSpecular] gain on the environment probe's specular.
 * @param {boolean} [opts.aniso] force the anisotropic specular on or off.
 * @param {THREE.Vector3} [opts.anisoDirection] world-space sheen axis.
 * @returns {THREE.MeshStandardMaterial} patched, ready to add to a scene.
 */
export function createToonMaterial(opts = {}) {
  const presetName = opts.preset && TOON_PRESETS[opts.preset] ? opts.preset : 'generic';
  const p = { ...TOON_PRESETS.generic, ...TOON_PRESETS[presetName] };

  const bands = THREE.MathUtils.clamp(Math.round(opts.bands ?? p.bands), 2, 4);
  const specGain = opts.specGain ?? p.specGain ?? 0;
  // A zero-gain highlight is not the same thing as no highlight. The classes the
  // reference gives no gloss (skin above all) must not merely multiply the lobe
  // by zero — the term drops out of the compiled program, so it cannot come back
  // through a stray `updateToonUniforms` and cannot cost a `pow()` per light per
  // fragment on the largest surface in frame.
  const hasSpec = specGain > 0;
  const aniso = hasSpec && (opts.aniso ?? p.aniso ?? false);

  // The ramp is chroma-only (see `awToonTint`), so a mismatch between its band
  // count and `bands` is cosmetic rather than broken — but matching them keeps
  // the ramp's colour steps landing on the band plateaus instead of across
  // their terminators, which is the difference between a coloured shadow and a
  // faintly iridescent one.
  let rampMap = opts.rampMap ?? null;
  if (!rampMap && opts.forge?.texture) {
    rampMap = opts.forge.texture(`ramp-toon-${bands}`, { bands });
  }

  const material = new THREE.MeshStandardMaterial({
    name: opts.name ?? `toon:${presetName}`,
    color: opts.color ?? 0xffffff,
    map: opts.map ?? null,
    normalMap: opts.normalMap ?? null,
    normalScale: opts.normalScale ?? new THREE.Vector2(1, 1),
    roughnessMap: opts.roughnessMap ?? null,
    metalnessMap: opts.metalnessMap ?? null,
    aoMap: opts.aoMap ?? null,
    aoMapIntensity: opts.aoMapIntensity ?? 1.0,
    alphaMap: opts.alphaMap ?? null,
    emissive: opts.emissive ?? 0x000000,
    emissiveMap: opts.emissiveMap ?? null,
    emissiveIntensity: opts.emissiveIntensity ?? 1.0,
    // Where a map exists, three multiplies the scalar by it, so 1.0 lets the
    // baked value through unchanged — the same convention `AssetForge.material`
    // documents, and deviating from it here would make the two disagree about
    // what `roughness: 0.6` means.
    roughness: opts.roughness ?? (opts.roughnessMap ? 1.0 : p.roughness),
    metalness: opts.metalness ?? (opts.metalnessMap ? 1.0 : p.metalness),
    envMapIntensity: opts.envMapIntensity ?? p.envMapIntensity,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1.0,
    alphaTest: opts.alphaTest ?? 0.0,
    side: opts.side ?? THREE.FrontSide,
    flatShading: opts.flatShading ?? false,
    vertexColors: opts.vertexColors ?? false,
    fog: opts.fog ?? true,
    // Banded shading puts large near-flat regions on screen, which is exactly
    // where 8-bit quantisation shows as contouring. The cost is one hash per
    // fragment and it removes a defect the post chain's grain would otherwise
    // have to hide.
    dithering: opts.dithering ?? true,
    toneMapped: opts.toneMapped ?? true,
  });

  const rig = opts.lighting?.uniforms ?? (opts.lighting?.uKeyColor ? opts.lighting : null);

  /** @type {Record<string, {value:*}>} */
  const uniforms = {
    // ---- rig-facing (aliased when a Lighting instance is supplied) --------
    uKeyColor: { value: new THREE.Color(1, 1, 1).multiplyScalar(3) },
    uRimDirection: { value: new THREE.Vector3(-0.5, 0.45, -0.74).normalize() },
    uRimColor: { value: chromaAt(LIGHT.RING_GLOW, 0.45) },
    uRimStrength: { value: 1.0 },

    // ---- the cel ramp -----------------------------------------------------
    uToonBands: { value: bands },
    uToonTerminator: { value: opts.terminator ?? p.terminator },
    uToonSoftness: { value: opts.softness ?? p.softness },
    uToonBandSpacing: { value: opts.bandSpacing ?? p.bandSpacing },
    uToonShadowStep: { value: opts.shadowStep ?? p.shadowStep },
    uToonCoreStep: { value: opts.coreStep ?? p.coreStep },
    uToonRamp: { value: rampMap },

    // ---- shadow colour (ART_BIBLE §2.1) -----------------------------------
    uToonShadowDeep: {
      value: chromaAt(opts.shadowColor ?? LIGHT.SHADOW_TINT, opts.shadowLevel ?? p.shadowLevel),
    },
    uToonShadowWarm: {
      value: chromaAt(opts.shadowWarm ?? LIGHT.BOUNCE_GROUND, opts.warmLevel ?? p.warmLevel),
    },
    uToonShadowGain: { value: opts.shadowGain ?? 1.0 },
    uToonShadowWarmSpan: { value: opts.shadowWarmSpan ?? p.shadowWarmSpan },
    uToonShadowAlbedo: {
      value: opts.shadowAlbedo !== undefined ? chromaUnit(opts.shadowAlbedo) : SHADOW_ALBEDO.clone(),
    },
    uToonShadowMix: { value: opts.shadowMix ?? p.shadowMix },
    // Enforced in the shader rather than left to an author to remember: a warm
    // albedo lerped halfway to a cool tint passes through the neutral axis, so
    // the rule has to hold where the mix happens.
    uToonShadowSatFloor: { value: opts.shadowSatFloor ?? SHADOW_SAT_TARGET },

    // ---- subsurface -------------------------------------------------------
    uToonSubsurface: {
      value: chromaAt(opts.subsurface ?? p.subsurface ?? SURFACE_TINT.SKIN_RIM,
        opts.subsurfaceLevel ?? p.subsurfaceLevel),
    },
    uToonSubsurfaceWidth: { value: opts.subsurfaceWidth ?? p.subsurfaceWidth },

    // ---- specular ---------------------------------------------------------
    uToonSpecColor: { value: toColor(opts.specColor ?? p.specColor ?? 0xffffff) },
    uToonSpecGain: { value: specGain },
    uToonSpecExponent: { value: opts.specExponent ?? p.specExponent ?? 48 },
    uToonSpecThreshold: { value: opts.specThreshold ?? p.specThreshold ?? 0.45 },
    uToonSpecSoftness: { value: opts.specSoftness ?? p.specSoftness ?? 0.06 },
    uToonEnvSpecular: { value: opts.envSpecular ?? p.envSpecular },

    // ---- rim --------------------------------------------------------------
    uToonRimPower: { value: opts.rimPower ?? p.rimPower },
    uToonRimGain: { value: opts.rimGain ?? p.rimGain },
    uToonRimFocus: { value: toVec2(opts.rimFocus, DEFAULT_RIM_FOCUS) },
    uToonRimShape: { value: toVec2(opts.rimShape, DEFAULT_RIM_SHAPE) },
    uToonRimFloor: { value: opts.rimFloor ?? p.rimFloor },

    // ---- battle feedback --------------------------------------------------
    uToonPulse: { value: toColor(opts.pulse ?? 0x000000) },
    uToonPulseRate: { value: opts.pulseRate ?? 0.0 },
    uToonTime: { value: 0.0 },

    // ---- anisotropy -------------------------------------------------------
    uToonAnisoDirection: { value: toDirection(opts.anisoDirection, DEFAULT_ANISO_DIR) },
    uToonAnisoShift: { value: opts.anisoShift ?? p.anisoShift ?? 0.12 },
  };

  // Levels are remembered so a later `updateToonUniforms({ shadowColor })` can
  // re-derive the radiance the same way the constructor did, instead of
  // dumping a raw swatch into a uniform that expects a radiance.
  const levels = {
    shadow: opts.shadowLevel ?? p.shadowLevel,
    warm: opts.warmLevel ?? p.warmLevel,
    subsurface: opts.subsurfaceLevel ?? p.subsurfaceLevel,
  };

  const shared = new Set();
  if (rig) {
    for (const name of RIG_UNIFORMS) {
      if (rig[name]) {
        uniforms[name] = rig[name];
        shared.add(name);
      }
    }
  }
  if (opts.rimColor !== undefined) privatiseUniform(uniforms, shared, 'uRimColor', toColor(opts.rimColor));
  if (opts.rimStrength !== undefined) privatiseUniform(uniforms, shared, 'uRimStrength', opts.rimStrength);

  material.defines = { ...(material.defines ?? {}) };
  if (rampMap) material.defines.TOON_RAMP_MAP = '';
  if (hasSpec) material.defines.TOON_SPECULAR = '';
  if (aniso) material.defines.TOON_ANISO = '';

  material.userData.toon = { kind: 'surface', uniforms, levels, shared, preset: presetName };
  material.userData.isToonMaterial = true;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.toon.uniforms);
    shader.fragmentShader = injectAfter(shader.fragmentShader, [
      ['#include <lights_physical_pars_fragment>', TOON_SURFACE_PARS],
      ['#include <lights_physical_fragment>', TOON_SURFACE_INIT],
      ['#include <lights_fragment_end>', TOON_SURFACE_COMPOSITE],
    ], material.name);
    material.userData.toonShader = shader;
  };

  // Without this, three's program cache keys a toon material and a plain
  // `MeshStandardMaterial` with the same defines to the *same* compiled
  // program, because `onBeforeCompile` is not part of the key. The first one
  // compiled wins and the other renders with someone else's BRDF — a bug that
  // presents as "characters look fine until you walk past a rock".
  const cacheKey = `aw-toon-surface|${presetName}|${rampMap ? 'ramp' : 'analytic'}`
    + `|${hasSpec ? (aniso ? 'aniso' : 'iso') : 'nospec'}`;
  material.customProgramCacheKey = () => cacheKey;

  return material;
}

/**
 * Apply a list of `[anchor, block]` injections, appending each block after its
 * anchor. Uses a function replacer so a `$` in the GLSL can never be read as a
 * `String.replace` substitution pattern, and reports a missing anchor loudly —
 * a silently skipped injection means the character renders as plain PBR, which
 * is subtle enough on one mesh to survive a review.
 */
function injectAfter(source, pairs, label) {
  let out = source;
  for (const [anchor, block] of pairs) {
    if (out.indexOf(anchor) === -1) {
      console.error(`[ToonMaterial] anchor "${anchor}" missing from ${label}; toon shading incomplete.`);
      continue;
    }
    out = out.replace(anchor, () => `${anchor}\n${block}`);
  }
  return out;
}

/**
 * Replace an aliased rig uniform with a private one.
 *
 * Writing through a shared uniform object would retint every other character
 * built against the same rig, so an override has to break the alias first. If
 * the material has already compiled, the swap needs a program rebuild: three
 * captures the uniform *objects* into `materialProperties.uniformsList` when
 * the program is built, so replacing the entry afterwards would be ignored.
 */
function privatiseUniform(uniforms, shared, name, value) {
  if (!shared.has(name)) {
    if (uniforms[name].value instanceof THREE.Color && value instanceof THREE.Color) {
      uniforms[name].value.copy(value);
    } else if (uniforms[name].value instanceof THREE.Vector3 && value instanceof THREE.Vector3) {
      uniforms[name].value.copy(value);
    } else {
      uniforms[name].value = value;
    }
    return false;
  }
  uniforms[name] = { value };
  shared.delete(name);
  return true;
}

/** True for anything this module produced. */
export function isToonMaterial(material) {
  return !!material?.userData?.isToonMaterial;
}

/* -------------------------------------------------------------------------- */
/* Uniform updates                                                            */
/* -------------------------------------------------------------------------- */

/** Scalar options that map straight onto a uniform. */
const SCALAR_KEYS = Object.freeze({
  time: 'uToonTime',
  bands: 'uToonBands',
  terminator: 'uToonTerminator',
  softness: 'uToonSoftness',
  bandSpacing: 'uToonBandSpacing',
  shadowStep: 'uToonShadowStep',
  coreStep: 'uToonCoreStep',
  shadowGain: 'uToonShadowGain',
  shadowWarmSpan: 'uToonShadowWarmSpan',
  shadowMix: 'uToonShadowMix',
  shadowSatFloor: 'uToonShadowSatFloor',
  subsurfaceWidth: 'uToonSubsurfaceWidth',
  specExponent: 'uToonSpecExponent',
  specThreshold: 'uToonSpecThreshold',
  specSoftness: 'uToonSpecSoftness',
  envSpecular: 'uToonEnvSpecular',
  rimPower: 'uToonRimPower',
  rimGain: 'uToonRimGain',
  rimFloor: 'uToonRimFloor',
  pulseRate: 'uToonPulseRate',
  anisoShift: 'uToonAnisoShift',
  outlineWidth: 'uOutlineWidth',
});

/** Colour options written verbatim as radiance. */
const COLOR_KEYS = Object.freeze({
  keyColor: 'uKeyColor',
  specColor: 'uToonSpecColor',
  pulse: 'uToonPulse',
});

/** Colour options whose swatch is separated from its level by `chromaAt`. */
const CHROMA_KEYS = Object.freeze({
  shadowColor: ['uToonShadowDeep', 'shadow'],
  shadowWarm: ['uToonShadowWarm', 'warm'],
  subsurface: ['uToonSubsurface', 'subsurface'],
});

/**
 * Push art or runtime state into a material built by this module.
 *
 * Safe to call every frame — it touches only the keys present in `opts` and
 * allocates nothing on the scalar and vector paths. Safe to call on a material
 * that has not compiled yet.
 *
 * Two behaviours are worth knowing about. Writing `rimColor` / `rimStrength` /
 * `keyColor` on a material that was built with `{ lighting }` **breaks the
 * alias to the rig** for that uniform and triggers one program rebuild; the
 * material then keeps the value you gave it and stops tracking time of day.
 * That is almost always what an author who reaches for the override wants, but
 * it is not free, so do not do it per frame. Writing `rampMap` toggles a define
 * and therefore also rebuilds.
 *
 * @param {THREE.Material} material
 * @param {Object} opts
 * @param {number} [opts.time] seconds; drives the `pulse` channel.
 * @param {THREE.ColorRepresentation} [opts.rimColor]
 * @param {THREE.Vector3} [opts.rimDirection] world space, toward the light.
 * @param {THREE.Vector3} [opts.anisoDirection] world space sheen axis.
 * @param {THREE.ColorRepresentation} [opts.pulse] additive battle-feedback tint.
 * @param {THREE.Texture|null} [opts.rampMap]
 * @returns {THREE.Material} the same material, for chaining.
 */
export function updateToonUniforms(material, opts = {}) {
  const toon = material?.userData?.toon;
  if (!toon) return material;
  const u = toon.uniforms;
  const shared = toon.shared;

  for (const key in SCALAR_KEYS) {
    const v = opts[key];
    if (v === undefined) continue;
    const name = SCALAR_KEYS[key];
    if (u[name]) u[name].value = v;
  }

  for (const key in COLOR_KEYS) {
    const v = opts[key];
    if (v === undefined) continue;
    const name = COLOR_KEYS[key];
    if (!u[name]) continue;
    if (privatiseUniform(u, shared, name, toColor(v))) material.needsUpdate = true;
  }

  for (const key in CHROMA_KEYS) {
    const v = opts[key];
    if (v === undefined) continue;
    const [name, levelKey] = CHROMA_KEYS[key];
    if (!u[name]) continue;
    const level = opts[`${levelKey}Level`] ?? toon.levels[levelKey];
    toon.levels[levelKey] = level;
    u[name].value.copy(chromaAt(v, level));
  }

  if (opts.rimColor !== undefined && u.uRimColor) {
    if (privatiseUniform(u, shared, 'uRimColor', toColor(opts.rimColor))) material.needsUpdate = true;
  }
  if (opts.rimStrength !== undefined && u.uRimStrength) {
    if (privatiseUniform(u, shared, 'uRimStrength', opts.rimStrength)) material.needsUpdate = true;
  }
  if (opts.rimDirection !== undefined && u.uRimDirection) {
    const dir = toDirection(opts.rimDirection, DEFAULT_ANISO_DIR);
    if (privatiseUniform(u, shared, 'uRimDirection', dir)) material.needsUpdate = true;
  }
  if (opts.anisoDirection !== undefined && u.uToonAnisoDirection) {
    u.uToonAnisoDirection.value.copy(toDirection(opts.anisoDirection, DEFAULT_ANISO_DIR));
  }
  if (opts.shadowAlbedo !== undefined && u.uToonShadowAlbedo) {
    u.uToonShadowAlbedo.value.copy(chromaUnit(opts.shadowAlbedo));
  }

  // `specGain` crossing zero adds or removes the highlight from the program, so
  // it cannot go through `SCALAR_KEYS`. Anisotropy rides along: the tangent
  // frame is only ever consumed by the highlight, so a material without one has
  // no use for `TOON_ANISO` and should not pay to compile it.
  if (opts.specGain !== undefined && u.uToonSpecGain) {
    const had = u.uToonSpecGain.value > 0;
    u.uToonSpecGain.value = opts.specGain;
    const has = opts.specGain > 0;
    if (had !== has) {
      material.defines = { ...(material.defines ?? {}) };
      if (has) material.defines.TOON_SPECULAR = '';
      else { delete material.defines.TOON_SPECULAR; delete material.defines.TOON_ANISO; }
      material.needsUpdate = true;
    }
  }

  if (opts.rimFocus !== undefined && u.uToonRimFocus) {
    u.uToonRimFocus.value.copy(toVec2(opts.rimFocus, DEFAULT_RIM_FOCUS));
  }
  if (opts.rimShape !== undefined && u.uToonRimShape) {
    u.uToonRimShape.value.copy(toVec2(opts.rimShape, DEFAULT_RIM_SHAPE));
  }

  // The outline's colour is a material property rather than a uniform, because
  // it is `MeshBasicMaterial.color` and hijacking that uniform object would
  // fight three's own `refreshUniformsCommon`.
  if (opts.outlineColor !== undefined && material.color) {
    material.color.copy(toColor(opts.outlineColor));
  }

  if (opts.rampMap !== undefined && u.uToonRamp) {
    const had = !!u.uToonRamp.value;
    u.uToonRamp.value = opts.rampMap ?? null;
    if (had !== !!u.uToonRamp.value) {
      material.defines = { ...(material.defines ?? {}) };
      if (u.uToonRamp.value) material.defines.TOON_RAMP_MAP = '';
      else delete material.defines.TOON_RAMP_MAP;
      material.needsUpdate = true;
    }
  }

  return material;
}

/* -------------------------------------------------------------------------- */
/* Inverted-hull outline                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Default line weight, as a fraction of viewport height.
 *
 * 0.0014 is ~1.5 px at 1080p and ~2 px at 1440p. REFERENCE_TARGET §1 calls for
 * soft edges, not ink: the outline's job here is to stop a chibi's chin
 * dissolving into a same-value background at eighty pixels tall, and anything
 * heavier than two pixels starts reading as a cartoon border instead of a
 * drawn edge.
 */
const DEFAULT_OUTLINE_WIDTH = 0.0014;

/**
 * The outline colour: `SHADOW_TINT` at a low level, not black.
 *
 * A black outline is the fastest way to break ART_BIBLE §2.3's crushed-but-
 * tinted value floor, because it would be the only true black in frame and it
 * would be sitting on the subject. Tinting toward the shadow colour also means
 * the line reads as the character's own deepest shade wrapping the silhouette,
 * which is what a painted edge does.
 */
const DEFAULT_OUTLINE_LEVEL = 0.035;

/**
 * Build the material for an inverted-hull outline.
 *
 * @param {Object} [opts]
 * @param {number} [opts.width=0.0014] fraction of viewport height.
 * @param {THREE.ColorRepresentation} [opts.color] outline colour; defaults to
 *   `SHADOW_TINT` at {@link DEFAULT_OUTLINE_LEVEL}.
 * @param {number} [opts.level] luminance for the default colour.
 * @param {boolean} [opts.fog=true]
 * @returns {THREE.MeshBasicMaterial}
 */
export function createToonOutlineMaterial(opts = {}) {
  const color = opts.color !== undefined
    ? toColor(opts.color)
    : chromaAt(LIGHT.SHADOW_TINT, opts.level ?? DEFAULT_OUTLINE_LEVEL);

  const material = new THREE.MeshBasicMaterial({
    name: opts.name ?? 'toon:outline',
    color,
    // BackSide is the hull; FrontSide culling is what makes the shell visible
    // only where it pokes out past the silhouette.
    side: THREE.BackSide,
    fog: opts.fog ?? true,
    // Opaque and depth-writing. A transparent outline would need sorting
    // against the character it wraps, and would show the seam wherever the
    // shell self-overlaps on a concave part like an armpit.
    transparent: false,
    depthWrite: true,
    toneMapped: true,
  });

  const uniforms = { uOutlineWidth: { value: opts.width ?? DEFAULT_OUTLINE_WIDTH } };
  material.userData.toon = { kind: 'outline', uniforms, levels: {}, shared: new Set() };
  material.userData.isToonMaterial = true;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.toon.uniforms);
    shader.vertexShader = TOON_OUTLINE_PARS + shader.vertexShader;
    if (shader.vertexShader.indexOf('#include <project_vertex>') === -1) {
      console.error('[ToonMaterial] outline anchor missing; outline will not offset.');
    } else {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>', () => TOON_OUTLINE_PROJECT,
      );
    }
    material.userData.toonShader = shader;
  };

  material.customProgramCacheKey = () => 'aw-toon-outline';
  return material;
}

/**
 * Attach an inverted-hull outline to a mesh.
 *
 * The hull is added as a **child of the source with an identity local matrix**,
 * which is the only arrangement that is correct for both cases: a static mesh
 * inherits the source's world transform exactly, and a `SkinnedMesh` — which
 * three transforms through its bind matrix and skeleton rather than through its
 * own world matrix — ends up sharing the source's skeleton, bind matrix and
 * bind mode, so the hull deforms with the animation instead of drifting off it.
 * Cloning the geometry would double the vertex memory of every character in the
 * party for no benefit, so it is shared; `disposeToonOutline` therefore
 * disposes the material only.
 *
 * @param {THREE.Mesh} source
 * @param {Object} [opts] forwarded to {@link createToonOutlineMaterial}, plus
 *   `material` to supply a shared one.
 * @returns {THREE.Mesh|THREE.SkinnedMesh|null} null if `source` has no geometry.
 */
export function createToonOutline(source, opts = {}) {
  if (!source?.geometry) return null;
  const material = opts.material ?? createToonOutlineMaterial(opts);
  const ownsMaterial = !opts.material;

  let outline;
  if (source.isSkinnedMesh) {
    outline = new THREE.SkinnedMesh(source.geometry, material);
    outline.bindMode = source.bindMode;
    outline.bind(source.skeleton, source.bindMatrix);
  } else {
    outline = new THREE.Mesh(source.geometry, material);
  }

  outline.name = `${source.name || 'mesh'}::outline`;
  // The hull is a shading trick, not an occluder: casting from it would thicken
  // every contact shadow by the outline width, and receiving would band the
  // line where the key crosses it.
  outline.castShadow = false;
  outline.receiveShadow = false;
  // Local transform stays identity, so `matrixWorld` resolves to the source's
  // every frame with no syncing code and no chance of the hull lagging the
  // character by a frame during a fast dash.
  outline.position.set(0, 0, 0);
  outline.quaternion.identity();
  outline.scale.set(1, 1, 1);
  // Drawn before the surface so the depth buffer rejects the hull's interior
  // early, and so a translucent effect layered over the character sorts against
  // one silhouette rather than two.
  outline.renderOrder = source.renderOrder - 1;
  outline.frustumCulled = source.frustumCulled;
  outline.userData.isToonOutline = true;
  outline.userData.ownsMaterial = ownsMaterial;

  source.add(outline);
  return outline;
}

/**
 * Detach and dispose an outline built by {@link createToonOutline}.
 *
 * Geometry is shared with the source mesh and is deliberately left alone, and
 * so is a material the caller supplied — a party sharing one outline material
 * is the normal case, and disposing it from the first character to be torn down
 * would blank the other five.
 */
export function disposeToonOutline(outline) {
  if (!outline) return;
  outline.parent?.remove(outline);
  if (outline.userData?.ownsMaterial !== false) outline.material?.dispose();
  if (outline.isSkinnedMesh) outline.skeleton = null;
}
