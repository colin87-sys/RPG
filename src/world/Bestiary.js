/**
 * Bestiary — the field-encounter creatures, built in code.
 *
 * ## What replaced what
 *
 * The stand-in this module replaces was a swept blob with a crown of shards on
 * it: one continuous skin, no limbs that articulate, no head that separates from
 * the neck, no surface incident, and a pair of 24 mm eyes on a 3.4 m animal. It
 * had a silhouette and nothing else. Three creatures are authored here with real
 * anatomy — a stalking quadruped, a hovering bell and a low armoured insectoid —
 * and they are deliberately built so that no two of them share a *shape of
 * mass*: one is tall at the shoulder and long front-to-back, one is a vertical
 * top-heavy dome trailing streamers, one is wide, flat and horizontal on six
 * legs. Silhouette is the only creature read that survives a battle camera, a
 * shadow pass and 30 px of screen height, so it is the thing designed first.
 *
 * ## Measured off the plates, and off our own frame
 *
 * There is no monster in `docs/reference/bravely01.jpg`, so the plate is
 * evidence about *staging* rather than about anatomy. Three numbers came out of
 * it and all three are load-bearing here.
 *
 *  1. **A subject is a dark mass against a bright field.** Over the knight's
 *     figure (x 330–520, y 320–750) the plate reads p1 2.4 / p50 59.9 / p99
 *     178.5 sRGB, while the meadow floor beneath the party (x 300–1300,
 *     y 850–1050) reads p1 36.9 / p50 112.0 / p99 173.1. The subject's median
 *     is **0.53 of the ground's**, with a value range that reaches lower *and*
 *     higher than the ground's at both ends. Our own capture
 *     (`shots/now/cast-stage.png`) has the cast at p50 99.6 against a floor at
 *     p50 90.9 — a ratio of 1.10, i.e. our figures are *brighter* than the
 *     ground they stand on and the frame has no anchor. Every hide albedo in
 *     `BESTIARY` is therefore authored dark: 0x24–0x4a peak channel, which lands
 *     a lit flank in the 50–80 sRGB band against the meadow's 112 and puts the
 *     creature's own shadow side under 30.
 *  2. **Counter-shading, not one flat hide.** The plate's costume zones are not
 *     flat fills — a 48 px scanline across the knight's pauldron steps through
 *     roughly forty distinct values. A creature has no costume seams to supply
 *     that, so the value structure has to be painted into the albedo: every hide
 *     here runs a three-stop ramp from a dark dorsal colour through a flank to a
 *     light belly, keyed off the surface's own world-space up-facing. That single
 *     operation is what stops a procedural animal reading as a rubber toy.
 *  3. **An eye is contrast, not brightness.** Gloria's eye on the plate
 *     (x 635–700, y 380–415) is roughly 35 px wide on a ~95 px head — **0.37 of
 *     head width** — and it reads because its iris bottoms out at 2 sRGB against
 *     a sclera at 191: a near-black mark inside a near-white one. The creatures
 *     invert the polarity (a bright lens inside a near-black socket, since a
 *     monster's eye is the lit part) but keep both the contrast and the *size*:
 *     lens diameter is 0.19–0.31 of head width on all three, and every lens sits
 *     inside a socket dome a quarter larger in the darkest colour on the animal.
 *     The stand-in's lenses measured 0.048 across in the same normalised space
 *     the bodies are authored in; these run 0.074–0.104.
 *
 * ## Construction, and the budget
 *
 * Everything is generated: there is no asset load anywhere in this module. Four
 * primitives do all the work — a parallel-transported swept tube, a faceted
 * spike, a ridged plate and a pushed stock polyhedron — and each creature merges
 * into exactly **three meshes**: hide, crystal growth, eye. All albedo variation
 * inside a mesh rides on the vertex-colour attribute, which is what lets plates,
 * claws, tufts and hide share one material and one draw call instead of four.
 *
 * The budget is the reason for that. The capture harness renders on CPU
 * SwiftShader and a recent round failed a 180 s screenshot timeout, so the whole
 * catalogue is 5.0 k triangles and 4.1 k vertices — 2046 / 1236 / 1724 for the
 * quadruped, the floater and the insectoid. Radial counts are 4–6 on limbs and
 * 10–12 on bodies: a 6-gon leg is indistinguishable from a 16-gon leg at battle
 * distance and costs a third as much to raster and to push through the outline
 * hull, which is the one place a vertex is paid for twice.
 *
 * Normals are never authored. Every buffer is closed with
 * `computeVertexNormals`, and the choice between a smooth and a hard surface is
 * made by *vertex sharing*: swept bodies share their ring vertices and come out
 * smooth, while spikes and plates emit unshared corners and come out crisply
 * faceted. That is one rule instead of two normal pipelines, and it is why hide
 * and chitin can live in one mesh without a `flatShading` flag deciding for both.
 *
 * **Procedural noise is legal here.** `ANIME_PIPELINE`'s prohibition is about
 * *characters* — on a face fBm reads as dirt — and these are not characters. It
 * is still used with a short leash: a ±5–7% multiplicative mottle on the hide
 * colour and `AssetForge`'s normal/roughness maps for micro-relief. The base
 * colour map is deliberately **not** bound, because the forge's leather albedo
 * is a brown and would fight the authored scheme; the colour of a creature is
 * the vertex attribute and nothing else multiplies into it.
 *
 * ## Contract
 *
 *   buildCreature(id, opts) -> { root, height, dispose() }
 *   BESTIARY                -> the catalogue, as plain frozen data
 *
 * `root` is a `THREE.Group` whose origin sits on the ground under the creature,
 * with +Z its facing direction, so a caller places it with a position and a
 * `rotation.y` and nothing else. Everything the call allocated is released by
 * `dispose()`; nothing is cached between calls, so two creatures of one species
 * are two independent meshes — see the note on `buildCreature` if a scene wants
 * a crowd.
 *
 * OWNED BY: world/Bestiary.js.
 */
import * as THREE from 'three';
import { rng as sharedRng, Rng } from '../core/GameState.js';
import { createToonMaterial, createToonOutline, createToonOutlineMaterial, disposeToonOutline } from '../render/ToonMaterial.js';
import { ELEMENT, hexToLinear } from '../art/Palette.js';
import { makeNoise, clamp, smootherstep } from '../art/noise.js';

/* -------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The creature catalogue, as **pure data**.
 *
 * Deliberately free of function references so it can be dumped to a debug
 * overlay, diffed in a review or serialised into an encounter table without
 * dragging a geometry builder along with it; the builders live in a private map
 * keyed by the same ids.
 *
 * Reading an entry:
 *
 *  - `height` — metres from the ground to the creature's tallest point, and the
 *    scale factor for its whole normalised authoring space. The cast stands
 *    1.00–1.19 m (`LookdevScene.PARTY`), so 1.35 m for the quadruped puts a
 *    field encounter a head over the party without reaching boss scale, and
 *    0.82 m for the insectoid puts it below their eyeline — the two silhouettes
 *    have to differ in *stance*, not only in outline.
 *  - `palette.hide` / `flank` / `belly` — the three stops of the counter-shading
 *    ramp, dorsal to ventral. Every one is dark by the plate measurement in the
 *    module header; the belly is the only member allowed past 0x80 on a channel.
 *  - `palette.plate` / `ridge` — armour scutes and their proud edge. The ridge is
 *    always the lighter of the pair, because a plate reads by its lit edge.
 *  - `palette.growth` / `emissive` — the crystal member. `ART_BIBLE` §4 reserves
 *    magenta/violet for enemies, so the two shard-bearing species take it; the
 *    insectoid carries `RING_GLOW` teal instead, which is the shard-fall colour
 *    its fiction gives it, and its warm eye then sits opposite that on the wheel.
 *  - `palette.eye` — pre-multiplier. The eye material takes it past 1.0 so the
 *    lens is a genuine bloom source rather than a bright grey dot.
 *  - `element` — the elemental affinity, keyed into `Palette.ELEMENT`, for a
 *    battle system and for VFX tinting.
 */
export const BESTIARY = Object.freeze({
  glassmane: Object.freeze({
    id: 'glassmane',
    name: 'Glassmane',
    archetype: 'quadruped',
    element: 'dark',
    /**
     * Metres, ground to the tip of the crest; the withers land at 0.86 of that.
     *
     * Raised from 1.35 with the stance rebuild (see {@link buildGlassmane}).
     * 1.52 against a 1.00–1.19 m cast puts a field encounter a clear head and
     * shoulders over the party rather than level with it, which is what the
     * *lead* creature has to do — a battle frame in which the threat and the
     * party measure the same has no antagonist in it, only a sixth party member
     * facing the wrong way. A scene staging it as the frame's subject overrides
     * this upward again; `LookdevScene.ENCOUNTER` runs 1.80.
     */
    height: 1.52,
    description:
      'An ashland courser that beds down in spent-magic drifts. Its winter coat '
      + 'comes in the colour of cold charcoal and it carries the ember of every '
      + 'drift it has slept in behind its eyes.',
    /**
     * **Charcoal and one ember, and the crystals are gone.**
     *
     * The review's finding was an "off-style magenta-crystal wolf" that "belongs
     * to a different game", and both halves of that are palette decisions rather
     * than modelling ones. `0x8c4dd9` growth over a `0x2b2136` violet-brown hide
     * put two saturated purples on the frame's darkest mass, in a picture whose
     * reference reserves saturation for *accents* — the plate's own party is
     * built from near-neutral armour, near-neutral cloth and one colour each.
     *
     * So the whole animal is neutral now. Hide, flank, plate and ridge are a
     * single desaturated charcoal ramp — measured against the plate's knight,
     * whose armour runs p50 sRGB 60 at saturation 0.09 — and the belly is a warm
     * off-white rather than a purple-grey, because counter-shading is a *value*
     * device and a hue on both ends of it cancels the read.
     *
     * The one accent is `earth.accent`, a warm amber, and it appears in exactly
     * two places: the eye lens and the ear membranes. That is the cast's own
     * discipline — one saturated colour per figure, placed where the eye is
     * meant to land — and against a charcoal coat under a warm key it is also
     * the only colour on the animal that the meadow's violet cannot swallow.
     */
    palette: Object.freeze({
      hide: 0x22242a, flank: 0x3b4048, belly: 0x8d887c,
      plate: 0x4a505b, ridge: 0x9aa1a9,
      // Fangs and claws, dropped from a near-white. The head carries a lit eye,
      // two lit ear membranes and four visible fangs inside 40 px, and at the
      // old `0xd2c9b4` the teeth were the brightest mark on the animal — a
      // charcoal wolf whose face read as a handful of white chips. This sits
      // half a stop under the pale belly, so the fangs are still the lightest
      // thing on the muzzle and no longer the lightest thing on the creature.
      bone: 0xb3a992,
      /** The ember, used for the ear membranes; the eye takes the same family. */
      accent: ELEMENT.earth.accent,
      /**
       * `accent` rather than `earth.core`.
       *
       * The lens material multiplies this by 2.2 to make the eye a bloom source,
       * and `core` is `0xf2d9a6` — a near-white cream, which at 2.2 × is simply
       * white. The whole point of giving this animal one accent is that the
       * frame's eye lands on it *as a colour*, and a white dot on a charcoal
       * head is indistinguishable from the fangs beside it. `accent` is a
       * saturated amber and survives the multiplier as amber.
       */
      eye: ELEMENT.earth.accent,
      socket: 0x0c0e12,
    }),
  }),

  driftbell: Object.freeze({
    id: 'driftbell',
    name: 'Driftbell',
    archetype: 'floater',
    /** Metres, ground to the crown shard tips. The bell's mouth hangs at 0.45 m. */
    height: 1.62,
    element: 'ice',
    description:
      'Anima that pooled in a keeping-shrine and never dispersed, wearing the '
      + 'bell it was stored in. It drifts down the wind lanes ringing on a note '
      + 'nobody alive remembers the words to.',
    palette: Object.freeze({
      hide: 0x241f36, flank: 0x433b62, belly: 0x7a7296,
      plate: 0x554c78, ridge: 0x9089b8,
      bone: 0xcfc9dd,
      growth: 0x9a6fe0, emissive: ELEMENT.dark.accent,
      eye: ELEMENT.ice.core,
      socket: 0x120e1c,
    }),
  }),

  shardmite: Object.freeze({
    id: 'shardmite',
    name: 'Shardmite',
    archetype: 'insectoid',
    /** Metres, ground to the tallest dorsal shard. Body length is 1.33 m. */
    height: 0.82,
    element: 'earth',
    description:
      'A shard-fall scavenger that grows its own back plate by swallowing glass '
      + 'and sweating it out along the spine. Hunted for the plate; survives '
      + 'because the plate is what makes it worth hunting.',
    palette: Object.freeze({
      hide: 0x16212a, flank: 0x2c3f4e, belly: 0x64736e,
      plate: 0x3d5768, ridge: 0x839aa6,
      bone: 0xb9c2bd,
      growth: 0x5fb8b0, emissive: ELEMENT.wind.fringe,
      eye: ELEMENT.fire.fringe,
      socket: 0x0c1218,
    }),
  }),
});

/** Ids in catalogue order, for encounter tables and for the lookdev bay. */
export const BESTIARY_IDS = Object.freeze(Object.keys(BESTIARY));

/* -------------------------------------------------------------------------- */
/* Buffer assembly                                                            */
/* -------------------------------------------------------------------------- */

const REF_UP = new THREE.Vector3(0, 1, 0);
const REF_FWD = new THREE.Vector3(0, 0, 1);

/**
 * A growable triangle buffer with a colour channel.
 *
 * The whole creature is written into three of these and closed once, rather than
 * built as thirty `BufferGeometry` objects and merged. That is not only cheaper
 * at build time (the harness pays this cost on the CPU before the first frame) —
 * it is what makes the vertex-sharing rule expressible at all, because the
 * decision to share or duplicate a corner is taken by the primitive that writes
 * it rather than by a merge pass that can no longer tell the difference.
 */
class MeshBuffer {
  constructor() {
    this.position = [];
    this.uv = [];
    this.color = [];
    this.index = [];
  }

  get vertexCount() {
    return this.position.length / 3;
  }

  get empty() {
    return this.index.length === 0;
  }

  /** Append one vertex; returns its index. `c` is a linear RGB triple. */
  vertex(x, y, z, u, v, c) {
    this.position.push(x, y, z);
    this.uv.push(u, v);
    this.color.push(c[0], c[1], c[2]);
    return this.position.length / 3 - 1;
  }

  tri(a, b, c) {
    this.index.push(a, b, c);
  }

  /** Two triangles over four existing, shared vertices. */
  quad(a, b, c, d) {
    this.index.push(a, b, c, a, c, d);
  }

  /**
   * A quad with **unshared** corners, so `computeVertexNormals` resolves it to a
   * single face normal. This is the whole flat-shading mechanism: a spike or a
   * plate calls this and comes out crisp, while a swept body shares its ring
   * vertices and comes out smooth, inside one buffer and one material.
   */
  facetQuad(p0, p1, p2, p3, c0, c1 = c0, c2 = c1, c3 = c0) {
    const a = this.vertex(p0.x, p0.y, p0.z, 0, 0, c0);
    const b = this.vertex(p1.x, p1.y, p1.z, 1, 0, c1);
    const c = this.vertex(p2.x, p2.y, p2.z, 1, 1, c2);
    const d = this.vertex(p3.x, p3.y, p3.z, 0, 1, c3);
    this.quad(a, b, c, d);
  }

  /** A triangle with unshared corners. See {@link MeshBuffer#facetQuad}. */
  facetTri(p0, p1, p2, c0, c1 = c0, c2 = c0) {
    const a = this.vertex(p0.x, p0.y, p0.z, 0, 0, c0);
    const b = this.vertex(p1.x, p1.y, p1.z, 1, 0, c1);
    const c = this.vertex(p2.x, p2.y, p2.z, 0.5, 1, c2);
    this.tri(a, b, c);
  }

  /**
   * Close the buffer.
   *
   * `Uint16` indices are chosen explicitly rather than left to three's automatic
   * widening: nothing in this module comes near 65 k vertices and the assertion
   * is worth having, because a creature that quietly crossed that line would be
   * a creature that had stopped being affordable.
   */
  finish(name) {
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.color, 3));
    g.setIndex(this.vertexCount > 65535
      ? new THREE.Uint32BufferAttribute(this.index, 1)
      : new THREE.Uint16BufferAttribute(this.index, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** Control-point channels: x, y, z, radius, lateral scale, dorsal keel. */
function normaliseControl(control) {
  return control.map((c) => [c[0], c[1], c[2], c[3], c[4] ?? 1, c[5] ?? 0]);
}

/**
 * Uniform Catmull-Rom resample of a control polyline across all six channels.
 *
 * Uniform rather than centripetal, for the same reason the previous creature's
 * spine used it: the control points are laid out at roughly even spacing along
 * the body, so the parameterisation buys nothing, and the plain form leaves a
 * radius channel monotone where it was authored monotone — a centripetal knot
 * sequence can overshoot a taper into a negative radius and turn a muzzle
 * inside out.
 */
function resample(control, steps) {
  const n = control.length;
  const out = [];
  for (let s = 0; s <= steps; s++) {
    const t = (s / steps) * (n - 1);
    const i = Math.min(n - 2, Math.floor(t));
    const f = t - i;
    const p0 = control[Math.max(0, i - 1)];
    const p1 = control[i];
    const p2 = control[i + 1];
    const p3 = control[Math.min(n - 1, i + 2)];
    const v = new Array(6);
    for (let k = 0; k < 6; k++) {
      v[k] = 0.5 * (2 * p1[k]
        + (-p0[k] + p2[k]) * f
        + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f * f
        + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * f * f * f);
    }
    v[3] = Math.max(0.002, v[3]);
    out.push(v);
  }
  return out;
}

const _tan = new THREE.Vector3();
const _prevTan = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _col = [1, 1, 1];

/**
 * Sweep a closed tube along a resampled spine.
 *
 * The frame is **parallel-transported** rather than rebuilt per sample from a
 * world-up reference. A reference frame is cheaper but it flips discontinuously
 * wherever the tangent passes near vertical, and every leg in this module does
 * exactly that — an insect leg leaves the body horizontally and reaches the
 * ground vertically. A flip shows up as a visible twist in the tube and a
 * scrambled band of vertex colour at the knee. Transport carries the previous
 * frame through the smallest rotation that maps the old tangent onto the new
 * one, so the only place the reference is consulted is the first sample.
 *
 * `keel` (per control point) pushes the dorsal half of the cross-section out and
 * `belly` (per sweep) flattens the ventral half. Together they turn a circle
 * into an animal cross-section — ridged on top, flat underneath — for the cost
 * of two multiplies per vertex, which is far cheaper than modelling a back.
 *
 * @param {MeshBuffer} mb
 * @param {number[][]} controlIn `[x, y, z, radius, lateral, keel]` per point.
 * @param {Object} o
 * @param {number} [o.samples] rings along the sweep.
 * @param {number} [o.radial=10] vertices per ring. 4–6 on limbs is deliberate.
 * @param {number} [o.belly=0] ventral flattening, 0–1.
 * @param {number} [o.ribs=0] angular radius modulation period — flutes a bell.
 * @param {number} [o.ribDepth=0] amplitude of that modulation.
 * @param {boolean} [o.capStart=true] / [o.capEnd=true] close the ends.
 * @param {(x:number,y:number,z:number,upFacing:number,t:number,out:number[])=>void} o.tint
 * @returns {number[][]} the resampled spine, so callers can hang plates, spikes
 *   and tufts off the surface they actually built rather than off a guess.
 */
function sweep(mb, controlIn, o) {
  const control = normaliseControl(controlIn);
  const samples = o.samples ?? Math.max(8, (control.length - 1) * 3);
  const radial = o.radial ?? 10;
  const belly = o.belly ?? 0;
  const ribs = o.ribs ?? 0;
  const ribDepth = o.ribDepth ?? 0;
  const { tint } = o;
  const path = resample(control, samples);
  const n = path.length;
  const rowStart = new Array(n);

  for (let i = 0; i < n; i++) {
    const p = path[i];
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    _tan.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (_tan.lengthSq() < 1e-12) _tan.copy(REF_FWD);
    _tan.normalize();

    if (i === 0) {
      const ref = Math.abs(_tan.y) < 0.9 ? REF_UP : REF_FWD;
      _right.copy(ref).cross(_tan).normalize();
    } else {
      _quat.setFromUnitVectors(_prevTan, _tan);
      _right.applyQuaternion(_quat);
    }
    // Re-orthogonalise every ring. The transported right vector drifts off the
    // plane by an epsilon per step and a fifty-sample body would accumulate a
    // visible shear by the tail.
    _up.crossVectors(_tan, _right).normalize();
    _right.crossVectors(_up, _tan).normalize();
    _prevTan.copy(_tan);

    rowStart[i] = mb.vertexCount;
    const r = p[3];
    const lat = p[4];
    const keel = p[5];
    const v = i / (n - 1);
    for (let k = 0; k < radial; k++) {
      const ang = (k / radial) * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      let rr = r;
      if (ribs > 0) rr *= 1 + ribDepth * Math.cos(ribs * ang);
      const ox = ca * rr * lat;
      let oy = sa * rr;
      if (sa > 0) oy *= 1 + keel * sa * sa;
      else oy *= 1 - belly * sa * sa;
      const dx = _right.x * ox + _up.x * oy;
      const dy = _right.y * ox + _up.y * oy;
      const dz = _right.z * ox + _up.z * oy;
      // The offset direction is a good enough proxy for the surface normal to
      // drive counter-shading, and it costs one reciprocal square root instead
      // of a second pass over a normal buffer that does not exist yet.
      const dl = Math.hypot(dx, dy, dz) || 1;
      const px = p[0] + dx;
      const py = p[1] + dy;
      const pz = p[2] + dz;
      tint(px, py, pz, dy / dl, v, _col);
      mb.vertex(px, py, pz, k / radial, v * (o.uvScale ?? 1), _col);
    }
  }

  for (let i = 0; i < n - 1; i++) {
    const A = rowStart[i];
    const B = rowStart[i + 1];
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial;
      mb.quad(A + k, A + k2, B + k2, B + k);
    }
  }

  // Fan caps. The two windings are mirror images because the cap at the start of
  // the sweep faces against the tangent and the one at the end faces along it.
  if (o.capStart !== false) {
    const p = path[0];
    tint(p[0], p[1], p[2], -1, 0, _col);
    const c = mb.vertex(p[0], p[1], p[2], 0.5, 0, _col);
    for (let k = 0; k < radial; k++) {
      mb.tri(c, rowStart[0] + ((k + 1) % radial), rowStart[0] + k);
    }
  }
  if (o.capEnd !== false) {
    const p = path[n - 1];
    tint(p[0], p[1], p[2], 1, 1, _col);
    const c = mb.vertex(p[0], p[1], p[2], 0.5, 1, _col);
    for (let k = 0; k < radial; k++) {
      mb.tri(c, rowStart[n - 1] + k, rowStart[n - 1] + ((k + 1) % radial));
    }
  }
  return path;
}

const _sOrigin = new THREE.Vector3();
const _sDir = new THREE.Vector3();
const _sRight = new THREE.Vector3();
const _sUp = new THREE.Vector3();
const _sBend = new THREE.Vector3();
const _sCentre = new THREE.Vector3();
const _ringA = [];
const _ringB = [];
const _tip = new THREE.Vector3();

/**
 * A faceted spike: horn, claw, fang, mandible, chitin spur, fur blade, crystal
 * growth. One primitive covers all of them because they are all the same solid —
 * a tapering polygonal cone — and differ only in side count, waist and bend.
 *
 * Three sides with no waist is a tetrahedron: three triangles, solid from every
 * angle, and the cheapest thing in this module that still reads as a tuft of fur
 * at battle distance. A billboard would be cheaper still and disappears edge-on,
 * which is the failure mode fur cards always have on a creature that turns.
 *
 * @param {MeshBuffer} mb
 * @param {Object} o
 * @param {THREE.Vector3|number[]} o.origin base centre.
 * @param {THREE.Vector3|number[]} o.dir direction of growth; need not be unit.
 * @param {number} o.length / @param {number} o.radius base radius.
 * @param {number} [o.sides=4] / @param {number} [o.roll=0] base ring roll.
 * @param {number|null} [o.waist=null] mid-ring radius as a fraction of the base;
 *   null builds a straight cone with no mid ring.
 * @param {number[]} [o.bend] tip displacement, applied as t² so the base stays
 *   flush with the surface it grows out of.
 * @param {number[]} o.color base colour, linear. @param {number[]} [o.tipColor]
 */
function spike(mb, o) {
  const sides = o.sides ?? 4;
  const waist = o.waist ?? null;
  const roll = o.roll ?? 0;
  _sOrigin.set(o.origin[0] ?? o.origin.x, o.origin[1] ?? o.origin.y, o.origin[2] ?? o.origin.z);
  _sDir.set(o.dir[0], o.dir[1], o.dir[2]).normalize();
  _sBend.set(o.bend?.[0] ?? 0, o.bend?.[1] ?? 0, o.bend?.[2] ?? 0);

  const ref = Math.abs(_sDir.y) < 0.9 ? REF_UP : REF_FWD;
  _sRight.copy(ref).cross(_sDir).normalize();
  _sUp.crossVectors(_sDir, _sRight).normalize();

  const base = o.color;
  const tipCol = o.tipColor ?? o.color;
  const mid = waist === null ? base : [
    base[0] + (tipCol[0] - base[0]) * 0.5,
    base[1] + (tipCol[1] - base[1]) * 0.5,
    base[2] + (tipCol[2] - base[2]) * 0.5,
  ];

  const ring = (out, t, r) => {
    _sCentre.copy(_sOrigin).addScaledVector(_sDir, o.length * t).addScaledVector(_sBend, t * t);
    for (let k = 0; k < sides; k++) {
      const ang = roll + (k / sides) * Math.PI * 2;
      const p = out[k] ?? (out[k] = new THREE.Vector3());
      p.copy(_sCentre)
        .addScaledVector(_sRight, Math.cos(ang) * r)
        .addScaledVector(_sUp, Math.sin(ang) * r);
    }
  };

  _tip.copy(_sOrigin).addScaledVector(_sDir, o.length).add(_sBend);
  ring(_ringA, 0, o.radius);
  if (waist === null) {
    for (let k = 0; k < sides; k++) {
      mb.facetTri(_ringA[k], _ringA[(k + 1) % sides], _tip, base, base, tipCol);
    }
  } else {
    ring(_ringB, 0.5, o.radius * waist);
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      mb.facetQuad(_ringA[k], _ringA[k2], _ringB[k2], _ringB[k], base, base, mid, mid);
      mb.facetTri(_ringB[k], _ringB[k2], _tip, mid, mid, tipCol);
    }
  }
}

const _fOrigin = new THREE.Vector3();
const _fDir = new THREE.Vector3();
const _fSide = new THREE.Vector3();
const _fRef = new THREE.Vector3();
const _fBend = new THREE.Vector3();
const _fb0 = new THREE.Vector3();
const _fb1 = new THREE.Vector3();
const _fm0 = new THREE.Vector3();
const _fm1 = new THREE.Vector3();
const _fTip = new THREE.Vector3();

/**
 * A **fur shell** — one flat, tapered, back-swept lock of hair.
 *
 * This is what the crystal crest was replaced with, and it is a different
 * primitive from {@link spike} for a reason the silhouette makes obvious. A
 * spike is a solid of revolution: it presents the same width from every bearing,
 * which is correct for a horn and wrong for hair, because hair lies in *sheets*.
 * A shell is a two-sided blade with real width across the body and almost none
 * through it, so a row of them overlapping like roof tiles reads as a mane from
 * the side, thins to a ragged line seen end-on, and never resolves into a comb
 * of identical cones — which is exactly what our crest did.
 *
 * Three triangles: a base pair, a waisted mid pair, a tip. The mid ring is what
 * lets the lock *curl* — `bend` is applied at t² so the root stays flush with
 * the hide it grows out of while the tip sweeps back, and a lock that leaves the
 * body on a curve is the difference between fur and a paper fringe.
 *
 * Emitted through `facetQuad`/`facetTri`, so it flat-shades and takes a hard
 * value break against the hide behind it. That break is the whole point at
 * battle distance: the coat has no texture map, so its only way to read as fur
 * is a row of distinct lit faces along the spine.
 *
 * @param {MeshBuffer} mb
 * @param {Object} o
 * @param {number[]} o.origin base centre, on the hide.
 * @param {number[]} o.dir direction of growth; need not be unit.
 * @param {number[]} [o.side] the width axis. Defaults to the horizontal
 *   perpendicular of `dir`, which is what a dorsal lock wants.
 * @param {number} o.length / @param {number} o.width base width across.
 * @param {number} [o.waist=0.72] mid-ring width as a fraction of the base.
 * @param {number[]} [o.bend] tip displacement, applied as t².
 * @param {number[]} o.color root colour, linear. @param {number[]} [o.tipColor]
 */
function furShell(mb, o) {
  _fOrigin.set(o.origin[0], o.origin[1], o.origin[2]);
  _fDir.set(o.dir[0], o.dir[1], o.dir[2]).normalize();
  _fBend.set(o.bend?.[0] ?? 0, o.bend?.[1] ?? 0, o.bend?.[2] ?? 0);
  if (o.side) {
    _fSide.set(o.side[0], o.side[1], o.side[2]);
  } else {
    _fRef.copy(Math.abs(_fDir.y) < 0.9 ? REF_UP : REF_FWD);
    _fSide.crossVectors(_fRef, _fDir);
  }
  // Orthogonalised against the growth direction, so `width` is a width whatever
  // axis the caller handed in.
  _fSide.addScaledVector(_fDir, -_fSide.dot(_fDir));
  if (_fSide.lengthSq() < 1e-8) _fSide.set(1, 0, 0);
  _fSide.normalize();

  const waist = o.waist ?? 0.72;
  const half = o.width * 0.5;
  const root = o.color;
  const tip = o.tipColor ?? o.color;
  const mid = [
    root[0] + (tip[0] - root[0]) * 0.5,
    root[1] + (tip[1] - root[1]) * 0.5,
    root[2] + (tip[2] - root[2]) * 0.5,
  ];

  _fb0.copy(_fOrigin).addScaledVector(_fSide, -half);
  _fb1.copy(_fOrigin).addScaledVector(_fSide, half);
  _fm0.copy(_fOrigin).addScaledVector(_fDir, o.length * 0.55)
    .addScaledVector(_fBend, 0.3025).addScaledVector(_fSide, -half * waist);
  _fm1.copy(_fm0).addScaledVector(_fSide, half * waist * 2);
  _fTip.copy(_fOrigin).addScaledVector(_fDir, o.length).add(_fBend);

  mb.facetQuad(_fb0, _fb1, _fm1, _fm0, root, root, mid, mid);
  mb.facetTri(_fm0, _fm1, _fTip, mid, mid, tip);
  /**
   * The same blade again, wound the other way.
   *
   * Not an optimisation to skip. Every other primitive in this module is a
   * *closed solid* — a swept tube, a cone, a plate lying on a body — so its back
   * faces are inside something and the hide material's `FrontSide` never has to
   * see them. A lock of hair is the one open surface here: it stands proud of
   * the body and the camera reaches both of its faces at the silhouette, where a
   * mane is doing all of its work. Culled, half the ranks would simply be absent
   * from any given bearing, and the crest would flicker between dense and bare
   * as the animal turned.
   *
   * Six triangles rather than three on a mesh of two thousand, against the
   * alternative of a second material with `side: DoubleSide` and a second draw
   * call on the frame's largest silhouette.
   */
  mb.facetQuad(_fm0, _fm1, _fb1, _fb0, mid, mid, root, root);
  mb.facetTri(_fTip, _fm1, _fm0, tip, mid, mid);
}

const _pAxis = new THREE.Vector3();
const _pNormal = new THREE.Vector3();
const _pSide = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();
const _k0 = new THREE.Vector3();
const _k1 = new THREE.Vector3();

/**
 * A ridged plate — a chitin tergite, an armour scute, a brow ridge.
 *
 * Four triangles: two slopes meeting along a raised centre line, with the front
 * end of that line pushed proud by `lip` so the plate overhangs the one behind
 * it. Overlap is what makes a row of these read as segmented armour rather than
 * as tiles, and the proud lip is what catches the key and draws the segment
 * boundary as a light line instead of relying on a shadow that a soft terminator
 * will not give.
 *
 * The ridge takes its own colour, always lighter than the plate's. On the plate
 * reference an armour edge is the brightest mark on the figure (p98 190 sRGB on
 * a pauldron whose median is 56), and a creature has no polished metal to get
 * that from — so it is painted in.
 */
function plate(mb, o) {
  _pAxis.set(o.axis[0], o.axis[1], o.axis[2]).normalize();
  _pNormal.set(o.normal[0], o.normal[1], o.normal[2]).normalize();
  _pSide.crossVectors(_pNormal, _pAxis).normalize();
  _pAxis.crossVectors(_pSide, _pNormal).normalize();

  const c = o.center;
  const L = o.length * 0.5;
  const W = o.width * 0.5;
  const rise = o.rise;
  const lip = o.lip ?? 0;
  // `drop` sinks the four corners below the plate's own plane, turning a flat
  // shield into an arch that follows the body under it. Without it a tergite
  // wide enough to read has its corners floating off a curved back, and one
  // narrow enough to sit flush is too small to see — measured on the first
  // insectoid build, which shipped six plates down the spine and no visible
  // segmentation whatsoever.
  const drop = o.drop ?? 0;
  const set = (out, al, sl, nl) => out
    .set(c[0], c[1], c[2])
    .addScaledVector(_pAxis, al)
    .addScaledVector(_pSide, sl)
    .addScaledVector(_pNormal, nl);

  set(_p0, -L, -W, -drop);
  set(_p1, -L, W, -drop);
  set(_p2, L, W, -drop);
  set(_p3, L, -W, -drop);
  set(_k0, -L, 0, rise);
  set(_k1, L + lip, 0, rise * 1.15);

  const col = o.color;
  const ridge = o.ridgeColor ?? o.color;
  mb.facetQuad(_p1, _k0, _k1, _p2, col, ridge, ridge, col);
  mb.facetQuad(_p0, _p3, _k1, _k0, col, col, ridge, ridge);
}

const _gv = new THREE.Vector3();

/**
 * Append a stock geometry, transformed.
 *
 * Used only for eye lenses and sockets, where a 20-triangle icosahedron is both
 * the right shape and cheaper than anything hand-rolled would be. Kept general
 * because it is also the escape hatch for any future creature part that a swept
 * tube genuinely cannot describe.
 */
function pushGeometry(mb, geo, matrix, color) {
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  const idx = geo.getIndex();
  const base = mb.vertexCount;
  for (let i = 0; i < pos.count; i++) {
    _gv.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    mb.vertex(_gv.x, _gv.y, _gv.z, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0, color);
  }
  if (idx) {
    for (let i = 0; i < idx.count; i++) mb.index.push(base + idx.getX(i));
  } else {
    for (let i = 0; i < pos.count; i++) mb.index.push(base + i);
  }
}

/* -------------------------------------------------------------------------- */
/* Surface colour                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build the hide's per-vertex colour function.
 *
 * Three things stack, in this order and no other:
 *
 *  1. **Counter-shading.** A three-stop ramp from `back` through `flank` to
 *     `belly`, keyed off the surface's world-space up-facing. This is the whole
 *     value structure of the animal and it is the reason a procedural creature
 *     stops looking inflated: on a real one the ventral surface is several times
 *     the reflectance of the dorsal, which cancels the sky's own gradient and
 *     leaves the *form* rather than the lighting describing the shape.
 *  2. **Banding**, optional, along the body axis. A marking is a graphic
 *     decision and reads at any distance; noise does not. Kept shallow
 *     (`bandDepth` 0.2–0.3) so it is a marking and not a stripe.
 *  3. **fBm mottle**, ±5–7% multiplicative and last, so it perturbs the result
 *     rather than competing with it. This is the only place noise touches a
 *     creature's colour, and the amplitude is chosen to be visible on a 200 px
 *     flank and invisible on a 20 px one.
 */
function hideTinter(palette, noise, o = {}) {
  const back = hexToLinear(o.back ?? palette.hide, [0, 0, 0]);
  const flank = hexToLinear(o.flank ?? palette.flank, [0, 0, 0]);
  const belly = hexToLinear(o.belly ?? palette.belly, [0, 0, 0]);
  const band = hexToLinear(o.bandColor ?? palette.hide, [0, 0, 0]);
  const mottle = o.mottle ?? 0.06;
  const bandFreq = o.bandFreq ?? 0;
  const bandDepth = o.bandDepth ?? 0;
  const bandAxis = o.bandAxis ?? 2;
  const freq = o.noiseFreq ?? 7;
  // A meridional rib highlight, for a body of revolution. The geometry's own
  // flutes give the silhouette its scallop; this paints the crest of each flute
  // lighter so the ribs read on the *facing* surface too, where a soft
  // terminator will not draw them. Free — one atan2 per vertex at build time.
  const ribCount = o.ribCount ?? 0;
  const ribDepth = o.ribTintDepth ?? 0;
  const ribCol = hexToLinear(o.ribColor ?? palette.ridge, [0, 0, 0]);

  return (x, y, z, upFacing, t, out) => {
    const u = clamp(upFacing * 0.5 + 0.5, 0, 1);
    // Two segments rather than one lerp: a linear ramp from belly to back puts
    // the mid-value on the widest part of the flank, which is exactly where the
    // silhouette edge is and where the value most needs to be settled.
    let r; let g; let b;
    if (u < 0.55) {
      const f = u / 0.55;
      r = belly[0] + (flank[0] - belly[0]) * f;
      g = belly[1] + (flank[1] - belly[1]) * f;
      b = belly[2] + (flank[2] - belly[2]) * f;
    } else {
      const f = (u - 0.55) / 0.45;
      r = flank[0] + (back[0] - flank[0]) * f;
      g = flank[1] + (back[1] - flank[1]) * f;
      b = flank[2] + (back[2] - flank[2]) * f;
    }

    if (bandDepth > 0) {
      const axis = bandAxis === 0 ? x : bandAxis === 1 ? y : z;
      const m = smootherstep(0.45, 0.9, Math.abs(Math.sin(axis * bandFreq))) * bandDepth;
      r += (band[0] - r) * m;
      g += (band[1] - g) * m;
      b += (band[2] - b) * m;
    }

    if (ribDepth > 0) {
      const c = Math.cos(ribCount * Math.atan2(x, z));
      const m = c * c * c * c * ribDepth;
      r += (ribCol[0] - r) * m;
      g += (ribCol[1] - g) * m;
      b += (ribCol[2] - b) * m;
    }

    const k = 1 + mottle * noise.fbm3(x * freq, y * freq, z * freq, { octaves: 3 });
    out[0] = r * k;
    out[1] = g * k;
    out[2] = b * k;
  };
}

/** A constant tint function — for limbs and parts that take one flat colour. */
function flatTinter(hex) {
  const c = hexToLinear(hex, [0, 0, 0]);
  return (x, y, z, upFacing, t, out) => {
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
  };
}

/**
 * Sample a resampled spine at a world z, for hanging parts off the surface.
 *
 * Every dorsal plate, spur and crystal growth in this module is placed through
 * this rather than against the control points it was authored from. The two are
 * not the same curve — a Catmull-Rom spline does not pass through the midpoint
 * of its own control polygon — and a shard placed against the polygon floats a
 * centimetre off a back that ended up somewhere else.
 */
function atZ(path, z) {
  let lo = path.length - 2;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i][2];
    const b = path[i + 1][2];
    if ((z >= a && z <= b) || (z <= a && z >= b)) {
      lo = i;
      break;
    }
  }
  const a = path[lo];
  const b = path[Math.min(path.length - 1, lo + 1)];
  const span = b[2] - a[2];
  const f = clamp(Math.abs(span) < 1e-6 ? 0 : (z - a[2]) / span, 0, 1);
  const out = new Array(6);
  for (let k = 0; k < 6; k++) out[k] = a[k] + (b[k] - a[k]) * f;
  return out;
}

/** Top of the sweep's skin at a given z — where a dorsal spine or plate sits. */
function dorsal(path, z) {
  const p = atZ(path, z);
  return p[1] + p[3] * (1 + p[5]);
}

/* -------------------------------------------------------------------------- */
/* Eyes                                                                       */
/* -------------------------------------------------------------------------- */

const _eyeMat = new THREE.Matrix4();
const _eyePos = new THREE.Vector3();
const _eyeQuat = new THREE.Quaternion();
const _eyeScale = new THREE.Vector3();
const _eyeFace = new THREE.Vector3();
const _IDENTITY = new THREE.Quaternion();

function _eyeDir(face) {
  return _eyeFace.set(face[0], face[1], face[2]).normalize();
}

/** Place a transformed copy of the shared icosahedron. */
function blob(mb, sphere, at, sx, sy, sz, color, quat = null) {
  _eyePos.set(at[0], at[1], at[2]);
  _eyeQuat.copy(quat ?? _IDENTITY);
  _eyeScale.set(sx, sy, sz);
  _eyeMat.compose(_eyePos, _eyeQuat, _eyeScale);
  pushGeometry(mb, sphere, _eyeMat, color);
}

/**
 * One eye: a bright lens in the glow buffer, a near-black socket dome a third
 * larger in the hide buffer behind it.
 *
 * Both halves are required. The plate's read (module header, finding 3) is a
 * near-black mark inside a near-white one, and an emissive lens dropped straight
 * onto a mid-value hide has the brightness but not the *contrast* — at battle
 * distance it reads as a spark stuck to the animal rather than as an eye set
 * into it. `socket` is the darkest colour on the creature by construction.
 */
function eye(hide, lens, o) {
  const facing = _eyeDir(o.face);
  const quat = new THREE.Quaternion().setFromUnitVectors(REF_FWD, facing);
  const at = o.at;

  // Both halves take the UV sphere rather than the icosahedron every other blob
  // uses. The eye is the single most-looked-at 40 px on the creature and a
  // detail-0 icosahedron silhouettes as a pentagon — the socket worse than the
  // lens, because it is the larger shape. An 8x4 UV sphere is an octagon in
  // silhouette at 45 shared vertices; the icosahedron subdivision that would
  // have matched it is *non-indexed* and costs 240, which is how the first build
  // put more vertices into three eyes than into the entire bell.
  blob(hide, o.lensSphere ?? o.sphere,
    at, o.radius * 1.24, o.radius * 1.24, o.radius * 0.70, o.socketColor, quat);

  // The lens sits proud of the socket along the facing axis, so the socket is a
  // ring around it from every angle the battle camera can reach.
  const out = [
    at[0] + facing.x * o.radius * 0.30,
    at[1] + facing.y * o.radius * 0.30,
    at[2] + facing.z * o.radius * 0.30,
  ];
  blob(lens, o.lensSphere ?? o.sphere,
    out, o.radius, o.radius * (o.squash ?? 0.86), o.radius * 0.86, o.lensColor, quat);
}

/* -------------------------------------------------------------------------- */
/* Species: glassmane — the quadruped                                         */
/* -------------------------------------------------------------------------- */

/**
 * A stalking courser. The silhouette decisions, in the order they matter:
 *
 *  - **The head is below the shoulder.** Withers crest at y 0.85 of the
 *    creature's height, skull centre at 0.46. A raised head is a grazing animal
 *    and a lowered one is a hunting animal, and that single relationship carries
 *    more threat than any amount of spikes.
 *  - **The back line falls from the withers to the rump**, so the mass reads as
 *    front-loaded — chest and shoulder heavy, haunch light.
 *  - **The hind leg is reverse-jointed** (hip 0.50 → stifle 0.35 forward → hock
 *    0.20 back → paw). A straight hind leg is the fastest way to make a
 *    quadruped read as a table.
 *  - **The crest is a value break, not a colour one.** The mane is the only
 *    lit-edged mass above the shoulder line, so the eye lands on the head end.
 *
 * ## The restyle: charcoal fur, no crystals, and forms the cast would recognise
 *
 * The review's finding was an "off-style magenta-crystal wolf". Three things
 * were producing that and none of them was fixable by moving it:
 *
 *  1. **The crest and shoulder rows were emissive violet crystal.** They are
 *     gone entirely — the `glow` buffer is never written by this species now, so
 *     the creature also ships one mesh and one material lighter — and replaced
 *     by rows of {@link furShell} locks along the spine, the haunch and the
 *     tail. That is the same read the plate's own cast gets from its fur
 *     collars: a ragged lit edge over a dark mass.
 *  2. **The joints were armour.** Four hard-edged `plate()` scutes with proud
 *     ridges sat on the shoulders and haunches — the right primitive for the
 *     insectoid and the wrong one for a mammal, and against a party built from
 *     rounded chibi masses it read as a mechanical thing. The mass is now
 *     carried by the *sweep* instead: the trunk's control radii bulge at the
 *     shoulder and haunch and draw in at the loin, which is a muscle rather than
 *     a bolted plate, and the radial count comes up so the bulges resolve as
 *     round.
 *  3. **The skull wore a helmet.** Two swept-back horns were the tallest thing
 *     on the head and the single most "different game" element in the frame.
 *     They are gone; the ears grow instead, from spurs to broad amber-lined
 *     blades, which is also the cheapest cue that this is an animal.
 *
 * ## The stance rebuild, and why it was structural rather than a tuning pass
 *
 * This animal was authored as a field mob and then asked to be the frame's
 * antagonist, and it failed at that for one measurable reason: it was **1.78 ×
 * as long as it was tall**. A creature with that ratio, staged broadside at a
 * frame height that reads as a threat, is 0.87 of `ndc` across — 43% of the
 * image — and a six-figure line plus the HP/MP/BP stack does not leave that
 * much. The stage's own answer was to drop it and stage the floater instead,
 * which is how the shipped frame came to have an abstract ribbed dome in it
 * where an animal belonged. No amount of repositioning reaches that; the
 * proportion is the defect.
 *
 * So the animal stands up. {@link STANCE} lifts the trunk, neck, skull, tail and
 * every plate hung off them by 0.15 of the authoring height while the paws stay
 * planted, which lengthens all four legs by the same amount; the tail loses
 * 0.08, being the one part that is pure length and contributes nothing to the
 * height it is measured against. Read off the built buffers at a staged 1.80 m
 * the ratio is now **1.48** against 1.79, and the yawed projection the stage
 * actually uses is 2.07 m — half of `ndc` at the encounter's depth, against the
 * 0.87 that got it rejected. It is also a better animal: a courser carries its
 * chest well clear of the ground, and the previous build's 0.48-unit legs under
 * a 0.34-unit-deep barrel read as a badger.
 *
 * Three head corrections ride with it, all aimed at the same target — that a
 * creature at 400 px of frame height has to resolve as a *face*:
 *
 *  - **Eyes at 0.052 against 0.037.** Module finding 3 sets lens diameter at
 *    0.19–0.31 of head width and the old pair sat at the bottom of that band;
 *    on a head presented three-quarter rather than broadside, the far eye is
 *    foreshortened to about 60% and fell under the size at which an eye reads as
 *    an eye at all. They also face further forward (0.83 of the facing vector on
 *    z against 0.72) so both are presented from the stage's own bearing.
 *  - **Ears.** The single cheapest "this is an animal" cue there is, and the
 *    build had none — the skull's only projections were a pair of swept-back
 *    horns, which read as a helmet. Two broad blades now carry the whole of that
 *    read, and they carry the animal's one accent colour on their inner face.
 *  - **An open mouth line.** The jaw drops 0.02 clear of the muzzle and a plate
 *    in the socket colour — the darkest value on the animal — fills the seam, so
 *    the head carries a dark horizontal mark under the eyes. A closed muzzle at
 *    this scale is a snout; a dark line under it is a mouth.
 */
/**
 * @param {MeshBuffer} hide the body buffer.
 * @param {MeshBuffer} unusedGlow the crystal-growth buffer, which this species
 *   deliberately never writes — see the restyle note above. The parameter stays
 *   because every builder shares one call signature, and leaving it named `glow`
 *   would read as an oversight rather than as a decision. `buildCreature` skips
 *   the growth mesh, its material and its draw call entirely when it comes back
 *   empty, so the quadruped ships two meshes where the other two ship three.
 * @param {MeshBuffer} lens the emissive eye buffer.
 * @param {Object} ctx palette, rng, noise and the shared eye spheres.
 */
function buildGlassmane(hide, unusedGlow, lens, ctx) {
  const { pal, rng, noise, sphere, lensSphere } = ctx;
  /**
   * How far the body sits above the ground it was originally authored at, in
   * authoring units. Applied through {@link Y} to everything carried by the
   * skeleton and *not* to the paws, which is what turns a lift into a leg.
   */
  const STANCE = 0.15;
  /** Body-frame height: authored elevation plus the stance lift. */
  const Y = (v) => v + STANCE;
  const tintBody = hideTinter(pal, noise, {
    mottle: 0.07, bandFreq: 9, bandDepth: 0.34, bandColor: pal.hide, noiseFreq: 6,
  });
  const tintLimb = hideTinter(pal, noise, {
    back: pal.hide, flank: pal.flank, belly: pal.flank, mottle: 0.05, noiseFreq: 9,
  });
  const boneCol = hexToLinear(pal.bone, [0, 0, 0]);
  const plateCol = hexToLinear(pal.plate, [0, 0, 0]);
  const ridgeCol = hexToLinear(pal.ridge, [0, 0, 0]);
  const darkCol = hexToLinear(pal.socket, [0, 0, 0]);
  const accentCol = hexToLinear(pal.accent, [0, 0, 0]);
  const flankCol = hexToLinear(pal.flank, [0, 0, 0]);
  const bellyCol = hexToLinear(pal.belly, [0, 0, 0]);
  const hideCol = hexToLinear(pal.hide, [0, 0, 0]);

  /**
   * Trunk, neck and skull as one skin, and the **muscle is in the radii**.
   *
   * Overlapping ellipsoids would each contribute their own silhouette edge and
   * light up separately under the rim, so the animal would read as a string of
   * bubbles; one swept skin has exactly one contour. What that skin has to do,
   * now the armour scutes over the joints are gone, is carry the joints itself.
   *
   * So the radius channel runs a real animal's profile rather than a smooth
   * taper: 0.192 over the shoulder at z 0.150, drawn in to 0.146 at the loin
   * (z −0.140) and back out to 0.176 over the haunch (z −0.300). That 25%
   * excursion is what the eye reads as a chest and a hindquarter with a waist
   * between them, and it is the same device the cast's own torsos use — the
   * form is in the silhouette, not in a panel painted on it.
   *
   * `radial` 12 rather than 10, because those bulges are the read: at 10 the
   * shoulder's widest ring is a decagon and the specular band on it steps.
   */
  const trunk = sweep(hide, [
    [0, Y(0.520), -0.560, 0.032, 0.90, 0.00],
    [0, Y(0.545), -0.440, 0.126, 1.10, 0.08],
    [0, Y(0.552), -0.300, 0.176, 1.24, 0.12],
    [0, Y(0.556), -0.210, 0.166, 1.14, 0.14],
    [0, Y(0.560), -0.140, 0.146, 1.02, 0.16],
    [0, Y(0.588), 0.010, 0.162, 1.02, 0.20],
    [0, Y(0.625), 0.150, 0.192, 1.08, 0.24],
    [0, Y(0.608), 0.285, 0.168, 1.14, 0.18],
    [0, Y(0.580), 0.380, 0.110, 0.98, 0.14],
    [0, Y(0.540), 0.470, 0.086, 0.92, 0.12],
    [0, Y(0.495), 0.550, 0.080, 0.92, 0.10],
    [0, Y(0.464), 0.618, 0.108, 1.14, 0.08],
    [0, Y(0.448), 0.698, 0.074, 0.92, 0.05],
    [0, Y(0.432), 0.772, 0.046, 0.80, 0.02],
    [0, Y(0.428), 0.822, 0.016, 0.70, 0.00],
  ], { samples: 32, radial: 12, belly: 0.30, tint: tintBody });

  // Lower jaw, dropped 0.02 clear of the muzzle and darker than the hide. The
  // gap is the point: a mouth at this scale is a dark horizontal mark under the
  // eyes, and a shading model with a soft terminator will not draw one on a
  // closed muzzle at any light angle.
  sweep(hide, [
    [0, Y(0.416), 0.610, 0.042, 0.95, 0.00],
    [0, Y(0.398), 0.690, 0.036, 0.90, 0.00],
    [0, Y(0.388), 0.762, 0.024, 0.80, 0.00],
    [0, Y(0.386), 0.806, 0.008, 0.70, 0.00],
  ], { samples: 8, radial: 7, belly: 0.35, tint: flatTinter(pal.hide) });
  // The seam itself, in the darkest colour on the animal, spanning the gap the
  // dropped jaw opened so the mouth reads as an aperture and not as a groove
  // between two tubes.
  plate(hide, {
    center: [0, Y(0.424), 0.706], axis: [0, -0.10, 1], normal: [0, 1, 0.06],
    length: 0.190, width: 0.062, rise: -0.014, lip: 0.008,
    color: darkCol, ridgeColor: darkCol,
  });

  // Legs. Four sweeps, radial 6: a hexagonal limb is indistinguishable from a
  // round one once it is 40 px tall and costs 40% of the raster. The hip end
  // rides the stance lift and the paw does not, which is what lengthens them.
  for (const s of [1, -1]) {
    sweep(hide, [
      [s * 0.112, Y(0.520), 0.250, 0.076],
      [s * 0.120, Y(0.300), 0.292, 0.058],
      [s * 0.116, Y(0.115), 0.232, 0.040],
      [s * 0.114, 0.078, 0.258, 0.036],
      [s * 0.112, 0.040, 0.300, 0.044],
    ], { samples: 12, radial: 6, tint: tintLimb });
    sweep(hide, [
      [s * 0.128, Y(0.510), -0.300, 0.090],
      [s * 0.136, Y(0.330), -0.226, 0.070],
      [s * 0.128, Y(0.145), -0.352, 0.044],
      [s * 0.120, 0.076, -0.302, 0.036],
      [s * 0.118, 0.040, -0.262, 0.044],
    ], { samples: 12, radial: 6, tint: tintLimb });

    // Claws, three per paw. Tetrahedra: three triangles each and solid, so a
    // paw keeps its grip on the ground from any camera azimuth.
    for (let c = 0; c < 3; c++) {
      const off = (c - 1) * 0.026;
      spike(hide, {
        origin: [s * 0.112 + off, 0.030, 0.332], dir: [off * 2, -0.42, 1],
        length: 0.046, radius: 0.013, sides: 3, color: boneCol,
      });
      spike(hide, {
        origin: [s * 0.118 + off, 0.030, -0.230], dir: [off * 2, -0.42, 1],
        length: 0.044, radius: 0.013, sides: 3, color: boneCol,
      });
    }

    /**
     * Shoulder and haunch **fur**, where four armour scutes used to sit.
     *
     * The scutes were solving a real problem — the joint between limb and trunk
     * is where a swept quadruped's form is hardest to read, and a light-valued
     * mass there is what settles it — with the wrong material. Overlapping
     * shells solve the same problem in the cast's own vocabulary: each lock is
     * lit on its outer face and drops a hard edge onto the one behind it, so the
     * joint gains a run of value breaks that follows the muscle instead of a
     * plate bolted across it.
     *
     * Four per joint, back-swept and lengthening downward, with the tips in the
     * pale belly colour: the value climbs *away* from the body, which is what a
     * coat does where it catches the sky and what keeps the shoulder reading as
     * round rather than as a lit rectangle.
     */
    for (let t = 0; t < 4; t++) {
      const f = t / 3;
      furShell(hide, {
        origin: [s * (0.132 + f * 0.012), Y(0.660 - f * 0.115), 0.250 - f * 0.030],
        dir: [s * 0.62, -0.42 - f * 0.30, -0.24],
        side: [0, 0.30, 1],
        length: 0.115 + f * 0.055 + rng.range(-0.010, 0.010),
        width: 0.100 - f * 0.018,
        bend: [s * 0.010, -0.024, -0.018],
        color: hideCol, tipColor: ridgeCol,
      });
      furShell(hide, {
        origin: [s * (0.136 + f * 0.010), Y(0.612 - f * 0.100), -0.300 - f * 0.020],
        dir: [s * 0.60, -0.40 - f * 0.28, -0.34],
        side: [0, 0.30, 1],
        length: 0.100 + f * 0.045 + rng.range(-0.010, 0.010),
        width: 0.092 - f * 0.016,
        bend: [s * 0.008, -0.020, -0.022],
        color: hideCol, tipColor: flankCol,
      });
    }
    // Elbow feathering, kept from the scute build: a short forward-swept run
    // under the shoulder, which is what stops the foreleg reading as a pipe
    // pushed into the barrel.
    for (let t = 0; t < 3; t++) {
      furShell(hide, {
        origin: [s * 0.126, Y(0.318 + t * 0.026), 0.296 - t * 0.014],
        dir: [s * 0.55, -0.38 - t * 0.20, 0.72],
        length: 0.082 + rng.range(-0.010, 0.010), width: 0.060,
        bend: [0, -0.014, 0.010],
        color: flankCol, tipColor: bellyCol,
      });
    }
  }

  // Tail, and the tuft that terminates it. A tail is cheap and it is half of
  // what tells the eye which end of a quadruped it is looking at.
  //
  // Shortened by 0.08 with the stance rebuild. The tail is pure length and
  // contributes nothing to the height it is measured against, so it was the
  // cheapest 5% of the length:height ratio available — and a courser's tail is
  // a counterweight, not a train.
  const tail = sweep(hide, [
    [0, Y(0.535), -0.560, 0.044],
    [0, Y(0.572), -0.642, 0.032],
    [0, Y(0.552), -0.700, 0.021],
    [0, Y(0.500), -0.740, 0.012],
  ], { samples: 12, radial: 5, tint: tintLimb });
  /**
   * The tail is **brushed**, not tufted, and that is the whole difference.
   *
   * It used to terminate in a rosette of five spikes at one station — a pompom,
   * which is a shape no fur has. A tail's read is a *taper of overlapping locks*
   * running the length of it, thin at the root and heaviest two thirds out, and
   * it is one of the two places on this animal where the silhouette is nothing
   * but fur. Six pairs down the sweep, alternating sides and lengthening toward
   * the tip, give exactly that for eighteen triangles.
   */
  for (let t = 0; t < 6; t++) {
    const f = t / 5;
    const z = -0.590 - f * 0.150;
    const p = atZ(tail, z);
    const len = 0.055 + 0.075 * Math.sin(Math.PI * (0.22 + f * 0.72));
    for (const s of [1, -1]) {
      furShell(hide, {
        origin: [s * p[3] * 0.55, p[1] - p[3] * 0.25, z],
        dir: [s * 0.72, -0.30 - f * 0.24, -0.60],
        side: [0, 1, 0.15],
        length: len + rng.range(-0.008, 0.008),
        width: 0.058 + f * 0.020,
        bend: [0, -0.018, -0.014],
        color: hideCol, tipColor: flankCol,
      });
    }
  }

  // Chest ruff — five locks under the throat, breaking the neck-to-chest
  // transition that a single swept skin makes too clean. The plate's own cast
  // wears a fur collar in exactly this position (`bravely05.jpg`), and the read
  // it gets there is the read this is after: a pale ragged edge under a dark
  // head, which is what separates the two masses without a contour line.
  for (let t = 0; t < 5; t++) {
    const s = t % 2 === 0 ? 1 : -1;
    furShell(hide, {
      origin: [s * 0.045 * (t % 3), Y(0.505 - t * 0.018), 0.415 + t * 0.012],
      dir: [s * 0.35, -0.55, 0.76],
      side: [1, 0, -0.4],
      length: 0.115 + rng.range(-0.015, 0.015), width: 0.082,
      bend: [0, -0.022, 0.014],
      color: flankCol, tipColor: bellyCol,
    });
  }

  // Brow ridges — a heavy plate over each eye. Without them the skull sweep has
  // nothing to set the eye into and the lens reads as painted on.
  for (const s of [1, -1]) {
    plate(hide, {
      center: [s * 0.058, Y(0.492), 0.652], axis: [0.15 * s, -0.18, 1], normal: [s * 0.55, 0.82, 0.15],
      length: 0.115, width: 0.078, rise: 0.020, lip: 0.014,
      color: hideCol, ridgeColor: plateCol,
    });
    /**
     * The ears carry the whole top of the skull now that the horns are gone.
     *
     * A pair of broad blades rather than a pair of spurs: 0.175 long against the
     * old 0.130 and set higher and more upright, so they are the tallest thing
     * on the animal and give the head an outline the neck cannot be confused
     * with — which is the job the horns were doing, done by a shape that belongs
     * to a mammal.
     *
     * Two shells each, back to back. The outer one is hide-dark, the inner one
     * is the animal's single accent, and it is 6% shorter and pushed forward so
     * it sits *inside* the outer blade's outline: that is a lit amber membrane
     * inside a charcoal ear, which is where the eye is meant to go second, after
     * the eyes themselves.
     */
    furShell(hide, {
      origin: [s * 0.062, Y(0.500), 0.588], dir: [s * 0.44, 0.86, -0.26],
      side: [0, 0.20, 1],
      length: 0.175, width: 0.112, waist: 0.62,
      bend: [s * 0.014, 0.0, -0.042],
      color: hideCol, tipColor: flankCol,
    });
    furShell(hide, {
      origin: [s * 0.058, Y(0.498), 0.598], dir: [s * 0.42, 0.87, -0.24],
      side: [0, 0.20, 1],
      length: 0.164, width: 0.086, waist: 0.60,
      bend: [s * 0.012, 0.0, -0.040],
      color: darkCol, tipColor: accentCol,
    });
    // Fangs, visible under the muzzle at any azimuth the stage camera reaches.
    // Dropped with the jaw so they sit inside the mouth line rather than over it.
    spike(hide, {
      origin: [s * 0.030, Y(0.400), 0.752], dir: [s * 0.12, -1, 0.18],
      length: 0.050, radius: 0.012, sides: 3, color: boneCol,
    });
    spike(hide, {
      origin: [s * 0.036, Y(0.406), 0.694], dir: [s * 0.15, -1, 0.05],
      length: 0.038, radius: 0.010, sides: 3, color: boneCol,
    });
    // Set wide on the skull and strongly squashed. A round eye on the midline
    // reads as a pet; a narrow one set out toward the cheek reads as a predator,
    // and the plate's own eyes are 2.6 times as wide as they are tall.
    //
    // 0.052 against 0.037, and turned further forward: staged three-quarter the
    // far eye foreshortens to ~60% of its own width, and the old radius put it
    // under the size at which a lens reads as an eye rather than as a highlight.
    eye(hide, lens, {
      sphere, lensSphere, at: [s * 0.064, Y(0.470), 0.660], face: [s * 0.54, 0.12, 0.83],
      radius: 0.052, squash: 0.60, socketColor: darkCol, lensColor: [1, 1, 1],
    });
    // The cheek. A soft muzzle sweep alone reads as a swelling in the neck and
    // something has to separate a head from a tube — but the hard-edged scute
    // that used to do it belonged to the armoured build. A single lock swept
    // back along the jaw line does the same work in fur: it draws the same
    // boundary and it catches the key on one face, so the jaw still has an edge
    // and the head still has a plane.
    furShell(hide, {
      origin: [s * 0.078, Y(0.442), 0.690], dir: [s * 0.46, -0.10, -0.88],
      side: [0, 1, 0.1],
      length: 0.150, width: 0.086, waist: 0.66,
      bend: [s * 0.010, 0.014, 0],
      color: plateCol, tipColor: ridgeCol,
    });
  }

  /**
   * The mane — **fur, on the hide buffer, where nine emissive crystal shards
   * used to stand.**
   *
   * The crest's job has not changed: it is the value break above the shoulder
   * line that lands the eye on the head end, and it is the only silhouette the
   * animal has along its back. What changed is that it was made of the wrong
   * substance and in the wrong colour — a row of glowing violet cones, which
   * is the single element the review named as belonging to another game.
   *
   * Eleven pairs of {@link furShell} locks, laid in overlapping ranks either
   * side of the dorsal line rather than on it. That is the correction that
   * matters most: a *single* row of anything along a midline is a comb from
   * every bearing, because there is nothing behind a lock for it to overlap.
   * Offsetting each pair to ±0.35 of the trunk's own radius and giving the two
   * sides opposite sweeps produces a mane with a near rank and a far rank, so
   * from the stage's three-quarter bearing the eye reads depth in it.
   *
   * Placed against the *resampled* spine through `dorsal`/`atZ` rather than
   * against the control points, so no lock can float off a back it was authored
   * before and the stance lift carries the whole row without a coordinate here
   * changing.
   */
  const MANE = 11;
  for (let i = 0; i < MANE; i++) {
    const f = i / (MANE - 1);
    const z = 0.560 - f * 0.560;
    const y = dorsal(trunk, z) - 0.014;
    const p = atZ(trunk, z);
    // Longest over the neck and shoulder, tapering both ways: the mane is a
    // shape in its own right and a constant-length row is a brush.
    const len = 0.070 + 0.135 * Math.pow(Math.sin(Math.PI * (0.10 + f * 0.84)), 0.6);
    for (const s of [1, -1]) {
      furShell(hide, {
        origin: [s * p[3] * 0.35, y - p[3] * 0.05, z],
        dir: [s * 0.30, 1, -0.50 - f * 0.22],
        side: [1, 0, 0.35 * s],
        length: len * rng.range(0.88, 1.12),
        width: 0.086 + 0.030 * (1 - f),
        bend: [s * 0.012, -0.010, -0.038],
        // Root in the coat's own charcoal, tip in the lit fur value: the lock
        // brightens as it leaves the body, which is the only way a mane reads
        // against a dark back under a soft terminator.
        color: hideCol, tipColor: ridgeCol,
      });
    }
  }
  // A lower flanking run over the shoulder, shorter and further down the flank,
  // so the mane has a skirt as well as a crest and the two ranks above do not
  // end on a hard line halfway down the body.
  for (let i = 0; i < 4; i++) {
    for (const s of [1, -1]) {
      const z = 0.420 - i * 0.150;
      const p = atZ(trunk, z);
      furShell(hide, {
        origin: [s * p[3] * p[4] * 0.66, p[1] + p[3] * 0.62, z],
        dir: [s * 0.66, 0.66, -0.36],
        side: [0, 1, 0.2],
        length: 0.076 + i * 0.014, width: 0.070,
        bend: [s * 0.008, -0.014, -0.020],
        color: hideCol, tipColor: flankCol,
      });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Species: driftbell — the floater                                           */
/* -------------------------------------------------------------------------- */

/**
 * A hovering bell. Everything about it is chosen to be the *opposite read* to
 * the quadruped: vertical rather than horizontal, top-heavy rather than
 * front-heavy, and terminating in trailing streamers rather than in feet, so
 * the two are separable as pure black shapes.
 *
 * The bell is a surface of revolution with a six-fold radius modulation, which
 * gives it six vertical flutes for the cost of one cosine per vertex. Flutes
 * matter more than they sound: an unmodulated dome under a soft terminator is a
 * value gradient with no incident in it at all, and this creature has no limbs
 * to supply any.
 *
 * **The rib count is `radial / 2` and that is not a coincidence.** The first
 * build ran seven ribs against twelve radial vertices, which samples the cosine
 * at incommensurate phase and produced no flutes at all — just a slightly noisy
 * sphere. At `radial = 2 · ribs` every vertex lands exactly on a crest or a
 * trough, so the cross-section is a clean six-lobed rosette and the silhouette
 * scallops. The depth went 0.055 → 0.155 for the same reason the plates' rise
 * did: on a 0.25 radius, 5% is 12 mm and nothing at battle distance sees it.
 * A matching six-fold *tint* rides on top through `ribCount`, because the
 * silhouette only carries the ribs at the edges and the facing surface needs
 * them too.
 *
 * The mouth is capped rather than left open. An open tube shows its back faces,
 * and a fold that tucks the rim inward inverts the winding at the fold — either
 * way the underside is wrong from below. A closed oral disc with a glowing core
 * hung beneath it reads better and costs less.
 */
function buildDriftbell(hide, glow, lens, ctx) {
  const { pal, rng, noise, sphere, lensSphere } = ctx;
  const tintBell = hideTinter(pal, noise, {
    mottle: 0.05, bandFreq: 9, bandDepth: 0.22, bandColor: pal.hide, bandAxis: 1, noiseFreq: 5,
    ribCount: 6, ribTintDepth: 0.48, ribColor: 0x60587e,
  });
  const tintRibbon = hideTinter(pal, noise, {
    back: pal.flank, flank: pal.plate, belly: pal.ridge, mottle: 0.05, noiseFreq: 8,
  });
  const plateCol = hexToLinear(pal.plate, [0, 0, 0]);
  const ridgeCol = hexToLinear(pal.ridge, [0, 0, 0]);
  const darkCol = hexToLinear(pal.socket, [0, 0, 0]);
  const growthCol = hexToLinear(pal.growth, [0, 0, 0]);
  const growthTip = hexToLinear(pal.emissive, [0, 0, 0]);

  sweep(hide, [
    [0, 0.872, 0, 0.014],
    [0, 0.856, 0, 0.060],
    [0, 0.824, 0, 0.116],
    [0, 0.776, 0, 0.166],
    [0, 0.712, 0, 0.204],
    [0, 0.640, 0, 0.228],
    [0, 0.566, 0, 0.244],
    [0, 0.498, 0, 0.252],
    [0, 0.448, 0, 0.246],
    [0, 0.418, 0, 0.206],
    [0, 0.408, 0, 0.128],
    [0, 0.404, 0, 0.048],
  ], { samples: 16, radial: 12, ribs: 6, ribDepth: 0.155, tint: tintBell });

  // Rim lappets — sixteen, alternating long and short, which is what turns a
  // machined-looking rim into a scalloped organic one. Three-sided and solid.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const long = i % 2 === 0;
    const r = 0.196;
    spike(hide, {
      origin: [Math.cos(a) * r, 0.428, Math.sin(a) * r],
      dir: [Math.cos(a) * 0.42, -1, Math.sin(a) * 0.42],
      length: (long ? 0.135 : 0.082) * rng.range(0.9, 1.1),
      radius: long ? 0.032 : 0.026, sides: 3,
      color: plateCol, tipColor: ridgeCol,
    });
  }

  // Trailing tendrils. Five, each drifting on its own axis — the one part of
  // this creature that says "floating" rather than "standing", so they are the
  // one part allowed to reach nearly to the ground.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const r0 = 0.055 + rng.range(0, 0.045);
    const drift = rng.range(0.10, 0.19);
    const swing = rng.range(-1, 1);
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    sweep(hide, [
      [cx * r0, 0.404, cz * r0, 0.026],
      [cx * (r0 + drift * 0.5), 0.316, cz * (r0 + drift * 0.5), 0.020],
      [cx * (r0 + drift) + swing * 0.05, 0.226, cz * (r0 + drift) - swing * 0.05, 0.015],
      [cx * (r0 + drift * 0.6) + swing * 0.09, 0.138, cz * (r0 + drift * 0.6) - swing * 0.09, 0.010],
      [cx * (r0 + drift * 0.2) + swing * 0.04, 0.062, cz * (r0 + drift * 0.2) - swing * 0.04, 0.005],
    ], { samples: 9, radial: 4, tint: tintRibbon });
  }

  // Crown shards. Five around a taller centre, so the top of the silhouette is
  // a spray and not a point.
  spike(glow, {
    origin: [0, 0.852, 0], dir: [0, 1, -0.06],
    length: 0.152, radius: 0.032, waist: 0.44, sides: 4,
    color: growthCol, tipColor: growthTip,
  });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    spike(glow, {
      origin: [Math.cos(a) * 0.058, 0.838, Math.sin(a) * 0.058],
      dir: [Math.cos(a) * 0.42, 1, Math.sin(a) * 0.42],
      length: 0.108 * rng.range(0.88, 1.12), radius: 0.026, waist: 0.44, sides: 4,
      color: growthCol, tipColor: growthTip,
    });
  }

  // The core, slung under the oral disc. It is the only lit thing below the
  // bell, so it separates the creature from its own shadow on the ground — the
  // read a floater needs and a walker does not.
  blob(glow, sphere, [0, 0.392, 0], 0.088, 0.062, 0.088, growthTip);

  // Three eyes in an arc across the bell's front, the centre one nearly twice
  // the others. A single eye reads as a machine; an arc reads as a face.
  eye(hide, lens, {
    sphere, lensSphere, at: [0, 0.596, 0.248], face: [0, 0.08, 1],
    radius: 0.047, squash: 0.90, socketColor: darkCol, lensColor: [1, 1, 1],
  });
  for (const s of [1, -1]) {
    eye(hide, lens, {
      sphere, lensSphere, at: [s * 0.132, 0.618, 0.212], face: [s * 0.62, 0.16, 0.77],
      radius: 0.029, squash: 0.88, socketColor: darkCol, lensColor: [1, 1, 1],
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Species: shardmite — the armoured insectoid                                */
/* -------------------------------------------------------------------------- */

/**
 * A low, wide, six-legged digger. Read decisions:
 *
 *  - **Wide and flat.** `lat` runs to 1.70 against the quadruped's 1.18, and the
 *    ventral flattening to 0.45, so the body is a 0.62 m-wide shield 0.19 m off
 *    the ground. Nothing else in the catalogue is shaped like that.
 *  - **Knees above the back.** An insect's femur-tibia joint rises over the
 *    thorax and the leg descends to the ground outside the body's own width.
 *    Legs that hang straight down turn any six-legged animal into a table with
 *    two extra legs; this one places the knee at y 0.40 against a thorax top of
 *    0.62 and lands the foot 0.36 outside the flank.
 *  - **Segmentation is authored, not shaded.** Six overlapping tergites down the
 *    spine, each with a proud front lip and a light ridge. The soft terminator
 *    this project shades with will not carve a segment boundary on its own.
 *  - **The eyes are set on the sides of the cranium, not the front.** Lens
 *    diameter is 0.30 of head width — the same as the quadruped's — but the pair
 *    faces outward at 55°, which is the difference between an insect and a
 *    mammal with too many legs. This head is the smallest and lowest of the
 *    three, so it gets the catalogue's largest eyes in absolute terms.
 */
function buildShardmite(hide, glow, lens, ctx) {
  const { pal, rng, noise, sphere, lensSphere } = ctx;
  const tintBody = hideTinter(pal, noise, {
    mottle: 0.06, bandFreq: 13, bandDepth: 0.26, bandColor: pal.hide, noiseFreq: 6,
  });
  const tintLeg = hideTinter(pal, noise, {
    back: pal.hide, flank: pal.flank, belly: pal.plate, mottle: 0.04, noiseFreq: 10,
  });
  const plateCol = hexToLinear(pal.plate, [0, 0, 0]);
  const ridgeCol = hexToLinear(pal.ridge, [0, 0, 0]);
  const boneCol = hexToLinear(pal.bone, [0, 0, 0]);
  const darkCol = hexToLinear(pal.socket, [0, 0, 0]);
  const growthCol = hexToLinear(pal.growth, [0, 0, 0]);
  const growthTip = hexToLinear(pal.emissive, [0, 0, 0]);

  const body = sweep(hide, [
    [0, 0.300, -1.000, 0.020, 1.00, 0.00],
    [0, 0.310, -0.900, 0.090, 1.30, 0.20],
    [0, 0.330, -0.740, 0.170, 1.55, 0.30],
    [0, 0.345, -0.540, 0.215, 1.70, 0.34],
    [0, 0.350, -0.330, 0.222, 1.68, 0.34],
    [0, 0.350, -0.130, 0.208, 1.58, 0.32],
    [0, 0.355, 0.030, 0.196, 1.50, 0.30],
    [0, 0.360, 0.190, 0.205, 1.58, 0.28],
    [0, 0.350, 0.330, 0.170, 1.40, 0.22],
    [0, 0.330, 0.430, 0.110, 1.10, 0.14],
  ], { samples: 22, radial: 12, belly: 0.45, tint: tintBody });

  // Head: a separate wedge, wider than the neck it sits on, so the join reads as
  // a neck rather than as a taper.
  sweep(hide, [
    [0, 0.325, 0.418, 0.112, 1.20, 0.10],
    [0, 0.316, 0.500, 0.135, 1.30, 0.12],
    [0, 0.300, 0.570, 0.108, 1.15, 0.10],
    [0, 0.288, 0.626, 0.058, 0.85, 0.05],
    [0, 0.284, 0.658, 0.012, 0.60, 0.00],
  ], { samples: 10, radial: 10, belly: 0.35, tint: tintBody });

  // Nasal horn and mandibles. Together they are the whole front-on read, and the
  // horn is what makes the creature's height at the head end nonzero.
  spike(hide, {
    origin: [0, 0.330, 0.520], dir: [0, 0.90, 0.44],
    length: 0.260, radius: 0.046, waist: 0.40, sides: 4,
    bend: [0, 0.030, 0.030], color: plateCol, tipColor: boneCol,
  });
  // Pronotum — the shield across the front of the thorax. Without it the head
  // is a swelling on the front of the body rather than a separate mass, which
  // is the one thing a beetle's silhouette must state.
  plate(hide, {
    center: [0, dorsal(body, 0.330) - 0.026, 0.332], axis: [0, 0, 1], normal: [0, 1, 0],
    length: 0.185, width: 0.310, rise: 0.058, lip: 0.055, drop: 0.070,
    color: plateCol, ridgeColor: ridgeCol,
  });
  for (const s of [1, -1]) {
    // The pair converges without crossing. An earlier build had them meeting at
    // the midline and the front-on read was a drawn X under the eyes rather than
    // a mouth.
    spike(hide, {
      origin: [s * 0.090, 0.266, 0.600], dir: [-s * 0.10, -0.20, 1],
      length: 0.200, radius: 0.030, waist: 0.42, sides: 4,
      bend: [-s * 0.048, -0.028, 0.010], color: plateCol, tipColor: boneCol,
    });
    // Compound eye, sunk into the side of the cranium and angled forward.
    eye(hide, lens, {
      sphere, lensSphere, at: [s * 0.112, 0.320, 0.504], face: [s * 0.80, 0.16, 0.58],
      radius: 0.052, squash: 0.92, socketColor: darkCol, lensColor: [1, 1, 1],
    });
  }

  // Six legs. Coxa out and up, femur out and down over a knee that clears the
  // back, tibia to a pointed tarsus on the ground.
  const LEG_Z = [0.300, -0.050, -0.420];
  for (let i = 0; i < LEG_Z.length; i++) {
    const z = LEG_Z[i];
    const p = atZ(body, z);
    const hw = p[3] * p[4];
    const splay = 0.05 - i * 0.06;
    for (const s of [1, -1]) {
      sweep(hide, [
        [s * hw * 0.88, 0.348, z, 0.048],
        [s * (hw + 0.130), 0.404, z + splay * 0.5, 0.040],
        [s * (hw + 0.300), 0.232, z + splay * 0.9, 0.030],
        [s * (hw + 0.358), 0.078, z + splay * 1.1, 0.020],
        [s * (hw + 0.330), 0.006, z + splay * 1.3, 0.008],
      ], { samples: 11, radial: 4, tint: tintLeg });
    }
  }

  // Dorsal tergites, front to back, each overlapping the one behind it. Widths
  // are taken from the body's own resampled half-width so a plate can never be
  // wider than the animal under it.
  const PLATE_Z = [0.255, 0.090, -0.085, -0.265, -0.450, -0.640];
  for (let i = 0; i < PLATE_Z.length; i++) {
    const z = PLATE_Z[i];
    const p = atZ(body, z);
    // Width is held near the body's *half*-width, not its full width. A tergite
    // as wide as the animal has its corners buried inside a curved back and only
    // its ridge ever surfaces, which is exactly how the first build measured —
    // six plates on the spine and no visible segmentation at all.
    plate(hide, {
      center: [0, dorsal(body, z) - 0.028, z], axis: [0, 0, 1], normal: [0, 1, 0],
      length: 0.175, width: p[3] * p[4] * 1.42, rise: 0.056 - i * 0.003, lip: 0.050,
      drop: 0.085,
      color: plateCol, ridgeColor: ridgeCol,
    });
    // Lateral spurs along the plate's edge — the woodlouse read, and the thing
    // that keeps the wide flat body from silhouetting as a pebble.
    for (const s of [1, -1]) {
      spike(hide, {
        origin: [s * p[3] * p[4] * 0.94, p[1] + p[3] * 0.30, z],
        dir: [s * 0.92, 0.22, -0.32],
        length: 0.115 + (i === 1 || i === 2 ? 0.040 : 0), radius: 0.026, sides: 3,
        color: plateCol, tipColor: ridgeCol,
      });
    }
  }

  // Shard growth erupting through the plate line. The tallest is what sets the
  // creature's stated height, and it sits over the widest part of the abdomen so
  // the mass and the crest agree.
  const SHARDS = [
    [0, -0.300, 0.420, 0.052, 0.0],
    [0, -0.520, 0.300, 0.042, 0.0],
    [0, -0.080, 0.280, 0.040, 0.0],
    [1, -0.180, 0.215, 0.032, 0.55],
    [-1, -0.400, 0.235, 0.034, 0.55],
    [1, -0.640, 0.165, 0.028, 0.62],
    [-1, 0.060, 0.170, 0.028, 0.62],
  ];
  for (const [s, z, len, rad, lateral] of SHARDS) {
    const p = atZ(body, z);
    spike(glow, {
      origin: [s * p[3] * p[4] * lateral, dorsal(body, z) - 0.020, z],
      dir: [s * lateral * 0.9, 1, -0.52],
      length: len * rng.range(0.94, 1.06), radius: rad, waist: 0.40, sides: 4,
      roll: rng.range(0, 1.5), color: growthCol, tipColor: growthTip,
    });
  }
}

/** id → geometry builder. Kept out of `BESTIARY` so the catalogue stays data. */
const BUILDERS = {
  glassmane: buildGlassmane,
  driftbell: buildDriftbell,
  shardmite: buildShardmite,
};

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build one creature.
 *
 * Nothing is cached between calls: two glassmanes are two independent geometries
 * and two independent materials. That is the honest default for a module that
 * varies its output on an `Rng`, and it is the right cost for a field encounter
 * of three or four. **A caller staging a crowd should build one and
 * `THREE.Mesh.clone()` the result's children**, which shares both the buffers
 * and the programs; the harness cannot afford eight independent builds.
 *
 * @param {string} id a key of {@link BESTIARY}.
 * @param {Object} [opts]
 * @param {import('../core/GameState.js').Rng} [opts.rng] deterministic source.
 *   Defaults to the shared game stream, so a capture reproduces exactly.
 * @param {number} [opts.seed] build from a private `Rng` on this seed instead,
 *   for a creature that must be identical regardless of what drew before it.
 * @param {import('../render/Lighting.js').Lighting} [opts.lighting] the rig.
 *   Supplying it aliases the key/rim uniforms so the creature's rim tracks the
 *   light that casts it, exactly as the cast's does.
 * @param {import('../art/AssetForge.js').AssetForge} [opts.forge] supplies the
 *   normal and roughness maps for hide micro-relief. The base colour map is
 *   deliberately never bound — see the module header.
 * @param {number} [opts.height] override the catalogue height, in metres.
 * @param {boolean} [opts.outline=true] attach the project's inverted-hull ink
 *   line to the hide. The line is derived per fragment from the vertex colour,
 *   so a pale belly and a dark back do not share one flat contour.
 * @returns {{root: THREE.Group, height: number, dispose: () => void}}
 */
export function buildCreature(id, opts = {}) {
  const spec = BESTIARY[id];
  const builder = BUILDERS[id];
  if (!spec || !builder) {
    throw new Error(`[Bestiary] unknown creature "${id}" — known: ${BESTIARY_IDS.join(', ')}`);
  }

  const rng = opts.seed !== undefined ? new Rng(opts.seed) : (opts.rng ?? sharedRng);
  const height = opts.height ?? spec.height;
  const pal = spec.palette;
  const forge = opts.forge ?? null;

  const hide = new MeshBuffer();
  const glow = new MeshBuffer();
  const lens = new MeshBuffer();

  // One shared source for every eye lens and socket on the creature, disposed
  // the moment the buffers are closed: it is a template, not an asset.
  const sphere = new THREE.IcosahedronGeometry(1, 0);
  const lensSphere = new THREE.SphereGeometry(1, 8, 4);
  // The noise stream is seeded off the creature's own draw so two of a species
  // mottle differently, and off nothing else so a capture is reproducible.
  const noise = makeNoise((rng.next() * 0xffffffff) >>> 0 || 1);

  builder(hide, glow, lens, { pal, rng, noise, sphere, lensSphere });
  sphere.dispose();
  lensSphere.dispose();

  const owned = [];
  const track = (r) => {
    owned.push(r);
    return r;
  };

  const root = new THREE.Group();
  root.name = `creature:${id}`;

  // The hide. `leather` is the prop class — it keeps its detail maps and its
  // soft ramp, which is right for an animal and wrong for a costume. `color`
  // stays white because every colour on this mesh is in the vertex attribute;
  // the material must not tint it a second time.
  const hideMat = track(createToonMaterial({
    name: `creature:${id}:hide`,
    preset: 'leather',
    color: 0xffffff,
    vertexColors: true,
    normalMap: forge ? forge.texture('leather/normal', { repeat: 2 }) : null,
    normalScale: new THREE.Vector2(0.85, 0.85),
    roughnessMap: forge ? forge.texture('leather/roughness', { repeat: 2 }) : null,
    /**
     * Well under the preset's defaults, and cut again after the first capture
     * that staged this creature as the frame's subject rather than as a distant
     * mob.
     *
     * Module finding 1 is the target: the plate's subject sits at **0.53 of the
     * ground's median**, and measured on that capture the staged animal came
     * back *lighter* than the meadow it stands on — a pale grey-lavender mass
     * where a dark one belongs, with its authored `#2b2136` back nowhere in the
     * result. The albedo was never the problem. A creature is built almost
     * entirely of swept tubes, and a tube is all grazing angle: exactly the
     * geometry `Flora` records for a blade of grass, where the rim covers the
     * whole surface instead of its contour and the Fresnel term drives the
     * environment specular to its F90 everywhere at once. Three white,
     * albedo-independent terms over a dark hide is how a dark hide stops being
     * dark.
     *
     * So all three come down hard rather than one of them a little: the rim to a
     * quarter of the prop default with a ceiling at 0.09, the Blinn lobe to 0.06
     * (an animal has no polished surface on it — the crystal growth is a
     * separate mesh with its own material), and the environment specular to
     * 0.03. The sky still reaches the shaded side through `envMapIntensity`,
     * which is the term that is multiplied by the albedo and therefore the only
     * one that can lift a flank without bleaching it.
     */
    rimGain: 0.22,
    rimMax: 0.09,
    specGain: 0.06,
    envMapIntensity: 0.22,
    envSpecular: 0.03,
    shadowMix: 0.52,
    lighting: opts.lighting,
  }));

  const hideMesh = new THREE.Mesh(hide.finish(`${id}:hide`), hideMat);
  hideMesh.name = `${id}:hide`;
  hideMesh.frustumCulled = true;
  hideMesh.castShadow = true;
  hideMesh.receiveShadow = true;
  root.add(hideMesh);
  track(hideMesh.geometry);

  // Crystal growth. `emissiveIntensity` sits mid-band of ART_BIBLE §4's 1.2–1.8
  // for an ambient prop glow — bright enough to survive the meadow at 10 m, well
  // under the 2.5–6.0 the same section reserves for a spell core, so a creature
  // never reads as a cast spell.
  let growthMesh = null;
  if (!glow.empty) {
    const growthMat = track(createToonMaterial({
      name: `creature:${id}:growth`,
      preset: 'crystal',
      color: 0xffffff,
      vertexColors: true,
      normalMap: forge ? forge.texture('crystal/normal', { repeat: 2 }) : null,
      normalScale: new THREE.Vector2(0.5, 0.5),
      emissive: pal.emissive,
      emissiveIntensity: 1.45,
      lighting: opts.lighting,
    }));
    growthMesh = new THREE.Mesh(glow.finish(`${id}:growth`), growthMat);
    growthMesh.name = `${id}:growth`;
    growthMesh.castShadow = true;
    root.add(growthMesh);
    track(growthMesh.geometry);
  }

  // The lenses. Unlit and above 1.0 so they are genuine bloom sources: §2.2
  // permits supra-1.0 emissive for magic, and on these creatures the eye is the
  // part that *is* magic. Not a shadow caster — a 4 cm sphere contributes
  // nothing to a shadow map but a draw.
  const eyeMat = track(new THREE.MeshBasicMaterial({
    name: `creature:${id}:eye`,
    color: new THREE.Color(pal.eye).multiplyScalar(2.2),
    toneMapped: true,
    fog: true,
  }));
  const eyeMesh = new THREE.Mesh(lens.finish(`${id}:eye`), eyeMat);
  eyeMesh.name = `${id}:eye`;
  eyeMesh.renderOrder = 3;
  root.add(eyeMesh);
  track(eyeMesh.geometry);

  // One hull, on the hide only. The growth is emissive and already separates
  // itself from the body; giving it a line as well would draw an ink contour
  // around a light source, and it would double the cheapest mesh's cost for it.
  let outlineMat = null;
  let outlineMesh = null;
  if (opts.outline !== false) {
    outlineMat = track(createToonOutlineMaterial({
      name: `creature:${id}:outline`,
      vertexColors: true,
      pixels: 1.9,
    }));
    outlineMesh = createToonOutline(hideMesh, { material: outlineMat });
  }

  // The scale is **solved**, not assumed. Every creature is authored in a space
  // whose intended top is y = 1, but the tallest point is a spline sample or a
  // spike tip and lands a few percent short of it — the quadruped's crest closed
  // at 0.958 and the insectoid's at 0.977, so a bare `setScalar(height)` shipped
  // creatures 4% and 2% under their stated size. Measuring the finished buffers
  // makes `height` a guarantee, which matters because a scene stages a creature
  // against the cast by its height and nothing else.
  const bounds = new THREE.Box3();
  for (const mesh of [hideMesh, growthMesh, eyeMesh]) {
    if (!mesh) continue;
    mesh.geometry.computeBoundingBox();
    bounds.union(mesh.geometry.boundingBox);
  }
  const scale = height / Math.max(1e-3, bounds.max.y);
  root.scale.setScalar(scale);

  root.userData.creature = {
    id,
    spec,
    height,
    /** Ground footprint and the depth the feet deliberately sink, in metres. */
    footprint: {
      width: (bounds.max.x - bounds.min.x) * scale,
      length: (bounds.max.z - bounds.min.z) * scale,
      sink: Math.max(0, -bounds.min.y * scale),
    },
    meshes: { hide: hideMesh, growth: growthMesh, eye: eyeMesh },
    materials: { hide: hideMat, eye: eyeMat },
  };

  let disposed = false;
  return {
    root,
    height,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (outlineMesh) disposeToonOutline(outlineMesh);
      root.removeFromParent();
      for (const r of owned) r.dispose?.();
      owned.length = 0;
    },
  };
}
