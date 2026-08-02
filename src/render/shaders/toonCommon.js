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
 * | `metal` | `awToonMetalLobe` + `awToonGlintShape` | continuous PMREM | roughness clamped ≤ 0.25 inside the lobe |
 * | `hair` | `awToonAnisoLobe` + `awToonArcShape` | none | one crisp arc, bounded at 1.4× the surface |
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
 *  5. `awToonMetalLobe` + `awToonGlintShape` — the steel glint. Roughness clamped
 *     to 0.25 inside the lobe (exponent 510, half-peak 1.8° off the mirror), and
 *     a shape with **no core floor**, so the mark is bright only where the
 *     surface faces the mirror direction and is exactly zero elsewhere.
 *  6. `awToonAnisoLobe` + `awToonArcShape` — Kajiya-Kay narrowed into one crisp
 *     arc with a defined inner and outer edge and a flat interior.
 *  7. `awToonSpecRelBound` — the bound that makes a hair band read as hair: the
 *     mark may never exceed `uToonSpecRelMax` of the diffuse level beneath it,
 *     evaluated in the composite where that level is finally known. Hair runs
 *     0.40, i.e. 1.4× the surface at most.
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
uniform float uToonSpecCeiling;

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
 * The steel glint's maximum roughness.
 *
 * Armour is the only class on a character that carries a direct highlight with
 * any width to it, and the brief for this revision states the bound: a GGX
 * roughness of 0.25 or tighter. Clamping *inside* the lobe rather than trusting
 * the preset is what makes that a property of the class — 'Garments' builds
 * plate, trim and blades through the same preset with per-recipe overrides, and
 * one of them raising 'roughness' for a scuffed look must not be able to spread
 * the glint back into the sheen this revision exists to remove.
 *
 * At 0.25 the Beckmann-equivalent exponent is 510, so the lobe falls to half its
 * peak 1.8° off the mirror direction. That is a *glint*: on a chibi pauldron at
 * battle-camera distance it is a few pixels across, which is what the plate
 * shows — Seth's plate carries a scatter of small bright marks along its rolled
 * edges and is otherwise valued entirely by the form ramp.
 */
const float METAL_MAX_ROUGHNESS = 0.25;

/**
 * The metal lobe: Blinn-Phong at a bounded roughness.
 *
 * Blinn rather than a normalised microfacet BRDF because it is *boundable* — the
 * lobe lives in 0..1, so 'uToonSpecThreshold' means the same thing on every
 * surface and the shape can be stated as two numbers. A normalised GGX lobe
 * peaks anywhere from 1 to 100 depending on roughness and cannot be shaped by a
 * stated number at all. The exponent is the standard '2 / α² - 2' mapping with
 * 'α = roughness²', so the clamp above is expressed in the units the rest of the
 * engine uses for roughness.
 */
float awToonMetalLobe( const in vec3 n, const in vec3 l, const in vec3 v, const in float roughness ) {

  vec3 h = normalize( l + v );
  float ndh = saturate( dot( n, h ) );

  float a = max( min( roughness, METAL_MAX_ROUGHNESS ), 0.02 );
  a = a * a;
  float exponent = clamp( 2.0 / ( a * a ) - 2.0, 1.0, 8192.0 );

  return pow( ndh, exponent );

}

/**
 * The glint's shape: graded from the threshold up to the mirror direction, and
 * **exactly zero below it**.
 *
 * This is the function the "wet vinyl" defect actually lived in. Its predecessor
 * shaped every class with 'smoothstep( t - w, t + w, lobe ) * mix( 0.45, 1, lobe )'
 * — a *floor* of 45% of full gain across the whole shoulder. With metal's
 * threshold at 0.30 and shoulder at 0.22 the mark began at lobe 0.08, which at
 * exponent 300 is 7° of half-angle, and 45% of the gain was already being paid
 * there. The result was a broad plateau of near-constant sheen with a small
 * brighter core: a plastic surface, on every class that carried any gloss at all.
 *
 * There is no core floor here. A single 'smoothstep' from the threshold to the
 * lobe's peak means the mark's *extent* and its *gradation* are the same curve —
 * it is bright only where the surface genuinely faces the mirror direction and
 * falls continuously to nothing over a stated width, which is what a small
 * distinct glint is. 'awToonEdge' keeps it from crawling once it goes sub-pixel.
 */
float awToonGlintShape( const in float lobe ) {

  float t = clamp( uToonSpecThreshold, 0.001, 0.999 );
  float hi = min( t + max( uToonSpecSoftness, 1e-3 ), 1.0 );

  return awToonEdge( smoothstep( t, hi, lobe ) );

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
const float GLOSS_CORE_FLOOR = 0.45;

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
