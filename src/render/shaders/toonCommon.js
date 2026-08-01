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
uniform float uToonShadowFloor;
uniform float uToonShadowLift;

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
 * The mandatory rim.
 *
 * Two terms multiplied. A bare 'pow( 1 - N·V, k )' haloes a character uniformly
 * and reads as a force field; weighting it by how much the surface faces the rim
 * light concentrates it on the back-lit edge, which is what the reference frames
 * actually show and what gives the silhouette a light *direction* instead of a
 * glow.
 *
 * The directional weight is floored rather than allowed to reach zero, and that
 * floor is load-bearing. With a pure directional weight the rim exists only
 * where the rig's rim vector happens to point — in a dusk rig that is the upper
 * hemisphere, so the band lands on the top of the cranium and the lower body
 * dissolves into dark ground. REFERENCE_TARGET §1 asks for the rim to separate
 * the character "from the background in every frame", i.e. around the whole
 * silhouette; the floor supplies that continuous edge while the directional term
 * still rides on top of it and carries the light's direction.
 *
 * The product is then smooth-stepped a second time. That is not redundant with
 * the first 'pow': 'pow' alone produces a long low-amplitude tail that creeps
 * across the whole facing side and greys it out, while the window collapses the
 * tail to zero and holds the band tight to the edge.
 */
float awToonRim( const in vec3 n, const in vec3 v, const in vec3 rimDirView ) {

  float fresnel = pow( 1.0 - saturate( dot( n, v ) ), max( uToonRimPower, 0.5 ) );
  float focus = smoothstep( uToonRimFocus.x, uToonRimFocus.y, dot( n, rimDirView ) );
  focus = mix( clamp( uToonRimFloor, 0.0, 1.0 ), 1.0, focus );

  return smoothstep( uToonRimShape.x, uToonRimShape.y, fresnel * focus );

}
`;
