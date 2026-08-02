/**
 * Outline.js — the inverted-hull ink line. **Off by default; see below.**
 *
 * ## Why this is disabled
 *
 * `docs/ANIME_PIPELINE.md` names a missing ink line as one of four causes of the
 * first cast's rejection, and this module was written to supply one. The
 * client's actual reference screenshots then arrived in `docs/reference/`, and
 * they do not have one. That is not an impression; it was measured on four
 * silhouette crossings chosen for a clean background, and an inverted hull is
 * trivially detectable — a 2 px shell at 0.18× albedo puts a 2–4 px trough well
 * *below* the background level in front of every lit edge:
 *
 *  - `bravely01.jpg`, the white hat against dark foliage at y=330: background
 *    runs 50–83 sRGB, the last pixels before the hat read 57 69 83 72 83 77 113,
 *    then 177 inside. No pixel dips below the background band at all.
 *  - `bravely01.jpg`, Seth's pauldron against bright lavender at x=350: 114 68
 *    27 22 — three pixels from background to armour, monotonic, no pre-edge dip.
 *  - `bravely02.jpg`, a white boot against smooth purple ice at y=470: ice 155,
 *    a single pixel at 141 (−9%, one pixel wide, i.e. antialiasing or a contact
 *    darkening), then 201 234 236.
 *  - `bravely05.jpg`, the ninja's hair against a smooth sky at y=140: sky 37,
 *    the darkest edge pixel 34. Three code values on a 37 background, one pixel.
 *
 * A drawn ink line is not a subtle effect and none of those is one. The client's
 * note is the same finding in words — "we added a heavy ink outline and hard cel
 * banding; the plate has neither" — so `OUTLINE_DEFAULTS.enabled` ships `false`
 * and the machinery stays behind {@link setOutlineEnabled}.
 *
 * Nothing here is deleted. The hull is correctly welded, correctly skinned and
 * correctly parented, and this is exactly the sort of art direction that gets
 * revisited; deleting a working implementation to express a default is how a
 * project ends up rebuilding it badly six weeks later. Turning it on gives a far
 * lighter line than it used to — `width` 1.0 px rather than 2.0 and `darkness`
 * 0.30 rather than 0.18, which is roughly the strength of the contact darkening
 * the plates *do* show at some material boundaries, rather than the marker
 * stroke the previous default drew.
 *
 * ## What it is
 *
 * Not a post-process edge filter — those key off depth and normal
 * discontinuities, so they miss the inside of a silhouette and shimmer on a
 * moving character. It is geometry.
 *
 * ## The technique, and the five ways it goes wrong
 *
 * Duplicate the mesh, render it with `side: BackSide` (three culls front faces),
 * and push every vertex out along its normal. The shell is hidden inside the
 * character everywhere except where it pokes past the silhouette, where it reads
 * as a line of constant weight. Five details decide whether that looks like an
 * inked drawing or like a mistake:
 *
 * 1. **The push is in view space, scaled by view depth.** A world-space offset
 *    is the naive version: it is a hairline on a character at the back of the
 *    battle stage and a marker stroke on one in a closeup. Scaling by the
 *    frustum's height at the vertex's own depth makes the line a constant number
 *    of *pixels* — `updateOutlineScale` derives the factor from the camera and
 *    the viewport, and `shaders/outlineHull.js` applies it in the view plane.
 * 2. **The hull is skinned by the same skeleton.** A hull that is not skinned
 *    stays in bind pose and the character walks out of its own outline. Here the
 *    hull is a `SkinnedMesh` sharing the source's `skeleton`, `bindMatrix` and
 *    `bindMode`, and it is pushed along a normal that three's own
 *    `skinnormal_vertex` chunk has deformed — not along a re-derived one.
 * 3. **The push follows *welded* normals, within a cone.** `CharacterFactory`
 *    runs `toCreasedNormals`, so vertices are split at every hard edge and their
 *    normals diverge. Pushing along those tears the shell open at each crease —
 *    a gap in the line exactly at a hair clump's point or a boot's corner, which
 *    is where the silhouette is doing the most work. `buildOutlineGeometry`
 *    computes a position-welded average into an `aOutlineNormal` attribute, and
 *    limits it to a cone so that two *unrelated* surfaces sharing a position —
 *    a clump bedded on a skull, a sleeve sunk into a torso — are not averaged
 *    into a direction that points into the body. The same attribute carries the
 *    miter scale that keeps the line one weight across a crease.
 * 4. **The push is lateral — view-space XY, never Z.** Back-face culling alone
 *    does not guarantee the hull loses to the surface it wraps. Pushed along the
 *    full 3D normal, the shell moves toward the camera wherever the surface
 *    faces the lens, and on geometry thinner than that motion — a tunic layer, a
 *    cape panel, a hair clump, i.e. most of a chibi character — it overtakes the
 *    surface and occludes it. The cast shipped that way: what looked like "no
 *    outline anywhere and desaturated beige-grey costumes" was the outline,
 *    drawn at character size. Offsetting in XY alone makes the line exactly the
 *    requested number of pixels wide *and* leaves the shell's depth identical to
 *    the surface's, so it cannot occlude anything at any thickness.
 * 5. **The line is not black.** The rule is a heavily darkened, saturated
 *    version of the albedo underneath, so hair takes a dark-warm line and cloth
 *    a dark-cool one. `outlineColorFor` is that transform, and it is exposed per
 *    material.
 *
 * ## Depth, and the post chain
 *
 * The hull is **opaque and writes depth normally**. `PostFX` runs SSAO, DOF and
 * motion blur off the beauty pass's own depth texture, so the alternative — a
 * transparent, depth-write-disabled line — would leave the outline as a hole in
 * the depth buffer, and DOF would compute its circle of confusion there from
 * whatever lies *behind* the character. The result is a character crisply in
 * focus wearing a background-blurred halo. It is safe to write depth because
 * the shell is offset laterally only, so its depth is the surface's own: the
 * hull is drawn first (`renderOrder - 1`) and the surface's `LEQUAL` test wins
 * every pixel they contest, with `depthGuard` breaking the float-error ties.
 *
 * ## Contract
 *
 *   setOutlineEnabled( on )                         // off by default
 *   isOutlineEnabled()                              -> boolean
 *   buildOutline( mesh, opts )                      -> THREE.Mesh | null
 *   buildOutlines( root, opts )                     -> THREE.Mesh[]
 *   updateOutlineScale( mesh, camera, viewportHeight )
 *   createOutlineMaterial( opts )                   -> THREE.MeshBasicMaterial
 *   outlineColorFor( albedo, opts )                 -> THREE.Color
 *   setOutlineWidth( target, pixels )
 *   setOutlineSkip( target, skip )
 *   disposeOutline( target )
 *
 * `buildOutline` allocates a geometry and (unless one is supplied) a material;
 * both are the caller's to release through `disposeOutline`, which is written to
 * be safe about the attribute buffers the hull *shares* with its source.
 *
 * OWNED BY: render/Outline.js. Consumers: `characters/*`, `world/*`, `battle/*`.
 */
import * as THREE from 'three';
import { LIGHT } from '../art/Palette.js';
import {
  OUTLINE_VERTEX_PARS,
  OUTLINE_BEGIN_NORMAL,
  OUTLINE_PROJECT,
  OUTLINE_FRAGMENT_PARS,
  OUTLINE_TINT,
} from './shaders/outlineHull.js';

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Art defaults for the line. Frozen and exported so a debug panel or a capture
 * scenario can read the shipped values instead of guessing them.
 *
 * `enabled` is `false`, and it is the headline: the reference plates carry no
 * ink line and the measurements are in the module header.
 *
 * The rest describe the line a caller gets if they turn it back on, and they are
 * a long way from where they were. `width` is in **device pixels**, which is
 * what "constant screen-space weight" means. 1.0 px, not the 2.0 this shipped
 * at: the strongest edge darkening anywhere in `docs/reference/` is a single
 * pixel about 9% under its background, so a two-pixel mark at 82% under is two
 * orders of the wrong thing. One pixel with a light `darkness` is the closest
 * this technique gets to what the plates actually show.
 *
 * `darkness` and `saturation` are the colour rule: a heavily darkened, saturated
 * version of the albedo underneath, so hair takes a dark-warm line and cloth a
 * dark-cool one. 0.30 rather than 0.18 for the same reason as the width —
 * against a bright meadow a 0.18 line is a black border, and a border is what
 * the client rejected. Pushing saturation up on the way down stops the darkening
 * from also draining the hue and landing on a neutral near-black. 1.25 rather
 * than the 1.55 this shipped at, because the saturation identity clamps: on any
 * garment darker than mid — most of this cast — 1.55 drove two of the three
 * channels to exactly zero, so a navy coat, a teal sash and a violet cape all
 * resolved to the same single-channel line, and the very term meant to protect
 * the per-surface hue threw it away. `floor` keeps a very dark albedo — a deep
 * navy, which crushes to black inside a code value at this level — off zero, so
 * no pure black lands on the subject (ART_BIBLE §2.3).
 *
 * `depthGuard` is a tie-breaker, in multiples of the lateral push. The shell is
 * offset in view-space *XY only* (see `shaders/outlineHull.js`), so it can never
 * move toward the camera and can never occlude the surface it wraps; all this
 * has left to settle is the float error between two coplanar triangles offset
 * laterally, which half a line width covers with room to spare.
 *
 * `fog: false`, and it is the correction the review demanded rather than a
 * convenience. This project's environment is built on heavy mist, and the mist
 * is *brighter* than the cast — the review measured the mist band at L≈149
 * against a party at L≈80. A fogged ink line is therefore mixed toward something
 * paler than the character it is supposed to close, so the line gets weaker with
 * distance precisely where the silhouette needs it most, and on a heavily hazed
 * figure it inverts into a light edge. Ink is a drawn mark on top of the image,
 * not a surface in the scene: it does not stand in the atmosphere, so nothing in
 * the atmosphere may lift it.
 */
export const OUTLINE_DEFAULTS = Object.freeze({
  enabled: false,
  width: 1.0,
  darkness: 0.30,
  saturation: 1.25,
  floor: 0.008,
  fog: false,
  depthGuard: 0.5,
});

/**
 * Whether {@link buildOutline} produces anything.
 *
 * Module state rather than a per-call option because it is a project-wide art
 * decision, and the two call sites that build character hulls
 * (`CharacterFactory`, `LookdevScene`) pass a line *width* without asking
 * whether there should be a line at all. A switch here reaches both without
 * either of them having to know the answer.
 */
let _enabled = OUTLINE_DEFAULTS.enabled;

/**
 * Reference projection used until `updateOutlineScale` is first called: a 50°
 * vertical FOV at 1080p, which is the middle of REFERENCE_TARGET §2's battle
 * camera and the capture harness's viewport. A hull that never sees a scale
 * update therefore draws a plausible line rather than none at all — but the
 * per-frame call is still required, because nothing else tracks a FOV change,
 * a resize or a cut to an orthographic map camera.
 */
const REFERENCE_FOV_DEGREES = 50;
const REFERENCE_VIEWPORT_HEIGHT = 1080;

/**
 * Metres of offset, per screen pixel of line width, per unit of view depth.
 * Module state rather than per-material state because it is a property of the
 * *camera*, shared by every hull in the frame; keeping one copy is what lets
 * `setOutlineWidth` take effect immediately instead of waiting for the next
 * `updateOutlineScale`.
 */
let _metresPerPixel = (2 * Math.tan((REFERENCE_FOV_DEGREES * Math.PI) / 360))
  / REFERENCE_VIEWPORT_HEIGHT;
let _orthographic = false;

/**
 * Every live outline material, so a per-frame `updateOutlineScale(null, …)` can
 * rescale the whole frame without walking the scene graph. Entries remove
 * themselves when the material is disposed, by whatever route.
 */
const _materials = new Set();

/** `userData` flag honoured on meshes, subtrees and materials. */
const SKIP_FLAG = 'noOutline';

/** Vertex positions closer than this (in metres) are treated as one vertex when
 *  averaging normals. 0.1 mm is far below any feature a chibi character has and
 *  far above the float error a merge or a bind-pose transform introduces. */
const WELD_TOLERANCE = 1e-4;

/**
 * How far apart two normals at one position may be and still be averaged.
 *
 * `cos 100°`. The welder exists to close the splits `toCreasedNormals` makes at
 * a hard edge, and a *crease* is two faces of the same solid meeting at an
 * angle: 30–60° on a hair clump's point, a full 90° on a boot's corner or a
 * blade's spine. What it must not do is average normals belonging to two
 * surfaces that merely happen to touch, and a character is full of those — a
 * merged shading class is a hundred separate parts, and every clump bedded on
 * the skull, every sleeve sunk into a torso and every strap crossing a coat puts
 * two unrelated, often *opposed*, normals inside the same 0.1 mm bucket. A hair
 * over that pair of right angles is therefore the right place to draw the line:
 * it admits every genuine crease and rejects everything facing backwards.
 *
 * Averaging without it produced the measured defect. Across the shipped cast,
 * 8–18% of hair, cloth and metal vertices had a welded normal more than 57° off
 * their own shading normal, and the worst were fully reversed (dot −0.9). A
 * vertex pushed along a reversed normal travels into the body while its
 * neighbours travel out, which tears the shell open — the review's "broken
 * [line], visible along the upper back and shoulder, dropping to dotted
 * fragments along the rear legs and belly".
 */
const WELD_CONE = -0.17;

/**
 * The averaged direction must keep at least this much of the vertex's own
 * normal, or the vertex keeps its own instead.
 *
 * `cos 78°`. The cone above bounds each *contributor*; this bounds the *result*,
 * and the two are not the same guarantee — a vertex where five surfaces meet can
 * take five admissible normals and still average to something almost tangential.
 * A tangential push slides a vertex along the surface instead of out of it,
 * which is a tear rather than a line. Falling back to the shading normal there
 * gives a locally correct offset and, at worst, a hairline seam at one vertex.
 */
const WELD_MIN_AGREEMENT = 0.2;

/**
 * Floor on the miter scale, as `cos θ` between the welded and shading normals.
 *
 * `cos 60°` = 0.5, so the correction is capped at 2×. See `weldedNormals` for
 * what it corrects; the cap keeps a pathological vertex from throwing a spike
 * the length of a limb.
 */
const MITER_LIMIT = 0.5;

/* -------------------------------------------------------------------------- */
/* Colour                                                                     */
/* -------------------------------------------------------------------------- */

/** Coerce a hex / `THREE.Color` / rgb array into a fresh `THREE.Color`. */
function toColor(v) {
  if (v instanceof THREE.Color) return v.clone();
  if (Array.isArray(v)) return new THREE.Color(v[0], v[1], v[2]);
  return new THREE.Color(v);
}

/**
 * The line colour, evaluated on the CPU.
 *
 * Identical maths to `OUTLINE_TINT` in the shader — deliberately, so a flat hull
 * and a per-vertex-coloured one cannot drift apart — and the ordering is the
 * part that matters. Saturation is applied at constant peak first
 * (`c' = 1 - (1 - c) * k` on a peak-normalised colour is a pure HSV saturation
 * change), and only then is value crushed. Darkening first, or folding both into
 * one multiply toward a dark colour, desaturates as it darkens and produces the
 * grey-black line the document forbids.
 *
 * Everything happens in three's linear working space, which is where a
 * multiplicative darkening is meaningful.
 *
 * @param {THREE.ColorRepresentation} albedo the surface colour underneath.
 * @param {Object} [opts]
 * @param {number} [opts.darkness=0.30] value multiplier.
 * @param {number} [opts.saturation=1.25] HSV saturation multiplier.
 * @param {number} [opts.floor=0.008] minimum peak channel, so no line is black.
 * @returns {THREE.Color}
 */
export function outlineColorFor(albedo, opts = {}) {
  const darkness = opts.darkness ?? OUTLINE_DEFAULTS.darkness;
  const saturation = opts.saturation ?? OUTLINE_DEFAULTS.saturation;
  const floor = opts.floor ?? OUTLINE_DEFAULTS.floor;

  const c = toColor(albedo);
  const peak = Math.max(c.r, c.g, c.b);

  // Nothing to derive a hue from. The scene's shadow tint is the honest answer:
  // it is where every other unlit colour in the game already sits, and it is not
  // black.
  if (peak <= 1e-4) return fallbackColor(floor);

  const level = Math.max(peak * darkness, floor);
  c.r = THREE.MathUtils.clamp(1 - (1 - c.r / peak) * saturation, 0, 1) * level;
  c.g = THREE.MathUtils.clamp(1 - (1 - c.g / peak) * saturation, 0, 1) * level;
  c.b = THREE.MathUtils.clamp(1 - (1 - c.b / peak) * saturation, 0, 1) * level;
  return c;
}

/** The shadow tint, peak-normalised and scaled to `level`. Peak rather than
 *  luminance so it composes with `outlineColorFor`, which works in peaks. */
function fallbackColor(level) {
  const c = new THREE.Color(LIGHT.SHADOW_TINT);
  return c.multiplyScalar(level / (Math.max(c.r, c.g, c.b) || 1e-6));
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/** Scratch, so per-character geometry maths allocates nothing. */
const _v3 = new THREE.Vector3();

/**
 * Is this geometry wound inside-out?
 *
 * The divergence theorem on a triangle soup: `Σ a · (b × c) / 6` is the enclosed
 * volume, positive when the winding — and therefore every normal
 * `computeVertexNormals` or `toCreasedNormals` derives from it — faces outward.
 * A geometry assembled from swept sections whose parametrisation happens to run
 * the other way comes out negative, and *everything* downstream is then
 * reversed: the surface is lit from inside, and an inverted hull pushed along
 * those normals deflates instead of inflating, so the line simply does not
 * exist. The boss in the shipped frame measures −0.19 here, which is both why it
 * reads as "a single flat unshaded blue value with no form" and why its outline
 * survives only as dotted fragments.
 *
 * A hull cannot fix the shading — that is the source geometry's problem — but it
 * has no excuse for inheriting the fault, so `buildOutlineGeometry` flips the
 * normals it pushes along when this reports an inversion.
 *
 * Two details are load-bearing. The sum is taken **about the geometry's own
 * centroid**, not about the object origin: the identity is origin-independent
 * only for a *closed* surface, and a merged shading class is a hundred parts of
 * which several are open shells, so an origin at the feet of a 1.1 m character
 * lets the open boundaries dominate the sum and invert its sign. And **every**
 * triangle is counted rather than a sample, for the same reason — with open
 * boundaries in the sum there is no guarantee that a stride keeps the sign. It
 * is a few thousand triangles, once, at build time.
 */
function windingIsInverted(position, index) {
  const triangles = Math.floor((index ? index.count : position.count) / 3);
  if (triangles < 1) return false;
  const at = (k) => (index ? index.getX(k) : k);

  let ox = 0, oy = 0, oz = 0;
  for (let i = 0; i < position.count; i++) {
    ox += position.getX(i); oy += position.getY(i); oz += position.getZ(i);
  }
  ox /= position.count; oy /= position.count; oz /= position.count;

  let volume = 0;
  for (let t = 0; t < triangles; t++) {
    const a = at(t * 3);
    const b = at(t * 3 + 1);
    const c = at(t * 3 + 2);
    const ax = position.getX(a) - ox, ay = position.getY(a) - oy, az = position.getZ(a) - oz;
    const bx = position.getX(b) - ox, by = position.getY(b) - oy, bz = position.getZ(b) - oz;
    const cx = position.getX(c) - ox, cy = position.getY(c) - oy, cz = position.getZ(c) - oz;
    volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return volume < 0;
}

/**
 * Position-welded push normals, plus the miter scale each one needs.
 *
 * Returns a `vec4` attribute: `xyz` is the direction to push along, `w` is how
 * far to push relative to the requested line weight.
 *
 * **xyz — closing the creases.** `CharacterFactory` runs `toCreasedNormals`, so
 * a vertex on a hard edge exists two or three times with divergent normals.
 * Pushing each copy along its own normal opens a gap in the shell exactly at a
 * hair clump's point or a boot's corner, which is where the silhouette does most
 * of its work. Averaging the *distinct* normals within `WELD_CONE` of the
 * vertex's own recovers the direction that carries every copy to the same place.
 *
 * Distinct is deliberate: a plain sum weights each smoothing group by how many
 * triangles happen to touch the corner, which on a non-indexed box gives
 * `(1,1,2)` instead of `(1,1,1)` purely because one face's triangulation fans
 * through it twice. That is the tessellation's opinion, not the surface's.
 *
 * The cone is the correction this function was rewritten for; see `WELD_CONE`.
 *
 * **w — keeping the line one weight.** A vertex on a 90° crease is pushed along
 * the 45° bisector, so the two faces meeting there only move `cos 45° = 0.71`
 * of the requested distance *in their own planes* and the line thins at every
 * corner. This is the same problem a stroked polyline has at a joint and it has
 * the same answer: divide by the cosine between the push direction and the
 * face's own normal. `MITER_LIMIT` caps the correction so a near-degenerate
 * vertex cannot throw a spike.
 */
function weldedNormals(geometry, tolerance) {
  const position = geometry.getAttribute('position');
  let normal = geometry.getAttribute('normal');

  if (!normal) {
    // No shading normals to average. Deriving them on a throwaway geometry that
    // *shares* this one's buffers is the cheapest correct route and leaves the
    // source untouched — it is never rendered, so it allocates nothing on the
    // GPU and needs no disposal.
    const tmp = new THREE.BufferGeometry();
    tmp.setAttribute('position', position);
    if (geometry.index) tmp.setIndex(geometry.index);
    tmp.computeVertexNormals();
    normal = tmp.getAttribute('normal');
  }

  // One sign for the whole geometry, applied to the *shading* normals before
  // anything is averaged, so the cone test and the miter both operate on
  // outward-facing directions whichever way the source was wound.
  const flip = windingIsInverted(position, geometry.index) ? -1 : 1;

  const count = position.count;
  const out = new Float32Array(count * 4);
  const own = new Float32Array(count * 3);
  const bucketOf = new Int32Array(count);
  const distinct = [];
  const buckets = new Map();
  const q = 1 / tolerance;

  for (let i = 0; i < count; i++) {
    const key = `${Math.round(position.getX(i) * q)},`
      + `${Math.round(position.getY(i) * q)},`
      + `${Math.round(position.getZ(i) * q)}`;
    let b = buckets.get(key);
    if (b === undefined) {
      b = distinct.length;
      buckets.set(key, b);
      distinct.push([]);
    }
    bucketOf[i] = b;

    const len = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) || 1;
    const nx = (normal.getX(i) / len) * flip;
    const ny = (normal.getY(i) / len) * flip;
    const nz = (normal.getZ(i) / len) * flip;
    own[i * 3] = nx; own[i * 3 + 1] = ny; own[i * 3 + 2] = nz;

    const seen = distinct[b];
    let duplicate = false;
    for (let k = 0; k < seen.length; k += 3) {
      if (nx * seen[k] + ny * seen[k + 1] + nz * seen[k + 2] > 0.9999) { duplicate = true; break; }
    }
    if (!duplicate) seen.push(nx, ny, nz);
  }

  for (let i = 0; i < count; i++) {
    const nx = own[i * 3], ny = own[i * 3 + 1], nz = own[i * 3 + 2];
    const seen = distinct[bucketOf[i]];

    // Averaged per vertex rather than per bucket, because the cone is measured
    // against *this* vertex's normal: two faces of one crease each pull in the
    // other, while a third surface that merely passes through the same point is
    // excluded from both. A single bucket-wide average cannot express that.
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < seen.length; k += 3) {
      if (nx * seen[k] + ny * seen[k + 1] + nz * seen[k + 2] < WELD_CONE) continue;
      x += seen[k]; y += seen[k + 1]; z += seen[k + 2];
    }

    let len = Math.hypot(x, y, z);
    // Two rejections, both to the vertex's own normal: a degenerate average
    // (only reachable on denormal input, since the cone always admits the
    // vertex itself), and one that has drifted too far to still be an outward
    // push. See `WELD_MIN_AGREEMENT`.
    if (len > 1e-6) { x /= len; y /= len; z /= len; }
    if (len < 1e-6 || x * nx + y * ny + z * nz < WELD_MIN_AGREEMENT) { x = nx; y = ny; z = nz; }

    out[i * 4] = x;
    out[i * 4 + 1] = y;
    out[i * 4 + 2] = z;
    out[i * 4 + 3] = 1 / Math.max(x * nx + y * ny + z * nz, MITER_LIMIT);
  }

  return new THREE.BufferAttribute(out, 4);
}

/**
 * The hull's geometry: a distinct `BufferGeometry` that **shares** the source's
 * attribute buffers and adds one of its own.
 *
 * Sharing rather than cloning is worth being explicit about. The hull needs the
 * source's positions, UVs, colours and — critically — its `skinIndex` /
 * `skinWeight`, byte for byte; a clone would double the vertex memory of every
 * character in the party to hold a second copy of numbers that can never differ.
 * The only genuinely new buffer is `aOutlineNormal`. The price is that
 * `dispose()` on this geometry would delete GPU buffers the *source* is still
 * drawing from, so the shared names are recorded here and `disposeOutline`
 * detaches them first.
 *
 * `aOutlineNormal` is a `vec4`: the welded push direction and, in `w`, the miter
 * scale. See {@link weldedNormals}.
 *
 * @param {THREE.BufferGeometry} source
 * @param {Object} [opts]
 * @param {number[]} [opts.materialIndexMap] source material index → hull material
 *   index, with a negative entry dropping that material's groups entirely. This
 *   is how a submesh inside a merged mesh — the eyes — opts out of being
 *   outlined. Absent, groups are copied verbatim.
 * @param {number} [opts.tolerance=1e-4] weld distance for normal averaging.
 * @returns {THREE.BufferGeometry}
 */
export function buildOutlineGeometry(source, opts = {}) {
  const hull = new THREE.BufferGeometry();
  hull.name = `${source.name || 'geometry'}::outline`;

  const shared = [];
  for (const name in source.attributes) {
    hull.setAttribute(name, source.attributes[name]);
    shared.push(name);
  }
  if (source.index) hull.setIndex(source.index);

  // Morph *positions* ride along so a hull follows a facial expression; morph
  // *normals* deliberately do not. Their deltas were authored against the split
  // shading normals, and applying them to a welded normal is worse than not
  // applying them at all — the rest-pose smoothed direction is a good
  // approximation of the morphed one, an unwelded seam is not.
  if (source.morphAttributes?.position) {
    hull.morphAttributes.position = source.morphAttributes.position;
    hull.morphTargetsRelative = source.morphTargetsRelative;
  }

  const map = opts.materialIndexMap;
  for (const g of source.groups) {
    // The caller compacts the material array as it drops entries and hands the
    // mapping in, rather than this function inventing one from group order —
    // the two orderings can differ, and a hull whose groups point at the wrong
    // material draws a garment's line in a face's colour.
    const index = map ? map[g.materialIndex] ?? -1 : g.materialIndex;
    if (index < 0) continue;
    hull.addGroup(g.start, g.count, index);
  }
  hull.setDrawRange(source.drawRange.start, source.drawRange.count);

  hull.setAttribute('aOutlineNormal', weldedNormals(source, opts.tolerance ?? WELD_TOLERANCE));

  // Culling volumes are copied rather than recomputed — same positions, same
  // answer — with a small margin for the push itself, so a character does not
  // lose its outline a frame before it leaves the screen edge.
  if (source.boundingSphere) {
    hull.boundingSphere = source.boundingSphere.clone();
    hull.boundingSphere.radius *= 1.02;
  }
  if (source.boundingBox) {
    hull.boundingBox = source.boundingBox.clone();
    hull.boundingBox.expandByScalar(hull.boundingBox.getSize(_v3).length() * 0.01);
  }

  hull.userData.outlineShared = shared;
  return hull;
}

/* -------------------------------------------------------------------------- */
/* Material                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build a material for an inverted hull.
 *
 * A `MeshBasicMaterial` patched through `onBeforeCompile`, so skinning, morphs,
 * instancing, fog and tone mapping are three's implementations rather than
 * reimplementations of them — see `shaders/outlineHull.js` for why that is the
 * whole design and not a shortcut.
 *
 * @param {Object} [opts]
 * @param {THREE.ColorRepresentation} [opts.albedo] the surface colour underneath;
 *   the line colour is derived from it by {@link outlineColorFor}.
 * @param {THREE.ColorRepresentation} [opts.color] an explicit line colour, used
 *   verbatim. Overrides `albedo`.
 * @param {boolean} [opts.vertexColors=false] derive the line per fragment from
 *   the hull's colour attribute instead. This is what gives a single merged
 *   character mesh a dark-warm line on hair and a dark-cool one on cloth.
 * @param {number} [opts.width=1] line weight in device pixels.
 * @param {number} [opts.darkness] / [opts.saturation] / [opts.floor] tint
 *   controls; meaningful with `vertexColors`, folded into the colour otherwise.
 * @param {boolean} [opts.fog=false] let the atmosphere lift the line. Off by
 *   default; see `OUTLINE_DEFAULTS`.
 * @param {THREE.Texture} [opts.alphaMap] / [opts.alphaTest] cutout, inherited
 *   from the source material so an alpha-tested card is outlined at its cut
 *   edge rather than at the edge of its quad.
 * @param {number} [opts.depthGuard=0.5] tie-breaking nudge away from the camera,
 *   as a multiple of the lateral push; see `OUTLINE_DEFAULTS`.
 * @param {boolean} [opts.weldedNormals=true] push along the `aOutlineNormal`
 *   attribute that {@link buildOutlineGeometry} adds. Materials and geometry are
 *   decoupled here — a caller may share one material across hulls it built
 *   itself — so this has to be switchable: with the attribute absent the shader
 *   would reference an undeclared name and fail to compile. Turning it off falls
 *   back to the shading normal, which tears the shell open at hard edges.
 * @param {boolean} [opts.fog=false] see `OUTLINE_DEFAULTS`.
 * @returns {THREE.MeshBasicMaterial}
 */
export function createOutlineMaterial(opts = {}) {
  const vertexColors = opts.vertexColors ?? false;
  const tint = {
    darkness: opts.darkness ?? OUTLINE_DEFAULTS.darkness,
    saturation: opts.saturation ?? OUTLINE_DEFAULTS.saturation,
    floor: opts.floor ?? OUTLINE_DEFAULTS.floor,
  };

  // With one flat albedo the tint transform has a single answer, so it is
  // evaluated once here and the fragment stage never sees it: the material's
  // own `color` *is* the line colour, which is both cheaper and the property an
  // author expects to find when they go looking for it. Only a hull whose albedo
  // varies per vertex needs the per-fragment path.
  let color;
  if (opts.color !== undefined) color = toColor(opts.color);
  else if (vertexColors) color = new THREE.Color(1, 1, 1);
  else color = outlineColorFor(opts.albedo ?? 0xffffff, tint);

  const material = new THREE.MeshBasicMaterial({
    name: opts.name ?? 'outline',
    color,
    vertexColors,
    alphaMap: opts.alphaMap ?? null,
    alphaTest: opts.alphaTest ?? 0,
    // BackSide is the inversion: three culls front faces, so the shell is
    // visible only where it escapes the silhouette.
    side: THREE.BackSide,
    fog: opts.fog ?? OUTLINE_DEFAULTS.fog,
    // Opaque and depth-writing, for the post chain's sake — see the module
    // header. A transparent line would also need sorting against the character
    // it wraps and would show its own seam wherever the shell self-overlaps at
    // a concave joint.
    transparent: false,
    depthWrite: true,
    depthTest: true,
    toneMapped: true,
  });

  const uniforms = {
    uOutlineDepthScale: { value: 0 },
    uOutlineConstant: { value: 0 },
    uOutlineDepthGuard: { value: Math.max(opts.depthGuard ?? OUTLINE_DEFAULTS.depthGuard, 0) },
  };
  if (vertexColors) {
    uniforms.uOutlineDarkness = { value: tint.darkness };
    uniforms.uOutlineSaturation = { value: tint.saturation };
    uniforms.uOutlineFloor = { value: tint.floor };
    uniforms.uOutlineFallback = { value: fallbackColor(tint.floor) };
  }

  const welded = opts.weldedNormals ?? true;
  material.defines = { ...(material.defines ?? {}) };
  if (welded) material.defines.AW_OUTLINE_NORMAL = '';
  material.userData.outline = { uniforms, width: opts.width ?? OUTLINE_DEFAULTS.width, tint };
  material.userData.isOutlineMaterial = true;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    // Two independent substitutions. The first seeds three's *own* normal
    // pipeline with the welded normal, so on a skinned program the stock morph
    // and skin chunks deform it exactly as they deform the position. The second
    // appends the hull push, and carries an inlined copy of that same seed for
    // the programs where the normal pipeline is compiled out altogether.
    shader.vertexShader = OUTLINE_VERTEX_PARS + replaceOnce(
      shader.vertexShader, '#include <beginnormal_vertex>', OUTLINE_BEGIN_NORMAL, material.name,
    );
    shader.vertexShader = replaceOnce(
      shader.vertexShader, '#include <project_vertex>', OUTLINE_PROJECT, material.name,
    );

    if (vertexColors) {
      shader.fragmentShader = OUTLINE_FRAGMENT_PARS + replaceOnce(
        shader.fragmentShader, '#include <color_fragment>', OUTLINE_TINT, material.name,
      );
    }
  };

  // `onBeforeCompile` is not part of three's program cache key, so without this
  // an outline material and any other `MeshBasicMaterial` with the same defines
  // resolve to the same compiled program — whichever compiled first wins and the
  // other renders with the wrong vertex stage. It presents as "the outlines
  // vanish once there is a billboard in the scene".
  const cacheKey = `aw-outline|${vertexColors ? 'tint' : 'flat'}|${welded ? 'welded' : 'shading'}`;
  material.customProgramCacheKey = () => cacheKey;

  _materials.add(material);
  material.addEventListener('dispose', () => _materials.delete(material));
  applyScale(material);
  return material;
}

/**
 * Substitute a shader anchor exactly once, loudly.
 *
 * A silently skipped injection means the hull renders un-pushed — geometry
 * coincident with the character, invisible except as z-fighting on the
 * silhouette — which is subtle enough to survive a review. The function
 * replacer keeps a `$` in the GLSL from being read as a `String.replace`
 * substitution pattern.
 */
function replaceOnce(source, anchor, block, label) {
  if (source.indexOf(anchor) === -1) {
    console.error(`[Outline] anchor "${anchor}" missing from ${label}; the hull will not offset.`);
    return source;
  }
  return source.replace(anchor, () => block);
}

/**
 * Convert this frame's camera scale into the material's two offset uniforms.
 *
 * Exactly one of the pair is non-zero: a perspective frustum's height grows with
 * depth, so the offset is a per-depth rate, while an orthographic one does not,
 * so the offset is constant. Splitting it this way keeps the vertex shader
 * branch-free.
 */
function applyScale(material) {
  const state = material.userData?.outline;
  if (!state) return;
  const metres = state.width * _metresPerPixel;
  state.uniforms.uOutlineDepthScale.value = _orthographic ? 0 : metres;
  state.uniforms.uOutlineConstant.value = _orthographic ? metres : 0;
}

/* -------------------------------------------------------------------------- */
/* Building                                                                   */
/* -------------------------------------------------------------------------- */

/** True if this object or material has opted out of being outlined. */
function isSkipped(node) {
  return node?.userData?.[SKIP_FLAG] === true;
}

/**
 * Turn the ink line on or off for everything built from here on.
 *
 * The reference plates show no outline, so this ships `false`; see the module
 * header for the measurements. It is a *build-time* switch and deliberately not
 * a live one: an inverted hull is geometry, so turning it on after a character
 * has been assembled cannot conjure the hulls that were never created, and
 * turning it off afterwards would leave orphaned meshes for `disposeOutline` to
 * find. Call it before the cast is built — a scene that wants ink sets it in its
 * constructor.
 *
 * @param {boolean} [on=true]
 * @returns {boolean} the state now in effect.
 */
export function setOutlineEnabled(on = true) {
  _enabled = !!on;
  return _enabled;
}

/** Whether {@link buildOutline} will currently produce a hull. */
export function isOutlineEnabled() {
  return _enabled;
}

/**
 * Mark an object, a subtree or a material as not to be outlined.
 *
 * ANIME_PIPELINE §4: "Skip outlines on the eyes; the painted lash line already
 * provides that weight." A hull around a four-pixel catch-light does not read as
 * ink, it reads as the catch-light being gone. The same applies to anything
 * additive — a glow shell, a spell trail — where a dark ring is the one thing
 * that cannot be there.
 *
 * @param {THREE.Object3D|THREE.Material} target subtrees are marked recursively.
 * @param {boolean} [skip=true]
 */
export function setOutlineSkip(target, skip = true) {
  if (!target) return;
  if (target.isObject3D) {
    target.traverse((node) => { node.userData[SKIP_FLAG] = skip; });
    return;
  }
  target.userData = target.userData ?? {};
  target.userData[SKIP_FLAG] = skip;
}

/**
 * Build the inverted hull for one mesh.
 *
 * The hull is attached as a **child of the source with an identity local
 * transform**, which is the only arrangement correct for both kinds of mesh. A
 * static mesh inherits the source's world matrix exactly, with no syncing code
 * and no chance of the line lagging a frame behind a fast dash. A `SkinnedMesh`
 * is not positioned by its world matrix at all but by its skeleton and bind
 * matrix — so the hull is given the *same* skeleton object, the same bind matrix
 * and the same bind mode, and under the default `AttachedBindMode` its
 * `bindMatrixInverse` is refreshed from a world matrix identical to the
 * source's. The hull therefore deforms with the animation rather than standing
 * in bind pose while the character walks away from it.
 *
 * Pass `attach: false` to place it yourself; a sibling with an identity
 * transform under the same parent is equally correct.
 *
 * @param {THREE.Mesh} mesh source mesh, static or skinned.
 * @param {Object} [opts] forwarded to {@link createOutlineMaterial}, plus:
 * @param {boolean} [opts.enabled] override the project-wide switch for this one
 *   hull. Defaults to {@link isOutlineEnabled}, which is `false`.
 * @param {THREE.Material|THREE.Material[]} [opts.material] a shared material to
 *   use instead of deriving one per source material. Not disposed by
 *   {@link disposeOutline}.
 * @param {boolean} [opts.attach=true] add the hull to the source.
 * @param {number} [opts.tolerance] weld distance for the normal average.
 * @returns {THREE.Mesh|THREE.SkinnedMesh|null} null when the mesh has no
 *   geometry or has opted out.
 */
export function buildOutline(mesh, opts = {}) {
  // Ahead of every other test, including the geometry one: with the line off
  // this must cost a boolean read per mesh and allocate nothing. `opts.enabled`
  // lets one caller — a stylised set piece, a debug capture — opt back in
  // without disturbing the project default.
  if (!(opts.enabled ?? _enabled)) return null;
  if (!mesh?.isMesh || !mesh.geometry || isSkipped(mesh)) return null;

  const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const keep = sources.map((m) => !isSkipped(m));
  if (!keep.some(Boolean)) return null;

  // A multi-material mesh with one of its materials opted out keeps its other
  // groups, so both the geometry's groups and the hull's material array have to
  // be compacted through the same mapping.
  let materialIndexMap = null;
  if (keep.some((k) => !k) && sources.length > 1) {
    materialIndexMap = [];
    let next = 0;
    for (let i = 0; i < sources.length; i++) materialIndexMap[i] = keep[i] ? next++ : -1;
  }

  const geometry = buildOutlineGeometry(mesh.geometry, {
    materialIndexMap,
    tolerance: opts.tolerance,
  });

  // One outline material per source material, so the per-surface colour rule
  // can actually be honoured: the line inherits the albedo it sits against, and
  // hair, cloth and metal each get their own. They all compile to the same
  // program, so the cost is a uniform block apiece, not a shader apiece.
  const supplied = opts.material ?? null;
  const built = [];
  for (let i = 0; i < sources.length; i++) {
    if (!keep[i]) continue;
    const src = sources[i];
    if (supplied) {
      // A shared material still has to be replicated per surviving slot when
      // groups were dropped: three only walks a geometry's groups when the mesh
      // carries a material *array*, so a single material would quietly redraw
      // the very groups that were just removed.
      built.push(Array.isArray(supplied) ? (supplied[i] ?? supplied[0]) : supplied);
      continue;
    }
    built.push(createOutlineMaterial({
      ...opts,
      name: opts.name ?? `${src?.name || mesh.name || 'mesh'}::outline`,
      albedo: opts.albedo ?? src?.color ?? 0xffffff,
      // A hull only derives per-fragment colour where the source genuinely
      // varies per vertex; otherwise the flat path gives the same answer for
      // less work.
      vertexColors: opts.vertexColors
        ?? (!!src?.vertexColors && !!geometry.getAttribute('color')),
      alphaMap: opts.alphaMap ?? src?.alphaMap ?? null,
      alphaTest: opts.alphaTest ?? src?.alphaTest ?? 0,
      // Deliberately *not* inherited from the source material: the surface
      // stands in the mist and the line drawn round it does not. See
      // `OUTLINE_DEFAULTS`.
      fog: opts.fog ?? OUTLINE_DEFAULTS.fog,
    }));
  }
  // An array source stays an array even if it is down to one entry: three only
  // honours a geometry's groups for array materials, and collapsing it would
  // draw the parts of the mesh those groups deliberately leave out.
  const material = Array.isArray(mesh.material) ? built : built[0];

  let outline;
  if (mesh.isSkinnedMesh) {
    outline = new THREE.SkinnedMesh(geometry, material);
    outline.bindMode = mesh.bindMode;
    // Shares the skeleton object itself: one bone texture, one update per frame,
    // and no possibility of the hull's pose being a frame stale.
    outline.bind(mesh.skeleton, mesh.bindMatrix);
  } else {
    outline = new THREE.Mesh(geometry, material);
  }

  outline.name = `${mesh.name || 'mesh'}::outline`;
  // The hull is a shading trick, not an occluder. Casting from it would thicken
  // every contact shadow by the line width and re-outline the character in its
  // own shadow; receiving would band the line wherever the key crosses it.
  outline.castShadow = false;
  outline.receiveShadow = false;
  outline.frustumCulled = mesh.frustumCulled;
  // Drawn before the surface, so the depth buffer rejects the shell's interior
  // early and the surface wins every pixel they contest.
  outline.renderOrder = mesh.renderOrder - 1;
  outline.userData.isOutlineHull = true;
  outline.userData.ownsMaterial = !supplied;

  if (opts.attach !== false) mesh.add(outline);
  return outline;
}

/**
 * Build hulls for every mesh in a subtree.
 *
 * The normal entry point for a character: `CharacterFactory` produces one
 * `SkinnedMesh` per shading class, and this outlines all of them in one call
 * while letting the eye and glow classes opt out.
 *
 * @param {THREE.Object3D} root
 * @param {Object} [opts] forwarded to {@link buildOutline}, plus:
 * @param {((mesh:THREE.Mesh)=>boolean)|Iterable<string>} [opts.skip] a predicate,
 *   or a list of mesh names to leave alone. The `noOutline` `userData` flag is
 *   honoured regardless.
 * @returns {THREE.Mesh[]} the hulls, in traversal order.
 */
export function buildOutlines(root, opts = {}) {
  const hulls = [];
  if (!root || !(opts.enabled ?? _enabled)) return hulls;

  const skip = typeof opts.skip === 'function'
    ? opts.skip
    : (opts.skip ? namesPredicate(opts.skip) : null);

  // Collected before building, because `buildOutline` attaches hulls as children
  // and traversing while doing so would walk into what it just created.
  const meshes = [];
  root.traverse((node) => {
    if (node.isMesh && !node.userData.isOutlineHull) meshes.push(node);
  });

  for (const mesh of meshes) {
    if (skip?.(mesh)) continue;
    const hull = buildOutline(mesh, opts);
    if (hull) hulls.push(hull);
  }
  return hulls;
}

/** A name list turned into the predicate `buildOutlines` wants. Matches the
 *  mesh's own name and its material's, since a merged character mesh is named
 *  for its shading class in one place or the other. */
function namesPredicate(names) {
  const set = new Set(names);
  return (mesh) => set.has(mesh.name)
    || (Array.isArray(mesh.material)
      ? mesh.material.some((m) => set.has(m?.name))
      : set.has(mesh.material?.name));
}

/* -------------------------------------------------------------------------- */
/* Per-frame scale                                                            */
/* -------------------------------------------------------------------------- */

/** Run `fn` over the outline materials reachable from `target`. A falsy target
 *  means every live outline material, which is the cheap path and the one a
 *  render loop should use. */
function forEachMaterial(target, fn) {
  if (!target) {
    for (const material of _materials) fn(material);
    return;
  }
  if (target.isMaterial) {
    if (target.userData?.isOutlineMaterial) fn(target);
    return;
  }
  if (!target.isObject3D) return;
  target.traverse((node) => {
    if (!node.userData?.isOutlineHull) return;
    const m = node.material;
    if (Array.isArray(m)) { for (const entry of m) if (entry?.userData?.isOutlineMaterial) fn(entry); }
    else if (m?.userData?.isOutlineMaterial) fn(m);
  });
}

/**
 * Rescale the ink line for this frame's camera and viewport.
 *
 * **Call this once per frame**, or at minimum after every resize and every
 * camera change. It is what makes the line a constant number of pixels instead
 * of a constant number of metres, which is the difference between an ink line
 * and a black jacket at the near end of a dolly.
 *
 * The factor is read from the camera's own projection matrix rather than from
 * `fov`, so it stays correct for an orthographic camera, a zoom, and a camera
 * with a view offset applied — `P[1][1]` is `2n / (t - b)` in every one of those
 * cases, and `2 / P[1][1]` is therefore the frustum's world height at unit depth
 * (perspective) or outright (orthographic). `P[3][3]` distinguishes the two.
 *
 * `viewportHeight` must be the **drawing buffer** height, not the CSS height:
 * `renderer.getDrawingBufferSize()` already folds in the pixel ratio, and
 * passing CSS pixels on a retina display halves the line.
 *
 * @param {THREE.Object3D|THREE.Material|null} mesh a hull, a source mesh, a
 *   character root — or `null`/`undefined` for every live outline, which is the
 *   allocation-free path and needs no scene walk.
 * @param {THREE.Camera} camera the camera the frame is rendered with.
 * @param {number} viewportHeight drawing-buffer height in pixels.
 */
export function updateOutlineScale(mesh, camera, viewportHeight) {
  if (!camera?.isCamera || !(viewportHeight > 0)) return;

  const e = camera.projectionMatrix.elements;
  const p11 = Math.abs(e[5]);
  if (!(p11 > 1e-8)) return;

  _orthographic = e[15] === 1;
  _metresPerPixel = (2 / p11) / viewportHeight;

  forEachMaterial(mesh, applyScale);
}

/**
 * Set the line weight, in device pixels, on whatever the target resolves to.
 *
 * Takes effect immediately at the last known camera scale, so a boss can be
 * given a heavier line mid-frame without waiting for the next
 * `updateOutlineScale`.
 *
 * @param {THREE.Object3D|THREE.Material|null} target
 * @param {number} pixels 1.0 is the shipped weight; anything past ~1.5 reads as
 *   a border rather than as a contour against a bright background.
 */
export function setOutlineWidth(target, pixels) {
  if (!(pixels >= 0)) return;
  forEachMaterial(target, (material) => {
    material.userData.outline.width = pixels;
    applyScale(material);
  });
}

/* -------------------------------------------------------------------------- */
/* Teardown                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Detach and release a hull, or an array of them.
 *
 * The care here is not ceremony. The hull's geometry *shares* its attribute
 * buffers with the source mesh, and `BufferGeometry.dispose()` deletes the GL
 * buffer behind every attribute it holds — so disposing it naively would blow
 * away the source character's positions and skin weights along with the hull's.
 * The shared attributes and the index are detached first, leaving only the
 * private welded-normal buffer for `dispose()` to reclaim.
 *
 * A material the caller supplied is left alone: a party sharing one outline
 * material is a normal arrangement, and disposing it with the first character to
 * be torn down would blank the other five.
 *
 * @param {THREE.Mesh|THREE.Mesh[]} target
 */
export function disposeOutline(target) {
  if (Array.isArray(target)) {
    for (const entry of target) disposeOutline(entry);
    return;
  }
  if (!target?.userData?.isOutlineHull) return;

  target.parent?.remove(target);

  const geometry = target.geometry;
  if (geometry) {
    for (const name of geometry.userData.outlineShared ?? []) geometry.deleteAttribute(name);
    geometry.setIndex(null);
    // Morph targets are held in a WeakMap keyed by geometry rather than by
    // attribute, so they are not freed by `dispose()` and must not be detached
    // for safety's sake — but dropping the reference keeps the source's arrays
    // from being reachable through a dead geometry.
    geometry.morphAttributes = {};
    geometry.dispose();
  }

  if (target.userData.ownsMaterial) {
    const m = target.material;
    if (Array.isArray(m)) { for (const entry of m) entry?.dispose(); }
    else m?.dispose();
  }

  if (target.isSkinnedMesh) target.skeleton = null;
}
