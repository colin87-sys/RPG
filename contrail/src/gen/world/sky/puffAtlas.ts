/**
 * Procedural cumulus puff atlas: 1024x1024 RGBA8, 4x4 cells of 256 px, baked
 * once on the CPU (deterministic) and cached.
 *
 *   R,G = pseudo-normal x,y (0.5 + 0.5 n); z is rebuilt in the shader
 *   B   = baked top-lit occlusion (sky light from above, crease darkening, darker base)
 *   A   = density
 *
 * Cells 0-5: cauliflower cumulus tops (lobes on top, flat base)
 * Cells 6-11: round billows
 * Cells 12-15: wide flat base puffs (stratus / tower bases)
 * The runtime shader tints lit/shadow by the stage key direction using R,G.
 */
import * as THREE from 'three';
import { Rng } from '../../../core/rng';
import { sampleNoise } from './noise';

export const ATLAS_SIZE = 1024;
export const ATLAS_GRID = 4;
export const PUFF_CELLS = { cumulus: [0, 5], round: [6, 11], flat: [12, 15] } as const;

let cached: THREE.DataTexture | null = null;
let cachedData: Uint8Array | null = null;

interface Blob {
  x: number;
  y: number;
  r: number;
  sy: number; // vertical squash (1 = circle)
}

function blobsFor(v: number, rng: Rng): { blobs: Blob[]; base: number } {
  const blobs: Blob[] = [];
  if (v <= 5) {
    // cauliflower top: main dome + lobes around the upper half
    const R = 0.23 + rng.range(-0.02, 0.02);
    blobs.push({ x: rng.range(-0.02, 0.02), y: -0.06, r: R, sy: 1 });
    const n = 5 + (v % 3);
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * (0.12 + (0.76 * (i + rng.range(0.1, 0.9))) / n));
      const d = R * rng.range(0.55, 0.85);
      blobs.push({ x: Math.cos(a) * d, y: -0.06 + Math.sin(a) * d * 0.9, r: rng.range(0.1, 0.16), sy: 1 });
    }
    // low side shoulders
    blobs.push({ x: -R * 0.9, y: -0.14, r: rng.range(0.1, 0.13), sy: 0.9 });
    blobs.push({ x: R * 0.9, y: -0.14, r: rng.range(0.1, 0.13), sy: 0.9 });
    return { blobs, base: -0.22 };
  }
  if (v <= 11) {
    const R = 0.25 + rng.range(-0.02, 0.02);
    blobs.push({ x: 0, y: 0, r: R, sy: 1 });
    const n = 4 + (v % 4);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = R * rng.range(0.4, 0.7);
      blobs.push({ x: Math.cos(a) * d, y: Math.sin(a) * d * 0.8, r: rng.range(0.1, 0.17), sy: 1 });
    }
    return { blobs, base: -0.3 };
  }
  // flat wide base
  const n = 5 + (v % 3);
  for (let i = 0; i < n; i++) {
    const x = -0.3 + (0.6 * (i + 0.5)) / n + rng.range(-0.03, 0.03);
    blobs.push({ x, y: -0.06 + rng.range(-0.02, 0.05), r: rng.range(0.1, 0.16), sy: 0.75 });
  }
  return { blobs, base: -0.12 };
}

function bakeCell(v: number, data: Uint8Array): void {
  const S = ATLAS_SIZE / ATLAS_GRID;
  const cx = v % ATLAS_GRID, cy = Math.floor(v / ATLAS_GRID);
  const rng = new Rng(0x9a11 + v * 7919).fork(`puff${v}`);
  const { blobs, base } = blobsFor(v, rng);
  const nu = rng.range(0, 1), nv = rng.range(0, 1);
  const flat = v >= 12;
  const topDeg = v <= 5;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      let px = (i + 0.5) / S - 0.5;
      let py = (j + 0.5) / S - 0.5;
      // billowy domain warp
      const w1 = sampleNoise(nu + px * 1.2, nv + py * 1.2, 0) - 0.5;
      const w2 = sampleNoise(nu + 0.5 + px * 1.2, nv + 0.3 + py * 1.2, 0) - 0.5;
      px += w1 * 0.045;
      py += w2 * 0.045;
      // union of sphere caps
      let hMax = 0, sdMax = -1;
      let bx = 0, by = 0, br = 1, bsy = 1;
      let h2 = 0;
      for (const b of blobs) {
        const dx = px - b.x, dy = (py - b.y) / b.sy;
        const d2 = dx * dx + dy * dy;
        const sd = b.r - Math.sqrt(d2);
        if (sd > sdMax) sdMax = sd;
        const h = Math.sqrt(Math.max(0, b.r * b.r - d2));
        if (h > hMax) {
          h2 = hMax;
          hMax = h;
          bx = b.x; by = b.y; br = b.r; bsy = b.sy;
        } else if (h > h2) h2 = h;
      }
      const o = ((cy * S + j) * ATLAS_SIZE + (cx * S + i)) * 4;
      // density with noisy soft edge; softer bottom
      const en = sampleNoise(nu + px * 1.6, nv + py * 1.6, 1) - 0.5;
      const bottomSoft = py < base + 0.1 ? 0.06 : 0.035;
      let dens = smooth(-0.012, bottomSoft, sdMax + en * 0.035);
      if (!flat) dens *= smooth(base - 0.05, base + 0.07, py);
      else dens *= smooth(base - 0.02, base + 0.06, py);
      if (dens <= 0.002) {
        data[o] = 128; data[o + 1] = 128; data[o + 2] = 128; data[o + 3] = 0;
        continue;
      }
      // normal of the dominant cap (crease between lobes = normal discontinuity)
      let nx = (px - bx) / br, ny = ((py - by) / bsy) / br;
      const nn = nx * nx + ny * ny;
      if (nn > 1) { const k = 1 / Math.sqrt(nn); nx *= k; ny *= k; }
      // fine billow detail
      const dnx = sampleNoise(nu + px * 1.5, nv + py * 1.5, 1) - 0.5;
      const dny = sampleNoise(nu + 0.21 + px * 1.5, nv + 0.63 + py * 1.5, 1) - 0.5;
      nx = clamp(nx + dnx * 0.3, -0.98, 0.98);
      ny = clamp(ny + dny * 0.3, -0.98, 0.98);
      const nl = Math.hypot(nx, ny);
      if (nl > 0.98) { nx *= 0.98 / nl; ny *= 0.98 / nl; }
      // baked top light: sky from above, crease occlusion, darker base
      const creaseDark = h2 > 0 ? 1 - 0.35 * (1 - smooth(0.0, 0.045, hMax - h2)) : 1;
      const up = 0.62 + 0.38 * (0.5 + 0.5 * ny);
      const baseDark = 0.72 + 0.28 * smooth(base, base + (topDeg ? 0.3 : 0.22), py);
      const ao = clamp(up * baseDark * creaseDark, 0, 1);
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round(ao * 255);
      data[o + 3] = Math.round(clamp(dens, 0, 1) * 255);
    }
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

/** Raw atlas bytes (for debug views). */
export function puffAtlasData(): Uint8Array {
  if (cachedData) return cachedData;
  const data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  for (let v = 0; v < ATLAS_GRID * ATLAS_GRID; v++) bakeCell(v, data);
  cachedData = data;
  return data;
}

/** The cached GPU atlas. */
export function puffAtlas(): THREE.DataTexture {
  if (cached) return cached;
  const tex = new THREE.DataTexture(puffAtlasData(), ATLAS_SIZE, ATLAS_SIZE, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}
