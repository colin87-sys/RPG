/**
 * BULWARK capital boss (P0 silhouette pass): ~220 m span flying fortress.
 * Armoured central hull with a stepped citadel and a red visor band on the prow,
 * broad swept wings with a stacked lower armour plate, downward talon blades at
 * the tips, four emitter pylons hanging under the wings (+ a chin emitter),
 * reactor weak points on the belly and the main engine core at the tail.
 * Rows of small glowing vents (bossVent) run along the wing undersides, the hull
 * flanks and the stern: one InstancedMesh with a travelling-wave glow.
 * Built to read from below and behind (underside/stern carry the light detail).
 * Draw calls: hull 1 (+1 outline) + vents 1 + engine plumes 1.
 * Local frame: nose = -Z, up = +Y, origin at hull centre.
 */
import * as THREE from 'three';
import { palette } from '../../../style/tokens';
import { mix, tvec } from '../../../style/color';
import { Rng } from '../../../core/rng';
import { GLSL_LIGHTING, GLSL_STD_VERTEX, lightUniforms } from '../../common/lighting';
import { CH, GeoBuilder, type MatSpec, type V } from './kit';
import { ENEMY_VARIANTS } from './variants';
import { mergeSimple } from './dart';
import { createEnemyMaterial, createFlameMaterial, enemyMesh, flameGeometry, type EnemyLook } from './material';

export interface BulwarkParams {
  span: number; // 220
  length: number; // hull length (150)
  sweep: number; // leading-edge sweep (rad)
  ventRows: number; // vent rows under each wing
  ventsPerRow: number;
  emitters: number; // under-wing emitter pylons (even number)
  look: EnemyLook;
}

export interface BulwarkState {
  time: number;
  phase?: number; // 1..3
  ventGlow?: number; // 0..1 master vent brightness
  hitFlash?: number;
  emitterCharge?: number; // 0..1 brightens the beam emitters (telegraph)
}

export interface BulwarkBuild {
  root: THREE.Group;
  update(dt: number, s: BulwarkState): void;
  beamEmittersLocal: THREE.Vector3[];
  weakPointsLocal: THREE.Vector3[];
  triangles: number;
  ventCount: number;
}

// ---------------------------------------------------------------- vent material
const VENT_VERT = /* glsl */ `
attribute vec2 aInst; // x = wave phase, y = row gain
varying vec2 vVent;
vec3 enemyPos;
vec3 enemyNrm;
#define position enemyPos
#define normal enemyNrm
#define main enemyStdMain
${GLSL_STD_VERTEX}
#undef main
#undef normal
#undef position
void main() {
  enemyPos = position;
  enemyNrm = normal;
  enemyStdMain();
  vVent = aInst;
}
`;
const VENT_FRAG = /* glsl */ `
${GLSL_LIGHTING}
uniform vec3 uVentCol;
uniform vec3 uVentHot;
uniform vec3 uFrame;
uniform float uGlow;
uniform float uRate;
uniform float uTimeV;
uniform float uHitFlash;
uniform float uSilhouette;
uniform vec3 uFlashColor;
uniform vec3 uSilColor;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying vec2 vVent;
void main() {
  if (uSilhouette > 0.5) { gl_FragColor = vec4(uSilColor, 1.0);
    #include <colorspace_fragment>
    return; }
  vec2 q = abs(vUv - 0.5) * 2.0;
  float slot = (1.0 - smoothstep(0.55, 0.85, q.x)) * (1.0 - smoothstep(0.35, 0.75, q.y));
  float wave = 0.5 + 0.5 * sin(uTimeV * uRate - vVent.x * 6.2831853);
  float g = uGlow * vVent.y * (0.3 + 0.7 * wave * wave);
  vec3 c = mix(uFrame, uVentCol * (0.6 + 1.6 * g), slot);
  c += uVentHot * slot * slot * g * 0.9;
  c = applyFog(c, vWorldPos);
  c = mix(c, uFlashColor, uHitFlash);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

function ventMaterial(): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      ...lightUniforms,
      uVentCol: { value: tvec(palette.bossVent) },
      uVentHot: { value: tvec(palette.burstWhite) },
      uFrame: { value: tvec(palette.bossBody, 0.6) },
      uGlow: { value: 1 },
      uRate: { value: 3 },
      uTimeV: { value: 0 },
      uHitFlash: { value: 0 },
      uSilhouette: { value: 0 },
      uFlashColor: { value: tvec(palette.hitFlash) },
      uSilColor: { value: tvec(palette.hazardBlack) },
    },
    vertexShader: VENT_VERT,
    fragmentShader: VENT_FRAG,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // participates in setEnemySilhouette / setEnemyHitFlash (same uniform names)
  m.userData.enemy = m.uniforms;
  return m;
}

// ---------------------------------------------------------------- geometry
interface Vent { p: THREE.Vector3; n: THREE.Vector3; t: THREE.Vector3; w: number; h: number; phase: number; gain: number }

export function bulwarkGeometry(p: BulwarkParams, seed: number) {
  const rng = new Rng(seed).fork('bulwark');
  const L = p.look;
  const ks = p.length / 150; // hull scale
  const half = p.span / 2;
  const hullC: MatSpec = { albedo: palette.bossBody };
  const plate: MatSpec = { albedo: mix(palette.bossBody, palette.enemyPanel, L.panelContrast * 0.8) };
  const plateHi: MatSpec = { albedo: mix(palette.bossBody, palette.enemyPanel, Math.min(1, L.panelContrast * 1.1)) };
  const dark: MatSpec = { albedo: mix(palette.bossBody, palette.emblemBlack, 0.5) };
  const visor: MatSpec = { albedo: palette.bossBody, emit: palette.enemyMarker, emitStrength: 1.8, channel: CH.eye };
  const lens: MatSpec = { albedo: palette.bossBody, emit: palette.burstYellow, emitStrength: 1.0, channel: CH.charge };
  const core: MatSpec = { albedo: palette.bossBody, emit: palette.bossVent, emitStrength: 1.0, channel: CH.weak };
  const thr: MatSpec = { albedo: palette.armourDark, emit: palette.accentOrange, emitStrength: 1.0, channel: CH.thruster };
  const marker = (): MatSpec => ({ albedo: palette.bossBody, emit: palette.enemyMarker, emitStrength: 1.6, channel: CH.marker, phase: rng.next() });
  const g = new GeoBuilder();
  const vents: Vent[] = [];
  const addVent = (pp: V, n: V, t: V, w: number, h: number, phase: number, gain = 1) =>
    vents.push({ p: new THREE.Vector3(...pp), n: new THREE.Vector3(...n).normalize(), t: new THREE.Vector3(...t).normalize(), w, h, phase, gain });

  // ---- hull: loft nose -> tail, rings CCW in XY
  const secs: [number, number, number, number][] = [
    [-82, 3, 3, -2], [-70, 10, 7, -7], [-42, 17, 11, -12], [-5, 19, 13, -14], [38, 18, 12, -13], [68, 15, 10, -9],
  ];
  const ring = (z: number, w: number, t: number, b: number): V[] => [
    [0, b, z], [0.7 * w, 0.8 * b, z], [w, 0.25 * b, z], [0.9 * w, 0.45 * t, z], [0.45 * w, t, z],
    [-0.45 * w, t, z], [-0.9 * w, 0.45 * t, z], [-w, 0.25 * b, z], [-0.7 * w, 0.8 * b, z],
  ];
  const hullRings = secs.map(([z, w, t, b]) => ring(z * ks, w * ks, t * ks, b * ks));
  g.loft(hullRings, (r, s) => (s === 4 ? plateHi : s === 3 || s === 5 ? plate : r === 0 ? plate : hullC), hullC, dark);
  // prow visor band (red), across the front faces of the second section
  g.mirrorX(() => {
    const a = hullRings[1][3], b = hullRings[1][2];
    const z = -69 * ks;
    g.quad([0, (a[1] + b[1]) * 0.5 + 1.5 * ks, z - 0.4], [a[0] * 0.98, a[1] * 0.6, z - 0.4], [a[0] * 0.95, a[1] * 0.6 - 1.4 * ks, z - 0.4], [0, (a[1] + b[1]) * 0.5, z - 0.4], visor);
  });
  // citadel: stepped tower blocks on the spine
  g.box(0, 15 * ks, 5 * ks, 18 * ks, 8 * ks, 60 * ks, plate, 0.3, hullC);
  g.box(0, 21 * ks, 12 * ks, 11 * ks, 7 * ks, 34 * ks, plateHi, 0.3, hullC);
  g.box(0, 26 * ks, 16 * ks, 5 * ks, 5 * ks, 14 * ks, plate, 0.3, hullC);
  g.mirrorX(() => {
    g.cylinder(4, 1.2 * ks, 0.1, 28 * ks, 40 * ks, hullC, undefined, undefined, Math.PI / 4);
  });
  // belly keel + reactor weak points
  g.box(0, -14 * ks, 0, 8 * ks, 3 * ks, 90 * ks, plate, 0.3, hullC);
  const weak: THREE.Vector3[] = [];
  g.mirrorX((s) => {
    g.push(new THREE.Matrix4().makeTranslation(9 * ks, -12.4 * ks, 18 * ks));
    g.cylinder(10, 4.2 * ks, 3.6 * ks, 0.8 * ks, -0.2 * ks, dark, undefined, undefined); // housing (downward)
    g.pop();
    g.sphere([9 * ks, -12.6 * ks, 18 * ks], 3.0 * ks, 1.4 * ks, 3.0 * ks, 12, 6, core);
    weak.push(new THREE.Vector3(9 * ks * s, -13.8 * ks, 18 * ks));
  });

  // ---- wings: loft along +X, rings [leading, top, trailing, bottom]
  const tanS = Math.tan(p.sweep);
  const x0 = 16 * ks;
  const zl = (x: number) => -45 * ks + (x - x0) * tanS;
  const zt = (x: number) => 62 * ks - (x - x0) * 0.05;
  const yW = (x: number) => -((x - x0) / (half - x0)) * 7;
  const th = (x: number) => 9 * ks + ((x - x0) / (half - x0)) * (2.2 - 9 * ks);
  const wsec = (x: number): V[] => {
    const a = zl(x), b = zt(x), y = yW(x), t = th(x);
    return [[x, y, a], [x, y + t, a + (b - a) * 0.42], [x, y, b], [x, y - t * 0.55, a + (b - a) * 0.4]];
  };
  const stations = [x0, x0 + (half - x0) * 0.3, x0 + (half - x0) * 0.62, half];
  const emitters: THREE.Vector3[] = [];
  g.mirrorX((side) => {
    g.loft(stations.map(wsec), (r, s) => (s === 0 ? (r % 2 ? plate : plateHi) : s === 3 ? hullC : s === 1 ? hullC : dark), undefined, dark);
    // stacked lower armour plate (step faces rearward/down)
    const lx0 = x0 + 2, lx1 = x0 + (half - x0) * 0.7;
    const lsec = (x: number): V[] => {
      const a = zl(x) + 14 * ks, b = zt(x) - 10 * ks, y = yW(x) - th(x) * 0.55 - 1.2, t = 2.4 * ks;
      return [[x, y, a], [x, y + t, (a + b) / 2], [x, y, b], [x, y - t, (a + b) / 2]];
    };
    g.loft([lsec(lx0), lsec((lx0 + lx1) / 2), lsec(lx1)], (_r, s) => (s === 3 || s === 0 ? plate : hullC), undefined, hullC);
    // talon blades at the wing tips (loft along -Y): [leading, outer, trailing, inner]
    const tip = half, ty = yW(tip);
    const bl = (x: number, y: number, a: number, b: number, t: number): V[] => [[x, y, a], [x + t, y, (a + b) / 2], [x, y, b], [x - t, y, (a + b) / 2]];
    g.loft([bl(tip - 2, ty + 2, zl(tip) + 2, zt(tip), 1.6), bl(tip - 4, ty - 14, zl(tip) + 9, zt(tip) + 2, 1.1), bl(tip - 7, ty - 30, zl(tip) + 18, zt(tip) + 6, 0.2)],
      (_r, s) => (s === 1 ? plateHi : hullC), hullC);
    // root fins (front silhouette)
    const fx = x0 + 10;
    g.loft([bl(fx, yW(fx) + th(fx) * 0.8, zl(fx) + 30, zt(fx) - 8, 1.2).map(([x, y, z]) => [x, y, z] as V),
      bl(fx + 3, yW(fx) + th(fx) + 16, zl(fx) + 50, zt(fx) + 2, 0.2)].map((r) => r.map(([x, y, z]) => [x, y, z] as V)).map((r) => [r[0], r[3], r[2], r[1]]),
      (_r, s) => (s === 0 ? plateHi : hullC), hullC);
    // leading-edge marker lights
    for (let i = 0; i < 6; i++) {
      if (rng.next() > L.markerDensity) continue;
      const x = x0 + ((i + 0.5) / 6) * (half - x0);
      g.box(x, yW(x) + 0.3, zl(x) - 0.6, 2.2, 0.8, 0.8, marker());
    }
    // emitter pylons: hang from the wing underside, lens faces forward-down
    const np = Math.max(1, Math.floor(p.emitters / 2));
    for (let i = 0; i < np; i++) {
      const x = x0 + (half - x0) * (0.28 + 0.4 * (i / Math.max(1, np - 1)));
      const a = zl(x), b = zt(x), y = yW(x);
      const zc = a + (b - a) * 0.3;
      g.box(x, y - th(x) * 0.5 - 4, zc + 6, 4.5, 9, 22, hullC, 0.3, plate);
      g.push(new THREE.Matrix4().makeTranslation(x, y - th(x) * 0.5 - 9, zc).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2 + 0.2)));
      g.cylinder(10, 3.4, 3.8, -6, 6, plate, undefined, dark);
      g.cylinder(10, 3.4, 2.6, -6, -7.2, hullC, undefined, undefined);
      g.pop();
      // lens (smooth orb) at the pylon front
      const lp = new THREE.Vector3(x, y - th(x) * 0.5 - 9, zc).add(new THREE.Vector3(0, Math.sin(0.2) * 6.4, -Math.cos(0.2) * 6.4));
      g.sphere([lp.x, lp.y, lp.z], 2.3, 2.3, 1.2, 12, 6, lens);
      emitters.push(new THREE.Vector3(lp.x * side, lp.y, lp.z - 1.2));
    }
    // greebles on the wing underside (seeded)
    for (let i = 0; i < 26; i++) {
      const x = x0 + 6 + rng.next() * (half - x0 - 16);
      const a = zl(x), b = zt(x);
      const f = 0.55 + rng.next() * 0.35;
      const z = a + (b - a) * f;
      const y = yW(x) - th(x) * 0.55 * (1 - (f - 0.4) / 0.6) - 0.4;
      g.box(x, y, z, 2 + rng.next() * 6, 1.0, 3 + rng.next() * 8, rng.next() < 0.5 ? plate : hullC, 0.3);
    }
  });
  // chin emitter under the prow
  g.push(new THREE.Matrix4().makeTranslation(0, -11 * ks, -52 * ks).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2 + 0.25)));
  g.cylinder(10, 4.2 * ks, 4.6 * ks, -5 * ks, 6 * ks, plate, undefined, dark);
  g.pop();
  const chin = new THREE.Vector3(0, -11 * ks, -52 * ks).add(new THREE.Vector3(0, Math.sin(0.25) * 5.4 * ks, -Math.cos(0.25) * 5.4 * ks));
  g.sphere([chin.x, chin.y, chin.z], 3.0 * ks, 3.0 * ks, 1.4 * ks, 12, 6, lens);
  emitters.push(chin.clone().setZ(chin.z - 1.4 * ks));
  // stern: engine block with three nozzles
  const nozzles: THREE.Vector3[] = [];
  for (const nx of [-9, 0, 9]) {
    g.push(new THREE.Matrix4().makeTranslation(nx * ks, -1 * ks, 0).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)));
    g.cylinder(10, 5.2 * ks, 4.6 * ks, 64 * ks, 76 * ks, hullC, undefined, thr);
    g.pop();
    nozzles.push(new THREE.Vector3(nx * ks, -1 * ks, 76 * ks));
  }
  weak.push(new THREE.Vector3(0, -1 * ks, 76.5 * ks));
  const geo = g.build(false);

  // ---- vents (instanced quads)
  // (a) wing undersides: rows parallel to the leading edge on the forward bottom face
  for (const side of [1, -1]) {
    for (let r = 0; r < p.ventRows; r++) {
      const f = 0.06 + (r / Math.max(1, p.ventRows - 1)) * 0.3; // chord fraction on the front-bottom face (0..0.4)
      for (let c = 0; c < p.ventsPerRow; c++) {
        const x = x0 + 5 + ((c + 0.5) / p.ventsPerRow) * (half - x0 - 14);
        const a = zl(x), b = zt(x), t = th(x), y = yW(x);
        const bz = a + (b - a) * 0.4, by = y - t * 0.55;
        const z = a + (bz - a) * (f / 0.4), yy = y + (by - y) * (f / 0.4);
        // face normal: perpendicular to span (x) and to the chord line (0, by-y, bz-a)
        const cn = new THREE.Vector3(0, by - y, bz - a).normalize();
        const n = new THREE.Vector3(1, 0, 0).cross(cn).normalize(); // points down/forward
        if (n.y > 0) n.negate();
        addVent([(x) * side, yy + n.y * 0.25, z + n.z * 0.25], [0, n.y, n.z], [1, 0, 0], 2.4, 0.9, (c / p.ventsPerRow) * 2 + r * 0.13, 0.8 + 0.2 * (r % 2));
      }
    }
  }
  // (b) hull flanks: two rows each side on the lower flank faces
  for (const side of [1, -1]) {
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 22; c++) {
        const z = (-40 + (c / 21) * 100) * ks;
        // interpolate hull section at z (sections 2..4 roughly constant)
        const w = 18 * ks, b = -13 * ks;
        const pA = new THREE.Vector3(0.7 * w, 0.8 * b, z), pB = new THREE.Vector3(w, 0.25 * b, z);
        const tt = 0.3 + r * 0.4;
        const pp = pA.clone().lerp(pB, tt);
        const n = new THREE.Vector3(pB.y - pA.y, -(pB.x - pA.x), 0).normalize();
        addVent([pp.x * side + n.x * 0.3 * side, pp.y + n.y * 0.3, z], [n.x * side, n.y, 0], [0, 0, 1], 2.2, 0.8, c / 22 + r * 0.5, 1);
      }
    }
  }
  // (c) stern face: rows above and between the nozzles (read from behind)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 12; c++) {
      const x = (-13 + (c / 11) * 26) * ks;
      addVent([x, (5 + r * 2.2) * ks, 68.3 * ks], [0, 0, 1], [1, 0, 0], 1.7 * ks, 0.8 * ks, c / 12 + r * 0.33, 1);
    }
  }
  // (d) lower-plate trailing step faces (read from behind/below)
  for (const side of [1, -1]) {
    for (let c = 0; c < 18; c++) {
      const lx0 = x0 + 2, lx1 = x0 + (half - x0) * 0.7;
      const x = lx0 + ((c + 0.5) / 18) * (lx1 - lx0);
      const zb = zt(x) - 10 * ks, y = yW(x) - th(x) * 0.55 - 1.2;
      addVent([x * side, y - 0.9, zb - 3.4], [0, -1, 0.35], [1, 0, 0], 2.6, 1.0, c / 9, 1);
    }
  }

  // flames
  const fl: THREE.BufferGeometry[] = [];
  for (const nz of nozzles) {
    const f = flameGeometry(4.2 * ks, 30 * ks, 10);
    f.rotateX(-Math.PI / 2);
    f.translate(nz.x, nz.y, nz.z);
    fl.push(f);
  }
  return { geo, vents, flame: mergeSimple(fl), emitters, weak };
}

export function buildBulwark(params: BulwarkParams = ENEMY_VARIANTS.A.bulwark, seed = 1): BulwarkBuild {
  const G = bulwarkGeometry(params, seed);
  const mp = createEnemyMaterial({ look: params.look, seamSpacing: 6 });
  const root = new THREE.Group();
  root.name = 'bulwark';
  for (const m of enemyMesh(G.geo, mp)) root.add(m);
  // vents
  const quad = new THREE.PlaneGeometry(1, 1);
  const n = G.vents.length;
  const inst = new Float32Array(n * 2);
  const vm = ventMaterial();
  const vmesh = new THREE.InstancedMesh(quad, vm, n);
  const m4 = new THREE.Matrix4(), bx = new THREE.Vector3(), by = new THREE.Vector3();
  G.vents.forEach((v, i) => {
    // plane: local X = t (long axis), local Y = n x t, local Z = n
    by.crossVectors(v.n, v.t).normalize();
    bx.crossVectors(by, v.n).normalize();
    m4.makeBasis(bx.multiplyScalar(v.w), by.multiplyScalar(v.h), v.n.clone()).setPosition(v.p);
    vmesh.setMatrixAt(i, m4);
    inst[i * 2] = v.phase;
    inst[i * 2 + 1] = v.gain;
  });
  quad.setAttribute('aInst', new THREE.InstancedBufferAttribute(inst, 2));
  vmesh.frustumCulled = false;
  vmesh.name = 'bulwark-vents';
  root.add(vmesh);
  const fm = createFlameMaterial(false, params.look.thrusterIntensity / 2);
  const flame = new THREE.Mesh(G.flame, fm);
  flame.renderOrder = 2;
  root.add(flame);
  return {
    root,
    beamEmittersLocal: G.emitters,
    weakPointsLocal: G.weak,
    triangles: G.geo.attributes.position.count / 3 + n * 2 + G.flame.attributes.position.count / 3,
    ventCount: n,
    update(dt, s) {
      const ph = Math.max(1, Math.min(3, s.phase ?? 1));
      const vg = s.ventGlow ?? 1;
      vm.uniforms.uTimeV.value = s.time;
      vm.uniforms.uGlow.value = vg;
      vm.uniforms.uRate.value = 1.8 + ph * 1.1;
      vm.uniforms.uHitFlash.value = s.hitFlash ?? 0;
      mp.u.uEnemyTime.value = s.time;
      mp.u.uHitFlash.value = s.hitFlash ?? 0;
      mp.u.uChanA.value.w = 0.5 + 0.25 * ph + 3.5 * (s.emitterCharge ?? 0);
      mp.u.uChanB.value.y = 0.6 + 0.5 * Math.sin(s.time * (2 + ph)) * 0.5 + 0.3 * ph;
      fm.uniforms.uFlameTime.value = s.time;
    },
  };
}
