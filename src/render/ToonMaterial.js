/**
 * ToonMaterial — the character shading model.
 *
 * ## What this is, and what it replaced
 *
 * This module has been corrected twice. The first cast was rejected for a
 * smooth PBR falloff with procedural noise smeared over hair and cloth; the
 * over-correction that followed was hard two-band cel shading with a 1.3-pixel
 * terminator and a heavy ink outline, which the client rejected again. The
 * reference screenshots are now in `docs/reference/`, they are the authority,
 * and where the prose specs disagree with them the images win.
 *
 * Measured off `bravely01.jpg` (1920×1080) and `bravely02.jpg`:
 *
 *  1. **The terminator is a broad continuous gradient.** The white hat runs
 *     236 → 142 sRGB over ~30 px of a ~150 px form; the red coat sleeve runs
 *     15 → 188 over ~13 px of a ~50 px cylinder. A 16-bin histogram of the hat's
 *     interior is populated in every bin — a ramp, not a pair of plateaus. So
 *     `softness` is now the ramp's *full width in N·L* and it is close to a whole
 *     unit, `terminator` sits near the geometric terminator rather than at 0.5,
 *     and `edgePixels` is only an antialias floor.
 *  2. **The dark side is a level, not a hole.** That 236/142 pair is a linear
 *     ratio of 0.34. `shadowDepth` states it, and the composite places the
 *     shaded level there after every fill has had its say, so it holds at noon,
 *     at dusk and by torchlight.
 *  3. **The shadow is still a hue shift with rising saturation.** The one thing
 *     the previous revision had right: the darkest skin on the plate is
 *     RGB(151,130,123) against a lit RGB(186,155,147), which is warmer in
 *     proportion rather than a scaled copy.
 *  4. **Metal is genuine metal.** Isotropic classes now take three's own
 *     `BRDF_GGX` for the direct highlight and the real reflection-vector probe
 *     radiance for the indirect one, unquantised. The plate's greaves sweep
 *     continuously from the purple ice below to the teal aurora above, with
 *     specular streaks at 237 sRGB over plate bodies at 59 and recesses at 4.
 *  5. **The face resists shadowing.** `faceFlatten` lifts the face's shaded
 *     *radiance* toward its lit one without touching the ramp, so a fringe
 *     cannot carve a face into darkness and the rose-tan shadow shape survives.
 *     The plate's lit face is one value to within ±3%.
 *  6. **Fur and feather have their own class.** `preset: 'fur'` compiles a
 *     Charlie/Neubelt sheen — broad, grazing-peaked, retro-reflective. The
 *     plate's fur collar spreads smoothly across p5 15 / p50 70 / p95 181 sRGB;
 *     a Blinn lobe on the same albedo gives a bimodal albedo-plus-hotspot
 *     signature, which is what reads as moulded plastic.
 *
 * **There is no ink outline in the reference.** Four clean silhouette crossings
 * were checked against smooth backgrounds and none shows a trough below the
 * background level — see `render/Outline.js`, which now ships disabled by
 * default and keeps the machinery behind a switch.
 *
 * **The rim is a whisper.** Nothing on the plates is attributable to one, so it
 * survives only because the brief requires a separation device: it is bounded
 * absolutely by `rimMax` downstream of the rig's radiance solve, which is the
 * only place a cap can hold, since `Lighting` normalises preset gains away.
 *
 * **No noise touches a character.** The presets that describe character surfaces
 * carry `flat: true`, and a flat preset drops incoming `normalMap` /
 * `roughnessMap` / `aoMap` — in this project those come from `AssetForge`'s fBm
 * generators, and on a character they read as dirt. Props and monsters
 * (`generic`, `leather`, `crystal`) keep theirs, and any caller that genuinely
 * wants detail on a flat class can pass `{ detailMaps: true }`. A base colour
 * `map` is **never** dropped — the painted face texture and the garment system's
 * woven patterns both arrive that way, and nothing in this material multiplies
 * anything into it.
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
 * The last two are **adapters over `render/Outline.js`**, which owns the one
 * inverted-hull implementation in the project. They exist so callers that hold
 * this module's spelling keep working; new code should call `Outline.js`
 * directly.
 *
 * Pass `{ lighting }` (the `Lighting` service) and the rig's key/rim uniforms are
 * *aliased*, not copied: the character's rim tracks the rim light that casts it,
 * every frame, at zero per-frame cost and with no possibility of the two
 * disagreeing. It is also how the face-flattening fill knows the key's colour, so
 * a face without it is flattened by a fixed white light instead of by the sun.
 *
 * The materials this module returns are the caller's to `dispose()`. A hull from
 * `createToonOutline` is released through `disposeToonOutline`, which delegates
 * to `Outline.disposeOutline` — the hull's geometry shares its attribute buffers
 * with the source mesh, and that function is the one that detaches them before
 * disposing.
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
  OUTLINE_DEFAULTS,
  buildOutline,
  createOutlineMaterial,
  disposeOutline,
} from './Outline.js';

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
 * The skin shadow's hue target.
 *
 * Faces are the one surface whose shadow stays warm — a teal-shadowed face reads
 * as corpse-lit at any distance — and the plate agrees: the darkest skin sample
 * on `bravely01.jpg` is RGB(151,130,123) against a lit RGB(186,155,147), so the
 * channels fall 0.81 / 0.84 / 0.84 and red loses least. The skin preset
 * overrides the scene shadow tint with this rose-tan; everything else inherits
 * `SHADOW_TINT`.
 */
const SKIN_SHADOW_TINT = 0xe0a98f;

/**
 * The face clamp, as the fraction of the lit level's radiance the face's shaded
 * level is lifted to. The readable spelling `faceFlatten: true` resolves to this.
 *
 * 0.80, measured rather than transcribed. The prose specs quote 0.72–0.75; the
 * plate says otherwise. Elvis's cheek on `bravely01.jpg` measures p50 178 / p95
 * 187 sRGB — the lit face is one value to within ±3% — and the darkest skin
 * anywhere on a face is 0.81 of the lit value. A painted anime face carries its
 * jaw and fringe shadow almost entirely as a *hue* shape at a very gentle value
 * break, which is exactly what this number plus the rose-tan rotation produces.
 */
const FACE_SHADOW_FLOOR = 0.80;

/**
 * Per-class rim gain.
 *
 * These numbers no longer decide how bright the rim is, and it is worth being
 * explicit about that because two previous revisions were spent tuning them as
 * though they did. `Lighting._solveCharacterRim` normalises `uRimStrength`
 * against the *largest* gain among the character classes, so scaling this whole
 * table up or down changes nothing at all on screen; only the ratios between
 * entries survive. The absolute level is bounded by `rimMax` in the composite,
 * which is downstream of the solve and is therefore the only place a cap can
 * hold.
 *
 * So these are ratios and nothing else: metal and fur carry the most, because a
 * polished edge and a fur silhouette are the two surfaces that genuinely catch a
 * back light; skin carries the least, because a glowing cranium edge is the
 * fastest way to lose a painted face.
 */
const CHARACTER_RIM_GAIN = Object.freeze({
  skin: 0.45, cloth: 0.70, hair: 0.80, metal: 1.00, fur: 0.95,
  generic: 0.70, leather: 0.70,
});

/**
 * Minimum width of the diffuse ramp, in **device pixels**.
 *
 * This is the sole remaining use of `fwidth` on the diffuse term, and its
 * direction is the opposite of the one it had. The previous revision used
 * screen-space derivatives to *narrow* the terminator to 1.3 px, which is how a
 * cel edge is made; the reference plates have no such edge, so the only job left
 * is to stop a ramp collapsing. On a character at the back of the battle stage,
 * or across a tight crease on a belt buckle, a ramp that spans a whole form in a
 * closeup can compress into one or two pixels and crawl under animation.
 * `awToonResolve` re-expands it about its own midpoint by exactly the shortfall.
 *
 * 2 px is the width at which a transition antialiases cleanly at any pixel
 * ratio. Above the threshold this costs one `min` and changes nothing.
 */
const DEFAULT_EDGE_PIXELS = 2.0;

/**
 * How much of the indirect light's *direction* a character surface trades away
 * for its own average.
 *
 * The previous revision set this to 1 implicitly — `TOON_FLAT_AMBIENT`
 * reconstructed the irradiance at zero directional order, so the hemisphere
 * fill, the probe and the grazing fresnel gave energy but no shape. That was in
 * service of keeping a hard terminator the only thing varying on the surface.
 * There is no hard terminator any more, and the plates plainly show ambient
 * direction on their figures: the white hat's shaded underside sits at 142 sRGB
 * with no key reaching it, and the ninja's trousers in `bravely05.jpg` pick up
 * the purple of the ice below.
 *
 * A quarter is still worth trading. A character standing under a strong sky
 * gradient with a fully directional ambient loses the key's authority over the
 * form, and evenly-lit-from-nowhere is the failure the whole rebuild is about.
 */
const DEFAULT_AMBIENT_FLATNESS = 0.25;

/**
 * The absolute cap on the rim's radiance, pre-tone-map, as a peak channel value.
 *
 * The number that actually keeps the rim off white, and the reason it has to
 * live here rather than in a gain: `Lighting` solves `uRimStrength` so the
 * hottest sliver in the frame lands at a pre-tone-map luminance of 0.55–0.92
 * (`RIM_PEAK_LUMA_MIN`/`MAX`), measured against whatever the largest preset gain
 * happens to be. After ACES and the sRGB transfer that band is 190–215 code
 * values — a white edge, which is the defect. No value any preset writes into
 * `rimGain` changes it, because the solve divides the gains out again.
 *
 * At 0.28 the band lands near 172 code values on a black surface, and lower on
 * anything already lit because the headroom term takes its share first. It is
 * plainly a sheen catching the edge, it is above ART_BIBLE §6's bloom threshold
 * of 1.0 only after the surface under it contributes, and it is never a line.
 */
const DEFAULT_RIM_MAX = 0.28;

/**
 * Named surface classes.
 *
 * These exist so that six characters authored by different agents cannot end up
 * with six different opinions about what skin looks like.
 *
 * Reading the fields:
 *
 *  - `terminator` / `softness` — the diffuse ramp's **midpoint** and its **full
 *    width**, both in N·L. `softness` is close to a whole unit on every class,
 *    because that is what the plates measure: light wraps most of the way round
 *    a form before the surface settles at its shaded level. A narrow value here
 *    is hard cel shading, which is the thing this table is a correction of.
 *  - `rampGamma` — bends the ramp without moving its ends. Above 1 holds the
 *    dark longer and turns into the light late; below 1 does the reverse.
 *  - `edgePixels` — the ramp's minimum width on screen, an antialias floor only.
 *  - `shadowMix` — how far the albedo's chroma rotates toward `shadowTint`.
 *  - `shadowSat` — HSV saturation multiplier inside the shadow. Above 1 by
 *    definition: saturation *increases* as value drops, which is the difference
 *    between a painted shadow and a dimmed one.
 *  - `shadowValue` — value multiplier inside the shadow. Deliberately mild; the
 *    bulk of the value drop is `shadowDepth`'s job, and doing it twice turns a
 *    shadow into a hole.
 *  - `shadowLevel` / `shadowGain` — luminance and gain of the flat fill that
 *    supplies the shaded level's hue.
 *  - `shadowLift` — the share of the key the shaded level keeps, so the dark
 *    side still carries the key's colour and dies with it at night.
 *  - `shadowDepth` — **the dark level, stated.** The shaded level is placed at
 *    exactly this fraction of the lit level's peak, after the hemisphere fill,
 *    the environment probe and the flat fill have all contributed. Without it
 *    the ratio is whatever those three terms leave over, and they lift the dark
 *    side toward the light side, which erased the form at dusk in the shipped
 *    build. The white hat on `bravely01.jpg` measures a linear 0.34 crown to
 *    shaded underside, which is where cloth sits; metal runs much deeper
 *    because its recesses on the plate measure near black (p1 = 4 sRGB against
 *    plate faces at 59).
 *  - `shadowFloor` — the face clamp: the shaded level's radiance is lifted this
 *    far toward the lit one. 0 everywhere except the face. It deliberately does
 *    *not* touch the ramp, so a flattened face still shows a full rose-tan
 *    shadow shape at a very gentle value break.
 *  - `ambientFlatness` — how much indirect direction the class trades for its
 *    own average. See `DEFAULT_AMBIENT_FLATNESS`. Inert on a non-`flat` class.
 *  - `specGain: 0` removes the highlight from the compiled program outright.
 *  - `specAlbedoMix` — how much of the surface's own colour the highlight keeps.
 *    Hair wants roughly half: a bright, slightly desaturated version of the hair
 *    colour, not a white dot. Only the anisotropic path reads it.
 *  - `specExponent` / `specThreshold` / `specSoftness` — the anisotropic lobe's
 *    tightness and the soft shoulder its falloff is centred on. The isotropic
 *    path ignores all three: it is `BRDF_GGX` driven by `roughness`, so the lobe
 *    shape is the material's own.
 *  - `specCeiling` — the HDR level the *highlight* is bounded at, separately
 *    from the rim. Metal carries by far the highest because the plate's armour
 *    specular genuinely clips (max 237 sRGB over a plate body at 59), and
 *    sharing one ceiling with the rim meant every attempt to calm the rim also
 *    flattened the metal.
 *  - `sheenGain` / `sheenRoughness` / `sheenColor` — the fur and feather lobe.
 *    Present only on classes that compile `TOON_SHEEN`.
 *  - `rimWidth` / `rimCeiling` / `rimMax` — how far the rim reaches in from the
 *    silhouette in N·V, the level its *headroom* is measured against, and the
 *    absolute cap on its own radiance. The last one is the one that matters; see
 *    `DEFAULT_RIM_MAX`.
 *  - `rimGain` — a *ratio* between classes, not a brightness. `Lighting`
 *    normalises the absolute level away; see `CHARACTER_RIM_GAIN`.
 *  - `flat` — this class is a character surface, so detail maps are dropped and
 *    `ambientFlatness` applies.
 *  - `envSpecular` — gain on the environment probe's specular. Small for every
 *    dielectric; near unity on metal, because on the plates the environment
 *    reflection *is* the armour.
 */
export const TOON_PRESETS = Object.freeze({
  generic: {
    terminator: 0.10, softness: 1.00, rampGamma: 1.00, edgePixels: DEFAULT_EDGE_PIXELS,
    shadowMix: 0.40, shadowSat: 1.20, shadowValue: 0.90,
    shadowLevel: 0.24, shadowGain: 1.0, shadowLift: 0.16, shadowFloor: 0.0,
    shadowDepth: 0.34,
    ambientGain: 0.90, ambientFlatness: 0.0, metalAlbedo: 0.0,
    specColor: 0xffffff, specGain: 0.80,
    specCeiling: 1.20,
    rimPower: 3.4, rimGain: CHARACTER_RIM_GAIN.generic, rimFloor: 0.35,
    rimWidth: 0.75, rimCeiling: 1.50, rimMax: DEFAULT_RIM_MAX,
    roughness: 0.58, metalness: 0.0, envMapIntensity: 0.45, envSpecular: 0.30,
    flat: false,
  },

  // The face is the read, and the plates put that read entirely in the painted
  // texture: drawn eyes, drawn brows, drawn mouth on an almost unshaded plane.
  // Elvis's cheek on `bravely01.jpg` measures p50 178 / p95 187 sRGB. So the
  // shading's whole job here is to stay out of the way — `shadowFloor` 0.80 is
  // the measured face clamp, the shadow tint is the warm rose-tan rather than
  // the scene's cool one, and there is no highlight at all: a specular lobe on a
  // near-spherical chibi cranium is a hotspot that slides with the camera and
  // reads as wet plastic. None of the plate's four faces has one.
  skin: {
    terminator: 0.05, softness: 1.15, rampGamma: 0.85, edgePixels: DEFAULT_EDGE_PIXELS,
    shadowTint: SKIN_SHADOW_TINT,
    shadowMix: 0.55, shadowSat: 1.10, shadowValue: 0.96,
    // 0.35, not the face's 0.80. The clamp belongs to the *face*, and putting it
    // on the class put it on forearms and bare shoulders too, which came out as
    // limbs with no form. `CharacterFactory` builds the face plate with
    // `faceFlatten: true`, so the one surface that needs the full clamp asks for
    // it by name and the rest of the skin shades — which is what the plate
    // shows: Adelle's exposed arms carry a full shadow while her cheek does not.
    shadowLevel: 0.30, shadowGain: 1.0, shadowLift: 0.30, shadowFloor: 0.35,
    // The shallowest dark level of the character classes. Skin is the brightest
    // albedo the cast owns and the plate never lets it go dark.
    shadowDepth: 0.55,
    // The most flattened ambient in the set. A face turning under a sky gradient
    // picks up a top-to-bottom ramp that competes with the painted brow line,
    // and the painted line has to win.
    ambientGain: 0.95, ambientFlatness: 0.40,
    specGain: 0.0,
    specCeiling: 1.00,
    // The tightest rim in the set and the lowest cap. Skin is the brightest
    // albedo the cast owns and `shadowFloor` keeps it lit even in shadow, so it
    // is the surface with the least headroom left — and it is the one surface
    // where a wide band eats into the painted face.
    rimPower: 3.4, rimGain: CHARACTER_RIM_GAIN.skin, rimFloor: 0.40,
    rimWidth: 0.50, rimCeiling: 1.35, rimMax: 0.18,
    roughness: 0.62, metalness: 0.0, envMapIntensity: 0.30, envSpecular: 0.06,
    flat: true,
  },

  // Hair on the plates is a carved volume with a broad, soft anisotropic sheen
  // running across the crown — Elvis's and Gloria's both fade continuously into
  // the hair mass rather than stopping at an edge. `aniso` picks the Kajiya-Kay
  // lobe (constant along the strand axis, falling off across it, so it yields a
  // band and not a dot) and `awToonSpecShape` gives it a shoulder wide enough
  // that it cannot read as a strip of plastic laid over the head.
  hair: {
    terminator: 0.10, softness: 0.95, rampGamma: 1.05, edgePixels: DEFAULT_EDGE_PIXELS,
    shadowMix: 0.42, shadowSat: 1.28, shadowValue: 0.88,
    shadowLevel: 0.22, shadowGain: 1.0, shadowLift: 0.12, shadowFloor: 0.0,
    shadowDepth: 0.26,
    ambientGain: 0.85, ambientFlatness: DEFAULT_AMBIENT_FLATNESS,
    // 0.45, down from 1.05, and the ceiling down with it. The band no longer has
    // a hard cut holding it to a shape, so its gain is now literally how bright
    // the sheen is rather than how much of the crown clears a threshold; at the
    // old value the whole crown went to the ceiling and read as a cream skullcap.
    // The Kajiya-Kay lobe is unnormalised (it lives in 0..1), so 0.45 against a
    // key at ~3 puts the band's peak just over 1.3 and the soft cap rounds its
    // shoulder rather than flattening it.
    specColor: SURFACE_TINT.SILK_SPEC, specGain: 0.45, specExponent: 96,
    specThreshold: 0.50, specSoftness: 0.05, specAlbedoMix: 0.55,
    specCeiling: 1.10,
    aniso: true, anisoShift: 0.18,
    rimPower: 3.6, rimGain: CHARACTER_RIM_GAIN.hair, rimFloor: 0.32,
    rimWidth: 0.62, rimCeiling: 1.50, rimMax: 0.26,
    roughness: 0.40, metalness: 0.0, envMapIntensity: 0.30, envSpecular: 0.10,
    flat: true,
  },

  // Matte, and matte on purpose: the plate's garments are diffuse-dominated,
  // and the layering that makes them rich is geometry and pattern rather than
  // gloss. `specGain: 0` compiles the highlight out entirely, which is both the
  // right look and the right cost on the largest surfaces in frame.
  //
  // **This is the class the garment system's patterns ride on.** A base colour
  // `map` is never dropped by the flat-class rule, and nothing in this material
  // multiplies anything into it, so a woven check, an embroidered hem or a
  // printed damask arrives on screen exactly as the garment system drew it and
  // is then shaded as one surface. Its shadow is the most saturated in the set,
  // because a garment shadow is where a painter puts the frame's richest colour.
  cloth: {
    terminator: 0.10, softness: 1.05, rampGamma: 1.00, edgePixels: DEFAULT_EDGE_PIXELS,
    shadowMix: 0.42, shadowSat: 1.30, shadowValue: 0.88,
    shadowLevel: 0.24, shadowGain: 1.0, shadowLift: 0.14, shadowFloor: 0.0,
    // The measured value: 236 sRGB crown to 142 shaded underside on the white
    // hat is a linear ratio of 0.34.
    shadowDepth: 0.34,
    ambientGain: 0.90, ambientFlatness: DEFAULT_AMBIENT_FLATNESS,
    specGain: 0.0,
    specCeiling: 1.00,
    rimPower: 3.2, rimGain: CHARACTER_RIM_GAIN.cloth, rimFloor: 0.38,
    rimWidth: 0.66, rimCeiling: 1.45, rimMax: 0.24,
    roughness: 0.92, metalness: 0.0, envMapIntensity: 0.28, envSpecular: 0.06,
    flat: true,
  },

  // Fur, feather and shearling trim — the class the brief asks for by name, and
  // one this table did not have. Adelle's collar on `bravely01.jpg` measures p5
  // 15 / p50 70 / p95 181 / max 223 sRGB in a smooth unimodal spread: no hot
  // spot, no flat mass, a broad sheen that is strongest along the silhouette of
  // each clump. `TOON_SHEEN` is a Charlie distribution with Neubelt visibility,
  // which peaks at grazing angles and is retro-reflective — the two properties
  // that separate fur from moulded plastic. The GGX highlight is compiled out
  // entirely, because one is exactly what makes it plastic.
  fur: {
    terminator: 0.05, softness: 1.30, rampGamma: 1.10, edgePixels: DEFAULT_EDGE_PIXELS,
    shadowMix: 0.40, shadowSat: 1.25, shadowValue: 0.90,
    shadowLevel: 0.22, shadowGain: 1.0, shadowLift: 0.18, shadowFloor: 0.0,
    shadowDepth: 0.28,
    ambientGain: 0.95, ambientFlatness: 0.15,
    specGain: 0.0,
    specCeiling: 1.00,
    sheen: true, sheenColor: SURFACE_TINT.SILK_SPEC, sheenGain: 0.85, sheenRoughness: 0.58,
    // The widest rim in the set, and the only one that earns it: a fur edge is
    // hundreds of grazing strand tips, so a back light genuinely lands on it.
    rimPower: 2.6, rimGain: CHARACTER_RIM_GAIN.fur, rimFloor: 0.35,
    rimWidth: 0.85, rimCeiling: 1.50, rimMax: 0.30,
    roughness: 0.95, metalness: 0.0, envMapIntensity: 0.26, envSpecular: 0.05,
    flat: true,
  },

  // Props and monster hides rather than a party garment, so this one keeps its
  // detail maps and takes a broad, soft GGX highlight from its own roughness.
  leather: {
    terminator: 0.10, softness: 1.00, rampGamma: 1.00, edgePixels: DEFAULT_EDGE_PIXELS,
    shadowMix: 0.42, shadowSat: 1.22, shadowValue: 0.88,
    shadowLevel: 0.22, shadowGain: 1.0, shadowLift: 0.14, shadowFloor: 0.0,
    shadowDepth: 0.32,
    ambientGain: 0.90, ambientFlatness: 0.0,
    specColor: 0xffffff, specGain: 0.70,
    specCeiling: 1.10,
    rimPower: 3.2, rimGain: CHARACTER_RIM_GAIN.leather, rimFloor: 0.35,
    rimWidth: 0.72, rimCeiling: 1.50, rimMax: DEFAULT_RIM_MAX,
    roughness: 0.66, metalness: 0.0, envMapIntensity: 0.40, envSpecular: 0.22,
    flat: false,
  },

  // The class the whole "make it read as metal" correction is aimed at, and the
  // one that changed most. Three things happen here that did not before:
  //
  //  - the direct highlight is `BRDF_GGX` at `roughness: 0.28`, which is a
  //    narrow Fresnel-weighted streak rather than a thresholded blob;
  //  - the indirect is the **real reflection-vector probe radiance**, not a
  //    three-step quantisation of it. The greaves in `bravely02.jpg` sweep
  //    continuously from the purple ice below to the teal aurora above, and that
  //    sweep across a curved plate is the single strongest metal cue in the
  //    reference set;
  //  - `ambientFlatness: 0` — metal is the one class that must keep every bit of
  //    the environment's direction, and flattening it is what left our armour
  //    looking like painted card.
  //
  // The recesses come from the other end: `shadowDepth: 0.20` and the lowest
  // `shadowLift` and `ambientGain` in the set, so a plate turning away from the
  // key goes properly dark. On `bravely01.jpg` the knight's shadow-side plate
  // faces read 60–80 sRGB with the gaps between them at 1–15, and the whole
  // armour region spans p1 4 / p50 59 / p99 175 / max 237.
  //
  // `metalAlbedo` restores part of the diffuse three zeroes at metalness 1: a
  // chibi pauldron carries a painted base colour under its reflection, and at
  // zero the armour is nothing but environment.
  metal: {
    terminator: 0.12, softness: 0.85, rampGamma: 1.15, edgePixels: DEFAULT_EDGE_PIXELS,
    shadowMix: 0.38, shadowSat: 1.20, shadowValue: 0.84,
    shadowLevel: 0.18, shadowGain: 1.0, shadowLift: 0.06, shadowFloor: 0.0,
    shadowDepth: 0.20,
    ambientGain: 0.75, ambientFlatness: 0.0,
    metalAlbedo: 0.35,
    // 1.0, because 'BRDF_GGX' is energy-normalised: the gain is a nudge on a
    // physically-scaled lobe, not the lobe's amplitude. At 'roughness: 0.28' its
    // peak is already ~14, so most of the streak's shape is the soft cap's
    // shoulder, which is exactly how a clipped specular on film behaves.
    specColor: 0xffffff, specGain: 1.00,
    // The one class whose highlight is allowed to clip. 2.6 pre-tone-map is
    // ~248 code values after ACES, against the plate's measured 237 peak.
    specCeiling: 2.60,
    rimPower: 3.6, rimGain: CHARACTER_RIM_GAIN.metal, rimFloor: 0.30,
    rimWidth: 0.58, rimCeiling: 1.90, rimMax: 0.30,
    roughness: 0.32, metalness: 1.0, envMapIntensity: 1.0, envSpecular: 0.85,
    flat: true,
  },

  // Kept for any geometry eye still in the scene. Under the painted-face
  // pipeline the eye is drawn into the texture and this preset is not the
  // primary path — but where it is used, an iris must never take a shadow
  // (hence the 0.9 floor) and its catch-light is the whole point, which a tight
  // GGX lobe at `roughness: 0.10` supplies.
  eye: {
    terminator: 0.0, softness: 1.40, rampGamma: 0.80, edgePixels: DEFAULT_EDGE_PIXELS,
    shadowMix: 0.15, shadowSat: 1.10, shadowValue: 0.96,
    shadowLevel: 0.12, shadowGain: 1.0, shadowLift: 0.30, shadowFloor: 0.90,
    shadowDepth: 0.90,
    ambientGain: 0.95, ambientFlatness: 0.30,
    specColor: 0xffffff, specGain: 1.40,
    specCeiling: 3.00,
    rimPower: 3.4, rimGain: 0.50, rimFloor: 0.20,
    rimWidth: 0.85, rimCeiling: 1.50, rimMax: 0.20,
    roughness: 0.10, metalness: 0.0, envMapIntensity: 0.40, envSpecular: 0.35,
    flat: true,
  },

  // Interior glow is the caller's `emissive`; this supplies the fresnel rim and
  // a sharp highlight over the top of it. A prop class, so detail maps stay.
  crystal: {
    terminator: 0.0, softness: 1.20, rampGamma: 0.90, edgePixels: DEFAULT_EDGE_PIXELS,
    shadowMix: 0.36, shadowSat: 1.18, shadowValue: 0.90,
    shadowLevel: 0.18, shadowGain: 1.0, shadowLift: 0.20, shadowFloor: 0.0,
    shadowDepth: 0.62,
    ambientGain: 0.95, ambientFlatness: 0.0,
    specColor: 0xffffff, specGain: 1.20,
    specCeiling: 3.00,
    // The one class that wants a broad wrap rather than a sliver: on glass the
    // fresnel *is* the material, so the width stays at the identity value and
    // the band is the bare `pow(1 - N·V, k)` it always was. The cap is the
    // highest in the set because a crystal's own emissive already sits at
    // 1.2–1.8 and the rim must still be visible over it.
    rimPower: 1.6, rimGain: 1.60, rimFloor: 0.30,
    rimWidth: 1.00, rimCeiling: 2.00, rimMax: 0.90,
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
 * A bare `pow(1 - N·V, k)` states a falloff but never a *reach*: the band ends
 * wherever that curve happens to fall under the shape window, and at the
 * exponent this project actually runs — `Lighting.RIM_CONTRACT` floors it at 3
 * and `CharacterFactory.BODY_RIM` pins it there, so nothing a preset here says
 * survives — the band covers the outer fifth of a chibi silhouette's radius.
 * Twenty percent of a head is a slab of light.
 *
 * Stating the reach separately is what makes the width a property of the surface
 * class (how sharply its silhouette curves away) instead of a side effect of an
 * exponent two other modules have opinions about. 0.7 puts the band's foot at
 * roughly 6% of a sphere's projected radius with the peak in the outer 1%.
 * `1.0` is the identity case and restores the bare fresnel exactly.
 */
const DEFAULT_RIM_WIDTH = 0.70;

/**
 * The level the rim's *headroom* is measured against.
 *
 * A rim added outright cannot promise not to clip, because its brightness is the
 * rig's but the surface under it is the character's — the same rim that reads as
 * a glow on a navy coat lands a lit face past 2.0, where ACES has nothing left
 * to resolve and hue collapses to white. `TOON_SURFACE_COMPOSITE` therefore
 * spends the rim against the headroom below this value.
 *
 * This is only *half* the bound, and the weaker half. It stops the rim piling on
 * top of an already-bright surface; it does nothing about the rim being too
 * bright in the first place, which on a dark coat is the whole of the defect.
 * `rimMax` is the half that does. See `DEFAULT_RIM_MAX`.
 */
const DEFAULT_RIM_CEILING = 1.50;

/**
 * The level the *highlight* is bounded at, separately from the rim.
 *
 * The two used to share one ceiling, and that conflation is why every previous
 * attempt to calm the rim also flattened the metal. They want opposite things:
 * the reference armour's specular genuinely clips — `bravely01.jpg` measures the
 * knight's plates at p50 59 / p99 175 / p99.9 214 / max 237 sRGB — while the rim
 * must never come near it. `metal` and `crystal` carry a much higher value than
 * this default; the matte classes carry a lower one.
 */
const DEFAULT_SPEC_CEILING = 1.20;

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
 * Build a stylised character material.
 *
 * @param {Object} [opts]
 * @param {string} [opts.preset='generic'] key into {@link TOON_PRESETS}.
 * @param {import('./Lighting.js').Lighting|{uniforms:Object}} [opts.lighting]
 *   the lighting rig (or anything exposing its `uniforms` block). Supplying it
 *   aliases the key/rim uniforms so they track the rig for free.
 * @param {THREE.ColorRepresentation} [opts.color=0xffffff] base albedo.
 * @param {THREE.Texture} [opts.map] base colour map — the painted face texture,
 *   or a garment pattern. Never dropped, and nothing in this material multiplies
 *   anything into it.
 * @param {boolean} [opts.detailMaps] force detail maps on a `flat` preset. They
 *   are dropped by default on every character class.
 * @param {number} [opts.terminator] the diffuse ramp's midpoint, in N·L.
 * @param {number} [opts.softness] the diffuse ramp's **full width**, in N·L.
 *   Near 1 on every class; a narrow value is hard cel shading, which the
 *   reference plates do not have.
 * @param {number} [opts.rampGamma] bends the ramp without moving its ends.
 * @param {number} [opts.edgePixels] minimum ramp width on screen; antialias only.
 * @param {number} [opts.shadowFloor] how far the shaded level's radiance is
 *   lifted toward the lit one. `0.80` is the face value; see also `faceFlatten`.
 * @param {boolean} [opts.faceFlatten] shorthand for `shadowFloor: 0.80`.
 * @param {THREE.ColorRepresentation} [opts.shadowTint] hue target for the
 *   shadow albedo. Defaults to the scene shadow tint (warm rose-tan on `skin`).
 * @param {number} [opts.shadowMix] 0–1, how far the albedo's chroma rotates.
 * @param {number} [opts.shadowSat] HSV saturation multiplier in shadow, > 1.
 * @param {number} [opts.shadowValue] value multiplier in shadow, < 1.
 * @param {number} [opts.shadowLevel] luminance of the flat shadow fill.
 * @param {number} [opts.shadowLift] share of the key the shaded level keeps.
 * @param {number} [opts.shadowDepth] the shaded level, as a fraction of the lit
 *   level's peak. Stated rather than left over: 0.34 measured for cloth, 0.20
 *   for metal.
 * @param {number} [opts.ambientFlatness] 0–1, how much indirect *direction* the
 *   surface trades for its own average. Inert on a non-`flat` class.
 * @param {number} [opts.specGain] 0 compiles the highlight out entirely.
 * @param {number} [opts.specCeiling] HDR bound on the highlight, independent of
 *   the rim's. Metal carries a high one because its ping is allowed to clip.
 * @param {number} [opts.sheenGain] 0 compiles the fur/feather lobe out.
 * @param {number} [opts.sheenRoughness] the Charlie lobe's width; higher is
 *   softer and more fur-like.
 * @param {number} [opts.rimGain] the rim's *ratio* against the other classes.
 *   `Lighting` normalises the absolute level away — bound it with `rimMax`.
 * @param {number} [opts.rimWidth] the rim band's inner edge, in `N·V`. 1 is the
 *   bare fresnel; lower values hold the band to the outer silhouette.
 * @param {number} [opts.rimCeiling] the level the rim's headroom is measured
 *   against.
 * @param {number} [opts.rimMax] absolute cap on the rim's own radiance. The
 *   bound that keeps the band off white; see `DEFAULT_RIM_MAX`.
 * @param {boolean} [opts.aniso] force the anisotropic highlight on or off.
 * @param {THREE.Vector3} [opts.anisoDirection] world-space strand axis.
 * @returns {THREE.MeshStandardMaterial} patched, ready to add to a scene.
 */
export function createToonMaterial(opts = {}) {
  const presetName = opts.preset && TOON_PRESETS[opts.preset] ? opts.preset : 'generic';
  const p = { ...TOON_PRESETS.generic, ...TOON_PRESETS[presetName] };

  const specGain = opts.specGain ?? p.specGain ?? 0;
  // A zero-gain highlight is not the same thing as no highlight. The classes the
  // reference gives no gloss (skin and cloth above all) must not merely multiply
  // the lobe by zero — the term drops out of the compiled program, so it cannot
  // come back through a stray `updateToonUniforms` and cannot cost a `BRDF_GGX`
  // per light per fragment on the largest surfaces in frame.
  const hasSpec = specGain > 0;
  const aniso = hasSpec && (opts.aniso ?? p.aniso ?? false);

  // The fur / feather lobe, compiled in on the same terms. It is deliberately
  // independent of `hasSpec`: fur wants a sheen and no GGX highlight at all,
  // which is the whole distinction between fur and moulded plastic.
  const sheenGain = opts.sheenGain ?? p.sheenGain ?? 0;
  const hasSheen = sheenGain > 0 && (opts.sheen ?? p.sheen ?? true);

  // A character class never receives a procedural detail map: in this project
  // every one of them is fBm from `AssetForge`, and on a character they read as
  // dirt. Callers with a genuine reason opt back in per material rather than by
  // editing this table. The base colour `map` is deliberately not in that set —
  // a garment pattern and a painted face both arrive that way.
  const flat = opts.detailMaps === undefined ? (p.flat ?? false) : !opts.detailMaps;
  const detail = {};
  for (const key of DETAIL_MAP_KEYS) detail[key] = flat ? null : (opts[key] ?? null);

  // `faceFlatten` is the readable spelling of the face clamp; `shadowFloor` is
  // the same control with the value exposed. Resolved here rather than inline so
  // that `faceFlatten: false` can genuinely turn the clamp *off* on a preset
  // that carries one.
  const shadowFloor = opts.shadowFloor
    ?? (opts.faceFlatten === undefined
      ? (p.shadowFloor ?? 0.0)
      : (opts.faceFlatten ? FACE_SHADOW_FLOOR : 0.0));

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

    // ---- the diffuse ramp --------------------------------------------------
    uToonTerminator: { value: opts.terminator ?? p.terminator },
    uToonSoftness: { value: opts.softness ?? p.softness },
    uToonEdgePixels: { value: opts.edgePixels ?? p.edgePixels ?? DEFAULT_EDGE_PIXELS },
    uToonRampGamma: { value: opts.rampGamma ?? p.rampGamma ?? 1.0 },
    uToonShadowFloor: { value: shadowFloor },
    uToonShadowLift: { value: opts.shadowLift ?? p.shadowLift },
    uToonShadowDepth: { value: opts.shadowDepth ?? p.shadowDepth ?? 0.34 },

    // ---- shadow colour: hue shift, saturation up --------------------------
    uToonShadowTint: { value: chromaUnit(shadowTint) },
    uToonShadowHue: { value: opts.shadowMix ?? p.shadowMix },
    uToonShadowSat: { value: opts.shadowSat ?? p.shadowSat },
    uToonShadowValue: { value: opts.shadowValue ?? p.shadowValue },
    // Enforced in the shader rather than left to an author to remember: a warm
    // albedo rotated halfway to a cool tint passes through the neutral axis, so
    // the rule has to hold where the mix happens.
    uToonShadowSatFloor: { value: opts.shadowSatFloor ?? SHADOW_SAT_TARGET },

    // ---- fills and the environment ----------------------------------------
    uToonShadowFill: {
      value: chromaAt(opts.shadowColor ?? shadowTint, opts.shadowLevel ?? p.shadowLevel),
    },
    uToonShadowGain: { value: opts.shadowGain ?? p.shadowGain },
    uToonAmbientGain: { value: opts.ambientGain ?? p.ambientGain },
    uToonAmbientFlatness: {
      value: opts.ambientFlatness ?? p.ambientFlatness ?? DEFAULT_AMBIENT_FLATNESS,
    },
    uToonMetalAlbedo: { value: opts.metalAlbedo ?? p.metalAlbedo ?? 0.0 },
    uToonEnvSpecular: { value: opts.envSpecular ?? p.envSpecular },

    // ---- highlight and rim bounds -----------------------------------------
    // Two separate ceilings, and the separation is the point: armour's ping is
    // allowed to clip and the rim never may. See `DEFAULT_SPEC_CEILING`.
    uToonSpecCeiling: { value: opts.specCeiling ?? p.specCeiling ?? DEFAULT_SPEC_CEILING },
    uToonRimPower: { value: opts.rimPower ?? p.rimPower },
    uToonRimGain: { value: opts.rimGain ?? p.rimGain },
    uToonRimFocus: { value: toVec2(opts.rimFocus, DEFAULT_RIM_FOCUS) },
    uToonRimShape: { value: toVec2(opts.rimShape, DEFAULT_RIM_SHAPE) },
    uToonRimFloor: { value: opts.rimFloor ?? p.rimFloor },
    uToonRimWidth: { value: opts.rimWidth ?? p.rimWidth ?? DEFAULT_RIM_WIDTH },
    uToonRimCeiling: { value: opts.rimCeiling ?? p.rimCeiling ?? DEFAULT_RIM_CEILING },
    uToonRimMax: { value: opts.rimMax ?? p.rimMax ?? DEFAULT_RIM_MAX },

    // ---- battle feedback --------------------------------------------------
    uToonPulse: { value: toColor(opts.pulse ?? 0x000000) },
    uToonPulseRate: { value: opts.pulseRate ?? 0.0 },
    uToonTime: { value: 0.0 },
  };

  if (hasSpec) {
    uniforms.uToonSpecColor = { value: toColor(opts.specColor ?? p.specColor ?? 0xffffff) };
    uniforms.uToonSpecGain = { value: specGain };
    uniforms.uToonSpecAlbedoMix = { value: opts.specAlbedoMix ?? p.specAlbedoMix ?? 0.0 };
  }

  // The lobe-shaping trio belongs to the anisotropic path alone. The isotropic
  // highlight is three's own `BRDF_GGX` driven by `material.roughness`, so an
  // exponent and a threshold would have nothing to act on there — allocating
  // them anyway is how a caller comes to believe a number is doing something.
  if (aniso) {
    uniforms.uToonAnisoDirection = { value: toDirection(opts.anisoDirection, DEFAULT_ANISO_DIR) };
    uniforms.uToonAnisoShift = { value: opts.anisoShift ?? p.anisoShift ?? 0.12 };
    uniforms.uToonSpecExponent = { value: opts.specExponent ?? p.specExponent ?? 96 };
    uniforms.uToonSpecThreshold = { value: opts.specThreshold ?? p.specThreshold ?? 0.5 };
    uniforms.uToonSpecSoftness = { value: opts.specSoftness ?? p.specSoftness ?? 0.05 };
  }

  if (hasSheen) {
    uniforms.uToonSheenColor = {
      value: toColor(opts.sheenColor ?? p.sheenColor ?? SURFACE_TINT.SILK_SPEC),
    };
    uniforms.uToonSheenGain = { value: sheenGain };
    uniforms.uToonSheenRoughness = { value: opts.sheenRoughness ?? p.sheenRoughness ?? 0.6 };
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
  if (hasSheen) material.defines.TOON_SHEEN = '';
  // A character surface trades part of its indirect *direction* for the same
  // light's average — the same `flat` classification that drops the fBm detail
  // maps. How much is `uToonAmbientFlatness`; the define only decides whether
  // the surface is a candidate. See `RE_IndirectDiffuse_Toon`.
  if (flat) material.defines.TOON_FLAT_AMBIENT = '';

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
  const cacheKey = `aw-toon-surface|${presetName}`
    + `|${hasSpec ? (aniso ? 'aniso' : 'iso') : 'nospec'}|${hasSheen ? 'sheen' : 'nosheen'}`
    + `|${flat ? 'flatamb' : 'amb'}`;
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
      console.error(`[ToonMaterial] anchor "${anchor}" missing from ${label}; character shading incomplete.`);
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
 *  absent (the highlight on a `specGain: 0` material, the lobe trio on an
 *  isotropic one, the sheen on anything that is not fur) are skipped rather than
 *  created: the uniform is not in the compiled program either. */
const SCALAR_KEYS = Object.freeze({
  time: 'uToonTime',
  terminator: 'uToonTerminator',
  softness: 'uToonSoftness',
  edgePixels: 'uToonEdgePixels',
  rampGamma: 'uToonRampGamma',
  shadowFloor: 'uToonShadowFloor',
  shadowLift: 'uToonShadowLift',
  shadowDepth: 'uToonShadowDepth',
  shadowMix: 'uToonShadowHue',
  shadowSat: 'uToonShadowSat',
  shadowValue: 'uToonShadowValue',
  shadowSatFloor: 'uToonShadowSatFloor',
  shadowGain: 'uToonShadowGain',
  ambientGain: 'uToonAmbientGain',
  ambientFlatness: 'uToonAmbientFlatness',
  metalAlbedo: 'uToonMetalAlbedo',
  envSpecular: 'uToonEnvSpecular',
  specExponent: 'uToonSpecExponent',
  specThreshold: 'uToonSpecThreshold',
  specSoftness: 'uToonSpecSoftness',
  specAlbedoMix: 'uToonSpecAlbedoMix',
  specCeiling: 'uToonSpecCeiling',
  sheenGain: 'uToonSheenGain',
  sheenRoughness: 'uToonSheenRoughness',
  rimPower: 'uToonRimPower',
  rimGain: 'uToonRimGain',
  rimFloor: 'uToonRimFloor',
  rimWidth: 'uToonRimWidth',
  rimCeiling: 'uToonRimCeiling',
  rimMax: 'uToonRimMax',
  pulseRate: 'uToonPulseRate',
  anisoShift: 'uToonAnisoShift',
});

/** Colour options written verbatim as radiance. */
const COLOR_KEYS = Object.freeze({
  keyColor: 'uKeyColor',
  specColor: 'uToonSpecColor',
  sheenColor: 'uToonSheenColor',
  pulse: 'uToonPulse',
});

/**
 * Push art or runtime state into a material built by this module.
 *
 * Safe to call every frame — it touches only the keys present in `opts` and
 * allocates nothing on the scalar and vector paths. Safe to call on a material
 * that has not compiled yet. It does **not** drive the ink line: outline
 * materials are `render/Outline.js`'s, and its `setOutlineWidth` and
 * `setOutlineEnabled` are the API for them, so that one module stays the only
 * place the line's weight and its existence are decided.
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
    u.uToonShadowFloor.value = opts.faceFlatten ? FACE_SHADOW_FLOOR : 0.0;
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

  return material;
}

/* -------------------------------------------------------------------------- */
/* Inverted-hull outline — thin adapters over render/Outline.js               */
/* -------------------------------------------------------------------------- */

/**
 * The reference viewport height the legacy fraction-of-viewport spelling is
 * resolved against.
 *
 * This module used to own a *second*, independent inverted-hull implementation,
 * and the two had drifted: it shared the source geometry (so it pushed along
 * `toCreasedNormals`' split normals and tore the shell open at every hard edge —
 * a gap in the line exactly at a hair clump's point or a boot's corner),
 * defaulted `vertexColors` on (so a hull with no colour attribute collapsed
 * `diffuseColor` to zero and abandoned the per-albedo tint for a
 * fixed swatch), carried no floor under the darkened colour, and registered with
 * nothing, so `setOutlineWidth` could not reach it. The enemy — the largest
 * figure in frame and the one the review measured the broken contour on — was
 * outlined by that copy while the party was outlined by `render/Outline.js`.
 *
 * Two implementations of one technique is the actual defect; there is now one.
 * These functions are kept because callers hold them, and they translate the one
 * argument whose units differ: `Outline.js` takes line weight in **device
 * pixels**, which is what "constant screen-space weight" means, while this
 * entry point documented a fraction of viewport height. 1080p is the capture
 * harness's viewport, so it is the only defensible constant to resolve the old
 * spelling against.
 *
 * Note that these adapters inherit `Outline.js`'s project-wide switch, which now
 * ships **off**: the reference plates carry no ink line, and the measurements
 * behind that are in that module's header. A caller that wants one calls
 * `setOutlineEnabled(true)` before building.
 */
const OUTLINE_REFERENCE_HEIGHT = 1080;

/**
 * Fallback line level for a hull with no albedo and no per-vertex colour.
 *
 * `Outline.js` derives the line from the surface underneath, and with nothing to
 * derive from its own fallback is the scene shadow tint — but a caller reaching
 * this adapter without an albedo (the husks in `LookdevScene`) would otherwise
 * fall through to its `0xffffff` default and get a line *lighter* than the body
 * it wraps, which is an inversion, not a line. Naming the colour here keeps that
 * impossible.
 *
 * Raised from 0.035 to track `OUTLINE_DEFAULTS.darkness` going from 0.18 to
 * 0.30: against the bright sunlit meadow the plates actually show, a line this
 * dark reads as a black border rather than as a contour, and the two constants
 * expressing the same judgement have to move together or a hull built through
 * this adapter comes out heavier than one built directly.
 */
const DEFAULT_OUTLINE_LEVEL = 0.060;

/**
 * Build the material for an inverted-hull outline.
 *
 * @param {Object} [opts] forwarded to `Outline.createOutlineMaterial`, except:
 * @param {number} [opts.width] fraction of viewport height (this module's
 *   historical spelling), resolved against 1080p. Pass `pixels` instead to state
 *   the weight the way `Outline.js` does.
 * @param {number} [opts.pixels] line weight in device pixels; wins over `width`.
 * @param {boolean} [opts.vertexColors=false] derive the line per fragment from
 *   the hull's colour attribute. Only correct when the geometry carries one.
 * @returns {THREE.MeshBasicMaterial}
 */
export function createToonOutlineMaterial(opts = {}) {
  const vertexColors = opts.vertexColors ?? false;
  const width = opts.pixels
    ?? (opts.width !== undefined ? opts.width * OUTLINE_REFERENCE_HEIGHT : OUTLINE_DEFAULTS.width);

  return createOutlineMaterial({
    ...opts,
    name: opts.name ?? 'toon:outline',
    width,
    vertexColors,
    // Only when the caller named neither, and only for a flat hull: with vertex
    // colours the fragment stage derives the line and an explicit colour would
    // override every zone with one value.
    color: opts.color ?? (opts.albedo === undefined && !vertexColors
      ? chromaAt(LIGHT.SHADOW_TINT, opts.level ?? DEFAULT_OUTLINE_LEVEL)
      : undefined),
  });
}

/**
 * Attach an inverted-hull outline to a mesh.
 *
 * @param {THREE.Mesh} source
 * @param {Object} [opts] forwarded to `Outline.buildOutline`.
 * @returns {THREE.Mesh|THREE.SkinnedMesh|null} null if `source` has no geometry.
 */
export function createToonOutline(source, opts = {}) {
  return buildOutline(source, opts);
}

/** Detach and release a hull built by {@link createToonOutline}. */
export function disposeToonOutline(outline) {
  disposeOutline(outline);
}
