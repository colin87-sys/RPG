/**
 * toonCommon.js — the GLSL vocabulary of the character shading model.
 *
 * REFERENCE_TARGET §1 describes the characters as "soft cel / toon-adjacent,
 * not full PBR: a broad lit region, a soft terminator, a coloured shadow region,
 * and — critically — a bright rim/back light separating them from the background
 * in every frame." Those four clauses map one-to-one onto the four functions
 * below, and nothing else in this file exists.
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
uniform float uToonSoftness;
uniform float uToonWrap;

uniform vec3  uToonShadowDeep;
uniform vec3  uToonShadowWarm;
uniform float uToonShadowGain;
uniform float uToonShadowWarmSpan;

uniform vec3  uToonSubsurface;
uniform float uToonSubsurfaceWidth;

uniform vec3  uToonSpecColor;
uniform float uToonSpecGain;
uniform float uToonSpecExponent;
uniform float uToonSpecThreshold;
uniform float uToonSpecSoftness;

uniform float uToonRimPower;
uniform float uToonRimGain;
uniform vec2  uToonRimFocus;
uniform vec2  uToonRimShape;

uniform vec3  uToonPulse;
uniform float uToonPulseRate;
uniform float uToonTime;

#ifdef TOON_ANISO
  uniform vec3  uToonAnisoDirection;
  uniform float uToonAnisoShift;
#endif

#ifdef TOON_RAMP_MAP
  uniform sampler2D uToonRamp;
#endif
`;

/**
 * The four shading primitives.
 *
 * Every one of them is written to be safe at its domain edges, because they are
 * evaluated per light per fragment on a material that will be on screen in
 * literally every frame of the game — a NaN here is not a rare artefact, it is
 * a black character.
 */
export const TOON_FUNCTIONS_GLSL = /* glsl */ `

/**
 * Quantise a 0..1 shading coordinate into 'uToonBands' plateaus joined by
 * smooth-stepped terminators.
 *
 * The terminator is placed at the *centre* of each band rather than at its
 * edge, so 'uToonSoftness' widens the transition symmetrically into the two
 * neighbouring plateaus instead of eating one of them. At softness 1.0 the
 * plateaus vanish entirely and the function degenerates to a smooth ramp, which
 * is the correct behaviour for a "how banded do you want this" control — art
 * gets a continuous dial from cel to soft rather than a cliff.
 *
 * Softness is floored at 0.03 because a step narrower than that aliases: the
 * terminator crosses a whole band inside one pixel's screen-space derivative
 * and crawls under camera motion, which is the exact defect REFERENCE_TARGET
 * §1 is warning against with "soft terminator, not hard steps".
 */
float awToonBand( const in float x ) {

  float bands = max( uToonBands, 1.0 );
  float s = clamp( x, 0.0, 1.0 ) * bands;
  float i = floor( s );
  float half_ = clamp( uToonSoftness, 0.03, 1.0 ) * 0.5;

  return ( i + smoothstep( 0.5 - half_, 0.5 + half_, s - i ) ) / bands;

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
 * The shadow colour ramp — ART_BIBLE §2.1's shadow rule, expressed as a
 * gradient rather than a constant.
 *
 * A shadow that is one flat colour reads as a sticker; a shadow that is a
 * darkened copy of albedo reads as dirt. Real shade is a *gradient*, warm where
 * bounce light is still reaching the surface just past the terminator and cool
 * in the mass where only sky reaches it. 'uToonShadowWarm' carries
 * 'BOUNCE_GROUND''s chroma and 'uToonShadowDeep' carries 'SHADOW_TINT''s, both
 * pre-normalised to unit luminance on the CPU so this mix moves hue only and
 * cannot accidentally change the character's exposure.
 */
vec3 awToonShadowColor( const in float lit ) {

  return mix( uToonShadowDeep, uToonShadowWarm,
              smoothstep( 0.0, max( uToonShadowWarmSpan, 1e-3 ), lit ) );

}

/**
 * The mandatory rim.
 *
 * Two terms multiplied, and the second one is the whole point. A bare
 * 'pow( 1 - N·V, k )' haloes a character uniformly and reads as a force field;
 * weighting it by how much the surface faces the rim light concentrates it on
 * the back-lit edge, which is what the reference frames actually show and what
 * gives the silhouette a light *direction* instead of a glow.
 *
 * The product is then smooth-stepped a second time. That is not redundant with
 * the first 'pow': 'pow' alone produces a long low-amplitude tail that creeps
 * across the whole facing side and greys it out, while the window collapses the
 * tail to zero and holds the band tight to the edge without hardening it into
 * an ink line. Feed it a wide 'uToonRimShape' and it stays soft — which is the
 * requirement, the reference has soft edges, not outlines.
 */
float awToonRim( const in vec3 n, const in vec3 v, const in vec3 rimDirView ) {

  float fresnel = pow( 1.0 - saturate( dot( n, v ) ), max( uToonRimPower, 0.5 ) );
  float focus = smoothstep( uToonRimFocus.x, uToonRimFocus.y, dot( n, rimDirView ) );

  return smoothstep( uToonRimShape.x, uToonRimShape.y, fresnel * focus );

}
`;
