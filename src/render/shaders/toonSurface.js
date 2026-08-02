/**
 * toonSurface.js — the GLSL blocks that turn a stock `MeshStandardMaterial`
 * into the cel character shading model of `docs/ANIME_PIPELINE.md`.
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
 * ## The model, in the order the fragment evaluates it
 *
 *  1. **Per light** (`RE_Direct_Toon`): N·L is *collected*, weighted by the
 *     light's share of the key, rather than shaded. A rig with four cascades, a
 *     rim and a fill would otherwise shade one surface with six differently
 *     oriented terminators, and their sum is a muddle rather than a form. What
 *     is collected is the raw geometric term, so the composite can threshold one
 *     dominant direction exactly once.
 *  2. **Specular** in the same pass, and it is a *shape*: a Blinn-Phong lobe
 *     thresholded into a hard-edged blob (ANIME_PIPELINE §2), or a Kajiya-Kay
 *     band thresholded the same way for hair (§3). Fur takes a Charlie/Neubelt
 *     sheen, which is the one class whose contour is meant to read broken.
 *     Classes with no gloss compile all of it out.
 *  3. **Indirect** is held, not applied, so the composite can decide once which
 *     albedo it multiplies. On a character class it is partly flattened
 *     (`TOON_FLAT_AMBIENT` plus `uToonAmbientFlatness`) so the ambient cannot
 *     compete with the key for the form, and any environment reflection is
 *     quantised into flat plates — §5's colour blocking rule applied to the one
 *     term that most easily breaks it.
 *  4. **Composite**: the collected direction is thresholded once into two bands,
 *     intersected with the cast-shadow term so a cast shadow joins the form
 *     shadow as one mass, resolved to a constant device-pixel edge, and used to
 *     blend two complete surface responses — the lit one and a hue-shifted
 *     shadow one placed at a stated fraction of it. Then the optional third band
 *     on the lit side, the face clamp, the bounded rim and the battle pulse.
 *
 * ## The doctrinal ruling
 *
 * This file previously implemented soft stylised-PBR shading, written against
 * `docs/BRAVELY_REFERENCE.md` and the plates in `docs/reference/`. The ruling is
 * now `docs/ANIME_PIPELINE.md`, which reverses that; the reasoning and the
 * measurements from both sides are recorded in `shaders/toonCommon.js` so the
 * decision can be revisited on evidence rather than re-argued from memory.
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
 *     loop and the two indirect calls have run. It has to be one place and not
 *     per light: the whole model is "two levels, one edge between them", and
 *     neither level nor the edge is knowable until every light has reported.
 *
 * OWNED BY: render/ToonMaterial.js.
 */
import { TOON_UNIFORMS_GLSL, TOON_FUNCTIONS_GLSL } from './toonCommon.js';

/** Injection 1: uniforms, helpers, the toon responses, and the macro swaps. */
export const TOON_SURFACE_PARS = /* glsl */ `
// ---- AETHERWIND character surface model -----------------------------------
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
float awToonNdl;            // Σ N·L × share — collected, not yet thresholded
float awToonWeight;         // Σ share — the normaliser, and the cast-shadow term
vec3 awToonKey;             // direct radiance, albedo not yet applied
vec3 awToonAmbient;         // indirect irradiance

void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  float ndl = dot( geometryNormal, directLight.direction );

  // How much of the key's radiance actually arrived here.
  //
  // For every cascade light this ratio *is* the shadow factor, exactly: the rig
  // drives all cascades at one colour and one intensity and publishes that
  // product as 'uKeyColor', so dividing the post-shadow radiance by it recovers
  // the scalar the shadow map returned. For a dimmer light (the rim, a torch) it
  // degrades to that light's share of the key, which is the correct weight for a
  // term whose only question is "how lit is this pixel".
  //
  // Summed, not maxed, and the sum has two jobs. As a denominator it makes the
  // collected N·L a share-weighted mean, so the key — the brightest light by
  // construction — decides the form's direction. As a value in its own right it
  // is the fragment's total visibility of the key, which is what the composite
  // intersects the form band with; that is what makes a cast shadow snap into
  // the shadow band instead of merely dimming the lit one. CSM calls 'RE_Direct'
  // once per cascade and splits the radiance between two of them inside the fade
  // band, so a maximum would report half visibility along the whole cascade
  // boundary and draw a seam across the character as it walks through it. The
  // sum is exactly 1 there.
  float share = saturate( max3( directLight.color ) / max( max3( uKeyColor ), 1e-4 ) );
  awToonNdl += ndl * share;
  awToonWeight += share;

  // Radiance is accumulated for the *level* of the two bands. The band itself is
  // decided by direction alone, above, so a torch cannot draw a second
  // terminator across a figure the sun has already shaped.
  awToonKey += directLight.color;

  #ifdef TOON_SPECULAR

    // Gated by this light's own two-band step so a highlight cannot survive on
    // the dark side of the form. Evaluated unresolved — the blob's own edge is
    // resolved inside 'awToonSpecShape', and resolving a product of two edges
    // twice would draw a seam where they cross.
    float awGate = awToonBand( ndl, uToonTerminator, uToonSoftness );

    #ifdef TOON_ANISO

      // Sculpted hair in this style is a carved volume, not strands, so there is
      // no tangent attribute to trust; the strand axis arrives as a world-space
      // uniform (default +Y, i.e. hair falls) and is orthogonalised against the
      // shading normal here. The shift along the normal slides the band off the
      // geometric centre of the mass, which is the difference between "shiny"
      // and "hair".
      vec3 tangent = normalize( ( viewMatrix * vec4( uToonAnisoDirection, 0.0 ) ).xyz );
      tangent = normalize( tangent - geometryNormal * dot( geometryNormal, tangent ) + geometryNormal * uToonAnisoShift );
      vec3 halfDir = normalize( directLight.direction + geometryViewDir );

      float awLobe = awToonSpecShape( awToonAnisoLobe( tangent, halfDir ) );

      // ANIME_PIPELINE §3: "a bright, slightly desaturated band" — the
      // highlight's colour is the surface's own, lightened toward
      // 'uToonSpecColor'. Pure white on a saturated hair mass reads as plastic;
      // the albedo alone reads as a lighting artefact.
      vec3 awSpecTint = mix( uToonSpecColor, uToonSpecColor * material.diffuseColor,
                             clamp( uToonSpecAlbedoMix, 0.0, 1.0 ) );

      reflectedLight.directSpecular += directLight.color * awSpecTint
        * ( uToonSpecGain * awLobe * awGate );

    #else

      // ANIME_PIPELINE §2: a thresholded Blinn-Phong term, so the highlight is a
      // crisp shape rather than a lobe. This is what carries metal under the cel
      // ruling — REFERENCE_TARGET §1 is explicit that armour and blades "read
      // through a hard specular band rather than environment reflection" — and
      // it is why the previous revision's 'BRDF_GGX' is gone from the direct
      // path: a normalised microfacet lobe has no bounded range, so a threshold
      // on it means something different on every surface.
      float awLobe = awToonSpecShape( awToonBlinn( geometryNormal, directLight.direction,
                                                   geometryViewDir, material.roughness ) );

      reflectedLight.directSpecular += directLight.color * uToonSpecColor
        * ( uToonSpecGain * awLobe * awGate );

    #endif

  #endif

  #ifdef TOON_SHEEN

    // Fur and feather trim. Additive over the diffuse rather than replacing it,
    // and deliberately *not* gated by the band: Charlie's lobe peaks at grazing
    // angles and is retro-reflective, so it is at its strongest exactly where a
    // fur collar is backlit. Weighted by N·L only so it still dies on a surface
    // facing fully away.
    reflectedLight.directSpecular += directLight.color * uToonSheenColor
      * ( awToonSheen( geometryNormal, directLight.direction, geometryViewDir )
          * saturate( ndl ) * uToonSheenGain );

  #endif

}

/**
 * The indirect chain, flattened on a character.
 *
 * ANIME_PIPELINE's model has exactly two levels on a character surface, and
 * every term that varies smoothly across the form is competing with the
 * terminator for the job of describing it. A hemisphere fill and a probe both do
 * — a figure under a strong sky gradient picks up a top-to-bottom ramp that
 * reads as the soft PBR falloff the whole rewrite exists to remove, and on a
 * face it competes directly with the painted brow line, which has to win.
 *
 * So the flattening is a blend rather than a switch. 'uToonAmbientFlatness' says
 * how much of the directional ambient to trade for its own average: 0 is
 * physically correct, 1 discards direction entirely, and the character presets
 * sit high. Keeping a little is still worth it — a character lit from nowhere at
 * all is a cut-out, which is the other failure mode the review named.
 *
 * Compiled only for the classes that describe a character surface ('flat' in the
 * preset table). Props, terrain and monsters keep three's per-normal indirect
 * untouched.
 */
void RE_IndirectDiffuse_Toon( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  vec3 awIrradiance = irradiance;

  #ifdef TOON_FLAT_AMBIENT

    // The directional average of everything three summed into 'irradiance':
    // ambient is flat already, band 0 of the probe's SH is its average, and a
    // hemisphere light's average is the midpoint of sky and ground.
    vec3 awFlat = getAmbientLightIrradiance( ambientLightColor );

    #if defined( USE_LIGHT_PROBES )
      awFlat += lightProbe[ 0 ] * 0.886227;
    #endif

    #if NUM_HEMI_LIGHTS > 0
      for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
        awFlat += mix( hemisphereLights[ i ].groundColor, hemisphereLights[ i ].skyColor, 0.5 );
      }
    #endif

    awIrradiance = mix( irradiance, awFlat, clamp( uToonAmbientFlatness, 0.0, 1.0 ) );

  #endif

  // Held rather than applied, because the albedo it multiplies is not decided
  // until the composite.
  awToonAmbient += awIrradiance * RECIPROCAL_PI * uToonAmbientGain;

}

void RE_IndirectSpecular_Toon( const in vec3 radiance, const in vec3 irradiance, const in vec3 clearcoatRadiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  // The probe's diffuse half. three's physical path routes this through
  // 'RE_IndirectSpecular' rather than 'RE_IndirectDiffuse' because it wants to
  // subtract the specular's energy from it first; dropping that compensation
  // costs a few percent of brightness on a rough dielectric and buys not having
  // a GGX split-sum evaluation on a material whose direct highlight already is
  // a closed-form shape.
  vec3 awProbe = irradiance;

  #if defined( TOON_FLAT_AMBIENT ) && defined( USE_ENVMAP )
    // 'getIBLIrradiance' is a mip-1 cube lookup rather than an SH evaluation, so
    // there is no band-0 term to isolate; two antipodal samples along world up
    // are its directional average to the accuracy the lookup itself has.
    vec3 awUpView = ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz;
    vec3 awFlatProbe = 0.5 * ( getIBLIrradiance( awUpView ) + getIBLIrradiance( - awUpView ) );
    awProbe = mix( irradiance, awFlatProbe, clamp( uToonAmbientFlatness, 0.0, 1.0 ) );
  #endif

  awToonAmbient += awProbe * RECIPROCAL_PI * uToonAmbientGain;

  // The grazing Fresnel lift is kept — it is what stops a metal edge turning
  // away from the camera going dead — but the radiance it multiplies is
  // levelled, not swept. A continuous reflection sweeping across a curved plate
  // is the loudest "physically based" cue a stylised frame can carry, and
  // ANIME_PIPELINE §5 asks a character to read as three or four flat zones;
  // 'uToonEnvLevels' is how many plates that reflection is allowed to break
  // into, and it is 0 (off) on every dielectric class.
  float awNdv = saturate( dot( geometryNormal, geometryViewDir ) );
  vec3 awF = material.specularColorBlended
    + ( vec3( material.specularF90 ) - material.specularColorBlended ) * pow( 1.0 - awNdv, 5.0 );

  vec3 awEnv = mix( awProbe * RECIPROCAL_PI, radiance, material.metalness );
  awEnv = awToonQuantise( awEnv, uToonEnvLevels );

  reflectedLight.indirectSpecular += awEnv * awF * uToonEnvSpecular;

}

#undef RE_Direct
#define RE_Direct RE_Direct_Toon
#undef RE_IndirectDiffuse
#define RE_IndirectDiffuse RE_IndirectDiffuse_Toon
#undef RE_IndirectSpecular
#define RE_IndirectSpecular RE_IndirectSpecular_Toon
// ---- end character surface model ------------------------------------------
`;

/** Injection 2: per-fragment reset, immediately before the lighting loop. */
export const TOON_SURFACE_INIT = /* glsl */ `
awToonNdl = 0.0;
awToonWeight = 0.0;
awToonKey = vec3( 0.0 );
awToonAmbient = vec3( 0.0 );
`;

/** Injection 3: the once-per-fragment composite. */
export const TOON_SURFACE_COMPOSITE = /* glsl */ `
{
  // ---- one terminator, drawn once -----------------------------------------
  // The share-weighted mean of every light's N·L: one dominant direction for the
  // form, whatever the rig's light count. See 'RE_Direct_Toon'.
  float awNdl = awToonNdl / max( awToonWeight, 1e-4 );

  // The fragment's visibility of the key, which for a single key across CSM's
  // cascades is exactly the shadow-map result. Intersected with the form band
  // rather than multiplied into the radiance, so a cast shadow lands the surface
  // in the *shadow band* — one shadow mass with one contour, which is how an
  // inked frame reads a shadow — instead of dimming the lit band and leaving a
  // soft grey patch floating inside it.
  float awVis = saturate( awToonWeight );

  // ANIME_PIPELINE §2: two bands, 'smoothstep( t - w, t + w, N·L )' at t ≈ 0.5
  // and w ≈ 0.04, then resolved to a constant device-pixel edge so the
  // terminator is a drawn line at every distance and still antialiases.
  float awShape = awToonEdge( awToonBias( min( awToonBand( awNdl, uToonTerminator, uToonSoftness ),
                                               awVis ) ) );

  // ---- surfaces that must not take a shadow at all -------------------------
  // A floor on the band itself, for the one class where a shadow is not a
  // stylistic choice but an error: an iris carrying a cast shadow reads as a
  // dead eye. It is 0 on everything else, including skin — the *face's* clamp is
  // a bound on how dark its shadow may go rather than a suppression of the
  // shadow shape, and that belongs to 'uToonShadowDepth' below. Flattening the
  // term instead lifts the whole face toward its lit level, which measurably
  // blew the painted sclera past the bloom threshold and swallowed the eye.
  awShape = max( awShape, clamp( uToonShadowFloor, 0.0, 1.0 ) );

  // ---- the two albedos ----------------------------------------------------
  // §2: the shaded side is a hue rotation with rising saturation, never a
  // darkened copy. 'awToonShadowAlbedo' does the rotation; the band picks one
  // side or the other, so the hue changes *at the terminator* rather than
  // travelling across the form.
  //
  // Metal restores part of its albedo first. three zeroes 'diffuseContribution'
  // at metalness 1 because a physical metal has no diffuse lobe — but a chibi
  // pauldron carries a painted base colour under its reflection, and without
  // this the armour is nothing but environment.
  vec3 awLitAlbedo = mix( material.diffuseContribution, material.diffuseColor,
                          material.metalness * clamp( uToonMetalAlbedo, 0.0, 1.0 ) );
  vec3 awShadeAlbedo = awToonShadowAlbedo( awLitAlbedo );

  // ---- the two radiances --------------------------------------------------
  // Both levels are evaluated in full, then selected between. A cel character
  // does not have a light term that falls off, it has **two levels and an edge**,
  // and the ratio of those levels is art direction rather than an accident of
  // how much ambient the scene supplies.
  //
  // 'uToonShadowLift' is the share of the key the shaded level keeps, so the
  // dark side still carries the key's colour and dies with it at night; the flat
  // fill supplies the scene's shadow hue.
  vec3 awAmbient = awToonAmbient;
  vec3 awLitRad = awToonKey * RECIPROCAL_PI + awAmbient;
  vec3 awShadeRad = awToonKey * ( RECIPROCAL_PI * clamp( uToonShadowLift, 0.0, 1.0 ) )
    + awAmbient + uToonShadowFill * uToonShadowGain;

  // ---- the stated dark level ----------------------------------------------
  // The shaded level is placed at exactly 'uToonShadowDepth' of the lit level's
  // peak, measured after everything else has had its say.
  //
  // Stating it is what makes the two levels survive the scene. The hemisphere
  // fill, the environment probe and the flat shadow fill are three terms this
  // material does not own, all of which lift the dark side toward the light
  // side, and between them they used to erase the form at dusk entirely.
  // Normalising instead of clamping means the ratio holds in both directions: at
  // noon the fill cannot wash the dark side out, and at night the dark side
  // cannot collapse to black. It is also what gives the frame a value structure
  // the review found missing — with a hard edge between two *stated* levels, a
  // character carries a real dark mass rather than living in one 45–80% band.
  //
  // It is where the **face clamp** lives, too. ANIME_PIPELINE §2 asks that a
  // face "resist shadowing so it stays readable", and the honest expression of
  // that in a two-level model is a shallow dark level — the band still switches,
  // so the fringe and jaw shadow keep their drawn shape and their rose-tan hue,
  // but the step between the levels is too small to carve a hole in the painted
  // eyes. 'faceFlatten' is that number; see 'FACE_SHADOW_DEPTH'.
  //
  // Measured and applied on the peak channel so the placement scales the shaded
  // level's brightness without touching the hue 'awToonShadowAlbedo' just built.
  vec3 awLitOut = awLitRad * awLitAlbedo;
  vec3 awShadeOut = awShadeRad * awShadeAlbedo;
  float awTarget = max3( awLitOut ) * clamp( uToonShadowDepth, 0.02, 1.0 );
  awShadeOut *= awTarget / max( max3( awShadeOut ), 1e-5 );

  #ifdef TOON_HIGH_BAND

    // §2: "A third rim band is allowed on the lit side for hair and metal only."
    // A second threshold further up N·L, drawn with the same pixel-resolved edge
    // as the terminator, lifting the lit level where the surface turns fully into
    // the key. On a carved hair volume it is the top plane reading brighter than
    // the front; on a pauldron it is the crown of the plate. Multiplicative, so
    // it scales whatever the lit level came to rather than adding a fixed value
    // that would blow out at noon and vanish at dusk.
    float awHigh = awToonEdge( awToonBand( awNdl, uToonHighBand, uToonSoftness ) );
    awLitOut *= mix( 1.0, max( uToonHighGain, 1.0 ), awHigh );

  #endif

  // Written as one term, into the direct accumulator. The two levels are a
  // *response to the lights* — the ambient inside them is a fill, not a probe
  // lookup — and splitting the sum across three's direct and indirect slots
  // would let '<aomap_fragment>' occlude one half of a value the placement above
  // just balanced.
  reflectedLight.directDiffuse += mix( awShadeOut, awLitOut, awShape );

  // ---- highlight ceiling --------------------------------------------------
  // The highlight is accumulated per light inside 'RE_Direct_Toon', which cannot
  // know what the rest of the surface will come to, so it needs a bound of its
  // own — and a separate one from the rim's, because the two want opposite
  // things and sharing one meant every attempt to calm the rim also flattened
  // the metal.
  //
  // Compressed on the *peak channel* through a soft shoulder, so a gold blade's
  // ping stays gold. By this point the highlight is already a thresholded blob
  // of near-constant value, so the shoulder scales its plateau and leaves the
  // edge 'awToonSpecShape' drew intact; a hard clamp would instead drive every
  // overshooting blob to exactly the ceiling and, past it, to white.
  float awSpecPeak = max3( reflectedLight.directSpecular );
  reflectedLight.directSpecular *=
    awToonSoftCap( awSpecPeak, uToonSpecCeiling ) / max( awSpecPeak, 1e-5 );

  // ---- rim, drawn as a band and bounded twice -----------------------------
  // REFERENCE_TARGET §1 requires a rim/back light separating the cast from the
  // background in every frame. Under the cel ruling it is a band with an edge —
  // resolved through the same device-pixel edge as the terminator and the
  // highlight, so every mark on the character is the same kind of mark — rather
  // than a fresnel wash that would read as one more smooth gradient.
  //
  // Two independent bounds on its level, because one is not enough:
  //
  //  - **Headroom.** The rim is spent against what is left below
  //    'uToonRimCeiling' rather than added outright. With ceiling 'c',
  //    accumulated peak 's' and rim peak 'r', the result is
  //    's + r(1 - s/c) = r + s(1 - r/c)', which for 'r <= c' rises monotonically
  //    in 's' to exactly 'c' and is suppressed to zero beyond it. That stops the
  //    same rim that glows on a dark coat from blowing a lit face past the tone
  //    curve's shoulder.
  //  - **An absolute cap.** 'uToonRimMax' bounds the rim's own radiance before
  //    it is added. 'Lighting' solves 'uRimStrength' so the hottest sliver in the
  //    frame lands at a pre-tone-map luminance of 0.55–0.92, which after ACES and
  //    the sRGB transfer is 190–215 code values — a white edge, which reads as a
  //    blown highlight rather than as a lit contour. Nothing a preset says about
  //    gain changes that, because the rig normalises gains away; only a cap
  //    downstream of the solve can.
  //
  // Deliberately not shadowed — the rig's rim light casts none, and a character
  // stepping into shade must not lose the edge holding it off the background.
  // 'totalEmissiveRadiance' is included in the headroom because an emissive
  // crystal is exactly the surface that would otherwise be pushed over by its
  // own glow plus a rim.
  vec3 awRimDirView = normalize( ( viewMatrix * vec4( uRimDirection, 0.0 ) ).xyz );
  float awRim = awToonEdge( awToonRim( normal, geometryViewDir, awRimDirView ) );

  vec3 awSoFar = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse
    + reflectedLight.directSpecular + reflectedLight.indirectSpecular
    + totalEmissiveRadiance;
  float awHeadroom = 1.0 - saturate( max3( awSoFar ) / max( uToonRimCeiling, 1e-3 ) );

  vec3 awRimRad = uRimColor * ( awRim * awHeadroom * uToonRimGain * uRimStrength );
  float awRimPeak = max3( awRimRad );
  awRimRad *= awToonSoftCap( awRimPeak, uToonRimMax ) / max( awRimPeak, 1e-5 );
  reflectedLight.directSpecular += awRimRad;

  // ---- battle feedback channel -------------------------------------------
  // A surface-wide additive tint the combat layer drives for hit flashes, limit
  // charge and status auras. Weighted toward the rim so a pulse reads as the
  // character *glowing at its edge* rather than as a flat colour wash. Zero-cost
  // at rest: 'uToonPulse' defaults to black and the whole term collapses.
  vec3 awPulse = uToonPulse * ( 0.5 + 0.5 * sin( uToonTime * uToonPulseRate ) );
  reflectedLight.directSpecular += awPulse * ( 0.35 + 0.65 * awRim );
}
`;
