/**
 * CharacterFactory.js — procedural chibi character construction.
 *
 * Everything on screen for the entire game is built here, in code, from the
 * numbers in `roster.js` and the skeleton in `Rig.js`. No meshes are loaded;
 * there is nothing to load.
 *
 * ## The three things this file exists to get right
 *
 * **1. Silhouette.** REFERENCE_TARGET §1: the party occupies about **80 px of
 * screen height** in the fixed side-view battle camera, where a costume seam is
 * invisible and what survives is the outline. Six characters, six *different*
 * hair volumes, six *different* weapon outlines, six *different* cloth hems.
 * Bramm's hair mass is below the chin (beard) where everyone else's is above
 * it. Kite carries a hard ring on her back. Yshara carries a horizontal bar.
 * Seren's hair is twice her shoulder width. Emrys is a bell of coat with a
 * starburst on top. Auren is a vertical line broken at the hip. Flatten any two
 * of those to black and they do not collide.
 *
 * **2. Colour blocking, and no noise anywhere.** ANIME_PIPELINE §5 requires
 * three or four *flat* colour zones per character, identifiable "by colour
 * alone" at battle distance. The first cast failed that outright — every
 * surface carried an fBm detail map and every costume was a dark desaturated
 * coat, so the party read as one navy mass with dirt on it. Two consequences
 * run through everything below:
 *
 *   - **No procedural texture touches a character.** No `normalMap`, no
 *     `roughnessMap`, no `aoMap`, on skin, hair, cloth, leather or metal. This
 *     is ANIME_PIPELINE's absolute rule and it is enforced twice: nothing here
 *     asks the forge for one, and `createToonMaterial`'s `flat` presets drop
 *     any that arrive anyway.
 *   - **Colour is per vertex, and the boundaries are hard.** A zone change is a
 *     duplicated ring of vertices carrying two different colours, which the
 *     welder cannot merge — so a belt line is an edge, not a gradient. One
 *     `SkinnedMesh` per shading class still means one draw call for the coat,
 *     its trim and its undercoat.
 *
 * **3. The face is a painted texture.** ANIME_PIPELINE §1. Eyes, brows and
 * mouth are *drawn* by `FaceTexture.js` and land on a square plate wrapped onto
 * the front of the skull (`buildFacePlate`). The previous cast modelled them as
 * a stack of coloured decal discs, which took the lighting: the lash line
 * brightened on the lit side, the catch-light dimmed on the shadow side, and no
 * amount of tuning recovers the ink weight a drawn line has for free.
 *
 * ## Construction pipeline
 *
 *   parametric parts (bind-pose world space)
 *     → weld + smooth normals per part
 *     → analytic skin weights against a *whitelisted* bone segment list
 *     → merge by shading class
 *     → SkinnedMesh per class, sharing one Skeleton
 *
 * Two decisions in that chain are worth defending:
 *
 * **Parts are authored in bind-pose world space, not in bone-local space.**
 * Every dimension in `roster.js` is a fraction of body height, and every joint
 * in `Rig.js` is a world position, so authoring in the same frame means no
 * builder ever has to compose a transform to know where the elbow is. Binding
 * a part to a bone afterwards is a single matrix the skeleton already owns.
 *
 * **Skin weights are solved against a per-part whitelist**, not against every
 * bone. A chibi upper arm passes within a couple of centimetres of the ribcage;
 * a global nearest-bone solve gives the chest 30% arm weight and the torso
 * visibly dents every time the character swings. Restricting the torso to
 * spine bones and the arm to arm bones is both faster and strictly better.
 *
 * OWNED BY: characters. Consumers: `battle/*`, `world/*`, `story/*`.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/GameState.js';
import { LIGHT, luminance } from '../art/Palette.js';
import {
  buildRig, computeMetrics, skinSegments, skullPoint, skullDepth, hairlinePhi,
  CAST_LAYER,
} from './Rig.js';
import { Animator } from './Animation.js';
import { ClothSim } from './Cloth.js';
import { characterDef, ROSTER } from './roster.js';
import { buildFaceTexture } from './FaceTexture.js';
import { buildGarmentSet } from './Garments.js';
import { createToonMaterial, updateToonUniforms } from '../render/ToonMaterial.js';
import { buildOutline, disposeOutline, setOutlineSkip } from '../render/Outline.js';

const TAU = Math.PI * 2;

/**
 * Shading classes. One `SkinnedMesh` and one material per class per character.
 *
 * `face` is the painted plate and nothing else: it is the only class carrying a
 * colour map, the only one whose albedo must *not* be multiplied by a vertex
 * colour, and the only one that takes no outline (ANIME_PIPELINE §4 — the drawn
 * lash line already is the ink). Keeping it apart from `skin` is what lets all
 * three of those be true at once. It shares the `skin` preset otherwise, so the
 * plate's edge and the skull around it shade identically and the join is
 * invisible.
 */
const CLASSES = ['skin', 'face', 'hair', 'cloth', 'metal', 'glow'];

/** Classes whose hull forms the read silhouette and therefore takes an ink line. */
const OUTLINED = new Set(['skin', 'hair', 'cloth', 'metal']);

/**
 * Re-exported so consumers have one import for the cast; defined in `Rig.js`
 * because `Cloth` needs it and cannot import this module.
 *
 * The review's "five of six party members are semi-transparent" is not a
 * character-side defect: every material this file produces is opaque and writes
 * depth (`sealOpaque`, and `auditCharacter` proves it without a renderer). The
 * cast is being *composited over* by the scene's volumetric mist, which is
 * alpha-blended and therefore always drawn after the opaque queue — a card
 * standing between the lens and a figure veils it no matter what the figure's
 * material says. Fixing that means either depth-aware mist or a cast pass that
 * runs after the volumetrics, and both need the renderer to be able to name the
 * cast, which is what this layer is for.
 */
export { CAST_LAYER };

/**
 * The opacity contract every character surface is held to, asserted rather than
 * inherited.
 *
 * ANIME_PIPELINE has no transparent character surface: flat colour, a painted
 * face and a highlight band. A blended one would also have to be sorted against
 * the volumetric pass and against the inverted hull, neither of which has a
 * stable answer. Writing the fields explicitly here — rather than trusting
 * `createToonMaterial`'s defaults, a preset table this file does not own, or a
 * caller's `spec` — is what makes "the cast is opaque" a property of the module
 * instead of a property of five other files agreeing.
 *
 * The contact decal is the one deliberate exception and is built by hand.
 */
function sealOpaque(material) {
  material.transparent = false;
  material.opacity = 1;
  material.alphaTest = 0;
  material.blending = THREE.NormalBlending;
  material.depthWrite = true;
  material.depthTest = true;
  material.premultipliedAlpha = false;
  return material;
}

// =========================================================== geometry tools

/**
 * A growable triangle soup in bind-pose world space.
 *
 * Deliberately not a `BufferGeometry` until `finish()`: every builder below
 * appends a few hundred vertices and typed-array growth would dominate the
 * cost of generating a character. Plain arrays, one copy at the end.
 */
class Surface {
  constructor() {
    this.pos = [];
    this.idx = [];
    /**
     * Per-vertex linear colour, written as vertices are emitted.
     *
     * Colouring a finished geometry by re-deriving which layer a vertex belongs
     * to from its *position* — which is what this file used to do for the face —
     * is the kind of thing that works until a proportion changes and then
     * silently mis-assigns a whole layer. There is no way to look at the result
     * and know it went wrong; it just renders a blank eye. Recording the colour
     * at emission time makes the assignment unconditionally correct, and the
     * welder keeps hard colour boundaries hard because two vertices that differ
     * in any attribute are never merged.
     */
    this.col = [];
    /**
     * Per-vertex UV, written at emission for exactly one consumer: the painted
     * face plate. Every other surface on a character is flat colour with no map
     * at all (ANIME_PIPELINE's no-noise rule removed the detail maps that used
     * to need a projection), so they emit the default and pay two floats a
     * vertex to keep the attribute sets uniform — `mergeGeometries` refuses to
     * merge geometries whose attributes differ, and one part without a UV would
     * break its whole shading class.
     */
    this.uv = [];
    this._r = 1; this._g = 1; this._b = 1;
    this._u = 0; this._v = 0;
    this._scratch = new THREE.Color();
  }

  /** Set the colour subsequent vertices carry. `hex` is sRGB; stored linear. */
  ink(hex, scale = 1) {
    const c = hex instanceof THREE.Color ? this._scratch.copy(hex) : this._scratch.set(hex);
    this._r = c.r * scale; this._g = c.g * scale; this._b = c.b * scale;
    return this;
  }

  /** Set the UV subsequent vertices carry. */
  uvAt(u, v) {
    this._u = u; this._v = v;
    return this;
  }

  vertex(x, y, z) {
    this.pos.push(x, y, z);
    this.col.push(this._r, this._g, this._b);
    this.uv.push(this._u, this._v);
    return this.pos.length / 3 - 1;
  }

  vec(v) { return this.vertex(v.x, v.y, v.z); }

  tri(a, b, c) { this.idx.push(a, b, c); }

  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  /**
   * Lay out a `(rows+1) × (cols+1)` patch and triangulate it.
   *
   * Faces come out wound as `∂row × ∂col`. That is outward for `blob`, whose
   * (latitude, longitude) parameterisation is right-handed, and *inward* for
   * `sweep`, whose (path, section) parameterisation is not — see the note on
   * `sweep`. `flip` reverses every quad so a caller can state its handedness
   * once instead of every call site guessing.
   *
   * @param {number} rows @param {number} cols
   * @param {boolean} wrapCols share the seam column (tubes, spheroids)
   * @param {(i:number, j:number) => {x:number,y:number,z:number}} fn
   * @param {boolean} [flip] reverse the winding of every quad
   * @returns {number[][]} the vertex-id grid, so callers can cap or stitch
   */
  patch(rows, cols, wrapCols, fn, flip = false) {
    const grid = [];
    for (let i = 0; i <= rows; i++) {
      const row = [];
      const jMax = wrapCols ? cols - 1 : cols;
      for (let j = 0; j <= jMax; j++) {
        const p = fn(i, j);
        row.push(this.vertex(p.x, p.y, p.z));
      }
      if (wrapCols) row.push(row[0]);
      grid.push(row);
    }
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const a = grid[i][j], b = grid[i][j + 1];
        const c = grid[i + 1][j + 1], d = grid[i + 1][j];
        if (a === b && c === d) continue;
        if (flip) this.quad(a, b, c, d);
        else this.quad(a, d, c, b);
      }
    }
    return grid;
  }

  /** Fan-cap a ring of vertex ids around their centroid. */
  cap(ring, flip = false) {
    let cx = 0, cy = 0, cz = 0;
    const n = ring.length - 1; // last entry repeats the first on wrapped rings
    for (let i = 0; i < n; i++) {
      cx += this.pos[ring[i] * 3];
      cy += this.pos[ring[i] * 3 + 1];
      cz += this.pos[ring[i] * 3 + 2];
    }
    const c = this.vertex(cx / n, cy / n, cz / n);
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      if (flip) this.tri(c, b, a); else this.tri(c, a, b);
    }
  }

  get empty() { return this.idx.length === 0; }

  /**
   * @param {number} [crease] radians; when set, edges sharper than this stay
   *        hard. Used for blades, boots and books — anything whose read depends
   *        on a crisp corner rather than on a soft chibi curve.
   */
  finish(crease = 0) {
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    // Always present, even when the caller intends to repaint the whole part
    // afterwards: `mergeGeometries` refuses to merge geometries whose attribute
    // sets differ, so one un-coloured part would break the whole shading class.
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setIndex(this.idx);
    // Weld first: the patch builder emits shared grid vertices already, but
    // caps, seams and stitched sub-surfaces leave coincident duplicates that
    // would otherwise split the normal and print a visible facet line.
    geo = mergeVertices(geo, 1e-5);
    if (crease > 0) {
      // `toCreasedNormals` returns non-indexed; welding again re-indexes it
      // while *keeping* the split at the hard edges, because the two sides now
      // differ in their normal attribute and no longer compare equal.
      geo = mergeVertices(toCreasedNormals(geo, crease), 1e-5);
    } else {
      geo.computeVertexNormals();
    }
    return geo;
  }
}

/**
 * Shading classes that are allowed to keep hard edges, and nothing else.
 *
 * `toCreasedNormals` splits the normal wherever two faces meet at more than its
 * threshold, which is the correct finish for a bevelled pauldron and the wrong
 * one for everything a body is made of. On skin, cloth and hair it converts the
 * tessellation itself into visible information: a 20-column sweep meeting the
 * threshold at its silhouette prints the polygon boundary as a value step, so
 * the surface reads as folded card rather than as a form — which is exactly the
 * "faceted paper-toy" the plates are being compared against. The plate's cloth
 * and hair have hard edges too, but they are *modelled* ones — a lapel, a collar
 * roll, a hair clump's parting — with smooth shading either side of them, and
 * that is what a modelled crease looks like.
 *
 * So the policy is a whitelist rather than a per-part opinion, and it lives at
 * the assembly point where it can be checked in one place: **metal and glow may
 * crease; skin, cloth, hair and face never do.** Parts still declare their
 * `crease` and it is still honoured — inside those two classes.
 */
const CREASE_CLASSES = new Set(['metal', 'glow']);

/** The crease angle a part actually gets — see {@link CREASE_CLASSES}. */
function creaseFor(part) {
  return CREASE_CLASSES.has(part.cls) ? (part.crease ?? 0) : 0;
}

/** Unit cross-sections for swept solids. All return `[x, y]` pairs on a unit circle-ish. */
const SECTIONS = {
  circle(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      out.push([Math.cos(a), Math.sin(a)]);
    }
    return out;
  },
  /** Superellipse; `e < 1` squares off, used for boots, books and armour. */
  square(n, e = 0.45) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      out.push([Math.sign(c) * Math.pow(Math.abs(c), e), Math.sign(s) * Math.pow(Math.abs(s), e)]);
    }
    return out;
  },
  /** Blade lens: wide on x, knife-thin on y, with genuinely sharp x extremes. */
  lens(n, thin = 0.28) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      out.push([c, Math.sign(s) * thin * Math.pow(1 - Math.abs(c), 0.62)]);
    }
    return out;
  },
  /**
   * Hair clump: a broad wedge with a domed top, a flatter underside that beds
   * down against the skull, and squared-off sides.
   *
   * The two exponents are what make a clump read as *carved* rather than as
   * rope. A circular section sweeps into a tube, and a tube of hair is a
   * strand — which ANIME_PIPELINE §3 rules out. Squaring the sides gives the
   * clump two broad planes with a hard edge between them, which is the surface
   * the one highlight band runs across.
   */
  clump(n, eTop = 0.62, eBot = 0.40) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      const e = s >= 0 ? eTop : eBot;
      out.push([Math.sign(c) * Math.pow(Math.abs(c), e), Math.sign(s) * Math.pow(Math.abs(s), e)]);
    }
    return out;
  },
};

/**
 * Parallel-transport frames along a polyline.
 *
 * Frenet frames flip their normal wherever the curve's curvature reverses,
 * which on a hair lock or a cape hem produces a visible twist. Parallel
 * transport carries the previous frame forward and only rotates it by the
 * minimum amount needed, so a swept lock never corkscrews.
 */
function transportFrames(path) {
  const n = path.length;
  const t = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    t.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  const u = [];
  const v = [];
  let ref = Math.abs(t[0].y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  u.push(new THREE.Vector3().crossVectors(ref, t[0]).normalize());
  v.push(new THREE.Vector3().crossVectors(t[0], u[0]).normalize());
  for (let i = 1; i < n; i++) {
    const prevU = u[i - 1];
    const proj = prevU.clone().addScaledVector(t[i], -prevU.dot(t[i]));
    if (proj.lengthSq() < 1e-8) proj.copy(v[i - 1]);
    proj.normalize();
    u.push(proj);
    v.push(new THREE.Vector3().crossVectors(t[i], proj).normalize());
  }
  return { t, u, v };
}

/**
 * Sweep a cross-section along a path.
 *
 * The wall is emitted with the winding **flipped**, and that is a correctness
 * fix rather than a preference. `transportFrames` returns a right-handed basis
 * with `u × v = t`, so the patch's own `∂path × ∂section` evaluates to
 * `t × (−u sinθ + v cosθ) = −(u cosθ + v sinθ)` — the *inward* radial. Left
 * unflipped every swept solid on a character (hair clumps, weapon hafts, belt
 * straps, collar shells, boot shafts) renders back-face-culled inside out: the
 * far inner wall shows through the near one, which on an opaque cel surface
 * reads as a glassy, seam-cracked shell rather than as a solid lock of hair.
 * `Garments.js` carries the identical note on its own copy of this primitive.
 *
 * The two caps are *not* flipped: a cap ring wound in increasing section angle
 * already gives `r × ĉ = +t`, so the start cap (which faces `−t`) is the one
 * that reverses, which is what `cap(grid[0], true)` below does.
 *
 * @param {Surface} s
 * @param {THREE.Vector3[]} path
 * @param {number[][]} section unit cross-section
 * @param {(i:number)=>[number, number]} scaleFn per-path-point [su, sv]
 * @param {object} [opts] `{ capStart, capEnd, twist }`
 */
function sweep(s, path, section, scaleFn, opts = {}) {
  const { t, u, v } = transportFrames(path);
  const cols = section.length;
  const rows = path.length - 1;
  const twist = opts.twist ?? 0;
  const grid = s.patch(rows, cols, true, (i, j) => {
    const [su, sv] = scaleFn(i);
    const a = twist * (i / rows);
    const c = Math.cos(a), sn = Math.sin(a);
    const px = section[j][0] * c - section[j][1] * sn;
    const py = section[j][0] * sn + section[j][1] * c;
    const p = path[i];
    return {
      x: p.x + u[i].x * px * su + v[i].x * py * sv,
      y: p.y + u[i].y * px * su + v[i].y * py * sv,
      z: p.z + u[i].z * px * su + v[i].z * py * sv,
    };
  }, true);
  if (opts.capStart !== false) s.cap(grid[0], true);
  if (opts.capEnd !== false) s.cap(grid[rows], false);
  return grid;
}

/**
 * Superellipsoid — one primitive that covers head, torso, hands, boots,
 * pauldrons and books by moving two exponents. `e = 1` is an ellipsoid,
 * `e → 0` is a box; the useful chibi band is 0.5–0.95.
 */
function blob(s, opts) {
  const {
    cx = 0, cy = 0, cz = 0, rx = 1, ry = 1, rz = 1,
    eU = 1, eV = 1, segU = 20, segV = 14,
    vFrom = 0, vTo = 1, profile = null, matrix = null,
  } = opts;
  const p = new THREE.Vector3();
  const pw = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
  const grid = s.patch(segV, segU, true, (i, j) => {
    const vt = vFrom + (vTo - vFrom) * (i / segV);
    const phi = (vt - 0.5) * Math.PI;
    const theta = (j / segU) * TAU;
    const sc = profile ? profile(vt) : 1;
    const cr = pw(Math.cos(phi), eV);
    p.set(
      cx + rx * cr * pw(Math.cos(theta), eU) * sc,
      cy + ry * pw(Math.sin(phi), eV),
      cz + rz * cr * pw(Math.sin(theta), eU) * sc,
    );
    if (matrix) p.applyMatrix4(matrix);
    return p;
  });
  if (vFrom > 0.001) s.cap(grid[0], true);
  if (vTo < 0.999) s.cap(grid[segV], false);
  return grid;
}

/** Catmull-ish sampling of a control polyline into `n` smooth points. */
function smoothPath(controls, n) {
  const curve = new THREE.CatmullRomCurve3(controls, false, 'catmullrom', 0.35);
  return curve.getSpacedPoints(n - 1);
}

// ============================================================ skin solving

/**
 * Analytic skin weights from bone-segment proximity.
 *
 * Weight falls off as a Gaussian in the *perpendicular* distance to the bone's
 * axis, clamped along the axis to the segment. A Gaussian rather than an
 * inverse power because it has no singularity at the axis (so a vertex sitting
 * exactly on the bone does not take 100% and shear its neighbours) and because
 * its shoulder gives a genuinely soft, wide blend across a joint — which is
 * what a chibi limb, with no elbow detail to hide a crease, actually needs.
 *
 * `sigma` per segment comes from `Rig.skinSegments` and tracks that limb's own
 * girth, so the same solve works on Bramm's forearm and Emrys's.
 */
function solveSkin(geometry, segments, maxInfluences = 4) {
  const pos = geometry.getAttribute('position');
  const count = pos.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);

  const w = new Float64Array(segments.length);
  const ab = new THREE.Vector3();
  const ap = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    let best = -1;
    let bestD = Infinity;

    for (let sgi = 0; sgi < segments.length; sgi++) {
      const sg = segments[sgi];
      ab.subVectors(sg.b, sg.a);
      ap.set(px - sg.a.x, py - sg.a.y, pz - sg.a.z);
      const denom = ab.lengthSq();
      let t = denom > 1e-9 ? ap.dot(ab) / denom : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = ap.x - ab.x * t;
      const dy = ap.y - ab.y * t;
      const dz = ap.z - ab.z * t;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const k = d / sg.sigma;
      w[sgi] = Math.exp(-k * k);
      if (d < bestD) { bestD = d; best = sgi; }
    }

    // Top-N selection by partial insertion — N is 4, so a sort would cost more
    // than the scan and allocate besides.
    let n = 0;
    const idxBuf = [0, 0, 0, 0];
    const wBuf = [0, 0, 0, 0];
    for (let sgi = 0; sgi < segments.length; sgi++) {
      const val = w[sgi];
      if (val <= 1e-4) continue;
      if (n < maxInfluences) {
        idxBuf[n] = sgi; wBuf[n] = val; n++;
      } else {
        let minAt = 0;
        for (let k = 1; k < maxInfluences; k++) if (wBuf[k] < wBuf[minAt]) minAt = k;
        if (val > wBuf[minAt]) { wBuf[minAt] = val; idxBuf[minAt] = sgi; }
      }
    }
    if (n === 0) { idxBuf[0] = best; wBuf[0] = 1; n = 1; }

    let sum = 0;
    for (let k = 0; k < n; k++) sum += wBuf[k];
    const inv = sum > 1e-9 ? 1 / sum : 0;
    for (let k = 0; k < 4; k++) {
      skinIndex[i * 4 + k] = k < n ? segments[idxBuf[k]].index : 0;
      skinWeight[i * 4 + k] = k < n ? wBuf[k] * inv : 0;
    }
  }

  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
}

/**
 * Layered garments, built by `Garments.js` and skinned onto this rig.
 *
 * The body under a costume is one flat colour mass, and the client's largest
 * single complaint was that our costumes were exactly that where the plate's are
 * built up in layers. Those layers are `Garments.js`'s job; making them *move*
 * with the character is this module's, and the two meet at one call.
 *
 * ### The skinning rule, and why `attachBone` is a bias rather than a parent
 *
 * A garment piece hangs *off* the body: a coat panel can sit a centimetre clear
 * of the thigh that should drive it, which is past the falloff a skin surface
 * uses. So pieces are solved against the same segments widened uniformly (see
 * `Rig.skinSegments`'s `sigmaScale`) — without that, every vertex past the
 * body's own falloff drops through to the solver's nearest-bone fallback and
 * binds rigidly, which is how a coat tail ends up moving in stair-steps.
 *
 * `attachBone` then widens that one bone's falloff further rather than parenting
 * the piece to it. Parenting is the wrong tool: a skirt attached at the hips
 * still has to be pushed by the knees, and a pauldron attached at the shoulder
 * still has to follow the chest when the torso twists. Biasing gives the anchor
 * the neighbourhood it names and lets the rest of the skeleton keep the parts of
 * the piece that are closer to it. A piece anchored on a *non-core* bone —
 * `weapon`, a hair or cape link — has no such neighbourhood and is bound rigidly,
 * which is the correct treatment for a hard fitting.
 *
 * Materials come back from `Garments.js` and are **not** disposed here, on the
 * same principle as the face texture: this module did not create them and cannot
 * know whether they are shared across the party.
 *
 * @returns {Array<{name: string, geometry: THREE.BufferGeometry, material: THREE.Material}>}
 */
function buildGarments(def, metrics, rig) {
  let pieces;
  try {
    pieces = buildGarmentSet(def, metrics, rig);
  } catch (err) {
    // One malformed garment must not cost the scene its whole cast.
    console.warn(`[CharacterFactory] garment set failed for "${def.id}": ${err.message}`);
    return [];
  }
  if (!Array.isArray(pieces) || pieces.length === 0) return [];

  const wide = skinSegments(rig, 1.65);
  const anchored = new Set(wide.map((s) => s.name));
  const out = [];

  for (const piece of pieces) {
    const geo = piece?.geometry;
    if (!geo?.getAttribute?.('position')) continue;
    const bone = piece.attachBone;
    if (anchored.has(bone)) {
      solveSkin(geo, wide.map((s) => (s.name === bone ? { ...s, sigma: s.sigma * 2.2 } : s)));
    } else {
      const idx = bone ? rig.order.indexOf(bone) : -1;
      if (idx >= 0) rigidSkin(geo, idx);
      else solveSkin(geo, wide);
    }
    out.push({ name: piece.name ?? `garment${out.length}`, geometry: geo, material: piece.material });
  }
  return out;
}

/** Rigid binding: every vertex fully owned by one bone (weapons, accessories). */
function rigidSkin(geometry, boneIndex) {
  const count = geometry.getAttribute('position').count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    skinIndex[i * 4] = boneIndex;
    skinWeight[i * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
}

/**
 * A linear-luminance band per shading class, enforced rather than trusted.
 *
 * A palette authored by eye in sRGB spans four stops of value, and on a
 * two-band cel surface with no environment reflection to absorb the error, an
 * out-of-band swatch inverts the frame's value hierarchy — the brightest object
 * becomes a rectangle of cloth and the eye leaves the face. Rescaling luminance
 * while leaving chromaticity alone keeps every authored hue and only moves the
 * level, so ANIME_PIPELINE §5's "flat and *saturated*" survives the clamp.
 *
 * The cloth window is deliberately wide — 0.09 to 0.62, against the 0.12–0.46
 * this used to enforce. §5's whole point is that the six must be separable by
 * colour at eighty pixels, and value is half of that separation: squeezing
 * Seren's ivory and Emrys's violet into a third of a stop of each other is one
 * of the mechanisms that made the first cast read as a single mass. The floor
 * matters more than the ceiling, because a garment below it stops carrying hue
 * at all.
 *
 * `skin` is unbanded, and that is load-bearing rather than an omission. The
 * skull's flat vertex colour has to match the skin the face texture is painted
 * on *exactly*, or the plate's boundary shows as a patch on the cheek — and the
 * painter reads `palette.skin` raw. There is one number, and it is the roster's.
 * `glow` is unbanded because it is emissive by definition.
 */
const ALBEDO_BAND = Object.freeze({
  skin: null,
  face: null,
  // The hair floor is 0.085 rather than 0.04. Four of the six carry a hair
  // swatch whose linear luminance is under 0.06, and on a surface that also
  // takes a `shadowFloor: 0` cel band and an ink outline derived from the same
  // albedo, the result is not "dark hair" — it is a hole in the character with
  // no internal form at all, which is half of why the rebuilt clumps still read
  // as flat black slabs. 0.085 is still unambiguously dark hair; what it buys is
  // enough range between the lit band, the shadow band and the outline for the
  // carved volume to be visible, which is the entire point of building it.
  hair: [0.085, 0.50],
  cloth: [0.09, 0.62],
  metal: [0.26, 0.72],
  glow: null,
});

/**
 * The band the hair highlight is graded into.
 *
 * Deliberately *not* `ALBEDO_BAND.hair`. The highlight has to sit above the
 * base value on every head in the party, and four of the six carry a hair
 * swatch that the base band already pins at or near its 0.50 ceiling — so a
 * highlight graded on the same band would be the same value as the hair it is
 * drawn on and would simply not exist. Its own window, floored above the base
 * band's ceiling, makes the separation a property of the construction.
 */
const HAIR_HIGHLIGHT_BAND = Object.freeze([0.16, 0.62]);

/**
 * The single anisotropic crown band, ANIME_PIPELINE §3: "a bright, slightly
 * desaturated band with hard-ish edges".
 *
 * Both halves of that sentence are load-bearing and neither can be reached by
 * multiplying the albedo. *Bright* means it must clear the base band, which is
 * why it is graded separately — four of the six carry a hair swatch the base
 * band already pins at its ceiling, so a highlight graded on that band would be
 * the same value as the hair it is drawn on. *Slightly desaturated* is what
 * stops it reading as "the same hair, lit"; a highlight that keeps full chroma
 * is a lighting effect, and a lighting effect on a cel surface is already the
 * shadow band's job.
 *
 * ### How strong, measured off the plate rather than off the prose
 *
 * `docs/reference/bravely01.jpg` shows every head carrying a distinct lighter
 * strip across the crown — the defect this fixes is that ours carried none —
 * but the strip is roughly **1.5–1.8× the base value**, not the 2.5×+ that
 * ANIME_PIPELINE §3's "bright" reads as in isolation. At 2.6× the band came
 * out as a stripe of paint laid over the hair rather than as the hair catching
 * light. `docs/reference/README.md` is explicit that where the plates and the
 * prose disagree the plates win, and this is one of those places.
 *
 * @param {number|THREE.Color} hex the character's hair swatch
 * @returns {THREE.Color} linear colour, ready for `Surface.ink`
 */
function hairHighlight(hex) {
  const c = hex instanceof THREE.Color ? hex.clone() : new THREE.Color(hex);
  const grey = luminance(c.r, c.g, c.b);
  c.lerp(new THREE.Color(grey, grey, grey), 0.28);
  const y = luminance(c.r, c.g, c.b);
  const target = THREE.MathUtils.clamp(
    Math.max(y * 1.7, HAIR_HIGHLIGHT_BAND[0]),
    HAIR_HIGHLIGHT_BAND[0], HAIR_HIGHLIGHT_BAND[1],
  );
  return y > 1e-5 ? c.multiplyScalar(target / y) : c.setScalar(target);
}

/** Rescale a swatch's linear luminance into `[lo, hi]`, preserving chroma. */
function gradeAlbedo(hex, cls, scale = 1) {
  const c = hex instanceof THREE.Color ? hex.clone() : new THREE.Color(hex);
  if (scale !== 1) c.multiplyScalar(scale);
  const band = ALBEDO_BAND[cls];
  if (!band) return c;
  const y = luminance(c.r, c.g, c.b);
  if (y <= 1e-5) return c.setScalar(band[0]);
  const target = THREE.MathUtils.clamp(y, band[0], band[1]);
  return c.multiplyScalar(target / y);
}

/**
 * Open a flat colour zone on a surface: every vertex emitted from here until
 * the next call carries this graded colour.
 *
 * This is how ANIME_PIPELINE §5's colour blocking is actually built. The
 * alternative — one part per colour — would multiply the party's draw calls by
 * four, and painting a finished geometry by re-deriving which zone a vertex
 * belongs to from its position is the kind of thing that works until a
 * proportion changes and then silently mis-assigns a whole zone with no way to
 * tell from the result. Recording it at emission is unconditionally correct.
 *
 * A part that calls this must be pushed with `painted: true` so the assembly
 * pass does not flatten it back to one colour.
 */
function zone(surface, hex, cls, scale = 1) {
  return surface.ink(gradeAlbedo(hex, cls, scale));
}

/** Flat vertex colour for a whole part, written in linear space. */
function paint(geometry, hex, cls, scale = 1) {
  const c = gradeAlbedo(hex, cls, scale);
  const count = geometry.getAttribute('position').count;
  const arr = geometry.getAttribute('color').array;
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geometry.getAttribute('color').needsUpdate = true;
}

// ============================================================== materials

/**
 * Toon material construction.
 *
 * `render/ToonMaterial.js` owns the project's shading contract — the band
 * count, the tinted shadow gradient, the anisotropic specular and the mandatory
 * rim all live there so the party, the NPCs and the espers cannot drift apart.
 * This module only chooses a preset per shading class; every numeric look
 * decision belongs to that file.
 *
 * Nothing is passed a texture. ANIME_PIPELINE's absolute rule is that no
 * procedural noise touches a character surface — on a character an fBm normal
 * or roughness map reads as dirt, and the client rejected the first cast partly
 * for exactly that. The one map on a character is the painted face, and it
 * arrives through `map` on the `face` class alone.
 *
 * `vertexColors` is on for every class but that one, because a character is
 * authored as one geometry per *shading class* rather than one per colour.
 * Auren's cobalt coat, his gold trim and his bone trousers are all `cloth`:
 * same shading, three flat colours, one draw call.
 */
function toonMaterial(preset, spec = {}) {
  return createToonMaterial({ preset, vertexColors: true, ...spec });
}

/**
 * The rim envelope every *body* surface shares.
 *
 * REFERENCE_TARGET §1 calls a bright rim/back light "critical [...] in every
 * frame" and ART_BIBLE §5.6 says a silhouette that merges with the background
 * has to earn one. The failure the review found — a hotspot on the top of the
 * cranium and nothing along the torso, skirt or legs — is a *directional* one:
 * with a pure `dot(N, rimDir)` weight the band only exists where the rig's rim
 * vector points, and at the dusk key that is the upper hemisphere.
 *
 * `render/ToonMaterial.js` owns the fix (`uToonRimFloor` puts a floor under the
 * directional weight so the band is continuous around the whole silhouette and
 * the direction rides on top of it). This block is the character-side half:
 * lift that floor for the classes that actually form the outline, and hold the
 * fresnel at the specified power 3.0 so the band stays in the outer quarter of
 * the silhouette instead of washing across the form.
 *
 * Colour and intensity are deliberately *not* overridden. `Lighting` publishes
 * `RING_GLOW` at 0.85–1.32 from the ring's azimuth — ART_BIBLE §5.6's value —
 * and `createToonMaterial` aliases those uniform objects, so writing them here
 * would break the alias and leave a dusk party carrying a noon rim.
 */
const BODY_RIM = Object.freeze({
  rimPower: 3.0,
  rimFloor: 0.55,
});

/**
 * Unlit emissive for tattoo lines, chime-bells, vents and orrery rings.
 *
 * Deliberately *not* a toon material: these surfaces must not take a shadow
 * band, because a light source that goes dark on the shadow side stops being a
 * light source. ART_BIBLE §2.2 reserves supra-1.0 emissive for magic, so this
 * sits at exactly 1.0 and lets the bloom threshold decide.
 */
function glowMaterial(name) {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    toneMapped: true,
    fog: true,
    name: `${name}-glow`,
  });
}

// ============================================================ body builders

/**
 * The silhouette block, resolved with defaults.
 *
 * REFERENCE_TARGET §1 makes "a clean, distinct black silhouette at 80 px" a
 * hard requirement and the review found the party failing it on the *body*:
 * identical box torso, straight untapered tube legs, the same egg head, with
 * colour doing all the identification work. Costume and hair were already
 * differentiated; the mass underneath them was not.
 *
 * These four numbers are the mass. `hip`/`waist`/`chest` reshape the trunk
 * (see `buildTorso`) and `limbTaper` scales how hard a limb narrows from its
 * root to its extremity, which is what turns a tube into a leg. Stance width
 * lives in `proportions.stance` instead, because `Rig` has to place the joints
 * before anything can be built against them.
 *
 * They are deliberately *shape* controls, not size controls. A scalar girth
 * multiplier — which is all the roster had — changes a figure's area but leaves
 * its outline the same rectangle, which is exactly the failure being fixed.
 */
const SILHOUETTE_DEFAULTS = Object.freeze({
  hip: 0, waist: 0, chest: 0, limbTaper: 1,
});

function silhouetteOf(def) {
  return { ...SILHOUETTE_DEFAULTS, ...(def.silhouette ?? {}) };
}

/**
 * Limb radii at root, mid joint and extremity, per limb, in world units.
 *
 * REFERENCE §1 says limbs have "no visible elbow/knee articulation detail"; the
 * plate says they do, plainly, on all four figures, and `buildLimb` now models
 * it. What survives from that note is the **taper**, which the plate agrees
 * with. The previous numbers were `girth.thigh × 1.06 → knee → ankle`, a 1.38:1
 * taper over the whole leg — which at eighty pixels is a straight tube, and six
 * straight tubes are six identical silhouettes. Just over 2:1 is what actually
 * reads: a heavy thigh and upper arm, a narrow wrist and ankle disappearing
 * into a cuff and a boot.
 *
 * The wrist and ankle values are returned rather than recomputed by each
 * consumer because the mitten, the sleeve cuff and the boot shaft all have to
 * *swallow* the tube's end. A taper tuned in one place and a hand sized in
 * another is how a limb ends in a visible step, which is the defect
 * `buildHand`'s stationing exists to prevent.
 */
function limbRadii(m, sil) {
  const g = m.girth;
  const k = sil.limbTaper;
  const taper = (root, mid, tip) => ({
    root: root * THREE.MathUtils.lerp(1, 1.22, k),
    mid: mid * THREE.MathUtils.lerp(1, 0.94, k),
    tip: tip * THREE.MathUtils.lerp(1, 0.80, k),
  });
  return {
    arm: taper(g.arm, g.elbow, g.wrist),
    leg: taper(g.thigh, g.knee, g.ankle),
  };
}

/**
 * Torso: one continuous lathed mass from hip to neck, in three flat colour
 * zones.
 *
 * The radius profile is the character's read from the front — Bramm's widest
 * ring is at the belt, Auren's at the chest, Seren's barely varies. Ring 0 is
 * placed *below* the hip joint so the pelvis has volume under the belt line;
 * without it a chibi torso looks like it is standing on two sticks.
 *
 * ### The colour zones, and why the profile has duplicate rows
 *
 * The trunk is the largest single area on a character, so it is where
 * ANIME_PIPELINE §5's blocking either happens or does not: `secondary` below
 * the belt, a narrow `trim` sash across it, `identity` above. That is a
 * garment, a waist and a coat, and the value break at the belt is what stops
 * the figure reading as one lozenge at eighty pixels.
 *
 * Vertex colour interpolates across a quad, so a zone change between two
 * *adjacent* rings would render as a gradient — precisely the soft, muddy
 * transition the pipeline is trying to eliminate. Emitting the boundary ring
 * **twice**, once in each colour, gives a hard edge instead: the two rings are
 * coincident so the quad between them has zero area and never rasterises, and
 * `mergeVertices` cannot weld them because they differ in the colour attribute.
 */
function buildTorso(s, m, pal, sil) {
  const g = m.girth;
  const hipY = m.joints.hips.y;
  const neckY = m.joints.neck.y;
  const span = neckY - hipY;

  /**
   * Three smooth bumps along the trunk — pelvis, waist, ribcage — that the
   * roster's `silhouette` block pushes in or out independently.
   *
   * This is the answer to the review's "all six share an identical box torso".
   * They did, literally: the profile table below was the *only* trunk in the
   * game and the six differed by a scalar girth multiplier, which changes a
   * figure's area but not its shape — flatten two of them to black at eighty
   * pixels and they are the same rectangle. A per-character bump triple is the
   * cheapest thing that changes the *outline*: Bramm's pelvis and ribs both push
   * out while his waist pushes out further (a keg), Kite's waist pulls in hard
   * against a flared pelvis (an hourglass), Emrys's coat swings out below the
   * belt and in at the shoulders (a bell with a child on top). Same eleven
   * rings, six genuinely different silhouettes.
   *
   * Each bump is a raised cosine so the shaping never introduces a crease of
   * its own; the hard edges in the trunk are the *colour* zones, which is where
   * ANIME_PIPELINE §5 wants them.
   */
  const bump = (t, centre, width) => {
    const k = THREE.MathUtils.clamp(Math.abs(t - centre) / width, 0, 1);
    return 0.5 + 0.5 * Math.cos(k * Math.PI);
  };
  const shapeAt = (t) => 1
    + sil.hip * bump(t, -0.02, 0.42)
    + sil.waist * bump(t, 0.34, 0.34)
    + sil.chest * bump(t, 0.82, 0.42);

  // [t along hips→neck, xScale, zScale, zOffset, zone]
  // The waist pinch is deep on purpose (0.78 at t = 0.34): a 14% variation
  // across the trunk is invisible once the figure is eighty pixels tall, which
  // is part of how four of the six ended up reading as the same lozenge. 22%
  // survives the downscale and is still well inside chibi proportions, where
  // the trunk is one soft mass rather than an anatomy study.
  //
  // The doubled rows at 0.10 and 0.24 are the sash's two hard edges.
  const profile = [
    [-0.30, 0.88, 0.88, -0.004, 'secondary'],
    [-0.12, 1.02, 1.02, -0.002, 'secondary'],
    [0.10, 0.94, 0.92, 0.000, 'secondary'],
    [0.10, 0.94, 0.92, 0.000, 'trim'],
    [0.24, 0.85, 0.85, 0.002, 'trim'],
    [0.24, 0.85, 0.85, 0.002, 'identity'],
    [0.34, 0.78, 0.80, 0.004, 'identity'],
    [0.58, 0.92, 0.90, 0.008, 'identity'],
    [0.80, 1.04, 1.02, 0.006, 'identity'],
    [0.95, 0.88, 0.86, 0.002, 'identity'],
    [1.06, 0.52, 0.52, 0.000, 'identity'],
  ];
  const path = [];
  const scales = [];
  const inks = [];
  for (const [t, sx, sz, dz, name] of profile) {
    path.push(new THREE.Vector3(0, hipY + span * t, dz * m.height));
    // Below the waist the hip girth dominates, above it the chest does; the
    // crossover is at t = 0.34, which is where a chibi's "waist" reads.
    const k = THREE.MathUtils.clamp((t - 0.10) / 0.45, 0, 1);
    const shape = shapeAt(t);
    const rx = THREE.MathUtils.lerp(g.hipX, g.chestX, k) * sx * shape;
    const rz = THREE.MathUtils.lerp(g.hipZ, g.chestZ, k) * sz * shape;
    scales.push([rx, rz]);
    // Graded once per ring rather than once per vertex: `sweep` consults the
    // scale function for every column, and `gradeAlbedo` allocates.
    inks.push(gradeAlbedo(pal[name], 'cloth'));
  }
  sweep(s, path, SECTIONS.square(28, 0.90), (i) => {
    s.ink(inks[i]);
    return scales[i];
  }, { capStart: true, capEnd: true });
}

/** Neck: short, mostly swallowed by the collar, but it must exist or the head floats. */
function buildNeck(s, m) {
  const g = m.girth;
  const y0 = m.joints.neck.y - g.neck * 0.6;
  const y1 = m.head.chinY + m.head.ry * 0.20;
  sweep(
    s,
    [new THREE.Vector3(0, y0, 0), new THREE.Vector3(0, (y0 + y1) * 0.5, 0.002), new THREE.Vector3(0, y1, 0.004)],
    SECTIONS.circle(20),
    (i) => { const r = [g.neck * 1.05, g.neck, g.neck * 1.15][i]; return [r, r * 0.92]; },
    { capStart: false, capEnd: false },
  );
}

/**
 * Head: a near-sphere with a jaw taper and a slight cranial lift.
 *
 * `profile(v)` narrows the lower third to make a chin and widens the upper
 * middle to make a cranium. Both are small — REFERENCE §1 wants "near-spherical,
 * slightly wider than tall" — but without them the head is a ball and the
 * character reads as a doll rather than as a person drawn small.
 */
function buildHead(s, m) {
  const h = m.head;
  blob(s, {
    cx: 0, cy: h.center.y, cz: 0,
    rx: h.rx, ry: h.ry, rz: h.rz,
    eU: 1, eV: h.eV, segU: 32, segV: 22,
    profile: h.profile,
  });
  // Ears: two flat nubs that stop the head silhouette from being a perfect
  // circle. Their placement is solved in `Rig.computeMetrics` against the
  // hairline rather than authored, because an ear whose top rises above the
  // hairline punches through the hair shell and mottles the temple — half of
  // the "camo blotching across every skull" the review found. No `capDrop` in
  // the roster can reintroduce it now.
  const ear = m.ear;
  for (const side of [1, -1]) {
    blob(s, {
      cx: side * ear.cx, cy: ear.cy, cz: ear.cz,
      rx: ear.rx, ry: ear.ry, rz: ear.rz,
      eU: 0.9, eV: 0.9, segU: 12, segV: 9,
    });
  }
}

/** Unit-height Gaussian bump, for the anatomy profiles below. */
const bell = (t, centre, width) => {
  const k = (t - centre) / width;
  return Math.exp(-k * k);
};

/**
 * The anatomy of a limb, as a radius multiplier and a back-offset along `t`.
 *
 * This is the table the review's "limbs are tapered tubes with no elbow/knee/
 * calf mass" is answered from, and it is worth being explicit about why a table
 * rather than a smarter taper: a limb's outline is not monotonic. It swells at
 * the belly of each muscle group and pinches at each joint, and every one of
 * those features sits at a *fixed fraction of the limb* on every human being.
 * A single root→mid→tip lerp cannot produce a non-monotonic outline at all, so
 * no amount of retuning the three radii was ever going to get there.
 *
 * `scale` multiplies the tapered radius; `back` displaces the ring away from the
 * limb's front, in units of the local radius, which is what puts the calf mass
 * behind the shin instead of ringing it. Both are read off the plate's figures,
 * whose sleeves and hose are close enough to the body to show the outline:
 *
 *  - **arm.** Deltoid/biceps belly at 22% with a 15% swell; the sleeve narrows
 *    into the elbow; the brachioradialis mass sits just past it at 60% (+11%),
 *    then a hard run down to the wrist. The forearm's fullest point being
 *    *below* the elbow rather than at it is the single detail that stops an arm
 *    reading as two cones stuck together.
 *  - **leg.** Thigh mass high and heavy (+13% at 15%), knee, then the
 *    gastrocnemius at 64% — the biggest single feature on a limb at +21%, and
 *    displaced 0.5 r rearward so the shin keeps a straight front line and the
 *    calf hangs off the back of it. The plate's characters are all in hose or
 *    tight boots and every one of them shows this.
 */
const LIMB_ANATOMY = Object.freeze({
  arm: {
    scale: (t) => 1 + 0.15 * bell(t, 0.22, 0.16) + 0.11 * bell(t, 0.60, 0.13),
    back: (t) => 0.10 * bell(t, 0.60, 0.15),
    /** A sleeved arm is marginally deeper than it is wide. */
    aspect: 1.03,
  },
  leg: {
    scale: (t) => 1 + 0.13 * bell(t, 0.15, 0.18) + 0.21 * bell(t, 0.64, 0.13),
    back: (t) => 0.50 * bell(t, 0.66, 0.15) - 0.14 * bell(t, 0.44, 0.10),
    /** A shin is flat across the front and deep front-to-back. */
    aspect: 1.06,
  },
});

/**
 * A limb swept along its joint chain, with muscle mass on it.
 *
 * **The joint parameter is measured, not assumed.** `smoothPath` returns
 * *arc-length-uniform* points, so the mid joint only lands at `t = 0.5` when the
 * two segments happen to be the same length. They are not — the femur is 55% of
 * the leg and the humerus 52% of the arm — so a `t < 0.5` split puts the radius
 * break up to five per cent of the limb away from the joint it describes.
 *
 * **The joint carries volume.** `jointSwell` is a narrow Gaussian centred on the
 * real joint. This is the direct counter to the one unavoidable artefact of
 * linear blend skinning: where two bones share a cross-section evenly, a bend of
 * θ shrinks that section by about `cos(θ/2)`, so a 90° elbow loses 29% of its
 * radius. Putting 14% back *at the joint only* means the crease still creases —
 * which is what makes a limb read as jointed — while the silhouette through the
 * fold stays convex instead of nipping in like a bent drinking straw.
 *
 * **The muscle mass comes from `LIMB_ANATOMY`,** which is where the outline
 * stops being monotonic and the limb stops being a cone.
 *
 * **Density.** 21 rings of 20 columns. The columns are what the brief is about:
 * at 12 a limb's silhouette is a 12-gon, whose facet-to-facet normal step is 30°
 * — far past any toon ramp's band width, so every arm printed a hard vertical
 * stripe down its lit side whatever the shader did. At 20 the step is 18° and
 * the ramp resolves it as one gradient. It costs about 370 extra triangles per
 * limb — 800 against the old 432 — so 1 500 per character and 9 000 across the
 * cast, against a meadow of 1.7 M. That is not a number worth protecting.
 *
 * @param {'arm'|'leg'} kind which anatomy table to apply
 * @param {number} [jointSwell] fractional radius gain at the mid joint
 */
function buildLimb(s, a, b, c, r0, r1, r2, kind = 'arm', seg = 20, jointSwell = 0.14) {
  const anat = LIMB_ANATOMY[kind] ?? LIMB_ANATOMY.arm;
  const path = smoothPath([a, b, c], 21);
  // Where the mid joint actually falls along an arc-length parameterisation.
  const l0 = a.distanceTo(b);
  const tj = THREE.MathUtils.clamp(l0 / (l0 + b.distanceTo(c)), 0.15, 0.85);
  // Tangents are taken from the *undisplaced* path in a first pass: displacing a
  // ring changes its neighbours' finite-difference tangent, and letting that
  // feed back would make the offset direction depend on iteration order.
  const tangent = [];
  for (let i = 0; i < path.length; i++) {
    tangent.push(new THREE.Vector3().subVectors(
      path[Math.min(i + 1, path.length - 1)], path[Math.max(i - 1, 0)],
    ).normalize());
  }

  const radii = [];
  const backDir = new THREE.Vector3();
  for (let i = 0; i < path.length; i++) {
    const t = i / (path.length - 1);
    const r = t < tj
      ? THREE.MathUtils.lerp(r0, r1, t / tj)
      : THREE.MathUtils.lerp(r1, r2, (t - tj) / (1 - tj));
    const k = (t - tj) / 0.14;
    const rr = r * anat.scale(t) * (1 + jointSwell * Math.exp(-k * k));
    radii.push(rr);

    // Displace the ring rearward. The offset is taken along world −Z with the
    // limb's own tangent projected out, so it stays perpendicular to the limb
    // however the pre-bend has angled it and never shortens the segment.
    const off = anat.back(t);
    if (off !== 0) {
      const tg = tangent[i];
      backDir.set(0, 0, -1).addScaledVector(tg, tg.z);
      const len = backDir.length();
      if (len > 1e-5) path[i].addScaledVector(backDir, (off * rr) / len);
    }
  }
  sweep(s, path, SECTIONS.circle(seg),
    (i) => [radii[i], radii[i] * anat.aspect], { capStart: true, capEnd: true });
}

/**
 * The hand frame: an orthonormal basis at the wrist in which the hand is easy
 * to author, plus the grip expressed in it.
 *
 * `+y` runs down the hand (the forearm's own direction, so a finger authored
 * along +y continues the arm), `+z` is the palm normal — the side the fingers
 * close toward — and `+x` completes it. `medialX` is which way `+x` points
 * relative to the body, so the thumb can be placed on the inboard edge without
 * anyone having to reason about the A-pose splay per side.
 */
function handFrame(m, side) {
  const sfx = side > 0 ? 'L' : 'R';
  const wrist = m.joints[`hand${sfx}`];
  const elbow = m.joints[`forearm${sfx}`];
  const grip = m.grip[sfx];

  const origin = new THREE.Vector3(wrist.x, wrist.y, wrist.z);
  const yAxis = new THREE.Vector3(wrist.x - elbow.x, wrist.y - elbow.y, wrist.z - elbow.z).normalize();
  const zAxis = new THREE.Vector3(grip.normal.x, grip.normal.y, grip.normal.z)
    .addScaledVector(yAxis, -yAxis.dot(new THREE.Vector3(grip.normal.x, grip.normal.y, grip.normal.z)))
    .normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();

  const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).setPosition(origin);
  // The grip, in hand-local coordinates. Its x is zero by construction (the
  // socket sits on the hand's own axis), so only the reach along the hand and
  // the stand-off through the palm matter.
  const g = new THREE.Vector3(grip.center.x, grip.center.y, grip.center.z).sub(origin);
  return {
    basis,
    origin, xAxis, yAxis, zAxis,
    gripY: g.dot(yAxis),
    gripZ: g.dot(zAxis),
    gripR: grip.radius,
    // Which local x is inboard. `-side` is the body's centreline direction from
    // this hand, so its sign against the frame's own x axis is the answer.
    medialX: Math.sign(xAxis.x * -side) || 1,
  };
}

const smoothstep01 = (x) => { const t = x < 0 ? 0 : x > 1 ? 1 : x; return t * t * (3 - 2 * t); };

/**
 * A digit: a tapered tube swept along an arc that closes onto the grip.
 *
 * The curl is **solved against the haft, not authored**. The arc is centred on
 * the grip axis at a radius of exactly `gripR + fingerR`, so a closed finger
 * touches the haft along its whole length by construction — at any hand size,
 * for any weapon, with no per-character tuning. That is the difference between
 * a fist that grips and a fist that is merely near the weapon, and it is the
 * reason `Rig.computeMetrics` publishes the grip at all.
 *
 * The first phalanx eases the radius from wherever the knuckle actually sits to
 * the wrap radius, so the finger leaves the knuckle in the direction the palm
 * points and only then closes. Straightening it is the same code with a small
 * sweep angle: an open hand is a closed one that never got there.
 */
function digit(s, f, { x, y0, z0, length, radius, close, segments = 3 }) {
  const cy = f.gripY;
  const cz = f.gripZ;
  const wrap = f.gripR + radius;
  // Where the knuckle sits relative to the grip centre, in the hand's y–z plane.
  const k = { y: y0 - cy, z: z0 - cz };
  const start = Math.atan2(k.z, k.y);
  const r0 = Math.max(Math.hypot(k.y, k.z), wrap * 0.6);
  // Sweep enough angle for the finger's own length at the wrap radius, but never
  // past 2.7 rad — beyond that a fingertip re-enters the palm.
  const span = Math.min(length / wrap, 2.7) * close;

  const n = segments * 3;
  const pts = [];
  const radii = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = start + span * t;
    // Radius eases from the knuckle's own stand-off to the wrap radius over the
    // proximal third, then holds — so the finger meets the haft and stays on it.
    const r = THREE.MathUtils.lerp(r0, wrap, smoothstep01(t / 0.34));
    // Open hands have no arc to ride, so the length has to come from somewhere:
    // whatever the sweep does not consume is spent running straight on.
    const straight = length * Math.max(0, 1 - span * wrap / Math.max(length, 1e-6));
    pts.push(new THREE.Vector3(
      x,
      cy + r * Math.cos(a) + straight * t * Math.cos(start),
      cz + r * Math.sin(a) + straight * t * Math.sin(start),
    ));
    // Knuckles are the widest part of a finger and the tip the narrowest; three
    // pads make the taper read as jointed rather than as a cone.
    const pad = 1 + 0.10 * Math.cos(t * segments * TAU);
    radii.push(radius * THREE.MathUtils.lerp(1.0, 0.62, t) * pad);
  }
  const path = [];
  for (const p of pts) path.push(p.clone().applyMatrix4(f.basis));
  sweep(s, path, SECTIONS.circle(10), (i) => [radii[i], radii[i]], { capStart: true, capEnd: true });
}

/**
 * Hand: a palm and five digits, closing on the weapon the character is holding.
 *
 * REFERENCE_TARGET §1 says "hands are mitten-like simple masses" and the plate
 * says otherwise. On `bravely01.jpg` the staff-mage's gloved hand is 37 × 29
 * source pixels against a 100-pixel head — nearly two-fifths of a head — and
 * every finger reads individually against the haft, as do the knight's on his
 * sword and the archer's on her bow. At the party's on-screen size a mitten is
 * not a simplification of that, it is a different object: the hand is one of
 * only three places on a character where the silhouette has interior structure
 * (the others are the hair and the boot), and it is the one the eye goes to
 * because it is where the weapon is.
 *
 * ### The join is still stepless
 *
 * The palm starts *inside the sleeve*, at a ring exactly the tapered wrist's
 * radius, and swells from there. The old mitten's whole argument for being a
 * sweep rather than a blob — that the eye reads a step in cross-section as two
 * objects however much they overlap — is unaffected by there being fingers on
 * the end of it, so the construction is kept.
 */
function buildHand(s, m, side, wristR, close = 1) {
  const f = handFrame(m, side);
  const h = m.hand;
  const knuckleZ = h.thickness * 0.10;

  // ---- palm: wrist ring → knuckle line, buried back into the sleeve --------
  const stations = [
    [-h.palm * 0.62, wristR * 0.94, wristR * 0.98],
    [0, wristR * 1.02, wristR * 1.14],
    [h.palm * 0.46, h.width * 0.50, h.thickness * 0.52],
    [h.palm * 0.90, h.width * 0.49, h.thickness * 0.48],
    [h.palm * 1.06, h.width * 0.40, h.thickness * 0.38],
  ];
  const path = stations.map(([d]) => new THREE.Vector3(0, d, 0).applyMatrix4(f.basis));
  sweep(s, path, SECTIONS.square(20, 0.80),
    (i) => [stations[i][1], stations[i][2]],
    { capStart: true, capEnd: true });

  // ---- four fingers -------------------------------------------------------
  //
  // Spaced across the knuckle line and slightly staggered in length — index,
  // middle, ring, little. The stagger is what stops four identical tubes
  // reading as a comb; at battle distance it is the only thing that does.
  const span = h.width * 0.78;
  const lengths = [0.98, 1.06, 1.00, 0.84];
  for (let i = 0; i < 4; i++) {
    const u = i / 3 - 0.5;
    digit(s, f, {
      // Ordered from the thumb side outward, so `lengths` reads index-first
      // whichever hand this is.
      x: u * span * f.medialX * -1,
      y0: h.palm,
      z0: knuckleZ,
      length: h.finger * lengths[i],
      radius: h.fingerR * (1 - Math.abs(u) * 0.16),
      close,
    });
  }
  // The knuckle line itself: a low ridge across the back of the hand. Without it
  // the four fingers sprout from a flat edge and the hand reads as a rake.
  blob(s, {
    cx: 0, cy: h.palm * 0.98, cz: 0,
    rx: h.width * 0.48, ry: h.thickness * 0.34, rz: h.thickness * 0.46,
    eU: 0.7, eV: 0.8, segU: 16, segV: 12,
    matrix: f.basis,
  });

  // ---- thumb --------------------------------------------------------------
  //
  // Opposed: it leaves the inboard edge of the palm well short of the knuckles
  // and closes across the haft from the other side, which is what actually makes
  // a fist a fist. Rooted with a blob overlapping the palm by more than its own
  // radius so the welder fuses the two into one silhouette.
  const tx = f.medialX * h.width * 0.42;
  blob(s, {
    cx: tx, cy: h.palm * 0.30, cz: h.thickness * 0.16,
    rx: h.thumbR * 1.15, ry: h.thumbR * 1.30, rz: h.thumbR * 1.10,
    eU: 0.85, eV: 0.85, segU: 16, segV: 12,
    matrix: f.basis,
  });
  const tPath = [];
  const tRad = [];
  const tSpan = 1.35 * close + 0.35;
  const tStart = -0.55;
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const a = tStart + tSpan * t;
    const r = f.gripR + h.thumbR * 0.95;
    tPath.push(new THREE.Vector3(
      // The thumb crosses the haft, so its x travels from the palm's edge back
      // toward the centreline as it closes.
      tx * (1 - 0.55 * t * close),
      f.gripY + r * Math.cos(a),
      f.gripZ + r * Math.sin(a),
    ).applyMatrix4(f.basis));
    tRad.push(h.thumbR * THREE.MathUtils.lerp(1.0, 0.66, t));
  }
  sweep(s, tPath, SECTIONS.circle(10), (i) => [tRad[i], tRad[i]], { capStart: true, capEnd: true });
}

/**
 * The sleeve cuff: a short flared ring at the wrist, in the costume colour.
 *
 * Insurance rather than decoration. Even with the hand buried in the forearm,
 * the *skin* and *cloth* shading classes meet somewhere along the wrist and a
 * hard colour boundary across a smooth tube reads as a seam. A cuff makes that
 * boundary an intentional edge of tailoring, and it is the standard chibi
 * solution for the same reason.
 */
function buildCuff(s, m, side, armR) {
  const g = m.girth;
  const wrist = m.joints[side > 0 ? 'handL' : 'handR'];
  const elbow = m.joints[side > 0 ? 'forearmL' : 'forearmR'];
  const a = new THREE.Vector3(elbow.x, elbow.y, elbow.z);
  const b = new THREE.Vector3(wrist.x, wrist.y, wrist.z);
  const dir = b.clone().sub(a).normalize();
  // Measured off the palm rather than off `girth.hand`: the boundary the cuff
  // exists to hide is the skin/cloth change at the wrist, and the palm is what
  // sets where that now falls.
  const p0 = b.clone().addScaledVector(dir, -m.hand.palm * 0.52);
  const p1 = b.clone().addScaledVector(dir, m.hand.palm * 0.10);
  // **Closed at both ends.** It used to open at `p0` with `capStart: false` and
  // a first ring wider than the sleeve underneath it, which leaves a bare
  // boundary in mid-air: from the battle camera you look straight into the
  // cuff's culled backfaces, and a one-sided ring lit by the mandatory rim
  // reads as a thin bright sliver hanging off the wrist. That is the review's
  // "white sliver shooting off character 3's hand" — not z-fighting, an open
  // shell. Sealing the ring against the sleeve is the fix, and the first ring
  // is pulled *inside* the tapered forearm so the cap can never be seen either.
  const seal = Math.min(armR.mid, armR.tip * 1.35) * 0.90;
  sweep(s, [p0, p0.clone().lerp(p1, 0.55), p1], SECTIONS.circle(20),
    (i) => { const r = [seal, g.wrist * 1.34, g.wrist * 1.46][i]; return [r, r * 0.95]; },
    { capStart: true, capEnd: true });
}

/**
 * Boot: a chunky wedge, wider and taller than an anatomical foot.
 *
 * The whole party's ground contact reads through these, and a small foot makes
 * a chibi look like it is about to tip over. `eU = 0.5` squares the cross
 * section so the boot has an edge to catch the key light along.
 */
function buildBoot(s, m, side, cuffHeight = 0.0, zones = null) {
  const f = m.foot;
  const g = m.girth;
  const ankle = m.joints[side > 0 ? 'footL' : 'footR'];
  const cz = ankle.z + f.length * 0.14;
  // The boot must be wider than the ankle it caps. If it is not, the leg tube's
  // flat end cap projects past it and the character terminates in a square-cut
  // stump — the defect the review calls "the clearest single tell that these are
  // unfinished proxies". 1.30 is a 30% overhang all the way round, which reads
  // as a chunky boot rather than as a sock.
  const halfW = Math.max(f.width * 0.5, g.ankle * 1.30);
  const halfL = Math.max(f.length * 0.5, g.ankle * 1.65);

  // Two flat zones per §5: the boot body in the dark leather accent, the shaft
  // in the bright trim. A single-colour boot is a black blob at the bottom of
  // the silhouette; the cuff is what makes the leg terminate in a *shape*.
  if (zones) zone(s, zones.body, 'cloth');

  // Main mass: sole to instep. `eU = 0.45` squares the cross-section so the
  // boot has a real edge for the key light to catch along its outside.
  blob(s, {
    cx: ankle.x, cy: f.height * 0.50, cz,
    rx: halfW, ry: f.height * 0.55, rz: halfL,
    eU: 0.45, eV: 0.55, segU: 22, segV: 14,
    profile: (v) => 1 - Math.pow(THREE.MathUtils.clamp((v - 0.55) / 0.45, 0, 1), 1.4) * 0.26,
  });
  // Toe box: pushed forward and flattened, so the foot has direction. Without
  // it the boot is a symmetric lozenge and a walk cycle reads backwards.
  blob(s, {
    cx: ankle.x, cy: f.height * 0.32, cz: cz + halfL * 0.62,
    rx: halfW * 0.90, ry: f.height * 0.34, rz: halfL * 0.30,
    eU: 0.50, eV: 0.55, segU: 16, segV: 10,
  });
  // Heel block: a hard corner behind the ankle. Two hundred triangles, and it
  // is the difference between a boot and a slipper in silhouette.
  blob(s, {
    cx: ankle.x, cy: f.height * 0.26, cz: cz - halfL * 0.74,
    rx: halfW * 0.80, ry: f.height * 0.30, rz: halfL * 0.22,
    eU: 0.35, eV: 0.40, segU: 14, segV: 9,
  });
  // Ankle shaft: rises past the leg's own end cap and swallows it. Always
  // built, cuffed or not — a bare foot still needs its ankle closed.
  const shaft = Math.max(cuffHeight, g.ankle * 0.55);
  if (zones) zone(s, cuffHeight > 0 ? zones.cuff : zones.body, 'cloth');
  sweep(
    s,
    [new THREE.Vector3(ankle.x, f.height * 0.55, ankle.z),
      new THREE.Vector3(ankle.x, f.height + shaft * 0.55, ankle.z),
      new THREE.Vector3(ankle.x, f.height + shaft, ankle.z)],
    SECTIONS.circle(22),
    (i) => {
      const r = [halfW * 0.92, g.ankle * 1.24, g.ankle * (cuffHeight > 0 ? 1.34 : 1.10)][i];
      return [r, r * 1.06];
    },
    { capStart: false, capEnd: true },
  );
}

// ================================================================== face

/** Signed power, the superellipse primitive every surface here is built from. */
const pw = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);

const _faceRow = { phi: 0, halfWidth: 0, depth: 0 };
const _plateRow = { phi: 0, halfWidth: 0, depth: 0 };
const _plateOut = new THREE.Vector3();

/**
 * The skull's cross-section half-width and front depth at a given height.
 *
 * `dy` is measured from the head centre. Returns the latitude the row sits at,
 * the world half-width of the skull there (the largest `|x|` a face feature can
 * occupy on that row), and the skull's `z` on the centreline — which is the
 * depth the flattening pulls the whole row toward.
 */
function faceRow(m, dy, out = { phi: 0, halfWidth: 0, depth: 0 }) {
  const h = m.head;
  // Invert y = ry * sign(sin phi) * |sin phi|^eV.
  const ny = THREE.MathUtils.clamp(dy / h.ry, -0.999, 0.999);
  const sinPhi = Math.sign(ny) * Math.pow(Math.abs(ny), 1 / h.eV);
  const phi = Math.asin(THREE.MathUtils.clamp(sinPhi, -1, 1));
  const cr = Math.sign(Math.cos(phi)) * Math.pow(Math.abs(Math.cos(phi)), h.eV)
    * h.profile(phi / Math.PI + 0.5);
  out.phi = phi;
  out.halfWidth = h.rx * Math.max(cr, 1e-4);
  out.depth = h.rz * Math.max(cr, 1e-4);
  return out;
}

/**
 * The face plate surface: the point on the flattened face shield carrying face
 * coordinate `(ox, oy)`, measured from the plate centre.
 *
 * ### The construction, and what each term is defending against
 *
 * **`x` and `y` are returned exactly as asked.** That is the whole contract.
 * The UV is `0.5 + ox/size`, an affine function of the plate coordinate, so if
 * the world position is also affine in it then UV is affine in world position —
 * at any tessellation, on any proportions. The painted eye cannot stretch, skew
 * or shift, and the two eyes are provably identical in size and height because
 * the texture that draws them is mirrored about `ox = 0` and the surface is too.
 * The previous projector broke this in two places: it saturated `acos` once the
 * requested `x` ran past the local cross-section (the truncated outer eye the
 * review measured), and it applied the stand-off along the surface *normal*,
 * which drags `x` and `y` off the coordinate they were solved for.
 *
 * **Saturation is now impossible rather than clamped.** The caller asks for a
 * fraction of the row's own half-width, so the request is always satisfiable;
 * `buildFacePlate` sizes each ring against `faceRow().halfWidth`.
 *
 * **`z` is flattened toward the row's centre depth.** Across the eye pair a
 * chibi skull recedes about 0.19 head-radii, which foreshortens the outboard
 * eye the instant the head turns — the "different sizes at different heights"
 * finding. Pulling each row 62% toward its own centre depth is the face-shield
 * construction anime 3D uses, and it is bounded by design: the correction is
 * zero on the centreline and never exceeds the centre depth, so the plate can
 * never break the head's profile silhouette.
 *
 * **The rim scales toward the head centre.** The skull is star-shaped about that
 * point, so a ring scaled inward is unconditionally buried inside it — no
 * stand-off tuning, no visible plate edge under the rim light.
 */
function facePoint(m, ox, oy, r, out = new THREE.Vector3()) {
  const f = m.face;
  const h = m.head;
  const row = faceRow(m, f.centerY - h.center.y + oy, _faceRow);

  // Flattening: 1 inside `flatFrom`, easing to 0 by `flatTo` so the plate has
  // rejoined the skull before the rim dives.
  const fade = 1 - THREE.MathUtils.smoothstep(r, f.flatFrom, f.flatTo);
  const ct = ox / row.halfWidth;               // |ct| < 1 guaranteed by the caller
  const zSkull = row.depth * Math.sqrt(Math.max(0, 1 - ct * ct));
  const bury = THREE.MathUtils.smoothstep(r, f.buryFrom, 1);

  let x = ox;
  let y = f.centerY + oy;
  let z = zSkull + (row.depth - zSkull) * f.flatten * fade + f.lift * (1 - bury);

  if (bury > 0) {
    const k = 1 - f.buryDepth * bury;
    x *= k;
    y = h.center.y + (y - h.center.y) * k;
    z *= k;
  }
  return out.set(x, y, z);
}

/**
 * The face plate: the painted face texture's square, wrapped onto the skull.
 *
 * ANIME_PIPELINE §1 — this is the whole face. `FaceTexture.drawFace` paints
 * eyes, brows and mouth into a square canvas at fixed fractions of its edge;
 * this builds the surface that square lands on, and `Rig.computeMetrics` has
 * already solved the placement so that the layout's 56%-down eye line coincides
 * with the skull's anatomical one.
 *
 * ### Why the UVs are exact
 *
 * `faceProject` is a *planar* projection in disguise: it solves for the point on
 * the skull whose `(x, y)` are the ones asked for, and only `z` comes out of the
 * skull's shape. So world x and y equal the plate coordinates exactly, and the
 * UV — an affine function of those — is an affine function of world position.
 * A triangle is planar, position varies linearly across it, therefore UV does
 * too, at any tessellation. The painted face cannot stretch, skew or shift with
 * mesh density; the only thing tessellation buys is how closely the plate hugs
 * the skull.
 *
 * ### Why the plate is a rounded square, and why its lift goes negative
 *
 * The corners of a true square would project past the skull's cross-section at
 * the chin and the crown and pile up on its silhouette. A superellipse of
 * exponent 2.6 stays inside the skull everywhere while still reaching the
 * texture's outer margin — which is blank skin, because every drawn feature
 * sits well inside `FACE_LAYOUT`'s bounds.
 *
 * The stand-off then falls off as `1 - 1.35 r²`, crossing zero at 86% of the
 * radius so the plate's rim is *buried* inside the skull. That removes the
 * plate's edge from the silhouette entirely: what you see is the intersection
 * curve of two surfaces that are the same flat colour, shaded by the same
 * preset, with the same normals — invisible, including under the rim light,
 * which is where a hard floating edge would otherwise print a bright line
 * across the cheek.
 */
function buildFacePlate(m, pal) {
  const s = new Surface();
  const f = m.face;
  const h = m.head;
  // 10 × 40 rather than 7 × 32. Tessellation buys nothing in texture fidelity
  // — the UV is exactly affine either way — but it does control how closely the
  // shield hugs the skull between rings, and the coarse grid left a faceted
  // ridge across the cheekbone that the rim light picked out.
  const rings = 10;
  const seg = 40;
  const e = 2 / 2.6;

  // Painted, but the vertex colour still says "skin": the outline pass reads it
  // if this plate is ever outlined, and a white default would draw a white line.
  s.ink(pal.skin);
  s.patch(rings, seg, true, (i, j) => {
    const r = i / rings;
    const a = (j / seg) * TAU;
    const oy = pw(Math.sin(a), e) * f.halfY * r;
    // The ring's width is solved against the skull's *own* cross-section at
    // this height, capped at 94% of it. That single line is what makes the
    // projector unsaturatable: it can only ever be asked for an `x` the row can
    // actually supply, so there is no clamp, no pile-up, and no truncated eye.
    const row = faceRow(m, f.centerY - h.center.y + oy, _plateRow);
    const halfX = Math.min(f.halfX, row.halfWidth * 0.94);
    const ox = pw(Math.cos(a), e) * halfX * r;
    s.uvAt(0.5 + ox / f.size, 0.5 + oy / f.size);
    return facePoint(m, ox, oy, r, _plateOut);
  });
  // Ring 0 collapses to a point, so the plate is already closed; a fan cap here
  // would only add degenerate triangles for the welder to strip.
  return s;
}

/**
 * Force a face texture to clamp rather than tile, at the point of use.
 *
 * `buildFaceTexture` already sets both wraps, but the face is the one surface in
 * the game where a repeating wrap is not a cosmetic bug: a `u` outside [0, 1]
 * tiles a *second pair of eyes* onto the side of the skull, which is a defect no
 * amount of shading hides and which a reviewer reads as the character having
 * four eyes. The geometry can no longer produce such a UV (`face.halfX` is
 * capped below `face.size / 2` in `Rig.computeMetrics`), so this is the second
 * of two independent guards rather than the fix — and it is asserted here, at
 * the material, because that is where a future caller supplying its own texture
 * would otherwise slip past it.
 *
 * @param {THREE.Texture} tex
 * @returns {THREE.Texture} the same texture
 */
function clampFaceTexture(tex) {
  if (tex.wrapS !== THREE.ClampToEdgeWrapping || tex.wrapT !== THREE.ClampToEdgeWrapping) {
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
  }
  return tex;
}

/**
 * How far in front of the face shield a point sits, in world units.
 *
 * Negative means behind it — safely hidden. This is the invariant every hair
 * mass is held to: two of the six characters shipped with a hair volume parked
 * *in front of* the face, which is why the review found "a blank cream oval
 * with a single dot" where a face should be. Authoring the masses correctly is
 * the fix; this is the guard rail that makes the failure impossible to
 * reintroduce from the roster.
 *
 * Returns `-Infinity` for anything outside the plate's footprint, so hair that
 * legitimately frames the face from the side is never touched.
 */
function faceIntrusion(m, x, y, z) {
  const f = m.face;
  const h = m.head;
  // Only the painted eye envelope is protected. A fringe belongs in front of the
  // forehead and a beard in front of the chin, so a guard spanning the whole
  // plate would flatten both back into the skull.
  if (z <= 0 || y > f.guardTop || y < f.guardBottom || Math.abs(x) > f.guardX) {
    return -Infinity;
  }
  const oy = y - f.centerY;
  const row = faceRow(m, f.centerY - h.center.y + oy, _faceRow);
  const halfX = Math.min(f.halfX, row.halfWidth * 0.94);
  const u = Math.abs(x) / halfX;
  const v = Math.abs(oy) / f.halfY;
  // The plate's own superellipse metric, so "inside the face" means exactly
  // what `buildFacePlate` means by it.
  const r = Math.pow(Math.pow(u, 2.6) + Math.pow(v, 2.6), 1 / 2.6);
  if (r >= 0.98) return -Infinity;
  return z - facePoint(m, x, oy, r, _plateOut).z;
}

// ================================================================== hair

/**
 * A closed hair shell: outer surface, inner surface, and a rim strip joining
 * them at the hairline.
 *
 * ### Why both walls are built from `skullPoint`
 *
 * This shell used to be a plain ellipsoid scaled off `head.rx/ry/rz`, while the
 * skull it covers is a superellipsoid carrying a jaw taper and a cranium swell.
 * `profile()` widens the cranium by up to 4.5%, and the inner wall stood at
 * 0.5% — so across most of the crown the **scalp was outside the hair**, and
 * the two surfaces interleaved into the mottled, bruise-like camouflage the
 * review found on every head in `cast-lineup.png`. It was never z-fighting; the
 * hair was genuinely inside the head.
 *
 * Both walls are now radial offsets of the *same* skull definition. The skull is
 * star-shaped about the head centre, so any scale above 1 strictly encloses it:
 * interpenetration is impossible by construction rather than avoided by tuning.
 *
 * The walls are 7–8% of a head radius apart, which on a chibi skull is a little
 * over a centimetre of visible thickness at the hairline. That edge is what the
 * reference reads as *carved volume* rather than as paint, and it is the single
 * biggest difference between hair and a swim cap.
 */
function hairShell(s, {
  head, outer, inner, frontPhi, backPhi, peak,
  segU = 30, segV = 14, swell = 0.06, base, highlight, band,
}) {
  const ringOuter = [];
  const ringInner = [];
  const p = new THREE.Vector3();
  /**
   * One wall, optionally over a sub-range of the hairline→crown parameter.
   *
   * The range exists so the outer wall can be emitted as three patches that
   * share their boundary rows *exactly* — same `u`, same formula, same
   * position — while carrying different vertex colours. A colour change
   * between two adjacent rows of a single patch is a gradient across the quad
   * between them, which is the soft airbrushed transition ANIME_PIPELINE is
   * trying to eliminate; two patches meeting at a coincident row is a hard
   * edge with no crack, and `mergeVertices` cannot weld the pair away because
   * they differ in colour. It is the same technique `buildTorso` uses for the
   * sash.
   */
  const build = (scale, ring, from = 0, to = 1, flip = false) => {
    const grid = s.patch(segV, segU, true, (i, j) => {
      const theta = (j / segU) * TAU;
      const lo = hairlinePhi(theta, frontPhi, backPhi, peak);
      const u = from + (to - from) * (i / segV);
      const phi = lo + (Math.PI * 0.5 - lo) * u;
      // The crown swells: hair has bulk on top and is flat at the temples, and
      // that asymmetry is most of what separates a hairstyle from a helmet at
      // silhouette scale.
      const bulk = scale * (1 + swell * Math.pow(Math.max(0, Math.sin(phi)), 2));
      return skullPoint(head, theta, phi, bulk, p);
    }, flip);
    if (ring) for (const id of grid[0]) ring.push(id);
    return grid;
  };
  // The band is measured as a fraction of the hairline→crown run rather than
  // as a latitude, so it stays parallel to the hairline at every azimuth — i.e.
  // perpendicular to the direction the hair combs, which is exactly where §3
  // puts it. A fixed latitude would cross the hairline at the temples.
  if (band && base && highlight) {
    s.ink(base);
    build(outer, ringOuter, 0, band[0]);
    s.ink(highlight);
    build(outer, null, band[0], band[1]);
    s.ink(base);
    build(outer, null, band[1], 1);
  } else {
    build(outer, ringOuter);
  }
  if (base) s.ink(base);
  // The inner wall is the *underside* of the hair, so it has to face the skull,
  // which is the opposite handedness to the outer wall built from the identical
  // parameterisation. Wound the same way round — as it was — both walls face
  // away from the head centre, and since every character material is
  // `FrontSide` the underside of a fringe or a bob then culls away and the
  // viewer looks straight through the hair volume onto the scalp. That hole,
  // seen through the outer wall's own culled back faces, is what made every
  // head in the previous captures read as cracked glass rather than as hair.
  build(inner, ringInner, 0, 1, true);
  // Rim: the exposed edge at the hairline, so its normal runs *down and out*,
  // away from the crown. `quad(a,b,c,d)` normals are `(b−a)×(c−b)`; walking
  // outer→outer→inner→inner gives −φ̂ there, walking outer→inner→inner→outer
  // gives +φ̂ and buries the lip inside the hair mass.
  const n = ringOuter.length - 1;
  for (let j = 0; j < n; j++) {
    s.quad(ringOuter[j], ringOuter[j + 1], ringInner[j + 1], ringInner[j]);
  }
}

/**
 * FNV-1a over a character id — a stable seed that does not depend on the order
 * scenes happen to build their casts in.
 *
 * Hair shape draws a handful of random numbers (spike pitch, spike length), and
 * pulling them from the shared `rng` stream made a character's hair depend on
 * how many other characters had been built first: the party in a field scene
 * came out with different heads from the same party in a battle scene, and a
 * capture stopped being reproducible. `FaceTexture` seeds per character for
 * exactly this reason and this follows it.
 */
function hairSeed(id) {
  let h = 0x811c9dc5;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;
}

/**
 * Sweep one hair clump along its spine, framed by the **skull** rather than by
 * parallel transport.
 *
 * `sweep`'s transported frame carries whatever orientation the first segment
 * happened to have all the way to the tip, so a clump that curves over the crown
 * corkscrews and its broad face rolls edge-on. That is precisely how a
 * volumetric clump ends up reading as a flat card pasted onto a sphere — the
 * defect this rebuild exists to remove.
 *
 * Here the wide axis is Gram-Schmidted out of the **azimuthal** direction at the
 * clump's root — the way hair actually combs around a head — and the thin axis
 * is what is left over, then the pair is flipped if it came out pointing into
 * the skull so the section's flat underside always beds down. The result is a
 * broad plate that lies against the head along its whole length, which is what
 * ANIME_PIPELINE §3's "chunky geometric clump" is.
 *
 * @param {Surface} surface
 * @param {object} head `metrics.head`
 * @param {THREE.Vector3[]} path the spine, root first
 * @param {THREE.Vector3} combAxis preferred wide axis (azimuthal at the root)
 * @param {(i:number)=>number} widthAt half-width per spine sample
 * @param {(i:number)=>number} thickAt half-thickness per spine sample
 * @param {number[][]} section unit cross-section
 * @param {(i:number)=>void} [rowInk] called once per spine sample, before that
 *        sample's ring is emitted, so a caller can change the vertex colour
 *        between rows. Paired with a duplicated spine sample (see `bandSpine`)
 *        this produces a hard colour edge rather than a gradient.
 */
function clumpSweep(surface, head, path, combAxis, widthAt, thickAt, section, rowInk = null) {
  const n = path.length;
  const rows = n - 1;
  const cols = section.length;
  const tan = new THREE.Vector3();
  const wide = new THREE.Vector3();
  const rad = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const frames = [];

  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    tan.subVectors(b, a);
    if (tan.lengthSq() < 1e-14) tan.set(0, -1, 0);
    tan.normalize();

    wide.copy(combAxis).addScaledVector(tan, -combAxis.dot(tan));
    // Degenerate only where the spine runs *along* the comb direction; the
    // skull's own radial then supplies the missing axis.
    if (wide.lengthSq() < 1e-8) {
      outward.set(path[i].x / head.rx, (path[i].y - head.center.y) / head.ry, path[i].z / head.rz);
      wide.crossVectors(outward, tan);
      if (wide.lengthSq() < 1e-8) wide.set(-tan.y, tan.x, 0);
    }
    wide.normalize();
    // Carry the previous sample's sign forward. Without this the frame can
    // invert between two adjacent rings, which twists the section 180° across a
    // single quad and prints a dark pinched patch — visible on every crown,
    // because a spine running radially out of the skull is exactly where the
    // orientation test below is worst conditioned.
    if (i > 0 && wide.dot(frames[i - 1][0]) < 0) wide.negate();
    // `v = t × u` matches `sweep`'s handedness, so this shares `sweep`'s flip
    // on the wall (the parameterisation is left-handed and the unflipped patch
    // faces inward) and `sweep`'s cap orientations unchanged.
    rad.crossVectors(tan, wide).normalize();
    frames.push([wide.clone(), rad.clone()]);
  }

  // Which way round the section sits is decided **once**, at the root, where the
  // spine is tangential to the skull and the radial is therefore unambiguous —
  // then applied to the whole clump. Negating *both* axes turns the section's +y
  // side away from the head while preserving the handedness, so the profile's
  // flat underside beds down and the domed side is the one the highlight band
  // runs across.
  outward.set(
    path[0].x / (head.rx * head.rx),
    (path[0].y - head.center.y) / (head.ry * head.ry),
    path[0].z / (head.rz * head.rz),
  );
  if (frames[0][1].dot(outward) < 0) {
    for (const f of frames) { f[0].negate(); f[1].negate(); }
  }

  const grid = surface.patch(rows, cols, true, (i, j) => {
    if (j === 0 && rowInk) rowInk(i);
    const [u, v] = frames[i];
    const sx = section[j][0] * widthAt(i);
    const sy = section[j][1] * thickAt(i);
    const p = path[i];
    return {
      x: p.x + u.x * sx + v.x * sy,
      y: p.y + u.y * sx + v.y * sy,
      z: p.z + u.z * sx + v.z * sy,
    };
  }, true);
  // The caps take the colour of the ring they close, not whatever the last row
  // happened to leave set — otherwise the root disc carries the tip's ink and
  // any style whose root is not fully buried shows a wrong-coloured lid.
  if (rowInk) rowInk(rows);
  surface.cap(grid[rows], false);
  if (rowInk) rowInk(0);
  surface.cap(grid[0], true);
  return grid;
}

/**
 * Split a clump spine into base / highlight / base runs by **duplicating** the
 * sample at each band edge.
 *
 * The duplicate is what makes the edge hard. Two coincident rows bound a quad
 * of zero area that never rasterises, so the colour steps between them instead
 * of interpolating across a strand's whole width — the same construction
 * `buildTorso` uses for the belt line, and the reason a cel highlight reads as
 * a painted strip rather than as a specular smear.
 *
 * The band is placed in the spine's own arc parameter rather than at a world
 * height. Every clump grows out of the scalp, so a fixed fraction along the
 * strand is a fixed distance from the roots — which puts the band on a ring
 * around the crown, perpendicular to the strand direction, on every style from
 * a starburst to a twin-tail without any per-style placement.
 *
 * @param {THREE.Vector3[]} path
 * @param {number} from @param {number} to band window in [0, 1]
 * @returns {{path: THREE.Vector3[], t: number[], lit: boolean[]}}
 */
function bandSpine(path, from, to) {
  const last = path.length - 1;
  const out = { path: [], t: [], lit: [] };
  const push = (p, t, lit) => { out.path.push(p); out.t.push(t); out.lit.push(lit); };
  for (let i = 0; i <= last; i++) {
    const ti = i / last;
    const prev = i === 0 ? -1 : (i - 1) / last;
    // `after` is the band state on the far side of the edge; the row that
    // closes the outgoing run therefore carries its negation.
    for (const [edge, after] of [[from, true], [to, false]]) {
      if (prev < edge && ti > edge) {
        const k = (edge - prev) / (ti - prev);
        const p = path[i - 1].clone().lerp(path[i], k);
        push(p.clone(), edge, !after);
        push(p, edge, after);
      }
    }
    push(path[i], ti, ti >= from && ti <= to);
  }
  return out;
}

/**
 * Push every vertex of a hair surface back out of the skull.
 *
 * Applied once on a finished surface rather than negotiated inside each style
 * branch, because the failure it prevents is not a style question: a spline
 * control point that lands inside the head does not read as a modelling slip,
 * it reads as a black ribbon driven through the character's face.
 *
 * The threshold is the **scalp**, not the hair shell. Holding clumps outside the
 * shell — which is what this used to do — is what made every clump sit *on* the
 * shell with its root cap in plain view, so each one read as a separate plate
 * floating off the skull with a visible seam. A clump has to be able to bury its
 * root inside the shell to grow out of it; the shell's own outer wall then hides
 * everything below the surface, and the only thing that must never be violated
 * is the scalp itself.
 *
 * The margin has to cover everything `skullDepth`'s three-divide ellipsoid
 * metric ignores, which is both `profile()`'s cranium swell (now 2%) and the
 * `eV = 0.94` superellipse's own bulge off the ellipsoid (at most 2.1%, at the
 * 45° diagonal). 1.045 covers their product with room to spare; the old 1.03
 * did not cover the old 4.5% swell at all, so clumps could legitimately sit
 * inside the crown scalp while every clearance check reported them clear.
 */
function clearSkull(surface, m, minScale = 1.045) {
  const h = m.head;
  const pos = surface.pos;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = pos[i + 1];
    const z = pos[i + 2];
    const q = skullDepth(h, x, y, z);
    if (q < 1e-6 || q >= minScale) continue;
    const k = minScale / q;
    pos[i] = x * k;
    pos[i + 1] = h.center.y + (y - h.center.y) * k;
    pos[i + 2] = z * k;
  }
}

/**
 * Pull every vertex of a hair *mass* out of the face shield.
 *
 * Two of the six characters shipped with a hair volume parked in front of the
 * eyes — the review's "blank cream oval with a single dot" and the eyes
 * "rendering as a wireframe rectangle on the temple". Both were a style volume
 * authored in body-height units on a character whose head is a different
 * fraction of that height, so no amount of eyeballing the numbers catches it;
 * the invariant has to be enforced.
 *
 * Only masses get this, never locks: a lock is *supposed* to hang in front of
 * the forehead, and `faceIntrusion`'s guard band is limited to the eye block for
 * the same reason.
 */
function clearFace(surface, m) {
  const pos = surface.pos;
  const gap = m.head.ry * 0.05;
  for (let i = 0; i < pos.length; i += 3) {
    const d = faceIntrusion(m, pos[i], pos[i + 1], pos[i + 2]);
    if (d > -gap) pos[i + 2] -= d + gap;
  }
}

/**
 * Hair is built as a *carved volume* of chunky clumps, never as strands and
 * never as cards.
 *
 * ANIME_PIPELINE §3, in full: chunky geometric clumps, each "a broad tapered
 * form with a clear point"; **one flat base colour**, no mottling and no
 * per-pixel variation; one anisotropic highlight band; and silhouette doing all
 * the work — spikes, sweeps, twin-tails, a long fringe.
 *
 * ## What the previous build got wrong, and what replaces it
 *
 * The review's verdict was "flat black slabs pasted onto the skull [...] no
 * volume, no depth, and the pieces visibly float off the head with gaps". Three
 * separate mechanisms produced that, and all three are gone:
 *
 *  - **Clumps were framed by parallel transport.** A transported frame carries
 *    the first segment's orientation to the tip, so a lock curving over the
 *    crown rolls its broad face edge-on and silhouettes as a card. `clumpSweep`
 *    frames every section against the skull instead — wide axis azimuthal, thin
 *    axis radial — so a clump presents its broad plane to the viewer for its
 *    whole length.
 *  - **Clumps were held *outside* the hair shell** by the clearance solver, so
 *    each one sat on the shell with its root cap in view: a plate stuck to a
 *    sphere with a seam round it. Clumps now *grow out of* the scalp — the first
 *    three spine samples are points on the skull itself, bedded far enough in
 *    that the base cap is buried — and `clearSkull` only defends the scalp.
 *  - **The volume was carried by ellipsoid blobs**, which is where the "slab"
 *    read came from: one large smooth mass has no internal form, so it flattens
 *    to a silhouette with nothing inside it. Every style below is now built
 *    from 10–14 tapered clumps and nothing else, except the topknot's bound
 *    column, which is a bound column and is supposed to be one form.
 *
 * The hair carries exactly two colours: `palette.hair` for every clump and the
 * shell, and `palette.accent` for a binding cord where a style has one. Nothing
 * is noise-textured, nothing is gradient-shaded, and nothing varies per pixel —
 * the single highlight band comes from `ToonMaterial`'s `hair` preset, which is
 * an anisotropic lobe about the strand axis and therefore moves with the light
 * the way a painted strip cannot.
 */
function buildHair(parts, m, def, pal) {
  const hp = def.hair ?? {};
  const h = m.head;
  const style = hp.style ?? 'swept';
  /** Head *diameter*. Every hair length below is a multiple of it — hair is a
   *  function of the skull it grows on and of nothing else. */
  const D = h.ry * 2;
  // Seeded from the character id rather than drawn from the shared stream, so a
  // hairstyle is identical no matter what order scenes build their casts in —
  // the same convention `FaceTexture` uses, and what keeps a capture stable.
  const rand = new Rng(hairSeed(def.id));

  const cap = new Surface();
  const clumps = new Surface();
  /**
   * Facial hair — the fringe, and a beard's forks and moustache.
   *
   * Separated from the style mass because the two obey *opposite* rules about
   * the hairline. A fringe is defined by hanging past it; a style mass bedded
   * below it is a slab of hair glued to a bare cheek, which is what shipped as
   * a black polygon void over Yshara's face. Keeping them in different surfaces
   * is what lets `auditCharacter` enforce that distinction mechanically instead
   * of a reviewer having to spot it in a render — the whole reason the previous
   * defect survived to the client.
   */
  const facial = new Surface();
  const mass = new Surface();
  const cord = new Surface();
  /**
   * The hairdo carries exactly **two** values and no others: one flat base and
   * one crown highlight.
   *
   * Held in locals and applied everywhere rather than re-derived per surface,
   * because the review's finding on the lead was "three unrelated colours (dark
   * brown, maroon, blue) appear on one hairdo" — a hairstyle stops reading as
   * one object the moment its parts disagree about what colour hair is. There
   * is one `base` and one `lit` in this function and every clump, shell wall,
   * beard fork and bound column is painted from them.
   */
  const hairBase = gradeAlbedo(pal.hair, 'hair');
  const hairLit = hairHighlight(pal.hair);
  cap.ink(hairBase);
  clumps.ink(hairBase);
  facial.ink(hairBase);
  mass.ink(hairBase);
  // Graded on the `metal` band rather than `cloth`: a binding cord is §5's
  // small high-value accent, and the cloth band's floor would sink it into the
  // hair it is tied around.
  zone(cord, pal.accent, 'metal');

  /**
   * The shell's outer and inner walls, as radial offsets of the skull.
   *
   * The shell is no longer the hairstyle — the clumps are — but it is still
   * load-bearing: it is the opaque scalp cover the clumps grow out of, and it is
   * what stops bare skin showing between them. Both walls are radial offsets of
   * the *same* skull definition `buildHead` uses, and the skull is star-shaped
   * about the head centre, so any scale above 1 strictly encloses it.
   * Interpenetration is impossible by construction rather than avoided by
   * tuning.
   */
  // The inner floor tracks `clearSkull`'s margin: the wall has to stand clear
  // of the true superellipsoid-plus-profile surface, not of the ellipsoid the
  // radial metric measures, or the scalp erupts through the shell at the crown.
  const shellOuter = shellScale(def);
  const shellInner = Math.max(1.055, shellOuter - 0.085);

  // The hairline is solved in `Rig.computeMetrics`, pinned to the *painted*
  // brow, and shared with the ear placement and the clearance solver. No
  // combination of roster values and no retune of the face layout can push hair
  // over the eyes — the one hair failure that destroys a character and that no
  // shading can hide.
  const { frontPhi, backPhi, peak } = m.hairline;

  /**
   * Where the crown highlight sits, as a fraction of the run from the hairline
   * to the crown (shell) and along a clump's own spine (locks).
   *
   * The same window is used for both so the band is *continuous* across the
   * boundary between a clump and the shell showing between clumps. Placed just
   * past a third of the way up because that is where the skull's curvature is
   * turning fastest and therefore where a real strip of light lands; a band on
   * the pole would be hidden by every style that piles mass on the crown.
   */
  const HIGHLIGHT_BAND = Object.freeze([0.34, 0.52]);

  hairShell(cap, {
    head: h,
    outer: shellOuter, inner: shellInner,
    frontPhi, backPhi, peak, segU: 34, segV: 15, swell: 0.05,
    base: hairBase, highlight: hairLit, band: HIGHLIGHT_BAND,
  });

  /**
   * The radial scale that beds a clump of half-thickness `t` flush onto the
   * head at `(theta, phi)`.
   *
   * Above the hairline the clump rides the shell, buried by a little under half
   * its own thickness so its underside and its base cap are inside the shell's
   * outer wall and cannot be seen from any angle. Below it — a beard, a lock in
   * front of the ear — there is no shell, so it beds onto the scalp instead.
   * Either way the clump's root is a strip of the skull's own curvature, which
   * is what makes a gap between hair and head impossible rather than merely
   * unlikely.
   */
  const seat = (theta, phi, t) => {
    const onShell = phi > hairlinePhi(theta, frontPhi, backPhi, peak);
    return (onShell ? shellOuter : 1.05) + (t / h.ry) * 0.42;
  };

  /**
   * A per-clump radial shim, so no two clumps can be coplanar.
   *
   * `seat` is a pure function of `(theta, phi)`, which means two neighbouring
   * clumps overlapping anywhere on the crown have their undersides on *exactly*
   * the same surface. Coincident faces at equal depth are the classic
   * z-fighting configuration, and under an inverted-hull pass the loser of the
   * fight is not a dark pixel but the *hull* — which is how the review's "thin
   * feathered white streaks along the hair clump edges at the crown" appear,
   * and why they masquerade as the highlight band. Stepping successive clumps
   * apart by a fraction of a millimetre each removes the tie entirely; it is
   * three orders of magnitude below the shell's own 8% wall thickness, so
   * nothing can surface through the scalp cover.
   */
  let clumpOrdinal = 0;
  const SHIM = 0.0045;

  /**
   * Root latitude of every *style-mass* clump, against its own hairline.
   *
   * Recorded during construction rather than recovered from the finished vertex
   * buffer, because after `clearSkull`, `clearFace` and a spline resample there
   * is no way to tell a root from a tip. One number per clump is what makes the
   * audit's `hair-mass-below-hairline` check exact: the defect it exists to
   * catch — Yshara's gather rooted at the equator, which put two broad clumps
   * flat on her cheek — is precisely a root in the wrong place, and every other
   * invariant in `auditCharacter` passed it.
   */
  const massRoots = [];

  /**
   * The radial scale of a clump's **first** spine sample — under the shell's
   * outer wall where there is one, just clear of the scalp where there is not.
   *
   * A sweep caps its first ring with a disc facing back along the spine. At the
   * root the spine is tangential to the skull, so that disc faces *up-slope* —
   * and with the roots ringed around the crown, every one of them presents its
   * cap to the top of the head. What that renders as is a ring of hard-edged
   * ends around a patch of bare shell, which reads as a dark hole punched in the
   * crown. Starting the spine inside the shell puts the cap where nothing can
   * see it and makes the clump genuinely emerge *through* the scalp.
   */
  const rootScale = (theta, phi) => (
    phi > hairlinePhi(theta, frontPhi, backPhi, peak) ? shellInner + 0.005 : 1.035
  );

  /** The azimuthal ("comb") direction at an azimuth — a clump's wide axis. */
  const comb = (theta) => new THREE.Vector3(
    -h.rx * Math.sin(theta), 0, h.rz * Math.cos(theta),
  ).normalize();

  /** A point on the skull, as a fresh vector the caller may keep. */
  const P = (theta, phi, scale) => skullPoint(h, theta, phi, scale, new THREE.Vector3());

  /**
   * One chunky hair clump: a broad tapered form with a clear point, growing out
   * of the scalp.
   *
   * The spine is built in two halves. The first is four samples *on the head* —
   * from `(theta, phi)` combing to `(theta + runTheta, phi + runPhi)` — so the
   * root section follows the skull's curvature and the base cap is buried. The
   * second is the free control points in `via`, which is where a tail leaves the
   * skull and the silhouette is authored.
   *
   * The width holds near full until `hold` and then converges; the last ring is
   * driven to zero by the `1 - t⁹` term, because a lock that ends at finite
   * width is capped by a disc of geometry facing sideways and at closeup range
   * that disc is a raw rectangular boundary on the strand. Collapsing the final
   * ring makes the end cap degenerate, the welder strips it, and what is left is
   * an actual point.
   */
  const clump = (o, target = clumps) => {
    const shim = (clumpOrdinal++ % 4) * SHIM;
    if (target === clumps) {
      massRoots.push({
        theta: o.theta,
        below: hairlinePhi(o.theta, frontPhi, backPhi, peak) - o.phi,
      });
    }
    const w = o.w;
    // Depth is 0.74 of width, not 0.60. A clump's wide axis is combed azimuthally
    // and its thin axis is the skull radial, so a shallow section presents an
    // almost edge-free plane to any camera standing off the character's flank —
    // which is every camera in the game. At 0.60 the party's locks silhouetted as
    // ribbons with no thickness at their ends; 0.74 is enough that the section's
    // squared side is visible along the whole length and the clump reads as the
    // carved wedge ANIME_PIPELINE §3 asks for, without fattening into a tube.
    const th = o.thick ?? w * 0.74;
    const runs = 3;
    const pts = [];
    for (let i = 0; i <= runs; i++) {
      const k = i / runs;
      const theta = o.theta + (o.runTheta ?? 0) * k;
      const phi = o.phi + (o.runPhi ?? 0) * k;
      // Sample 0 is buried; the rest bed onto the surface, and the stand-off
      // eases in quadratically so the run stays flush and only the free end
      // lifts away.
      pts.push(P(theta, phi, i === 0
        ? rootScale(theta, phi)
        : seat(theta, phi, th) + shim + (o.lift ?? 0) * k * k));
    }
    if (o.via) for (const v of o.via) pts.push(v);
    /**
     * Floor on how far a clump may taper.
     *
     * The review found "thin single-polygon spikes dangling loose at the
     * jawline" on the lead, and that is what a `tipRatio` of 0.10 on a lock
     * three head-radii long actually builds: the last two thirds of the strand
     * are three millimetres across, which is sub-pixel from the battle camera
     * and a floating splinter in a closeup. A clump is a *carved wedge* (§3),
     * and a wedge that converges to nothing over its whole length is a needle.
     * 0.22 keeps a lock's tip readable as a cut end; only the styles that are
     * genuinely meant to come to a point — a starburst spike, a fringe flick —
     * opt below it, and they are short enough that the point is a point rather
     * than a dangle.
     */
    const tipR = Math.max(o.tipRatio ?? 0.12, o.pointed ? 0.06 : 0.22);
    const hold = o.hold ?? 0.30;
    const prof = (t) => {
      const k = THREE.MathUtils.smoothstep(t, hold, 1);
      // The floor is below `mergeVertices`'s weld tolerance, so the collapsed
      // ring genuinely welds to a point instead of leaving a needle of geometry.
      return Math.max((1 - k * (1 - tipR)) * (1 - Math.pow(t, 9)), 1e-6);
    };
    // The band edges are duplicated into the spine, so the highlight steps
    // rather than ramps. `band` is in the *pre-split* parameter, which is what
    // makes it the same distance from the roots on every clump in the style.
    const spine = bandSpine(smoothPath(pts, o.seg ?? 13), o.band?.[0] ?? 2, o.band?.[1] ?? 2);
    clumpSweep(
      target, h, spine.path, comb(o.theta + (o.runTheta ?? 0) * 0.5),
      (i) => w * prof(spine.t[i]), (i) => th * prof(spine.t[i]), SECTIONS.clump(14),
      (i) => target.ink(spine.lit[i] ? hairLit : hairBase),
    );
  };

  // ---- the fringe, which every style carries ------------------------------
  //
  // Two rules keep a fringe from becoming a curtain over the face. First it is
  // *parted*: `part` shifts the whole fan off centre so no clump hangs down the
  // middle of the nose. Second, length is short at the parting and long at the
  // temples — that taper is the entire difference between an anime fringe and a
  // mop, and it means the centre of the face stays clear while the silhouette
  // still gets its long angular corners.
  const nF = THREE.MathUtils.clamp(hp.fringe | 0, 0, 5);
  const partShift = hp.part ?? 0.16;
  const spread = hp.fringeSpread ?? 1.0;
  const fringeSweep = hp.fringeSweep ?? 0.4;
  const fLen = hp.fringeLength ?? 0.30;
  // The protected column, widened by the clump's own half-width. A spine held
  // exactly at the brow still puts the *body* of a fat clump across the eye,
  // which is how a fringe that measured correctly on paper came back as a blade
  // through the iris; the floor has to account for the volume, not the curve.
  const guardX = m.face.guardX;
  const browFloor = Math.max(m.eye.browTop, m.face.guardTop) + h.ry * 0.03;
  for (let i = 0; i < nF; i++) {
    const t = nF === 1 ? 0.5 : (i + 0.5) / nF;
    const off = (t - 0.5) + partShift;
    // The fan is capped at ±1.0 rad off the front. Past that a "fringe" clump is
    // really a lock hanging beside the ear, and because it lies flat against the
    // side of the skull the camera sees its whole broad face at once — a dark
    // rectangle stuck to the temple, which is the exact slab read this rebuild
    // is removing. Locks that belong beside the ear are authored as such by the
    // styles that want them.
    const theta = Math.PI * 0.5 - THREE.MathUtils.clamp(
      off * Math.PI * 0.92 * spread, -1.0, 1.0,
    );
    const w = h.rx * (0.30 - Math.abs(off) * 0.07);
    const th = w * 0.62;
    const runTheta = fringeSweep * 0.45 * Math.sign(off || 1);
    const root = frontPhi + 0.34;
    // 0.40 rad at the parting to 1.15 at the temples, before the length dial.
    // The span matters more than the absolute: clumps that all bottom out on the
    // guard floor fuse into one horizontal bar across the forehead, which reads
    // as a headband rather than as a fringe.
    let end = root - (0.38 + 0.56 * Math.min(1, Math.abs(off) * 2.4)) * (fLen / 0.30);
    // Hold the tip clear of the painted eye block. Outside the column a clump
    // may hang to the jaw, which is where a fringe earns its silhouette corners.
    const tip = P(theta + runTheta, end, seat(theta, end, th));
    if (Math.abs(tip.x) < guardX + w) {
      end = Math.max(end, Math.asin(THREE.MathUtils.clamp(
        (browFloor + th - h.center.y) / h.ry, -0.98, 0.98,
      )));
    }
    // A short free flick off the end. A fringe whose every vertex lies on the
    // skull is a decal on the forehead: the clumps abut, the tips all land at
    // the same latitude and the whole thing reads as one dark bar across the
    // brow. Letting the ends leave the surface — outward and down, and further
    // the closer the clump is to the temple — is what separates them into
    // individual points and gives the fringe a silhouette of its own.
    const flickK = Math.min(1, Math.abs(off) * 2.4);
    const endP = P(theta + runTheta, end, seat(theta, end, th) + 0.06);
    const away = new THREE.Vector3(endP.x, 0, endP.z);
    if (away.lengthSq() > 1e-9) away.normalize(); else away.set(0, 0, 1);
    const flick = endP.clone()
      .addScaledVector(away, h.rx * (0.05 + 0.09 * flickK))
      .add(new THREE.Vector3(0, -h.ry * 0.24 * flickK, 0));
    clump({
      theta, phi: root, runTheta, runPhi: end - root,
      lift: 0.06, via: [flick], w, thick: th, tipRatio: 0.26, hold: 0.34,
      band: HIGHLIGHT_BAND,
    }, facial);
  }

  // ---- style mass ---------------------------------------------------------
  //
  // REFERENCE_TARGET §1 makes silhouette distinctiveness at 80 px a hard
  // requirement. The six branches below are six *different mass classes*, not
  // six parameterisations of one:
  //
  //   swept    — a wedge thrown backwards off a hard side part (widest at the nape)
  //   twintail — a low flat crown with two heavy tails at the ears (widest at mid-height)
  //   beard    — a bare low crop above the chin, a forked mass below it (lowest crown)
  //   bob      — a bell cut on a diagonal                      (widest at the jaw)
  //   spike    — forward-raked spikes                          (tallest crown)
  //   topknot  — everything gathered up into a raked column    (tall, narrowest)
  //
  // Flatten any two to black and they do not collide, which is the test.
  //
  // ### Why `sheet` became `twintail`, and why `spike` was re-raked
  //
  // The review: "party slots 4, 5 and 6 all use the same hair asset — an
  // identical pale grey-blue lampshade cap with two flared side lobes and a
  // centre part". Slots 4–6 are Bramm, Seren and Emrys, and the three *style*
  // branches they ran through were genuinely different — but all three put
  // their mass in the same place. Bramm's crop and Seren's sheet both rooted a
  // fan at the crown and hung it down the back, and Emrys's starburst was
  // splayed so flat (`spikeSpread` 1.55, vertical component scaled to 0.30)
  // that its outline was a disc at ear height too. Three different builders,
  // one silhouette: a cap with lobes. Distinctiveness is a property of *where
  // the volume goes*, not of how many branches the code has.
  //
  // So the three now differ on the two axes a black matte at 80 px can carry:
  // crown height (Bramm lowest, Seren low, Emrys highest) and outer extent
  // (Seren widest, Bramm narrowest). See `docs/REFERENCE_TARGET.md` §1.
  // `backWidth` moves where the *tips* land, not how fat a clump is. Folding it
  // into the clump width instead — which is what this used to do — gave Seren
  // half-metre-thick locks whose own bulk lifted the measured head mass out of
  // REFERENCE §1's heads-tall band, and made a wide hairstyle read as a few
  // enormous tubes rather than as a mass of hair. Clump width is a property of
  // hair; spread is a property of the style.
  const spreadX = 0.55 + 0.50 * (hp.backWidth ?? 0.9);
  const backLen = (hp.backLength ?? 0.6) * D;

  if (style === 'swept') {
    // A hard side part with the whole mass thrown backwards and down, so the
    // head silhouettes as an arrowhead pointing forward.
    const n = hp.backCount ?? 6;
    const lean = hp.lean ?? 0.22;
    const depth = hp.backDepth ?? 1.0;
    // Rooted near the crown rather than halfway down it: a fan that starts low
    // leaves the top of the skull as bare shell, and a bare shell is a smooth
    // unbroken dome — the swim cap the review has objected to twice. 1.05 rad is
    // a ring at about half the head's radius, far enough off the pole that the
    // clumps do not all collapse onto one point and close enough that their own
    // width covers what is left.
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const theta = 0.32 - (Math.PI + 0.64) * t;
      // Longest over the crown, shorter at the temples, biased to one side by
      // `lean` so the part reads from the front as well as from the side.
      const long = 0.72 + 0.50 * Math.sin(Math.PI * t) + lean * (t - 0.5) * 2;
      const end = -0.88;
      const base = P(theta, end, seat(theta, end, 0));
      // The drop is deliberately less than half the reach. A wedge that falls
      // as far as it travels is hair hanging behind a head, which is the same
      // region Kite's bell and Bramm's beard occupy — the pair check scored
      // all three within 0.05 of each other. Held high, it is a spur pointing
      // backwards off the crown, which is the arrowhead this style is for and
      // a place no other style in the roster puts mass.
      const tip = new THREE.Vector3(
        base.x * spreadX,
        base.y - backLen * long * 0.42,
        base.z - backLen * long * 0.62 * depth - h.rz * 0.20,
      );
      // The mid control is pulled further back than the straight line: the bow
      // is what makes the wedge a *sweep* rather than a fan of straight spikes.
      const mid = base.clone().lerp(tip, 0.46);
      mid.z -= h.rz * 0.22;
      clump({
        theta, phi: 1.05, runTheta: 0.10, runPhi: end - 1.05, lift: 0.03,
        via: [mid, tip],
        w: h.rx * 0.26, tipRatio: 0.24, hold: 0.44, band: HIGHLIGHT_BAND,
      });
    }
    /**
     * Two short clumps combed **over the pole**, closing the crown.
     *
     * The back fan roots at φ = 1.05, which leaves a polar cap of about 30°
     * radius — a disc half the head's radius across, at the very top of the
     * silhouette — carrying nothing but bare shell. The review found it from
     * the front: "visible gaps at the top-centre through which sky is showing,
     * plus a blue patch of tunic/cape colour bleeding through the head". Two
     * clumps crossing the pole from the parting to the nape cover that disc
     * with real geometry, so there is no longer a place where the shell is the
     * only thing between the camera and the background.
     */
    for (const sgn of [1, -1]) {
      const theta = 0.32 + sgn * 0.55;
      clump({
        theta, phi: 1.28, runTheta: -sgn * 0.30, runPhi: -0.80, lift: 0.02,
        w: h.rx * 0.26, thick: h.rx * 0.20, tipRatio: 0.34, hold: 0.50,
        band: HIGHLIGHT_BAND,
      });
    }
    /**
     * **One** lock falling in front of the ear, on the parted side.
     *
     * A symmetric pair is what a hard side part is not, and the pair was also
     * putting mass beside the jaw on both sides — the same place Kite's bell
     * closes in front of her ears, which is where the two kept colliding in the
     * pair check. One lock is the parting made visible from the front, and the
     * asymmetry is free silhouette identity of the sort the roster already buys
     * with his cut-away coat tail.
     *
     * Blunt, not pointed. At `tipRatio` 0.10 these converged to three
     * millimetres over three head-radii of length — the review's "thin
     * single-polygon spikes dangling loose at the jawline". A face-framing lock
     * is a cut end, and the taper floor in `clump` now makes that structural.
     */
    {
      const theta = 0.16;
      const end = frontPhi - 0.30;
      const root = P(theta, end, seat(theta, end, 0));
      clump({
        theta, phi: frontPhi + 0.20, runPhi: end - frontPhi - 0.20, lift: 0.04,
        via: [new THREE.Vector3(root.x * 1.04, h.center.y - h.ry * (0.62 + lean * 0.4), root.z + h.rz * 0.06)],
        w: h.rx * 0.23, tipRatio: 0.38, hold: 0.48, band: HIGHLIGHT_BAND,
      }, facial);
    }
  } else if (style === 'twintail') {
    /**
     * A deliberately **low, flat crown** with all the volume in two heavy
     * tails bound at ear height — the widest outline in the party at
     * mid-height, and the emptiest above the skull.
     *
     * This replaces the old `sheet` curtain, which put a fan of clumps at the
     * crown and hung them down the back: the same mass in the same place as
     * every other back-fan style in the roster, which is what collapsed three
     * of the six silhouettes into one lampshade. Moving the volume *sideways
     * and down*, and leaving the crown bare, is a shape nothing else here has.
     *
     * WORLD_BIBLE §3.2's "pale drifting mass twice the width of her body"
     * survives intact — it is still the widest hair in the party, and the
     * bound tails are what the cloth solver drives.
     */
    const n = hp.backCount ?? 4;
    const flare = hp.backFlare ?? 1.2;
    // A short blunt nape fall, so the back of the head is not a bare shell
    // between the tails. Kept well under a head-radius: length here would
    // rebuild the curtain this style exists to replace.
    for (let i = 0; i < 3; i++) {
      const theta = -Math.PI * 0.5 + (i - 1) * 0.62;
      const end = -0.86;
      const root = P(theta, end, seat(theta, end, 0));
      clump({
        theta, phi: 0.92, runPhi: end - 0.92, lift: 0.02,
        via: [new THREE.Vector3(root.x * 0.96, root.y - D * 0.30, root.z * 0.94)],
        w: h.rx * 0.30, tipRatio: 0.62, hold: 0.58, band: HIGHLIGHT_BAND,
      });
    }
    // The tails themselves: bound just behind and above each ear, thrown out
    // and down. `spreadX` drives the lateral throw, which is the channel that
    // makes this the widest silhouette on the stage.
    for (const sgn of [1, -1]) {
      const theta = sgn > 0 ? 0.10 : Math.PI - 0.10;
      const bind = P(theta, 0.30, seat(theta, 0.30, 0));
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        const drop = backLen * (0.82 + 0.30 * t);
        // The lateral throw is bounded on purpose. The staged party sits
        // 0.91–1.14 m apart (`LookdevScene.PARTY`), so a tail that reaches much
        // past a head-diameter from the centreline drives through a
        // neighbour — the same constraint that caps Yshara's lance rake. This
        // lands the outer tip near 2.4 head-radii out, which is comfortably the
        // widest head mass on the stage and still inside her own personal
        // radius.
        const tip = new THREE.Vector3(
          bind.x * (1.0 + flare * spreadX * (0.20 + t * 0.35)),
          bind.y - drop,
          bind.z + (t - 0.5) * h.rz * 1.1,
        );
        const mid = bind.clone().lerp(tip, 0.45);
        mid.y += drop * 0.16;   // the tails kick out before they fall
        clump({
          theta, phi: 0.34, runTheta: sgn * 0.10, runPhi: -0.28, lift: 0.05,
          via: [mid, tip],
          w: h.rx * 0.24, tipRatio: 0.44, hold: 0.52, band: HIGHLIGHT_BAND,
        });
      }
      // The binding ring, in the accent: §5's small high-value zone, and the
      // thing that says "bound" rather than "grew that way".
      const along = new THREE.Vector3(bind.x, bind.y, bind.z)
        .sub(new THREE.Vector3(0, h.center.y, 0)).normalize();
      sweep(cord,
        [bind.clone().addScaledVector(along, -h.ry * 0.04),
          bind.clone().addScaledVector(along, h.ry * 0.10)],
        SECTIONS.circle(12),
        () => [h.rx * 0.20, h.rx * 0.20],
        { capStart: false, capEnd: false });
    }
  } else if (style === 'beard') {
    // Almost nothing above the chin; the volume is below it. Inverting where the
    // head mass sits relative to everyone else is the strongest silhouette trick
    // available at this size, and it costs nothing.
    //
    // The crown still gets a crop of five short clumps: with a bare shell it
    // rendered as one smooth unbroken dome — a helmet, not hair — and the crop
    // breaks the outline without giving him a hairstyle he is not supposed to
    // have.
    // Seven, not five, and each one leaves the scalp at its end. Five clumps of
    // half-width 0.26 spread over four radians of azimuth cover barely two
    // thirds of the arc, so a third of the crown stayed bare shell — and a bare
    // shell is a smooth unbroken dome, which is the swim-cap read the crop
    // exists to break. Seven overlap, and the free flick past the ear is what
    // gives the crop an outline of its own instead of a painted edge.
    // The crop is deliberately **flat to the skull and stopped short of the
    // pole**. It used to run from φ = 1.06 down past the ear with a free flick,
    // which piles a ring of loose ends at exactly the height and extent every
    // other back-fan style in the roster puts them — the shared lampshade
    // outline. Bramm's identity is that his head mass is *below* the chin, so
    // above it he gets the lowest, tightest crown on the stage and no free ends
    // at all: the clumps bed down for their whole length and terminate on the
    // shell. The contrast against Emrys's raked spikes two slots away is then a
    // full head-radius of crown height.
    const nCrop = 8;
    for (let i = 0; i < nCrop; i++) {
      const t = (i + 0.5) / nCrop;
      const theta = 0.40 - (Math.PI + 0.80) * t;
      // The run stops **on the hairline**, solved per azimuth. A fixed end
      // latitude is correct at the nape and halfway down the cheek at the
      // front, which is how a crop ends up bedded onto bare temple — the same
      // failure the topknot gather was rebuilt to remove.
      const end = hairlinePhi(theta, frontPhi, backPhi, peak) + 0.10;
      clump({
        theta, phi: 1.34, runTheta: 0.10, runPhi: end - 1.34, lift: 0.0,
        w: h.rx * 0.28, thick: h.rx * 0.15, tipRatio: 0.40, hold: 0.60,
        band: HIGHLIGHT_BAND,
      });
    }
    const blen = (hp.beardLength ?? 1.0) * D;
    const bwd = hp.beardWidth ?? 1.2;
    const fork = hp.beardFork ?? 0.28;
    // The whole beard hangs below the mouth line. Solved from the face metrics
    // rather than authored, so it cannot creep back up over the eye block.
    const chin = Math.min(m.face.guardBottom - h.ry * 0.06, h.center.y - h.ry * 0.50);
    for (let i = 0; i < 5; i++) {
      const u = (i / 4 - 0.5) * 2;                 // -1 (left jaw) .. +1 (right jaw)
      const theta = Math.PI * 0.5 - u * 1.15;
      const end = -0.94;
      const root = P(theta, -0.55, seat(theta, -0.55, 0));
      const drop = blen * (1 - Math.abs(u) * 0.28);
      // The forks converge: two masses meeting at a point is what separates a
      // beard from a bib.
      const tip = new THREE.Vector3(u * h.rx * fork * 1.7, chin - drop, h.rz * 0.30);
      clump({
        theta, phi: -0.55, runPhi: end + 0.55, lift: 0.02,
        via: [root.clone().lerp(tip, 0.42).setZ(h.rz * 0.74), tip],
        w: h.rx * 0.24 * bwd, tipRatio: 0.30, hold: 0.40,
      }, facial);
    }
    // Moustache: two short bars over the lip, angled down and out. The latitude
    // is *solved* from the eye guard rather than authored — a moustache one
    // notch too high lands inside the protected column, where `clearFace`
    // flattens it back into the skull and the audit reports hair inside the
    // head. Half the clump's own thickness of clearance below the guard is what
    // makes that impossible at any proportion.
    const lipPhi = Math.asin(THREE.MathUtils.clamp(
      (m.face.guardBottom - h.ry * 0.14 - h.center.y) / h.ry, -0.98, 0.98,
    ));
    for (const sgn of [1, -1]) {
      const theta = Math.PI * 0.5 - sgn * 0.42;
      clump({
        theta, phi: lipPhi, runTheta: sgn * 0.18, runPhi: -0.22, lift: 0.05,
        w: h.rx * 0.17 * bwd, thick: h.rx * 0.09, tipRatio: 0.18, hold: 0.30,
      }, facial);
    }
  } else if (style === 'bob') {
    // A bell that is widest at the jaw — nobody else in the party carries mass
    // at ear level — cut on a hard diagonal with the outboard side kicking past
    // the shoulder line.
    const n = hp.backCount ?? 8;
    const lean = hp.lean ?? 0.35;
    const cut = hp.cutAngle ?? 0.55;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const theta = 0.62 - (Math.PI + 1.24) * t;   // wraps past both ears onto the cheeks
      const end = -0.92;
      const root = P(theta, end, seat(theta, end, 0));
      // `Math.cos(theta)` is +1 at the character's left and -1 at their right,
      // so this is the diagonal: one side of the bob is a jawline longer than
      // the other by a quarter of its own length.
      const len = backLen * (0.80 + 0.34 * Math.sin(Math.PI * t) + lean * cut * Math.cos(theta));
      // Width is taken from the head's **equator**, not from the root ring.
      // The roots sit at φ = −0.92 where the skull has already narrowed to 60%
      // of its width, so scaling them could never build a bell that is wider
      // than the head — which is the whole read ("widest at the jaw", the one
      // place nobody else in the party carries mass) and the reason this matte
      // kept scoring against Auren's wedge.
      const tip = new THREE.Vector3(
        Math.cos(theta) * h.rx * (1.02 + cut * 0.30) * spreadX,
        h.center.y - h.ry * 0.48 - len,
        root.z * 0.88,
      );
      clump({
        theta, phi: 1.02, runPhi: end - 1.02, lift: 0.02,
        via: [root.clone().lerp(tip, 0.48), tip],
        w: h.rx * 0.28, tipRatio: 0.46, hold: 0.50, band: HIGHLIGHT_BAND,
      });
    }
  } else if (style === 'spike') {
    /**
     * Spikes **raked forward and up**, not splayed flat.
     *
     * The previous build scaled the growth direction's vertical component to
     * 0.30 and multiplied its horizontal by `spikeSpread` — which is a disc,
     * not a starburst. Seen from the fixed side-view stage, a disc of spikes at
     * ear height has the same outline as a cap with two side lobes, which is
     * how this ended up indistinguishable from the two styles staged beside it.
     *
     * `spikeRake` re-aims the whole crown: it biases each spike toward +Z (the
     * face direction) and keeps the vertical component, so the mass leans over
     * the brow and the outline is a wedge pointing forward and up. That is the
     * tallest crown in the party and the one shape a low, wide silhouette
     * cannot be confused with — and it costs nothing against REFERENCE §1's
     * heads-tall band, because `ceiling` below still clamps every spine.
     */
    const n = hp.spikes ?? 8;
    const splay = hp.spikeSpread ?? 1.4;
    const rake = hp.spikeRake ?? 0.0;
    const len0 = (hp.spikeLength ?? 0.55) * D;
    // Fat wedges, not darts, and near-round in section.
    //
    // Two things made this crown read as flat plates radiating off a bare dome.
    // A splayed spike is the one clump whose wide axis and whose growth
    // direction are *both* roughly horizontal, so its broad face lies in a
    // horizontal plane — and every camera in this game looks down 10–18°
    // (REFERENCE §2), straight onto it. And a taper starting a fifth of the way
    // along left four fifths of every spike a needle with no bulk to catch the
    // light. A near-round section that holds its width to nearly half its
    // length is a tapered horn from any angle; the carved read comes from eight
    // separate forms overlapping at the crown, not from faceting inside one.
    const spikeW = h.rx * 0.30;
    const spikeT = h.rx * 0.26;
    // Hard ceiling on the mass, not a tuned one. REFERENCE §1 measures the
    // silhouette head — hair included — against the 3.0–3.5 heads band, and a
    // starburst is the one style whose randomised roots can spend the whole
    // budget upward; `auditCharacter` enforces it, so this is the constraint the
    // shape is solved under rather than a number to eyeball.
    //
    // The ceiling applies to the *spine*, and a spine runs down the middle of a
    // clump, so it has to sit a half-thickness below the height it buys — and
    // for the same reason the root band is capped too. A root sitting a few
    // degrees off the pole puts its section's whole half-thickness straight up,
    // which is height the tip clamp never sees. Both limits are expressed
    // against `spikeT`, so fattening the section can no longer silently spend
    // the proportion budget.
    //
    // The ceiling is now the skull crown **plus a budget**, not the skull crown
    // itself. Pinning it at `crownY` was correct while the rig was solved for a
    // 3.0–3.5 heads band on a 0.295 H skull, where every millimetre of crown
    // came straight out of the proportion. On BRAVELY §1's 0.213 H skull and
    // 4.0–4.5 band the constraint had inverted: it was holding the one style
    // whose identity is *height* to the same crown rise as a flat crop, which
    // is a direct cause of the silhouette collision this pass is fixing.
    // `auditRoster` still measures the result, so the budget is checked rather
    // than trusted.
    const ceiling = h.crownY + h.ry * (hp.spikeRise ?? 0.0) - spikeT;
    // The *root* band stays under the skull crown regardless: a root above the
    // pole puts its section's whole half-thickness straight up, which is height
    // the tip clamp never sees, and it is height bought with no visible spike.
    const rootPhiMax = Math.asin(THREE.MathUtils.clamp(
      (h.crownY - spikeT - h.center.y) / (h.ry * (shellOuter + 0.06)), -0.98, 0.98,
    ));
    for (let i = 0; i < n; i++) {
      const theta = (i / n) * TAU + rand.jitter(hp.spikeJitter ?? 0.3);
      // Roots spread from the temples to just short of the pole, so the spikes
      // themselves cover the crown instead of standing on a bare dome.
      const phi = Math.min(0.42 + rand.next() * 0.62, rootPhiMax);
      const len = len0 * (0.72 + rand.next() * 0.52);
      const root = P(theta, phi, seat(theta, phi, 0));
      // The radial direction, then raked: `rake` adds a constant forward-and-up
      // push so the whole crown leans over the brow instead of radiating evenly.
      const dir = new THREE.Vector3(
        root.x * splay,
        (root.y - h.center.y) * (0.30 + rake * 1.30),
        root.z * splay + h.rz * rake * 1.25,
      ).normalize();
      const tip = root.clone().addScaledVector(dir, len);
      const mid = root.clone().lerp(tip, 0.44);
      mid.y = Math.min(mid.y + len * 0.10, ceiling);
      tip.y = Math.min(tip.y, ceiling);
      clump({
        theta, phi, runPhi: 0.05, lift: 0.02,
        via: [mid, tip],
        // The one style whose tips are *meant* to be points: a spike is short
        // and fat, so 7% of its width is a genuine apex rather than the
        // dangling splinter the taper floor exists to prevent.
        w: spikeW, thick: spikeT, tipRatio: 0.07, pointed: true, hold: 0.42,
        band: HIGHLIGHT_BAND,
      });
    }
  } else if (style === 'topknot' || style === 'braid') {
    // Everything is gathered *up*: six clumps combed from the hairline to a
    // binding ring above the crown, then a bound column above that. It is the
    // only party member whose mass sits above the skull rather than beside or
    // behind it, and the gather is what makes it read as bound hair rather than
    // as a hat.
    const tk = (hp.topknot ?? 0.5) * D;
    const tw = hp.topknotWidth ?? 0.50;
    const bindY = h.center.y + h.ry * 0.68;
    const bindZ = -h.rz * 0.30;
    const n = hp.backCount ?? 6;
    // **Every gather clump roots on its own hairline, not on a fixed latitude.**
    //
    // This is the review's "hard-edged black polygon void punched into the right
    // side of the hair". It was never a missing face or a flipped normal: the
    // gather was rooted at `phi = -0.06` — the head's *equator* — for every
    // azimuth in a fan that reached the front on both sides, so the two outer
    // clumps were bedded onto bare cheek and temple, ran up across the eye guard
    // (where `clearFace` shoved them backwards, which is the notch), and
    // presented their broad unlit face to the lens as a black slab over the
    // skin. A latitude that is correct at the nape is halfway down the jaw at
    // the front, and no clump width or length fixes a root in the wrong place.
    //
    // Rooting at `hairlinePhi(theta) + margin` makes the failure unreachable
    // from any azimuth or any head proportion, and the fan is re-centred on the
    // nape so the gather sweeps up from behind the ears — which is what a
    // gathered style actually does and what leaves the temples to the fringe.
    const gatherSpan = 1.75;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const theta = -Math.PI * 0.5 + gatherSpan * (1 - 2 * t);
      const root = hairlinePhi(theta, frontPhi, backPhi, peak) + 0.16;
      // The six converge onto a *ring* about the binding axis rather than onto
      // one point. Six spines meeting at a single control point put six clump
      // bodies through each other for the last third of their length, which is
      // a solid knot of interpenetrating shells with no internal form — and it
      // is coincident geometry, which is the other half of the crown slivers.
      const gatherA = new THREE.Vector3(
        Math.cos(theta) * h.rx * 0.16,
        bindY - h.ry * 0.10,
        bindZ * 0.8 + Math.sin(theta) * h.rz * 0.16,
      );
      clump({
        theta, phi: root, runPhi: Math.max(0.26, 1.20 - root), lift: 0.02,
        via: [gatherA],
        w: h.rx * 0.24, tipRatio: 0.34, hold: 0.58, band: HIGHLIGHT_BAND,
      });
    }
    /**
     * The bound column: a long **backward diagonal** off a high bind.
     *
     * Vertical extent is the one thing on a head that is not free. BRAVELY §1
     * puts the silhouette head mass at 4.0–4.5 of body height against a skull
     * that is already 0.213 H, which leaves every character in the party a
     * total crown budget of about 0.35 head-radii — a topknot standing upright
     * spends all of it and is still only a nub. Horizontal projection costs
     * nothing against that band, so the column buys its silhouette going *back*
     * instead: it rises a quarter of its length and travels a full length and a
     * half behind the skull, which is a diagonal no other style in the roster
     * owns and which the braid then continues.
     */
    sweep(mass,
      [new THREE.Vector3(0, bindY - h.ry * 0.08, bindZ),
        new THREE.Vector3(0, bindY + tk * 0.22, bindZ - tk * 0.70),
        new THREE.Vector3(0, bindY + tk * 0.30, bindZ - tk * 1.55)],
      SECTIONS.circle(14),
      (i) => { const r = h.rx * tw * [0.88, 1.0, 0.26][i]; return [r, r * 0.94]; },
      { capStart: true, capEnd: true });
    // Binding cord. The one place the hair is allowed a second colour: it is a
    // *cord*, a small flat accent zone in the §5 sense, not a shading effect.
    sweep(cord,
      [new THREE.Vector3(0, bindY - h.ry * 0.04, bindZ),
        new THREE.Vector3(0, bindY + h.ry * 0.08, bindZ - h.rz * 0.04)],
      SECTIONS.circle(14),
      () => [h.rx * tw * 1.06, h.rx * tw * 1.06],
      { capStart: false, capEnd: false });
  }

  // ---- the two invariants -------------------------------------------------
  //
  // Applied here, once, on finished surfaces, rather than defended inside each
  // of the six style branches. `clearSkull` defends the *scalp* only: a clump
  // has to be able to bury its root inside the hair shell, or it floats. The
  // face guard is absolute — a mass in front of the eyes is a character with no
  // face, which is what shipped once already.
  clearSkull(clumps, m);
  clearSkull(facial, m);
  clearSkull(mass, m);
  clearSkull(cord, m);
  clearFace(clumps, m);
  clearFace(facial, m);
  clearFace(mass, m);

  // None of these ask for a crease, and the clumps in particular used to.
  //
  // The argument for `crease: 0.7` on a clump was that its ten-sided superellipse
  // section has squared sides which *should* stay hard, so the hair reads as
  // carved rather than as rope. The argument is right about the shape and wrong
  // about the mechanism: `toCreasedNormals` cannot tell a modelled corner from a
  // tessellation seam, so at 0.7 rad it hardened both, and a ten-column sweep's
  // ordinary column boundaries were all past the threshold. The result on a
  // black hair mass at battle distance is a fan of flat polygonal panels, which
  // is the "faceted paper toy" read in full. The section carries the carving on
  // its own — a squared superellipse has a genuinely small radius at its
  // corners, and smooth normals across a small radius still print a tight
  // highlight break. `CREASE_CLASSES` now enforces this for the whole class.
  if (!cap.empty) parts.push({ surface: cap, cls: 'hair', bind: ['neck', 'head'], painted: true });
  if (!clumps.empty) {
    parts.push({
      surface: clumps, cls: 'hair', bind: ['neck', 'head'],
      painted: true, roots: massRoots,
    });
  }
  if (!facial.empty) parts.push({ surface: facial, cls: 'hair', bind: ['neck', 'head'], painted: true });
  if (!mass.empty) parts.push({ surface: mass, cls: 'hair', bind: ['neck', 'head'], painted: true });
  if (!cord.empty) parts.push({ surface: cord, cls: 'hair', bind: ['head'], painted: true });
}

/**
 * The braid / drift tail that the cloth solver drives.
 *
 * Built along the bind-pose hair chain and skinned to `hair0..n` so the verlet
 * strand's bone rotations carry it. Segment radii pulse so a braid reads as
 * plaited rather than as a rope; a plain taper looks like a tail.
 */
/**
 * The chain's *shape*, with no rig involved.
 *
 * Split out from `buildHairChain` so `auditCharacter` can measure it. The
 * chain is the largest single hair mass on four of the six — Yshara's braid is
 * 2.4 head diameters long — and while it was invisible to the audit, the
 * silhouette check was scoring a party whose most distinctive hair was missing
 * from every matte. A shape that only exists once a skeleton has been built is
 * a shape no headless check can see, and that is a structural reason for the
 * defect surviving review, not an accident.
 *
 * @returns {Surface|null} null when the character has no chain
 */
function hairChainSurface(m, def, ink) {
  const chain = m.chains.hair;
  if (chain.length < 2) return null;
  const hp = def.hair ?? {};
  const s = new Surface();
  if (ink) s.ink(ink);
  const pts = chain.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const path = smoothPath(pts, Math.max(10, chain.length * 3));
  const w0 = (hp.braidWidth ?? hp.backWidth ?? 0.9) * m.head.rx * 0.55;
  const segs = hp.braidSegments ?? 0;
  sweep(s, path, SECTIONS.circle(16), (i) => {
    const t = i / (path.length - 1);
    const taper = 1 - Math.pow(t, 1.7) * 0.72;
    const plait = segs > 0 ? 1 + Math.sin(t * Math.PI * segs * 2) * 0.16 : 1;
    const r = w0 * taper * plait;
    return [r, r * 0.9];
  }, { capStart: true, capEnd: true });
  return s;
}

function buildHairChain(parts, m, def, pal, rig) {
  const chain = m.chains.hair;
  const s = hairChainSurface(m, def);
  if (!s) return;
  const hp = def.hair ?? {};
  const H = m.height;
  const pts = chain.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const w0 = (hp.braidWidth ?? hp.backWidth ?? 0.9) * m.head.rx * 0.55;

  // Skin against the chain's own bone segments.
  const names = [];
  for (let i = 0; i < chain.length - 1; i++) names.push(`hair${i}`);
  const segments = [];
  for (let i = 0; i < names.length; i++) {
    const idx = rig.order.indexOf(names[i]);
    if (idx < 0) continue;
    const a = rig.rest[names[i]].world;
    const next = rig.rest[names[i + 1]];
    const b = next ? next.world : a.clone().add(new THREE.Vector3(0, -H * 0.06, 0));
    segments.push({ index: idx, name: names[i], a, b, sigma: Math.max(w0 * 2.4, H * 0.03) });
  }
  // The topmost link also takes the head so the join at the scalp never gaps.
  const headIdx = rig.order.indexOf('head');
  if (headIdx >= 0) {
    segments.push({
      index: headIdx, name: 'head',
      a: new THREE.Vector3(0, m.head.center.y, 0),
      b: new THREE.Vector3(pts[0].x, pts[0].y, pts[0].z),
      sigma: m.head.rx * 0.7,
    });
  }
  parts.push({ surface: s, cls: 'hair', color: pal.hair, segments });
}

// ================================================================ weapons

/**
 * Weapons are authored along +Y from a grip at the origin, then rotated into
 * the roster's declared carry pose and translated onto the weapon bone. Keeping
 * authoring and carriage separate means the animator's weapon-bone rotations
 * are relative to how the character *holds* it, so one attack clip works for a
 * sword held low and a lance held across the shoulders.
 */
function buildWeapon(parts, m, def, pal, rig) {
  const w = def.weapon;
  if (!w || !rig.bones.weapon) return;
  const H = m.height;
  const idx = rig.order.indexOf('weapon');
  const bindWorld = rig.rest.weapon.world;

  const carry = new THREE.Euler(w.tilt ?? 0, 0, w.roll ?? 0, 'ZXY');
  const xf = new THREE.Matrix4()
    .makeRotationFromEuler(carry)
    .premultiply(new THREE.Matrix4().makeTranslation(bindWorld.x, bindWorld.y, bindWorld.z));

  const primary = new Surface();
  const secondary = new Surface();
  const glow = new Surface();

  const put = (surface, cls, color, crease = 0.7) => {
    if (surface.empty) return;
    // Bake the carry transform in, then bind rigidly to the weapon bone.
    for (let i = 0; i < surface.pos.length; i += 3) {
      const v = new THREE.Vector3(surface.pos[i], surface.pos[i + 1], surface.pos[i + 2]).applyMatrix4(xf);
      surface.pos[i] = v.x; surface.pos[i + 1] = v.y; surface.pos[i + 2] = v.z;
    }
    // `emissive` brightens the unlit parts of a weapon — Seren's chime-bells and
    // Bramm's vents run hot, Auren's moonglass barely glows. Kept at or below
    // 1.2 so a resting weapon never trips the bloom threshold on its own;
    // ART_BIBLE §2.2 reserves supra-threshold emission for spells.
    const scale = cls === 'glow' ? THREE.MathUtils.clamp(w.emissive ?? 1, 0.1, 1.2) : 1;
    parts.push({ surface, cls, color, rigid: idx, crease, colorScale: scale });
  };

  switch (w.kind) {
    case 'sword': {
      const len = w.length * H;
      const grip = w.gripLength * H;
      // Blade: lens section, tapering to a point, with a fuller implied by the
      // section rather than modelled — at 80 px a fuller is one dark pixel.
      const bladePath = [
        new THREE.Vector3(0, grip * 0.6, 0),
        new THREE.Vector3(0, grip * 0.6 + len * 0.5, 0),
        new THREE.Vector3(0, grip * 0.6 + len, 0),
      ];
      sweep(primary, smoothPath(bladePath, 7), SECTIONS.lens(12, 0.30), (i) => {
        const t = i / 6;
        const s = (1 - Math.pow(t, 3.2) * 0.94) * w.width * H * 0.5;
        return [s, s * (w.thickness / w.width)];
      }, { capStart: true, capEnd: true });
      // Crossguard: a wide flat bar — the sword's identity in silhouette.
      blob(secondary, {
        cx: 0, cy: grip * 0.6, cz: 0,
        rx: w.guard * H * 0.5, ry: H * 0.016, rz: H * 0.018,
        eU: 0.5, eV: 0.55, segU: 12, segV: 8,
      });
      // Grip and pommel.
      sweep(secondary,
        [new THREE.Vector3(0, -grip * 0.45, 0), new THREE.Vector3(0, grip * 0.55, 0)],
        SECTIONS.circle(10), () => [H * 0.017, H * 0.014], { capStart: true, capEnd: true });
      blob(secondary, { cx: 0, cy: -grip * 0.52, cz: 0, rx: w.pommel * H * 0.5, ry: w.pommel * H * 0.42, rz: w.pommel * H * 0.5, eU: 0.8, eV: 0.8, segU: 12, segV: 8 });
      put(primary, 'metal', pal.weaponA, 0.5);
      put(secondary, 'metal', pal.weaponB, 0.6);
      break;
    }
    case 'chimestaff': {
      const len = w.length * H;
      sweep(primary,
        [new THREE.Vector3(0, -len * 0.35, 0), new THREE.Vector3(0, len * 0.65, 0)],
        SECTIONS.circle(10), (i) => { const r = w.width * H * (i === 0 ? 0.9 : 1.05); return [r, r]; },
        { capStart: true, capEnd: true });
      // Ring at the head, with the seven bells hung from it.
      const R = w.ringRadius * H;
      const ringPath = [];
      for (let i = 0; i <= 24; i++) {
        const a = (i / 24) * TAU;
        ringPath.push(new THREE.Vector3(Math.sin(a) * R, len * 0.66 + Math.cos(a) * R, 0));
      }
      sweep(secondary, ringPath, SECTIONS.circle(8), () => [H * 0.010, H * 0.010], { capStart: false, capEnd: false });
      const n = w.bells ?? 7;
      for (let i = 0; i < n; i++) {
        const a = Math.PI * (0.15 + (i / (n - 1)) * 0.7);
        const bx = Math.sin(a) * R * 0.94;
        const by = len * 0.66 - Math.cos(a) * R * 0.94;
        blob(glow, {
          cx: bx, cy: by - w.bellRadius * H * 1.6, cz: 0,
          rx: w.bellRadius * H, ry: w.bellRadius * H * 1.15, rz: w.bellRadius * H,
          eU: 1, eV: 0.8, segU: 10, segV: 7,
        });
      }
      put(primary, 'metal', pal.weaponA, 0.7);
      put(secondary, 'metal', pal.weaponB, 0.7);
      put(glow, 'glow', pal.glow, 0);
      break;
    }
    case 'piston': {
      const len = w.length * H;
      const r = w.width * H * 0.5;
      // Barrel cluster: the read is "machine", so it is three hard cylinders
      // and a vented sleeve, not one smooth tube.
      const n = w.barrels ?? 3;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const ox = Math.cos(a) * r * 0.42;
        const oz = Math.sin(a) * r * 0.42;
        sweep(primary,
          [new THREE.Vector3(ox, -len * 0.1, oz), new THREE.Vector3(ox, len * 0.75, oz)],
          SECTIONS.circle(10), () => [r * 0.36, r * 0.36], { capStart: true, capEnd: true });
      }
      sweep(secondary,
        [new THREE.Vector3(0, -len * 0.35, 0), new THREE.Vector3(0, len * 0.30, 0)],
        SECTIONS.square(14, 0.6), (i) => [r * (i === 0 ? 0.92 : 1.0), r * (i === 0 ? 0.92 : 1.0)],
        { capStart: true, capEnd: true });
      for (let i = 0; i < (w.ventCount ?? 5); i++) {
        const y = -len * 0.28 + (i / (w.ventCount ?? 5)) * len * 0.5;
        blob(glow, { cx: 0, cy: y, cz: r * 0.92, rx: r * 0.55, ry: len * 0.020, rz: r * 0.12, eU: 0.4, eV: 0.4, segU: 8, segV: 4 });
      }
      put(primary, 'metal', pal.weaponA, 0.5);
      put(secondary, 'metal', pal.weaponB, 0.5);
      put(glow, 'glow', pal.glow, 0);
      break;
    }
    case 'chakram': {
      const R = w.radius * H;
      const gap = w.gap ?? 0.5;
      const arc = TAU * (1 - gap * 0.18);
      const path = [];
      const steps = 40;
      for (let i = 0; i <= steps; i++) {
        const a = -arc * 0.5 + (i / steps) * arc;
        path.push(new THREE.Vector3(Math.sin(a) * R, Math.cos(a) * R, 0));
      }
      sweep(primary, path, SECTIONS.lens(10, 0.34), () => [w.width * H * 0.5, w.thickness * H * 0.5],
        { capStart: true, capEnd: true });
      // Blade cusps around the rim — the detail that stops it reading as a hoop.
      for (let i = 0; i < (w.blades ?? 3); i++) {
        const a = -arc * 0.5 + ((i + 0.5) / (w.blades ?? 3)) * arc;
        const base = new THREE.Vector3(Math.sin(a) * R, Math.cos(a) * R, 0);
        const tip = base.clone().multiplyScalar(1.22);
        sweep(secondary, [base, tip], SECTIONS.lens(8, 0.3),
          (i2) => { const s = i2 === 0 ? w.width * H * 0.5 : w.width * H * 0.12; return [s, w.thickness * H * 0.5]; },
          { capStart: false, capEnd: true });
      }
      put(primary, 'metal', pal.weaponA, 0.5);
      put(secondary, 'metal', pal.weaponB, 0.5);
      break;
    }
    case 'grimoire': {
      const bw = w.width * H, bh = w.height * H, bt = w.thickness * H;
      blob(primary, { cx: 0, cy: 0, cz: 0, rx: bw * 0.5, ry: bh * 0.5, rz: bt * 0.5, eU: 0.28, eV: 0.30, segU: 14, segV: 10 });
      blob(secondary, { cx: bw * 0.06, cy: 0, cz: 0, rx: bw * 0.46, ry: bh * 0.46, rz: bt * 0.54, eU: 0.24, eV: 0.26, segU: 12, segV: 8 });
      // Orrery: three thin rings that will orbit him when casting.
      for (let i = 0; i < (w.orreryRings ?? 3); i++) {
        const R = w.orreryRadius * H * (0.6 + i * 0.26);
        const tilt = (i - 1) * 0.55;
        const path = [];
        for (let k = 0; k <= 28; k++) {
          const a = (k / 28) * TAU;
          const p = new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R);
          p.applyAxisAngle(new THREE.Vector3(1, 0, 0), tilt);
          path.push(p);
        }
        sweep(glow, path, SECTIONS.circle(6), () => [H * 0.004, H * 0.004], { capStart: false, capEnd: false });
      }
      put(primary, 'cloth', pal.weaponA, 0.35);
      put(secondary, 'cloth', pal.weaponB, 0.35);
      put(glow, 'glow', pal.glow, 0);
      break;
    }
    case 'lance': {
      const len = w.length * H;
      sweep(primary,
        [new THREE.Vector3(0, -len * 0.42, 0), new THREE.Vector3(0, len * 0.10, 0), new THREE.Vector3(0, len * 0.52, 0)],
        SECTIONS.circle(10),
        (i) => { const r = w.width * H * [1.0, 0.92, 0.74][i]; return [r, r]; },
        { capStart: true, capEnd: true });
      // Bone head: a ribbed leaf blade, the party's only horizontal in profile.
      const hl = w.headLength * H;
      sweep(secondary,
        [new THREE.Vector3(0, len * 0.50, 0), new THREE.Vector3(0, len * 0.50 + hl * 0.42, 0), new THREE.Vector3(0, len * 0.50 + hl, 0)],
        SECTIONS.lens(12, 0.30),
        (i) => { const s = w.headWidth * H * 0.5 * [0.34, 1.0, 0.06][i]; return [s, s * 0.55]; },
        { capStart: true, capEnd: true });
      for (let i = 0; i < (w.ribs ?? 5); i++) {
        const y = -len * 0.34 + (i / (w.ribs ?? 5)) * len * 0.72;
        blob(secondary, { cx: 0, cy: y, cz: 0, rx: w.width * H * 1.7, ry: H * 0.010, rz: w.width * H * 1.7, eU: 0.85, eV: 0.5, segU: 10, segV: 5 });
      }
      put(primary, 'metal', pal.weaponA, 0.6);
      put(secondary, 'metal', pal.weaponB, 0.6);
      break;
    }
    default:
      break;
  }
}

// ============================================================ accessories

/** Pauldrons, collars, belts, prosthetics — the costume's silhouette punctuation. */
function buildAccessories(parts, m, def, pal) {
  const acc = def.accessories ?? {};
  const H = m.height;
  const g = m.girth;
  // One surface per *binding*, not one per material: a pauldron rides the
  // shoulder, a belt buckle rides the pelvis, and merging them would force the
  // solver to choose one skin whitelist for both.
  const metalBody = new Surface();
  const cloth = new Surface();
  const leather = new Surface();
  const glow = new Surface();

  if (acc.pauldron) {
    const side = acc.pauldron === 'L' ? 1 : -1;
    const j = m.joints[side > 0 ? 'shoulderL' : 'shoulderR'];
    const pauldron = new Surface();
    blob(pauldron, {
      cx: j.x * 1.14, cy: j.y + g.arm * 0.42, cz: 0,
      rx: g.arm * 2.3, ry: g.arm * 1.55, rz: g.arm * 2.1,
      eU: 0.9, eV: 0.72, segU: 16, segV: 10,
      // Closed, not a capped dome. The pauldron overhangs the arm laterally by
      // more than an arm radius, and every camera in the game sits below the
      // shoulder line of a 1.1 m chibi — so a flat bottom cap is *always* in
      // view, and with the mandatory rim light running around its edge it read
      // as a metal bowl hanging off the chest rather than as a shoulder mass.
      // The lower pole is buried in the deltoid, so the extra ring is free.
      vFrom: 0.02, vTo: 1.0,
    });
    parts.push({
      surface: pauldron, cls: 'metal', color: pal.accent, crease: 0.8,
      bind: [side > 0 ? 'shoulderL' : 'shoulderR', 'chest'],
    });
  }

  if (acc.collar && acc.collar !== 'none') {
    const y = m.joints.neck.y;
    const tall = acc.collar === 'high' ? 1.5 : acc.collar === 'oversized' ? 1.75 : acc.collar === 'popped' ? 1.35 : 0.85;
    // The feather collar used to be wider than the head, which put a slab of
    // ash-violet across the wearer's chin in every closeup. A collar frames a
    // face; it does not eat one.
    const wide = acc.collar === 'oversized' ? 1.45 : acc.collar === 'feather' ? 1.40 : 1.2;
    // Built as a *closed* shell — outer wall up, inner wall back down, rim ring
    // across the top — rather than as an open tube.
    //
    // An uncapped sweep is a one-sided cylinder: at its top edge you see through
    // the wall into the material's culled backfaces, which renders as a bright
    // hard-edged sliver hanging off the shoulder line. That is the "stray white
    // polygon flap protruding from the shoulder" in the review, and capping it
    // with a disc would only replace the flap with a lid across the neck. The
    // shell has no open boundary anywhere above the torso, so there is nothing
    // left to see through.
    // The top ring is *solved* against the jaw, not trusted from `tall`. Collar
    // heights are authored as multiples of a neck radius, and the neck is the
    // body part whose girth varies most across this roster, so a height that
    // frames Auren's chin closes over Yshara's mouth — which is what shipped:
    // a bone-coloured band across the lower half of her face in every frame.
    // Clamping here means no roster value and no proportion block can restore it.
    const jaw = m.head.center.y - m.head.ry * 0.98;
    const top = new THREE.Vector3(
      0,
      Math.min(y + g.neck * 1.4 * tall, jaw - g.neck * 0.15),
      -g.neck * 0.35 * tall,
    );
    const bottom = new THREE.Vector3(0, y - g.neck * 0.6, 0);
    const rOuter = (i) => g.neck * (i === 0 ? 1.5 : 1.9) * wide;
    const outerGrid = sweep(cloth, [bottom, top], SECTIONS.circle(16),
      (i) => { const r = rOuter(i); return [r, r * 1.05]; },
      { capStart: false, capEnd: false });
    const innerGrid = sweep(cloth, [top, bottom], SECTIONS.circle(16),
      (i) => { const r = rOuter(1 - i) * 0.86; return [r, r * 1.05]; },
      { capStart: false, capEnd: false });
    // Rim: outer top ring to inner top ring. `innerGrid` runs top-to-bottom, so
    // its row 0 is the top; winding matches the outer wall's outward normal.
    const oTop = outerGrid[1];
    const iTop = innerGrid[0];
    for (let j = 0; j < oTop.length - 1; j++) {
      cloth.quad(oTop[j], oTop[j + 1], iTop[j + 1], iTop[j]);
    }
    if (acc.collar === 'feather') {
      const n = Math.max(3, def.cape?.feathers ?? 9);
      const fl = (def.cape?.featherLength ?? 0.18) * H;
      // A ruff that lies **back over the shoulders**, not a crown that stands up
      // out of the chest ring.
      //
      // The quills used to grow straight up — `tip = base + (0, featherLength,
      // 0)` — and on a chibi that is catastrophic: the collar ring sits barely a
      // head-radius below the chin, so a fifth of body height of rise puts every
      // one of eleven bone-white blades across the wearer's jaw, mouth and eyes.
      // Yshara shipped with her whole lower face behind her own collar.
      //
      // Splaying them outward is also the better read. A feather mantle's
      // silhouette value is *width* at the shoulder line, which is what
      // WORLD_BIBLE asks of hers, and width costs nothing against REFERENCE §1's
      // heads-tall budget the way height does. The rise is capped against the
      // solved jaw rather than tuned, so no roster length and no head scale can
      // put a quill back over the face — the same solved line the collar shell
      // above is clamped to.
      //
      // The fan is also cut back to the rear three-fifths of the ring. A quill
      // rooted near the front of the collar points straight at the lens on the
      // side-view stage, so it crosses the throat and the jaw however short it
      // is — length alone cannot save a direction that is wrong.
      // **Closed plates rooted inside the shell, not open blades in mid-air.**
      //
      // Each quill was a two-point sweep with `capStart: false`, and its first
      // ring stood proud of the torso — an open boundary hanging in the air.
      // From any angle you look straight through it into the material's culled
      // backfaces, and with the mandatory rim running round that boundary the
      // result is a thin, feathered, bright streak: the review's "white slivers
      // shooting off character 3's shoulder and hand", read (correctly) as
      // exposed backfaces rather than as a designed highlight. Eleven of them
      // fanned across a chibi shoulder is why they looked like cutlery.
      //
      // The rebuild fixes the cause three ways: the root ring is pulled *inside*
      // the chest mass and capped, so there is no boundary to see through; the
      // tip ring collapses below the weld tolerance so the plate ends in a point
      // rather than a lid; and the count is cut roughly in half with the width
      // more than doubled, which is what turns a row of needles into a mantle.
      // Silhouette value at this size is carried by mass, never by line count.
      const plates = THREE.MathUtils.clamp(Math.round(n * 0.55), 4, 7);
      for (let i = 0; i < plates; i++) {
        const a = Math.PI * (0.42 + (i / (plates - 1)) * 1.16);
        const out = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
        const ringY = m.joints.chest.y + g.chestZ * 0.5;
        // Buried: 0.62 of the chest half-girth is comfortably inside the trunk
        // sweep, so the cap disc is never on screen from any camera.
        const base = new THREE.Vector3(out.x * g.chestX * 0.62, ringY, out.z * g.chestZ * 0.62);
        // Longest at the back of the ring, shortest at the shoulder points, so
        // the fan reads as a mantle gathered behind the neck.
        const len = fl * (0.44 + 0.38 * Math.max(0, -Math.cos(a)));
        const rise = Math.min(len * 0.30, Math.max(0, jaw - ringY));
        const tip = new THREE.Vector3(
          out.x * (g.chestX * 0.62 + len), ringY + rise, out.z * (g.chestZ * 0.62 + len) - g.chestZ * 0.22,
        );
        const mid = base.clone().lerp(tip, 0.55);
        mid.y += len * 0.10;
        sweep(cloth, smoothPath([base, mid, tip], 6), SECTIONS.clump(14, 0.70, 0.48),
          (i2) => {
            const t2 = i2 / 5;
            // Widest a third of the way out — a feather's vane, not a spike —
            // and driven to zero at the tip so the end cap welds away.
            const s = H * (0.030 + 0.016 * Math.sin(Math.PI * Math.min(1, t2 * 1.15)))
              * Math.max(1e-6, 1 - Math.pow(t2, 6));
            return [s, s * 0.34];
          },
          { capStart: true, capEnd: true });
      }
    }
  }

  if (acc.beltRing) {
    const y = m.joints.hips.y + g.hipX * 0.10;
    const path = [];
    for (let i = 0; i <= 26; i++) {
      const a = (i / 26) * TAU;
      path.push(new THREE.Vector3(Math.cos(a) * g.hipX * 1.02, y, Math.sin(a) * g.hipZ * 1.02));
    }
    sweep(leather, path, SECTIONS.square(12, 0.5), () => [H * 0.013, H * 0.020], { capStart: false, capEnd: false });
    blob(metalBody, { cx: 0, cy: y, cz: g.hipZ * 1.06, rx: H * 0.030, ry: H * 0.026, rz: H * 0.012, eU: 0.4, eV: 0.4, segU: 10, segV: 6 });
  }

  if (acc.prosthetic) {
    // Bramm's piston forearm replaces the limb below the elbow: brass sleeve,
    // exposed rod. Bound to the forearm so it swings as one rigid unit.
    const side = acc.prosthetic === 'L' ? 1 : -1;
    const e = m.joints[side > 0 ? 'forearmL' : 'forearmR'];
    const wj = m.joints[side > 0 ? 'handL' : 'handR'];
    const a = new THREE.Vector3(e.x, e.y, e.z);
    const b = new THREE.Vector3(wj.x, wj.y, wj.z);
    const rigArm = new Surface();
    sweep(rigArm, [a, a.clone().lerp(b, 0.55), b], SECTIONS.square(12, 0.7),
      (i) => { const r = g.elbow * [1.5, 1.35, 1.15][i]; return [r, r]; }, { capStart: true, capEnd: true });
    const dir = b.clone().sub(a).normalize();
    for (let i = 0; i < 3; i++) {
      const p = a.clone().addScaledVector(dir, g.elbow * (1.2 + i * 1.4));
      blob(rigArm, { cx: p.x, cy: p.y, cz: p.z, rx: g.elbow * 1.7, ry: g.elbow * 0.22, rz: g.elbow * 1.7, eU: 0.85, eV: 0.4, segU: 12, segV: 5 });
    }
    parts.push({
      surface: rigArm, cls: 'metal', color: pal.accent, crease: 0.7,
      bind: [side > 0 ? 'armL' : 'armR', side > 0 ? 'forearmL' : 'forearmR', side > 0 ? 'handL' : 'handR', side > 0 ? 'shoulderL' : 'shoulderR'],
    });
  }

  if (acc.bootBlade) {
    const side = acc.bootBlade === 'L' ? 1 : -1;
    const f = m.joints[side > 0 ? 'footL' : 'footR'];
    const base = new THREE.Vector3(f.x + side * m.foot.width * 0.42, m.foot.height * 0.85, f.z - m.foot.length * 0.10);
    const tip = base.clone().add(new THREE.Vector3(0, -m.foot.height * 0.4, m.foot.length * 0.95));
    const blade = new Surface();
    sweep(blade, [base, tip], SECTIONS.lens(8, 0.28),
      (i) => { const s = H * (i === 0 ? 0.018 : 0.003); return [s, s * 0.6]; }, { capStart: true, capEnd: true });
    parts.push({
      surface: blade, cls: 'metal', color: pal.accent, crease: 0.5,
      bind: [side > 0 ? 'shinL' : 'shinR', side > 0 ? 'footL' : 'footR'],
    });
  }

  if (acc.satchel) {
    const side = acc.satchel === 'L' ? 1 : -1;
    blob(leather, {
      cx: side * g.hipX * 1.05, cy: m.joints.hips.y - H * 0.03, cz: -g.hipZ * 0.35,
      rx: H * 0.055, ry: H * 0.062, rz: H * 0.030, eU: 0.35, eV: 0.4, segU: 12, segV: 8,
    });
  }

  if (acc.anklet) {
    for (const side of [1, -1]) {
      const f = m.joints[side > 0 ? 'footL' : 'footR'];
      const path = [];
      for (let i = 0; i <= 14; i++) {
        const a = (i / 14) * TAU;
        path.push(new THREE.Vector3(f.x + Math.cos(a) * g.ankle * 1.15, f.y + g.ankle * 0.6, f.z + Math.sin(a) * g.ankle * 1.15));
      }
      sweep(glow, path, SECTIONS.circle(6), () => [H * 0.005, H * 0.005], { capStart: false, capEnd: false });
    }
  }

  if (acc.rolledSleeves) {
    // The coat's sleeves are rolled: a stack of thick rings at each forearm.
    for (const side of [1, -1]) {
      const e = m.joints[side > 0 ? 'forearmL' : 'forearmR'];
      const wj = m.joints[side > 0 ? 'handL' : 'handR'];
      const a = new THREE.Vector3(e.x, e.y, e.z);
      const b = new THREE.Vector3(wj.x, wj.y, wj.z);
      const dir = b.clone().sub(a).normalize();
      for (let i = 0; i < 3; i++) {
        const p = a.clone().addScaledVector(dir, g.elbow * (0.4 + i * 0.85));
        const basis = new THREE.Matrix4();
        const yAxis = dir.clone();
        const xAxis = new THREE.Vector3(0, 0, 1).cross(yAxis).normalize();
        const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
        basis.makeBasis(xAxis, yAxis, zAxis).setPosition(p);
        blob(cloth, {
          rx: g.elbow * (1.55 - i * 0.10), ry: g.elbow * 0.42, rz: g.elbow * (1.55 - i * 0.10),
          eU: 0.95, eV: 0.55, segU: 12, segV: 6, matrix: basis,
        });
      }
    }
  }

  if (acc.tattoo) {
    // Yshara's wyld-lines: thin emissive strips on the arms that the esper
    // system can pulse. Emissive, but a *character* accent, so it sits well
    // under the ART_BIBLE emissive budget for non-magic surfaces.
    for (const side of [1, -1]) {
      const a = m.joints[side > 0 ? 'armL' : 'armR'];
      const c = m.joints[side > 0 ? 'handL' : 'handR'];
      for (let k = 0; k < 2; k++) {
        const off = (k - 0.5) * g.arm * 0.9;
        const p0 = new THREE.Vector3(a.x + off * 0.5, a.y, a.z + g.arm * 0.75);
        const p1 = new THREE.Vector3(c.x + off * 0.5, c.y, c.z + g.wrist * 0.85);
        // Capped at both ends. An open tube is a one-sided surface: you see
        // through its rim into the far inner wall, which on an *unlit* emissive
        // material renders at full brightness and prints two hard bright dots at
        // the ends of every strip. Two fan caps on a five-sided section is six
        // triangles a strip and removes the whole class of artefact.
        sweep(glow, smoothPath([p0, p0.clone().lerp(p1, 0.5), p1], 6), SECTIONS.circle(5),
          () => [H * 0.0035, H * 0.0035], { capStart: true, capEnd: true });
      }
    }
  }

  // Collar, sleeve rolls and feather fringe are all *trim*: small, bright, and
  // adjacent to the face or the hands, which is where §5 wants the party's
  // highest-contrast colour so the eye has somewhere to land at battle range.
  if (!cloth.empty) parts.push({ surface: cloth, cls: 'cloth', color: pal.trim, bind: 'body' });
  if (!leather.empty) parts.push({ surface: leather, cls: 'cloth', color: pal.leather, bind: 'body' });
  if (!glow.empty) parts.push({ surface: glow, cls: 'glow', color: pal.glow, bind: 'body' });
  if (!metalBody.empty) parts.push({ surface: metalBody, cls: 'metal', color: pal.accent, bind: 'body', crease: 0.8 });
}

// ========================================================= contact shadow

/**
 * The radial falloff used by every contact blob, generated once and shared.
 *
 * A 64×64 single-channel texture is plenty: it is stretched over a decal the
 * size of a chibi's stance and then blurred further by the DOF, so the sampler's
 * bilinear filtering carries more of the gradient than the resolution does. The
 * profile is `(1 - r²)^1.6` rather than a linear ramp because a linear ramp
 * leaves a visible circular boundary where it reaches zero, and the squared
 * falloff's tail is what makes the blob read as penumbra instead of as a decal.
 *
 * Module-scoped and lazily built: six characters would otherwise each upload an
 * identical texture, and the field scene will have dozens.
 */
let _contactTexture = null;
let _contactRefs = 0;

function acquireContactTexture() {
  _contactRefs++;
  if (_contactTexture) return _contactTexture;
  const N = 64;
  // RGBA, not Red: three's `alphamap_fragment` samples the **green** channel and
  // `map`'s alpha multiplies `diffuseColor.a`, so a single-channel texture is
  // either invisible or tints the decal red depending on which slot it lands in.
  // White RGB with the falloff in alpha works correctly in either.
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x + 0.5) / N * 2 - 1;
      const dy = (y + 0.5) / N * 2 - 1;
      const r2 = dx * dx + dy * dy;
      const a = r2 >= 1 ? 0 : Math.round(255 * Math.pow(1 - r2, 1.6));
      const i = (y * N + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = a;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.name = 'contact-falloff';
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  _contactTexture = t;
  return t;
}

/** Drop one reference; the shared falloff dies with the last character. */
function releaseContactTexture() {
  if (--_contactRefs > 0) return;
  _contactRefs = 0;
  _contactTexture?.dispose();
  _contactTexture = null;
}

/**
 * Soft contact shadows welded to the rig.
 *
 * REFERENCE_TARGET §2: "Characters stand on visible ground with soft contact
 * shadows." The cascade shadow map cannot supply this on its own — at the dusk
 * key the sun sits around 8–15° and the cast shadow lands a metre and a half
 * downrange, so the *feet* have nothing under them and the party reads as a
 * sticker layer composited over the terrain. Every reference frame has a dark
 * pool directly beneath each character, and it is the single cheapest piece of
 * grounding available.
 *
 * Three decals: one under the body mass, two tracking the feet. The foot blobs
 * are what make it read as contact rather than as a painted oval — they follow
 * the stance, and they *shrink as the foot lifts*, which is the ambient
 * occlusion behaviour the eye is actually reading. Scale rather than opacity
 * carries the fade so all three can share one material and one draw state.
 *
 * Tinted toward `SHADOW_TINT` and not black, per ART_BIBLE §2.1's shadow rule:
 * a black pool under six characters would be the only true black in frame and
 * would sit on the subject.
 *
 * @returns {{group: THREE.Group, update: (root: THREE.Object3D) => void,
 *            dispose: () => void}}
 */
function buildContactShadow(rig, metrics) {
  const H = metrics.height;
  const g = metrics.girth;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);

  const material = new THREE.MeshBasicMaterial({
    name: 'contact-shadow',
    map: acquireContactTexture(),
    // The value the ground is *multiplied* by at full coverage, not a colour
    // the ground is blended toward. Blending toward a tint only darkens where
    // the destination is brighter than the tint, and ART_BIBLE §2.3 puts ~15%
    // of a composed frame under 0.08 — on that floor a SHADOW_TINT decal is
    // the brighter of the two and every character stood in a teal puddle it
    // was itself lighting. `MultiplyBlending` over a premultiplied fragment is
    // `dst * mix(1, tint, coverage)`, which can only attenuate, at any hour and
    // over any ground albedo. Lifted above the raw tint because it is now a
    // transmission factor rather than a colour: 1.35 × SHADOW_TINT bottoms the
    // ground out around a third of its lit value, which is what an ambient
    // occlusion term of this footprint is worth.
    color: new THREE.Color(LIGHT.SHADOW_TINT).multiplyScalar(1.35),
    transparent: true,
    // 0.78 rather than 0.62. The review found the cast "not grounded" — contact
    // shadows "missing or near-missing on most of the cast". They were present;
    // they were simply too weak to survive the dusk key's exposure and the fog
    // lift over the ground plane, which together lighten a decal at 0.62 to
    // within a few percent of the terrain it sits on. The decal is a
    // transmission factor under `MultiplyBlending`, so raising it can only
    // darken, at any hour and over any ground albedo.
    opacity: 0.78,
    premultipliedAlpha: true,
    blending: THREE.MultiplyBlending,
    depthWrite: false,
    // Biased toward the camera so the decal wins the depth test against the
    // terrain triangle it is lying on. Without it the blob z-fights on any
    // slope and stipples in and out as the camera drifts.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    // Neither fogged nor tone-mapped: the decal modulates fragments that have
    // already been through both, so applying either here would double them.
    fog: false,
    toneMapped: false,
  });

  const group = new THREE.Group();
  group.name = 'contact-shadow';
  group.renderOrder = 2;

  const body = new THREE.Mesh(geo, material);
  // Sized against the *stance*, not the hips: the pool has to reach past both
  // boots or the feet read as floating even with their own decals under them.
  body.scale.set(
    Math.max(g.hipX * 5.6, Math.abs(metrics.joints.footL.x) * 2 + metrics.foot.width * 3.2),
    1,
    Math.max(g.hipZ * 6.0, metrics.foot.length * 3.4),
  );
  body.position.y = H * 0.006;
  body.renderOrder = 2;
  body.castShadow = false;
  body.receiveShadow = false;
  // `Layers` is per-object in three — a group's bits do not propagate — so the
  // decals opt in individually.
  body.layers.enable(CAST_LAYER);
  group.add(body);

  const feet = [];
  for (const name of ['footL', 'footR']) {
    const bone = rig.bones[name];
    if (!bone) continue;
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.y = H * 0.010;
    mesh.renderOrder = 3;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.layers.enable(CAST_LAYER);
    group.add(mesh);
    feet.push({ mesh, bone, base: Math.max(metrics.foot.width, metrics.foot.length) * 1.9 });
  }

  const world = new THREE.Vector3();
  const toLocal = new THREE.Matrix4();
  // The height at which a lifted foot's contact has faded out entirely. One
  // foot length is the right scale: by then the toe has cleared the ground and
  // there is genuinely nothing in contact.
  const liftSpan = Math.max(1e-4, metrics.foot.length);

  return {
    group,
    update(root) {
      toLocal.copy(root.matrixWorld).invert();
      for (const f of feet) {
        world.setFromMatrixPosition(f.bone.matrixWorld).applyMatrix4(toLocal);
        f.mesh.position.x = world.x;
        f.mesh.position.z = world.z + metrics.foot.length * 0.12;
        const lift = THREE.MathUtils.clamp(
          (world.y - metrics.joints.footL.y) / liftSpan, 0, 1,
        );
        const k = f.base * (1 - lift * 0.85);
        f.mesh.scale.set(k, 1, k * 1.25);
      }
    },
    dispose() {
      group.removeFromParent();
      geo.dispose();
      material.dispose();
      releaseContactTexture();
    },
  };
}

// ================================================================ assembly

/**
 * Build a complete playable character.
 *
 * @param {object|string} defOrId roster entry, or an id into `roster.js`
 * @param {import('../art/AssetForge.js').AssetForge} [forge] accepted for the
 *        `ARCHITECTURE.md` signature and deliberately unused: ANIME_PIPELINE
 *        forbids any procedural texture on a character surface
 * @param {object} [opts] optional extensions, none of them required
 * @param {import('../render/Lighting.js').Lighting} [opts.lighting] light rig to
 *        alias key/rim uniforms from, so a time-of-day change re-lights the
 *        whole party without touching a material
 * @param {boolean} [opts.outline=true] inverted-hull silhouette line
 * @param {number} [opts.outlineWidth] line weight in **device pixels**;
 *        ANIME_PIPELINE §4's range is 1.5–2.5 and `render/Outline.js` defaults
 *        to 2.0. The scene must call `updateOutlineScale` once a frame for the
 *        weight to stay constant on screen.
 * @param {string} [opts.expression='neutral'] initial painted face
 * @returns {{root: THREE.Group, skeleton: THREE.Skeleton,
 *            bones: Record<string, THREE.Bone>, animator: Animator,
 *            cloth: ClothSim|null, height: number, dispose: () => void}}
 */
export function buildCharacter(defOrId, forge = null, opts = {}) {
  const def = typeof defOrId === 'string' ? characterDef(defOrId) : defOrId;
  if (!def) throw new Error(`[CharacterFactory] unknown character "${defOrId}"`);
  const lighting = opts.lighting ?? null;
  const outline = opts.outline !== false;
  const outlineWidth = opts.outlineWidth;
  const expression = opts.expression ?? 'neutral';

  const metrics = computeMetrics(def);
  const rig = buildRig(def, metrics);
  const pal = def.palette;
  const H = metrics.height;

  const root = new THREE.Group();
  root.name = `character:${def.id}`;
  root.add(rig.root);

  // ---- parts ------------------------------------------------------------
  const parts = [];

  // The trunk carries its own three zones (see `buildTorso`), so it is pushed
  // `painted` — the assembly pass must not flatten it back to one colour.
  const sil = silhouetteOf(def);
  const radii = limbRadii(metrics, sil);

  const torso = new Surface();
  buildTorso(torso, metrics, pal, sil);
  parts.push({ surface: torso, cls: 'cloth', bind: ['hips', 'spine', 'chest', 'neck'], painted: true });

  const skin = new Surface();
  buildNeck(skin, metrics);
  buildHead(skin, metrics);
  parts.push({ surface: skin, cls: 'skin', color: pal.skin, bind: ['neck', 'head', 'chest'] });

  // Which hand is closed around a haft. Everything else hangs relaxed — a fist
  // on an empty hand is one of the clearest tells of a rig posed by numbers.
  const heldIn = def.weapon && def.weapon.mount !== 'back' ? (def.weapon.mount ?? 'handR') : null;

  for (const side of [1, -1]) {
    const sfx = side > 0 ? 'L' : 'R';
    const J = (n) => new THREE.Vector3(metrics.joints[n].x, metrics.joints[n].y, metrics.joints[n].z);
    const arm = new Surface();
    const bare = def.accessories?.bareShoulder === sfx || def.accessories?.prosthetic === sfx;
    // Two corrections here, and the second is the larger.
    //
    // The joints' own `z` is passed through now. It used to be zeroed, which
    // silently discarded the elbow and knee set-back that `Rig` computes — the
    // limbs were rebuilt dead straight however the rig was bent.
    //
    // And the arm starts at the **shoulder joint**, not at the acromion. It used
    // to run from `shoulderL`, which put the top fifth of the tube across the
    // `shoulder → arm` stub: two bones, one of which follows the chest and one
    // the arm, sharing a visible surface over a span shorter than the blend
    // itself. Lifting the arm 90° left that surface holding 20–39% of its width
    // and rolling it left 5–22% — the two artefacts the brief names, and by far
    // the worst pair in the rig. Starting at `arm` makes the whole tube the
    // humerus's, which is what it anatomically is; the deltoid cap below covers
    // the joint, and a cap squashes under a lift where a tube pinches.
    buildLimb(
      arm, J(`arm${sfx}`), J(`forearm${sfx}`), J(`hand${sfx}`),
      radii.arm.root, radii.arm.mid, radii.arm.tip, 'arm',
    );
    parts.push({
      surface: arm,
      cls: bare ? 'skin' : 'cloth',
      color: bare ? pal.skin : pal.identity,
      bind: [`shoulder${sfx}`, `arm${sfx}`, `forearm${sfx}`, `hand${sfx}`],
    });

    // Deltoid. The plate's shoulders are a defined cap of muscle sitting *over*
    // the joint, wider than the arm below it — it is what makes the shoulder
    // line read at all, and a tube socketed straight into the trunk has none.
    // Its own surface rather than a swell on the arm, because it has to blend
    // across the shoulder bone and the arm tube must not.
    //
    // It is a **teardrop aligned to the humerus**, not a sphere sitting on top of
    // one. A sphere is what the closeup showed: a distinct pale ball balanced on
    // the shoulder, reading as a pauldron nobody authored, because a sphere's
    // silhouette is a circle and a circle abutting a tube always reads as two
    // objects. A real deltoid caps the joint at its top and runs to a point
    // where it inserts a third of the way down the arm, so the profile below
    // holds full width across the cap and closes to 28% at the insertion —
    // whereupon the taper meets the arm tube's own radius and the two weld into
    // one silhouette.
    const shoulderCap = new Surface();
    const armJ = J(`arm${sfx}`);
    const capUp = armJ.clone().sub(J(`forearm${sfx}`)).normalize();
    const capX = new THREE.Vector3(0, 0, 1).cross(capUp).normalize();
    const capZ = new THREE.Vector3().crossVectors(capX, capUp).normalize();
    const capR = radii.arm.root;
    blob(shoulderCap, {
      cx: 0, cy: 0, cz: 0,
      // 1.30 rx puts the deltoid's outer edge at 0.137 H, i.e. a shoulder line
      // 0.274 H across against a 0.218 H skull — 1.26 head-widths, between the
      // plate's measured 1.01 (hat-mage) and 1.35 (staff-mage in a coat). The
      // roster's `shoulder` and `limb` multipliers spread the cast across that
      // whole band from here; see `Rig.F`'s header.
      rx: capR * 1.30, ry: capR * 1.62, rz: capR * 1.26,
      eU: 0.88, eV: 0.90, segU: 20, segV: 16,
      // v = 0 is the insertion point down the arm, v = 1 the crest over the
      // joint; the shoulder itself is the top half, so the taper is spent
      // entirely on the lower one.
      profile: (v) => 0.28 + 0.72 * smoothstep01(v / 0.55),
      matrix: new THREE.Matrix4().makeBasis(capX, capUp, capZ).setPosition(armJ),
    });
    parts.push({
      surface: shoulderCap,
      cls: bare ? 'skin' : 'cloth',
      color: bare ? pal.skin : pal.identity,
      bind: ['chest', `shoulder${sfx}`, `arm${sfx}`],
    });

    const hand = new Surface();
    // How closed the fist is. A hand on a haft closes fully onto the modelled
    // grip; a hand with nothing in it does not, or the character reads as
    // clenching for no reason. But 0.34 was an *open* hand with the fingers
    // splayed, and at battle distance four splayed fingers alias into a comb
    // while a loose fist keeps one clean silhouette with grooves in it — which
    // is also the hand every plate figure's free arm is carrying. 0.55 is that
    // loose fist, and a character with no held weapon at all (a back-slung
    // chakram, a forearm piston) gets it on both hands.
    buildHand(hand, metrics, side, radii.arm.tip, heldIn === `hand${sfx}` ? 1 : 0.55);
    parts.push({
      surface: hand,
      cls: def.accessories?.prosthetic === sfx ? 'metal' : 'skin',
      color: def.accessories?.prosthetic === sfx ? pal.accent : pal.skin,
      bind: [`forearm${sfx}`, `hand${sfx}`],
    });

    // The cuff hides the skin/cloth boundary at the wrist. Skipped on a bare
    // arm (there is no sleeve to hem) and on the prosthetic (the brass sleeve
    // already terminates the limb).
    if (!bare && def.accessories?.prosthetic !== sfx) {
      const cuff = new Surface();
      buildCuff(cuff, metrics, side, radii.arm);
      parts.push({
        surface: cuff, cls: 'cloth', color: pal.trim,
        bind: [`forearm${sfx}`, `hand${sfx}`],
      });
    }

    const leg = new Surface();
    buildLimb(
      leg, J(`thigh${sfx}`), J(`shin${sfx}`), J(`foot${sfx}`),
      radii.leg.root, radii.leg.mid, radii.leg.tip, 'leg',
    );
    const bareLeg = Boolean(def.accessories?.barefoot);
    parts.push({
      surface: leg,
      cls: bareLeg ? 'skin' : 'cloth',
      color: bareLeg ? pal.skin : pal.secondary,
      bind: ['hips', `thigh${sfx}`, `shin${sfx}`, `foot${sfx}`],
    });

    const boot = new Surface();
    if (def.accessories?.barefoot) {
      // Bare feet: same wedge, skin toned, no cuff, and smaller — Seren's
      // bare feet are part of her read (WORLD_BIBLE §3.2).
      buildBoot(boot, metrics, side, 0);
      parts.push({ surface: boot, cls: 'skin', color: pal.skin, bind: [`shin${sfx}`, `foot${sfx}`] });
    } else {
      buildBoot(boot, metrics, side, H * 0.045, { body: pal.leather, cuff: pal.trim });
      parts.push({ surface: boot, cls: 'cloth', bind: [`shin${sfx}`, `foot${sfx}`], painted: true });
    }
  }

  buildHair(parts, metrics, def, pal);
  if (metrics.chains.hair.length > 1) buildHairChain(parts, metrics, def, pal, rig);
  buildWeapon(parts, metrics, def, pal, rig);
  buildAccessories(parts, metrics, def, pal);

  // Built before the class buckets are assembled so a garment failure cannot
  // half-construct a character: either the whole body is there with its layers
  // or it is there without them.
  const garments = buildGarments(def, metrics, rig);

  // ---- the painted face --------------------------------------------------
  //
  // Skinned against the same whitelist as the skull rather than bound rigidly
  // to the head bone. The plate sits barely a third of a millimetre off the
  // skull, so identical weights mean identical deformation: under a neck bend
  // the two surfaces move as one and the plate cannot shear off the face.
  parts.push({
    surface: buildFacePlate(metrics, pal), cls: 'face',
    bind: ['neck', 'head', 'chest'], painted: true,
  });

  // ---- geometry assembly -------------------------------------------------
  const coreSegments = skinSegments(rig);
  const segByName = new Map(coreSegments.map((s) => [s.name, s]));
  const buckets = new Map(CLASSES.map((c) => [c, []]));

  for (const part of parts) {
    if (part.surface.empty) continue;
    const geo = part.surface.finish(creaseFor(part));

    // `painted` parts carried their zones out of the builder, per vertex, and
    // must not be flattened back to a single tone here.
    if (!part.painted) paint(geo, part.color, part.cls, part.colorScale ?? 1);

    if (part.rigid !== undefined) {
      rigidSkin(geo, part.rigid);
    } else if (part.segments) {
      solveSkin(geo, part.segments);
    } else {
      const list = part.bind === 'body' || !part.bind
        ? coreSegments
        : (Array.isArray(part.bind) ? part.bind : [part.bind])
          .map((n) => segByName.get(n))
          .filter(Boolean);
      solveSkin(geo, list.length ? list : coreSegments);
    }
    const bucket = buckets.get(part.cls) ?? buckets.get('cloth');
    bucket.push(geo);
  }

  // ---- materials ---------------------------------------------------------
  //
  // Not one texture between them except the painted face. ANIME_PIPELINE's
  // absolute rule: no procedural noise on a character. The weave normal, the
  // grind-line normal and the leather bump that used to be fetched here are all
  // fBm out of `AssetForge`, and on a character they read as dirt — which is
  // half of what the client saw. `forge` stays in the signature because it is
  // part of the module contract in ARCHITECTURE.md and monsters and props still
  // want it; characters simply no longer ask it for anything.
  const shared = { lighting, ...BODY_RIM };

  const materials = {
    skin: toonMaterial('skin', { ...shared, name: `${def.id}:skin` }),
    // The face shares `skin` down to the last uniform — same preset, same rim
    // envelope — so the plate's buried rim and the skull around it shade
    // identically and there is no seam to find. It differs in exactly two
    // things: the painted map, and `vertexColors: false`, because three
    // multiplies vertex colour into the map and a face multiplied by its own
    // skin tone would come out with a grey sclera. `faceFlatten` is redundant
    // against the preset's own 0.75 floor and passed anyway — §2's face clamp is
    // the one number the pipeline calls essential, and it should be visible at
    // the call site rather than inherited silently.
    face: createToonMaterial({
      preset: 'skin', ...shared, name: `${def.id}:face`,
      // 1024 rather than 512.
      //
      // The review's "jagged aliased polyline" lash is a sampling failure, not a
      // drawing one: at 512 the lash bar is about 25 texels of near-black across
      // a white sclera, and the closeup camera magnifies the face plate roughly
      // 1:1, so every stair-step in the rasterised curve is a screen pixel. At
      // 1024 the canvas rasteriser anti-aliases the same curve at twice the
      // linear rate and the mip chain box-filters it back down for the battle
      // camera — supersampling the highest-contrast edge in the game for the
      // cost of 4 MB a character.
      map: clampFaceTexture(buildFaceTexture(def, { expression, size: 1024 })),
      vertexColors: false, faceFlatten: true,
    }),
    // The hair band is tightened from the preset's default, and it is a *shape*
    // correction rather than a taste one. `TOON_PRESETS.hair` thresholds its
    // Kajiya-Kay lobe at 0.52 with exponent 96, which lands a band on a
    // human-scale head; a chibi cranium is a near-sphere barely two head-radii
    // across, so the lobe stays above that threshold across the entire crown and
    // resolves as a blown white cap rather than as a band — every character
    // rendered as though wearing a cream skullcap. Narrowing the lobe and
    // raising the cut restores ANIME_PIPELINE §3's "bright, slightly desaturated
    // band with hard-ish edges" on this geometry.
    hair: toonMaterial('hair', {
      ...shared, name: `${def.id}:hair`,
      // ANIME_PIPELINE §3 and the review both ask for **one glossy band running
      // around the crown**, and the previous settings did not deliver one: at
      // exponent 240 / threshold 0.86 the Kajiya-Kay lobe clears the cut over
      // about two degrees of surface, which is a specular *pinprick*. The
      // opposite failure is the preset's own 96 / 0.52, which on a near-spherical
      // chibi cranium — where the projected strand tangent degenerates at the
      // pole — blows the whole crown out into a cream skullcap.
      //
      // 170 / 0.55 puts the cut at |t·h| ≈ 0.084, a band roughly five degrees
      // wide: readable as a band at battle distance, nowhere near wide enough to
      // reach the degenerate pole. Softness is doubled so its edges are "hard-
      // ish" rather than hard, which is what §3 actually asks for.
      specGain: 1.25, specExponent: 170, specThreshold: 0.55, specSoftness: 0.07,
    }),
    cloth: toonMaterial('cloth', { ...shared, name: `${def.id}:cloth` }),
    metal: toonMaterial('metal', { ...shared, name: `${def.id}:metal` }),
    // Simulated cloth gets its own material, and the only thing that differs is
    // the rim. A fresnel rim is only a *rim* on a convex body, where `N·V → 0`
    // happens along the silhouette and nowhere else. A cape, a skirt and an
    // apron are large flat sheets hanging edge-on to the fixed side-view
    // camera, so `N·V → 0` over their entire area and the "rim" floods the
    // whole panel with the rig's teal ring glow — which is what turned every
    // costume in the party into the same sheet of pale cyan and hid all of §5's
    // colour blocking behind it. Held to a fifth of the body's gain and a
    // tighter fresnel, the band survives where a hem genuinely curves away and
    // stops competing with the albedo everywhere else.
    panel: toonMaterial('cloth', {
      ...shared, name: `${def.id}:panel`,
      rimGain: 0.10, rimPower: 4.5, rimFloor: 0.25,
      // And its shadow runs darker and keeps more of its own hue. The fixed
      // side-view camera sees the *back* of every cape, so a panel's shadow
      // response — not its lit response — is what the garment actually looks
      // like in play. The body's 0.48 rotation toward the scene tint is right
      // for a surface whose lit side dominates and wrong here: it turned a
      // scarlet coat tail grey-violet, which is identity thrown away on the
      // largest area a character owns.
      shadowMix: 0.30, shadowValue: 0.60, shadowLevel: 0.14, ambientGain: 0.62,
    }),
    glow: glowMaterial(def.id),
  };

  // ANIME_PIPELINE §4: "Skip outlines on the eyes; the painted lash line already
  // provides that weight." A hull around the face plate would draw a dark ring
  // across the cheeks, and the head's silhouette is already inked by the skull's
  // own hull. Marked on the materials so `buildOutline` refuses them even if a
  // caller reaches for `buildOutlines(root)`.
  setOutlineSkip(materials.face);
  setOutlineSkip(materials.glow);

  // Every character surface is opaque and writes depth, stated here rather than
  // assumed. See `sealOpaque`: the review's ghosted party is the scene's
  // volumetric pass compositing over the cast, and the only way to say that
  // with confidence is for the cast's own side of the contract to be asserted
  // instead of inherited from a preset table this module does not own.
  for (const key of Object.keys(materials)) sealOpaque(materials[key]);

  // ---- skinned meshes ----------------------------------------------------
  const meshes = [];
  const outlines = [];
  const bounds = new THREE.Sphere(new THREE.Vector3(0, H * 0.55, 0), H * 1.15);
  for (const cls of CLASSES) {
    const list = buckets.get(cls);
    if (!list || list.length === 0) continue;
    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!merged) {
      console.warn(`[CharacterFactory] merge failed for class "${cls}" on ${def.id}`);
      continue;
    }
    if (list.length > 1) for (const g of list) g.dispose();
    merged.boundingSphere = bounds.clone();
    merged.boundingBox = new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(0, H * 0.5, 0), new THREE.Vector3(H * 1.6, H * 1.3, H * 1.6),
    );

    const mesh = new THREE.SkinnedMesh(merged, materials[cls]);
    mesh.name = `${def.id}:${cls}`;
    // The face plate neither casts nor receives. It is coincident with the
    // skull to within a third of a millimetre, so casting from it would put
    // shadow acne across the painted eyes — the one surface in the game that
    // cannot afford any — while the skull behind it already casts the identical
    // silhouette. `glow` is emissive and has nothing to occlude.
    mesh.castShadow = cls !== 'face' && cls !== 'glow';
    mesh.receiveShadow = cls !== 'face' && cls !== 'glow';
    mesh.frustumCulled = true;
    // Layer 0 stays on, so this is invisible to any scene that does not look
    // for it; a scene that does can render the cast as its own pass after the
    // volumetrics without knowing how a character is put together.
    mesh.layers.enable(CAST_LAYER);
    root.add(mesh);
    // Bound with the rig at the origin: `AttachedBindMode` (the default)
    // refreshes `bindMatrixInverse` from the mesh's world matrix every frame,
    // so moving `root` around the world cannot double-transform the skin.
    mesh.bind(rig.skeleton, new THREE.Matrix4());
    meshes.push(mesh);

    // Inverted-hull outline on the classes that define the silhouette.
    // `buildOutline` derives the line colour from the source material's own
    // albedo — per fragment here, since every one of these carries a vertex
    // colour block — which is how ANIME_PIPELINE §4's "dark-warm line on hair,
    // dark-cool on cloth" happens on a single merged mesh.
    if (outline && OUTLINED.has(cls)) {
      const hull = buildOutline(mesh, { width: outlineWidth });
      if (hull) {
        hull.layers.enable(CAST_LAYER);
        // The hull must be parented, not merely returned. It is a SkinnedMesh
        // sharing the source's skeleton and bind matrix, so adding it to the
        // same root is what puts it in the render graph and keeps it deforming
        // with the body. Handing it back in the result object and trusting the
        // scene to parent it meant every character shipped with no ink line at
        // all — the outline pass ran, produced geometry, and drew nothing.
        root.add(hull);
        outlines.push(hull);
      }
    }
  }

  // ---- garments ----------------------------------------------------------
  //
  // Each piece keeps its own material, so unlike the body it cannot be merged
  // into a shading-class bucket — a layered costume is layered precisely because
  // its layers do not share a surface response. They are skinned to the same
  // skeleton and bound the same way, and they take the same inverted-hull
  // outline as any other cloth so the silhouette stays one drawing.
  for (const piece of garments) {
    piece.geometry.boundingSphere = bounds.clone();
    const mesh = new THREE.SkinnedMesh(piece.geometry, piece.material);
    mesh.name = `${def.id}:garment:${piece.name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.layers.enable(CAST_LAYER);
    root.add(mesh);
    mesh.bind(rig.skeleton, new THREE.Matrix4());
    meshes.push(mesh);
    if (outline) {
      const hull = buildOutline(mesh, { width: outlineWidth });
      if (hull) {
        hull.layers.enable(CAST_LAYER);
        root.add(hull);
        outlines.push(hull);
      }
    }
  }

  // ---- grounding ---------------------------------------------------------
  const contact = opts.contactShadow === false ? null : buildContactShadow(rig, metrics);
  if (contact) root.add(contact.group);

  // ---- cloth -------------------------------------------------------------
  const cloth = buildCloth(root, rig, metrics, def, pal, materials);

  // ---- animator ----------------------------------------------------------
  const skip = new Set();
  for (const name of rig.order) {
    if (name.startsWith('hair') || name.startsWith('cape')) skip.add(name);
  }
  const animator = new Animator({
    bones: rig.bones,
    order: rig.order,
    rest: rig.rest,
    metrics,
    def,
    skip,
    // No iris or lid geometry exists any more: both are painted into the face
    // texture, and `Animator` treats them as optional. Blink and gaze are
    // therefore currently inert — see the note on `setExpression`.
    irises: null,
    lids: null,
  });
  animator.play('idle', { fade: 0 });

  root.updateMatrixWorld(true);
  // Place the foot decals for frame zero: a scene that renders before its first
  // `update` would otherwise show both blobs stacked at the character's origin.
  contact?.update(root);

  let disposed = false;
  const character = {
    root,
    skeleton: rig.skeleton,
    bones: rig.bones,
    animator,
    cloth,
    height: H,
    /** Extras beyond the contract — handy, never required. */
    def,
    metrics,
    meshes,
    outlines,
    materials,
    /**
     * Convenience tick. The order is load-bearing: pose the skeleton, flush the
     * world matrices, *then* simulate — cloth anchors read bone world matrices,
     * so simulating first would hang every cape one frame behind its owner.
     */
    update(dt) {
      animator.update(dt);
      root.updateMatrixWorld(true);
      contact?.update(root);
      cloth?.update(dt);
    },
    /**
     * Battle feedback hook: an additive tint across every lit surface, plus the
     * animated uniforms the toon shader needs. `pulse` is what a damage flash,
     * a status aura or an esper bond glow drives.
     * @param {object} o forwarded to `updateToonUniforms`
     */
    setToonUniforms(o) {
      for (const key of ['skin', 'face', 'hair', 'cloth', 'metal', 'panel']) {
        updateToonUniforms(materials[key], o);
      }
    },
    /**
     * Swap the painted face for another expression — `'neutral'`,
     * `'determined'`, `'hurt'` or `'joy'`.
     *
     * This is the whole expression system now that the face is a texture, and
     * it is a single `map` assignment: `FaceTexture` caches by (character,
     * expression, size), so the first call per expression paints a 512² canvas
     * and every call afterwards is free. Nothing recompiles — `USE_MAP` is
     * already defined and three refreshes the sampler from `material.map` each
     * frame.
     *
     * The textures are owned by that cache and are deliberately **not** disposed
     * with the character: a party of four sharing the neutral face is the normal
     * case, and releasing it with the first member to be torn down would blank
     * the other three. `disposeFaceCache()` is the global release.
     *
     * @param {string} name expression id; unknown names fall back to neutral.
     */
    setExpression(name) {
      materials.face.map = clampFaceTexture(buildFaceTexture(def, { expression: name, size: 1024 }));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      animator.dispose();
      cloth?.dispose();
      contact?.dispose();
      // Hulls share their source's attribute buffers, so they are released
      // before the meshes free them; `disposeOutline` detaches the shared
      // attributes first and only reclaims the hull's own welded-normal buffer.
      disposeOutline(outlines);
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.removeFromParent();
      }
      // The materials are per-character and ours. The face *texture* is not: it
      // belongs to `FaceTexture`'s cache and is shared with every other
      // character wearing the same expression.
      for (const key of Object.keys(materials)) materials[key].dispose();
      rig.skeleton.dispose?.();
      root.removeFromParent();
    },
  };
  return character;
}

/**
 * Cloth rig: colliders derived from the body's own capsules, then one to three
 * simulated panels per character according to the roster's `cape` block.
 */
function buildCloth(root, rig, metrics, def, pal, materials) {
  const cape = def.cape;
  const chainCount = metrics.chains.hair.length - 1;
  if (!cape && chainCount <= 0) return null;

  const H = metrics.height;
  const g = metrics.girth;
  const sim = new ClothSim({ root, bones: rig.bones, height: H, gravity: -9.2, iterations: 6 });

  // Colliders: torso, hips and both thighs. A cape hem finds every gap, so the
  // capsules deliberately overlap rather than abutting.
  sim.addCollider('chest', 'hips', Math.max(g.chestX, g.hipX) * 0.94);
  sim.addCollider('hips', 'spine', g.hipX * 0.98);
  sim.addCollider('neck', 'head', metrics.head.rx * 0.88);
  for (const s of ['L', 'R']) {
    sim.addCollider(`thigh${s}`, `shin${s}`, g.thigh * 1.15);
  }

  const clothMat = materials.panel;

  if (cape) {
    const len = cape.length * H;
    const wid = cape.width * H;
    // Graded rather than raw, so a swatch authored by eye cannot invert the
    // frame's value hierarchy — Seren's ivory is linear luminance 0.81 and
    // would otherwise be the brightest object on the stage. `gradeAlbedo` moves
    // the level and leaves the authored hue untouched.
    //
    // Cape outside is the identity colour and the lining is the trim, which is
    // deliberate and is most of what the cloth contributes to §5: a coat that
    // flares shows a hard flash of the character's brightest colour, and it is
    // the one moment in an idle where the trim is a large area rather than a
    // seam.
    const common = {
      material: clothMat,
      color: gradeAlbedo(pal.cape, 'cloth'),
      lining: gradeAlbedo(pal.capeLining, 'cloth'),
      thickness: H * 0.008,
      stiffness: cape.stiffness ?? 0.45,
      drag: cape.drag ?? 0.03,
      mass: cape.mass ?? 1.0,
      // A coat tail is wrapped hard around the body (`curve: 0.95` below), so
      // its columns are a curved cross-section rather than a flat sheet's and
      // they facet exactly as a skirt's do. 12 across a 0.95 rad wrap is a 4.5°
      // step, which is smooth at any zoom.
      cols: 12,
      rows: 11,
    };

    if ((cape.split ?? 0) > 0.01) {
      // Split coats become two independent tails. Simulating them as one sheet
      // with a slit would need tearing logic; two panels give the same read and
      // let the asymmetric tail carry different mass, which is the point.
      const asym = cape.asymmetry ?? 0;
      for (const side of [1, -1]) {
        sim.addPanel({
          ...common,
          name: `${def.id}-coat-${side > 0 ? 'L' : 'R'}`,
          anchor: cape.anchor ?? 'chest',
          width: wid * 0.46,
          length: len * (side > 0 ? 1 : 1 + asym),
          flare: 1.25,
          // Wrapped hard enough to sit *on* the body rather than behind it: a
          // coat tail with no curvature is a plank hanging off a shoulder, and
          // it is the flatness rather than the length that reads as cardboard.
          curve: 0.95,
          hem: 'swallow',
          offsetX: side * wid * 0.24,
          offsetY: g.chestZ * 0.2,
          offsetZ: -g.chestZ * 0.55,
          tiltZ: 0.35,
          mass: common.mass * (side > 0 ? 1 : 1 + asym * 0.4),
        });
      }
    } else {
      sim.addPanel({
        ...common,
        name: `${def.id}-${cape.kind}`,
        anchor: cape.anchor ?? 'chest',
        width: wid,
        length: len,
        flare: cape.kind === 'mantle' ? 1.05 : 1.30,
        curve: cape.kind === 'apron' ? 0.85 : 1.55,
        hem: cape.hem ?? (cape.kind === 'apron' ? 'round' : 'point'),
        offsetY: g.chestZ * 0.25,
        offsetZ: cape.kind === 'apron' ? g.chestZ * 0.92 : -g.chestZ * 0.72,
        tiltZ: cape.kind === 'apron' ? -0.10 : 0.28,
      });
    }

    if (cape.skirt) {
      // A wrapping skirt is a *tube*, and it has to be a tube centred on the
      // body. `addPanel` lays a curved panel out with its edge columns on
      // `offsetZ` and its centre column bowed forward by `(1 - cos(curve/2)) ·
      // radius`. Below a half turn that is exactly right — the middle of a cape
      // sits against the back and the edges come round onto the ribs — but past
      // a half turn the edges have wrapped back and the construction displaces
      // the whole ring forward by very nearly its own radius. Seren's skirt hung
      // a full radius in front of her hips with its waist opening aimed at the
      // battle camera, and the frame looked straight down inside her clothing.
      //
      // Two corrections, and both are derived rather than dialled so retuning
      // one cannot desynchronise the other. `offsetZ` is the bow term negated,
      // which puts the arc's circle centre on the body axis. And the waist
      // radius is pulled just *inside* the hip girth, so the body itself plugs
      // the top of the tube from every angle instead of relying on a garment
      // hem to cover it.
      const skirtCurve = TAU * 1.03;
      const skirtWidth = g.hipX * TAU * 1.02;
      const skirtRadius = skirtWidth / skirtCurve;
      sim.addPanel({
        material: clothMat,
        color: gradeAlbedo(pal.identity, 'cloth'),
        lining: gradeAlbedo(pal.secondary, 'cloth'),
        thickness: H * 0.007,
        name: `${def.id}-skirt`,
        anchor: 'hips',
        // A wrapping skirt's `width` is its *circumference*, because `curve`
        // here is a full turn — the panel is a tube, not a sheet.
        //
        // `curve` is TAU × 1.03, deliberately *past* a closed turn. At 0.94 the
        // tube left a 6% gap down the back seam, and since the grid does not
        // wrap there is no constraint holding the two edge columns together —
        // so the gap opens under wind and you see the terrain through the skirt.
        // Overlapping the seam by 3% closes it for every pose without needing a
        // wrapped constraint topology.
        width: skirtWidth,
        length: cape.skirt.length * H,
        flare: cape.skirt.flare ?? 1.7,
        curve: skirtCurve,
        hem: 'hemline',
        offsetY: g.hipX * 0.34,
        offsetZ: Math.cos(skirtCurve * 0.5) * skirtRadius,
        stiffness: cape.skirt.stiffness ?? 0.24,
        drag: cape.skirt.drag ?? 0.05,
        mass: 0.8,
        // 24 columns around a closed tube, not 16. The success test for this
        // whole pass is "no facet edges on the faces of a skirt at 100% zoom",
        // and a 16-sided tube steps its normal 22.5° per column — well past any
        // toon ramp's band width, so every one of those sixteen boundaries
        // printed as a vertical value edge down the skirt. 24 brings the step to
        // 15°, inside the ramp's softest band, and costs 27 extra cloth
        // particles on the two characters that wear one.
        cols: 24,
        rows: 10,
      });
    }

    if (cape.sash) {
      const side = cape.sash.side === 'L' ? 1 : -1;
      sim.addPanel({
        material: clothMat,
        color: gradeAlbedo(pal.accent, 'cloth'),
        lining: gradeAlbedo(pal.accent, 'cloth', 0.7),
        thickness: H * 0.004,
        hem: 'point',
        name: `${def.id}-sash`,
        anchor: 'hips',
        width: cape.sash.width * H,
        length: cape.sash.length * H,
        flare: 0.85,
        curve: 0.0,
        offsetX: side * g.hipX * 0.85,
        offsetY: g.hipX * 0.2,
        offsetZ: g.hipZ * 0.35,
        stiffness: cape.sash.stiffness ?? 0.18,
        drag: cape.sash.drag ?? 0.06,
        mass: 0.5,
        cols: 4,
        rows: 10,
      });
    }
  }

  // Hair chains: one strand per character that declares hair bones.
  if (chainCount > 0) {
    const names = [];
    for (let i = 0; i < chainCount; i++) names.push(`hair${i}`);
    sim.addStrand({
      bones: names,
      stiffness: def.hair?.boneStiffness ?? 0.4,
      drag: 0.075,
      mass: 0.55,
      tipLength: H * 0.05,
    });
  }
  // Bone-driven mantles (Yshara) get the same treatment on the cape chain.
  const capeChain = metrics.chains.cape.length - 1;
  if (capeChain > 0) {
    const names = [];
    for (let i = 0; i < capeChain; i++) names.push(`cape${i}`);
    sim.addStrand({ bones: names, stiffness: 0.5, drag: 0.06, mass: 0.9, tipLength: H * 0.05 });
  }

  // A gentle standing breeze so nothing is ever completely still — ART_BIBLE
  // §7.9 again: cloth that stops when the character does is a failed review.
  sim.setWind(new THREE.Vector3(0.28, 0.0, -0.16), 0.30);
  return sim;
}

/**
 * Build-time geometry audit for one roster entry.
 *
 * The review's fifth finding asks for exactly this: "an automated check that
 * every rig's face UV island is non-empty and that the face normal is within 15
 * degrees of the head bone's forward". Two of six characters shipped without a
 * usable face and nothing in the pipeline noticed, because the only test was a
 * person looking at a render. This runs the same builders `buildCharacter` runs,
 * inspects the raw vertex buffers, and reports the invariants that were violated
 * — no renderer, no canvas, no browser, so it can run anywhere.
 *
 * Checks, in the order they matter:
 *
 *  - `face-uv-island` — the plate's UV must span most of the texture. An island
 *    collapsed to a point is the failure mode where a face texture binds but
 *    lands on three texels of blank cheek.
 *  - `face-normal` — the plate's area-weighted normal must point within 15° of
 *    the head's forward axis. This is the check that catches a face plane
 *    rotated onto the temple.
 *  - `hair-in-skull` — no hair vertex inside the scalp. Below 1.0 is a lock
 *    driven through the head; this is what produced the mottling.
 *  - `hair-over-eyes` — no hair vertex in front of the painted eye block.
 *  - `hair-mass-below-hairline` — no style-mass clump may root on bare skin.
 *    This is the one that would have caught the black slab over Yshara's cheek:
 *    it was outside the skull, clear of the eye block and inside the heads-tall
 *    band, so every other check here passed it.
 *  - `heads-tall` — REFERENCE_TARGET §1's 3.0–3.5 band, measured against the
 *    silhouette head mass (skull plus hair) rather than the skull alone,
 *    because that is what a critic measures.
 *  - `silhouette-spread` — the trunk shaping and limb taper actually differ
 *    across the roster. Reported per character; `auditRoster` is where the
 *    six-way comparison is worth reading.
 *
 * @param {object|string} defOrId roster entry or id
 * @returns {{id: string, headsTall: number, faceUvSpan: number,
 *            faceNormalDeg: number, hairMinDepth: number,
 *            hairFaceIntrusion: number, issues: string[]}}
 */
/** Edge of the square matte `headMatte` rasterises into. */
const MATTE = 80;

/**
 * The hair shell's outer radial scale for a definition.
 *
 * One expression, consumed by `buildHair` (which builds the shell) and by
 * `auditCharacter` (which has to subtract it). Two copies of this number is
 * how an audit ends up measuring a shell that is not the one on the model.
 */
function shellScale(def) {
  return Math.max(def.hair?.capScale ?? 1.08, 1.12);
}

/** A radial copy of a surface about the head centre, for masking. */
function scaledSurface(surface, head, scale) {
  const out = new Surface();
  out.idx = surface.idx;
  out.pos = new Array(surface.pos.length);
  for (let i = 0; i < surface.pos.length; i += 3) {
    out.pos[i] = surface.pos[i] * scale;
    out.pos[i + 1] = head.center.y + (surface.pos[i + 1] - head.center.y) * scale;
    out.pos[i + 2] = surface.pos[i + 2] * scale;
  }
  return out;
}

/**
 * The head mass as a pure-black matte at 80 px, in the battle camera's own
 * projection.
 *
 * REFERENCE_TARGET §1 makes "a clean, distinct black silhouette at 80 px" a
 * *hard requirement* and names hair shape as the channel that carries it — and
 * the review found half the cast failing it ("party slots 4, 5 and 6 all use
 * the same hair asset"). Every other invariant in `auditCharacter` passed that
 * geometry, because none of them can see a shape: they measure depths, spans
 * and angles one character at a time, and silhouette collision is a property
 * of a *pair*. So the audit now rasterises what a critic actually looks at.
 *
 * The projection is deliberately the staged one rather than a front elevation.
 * `LookdevScene.PARTY` turns each figure 0.34–0.52 rad back toward the lens off
 * a side-on address, so a front matte would score shapes nobody ever sees and
 * would flatter exactly the styles — a wide bell, a wide starburst — that
 * collapse into each other in profile.
 *
 * The window is a **fixed square in head-radii, centred on the head centre** —
 * not a fit to each mass's own bounding box. That distinction decides whether
 * the measure can see the defect at all. A per-shape bbox fit normalises away
 * both of the channels the finding is actually about ("different crown heights
 * and different outer extents"): a tall narrow beard and a wide low bell both
 * become a rectangle full of head, and they score as near-identical. Anchoring
 * every matte to the same origin at the same scale means a style that puts its
 * volume somewhere else *measures* as somewhere else. Six characters of
 * different heights still compare fairly, because hair is authored in head
 * diameters and the window is too.
 *
 * Barycentric scan conversion, clipped to the window — which is what a real
 * 80 px frame does to a long beard as well.
 *
 * @param {Array<{surface: Surface}>} parts the hair parts
 * @param {Surface} skull the head surface
 * @param {object} head `metrics.head`
 * @returns {Uint8Array} `MATTE × MATTE` coverage, 1 = inside
 */
function headMatte(parts, skull, head) {
  const YAW = 0.44;
  // Half-extent of the window, in head radii. Wide enough that Seren's tails
  // and Bramm's beard — the widest and the longest masses in the roster — are
  // inside it rather than being scored against the frame edge.
  const HALF = 2.6;
  const cos = Math.cos(YAW);
  const sin = Math.sin(YAW);
  const xs = [];
  const ys = [];
  const idx = [];
  for (const surf of [skull, ...parts.map((p) => p.surface)]) {
    const off = xs.length;
    for (let i = 0; i < surf.pos.length; i += 3) {
      xs.push(surf.pos[i] * cos + surf.pos[i + 2] * sin);
      ys.push(surf.pos[i + 1]);
    }
    for (const j of surf.idx) idx.push(off + j);
  }
  const grid = new Uint8Array(MATTE * MATTE);
  if (!idx.length) return grid;

  const s = MATTE / (2 * HALF * head.ry);
  const px = (x) => MATTE * 0.5 + x * s;
  const py = (y) => MATTE * 0.5 - (y - head.center.y) * s;

  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]; const b = idx[t + 1]; const c = idx[t + 2];
    const ax = px(xs[a]); const ay = py(ys[a]);
    const bx = px(xs[b]); const by = py(ys[b]);
    const cx = px(xs[c]); const cy = py(ys[c]);
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(MATTE - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(MATTE - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const u = ((by - cy) * dx + (cx - bx) * dy) / det;
        const v = ((cy - ay) * dx + (ax - cx) * dy) / det;
        if (u >= 0 && v >= 0 && u + v <= 1) grid[y * MATTE + x] = 1;
      }
    }
  }
  return grid;
}

/**
 * How much of two characters' *hair* occupies the same place, 0–1.
 *
 * Scored over the pixels neither bare skull covers. Without that mask the
 * measure is dominated by the head itself: two chibi skulls in a head-relative
 * window agree on roughly three quarters of their area no matter what is
 * growing out of them, so a genuinely distinct topknot and starburst scored
 * 0.80 against each other while an identical hairpiece scored 0.85 — a range
 * of five points to make a pass/fail call in. Masking the skull out leaves
 * only the thing REFERENCE_TARGET §1 actually names as the distinctiveness
 * channel, and the same two pairs separate by more than a factor of two.
 */
function matteOverlap(a, b) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.matte.length; i++) {
    if (a.bare[i] | b.bare[i]) continue;
    if (a.matte[i] | b.matte[i]) union++;
    if (a.matte[i] & b.matte[i]) inter++;
  }
  return union ? inter / union : 1;
}

export function auditCharacter(defOrId) {
  const def = typeof defOrId === 'string' ? characterDef(defOrId) : defOrId;
  if (!def) throw new Error(`[CharacterFactory] unknown character "${defOrId}"`);
  const m = computeMetrics(def);
  const pal = def.palette;
  const issues = [];

  // ---- face plate ---------------------------------------------------------
  const plate = buildFacePlate(m, pal);
  let uMin = Infinity; let uMax = -Infinity;
  let vMin = Infinity; let vMax = -Infinity;
  for (let i = 0; i < plate.uv.length; i += 2) {
    uMin = Math.min(uMin, plate.uv[i]); uMax = Math.max(uMax, plate.uv[i]);
    vMin = Math.min(vMin, plate.uv[i + 1]); vMax = Math.max(vMax, plate.uv[i + 1]);
  }
  const faceUvSpan = Math.min(uMax - uMin, vMax - vMin);

  // Area-weighted so the buried rim ring — which genuinely faces sideways —
  // cannot outvote the flat centre the painting actually lands on.
  const normal = new THREE.Vector3();
  const va = new THREE.Vector3(); const vb = new THREE.Vector3(); const vc = new THREE.Vector3();
  const ab = new THREE.Vector3(); const ac = new THREE.Vector3(); const cr = new THREE.Vector3();
  const at = (id, out) => out.set(plate.pos[id * 3], plate.pos[id * 3 + 1], plate.pos[id * 3 + 2]);
  for (let t = 0; t < plate.idx.length; t += 3) {
    at(plate.idx[t], va); at(plate.idx[t + 1], vb); at(plate.idx[t + 2], vc);
    ab.subVectors(vb, va); ac.subVectors(vc, va);
    normal.add(cr.crossVectors(ab, ac));
  }
  const faceNormalDeg = normal.lengthSq() > 1e-20
    ? THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(normal.normalize().z, -1, 1)))
    : 180;

  if (!(faceUvSpan > 0.6)) issues.push(`face-uv-island: span ${faceUvSpan.toFixed(3)} < 0.6`);
  if (!(faceNormalDeg < 15)) issues.push(`face-normal: ${faceNormalDeg.toFixed(1)}° off head forward`);
  // A UV outside the unit square is the failure that puts a smeared band — or,
  // under any repeating wrap, a second pair of eyes — on the side of the skull.
  // The plate's own geometry has to make it unreachable; the texture's clamp is
  // a backstop, not a licence.
  if (uMin < 0 || uMax > 1 || vMin < 0 || vMax > 1) {
    issues.push(`face-uv-range: u [${uMin.toFixed(3)}, ${uMax.toFixed(3)}] `
      + `v [${vMin.toFixed(3)}, ${vMax.toFixed(3)}] escapes the unit square`);
  }

  // ---- hair ---------------------------------------------------------------
  const parts = [];
  buildHair(parts, m, def, pal);
  // The bone-driven chain is part of the silhouette even though it is not part
  // of the skull-clearance question, so it joins the matte and nothing else.
  const chain = hairChainSurface(m, def);
  let hairMinDepth = Infinity;
  let hairFaceIntrusion = -Infinity;
  let deepestAt = '';
  let crown = m.head.crownY;
  let hairWidth = m.head.rx * 2;
  // How far below its own hairline the worst *style-mass* clump is rooted.
  //
  // A fringe, a beard and a face-framing lock are all authored to hang past the
  // hairline — that is what they are — so they live in their own surface and
  // are not scored. A back fan, a bell, a starburst or a gather rooted below it
  // is hair bedded onto bare cheek, which is what rendered as a black polygon
  // slab over Yshara's face. Every other invariant here passed that geometry: it
  // never entered the skull, never crossed the eye block, and did not move the
  // heads-tall ratio.
  let rootBelowHairline = 0;
  let rootAt = '';
  for (const part of parts) {
    for (const r of part.roots ?? []) {
      if (r.below > rootBelowHairline) {
        rootBelowHairline = r.below;
        rootAt = `θ=${r.theta.toFixed(2)}`;
      }
    }
  }
  for (let p = 0; p < parts.length; p++) {
    const pos = parts[p].surface.pos;
    for (let i = 0; i < pos.length; i += 3) {
      const d = skullDepth(m.head, pos[i], pos[i + 1], pos[i + 2]);
      if (d < hairMinDepth) {
        hairMinDepth = d;
        // Naming the offending surface is the difference between a check that
        // reports a number and one that tells you which builder to open.
        deepestAt = `part ${p} at (${pos[i].toFixed(3)}, ${(pos[i + 1] - m.head.center.y).toFixed(3)}, ${pos[i + 2].toFixed(3)})`;
      }
      hairFaceIntrusion = Math.max(hairFaceIntrusion, faceIntrusion(m, pos[i], pos[i + 1], pos[i + 2]));
      crown = Math.max(crown, pos[i + 1]);
      hairWidth = Math.max(hairWidth, Math.abs(pos[i]) * 2);
    }
  }
  // `clearSkull` holds every hair vertex at or above 1.045, which is itself
  // sized to cover everything the radial metric ignores (`profile()`'s swell
  // and the superellipse bulge). 1.04 is that floor less one epsilon of
  // spline-resample slack, so the check fails before a scalp can surface.
  if (hairMinDepth < 1.04) {
    issues.push(`hair-in-skull: min depth ${hairMinDepth.toFixed(3)} — ${deepestAt}`);
  }
  if (hairFaceIntrusion > 0) {
    issues.push(`hair-over-eyes: ${(hairFaceIntrusion / m.head.ry).toFixed(3)} ry in front of the plate`);
  }
  // Zero tolerance, because there is no style in the roster that wants one: a
  // mass clump's root either sits on the hair shell or it sits on skin.
  if (rootBelowHairline > 0) {
    issues.push(`hair-mass-below-hairline: ${rootBelowHairline.toFixed(2)} rad at ${rootAt}`);
  }

  // ---- proportion ---------------------------------------------------------
  // Measured on the *silhouette* head — skull plus whatever hair and headgear
  // project past it — because that is the shape a critic with a ruler measures
  // and the only one the plates and the prose specs can be compared on.
  //
  // The band is **3.2–3.7**, centred on `bravely02`'s standing hat-mage at 3.35.
  // `Rig.F`'s header carries the full six-figure measurement it comes from,
  // including why the plates support anything from 2.8 to 4.1 depending on the
  // figure's headgear and how deep its combat pose is, and why we target their
  // chibi end. The band is deliberately tight — ±0.25 head — because its job is
  // to catch a roster `headScale` or `legLength` that has drifted a character
  // out of the cast's own family, not to re-litigate the target.
  const headMass = crown - m.head.chinY;
  const headsTall = m.height / headMass;
  if (headsTall < 3.2 || headsTall > 3.7) {
    issues.push(`heads-tall: ${headsTall.toFixed(2)} outside the plates' 3.2–3.7`);
  }

  // ---- joints -------------------------------------------------------------
  const rigJ = buildRig(def, m);
  const radiiJ = limbRadii(m, silhouetteOf(def));
  const armLimb = ['armL', 'forearmL', 'handL'];
  const armAxis = ['armL', 'forearmL', 'handL'];
  const legLimb = ['thighL', 'shinL', 'footL'];
  const armBind = ['shoulderL', 'armL', 'forearmL', 'handL'];
  const legBind = ['hips', 'thighL', 'shinL', 'footL'];
  const joints = [
    measureJoint(rigJ, m, armLimb, armAxis, 'armL', radiiJ.arm, armBind),
    measureJoint(rigJ, m, armLimb, armAxis, 'forearmL', radiiJ.arm, armBind),
    measureJoint(rigJ, m, legLimb, legLimb, 'shinL', radiiJ.leg, legBind),
  ];
  for (const j of joints) {
    // 0.75 is a quarter of the cross-section lost at a right-angle bend. Linear
    // blend skinning cannot beat cos(θ/2) = 0.707 where two bones share a section
    // evenly, so this asserts that `buildLimb`'s joint swell is putting the
    // difference back — not that the artefact has been designed away.
    if (j.bend < 0.75) {
      issues.push(`joint-collapse: ${j.name} keeps ${(j.bend * 100).toFixed(0)}% of section at 90° bend`);
    }
    // Twist is the candy-wrapper case, and it has no such floor: a roll about a
    // limb's own axis should not change its cross-section at all. Anything under
    // 0.86 means influence is leaking across the joint along the axis.
    if (j.twist < 0.86) {
      issues.push(`joint-twist: ${j.name} keeps ${(j.twist * 100).toFixed(0)}% of section at 90° roll`);
    }
  }

  // ---- silhouette ---------------------------------------------------------
  //
  // The two body-mass channels the review found flat across the whole party,
  // reported as numbers so "the six all share one torso and one tube leg" is a
  // measurement rather than an opinion. `trunkRatio` is the widest ring of the
  // trunk over its narrowest — a box is 1.0 and an hourglass is well above it —
  // and `limbTaper` is the leg's root radius over its ankle.
  const sil = silhouetteOf(def);
  const radii = limbRadii(m, sil);
  const trunk = [-0.02, 0.34, 0.82].map((t) => {
    const bump = (c, w) => {
      const k = THREE.MathUtils.clamp(Math.abs(t - c) / w, 0, 1);
      return 0.5 + 0.5 * Math.cos(k * Math.PI);
    };
    return 1 + sil.hip * bump(-0.02, 0.42) + sil.waist * bump(0.34, 0.34)
      + sil.chest * bump(0.82, 0.42);
  });

  const skull = new Surface();
  buildHead(skull, m);

  return {
    id: def.id,
    headsTall,
    headMassWidth: hairWidth / m.head.ry,
    /** How far the hair mass rises above the bare skull, in head radii. */
    crownRise: (crown - m.head.crownY) / m.head.ry,
    /** @see headMatte — the 80 px black shape a critic actually compares. */
    matte: headMatte(chain ? [...parts, { surface: chain }] : parts, skull, m.head),
    /**
     * The same window covering the skull **and the hair shell over it**, so
     * `matteOverlap` scores only what a style projects beyond the cap.
     *
     * The shell has to be in the mask, not just the skull. Every style in the
     * roster wears one, at a radial offset within a few percent of every other,
     * so an unmasked shell ring is a constant contribution to every pair's
     * intersection — which is precisely the term that was compressing the whole
     * measurement into a five-point band.
     */
    bare: headMatte([], scaledSurface(skull, m.head, shellScale(def)), m.head),
    faceUvSpan,
    faceNormalDeg,
    hairMinDepth,
    hairFaceIntrusion: hairFaceIntrusion / m.head.ry,
    rootBelowHairline,
    trunkRatio: Math.max(...trunk) / Math.min(...trunk),
    limbTaper: radii.leg.root / radii.leg.tip,
    joints,
    issues,
  };
}

/**
 * How much of a joint's cross-section survives being bent and being twisted.
 *
 * "No collapsed joints or candy-wrapper twisting at elbow, knee or shoulder" is
 * a measurable property of the weights rather than a matter of taste, so it is
 * measured. The method is the shipping path end to end: build the real limb with
 * `buildLimb`, solve the real weights with `solveSkin` against the real
 * segments, pose the real skeleton, and apply linear blend skinning by hand.
 *
 * Both numbers are the **minimum ratio of a vertex's distance from the limb's
 * axis after deformation to its distance before**, over vertices whose closest
 * point on the axis is within 1.4 mid-radii of the joint. Vertices nearer the
 * axis than a third of the local radius are skipped: their ratio is dominated by
 * where the axis polyline happens to bend, not by the skin.
 *
 * `bend` rotates the joint bone 90° about X — the hinge the joint is for.
 * `twist` rotates it 90° about its own Y, the axis a forearm rolls about and the
 * one that produces candy-wrapper pinching.
 *
 * @param {object} rig from `buildRig`
 * @param {object} m metrics
 * @param {[string, string, string]} limb the three control points `buildLimb`
 *        is given for this limb — it must be the *shipped* call, or the weights
 *        being measured are not the weights that ship
 * @param {string[]} axis every bone the limb runs through, in order; the
 *        polyline distances are taken against this, so a joint that is not a
 *        control point (the shoulder) still has an axis vertex at it
 * @param {string} joint the bone to rotate
 * @param {{root: number, mid: number, tip: number}} r that limb's radii
 * @param {string[]} bind the same bone whitelist `buildCharacter` gives this
 *        limb — solving against the whole skeleton instead would let the chest
 *        capture the arm's root ring and report a shear that never ships
 */
function measureJoint(rig, m, limb, axis, joint, r, bind) {
  const J = m.joints;
  const P = (n) => new THREE.Vector3(J[n].x, J[n].y, J[n].z);
  const surface = new Surface();
  const kind = joint === 'shinL' ? 'leg' : 'arm';
  buildLimb(surface, P(limb[0]), P(limb[1]), P(limb[2]), r.root, r.mid, r.tip, kind);
  const geo = surface.finish(0);
  const all = skinSegments(rig);
  solveSkin(geo, all.filter((s) => bind.includes(s.name)));

  const pos = geo.getAttribute('position');
  const si = geo.getAttribute('skinIndex');
  const sw = geo.getAttribute('skinWeight');
  const bones = rig.order.map((n) => rig.bones[n]);
  const inverses = rig.skeleton.boneInverses;

  const axis0 = axis.map(P);
  const pivot0 = P(joint);
  const v = new THREE.Vector3();
  const acc = new Float64Array(16);
  const mat = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();
  const seg = new THREE.Vector3();
  const rel = new THREE.Vector3();
  const foot = new THREE.Vector3();

  /** Closest point on a polyline, written into `out`. */
  const footOf = (p, poly, out) => {
    let d = Infinity;
    for (let i = 0; i < poly.length - 1; i++) {
      seg.subVectors(poly[i + 1], poly[i]);
      rel.subVectors(p, poly[i]);
      const t = THREE.MathUtils.clamp(rel.dot(seg) / (seg.lengthSq() || 1e-9), 0, 1);
      foot.copy(poly[i]).addScaledVector(seg, t);
      const dist = p.distanceTo(foot);
      if (dist < d) { d = dist; out.copy(foot); }
    }
    return out;
  };

  /**
   * `hinge` is the world axis the joint is being rotated about. The quantity
   * scored is the offset's component **along** it — which a rigid rotation about
   * that axis preserves exactly, whatever else it does to the shape.
   *
   * That choice is the whole point of the measurement. Scoring the plain radial
   * distance instead conflates two different things: on the inside of a fold the
   * surface genuinely does come together, and it *should* — that is a crease,
   * not a defect, and a metric that fails it fails every correctly folded elbow
   * ever rigged. The hinge-parallel width has no such excuse. It is the width of
   * the limb seen down the bend, it is exactly what "collapsed joint" and
   * "candy-wrapper" name, and it is invariant under the pose being applied.
   */
  const run = (euler, hinge) => {
    const bone = rig.bones[joint];
    const rest = rig.rest[joint].quaternion;
    bone.quaternion.copy(rest).multiply(new THREE.Quaternion().setFromEuler(euler));
    rig.root.updateMatrixWorld(true);
    const axis1 = axis.map((n) => new THREE.Vector3().setFromMatrixPosition(rig.bones[n].matrixWorld));
    // The hinge in world space. Every bind rotation is identity (`Rig.js`), so a
    // local axis on a bone whose ancestors are unposed *is* the world axis.
    const h = hinge.clone().normalize();

    let worst = Infinity;
    const deformed = new THREE.Vector3();
    const foot0 = new THREE.Vector3();
    const foot1 = new THREE.Vector3();
    const e0 = new THREE.Vector3();
    const e1 = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      footOf(v, axis0, foot0);
      // Only the surface right at the joint, and only the flank of it: a vertex
      // whose offset is nearly parallel to the hinge is the one that carries the
      // width, and one that is nearly perpendicular carries none and would score
      // noise divided by noise.
      if (foot0.distanceTo(pivot0) > r.mid * 1.4) continue;
      e0.copy(v).sub(foot0);
      const w0 = Math.abs(e0.dot(h));
      if (w0 < r.mid * 0.55) continue;

      acc.fill(0);
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w <= 0) continue;
        const idx = si.getComponent(i, k);
        tmp.multiplyMatrices(bones[idx].matrixWorld, inverses[idx]);
        for (let e = 0; e < 16; e++) acc[e] += tmp.elements[e] * w;
      }
      mat.fromArray(acc);
      deformed.copy(v).applyMatrix4(mat);
      e1.copy(deformed).sub(footOf(deformed, axis1, foot1));
      const ratio = Math.abs(e1.dot(h)) / w0;
      if (ratio < worst) worst = ratio;
    }
    bone.quaternion.copy(rest);
    rig.root.updateMatrixWorld(true);
    return Number.isFinite(worst) ? worst : 1;
  };

  // The limb's own direction at the joint — the axis a forearm rolls about, and
  // the one candy-wrapper pinching happens around.
  const roll = P(axis[axis.length - 1]).sub(pivot0).normalize();
  const out = {
    name: joint,
    bend: run(new THREE.Euler(Math.PI / 2, 0, 0, 'YXZ'), new THREE.Vector3(1, 0, 0)),
    // Rolling about local Y is not the same as rolling about the limb, because
    // the limb is splayed — but the *hinge* for scoring is the limb, so a bone
    // whose weights leak across the joint still shows up.
    twist: run(new THREE.Euler(0, Math.PI / 2, 0, 'YXZ'), roll),
  };
  geo.dispose();
  return out;
}

/**
 * {@link auditCharacter} across the whole roster, plus the one check that only
 * exists between characters: pairwise silhouette collision.
 *
 * REFERENCE_TARGET §1 calls distinctiveness between the six a hard
 * requirement, and it is the requirement most recently found failing — "three
 * of six characters sharing one identical lampshade hair asset [...] fails
 * outright". A per-character audit structurally cannot catch that, so the pair
 * loop lives here and reports into the offending characters' own `issues`,
 * which is where a builder will look.
 *
 * 0.50 is the threshold, scored on the shell-masked overlap so it measures the
 * *style* rather than the head underneath it. The floor is not zero and cannot
 * be: every style in the roster carries a fringe over the same brow, and a
 * fringe is common to the idiom rather than a failure of authorship. Measured
 * across this roster, styles that put their mass in different places score
 * 0.08–0.40 and two that agree on where the volume goes score above 0.7 — so
 * the band this has to discriminate is wide, and the threshold sits in the gap
 * rather than being tuned to the current numbers.
 */
export function auditRoster(defs = ROSTER) {
  const rows = defs.map((d) => auditCharacter(d));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const overlap = matteOverlap(rows[i], rows[j]);
      if (overlap > 0.50) {
        const note = `silhouette-collision: ${rows[i].id}/${rows[j].id} `
          + `IoU ${overlap.toFixed(3)} at ${MATTE} px`;
        rows[i].issues.push(note);
        rows[j].issues.push(note);
      }
    }
  }
  return rows;
}

export default buildCharacter;
