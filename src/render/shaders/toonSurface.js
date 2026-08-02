/**
 * toonSurface.js — the GLSL blocks that turn a stock `MeshStandardMaterial`
 * into the stylised character shading model measured off `docs/reference/`.
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
 *  2. **Specular** in the same pass, dispatched by **shading class at compile
 *     time**: a tight Blinn glint at a clamped roughness for metal, a narrowed
 *     Kajiya-Kay arc for hair, the old broad shoulder for the prop classes, a
 *     Charlie/Neubelt sheen for fur. Cloth, skin and every world surface compile
 *     the entire chain out — including the environment Fresnel in
 *     `RE_IndirectSpecular_Toon`, which is the half that survived the previous
 *     `specGain: 0` and put a grazing sheen on every garment in the frame.
 *     Whatever survives that dispatch is bounded three times in the composite,
 *     and the third bound is stated on **mark plus surface** (`awToonSumBound`)
 *     because that is the quantity a photograph of the plate measures: with
 *     only the first two, 26% of every hair mass on the cast rendered at the
 *     clip point while both were satisfied.
 *  3. **Indirect** is held, not applied, so the composite can decide once which
 *     albedo it multiplies. On a character class it is *partly* flattened
 *     (`TOON_FLAT_AMBIENT` plus `uToonAmbientFlatness`) so the ambient cannot
 *     compete with the key for the form — but only partly: the residual is a
 *     genuine second gradient across the form, and the flatness values are much
 *     lower than the cel revision's for exactly that reason. The environment
 *     reflection reaches metal continuously; quantising it is opt-in and off.
 *  4. **Composite**: the collected direction is shaped once into a broad ramp,
 *     intersected with the cast-shadow term so a cast shadow joins the form
 *     shadow as one mass, and used to blend two complete surface responses — the
 *     lit one and a hue-shifted shadow one placed at a stated fraction of it.
 *     Then the optional second lift on the lit side, the face clamp, the bounded
 *     rim and the battle pulse.
 *
 * ## The doctrinal ruling
 *
 * `docs/ANIME_PIPELINE.md` and `docs/BRAVELY_REFERENCE.md` contradict each other
 * on the terminator, the highlight and the outline. `docs/reference/README.md`
 * settles it: where prose and plate disagree, the plate wins. A previous
 * revision ruled for ANIME_PIPELINE and produced surfaces with two levels and
 * nothing in between; measured against `bravely01.jpg` that is wrong by a factor
 * of four to eight on internal value variation. The measurements, the arithmetic
 * behind them and what each one changed are recorded in `shaders/toonCommon.js`
 * so the decision stays revisable on evidence rather than re-argued from memory.
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

  // Radiance is accumulated for the *level* of the two ends of the ramp. Where
  // a fragment sits on that ramp is decided by direction alone, above, so a
  // torch cannot draw a second terminator across a figure the sun has shaped.
  //
  // Worth being explicit about, because it is what the flat-fill defect turned
  // on: nothing here is weighted by N·L, so this sum is constant across the
  // surface. All of the form comes from the ramp in the composite, which is why
  // compressing that ramp to a device-pixel width left nothing behind.
  awToonKey += directLight.color;

  #ifdef TOON_SPECULAR

    // The gate that keeps a mark off the unlit side of a surface. A constant
    // rather than the form band, because the form band is now five degrees wide
    // on a character and would slice a glint in half with a straight line
    // wherever a plate edge crosses the terminator. See 'SPEC_GATE'.
    float awGate = smoothstep( SPEC_GATE.x, SPEC_GATE.y, ndl );

    #if defined( TOON_SPEC_HAIR )

      // Sculpted hair in this style is a carved volume, not strands, so there is
      // no tangent attribute to trust; the strand axis arrives as a world-space
      // uniform (default +Y, i.e. hair falls) and is orthogonalised against the
      // shading normal here. The shift along the normal slides the band off the
      // geometric centre of the mass, which is the difference between "shiny"
      // and "hair".
      vec3 tangent = normalize( ( viewMatrix * vec4( uToonAnisoDirection, 0.0 ) ).xyz );
      tangent = normalize( tangent - geometryNormal * dot( geometryNormal, tangent ) + geometryNormal * uToonAnisoShift );
      vec3 halfDir = normalize( directLight.direction + geometryViewDir );

      // One arc, with a defined inner and outer edge and a flat interior. How
      // bright that interior may be is decided in the composite, against the
      // diffuse level underneath — see 'awToonSpecRelBound'.
      float awLobe = awToonArcShape( awToonAnisoLobe( tangent, halfDir ) );

      // ANIME_PIPELINE §3: "a bright, slightly desaturated band" — the band's
      // colour is the surface's own, lightened toward 'uToonSpecColor'. Pure
      // white on a saturated hair mass reads as plastic; the albedo alone reads
      // as a lighting artefact.
      vec3 awSpecTint = mix( uToonSpecColor, uToonSpecColor * material.diffuseColor,
                             clamp( uToonSpecAlbedoMix, 0.0, 1.0 ) );

      reflectedLight.directSpecular += directLight.color * awSpecTint
        * ( uToonSpecGain * awLobe * awGate );

    #elif defined( TOON_SPEC_METAL )

      // The steel glint: a Blinn lobe at a roughness clamped to 0.25 inside
      // 'awToonMetalLobe', graded from its threshold to the mirror direction and
      // exactly zero below it. A few pixels across on a chibi pauldron, which is
      // the size the mark is on the plate.
      //
      // It is half of what carries metal. The other half is the environment
      // reflection in 'RE_IndirectSpecular_Toon', which on the reference plates
      // is the stronger of the two.
      float awLobe = awToonGlintShape( awToonMetalLobe( geometryNormal, directLight.direction,
                                                        geometryViewDir, material.roughness ) );

      reflectedLight.directSpecular += directLight.color * uToonSpecColor
        * ( uToonSpecGain * awLobe * awGate );

    #else

      // The prop classes — leather, crystal, the geometry eye. A broad graded
      // highlight is right on all three and wrong on every character surface,
      // which is the distinction this dispatch exists to draw.
      float awLobe = awToonGlossShape( awToonGlossLobe( geometryNormal, directLight.direction,
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
 * A figure under a strong sky gradient picks up a top-to-bottom ramp from the
 * hemisphere fill and the probe, and on a *face* that ramp competes directly
 * with the painted brow line, which has to win. That is the whole case for
 * flattening, and it is a case about the face rather than about the costume.
 *
 * So the flattening is a blend rather than a switch. 'uToonAmbientFlatness' says
 * how much of the directional ambient to trade for its own average: 0 is
 * physically correct and 1 discards direction entirely.
 *
 * The character presets used to sit at 0.35–0.75. They now sit at 0.15–0.55,
 * with only 'skin' still high, because under the cel model this was the *third*
 * thing flattening the costumes: with the key contributing no N·L variation at
 * all and the band compressed to a line, the residual directional ambient was
 * the only term left that varied across a surface, and it was being traded away
 * too. It is now a genuine second gradient sitting under the form ramp — subtler
 * than the key's and differently oriented, which is what stops a figure reading
 * as if it were lit by exactly one lamp in a void.
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

  #ifdef TOON_ENV_SPEC

    // The grazing Fresnel lift, over a *swept* rather than levelled reflection.
    // On 'bravely01.jpg' the environment reflection is the strongest single
    // metal cue the knight's plate carries: one 42 px patch of a pauldron runs
    // p2 5 → p98 190 sRGB with a longest flat run of 4.8% of its own width,
    // which is a continuous sweep and cannot be produced by any number of
    // plates.
    //
    // Compiled in only for the classes that are allowed a reflection at all —
    // metal, and the three prop classes at a much lower gain. It is the other
    // half of the vinyl defect and the half that was easiest to miss: a Fresnel
    // term over a probe is brightest exactly along a silhouette, so at
    // 'envSpecular: 0.06' every cloth panel and every square centimetre of skin
    // in the frame carried a pale grazing sheen that no 'specGain: 0' switched
    // off, because this term never consulted it. On a matte class the whole
    // block — the Fresnel, the probe fetch it multiplies and the quantiser — now
    // leaves the program.
    //
    // 'uToonEnvLevels' still exists and still quantises, but it is 0 on every
    // class including metal. At the three levels metal used to carry, a peak
    // radiance below 1/6 quantises to exactly zero and everything up to 1/2
    // snaps to one constant — and with 'LookdevScene' authoring
    // 'environmentIntensity = 0.28' the armour sat inside that dead zone, so the
    // reflection was being deleted outright rather than stylised.
    float awNdv = saturate( dot( geometryNormal, geometryViewDir ) );
    vec3 awF = material.specularColorBlended
      + ( vec3( material.specularF90 ) - material.specularColorBlended ) * pow( 1.0 - awNdv, 5.0 );

    vec3 awEnv = mix( awProbe * RECIPROCAL_PI, radiance, material.metalness );
    awEnv = awToonQuantise( awEnv, uToonEnvLevels );

    reflectedLight.indirectSpecular += awEnv * awF * uToonEnvSpecular;

  #endif

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
  // ---- one form ramp, shaped once -----------------------------------------
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

  // The form ramp: 'smoothstep( t - w, t + w, N·L )'. Its half-width is per
  // class — five degrees on a garment, half the N·L range on the meadow — so the
  // same expression is a toon terminator on a coat and a soft falloff on a
  // hedge. 'awToonBias' then curves it; see 'awToonBias'.
  float awBand = awToonBand( awNdl, uToonTerminator, uToonSoftness );

  #ifdef TOON_NARROW_BAND

    // The antialias floor, and *only* the floor: 'awToonEdge' can widen a
    // transition that has collapsed below 'uToonEdgePixels', never narrow one.
    // A five-degree terminator goes sub-pixel wherever a limb turns near-tangent
    // to the camera, and an unfiltered one there is a jagged staircase running
    // the length of the silhouette — the exact artefact the ink line is supposed
    // to be the only hard edge in the frame.
    //
    // This is not the term that flattened the costumes in the cel revision. That
    // one *narrowed* the band to a fixed pixel count, which turned a ramp
    // spanning a third of a figure into two flat fills. The narrowing path is
    // gone from 'awToonEdge' entirely; what is left cannot make a band tighter
    // than the preset asked for.
    awBand = awToonEdge( awBand );

  #endif

  float awShape = awToonBias( min( awBand, awVis ) );

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
  // the review found missing — with two *stated* levels a character carries a
  // real dark mass rather than living in one 45–80% band. What changed is that
  // the dark level is now the ramp's asymptote rather than a plateau: a fragment
  // reaches it only where the surface turns well away from the key, and
  // everything between the two levels is form.
  //
  // It is where the **face clamp** lives, too. A face has to resist shadowing to
  // stay readable, and the honest expression of that here is a shallow dark
  // level — the ramp still runs, so the fringe and jaw shadow keep their shape
  // and their rose-tan hue, but the step between the levels is too small to
  // carve a hole in the painted eyes. 'faceFlatten' is that number; see
  // 'FACE_SHADOW_DEPTH'.
  //
  // Measured and applied on the peak channel so the placement scales the shaded
  // level's brightness without touching the hue 'awToonShadowAlbedo' just built.
  vec3 awLitOut = awLitRad * awLitAlbedo;
  vec3 awShadeOut = awShadeRad * awShadeAlbedo;
  float awTarget = max3( awLitOut ) * clamp( uToonShadowDepth, 0.02, 1.0 );
  awShadeOut *= awTarget / max( max3( awShadeOut ), 1e-5 );

  #ifdef TOON_HIGH_BAND

    // The second lift on the lit side, for hair and metal only. A second ramp
    // further up N·L, sharing the terminator's half-width, brightening the
    // surface where it turns fully into the key. On a carved hair volume it is
    // the top plane reading brighter than the front; on a pauldron it is the
    // crown of the plate catching the sun.
    //
    // With a wide half-width this is a broad *gradient* rather than the drawn
    // band it used to be, which is the point: on the plate the bright pass over
    // an armour crown grades across roughly a third of the piece rather than
    // stopping at a contour. Multiplicative, so it scales whatever the lit level
    // came to rather than adding a fixed value that would blow out at noon and
    // vanish at dusk.
    float awHigh = awToonBand( awNdl, uToonHighBand, uToonSoftness );
    awLitOut *= mix( 1.0, max( uToonHighGain, 1.0 ), awHigh );

  #endif

  // Written as one term, into the direct accumulator. The two levels are a
  // *response to the lights* — the ambient inside them is a fill, not a probe
  // lookup — and splitting the sum across three's direct and indirect slots
  // would let '<aomap_fragment>' occlude one half of a value the placement above
  // just balanced.
  vec3 awSurface = mix( awShadeOut, awLitOut, awShape );
  reflectedLight.directDiffuse += awSurface;

  #if defined( TOON_SPECULAR ) || defined( TOON_SHEEN )

    // ---- highlight bounds, absolute then relative --------------------------
    // The highlight is accumulated per light inside 'RE_Direct_Toon', which
    // cannot know what the rest of the surface will come to, so it needs a bound
    // of its own — and a separate one from the rim's, because the two want
    // opposite things and sharing one meant every attempt to calm the rim also
    // flattened the metal.
    //
    // Compressed on the *peak channel* through a soft shoulder, so a gold
    // blade's ping stays gold and the whole highlight is scaled by one factor,
    // which leaves the gradation the shape function built across it intact. A
    // hard clamp would flatten every overshooting fragment to exactly the
    // ceiling, turning a graded highlight back into a constant-valued sticker.
    float awSpecPeak = max3( reflectedLight.directSpecular );
    float awSpecScale = awToonSoftCap( awSpecPeak, uToonSpecCeiling )
      / max( awSpecPeak, 1e-5 );

    // Then the bound that is stated against the surface underneath rather than
    // in absolute radiance, because an absolute ceiling cannot express "never
    // more than half again as bright as the hair": the same 1.7 that is a
    // discreet ping on steel is a white blaze on a dark braid, and the hair band
    // is the one mark in the frame whose whole job is to describe a *volume*
    // rather than to be the brightest thing on the character. Hair runs
    // 'specRelMax: 0.40', so the arc lands at most 1.4× the mass it sits on —
    // measured off the plates, where every bright pass on a hair mass sits well
    // inside the value range of the mass itself and never near white.
    //
    // Evaluated here because this is the first point at which the diffuse level
    // exists. It scales the whole term, so the arc's shape survives the bound.
    //
    // Compiled only where there is a lobe to bound: the fur class reaches this
    // block through 'TOON_SHEEN' and deliberately has no relative bound, because
    // a Charlie lobe *is* the silhouette of the trim and clamping it against the
    // dark albedo underneath would erase the one thing fur is for.
    #ifdef TOON_SPECULAR
      awSpecScale *= awToonSpecRelBound( awSpecPeak * awSpecScale, max3( awSurface ) );
    #endif

    // ---- and the bound on the sum, which is what a camera measures ---------
    // The two bounds above are both stated on the *mark*: one in absolute
    // radiance, one as a ratio to the surface. Neither of them can promise the
    // pixel does not clip, because a mark at 1.4x a surface that is already
    // near the top of the tone curve is still white — and that is what the
    // capture showed. Fraction of a zone above sRGB 235, ours against
    // 'bravely01.jpg': hair mass 26.07% against 0.00%, pauldron 1.41% (peaking
    // at 255) against 0.01% (peaking at 238). A quarter of every hair mass on
    // the cast was a hole rather than a band, and no amount of narrowing the
    // arc fixes a mark whose whole area sits at the clip point.
    //
    // Stated on the sum, through the same soft shoulder, so the mark spends the
    // headroom the surface has left and no more. It applies to the sheen too:
    // a fur collar's grazing lobe is the other term that can outrun its own
    // albedo without either bound above noticing.
    awSpecScale *= awToonSumBound( max3( awSurface ), awSpecPeak * awSpecScale );

    reflectedLight.directSpecular *= awSpecScale;

  #endif

  // ---- rim, a soft profile bounded twice ----------------------------------
  // REFERENCE_TARGET §1 requires a rim/back light separating the cast from the
  // background in every frame. It is a gradient along the silhouette and is left
  // as one: running it through 'awToonEdge' turned it into a hard 1.3 px light
  // line that traced every internal contour as well as the outer silhouette,
  // which is the cyan piping down the knight's arm, cape and greaves in our
  // capture — a second ink outline, in a light colour, over the one
  // 'render/Outline.js' already draws. The plate has no such line.
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
  float awRim = awToonRim( normal, geometryViewDir, awRimDirView );

  vec3 awSoFar = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse
    + reflectedLight.directSpecular + reflectedLight.indirectSpecular
    + totalEmissiveRadiance;
  float awHeadroom = 1.0 - saturate( max3( awSoFar ) / max( uToonRimCeiling, 1e-3 ) );

  // The rim's **hue** is a material decision, not a rig one, and this is where
  // the two part company. 'Lighting' publishes the back light's colour as
  // 'RING_GLOW' (#5FB8B0), a strong teal, because that is what the ring in the
  // sky is; a surface asked what to do with it answers differently depending on
  // what it is made of. On 'bravely01.jpg' and 'bravely02.jpg' no character
  // carries a coloured contour at all — separation is value and the ink line —
  // and in 'shots/mp0-cast/cast-stage.png' a teal line traced the knight's
  // pauldron, the whole back of her hair, the ponytail, the sword and the cape
  // edge, which reads as a *coating* over the entire figure. That was the
  // loudest plastic cue the frame had left.
  //
  // Desaturated at constant peak rather than dimmed, so the rig's solve for
  // 'uRimStrength' still delivers the separation it sized for and only the hue
  // is spent. 'uToonRimMax' remains the bound on the level.
  vec3 awRimTint = mix( vec3( max3( uRimColor ) ), uRimColor, clamp( uToonRimTint, 0.0, 1.0 ) );

  vec3 awRimRad = awRimTint * ( awRim * awHeadroom * uToonRimGain * uRimStrength );
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
