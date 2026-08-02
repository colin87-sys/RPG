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
 * holding the position-welded average in `xyz` and the crease miter scale in
 * `w`, and it is fed in through `beginnormal_vertex` so three's own morph and
 * skinning chunks transform it with the rest of the mesh.
 *
 * **The shell is guarded in depth, not merely trusted to be behind.** See the
 * comment on `uOutlineDepthGuard` inside `OUTLINE_PROJECT`; it is what stops a
 * thin garment or a self-intersecting shell from repainting the character it is
 * supposed to outline.
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
uniform float uOutlineDepthGuard;

#ifdef AW_OUTLINE_NORMAL
  // 'xyz' the welded push direction, 'w' the miter scale that keeps the line one
  // weight across a crease. See 'Outline.weldedNormals'.
  attribute vec4 aOutlineNormal;
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
  vec3 objectNormal = aOutlineNormal.xyz;
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

// The miter scale, so a vertex pushed along a crease bisector still moves the
// requested distance in each of the faces that meet there. 1.0 on a smooth
// surface, where the bisector *is* the normal.
#ifdef AW_OUTLINE_NORMAL
  float awMiter = aOutlineNormal.w;
#else
  float awMiter = 1.0;
#endif

// 'uOutlineDepthScale' is metres-per-unit-of-view-depth for the requested pixel
// width (perspective), 'uOutlineConstant' the depth-independent part
// (orthographic). Exactly one of the two is non-zero for a given camera.
float awHullDepth = max( - mvPosition.z, 0.0 );
float awPush = ( uOutlineConstant + uOutlineDepthScale * awHullDepth ) * awMiter;

// ---- the push is lateral: view-space XY only, never Z -----------------------
//
// This is the correction that turns the technique from fragile into exact, and
// it is worth being precise about what it fixes.
//
// Pushing along the full three-component view normal moves a vertex *toward the
// camera* by 'awHullView.z * awPush' wherever the surface faces the lens. An
// inverted hull survives that only while its drawn faces are further away than
// the surface by more than that amount — true for a thick closed solid, and
// false for everything a chibi character is actually made of. A cape panel, a
// tunic layer and a hair clump are two to five millimetres through, so their
// far face is *inside* the distance the push moves it forward: the shell
// overtakes the surface, writes depth in front of it, and the surface then fails
// its own depth test across the whole garment. The result is not a missing line,
// it is the entire cast repainted in flat unlit ink — which is exactly what
// shipped. The review read it as two separate defects, "there is no
// inverted-hull outline on a single party member" and "costume colour is
// desaturated beige-grey across half the cast", and they are one defect: what
// the frame showed was the outline, at character size.
//
// The line's weight is a screen-space quantity, so the offset that produces it
// is a screen-space offset. Dropping the Z component makes it exactly that:
// 'uOutlineDepthScale' is already world-units-per-pixel-per-unit-depth, so
// 'awHullView.xy * awPush' spans precisely 'width' pixels — the previous form
// spent part of that budget on depth and drew a line thinner than it asked for —
// and the shell's depth becomes *identical* to the source surface's, vertex for
// vertex. It can no longer overtake anything, on any thickness of geometry, at
// any camera angle. The taper is self-correcting too: 'awHullView.xy' falls to
// zero as a face turns to meet the lens, which is the definition of "not on the
// silhouette", and reaches full length exactly where the contour is.
mvPosition.xy += awHullView.xy * awPush;

// ---- the slide guard --------------------------------------------------------
//
// A lateral offset moves the shell *along* the surface it copies, and a surface
// seen at an angle recedes as it slides: over a shift of 'awPush' its depth
// changes by 'awPush * |n.xy| / |n.z|', the tangent of the angle between its
// normal and the view axis. On a closed solid that is harmless — the shell's far
// face is a whole body thickness behind the near one, and no slide of a couple
// of pixels closes that. On a *single-layer* surface there is no far face at
// all: the shell's drawn fragment is the same sheet, slid, and the slide is the
// only thing separating them. It surfaces in front of its own source, writes
// depth there, and the source then fails its own depth test — the shell wins the
// whole garment instead of a two-pixel ring. Most of a chibi character is that
// kind of surface: a cape panel, a tunic layer, a hair clump, a sleeve.
//
// Subtracting the same quantity puts the shell back on the depth the surface
// would have had, so the two are separated by geometry rather than by luck. The
// ratio diverges as a face turns edge-on, which is the one place the shell is
// *meant* to win, so it is capped: 8 covers surfaces up to 83° off-axis exactly
// and the rest fall back to that fixed clearance, which is the trade — beyond it
// the guard would start pushing the *ring* behind the ground a boot stands on,
// and a line that sinks is worse than a shell that occasionally surfaces on a
// near-tangent sliver. 'uOutlineDepthGuard'
// is the remaining constant term: two coplanar triangles offset laterally do not
// interpolate to bit-identical depth at a shared pixel, and half a line width
// settles that without sinking a boot's contour into the ground it stands on.
float awSlide = min( length( awHullView.xy ) / max( abs( awHullView.z ), 0.125 ), 8.0 );
mvPosition.z -= awPush * ( uOutlineDepthGuard + awSlide );

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
