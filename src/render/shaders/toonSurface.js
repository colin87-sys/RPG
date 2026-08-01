/**
 * toonSurface.js — the three GLSL blocks that turn a stock
 * `MeshStandardMaterial` into the character shading model.
 *
 * ## Why patch the standard material instead of writing a ShaderMaterial
 *
 * The brief allows either. A hand-written `ShaderMaterial` would have to
 * re-implement, correctly and forever: cascaded shadow selection (`render/
 * Lighting.js` drives `three/examples/jsm/csm/CSM.js`, which swaps
 * `ShaderChunk.lights_fragment_begin` out from under every lit material in the
 * process), skinning, morph targets, `FogExp2`, PMREM environment maps, tone
 * mapping and output colour space. Every one of those is a place where the
 * character would silently diverge from the environment it stands in — and
 * "characters lit differently from the world" is the specific failure this
 * material exists to *avoid* being an accident of.
 *
 * So instead the physical BRDF is replaced and nothing else is. Three
 * injections, chosen because they are the only three points that survive CSM
 * having already rewritten the lighting chunks:
 *
 *  1. after `<lights_physical_pars_fragment>` — declare uniforms and helpers,
 *     define `RE_Direct_Toon`, and repoint the `RE_Direct` macro at it. CSM's
 *     replacement chunk calls `RE_Direct` by macro, so cascade selection,
 *     cascade fading and shadow sampling all keep working untouched and the
 *     toon response is what they feed.
 *  2. after `<lights_physical_fragment>` — reset the per-fragment accumulator.
 *     This chunk is the last thing before the lighting loop and CSM does not
 *     touch it.
 *  3. after `<lights_fragment_end>` — composite the terms that must be
 *     evaluated once per fragment rather than once per light: the tinted
 *     shadow gradient and the rim. Placing it here and not later means
 *     `<aomap_fragment>` still occludes the shadow fill, which is right; the
 *     rim goes into `directSpecular`, which AO does not touch, which is also
 *     right — a rim is a grazing highlight, not bounce.
 *
 * `RE_IndirectDiffuse` and `RE_IndirectSpecular` are left as the physical
 * implementations on purpose. That is what keeps the hemisphere fill (whose sky
 * colour Lighting has already forced inside ART_BIBLE §2.1's hue window) and
 * the PMREM probe reaching the character at all, and it is why a scene setting
 * `scene.environment` improves this material instead of breaking it.
 *
 * OWNED BY: render/ToonMaterial.js.
 */
import { TOON_UNIFORMS_GLSL, TOON_FUNCTIONS_GLSL } from './toonCommon.js';

/** Injection 1: uniforms, helpers, the toon BRDF, and the macro swap. */
export const TOON_SURFACE_PARS = /* glsl */ `
// ---- AETHERWIND toon character model -------------------------------------
${TOON_UNIFORMS_GLSL}
${TOON_FUNCTIONS_GLSL}

/**
 * Peak banded key-light visibility at this fragment: 1 where the key lands
 * unobstructed, 0 on the unlit side *or* inside a cast shadow. Written by
 * `RE_Direct_Toon` for every light, consumed once after the lighting loop.
 *
 * A global rather than an out-parameter because `RE_Direct`'s signature is
 * fixed by three and by CSM's replacement chunk; changing it would mean
 * reimplementing both.
 */
float awToonLit;

void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  float ndl = dot( geometryNormal, directLight.direction );

  // Wrap *before* banding. Wrapping afterwards would slide the finished ramp
  // along the surface, which moves the terminator without widening the lit
  // region; it is the width of the lit region that keeps an oversized chibi
  // head from going dead on its shadow side, so the remap has to happen in the
  // coordinate the bands are cut from.
  float lit = awToonBand( saturate( ( ndl + uToonWrap ) / ( 1.0 + uToonWrap ) ) );

  // How much of the key's radiance actually arrived here.
  //
  // For every cascade light this ratio *is* the shadow factor, exactly: the rig
  // drives all cascades at one colour and one intensity and publishes that
  // product as `uKeyColor`, so dividing the post-shadow radiance by it recovers
  // the scalar the shadow map returned. For a dimmer light (the rim, a torch)
  // it degrades to that light's share of the key, which is the correct weight
  // for a term whose only question is "is this pixel lit". Recovering it here
  // is what lets the shadow be *tinted* below instead of multiplied to black:
  // the shading needs to know a surface is shadowed, not merely that it is dark.
  float share = saturate( max3( directLight.color ) / max( max3( uKeyColor ), 1e-4 ) );
  awToonLit = max( awToonLit, lit * share );

  // Banded diffuse. The band supplies the value, the ramp supplies the hue, and
  // `directLight.color` supplies the light's own colour and its shadowing —
  // three separable inputs, which is what makes this tunable rather than fiddly.
  vec3 irradiance = directLight.color * lit * awToonTint( lit );
  reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );

  // Subsurface wrap: a warm band straddling the terminator, unbanded so it
  // reads as light *bleeding* through rather than as a fourth cel step. This is
  // ART_BIBLE §4's skin row ("fresnel rim #FF9E7A at 0.25 strength fakes SSS")
  // relocated from the fresnel to the terminator, which is where subsurface
  // scatter actually shows on a face lit from one side.
  //
  // Triangular rather than Gaussian: two multiplies instead of an exp() on a
  // material that shades every character in frame, and at this width the two
  // curves are not distinguishable in a screenshot.
  float sss = 1.0 - min( 1.0, abs( ndl ) / max( uToonSubsurfaceWidth, 1e-3 ) );
  reflectedLight.directDiffuse += directLight.color * uToonSubsurface * ( sss * sss )
    * BRDF_Lambert( material.diffuseContribution );

  // One tight, quantised specular band. Not GGX: a microfacet lobe on a
  // three-band character reads as a smudge of PBR contamination, whereas the
  // reference's armour and hair carry a single decisive highlight with a hard
  // inner edge and a soft outer one — which is what a smooth-stepped threshold
  // on a Blinn lobe gives, at a fraction of the cost.
  #ifdef TOON_ANISO

    // Kajiya-Kay with Scheuermann's tangent shift. Sculpted hair in this style
    // is a carved volume, not strands, so there is no tangent attribute to
    // trust; the flow axis arrives as a world-space uniform (default +Y, i.e.
    // hair falls) and is orthogonalised against the shading normal here. The
    // shift along the normal is what slides the band off the geometric centre
    // of the mass, which is the difference between "shiny" and "hair".
    vec3 tangent = normalize( ( viewMatrix * vec4( uToonAnisoDirection, 0.0 ) ).xyz );
    tangent = normalize( tangent - geometryNormal * dot( geometryNormal, tangent ) + geometryNormal * uToonAnisoShift );
    vec3 halfDir = normalize( directLight.direction + geometryViewDir );
    float tdh = dot( tangent, halfDir );
    float lobe = pow( sqrt( max( 0.0, 1.0 - tdh * tdh ) ), uToonSpecExponent );

  #else

    vec3 halfDir = normalize( directLight.direction + geometryViewDir );
    float lobe = pow( saturate( dot( geometryNormal, halfDir ) ), uToonSpecExponent );

  #endif

  float band = smoothstep( uToonSpecThreshold - uToonSpecSoftness,
                           uToonSpecThreshold + uToonSpecSoftness, lobe );

  // Metals tint their own highlight; dielectrics do not. Reading it from
  // `material.metalness` rather than from a per-material colour means a mixed
  // metal/cloth mesh sharing one material still behaves, and it keeps
  // ART_BIBLE §4's "metal is 1.0 or 0.0" rule from needing a second uniform.
  vec3 specTint = uToonSpecColor * mix( vec3( 1.0 ), material.diffuseColor, material.metalness );

  // Gated by a soft step on N·L, not by the band: a highlight that survives one
  // pixel past the terminator is the classic toon-shader tell.
  reflectedLight.directSpecular += directLight.color * specTint
    * ( uToonSpecGain * band * smoothstep( -0.05, 0.15, ndl ) );

}

#undef RE_Direct
#define RE_Direct RE_Direct_Toon
// ---- end toon character model --------------------------------------------
`;

/** Injection 2: per-fragment reset, immediately before the lighting loop. */
export const TOON_SURFACE_INIT = /* glsl */ `
awToonLit = 0.0;
`;

/** Injection 3: the once-per-fragment composite. */
export const TOON_SURFACE_COMPOSITE = /* glsl */ `
{
  float awLit = clamp( awToonLit, 0.0, 1.0 );

  // ---- tinted shadow ------------------------------------------------------
  // ART_BIBLE §2.1: "shadows are never neutral [...] if you can eyedrop a grey
  // out of a shadow, it is a bug." The rig enforces that for the environment
  // through its hemisphere fill; this is the character-side half, and it is
  // additive rather than multiplicative on purpose — a multiply can only ever
  // darken toward the albedo's own hue, which is precisely the "darkened copy
  // of albedo" the look must not have. Driving it from `awLit` rather than from
  // N·L alone is what makes a *cast* shadow land in the same coloured mass as
  // the form shadow instead of punching a black hole through the character.
  vec3 shadowFill = awToonShadowColor( awLit ) * ( uToonShadowGain * ( 1.0 - awLit ) );
  reflectedLight.indirectDiffuse += shadowFill * material.diffuseContribution;

  // ---- mandatory rim ------------------------------------------------------
  // REFERENCE_TARGET §1 lists this as the one non-negotiable: "a bright
  // rim/back light separating them from the background in every frame". It is
  // deliberately not shadowed — the rig's rim light casts no shadows (a second
  // shadow pass fighting the key for the same surfaces buys nothing), and a
  // character stepping into shade must not lose the edge that is holding it off
  // a fog-coloured background.
  //
  // Allowed past 1.0. ART_BIBLE §6 puts the bloom threshold at 1.0 and §2.3
  // names specular pings as one of the three things permitted to clip, so only
  // the hottest sliver of the rim spills into bloom and the body of it stays
  // inside the 0.05–0.85 band the histogram target wants.
  vec3 rimDirView = normalize( ( viewMatrix * vec4( uRimDirection, 0.0 ) ).xyz );
  float awRim = awToonRim( normal, geometryViewDir, rimDirView );
  reflectedLight.directSpecular += uRimColor * ( awRim * uToonRimGain * uRimStrength );

  // ---- battle feedback channel -------------------------------------------
  // A surface-wide additive tint the combat layer drives for hit flashes, limit
  // charge and status auras. Weighted toward the rim so a pulse reads as the
  // character *glowing at its edge* rather than as a flat colour wash, which is
  // how the reference shows charged states. Zero-cost at rest: `uToonPulse`
  // defaults to black and the whole term collapses.
  vec3 awPulse = uToonPulse * ( 0.5 + 0.5 * sin( uToonTime * uToonPulseRate ) );
  reflectedLight.directSpecular += awPulse * ( 0.35 + 0.65 * awRim );
}
`;
