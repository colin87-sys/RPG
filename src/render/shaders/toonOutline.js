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
 * OWNED BY: render/ToonMaterial.js.
 */

/** Declared ahead of three's own vertex source; the renderer's precision and
 *  built-in uniform prefix is already in front of it. */
export const TOON_OUTLINE_PARS = /* glsl */ `
uniform float uOutlineWidth;
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
