/**
 * Wreckfield debris field: instanced asteroids (3 shapes), wreck slabs (plate,
 * beam truss, broken rib) and a dense fleck layer that streaks with speed.
 *
 * GPU-driven: every instance is placed, spun and recycled in the vertex shader
 * from per-instance attributes, so update() only writes uniforms (no per-frame
 * CPU work or allocation). Recycling is stateless: world z of an instance is
 *   camZ + back - mod(camZ + back - z0, depth)
 * so the field repeats seamlessly along -Z for any distance travelled. Big
 * pieces keep fixed world x/y outside a clear corridor around x=0,y=0; flecks
 * also wrap in x/y around the camera. Pieces shrink in at the far end (no pop).
 *
 * Draw calls: 3 asteroid + 3 slab + 1 fleck = 7.
 */
import * as THREE from 'three';
import { palette, shading } from '../../../style/tokens';
import { mix, shade, tvec } from '../../../style/color';
import { GLSL_LIGHTING, lightUniforms } from '../../common/lighting';
import { Rng } from '../../../core/rng';
import { GLSL_NOISE } from './glslNoise';
import { ASTEROID_SHAPES, asteroidGeometry, beamGeometry, fleckGeometry, plateGeometry, ribGeometry } from './debrisGeometry';

export interface DebrisParams {
  /** clear half-size (m) of the action corridor around x=0,y=0 for big pieces */
  corridor: number;
  /** 0..1: big pieces favour left/right over top/bottom */
  sideBias: number;
  /** vertical squash of the big-piece ring (frame is wider than tall) */
  verticalSquash: number;
  // flecks
  fleckCount: number;
  fleckSize: [number, number];
  /** near fleck box around the camera [x, y, depth] and how far behind the camera it reaches */
  fleckBox: [number, number, number];
  fleckBack: number;
  /** fraction of flecks in a larger, sparser far box */
  fleckFarFraction: number;
  fleckFarBox: [number, number, number];
  fleckFarSize: [number, number];
  fleckLightFraction: number;
  fleckSpin: number;
  /** streak stretch per m/s of camera speed, and its cap */
  streak: number;
  streakMax: number;
  // slabs
  slabCount: number;
  slabSize: [number, number];
  slabRadial: [number, number];
  slabDepth: number;
  slabLightPanels: number;
  // asteroids
  asteroidCount: number;
  asteroidSize: [number, number];
  asteroidRadial: [number, number];
  asteroidDepth: number;
  giantCount: number;
  giantSize: [number, number];
  giantRadial: [number, number];
  giantDepth: number;
  /** spin speed scale for big pieces (rad/s) */
  spin: number;
  /** distance colour shift toward the far colour [start, end] metres and amount */
  farShift: [number, number];
  farMix: number;
  rimBoost: number;
  /** assumed camera velocity when update() has no history (m/s, world) */
  defaultVelocity: [number, number, number];
}

export const DEBRIS_DEFAULTS: DebrisParams = {
  corridor: 20,
  sideBias: 0.65,
  verticalSquash: 0.75,
  fleckCount: 4200,
  fleckSize: [0.07, 0.5],
  fleckBox: [120, 70, 230],
  fleckBack: 12,
  fleckFarFraction: 0.3,
  fleckFarBox: [420, 240, 650],
  fleckFarSize: [0.6, 2.2],
  fleckLightFraction: 0.32,
  fleckSpin: 1.6,
  streak: 0.022,
  streakMax: 1.6,
  slabCount: 60,
  slabSize: [5, 22],
  slabRadial: [24, 150],
  slabDepth: 650,
  slabLightPanels: 0.14,
  asteroidCount: 72,
  asteroidSize: [3, 34],
  asteroidRadial: [28, 330],
  asteroidDepth: 950,
  giantCount: 6,
  giantSize: [70, 140],
  giantRadial: [260, 480],
  giantDepth: 1300,
  spin: 0.12,
  farShift: [60, 900],
  farMix: 0.82,
  rimBoost: 1.7,
  defaultVelocity: [0, 0, -45],
};

export interface DebrisField {
  group: THREE.Group;
  update(cameraPos: THREE.Vector3, time: number): void;
  /** CPU mirror of the shader placement (board labels / debug, allocates) */
  debugInstances(kind: 'asteroid' | 'slab' | 'fleck'): { center: THREE.Vector3; radius: number }[];
  dispose(): void;
  stats: { triangles: number; drawCalls: number; instances: { asteroids: number; slabs: number; flecks: number } };
}

const DEBRIS_VERT = /* glsl */ `
attribute vec4 iPosScale;  // anchor xyz, uniform scale
attribute vec4 iAxisSpin;  // axis xyz, spin rad/s
attribute vec4 iMisc;      // phase, stretch x, stretch y, variation
attribute vec4 iBox;       // WRAP_XYZ: box x, box y, depth, back  | else: depth, back, fadeLen, 0
uniform vec3 uField;       // camera position in field space
uniform float uTimeD;
uniform vec3 uVel;
uniform float uStreak;
uniform float uStreakMax;
uniform float uDrift;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying float vVar;
mat3 rotAxis(vec3 a, float ang) {
  float s = sin(ang), c = cos(ang), oc = 1.0 - c;
  return mat3(oc * a.x * a.x + c, oc * a.x * a.y + a.z * s, oc * a.z * a.x - a.y * s,
              oc * a.x * a.y - a.z * s, oc * a.y * a.y + c, oc * a.y * a.z + a.x * s,
              oc * a.z * a.x + a.y * s, oc * a.y * a.z - a.x * s, oc * a.z * a.z + c);
}
void main() {
  vUv = uv;
  vVar = iMisc.w;
  vec3 axis = normalize(iAxisSpin.xyz);
  mat3 R = rotAxis(axis, iMisc.x + iAxisSpin.w * uTimeD);
  vec3 st = vec3(iMisc.y, iMisc.z, 1.0);
  vec3 o = R * (position * st * iPosScale.w);
  vec3 nn = R * (normal / st);
  vec3 c;
  float fade = 1.0;
  #ifdef WRAP_XYZ
    vec3 a = iPosScale.xyz + axis * uDrift * (iMisc.w - 0.5) * uTimeD;
    c.x = uField.x + mod(a.x - uField.x, iBox.x) - 0.5 * iBox.x;
    c.y = uField.y + mod(a.y - uField.y, iBox.y) - 0.5 * iBox.y;
    float relz = iBox.w - mod(uField.z + iBox.w - a.z, iBox.z);
    c.z = uField.z + relz;
    fade *= smoothstep(iBox.w - iBox.z, iBox.w - iBox.z * 0.8, relz);
    fade *= 1.0 - smoothstep(0.4, 0.5, abs(c.x - uField.x) / iBox.x);
    fade *= 1.0 - smoothstep(0.4, 0.5, abs(c.y - uField.y) / iBox.y);
  #else
    c.xy = iPosScale.xy;
    float relz = iBox.y - mod(uField.z + iBox.y - iPosScale.z, iBox.x);
    c.z = uField.z + relz;
    fade *= smoothstep(iBox.y - iBox.x, iBox.y - iBox.x + iBox.z, relz);
  #endif
  // never let a piece swallow the camera
  vec3 wc = (modelMatrix * vec4(c, 1.0)).xyz;
  fade *= smoothstep(1.2, 4.0, length(wc - cameraPosition) - iPosScale.w);
  o *= fade;
  #ifdef STREAK
    float sp = length(uVel);
    if (sp > 0.01) {
      vec3 vd = uVel / sp;
      o += vd * dot(o, vd) * min(sp * uStreak, uStreakMax);
    }
  #endif
  vec4 wp = modelMatrix * vec4(c + o, 1.0);
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * nn);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const DEBRIS_FRAG = /* glsl */ `
${GLSL_LIGHTING}
${GLSL_NOISE}
uniform vec3 uAlbedoA;
uniform vec3 uAlbedoB;
uniform vec3 uPanelLight;
uniform float uLightPanels;
uniform float uSeamDark;
uniform vec3 uFarColor;
uniform vec2 uFarRange;
uniform float uFarMix;
uniform float uRimMul;
uniform float uSpecPow;
uniform float uSpecStr;
uniform vec3 uGlint;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying float vVar;
void main() {
  vec3 n = normalize(vWorldNormal);
  #ifdef DOUBLE_SIDED
  n = gl_FrontFacing ? n : -n;
  #endif
  vec3 v = normalize(cameraPosition - vWorldPos);
  vec3 albedo = mix(uAlbedoA, uAlbedoB, vVar);
  #ifdef PANELS
    vec2 q = vUv * vec2(6.0, 9.0);
    q.x += step(1.0, mod(floor(q.y), 2.0)) * 0.5;
    vec2 cell = floor(q);
    vec2 f = fract(q);
    float h = wfHash2(cell + floor(vVar * 97.0));
    albedo *= 0.82 + 0.36 * h;
    albedo = mix(albedo, uPanelLight, step(1.0 - uLightPanels, fract(h * 7.31)) * 0.85);
    vec2 fw = fwidth(q);
    vec2 e = smoothstep(vec2(0.035), vec2(0.035) + fw * 1.5, f) * smoothstep(vec2(0.035), vec2(0.035) + fw * 1.5, 1.0 - f);
    float vis = 1.0 - smoothstep(0.2, 0.45, max(fw.x, fw.y));
    albedo *= 1.0 - (1.0 - e.x * e.y) * uSeamDark * vis;
  #endif
  vec3 c = shadeToon(albedo, n);
  c += rimTerm(n, v) * uRimMul;
  // toon glint toward the planet (key) light
  vec3 hv = normalize(normalize(uKeyDir) + v);
  float sp = pow(max(dot(n, hv), 0.0), uSpecPow);
  c += uKeyColor * uGlint * smoothstep(0.45, 0.55, sp) * uSpecStr;
  // depth: colour shift toward the far field
  float dist = length(vWorldPos - cameraPosition);
  c = mix(c, uFarColor, smoothstep(uFarRange.x, uFarRange.y, dist) * uFarMix);
  c = applyFog(c, vWorldPos);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

interface Layer {
  geo: THREE.BufferGeometry;
  count: number;
  a: { pos: Float32Array; axis: Float32Array; misc: Float32Array; box: Float32Array };
  radius: number;
}

function makeMaterial(defines: Record<string, string>, u: Record<string, THREE.IUniform>, side: THREE.Side) {
  return new THREE.ShaderMaterial({
    uniforms: { ...lightUniforms, ...u },
    defines,
    vertexShader: DEBRIS_VERT,
    fragmentShader: DEBRIS_FRAG,
    side,
  });
}

/** Build the debris field. Pure function of (params, seed). */
export function buildDebrisField(params: Partial<DebrisParams> = {}, seed = 1): DebrisField {
  const p: DebrisParams = { ...DEBRIS_DEFAULTS, ...params };
  const root = new Rng(seed).fork('debris');
  const group = new THREE.Group();
  group.name = 'debrisField';

  // shared per-field uniforms (same objects in every material)
  const field = { value: new THREE.Vector3() };
  const timeU = { value: 0 };
  const velU = { value: new THREE.Vector3(...p.defaultVelocity) };
  const farColor = tvec(mix(palette.spaceDeep, palette.spaceNebula, 0.4));
  const common = {
    uField: field,
    uTimeD: timeU,
    uVel: velU,
    uStreak: { value: p.streak },
    uStreakMax: { value: p.streakMax },
    uDrift: { value: 0.6 },
    uFarColor: { value: farColor },
    uFarRange: { value: new THREE.Vector2(p.farShift[0], p.farShift[1]) },
    uFarMix: { value: p.farMix },
    uSpecPow: { value: shading.specular.power },
    uGlint: { value: tvec(mix(palette.debrisRim, palette.sunCore, 0.4)) },
    uSeamDark: { value: shading.seamDarkness },
  };

  const asteroidMat = makeMaterial({}, {
    ...common,
    uAlbedoA: { value: tvec(mix(palette.debrisDark, palette.debrisRim, 0.1)) },
    uAlbedoB: { value: tvec(mix(palette.debrisDark, palette.armourSteel, 0.4)) },
    uPanelLight: { value: tvec(palette.armourSteel) },
    uLightPanels: { value: 0 },
    uRimMul: { value: p.rimBoost },
    uSpecStr: { value: 0.12 },
  }, THREE.FrontSide);
  const slabMat = makeMaterial({ PANELS: '' }, {
    ...common,
    uAlbedoA: { value: tvec(mix(palette.debrisDark, palette.armourSteel, 0.35)) },
    uAlbedoB: { value: tvec(mix(palette.armourDark, palette.armourSteel, 0.55)) },
    uPanelLight: { value: tvec(mix(palette.armourSteel, palette.armourLight, 0.55)) },
    uLightPanels: { value: p.slabLightPanels },
    uRimMul: { value: p.rimBoost * 0.8 },
    uSpecStr: { value: shading.specular.strength },
  }, THREE.DoubleSide);
  const fleckMat = makeMaterial({ WRAP_XYZ: '', STREAK: '', DOUBLE_SIDED: '' }, {
    ...common,
    uAlbedoA: { value: tvec(shade(palette.debrisDark, 1.2)) },
    uAlbedoB: { value: tvec(mix(palette.armourLight, palette.smokeLit, 0.4)) },
    uPanelLight: { value: tvec(palette.armourLight) },
    uLightPanels: { value: 0 },
    uRimMul: { value: 1.2 },
    uSpecStr: { value: 0.9 },
  }, THREE.DoubleSide);

  const layers: { kind: 'asteroid' | 'slab' | 'fleck'; layer: Layer; mesh: THREE.Mesh }[] = [];

  const alloc = (n: number) => ({ pos: new Float32Array(n * 4), axis: new Float32Array(n * 4), misc: new Float32Array(n * 4), box: new Float32Array(n * 4) });

  /** place a big piece outside the corridor; returns [x, y] */
  const placeRing = (rng: Rng, rMin: number, rMax: number, radius: number): [number, number] => {
    let ang: number;
    if (rng.chance(p.sideBias)) ang = (rng.chance(0.5) ? 0 : Math.PI) + rng.gauss(1.3);
    else ang = rng.next() * Math.PI * 2;
    const rho = rMin + (rMax - rMin) * Math.pow(rng.next(), 1.5);
    let x = Math.cos(ang) * rho;
    let y = Math.sin(ang) * rho * p.verticalSquash;
    const lim = p.corridor + radius;
    if (Math.abs(x) < lim && Math.abs(y) < lim) {
      if (Math.abs(x) / lim > Math.abs(y) / lim) x = Math.sign(x || 1) * (lim + rng.next() * 6);
      else y = Math.sign(y || 1) * (lim + rng.next() * 6);
    }
    return [x, y];
  };

  const bigLayer = (rng: Rng, geo: THREE.BufferGeometry, n: number, size: [number, number], radial: [number, number], depth: number, stretchRange: [number, number], giant?: { n: number; size: [number, number]; radial: [number, number]; depth: number }): Layer => {
    const total = n + (giant?.n ?? 0);
    const a = alloc(total);
    const gr = geo.boundingSphere?.radius ?? 1;
    for (let i = 0; i < total; i++) {
      const isGiant = i >= n;
      const sz = isGiant ? giant!.size : size;
      const dep = isGiant ? giant!.depth : depth;
      const rad = isGiant ? giant!.radial : radial;
      const s = sz[0] * Math.pow(sz[1] / sz[0], Math.pow(rng.next(), 1.7));
      const sx = rng.range(stretchRange[0], stretchRange[1]);
      const sy = rng.range(stretchRange[0], stretchRange[1]);
      const worldR = s * gr * Math.max(sx, sy, 1);
      const [x, y] = placeRing(rng, rad[0] + (isGiant ? 0 : worldR * 0.5), rad[1], worldR);
      const k = i * 4;
      a.pos[k] = x; a.pos[k + 1] = y; a.pos[k + 2] = -rng.next() * dep; a.pos[k + 3] = s;
      const ax = new THREE.Vector3(rng.signed(), rng.signed(), rng.signed()).normalize();
      a.axis[k] = ax.x; a.axis[k + 1] = ax.y; a.axis[k + 2] = ax.z;
      a.axis[k + 3] = p.spin * rng.range(0.15, 1.0) * (rng.chance(0.5) ? 1 : -1) / Math.max(1, Math.sqrt(s / 6));
      a.misc[k] = rng.next() * Math.PI * 2; a.misc[k + 1] = sx; a.misc[k + 2] = sy; a.misc[k + 3] = rng.next();
      const back = 30 + worldR;
      a.box[k] = dep; a.box[k + 1] = back; a.box[k + 2] = Math.min(dep * 0.2, 160); a.box[k + 3] = 0;
    }
    return { geo, count: total, a, radius: gr };
  };

  const addLayer = (kind: 'asteroid' | 'slab' | 'fleck', layer: Layer, mat: THREE.ShaderMaterial, name: string) => {
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = layer.geo.index;
    for (const k of ['position', 'normal', 'uv']) ig.setAttribute(k, layer.geo.getAttribute(k));
    ig.setAttribute('iPosScale', new THREE.InstancedBufferAttribute(layer.a.pos, 4));
    ig.setAttribute('iAxisSpin', new THREE.InstancedBufferAttribute(layer.a.axis, 4));
    ig.setAttribute('iMisc', new THREE.InstancedBufferAttribute(layer.a.misc, 4));
    ig.setAttribute('iBox', new THREE.InstancedBufferAttribute(layer.a.box, 4));
    ig.instanceCount = layer.count;
    const mesh = new THREE.Mesh(ig, mat);
    mesh.name = name;
    mesh.frustumCulled = false;
    group.add(mesh);
    layers.push({ kind, layer, mesh });
  };

  // --- asteroids: 3 shapes; giants go to the two detail-2 shapes ---
  const ar = root.fork('asteroids');
  const split = [0.36, 0.3, 0.34];
  ASTEROID_SHAPES.forEach((shape, i) => {
    const geo = asteroidGeometry(shape, (seed * 31 + i * 977) >>> 0);
    const n = Math.round(p.asteroidCount * split[i]);
    const giants = i < 2 ? Math.round(p.giantCount * (i === 0 ? 0.5 : 0.5)) : 0;
    const layer = bigLayer(ar.fork(`a${i}`), geo, n, p.asteroidSize, p.asteroidRadial, p.asteroidDepth, [0.8, 1.2], giants ? { n: giants, size: p.giantSize, radial: p.giantRadial, depth: p.giantDepth } : undefined);
    addLayer('asteroid', layer, asteroidMat, `asteroids${i}`);
  });

  // --- wreck slabs: plate / beam / rib ---
  const sr = root.fork('slabs');
  const slabGeos = [plateGeometry((seed * 7 + 1) >>> 0), beamGeometry((seed * 7 + 2) >>> 0), ribGeometry((seed * 7 + 3) >>> 0)];
  const slabSplit = [0.5, 0.25, 0.25];
  slabGeos.forEach((geo, i) => {
    const n = Math.round(p.slabCount * slabSplit[i]);
    const layer = bigLayer(sr.fork(`s${i}`), geo, n, p.slabSize, p.slabRadial, p.slabDepth, [0.85, 1.15]);
    addLayer('slab', layer, slabMat, ['slabPlates', 'slabBeams', 'slabRibs'][i]);
  });

  // --- flecks ---
  const fr = root.fork('flecks');
  const nF = Math.round(p.fleckCount);
  const fa = alloc(nF);
  for (let i = 0; i < nF; i++) {
    const far = i < nF * p.fleckFarFraction;
    const box = far ? p.fleckFarBox : p.fleckBox;
    const sz = far ? p.fleckFarSize : p.fleckSize;
    const k = i * 4;
    fa.pos[k] = rng01(fr) * box[0]; fa.pos[k + 1] = rng01(fr) * box[1]; fa.pos[k + 2] = -rng01(fr) * box[2];
    fa.pos[k + 3] = sz[0] * Math.pow(sz[1] / sz[0], Math.pow(fr.next(), 1.6));
    const ax = new THREE.Vector3(fr.signed(), fr.signed(), fr.signed()).normalize();
    fa.axis[k] = ax.x; fa.axis[k + 1] = ax.y; fa.axis[k + 2] = ax.z;
    fa.axis[k + 3] = p.fleckSpin * fr.range(0.2, 1.0) * (fr.chance(0.5) ? 1 : -1);
    fa.misc[k] = fr.next() * 6.283; fa.misc[k + 1] = fr.range(0.4, 1.3); fa.misc[k + 2] = fr.range(0.5, 1.0);
    fa.misc[k + 3] = fr.chance(p.fleckLightFraction) ? fr.range(0.55, 1.0) : fr.range(0.0, 0.3);
    fa.box[k] = box[0]; fa.box[k + 1] = box[1]; fa.box[k + 2] = box[2]; fa.box[k + 3] = far ? 30 : p.fleckBack;
  }
  addLayer('fleck', { geo: fleckGeometry(), count: nF, a: fa, radius: 0.6 }, fleckMat, 'flecks');

  // --- stats ---
  let triangles = 0;
  for (const l of layers) {
    const g = l.layer.geo;
    triangles += (g.index ? g.index.count / 3 : g.attributes.position.count / 3) * l.layer.count;
  }
  const count = (k: string) => layers.filter((l) => l.kind === k).reduce((s, l) => s + l.layer.count, 0);

  // --- update: uniforms only ---
  const local = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  let prevT = -1;
  const update = (cameraPos: THREE.Vector3, time: number) => {
    local.copy(cameraPos);
    group.updateWorldMatrix(true, false);
    group.worldToLocal(local);
    if (prevT >= 0) {
      const dt = time - prevT;
      if (dt > 1e-4 && dt < 0.5) {
        tmpV.subVectors(cameraPos, prev).multiplyScalar(1 / dt);
        if (tmpV.length() < 400) velU.value.lerp(tmpV, 0.25);
      }
    }
    prev.copy(cameraPos);
    prevT = time;
    field.value.copy(local);
    timeU.value = time;
  };

  const debugInstances = (kind: 'asteroid' | 'slab' | 'fleck') => {
    const out: { center: THREE.Vector3; radius: number }[] = [];
    const F = field.value;
    for (const l of layers) {
      if (l.kind !== kind) continue;
      const a = l.layer.a;
      for (let i = 0; i < l.layer.count; i++) {
        const k = i * 4;
        const s = a.pos[k + 3];
        let x = a.pos[k], y = a.pos[k + 1], z: number;
        if (kind === 'fleck') {
          const m = (v: number, b: number) => ((v % b) + b) % b;
          x = F.x + m(x - F.x, a.box[k]) - a.box[k] / 2;
          y = F.y + m(y - F.y, a.box[k + 1]) - a.box[k + 1] / 2;
          z = F.z + a.box[k + 3] - m(F.z + a.box[k + 3] - a.pos[k + 2], a.box[k + 2]);
        } else {
          const m = (v: number, b: number) => ((v % b) + b) % b;
          z = F.z + a.box[k + 1] - m(F.z + a.box[k + 1] - a.pos[k + 2], a.box[k]);
        }
        const c = group.localToWorld(new THREE.Vector3(x, y, z));
        out.push({ center: c, radius: s * l.layer.radius * Math.max(a.misc[k + 1], a.misc[k + 2], 1) });
      }
    }
    return out;
  };

  return {
    group,
    update,
    debugInstances,
    dispose() {
      for (const l of layers) {
        l.mesh.geometry.dispose();
        l.layer.geo.dispose();
      }
      asteroidMat.dispose();
      slabMat.dispose();
      fleckMat.dispose();
    },
    stats: { triangles, drawCalls: layers.length, instances: { asteroids: count('asteroid'), slabs: count('slab'), flecks: count('fleck') } },
  };
}

function rng01(r: Rng): number {
  return r.next();
}
