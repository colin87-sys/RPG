/**
 * CharacterFactory.js — procedural chibi character construction.
 *
 * Everything on screen for the entire game is built here, in code, from the
 * numbers in `roster.js` and the skeleton in `Rig.js`. No meshes are loaded;
 * there is nothing to load.
 *
 * ## The one thing this file exists to get right
 *
 * REFERENCE_TARGET §1: the party occupies about **80 px of screen height** in
 * the fixed side-view battle camera. At that size a face is four pixels and a
 * costume seam is invisible. What survives is the outline. So the whole
 * architecture below is organised around silhouette:
 *
 * - Six characters, six *different* hair volumes, six *different* weapon
 *   outlines, six *different* cloth hems. Those three channels carry all
 *   recognition; everything else is texture for the closeup camera.
 * - Bramm's mass is below the chin (beard) where everyone else's is above it.
 *   Kite carries a hard ring on her back. Yshara carries a horizontal bar.
 *   Seren's hair is twice her shoulder width. Emrys is a bell of coat with a
 *   starburst on top. Auren is a vertical line broken at the hip. Flatten any
 *   two of those to black and they do not collide.
 * - Eyes are the single most expensive facial investment because they are the
 *   only facial feature that reads at all: a dark outline, a bright sclera, a
 *   saturated iris, a dark pupil and an unlit specular catch-light, layered on
 *   the head's actual curvature rather than pasted on flat.
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
import { buildRig, computeMetrics, skinSegments } from './Rig.js';
import { Animator } from './Animation.js';
import { ClothSim } from './Cloth.js';
import { characterDef } from './roster.js';
import {
  createToonMaterial, createToonOutline, createToonOutlineMaterial, disposeToonOutline,
  updateToonUniforms,
} from '../render/ToonMaterial.js';

const TAU = Math.PI * 2;

/** Shading classes. One `SkinnedMesh` and one material per class per character. */
const CLASSES = ['skin', 'hair', 'cloth', 'metal', 'eye', 'glow'];

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
    this._r = 1; this._g = 1; this._b = 1;
    this._scratch = new THREE.Color();
  }

  /** Set the colour subsequent vertices carry. `hex` is sRGB; stored linear. */
  ink(hex, scale = 1) {
    const c = hex instanceof THREE.Color ? this._scratch.copy(hex) : this._scratch.set(hex);
    this._r = c.r * scale; this._g = c.g * scale; this._b = c.b * scale;
    return this;
  }

  vertex(x, y, z) {
    this.pos.push(x, y, z);
    this.col.push(this._r, this._g, this._b);
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
 * Triplanar-ish planar UVs derived from position.
 *
 * Characters carry only detail normal maps (weave, pore, grind lines), never
 * authored colour maps, so the UVs need to be continuous and roughly
 * area-preserving, not laid out. Projecting on the dominant normal axis costs
 * one branch per vertex and never produces the smeared bands a single planar
 * projection leaves on a cylinder.
 */
function planarUV(geometry, scale) {
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u, v;
    if (ny >= nx && ny >= nz) { u = x; v = z; }
    else if (nx >= nz) { u = z; v = y; }
    else { u = x; v = y; }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * ART_BIBLE §4's "albedo value (linear)" column, enforced rather than trusted.
 *
 * The bible states a linear luminance band per surface class, and a palette
 * authored by eye in sRGB routinely lands outside it — `#EAE2D4` (Seren's robe,
 * WORLD_BIBLE §3.2) is luminance 0.76 against cloth's 0.20–0.55 ceiling. On a
 * toon surface with no environment reflection to absorb the error that shows up
 * as the single brightest object in frame being a rectangle of cloth, which
 * inverts the value hierarchy and pulls the eye off the face. Rescaling
 * luminance while leaving chromaticity alone keeps every WORLD_BIBLE hue exactly
 * as authored and only moves the level.
 *
 * `eye` and `glow` are deliberately unbanded: the eye's read *is* its contrast
 * ratio (near-black lash against near-white sclera) and clamping either end
 * would destroy the one facial feature that survives to battle distance.
 */
const ALBEDO_BAND = Object.freeze({
  skin: [0.30, 0.52],
  hair: [0.05, 0.44],
  cloth: [0.12, 0.46],
  metal: [0.28, 0.60],
  eye: null,
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
 * This module only chooses a preset per shading class and hands over the
 * per-character detail maps; every numeric look decision belongs to that file.
 *
 * `vertexColors` is on for every class, because a character is authored as one
 * geometry per *shading class* rather than one per colour. Auren's slate coat,
 * his amber trim and his dark undercoat are all `cloth`: same shading, three
 * colours, one draw call.
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
 * Unlit emissive for catch-lights, tattoo lines and chime-bells.
 *
 * Deliberately *not* a toon material: these surfaces must not take a shadow
 * band. A catch-light that goes dark on the shadow side of the face stops being
 * a catch-light, and ART_BIBLE §2.2 reserves supra-1.0 emissive for magic — so
 * this sits at exactly 1.0 and lets the bloom threshold decide.
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

/** Safe texture fetch — the forge is optional and may not have warmed a key. */
function tex(forge, key, opts) {
  if (!forge?.texture) return null;
  try {
    return forge.texture(key, opts);
  } catch (err) {
    console.warn(`[CharacterFactory] texture "${key}" unavailable`, err);
    return null;
  }
}

// ============================================================ body builders

/**
 * Torso: one continuous lathed mass from hip to neck.
 *
 * The radius profile is the character's read from the front — Bramm's widest
 * ring is at the belt, Auren's at the chest, Seren's barely varies. Ring 0 is
 * placed *below* the hip joint so the pelvis has volume under the belt line;
 * without it a chibi torso looks like it is standing on two sticks.
 */
function buildTorso(s, m) {
  const g = m.girth;
  const hipY = m.joints.hips.y;
  const neckY = m.joints.neck.y;
  const span = neckY - hipY;

  // [t along hips→neck, xScale, zScale, zOffset]
  // The waist pinch is deeper than it was (0.78 against 0.86 at t = 0.34). A
  // 14% variation across the trunk is invisible once the figure is eighty pixels
  // tall, which is how four of the six ended up reading as "the same navy
  // lozenge" — the torso had no shape to distinguish. 22% survives the downscale
  // and is still well inside chibi proportions, where the trunk is one soft mass
  // rather than an anatomy study.
  const profile = [
    [-0.30, 0.88, 0.88, -0.004],
    [-0.12, 1.02, 1.02, -0.002],
    [0.10, 0.94, 0.92, 0.000],
    [0.34, 0.78, 0.80, 0.004],
    [0.58, 0.92, 0.90, 0.008],
    [0.80, 1.04, 1.02, 0.006],
    [0.95, 0.88, 0.86, 0.002],
    [1.06, 0.52, 0.52, 0.000],
  ];
  const path = [];
  const scales = [];
  for (const [t, sx, sz, dz] of profile) {
    path.push(new THREE.Vector3(0, hipY + span * t, dz * m.height));
    // Below the waist the hip girth dominates, above it the chest does; the
    // crossover is at t = 0.34, which is where a chibi's "waist" reads.
    const k = THREE.MathUtils.clamp((t - 0.10) / 0.45, 0, 1);
    const rx = THREE.MathUtils.lerp(g.hipX, g.chestX, k) * sx;
    const rz = THREE.MathUtils.lerp(g.hipZ, g.chestZ, k) * sz;
    scales.push([rx, rz]);
  }
  sweep(s, path, SECTIONS.square(22, 0.86), (i) => scales[i], { capStart: true, capEnd: true });
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
  // Ears: two flat nubs. Four hundred triangles that stop the head silhouette
  // from being a perfect circle, which is worth more than it sounds at 80 px.
  for (const side of [1, -1]) {
    blob(s, {
      cx: side * h.rx * 0.94, cy: h.center.y - h.ry * 0.08, cz: -h.rz * 0.06,
      rx: h.rx * 0.16, ry: h.ry * 0.24, rz: h.rz * 0.10,
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
function buildBoot(s, m, side, cuffHeight = 0.0) {
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

/**
 * A point on the skull, in the same parameterisation `blob` uses to build it.
 *
 * `theta` is the azimuth (+Z, the face direction, is θ = π/2) and `phi` the
 * latitude in [-π/2, π/2]. Kept identical to `blob`'s inner loop on purpose —
 * this is the shared definition the face projector and the mesh both read.
 */
function headPoint(h, theta, phi, out = new THREE.Vector3()) {
  const pw = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
  const sc = h.profile(phi / Math.PI + 0.5);
  const cr = pw(Math.cos(phi), h.eV) * sc;
  return out.set(
    h.rx * cr * Math.cos(theta),
    h.center.y + h.ry * pw(Math.sin(phi), h.eV),
    h.rz * cr * Math.sin(theta),
  );
}

/**
 * Project a face-plane offset onto the *actual* skull surface, pushed out along
 * the true surface normal by `lift`.
 *
 * ### Why this is not the ellipsoid formula it replaces
 *
 * The head is built by `blob` as a superellipsoid (`eV = 0.94`) carrying a jaw
 * and cranium profile. Treating it as a plain ellipsoid here — which is what
 * this function used to do — puts the projected point up to 0.5% of a radius
 * *inside* the mesh at the eye latitude and around 1.2 mm inside at the outer
 * canthus, against a decal stand-off of about the same magnitude. The result is
 * that parts of every eye layer are swallowed by the skull and parts survive:
 * the eye renders as a partial ring with no iris, which is exactly the "single
 * grey torus, no second eye" the review reports. There is no lift value that
 * fixes it, because the error varies across the eye.
 *
 * Solving in the mesh's own parameterisation removes the error entirely rather
 * than hiding it. Given the target `(x, y)` on the face plane:
 *   `y` fixes `phi` by inverting the superellipse's vertical term,
 *   `phi` gives the cross-section scale `cr`,
 *   `x` then fixes `theta` on that cross-section, and `z` falls out.
 * The normal comes from the cross product of the two parametric tangents, taken
 * by central difference — analytic derivatives of a profiled superellipsoid are
 * long, error-prone, and no more accurate at this step size.
 */
const _fpA = new THREE.Vector3();
const _fpB = new THREE.Vector3();
const _fpC = new THREE.Vector3();
const _fpD = new THREE.Vector3();
const _fpU = new THREE.Vector3();
const _fpV = new THREE.Vector3();

function faceProject(m, dx, dy, lift) {
  const h = m.head;
  // Invert y = ry * sign(sin phi) * |sin phi|^eV.
  const ny = THREE.MathUtils.clamp(dy / h.ry, -0.999, 0.999);
  const sinPhi = Math.sign(ny) * Math.pow(Math.abs(ny), 1 / h.eV);
  const phi = Math.asin(THREE.MathUtils.clamp(sinPhi, -1, 1));

  const pw = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
  const cr = pw(Math.cos(phi), h.eV) * h.profile(phi / Math.PI + 0.5);
  // cos(theta) is the fraction of this cross-section's half-width the feature
  // sits at; clamping is what keeps a wide brow that runs off the cheek from
  // producing a NaN rather than sliding round to the temple.
  const ct = THREE.MathUtils.clamp(dx / (h.rx * Math.max(cr, 1e-4)), -0.999, 0.999);
  const theta = Math.acos(ct); // in [0, π]; sin(theta) ≥ 0, i.e. the +Z face side.

  const p = headPoint(h, theta, phi, _fpA);
  const eps = 1e-3;
  _fpU.subVectors(headPoint(h, theta + eps, phi, _fpB), headPoint(h, theta - eps, phi, _fpC));
  _fpV.subVectors(headPoint(h, theta, phi + eps, _fpB), headPoint(h, theta, phi - eps, _fpD));
  const n = new THREE.Vector3().crossVectors(_fpV, _fpU);
  if (n.lengthSq() < 1e-12) n.set(0, 0, 1); else n.normalize();
  if (n.z < 0) n.negate();
  return n.multiplyScalar(lift).add(p);
}

/**
 * A filled face decal shaped by a superellipse outline, wrapped on the skull.
 *
 * `tilt` rakes the outer canthus up or down — that single angle is the whole
 * difference between Auren's level stare and Seren's open one, and it survives
 * downscaling better than any amount of internal eye detail.
 */
function faceDisc(s, m, { cx, cy, rx, ry, lift, n = 2.4, tilt = 0, rings = 4, seg = 20, side = 1 }) {
  const pw = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
  const grid = s.patch(rings, seg, true, (i, j) => {
    const r = i / rings;
    const a = (j / seg) * TAU;
    const ox = pw(Math.cos(a), 2 / n) * rx * r;
    const oy = pw(Math.sin(a), 2 / n) * ry * r;
    const ct = Math.cos(tilt * side), st = Math.sin(tilt * side);
    const rxo = ox * ct - oy * st;
    const ryo = ox * st + oy * ct;
    return faceProject(m, cx + rxo, cy + ryo, lift);
  });
  // Ring 0 collapses to the centre point, so the disc is already closed; a fan
  // cap here would only add degenerate triangles for the welder to strip.
  return grid;
}

/**
 * The face, built as five explicitly-coloured decal layers per eye.
 *
 * REFERENCE_TARGET §1: "very large, high-contrast eyes [...] simple bright iris
 * + dark outline + a specular catch-light", and "the face reads on eyes and
 * brows alone". That is a specification with five parts and it is built here as
 * five parts, in this order outward from the skull:
 *
 *   1. **outline lozenge** — `pal.lash`, near-black. The dark boundary is what
 *      makes the eye survive being scaled to six pixels; without it the sclera
 *      is just a lighter patch of face.
 *   2. **sclera** — inset to 80%, so layer 1 survives as a ring of even weight
 *      all the way round rather than as a lash line on one edge only.
 *   3. **iris** — 55% of the lozenge height, in the character's *element*
 *      accent, which is the cheapest possible way to make six characters
 *      distinguishable at closeup range: six different saturated hues.
 *   4. **pupil** — half the iris, back to `pal.lash`.
 *   5. **catch-light** — 10% of the lozenge height, offset up-and-outward, and
 *      the only unlit surface on the character. A catch-light that takes a
 *      shadow band stops being a catch-light.
 *
 * Layers 3–5 go into separate surfaces because the animator drives them as a
 * rigid group on the head bone (eyes lead the head in a gaze shift); 1, 2 and
 * the brow are skinned with the rest of the face.
 *
 * @returns {{face: Surface, iris: Surface, catch: Surface, lid: Surface}}
 */
function buildFace(m, pal) {
  const e = m.eye;
  const h = m.head;
  const face = new Surface();
  const iris = new Surface();
  const glint = new Surface();
  const lid = new Surface();

  const L = e.lift;
  const G = e.layerGap;
  const halfW = e.width * 0.5;
  const halfH = e.height * 0.5;
  const irisR = e.height * 0.275;          // "55% of the lozenge height"
  const pupilR = irisR * 0.50;
  const glintR = e.height * 0.05;          // "~10%"

  for (const side of [1, -1]) {
    const cx = side * e.halfSpan;
    const cy = e.y - h.center.y;

    // 1 — outline lozenge. `n = 2.7` squares the superellipse off just enough
    // to give the eye a flat top edge, which is what reads as a lid.
    face.ink(pal.lash);
    faceDisc(face, m, { cx, cy, rx: halfW, ry: halfH, lift: L, n: 2.7, tilt: 0.10, side, rings: 3, seg: 22 });

    // 2 — sclera.
    face.ink(pal.sclera);
    faceDisc(face, m, {
      cx, cy, rx: halfW * 0.80, ry: halfH * 0.80,
      lift: L + G, n: 2.7, tilt: 0.10, side, rings: 3, seg: 22,
    });

    // 3/4 — iris and pupil, dropped slightly below the eye's centre so a sliver
    // of sclera shows above: a pupil centred in the aperture reads as a stare.
    const iy = cy - halfH * 0.10;
    iris.ink(pal.eye);
    faceDisc(iris, m, { cx, cy: iy, rx: irisR, ry: irisR, lift: L + 2 * G, n: 2.0, side, rings: 3, seg: 18 });
    iris.ink(pal.lash);
    faceDisc(iris, m, { cx, cy: iy, rx: pupilR, ry: pupilR, lift: L + 3 * G, n: 2.0, side, rings: 2, seg: 14 });

    // 5 — catch-light, offset toward the temple and up. Offsetting it *outward*
    // rather than inward is what makes both eyes read as catching the same
    // light source instead of as two independent decals.
    glint.ink(0xffffff);
    faceDisc(glint, m, {
      cx: cx + side * irisR * 0.42, cy: iy + irisR * 0.44,
      rx: glintR, ry: glintR, lift: L + 4 * G, n: 2.0, side, rings: 2, seg: 12,
    });

    // Brow — a short dark bar. `browAngle` sets the whole expression, and at
    // 80 px it and the eye block are the entire face.
    face.ink(pal.hairShade);
    faceDisc(face, m, {
      cx: cx * 1.02, cy: cy + e.browLift, rx: halfW * 0.92, ry: e.browThickness * 0.5,
      lift: L + G * 0.5, n: 3.0, tilt: e.browAngle, side, rings: 2, seg: 14,
    });

    // Blink lid. Parked just above the eye and slid down by exactly the eye's
    // height plus its clearance; it carries the largest lift of any face layer
    // because it must occlude the iris *and* the catch-light or a blink reads
    // as a glitch.
    lid.ink(pal.skin);
    faceDisc(lid, m, {
      cx, cy: cy + e.height * 1.16, rx: halfW * 1.14, ry: halfH * 1.30,
      lift: L + 5 * G, n: 2.7, tilt: 0.10, side, rings: 3, seg: 18,
    });
  }

  // Mouth — deliberately tiny. REFERENCE §1: "nose/mouth minimal or absent".
  face.ink(pal.skinShade);
  faceDisc(face, m, {
    cx: 0, cy: -h.ry * 0.50, rx: e.width * 0.28, ry: e.height * 0.075,
    lift: L, n: 2.2, tilt: 0, side: 1, rings: 2, seg: 14,
  });

  return { face, iris, catch: glint, lid };
}

// ================================================================== hair

/**
 * The hairline, as a function of azimuth.
 *
 * This is the single most important function in the hair builder. A revolved
 * shell over the skull covers the *face*, so the shell's lower boundary has to
 * ride high across the forehead and drop away at the nape — exactly like a real
 * hairline. Getting this wrong does not look like a hair bug; it looks like the
 * character has no face at all.
 *
 * `theta` follows `blob`'s convention: +Z (forward) is θ = π/2, so
 * `sin(theta)` is +1 at the face and −1 at the nape.
 *
 * @param {number} frontPhi latitude of the hairline across the forehead, derived
 *        from the brow position so it can never cross the eyes
 * @param {number} backPhi latitude at the nape
 * @param {number} peak widow's-peak dip at the centre front, radians
 */
function hairlinePhi(theta, frontPhi, backPhi, peak) {
  const f = Math.sin(theta);
  const t = (f + 1) * 0.5;
  // Cubic in `t` so the transition happens over the temples rather than being
  // spread evenly around the head — a linear blend puts the hairline halfway
  // down the cheek at the ears, which reads as a swim cap.
  const k = t * t * (3 - 2 * t);
  const base = backPhi + (frontPhi - backPhi) * k;
  return base - peak * Math.max(0, f) ** 3;
}

/**
 * A closed hair shell: outer surface, inner surface, and a rim strip joining
 * them at the hairline.
 *
 * Two surfaces rather than one because an open shell shows its backfaces at
 * every edge, and because the visible thickness at the hairline is what makes
 * hair read as *carved volume* (REFERENCE_TARGET §1) instead of as paint.
 */
function hairShell(s, { center, rx, ry, rz, outer, inner, frontPhi, backPhi, peak, segU = 26, segV = 14, swell = 0.06 }) {
  const ringOuter = [];
  const ringInner = [];
  const build = (scale, ring) => {
    const grid = s.patch(segV, segU, true, (i, j) => {
      const theta = (j / segU) * TAU;
      const lo = hairlinePhi(theta, frontPhi, backPhi, peak);
      const phi = lo + (Math.PI * 0.5 - lo) * (i / segV);
      // The crown swells slightly: hair has bulk on top and is flat at the
      // temples, and that asymmetry is most of what separates a hairstyle from
      // a helmet at silhouette scale.
      const bulk = scale * (1 + swell * Math.pow(Math.max(0, Math.sin(phi)), 2));
      const cp = Math.cos(phi);
      return {
        x: center.x + rx * bulk * cp * Math.cos(theta),
        y: center.y + ry * bulk * Math.sin(phi),
        z: center.z + rz * bulk * cp * Math.sin(theta),
      };
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
 * Hair is built as a *carved volume*, never as strands.
 *
 * REFERENCE §1: "large, sculpted, bold single-silhouette shapes — not strands.
 * Reads as carved volume with a glossy highlight band." So every style below
 * is a skull-hugging cap, a small number of large swept locks, and one band of
 * geometry proud of the cap in the highlight colour. Thin strands would
 * dissolve into aliasing at battle distance and cost ten times the triangles.
 */
function buildHair(parts, m, def, pal) {
  const hp = def.hair ?? {};
  const h = m.head;
  const H = m.height;
  const style = hp.style ?? 'swept';

  const cap = new Surface();
  const detail = new Surface();
  const band = new Surface();

  const capScale = hp.capScale ?? 1.08;
  const drop = hp.capDrop ?? 0.5;

  /**
   * A point on the hair shell, in the same frame the shell is built in.
   *
   * Every lock, spike and tail below anchors through this rather than through a
   * hand-written fraction of the head radius. The previous code anchored front
   * locks at `0.80 × rx`, which is *inside the skull* — so the lock's first
   * segment started buried in the head and surfaced through the temple, giving
   * the "dark ribbon of hair driven straight through the skull" and the loose
   * blade "jutting past the head like a chopstick". Anchoring at 0.98 of the
   * shell puts the origin outside the skull and just under the hair surface,
   * which hides the join and makes the intersection impossible by construction.
   */
  const scalp = (theta, phi, scale = capScale * 0.98) => new THREE.Vector3(
    h.rx * scale * Math.cos(phi) * Math.cos(theta),
    h.center.y + h.ry * scale * Math.sin(phi),
    h.rz * scale * Math.cos(phi) * Math.sin(theta),
  );

  // The hairline is pinned to the brow, not authored: the forehead boundary is
  // derived from `metrics.eye`, so no combination of roster values can push
  // hair down over the eyes — the one hair failure that destroys a character.
  // Clearance above the brow is 0.07 of a head radius, not 0.16. The larger
  // value left a band of bare forehead between the shell and the brow that the
  // fringe locks then hung across, so the hair read as a receding hairline with
  // loose ribbons over it instead of as one mass — half of what made the head
  // look like an untextured blockout. This is still a hard floor: the hairline
  // is derived from `metrics.eye`, so no roster value can push hair over the
  // eyes, which is the failure the pinning exists to prevent.
  const frontPhi = Math.asin(THREE.MathUtils.clamp(
    (m.eye.y + m.eye.browLift + m.eye.browThickness * 0.5 + h.ry * 0.07 - h.center.y) / h.ry,
    -0.98, 0.98,
  ));
  const backPhi = -(0.32 + drop * 0.95);
  const peak = h.ry > 0 ? 0.10 : 0;
  const center = { x: 0, y: h.center.y, z: -h.rz * 0.02 };

  // `inner` sits closer to the skull than before (1.005 rather than 1.02) so the
  // rim strip at the hairline is the shell's *full* thickness. That visible
  // edge is what turns the boundary from "a tan plate meeting a cream plate
  // across the temple" — a flat seam with no depth, which is how the review read
  // it — into a carved hair volume overhanging a forehead, which is what
  // REFERENCE §1 asks for. Swell is held at 0.04 so the shell contributes under
  // 3% of head height and the 3.0–3.5-heads metric survives the hairstyle.
  hairShell(cap, {
    center, rx: h.rx, ry: h.ry, rz: h.rz,
    outer: capScale, inner: 1.005,
    frontPhi, backPhi, peak, segU: 30, segV: 13, swell: 0.04,
  });

  // --- the highlight band: a strip riding the shell a hair's breadth proud of
  // it, in the light hair tone. The reference's single most identifiable hair
  // cue, and it costs about 250 triangles. Columns whose hairline sits above
  // the band are skipped, so the band can never float in front of the face.
  const bandLo = Math.PI * 0.5 * ((hp.highlightBand ?? 0.6) - (hp.highlightWidth ?? 0.13) * 0.5) * 2 - Math.PI * 0.25;
  const bandHi = bandLo + Math.PI * (hp.highlightWidth ?? 0.13);
  const lift = 1 + H * 0.004 / Math.max(1e-4, h.ry);
  {
    const segU = 26;
    const prev = [];
    for (let j = 0; j <= segU; j++) {
      const theta = ((j % segU) / segU) * TAU;
      const line = hairlinePhi(theta, frontPhi, backPhi, peak);
      const lo = Math.max(bandLo, line);
      const hi = Math.max(bandHi, line + 1e-4);
      if (hi <= line + 2e-4) { prev.length = 0; continue; }
      const pt = (phi) => {
        const sc = capScale * lift * (1 + 0.06 * Math.pow(Math.max(0, Math.sin(phi)), 2));
        const cp = Math.cos(phi);
        return band.vertex(
          center.x + h.rx * sc * cp * Math.cos(theta),
          center.y + h.ry * sc * Math.sin(phi),
          center.z + h.rz * sc * cp * Math.sin(theta),
        );
      };
      const a = pt(lo);
      const b = pt(hi);
      if (prev.length === 2) band.quad(prev[0], a, b, prev[1]);
      prev[0] = a; prev[1] = b;
    }
  }

  /**
   * One swept lock.
   *
   * The radius is driven to zero at the tip by the `1 - t^6` term. A lock that
   * ends at finite width is capped by a disc of geometry facing sideways, and at
   * closeup range that disc is the "raw rectangular boundary" the review found
   * on the loose strands. Collapsing the final ring turns the end cap into
   * degenerate triangles the welder strips, leaving an actual point.
   */
  const lock = (from, ctrl, to, w0, w1, twist = 0) => {
    const path = smoothPath([from, ctrl, to], 9);
    sweep(detail, path, SECTIONS.lens(10, 0.55), (i) => {
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
  const nF = hp.fringe | 0;
  const partShift = hp.part ?? 0.12;
  const sweepAmt = hp.fringeSweep ?? 0.4;
  const lean = hp.lean ?? 0;
  // A lock is allowed to hang no lower than this before it starts crossing the
  // eye. The eyes are the entire face (REFERENCE §1) and a blade of hair through
  // them is the one hair failure that cannot be shaded away, so the limit is
  // derived from `metrics.eye` rather than authored — no roster value can
  // violate it.
  const fringeFloor = m.eye.y + m.eye.height * 0.60;
  const fringeGuard = m.eye.halfSpan + m.eye.width * 0.55;
  for (let i = 0; i < nF; i++) {
    const t = nF === 1 ? 0.5 : (i + 0.5) / nF;
    const off = (t - 0.5) + partShift;
    const ang = off * Math.PI * 0.95 * (hp.fringeSpread ?? 1);
    const sx = Math.sin(ang);
    const cz = Math.cos(ang);
    const taper = 0.45 + 1.35 * Math.min(1, Math.abs(off) * 2.2);
    const tipX = sx * h.rx * (1.04 + sweepAmt * 0.75) + lean * h.rx * 0.9;
    const top = h.center.y + h.ry * 0.34;
    let len = (hp.fringeLength ?? 0.26) * h.ry * 2.0 * taper;
    if (Math.abs(tipX) < fringeGuard) len = Math.min(len, Math.max(0, top - fringeFloor));
    // Anchored on the hair shell, not at 0.80 of the skull radius. See `scalp`.
    const from = scalp(Math.atan2(cz, sx), Math.asin(0.52));
    const ctrl = new THREE.Vector3(
      sx * h.rx * (1.00 + sweepAmt * 0.30) + lean * h.rx * 0.4,
      h.center.y + h.ry * 0.30 - len * 0.35,
      cz * h.rz * (1.04 + sweepAmt * 0.25),
    );
    const to = new THREE.Vector3(
      tipX,
      top - len,
      cz * h.rz * (0.98 + sweepAmt * 0.55) - sweepAmt * len * 0.30,
    );
    // Wide enough that neighbouring locks overlap into one continuous fringe.
    // At the previous 0.115 they were separate blades with bare forehead showing
    // between them, which is what made a fringe read as "dark ribbons" rather
    // than as the sculpted mass REFERENCE §1 asks for.
    const w = h.rx * 0.21 * (1 - Math.abs(off) * 0.25);
    lock(from, ctrl, to, w, w * 0.18, off * 0.7);
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
  if (style === 'spike') {
    const n = hp.spikes ?? 8;
    const spread = hp.spikeSpread ?? 1.1;
    for (let i = 0; i < n; i++) {
      // Deterministic jitter: the same character always gets the same hair.
      const j = rng.next();
      const ang = (i / n) * TAU + j * (hp.spikeJitter ?? 0.3);
      const pitch = 0.30 + rng.next() * 0.50;
      const len = (hp.spikeLength ?? 0.3) * H * (0.70 + rng.next() * 0.55);
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
      lock(base, ctrl, tip, H * 0.040, H * 0.002);
    }
  } else if (style === 'bob') {
    // A bell of hair, cut on a hard diagonal, flaring outward at the jaw. The
    // shell alone is a swim cap; the flare is what makes it a haircut, and the
    // asymmetric `lean` is Kite's "everything about her is diagonals".
    const lean = hp.lean ?? 0.3;
    const cut = hp.cutAngle ?? 0.4;
    const bl = (hp.backLength ?? 0.22) * H;
    const wide = hp.backWidth ?? 1.3;
    blob(detail, {
      cx: lean * h.rx * 0.16, cy: h.center.y - h.ry * 0.06 - bl * 0.28, cz: -h.rz * 0.16,
      rx: h.rx * wide, ry: bl * 0.62 + h.ry * 0.72, rz: h.rz * 1.04,
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
        h.rx * 0.24, h.rx * 0.03);
    }
  } else if (style === 'sheet' || style === 'drift') {
    // "a pale drifting mass twice the width of her body" (WORLD_BIBLE §3.2).
    // Three overlapping *solids* rather than sheets — a flat card would vanish
    // edge-on in the side-view battle camera, which is the one angle the game
    // spends most of its running time in. Each layer is a squashed ellipsoid
    // whose lower half is pinched, so the stack silhouettes as a flame.
    const back = (hp.backLength ?? 0.6) * H;
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
      blob(detail, {
        cx: 0,
        cy: h.center.y - h.ry * 0.10 - drop * 0.55,
        cz: -h.rz * (0.22 + lt * 0.42),
        rx: w, ry: drop * 0.62 + h.ry * 0.45, rz: h.rz * (0.86 - lt * 0.16),
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
      lock(from, ctrl, to, H * 0.040, H * 0.008);
    }
  } else if (style === 'beard') {
    const bl = (hp.beardLength ?? 0.4) * H;
    const bwd = (hp.beardWidth ?? 1.2);
    const fork = hp.beardFork ?? 0.25;
    for (const sgn of [-1, 1]) {
      // Anchored on the jaw *surface* (the beard grows off the face, so the
      // shell here is the skull itself at 1.0, not the hair cap).
      const from = scalp(sgn > 0 ? 0.72 : Math.PI - 0.72, -0.34, 1.0);
      const ctrl = new THREE.Vector3(sgn * h.rx * 0.60 * bwd, h.center.y - h.ry * 0.62 - bl * 0.35, h.rz * 0.72);
      const to = new THREE.Vector3(sgn * h.rx * fork * 2.2, h.center.y - h.ry * 0.5 - bl, h.rz * 0.34);
      lock(from, ctrl, to, H * 0.055 * bwd, H * 0.012);
    }
    // Central mass filling between the forks, plus a moustache bar.
    blob(detail, {
      cx: 0, cy: h.center.y - h.ry * 0.62 - bl * 0.30, cz: h.rz * 0.44,
      rx: h.rx * 0.62 * bwd, ry: bl * 0.55, rz: h.rz * 0.50,
      eU: 0.9, eV: 0.85, segU: 16, segV: 10,
      profile: (v) => 1 - Math.pow(THREE.MathUtils.clamp((0.5 - v) / 0.5, 0, 1), 1.4) * 0.55,
    });
    blob(detail, {
      cx: 0, cy: h.center.y - h.ry * 0.22, cz: h.rz * 0.78,
      rx: h.rx * 0.46, ry: h.ry * 0.10, rz: h.rz * 0.24,
      eU: 0.8, eV: 0.8, segU: 14, segV: 6,
    });
  } else if (style === 'topknot' || style === 'braid') {
    // A bound column above the crown. Narrow and tall — the exact opposite of
    // the bob and the sheet, and the only party member whose mass is *above*
    // the skull rather than beside or behind it.
    const tk = (hp.topknot ?? 0.24) * H;
    const tw = hp.topknotWidth ?? 0.50;
    const bindY = h.center.y + h.ry * 0.80;
    // Raked backwards as it rises: the mass ends up behind the crown rather
    // than above it, which keeps the read ("a bound column") while spending
    // roughly half the head-height the same volume would cost stood upright.
    sweep(detail,
      [new THREE.Vector3(0, bindY - h.ry * 0.10, -h.rz * 0.10),
        new THREE.Vector3(0, bindY + tk * 0.52, -h.rz * 0.62),
        new THREE.Vector3(0, bindY + tk * 0.80, -h.rz * 1.55)],
      SECTIONS.circle(14),
      (i) => { const r = h.rx * tw * [0.86, 1.0, 0.30][i]; return [r, r * 0.94]; },
      { capStart: true, capEnd: true });
    // Binding ring, in the light tone, sits in the highlight bucket.
    sweep(band,
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
    const bl = hp.backLength * H;
    // `backDepth` pushes the mass behind the skull rather than beside it, which
    // is how a swept style earns silhouette width in the *side-view* battle
    // camera without widening the head from the front. Front width and side
    // width are separate identity channels and the roster tunes them apart.
    const depth = hp.backDepth ?? 0.62;
    blob(detail, {
      cx: 0, cy: h.center.y - h.ry * 0.10 - bl * 0.35, cz: -h.rz * (0.10 + depth * 0.52),
      rx: h.rx * (hp.backWidth ?? 0.9) * 0.86, ry: bl * 0.72 + h.ry * 0.25, rz: h.rz * depth,
      eU: 1, eV: 0.88, segU: 18, segV: 12,
      profile: (v) => 1 - Math.pow(THREE.MathUtils.clamp((0.45 - v) / 0.45, 0, 1), 1.5) * 0.45,
    });
  }

  if (!cap.empty) parts.push({ surface: cap, cls: 'hair', color: pal.hair, bind: ['neck', 'head'] });
  if (!detail.empty) parts.push({ surface: detail, cls: 'hair', color: pal.hair, bind: ['neck', 'head'], crease: 0.9 });
  if (!band.empty) parts.push({ surface: band, cls: 'hair', color: pal.hairLight, bind: ['head'] });
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
      surface: pauldron, cls: 'metal', color: pal.metal, crease: 0.8,
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
      surface: rigArm, cls: 'metal', color: pal.metal, crease: 0.7,
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
      surface: blade, cls: 'metal', color: pal.metal, crease: 0.5,
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

  if (!cloth.empty) parts.push({ surface: cloth, cls: 'cloth', color: pal.secondary, bind: 'body' });
  if (!leather.empty) parts.push({ surface: leather, cls: 'cloth', color: pal.leather, bind: 'body', crease: 0.8 });
  if (!glow.empty) parts.push({ surface: glow, cls: 'glow', color: pal.glow, bind: 'body' });
  if (!metalBody.empty) parts.push({ surface: metalBody, cls: 'metal', color: pal.metal, bind: 'body', crease: 0.8 });
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
    opacity: 0.62,
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
  body.scale.set(g.hipX * 5.2, 1, g.hipZ * 5.6);
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
 * @param {import('../art/AssetForge.js').AssetForge} [forge] optional; supplies
 *        the toon ramp and the detail normal maps that keep ART_BIBLE §4's
 *        "nothing flat" rule true
 * @param {object} [opts] optional extensions, none of them required
 * @param {import('../render/Lighting.js').Lighting} [opts.lighting] light rig to
 *        alias key/rim uniforms from, so a time-of-day change re-lights the
 *        whole party without touching a material
 * @param {boolean} [opts.outline=true] inverted-hull silhouette line
 * @param {number} [opts.outlineWidth] viewport-fraction width
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

  const metrics = computeMetrics(def);
  const rig = buildRig(def, metrics);
  const pal = def.palette;
  const H = metrics.height;

  const root = new THREE.Group();
  root.name = `character:${def.id}`;
  root.add(rig.root);

  // ---- parts ------------------------------------------------------------
  const parts = [];

  const torso = new Surface();
  buildTorso(torso, metrics);
  parts.push({ surface: torso, cls: 'cloth', color: pal.primary, bind: ['hips', 'spine', 'chest', 'neck'] });

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
      color: bare ? pal.skin : pal.primary,
      bind: [`shoulder${sfx}`, `arm${sfx}`, `forearm${sfx}`, `hand${sfx}`],
    });

    const hand = new Surface();
    buildHand(hand, metrics, side);
    parts.push({
      surface: hand,
      cls: def.accessories?.prosthetic === sfx ? 'metal' : 'skin',
      color: def.accessories?.prosthetic === sfx ? pal.metal : pal.skin,
      bind: [`forearm${sfx}`, `hand${sfx}`],
    });

    // The cuff hides the skin/cloth boundary at the wrist. Skipped on a bare
    // arm (there is no sleeve to hem) and on the prosthetic (the brass sleeve
    // already terminates the limb).
    if (!bare && def.accessories?.prosthetic !== sfx) {
      const cuff = new Surface();
      buildCuff(cuff, metrics, side);
      parts.push({
        surface: cuff, cls: 'cloth', color: pal.trim ?? pal.secondary, crease: 0.9,
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
      buildBoot(boot, metrics, side, H * 0.045);
      parts.push({ surface: boot, cls: 'cloth', color: pal.leather, bind: [`shin${sfx}`, `foot${sfx}`], crease: 0.9 });
    }
  }

  buildHair(parts, metrics, def, pal);
  if (metrics.chains.hair.length > 1) buildHairChain(parts, metrics, def, pal, rig);
  buildWeapon(parts, metrics, def, pal, rig);
  buildAccessories(parts, metrics, def, pal);

  // ---- face: skinned layers plus the mobile iris/lid groups ---------------
  const headWorld = rig.rest.head.world;
  const faceParts = buildFace(metrics, pal);
  const irisSurface = faceParts.iris;
  const catchSurface = faceParts.catch;
  const lidSurface = faceParts.lid;

  parts.push({ surface: faceParts.face, cls: 'eye', bind: ['head'], painted: true });

  // ---- geometry assembly -------------------------------------------------
  const coreSegments = skinSegments(rig);
  const segByName = new Map(coreSegments.map((s) => [s.name, s]));
  const buckets = new Map(CLASSES.map((c) => [c, []]));

  for (const part of parts) {
    if (part.surface.empty) continue;
    const geo = part.surface.finish(part.crease ?? 0);
    planarUV(geo, 3.2 / H);

    // `painted` parts carried their colours out of the builder, per vertex, and
    // must not be flattened to a single tone here — that is the whole face.
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
  // Detail maps only: characters carry no authored albedo. The weave on a coat
  // and the grind lines on a blade are what keep ART_BIBLE §4's "nothing flat"
  // rule true on a toon surface that has no environment reflection to hide in.
  const clothNormal = tex(forge, 'cloth/normal', { repeat: 4 });
  const steelNormal = tex(forge, 'steel/normal', { repeat: 3 });
  const leatherNormal = tex(forge, 'leather/normal', { repeat: 4 });
  const shared = { forge, lighting, ...BODY_RIM };

  const materials = {
    skin: toonMaterial('skin', { ...shared, name: `${def.id}:skin` }),
    hair: toonMaterial('hair', { ...shared, name: `${def.id}:hair` }),
    cloth: toonMaterial('cloth', {
      ...shared, name: `${def.id}:cloth`,
      normalMap: clothNormal ?? leatherNormal,
      normalScale: new THREE.Vector2(0.55, 0.55),
    }),
    metal: toonMaterial('metal', {
      ...shared, name: `${def.id}:metal`,
      normalMap: steelNormal,
      normalScale: new THREE.Vector2(0.35, 0.35),
    }),
    // The eye takes the stock preset's rim envelope, not `BODY_RIM`: the iris is
    // four pixels wide at battle distance and a lifted fresnel floor across it
    // is a grey smear over the one facial feature that has to stay legible. Its
    // own catch-light already supplies the highlight a rim would be faking.
    eye: toonMaterial('eye', { forge, lighting, name: `${def.id}:eye` }),
    glow: glowMaterial(def.id),
  };

  // ---- skinned meshes ----------------------------------------------------
  const meshes = [];
  const outlines = [];
  // One outline material per character, shared by all of its hulls: the width
  // is a viewport fraction, so every class wants the identical value and six
  // copies would be six extra uniform blocks for no visual difference.
  const outlineMaterial = outline
    ? createToonOutlineMaterial({ name: `${def.id}:outline`, width: outlineWidth })
    : null;
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
    mesh.castShadow = true;
    mesh.receiveShadow = cls !== 'glow';
    mesh.frustumCulled = true;
    root.add(mesh);
    // Bound with the rig at the origin: `AttachedBindMode` (the default)
    // refreshes `bindMatrixInverse` from the mesh's world matrix every frame,
    // so moving `root` around the world cannot double-transform the skin.
    mesh.bind(rig.skeleton, new THREE.Matrix4());
    meshes.push(mesh);

    // Inverted-hull outline on the shading classes that define the silhouette.
    // Skipped on `eye` and `glow`: an outline around a four-pixel catch-light
    // erases it, and the face already carries its own drawn dark ring.
    if (outline && cls !== 'eye' && cls !== 'glow') {
      const hull = createToonOutline(mesh, { material: outlineMaterial });
      if (hull) outlines.push(hull);
    }
  }

  // ---- face groups on the head bone --------------------------------------
  const headLocal = new THREE.Matrix4().makeTranslation(-headWorld.x, -headWorld.y, -headWorld.z);
  const irisGroup = new THREE.Group();
  irisGroup.name = `${def.id}:irises`;
  const extraGeo = [];

  if (!irisSurface.empty) {
    const g = irisSurface.finish(0);
    g.applyMatrix4(headLocal);
    planarUV(g, 3.2 / H);
    const mesh = new THREE.Mesh(g, materials.eye);
    mesh.name = `${def.id}:iris`;
    mesh.castShadow = false;
    irisGroup.add(mesh);
    extraGeo.push(g);
  }
  if (!catchSurface.empty) {
    const g = catchSurface.finish(0);
    g.applyMatrix4(headLocal);
    planarUV(g, 3.2 / H);
    const mesh = new THREE.Mesh(g, materials.glow);
    mesh.name = `${def.id}:catchlight`;
    mesh.castShadow = false;
    irisGroup.add(mesh);
    extraGeo.push(g);
  }
  if (irisGroup.children.length) rig.bones.head.add(irisGroup);

  let lidGroup = null;
  if (!lidSurface.empty) {
    const g = lidSurface.finish(0);
    g.applyMatrix4(headLocal);
    planarUV(g, 3.2 / H);
    lidGroup = new THREE.Group();
    lidGroup.name = `${def.id}:lids`;
    const mesh = new THREE.Mesh(g, materials.skin);
    mesh.castShadow = false;
    lidGroup.add(mesh);
    lidGroup.visible = false;
    rig.bones.head.add(lidGroup);
    extraGeo.push(g);
  }

  // ---- grounding ---------------------------------------------------------
  const contact = opts.contactShadow === false ? null : buildContactShadow(rig, metrics);
  if (contact) root.add(contact.group);

  // ---- cloth -------------------------------------------------------------
  const cloth = buildCloth(root, rig, metrics, def, pal, materials, forge);

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
    irises: irisGroup.children.length ? irisGroup : null,
    lids: lidGroup,
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
      for (const key of ['skin', 'hair', 'cloth', 'metal', 'eye']) {
        updateToonUniforms(materials[key], o);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      animator.dispose();
      cloth?.dispose();
      contact?.dispose();
      // Outlines share their source geometry, so they are detached before the
      // meshes free it; `disposeToonOutline` knows not to touch a supplied
      // material, which is why the shared one is disposed separately below.
      for (const hull of outlines) disposeToonOutline(hull);
      outlineMaterial?.dispose();
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        mesh.removeFromParent();
      }
      for (const g of extraGeo) g.dispose();
      irisGroup.removeFromParent();
      lidGroup?.removeFromParent();
      // The toon ramp and the detail normals belong to the forge, which guards
      // its own dispose; the materials themselves are per-character and ours.
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
function buildCloth(root, rig, metrics, def, pal, materials, forge) {
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

  const clothMat = materials.cloth;

  if (cape) {
    const len = cape.length * H;
    const wid = cape.width * H;
    // Graded, not raw. `pal.cape` for the oracle is ivory `#EAE2D4`, linear
    // luminance 0.76 against ART_BIBLE §4's 0.20–0.55 cloth ceiling; ungraded it
    // becomes the brightest object in the frame and the eye lands on a blank
    // rectangle instead of on a face. `gradeAlbedo` moves the level and leaves
    // the WORLD_BIBLE hue untouched.
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
        color: gradeAlbedo(pal.primary, 'cloth'),
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

export default buildCharacter;
