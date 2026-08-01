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
import { rng } from '../core/GameState.js';
import { LIGHT, luminance } from '../art/Palette.js';
import {
  buildRig, computeMetrics, skinSegments, skullPoint, skullDepth, hairlinePhi,
} from './Rig.js';
import { Animator } from './Animation.js';
import { ClothSim } from './Cloth.js';
import { characterDef, ROSTER } from './roster.js';
import { buildFaceTexture } from './FaceTexture.js';
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
   * @param {number} rows @param {number} cols
   * @param {boolean} wrapCols share the seam column (tubes, spheroids)
   * @param {(i:number, j:number) => {x:number,y:number,z:number}} fn
   * @returns {number[][]} the vertex-id grid, so callers can cap or stitch
   */
  patch(rows, cols, wrapCols, fn) {
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
        this.quad(a, d, c, b);
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
  });
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
  hair: [0.04, 0.50],
  cloth: [0.09, 0.62],
  metal: [0.26, 0.72],
  glow: null,
});

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
function buildTorso(s, m, pal) {
  const g = m.girth;
  const hipY = m.joints.hips.y;
  const neckY = m.joints.neck.y;
  const span = neckY - hipY;

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
    const rx = THREE.MathUtils.lerp(g.hipX, g.chestX, k) * sx;
    const rz = THREE.MathUtils.lerp(g.hipZ, g.chestZ, k) * sz;
    scales.push([rx, rz]);
    // Graded once per ring rather than once per vertex: `sweep` consults the
    // scale function for every column, and `gradeAlbedo` allocates.
    inks.push(gradeAlbedo(pal[name], 'cloth'));
  }
  sweep(s, path, SECTIONS.square(22, 0.86), (i) => {
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
    SECTIONS.circle(14),
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
      eU: 0.9, eV: 0.9, segU: 10, segV: 8,
    });
  }
}

/** A tapered limb swept along its joint chain, with a soft mid-bulge. */
function buildLimb(s, a, b, c, r0, r1, r2, seg = 12) {
  const path = smoothPath([a, b, c], 9);
  const radii = [];
  for (let i = 0; i < path.length; i++) {
    const t = i / (path.length - 1);
    // Two-piece linear taper with a small cosine bulge at the belly of each
    // segment: a perfectly conical chibi limb reads as plastic tubing.
    const r = t < 0.5
      ? THREE.MathUtils.lerp(r0, r1, t * 2)
      : THREE.MathUtils.lerp(r1, r2, (t - 0.5) * 2);
    const bulge = 1 + Math.sin(t * Math.PI * 2) * 0.05;
    radii.push(r * bulge);
  }
  sweep(s, path, SECTIONS.circle(seg), (i) => [radii[i], radii[i]], { capStart: true, capEnd: true });
}

/**
 * Mitten hand: one soft mass plus a thumb nub, no fingers.
 *
 * REFERENCE §1 is explicit — "hands are mitten-like simple masses". Fingers at
 * this scale are three pixels of noise that break the silhouette's clean edge,
 * and they cost more triangles than the entire head.
 */
function buildHand(s, m, side) {
  const g = m.girth;
  const wrist = m.joints[side > 0 ? 'handL' : 'handR'];
  const elbow = m.joints[side > 0 ? 'forearmL' : 'forearmR'];
  const dir = new THREE.Vector3(wrist.x - elbow.x, wrist.y - elbow.y, wrist.z - elbow.z).normalize();

  // The mass *straddles* the wrist rather than sitting past it.
  //
  // The hand's pivot is the wrist bone, so any mesh that begins at the wrist
  // opens a wedge-shaped hole against the sleeve the moment the hand rotates —
  // which is the "hand is a grey lozenge floating in open space with a visible
  // gap from the cuff" defect. Centring the blob only 0.45 hand-widths past the
  // wrist with a 1.25 half-length buries 0.8 of a hand width *inside* the
  // forearm, where it is skinned to the forearm segment and follows the sleeve.
  // No rotation of the hand bone can expose the join.
  const c = new THREE.Vector3(wrist.x, wrist.y, wrist.z).addScaledVector(dir, g.hand * 0.45);

  const basis = new THREE.Matrix4();
  const yAxis = dir.clone();
  const xAxis = new THREE.Vector3(0, 0, 1).cross(yAxis).normalize();
  const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
  basis.makeBasis(xAxis, yAxis, zAxis).setPosition(c);

  // Mitten: flat-ish across the palm, rounded at the knuckles, no fingers
  // (REFERENCE §1). The `profile` pinches the wrist end so the mass tapers into
  // the sleeve instead of ending in a cylinder.
  blob(s, {
    rx: g.hand * 0.86, ry: g.hand * 1.25, rz: g.hand * 0.64,
    eU: 0.88, eV: 0.92, segU: 16, segV: 12, matrix: basis,
    profile: (v) => 1 - Math.pow(THREE.MathUtils.clamp((0.42 - v) / 0.42, 0, 1), 1.4) * 0.34,
  });
  const thumb = new THREE.Matrix4().makeTranslation(side * g.hand * 0.66, g.hand * 0.34, g.hand * 0.12);
  blob(s, {
    rx: g.hand * 0.32, ry: g.hand * 0.50, rz: g.hand * 0.30,
    eU: 0.9, eV: 0.9, segU: 10, segV: 8,
    matrix: basis.clone().multiply(thumb),
  });
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
function buildCuff(s, m, side) {
  const g = m.girth;
  const wrist = m.joints[side > 0 ? 'handL' : 'handR'];
  const elbow = m.joints[side > 0 ? 'forearmL' : 'forearmR'];
  const a = new THREE.Vector3(elbow.x, elbow.y, elbow.z);
  const b = new THREE.Vector3(wrist.x, wrist.y, wrist.z);
  const dir = b.clone().sub(a).normalize();
  const p0 = b.clone().addScaledVector(dir, -g.hand * 0.85);
  const p1 = b.clone().addScaledVector(dir, g.hand * 0.12);
  sweep(s, [p0, p0.clone().lerp(p1, 0.55), p1], SECTIONS.circle(14),
    (i) => { const r = g.wrist * [1.10, 1.30, 1.42][i]; return [r, r * 0.95]; },
    { capStart: false, capEnd: true });
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
    eU: 0.45, eV: 0.55, segU: 18, segV: 12,
    profile: (v) => 1 - Math.pow(THREE.MathUtils.clamp((v - 0.55) / 0.45, 0, 1), 1.4) * 0.26,
  });
  // Toe box: pushed forward and flattened, so the foot has direction. Without
  // it the boot is a symmetric lozenge and a walk cycle reads backwards.
  blob(s, {
    cx: ankle.x, cy: f.height * 0.32, cz: cz + halfL * 0.62,
    rx: halfW * 0.90, ry: f.height * 0.34, rz: halfL * 0.30,
    eU: 0.50, eV: 0.55, segU: 14, segV: 8,
  });
  // Heel block: a hard corner behind the ankle. Two hundred triangles, and it
  // is the difference between a boot and a slipper in silhouette.
  blob(s, {
    cx: ankle.x, cy: f.height * 0.26, cz: cz - halfL * 0.74,
    rx: halfW * 0.80, ry: f.height * 0.30, rz: halfL * 0.22,
    eU: 0.35, eV: 0.40, segU: 12, segV: 7,
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
    SECTIONS.circle(16),
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
function hairShell(s, { head, outer, inner, frontPhi, backPhi, peak, segU = 30, segV = 14, swell = 0.06 }) {
  const ringOuter = [];
  const ringInner = [];
  const p = new THREE.Vector3();
  const build = (scale, ring) => {
    const grid = s.patch(segV, segU, true, (i, j) => {
      const theta = (j / segU) * TAU;
      const lo = hairlinePhi(theta, frontPhi, backPhi, peak);
      const phi = lo + (Math.PI * 0.5 - lo) * (i / segV);
      // The crown swells: hair has bulk on top and is flat at the temples, and
      // that asymmetry is most of what separates a hairstyle from a helmet at
      // silhouette scale.
      const bulk = scale * (1 + swell * Math.pow(Math.max(0, Math.sin(phi)), 2));
      return skullPoint(head, theta, phi, bulk, p);
    });
    for (const id of grid[0]) ring.push(id);
    return grid;
  };
  build(outer, ringOuter);
  build(inner, ringInner);
  // Rim: wound so its normals face outward from the hair mass.
  const n = ringOuter.length - 1;
  for (let j = 0; j < n; j++) {
    s.quad(ringOuter[j], ringInner[j], ringInner[j + 1], ringOuter[j + 1]);
  }
}

/**
 * Push every vertex of a hair surface out of the head.
 *
 * Applied after a surface is fully built rather than negotiated inside each of
 * the six style branches, because the failure it prevents is not a style
 * question: a clump whose spline control point happens to fall inside the head
 * does not read as a modelling slip, it reads as a black ribbon driven through
 * the character's face — the "cage of hair cards stabbing through the faces"
 * finding, and the reason the hero's outer eye looked truncated.
 *
 * The minimum radius switches across the hairline. Above it a clump must clear
 * the shell's outer wall, or it surfaces through the crown in patches; below it
 * only the scalp, so a beard still grows off the jaw instead of ballooning off
 * it. The correction is radial in the head's own metric, so a squashed clump
 * reads as hair lying against the skull — which is what hair does.
 *
 * The margins on top (`+0.06` over the shell, `1.05` over the scalp) cover
 * `profile()`'s 4.5% cranium swell, which the radial metric deliberately
 * ignores so it stays a cheap three-divide test.
 */
function clearSkull(surface, m, shellOuter) {
  const h = m.head;
  const hl = m.hairline;
  const pos = surface.pos;
  const reach = shellOuter + 0.06;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = pos[i + 1];
    const z = pos[i + 2];
    const q = skullDepth(h, x, y, z);
    if (q < 1e-6 || q >= reach) continue;
    const phi = Math.asin(THREE.MathUtils.clamp((y - h.center.y) / h.ry / q, -1, 1));
    const theta = Math.atan2(z / h.rz, x / h.rx);
    const min = phi > hairlinePhi(theta, hl.frontPhi, hl.backPhi, hl.peak) ? reach : 1.05;
    if (q >= min) continue;
    const k = min / q;
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
 * Hair is built as a *carved volume*, never as strands.
 *
 * ANIME_PIPELINE §3, in full: chunky geometric clumps, each "a broad tapered
 * form with a clear point"; **one flat base colour**, no mottling and no
 * per-pixel variation; one anisotropic highlight band; and silhouette doing all
 * the work — spikes, sweeps, twin-tails, a long fringe.
 *
 * Two things changed here from the rejected version, and both are §3 read
 * literally:
 *
 *  - **The highlight band is no longer geometry.** It used to be a strip of
 *    mesh riding proud of the shell in a lighter tone. §3 asks for *one*
 *    highlight band, and `ToonMaterial`'s `hair` preset already produces one —
 *    a thresholded Kajiya-Kay lobe about the strand axis, which is a band by
 *    construction and, unlike a painted strip, moves when the light does. Two
 *    highlights on one head is one of the ways stylised-PBR gives itself away.
 *  - **The clumps are faceted.** The lock section is an eight-sided lens swept
 *    at a 0.65 rad crease, so every clump keeps hard planes with a hard edge
 *    between them. A smooth tube of hair reads as a rope; §3's "carved" is the
 *    whole difference, and it is the facets that carve it.
 *
 * The hair carries exactly two colours: `palette.hair` for every clump and the
 * shell, and `palette.accent` for a binding cord where a style has one. Nothing
 * is noise-textured, nothing is gradient-shaded, and nothing varies per pixel.
 */
function buildHair(parts, m, def, pal) {
  const hp = def.hair ?? {};
  const h = m.head;
  const style = hp.style ?? 'swept';

  const cap = new Surface();
  const detail = new Surface();
  const mass = new Surface();
  const cord = new Surface();
  zone(cap, pal.hair, 'hair');
  zone(detail, pal.hair, 'hair');
  zone(mass, pal.hair, 'hair');
  // Graded on the `metal` band rather than `cloth`: a binding cord is §5's
  // small high-value accent, and the cloth band's floor would sink it into the
  // hair it is tied around.
  zone(cord, pal.accent, 'metal');

  /**
   * The shell's outer and inner walls, as radial offsets of the skull.
   *
   * The floor is not a taste decision. At the previous 0.5% inner offset the
   * shell was thinner than `profile()`'s own cranium swell, so the scalp came
   * through it in patches — the mottled camouflage across every head in the
   * lineup. The review's brief is explicit: hair is "a single sculpted shell
   * offset 2–4 cm off the skull" with "the silhouette carved into the mesh".
   * 8% of a head radius on a chibi skull is about 1.4 cm of wall and 1.4 cm of
   * stand-off — the right order for a head this size, and unconditionally
   * thicker than anything `profile()` can do.
   */
  const shellOuter = Math.max(hp.capScale ?? 1.08, 1.10);
  const shellInner = Math.max(1.045, shellOuter - 0.085);

  /**
   * A point on the hair shell's outer wall.
   *
   * Every lock, spike and tail anchors through this rather than through a
   * hand-written fraction of the head radius. It routes through `skullPoint`, so
   * it carries the jaw taper and the cranium swell the shell itself is built
   * from and cannot drift from it. `scale` below 1 reaches the scalp — the
   * beard grows off the jaw, not off the hair.
   */
  const scalp = (theta, phi, scale = shellOuter * 0.99) => skullPoint(
    h, theta, phi, scale, new THREE.Vector3(),
  );

  // The hairline is solved in `Rig.computeMetrics`, pinned to the *painted*
  // brow, and shared with the ear placement and the clearance solver. No
  // combination of roster values and no retune of the face layout can push hair
  // over the eyes — the one hair failure that destroys a character and that no
  // shading can hide.
  const { frontPhi, backPhi, peak } = m.hairline;

  hairShell(cap, {
    head: h,
    outer: shellOuter, inner: shellInner,
    // 34 × 15 rather than 30 × 13. The rim strip at the hairline is now a real
    // visible edge rather than a hairline crack, and a coarse ring around it
    // read as a faceted band — which at closeup is exactly the swim-cap seam the
    // review called out.
    frontPhi, backPhi, peak, segU: 34, segV: 15, swell: 0.05,
  });

  /**
   * One hair clump — ANIME_PIPELINE §3's "broad tapered form with a clear
   * point".
   *
   * The section is an eight-sided lens at 0.72 thickness rather than the ten
   * sides at 0.55 it was: fewer, larger planes so the crease pass leaves
   * genuinely visible facets, and a fatter cross-section so a clump is a
   * *chunk* rather than a blade. Thin, numerous locks are the strand look §3
   * rules out — they alias into fizz at battle distance and cost ten times the
   * triangles for a worse silhouette.
   *
   * The radius is driven to zero at the tip by the `1 - t^6` term. A lock that
   * ends at finite width is capped by a disc of geometry facing sideways, and
   * at closeup range that disc is a raw rectangular boundary on the strand.
   * Collapsing the final ring turns the end cap into degenerate triangles the
   * welder strips, leaving an actual point.
   */
  const lock = (from, ctrl, to, w0, w1, twist = 0) => {
    const path = smoothPath([from, ctrl, to], 9);
    sweep(detail, path, SECTIONS.lens(8, 0.72), (i) => {
      const t = i / (path.length - 1);
      const r = THREE.MathUtils.lerp(w0, w1, t * t) * (1 - Math.pow(t, 6));
      return [Math.max(r, 1e-5), Math.max(r * 0.85, 1e-5)];
    }, { capStart: true, capEnd: true, twist });
  };

  // --- front locks.
  //
  // Two rules keep a fringe from becoming a curtain over the face. First, the
  // locks are *parted*: `part` shifts the whole fan off centre so no lock hangs
  // down the middle of the nose. Second, length is short at the parting and
  // long at the temples — that taper is the entire difference between an anime
  // fringe and a mop, and it means the centre of the face stays clear while the
  // silhouette still gets its long angular corners.
  //
  // Lengths here are fractions of *head radius*, not of body height: a lock
  // measured against the body would swallow Emrys's face and barely reach
  // Yshara's brow.
  const nF = Math.min(hp.fringe | 0, 3);
  const partShift = hp.part ?? 0.14;
  const sweepAmt = hp.fringeSweep ?? 0.4;
  const lean = hp.lean ?? 0;
  // The protected column, widened by the clump's own half-thickness. A spine
  // held exactly at the brow still puts the *body* of a fat clump across the
  // eye, which is how a fringe that measured correctly on paper came back as a
  // blade through the iris; the floor has to account for the volume, not the
  // curve. Outside the column a lock may hang to the jaw, which is where a
  // fringe earns its silhouette corners.
  const guardX = m.face.guardX;
  const browFloor = Math.max(m.eye.browTop, m.face.guardTop) + h.ry * 0.02;
  /** Hold a control point clear of the eyes if it sits over them. */
  const guard = (p, w) => {
    if (Math.abs(p.x) < guardX + w) p.y = Math.max(p.y, browFloor + w);
    return p;
  };
  for (let i = 0; i < nF; i++) {
    const t = nF === 1 ? 0.5 : (i + 0.5) / nF;
    const off = (t - 0.5) + partShift;
    const ang = off * Math.PI * 0.95 * (hp.fringeSpread ?? 1);
    const sx = Math.sin(ang);
    const cz = Math.cos(ang);
    const taper = 0.45 + 1.35 * Math.min(1, Math.abs(off) * 2.2);
    const tipX = sx * h.rx * (1.06 + sweepAmt * 0.75) + lean * h.rx * 0.9;
    const top = h.center.y + h.ry * 0.34;
    const len = (hp.fringeLength ?? 0.26) * h.ry * 2.0 * taper;
    // Three fat clumps, not five thin ones. The review's read of the previous
    // fringe was "zero-thickness cards intersecting a low-poly sphere", and half
    // of that was count: narrow blades with bare forehead between them alias
    // into ribbons, where a small number of broad forms with real thickness
    // fuse into one carved mass (ANIME_PIPELINE §3, REFERENCE §1).
    const w = h.rx * 0.36 * (1 - Math.abs(off) * 0.22);
    // Anchored on the hair shell's outer wall, above the hairline, so the clump
    // emerges *from under* the shell rather than out of the forehead.
    const from = scalp(Math.atan2(cz, sx), frontPhi + 0.34);
    const ctrl = guard(new THREE.Vector3(
      sx * h.rx * (1.02 + sweepAmt * 0.30) + lean * h.rx * 0.4,
      h.center.y + h.ry * 0.30 - len * 0.35,
      cz * h.rz * (1.10 + sweepAmt * 0.25),
    ), w);
    const to = guard(new THREE.Vector3(
      tipX,
      top - len,
      cz * h.rz * (1.04 + sweepAmt * 0.55) - sweepAmt * len * 0.30,
    ), w * 0.35);
    lock(from, ctrl, to, w, w * 0.20, off * 0.7);
  }

  // --- style-specific mass.
  //
  // REFERENCE_TARGET §1 makes silhouette distinctiveness at 80 px a hard
  // requirement, and the review's flat-fill test found characters 1–3 collapsing
  // into one shape. The six branches below are therefore six *different mass
  // classes*, not six parameterisations of one:
  //
  //   swept   — a wedge pointing backwards off a hard side part   (widest at the nape)
  //   sheet   — a long straight curtain to mid-thigh              (widest overall, ~1.9 heads)
  //   beard   — almost nothing above the chin, a forked mass below it
  //   bob     — a wide flared bell cut on a diagonal              (widest at the jaw)
  //   spike   — a radial starburst                                 (widest at the crown)
  //   topknot — a tall bound column plus a trailing braid          (tallest, narrowest)
  //
  // Flatten any two to black and they do not collide, which is the test.
  //
  // **Every length below is a multiple of head diameter, never of body height.**
  // That is a correctness fix, not a convenience: Bramm's beard was authored at
  // 0.50 of *body* height, which on a head 0.28 of body height is three and a
  // half head-radii of mass whose top edge landed above his eyes. He is the
  // review's "blank cream oval with a single dot" — the beard was the face. A
  // hair volume is a function of the skull it grows on and nothing else.
  const D = h.ry * 2;
  if (style === 'spike') {
    const n = hp.spikes ?? 8;
    const spread = hp.spikeSpread ?? 1.1;
    for (let i = 0; i < n; i++) {
      // Deterministic jitter: the same character always gets the same hair.
      const j = rng.next();
      const ang = (i / n) * TAU + j * (hp.spikeJitter ?? 0.3);
      const pitch = 0.30 + rng.next() * 0.50;
      const len = (hp.spikeLength ?? 0.55) * D * (0.70 + rng.next() * 0.55);
      const base = scalp(ang, pitch);
      // Weighted outward rather than upward: a purely vertical starburst adds
      // head height (which the 3.0–3.5-heads metric charges for) and reads as a
      // crown of horns. Splaying it wide costs nothing in the ratio and gives a
      // genuinely unmistakable outline.
      const tip = base.clone().add(new THREE.Vector3(
        Math.cos(ang) * len * spread,
        len * 0.48,
        Math.sin(ang) * len * spread,
      ));
      const ctrl = base.clone().lerp(tip, 0.42).add(new THREE.Vector3(0, len * 0.14, 0));
      lock(base, ctrl, tip, D * 0.20, D * 0.008);
    }
  } else if (style === 'bob') {
    // A bell of hair, cut on a hard diagonal, flaring outward at the jaw. The
    // shell alone is a swim cap; the flare is what makes it a haircut, and the
    // asymmetric `lean` is Kite's "everything about her is diagonals".
    const lean = hp.lean ?? 0.3;
    const cut = hp.cutAngle ?? 0.4;
    const bl = (hp.backLength ?? 0.75) * D;
    const wide = hp.backWidth ?? 1.3;
    // `cz` pulls the bell a third of a head-depth back and `rz` no longer
    // exceeds the skull's, so the front of the bob sits behind the cheekbone
    // instead of closing over the face. A bob frames a face from the *sides*;
    // the side flares below are what does the framing.
    blob(mass, {
      cx: lean * h.rx * 0.16, cy: h.center.y - h.ry * 0.06 - bl * 0.28, cz: -h.rz * 0.34,
      rx: h.rx * wide, ry: bl * 0.62 + h.ry * 0.72, rz: h.rz * 0.92,
      eU: 1, eV: 0.88, segU: 22, segV: 14,
      // Widest just below the ear line, pinched at the crown so it sits under
      // the shell, and cut off square at the bottom for the blunt bob hem.
      profile: (v) => {
        const upper = THREE.MathUtils.clamp((v - 0.58) / 0.42, 0, 1);
        const lower = THREE.MathUtils.clamp((0.24 - v) / 0.24, 0, 1);
        return (1 - Math.pow(upper, 1.3) * 0.42) * (1 - Math.pow(lower, 1.8) * 0.30);
      },
    });
    // Two side flares kicking out past the jaw, longer on the lean side — the
    // 25%-width divergence this style owes the lineup.
    for (const sgn of [-1, 1]) {
      const bias = 1 + sgn * lean * cut;
      const from = scalp(sgn > 0 ? 0.0 : Math.PI, Math.asin(0.10));
      const tip = new THREE.Vector3(
        sgn * h.rx * (1.30 + cut * 0.55) * bias,
        h.center.y - h.ry * (0.70 + bias * 0.30),
        -h.rz * 0.30,
      );
      lock(from, from.clone().lerp(tip, 0.45).setY(h.center.y - h.ry * 0.22), tip,
        h.rx * 0.30, h.rx * 0.03);
    }
  } else if (style === 'sheet' || style === 'drift') {
    // "a pale drifting mass twice the width of her body" (WORLD_BIBLE §3.2).
    // Three overlapping *solids* rather than sheets — a flat card would vanish
    // edge-on in the side-view battle camera, which is the one angle the game
    // spends most of its running time in. Each layer is a squashed ellipsoid
    // whose lower half is pinched, so the stack silhouettes as a flame.
    const back = (hp.backLength ?? 1.5) * D;
    const wide = hp.backWidth ?? 1.8;
    const flare = hp.backFlare ?? 1.4;
    const layers = 3;
    for (let L = 0; L < layers; L++) {
      const lt = layers === 1 ? 0 : L / (layers - 1);
      const w = h.rx * wide * (0.62 + lt * 0.46);
      const drop = back * (0.55 + lt * 0.55);
      // Centred and sized so the stack's *top* lands well under the crown. The
      // previous placement pushed the top layer above the skull, which counts
      // straight against the head-to-height ratio while adding nothing to a
      // silhouette whose whole point is length below the shoulder.
      blob(mass, {
        cx: 0,
        cy: h.center.y - h.ry * 0.10 - drop * 0.55,
        cz: -h.rz * (0.45 + lt * 0.35),
        rx: w, ry: drop * 0.62 + h.ry * 0.45, rz: h.rz * (0.80 - lt * 0.14),
        // `eU` under 1 squares the horizontal cross-section off: the sheet has
        // to read as a *slab* with two flat faces and a hard side edge. At
        // eU = 1 it is an ellipsoid, and an ellipsoid as wide as it is tall
        // silhouettes as a balloon behind the head, not as hair.
        eU: 0.72, eV: 0.86, segU: 22, segV: 15,
        // Wide at the shoulder line, pinched at the hem: `flare` moves where
        // the widest point sits, which is the difference between "hair" and
        // "cape" at silhouette scale.
        profile: (v) => {
          const lower = THREE.MathUtils.clamp((0.46 - v) / 0.46, 0, 1);
          const upper = THREE.MathUtils.clamp((v - 0.62) / 0.38, 0, 1);
          return (1 + lower * (flare - 1) * 0.35) * (1 - Math.pow(upper, 1.4) * 0.30)
            * (1 - Math.pow(lower, 2.6) * 0.55);
        },
      });
    }
    // Two long forward locks framing the face — the classic oracle read, and
    // the thing that stops the back mass from looking like a hood.
    for (const sgn of [-1, 1]) {
      const from = scalp(sgn > 0 ? 0.28 : Math.PI - 0.28, Math.asin(0.30));
      const ctrl = new THREE.Vector3(sgn * h.rx * 1.16, h.center.y - h.ry * 0.45, h.rz * 0.36);
      const to = new THREE.Vector3(sgn * h.rx * 1.06, h.center.y - h.ry * 0.6 - back * 0.55, h.rz * 0.14);
      lock(from, ctrl, to, D * 0.19, D * 0.03);
    }
  } else if (style === 'beard') {
    // Measured in head diameters. At the old body-height scale this mass grew
    // to three and a half head-radii and its top edge closed over the eyes.
    const bl = (hp.beardLength ?? 0.95) * D;
    const bwd = (hp.beardWidth ?? 1.2);
    const fork = hp.beardFork ?? 0.25;
    // The whole beard hangs below the mouth line. Solved from the face metrics
    // rather than authored, so it cannot creep back up over the eye block.
    const chin = Math.min(m.face.guardBottom - h.ry * 0.04, h.center.y - h.ry * 0.52);
    for (const sgn of [-1, 1]) {
      // Anchored on the jaw *surface* — the beard grows off the face, so the
      // radius here is just clear of the skull, not the hair shell.
      const from = scalp(sgn > 0 ? 0.72 : Math.PI - 0.72, -0.40, 1.03);
      const ctrl = new THREE.Vector3(sgn * h.rx * 0.66 * bwd, chin - bl * 0.35, h.rz * 0.68);
      const to = new THREE.Vector3(sgn * h.rx * fork * 2.2, chin - bl, h.rz * 0.30);
      lock(from, ctrl, to, D * 0.20 * bwd, D * 0.045);
    }
    // Central mass filling between the forks, plus a moustache bar. Both sized
    // and placed against `chin`, so the top of the beard is a solved quantity.
    blob(mass, {
      cx: 0, cy: chin - bl * 0.42, cz: h.rz * 0.42,
      rx: h.rx * 0.66 * bwd, ry: bl * 0.50, rz: h.rz * 0.48,
      eU: 0.9, eV: 0.85, segU: 16, segV: 10,
      profile: (v) => 1 - Math.pow(THREE.MathUtils.clamp((0.5 - v) / 0.5, 0, 1), 1.4) * 0.55,
    });
    blob(mass, {
      cx: 0, cy: chin + h.ry * 0.10, cz: h.rz * 0.74,
      rx: h.rx * 0.48, ry: h.ry * 0.09, rz: h.rz * 0.22,
      eU: 0.8, eV: 0.8, segU: 14, segV: 6,
    });
  } else if (style === 'topknot' || style === 'braid') {
    // A bound column above the crown. Narrow and tall — the exact opposite of
    // the bob and the sheet, and the only party member whose mass is *above*
    // the skull rather than beside or behind it.
    const tk = (hp.topknot ?? 0.80) * D;
    const tw = hp.topknotWidth ?? 0.50;
    const bindY = h.center.y + h.ry * 0.80;
    // Raked backwards as it rises: the mass ends up behind the crown rather
    // than above it, which keeps the read ("a bound column") while spending
    // roughly half the head-height the same volume would cost stood upright.
    sweep(mass,
      [new THREE.Vector3(0, bindY - h.ry * 0.10, -h.rz * 0.10),
        new THREE.Vector3(0, bindY + tk * 0.52, -h.rz * 0.62),
        new THREE.Vector3(0, bindY + tk * 0.80, -h.rz * 1.55)],
      SECTIONS.circle(14),
      (i) => { const r = h.rx * tw * [0.86, 1.0, 0.30][i]; return [r, r * 0.94]; },
      { capStart: true, capEnd: true });
    // Binding cord. The one place the hair is allowed a second colour: it is a
    // *cord*, a small flat accent zone in the §5 sense, not a shading effect.
    sweep(cord,
      [new THREE.Vector3(0, bindY - h.ry * 0.06, -h.rz * 0.10),
        new THREE.Vector3(0, bindY + h.ry * 0.06, -h.rz * 0.12)],
      SECTIONS.circle(14),
      () => [h.rx * tw * 1.02, h.rz * tw * 1.02],
      { capStart: false, capEnd: false });
  }

  // --- back mass, shared by the styles that keep one. Skipped where the style
  // already owns the volume behind the skull, or the two would inter-penetrate.
  const OWNS_BACK = new Set(['sheet', 'drift', 'bob']);
  if ((hp.backLength ?? 0) > 0 && !OWNS_BACK.has(style)) {
    const bl = hp.backLength * D;
    // `backDepth` pushes the mass behind the skull rather than beside it, which
    // is how a swept style earns silhouette width in the *side-view* battle
    // camera without widening the head from the front. Front width and side
    // width are separate identity channels and the roster tunes them apart.
    const depth = hp.backDepth ?? 0.62;
    blob(mass, {
      cx: 0, cy: h.center.y - h.ry * 0.10 - bl * 0.35, cz: -h.rz * (0.24 + depth * 0.52),
      rx: h.rx * (hp.backWidth ?? 0.9) * 0.86, ry: bl * 0.72 + h.ry * 0.25, rz: h.rz * depth,
      eU: 1, eV: 0.88, segU: 18, segV: 12,
      profile: (v) => 1 - Math.pow(THREE.MathUtils.clamp((0.45 - v) / 0.45, 0, 1), 1.5) * 0.45,
    });
  }

  // ---- the two invariants -------------------------------------------------
  //
  // Applied here, once, on finished surfaces, rather than defended inside each
  // of the six style branches. Locks are only held out of the head — a lock is
  // *supposed* to hang in front of the forehead. Masses are held out of the head
  // and out of the eye block, because a mass in front of the eyes is a character
  // with no face, which is what shipped.
  clearSkull(detail, m, shellOuter);
  clearSkull(mass, m, shellOuter);
  clearFace(mass, m);
  clearSkull(cord, m, shellOuter);

  // `crease: 0.65` rather than 0.9: the clump section is an octagon, so its
  // facets meet at ~45° (0.785 rad). At 0.9 every one of them was smoothed away
  // and the clumps rendered as soft tubes; below the facet angle they stay hard,
  // which is what makes the hair read as carved (§3).
  if (!cap.empty) parts.push({ surface: cap, cls: 'hair', bind: ['neck', 'head'], painted: true });
  if (!detail.empty) parts.push({ surface: detail, cls: 'hair', bind: ['neck', 'head'], crease: 0.65, painted: true });
  // The style mass keeps a softer crease than the clumps: it is one large form
  // and hard facets across it read as a low-poly artefact rather than as carving.
  if (!mass.empty) parts.push({ surface: mass, cls: 'hair', bind: ['neck', 'head'], crease: 1.05, painted: true });
  if (!cord.empty) parts.push({ surface: cord, cls: 'hair', bind: ['head'], crease: 0.9, painted: true });
}

/**
 * The braid / drift tail that the cloth solver drives.
 *
 * Built along the bind-pose hair chain and skinned to `hair0..n` so the verlet
 * strand's bone rotations carry it. Segment radii pulse so a braid reads as
 * plaited rather than as a rope; a plain taper looks like a tail.
 */
function buildHairChain(parts, m, def, pal, rig) {
  const chain = m.chains.hair;
  if (chain.length < 2) return;
  const hp = def.hair ?? {};
  const H = m.height;
  const s = new Surface();
  const pts = chain.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const path = smoothPath(pts, Math.max(10, chain.length * 3));
  const w0 = (hp.braidWidth ?? hp.backWidth ?? 0.9) * m.head.rx * 0.55;
  const segs = hp.braidSegments ?? 0;
  sweep(s, path, SECTIONS.circle(12), (i) => {
    const t = i / (path.length - 1);
    const taper = 1 - Math.pow(t, 1.7) * 0.72;
    const plait = segs > 0 ? 1 + Math.sin(t * Math.PI * segs * 2) * 0.16 : 1;
    const r = w0 * taper * plait;
    return [r, r * 0.9];
  }, { capStart: true, capEnd: true });

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
    const top = new THREE.Vector3(0, y + g.neck * 1.4 * tall, -g.neck * 0.35 * tall);
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
      for (let i = 0; i < n; i++) {
        const a = Math.PI * (0.18 + (i / (n - 1)) * 1.64);
        const base = new THREE.Vector3(Math.sin(a) * g.chestX * 0.95, m.joints.chest.y + g.chestZ * 0.5, Math.cos(a) * g.chestZ * 0.95);
        const tip = base.clone().add(new THREE.Vector3(Math.sin(a) * fl * 0.45, fl, Math.cos(a) * fl * 0.45));
        sweep(cloth, [base, tip], SECTIONS.lens(8, 0.4),
          (i2) => { const s = H * (i2 === 0 ? 0.022 : 0.004); return [s, s * 0.7]; },
          { capStart: false, capEnd: true });
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
    sweep(leather, path, SECTIONS.square(8, 0.5), () => [H * 0.013, H * 0.020], { capStart: false, capEnd: false });
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
        sweep(glow, smoothPath([p0, p0.clone().lerp(p1, 0.5), p1], 6), SECTIONS.circle(5),
          () => [H * 0.0035, H * 0.0035], { capStart: false, capEnd: false });
      }
    }
  }

  // Collar, sleeve rolls and feather fringe are all *trim*: small, bright, and
  // adjacent to the face or the hands, which is where §5 wants the party's
  // highest-contrast colour so the eye has somewhere to land at battle range.
  if (!cloth.empty) parts.push({ surface: cloth, cls: 'cloth', color: pal.trim, bind: 'body' });
  if (!leather.empty) parts.push({ surface: leather, cls: 'cloth', color: pal.leather, bind: 'body', crease: 0.8 });
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
  const torso = new Surface();
  buildTorso(torso, metrics, pal);
  parts.push({ surface: torso, cls: 'cloth', bind: ['hips', 'spine', 'chest', 'neck'], painted: true });

  const skin = new Surface();
  buildNeck(skin, metrics);
  buildHead(skin, metrics);
  parts.push({ surface: skin, cls: 'skin', color: pal.skin, bind: ['neck', 'head', 'chest'] });

  for (const side of [1, -1]) {
    const sfx = side > 0 ? 'L' : 'R';
    const g = metrics.girth;
    const arm = new Surface();
    const bare = def.accessories?.bareShoulder === sfx || def.accessories?.prosthetic === sfx;
    buildLimb(
      arm,
      new THREE.Vector3(metrics.joints[`shoulder${sfx}`].x, metrics.joints[`shoulder${sfx}`].y, 0),
      new THREE.Vector3(metrics.joints[`forearm${sfx}`].x, metrics.joints[`forearm${sfx}`].y, 0),
      new THREE.Vector3(metrics.joints[`hand${sfx}`].x, metrics.joints[`hand${sfx}`].y, 0),
      g.arm * 1.10, g.elbow, g.wrist, 12,
    );
    parts.push({
      surface: arm,
      cls: bare ? 'skin' : 'cloth',
      color: bare ? pal.skin : pal.identity,
      bind: [`shoulder${sfx}`, `arm${sfx}`, `forearm${sfx}`, `hand${sfx}`],
    });

    const hand = new Surface();
    buildHand(hand, metrics, side);
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
      buildCuff(cuff, metrics, side);
      parts.push({
        surface: cuff, cls: 'cloth', color: pal.trim, crease: 0.9,
        bind: [`forearm${sfx}`, `hand${sfx}`],
      });
    }

    const leg = new Surface();
    buildLimb(
      leg,
      new THREE.Vector3(metrics.joints[`thigh${sfx}`].x, metrics.joints[`thigh${sfx}`].y, 0),
      new THREE.Vector3(metrics.joints[`shin${sfx}`].x, metrics.joints[`shin${sfx}`].y, 0),
      new THREE.Vector3(metrics.joints[`foot${sfx}`].x, metrics.joints[`foot${sfx}`].y, 0),
      g.thigh * 1.06, g.knee, g.ankle, 12,
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
      parts.push({ surface: boot, cls: 'skin', color: pal.skin, bind: [`shin${sfx}`, `foot${sfx}`], crease: 1.0 });
    } else {
      buildBoot(boot, metrics, side, H * 0.045, { body: pal.leather, cuff: pal.trim });
      parts.push({ surface: boot, cls: 'cloth', bind: [`shin${sfx}`, `foot${sfx}`], crease: 0.9, painted: true });
    }
  }

  buildHair(parts, metrics, def, pal);
  if (metrics.chains.hair.length > 1) buildHairChain(parts, metrics, def, pal, rig);
  buildWeapon(parts, metrics, def, pal, rig);
  buildAccessories(parts, metrics, def, pal);

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
    const geo = part.surface.finish(part.crease ?? 0);

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
      map: buildFaceTexture(def, { expression, size: 1024 }),
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
      if (hull) outlines.push(hull);
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
      materials.face.map = buildFaceTexture(def, { expression: name });
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
      cols: 8,
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
        width: g.hipX * TAU * 1.10,
        length: cape.skirt.length * H,
        flare: cape.skirt.flare ?? 1.7,
        curve: TAU * 1.03,
        hem: 'hemline',
        offsetY: g.hipX * 0.30,
        offsetZ: 0,
        stiffness: cape.skirt.stiffness ?? 0.24,
        drag: cape.skirt.drag ?? 0.05,
        mass: 0.8,
        cols: 16,
        rows: 9,
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
 *  - `heads-tall` — REFERENCE_TARGET §1's 3.0–3.5 band, measured against the
 *    silhouette head mass (skull plus hair) rather than the skull alone,
 *    because that is what a critic measures.
 *
 * @param {object|string} defOrId roster entry or id
 * @returns {{id: string, headsTall: number, faceUvSpan: number,
 *            faceNormalDeg: number, hairMinDepth: number,
 *            hairFaceIntrusion: number, issues: string[]}}
 */
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

  // ---- hair ---------------------------------------------------------------
  const parts = [];
  buildHair(parts, m, def, pal);
  let hairMinDepth = Infinity;
  let hairFaceIntrusion = -Infinity;
  let deepestAt = '';
  let crown = m.head.crownY;
  let hairWidth = m.head.rx * 2;
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
  // A shell wall sits at 1.045 and the clearance solver holds clumps above it;
  // 1.02 is the tolerance for the radial metric ignoring `profile()`'s swell.
  if (hairMinDepth < 1.02) {
    issues.push(`hair-in-skull: min depth ${hairMinDepth.toFixed(3)} — ${deepestAt}`);
  }
  if (hairFaceIntrusion > 0) {
    issues.push(`hair-over-eyes: ${(hairFaceIntrusion / m.head.ry).toFixed(3)} ry in front of the plate`);
  }

  // ---- proportion ---------------------------------------------------------
  const headMass = crown - m.head.chinY;
  const headsTall = m.height / headMass;
  if (headsTall < 3.0 || headsTall > 3.5) {
    issues.push(`heads-tall: ${headsTall.toFixed(2)} outside REFERENCE §1's 3.0–3.5`);
  }

  return {
    id: def.id,
    headsTall,
    headMassWidth: hairWidth / m.head.ry,
    faceUvSpan,
    faceNormalDeg,
    hairMinDepth,
    hairFaceIntrusion: hairFaceIntrusion / m.head.ry,
    issues,
  };
}

/** {@link auditCharacter} across the whole roster. */
export function auditRoster(defs = ROSTER) {
  return defs.map((d) => auditCharacter(d));
}

export default buildCharacter;
