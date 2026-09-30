/**
 * Strider: ~16 m bipedal mech that hovers on a twin-pod jetpack. Broad prow
 * chest, low sensor head with a red visor, heavy pauldrons, forearm gun pods,
 * digitigrade legs with clawed feet that dangle and sway on damped springs.
 * Weak point: an amber reactor core on the back between the jet pods, behind two
 * armour shutters that slide open (weakPointOpen).
 * One mesh with 14 rigid bones (1 draw call, +1 outline, +1 flames).
 * Local frame: origin at the pelvis, front = -Z, up = +Y.
 */
import * as THREE from 'three';
import { palette } from '../../../style/tokens';
import { mix } from '../../../style/color';
import { Rng } from '../../../core/rng';
import { CH, GeoBuilder, type MatSpec, type V } from './kit';
import { ENEMY_VARIANTS } from './variants';
import { mergeSimple } from './dart';
import { createEnemyMaterial, createFlameMaterial, enemyMesh, flameGeometry, type EnemyLook } from './material';

export interface StriderParams {
  height: number; // 16
  shoulderWidth: number; // pauldron to pauldron (7.6)
  legScale: number; // leg length multiplier
  jetpackSize: number;
  swayAmp: number; // secondary motion gain
  springK: number; // leg spring stiffness (1/s^2)
  damping: number;
  look: EnemyLook;
}

export interface StriderState {
  time: number;
  hitFlash?: number;
  weakPointOpen?: number | boolean;
}

export interface StriderBuild {
  root: THREE.Group;
  update(dt: number, s: StriderState): void;
  /** reactor core centre (root space; follows the hover bob) */
  weakPointLocal: THREE.Vector3;
  /** forearm gun muzzles [right, left] (root space; follow the arms) */
  muzzlesLocal: THREE.Vector3[];
  triangles: number;
}

// bone ids
const B = { body: 0, head: 1, uarmR: 2, uarmL: 3, farmR: 4, farmL: 5, thighR: 6, thighL: 7, shinR: 8, shinL: 9, footR: 10, footL: 11, shutR: 12, shutL: 13 };
const BONES = 14;
const NOMINAL_H = 15.9;

/** Box whose local +Y runs from b up to a (limb segment). */
function limb(g: GeoBuilder, a: V, b: V, w: number, d: number, mat: MatSpec, chamfer = 0.3, side?: MatSpec) {
  const A = new THREE.Vector3(...a), Bv = new THREE.Vector3(...b);
  const y = A.clone().sub(Bv);
  const len = y.length();
  y.normalize();
  const x = new THREE.Vector3(1, 0, 0).addScaledVector(y, -y.x).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  const m = new THREE.Matrix4().makeBasis(x, y, z).setPosition(A.add(Bv).multiplyScalar(0.5));
  g.push(m);
  g.box(0, 0, 0, w, len, d, mat, chamfer, side);
  g.pop();
}

export function striderGeometry(p: StriderParams, seed: number) {
  const rng = new Rng(seed).fork('strider');
  const L = p.look;
  const S = p.height / NOMINAL_H;
  const ls = p.legScale;
  const body: MatSpec = { albedo: palette.enemyBody };
  const panel: MatSpec = { albedo: mix(palette.enemyBody, palette.enemyPanel, L.panelContrast) };
  const panelHi: MatSpec = { albedo: mix(palette.enemyBody, palette.enemyPanel, Math.min(1, L.panelContrast * 1.3)) };
  const red = (s = 1.5): MatSpec => ({ albedo: palette.enemyBody, emit: palette.enemyMarker, emitStrength: s, channel: CH.marker, phase: rng.next() });
  const eye: MatSpec = { albedo: palette.enemyBody, emit: palette.enemyMarker, emitStrength: 2.0, channel: CH.eye };
  const thr: MatSpec = { albedo: palette.armourDark, emit: palette.accentOrange, emitStrength: 1.0, channel: CH.thruster };
  const core: MatSpec = { albedo: palette.bossBody, emit: palette.bossVent, emitStrength: 1.0, channel: CH.weak };
  const g = new GeoBuilder();
  g.push(new THREE.Matrix4().makeScale(S, S, S));
  const sw = p.shoulderWidth / 7.6;

  // ---------------- body (bone 0)
  g.bone = B.body;
  g.box(0, 0, 0.1, 2.6, 1.1, 1.8, body, 0.35);
  g.box(0, 1.0, 0.2, 1.6, 1.2, 1.4, panel, 0.3);
  // chest: loft along +Y, rings CCW seen from above (x, -z)
  const chest = (y: number, s: number): V[] => {
    const pts: [number, number][] = [[0, -1.75], [-1.35, -1.05], [-2.0, 0.1], [-1.5, 1.3], [1.5, 1.3], [2.0, 0.1], [1.35, -1.05]];
    return pts.map(([x, z]) => [x * s * sw, y, z * (0.75 + 0.25 * s)] as V);
  };
  g.loft([chest(1.5, 0.6), chest(3.0, 0.95), chest(4.4, 1.0), chest(5.05, 0.78)],
    (r, s) => (s === 0 || s === 6 ? (r === 1 ? panelHi : panel) : s === 3 ? body : r === 2 ? panel : body), undefined, panel);
  // chest accent lights (red strips on the prow faces)
  g.mirrorX(() => {
    g.push(g.at(0.72 * sw, 3.95, -1.43, 0, -0.5, 0));
    g.box(0, 0, 0, 0.72, 0.13, 0.08, red(1.8));
    g.box(0, -0.35, 0.02, 0.5, 0.1, 0.08, red(1.4));
    g.pop();
  });
  // pauldrons
  g.mirrorX(() => {
    g.box(2.95 * sw, 4.85, 0.0, 1.9, 1.45, 2.7, panelHi, 0.35, body);
    g.box(2.95 * sw, 4.1, 0.0, 1.6, 0.4, 2.3, body, 0.3);
    if (rng.next() < 0.5 + L.markerDensity * 0.5) g.box(3.2 * sw, 4.95, -1.37, 0.5, 0.18, 0.06, red());
  });
  // hip armour
  g.mirrorX(() => g.box(1.6, -0.1, 0.1, 0.7, 1.3, 1.5, panel, 0.3, body));
  // jetpack: two pods + central housing
  const jp = p.jetpackSize;
  g.mirrorX(() => {
    g.push(new THREE.Matrix4().makeTranslation(1.28, 0, 1.95));
    g.cylinder(8, 0.72 * jp, 0.72 * jp, 1.8, 5.3, body, undefined, panel, Math.PI / 8);
    g.cylinder(8, 0.55 * jp, 0.72 * jp, 1.25, 1.8, panel, thr, undefined, Math.PI / 8);
    g.cylinder(4, 0.3, 0.02, 5.3, 6.9, body, undefined, undefined, Math.PI / 4); // antenna fin
    g.pop();
    if (rng.next() < L.markerDensity) g.box(1.28, 5.0, 1.95 + 0.73 * jp, 0.3, 0.12, 0.05, red());
  });
  g.box(0, 3.4, 1.75, 1.7, 3.0, 1.1, body, 0.3);
  g.sphere([0, 3.4, 2.3], 0.55, 0.75, 0.45, 12, 6, core);
  // ---------------- head (bone 1)
  g.bone = B.head;
  g.box(0, 5.55, -0.55, 1.35, 0.8, 1.6, panelHi, 0.35, body);
  g.box(0, 5.55, -1.36, 0.95, 0.16, 0.06, eye);
  g.box(0, 6.05, -0.3, 0.12, 0.35, 1.3, body, 0.2); // crest

  // ---------------- arms
  g.mirrorX((side) => {
    g.bone = side > 0 ? B.uarmR : B.uarmL;
    limb(g, [3.0 * sw, 4.3, 0.0], [3.15 * sw, 2.4, 0.2], 0.95, 1.05, body, 0.3, panel);
    g.bone = side > 0 ? B.farmR : B.farmL;
    g.box(3.15 * sw, 2.2, -0.95, 1.15, 1.15, 3.0, panel, 0.3, body);
    g.push(new THREE.Matrix4().makeTranslation(3.15 * sw, 2.05, 0).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2)));
    g.cylinder(6, 0.24, 0.2, 2.4, 3.3, body, undefined, red(1.2));
    g.pop();
  });

  // ---------------- legs (digitigrade)
  const hip = (s: number): V => [1.4 * s, -0.3, 0.1];
  const knee = (s: number): V => [1.55 * s, -0.3 - 3.5 * ls, -1.1 * ls];
  const ankle = (s: number): V => [1.55 * s, -0.3 - 6.9 * ls, 0.8 * ls];
  g.mirrorX((side) => {
    const s = 1;
    g.bone = side > 0 ? B.thighR : B.thighL;
    limb(g, hip(s), knee(s), 1.0, 1.15, body, 0.3, panel);
    limb(g, [1.75, -0.8, 0.0], [1.8, -2.9 * ls, -0.8 * ls], 0.3, 0.9, panel, 0.3); // outer thigh plate
    g.bone = side > 0 ? B.shinR : B.shinL;
    const k = knee(s);
    g.box(k[0], k[1], k[2], 1.0, 0.95, 1.15, panelHi, 0.35, body);
    if (rng.next() < 0.4 + L.markerDensity * 0.6) g.box(k[0], k[1] + 0.1, k[2] - 0.6, 0.4, 0.12, 0.06, red());
    limb(g, knee(s), ankle(s), 0.8, 0.9, body, 0.3, panel);
    limb(g, [k[0], k[1] - 0.6, k[2] + 0.55], [1.55, ankle(s)[1] + 0.9, ankle(s)[2] + 0.45], 0.55, 0.3, panel, 0.3); // calf plate
    g.bone = side > 0 ? B.footR : B.footL;
    const a = ankle(s);
    g.box(a[0], a[1], a[2], 0.9, 0.7, 0.9, panel, 0.35);
    for (const tx of [-0.38, 0.38]) limb(g, [a[0] + tx * 0.5, a[1] - 0.2, a[2] - 0.2], [a[0] + tx, a[1] - 1.45 * ls, a[2] - 1.35 * ls], 0.3, 0.42, body, 0.25);
    limb(g, [a[0], a[1] - 0.1, a[2] + 0.3], [a[0], a[1] - 1.0 * ls, a[2] + 1.05 * ls], 0.26, 0.36, body, 0.25); // spur
  });

  // ---------------- shutters (bones 12/13) over the core
  g.mirrorX((side) => {
    g.bone = side > 0 ? B.shutR : B.shutL;
    g.box(0.42, 3.4, 2.78, 0.84, 1.9, 0.16, panelHi, 0.3, body);
    g.box(0.12, 3.4, 2.87, 0.08, 1.5, 0.04, red(1.0));
  });
  g.pop();

  // flames from the jet pods (root space, rest pose)
  const fl: THREE.BufferGeometry[] = [];
  for (const sx of [1, -1]) {
    const f = flameGeometry(0.5 * S * jp, 3.6 * S);
    f.rotateX(-0.18);
    f.translate(1.28 * sx * S, 1.25 * S, 1.95 * S);
    fl.push(f);
  }
  return {
    geo: g.build(true),
    flame: mergeSimple(fl),
    S,
    pivots: {
      head: new THREE.Vector3(0, 5.1, -0.4).multiplyScalar(S),
      shoulder: [new THREE.Vector3(3.0 * sw, 4.3, 0).multiplyScalar(S), new THREE.Vector3(-3.0 * sw, 4.3, 0).multiplyScalar(S)],
      elbow: [new THREE.Vector3(3.15 * sw, 2.3, 0.2).multiplyScalar(S), new THREE.Vector3(-3.15 * sw, 2.3, 0.2).multiplyScalar(S)],
      hip: [new THREE.Vector3(...hip(1)).multiplyScalar(S), new THREE.Vector3(...hip(1)).multiplyScalar(S).setX(-1.4 * S)],
      knee: [new THREE.Vector3(...knee(1)).multiplyScalar(S), new THREE.Vector3(...knee(1)).multiplyScalar(S).setX(-1.55 * S)],
      ankle: [new THREE.Vector3(...ankle(1)).multiplyScalar(S), new THREE.Vector3(...ankle(1)).multiplyScalar(S).setX(-1.55 * S)],
      core: new THREE.Vector3(0, 3.4, 2.75).multiplyScalar(S),
      muzzle: [new THREE.Vector3(3.15 * sw, 2.05, -3.35).multiplyScalar(S), new THREE.Vector3(-3.15 * sw, 2.05, -3.35).multiplyScalar(S)],
    },
  };
}

interface Spring { a: number; v: number }

export function buildStrider(params: StriderParams = ENEMY_VARIANTS.A.strider, seed = 1): StriderBuild {
  const G = striderGeometry(params, seed);
  const mp = createEnemyMaterial({ look: params.look, bones: BONES, seamSpacing: 1.2 });
  const root = new THREE.Group();
  root.name = 'strider';
  for (const m of enemyMesh(G.geo, mp)) root.add(m);
  const fm = createFlameMaterial(false, params.look.thrusterIntensity / 2);
  const flame = new THREE.Mesh(G.flame, fm);
  flame.matrixAutoUpdate = false;
  flame.renderOrder = 2;
  root.add(flame);

  const bones = mp.bones!;
  const P = G.pivots;
  const S = G.S;
  const legs = [0, 1].map(() => ({ hipP: { a: 0, v: 0 } as Spring, hipR: { a: 0, v: 0 } as Spring, knee: { a: 0, v: 0 } as Spring, ankle: { a: 0, v: 0 } as Spring }));
  const weak: Spring = { a: 0, v: 0 };
  const phase = new Rng(seed).fork('strider-phase').range(0, 6.28);
  // pooled temporaries (no per-frame allocation)
  const M0 = new THREE.Matrix4(), T = new THREE.Matrix4(), Rm = new THREE.Matrix4(), E = new THREE.Euler();
  const wp = new THREE.Vector3(), prevWp = new THREE.Vector3(), vel = new THREE.Vector3(), prevVel = new THREE.Vector3(), acc = new THREE.Vector3();
  const invQ = new THREE.Quaternion();
  let first = true;
  const weakPointLocal = new THREE.Vector3();
  const muzzlesLocal = [new THREE.Vector3(), new THREE.Vector3()];

  /** out = parent * T(p) * R(euler) * T(-p) */
  const about = (out: THREE.Matrix4, parent: THREE.Matrix4, p: THREE.Vector3, rx: number, ry: number, rz: number) => {
    E.set(rx, ry, rz, 'XYZ');
    Rm.makeRotationFromEuler(E);
    T.makeTranslation(p.x, p.y, p.z);
    out.copy(parent).multiply(T).multiply(Rm);
    T.makeTranslation(-p.x, -p.y, -p.z);
    out.multiply(T);
  };
  const step = (s: Spring, target: number, force: number, h: number) => {
    const k = params.springK, c = params.damping;
    s.v += (-(s.a - target) * k - s.v * c + force) * h;
    s.a += s.v * h;
  };

  const api: StriderBuild = {
    root,
    weakPointLocal,
    muzzlesLocal,
    triangles: G.geo.attributes.position.count / 3,
    update(dt, st) {
      const t = st.time + phase;
      const h = Math.min(Math.max(dt, 0), 1 / 20);
      // hover bob (analytic acceleration feeds the leg springs)
      const w = 1.6;
      const bobA = 0.32 * S;
      const yb = bobA * Math.sin(w * t);
      const ay = -bobA * w * w * Math.sin(w * t);
      const pitch = 0.045 * Math.sin(w * t + 0.8), roll = 0.035 * Math.sin(0.9 * t);
      // world motion of the root (the integrator moves it): acceleration in root space
      root.getWorldPosition(wp);
      if (first || h <= 0) { prevWp.copy(wp); vel.set(0, 0, 0); prevVel.set(0, 0, 0); first = false; }
      vel.copy(wp).sub(prevWp).divideScalar(Math.max(h, 1e-4));
      acc.copy(vel).sub(prevVel).divideScalar(Math.max(h, 1e-4)).clampLength(0, 60);
      prevWp.copy(wp); prevVel.copy(vel);
      root.getWorldQuaternion(invQ).invert();
      acc.applyQuaternion(invQ).multiplyScalar(1 / Math.max(S, 0.1));
      // body
      E.set(pitch, 0, roll, 'XYZ');
      M0.makeRotationFromEuler(E).setPosition(0, yb, 0);
      bones[0].copy(M0);
      about(bones[1], M0, P.head, 0.05 * Math.sin(0.7 * t), 0.18 * Math.sin(0.45 * t), 0);
      // arms: slight counter-sway, guns roughly level
      for (let i = 0; i < 2; i++) {
        const sd = i === 0 ? 1 : -1;
        about(bones[2 + i], M0, P.shoulder[i], -0.06 * Math.sin(w * t + 1.3) - pitch, 0, sd * 0.04 * Math.sin(0.9 * t + i));
        about(bones[4 + i], bones[2 + i], P.elbow[i], 0.05 * Math.sin(w * t + 2.0 + i), 0, 0);
        muzzlesLocal[i].copy(P.muzzle[i]).applyMatrix4(bones[4 + i]);
      }
      // legs: damped springs driven by bob + world acceleration + idle sway
      const amp = params.swayAmp;
      const n = Math.max(1, Math.ceil(h / (1 / 120)));
      const hh = h / n;
      for (let i = 0; i < 2; i++) {
        const lg = legs[i];
        const ph = i * 1.9;
        for (let k = 0; k < n; k++) {
          step(lg.hipP, 0.07 * amp * Math.sin(1.1 * t + ph) - pitch, (acc.z * 0.12 - ay * 0.1) * amp, hh);
          step(lg.hipR, (i === 0 ? 0.04 : -0.04) + 0.03 * amp * Math.sin(0.8 * t + ph), (-acc.x * 0.1 - roll * 8) * amp, hh);
          step(lg.knee, 0.1 * amp * Math.sin(1.3 * t + ph + 0.6), (ay * 0.28 - acc.y * 0.1) * amp, hh);
          step(lg.ankle, 0.12 * amp * Math.sin(1.5 * t + ph + 1.1), -lg.knee.v * 1.4 * amp, hh);
        }
        about(bones[6 + i], M0, P.hip[i], lg.hipP.a, 0, lg.hipR.a);
        about(bones[8 + i], bones[6 + i], P.knee[i], lg.knee.a, 0, 0);
        about(bones[10 + i], bones[8 + i], P.ankle[i], lg.ankle.a, 0, 0);
      }
      // weak point shutters
      const open = st.weakPointOpen === true ? 1 : st.weakPointOpen === false || st.weakPointOpen === undefined ? 0 : st.weakPointOpen;
      step(weak, open, 0, h);
      const o = Math.max(0, Math.min(1.15, weak.a));
      for (let i = 0; i < 2; i++) {
        bones[12 + i].copy(M0);
        T.makeTranslation((i === 0 ? 1 : -1) * o * 0.8 * S, 0, 0);
        bones[12 + i].multiply(T);
      }
      mp.u.uChanB.value.y = 0.45 + 2.6 * o * (0.8 + 0.2 * Math.sin(st.time * 9));
      weakPointLocal.copy(P.core).applyMatrix4(M0);
      mp.u.uEnemyTime.value = st.time;
      mp.u.uHitFlash.value = st.hitFlash ?? 0;
      flame.matrix.copy(M0);
      fm.uniforms.uFlameTime.value = st.time;
      fm.uniforms.uFlameLen.value = 0.95 - ay / (w * w * bobA + 1e-6) * 0.12;
    },
  };
  api.update(0, { time: 0 });
  return api;
}
