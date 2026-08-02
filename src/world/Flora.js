/**
 * Flora — the sunlit flower meadow from `docs/reference/bravely01.jpg`.
 *
 * ## What is actually in the plate
 *
 * Everything below was measured off the 1920×1080 hero plate rather than taken
 * from the prose specs. Scale is expressed against the party's own height so it
 * survives whatever the cast finally measures: the knight spans **419 px** (head
 * top y≈326 to boot sole y≈745) and the horizon sits at **y≈190**, so apparent
 * height at any depth scales as `(y_feet − 190)`, which is what every ratio here
 * was divided through by.
 *
 * | element | measured | as built (character = 1.6 m) |
 * |---|---|---|
 * | mown lawn near camera | fine directional streaks, boots fully clear of it | 0.09–0.17 m blades |
 * | meadow tufts in the bed | arch to the lavender's shoulder | 0.55–1.05 m blades |
 * | lavender plant | 0.65–0.85 × character | 1.05–1.35 m, spike is the top ~35% |
 * | lavender raceme, across | contiguous violet runs 7 px median / 18 px p90; ~0.13 × its own length | 5.4 cm on a 1.2 m spike |
 * | tulip | heads sit just under the lavender tips | 0.66–1.05 m stem, 0.085 m head |
 * | seed-head grass | panicles crest 20–40 cm above the lavender | 1.30–1.90 m, head is the top 22% |
 * | ground cover | broad low leaves pooling between the grass | 0.16–0.36 m across |
 * | cherry blossom | 1.6–1.75 × character, canopy wider than tall (~1.15:1) | 2.9 m tall, 3.3 m across |
 * | broadleaf | rounded crown of 5–6 lobes over a clean bole | 5–6.5 m, crown 1.1–1.2 × height |
 * | boulder wall | 2.8 × character tall, 5.4 × wide | see `props/RockForms.js` |
 * | blossom petal | ~15 px at the knight's depth → ≈ 5.7 cm | 0.055 m |
 *
 * Colours are percentiles over masked regions of the plate, quoted as sRGB, and
 * they are the reason `FLORA_PALETTE` looks less candy-bright than the frame
 * reads: the saturation in that image is *contrast between lit and shaded*, not
 * a hot albedo. The lavender mass, for instance, runs p10 `#3e2479` → p50
 * `#6144a0` → p90 `#936dc8` over 25 400 masked pixels. Picking the p90 as an
 * albedo and letting the shading model produce the rest is what reproduces it;
 * picking a saturated violet and flattening it is what produced our plastic bed.
 *
 * ## Where the colour lives — read this before touching a palette entry
 *
 * Three's standard material multiplies `material.color × vertexColor ×
 * instanceColor` into one diffuse albedo. This module puts the measured colour
 * in exactly **one** of those three, every time:
 *
 *   - `material.color` is **always white**. It is not an art control here.
 *   - **vertex colour carries the albedo** — root-to-tip on a blade, throat-to-rim
 *     on a petal, cleaved-face-to-weathered-top on a rock.
 *   - **instance colour is a modulation**, near white, and it is what stops
 *     twenty thousand copies of one geometry reading as felt.
 *
 * The exception proves the rule: a tulip head and a wildflower bloom are authored
 * with a *neutral* vertex ramp so their instance colour can be the species — one
 * geometry, one draw call, reds and whites in the same mesh. Putting a colour on
 * the material as well is the mistake this note exists to prevent; two greens
 * multiplied give a black lawn.
 *
 * ## Where the prose docs are wrong
 *
 * `docs/REFERENCE_TARGET.md` and `docs/ANIME_PIPELINE.md` describe the
 * environment as dark, misty and low-contrast with silhouetted background
 * elements. The plate is the opposite in three specific, checkable ways, and
 * this module follows the plate:
 *
 *  1. **The background is in focus and fully detailed.** Individual lavender
 *     florets and tulip petals are resolvable at the far edge of the bed. So
 *     nothing here fades geometry out with distance — density falls off, blade
 *     *size* rises to compensate, and the silhouette stays sharp.
 *  2. **The ground is bright.** The lawn measures p50 `#5b763c` / p90 `#7e9659`
 *     across 200 000 masked pixels — a light, yellow-leaning green, not the
 *     `#2a3a24` the specs call for.
 *  3. **Foliage is translucent, not silhouetted.** Blades crossing in front of
 *     the sun on the plate are *brighter* than the lit ones beside them. Every
 *     foliage material here therefore carries a high `shadowDepth` (0.48 against
 *     the character classes' 0.34), which is the cheapest honest stand-in for
 *     leaf transmission and is why the bed does not go to a black mass at its
 *     back edge.
 *
 * ## Cost model
 *
 * Everything that repeats is one `InstancedMesh`, so a full meadow is single
 * digits of draw calls per species: grass 1, ground cover 1, seed grass 1,
 * lavender 2 (spikes + basal leaves), tulips 2 (stems + heads), blossom tree 2
 * (branches + blossom clusters), broadleaf 2 or 3 (bark + canopy lobes, plus a
 * leaf fringe on a hero tree only), conifers 2, boulders 2 (merged cluster +
 * instanced chips), flower patch 2. Density falls off from the scatter centre
 * with `falloff`, and blade size rises with radius so coverage holds while the
 * count drops.
 *
 * **A species is not a preset.** The five that share `bladeGeometry` do not
 * share a *read*: grass is a silhouette against the sky, ground cover is a plan
 * seen from above, a seed panicle is a spindle, a lavender raceme is a column
 * and a tulip is a goblet. Each of those needs its own droop, taper, up-blend
 * and lever, which is why they are five builders and not one with a mode flag —
 * a meadow that is one plant at five scales is the monoculture this module
 * spent a round shipping.
 *
 * Procedural surface noise is legal on these — they are props, not characters —
 * and every builder accepts an `AssetForge` to bind `stone` / `bark` detail maps.
 *
 * ## Wind
 *
 * Grass, flowers and foliage sway in a **vertex shader**, sharing one set of
 * uniforms so the whole meadow bends under one gust. Two per-mesh attributes
 * drive it: `aSway` (per vertex, 0 at the anchored end, 1 at the free tip) and
 * `aWindGain` (per instance, so one blade in a clump can be stiffer than its
 * neighbour). See {@link updateFlora}.
 *
 * OWNED BY: world/Flora.js.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng as defaultRng } from '../core/GameState.js';
import { createToonMaterial } from '../render/ToonMaterial.js';
import {
  createAngularRockGeometry,
  createStoneChipGeometry,
} from './props/RockForms.js';

/* -------------------------------------------------------------------------- */
/* Measured palette                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every value here is a percentile of a hue-masked region of `bravely01.jpg`,
 * quoted as sRGB, pulled toward the region's **p90** because a measurement off a
 * rendered frame is already lit and an albedo is not.
 *
 * `ROOT`/`TIP`, `DEEP`/`PALE` and `THROAT`/`RIM` pairs are the endpoints of a
 * vertex-colour ramp. `TULIP_*` and `PETAL_*` species colours are the only
 * entries that go into an instance colour instead. Nothing here is ever a
 * `material.color` — see the module note above.
 */
export const FLORA_PALETTE = Object.freeze({
  /** Lawn, masked g>r+8 & g>b+25, n=200 491: p10 #2b4b1b, p50 #5b763c, p90 #7e9659. */
  GRASS_ROOT: 0x2b4b1b,
  GRASS_TIP: 0x86a05a,
  /**
   * The bed's tall tufts.
   *
   * Warmed from `#1f3f16`/`#6f9040`. Those were picked to read "cooler and deeper
   * than the mown lawn", which is true of the *value* and false of the *hue*: on
   * the plate the tall grass standing between the lavender is the yellowest green
   * in the frame — masked over the bed's foliage it runs p50 `#54702c`, i.e. a
   * red-to-blue ratio of 1.35, where the old pair sat at 1.24 and 1.11. Under the
   * shading model that half-step toward blue is what made our bed read as a
   * blue-green hedge behind a violet mass instead of as the plate's warm meadow
   * with violet standing in it. The value relationship to the lawn is unchanged.
   */
  MEADOW_ROOT: 0x2a4415,
  MEADOW_TIP: 0x7c9a3e,

  /** Lavender florets, masked b>g+45 & r>g+10, n=25 424. */
  LAVENDER_DEEP: 0x4a2f8c,
  LAVENDER_MID: 0x8a62c6,
  LAVENDER_PALE: 0xc4b2e4,
  /** Bare stem below the raceme — a grey-green, distinctly duller than a blade. */
  LAVENDER_STEM: 0x5d7444,

  /** Tulip reds, masked r>110 & r>g+55 & r>b+55: p10 #7b1404, p90 #b25439. */
  TULIP_RED: 0xc0402c,
  TULIP_RED_DEEP: 0x8a2410,
  /** Tulip whites, masked r,g,b > 170/165/150: p50 #b3c4b1 — green-cast, not paper. */
  TULIP_WHITE: 0xeceee0,
  /** Neutral-warm, deliberately *not* the green throat the plate's whites show:
   *  this ramp is shared by the reds, and a hue baked here would turn them olive.
   *  The green arrives instead through the ambient the bed bounces up into them. */
  TULIP_THROAT: 0xada492,
  TULIP_STEM: 0x5b8235,

  /** Cherry blossom, masked r>120 & r>g+35 & b>g+10, n=39 557: p50 #aa6796, p90 #cd87b2. */
  BLOSSOM: 0xdd8fbd,
  BLOSSOM_PALE: 0xf2c6dd,
  BLOSSOM_DEEP: 0xb96a99,
  /** The bloom's warm centre, as a *value* ramp toward white — the pink is the
   *  instance colour, so this end has to stay near neutral. */
  BLOSSOM_HEART: 0xf3e4c8,
  /** Cherry bark reads a dark maroon-brown wherever it shows through the canopy. */
  BARK_DARK: 0x3d2a36,
  BARK_LIT: 0x6a4a58,

  /** Conifer, masked g>r+12 & g>b+12, n=38 503: p10 #11341a, p50 #204527, p90 #506e46. */
  CONIFER_DEEP: 0x1a3c20,
  CONIFER_LIT: 0x557546,
  CONIFER_BARK: 0x50442f,

  /**
   * The broadleaf standing behind the bed at plate centre-right.
   *
   * A different tree from the conifers in every measurable way and that is the
   * point: masked over its canopy the hue runs 92° against the cedars' 128°, the
   * mass is *rounded* rather than tiered, and its lit crown at p90 `#8aa447` is
   * two stops above anything on a cedar. Ours had one tree species repeated
   * twenty-two times, which is what a monoculture actually looks like.
   */
  BROADLEAF_DEEP: 0x21401b,
  BROADLEAF_MID: 0x3f6b28,
  BROADLEAF_LIT: 0x84a446,
  /** Broadleaf bark is a warm grey-brown, much lighter than the cherry's maroon. */
  BROADLEAF_BARK: 0x4b3d2b,
  BROADLEAF_BARK_LIT: 0x7a674c,

  /**
   * Tall seed-head grass — the species that gives the plate's bed its top edge.
   *
   * At frame right, standing a head above the lavender, the plate carries loose
   * straw-coloured panicles on bare green stalks. They are the only warm, pale
   * vertical in the bed and they are what stops the violet mass reading as a
   * wall: the eye gets a second height and a second hue at the same station.
   */
  SEED_STALK: 0x6d8a38,
  SEED_HEAD: 0xb5ad68,
  SEED_HEAD_PALE: 0xdcd6a4,

  /**
   * Low broadleaf ground cover — the dark rosettes between the lawn and the bed.
   *
   * Deliberately *darker* than the lawn it sits in. On the plate the ground
   * around the party is not one green: broad low leaves pool in the hollows at
   * roughly two thirds the lawn's luminance, and that mottling is most of what
   * keeps a large area of grass from reading as felt.
   */
  COVER_ROOT: 0x24400f,
  COVER_TIP: 0x6f8c34,

  /** The small wildflowers dotted through the bed — instance colours. */
  PETAL_WHITE: 0xf0efe2,
  PETAL_GOLD: 0xe8bf4e,
  PETAL_CORAL: 0xd9634a,
  PETAL_LILAC: 0xa98ad4,
  /** Their warm centre, again a value ramp rather than a hue. */
  PETAL_HEART: 0xf0e3b0,
});

/* -------------------------------------------------------------------------- */
/* Wind                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The gust, shared by every swaying material this module builds.
 *
 * Shared *objects*, not copied values: a lavender spike and the blade beside it
 * must be at the same point in the same gust or the bed shimmers instead of
 * bending. `uWindGain` and `uWindChop` are deliberately **not** in here — those
 * are per-material amplitude, because a cherry cluster on a stiff branch and a
 * grass blade on nothing do not move the same distance.
 */
const WIND = {
  uWindTime: { value: 0 },
  /** Unit vector in world XZ. The plate's bed leans consistently to frame-right. */
  uWindDir: { value: new THREE.Vector2(0.88, 0.47).normalize() },
  uWindStrength: { value: 1.0 },
};

/** True once a host has called {@link updateFlora}; disables the self-clock. */
let windDriven = false;
/** Wall-clock seconds at the last self-clock tick. */
let windLastWallClock = 0;

const WIND_PARS = /* glsl */`
uniform float uWindTime;
uniform vec2  uWindDir;
uniform float uWindStrength;
uniform float uWindGain;
uniform float uWindChop;
attribute float aSway;
attribute float aWindGain;
`;

/**
 * The sway itself, injected after `<begin_vertex>` so it acts on `transformed`
 * in object space — before `<project_vertex>` applies `instanceMatrix`, which is
 * what lets a whole field share one geometry.
 */
const WIND_BODY = /* glsl */`
{
  vec3 windLocal = vec3(uWindDir.x, 0.0, uWindDir.y);
  vec2 windAnchor = vec2(0.0);
  #ifdef USE_INSTANCING
    windAnchor = instanceMatrix[3].xz;
    // The world gust rotated into this instance's own frame. Instances carry a
    // random yaw, and without this every blade bends along its private axis:
    // a field that shivers rather than one a wind crosses. Columns are
    // normalised because the same matrix also carries the per-blade scale.
    vec3 windIx = normalize(instanceMatrix[0].xyz);
    vec3 windIz = normalize(instanceMatrix[2].xyz);
    windLocal = vec3(dot(windLocal, windIx), 0.0, dot(windLocal, windIz));
  #endif
  // Position is the phase reference, so the gust travels across the meadow
  // instead of the whole field pulsing in unison.
  float windPhase = dot(windAnchor, vec2(0.42, 0.31));
  float windT = uWindTime * uWindStrength;
  // Two incommensurate frequencies: a slow bend the eye reads as wind, plus a
  // faster flutter that keeps the loop from ever visibly repeating.
  float gust = sin(windT + windPhase) * 0.68
             + sin(windT * 2.37 + windPhase * 1.9) * 0.24 * uWindChop;
  // Squared, so the anchored end genuinely does not move. A linear lever makes
  // grass look like it is sliding rather than bending.
  float lever = aSway * aSway * uWindGain * aWindGain;
  transformed.xz += windLocal.xz * (gust * lever);
  // A bent stalk is not a stretched one: drop the tip by the arc's sagitta so
  // the silhouette keeps its length.
  transformed.y -= lever * gust * gust * 0.5;
}
`;

/**
 * Advance the meadow's wind.
 *
 * Optional. Until the first call the materials run off a wall clock of their
 * own, so flora dropped into any scene sways without the host knowing it exists.
 * Calling this once takes ownership permanently, which is what a deterministic
 * capture needs — drive it from the scene's fixed step and two runs at the same
 * seed produce the same frame.
 *
 * @param {number} dt seconds since the last call.
 */
export function updateFlora(dt) {
  windDriven = true;
  WIND.uWindTime.value += dt;
}

/**
 * Set the gust's direction and strength, and optionally pin its phase.
 *
 * @param {Object} [opts]
 * @param {THREE.Vector2|{x:number,y:number}} [opts.direction] world XZ; normalised here.
 * @param {number} [opts.strength] time multiplier — the gust's *rate*, not its
 *   amplitude. Amplitude is per-material, set at build time from `windGain`.
 * @param {number} [opts.time] absolute phase in seconds. Supplying it also takes
 *   ownership of the clock, exactly as {@link updateFlora} does.
 */
export function setFloraWind(opts = {}) {
  if (opts.direction) {
    WIND.uWindDir.value.set(opts.direction.x, opts.direction.y).normalize();
  }
  if (opts.strength !== undefined) WIND.uWindStrength.value = opts.strength;
  if (opts.time !== undefined) {
    windDriven = true;
    WIND.uWindTime.value = opts.time;
  }
}

/**
 * Self-clock, installed as `onBeforeRender` on every swaying mesh.
 *
 * Idempotent within a frame by construction: each call advances by the time
 * since the *last* call and then resets the mark, so ten meshes rendering in one
 * frame advance the gust once between them. The 0.1 s clamp stops a tab that was
 * backgrounded for a minute from teleporting the whole meadow on its first frame
 * back.
 */
function tickWindClock() {
  if (windDriven) return;
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  if (windLastWallClock === 0) windLastWallClock = now;
  WIND.uWindTime.value += Math.min(now - windLastWallClock, 0.1);
  windLastWallClock = now;
}

/* -------------------------------------------------------------------------- */
/* Materials                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `shadowDepth` for anything with a leaf in it.
 *
 * 0.48 against the character classes' 0.34. Leaves transmit: on the plate, blades
 * crossing in front of the sun are brighter than the lit ones beside them, and
 * the bed's back edge never goes to a mass. Three has no cheap transmission on a
 * `MeshStandardMaterial`, and a real one on 20 000 instanced blades is not on the
 * table, so the shaded *level* is raised instead. It is the difference between a
 * meadow and a hedge.
 */
const FOLIAGE_SHADOW_DEPTH = 0.48;

/**
 * Build a prop material, optionally with the wind sway compiled in.
 *
 * Deliberately built on `createToonMaterial` rather than a bare
 * `MeshStandardMaterial`: the meadow and the cast stand in the same frame under
 * the same rig, and a prop shaded by a different model is exactly how an
 * environment ends up looking pasted on. The `generic` preset is a *prop* class —
 * `flat: false` — so the fBm detail maps a caller passes are kept, which is legal
 * here and forbidden on a character.
 *
 * `color` is not a parameter. Every flora material is white and the albedo
 * arrives as vertex colour; see the module note on where colour lives.
 *
 * @param {Object} opts
 * @param {Object} [opts.lighting] the `Lighting` rig, aliased for free rim tracking.
 * @param {boolean} [opts.wind] compile the vertex sway in. Requires the geometry
 *   to carry `aSway` and the instanced attribute `aWindGain`.
 * @param {number} [opts.windGain] sway amplitude at the tip, in metres.
 * @param {number} [opts.windChop] weight of the fast flutter term, 0–1.
 * @returns {THREE.MeshStandardMaterial}
 */
function floraMaterial(opts) {
  const material = createToonMaterial({
    preset: opts.preset ?? 'generic',
    lighting: opts.lighting,
    name: opts.name ?? 'flora',
    color: 0xffffff,
    vertexColors: true,
    side: opts.side ?? THREE.DoubleSide,
    roughness: opts.roughness ?? 0.86,
    envMapIntensity: opts.envMapIntensity ?? 0.35,
    shadowDepth: opts.shadowDepth,
    shadowLift: opts.shadowLift,
    /**
     * How far a shadowed fragment's chroma rotates toward `LIGHT.SHADOW_TINT`.
     *
     * The `generic` preset ships **0.40**, and inheriting it turned the whole
     * meadow teal. That number is calibrated for the dusk contre-jour the rest
     * of the art bible is written around, where a blue-shifted shadow is the
     * point; under the plate's high warm key it is a disaster, because a leaf
     * seen at any distance presents mostly its *shadow* side and 40% of a
     * rotation toward `#2E4A5F` on a dark green albedo lands on cyan. Measured
     * on the first sunlit capture: conifer foliage rendered RGB(121,175,173) —
     * hue 176°, i.e. not green at all — and the meadow band's mean saturation
     * came out 0.186 against the plate's 0.491 over the same region.
     *
     * 0.14 keeps §2.1's ban on zero-saturation shadows (the shadow is still
     * measurably cooler and bluer than the lit side) while leaving foliage its
     * own hue, which is what the plate shows: its shaded leaves are *darker
     * green*, not blue.
     */
    shadowMix: opts.shadowMix ?? 0.14,
    /**
     * **No rim light on a plant.** This is the single largest correction the
     * meadow needed and it is worth stating why at length.
     *
     * `generic` is one of `Lighting.RIM_SOLVE_CLASSES`, so a material built
     * from it gets the *character* rim: `rimFloor` 0.35 (a third of the rim is
     * present even head-on), `rimPower` 3.4, and a strength the rig re-solves
     * every frame so the rim's peak luminance lands at 0.55–0.92 — i.e. near
     * white. On a chibi that is correct and invisible except at the contour,
     * because a torso is thick and only its silhouette grazes.
     *
     * A blade of grass is *all* silhouette. A lavender raceme, a conifer spray
     * and a tulip petal likewise: every fragment sits at a grazing angle, so
     * the rim covers the entire surface rather than its edge and the plant is
     * painted out in near-white. Measured on the sunlit capture, conifer
     * foliage whose albedo is `#204527` rendered RGB(121,175,173) and a bed of
     * 3 000 lavender plants produced a *purple pixel fraction of 0.003* over
     * the band it fills — against 0.08 on the plate.
     *
     * The reference agrees with the physics: the shading review's own sweep of
     * `bravely01.jpg` found **no rim anywhere** — every bright silhouette band
     * in that image resolves to albedo, and the sun-facing edge of the red coat
     * *darkens* outward, 188 → 41. So flora asks for none.
     */
    rimGain: opts.rimGain ?? 0,
    /**
     * **No highlight on a plant either**, and for the same reason the rim went.
     *
     * The rim removal above was correct but incomplete: it took out one of the
     * three white, albedo-independent terms `generic` adds, and left the other
     * two. `generic` also ships `specGain: 0.80` (threshold 0.50, softness
     * 0.35), and the thresholded Blinn lobe it drives is evaluated against the
     * *shading* normal — which every blade in this module blends 35–68% toward
     * world up, precisely so a lawn reads as ground. Under the plate's high key
     * that leaves N·H nearly constant over an entire field, so the threshold is
     * crossed by every fragment at once: instead of a highlight somewhere, the
     * whole meadow gets a flat white addition.
     *
     * Measured on `shots/now/cast-stage.png` over the vegetation band behind the
     * cast (x 200–1400, y 230–440, n = 252 000): mean sRGB (196, 191, 176),
     * luminance p50 **210**, 24% of the band above 230, mean saturation 0.170,
     * violet-pixel fraction 0.006. The same band in `bravely01.jpg` (x 820–1500,
     * y 200–430, n = 156 400): mean (79, 93, 89), luminance p50 **83**, 0.0%
     * above 230, saturation 0.468, violet fraction 0.071. Two and a half stops
     * of white laid over a `#4a2f8c` albedo is not a palette problem — it is
     * these two terms, and no albedo survives them.
     *
     * `specGain: 0` does not merely zero the lobe, it drops `TOON_SPECULAR` from
     * the compiled program, which also removes a lobe plus a screen-space edge
     * resolve per light per fragment from the highest-overdraw surfaces in the
     * frame. On the SwiftShader capture that is the cheapest fix available.
     */
    specGain: 0,
    /**
     * The second term, and the one the rim fix could not have caught.
     *
     * The environment specular is `envRadiance × F × uToonEnvSpecular`, with
     * `F = F0 + (F90 − F0)·(1 − N·V)^5`. A blade of grass is *all* grazing —
     * that is the same geometric fact that made the rim cover whole plants — so
     * `N·V → 0`, `(1 − N·V)^5 → 1`, and `F` climbs to the dielectric F90 of 1.0
     * across the entire surface rather than at a contour. `generic`'s
     * `envSpecular: 0.30` therefore adds ~0.27 of the sky probe as **white,
     * un-multiplied by albedo**, against a diffuse ambient of 0.90 × albedo. On
     * `LAVENDER_DEEP` (linear ≈ 0.075, 0.030, 0.276) that white term is larger
     * than the albedo's own green channel, which is exactly how a violet bed
     * arrives at a mean saturation of 0.170.
     *
     * Zeroed rather than reduced: a leaf has no specular lobe worth the name at
     * this scale, and the sky's genuine contribution to flora is diffuse bounce,
     * which still arrives through `envMapIntensity` below. That is the term that
     * should carry the sky — it is multiplied by the albedo and so keeps the
     * plant's hue while lifting its shaded side.
     */
    envSpecular: opts.envSpecular ?? 0,
    ambientGain: opts.ambientGain,
    normalMap: opts.normalMap,
    roughnessMap: opts.roughnessMap,
    normalScale: opts.normalScale,
  });

  if (!opts.wind) return material;

  const windUniforms = {
    ...WIND,
    uWindGain: { value: opts.windGain ?? 0.08 },
    uWindChop: { value: opts.windChop ?? 1.0 },
  };
  const inner = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    // The toon injection first — it owns the fragment stage and stores the
    // shader on `userData`; ours is vertex-only and cannot disturb it.
    inner.call(material, shader, renderer);
    Object.assign(shader.uniforms, windUniforms);
    shader.vertexShader = injectVertex(shader.vertexShader, '#include <common>', WIND_PARS);
    shader.vertexShader = injectVertex(shader.vertexShader, '#include <begin_vertex>', WIND_BODY);
  };

  // Three keys its program cache on defines, not on `onBeforeCompile`, so a
  // swaying material and a still one built from the same preset would otherwise
  // share a compiled program and whichever compiled first would win. The toon
  // module hits the same hazard and documents it; this is the same fix one layer
  // out.
  const baseKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${baseKey}|flora-wind`;
  material.userData.floraWind = windUniforms;
  return material;
}

/** Append a block after an anchor, reporting a miss loudly — a silently skipped
 *  injection is a meadow that renders correctly but never moves, which is subtle
 *  enough to survive a review. */
function injectVertex(source, anchor, block) {
  if (source.indexOf(anchor) === -1) {
    console.error(`[Flora] vertex anchor "${anchor}" missing; wind sway not compiled.`);
    return source;
  }
  return source.replace(anchor, () => `${anchor}\n${block}`);
}

/** A measured sRGB hex as a linear-space `THREE.Color`, which is the space
 *  vertex-colour and instance-colour buffers are read in. `new THREE.Color(hex)`
 *  already does this under three's colour management; being explicit stops the
 *  next reader wondering whether the conversion happened. A `Color` passed in is
 *  copied through, so a caller may hand a ramp endpoint it computed itself. */
function lin(hex) {
  return hex instanceof THREE.Color
    ? hex.clone()
    : new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

/** Blend two measured percentiles in **linear** light. Used where a ramp wants
 *  an endpoint between two entries of `FLORA_PALETTE` rather than a new
 *  constant: the palette holds what was measured off the plate, and inventing a
 *  fourth green to sit between two of them would leave the next reader unable to
 *  tell a measurement from an adjustment. Blending in sRGB instead would darken
 *  the midpoint by roughly a stop, which is the whole quantity in question. */
function mixLin(a, b, t) {
  return lin(a).lerp(lin(b), t);
}

/* -------------------------------------------------------------------------- */
/* Scatter                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Places for things to grow, with density falling off from the centre.
 *
 * @param {Object} opts
 * @param {Object} opts.rng deterministic source.
 * @param {number} opts.count how many to attempt.
 * @param {number} opts.radius outer radius in metres.
 * @param {number} [opts.innerRadius=0] hole in the middle — a clearing the party
 *   stands in, or the footprint of a prop.
 * @param {number} [opts.falloff=0.55] 0 spreads uniformly by area; 1 piles
 *   everything at the centre. The exponent it drives, `0.5 + falloff/2`, is 0.5
 *   at `falloff = 0`, which is exactly the uniform-areal `sqrt` distribution.
 * @param {number} [opts.clumping=0] 0–1. Above zero, samples are drawn around a
 *   small number of seed points instead of independently, which is how the
 *   plate's lavender and tulips actually sit — in drifts, not evenly sprinkled.
 * @param {(x:number,z:number)=>number} [opts.mask] 0–1 probability of keeping a
 *   sample. This is how a caller carves the dirt path out of the lawn.
 * @returns {Array<{x:number,z:number,t:number}>} `t` is the normalised radius,
 *   for callers that grow things larger the further out they sit.
 */
function scatter(opts) {
  const {
    rng, count, radius, innerRadius = 0, falloff = 0.55, clumping = 0, mask,
  } = opts;
  const exponent = 0.5 + falloff * 0.5;
  const out = [];

  // Drift seeds. Roughly one per twenty plants gives clumps the size the plate
  // shows; far fewer and the bed becomes a handful of bushes.
  const seeds = [];
  if (clumping > 0) {
    const n = Math.max(3, Math.round(count / 20));
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = innerRadius + (radius - innerRadius) * Math.pow(rng.next(), exponent);
      seeds.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
  }

  for (let i = 0; i < count; i++) {
    let x;
    let z;
    if (clumping > 0 && rng.next() < clumping) {
      const s = rng.pick(seeds);
      const spread = radius * 0.10;
      x = s[0] + rng.jitter(spread);
      z = s[1] + rng.jitter(spread);
    } else {
      const a = rng.range(0, Math.PI * 2);
      const r = innerRadius + (radius - innerRadius) * Math.pow(rng.next(), exponent);
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
    }
    const t = Math.min(1, Math.hypot(x, z) / radius);
    // Rejected samples are dropped rather than retried: a retry loop against a
    // mask that covers most of the disc spins, and the caller asked for a count
    // to *attempt*, which is the number that bounds the cost.
    if (mask && rng.next() > mask(x, z)) continue;
    out.push({ x, z, t });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Geometry primitives                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One grass blade: a tapered strip that arcs away from vertical and comes to a
 * point.
 *
 * Real geometry, not a texture on a quad, because the blade *is* the read — the
 * plate's near lawn resolves individual blade tips against the dirt path, and a
 * cutout on a card gives you a card. The blade is built at unit height and unit
 * width so one geometry serves every tier of the meadow through instance scale.
 *
 * `normal` is deliberately not the geometric one. A blade's true normal points
 * sideways, which under a high sun turns a lawn into a dark bristle mat; the
 * plate's lawn is the brightest large surface in the frame. Blending 55% toward
 * world up is the standard fix and it is what makes the field read as *ground*.
 */
function bladeGeometry(opts = {}) {
  const {
    segments = 5,
    droop = 0.42,
    taper = 0.62,
    serration = 0.0,
    rootColor = FLORA_PALETTE.GRASS_ROOT,
    tipColor = FLORA_PALETTE.GRASS_TIP,
    upBlend = 0.55,
  } = opts;

  const pos = [];
  const nrm = [];
  const uvs = [];
  const cols = [];
  const idx = [];
  const root = lin(rootColor);
  const tip = lin(tipColor);
  const c = new THREE.Color();
  const n = new THREE.Vector3();

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // Quadratic arc: stiff at the base, falling away at the tip. A blade that
    // leans linearly reads as a straw.
    const z = droop * t * t;
    const y = t * (1 - droop * t * t * 0.30);
    let halfWidth = 0.5 * Math.pow(1 - t, taper);
    if (serration > 0) {
      // Sawtooth on the outline. Used by the conifer sprays, where the notched
      // silhouette is the difference between needles and a leaf.
      halfWidth *= 1 - serration * (i % 2);
    }

    // Strip tangent, from the arc's derivative.
    const dy = 1 - droop * t * t * 0.90;
    const dz = 2 * droop * t;
    n.set(0, dz, -dy).normalize();
    n.set(n.x * (1 - upBlend), n.y * (1 - upBlend) + upBlend, n.z * (1 - upBlend)).normalize();

    c.copy(root).lerp(tip, Math.pow(t, 0.8));

    for (const s of [-1, 1]) {
      pos.push(s * halfWidth, y, z);
      nrm.push(n.x, n.y, n.z);
      uvs.push(s > 0 ? 1 : 0, t);
      cols.push(c.r, c.g, c.b);
    }
    if (i < segments) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(idx);
  return geo;
}

/**
 * Write the per-vertex sway lever onto a geometry.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {(x:number,y:number,z:number)=>number} fn 0 at the anchored end, 1 at
 *   the free tip.
 */
function setSway(geo, fn) {
  const pos = geo.getAttribute('position');
  const sway = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    sway[i] = fn(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  geo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
  return geo;
}

/**
 * A generic petal surface: a cupped, tapered lozenge swept around an axis.
 *
 * Three columns across the width rather than two, because the middle one is what
 * makes the petal *concave*. A tulip on the plate is a goblet — you can see the
 * inside of the near petals and the outside of the far ones in the same flower —
 * and a flat two-column strip cannot show that at any width.
 *
 * @param {Object} opts
 * @param {number} opts.petals how many around the axis.
 * @param {number} opts.rows lengthwise subdivisions.
 * @param {(t:number)=>number} opts.radius distance from the axis at `t` along
 *   the petal. This function is the flower's whole silhouette.
 * @param {(t:number)=>number} opts.height height at `t`.
 * @param {(t:number)=>number} opts.width half-width at `t`.
 * @param {number} [opts.cup=0.35] how far the middle column bows outward, as a
 *   fraction of the half-width.
 * @param {number} [opts.phase=0] rotation offset, for stacking whorls.
 * @param {number} [opts.notch=0] pulls the tip's middle column back down the
 *   petal — a cherry petal is notched, a tulip petal is not.
 * @param {(t:number)=>THREE.Color} opts.colorAt vertex colour along the petal.
 */
function petalWhorlGeometry(opts) {
  const {
    petals, rows, radius, height, width, cup = 0.35, phase = 0, notch = 0, colorAt,
  } = opts;
  const pos = [];
  const nrm = [];
  const uvs = [];
  const cols = [];
  const idx = [];
  const cols3 = 3;
  const v = new THREE.Vector3();

  for (let p = 0; p < petals; p++) {
    const a = phase + (p / petals) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const base = p * rows * cols3;

    for (let i = 0; i < rows; i++) {
      let t = i / (rows - 1);
      const r = radius(t);
      const h = height(t);
      const w = width(t);
      for (let j = 0; j < cols3; j++) {
        const s = j - 1; // -1, 0, +1 across the petal
        // Tangential offset is a chord across the petal's width; the middle
        // column is pushed out along the radius to cup it.
        const bow = j === 1 ? cup * w : 0;
        const rr = r + bow;
        const px = ca * rr - sa * (s * w);
        const pz = sa * rr + ca * (s * w);
        const py = h - (j === 1 ? notch * height(1) * t * t : 0);
        pos.push(px, py, pz);
        // Outward-and-up: a petal's lit face is the one turned toward the sky,
        // and this is the same reasoning as the blade's `upBlend`.
        v.set(ca, 0.55, sa).normalize();
        nrm.push(v.x, v.y, v.z);
        uvs.push(j / (cols3 - 1), t);
        const c = colorAt(t, j);
        cols.push(c.r, c.g, c.b);
      }
      if (i < rows - 1) {
        for (let j = 0; j < cols3 - 1; j++) {
          const q = base + i * cols3 + j;
          idx.push(q, q + 1, q + cols3, q + 1, q + cols3 + 1, q + cols3);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(idx);
  return geo;
}

/** A tapered stem as a low-sided prism. Five sides: enough that the silhouette
 *  is round at a metre and cheap enough to put ten thousand of in a bed. */
function stemGeometry(opts) {
  const {
    height, radiusBottom, radiusTop, bend = 0, segments = 3, radial = 5,
    rootColor = FLORA_PALETTE.TULIP_STEM, tipColor = FLORA_PALETTE.TULIP_STEM,
  } = opts;
  const pos = [];
  const nrm = [];
  const uvs = [];
  const cols = [];
  const idx = [];
  const root = lin(rootColor);
  const tip = lin(tipColor);
  const c = new THREE.Color();

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const r = radiusBottom + (radiusTop - radiusBottom) * t;
    const y = height * t;
    const z = bend * t * t;
    c.copy(root).lerp(tip, t);
    for (let k = 0; k <= radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      pos.push(cx * r, y, cz * r + z);
      nrm.push(cx, 0.12, cz);
      uvs.push(k / radial, t);
      cols.push(c.r, c.g, c.b);
    }
    if (i < segments) {
      for (let k = 0; k < radial; k++) {
        const a0 = i * (radial + 1) + k;
        const a1 = a0 + radial + 1;
        idx.push(a0, a1, a0 + 1, a0 + 1, a1, a1 + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(idx);
  geo.normalizeNormals();
  return geo;
}

/** Shared world up. Read-only by convention — nothing here writes it. */
const WORLD_UP = new THREE.Vector3(0, 1, 0);

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v3 = new THREE.Vector3();
const _s3 = new THREE.Vector3();
const _t3 = new THREE.Vector3();

/**
 * Transform a geometry by translation + Euler rotation + scale, in place.
 *
 * `order` is exposed and it matters. Three's default `'XYZ'` composes as
 * `Rx·Ry·Rz`, which makes the *X* tilt the outermost rotation — so a part yawed
 * into place and then tilted ends up tilted about the world X axis rather than
 * about its own. On the conifer, where every spray in a tier is yawed to a
 * different azimuth and then laid over toward horizontal, that collapses the
 * whole whorl into one direction. `'YXZ'` puts the yaw outermost, which is what
 * "point it that way, then lay it down" actually means.
 */
function placed(geo, x, y, z, rx, ry, rz, sx = 1, sy = 1, sz = 1, order = 'XYZ') {
  _e.set(rx, ry, rz, order);
  _q.setFromEuler(_e);
  _v3.set(x, y, z);
  _s3.set(sx, sy, sz);
  return geo.applyMatrix4(_m4.compose(_v3, _q, _s3));
}

/**
 * Merge, dispose the parts, and return one geometry.
 *
 * `mergeGeometries` requires every input to carry the same attribute set, which
 * is why every primitive above writes `position`/`normal`/`uv`/`color` whether it
 * needs them or not. `aSway` is applied *after* the merge, from world position,
 * so a merged plant's lever is continuous across its parts.
 */
function mergeAndDispose(parts) {
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged;
}

/**
 * Turn a geometry into an `InstancedMesh` with the per-instance wind gain
 * attribute attached.
 *
 * `computeBoundingSphere` is called after the matrices are written so the mesh
 * culls against its real extent — an `InstancedMesh` left with the source
 * geometry's bounds either pops out at the screen edge or, if the caller
 * disables culling to avoid that, costs a full field draw when it is off screen.
 */
function instanced(geo, material, count, fill, { castShadow = false, receiveShadow = true } = {}) {
  const mesh = new THREE.InstancedMesh(geo, material, count);
  const gains = new Float32Array(count);
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // Reset rather than trust the callback: instance colour *multiplies* the
    // vertex albedo, so a fill that does not care about tint must leave white
    // behind. Carrying the previous instance's value forward — or leaving the
    // constructor's black — silently darkens or erases the whole mesh.
    color.setRGB(1, 1, 1);
    gains[i] = fill(i, matrix, color) ?? 1;
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, color);
  }
  geo.setAttribute('aWindGain', new THREE.InstancedBufferAttribute(gains, 1));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  mesh.computeBoundingSphere();
  if (material.userData.floraWind) mesh.onBeforeRender = tickWindClock;
  return mesh;
}

/**
 * A recursive branching skeleton, shared by every tree in this module that has
 * one.
 *
 * Extracted from the cherry rather than written for the broadleaf, because the
 * two trees differ in their *canopy*, not in their wood: both are a trunk that
 * forks three ways, then two-or-three ways per order, with each order drooping
 * harder than its parent because thin wood cannot hold itself up. Growing the
 * broadleaf's canopy on a second, independently-written skeleton would have been
 * the fastest way to end up with two trees that light differently at the trunk.
 *
 * The defaults are the cherry's own, exactly, and the `rng` draw order is
 * unchanged from the inlined version — a tree is dressed off this stream and a
 * reordered draw is a differently-shaped tree in every capture that follows.
 *
 * @param {Object} o
 * @param {Object} o.rng deterministic source.
 * @param {number} o.length trunk segment length in metres.
 * @param {number} o.radius trunk radius at the ground.
 * @param {number} [o.maxDepth=4] branching orders.
 * @param {number} [o.lean=0.07] how far off vertical the trunk may start.
 * @param {number} [o.twigDepth=2] the first order that carries foliage anchors.
 *   Below it a canopy hangs off the trunk, which is the classic tell of a tree
 *   whose foliage was scattered in a sphere.
 * @param {number} [o.droop] gravity added to the direction per step at depth 0.
 * @param {number} [o.droopPerDepth] extra gravity per branching order.
 * @param {[number,number]} [o.spread] how far a child leaves its parent's axis.
 * @param {[number,number]} [o.rise] upward bias added to a child's direction.
 * @returns {{segments: Array, twigs: Array}} `segments` are `{a,b,ra,rb,depth}`
 *   for the wood; `twigs` are `{p,d,depth}` anchors for whatever hangs on it.
 */
function growSkeleton(o) {
  const {
    rng, length, radius,
    maxDepth = 4, lean = 0.07, twigDepth = 2,
    droop = 0.055, droopPerDepth = 0.032, wander = 0.10,
    spread = [0.55, 1.05], rise = [0.04, 0.28],
    lengthDecay = [0.58, 0.76], radiusDecay = [0.56, 0.72],
    taper = 0.42,
  } = o;

  const segments = [];
  const twigs = [];

  const grow = (origin, dir, len, rad, depth) => {
    const steps = depth === 0 ? 4 : 3;
    const stepLen = len / steps;
    const p = origin.clone();
    const d = dir.clone();
    let r = rad;
    for (let i = 0; i < steps; i++) {
      const nr = rad * (1 - ((i + 1) / steps) * taper);
      const b = p.clone().addScaledVector(d, stepLen);
      segments.push({ a: p.clone(), b: b.clone(), ra: r, rb: nr, depth });
      if (depth >= twigDepth) twigs.push({ p: b.clone(), d: d.clone(), depth });
      p.copy(b);
      r = nr;
      d.y -= droop + depth * droopPerDepth;
      d.x += rng.jitter(wander);
      d.z += rng.jitter(wander);
      d.normalize();
    }
    if (depth >= maxDepth) return;
    const children = depth === 0 ? 3 : rng.int(2, 3);
    for (let c = 0; c < children; c++) {
      const child = d.clone();
      const a = rng.range(0, Math.PI * 2);
      const side = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      // Orthogonalise against the parent so the spread angle means what it says
      // whatever direction the parent happens to point.
      side.addScaledVector(d, -side.dot(d));
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      child.addScaledVector(side, rng.range(spread[0], spread[1]));
      child.y += rng.range(rise[0], rise[1]);
      child.normalize();
      grow(
        p, child,
        len * rng.range(lengthDecay[0], lengthDecay[1]),
        r * rng.range(radiusDecay[0], radiusDecay[1]),
        depth + 1,
      );
    }
  };

  grow(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(rng.jitter(lean), 1, rng.jitter(lean)).normalize(),
    length, radius, 0,
  );
  return { segments, twigs };
}

/**
 * Turn a skeleton's segments into one merged bark geometry.
 *
 * Radial count falls with branching order — a fourth-order twig is under two
 * pixels across at any distance a battle camera uses, and a 7-gon there costs
 * the same as a 7-gon on the trunk.
 *
 * @param {Array} segments from {@link growSkeleton}.
 * @param {number} maxDepth for the bark colour ramp's normalisation.
 * @param {number|THREE.Color} darkHex bark in the canopy's shade.
 * @param {number|THREE.Color} litHex young wood at the branch tips.
 */
function barkGeometry(segments, maxDepth, darkHex, litHex) {
  const parts = [];
  const axis = new THREE.Vector3();
  const dark = lin(darkHex);
  const lit = lin(litHex);
  const barkColor = new THREE.Color();
  for (const s of segments) {
    axis.subVectors(s.b, s.a);
    const len = axis.length();
    if (len < 1e-4) continue;
    const radial = s.depth === 0 ? 7 : (s.depth < 3 ? 5 : 4);
    const cyl = new THREE.CylinderGeometry(s.rb, s.ra, len, radial, 1, true);
    // Young wood is the lighter, redder colour; the trunk is nearly black in the
    // plate wherever the canopy shades it.
    barkColor.copy(dark).lerp(lit, Math.min(1, s.depth / maxDepth));
    const n = cyl.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      col[i * 3] = barkColor.r;
      col[i * 3 + 1] = barkColor.g;
      col[i * 3 + 2] = barkColor.b;
    }
    cyl.setAttribute('color', new THREE.BufferAttribute(col, 3));
    axis.normalize();
    _q.setFromUnitVectors(WORLD_UP, axis);
    _v3.copy(s.a).addScaledVector(axis, len * 0.5);
    _s3.set(1, 1, 1);
    cyl.applyMatrix4(_m4.compose(_v3, _q, _s3));
    parts.push(cyl);
  }
  return mergeAndDispose(parts);
}

/**
 * Multiply a geometry's vertex colours by a tint, in place, in linear light.
 *
 * The escape hatch for a prop whose colours are authored in another module.
 * `props/RockForms.js` writes the plate's *facet relationship* — a pale
 * weathered top over a cleaved blue side — and that relationship is correct;
 * what it cannot know is the exposure of the frame it will end up in. Ours
 * renders those faces at sRGB 180+ against the plate's own p50 of 137, i.e. the
 * rock is a full stop hotter than the reference and reads as chalk.
 *
 * Doing it here rather than through `material.color` is the module's standing
 * rule: the material is white, the albedo is the vertex attribute, and a second
 * colour on the material is how two greens end up multiplying to a black lawn.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {number|THREE.Color|null} tint sRGB hex read as "what a white face
 *   becomes". `null` is a no-op, so a caller may pass an absent option straight
 *   through.
 */
function tintVertexColors(geo, tint) {
  if (tint === null || tint === undefined) return geo;
  const attr = geo.getAttribute('color');
  if (!attr) return geo;
  const t = lin(tint);
  for (let i = 0; i < attr.count; i++) {
    attr.setXYZ(i, attr.getX(i) * t.r, attr.getY(i) * t.g, attr.getZ(i) * t.b);
  }
  attr.needsUpdate = true;
  return geo;
}

/** Give a returned root a `dispose()` for the geometry and materials it owns.
 *  Textures are not touched — those belong to whoever's `AssetForge` supplied
 *  them, and that forge guards them against exactly this. */
function ownResources(root, geometries, materials) {
  root.userData.dispose = () => {
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
  };
  return root;
}

/** Common option unpacking. `heightAt` lets a field follow rolling terrain. */
function common(opts) {
  return {
    rng: opts.rng ?? defaultRng,
    lighting: opts.lighting,
    forge: opts.forge,
    heightAt: opts.heightAt ?? (() => 0),
    mask: opts.mask,
  };
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A field of real grass blades on one instanced mesh.
 *
 * The plate has two distinct grasses and this builds either. Near camera the
 * party stands on a **mown lawn**: boots fully clear of it, the surface reading
 * as fine directional streaks about a fifth of a boot long, which is 0.09–0.17 m
 * at a 1.6 m character. Behind them, in the flower bed, the same species is
 * **unmown** — arching blades that reach the lavender's shoulder at 0.55–1.05 m.
 * Pass `preset: 'meadow'` for the second.
 *
 * Density falls off with radius while blade *size* rises, so the far half of a
 * 40 m field costs a fraction of the near half and still covers the ground. That
 * combination is the reason a lawn dense enough to read at 2 m does not become a
 * million draw calls at 40 m — and it is one mesh either way.
 *
 * @param {Object} [opts]
 * @param {number} [opts.radius=14] field radius in metres.
 * @param {number} [opts.count=26000] blades attempted. Rejections by `mask` and
 *   by `innerRadius` come out of this, so the mesh may hold fewer.
 * @param {'lawn'|'meadow'} [opts.preset='lawn']
 * @param {[number,number]} [opts.height] override the preset's blade height range.
 * @param {number} [opts.falloff=0.55] see {@link scatter}.
 * @param {number} [opts.distanceGrowth=0.85] extra blade size at the field's rim,
 *   as a fraction. 0 keeps every blade the same size and thins the far field out.
 * @param {number} [opts.innerRadius=0] a clearing at the centre.
 * @param {(x:number,z:number)=>number} [opts.mask] keep-probability; carve paths with it.
 * @param {(x:number,z:number)=>number} [opts.heightAt] ground height.
 * @param {Object} [opts.lighting] the `Lighting` rig.
 * @param {Object} [opts.rng] deterministic source; defaults to the game RNG.
 * @returns {THREE.InstancedMesh} with `userData.dispose()`.
 */
export function buildGrassField(opts = {}) {
  const { rng, lighting, heightAt, mask } = common(opts);
  const preset = opts.preset ?? 'lawn';
  const isMeadow = preset === 'meadow';

  const [hMin, hMax] = opts.height ?? (isMeadow ? [0.55, 1.05] : [0.09, 0.17]);
  const radius = opts.radius ?? (isMeadow ? 9 : 14);
  const count = opts.count ?? (isMeadow ? 5200 : 34000);
  const growth = opts.distanceGrowth ?? 0.85;
  // Blade width in metres. Real grass is 4 mm and 4 mm blades alias into a
  // shimmering mess at any distance, so the width is set instead by what it
  // takes to *cover*.
  //
  // The lawn's 18 mm was too narrow and it is the reason our near ground read as
  // scattered spikes on a bare plane rather than as turf. Coverage is the only
  // thing that makes a lawn, and of the three ways to buy it — more blades,
  // taller blades, wider blades — only the third is free: width is an instance
  // scale, so it costs no instance, no vertex and no draw call. The capture
  // already runs against a 180 s budget on SwiftShader, so it is the only lever
  // that may be pulled. 26 mm with the flatter taper below is a little over
  // twice the projected area per blade at the same count.
  const bladeWidth = opts.bladeWidth ?? (isMeadow ? 0.030 : 0.026);
  /**
   * How far a blade's tip travels horizontally, as a multiple of its height —
   * the instance's Z scale, against which `droop` is expressed.
   *
   * This is the number that decides whether a lawn is made of *blades* or of
   * *streaks*, and at 0.55 it was making blades. Compared at the party's own
   * depth, the plate's mown lawn has no discrete blade in it anywhere: it is a
   * continuous surface carrying fine directional streaks, and every individual
   * leaf visible in that frame belongs to the taller bed behind. Ours put 30 px
   * spikes standing proud of the ground at the same station.
   *
   * 1.25 with the 0.85 droop below gives a horizontal reach of about 1.06 × the
   * blade's height while the tip falls to 0.75 of it — an arc that lies over and
   * runs along the ground rather than standing on it. That converts the same
   * blade, at the same count and the same vertex cost, from an object casting
   * its own silhouette into a stroke lying in the surface, which is what the
   * plate shows and what this module's own header already described.
   *
   * The bed's tufts keep 0.55: there the blade is meant to stand and arch, and
   * its silhouette against the sky is the whole read.
   */
  const bladeReach = isMeadow ? 0.55 : 1.25;

  const geo = setSway(
    bladeGeometry({
      segments: isMeadow ? 6 : 4,
      // The lawn blade arcs far harder than it did. A 6–10 cm blade standing at
      // droop 0.30 is a vertical tick with clear ground either side of it; the
      // plate's mown lawn has no visible ground between its blades at all,
      // because each one lies over into its neighbours. This is the same
      // coverage argument as the width and it is likewise free. See
      // `bladeReach` — droop is a fraction of that reach, so the two multiply.
      droop: isMeadow ? 0.62 : 0.85,
      // `halfWidth = 0.5·(1−t)^taper`, so the exponent decides how quickly the
      // blade comes to a point. 0.62 puts a needle on the lawn — 24% of full
      // width nine tenths of the way up — and a field of needles is a field of
      // spikes. The plate's lawn resolves as *streaks* that hold their weight
      // most of their length, which is 0.38 (45% at the same station). The bed's
      // tufts stay sharp: there the pointed silhouette is the read.
      taper: isMeadow ? 0.62 : 0.38,
      // The lawn's within-blade ramp is deliberately much shorter than the
      // meadow's. Measured percentiles over the plate's lawn are p10 #2b4b1b,
      // p50 #5b763c, p90 #7e9659 — but that spread lives *between* patches and
      // between lit and shaded ground, not inside one 6 cm blade. Running the
      // full p10→p90 up an object 10 px tall puts a two-stop gradient at the
      // pixel scale, and a dark base under a pale tip is precisely what the eye
      // reads as a spike lying on a plane rather than as ground cover. Starting
      // the ramp at the measured p50 keeps the blade close to the value of the
      // ground it grows out of, and the p10 end arrives where the plate puts
      // it — in the shaded troughs, from the shading model. 0.42 of the way from
      // the p10 entry to the tip resolves to #5f783f, which is the plate's own
      // p50 of #5b763c to within four code values on every channel.
      rootColor: isMeadow
        ? FLORA_PALETTE.MEADOW_ROOT
        : mixLin(FLORA_PALETTE.GRASS_ROOT, FLORA_PALETTE.GRASS_TIP, 0.42),
      tipColor: isMeadow ? FLORA_PALETTE.MEADOW_TIP : FLORA_PALETTE.GRASS_TIP,
      // A mown lawn is seen almost edge-on from a battle camera, so its blades
      // need the strongest push toward a ground normal; the bed's tufts are seen
      // side-on and keep more of their own shape.
      upBlend: isMeadow ? 0.42 : 0.68,
    }),
    (x, y) => y,
  );

  const material = floraMaterial({
    name: `flora:grass-${preset}`,
    lighting,
    wind: true,
    // Amplitude scales with the blade: a 12 cm lawn blade that swings 8 cm is a
    // lawn in a gale. Expressed against the tallest blade in the range because
    // the instance scale multiplies it again.
    windGain: hMax * 0.13,
    windChop: isMeadow ? 1.0 : 0.55,
    shadowDepth: FOLIAGE_SHADOW_DEPTH,
    roughness: 0.9,
  });

  const places = scatter({
    rng, count, radius,
    innerRadius: opts.innerRadius ?? 0,
    falloff: opts.falloff ?? 0.55,
    mask,
  });

  const mesh = instanced(geo, material, places.length, (i, m, c) => {
    const p = places[i];
    const size = 1 + p.t * growth;
    const h = rng.range(hMin, hMax) * size;
    _e.set(rng.jitter(0.14), rng.range(0, Math.PI * 2), rng.jitter(0.20));
    _q.setFromEuler(_e);
    // Set slightly below the surface so no blade shows a floating root edge on
    // a slope. Width is not scaled by height — coupling them turns a tuft of
    // grass into agave.
    _v3.set(p.x, heightAt(p.x, p.z) - h * 0.06, p.z);
    _s3.set(rng.range(0.65, 1.05) * bladeWidth * size, h, h * bladeReach);
    m.compose(_v3, _q, _s3);
    // Value drift across the field — still there, but now at the *spatial*
    // frequency the plate actually shows it at.
    //
    // The field must not sit at one value; that reads as felt, and the measured
    // p10→p90 spread of nearly two stops is real. But drawing each blade's value
    // independently puts that whole spread between one blade and the blade
    // beside it, which is salt-and-pepper at the pixel scale and is the other
    // half of why our near ground read as scattered spikes: a bright blade
    // against a dark neighbour separates, and a field of separated blades is
    // never ground cover however dense it gets. On the plate the lawn's value
    // varies over patches a metre or two across — sun through the canopy, a
    // slight roll in the ground — and neighbouring blades agree.
    //
    // So the bulk of the variation is sampled from position instead of from the
    // RNG. Two incommensurate sinusoids are enough: the beat between them gives
    // drifting patches with no visible tiling, and it is evaluated once per
    // blade at build time, so it costs nothing at render.
    const patch = Math.sin(p.x * 0.83 + p.z * 0.51) * Math.cos(p.z * 0.67 - p.x * 0.29);
    // Per-blade jitter is kept but reduced to a tenth of its old range: enough
    // to break the sinusoids' regularity, far too little to detach a blade from
    // its neighbours.
    const v = (0.94 + patch * 0.17) * rng.range(0.97, 1.03);
    c.setRGB(v * rng.range(0.97, 1.02), v, v * rng.range(0.93, 1.0));
    return rng.range(0.7, 1.35);
  }, { castShadow: false, receiveShadow: true });

  mesh.name = `grass-${preset}`;
  return ownResources(mesh, [geo], [material]);
}

/**
 * The two ends of the plate's violet, as the anchors a drift's `hueShift` pulls
 * toward.
 *
 * A single lavender colour is what made our bed a wall. Masked over the plate's
 * bed the violet is not one hue at all: it separates into a cold indigo in the
 * shaded interior runs (hue 262°) and a warm red-violet on the sunlit near
 * drifts (hue 288°), a 26° spread that survives at every distance in the frame
 * because it is *drift-scale* — one clump is cold, the clump beside it is warm —
 * rather than per-plant noise, which averages to grey at four pixels.
 *
 * These two are therefore deliberately **not** in `FLORA_PALETTE`: that table
 * holds measured percentiles of a masked region, and these are the endpoints of
 * an authored spread, applied at half strength so no drift ever leaves the
 * measured p10–p90 band.
 */
const LAVENDER_INDIGO = 0x3a2fa4;
const LAVENDER_MAGENTA = 0x9a55c0;

/**
 * A drift of lavender: tall vertical spikes of individual florets.
 *
 * The plate's lavender is the element that carries the bed. Each plant is a fan
 * of bare stems, and the top third of each stem is a **raceme** — florets in
 * whorls up the axis, biggest and most saturated low down, shading to pale
 * unopened buds at the tip. Measured at 0.65–0.85 × character overall, so
 * 1.05–1.35 m, with the floret column about 35% of that.
 *
 * Built as spikes rather than as plants: a lavender clump *is* a scatter of
 * spikes, so instancing them individually gives clumps a natural, uneven
 * silhouette for one draw call instead of giving every plant the same one. The
 * basal foliage is a second instanced mesh of long blades, because on the plate
 * you can see grass-like leaves pushing up between the stems everywhere.
 *
 * @param {Object} [opts]
 * @param {number} [opts.radius=6] drift radius.
 * @param {number} [opts.count=520] spikes.
 * @param {[number,number]} [opts.height=[1.05,1.35]] total spike height, metres.
 * @param {number} [opts.spikeRatio=0.35] fraction of the height carrying florets.
 * @param {number} [opts.whorls=9] floret whorls up the raceme.
 * @param {number} [opts.paleFraction=0.08] share of near-white spikes; the plate
 *   has roughly one in twelve.
 * @param {number} [opts.foliage=1] multiplier on the basal leaf count; 0 omits it.
 * @param {number} [opts.hueShift=0] −1 … +1, indigo … magenta. See
 *   {@link LAVENDER_INDIGO}.
 * @returns {THREE.Group} with `userData.dispose()`.
 */
export function buildLavender(opts = {}) {
  const { rng, lighting, heightAt, mask } = common(opts);
  const radius = opts.radius ?? 6;
  const count = opts.count ?? 520;
  const [hMin, hMax] = opts.height ?? [1.05, 1.35];
  const spikeRatio = opts.spikeRatio ?? 0.35;
  const whorls = opts.whorls ?? 9;
  const paleFraction = opts.paleFraction ?? 0.08;

  const group = new THREE.Group();
  group.name = 'lavender';

  /* --- the spike: one stem plus a raceme of florets, unit height ---------- */
  const parts = [];
  const stemTop = 1 - spikeRatio;
  parts.push(stemGeometry({
    height: 1.0,
    radiusBottom: 0.006,
    radiusTop: 0.0035,
    bend: 0.05,
    segments: 3,
    rootColor: FLORA_PALETTE.LAVENDER_STEM,
    tipColor: FLORA_PALETTE.LAVENDER_STEM,
  }));

  // The whole raceme ramp, rotated toward one end of the plate's own violet
  // spread. See {@link LAVENDER_INDIGO} for what the two anchors are and why
  // this exists at all.
  const hueShift = opts.hueShift ?? 0;
  const anchor = lin(hueShift < 0 ? LAVENDER_INDIGO : LAVENDER_MAGENTA);
  const shift = Math.min(1, Math.abs(hueShift)) * 0.5;
  const deep = lin(FLORA_PALETTE.LAVENDER_DEEP).lerp(anchor, shift * 0.7);
  const mid = lin(FLORA_PALETTE.LAVENDER_MID).lerp(anchor, shift);
  const pale = lin(FLORA_PALETTE.LAVENDER_PALE).lerp(anchor, shift * 0.45);
  const floretColor = new THREE.Color();

  for (let w = 0; w < whorls; w++) {
    const u = w / (whorls - 1);
    const y = stemTop + spikeRatio * (0.04 + u * 0.96);
    // Florets are fattest at the base of the raceme and taper to buds. The
    // silhouette that produces — a soft spearhead, not a cylinder — is the
    // single most recognisable thing about lavender at 10 m.
    const scale = (0.95 - 0.42 * u * u) * spikeRatio;
    // Two florets per whorl, alternating 90° so the spike is not flat from any
    // angle. Cheaper than three and indistinguishable past two metres.
    const phase = w * 1.87;
    // Base of the raceme is deepest, tip is nearly white with unopened buds.
    //
    // Both rates were too fast. The masked lavender in the plate runs p10
    // #3e2479 → p50 #6144a0 → p90 #936dc8, so a raceme's *mean* should land near
    // `LAVENDER_MID` with `LAVENDER_DEEP` holding most of the lower column and
    // the pale buds confined to the tip. Reaching full mid by u = 0.5 and then
    // washing to `LAVENDER_PALE` over the entire top 45% put the raceme's mean
    // above p90 — a bed of pale mauve where the plate has saturated violet.
    // Zoomed on the plate the near-white buds are the top sixth of a spike at
    // most; below that it is solid colour.
    floretColor.copy(deep).lerp(mid, Math.min(1, u * 1.4));
    if (u > 0.78) floretColor.lerp(pale, (u - 0.78) / 0.22);

    const floret = petalWhorlGeometry({
      petals: 4,
      rows: 2,
      phase,
      // A raceme is a *column*, not a string of beads, and this is where ours
      // stopped being one.
      //
      // Whorls sit `spikeRatio·0.96/(whorls−1)` apart — 0.042 of the spike's
      // height at the defaults. The florets were 0.020 tall before the `scale`
      // above shrank them to 0.006, so better than four fifths of the raceme's
      // volume was air, and at the 11–16 m the bed actually sits at the grass
      // behind simply showed through and averaged the violet away. Measured on
      // the last capture: violet-pixel fraction 0.008 over the band, against
      // 0.071 for the same band in the plate and 0.167 inside the plate's dense
      // bed. Run-length over the plate's violet mask gives contiguous
      // *horizontal* runs of 7 px median and 18 px at p90 — solid columns, with
      // nothing dotted about them.
      //
      // So the florets are sized to close on their neighbours instead. The
      // condition is `span × scale(0) ≥ spacing`: 0.135 × 0.3325 = 0.0449
      // against 0.042, so the lower whorls overlap by about 7% and the base of
      // the raceme is continuous colour with no grass visible through it. The
      // taper in `scale` still opens the top out into separate buds — at u = 1
      // the same span covers only 0.025 of a 0.042 gap — which is the spearhead
      // silhouette the plate shows and the reason this is not simply a cylinder.
      //
      // Radial reach is set from the plate's own proportion: 0.068 × 0.3325 is a
      // half-width of 0.023 against a 0.35 raceme, i.e. a width-to-length ratio
      // of 0.13, or 5.4 cm across on a 1.2 m spike. This costs nothing — it is
      // the same 9 whorls of the same 4 petals on the same instanced geometry,
      // so the meadow gains its violet for zero triangles and zero draw calls,
      // which is the only kind of fix the capture's time budget allows.
      radius: (t) => 0.014 + 0.054 * t,
      // Starts below its own whorl anchor and finishes above it, so the floret
      // straddles the gap rather than hanging under the next one up.
      height: (t) => -0.048 + 0.135 * t,
      width: (t) => 0.024 * (1 - t * 0.5),
      cup: 0.5,
      colorAt: (t) => floretColor,
    });
    parts.push(placed(floret, 0, y, 0, 0, 0, 0, scale, scale, scale));
  }

  const spikeGeo = setSway(mergeAndDispose(parts), (x, y) => y);

  const spikeMat = floraMaterial({
    name: 'flora:lavender-spike',
    lighting,
    wind: true,
    windGain: 0.075,
    windChop: 0.85,
    // A stem is not a leaf: it transmits far less, so it keeps closer to the
    // prop default and the bed gains depth from spikes reading darker than the
    // foliage behind them.
    shadowDepth: 0.38,
    roughness: 0.82,
  });

  const places = scatter({
    rng, count, radius,
    innerRadius: opts.innerRadius ?? 0,
    falloff: opts.falloff ?? 0.35,
    // Lavender grows in drifts on the plate, never evenly sprinkled.
    clumping: opts.clumping ?? 0.7,
    mask,
  });

  const spikes = instanced(spikeGeo, spikeMat, places.length, (i, m, c) => {
    const p = places[i];
    const h = rng.range(hMin, hMax);
    // Real lavender leans; a bed of perfect verticals reads as a pin cushion.
    _e.set(rng.jitter(0.22), rng.range(0, Math.PI * 2), rng.jitter(0.22));
    _q.setFromEuler(_e);
    _v3.set(p.x, heightAt(p.x, p.z), p.z);
    _s3.set(h, h, h);
    m.compose(_v3, _q, _s3);
    if (rng.next() < paleFraction) {
      // A bleached spike, produced by lifting the modulation above 1 rather than
      // by tinting toward white — the multiply cannot desaturate, so the only
      // way to wash a violet out is to raise its level. Bounded well under the
      // point where the albedo would leave the physical range.
      c.setRGB(1.55, 1.42, 1.62);
    } else {
      const v = rng.range(0.78, 1.12);
      c.setRGB(v * rng.range(0.95, 1.06), v * rng.range(0.9, 1.0), v);
    }
    return rng.range(0.75, 1.3);
  }, { castShadow: false, receiveShadow: true });
  spikes.name = 'lavender-spikes';
  group.add(spikes);

  /* --- basal foliage ------------------------------------------------------ */
  const leafCount = Math.round(count * 1.6 * (opts.foliage ?? 1));
  const geometries = [spikeGeo];
  const materials = [spikeMat];

  if (leafCount > 0) {
    const leafGeo = setSway(
      bladeGeometry({
        segments: 6,
        droop: 0.75,
        taper: 0.55,
        rootColor: FLORA_PALETTE.MEADOW_ROOT,
        tipColor: FLORA_PALETTE.MEADOW_TIP,
        upBlend: 0.40,
      }),
      (x, y) => y,
    );
    const leafMat = floraMaterial({
      name: 'flora:lavender-foliage',
      lighting,
      wind: true,
      windGain: 0.10,
      shadowDepth: FOLIAGE_SHADOW_DEPTH,
    });
    const leafPlaces = scatter({
      rng, count: leafCount, radius: radius * 1.05,
      innerRadius: opts.innerRadius ?? 0,
      falloff: opts.falloff ?? 0.35,
      clumping: opts.clumping ?? 0.7,
      mask,
    });
    /**
     * Basal leaves scale with the plant, and this was a genuine bug rather than
     * a tuning miss.
     *
     * The leaf height was an **absolute** 0.45–0.95 m while the spike above it
     * was whatever `height` the caller asked for. At the 1.05–1.35 m default
     * that is invisible — the leaves sit at roughly two thirds of the spike,
     * which is what a lavender clump looks like. Ask for a *short* drift, as the
     * stage's knee-height foreground framing does at 0.34–0.58 m, and the same
     * code plants 0.95 m grass around a 0.4 m flower: measured on the first
     * capture of that drift, blades a metre tall stood two metres from the lens
     * and covered the bottom-right quarter of the frame and three of the six
     * party members from the waist down.
     *
     * Normalised against the 1.20 m the absolute range was implicitly written
     * for, so every existing caller is unchanged to within a percent and a short
     * drift gets short leaves.
     */
    const leafScale = ((hMin + hMax) * 0.5) / 1.20;
    const leaves = instanced(leafGeo, leafMat, leafPlaces.length, (i, m, c) => {
      const p = leafPlaces[i];
      const h = rng.range(0.45, 0.95) * leafScale;
      _e.set(rng.jitter(0.28), rng.range(0, Math.PI * 2), rng.jitter(0.30));
      _q.setFromEuler(_e);
      _v3.set(p.x, heightAt(p.x, p.z) - 0.02, p.z);
      _s3.set(rng.range(0.05, 0.085) * leafScale, h, h * 0.7);
      m.compose(_v3, _q, _s3);
      const v = rng.range(0.82, 1.14);
      c.setRGB(v * rng.range(0.94, 1.04), v, v * rng.range(0.86, 1.0));
      return rng.range(0.8, 1.4);
    }, { castShadow: false, receiveShadow: true });
    leaves.name = 'lavender-foliage';
    group.add(leaves);
    geometries.push(leafGeo);
    materials.push(leafMat);
  }

  return ownResources(group, geometries, materials);
}

/**
 * Tulips — cupped goblets on bare stems, in the plate's red and white.
 *
 * The heads are a separate instanced mesh from the stems, and that split is what
 * makes the colour work: the head geometry is authored **white**, and the red or
 * white of each individual flower arrives as an instance colour multiplied into
 * it. One geometry, one draw call, two species. Tinting a merged stem-and-head
 * plant instead would tint the stem red as well.
 *
 * Two whorls of three petals, offset 60°, with the inner whorl slightly shorter —
 * that is what a tulip is, and it is why the plate's flowers show a dark throat
 * between overlapping petal edges rather than a smooth ball.
 *
 * @param {Object} [opts]
 * @param {number} [opts.radius=6]
 * @param {number} [opts.count=180]
 * @param {[number,number]} [opts.height=[0.42,0.62]] stem height, metres.
 * @param {number} [opts.headLength=0.085] flower head length, metres — measured.
 * @param {number} [opts.whiteFraction=0.45] the plate runs close to even.
 * @returns {THREE.Group} with `userData.dispose()`.
 */
export function buildTulips(opts = {}) {
  const { rng, lighting, heightAt, mask } = common(opts);
  const radius = opts.radius ?? 6;
  const count = opts.count ?? 180;
  const [hMin, hMax] = opts.height ?? [0.42, 0.62];
  const headLength = opts.headLength ?? 0.085;
  const whiteFraction = opts.whiteFraction ?? 0.45;

  const group = new THREE.Group();
  group.name = 'tulips';

  /* --- stem and strap leaves, unit stem height ---------------------------- */
  const stemParts = [stemGeometry({
    height: 1.0,
    radiusBottom: 0.009,
    radiusTop: 0.0065,
    bend: 0.04,
    segments: 3,
    rootColor: 0x40631f,
    tipColor: FLORA_PALETTE.TULIP_STEM,
  })];
  // Two broad strap leaves sheathing the lower stem. Without them a tulip is a
  // lollipop, and the plate clearly shows the leaves splaying at ground level.
  for (let i = 0; i < 2; i++) {
    const leaf = bladeGeometry({
      segments: 5,
      droop: 0.55,
      taper: 0.45,
      rootColor: 0x3c5d1d,
      tipColor: FLORA_PALETTE.TULIP_STEM,
      upBlend: 0.40,
    });
    placed(leaf, 0, 0, 0, 0, i * 2.4 + 0.5, 0, 0.055, rng.range(0.42, 0.62), 0.30);
    stemParts.push(leaf);
  }
  const stemGeo = setSway(mergeAndDispose(stemParts), (x, y) => y);

  /* --- the head, authored white so instance colour can pick the species --- */
  const throat = lin(FLORA_PALETTE.TULIP_THROAT);
  const rim = lin(FLORA_PALETTE.TULIP_WHITE);
  const petalColor = new THREE.Color();
  const headParts = [];
  for (let whorl = 0; whorl < 2; whorl++) {
    const inner = whorl === 1;
    const scale = inner ? 0.88 : 1.0;
    headParts.push(petalWhorlGeometry({
      petals: 3,
      rows: 5,
      phase: inner ? Math.PI / 3 : 0,
      // The goblet profile. Widest a little past halfway, then drawing back in,
      // so the petal tips converge — the plate's tulips are barely open.
      radius: (t) => (0.020 + 0.052 * t - 0.040 * t * t) * scale,
      height: (t) => headLength * t * scale,
      width: (t) => (0.026 * Math.pow(Math.sin(Math.PI * (0.15 + t * 0.85)), 0.7) + 0.004) * scale,
      cup: 0.55,
      colorAt: (t, j) => {
        // Value only, never hue: the hue arrives per instance, and baking one
        // here would make every red tulip and every white tulip the same flower.
        petalColor.copy(throat).lerp(rim, Math.min(1, t * 1.5));
        // The middle column is the petal's outer bow and catches more light.
        return j === 1 ? petalColor.clone().multiplyScalar(1.06) : petalColor;
      },
    }));
  }
  const headGeo = setSway(mergeAndDispose(headParts), () => 1.0);

  // The stem and the head are two meshes and one plant. Everything that decides
  // where a vertex ends up has to agree between them or the flowers drift off
  // their stalks: same sway amplitude, same chop, same per-instance gain, same
  // transform. This is the amplitude both use.
  const TULIP_WIND_GAIN = 0.045;
  const TULIP_WIND_CHOP = 0.5;

  const stemMat = floraMaterial({
    name: 'flora:tulip-stem',
    lighting,
    wind: true,
    windGain: TULIP_WIND_GAIN,
    windChop: TULIP_WIND_CHOP,
    shadowDepth: FOLIAGE_SHADOW_DEPTH,
  });
  const headMat = floraMaterial({
    name: 'flora:tulip-head',
    lighting,
    wind: true,
    windGain: TULIP_WIND_GAIN,
    windChop: TULIP_WIND_CHOP,
    // Petals are the most translucent thing in the frame — the plate's whites
    // glow where the sun is behind them — so they go past the foliage value.
    shadowDepth: 0.58,
    roughness: 0.78,
  });

  const places = scatter({
    rng, count, radius,
    innerRadius: opts.innerRadius ?? 0,
    falloff: opts.falloff ?? 0.4,
    clumping: opts.clumping ?? 0.55,
    mask,
  });

  // One draw of the plants and one of the flowers, sharing a placement list so
  // every head sits exactly on top of its own stem.
  // Drawn once, consumed by both meshes. Drawing them again inside the second
  // fill would give the heads a different lean and a different wind gain from
  // the stems they sit on, which is a defect no amount of tuning recovers from.
  const heights = new Float32Array(places.length);
  const yaws = new Float32Array(places.length);
  const leans = new Float32Array(places.length);
  const gains = new Float32Array(places.length);
  for (let i = 0; i < places.length; i++) {
    heights[i] = rng.range(hMin, hMax);
    yaws[i] = rng.range(0, Math.PI * 2);
    leans[i] = rng.jitter(0.16);
    gains[i] = rng.range(0.8, 1.2);
  }

  const stems = instanced(stemGeo, stemMat, places.length, (i, m, c) => {
    const p = places[i];
    _e.set(leans[i], yaws[i], leans[i] * 0.6);
    _q.setFromEuler(_e);
    _v3.set(p.x, heightAt(p.x, p.z), p.z);
    _s3.set(1, heights[i], 1);
    m.compose(_v3, _q, _s3);
    const v = rng.range(0.88, 1.1);
    c.setRGB(v, v * rng.range(0.98, 1.05), v * rng.range(0.9, 1.0));
    return gains[i];
  }, { castShadow: false, receiveShadow: true });
  stems.name = 'tulip-stems';
  group.add(stems);

  const red = lin(FLORA_PALETTE.TULIP_RED);
  const redDeep = lin(FLORA_PALETTE.TULIP_RED_DEEP);
  const white = lin(FLORA_PALETTE.TULIP_WHITE);
  const heads = instanced(headGeo, headMat, places.length, (i, m, c) => {
    const p = places[i];
    const h = heights[i];
    _e.set(leans[i], yaws[i], leans[i] * 0.6);
    _q.setFromEuler(_e);
    // Sit on the stem's own tip. The stem's instance scale is (1, h, 1) — its
    // radial axes are *not* scaled — so its unit-height geometry puts the tip at
    // local (0, h, bend), with `bend` unscaled at 0.04. Multiplying that z by
    // `h` as well is the easy mistake and it lifts every flower off its stalk by
    // a couple of centimetres.
    _t3.set(0, h, 0.04).applyQuaternion(_q);
    _v3.set(p.x, heightAt(p.x, p.z), p.z).add(_t3);
    _s3.set(1, 1, 1);
    m.compose(_v3, _q, _s3);
    if (rng.next() < whiteFraction) {
      c.copy(white).multiplyScalar(rng.range(0.92, 1.02));
    } else {
      c.copy(red).lerp(redDeep, rng.next() * 0.5).multiplyScalar(rng.range(0.9, 1.1));
    }
    return gains[i];
  }, { castShadow: false, receiveShadow: true });
  heads.name = 'tulip-heads';
  group.add(heads);

  return ownResources(group, [stemGeo, headGeo], [stemMat, headMat]);
}

/**
 * A cherry in full bloom — the meadow's hero prop.
 *
 * Measured off the plate at **1.6–1.75 × character height** with a canopy about
 * 1.15 × wider than it is tall, so a compact, broad ornamental rather than a
 * forest tree. The canopy is emphatically **not** a solid ball: gaps run right
 * through it and you can see the dark maroon branch structure inside, which is
 * what stops a blossom tree looking like candy floss on a stick. So the trunk is
 * a real recursive branching skeleton, and the blossom is instanced *onto* the
 * branches it grew — cluster positions are sampled from the branch segments
 * themselves, never from a sphere.
 *
 * Petals measure ≈ 15 px at the knight's depth, which is 5.7 cm.
 *
 * @param {Object} [opts]
 * @param {number} [opts.height=2.9] overall height in metres.
 * @param {number} [opts.spread=1.15] canopy width as a multiple of height.
 * @param {number} [opts.clusters=340] blossom clusters. Each is three rosettes
 *   of five petals — the plate's blossom reads as bunches, not single flowers.
 * @param {number} [opts.depth=4] branching recursion depth.
 * @param {number} [opts.leafFraction=0.16] share of the clusters replaced by
 *   green leaf sprigs; the plate's cherry carries a few.
 * @param {Object} [opts.forge] an `AssetForge`, to bind its `bark` detail maps.
 * @returns {THREE.Group} with `userData.dispose()`.
 */
export function buildBlossomTree(opts = {}) {
  const { rng, lighting, forge } = common(opts);
  const height = opts.height ?? 2.9;
  const spread = opts.spread ?? 1.15;
  const clusterCount = opts.clusters ?? 340;
  const maxDepth = opts.depth ?? 4;
  const leafFraction = opts.leafFraction ?? 0.16;

  const group = new THREE.Group();
  group.name = 'blossom-tree';

  /* --- skeleton ----------------------------------------------------------- */
  // Only the outer two orders carry flowers (`twigDepth`). A cherry blooms on
  // its young wood, and hanging blossom off the trunk is the classic tell of a
  // tree whose canopy was scattered in a sphere.
  const { segments, twigs } = growSkeleton({
    rng, length: height * 0.34, radius: height * 0.042, maxDepth, twigDepth: 2,
  });

  /* --- branch geometry ---------------------------------------------------- */
  const branchGeo = barkGeometry(
    segments, maxDepth, FLORA_PALETTE.BARK_DARK, FLORA_PALETTE.BARK_LIT,
  );

  const branchMat = floraMaterial({
    name: 'flora:blossom-bark',
    lighting,
    side: THREE.FrontSide,
    roughness: 0.94,
    // Bark is opaque, so it keeps the prop default rather than the foliage lift.
    shadowDepth: 0.30,
    normalMap: forge?.texture('bark/normal') ?? undefined,
    roughnessMap: forge?.texture('bark/roughness') ?? undefined,
  });
  const branches = new THREE.Mesh(branchGeo, branchMat);
  branches.name = 'blossom-branches';
  branches.castShadow = true;
  branches.receiveShadow = true;
  group.add(branches);

  /* --- blossom clusters --------------------------------------------------- */
  const heart = lin(FLORA_PALETTE.BLOSSOM_HEART);
  const petalRim = lin(FLORA_PALETTE.BLOSSOM_PALE);
  const clusterColor = new THREE.Color();
  const rosettes = [];
  for (let k = 0; k < 3; k++) {
    // Three rosettes at small offsets: a cherry flowers in bunches off one bud,
    // and a single five-petal flower per anchor reads as a daisy from any
    // distance the battle camera actually uses.
    const rosette = petalWhorlGeometry({
      petals: 5,
      rows: 3,
      phase: k * 0.9,
      radius: (t) => 0.008 + 0.030 * t,
      height: (t) => 0.012 * t,
      // Measured petal length 0.055 m; the width profile is a rounded blade
      // widest two-thirds out, which is a cherry petal's actual shape.
      width: (t) => 0.019 * Math.pow(Math.sin(Math.PI * (0.18 + t * 0.82)), 0.6),
      cup: 0.22,
      // The notch. A cherry petal is cleft at the tip and a rounded one reads
      // as plum; it costs nothing here because the middle column already exists
      // for the cupping.
      notch: 0.45,
      colorAt: (t) => clusterColor.copy(heart).lerp(petalRim, Math.min(1, t * 1.7)),
    });
    placed(
      rosette,
      rng.jitter(0.030), rng.range(0.0, 0.045), rng.jitter(0.030),
      rng.jitter(0.5), rng.range(0, Math.PI * 2), rng.jitter(0.5),
      1, 1, 1,
    );
    rosettes.push(rosette);
  }
  // Tips move a little more than the bunch's root, so a cluster flexes rather
  // than sliding as a rigid lump.
  const clusterGeo = setSway(mergeAndDispose(rosettes), (x, y, z) => 0.55 + 0.45 * Math.min(1, Math.hypot(x, y, z) / 0.06));

  const clusterMat = floraMaterial({
    name: 'flora:blossom',
    lighting,
    wind: true,
    windGain: 0.035,
    windChop: 1.0,
    shadowDepth: 0.56,
    roughness: 0.8,
  });

  const canopyRadius = height * spread * 0.5;
  const pale = lin(FLORA_PALETTE.BLOSSOM_PALE);
  const deepPink = lin(FLORA_PALETTE.BLOSSOM_DEEP);
  const midPink = lin(FLORA_PALETTE.BLOSSOM);
  const leafGreen = lin(0x486f2c);
  const anchor = new THREE.Vector3();

  const clusters = instanced(clusterGeo, clusterMat, clusterCount, (i, m, c) => {
    const t = twigs.length
      ? twigs[rng.int(0, twigs.length - 1)]
      : { p: new THREE.Vector3(0, height, 0), d: WORLD_UP, depth: maxDepth };
    // Jitter along and around the twig so clusters sit on the wood rather than
    // at a point on it, and scale the jitter to the canopy so a bigger tree does
    // not get a tighter-looking bloom.
    anchor.copy(t.p)
      .addScaledVector(t.d, rng.range(-0.10, 0.06) * height)
      .add(_v3.set(rng.jitter(0.05), rng.jitter(0.05), rng.jitter(0.05)).multiplyScalar(height * 0.35));
    _e.set(rng.range(0, Math.PI * 2), rng.range(0, Math.PI * 2), rng.range(0, Math.PI * 2));
    _q.setFromEuler(_e);
    const s = rng.range(0.75, 1.35);
    _s3.set(s, s, s);
    m.compose(anchor, _q, _s3);
    if (rng.next() < leafFraction) {
      c.copy(leafGreen).multiplyScalar(rng.range(0.8, 1.2));
    } else {
      // Measured spread: p50 #aa6796 to p90 #cd87b2 with highlights past
      // #e19bc0. Sampling the whole range per cluster is what gives the canopy
      // its depth — a canopy at one pink is a paper cutout.
      const u = rng.next();
      c.copy(u < 0.3 ? deepPink : midPink).lerp(pale, rng.next() * 0.7);
    }
    // Clusters further from the trunk hang on thinner wood and move more.
    return 0.6 + Math.min(1.6, anchor.length() / Math.max(0.5, canopyRadius));
    // Casting is worth it here even though the depth pass has no sway compiled
    // into it: the canopy's shadow is the largest thing this prop puts on the
    // ground, and the mismatch it hides is under 4 cm.
  }, { castShadow: true, receiveShadow: true });
  clusters.name = 'blossom-clusters';
  group.add(clusters);

  return ownResources(group, [branchGeo, clusterGeo], [branchMat, clusterMat]);
}

/**
 * A conifer built from layered, drooping sprays — never a cone.
 *
 * The trees flanking the plate are slender cedars whose silhouette is a stack of
 * distinct tiers with air between them, each tier a whorl of flat foliage sprays
 * that droop at the tip. The outline is notched all the way down. A smooth cone
 * with a green texture on it is the single most obvious "programmer tree", so
 * each spray here is a serrated strip: its half-width alternates row by row,
 * which cuts the silhouette into needle clumps for no extra vertices.
 *
 * @param {Object} [opts]
 * @param {number} [opts.count=1] trees. Above one they are instanced, so a grove
 *   is still two draw calls.
 * @param {number} [opts.height=5.2] height in metres.
 * @param {number} [opts.tiers=9] foliage layers.
 * @param {number} [opts.spraysPerTier=10]
 * @param {number} [opts.radius=8] scatter radius when `count > 1`.
 * @returns {THREE.Group} with `userData.dispose()`.
 */
export function buildConiferTree(opts = {}) {
  const { rng, lighting, forge, heightAt, mask } = common(opts);
  const count = opts.count ?? 1;
  const height = opts.height ?? 5.2;
  const tiers = opts.tiers ?? 11;
  // Sixteen, because a conifer's read is *density* — the plate's cedars are a
  // solid feathery mass with the trunk only glimpsed through it. At ten the
  // tiers separate into visible spokes. It costs about 2 000 triangles for the
  // whole tree and the tree is instanced, so a grove pays for it once.
  const spraysPerTier = opts.spraysPerTier ?? 16;

  const group = new THREE.Group();
  group.name = 'conifer';

  /* --- trunk, unit height ------------------------------------------------- */
  const trunkGeo = stemGeometry({
    height: 1.0,
    radiusBottom: 0.048,
    radiusTop: 0.008,
    segments: 3,
    radial: 6,
    rootColor: 0x3a3122,
    tipColor: FLORA_PALETTE.CONIFER_BARK,
  });

  /* --- foliage, unit height ----------------------------------------------- */
  const sprayParts = [];
  for (let tier = 0; tier < tiers; tier++) {
    const u = tier / (tiers - 1);
    // Foliage starts a third of the way up: the plate's cedars show clean trunk
    // below that, and a skirt to the ground reads as a bush.
    const y = 0.30 + 0.70 * u;
    // Width tapers to the leader but not linearly — a fir's lower tiers are
    // nearly as wide as each other and the taper accelerates near the top. 0.24
    // of the height at the base tier makes a tree roughly half as wide as it is
    // tall, which is the proportion the plate's flanking cedars hold.
    const tierRadius = 0.24 * Math.pow(1 - u, 0.72) + 0.025;
    const n = Math.max(4, Math.round(spraysPerTier * (1 - u * 0.45)));
    for (let s = 0; s < n; s++) {
      const spray = bladeGeometry({
        segments: 7,
        // Sprays droop hard at the tip: that downward hook at the end of each
        // layer is the shape that reads as "conifer" in silhouette.
        droop: 0.85,
        taper: 0.35,
        serration: 0.45,
        rootColor: FLORA_PALETTE.CONIFER_DEEP,
        tipColor: FLORA_PALETTE.CONIFER_LIT,
        upBlend: 0.35,
      });
      const a = (s / n) * Math.PI * 2 + tier * 0.7 + rng.jitter(0.16);
      const len = tierRadius * rng.range(0.85, 1.25);
      // Built along +Y then laid over toward horizontal: a spray leaves the
      // trunk almost level and only its own droop (which points along the
      // geometry's +Z, and so ends up pointing at the ground once the spray is
      // laid over) takes it down. `'YXZ'` so the azimuth is the outer rotation —
      // see `placed`.
      placed(
        spray,
        0, y, 0,
        Math.PI * 0.42 + rng.jitter(0.14), -a, 0,
        len * 0.55, len, len * 0.6,
        'YXZ',
      );
      sprayParts.push(spray);
    }
  }
  const foliageGeo = setSway(
    mergeAndDispose(sprayParts),
    // Lever combines how high up the tree the vertex is with how far out along
    // its spray — the leader whips, the bottom tier barely moves.
    (x, y, z) => Math.min(1, (0.15 + 0.85 * y) * (0.35 + 0.65 * Math.min(1, Math.hypot(x, z) / 0.26))),
  );

  const trunkMat = floraMaterial({
    name: 'flora:conifer-bark',
    lighting,
    side: THREE.FrontSide,
    roughness: 0.95,
    shadowDepth: 0.28,
    normalMap: forge?.texture('bark/normal') ?? undefined,
  });
  const foliageMat = floraMaterial({
    name: 'flora:conifer-foliage',
    lighting,
    wind: true,
    windGain: 0.05,
    windChop: 0.9,
    shadowDepth: FOLIAGE_SHADOW_DEPTH,
    roughness: 0.9,
  });

  const places = count === 1
    ? [{ x: 0, z: 0, t: 0 }]
    : scatter({
      rng, count, radius: opts.radius ?? 8,
      innerRadius: opts.innerRadius ?? 0,
      falloff: opts.falloff ?? 0.4,
      mask,
    });

  const scales = new Float32Array(places.length);
  const yaws = new Float32Array(places.length);
  for (let i = 0; i < places.length; i++) {
    scales[i] = height * rng.range(0.8, 1.2);
    yaws[i] = rng.range(0, Math.PI * 2);
  }

  const trunks = instanced(trunkGeo, trunkMat, places.length, (i, m, c) => {
    const p = places[i];
    _e.set(0, yaws[i], 0);
    _q.setFromEuler(_e);
    _v3.set(p.x, heightAt(p.x, p.z), p.z);
    _s3.set(scales[i] * 0.5, scales[i], scales[i] * 0.5);
    m.compose(_v3, _q, _s3);
    const v = rng.range(0.85, 1.12);
    c.setRGB(v * rng.range(0.98, 1.06), v, v * rng.range(0.9, 1.0));
    return 0;
  }, { castShadow: true, receiveShadow: true });
  trunks.name = 'conifer-trunks';
  group.add(trunks);

  const foliage = instanced(foliageGeo, foliageMat, places.length, (i, m, c) => {
    const p = places[i];
    _e.set(0, yaws[i], 0);
    _q.setFromEuler(_e);
    _v3.set(p.x, heightAt(p.x, p.z), p.z);
    _s3.set(scales[i], scales[i], scales[i]);
    m.compose(_v3, _q, _s3);
    // A level and warmth modulation, never a second green: the deep-to-lit ramp
    // already lives in the vertex colour, and multiplying another conifer green
    // into it takes a whole grove to near black.
    const v = rng.range(0.82, 1.18);
    c.setRGB(v * rng.range(0.9, 1.05), v, v * rng.range(0.88, 1.04));
    return rng.range(0.85, 1.2);
  }, { castShadow: true, receiveShadow: true });
  foliage.name = 'conifer-foliage';
  group.add(foliage);

  return ownResources(group, [trunkGeo, foliageGeo], [trunkMat, foliageMat]);
}

/**
 * The angular grey boulder wall behind the meadow.
 *
 * Shape and the pale-top/blue-side facet split are `props/RockForms.js`'s, and
 * the reasoning for both is documented there. What happens here is *staging*:
 * the plate's rocks lean on each other in a ridge, larger toward the middle, and
 * they are half buried in the meadow rather than resting on it.
 *
 * The large blocks are **merged** rather than instanced — there are a dozen of
 * them, each is a distinct hull, and one merged mesh is one draw call with full
 * shape variety, which beats instancing a single hull with random scale. The
 * scatter chips *are* instanced, because there are many and they repeat.
 *
 * @param {Object} [opts]
 * @param {number} [opts.count=9] large blocks.
 * @param {number} [opts.radius=5] cluster radius.
 * @param {number} [opts.size=2.4] typical block size, in metres — the plate's
 *   wall runs 2.8 × character tall, so blocks of roughly 1.5 × character stacked.
 * @param {number} [opts.chips=26] small flat stones scattered around the base.
 * @param {number} [opts.chipRadius] scatter radius for the chips; defaults to
 *   three times the cluster radius, because the plate scatters them well out
 *   across the lawn.
 * @param {Object} [opts.forge] an `AssetForge`, to bind its `stone` detail maps.
 * @param {number} [opts.tint] sRGB hex read as "what a white face becomes",
 *   multiplied into the rock's vertex colours in linear light. See
 *   {@link tintVertexColors}.
 * @returns {THREE.Group} with `userData.dispose()`.
 */
export function buildBoulderCluster(opts = {}) {
  const { rng, lighting, forge, heightAt, mask } = common(opts);
  const count = opts.count ?? 9;
  const radius = opts.radius ?? 5;
  const size = opts.size ?? 2.4;
  const chipCount = opts.chips ?? 26;
  const tint = opts.tint ?? null;

  const group = new THREE.Group();
  group.name = 'boulders';

  const material = floraMaterial({
    name: 'flora:boulder',
    lighting,
    side: THREE.FrontSide,
    roughness: 0.88,
    envMapIntensity: 0.5,
    // The measured facet contrast: up-faces p50 #898b9d against verticals p50
    // #123256 is a linear ratio near 0.11. The prop default of 0.34 leaves rock
    // looking like grey card; this is the number the plate actually shows, and
    // it is the deepest shadow of any surface in the meadow.
    shadowDepth: 0.16,
    normalMap: forge?.texture('stone/normal') ?? undefined,
    roughnessMap: forge?.texture('stone/roughness') ?? undefined,
    normalScale: new THREE.Vector2(0.8, 0.8),
  });

  const geometries = [];

  /* --- the wall ----------------------------------------------------------- */
  const blocks = [];
  for (let i = 0; i < count; i++) {
    // Ridge staging: a random walk along one axis with the largest blocks in the
    // middle, which is the arrangement in the plate — not a ring.
    const along = (i / Math.max(1, count - 1)) * 2 - 1;
    const bulk = 1 - Math.abs(along) * 0.55;
    const s = size * bulk * rng.range(0.7, 1.25);
    const geo = createAngularRockGeometry({
      rng,
      size: s,
      height: rng.range(0.62, 0.95),
      seedPoints: rng.int(11, 15),
      ridge: rng.range(0.3, 0.6),
      cleaves: rng.int(1, 3),
      sink: rng.range(0.1, 0.22),
      uvScale: 0.6,
    });
    const x = along * radius + rng.jitter(radius * 0.18);
    const z = rng.jitter(radius * 0.42);
    // Leaning is what makes a pile of rocks a rock face. The plate's blocks are
    // tipped 10–25° off level and none of them shares an axis with its neighbour.
    placed(
      geo,
      x, heightAt(x, z), z,
      rng.jitter(0.32), rng.range(0, Math.PI * 2), rng.jitter(0.32),
    );
    blocks.push(geo);
  }
  // `mergeGeometries` returns null for an empty list, so a caller asking for
  // chips only ( `count: 0` ) must not reach it.
  if (blocks.length > 0) {
    const wallGeo = tintVertexColors(mergeAndDispose(blocks), tint);
    const wall = new THREE.Mesh(wallGeo, material);
    wall.name = 'boulder-wall';
    wall.castShadow = true;
    wall.receiveShadow = true;
    group.add(wall);
    geometries.push(wallGeo);
  }

  /* --- scatter chips ------------------------------------------------------ */
  if (chipCount > 0) {
    const chipGeo = tintVertexColors(createStoneChipGeometry({ rng, size: size * 0.16 }), tint);
    const places = scatter({
      rng,
      count: chipCount,
      radius: opts.chipRadius ?? radius * 3,
      innerRadius: radius * 0.5,
      falloff: 0.25,
      mask,
    });
    const chips = instanced(chipGeo, material, places.length, (i, m, c) => {
      const p = places[i];
      _e.set(rng.jitter(0.35), rng.range(0, Math.PI * 2), rng.jitter(0.35));
      _q.setFromEuler(_e);
      _v3.set(p.x, heightAt(p.x, p.z), p.z);
      const s = rng.range(0.5, 1.5);
      _s3.set(s, s * rng.range(0.7, 1.2), s);
      m.compose(_v3, _q, _s3);
      const v = rng.range(0.85, 1.2);
      c.setRGB(v, v, v * rng.range(1.0, 1.08));
      return 0;
    }, { castShadow: true, receiveShadow: true });
    chips.name = 'stone-chips';
    group.add(chips);
    geometries.push(chipGeo);
  }

  return ownResources(group, geometries, [material]);
}

/**
 * Small mixed wildflowers scattered through grass.
 *
 * The dressing layer between the lawn and the tall bed: five-petal blooms a few
 * centimetres across on short stems, in the whites, golds and corals the plate
 * dots through its meadow. Like the tulips, the bloom is authored white and the
 * species arrives as an instance colour, so one geometry covers the whole mix.
 *
 * @param {Object} [opts]
 * @param {number} [opts.radius=8]
 * @param {number} [opts.count=420]
 * @param {[number,number]} [opts.height=[0.10,0.22]] stem height, metres.
 * @param {number[]} [opts.colors] sRGB hexes to draw from; defaults to the
 *   plate's white / gold / coral / lilac mix.
 * @param {number[]} [opts.weights] relative frequency per colour.
 * @returns {THREE.Group} with `userData.dispose()`.
 */
export function buildFlowerPatch(opts = {}) {
  const { rng, lighting, heightAt, mask } = common(opts);
  const radius = opts.radius ?? 8;
  const count = opts.count ?? 420;
  const [hMin, hMax] = opts.height ?? [0.10, 0.22];
  const colors = (opts.colors ?? [
    FLORA_PALETTE.PETAL_WHITE,
    FLORA_PALETTE.PETAL_GOLD,
    FLORA_PALETTE.PETAL_CORAL,
    FLORA_PALETTE.PETAL_LILAC,
  ]).map(lin);
  // Whites dominate the plate's ground layer; lilac is the rarest.
  const weights = opts.weights ?? [0.44, 0.24, 0.20, 0.12];
  const cumulative = [];
  let acc = 0;
  for (let i = 0; i < colors.length; i++) {
    acc += weights[i] ?? 1;
    cumulative.push(acc);
  }

  const group = new THREE.Group();
  group.name = 'flower-patch';

  const stemGeo = setSway(stemGeometry({
    height: 1.0,
    radiusBottom: 0.006,
    radiusTop: 0.004,
    bend: 0.08,
    segments: 2,
    radial: 4,
    rootColor: 0x3d6120,
    tipColor: FLORA_PALETTE.TULIP_STEM,
  }), (x, y) => y);

  const heart = lin(FLORA_PALETTE.PETAL_HEART);
  const petalTip = new THREE.Color(1, 1, 1);
  const bloomColor = new THREE.Color();
  const bloomGeo = setSway(petalWhorlGeometry({
    petals: 5,
    rows: 3,
    radius: (t) => 0.004 + 0.022 * t,
    // Nearly flat, faintly dished. A ground wildflower opens to the sky, which
    // is also why it stays visible from a battle camera looking down at it.
    height: (t) => 0.006 * t,
    width: (t) => 0.013 * Math.pow(Math.sin(Math.PI * (0.2 + t * 0.8)), 0.6),
    cup: -0.15,
    colorAt: (t) => bloomColor.copy(heart).lerp(petalTip, Math.min(1, t * 2.6)),
  }), () => 1.0);

  // As with the tulips: one plant, two meshes, so the two materials must agree
  // about how far a tip travels or the blooms come off their stems.
  const BLOOM_WIND_GAIN = 0.03;
  const BLOOM_WIND_CHOP = 0.7;

  const stemMat = floraMaterial({
    name: 'flora:wildflower-stem',
    lighting,
    wind: true,
    windGain: BLOOM_WIND_GAIN,
    windChop: BLOOM_WIND_CHOP,
    shadowDepth: FOLIAGE_SHADOW_DEPTH,
  });
  const bloomMat = floraMaterial({
    name: 'flora:wildflower-bloom',
    lighting,
    wind: true,
    windGain: BLOOM_WIND_GAIN,
    windChop: BLOOM_WIND_CHOP,
    shadowDepth: 0.58,
    roughness: 0.8,
  });

  const places = scatter({
    rng, count, radius,
    innerRadius: opts.innerRadius ?? 0,
    falloff: opts.falloff ?? 0.5,
    clumping: opts.clumping ?? 0.45,
    mask,
  });

  const heights = new Float32Array(places.length);
  const yaws = new Float32Array(places.length);
  const leans = new Float32Array(places.length);
  const gains = new Float32Array(places.length);
  for (let i = 0; i < places.length; i++) {
    heights[i] = rng.range(hMin, hMax);
    yaws[i] = rng.range(0, Math.PI * 2);
    leans[i] = rng.jitter(0.26);
    gains[i] = rng.range(0.9, 1.4);
  }

  const stems = instanced(stemGeo, stemMat, places.length, (i, m) => {
    const p = places[i];
    _e.set(leans[i], yaws[i], leans[i] * 0.5);
    _q.setFromEuler(_e);
    _v3.set(p.x, heightAt(p.x, p.z), p.z);
    _s3.set(1, heights[i], 1);
    m.compose(_v3, _q, _s3);
    return gains[i];
  }, { castShadow: false, receiveShadow: true });
  stems.name = 'wildflower-stems';
  group.add(stems);

  const blooms = instanced(bloomGeo, bloomMat, places.length, (i, m, c) => {
    const p = places[i];
    // The stem's radial axes are unscaled, so its bend at the tip is a flat
    // 0.08 m regardless of how tall this particular stem is.
    _t3.set(0, heights[i], 0.08).applyQuaternion(_q.setFromEuler(
      _e.set(leans[i], yaws[i], leans[i] * 0.5),
    ));
    _v3.set(p.x, heightAt(p.x, p.z), p.z).add(_t3);
    const s = rng.range(0.75, 1.3);
    _s3.set(s, s, s);
    m.compose(_v3, _q, _s3);
    const roll = rng.next() * acc;
    let k = 0;
    while (k < cumulative.length - 1 && roll > cumulative[k]) k++;
    c.copy(colors[k]).multiplyScalar(rng.range(0.88, 1.12));
    return gains[i];
  }, { castShadow: false, receiveShadow: true });
  blooms.name = 'wildflower-blooms';
  group.add(blooms);

  return ownResources(group, [stemGeo, bloomGeo], [stemMat, bloomMat]);
}

/**
 * Tall seed-head grass — the bed's second height and its only warm vertical.
 *
 * This is the species our meadow was missing and the plate leans on hardest.
 * Zoom the plate's bed at frame right and it is not a violet mass at all: it is
 * violet racemes at 1.05–1.35 m with **bare green stalks carrying loose straw
 * panicles standing 20–40 cm above them**, and the pale spindles reading against
 * the sky are what give the bed a ragged top edge instead of a mown one. Ours
 * had exactly one thing at that station, and one thing at one height is a wall
 * however well it is coloured.
 *
 * Measured off the plate against the knight's 419 px: the panicles crest at
 * 0.95–1.15 × character (1.5–1.85 m at our 1.6 m scale), the panicle itself is
 * the top 22% of the plant, and it runs 0.10–0.13 of its own length across —
 * narrower than a lavender raceme, which is most of what separates the two
 * silhouettes at the eight pixels they actually occupy.
 *
 * Built as a **clump**, not a blade: a stalk with its panicle plus three basal
 * blades merged into one instance, so a clump has a base as well as a top and
 * the bed does not look like a field of aerials. One draw call.
 *
 * @param {Object} [opts]
 * @param {number} [opts.radius=8] drift radius in metres.
 * @param {number} [opts.count=420] clumps.
 * @param {[number,number]} [opts.height=[1.35,1.85]] stalk height, metres.
 * @param {number} [opts.panicle=0.22] fraction of the height carrying seed.
 * @param {number} [opts.whorls=8] seed whorls up the panicle.
 * @returns {THREE.InstancedMesh} with `userData.dispose()`.
 */
export function buildSeedGrass(opts = {}) {
  const { rng, lighting, heightAt, mask } = common(opts);
  const radius = opts.radius ?? 8;
  const count = opts.count ?? 420;
  const [hMin, hMax] = opts.height ?? [1.35, 1.85];
  const panicle = opts.panicle ?? 0.22;
  const whorls = opts.whorls ?? 8;

  const parts = [];
  // The stalk. Thinner and straighter than a lavender stem — this grass holds
  // its head up and only the panicle nods, which is the opposite of a raceme
  // and reads as a different plant from a hundred metres.
  parts.push(stemGeometry({
    height: 1.0,
    radiusBottom: 0.0055,
    radiusTop: 0.0028,
    bend: 0.09,
    segments: 4,
    rootColor: FLORA_PALETTE.MEADOW_ROOT,
    tipColor: FLORA_PALETTE.SEED_STALK,
  }));

  const seedDeep = lin(FLORA_PALETTE.SEED_STALK);
  const seedMid = lin(FLORA_PALETTE.SEED_HEAD);
  const seedPale = lin(FLORA_PALETTE.SEED_HEAD_PALE);
  const seedColor = new THREE.Color();
  const stalkTop = 1 - panicle;
  for (let w = 0; w < whorls; w++) {
    const u = w / (whorls - 1);
    const y = stalkTop + panicle * (0.02 + u * 0.98);
    // A panicle is a *spindle*: widest a third of the way up and drawn to a
    // point at both ends. A cylinder of seed reads as a bulrush, which is a
    // different plant entirely and one the plate does not have.
    const spindle = Math.pow(Math.sin(Math.PI * (0.10 + u * 0.86)), 0.75);
    const scale = panicle * (0.42 + 0.72 * spindle);
    // Green at the base of the head where the seed is still unripe, bleaching
    // to straw at the tip — the same direction the lavender's ramp runs, so the
    // two species read as lit by the same sun.
    seedColor.copy(seedDeep).lerp(seedMid, Math.min(1, u * 2.1));
    if (u > 0.45) seedColor.lerp(seedPale, (u - 0.45) / 0.55 * 0.85);

    const spikelets = petalWhorlGeometry({
      petals: 3,
      rows: 2,
      phase: w * 2.31,
      // Reach is under half the lavender's for the same plant height, which is
      // the whole silhouette difference between the two species.
      radius: (t) => 0.010 + 0.030 * t,
      height: (t) => -0.030 + 0.110 * t,
      width: (t) => 0.011 * (1 - t * 0.65),
      cup: 0.28,
      colorAt: () => seedColor,
    });
    parts.push(placed(spikelets, 0, y, 0, 0, 0, 0, scale, scale, scale));
  }

  // Basal blades. Three, splayed, at a third of the stalk — a clump of grass
  // has a skirt, and without one every instance floats on a stick.
  for (let b = 0; b < 3; b++) {
    const blade = bladeGeometry({
      segments: 5,
      droop: 0.80,
      taper: 0.52,
      rootColor: FLORA_PALETTE.MEADOW_ROOT,
      tipColor: FLORA_PALETTE.MEADOW_TIP,
      upBlend: 0.38,
    });
    const h = rng.range(0.26, 0.46);
    placed(blade, 0, 0, 0, 0.10, b * 2.09 + rng.jitter(0.4), 0, 0.026, h, h * 0.85, 'YXZ');
    parts.push(blade);
  }

  const geo = setSway(mergeAndDispose(parts), (x, y) => y);
  const material = floraMaterial({
    name: 'flora:seed-grass',
    lighting,
    wind: true,
    // The tallest, thinnest thing in the bed, so it bends furthest and fastest.
    // A meadow where the seed heads move less than the lavender under them reads
    // as plastic even when every colour is right.
    windGain: 0.16,
    windChop: 1.15,
    shadowDepth: FOLIAGE_SHADOW_DEPTH,
    roughness: 0.9,
  });

  const places = scatter({
    rng, count, radius,
    innerRadius: opts.innerRadius ?? 0,
    falloff: opts.falloff ?? 0.4,
    // Seed grass grows through the lavender in loose runs rather than as its own
    // stand; high clumping is what interleaves the two instead of banding them.
    clumping: opts.clumping ?? 0.62,
    mask,
  });

  const mesh = instanced(geo, material, places.length, (i, m, c) => {
    const p = places[i];
    const h = rng.range(hMin, hMax);
    _e.set(rng.jitter(0.16), rng.range(0, Math.PI * 2), rng.jitter(0.16));
    _q.setFromEuler(_e);
    _v3.set(p.x, heightAt(p.x, p.z), p.z);
    _s3.set(h, h, h);
    m.compose(_v3, _q, _s3);
    const v = rng.range(0.84, 1.16);
    c.setRGB(v * rng.range(0.99, 1.07), v, v * rng.range(0.86, 0.98));
    return rng.range(0.8, 1.35);
  }, { castShadow: false, receiveShadow: true });

  mesh.name = 'seed-grass';
  return ownResources(mesh, [geo], [material]);
}

/**
 * Low broadleaf ground cover — the dark rosettes that break up a lawn.
 *
 * The fifth species, and the one that works at the bottom of frame where the
 * others are all too tall to reach. On the plate the ground the party stands on
 * is not one green: broad flat leaves pool between the grass at roughly two
 * thirds its luminance, in patches a metre across, and that mottling is most of
 * what keeps 200 000 px of lawn from reading as felt. Ours had a single blade
 * species there and duly shipped a uniform mat.
 *
 * A rosette rather than a plant: five broad leaves splayed almost flat from one
 * crown, which is the shape that reads from a camera looking down at it. Grass
 * is a silhouette read and ground cover is a plan read, so they need opposite
 * geometry — that is the reason this is not a `buildGrassField` preset.
 *
 * @param {Object} [opts]
 * @param {number} [opts.radius=9]
 * @param {number} [opts.count=900] rosettes.
 * @param {[number,number]} [opts.size=[0.16,0.34]] leaf span, metres.
 * @returns {THREE.InstancedMesh} with `userData.dispose()`.
 */
export function buildGroundCover(opts = {}) {
  const { rng, lighting, heightAt, mask } = common(opts);
  const radius = opts.radius ?? 9;
  const count = opts.count ?? 900;
  const [sMin, sMax] = opts.size ?? [0.16, 0.34];
  const leaves = opts.leaves ?? 5;

  const parts = [];
  for (let i = 0; i < leaves; i++) {
    const leaf = bladeGeometry({
      segments: 4,
      // Nearly a full quarter-turn of droop with almost no taper: a broad
      // rounded lamina rather than a blade. `taper` 0.20 holds 82% of the width
      // nine tenths of the way out, which is a leaf; the lawn's 0.38 is a strap
      // and the meadow's 0.62 is a needle.
      droop: 1.05,
      taper: 0.20,
      rootColor: FLORA_PALETTE.COVER_ROOT,
      tipColor: FLORA_PALETTE.COVER_TIP,
      // Highest up-blend in the module. These are seen from almost directly
      // above and their true normals are nearly horizontal, so without it a
      // patch of ground cover goes black under a high key.
      upBlend: 0.74,
    });
    // Laid over toward horizontal, each leaf on its own azimuth. `'YXZ'` so the
    // azimuth stays the outer rotation — see `placed`.
    placed(
      leaf, 0, 0, 0,
      Math.PI * 0.40 + rng.jitter(0.18), (i / leaves) * Math.PI * 2 + rng.jitter(0.3), 0,
      0.34, 0.62, 0.55,
      'YXZ',
    );
    parts.push(leaf);
  }

  const geo = setSway(
    mergeAndDispose(parts),
    // Anchored at the crown, free at the leaf tips: lever is radial distance,
    // not height, because this plant has almost none.
    (x, y, z) => Math.min(1, Math.hypot(x, z) / 0.55),
  );

  const material = floraMaterial({
    name: 'flora:ground-cover',
    lighting,
    wind: true,
    // Barely moves. A broad low leaf on a short petiole is the stiffest thing in
    // the meadow, and cover that waves like grass destroys the height cue the
    // species exists to provide.
    windGain: 0.018,
    windChop: 0.4,
    shadowDepth: FOLIAGE_SHADOW_DEPTH,
    roughness: 0.92,
  });

  const places = scatter({
    rng, count, radius,
    innerRadius: opts.innerRadius ?? 0,
    falloff: opts.falloff ?? 0.5,
    // The plate's cover sits in patches a metre across, not as a sprinkle.
    clumping: opts.clumping ?? 0.72,
    mask,
  });

  const mesh = instanced(geo, material, places.length, (i, m, c) => {
    const p = places[i];
    const s = rng.range(sMin, sMax);
    _e.set(rng.jitter(0.12), rng.range(0, Math.PI * 2), rng.jitter(0.12));
    _q.setFromEuler(_e);
    _v3.set(p.x, heightAt(p.x, p.z) - s * 0.03, p.z);
    _s3.set(s, s * rng.range(0.7, 1.0), s);
    m.compose(_v3, _q, _s3);
    const v = rng.range(0.82, 1.12);
    c.setRGB(v * rng.range(0.96, 1.06), v, v * rng.range(0.84, 0.98));
    return rng.range(0.7, 1.2);
  }, { castShadow: false, receiveShadow: true });

  mesh.name = 'ground-cover';
  return ownResources(mesh, [geo], [material]);
}

/**
 * A broadleaf — rounded canopy masses on real wood.
 *
 * The plate has **two** tree species behind its meadow and we shipped one,
 * twenty-two times. Its cedars are tiered and notched; the tree at plate centre
 * (x ≈ 1180–1400, y ≈ 60–300) is the opposite read in every axis: a single
 * rounded crown built of four or five overlapping *lobes* with clear gaps of sky
 * between them, wider than it is tall above a clean bole, and a full 36° warmer
 * in hue than the cedars beside it. Half the belt is this now, and a treeline of
 * two silhouettes is the cheapest depth cue in the frame.
 *
 * The canopy is modelled as lobes rather than scattered as cards, and that is
 * the load-bearing decision. A broadleaf crown at 25 m is a *mass* — its read is
 * the rounded value gradient across each lobe and the dark gap between lobes,
 * neither of which a cloud of billboards produces. The leaf detail that a mass
 * alone cannot give arrives as a fringe of instanced sprigs on the lobes' outer
 * shells, which breaks the silhouette without paying for interior geometry
 * nothing will ever see.
 *
 * Authored at **unit height** and scaled per instance, so a grove is three draw
 * calls at any count.
 *
 * @param {Object} [opts]
 * @param {number} [opts.count=1] trees; above one they are instanced.
 * @param {number} [opts.height=6.0] height in metres.
 * @param {number} [opts.spread=1.12] crown width as a multiple of height.
 * @param {number} [opts.lobes=6] canopy masses. Five or six is the plate's read;
 *   past eight the gaps close and it becomes a ball again.
 * @param {number} [opts.fringe] leaf sprigs on the lobe shells. Defaults to 200
 *   for a single hero tree and **0** for a grove, where at 25 m a sprig is under
 *   a pixel and the mass carries the whole read.
 * @param {number} [opts.radius=8] scatter radius when `count > 1`.
 * @param {Object} [opts.forge] an `AssetForge`, to bind its `bark` detail maps.
 * @returns {THREE.Group} with `userData.dispose()`.
 */
export function buildBroadleafTree(opts = {}) {
  const { rng, lighting, forge, heightAt, mask } = common(opts);
  const count = opts.count ?? 1;
  const height = opts.height ?? 6.0;
  const spread = opts.spread ?? 1.12;
  const lobeCount = opts.lobes ?? 6;
  const fringeCount = opts.fringe ?? (count === 1 ? 200 : 0);
  const maxDepth = opts.depth ?? 3;

  const group = new THREE.Group();
  group.name = 'broadleaf';

  /* --- skeleton, in unit-height space ------------------------------------- */
  // Against the cherry: a third less droop and twice the upward bias, because a
  // broadleaf reaches for the light and a flowering cherry weeps. `twigDepth` 1
  // rather than 2 — the lobes hang off the main forks, which is what puts a
  // crown *over* a bole instead of a cloud around a stick.
  const { segments, twigs } = growSkeleton({
    rng, length: 0.30, radius: 0.030, maxDepth, twigDepth: 1,
    droop: 0.022, droopPerDepth: 0.020,
    spread: [0.42, 0.86], rise: [0.18, 0.52],
    lengthDecay: [0.62, 0.82], radiusDecay: [0.58, 0.74],
  });
  const branchGeo = barkGeometry(
    segments, maxDepth, FLORA_PALETTE.BROADLEAF_BARK, FLORA_PALETTE.BROADLEAF_BARK_LIT,
  );

  /* --- canopy lobes -------------------------------------------------------- */
  const crownRadius = spread * 0.5;
  const deep = lin(FLORA_PALETTE.BROADLEAF_DEEP);
  const mid = lin(FLORA_PALETTE.BROADLEAF_MID);
  const litLeaf = lin(FLORA_PALETTE.BROADLEAF_LIT);
  const lobeColor = new THREE.Color();
  /** Lobe centres and radii, kept so the fringe can sit on the shells the
   *  canopy actually built rather than on a sphere it might have built. */
  const shells = [];
  const lobeParts = [];
  // Anchors are drawn from the *outer* twigs so the lobes sit where the wood
  // ends. Striding rather than sampling: a random draw clusters two lobes on one
  // branch and leaves a quadrant of the crown empty, which on a shape made of
  // five masses is immediately visible.
  const outer = twigs.filter((t) => t.depth >= maxDepth - 1);
  const pool = outer.length ? outer : twigs;
  for (let i = 0; i < lobeCount; i++) {
    const t = pool[Math.floor((i + 0.5) * pool.length / lobeCount) % pool.length];
    const r = crownRadius * rng.range(0.40, 0.56);
    const centre = new THREE.Vector3()
      .copy(t.p)
      .addScaledVector(t.d, r * 0.35)
      .add(_v3.set(rng.jitter(0.09), rng.jitter(0.05), rng.jitter(0.09)));
    // Keep every lobe over the bole. A branch that wandered wide would otherwise
    // hang a mass off the side of the tree with nothing under it.
    const reach = Math.hypot(centre.x, centre.z);
    if (reach > crownRadius * 0.72) {
      centre.x *= (crownRadius * 0.72) / reach;
      centre.z *= (crownRadius * 0.72) / reach;
    }
    shells.push({ centre, radius: r });

    // 9x6 is 90 triangles and, being indexed, closes to genuinely smooth normals
    // — which is the entire point of a lobe. An icosahedron at the same triangle
    // count is non-indexed and would come back faceted, i.e. a low-poly ball.
    const lobe = new THREE.SphereGeometry(1, 9, 6);
    const pos = lobe.getAttribute('position');
    // Three incommensurate lobes of deformation on the unit direction. Sampled
    // from *position* rather than from the RNG so coincident seam vertices agree
    // and the surface stays closed; the RNG supplies only the phases.
    const pa = rng.range(0, 6.28);
    const pb = rng.range(0, 6.28);
    const pc = rng.range(0, 6.28);
    const cols = new Float32Array(pos.count * 3);
    for (let v = 0; v < pos.count; v++) {
      _v3.fromBufferAttribute(pos, v);
      const k = 1
        + 0.20 * Math.sin(_v3.x * 2.7 + pa) * Math.cos(_v3.y * 3.1 + pb)
        + 0.13 * Math.sin(_v3.z * 4.3 + pc);
      _v3.multiplyScalar(k);
      pos.setXYZ(v, _v3.x, _v3.y * 0.82, _v3.z);
      // A crown's value structure is vertical: sky-lit on top, in its own shade
      // underneath. Painting it into the albedo is what keeps the mass reading
      // as a mass when the terminator falls somewhere else entirely.
      // Clamped, because the deformation above can push a vertex past the unit
      // sphere and an unclamped `lerp` *extrapolates* — which on the crown's top
      // row would push the lit green past its own measured p90.
      const u = Math.min(1, Math.max(0, _v3.y * 0.5 + 0.5));
      lobeColor.copy(deep).lerp(mid, Math.min(1, u * 1.8));
      if (u > 0.55) lobeColor.lerp(litLeaf, (u - 0.55) / 0.45 * 0.85);
      cols[v * 3] = lobeColor.r;
      cols[v * 3 + 1] = lobeColor.g;
      cols[v * 3 + 2] = lobeColor.b;
    }
    lobe.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    lobe.computeVertexNormals();
    lobeParts.push(placed(lobe, centre.x, centre.y, centre.z, 0, 0, 0, r, r, r));
  }
  const canopyGeo = setSway(
    mergeAndDispose(lobeParts),
    // The whole crown flexes together and the bole does not, so the lever is
    // height above the ground rather than distance from a branch.
    (x, y) => Math.min(1, Math.max(0, (y - 0.35) / 0.65)),
  );

  /* --- leaf fringe --------------------------------------------------------- */
  let fringeGeo = null;
  let fringeMat = null;
  if (fringeCount > 0) {
    const sprigParts = [];
    for (let i = 0; i < 4; i++) {
      const leaf = bladeGeometry({
        segments: 3,
        droop: 0.72,
        taper: 0.26,
        rootColor: FLORA_PALETTE.BROADLEAF_MID,
        tipColor: FLORA_PALETTE.BROADLEAF_LIT,
        upBlend: 0.45,
      });
      placed(
        leaf, 0, 0, 0,
        0.5 + rng.jitter(0.5), (i / 4) * Math.PI * 2 + rng.jitter(0.4), 0,
        0.5, 1.0, 0.8,
        'YXZ',
      );
      sprigParts.push(leaf);
    }
    fringeGeo = setSway(mergeAndDispose(sprigParts), (x, y) => Math.min(1, y * 1.6));
    fringeMat = floraMaterial({
      name: 'flora:broadleaf-fringe',
      lighting,
      wind: true,
      windGain: 0.05,
      windChop: 1.0,
      shadowDepth: FOLIAGE_SHADOW_DEPTH,
      roughness: 0.88,
    });
  }

  /* --- materials ----------------------------------------------------------- */
  const barkMat = floraMaterial({
    name: 'flora:broadleaf-bark',
    lighting,
    side: THREE.FrontSide,
    roughness: 0.95,
    shadowDepth: 0.30,
    normalMap: forge?.texture('bark/normal') ?? undefined,
    roughnessMap: forge?.texture('bark/roughness') ?? undefined,
  });
  const canopyMat = floraMaterial({
    name: 'flora:broadleaf-canopy',
    lighting,
    wind: true,
    windGain: 0.055,
    windChop: 0.7,
    // A crown is the one piece of foliage in the module thick enough to be
    // genuinely opaque in its interior, so it takes less transmission lift than
    // a blade — which is what lets the gaps between lobes stay dark and the
    // masses stay separable.
    shadowDepth: 0.40,
    roughness: 0.9,
    side: THREE.FrontSide,
  });

  /* --- placement ----------------------------------------------------------- */
  const places = count === 1
    ? [{ x: 0, z: 0, t: 0 }]
    : scatter({
      rng, count, radius: opts.radius ?? 8,
      innerRadius: opts.innerRadius ?? 0,
      falloff: opts.falloff ?? 0.4,
      mask,
    });

  const scales = new Float32Array(places.length);
  const yaws = new Float32Array(places.length);
  for (let i = 0; i < places.length; i++) {
    scales[i] = height * rng.range(0.78, 1.22);
    yaws[i] = rng.range(0, Math.PI * 2);
  }
  const place = (i, m) => {
    const p = places[i];
    _e.set(0, yaws[i], 0);
    _q.setFromEuler(_e);
    _v3.set(p.x, heightAt(p.x, p.z), p.z);
    _s3.set(scales[i], scales[i], scales[i]);
    m.compose(_v3, _q, _s3);
  };

  const trunks = instanced(branchGeo, barkMat, places.length, (i, m, c) => {
    place(i, m);
    const v = rng.range(0.86, 1.12);
    c.setRGB(v * rng.range(1.0, 1.06), v, v * rng.range(0.9, 1.0));
    return 0;
  }, { castShadow: true, receiveShadow: true });
  trunks.name = 'broadleaf-trunks';
  group.add(trunks);

  const canopy = instanced(canopyGeo, canopyMat, places.length, (i, m, c) => {
    place(i, m);
    // Level and warmth only. A second green multiplied into the lobe ramp takes
    // a whole grove to near black — the same trap the conifer records.
    const v = rng.range(0.84, 1.16);
    c.setRGB(v * rng.range(0.94, 1.08), v, v * rng.range(0.86, 1.0));
    return rng.range(0.85, 1.2);
  }, { castShadow: true, receiveShadow: true });
  canopy.name = 'broadleaf-canopy';
  group.add(canopy);

  const geometries = [branchGeo, canopyGeo];
  const materials = [barkMat, canopyMat];

  if (fringeGeo) {
    // One fringe budget shared across every tree in the group, so a grove that
    // asked for sprigs does not multiply them by its own count.
    const perTree = Math.max(1, Math.round(fringeCount / places.length));
    const total = perTree * places.length;
    const fringe = instanced(fringeGeo, fringeMat, total, (i, m, c) => {
      const tree = Math.floor(i / perTree);
      const shell = shells[rng.int(0, shells.length - 1)];
      // A point on the lobe's own shell, pushed just proud of it so the sprig
      // reads against the mass rather than being swallowed by it.
      const a = rng.range(0, Math.PI * 2);
      const y = rng.range(-0.75, 1.0);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      _t3.set(Math.cos(a) * r, y, Math.sin(a) * r);
      _v3.copy(shell.centre).addScaledVector(_t3, shell.radius * 0.98);
      // Grown outward along the shell normal, which is what makes the fringe a
      // fringe rather than a halo of randomly-tumbled leaves.
      _q.setFromUnitVectors(WORLD_UP, _t3);
      const s = rng.range(0.055, 0.10);
      _s3.set(s, s, s);
      _m4.compose(_v3, _q, _s3);
      // Fold the tree's own placement in afterwards, since the shell positions
      // are authored in the unit-height space the canopy was built in.
      place(tree, m);
      m.multiply(_m4);
      const v = rng.range(0.8, 1.2);
      c.setRGB(v * rng.range(0.96, 1.08), v, v * rng.range(0.86, 1.0));
      return rng.range(0.9, 1.5);
    }, { castShadow: false, receiveShadow: true });
    fringe.name = 'broadleaf-fringe';
    group.add(fringe);
    geometries.push(fringeGeo);
    materials.push(fringeMat);
  }

  return ownResources(group, geometries, materials);
}
