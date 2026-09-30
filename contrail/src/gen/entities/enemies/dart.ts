/**
 * Dart fighter: ~7 m dark wedge (arrowhead body rising to a blunt rear), drooped
 * swept wings, canted V-fins, two rear "barb" booms (harpoon silhouette), twin
 * orange thrusters with alpha-blended plumes, red wingtip markers and a red
 * sensor chevron on the nose. Flies in pairs: DartSquadron instances them.
 * Local frame: nose = -Z, up = +Y.
 */
import * as THREE from 'three';
import { palette } from '../../../style/tokens';
import { mix } from '../../../style/color';
import { Rng } from '../../../core/rng';
import { CH, GeoBuilder, type MatSpec, type V } from './kit';
import { ENEMY_VARIANTS } from './variants';
import { createEnemyMaterial, createFlameMaterial, enemyMesh, flameGeometry, type EnemyLook, type EnemyMaterialPair } from './material';

export interface DartParams {
  length: number; // 7
  span: number; // wingspan (4.6)
  height: number; // rear spine height above the wing plane
  wingDroop: number; // anhedral (rad)
  finCant: number; // V-fin outward cant (rad)
  barbs: number; // rear barb length scale (0 = none)
  look: EnemyLook;
}

export interface DartBuild {
  root: THREE.Group;
  update(dt: number, s: { time: number; hitFlash?: number; thrust?: number }): void;
  /** nozzle exit points (root space) */
  nozzlesLocal: THREE.Vector3[];
  /** gun muzzle (root space) for the 3-shot orb bursts */
  muzzleLocal: THREE.Vector3;
  triangles: number;
}

interface DartGeo {
  body: THREE.BufferGeometry;
  flame: THREE.BufferGeometry;
  nozzles: THREE.Vector3[];
  muzzle: THREE.Vector3;
}

export function dartGeometry(p: DartParams, seed: number): DartGeo {
  const rng = new Rng(seed).fork('dart');
  const L = p.look;
  const k = p.length / 7;
  const body: MatSpec = { albedo: palette.enemyBody };
  const panel: MatSpec = { albedo: mix(palette.enemyBody, palette.enemyPanel, L.panelContrast) };
  const panelHi: MatSpec = { albedo: mix(palette.enemyBody, palette.enemyPanel, Math.min(1, L.panelContrast * 1.25)) };
  const marker: MatSpec = { albedo: palette.enemyBody, emit: palette.enemyMarker, emitStrength: 1.4, channel: CH.marker, phase: rng.next() };
  const eye: MatSpec = { albedo: palette.enemyBody, emit: palette.enemyMarker, emitStrength: 1.6, channel: CH.eye };
  const nozzleIn: MatSpec = { albedo: palette.armourDark, emit: palette.accentOrange, emitStrength: 1.0, channel: CH.thruster, phase: 0.3 };
  const nozzleCore: MatSpec = { albedo: palette.armourDark, emit: palette.exhaustCore, emitStrength: 1.0, channel: CH.thruster, phase: 0.7 };
  const g = new GeoBuilder();
  g.push(new THREE.Matrix4().makeScale(k, k, k));

  // --- wedge hull: loft nose (-Z) -> tail (+Z); rings CCW in XY
  const H = p.height;
  const secs: [number, number, number, number][] = [
    // z, halfWidth, top, bottom
    [-3.5, 0.04, 0.03, 0.02],
    [-2.6, 0.3, 0.2, 0.12],
    [-1.2, 0.7, 0.48 * H, 0.24],
    [0.5, 0.96, 0.84 * H, 0.3],
    [2.2, 1.0, H, 0.3],
    [3.2, 0.88, 0.92 * H, 0.26],
  ];
  const rings: V[][] = secs.map(([z, w, h, d]) => [
    [-0.6 * w, -d, z], [0.6 * w, -d, z], [w, 0.08 * h, z], [0.52 * w, 0.72 * h, z],
    [0, h, z], [-0.52 * w, 0.72 * h, z], [-w, 0.08 * h, z],
  ]);
  g.loft(rings, (_r, s) => (s === 0 || s === 1 || s === 6 ? body : s === 3 || s === 4 ? panelHi : panel), body, body);
  // nose sensor chevron (red), sits on the upper faces
  const zc = -1.75, hh = 0.36 * H;
  g.mirrorX(() => {
    g.quad([0.02, hh + 0.05, zc - 0.18], [0.02, hh + 0.06, zc + 0.02], [0.34, hh * 0.68 + 0.05, zc + 0.3], [0.34, hh * 0.68 + 0.04, zc + 0.1], eye);
  });
  // spine ridge plate
  g.box(0, H + 0.03, 1.6, 0.16, 0.12, 2.6, panelHi, 0.3, body);

  // --- wings (drooped, swept), loft along +X from root to tip, rings [leading, top, trailing, bottom]
  const half = p.span / 2;
  const droop = Math.tan(p.wingDroop) * (half - 0.85);
  g.mirrorX(() => {
    const root = (x: number, zl: number, zt: number, y: number, th: number): V[] => [
      [x, y, zl], [x, y + th, (zl + zt) * 0.5], [x, y, zt], [x, y - th * 0.6, (zl + zt) * 0.5],
    ];
    g.loft([root(0.8, -0.5, 2.9, 0.12, 0.14), root(half * 0.62, 1.0, 3.1, 0.12 - droop * 0.55, 0.09), root(half, 2.1, 3.25, 0.12 - droop, 0.05)],
      (_r, s) => (s === 0 ? panel : s === 1 ? body : body), undefined, body);
    // wingtip marker light
    g.box(half + 0.02, 0.12 - droop, 2.55, 0.1, 0.12, 0.5, marker);
    // optional flank markers
    if (rng.next() < L.markerDensity) g.box(0.99, 0.2, 1.2, 0.05, 0.08, 0.35, marker);
  });

  // --- V-fins, canted outward
  g.mirrorX(() => {
    const cant = p.finCant;
    const base = (zl: number, zt: number, x: number, y: number, th: number): V[] => [
      [x, y, zl], [x - th, y, (zl + zt) / 2], [x, y, zt], [x + th, y, (zl + zt) / 2],
    ];
    const hFin = 1.05;
    const x1 = 0.42 + Math.tan(cant) * hFin;
    g.loft([base(1.5, 3.1, 0.42, 0.8 * H, 0.07), base(2.75, 3.45, x1, 0.8 * H + hFin, 0.03)], panel, undefined, body);
    if (rng.next() < L.markerDensity) g.box(x1, 0.8 * H + hFin + 0.02, 3.1, 0.06, 0.06, 0.3, marker);
  });

  // --- rear barbs (harpoon booms): square loft along +Z
  if (p.barbs > 0) {
    g.mirrorX(() => {
      const sq = (x: number, y: number, z: number, s: number): V[] => [[x - s, y - s, z], [x + s, y - s, z], [x + s, y + s, z], [x - s, y + s, z]];
      g.loft([sq(0.92, 0.05, 0.6, 0.16), sq(1.02, 0.02, 3.1, 0.13), sq(1.1, -0.02, 3.2 + 1.3 * p.barbs, 0.015)], (_r, s) => (s === 2 ? panel : body), body);
    });
  }

  // --- thrusters: two nozzles through the rear face
  const nozzles: THREE.Vector3[] = [];
  g.mirrorX((side) => {
    g.push(new THREE.Matrix4().makeTranslation(0.42, 0.34 * H + 0.05, 0).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
    g.cylinder(8, 0.3, 0.27, 2.9, 3.55, body, undefined, nozzleIn, Math.PI / 8);
    g.cylinder(8, 0.16, 0.16, 3.55, 3.57, nozzleCore, undefined, nozzleCore, Math.PI / 8);
    g.pop();
    nozzles.push(new THREE.Vector3(0.42 * side * k, (0.34 * H + 0.05) * k, 3.55 * k));
  });
  // gun pod under the nose
  g.box(0, -0.22, -1.6, 0.18, 0.14, 1.4, body, 0.3);
  g.pop();

  // flames: cone along -Y rotated to +Z, placed at each nozzle
  const fl: THREE.BufferGeometry[] = [];
  for (const n of nozzles) {
    const f = flameGeometry(0.2 * k, 1.8 * k);
    f.rotateX(-Math.PI / 2);
    f.translate(n.x, n.y, n.z - 0.05 * k);
    fl.push(f);
  }
  const flame = mergeSimple(fl);
  return { body: g.build(false), flame, nozzles, muzzle: new THREE.Vector3(0, -0.22 * k, -2.35 * k) };
}

/** Merge non-indexed-compatible geometries (position/normal/uv). */
export function mergeSimple(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const size = parts[0].attributes[name].itemSize;
    const total = parts.reduce((a, g) => a + g.attributes[name].count * size, 0);
    const arr = new Float32Array(total);
    let o = 0;
    for (const g of parts) {
      arr.set(g.attributes[name].array as Float32Array, o);
      o += g.attributes[name].count * size;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  out.computeBoundingSphere();
  return out;
}

function tick(mp: EnemyMaterialPair, flame: THREE.ShaderMaterial, time: number, thrust: number) {
  mp.u.uEnemyTime.value = time;
  flame.uniforms.uFlameTime.value = time;
  flame.uniforms.uFlameLen.value = 0.6 + 0.6 * thrust;
}

export function buildDart(params: DartParams = ENEMY_VARIANTS.A.dart, seed = 1): DartBuild {
  const G = dartGeometry(params, seed);
  const mp = createEnemyMaterial({ look: params.look, seamSpacing: 0.9 });
  const fm = createFlameMaterial(false, params.look.thrusterIntensity / 2);
  const root = new THREE.Group();
  root.name = 'dart';
  for (const m of enemyMesh(G.body, mp)) root.add(m);
  const flame = new THREE.Mesh(G.flame, fm);
  flame.renderOrder = 2;
  root.add(flame);
  return {
    root,
    nozzlesLocal: G.nozzles,
    muzzleLocal: G.muzzle,
    triangles: G.body.attributes.position.count / 3,
    update(dt, s) {
      tick(mp, fm, s.time, s.thrust ?? 1);
      mp.u.uHitFlash.value = s.hitFlash ?? 0;
    },
  };
}

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

/**
 * Instanced dart renderer: body (1 draw call, +1 with outline) + plumes (1 draw call),
 * all sharing one instance-matrix buffer and one per-instance (flash, phase) buffer.
 */
export class DartSquadron {
  readonly mesh: THREE.Group;
  readonly capacity: number;
  readonly triangles: number;
  private meshes: THREE.InstancedMesh[];
  private inst: THREE.InstancedBufferAttribute;
  private mp: EnemyMaterialPair;
  private fm: THREE.ShaderMaterial;
  thrust = 1;

  constructor(capacity: number, params: DartParams = ENEMY_VARIANTS.A.dart, seed = 1) {
    this.capacity = capacity;
    const G = dartGeometry(params, seed);
    this.triangles = G.body.attributes.position.count / 3;
    const rng = new Rng(seed).fork('dart-phase');
    const arr = new Float32Array(capacity * 2);
    for (let i = 0; i < capacity; i++) arr[i * 2 + 1] = rng.next();
    this.inst = new THREE.InstancedBufferAttribute(arr, 2);
    this.inst.setUsage(THREE.DynamicDrawUsage);
    G.body.setAttribute('aInst', this.inst);
    G.flame.setAttribute('aInst', this.inst);
    this.mp = createEnemyMaterial({ look: params.look, instanced: true, seamSpacing: 0.9 });
    this.fm = createFlameMaterial(true, params.look.thrusterIntensity / 2);
    this.meshes = enemyMesh(G.body, this.mp, capacity) as THREE.InstancedMesh[];
    const flame = new THREE.InstancedMesh(G.flame, this.fm, capacity);
    flame.renderOrder = 2;
    this.meshes.push(flame);
    this.mesh = new THREE.Group();
    this.mesh.name = 'dart-squadron';
    const shared = this.meshes[0].instanceMatrix;
    shared.setUsage(THREE.DynamicDrawUsage);
    for (const m of this.meshes) {
      m.instanceMatrix = shared;
      m.frustumCulled = false;
      m.count = 0;
      this.mesh.add(m);
    }
  }

  set(i: number, position: THREE.Vector3, quaternion: THREE.Quaternion, scale: number, flash: number): void {
    _m.compose(position, quaternion, _s.set(scale, scale, scale));
    this.meshes[0].setMatrixAt(i, _m);
    (this.inst.array as Float32Array)[i * 2] = flash;
  }

  setCount(n: number): void {
    const c = Math.max(0, Math.min(this.capacity, n));
    for (const m of this.meshes) m.count = c;
  }

  update(time: number): void {
    tick(this.mp, this.fm, time, this.thrust);
    this.meshes[0].instanceMatrix.needsUpdate = true;
    this.inst.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.meshes) m.geometry.dispose();
    this.mp.body.dispose();
    this.mp.outline?.dispose();
    this.fm.dispose();
  }
}
