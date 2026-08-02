/**
 * toonCommon.js — the GLSL vocabulary of the character shading model.
 *
 * ## This file is a correction, and the evidence is the reference plates
 *
 * The previous revision implemented hard two-band cel shading: one
 * `smoothstep( t - w, t + w, N·L )` with `w ≈ 0.04`, resolved through `fwidth`
 * to a terminator **1.3 device pixels wide**, plus a hard-thresholded specular
 * "blob", plus a three-step quantiser on the environment probe. It was written
 * against prose in `docs/ANIME_PIPELINE.md`. The client's actual reference
 * screenshots are now in `docs/reference/`, and they do not show any of it.
 * Measured off `bravely01.jpg` (1920×1080) and `bravely02.jpg`:
 *
 *  - **The terminator is a broad continuous gradient, not a band.** The white
 *    hat at x=685 runs 236 → 142 sRGB down its crown over ~30 px on a form
 *    ~150 px wide (20% of the form). The red coat sleeve at y=520 runs 15 → 188
 *    over ~13 px on a ~50 px cylinder (26%). Neither shows a step.
 *  - **There is no cel banding.** A 16-bin histogram of the hat's interior over
 *    120–260 sRGB is populated in *every* bin (113 140 157 196 262 369 429 321
 *    192 103 88 128 430 522 30 4). Two-band shading of a curved form is bimodal
 *    with an empty middle; this is a ramp.
 *  - **The shadow side bottoms out high.** Hat crown 236 vs. underside 142 is a
 *    linear ratio of 0.34 — the dark mass is a *level*, and it is a third of the
 *    light mass, not a hole. That is what `uToonShadowDepth` states.
 *  - **The face barely shades at all.** Elvis's cheek measures p50 178 / p95 187
 *    sRGB — ±3% across the whole lit face — and the darkest skin sample on the
 *    plate is RGB(151,130,123) against a lit RGB(186,155,147): a ratio of 0.81,
 *    warm-biased (red falls least). `uToonShadowFloor` is that number.
 *
 * So the model here is a **soft wrapped diffuse ramp between two stated
 * levels**, with a painted hue shift on the dark side. The architecture that
 * collects every light's contribution and resolves it *once* is kept — it is
 * what stops a six-light rig drawing six terminators at six angles — but what it
 * resolves to is a gradient, not an edge.
 *
 * The pieces:
 *
 *  1. `awToonDiffuse` — a wrapped ramp, `smoothstep` across a *wide* window in
 *     N·L. The width is the plate's, roughly a full unit of N·L.
 *  2. `awToonResolve` — shapes the accumulated ramp and guarantees it never
 *     collapses below a stated number of screen pixels, which is the only thing
 *     `fwidth` is used for here. It is an antialias floor, not an edge former.
 *  3. `awToonShadowAlbedo` — the dark side is a hue shift with rising
 *     saturation, kept from the previous revision because the plates support it:
 *     the shadow-side skin sample above holds its warmth rather than going grey.
 *  4. `awToonSpecShape` — a soft shoulder on a specular lobe. The plates carry
 *     no hard-edged highlight anywhere, so a caller's threshold is honoured as
 *     the lobe's *centre* while the transition is floored wide.
 *  5. `awToonSheen` — a Charlie/Neubelt lobe for fur and feather trim. Adelle's
 *     fur collar measures p5 15 / p50 70 / p95 181 / max 223 sRGB in a smooth
 *     unimodal spread: a broad, low, retro-reflective sheen. A Blinn lobe with a
 *     tight exponent gives the small hot spot on a dark mass that reads as
 *     moulded plastic, which is exactly what this replaces.
 *  6. `awToonRim` — a *profile* in 0..1, no longer clamped to a pixel width,
 *     because it is no longer trying to be a line. Its radiance is bounded twice
 *     by the composite; see `TOON_SURFACE_COMPOSITE`.
 *
 * What is gone: `awToonBand`'s hard step, `awToonEdge`'s pixel-width resolve,
 * the third "lit band" plateau, the specular threshold cut, and `awToonPlate`'s
 * three-step quantiser on the environment probe. On the plate the greaves in
 * `bravely02.jpg` reflect the purple ice below and the teal aurora above as a
 * continuous sweep — quantising that is precisely what stopped our armour
 * reading as metal.
 *
 * There is still **no ramp texture and no noise of any kind**: no procedural
 * surface noise ever touches a character. Clothing *patterns* arrive through the
 * base colour map, which this model never multiplies anything into.
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
 * rather than a multiply toward black.
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

#ifdef TOON_SPECULAR
  uniform vec3  uToonSpecColor;
  uniform float uToonSpecGain;
  uniform float uToonSpecAlbedoMix;
#endif

// The lobe-shaping trio belongs to the anisotropic path alone. The isotropic
// highlight is now three's own 'BRDF_GGX' driven by 'material.roughness', so an
// exponent and a threshold would have nothing to act on there.
#ifdef TOON_ANISO
  uniform vec3  uToonAnisoDirection;
  uniform float uToonAnisoShift;
  uniform float uToonSpecExponent;
  uniform float uToonSpecThreshold;
  uniform float uToonSpecSoftness;
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
 * The diffuse ramp: N·L in, 0..1 out, over a **wide** window.
 *
 * This is the single change the reference plates force, and it is a change of
 * kind rather than of degree. The previous revision put 'w ≈ 0.04' here and then
 * resolved the result to a 1.3-pixel edge, which is hard cel shading. Nothing in
 * 'docs/reference/' shades that way. Measured on 'bravely01.jpg': the white hat
 * ramps 236 → 142 sRGB over ~30 px of a ~150 px form, the red coat sleeve
 * 15 → 188 over ~13 px of a ~50 px cylinder, and a 16-bin histogram of the hat
 * interior is populated in every bin — a continuous gradient with no plateau
 * pair anywhere in it.
 *
 * So 'uToonSoftness' is now the ramp's **full width in N·L** and it is close to
 * a whole unit: light wraps most of the way round the form before the surface
 * reaches its shadow level. 'uToonTerminator' is the ramp's *midpoint*, and it
 * sits near 0 — at the geometric terminator — rather than at the 0.5 the cel
 * model needed to carve out a large dark mass. A ramp this wide cannot alias and
 * cannot crawl, which is why the pixel machinery below is only a floor.
 *
 * The 'smoothstep' polynomial is spelled out rather than called so the domain
 * clamp and the S-curve are visibly separate: the clamp is what makes the ends
 * genuinely flat, and flat ends are what let 'uToonShadowDepth' state the dark
 * level as a level.
 */
float awToonDiffuse( const in float ndl ) {

  float t = clamp( uToonTerminator, -0.9, 0.9 );
  float w = max( uToonSoftness, 0.02 );
  float x = saturate( ( ndl - t ) / w + 0.5 );

  return x * x * ( 3.0 - 2.0 * x );

}

/**
 * Shape the accumulated ramp, and guarantee it never collapses to an edge.
 *
 * Two jobs, and it is worth being clear that neither is the one the function it
 * replaced ('awToonEdge') had. That function used 'fwidth' to *narrow* the
 * transition to a fixed pixel count, which is how a soft ramp becomes an ink
 * terminator. Here 'fwidth' is used in the opposite direction only.
 *
 * **Gamma.** 'uToonRampGamma' bends the ramp without moving its ends. Above 1
 * holds the shadow longer and turns into the light late, which is what a form
 * with a strong ambient occlusion gradient does; below 1 does the reverse. It is
 * the control that used to be spelled "where do I put the terminator", now that
 * there is no terminator to put.
 *
 * **The antialias floor.** A ramp already spanning hundreds of pixels needs
 * nothing, but a character at the back of the battle stage, or a tight crease on
 * a belt buckle, can compress the same ramp into one or two. 'fwidth( x )' is
 * how much the ramp moves between neighbouring pixels, so '1 / fwidth( x )' is
 * how many pixels it currently spans; where that is under 'uToonEdgePixels' the
 * ramp is re-expanded about its own midpoint by exactly the shortfall. Above the
 * threshold the scale is 1 and this costs nothing but the 'min'.
 */
float awToonResolve( const in float x ) {

  float px = max( uToonEdgePixels, 0.0 );
  float scale = px > 0.0
    ? min( 1.0, 1.0 / max( px * fwidth( x ), 1e-5 ) )
    : 1.0;

  float y = saturate( 0.5 + ( x - 0.5 ) * scale );

  return pow( y, max( uToonRampGamma, 0.05 ) );

}

/**
 * The shadow-region **albedo**: a hue shift with rising saturation.
 *
 * Kept from the previous revision, at gentler settings, because this is the one
 * thing the old model had right and the plates confirm it. The darkest skin
 * sample on 'bravely01.jpg' is RGB(151,130,123) against a lit RGB(186,155,147):
 * the channel ratios are 0.81 / 0.84 / 0.84, so the dark side is *warmer* in
 * proportion, not a uniformly scaled copy. On the garments the effect is much
 * stronger — the red coat's shadow keeps its red where a multiply would have
 * drained it to brown.
 *
 * Light alone cannot deliver that. An amber albedo has almost no blue
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

#ifdef TOON_ANISO

/**
 * A soft shoulder on a specular lobe. Never a cut.
 *
 * The previous revision ran 'smoothstep( t - w, t + w, lobe )' with 'w ≈ 0.03',
 * which turns any lobe into a flat-topped blob with a drawn edge. Nothing on the
 * reference plates has one. The armour highlights in 'bravely02.jpg' are narrow
 * *streaks* along the crowns of the greaves that fall off continuously into the
 * plate value; the hair sheens in 'bravely01.jpg' are broad and soft; the fur
 * collar has no discrete highlight at all.
 *
 * Callers outside this module have tuned 't' and 'w' against the old blob —
 * 'CharacterFactory' passes 0.55 / 0.07 for hair — and silently ignoring them
 * would throw away a real observation about where that band should sit on a
 * chibi cranium. So the threshold is honoured as the lobe value the falloff is
 * centred on, and the transition width is floored at roughly the threshold
 * itself. A caller's tuned blob becomes a tuned *falloff* in the same place,
 * which is the intent behind the number rather than the letter of it.
 */
float awToonSpecShape( const in float lobe ) {

  float t = clamp( uToonSpecThreshold, 0.0, 0.98 );
  float w = max( uToonSpecSoftness, t * 0.9 + 0.05 );

  return smoothstep( max( t - w, 0.0 ), min( t + w, 1.0 ), lobe );

}

/**
 * Kajiya-Kay with Scheuermann's tangent shift, as a bare lobe.
 *
 * Sculpted hair in this style is a carved volume, not strands, so there is no
 * tangent attribute to trust; the strand axis arrives as a world-space uniform
 * (default +Y, i.e. hair falls) and is orthogonalised against the shading normal
 * by the caller. The lobe is constant *along* the strand axis and falls off
 * *across* it, so it reads as a band running perpendicular to the strands. A
 * round dot means the tangent frame is wrong.
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
 * The brief is "fur or feather trim that does not look like hard plastic", and
 * the plate says what the difference is numerically. Adelle's black fur collar
 * in 'bravely01.jpg' measures p5 15 / p50 70 / p95 181 / max 223 sRGB, and the
 * distribution between those points is smooth and unimodal. A Blinn or GGX lobe
 * on a dark albedo gives the opposite signature — a large mass near the albedo
 * plus a small, near-clipped hot spot, with almost nothing in between — and that
 * bimodality is exactly what the eye reads as moulded plastic.
 *
 * Charlie's 'sin^(1/a)' distribution is broad and, crucially, *peaks at grazing
 * angles rather than at the mirror direction*, so the light sits on the silhouette
 * of every strand clump instead of in a spot on the front of the mass. Neubelt's
 * visibility term keeps it retro-reflective, which is what makes fur brighten
 * when the light is behind it. Both are cheap closed forms.
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
 * Both the highlight and the rim need a bound, and a hard 'min' is the wrong one
 * for either. A hard clamp is exactly a threshold: everything above the ceiling
 * lands *on* it, so a lobe that overshoots by 20x — which a normalised GGX at
 * 'roughness: 0.28' does — comes out as a flat-topped blob with a drawn edge,
 * which is the cel artefact this whole revision exists to remove. The reference
 * armour's brightest streaks clip, but they clip the way film clips: continuous
 * right up to the point where there is nothing left.
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
 * The rim — a **profile**, in 0..1. Its radiance is applied by the composite,
 * against two independent bounds; see 'TOON_SURFACE_COMPOSITE'.
 *
 * Search the reference plates for a rim and what you find is: nothing
 * attributable to one. Every bright silhouette band on 'bravely01.jpg' resolves
 * to albedo when you look at what is actually there — Gloria's shoulder reads
 * 172 against a 28 bodice because she is wearing a white collar; Elvis's
 * shoulder reads 164 because he is wearing a grey mantle. On the sun-facing
 * right edge of his coat the surface goes the *other* way, 188 → 181 → 167 →
 * 159 → 136 → 99 → 69 → 41 into the background: it darkens toward the
 * silhouette, with no lift at the edge at all.
 *
 * The rim is nonetheless required by the brief as a separation device against a
 * fog-coloured background, so it stays — but it stays as a whisper, and this
 * function's job is only to say *where*. The previous revision's pixel-width
 * clamp is gone: it existed to keep the rim thinner than the ink outline it was
 * competing with, and it was competing because it was bright enough to be a
 * line. Bound the radiance instead (see 'uToonRimMax') and the width stops being
 * the thing holding the defect back.
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
