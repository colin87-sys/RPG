/**
 * toonOutline.js — inverted-hull outline vertex GLSL.
 *
 * The outline is built on `MeshBasicMaterial` rather than a `ShaderMaterial`
 * for one reason that matters and one that is merely convenient. The one that
 * matters: characters are skinned, and half of them carry morph targets for
 * facial expression, so the hull has to be deformed by the *same* skinning and
 * morph maths as the surface it hugs, to the bit. Re-deriving that in a
 * hand-written shader is how outlines end up peeling off a character mid-
 * animation. The convenient one: fog comes free, and a distant outline washing
 * into the mist with everything else is exactly what REFERENCE_TARGET §3's
 * "heavy atmospheric perspective" asks for — an outline that stays crisp at
 * 60 m would be the only object in frame ignoring the atmosphere.
 *
 * The offset is applied in **view space, scaled by the frustum's height at the
 * fragment's depth**, which makes line weight a constant fraction of the
 * viewport instead of a constant number of world metres. A world-space offset
 * is the naive version and it is visibly wrong the moment the same character
 * appears in a closeup and in the wide battle stage: the line is a hairline in
 * one shot and a black jacket in the other.
 *
 * ANIME_PIPELINE §4 adds a colour rule: "Outline colour is **not black** — use a
 * heavily darkened, saturated version of the underlying albedo, so hair gets a
 * dark-warm line and cloth a dark-cool one." That is what `TOON_OUTLINE_TINT`
 * below implements, in the fragment stage, from whatever colour the hull already
 * carries — which for a character is the per-vertex colour block it shares with
 * the surface mesh. Deriving it here rather than asking the caller for a second
 * colour per zone is the only arrangement that keeps the line correct when a
 * single merged mesh carries three garment colours.
 *
 * OWNED BY: render/ToonMaterial.js.
 */

/** Declared ahead of three's own vertex source; the renderer's precision and
 *  built-in uniform prefix is already in front of it. */
export const TOON_OUTLINE_PARS = /* glsl */ `
uniform float uOutlineWidth;
`;

/** Fragment-side uniforms, declared ahead of three's own fragment source. */
export const TOON_OUTLINE_FRAGMENT_PARS = /* glsl */ `
uniform float uOutlineDarkness;
uniform float uOutlineSaturation;
uniform vec3  uOutlineFallback;
`;

/**
 * Appended after `#include <color_fragment>`, i.e. once `diffuseColor` holds
 * `material.color × vColor` and before anything else touches it.
 *
 * The two moves are separable on purpose. Saturation is scaled at constant peak
 * — `c' = 1 - (1 - c) * k` on a peak-normalised colour is a pure HSV saturation
 * change and nothing else — and only then is value crushed. Doing it in the
 * other order, or as a single multiply toward a dark colour, desaturates as it
 * darkens and lands on the near-black line the pipeline document rules out.
 *
 * The fallback is not defensive padding. A hull whose geometry carries no
 * `color` attribute reads the WebGL default attribute, which is black, and a
 * black line is precisely what §4 forbids — so a colour with nothing left to
 * derive from falls back to the scene's shadow tint instead of shipping the
 * failure silently.
 */
export const TOON_OUTLINE_TINT = /* glsl */ `
#include <color_fragment>

// ---- AETHERWIND outline tint ---------------------------------------------
{
  float awPeak = max( max( diffuseColor.r, diffuseColor.g ), diffuseColor.b );
  vec3 awChroma = diffuseColor.rgb / max( awPeak, 1e-4 );
  awChroma = max( vec3( 0.0 ), 1.0 - ( 1.0 - awChroma ) * max( uOutlineSaturation, 0.0 ) );
  diffuseColor.rgb = mix( uOutlineFallback, awChroma * ( awPeak * uOutlineDarkness ),
                          step( 1e-4, awPeak ) );
}
// ---- end outline tint ------------------------------------------------------
`;

/**
 * Replaces `#include <project_vertex>` — the chunk is kept and the hull push
 * appended, so instancing, batching and log-depth handling stay stock.
 */
export const TOON_OUTLINE_PROJECT = /* glsl */ `
#include <project_vertex>

// ---- AETHERWIND inverted-hull outline ------------------------------------
#if defined( USE_ENVMAP ) || defined( USE_SKINNING )

  // 'meshbasic' only runs the normal pipeline under these two defines, and when
  // it does, 'objectNormal' has already been morphed and skinned by exactly the
  // chunks that deformed 'transformed'. Reusing it is what keeps the hull
  // welded to the surface through an animation.
  vec3 awOutlineNormal = objectNormal;

#else

  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  vec3 awOutlineNormal = objectNormal;

#endif

#ifdef USE_INSTANCING
  awOutlineNormal = mat3( instanceMatrix ) * awOutlineNormal;
#endif

#ifdef USE_BATCHING
  awOutlineNormal = mat3( batchingMatrix ) * awOutlineNormal;
#endif

// Deliberately *not* 'transformedNormal': the outline material renders back
// faces, so three defines FLIP_SIDED and '<defaultnormal_vertex>' negates that
// vector. Pushing along a negated normal collapses the hull inward and the
// outline disappears — a failure that only shows up once someone sets
// 'side: BackSide', which is always.
vec3 awOutlineNormalView = normalize( normalMatrix * awOutlineNormal );

// View-space height of the frustum at this depth. For a perspective camera
// projectionMatrix[1][1] is cot( fov / 2 ), so 2 * z / P[1][1] is the visible
// height in metres at distance z — multiply by that and 'uOutlineWidth' becomes
// a fraction of the viewport, constant in pixels no matter how far the subject
// stands. P[3][3] is 0 for perspective and 1 for orthographic; an ortho frustum
// has no depth-dependent height, so the depth factor drops out and the same
// expression stays correct for a map or portrait camera.
float awDepth = max( - mvPosition.z, 1e-3 );
float awFrustumHeight = ( projectionMatrix[ 3 ][ 3 ] == 0.0 ? awDepth : 1.0 ) * 2.0 / projectionMatrix[ 1 ][ 1 ];

mvPosition.xyz += awOutlineNormalView * ( uOutlineWidth * awFrustumHeight );
gl_Position = projectionMatrix * mvPosition;
// ---- end outline ----------------------------------------------------------
`;
