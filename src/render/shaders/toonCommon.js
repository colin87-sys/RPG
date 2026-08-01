/**
 * toonCommon.js — the GLSL vocabulary of the character shading model.
 *
 * REFERENCE_TARGET §1 describes the characters as "soft cel / toon-adjacent,
 * not full PBR: a broad lit region, a soft terminator, a coloured shadow region,
 * and — critically — a bright rim/back light separating them from the background
 * in every frame." Those four clauses are the whole specification, and the
 * functions below exist one per clause.
 *
 * The word doing the most work in that sentence is **region**. A cel ramp is not
 * "a gradient with steps in it": it is a large flat plateau at full key, one
 * decisive edge, and a second flat plateau whose *colour is different*, not
 * merely darker. Quantising N·L into equal-width bands across 0..1 — the
 * obvious implementation, and the one this file used to carry — produces
 * neither, because the top plateau then only begins around N·L ≈ 0.9, i.e. a
 * sliver at the light-facing pole, and everything a camera actually sees is
 * mid-band gradient. `awToonBand` therefore places the terminator explicitly, in
 * N·L, and treats the band count as a subdivision of the *shadow* alone.
 *
 * The second half of the correction is `awToonShadowAlbedo`. A shadow built by
 * multiplying albedo can only ever travel toward black along the albedo's own
 * hue line, which is the "darkened desaturated albedo" the reference never has;
 * ART_BIBLE §2.1 requires the shadow region to land within ±8° of `SHADOW_TINT`
 * (hue ≈ 206°) with saturation ≥ 0.15, and the only way to get there is to shift
 * the surface colour itself before it is lit.
 *
 * These are exported as source strings rather than registered into
 * `THREE.ShaderChunk`, for the same reason `postCommon.js` and `skyCommon.js`
 * made that call: the chunk registry is process-global state shared with every
 * stock material in the engine, and `render/Lighting.js` already has to work
 * around one addon (CSM) that mutates it. Adding a second mutator would make
 * the order in which two unrelated modules happen to be imported a rendering
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
 */
export const TOON_UNIFORMS_GLSL = /* glsl */ `
uniform vec3  uKeyColor;
uniform vec3  uRimDirection;
uniform vec3  uRimColor;
uniform float uRimStrength;

uniform float uToonBands;
uniform float uToonTerminator;
uniform float uToonSoftness;
uniform float uToonBandSpacing;
uniform float uToonShadowStep;
uniform float uToonCoreStep;

uniform vec3  uToonShadowDeep;
uniform vec3  uToonShadowWarm;
uniform float uToonShadowGain;
uniform float uToonShadowWarmSpan;
uniform vec3  uToonShadowAlbedo;
uniform float uToonShadowMix;
uniform float uToonShadowSatFloor;

uniform vec3  uToonSubsurface;
uniform float uToonSubsurfaceWidth;

uniform float uToonEnvSpecular;

uniform float uToonRimPower;
uniform float uToonRimGain;
uniform vec2  uToonRimFocus;
uniform vec2  uToonRimShape;
uniform float uToonRimFloor;

uniform vec3  uToonPulse;
uniform float uToonPulseRate;
uniform float uToonTime;

#ifdef TOON_SPECULAR
  uniform vec3  uToonSpecColor;
  uniform float uToonSpecGain;
  uniform float uToonSpecExponent;
  uniform float uToonSpecThreshold;
  uniform float uToonSpecSoftness;
#endif

#ifdef TOON_ANISO
  uniform vec3  uToonAnisoDirection;
  uniform float uToonAnisoShift;
#endif

#ifdef TOON_RAMP_MAP
  uniform sampler2D uToonRamp;
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
 * The cel ramp: N·L in, a plateau value in 0..1 out.
 *
 * The terminator is an explicit position in N·L rather than a by-product of the
 * band count, and that is the correction this whole file turns on. Slicing
 * 0..1 into 'uToonBands' equal plateaus puts the topmost step at N·L ≈ 1 − 1/2n,
 * so at three bands the "fully lit" plateau does not begin until N·L ≈ 0.89 —
 * about 27° off the light axis. On an oversized chibi cranium that is a coin-
 * sized patch, and every other pixel of the head is mid-band gradient, which is
 * indistinguishable from a soft Lambert falloff. Pinning the step near N·L = 0
 * instead gives the reference's actual structure: most of the visible surface at
 * one flat value, one decisive edge, and detail only *inside* the shadow.
 *
 * 'uToonSoftness' is the full width of that edge measured in N·L, so the brief's
 * "~0.08 wide" is literally the number an author types. It is floored rather
 * than allowed to reach zero because 'smoothstep' with equal edges is undefined,
 * and an edge narrower than a pixel's screen-space derivative crawls under
 * animation — the defect REFERENCE_TARGET §1 warns about with "soft terminator".
 *
 * Extra bands subdivide the shadow side only. A step placed *above* the
 * terminator would cut the lit plateau back into a gradient and undo the point
 * of the function; a step below it is a core shadow, which is what a painter
 * would add and what the reference frames show under a jaw or inside a hood.
 */
float awToonBand( const in float ndl ) {

  float t = clamp( uToonTerminator, -0.95, 0.95 );
  float w = max( uToonSoftness, 0.012 ) * 0.5;

  // The one edge that matters. Above it: flat, full key, no structure.
  float lit = smoothstep( t - w, t + w, ndl );

  // Core-shadow steps, stacked downward from the terminator. The 2.1 spacing
  // ratio (rather than 2.0) keeps the two edges from landing on the same
  // screen-space contour on a sphere, where evenly spaced N·L steps compress
  // into a visible pair of concentric rings near the silhouette.
  float gap = max( uToonBandSpacing, 0.04 );
  float s1 = smoothstep( t - gap - w, t - gap + w, ndl );
  float s2 = smoothstep( t - gap * 2.1 - w, t - gap * 2.1 + w, ndl );

  float three = step( 2.5, uToonBands );
  float four = step( 3.5, uToonBands );

  float shade = uToonShadowStep
    + three * uToonCoreStep * s1
    + four * uToonCoreStep * 0.45 * s2;

  return mix( min( shade, 1.0 ), 1.0, lit );

}

/**
 * The chromatic half of the ramp: what *colour* the key light becomes as it
 * falls off, independent of how much of it there is.
 *
 * The value axis is deliberately not read from the ramp texture. 'Palette''s
 * 'toonRamp' bakes its own value curve (0.40 at the dark end so a toon shadow
 * never kills the silhouette), and if both the texture and 'awToonBand' were
 * allowed to shape value they would fight: changing the band count would also
 * change the overall brightness of the character, which makes the two controls
 * uncombinable. Normalising the sample to unit maximum strips the texture's
 * value and keeps its hue and saturation — exactly the "shadow gradient" knob
 * AssetForge's 'ramp-toon' is there to provide.
 */
vec3 awToonTint( const in float lit ) {

  #ifdef TOON_RAMP_MAP

    vec3 c = texture2D( uToonRamp, vec2( clamp( lit, 0.0, 1.0 ), 0.5 ) ).rgb;

  #else

    // Analytic stand-in with the same shape: cool at the dark end, neutral at
    // the lit end, arriving late (squared) so the darkest band commits to the
    // shadow tint rather than sitting at a wishy-washy midpoint.
    vec3 c = mix( uToonShadowDeep, vec3( 1.0 ), lit * lit );

  #endif

  return c / max( max3( c ), 1e-4 );

}

/**
 * The shadow-region **albedo** — ART_BIBLE §2.1's shadow rule applied where it
 * can actually be obeyed.
 *
 * Light cannot make a surface a different hue than its own reflectance allows.
 * Multiply an amber-skin albedo by any amount of teal ambient and the result is
 * still a duller amber, because the surface has almost no blue reflectance to
 * modulate — which is precisely why a "tinted shadow" built as a light term
 * eyedrops as a darker desaturated copy of the albedo. The fix has to happen one
 * step earlier: the shading albedo itself shifts toward 'SHADOW_TINT' inside the
 * shadow band, exactly as a painter mixes the shadow colour on the palette
 * rather than glazing it over the light colour.
 *
 * The tint target carries 'SHADOW_TINT''s chromaticity scaled to the albedo's own
 * peak channel, so the mix moves hue and leaves value to 'awToonBand' — keeping
 * the two controls independent, which is the same separation 'awToonTint' and
 * 'Palette.toonRamp' make for the same reason.
 *
 * The saturation guard at the end is not optional, and the reason is a trap
 * worth spelling out. A straight lerp from a warm albedo to a cool tint passes
 * *through* the neutral axis, and for skin tones the crossing sits at mix ≈ 0.52
 * — within a hair of the value the art direction actually asks for. Ship the
 * obvious implementation at the obvious number and the shadow side of every face
 * eyedrops as grey, which is the one thing §2.1 forbids by name. The guard
 * measures the result and spends part of the *remaining* distance to the tint
 * when it comes up short: forward, never back toward the albedo, because
 * retreating lands on the same neutral from the other side. The presets carry
 * mixes past the crossing so the guard is normally inert; it is there so that an
 * author picking a mix cannot silently reintroduce the defect.
 */
vec3 awToonShadowAlbedo( const in vec3 base ) {

  float v = max3( base );
  vec3 tinted = uToonShadowAlbedo * v;
  vec3 shade = mix( base, tinted, clamp( uToonShadowMix, 0.0, 1.0 ) );

  float sv = max3( shade );
  float sat = ( sv - awMin3( shade ) ) / max( sv, 1e-4 );
  float need = max( uToonShadowSatFloor, 1e-3 );
  float k = clamp( ( need - sat ) / need, 0.0, 1.0 );

  return mix( shade, tinted, k );

}

/**
 * The shadow *light* gradient, layered over the shifted albedo.
 *
 * A shadow that is one flat colour reads as a sticker. Real shade is a
 * gradient, warm where bounce light is still reaching the surface just past the
 * terminator and cool in the mass where only sky reaches it.
 * 'uToonShadowWarm' carries 'BOUNCE_GROUND''s chroma and 'uToonShadowDeep'
 * carries 'SHADOW_TINT''s, both pre-normalised to a chosen luminance on the CPU
 * so this mix moves hue only and cannot accidentally change exposure.
 */
vec3 awToonShadowColor( const in float lit ) {

  return mix( uToonShadowDeep, uToonShadowWarm,
              smoothstep( 0.0, max( uToonShadowWarmSpan, 1e-3 ), lit ) );

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
 * dissolves into dark ground. §1 asks for the rim to separate the character
 * "from the background in every frame", i.e. around the whole silhouette; the
 * floor supplies that continuous edge while the directional term still rides on
 * top of it and carries the light's direction.
 *
 * The product is then smooth-stepped a second time. That is not redundant with
 * the first 'pow': 'pow' alone produces a long low-amplitude tail that creeps
 * across the whole facing side and greys it out, while the window collapses the
 * tail to zero and holds the band tight to the edge without hardening it into
 * an ink line.
 */
float awToonRim( const in vec3 n, const in vec3 v, const in vec3 rimDirView ) {

  float fresnel = pow( 1.0 - saturate( dot( n, v ) ), max( uToonRimPower, 0.5 ) );
  float focus = smoothstep( uToonRimFocus.x, uToonRimFocus.y, dot( n, rimDirView ) );
  focus = mix( clamp( uToonRimFloor, 0.0, 1.0 ), 1.0, focus );

  return smoothstep( uToonRimShape.x, uToonRimShape.y, fresnel * focus );

}
`;
