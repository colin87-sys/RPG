/**
 * outlineHull.js — GLSL for the inverted-hull ink line (ANIME_PIPELINE §4).
 *
 * These blocks are injected into three's `meshbasic` program by
 * `render/Outline.js`. Building on a stock material rather than on a
 * `ShaderMaterial` is the decision the whole module hangs off: the cast is
 * skinned, so the hull has to be deformed by *exactly* the same maths as the
 * surface it wraps — bit for bit, not "the same idea reimplemented". Re-deriving
 * skinning, morphing, instancing and log-depth by hand is how inverted hulls end
 * up peeling off a character halfway through an animation. Reusing three's own
 * chunks makes that class of bug unrepresentable. Fog is compiled in but left
 * *off* by `Outline.js`: this project's mist is brighter than its cast, so
 * fogging the line mixes it toward something paler than the character it closes
 * and the contour fades exactly where the silhouette needs it. Ink is a mark on
 * top of the image, not a surface standing in the atmosphere.
 *
 * Two things here are load-bearing and easy to get subtly wrong.
 *
 * **The push is in view space, scaled by view depth.** `Outline.js` uploads
 * `uOutlineDepthScale` = world-units-of-offset per unit of view depth for one
 * screen pixel × the requested pixel width, so the offset in metres grows
 * exactly as fast as the frustum does and the line holds a constant pixel
 * weight from a closeup to the far end of the battle stage. A world-space
 * offset — the naive version — is a hairline on a distant character and a
 * marker stroke on a near one. Orthographic cameras have no depth-dependent
 * frustum height, so their whole offset arrives in `uOutlineConstant` and the
 * depth term is zero; one expression covers both projections with no branch.
 *
 * **The hull is pushed along *welded* normals, not the surface's shading
 * normals.** `CharacterFactory` runs `toCreasedNormals`, which splits vertices
 * at every hard edge — and a hull pushed along split normals tears open at each
 * one, leaving a gap in the line exactly where a hair clump or a boot has its
 * sharpest silhouette. `Outline.js` supplies an `aOutlineNormal` attribute
 * holding the position-welded average, and it is fed in through
 * `beginnormal_vertex` so three's own morph and skinning chunks transform it
 * with the rest of the mesh.
 *
 * OWNED BY: render/Outline.js.
 */

/**
 * Vertex-stage declarations, prepended ahead of three's own source (so after
 * the renderer's prefix, which is where `AW_OUTLINE_NORMAL` and the precision
 * qualifiers are defined).
 */
export const OUTLINE_VERTEX_PARS = /* glsl */ `
uniform float uOutlineDepthScale;
uniform float uOutlineConstant;

#ifdef AW_OUTLINE_NORMAL
  attribute vec3 aOutlineNormal;
#endif
`;

/**
 * Replaces `#include <beginnormal_vertex>`.
 *
 * The substitution is the entire trick behind seam-free hulls: every downstream
 * chunk — `morphnormal_vertex`, `skinbase_vertex`, `skinnormal_vertex` — works
 * on `objectNormal` in place, so seeding it with the welded normal means the
 * smoothed direction is morphed and skinned by three's code rather than by a
 * copy of it. The `#else` arm is the stock chunk body verbatim, for a hull
 * built against geometry that carries no welded attribute.
 */
export const OUTLINE_BEGIN_NORMAL = /* glsl */ `
#ifdef AW_OUTLINE_NORMAL
  vec3 objectNormal = aOutlineNormal;
#else
  vec3 objectNormal = vec3( normal );
#endif
`;

/**
 * Replaces `#include <project_vertex>`; the stock chunk is kept and the hull
 * push appended, so instancing, batching and logarithmic depth stay stock and
 * `gl_Position` is simply recomputed from the displaced view position.
 */
export const OUTLINE_PROJECT = /* glsl */ `
#include <project_vertex>

// ---- AETHERWIND inverted-hull offset --------------------------------------
#if defined( USE_ENVMAP ) || defined( USE_SKINNING )

  // Those are the only two conditions under which 'meshbasic' runs the normal
  // pipeline at all — and when it does, 'objectNormal' has already been morphed
  // and skinned by the same chunks that deformed 'transformed'. Reusing it is
  // what keeps the hull welded to the surface through an animation.
  vec3 awHullNormal = objectNormal;

#else

  // Nothing declared 'objectNormal' for this program, so the welded normal is
  // seeded and morphed here instead. Inlined rather than left as an include so
  // the two substitutions this module performs stay independent of each other.
  ${OUTLINE_BEGIN_NORMAL}
  #include <morphnormal_vertex>
  vec3 awHullNormal = objectNormal;

#endif

#ifdef USE_INSTANCING
  awHullNormal = mat3( instanceMatrix ) * awHullNormal;
#endif

#ifdef USE_BATCHING
  awHullNormal = mat3( batchingMatrix ) * awHullNormal;
#endif

// Deliberately *not* 'transformedNormal'. The hull renders back faces, so three
// defines FLIP_SIDED and '<defaultnormal_vertex>' negates that vector; pushing
// along a negated normal collapses the shell inward and the outline vanishes
// entirely — a failure that only appears once someone sets 'side: BackSide',
// which for an inverted hull is always.
vec3 awHullView = normalize( normalMatrix * awHullNormal );

// 'uOutlineDepthScale' is metres-per-unit-of-view-depth for the requested pixel
// width (perspective), 'uOutlineConstant' the depth-independent part
// (orthographic). Exactly one of the two is non-zero for a given camera.
float awHullDepth = max( - mvPosition.z, 0.0 );
mvPosition.xyz += awHullView * ( uOutlineConstant + uOutlineDepthScale * awHullDepth );

gl_Position = projectionMatrix * mvPosition;
// ---- end inverted-hull offset ----------------------------------------------
`;

/** Fragment-stage declarations for the per-fragment tint. */
export const OUTLINE_FRAGMENT_PARS = /* glsl */ `
uniform float uOutlineDarkness;
uniform float uOutlineSaturation;
uniform float uOutlineFloor;
uniform vec3  uOutlineFallback;
`;

/**
 * Replaces `#include <color_fragment>`, i.e. runs once `diffuseColor` holds
 * `material.color × vColor` and before anything else touches it.
 *
 * ANIME_PIPELINE §4: "Outline colour is **not black** — use a heavily darkened,
 * saturated version of the underlying albedo, so hair gets a dark-warm line and
 * cloth a dark-cool one." This variant of the program is compiled only for hulls
 * whose albedo varies *per vertex* — a merged mesh carrying three garment
 * colours in its colour block. A hull with one flat albedo gets the identical
 * maths evaluated once on the CPU (`outlineColorFor`) and skips this entirely.
 *
 * The order of the two moves is not interchangeable. Saturation is applied at
 * constant peak — on a peak-normalised colour, `c' = 1 - (1 - c) * k` is a pure
 * HSV saturation change and nothing else — and only then is the value crushed.
 * Darkening first, or collapsing both into a single multiply toward a dark
 * colour, drains the hue as it darkens and lands on precisely the near-black
 * line the document rules out.
 *
 * `uOutlineFloor` then keeps the result off zero: a deep navy coat darkened by
 * 0.18 is black to within a code value, which would put the only pure black in
 * the frame on the subject and break ART_BIBLE §2.3's tinted value floor. And a
 * colour with *nothing* left to derive from — a hull whose geometry has no
 * colour attribute reads the WebGL default, which is black — falls back to the
 * scene's shadow tint rather than shipping that failure silently.
 */
export const OUTLINE_TINT = /* glsl */ `
#include <color_fragment>

// ---- AETHERWIND outline tint ----------------------------------------------
{
  float awPeak = max( max( diffuseColor.r, diffuseColor.g ), diffuseColor.b );
  vec3 awChroma = diffuseColor.rgb / max( awPeak, 1e-4 );
  awChroma = clamp( 1.0 - ( 1.0 - awChroma ) * uOutlineSaturation, 0.0, 1.0 );
  float awLevel = max( awPeak * uOutlineDarkness, uOutlineFloor );
  diffuseColor.rgb = mix( uOutlineFallback, awChroma * awLevel, step( 1e-4, awPeak ) );
}
// ---- end outline tint ------------------------------------------------------
`;
