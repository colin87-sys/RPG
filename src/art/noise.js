/**
 * noise.js — the procedural substrate every surface in the game is built from.
 *
 * Two families live here and they exist for different reasons:
 *
 *   1. **Simplex** (`simplex3`, `simplex4`) — isotropic, artefact-free, but the
 *      gradient lattice is unbounded so it cannot be made to repeat by itself.
 *      Used for analytic/volumetric work (curl fields, VFX, terrain) and, via
 *      the 4D torus mapping, for the mathematically exact tileable path.
 *   2. **Periodic gradient (Perlin) noise** (`perlin3p`) — a classic value-
 *      gradient lattice whose integer coordinates are wrapped modulo an
 *      explicit period before hashing. Wrapping the *lattice* rather than the
 *      *sample point* is what makes a texture seamless: the field is genuinely
 *      periodic, not cross-faded, so there is no ghosting band at the seam.
 *
 * Texture generation runs ~10 noise evaluations per texel across a quarter of a
 * million texels, so the periodic-Perlin path is the workhorse — it costs one
 * eighth of a 4D simplex evaluation and tiles exactly. The 4D torus path
 * (`simplexTile2`) is kept for fields where perfect isotropy matters more than
 * throughput, because a Perlin lattice has faint axis-aligned structure that a
 * dune ripple or a brushed-metal streak would amplify.
 *
 * Determinism: the permutation table is shuffled with `Rng` from core/GameState
 * — the same xorshift the rest of the game uses — never `Math.random()`. Each
 * `Noise` instance takes an explicit seed so a caller's output never depends on
 * how many other callers ran first. That matters more than it sounds: textures
 * are generated lazily on first request, so call order changes with the scene.
 *
 * OWNED BY: art. No other module writes here.
 */
import { Rng } from '../core/GameState.js';

/**
 * A 256-entry permutation (the classic Perlin size) caps exact tiling at a
 * period of 256 lattice cells. Our highest octave asks for 512+ cells across a
 * 1024px map, so the table is widened to 1024. Cost is identical at runtime —
 * it is one extra indirection into a slightly larger array — and it buys four
 * times the seamless period.
 */
const PERM_SIZE = 1024;
const PERM_MASK = PERM_SIZE - 1;

/** The 12 edge-midpoint gradients of a cube. Uniform directions, no bias. */
// prettier-ignore
const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/** The 32 4D gradients used by Gustavson's simplex — vertices of a 4-cube edge set. */
// prettier-ignore
const GRAD4 = new Float32Array([
  0, 1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1,
  0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1,
  1, 0, 1, 1, 1, 0, 1, -1, 1, 0, -1, 1, 1, 0, -1, -1,
  -1, 0, 1, 1, -1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1,
  1, 1, 0, 1, 1, 1, 0, -1, 1, -1, 0, 1, 1, -1, 0, -1,
  -1, 1, 0, 1, -1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, -1,
  1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1, 0,
  -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 0,
]);

const F3 = 1 / 3;
const G3 = 1 / 6;
const F4 = (Math.sqrt(5) - 1) / 4;
const G4 = (5 - Math.sqrt(5)) / 20;

const TAU = Math.PI * 2;

/** Quintic fade — C2 continuous, so Sobel-derived normals stay smooth. */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Integer hash for cellular feature points. `Math.imul` is mandatory here:
 * plain `*` on int32-sized operands silently overflows the 53-bit mantissa and
 * the "hash" degenerates into visible diagonal banding.
 */
function hash3u(x, y, z, seed) {
  let h = Math.imul(x, 0x1657f5) ^ Math.imul(y, 0x27d4eb) ^ Math.imul(z, 0x4c1b3d) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hash3i(x, y, z, seed) {
  return hash3u(x, y, z, seed) / 4294967296;
}

/** 1 / 65536 and 1 / 1024 — bit-field scales for splitting one hash into offsets. */
const INV16 = 1 / 65536;
const INV10 = 1 / 1024;

/** Positive modulo — JS `%` keeps the sign of the dividend, which breaks wrapping. */
function pmod(a, n) {
  const m = a % n;
  return m < 0 ? m + n : m;
}

export class Noise {
  constructor(seed = 0x5eed1e) {
    const r = new Rng(seed >>> 0 || 1);
    const p = new Uint16Array(PERM_SIZE);
    for (let i = 0; i < PERM_SIZE; i++) p[i] = i;
    // Fisher-Yates, drawn from the core RNG so a given seed always produces
    // the same table on every machine and every run.
    for (let i = PERM_SIZE - 1; i > 0; i--) {
      const j = Math.floor(r.next() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    // Doubled tables let the hash chain `perm[a + perm[b + perm[c]]]` index
    // without a mask at every level; a single mask on the outermost lookup is
    // enough because each entry is < PERM_SIZE.
    this.perm = new Uint16Array(PERM_SIZE * 2);
    this.permMod12 = new Uint8Array(PERM_SIZE * 2);
    this.permMod32 = new Uint8Array(PERM_SIZE * 2);
    for (let i = 0; i < PERM_SIZE * 2; i++) {
      const v = p[i & PERM_MASK];
      this.perm[i] = v;
      this.permMod12[i] = v % 12;
      this.permMod32[i] = v & 31;
    }
    this.seed = seed >>> 0;
    /** Scratch for the cellular functions — avoids allocating per texel. */
    this._cell = new Float32Array(4);
    this._vec = new Float32Array(3);
    this._warpOpts = { period: 6, octaves: 4, gain: 0.5, lacunarity: 2, scaleX: 1, scaleY: 1, z: 0 };
    /**
     * Nyquist limit, in lattice cells across the unit square. Octaves finer
     * than this are not detail — they are aliasing, because the sampler cannot
     * resolve a feature narrower than two texels and what lands in the map is
     * a fixed pattern of undersampled garbage that will not filter away in the
     * mip chain. Texture generation sets this to `size / 2`; leaving it at the
     * table limit means "no clamp", for analytic (non-rasterised) callers.
     */
    this.maxPeriod = PERM_SIZE;
  }

  // ---------------------------------------------------------------- gradient

  /**
   * Periodic 3D gradient noise in [-1, 1]. `px/py/pz` are the lattice periods
   * in cells and must be positive integers ≤ 1024 for exact tiling.
   */
  perlin3p(x, y, z, px, py, pz) {
    const perm = this.perm;
    const X = Math.floor(x);
    const Y = Math.floor(y);
    const Z = Math.floor(z);
    const fx = x - X;
    const fy = y - Y;
    const fz = z - Z;
    const u = fade(fx);
    const v = fade(fy);
    const w = fade(fz);

    const x0 = pmod(X, px);
    const y0 = pmod(Y, py);
    const z0 = pmod(Z, pz);
    const x1 = x0 + 1 === px ? 0 : x0 + 1;
    const y1 = y0 + 1 === py ? 0 : y0 + 1;
    const z1 = z0 + 1 === pz ? 0 : z0 + 1;

    const p12 = this.permMod12;
    const a0 = perm[z0];
    const a1 = perm[z1];
    const b00 = perm[y0 + a0];
    const b10 = perm[y1 + a0];
    const b01 = perm[y0 + a1];
    const b11 = perm[y1 + a1];

    const g000 = p12[x0 + b00] * 3;
    const g100 = p12[x1 + b00] * 3;
    const g010 = p12[x0 + b10] * 3;
    const g110 = p12[x1 + b10] * 3;
    const g001 = p12[x0 + b01] * 3;
    const g101 = p12[x1 + b01] * 3;
    const g011 = p12[x0 + b11] * 3;
    const g111 = p12[x1 + b11] * 3;

    const G = GRAD3;
    const fx1 = fx - 1;
    const fy1 = fy - 1;
    const fz1 = fz - 1;

    const n000 = G[g000] * fx + G[g000 + 1] * fy + G[g000 + 2] * fz;
    const n100 = G[g100] * fx1 + G[g100 + 1] * fy + G[g100 + 2] * fz;
    const n010 = G[g010] * fx + G[g010 + 1] * fy1 + G[g010 + 2] * fz;
    const n110 = G[g110] * fx1 + G[g110 + 1] * fy1 + G[g110 + 2] * fz;
    const n001 = G[g001] * fx + G[g001 + 1] * fy + G[g001 + 2] * fz1;
    const n101 = G[g101] * fx1 + G[g101 + 1] * fy + G[g101 + 2] * fz1;
    const n011 = G[g011] * fx + G[g011 + 1] * fy1 + G[g011 + 2] * fz1;
    const n111 = G[g111] * fx1 + G[g111 + 1] * fy1 + G[g111 + 2] * fz1;

    const nx00 = lerp(n000, n100, u);
    const nx10 = lerp(n010, n110, u);
    const nx01 = lerp(n001, n101, u);
    const nx11 = lerp(n011, n111, u);
    // Gradient noise peaks near 1/sqrt(3) with unit-edge gradients; the 1.12
    // gain pushes the practical range to roughly [-1, 1] without clipping.
    return lerp(lerp(nx00, nx10, v), lerp(nx01, nx11, v), w) * 1.12;
  }

  /** Non-periodic gradient noise (period is the full permutation table). */
  perlin3(x, y, z) {
    return this.perlin3p(x, y, z, PERM_SIZE, PERM_SIZE, PERM_SIZE);
  }

  // ----------------------------------------------------------------- simplex

  /** 3D simplex noise in roughly [-1, 1]. Isotropic; no lattice grain. */
  simplex3(xin, yin, zin) {
    const perm = this.perm;
    const p12 = this.permMod12;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else {
      if (y0 < z0) {
        i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
      } else if (x0 < z0) {
        i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
      } else {
        i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      }
    }

    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;

    const ii = i & PERM_MASK, jj = j & PERM_MASK, kk = k & PERM_MASK;
    const G = GRAD3;
    let n = 0;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = p12[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n += t0 * t0 * (G[g] * x0 + G[g + 1] * y0 + G[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = p12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n += t1 * t1 * (G[g] * x1 + G[g + 1] * y1 + G[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = p12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n += t2 * t2 * (G[g] * x2 + G[g + 1] * y2 + G[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = p12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n += t3 * t3 * (G[g] * x3 + G[g + 1] * y3 + G[g + 2] * z3);
    }
    return 32 * n;
  }

  /**
   * 4D simplex noise in roughly [-1, 1]. Exists so a 2D field can be sampled
   * on a torus and tile perfectly in both axes with no lattice anisotropy.
   * Uses the rank-comparison simplex traversal rather than a 64-entry lookup
   * table — same result, no table cache miss.
   */
  simplex4(x, y, z, w) {
    const perm = this.perm;
    const p32 = this.permMod32;
    const s = (x + y + z + w) * F4;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const l = Math.floor(w + s);
    const t = (i + j + k + l) * G4;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    const w0 = w - (l - t);

    // Rank of each coordinate among the four — determines simplex traversal.
    let rx = 0, ry = 0, rz = 0, rw = 0;
    if (x0 > y0) rx++; else ry++;
    if (x0 > z0) rx++; else rz++;
    if (x0 > w0) rx++; else rw++;
    if (y0 > z0) ry++; else rz++;
    if (y0 > w0) ry++; else rw++;
    if (z0 > w0) rz++; else rw++;

    const i1 = rx >= 3 ? 1 : 0, j1 = ry >= 3 ? 1 : 0, k1 = rz >= 3 ? 1 : 0, l1 = rw >= 3 ? 1 : 0;
    const i2 = rx >= 2 ? 1 : 0, j2 = ry >= 2 ? 1 : 0, k2 = rz >= 2 ? 1 : 0, l2 = rw >= 2 ? 1 : 0;
    const i3 = rx >= 1 ? 1 : 0, j3 = ry >= 1 ? 1 : 0, k3 = rz >= 1 ? 1 : 0, l3 = rw >= 1 ? 1 : 0;

    const x1 = x0 - i1 + G4, y1 = y0 - j1 + G4, z1 = z0 - k1 + G4, w1 = w0 - l1 + G4;
    const x2 = x0 - i2 + 2 * G4, y2 = y0 - j2 + 2 * G4, z2 = z0 - k2 + 2 * G4, w2 = w0 - l2 + 2 * G4;
    const x3 = x0 - i3 + 3 * G4, y3 = y0 - j3 + 3 * G4, z3 = z0 - k3 + 3 * G4, w3 = w0 - l3 + 3 * G4;
    const x4 = x0 - 1 + 4 * G4, y4 = y0 - 1 + 4 * G4, z4 = z0 - 1 + 4 * G4, w4 = w0 - 1 + 4 * G4;

    const ii = i & PERM_MASK, jj = j & PERM_MASK, kk = k & PERM_MASK, ll = l & PERM_MASK;
    const G = GRAD4;
    let n = 0;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0 - w0 * w0;
    if (t0 > 0) {
      const g = p32[ii + perm[jj + perm[kk + perm[ll]]]] * 4;
      t0 *= t0;
      n += t0 * t0 * (G[g] * x0 + G[g + 1] * y0 + G[g + 2] * z0 + G[g + 3] * w0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1 - w1 * w1;
    if (t1 > 0) {
      const g = p32[ii + i1 + perm[jj + j1 + perm[kk + k1 + perm[ll + l1]]]] * 4;
      t1 *= t1;
      n += t1 * t1 * (G[g] * x1 + G[g + 1] * y1 + G[g + 2] * z1 + G[g + 3] * w1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2 - w2 * w2;
    if (t2 > 0) {
      const g = p32[ii + i2 + perm[jj + j2 + perm[kk + k2 + perm[ll + l2]]]] * 4;
      t2 *= t2;
      n += t2 * t2 * (G[g] * x2 + G[g + 1] * y2 + G[g + 2] * z2 + G[g + 3] * w2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3 - w3 * w3;
    if (t3 > 0) {
      const g = p32[ii + i3 + perm[jj + j3 + perm[kk + k3 + perm[ll + l3]]]] * 4;
      t3 *= t3;
      n += t3 * t3 * (G[g] * x3 + G[g + 1] * y3 + G[g + 2] * z3 + G[g + 3] * w3);
    }
    let t4 = 0.6 - x4 * x4 - y4 * y4 - z4 * z4 - w4 * w4;
    if (t4 > 0) {
      const g = p32[ii + 1 + perm[jj + 1 + perm[kk + 1 + perm[ll + 1]]]] * 4;
      t4 *= t4;
      n += t4 * t4 * (G[g] * x4 + G[g + 1] * y4 + G[g + 2] * z4 + G[g + 3] * w4);
    }
    return 27 * n;
  }

  /**
   * Exactly tileable 2D noise: the unit square is wrapped onto the surface of
   * a 4D torus (two orthogonal circles) and sampled with 4D simplex. Seamless
   * in both axes by construction, and free of the faint axis-aligned structure
   * a wrapped Perlin lattice carries. Costs ~8x `perlin3p`, so reserve it for
   * fields where the lattice grain would be visible (ripples, brushed metal).
   */
  simplexTile2(u, v, freqU = 1, freqV = 1, phase = 0) {
    const ru = freqU / TAU;
    const rv = freqV / TAU;
    const au = u * TAU;
    const av = v * TAU;
    return this.simplex4(
      Math.cos(au) * ru + phase,
      Math.sin(au) * ru,
      Math.cos(av) * rv,
      Math.sin(av) * rv,
    );
  }

  // -------------------------------------------------------------- fractals

  /**
   * Tileable fractional Brownian motion over the unit square.
   *
   * `period` is the lattice period of the first octave; lacunarity is forced
   * to an integer because a fractional one would make higher octaves
   * incommensurate with the base period and reopen the seam.
   */
  fbm2(u, v, opts = {}) {
    const octaves = opts.octaves ?? 5;
    const gain = opts.gain ?? 0.5;
    const lac = Math.max(2, Math.round(opts.lacunarity ?? 2));
    const sx = opts.scaleX ?? 1;
    const sy = opts.scaleY ?? 1;
    let period = Math.max(1, Math.round(opts.period ?? 8));
    let z = opts.z ?? 0.5;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    const lim = this.maxPeriod;
    for (let o = 0; o < octaves; o++) {
      const px = Math.min(PERM_SIZE, Math.round(period * sx)) || 1;
      const py = Math.min(PERM_SIZE, Math.round(period * sy)) || 1;
      if (o > 0 && (px > lim || py > lim)) break;
      sum += amp * this.perlin3p(u * px, v * py, z, px, py, PERM_SIZE);
      norm += amp;
      amp *= gain;
      period *= lac;
      // Decorrelate octaves by walking the third axis; without this the peaks
      // of successive octaves line up and the result reads as a single scale.
      z += 13.37;
    }
    return sum / norm;
  }

  /**
   * Tileable ridged multifractal in [0, 1]. The weight feedback term is what
   * produces the sharp, branching crest structure — plain `1 - |fbm|` gives
   * soft blobs with creases, not ridges.
   */
  ridged2(u, v, opts = {}) {
    const octaves = opts.octaves ?? 5;
    const gain = opts.gain ?? 0.5;
    const lac = Math.max(2, Math.round(opts.lacunarity ?? 2));
    const sharpness = opts.sharpness ?? 2;
    const sx = opts.scaleX ?? 1;
    const sy = opts.scaleY ?? 1;
    let period = Math.max(1, Math.round(opts.period ?? 6));
    let z = opts.z ?? 3.5;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let weight = 1;
    const lim = this.maxPeriod;
    for (let o = 0; o < octaves; o++) {
      const px = Math.min(PERM_SIZE, Math.round(period * sx)) || 1;
      const py = Math.min(PERM_SIZE, Math.round(period * sy)) || 1;
      if (o > 0 && (px > lim || py > lim)) break;
      let n = 1 - Math.abs(this.perlin3p(u * px, v * py, z, px, py, PERM_SIZE));
      n *= n;
      n *= weight;
      // Successive octaves only appear where the previous one already crested,
      // which is the whole point of a ridged multifractal.
      weight = Math.min(1, n * sharpness);
      sum += amp * n;
      norm += amp;
      amp *= gain;
      period *= lac;
      z += 7.77;
    }
    return sum / norm;
  }

  /** Tileable turbulence — absolute-value fBm. Billowy, good for cloud and smoke. */
  turbulence2(u, v, opts = {}) {
    const octaves = opts.octaves ?? 5;
    const gain = opts.gain ?? 0.5;
    const lac = Math.max(2, Math.round(opts.lacunarity ?? 2));
    const sx = opts.scaleX ?? 1;
    const sy = opts.scaleY ?? 1;
    let period = Math.max(1, Math.round(opts.period ?? 6));
    let z = opts.z ?? 11.5;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    const lim = this.maxPeriod;
    for (let o = 0; o < octaves; o++) {
      const px = Math.min(PERM_SIZE, Math.round(period * sx)) || 1;
      const py = Math.min(PERM_SIZE, Math.round(period * sy)) || 1;
      if (o > 0 && (px > lim || py > lim)) break;
      sum += amp * Math.abs(this.perlin3p(u * px, v * py, z, px, py, PERM_SIZE));
      norm += amp;
      amp *= gain;
      period *= lac;
      z += 5.19;
    }
    return sum / norm;
  }

  /**
   * Tileable domain-warped fBm — Inigo Quilez's two-level warp.
   *
   * Warping keeps its seamlessness because the offset field is itself
   * 1-periodic in (u, v): displacing a periodic function by a periodic
   * displacement is still periodic. This is the single highest-value trick in
   * the file — it is what turns "obviously fBm" into marble, smoke and cloud.
   */
  warp2(u, v, opts = {}) {
    const w1 = opts.warp ?? 0.35;
    const w2 = opts.warp2 ?? w1 * 0.6;
    // A single reused options record: `warp2` is called once per texel across
    // a quarter-million texels, and five object spreads per call would put
    // more pressure on the nursery than the noise evaluations themselves.
    const o = this._warpOpts;
    const oct = opts.octaves ?? 4;
    o.period = opts.period ?? 6;
    // The q/r fields are displacements, not detail: high-frequency content in
    // them only jitters the final lookup by a sub-texel amount while costing a
    // full octave each, four times over. Two octaves is where it stops showing.
    o.octaves = Math.max(2, oct - 1);
    o.gain = opts.gain ?? 0.5;
    o.scaleX = 1;
    o.scaleY = 1;

    o.z = 0.0;
    const qx = this.fbm2(u, v, o);
    o.z = 21.3;
    const qy = this.fbm2(u, v, o);

    o.z = 44.1;
    const rx = this.fbm2(u + w1 * qx, v + w1 * qy, o);
    o.z = 67.9;
    const ry = this.fbm2(u + w1 * qx, v + w1 * qy, o);

    o.period = opts.detailPeriod ?? (opts.period ?? 6);
    o.octaves = opts.detailOctaves ?? oct + 1;
    o.z = 88.5;
    const out = this.fbm2(u + w2 * rx, v + w2 * ry, o);
    if (opts.field) {
      opts.field[0] = rx;
      opts.field[1] = ry;
    }
    return out;
  }

  /** Non-tiling 3D fBm on simplex — for volumetrics and analytic shaping. */
  fbm3(x, y, z, opts = {}) {
    const octaves = opts.octaves ?? 5;
    const gain = opts.gain ?? 0.5;
    const lac = opts.lacunarity ?? 2.02;
    let f = opts.frequency ?? 1;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex3(x * f, y * f, z * f);
      norm += amp;
      amp *= gain;
      f *= lac;
    }
    return sum / norm;
  }

  /** Non-tiling 3D ridged multifractal. */
  ridged3(x, y, z, opts = {}) {
    const octaves = opts.octaves ?? 5;
    const gain = opts.gain ?? 0.5;
    const lac = opts.lacunarity ?? 2.02;
    let f = opts.frequency ?? 1;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let weight = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.simplex3(x * f, y * f, z * f));
      n *= n * weight;
      weight = Math.min(1, n * 2);
      sum += amp * n;
      norm += amp;
      amp *= gain;
      f *= lac;
    }
    return sum / norm;
  }

  // -------------------------------------------------------------- cellular

  /**
   * Periodic 2D Worley/cellular noise.
   *
   * Writes `[F1, F2, cellHash, F2-F1]` into `out` (a shared scratch buffer by
   * default — read it before the next call). Distances are normalised so F1
   * lands in roughly [0, 1] at jitter 1.
   *
   * F1 gives domes and pores, F2-F1 gives crack/facet edges, and the cell hash
   * gives per-cell variation (a pebble's colour, a facet's tilt). Every
   * cellular surface in Textures.js is one of those three reads.
   */
  worley2(u, v, period = 8, jitter = 1, out = this._cell) {
    const p = Math.max(1, Math.round(period));
    const x = u * p;
    const y = v * p;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    let f1 = 8, f2 = 8, id = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox;
        const gy = cy + oy;
        // Hash the *wrapped* cell so the lattice repeats, but measure distance
        // in unwrapped space so the neighbourhood stays continuous at the seam.
        const wx = pmod(gx, p);
        const wy = pmod(gy, p);
        // One hash split into two 16-bit fields rather than two hashes: the
        // cellular functions dominate the cost of leather, crystal and stone,
        // and the second `imul` chain bought nothing that a bit field does not.
        const hu = hash3u(wx, wy, 0, this.seed);
        const h = (hu & 0xffff) * INV16;
        const h2 = (hu >>> 16) * INV16;
        const fx = gx + 0.5 + (h - 0.5) * jitter;
        const fy = gy + 0.5 + (h2 - 0.5) * jitter;
        const dx = fx - x;
        const dy = fy - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          // The cell id must not correlate with the jitter it was split from,
          // or a generator that thresholds on the id (dirt's pebbles) ends up
          // selecting cells by where their feature point happens to sit.
          id = ((hu ^ (hu >>> 11)) >>> 0) / 4294967296;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    out[0] = f1;
    out[1] = f2;
    out[2] = id;
    out[3] = f2 - f1;
    return out;
  }

  /**
   * Anisotropic periodic cellular noise — the cell grid is stretched by
   * (aspectX, aspectY) before distance measurement. Bark furrows and brushed
   * metal need cells that are ten times longer than they are wide; scaling the
   * *distance metric* rather than the *lattice* keeps the tiling exact.
   */
  worleyAniso2(u, v, periodX, periodY, jitter, aspectX, aspectY, out = this._cell) {
    const px = Math.max(1, Math.round(periodX));
    const py = Math.max(1, Math.round(periodY));
    const x = u * px;
    const y = v * py;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    let f1 = 64, f2 = 64, id = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox;
        const gy = cy + oy;
        const hu = hash3u(pmod(gx, px), pmod(gy, py), 31, this.seed);
        const h = (hu & 0xffff) * INV16;
        const h2 = (hu >>> 16) * INV16;
        const dx = (gx + 0.5 + (h - 0.5) * jitter - x) * aspectX;
        const dy = (gy + 0.5 + (h2 - 0.5) * jitter - y) * aspectY;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = ((hu ^ (hu >>> 11)) >>> 0) / 4294967296;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    out[0] = f1;
    out[1] = f2;
    out[2] = id;
    out[3] = f2 - f1;
    return out;
  }

  /** Non-periodic 3D cellular. Same output convention as `worley2`. */
  worley3(x, y, z, jitter = 1, out = this._cell) {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const cz = Math.floor(z);
    let f1 = 64, f2 = 64, id = 0;
    for (let oz = -1; oz <= 1; oz++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox, gy = cy + oy, gz = cz + oz;
          // Three 10-bit fields from one hash. 1/1024 of a cell is far finer
          // than the eye can resolve in a jittered feature point, and 27 cells
          // per sample makes the saved hash chains worth having.
          const hu = hash3u(gx, gy, gz, this.seed);
          const ha = (hu & 1023) * INV10;
          const hb = ((hu >>> 10) & 1023) * INV10;
          const hc = ((hu >>> 20) & 1023) * INV10;
          const dx = gx + 0.5 + (ha - 0.5) * jitter - x;
          const dy = gy + 0.5 + (hb - 0.5) * jitter - y;
          const dz = gz + 0.5 + (hc - 0.5) * jitter - z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < f1) {
            f2 = f1;
            f1 = d;
            id = ((hu ^ (hu >>> 7)) >>> 0) / 4294967296;
          } else if (d < f2) {
            f2 = d;
          }
        }
      }
    }
    out[0] = f1;
    out[1] = f2;
    out[2] = id;
    out[3] = f2 - f1;
    return out;
  }

  // ------------------------------------------------------------------ curl

  /**
   * Curl of a simplex vector potential — a divergence-free field.
   *
   * Divergence-free matters for particles: advecting motes through plain fBm
   * makes them pile up in sinks, which reads as clumping. Curl noise cannot
   * compress, so ambient drift stays evenly distributed forever. Writes into
   * `out` and returns it.
   */
  curl3(x, y, z, eps = 0.1, out = this._vec) {
    const e = eps;
    // Potential components are the same field sampled at large offsets, which
    // is cheaper than three independent noise instances and just as decorrelated.
    const p1 = (a, b, c) => this.simplex3(a, b, c);
    const p2 = (a, b, c) => this.simplex3(a + 31.4, b + 17.2, c + 5.9);
    const p3 = (a, b, c) => this.simplex3(a - 12.7, b + 44.3, c - 23.1);

    const dp3dy = (p3(x, y + e, z) - p3(x, y - e, z)) / (2 * e);
    const dp2dz = (p2(x, y, z + e) - p2(x, y, z - e)) / (2 * e);
    const dp1dz = (p1(x, y, z + e) - p1(x, y, z - e)) / (2 * e);
    const dp3dx = (p3(x + e, y, z) - p3(x - e, y, z)) / (2 * e);
    const dp2dx = (p2(x + e, y, z) - p2(x - e, y, z)) / (2 * e);
    const dp1dy = (p1(x, y + e, z) - p1(x, y - e, z)) / (2 * e);

    out[0] = dp3dy - dp2dz;
    out[1] = dp1dz - dp3dx;
    out[2] = dp2dx - dp1dy;
    return out;
  }
}

/** Shared default instance. Explicitly seeded so captures reproduce. */
export const noise = new Noise(0x2f6e2b1);

/** Per-surface generators take their own instance so lazy call order is irrelevant. */
export function makeNoise(seed) {
  return new Noise(seed);
}

// ------------------------------------------------------------------ helpers

export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

/** Cubic-in-cubic-out step — softer shoulder than smoothstep, no C2 kink. */
export function smootherstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1e-6)));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Integer power by squaring. `Math.pow` measured at 62 ns even with a constant
 * integer exponent — V8 routes it through the generic pow. The texture
 * generators use shaped falloffs (`(1-d)^9` for a vein, `(1-d)^6` for a pit) on
 * every texel of every surface, and this turns ~60 ns into ~8.
 */
export function ipow(x, n) {
  let r = 1;
  let b = x;
  let e = n;
  while (e > 0) {
    if (e & 1) r *= b;
    b *= b;
    e >>= 1;
  }
  return r;
}

export function clamp(x, a = 0, b = 1) {
  return x < a ? a : x > b ? b : x;
}

export function mix(a, b, t) {
  return a + (b - a) * t;
}

/** Wrapped absolute difference on the unit interval — toroidal distance. */
export function torusDelta(a, b) {
  let d = a - b;
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  return d;
}

/**
 * A 1D deterministic hash in [0,1). Used where a generator needs a stable
 * per-index value (thread colour, leaf rotation) without spending RNG state.
 */
export function hash1(i, seed = 0) {
  return hash3i(i | 0, 0, 0, seed | 0);
}

export { hash3i };
