/**
 * toonCommon.js — the GLSL vocabulary of the character shading model.
 *
 * ## The doctrinal ruling this file is built on
 *
 * Three documents in this repo describe character shading and they contradict
 * each other. `docs/ANIME_PIPELINE.md` §2/§4/§6 demand flat saturated colour, a
 * hard two-band terminator, a hard-edged specular shape and an ink outline.
 * `docs/BRAVELY_REFERENCE.md` §1/§4 reverses all four, and the plates in
 * `docs/reference/` do support it — measured on `bravely01.jpg`, the white hat
 * ramps 236 → 142 sRGB over ~30 px of a ~150 px form with a 16-bin histogram
 * populated in every bin, and four silhouette crossings show no ink trough.
 *
 * **The ruling is ANIME_PIPELINE.** It is the document the build brief names as
 * the literal spec ("how characters are built. Follow literally"), it is the
 * rubric the art review scores against, and its one-line test in §6 is the
 * acceptance criterion the cast has been failing. A shading model that satisfies
 * neither document is the one outcome that cannot be defended, so this file
 * commits to the cel model completely rather than meeting the two halfway.
 *
 * The BRAVELY measurements are not deleted; they are recorded here so that if
 * the ruling is ever reversed, the numbers behind the soft model are still on
 * record and the reversal costs a preset table rather than a rewrite.
 *
 * ## The model
 *
 * **Two levels and an edge between them, not a falloff.** Every light reports
 * its own N·L, the lights are collected into one dominant direction, and the
 * *composite* thresholds that once. Collecting rather than shading per light is
 * the property worth keeping from the previous revision — a six-light rig
 * otherwise draws six terminators at six angles and their sum is a muddle — but
 * what it resolves to is now an edge.
 *
 * The pieces, in the order the composite uses them:
 *
 *  1. `awToonBand` — the two-band `smoothstep( t - w, t + w, N·L )` of
 *     ANIME_PIPELINE §2, at `t ≈ 0.5` and `w ≈ 0.04`. Wide ramps read as PBR.
 *  2. `awToonEdge` — resolves the transition to a stated width in **device
 *     pixels**. This is what makes a terminator a drawn line rather than a
 *     gradient that happens to be steep: it holds the same crispness on a
 *     character filling the frame and on one at the back of the battle stage,
 *     and because the width is fixed in pixels it antialiases instead of
 *     crawling. The previous revision used `fwidth` only to *widen* a collapsing
 *     ramp; under `TOON_CEL_EDGE` it also narrows, which is the whole technique.
 *     That define is set for the **character** classes only — ANIME_PIPELINE is
 *     a character pipeline, `world/Flora.js` shades the entire meadow through
 *     the `generic` prop class, and banding a field of grass is a change neither
 *     document asks for.
 *  3. `awToonShadowAlbedo` — the dark side is a hue rotation with rising
 *     saturation, never a multiply. Kept unchanged: this is the one part of the
 *     model both documents agree on, and ANIME_PIPELINE §2 names a darkened copy
 *     of albedo as "the single most common way cel shading looks cheap".
 *  4. `awToonBlinn` + `awToonSpecShape` — ANIME_PIPELINE §2: "Specular is a
 *     hard-edged shape, not a soft lobe: threshold the Blinn-Phong term to
 *     produce a crisp highlight blob." Both spellings are literal. The
 *     `BRDF_GGX` the previous revision used is a continuous microfacet falloff
 *     and cannot produce a shape at any parameterisation.
 *  5. `awToonAnisoLobe` — Kajiya-Kay for the hair band, thresholded by the same
 *     shape function so the band has an edge (§3: "hard-ish edges").
 *  6. `awToonSheen` — a Charlie/Neubelt lobe for fur and feather trim, which is
 *     the one surface class whose silhouette is meant to read as broken rather
 *     than as a clean edge.
 *  7. `awToonQuantise` — levels an environment reflection on a character class.
 *     §4's rule is flat colour blocking; a continuously-swept probe reflection
 *     across a pauldron is the single loudest "this is PBR" cue a cel frame can
 *     carry.
 *  8. `awToonRim` — a *profile*, edge-resolved by the composite into a band.
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

// The third band of ANIME_PIPELINE §2, on the lit side, for hair and metal only.
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
 * The two-band step of ANIME_PIPELINE §2, verbatim: 'smoothstep( t - w, t + w,
 * N·L )' with 't ≈ 0.5' and 'w ≈ 0.03–0.06'.
 *
 * 't' near 0.5 rather than at the geometric terminator is deliberate and is what
 * gives a cel figure its large, decisive shadow mass: the surface commits to the
 * dark level at 60° from the key rather than at 90°, so the shadow shape is a
 * drawn shape with a describable contour rather than the thin sliver a physical
 * falloff leaves. 'w' is the transition's **half-width in N·L**, and it is
 * narrow — this is the number that separates anime from stylised PBR, and the
 * previous revision's near-unit value is the defect the art review named first.
 *
 * The output is still continuous. Making it *hard* is 'awToonEdge''s job, and
 * keeping the two separate is what lets the composite intersect this with the
 * cast-shadow term before either is resolved.
 */
float awToonBand( const in float ndl, const in float t, const in float w ) {

  float lo = t - max( w, 1e-3 );
  float hi = t + max( w, 1e-3 );

  return smoothstep( lo, hi, ndl );

}

/**
 * Resolve a transition to a width in **device pixels**.
 *
 * 'fwidth( x )' is how much the transition moves between neighbouring pixels, so
 * '1 / fwidth( x )' is how many pixels it currently spans, and dividing by
 * 'uToonEdgePixels' rescales it about its own midpoint. What the two compile
 * paths differ on is whether that rescale is allowed to *narrow*:
 *
 *  - **'TOON_CEL_EDGE' — a drawn edge.** The scale is unclamped, so a
 *    transition spanning a third of a character is compressed to a line and one
 *    that has collapsed into a single pixel is expanded back out to the same
 *    width. Narrowing is what produces the terminator: without it there is no
 *    edge, only a steep gradient, and a steep gradient photographs as PBR — the
 *    "smooth PBR-ish falloff with no terminator anywhere" the review measured.
 *    Widening is what stops that edge aliasing; a hard 'step' crawls and
 *    stair-steps under animation, which is how hand-rolled cel shaders betray
 *    themselves, while a transition held at a constant ~1.3 px is a clean,
 *    resolution-independent antialiased line at any distance or pixel ratio.
 *  - **Without it — an antialias floor only.** 'min( 1, … )' can widen and never
 *    narrow, so a soft ramp stays soft.
 *
 * The distinction is which *classes* get an edge, and it is deliberately not
 * "all of them". ANIME_PIPELINE governs **characters** — its own framing is a
 * character pipeline, and REFERENCE_TARGET §8.4 leaves environments physically
 * based. 'generic', 'leather' and 'crystal' are the prop classes: 'world/Flora.js'
 * shades every blade of grass, flower and tree in the meadow through 'generic',
 * and banding a whole field of foliage is not a decision either document asks
 * for. It also measurably wrecks the frame — banding the props compressed the
 * capture's luminance range from p1 15 / p95 228 to p1 41 / p95 182, which is
 * precisely the chalky mid-only structure the review already objects to.
 *
 * The floor of 0.5 px keeps a caller from asking for a sub-pixel edge, which is
 * a 'step' with the aliasing that implies.
 */
float awToonEdge( const in float x ) {

  float px = max( uToonEdgePixels, 0.5 );
  float span = max( px * fwidth( x ), 1e-5 );

  #ifdef TOON_CEL_EDGE
    float scale = 1.0 / span;
  #else
    float scale = min( 1.0, 1.0 / span );
  #endif

  return saturate( 0.5 + ( x - 0.5 ) * scale );

}

/**
 * Fine bias of the terminator inside its own transition window.
 *
 * 'uToonRampGamma' is what remains of the previous model's ramp-shaping control,
 * and in a two-band model there is very little for it to shape: the transition
 * is only 'w' wide, so a gamma can move the crossing at most that far. That
 * limited job is still worth keeping — a hair mass and a plate want their edge a
 * few degrees either side of where the cloth wants it, and expressing that as a
 * bias on a shared threshold is clearer than six different thresholds. Above 1
 * holds the shadow slightly longer; below 1 turns into the light earlier.
 *
 * Applied before the pixel resolve, because after it the value is already a step
 * and there is nothing left to bend.
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
 * Level a colour, preserving its hue.
 *
 * ANIME_PIPELINE §5 asks a character to read as three or four flat colour zones.
 * An environment probe sampled along the reflection vector does the opposite: it
 * sweeps continuously across a curved plate, and that sweep is the loudest
 * "physically based" cue a stylised frame can carry — it is also, on the
 * reference plates, genuinely the strongest metal cue, which is exactly why the
 * two documents disagree about it. Under the cel ruling the reflection is
 * quantised into a small number of flat plates instead.
 *
 * Quantised on the **peak channel** and reapplied as a scale, so the hue the
 * probe returned is preserved exactly and only its level is stepped. Rounding
 * rather than flooring keeps the mean brightness of the surface unchanged, so
 * turning quantisation on does not also darken the armour.
 *
 * 'levels <= 0' returns the colour untouched, which is how every dielectric
 * class opts out without a define of its own.
 */
vec3 awToonQuantise( const in vec3 c, const in float levels ) {

  if ( levels < 1.0 ) return c;

  float peak = max3( c );
  float stepped = floor( peak * levels + 0.5 ) / levels;

  return c * ( stepped / max( peak, 1e-5 ) );

}

#ifdef TOON_SPECULAR

/**
 * Blinn-Phong, with its exponent derived from the material's own roughness.
 *
 * ANIME_PIPELINE §2 names Blinn-Phong specifically ("threshold the Blinn-Phong
 * term"), and the reason is that it is *boundable*: the lobe lives in 0..1, so a
 * threshold on it is a threshold on a shape. A normalised microfacet BRDF peaks
 * anywhere from 1 to 100 depending on roughness, so the same threshold is a
 * different shape on every surface and the "hard-edged highlight" cannot be
 * specified at all. That, and not its energy behaviour, is why 'BRDF_GGX' is
 * gone from the direct path.
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
 * A **hard-edged** highlight shape.
 *
 * ANIME_PIPELINE §2, literally: "Specular is a hard-edged shape, not a soft
 * lobe: threshold the Blinn-Phong term to produce a crisp highlight blob." The
 * previous revision floored the transition width at roughly the threshold
 * itself, which turns any threshold back into a falloff — a deliberate
 * inversion of this rule, made under the other document.
 *
 * The threshold is the lobe value the blob's edge sits at; the width is a
 * pre-antialias only, since 'awToonEdge' then resolves the edge to the same
 * device-pixel width as the terminator. Sharing that one resolve is what keeps a
 * highlight's edge and a terminator's edge visually the same *kind* of mark,
 * which is what an inked frame looks like.
 */
float awToonSpecShape( const in float lobe ) {

  float t = clamp( uToonSpecThreshold, 0.001, 0.999 );
  float w = max( uToonSpecSoftness, 1e-3 );

  return awToonEdge( smoothstep( t - w, t + w, lobe ) );

}

#endif

#ifdef TOON_ANISO

/**
 * Kajiya-Kay with Scheuermann's tangent shift, as a bare lobe.
 *
 * ANIME_PIPELINE §3 asks for "one anisotropic highlight band running across the
 * crown, perpendicular to the strand direction". Sculpted hair in this style is
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
 * Fur is the one class the cel ruling does *not* give a hard edge, and the
 * reason is a silhouette one rather than a shading one: a fur or feather collar
 * reads as a broken, soft-edged contour, and a thresholded blob on it reads as
 * moulded plastic. The measured signature is a smooth unimodal spread — Adelle's
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
 * *magnitude*, never on its shape: by the time it is reached the highlight is
 * already a thresholded blob of near-constant value, so compressing it scales
 * the plateau rather than rounding the edge that 'awToonSpecShape' just drew.
 * That separation is why a soft shoulder is still the right bound under a cel
 * model — a hard 'min' would clip the plateau to exactly the ceiling and, on
 * anything that overshoots, drive it to white, which is the "clipped speculars
 * with no bloom" the art review measured.
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
 * The rim — a **profile**, in 0..1, which the composite resolves into a band
 * with a drawn edge and bounds twice; see 'TOON_SURFACE_COMPOSITE'.
 *
 * REFERENCE_TARGET §1 makes a bright rim/back light separating the cast from the
 * background a requirement of every frame, and under the cel ruling it is a
 * *band* — a flat shape with an edge, like every other mark on the character —
 * rather than a fresnel wash. The three terms and the order they combine in:
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
