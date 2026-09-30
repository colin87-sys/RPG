/**
 * Cloudgate framing mass: one colossal curved, ribbed dark hull on one side of
 * the flight corridor, with an overhanging deck lip, belts, greebles, fins,
 * masts, small cool lights, and gate arches that span over the corridor.
 *
 * Built from a repeatable module (InstancedMesh, per-instance part masks for
 * variety, placed along a gentle plan-view bow) + unique pieces (prow cap,
 * stepped stern cap, arches) merged into one mesh + one Points set of lights.
 * Draw calls: 3. Group local frame: corridor axis = local -Z starting at z=0
 * (prow tip) and ending at z=-lengthMetres; hull on +X (side=1) or -X (side=-1).
 */
import * as THREE from 'three';
import { palette, shading } from '../../../style/tokens';
import { mix, tvec } from '../../../style/color';
import { GLSL_LIGHTING, lightUniforms } from '../../common/lighting';
import { Rng } from '../../../core/rng';
import { GeoBuilder, faceNormal, type V3 } from '../space/geomKit';
import { GLSL_NOISE } from '../space/glslNoise';

export interface HullParams {
  /** +1 = right of the corridor, -1 = left */
  side: 1 | -1;
  /** nearest hull surface distance from the corridor axis (m) */
  clearance: number;
  halfWidth: number;
  halfHeight: number;
  centerY: number;
  /** superellipse exponent of the cross-section: 2 = round, 4 = boxy */
  roundness: number;
  ribSpacing: number;
  ribDepth: number;
  modules: number;
  /** plan-view curvature: metres the ends recede from the corridor vs the middle */
  bow: number;
  /** an arch over the corridor every N modules (0 = none) */
  archEvery: number;
  archTop: number;
  lipY: number;
  lipOut: number;
  lightDensity: number;
  greebleDensity: number;
  /** 0 = armourDark, 1 = armourSteel */
  tone: number;
  capLength: number;
}

export const HULL_DEFAULTS: HullParams = {
  side: 1,
  clearance: 42,
  halfWidth: 58,
  halfHeight: 78,
  centerY: -18,
  roundness: 2.6,
  ribSpacing: 18,
  ribDepth: 2.8,
  modules: 10,
  bow: 18,
  archEvery: 4,
  archTop: 48,
  lipY: 36,
  lipOut: 9,
  lightDensity: 1,
  greebleDensity: 1,
  tone: 0.2,
  capLength: 60,
};

/** A = balanced; B = tight ribs, dense lights, strong bow; C = wide ribs, sparse lights, boxy + frequent arches. */
export const HULL_VARIANTS: Record<'A' | 'B' | 'C', HullParams> = {
  A: { ...HULL_DEFAULTS },
  B: { ...HULL_DEFAULTS, ribSpacing: 12, modules: 14, lightDensity: 1.9, bow: 40, roundness: 2.2, archEvery: 5, tone: 0.14 },
  C: { ...HULL_DEFAULTS, ribSpacing: 26, modules: 7, lightDensity: 0.5, bow: 5, roundness: 3.6, archEvery: 2, tone: 0.28 },
};

export interface HullMass {
  group: THREE.Group;
  update(time: number): void;
  lengthMetres: number;
  dispose(): void;
  stats: { triangles: number; drawCalls: number; lights: number; moduleTriangles: number; uniqueTriangles: number };
}

export interface HullBuildOptions {
  /** flat black material, lights hidden (silhouette test) */
  silhouette?: boolean;
}

const HULL_VERT = /* glsl */ `
attribute float aTone;
attribute float aPart;
#ifdef USE_INSTANCING
attribute vec4 iMask;
#endif
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying float vTone;
varying float vLocalY;
void main() {
  vUv = uv;
  vTone = aTone;
  vLocalY = position.y;
  vec4 p = vec4(position, 1.0);
  vec3 nrm = normal;
  #ifdef USE_INSTANCING
    float keep = 1.0;
    if (aPart > 0.5) keep = aPart < 1.5 ? iMask.x : (aPart < 2.5 ? iMask.y : (aPart < 3.5 ? iMask.z : iMask.w));
    p.xyz *= step(0.5, keep);
    p = instanceMatrix * p;
    nrm = mat3(instanceMatrix) * nrm;
  #endif
  vec4 wp = modelMatrix * p;
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * nrm);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const HULL_FRAG = /* glsl */ `
${GLSL_LIGHTING}
${GLSL_NOISE}
uniform vec3 uDark;
uniform vec3 uSteel;
uniform vec3 uLight;
uniform vec3 uSil;
uniform vec2 uPanel;
uniform float uSeamW;
uniform float uSeamDark;
uniform float uRimMul;
uniform float uSpecPow;
uniform float uSpecStr;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying float vTone;
varying float vLocalY;
void main() {
  #ifdef SILHOUETTE
    gl_FragColor = vec4(uSil, 1.0);
    #include <colorspace_fragment>
    return;
  #endif
  vec3 n = normalize(vWorldNormal);
  vec3 v = normalize(cameraPosition - vWorldPos);
  // staggered armour panels in metres
  vec2 q = vUv / uPanel;
  q.x += step(1.0, mod(floor(q.y), 2.0)) * 0.5;
  vec2 cell = floor(q);
  vec2 f = fract(q);
  float h = wfHash2(cell);
  float t = clamp(vTone + (h - 0.5) * 0.16, 0.0, 1.0);
  vec3 albedo = mix(uDark, uSteel, t);
  albedo = mix(albedo, uLight, step(0.985, h) * 0.18);
  // small detail: a darker inset strip on some panels
  albedo *= 1.0 - 0.12 * step(0.88, fract(h * 13.7)) * step(0.3, f.y) * step(f.y, 0.4);
  vec2 fw = fwidth(q);
  vec2 sw = vec2(uSeamW) / uPanel;
  vec2 e = smoothstep(sw, sw + fw * 1.5, f) * smoothstep(sw, sw + fw * 1.5, 1.0 - f);
  float vis = 1.0 - smoothstep(0.05, 0.16, max(fw.x, fw.y));
  albedo *= 1.0 - (1.0 - e.x * e.y) * uSeamDark * vis;
  // mass: darker toward the depths
  albedo *= mix(0.5, 1.0, smoothstep(-70.0, 25.0, vLocalY));
  vec3 c = shadeToon(albedo, n);
  c += rimTerm(n, v) * uRimMul;
  vec3 hv = normalize(normalize(uKeyDir) + v);
  float sp = pow(max(dot(n, hv), 0.0), uSpecPow);
  c += uKeyColor * smoothstep(0.5, 0.58, sp) * uSpecStr * albedo * 4.0;
  c = applyFog(c, vWorldPos);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

const LIGHT_VERT = /* glsl */ `
attribute float aSize;
attribute float aBlink;
attribute float aPhase;
attribute vec3 aColor;
uniform float uViewH;
uniform float uHullTime;
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform float uFogBaseHeight;
varying vec3 vColor;
varying float vSigma;
varying float vHalf;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;
  float px = aSize * projectionMatrix[1][1] * 0.5 * uViewH / max(-mv.z, 0.1);
  float sigma = clamp(px * 0.5, 0.7, 1.8);
  float energy = px * px;
  float peak = min(energy / (4.0 * sigma * sigma), 1.1);
  float blink = aBlink > 0.5 ? smoothstep(0.55, 0.6, fract(uHullTime * 0.7 + aPhase)) * (1.0 - smoothstep(0.85, 0.9, fract(uHullTime * 0.7 + aPhase))) * 2.2 : 1.0;
  float d = length(wp.xyz - cameraPosition);
  float fd = uFogDensity * d;
  float fog = 1.0 - exp(-fd * fd);
  float below = max(0.0, uFogBaseHeight - wp.y);
  fog = clamp(fog + (1.0 - exp(-below * uFogHeightFalloff)) * 0.8, 0.0, 1.0);
  vColor = aColor * peak * blink * (1.0 - fog);
  vSigma = sigma;
  vHalf = ceil(sigma * 3.0) + 1.0;
  gl_PointSize = vHalf * 2.0;
}
`;

const LIGHT_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vSigma;
varying float vHalf;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * 2.0 * vHalf;
  float g = exp(-0.5 * dot(q, q) / (vSigma * vSigma));
  if (g < 0.01) discard;
  gl_FragColor = vec4(vColor * g, 1.0);
  #include <colorspace_fragment>
}
`;

interface PP {
  x: number;
  y: number;
  nx: number;
  ny: number;
  s: number;
}

const sgnpow = (v: number, e: number) => Math.sign(v) * Math.pow(Math.abs(v), e);

function profile(p: HullParams, a0: number, a1: number, n: number, scale = 1, cxShift = 0): PP[] {
  const cx = p.clearance + p.halfWidth + cxShift, cy = p.centerY;
  const e = 2 / p.roundness;
  const pts: PP[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: cx + p.halfWidth * scale * sgnpow(Math.cos(a), e), y: cy + p.halfHeight * scale * sgnpow(Math.sin(a), e), nx: 0, ny: 0, s: 0 });
  }
  for (let i = 0; i <= n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    // traversal is counter-clockwise around the centre -> outward = (dy, -dx)
    pts[i].nx = dy / l;
    pts[i].ny = -dx / l;
    if (i > 0) pts[i].s = pts[i - 1].s + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return pts;
}

/** quad with winding forced so its face normal agrees with `want` */
function oq(gb: GeoBuilder, a: V3, b: V3, c: V3, d: V3, want: V3, uv: [number, number][], smooth?: [V3, V3, V3, V3]) {
  const fn = faceNormal(a, b, c);
  const ok = fn[0] * want[0] + fn[1] * want[1] + fn[2] * want[2] >= 0;
  if (ok) gb.quad(a, b, c, d, uv[0], uv[1], uv[2], uv[3], smooth?.[0], smooth?.[1], smooth?.[2], smooth?.[3]);
  else gb.quad(a, d, c, b, uv[0], uv[3], uv[2], uv[1], smooth?.[0], smooth?.[3], smooth?.[2], smooth?.[1]);
}

/** oriented box: centre, half extents along (r = radial normal, t = tangent, z) */
function obox(gb: GeoBuilder, c: V3, h: V3, r: V3, t: V3) {
  gb.box(c, h, r, t, [0, 0, 1]);
}

function nearestY(pts: PP[], y: number): PP {
  let best = pts[0];
  for (const p of pts) if (Math.abs(p.y - y) < Math.abs(best.y - y) && p.nx < 0.2) best = p;
  return best;
}

/** mirror a built geometry in x (for side = -1), keeping front faces outward */
function mirrorX(g: THREE.BufferGeometry) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const names = Object.keys(g.attributes);
  for (let i = 0; i < pos.count; i++) {
    pos.setX(i, -pos.getX(i));
    nrm.setX(i, -nrm.getX(i));
  }
  for (let t = 0; t < pos.count; t += 3) {
    for (const nm of names) {
      const a = g.attributes[nm] as THREE.BufferAttribute;
      for (let k = 0; k < a.itemSize; k++) {
        const x = a.getComponent(t + 1, k);
        a.setComponent(t + 1, k, a.getComponent(t + 2, k));
        a.setComponent(t + 2, k, x);
      }
    }
  }
  g.computeBoundingSphere();
  g.computeBoundingBox();
}

/** Build the hull mass. Pure function of (params, seed). */
export function buildHullMass(params: Partial<HullParams> = {}, seed = 1, opts: HullBuildOptions = {}): HullMass {
  const p: HullParams = { ...HULL_DEFAULTS, ...params };
  const rng = new Rng(seed).fork('hullMass');
  const M = p.ribSpacing * 2;
  const bodyLen = p.modules * M;
  const lengthMetres = p.capLength * 2 + bodyLen;
  const A0 = (78 * Math.PI) / 180, A1 = (262 * Math.PI) / 180;
  const prof = profile(p, A0, A1, 52);
  const lights: { p: V3; size: number; color: THREE.Vector3; blink: number }[] = [];
  const cCool = tvec(mix(palette.canopyBlue, palette.smokeLit, 0.72), 1.25);
  const cWin = tvec(mix(palette.smokeLit, palette.skyHorizon, 0.35), 1.0);
  const cBeacon = tvec(mix(palette.playerShotHalo, palette.smokeLit, 0.5), 1.6);
  const dens = p.lightDensity;

  // ---------- module (local z from 0 to -M) ----------
  const mb = new GeoBuilder(['aTone', 'aPart']);
  const moduleLights: { p: V3; size: number; color: THREE.Vector3; blink: number; part: number }[] = [];
  mb.cur.aTone = p.tone;
  mb.cur.aPart = 0;
  // skin
  const zs = [0, -M / 2, -M];
  for (let i = 0; i < prof.length - 1; i++) {
    const a = prof[i], b = prof[i + 1];
    for (let k = 0; k < zs.length - 1; k++) {
      const z0 = zs[k], z1 = zs[k + 1];
      const na: V3 = [a.nx, a.ny, 0], nb: V3 = [b.nx, b.ny, 0];
      oq(mb, [a.x, a.y, z0], [b.x, b.y, z0], [b.x, b.y, z1], [a.x, a.y, z1], [(a.nx + b.nx) / 2, (a.ny + b.ny) / 2, 0],
        [[a.s, z0], [b.s, z0], [b.s, z1], [a.s, z1]], [na, nb, nb, na]);
    }
  }
  // ribs: heavy at the joint, light mid-module
  const rib = (zc: number, w: number, depth: number, tone: number) => {
    mb.cur.aTone = tone;
    const r0 = 6, r1 = prof.length - 4; // keep ribs off the far top and the deep bottom
    for (let i = r0; i < r1; i++) {
      const a = prof[i], b = prof[i + 1];
      const ao: V3 = [a.x + a.nx * depth, a.y + a.ny * depth, 0], bo: V3 = [b.x + b.nx * depth, b.y + b.ny * depth, 0];
      const zA = zc + w / 2, zB = zc - w / 2;
      const nOut: V3 = [(a.nx + b.nx) / 2, (a.ny + b.ny) / 2, 0];
      oq(mb, [ao[0], ao[1], zA], [bo[0], bo[1], zA], [bo[0], bo[1], zB], [ao[0], ao[1], zB], nOut, [[a.s, 0], [b.s, 0], [b.s, w], [a.s, w]]);
      oq(mb, [a.x, a.y, zA], [b.x, b.y, zA], [bo[0], bo[1], zA], [ao[0], ao[1], zA], [0, 0, 1], [[a.s, 0], [b.s, 0], [b.s, depth], [a.s, depth]]);
      oq(mb, [a.x, a.y, zB], [b.x, b.y, zB], [bo[0], bo[1], zB], [ao[0], ao[1], zB], [0, 0, -1], [[a.s, 0], [b.s, 0], [b.s, depth], [a.s, depth]]);
    }
    // end caps of the rib band
    for (const i of [r0, r1]) {
      const a = prof[i];
      const ao: V3 = [a.x + a.nx * depth, a.y + a.ny * depth, 0];
      const tan: V3 = i === r0 ? [a.ny, -a.nx, 0] : [-a.ny, a.nx, 0];
      oq(mb, [a.x, a.y, zc + w / 2], [ao[0], ao[1], zc + w / 2], [ao[0], ao[1], zc - w / 2], [a.x, a.y, zc - w / 2], [-tan[0], -tan[1], 0], [[0, 0], [depth, 0], [depth, w], [0, w]]);
    }
  };
  rib(0, 4.2, p.ribDepth, p.tone * 0.9 + 0.1);
  rib(-M / 2, 2.0, p.ribDepth * 0.5, p.tone);
  // belts (horizontal strakes)
  for (const by of [-16, 10]) {
    const q = nearestY(prof, by);
    mb.cur.aTone = p.tone * 0.8;
    obox(mb, [q.x + q.nx * 1.0, q.y + q.ny * 1.0, -M / 2], [1.0, 1.4, M / 2], [q.nx, q.ny, 0], [-q.ny, q.nx, 0]);
  }
  // deck lip (overhang toward the corridor)
  const lipQ = nearestY(prof, p.lipY);
  mb.cur.aTone = p.tone * 1.05;
  const lipInner = lipQ.x + 3;
  const lipOuter = lipQ.x - p.lipOut;
  mb.box([(lipInner + lipOuter) / 2, p.lipY, -M / 2], [(lipInner - lipOuter) / 2, 1.8, M / 2]);
  // lip fascia step
  mb.cur.aTone = p.tone * 0.7;
  mb.box([lipOuter + 1.2, p.lipY - 2.6, -M / 2], [1.2, 0.8, M / 2]);
  for (let z = -2; z > -M; z -= 4.5 / dens) moduleLights.push({ p: [lipOuter + 0.2, p.lipY - 3.5, z], size: 0.55, color: cCool, blink: 0, part: 0 });
  // greebles (optional parts 1/2), fins (3), mast (4)
  const gr = rng.fork('greebles');
  const nG = Math.round(10 * p.greebleDensity);
  for (let i = 0; i < nG; i++) {
    const q = nearestY(prof, gr.range(-38, 30));
    const part = 1 + (i % 2);
    mb.cur.aPart = part;
    mb.cur.aTone = p.tone * gr.range(0.6, 1.1);
    const hz = gr.range(1.5, 5), ht = gr.range(1.2, 4), hr = gr.range(0.5, 1.6);
    const z = gr.range(-M + hz + 2.5, -hz - 2.5);
    obox(mb, [q.x + q.nx * hr, q.y + q.ny * hr, z], [hr, ht, hz], [q.nx, q.ny, 0], [-q.ny, q.nx, 0]);
  }
  mb.cur.aPart = 0;
  // window rows
  const wr = rng.fork('windows');
  const rows = Math.max(0, Math.round(3 * dens));
  for (let r = 0; r < rows; r++) {
    const q = nearestY(prof, wr.range(-30, 28));
    const nL = wr.int(5, 12);
    const z0 = wr.range(-M + 4, -6);
    for (let k = 0; k < nL; k++) {
      const z = z0 + k * 1.5;
      if (z > -2.5 || z < -M + 2.5) continue;
      moduleLights.push({ p: [q.x + q.nx * 0.4, q.y + q.ny * 0.4, z], size: 0.45, color: cWin, blink: 0, part: 0 });
    }
  }
  // fin (part 3) and mast (part 4) on the top shoulder
  const top = prof[Math.round(prof.length * 0.12)];
  mb.cur.aPart = 3;
  mb.cur.aTone = p.tone * 0.9;
  mb.box([top.x + 4, top.y + 6, -M * 0.3], [0.35, 6, 5]);
  mb.box([top.x + 4, top.y + 11, -M * 0.3 - 3], [0.35, 1.5, 2.5]);
  mb.cur.aPart = 4;
  mb.box([top.x - 2, top.y + 10, -M * 0.7], [0.4, 10, 0.4]);
  mb.box([top.x - 2, top.y + 16, -M * 0.7], [3, 0.3, 0.3]);
  moduleLights.push({ p: [top.x - 2, top.y + 20.6, -M * 0.7], size: 0.9, color: cBeacon, blink: 1, part: 4 });
  mb.cur.aPart = 0;
  const moduleGeo = mb.build();

  // ---------- instance placement along the plan-view bow ----------
  const xOff = (u: number) => p.bow * (2 * u - 1) * (2 * u - 1);
  const yawAt = (u: number) => -Math.atan((4 * p.bow * (2 * u - 1)) / bodyLen);
  const mats: THREE.Matrix4[] = [];
  const masks = new Float32Array(p.modules * 4);
  const mr = rng.fork('masks');
  for (let i = 0; i < p.modules; i++) {
    const u0 = i / p.modules, um = (i + 0.5) / p.modules;
    const m = new THREE.Matrix4().makeRotationY(yawAt(um)).setPosition(xOff(u0), 0, -(p.capLength + i * M));
    mats.push(m);
    masks[i * 4] = mr.chance(0.75) ? 1 : 0;
    masks[i * 4 + 1] = mr.chance(0.6) ? 1 : 0;
    masks[i * 4 + 2] = mr.chance(0.45) ? 1 : 0;
    masks[i * 4 + 3] = i % 3 === 1 ? 1 : 0;
    const mv = new THREE.Vector3();
    for (const L of moduleLights) {
      if (L.part > 0 && masks[i * 4 + L.part - 1] < 0.5) continue;
      mv.set(...L.p).applyMatrix4(m);
      lights.push({ p: [mv.x, mv.y, mv.z], size: L.size, color: L.color, blink: L.blink });
    }
  }

  // ---------- unique pieces: caps + arches ----------
  const ub = new GeoBuilder(['aTone', 'aPart']);
  ub.cur.aTone = p.tone;
  const closed = (scale: number, shift: number) => profile(p, 0, Math.PI * 2, 44, scale, shift);
  const loft = (rings: { z: number; scale: number; shift: number; tone: number }[], m: THREE.Matrix4, closeEnd: boolean, dir: 1 | -1) => {
    const b = new GeoBuilder(['aTone', 'aPart']);
    for (let r = 0; r < rings.length - 1; r++) {
      const A = closed(rings[r].scale, rings[r].shift), B = closed(rings[r + 1].scale, rings[r + 1].shift);
      b.cur.aTone = rings[r].tone;
      for (let i = 0; i < A.length - 1; i++) {
        const a0 = A[i], a1 = A[i + 1], b0 = B[i], b1 = B[i + 1];
        const want: V3 = [a0.nx, a0.ny, dir * 0.4];
        oq(b, [a0.x, a0.y, rings[r].z], [a1.x, a1.y, rings[r].z], [b1.x, b1.y, rings[r + 1].z], [b0.x, b0.y, rings[r + 1].z], want,
          [[a0.s, rings[r].z], [a1.s, rings[r].z], [b1.s, rings[r + 1].z], [b0.s, rings[r + 1].z]]);
      }
    }
    if (closeEnd) {
      const last = rings[rings.length - 1];
      const E = closed(last.scale, last.shift);
      const cx = p.clearance + p.halfWidth + last.shift, cy = p.centerY;
      b.cur.aTone = p.tone * 0.6;
      for (let i = 0; i < E.length - 1; i++) {
        const a: V3 = [E[i].x, E[i].y, last.z], c: V3 = [E[i + 1].x, E[i + 1].y, last.z], o: V3 = [cx, cy, last.z];
        const fn = faceNormal(a, c, o);
        if (fn[2] * dir >= 0) b.tri(a, c, o, [a[0], a[1]], [c[0], c[1]], [cx, cy]);
        else b.tri(a, o, c, [a[0], a[1]], [cx, cy], [c[0], c[1]]);
      }
    }
    ub.append(b, m);
  };
  // prow (toward +z, approached first): smooth taper
  const K = 7;
  const prow: { z: number; scale: number; shift: number; tone: number }[] = [];
  for (let k = 0; k <= K; k++) {
    const t = k / K;
    prow.push({ z: t * p.capLength, scale: 1 - 0.8 * Math.pow(t, 1.7), shift: 0.3 * p.halfWidth * Math.pow(t, 1.3), tone: p.tone * (1 - 0.15 * t) });
  }
  const mProw = new THREE.Matrix4().makeRotationY(yawAt(0)).setPosition(xOff(0), 0, -p.capLength);
  loft(prow, mProw, true, 1);
  // stern: stepped bulkheads
  const stern = [
    { z: 0, scale: 1, shift: 0, tone: p.tone },
    { z: -p.capLength * 0.3, scale: 0.94, shift: 3, tone: p.tone },
    { z: -p.capLength * 0.3, scale: 0.8, shift: 6, tone: p.tone * 0.7 },
    { z: -p.capLength * 0.62, scale: 0.72, shift: 9, tone: p.tone * 0.9 },
    { z: -p.capLength * 0.62, scale: 0.55, shift: 12, tone: p.tone * 0.6 },
    { z: -p.capLength, scale: 0.42, shift: 16, tone: p.tone * 0.8 },
  ];
  const mStern = new THREE.Matrix4().makeRotationY(yawAt(1)).setPosition(xOff(1), 0, -(p.capLength + bodyLen));
  loft(stern, mStern, true, -1);
  // prow lights
  const pl = new THREE.Vector3();
  for (let k = 0; k < Math.round(10 * dens); k++) {
    const t = 0.15 + (0.7 * k) / Math.max(1, Math.round(10 * dens));
    const sc = 1 - 0.8 * Math.pow(t, 1.7), sh = 0.3 * p.halfWidth * Math.pow(t, 1.3);
    const x = p.clearance + p.halfWidth + sh - p.halfWidth * sc + -0.6;
    pl.set(x, p.centerY + 12 * sc, t * p.capLength).applyMatrix4(mProw);
    lights.push({ p: [pl.x, pl.y, pl.z], size: 0.6, color: cCool, blink: 0 });
  }

  // arches over the corridor
  const arches: number[] = [];
  if (p.archEvery > 0) for (let i = Math.floor(p.archEvery / 2); i < p.modules; i += p.archEvery) arches.push(i);
  const P1 = new THREE.Vector2(lipOuter + 8, p.lipY + 2), P2 = new THREE.Vector2(0, p.archTop), P3 = new THREE.Vector2(-p.clearance - 95, -95);
  // circle through 3 points
  const d = 2 * (P1.x * (P2.y - P3.y) + P2.x * (P3.y - P1.y) + P3.x * (P1.y - P2.y));
  const ux = ((P1.lengthSq()) * (P2.y - P3.y) + P2.lengthSq() * (P3.y - P1.y) + P3.lengthSq() * (P1.y - P2.y)) / d;
  const uy = ((P1.lengthSq()) * (P3.x - P2.x) + P2.lengthSq() * (P1.x - P3.x) + P3.lengthSq() * (P2.x - P1.x)) / d;
  const C = new THREE.Vector2(ux, uy);
  const Rr = P1.distanceTo(C);
  const ang = (q: THREE.Vector2) => Math.atan2(q.y - C.y, q.x - C.x);
  let a1 = ang(P1) - 0.03, a3 = ang(P3);
  if (a3 < a1) a3 += Math.PI * 2; // sweep counter-clockwise from the hull, over the top, down the far side
  const archB = new GeoBuilder(['aTone', 'aPart']);
  const band = (rIn: number, rOut: number, halfW: number, tone: number, zc: number) => {
    archB.cur.aTone = tone;
    const S = 40;
    for (let i = 0; i < S; i++) {
      const t0 = a1 + ((a3 - a1) * i) / S, t1 = a1 + ((a3 - a1) * (i + 1)) / S;
      const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      const P = (c: number, s: number, r: number, z: number): V3 => [C.x + c * r, C.y + s * r, z];
      const u0 = Rr * (t0 - a1), u1 = Rr * (t1 - a1);
      const zf = zc + halfW, zb = zc - halfW;
      oq(archB, P(c0, s0, rOut, zf), P(c1, s1, rOut, zf), P(c1, s1, rOut, zb), P(c0, s0, rOut, zb), [(c0 + c1) / 2, (s0 + s1) / 2, 0], [[u0, 0], [u1, 0], [u1, 2 * halfW], [u0, 2 * halfW]]);
      oq(archB, P(c0, s0, rIn, zf), P(c1, s1, rIn, zf), P(c1, s1, rIn, zb), P(c0, s0, rIn, zb), [-(c0 + c1) / 2, -(s0 + s1) / 2, 0], [[u0, 0], [u1, 0], [u1, 2 * halfW], [u0, 2 * halfW]]);
      oq(archB, P(c0, s0, rIn, zf), P(c1, s1, rIn, zf), P(c1, s1, rOut, zf), P(c0, s0, rOut, zf), [0, 0, 1], [[u0, 0], [u1, 0], [u1, rOut - rIn], [u0, rOut - rIn]]);
      oq(archB, P(c0, s0, rIn, zb), P(c1, s1, rIn, zb), P(c1, s1, rOut, zb), P(c0, s0, rOut, zb), [0, 0, -1], [[u0, 0], [u1, 0], [u1, rOut - rIn], [u0, rOut - rIn]]);
    }
  };
  band(Rr - 3.5, Rr + 3.5, 4.5, p.tone * 0.95, 0);
  band(Rr - 5.2, Rr - 3.4, 2.2, p.tone * 0.55, 0); // inner trim
  band(Rr + 3.4, Rr + 4.4, 5.2, p.tone * 0.75, 0); // outer cap strip
  const archGeo = archB;
  const archLightsLocal: V3[] = [];
  for (let t = a1 + 0.05; t < a3; t += 7 / (Rr * Math.max(0.3, dens))) archLightsLocal.push([C.x + Math.cos(t) * (Rr - 5.4), C.y + Math.sin(t) * (Rr - 5.4), 0]);
  for (const i of arches) {
    const m = mats[i];
    ub.append(archGeo, m);
    for (const q of archLightsLocal) {
      pl.set(...q).applyMatrix4(m);
      lights.push({ p: [pl.x, pl.y, pl.z], size: 0.6, color: cCool, blink: 0 });
    }
  }
  const uniqueGeo = ub.build();
  if (p.side === -1) {
    mirrorX(moduleGeo);
    mirrorX(uniqueGeo);
    for (const L of lights) L.p[0] = -L.p[0];
    for (const m of mats) {
      const e = m.elements;
      // mirror placement: negate x translation and yaw
      const pos = new THREE.Vector3().setFromMatrixPosition(m);
      const yaw = Math.atan2(e[8], e[10]);
      m.makeRotationY(-yaw).setPosition(-pos.x, pos.y, pos.z);
    }
  }

  // ---------- materials ----------
  const hullMat = new THREE.ShaderMaterial({
    uniforms: {
      ...lightUniforms,
      uDark: { value: tvec(palette.armourDark) },
      uSteel: { value: tvec(palette.armourSteel) },
      uLight: { value: tvec(mix(palette.armourSteel, palette.armourLight, 0.5)) },
      uSil: { value: tvec(palette.emblemBlack) },
      uPanel: { value: new THREE.Vector2(9.0, 4.6) },
      uSeamW: { value: 0.14 },
      uSeamDark: { value: shading.seamDarkness },
      uRimMul: { value: 0.8 },
      uSpecPow: { value: shading.specular.power },
      uSpecStr: { value: shading.specular.strength },
    },
    defines: opts.silhouette ? { SILHOUETTE: '' } : {},
    vertexShader: HULL_VERT,
    fragmentShader: HULL_FRAG,
  });

  const group = new THREE.Group();
  group.name = 'hullMass';
  const im = new THREE.InstancedMesh(moduleGeo, hullMat, p.modules);
  mats.forEach((m, i) => im.setMatrixAt(i, m));
  im.instanceMatrix.needsUpdate = true;
  moduleGeo.setAttribute('iMask', new THREE.InstancedBufferAttribute(masks, 4));
  im.name = 'hullModules';
  im.computeBoundingSphere();
  group.add(im);
  const unique = new THREE.Mesh(uniqueGeo, hullMat);
  unique.name = 'hullUnique';
  group.add(unique);

  // lights
  const NL = lights.length;
  const lp = new Float32Array(NL * 3), ls = new Float32Array(NL), lb = new Float32Array(NL), lph = new Float32Array(NL), lc = new Float32Array(NL * 3);
  const lr = rng.fork('lights');
  lights.forEach((L, i) => {
    lp.set(L.p, i * 3);
    ls[i] = L.size;
    lb[i] = L.blink;
    lph[i] = lr.next();
    lc.set([L.color.x, L.color.y, L.color.z], i * 3);
  });
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
  lg.setAttribute('aSize', new THREE.BufferAttribute(ls, 1));
  lg.setAttribute('aBlink', new THREE.BufferAttribute(lb, 1));
  lg.setAttribute('aPhase', new THREE.BufferAttribute(lph, 1));
  lg.setAttribute('aColor', new THREE.BufferAttribute(lc, 3));
  lg.computeBoundingSphere();
  const timeU = { value: 0 };
  const lightMat = new THREE.ShaderMaterial({
    uniforms: {
      uViewH: { value: 1080 },
      uHullTime: timeU,
      uFogDensity: lightUniforms.uFogDensity,
      uFogHeightFalloff: lightUniforms.uFogHeightFalloff,
      uFogBaseHeight: lightUniforms.uFogBaseHeight,
    },
    vertexShader: LIGHT_VERT,
    fragmentShader: LIGHT_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lightPts = new THREE.Points(lg, lightMat);
  lightPts.name = 'hullLights';
  const vp = new THREE.Vector4();
  lightPts.onBeforeRender = (renderer) => {
    renderer.getCurrentViewport(vp);
    lightMat.uniforms.uViewH.value = vp.w > 0 ? vp.w : 1080;
  };
  lightPts.visible = !opts.silhouette;
  group.add(lightPts);

  const moduleTriangles = moduleGeo.attributes.position.count / 3;
  const uniqueTriangles = uniqueGeo.attributes.position.count / 3;
  return {
    group,
    lengthMetres,
    update(time: number) {
      timeU.value = time;
    },
    dispose() {
      moduleGeo.dispose();
      uniqueGeo.dispose();
      lg.dispose();
      hullMat.dispose();
      lightMat.dispose();
    },
    stats: { triangles: moduleTriangles * p.modules + uniqueTriangles, drawCalls: opts.silhouette ? 2 : 3, lights: NL, moduleTriangles, uniqueTriangles },
  };
}

