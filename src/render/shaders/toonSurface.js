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
 *     as a plate-quantised reflection. On a character class the whole indirect
 *     chain is additionally evaluated at **zero directional order**
 *     (`TOON_FLAT_AMBIENT`), so it contributes light without contributing a
 *     gradient; see the comment on `RE_IndirectDiffuse_Toon` for why that is
 *     what makes the terminator an edge rather than a kink.
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
float awToonLit;            // Σ band × share — the banded term, before resolution
float awToonWeight;         // Σ share — the normaliser that makes it a mean
vec3 awToonKey;             // *unbanded* direct radiance, albedo not yet applied
vec3 awToonAmbient;         // cosine-weighted indirect irradiance
#ifdef TOON_LIT_BAND
  float awToonTop;          // Σ litBand × share
#endif

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
  awToonWeight += share;

  // The radiance is accumulated **unbanded**, and that is the second half of
  // the terminator correction.
  //
  // Banding each light by its own N·L — which is what this did — gives a
  // surface as many terminators as the rig has lights, at as many angles, each
  // one a partial step. Summed, six partial steps at six thresholds *are* a
  // smooth ramp; the rig here runs four cascade lights, a rim light and a fill,
  // and the review's "continuous soft airbrush ramp" is their sum. Anime has
  // exactly one terminator, drawn where the key puts it, and every other light
  // contributes brightness to the two masses it divides rather than a boundary
  // of its own. So the light is collected here and divided once, in the
  // composite, by the *dominant* band — which is what 'awToonLit / awToonWeight'
  // recovers: a share-weighted mean in which the key, being the brightest light
  // by construction, decides the sign.
  //
  // Cast shadows survive this intact. Three multiplies the shadow-map result
  // into 'directLight.color' before this function is called, so a shadowed
  // fragment arrives with less radiance *and* a smaller share — it darkens, and
  // it pulls the mean toward the shadow band, which is exactly how a cast
  // shadow should read on a cel character: as part of the one shadow mass, not
  // as a hole punched through the shading.
  awToonKey += directLight.color;

  #ifdef TOON_LIT_BAND

    // ANIME_PIPELINE §2's optional third band, hair and metal only. Collected
    // the same way as the terminator so it resolves to one plateau rather than
    // one per light.
    awToonTop += awToonLitBand( ndl ) * share;

  #endif

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

/**
 * The indirect chain, evaluated at **zero directional order** on a character.
 *
 * ANIME_PIPELINE §2's terminator is a hard edge only if it is the *only* thing
 * on the surface that varies. It was not. Every character fragment was summing
 * the banded key with three continuous, normal-dependent terms, each of the same
 * order as the step the band is supposed to draw:
 *
 *  - the hemisphere fill, which is 'mix( ground, sky, 0.5 · N·up + 0.5 )' —
 *    a smooth top-to-bottom ramp across every surface, by construction;
 *  - the environment probe's irradiance, a smooth SH/mip-1 lookup on the same
 *    shading normal;
 *  - the environment fresnel's 'pow( 1 - N·V, 5 )' grazing ramp.
 *
 * On a small convex form the band still wins. On the largest smooth mass the
 * cast owns — a shoulder pauldron in a close-up — those ramps *are* the image,
 * and the review read exactly that: "a smooth continuous gradient from pale to
 * mid", i.e. the PBR falloff ANIME_PIPELINE was written to remove, with a faint
 * kink in it where the terminator is.
 *
 * The fix is not to turn the ambient down — that darkens the cast, which the
 * same review already calls the darkest thing in frame — but to strip the
 * *direction* out of it and keep the energy. Reconstructing the irradiance from
 * the light uniforms at band 0 is exactly that: the hemisphere's average of sky
 * and ground, the probe's constant SH term, and the ambient light, which is flat
 * already. Same total light, no gradient. After this the only spatial variation
 * left on a character's diffuse is the band itself, so the terminator is an edge
 * by construction rather than by tuning — which is the property the review asks
 * to verify by eye on the pauldron.
 *
 * Compiled only for the classes that describe a character surface ('flat' in the
 * preset table). Props, terrain and monsters keep three's per-normal indirect.
 */
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  // Held rather than applied, because the albedo it multiplies is not decided
  // until the composite. 'uToonAmbientGain' scales it because ambient is the one
  // term with no band in it at all: too much and it lifts the shadow mass until
  // the terminator has no value break left to show.
  #ifdef TOON_FLAT_AMBIENT

    vec3 awFlat = getAmbientLightIrradiance( ambientLightColor );

    #if defined( USE_LIGHT_PROBES )
      // Band 0 of 'shGetIrradianceAt': the probe's directional average, which is
      // the whole of it that survives flattening.
      awFlat += lightProbe[ 0 ] * 0.886227;
    #endif

    #if NUM_HEMI_LIGHTS > 0
      for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
        awFlat += mix( hemisphereLights[ i ].groundColor, hemisphereLights[ i ].skyColor, 0.5 );
      }
    #endif

    awToonAmbient += awFlat * RECIPROCAL_PI * uToonAmbientGain;

  #else

    awToonAmbient += irradiance * RECIPROCAL_PI * uToonAmbientGain;

  #endif

}

void RE_IndirectSpecular_Toon( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  // The probe's diffuse half. three's physical path routes this through
  // 'RE_IndirectSpecular' rather than 'RE_IndirectDiffuse' because it wants to
  // subtract the specular's energy from it first; dropping that compensation
  // costs a few percent of brightness on a rough dielectric and buys not having
  // a GGX split-sum evaluation on a material that has no GGX lobe left to
  // conserve energy against.
  //
  // Flattened on a character for the reason given above 'RE_IndirectDiffuse_Toon'.
  // 'getIBLIrradiance' is a mip-1 cube lookup rather than an SH evaluation, so
  // there is no band-0 term to isolate; the two antipodal samples along world up
  // are its directional average to the accuracy the lookup itself has, and they
  // are constant over the surface, which is the property that matters here.
  vec3 awProbe = irradiance;

  #if defined( TOON_FLAT_AMBIENT ) && defined( USE_ENVMAP )
    vec3 awUpView = ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz;
    awProbe = 0.5 * ( getIBLIrradiance( awUpView ) + getIBLIrradiance( - awUpView ) );
  #endif

  awToonAmbient += awProbe * RECIPROCAL_PI * uToonAmbientGain;

  // The grazing fresnel is the third smooth ramp, and on a character it is also
  // a *silhouette-brightening* one — it peaks exactly where the ink line has to
  // win. Characters therefore take the environment at normal incidence, which is
  // a constant: cel-painted armour reflects its world as a flat plate value, not
  // as a rolled edge. Props keep the real Schlick term.
  #ifdef TOON_FLAT_AMBIENT

    vec3 F = material.specularColorBlended;

  #else

    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    vec3 F = material.specularColorBlended
      + ( vec3( material.specularF90 ) - material.specularColorBlended ) * pow( 1.0 - dotNV, 5.0 );

  #endif

  // Dielectric: irradiance only. It is evaluated from the shading normal, so it
  // varies smoothly across the surface and cannot form the sliding mirror
  // hotspot a reflection-vector lookup does — the exact defect this replacement
  // exists to remove. Metal: the real reflection, stepped into plates.
  //
  // On a character, metal takes the *flattened* probe instead, and that is the
  // last smooth ramp on the cast. 'awToonPlate' quantises a radiance's level
  // into three steps but leaves its chromaticity alone, and a reflection-vector
  // lookup's chromaticity sweeps continuously across a form — so a chibi
  // pauldron, the largest smooth mass the cast owns, came out as an unbroken
  // cream-to-lavender gradient with the terminator invisible inside it. That is
  // the review's "PBR falloff wearing a chibi costume", on the one class whose
  // shading is dominated by the probe. Cel-painted armour reflects its world as
  // a flat plate value; the form is carried by the band and by the hard
  // highlight, which is what ANIME_PIPELINE §5's colour blocking asks for.
  #ifdef TOON_FLAT_AMBIENT
    vec3 awMetalEnv = awToonPlate( awProbe * RECIPROCAL_PI );
  #else
    vec3 awMetalEnv = awToonPlate( radiance );
  #endif

  vec3 env = mix( awProbe * RECIPROCAL_PI, awMetalEnv, material.metalness );

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
awToonWeight = 0.0;
awToonKey = vec3( 0.0 );
awToonAmbient = vec3( 0.0 );
#ifdef TOON_LIT_BAND
  awToonTop = 0.0;
#endif
`;

/** Injection 3: the once-per-fragment composite. */
export const TOON_SURFACE_COMPOSITE = /* glsl */ `
{
  // ---- one terminator, resolved to a fixed pixel width ---------------------
  // The share-weighted mean of every light's band. See 'RE_Direct_Toon' for why
  // the lights are collected rather than banded individually; 'awToonEdge' for
  // why the edge's width is stated in pixels rather than in N·L.
  float awMean = awToonLit / max( awToonWeight, 1e-4 );
  float awBand = awToonEdge( awMean, 0.5 );

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

  // ---- the two radiances --------------------------------------------------
  // Both masses are evaluated in full, then one is chosen. That is the change
  // the review's first finding actually needs: a cel character does not have a
  // light term that happens to step, it has **two levels**, and the ratio
  // between them is art direction rather than an accident of how much ambient
  // the scene supplies. Building them separately is what lets that ratio be
  // stated and enforced below.
  //
  // 'uToonShadowLift' is the share of the key the shadow mass keeps, so the
  // dark side still carries the key's colour and dies with it at night; the
  // flat fill is the scene's shadow tint, one value across the whole mass,
  // because a gradient here would put a soft falloff back inside the band.
  vec3 awAmbient = awToonAmbient;
  vec3 awLitRad = awToonKey * RECIPROCAL_PI + awAmbient;
  vec3 awShadeRad = awToonKey * ( RECIPROCAL_PI * clamp( uToonShadowLift, 0.0, 1.0 ) )
    + awAmbient + uToonShadowFill * uToonShadowGain;

  #ifdef TOON_LIT_BAND

    // The third band sits on the lit side only, so it lifts one mass and not
    // the other — a plateau *inside* the light, never a second terminator.
    awLitRad += awToonKey * ( RECIPROCAL_PI * uToonLitBandGain
      * awToonEdge( awToonTop / max( awToonWeight, 1e-4 ), 0.5 ) );

  #endif

  // ---- face flattening ----------------------------------------------------
  // ANIME_PIPELINE §2: "Faces get flatter lighting than bodies. Anime faces
  // deliberately resist shadowing so they stay readable — clamp the face's
  // shadow term to a minimum of ~0.75 so a nose or fringe never carves the face
  // into darkness."
  //
  // Lifting the *radiance* toward the lit mass is the whole of that clause, and
  // it is deliberately not what this used to do. The floor used to be applied to
  // the band itself, so at 0.75 the face's albedo was also mixed three-quarters
  // of the way back to the lit colour and its shadow was paid an extra
  // three-quarters of the key on top of the lift it already had — a shadow mass
  // at 89% of the lit value carrying 25% of the shadow hue, which is a face with
  // no shadow at all. That is measurable in the shipped frame: the closeup's
  // cheek reads one flat value from jaw to fringe. Clamping the radiance and
  // leaving the band alone gives the face what the reference actually shows —
  // a full rose-tan shadow *shape* under the fringe and along the jaw, at a
  // gentle value break the fringe cannot carve a hole with.
  awShadeRad = mix( awShadeRad, awLitRad, clamp( uToonShadowFloor, 0.0, 1.0 ) );

  // ---- the guaranteed value break -----------------------------------------
  // The shadow mass may never come within 'uToonShadowCeiling' of the lit mass.
  //
  // Without this the break is whatever is left over after the hemisphere fill,
  // the environment probe and the flat shadow fill have all been added to both
  // masses — three terms this material does not own, each of which lifts the
  // dark side toward the light side, and which between them erased the
  // terminator at dusk in the shipped build. Stating the ratio makes the
  // terminator a property of the surface class instead of a coincidence of the
  // scene's ambient level: at noon, at dusk and by torchlight the dark mass is
  // the same fraction of the light mass, which is exactly what a painter does
  // and what makes the two bands read as two bands.
  //
  // Measured and applied on the peak channel so the clamp scales the shadow's
  // brightness without touching the hue 'awToonShadowAlbedo' just built.
  vec3 awLitOut = awLitRad * awLitAlbedo;
  vec3 awShadeOut = awShadeRad * awShadeAlbedo;
  float awCeiling = max3( awLitOut ) * clamp( uToonShadowCeiling, 0.02, 1.0 );
  awShadeOut *= min( 1.0, awCeiling / max( max3( awShadeOut ), 1e-5 ) );

  // Diffuse and ambient are one term now: they are two levels of the same
  // surface response, and splitting them across three's direct/indirect
  // accumulators would only let '<aomap_fragment>' occlude half of it.
  reflectedLight.indirectDiffuse += mix( awShadeOut, awLitOut, awBand );

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
