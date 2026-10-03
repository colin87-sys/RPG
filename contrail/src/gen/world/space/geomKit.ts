/**
 * Tiny geometry kit shared by the World lane (space debris + structures):
 * a non-indexed triangle builder with flat or explicit normals, UVs in metres
 * and optional per-vertex float attributes, plus a seeded CPU value noise.
 * Pure helpers, no colours.
 */
import * as THREE from 'three';

export type V3 = [number, number, number];

export class GeoBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private extra = new Map<string, number[]>();
  /** current values for extra attributes, applied to every vertex added */
  cur: Record<string, number> = {};

  constructor(extraNames: string[] = []) {
    for (const n of extraNames) {
      this.extra.set(n, []);
      this.cur[n] = 0;
    }
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  private vert(p: V3, n: V3, uv: [number, number]) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(uv[0], uv[1]);
    for (const [k, arr] of this.extra) arr.push(this.cur[k] ?? 0);
  }

  /** Triangle a,b,c counter-clockwise seen from the front. Flat normal unless given. */
  tri(a: V3, b: V3, c: V3, uva: [number, number] = [0, 0], uvb: [number, number] = [0, 0], uvc: [number, number] = [0, 0], na?: V3, nb?: V3, nc?: V3) {
    let fn: V3 | undefined;
    if (!na || !nb || !nc) fn = faceNormal(a, b, c);
    this.vert(a, na ?? fn!, uva);
    this.vert(b, nb ?? fn!, uvb);
    this.vert(c, nc ?? fn!, uvc);
  }

  /** Quad a,b,c,d counter-clockwise. */
  quad(a: V3, b: V3, c: V3, d: V3, uva: [number, number] = [0, 0], uvb: [number, number] = [0, 0], uvc: [number, number] = [0, 0], uvd: [number, number] = [0, 0], na?: V3, nb?: V3, nc?: V3, nd?: V3) {
    this.tri(a, b, c, uva, uvb, uvc, na, nb, nc);
    this.tri(a, c, d, uva, uvc, uvd, na, nc, nd);
  }

  /** Axis-aligned-in-a-frame box: centre c, half sizes h, frame axes (ax, ay, az). Faces with UVs in metres. */
  box(c: V3, h: V3, ax: V3 = [1, 0, 0], ay: V3 = [0, 1, 0], az: V3 = [0, 0, 1], skipBack = false) {
    const P = (sx: number, sy: number, sz: number): V3 => [
      c[0] + ax[0] * h[0] * sx + ay[0] * h[1] * sy + az[0] * h[2] * sz,
      c[1] + ax[1] * h[0] * sx + ay[1] * h[1] * sy + az[1] * h[2] * sz,
      c[2] + ax[2] * h[0] * sx + ay[2] * h[1] * sy + az[2] * h[2] * sz,
    ];
    const W = h[0] * 2, H = h[1] * 2, D = h[2] * 2;
    // +x
    this.quad(P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), [0, 0], [D, 0], [D, H], [0, H]);
    // -x
    if (!skipBack) this.quad(P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), [0, 0], [D, 0], [D, H], [0, H]);
    // +y
    this.quad(P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1), [0, 0], [W, 0], [W, D], [0, D]);
    // -y
    this.quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), [0, 0], [W, 0], [W, D], [0, D]);
    // +z
    this.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), [0, 0], [W, 0], [W, H], [0, H]);
    // -z
    this.quad(P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), [0, 0], [W, 0], [W, H], [0, H]);
  }

  /** Append another builder's triangles transformed by a matrix. */
  append(other: GeoBuilder, m?: THREE.Matrix4) {
    const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    const v = new THREE.Vector3();
    for (let i = 0; i < other.pos.length; i += 3) {
      v.set(other.pos[i], other.pos[i + 1], other.pos[i + 2]);
      if (m) v.applyMatrix4(m);
      this.pos.push(v.x, v.y, v.z);
      v.set(other.nrm[i], other.nrm[i + 1], other.nrm[i + 2]);
      if (nm) v.applyMatrix3(nm).normalize();
      this.nrm.push(v.x, v.y, v.z);
    }
    this.uv.push(...other.uv);
    for (const [k, arr] of this.extra) {
      const src = other.extra.get(k);
      if (src) for (const x of src) arr.push(x);
      else for (let i = 0; i < other.pos.length / 3; i++) arr.push(0);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const [k, arr] of this.extra) g.setAttribute(k, new THREE.Float32BufferAttribute(arr, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export function faceNormal(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Seeded 3D value noise in [0,1] (CPU side, build time only). */
export function makeValueNoise3(seed: number) {
  const h = (x: number, y: number, z: number) => {
    let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647) + Math.imul(seed, 1274126177)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  };
  const s = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number, z: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = s(x - xi), fy = s(y - yi), fz = s(z - zi);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(h(xi, yi, zi), h(xi + 1, yi, zi), fx), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), fx), fy),
      l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), fx), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), fx), fy),
      fz,
    );
  };
}

/** Triangle count of a (non-)indexed geometry. */
export function triCount(g: THREE.BufferGeometry): number {
  return g.index ? g.index.count / 3 : g.attributes.position.count / 3;
}
