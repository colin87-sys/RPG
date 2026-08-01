/**
 * Outline.js — the inverted-hull ink line (ANIME_PIPELINE §4).
 *
 * ## Why this exists
 *
 * The first cast was rejected as "AI slop [that] looks nothing like anime", and
 * `docs/ANIME_PIPELINE.md` names four causes. This module is one of them: "no
 * outlines, or too subtle to see". Flat saturated colour and a hard terminator
 * still read as *stylised low-poly* without an ink line around the silhouette;
 * the line is what makes a 3D frame read as drawn. It is not a post-process edge
 * filter — those key off depth and normal discontinuities, so they miss the
 * inside of a silhouette and shimmer on a moving character. It is geometry.
 *
 * ## The technique, and the four ways it goes wrong
 *
 * Duplicate the mesh, render it with `side: BackSide` (three culls front faces),
 * and push every vertex out along its normal. The shell is hidden inside the
 * character everywhere except where it pokes past the silhouette, where it reads
 * as a line of constant weight. Four details decide whether that looks like an
 * inked drawing or like a mistake:
 *
 * 1. **The push is in view space, scaled by view depth.** A world-space offset
 *    is the naive version: it is a hairline on a character at the back of the
 *    battle stage and a marker stroke on one in a closeup. Scaling by the
 *    frustum's height at the vertex's own depth makes the line a constant number
 *    of *pixels* — `updateOutlineScale` derives the factor from the camera and
 *    the viewport, and `shaders/outlineHull.js` applies it.
 * 2. **The hull is skinned by the same skeleton.** A hull that is not skinned
 *    stays in bind pose and the character walks out of its own outline. Here the
 *    hull is a `SkinnedMesh` sharing the source's `skeleton`, `bindMatrix` and
 *    `bindMode`, and it is pushed along a normal that three's own
 *    `skinnormal_vertex` chunk has deformed — not along a re-derived one.
 * 3. **The push follows *welded* normals.** `CharacterFactory` runs
 *    `toCreasedNormals`, so vertices are split at every hard edge and their
 *    normals diverge. Pushing along those tears the shell open at each crease —
 *    a gap in the line exactly at a hair clump's point or a boot's corner, which
 *    is where the silhouette is doing the most work. `buildOutlineGeometry`
 *    computes a position-welded average into an `aOutlineNormal` attribute.
 * 4. **The line is not black.** §4 asks for a heavily darkened, saturated
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
 * focus wearing a background-blurred halo. Writing depth is also why no
 * polygon offset is needed: the hull is drawn first (`renderOrder - 1`), so
 * where it meets the surface at the silhouette the surface's own `LEQUAL` test
 * wins and there is nothing to z-fight over.
 *
 * ## Contract
 *
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
 * `width` is in **device pixels**, which is what "constant screen-space weight"
 * means and what ANIME_PIPELINE §4 asks for: 1.5–2.5 px at 1080p. 2.0 sits in
 * the middle — unmistakably an ink line at battle distance, still short of the
 * cartoon border a heavier value gives a chibi character whose whole body is
 * only ~80 px tall.
 *
 * `darkness` and `saturation` are §4's colour rule. 0.16 in linear light is
 * heavily darkened; boosting saturation by 1.55 on the way down is what stops
 * the darkening from also draining the hue and landing on the near-black line
 * the document rules out. `floor` keeps a very dark albedo — a deep navy coat,
 * which crushes to black inside a code value at 0.16 — off zero, so the line
 * still carries the garment's hue and no pure black lands on the subject
 * (ART_BIBLE §2.3).
 */
export const OUTLINE_DEFAULTS = Object.freeze({
  width: 2.0,
  darkness: 0.16,
  saturation: 1.55,
  floor: 0.008,
});

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
 * ANIME_PIPELINE §4's line colour, evaluated on the CPU.
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
 * @param {number} [opts.darkness=0.16] value multiplier.
 * @param {number} [opts.saturation=1.55] HSV saturation multiplier.
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

/**
 * Position-welded vertex normals.
 *
 * Every vertex at the same location is given the average of the *distinct*
 * shading normals meeting there — which is the normal the surface would have
 * had before `toCreasedNormals` split it, and therefore the one direction that
 * pushes both sides of a crease to the same point and keeps the shell closed.
 *
 * Distinct is the operative word. A plain sum weights each smoothing group by
 * how many triangles happen to touch the corner, which on a non-indexed box
 * gives the corner `(1,1,2)` instead of `(1,1,1)` purely because one face's
 * triangulation fans through it twice. That is the tessellation's opinion, not
 * the surface's, and it skews the line's thickness around exactly the hard
 * corners that carry a chibi silhouette. Collapsing duplicates first makes the
 * result depend only on the shape.
 *
 * Normals that cancel — the two sides of a zero-thickness card — leave no
 * usable average, and those vertices keep their own normal so the two faces
 * push apart instead of collapsing into each other.
 */
/** Scratch, so per-character geometry maths allocates nothing. */
const _v3 = new THREE.Vector3();

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

  const count = position.count;
  const out = new Float32Array(count * 3);
  const bucketOf = new Int32Array(count);
  const sums = [];
  const distinct = [];
  const buckets = new Map();
  const q = 1 / tolerance;

  for (let i = 0; i < count; i++) {
    const key = `${Math.round(position.getX(i) * q)},`
      + `${Math.round(position.getY(i) * q)},`
      + `${Math.round(position.getZ(i) * q)}`;
    let b = buckets.get(key);
    if (b === undefined) {
      b = sums.length;
      buckets.set(key, b);
      sums.push(0, 0, 0);
      distinct.push([]);
    }
    bucketOf[i] = b;

    const len = Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) || 1;
    const nx = normal.getX(i) / len;
    const ny = normal.getY(i) / len;
    const nz = normal.getZ(i) / len;

    // `b` is the flat offset into `sums`, so `b / 3` is the bucket's ordinal.
    const seen = distinct[b / 3];
    let duplicate = false;
    for (let k = 0; k < seen.length; k += 3) {
      if (nx * seen[k] + ny * seen[k + 1] + nz * seen[k + 2] > 0.9999) { duplicate = true; break; }
    }
    if (duplicate) continue;

    seen.push(nx, ny, nz);
    sums[b] += nx;
    sums[b + 1] += ny;
    sums[b + 2] += nz;
  }

  for (let i = 0; i < count; i++) {
    const b = bucketOf[i];
    let x = sums[b];
    let y = sums[b + 1];
    let z = sums[b + 2];
    let len = Math.hypot(x, y, z);
    if (len < 1e-6) {
      x = normal.getX(i);
      y = normal.getY(i);
      z = normal.getZ(i);
      len = Math.hypot(x, y, z) || 1;
    }
    out[i * 3] = x / len;
    out[i * 3 + 1] = y / len;
    out[i * 3 + 2] = z / len;
  }

  return new THREE.BufferAttribute(out, 3);
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
 * @param {number} [opts.width=2] line weight in device pixels.
 * @param {number} [opts.darkness] / [opts.saturation] / [opts.floor] §4 tint
 *   controls; meaningful with `vertexColors`, folded into the colour otherwise.
 * @param {THREE.Texture} [opts.alphaMap] / [opts.alphaTest] cutout, inherited
 *   from the source material so an alpha-tested card is outlined at its cut
 *   edge rather than at the edge of its quad.
 * @param {boolean} [opts.weldedNormals=true] push along the `aOutlineNormal`
 *   attribute that {@link buildOutlineGeometry} adds. Materials and geometry are
 *   decoupled here — a caller may share one material across hulls it built
 *   itself — so this has to be switchable: with the attribute absent the shader
 *   would reference an undeclared name and fail to compile. Turning it off falls
 *   back to the shading normal, which tears the shell open at hard edges.
 * @param {boolean} [opts.fog=true]
 * @returns {THREE.MeshBasicMaterial}
 */
export function createOutlineMaterial(opts = {}) {
  const vertexColors = opts.vertexColors ?? false;
  const tint = {
    darkness: opts.darkness ?? OUTLINE_DEFAULTS.darkness,
    saturation: opts.saturation ?? OUTLINE_DEFAULTS.saturation,
    floor: opts.floor ?? OUTLINE_DEFAULTS.floor,
  };

  // With one flat albedo the §4 transform has a single answer, so it is
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
    fog: opts.fog ?? true,
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
 * @param {THREE.Material|THREE.Material[]} [opts.material] a shared material to
 *   use instead of deriving one per source material. Not disposed by
 *   {@link disposeOutline}.
 * @param {boolean} [opts.attach=true] add the hull to the source.
 * @param {number} [opts.tolerance] weld distance for the normal average.
 * @returns {THREE.Mesh|THREE.SkinnedMesh|null} null when the mesh has no
 *   geometry or has opted out.
 */
export function buildOutline(mesh, opts = {}) {
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

  // One outline material per source material, so §4's per-surface colour rule
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
      fog: opts.fog ?? src?.fog ?? true,
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
  if (!root) return hulls;

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
 * @param {number} pixels 1.5–2.5 is the ANIME_PIPELINE §4 range at 1080p.
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
