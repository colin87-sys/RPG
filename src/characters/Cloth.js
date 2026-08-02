/**
 * Cloth.js — verlet cloth and strand simulation for capes, skirts and hair.
 *
 * ART_BIBLE §7.9 makes this mandatory rather than decorative: "cloth, hair, or
 * capes that stop moving when the character does" is a failed review. A chibi
 * character has almost no articulation detail to animate — no elbows, no
 * fingers, a face that is four pixels at battle distance — so *secondary
 * motion is the primary readability channel*. If the cape is dead, the
 * character is dead.
 *
 * ## Why verlet, and why fixed-step
 *
 * Position-based verlet with Gauss–Seidel distance constraints is the right
 * trade here: it is unconditionally stable under constraint projection (a
 * constraint can only ever move a particle *toward* its rest length, never
 * inject energy), it costs one multiply-add per particle per axis, and it
 * degrades gracefully — an over-constrained frame gets stiff, not explosive.
 * The catch is that implicit damping in verlet is a function of the *timestep*,
 * so a variable dt makes a cape stiffen and slacken with the frame rate. Hence
 * the accumulator in `update()`: the solver only ever sees 1/60, and callers
 * with a variable delta still get identical motion on a 144 Hz display.
 *
 * ## The three stabilisers that matter
 *
 * 1. **Velocity clamping before integration.** A teleporting character (scene
 *    swap, battle entry) would otherwise hand the solver a metre of implicit
 *    velocity and the cape would slingshot. Displacement is clamped to a
 *    fraction of the shortest rest length, which is the classic CFL-ish bound.
 * 2. **Bend constraints as a separate, weak pass.** Structural-only cloth
 *    folds into itself and self-intersects; full-strength bend constraints
 *    make it read as sheet metal. Skip-one links at ~0.25 stiffness is the
 *    band where a cape swings as a mass but still ripples at its hem.
 * 3. **Capsule collision, not sphere collision.** A sphere per body part
 *    leaves gaps at the joints that a cape hem finds instantly. Segment
 *    capsules built straight off the bone list have no gaps by construction.
 *
 * OWNED BY: characters.
 */
import * as THREE from 'three';
import { rng } from '../core/GameState.js';
import { CAST_LAYER } from './Rig.js';

const FIXED_STEP = 1 / 60;
const MAX_CATCHUP_STEPS = 4; // Beyond this we drop time; a spiral is worse than a hitch.

/** Deterministic value noise — `rng` is consumed once, at construction. */
function hashNoise(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

/** Smooth 1-D turbulence in [-1, 1]; three octaves is plenty for gusting. */
function turbulence(t, lane, seed) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  for (let o = 0; o < 3; o++) {
    const x = t * freq;
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    const a = hashNoise(i, lane + o * 31, seed);
    const b = hashNoise(i + 1, lane + o * 31, seed);
    sum += ((a + (b - a) * s) * 2 - 1) * amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum * 0.57;
}

/**
 * A capsule collider tracking two bones. Radius is fixed; the endpoints are
 * refreshed from the skeleton every step so the cape collides against the pose
 * the animator actually produced, not the bind pose.
 */
class BoneCapsule {
  constructor(boneA, boneB, radius, offsetA = null, offsetB = null) {
    this.boneA = boneA;
    this.boneB = boneB;
    this.radius = radius;
    this.offsetA = offsetA;
    this.offsetB = offsetB;
    this.a = new THREE.Vector3();
    this.b = new THREE.Vector3();
  }

  refresh() {
    this.a.set(0, 0, 0);
    if (this.offsetA) this.a.copy(this.offsetA);
    this.a.applyMatrix4(this.boneA.matrixWorld);
    this.b.set(0, 0, 0);
    if (this.offsetB) this.b.copy(this.offsetB);
    this.b.applyMatrix4(this.boneB.matrixWorld);
  }
}

/** A simulated quad grid: capes, skirts, aprons, mantles, sashes. */
class Panel {
  /**
   * @param {object} spec see {@link ClothSim#addPanel}
   * @param {THREE.Bone} anchorBone bone the top edge is welded to
   * @param {THREE.Vector3[]} anchorLocal top-edge attachment points, in the
   *        anchor bone's local space (captured once, in bind pose)
   * @param {Float32Array} rest flattened rest positions, character-local
   */
  constructor(spec, anchorBone, anchorLocal, restLocal, cols, rows) {
    this.spec = spec;
    this.anchorBone = anchorBone;
    this.anchorLocal = anchorLocal;
    this.cols = cols;
    this.rows = rows;
    this.count = (cols + 1) * (rows + 1);

    this.pos = new Float32Array(this.count * 3);
    this.prev = new Float32Array(this.count * 3);
    this.restLocal = restLocal;
    this.pinned = new Uint8Array(this.count);
    for (let c = 0; c <= cols; c++) this.pinned[c] = 1;

    /** Constraint arrays: [i, j] pairs with a rest length and a stiffness. */
    this.cIdx = null;
    this.cRest = null;
    this.cStiff = null;
    this.minRest = Infinity;

    this.geometry = null;
    this.mesh = null;
    this._normalScratch = null;
    this._seeded = false;
    /** Half-thickness of the solid shell built around the simulated sheet. */
    this.thickness = 0;
    /** +1 if the grid normal already points away from the body. */
    this.faceSign = 1;
  }
}

/**
 * Which way round the shell is: +1 if the grid normal points away from the
 * body, -1 if it points at it.
 *
 * The winding of a panel's grid depends on `curve`, `flare` and the sign of
 * `offsetX`, so there is no single answer that holds for a cape, an apron and a
 * wrapped skirt at once. Getting it wrong is not subtle — the *lining* ends up
 * on the outside, so Emrys's ember-orange coat lining renders as the whole
 * outward face of the coat and the character becomes a saturated orange bell,
 * which ART_BIBLE §2.2 reserves for spells. Deciding it once from the rest
 * layout, per panel, removes the whole class of error.
 *
 * The test is the grid normal at the panel's centre against the outward radial
 * from the body's vertical axis. Where that is degenerate — a flat ribbon
 * hanging off the hip, whose normal is perpendicular to its own offset — the
 * panel's authored `offsetZ` breaks the tie, and failing that either side is
 * equally correct because such a panel is single-toned anyway.
 */
function outwardSign(restLocal, cols, rows, offsetZ) {
  const at = (r, c) => (r * (cols + 1) + c) * 3;
  const r = Math.max(1, Math.floor(rows / 2));
  const c = Math.max(1, Math.floor(cols / 2));
  const k = at(r, c);
  const ux = restLocal[at(r, c + 1)] - restLocal[at(r, c - 1)];
  const uy = restLocal[at(r, c + 1) + 1] - restLocal[at(r, c - 1) + 1];
  const uz = restLocal[at(r, c + 1) + 2] - restLocal[at(r, c - 1) + 2];
  const vx = restLocal[at(r + 1, c)] - restLocal[at(r - 1, c)];
  const vy = restLocal[at(r + 1, c) + 1] - restLocal[at(r - 1, c) + 1];
  const vz = restLocal[at(r + 1, c) + 2] - restLocal[at(r - 1, c) + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const px = restLocal[k], pz = restLocal[k + 2];
  const rad = Math.hypot(px, pz);
  const len = Math.hypot(nx, ny, nz) || 1;
  const dot = rad > 1e-5 ? (nx * px + nz * pz) / (rad * len) : 0;
  if (Math.abs(dot) > 0.15) return dot > 0 ? 1 : -1;
  const fallback = nz * Math.sign(offsetZ || -1);
  return fallback >= 0 ? 1 : -1;
}

/**
 * Hem shapes, as a per-column multiplier on the panel's hang length.
 *
 * A simulated sheet with a straight bottom row is a rectangle, and a rectangle
 * pinned behind a torso reads as a towel — which is exactly what the review
 * found ("flat quad with hard rectangular corners"). Worse, the zig-zag the
 * review calls a "serrated torn hem" is what a straight hem *becomes* once the
 * per-column wind lanes push neighbouring columns out of phase: with nothing
 * shaping the edge, every ripple shows up as a notch on the silhouette.
 *
 * Giving the hem an authored curve fixes both at once. The outline is now a
 * designed shape rather than an artefact, and a ripple reads as the curve
 * flexing instead of as damage.
 *
 * `u` runs -0.5 … 0.5 across the panel.
 */
const HEM_SHAPE = Object.freeze({
  straight: () => 1,
  /** Aprons and mantles: a soft arc, longest at the centre. */
  round: (u) => 1 - 0.30 * Math.pow(Math.abs(u) * 2, 2.2),
  /** Capes and coat tails: drawn to a centre point, the classic heroic hem. */
  point: (u) => 1 - 0.46 * Math.pow(Math.abs(u) * 2, 1.15),
  /** Skirts and robes: near-even, with just enough corner relief to kill the
   *  rectangle. Wrapping panels need their hem level or the seam shows. */
  hemline: (u) => 1 - 0.10 * Math.pow(Math.abs(u) * 2, 3.0),
  /** Split coat tails: long on the outboard edge, cut away inboard. */
  swallow: (u) => 0.62 + 0.38 * Math.pow(Math.abs(u) * 2, 0.8),
});

/** A bone chain driven by a particle strand: hair locks, braids, feather tails. */
class Strand {
  constructor(bones, restDirs, lengths, spec) {
    this.bones = bones;
    this.restDirs = restDirs;     // unit direction of each bone's child offset, bone-local
    this.lengths = lengths;       // rest length of each link
    this.spec = spec;
    this.n = bones.length;        // free particles: one per bone (origins 1..n-1 plus a tip)
    this.pos = new Float32Array((this.n + 1) * 3);
    this.prev = new Float32Array((this.n + 1) * 3);
    this.rest = new Float32Array((this.n + 1) * 3); // pose-target, refreshed per step
    this._seeded = false;
  }
}

/**
 * The per-character cloth solver. One instance owns every simulated panel and
 * strand on that character, so wind, gravity and the collider set are shared
 * and consistent — a cape and a braid on the same body must gust together or
 * the effect reads as two unrelated bugs.
 */
export class ClothSim {
  /**
   * @param {object} opts
   * @param {THREE.Object3D} opts.root character root; panel meshes are parented here
   * @param {Record<string, THREE.Bone>} opts.bones named bones from `Rig.buildRig`
   * @param {number} opts.height character height, used to scale every default
   * @param {number} [opts.gravity] m/s², negative is down
   * @param {number} [opts.iterations] Gauss–Seidel passes per step
   */
  constructor({ root, bones, height, gravity = -9.0, iterations = 6 }) {
    this.root = root;
    this.bones = bones;
    this.height = height;
    this.gravity = gravity;
    this.iterations = iterations;

    this.panels = [];
    this.strands = [];
    this.colliders = [];

    /** Ambient wind, world space. Field/battle scenes may drive this. */
    this.wind = new THREE.Vector3(0, 0, 0);
    this.windGust = 0.35;
    this.time = 0;
    this._accum = 0;
    this._dirty = false;
    this._seed = (rng.next() * 0x7fffffff) | 0;
    this._disposed = false;

    // Scratch, allocated once — this runs 60×/s per character and the GC is
    // the only thing in this file that can actually cause a frame drop.
    this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._toLocal = new THREE.Matrix4();
  }

  // ------------------------------------------------------------- authoring

  /**
   * Add a capsule collider spanning two bones.
   * @param {string} boneA @param {string} boneB
   * @param {number} radius world units
   * @param {THREE.Vector3} [offsetA] @param {THREE.Vector3} [offsetB]
   */
  addCollider(boneA, boneB, radius, offsetA = null, offsetB = null) {
    const a = this.bones[boneA];
    const b = this.bones[boneB] ?? a;
    if (!a) return null;
    const c = new BoneCapsule(a, b, radius, offsetA, offsetB);
    this.colliders.push(c);
    return c;
  }

  /**
   * Add a simulated cloth panel and return its mesh.
   *
   * The panel is authored as a hanging trapezoid in the *character's* local
   * space so the roster can describe a cape in fractions of body height and
   * never think about world coordinates. `flare` widens it toward the hem
   * (skirts), `curve` wraps it around the body (a cape is a cylinder segment,
   * not a flat sheet — flat capes are the classic tell of a first cloth demo).
   *
   * @param {object} spec
   * @param {string} spec.anchor bone name the top edge welds to
   * @param {number} spec.width  hem-line width at the anchor
   * @param {number} spec.length hang length
   * @param {number} [spec.flare] hem width multiplier
   * @param {number} [spec.curve] wrap angle in radians across the top edge
   * @param {number} [spec.offsetY] @param {number} [spec.offsetZ]
   * @param {number} [spec.cols] @param {number} [spec.rows]
   * @param {number} [spec.stiffness] 0..1 structural stiffness
   * @param {number} [spec.drag] velocity damping per step
   * @param {number} [spec.mass] scales gravity and wind response inversely
   * @param {THREE.Material} spec.material
   * @returns {THREE.Mesh}
   */
  addPanel(spec) {
    const anchorBone = this.bones[spec.anchor] ?? this.bones.chest ?? this.bones.hips;
    if (!anchorBone) return null;

    const cols = Math.max(3, spec.cols ?? 8);
    const rows = Math.max(3, spec.rows ?? 10);
    const width = spec.width;
    const length = spec.length;
    const flare = spec.flare ?? 1.0;
    const curve = spec.curve ?? 0.9;
    const offsetX = spec.offsetX ?? 0;
    const offsetY = spec.offsetY ?? 0;
    const offsetZ = spec.offsetZ ?? 0;
    const tiltZ = spec.tiltZ ?? 0;

    // Rest layout, character-local. Row 0 is the anchored top edge.
    const count = (cols + 1) * (rows + 1);
    const restLocal = new Float32Array(count * 3);
    const anchorWorldY = anchorBone.matrixWorld.elements[13];
    const hem = HEM_SHAPE[spec.hem] ?? HEM_SHAPE.round;
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      const halfW = (width * (1 + (flare - 1) * v)) * 0.5;
      for (let c = 0; c <= cols; c++) {
        const u = c / cols - 0.5;
        const ang = u * curve;
        // The hem curve is applied to how far *down* this column hangs, not to
        // where its particles sit relative to each other, so every column keeps
        // an even particle spacing and the solver's rest lengths stay uniform.
        const hangs = hem(u);
        // Sweep the top edge around a cylinder whose *arc length* is the panel
        // width — `radius = width / curve`, not `halfWidth / sin(curve/2)`.
        // The chord form looks equivalent and is not: it under-widens shallow
        // panels and diverges as the wrap approaches a full turn, which is
        // exactly the case a skirt uses. Arc length degenerates smoothly to a
        // flat sheet as curve → 0 (the sash and apron case).
        const radius = (halfW * 2) / Math.max(1e-4, curve);
        const x = curve > 1e-3 ? Math.sin(ang) * radius : u * halfW * 2;
        const z = curve > 1e-3 ? (Math.cos(ang) - Math.cos(curve * 0.5)) * radius : 0;
        const i = (r * (cols + 1) + c) * 3;
        restLocal[i] = x + offsetX;
        restLocal[i + 1] = anchorWorldY + offsetY - v * length * hangs;
        // `tiltZ` rakes the hem backwards quadratically — a coat hangs off the
        // shoulders and kicks out behind, it does not drop like a curtain.
        restLocal[i + 2] = z + offsetZ - v * v * length * tiltZ;
      }
    }

    // Top-edge attachment points, in the anchor bone's local space. Captured
    // once from the bind pose so the weld survives any animation.
    this._m.copy(anchorBone.matrixWorld).invert();
    const anchorLocal = [];
    for (let c = 0; c <= cols; c++) {
      const i = c * 3;
      anchorLocal.push(
        new THREE.Vector3(restLocal[i], restLocal[i + 1], restLocal[i + 2]).applyMatrix4(this._m),
      );
    }

    const panel = new Panel(spec, anchorBone, anchorLocal, restLocal, cols, rows);
    panel.faceSign = outwardSign(restLocal, cols, rows, offsetZ);
    this._buildPanelConstraints(panel, spec);
    this._buildPanelMesh(panel, spec);
    this.panels.push(panel);
    return panel.mesh;
  }

  _buildPanelConstraints(panel, spec) {
    const { cols, rows } = panel;
    const idx = [];
    const rest = [];
    const stiff = [];
    const structural = THREE.MathUtils.clamp(spec.stiffness ?? 0.5, 0.05, 1.0);
    const shear = structural * 0.6;
    const bend = structural * 0.28;
    const at = (r, c) => r * (cols + 1) + c;
    const dist = (a, b) => {
      const i = a * 3, j = b * 3;
      return Math.hypot(
        panel.restLocal[i] - panel.restLocal[j],
        panel.restLocal[i + 1] - panel.restLocal[j + 1],
        panel.restLocal[i + 2] - panel.restLocal[j + 2],
      );
    };
    const push = (a, b, s) => {
      const d = dist(a, b);
      idx.push(a, b);
      rest.push(d);
      stiff.push(s);
      if (d < panel.minRest) panel.minRest = d;
    };

    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        if (c < cols) push(at(r, c), at(r, c + 1), structural);
        if (r < rows) push(at(r, c), at(r + 1, c), structural);
        if (c < cols && r < rows) {
          push(at(r, c), at(r + 1, c + 1), shear);
          push(at(r, c + 1), at(r + 1, c), shear);
        }
        if (c < cols - 1) push(at(r, c), at(r, c + 2), bend);
        if (r < rows - 1) push(at(r, c), at(r + 2, c), bend);
      }
    }

    panel.cIdx = new Int32Array(idx);
    panel.cRest = new Float32Array(rest);
    panel.cStiff = new Float32Array(stiff);
  }

  /**
   * Build the render geometry as a **solid shell**, not a sheet.
   *
   * The panel simulates as one grid of particles, but it renders as two: the
   * outer face at the particle positions and an inner face pushed back along
   * the surface normal by `thickness`, stitched together by a rim strip around
   * the whole perimeter. Three reasons, in order of how much they matter:
   *
   *  1. **A single-sided quad has no back.** From behind — which is half of the
   *     fixed side-view battle camera's coverage of a cape — a `FrontSide`
   *     sheet simply vanishes, and where it wraps the body you see straight
   *     through the panel to the terrain. That is the review's "you see through
   *     the gap between skirt and legs".
   *  2. **The inner face carries the lining colour**, darker than the outer. A
   *     cape whose underside is the same value as its top is the definition of
   *     cardboard; the value break at the fold is what makes cloth read as
   *     cloth at eighty pixels.
   *  3. **The rim strip gives the hem a visible edge.** A zero-thickness hem
   *     aliases into exactly the serration the review found. An edge two
   *     millimetres deep resolves into a soft line instead.
   *
   * Turning the material double-sided would have fixed (1) alone, for the same
   * fill cost, and left the cape still flat and still uniformly bright.
   */
  _buildPanelMesh(panel, spec) {
    const { cols, rows, count } = panel;
    const geo = new THREE.BufferGeometry();
    const total = count * 2;
    const position = new Float32Array(total * 3);
    const normal = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const color = new Float32Array(total * 3);

    panel.thickness = spec.thickness ?? this.height * 0.007;

    const front = new THREE.Color(spec.color ?? 0xffffff);
    const back = new THREE.Color(spec.lining ?? spec.color ?? 0xffffff);
    // The inner surface is *mostly the costume colour*, only tinted toward the
    // lining, and then dropped by nearly half.
    //
    // Not the lining at full strength. A cape hangs behind its wearer, so a
    // camera in front of the character sees the inside face of everything that
    // flares past the body — and since linings in this palette are element
    // accents, painting that face the lining colour turns a charcoal coat into a
    // saturated orange bell from the one angle the game is played at. Tinting
    // instead of replacing keeps the "the underside flashes when the cape lifts"
    // read, which lives at the hem gradient below, and cannot invert the value
    // hierarchy no matter which way the panel ends up facing.
    const inner = front.clone().lerp(back, 0.35).multiplyScalar(0.55);
    // Layer 0 sits at the particles and faces +N; layer 1 is the offset shell
    // and faces -N. `faceSign` says which of those is the outside, so the
    // costume colour and the lining land on the correct faces.
    const outward = panel.faceSign >= 0 ? 0 : count;
    const inward = panel.faceSign >= 0 ? count : 0;
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const k = r * (cols + 1) + c;
        const u = c / cols;
        const v = 1 - r / rows;
        uv[k * 2] = u; uv[k * 2 + 1] = v;
        uv[(k + count) * 2] = u; uv[(k + count) * 2 + 1] = v;
        // The hem carries the lining colour so the underside flashes when the
        // cape lifts — a two-tone cape is worth three of a flat one at 80 px.
        //
        // Exponent 5, not 2.2. Linings in this palette are element accents
        // (Emrys's ember `#FF6B2B`, Kite's signal red) and at 2.2 they claimed
        // the bottom 40% of the panel, which put a saturated orange bell on a
        // character ART_BIBLE §2.2 says may carry no saturated chroma outside a
        // spell. At 5 the accent is a hem band, which is what it is meant to be.
        const t = Math.pow(r / rows, 5.0);
        color[(k + outward) * 3] = front.r + (back.r - front.r) * t;
        color[(k + outward) * 3 + 1] = front.g + (back.g - front.g) * t;
        color[(k + outward) * 3 + 2] = front.b + (back.b - front.b) * t;
        color[(k + inward) * 3] = inner.r;
        color[(k + inward) * 3 + 1] = inner.g;
        color[(k + inward) * 3 + 2] = inner.b;
      }
    }

    const index = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * (cols + 1) + c;
        const b = a + 1;
        const d = a + (cols + 1);
        const e = d + 1;
        index.push(a, d, b, b, d, e);
        // Inner face, wound the other way so its front faces inward.
        index.push(a + count, b + count, d + count, b + count, e + count, d + count);
      }
    }
    // Rim strip: walk the perimeter once, joining outer to inner. Wound so the
    // strip faces outward all the way round.
    const at = (r, c) => r * (cols + 1) + c;
    const border = [];
    for (let c = 0; c < cols; c++) border.push([at(rows, c), at(rows, c + 1)]);
    for (let r = rows; r > 0; r--) border.push([at(r, cols), at(r - 1, cols)]);
    for (let c = cols; c > 0; c--) border.push([at(0, c), at(0, c - 1)]);
    for (let r = 0; r < rows; r++) border.push([at(r, 0), at(r + 1, 0)]);
    for (const [a, b] of border) {
      index.push(a, a + count, b, b, a + count, b + count);
    }

    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    geo.setIndex(index);
    // Cloth leaves the bind volume; a stale bounding sphere pops it out of
    // frame mid-swing. One generous manual sphere costs nothing to keep.
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, this.height * 0.5, 0),
      this.height * 1.4,
    );

    const mesh = new THREE.Mesh(geo, spec.material);
    mesh.name = spec.name ?? 'cloth-panel';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false; // Vertices are already in root-local space.
    // A cape is part of the cast silhouette, so it joins the cast layer with
    // the body — see `CharacterFactory.CAST_LAYER`. Layer 0 stays enabled, so a
    // scene that does not use it sees no change.
    mesh.layers.enable(CAST_LAYER);
    panel.geometry = geo;
    panel.mesh = mesh;
    this.root.add(mesh);
  }

  /**
   * Drive a bone chain (`hair0..n` / `cape0..n`) from a simulated strand.
   *
   * Rotations are solved rather than positions because the geometry is skinned:
   * a strand that moved bone *positions* would tear the mesh away from the
   * head. Each bone is aimed at the next simulated particle, which reproduces
   * the strand's curve exactly while keeping every joint welded.
   *
   * @param {object} spec
   * @param {string[]} spec.bones ordered chain, root first
   * @param {number} [spec.stiffness] 0..1 pull toward the animated rest pose
   * @param {number} [spec.drag] @param {number} [spec.mass] @param {number} [spec.tipLength]
   */
  addStrand(spec) {
    const bones = spec.bones.map((n) => this.bones[n]).filter(Boolean);
    if (bones.length === 0) return null;

    const restDirs = [];
    const lengths = [];
    for (let i = 0; i < bones.length; i++) {
      const child = bones[i + 1];
      const off = child
        ? child.position.clone()
        : new THREE.Vector3(0, -(spec.tipLength ?? this.height * 0.06), 0);
      const len = off.length() || this.height * 0.04;
      lengths.push(len);
      restDirs.push(off.clone().divideScalar(len));
    }

    const strand = new Strand(bones, restDirs, lengths, spec);
    this.strands.push(strand);
    return strand;
  }

  // -------------------------------------------------------------- driving

  /** Ambient wind in world space. `gust` scales the turbulent component. */
  setWind(vec, gust = this.windGust) {
    this.wind.copy(vec);
    this.windGust = gust;
  }

  /**
   * Variable-rate entry point. Accumulates into whole 1/60 steps so the sim is
   * frame-rate independent, which verlet damping otherwise is not.
   */
  update(dt) {
    if (this._disposed) return;
    this._accum += Math.min(dt, 0.25);
    let steps = 0;
    while (this._accum >= FIXED_STEP && steps < MAX_CATCHUP_STEPS) {
      this.fixedUpdate(FIXED_STEP);
      this._accum -= FIXED_STEP;
      steps++;
    }
    if (steps === MAX_CATCHUP_STEPS) this._accum = 0;
    this.flush();
  }

  /**
   * One deterministic 1/60 step. Safe to call directly from `Scene.fixedUpdate`
   * — the geometry write is deferred to `flush()` and marked dirty here, so a
   * frame that runs two sim steps still uploads its vertex buffers once.
   */
  fixedUpdate(dt = FIXED_STEP) {
    if (this._disposed) return;
    this.time += dt;
    this._dirty = true;

    this.root.updateMatrixWorld(true);
    this._toLocal.copy(this.root.matrixWorld).invert();
    for (const c of this.colliders) c.refresh();

    for (const panel of this.panels) this._stepPanel(panel, dt);
    for (const strand of this.strands) this._stepStrand(strand, dt);
  }

  // ---------------------------------------------------------------- panels

  _stepPanel(panel, dt) {
    const { cols, rows, count, pos, prev, pinned } = panel;
    const spec = panel.spec;
    const mass = spec.mass ?? 1;
    const drag = THREE.MathUtils.clamp(spec.drag ?? 0.03, 0, 0.5);
    const invMass = 1 / Math.max(0.2, mass);

    // Weld the top edge to the anchor bone's current world transform.
    const m = panel.anchorBone.matrixWorld;
    if (!panel._seeded) {
      // First step: place every particle at its rest position transformed by
      // the *current* pose, so the cape never starts in a knot at the origin.
      for (let c = 0; c <= cols; c++) {
        this._v.copy(panel.anchorLocal[c]).applyMatrix4(m);
        const base = c * 3;
        const dx = this._v.x - panel.restLocal[base];
        const dy = this._v.y - panel.restLocal[base + 1];
        const dz = this._v.z - panel.restLocal[base + 2];
        for (let r = 0; r <= rows; r++) {
          const k = (r * (cols + 1) + c) * 3;
          pos[k] = panel.restLocal[k] + dx;
          pos[k + 1] = panel.restLocal[k + 1] + dy;
          pos[k + 2] = panel.restLocal[k + 2] + dz;
          prev[k] = pos[k]; prev[k + 1] = pos[k + 1]; prev[k + 2] = pos[k + 2];
        }
      }
      panel._seeded = true;
    }
    for (let c = 0; c <= cols; c++) {
      this._v.copy(panel.anchorLocal[c]).applyMatrix4(m);
      const k = c * 3;
      pos[k] = this._v.x; pos[k + 1] = this._v.y; pos[k + 2] = this._v.z;
      prev[k] = this._v.x; prev[k + 1] = this._v.y; prev[k + 2] = this._v.z;
    }

    // Integrate. Displacement clamping is the difference between a cape and a
    // catastrophe when the character is teleported between scenes.
    const gy = this.gravity * dt * dt * invMass;
    const maxStep = panel.minRest * 0.6;
    const keep = 1 - drag;
    const wt = this.time * 1.7;
    const wx = this.wind.x, wy = this.wind.y, wz = this.wind.z;
    const gustAmp = this.windGust * dt * dt * invMass * 6.0;

    for (let i = 0; i < count; i++) {
      if (pinned[i]) continue;
      const k = i * 3;
      let vx = (pos[k] - prev[k]) * keep;
      let vy = (pos[k + 1] - prev[k + 1]) * keep;
      let vz = (pos[k + 2] - prev[k + 2]) * keep;
      const speed = Math.hypot(vx, vy, vz);
      if (speed > maxStep) {
        const s = maxStep / speed;
        vx *= s; vy *= s; vz *= s;
      }
      prev[k] = pos[k]; prev[k + 1] = pos[k + 1]; prev[k + 2] = pos[k + 2];

      // Turbulence lanes are per-column so neighbouring columns gust out of
      // phase — that phase difference is what makes the hem ripple rather than
      // swing as a rigid board.
      const lane = i % (cols + 1);
      const tb = turbulence(wt + lane * 0.37, lane, this._seed);
      pos[k] += vx + (wx * dt * dt * invMass * 3.0) + tb * gustAmp;
      pos[k + 1] += vy + gy + tb * gustAmp * 0.35 + wy * dt * dt * invMass * 3.0;
      pos[k + 2] += vz + (wz * dt * dt * invMass * 3.0) + tb * gustAmp * 0.6;
    }

    // Constraint projection.
    const { cIdx, cRest, cStiff } = panel;
    const pairs = cRest.length;
    for (let it = 0; it < this.iterations; it++) {
      for (let c = 0; c < pairs; c++) {
        const a = cIdx[c * 2], b = cIdx[c * 2 + 1];
        const ia = a * 3, ib = b * 3;
        const dx = pos[ib] - pos[ia];
        const dy = pos[ib + 1] - pos[ia + 1];
        const dz = pos[ib + 2] - pos[ia + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-6) continue;
        const diff = ((d - cRest[c]) / d) * cStiff[c] * 0.5;
        const ox = dx * diff, oy = dy * diff, oz = dz * diff;
        const pa = pinned[a], pb = pinned[b];
        if (!pa && !pb) {
          pos[ia] += ox; pos[ia + 1] += oy; pos[ia + 2] += oz;
          pos[ib] -= ox; pos[ib + 1] -= oy; pos[ib + 2] -= oz;
        } else if (!pa) {
          pos[ia] += ox * 2; pos[ia + 1] += oy * 2; pos[ia + 2] += oz * 2;
        } else if (!pb) {
          pos[ib] -= ox * 2; pos[ib + 1] -= oy * 2; pos[ib + 2] -= oz * 2;
        }
      }
      this._collidePanel(panel);
    }
  }

  _collidePanel(panel) {
    const { count, pos, pinned } = panel;
    for (const cap of this.colliders) {
      const ax = cap.a.x, ay = cap.a.y, az = cap.a.z;
      const bx = cap.b.x - ax, by = cap.b.y - ay, bz = cap.b.z - az;
      const bb = bx * bx + by * by + bz * bz;
      const r = cap.radius;
      for (let i = 0; i < count; i++) {
        if (pinned[i]) continue;
        const k = i * 3;
        const px = pos[k] - ax, py = pos[k + 1] - ay, pz = pos[k + 2] - az;
        let t = bb > 1e-9 ? (px * bx + py * by + pz * bz) / bb : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = px - bx * t, cy = py - by * t, cz = pz - bz * t;
        const d2 = cx * cx + cy * cy + cz * cz;
        if (d2 >= r * r) continue;
        const d = Math.sqrt(d2);
        if (d < 1e-6) {
          // Degenerate: particle exactly on the axis. Push straight back, which
          // for a cape is always the correct side.
          pos[k + 2] -= r;
          continue;
        }
        const push = (r - d) / d;
        pos[k] += cx * push;
        pos[k + 1] += cy * push;
        pos[k + 2] += cz * push;
      }
    }
  }

  // --------------------------------------------------------------- strands

  _stepStrand(strand, dt) {
    const { bones, lengths, pos, prev, rest, n } = strand;
    const spec = strand.spec;
    const drag = THREE.MathUtils.clamp(spec.drag ?? 0.06, 0, 0.5);
    const stiffness = THREE.MathUtils.clamp(spec.stiffness ?? 0.4, 0, 1);
    const invMass = 1 / Math.max(0.2, spec.mass ?? 1);

    // Rest targets: where the chain would be if it were rigid in the current
    // pose. Solving toward these is what gives hair a *shape memory* — without
    // it a braid hangs like a rope and the sculpted silhouette is lost.
    const parent = bones[0].parent;
    this._m.copy(parent ? parent.matrixWorld : this.root.matrixWorld);
    this._v.set(0, 0, 0).applyMatrix4(bones[0].matrixWorld);
    rest[0] = this._v.x; rest[1] = this._v.y; rest[2] = this._v.z;
    // The rest of the chain follows the bind directions rotated by the anchor.
    this._q.setFromRotationMatrix(bones[0].matrixWorld);
    for (let i = 0; i < n; i++) {
      this._v2.copy(strand.restDirs[i]).multiplyScalar(lengths[i]).applyQuaternion(this._q);
      rest[(i + 1) * 3] = rest[i * 3] + this._v2.x;
      rest[(i + 1) * 3 + 1] = rest[i * 3 + 1] + this._v2.y;
      rest[(i + 1) * 3 + 2] = rest[i * 3 + 2] + this._v2.z;
    }

    if (!strand._seeded) {
      pos.set(rest);
      prev.set(rest);
      strand._seeded = true;
    }

    pos[0] = rest[0]; pos[1] = rest[1]; pos[2] = rest[2];
    prev[0] = rest[0]; prev[1] = rest[1]; prev[2] = rest[2];

    const keep = 1 - drag;
    const gy = this.gravity * dt * dt * invMass * 0.55; // Hair is light; full g reads as chain.
    const maxStep = Math.min(...lengths) * 0.5;
    const gustAmp = this.windGust * dt * dt * invMass * 5.0;

    for (let i = 1; i <= n; i++) {
      const k = i * 3;
      let vx = (pos[k] - prev[k]) * keep;
      let vy = (pos[k + 1] - prev[k + 1]) * keep;
      let vz = (pos[k + 2] - prev[k + 2]) * keep;
      const speed = Math.hypot(vx, vy, vz);
      if (speed > maxStep) {
        const s = maxStep / speed;
        vx *= s; vy *= s; vz *= s;
      }
      prev[k] = pos[k]; prev[k + 1] = pos[k + 1]; prev[k + 2] = pos[k + 2];
      const tb = turbulence(this.time * 1.9 + i * 0.53, i + 64, this._seed);
      pos[k] += vx + this.wind.x * dt * dt * invMass * 3.0 + tb * gustAmp;
      pos[k + 1] += vy + gy + tb * gustAmp * 0.3;
      pos[k + 2] += vz + this.wind.z * dt * dt * invMass * 3.0 + tb * gustAmp * 0.7;
    }

    for (let it = 0; it < this.iterations; it++) {
      // Shape memory first, so the distance pass always has the last word and
      // link lengths stay exact (a stretched hair chain skews the skinning).
      for (let i = 1; i <= n; i++) {
        const k = i * 3;
        // Applied once per Gauss–Seidel pass, so the per-step pull compounds:
        // 0.055 across six iterations is ~30% of the gap per second, which
        // keeps a sculpted silhouette without turning the strand rigid. At the
        // 0.18 that looks reasonable in isolation the chain snaps back inside
        // three frames and the secondary motion disappears entirely.
        const s = stiffness * 0.055;
        pos[k] += (rest[k] - pos[k]) * s;
        pos[k + 1] += (rest[k + 1] - pos[k + 1]) * s;
        pos[k + 2] += (rest[k + 2] - pos[k + 2]) * s;
      }
      for (let i = 0; i < n; i++) {
        const ia = i * 3, ib = (i + 1) * 3;
        const dx = pos[ib] - pos[ia];
        const dy = pos[ib + 1] - pos[ia + 1];
        const dz = pos[ib + 2] - pos[ia + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        const diff = (d - lengths[i]) / d;
        // Link 0's parent particle is pinned to the bone, so it absorbs nothing.
        if (i === 0) {
          pos[ib] -= dx * diff; pos[ib + 1] -= dy * diff; pos[ib + 2] -= dz * diff;
        } else {
          const h = diff * 0.5;
          pos[ia] += dx * h; pos[ia + 1] += dy * h; pos[ia + 2] += dz * h;
          pos[ib] -= dx * h; pos[ib + 1] -= dy * h; pos[ib + 2] -= dz * h;
        }
      }
      this._collideStrand(strand);
    }

    this._writeStrandRotations(strand);
  }

  _collideStrand(strand) {
    const { pos, n } = strand;
    for (const cap of this.colliders) {
      const ax = cap.a.x, ay = cap.a.y, az = cap.a.z;
      const bx = cap.b.x - ax, by = cap.b.y - ay, bz = cap.b.z - az;
      const bb = bx * bx + by * by + bz * bz;
      const r = cap.radius;
      for (let i = 1; i <= n; i++) {
        const k = i * 3;
        const px = pos[k] - ax, py = pos[k + 1] - ay, pz = pos[k + 2] - az;
        let t = bb > 1e-9 ? (px * bx + py * by + pz * bz) / bb : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = px - bx * t, cy = py - by * t, cz = pz - bz * t;
        const d2 = cx * cx + cy * cy + cz * cz;
        if (d2 >= r * r) continue;
        const d = Math.sqrt(d2) || 1e-6;
        const push = (r - d) / d;
        pos[k] += cx * push;
        pos[k + 1] += cy * push;
        pos[k + 2] += cz * push;
      }
    }
  }

  /**
   * Convert solved particle positions into bone rotations.
   *
   * For bone `i`, the child sits at `parentWorldQ * q_i * restDir_i * length`.
   * Solving for `q_i` is therefore a single `setFromUnitVectors` between the
   * rest direction and the desired direction pulled back into the bone's
   * parent frame — no IK iteration, no gimbal handling, exact every time.
   */
  _writeStrandRotations(strand) {
    const { bones, pos, restDirs, n } = strand;
    for (let i = 0; i < n; i++) {
      const bone = bones[i];
      const parent = bone.parent;
      if (parent) {
        parent.updateMatrixWorld(false);
        this._q.setFromRotationMatrix(parent.matrixWorld);
      } else {
        this._q.identity();
      }
      this._q.invert();

      const k = i * 3;
      this._v.set(pos[k + 3] - pos[k], pos[k + 4] - pos[k + 1], pos[k + 5] - pos[k + 2]);
      if (this._v.lengthSq() < 1e-12) continue;
      this._v.normalize().applyQuaternion(this._q);
      this._q2.setFromUnitVectors(restDirs[i], this._v);
      bone.quaternion.copy(this._q2);
      bone.updateMatrixWorld(true);
    }
  }

  // ---------------------------------------------------------------- output

  /**
   * Push solved panel particles into their geometries, with fresh normals.
   * Idempotent and cheap to over-call: a clean simulation state returns
   * immediately, so a scene may call this from its own render hook.
   */
  flush() {
    if (!this._dirty || this._disposed) return;
    this._dirty = false;
    for (const panel of this.panels) {
      if (!panel._seeded) continue;
      const { cols, rows, count, pos, geometry } = panel;
      // Offset toward the body, whichever side that is: an inner shell pushed
      // the wrong way would poke through the outer one at every fold.
      const thickness = panel.thickness * panel.faceSign;
      const attr = geometry.getAttribute('position');
      const arr = attr.array;
      const nrm = geometry.getAttribute('normal').array;
      const stride = count * 3;

      for (let i = 0; i < count; i++) {
        const k = i * 3;
        this._v.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(this._toLocal);
        arr[k] = this._v.x; arr[k + 1] = this._v.y; arr[k + 2] = this._v.z;
      }

      // Grid normals from central differences: two cross products per vertex
      // instead of the twelve a generic `computeVertexNormals` would do, and
      // smooth by construction because the grid is already shared-vertex. The
      // inner shell is then a pure offset of the outer one along -N, which is
      // both cheaper and better-behaved than simulating a second sheet: the two
      // faces can never cross and the shell can never turn inside out.
      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
          const k = (r * (cols + 1) + c) * 3;
          const kl = (r * (cols + 1) + Math.max(0, c - 1)) * 3;
          const kr = (r * (cols + 1) + Math.min(cols, c + 1)) * 3;
          const ku = (Math.max(0, r - 1) * (cols + 1) + c) * 3;
          const kd = (Math.min(rows, r + 1) * (cols + 1) + c) * 3;
          const ux = arr[kr] - arr[kl], uy = arr[kr + 1] - arr[kl + 1], uz = arr[kr + 2] - arr[kl + 2];
          const vx = arr[kd] - arr[ku], vy = arr[kd + 1] - arr[ku + 1], vz = arr[kd + 2] - arr[ku + 2];
          const nx = uy * vz - uz * vy;
          const ny = uz * vx - ux * vz;
          const nz = ux * vy - uy * vx;
          const len = Math.hypot(nx, ny, nz) || 1;
          const ex = nx / len, ey = ny / len, ez = nz / len;
          nrm[k] = ex; nrm[k + 1] = ey; nrm[k + 2] = ez;
          nrm[k + stride] = -ex; nrm[k + stride + 1] = -ey; nrm[k + stride + 2] = -ez;
          arr[k + stride] = arr[k] - ex * thickness;
          arr[k + stride + 1] = arr[k + 1] - ey * thickness;
          arr[k + stride + 2] = arr[k + 2] - ez * thickness;
        }
      }

      attr.needsUpdate = true;
      geometry.getAttribute('normal').needsUpdate = true;
    }
  }

  /** Re-seed every panel and strand at the current pose (post-teleport). */
  reset() {
    for (const p of this.panels) p._seeded = false;
    for (const s of this.strands) s._seeded = false;
    this._accum = 0;
    this._dirty = true;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const panel of this.panels) {
      panel.mesh?.removeFromParent();
      panel.geometry?.dispose();
      panel.geometry = null;
      panel.mesh = null;
    }
    this.panels.length = 0;
    this.strands.length = 0;
    this.colliders.length = 0;
  }
}
