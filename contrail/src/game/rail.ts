/**
 * The rail: a smooth spline through world space sampled every metre into a
 * table of parallel-transport frames (position, tangent, right, up).
 *
 * Combat is simulated in RAIL SPACE (u, x, y): u = metres ahead of the player
 * along the rail, x = right, y = up. worldOf() maps rail space to world space
 * using the frame at (playerS + u), so the play field bends with the corridor.
 */
import * as THREE from 'three';
import { Rng } from '../core/rng';

export interface RailFrame {
  pos: THREE.Vector3;
  tan: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
}

export interface RailParams {
  length: number; // metres
  /** lateral wander amplitude (m) and wavelength (m) */
  wanderX: number;
  wanderY: number;
  wavelength: number;
  seed: number;
}

export class Rail {
  readonly length: number;
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private tx: Float32Array;
  private ty: Float32Array;
  private tz: Float32Array;
  private rx: Float32Array;
  private ry: Float32Array;
  private rz: Float32Array;
  private ux: Float32Array;
  private uy: Float32Array;
  private uz: Float32Array;
  private readonly n: number;

  constructor(p: RailParams) {
    // Extra margin past the end so entities ahead of the player near the finish have frames.
    this.length = p.length;
    const total = Math.ceil(p.length + 1200);
    this.n = total + 1;
    const rng = new Rng(p.seed);
    // control points every wavelength/2 with seeded lateral offsets; first two straight
    const ctrl: THREE.Vector3[] = [];
    const step = p.wavelength / 2;
    const count = Math.ceil(total / step) + 3;
    for (let i = 0; i < count; i++) {
      const z = -i * step + step;
      const calm = i < 3 ? 0 : 1;
      ctrl.push(new THREE.Vector3(rng.signed() * p.wanderX * calm, rng.signed() * p.wanderY * calm, z));
    }
    const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal', 0.5);
    curve.arcLengthDivisions = Math.ceil(total / 2); // ~2 m arc-length table resolution
    // arc-length parameterisation
    const curveLen = curve.getLength();
    const N = this.n;
    this.px = new Float32Array(N); this.py = new Float32Array(N); this.pz = new Float32Array(N);
    this.tx = new Float32Array(N); this.ty = new Float32Array(N); this.tz = new Float32Array(N);
    this.rx = new Float32Array(N); this.ry = new Float32Array(N); this.rz = new Float32Array(N);
    this.ux = new Float32Array(N); this.uy = new Float32Array(N); this.uz = new Float32Array(N);
    const offset = step; // skip the first control segment so s=0 starts on the curve body
    const tmp = new THREE.Vector3();
    const tan = new THREE.Vector3();
    let up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const u = Math.min(1, (i + offset) / curveLen);
      curve.getPointAt(u, tmp);
      curve.getTangentAt(u, tan).normalize();
      // parallel transport the up vector, gently pulled back toward world up (no corkscrews)
      right.crossVectors(tan, up).normalize();
      up = new THREE.Vector3().crossVectors(right, tan).normalize();
      up.lerp(new THREE.Vector3(0, 1, 0), 0.02).normalize();
      right.crossVectors(tan, up).normalize();
      up.crossVectors(right, tan).normalize();
      this.px[i] = tmp.x; this.py[i] = tmp.y; this.pz[i] = tmp.z;
      this.tx[i] = tan.x; this.ty[i] = tan.y; this.tz[i] = tan.z;
      this.rx[i] = right.x; this.ry[i] = right.y; this.rz[i] = right.z;
      this.ux[i] = up.x; this.uy[i] = up.y; this.uz[i] = up.z;
    }
  }

  /** Frame at arc length s (metres), linearly interpolated. Writes into out. */
  frameAt(s: number, out: RailFrame): RailFrame {
    const f = Math.max(0, Math.min(this.n - 1.001, s));
    const i = Math.floor(f);
    const t = f - i;
    const j = i + 1;
    const L = (a: Float32Array) => a[i] + (a[j] - a[i]) * t;
    out.pos.set(L(this.px), L(this.py), L(this.pz));
    out.tan.set(L(this.tx), L(this.ty), L(this.tz)).normalize();
    out.right.set(L(this.rx), L(this.ry), L(this.rz)).normalize();
    out.up.set(L(this.ux), L(this.uy), L(this.uz)).normalize();
    return out;
  }

  /** World position of rail-space point (s + u, x, y). */
  worldOf(s: number, u: number, x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
    const f = this.frameAt(s + u, scratchFrame);
    return out.copy(f.pos).addScaledVector(f.right, x).addScaledVector(f.up, y);
  }
}

export function makeFrame(): RailFrame {
  return { pos: new THREE.Vector3(), tan: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() };
}

const scratchFrame = makeFrame();
