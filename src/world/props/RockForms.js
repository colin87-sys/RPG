/**
 * RockForms — angular rock geometry, measured off `docs/reference/bravely01.jpg`.
 *
 * ## What the plate actually shows
 *
 * The boulder wall behind the party (source box x 430–1000, y 30–300) is not a
 * set of eroded lumps. It is **cleaved slate**: every rock is a wedge bounded by
 * two or three large planar faces that meet along a single straight arête, and
 * the arêtes run diagonally across the frame at roughly 25–35°. There is no
 * rounding anywhere on the silhouette — where two faces meet, the edge is one
 * pixel wide.
 *
 * The colour break across that edge is the strongest value contrast in the whole
 * plate and it is **not** just lighting:
 *
 *   - up-facing facets   p50 sRGB #898b9d, p90 #b7c8d7 — a pale, slightly warm grey
 *   - vertical faces     p50 sRGB #123256, p10 #06203c — a deep, saturated blue
 *
 * A linear ratio of about 0.11 between them. Part is the key light, but the two
 * families also differ in *hue* in a way a single albedo under one light cannot
 * produce — weathered exposure on the up-faces against fresh cleaved stone on the
 * verticals. So the split is baked into vertex colour here and the shading model
 * only has to supply the rest. This is the one thing that makes procedurally
 * generated rock stop reading as grey putty.
 *
 * ## Method
 *
 * A convex hull over a *small* set of points. Few points is the whole trick: a
 * hull over 200 samples is a sphere, a hull over 13 is a crystal with facets big
 * enough to read at 30 m. Two further operations shape it toward the plate:
 *
 *  1. **Ridge pull** — points on the upper hemisphere are lifted in proportion to
 *     how well they align with one random horizontal axis, which turns the blob
 *     into a wedge with a definite arête instead of a lumpy dome.
 *  2. **Cleave planes** — points beyond a random plane are *projected onto* it
 *     rather than clipped away, so several hull vertices become exactly coplanar
 *     and the hull grows one genuinely flat, large face. This is what a split
 *     block looks like and no amount of noise produces it.
 *
 * Procedural surface noise is legal here — these are props, not characters — so
 * the geometry carries box-projected UVs for a caller that wants to bind
 * `AssetForge`'s `stone` normal/roughness maps on top.
 *
 * OWNED BY: world/props/RockForms.js.
 */
import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';

/**
 * Measured facet colours, as sRGB hex.
 *
 * `UP` is the p50 of the plate's up-facing facets pulled a little brighter,
 * because it is an *albedo* and the measurement is already lit; `SIDE` is the
 * p50 of the vertical faces pulled the other way for the same reason.
 */
export const ROCK_FACETS = Object.freeze({
  UP: 0xb4bcc6,
  SIDE: 0x55617e,
  /** The deepest recesses between stacked blocks — plate p10 #06203c. */
  CREVICE: 0x2a3854,
});

/** Where the up-face/side-face blend crosses over, in world-space `normal.y`. */
const FACET_KNEE = 0.34;

/**
 * One angular boulder.
 *
 * @param {Object} opts
 * @param {import('../../core/GameState.js').Rng} opts.rng deterministic source.
 * @param {number} [opts.size=1] longest horizontal dimension, in metres.
 * @param {number} [opts.height=0.78] height as a fraction of `size`. The plate's
 *   blocks are wider than they are tall by roughly 4:3.
 * @param {number} [opts.seedPoints=13] hull sample count. Raising this rounds the
 *   rock off; below about 9 the hull starts producing slivers.
 * @param {number} [opts.ridge=0.42] strength of the arête pull, 0 disables it.
 * @param {number} [opts.cleaves=2] number of flat split faces to force.
 * @param {number} [opts.sink=0.12] fraction of the height buried below y=0, so
 *   the rock meets the ground instead of resting on it.
 * @param {number} [opts.uvScale=0.5] world metres per UV unit for the box
 *   projection.
 * @param {number} [opts.valueJitter=0.06] per-facet lightness variation.
 * @returns {THREE.BufferGeometry} non-indexed, flat-normalled, with `position`,
 *   `normal`, `uv` and `color`. The caller owns it and must `dispose()` it.
 */
export function createAngularRockGeometry(opts) {
  const {
    rng,
    size = 1,
    height = 0.78,
    seedPoints = 13,
    ridge = 0.42,
    cleaves = 2,
    sink = 0.12,
    uvScale = 0.5,
    valueJitter = 0.06,
  } = opts;

  const half = size * 0.5;
  // Anisotropy per rock rather than per project: the plate's blocks are all
  // clearly the same material but no two share a proportion.
  const ax = half * rng.range(0.82, 1.0);
  const az = half * rng.range(0.72, 1.0);
  const ay = size * height * 0.5;

  // A random horizontal axis for the arête. Everything the ridge pull does is
  // measured against this one direction, which is why the result reads as a
  // deliberate split rather than as bumps.
  const ridgeAngle = rng.range(0, Math.PI * 2);
  const ridgeX = Math.cos(ridgeAngle);
  const ridgeZ = Math.sin(ridgeAngle);

  const points = [];
  for (let i = 0; i < seedPoints; i++) {
    // Stratified in cos(theta) so the samples do not clump at the poles, which
    // on a 13-point hull would leave one enormous facet across the equator.
    const u = (i + rng.next()) / seedPoints;
    const cosT = 1 - 2 * u;
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
    const phi = rng.range(0, Math.PI * 2);
    let dx = sinT * Math.cos(phi);
    let dy = cosT;
    let dz = sinT * Math.sin(phi);

    // Radius jitter is what makes the facets uneven; without it the hull is a
    // regular polyhedron and reads as a die.
    const r = rng.range(0.74, 1.0);
    let x = dx * ax * r;
    let y = dy * ay * r;
    let z = dz * az * r;

    if (ridge > 0 && y > 0) {
      // Lift by alignment with the ridge axis, weighted by how high the point
      // already is. The result is a roof: two large slopes meeting on a line.
      const along = Math.abs(dx * ridgeX + dz * ridgeZ);
      y += ay * ridge * along * (y / ay);
    }
    points.push(new THREE.Vector3(x, y, z));
  }

  for (let c = 0; c < cleaves; c++) {
    // A plane through a point offset from centre, tilted off vertical. Points on
    // the far side are pushed *onto* it, so they become exactly coplanar and the
    // hull gains one large flat face — a split block, not a shaved one.
    const a = rng.range(0, Math.PI * 2);
    const tilt = rng.range(-0.55, 0.55);
    const n = new THREE.Vector3(Math.cos(a), tilt, Math.sin(a)).normalize();
    const d = rng.range(0.30, 0.62) * Math.max(ax, az);
    for (const p of points) {
      const dist = p.dot(n) - d;
      if (dist > 0) p.addScaledVector(n, -dist);
    }
  }

  const geo = new ConvexGeometry(points);

  // ConvexGeometry emits per-face vertices with the face normal already on each
  // one, so the facets are flat without `flatShading` and the colour split below
  // can be written per triangle. It supplies no UVs, hence the box projection.
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const count = pos.count;

  // Drop to the ground plane, then sink. Done on the finished hull rather than
  // on the point cloud because the hull's extent is not the cloud's.
  geo.computeBoundingBox();
  const minY = geo.boundingBox.min.y;
  const lift = -minY - size * height * sink;
  for (let i = 0; i < count; i++) pos.setY(i, pos.getY(i) + lift);
  pos.needsUpdate = true;

  const uv = new Float32Array(count * 2);
  const col = new Float32Array(count * 3);
  const up = new THREE.Color().setHex(ROCK_FACETS.UP, THREE.SRGBColorSpace);
  const side = new THREE.Color().setHex(ROCK_FACETS.SIDE, THREE.SRGBColorSpace);
  const crevice = new THREE.Color().setHex(ROCK_FACETS.CREVICE, THREE.SRGBColorSpace);
  const facet = new THREE.Color();

  for (let t = 0; t < count; t += 3) {
    const nx = nrm.getX(t);
    const ny = nrm.getY(t);
    const nz = nrm.getZ(t);

    // The measured split. `smoothstep` rather than a step because a few of the
    // plate's facets are half-turned and sit between the two families; a hard
    // cut there would read as the cel banding the client rejected.
    const upness = smoothstep(FACET_KNEE - 0.30, FACET_KNEE + 0.42, ny);
    facet.copy(side).lerp(up, upness);
    // Undersides go to the crevice value: on the plate the gaps between stacked
    // blocks are near black, and an ambient term alone never gets there.
    if (ny < -0.2) facet.lerp(crevice, Math.min(1, (-ny - 0.2) * 1.4));

    // Per-facet lightness variation — legal on a prop, and the thing that stops
    // a cluster of hulls looking like one extruded material.
    const v = 1 + (rng.next() * 2 - 1) * valueJitter;

    // Box projection off the dominant axis, so a stone normal map lands without
    // shearing on any face.
    const axis = Math.abs(nx) > Math.abs(ny)
      ? (Math.abs(nx) > Math.abs(nz) ? 0 : 2)
      : (Math.abs(ny) > Math.abs(nz) ? 1 : 2);

    for (let k = 0; k < 3; k++) {
      const i = t + k;
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);
      const u2 = axis === 0 ? pz : px;
      const v2 = axis === 1 ? pz : py;
      uv[i * 2] = u2 / uvScale;
      uv[i * 2 + 1] = v2 / uvScale;
      col[i * 3] = facet.r * v;
      col[i * 3 + 1] = facet.g * v;
      col[i * 3 + 2] = facet.b * v;
    }
  }

  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * A flat chip of stone lying on the ground.
 *
 * The plate scatters these across the lawn in front of the boulder wall — pale
 * grey slivers about a boot long, always flatter than they are wide. They cost
 * almost nothing and they are what stops a mown lawn reading as a golf green.
 *
 * @param {Object} opts see {@link createAngularRockGeometry}; `size` is the
 *   chip's length in metres.
 * @returns {THREE.BufferGeometry}
 */
export function createStoneChipGeometry(opts) {
  return createAngularRockGeometry({
    ...opts,
    height: opts.height ?? 0.26,
    seedPoints: opts.seedPoints ?? 9,
    ridge: opts.ridge ?? 0.10,
    cleaves: opts.cleaves ?? 1,
    sink: opts.sink ?? 0.35,
    uvScale: opts.uvScale ?? 0.18,
  });
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
