/**
 * toonSurface.js — the GLSL blocks that turn a stock `MeshStandardMaterial`
 * into the cel character shading model.
 *
 * ## Why patch the standard material instead of writing a ShaderMaterial
 *
 * A hand-written `ShaderMaterial` would have to re-implement, correctly and
 * forever: cascaded shadow selection (`render/Lighting.js` drives
 * `three/examples/jsm/csm/CSM.js`, which swaps `ShaderChunk.lights_fragment_begin`
 * out from under every lit material in the process), skinning, morph targets,
 * `FogExp2`, PMREM environment maps, tone mapping and output colour space. Every
 * one of those is a place where the character would silently diverge from the
 * environment it stands in — and the brief requires the cast to keep receiving
 * real scene lights, real shadows and real fog, and to survive the HDR post
 * chain unchanged.
 *
 * So the physical BRDF is replaced and nothing else is.
 *
 * ## The model, in the order the fragment evaluates it
 *
 *  1. **Per light** (`RE_Direct_Toon`): N·L is banded to 0 or 1 by one narrow
 *     `smoothstep`, optionally plus a brighter third band on the lit side. The
 *     banded result is accumulated *without albedo*, so the composite can decide
 *     once — not per light, in whatever order they happen to be evaluated —
 *     which albedo every term multiplies.
 *  2. **Specular** is a thresholded blob in the same pass, gated by the cel band
 *     so it cannot survive past the terminator, and compiled out entirely on the
 *     classes that must not have one.
 *  3. **Indirect** is held, not applied, for the same reason as (1). The probe
 *     reaches dielectrics as irradiance only — never as a reflection-vector
 *     lookup, which is the sliding mirror hotspot that reads as PBR — and metal
 *     as a plate-quantised reflection.
 *  4. **Composite**: two albedos (lit, and the hue-shifted shadow one), selected
 *     by the band; the face-flattening floor; a flat shadow fill; the mandatory
 *     rim; the battle-feedback pulse.
 *
 * ## Injection points
 *
 * Three, chosen because they are the only ones that survive CSM having already
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
 *  3. after `<lights_fragment_end>` — the composite, once, after both the direct
 *     loop and the two indirect calls have run. Placing it here and not later
 *     means `<aomap_fragment>` still occludes the ambient and the shadow fill,
 *     which is right; the rim goes into `directSpecular`, which AO does not
 *     touch, which is also right — a rim is a grazing highlight, not bounce.
 *
 * OWNED BY: render/ToonMaterial.js.
 */
import { TOON_UNIFORMS_GLSL, TOON_FUNCTIONS_GLSL } from './toonCommon.js';

/** Injection 1: uniforms, helpers, the toon responses, and the macro swaps. */
export const TOON_SURFACE_PARS = /* glsl */ `
// ---- AETHERWIND cel character model --------------------------------------
${TOON_UNIFORMS_GLSL}
${TOON_FUNCTIONS_GLSL}

/**
 * Per-fragment accumulators.
 *
 * Globals rather than out-parameters because the 'RE_*' signatures are fixed by
 * three and by CSM's replacement chunk; changing them would mean reimplementing
 * both. Radiance is accumulated *without* albedo so the composite can decide,
 * once, which albedo — lit or hue-shifted — every term is multiplied by. Any
 * other arrangement makes the shadow colour depend on which light happened to be
 * evaluated first, which is a bug that only appears once a torch is added.
 */
float awToonLit;            // banded key visibility, 0 shadowed, 1 lit
vec3 awToonKey;             // banded direct radiance, albedo not yet applied
vec3 awToonAmbient;         // cosine-weighted indirect irradiance

void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  float ndl = dot( geometryNormal, directLight.direction );
  float band = awToonBand( ndl );

  // How much of the key's radiance actually arrived here.
  //
  // For every cascade light this ratio *is* the shadow factor, exactly: the rig
  // drives all cascades at one colour and one intensity and publishes that
  // product as 'uKeyColor', so dividing the post-shadow radiance by it recovers
  // the scalar the shadow map returned. For a dimmer light (the rim, a torch) it
  // degrades to that light's share of the key, which is the correct weight for a
  // term whose only question is "is this pixel lit". Recovering it here is what
  // lets the shadow be a *colour* below instead of a multiply toward black, and
  // it is what the face-flattening floor is measured against.
  //
  // Summed, not maxed. CSM calls 'RE_Direct' once per cascade and splits the
  // radiance between two of them inside the fade band; taking a maximum there
  // would report the fragment as half-lit along the whole cascade boundary and
  // draw a visible seam across the character as it walks through it.
  float share = saturate( max3( directLight.color ) / max( max3( uKeyColor ), 1e-4 ) );
  awToonLit += band * share;

  // The shadow band keeps a small share of the key ('uToonShadowLift', ~0.1).
  // Not to soften the edge — the edge is already drawn, above — but so the dark
  // side still carries the key's *colour* and dies with it at night. At zero the
  // shadow is lit by fill alone and a character walking from noon into dusk
  // changes only in its lit half, which looks like two objects.
  float weight = mix( clamp( uToonShadowLift, 0.0, 1.0 ), 1.0, band );

  #ifdef TOON_LIT_BAND

    // ANIME_PIPELINE §2's optional third band, hair and metal only.
    weight += uToonLitBandGain * awToonLitBand( ndl );

  #endif

  awToonKey += directLight.color * weight;

  #ifdef TOON_SPECULAR

    // One highlight, and it is a *shape*, not a lobe. The threshold is what
    // turns Blinn-Phong into a drawn blob: below it there is nothing at all,
    // above it there is full intensity, and the transition is a few hundredths
    // wide. A soft lobe here is the single most PBR-looking thing a cel
    // character can carry, and no amount of tuning its exponent hides it.
    //
    // Compiled out entirely on the classes that must not have one (skin, cloth):
    // a zero gain would leave the term one stray uniform write away from
    // returning, and would still cost a 'pow()' per light per fragment on the
    // largest surfaces in frame.
    #ifdef TOON_ANISO

      // Kajiya-Kay with Scheuermann's tangent shift. Sculpted hair in this style
      // is a carved volume, not strands, so there is no tangent attribute to
      // trust; the strand axis arrives as a world-space uniform (default +Y,
      // i.e. hair falls) and is orthogonalised against the shading normal here.
      // The shift along the normal slides the band off the geometric centre of
      // the mass, which is the difference between "shiny" and "hair".
      //
      // The lobe is constant *along* the strand axis and falls off *across* it,
      // so thresholding it cuts a band running perpendicular to the strands —
      // ANIME_PIPELINE §3's "one anisotropic highlight band running across the
      // crown". A round dot would mean the tangent frame is wrong.
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
    float blob = smoothstep( uToonSpecThreshold - specSoft, uToonSpecThreshold + specSoft, lobe );

    // The highlight's colour is the surface's own, lightened and desaturated
    // toward 'uToonSpecColor' — how a hair highlight is actually painted. Pure
    // white on a saturated hair mass reads as plastic; the albedo alone reads as
    // a lighting artefact. 'material.diffuseColor' is the full albedo here (three
    // keeps the metalness split in 'diffuseContribution'), so a gold blade gets a
    // gold-white band without a second uniform.
    vec3 specTint = mix( uToonSpecColor, uToonSpecColor * material.diffuseColor,
                         clamp( uToonSpecAlbedoMix, 0.0, 1.0 ) );

    // Gated by the cel band itself, not by a smoothstep on N·L: a highlight that
    // survives one pixel past the terminator is the classic toon-shader tell.
    reflectedLight.directSpecular += directLight.color * specTint * ( uToonSpecGain * blob * band );

  #endif

}

void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  // Ambient, light probes and the hemisphere fill — whose sky colour Lighting
  // has already forced inside ART_BIBLE §2.1's hue window. Held rather than
  // applied, because the albedo it multiplies is not decided until the composite.
  // 'uToonAmbientGain' exists because ambient is the one term in the model that
  // is a smooth gradient by nature: too much of it and it washes across the
  // terminator and puts the soft falloff back.
  awToonAmbient += irradiance * RECIPROCAL_PI * uToonAmbientGain;

}

void RE_IndirectSpecular_Toon( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  // The probe's diffuse half. three's physical path routes this through
  // 'RE_IndirectSpecular' rather than 'RE_IndirectDiffuse' because it wants to
  // subtract the specular's energy from it first; dropping that compensation
  // costs a few percent of brightness on a rough dielectric and buys not having
  // a GGX split-sum evaluation on a material that has no GGX lobe left to
  // conserve energy against.
  awToonAmbient += irradiance * RECIPROCAL_PI * uToonAmbientGain;

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
// ---- end cel character model ----------------------------------------------
`;

/** Injection 2: per-fragment reset, immediately before the lighting loop. */
export const TOON_SURFACE_INIT = /* glsl */ `
awToonLit = 0.0;
awToonKey = vec3( 0.0 );
awToonAmbient = vec3( 0.0 );
`;

/** Injection 3: the once-per-fragment composite. */
export const TOON_SURFACE_COMPOSITE = /* glsl */ `
{
  float awRaw = clamp( awToonLit, 0.0, 1.0 );

  // ---- face flattening ----------------------------------------------------
  // ANIME_PIPELINE §2: "Faces get flatter lighting than bodies. Anime faces
  // deliberately resist shadowing so they stay readable — clamp the face's
  // shadow term to a minimum of ~0.75 so a nose or fringe never carves the face
  // into darkness."
  //
  // Two halves, and both are needed. The floor on the band handles *form*
  // shadow. The fill below handles *cast* shadow, which the band cannot see:
  // three multiplies the shadow-map result into 'directLight.color' before this
  // material is ever called, so a fringe shadow arrives as an absence of light,
  // not as a term to clamp. Paying the deficit back at 'uKeyColor' — the rig's
  // own key radiance — is what makes a flattened face brighten and cool with the
  // time of day instead of sitting under a private studio light.
  float awFloor = clamp( uToonShadowFloor, 0.0, 1.0 );
  float awLit = max( awRaw, awFloor );
  vec3 awKey = awToonKey + uKeyColor * max( 0.0, awFloor - awRaw );

  // ---- the two albedos ----------------------------------------------------
  // The terminator is a *hue* boundary as well as a value one, which is what
  // makes a painted cel shadow look painted. 'awToonShadowAlbedo' does the hue
  // shift and the saturation lift; the band chooses between the two results.
  //
  // Metal restores part of its albedo first. three zeroes 'diffuseContribution'
  // at metalness 1 because a physical metal has no diffuse lobe — but cel-shaded
  // armour is *painted*, not simulated, and ANIME_PIPELINE §5 needs it to read as
  // one of the character's flat colour zones with a hard band across it.
  vec3 awLitAlbedo = mix( material.diffuseContribution, material.diffuseColor,
                          material.metalness * clamp( uToonMetalAlbedo, 0.0, 1.0 ) );
  vec3 awShadeAlbedo = awToonShadowAlbedo( awLitAlbedo );
  vec3 awAlbedo = mix( awShadeAlbedo, awLitAlbedo, awLit );

  reflectedLight.directDiffuse += awKey * BRDF_Lambert( awAlbedo );
  reflectedLight.indirectDiffuse += awToonAmbient * awAlbedo;

  // ---- flat shadow fill ---------------------------------------------------
  // One flat colour across the whole shadow mass, at the scene's shadow tint.
  // Flat is the point: a gradient here would put a soft falloff back inside the
  // band and undo the terminator. Driving it from the banded term rather than
  // from N·L is what makes a cast shadow land in the same coloured mass as the
  // form shadow instead of punching a hole through the character.
  reflectedLight.indirectDiffuse += uToonShadowFill * ( uToonShadowGain * ( 1.0 - awLit ) ) * awAlbedo;

  // ---- highlight ceiling --------------------------------------------------
  // The drawn highlight is accumulated per light inside 'RE_Direct_Toon', which
  // cannot know what the rest of the surface will come to — so, unlike the rim
  // below, it had no bound at all. On the two classes that carry one that is
  // where the clipping actually lived: a pale hair mass under a hard key put the
  // anisotropic band past 2.0, and a pauldron's ping past 3.0, where ACES has no
  // resolution left and every hue in the shape flattens to the same neutral
  // white. That is the review's "edges clipping to pure white rather than
  // glowing", on the specular rather than on the rim.
  //
  // Scaling the *peak channel* back to the class ceiling bounds it exactly while
  // leaving its chromaticity alone, so a gold blade's ping stays gold and a hair
  // band stays the colour of lightened hair. The ceiling is the same one the rim
  // is spent against, which is the point: it is the surface class's HDR headroom,
  // not a per-term allowance — metal and crystal carry a higher one precisely
  // because the art direction lets their highlights run hotter.
  float awSpecPeak = max3( reflectedLight.directSpecular );
  reflectedLight.directSpecular *= min( 1.0, uToonRimCeiling / max( awSpecPeak, 1e-4 ) );

  // ---- mandatory rim ------------------------------------------------------
  // REFERENCE_TARGET §1 lists this as non-negotiable: "a bright rim/back light
  // separating them from the background in every frame". Deliberately not
  // shadowed — the rig's rim light casts none, and a character stepping into
  // shade must not lose the edge holding it off a fog-coloured background.
  //
  // Added against the *headroom left below a ceiling* rather than added outright,
  // and that is the fix for the review's "edges clipping to pure white". The rim
  // is solved by the rig to a fixed radiance, but the surface it lands on is not
  // fixed: on a dark coat that radiance is the whole pixel, while on a lit chibi
  // face — already near 1.0 before the rim, because the face is the brightest
  // albedo in the cast under a face-flattening floor — the same addition lands
  // the edge past 2.0, where ACES has nothing left to resolve and every hue in
  // the frame flattens to the same white. Scaling by the remaining headroom
  // makes the rim what it is meant to be: a term that lifts an edge *to* a
  // brightness, not one that piles onto whatever brightness is already there.
  //
  // The bound is exact and worth stating, because it is the property the defect
  // was about. With ceiling 'c', accumulated peak 's' and rim peak 'r', the
  // result is 's + r(1 - s/c) = r + s(1 - r/c)', which for 'r <= c' rises
  // monotonically in 's' to exactly 'c' at 's = c' and is suppressed to zero
  // beyond it. So no fragment this material shades can be pushed above 'c' by
  // the rim — and the presets put 'c' at 1.5–2.0, inside the band that feeds
  // ART_BIBLE §6's soft-knee bloom (threshold 1.0, knee 0.6) without saturating.
  //
  // Measured on the peak channel, since that is the channel that clips, and
  // applied to all three so the rim keeps its chromaticity as it dims — the
  // whole point of the rig solving the rim for luminance rather than for peak.
  // 'totalEmissiveRadiance' is included because an emissive crystal is exactly
  // the surface that would otherwise be pushed over by its own glow plus a rim.
  vec3 rimDirView = normalize( ( viewMatrix * vec4( uRimDirection, 0.0 ) ).xyz );
  float awRim = awToonRim( normal, geometryViewDir, rimDirView );

  vec3 awSoFar = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse
    + reflectedLight.directSpecular + reflectedLight.indirectSpecular
    + totalEmissiveRadiance;
  float awHeadroom = 1.0 - saturate( max3( awSoFar ) / max( uToonRimCeiling, 1e-3 ) );

  reflectedLight.directSpecular += uRimColor
    * ( awRim * awHeadroom * uToonRimGain * uRimStrength );

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
