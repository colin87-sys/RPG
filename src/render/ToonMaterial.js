/**
 * ToonMaterial — the character shading model.
 *
 * ## What this is, and what it replaced
 *
 * The first cast was rejected as "AI slop [that] looks nothing like anime", and
 * `docs/ANIME_PIPELINE.md` diagnoses why: the characters were lit by a smooth,
 * PBR-ish falloff with procedural noise smeared over hair and cloth. This module
 * is the shading half of the correction. It implements ANIME_PIPELINE §2
 * literally:
 *
 *  1. **Two bands.** One `smoothstep( t - w, t + w, N·L )` with `t ≈ 0.5` and
 *     `w ≈ 0.03–0.06`. No ramp texture, no core-shadow subdivisions, no
 *     subsurface wrap across the terminator — every one of those softens the one
 *     edge the style depends on, and their sum is a soft ramp, which is the
 *     failure mode. A third band is available *above* the terminator, for hair
 *     and metal only, because that is the one extra band the idiom uses.
 *  2. **The shadow is a hue shift with rising saturation**, applied to the
 *     albedo before it is lit — never a darkened copy. See `awToonShadowAlbedo`
 *     in `shaders/toonCommon.js`; the trap it guards is documented there.
 *  3. **Specular is a thresholded blob**, isotropic or Kajiya-Kay across a
 *     strand axis, gated by the cel band, and compiled out of the classes that
 *     must not have one.
 *  4. **The face resists shadowing.** `shadowFloor` (0.75 on the `skin` preset)
 *     clamps the banded light term from below and pays the deficit back at the
 *     rig's own key radiance, so neither a form shadow nor a *cast* fringe
 *     shadow can carve a face into darkness.
 *
 * The rim from REFERENCE_TARGET §1 survives all of that unchanged: it is the one
 * term the reference frames never omit.
 *
 * **No noise touches a character.** ANIME_PIPELINE's absolute rule. The presets
 * that describe character surfaces carry `flat: true`, and a flat preset drops
 * incoming `normalMap` / `roughnessMap` / `aoMap` — in this project those come
 * from `AssetForge`'s fBm generators, and on a character they read as dirt.
 * Props and monsters (`generic`, `leather`, `crystal`) keep theirs, and any
 * caller that genuinely wants detail on a flat class can pass
 * `{ detailMaps: true }`. A base colour `map` is never dropped: the painted face
 * texture arrives that way, and nothing in this material multiplies anything
 * into it.
 *
 * ## Mechanically
 *
 * A `MeshStandardMaterial` whose direct BRDF has been replaced through
 * `onBeforeCompile`, and nothing else touched — so the characters keep cascaded
 * shadows from `render/Lighting.js`, skinning, morph targets, `FogExp2`, the
 * PMREM probe, ACES tone mapping and the HDR post chain. `Lighting.registerMaterial`
 * captures and chains a material's own `onBeforeCompile` before installing CSM's,
 * which is what makes this legal: CSM's hook runs first, ours second, and neither
 * depends on the other having left a particular chunk in place.
 *
 * ## Contract for consumers
 *
 *   createToonMaterial({ preset, lighting, ... })         -> THREE.MeshStandardMaterial
 *   updateToonUniforms(material, { time, rimColor, ... }) -> material
 *   createToonOutlineMaterial({ width, ... })             -> THREE.MeshBasicMaterial
 *   createToonOutline(sourceMesh, { material })           -> THREE.Mesh | THREE.SkinnedMesh
 *
 * Pass `{ lighting }` (the `Lighting` service) and the rig's key/rim uniforms are
 * *aliased*, not copied: the character's rim tracks the rim light that casts it,
 * every frame, at zero per-frame cost and with no possibility of the two
 * disagreeing. It is also how the face-flattening fill knows the key's colour, so
 * a face without it is flattened by a fixed white light instead of by the sun.
 *
 * Nothing here allocates a GPU resource; the materials and geometries this module
 * returns are the caller's to `dispose()`, and `createToonOutline` shares the
 * source geometry rather than cloning it, so the outline must never dispose it.
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
import {
  TOON_OUTLINE_PARS,
  TOON_OUTLINE_PROJECT,
  TOON_OUTLINE_FRAGMENT_PARS,
  TOON_OUTLINE_TINT,
} from './shaders/toonOutline.js';

/* -------------------------------------------------------------------------- */
/* Colour helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A palette hex reduced to pure chromaticity and re-scaled to a chosen
 * luminance.
 *
 * Every "fill" uniform in this material is a *radiance*, not a swatch, and the
 * two are not interchangeable: `SHADOW_TINT #2E4A5F` has a linear luminance of
 * 0.063, so using it raw as a shadow radiance would make the shadow's strength
 * an accident of how dark the designer happened to pick the swatch. Separating
 * hue from level means the art bible's hex stays authoritative for *colour*
 * while the level stays a tunable number.
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
 * *radiance* — something added to a light term, so it wants a luminance. This
 * produces a *reflectance* — the hue target the shadow albedo rotates toward —
 * so it must not exceed 1 in any channel, and peak-normalising leaves hue and
 * value independently controllable, which is the separation the whole shadow
 * model is built on.
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
 * ANIME_PIPELINE §1's skin shadow, as a hue target.
 *
 * The document is specific and it is not the scene tint: skin is `#F7DCC4` and
 * "the cel shadow band is a **warm rose-tan** (`#E0A98F`), never grey and never
 * a darkened copy of the base". Faces are the one surface whose shadow stays
 * warm — a teal-shadowed face reads as corpse-lit at any distance — so the skin
 * preset overrides the scene shadow tint with this and everything else inherits
 * `SHADOW_TINT`.
 */
const SKIN_SHADOW_TINT = 0xe0a98f;

/**
 * Named surface classes.
 *
 * These exist so that six characters authored by different agents cannot end up
 * with six different opinions about what skin looks like.
 *
 * Reading the fields:
 *
 *  - `terminator` / `softness` — ANIME_PIPELINE §2's `t` and `w`, in N·L.
 *    `softness` is the *full* width of the edge. It is a narrow band on purpose;
 *    widening it is how this material regressed to PBR the first time.
 *  - `bands` — 2, or 3 to enable the extra plateau on the lit side. Hair and
 *    metal only, per §2.
 *  - `shadowMix` — how far the albedo's chroma rotates toward `shadowTint`.
 *  - `shadowSat` — HSV saturation multiplier inside the shadow. Above 1 by
 *    definition: §2 requires saturation to *increase* as value drops.
 *  - `shadowValue` — value multiplier inside the shadow. Deliberately mild; the
 *    bulk of the value drop is the light the band withholds, and doing it twice
 *    turns a cel shadow into a hole.
 *  - `shadowLevel` / `shadowGain` — luminance and gain of the flat fill that
 *    lights the shadow mass.
 *  - `shadowLift` — the share of the key the shadow band keeps, so the dark side
 *    still carries the key's colour and dies with it at night.
 *  - `shadowFloor` — the face-flattening clamp. 0 everywhere except the face.
 *  - `specGain: 0` removes the highlight from the compiled program outright.
 *  - `specAlbedoMix` — how much of the surface's own colour the highlight keeps.
 *    Hair wants roughly half: a bright, slightly desaturated version of the hair
 *    colour, not a white dot.
 *  - `rimWidth` / `rimCeiling` — how far the rim reaches in from the silhouette,
 *    and the HDR level it lifts that edge to. See `DEFAULT_RIM_WIDTH` and
 *    `DEFAULT_RIM_CEILING`; between them they are why the rim now glows instead
 *    of clipping to a white second outline.
 *  - `flat` — this class is a character surface, so detail maps are dropped.
 *  - `envSpecular` — gain on the environment probe. Small for every dielectric:
 *    a toon character drinking a full-strength probe stops looking hand-painted.
 */
export const TOON_PRESETS = Object.freeze({
  generic: {
    bands: 2, terminator: 0.50, softness: 0.05,
    shadowMix: 0.45, shadowSat: 1.25, shadowValue: 0.80,
    shadowLevel: 0.26, shadowGain: 1.0, shadowLift: 0.10, shadowFloor: 0.0,
    ambientGain: 0.85, metalAlbedo: 0.0,
    specColor: 0xffffff, specGain: 0.25, specExponent: 56,
    specThreshold: 0.50, specSoftness: 0.05, specAlbedoMix: 0.25,
    rimPower: 3.4, rimGain: 1.45, rimFloor: 0.35,
    rimWidth: 0.75, rimCeiling: 1.50,
    roughness: 0.62, metalness: 0.0, envMapIntensity: 0.30, envSpecular: 0.12,
    flat: false,
  },

  // The face is the read, and ANIME_PIPELINE §1 puts that read entirely in the
  // painted texture: drawn eyes, drawn brows, drawn mouth on a flat cream plane.
  // So the shading's whole job here is to stay out of the way. `shadowFloor`
  // 0.75 is §2's face clamp — the essential one — the shadow tint is the warm
  // rose-tan rather than the scene's cool one, and there is no highlight at all:
  // a specular lobe on a near-spherical chibi cranium is a hotspot that slides
  // with the camera and reads as wet plastic.
  skin: {
    bands: 2, terminator: 0.46, softness: 0.045,
    shadowTint: SKIN_SHADOW_TINT,
    shadowMix: 0.80, shadowSat: 1.18, shadowValue: 0.88,
    shadowLevel: 0.30, shadowGain: 1.0, shadowLift: 0.14, shadowFloor: 0.75,
    ambientGain: 0.90,
    specGain: 0.0,
    // The tightest rim in the set, and the lowest ceiling. Skin is the brightest
    // albedo the cast owns and `shadowFloor` keeps it lit even in shadow, so it
    // is the surface with the least headroom left — and it is also the one
    // surface where a wide band would eat into the painted face, which is the
    // read the whole pipeline exists to protect.
    rimPower: 3.4, rimGain: 1.35, rimFloor: 0.40,
    rimWidth: 0.55, rimCeiling: 1.42,
    roughness: 0.55, metalness: 0.0, envMapIntensity: 0.22, envSpecular: 0.05,
    flat: true,
  },

  // ANIME_PIPELINE §3: "One anisotropic highlight band running across the crown,
  // perpendicular to the strand direction — a bright, slightly desaturated band
  // with hard-ish edges." Every clause is a field here: `aniso` picks the
  // Kajiya-Kay lobe (constant along the strand axis, falling off across it, so
  // thresholding it yields a band and not a dot), the high exponent under a
  // tight threshold and a 0.035 softness give the hard-ish edge, and
  // `specAlbedoMix` 0.45 keeps enough hair colour in the band that it reads as
  // lightened hair rather than as white plastic. Three bands: hair is one of the
  // two classes §2 allows the extra lit-side plateau.
  hair: {
    bands: 3, terminator: 0.50, softness: 0.04,
    shadowMix: 0.50, shadowSat: 1.35, shadowValue: 0.74,
    shadowLevel: 0.24, shadowGain: 1.0, shadowLift: 0.08, shadowFloor: 0.0,
    ambientGain: 0.80, litBandThreshold: 0.86, litBandGain: 0.22,
    specColor: SURFACE_TINT.SILK_SPEC, specGain: 1.45, specExponent: 96,
    specThreshold: 0.52, specSoftness: 0.035, specAlbedoMix: 0.45,
    aniso: true, anisoShift: 0.18,
    rimPower: 3.6, rimGain: 1.90, rimFloor: 0.32,
    rimWidth: 0.66, rimCeiling: 1.60,
    roughness: 0.42, metalness: 0.0, envMapIntensity: 0.22, envSpecular: 0.06,
    flat: true,
  },

  // Cloth carries no highlight at all. A sheen band on a coat is the tell that
  // separates a cel frame from a stylised-PBR one, and §5's colour blocking
  // wants these surfaces to be *the* flat zones the character is identified by
  // at eighty pixels tall. Its shadow is the most saturated in the set, because
  // a garment shadow is where a painter puts the frame's richest colour.
  cloth: {
    bands: 2, terminator: 0.50, softness: 0.05,
    shadowMix: 0.48, shadowSat: 1.35, shadowValue: 0.78,
    shadowLevel: 0.25, shadowGain: 1.0, shadowLift: 0.10, shadowFloor: 0.0,
    ambientGain: 0.85,
    specGain: 0.0,
    rimPower: 3.2, rimGain: 1.35, rimFloor: 0.38,
    rimWidth: 0.70, rimCeiling: 1.50,
    roughness: 0.88, metalness: 0.0, envMapIntensity: 0.18, envSpecular: 0.05,
    flat: true,
  },

  // Props and monster hides rather than a party garment, so this one keeps its
  // detail maps and a modest highlight.
  leather: {
    bands: 2, terminator: 0.50, softness: 0.055,
    shadowMix: 0.46, shadowSat: 1.25, shadowValue: 0.78,
    shadowLevel: 0.22, shadowGain: 1.0, shadowLift: 0.10, shadowFloor: 0.0,
    ambientGain: 0.85,
    specColor: 0xffffff, specGain: 0.18, specExponent: 44,
    specThreshold: 0.48, specSoftness: 0.05, specAlbedoMix: 0.30,
    rimPower: 3.2, rimGain: 1.40, rimFloor: 0.35,
    rimWidth: 0.75, rimCeiling: 1.50,
    roughness: 0.60, metalness: 0.0, envMapIntensity: 0.26, envSpecular: 0.10,
    flat: false,
  },

  // The second class §2 allows a third band, and the one that lives on its
  // highlight: a tight, bright, hard-edged blob with an anisotropic axis a
  // caller pushes per frame for a blade (`updateToonUniforms(m, {anisoDirection})`).
  // `metalAlbedo` restores most of the diffuse three zeroes at metalness 1 —
  // cel-shaded armour is painted, not simulated, and §5 needs it to read as a
  // flat colour zone. The probe is kept but quantised into plates and held well
  // below full strength, so armour acknowledges the world without mirroring it.
  metal: {
    bands: 3, terminator: 0.48, softness: 0.035,
    shadowMix: 0.42, shadowSat: 1.25, shadowValue: 0.70,
    shadowLevel: 0.20, shadowGain: 1.0, shadowLift: 0.06, shadowFloor: 0.0,
    ambientGain: 0.80, litBandThreshold: 0.84, litBandGain: 0.28,
    metalAlbedo: 0.70,
    specColor: 0xffffff, specGain: 2.4, specExponent: 130,
    specThreshold: 0.45, specSoftness: 0.03, specAlbedoMix: 0.50,
    aniso: true, anisoShift: 0.06,
    // ART_BIBLE §2.3 lets a specular ping clip, so metal keeps the highest
    // ceiling of the character classes — but it is a *ping*, and the rim is not
    // one, hence the narrow band.
    rimPower: 3.6, rimGain: 2.00, rimFloor: 0.30,
    rimWidth: 0.62, rimCeiling: 1.85,
    roughness: 0.35, metalness: 1.0, envMapIntensity: 0.55, envSpecular: 0.45,
    flat: true,
  },

  // Kept for any geometry eye still in the scene. Under the painted-face
  // pipeline the eye is drawn into the texture and this preset is not the
  // primary path — but where it is used, an iris must never take a shadow band
  // (hence the 0.9 floor) and its catch-light is the whole point.
  eye: {
    bands: 2, terminator: 0.0, softness: 0.10,
    shadowMix: 0.15, shadowSat: 1.10, shadowValue: 0.94,
    shadowLevel: 0.12, shadowGain: 1.0, shadowLift: 0.30, shadowFloor: 0.90,
    ambientGain: 0.90,
    specColor: 0xffffff, specGain: 3.0, specExponent: 220,
    specThreshold: 0.60, specSoftness: 0.03, specAlbedoMix: 0.0,
    rimPower: 3.4, rimGain: 1.10, rimFloor: 0.20,
    rimWidth: 0.85, rimCeiling: 1.50,
    roughness: 0.20, metalness: 0.0, envMapIntensity: 0.20, envSpecular: 0.25,
    flat: true,
  },

  // Interior glow is the caller's `emissive`; this supplies the fresnel rim and
  // a hard highlight over the top of it. A prop class, so detail maps stay.
  crystal: {
    bands: 2, terminator: 0.30, softness: 0.06,
    shadowMix: 0.40, shadowSat: 1.20, shadowValue: 0.82,
    shadowLevel: 0.18, shadowGain: 1.0, shadowLift: 0.16, shadowFloor: 0.0,
    ambientGain: 0.90,
    specColor: 0xffffff, specGain: 1.4, specExponent: 120,
    specThreshold: 0.42, specSoftness: 0.04, specAlbedoMix: 0.20,
    // The one class that wants a broad wrap rather than an edge: on glass the
    // fresnel *is* the material, so the width stays at the identity value and
    // the band is the bare `pow(1 - N·V, k)` it always was. The ceiling is the
    // highest in the set because a crystal's own emissive already sits at
    // 1.2–1.8 and the rim must still be visible over it.
    rimPower: 1.6, rimGain: 2.10, rimFloor: 0.30,
    rimWidth: 1.00, rimCeiling: 2.00,
    roughness: 0.10, metalness: 0.0, envMapIntensity: 0.9, envSpecular: 0.9,
    flat: false,
  },
});

/** Rim focus window on `dot(N, rimDir)`. The negative floor is deliberate: a
 *  surface may face slightly *away* from the rim and still show its wrap, which
 *  is what stops the band from terminating in a visible hard edge halfway round
 *  a cylinder. The ceiling stays well under 1 so the band saturates before the
 *  surface turns fully toward the light and the fresnel has already died. */
const DEFAULT_RIM_FOCUS = new THREE.Vector2(-0.50, 0.35);

/** Window applied to the grazing term. Opens at 0.05 rather than 0 to kill the
 *  long low tail `pow()` leaves across the facing side — that tail is what turns
 *  a rim into a wash. Closes at 0.5 so the band reaches full strength in the
 *  outer sliver of the silhouette. */
const DEFAULT_RIM_SHAPE = new THREE.Vector2(0.05, 0.50);

/**
 * Where the rim band's inner edge sits, in `N·V`.
 *
 * The control the model was missing, and the reason the review found "a hard
 * white outline competing with the ink outline" rather than a rim. A bare
 * `pow(1 - N·V, k)` states a falloff but never a *reach*: the band ends wherever
 * that curve happens to fall under the shape window, and at the exponent this
 * project actually runs — `Lighting.RIM_CONTRACT` floors it at 3 and
 * `CharacterFactory.BODY_RIM` pins it there, so nothing a preset here says
 * survives — the band covers the outer fifth of a chibi silhouette's radius.
 * Twenty percent of a head is a slab of light, and a slab of light at the
 * silhouette is an outline.
 *
 * Stating the reach separately is what makes the width a property of the surface
 * class (how sharply its silhouette curves away) instead of a side effect of an
 * exponent two other modules have opinions about. 0.7 puts the band's foot at
 * roughly 6% of a sphere's projected radius with the peak in the outer 1% — read
 * as a glow hugging the edge at the battle camera, still under the 2 px ink line
 * in a closeup. `1.0` is the identity case and restores the bare fresnel exactly.
 */
const DEFAULT_RIM_WIDTH = 0.70;

/**
 * The HDR level the rim lifts an edge *to*, and cannot push past.
 *
 * The review's defect: "character edges are clipping to pure white rather than
 * glowing [...] it should read as a bright edge that feeds bloom". A rim added
 * outright cannot promise that, because its brightness is the rig's but the
 * surface under it is the character's — the same rim that reads as a glow on a
 * navy coat lands a lit face past 2.0, where ACES has nothing left to resolve
 * and hue collapses to white. `TOON_SURFACE_COMPOSITE` therefore spends the rim
 * against the headroom below this value, which bounds the result at it exactly.
 *
 * 1.5 sits above ART_BIBLE §6's bloom threshold of 1.0 by more than the 0.6 knee
 * half-width, so the hottest part of the band is fully inside bloom and glows;
 * and it is far enough below the tone curve's shoulder that the rim's teal
 * survives the mapping instead of washing out. Classes whose highlights the art
 * direction *does* allow to clip — metal, crystal — carry a higher one.
 */
const DEFAULT_RIM_CEILING = 1.50;

/** Default anisotropy axis: world up. Hair falls, blades are worn vertically,
 *  and armour brushing runs with the body — world +Y is right far more often
 *  than it is wrong, and the exceptions are per-frame overrides anyway. */
const DEFAULT_ANISO_DIR = new THREE.Vector3(0, 1, 0);

/** Uniform names aliased from `Lighting.uniforms` when a rig is supplied. These
 *  are rig state, not art state; the spelling must match `Lighting` exactly or
 *  the aliasing silently degrades into private copies nobody updates. */
const RIG_UNIFORMS = ['uKeyColor', 'uRimDirection', 'uRimColor', 'uRimStrength'];

/**
 * Saturation the shadow albedo is held at or above.
 *
 * ART_BIBLE §2.1 sets the legal minimum at `MIN_SHADOW_SATURATION` (0.15). That
 * is a *floor*, and a shadow sitting exactly on it still eyedrops as a grey with
 * a faint cast — which is the observation the rule is trying to prevent. The
 * margin also has to clear the point where the albedo→tint line crosses the
 * neutral axis (mix ≈ 0.5 for skin tones), or the guard in `awToonShadowAlbedo`
 * would be inert exactly where it is needed.
 */
const SHADOW_SAT_TARGET = Math.max(MIN_SHADOW_SATURATION, 0.22);

/** Maps three's detail-map slots to the reason they are dropped on a flat class:
 *  in this project every one of them is fBm from `AssetForge`, and
 *  ANIME_PIPELINE's absolute rule is that no procedural noise touches a
 *  character. `map` is deliberately absent — the painted face arrives that way. */
const DETAIL_MAP_KEYS = Object.freeze(['normalMap', 'roughnessMap', 'aoMap', 'bumpMap']);

/* -------------------------------------------------------------------------- */
/* Surface material                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build a cel-shaded character material.
 *
 * @param {Object} [opts]
 * @param {string} [opts.preset='generic'] key into {@link TOON_PRESETS}.
 * @param {import('./Lighting.js').Lighting|{uniforms:Object}} [opts.lighting]
 *   the lighting rig (or anything exposing its `uniforms` block). Supplying it
 *   aliases the key/rim uniforms so they track the rig for free, and is what
 *   lets the face-flattening fill be paid in the sun's own colour.
 * @param {THREE.ColorRepresentation} [opts.color=0xffffff] base albedo.
 * @param {THREE.Texture} [opts.map] base colour map — the painted face texture.
 *   Nothing in this material multiplies anything into it.
 * @param {boolean} [opts.detailMaps] force detail maps on a `flat` preset. They
 *   are dropped by default on every character class.
 * @param {number} [opts.bands=2] 2, or 3 to enable the lit-side band.
 * @param {number} [opts.terminator=0.5] the cel edge's position, in N·L.
 * @param {number} [opts.softness=0.045] the cel edge's full width, in N·L.
 *   0.03–0.06. Wider is the PBR failure mode.
 * @param {number} [opts.shadowFloor] minimum for the banded light term. `0.75`
 *   is the face value; see also `faceFlatten`.
 * @param {boolean} [opts.faceFlatten] shorthand for `shadowFloor: 0.75`.
 * @param {THREE.ColorRepresentation} [opts.shadowTint] hue target for the
 *   shadow albedo. Defaults to the scene shadow tint (warm rose-tan on `skin`).
 * @param {number} [opts.shadowMix] 0–1, how far the albedo's chroma rotates.
 * @param {number} [opts.shadowSat] HSV saturation multiplier in shadow, > 1.
 * @param {number} [opts.shadowValue] value multiplier in shadow, < 1.
 * @param {number} [opts.shadowLevel] luminance of the flat shadow fill.
 * @param {number} [opts.shadowLift] share of the key the shadow band keeps.
 * @param {number} [opts.specGain] 0 compiles the highlight out entirely.
 * @param {number} [opts.rimGain] the rim's radiance, scaling `uRimColor`.
 * @param {number} [opts.rimWidth] the rim band's inner edge, in `N·V`. 1 is the
 *   bare fresnel; lower values hold the band to the outer silhouette.
 * @param {number} [opts.rimCeiling] HDR level the rim lifts an edge to and
 *   cannot exceed. 1.2–2.0 glows into bloom; higher clips to white.
 * @param {boolean} [opts.aniso] force the anisotropic highlight on or off.
 * @param {THREE.Vector3} [opts.anisoDirection] world-space strand axis.
 * @returns {THREE.MeshStandardMaterial} patched, ready to add to a scene.
 */
export function createToonMaterial(opts = {}) {
  const presetName = opts.preset && TOON_PRESETS[opts.preset] ? opts.preset : 'generic';
  const p = { ...TOON_PRESETS.generic, ...TOON_PRESETS[presetName] };

  const specGain = opts.specGain ?? p.specGain ?? 0;
  // A zero-gain highlight is not the same thing as no highlight. The classes the
  // pipeline gives no gloss (skin and cloth above all) must not merely multiply
  // the blob by zero — the term drops out of the compiled program, so it cannot
  // come back through a stray `updateToonUniforms` and cannot cost a `pow()` per
  // light per fragment on the largest surfaces in frame.
  const hasSpec = specGain > 0;
  const aniso = hasSpec && (opts.aniso ?? p.aniso ?? false);

  // `bands` is the caller-facing spelling of "is the third, lit-side band on".
  // ANIME_PIPELINE §2 allows it for hair and metal only, and the presets are
  // where that is decided; an explicit `litBand` overrides for a one-off.
  const bands = THREE.MathUtils.clamp(Math.round(opts.bands ?? p.bands), 2, 3);
  const litBand = opts.litBand ?? bands >= 3;

  // ANIME_PIPELINE's absolute rule, enforced where it can be: a character class
  // never receives a procedural detail map. Callers with a genuine reason opt
  // back in per material rather than by editing this table.
  const flat = opts.detailMaps === undefined ? (p.flat ?? false) : !opts.detailMaps;
  const detail = {};
  for (const key of DETAIL_MAP_KEYS) detail[key] = flat ? null : (opts[key] ?? null);

  // `faceFlatten` is the readable spelling of the one number ANIME_PIPELINE §2
  // calls essential; `shadowFloor` is the same control with the value exposed.
  // Resolved here rather than inline so that `faceFlatten: false` can genuinely
  // turn the face clamp *off* on a preset that carries one.
  const shadowFloor = opts.shadowFloor
    ?? (opts.faceFlatten === undefined ? (p.shadowFloor ?? 0.0) : (opts.faceFlatten ? 0.75 : 0.0));

  // The hue the shadow rotates toward: the scene shadow tint, unless the preset
  // or the caller names another (skin's warm rose-tan is the one that matters).
  const shadowTint = opts.shadowTint ?? p.shadowTint ?? LIGHT.SHADOW_TINT;

  const material = new THREE.MeshStandardMaterial({
    name: opts.name ?? `toon:${presetName}`,
    color: opts.color ?? 0xffffff,
    map: opts.map ?? null,
    normalMap: detail.normalMap,
    normalScale: opts.normalScale ?? new THREE.Vector2(1, 1),
    roughnessMap: detail.roughnessMap,
    metalnessMap: opts.metalnessMap ?? null,
    aoMap: detail.aoMap,
    aoMapIntensity: opts.aoMapIntensity ?? 1.0,
    alphaMap: opts.alphaMap ?? null,
    emissive: opts.emissive ?? 0x000000,
    emissiveMap: opts.emissiveMap ?? null,
    emissiveIntensity: opts.emissiveIntensity ?? 1.0,
    // Where a map exists, three multiplies the scalar by it, so 1.0 lets the
    // baked value through unchanged — the same convention `AssetForge.material`
    // documents, and deviating from it here would make the two disagree about
    // what `roughness: 0.6` means.
    roughness: opts.roughness ?? (detail.roughnessMap ? 1.0 : p.roughness),
    metalness: opts.metalness ?? (opts.metalnessMap ? 1.0 : p.metalness),
    envMapIntensity: opts.envMapIntensity ?? p.envMapIntensity,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1.0,
    alphaTest: opts.alphaTest ?? 0.0,
    side: opts.side ?? THREE.FrontSide,
    flatShading: opts.flatShading ?? false,
    vertexColors: opts.vertexColors ?? false,
    fog: opts.fog ?? true,
    // Cel shading puts large genuinely-flat regions on screen, which is exactly
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

    // ---- the two-band terminator (ANIME_PIPELINE §2) ----------------------
    uToonTerminator: { value: opts.terminator ?? p.terminator },
    uToonSoftness: { value: opts.softness ?? p.softness },
    uToonShadowFloor: { value: shadowFloor },
    uToonShadowLift: { value: opts.shadowLift ?? p.shadowLift },

    // ---- shadow colour: hue shift, saturation up --------------------------
    uToonShadowTint: { value: chromaUnit(shadowTint) },
    uToonShadowHue: { value: opts.shadowMix ?? p.shadowMix },
    uToonShadowSat: { value: opts.shadowSat ?? p.shadowSat },
    uToonShadowValue: { value: opts.shadowValue ?? p.shadowValue },
    // Enforced in the shader rather than left to an author to remember: a warm
    // albedo rotated halfway to a cool tint passes through the neutral axis, so
    // the rule has to hold where the mix happens.
    uToonShadowSatFloor: { value: opts.shadowSatFloor ?? SHADOW_SAT_TARGET },

    // ---- the flat shadow fill ---------------------------------------------
    uToonShadowFill: {
      value: chromaAt(opts.shadowColor ?? shadowTint, opts.shadowLevel ?? p.shadowLevel),
    },
    uToonShadowGain: { value: opts.shadowGain ?? p.shadowGain },
    uToonAmbientGain: { value: opts.ambientGain ?? p.ambientGain },
    uToonMetalAlbedo: { value: opts.metalAlbedo ?? p.metalAlbedo ?? 0.0 },
    uToonEnvSpecular: { value: opts.envSpecular ?? p.envSpecular },

    // ---- rim --------------------------------------------------------------
    uToonRimPower: { value: opts.rimPower ?? p.rimPower },
    uToonRimGain: { value: opts.rimGain ?? p.rimGain },
    uToonRimFocus: { value: toVec2(opts.rimFocus, DEFAULT_RIM_FOCUS) },
    uToonRimShape: { value: toVec2(opts.rimShape, DEFAULT_RIM_SHAPE) },
    uToonRimFloor: { value: opts.rimFloor ?? p.rimFloor },
    uToonRimWidth: { value: opts.rimWidth ?? p.rimWidth ?? DEFAULT_RIM_WIDTH },
    uToonRimCeiling: { value: opts.rimCeiling ?? p.rimCeiling ?? DEFAULT_RIM_CEILING },

    // ---- battle feedback --------------------------------------------------
    uToonPulse: { value: toColor(opts.pulse ?? 0x000000) },
    uToonPulseRate: { value: opts.pulseRate ?? 0.0 },
    uToonTime: { value: 0.0 },
  };

  if (litBand) {
    uniforms.uToonLitBandThreshold = {
      value: opts.litBandThreshold ?? p.litBandThreshold ?? 0.85,
    };
    uniforms.uToonLitBandGain = { value: opts.litBandGain ?? p.litBandGain ?? 0.22 };
  }

  if (hasSpec) {
    uniforms.uToonSpecColor = { value: toColor(opts.specColor ?? p.specColor ?? 0xffffff) };
    uniforms.uToonSpecGain = { value: specGain };
    uniforms.uToonSpecExponent = { value: opts.specExponent ?? p.specExponent ?? 56 };
    uniforms.uToonSpecThreshold = { value: opts.specThreshold ?? p.specThreshold ?? 0.5 };
    uniforms.uToonSpecSoftness = { value: opts.specSoftness ?? p.specSoftness ?? 0.04 };
    uniforms.uToonSpecAlbedoMix = { value: opts.specAlbedoMix ?? p.specAlbedoMix ?? 0.0 };
  }

  if (aniso) {
    uniforms.uToonAnisoDirection = { value: toDirection(opts.anisoDirection, DEFAULT_ANISO_DIR) };
    uniforms.uToonAnisoShift = { value: opts.anisoShift ?? p.anisoShift ?? 0.12 };
  }

  // The fill's level is remembered so a later `updateToonUniforms({ shadowColor })`
  // can re-derive the radiance the same way the constructor did, instead of
  // dumping a raw swatch into a uniform that expects a radiance.
  const levels = { shadow: opts.shadowLevel ?? p.shadowLevel };

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
  if (hasSpec) material.defines.TOON_SPECULAR = '';
  if (aniso) material.defines.TOON_ANISO = '';
  if (litBand) material.defines.TOON_LIT_BAND = '';

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
  // `MeshStandardMaterial` with the same defines to the *same* compiled program,
  // because `onBeforeCompile` is not part of the key. The first one compiled wins
  // and the other renders with someone else's BRDF — a bug that presents as
  // "characters look fine until you walk past a rock".
  const cacheKey = `aw-toon-surface|${presetName}|${litBand ? 'lit3' : 'lit2'}`
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
      console.error(`[ToonMaterial] anchor "${anchor}" missing from ${label}; cel shading incomplete.`);
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
 * captures the uniform *objects* into `materialProperties.uniformsList` when the
 * program is built, so replacing the entry afterwards would be ignored.
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

/** Scalar options that map straight onto a uniform. Entries whose uniform is
 *  absent (the highlight on a `specGain: 0` material, the lit band on a two-band
 *  one) are skipped rather than created: the uniform is not in the compiled
 *  program either. */
const SCALAR_KEYS = Object.freeze({
  time: 'uToonTime',
  terminator: 'uToonTerminator',
  softness: 'uToonSoftness',
  shadowFloor: 'uToonShadowFloor',
  shadowLift: 'uToonShadowLift',
  shadowMix: 'uToonShadowHue',
  shadowSat: 'uToonShadowSat',
  shadowValue: 'uToonShadowValue',
  shadowSatFloor: 'uToonShadowSatFloor',
  shadowGain: 'uToonShadowGain',
  ambientGain: 'uToonAmbientGain',
  metalAlbedo: 'uToonMetalAlbedo',
  envSpecular: 'uToonEnvSpecular',
  litBandThreshold: 'uToonLitBandThreshold',
  litBandGain: 'uToonLitBandGain',
  specExponent: 'uToonSpecExponent',
  specThreshold: 'uToonSpecThreshold',
  specSoftness: 'uToonSpecSoftness',
  specAlbedoMix: 'uToonSpecAlbedoMix',
  rimPower: 'uToonRimPower',
  rimGain: 'uToonRimGain',
  rimFloor: 'uToonRimFloor',
  rimWidth: 'uToonRimWidth',
  rimCeiling: 'uToonRimCeiling',
  pulseRate: 'uToonPulseRate',
  anisoShift: 'uToonAnisoShift',
  outlineWidth: 'uOutlineWidth',
  outlineDarkness: 'uOutlineDarkness',
  outlineSaturation: 'uOutlineSaturation',
});

/** Colour options written verbatim as radiance. */
const COLOR_KEYS = Object.freeze({
  keyColor: 'uKeyColor',
  specColor: 'uToonSpecColor',
  pulse: 'uToonPulse',
});

/**
 * Push art or runtime state into a material built by this module.
 *
 * Safe to call every frame — it touches only the keys present in `opts` and
 * allocates nothing on the scalar and vector paths. Safe to call on a material
 * that has not compiled yet, and on the outline material (which shares the
 * `outline*` keys and ignores the rest).
 *
 * Two behaviours are worth knowing about. Writing `rimColor` / `rimStrength` /
 * `keyColor` on a material built with `{ lighting }` **breaks the alias to the
 * rig** for that uniform and triggers one program rebuild; the material then
 * keeps the value you gave it and stops tracking time of day. That is almost
 * always what an author who reaches for the override wants, but it is not free,
 * so do not do it per frame. And `specGain` is inert on a material built with
 * none: the highlight is compiled in, not multiplied, so a class the pipeline
 * gives no gloss (skin, cloth) cannot grow one at runtime. Toggling it on a
 * material that *has* a highlight still costs one program rebuild.
 *
 * @param {THREE.Material} material
 * @param {Object} opts
 * @param {number} [opts.time] seconds; drives the `pulse` channel.
 * @param {THREE.ColorRepresentation} [opts.shadowTint] shadow hue target.
 * @param {THREE.ColorRepresentation} [opts.shadowColor] shadow fill swatch.
 * @param {number} [opts.shadowLevel] luminance for that fill.
 * @param {THREE.Vector3} [opts.anisoDirection] world-space strand/blade axis.
 * @param {THREE.ColorRepresentation} [opts.pulse] additive battle-feedback tint.
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

  // The fill is a radiance, so its swatch and its level are recombined here the
  // same way the constructor did; writing a raw hex would make the fill's
  // strength an accident of how dark the swatch happens to be.
  if ((opts.shadowColor !== undefined || opts.shadowLevel !== undefined) && u.uToonShadowFill) {
    const level = opts.shadowLevel ?? toon.levels.shadow;
    toon.levels.shadow = level;
    const swatch = opts.shadowColor ?? u.uToonShadowFill.value;
    u.uToonShadowFill.value.copy(chromaAt(swatch, level));
  }

  if (opts.shadowTint !== undefined && u.uToonShadowTint) {
    u.uToonShadowTint.value.copy(chromaUnit(opts.shadowTint));
  }
  if (opts.faceFlatten !== undefined && u.uToonShadowFloor) {
    u.uToonShadowFloor.value = opts.faceFlatten ? 0.75 : 0.0;
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

  // `specGain` crossing zero adds or removes the highlight from the program, so
  // it cannot go through `SCALAR_KEYS`. Anisotropy rides along: the tangent frame
  // is only ever consumed by the highlight, so a material without one has no use
  // for `TOON_ANISO` and should not pay to compile it. Going from *no* highlight
  // to one needs the material rebuilt anyway, and the uniforms the new program
  // reads have to exist before it is compiled.
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

  return material;
}

/* -------------------------------------------------------------------------- */
/* Inverted-hull outline                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Default line weight, as a fraction of viewport height.
 *
 * ANIME_PIPELINE §4 asks for a constant screen-space weight of 1.5–2.5 px at
 * 1080p, and names "no outlines, or too subtle to see" as one of the four
 * failures of the first attempt. 0.0018 is ~1.9 px at 1080p and ~2.6 px at
 * 1440p: unmistakably an ink line, still short of the cartoon border that a
 * heavier value would give.
 */
const DEFAULT_OUTLINE_WIDTH = 0.0018;

/**
 * How far the outline darkens the albedo it is derived from, and how much it
 * saturates on the way down.
 *
 * §4: "Outline colour is **not black** — use a heavily darkened, saturated
 * version of the underlying albedo, so hair gets a dark-warm line and cloth a
 * dark-cool one." 0.16 is heavily darkened; 1.55 saturation is what stops the
 * darkening from also draining the hue and landing on the near-black line the
 * document rules out. A true black outline would additionally be the only pure
 * black in frame, sitting on the subject, which breaks ART_BIBLE §2.3's tinted
 * value floor.
 */
const DEFAULT_OUTLINE_DARKNESS = 0.16;
const DEFAULT_OUTLINE_SATURATION = 1.55;

/** Fallback outline colour, for a hull with no per-vertex colour to darken. */
const DEFAULT_OUTLINE_LEVEL = 0.035;

/**
 * Build the material for an inverted-hull outline.
 *
 * @param {Object} [opts]
 * @param {number} [opts.width=0.0018] fraction of viewport height.
 * @param {boolean} [opts.vertexColors=true] derive the line colour from the
 *   hull's per-vertex colour block, which is how §4's "dark-warm line on hair,
 *   dark-cool on cloth" is achieved on a single merged mesh. Requires the
 *   geometry to carry a `color` attribute — `CharacterFactory` paints one.
 * @param {THREE.ColorRepresentation} [opts.color] explicit line colour. With
 *   `vertexColors` on this multiplies the vertex colour; leave it white.
 * @param {number} [opts.darkness] / [opts.saturation] the §4 tint controls.
 * @returns {THREE.MeshBasicMaterial}
 */
export function createToonOutlineMaterial(opts = {}) {
  const vertexColors = opts.vertexColors ?? true;
  const color = opts.color !== undefined
    ? toColor(opts.color)
    : (vertexColors ? new THREE.Color(1, 1, 1) : chromaAt(LIGHT.SHADOW_TINT, opts.level ?? DEFAULT_OUTLINE_LEVEL));

  const material = new THREE.MeshBasicMaterial({
    name: opts.name ?? 'toon:outline',
    color,
    vertexColors,
    // BackSide is the hull; FrontSide culling is what makes the shell visible
    // only where it pokes out past the silhouette.
    side: THREE.BackSide,
    fog: opts.fog ?? true,
    // Opaque and depth-writing. A transparent outline would need sorting against
    // the character it wraps, and would show the seam wherever the shell
    // self-overlaps on a concave part like an armpit.
    transparent: false,
    depthWrite: true,
    toneMapped: true,
  });

  const uniforms = { uOutlineWidth: { value: opts.width ?? DEFAULT_OUTLINE_WIDTH } };
  // The tint is only meaningful when there is an albedo to derive from. With an
  // explicit flat colour the caller has already chosen the line, and darkening
  // it a second time would halve a value that was picked deliberately.
  const tint = opts.tint ?? vertexColors;
  if (tint) {
    uniforms.uOutlineDarkness = { value: opts.darkness ?? DEFAULT_OUTLINE_DARKNESS };
    uniforms.uOutlineSaturation = { value: opts.saturation ?? DEFAULT_OUTLINE_SATURATION };
    uniforms.uOutlineFallback = {
      value: chromaAt(LIGHT.SHADOW_TINT, opts.level ?? DEFAULT_OUTLINE_LEVEL),
    };
  }

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
    if (tint) {
      shader.fragmentShader = TOON_OUTLINE_FRAGMENT_PARS + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>', () => TOON_OUTLINE_TINT,
      );
    }
    material.userData.toonShader = shader;
  };

  material.customProgramCacheKey = () => `aw-toon-outline|${tint ? 'tint' : 'flat'}`;
  return material;
}

/**
 * Attach an inverted-hull outline to a mesh.
 *
 * The hull is added as a **child of the source with an identity local matrix**,
 * which is the only arrangement correct for both cases: a static mesh inherits
 * the source's world transform exactly, and a `SkinnedMesh` — which three
 * transforms through its bind matrix and skeleton rather than through its own
 * world matrix — ends up sharing the source's skeleton, bind matrix and bind
 * mode, so the hull deforms with the animation instead of drifting off it.
 * Cloning the geometry would double the vertex memory of every character in the
 * party for no benefit, so it is shared; `disposeToonOutline` therefore disposes
 * the material only.
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
  // every contact shadow by the outline width, and receiving would band the line
  // where the key crosses it.
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
 * Geometry is shared with the source mesh and is deliberately left alone, and so
 * is a material the caller supplied — a party sharing one outline material is
 * the normal case, and disposing it from the first character to be torn down
 * would blank the other five.
 */
export function disposeToonOutline(outline) {
  if (!outline) return;
  outline.parent?.remove(outline);
  if (outline.userData?.ownsMaterial !== false) outline.material?.dispose();
  if (outline.isSkinnedMesh) outline.skeleton = null;
}
