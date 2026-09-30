/**
 * Caltrop drone: 1.4 m four-point red star with a dark armoured hub, a red
 * sensor eye on the front (-Z) face and short dark secondary points behind.
 * Spins around its local Z (star normal). Chains of 8-14 use CaltropSwarm
 * (one InstancedMesh, per-instance hit flash + spin phase, spin in the shader).
 * Local frame: nose/front face = -Z, up = +Y.
 */
import * as THREE from 'three';
import { palette } from '../../../style/tokens';
import { mix } from '../../../style/color';
import { Rng } from '../../../core/rng';
import { CH, GeoBuilder, type MatSpec, type V } from './kit';
import { ENEMY_VARIANTS } from './variants';
import { createEnemyMaterial, enemyMesh, type EnemyLook, type EnemyMaterialPair } from './material';

export interface CaltropParams {
  span: number; // tip to tip, metres (1.4)
  valley: number; // inner valley radius as a fraction of the tip radius
  thickness: number; // centre half-thickness as a fraction of the tip radius
  sweep: number; // pinwheel lean of the points (radians)
  hubRadius: number; // fraction of tip radius
  backPoints: number; // dark secondary points length fraction (0 = none)
  spinRate: number; // rad/s
  look: EnemyLook;
}

export interface CaltropBuild {
  root: THREE.Group;
  /** the spinning child (do not re-parent) */
  body: THREE.Object3D;
  update(dt: number, s: { time: number; hitFlash?: number }): void;
  triangles: number;
}

export function caltropGeometry(p: CaltropParams, seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed).fork('caltrop');
  const L = p.look;
  const R = p.span / 2;
  const t = p.thickness * R;
  const red: MatSpec = { albedo: palette.caltropRed };
  const redDark: MatSpec = { albedo: mix(palette.caltropRed, palette.enemyBody, 0.45) };
  const body: MatSpec = { albedo: palette.enemyBody };
  const panel: MatSpec = { albedo: mix(palette.enemyBody, palette.enemyPanel, L.panelContrast) };
  const eye: MatSpec = { albedo: palette.enemyBody, emit: palette.enemyMarker, emitStrength: 0.9, channel: CH.eye };
  const eyeHot: MatSpec = { albedo: palette.enemyBody, emit: palette.hostileHalo, emitStrength: 0.8, channel: CH.eye };
  const g = new GeoBuilder();

  // --- red star: ridge from the centre apex to each point (toon split per point)
  const tips: V[] = [], vals: V[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 2 + p.sweep;
    tips.push([Math.cos(a) * R, Math.sin(a) * R, 0]);
    const b = a - p.sweep + Math.PI / 4;
    const rv = p.valley * R;
    vals.push([Math.cos(b) * rv, Math.sin(b) * rv, 0]);
  }
  const F: V = [0, 0, -t], B: V = [0, 0, t * 0.8];
  for (let i = 0; i < 4; i++) {
    const vPrev = vals[(i + 3) % 4], tip = tips[i], vNext = vals[i];
    // mid ridge point raised off the plane to make each point a blade with a crest
    const m: V = [tip[0] * 0.55, tip[1] * 0.55, -t * 0.42];
    const mb: V = [tip[0] * 0.55, tip[1] * 0.55, t * 0.34];
    // front (normals toward -Z): CW in XY seen from +Z
    g.tri(F, m, vPrev, red);
    g.tri(m, tip, vPrev, red);
    g.tri(F, vNext, m, redDark);
    g.tri(m, vNext, tip, redDark);
    // back
    g.tri(B, vPrev, mb, redDark);
    g.tri(mb, vPrev, tip, redDark);
    g.tri(B, mb, vNext, red);
    g.tri(mb, tip, vNext, red);
  }
  // --- dark secondary points in the valleys (set back), make an 8-point read up close
  if (p.backPoints > 0) {
    for (let i = 0; i < 4; i++) {
      const a = Math.atan2(vals[i][1], vals[i][0]);
      const rr = R * p.backPoints;
      const tip: V = [Math.cos(a) * rr, Math.sin(a) * rr, t * 0.5];
      const w = R * 0.13;
      const s1: V = [Math.cos(a + 1.3) * w, Math.sin(a + 1.3) * w, t * 0.5];
      const s2: V = [Math.cos(a - 1.3) * w, Math.sin(a - 1.3) * w, t * 0.5];
      const top: V = [Math.cos(a) * rr * 0.35, Math.sin(a) * rr * 0.35, t * 0.1];
      const bot: V = [Math.cos(a) * rr * 0.35, Math.sin(a) * rr * 0.35, t * 1.1];
      g.tri(top, s1, tip, body);
      g.tri(top, tip, s2, panel);
      g.tri(bot, tip, s1, body);
      g.tri(bot, s2, tip, body);
    }
  }
  // --- hub: octagonal armoured boss through the centre, bevelled front with the eye
  const hr = p.hubRadius * R;
  g.push(new THREE.Matrix4().makeRotationX(-Math.PI / 2)); // cylinder +Y -> -Z
  g.cylinder(8, hr, hr, -t * 0.9, t * 1.05, body, body, undefined, Math.PI / 8);
  g.cylinder(8, hr, hr * 0.62, t * 1.05, t * 1.45, panel, undefined, undefined, Math.PI / 8);
  g.cylinder(8, hr * 0.62, hr * 0.44, t * 1.45, t * 1.52, eye, undefined, eyeHot, Math.PI / 8);
  // rear spike (+Z): gives a "+" in side view
  g.cylinder(4, 0, hr * 0.55, -t * 0.9 - R * 0.32, -t * 0.9, body, undefined, undefined, Math.PI / 4);
  g.pop();
  // tiny marker studs on alternate points (density-controlled)
  const mk: MatSpec = { albedo: palette.enemyBody, emit: palette.enemyMarker, emitStrength: 1.5, channel: CH.marker, phase: rng.next() };
  for (let i = 0; i < 4; i++) {
    if (rng.next() > L.markerDensity) continue;
    const tp = tips[i];
    const c: V = [tp[0] * 0.33, tp[1] * 0.33, -t * 0.72];
    const s = R * 0.035;
    g.panel(c, [s, 0, 0], [0, -s, 0], mk);
  }
  return g.build(false);
}

function applyTime(mp: EnemyMaterialPair, time: number, spinRate: number) {
  mp.u.uEnemyTime.value = time;
  mp.u.uSpinTime.value = time;
  mp.u.uSpinRate.value = spinRate;
}

/** Single caltrop for boards / hero shots. Spin is applied to `body` (a child), not `root`. */
export function buildCaltrop(params: CaltropParams, seed = 1): CaltropBuild {
  const geo = caltropGeometry(params, seed);
  const mp = createEnemyMaterial({ look: params.look, seamSpacing: 0.35 });
  const root = new THREE.Group();
  root.name = 'caltrop';
  const body = new THREE.Group();
  for (const m of enemyMesh(geo, mp)) body.add(m);
  root.add(body);
  return {
    root,
    body,
    triangles: geo.attributes.position.count / 3,
    update(dt, s) {
      body.rotation.z = s.time * params.spinRate;
      mp.u.uEnemyTime.value = s.time;
      mp.u.uHitFlash.value = s.hitFlash ?? 0;
    },
  };
}

const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();

/**
 * Instanced caltrop chain renderer: one draw call (+1 if outline) for up to `capacity` drones.
 *   set(i, position, quaternion, scale, flash) each frame for live drones, setCount(n), update(time).
 * Spin around local Z happens in the vertex shader (per-instance phase), so the
 * quaternion you pass only needs to face the star toward the camera / travel direction.
 */
export class CaltropSwarm {
  readonly mesh: THREE.Group;
  readonly capacity: number;
  readonly triangles: number;
  private meshes: THREE.InstancedMesh[];
  private inst: THREE.InstancedBufferAttribute;
  private mp: EnemyMaterialPair;
  private spinRate: number;

  constructor(capacity: number, params: CaltropParams = ENEMY_VARIANTS.A.caltrop, seed = 1) {
    this.capacity = capacity;
    this.spinRate = params.spinRate;
    const geo = caltropGeometry(params, seed);
    this.triangles = geo.attributes.position.count / 3;
    const rng = new Rng(seed).fork('caltrop-phase');
    const arr = new Float32Array(capacity * 2);
    for (let i = 0; i < capacity; i++) arr[i * 2 + 1] = rng.next();
    this.inst = new THREE.InstancedBufferAttribute(arr, 2);
    this.inst.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aInst', this.inst);
    this.mp = createEnemyMaterial({ look: params.look, instanced: true, spin: true, seamSpacing: 0.35 });
    this.meshes = enemyMesh(geo, this.mp, capacity) as THREE.InstancedMesh[];
    this.mesh = new THREE.Group();
    this.mesh.name = 'caltrop-swarm';
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
    applyTime(this.mp, time, this.spinRate);
    this.meshes[0].instanceMatrix.needsUpdate = true;
    this.inst.needsUpdate = true;
  }

  dispose(): void {
    this.meshes[0].geometry.dispose();
    this.mp.body.dispose();
    this.mp.outline?.dispose();
  }
}

