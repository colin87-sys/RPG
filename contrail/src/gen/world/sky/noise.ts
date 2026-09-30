/**
 * Sky lane noise: one tileable 256x256 RGBA value-noise texture (four octaves in
 * four channels), generated once from a fixed seed and cached. The same data is
 * sampled on the CPU (puff atlas bake) and on the GPU (sky, sea, bands, puffs),
 * so every noise pattern is deterministic and GPU-independent (no sin-hash noise).
 *
 * Channels (cells per tile): A = 4, R = 8, G = 16, B = 32.
 */
import * as THREE from 'three';
import { Rng } from '../../../core/rng';

export const NOISE_SIZE = 256;
const CELLS = [8, 16, 32, 4]; // R G B A

let cachedData: Uint8Array | null = null;
let cachedTex: THREE.DataTexture | null = null;

function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function periodicValueNoise(rng: Rng, cells: number, out: Float32Array): void {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rng.next();
  const N = NOISE_SIZE;
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < N; y++) {
    const fy = (y / N) * cells;
    const iy = Math.floor(fy);
    const ty = quintic(fy - iy);
    const y0 = iy % cells, y1 = (iy + 1) % cells;
    for (let x = 0; x < N; x++) {
      const fx = (x / N) * cells;
      const ix = Math.floor(fx);
      const tx = quintic(fx - ix);
      const x0 = ix % cells, x1 = (ix + 1) % cells;
      const a = g[y0 * cells + x0], b = g[y0 * cells + x1];
      const c = g[y1 * cells + x0], d = g[y1 * cells + x1];
      const v = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
      out[y * N + x] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const k = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * k;
}

/** RGBA8 noise data (row 0 = v 0). Built once. */
export function noiseData(): Uint8Array {
  if (cachedData) return cachedData;
  const N = NOISE_SIZE;
  const rng = new Rng(0x5c1e5).fork('sky-noise');
  const data = new Uint8Array(N * N * 4);
  const tmp = new Float32Array(N * N);
  for (let ch = 0; ch < 4; ch++) {
    periodicValueNoise(rng.fork(`ch${ch}`), CELLS[ch], tmp);
    for (let i = 0; i < N * N; i++) data[i * 4 + ch] = Math.round(tmp[i] * 255);
  }
  cachedData = data;
  return data;
}

/** Shared GPU copy (RepeatWrapping, trilinear). Built once. */
export function noiseTexture(): THREE.DataTexture {
  if (cachedTex) return cachedTex;
  const tex = new THREE.DataTexture(noiseData(), NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 8; // grazing views of the cloud sea: no view-aligned mip smear
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  cachedTex = tex;
  return tex;
}

/** CPU bilinear sample, u/v in tile units (1 = one tile), channel 0..3. Returns 0..1. */
export function sampleNoise(u: number, v: number, ch: number): number {
  const d = noiseData();
  const N = NOISE_SIZE;
  const fx = u * N - 0.5, fy = v * N - 0.5;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const x0 = ((ix % N) + N) % N, x1 = (x0 + 1) % N;
  const y0 = ((iy % N) + N) % N, y1 = (y0 + 1) % N;
  const a = d[(y0 * N + x0) * 4 + ch], b = d[(y0 * N + x1) * 4 + ch];
  const c = d[(y1 * N + x0) * 4 + ch], e = d[(y1 * N + x1) * 4 + ch];
  return ((a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty) / 255;
}

/** GLSL: noise sampling helpers. Requires `uniform sampler2D uNoise;` declared by this chunk. */
export const GLSL_SKY_NOISE = /* glsl */ `
uniform sampler2D uNoise;
// fbm in 0..1 (centred ~0.5); p in tile units
float skyFbm(vec2 p) {
  vec4 a = texture2D(uNoise, p);
  vec4 b = texture2D(uNoise, p * 2.03 + vec2(0.37, 0.11));
  return a.a * 0.42 + a.r * 0.26 + a.g * 0.14 + b.g * 0.1 + b.b * 0.08;
}
// cheaper, low-octave fbm for distant samples
float skyFbmLo(vec2 p) {
  vec4 a = texture2D(uNoise, p);
  return a.a * 0.55 + a.r * 0.3 + a.g * 0.15;
}
// hash for small integer-valued inputs (cell indices, ids); stays accurate for |x| < 1e4
float skyHash(float x) {
  return fract(sin(x * 12.9898 + 4.1414) * 43758.5453);
}
`;
