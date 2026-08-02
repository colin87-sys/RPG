/**
 * toonCommon.js — the GLSL vocabulary of the character shading model.
 *
 * ANIME_PIPELINE §2 is the whole specification, and it is a correction of what
 * this file used to contain. The previous model was a *soft* cel ramp: a wide
 * terminator (0.08–0.10 in N·L), extra "core shadow" steps subdividing the dark
 * side, a subsurface wrap bleeding across the terminator, and a shadow built by
 * lerping the albedo toward a tint. Every one of those softens the one edge the
 * style depends on, and the sum of them is a smooth falloff with contours in it
 * — which reads as PBR, which is what the review called it.
 *
 * The replacement is literal:
 *
 *  1. **Two bands.** One `smoothstep( t - w, t + w, N·L )` at `t ≈ 0.5` with
 *     `w ≈ 0.03–0.06`. Nothing subdivides the shadow. A third band is available
 *     *above* the terminator — a brighter plateau on the lit side, for hair and
 *     metal only — because that is the one extra band the idiom actually uses.
 *     The per-light band positions the edge; `awToonEdge` then resolves the
 *     accumulated result to a **fixed pixel width**, which is what makes it an
 *     edge on a large smooth form rather than a three-hundred-pixel wash.
 *  2. **The shadow is a hue shift with rising saturation**, not a multiply.
 *     `awToonShadowAlbedo` decomposes the albedo into chroma and value, rotates
 *     the chroma toward the shadow tint, scales HSV saturation *up*, and drops
 *     value only slightly. A darkened copy of the albedo is the single most
 *     common way cel shading looks cheap; this function is the reason we do not
 *     have one.
 *  3. **Specular is a thresholded blob**, isotropic Blinn-Phong or Kajiya-Kay
 *     across a strand axis, gated by the cel band so it cannot survive one pixel
 *     past the terminator.
 *  4. **The face resists shadowing.** `uToonShadowFloor` clamps the banded light
 *     term from below so a fringe or a nose never carves the face into darkness.
 *     Applied in the composite rather than here, because the floor has to lift
 *     *cast* shadows too, and a cast shadow has already been multiplied into
 *     `directLight.color` before this file sees it.
 *
 * There is deliberately **no ramp texture and no noise of any kind**. A ramp
 * lookup is a gradient by construction, which is the failure mode; and
 * ANIME_PIPELINE's absolute rule is that no procedural noise ever touches a
 * character surface.
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
 *    it. Renaming any of these silently decouples the two.
 *  - `uToon*` are per-material art controls. They are never shared.
 *
 * `uKeyColor` and `uRimColor` arrive premultiplied by their light's intensity;
 * that is the rig's convention and the shader does not second-guess it.
 * `uKeyColor` carries a second job here — it is the radiance the face-flattening
 * fill is paid in, so a flattened face brightens and cools with the time of day
 * instead of sitting under a fixed studio light.
 */
export const TOON_UNIFORMS_GLSL = /* glsl */ `
uniform vec3  uKeyColor;
uniform vec3  uRimDirection;
uniform vec3  uRimColor;
uniform float uRimStrength;

uniform float uToonTerminator;
uniform float uToonSoftness;
uniform float uToonEdgePixels;
uniform float uToonShadowFloor;
uniform float uToonShadowLift;
uniform float uToonShadowCeiling;

uniform vec3  uToonShadowTint;
uniform float uToonShadowHue;
uniform float uToonShadowSat;
uniform float uToonShadowValue;
uniform float uToonShadowSatFloor;

uniform vec3  uToonShadowFill;
uniform float uToonShadowGain;
uniform float uToonAmbientGain;
uniform float uToonMetalAlbedo;
uniform float uToonEnvSpecular;

uniform float uToonRimPower;
uniform float uToonRimGain;
uniform vec2  uToonRimFocus;
uniform vec2  uToonRimShape;
uniform float uToonRimFloor;
uniform float uToonRimWidth;
uniform float uToonRimPixels;
uniform float uToonRimCeiling;

uniform vec3  uToonPulse;
uniform float uToonPulseRate;
uniform float uToonTime;

#ifdef TOON_LIT_BAND
  uniform float uToonLitBandThreshold;
  uniform float uToonLitBandGain;
#endif

#ifdef TOON_SPECULAR
  uniform vec3  uToonSpecColor;
  uniform float uToonSpecGain;
  uniform float uToonSpecExponent;
  uniform float uToonSpecThreshold;
  uniform float uToonSpecSoftness;
  uniform float uToonSpecAlbedoMix;
#endif

#ifdef TOON_ANISO
  uniform vec3  uToonAnisoDirection;
  uniform float uToonAnisoShift;
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
 * The cel terminator: N·L in, 0 or 1 out, with one narrow transition.
 *
 * ANIME_PIPELINE §2: 'smoothstep( t - w, t + w, N·L )' with 't ≈ 0.5' and
 * 'w ≈ 0.03–0.06'. Both numbers matter and both are counter-intuitive.
 *
 * 't ≈ 0.5' rather than 0 puts the edge at 60° off the light axis, well *inside*
 * the geometric terminator. That is what makes a cel character read as drawn:
 * the dark side is a large, deliberately-shaped mass that follows the light
 * direction, not a thin crescent hugging the silhouette. Placing the edge at the
 * geometric terminator — the intuitive choice, and what this file did before —
 * leaves the shadow as a rim of dark around the outside, which is exactly what
 * a soft Lambert falloff looks like once it is clamped.
 *
 * 'w' is the *full* width of the edge in N·L, so the brief's number is literally
 * what an author types. It is floored a hair above zero for two reasons:
 * 'smoothstep' with equal edges is undefined, and an edge narrower than a
 * pixel's screen-space derivative crawls and shimmers under animation. It must
 * never be widened "to look smoother" — a wide ramp is the failure this whole
 * file is a correction of.
 */
float awToonBand( const in float ndl ) {

  float t = clamp( uToonTerminator, -0.95, 0.95 );
  float w = max( uToonSoftness, 0.008 ) * 0.5;

  return smoothstep( t - w, t + w, ndl );

}

/**
 * Resolve an accumulated band into **one edge that is a fixed number of pixels
 * wide**, wherever it lands on the surface.
 *
 * This is the correction the review demanded, and it is a change of technique
 * rather than of constants. 'awToonBand' states the edge's width in N·L, and a
 * width in N·L is not a width on screen: the same 0.05 is a two-pixel line
 * across a chibi forearm, where the normal swings through a right angle in
 * twenty pixels, and a *three-hundred*-pixel wash across a shoulder pauldron in
 * a close-up, where it swings through the same angle over half the frame. The
 * review measured exactly that — "the closeup's cheek ramps from ~240 to ~180
 * across 300 px with no edge" — and no value of 'uToonSoftness' fixes it,
 * because the largest, smoothest, most prominent forms in frame are precisely
 * the ones where an angular width resolves to the widest gradient.
 *
 * 'fwidth( x )' is how much the banded term moves between neighbouring pixels,
 * so 'uToonEdgePixels * fwidth( x )' is the threshold half-width that spans
 * exactly that many pixels here — on a flat cheek and on a tight knuckle alike.
 * One pixel is the floor at which a step still antialiases rather than crawling
 * under animation, and 1.2–1.5 is what a drawn ink terminator measures.
 *
 * The absolute floor guards the degenerate case: a facet whose banded term is
 * constant has a zero derivative, and a zero-width 'smoothstep' is undefined.
 * There is no edge to draw there, so any positive width gives the same answer.
 */
float awToonEdge( const in float x, const in float threshold ) {

  float w = max( uToonEdgePixels * fwidth( x ), 1e-4 );

  return smoothstep( threshold - w, threshold + w, x );

}

#ifdef TOON_LIT_BAND

/**
 * The optional third band, on the **lit** side.
 *
 * ANIME_PIPELINE §2 permits exactly one extra band and puts it above the
 * terminator, for hair and metal only. It reads as the plane of the form that
 * turns most directly into the key — the pale crown of a hair mass, the flat of
 * a pauldron — and it is what stops a two-band metal from looking like flat
 * paper between its highlights.
 *
 * Returns 0 or 1; the caller scales it. Its edge shares the terminator's width
 * so the two bands are the same kind of line.
 */
float awToonLitBand( const in float ndl ) {

  float t = clamp( uToonLitBandThreshold, -0.9, 0.99 );
  float w = max( uToonSoftness, 0.008 ) * 0.5;

  return smoothstep( t - w, t + w, ndl );

}

#endif

/**
 * The shadow-region **albedo** — ANIME_PIPELINE §2's central rule.
 *
 * "Shadow colour is a hue shift, not a multiply. Shift toward the scene's shadow
 * tint and *increase* saturation slightly as value drops. A darkened copy of
 * albedo is the single most common way cel shading looks cheap."
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
 *     nothing else. 'k > 1' is the point — a shadow that is *more* chromatic
 *     than its light is the difference between painted and dimmed.
 *  3. **Value, downward, and only slightly.** The bulk of the value drop belongs
 *     to the lighting (the shadow band simply receives less light); doing it
 *     twice is how a cel shadow turns into a hole.
 *
 * The saturation floor at the end guards a specific trap. A straight hue mix
 * from a warm albedo to a cool tint passes *through* the neutral axis, and for
 * skin tones the crossing sits near mix ≈ 0.5 — within a hair of the value the
 * art direction asks for. Ship the obvious implementation at the obvious number
 * and the shadow side of every face eyedrops as grey, which ART_BIBLE §2.1
 * forbids by name. The guard spends part of the *remaining* distance to the tint
 * when the result comes up short: forward, never back toward the albedo, because
 * retreating lands on the same neutral from the other side.
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
 * Quantise a radiance into flat plates.
 *
 * Used on the environment probe for metal only. REFERENCE_TARGET §1: "metal
 * (armour, blades) reads through a hard specular band rather than environment
 * reflection" — but armour that ignores the world entirely reads as painted
 * cardboard, so the probe is kept and its continuous gradient is stepped
 * instead. Quantising the *level* and rescaling the colour keeps the reflected
 * hue intact while the value lands on three plates, which is how a cel-painted
 * pauldron is drawn.
 */
vec3 awToonPlate( const in vec3 c ) {

  float y = max( max3( c ), 1e-5 );
  float s = y * 3.0;
  float q = ( floor( s ) + smoothstep( 0.35, 0.65, fract( s ) ) ) / 3.0;

  return c * ( q / y );

}

/**
 * The mandatory rim — a **profile**, in 0..1. Its radiance is applied by the
 * composite, against a ceiling; see 'TOON_SURFACE_COMPOSITE'.
 *
 * Three terms, and the order they combine in is the correction this function
 * carries. The previous arrangement windowed 'fresnel * focus' together, which
 * produced the defect the review named: character edges clipping to flat white
 * in a band wide enough to read as a second outline drawn beside the ink one.
 * Two separate mechanisms put it there.
 *
 * **Width.** 'pow( 1 - N·V, k )' has no width control. Where its tail drops
 * below the window's lower edge is decided jointly by 'k' and by that edge, and
 * at the exponent this project actually runs — 'Lighting.RIM_CONTRACT' floors it
 * at 3 and 'CharacterFactory.BODY_RIM' pins it there — the tail is still above
 * the window across the outer *fifth* of a chibi silhouette's radius. That is a
 * slab, not a rim. So the grazing term is remapped first: 'uToonRimWidth' states
 * the band's inner edge directly, in N·V, and the exponent then shapes the
 * falloff *inside* the band instead of deciding how far it reaches. A width of 1
 * reproduces the bare fresnel exactly, which is what the classes that genuinely
 * want a broad wrap (glass) are given.
 *
 * **The floor.** The directional weight is floored rather than allowed to reach
 * zero, and that floor is load-bearing: with a pure directional weight the rim
 * exists only where the rig's rim vector points — in a dusk rig, the upper
 * hemisphere — so the band lands on the crown and the lower body dissolves into
 * dark ground, while REFERENCE_TARGET section 1 wants the character separated
 * from the background *around the whole silhouette*. But folding the floor
 * inside the window made it useless as a dimmer: at 'floor = 0.55' the product
 * still reached the window's upper edge wherever the fresnel saturated, so the
 * wrap came out at the same full brightness as the back-lit edge and the
 * direction the focus term exists to carry was invisible. Windowing the fresnel
 * alone and letting the focus *scale* the result restores it — the wrap is now
 * literally 'floor' times the lit edge — and it is also the shape
 * 'Lighting.RIM_CONTRACT' names as its target: 'pow( 1 - N·V, k )' weighted by
 * 'N·L_rim'.
 *
 * The window itself is not redundant with the 'pow': 'pow' alone leaves a long
 * low-amplitude tail creeping across the facing side, and the window collapses
 * that tail to exactly zero.
 *
 * **The width is finally clamped in pixels, and that is the defect this
 * function was rewritten for.** 'uToonRimWidth' states the band's reach in N·V,
 * which is a fraction of the *subject's own projected radius*: the identical
 * uniform that puts a ~1 px sheen on a chibi hand puts a 5-6 px band around a
 * boss that fills half the frame. At the radiance the rig solves the character
 * rim to, a saturated teal band that wide, wrapping the contour, simply *is* the
 * silhouette line — drawn in light instead of in ink — and it buries the 2 px
 * inverted hull underneath it. That is the review's "bright cyan-white line
 * where the ink outline should be", and no amount of retuning the exponent fixes
 * it, because the exponent has never had a screen-space term in it.
 *
 * So the reach is converted into pixels the same way the outline's is:
 * 'fwidth( N·V )' is how much the grazing term moves per pixel here, so
 * 'uToonRimPixels * fwidth( N·V )' is the reach that spans exactly that many
 * pixels, whatever the subject's size or distance. Taking the *tighter* of the
 * two keeps 'uToonRimWidth' meaningful as an art ceiling on a close-up, while
 * guaranteeing the rim can never outweigh the ink line it sits inside. A
 * non-positive 'uToonRimPixels' disables the clamp, which is what the one class
 * that genuinely wants a broad wrap (glass, where the fresnel *is* the material)
 * is given.
 */
float awToonRim( const in vec3 n, const in vec3 v, const in vec3 rimDirView ) {

  float grazing = saturate( dot( n, v ) );

  float span = max( uToonRimWidth, 1e-3 );
  if ( uToonRimPixels > 0.0 ) {
    // 'fwidth' is floored because a surface facing the camera dead-on has no
    // silhouette here and a zero derivative would divide the band to nothing —
    // which is correct, but must not become a NaN on the way.
    span = max( min( span, uToonRimPixels * max( fwidth( grazing ), 1e-5 ) ), 1e-4 );
  }

  float edge = saturate( ( span - grazing ) / span );
  float fresnel = pow( edge, max( uToonRimPower, 0.5 ) );

  float band = smoothstep( uToonRimShape.x, uToonRimShape.y, fresnel );
  float facing = smoothstep( uToonRimFocus.x, uToonRimFocus.y, dot( n, rimDirView ) );

  return band * mix( clamp( uToonRimFloor, 0.0, 1.0 ), 1.0, facing );

}
`;
