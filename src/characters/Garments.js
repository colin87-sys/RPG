/**
 * Garments.js — the layered-costume library.
 *
 * The client's largest single complaint was that our costumes are flat colour
 * masses where the reference plates' are *built up in layers*. This module is
 * the answer: a parametric catalogue of real garment pieces, each with its own
 * colour, its own material response and its own place in a stack, assembled per
 * character from the `garments` block in `roster.js`.
 *
 * ## Everything here was measured off the plates, not off the prose docs
 *
 * `docs/reference/bravely01.jpg` (1920×1080) and `docs/reference/bravely05.jpg`
 * are the evidence. Landmarks read at 3–5× magnification, expressed as
 * fractions of the figure's own crown-to-sole height H so they transfer across
 * a roster that spans 1.00–1.26 units.
 *
 * ### The knight (`bravely01`, figure 1) — layered armour
 *
 * Eleven separable pieces on one character: gorget, two pauldrons of two to
 * three overlapping lames each, an embossed breastplate, articulated vambraces
 * and gauntlets, a leather waist belt with a rectangular buckle plate, a fauld
 * hanging to a pointed lower plate, thigh cuisses, knee cuffs, greaves and
 * sabatons. Measured stations, sole as origin, H = 363 px on that figure:
 *
 * | landmark                 | measured | as H  |
 * |--------------------------|----------|-------|
 * | gorget top               | 427 px y | 0.76  |
 * | breastplate top → belt   | 84 px    | 0.23  |
 * | belt line                | —        | 0.51  |
 * | belt strap thickness     | 13 px    | 0.036 |
 * | buckle plate             | 30×20 px | 0.083 × 0.055 |
 * | fauld drop below belt    | 96 px    | 0.26  |
 * | cuisse span              | 60 px    | 0.165 |
 * | knee cuff band           | 24 px    | 0.066 |
 *
 * **The single most important read is the rolled edge.** Every plate on that
 * figure is a *shell with thickness* whose border turns over into a narrow,
 * brighter lip. That lip — not the plate's silhouette, not its colour — is what
 * makes armour read as armour rather than as painted-on panels, and it is the
 * reason `shell()` below is built around a rim strip rather than around a
 * single-sided patch. Ours had none.
 *
 * ### The hat-mage (`bravely01`, figure 2) — soft goods and print
 *
 * Beret crown **2.1× head width**, with a pompom and a beaded under-band; a
 * broad flat sailor collar lying over the shoulders; a ribbon tie at the
 * throat; a printed A-line skirt whose hem is **0.40 H across against a 0.14 H
 * waist** (a 2.9:1 flare) and **0.41 H long**, carrying a pale piped hem line
 * around its entire circumference; turned sleeve cuffs; laced boots with
 * visible eyelet dots.
 *
 * The print is a *designed repeating motif*, not noise. So are all eight
 * patterns in `PATTERNS` below.
 *
 * ### The staff-mage (`bravely01`, figure 3) — the long coat
 *
 * The best coat evidence in the set. Ankle-length (hem at 0.075 H off the
 * ground), **0.64 H from shoulder to hem**, flaring to **0.47 H across at the
 * hem against a 0.21 H shoulder** — a coat is more than twice its wearer's
 * shoulder width at the floor. Notched lapels covering the upper quarter of the
 * coat; a buttoned front placket; a centre split running **45% of the coat's
 * length** up from the hem; wide turned-back cuffs; and rose-and-vine
 * embroidery confined to the **bottom 32%** of both front panels and to the
 * cuffs. `PATTERNS.floral` reproduces that motif and that banding.
 *
 * ### The archer (`bravely01`, figure 4) and the ninja (`bravely05`)
 *
 * A small brimmed hat worn tilted, with a diamond-mesh veil hanging past the
 * chin; a black fur ruff with a genuinely **broken, tufted silhouette**; an
 * iridescent woven gown; and a coarse net draped over the skirt in loose
 * scalloped points, roughly seven cells across. The ninja adds a fur-trimmed
 * cape whose trim is irregular along its whole leading edge, a chest harness
 * covered in gold arabesque embroidery, and a cluster of four crossing belts
 * with buckles and hanging strap ends.
 *
 * Both the veil and the net are built as **real strand geometry**, not as an
 * alpha-tested sheet: a cut-out would have to be sorted against the volumetric
 * pass and against the inverted-hull outline, and neither has a stable answer.
 * At this scale the strands are thicker than a pixel anyway.
 *
 * ## Where this contradicts the prose docs
 *
 * `REFERENCE_TARGET.md` §1's "no visible costume detail at battle distance, three
 * flat zones" is wrong about the plates and wrong about the fix: the knight
 * carries eleven pieces and reads *better* small, because the internal edges
 * give the silhouette structure that a single mass cannot have. What survives
 * from that note is that the zones must be *flat* — and they are. There is no
 * gradient anywhere in this file except across a 2-row rolled rim.
 *
 * ## Construction contract (unchanged from the stub this replaces)
 *
 * ```js
 * buildGarmentSet(def, metrics, rig) -> Array<{
 *   name, geometry, material, attachBone
 * }>
 * ```
 *
 * Geometry is authored in the **bind pose, at the origin**, in the same world
 * frame as the body; `CharacterFactory.buildGarments` solves the skin weights
 * against a widened bone-segment list and `attachBone` biases that solve.
 * Pieces sharing a material recipe and a skin bias are merged before they are
 * returned, so the six characters below ship five to ten meshes each while
 * wearing nine to twelve garments — see the note above `BUILDERS` for why the
 * bias, not the piece, is what decides the split.
 *
 * OWNED BY: the garment author. Consumers: `CharacterFactory` only.
 */
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../core/GameState.js';
import { luminance } from '../art/Palette.js';
import { createToonMaterial } from '../render/ToonMaterial.js';

const TAU = Math.PI * 2;
const { clamp, lerp } = THREE.MathUtils;

/**
 * The catalogue. Every id here is buildable and every one of them was chosen
 * because it is visible in a plate — nothing is here on spec.
 *
 * Grouped by the read they carry: hard layered armour, tailored outerwear,
 * soft goods, hardware, and the two mesh pieces.
 */
export const GARMENT_KINDS = Object.freeze([
  // layered plate — each a curved shell with thickness and a rolled edge
  'gorget', 'pauldron', 'breastplate', 'fauld', 'vambrace', 'cuisse', 'greave',
  // tailored outerwear
  'longcoat', 'lapel', 'cuff', 'apron', 'cape', 'hood',
  // skirts and their underlayers
  'skirt', 'underskirt',
  // soft goods around the neck and head
  'collar', 'furCollar', 'scarf', 'ribbon', 'hatSoft', 'hatBrim',
  // hardware and bindings
  'belt', 'sash', 'strap', 'pouch', 'legwrap', 'boot',
  // strand meshes
  'veil', 'fishnet',
]);

const KIND_SET = new Set(GARMENT_KINDS);

/**
 * Luminance windows, **deliberately identical to `CharacterFactory`'s private
 * `ALBEDO_BAND`**.
 *
 * A garment sits directly against the body surface it is worn over, so if the
 * two grade their swatches differently a cobalt coat and a cobalt sleeve come
 * out as two different blues on the same character. The factory cannot export
 * its table without exporting a private of its assembly pass, so the values are
 * restated here with this note: **if one moves, both move.**
 */
const ALBEDO_BAND = Object.freeze({
  cloth: [0.09, 0.62],
  metal: [0.26, 0.72],
});

/**
 * The body's rim envelope, restated for the same reason as the bands above.
 * `BODY_RIM` in `CharacterFactory` — hard pieces that form the silhouette want
 * it; large flat panels want the much weaker `panel` variant, because a fresnel
 * rim floods an edge-on sheet.
 */
const HARD_RIM = Object.freeze({ rimPower: 3.0, rimFloor: 0.55 });
const PANEL_RIM = Object.freeze({
  rimGain: 0.10, rimPower: 4.5, rimFloor: 0.25,
  shadowMix: 0.30, shadowValue: 0.60, shadowLevel: 0.14, ambientGain: 0.62,
});

/**
 * Material recipes. The key is what pieces merge on, so the set is kept small
 * on purpose: five responses is enough to make a stack read as layers, and each
 * extra one is a draw call on every character that wears it.
 */
const RECIPES = Object.freeze({
  /** Armour plate: the only class that takes a highlight. */
  plate: { preset: 'metal', band: 'metal', crease: 0.8, opts: { ...HARD_RIM } },
  /** Buckles, studs, eyelets, rolled lips — brighter and glossier than plate. */
  trim: { preset: 'metal', band: 'metal', crease: 0.7, opts: { ...HARD_RIM, envSpecular: 0.9 } },
  /** Belts, straps, boot bodies, pouches. */
  leather: { preset: 'leather', band: 'cloth', crease: 0.9, opts: { ...HARD_RIM } },
  /** Fitted fabric: collars, cuffs, bodices, sleeves. */
  cloth: { preset: 'cloth', band: 'cloth', crease: 0, opts: { ...HARD_RIM } },
  /** Hanging fabric: coat bodies, skirts, capes, aprons. */
  panel: { preset: 'cloth', band: 'cloth', crease: 0, opts: { ...PANEL_RIM } },
  /**
   * Fur and feather. Same cel response as cloth with the rim opened up: the
   * broken silhouette is the whole point of the piece, and the rim is what
   * separates every tuft tip from the one behind it.
   */
  fur: { preset: 'cloth', band: 'cloth', crease: 0, opts: { rimPower: 2.2, rimFloor: 0.62, ambientGain: 0.78 } },
});

/**
 * The trunk's radius profile, mirrored from `CharacterFactory.buildTorso`.
 *
 * A belt that does not know where the waist actually is either floats off the
 * body or cuts into it, and the trunk is *shaped* per character by the roster's
 * `silhouette` block — Bramm's widest ring is his waist, Kite's narrowest is.
 * Rows are `[t along hips→neck, xScale, zScale, zOffset]`; the doubled rows the
 * factory uses to force hard colour breaks are collapsed, since nothing here
 * reads colour off this table.
 *
 * This is an approximation of another module's surface, so it carries a
 * one-way error budget: `CLEARANCE` below is large enough that drift can only
 * ever make a garment slightly loose, never make it clip.
 */
const TRUNK_PROFILE = Object.freeze([
  [-0.30, 0.88, 0.88, -0.004],
  [-0.12, 1.02, 1.02, -0.002],
  [0.10, 0.94, 0.92, 0.000],
  [0.24, 0.85, 0.85, 0.002],
  [0.34, 0.78, 0.80, 0.004],
  [0.58, 0.92, 0.90, 0.008],
  [0.80, 1.04, 1.02, 0.006],
  [0.95, 0.88, 0.86, 0.002],
  [1.06, 0.52, 0.52, 0.000],
]);

/**
 * How far outside the body a first garment layer sits.
 *
 * 1.075 covers three separate approximations at once: the trunk is swept on a
 * superellipse (`SECTIONS.square(22, 0.86)`), which is 4.8% wider on its
 * diagonals than the ellipse this module models it as; the limb builder adds a
 * 14% joint swell and a small mid-segment belly the taper table does not carry;
 * and `TRUNK_PROFILE` is resampled rather than shared. Anything layered on top
 * of a first layer adds `LAYER` again.
 */
const CLEARANCE = 1.075;
const LAYER = 0.055;

/**
 * The turned edge every free garment boundary carries, as a fraction of body
 * height H.
 *
 * **Measured, because the written spec is wrong here.** The finding asks for a
 * "2–4 mm scale" lip. At this roster's scale a figure is 1.00–1.26 units for a
 * roughly 1.5 m read, so 3 mm is 0.002 units — about 0.17% H, which at the
 * battle camera (a 1.16-unit figure filling ~360 px of a 1080 frame) is 0.6 px.
 * A sub-pixel lip is exactly the invisible edge the finding is complaining
 * about, so following the number would have reproduced the defect.
 *
 * `bravely01.jpg` settles it. On the knight, whose crown-to-sole height is
 * 363 px in that plate, the pale piped edge on the hat-mage's skirt hem, the
 * turned edge of the staff-mage's coat and the lower lip of the archer's gown
 * all read at **4–5 px**, i.e. **1.1–1.4% of figure height** — two decimal
 * orders above the prose value and comfortably legible at capture resolution.
 *
 * `roll` is the one that matters: `shell` extends the lip *in-plane*, outward
 * past the boundary, so raising it deepens the visible turn without moving the
 * inner skin any closer to the body. `thickness` is held near where it was
 * precisely because it does move the inner skin, and a skirt only clears the
 * legs by about half of it.
 */
const HEM = Object.freeze({
  /** Hanging edges: skirt and coat hems, cape and apron borders, fauld lips. */
  roll: 0.014,
  /** Fitted edges — collar, cuff, lapel, sash. Smaller pieces, finer turn. */
  edge: 0.010,
  /** Two-skin separation for soft goods, held tight so hems clear the body. */
  thickness: 0.009,
});

// ============================================================ small maths

const pw = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Grade a swatch's linear luminance into its class's window, keeping chroma. */
function graded(hex, band) {
  const c = new THREE.Color(hex);
  const win = ALBEDO_BAND[band];
  if (!win) return c;
  const y = luminance(c.r, c.g, c.b);
  if (y <= 1e-5) return c.setScalar(win[0]);
  return c.multiplyScalar(clamp(y, win[0], win[1]) / y);
}

/**
 * Resolve a colour slot: a palette key name, a raw sRGB hex, or a fallback.
 *
 * The roster names slots (`'identity'`, `'trim'`, `'accent'`) rather than
 * writing hexes into the garment block, so that retuning a character's palette
 * retunes their whole wardrobe and a designer cannot leave a stale hex behind
 * that fights the identity colour. Raw numbers are still accepted for the one
 * case the palette cannot express — a piece that is deliberately off-palette,
 * like a bone button on a jade mantle.
 */
function swatch(pal, slot, fallback) {
  if (typeof slot === 'number') return slot;
  if (typeof slot === 'string' && pal[slot] !== undefined) return pal[slot];
  return fallback;
}

// ============================================================ triangle soup

/**
 * A growable triangle soup in bind-pose world space, with per-vertex colour and
 * UV recorded at emission.
 *
 * Deliberately a near-twin of `CharacterFactory`'s private `Surface` rather than
 * an import of it: that module imports *this* one, and a cycle between the
 * factory and its garment library would make the load order of two files decide
 * whether characters have clothes. The duplication is forty lines and it buys a
 * module graph with no cycle in it.
 */
class Surface {
  constructor() {
    this.pos = [];
    this.idx = [];
    this.col = [];
    this.uv = [];
    this._r = 1; this._g = 1; this._b = 1;
    this._u = 0; this._v = 0;
  }

  /** Set the linear colour subsequent vertices carry. */
  ink(c) { this._r = c.r; this._g = c.g; this._b = c.b; return this; }

  uvAt(u, v) { this._u = u; this._v = v; return this; }

  vertex(x, y, z) {
    this.pos.push(x, y, z);
    this.col.push(this._r, this._g, this._b);
    this.uv.push(this._u, this._v);
    return this.pos.length / 3 - 1;
  }

  vec(p) { return this.vertex(p.x, p.y, p.z); }

  tri(a, b, c) { this.idx.push(a, b, c); }

  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }

  /**
   * Emit a quad whose winding is chosen so its face normal agrees with `ref`.
   *
   * Rim strips are generated by walking a patch's perimeter, and a perimeter
   * walk's handedness depends on which corner it starts from and on whether the
   * patch's own parameterisation is left- or right-handed — neither of which a
   * caller should have to reason about. Testing one cross product per quad
   * makes the rim provably outward-facing for any patch, at the cost of nothing
   * measurable.
   */
  quadFacing(a, b, c, d, ref) {
    const n = faceNormal(this, a, b, c);
    if (n.dot(ref) < 0) this.quad(a, d, c, b);
    else this.quad(a, b, c, d);
  }

  /**
   * Lay out a `(rows+1) × (cols+1)` grid and triangulate it. Face normals come
   * out as `∂row × ∂col`; `flip` reverses every quad when the caller's
   * parameterisation is the other handedness.
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
    const n = ring[0] === ring[ring.length - 1] ? ring.length - 1 : ring.length;
    let cx = 0, cy = 0, cz = 0;
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

  finish(crease = 0) {
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setIndex(this.idx);
    geo = mergeVertices(geo, 1e-5);
    if (crease > 0) geo = mergeVertices(toCreasedNormals(geo, crease), 1e-5);
    else geo.computeVertexNormals();
    return geo;
  }
}

const _fa = new THREE.Vector3(); const _fb = new THREE.Vector3(); const _fc = new THREE.Vector3();
const _e1 = new THREE.Vector3(); const _e2 = new THREE.Vector3(); const _fn = new THREE.Vector3();

function faceNormal(s, a, b, c) {
  _fa.set(s.pos[a * 3], s.pos[a * 3 + 1], s.pos[a * 3 + 2]);
  _fb.set(s.pos[b * 3], s.pos[b * 3 + 1], s.pos[b * 3 + 2]);
  _fc.set(s.pos[c * 3], s.pos[c * 3 + 1], s.pos[c * 3 + 2]);
  _e1.subVectors(_fb, _fa); _e2.subVectors(_fc, _fa);
  return _fn.crossVectors(_e1, _e2);
}

// =========================================================== the core shell

/**
 * **The primitive this whole module is built on: a garment layer with real
 * thickness and a rolled edge.**
 *
 * Given any parametric surface `point(u, v)`, it emits an outer skin, an inner
 * skin offset back along the surface normal, and a rim band closing the two
 * along every open boundary — with the rim carrying its own flat colour so it
 * reads as a turned lip rather than as a shaded edge.
 *
 * That construction is the single largest thing separating our costumes from
 * the plates'. A pauldron modelled as a one-sided patch has no edge to catch
 * light and no visible depth where it overlaps the lame beneath it, so a stack
 * of three reads as one painted shape; give each of them a 2 mm lip and the
 * same three read as three. It is also what stops every free edge in a costume
 * showing the material's culled backfaces, which on a rim-lit cel surface
 * renders as a bright sliver — the defect the review found on the feather
 * collar and which every open garment boundary would otherwise reproduce.
 *
 * Handedness is solved rather than authored: the parameterisation's normal is
 * sampled at the patch centre and compared with `outward`, and every quad in
 * the piece is wound from that one test. Callers pass surfaces in whatever
 * parameterisation is natural for the garment.
 *
 * @param {Surface} s
 * @param {object} o
 * @param {(u:number,v:number)=>THREE.Vector3} o.point base surface, u and v in [0,1]
 * @param {number} o.thickness shell depth in world units
 * @param {THREE.Color} o.face outer colour
 * @param {THREE.Color} [o.back] inner colour; defaults to a darkened `face`
 * @param {THREE.Color} [o.rim] rolled-lip colour; defaults to `face`
 * @param {THREE.Vector3|((u:number,v:number)=>THREE.Vector3)} [o.outward]
 *        outward reference; defaults to the ray from the patch centroid
 * @param {boolean} [o.closedU] u wraps (a full ring); the rim becomes two rings
 * @param {number} [o.roll] how far the lip stands proud of the boundary, in-plane
 * @param {(u:number,v:number)=>[number,number]} [o.uv]
 */
function shell(s, o) {
  const {
    point, segU = 12, segV = 8, thickness, closedU = false,
    face, back = null, rim = null, roll = thickness * 0.85,
    // `v` is inverted, and every override below inverts it too. `CanvasTexture`
    // uploads with `flipY`, so texture v = 0 is the *bottom* row of the canvas —
    // which is where `PATTERNS.floral` puts its `bandV` band. A garment whose v
    // runs top-to-bottom therefore has to be flipped, or the coat embroidery
    // banded to the bottom third of the motif lands on the wearer's shoulders.
    uv = (u, v) => [u, 1 - v],
  } = o;

  const cols = segU;
  const rows = segV;
  // On a closed ring `patch` visits j = 0 … segU-1 and re-uses column 0 to shut
  // the seam, so u never reaches 1 and `point(0)` is the seam for both sides.
  const uAt = (j) => j / segU;
  const vAt = (i) => i / segV;

  // --- sample the base surface, its normal and its tangents ----------------
  const _out = new THREE.Vector3();
  const base = [];
  const norm = [];
  const tanU = [];
  const tanV = [];
  const centroid = V(0, 0, 0);
  const h = 1e-3;
  const jCount = closedU ? cols : cols + 1;
  for (let i = 0; i <= rows; i++) {
    const rowB = []; const rowN = []; const rowTu = []; const rowTv = [];
    for (let j = 0; j < jCount; j++) {
      const u = uAt(j); const v = vAt(i);
      const p = point(u, v);
      const du = point(Math.min(1, u + h), v).sub(point(Math.max(0, u - h), v));
      const dv = point(u, Math.min(1, v + h)).sub(point(u, Math.max(0, v - h)));
      if (du.lengthSq() < 1e-14) du.copy(point(u + h * 2, v).sub(p));
      if (dv.lengthSq() < 1e-14) dv.copy(point(u, v + h * 2).sub(p));
      rowB.push(p); rowTu.push(du.normalize()); rowTv.push(dv.normalize());
      rowN.push(new THREE.Vector3().crossVectors(dv, du).normalize());
      centroid.add(p);
    }
    base.push(rowB); norm.push(rowN); tanU.push(rowTu); tanV.push(rowTv);
  }
  centroid.multiplyScalar(1 / ((rows + 1) * jCount));

  // --- orient ---------------------------------------------------------------
  //
  // Handedness is a property of the caller's parameterisation, not of the
  // garment, so it is measured once at the patch centre and applied to every
  // quad in the piece rather than asked of the author.
  const outRef = (u, v, p) => {
    if (o.outward instanceof THREE.Vector3) return o.outward;
    if (typeof o.outward === 'function') return o.outward(u, v);
    return _out.subVectors(p, centroid);
  };
  const mi = rows >> 1; const mj = jCount >> 1;
  const flip = norm[mi][mj].dot(outRef(uAt(mj), vAt(mi), base[mi][mj])) < 0;
  if (flip) for (const row of norm) for (const n of row) n.negate();

  const half = thickness * 0.5;
  const cFace = face;
  const cBack = back ?? face.clone().multiplyScalar(0.62);
  const cRim = rim ?? face;

  // --- outer skin ------------------------------------------------------------
  s.ink(cFace);
  const outer = s.patch(rows, cols, closedU, (i, j) => {
    const t = uv(uAt(j), vAt(i));
    s.uvAt(t[0], t[1]);
    return _tmp.copy(base[i][j]).addScaledVector(norm[i][j], half);
  }, flip);

  // --- inner skin, wound the other way --------------------------------------
  s.ink(cBack);
  const inner = s.patch(rows, cols, closedU, (i, j) => {
    const t = uv(uAt(j), vAt(i));
    s.uvAt(t[0], t[1]);
    return _tmp.copy(base[i][j]).addScaledVector(norm[i][j], -half);
  }, !flip);

  // --- the rolled rim -------------------------------------------------------
  //
  // Emitted as its own vertices rather than reusing the skins' boundary rows,
  // because a shared vertex would interpolate the lip's colour into the plate
  // face and turn a hard turned edge into a soft gradient — which is the exact
  // reading the pipeline's flat-zone rule exists to prevent.
  s.ink(cRim);
  const dirOut = (i, j, along, sign) => {
    const t = (along === 'u' ? tanU : tanV)[i][j];
    return _dir.copy(t).multiplyScalar(sign).normalize().clone();
  };

  const strip = (walk) => {
    let prevO = -1; let prevL = -1; let prevI = -1; let prevRef = null;
    for (const [i, j, dir] of walk) {
      const p = base[i][j];
      const n = norm[i][j];
      const io = s.vertex(p.x + n.x * half, p.y + n.y * half, p.z + n.z * half);
      const il = s.vec(_tmp2.copy(p).addScaledVector(dir, roll));
      const ii = s.vertex(p.x - n.x * half, p.y - n.y * half, p.z - n.z * half);
      if (prevO >= 0) {
        s.quadFacing(prevO, io, il, prevL, prevRef);
        s.quadFacing(prevL, il, ii, prevI, prevRef);
      }
      prevO = io; prevL = il; prevI = ii; prevRef = dir;
    }
  };

  // The rim runs the **whole** perimeter as one closed walk, and the two
  // entries at each corner carry the two different in-plane directions the
  // corner sits between — which is what mitres it. Rimming the four edges
  // independently instead leaves a notch at every corner and, on a ring, a
  // missing quad at the seam: four open boundaries per plate, each of which
  // shows the material's culled backfaces as a bright sliver under the
  // mandatory rim light. There is deliberately no option to suppress a rim,
  // because every use of one turned out to be a hole.
  if (closedU) {
    for (const [row, sign] of [[0, -1], [rows, 1]]) {
      const walk = range(jCount).map((j) => [row, j, dirOut(row, j, 'v', sign)]);
      walk.push(walk[0]);
      strip(walk);
    }
  } else {
    const walk = [];
    for (let j = 0; j < jCount; j++) walk.push([0, j, dirOut(0, j, 'v', -1)]);
    for (let i = 0; i <= rows; i++) walk.push([i, jCount - 1, dirOut(i, jCount - 1, 'u', 1)]);
    for (let j = jCount - 1; j >= 0; j--) walk.push([rows, j, dirOut(rows, j, 'v', 1)]);
    for (let i = rows; i >= 0; i--) walk.push([i, 0, dirOut(i, 0, 'u', -1)]);
    walk.push(walk[0]);
    strip(walk);
  }

  return { outer, inner };
}

const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
/** Scratch for per-strand tonal variation; see `furCollar`. */
const _ink = new THREE.Color();
const range = (n) => Array.from({ length: n }, (_, i) => i);

// ============================================================ swept solids

/** Parallel-transport frames; Frenet frames corkscrew wherever curvature flips. */
function transportFrames(path) {
  const n = path.length;
  const t = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    t.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  const u = []; const v = [];
  const ref = Math.abs(t[0].y) < 0.9 ? V(0, 1, 0) : V(0, 0, 1);
  u.push(new THREE.Vector3().crossVectors(ref, t[0]).normalize());
  v.push(new THREE.Vector3().crossVectors(t[0], u[0]).normalize());
  for (let i = 1; i < n; i++) {
    const proj = u[i - 1].clone().addScaledVector(t[i], -u[i - 1].dot(t[i]));
    if (proj.lengthSq() < 1e-10) proj.copy(v[i - 1]);
    proj.normalize();
    u.push(proj);
    v.push(new THREE.Vector3().crossVectors(t[i], proj).normalize());
  }
  return { t, u, v };
}

/** Unit cross-sections. `e < 1` squares the section off; 1 is a circle. */
function section(n, e = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out.push([pw(Math.cos(a), e), pw(Math.sin(a), e)]);
  }
  return out;
}

/**
 * Sweep a section along a path. Used for straps, laces, tufts and belts.
 *
 * The wall is emitted with the winding **flipped**, and that is not a taste
 * call — a swept tube's natural parameterisation is left-handed and comes out
 * inside-out without it. `transportFrames` returns a right-handed basis with
 * `u × v = t`, so the patch's own `∂path × ∂section` evaluates to `t × v = −u`,
 * i.e. the inward radial. Rendered that way a tube shows its far inner wall
 * through its near one, which on an opaque cel surface reads as a dark hole
 * where a strap should be.
 *
 * The two caps are *not* flipped, because their handedness is the other way
 * round: a cap ring wound in increasing section angle already gives `u × v = t`,
 * so the start cap (which faces `−t`) is the one that needs reversing.
 */
function sweep(s, path, sect, scaleFn, opts = {}) {
  const { u, v } = transportFrames(path);
  const rows = path.length - 1;
  const cols = sect.length;
  const grid = s.patch(rows, cols, true, (i, j) => {
    const [su, sv] = scaleFn(i);
    const p = path[i];
    s.uvAt(j / cols, i / rows);
    return _tmp.set(
      p.x + u[i].x * sect[j][0] * su + v[i].x * sect[j][1] * sv,
      p.y + u[i].y * sect[j][0] * su + v[i].y * sect[j][1] * sv,
      p.z + u[i].z * sect[j][0] * su + v[i].z * sect[j][1] * sv,
    );
  }, true);
  if (opts.capStart !== false) s.cap(grid[0], true);
  if (opts.capEnd !== false) s.cap(grid[rows], false);
  return grid;
}

/** A superellipsoid — buckles, buttons, pompoms, studs, pouches. */
function blob(s, o) {
  const {
    cx = 0, cy = 0, cz = 0, rx = 1, ry = 1, rz = 1,
    eU = 1, eV = 1, segU = 12, segV = 8, matrix = null,
  } = o;
  s.patch(segV, segU, true, (i, j) => {
    const phi = (i / segV - 0.5) * Math.PI;
    const th = (j / segU) * TAU;
    s.uvAt(j / segU, i / segV);
    const cr = pw(Math.cos(phi), eV);
    _tmp.set(cx + rx * cr * pw(Math.cos(th), eU), cy + ry * pw(Math.sin(phi), eV), cz + rz * cr * pw(Math.sin(th), eU));
    if (matrix) _tmp.applyMatrix4(matrix);
    return _tmp;
  });
}

/** A closed ring path in the XZ plane — belts, sashes, collar bands, hat bands. */
function ringPath(y, rx, rz, n, z0 = 0, phase = 0) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = phase + (i / n) * TAU;
    out.push(V(Math.cos(a) * rx, y, z0 + Math.sin(a) * rz));
  }
  return out;
}

// ========================================================= fabric patterns
//
// Every one of these is a *designed repeating motif* drawn with paths on a
// canvas. ANIME_PIPELINE's absolute no-noise rule is about fBm detail maps
// standing in for surface texture — dirt on a character — and it is untouched
// here: there is no noise function in this file. The plates carry printed
// skirts, embroidered coat panels, gold arabesque harnesses and iridescent
// weaves, and a motif is the only honest way to build one.

/** Off-DOM where possible; a scene load can build a dozen of these. */
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const css = (hex) => `#${(hex >>> 0).toString(16).padStart(6, '0').slice(-6)}`;

/** Mix two sRGB hexes in sRGB space; motifs are authored by eye, not by light. */
function mixHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return ((Math.round(lerp(ar, br, t)) << 16)
    | (Math.round(lerp(ag, bg, t)) << 8)
    | Math.round(lerp(ab, bb, t))) >>> 0;
}

/**
 * Draw a motif at nine wrapped offsets so it tiles across the canvas seam.
 *
 * A motif clipped at the edge of a repeating texture prints a hard vertical
 * join down the middle of a skirt panel, which is worse than having no motif.
 */
function stamp(ctx, size, fn) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      ctx.save();
      ctx.translate(dx * size, dy * size);
      fn(ctx);
      ctx.restore();
    }
  }
}

/**
 * The motif catalogue.
 *
 * `bandV` restricts a motif to the lower fraction of the texture, which is how
 * the staff-mage's coat is actually decorated — the rose-and-vine work occupies
 * the bottom 32% of the panels and the cuffs, and nothing above.
 */
const PATTERNS = {
  /**
   * Rose-and-vine embroidery, straight off the staff-mage's coat panels: dark
   * curling stems with solid rounded blossoms in a second colour. Roughly six
   * blossoms per panel width, which is what the plate shows.
   */
  floral(ctx, size, p, rand) {
    const { base, ink, accent, bandV = 1 } = p;
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, size, size);
    const top = size * (1 - bandV);
    const rows = 2; const colsN = 3;
    ctx.lineCap = 'round';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < colsN; c++) {
        const cx = (c + 0.5) * size / colsN + rand.jitter(size * 0.04);
        const cy = top + (r + 0.5) * (size - top) / rows + rand.jitter(size * 0.03);
        const sc = (size / colsN) * (0.72 + rand.next() * 0.2);
        stamp(ctx, size, (g) => {
          // stem: two mirrored tendrils curling away from the blossom
          g.strokeStyle = css(ink);
          g.lineWidth = Math.max(1.5, size * 0.006);
          for (const dir of [-1, 1]) {
            g.beginPath();
            g.moveTo(cx, cy + sc * 0.42);
            g.bezierCurveTo(cx + dir * sc * 0.42, cy + sc * 0.30, cx + dir * sc * 0.50, cy - sc * 0.10, cx + dir * sc * 0.16, cy - sc * 0.34);
            g.stroke();
            // one leaf per tendril
            g.beginPath();
            g.moveTo(cx + dir * sc * 0.30, cy + sc * 0.14);
            g.quadraticCurveTo(cx + dir * sc * 0.58, cy + sc * 0.02, cx + dir * sc * 0.46, cy - sc * 0.20);
            g.quadraticCurveTo(cx + dir * sc * 0.30, cy - sc * 0.04, cx + dir * sc * 0.30, cy + sc * 0.14);
            g.fillStyle = css(ink);
            g.fill();
          }
          // blossom: three nested petal arcs, solid, no gradient
          g.fillStyle = css(accent);
          g.beginPath();
          g.arc(cx, cy, sc * 0.20, 0, TAU);
          g.fill();
          g.strokeStyle = css(mixHex(accent, ink, 0.55));
          g.lineWidth = Math.max(1, size * 0.004);
          for (let k = 1; k <= 2; k++) {
            g.beginPath();
            g.arc(cx, cy + sc * 0.02 * k, sc * (0.20 - k * 0.055), Math.PI * 0.15, Math.PI * 0.85);
            g.stroke();
          }
        });
      }
    }
  },

  /**
   * Gold scroll filigree — the ninja's chest harness. Four-fold mirrored
   * spirals, stroked thin so the read is line work rather than area.
   */
  arabesque(ctx, size, p) {
    const { base, accent } = p;
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = css(accent);
    ctx.lineCap = 'round';
    const spiral = (g, cx, cy, r0, turns, dir) => {
      g.beginPath();
      const steps = 48;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const a = dir * t * turns * TAU;
        const r = r0 * (1 - t * 0.86);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    };
    for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      stamp(ctx, size, (g) => {
        g.strokeStyle = css(accent);
        g.lineWidth = Math.max(1.5, size * 0.007);
        spiral(g, fx * size, fy * size, size * 0.17, 1.6, fx < 0.5 ? 1 : -1);
        g.lineWidth = Math.max(1, size * 0.004);
        spiral(g, fx * size, fy * size, size * 0.10, 1.2, fx < 0.5 ? -1 : 1);
        g.beginPath();
        g.moveTo(fx * size - size * 0.17, fy * size);
        g.quadraticCurveTo(fx * size, fy * size - size * 0.26, fx * size + size * 0.17, fy * size);
        g.stroke();
      });
    }
  },

  /**
   * A heraldic device, centred and non-tiling — the knight's breastplate carries
   * an embossed keep in a lighter tone than the plate around it.
   */
  heraldic(ctx, size, p) {
    const { base, accent, ink } = p;
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, size, size);
    const s = size;
    ctx.strokeStyle = css(mixHex(base, ink, 0.5));
    ctx.lineWidth = s * 0.020;
    ctx.strokeRect(s * 0.16, s * 0.14, s * 0.68, s * 0.72);
    ctx.fillStyle = css(accent);
    // keep: a wall with three merlons over an arched gate
    ctx.fillRect(s * 0.30, s * 0.36, s * 0.40, s * 0.34);
    for (let i = 0; i < 3; i++) ctx.fillRect(s * (0.30 + i * 0.145), s * 0.28, s * 0.11, s * 0.10);
    ctx.fillStyle = css(mixHex(accent, ink, 0.72));
    ctx.beginPath();
    ctx.moveTo(s * 0.44, s * 0.70);
    ctx.lineTo(s * 0.44, s * 0.52);
    ctx.arc(s * 0.50, s * 0.52, s * 0.06, Math.PI, 0);
    ctx.lineTo(s * 0.56, s * 0.70);
    ctx.closePath();
    ctx.fill();
    // a pair of wings under it — the Skysworn mark
    ctx.strokeStyle = css(accent);
    ctx.lineWidth = s * 0.012;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 0.50, s * 0.76);
      ctx.quadraticCurveTo(s * (0.50 + dir * 0.17), s * 0.74, s * (0.50 + dir * 0.22), s * 0.84);
      ctx.stroke();
    }
  },

  /**
   * Iridescent weave: diagonal bands cycling a four-stop hue ramp, with a fine
   * warp/weft cross-hatch over them. The archer's gown does exactly this — the
   * colour shift runs on a diagonal and the cloth still reads as woven.
   */
  iridescent(ctx, size, p) {
    const { ramp = [0x1f9e5c, 0xd6e35a, 0x3fd0c0, 0x2a6fa8], base } = p;
    ctx.fillStyle = css(base ?? ramp[0]);
    ctx.fillRect(0, 0, size, size);
    // Eight bands sheared exactly one canvas width over one canvas height. Both
    // numbers matter: the shear has to be 1:1 and the band period has to divide
    // the canvas, or the diagonal walks off the seam and prints a hard join down
    // the middle of the skirt.
    const bands = 8;
    const w = size / bands;
    for (let i = -bands; i <= bands * 2; i++) {
      const k = ((i % bands) + bands) % bands / bands * ramp.length;
      const a = ramp[Math.floor(k) % ramp.length];
      const b = ramp[(Math.floor(k) + 1) % ramp.length];
      ctx.fillStyle = css(mixHex(a, b, k - Math.floor(k)));
      const x = i * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + w + 1, 0);
      ctx.lineTo(x + w + 1 - size, size);
      ctx.lineTo(x - size, size);
      ctx.closePath();
      ctx.fill();
    }
    // Warp and weft. **Fourteen cells, not the twenty-eight this used to draw.**
    //
    // A weave line has to survive minification as a *line*; once its on-screen
    // pitch falls under about two pixels it stops resolving and starts beating
    // against whatever else in the motif is near that frequency — here the
    // colour bands — and the interference prints as a regular two-tone grid.
    // That is how this pattern shipped a magenta-and-white check on Seren's
    // petticoat: a 28-cell hatch tiled nine times round a skirt is a quarter of
    // a pixel per cell at the battle camera. Fourteen cells at the tiling this
    // roster now asks for lands the hatch at 8–11 px, which reads as cloth.
    //
    // The alpha comes down with it: a hatch that is legible does not need to be
    // dark to be seen, and 0.22 black over a light band was half the contrast in
    // the beat pattern.
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(1, size * 0.003);
    const weave = 14;
    const cell = size / weave;
    for (let i = 0; i <= weave; i++) {
      ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(size, i * cell); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },

  /** Diamond damask with a stylised wave inside each cell — corsair cloth. */
  damask(ctx, size, p) {
    const { base, ink, accent } = p;
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, size, size);
    const n = 4;
    const c = size / n;
    ctx.lineWidth = Math.max(1, size * 0.004);
    for (let r = 0; r <= n; r++) {
      for (let q = 0; q <= n; q++) {
        const cx = q * c + (r % 2 ? c * 0.5 : 0);
        const cy = r * c;
        stamp(ctx, size, (g) => {
          g.strokeStyle = css(ink);
          g.lineWidth = Math.max(1, size * 0.004);
          g.beginPath();
          g.moveTo(cx, cy - c * 0.46); g.lineTo(cx + c * 0.46, cy);
          g.lineTo(cx, cy + c * 0.46); g.lineTo(cx - c * 0.46, cy);
          g.closePath(); g.stroke();
          g.strokeStyle = css(accent);
          g.lineWidth = Math.max(1.2, size * 0.006);
          g.beginPath();
          g.moveTo(cx - c * 0.26, cy + c * 0.06);
          g.quadraticCurveTo(cx - c * 0.08, cy - c * 0.20, cx, cy + c * 0.02);
          g.quadraticCurveTo(cx + c * 0.08, cy + c * 0.22, cx + c * 0.26, cy - c * 0.06);
          g.stroke();
        });
      }
    }
  },

  /** Key-fret lattice — the ninja's mask and the corsair's collar lining. */
  lattice(ctx, size, p) {
    const { base, ink } = p;
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = css(ink);
    const n = 5;
    const c = size / n;
    ctx.lineWidth = Math.max(1.5, size * 0.008);
    for (let r = 0; r < n; r++) {
      for (let q = 0; q < n; q++) {
        stamp(ctx, size, (g) => {
          g.strokeStyle = css(ink);
          g.lineWidth = Math.max(1.5, size * 0.008);
          const x = q * c; const y = r * c;
          g.beginPath();
          g.moveTo(x + c * 0.18, y + c * 0.82);
          g.lineTo(x + c * 0.18, y + c * 0.18);
          g.lineTo(x + c * 0.82, y + c * 0.18);
          g.lineTo(x + c * 0.82, y + c * 0.60);
          g.lineTo(x + c * 0.46, y + c * 0.60);
          g.lineTo(x + c * 0.46, y + c * 0.42);
          g.stroke();
        });
      }
    }
  },

  /** Overlapping scalloped feather rows with a quill line — the Wyldcaller. */
  feather(ctx, size, p) {
    const { base, ink, accent } = p;
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, size, size);
    const rows = 5; const colsN = 5;
    const w = size / colsN; const hgt = size / rows;
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < colsN; q++) {
        const cx = q * w + (r % 2 ? w * 0.5 : 0) + w * 0.5;
        const cy = r * hgt + hgt * 0.5;
        stamp(ctx, size, (g) => {
          g.fillStyle = css(mixHex(base, accent, 0.45));
          g.beginPath();
          g.moveTo(cx, cy - hgt * 0.52);
          g.quadraticCurveTo(cx + w * 0.46, cy - hgt * 0.10, cx, cy + hgt * 0.52);
          g.quadraticCurveTo(cx - w * 0.46, cy - hgt * 0.10, cx, cy - hgt * 0.52);
          g.fill();
          g.strokeStyle = css(ink);
          g.lineWidth = Math.max(1, size * 0.004);
          g.beginPath();
          g.moveTo(cx, cy - hgt * 0.48); g.lineTo(cx, cy + hgt * 0.48);
          g.stroke();
        });
      }
    }
  },

  /** Crossed stripe sett — a forge tartan, warm over iron. */
  tartan(ctx, size, p) {
    const { base, ink, accent } = p;
    ctx.fillStyle = css(base);
    ctx.fillRect(0, 0, size, size);
    const bands = [[0.00, 0.16, accent, 0.55], [0.22, 0.06, ink, 0.9], [0.38, 0.24, ink, 0.35], [0.70, 0.05, accent, 0.85]];
    for (const [at, wide, col, alpha] of bands) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = css(col);
      ctx.fillRect(at * size, 0, wide * size, size);
      ctx.fillRect(0, at * size, size, wide * size);
    }
    ctx.globalAlpha = 1;
  },
};

/**
 * Pattern textures are cached module-wide by their full parameter key.
 *
 * Six characters wearing four patterned pieces each would otherwise upload
 * twenty-four canvases; in practice most of them are the same two or three
 * motifs in different palettes, and a party sharing a motif shares the texture.
 * They are deliberately *not* disposed with a character, on the same principle
 * as the face-texture cache: releasing one with the first wearer to be torn
 * down would blank it on everyone still standing.
 */
const _patternCache = new Map();

/**
 * Tiling, resolved in **one** place.
 *
 * This function exists because the checkerboard the review found on Seren's
 * petticoat was not a missing texture at all — this project loads no external
 * assets, so there is no path that can fail to resolve — it was a motif tiled
 * twice over. `skirt`, `longcoat`, `sash` and `cape` each multiplied u by a
 * private `patternRepeatU` default *inside the geometry*, and `materialFor`
 * then multiplied again by the roster's `pattern.repeat` *on the texture*. Her
 * underskirt asked for 3 and got 3 × 3 = 9, applied in u only, which squashes a
 * square-authored motif into a 9:1 grating: 252 near-vertical weave lines round
 * the skirt crossed by 28 horizontal ones down it. Sampled at a couple of
 * pixels a fine two-tone grating is a checkerboard, and because the aurora-silk
 * ramp happened to place its rose stop next to its ivory one, it was a
 * *magenta and white* checkerboard — indistinguishable from an engine's
 * missing-texture placeholder, which is exactly how the review read it.
 *
 * So: the builders no longer scale UVs, `pattern.repeat` is the only tiling
 * control any garment has, and it is validated here.
 *
 * Two rules are enforced rather than documented, because both defects reached a
 * capture once already:
 *
 * - **Anisotropy is capped at 4:1.** Every motif in `PATTERNS` is drawn square
 *   on a square canvas, so a repeat far off the diagonal does not tile it, it
 *   *shears* it into a grating — the failure above. Four is the widest ratio at
 *   which a blossom still reads as a blossom.
 * - **A clamped motif may not tile at all.** `wrap: 'clamp'` is how the
 *   non-repeating devices (the heraldic keep, the rib-plate) are placed, and a
 *   repeat above 1 on a clamped texture stretches one edge texel across the
 *   whole remaining surface — a smear, not a print.
 *
 * Both clamp with a warning rather than throwing: a mistuned repeat is ugly,
 * and shipping ugly beats a character failing to build mid-battle.
 */
function resolveRepeat(p) {
  const r = p.repeat;
  if (!r) return null;
  let [u, v] = r;
  if (!Number.isFinite(u) || !Number.isFinite(v) || u <= 0 || v <= 0) {
    console.warn(`[Garments] pattern "${p.id}" has a non-positive repeat ${JSON.stringify(r)}; ignoring it`);
    return null;
  }
  if (p.wrap === 'clamp' && (u !== 1 || v !== 1)) {
    console.warn(`[Garments] pattern "${p.id}" is clamped and cannot tile; forcing repeat to 1×1`);
    return [1, 1];
  }
  const skew = Math.max(u / v, v / u);
  if (skew > 4) {
    const k = Math.sqrt(4 / skew);
    [u, v] = u > v ? [u * k, v / k] : [u / k, v * k];
    console.warn(`[Garments] pattern "${p.id}" repeat ${JSON.stringify(r)} shears the motif ${skew.toFixed(1)}:1; clamped to ${u.toFixed(2)}×${v.toFixed(2)}`);
  }
  return [u, v];
}

function patternTexture(id, p) {
  const fn = PATTERNS[id];
  // A garment naming a motif that does not exist is this project's only
  // possible "unresolved texture reference", and it used to fail *silently* —
  // the piece shipped in flat vertex colour and nothing said so. Throwing means
  // a typo in `roster.js` cannot reach a capture: it fails the scene load with
  // the offending id, at the moment the wardrobe is built.
  if (!fn) throw new Error(`[Garments] unknown pattern id "${id}" — valid ids: ${Object.keys(PATTERNS).join(', ')}`);
  const key = `${id}|${JSON.stringify(p)}`;
  const hit = _patternCache.get(key);
  if (hit !== undefined) return hit;

  const size = p.size ?? 256;
  const canvas = makeCanvas(size, size);
  // Headless: no canvas, no pattern. The piece still renders in its flat
  // vertex colour rather than costing the caller its whole character.
  if (!canvas) { _patternCache.set(key, null); return null; }
  const ctx = canvas.getContext('2d');
  fn(ctx, size, p, new Rng(p.seed ?? 0x51f2a1));

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = `garment-${id}`;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = p.wrap === 'clamp' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  tex.wrapT = tex.wrapS;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  _patternCache.set(key, tex);
  return tex;
}

/** Release every cached motif. Call on a full teardown, never per character. */
export function disposeGarmentPatterns() {
  for (const t of _patternCache.values()) t?.dispose();
  _patternCache.clear();
}

// ================================================================ materials

const RIG_UNIFORMS = ['uKeyColor', 'uRimDirection', 'uRimColor', 'uRimStrength'];
const FEEDBACK_UNIFORMS = ['uToonPulse', 'uToonPulseRate', 'uToonTime'];
const NO_OP = () => {};

/**
 * Adopt the lighting rig and the battle-feedback channel from the body this
 * garment is worn on, at first render.
 *
 * `buildGarmentSet(def, metrics, rig)` is handed no `Lighting` instance — the
 * factory's signature predates this module and is not ours to change — so a
 * garment material built in isolation keeps `createToonMaterial`'s *defaults*
 * for the four rig uniforms. That is not cosmetic: `uKeyColor` is the radiance
 * the shader divides by to decide which side of the terminator a fragment is
 * on, so a garment holding the 3.0 white default while the body holds the dusk
 * key reads as permanently half-shadowed against the sleeve underneath it.
 *
 * The fix does not need a new argument, because the answer is already in the
 * scene graph: a garment is lit by the same rig as the body it is worn on, and
 * that body's material is a sibling of this mesh under the character's root.
 * On the first render we walk those siblings, find the first surface material
 * whose rig uniforms are *shared* (which is precisely the marker
 * `createToonMaterial` sets when it was given a `Lighting`), and alias the same
 * uniform objects. `uToonPulse` / `uToonPulseRate` / `uToonTime` are adopted in
 * the same pass, which is what makes `character.setToonUniforms` — whose class
 * list this module is not in — flash the costume along with the skin.
 *
 * `material.onBeforeRender` fires before the program is set up on the frame it
 * first draws, so the alias lands ahead of the uniform capture; `needsUpdate`
 * covers the case where the material compiled for a shadow or outline pass
 * first. One shot, then it removes itself.
 */
function inheritCharacterRig(material) {
  material.onBeforeRender = function adopt(renderer, scene, camera, geometry, object) {
    this.onBeforeRender = NO_OP;
    const mine = this.userData?.toon;
    const siblings = object?.parent?.children;
    if (!mine || !siblings) return;
    for (const child of siblings) {
      const donor = child.material?.userData?.toon;
      if (!donor || donor.kind !== 'surface' || !donor.shared?.has('uKeyColor')) continue;
      for (const name of RIG_UNIFORMS) {
        if (!donor.uniforms[name] || !mine.uniforms[name]) continue;
        mine.uniforms[name] = donor.uniforms[name];
        mine.shared.add(name);
      }
      for (const name of FEEDBACK_UNIFORMS) {
        if (donor.uniforms[name] && mine.uniforms[name]) mine.uniforms[name] = donor.uniforms[name];
      }
      this.needsUpdate = true;
      return;
    }
  };
  return material;
}

/**
 * One material per (recipe, pattern) pair per character.
 *
 * Per character rather than shared across the party, because `Lighting`
 * registers materials by identity for cascade shadows and because a damage
 * flash on one party member must not tint the other three.
 */
function materialFor(cache, def, recipeName, pattern) {
  const recipe = RECIPES[recipeName] ?? RECIPES.cloth;
  const map = pattern ? patternTexture(pattern.id, pattern) : null;
  const key = `${recipeName}|${map ? pattern.id + JSON.stringify(pattern) : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  if (map) {
    const rep = resolveRepeat(pattern);
    map.repeat.set(rep ? rep[0] : 1, rep ? rep[1] : 1);
  }
  const material = createToonMaterial({
    preset: recipe.preset,
    name: `${def.id}:garment:${recipeName}${map ? `:${pattern.id}` : ''}`,
    // A patterned piece carries its colour in the canvas and holds white
    // vertices, because three multiplies the two together and a tinted print is
    // a muddy print. Everything else is flat vertex colour and no map at all.
    vertexColors: true,
    map,
    ...recipe.opts,
  });
  material.transparent = false;
  material.opacity = 1;
  material.alphaTest = 0;
  material.depthWrite = true;
  inheritCharacterRig(material);
  cache.set(key, material);
  return material;
}

// ============================================================= body frames

/**
 * Everything a garment needs to know about the body it is being fitted to.
 *
 * Solved once per character and handed to every builder, so no two pieces can
 * disagree about where the waist is.
 */
function bodyFrame(def, m) {
  const g = m.girth;
  const J = m.joints;
  const H = m.height;
  const sil = { hip: 0, waist: 0, chest: 0, limbTaper: 1, ...(def.silhouette ?? {}) };
  const hipY = J.hips.y;
  const span = J.neck.y - hipY;

  const bump = (t, centre, width) => {
    const k = clamp(Math.abs(t - centre) / width, 0, 1);
    return 0.5 + 0.5 * Math.cos(k * Math.PI);
  };
  const shapeAt = (t) => 1
    + sil.hip * bump(t, -0.02, 0.42)
    + sil.waist * bump(t, 0.34, 0.34)
    + sil.chest * bump(t, 0.82, 0.42);

  /** Trunk half-widths at a world height, with clearance already applied. */
  const trunk = (y, extra = 0) => {
    const t = clamp((y - hipY) / span, -0.30, 1.06);
    let i = 0;
    while (i < TRUNK_PROFILE.length - 2 && TRUNK_PROFILE[i + 1][0] < t) i++;
    const [t0, sx0, sz0, dz0] = TRUNK_PROFILE[i];
    const [t1, sx1, sz1, dz1] = TRUNK_PROFILE[i + 1];
    const f = clamp((t - t0) / (t1 - t0 || 1), 0, 1);
    const k = clamp((t - 0.10) / 0.45, 0, 1);
    const shape = shapeAt(t);
    return {
      rx: lerp(g.hipX, g.chestX, k) * lerp(sx0, sx1, f) * shape * CLEARANCE + extra,
      rz: lerp(g.hipZ, g.chestZ, k) * lerp(sz0, sz1, f) * shape * CLEARANCE + extra,
      z: lerp(dz0, dz1, f) * H,
    };
  };

  // Limb radii, mirroring `CharacterFactory.limbRadii`'s taper so a vambrace
  // knows how thick the forearm inside it is.
  const k = sil.limbTaper;
  const taper = (root, mid, tip) => ({
    root: root * lerp(1, 1.22, k), mid: mid * lerp(1, 0.94, k), tip: tip * lerp(1, 0.80, k),
  });
  const arm = taper(g.arm, g.elbow, g.wrist);
  const leg = taper(g.thigh, g.knee, g.ankle);

  /** A point and an orthonormal frame at parameter `t` along a limb chain. */
  const limbAt = (aName, bName, t) => {
    const a = J[aName]; const b = J[bName];
    const p = V(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
    const axis = V(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
    const side = new THREE.Vector3().crossVectors(V(0, 0, 1), axis);
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    side.normalize();
    const front = new THREE.Vector3().crossVectors(axis, side).normalize();
    return { p, axis, side, front };
  };

  return {
    H, g, J, sil, hipY, span, trunk, arm, leg, limbAt,
    /** The belt line: the plate puts it at 0.51 H, which is `t ≈ 0.24` here. */
    waistY: hipY + span * 0.24,
    chestY: J.chest.y,
    shoulderY: J.shoulderL.y,
  };
}

// ============================================================ kind builders
//
// Each builder receives `(ctx, spec)`. `ctx.pull(recipe, bias, pattern)` returns
// the Surface for that group; everything drawn into one group ships as one mesh.
//
// `bias` is `null` for anything that *hugs* the body — plate, belts, cuffs,
// boots — and a bone name only for what genuinely hangs off it: a coat, a
// skirt, a cape, a hat. That distinction is the whole grouping strategy, and it
// is worth stating why, because getting it wrong costs draw calls by the dozen.
//
// `CharacterFactory.buildGarments` solves every piece against the bone segments
// widened 1.65×, and `attachBone` only widens *one further* bone by 2.2× on top
// of that. A greave is inside the shin's own falloff already, so naming the
// shin changes nothing about how it deforms — but it does force the greave into
// its own mesh, separate from the vambrace that named the forearm. Grouping
// eleven fitted pieces under one unbiased solve takes a dressed character from
// roughly thirty meshes (sixty draw calls once the outline hulls are counted)
// to six or seven, with identical skinning.
//
// A skirt hem is the opposite case: it sits well outside every segment's
// falloff, so without a bias its outer vertices fall through to the solver's
// nearest-bone fallback and bind rigidly, which is how a hem ends up moving in
// stair-steps. Those pieces name a bone and pay for their own mesh.

const BUILDERS = {

  // ------------------------------------------------------------ hard plate

  /**
   * Gorget: the plated ring that closes the gap between a breastplate and a
   * helm. On the knight it sits at 0.76 H and is the piece that stops the neck
   * reading as a bare tube between two costume masses.
   */
  gorget(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'plate', null, sp.pattern);
    const y = f.J.neck.y;
    const r = f.g.neck * (sp.width ?? 1.55);
    const rise = H * (sp.rise ?? 0.030);
    shell(s, {
      point: (u, v) => {
        const a = u * TAU;
        const drop = 1 - v * 0.55;
        return V(Math.cos(a) * r * (1 + v * 0.42), y - rise * 0.35 + rise * (1 - v) * 1.3, Math.sin(a) * r * (1 + v * 0.42) * 0.94 - f.g.neck * 0.10 * drop);
      },
      segU: 20, segV: 4, closedU: true,
      thickness: H * (sp.thickness ?? 0.010),
      face: ctx.col(sp.color, 'accent', sp.material ?? 'plate'),
      back: ctx.col(sp.lining ?? sp.color, 'leather', sp.material ?? 'plate'),
      rim: ctx.col(sp.rim ?? 'trim', 'trim', sp.material ?? 'plate'),
      outward: (u) => V(Math.cos(u * TAU), 0.35, Math.sin(u * TAU)),
    });
  },

  /**
   * Pauldron: a stack of overlapping lames over the shoulder.
   *
   * The plate's knight carries three on one shoulder and two on the other, each
   * a little wider and a little lower than the one above, each with its own
   * rolled lip. The asymmetry is free silhouette identity and survives to 80 px;
   * the overlap is what makes the stack read as armour rather than as a bowl.
   */
  pauldron(ctx, sp) {
    const { f, H } = ctx;
    const side = sp.side === 'L' ? 1 : -1;
    const bone = side > 0 ? 'shoulderL' : 'shoulderR';
    const s = ctx.pull(sp.material ?? 'plate', null, sp.pattern);
    const j = f.J[bone];
    const lames = clamp(sp.lames ?? 3, 1, 5);
    const r0 = f.arm.root * (sp.spread ?? 2.15);
    const faceC = ctx.col(sp.color, 'accent', sp.material ?? 'plate');
    const rimC = ctx.col(sp.rim ?? 'trim', 'trim', sp.material ?? 'plate');
    const backC = ctx.col(sp.lining ?? 'leather', 'leather', sp.material ?? 'plate');
    for (let k = 0; k < lames; k++) {
      const t = k / Math.max(1, lames - 1);
      const rx = r0 * (0.78 + t * 0.30);
      const ry = f.arm.root * (1.35 + t * 0.22);
      const cy = j.y + f.arm.root * (0.42 - t * 0.86);
      const cx = j.x * 1.10 + side * f.arm.root * t * 0.30;
      // Each lame is a band of latitude on its own ellipsoid, opened toward the
      // outboard side so the inner edge is buried in the deltoid.
      shell(s, {
        point: (u, v) => {
          const a = lerp(-Math.PI * 0.92, Math.PI * 0.92, u);
          const phi = lerp(0.62, -0.30, v);
          const cr = Math.pow(Math.cos(phi), 0.9);
          // Wraps from just inboard of the deltoid, over the outside of the
          // shoulder, to just inboard again — so both u-edges are buried and
          // only the rolled lower rim is on the silhouette.
          return V(cx + side * rx * cr * (0.45 + 0.55 * Math.cos(a)),
            cy + ry * Math.sin(phi),
            Math.sin(a) * rx * 0.92 * cr);
        },
        segU: 14, segV: 5,
        thickness: H * (sp.thickness ?? 0.011),
        roll: H * 0.012,
        face: faceC, back: backC, rim: rimC,
        outward: (u, v) => V(side * 0.55, 0.62 - v, Math.sin(lerp(-Math.PI * 0.92, Math.PI * 0.92, u))),
      });
    }
  },

  /**
   * Breastplate: a domed shell over the chest with a rolled rim and, where the
   * roster asks for one, an embossed device.
   *
   * Measured span on the plate is 0.23 H, top edge at the collarbone and lower
   * edge on the belt, which is what the defaults below reproduce.
   */
  breastplate(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'plate', null, sp.pattern);
    const top = lerp(f.waistY, f.J.neck.y, sp.top ?? 0.86);
    const bot = lerp(f.waistY, f.J.neck.y, sp.bottom ?? 0.02);
    const wrap = (sp.wrap ?? 0.62) * Math.PI;
    shell(s, {
      point: (u, v) => {
        const y = lerp(top, bot, v);
        const t = f.trunk(y, H * (sp.stand ?? 0.006));
        const a = Math.PI * 0.5 + lerp(-wrap, wrap, u);
        // A breastplate is not a cylinder: it swells over the sternum and pulls
        // in at the waist, which is the curvature the rim light runs along.
        const dome = 1 + 0.14 * Math.sin(Math.PI * v) * Math.cos(lerp(-wrap, wrap, u) * 0.9);
        return V(Math.cos(a) * t.rx * dome, y, t.z + Math.sin(a) * t.rz * dome);
      },
      segU: 14, segV: 7,
      thickness: H * (sp.thickness ?? 0.012),
      face: ctx.col(sp.color, 'identity', sp.material ?? 'plate'),
      back: ctx.col(sp.lining ?? 'leather', 'leather', sp.material ?? 'plate'),
      rim: ctx.col(sp.rim ?? 'trim', 'trim', sp.material ?? 'plate'),
      uv: (u, v) => [u, 1 - v],
      outward: (u) => {
        const a = Math.PI * 0.5 + lerp(-wrap, wrap, u);
        return V(Math.cos(a), 0, Math.sin(a));
      },
    });
  },

  /**
   * Fauld: the skirt of plate hanging off the belt, optionally cut into tabs.
   *
   * On the knight it drops 0.26 H to a pointed lower plate; on a smith it is a
   * fan of hanging leather tabs. Both are the same builder with `tabs` set,
   * because the difference is a cut, not a garment.
   */
  fauld(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'plate', 'hips', sp.pattern);
    const y0 = f.waistY - H * 0.008;
    const drop = H * (sp.drop ?? 0.24);
    const tabs = sp.tabs ?? 0;
    const wrap = (sp.wrap ?? 1.0) * Math.PI;
    const faceC = ctx.col(sp.color, 'identity', sp.material ?? 'plate');
    const rimC = ctx.col(sp.rim ?? 'accent', 'accent', sp.material ?? 'plate');
    const backC = ctx.col(sp.lining ?? 'leather', 'leather', sp.material ?? 'plate');

    if (tabs > 0) {
      // Separate hanging tabs: a broken lower silhouette, which is what a tool
      // skirt or a lamellar fauld actually looks like from the side.
      for (let k = 0; k < tabs; k++) {
        const mid = Math.PI * 0.5 + lerp(-wrap, wrap, (k + 0.5) / tabs);
        const halfA = (wrap / tabs) * 0.78;
        const len = drop * (0.82 + 0.30 * Math.cos(((k + 0.5) / tabs - 0.5) * Math.PI));
        shell(s, {
          point: (u, v) => {
            const y = y0 - len * v;
            const t = f.trunk(Math.max(y, f.hipY - H * 0.02), H * 0.004);
            const a = mid + lerp(-halfA, halfA, u) * (1 + v * 0.18);
            const flare = 1 + v * (sp.flare ?? 0.16);
            return V(Math.cos(a) * t.rx * flare, y, t.z + Math.sin(a) * t.rz * flare);
          },
          segU: 5, segV: 4,
          thickness: H * (sp.thickness ?? 0.008),
          // A hanging tab is a hem on three of its four sides.
          roll: H * HEM.roll,
          face: faceC, back: backC, rim: rimC,
          outward: (u) => { const a = mid + lerp(-halfA, halfA, u); return V(Math.cos(a), 0, Math.sin(a)); },
        });
      }
      return;
    }

    // One continuous apron of plate, tapering to a point on the centreline —
    // the shield-shaped lower plate the knight carries between his thighs.
    shell(s, {
      point: (u, v) => {
        const a = Math.PI * 0.5 + lerp(-wrap, wrap, u);
        const point = 1 - Math.abs(u - 0.5) * 2;
        const y = y0 - drop * v * (0.45 + 0.55 * Math.pow(point, 0.6));
        const t = f.trunk(Math.max(y, f.hipY - H * 0.02), H * 0.004);
        const flare = 1 + v * (sp.flare ?? 0.14);
        return V(Math.cos(a) * t.rx * flare, y, t.z + Math.sin(a) * t.rz * flare);
      },
      segU: 18, segV: 5,
      thickness: H * (sp.thickness ?? 0.010),
      face: faceC, back: backC, rim: rimC,
      outward: (u) => { const a = Math.PI * 0.5 + lerp(-wrap, wrap, u); return V(Math.cos(a), 0, Math.sin(a)); },
    });
  },

  /** Vambrace: a plated or laced cuff over the forearm, open at the back. */
  vambrace(ctx, sp) {
    const { f, H } = ctx;
    for (const side of sides(sp.side)) {
      const sfx = side > 0 ? 'L' : 'R';
      const s = ctx.pull(sp.material ?? 'plate', null, sp.pattern);
      const t0 = sp.from ?? 0.18;
      const t1 = sp.to ?? 0.92;
      const wrap = (sp.wrap ?? 0.80) * Math.PI;
      shell(s, {
        point: (u, v) => {
          const fr = f.limbAt(`forearm${sfx}`, `hand${sfx}`, lerp(t0, t1, v));
          const r = lerp(f.arm.mid, f.arm.tip, v) * (sp.fit ?? 1.30);
          const a = lerp(-wrap, wrap, u);
          return fr.p.clone()
            .addScaledVector(fr.side, Math.cos(a) * r)
            .addScaledVector(fr.front, Math.sin(a) * r);
        },
        segU: 12, segV: 4,
        thickness: H * (sp.thickness ?? 0.009),
        face: ctx.col(sp.color, 'accent', sp.material ?? 'plate'),
        back: ctx.col(sp.lining ?? 'leather', 'leather', sp.material ?? 'plate'),
        rim: ctx.col(sp.rim ?? 'trim', 'trim', sp.material ?? 'plate'),
      });
      if (sp.studs) {
        const st = ctx.pull('trim', null);
        st.ink(ctx.col(sp.studColor ?? 'metal', 'metal', 'trim'));
        for (let k = 0; k < sp.studs; k++) {
          const fr = f.limbAt(`forearm${sfx}`, `hand${sfx}`, lerp(t0 + 0.10, t1 - 0.10, k / Math.max(1, sp.studs - 1)));
          const r = f.arm.mid * (sp.fit ?? 1.30) * 1.02;
          const p = fr.p.clone().addScaledVector(fr.front, r);
          blob(st, { cx: p.x, cy: p.y, cz: p.z, rx: H * 0.008, ry: H * 0.008, rz: H * 0.008, eU: 0.7, eV: 0.7, segU: 8, segV: 5 });
        }
      }
    }
  },

  /** Cuisse: the thigh plate, hung from the fauld and covering the front only. */
  cuisse(ctx, sp) {
    const { f, H } = ctx;
    for (const side of sides(sp.side)) {
      const sfx = side > 0 ? 'L' : 'R';
      const s = ctx.pull(sp.material ?? 'plate', null, sp.pattern);
      const wrap = (sp.wrap ?? 0.56) * Math.PI;
      shell(s, {
        point: (u, v) => {
          const fr = f.limbAt(`thigh${sfx}`, `shin${sfx}`, lerp(sp.from ?? 0.16, sp.to ?? 0.82, v));
          const r = lerp(f.leg.root, f.leg.mid, v) * (sp.fit ?? 1.24);
          const a = lerp(-wrap, wrap, u);
          return fr.p.clone()
            .addScaledVector(fr.front, Math.cos(a) * r)
            .addScaledVector(fr.side, Math.sin(a) * r);
        },
        segU: 10, segV: 5,
        thickness: H * (sp.thickness ?? 0.011),
        face: ctx.col(sp.color, 'accent', sp.material ?? 'plate'),
        back: ctx.col(sp.lining ?? 'leather', 'leather', sp.material ?? 'plate'),
        rim: ctx.col(sp.rim ?? 'trim', 'trim', sp.material ?? 'plate'),
      });
    }
  },

  /** Greave: the shin plate, plus the knee cuff band above it. */
  greave(ctx, sp) {
    const { f, H } = ctx;
    for (const side of sides(sp.side)) {
      const sfx = side > 0 ? 'L' : 'R';
      const s = ctx.pull(sp.material ?? 'plate', null, sp.pattern);
      const wrap = (sp.wrap ?? 0.62) * Math.PI;
      shell(s, {
        point: (u, v) => {
          const fr = f.limbAt(`shin${sfx}`, `foot${sfx}`, lerp(sp.from ?? 0.10, sp.to ?? 0.86, v));
          const r = lerp(f.leg.mid, f.leg.tip, v) * (sp.fit ?? 1.32);
          const a = lerp(-wrap, wrap, u);
          return fr.p.clone()
            .addScaledVector(fr.front, Math.cos(a) * r)
            .addScaledVector(fr.side, Math.sin(a) * r);
        },
        segU: 10, segV: 5,
        thickness: H * (sp.thickness ?? 0.010),
        face: ctx.col(sp.color, 'accent', sp.material ?? 'plate'),
        back: ctx.col(sp.lining ?? 'leather', 'leather', sp.material ?? 'plate'),
        rim: ctx.col(sp.rim ?? 'trim', 'trim', sp.material ?? 'plate'),
      });
      if (sp.knee !== false) {
        // The dark stitched band over the knee — 0.066 H on the plate, and the
        // one place the leg's silhouette changes between hip and ankle.
        const ks = ctx.pull(sp.kneeMaterial ?? 'leather', null);
        ks.ink(ctx.col(sp.kneeColor ?? 'leather', 'leather', sp.kneeMaterial ?? 'leather'));
        const fr = f.limbAt(`shin${sfx}`, `foot${sfx}`, 0.04);
        sweep(ks,
          [fr.p.clone().addScaledVector(fr.axis, -H * 0.030), fr.p.clone().addScaledVector(fr.axis, H * 0.030)],
          section(12, 0.72),
          () => { const r = f.leg.mid * 1.38; return [r, r]; },
          { capStart: true, capEnd: true });
      }
    }
  },

  // -------------------------------------------------------------- outerwear

  /**
   * Long coat: the single biggest garment in the catalogue and the one the
   * plates give the most evidence for.
   *
   * Built as a lofted shell around the trunk with a wedge removed at the front
   * — that wedge *is* the split, and the shell's u-edge rims are the two front
   * panel edges. It flares from the shoulder to more than twice shoulder width
   * at the hem (measured 0.21 H → 0.47 H on the staff-mage), and its hem rim
   * carries the piped edge every coat in the plates has.
   *
   * The lapels and the buttoned placket are separate pieces so they can carry
   * their own colour and their own rolled edge; the embroidery arrives as a
   * pattern banded to the lower third, which is exactly where the plate puts it.
   */
  longcoat(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'panel', 'chest', sp.pattern);
    const top = lerp(f.J.chest.y, f.J.neck.y, sp.top ?? 0.55);
    const hemY = f.J.footL.y + H * (sp.hem ?? 0.10);
    const gap = (sp.gap ?? 0.20) * Math.PI;
    const flare = sp.flare ?? 2.30;
    const faceC = ctx.col(sp.color, 'identity', sp.material ?? 'panel');
    const point = (u, v) => {
      const y = lerp(top, hemY, Math.pow(v, sp.hang ?? 1.0));
      const t = f.trunk(y, H * 0.010 + H * LAYER * 0.10);
      // Below the hip the trunk table has nothing to say, so the coat becomes a
      // free cone: this is the flare that takes it past shoulder width.
      const below = clamp((f.hipY - y) / (f.hipY - hemY || 1), 0, 1);
      const k = 1 + below * (flare - 1);
      const a = Math.PI * 0.5 + gap * 0.5 + u * (TAU - gap);
      return V(Math.cos(a) * t.rx * k, y, t.z + Math.sin(a) * t.rz * k);
    };
    shell(s, {
      point, segU: 26, segV: 9,
      thickness: H * (sp.thickness ?? HEM.thickness),
      // Hem *and* both front panel edges — the coat's rim is one closed walk —
      // so raising this is what puts a visible turned edge down the split as
      // well as along the bottom, which is where the plate's coat reads thick.
      roll: H * HEM.roll,
      face: faceC,
      back: ctx.col(sp.lining ?? 'trim', 'trim', sp.material ?? 'panel'),
      rim: ctx.col(sp.piping ?? sp.lining ?? 'trim', 'trim', sp.material ?? 'panel'),
      // No UV scale here, on purpose — see `resolveRepeat`. The coat's tiling
      // lives in the roster's `pattern.repeat` and nowhere else.
      outward: (u) => {
        const a = Math.PI * 0.5 + gap * 0.5 + u * (TAU - gap);
        return V(Math.cos(a), 0, Math.sin(a));
      },
    });

    // Buttoned placket down the wearer's right front edge.
    if (sp.buttons) {
      const bs = ctx.pull('trim', null);
      bs.ink(ctx.col(sp.buttonColor ?? 'accent', 'accent', 'trim'));
      for (let k = 0; k < sp.buttons; k++) {
        const v = 0.06 + (k / Math.max(1, sp.buttons - 1)) * (sp.buttonSpan ?? 0.42);
        const p = point(0.012, v);
        blob(bs, { cx: p.x, cy: p.y, cz: p.z, rx: H * 0.008, ry: H * 0.008, rz: H * 0.005, eU: 0.75, eV: 0.6, segU: 8, segV: 5 });
      }
    }
  },

  /**
   * Notched lapel: the folded-back collar wing that sits on top of a coat.
   *
   * A bilinear patch between four solved corners with an outward fold, rather
   * than a cut-out of the coat, because the plate's lapels stand clear of the
   * chest and cast their own edge — which is the read that says "tailored"
   * rather than "printed on".
   */
  lapel(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'cloth', null, sp.pattern);
    const top = lerp(f.J.chest.y, f.J.neck.y, sp.top ?? 0.92);
    const bot = lerp(f.J.chest.y, f.J.neck.y, sp.bottom ?? -0.55);
    const faceC = ctx.col(sp.color, 'trim', sp.material ?? 'cloth');
    const backC = ctx.col(sp.lining ?? sp.color, 'identity', sp.material ?? 'cloth');
    for (const side of [1, -1]) {
      shell(s, {
        point: (u, v) => {
          const y = lerp(top, bot, v);
          const t = f.trunk(y, H * (0.014 + LAYER * 0.12));
          // The notch: the lapel is widest a third of the way down and narrows
          // to a point at the bottom, and folds further out as it rises.
          const spread = (sp.width ?? 0.42) * (0.35 + 0.95 * Math.sin(Math.PI * Math.pow(1 - v, 0.75)));
          const a = Math.PI * 0.5 + side * lerp(0.03, spread, u) * Math.PI;
          const out = 1 + u * (sp.fold ?? 0.16) * (1 - v * 0.5);
          return V(Math.cos(a) * t.rx * out, y, t.z + Math.sin(a) * t.rz * out);
        },
        segU: 6, segV: 6,
        thickness: H * (sp.thickness ?? HEM.thickness),
        roll: H * HEM.edge,
        face: faceC, back: backC, rim: faceC,
        outward: V(0, 0.25, 1),
      });
    }
  },

  /**
   * Turned cuff. `rolls` stacks two or three of them for a sleeve that has been
   * turned back more than once — the staff-mage's coat cuffs, and the read
   * WORLD_BIBLE asks for on a coat that does not fit its wearer.
   */
  cuff(ctx, sp) {
    const { f, H } = ctx;
    for (const side of sides(sp.side)) {
      const sfx = side > 0 ? 'L' : 'R';
      const s = ctx.pull(sp.material ?? 'cloth', null, sp.pattern);
      const rolls = clamp(sp.rolls ?? 1, 1, 3);
      const faceC = ctx.col(sp.color, 'trim', sp.material ?? 'cloth');
      const backC = ctx.col(sp.lining ?? 'identity', 'identity', sp.material ?? 'cloth');
      for (let k = 0; k < rolls; k++) {
        const t0 = (sp.at ?? 0.72) - k * (sp.pitch ?? 0.19);
        shell(s, {
          point: (u, v) => {
            const fr = f.limbAt(`forearm${sfx}`, `hand${sfx}`, clamp(t0 + v * (sp.height ?? 0.20), -0.4, 1.2));
            // A turned cuff is *wider at its free edge* — that flare is the
            // whole tell, and a straight band reads as a painted stripe.
            const r = lerp(f.arm.mid, f.arm.tip, clamp(t0, 0, 1)) * (sp.fit ?? 1.34) * (1 + (1 - v) * (sp.flare ?? 0.26));
            const a = u * TAU;
            return fr.p.clone().addScaledVector(fr.side, Math.cos(a) * r).addScaledVector(fr.front, Math.sin(a) * r);
          },
          segU: 14, segV: 3, closedU: true,
          thickness: H * (sp.thickness ?? HEM.thickness),
          // The free edge of a turned cuff is the whole read; it is the one
          // hem on the character that sits next to a hand and gets looked at.
          roll: H * HEM.edge,
          face: faceC, back: backC, rim: ctx.col(sp.rim ?? sp.color, 'trim', sp.material ?? 'cloth'),
        });
      }
    }
  },

  /** Work apron: a stiff bib and skirt hung from the neck, bound at the edge. */
  apron(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'panel', 'chest', sp.pattern);
    const top = lerp(f.J.chest.y, f.J.neck.y, sp.top ?? 0.70);
    const bot = f.hipY - H * (sp.drop ?? 0.22);
    shell(s, {
      point: (u, v) => {
        const y = lerp(top, bot, v);
        const t = f.trunk(y, H * (0.012 + LAYER * 0.10));
        // Narrow bib over the chest, widening into a full apron below the belt.
        const wide = lerp(sp.bib ?? 0.30, sp.skirt ?? 0.62, Math.pow(v, 0.7)) * Math.PI;
        const a = Math.PI * 0.5 + lerp(-wide, wide, u);
        const k = 1 + Math.max(0, (f.hipY - y) / (f.hipY - bot || 1)) * (sp.flare ?? 0.20);
        return V(Math.cos(a) * t.rx * k, y, t.z + Math.sin(a) * t.rz * k);
      },
      segU: 14, segV: 7,
      thickness: H * (sp.thickness ?? 0.010),
      // An apron is bound all round with a contrasting tape, and that binding
      // is the thickest edge on the character wearing it.
      roll: H * HEM.roll,
      face: ctx.col(sp.color, 'identity', sp.material ?? 'panel'),
      back: ctx.col(sp.lining ?? 'leather', 'leather', sp.material ?? 'panel'),
      rim: ctx.col(sp.binding ?? 'trim', 'trim', sp.material ?? 'panel'),
      uv: (u, v) => [u, 1 - v],
      outward: V(0, 0, 1),
    });
    // Neck strap, so the apron is worn rather than floating.
    if (sp.strap !== false) {
      const ss = ctx.pull(sp.strapMaterial ?? 'leather', null);
      ss.ink(ctx.col(sp.strapColor ?? 'leather', 'leather', 'leather'));
      const t = f.trunk(top, H * 0.014);
      for (const side of [1, -1]) {
        sweep(ss, [
          V(side * t.rx * 0.42, top, t.z + t.rz * 0.86),
          V(side * f.g.neck * 0.95, f.J.neck.y + f.g.neck * 0.55, t.z + f.g.neck * 0.30),
          V(side * f.g.neck * 0.70, f.J.neck.y + f.g.neck * 0.60, -f.g.neck * 0.75),
        ], section(6, 0.5), () => [H * 0.008, H * 0.004], { capStart: true, capEnd: true });
      }
    }
  },

  /** Short shoulder cape or mantle, optionally fur-trimmed along its hem. */
  cape(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'panel', 'chest', sp.pattern);
    const top = lerp(f.J.chest.y, f.J.neck.y, sp.top ?? 0.80);
    const bot = top - H * (sp.length ?? 0.20);
    const wrap = (sp.wrap ?? 0.86) * Math.PI;
    const phase = sp.front ? Math.PI * 0.5 : -Math.PI * 0.5;
    const point = (u, v) => {
      const y = lerp(top, bot, v);
      const t = f.trunk(Math.max(y, f.hipY), H * (0.016 + LAYER * 0.16));
      const a = phase + lerp(-wrap, wrap, u);
      const k = 1 + v * (sp.flare ?? 0.34);
      return V(Math.cos(a) * t.rx * k, y, t.z + Math.sin(a) * t.rz * k);
    };
    shell(s, {
      point, segU: 18, segV: 5,
      thickness: H * (sp.thickness ?? HEM.thickness),
      roll: H * HEM.roll,
      face: ctx.col(sp.color, 'cape', sp.material ?? 'panel'),
      back: ctx.col(sp.lining ?? 'capeLining', 'capeLining', sp.material ?? 'panel'),
      rim: ctx.col(sp.piping ?? sp.lining ?? 'trim', 'trim', sp.material ?? 'panel'),
      // No UV scale — `pattern.repeat` is the cape's only tiling control.
      outward: (u) => { const a = phase + lerp(-wrap, wrap, u); return V(Math.cos(a), 0, Math.sin(a)); },
    });
    if (sp.furTrim) {
      // The ninja's cape carries fur along its whole leading edge, and the
      // irregularity of that edge is most of what it contributes to the
      // silhouette. Tufts are rooted *inside* the panel so no cap disc shows.
      const fs = ctx.pull('fur', 'chest');
      const furC = ctx.col(sp.furColor ?? 'trim', 'trim', 'fur');
      const furS = ctx.col(sp.furShade ?? sp.furColor ?? 'leather', 'leather', 'fur');
      for (let k = 0; k <= 26; k++) {
        const u = k / 26;
        const root = point(u, 0.94);
        const outp = point(u, 1.0);
        const dir = outp.clone().sub(root).normalize();
        const len = H * (sp.furLength ?? 0.030) * (0.62 + ctx.rng.next() * 0.75);
        // Continuous tonal spread rather than a hard every-other alternation:
        // two colours in strict rotation read as a stripe, not as fur.
        fs.ink(_ink.copy(furS).lerp(furC, 0.15 + ctx.rng.next() * 0.85));
        sweep(fs, [
          root.clone().addScaledVector(dir, -H * 0.010),
          root.clone().addScaledVector(dir, len * 0.5),
          root.clone().addScaledVector(dir, len).add(V(ctx.rng.jitter(H * 0.010), -len * 0.35, ctx.rng.jitter(H * 0.010))),
        ], section(5, 0.8), (i) => { const r = H * 0.014 * [1, 0.85, 0.06][i]; return [r, r]; }, { capStart: true, capEnd: true });
      }
    }
  },

  /** Hood: a shell lying back over the shoulders, open at the front. */
  hood(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'panel', 'chest', sp.pattern);
    const hd = ctx.m.head;
    shell(s, {
      point: (u, v) => {
        const a = Math.PI * 1.5 + lerp(-Math.PI * (sp.wrap ?? 0.62), Math.PI * (sp.wrap ?? 0.62), u);
        // A cowl that has been pushed back: a bag hanging behind the neck whose
        // upper rim brushes the nape and whose lower end swings free.
        const rise = lerp(hd.center.y - hd.ry * 0.15, f.J.chest.y, v);
        const r = lerp(hd.rx * 1.30, hd.rx * 1.05, v);
        const back = lerp(-hd.rz * 0.55, -hd.rz * 1.45, Math.sin(Math.PI * v * 0.7));
        return V(Math.cos(a) * r, rise, back + Math.sin(a) * r * 0.55);
      },
      segU: 14, segV: 6,
      thickness: H * (sp.thickness ?? HEM.thickness),
      roll: H * HEM.roll,
      face: ctx.col(sp.color, 'identity', sp.material ?? 'panel'),
      back: ctx.col(sp.lining ?? 'trim', 'trim', sp.material ?? 'panel'),
      rim: ctx.col(sp.piping ?? 'trim', 'trim', sp.material ?? 'panel'),
      outward: V(0, 0.2, -1),
    });
  },

  // ----------------------------------------------------------- skirts

  /**
   * Flared skirt with a piped hem.
   *
   * Measured on the hat-mage: **0.41 H long**, hem **0.40 H across**, with a
   * pale piped edge running the whole circumference and visible panel gores.
   *
   * `flare` is hem radius over the *hip ring*, which is not the 2.9:1 the plate
   * gives for hem-over-visible-waist — the skirt is cut from the hip, and this
   * roster's hip ring is about 0.094 H in half-width once clearance is on it,
   * so 0.40 H of hem is 0.20 / 0.094 ≈ **2.15**. Authoring the plate's ratio
   * directly produces a 0.57 H hem, which is half again too wide and reads as a
   * crinoline. The number the plate actually fixes is the hem *width*; the
   * ratio depends on where the garment is cut from.
   *
   * `gores` scallops the hem so the panel seams read — a perfectly circular hem
   * is the tell that a skirt is a cone rather than cloth.
   */
  skirt(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'panel', 'hips', sp.pattern);
    const top = sp.top !== undefined ? lerp(f.hipY, f.J.neck.y, sp.top) : f.waistY;
    const flare = sp.flare ?? 2.15;
    const gores = sp.gores ?? 8;
    const sag = sp.sag ?? 0.05;
    // A hem is never allowed through the floor, whatever the roster asks for.
    // Skirt length is authored against body height and the waist sits at a
    // different fraction of it on every character, so a length that clears the
    // ground on a 1.26-unit dragoon drags on a 1.06-unit oracle — and cloth
    // through the stage is the one costume failure that cannot be shaded away.
    const len = Math.min(H * (sp.length ?? 0.41), (top - H * 0.015) / (1 + sag));
    shell(s, {
      point: (u, v) => {
        const a = u * TAU;
        const y = top - len * v;
        const t = f.trunk(Math.max(y, f.hipY - H * 0.01), H * 0.006);
        const wave = 1 + Math.cos(a * gores) * (sp.goreDepth ?? 0.05) * v;
        const k = (1 + v * (flare - 1)) * wave;
        return V(Math.cos(a) * t.rx * k, y - v * v * len * sag, t.z + Math.sin(a) * t.rz * k);
      },
      segU: 30, segV: 6, closedU: true,
      thickness: H * (sp.thickness ?? HEM.thickness),
      // The piped hem, measured on the hat-mage as a pale line running the
      // whole circumference: a rolled rim in the trim colour, standing proud
      // enough to survive the downscale. `HEM.roll` is that measurement.
      roll: H * (sp.piped === false ? HEM.edge : HEM.roll),
      face: ctx.col(sp.color, 'identity', sp.material ?? 'panel'),
      back: ctx.col(sp.lining ?? 'secondary', 'secondary', sp.material ?? 'panel'),
      rim: ctx.col(sp.pipingColor ?? 'trim', 'trim', sp.material ?? 'panel'),
      // No UV scale — the print's tiling is `pattern.repeat` alone. This line
      // used to multiply u by three on top of it, which is what turned Seren's
      // petticoat weave into a magenta/white check; see `resolveRepeat`.
      outward: (u) => V(Math.cos(u * TAU), 0, Math.sin(u * TAU)),
    });
  },

  /**
   * Underskirt: the same cone, shorter or longer and in another colour.
   *
   * A second hem line under the first is the cheapest layering read there is —
   * it doubles the number of horizontal edges at the bottom of the silhouette,
   * which is where the eye lands when a figure is eighty pixels tall.
   */
  underskirt(ctx, sp) {
    BUILDERS.skirt(ctx, {
      material: 'panel',
      length: 0.46, flare: 1.80, gores: 6, goreDepth: 0.03,
      color: 'secondary', lining: 'secondary', pipingColor: 'trim',
      ...sp,
    });
  },

  // ------------------------------------------------------------- soft goods

  /**
   * Collar. Four cuts, all from the plates: `stand` (a military band),
   * `popped` (a coat collar turned up at the back), `sailor` (the hat-mage's
   * broad flat shawl collar) and `wrap` (a soft crossed one).
   */
  collar(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'cloth', 'chest', sp.pattern);
    const cut = sp.cut ?? 'stand';
    const y = f.J.neck.y;
    const faceC = ctx.col(sp.color, 'trim', sp.material ?? 'cloth');
    const backC = ctx.col(sp.lining ?? 'identity', 'identity', sp.material ?? 'cloth');
    const rimC = ctx.col(sp.piping ?? sp.color, 'trim', sp.material ?? 'cloth');
    // The collar must never close over the jaw — the review found a bone band
    // across Yshara's mouth when a height authored in neck radii met a neck
    // whose girth had been retuned. Solved against the jaw, not authored.
    const jaw = ctx.m.head.center.y - ctx.m.head.ry * 0.98;

    if (cut === 'sailor') {
      // A broad flat shawl lying *on* the shoulders — the hat-mage's collar,
      // which is one continuous piece from the throat out to the deltoids and
      // down the back. Its whole read is that it is nearly horizontal, so it is
      // lofted from a small ring at the neck out to a wide ring at the chest
      // while dropping only a fifteenth of body height.
      const wide = sp.width ?? 1.06;
      const gap = Math.PI * (sp.gap ?? 0.16);
      shell(s, {
        point: (u, v) => {
          const a = Math.PI * 0.5 + gap * 0.5 + u * (TAU - gap);
          const drop = y - H * (sp.drop ?? 0.075) * Math.pow(v, 1.3);
          const t = f.trunk(drop, H * (0.010 + LAYER * 0.10));
          const rx = lerp(f.g.neck * 1.22, t.rx * wide, v);
          const rz = lerp(f.g.neck * 1.22, t.rz * wide * 1.10, v);
          return V(Math.cos(a) * rx, drop, t.z * v + Math.sin(a) * rz);
        },
        segU: 20, segV: 4,
        thickness: H * (sp.thickness ?? HEM.thickness * 0.85),
        // A sailor collar is seen almost edge-on from the battle camera, so its
        // turned border is nearly all of what the piece contributes — without a
        // lip it reads as a painted yoke rather than as a laid-on garment.
        roll: H * HEM.edge,
        face: faceC, back: backC, rim: rimC,
        outward: V(0, 1, -0.15),
      });
      return;
    }

    const tall = cut === 'popped' ? 1.55 : cut === 'oversized' ? 1.85 : cut === 'wrap' ? 0.95 : 1.35;
    const wide = cut === 'oversized' ? 1.55 : 1.28;
    const topY = Math.min(y + f.g.neck * 1.30 * (sp.height ?? tall), jaw - f.g.neck * 0.15);
    shell(s, {
      point: (u, v) => {
        const a = u * TAU;
        // `popped` stands tallest at the nape and lies down at the throat.
        const back = cut === 'popped' ? 0.35 + 0.65 * (0.5 - 0.5 * Math.sin(a)) : 1;
        const yy = lerp(y - f.g.neck * 0.55, topY, v * back);
        const r = f.g.neck * lerp(1.18, wide * (sp.width ?? 1), v) * (1 + v * (sp.flare ?? 0.22));
        return V(Math.cos(a) * r, yy, Math.sin(a) * r * 0.98 - f.g.neck * 0.10 * v);
      },
      segU: 18, segV: 4, closedU: true,
      thickness: H * (sp.thickness ?? HEM.thickness),
      roll: H * HEM.edge,
      face: faceC, back: backC, rim: rimC,
      outward: (u) => V(Math.cos(u * TAU), 0.30, Math.sin(u * TAU)),
    });
  },

  /**
   * Fur or feather ruff with a genuinely broken silhouette.
   *
   * The archer's collar and the ninja's cape trim are the evidence: the outline
   * is irregular at every scale, and that irregularity — not the colour — is
   * what makes it read as fur. Tufts vary in length, splay and lean; every one
   * of them is rooted *inside* a base band and tapers to a closed point, so
   * there is no open boundary anywhere for the rim light to print a bright
   * sliver on.
   *
   * `mode: 'feather'` swaps the round tuft for a broad flat plate — a mantle of
   * quills rather than a ruff — which is Yshara's read.
   */
  furCollar(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull('fur', 'chest', sp.pattern);
    const y = f.J.neck.y - f.g.neck * 0.20;
    const rBase = f.g.neck * (sp.radius ?? 1.55);
    const faceC = ctx.col(sp.color, 'trim', 'fur');
    const shadeC = ctx.col(sp.shade ?? sp.color, 'leather', 'fur');
    const feather = sp.mode === 'feather';

    // The band the tufts grow out of, so the ruff has a body under its fringe.
    s.ink(faceC);
    sweep(s, ringPath(y, rBase * 0.86, rBase * 0.86 * 0.95, 20, -f.g.neck * 0.10),
      section(8, 0.8), () => { const r = H * 0.016; return [r, r * 1.2]; },
      { capStart: false, capEnd: false });

    const n = clamp(sp.tufts ?? 22, 6, 40);
    const arc = (sp.arc ?? 1.0) * TAU;
    const start = sp.arc ? Math.PI * 0.5 - arc * 0.5 : 0;
    for (let k = 0; k < n; k++) {
      // Angle, radius and height all carry their own jitter, and that is what
      // fixes the defect rather than what decorates it. Evenly spaced tufts
      // rooted on one ring at one radius put every neighbouring pair of plates
      // on the same surface for most of their overlap, and the depth test then
      // flickers between them — the "bundle of strands that z-fight each other"
      // the review found on the bone ruff. Staggering the root is what makes
      // each overlap a definite over/under.
      const a = start + (k / n) * arc + ctx.rng.jitter((arc / n) * 0.30);
      const dirOut = V(Math.cos(a), 0, Math.sin(a) * 0.95);
      const lift = lerp(sp.liftBack ?? 0.55, sp.liftFront ?? -0.15, (Math.sin(a) + 1) * 0.5);
      const len = H * (sp.length ?? 0.055) * (0.55 + ctx.rng.next() * 0.90);
      const seat = rBase * (0.72 + ctx.rng.jitter(0.09));
      const root = V(dirOut.x * seat, y + ctx.rng.jitter(H * 0.011), dirOut.z * seat - f.g.neck * 0.10);
      const tip = root.clone()
        .addScaledVector(dirOut, len)
        .add(V(ctx.rng.jitter(len * 0.30), len * lift + ctx.rng.jitter(len * 0.22), ctx.rng.jitter(len * 0.30)));
      const mid = root.clone().lerp(tip, 0.55).add(V(0, len * 0.12, 0));
      // Strand-level tonal variation, which is what the plates' fur and feather
      // actually carry — a continuous spread between the shade and the face
      // colour, not the hard every-third-tuft alternation this used to do. The
      // `fur` recipe's opened rim supplies the sheen over the top of it.
      s.ink(_ink.copy(shadeC).lerp(faceC, 0.20 + ctx.rng.next() * 0.80));
      const w = H * (feather ? 0.030 : 0.017) * (0.7 + ctx.rng.next() * 0.6);
      sweep(s, [root.clone().addScaledVector(dirOut, -rBase * 0.30), root, mid, tip],
        feather ? section(6, 0.55) : section(5, 0.85),
        (i) => {
          const scale = [0.55, 1.0, 0.72, 0.05][i];
          return feather ? [w * scale, w * scale * 0.28] : [w * scale, w * scale];
        },
        { capStart: true, capEnd: true });
    }
  },

  /** Scarf: a wound band at the throat with one long hanging tail. */
  scarf(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'cloth', 'chest', sp.pattern);
    s.ink(ctx.col(sp.color, 'trim', sp.material ?? 'cloth'));
    const y = f.J.neck.y + f.g.neck * 0.15;
    const r = f.g.neck * 1.34;
    // Two turns, offset in height, so the wrap reads as wound cloth.
    for (let turn = 0; turn < 2; turn++) {
      const path = ringPath(y - turn * H * 0.020, r, r * 0.94, 18, -f.g.neck * 0.06);
      sweep(s, path, section(8, 0.7), () => [H * 0.016, H * 0.011], { capStart: false, capEnd: false });
    }
    const side = sp.side === 'R' ? -1 : 1;
    const drop = H * (sp.tail ?? 0.22);
    sweep(s, [
      V(side * r * 0.55, y - H * 0.020, r * 0.62),
      V(side * r * 0.80, y - drop * 0.42, r * 0.86),
      V(side * r * 0.62, y - drop * 0.82, r * 0.72),
      V(side * r * 0.90, y - drop, r * 0.94),
    ], section(6, 0.6), (i) => { const w = H * [0.020, 0.022, 0.020, 0.014][i]; return [w, w * 0.32]; },
    { capStart: true, capEnd: true });
  },

  /** Throat ribbon: a small knot with two tails. Trim-sized, face-adjacent. */
  ribbon(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'cloth', null, sp.pattern);
    s.ink(ctx.col(sp.color, 'accent', sp.material ?? 'cloth'));
    const y = f.J.neck.y + f.g.neck * (sp.at ?? 0.30);
    const z = f.g.neck * 1.12;
    // Band round the throat.
    sweep(s, ringPath(y, f.g.neck * 1.14, f.g.neck * 1.08, 16), section(6, 0.6),
      () => [H * 0.006, H * 0.004], { capStart: false, capEnd: false });
    // Two loops and two tails at the front.
    for (const side of [1, -1]) {
      blob(s, {
        cx: side * f.g.neck * 0.34, cy: y, cz: z * 0.95,
        rx: f.g.neck * 0.34, ry: f.g.neck * 0.24, rz: f.g.neck * 0.14,
        eU: 0.7, eV: 0.7, segU: 10, segV: 6,
      });
      sweep(s, [
        V(side * f.g.neck * 0.10, y - H * 0.004, z),
        V(side * f.g.neck * 0.30, y - H * (sp.tail ?? 0.055) * 0.6, z * 1.02),
        V(side * f.g.neck * 0.18, y - H * (sp.tail ?? 0.055), z * 0.98),
      ], section(5, 0.5), (i) => { const w = H * [0.008, 0.009, 0.007][i]; return [w, w * 0.30]; },
      { capStart: true, capEnd: true });
    }
  },

  /**
   * Soft tall hat — the hat-mage's beret, measured at 2.1× head width with a
   * pompom and a beaded under-band. The crown is wide and *soft*: it overhangs
   * the band all the way round, which is the only thing separating a beret from
   * a bucket.
   */
  hatSoft(ctx, sp) {
    const { H } = ctx;
    const s = ctx.pull(sp.material ?? 'cloth', 'head', sp.pattern);
    const hd = ctx.m.head;
    const brimY = hd.center.y + hd.ry * (sp.sit ?? 0.62);
    const R = hd.rx * (sp.width ?? 2.05);
    const rise = hd.ry * (sp.rise ?? 0.55);
    const faceC = ctx.col(sp.color, 'trim', sp.material ?? 'cloth');
    shell(s, {
      point: (u, v) => {
        const a = u * TAU;
        // A soft crown: full width at the brim, doming over and closing to a
        // small aperture rather than to a point. A profile that reaches r = 0
        // gives the shell a degenerate ring whose finite-difference tangents
        // vanish, and the apex vertex then welds with a zero-length normal —
        // a black dot on the top of the hat. Stopping at 8% of the crown radius
        // keeps every tangent well-conditioned, and the pompom below is five
        // times wider than the aperture it covers.
        const r = R * Math.pow(Math.max(0.001, 1 - v * v * 0.985), 0.36);
        const y = brimY + rise * Math.sin(v * Math.PI * 0.5);
        return V(Math.cos(a) * r, y, Math.sin(a) * r * 0.96 - hd.rz * 0.06);
      },
      segU: 24, segV: 6, closedU: true,
      thickness: H * (sp.thickness ?? 0.008),
      face: faceC,
      back: ctx.col(sp.lining ?? 'leather', 'leather', sp.material ?? 'cloth'),
      rim: ctx.col(sp.band ?? 'accent', 'accent', sp.material ?? 'cloth'),
      outward: (u, v) => V(Math.cos(u * TAU) * (1 - v), v * 1.4 + 0.2, Math.sin(u * TAU) * (1 - v)),
    });
    // Under-band gripping the skull, and the pompom.
    const bs = ctx.pull(sp.bandMaterial ?? 'cloth', 'head');
    bs.ink(ctx.col(sp.band ?? 'accent', 'accent', sp.bandMaterial ?? 'cloth'));
    sweep(bs, ringPath(brimY - hd.ry * 0.10, hd.rx * 1.10, hd.rz * 1.10, 18, -hd.rz * 0.04),
      section(8, 0.6), () => [H * 0.008, H * 0.010], { capStart: false, capEnd: false });
    if (sp.pompom !== false) {
      const ps = ctx.pull('fur', 'head');
      ps.ink(ctx.col(sp.pompomColor ?? 'accent', 'accent', 'fur'));
      const py = brimY + rise + hd.ry * 0.18;
      blob(ps, { cx: 0, cy: py, cz: -hd.rz * 0.06, rx: hd.rx * 0.32, ry: hd.ry * 0.30, rz: hd.rz * 0.32, eU: 0.85, eV: 0.85, segU: 12, segV: 8 });
      /**
       * Ten tufts, each rooted **on the ball** rather than at its centre.
       *
       * This is the worst instance of the review's tassel finding in the file.
       * Every tuft used to start at the identical point with the identical
       * radius, so eight cap discs and eight tube mouths occupied exactly the
       * same space — coincident coplanar geometry, which is what z-fights, and
       * eight straight two-point sweeps of the same length, which is what makes
       * a bundle read as untapered matchsticks rather than as wool.
       *
       * Each strand now leaves the surface where it would actually leave it,
       * with its own length, its own thickness and a mid control point that
       * lets the tip fall away from the direction the root left in. The roots
       * sit at 0.24 of the head radius against a ball of 0.32, so every cap is
       * still buried and no open boundary is on the silhouette.
       */
      const centre = V(0, py, -hd.rz * 0.06);
      const tufts = 10;
      for (let k = 0; k < tufts; k++) {
        const a = (k / tufts) * TAU + ctx.rng.jitter(0.24);
        const rise = 0.30 + ctx.rng.next() * 0.70;
        const d = V(Math.cos(a) * (1 - rise * 0.45), rise, Math.sin(a) * (1 - rise * 0.45)).normalize();
        const len = hd.rx * (0.30 + ctx.rng.next() * 0.26);
        const root = centre.clone().addScaledVector(d, hd.rx * 0.24);
        const mid = root.clone().addScaledVector(d, len * 0.55);
        const tip = root.clone().addScaledVector(d, len)
          .add(V(ctx.rng.jitter(len * 0.22), -len * 0.30, ctx.rng.jitter(len * 0.22)));
        const w = hd.rx * (0.070 + ctx.rng.next() * 0.038);
        sweep(ps, [root, mid, tip], section(5, 0.9),
          (i) => { const r = w * [1, 0.62, 0.05][i]; return [r, r]; },
          { capStart: true, capEnd: true });
      }
    }
  },

  /**
   * Small brimmed hat, worn tilted — the archer's. Brim, crown, hatband and an
   * optional pin, all clipped to the side of the skull rather than centred on
   * it, because the tilt is the whole character note.
   */
  hatBrim(ctx, sp) {
    const { H } = ctx;
    const s = ctx.pull(sp.material ?? 'cloth', 'head', sp.pattern);
    const hd = ctx.m.head;
    const tilt = (sp.tilt ?? 0.42) * (sp.side === 'R' ? -1 : 1);
    const basis = new THREE.Matrix4()
      .makeRotationZ(tilt)
      .setPosition(V(Math.sin(tilt) * hd.rx * 0.55, hd.center.y + hd.ry * (sp.sit ?? 0.74), -hd.rz * (sp.back ?? 0.12)));
    const brimR = hd.rx * (sp.brim ?? 1.55);
    const crownR = hd.rx * (sp.crown ?? 0.92);
    const crownH = hd.ry * (sp.height ?? 0.52);
    const faceC = ctx.col(sp.color, 'leather', sp.material ?? 'cloth');
    const rimC = ctx.col(sp.band ?? 'trim', 'trim', sp.material ?? 'cloth');
    // Brim: a flat annulus with a slight upward curl at the edge.
    shell(s, {
      point: (u, v) => {
        const a = u * TAU;
        const r = lerp(crownR * 0.94, brimR, v);
        return _tmp.set(Math.cos(a) * r, Math.pow(v, 2.4) * hd.ry * 0.10, Math.sin(a) * r * 0.92).applyMatrix4(basis).clone();
      },
      segU: 20, segV: 3, closedU: true,
      thickness: H * (sp.thickness ?? 0.006),
      face: faceC, back: faceC, rim: rimC,
      outward: V(0, 1, 0).applyMatrix4(new THREE.Matrix4().makeRotationZ(tilt)),
    });
    // Crown wall, then a squashed dome plugging its top. The wall is a closed
    // shell in its own right and the dome's equator sits below the wall's top
    // rim, so there is no boundary to see through from any angle.
    shell(s, {
      point: (u, v) => {
        const a = u * TAU;
        const r = crownR * (1 - v * v * 0.12);
        return _tmp.set(Math.cos(a) * r, v * crownH, Math.sin(a) * r * 0.94).applyMatrix4(basis).clone();
      },
      segU: 18, segV: 4, closedU: true,
      thickness: H * (sp.thickness ?? 0.006),
      face: faceC, back: faceC, rim: rimC,
      outward: (u) => V(Math.cos(u * TAU), 0.2, Math.sin(u * TAU)).applyMatrix4(new THREE.Matrix4().makeRotationZ(tilt)),
    });
    s.ink(faceC);
    blob(s, {
      cy: crownH * 0.82, rx: crownR * 0.90, ry: crownH * 0.34, rz: crownR * 0.85,
      eU: 0.9, eV: 0.7, segU: 16, segV: 8, matrix: basis,
    });
    // Hatband, and a pin on the outboard side.
    const bs = ctx.pull('trim', 'head');
    bs.ink(ctx.col(sp.buckle ?? 'metal', 'metal', 'trim'));
    const pin = _tmp.set(crownR * 0.98, crownH * 0.35, 0).applyMatrix4(basis).clone();
    blob(bs, { cx: pin.x, cy: pin.y, cz: pin.z, rx: H * 0.010, ry: H * 0.008, rz: H * 0.005, eU: 0.4, eV: 0.4, segU: 8, segV: 5 });
    const cs = ctx.pull(sp.material ?? 'cloth', 'head');
    cs.ink(ctx.col(sp.band ?? 'trim', 'trim', sp.material ?? 'cloth'));
    const bandPath = [];
    for (let i = 0; i <= 18; i++) {
      const a = (i / 18) * TAU;
      bandPath.push(_tmp.set(Math.cos(a) * crownR * 1.02, crownH * 0.22, Math.sin(a) * crownR * 0.96).applyMatrix4(basis).clone());
    }
    sweep(cs, bandPath, section(6, 0.5), () => [H * 0.006, H * 0.008], { capStart: false, capEnd: false });
  },

  // -------------------------------------------------------------- hardware

  /**
   * Belt with real buckle hardware: strap, buckle frame, tongue and a hanging
   * strap end. Measured on the knight at 0.036 H thick with a 0.083 × 0.055 H
   * buckle plate, which is a *large* piece of hardware relative to the figure —
   * hardware that scales like jewellery disappears at battle distance.
   */
  belt(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'leather', null, sp.pattern);
    const y = sp.at === 'hip' ? f.hipY + f.g.hipX * 0.10 : f.waistY + H * (sp.raise ?? 0);
    const t = f.trunk(y, H * (0.008 + LAYER * (sp.over ?? 0.20)));
    const w = H * (sp.width ?? 0.036);
    s.ink(ctx.col(sp.color, 'leather', sp.material ?? 'leather'));
    sweep(s, ringPath(y, t.rx, t.rz, 26, t.z), section(10, 0.45),
      () => [H * 0.008, w * 0.5], { capStart: false, capEnd: false });

    // Buckle: a frame, not a plate — the hole is what says "buckle" at 80 px.
    const hs = ctx.pull('trim', null);
    hs.ink(ctx.col(sp.buckle ?? 'metal', 'metal', 'trim'));
    const bw = H * (sp.buckleWidth ?? 0.083) * 0.5;
    const bh = H * (sp.buckleHeight ?? 0.055) * 0.5;
    const zf = t.z + t.rz * 1.02;
    const frame = H * 0.011;
    for (const [ox, oy, rx, ry] of [
      [0, bh - frame * 0.5, bw, frame * 0.5],
      [0, -bh + frame * 0.5, bw, frame * 0.5],
      [-bw + frame * 0.5, 0, frame * 0.5, bh],
      [bw - frame * 0.5, 0, frame * 0.5, bh],
    ]) {
      blob(hs, { cx: ox, cy: y + oy, cz: zf, rx, ry, rz: H * 0.008, eU: 0.30, eV: 0.30, segU: 8, segV: 5 });
    }
    // Tongue across the frame.
    blob(hs, { cx: 0, cy: y, cz: zf + H * 0.004, rx: bw * 0.14, ry: bh * 0.92, rz: H * 0.005, eU: 0.4, eV: 0.4, segU: 6, segV: 5 });

    if (sp.tail !== false) {
      const side = sp.tailSide === 'R' ? -1 : 1;
      s.ink(ctx.col(sp.color, 'leather', sp.material ?? 'leather'));
      const a0 = Math.PI * 0.5 - side * 0.55;
      const p0 = V(Math.cos(a0) * t.rx, y, t.z + Math.sin(a0) * t.rz);
      sweep(s, [p0,
        p0.clone().add(V(side * H * 0.010, -H * 0.045, H * 0.004)),
        p0.clone().add(V(side * H * 0.022, -H * 0.090, -H * 0.002))],
      section(6, 0.4), (i) => { const k = [1, 0.95, 0.72][i]; return [H * 0.007 * k, w * 0.45 * k]; },
      { capStart: true, capEnd: true });
    }
  },

  /** Wide wrap sash or obi — a soft belt that reads as a colour block. */
  sash(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'cloth', null, sp.pattern);
    const y = f.waistY + H * (sp.raise ?? 0.010);
    const w = H * (sp.width ?? 0.075);
    shell(s, {
      point: (u, v) => {
        const a = u * TAU;
        const yy = y + w * (0.5 - v);
        const t = f.trunk(yy, H * (0.008 + LAYER * 0.18));
        // Slight barrel so the wrap reads as cloth pulled tight, not a tube.
        const k = 1 + Math.sin(Math.PI * v) * 0.05;
        return V(Math.cos(a) * t.rx * k, yy, t.z + Math.sin(a) * t.rz * k);
      },
      segU: 22, segV: 3, closedU: true,
      thickness: H * (sp.thickness ?? HEM.thickness),
      roll: H * HEM.edge,
      face: ctx.col(sp.color, 'secondary', sp.material ?? 'cloth'),
      back: ctx.col(sp.lining ?? sp.color, 'secondary', sp.material ?? 'cloth'),
      rim: ctx.col(sp.piping ?? 'trim', 'trim', sp.material ?? 'cloth'),
      // No UV scale — `pattern.repeat` is the sash's only tiling control.
      outward: (u) => V(Math.cos(u * TAU), 0, Math.sin(u * TAU)),
    });
    if (sp.knot !== false) {
      const side = sp.knotSide === 'R' ? -1 : 1;
      s.ink(ctx.col(sp.color, 'secondary', sp.material ?? 'cloth'));
      const t = f.trunk(y, H * (0.012 + LAYER * 0.18));
      const a = Math.PI * 0.5 + side * 0.6;
      blob(s, {
        cx: Math.cos(a) * t.rx, cy: y, cz: t.z + Math.sin(a) * t.rz,
        rx: H * 0.026, ry: H * 0.030, rz: H * 0.020, eU: 0.75, eV: 0.75, segU: 10, segV: 7,
      });
    }
  },

  /**
   * Diagonal strap across the torso — a baldric, a bandolier, a book strap.
   *
   * The ninja carries four of these crossing at different angles, and they are
   * most of why that costume reads as *assembled* rather than as a suit. Ours
   * carries buckles and, optionally, a row of loops.
   */
  strap(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'leather', null, sp.pattern);
    s.ink(ctx.col(sp.color, 'leather', sp.material ?? 'leather'));
    const side = sp.side === 'R' ? -1 : 1;
    const yTop = lerp(f.J.chest.y, f.J.neck.y, sp.top ?? 0.62);
    const yBot = lerp(f.hipY, f.J.chest.y, sp.bottom ?? 0.18);
    const w = H * (sp.width ?? 0.030);
    const ring = (y, a) => {
      const t = f.trunk(y, H * (0.010 + LAYER * (sp.over ?? 0.30)));
      return V(Math.cos(a) * t.rx, y, t.z + Math.sin(a) * t.rz);
    };
    const path = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const v = i / steps;
      const y = lerp(yTop, yBot, v);
      // Over the shoulder at the top, round to the opposite hip at the bottom.
      const a = lerp(Math.PI * 0.5 + side * 0.45, Math.PI * 0.5 - side * 1.05, v);
      path.push(ring(y, a));
    }
    sweep(s, path, section(8, 0.35), () => [H * 0.007, w * 0.5], { capStart: true, capEnd: true });

    const hs = ctx.pull('trim', null);
    hs.ink(ctx.col(sp.buckle ?? 'metal', 'metal', 'trim'));
    const at = path[Math.round(steps * (sp.buckleAt ?? 0.42))];
    blob(hs, { cx: at.x, cy: at.y, cz: at.z + H * 0.006, rx: w * 0.62, ry: w * 0.52, rz: H * 0.008, eU: 0.35, eV: 0.35, segU: 8, segV: 5 });
    if (sp.loops) {
      for (let k = 0; k < sp.loops; k++) {
        const p = path[Math.round(lerp(2, steps - 2, k / Math.max(1, sp.loops - 1)))];
        blob(hs, { cx: p.x, cy: p.y, cz: p.z + H * 0.007, rx: w * 0.30, ry: w * 0.34, rz: H * 0.007, eU: 0.5, eV: 0.5, segU: 8, segV: 5 });
      }
    }
  },

  /** Pouch or satchel hung off a belt: body, flap and a buckle stud. */
  pouch(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'leather', null, sp.pattern);
    s.ink(ctx.col(sp.color, 'leather', sp.material ?? 'leather'));
    const side = sp.side === 'R' ? -1 : 1;
    const y = (sp.at === 'hip' ? f.hipY : f.waistY) - H * (sp.drop ?? 0.045);
    const a = Math.PI * (sp.angle ?? 0.5) * side;
    const t = f.trunk(y, H * (0.010 + LAYER * 0.35));
    const cx = Math.cos(a) * t.rx * (sp.out ?? 1.0);
    const cz = t.z + Math.sin(a) * t.rz * (sp.out ?? 1.0);
    const w = H * (sp.size ?? 0.048);
    blob(s, { cx, cy: y, cz, rx: w, ry: w * 1.12, rz: w * 0.58, eU: 0.35, eV: 0.42, segU: 12, segV: 8 });
    // Flap: a slightly larger, flatter cap over the top third.
    s.ink(ctx.col(sp.flap ?? sp.color, 'trim', sp.material ?? 'leather'));
    blob(s, { cx, cy: y + w * 0.62, cz, rx: w * 1.06, ry: w * 0.46, rz: w * 0.64, eU: 0.35, eV: 0.5, segU: 12, segV: 6 });
    const hs = ctx.pull('trim', null);
    hs.ink(ctx.col(sp.buckle ?? 'metal', 'metal', 'trim'));
    blob(hs, { cx, cy: y + w * 0.18, cz: cz + w * 0.58, rx: w * 0.20, ry: w * 0.20, rz: H * 0.005, eU: 0.4, eV: 0.4, segU: 8, segV: 5 });
  },

  /** Cloth bindings wound up a shin or forearm, with a crossed tie over them. */
  legwrap(ctx, sp) {
    const { f, H } = ctx;
    for (const side of sides(sp.side)) {
      const sfx = side > 0 ? 'L' : 'R';
      const s = ctx.pull(sp.material ?? 'cloth', null, sp.pattern);
      s.ink(ctx.col(sp.color, 'secondary', sp.material ?? 'cloth'));
      const turns = clamp(sp.turns ?? 5, 2, 9);
      const t0 = sp.from ?? 0.20;
      const t1 = sp.to ?? 0.92;
      for (let k = 0; k < turns; k++) {
        const t = lerp(t0, t1, k / (turns - 1));
        const fr = f.limbAt(`shin${sfx}`, `foot${sfx}`, t);
        const r = lerp(f.leg.mid, f.leg.tip, t) * (sp.fit ?? 1.20);
        const path = [];
        for (let i = 0; i <= 14; i++) {
          const a = (i / 14) * TAU;
          // Each turn climbs a little, so the wrap spirals instead of stacking.
          const climb = (i / 14 - 0.5) * (t1 - t0) / (turns - 1) * 0.7;
          const fr2 = f.limbAt(`shin${sfx}`, `foot${sfx}`, clamp(t + climb, 0, 1));
          path.push(fr2.p.clone().addScaledVector(fr.side, Math.cos(a) * r).addScaledVector(fr.front, Math.sin(a) * r));
        }
        sweep(s, path, section(6, 0.6), () => [H * 0.007, H * 0.009], { capStart: false, capEnd: false });
      }
      // Crossed tie down the front, in the accent so the binding reads.
      const ts = ctx.pull(sp.tieMaterial ?? 'leather', null);
      ts.ink(ctx.col(sp.tie ?? 'accent', 'accent', sp.tieMaterial ?? 'leather'));
      for (const dir of [1, -1]) {
        const pts = [];
        for (let i = 0; i <= 6; i++) {
          const t = lerp(t0, t1, i / 6);
          const fr = f.limbAt(`shin${sfx}`, `foot${sfx}`, t);
          const r = lerp(f.leg.mid, f.leg.tip, t) * (sp.fit ?? 1.20) * 1.06;
          const a = dir * (i % 2 ? 0.55 : -0.55);
          pts.push(fr.p.clone().addScaledVector(fr.front, Math.cos(a) * r).addScaledVector(fr.side, Math.sin(a) * r));
        }
        sweep(ts, pts, section(5, 0.7), () => [H * 0.005, H * 0.005], { capStart: true, capEnd: true });
      }
    }
  },

  /**
   * Laced boot, layered over the body's own boot rather than replacing it:
   * shaft, turned cuff, sole slab, toe cap, eyelet studs and criss-cross laces.
   *
   * The hat-mage's boots are the reference — the eyelet dots are individually
   * legible at source resolution, which is why they are geometry here and not a
   * texture. `CharacterFactory.buildBoot` builds the boot body under this and
   * takes its two colours from `palette.leather` and `palette.trim`.
   */
  boot(ctx, sp) {
    const { f, H } = ctx;
    for (const side of sides(sp.side)) {
      const sfx = side > 0 ? 'L' : 'R';
      const s = ctx.pull(sp.material ?? 'leather', null, sp.pattern);
      const ankle = f.J[`foot${sfx}`];
      const foot = ctx.m.foot;
      const base = foot.height * 0.9;
      const topY = base + H * (sp.shaft ?? 0.10);
      const rBase = Math.max(foot.width * 0.52, f.g.ankle * 1.42);
      const rTop = f.g.ankle * (sp.topFit ?? 1.36);
      const faceC = ctx.col(sp.color, 'leather', sp.material ?? 'leather');
      const cuffC = ctx.col(sp.cuff ?? 'trim', 'trim', sp.material ?? 'leather');

      // Shaft.
      shell(s, {
        point: (u, v) => {
          const a = u * TAU;
          const y = lerp(base, topY, v);
          const r = lerp(rBase, rTop, Math.pow(v, 0.7));
          return V(ankle.x + Math.cos(a) * r, y, ankle.z + Math.sin(a) * r * 1.04);
        },
        segU: 16, segV: 4, closedU: true,
        thickness: H * (sp.thickness ?? 0.008),
        face: faceC, back: faceC, rim: cuffC,
        outward: (u) => V(Math.cos(u * TAU), 0, Math.sin(u * TAU)),
      });

      // Turned-down cuff at the top — the flare is what makes it a boot cuff.
      const cs = ctx.pull(sp.cuffMaterial ?? 'cloth', null);
      shell(cs, {
        point: (u, v) => {
          const a = u * TAU;
          const y = topY - H * (sp.cuffHeight ?? 0.030) * v;
          const r = rTop * (1.06 + v * (sp.cuffFlare ?? 0.22));
          return V(ankle.x + Math.cos(a) * r, y, ankle.z + Math.sin(a) * r * 1.04);
        },
        segU: 16, segV: 2, closedU: true,
        thickness: H * HEM.thickness,
        roll: H * HEM.edge,
        face: cuffC,
        back: ctx.col(sp.cuffLining ?? 'secondary', 'secondary', sp.cuffMaterial ?? 'cloth'),
        rim: cuffC,
        outward: (u) => V(Math.cos(u * TAU), 0, Math.sin(u * TAU)),
      });

      // Sole: a squared slab under the foot, proud of it all round.
      const ss = ctx.pull(sp.soleMaterial ?? 'leather', null);
      ss.ink(ctx.col(sp.sole ?? 'leather', 'leather', sp.soleMaterial ?? 'leather'));
      blob(ss, {
        cx: ankle.x, cy: foot.height * (sp.soleHeight ?? 0.16), cz: ankle.z + foot.length * 0.14,
        rx: Math.max(foot.width * 0.55, f.g.ankle * 1.40),
        ry: foot.height * 0.20,
        rz: Math.max(foot.length * 0.54, f.g.ankle * 1.72),
        eU: 0.30, eV: 0.35, segU: 16, segV: 6,
      });
      if (sp.toeCap) {
        const tc = ctx.pull('plate', null);
        tc.ink(ctx.col(sp.toeCapColor ?? 'metal', 'metal', 'plate'));
        blob(tc, {
          cx: ankle.x, cy: foot.height * 0.44, cz: ankle.z + foot.length * 0.52,
          rx: foot.width * 0.48, ry: foot.height * 0.42, rz: foot.length * 0.26,
          eU: 0.45, eV: 0.55, segU: 12, segV: 7,
        });
      }

      // Eyelets and laces up the front of the shaft.
      const es = ctx.pull('trim', null);
      es.ink(ctx.col(sp.eyelet ?? 'metal', 'metal', 'trim'));
      const pairs = clamp(sp.eyelets ?? 4, 2, 7);
      const holes = [];
      for (let k = 0; k < pairs; k++) {
        const v = 0.12 + (k / (pairs - 1)) * 0.76;
        const y = lerp(base, topY, v);
        const r = lerp(rBase, rTop, Math.pow(v, 0.7));
        const row = [];
        for (const dx of [-1, 1]) {
          const a = Math.PI * 0.5 + dx * (sp.lacing ?? 0.30);
          const p = V(ankle.x + Math.cos(a) * r * 1.02, y, ankle.z + Math.sin(a) * r * 1.06);
          row.push(p);
          blob(es, { cx: p.x, cy: p.y, cz: p.z, rx: H * 0.006, ry: H * 0.006, rz: H * 0.004, eU: 0.6, eV: 0.6, segU: 6, segV: 4 });
        }
        holes.push(row);
      }
      const ls = ctx.pull(sp.laceMaterial ?? 'cloth', null);
      ls.ink(ctx.col(sp.lace ?? 'trim', 'trim', sp.laceMaterial ?? 'cloth'));
      for (let k = 0; k < pairs - 1; k++) {
        for (const [a, b] of [[holes[k][0], holes[k + 1][1]], [holes[k][1], holes[k + 1][0]]]) {
          sweep(ls, [a, a.clone().lerp(b, 0.5).add(V(0, 0, H * 0.004)), b],
            section(4, 0.8), () => [H * 0.0035, H * 0.0035], { capStart: true, capEnd: true });
        }
      }
    }
  },

  // ---------------------------------------------------------- strand meshes

  /**
   * Veil: a diamond mesh hanging from a hat brim over the face.
   *
   * Built as real crossed strands rather than an alpha-tested sheet. A cut-out
   * would have to be sorted against the volumetric pass *and* against the
   * inverted-hull outline, and neither has a stable answer; at the archer's
   * scale the mesh is roughly nine cells across the face and each strand is
   * thicker than a pixel at the battle camera anyway.
   */
  veil(ctx, sp) {
    const { H } = ctx;
    const s = ctx.pull(sp.material ?? 'cloth', 'head', sp.pattern);
    s.ink(ctx.col(sp.color, 'lash', sp.material ?? 'cloth'));
    const hd = ctx.m.head;
    const tilt = (sp.tilt ?? 0.42) * (sp.side === 'R' ? -1 : 1);
    const top = hd.center.y + hd.ry * (sp.from ?? 0.66);
    const bot = hd.center.y - hd.ry * (sp.to ?? 0.92);
    const span = (sp.wrap ?? 0.44) * Math.PI;
    // The sheet follows the skull's own cross-section, standing off it by 6%,
    // so the mesh drapes on the face instead of cutting through the cheek.
    const at = (u, v, push = 0) => {
      const y = lerp(top, bot, v);
      const ny = clamp((y - hd.center.y) / hd.ry, -0.98, 0.98);
      const cr = Math.sqrt(Math.max(0.04, 1 - ny * ny)) * (1.08 + push);
      const a = Math.PI * 0.5 + lerp(-span, span, u) + tilt * 0.35;
      return V(Math.cos(a) * hd.rx * cr, y + Math.sin(lerp(-span, span, u)) * tilt * hd.ry * 0.30, Math.sin(a) * hd.rz * cr);
    };
    const cells = clamp(sp.cells ?? 5, 3, 9);
    const r0 = H * (sp.strand ?? 0.0028);
    for (let k = -cells; k <= cells; k++) {
      for (const dir of [1, -1]) {
        // The two lattices sit on different standoffs — see `fishnet` for why
        // an equal-radius crossing is a depth-test coin flip rather than a knot.
        const push = dir > 0 ? 0 : 0.030;
        const r = r0 * (0.85 + ctx.rng.next() * 0.30);
        const pts = [];
        for (let i = 0; i <= 8; i++) {
          const v = i / 8;
          const u = 0.5 + (k / (cells * 2)) + dir * (v - 0.5) * 0.62;
          if (u < 0 || u > 1) { if (pts.length > 1) break; else continue; }
          pts.push(at(u, v, push));
        }
        if (pts.length > 1) sweep(s, pts, section(4, 1), () => [r, r], { capStart: true, capEnd: true });
      }
    }
  },

  /**
   * A coarse net draped over a skirt or a hip, hanging past the hem in loose
   * scalloped points — the archer's over-skirt, and a corsair's rigging net.
   *
   * Roughly seven cells across on the plate, which is coarse enough that the
   * cells read individually at battle distance. That is the point of it: a net
   * is the only garment layer that adds *holes* to a silhouette.
   */
  fishnet(ctx, sp) {
    const { f, H } = ctx;
    const s = ctx.pull(sp.material ?? 'cloth', 'hips', sp.pattern);
    s.ink(ctx.col(sp.color, 'leather', sp.material ?? 'cloth'));
    const top = sp.top !== undefined ? lerp(f.hipY, f.J.neck.y, sp.top) : f.waistY;
    const flare = sp.flare ?? 2.6;
    const scallopDepth = sp.scallopDepth ?? 0.22;
    // Same floor guard as `skirt`, taken against the deepest scallop.
    const len = Math.min(H * (sp.length ?? 0.44), (top - H * 0.015) / (1 + scallopDepth));
    const wrap = (sp.wrap ?? 1.0) * Math.PI;
    const phase = Math.PI * 0.5 + (sp.turn ?? 0);
    const at = (u, v, push = 0) => {
      const a = phase + lerp(-wrap, wrap, u);
      // The scallop: the net hangs lower between its hanging points, which is
      // what stops it reading as a printed grid.
      const scallop = 1 + Math.abs(Math.sin(u * Math.PI * (sp.scallops ?? 4))) * scallopDepth;
      const y = top - len * v * scallop;
      const t = f.trunk(Math.max(y, f.hipY - H * 0.01), H * (0.012 + LAYER * 0.55));
      const k = (1 + v * (flare - 1)) * (1 + push);
      return V(Math.cos(a) * t.rx * k, y, t.z + Math.sin(a) * t.rz * k);
    };
    const cells = clamp(sp.cells ?? 7, 3, 12);
    const r0 = H * (sp.strand ?? 0.0045);
    for (let k = -cells; k <= cells * 2; k++) {
      for (const dir of [1, -1]) {
        /**
         * The two strand directions run on **separate standoffs**, and each
         * strand carries its own thickness and a taper toward its hanging end.
         *
         * Both are fixes for the review's tassel finding rather than dressing.
         * Two tubes of identical radius crossing at the shallow angle this
         * lattice uses share a surface over most of the crossing, so the depth
         * test picks a different winner per pixel and the whole net speckles —
         * that is the z-fighting, and it is worst on Kite because her net is in
         * bleached rope against a scarlet coat. Lifting one lattice 1.5% clear
         * makes every crossing a definite over/under, which is also how a real
         * net is knotted. The taper gives the hanging points a tip instead of a
         * flat-cut cylinder end, which is the other half of "untapered".
         */
        const push = dir > 0 ? 0 : 0.015;
        const r = r0 * (0.82 + ctx.rng.next() * 0.36);
        const pts = [];
        for (let i = 0; i <= 7; i++) {
          const v = i / 7;
          const u = 0.5 + (k / (cells * 2)) - 0.5 + dir * (v - 0.5) * 0.55;
          if (u < 0 || u > 1) { if (pts.length > 1) break; else continue; }
          pts.push(at(u, v, push));
        }
        if (pts.length > 1) {
          const last = pts.length - 1;
          sweep(s, pts, section(4, 1),
            (i) => { const t = r * (1 - 0.34 * (i / last)); return [t, t]; },
            { capStart: true, capEnd: true });
        }
      }
    }
  },
};

/** `'L'`, `'R'` or (default) both. */
function sides(spec) {
  if (spec === 'L') return [1];
  if (spec === 'R') return [-1];
  return [1, -1];
}

// ============================================================== entry point

/**
 * Build one character's wardrobe.
 *
 * Reads `def.garments`, an ordered array of `{ kind, ...params }`. Order is
 * meaningful only as documentation of the stack — every piece is placed by
 * solved body dimensions, not by what came before it — but authoring it
 * innermost-first is what makes a roster entry readable as a costume.
 *
 * Pieces are grouped by `(material recipe, attach bone)` and merged, so a
 * character wearing eleven garments returns six to nine meshes.
 *
 * @param {object} def roster entry
 * @param {object} metrics frozen block from `Rig.computeMetrics`
 * @param {object} rig result of `Rig.buildRig`
 * @returns {Array<{name: string, geometry: import('three').BufferGeometry,
 *                  material: import('three').Material, attachBone: string}>}
 */
export function buildGarmentSet(def, metrics, rig) {
  const list = def?.garments;
  if (!Array.isArray(list) || list.length === 0) return [];
  void rig; // the factory solves the skin; every dimension here comes from metrics

  const pal = def.palette ?? {};
  const groups = new Map();
  const materials = new Map();
  const frame = bodyFrame(def, metrics);

  /**
   * A per-character deterministic stream.
   *
   * Fur tuft lengths and cape-trim jitter must reproduce exactly for a capture
   * to be comparable, and they must not depend on how many *other* characters
   * were built first — which is what drawing from the shared `rng` singleton
   * would make them. `Rng` is the project's generator either way; only the
   * stream is local, and it is seeded off the character id so two characters
   * never get the same tuft pattern.
   */
  let seed = 0x9e3779b1;
  for (let i = 0; i < (def.id ?? '').length; i++) seed = (Math.imul(seed ^ def.id.charCodeAt(i), 0x85ebca6b) >>> 0);
  const rand = new Rng(seed || 1);

  const ctx = {
    def, m: metrics, pal, f: frame, H: metrics.height, rng: rand,
    /** Resolve a colour slot and grade it into its shading class's window. */
    col(slot, fallbackSlot, recipeName) {
      const band = (RECIPES[recipeName] ?? RECIPES.cloth).band;
      return graded(swatch(pal, slot, swatch(pal, fallbackSlot, 0x808080)), band);
    },
    /**
     * The Surface for one (material recipe, skin bias, pattern) group.
     *
     * `bias` of `null` means "no bone bias" and is returned to the factory as
     * an empty `attachBone`, which its solver reads as the plain widened
     * segment solve — see the note above `BUILDERS`.
     */
    pull(recipeName, bias, pattern) {
      const patternKey = pattern ? `${pattern.id}|${JSON.stringify(pattern)}` : '';
      const key = `${recipeName}|${bias ?? ''}|${patternKey}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          surface: new Surface(), recipe: recipeName, bone: bias ?? '', pattern,
          name: bias ? `${recipeName}-${bias}` : recipeName,
        };
        groups.set(key, group);
      }
      return group.surface;
    },
  };

  for (const spec of list) {
    if (!spec || !KIND_SET.has(spec.kind)) {
      if (spec) console.warn(`[Garments] "${def.id}" asks for unknown kind "${spec.kind}"`);
      continue;
    }
    BUILDERS[spec.kind](ctx, spec);
  }

  const out = [];
  for (const group of groups.values()) {
    if (group.surface.empty) continue;
    const recipe = RECIPES[group.recipe] ?? RECIPES.cloth;
    const geometry = group.surface.finish(recipe.crease);
    const material = materialFor(materials, def, group.recipe, group.pattern);
    // A patterned piece holds white vertices so the canvas carries the colour
    // undiluted — three multiplies map by vertex colour, and a tinted print is a
    // muddy print. Conditioned on the material *actually* having a map rather
    // than on the spec asking for one, so that a headless build with no canvas
    // falls back to the authored flat colour instead of to white.
    if (material.map) geometry.getAttribute('color').array.fill(1);
    out.push({ name: group.name, geometry, material, attachBone: group.bone });
  }
  return out;
}

export default buildGarmentSet;
