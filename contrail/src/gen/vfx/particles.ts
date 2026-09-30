/**
 * VFX lane B core: pooled, instanced, camera-facing particle batches shared by
 * smoke trails, explosions, sparks and hit pops.
 *
 * One ParticleBatch = one InstancedBufferGeometry + one ShaderMaterial = ONE draw call.
 * - Simulation is on the CPU (effects write instances each frame into `data` via alloc()).
 * - Instances are depth-sorted back-to-front with a 16-bit radix sort (O(n), no allocation)
 *   and uploaded with a single bufferSubData range.
 * - Blending is premultiplied "over" (ONE, ONE_MINUS_SRC_ALPHA). Each instance carries an
 *   `occlusion` value: 1 = normal alpha (smoke), 0 = purely additive (glow). Fire sits in
 *   between, so additive fire and occluding smoke share one sorted draw call.
 * - Shading uses the shared rig (lightUniforms + GLSL_LIGHTING: key/rim/ambient/fog).
 *
 * Shapes (per instance): 0..3 lumpy puff atlas cells (normal-mapped), 4 streak,
 * 5 star burst, 6 toon sphere disc, 7 soft glow, 8 shard.
 */
import * as THREE from 'three';
import { GLSL_LIGHTING, lightUniforms } from '../common/lighting';
import { Rng } from '../../core/rng';

/** Floats per instance (5 x vec4). */
export const STRIDE = 20;

export const SHAPE = {
  PUFF0: 0,
  PUFF1: 1,
  PUFF2: 2,
  PUFF3: 3,
  STREAK: 4,
  STAR: 5,
  DISC: 6,
  GLOW: 7,
  SHARD: 8,
} as const;

/** Offsets inside one instance record (floats). */
export const OFF = {
  pos: 0, // x, y, z, width (m)
  colA: 4, // inner / lit colour (linear rgb, HDR allowed), opacity
  colB: 8, // outer / shadow colour, lit amount (0 = emissive, 1 = rig-lit smoke)
  axis: 12, // stretch direction xyz (batch-local), stretch ratio (>= 1)
  misc: 16, // rotation (rad), shape, occlusion (0 additive .. 1 over), seed / phase (0..1)
} as const;

/** Per-batch shading look (uniforms). */
export interface ParticleLook {
  /** 0 = flat camera-facing, 1 = full baked puff normals */
  normalStrength: number;
  /** 0 = physical half-lambert, 1 = screen-projected (anime) terminator that stays readable when backlit */
  stylize: number;
  /** terminator centre (0..1 of the half-lambert range) */
  term: number;
  /** terminator half-width (softness) */
  soft: number;
  /** extra brightness when the key light is behind the camera (front-lit), less when backlit */
  frontBias: number;
  /** how much the key light hue tints the lit side */
  keyTint: number;
  /** how much the ambient hue tints the shadow side */
  ambTint: number;
  /** forward scattering glow of thin edges when looking toward the key light */
  backlight: number;
  /** rim-light (shared rig) contribution on puff silhouettes */
  rim: number;
  /** ink-like darkening at puff silhouettes (separation against white cloud) */
  edgeDarken: number;
  /** multiplier on the texture density */
  density: number;
  /** exponent of the fire inner->outer gradient (higher = smaller hot centre) */
  fireCore: number;
  /** near-camera fade distances (m from puff surface): invisible at x, opaque at y */
  nearFade: [number, number];
  /** minimum projected size as a fraction of the viewport height (0 = off) */
  minScreen: number;
  /** darken rig-lit smoke by this x luminance of the stage fog colour (bright day stages get smoke a value step below cloud; space stays pale) */
  bgAdapt: number;
}

export const DEFAULT_LOOK: ParticleLook = {
  normalStrength: 0.8,
  stylize: 0.7,
  term: 0.42,
  soft: 0.3,
  frontBias: 0.15,
  keyTint: 0.35,
  ambTint: 0.35,
  backlight: 0.6,
  rim: 0.12,
  edgeDarken: 0.12,
  density: 1.0,
  fireCore: 1.2,
  nearFade: [0.4, 4.0],
  minScreen: 0,
  bgAdapt: 0,
};

// ---------------------------------------------------------------------------
// Procedural puff atlas (2 x 2 cells). R,G = normal xy, B = thickness, A = density.
// ---------------------------------------------------------------------------

class ValueNoise {
  private readonly perm = new Uint8Array(512);
  private readonly val = new Float32Array(256);
  constructor(rng: Rng) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      p[i] = i;
      this.val[i] = rng.next();
    }
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  at(x: number, y: number): number {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const P = this.perm, V = this.val;
    const X = xi & 255, Y = yi & 255;
    const a = V[P[P[X] + Y]], b = V[P[P[X + 1] + Y]];
    const c = V[P[P[X] + Y + 1]], d = V[P[P[X + 1] + Y + 1]];
    const ab = a + (b - a) * u, cd = c + (d - c) * u;
    return ab + (cd - ab) * v;
  }
  fbm(x: number, y: number, oct: number): number {
    let s = 0, amp = 0.5, f = 1, norm = 0;
    for (let o = 0; o < oct; o++) {
      s += this.at(x * f, y * f) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return s / norm;
  }
}

function smax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

let _atlas: THREE.DataTexture | null = null;
/** Build time of the atlas in ms (for the manifest / perf notes). */
export let puffAtlasBuildMs = 0;

/** The shared 512 x 512 puff atlas, generated once from a fixed seed and cached. */
export function puffAtlas(): THREE.DataTexture {
  if (_atlas) return _atlas;
  const t0 = performance.now();
  const CELL = 256;
  const N = CELL * 2;
  const data = new Uint8Array(N * N * 4);
  const root = new Rng(0x70ff);
  const h = new Float32Array(CELL * CELL);
  const n2 = new Float32Array(CELL * CELL);
  for (let cell = 0; cell < 4; cell++) {
    const rng = root.fork(`puff-cell-${cell}`);
    const noise = new ValueNoise(rng.fork('noise'));
    // sphere cluster: one body + lumps around it (cell 2 is elongated for stretched puffs)
    const sx: number[] = [], sy: number[] = [], sr: number[] = [];
    if (cell === 2) {
      for (let i = 0; i < 3; i++) {
        sx.push((i - 1) * 0.36 + rng.range(-0.03, 0.03));
        sy.push(rng.range(-0.05, 0.05));
        sr.push(i === 1 ? 0.46 : rng.range(0.34, 0.4));
      }
    } else {
      sx.push(rng.range(-0.04, 0.04));
      sy.push(rng.range(-0.04, 0.04));
      sr.push(rng.range(0.5, 0.58));
    }
    const lumps = cell === 3 ? 9 : cell === 2 ? 7 : 6 + cell;
    for (let i = 0; i < lumps; i++) {
      const ang = (i / lumps) * Math.PI * 2 + rng.range(-0.35, 0.35);
      const rad = cell === 3 ? rng.range(0.16, 0.27) : rng.range(0.2, 0.33);
      const ex = cell === 2 ? 1.35 : 1.0;
      const d = rng.range(0.3, 0.52);
      let x = Math.cos(ang) * d * ex, y = Math.sin(ang) * d * (cell === 2 ? 0.7 : 1);
      const len = Math.hypot(x, y);
      const maxLen = 0.93 - rad;
      if (len > maxLen) {
        x *= maxLen / len;
        y *= maxLen / len;
      }
      sx.push(x);
      sy.push(y);
      sr.push(rad);
    }
    const ox = rng.range(0, 50), oy = rng.range(0, 50);
    // height field with a wispy noisy edge
    for (let j = 0; j < CELL; j++) {
      const y = ((j + 0.5) / CELL) * 2 - 1;
      for (let i = 0; i < CELL; i++) {
        const x = ((i + 0.5) / CELL) * 2 - 1;
        let hh = 0;
        for (let s = 0; s < sx.length; s++) {
          const dx = x - sx[s], dy = y - sy[s];
          const d2 = sr[s] * sr[s] - dx * dx - dy * dy;
          if (d2 > 0) {
            const z = Math.sqrt(d2);
            hh = hh > 0 ? smax(hh, z, 0.09) : Math.max(hh, z);
          }
        }
        const nz = noise.fbm(x * 3.1 + ox, y * 3.1 + oy, 4);
        const r = Math.hypot(x, y);
        const edgeFade = 1 - Math.min(1, Math.max(0, (r - 0.8) / 0.15)); // keep content inside the cell
        h[j * CELL + i] = hh > 0 ? Math.max(0, (hh + (nz - 0.5) * 0.2) * edgeFade) : 0;
        n2[j * CELL + i] = noise.fbm(x * 6.3 + 17.1, y * 6.3 - 4.2, 3);
      }
    }
    // normals from the height gradient, density from height
    const cx0 = (cell % 2) * CELL, cy0 = Math.floor(cell / 2) * CELL;
    const texel = 2 / CELL;
    for (let j = 0; j < CELL; j++) {
      for (let i = 0; i < CELL; i++) {
        const k = j * CELL + i;
        const hl = h[j * CELL + Math.max(0, i - 1)], hr = h[j * CELL + Math.min(CELL - 1, i + 1)];
        const hd = h[Math.max(0, j - 1) * CELL + i], hu = h[Math.min(CELL - 1, j + 1) * CELL + i];
        let gx = -(hr - hl) / (2 * texel), gy = -(hu - hd) / (2 * texel);
        // clamp steep sphere rims so the normal stays a unit vector with z >= 0
        const gl = Math.hypot(gx, gy);
        const nzv = 1 / Math.sqrt(1 + gl * gl);
        gx *= nzv;
        gy *= nzv;
        const hk = h[k];
        const dens = Math.min(1, Math.max(0, hk / 0.24));
        const densS = dens * dens * (3 - 2 * dens) * (0.8 + 0.2 * n2[k]);
        const o = ((cy0 + j) * N + (cx0 + i)) * 4;
        data[o] = Math.round((gx * 0.5 + 0.5) * 255);
        data[o + 1] = Math.round((gy * 0.5 + 0.5) * 255);
        data[o + 2] = Math.round(Math.min(1, hk / 0.62) * 255);
        data[o + 3] = Math.round(densS * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  _atlas = tex;
  puffAtlasBuildMs = performance.now() - t0;
  return tex;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
attribute vec4 iPos;
attribute vec4 iColA;
attribute vec4 iColB;
attribute vec4 iAxis;
attribute vec4 iMisc;
uniform vec2 uNearFade;
uniform float uMinScreen;
varying vec2 vUv;
varying vec2 vRot;
varying vec4 vColA;
varying vec4 vColB;
varying vec4 vMisc;
varying vec3 vWorldPos;
varying vec3 vAxisU;
varying vec3 vAxisV;
varying vec3 vToCam;
varying float vFade;
void main() {
  vec3 wp = (modelMatrix * vec4(iPos.xyz, 1.0)).xyz;
  vec3 toCam = cameraPosition - wp;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 U = cross(camUp, V);
  float ul = length(U);
  U = ul > 1e-4 ? U / ul : vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 W = cross(V, U);
  float width = iPos.w;
  if (uMinScreen > 0.0) width = max(width, uMinScreen * 2.0 * dist / projectionMatrix[1][1]);
  float halfW = 0.5 * width;
  float halfL = halfW;
  if (iAxis.w > 1.001) {
    vec3 ax = mat3(modelMatrix) * iAxis.xyz;
    float al = length(ax);
    if (al > 1e-5) {
      ax /= al;
      vec3 axp = ax - dot(ax, V) * V;
      float s = length(axp);
      if (s > 1e-3) {
        U = axp / s;
        W = cross(V, U);
        halfL = max(halfW, halfW * iAxis.w * s);
      }
    }
  }
  vec3 corner = wp + U * (position.x * halfL) + W * (position.y * halfW);
  float c = cos(iMisc.x);
  float sn = sin(iMisc.x);
  vUv = vec2(c * position.x - sn * position.y, sn * position.x + c * position.y);
  vRot = vec2(c, sn);
  vAxisU = U;
  vAxisV = W;
  vToCam = V;
  vColA = iColA;
  vColB = iColB;
  vMisc = iMisc;
  vWorldPos = wp;
  vFade = smoothstep(uNearFade.x, uNearFade.y, dist - halfW);
  gl_Position = projectionMatrix * viewMatrix * vec4(corner, 1.0);
}
`;

const FRAG = /* glsl */ `
${GLSL_LIGHTING}
uniform sampler2D uPuffTex;
uniform float uNormalStrength;
uniform float uStylize;
uniform float uTerm;
uniform float uSoft;
uniform float uFrontBias;
uniform float uKeyTint;
uniform float uAmbTint;
uniform float uBacklight;
uniform float uRimAmt;
uniform float uEdgeDarken;
uniform float uDensity;
uniform float uFireCore;
uniform float uBgAdapt;
varying vec2 vUv;
varying vec2 vRot;
varying vec4 vColA;
varying vec4 vColB;
varying vec4 vMisc;
varying vec3 vWorldPos;
varying vec3 vAxisU;
varying vec3 vAxisV;
varying vec3 vToCam;
varying float vFade;

vec3 hueOf(vec3 c) {
  float m = max(max(c.r, c.g), max(c.b, 1e-4));
  return c / m;
}

void main() {
  float shape = floor(vMisc.y + 0.5); // interpolated varying: round before using as an id
  vec2 uv = vUv;
  float dens = 0.0;
  float centre = 0.0;
  float edge = 0.0;
  vec3 N = vToCam;
  // sample the atlas in uniform control flow (derivatives / mip selection must not follow a discard)
  float shp = min(shape, 3.0);
  vec2 cell = vec2(mod(shp, 2.0), floor(shp * 0.5));
  vec4 tx = texture2D(uPuffTex, (clamp(uv, -1.0, 1.0) * 0.5 + 0.5 + cell) * 0.5);
  if (shape < 3.5) {
    // lumpy puff from the atlas, lit through baked normals
    if (dot(uv, uv) >= 1.0) discard;
    dens = clamp(tx.a * uDensity, 0.0, 1.0);
    if (dens < 0.003) discard;
    vec2 nt = tx.rg * 2.0 - 1.0;
    vec2 nq = vec2(vRot.x * nt.x + vRot.y * nt.y, -vRot.y * nt.x + vRot.x * nt.y);
    float nz = sqrt(max(0.0, 1.0 - dot(nq, nq)));
    vec3 Nt = normalize(nq.x * vAxisU + nq.y * vAxisV + nz * vToCam);
    N = normalize(mix(vToCam, Nt, uNormalStrength));
    centre = tx.b;
    edge = 1.0 - smoothstep(0.05, 0.6, tx.a);
  } else if (shape < 4.5) {
    // velocity-aligned streak: bright head, fading tail, hot centre line
    float ay = abs(uv.y);
    float across = exp(-ay * ay * 4.5) * (1.0 - smoothstep(0.75, 1.0, ay));
    float along = 1.0 - smoothstep(0.5, 1.0, abs(uv.x));
    float head = 0.35 + 0.65 * smoothstep(-1.0, 0.9, uv.x);
    dens = across * along * head;
    centre = exp(-ay * ay * 26.0) * along;
  } else if (shape < 5.5) {
    // star burst: core + 4 long rays + 4 short diagonal rays + expanding ring (phase in vMisc.w)
    float r = length(uv);
    float ph = vMisc.w;
    float core = exp(-r * r * 20.0);
    float lenA = mix(0.55, 1.0, smoothstep(0.0, 0.35, ph));
    float ray1 = exp(-abs(uv.x) * 34.0) * (1.0 - smoothstep(0.0, lenA, abs(uv.y)));
    float ray2 = exp(-abs(uv.y) * 34.0) * (1.0 - smoothstep(0.0, lenA, abs(uv.x)));
    vec2 d = vec2(uv.x + uv.y, uv.x - uv.y) * 0.70710678;
    float ray3 = exp(-abs(d.x) * 44.0) * (1.0 - smoothstep(0.0, 0.55 * lenA, abs(d.y)));
    float ray4 = exp(-abs(d.y) * 44.0) * (1.0 - smoothstep(0.0, 0.55 * lenA, abs(d.x)));
    float ringR = mix(0.2, 0.92, ph);
    float ring = exp(-pow((r - ringR) * 16.0, 2.0)) * (1.0 - ph * 0.8);
    dens = clamp(core + max(max(ray1, ray2), 0.7 * max(ray3, ray4)) + 0.7 * ring, 0.0, 1.0);
    centre = clamp(core * 1.4 + 0.5 * max(ray1, ray2), 0.0, 1.0);
  } else if (shape < 6.5) {
    // toon sphere: crisp disc with a hot centre
    float r = length(uv);
    if (r >= 1.0) discard;
    dens = 1.0 - smoothstep(0.84, 1.0, r);
    centre = 1.0 - r * r;
    N = normalize(uv.x * vAxisU + uv.y * vAxisV + sqrt(max(0.0, 1.0 - r * r)) * vToCam);
  } else if (shape < 7.5) {
    // soft glow
    float r2 = dot(uv, uv);
    if (r2 >= 1.0) discard;
    dens = exp(-r2 * 3.5) * (1.0 - r2);
    centre = exp(-r2 * 12.0);
  } else {
    // shard: tumbling kite-shaped fragment, lit as a tilted plate
    float k = abs(uv.x) * 1.0 + abs(uv.y) * 2.1 + uv.x * 0.25;
    dens = 1.0 - smoothstep(0.78, 0.92, k);
    if (dens < 0.003) discard;
    centre = 0.35 + 0.3 * vMisc.w;
    N = normalize(vToCam + (vMisc.w - 0.5) * 1.6 * vAxisU + 0.6 * vAxisV);
  }

  // emissive fire: outer -> inner colour by centreness
  vec3 fire = mix(vColB.rgb, vColA.rgb, pow(clamp(centre, 0.0, 1.0), uFireCore));

  // rig-lit smoke: stylised terminator (screen-projected key) blended with half-lambert
  vec3 K = normalize(uKeyDir);
  float kv = dot(K, vToCam);
  vec3 Kp = K - kv * vToCam;
  float kpl = length(Kp);
  Kp = kpl > 1e-3 ? Kp / kpl : vAxisV;
  float xPhys = dot(N, K) * 0.5 + 0.5;
  float xStyl = 0.5 + 0.5 * dot(N, Kp) + uFrontBias * kv;
  float x = mix(xPhys, xStyl, uStylize);
  float l = smoothstep(uTerm - uSoft, uTerm + uSoft, x);
  vec3 keyHue = hueOf(uKeyColor);
  float hemi = N.y * 0.5 + 0.5;
  vec3 ambHue = hueOf(mix(uAmbGround, uAmbSky, hemi));
  vec3 litC = vColA.rgb * mix(vec3(1.0), keyHue, uKeyTint);
  vec3 shdC = vColB.rgb * mix(vec3(1.0), ambHue, uAmbTint);
  vec3 smoke = mix(shdC, litC, l);
  float fwd = pow(clamp(-kv, 0.0, 1.0), 2.0);
  smoke += litC * keyHue * fwd * (1.0 - clamp(centre, 0.0, 1.0)) * uBacklight;
  smoke += rimTerm(N, vToCam) * uRimAmt * vColA.rgb;
  smoke *= 1.0 - uEdgeDarken * edge;
  float bgLum = dot(uFogColor, vec3(0.2126, 0.7152, 0.0722));
  smoke *= 1.0 - uBgAdapt * clamp(bgLum, 0.0, 1.0) * mix(0.75, 1.15, 1.0 - l);

  vec3 col = mix(fire, smoke, vColB.a);
  float a = dens * vColA.a * vFade;
  if (a < 0.002) discard;
  float occ = vMisc.z;
  col = mix(col, applyFog(col, vWorldPos), occ);
  vec3 enc = linearToOutputTexel(vec4(col, 1.0)).rgb;
  gl_FragColor = vec4(enc * a, a * occ);
}
`;

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

export interface BatchOptions {
  /** sort back-to-front (needed whenever instances occlude, i.e. occlusion > 0) */
  sort: boolean;
  look?: Partial<ParticleLook>;
  name?: string;
  renderOrder?: number;
}

const _inv = new THREE.Matrix4();
const _camL = new THREE.Vector3();
const _fwdL = new THREE.Vector3();

/**
 * A pooled instanced particle batch. Usage per frame:
 *   batch.begin(); for each particle { const o = batch.alloc(); if (o < 0) break; write batch.data[o..o+19] } batch.finish(camera);
 */
export class ParticleBatch {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly material: THREE.ShaderMaterial;
  readonly geometry: THREE.InstancedBufferGeometry;
  readonly capacity: number;
  /** staging array: write instance records here (alloc() returns the float offset) */
  readonly data: Float32Array;
  count = 0;
  private readonly gpu: Float32Array;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private readonly sorted: boolean;
  private readonly qk: Uint16Array;
  private readonly idxA: Uint16Array;
  private readonly idxB: Uint16Array;
  private readonly hist = new Uint32Array(256);
  private readonly range = { start: 0, count: 0 };

  constructor(capacity: number, opts: BatchOptions) {
    this.capacity = Math.max(1, Math.min(65535, Math.floor(capacity)));
    this.sorted = opts.sort;
    this.gpu = new Float32Array(this.capacity * STRIDE);
    this.data = this.sorted ? new Float32Array(this.capacity * STRIDE) : this.gpu;
    this.qk = new Uint16Array(this.capacity);
    this.idxA = new Uint16Array(this.capacity);
    this.idxB = new Uint16Array(this.capacity);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.gpu, STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', new THREE.InterleavedBufferAttribute(this.buffer, 4, OFF.pos));
    g.setAttribute('iColA', new THREE.InterleavedBufferAttribute(this.buffer, 4, OFF.colA));
    g.setAttribute('iColB', new THREE.InterleavedBufferAttribute(this.buffer, 4, OFF.colB));
    g.setAttribute('iAxis', new THREE.InterleavedBufferAttribute(this.buffer, 4, OFF.axis));
    g.setAttribute('iMisc', new THREE.InterleavedBufferAttribute(this.buffer, 4, OFF.misc));
    g.instanceCount = 0;
    this.geometry = g;

    const look = { ...DEFAULT_LOOK, ...(opts.look ?? {}) };
    this.material = new THREE.ShaderMaterial({
      name: opts.name ?? 'vfx-particles',
      uniforms: {
        ...lightUniforms,
        uPuffTex: { value: puffAtlas() },
        uNormalStrength: { value: look.normalStrength },
        uStylize: { value: look.stylize },
        uTerm: { value: look.term },
        uSoft: { value: look.soft },
        uFrontBias: { value: look.frontBias },
        uKeyTint: { value: look.keyTint },
        uAmbTint: { value: look.ambTint },
        uBacklight: { value: look.backlight },
        uRimAmt: { value: look.rim },
        uEdgeDarken: { value: look.edgeDarken },
        uDensity: { value: look.density },
        uFireCore: { value: look.fireCore },
        uNearFade: { value: new THREE.Vector2(look.nearFade[0], look.nearFade[1]) },
        uMinScreen: { value: look.minScreen },
        uBgAdapt: { value: look.bgAdapt },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = opts.name ?? 'vfx-particles';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? 0;
    this.mesh.visible = false;
  }

  /** Update shading uniforms (e.g. when switching variants). */
  setLook(look: Partial<ParticleLook>): void {
    const u = this.material.uniforms;
    if (look.normalStrength !== undefined) u.uNormalStrength.value = look.normalStrength;
    if (look.stylize !== undefined) u.uStylize.value = look.stylize;
    if (look.term !== undefined) u.uTerm.value = look.term;
    if (look.soft !== undefined) u.uSoft.value = look.soft;
    if (look.frontBias !== undefined) u.uFrontBias.value = look.frontBias;
    if (look.keyTint !== undefined) u.uKeyTint.value = look.keyTint;
    if (look.ambTint !== undefined) u.uAmbTint.value = look.ambTint;
    if (look.backlight !== undefined) u.uBacklight.value = look.backlight;
    if (look.rim !== undefined) u.uRimAmt.value = look.rim;
    if (look.edgeDarken !== undefined) u.uEdgeDarken.value = look.edgeDarken;
    if (look.density !== undefined) u.uDensity.value = look.density;
    if (look.fireCore !== undefined) u.uFireCore.value = look.fireCore;
    if (look.nearFade !== undefined) (u.uNearFade.value as THREE.Vector2).set(look.nearFade[0], look.nearFade[1]);
    if (look.minScreen !== undefined) u.uMinScreen.value = look.minScreen;
    if (look.bgAdapt !== undefined) u.uBgAdapt.value = look.bgAdapt;
  }

  begin(): void {
    this.count = 0;
  }

  /** Reserve one instance; returns its float offset in `data`, or -1 when the batch is full. */
  alloc(): number {
    if (this.count >= this.capacity) return -1;
    return this.count++ * STRIDE;
  }

  /** Sort (if enabled) and upload the instances written since begin(). No allocation. */
  finish(camera: THREE.Camera): void {
    const n = this.count;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    if (this.sorted) {
      // camera position / forward in the batch's local space
      this.mesh.updateWorldMatrix(true, false);
      camera.updateMatrixWorld();
      _inv.copy(this.mesh.matrixWorld).invert();
      _camL.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inv);
      const e = camera.matrixWorld.elements;
      _fwdL.set(-e[8], -e[9], -e[10]).transformDirection(_inv);
      const cx = _camL.x, cy = _camL.y, cz = _camL.z;
      const fx = _fwdL.x, fy = _fwdL.y, fz = _fwdL.z;
      const src = this.data, q = this.qk;
      // quantise view depth 0..4096 m into 16 bits (1/16 m resolution)
      for (let i = 0; i < n; i++) {
        const o = i * STRIDE;
        const d = (src[o] - cx) * fx + (src[o + 1] - cy) * fy + (src[o + 2] - cz) * fz;
        const k = d * 16;
        q[i] = k <= 0 ? 0 : k >= 65535 ? 65535 : k | 0;
      }
      this.radix(n);
      // write far -> near
      const dst = this.gpu, order = this.idxA;
      let w = 0;
      for (let k = n - 1; k >= 0; k--) {
        const so = order[k] * STRIDE;
        for (let f = 0; f < STRIDE; f++) dst[w + f] = src[so + f];
        w += STRIDE;
      }
    }
    const b = this.buffer;
    b.updateRanges.length = 0;
    this.range.start = 0;
    this.range.count = n * STRIDE;
    b.updateRanges.push(this.range);
    b.needsUpdate = true;
  }

  /** Stable LSD radix sort of indices 0..n-1 by qk (ascending) into idxA. */
  private radix(n: number): void {
    const q = this.qk, a = this.idxA, b = this.idxB, h = this.hist;
    h.fill(0);
    for (let i = 0; i < n; i++) h[q[i] & 255]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      const c = h[i];
      h[i] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) b[h[q[i] & 255]++] = i;
    h.fill(0);
    for (let i = 0; i < n; i++) h[q[b[i]] >> 8]++;
    sum = 0;
    for (let i = 0; i < 256; i++) {
      const c = h[i];
      h[i] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const j = b[i];
      a[h[q[j] >> 8]++] = j;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Write one full instance record at float offset o. */
export function writeInstance(
  d: Float32Array,
  o: number,
  x: number, y: number, z: number, width: number,
  ar: number, ag: number, ab: number, alpha: number,
  br: number, bg: number, bb: number, lit: number,
  axx: number, axy: number, axz: number, stretch: number,
  rot: number, shape: number, occlusion: number, seed: number,
): void {
  d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = width;
  d[o + 4] = ar; d[o + 5] = ag; d[o + 6] = ab; d[o + 7] = alpha;
  d[o + 8] = br; d[o + 9] = bg; d[o + 10] = bb; d[o + 11] = lit;
  d[o + 12] = axx; d[o + 13] = axy; d[o + 14] = axz; d[o + 15] = stretch;
  d[o + 16] = rot; d[o + 17] = shape; d[o + 18] = occlusion; d[o + 19] = seed;
}

/** Linear-space RGB of a token hex into a small Float32Array (cached per call site). */
export function linearRGB(hex: string, intensity = 1, out = new Float32Array(3)): Float32Array {
  const c = new THREE.Color(hex);
  out[0] = c.r * intensity;
  out[1] = c.g * intensity;
  out[2] = c.b * intensity;
  return out;
}

/** Smooth 0..1 easing helpers (no allocation). */
export const ease = {
  outCubic: (t: number) => 1 - (1 - t) * (1 - t) * (1 - t),
  outQuad: (t: number) => 1 - (1 - t) * (1 - t),
  inOutSine: (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  smooth: (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  },
};
