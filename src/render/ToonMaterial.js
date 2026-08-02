/**
 * ToonMaterial — the character shading model.
 *
 * ## The ruling this module implements
 *
 * Three documents in this repo specify character shading and they contradict
 * each other on four of the five decisions that matter. `docs/ANIME_PIPELINE.md`
 * §2/§4/§6 demand flat saturated colour, a hard two-band terminator, a
 * hard-edged specular shape and an ink outline. `docs/BRAVELY_REFERENCE.md`
 * §1/§4 reverses all four.
 *
 * **The plates decide.** `docs/reference/README.md` says so in as many words —
 * where a written document and the images disagree, the images win, because the
 * prose was transcribed by eye before the plates were available. A previous
 * revision ruled for ANIME_PIPELINE and built a strict two-level cel model. Held
 * against `bravely01.jpg` it does not survive contact:
 *
 * Taking a patch wholly inside one costume zone and measuring the longest
 * horizontal run that holds within ±2 sRGB code values, as a fraction of the
 * zone's width —
 *
 * | zone | `bravely01.jpg` | `shots/now/cast-stage.png` |
 * |---|---|---|
 * | knight pauldron (42 px) | 4.8% | 28.3% |
 * | knight thigh plate (47 px) | 8.5% | 33.3% (torso, 42 px) |
 * | white hat crown (110 px) | 5.5% | 42.0% (green robe, 50 px) |
 * | red coat chest (60 px) | 18.3% | 22.7% (purple robe, 55 px) |
 *
 * and a 48 px scanline across the plate's left pauldron reads
 * `113 105 92 92 95 90 82 78 79 75 64 51 38 32 …`, a continuous ramp through
 * roughly forty values, where ours read `183 177 177 177 176 177 180 179 180 …`
 * for forty pixels and then fell off a cliff. Our figures were papercraft
 * because the model gave a surface literally two values.
 *
 * So this revision keeps everything about the cel model that the plates support
 * — a *stated* dark level, a hue-rotated shadow, a bounded rim, a painted face —
 * and reverses the two things they contradict: the drawn terminator and the
 * thresholded highlight blob. It is soft stylised shading with form, not flat
 * fills and not plain PBR.
 *
 * ## What that means mechanically
 *
 *  1. **A form band whose width is a per-class decision.** `terminator` is its
 *     midpoint in N·L and `softness` its **half-width**. The character classes
 *     run it narrow — 0.05 on cloth, 0.10–0.14 on skin, hair, metal and fur — so
 *     a garment resolves into two levels with a boundary you can point at, which
 *     is what the plates' costumes show and what the wide-ramp revision could
 *     not produce. The prop classes stay at 0.50–0.60, because `world/Flora.js`
 *     shades the meadow through `generic` and banding it collapsed the capture's
 *     luminance range. `awToonEdge` antialiases the narrow ones.
 *  2. **A cast shadow joins the form shadow.** The composite intersects the ramp
 *     with the key's visibility, so a shadow falling across a character lands it
 *     in the shadow level with one contour, rather than dimming the lit one.
 *  3. **The dark side is a stated level.** `shadowDepth` places the shaded level
 *     at a fixed fraction of the lit one after every fill has had its say, so the
 *     value structure holds at noon, at dusk and by torchlight.
 *  4. **The shadow is a hue shift with rising saturation**, never a darkened
 *     copy — the one point every document and the plates agree on.
 *  5. **The specular response is chosen per shading class, at compile time.**
 *     Cloth, skin, fur and the whole meadow have no lobe and no environment
 *     reflection — the entire chain leaves the program. Metal takes a tight
 *     glint at a roughness the lobe clamps to 0.25, plus the continuous PMREM
 *     reflection that is the plate's strongest metal cue. Hair takes one crisp
 *     Kajiya-Kay arc bounded at 1.4× the surface it sits on. Leather, crystal
 *     and the geometry eye keep the broad shoulder that used to be shared by
 *     everything, which is where it was always right. See `MATTE_CLASSES`.
 *  6. **The face resists shadowing.** `faceFlatten` puts the face's dark level
 *     at 0.75 of its lit one so the fringe and jaw shadow keep their contour and
 *     their rose-tan hue at a step too shallow to carve the painted eyes into
 *     darkness.
 *  7. **Fur and feather are the one exception.** `preset: 'fur'` compiles a
 *     Charlie/Neubelt sheen instead of a lobe, because a trim's contour is meant
 *     to read broken; a highlight shape on it reads as moulded plastic.
 *
 * **The ink line is `render/Outline.js`'s call, not this module's**, and it
 * still ships enabled. Nothing here draws a line any more: the rim used to be
 * resolved into a hard 1.3 px band and was drawing a second, light-coloured
 * outline down every internal contour — the cyan piping on the knight in our
 * capture. That is gone.
 *
 * **No hard terminator anywhere.** `docs/reference/README.md` and the plates are
 * unambiguous, and `characters/FaceTexture.js` already builds its face on the
 * same finding ("no hard terminator and no outline … there is no terminator
 * anywhere on this face"). The face and the body now agree.
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
  outlineColorFor,
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
 * The face clamp: the face's dark level, as a fraction of its lit level. The
 * readable spelling `faceFlatten: true` resolves to this.
 *
 * ANIME_PIPELINE §2: "clamp the face's shadow term to a minimum of ~0.75 so a
 * nose or fringe never carves the face into darkness." 0.75 is the document's
 * number; what it is applied *to* is the one judgement call, and it is
 * `shadowDepth` rather than the band.
 *
 * Flooring the band was tried and measured: it lifts the whole face toward its
 * lit level, and on the capture that pushed the painted sclera — near-white by
 * construction, `#F4F7FA` — past the post chain's bloom threshold, so the bloom
 * spread over the iris and the eye vanished into a white blob. A dark *level* at
 * 0.75 instead leaves the band switching normally, so the fringe and jaw shadow
 * keep their drawn contour and the rose-tan rotation from `SKIN_SHADOW_TINT`,
 * while the step between the two levels is a quarter-stop — too shallow for a
 * fringe to cut a hole with, which is exactly what the document is asking for.
 */
const FACE_SHADOW_DEPTH = 0.75;

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
 * The **antialias floor** for the specular shape, in device pixels.
 *
 * This used to be the width the terminator was *compressed* to, and compressing
 * it is what made every costume zone a flat fill. `awToonEdge` can now only
 * widen a transition that has collapsed, never narrow one, which is what makes
 * it safe to put back on the form band — and it is back, for the narrow classes
 * only, because a five-degree terminator genuinely goes sub-pixel on a limb seen
 * near-tangent and stair-steps the length of the silhouette there. The specular
 * shapes need it for the same reason at the other end of the scale: metal's lobe
 * runs at exponent 510 and hair's arc is 0.05 wide.
 *
 * 1.5 px rather than the old 1.3: as a floor the number wants to be comfortably
 * above one pixel at any device pixel ratio, and nothing is being held *to* it
 * any more, so erring wide costs only a slightly softer highlight edge on the
 * few fragments that reach it.
 */
const DEFAULT_EDGE_PIXELS = 1.5;

/**
 * How much of the indirect light's *direction* a character surface trades away
 * for its own average.
 *
 * A figure under a strong sky gradient picks up a top-to-bottom ramp from the
 * hemisphere fill and the probe. On a **face** that ramp competes with the
 * painted brow line, which has to win — that is the whole case for flattening,
 * and it is a case about the face, not about a coat.
 *
 * The cel revision applied it at 0.35–0.75 across every character class, and
 * that was the third thing flattening the costumes. The key term carries no N·L
 * variation by construction (`awToonKey` sums `directLight.color` unweighted, so
 * one terminator can describe the form), and the band selecting between the two
 * levels had been compressed to a line — which left the residual directional
 * ambient as the only term still varying across a surface, and it was being
 * traded away too.
 *
 * 0.28 for a general character surface. The residue is now a real second
 * gradient sitting under the form ramp, subtler and differently oriented, which
 * is what stops a figure reading as though it were lit by one lamp in a void.
 * `skin` still runs high, because the painted face is the one place the argument
 * for flattening actually holds.
 */
const DEFAULT_AMBIENT_FLATNESS = 0.28;

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
 * anything already lit because the headroom term takes its share first. That is
 * the prop-class default and it is unchanged.
 *
 * The **character** classes now run 0.16–0.28, below it. Two reasons, both from
 * the capture: the rim used to be resolved into a hard band, so its energy was
 * concentrated into a 1.3 px line and the cap was effectively sizing a line
 * rather than a wash — spread over a soft profile the same cap reads brighter.
 * And with the form ramp restored the rim is no longer the only thing describing
 * the edge of a figure, so it can afford to be quieter. The cyan piping down the
 * knight's cape in the previous capture was this term at its old level.
 */
const DEFAULT_RIM_MAX = 0.28;

/**
 * How much of the rig's rim **chroma** a surface keeps.
 *
 * `Lighting` publishes the back light's colour as `LIGHT.RING_GLOW` (`#5FB8B0`,
 * a strong teal) because that is the colour of the ring in this world's sky.
 * How much of it a *surface* returns is a material question, and the plates
 * answer it: no character on `bravely01.jpg` or `bravely02.jpg` carries a
 * coloured contour anywhere. Separation is done by value and by the ink line.
 *
 * In `shots/mp0-cast/cast-stage.png` a teal line ran the length of the knight's
 * pauldron, the whole back of her hair, the ponytail, the sword and the cape
 * edge, and the same line appears on every other figure. A contour in a colour
 * the costume does not contain reads as a *coating* over the whole figure —
 * after the hair band it was the loudest plastic cue in the frame, and the one
 * the previous revision's "no more cyan piping" note did not actually remove
 * (it removed the piping's hard *edge*; the colour survived as a wash).
 *
 * Spent as a desaturation at constant peak rather than as a dim, so the rig's
 * solved level survives — `Lighting._solveCharacterRim` sizes `uRimStrength`
 * against the character gains and must keep getting the separation it sized
 * for. `rimMax` remains the bound on the level; this bounds only the hue.
 *
 * 0.22–0.30 on the character classes: enough teal left that the back light is
 * legibly *this* world's ring rather than a white studio kicker, far too little
 * to read as a piped edge. The prop classes keep more, and `crystal` keeps all
 * of it — on glass the rim genuinely is the material.
 */
const DEFAULT_RIM_TINT = 0.28;

/**
 * The ceiling on **surface plus highlight**, as a pre-tone-map peak.
 *
 * The bound the model was missing, and the one the plate comparison is stated
 * in. `specCeiling` bounds the mark in absolute radiance and `specRelMax`
 * bounds it as a ratio to the surface underneath; neither can promise that the
 * pixel does not clip, because a mark at 1.4× a surface already near the top of
 * the tone curve is still white.
 *
 * Measured as the fraction of a zone above sRGB 235 —
 *
 * | zone | `bravely01.jpg` | `shots/mp0-cast` |
 * |---|---|---|
 * | hair mass | 0.00–0.02% (peak 225–245) | **26.07%** (peak 254) |
 * | pauldron | 0.01% (peak 238) | 1.41% (peak 255) |
 * | meadow | 0.00% | 0.00% |
 *
 * A quarter of every hair mass on the cast was at the clip point: the arc was
 * not reading as a band, it was a hole with a ragged edge. Both existing bounds
 * were satisfied throughout.
 *
 * 1.00 is the default and is deliberately generous — it is a *guard*, not a
 * grade, and on a mid-valued surface with a discreet glint it never engages
 * (the soft shoulder is the identity below half the ceiling). The classes whose
 * marks were actually clipping state their own, lower: hair at 0.66 and metal
 * at 0.92 put the brightest fragment of each at roughly the value the plate's
 * brightest hair and brightest pauldron fragment measure.
 */
const DEFAULT_SPEC_SUM = 1.00;

/**
 * Named surface classes.
 *
 * These exist so that six characters authored by different agents cannot end up
 * with six different opinions about what skin looks like.
 *
 * Reading the fields:
 *
 *  - `terminator` / `softness` — the form band's **midpoint** and its
 *    **half-width**, both in N·L, and the pair that decides which of two
 *    techniques a class is shaded by. Narrow (0.05–0.14, every character class)
 *    is a toon terminator: two levels and a boundary. Wide (0.50–0.60, the prop
 *    classes) is a falloff spanning half the N·L range. Both have shipped as the
 *    *only* answer at different times and both were wrong as a global: flat
 *    fills on a meadow, an airbrush on a coat.
 *  - `rampGamma` — the band's curve. It does the stylising on a wide band and
 *    almost nothing on a narrow one, so the narrow classes run it at 1 and place
 *    their edge with `terminator`.
 *  - `edgePixels` — the antialias floor, in device pixels; it can only widen a
 *    collapsed transition, never narrow one. Applied to the specular shapes
 *    always and to the form band on the narrow classes. See
 *    `DEFAULT_EDGE_PIXELS` and `NARROW_BAND_MAX`.
 *  - `highBand` / `highGain` — the optional second lift on the lit side, for
 *    hair and metal only. `highBand` is its midpoint in N·L, above `terminator`;
 *    `highGain` scales the lit level inside it. It shares `softness`, so it is a
 *    broad gradient over the key-facing side rather than a drawn band — on the
 *    plate the bright pass over an armour crown grades across roughly a third of
 *    the piece. Absent on every other class, and compiled out there.
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
 *    shaded underside, which is where cloth sits; metal runs deeper because its
 *    recesses on the plate measure near black (p1 = 4 sRGB against plate faces
 *    at 59). Under the cel ruling these run a little deeper still: with a hard
 *    edge the dark side is a *mass*, and a mass at 0.34 of the light against a
 *    bright meadow is what the review called a dead value structure.
 *  - `shadowFloor` — the minimum the class's **shadow term** is held at, for a
 *    surface where a shadow is not a stylistic choice but an error: an iris
 *    carrying one reads as a dead eye. 0 on every class but `eye`. The *face*
 *    clamp is `faceFlatten`, which bounds how dark the shadow may go rather than
 *    suppressing its shape; see `FACE_SHADOW_DEPTH`.
 *  - `ambientFlatness` — how much indirect direction the class trades for its
 *    own average. See `DEFAULT_AMBIENT_FLATNESS`. Inert on a non-`flat` class.
 *  - `envLevels` — how many flat levels the environment reflection is quantised
 *    into. **0 on every class**, metal included, and the arithmetic is why: at
 *    three levels a peak radiance below 1/6 quantises to exactly zero and
 *    everything up to 1/2 snaps to the single constant 1/3, and with
 *    `LookdevScene` authoring `environmentIntensity = 0.28` the armour sat inside
 *    that dead zone. The reflection was not being stylised, it was being deleted
 *    — on the one class whose whole read is environment reflection. The knob
 *    stays for a caller who deliberately wants a stepped prop.
 *  - `specGain: 0` removes the highlight from the compiled program outright, and
 *    membership of `MATTE_CLASSES` makes that unconditional — a caller cannot
 *    pass a gain into cloth, skin, fur or the meadow.
 *  - `specAlbedoMix` — how much of the surface's own colour the band keeps. Hair
 *    wants roughly half: a bright, slightly desaturated version of the hair
 *    colour, not a white dot. Only the hair path reads it.
 *  - `specThreshold` / `specSoftness` — the lobe value the mark's boundary sits
 *    at, and the width of the transition over it. Read by all three lobes, and
 *    what they *mean* differs by class because the shapes differ: on metal the
 *    pair is a grade from the threshold up toward the mirror direction with
 *    nothing below it, on hair a symmetric arc edge, on a prop the old shoulder
 *    with a graded core. `specExponent` belongs to the hair path alone; metal
 *    derives its exponent from a roughness clamped inside the lobe, and the prop
 *    path from `roughness` unmodified, so that number keeps meaning the same
 *    thing here and on a stock material.
 *  - `specRelMax` — the bound stated against the diffuse level underneath rather
 *    than in absolute radiance: the mark may reach `1 + specRelMax` times the
 *    surface it sits on and no further. 0 disables it. Hair runs 0.40 and it is
 *    the number that keeps a hair band reading as hair rather than as chrome; an
 *    absolute ceiling cannot express it, because the same value that is discreet
 *    on steel is a blaze on a dark braid.
 *  - `specCeiling` — the HDR level the *highlight* is bounded at, separately
 *    from the rim. Metal carries the highest because armour is the one surface
 *    whose ping is allowed to approach the clip point, and sharing one ceiling
 *    with the rim meant every attempt to calm the rim also flattened the metal.
 *    It is bounded well below white all the same: the review measured "clipped
 *    speculars with no bloom", and a blob whose whole area sits at the clip point
 *    is a hole in the frame rather than a highlight.
 *  - `specSum` — the bound on **surface plus mark**, and the only one of the
 *    three that can promise the pixel does not clip; the other two are stated
 *    on the mark alone and were both satisfied while a quarter of every hair
 *    mass on the cast sat at 255. See `DEFAULT_SPEC_SUM`. It bounds the fur
 *    sheen too.
 *  - `sheenGain` / `sheenRoughness` / `sheenColor` — the fur and feather lobe.
 *    Present only on classes that compile `TOON_SHEEN`.
 *  - `rimWidth` / `rimCeiling` / `rimMax` — how far the rim reaches in from the
 *    silhouette in N·V, the level its *headroom* is measured against, and the
 *    absolute cap on its own radiance. The last one is the one that matters; see
 *    `DEFAULT_RIM_MAX`.
 *  - `rimGain` — a *ratio* between classes, not a brightness. `Lighting`
 *    normalises the absolute level away; see `CHARACTER_RIM_GAIN`.
 *  - `rimTint` — how much of the rig's rim *chroma* the surface returns. The
 *    rig's back light is teal; a teal contour on a costume reads as a coating,
 *    and the plates carry no coloured contour on any character. See
 *    `DEFAULT_RIM_TINT`.
 *  - `flat` — this class is a character surface, so procedural detail maps are
 *    dropped and `ambientFlatness` applies. `generic`, `leather` and `crystal`
 *    are the prop classes and keep their fBm detail: `world/Flora.js` shades
 *    every blade of grass and every flower in the meadow through `generic`.
 *    Those three are also left **entirely untuned** by this revision — the cel
 *    model never reached them, their ramps were already soft, and the last agent
 *    to touch them measured that changing the meadow's shading compressed the
 *    capture's luminance range from p1 15 / p95 228 to p1 41 / p95 182.
 *  - `envSpecular` — gain on the environment probe's specular, and **0 on every
 *    matte class**, which is the correction this revision turned on. It is
 *    gated by its own define now, so a matte material has no Fresnel term in its
 *    program at all. At the 0.05–0.10 the character classes used to carry, this
 *    was a grazing sheen along the edge of every cloth panel, every hair mass
 *    and every square centimetre of skin in the frame — brightest exactly at the
 *    silhouette, which is the read "wet plastic" names — and `specGain: 0` never
 *    touched it, because this term is in the indirect chain. High on metal,
 *    where the reflection *is* the material; small on the prop classes.
 */
export const TOON_PRESETS = Object.freeze({
  // **The world class**, and the one every other preset inherits from.
  // `world/Flora.js` shades every blade of grass, every flower, every shrub and
  // every tree in the meadow through it, so this is the largest surface area in
  // any frame the game draws.
  //
  // It is now **matte**, and that is the single biggest pixel change in this
  // revision. It shipped `specGain: 0.80` and `envSpecular: 0.30`, which put a
  // direct highlight and a grazing environment reflection on the entire meadow;
  // the review's "uniform glossy-vinyl material response on every surface
  // including the ground" is that pair of numbers. `bravely01.jpg` has no
  // specular anywhere in its meadow — the lavender, the tulips, the blossom and
  // the grass are all valued by the key alone, and the only bright marks in the
  // lower two-thirds of the plate are white petals.
  //
  // Removing it is also the performance budget for everything else in this
  // revision: an instanced grass draw is tens of thousands of fragments, and it
  // no longer evaluates a Blinn lobe, a shape function or a Fresnel per light.
  //
  // The **ramp** is deliberately untouched. It was always soft, and the last
  // agent to consider banding the meadow measured the capture's luminance range
  // collapsing from p1 15 / p95 228 to p1 41 / p95 182.
  generic: {
    terminator: 0.10, softness: 0.50, rampGamma: 1.00, edgePixels: 2.0,
    shadowMix: 0.40, shadowSat: 1.20, shadowValue: 0.90,
    shadowLevel: 0.24, shadowGain: 1.0, shadowLift: 0.16, shadowFloor: 0.0,
    shadowDepth: 0.34,
    ambientGain: 0.90, ambientFlatness: 0.0, envLevels: 0.0, metalAlbedo: 0.0,
    // Inherited by the classes that *do* take a lobe, so each of them states
    // only what differs. `specGain: 0` here is not a scale of zero — `matte`
    // below makes it a compile-time absence, and `MATTE_CLASSES` makes it one a
    // caller cannot override.
    specColor: 0xffffff, specGain: 0.0, specThreshold: 0.50, specSoftness: 0.35,
    specCeiling: 1.20, specRelMax: 0.0, specSum: DEFAULT_SPEC_SUM,
    rimPower: 3.4, rimGain: CHARACTER_RIM_GAIN.generic, rimFloor: 0.35,
    // Half the ring's chroma and a much lower cap than the props: a rim is a
    // per-blade term on thirteen thousand instanced blades, so on the meadow it
    // is not a contour at all but a teal cast over the whole ground plane. The
    // plate's meadow has none.
    rimWidth: 0.75, rimCeiling: 1.50, rimMax: 0.18, rimTint: 0.50,
    roughness: 0.58, metalness: 0.0, envMapIntensity: 0.45, envSpecular: 0.0,
    flat: false,
  },

  // The face is the read, and the plates put that read entirely in the painted
  // texture: drawn eyes, drawn brows, drawn mouth on an almost unshaded plane.
  // `characters/FaceTexture.js` builds it that way and its header records the
  // same finding — "there is no terminator anywhere on this face". So the
  // shading's whole job here is to stay out of the way: the shallowest curve in
  // the set, the warm rose-tan shadow rather than the scene's cool one (never
  // grey and never a darkened copy), and no highlight at all — a specular blob
  // on a near-spherical chibi cranium slides with the camera and reads as wet
  // plastic.
  //
  // The clamp belongs to the *face* and not to the class: applied here it lands
  // on forearms and bare shoulders too, which come out as limbs with no form.
  // `CharacterFactory` builds the face plate with `faceFlatten: true`, so the one
  // surface that needs it asks for it by name and the rest of the skin shades
  // properly — the difference between an exposed arm carrying a full shadow and
  // a cheek carrying almost none is a read the reference has and we did not.
  skin: {
    // Two levels with the softest boundary of the narrow classes. Skin is the
    // one character surface whose terminator on the plates is genuinely a small
    // gradient rather than an edge — the darkest skin sample on `bravely01.jpg`
    // is only 0.81/0.84/0.84 of the lit one, a fifth of a stop — so a 0.12
    // half-width places a readable jaw and fringe shadow without ever drawing a
    // line across a cheek.
    terminator: 0.10, softness: 0.12, rampGamma: 1.00, edgePixels: DEFAULT_EDGE_PIXELS,
    shadowTint: SKIN_SHADOW_TINT,
    shadowMix: 0.55, shadowSat: 1.10, shadowValue: 0.96,
    shadowLevel: 0.30, shadowGain: 1.0, shadowLift: 0.30, shadowFloor: 0.0,
    // The shallowest dark level of the character classes, before the face's own
    // clamp raises it further. Skin is the brightest albedo the cast owns and an
    // anime face never lets it go dark.
    shadowDepth: 0.62,
    // The most flattened ambient in the set: a face turning under a sky gradient
    // picks up a top-to-bottom ramp that competes with the painted brow line,
    // and the painted line has to win. A coat has no painted line to protect.
    ambientGain: 0.95, ambientFlatness: 0.55, envLevels: 0.0,
    // No lobe and no reflection. A specular blob on a near-spherical chibi
    // cranium slides with the camera and reads as wet plastic, and the grazing
    // environment Fresnel this class used to carry at 0.06 was a pale sheen
    // along the edge of every cheek and forearm in the frame.
    specGain: 0.0, specCeiling: 1.00,
    // The tightest rim in the set and the lowest cap. Skin is the brightest
    // albedo the cast owns, so it is the surface with the least headroom left —
    // and it is the one surface where a wide band eats into the painted face.
    // The tightest and quietest rim in the set. A cheek is a broad convex
    // surface, so the same band that is a sliver on a sword covers a third of a
    // jaw here — and a teal jaw is the fastest way to lose a painted face.
    rimPower: 3.4, rimGain: CHARACTER_RIM_GAIN.skin, rimFloor: 0.40,
    rimWidth: 0.32, rimCeiling: 1.35, rimMax: 0.045, rimTint: 0.20,
    roughness: 0.62, metalness: 0.0, envMapIntensity: 0.30, envSpecular: 0.0,
    flat: true,
  },

  // Chunky geometric clumps carrying **one** highlight arc across the crown,
  // perpendicular to the strand direction. `aniso` picks the Kajiya-Kay lobe —
  // constant along the strand axis, falling off across it, so it yields a band
  // and not a dot — and `awToonArcShape` gives that band a defined inner and
  // outer edge with a flat interior, which is how every head on `bravely01.jpg`
  // and `bravely05.jpg` reads: one bright pass you could trace, sitting inside
  // the mass's own value range.
  //
  // Hair is one of the two classes that take a second lift on the lit side, and
  // it is what turns a modelled mass into a carved one: the top plane of the
  // clump reads brighter than its front, grading between the two.
  hair: {
    terminator: 0.16, softness: 0.10, rampGamma: 1.00, edgePixels: DEFAULT_EDGE_PIXELS,
    // 1.10 rather than 1.18: with the mass brought down to the plate's level
    // the top-plane lift is a readable eighth of a stop, and at 1.18 it was
    // stacking on top of the arc and putting the crown itself into the clip.
    highBand: 0.72, highGain: 1.10,
    shadowMix: 0.42, shadowSat: 1.28, shadowValue: 0.88,
    shadowLevel: 0.22, shadowGain: 1.0, shadowLift: 0.12, shadowFloor: 0.0,
    shadowDepth: 0.26,
    // Lowered from 0.85. Our hair mass measured p2 69 / p50 174 / p75 237 sRGB
    // against the plate's p2 43 / p50 104 / p75 139 — the whole mass was
    // sitting a stop and a half high, in the shoulder of the tone curve where
    // everything the arc adds turns to white. A hair mass is the darkest large
    // area on most of this cast and has to be lit like one.
    ambientGain: 0.62, ambientFlatness: 0.35, envLevels: 0.0,
    // **One crisp arc.** The Kajiya-Kay lobe is unnormalised and lives in 0..1,
    // so at `specExponent: 160` it clears 0.55 only within about five degrees of
    // the half-vector being perpendicular to the strand axis — a band, not a
    // wash — and `specSoftness: 0.05` gives that band a defined inner and outer
    // edge. It shipped with a 0.26 shoulder over a 0.44 threshold, which with
    // the old shape function's 0.45 core floor under it put half-strength gloss
    // across the whole clump and left no readable arc anywhere.
    //
    // `specRelMax: 0.40` is the bound that makes it hair rather than chrome: the
    // arc may reach 1.4× the value of the mass it sits on and no further,
    // whatever the key is doing. Every bright pass on a hair mass in
    // `bravely01.jpg` and `bravely05.jpg` sits inside the mass's own value range
    // — Elvis's is a light warm grey on mid-brown, not a white streak.
    // At `specExponent: 160` the lobe clears its threshold within five degrees
    // of the half-vector being perpendicular to the strand axis, which sounds
    // narrow and is not: a sculpted clump's normal swings through far more than
    // five degrees across each of its lumps, so the "arc" broke into a
    // patchwork of disconnected white shards following the geometry — 26% of
    // the mass at the clip point, against 0.00% anywhere on the plate's hair.
    // 420 halves the angular width to three degrees, `specThreshold: 0.62`
    // takes the shoulders off it, and the two together leave one pass over the
    // crown instead of one per lump.
    //
    // `specAlbedoMix: 0.82` is the other half of the correction and it is a
    // colour one. Every bright pass on a hair mass in `bravely01.jpg` is a
    // lighter, slightly desaturated version of *that hair's own colour* —
    // Elvis's is a warm grey on mid-brown, Adelle's a cool white on silver —
    // and none of them is a white streak laid over the top. At 0.55 ours was
    // nearly half neutral white, which is what a plastic wig looks like.
    //
    // Three bounds, and they do different jobs. `specRelMax: 0.40` keeps the
    // arc inside 1.4× the mass it sits on, which is the ratio the plate shows.
    // `specCeiling: 0.70` bounds the mark alone. `specSum: 0.66` is the one
    // that guarantees it never clips: it bounds mark *plus surface*, so the arc
    // spends whatever headroom the mass has left and no more, and the plate's
    // hair peaks (225 on Elvis, 245 on white-haired Adelle) are reachable while
    // 255 is not.
    specColor: SURFACE_TINT.SILK_SPEC, specGain: 0.60, specExponent: 420,
    specThreshold: 0.62, specSoftness: 0.08, specAlbedoMix: 0.82,
    specCeiling: 0.70, specRelMax: 0.40, specSum: 0.66,
    aniso: true, anisoShift: 0.18,
    rimPower: 3.6, rimGain: CHARACTER_RIM_GAIN.hair, rimFloor: 0.32,
    rimWidth: 0.40, rimCeiling: 1.50, rimMax: 0.07, rimTint: 0.25,
    // No environment reflection. Hair carries exactly one mark and the arc above
    // is it; a probe reflection under the arc is a second, smeared highlight
    // that slides with the camera instead of sitting on the volume.
    roughness: 0.40, metalness: 0.0, envMapIntensity: 0.30, envSpecular: 0.0,
    flat: true,
  },

  // **Matte, and two-tone.** The largest surface area on the cast and the class
  // the review's "uniform glossy-vinyl response" was most visible on.
  //
  // Two things changed and the pair is the point. `specGain: 0` was already here
  // and was already compiling the direct lobe out — but `envSpecular: 0.06` was
  // not consulted by that switch at all, so every garment in the frame still
  // carried a grazing environment Fresnel, brightest exactly along the edge of
  // each panel, which is precisely the read "wet plastic" describes. Both are 0
  // now and `MATTE_CLASSES` makes them unreachable, so a cloth material has no
  // specular chain in its compiled program by construction.
  //
  // And the band. Elvis's coat, Gloria's dress and Seth's surcoat on
  // `bravely01.jpg` each resolve into one lit mass, one dark mass and a boundary
  // a few pixels wide; what varies *inside* a mass is modelled folds, not a
  // lighting gradient. A 0.80 half-width ramp cannot produce that read — it
  // produces an airbrushed one — and it cannot substitute for fold geometry that
  // is not there either. 0.05 is a five-degree toon terminator, which is what the
  // plate shows and what this revision was asked for. `rampGamma` drops to 1
  // because a curve on a five-degree crossing moves nothing.
  //
  // **This is the class the garment system's patterns ride on.** A base colour
  // `map` is never dropped by the flat-class rule, and nothing in this material
  // multiplies anything into it, so a woven check, an embroidered hem or a
  // printed damask arrives on screen exactly as the garment system drew it and
  // is then shaded as one surface. Its shadow is the most saturated in the set,
  // because a garment shadow is where a painter puts the frame's richest colour.
  cloth: {
    terminator: 0.20, softness: 0.05, rampGamma: 1.00, edgePixels: DEFAULT_EDGE_PIXELS,
    shadowMix: 0.42, shadowSat: 1.30, shadowValue: 0.88,
    shadowLevel: 0.24, shadowGain: 1.0, shadowLift: 0.14, shadowFloor: 0.0,
    // The dark side of a garment is a mass and has to be dark enough to anchor
    // the figure; the review measured the whole frame living between 45% and 80%
    // luminance with nothing to anchor it. With a two-level band this is a real
    // mass again rather than an asymptote — a 60 px patch of Elvis's coat chest
    // runs p2 28 / p50 35 / p98 166 sRGB, i.e. most of the piece sits dark with a
    // distinct bright pass over the shoulder and lapel.
    shadowDepth: 0.28,
    ambientGain: 0.80, ambientFlatness: DEFAULT_AMBIENT_FLATNESS, envLevels: 0.0,
    specGain: 0.0, specCeiling: 1.00,
    // The rim is the last specular-shaped term a matte class can still carry —
    // it is added to `directSpecular` — and on a garment it was reading as
    // exactly the sheen this class exists to forbid: a teal line down every
    // lapel, cuff and cape edge in `shots/mp0-cast/cast-stage.png`. Narrowed to
    // the outer sliver, cut to a quarter of its level and desaturated, it holds
    // a coat off the meadow behind it without putting a highlight on cloth.
    rimPower: 3.2, rimGain: CHARACTER_RIM_GAIN.cloth, rimFloor: 0.38,
    rimWidth: 0.42, rimCeiling: 1.45, rimMax: 0.06, rimTint: 0.22,
    roughness: 0.92, metalness: 0.0, envMapIntensity: 0.28, envSpecular: 0.0,
    flat: true,
  },

  // Fur, feather and shearling trim — the one class that takes a lobe of its own
  // rather than the shared highlight. A trim's job is a *broken* contour, and
  // any highlight with a stated extent on a fur collar reads as moulded plastic,
  // which is the exact signature a Blinn lobe on a dark albedo produces (a large
  // mass near the albedo plus a small near-clipped hot spot, nothing between).
  // `TOON_SHEEN` is a Charlie distribution with Neubelt visibility, which peaks
  // at grazing angles and is retro-reflective — the two properties that separate
  // fur from plastic — and both the terminator window and its pixel width are
  // the widest in the set so the mass softens at its edge rather than being
  // sliced.
  fur: {
    // The softest band of the character classes, and the only one that keeps a
    // genuine gradient: a fur mass has no plane to terminate on, so an edge
    // across it reads as a cut rather than as a form. 0.14 half-width is soft
    // enough for the mass to turn and still an eighth of what a prop runs.
    terminator: 0.14, softness: 0.14, rampGamma: 1.00, edgePixels: 2.4,
    shadowMix: 0.40, shadowSat: 1.25, shadowValue: 0.90,
    shadowLevel: 0.22, shadowGain: 1.0, shadowLift: 0.18, shadowFloor: 0.0,
    shadowDepth: 0.30,
    ambientGain: 0.95, ambientFlatness: 0.30, envLevels: 0.0,
    specGain: 0.0, specCeiling: 1.00,
    // Charlie's lobe peaks at grazing angles and is deliberately ungated by the
    // form band, so on a collar seen against the sky it is the whole silhouette
    // that lights up. `specSum: 0.78` is what keeps that from becoming a white
    // fringe: the sheen spends the headroom the collar's own albedo has left,
    // which on Adelle's black trim (`bravely01.jpg`, p5 15 / p50 70 / p95 181,
    // max 223) is a lot and on a pale shearling is very little — the same
    // number giving the right answer on both, which is what the absolute gain
    // could never do.
    sheen: true, sheenColor: SURFACE_TINT.SILK_SPEC, sheenGain: 0.60, sheenRoughness: 0.58,
    specSum: 0.78,
    // Still the widest rim in the set, and the only one that earns it: a fur
    // edge is hundreds of grazing strand tips, so a back light genuinely lands
    // on it. It is the level and the hue that come down, not the reach.
    rimPower: 2.6, rimGain: CHARACTER_RIM_GAIN.fur, rimFloor: 0.35,
    rimWidth: 0.58, rimCeiling: 1.50, rimMax: 0.10, rimTint: 0.30,
    // No environment reflection: the sheen already *is* fur's grazing response,
    // and a Fresnel over a probe on top of it is the same term twice, the second
    // time without the retro-reflection that makes the first one read as fibre.
    roughness: 0.95, metalness: 0.0, envMapIntensity: 0.26, envSpecular: 0.0,
    flat: true,
  },

  // Props and monster hides rather than a party garment, so like `generic` this
  // is a soft class: it keeps its detail maps, keeps its wide band, and takes
  // the **prop** highlight (`TOON_SPEC_GLOSS` — the broad shoulder with a graded
  // core that every class used to share). A hide is the surface that shape was
  // always right for; what made it a defect was armour, cloth, skin, hair and
  // the meadow being shaded through it too.
  leather: {
    terminator: 0.10, softness: 0.50, rampGamma: 1.00, edgePixels: 2.0,
    shadowMix: 0.42, shadowSat: 1.22, shadowValue: 0.88,
    shadowLevel: 0.22, shadowGain: 1.0, shadowLift: 0.14, shadowFloor: 0.0,
    shadowDepth: 0.32,
    ambientGain: 0.90, ambientFlatness: 0.0, envLevels: 0.0,
    // Lowered with `GLOSS_CORE_FLOOR`, and for the same reason. `Bestiary`
    // shades a creature that fills an eighth of the battle frame through this
    // class, and at 0.70 gain over a 45% core shelf its hide came out as a
    // lacquered shell. A hide takes a graded highlight; it does not take a
    // lacquer.
    specColor: 0xffffff, specGain: 0.45, specThreshold: 0.50, specSoftness: 0.35,
    specCeiling: 1.10, specSum: 0.90,
    rimPower: 3.2, rimGain: CHARACTER_RIM_GAIN.leather, rimFloor: 0.35,
    rimWidth: 0.72, rimCeiling: 1.50, rimMax: 0.16, rimTint: 0.60,
    roughness: 0.66, metalness: 0.0, envMapIntensity: 0.40, envSpecular: 0.12,
    flat: false,
  },

  // Armour and blades, and the class the plate comparison indicted hardest. The
  // knight's pauldron on `bravely01.jpg`: a 42 px patch running p2 5 / p50 56 /
  // p98 190 sRGB, a 48 px scanline stepping 113 → 8 through ~40 distinct values,
  // and a longest flat run of 4.8% of the patch. Ours: 28.3% flat run, and a
  // 40 px scanline sitting at 178 ± 2. Three things were producing that and all
  // three are fixed here.
  //
  //  1. **The reflection was being deleted.** `envLevels: 3` quantises any peak
  //     radiance below 1/6 to exactly zero and everything up to 1/2 to the single
  //     constant 1/3, and `LookdevScene` authors `environmentIntensity = 0.28`,
  //     which lands the armour inside that dead zone. Now 0 — a continuous PMREM
  //     sweep, which is what the plate's plates actually show, and the reason the
  //     probe is worth carrying at all. `envMapIntensity` is raised to 1.5 to
  //     spend the headroom the quantiser used to throw away.
  //  2. **The terminator was a line.** It then became a 0.85 half-width ramp,
  //     which is the opposite error: a chibi pauldron shaded across the whole
  //     N·L range has no *band* at all, and the plate's armour plainly does —
  //     Seth's cuisse and pauldron each carry a lit face and a dark face with a
  //     boundary you can point at. 0.10 half-width is that band, and the
  //     antialias floor (`TOON_NARROW_BAND`) keeps it from stair-stepping.
  //  3. **The highlight was a plateau.** `awToonSpecShape` began the mark at
  //     lobe 0.08 — 7° of half-angle at exponent 300 — and paid 45% of full gain
  //     across all of it, which is a broad sheen with a small core: plastic.
  //     `awToonGlintShape` has no core floor and grades from the threshold to the
  //     mirror direction, and `awToonMetalLobe` clamps roughness to 0.25 (exponent
  //     510, half-peak 1.8° off the mirror) so no per-recipe override can widen
  //     the mark back out. What is left is a scatter of small bright marks along
  //     rolled edges, which is what the plate shows.
  //
  // The **shadow band is darkened and desaturated** relative to every other
  // class, and that is what makes it read as steel rather than as painted board:
  // a dielectric's shadow keeps its hue and a metal's does not, because a metal
  // has almost no diffuse term to keep a hue *with*. `shadowDepth: 0.15` is the
  // deepest in the set, `shadowValue: 0.80` takes it down further and
  // `shadowSat: 1.05` declines the saturation lift the fabric classes take — so
  // the recesses between plates land near the plate's p2 of 5 sRGB while the lit
  // faces hold their mid grey.
  //
  // `metalAlbedo` restores part of the diffuse three zeroes at metalness 1: a
  // chibi pauldron carries a painted base colour under its reflection, and at
  // zero the armour is nothing but environment.
  metal: {
    terminator: 0.18, softness: 0.10, rampGamma: 1.00, edgePixels: DEFAULT_EDGE_PIXELS,
    highBand: 0.70, highGain: 1.22,
    // The shadow band is darker and flatter than any other class's, which is
    // what separates steel from painted board: a dielectric's shadow keeps its
    // hue because it still has a diffuse term to keep it with, and a metal's
    // does not. `shadowValue: 0.76` takes the recesses down to roughly the
    // plate's p2 of 2.6 sRGB while the lit faces hold their mid grey — measured
    // on Seth's pauldron, which runs p2 2.6 / p50 53.5 / p98 145 against ours
    // at p2 9.6 / p50 116.6 / p98 222.
    shadowMix: 0.30, shadowSat: 1.05, shadowValue: 0.76,
    shadowLevel: 0.16, shadowGain: 1.0, shadowLift: 0.06, shadowFloor: 0.0,
    shadowDepth: 0.15,
    // The lowest ambient in the set, lowered again after the first capture with
    // the reflection restored: with the probe sweeping rather than quantised to
    // zero, the old `ambientGain` was lifting a pauldron to p50 203 sRGB against
    // the plate's 56 — a pale grey shell rather than steel. Armour is the one
    // class that should be reading almost entirely off the key and the probe.
    ambientGain: 0.42, ambientFlatness: 0.15, envLevels: 0.0,
    metalAlbedo: 0.28,
    // The threshold decides how much of the (already very tight) lobe survives
    // and `specSoftness` is how far up toward the mirror direction the mark
    // takes to reach full strength — a *grade*, not a shoulder, since there is
    // no core floor under it any more.
    // **The size of the mark, restated.** `specThreshold: 0.35` over a 0.65
    // shoulder graded the mark from lobe 0.35 all the way to the mirror
    // direction — at the clamped exponent of 510 that is a 3.7° cone in the
    // half-vector, which on the low curvature of a chibi pauldron covers a
    // quarter of the plate. What the capture showed was a soft white oval on
    // each shoulder and one on the breastplate: a plastic bubble, not a glint.
    // The plate's armour carries a scatter of *small* marks along rolled edges
    // and is otherwise valued entirely by the form ramp.
    //
    // 0.58 over a 0.22 grade halves the mark's angular radius and gives it a
    // defined edge instead of a gradient that fades across the whole piece.
    specColor: 0xffffff, specGain: 1.00, specThreshold: 0.58, specSoftness: 0.22,
    // Still the highest allowance in the character set — a glint on steel is
    // *meant* to outrun the surface, which is why this class alone declines the
    // relative bound. What it may not do is clip: ours peaked at 255 against the
    // plate's brightest pauldron fragment at 238, and a blob whose whole area
    // sits at white is a hole in the frame rather than a highlight. `specSum`
    // is the bound that states that, and it is stated on mark plus surface
    // because that is the quantity the plate was measured on.
    specCeiling: 1.00, specRelMax: 0.0, specSum: 0.92,
    rimPower: 3.6, rimGain: CHARACTER_RIM_GAIN.metal, rimFloor: 0.30,
    rimWidth: 0.38, rimCeiling: 1.90, rimMax: 0.10, rimTint: 0.30,
    // The one character class that keeps its environment reflection, because on
    // the plates it *is* the material — a pauldron's continuous 5 → 190 sRGB
    // sweep is a probe, not a lobe. Trimmed from 0.85/1.2 with `ambientGain`,
    // because with all three at their previous levels the plate read as a pale
    // grey shell (p50 117) rather than as steel (plate p50 54): the reflection
    // has to be the thing that *varies* across the piece, not the thing that
    // fills it.
    roughness: 0.28, metalness: 1.0, envMapIntensity: 1.0, envSpecular: 0.60,
    flat: true,
  },

  // Kept for any geometry eye still in the scene. Under the painted-face
  // pipeline the eye is drawn into the texture and this preset is not the
  // primary path — but where it is used, an iris must never take a shadow
  // (hence the 0.9 floor) and its catch-light is the whole point, which a tight
  // thresholded lobe at `roughness: 0.24` supplies as a crisp white dot rather
  // than a soft bloom.
  eye: {
    terminator: -0.40, softness: 0.55, rampGamma: 0.80, edgePixels: DEFAULT_EDGE_PIXELS,
    shadowMix: 0.15, shadowSat: 1.10, shadowValue: 0.96,
    shadowLevel: 0.12, shadowGain: 1.0, shadowLift: 0.30, shadowFloor: 0.90,
    shadowDepth: 0.90,
    ambientGain: 0.95, ambientFlatness: 0.50, envLevels: 0.0,
    // A catch-light is the one mark in the frame that is allowed to reach the
    // clip point — it is four pixels across and it *is* the eye — so the sum
    // bound is set well above anything a lit iris can reach and never engages.
    specColor: 0xffffff, specGain: 1.40, specThreshold: 0.30, specSoftness: 0.02,
    specCeiling: 2.40, specSum: 2.40,
    rimPower: 3.4, rimGain: 0.50, rimFloor: 0.20,
    rimWidth: 0.85, rimCeiling: 1.50, rimMax: 0.20, rimTint: 0.50,
    roughness: 0.24, metalness: 0.0, envMapIntensity: 0.40, envSpecular: 0.35,
    flat: true,
  },

  // Interior glow is the caller's `emissive`; this supplies the fresnel rim and
  // a sharp highlight over the top of it. A prop class, so detail maps stay and
  // the ramp is soft — a crystal is not a costume, and a hard-banded gemstone
  // reads as painted card.
  crystal: {
    terminator: 0.0, softness: 0.60, rampGamma: 0.90, edgePixels: 2.0,
    shadowMix: 0.36, shadowSat: 1.18, shadowValue: 0.90,
    shadowLevel: 0.18, shadowGain: 1.0, shadowLift: 0.20, shadowFloor: 0.0,
    shadowDepth: 0.62,
    ambientGain: 0.95, ambientFlatness: 0.0, envLevels: 0.0,
    specColor: 0xffffff, specGain: 1.20, specThreshold: 0.45, specSoftness: 0.25,
    // A gemstone's ping is a set-piece effect sitting over its own emissive and
    // is meant to blaze; both ceilings are set above anything the class can
    // reach so neither engages. This is the class the bounds are *not* for.
    specCeiling: 2.40, specSum: 2.60,
    // The one class that wants a broad wrap rather than a sliver: on glass the
    // fresnel *is* the material, so the width stays at the identity value and
    // the band is the bare `pow(1 - N·V, k)` it always was. The cap is the
    // highest in the set because a crystal's own emissive already sits at
    // 1.2–1.8 and the rim must still be visible over it.
    // The one class that keeps the ring's colour outright: on glass the rim
    // *is* the material, and a crystal lit by this world's sky is supposed to
    // carry that sky's teal.
    rimPower: 1.6, rimGain: 1.60, rimFloor: 0.30,
    rimWidth: 1.00, rimCeiling: 2.00, rimMax: 0.90, rimTint: 1.00,
    roughness: 0.25, metalness: 0.0, envMapIntensity: 0.9, envSpecular: 0.9,
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
 * armour is the one surface whose highlight is meant to be the brightest mark on
 * a character, while the rim must never come near it. `metal`, `eye` and
 * `crystal` carry a higher value than this default; the matte classes lower.
 *
 * None of them reaches white, and the reason is the same one that makes the
 * whole revision work: a highlight that spends its whole area at the clip point
 * is a flat patch, which is a hole in the frame rather than a highlight. The
 * ceiling has to sit low enough that the shape's gradation is still resolvable
 * after the tone curve. That is what the review measured as "clipped speculars
 * with no bloom", and the fix is the ceiling rather than the bloom threshold.
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

/**
 * The classes that may **never** carry a specular response, whatever a caller
 * asks for.
 *
 * This is the enforcement half of the per-class gate, and it is a set rather
 * than a preset field on purpose: `createToonMaterial` builds its working preset
 * by spreading `generic` under the named one, so a `matte: true` written into
 * `generic` would be inherited by `metal` and `hair` unless every glossy class
 * remembered to write `matte: false`. A membership test cannot be got wrong that
 * way round.
 *
 * What it forbids is both halves of the chain — `specGain` *and* `envSpecular`.
 * The second is the one that was actually shipping the defect: `cloth` and
 * `skin` already carried `specGain: 0`, and every garment and every square
 * centimetre of skin in the frame still had a grazing environment Fresnel on it,
 * because `RE_IndirectSpecular_Toon` never consulted that switch. Both now leave
 * the compiled program, so "cloth has no gloss" is a property of the shader
 * rather than of a number a `updateToonUniforms` call could write over.
 *
 * `generic` is in the set because `world/Flora.js` shades the entire meadow
 * through it — grass, flowers, shrubs, trees — and the plate's meadow has no
 * specular anywhere in it.
 */
const MATTE_CLASSES = Object.freeze(new Set(['generic', 'cloth', 'skin', 'fur']));

/**
 * How wide a form band has to be before it no longer needs antialiasing, as a
 * half-width in N·L.
 *
 * Above this the transition covers enough of the surface that it can never
 * collapse below a device pixel, so `awToonEdge` would be a `fwidth` and a
 * divide per fragment that provably do nothing — and the classes above the line
 * are `generic` and `leather`, i.e. every blade of grass in the frame. Below it
 * the band is a drawn terminator that genuinely goes sub-pixel on a limb seen
 * near-tangent, and an unfiltered one there is a jagged staircase running the
 * length of the silhouette.
 *
 * 0.25 sits in the empty gap between the two families: the narrow classes run
 * 0.05–0.14 and the wide ones 0.50–0.60.
 */
const NARROW_BAND_MAX = 0.25;

/**
 * Shading class → the define that selects its lobe in `toonSurface.js`.
 *
 * Exactly one is ever set, and `TOON_SPECULAR` accompanies it. Naming the three
 * separately rather than branching on a uniform is what makes "cloth has no
 * gloss" and "steel has a tight one" facts about the compiled program: a matte
 * material's fragment shader contains no lobe to reach.
 */
const SPEC_CLASS_DEFINE = Object.freeze({
  metal: 'TOON_SPEC_METAL',
  hair: 'TOON_SPEC_HAIR',
  gloss: 'TOON_SPEC_GLOSS',
});

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
 * @param {number} [opts.terminator] the form ramp's midpoint, in N·L. 0.10–0.18
 *   on the character classes.
 * @param {number} [opts.softness] the band's **half-width**, in N·L. 0.05–0.14 on
 *   the character classes (a toon terminator), 0.50–0.60 on the prop classes (a
 *   falloff). Crossing `NARROW_BAND_MAX` here also decides whether the antialias
 *   floor is compiled onto the band.
 * @param {number} [opts.rampGamma] the band's curve. Above 1 holds the dark side
 *   longer; close to inert on a narrow band.
 * @param {number} [opts.edgePixels] antialias floor, in device pixels; widens
 *   only. See `DEFAULT_EDGE_PIXELS`.
 * @param {number} [opts.highBand] midpoint of the optional second lift on the
 *   lit side, in N·L. Hair and metal only.
 * @param {number} [opts.highGain] how much the lit level is scaled inside it.
 * @param {number} [opts.shadowFloor] minimum the shadow *term* is held at, for
 *   a surface that must not take a shadow at all. 0 on every class but `eye`.
 * @param {boolean} [opts.faceFlatten] the face clamp: shorthand for
 *   `shadowDepth: 0.75`. See `FACE_SHADOW_DEPTH`.
 * @param {THREE.ColorRepresentation} [opts.shadowTint] hue target for the
 *   shadow albedo. Defaults to the scene shadow tint (warm rose-tan on `skin`).
 * @param {number} [opts.shadowMix] 0–1, how far the albedo's chroma rotates.
 * @param {number} [opts.shadowSat] HSV saturation multiplier in shadow, > 1.
 * @param {number} [opts.shadowValue] value multiplier in shadow, < 1.
 * @param {number} [opts.shadowLevel] luminance of the flat shadow fill.
 * @param {number} [opts.shadowLift] share of the key the shaded level keeps.
 * @param {number} [opts.shadowDepth] the shaded level, as a fraction of the lit
 *   level's peak. Stated rather than left over: 0.28 for cloth, 0.18 for metal.
 *   With a broad ramp it is an asymptote rather than a plateau.
 * @param {number} [opts.ambientFlatness] 0–1, how much indirect *direction* the
 *   surface trades for its own average. Inert on a non-`flat` class.
 * @param {number} [opts.envLevels] flat levels the environment reflection is
 *   quantised into. 0 on every shipped class; see the preset field notes for why
 *   turning it on deletes the reflection at this project's probe level.
 * @param {number} [opts.specGain] 0 compiles the highlight out entirely. Ignored
 *   on a `MATTE_CLASSES` preset, which never has one.
 * @param {number} [opts.specThreshold] the lobe value the mark's boundary sits
 *   at. Read by all three lobes.
 * @param {number} [opts.specSoftness] width of the transition over that
 *   boundary. Its meaning differs by class; see the preset field notes.
 * @param {number} [opts.specCeiling] HDR bound on the highlight, independent of
 *   the rim's. Metal carries the highest, still well under the clip point.
 * @param {number} [opts.specRelMax] bound on the highlight stated as a fraction
 *   of the diffuse level underneath. 0 disables it; hair runs 0.40.
 * @param {number} [opts.specSum] bound on **surface plus highlight**, the only
 *   one of the three that can promise the pixel does not clip. Applies to the
 *   fur sheen as well. See `DEFAULT_SPEC_SUM`.
 * @param {number} [opts.envSpecular] gain on the environment probe's specular.
 *   Ignored on a `MATTE_CLASSES` preset, where the whole Fresnel term is
 *   compiled out.
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
 * @param {number} [opts.rimTint] 0–1, how much of the rig's rim *chroma* the
 *   surface returns. Spent as a desaturation at constant peak, so the rig's
 *   solved level is untouched. See `DEFAULT_RIM_TINT`.
 * @param {boolean} [opts.aniso] force the anisotropic highlight on or off.
 * @param {THREE.Vector3} [opts.anisoDirection] world-space strand axis.
 * @returns {THREE.MeshStandardMaterial} patched, ready to add to a scene.
 */
export function createToonMaterial(opts = {}) {
  const presetName = opts.preset && TOON_PRESETS[opts.preset] ? opts.preset : 'generic';
  const p = { ...TOON_PRESETS.generic, ...TOON_PRESETS[presetName] };

  // The per-class specular gate. A zero-gain highlight is not the same thing as
  // no highlight: on a matte class the lobe, its shape function, the screen-space
  // edge resolve and the environment Fresnel all drop out of the compiled
  // program, so none of them can come back through a stray `updateToonUniforms`
  // and none of them costs anything per light per fragment on the largest
  // surfaces in frame — which, `generic` being the meadow's class, is most of the
  // pixels the game draws.
  const matte = MATTE_CLASSES.has(presetName);
  const specGain = matte ? 0 : (opts.specGain ?? p.specGain ?? 0);
  const hasSpec = specGain > 0;

  // Which of the three lobes, decided here rather than in the shader so the
  // program cache key can name it. `hair` asks by `aniso`, `metal` by its
  // metalness/preset identity; everything else that carries a lobe at all is a
  // prop and takes the broad shoulder.
  const specClass = !hasSpec ? 'none'
    : (opts.aniso ?? p.aniso ?? false) ? 'hair'
      : presetName === 'metal' ? 'metal'
        : 'gloss';
  const aniso = specClass === 'hair';

  // The environment reflection is the *other* half of the specular chain and is
  // gated on the same terms. It was not, and that is why `specGain: 0` on cloth
  // and skin did not produce a matte surface.
  const envSpecular = matte ? 0 : (opts.envSpecular ?? p.envSpecular ?? 0);
  const hasEnvSpec = envSpecular > 0;

  // The form band's antialias floor, compiled in only where the band is narrow
  // enough to collapse below a pixel. See `NARROW_BAND_MAX`.
  const softness = opts.softness ?? p.softness;
  const narrowBand = softness <= NARROW_BAND_MAX;

  // The fur / feather lobe, compiled in on the same terms. It is deliberately
  // independent of `hasSpec`: fur wants a sheen and no thresholded highlight at
  // all, which is the whole distinction between fur and moulded plastic.
  const sheenGain = opts.sheenGain ?? p.sheenGain ?? 0;
  const hasSheen = sheenGain > 0 && (opts.sheen ?? p.sheen ?? true);

  // The third band of ANIME_PIPELINE §2, compiled in only where a preset or a
  // caller names a threshold for it. Absent, the whole term — a second
  // `smoothstep`, a second edge resolve and a `mix` — leaves the program.
  const highBand = opts.highBand ?? p.highBand;
  const hasHighBand = typeof highBand === 'number';

  // A character class never receives a procedural detail map: in this project
  // every one of them is fBm from `AssetForge`, and on a character they read as
  // dirt. Callers with a genuine reason opt back in per material rather than by
  // editing this table. The base colour `map` is deliberately not in that set —
  // a garment pattern and a painted face both arrive that way.
  const flat = opts.detailMaps === undefined ? (p.flat ?? false) : !opts.detailMaps;
  const detail = {};
  for (const key of DETAIL_MAP_KEYS) detail[key] = flat ? null : (opts[key] ?? null);

  // `faceFlatten` is the readable spelling of the face clamp, and it acts on the
  // dark *level* rather than on the band; see `FACE_SHADOW_DEPTH`. An explicit
  // `shadowDepth` still wins, so a caller can flatten a face and then state
  // exactly how far. Resolved here rather than inline so that
  // `faceFlatten: false` can genuinely turn the clamp *off* on a preset that
  // carries one.
  const shadowFloor = opts.shadowFloor ?? p.shadowFloor ?? 0.0;
  const shadowDepth = opts.shadowDepth
    ?? (opts.faceFlatten
      ? FACE_SHADOW_DEPTH
      : (p.shadowDepth ?? 0.28));

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

    // ---- the two-band step -------------------------------------------------
    uToonTerminator: { value: opts.terminator ?? p.terminator },
    uToonSoftness: { value: softness },
    uToonEdgePixels: { value: opts.edgePixels ?? p.edgePixels ?? DEFAULT_EDGE_PIXELS },
    uToonRampGamma: { value: opts.rampGamma ?? p.rampGamma ?? 1.0 },
    uToonShadowFloor: { value: shadowFloor },
    uToonShadowLift: { value: opts.shadowLift ?? p.shadowLift },
    uToonShadowDepth: { value: shadowDepth },

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
    uToonEnvLevels: { value: opts.envLevels ?? p.envLevels ?? 0.0 },
    uToonMetalAlbedo: { value: opts.metalAlbedo ?? p.metalAlbedo ?? 0.0 },

    // ---- highlight and rim bounds -----------------------------------------
    // Two separate ceilings, and the separation is the point: armour's ping runs
    // far hotter than anything else on the cast and the rim never may. See
    // `DEFAULT_SPEC_CEILING`.
    uToonSpecCeiling: { value: opts.specCeiling ?? p.specCeiling ?? DEFAULT_SPEC_CEILING },
    // The bound on mark *plus* surface, which is the only one that can promise
    // the pixel does not clip. See `DEFAULT_SPEC_SUM`. Uploaded unconditionally
    // alongside `uToonSpecCeiling` because the sheen path reaches it too and
    // that path is selected by a different define.
    uToonSpecSum: { value: opts.specSum ?? p.specSum ?? DEFAULT_SPEC_SUM },
    uToonRimPower: { value: opts.rimPower ?? p.rimPower },
    uToonRimGain: { value: opts.rimGain ?? p.rimGain },
    uToonRimFocus: { value: toVec2(opts.rimFocus, DEFAULT_RIM_FOCUS) },
    uToonRimShape: { value: toVec2(opts.rimShape, DEFAULT_RIM_SHAPE) },
    uToonRimFloor: { value: opts.rimFloor ?? p.rimFloor },
    uToonRimWidth: { value: opts.rimWidth ?? p.rimWidth ?? DEFAULT_RIM_WIDTH },
    uToonRimCeiling: { value: opts.rimCeiling ?? p.rimCeiling ?? DEFAULT_RIM_CEILING },
    uToonRimMax: { value: opts.rimMax ?? p.rimMax ?? DEFAULT_RIM_MAX },
    // How much of the rig's rim *chroma* this surface returns. The level stays
    // the rig's; only the hue is a material decision. See `DEFAULT_RIM_TINT`.
    uToonRimTint: { value: opts.rimTint ?? p.rimTint ?? DEFAULT_RIM_TINT },

    // ---- battle feedback --------------------------------------------------
    uToonPulse: { value: toColor(opts.pulse ?? 0x000000) },
    uToonPulseRate: { value: opts.pulseRate ?? 0.0 },
    uToonTime: { value: 0.0 },
  };

  if (hasEnvSpec) uniforms.uToonEnvSpecular = { value: envSpecular };

  if (hasSpec) {
    uniforms.uToonSpecColor = { value: toColor(opts.specColor ?? p.specColor ?? 0xffffff) };
    uniforms.uToonSpecGain = { value: specGain };
    // The threshold and its transition width belong to all three lobes: each of
    // them is a lobe bounded in 0..1 under a `smoothstep`, which is precisely
    // what makes a threshold on one mean the same thing on every surface.
    uniforms.uToonSpecThreshold = { value: opts.specThreshold ?? p.specThreshold ?? 0.5 };
    uniforms.uToonSpecSoftness = { value: opts.specSoftness ?? p.specSoftness ?? 0.04 };
    // The bound stated against the surface underneath rather than in absolute
    // radiance; 0 disables it. Hair is the class that needs it — see the preset.
    uniforms.uToonSpecRelMax = { value: opts.specRelMax ?? p.specRelMax ?? 0.0 };
  }

  // The strand axis, the lobe's tightness and the band's albedo tint belong to
  // the hair path alone. Metal derives its exponent from a roughness the lobe
  // itself clamps, and the prop path from `material.roughness` unmodified, so
  // that one number keeps meaning the same thing on a toon material and a stock
  // one; allocating a second control for it here is how a caller comes to
  // believe a number is doing something.
  if (aniso) {
    uniforms.uToonAnisoDirection = { value: toDirection(opts.anisoDirection, DEFAULT_ANISO_DIR) };
    uniforms.uToonAnisoShift = { value: opts.anisoShift ?? p.anisoShift ?? 0.12 };
    uniforms.uToonSpecExponent = { value: opts.specExponent ?? p.specExponent ?? 96 };
    uniforms.uToonSpecAlbedoMix = { value: opts.specAlbedoMix ?? p.specAlbedoMix ?? 0.0 };
  }

  if (hasHighBand) {
    uniforms.uToonHighBand = { value: highBand };
    uniforms.uToonHighGain = { value: opts.highGain ?? p.highGain ?? 1.2 };
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
  // `depth` rides along so `updateToonUniforms({ faceFlatten: false })` can put
  // the class's own dark level back rather than guessing at one.
  const levels = {
    shadow: opts.shadowLevel ?? p.shadowLevel,
    depth: opts.shadowDepth ?? p.shadowDepth ?? 0.28,
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
  if (hasSpec) {
    material.defines.TOON_SPECULAR = '';
    material.defines[SPEC_CLASS_DEFINE[specClass]] = '';
  }
  if (hasEnvSpec) material.defines.TOON_ENV_SPEC = '';
  if (hasSheen) material.defines.TOON_SHEEN = '';
  if (hasHighBand) material.defines.TOON_HIGH_BAND = '';
  if (narrowBand) material.defines.TOON_NARROW_BAND = '';
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
    + `|${specClass}|${hasEnvSpec ? 'env' : 'noenv'}|${hasSheen ? 'sheen' : 'nosheen'}`
    + `|${hasHighBand ? 'hiband' : 'noband'}|${flat ? 'flatamb' : 'amb'}`
    + `|${narrowBand ? 'narrow' : 'wide'}`;
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
 *  absent (the highlight on a `specGain: 0` material, the strand axis on an
 *  isotropic one, the sheen on anything that is not fur, the third band on
 *  anything that is not hair or metal) are skipped rather than created: the
 *  uniform is not in the compiled program either. */
const SCALAR_KEYS = Object.freeze({
  time: 'uToonTime',
  terminator: 'uToonTerminator',
  // Writing this at runtime moves the band but does **not** re-decide whether
  // the antialias floor is compiled in (`TOON_NARROW_BAND`, chosen against
  // `NARROW_BAND_MAX` at construction). Widening a narrow class costs a `fwidth`
  // that does nothing; narrowing a wide one gives an unfiltered terminator. A
  // caller changing a class's band by more than a nudge should build the
  // material with the value it wants.
  softness: 'uToonSoftness',
  edgePixels: 'uToonEdgePixels',
  rampGamma: 'uToonRampGamma',
  highBand: 'uToonHighBand',
  highGain: 'uToonHighGain',
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
  envLevels: 'uToonEnvLevels',
  metalAlbedo: 'uToonMetalAlbedo',
  envSpecular: 'uToonEnvSpecular',
  specExponent: 'uToonSpecExponent',
  specThreshold: 'uToonSpecThreshold',
  specSoftness: 'uToonSpecSoftness',
  specAlbedoMix: 'uToonSpecAlbedoMix',
  specCeiling: 'uToonSpecCeiling',
  specRelMax: 'uToonSpecRelMax',
  specSum: 'uToonSpecSum',
  sheenGain: 'uToonSheenGain',
  sheenRoughness: 'uToonSheenRoughness',
  rimPower: 'uToonRimPower',
  rimGain: 'uToonRimGain',
  rimFloor: 'uToonRimFloor',
  rimWidth: 'uToonRimWidth',
  rimCeiling: 'uToonRimCeiling',
  rimMax: 'uToonRimMax',
  rimTint: 'uToonRimTint',
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
 * gives no gloss (skin, cloth, fur, the meadow) cannot grow one at runtime — the
 * uniform does not exist. Driving a *glossy* material's gain to zero does take
 * effect, at the cost of one program rebuild, and is one-way: which of the three
 * lobes it had is not restored, because a caller who wants a lobe back should
 * build the material that has one.
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
  // The face clamp acts on the dark level, so turning it off has to restore the
  // *class's* depth rather than some notional zero — a face at `shadowDepth: 0`
  // is a black plate. The constructor's resolved value is remembered for exactly
  // this, since the preset name alone would not survive a caller who overrode it.
  if (opts.faceFlatten !== undefined && u.uToonShadowDepth) {
    u.uToonShadowDepth.value = opts.faceFlatten ? FACE_SHADOW_DEPTH : toon.levels.depth;
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

  // `specGain` crossing zero removes the highlight from the program, so it
  // cannot go through `SCALAR_KEYS`. It is a **one-way** switch: a material built
  // without a lobe has no `uToonSpecGain` at all (matte classes never allocate
  // one), so this branch cannot fire on cloth, skin, fur or the meadow, and a
  // glossy material driven to zero drops its whole chain — the class define, the
  // shape function and the environment Fresnel — rather than multiplying by
  // nothing. Which class it *was* is not restored, because the program has to be
  // rebuilt either way and a caller who wants a lobe back should build the
  // material that has one.
  if (opts.specGain !== undefined && u.uToonSpecGain) {
    const had = u.uToonSpecGain.value > 0;
    u.uToonSpecGain.value = opts.specGain;
    if (had && !(opts.specGain > 0)) {
      material.defines = { ...(material.defines ?? {}) };
      delete material.defines.TOON_SPECULAR;
      for (const name of Object.values(SPEC_CLASS_DEFINE)) delete material.defines[name];
      delete material.defines.TOON_ENV_SPEC;
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
 * These adapters inherit `Outline.js`'s project-wide switch, which ships **on**
 * again under the ANIME_PIPELINE ruling; that module's header carries the
 * reasoning and the evidence from both sides of it.
 */
const OUTLINE_REFERENCE_HEIGHT = 1080;

/**
 * Fallback line colour for a hull with no albedo and no per-vertex colour.
 *
 * `Outline.js` derives the line from the surface underneath, and with nothing to
 * derive from, a caller reaching this adapter without an albedo (the husks in
 * `LookdevScene`) would fall through to its `0xffffff` default and get a line
 * *lighter* than the body it wraps, which is an inversion, not a line.
 *
 * Derived by running the scene shadow tint through `outlineColorFor` — the very
 * transform every other line in the frame goes through — rather than stated as a
 * level of its own. The previous revision stated one, at 0.035, with a comment
 * saying it tracked `OUTLINE_DEFAULTS.darkness`; nothing enforced that, and when
 * the darkness moved to 0.35 for this revision the two would silently have
 * disagreed by a factor of two. A constant that has to be kept in step by hand
 * is a constant that will not be.
 */
function defaultOutlineColor(opts) {
  return outlineColorFor(LIGHT.SHADOW_TINT, {
    darkness: opts.darkness ?? OUTLINE_DEFAULTS.darkness,
    saturation: opts.saturation,
    floor: opts.floor,
  });
}

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
      ? defaultOutlineColor(opts)
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
