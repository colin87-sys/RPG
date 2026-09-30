/**
 * Laser sniper: ~8 m long lance. Front: a big dark collar ring holding a glowing
 * lens, framed by three claws (reads as "a scope / an eye" when it aims at you).
 * Middle: hexagonal spine with armour sleeves and charge nodes that light in
 * sequence rear -> front. Rear: faceted power cell with three fletching vanes.
 * Telegraph (0.7 s): setCharge / update({charge}) ramps the lens red -> white-hot,
 * lights the nodes in order and springs the claws open.
 * Local frame: nose (emitter) = -Z, up = +Y. One draw call (+1 with outline):
 * claws are rigid bones inside the same mesh.
 */
import * as THREE from 'three';
import { palette } from '../../../style/tokens';
import { mix } from '../../../style/color';
import { Rng } from '../../../core/rng';
import { CH, GeoBuilder, type MatSpec, type V } from './kit';
import { ENEMY_VARIANTS } from './variants';
import { createEnemyMaterial, createFlameMaterial, enemyMesh, flameGeometry, type EnemyLook } from './material';

export interface SniperParams {
  length: number; // 8
  lensRadius: number; // 0.72
  ringRadius: number; // collar outer radius 1.2
  claws: number; // 3
  vanes: number; // 3
  nodes: number; // charge nodes along the spine
  look: EnemyLook;
}

export interface SniperState {
  time: number;
  charge?: number; // 0..1 during the 0.7 s telegraph
  hitFlash?: number;
}

export interface SniperBuild {
  root: THREE.Group;
  update(dt: number, s: SniperState): void;
  setCharge(c: number): void;
  /** beam origin at the lens face (root space) */
  emitterLocal: THREE.Vector3;
  triangles: number;
}

const BONES = 4; // 0 body, 1..3 claws

export function sniperGeometry(p: SniperParams, seed: number) {
  const rng = new Rng(seed).fork('sniper');
  const L = p.look;
  const k = p.length / 8;
  const body: MatSpec = { albedo: palette.enemyBody };
  const panel: MatSpec = { albedo: mix(palette.enemyBody, palette.enemyPanel, L.panelContrast) };
  const lens: MatSpec = { albedo: palette.enemyBody, emit: palette.laserRed, emitStrength: 1.0, channel: CH.charge };
  const lensRim: MatSpec = { albedo: palette.enemyBody, emit: palette.laserRed, emitStrength: 0.55, channel: CH.charge };
  const marker: MatSpec = { albedo: palette.enemyBody, emit: palette.enemyMarker, emitStrength: 1.4, channel: CH.marker, phase: rng.next() };
  const thr: MatSpec = { albedo: palette.armourDark, emit: palette.accentOrange, emitStrength: 1.0, channel: CH.thruster };
  const g = new GeoBuilder();
  g.push(new THREE.Matrix4().makeScale(k, k, k));
  const alongZ = new THREE.Matrix4().makeRotationX(Math.PI / 2); // +Y -> +Z

  // --- spine + sleeves + charge nodes
  g.push(alongZ);
  g.cylinder(6, 0.26, 0.26, -3.3, 2.5, body, undefined, undefined, 0);
  const sleeves = [-2.7, -1.5, -0.3, 0.9];
  for (const z of sleeves) {
    g.cylinder(6, 0.36, 0.44, z - 0.18, z, panel, body, undefined, 0);
    g.cylinder(6, 0.44, 0.44, z, z + 0.42, body, undefined, undefined, 0);
    g.cylinder(6, 0.44, 0.34, z + 0.42, z + 0.6, panel, undefined, body, 0);
  }
  for (let i = 0; i < p.nodes; i++) {
    const z = 2.2 - (i / Math.max(1, p.nodes - 1)) * 5.1; // rear -> front
    const node: MatSpec = { albedo: palette.enemyBody, emit: palette.laserRed, emitStrength: 1.3, channel: CH.sequence, phase: (i / p.nodes) * 0.9 };
    g.cylinder(6, 0.31, 0.31, z - 0.07, z + 0.07, node, undefined, undefined, Math.PI / 6);
  }
  g.pop();

  // --- collar ring (front), 12 segments, open centre for the lens
  const R0 = p.lensRadius + 0.08, R1 = p.ringRadius, zf = -3.95, zb = -3.25, n = 12;
  for (let i = 0; i < n; i++) {
    const a1 = (i / n) * Math.PI * 2 + Math.PI / 12, a0 = ((i + 1) / n) * Math.PI * 2 + Math.PI / 12; // (winding: outward faces)
    const P = (r: number, a: number, z: number): V => [Math.cos(a) * r, Math.sin(a) * r, z];
    const m = i % 2 === 0 ? panel : body;
    g.quad(P(R1, a0, zb), P(R1, a1, zb), P(R1 * 0.92, a1, zf), P(R1 * 0.92, a0, zf), body); // outer (tapers forward)
    g.quad(P(R0, a0, zf), P(R1 * 0.92, a0, zf), P(R1 * 0.92, a1, zf), P(R0, a1, zf), m); // front face
    g.quad(P(R0, a1, zf), P(R0, a1, zb + 0.2), P(R0, a0, zb + 0.2), P(R0, a0, zf), lensRim); // inner lip (glows faintly)
    g.quad(P(R1, a1, zb), P(R1, a0, zb), P(0.3, a0, zb + 0.35), P(0.3, a1, zb + 0.35), body); // back cone to spine
  }
  // lens: smooth flattened orb recessed in the collar
  g.sphere([0, 0, -3.62], p.lensRadius, p.lensRadius, 0.36, 16, 8, lens);
  // collar marker lights
  for (let i = 0; i < 6; i++) {
    if (rng.next() > L.markerDensity) continue;
    const a = (i / 6) * Math.PI * 2;
    const r = (R0 + R1 * 0.92) / 2;
    g.panel([Math.cos(a) * r, Math.sin(a) * r, zf - 0.02], [0.05, 0, 0], [0, 0.05, 0], marker);
  }

  // --- claws (bones 1..3): triangular blades from the ring, curving forward and inward
  for (let c = 0; c < p.claws; c++) {
    const ang = Math.PI / 2 + (c / p.claws) * Math.PI * 2;
    g.bone = 1 + c;
    g.push(new THREE.Matrix4().makeRotationZ(ang - Math.PI / 2)); // author with radial = +Y
    const sec = (r: number, z: number, w: number, h: number): V[] => [[-w, r, z], [0, r + h, z], [w, r, z]];
    const rr = p.ringRadius;
    g.loft([sec(rr * 0.8, -3.4, 0.22, 0.3), sec(rr * 1.05, -4.25, 0.2, 0.34), sec(rr * 0.82, -5.0, 0.13, 0.2), sec(rr * 0.48, -5.45, 0.02, 0.03)],
      (r, s) => (s === 0 ? (r === 0 ? panel : panel) : body), body);
    if (rng.next() < L.markerDensity) g.box(0, rr * 1.05 + 0.36, -4.25, 0.1, 0.06, 0.3, marker);
    g.pop();
  }
  g.bone = 0;

  // --- power cell (rear) + vanes
  g.push(alongZ);
  g.cylinder(8, 0.3, 0.66, 2.3, 3.0, panel, undefined, undefined, Math.PI / 8);
  g.cylinder(8, 0.66, 0.5, 3.0, 3.7, body, undefined, undefined, Math.PI / 8);
  g.cylinder(8, 0.5, 0.36, 3.7, 3.9, body, undefined, thr, Math.PI / 8);
  g.pop();
  for (let v = 0; v < p.vanes; v++) {
    const ang = -Math.PI / 2 + (v / p.vanes) * Math.PI * 2 + Math.PI / p.vanes;
    g.push(new THREE.Matrix4().makeRotationZ(ang - Math.PI / 2));
    // vane plate in the YZ plane (radial = +Y), swept back; ring [lead, left, trail, right] seen from +Y
    const vs = (r: number, zl: number, zt: number, th: number): V[] => [[0, r, zl], [-th, r, (zl + zt) / 2], [0, r, zt], [th, r, (zl + zt) / 2]];
    g.loft([vs(0.35, 1.6, 3.6, 0.07), vs(1.25, 2.8, 3.95, 0.05), vs(1.65, 3.55, 4.1, 0.02)], (_r, s) => (s < 2 ? panel : body), undefined, body);
    if (rng.next() < L.markerDensity) g.box(0, 1.6, 3.8, 0.06, 0.1, 0.3, marker);
    g.pop();
  }
  g.pop();
  const geo = g.build(true);
  return { geo, emitter: new THREE.Vector3(0, 0, -3.98 * k), clawPivotR: p.ringRadius * 0.8 * k, clawPivotZ: -3.4 * k, k };
}

export function buildSniper(params: SniperParams = ENEMY_VARIANTS.A.sniper, seed = 1): SniperBuild {
  const S = sniperGeometry(params, seed);
  const mp = createEnemyMaterial({ look: params.look, bones: BONES, seamSpacing: 0.7 });
  const root = new THREE.Group();
  root.name = 'sniper';
  for (const m of enemyMesh(S.geo, mp)) root.add(m);
  const fm = createFlameMaterial(false, params.look.thrusterIntensity / 2.4);
  const fg = flameGeometry(0.3 * S.k, 1.2 * S.k);
  fg.rotateX(-Math.PI / 2);
  fg.translate(0, 0, 3.9 * S.k);
  const flame = new THREE.Mesh(fg, fm);
  flame.renderOrder = 2;
  root.add(flame);

  const bones = mp.bones!;
  const claw = { a: 0, v: 0 };
  let charge = 0;
  const T = new THREE.Matrix4(), Ti = new THREE.Matrix4(), Rm = new THREE.Matrix4(), axis = new THREE.Vector3();
  const setClaws = (open: number) => {
    for (let c = 0; c < params.claws; c++) {
      const ang = Math.PI / 2 + (c / params.claws) * Math.PI * 2;
      const px = Math.cos(ang) * S.clawPivotR, py = Math.sin(ang) * S.clawPivotR;
      axis.set(-Math.sin(ang), Math.cos(ang), 0);
      T.makeTranslation(px, py, S.clawPivotZ);
      Ti.makeTranslation(-px, -py, -S.clawPivotZ);
      Rm.makeRotationAxis(axis, -open);
      bones[1 + c].copy(T).multiply(Rm).multiply(Ti);
    }
  };
  setClaws(0);
  const api: SniperBuild = {
    root,
    emitterLocal: S.emitter,
    triangles: S.geo.attributes.position.count / 3,
    setCharge(c: number) {
      charge = Math.max(0, Math.min(1, c));
    },
    update(dt, s) {
      if (s.charge !== undefined) api.setCharge(s.charge);
      const c = charge;
      // lens: base glow -> overdriven white-hot; nodes light rear -> front
      mp.u.uChanA.value.w = 0.55 + 4.2 * c * c;
      mp.u.uSeq.value = c * 1.02;
      mp.u.uEnemyTime.value = s.time;
      mp.u.uHitFlash.value = s.hitFlash ?? 0;
      // claws: damped spring toward open = 0.38 rad * charge, with a tremble near full charge
      const target = 0.38 * c + (c > 0.85 ? Math.sin(s.time * 60) * 0.02 : 0);
      const h = Math.min(dt, 1 / 30);
      claw.v += (-(claw.a - target) * 180 - claw.v * 16) * h;
      claw.a += claw.v * h;
      setClaws(claw.a);
      fm.uniforms.uFlameTime.value = s.time;
      fm.uniforms.uFlameLen.value = 0.7 + 0.3 * (1 - c);
    },
  };
  return api;
}
