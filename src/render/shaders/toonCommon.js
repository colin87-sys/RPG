/**
 * toonCommon.js — the GLSL vocabulary of the character shading model.
 *
 * ## The doctrinal ruling this file is built on
 *
 * Three documents in this repo describe character shading and they contradict
 * each other. `docs/ANIME_PIPELINE.md` §2/§4/§6 demand flat saturated colour, a
 * hard two-band terminator, a hard-edged specular shape and an ink outline.
 * `docs/BRAVELY_REFERENCE.md` §1/§4 reverses all four.
 *
 * **The plates decide, and they decide against the cel reading.**
 * `docs/reference/README.md` states the tie-break directly: where prose and
 * image disagree, the image wins. Measured on `bravely01.jpg` against
 * `shots/now/cast-stage.png`, with a 42–110 px patch taken wholly inside one
 * costume zone and "flat run" meaning the longest horizontal run holding within
 * ±2 sRGB code values:
 *
 * | zone | plate | ours, under the cel model |
 * |---|---|---|
 * | knight pauldron | 4.8% of the zone | 28.3% |
 * | knight thigh plate | 8.5% | 33.3% (torso) |
 * | white hat crown | 5.5% | 42.0% (green robe) |
 * | red coat chest | 18.3% | 22.7% (purple robe) |
 *
 * A 48 px scanline across the plate's left pauldron reads
 * `113 105 92 92 95 90 82 78 79 75 64 51 38 32 …` — a continuous ramp through
 * roughly forty distinct values. The same scanline across ours read
 * `183 177 177 177 176 177 180 179 180 …` for forty pixels, then a cliff. That
 * is the defect: **the cel model gave every surface exactly two levels, so a
 * curved plate had no internal value variation at all.**
 *
 * The cause was structural rather than a tuning error. `awToonKey` accumulates
 * `directLight.color` with no N·L factor — deliberately, so one terminator
 * describes the form — and the composite then multiplies it by an albedo. So
 * *within* a band the output is mathematically constant, and the only thing
 * varying across the form was the band selector. Compressing that selector to
 * 1.3 device pixels left a figure made of flat fills separated by drawn lines.
 *
 * ## The model, and the second measurement that reshaped it
 *
 * **Two stated levels, and a specular response chosen per shading class.**
 *
 * The wide-ramp revision above fixed the flat-fill defect and left a different
 * one behind, which the art review scored at 27/100 and called structural: every
 * surface in the frame carried the same broad glossy lobe, so armour, cloth,
 * skin, hair, the grass and the ground all had one plastic response. Held
 * against the plates:
 *
 * | zone | plate | ours, under the shared-lobe model |
 * |---|---|---|
 * | Elvis's wine coat (`bravely01`) | no highlight anywhere on the piece | sheen over shoulder and lapel |
 * | Gloria's white hat crown | matte; the form is entirely the terminator | glossy crown |
 * | Seth's pauldron | a scatter of marks a few px across on rolled edges | one 7°-wide plateau at 45% gain |
 * | Elvis's hair | exactly one crisp arc with a flat interior | half-strength wash over the whole mass |
 * | the meadow | matte throughout | specular on every blade |
 *
 * The cause was one function. `awToonSpecShape` shaped **every** class with
 * `smoothstep( t - w, t + w, lobe ) * mix( 0.45, 1, lobe )`, and that 0.45 is a
 * floor: 45% of full gain was paid across the whole shoulder, so a lobe that was
 * genuinely tight got spread into a plateau before it ever reached the frame. At
 * metal's threshold 0.30 and shoulder 0.22 the mark began at lobe 0.08, which at
 * exponent 300 is 7° of half-angle. Add `specGain: 0.80` on `generic` — the
 * class `world/Flora.js` shades the entire meadow through — and the gloss was on
 * literally everything.
 *
 * So the specular is now **gated at compile time by shading class**, and "no
 * specular" is the default rather than an opt-out:
 *
 * | class | direct lobe | environment | notes |
 * |---|---|---|---|
 * | `cloth`, `skin`, `fur`, `generic` | none | none | the whole chain leaves the program |
 * | `metal` | `awToonMetalLobe` + `awToonStreakShape` | continuous PMREM | one hard-edged streak at exponent 120, plus cavity and edge wear |
 * | `hair` | `awToonAnisoLobe` + `awToonArcShape` | none | one bright anisotropic ribbon, bounded at 1.75× the surface |
 * | `leather`, `crystal`, `eye` | `awToonGlossLobe` + `awToonGlossShape` | small | the old shape, kept where it was right |
 *
 * The pieces, in the order the composite uses them:
 *
 *  1. `awToonBand` — `smoothstep( t - w, t + w, N·L )`. `w` is the **half-width**
 *     and it is now per class: 0.05 on cloth — a two-level toon terminator, which
 *     is what the plates' garments show — 0.10–0.14 on skin, hair, metal and fur,
 *     and the prop classes' 0.50–0.60 left alone so the meadow does not band.
 *  2. `awToonBias` — the ramp's curve. It did the stylising while the ramp was
 *     wide; on a narrow band it only nudges where the edge falls, so the narrow
 *     classes run it at or near 1 and place their edge with `terminator` instead.
 *  3. `awToonEdge` — an **antialias floor**, and only that: it can widen a
 *     transition that has collapsed below `uToonEdgePixels` on screen, never
 *     narrow one. Now called from the form band as well as the specular shapes,
 *     because a five-degree terminator is exactly the transition that goes
 *     sub-pixel on a limb seen near-tangent and crawls under animation. Compiled
 *     in for the narrow classes only, so the meadow still pays no `fwidth`.
 *  4. `awToonShadowAlbedo` — the dark side is a hue rotation with rising
 *     saturation, never a multiply. Unchanged: this is the one part of the model
 *     every document and the plates agree on.
 *  5. `awToonMetalLobe` + `awToonStreakShape` — the steel **streak**. A stated
 *     Blinn exponent of 120 (half-peak 6.1° off the mirror) quantised by a hard
 *     threshold at 0.70, so the mark has a flat interior and a drawn edge and
 *     runs as a band along the curvature of a plate. It arrives with
 *     `awToonCavity`, which takes the recesses between plates near black where
 *     the surface grazes the key, and `awToonEdgeWear`, a light rim along rolled
 *     edges driven by fresnel × curvature. Those three together are what
 *     separates plate from painted board.
 *  5b. `awToonCreaseAmount` + `awToonCreaseInk` — interior line work: ink wherever
 *     two faces meet at more than 55°, found by an angle test and a curvature
 *     test that have to agree (neither survives both cameras alone). And
 *     `awToonClothTurn`, the 0.05 fresnel lift that turns a fold. The crease
 *     line's constants belong to `render/Outline.js`, which owns every ink mark
 *     in the frame; only its geometry lives here, and only because a ribbon per
 *     edge does not fit the capture budget.
 *  5c. `awToonDetail` — the hand-painted albedo multiply. Authored canvases only;
 *     the ban on procedural noise touching a character is unchanged.
 *  6. `awToonAnisoLobe` + `awToonArcShape` — Kajiya-Kay narrowed into one crisp
 *     arc with a defined inner and outer edge and a flat interior.
 *  7. `awToonSpecRelBound` — the bound that makes a hair band read as hair: the
 *     mark may never exceed `uToonSpecRelMax` of the diffuse level beneath it,
 *     evaluated in the composite where that level is finally known. Hair runs
 *     0.40, i.e. 1.4× the surface at most.
 *  7b. `awToonSumBound` — the bound on **mark plus surface**, and the one the
 *     model was missing. The two above are both stated on the mark alone, and
 *     both were satisfied while 26% of every hair mass on the cast rendered at
 *     the clip point (the plate's hair: 0.00%) — because a mark at 1.4× a
 *     surface already in the shoulder of the tone curve is still white. Stated
 *     on the sum, through the same soft shoulder, it is the only one of the
 *     three that can promise a band reads as a band rather than as a hole.
 *     It bounds the fur sheen too, which the other two do not reach.
 *  8. `awToonSheen` — a Charlie/Neubelt lobe for fur and feather trim, which is
 *     the one surface class whose silhouette is meant to read as broken rather
 *     than as a clean edge. Independent of the three gloss classes.
 *  9. `awToonQuantise` — an opt-in leveller for an environment reflection.
 *     **Off on every class**, including metal, and the measurement is why: at
 *     three levels any reflection whose peak radiance falls below 1/6 quantises
 *     to exactly zero, and everything from 1/6 to 1/2 snaps to the single
 *     constant 1/3. `LookdevScene` authors `environmentIntensity = 0.28`, which
 *     puts armour squarely in that dead zone — so the "quantised environment
 *     reflection" the cel model claimed to give metal was in practice no
 *     reflection at all. The knob stays for a caller who wants a deliberately
 *     stepped prop.
 * 10. `awToonRim` — a soft fresnel profile. It used to be edge-resolved into a
 *     band, which drew a hard 1.3 px light line around every silhouette *and
 *     every internal contour* — visible in our capture as the cyan piping
 *     outlining the knight's arm, cape and greaves. The plate has no such line.
 *     Removing the *edge* left the *colour* behind, and a teal wash along every
 *     contour reads as a coating over the whole figure; the composite now
 *     spends `uToonRimTint` of the rig's chroma and keeps its level, so the
 *     back light still separates the cast from the meadow without tinting it.
 *     It is the last specular-shaped term a matte class can still carry, which
 *     is why it belongs in this list at all.
 *
 * There is **no ramp texture and no noise of any kind**: no procedural surface
 * noise ever touches a character (ANIME_PIPELINE's absolute rule). Clothing
 * patterns arrive through the base colour map, which this model never multiplies
 * anything into.
 *
 * These are exported as source strings rather than registered into
 * `THREE.ShaderChunk`, for the same reason `postCommon.js` and `skyCommon.js`
 * made that call: the chunk registry is process-global state shared with every
 * stock material in the engine, and `render/Lighting.js` already has to work
 * around one addon (CSM) that mutates it. Adding a second mutator would make the
 * order in which two unrelated modules happen to be imported a rendering
 * variable, which is not a debugging session anyone wants.
 *
 * Dialect: GLSL ES 1.00 spelling (`texture2D`, `varying`). three 0.185 rewrites
 * material sources to `#version 300 es` with compatibility defines, so this is
 * the portable spelling — but GLSL 3.00's strict typing still applies, hence
 * every literal carries an explicit `.0`.
 *
 * OWNED BY: render/ToonMaterial.js.
 */

/**
 * Uniform block for the surface model.
 *
 * Split into two families on purpose:
 *
 *  - `uKey*` / `uRim*` mirror `Lighting.uniforms` **by name**, so a material
 *    built with `{ lighting }` can splice the rig's own uniform *objects*
 *    straight in and inherit per-frame updates for free — no per-frame lookup,
 *    no chance of the character's rim disagreeing with the rim light that casts
 *    it. Renaming any of these silently decouples the two. `Lighting` also
 *    writes `uToonRimFloor`, `uToonRimPower`, `uToonRimFocus` and
 *    `uToonRimShape` directly through `_applyRimContract`, so those four names
 *    are part of the same contract.
 *  - `uToon*` are per-material art controls. They are never shared.
 *
 * `uKeyColor` and `uRimColor` arrive premultiplied by their light's intensity;
 * that is the rig's convention and the shader does not second-guess it.
 * `uKeyColor` carries a second job here — it is the denominator that recovers
 * each light's share of the key, which is what lets the shadow be a *colour*
 * rather than a multiply toward black, and what lets a cast shadow join the
 * form shadow as one mass instead of punching a hole through it.
 */
export const TOON_UNIFORMS_GLSL = /* glsl */ `
uniform vec3  uKeyColor;
uniform vec3  uRimDirection;
uniform vec3  uRimColor;
uniform float uRimStrength;

uniform float uToonTerminator;
uniform float uToonSoftness;
uniform float uToonEdgePixels;
uniform float uToonRampGamma;
uniform float uToonShadowFloor;
uniform float uToonShadowLift;
uniform float uToonShadowDepth;

uniform vec3  uToonShadowTint;
uniform float uToonShadowHue;
uniform float uToonShadowSat;
uniform float uToonShadowValue;
uniform float uToonShadowSatFloor;

uniform vec3  uToonShadowFill;
uniform float uToonShadowGain;
uniform float uToonAmbientGain;
uniform float uToonAmbientFlatness;
uniform float uToonEnvLevels;
uniform float uToonMetalAlbedo;

// ---- the hand-painted detail map -------------------------------------------
//
// A second albedo channel, multiplied into 'diffuseColor' before three builds
// its 'PhysicalMaterial' from it, so a fabric print or a worn-metal mottle
// reaches the diffuse response, the metal reflection tint and the ink line
// together rather than being a decal laid over the top of a finished shade.
//
// It is deliberately *not* one of three's map slots. The character classes drop
// 'normalMap' / 'roughnessMap' / 'aoMap' because in this project those arrive
// from 'AssetForge''s fBm generators and read as dirt on a costume; that ban is
// on **procedural noise**, and it stands. What the plates show everywhere is the
// opposite thing — 'bravely01.jpg' gives Gloria a printed skirt, Elvis a rose
// damask embroidered down a wine coat, Seth's plate a mottled worn albedo — and
// none of it is noise: it is drawn shapes. So authored canvases arrive through a
// channel of their own, which is what makes "no noise on a character" a property
// of the ban rather than a property of every texture slot.
//
// Projected from object space rather than from UVs. The cast is assembled from
// swept lofts and merged part-by-part in 'CharacterFactory'; a garment carries a
// usable parameterisation and a pauldron does not, and a print that vanishes on
// half the cast because of that is worse than no print. Object space is stable
// under skinning (the attribute is the bind pose) so the print travels with the
// cloth instead of swimming across it.
#ifdef TOON_DETAIL_MAP
  uniform sampler2D uToonDetailMap;
  uniform float uToonDetailScale;
  uniform float uToonDetailStrength;
  varying vec3 vToonDetailPos;
  varying vec3 vToonDetailNormal;
#endif

// ---- interior crease ink ---------------------------------------------------
// 'uToonCreaseRange' is the face-angle window as a chord ('2·sin(θ/2)'),
// 'uToonCreaseCurve' the inverse-metres curvature window that keeps a smooth
// surface out of it at any camera distance, and 'uToonCreaseInk' the level the
// surface is multiplied down to inside the line. 'render/Outline.js' owns all
// three; see 'CREASE_DEFAULTS' there for why the interior line lives in this
// shader while the silhouette stays an inverted hull.
#ifdef TOON_CREASE_INK
  uniform vec2  uToonCreaseRange;
  uniform vec2  uToonCreaseCurve;
  uniform float uToonCreaseInk;
#endif

// The fresnel lift that turns a fold. Cloth only, and tiny — see
// 'awToonClothTurn'.
#ifdef TOON_CLOTH_TURN
  uniform float uToonClothFresnel;
#endif

// The two terms that separate plate from painted board: a darkened cavity where
// the surface grazes the key, and a light wear rim along rolled edges.
#ifdef TOON_METAL_SURFACE
  uniform float uToonCavityDepth;
  uniform float uToonCavityWidth;
  uniform float uToonEdgeWear;
  uniform vec3  uToonWearColor;
#endif

// The environment reflection is a *specular* response and is gated with the
// rest of them. A matte class does not merely scale it to zero — the Fresnel
// evaluation, the probe fetch it multiplies and the quantiser all leave the
// program, which is what makes "cloth has no gloss" a property of the compiled
// shader rather than of a number someone can write over at runtime.
#ifdef TOON_ENV_SPEC
  uniform float uToonEnvSpecular;
#endif

uniform float uToonRimPower;
uniform float uToonRimGain;
uniform vec2  uToonRimFocus;
uniform vec2  uToonRimShape;
uniform float uToonRimFloor;
uniform float uToonRimWidth;
uniform float uToonRimCeiling;
uniform float uToonRimMax;

// How much of the rig's rim *chroma* this surface keeps. The rig publishes
// 'RING_GLOW' (#5FB8B0, a strong teal) as the back light's colour, and on the
// reference plates no character carries a coloured edge at all — separation is
// carried by value and by the ink line. A teal contour traced down a pauldron,
// a hair mass and a coat lapel is read as a *coating*, which is the single
// loudest plastic cue the capture had left. Desaturating at constant peak
// rather than dimming keeps the rig's solved level intact, so 'Lighting' still
// gets the separation it sizes for; only the hue is spent.
uniform float uToonRimTint;

uniform float uToonSpecCeiling;

// The bound that decides whether the frame clips, and the one the model was
// missing. 'uToonSpecCeiling' bounds the *mark* and 'uToonSpecRelMax' bounds it
// against the surface underneath — neither of them bounds the **sum**, which is
// what a camera sees. Measured on 'shots/mp0-cast' against 'bravely01.jpg',
// taking the fraction of a zone above sRGB 235:
//
// | zone | plate | ours |
// |---|---|---|
// | Elvis / Auren hair mass | 0.00% | 26.07% |
// | Adelle hair mass | 0.02% | — |
// | Seth pauldron | 0.01% | 1.41% (and max 255 against the plate's 238) |
//
// A quarter of our hair mass was at the clip point: the arc was not reading as
// a band at all, it was a hole. Both existing bounds were satisfied the whole
// time, because a mark 1.4x a surface that is *already* near the top of the
// tone curve is still white. This states the ceiling on 'surface + mark'
// through the same soft shoulder, so the mark spends whatever headroom is left
// and no more.
uniform float uToonSpecSum;

uniform vec3  uToonPulse;
uniform float uToonPulseRate;
uniform float uToonTime;

// The second lift on the lit side, for hair and metal only.
#ifdef TOON_HIGH_BAND
  uniform float uToonHighBand;
  uniform float uToonHighGain;
#endif

// Shared by all three gloss classes: the lobe value the mark's boundary sits at,
// the width of the transition over it, and the two bounds on how bright the
// result may become — one absolute ('uToonSpecCeiling', above) and one stated
// *relative to the surface underneath*, which is the only bound that means the
// same thing on a black coat and a white one.
#ifdef TOON_SPECULAR
  uniform vec3  uToonSpecColor;
  uniform float uToonSpecGain;
  uniform float uToonSpecThreshold;
  uniform float uToonSpecSoftness;
  uniform float uToonSpecRelMax;
#endif

// The strand axis, its lobe tightness and the hair band's albedo tint belong to
// the hair class alone. The metal class derives its exponent from a clamped
// roughness instead, so a caller cannot widen a steel glint into a sheen.
#ifdef TOON_SPEC_HAIR
  uniform vec3  uToonAnisoDirection;
  uniform float uToonAnisoShift;
  uniform float uToonSpecExponent;
  uniform float uToonSpecAlbedoMix;
#endif

#ifdef TOON_SHEEN
  uniform vec3  uToonSheenColor;
  uniform float uToonSheenGain;
  uniform float uToonSheenRoughness;
#endif
`;

/**
 * The shading primitives.
 *
 * Every one of them is written to be safe at its domain edges, because they are
 * evaluated per light per fragment on a material that will be on screen in
 * literally every frame of the game — a NaN here is not a rare artefact, it is
 * a black character.
 */
export const TOON_FUNCTIONS_GLSL = /* glsl */ `

/** three's 'common' chunk supplies 'max3' but not its mirror. */
float awMin3( const in vec3 v ) { return min( min( v.x, v.y ), v.z ); }

/**
 * The form ramp: 'smoothstep( t - w, t + w, N·L )'.
 *
 * 't' is where the ramp's midpoint sits in N·L and 'w' is its **half-width**, and
 * 'w' is the number that decides which of two techniques this is.
 *
 * The character classes run it **narrow** — 0.05 on cloth, 0.10–0.14 on skin,
 * hair, metal and fur — so a garment resolves into two levels with a defined
 * edge between them. That is what the plates show and it is what this revision
 * was asked for: on 'bravely01.jpg' Elvis's coat, Gloria's dress and Seth's
 * surcoat each carry one lit mass, one dark mass and a boundary a few pixels
 * wide, with everything *inside* a mass described by modelled folds rather than
 * by a lighting gradient. A ramp cannot substitute for geometry that is not
 * there; trying to make it do so is what produced the airbrushed read the review
 * scored at 27.
 *
 * The prop classes ('generic', 'leather', 'crystal') stay wide at 0.50–0.60 and
 * are deliberately untouched. 'world/Flora.js' shades every blade of grass and
 * every flower through 'generic', and the last agent to band the meadow measured
 * the capture's luminance range collapsing from p1 15 / p95 228 to p1 41 /
 * p95 182.
 *
 * Narrow bands need antialiasing, which is why 'awToonEdge' is back on this term
 * for the narrow classes; see 'TOON_NARROW_BAND' in the composite.
 *
 * Kept as a bare 'smoothstep' rather than folded into the composite because the
 * composite has to intersect it with the cast-shadow term, and because the third
 * lit band reuses it at a different threshold.
 */
float awToonBand( const in float ndl, const in float t, const in float w ) {

  float lo = t - max( w, 1e-3 );
  float hi = t + max( w, 1e-3 );

  return smoothstep( lo, hi, ndl );

}

/**
 * Widen a transition that has collapsed below a stated width in **device
 * pixels**. An antialias floor, and nothing else.
 *
 * 'fwidth( x )' is how much the transition moves between neighbouring pixels, so
 * '1 / fwidth( x )' is how many pixels it currently spans; 'min( 1, … )' means
 * the rescale can only ever *widen*. A transition already softer than
 * 'uToonEdgePixels' passes through untouched — the scale is exactly 1 and the
 * expression is the identity.
 *
 * The previous revision let this narrow as well, unclamped, on the character
 * classes. That is what turned every costume zone into a flat fill: a ramp
 * spanning a third of a figure was compressed to 1.3 px, so the two levels
 * either side of it became the *entire* surface response and the median longest
 * flat run inside one zone went to 22–42% of the zone against the plate's
 * 5–18%. Narrowing is therefore gone, and with it the 'TOON_CEL_EDGE' define
 * that selected it.
 *
 * Two terms need the floor now. The specular shapes do — metal's lobe runs at
 * exponent 510 and hair's arc is 0.05 wide, so both genuinely fall below a pixel
 * at battle-camera distance, where a raw 'smoothstep' crawls and stair-steps
 * under animation. And the **form band** does again, for the classes that took a
 * five-degree terminator in this revision: on a limb seen near-tangent that
 * transition is sub-pixel, and an unfiltered one there is a jagged staircase
 * running the length of the silhouette. It stays off the prop classes, whose
 * bands are half the N·L range wide and can never collapse, so the meadow pays
 * no 'fwidth'.
 *
 * The floor of 0.5 px keeps a caller from asking for a sub-pixel edge, which is
 * a 'step' with the aliasing that implies.
 */
float awToonEdge( const in float x ) {

  float px = max( uToonEdgePixels, 0.5 );
  float span = max( px * fwidth( x ), 1e-5 );

  return saturate( 0.5 + ( x - 0.5 ) * min( 1.0, 1.0 / span ) );

}

/**
 * The ramp's curve.
 *
 * On a **wide** band this is the control that does the stylising: 'pow' on the
 * ramp's output decides where the midtones sit, and a gamma above 1 holds the
 * dark side longer. That is still true of the prop classes, whose bands span
 * half the N·L range, and it is why 'generic' and 'leather' keep theirs.
 *
 * On a **narrow** band it is close to inert — it can only shift a five-degree
 * crossing a fraction of a degree — so the classes that took a toon terminator
 * in this revision run it at 1 and place their edge with 'terminator' instead.
 * Leaving a gamma of 1.45 on a 0.10-wide metal band would state a curve that
 * moves nothing, which is how a number comes to be believed in.
 *
 * Bounded below at 0.05 so a caller cannot invert the ramp into a step.
 */
float awToonBias( const in float x ) {

  return pow( saturate( x ), max( uToonRampGamma, 0.05 ) );

}

/**
 * The shadow-region **albedo**: a hue shift with rising saturation.
 *
 * ANIME_PIPELINE §2: "Shadow colour is a hue shift, not a multiply. Shift toward
 * the scene's shadow tint and *increase* saturation slightly as value drops. A
 * darkened copy of albedo is the single most common way cel shading looks
 * cheap." This function is that rule, and it is the one part of the model that
 * survived the doctrinal reversal in both directions — the reference plates
 * agree with it too, so it is unchanged.
 *
 * Light alone cannot deliver it. An amber albedo has almost no blue
 * reflectance, so however teal the fill is, the product stays a duller amber —
 * which is precisely why a "tinted shadow" built as a light term eyedrops as a
 * darker desaturated copy of the albedo. The fix has to happen one step earlier,
 * on the surface colour itself, exactly as a painter mixes the shadow colour on
 * the palette rather than glazing it over the light colour.
 *
 * The three moves are kept strictly separate so they can be tuned separately:
 *
 *  1. **Hue.** The albedo is split into a peak-normalised chroma and a value.
 *     The chroma travels 'uToonShadowHue' of the way to the shadow tint's
 *     chroma. Value is untouched by this step.
 *  2. **Saturation, upward.** HSV saturation is scaled at constant value:
 *     'c = peak - ( peak - c ) * k'. That identity holds the peak channel fixed
 *     and pushes the others away from it, which is a pure saturation change and
 *     nothing else.
 *  3. **Value, downward, and only slightly.** The bulk of the value drop belongs
 *     to the lighting; doing it twice is how a painted shadow turns into a hole.
 *
 * The saturation floor at the end guards a specific trap. A straight hue mix
 * from a warm albedo to a cool tint passes *through* the neutral axis, and for
 * skin tones the crossing sits near mix ≈ 0.5. Ship the obvious implementation
 * at the obvious number and the shadow side of every face eyedrops as grey,
 * which ART_BIBLE §2.1 forbids by name. The guard spends part of the *remaining*
 * distance to the tint when the result comes up short: forward, never back
 * toward the albedo, because retreating lands on the same neutral from the other
 * side.
 */
vec3 awToonShadowAlbedo( const in vec3 base ) {

  float v = max3( base );
  vec3 chroma = base / max( v, 1e-4 );

  vec3 hue = mix( chroma, uToonShadowTint, clamp( uToonShadowHue, 0.0, 1.0 ) );

  float peak = max( max3( hue ), 1e-4 );
  hue = max( vec3( 0.0 ), peak - ( peak - hue ) * max( uToonShadowSat, 0.0 ) );

  // Saturation floor, measured on the result and repaired toward the tint.
  float sat = ( peak - awMin3( hue ) ) / peak;
  float need = max( uToonShadowSatFloor, 1e-3 );
  hue = mix( hue, uToonShadowTint * peak, clamp( ( need - sat ) / need, 0.0, 1.0 ) );

  return ( hue / max( max3( hue ), 1e-4 ) ) * ( v * clamp( uToonShadowValue, 0.0, 1.0 ) );

}

/**
 * Level a colour, preserving its hue. **Off on every shipped class**, metal
 * included; kept for a caller who deliberately wants a stepped prop.
 *
 * It was on for metal, at three levels, and that is one of the two reasons the
 * armour had no metallic response. The arithmetic: 'floor( peak * 3 + 0.5 ) / 3'
 * sends any peak below 1/6 to **exactly zero** and everything from 1/6 to 1/2 to
 * the single constant 1/3. 'LookdevScene' authors 'environmentIntensity = 0.28'
 * and 'Lighting' only ever lowers it, so a plate's reflected radiance sits right
 * in that dead zone — the reflection was being deleted or frozen to one flat
 * value, on the one surface class whose whole read is environment reflection.
 * The plate's pauldron, by contrast, measures p2 5 → p98 190 sRGB inside a
 * single 42 px patch with a 4.8% longest flat run.
 *
 * Quantised on the **peak channel** and reapplied as a scale, so the hue the
 * probe returned is preserved exactly and only its level is stepped. Rounding
 * rather than flooring keeps the mean brightness unchanged, so turning
 * quantisation on does not also darken the surface.
 *
 * 'levels < 1' returns the colour untouched, which is how every class opts out
 * without a define of its own — a uniform branch, so it is coherent across the
 * whole draw and costs nothing measurable.
 */
vec3 awToonQuantise( const in vec3 c, const in float levels ) {

  if ( levels < 1.0 ) return c;

  float peak = max3( c );
  float stepped = floor( peak * levels + 0.5 ) / levels;

  return c * ( stepped / max( peak, 1e-5 ) );

}

#ifdef TOON_SPECULAR

/**
 * The specular **gate**, in N·L, and why it is a constant rather than the form
 * band.
 *
 * A highlight must not survive on the side of a surface the key cannot see. The
 * previous revision spent the form band for that, which worked only while the
 * band was wide: now that the character classes run a two-level toon terminator
 * five degrees across, reusing it would cut a glint in half with a straight line
 * wherever a plate edge crosses the terminator. A gate of its own, soft and
 * fixed, kills the highlight over roughly the same range the terminator lives in
 * while grading rather than slicing.
 */
const vec2 SPEC_GATE = vec2( -0.02, 0.22 );

/**
 * The one shared bound on how hot a mark may get *relative to the surface it
 * sits on*, applied in the composite once the diffuse level is known.
 *
 * Stating it here rather than per class because a ceiling in absolute radiance
 * cannot express "never more than half again as bright as the hair" — the same
 * 1.7 that is a discreet ping on steel is a white blaze on a dark braid. 0
 * disables it.
 */
float awToonSpecRelBound( const in float specPeak, const in float basePeak ) {

  if ( uToonSpecRelMax <= 0.0 ) return 1.0;

  return min( 1.0, ( basePeak * uToonSpecRelMax ) / max( specPeak, 1e-5 ) );

}

#endif

#ifdef TOON_SPEC_METAL

/**
 * The streak's Blinn exponent, stated rather than derived from roughness.
 *
 * The previous revision clamped roughness to 0.25 inside the lobe, which is a
 * Beckmann-equivalent exponent of 510 and falls to half its peak **1.8° off the
 * mirror direction**. On a chibi pauldron that mark is two or three pixels wide,
 * and in 'shots/now/cast-stage.png' it is not present in the frame at all: the
 * surface of every plate on the cast is one flat panel of colour, which is what
 * the review means by "one uniform matte material family for everything".
 *
 * The plate's armour is not marked with dots. Seth's breastplate and cuisses on
 * 'bravely01.jpg' each carry one long bright *streak* running with the curvature
 * of the piece — 120 sRGB against a 56 median, a defined edge on both sides and
 * a flat interior — and the same read is on every buckle, greave and blade in
 * 'bravely02.jpg'. That is a wide lobe with a hard threshold on it, not a narrow
 * lobe left to grade.
 *
 * 120 puts the half-power point 6.1° off the mirror in the half-vector, and the
 * threshold below cuts the streak's edge at 4.4°. Across a cylindrical greave
 * whose normal sweeps slowly along its length and quickly across it, that is
 * exactly the anisotropic-looking band the plate shows — the shape comes from
 * the *geometry's* curvature rather than from a tangent frame, which is why a
 * plain Blinn lobe is the right primitive here and a Kajiya-Kay one is not.
 *
 * Stated as a constant rather than read from 'roughness' so that no per-recipe
 * override in 'Garments' can widen it back into the sheen it replaced;
 * 'roughness' still means what it means everywhere else, and still drives the
 * environment reflection, which is metal's other half.
 */
const float METAL_SPEC_EXPONENT = 120.0;

/** The Blinn lobe the streak is cut out of. Bounded in 0..1 by construction, so
 *  'uToonSpecThreshold' states an angle rather than a radiance. */
float awToonMetalLobe( const in vec3 n, const in vec3 l, const in vec3 v ) {

  vec3 h = normalize( l + v );

  return pow( saturate( dot( n, h ) ), METAL_SPEC_EXPONENT );

}

/**
 * The streak's shape: **quantised**, with a flat interior and a hard edge.
 *
 * A symmetric 'smoothstep' a few hundredths wide over the threshold, which on a
 * lobe this broad is a drawn boundary: inside it the mark is at full strength
 * everywhere, outside it there is nothing. Its predecessor graded from the
 * threshold all the way to the mirror direction, so the mark's brightest point
 * was a single fragment and everything around it was a fade — the shape of an
 * airbrushed blob, and unreadable once the whole thing is four pixels across.
 *
 * 'awToonEdge' is the antialias floor and does the only softening that survives:
 * the transition is narrower than a pixel at battle-camera distance, and an
 * unfiltered one there crawls along the plate as the character breathes.
 */
float awToonStreakShape( const in float lobe ) {

  float t = clamp( uToonSpecThreshold, 0.001, 0.999 );
  float w = max( uToonSpecSoftness, 1e-3 );

  return awToonEdge( smoothstep( t - w, t + w, lobe ) );

}

#endif

#if defined( TOON_CREASE_INK ) || defined( TOON_METAL_SURFACE )

/**
 * How strongly this fragment sits on a **crease**, from two independent tests
 * that have to agree.
 *
 * Finding a crease from 'fwidth( normal )' alone is the obvious implementation
 * and it is wrong twice over, in opposite directions, which is why both tests
 * are here.
 *
 * **The angle test** — 'length( fwidth( n ) )' is the chord of the angle the
 * geometric normal turns through across one 2×2 quad, '2·sin(θ/2)': 0.845 at
 * 50°, 1.0 at 60°. On the faceted geometry 'CharacterFactory' ships the normal
 * is constant inside a facet and jumps at its boundary, so this is a direct
 * reading of the face-to-face angle and 'uToonCreaseRange' states the brief's
 * 55° threshold as the chord window straddling it. A 30° loft joint reads 0.52
 * and is rejected **at any zoom**, which the curvature test alone would not do:
 * pull the camera into a closeup and every facet on the cast is separated by
 * more surface-metres per pixel, so a pure curvature threshold starts inking the
 * low-poly construction lines.
 *
 * **The curvature test** — 'turn / travel', where travel is
 * 'length( fwidth( viewPos ) )', the metres of surface one pixel covers. The
 * pixel cancels and what is left is radians per metre, i.e. genuine curvature,
 * identical at any distance or resolution. It exists because the angle test
 * alone fires on *smooth* geometry the moment the camera pulls back far enough
 * that a whole cranium turns 55° inside one quad — which is exactly the
 * far-end-of-the-battle-stage case, where it would ink the entire character.
 * On this cast a chibi cranium (r ≈ 0.12 m) reads 8, a hair clump 33 and a
 * forearm 20, against hundreds for a genuine crease, so the window is nowhere
 * near either family's tail.
 *
 * Neither test alone survives both cameras. Their product does.
 *
 * Fed 'nonPerturbedNormal' rather than 'normal', so a normal map on a prop can
 * never be read as a crease; the character classes carry none by construction.
 */
float awToonCreaseAmount( const in vec3 n, const in vec3 viewPos,
                          const in vec2 angleWindow, const in vec2 curveWindow ) {

  float turn = length( fwidth( n ) );
  float travel = max( length( fwidth( viewPos ) ), 1e-5 );

  return smoothstep( angleWindow.x, angleWindow.y, turn )
    * smoothstep( curveWindow.x, curveWindow.y, turn / travel );

}

#endif

#ifdef TOON_METAL_SURFACE

/**
 * The **cavity band**: armour goes dark where it grazes the key.
 *
 * The measurement this exists for. A 42 px patch of Seth's left pauldron on
 * 'bravely01.jpg' runs p2 2.6 / p50 53.5 / p98 145 sRGB — the recesses between
 * plates are within three code values of black while the lit faces hold a mid
 * grey, a range of six stops inside one small piece of armour. Ours ran p2 9.6 /
 * p50 116.6, i.e. the whole plate sat in the top two stops with nothing dark in
 * it anywhere, and no shadow *ramp* can produce that difference: the ramp's dark
 * end is a stated fraction of its light end, so it moves the whole piece
 * together.
 *
 * What produces it on the plate is geometry we do not have — recessed borders
 * between separately sculpted plates, which are surfaces standing nearly
 * perpendicular to the key and therefore lit by almost nothing. This is that,
 * expressed as a shading term: a fragment whose N·L is near zero is a wall of a
 * recess whatever the model it sits on, so it is taken down toward the cavity
 * level. It is symmetric about zero deliberately — the far wall of a recess
 * faces away from the key and is just as dark as the near one.
 *
 * Only on metal. The same term on cloth would draw a dark line down the middle
 * of every garment's terminator, which is a fold that is not there.
 */
float awToonCavity( const in float ndl ) {

  float band = smoothstep( 0.0, max( uToonCavityWidth, 1e-3 ), abs( ndl ) );

  return mix( 1.0 - clamp( uToonCavityDepth, 0.0, 0.95 ), 1.0, band );

}

/**
 * **Edge wear**: a light rim along rolled and chipped edges, from fresnel ×
 * curvature.
 *
 * Every piece of plate on 'bravely01.jpg' and 'bravely05.jpg' is lighter along
 * its own borders than across its faces — the paint is rubbed off a rolled edge
 * before it wears anywhere else, and the exposed metal there catches light at
 * every angle. It is the single strongest cue that a shape is *layered plate*
 * rather than one moulded shell, and it costs no geometry to state.
 *
 * The edge is found by 'awToonCreaseAmount', at its own thresholds: wear starts
 * at a **35°** rolled edge where the ink line does not begin until 55°, because
 * paint rubs off long before a border is sharp enough to draw. 'WEAR_ANGLE' is
 * the chord window straddling 35° ('2·sin(θ/2)' = 0.52 at 30°, 0.68 at 40°) and
 * 'WEAR_CURVE' is the same inverse-metres guard the ink line uses, one step
 * lower.
 *
 * The fresnel factor is a *modulation* rather than a gate — 'mix(0.35, 1, f)',
 * not 'f'. A plate border square to the camera has almost no fresnel and is
 * exactly where the wear has to read; multiplying by fresnel outright would
 * delete the term across the front of the breastplate and leave it only on the
 * silhouette, where the rim already lives.
 */
const vec2 WEAR_ANGLE = vec2( 0.52, 0.68 );
const vec2 WEAR_CURVE = vec2( 60.0, 160.0 );

float awToonEdgeWear( const in vec3 n, const in vec3 v,
                      const in vec3 geoNormal, const in vec3 viewPos ) {

  float worn = awToonCreaseAmount( geoNormal, viewPos, WEAR_ANGLE, WEAR_CURVE );
  float fresnel = pow( 1.0 - saturate( dot( n, v ) ), 2.0 );

  return worn * mix( 0.35, 1.0, fresnel );

}

#endif

#ifdef TOON_CLOTH_TURN

/**
 * The fold turn: a **0.05 fresnel lift, spent as a multiply**.
 *
 * Cloth catches a little more light where it turns away from the eye — a fold's
 * flank is brighter than its face, which is how a fold reads at all once the
 * terminator has decided which side of the garment it is on. Every previous
 * attempt at this in the project spent it as an *additive white* term, which is
 * the grazing environment fresnel the last revision removed by name: brightest
 * exactly along the edge of each panel, hue-free, and indistinguishable from wet
 * plastic.
 *
 * A multiply on the surface's own radiance cannot do that. It has no colour of
 * its own to add, so a wine coat's fold flank is a lighter wine and a navy
 * coat's a lighter navy; and at 0.05 the whole effect is a twentieth of a stop,
 * which is a turn rather than a sheen. The exponent keeps it off the facing side
 * entirely.
 */
float awToonClothTurn( const in vec3 n, const in vec3 v ) {

  float grazing = 1.0 - saturate( dot( n, v ) );

  return 1.0 + max( uToonClothFresnel, 0.0 ) * pow( grazing, 3.0 );

}

#endif

#ifdef TOON_CREASE_INK

/**
 * The **interior crease line** — ink on a fold ridge or a plate border, drawn by
 * the surface rather than by a shell.
 *
 * 'render/Outline.js' draws the silhouette as an inverted hull and owns this
 * line's constants too ('CREASE_DEFAULTS'), but not its geometry, and the reason
 * is a budget one worth stating plainly: the geometric form of an interior
 * crease pass is a view-facing ribbon per qualifying edge, which on this cast
 * measures out at roughly twenty thousand extra triangles per character across
 * its half-dozen shading classes, all of them skinned. The capture harness
 * renders on CPU SwiftShader and has already failed a screenshot timeout once.
 * The fragment test draws the same line for two 'fwidth' pairs and no geometry
 * at all, and — unlike the ribbon — it cannot tear at a skin seam, cannot
 * z-fight against the surface it lies on, and needs no second skinned draw.
 *
 * The line is a **multiply on the shaded surface**, not a flat ink colour, and
 * that is deliberate. An interior line in an inked drawing is lighter than the
 * contour — it describes a form rather than closing a silhouette — and one that
 * responds to the light keeps a plate border legible on the lit side without
 * punching a black hole through the shadow side, where a fixed ink value would
 * be darker than the surface it is drawn on.
 */
float awToonCreaseInk( const in vec3 n, const in vec3 viewPos ) {

  return awToonCreaseAmount( n, viewPos, uToonCreaseRange, uToonCreaseCurve );

}

#endif

#ifdef TOON_DETAIL_MAP

/**
 * The hand-painted detail multiplier, projected from object space.
 *
 * Two planar samples, not three. A costume's dominant axis is vertical, so the
 * front (XY) and side (ZY) planes between them cover every panel a garment has;
 * the third plane of a full triplanar blend would only serve the top of a
 * shoulder, which on a chibi is a few dozen pixels, and it costs a third more
 * texture bandwidth on every character fragment in the frame.
 *
 * The map is authored **linear and centred on 128**, so a texel of exactly mid
 * grey doubles to 1.0 and changes nothing. That is what lets one channel carry a
 * print that both darkens (a woven ground) and lightens (a highlight thread),
 * and carry hue while it does — a warm ochre motif returns roughly
 * '(1.17, 0.94, 0.70)' and tints the garment underneath rather than replacing
 * it, which is how a print sits on cloth.
 *
 * 'uToonDetailStrength' fades the whole thing toward 1.0, so a caller states how
 * loud the print is in one number and the canvas is authored once at full
 * contrast.
 */
vec3 awToonDetail() {

  vec3 axis = abs( normalize( vToonDetailNormal ) );
  vec2 uvFront = vToonDetailPos.xy * uToonDetailScale;
  vec2 uvSide = vToonDetailPos.zy * uToonDetailScale;

  float side = axis.x / max( axis.x + axis.z, 1e-4 );
  vec3 print = mix( texture2D( uToonDetailMap, uvFront ).rgb,
                    texture2D( uToonDetailMap, uvSide ).rgb, side );

  return mix( vec3( 1.0 ), print * 2.0, clamp( uToonDetailStrength, 0.0, 1.0 ) );

}

#endif

#ifdef TOON_SPEC_HAIR

/**
 * Kajiya-Kay with Scheuermann's tangent shift, as a bare lobe.
 *
 * One band running across the crown, perpendicular to the strand direction —
 * which is what the plates show and what a round dot instead of a band would
 * disprove. Sculpted hair in this style is a carved volume, not strands, so
 * there is no tangent attribute to trust; the strand axis arrives as a
 * world-space uniform (default +Y, i.e. hair falls) and is orthogonalised
 * against the shading normal by the caller. The lobe is constant *along* the
 * strand axis and falls off *across* it, so it reads as a band running
 * perpendicular to the strands. A round dot means the tangent frame is wrong.
 */
float awToonAnisoLobe( const in vec3 tangent, const in vec3 halfDir ) {

  float tdh = dot( tangent, halfDir );

  return pow( sqrt( max( 1.0 - tdh * tdh, 0.0 ) ), max( uToonSpecExponent, 1.0 ) );

}

/**
 * The hair band's shape: **one crisp arc**, not a shoulder.
 *
 * Measured on the plates rather than argued: every head in 'bravely01.jpg' and
 * 'bravely05.jpg' carries exactly one bright pass across the hair mass, with a
 * boundary a couple of pixels wide and a flat interior — Elvis's swept-back
 * mass, Adelle's white bob and the ninja's crown all read the same way. The
 * previous revision's shoulder ran 0.26 wide over a threshold of 0.44, so the
 * band began at lobe 0.18 and, with the 0.45 core floor under it, put a
 * half-strength wash over most of the clump and no readable arc anywhere.
 *
 * A narrow symmetric 'smoothstep' gives the arc a defined inner and outer edge
 * and a constant interior; 'awToonEdge' widens it back to a pixel and a half
 * where the lobe has gone sub-pixel, so the arc antialiases instead of crawling
 * under animation. How bright the interior is allowed to be is not this
 * function's business — see 'awToonSpecRelBound'.
 */
float awToonArcShape( const in float lobe ) {

  float t = clamp( uToonSpecThreshold, 0.001, 0.999 );
  float w = max( uToonSpecSoftness, 1e-3 );

  return awToonEdge( smoothstep( t - w, t + w, lobe ) );

}

#endif

#ifdef TOON_SPEC_GLOSS

/**
 * The **prop** highlight: a soft shoulder over a Blinn lobe with a graded core.
 *
 * This is the previous revision's shape function, kept verbatim and now reachable
 * only from the three prop classes ('leather', 'crystal', 'eye'). On a monster
 * hide, a gemstone or a geometry eyeball a broad graded highlight is correct and
 * measured — what made it a defect was that every *character* class was shaded
 * through it too, so armour, cloth, skin, hair and the whole meadow shared one
 * plastic response. Character surfaces now take 'TOON_SPEC_METAL',
 * 'TOON_SPEC_HAIR' or no lobe at all.
 *
 * The exponent is derived from the material's own roughness through the standard
 * '2 / α² - 2' mapping, so 'roughness: 0.66' on leather means the same thing here
 * as it does on a stock 'MeshStandardMaterial'.
 */
/**
 * The floor under a prop highlight's core, and the last surviving piece of the
 * plateau that made every surface in the frame read as vinyl.
 *
 * At 0.45 the mark paid 45% of full gain the instant the lobe cleared its
 * threshold, so the highlight's *extent* was a flat shelf with a small brighter
 * core sitting inside it — the signature of moulded plastic. Taking that shape
 * away from armour, cloth, skin and hair was right; leaving the shelf on the
 * three classes that kept the shape only moved the defect onto the props, and
 * 'world/Bestiary.js' shades a creature that fills an eighth of the battle
 * frame through 'leather'.
 *
 * 0.15 keeps what the shape is *for* — a hide and a gemstone genuinely carry a
 * graded rather than a drawn highlight — while making the gradation start near
 * nothing, so the mark's edge is where the lobe dies rather than where a
 * constant shelf ends.
 */
const float GLOSS_CORE_FLOOR = 0.15;

float awToonGlossLobe( const in vec3 n, const in vec3 l, const in vec3 v, const in float roughness ) {

  vec3 h = normalize( l + v );
  float ndh = saturate( dot( n, h ) );

  float a = max( roughness * roughness, 0.02 );
  float exponent = clamp( 2.0 / ( a * a ) - 2.0, 1.0, 4096.0 );

  return pow( ndh, exponent );

}

float awToonGlossShape( const in float lobe ) {

  float t = clamp( uToonSpecThreshold, 0.001, 0.999 );
  float w = max( uToonSpecSoftness, 1e-3 );

  return awToonEdge( smoothstep( t - w, t + w, lobe ) )
    * mix( GLOSS_CORE_FLOOR, 1.0, saturate( lobe ) );

}

#endif

#ifdef TOON_SHEEN

/**
 * The fur / feather lobe: Charlie distribution with Neubelt visibility.
 *
 * Fur gets a lobe of its own rather than the shared highlight, and the reason is
 * a silhouette one rather than a shading one: a fur or feather collar reads as a
 * broken, soft-edged contour, and any highlight with a stated extent on it reads
 * as moulded plastic. The measured signature is a smooth unimodal spread — Adelle's
 * black collar on 'bravely01.jpg' runs p5 15 / p50 70 / p95 181 / max 223 sRGB
 * with everything in between populated — where a Blinn or GGX lobe on a dark
 * albedo gives a large mass near the albedo plus a small near-clipped hot spot
 * and almost nothing between them.
 *
 * Charlie's 'sin^(1/a)' distribution is broad and, crucially, *peaks at grazing
 * angles rather than at the mirror direction*, so the light sits on the
 * silhouette of every strand clump instead of in a spot on the front of the
 * mass. Neubelt's visibility term keeps it retro-reflective, which is what makes
 * fur brighten when the light is behind it. Both are cheap closed forms.
 *
 * Written out here rather than calling three's 'BRDF_Sheen': that function is
 * compiled only under 'USE_SHEEN', which is a 'MeshPhysicalMaterial' feature and
 * these are 'MeshStandardMaterial's. Depending on it would make the fur trim
 * silently vanish the day someone simplifies the material.
 */
float awToonSheen( const in vec3 n, const in vec3 l, const in vec3 v ) {

  vec3 h = normalize( l + v );
  float ndh = saturate( dot( n, h ) );
  float ndv = saturate( dot( n, v ) );
  float ndl = saturate( dot( n, l ) );

  float alpha = max( uToonSheenRoughness * uToonSheenRoughness, 0.02 );
  float invAlpha = 1.0 / alpha;
  // Floored at 2^-7 so 'pow' stays finite in fp16 at the mirror direction, where
  // 'sin2h' is genuinely zero. Filament's constant, for the same reason.
  float sin2h = max( 1.0 - ndh * ndh, 0.0078125 );

  float D = ( 2.0 + invAlpha ) * pow( sin2h, invAlpha * 0.5 ) / ( 2.0 * PI );
  float V = saturate( 1.0 / ( 4.0 * ( ndl + ndv - ndl * ndv ) ) );

  return D * V;

}

#endif

/**
 * Compress a value toward a ceiling with a C1-continuous soft shoulder.
 *
 * Both the highlight and the rim need a bound. This one acts on a term's
 * *magnitude*, never on its shape: the caller divides by the input peak and
 * multiplies the whole term by the result, so the gradation the class's shape
 * function built across a mark survives the bound intact. A hard 'min' would
 * flatten every overshooting fragment to exactly the ceiling — turning a graded
 * highlight into a constant-valued patch and, past it, into white, which is the
 * "clipped speculars with no bloom" the art review measured.
 *
 * Identity below 'c / 2', asymptotic to 'c' above it, and the two halves meet
 * with matching first derivatives so there is no visible knee. Written
 * branchlessly: 'min( x, k )' is the identity part and the exponential is zero
 * there, so the same expression covers both sides.
 */
float awToonSoftCap( const in float x, const in float c ) {

  float k = max( c, 1e-4 ) * 0.5;
  float span = max( c - k, 1e-4 );

  return min( x, k ) + span * ( 1.0 - exp( - max( x - k, 0.0 ) / span ) );

}

/**
 * The bound stated on **surface plus mark**, which is the quantity a photograph
 * of the plate actually measures.
 *
 * The scale that keeps 'base + mark' under 'uToonSpecSum' once the soft
 * shoulder has had its say. Identity while the pair is inside budget — the
 * shoulder is the identity below half the ceiling, so a discreet glint on a
 * mid-valued plate never touches this — and it takes back only the *excess*,
 * so a mark on a dark coat keeps its full contrast while the same mark on a
 * sunlit hair mass is the one that gets spent down.
 *
 * Written against peaks rather than per channel so the mark's hue survives: a
 * gold blade's ping stays gold and a warm hair band stays warm, exactly as with
 * the two bounds upstream of it.
 *
 * 'base' is subtracted *after* the shoulder rather than before, which is what
 * makes the term degrade gracefully: on a surface already at or past the
 * ceiling on its own the allowance goes to zero and the mark disappears, rather
 * than going negative and inverting.
 */
float awToonSumBound( const in float base, const in float mark ) {

  float allowed = max( awToonSoftCap( base + mark, max( uToonSpecSum, 1e-3 ) ) - base, 0.0 );

  return min( 1.0, allowed / max( mark, 1e-5 ) );

}

/**
 * The rim — a soft **profile**, in 0..1, which the composite bounds twice; see
 * 'TOON_SURFACE_COMPOSITE'.
 *
 * REFERENCE_TARGET §1 makes a bright rim/back light separating the cast from the
 * background a requirement of every frame. It is a *gradient* along the
 * silhouette, and the composite no longer runs it through 'awToonEdge': doing so
 * turned it into a hard 1.3 px light line that followed every internal contour
 * as well as the outer silhouette, which in our capture is the cyan piping down
 * the knight's arm, cape and greaves — a second ink outline in a light colour,
 * on top of the one 'render/Outline.js' already draws. No such line exists
 * anywhere on 'bravely01.jpg'.
 *
 * The three terms and the order they combine in:
 *
 * **Width.** 'pow( 1 - N·V, k )' has no width control — where its tail drops
 * below the window's lower edge is decided jointly by 'k' and by that edge. So
 * the grazing term is remapped first: 'uToonRimWidth' states the band's inner
 * edge directly, in N·V, and the exponent then shapes the falloff *inside* the
 * band instead of deciding how far it reaches. A width of 1 reproduces the bare
 * fresnel exactly, which is what the class that genuinely wants a broad wrap
 * (glass, where the fresnel *is* the material) is given.
 *
 * **The window.** Not redundant with the 'pow': 'pow' alone leaves a long
 * low-amplitude tail creeping across the facing side, and the window collapses
 * that tail to exactly zero.
 *
 * **The focus.** 'Lighting.RIM_CONTRACT' publishes 'floor: 0' and a focus window
 * opening at 0, which makes this term 'saturate( N·L_rim )' — the rim exists
 * only on the hemisphere the rim light can actually reach, rather than wrapping
 * the whole silhouette as a halo. The floor is left as a uniform because the rig
 * owns it, not because a preset should be setting it.
 */
float awToonRim( const in vec3 n, const in vec3 v, const in vec3 rimDirView ) {

  float grazing = saturate( dot( n, v ) );

  float span = clamp( uToonRimWidth, 0.02, 1.0 );
  float edge = saturate( ( span - grazing ) / span );
  float fresnel = pow( edge, max( uToonRimPower, 0.5 ) );

  float band = smoothstep( uToonRimShape.x, uToonRimShape.y, fresnel );
  float facing = smoothstep( uToonRimFocus.x, uToonRimFocus.y, dot( n, rimDirView ) );

  return band * mix( clamp( uToonRimFloor, 0.0, 1.0 ), 1.0, facing );

}
`;
