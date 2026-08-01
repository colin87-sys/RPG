/**
 * toonSurface.js — the GLSL blocks that turn a stock `MeshStandardMaterial`
 * into the character shading model.
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
 * So instead the physical BRDF is replaced and nothing else is.
 *
 * ## What is replaced, and why all three response functions
 *
 * An earlier version of this file replaced `RE_Direct` only, and left
 * `RE_IndirectDiffuse` / `RE_IndirectSpecular` as the physical implementations
 * on the theory that "the probe should still reach the character". It did — as
 * a full GGX split-sum environment reflection. On a 0.40-roughness hair mass or
 * a 0.46-roughness cranium under a bright sky probe, that lobe is a broad
 * blown-out streak whose position tracks the reflection vector, i.e. it *slides
 * across the dome as the camera moves*. That is the single most PBR-looking
 * thing a toon character can do, it is what a review will call polished plastic,
 * and no amount of tuning the direct term hides it. `RE_IndirectSpecular` is
 * therefore replaced too:
 *
 *  - **Dielectrics** see the probe only through `iblIrradiance`, which is an
 *    irradiance term evaluated from the shading normal alone. It has no
 *    reflection vector, so it physically cannot produce a sliding hotspot; it
 *    contributes an ambient sheen at the silhouette and nothing else.
 *  - **Metal** keeps the sharp `radiance` lookup, because armour that ignores
 *    the world reads as cardboard — but quantised into plates by `awToonPlate`,
 *    which is REFERENCE_TARGET §1's "hard specular band rather than environment
 *    reflection" without throwing the world away.
 *
 * `RE_IndirectDiffuse` is replaced for a different reason: the ambient term has
 * to be multiplied by the *shadow-shifted* albedo, and the albedo shift is not
 * known until the direct lighting loop has finished. Both indirect functions
 * therefore stash their irradiance in a global and the single composite below
 * applies the albedo once, for every term, consistently.
 *
 * ## Injection points
 *
 * Four, chosen because they are the only points that survive CSM having already
 * rewritten the lighting chunks:
 *
 *  1. after `<lights_physical_pars_fragment>` — declare uniforms, helpers and
 *     the three toon response functions, then repoint the `RE_*` macros. CSM's
 *     replacement chunk calls `RE_Direct` by macro, so cascade selection,
 *     cascade fading and shadow sampling all keep working untouched and the
 *     toon response is what they feed.
 *  2. after `<lights_physical_fragment>` — reset the per-fragment accumulators.
 *     This chunk is the last thing before the lighting loop and CSM does not
 *     touch it.
 *  3. after `<lights_fragment_end>` — the composite. Everything the shading
 *     model owes `reflectedLight` is written here, once, after both the direct
 *     loop and the two indirect calls have run. Placing it here and not later
 *     means `<aomap_fragment>` still occludes the ambient and shadow fill, which
 *     is right; the rim goes into `directSpecular`, which AO does not touch,
 *     which is also right — a rim is a grazing highlight, not bounce.
 *
 * OWNED BY: render/ToonMaterial.js.
 */
import { TOON_UNIFORMS_GLSL, TOON_FUNCTIONS_GLSL } from './toonCommon.js';

/** Injection 1: uniforms, helpers, the toon responses, and the macro swaps. */
export const TOON_SURFACE_PARS = /* glsl */ `
// ---- AETHERWIND toon character model -------------------------------------
${TOON_UNIFORMS_GLSL}
${TOON_FUNCTIONS_GLSL}

/**
 * Per-fragment accumulators.
 *
 * Globals rather than out-parameters because the 'RE_*' signatures are fixed by
 * three and by CSM's replacement chunk; changing them would mean reimplementing
 * both. Radiance is accumulated *without* albedo so the composite can decide,
 * once, which albedo — lit or shadow-shifted — every term is multiplied by. Any
 * other arrangement makes the shadow colour depend on which light happened to be
 * evaluated first.
 */
float awToonLit;            // banded key visibility, 0 unlit or shadowed, 1 lit
vec3 awToonKey;             // banded, ramp-tinted direct irradiance
vec3 awToonBleed;           // subsurface wrap irradiance (never shadow-shifted)
vec3 awToonAmbient;         // cosine-weighted indirect irradiance

void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  float ndl = dot( geometryNormal, directLight.direction );
  float lit = awToonBand( ndl );

  // How much of the key's radiance actually arrived here.
  //
  // For every cascade light this ratio *is* the shadow factor, exactly: the rig
  // drives all cascades at one colour and one intensity and publishes that
  // product as 'uKeyColor', so dividing the post-shadow radiance by it recovers
  // the scalar the shadow map returned. For a dimmer light (the rim, a torch)
  // it degrades to that light's share of the key, which is the correct weight
  // for a term whose only question is "is this pixel lit". Recovering it here is
  // what lets the shadow be a *colour* below instead of a multiply toward black.
  //
  // Summed, not maxed. CSM calls 'RE_Direct' once per cascade and splits the
  // radiance between two of them inside the fade band; taking a maximum there
  // would report the fragment as half-lit along the whole cascade boundary and
  // draw a visible seam across the character as it walks through it.
  float share = saturate( max3( directLight.color ) / max( max3( uKeyColor ), 1e-4 ) );
  awToonLit += lit * share;

  // Banded diffuse. The band supplies the value, the ramp supplies the hue, and
  // 'directLight.color' supplies the light's own colour and its shadowing —
  // three separable inputs, which is what makes this tunable rather than fiddly.
  awToonKey += directLight.color * lit * awToonTint( lit );

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
  awToonBleed += directLight.color * uToonSubsurface * ( sss * sss );

  #ifdef TOON_SPECULAR

    // One highlight band, and it is compiled out entirely on the classes that
    // must not have one. Skin is the case that matters: REFERENCE_TARGET §1
    // gives the face eyes, brows and a flat cream plane, and *any* specular lobe
    // on a near-spherical chibi cranium becomes a moving hotspot that reads as
    // wet plastic. A zero gain would still leave the term one edit away from
    // returning, so 'ToonMaterial' drops the define instead and the code is not
    // in the program at all.
    #ifdef TOON_ANISO

      // Kajiya-Kay with Scheuermann's tangent shift. Sculpted hair in this
      // style is a carved volume, not strands, so there is no tangent attribute
      // to trust; the flow axis arrives as a world-space uniform (default +Y,
      // i.e. hair falls) and is orthogonalised against the shading normal here.
      // The shift along the normal slides the band off the geometric centre of
      // the mass, which is the difference between "shiny" and "hair". The lobe
      // is constant along the tangent and falls off across it, so a tight
      // threshold on it is a *stripe* following the sweep — §1's "glossy
      // highlight band" — rather than a dot.
      vec3 tangent = normalize( ( viewMatrix * vec4( uToonAnisoDirection, 0.0 ) ).xyz );
      tangent = normalize( tangent - geometryNormal * dot( geometryNormal, tangent ) + geometryNormal * uToonAnisoShift );
      vec3 halfDir = normalize( directLight.direction + geometryViewDir );
      float tdh = dot( tangent, halfDir );
      float lobe = pow( sqrt( max( 0.0, 1.0 - tdh * tdh ) ), uToonSpecExponent );

    #else

      vec3 halfDir = normalize( directLight.direction + geometryViewDir );
      float lobe = pow( saturate( dot( geometryNormal, halfDir ) ), uToonSpecExponent );

    #endif

    // The softness floor is not cosmetic: 'smoothstep' with equal edges is
    // undefined, and a zero-width highlight edge aliases into a crawling
    // sparkle on any curved surface anyway.
    float specSoft = max( uToonSpecSoftness, 1e-3 );
    float band = smoothstep( uToonSpecThreshold - specSoft, uToonSpecThreshold + specSoft, lobe );

    // Metals tint their own highlight; dielectrics do not. Reading it from
    // 'material.metalness' rather than from a per-material colour means a mixed
    // metal/cloth mesh sharing one material still behaves, and it keeps
    // ART_BIBLE §4's "metal is 1.0 or 0.0" rule from needing a second uniform.
    vec3 specTint = uToonSpecColor * mix( vec3( 1.0 ), material.diffuseColor, material.metalness );

    // Gated by a soft step on N·L, not by the band: a highlight that survives
    // one pixel past the terminator is the classic toon-shader tell.
    reflectedLight.directSpecular += directLight.color * specTint
      * ( uToonSpecGain * band * smoothstep( -0.05, 0.15, ndl ) );

  #endif

}

void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  // Ambient, light probes and the hemisphere fill — whose sky colour Lighting
  // has already forced inside ART_BIBLE §2.1's hue window. Held rather than
  // applied, because the albedo it multiplies is not decided until the composite.
  awToonAmbient += irradiance * RECIPROCAL_PI;

}

void RE_IndirectSpecular_Toon( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  // The probe's diffuse half. three's physical path routes this through
  // 'RE_IndirectSpecular' rather than 'RE_IndirectDiffuse' because it wants to
  // subtract the specular's energy from it first; dropping that compensation
  // costs a few percent of brightness on a rough dielectric and buys not having
  // a GGX split-sum evaluation on a material that has no GGX lobe left to
  // conserve energy against.
  awToonAmbient += irradiance * RECIPROCAL_PI;

  float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
  vec3 F = material.specularColorBlended
    + ( vec3( material.specularF90 ) - material.specularColorBlended ) * pow( 1.0 - dotNV, 5.0 );

  // Dielectric: irradiance only. It is evaluated from the shading normal, so it
  // varies smoothly across the surface and cannot form the sliding mirror
  // hotspot a reflection-vector lookup does — the exact defect this replacement
  // exists to remove. Metal: the real reflection, stepped into plates.
  vec3 env = mix( irradiance * RECIPROCAL_PI, awToonPlate( radiance ), material.metalness );

  reflectedLight.indirectSpecular += env * F * uToonEnvSpecular;

}

#undef RE_Direct
#define RE_Direct RE_Direct_Toon
#undef RE_IndirectDiffuse
#define RE_IndirectDiffuse RE_IndirectDiffuse_Toon
#undef RE_IndirectSpecular
#define RE_IndirectSpecular RE_IndirectSpecular_Toon
// ---- end toon character model --------------------------------------------
`;

/** Injection 2: per-fragment reset, immediately before the lighting loop. */
export const TOON_SURFACE_INIT = /* glsl */ `
awToonLit = 0.0;
awToonKey = vec3( 0.0 );
awToonBleed = vec3( 0.0 );
awToonAmbient = vec3( 0.0 );
`;

/** Injection 3: the once-per-fragment composite. */
export const TOON_SURFACE_COMPOSITE = /* glsl */ `
{
  float awLit = clamp( awToonLit, 0.0, 1.0 );

  // ---- the two albedos ----------------------------------------------------
  // REFERENCE_TARGET §1 asks for "a coloured shadow region", and a light term
  // alone cannot deliver one: an amber albedo has almost no blue reflectance, so
  // however teal the fill is, the product stays a duller amber. The surface
  // colour itself has to move. 'awToonShadowAlbedo' shifts it toward
  // 'SHADOW_TINT' at the preset's mix and enforces §2.1's saturation floor on
  // the result; the band then chooses between the two, which makes the
  // terminator a hue boundary as well as a value one — which is what makes a
  // painted cel shadow look painted.
  vec3 awLitAlbedo = material.diffuseContribution;
  vec3 awShadeAlbedo = awToonShadowAlbedo( awLitAlbedo );
  vec3 awAlbedo = mix( awShadeAlbedo, awLitAlbedo, awLit );

  reflectedLight.directDiffuse += awToonKey * BRDF_Lambert( awAlbedo );

  // Subsurface bleed keeps the *lit* albedo. It is light that entered the
  // surface on the key side and came out past the terminator, so it carries the
  // lit colour by definition; shifting it to the shadow hue would cancel the one
  // term that stops an oversized chibi head going dead across its terminator.
  reflectedLight.directDiffuse += awToonBleed * BRDF_Lambert( awLitAlbedo );

  reflectedLight.indirectDiffuse += awToonAmbient * awAlbedo;

  // ---- tinted shadow fill -------------------------------------------------
  // The light-side half of ART_BIBLE §2.1, layered over the shifted albedo: a
  // warm-to-cool gradient filling the deficit, warm just past the terminator
  // where bounce still reaches and cool in the mass where only sky does.
  // Driving it from 'awLit' rather than from N·L alone is what makes a *cast*
  // shadow land in the same coloured mass as the form shadow instead of punching
  // a hole through the character.
  vec3 shadowFill = awToonShadowColor( awLit ) * ( uToonShadowGain * ( 1.0 - awLit ) );
  reflectedLight.indirectDiffuse += shadowFill * awAlbedo;

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
  // how the reference shows charged states. Zero-cost at rest: 'uToonPulse'
  // defaults to black and the whole term collapses.
  vec3 awPulse = uToonPulse * ( 0.5 + 0.5 * sin( uToonTime * uToonPulseRate ) );
  reflectedLight.directSpecular += awPulse * ( 0.35 + 0.65 * awRim );
}
`;
