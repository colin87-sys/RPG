/**
 * Debris shape generators (unit scale, instanced later):
 * - asteroids: displaced icosahedra with planar cleaves (faceted, flat normals)
 * - wreck slabs: bent hull plate with frames, broken I-beam truss, curved broken rib
 * - fleck: a folded two-triangle shard
 * UVs are in local units (panel seams are drawn by the shader).
 */
import * as THREE from 'three';
import { Rng } from '../../../core/rng';
import { GeoBuilder, makeValueNoise3, type V3 } from './geomKit';

export interface AsteroidShape {
  detail: number;
  noiseAmp: number;
  noiseFreq: number;
  cuts: number;
  cutDepth: [number, number];
  stretch: V3;
}

export const ASTEROID_SHAPES: AsteroidShape[] = [
  { detail: 2, noiseAmp: 0.32, noiseFreq: 1.6, cuts: 2, cutDepth: [0.62, 0.8], stretch: [1.15, 0.9, 1.0] }, // lumpy boulder
  { detail: 2, noiseAmp: 0.14, noiseFreq: 2.4, cuts: 6, cutDepth: [0.45, 0.72], stretch: [1.0, 0.85, 1.2] }, // cleaved chunk
  { detail: 1, noiseAmp: 0.22, noiseFreq: 1.9, cuts: 3, cutDepth: [0.4, 0.65], stretch: [1.7, 0.7, 0.8] }, // shard rock
];

export function asteroidGeometry(shape: AsteroidShape, seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const noise = makeValueNoise3(seed);
  const g = new THREE.IcosahedronGeometry(1, shape.detail);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const cuts: { n: THREE.Vector3; d: number }[] = [];
  for (let i = 0; i < shape.cuts; i++) {
    const n = new THREE.Vector3(rng.signed(), rng.signed(), rng.signed()).normalize();
    cuts.push({ n, d: rng.range(shape.cutDepth[0], shape.cutDepth[1]) });
  }
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // quantise so shared corners displace identically (no cracks)
    const qx = Math.round(v.x * 1e4) / 1e4, qy = Math.round(v.y * 1e4) / 1e4, qz = Math.round(v.z * 1e4) / 1e4;
    const f = shape.noiseFreq;
    const r = 1 + shape.noiseAmp * ((noise(qx * f + 5, qy * f, qz * f) - 0.5) * 2 + 0.5 * (noise(qx * f * 2.3, qy * f * 2.3 + 9, qz * f * 2.3) - 0.5));
    v.set(qx, qy, qz).multiplyScalar(r);
    for (const c of cuts) {
      const s = v.dot(c.n) - c.d;
      if (s > 0) v.addScaledVector(c.n, -s);
    }
    v.set(v.x * shape.stretch[0], v.y * shape.stretch[1], v.z * shape.stretch[2]);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals(); // non-indexed -> flat facets
  g.computeBoundingSphere();
  return g;
}

/** Bent hull plate with a jagged broken outline, thickness and two inner frames. */
export function plateGeometry(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const gb = new GeoBuilder();
  const N = 14;
  const outline: THREE.Vector2[] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    let r = 1 + rng.signed() * 0.12;
    if (rng.chance(0.28)) r *= 0.62; // broken notch
    outline.push(new THREE.Vector2(Math.cos(a) * 0.6 * r, Math.sin(a) * 0.38 * r));
  }
  const bend = 0.22; // hull curvature
  const t = 0.035;
  const Y = (x: number) => -bend * x * x;
  const tris = THREE.ShapeUtils.triangulateShape(outline, []);
  const P = (p: THREE.Vector2, off: number): V3 => [p.x, Y(p.x) + off, p.y];
  const U = (p: THREE.Vector2): [number, number] => [p.x, p.y];
  for (const [a, b, c] of tris) {
    // top (+y) and bottom
    gb.tri(P(outline[a], t), P(outline[c], t), P(outline[b], t), U(outline[a]), U(outline[c]), U(outline[b]));
    gb.tri(P(outline[a], -t), P(outline[b], -t), P(outline[c], -t), U(outline[a]), U(outline[b]), U(outline[c]));
  }
  // orient top faces: make sure top normals point +y (check first)
  for (let i = 0; i < N; i++) {
    const a = outline[i], b = outline[(i + 1) % N];
    const l = a.distanceTo(b);
    gb.quad(P(a, -t), P(b, -t), P(b, t), P(a, t), [0, 0], [l, 0], [l, 2 * t], [0, 2 * t]);
  }
  // frames on the underside (hull ribs), one broken short
  for (let k = 0; k < 2; k++) {
    const x = -0.25 + k * 0.5 + rng.signed() * 0.05;
    const len = k === 1 ? 0.22 + rng.next() * 0.1 : 0.34;
    gb.box([x, Y(x) - t - 0.045, (k === 1 ? -0.05 : 0)], [0.022, 0.045, len], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  }
  // stringer across
  gb.box([0.05, Y(0.05) - t - 0.03, 0.12], [0.42, 0.03, 0.018]);
  return fixWinding(gb.build());
}

/** Broken I-beam with a snapped cross member and gusset. Length along x ~1. */
export function beamGeometry(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const gb = new GeoBuilder();
  const ibeam = (x0: number, x1: number, h: number, w: number, tf: number, tw: number, m: THREE.Matrix4 | null, jag: number) => {
    const b = new GeoBuilder();
    const j0 = () => x0 + rng.signed() * jag;
    const j1 = () => x1 + rng.signed() * jag;
    // flanges and web as boxes with jagged ends approximated by per-part end offsets
    const fa = j0(), fb = j1();
    b.box([(fa + fb) / 2, h / 2 - tf / 2, 0], [(fb - fa) / 2, tf / 2, w / 2]);
    const ga = j0(), gbx = j1();
    b.box([(ga + gbx) / 2, -h / 2 + tf / 2, 0], [(gbx - ga) / 2, tf / 2, w / 2]);
    const wa = j0(), wb = j1();
    b.box([(wa + wb) / 2, 0, 0], [(wb - wa) / 2, h / 2 - tf, tw / 2]);
    gb.append(b, m ?? undefined);
  };
  ibeam(-0.5, 0.5, 0.11, 0.08, 0.018, 0.014, null, 0.05);
  // snapped cross member at an angle
  const m = new THREE.Matrix4().makeRotationY(rng.range(0.7, 1.1)).setPosition(rng.range(-0.25, 0.2), 0, 0.02);
  const m2 = new THREE.Matrix4().makeRotationZ(rng.range(-0.3, 0.3));
  m.multiply(m2);
  ibeam(0.0, 0.42, 0.08, 0.06, 0.014, 0.012, m, 0.04);
  // gusset plate
  gb.box([0.02, 0, 0.06], [0.08, 0.045, 0.006]);
  return fixWinding(gb.build());
}

/** Curved hull rib (frame) with torn plating remnants. */
export function ribGeometry(seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const gb = new GeoBuilder();
  const R = 0.62, depth = 0.08, halfW = 0.035;
  const a0 = -0.9, a1 = 0.95;
  const S = 12;
  const pt = (a: number, r: number, z: number): V3 => [Math.cos(a) * r, Math.sin(a) * r, z];
  for (let i = 0; i < S; i++) {
    const a = a0 + ((a1 - a0) * i) / S, b = a0 + ((a1 - a0) * (i + 1)) / S;
    const ri = R - depth, ro = R;
    const la = R * (b - a);
    const u0 = R * (a - a0), u1 = u0 + la;
    // outer, inner, two sides
    gb.quad(pt(a, ro, -halfW), pt(b, ro, -halfW), pt(b, ro, halfW), pt(a, ro, halfW), [u0, 0], [u1, 0], [u1, 0.07], [u0, 0.07]);
    gb.quad(pt(a, ri, halfW), pt(b, ri, halfW), pt(b, ri, -halfW), pt(a, ri, -halfW), [u0, 0], [u1, 0], [u1, 0.07], [u0, 0.07]);
    gb.quad(pt(a, ri, halfW), pt(a, ro, halfW), pt(b, ro, halfW), pt(b, ri, halfW), [u0, 0], [u0, 0.08], [u1, 0.08], [u1, 0]);
    gb.quad(pt(b, ri, -halfW), pt(b, ro, -halfW), pt(a, ro, -halfW), pt(a, ri, -halfW), [u1, 0], [u1, 0.08], [u0, 0.08], [u0, 0]);
    // torn plating remnant on some segments
    if (i > 1 && i < S - 2 && rng.chance(0.55)) {
      const zw = 0.08 + rng.next() * 0.18;
      const side = rng.chance(0.5) ? 1 : -1;
      const z0 = side * halfW, z1 = side * (halfW + zw);
      const r = R + 0.004;
      const q = [pt(a, r, z0), pt(b, r, z0), pt(b, r, z1 * (0.6 + rng.next() * 0.4)), pt(a, r, z1)];
      if (side > 0) gb.quad(q[0], q[1], q[2], q[3], [u0, 0], [u1, 0], [u1, zw], [u0, zw]);
      else gb.quad(q[3], q[2], q[1], q[0], [u0, zw], [u1, zw], [u1, 0], [u0, 0]);
      const r2 = R - 0.012;
      const qi = [pt(a, r2, z0), pt(b, r2, z0), pt(b, r2, z1 * 0.8), pt(a, r2, z1)];
      if (side > 0) gb.quad(qi[3], qi[2], qi[1], qi[0]);
      else gb.quad(qi[0], qi[1], qi[2], qi[3]);
    }
  }
  // end caps
  for (const a of [a0, a1]) {
    const q = [pt(a, R - depth, -halfW), pt(a, R, -halfW), pt(a, R, halfW), pt(a, R - depth, halfW)];
    gb.quad(q[0], q[1], q[2], q[3]);
  }
  const g = fixWinding(gb.build());
  g.translate(-R * 0.75, 0, 0);
  return g;
}

/** Folded two-triangle shard (double sided in the shader). */
export function fleckGeometry(): THREE.BufferGeometry {
  const gb = new GeoBuilder();
  const a: V3 = [-0.5, 0, -0.25], b: V3 = [0.08, 0.07, -0.5], c: V3 = [0.5, 0, 0.3], d: V3 = [-0.12, -0.06, 0.5];
  gb.tri(a, c, b, [0, 0], [1, 1], [1, 0]);
  gb.tri(a, d, c, [0, 0], [0, 1], [1, 1]);
  return gb.build();
}

/**
 * Make flat normals point away from the shape's centroid for closed-ish meshes
 * (flips triangle winding + normal when needed). Keeps authoring simple.
 */
export function fixWinding(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // per-part centroid is unknown; use local box centres per triangle neighbourhood is overkill:
  // test each face against the centroid of its own 64 nearest-in-order vertices (parts are appended contiguously).
  const n = pos.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3(), mid = new THREE.Vector3(), cen = new THREE.Vector3();
  const block = 36; // a box is 36 vertices; other parts are handled by the global centroid
  const globalC = new THREE.Vector3();
  for (let i = 0; i < n; i++) globalC.add(a.fromBufferAttribute(pos, i));
  globalC.multiplyScalar(1 / n);
  for (let t = 0; t < n; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    fn.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a)).normalize();
    // local centroid of the containing block
    const s = Math.floor(t / block) * block;
    const e = Math.min(n, s + block);
    cen.set(0, 0, 0);
    for (let k = s; k < e; k++) cen.add(e1.fromBufferAttribute(pos, k));
    cen.multiplyScalar(1 / (e - s));
    mid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    const out = mid.clone().sub(cen);
    if (out.lengthSq() < 1e-10) out.copy(mid).sub(globalC);
    if (fn.dot(out) < 0) {
      // swap b and c
      const bx = b.clone();
      pos.setXYZ(t + 1, c.x, c.y, c.z);
      pos.setXYZ(t + 2, bx.x, bx.y, bx.z);
      const u1 = uv.getX(t + 1), v1 = uv.getY(t + 1);
      uv.setXY(t + 1, uv.getX(t + 2), uv.getY(t + 2));
      uv.setXY(t + 2, u1, v1);
      fn.negate();
    }
    for (let k = 0; k < 3; k++) nrm.setXYZ(t + k, fn.x, fn.y, fn.z);
  }
  g.computeBoundingSphere();
  return g;
}
