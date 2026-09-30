/**
 * Cumulus field: camera-facing puff billboards (procedural atlas) grouped into
 * towers, banks, sea humps and near wisps around a clear flight corridor along -Z.
 *
 * Recycling: every cluster has an anchor u in [0, depth). The shader places it at
 * ahead = mod(u - phase, depth) - back metres in front of the camera, so the field
 * wraps forever along -Z with no CPU work. Each wrap re-seeds the cluster's side and
 * lateral offset (hash of cluster id + wrap count), so it never visibly repeats.
 * New clusters fade in over `fadeFar` at the far end; near puffs fade out (no popping).
 *
 * Sorting: instance data sits in a float texture, sorted by anchor (far first). As the
 * camera moves the correct back-to-front order is a cyclic rotation of that list, so
 * the vertex shader reads instance (gl_InstanceID + uOffset) % count and the CPU only
 * updates one integer uniform per frame (binary search, no allocation).
 *
 * One instanced draw call; 2 triangles per puff.
 */
import * as THREE from 'three';
import type { StageId } from '../../../style/tokens';
import { Rng } from '../../../core/rng';
import { GLSL_LIGHTING, lightUniforms } from '../../common/lighting';
import { GLSL_SKY_NOISE } from './noise';
import { puffAtlas, PUFF_CELLS } from './puffAtlas';
import { colorVec, type CloudFieldParams } from './params';
import { GLSL_SKY_HAZE, skyCommonUniforms } from './shading';

export interface CloudField {
  group: THREE.Group;
  update(cameraPos: THREE.Vector3, time: number): void;
  stats: { triangles: number; drawCalls: number; puffs: number; clusters: number };
}

interface Puff {
  x: number; y: number; dz: number; size: number;
  aspect: number; cell: number; flip: boolean; alpha: number;
  cnx: number; cny: number; cnz: number;
  height: number; tone: number;
}
interface Cluster {
  u: number;
  id: number;
  puffs: Puff[];
}

const TEX_W = 1024;
const ROWS = 4;

function pickCell(rng: Rng, kind: keyof typeof PUFF_CELLS): number {
  const [a, b] = PUFF_CELLS[kind];
  return rng.int(a, b);
}

/** Keep the flight corridor clear: push puffs sideways, or shrink/drop sea humps. */
function clearCorridor(p: Puff, P: CloudFieldParams, canPush: boolean): boolean {
  const hx = 0.46 * p.size * p.aspect, hy = 0.42 * p.size;
  const inX = Math.abs(p.x) - hx < P.corridorX;
  const inY = p.y + hy > -P.corridorY && p.y - hy < P.corridorY;
  if (!(inX && inY)) return true;
  if (canPush) {
    const s = p.x < 0 ? -1 : 1;
    p.x = s * (P.corridorX + hx + 1);
    return true;
  }
  // shrink until the top clears the corridor floor
  const maxHy = -P.corridorY - p.y;
  if (maxHy > 8) {
    p.size = maxHy / 0.42;
    return true;
  }
  return false;
}

function makeTower(rng: Rng, P: CloudFieldParams, side: number): Puff[] {
  const W = rng.range(P.towerWidth[0], P.towerWidth[1]);
  const H = rng.range(P.towerHeight[0], P.towerHeight[1]);
  const cx = side * (P.corridorX + rng.range(P.lateral[0], P.lateral[1]) + W * 0.5);
  const baseY = P.seaY - 6;
  const nl = Math.max(3, Math.round(H / (W * 0.26)));
  const out: Puff[] = [];
  const cy = baseY + H * 0.45;
  for (let k = 0; k < nl; k++) {
    const t = k / (nl - 1);
    const y = baseY + t * H * 0.8;
    // cumulus profile: flat base, bulging cauliflower middle, rounded dome (not a cone)
    const bulge = Math.sin(Math.PI * Math.min(1, t * 1.15));
    const rad = W * 0.5 * (0.72 + 0.32 * bulge - 0.28 * t * t * t);
    const np = t < 0.2 ? 5 : 4;
    for (let m = 0; m < np; m++) {
      const a = rng.range(0, Math.PI * 2);
      const rr = rad * rng.range(0.25, 0.75);
      const px = cx + Math.cos(a) * rr;
      const dz = Math.sin(a) * rr * 0.8;
      const flat = t < 0.18;
      const kind = flat ? 'flat' : t > 0.55 ? 'cumulus' : rng.chance(0.5) ? 'cumulus' : 'round';
      out.push({
        x: px, y, dz,
        size: W * 0.6 * (0.78 + 0.22 * bulge - 0.2 * t * t) * rng.range(0.8, 1.2),
        aspect: flat ? rng.range(1.4, 1.8) : rng.range(1.0, 1.25),
        cell: pickCell(rng, kind), flip: rng.chance(0.5), alpha: 1,
        cnx: (px - cx) / (W * 0.5), cny: (y - cy) / (H * 0.55), cnz: dz / (W * 0.5) + 0.35,
        height: t, tone: rng.range(0.94, 1.04),
      });
    }
  }
  // crown
  const nc = rng.int(2, 3);
  for (let c = 0; c < nc; c++) {
    const px = cx + rng.range(-0.28, 0.28) * W;
    const y = baseY + H * rng.range(0.84, 0.94);
    out.push({
      x: px, y, dz: rng.range(-0.1, 0.1) * W, size: W * rng.range(0.42, 0.52), aspect: rng.range(1.0, 1.2),
      cell: pickCell(rng, 'cumulus'), flip: rng.chance(0.5), alpha: 1,
      cnx: (px - cx) / (W * 0.5), cny: 1, cnz: 0.3, height: 1, tone: rng.range(0.98, 1.05),
    });
  }
  return out;
}

function makeBank(rng: Rng, P: CloudFieldParams, side: number): Puff[] {
  const Lb = rng.range(P.bankLength[0], P.bankLength[1]);
  const Hb = rng.range(P.bankHeight[0], P.bankHeight[1]);
  const alongZ = rng.chance(0.5);
  const halfX = alongZ ? Hb * 0.8 : Lb * 0.5;
  const cx = side * (P.corridorX + rng.range(P.lateral[0], P.lateral[1]) + halfX);
  const baseY = P.seaY - 4;
  const n = Math.max(3, Math.ceil(Lb / (Hb * 0.85)));
  const out: Puff[] = [];
  const cy = baseY + Hb * 0.4;
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) / n - 0.5;
    const along = s * Lb;
    const env = Math.sqrt(Math.max(0.15, 1 - 4 * s * s)); // taller in the middle
    const px = cx + (alongZ ? rng.range(-0.3, 0.3) * Hb : along + rng.range(-0.1, 0.1) * Hb);
    const dz = (alongZ ? along : 0) + rng.range(-0.3, 0.3) * Hb;
    const y = baseY + rng.range(0.15, 0.45) * Hb * env;
    out.push({
      x: px, y, dz, size: Hb * rng.range(1.2, 1.6) * (0.7 + 0.3 * env), aspect: rng.range(1.3, 1.7),
      cell: pickCell(rng, rng.chance(0.6) ? 'flat' : 'round'), flip: rng.chance(0.5), alpha: 1,
      cnx: (px - cx) / Math.max(halfX, 1), cny: (y - cy) / Hb, cnz: 0.5, height: 0.2, tone: rng.range(0.95, 1.03),
    });
    if (rng.chance(0.7 * env)) {
      const ty = y + Hb * rng.range(0.45, 0.75) * env;
      out.push({
        x: px + rng.range(-0.2, 0.2) * Hb, y: ty, dz: dz + rng.range(-0.2, 0.2) * Hb,
        size: Hb * rng.range(0.9, 1.25) * env, aspect: rng.range(1.0, 1.3),
        cell: pickCell(rng, 'cumulus'), flip: rng.chance(0.5), alpha: 1,
        cnx: (px - cx) / Math.max(halfX, 1), cny: (ty - cy) / Hb, cnz: 0.4, height: 0.8, tone: rng.range(0.97, 1.05),
      });
    }
  }
  return out;
}

function makeHump(rng: Rng, P: CloudFieldParams): Puff[] {
  const out: Puff[] = [];
  const cx = rng.range(-P.humpSpread, P.humpSpread);
  const n = rng.int(1, 3);
  for (let i = 0; i < n; i++) {
    const size = rng.range(45, 120);
    out.push({
      x: cx + rng.range(-0.6, 0.6) * size, y: P.seaY + rng.range(-2, 10), dz: rng.range(-0.5, 0.5) * size,
      size, aspect: rng.range(1.4, 2.0), cell: pickCell(rng, rng.chance(0.5) ? 'flat' : 'cumulus'),
      flip: rng.chance(0.5), alpha: rng.range(0.75, 1), cnx: rng.range(-0.3, 0.3), cny: 0.6, cnz: 0.5,
      height: 0.5, tone: rng.range(0.95, 1.04),
    });
  }
  return out;
}

function makeWisp(rng: Rng, P: CloudFieldParams, side: number): Puff[] {
  const size = rng.range(45, 85);
  return [{
    x: side * (P.corridorX + rng.range(8, 50)), y: rng.range(-20, 35), dz: 0, size, aspect: rng.range(1.2, 1.6),
    cell: pickCell(rng, 'round'), flip: rng.chance(0.5), alpha: rng.range(0.3, 0.5),
    cnx: side * 0.3, cny: 0.3, cnz: 0.8, height: 0.6, tone: 1.02,
  }];
}

/** Deterministic layout: clusters sorted far-first (u descending), puffs far-first inside. */
export function layoutCloudField(P: CloudFieldParams, seed: number): Cluster[] {
  const rng = new Rng(seed).fork('cloud-field');
  const km = P.depth / 1000;
  const clusters: Cluster[] = [];
  let id = 0;
  const add = (label: string, perKm: number, make: (r: Rng, side: number) => Puff[], canPush: boolean) => {
    const r = rng.fork(label);
    const n = Math.round(perKm * km);
    for (let i = 0; i < n; i++) {
      // stratified along the window so density is even
      const u = ((i + r.range(0.05, 0.95)) / n) * P.depth;
      const side = r.chance(0.5) ? -1 : 1;
      const puffs = make(r, side).filter((p) => clearCorridor(p, P, canPush));
      if (puffs.length) clusters.push({ u, id: id++, puffs });
    }
  };
  add('towers', P.towersPerKm, (r, s) => makeTower(r, P, s), true);
  add('banks', P.banksPerKm, (r, s) => makeBank(r, P, s), true);
  add('humps', P.humpsPerKm, (r) => makeHump(r, P), false);
  add('wisps', P.wispsPerKm, (r, s) => makeWisp(r, P, s), true);
  clusters.sort((a, b) => b.u - a.u);
  for (const c of clusters) c.puffs.sort((a, b) => a.dz - b.dz);
  return clusters;
}

export function buildCloudField(stage: StageId, params: CloudFieldParams, seed: number): CloudField {
  const P = params;
  const clusters = layoutCloudField(P, seed);
  const count = clusters.reduce((s, c) => s + c.puffs.length, 0);
  const blocks = Math.max(1, Math.ceil(count / TEX_W));
  const data = new Float32Array(TEX_W * blocks * ROWS * 4);
  const clusterU = new Float64Array(clusters.length);
  const clusterStart = new Int32Array(clusters.length);
  let idx = 0;
  clusters.forEach((c, ci) => {
    clusterU[ci] = c.u;
    clusterStart[ci] = idx;
    for (const p of c.puffs) {
      const bx = idx % TEX_W, by = Math.floor(idx / TEX_W) * ROWS;
      const put = (row: number, a: number, b: number, cc: number, d: number) => {
        const o = ((by + row) * TEX_W + bx) * 4;
        data[o] = a; data[o + 1] = b; data[o + 2] = cc; data[o + 3] = d;
      };
      const cl = Math.hypot(p.cnx, p.cny, p.cnz) || 1;
      put(0, p.x, p.y, p.dz, p.size);
      put(1, c.u, p.aspect, p.cell + (p.flip ? 16 : 0), p.alpha);
      put(2, p.cnx / cl, p.cny / cl, p.cnz / cl, c.id);
      put(3, p.height, p.tone, 0, 0);
      idx++;
    }
  });
  const dataTex = new THREE.DataTexture(data, TEX_W, blocks * ROWS, THREE.RGBAFormat, THREE.FloatType);
  dataTex.magFilter = dataTex.minFilter = THREE.NearestFilter;
  dataTex.generateMipmaps = false;
  dataTex.needsUpdate = true;

  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(quad.index);
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  geo.instanceCount = count;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...lightUniforms,
      ...skyCommonUniforms(stage),
      uAtlas: { value: puffAtlas() },
      uData: { value: dataTex },
      uCount: { value: count },
      uOffset: { value: 0 },
      uPhase: { value: 0 },
      uCycle: { value: 0 },
      uL: { value: P.depth },
      uBack: { value: P.back },
      uFadeFar: { value: P.fadeFar },
      uFadeNear: { value: P.fadeNear },
      uCycleShift: { value: P.cycleShift },
      uCamZ: { value: 0 },
      uPuffTime: { value: 0 },
      uSeaY: { value: P.seaY },
      uLit: { value: colorVec(P.lit) },
      uMidC: { value: colorVec(P.mid) },
      uShadow: { value: colorVec(P.shadow) },
      uRimC: { value: colorVec(P.rim) },
      uBacklit: { value: P.backlit },
      uRimPow: { value: P.rimPower },
      uClusterN: { value: P.clusterNormal },
      uToon: { value: P.toon },
      uOpacity: { value: P.opacity },
      uLift: { value: P.lift },
    },
    vertexShader: /* glsl */ `
      ${GLSL_SKY_NOISE}
      uniform highp sampler2D uData;
      uniform int uCount;
      uniform int uOffset;
      uniform float uPhase, uCycle, uL, uBack, uFadeFar, uFadeNear, uCycleShift, uCamZ, uPuffTime;
      varying vec2 vAtlasUv;
      varying float vAlpha;
      varying float vFlip;
      varying float vHeight;
      varying float vTone;
      varying vec3 vCN;
      varying vec3 vWorldPos;
      void main() {
        int idx = gl_InstanceID + uOffset;
        if (idx >= uCount) idx -= uCount;
        ivec2 b = ivec2(idx % ${TEX_W}, (idx / ${TEX_W}) * ${ROWS});
        vec4 d0 = texelFetch(uData, b, 0);
        vec4 d1 = texelFetch(uData, b + ivec2(0, 1), 0);
        vec4 d2 = texelFetch(uData, b + ivec2(0, 2), 0);
        vec4 d3 = texelFetch(uData, b + ivec2(0, 3), 0);

        float ahead = mod(d1.x - uPhase, uL) - uBack;
        float cyc = uCycle + (d1.x < uPhase ? 1.0 : 0.0);
        float h1 = skyHash(d2.w * 1.618 + mod(cyc, 997.0) * 7.31);
        float h2 = skyHash(d2.w * 2.414 + mod(cyc, 991.0) * 3.17 + 0.5);
        float mir = h1 < 0.5 ? -1.0 : 1.0;
        float x = d0.x * mir;
        x += sign(x) * h2 * uCycleShift;
        vec3 center = vec3(x, d0.y, uCamZ - ahead + d0.z);

        float size = d0.w * (1.0 + 0.025 * sin(uPuffTime * 0.3 + d2.w * 2.1 + d0.x * 0.01));
        vec4 mv = modelViewMatrix * vec4(center, 1.0);
        float far = 1.0 - smoothstep(uL - uBack - uFadeFar, uL - uBack, ahead);
        float near = smoothstep(uFadeNear * 0.3, uFadeNear, -mv.z - size * 0.3);
        vAlpha = d1.w * far * near;
        if (vAlpha < 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

        vec2 off = position.xy * vec2(size * d1.y, size);
        mv.xy += off;
        gl_Position = projectionMatrix * mv;

        float flip = (d1.z >= 16.0 ? -1.0 : 1.0) * mir;
        float cell = mod(d1.z, 16.0);
        vec2 cuv = vec2(flip < 0.0 ? 1.0 - uv.x : uv.x, uv.y);
        vec2 cxy = vec2(mod(cell, 4.0), floor(cell / 4.0));
        vAtlasUv = (cxy + cuv * 0.98 + 0.01) * 0.25;
        vFlip = flip;
        vCN = normalize((viewMatrix * vec4(d2.x * mir, d2.y, d2.z, 0.0)).xyz);
        vHeight = d3.x;
        vTone = d3.y;
        vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vWorldPos = (modelMatrix * vec4(center, 1.0)).xyz + R * off.x + U * off.y;
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_LIGHTING}
      ${GLSL_SKY_HAZE}
      uniform sampler2D uAtlas;
      uniform vec3 uLit, uMidC, uShadow, uRimC;
      uniform float uBacklit, uRimPow, uClusterN, uToon, uOpacity, uSeaY, uLift;
      varying vec2 vAtlasUv;
      varying float vAlpha;
      varying float vFlip;
      varying float vHeight;
      varying float vTone;
      varying vec3 vCN;
      varying vec3 vWorldPos;
      void main() {
        vec4 t = texture2D(uAtlas, vAtlasUv);
        float dens = t.a * vAlpha * smoothstep(uSeaY - 6.0, uSeaY + 12.0, vWorldPos.y);
        if (dens < 0.004) discard;
        vec3 n = vec3((t.r * 2.0 - 1.0) * vFlip, t.g * 2.0 - 1.0, 0.0);
        n.z = sqrt(max(0.03, 1.0 - dot(n.xy, n.xy)));
        vec3 N = normalize(mix(n, vCN, uClusterN));
        vec3 Lv = normalize((viewMatrix * vec4(uKeyDir, 0.0)).xyz);
        float x = clamp(dot(N, Lv) * 0.5 + 0.5 + uLift, 0.0, 1.0);
        float r = texture2D(uRamp, vec2(x, 0.5)).r * 1.25;
        float lit = mix(smoothstep(0.05, 0.95, x), clamp((r - 0.18) / 0.9, 0.0, 1.0), uToon);
        float l = lit * mix(1.0, t.b, 0.75) * mix(0.82, 1.0, vHeight) * vTone;
        vec3 c = mix(uShadow, uMidC, smoothstep(0.08, 0.45, l));
        c = mix(c, uLit, smoothstep(0.42, 0.82, l));
        // backlit silver lining: thin parts glow when looking toward the sun
        vec3 v = normalize(vWorldPos - cameraPosition);
        float fwd = pow(max(dot(v, normalize(uKeyDir)), 0.0), uRimPow);
        float thin = 1.0 - smoothstep(0.1, 0.8, t.a);
        c += uRimC * fwd * (thin * 0.9 + 0.3 * (1.0 - N.z)) * uBacklit;
        c = skyFogHaze(c, vWorldPos);
        gl_FragColor = vec4(c, clamp(dens * uOpacity, 0.0, 1.0));
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `cloudField:${stage}`;
  mesh.frustumCulled = false;
  mesh.renderOrder = -700;
  const group = new THREE.Group();
  group.name = `clouds:${stage}`;
  group.add(mesh);

  const u = mat.uniforms;
  return {
    group,
    update(cameraPos: THREE.Vector3, time: number) {
      const camZ = cameraPos.z - group.position.z;
      const D = -camZ + P.wind * time - P.back;
      const phase = ((D % P.depth) + P.depth) % P.depth;
      u.uPhase.value = phase;
      u.uCycle.value = Math.floor(D / P.depth);
      u.uCamZ.value = camZ;
      u.uPuffTime.value = time;
      // farthest cluster = first (u descending) with u < phase; binary search
      let lo = 0, hi = clusterU.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (clusterU[m] < phase) hi = m;
        else lo = m + 1;
      }
      u.uOffset.value = lo < clusterU.length ? clusterStart[lo] : 0;
    },
    stats: { triangles: count * 2, drawCalls: 1, puffs: count, clusters: clusters.length },
  };
}
