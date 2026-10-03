/**
 * Enemy geometry kit: a tiny faceted mesh builder shared by every WARDEN enemy.
 * Flat-shaded (non-indexed) triangles with per-vertex material data:
 *   aAlbedo (vec3, linear), aEmit (vec4: rgb = emissive linear * strength,
 *   a = channel + phase fraction), aBone (float, rigid bone index), uv.
 * Colours come only from tokens (hex strings) converted once per material spec.
 */
import * as THREE from 'three';

/** Emissive channels understood by the enemy material (see material.ts). */
export const CH = {
  none: 0,
  marker: 1, // small red marker lights (gentle pulse)
  thruster: 2, // engine glow (flicker)
  charge: 3, // sniper lens (driven by charge)
  sequence: 4, // lights in order as uSeq passes the phase fraction
  weak: 5, // weak point core
  vent: 6, // boss vents (travelling wave)
  eye: 7, // sensor eyes (steady)
} as const;

export interface MatSpec {
  albedo: string; // token hex
  emit?: string; // token hex
  emitStrength?: number;
  channel?: number;
  phase?: number; // 0..0.999, stored as channel fraction
}

interface ResolvedMat {
  a: [number, number, number];
  e: [number, number, number, number];
}

const matCache = new WeakMap<MatSpec, ResolvedMat>();
function resolve(m: MatSpec): ResolvedMat {
  let r = matCache.get(m);
  if (r) return r;
  const c = new THREE.Color(m.albedo);
  const e = m.emit ? new THREE.Color(m.emit) : new THREE.Color(0, 0, 0);
  const s = m.emitStrength ?? 1;
  const ch = (m.channel ?? (m.emit ? CH.marker : CH.none)) + Math.min(0.999, Math.max(0, m.phase ?? 0));
  r = { a: [c.r, c.g, c.b], e: [e.r * s, e.g * s, e.b * s, ch] };
  matCache.set(m, r);
  return r;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _n = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();

export type V = [number, number, number];

export class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uvs: number[] = [];
  alb: number[] = [];
  emi: number[] = [];
  bon: number[] = [];
  bone = 0;
  private m = new THREE.Matrix4();
  private stack: THREE.Matrix4[] = [];
  private flip = false;

  get triangles(): number {
    return this.pos.length / 9;
  }

  /** Push a transform (composed with the current one). */
  push(t: THREE.Matrix4): this {
    this.stack.push(this.m.clone());
    this.m.multiply(t);
    this.flip = this.m.determinant() < 0;
    return this;
  }
  pop(): this {
    this.m.copy(this.stack.pop()!);
    this.flip = this.m.determinant() < 0;
    return this;
  }
  /** Run fn twice: as authored and mirrored in X. */
  mirrorX(fn: (side: 1 | -1) => void): void {
    fn(1);
    this.push(new THREE.Matrix4().makeScale(-1, 1, 1));
    fn(-1);
    this.pop();
  }
  at(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s: number | V = 1): THREE.Matrix4 {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
    const sc = typeof s === 'number' ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s);
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, sc);
  }

  /** One triangle (counter-clockwise = front). Optional smooth normals (object space, pre-transform). */
  tri(a: V, b: V, c: V, mat: MatSpec, uv?: [number, number, number, number, number, number], normals?: [V, V, V]): void {
    const r = resolve(mat);
    let pa = _a.set(...a).applyMatrix4(this.m);
    let pb = _b.set(...b).applyMatrix4(this.m);
    let pc = _c.set(...c).applyMatrix4(this.m);
    let ns = normals;
    let uu = uv ?? [0, 0, 1, 0, 0, 1];
    if (this.flip) {
      const t = pb; pb = pc; pc = t;
      if (ns) ns = [ns[0], ns[2], ns[1]];
      uu = [uu[0], uu[1], uu[4], uu[5], uu[2], uu[3]];
    }
    _e1.subVectors(pb, pa);
    _e2.subVectors(pc, pa);
    _n.crossVectors(_e1, _e2);
    if (_n.lengthSq() < 1e-14) return; // degenerate
    _n.normalize();
    const nm = new THREE.Matrix3().getNormalMatrix(this.m);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? pa : k === 1 ? pb : pc;
      this.pos.push(p.x, p.y, p.z);
      if (ns) {
        const v = new THREE.Vector3(...ns[k]).applyMatrix3(nm).normalize();
        this.nrm.push(v.x, v.y, v.z);
      } else this.nrm.push(_n.x, _n.y, _n.z);
      this.alb.push(r.a[0], r.a[1], r.a[2]);
      this.emi.push(r.e[0], r.e[1], r.e[2], r.e[3]);
      this.bon.push(this.bone);
    }
    this.uvs.push(...uu);
  }

  quad(a: V, b: V, c: V, d: V, mat: MatSpec): void {
    this.tri(a, b, c, mat, [0, 0, 1, 0, 1, 1]);
    this.tri(a, c, d, mat, [0, 0, 1, 1, 0, 1]);
  }

  /** Convex polygon fan (CCW). */
  poly(pts: V[], mat: MatSpec): void {
    for (let i = 1; i < pts.length - 1; i++) this.tri(pts[0], pts[i], pts[i + 1], mat);
  }

  /**
   * Loft between rings of equal length. Rings should wind CCW when viewed from
   * the END of the loft looking back toward the start (outward normals).
   */
  loft(rings: V[][], mat: MatSpec | ((ring: number, seg: number) => MatSpec), capStart?: MatSpec, capEnd?: MatSpec): void {
    const n = rings[0].length;
    for (let r = 0; r < rings.length - 1; r++) {
      const A = rings[r], B = rings[r + 1];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const m = typeof mat === 'function' ? mat(r, i) : mat;
        this.quad(A[i], A[j], B[j], B[i], m);
      }
    }
    if (capStart) this.poly([...rings[0]].reverse(), capStart);
    if (capEnd) this.poly(rings[rings.length - 1], capEnd);
  }

  /** Axis-aligned box with optional chamfer (fraction of the smallest half-size). */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, mat: MatSpec, chamfer = 0, side?: MatSpec): void {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    if (chamfer <= 0) {
      const p = (x: number, y: number, z: number): V => [cx + x * hx, cy + y * hy, cz + z * hz];
      const S = side ?? mat;
      this.quad(p(-1, 1, -1), p(-1, 1, 1), p(1, 1, 1), p(1, 1, -1), mat); // top
      this.quad(p(-1, -1, -1), p(1, -1, -1), p(1, -1, 1), p(-1, -1, 1), S); // bottom
      this.quad(p(-1, -1, 1), p(1, -1, 1), p(1, 1, 1), p(-1, 1, 1), S); // +z
      this.quad(p(1, -1, -1), p(-1, -1, -1), p(-1, 1, -1), p(1, 1, -1), S); // -z
      this.quad(p(1, -1, 1), p(1, -1, -1), p(1, 1, -1), p(1, 1, 1), S); // +x
      this.quad(p(-1, -1, -1), p(-1, -1, 1), p(-1, 1, 1), p(-1, 1, -1), S); // -x
      return;
    }
    // chamfered: octagonal profile in XY extruded along Z, with bevelled ends
    const c = Math.min(hx, hy, hz) * chamfer;
    const ring = (z: number, inset: number): V[] => {
      const ax = hx - inset, ay = hy - inset, cc = Math.max(0.0001, c - inset * 0.0);
      return [
        [cx - ax + cc, cy - ay, cz + z], [cx + ax - cc, cy - ay, cz + z], [cx + ax, cy - ay + cc, cz + z], [cx + ax, cy + ay - cc, cz + z],
        [cx + ax - cc, cy + ay, cz + z], [cx - ax + cc, cy + ay, cz + z], [cx - ax, cy + ay - cc, cz + z], [cx - ax, cy - ay + cc, cz + z],
      ];
    };
    const r0 = ring(-hz, c), r1 = ring(-hz + c, 0), r2 = ring(hz - c, 0), r3 = ring(hz, c);
    const S = side ?? mat;
    this.loft([r0, r1, r2, r3], (r, s) => (s === 4 ? mat : S), S, S);
  }

  /** Cylinder / cone along +Y from y0 to y1 (n sides), optional caps. */
  cylinder(n: number, r0: number, r1: number, y0: number, y1: number, mat: MatSpec, capBottom?: MatSpec, capTop?: MatSpec, rot = 0): void {
    const ring = (r: number, y: number): V[] => {
      const out: V[] = [];
      for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * Math.PI * 2;
        out.push([Math.cos(a) * r, y, -Math.sin(a) * r]);
      }
      return out;
    };
    // loft rings must wind CCW seen from the end (+Y looking down -Y): use reversed order
    const A = ring(r0, y0), B = ring(r1, y1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (r1 < 1e-6) this.tri(A[i], A[j], B[i], mat);
      else if (r0 < 1e-6) this.tri(A[i], B[j], B[i], mat);
      else this.quad(A[i], A[j], B[j], B[i], mat);
    }
    if (capBottom && r0 > 1e-6) this.poly([...A].reverse(), capBottom);
    if (capTop && r1 > 1e-6) this.poly(B, capTop);
  }

  /** Smooth UV sphere (ellipsoid radii rx, ry, rz) centred at c. */
  sphere(c: V, rx: number, ry: number, rz: number, ws: number, hs: number, mat: MatSpec): void {
    const P = (i: number, j: number): [V, V] => {
      const th = (i / ws) * Math.PI * 2, ph = (j / hs) * Math.PI;
      const nx = Math.sin(ph) * Math.cos(th), ny = Math.cos(ph), nz = -Math.sin(ph) * Math.sin(th);
      return [[c[0] + nx * rx, c[1] + ny * ry, c[2] + nz * rz], [nx / rx, ny / ry, nz / rz]];
    };
    for (let j = 0; j < hs; j++)
      for (let i = 0; i < ws; i++) {
        const [a, na] = P(i, j), [b, nb] = P(i, j + 1), [cc, nc] = P(i + 1, j + 1), [d, nd] = P(i + 1, j);
        if (j > 0) this.tri(a, b, d, mat, undefined, [na, nb, nd]);
        if (j < hs - 1) this.tri(b, cc, d, mat, undefined, [nb, nc, nd]);
      }
  }

  /** Emissive quad facing +normal: centre c, axes u (half width) and v (half height). */
  panel(c: V, u: V, v: V, mat: MatSpec): void {
    const p = (a: number, b: number): V => [c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b, c[2] + u[2] * a + v[2] * b];
    this.quad(p(-1, -1), p(1, -1), p(1, 1), p(-1, 1), mat);
  }

  build(withBones = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('aAlbedo', new THREE.Float32BufferAttribute(this.alb, 3));
    g.setAttribute('aEmit', new THREE.Float32BufferAttribute(this.emi, 4));
    if (withBones) g.setAttribute('aBone', new THREE.Float32BufferAttribute(this.bon, 1));
    g.setAttribute('aOutlineN', new THREE.Float32BufferAttribute(smoothNormals(this.pos, this.nrm), 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** Position-welded averaged normals (for the inverted-hull outline, no gaps at hard edges). */
function smoothNormals(pos: number[], nrm: number[]): number[] {
  const key = (i: number) => `${Math.round(pos[i] * 1000)},${Math.round(pos[i + 1] * 1000)},${Math.round(pos[i + 2] * 1000)}`;
  const acc = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.length; i += 3) {
    const k = key(i);
    const a = acc.get(k) ?? [0, 0, 0];
    a[0] += nrm[i]; a[1] += nrm[i + 1]; a[2] += nrm[i + 2];
    acc.set(k, a);
  }
  const out = new Array<number>(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const a = acc.get(key(i))!;
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    out[i] = a[0] / l; out[i + 1] = a[1] / l; out[i + 2] = a[2] / l;
  }
  return out;
}

/** Count triangles under an object (instanced meshes counted once per geometry). */
export function countTriangles(o: THREE.Object3D): number {
  let t = 0;
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh && m.visible !== false && !(m.userData && m.userData.outline)) {
      const g = m.geometry;
      t += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  return t;
}

/** Count draw calls (meshes) under an object. */
export function countDrawCalls(o: THREE.Object3D): number {
  let d = 0;
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) d++;
  });
  return d;
}
