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
 * ## The model
 *
 * **Two stated levels with a broad ramp between them.** Every light reports its
 * own N·L, the lights are collected into one dominant direction, and the
 * *composite* shapes that once. Collecting rather than shading per light is the
 * property worth keeping — a six-light rig otherwise draws six terminators at
 * six angles and their sum is a muddle — but what it resolves to is a falloff
 * wide enough to carry the form, not an edge.
 *
 * The stylisation is now carried by *where the two levels sit* and *how the ramp
 * is curved* rather than by how narrow the transition is: `shadowDepth` states
 * the dark level outright, `awToonShadowAlbedo` rotates its hue, and
 * `awToonBias` bends the ramp so midtones settle low the way a painted figure's
 * do. That is soft stylised shading with form, which is what the plate shows;
 * it is not a return to plain PBR, which has neither a stated dark level nor a
 * hue-rotated shadow.
 *
 * The pieces, in the order the composite uses them:
 *
 *  1. `awToonBand` — `smoothstep( t - w, t + w, N·L )`, with `w` now a *wide*
 *     half-width (0.7–0.85 on the character classes) so the ramp spans most of
 *     the N·L range. This is the number the plate measurement moved.
 *  2. `awToonBias` — the ramp's curve. With a wide band this is the control that
 *     does the stylising: above 1 it holds the dark side longer, which is what
 *     puts the median of a costume zone down near the plate's (thigh plate p50
 *     = 66 sRGB, red coat p50 = 31–35) instead of up at ours (130–176).
 *  3. `awToonEdge` — an **antialias floor**, and only that. It can widen a
 *     transition that has collapsed below `uToonEdgePixels` on screen; it can no
 *     longer narrow one. Called from the specular shape alone, because at
 *     `roughness 0.28` the Blinn exponent is near 300 and that lobe genuinely
 *     can go sub-pixel at battle-camera distance. Removing it from the
 *     terminator, the third band and the rim also removes three `fwidth`
 *     evaluations per character fragment.
 *  4. `awToonShadowAlbedo` — the dark side is a hue rotation with rising
 *     saturation, never a multiply. Unchanged: this is the one part of the model
 *     every document and the plates agree on.
 *  5. `awToonBlinn` + `awToonSpecShape` — a Blinn-Phong lobe with a soft
 *     shoulder. The shoulder's width is `specSoftness`, and on the plate the
 *     armour highlight is a bright *graded* streak along a plate edge, not a
 *     flat blob: the pauldron patch runs p2 5 → p98 190 sRGB with every level in
 *     between populated.
 *  6. `awToonAnisoLobe` — Kajiya-Kay for the hair band, shaped by the same
 *     shoulder so hair reads as a carved volume with a graded band.
 *  7. `awToonSheen` — a Charlie/Neubelt lobe for fur and feather trim, which is
 *     the one surface class whose silhouette is meant to read as broken rather
 *     than as a clean edge.
 *  8. `awToonQuantise` — an opt-in leveller for an environment reflection.
 *     **Off on every class**, including metal, and the measurement is why: at
 *     three levels any reflection whose peak radiance falls below 1/6 quantises
 *     to exactly zero, and everything from 1/6 to 1/2 snaps to the single
 *     constant 1/3. `LookdevScene` authors `environmentIntensity = 0.28`, which
 *     puts armour squarely in that dead zone — so the "quantised environment
 *     reflection" the cel model claimed to give metal was in practice no
 *     reflection at all. The knob stays for a caller who wants a deliberately
 *     stepped prop.
 *  9. `awToonRim` — a soft fresnel profile. It used to be edge-resolved into a
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
uniform float uToonEnvSpecular;

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

// The threshold and its transition width belong to *both* specular paths: the
// isotropic highlight is now a thresholded Blinn lobe rather than a continuous
// microfacet BRDF, so it needs the same shape controls the hair band does.
#ifdef TOON_SPECULAR
  uniform vec3  uToonSpecColor;
  uniform float uToonSpecGain;
  uniform float uToonSpecAlbedoMix;
  uniform float uToonSpecThreshold;
  uniform float uToonSpecSoftness;
#endif

// The strand axis and its lobe tightness belong to the anisotropic path alone;
// the isotropic path derives its exponent from 'material.roughness' so that one
// number keeps meaning the same thing on a toon material and a stock one.
#ifdef TOON_ANISO
  uniform vec3  uToonAnisoDirection;
  uniform float uToonAnisoShift;
  uniform float uToonSpecExponent;
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
 * 't' is where the ramp's midpoint sits in N·L and 'w' is its **half-width**.
 * The character classes now run 't' low (0.10–0.18) and 'w' wide (0.70–0.85),
 * which puts 't - w' below -0.5 and 't + w' at or above 1 — so the ramp spans
 * the *whole* useful range of N·L and every fragment of a curved surface lands
 * somewhere different on it. That is what produces the plate's continuous
 * pauldron falloff (113 → 8 sRGB over 48 px, ~40 distinct values) instead of the
 * ±2-code-value plateau the narrow-band version gave us.
 *
 * The old numbers were 't ≈ 0.5, w ≈ 0.04'. They are not a smaller version of
 * this — they are a different technique, and they are what made the surfaces
 * flat: at 'w = 0.04' the whole transition is 5° of surface normal and
 * everything either side of it is a constant.
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
 * The one term that still needs the floor is the specular shape: 'metal' runs
 * 'roughness 0.28', which puts the Blinn exponent near 300, and that lobe does
 * genuinely go sub-pixel on a pauldron at battle-camera distance — where a raw
 * 'smoothstep' crawls and stair-steps under animation. Every other caller was
 * dropped, which removes three 'fwidth' evaluations per character fragment on
 * the largest surfaces in frame.
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
 * The ramp's curve — and with a wide band, the control that does the stylising.
 *
 * Under the narrow-band model this could only nudge a 5°-wide crossing and was
 * close to inert. Now that 'awToonBand' spans the whole N·L range, 'pow' on its
 * output is what decides where the *midtones* sit, which is the difference the
 * plate measurement is loudest about: the plate's costume zones have medians of
 * 31–66 sRGB (12–26% of range) while ours sat at 130–176 (51–69%). A gamma above
 * 1 holds the dark side of the ramp longer and pulls that median down, which is
 * how a painted figure is valued — most of the form in the lower half, a
 * comparatively small bright pass near the key.
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
 * How dark the *inside* of a highlight is allowed to get at its boundary, as a
 * fraction of its core. Not a uniform: this is the difference between a graded
 * highlight and a sticker, and no surface class has ever wanted a different
 * answer. Below about 0.3 the highlight develops a visible dark ring at its own
 * edge, because the shoulder and the grade both fall off there at once.
 */
const float SPEC_CORE_FLOOR = 0.45;

/**
 * Blinn-Phong, with its exponent derived from the material's own roughness.
 *
 * Blinn rather than a normalised microfacet BRDF because it is *boundable*: the
 * lobe lives in 0..1, so 'uToonSpecThreshold' and 'uToonSpecSoftness' mean the
 * same thing on every surface and the shape can be specified as two numbers. A
 * normalised microfacet lobe peaks anywhere from 1 to 100 depending on roughness
 * and cannot be. That, and not its energy behaviour, is why 'BRDF_GGX' is gone
 * from the direct path.
 *
 * The exponent is the standard Beckmann-equivalent mapping '2 / α² - 2' with
 * 'α = roughness²', so a caller who sets 'roughness: 0.32' on a plate still gets
 * a tight highlight and one who sets 0.66 on leather still gets a broad one —
 * one number keeps meaning the same thing across the toon and stock materials,
 * which is what stops a prop and a costume drifting apart.
 */
float awToonBlinn( const in vec3 n, const in vec3 l, const in vec3 v, const in float roughness ) {

  vec3 h = normalize( l + v );
  float ndh = saturate( dot( n, h ) );

  float a = max( roughness * roughness, 0.02 );
  float exponent = clamp( 2.0 / ( a * a ) - 2.0, 1.0, 4096.0 );

  return pow( ndh, exponent );

}

/**
 * The highlight's shape: a soft shoulder over the lobe, with a graded core.
 *
 * The plate's armour highlight is not a flat blob. Inside one 42 px pauldron
 * patch the values run p2 5 / p50 56 / p98 190 sRGB with every level between
 * them populated, and the bright pass along a plate edge falls off across its
 * own width — that gradation is most of what makes it read as metal rather than
 * as a white sticker. The previous revision thresholded the lobe into a
 * constant-valued blob and then resolved its edge to 1.3 px, which is the other
 * half of why the pauldron scanline was flat.
 *
 * Two terms, and they do different jobs:
 *
 *  - 'smoothstep( t - w, t + w, lobe )' decides the highlight's *extent*. 't' is
 *    still the lobe value its boundary sits at, so a caller's existing threshold
 *    keeps its meaning; 'w' is now a genuine shoulder rather than a pre-antialias
 *    sliver, and the presets widened accordingly.
 *  - 'mix( SPEC_CORE_FLOOR, 1.0, lobe )' grades the inside. Without it the
 *    plateau is constant however wide the shoulder is, and a wide shoulder alone
 *    just moves the flat region rather than removing it.
 *
 * 'awToonEdge' is still applied, but only as the antialias floor it now is:
 * 'metal' runs 'roughness 0.28', so the Blinn exponent is near 300 and the
 * shoulder genuinely can fall below a pixel at battle-camera distance.
 */
float awToonSpecShape( const in float lobe ) {

  float t = clamp( uToonSpecThreshold, 0.001, 0.999 );
  float w = max( uToonSpecSoftness, 1e-3 );

  return awToonEdge( smoothstep( t - w, t + w, lobe ) )
    * mix( SPEC_CORE_FLOOR, 1.0, saturate( lobe ) );

}

#endif

#ifdef TOON_ANISO

/**
 * Kajiya-Kay with Scheuermann's tangent shift, as a bare lobe.
 *
 * One highlight band running across the crown, perpendicular to the strand
 * direction — which is what the plate's hair shows and what a round dot instead
 * of a band would disprove. Sculpted hair in this style is
 * a carved volume, not strands, so there is no tangent attribute to trust; the
 * strand axis arrives as a world-space uniform (default +Y, i.e. hair falls) and
 * is orthogonalised against the shading normal by the caller. The lobe is
 * constant *along* the strand axis and falls off *across* it, so it reads as a
 * band running perpendicular to the strands. A round dot means the tangent frame
 * is wrong.
 */
float awToonAnisoLobe( const in vec3 tangent, const in vec3 halfDir ) {

  float tdh = dot( tangent, halfDir );

  return pow( sqrt( max( 1.0 - tdh * tdh, 0.0 ) ), max( uToonSpecExponent, 1.0 ) );

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
 * multiplies the whole term by the result, so the gradation 'awToonSpecShape'
 * built across a highlight survives the bound intact. A hard 'min' would instead
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
