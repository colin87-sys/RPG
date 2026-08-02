/**
 * toonSurface.js — the GLSL blocks that turn a stock `MeshStandardMaterial`
 * into the stylised character shading model.
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
 * It is also why the highlight is now three's own `BRDF_GGX` rather than a
 * hand-rolled lobe: that function is right there in the chunk we inject after,
 * it is energy-correct, and it is what makes armour reflect like armour.
 *
 * ## The model, in the order the fragment evaluates it
 *
 *  1. **Per light** (`RE_Direct_Toon`): N·L is turned into a *wide soft ramp*
 *     (`awToonDiffuse`) and the ramp is **collected** — weighted by the light's
 *     share of the key — rather than applied. A rig with four cascades, a rim
 *     and a fill would otherwise shade one surface with six differently-oriented
 *     ramps, and their sum is a muddle rather than a form; the reference plates
 *     show one clear light direction per figure. Radiance is collected unbanded.
 *  2. **Specular** in the same pass. Isotropic surfaces get `BRDF_GGX` — a real
 *     microfacet lobe with Fresnel, so metal has a bright tight highlight and a
 *     dark body between plates. Hair gets a Kajiya-Kay band with a soft shoulder.
 *     Fur and feather get a Charlie/Neubelt sheen. Classes with no gloss compile
 *     all of it out.
 *  3. **Indirect** is held, not applied, so the composite can decide once which
 *     albedo it multiplies. Dielectrics take the probe as irradiance; **metal
 *     takes the real reflection-vector radiance**, which is the change that makes
 *     a pauldron look like steel instead of painted card. On a character class
 *     the indirect is partly flattened (`TOON_FLAT_AMBIENT` plus
 *     `uToonAmbientFlatness`) so the ambient does not fight the key for the
 *     form, but it is no longer flattened to zero order — the plates' figures are
 *     plainly lit from above by their sky.
 *  4. **Composite**: the collected ramp is resolved once, two complete surface
 *     responses are built (lit, and the hue-shifted shadow one at a stated
 *     fraction of the lit one), and the ramp **blends** between them. Then the
 *     face-flattening lift, the bounded rim and the battle-feedback pulse.
 *
 * ## What changed, and why
 *
 * This file used to implement hard two-band cel shading with a 1.3-pixel
 * terminator, a thresholded specular blob, and a three-step quantiser on the
 * environment probe. The client's reference plates (`docs/reference/`) show none
 * of those. See `shaders/toonCommon.js` for the measurements; the short version
 * is that the plate's terminators are 20–26% of a form wide and continuous, its
 * armour reflects its environment as a smooth sweep, and its highlights fall off
 * rather than stopping.
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
 *     toon response is what they feed. `BRDF_GGX` is declared by that same
 *     chunk, above this injection, so it is in scope here.
 *  2. after `<lights_physical_fragment>` — reset the per-fragment accumulators.
 *     This chunk is the last thing before the lighting loop and CSM does not
 *     touch it.
 *  3. after `<lights_fragment_end>` — the composite, once, after both the direct
 *     loop and the two indirect calls have run. It has to be one place and not
 *     per light: the whole model is "two levels, blended", and neither level is
 *     knowable until every light has reported.
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
float awToonLit;            // Σ ramp × share — the diffuse ramp, before resolution
float awToonWeight;         // Σ share — the normaliser that makes it a mean
vec3 awToonKey;             // *unramped* direct radiance, albedo not yet applied
vec3 awToonAmbient;         // indirect irradiance

void RE_Direct_Toon( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

  float ndl = dot( geometryNormal, directLight.direction );
  float ramp = awToonDiffuse( ndl );

  // How much of the key's radiance actually arrived here.
  //
  // For every cascade light this ratio *is* the shadow factor, exactly: the rig
  // drives all cascades at one colour and one intensity and publishes that
  // product as 'uKeyColor', so dividing the post-shadow radiance by it recovers
  // the scalar the shadow map returned. For a dimmer light (the rim, a torch) it
  // degrades to that light's share of the key, which is the correct weight for a
  // term whose only question is "how lit is this pixel".
  //
  // Summed, not maxed. CSM calls 'RE_Direct' once per cascade and splits the
  // radiance between two of them inside the fade band; taking a maximum there
  // would report the fragment as half-lit along the whole cascade boundary and
  // draw a visible seam across the character as it walks through it.
  float share = saturate( max3( directLight.color ) / max( max3( uKeyColor ), 1e-4 ) );
  awToonLit += ramp * share;
  awToonWeight += share;

  // The radiance is accumulated **unramped**, and the ramp is applied once in
  // the composite against the *dominant* light direction. Shading each light by
  // its own N·L gives a surface as many form-defining gradients as the rig has
  // lights, at as many angles; summed, they average out into the flat, evenly
  // filled look the client rejected. The plates show one unambiguous key per
  // figure with everything else acting as fill, which is what
  // 'awToonLit / awToonWeight' recovers: a share-weighted mean in which the key,
  // being the brightest light by construction, decides the shape.
  //
  // Cast shadows survive this intact. Three multiplies the shadow-map result
  // into 'directLight.color' before this function is called, so a shadowed
  // fragment arrives with less radiance *and* a smaller share — it darkens and
  // it pulls the mean toward the shadow level, which is how a cast shadow should
  // read: as part of the one shadow mass, not as a hole punched through it.
  awToonKey += directLight.color;

  #ifdef TOON_SPECULAR

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

      // Shaped, not cut. The hair sheens on 'bravely01.jpg' are broad soft bands
      // that fade into the hair mass; the previous hard 'smoothstep' gate put a
      // flat-topped strip of plastic across every crown.
      float awLobe = awToonSpecShape( awToonAnisoLobe( tangent, halfDir ) );

      // The highlight's colour is the surface's own, lightened and desaturated
      // toward 'uToonSpecColor' — how a hair highlight is actually painted. Pure
      // white on a saturated hair mass reads as plastic; the albedo alone reads
      // as a lighting artefact.
      vec3 awSpecTint = mix( uToonSpecColor, uToonSpecColor * material.diffuseColor,
                             clamp( uToonSpecAlbedoMix, 0.0, 1.0 ) );

      // Gated by the diffuse ramp, so the band cannot survive on the dark side
      // of the form — but by a *soft* ramp, so it fades out rather than being
      // sliced off at a terminator that no longer exists.
      reflectedLight.directSpecular += directLight.color * awSpecTint
        * ( uToonSpecGain * awLobe * ramp );

    #else

      // The isotropic highlight is three's own microfacet BRDF, and that is the
      // whole of the "make metal read as metal" correction on the direct side.
      // 'bravely02.jpg' measures the greave crowns at a near-neutral RGB
      // (197,172,173) against recesses at (54,32,43) — a bright, narrow,
      // slightly tinted specular over a dark body, which is a Fresnel-weighted
      // GGX lobe and is not reproducible with a thresholded Blinn blob at any
      // exponent. Roughness comes from the material, so 'metal' at 0.28 gets the
      // tight streak and 'leather' at 0.6 gets a broad soft one.
      float awNdl = saturate( ndl );
      reflectedLight.directSpecular += directLight.color * uToonSpecColor
        * ( BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material )
            * awNdl * uToonSpecGain );

    #endif

  #endif

  #ifdef TOON_SHEEN

    // Fur and feather trim. Additive over the diffuse rather than replacing it,
    // and deliberately *not* gated by the ramp: Charlie's lobe peaks at grazing
    // angles and is retro-reflective, so it is at its strongest exactly where a
    // fur collar is backlit, which is the read the plate's collar has. Weighted
    // by N·L only so it still dies on a surface facing fully away.
    reflectedLight.directSpecular += directLight.color * uToonSheenColor
      * ( awToonSheen( geometryNormal, directLight.direction, geometryViewDir )
          * saturate( ndl ) * uToonSheenGain );

  #endif

}

/**
 * The indirect chain, partly flattened on a character.
 *
 * The previous revision evaluated this at **zero** directional order on every
 * character class, so the hemisphere fill, the probe and the grazing fresnel
 * contributed energy but no direction at all. That was in service of keeping a
 * hard terminator the only thing varying on the surface. There is no hard
 * terminator any more, and the plates are unambiguous that their figures carry
 * real sky-to-ground ambient: the white hat in 'bravely01.jpg' is bright on top
 * and reads 142 sRGB on its shaded underside with no key light reaching it, and
 * the ninja's trousers in 'bravely05.jpg' pick up the purple ice from below.
 *
 * So the flattening becomes a *blend* rather than a switch. 'uToonAmbientFlatness'
 * says how much of the directional ambient to trade for its own average: 0 is
 * physically correct, 1 is the old behaviour, and the character presets sit low.
 * Keeping some is still worth it — a character standing under a strong sky
 * gradient otherwise loses the key's authority over the form, which is the
 * failure that made the first cast look evenly lit from nowhere.
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
  // one.
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

  // The real Schlick term, on characters too. The previous revision replaced it
  // with a constant at normal incidence on every character class, to stop the
  // grazing ramp brightening the silhouette where the ink line had to win. There
  // is no ink line any more, and the grazing lift is a large part of why the
  // plate's greaves and pauldrons read as polished: a metal edge turning away
  // from the camera catches its environment, and flattening that is what left
  // ours looking like painted card.
  float awNdv = saturate( dot( geometryNormal, geometryViewDir ) );
  vec3 awF = material.specularColorBlended
    + ( vec3( material.specularF90 ) - material.specularColorBlended ) * pow( 1.0 - awNdv, 5.0 );

  // Dielectric: irradiance only — evaluated from the shading normal, so it
  // varies smoothly and cannot form a sliding mirror hotspot on skin or cloth.
  // Metal: the genuine reflection-vector radiance three already computed,
  // unquantised.
  //
  // Unquantised is the point. The previous revision pushed this through a
  // three-step level quantiser on the theory that cel-painted armour reflects
  // its world as flat plates. The greaves in 'bravely02.jpg' do the opposite —
  // they sweep continuously from the purple of the ice below to the teal of the
  // aurora above, and that continuous sweep across a curved plate is the single
  // strongest metal cue in the whole reference set.
  vec3 awEnv = mix( awProbe * RECIPROCAL_PI, radiance, material.metalness );

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
awToonLit = 0.0;
awToonWeight = 0.0;
awToonKey = vec3( 0.0 );
awToonAmbient = vec3( 0.0 );
`;

/** Injection 3: the once-per-fragment composite. */
export const TOON_SURFACE_COMPOSITE = /* glsl */ `
{
  // ---- one ramp, resolved once --------------------------------------------
  // The share-weighted mean of every light's diffuse ramp. See 'RE_Direct_Toon'
  // for why the lights are collected rather than shaded individually, and
  // 'awToonResolve' for the gamma and the antialias floor.
  float awShape = awToonResolve( awToonLit / max( awToonWeight, 1e-4 ) );

  // ---- the two albedos ----------------------------------------------------
  // The shaded side is a *hue* shift as well as a value one, which is what makes
  // a painted shadow look painted rather than dimmed. 'awToonShadowAlbedo' does
  // the hue rotation and the saturation lift; the ramp blends between the two
  // results, so on the plate's evidence the hue travels continuously across the
  // form instead of switching at a line.
  //
  // Metal restores part of its albedo first. three zeroes 'diffuseContribution'
  // at metalness 1 because a physical metal has no diffuse lobe — but a chibi
  // pauldron carries a painted base colour under its reflection, and without
  // this the armour is nothing but environment.
  vec3 awLitAlbedo = mix( material.diffuseContribution, material.diffuseColor,
                          material.metalness * clamp( uToonMetalAlbedo, 0.0, 1.0 ) );
  vec3 awShadeAlbedo = awToonShadowAlbedo( awLitAlbedo );

  // ---- the two radiances --------------------------------------------------
  // Both levels are evaluated in full, then blended. A stylised character does
  // not have a light term that happens to fall off, it has **two levels with a
  // gradient between them**, and the ratio of those levels is art direction
  // rather than an accident of how much ambient the scene supplies.
  //
  // 'uToonShadowLift' is the share of the key the shaded level keeps, so the
  // dark side still carries the key's colour and dies with it at night; the flat
  // fill supplies the scene's shadow hue.
  vec3 awAmbient = awToonAmbient;
  vec3 awLitRad = awToonKey * RECIPROCAL_PI + awAmbient;
  vec3 awShadeRad = awToonKey * ( RECIPROCAL_PI * clamp( uToonShadowLift, 0.0, 1.0 ) )
    + awAmbient + uToonShadowFill * uToonShadowGain;

  // ---- face flattening ----------------------------------------------------
  // The face is a painted texture and the shading's job is to stay out of it.
  // Measured on 'bravely01.jpg': the lit face is one value to within ±3%
  // (p50 178, p95 187 sRGB across Elvis's cheek), and the darkest skin anywhere
  // on a face is RGB(151,130,123) against a lit RGB(186,155,147) — a ratio of
  // 0.81, and warm rather than neutral. So the clamp lifts the shaded *radiance*
  // most of the way to the lit one while leaving the ramp and the rose-tan hue
  // rotation alone: the face keeps a soft shadow *shape* under the fringe and
  // along the jaw, at a value break too gentle for a fringe to carve a hole with.
  awShadeRad = mix( awShadeRad, awLitRad, clamp( uToonShadowFloor, 0.0, 1.0 ) );

  // ---- the stated dark level ----------------------------------------------
  // The shaded level is placed at exactly 'uToonShadowDepth' of the lit level's
  // peak, measured after everything else has had its say.
  //
  // Stating it is what makes the two levels survive the scene. The hemisphere
  // fill, the environment probe and the flat shadow fill are three terms this
  // material does not own, all of which lift the dark side toward the light
  // side, and between them they used to erase the form at dusk entirely.
  // Normalising instead of clamping means the ratio holds in both directions:
  // at noon the fill cannot wash the dark side out, and at night the dark side
  // cannot collapse to black. The white hat on 'bravely01.jpg' measures 236
  // sRGB on the crown against 142 on the shaded underside — a linear ratio of
  // 0.34, which is where the cloth and skin classes sit.
  //
  // Measured and applied on the peak channel so the placement scales the shaded
  // level's brightness without touching the hue 'awToonShadowAlbedo' just built.
  vec3 awLitOut = awLitRad * awLitAlbedo;
  vec3 awShadeOut = awShadeRad * awShadeAlbedo;
  float awTarget = max3( awLitOut ) * clamp( uToonShadowDepth, 0.02, 1.0 );
  awShadeOut *= awTarget / max( max3( awShadeOut ), 1e-5 );

  // Written as one term, into the direct accumulator. The two levels are a
  // *response to the lights* — the ambient inside them is a fill, not a probe
  // lookup — and splitting the sum across three's direct and indirect slots
  // would let '<aomap_fragment>' occlude one half of a value the placement above
  // just balanced.
  reflectedLight.directDiffuse += mix( awShadeOut, awLitOut, awShape );

  // ---- highlight ceiling --------------------------------------------------
  // The highlight is accumulated per light inside 'RE_Direct_Toon', which cannot
  // know what the rest of the surface will come to, so it needs a bound of its
  // own. It is a *separate* bound from the rim's, and that separation is the
  // point: the reference armour's specular is allowed to run right up to the
  // clip point — 'bravely01.jpg' measures the knight's plates at p50 59 / p99
  // 175 / p99.9 214 / max 237 sRGB, so the hottest streaks are three to four
  // stops above the plate body — while the rim must never get near it. Sharing
  // one ceiling meant every attempt to calm the rim also flattened the metal.
  //
  // Compressed on the *peak channel* through a soft shoulder, so a gold blade's
  // ping stays gold and — the part that matters — a lobe overshooting the
  // ceiling twentyfold does not come out as a flat-topped blob with a drawn
  // edge. See 'awToonSoftCap'.
  float awSpecPeak = max3( reflectedLight.directSpecular );
  reflectedLight.directSpecular *=
    awToonSoftCap( awSpecPeak, uToonSpecCeiling ) / max( awSpecPeak, 1e-5 );

  // ---- rim, bounded twice -------------------------------------------------
  // The brief requires a rim as a separation device against a fog-coloured
  // background. The reference plates do not show one — every bright silhouette
  // band on 'bravely01.jpg' resolves to albedo (a white collar, a grey mantle),
  // and on the sun-facing edge of Elvis's coat the surface measurably *darkens*
  // into the silhouette, 188 → 136 → 99 → 69 → 41 sRGB, with no lift at all. So
  // the rim stays, and it stays quiet.
  //
  // Two independent bounds, because one is not enough:
  //
  //  - **Headroom.** The rim is spent against what is left below
  //    'uToonRimCeiling' rather than added outright. With ceiling 'c',
  //    accumulated peak 's' and rim peak 'r', the result is
  //    's + r(1 - s/c) = r + s(1 - r/c)', which for 'r <= c' rises monotonically
  //    in 's' to exactly 'c' and is suppressed to zero beyond it. That stops the
  //    same rim that glows on a dark coat from blowing a lit face past the tone
  //    curve's shoulder.
  //  - **An absolute cap.** 'uToonRimMax' bounds the rim's own radiance before
  //    it is added, and it is the bound that actually keeps the band off white.
  //    'Lighting' solves 'uRimStrength' so the hottest sliver in the frame lands
  //    at a pre-tone-map luminance of 0.55–0.92, which after ACES and the sRGB
  //    transfer is 190–215 code values — a white edge, exactly the defect this
  //    is a correction of. Nothing a preset can say about gain changes that,
  //    because the rig normalises gains away; only a cap downstream of the solve
  //    can. At the shipped 0.22–0.34 the band lands at 105–140 code values on a
  //    black surface: visible as a sheen catching the edge, never as a line.
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
