/**
 * Textures.js — every pixel of every surface in AETHERWIND SAGA.
 *
 * There are no image files in this project, so this module is the paint
 * department. Each named surface produces a *full PBR set* — albedo, a normal
 * map derived from a real height field, roughness, and AO or emissive where the
 * material needs it — rendered into an OffscreenCanvas and handed back as
 * `THREE.Texture`s with their colour spaces already correct.
 *
 * Three principles run through all of it:
 *
 * 1. **Height first, normals second.** Every generator writes a scalar height
 *    field and the normal map is Sobel-differentiated from it. Faking normals
 *    from the albedo (the usual shortcut) couples colour to shape and produces
 *    the tell-tale "photo embossed into rubber" look. Deriving them means a
 *    mortar line is dark *because* it is recessed, and the two agree under any
 *    light direction.
 *
 * 2. **Nothing tiles visibly.** Every field is exactly periodic (see noise.js)
 *    and every surface layers 3–5 octaves plus a low-frequency breakup layer
 *    whose period is 1–2 cells across the whole map. Without that breakup layer
 *    a 4-octave fBm reads as a repeating swatch the moment it covers more than
 *    a few metres of ground.
 *
 * 3. **The bible is enforced, not suggested.** Albedo is rescaled per texel
 *    into the linear luminance band `Palette.SURFACE_SPEC` gives for that
 *    surface, and roughness is baked as an absolute value inside the specified
 *    range. A material cannot drift out of the art direction by accident.
 *
 * Determinism: each generator gets its own `Noise` and `Rng` seeded from the
 * surface key. Textures are built lazily on first request, so call order varies
 * with the scene — deriving the seed from the key rather than sharing a global
 * stream is what keeps a capture reproducible.
 *
 * OWNED BY: art.
 */
import * as THREE from 'three';
import { Rng } from '../core/GameState.js';
import { makeNoise, smoothstep, smootherstep, clamp, mix, ipow, hash1 } from './noise.js';
import {
  hexToLinear, linearToByte, luminance, mixHex, hueRotate, chromaClamp, saturationRatio,
  ELEMENT, SURFACE_SPEC, SURFACE_TINT, TEAL_BLACK, element, elementRamp, toonRamp,
  LAWN_BLADE, MEADOW_SOIL, MEADOW_DRY,
} from './Palette.js';

const TAU = Math.PI * 2;
const DEFAULT_SIZE = 512;

// ---------------------------------------------------------------- plumbing

/**
 * OffscreenCanvas keeps generation off the DOM entirely, which matters because
 * a scene load can build a dozen of these and appending real canvases would
 * thrash layout. The DOM fallback exists only for environments that predate it.
 */
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function paint(w, h, bytes) {
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(bytes, w, h), 0, 0);
  return canvas;
}

/**
 * Wrap a canvas as a texture. `srgb` is the single most common source of
 * washed-out or crunchy procedural art: albedo and emissive carry authored
 * colour and must be tagged sRGB so the renderer decodes them, while normal,
 * roughness, AO and metalness are raw numbers and must stay linear.
 */
function texFromCanvas(canvas, { srgb = false, wrap = THREE.RepeatWrapping, mips = true, filter = THREE.LinearFilter, name = '' } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : filter;
  t.magFilter = filter;
  t.name = name;
  t.needsUpdate = true;
  return t;
}

/** Wrapped index helper; every field in this file is toroidal. */
function wrapi(i, n) {
  return i < 0 ? i + n : i >= n ? i - n : i;
}

/**
 * Texels per cycle the *highest* octave of a field must keep. Four is the
 * practical floor for a value-noise lattice: below it the lattice cells stop
 * being resolved by the sample grid and the octave degenerates into per-texel
 * hash, which is uncorrelated between neighbours and therefore survives every
 * stage of minification as shimmer.
 */
const MIN_TEXELS_PER_CYCLE = 4;

/**
 * The largest octave count a band-limited fBm may use at this resolution.
 *
 * The terrain moiré this exists to kill was not a filtering failure — it was
 * baked into the source maps. `fbm2` doubles its period per octave, so grass's
 * `{period: 12, octaves: 4}` put its top octave at 96 cycles across a 256 map
 * (2.7 texels/cycle) and sand's `{period: 200}` grain field at 1.3, both at or
 * past the map's own Nyquist limit *before* any camera got involved. No mip
 * chain can recover a signal that was aliased at generation time: the top mip
 * already contains the fold-back, and every level below it inherits a different
 * random fold, which is exactly the crawling red/green interference the review
 * measured across the mid-ground.
 *
 * So the constraint is enforced here rather than trusted to hand-picked
 * constants. Every ground field asks this function how many octaves it may
 * spend, and the answer is derived from the map it is being written into.
 *
 * Returns fbm2 options, so a caller writes `n.fbm2(u, v, bandLimited(size, 12,
 * 4, { z: 3.3 }))` and cannot express an out-of-band field by accident. The base
 * period is clamped too: an octave count of one does not save a generator that
 * asked for a 200-cycle grain field in the first place.
 *
 * @param {number} size map resolution in texels
 * @param {number} period lattice period of the first octave
 * @param {number} octaves octaves the generator would like
 * @param {Object} [extra] gain, z, lacunarity — passed through untouched
 */
function bandLimited(size, period, octaves, extra = {}) {
  const maxPeriod = Math.max(1, Math.floor(size / MIN_TEXELS_PER_CYCLE));
  const base = Math.min(Math.max(1, Math.round(period)), maxPeriod);
  const room = maxPeriod / base;
  const allowed = room < 2 ? 1 : Math.floor(Math.log2(room)) + 1;
  return { ...extra, period: base, octaves: Math.max(1, Math.min(octaves, allowed)) };
}

/**
 * The scratch a generator fills. Channels are allocated on demand because a
 * 1024² AO buffer nobody reads is 4 MB of pointless garbage per surface.
 */
class SurfaceBuffer {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    /** Linear-light albedo, 3 floats per texel. */
    this.albedo = new Float32Array(this.n * 3);
    /** Height in arbitrary units; only its gradient is used. */
    this.height = new Float32Array(this.n);
    /** Absolute roughness, 0..1. */
    this.rough = new Float32Array(this.n);
    this.ao = null;
    this.emissive = null;
    this.alpha = null;
  }
  useAO() {
    if (!this.ao) this.ao = new Float32Array(this.n).fill(1);
    return this.ao;
  }
  useEmissive() {
    if (!this.emissive) this.emissive = new Float32Array(this.n * 3);
    return this.emissive;
  }
  useAlpha() {
    if (!this.alpha) this.alpha = new Float32Array(this.n).fill(1);
    return this.alpha;
  }
}

/**
 * Sobel normal derivation.
 *
 * A 3×3 Sobel rather than a 2-tap central difference because the height fields
 * carry per-texel noise: central differencing amplifies it into a sparkling
 * normal map that aliases badly under a moving camera, while Sobel's implicit
 * vertical smoothing costs four extra taps and removes it.
 *
 * Sign convention: `texture.flipY` is true by default in three, so data row 0
 * ends up at v = 1. Image-space +y therefore runs opposite to UV +v, which is
 * why the green channel takes `+gy` while red takes `-gx`. Getting this wrong
 * inverts lighting on every bump in the game and is nearly invisible on a
 * symmetric test sphere — hence the note.
 */
function normalFromHeight(height, w, h, strength) {
  const out = new Uint8ClampedArray(w * h * 4);
  // Feature size is defined in UV, so per-texel gradients halve when the map
  // doubles in resolution. Scaling by w/512 keeps apparent bump depth constant.
  const k = strength * (w / 512) * 0.125;
  for (let y = 0; y < h; y++) {
    const ym = wrapi(y - 1, h) * w;
    const y0 = y * w;
    const yp = wrapi(y + 1, h) * w;
    for (let x = 0; x < w; x++) {
      const xm = wrapi(x - 1, w);
      const xp = wrapi(x + 1, w);
      const gx =
        (height[ym + xp] + 2 * height[y0 + xp] + height[yp + xp]) -
        (height[ym + xm] + 2 * height[y0 + xm] + height[yp + xm]);
      const gy =
        (height[yp + xm] + 2 * height[yp + x] + height[yp + xp]) -
        (height[ym + xm] + 2 * height[ym + x] + height[ym + xp]);
      let nx = -gx * k;
      let ny = gy * k;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      const o = (y0 + x) * 4;
      out[o] = (nx * 0.5 + 0.5) * 255;
      out[o + 1] = (ny * 0.5 + 0.5) * 255;
      out[o + 2] = inv * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Ambient occlusion approximated from the height field: a texel is occluded in
 * proportion to how much higher its neighbourhood sits above it. Sampling three
 * radii gives a cheap multi-scale result — the narrow radius catches mortar
 * lines and bark cracks, the wide one catches the general basin a block sits in.
 */
function aoFromHeight(height, w, h, strength) {
  const out = new Float32Array(w * h);
  const radii = [1, 3, 7];
  const weights = [0.5, 0.32, 0.18];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = height[i];
      let occ = 0;
      for (let r = 0; r < radii.length; r++) {
        const R = radii[r];
        let sum = 0;
        // Four-tap cross at each radius; a full disc costs 8x for a difference
        // that vanishes once the map is on geometry.
        sum += height[wrapi(y - R, h) * w + x];
        sum += height[wrapi(y + R, h) * w + x];
        sum += height[y * w + wrapi(x - R, w)];
        sum += height[y * w + wrapi(x + R, w)];
        occ += weights[r] * Math.max(0, sum * 0.25 - c);
      }
      out[i] = clamp(1 - occ * strength, 0, 1);
    }
  }
  return out;
}

/**
 * Fit a generated albedo into the bible's linear luminance band for that
 * surface.
 *
 * The obvious implementation — clamp each texel as it is written — is wrong,
 * and wrong in a way that looks fine in code review and terrible on screen: a
 * surface whose authored colours all sit below the band (cloth, at Y ≈ 0.10
 * against a floor of 0.20) has *every* texel pushed to exactly the floor, and
 * the material arrives as a flat swatch with its entire tonal structure
 * removed. Steel lost its brush streaks to this before it was caught.
 *
 * Fitting after the fact instead measures the surface's own luminance range and
 * maps it linearly onto the band, preserving every relative value the generator
 * produced while still guaranteeing the physical albedo constraint. Chroma
 * ratios are held: only the luminance is rescaled.
 *
 * Texels with zero alpha are excluded from the measurement — a cutout's
 * transparent background is not part of the material and would otherwise drag
 * the range and compress everything visible into the top of the band.
 *
 * `maxSat` is the second half of the contract and applies to the ground
 * surfaces only. Fitting luminance holds chroma *ratios* exactly, so a band fit
 * on its own can hand back a surface that is perfectly in-band and still the
 * most saturated object in the frame — which is what the terrain was. The
 * ceiling is applied after the fit because collapsing chroma about the
 * luminance axis leaves luminance untouched, so the two constraints compose in
 * this order and only this order.
 */
function fitAlbedoBand(buf, band, maxSat = 0) {
  const [lo, hi] = band;
  const a = buf.albedo;
  const ratio = maxSat > 0 ? saturationRatio(maxSat) : 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < buf.n; i++) {
    if (buf.alpha && buf.alpha[i] < 0.02) continue;
    const y = luminance(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
    if (y < min) min = y;
    if (y > max) max = y;
  }
  if (!(max > min)) {
    // Degenerate (a genuinely uniform surface): centre it in the band.
    const mid = (lo + hi) * 0.5;
    for (let i = 0; i < buf.n; i++) {
      const y = luminance(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]) || 1e-5;
      const k = mid / y;
      a[i * 3] *= k; a[i * 3 + 1] *= k; a[i * 3 + 2] *= k;
      if (ratio > 0) chromaClamp(a, i * 3, ratio);
    }
    return;
  }
  const scale = (hi - lo) / (max - min);
  for (let i = 0; i < buf.n; i++) {
    const y = luminance(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
    if (y < 1e-6) {
      a[i * 3] = a[i * 3 + 1] = a[i * 3 + 2] = lo;
      continue;
    }
    const k = (lo + (y - min) * scale) / y;
    a[i * 3] *= k;
    a[i * 3 + 1] *= k;
    a[i * 3 + 2] *= k;
    if (ratio > 0) chromaClamp(a, i * 3, ratio);
  }
}

/** Iterate the texels a stamp of radius (radU, radV) covers, wrapping at the edges. */
function stampRegion(w, h, cu, cv, radU, radV, cb) {
  const x0 = Math.floor((cu - radU) * w);
  const x1 = Math.ceil((cu + radU) * w);
  const y0 = Math.floor((cv - radV) * h);
  const y1 = Math.ceil((cv + radV) * h);
  for (let y = y0; y <= y1; y++) {
    const yy = ((y % h) + h) % h;
    const dv = (y + 0.5) / h - cv;
    for (let x = x0; x <= x1; x++) {
      const xx = ((x % w) + w) % w;
      const du = (x + 0.5) / w - cu;
      cb(yy * w + xx, du, dv);
    }
  }
}

function mix3(a, b, t, out) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/** Stable 32-bit seed from a surface key, so lazy generation order is irrelevant. */
function seedFromKey(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 1;
}

// ---------------------------------------------------------- surface catalogue

/**
 * `bump` is the normal strength; `ao` requests an AO map; `spec` names the
 * `SURFACE_SPEC` entry whose albedo band and roughness range are enforced.
 * `repeat` is the sensible default tiling for a 1 m² of that material.
 *
 * `size` is a budget decision, not a quality one. What matters is *texel
 * density in world space*, and that is resolution divided by repeat: a stone
 * wall at 512² and repeat 2 gives ~1000 texels per metre, while grass at 256²
 * and repeat 12 gives ~3000. The heavily-tiled ground and atmosphere surfaces
 * are therefore generated at half resolution and still out-resolve the hero
 * materials — which takes a full field scene's warm-up from 2.1 s to 1.3 s.
 */
const SURFACES = {
  stone: { spec: 'stone', bump: 4.5, ao: 0.9, repeat: 2 },
  marble: { spec: 'marble', bump: 1.1, ao: 0.35, repeat: 1.5 },
  wood: { spec: 'wood', bump: 2.6, ao: 0.5, repeat: 2 },
  bark: { spec: 'bark', bump: 3.6, ao: 1.35, repeat: 3 },
  foliage: { spec: 'foliage', bump: 2.8, ao: 0.5, repeat: 1, alpha: true, doubleSided: true },
  cloth: { spec: 'cloth', bump: 2.2, ao: 0.45, repeat: 6 },
  silk: { spec: 'silk', bump: 1.4, ao: 0.25, repeat: 6 },
  // `ao` is well under the old 0.8: the hide's height field is now four plates
  // per tile rather than a pore lattice, and an occlusion kernel run over
  // metre-scale domes paints broad dark haloes instead of crease contact.
  leather: { spec: 'leather', bump: 3.4, ao: 0.5, repeat: 4 },
  // Metal bump is deliberately high for a surface whose relief is measured in
  // microns: the grind field is the *only* thing giving a blade internal
  // structure (§4 forbids fractional metalness, so there is no albedo contrast
  // to fall back on), and every consumer of these maps dials `normalScale` down
  // — CharacterFactory binds `steel/normal` at 0.35 on the weapon class. At the
  // old 1.6 that arrived as 0.56 effective and the streaks were gone.
  steel: { spec: 'steel', bump: 2.8, ao: 0.3, repeat: 1 },
  gold: { spec: 'gold', bump: 2.2, ao: 0.75, repeat: 1 },
  crystal: { spec: 'crystal', bump: 3.0, ao: 0.3, repeat: 1, emissive: true },
  sand: { spec: 'sand', bump: 2.4, ao: 0.4, repeat: 8, size: 256 },
  grass: { spec: 'grass', bump: 3.0, ao: 0.7, repeat: 12, size: 256 },
  dirt: { spec: 'dirt', bump: 3.6, ao: 0.85, repeat: 10, size: 256 },
  'water-normal': { spec: 'water', bump: 3.2, ao: 0, repeat: 6, primary: 'normal', noAlbedo: true, size: 256 },
  cloud: { spec: null, bump: 1.6, ao: 0, repeat: 1, alpha: true, size: 256 },
  rune: { spec: null, bump: 2.0, ao: 0, repeat: 1, alpha: true, emissive: true, clamp: true },
};

export const SURFACE_KEYS = Object.keys(SURFACES);
export const RAMP_KEYS = ['ramp-fire', 'ramp-ice', 'ramp-holy', 'ramp-toon'];
export const SPRITE_KEYS = ['spark', 'smoke', 'glow', 'star', 'ember', 'mote', 'streak', 'ring'];
export const UTILITY_KEYS = ['noise-rgb', 'blue-noise', 'macro-ground'];

// ------------------------------------------------------------- generators

/**
 * Stone: cut blocks with recessed mortar, cavity AO in the joints and moss
 * where water would sit. The block grid is jittered per row so it does not read
 * as a chessboard, and each block carries an independent value offset — real
 * masonry's variation is between stones, not within them.
 */
function genStone(buf, n, rng) {
  const { w, h } = buf;
  const base = hexToLinear(0x8e9096, [0, 0, 0]);
  const warm = hexToLinear(0xa89880, [0, 0, 0]);
  const moss = hexToLinear(SURFACE_TINT.MOSS, [0, 0, 0]);
  const mortar = hexToLinear(0x6f6f6e, [0, 0, 0]);
  const col = [0, 0, 0];
  const cell = new Float32Array(4);
  const rows = 5;
  const cols = 3;
  const spec = SURFACE_SPEC.stone;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const rowF = v * rows;
    const row = Math.floor(rowF);
    const vy = rowF - row;
    // Alternate courses are offset half a block; the extra hash-driven slide
    // stops the offset itself from becoming a visible vertical rhythm.
    const slide = (row & 1) * 0.5 + hash1(row, 21) * 0.12;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;
      const colF = u * cols + slide;
      const cIdx = Math.floor(colF);
      const vx = colF - cIdx;
      // The course offset pushes colF past `cols`, so the last partial block on
      // the right is the same stone as the first on the left. Hashing the
      // unwrapped index would give them different colours and open a seam.
      const id = hash1(((cIdx % cols) + cols) % cols * 131 + row * 17, 7);

      // Distance to the nearest joint, in block-local units.
      const dEdge = Math.min(Math.min(vx, 1 - vx) * cols, Math.min(vy, 1 - vy) * rows);
      const joint = 1 - smoothstep(0.02, 0.075, dEdge);

      // Surface: a coarse pit layer plus a fine grain layer, both breakup-modulated.
      const coarse = n.fbm2(u, v, { period: 24, octaves: 4, gain: 0.52, z: 1.3 });
      const grain = n.fbm2(u, v, { period: 96, octaves: 3, gain: 0.45, z: 9.1 });
      n.worley2(u, v, 30, 1, cell);
      const pits = ipow(1 - clamp(cell[0], 0, 1), 6);
      const breakup = n.fbm2(u, v, { period: 2, octaves: 2, gain: 0.5, z: 40.2 });

      // Blocks are domed very slightly so their centres catch light; the joint
      // cuts a hard 0.6-unit trench, which is what gives stone its read.
      let ht = 0.55 + (id - 0.5) * 0.22;
      ht += coarse * 0.16 + grain * 0.05 - pits * 0.12;
      ht += (1 - Math.abs(vx * 2 - 1)) * 0.03 + (1 - Math.abs(vy * 2 - 1)) * 0.02;
      ht -= joint * 0.62;
      buf.height[i] = ht;

      const shade = 0.8 + id * 0.3 + coarse * 0.2 + breakup * 0.16;
      mix3(base, warm, clamp(0.3 + (id - 0.5) * 0.85 + breakup * 0.45, 0, 1), col);
      col[0] *= shade; col[1] *= shade; col[2] *= shade;
      mix3(col, mortar, joint * 0.85, col);

      // Moss only in joints, only where the breakup layer says it is damp, and
      // biased to the upper edge of a course where runoff would collect.
      const damp = smoothstep(0.05, 0.35, breakup + coarse * 0.4);
      const mossAmt = joint * damp * smoothstep(0.55, 0.95, 1 - vy) * 0.8;
      mix3(col, moss, mossAmt, col);

      buf.albedo[i * 3] = col[0];
      buf.albedo[i * 3 + 1] = col[1];
      buf.albedo[i * 3 + 2] = col[2];

      // Joints hold moisture and dust: rougher. Block faces polish slightly.
      buf.rough[i] = clamp(0.78 + joint * 0.14 - id * 0.08 + grain * 0.06, spec.roughness[0], spec.roughness[1]);
    }
  }
}

/**
 * Marble: domain-warped veining. The vein function is a high-power sine of a
 * warped coordinate — that is what produces long continuous filaments instead
 * of the disconnected blobs a thresholded fBm gives. Two vein families cross at
 * different angles so the stone reads as a cut slab, not a wood grain.
 * Contrast is deliberately held under the bible's 0.15 ceiling.
 */
function genMarble(buf, n, rng) {
  const { w, h } = buf;
  const body = hexToLinear(0xf2ece0, [0, 0, 0]);
  const rim = hexToLinear(SURFACE_TINT.MARBLE_RIM, [0, 0, 0]);
  const veinDark = hexToLinear(0x6d7f86, [0, 0, 0]);
  const veinWarm = hexToLinear(0xc2a98c, [0, 0, 0]);
  const col = [0, 0, 0];
  const spec = SURFACE_SPEC.marble;
  const field = [0, 0];

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;

      const warp = n.warp2(u, v, { period: 3, octaves: 3, warp: 0.55, warp2: 0.3, field });
      const s1 = Math.sin((u * 2 + v * 0.7 + warp * 2.4 + field[0] * 0.8) * TAU);
      const s2 = Math.sin((u * -1 + v * 3 + field[1] * 2.1) * TAU);
      // Three widths from two sine families. The exponent *is* the vein width,
      // and it has to be tuned against the mip chain: anything past ~30 is a
      // filament a texel across, which the first mip level erases entirely. So
      // the broad veins carry the read at distance and the hairline only adds
      // bite up close, where it is the sharpest thing on the surface.
      const vein1 = ipow(1 - Math.abs(s1), 9);
      const vein2 = ipow(1 - Math.abs(s2), 15) * 0.7;
      const hair = ipow(1 - Math.abs(s1), 40);
      const micro = n.fbm2(u, v, { period: 64, octaves: 2, gain: 0.5, z: 5.5 });
      const cloudy = n.fbm2(u, v, { period: 2, octaves: 3, gain: 0.55, z: 17.3 });

      // Veins sit a hair proud of the polished body — calcite is harder than
      // the matrix and survives polishing, which is why real marble catches a
      // grazing light along its veins.
      buf.height[i] = vein1 * 0.35 + hair * 0.5 + vein2 * 0.25 + micro * 0.12 + cloudy * 0.05;

      mix3(body, rim, clamp(0.35 + cloudy * 0.9, 0, 1), col);
      const t1 = clamp(vein1, 0, 1);
      mix3(col, veinDark, t1 * 0.85, col);
      mix3(col, veinDark, hair * 0.5, col);
      mix3(col, veinWarm, clamp(vein2, 0, 1) * 0.6, col);
      const shade = 0.94 + micro * 0.08 + cloudy * 0.06;
      col[0] *= shade; col[1] *= shade; col[2] *= shade;

      buf.albedo[i * 3] = col[0];
      buf.albedo[i * 3 + 1] = col[1];
      buf.albedo[i * 3 + 2] = col[2];

      buf.rough[i] = clamp(0.3 + t1 * 0.16 + micro * 0.06 - cloudy * 0.04, spec.roughness[0], spec.roughness[1]);
    }
  }
}

/**
 * Wood: growth rings around an off-canvas pith, warped so the rings wobble the
 * way real timber does, plus a fibre layer running along the grain. Roughness
 * follows the ring structure — earlywood is porous and matte, latewood is dense
 * and takes a sheen. That correlation is what sells wood; uniform roughness on
 * a ring albedo looks like printed laminate.
 */
function genWood(buf, n, rng) {
  const { w, h } = buf;
  const light = hexToLinear(0xb98a54, [0, 0, 0]);
  const dark = hexToLinear(0x6b4526, [0, 0, 0]);
  const deep = hexToLinear(0x3d2415, [0, 0, 0]);
  const col = [0, 0, 0];
  const spec = SURFACE_SPEC.wood;
  // 13 rings across the tile, bowed by a full-period cosine.
  //
  // The intuitive construction — radial distance to a pith placed off-canvas —
  // gives beautiful arcs and does not tile in either axis, because a radius is
  // not a periodic function of u. An integer ring count along v plus a
  // single-period cosine bow along u produces the same tangential-cut arcs and
  // repeats exactly, which is what a plank atlas actually needs.
  const RINGS = 13;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;

      const wob = n.fbm2(u, v, { period: 3, octaves: 3, gain: 0.5, z: 2.2, scaleX: 1, scaleY: 3 });
      const ringF = v * RINGS + Math.cos(u * TAU) * 1.15 + wob * 1.6;
      const ring = ringF - Math.floor(ringF);
      // Asymmetric ring profile: latewood is a narrow dark band on one side.
      const late = ipow(1 - Math.abs(ring * 2 - 1), 3);
      const fibre = n.fbm2(u, v, { period: 6, octaves: 4, gain: 0.55, z: 30.1, scaleX: 1, scaleY: 40 });
      const knotN = n.fbm2(u, v, { period: 2, octaves: 2, gain: 0.5, z: 61.7 });
      const knot = ipow(clamp(knotN * 1.6, 0, 1), 6);

      buf.height[i] = -late * 0.35 + fibre * 0.22 - knot * 0.4;

      mix3(light, dark, clamp(late * 0.85 + fibre * 0.28 + 0.06, 0, 1), col);
      mix3(col, deep, knot * 0.8, col);
      const shade = 0.9 + wob * 0.16 + fibre * 0.1;
      col[0] *= shade; col[1] *= shade; col[2] *= shade;

      buf.albedo[i * 3] = col[0];
      buf.albedo[i * 3 + 1] = col[1];
      buf.albedo[i * 3 + 2] = col[2];

      buf.rough[i] = clamp(0.66 - late * 0.1 + fibre * 0.12 + knot * 0.06, spec.roughness[0], spec.roughness[1]);
    }
  }
}

/**
 * Bark: vertical ridges from an anisotropic ridged multifractal, with deep
 * cracks carved by the F2−F1 edges of a strongly stretched cellular field.
 * The two must agree — cracks run *between* ridges, not across them — which is
 * why both are driven from the same anisotropy ratio.
 */
function genBark(buf, n, rng) {
  const { w, h } = buf;
  const bark = hexToLinear(0x6b5a48, [0, 0, 0]);
  const pale = hexToLinear(0x9a8b76, [0, 0, 0]);
  const crackCol = hexToLinear(0x1d150f, [0, 0, 0]);
  const moss = hexToLinear(SURFACE_TINT.MOSS, [0, 0, 0]);
  const col = [0, 0, 0];
  const cell = new Float32Array(4);
  const spec = SURFACE_SPEC.bark;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;

      const ridge = n.ridged2(u, v, { period: 4, octaves: 4, gain: 0.5, scaleX: 7, scaleY: 1, z: 3.1 });
      const fine = n.ridged2(u, v, { period: 8, octaves: 3, gain: 0.45, scaleX: 9, scaleY: 2, z: 12.4 });
      n.worleyAniso2(u, v, 14, 3, 0.9, 1, 0.32, cell);
      const crack = ipow(1 - smoothstep(0.0, 0.16, cell[3]), 2);
      const breakup = n.fbm2(u, v, { period: 2, octaves: 2, gain: 0.55, z: 51.9 });

      const ht = ridge * 0.75 + fine * 0.28 - crack * 0.95 + breakup * 0.12;
      buf.height[i] = ht;

      mix3(bark, pale, clamp(ridge * 1.1 + breakup * 0.35, 0, 1), col);
      mix3(col, crackCol, crack * 0.92, col);
      // Moss on the sheltered side of ridges, gated by the breakup layer so it
      // appears in patches rather than uniformly along every crack.
      const mossAmt = clamp((1 - ridge) * smoothstep(0.1, 0.45, breakup) - crack * 0.6, 0, 1) * 0.45;
      mix3(col, moss, mossAmt, col);

      buf.albedo[i * 3] = col[0];
      buf.albedo[i * 3 + 1] = col[1];
      buf.albedo[i * 3 + 2] = col[2];

      buf.rough[i] = clamp(0.88 - ridge * 0.06 + crack * 0.05, spec.roughness[0], spec.roughness[1]);
    }
  }
}

/**
 * Foliage: a tileable leaf mass on transparent background, usable both as a
 * canopy card and as a cutout texture. Leaves are stamped (not evaluated per
 * texel against every leaf) — 30 stamps of ~40×40 texels is a thousandth of the
 * work of a per-texel loop over 30 SDFs, and the result is identical.
 *
 * Two-tone per the bible: `FOLIAGE_LIT` on the blade, `FOLIAGE_UNDER` toward
 * the edges and the leaves stamped earliest (which end up underneath).
 */
function genFoliage(buf, n, rng) {
  const { w, h } = buf;
  const lit = hexToLinear(SURFACE_TINT.FOLIAGE_LIT, [0, 0, 0]);
  const under = hexToLinear(SURFACE_TINT.FOLIAGE_UNDER, [0, 0, 0]);
  const dry = hexToLinear(0xa8934a, [0, 0, 0]);
  const spec = SURFACE_SPEC.foliage;
  const alpha = buf.useAlpha();
  alpha.fill(0);
  const depth = new Float32Array(buf.n).fill(-1);
  const col = [0, 0, 0];

  // Under-canopy: the gaps between leaves are not empty, they are the shadowed
  // mass behind. Filling them keeps mip levels from fading to grey.
  for (let i = 0; i < buf.n; i++) {
    buf.albedo[i * 3] = under[0] * 0.5;
    buf.albedo[i * 3 + 1] = under[1] * 0.5;
    buf.albedo[i * 3 + 2] = under[2] * 0.5;
    buf.rough[i] = 0.6;
  }

  const LEAVES = 34;
  for (let l = 0; l < LEAVES; l++) {
    const cu = rng.next();
    const cv = rng.next();
    const ang = rng.range(0, TAU);
    const len = rng.range(0.14, 0.24);
    const wid = len * rng.range(0.3, 0.44);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const z = l / LEAVES;
    const dryAmt = Math.pow(rng.next(), 3) * 0.7;
    const hueJit = rng.range(-14, 14);
    const leafLit = hexToLinear(hueRotate(SURFACE_TINT.FOLIAGE_LIT, hueJit), [0, 0, 0]);
    const value = rng.range(0.78, 1.18);
    // Oriented AABB rather than a circumscribed square: a leaf is three times
    // longer than it is wide, so the square wastes two thirds of its texels on
    // an early reject. At 34 leaves that is the difference between 1.5 M and
    // 0.4 M callback invocations.
    const radU = (Math.abs(ca) * len + Math.abs(sa) * wid) * 1.15;
    const radV = (Math.abs(sa) * len + Math.abs(ca) * wid) * 1.15;

    stampRegion(w, h, cu, cv, radU, radV, (i, du, dv) => {
      // Rotate into leaf space; a = along the midrib, b = across it.
      const a = (du * ca + dv * sa) / len;
      const b = (-du * sa + dv * ca) / wid;
      if (a < -1 || a > 1) return;
      // Blade profile: widest at a third of the length, tapering to a point.
      const halfWidth = Math.pow(clamp(1 - a * a, 0, 1), 0.62) * (0.72 + 0.28 * (1 - a));
      const d = halfWidth - Math.abs(b);
      if (d <= 0) return;
      const cover = smoothstep(0, 0.06, d);
      if (z < depth[i] && alpha[i] > 0.5) return;
      depth[i] = z;

      const rib = Math.exp(-Math.abs(b) * 14) * 0.8;
      const veins = ipow(Math.abs(Math.cos((a * 6 + Math.abs(b) * 3.5) * Math.PI)), 6) * 0.3 * (1 - Math.abs(b));
      const edgeDark = 1 - smoothstep(0, 0.55, d / Math.max(1e-4, halfWidth));

      buf.height[i] = rib + veins - edgeDark * 0.25 + (1 - a) * 0.1;

      mix3(leafLit, under, edgeDark * 0.75, col);
      mix3(col, dry, dryAmt * smoothstep(0.2, 1.0, a * 0.5 + 0.5), col);
      col[0] *= value; col[1] *= value; col[2] *= value;
      buf.albedo[i * 3] = col[0];
      buf.albedo[i * 3 + 1] = col[1];
      buf.albedo[i * 3 + 2] = col[2];
      // Cuticle is glossier than the blade; midribs stay matte.
      buf.rough[i] = clamp(0.58 - rib * 0.12 + veins * 0.05, spec.roughness[0], spec.roughness[1]);
      alpha[i] = Math.max(alpha[i], cover);
    });
  }
}

/**
 * Cloth: a real over/under weave evaluated at thread level, not a noise field
 * pretending to be one. Each texel knows which thread it is on and whether that
 * thread passes over or under at this crossing, so the height field has the
 * correct interlocking ridges and the normal map reads as fabric at grazing
 * angles. Fuzz is added on top; without it the weave looks like moulded plastic.
 */
function genCloth(buf, n, rng) {
  const { w, h } = buf;
  const dye = hexToLinear(0x3f5f70, [0, 0, 0]);
  const dyeAlt = hexToLinear(0x54798a, [0, 0, 0]);
  const spec = SURFACE_SPEC.cloth;
  const col = [0, 0, 0];
  const THREADS = 48; // ~10 texels per thread at 512 — a legible weave, not moiré

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const tv = v * THREADS;
    const iv = Math.floor(tv);
    const fv = tv - iv;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;
      const tu = u * THREADS;
      const iu = Math.floor(tu);
      const fu = tu - iu;

      const over = (iu + iv) & 1;
      // Rounded thread cross-section: cos gives the correct cylindrical bulge.
      const warpH = Math.cos((fu - 0.5) * Math.PI);
      const weftH = Math.cos((fv - 0.5) * Math.PI);
      const ht = over ? warpH * 0.85 + weftH * 0.2 : weftH * 0.85 + warpH * 0.2;

      const fuzz = n.fbm2(u, v, { period: 128, octaves: 3, gain: 0.5, z: 4.4 });
      const slub = n.fbm2(u, v, { period: 8, octaves: 3, gain: 0.5, z: 22.8 });
      const breakup = n.fbm2(u, v, { period: 2, octaves: 2, gain: 0.5, z: 71.2 });
      buf.height[i] = ht * 0.7 + fuzz * 0.16 + slub * 0.1;

      // Per-thread dye variation: real dyed yarn is never uniform, and this is
      // the difference between "cloth" and "a blue box".
      const threadId = over ? hash1(iu, 3) : hash1(iv + 4096, 3);
      mix3(dye, dyeAlt, clamp(0.35 + threadId * 0.32 + breakup * 0.4, 0, 1), col);
      const shade = 0.72 + ht * 0.3 + fuzz * 0.14 + slub * 0.08;
      col[0] *= shade; col[1] *= shade; col[2] *= shade;

      buf.albedo[i * 3] = col[0];
      buf.albedo[i * 3 + 1] = col[1];
      buf.albedo[i * 3 + 2] = col[2];

      // Thread crowns are compressed and slightly smoother; the valleys hold
      // fibre ends and are maximally rough.
      buf.rough[i] = clamp(0.9 - ht * 0.1 + fuzz * 0.06, spec.roughness[0], spec.roughness[1]);
    }
  }
}

/**
 * Silk: dense warp threads with almost no weft relief, plus a long-wavelength
 * moiré from the slight irregularity of the warp spacing. The anisotropic sheen
 * itself is a shading term (the material sets `anisotropy` along the warp) —
 * what the texture supplies is the directional micro-structure that makes that
 * sheen believable and a hue drift that reads as shot silk.
 */
function genSilk(buf, n, rng) {
  const { w, h } = buf;
  const spec = SURFACE_SPEC.silk;
  const warmHex = 0x8a5f6e;
  const coolHex = 0x455f7a;
  const warm = hexToLinear(warmHex, [0, 0, 0]);
  const cool = hexToLinear(coolHex, [0, 0, 0]);
  const specTint = hexToLinear(SURFACE_TINT.SILK_SPEC, [0, 0, 0]);
  const col = [0, 0, 0];
  const WARPS = 180;

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;

      const jitter = n.fbm2(u, v, { period: 4, octaves: 2, gain: 0.5, z: 8.8, scaleX: 1, scaleY: 6 }) * 0.35;
      const tv = (v + jitter / WARPS) * WARPS;
      const fv = tv - Math.floor(tv);
      const thread = Math.cos((fv - 0.5) * Math.PI);
      const streak = n.fbm2(u, v, { period: 3, octaves: 4, gain: 0.55, z: 15.2, scaleX: 1, scaleY: 48 });
      const drape = n.fbm2(u, v, { period: 2, octaves: 3, gain: 0.6, z: 33.6 });

      buf.height[i] = thread * 0.4 + streak * 0.35 + drape * 0.25;

      // Shot silk: warp and weft dyed differently, so the perceived hue swings
      // with the drape. The two dyes are chosen at matched luminance, so the
      // hue swing never disturbs the value structure — a silhouette test of
      // this material reads as one flat shape, which is what the bible wants.
      mix3(warm, cool, clamp(0.5 + drape * 0.65, 0, 1), col);
      mix3(col, specTint, clamp(thread * 0.5 + streak * 0.4, 0, 1) * 0.22, col);
      const shade = 0.85 + thread * 0.2 + drape * 0.12;
      col[0] *= shade; col[1] *= shade; col[2] *= shade;

      buf.albedo[i * 3] = col[0];
      buf.albedo[i * 3 + 1] = col[1];
      buf.albedo[i * 3 + 2] = col[2];

      buf.rough[i] = clamp(0.42 - thread * 0.1 - streak * 0.06, spec.roughness[0], spec.roughness[1]);
    }
  }
}

/**
 * Leather — the **creature hide**, and therefore a character surface.
 *
 * The only thing in frame wearing this map is the shardhusk's shell, which
 * makes `leather` the one surface in the library that lands on a character. It
 * used to be authored as photoreal hide: a 90-cell pore field, a 26-cell coarse
 * cellular layer, domain-warped wrinkles, and a warm `worn` tone (#8A6440)
 * sprayed over the dark base wherever a wear mask cleared its threshold. On a
 * 3.4 m creature at repeat 3 that puts roughly 270 pore cells across the
 * silhouette — per-pixel by the time it reaches the battle camera — and the
 * review read the warm speckle for exactly what it is: rust. ANIME_PIPELINE's
 * absolute rule is that no procedural noise texture ever touches a character
 * surface, so tuning the pore frequency was never an option; the technique had
 * to go.
 *
 * What replaces it is the anime read of a hide: **flat colour, and form carried
 * entirely by shading.** Three consequences:
 *
 * - **Albedo is a single constant.** Not "low contrast" — constant. Any
 *   variation at all would be re-normalised across the full §4 albedo band by
 *   `fitAlbedoBand`, which turns a 1% authored drift into a 100% swing; and a
 *   character's colour zones are supposed to come from vertex colour and
 *   material tint, never from a texture. `fitAlbedoBand`'s degenerate branch
 *   centres the constant in the band, so the physical constraint still holds.
 * - **Height carries plates, not grain.** Four cells across the tile — about
 *   35 cm of creature per plate — domed slightly and separated by a crease at
 *   the cell boundary. Under cel shading a crease resolves as a drawn panel
 *   line and the plate between it stays a flat block, which is the same
 *   contract the party's cloth zones honour.
 * - **Roughness is constant.** The husk binds this map with a scalar of 1, so a
 *   varying roughness would modulate its one specular band into a mottled
 *   field — the highlight equivalent of the albedo speckle.
 */
function genLeather(buf, n, rng) {
  const { w, h } = buf;
  const hide = hexToLinear(0x53392a, [0, 0, 0]);
  const spec = SURFACE_SPEC.leather;
  const rough = (spec.roughness[0] + spec.roughness[1]) * 0.5;
  const cell = new Float32Array(4);

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;

      // Four cells, high jitter: irregular plates rather than a visible lattice.
      n.worley2(u, v, 4, 0.95, cell);
      // F1 is continuous across the whole tile, so using it directly domes each
      // plate without introducing a step anywhere except the crease itself.
      const dome = 1 - smoothstep(0.05, 0.62, cell[0]);
      const crease = 1 - smoothstep(0.0, 0.09, cell[3]);
      // One slow undulation so a large flat panel of hide is not mathematically
      // flat. Two octaves at period 2 is half a tile per feature — form, at a
      // frequency no camera in this game can resolve as texture.
      const sag = n.fbm2(u, v, { period: 2, octaves: 2, gain: 0.5, z: 44.4 });

      buf.height[i] = dome * 0.9 + sag * 0.35 - crease * 0.85;

      buf.albedo[i * 3] = hide[0];
      buf.albedo[i * 3 + 1] = hide[1];
      buf.albedo[i * 3 + 2] = hide[2];

      buf.rough[i] = rough;
    }
  }
}

/**
 * Steel and gold share a substrate: a brushed anisotropic grind field along U
 * (the blade axis), micro-pitting from a fine cellular layer, a bevel/hone band
 * structure, and a broad polish-variation layer. They differ in tint, in how
 * much grime collects, and in how deep the pitting cuts — gold is soft and
 * dents, steel is hard and pits.
 *
 * Three things here are doing the heavy lifting and none of them is obvious.
 *
 * **The grind must survive the mip chain.** §4 makes anisotropic streaking
 * mandatory on metal and §7.13 makes its absence a never-ship, but a single
 * mid-frequency streak layer averages to flat by mip 3 and every blade in the
 * game is between four and twenty pixels wide. So the streaks are built from
 * three explicitly chosen bands — roughly 44, 120 and 128 lattice cells across
 * V against 2–3 across U — instead of one fBm stack. The coarsest band is what
 * still reads at battle distance; the finest is what carries the roughness
 * variance that keeps the highlight from collapsing to a dot in a closeup.
 *
 * **The highlight has to move.** A blade whose roughness is uniform gives a
 * static specular line wherever the geometry happens to face the key. Baking
 * the grind into *roughness* as well as into the normal means the reflected band
 * breaks, brightens and slides along the blade as the camera drifts, which is
 * the difference between "metal" and "a white decal".
 *
 * **Edge wear.** §4 asks for "edge wear lightening" on steel by name. `band` is
 * a very low frequency field across V and a slow one along U, so its crests form
 * long strips running the length of the blade; the abrasive bit hardest there,
 * so those strips lose their oxide, lighten toward `wear`, and drop to the
 * bottom of the roughness range. That is the only cue that distinguishes a
 * ground blade from a painted lozenge in silhouette-adjacent lighting.
 *
 * `metal` is 'steel' or 'gold'.
 */
function genMetal(buf, n, rng, metal) {
  const { w, h } = buf;
  const isGold = metal === 'gold';
  const spec = isGold ? SURFACE_SPEC.gold : SURFACE_SPEC.steel;
  const baseA = hexToLinear(isGold ? SURFACE_TINT.GOLD_BRIGHT : 0xb2bcc4, [0, 0, 0]);
  const baseB = hexToLinear(isGold ? SURFACE_TINT.GOLD_DEEP : 0x717c86, [0, 0, 0]);
  // Bare, freshly abraded metal: brighter and bluer than the oxidised field on
  // steel, brighter and warmer on gold.
  const wear = hexToLinear(isGold ? 0xffe6b8 : 0xe4ebf0, [0, 0, 0]);
  const grime = hexToLinear(isGold ? SURFACE_TINT.GOLD_GRIME : 0x27303a, [0, 0, 0]);
  const rLo = spec.roughness[0];
  const rHi = spec.roughness[1];
  const col = [0, 0, 0];
  const cell = new Float32Array(4);

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;

      // scaleY >> scaleX gives features an order of magnitude longer along U
      // than across it: the grind lines a belt leaves. The three bands are
      // sampled separately rather than as octaves of one fBm so their relative
      // weights can be tuned against the mip level each one dies at.
      const grindA = n.fbm2(u, v, { period: 2, octaves: 2, gain: 0.55, z: 6.6, scaleX: 1, scaleY: 22 });
      const grindB = n.fbm2(u, v, { period: 3, octaves: 1, z: 19.1, scaleX: 1, scaleY: 40 });
      // One octave at ~128 cells over the map height: four texels per cell, the
      // finest streak that can be filtered without aliasing into sparkle.
      const grindC = n.fbm2(u, v, { period: 2, octaves: 1, z: 31.7, scaleX: 1, scaleY: 64 });
      // Bevel/hone bands: six-ish strips across V, drifting slowly along U.
      const band = n.fbm2(u, v, { period: 2, octaves: 2, gain: 0.5, z: 44.2, scaleX: 1, scaleY: 3 });

      n.worley2(u, v, isGold ? 40 : 64, 1, cell);
      const pit = ipow(1 - clamp(cell[0] * (isGold ? 2.4 : 1.9), 0, 1), isGold ? 3 : 5);
      const polish = n.fbm2(u, v, { period: 2, octaves: 3, gain: 0.55, z: 55.1 });

      const grind = grindA * 0.5 + grindB * 0.32 + grindC * 0.18;
      // Wear lives on the band crests and only where the macro polish agrees,
      // so it forms a few long strips rather than a stripe on every band.
      const honed = smoothstep(0.10, 0.62, band * 1.15 + polish * 0.45 + grindA * 0.2);
      const dirtMask = smoothstep(0.05, 0.5, -polish + grindA * 0.3) * (1 - honed * 0.75);

      // Grind dominates the height field; the bands give it a slow cross-blade
      // undulation so the normal is not a pure 1D signal (which would light
      // identically from every azimuth and read as printed-on stripes).
      buf.height[i] =
        grindA * 0.52 + grindB * 0.30 + grindC * 0.20 + band * 0.22 - pit * (isGold ? 0.7 : 0.5);

      // Warm falloff on gold: the tint runs bright→deep with the polish field,
      // which is what stops procedural gold from reading as flat yellow paint.
      mix3(baseA, baseB, clamp(0.5 + polish * (isGold ? 1.7 : 1.1) - grind * 0.3, 0, 1), col);
      mix3(col, wear, honed * (isGold ? 0.5 : 0.62), col);
      const shade = 0.9 + grind * 0.2 - pit * 0.35;
      col[0] *= shade; col[1] *= shade; col[2] *= shade;
      // Grime lives in the recesses. On gold the bible names the colour; on
      // steel it is oxide in the grind lines.
      mix3(col, grime, dirtMask * (isGold ? 0.68 : 0.4) + pit * 0.35, col);

      buf.albedo[i * 3] = col[0];
      buf.albedo[i * 3 + 1] = col[1];
      buf.albedo[i * 3 + 2] = col[2];

      // Roughness rides the grind direction, and its swing is deliberately the
      // full width of the bible's band for this metal: this is the term that
      // turns the specular into a band that travels along the blade instead of
      // a static line, and half-strength here is indistinguishable from none.
      const mid = (rLo + rHi) * 0.5;
      const swing = (rHi - rLo) * 0.5;
      const r = mid
        + grind * swing * 1.15
        + pit * swing * 1.4
        + dirtMask * swing * 0.9
        - honed * swing * 1.6;
      buf.rough[i] = clamp(r, rLo, rHi);
    }
  }
}

/**
 * Crystal: internal facet structure. Three cellular layers are sampled at
 * different depths of a 3D field and composited, so the eye reads planes
 * *inside* the volume rather than a pattern painted on the surface — the same
 * cheat a matte painter uses for ice. The outermost layer also drives the
 * height field, giving genuine cut facets; the interior layers only tint and
 * glow. Emissive interior is mandatory per the bible.
 *
 * The one place this map lands in a battle frame is the shardhusk's crown,
 * which makes it a character surface, so the fBm `flaw` layer that used to
 * mottle the albedo, the height and the roughness is gone: it was mid-frequency
 * noise on a creature, and it fought the facets besides. Colour is now blocked
 * flat per facet with the cut edges lifted toward the element core, which is
 * both what ANIME_PIPELINE §5 asks of a character surface and a better gem —
 * a cut stone is flat planes meeting at bright edges, not a mottled lump. The
 * cellular interior layers survive because they drive the *emissive*, and glow
 * pooling at inclusions is light rather than surface detail.
 */
function genCrystal(buf, n, rng, opts) {
  const { w, h } = buf;
  const el = element(opts.element ?? 'ice');
  const accent = hexToLinear(el.accent, [0, 0, 0]);
  const core = hexToLinear(el.core, [0, 0, 0]);
  const deep = hexToLinear(mixHex(el.accent, TEAL_BLACK, 0.72), [0, 0, 0]);
  const spec = SURFACE_SPEC.crystal;
  const col = [0, 0, 0];
  const emis = buf.useEmissive();
  const cell = new Float32Array(4);
  const glow = opts.glow ?? 1.5; // ART_BIBLE §2.2: ambient magic props 1.2–1.8

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;

      // Surface facets: low cell count, high jitter — big irregular planes.
      n.worley2(u, v, 6, 1, cell);
      const facetId = cell[2];
      const facetEdge = 1 - smoothstep(0.0, 0.12, cell[3]);
      // A plane tilted per cell: the F1 distance is linear away from the
      // feature point, so using it directly as height gives flat faces meeting
      // at sharp creases, exactly like a cut gem.
      const face = cell[0] * (0.6 + facetId * 0.8);

      // Interior layers: periodic cellular at different periods and aspect
      // ratios. 3D cellular would read marginally better but does not tile, and
      // a seam down a crystal is more visible than a slightly flatter interior.
      n.worleyAniso2(u, v, 11, 11, 0.95, 1.0, 0.8, cell);
      const inner1 = 1 - smoothstep(0.0, 0.25, cell[3]);
      n.worleyAniso2(u, v, 19, 17, 1.0, 0.75, 1.0, cell);
      const inner2 = 1 - smoothstep(0.0, 0.3, cell[3]);

      buf.height[i] = face * 0.9 - facetEdge * 0.5;

      // Flat per facet: `facetId` is constant inside a cell, so each face is a
      // single block of colour and the only value change in the map is at a cut.
      mix3(deep, accent, clamp(0.30 + facetId * 0.55, 0, 1), col);
      mix3(col, core, facetEdge * 0.55 + inner1 * 0.3, col);
      buf.albedo[i * 3] = col[0];
      buf.albedo[i * 3 + 1] = col[1];
      buf.albedo[i * 3 + 2] = col[2];

      // Interior glow concentrates where the internal layers cross — reads as
      // light pooling at inclusions rather than a uniform lit block.
      const g = clamp(inner1 * 0.55 + inner2 * 0.4 + facetEdge * 0.35, 0, 1);
      const gi = g * glow;
      emis[i * 3] = mix(accent[0], core[0], inner2 * 0.6) * gi;
      emis[i * 3 + 1] = mix(accent[1], core[1], inner2 * 0.6) * gi;
      emis[i * 3 + 2] = mix(accent[2], core[2], inner2 * 0.6) * gi;

      buf.rough[i] = clamp(0.07 + facetEdge * 0.08, spec.roughness[0], spec.roughness[1]);
    }
  }
}

/**
 * Sand: wind ripples plus grain sparkle. The ripple direction uses integer
 * wave numbers (7, 2) so the sinusoid is exactly periodic across the tile, and
 * the crest positions are pushed around by a warp field so they meander like
 * real dune ripples instead of marching in parade.
 *
 * The grain field was `{period: 200}` — 1.3 texels per cycle on a 256 map, so
 * every texel drew an independent sample and the "grain" was white noise
 * multiplied straight into the albedo. That is the same defect the terrain
 * review caught on grass, and it is worse here because sand's albedo band is
 * the brightest of the three. Band-limited it becomes a real grain field; the
 * per-texel mica glints below are still per-texel, which is correct, because
 * they are a sparse *roughness* event and not a colour signal.
 */
function genSand(buf, n, rng) {
  const { w, h } = buf;
  const lightS = hexToLinear(0xd6c3a4, [0, 0, 0]);
  const darkS = hexToLinear(0xa89578, [0, 0, 0]);
  const shadowS = hexToLinear(0x776a5c, [0, 0, 0]);
  const spec = SURFACE_SPEC.sand;
  const col = [0, 0, 0];

  const meanderField = bandLimited(w, 3, 3, { gain: 0.55, z: 2.9 });
  const duneField = bandLimited(w, 2, 3, { gain: 0.6, z: 13.8 });
  const grainField = bandLimited(w, 32, 2, { gain: 0.5, z: 61.2 });

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;

      const meander = n.fbm2(u, v, meanderField);
      const ripple = Math.sin((u * 7 + v * 2) * TAU + meander * 4.5);
      // Ripples are asymmetric — a shallow windward slope and a steep lee face.
      const shaped = Math.pow(ripple * 0.5 + 0.5, 1.7) * 2 - 1;
      const dune = n.fbm2(u, v, duneField);
      const grain = n.fbm2(u, v, grainField);
      const sparkleSeed = hash1(i, 5);

      buf.height[i] = shaped * 0.5 + dune * 0.4 + grain * 0.1;

      mix3(darkS, lightS, clamp(0.5 + shaped * 0.3 + dune * 0.35, 0, 1), col);
      mix3(col, shadowS, clamp(-shaped * 0.35, 0, 1) * 0.4, col);
      const shade = 0.96 + grain * 0.08;
      col[0] *= shade; col[1] *= shade; col[2] *= shade;

      buf.albedo[i * 3] = col[0];
      buf.albedo[i * 3 + 1] = col[1];
      buf.albedo[i * 3 + 2] = col[2];

      // Sparse mica glints: a handful of texels per thousand drop to near-zero
      // roughness. Under a low sun these are what make sand read as granular.
      const glint = sparkleSeed > 0.994 ? 0.35 : 0;
      buf.rough[i] = clamp(0.78 + grain * 0.08 - glint, spec.roughness[0], spec.roughness[1]);
    }
  }
}

/**
 * Grass: stamped tussocks over a soil base, band-limited, with the blade signal
 * living in the height field rather than in the albedo.
 *
 * The previous build stamped 2400 blades of 4–8.5% tile length and wrote each
 * one's full colour into the albedo — a near-black soil at Y ≈ 0.03 against a
 * lit blade at Y ≈ 0.30, adjacent, at roughly two texels of separation. That is
 * a 10:1 contrast edge repeating at close to the map's Nyquist limit, tiled 400
 * times across a 900 m stage, and it is the mid-ground moiré carpet the review
 * put first on the list. Three changes, and the split between them is the point:
 *
 * 1. **Feature scale up, count down.** ~950 tussocks at 8–16% tile length. At
 *    LookdevScene's 2.25 m tiling that is a 18–36 cm clump rather than a 9 cm
 *    blade, which puts the dominant albedo frequency an octave and a half below
 *    where it was and comfortably under Nyquist at battle-camera distance.
 *
 * 2. **Contrast moves out of albedo and into height.** The tips still rise the
 *    full amount in the height field — the normal map, and therefore the lit
 *    read of the near ground, is unchanged — but the albedo only *modulates*
 *    around the clump's own value by a few percent. A normal map degrades
 *    gracefully under minification because the ground shader already relaxes it
 *    toward geometric past 14 m; a high-contrast albedo does not, and there is
 *    nowhere for that energy to go but interference.
 *
 * 3. **Soil and blade share one hue family.** Not by being authored carefully —
 *    that was the previous attempt and it still drifted, because the four hexes
 *    here were maintained separately from the two `LookdevScene` paints its
 *    floor with and the four `Flora.js` colours its blade instances. Every
 *    colour on this surface is now *derived* from the single `Palette.MEADOW`
 *    ground colour, so the tile the terrain is painted with and the blades
 *    standing in it cannot be two different materials. See `Palette.bladeRamp`.
 */
function genGrass(buf, n, rng) {
  const { w, h } = buf;
  const spec = SURFACE_SPEC.grass;
  // The family, all four members derived from `MEADOW.GROUND`: a lit blade tip,
  // a shaded blade base, sun-bleached straw, and the bare earth under them.
  // Authoring them here as literals is what let this tile and the meadow's own
  // instanced blades end up 40° of hue apart, which is the defect this whole
  // derivation exists to make impossible.
  const soil = hexToLinear(MEADOW_SOIL, [0, 0, 0]);
  const bladeA = hexToLinear(LAWN_BLADE.tip, [0, 0, 0]);
  const bladeB = hexToLinear(LAWN_BLADE.root, [0, 0, 0]);
  const bladeDry = hexToLinear(MEADOW_DRY, [0, 0, 0]);
  const col = [0, 0, 0];

  // 6 cycles at 256 texels leaves the top octave at 10.7 texels/cycle. The old
  // field ran four octaves off a period of 12 and finished at 2.7.
  const soilField = bandLimited(w, 6, 3, { gain: 0.5, z: 3.3 });

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;
      const dirt = n.fbm2(u, v, soilField);
      const shade = 0.86 + dirt * 0.24;
      buf.albedo[i * 3] = soil[0] * shade;
      buf.albedo[i * 3 + 1] = soil[1] * shade;
      buf.albedo[i * 3 + 2] = soil[2] * shade;
      buf.height[i] = dirt * 0.2 - 0.3;
      buf.rough[i] = 0.92;
    }
  }

  const CLUMPS = 950;
  const flowField = bandLimited(w, 3, 2, { gain: 0.5, z: 77.1 });
  const dryField = bandLimited(w, 2, 2, { gain: 0.5, z: 91.4 });
  for (let b = 0; b < CLUMPS; b++) {
    const cu = rng.next();
    const cv = rng.next();
    // Clump direction: a low-frequency field so neighbouring clumps lie the
    // same way, as if a wind had passed. Purely random angles read as static.
    const flow = n.fbm2(cu, cv, flowField);
    const ang = flow * Math.PI * 1.6 + rng.jitter(0.5);
    const len = rng.range(0.08, 0.16);
    const wid = rng.range(0.011, 0.019);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const dryAmt = clamp(n.fbm2(cu, cv, dryField) * 1.6 + 0.15, 0, 1);
    // ±7% rather than ±22%. Per-clump value jitter is what gives a stamped
    // field its life, but at the old amplitude it was also the largest source
    // of texel-scale albedo variance in the map.
    const value = rng.range(0.93, 1.07);
    // Clumps curve up to 0.8 * len across their own width, so the bend has to
    // be inside the bound or tips get clipped at the box edge.
    const spanB = wid * 2.6;
    const radU = Math.abs(ca) * len + Math.abs(sa) * spanB;
    const radV = Math.abs(sa) * len + Math.abs(ca) * spanB;

    stampRegion(w, h, cu, cv, radU, radV, (i, du, dv) => {
      const a = (du * ca + dv * sa) / len;
      if (a < 0 || a > 1) return;
      const bcoord = (-du * sa + dv * ca) / wid;
      // Taper to a point, with a slight curve so the clump arcs over.
      const halfW = (1 - a * a * 0.85) * (1 - a * 0.15);
      const bend = a * a * 0.8;
      const d = halfW - Math.abs(bcoord - bend);
      if (d <= 0) return;
      const cover = smoothstep(0, 0.9, d);
      if (cover < 0.35) return;

      mix3(bladeB, bladeA, clamp(a * 0.9 + 0.2, 0, 1), col);
      mix3(col, bladeDry, dryAmt * 0.6 * a, col);
      col[0] *= value; col[1] *= value; col[2] *= value;
      // Blend rather than overwrite, weighted by coverage. A hard write puts a
      // one-texel step at every clump edge — the highest-frequency content the
      // map could possibly carry, and thousands of instances of it. Fading over
      // the taper's own soft edge costs nothing and removes all of them.
      const t = smoothstep(0.35, 0.85, cover);
      buf.albedo[i * 3] += (col[0] - buf.albedo[i * 3]) * t;
      buf.albedo[i * 3 + 1] += (col[1] - buf.albedo[i * 3 + 1]) * t;
      buf.albedo[i * 3 + 2] += (col[2] - buf.albedo[i * 3 + 2]) * t;
      // Clump height rises toward the tip so the normal map lights the tips
      // brightest — the cheap stand-in for real per-blade geometry. Left at full
      // amplitude: this is where the detail the albedo gave up now lives.
      buf.height[i] = Math.max(buf.height[i], 0.25 + a * 0.75 + d * 0.3);
      buf.rough[i] = clamp(0.6 - a * 0.08, spec.roughness[0], spec.roughness[1]);
    });
  }
}

/**
 * Dirt: a soil matrix with embedded pebbles and dried cracks. The pebbles come
 * from a cellular field thresholded on F1 so only the cells whose hash clears a
 * bar become stones — otherwise every cell grows a pebble and it reads as
 * cobble, not earth.
 *
 * The `fine` grain field used to run `{period: 80, octaves: 3}`. On a 256 map
 * `fbm2` drops octaves past its `maxPeriod`, so what actually reached the
 * texture was a single octave at 3.2 texels per cycle — below the four the
 * lattice needs to be resolved, i.e. aliased in the source pixels themselves,
 * and then multiplied into both albedo and roughness. Band-limited it now
 * lands at 8 texels per cycle. The pebbles are the coarse detail this surface
 * actually reads on and they are unaffected.
 */
function genDirt(buf, n, rng) {
  const { w, h } = buf;
  const spec = SURFACE_SPEC.dirt;
  const soil = hexToLinear(0x4a4237, [0, 0, 0]);
  const dry = hexToLinear(0x6f6353, [0, 0, 0]);
  const damp = hexToLinear(0x2c2822, [0, 0, 0]);
  const pebbleCol = hexToLinear(0x82807a, [0, 0, 0]);
  const col = [0, 0, 0];
  const cell = new Float32Array(4);
  const cell2 = new Float32Array(4);

  const coarseField = bandLimited(w, 8, 3, { gain: 0.55, z: 1.7 });
  const fineField = bandLimited(w, 32, 2, { gain: 0.5, z: 12.2 });
  const breakupField = bandLimited(w, 2, 2, { gain: 0.5, z: 63.1 });

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;

      const coarse = n.fbm2(u, v, coarseField);
      const fine = n.fbm2(u, v, fineField);
      const breakup = n.fbm2(u, v, breakupField);

      n.worley2(u, v, 34, 1, cell);
      const isPebble = cell[2] > 0.72 ? 1 : 0;
      const pebble = isPebble * Math.pow(clamp(1 - cell[0] * 2.6, 0, 1), 0.6);

      n.worley2(u, v, 9, 0.9, cell2);
      const crack = ipow(1 - smoothstep(0.0, 0.1, cell2[3]), 2) * smoothstep(0.0, 0.4, breakup + 0.2);

      buf.height[i] = coarse * 0.3 + fine * 0.14 + pebble * 0.85 - crack * 0.7;

      // Mix weights pulled in across the board. Every one of these terms was
      // driving a full soil-to-dry or soil-to-damp swing off a noise field, so
      // the surface spanned its whole authored range several times per tile.
      mix3(soil, dry, clamp(0.45 + coarse * 0.45 + breakup * 0.35, 0, 1), col);
      mix3(col, damp, clamp(-breakup * 0.8, 0, 1) * 0.4 + crack * 0.35, col);
      mix3(col, pebbleCol, pebble * 0.6, col);
      const shade = 0.94 + fine * 0.1;
      col[0] *= shade; col[1] *= shade; col[2] *= shade;

      buf.albedo[i * 3] = col[0];
      buf.albedo[i * 3 + 1] = col[1];
      buf.albedo[i * 3 + 2] = col[2];

      buf.rough[i] = clamp(0.92 - pebble * 0.18 + fine * 0.05, spec.roughness[0], spec.roughness[1]);
    }
  }
}

/**
 * Water normal: three crossing Gerstner-style wave trains at integer wave
 * numbers (so they tile exactly) plus a chop layer. The bible asks for dual
 * scrolling normals at 0.7/1.3 scale and 12° divergence — that scrolling is the
 * shader's job; this map's job is to be a plausible single-scale wave field
 * with no directional bias strong enough to survive being scrolled twice.
 */
function genWaterNormal(buf, n, rng) {
  const { w, h } = buf;
  const spec = SURFACE_SPEC.water;
  const absorb = hexToLinear(SURFACE_TINT.WATER_ABSORB, [0, 0, 0]);
  const waves = [
    [3, 1, 1.0],
    [-2, 3, 0.62],
    [5, 4, 0.35],
    [1, -6, 0.22],
  ];
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;
      const warp = n.fbm2(u, v, { period: 4, octaves: 3, gain: 0.55, z: 4.1 });
      let ht = 0;
      for (let k = 0; k < waves.length; k++) {
        const [kx, ky, amp] = waves[k];
        const phase = (u * kx + v * ky) * TAU + warp * 2.2;
        // Sharpened crests / flattened troughs: the Gerstner signature.
        ht += amp * Math.pow(Math.sin(phase) * 0.5 + 0.5, 1.6);
      }
      const chop = n.fbm2(u, v, { period: 24, octaves: 3, gain: 0.5, z: 21.7 });
      buf.height[i] = ht * 0.45 + chop * 0.22;
      buf.albedo[i * 3] = absorb[0];
      buf.albedo[i * 3 + 1] = absorb[1];
      buf.albedo[i * 3 + 2] = absorb[2];
      buf.rough[i] = clamp(0.04 + chop * 0.05, spec.roughness[0], spec.roughness[1]);
    }
  }
}

/**
 * Cloud: billowed turbulence with a cellular puff mask. Alpha is the payload;
 * the RGB carries a silver-lining tint (warm toward the density gradient, cool
 * in the core) so a cloud plane picks up direction even under flat ambient.
 */
function genCloud(buf, n, rng) {
  const { w, h } = buf;
  const bright = hexToLinear(0xfff2e0, [0, 0, 0]);
  const shade = hexToLinear(0x8fa6b8, [0, 0, 0]);
  const col = [0, 0, 0];
  const alpha = buf.useAlpha();
  const cell = new Float32Array(4);

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;
      const billow = n.turbulence2(u, v, { period: 4, octaves: 5, gain: 0.55, z: 6.1 });
      const warp = n.warp2(u, v, { period: 3, octaves: 3, warp: 0.6 });
      n.worley2(u, v, 5, 1, cell);
      const puff = 1 - clamp(cell[0] * 1.25, 0, 1);
      const density = clamp(puff * 0.85 + (1 - billow) * 0.5 + warp * 0.5 - 0.32, 0, 1);
      const a = smootherstep(0.05, 0.55, density);
      alpha[i] = a;
      buf.height[i] = density;
      // Rim brightening where density falls off — the lit edge of a cumulus.
      const rim = smoothstep(0.35, 0.75, density) * (1 - smoothstep(0.6, 0.95, density));
      mix3(shade, bright, clamp(density * 0.7 + rim * 0.8, 0, 1), col);
      buf.albedo[i * 3] = col[0];
      buf.albedo[i * 3 + 1] = col[1];
      buf.albedo[i * 3 + 2] = col[2];
      buf.rough[i] = 1;
    }
  }
}

/**
 * Rune: a magic circle drawn analytically from distance fields — concentric
 * rings, a tick band, a star-polygon lattice, and eight glyph cartouches whose
 * strokes are drawn from the seeded RNG. Everything is a signed distance so the
 * edges antialias for free and the same field feeds both alpha and height.
 */
function genRune(buf, n, rng, opts) {
  const { w, h } = buf;
  const el = element(opts.element ?? 'light');
  const accent = hexToLinear(el.accent, [0, 0, 0]);
  const core = hexToLinear(el.core, [0, 0, 0]);
  const alpha = buf.useAlpha();
  const emis = buf.useEmissive();
  alpha.fill(0);
  const STROKE_R = 0.0022;

  /** Pre-generate the glyph strokes so the per-texel loop is a flat scan. */
  /** [ax, ay, bx, by, minX, minY, maxX, maxY] — the box lets the per-texel loop
   *  skip 40 of the 41 strokes with four compares instead of a square root. */
  const strokes = [];
  const pushStroke = (ax, ay, bx, by) => {
    const pad = STROKE_R + 3 / w;
    strokes.push([ax, ay, bx, by,
      Math.min(ax, bx) - pad, Math.min(ay, by) - pad,
      Math.max(ax, bx) + pad, Math.max(ay, by) + pad]);
  };
  const SECTORS = 8;
  for (let s = 0; s < SECTORS; s++) {
    const a0 = (s / SECTORS) * TAU + TAU / (SECTORS * 2);
    const cx = 0.5 + Math.cos(a0) * 0.355;
    const cy = 0.5 + Math.sin(a0) * 0.355;
    const rot = a0 + Math.PI / 2;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const count = rng.int(3, 5);
    for (let k = 0; k < count; k++) {
      const x0 = rng.range(-0.030, 0.030);
      const y0 = rng.range(-0.030, 0.030);
      const x1 = rng.range(-0.030, 0.030);
      const y1 = rng.range(-0.030, 0.030);
      pushStroke(
        cx + x0 * cr - y0 * sr, cy + x0 * sr + y0 * cr,
        cx + x1 * cr - y1 * sr, cy + x1 * sr + y1 * cr,
      );
    }
  }
  // Star polygon: 9 points, connected with a stride of 4 — a single unbroken
  // circuit, which reads as intentional geometry rather than a scribble.
  const POINTS = 9;
  const STRIDE = 4;
  const R = 0.255;
  for (let p = 0; p < POINTS; p++) {
    const a0 = (p / POINTS) * TAU - Math.PI / 2;
    const a1 = (((p + STRIDE) % POINTS) / POINTS) * TAU - Math.PI / 2;
    pushStroke(
      0.5 + Math.cos(a0) * R, 0.5 + Math.sin(a0) * R,
      0.5 + Math.cos(a1) * R, 0.5 + Math.sin(a1) * R,
    );
  }

  const rings = [
    [0.470, 0.0055], [0.452, 0.0018], [0.398, 0.0030],
    [0.290, 0.0022], [0.272, 0.0055], [0.120, 0.0035],
  ];

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;
      const dx = u - 0.5;
      const dy = v - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy);
      const th = Math.atan2(dy, dx);
      const aa = 1.5 / w; // one and a half texels of antialiasing

      let ink = 0;
      for (let k = 0; k < rings.length; k++) {
        ink = Math.max(ink, 1 - smoothstep(rings[k][1], rings[k][1] + aa, Math.abs(r - rings[k][0])));
      }
      // Tick band between the two outer rings.
      if (r > 0.398 && r < 0.452) {
        const TICKS = 72;
        const tf = ((th / TAU) * TICKS + TICKS) % 1;
        const tick = 1 - smoothstep(0.16, 0.16 + aa * TICKS, Math.abs(tf - 0.5));
        ink = Math.max(ink, tick * (1 - smoothstep(0.44, 0.452, r)) * (1 - smoothstep(0.0, 0.006, 0.404 - r)));
      }
      for (let k = 0; k < strokes.length; k++) {
        const sk = strokes[k];
        if (u < sk[4] || u > sk[6] || v < sk[5] || v > sk[7]) continue;
        const ax = sk[0], ay = sk[1], bx = sk[2], by = sk[3];
        const vx = bx - ax;
        const vy = by - ay;
        const wx = u - ax;
        const wy = v - ay;
        const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy || 1e-6), 0, 1);
        const px = wx - vx * t;
        const py = wy - vy * t;
        const d = Math.sqrt(px * px + py * py);
        ink = Math.max(ink, 1 - smoothstep(STROKE_R, STROKE_R + aa, d));
      }
      // Erode the ink with a fine noise so the sigil looks inscribed, not printed.
      const erode = n.fbm2(u, v, { period: 40, octaves: 3, gain: 0.5, z: 8.4 });
      ink = clamp(ink * (0.82 + erode * 0.45), 0, 1);
      // Fade the whole circle out past the outer ring so the card has no edge.
      ink *= 1 - smoothstep(0.478, 0.5, r);

      alpha[i] = ink;
      buf.height[i] = ink * 0.6 + erode * 0.08;
      const t = clamp(r * 2.2, 0, 1);
      buf.albedo[i * 3] = mix(core[0], accent[0], t);
      buf.albedo[i * 3 + 1] = mix(core[1], accent[1], t);
      buf.albedo[i * 3 + 2] = mix(core[2], accent[2], t);
      const gi = ink * (opts.glow ?? 1.6);
      emis[i * 3] = mix(core[0], accent[0], t) * gi;
      emis[i * 3 + 1] = mix(core[1], accent[1], t) * gi;
      emis[i * 3 + 2] = mix(core[2], accent[2], t) * gi;
      buf.rough[i] = 0.35;
    }
  }
}

const GENERATORS = {
  stone: genStone,
  marble: genMarble,
  wood: genWood,
  bark: genBark,
  foliage: genFoliage,
  cloth: genCloth,
  silk: genSilk,
  leather: genLeather,
  steel: (b, n, r, o) => genMetal(b, n, r, 'steel', o),
  gold: (b, n, r, o) => genMetal(b, n, r, 'gold', o),
  crystal: genCrystal,
  sand: genSand,
  grass: genGrass,
  dirt: genDirt,
  'water-normal': genWaterNormal,
  cloud: genCloud,
  rune: genRune,
};

// -------------------------------------------------------------- assembly

/**
 * Build the full map set for a named surface.
 * @returns {{maps: Object<string, THREE.Texture>, meta: Object}}
 */
export function generateSurface(key, opts = {}) {
  const def = SURFACES[key];
  if (!def) throw new Error(`Textures: unknown surface "${key}"`);
  const size = opts.size ?? def.size ?? DEFAULT_SIZE;
  const buf = new SurfaceBuffer(size, size);
  const seed = seedFromKey(key) ^ ((opts.seed ?? 0) >>> 0);
  const n = makeNoise(seed);
  n.maxPeriod = size * 0.5;
  const rng = new Rng(seed ^ 0x5bf03635);

  GENERATORS[key](buf, n, rng, opts);
  if (def.spec && !def.noAlbedo) {
    const spec = SURFACE_SPEC[def.spec];
    fitAlbedoBand(buf, spec.albedo, spec.maxSat ?? 0);
  }

  const wrap = def.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  const maps = {};

  // Mean albedo is accumulated during encoding rather than in a second pass:
  // materials need it for derived colours the bible specifies relative to the
  // base map (cloth sheen = albedo + 20% value, foliage translucency tint), and
  // a second sweep over a million floats to recover it would be wasteful.
  let mr = 0, mg = 0, mb = 0;
  if (!def.noAlbedo) {
    const bytes = new Uint8ClampedArray(buf.n * 4);
    for (let i = 0; i < buf.n; i++) {
      const r = buf.albedo[i * 3];
      const g = buf.albedo[i * 3 + 1];
      const b = buf.albedo[i * 3 + 2];
      mr += r; mg += g; mb += b;
      bytes[i * 4] = linearToByte(r);
      bytes[i * 4 + 1] = linearToByte(g);
      bytes[i * 4 + 2] = linearToByte(b);
      bytes[i * 4 + 3] = buf.alpha ? (buf.alpha[i] * 255 + 0.5) | 0 : 255;
    }
    mr /= buf.n; mg /= buf.n; mb /= buf.n;
    maps.albedo = texFromCanvas(paint(size, size, bytes), { srgb: true, wrap, name: `${key}:albedo` });
  }

  maps.normal = texFromCanvas(
    paint(size, size, normalFromHeight(buf.height, size, size, opts.bump ?? def.bump)),
    { srgb: false, wrap, name: `${key}:normal` },
  );

  {
    const bytes = new Uint8ClampedArray(buf.n * 4);
    for (let i = 0; i < buf.n; i++) {
      const r = (clamp(buf.rough[i], 0, 1) * 255 + 0.5) | 0;
      bytes[i * 4] = r;
      bytes[i * 4 + 1] = r;
      bytes[i * 4 + 2] = r;
      bytes[i * 4 + 3] = 255;
    }
    maps.roughness = texFromCanvas(paint(size, size, bytes), { srgb: false, wrap, name: `${key}:roughness` });
  }

  if (def.ao > 0) {
    const ao = aoFromHeight(buf.height, size, size, def.ao);
    const bytes = new Uint8ClampedArray(buf.n * 4);
    for (let i = 0; i < buf.n; i++) {
      const a = (clamp(ao[i], 0, 1) * 255 + 0.5) | 0;
      bytes[i * 4] = a;
      bytes[i * 4 + 1] = a;
      bytes[i * 4 + 2] = a;
      bytes[i * 4 + 3] = 255;
    }
    maps.ao = texFromCanvas(paint(size, size, bytes), { srgb: false, wrap, name: `${key}:ao` });
  }

  if (def.emissive && buf.emissive) {
    const bytes = new Uint8ClampedArray(buf.n * 4);
    for (let i = 0; i < buf.n; i++) {
      bytes[i * 4] = linearToByte(buf.emissive[i * 3]);
      bytes[i * 4 + 1] = linearToByte(buf.emissive[i * 3 + 1]);
      bytes[i * 4 + 2] = linearToByte(buf.emissive[i * 3 + 2]);
      bytes[i * 4 + 3] = 255;
    }
    maps.emissive = texFromCanvas(paint(size, size, bytes), { srgb: true, wrap, name: `${key}:emissive` });
  }

  return {
    maps,
    meta: {
      key,
      spec: def.spec ? SURFACE_SPEC[def.spec] : null,
      repeat: def.repeat ?? 1,
      transparent: !!def.alpha,
      doubleSided: !!def.doubleSided,
      primary: def.primary ?? 'albedo',
      emissive: !!def.emissive,
      clamped: !!def.clamp,
      /** Mean albedo in linear light, and the same value as an sRGB hex. */
      meanLinear: [mr, mg, mb],
      meanHex: (linearToByte(mr) << 16) | (linearToByte(mg) << 8) | linearToByte(mb),
      size,
    },
  };
}

// ------------------------------------------------------------------ ramps

/**
 * A gradient ramp texture. 256×8 rather than 256×1: a one-pixel-tall texture
 * has no mip chain and some drivers sample it inconsistently at grazing UVs.
 * ClampToEdge is mandatory — a wrapping ramp makes the hottest core colour
 * bleed into the transparent tail at the seam.
 */
export function generateRampTexture(ramp, { width = 256, height = 8, srgb = true, name = 'ramp' } = {}) {
  const bytes = new Uint8ClampedArray(width * height * 4);
  const c = [0, 0, 0, 1];
  for (let x = 0; x < width; x++) {
    ramp.sample(x / (width - 1), c);
    const r = linearToByte(c[0]);
    const g = linearToByte(c[1]);
    const b = linearToByte(c[2]);
    const a = (clamp(c[3], 0, 1) * 255 + 0.5) | 0;
    for (let y = 0; y < height; y++) {
      const o = (y * width + x) * 4;
      bytes[o] = r;
      bytes[o + 1] = g;
      bytes[o + 2] = b;
      bytes[o + 3] = a;
    }
  }
  return texFromCanvas(paint(width, height, bytes), {
    srgb,
    wrap: THREE.ClampToEdgeWrapping,
    mips: false,
    name,
  });
}

/** `ramp-fire`, `ramp-ice`, `ramp-holy`, `ramp-<element>`, and `ramp-toon[-n]`. */
export function generateRamp(key, opts = {}) {
  if (key === 'ramp-toon' || key.startsWith('ramp-toon-')) {
    const bands = key === 'ramp-toon' ? (opts.bands ?? 3) : parseInt(key.slice('ramp-toon-'.length), 10) || 3;
    return generateRampTexture(toonRamp(clamp(bands, 2, 4), opts), {
      width: 128,
      height: 4,
      srgb: true,
      name: key,
    });
  }
  const alias = { 'ramp-holy': 'light', 'ramp-fire': 'fire', 'ramp-ice': 'ice' };
  const el = alias[key] ?? key.replace(/^ramp-/, '');
  return generateRampTexture(elementRamp(ELEMENT[el] ? el : 'light'), { name: key });
}

// ---------------------------------------------------------------- sprites

/**
 * Additive VFX sprites.
 *
 * All of them share one discipline: a **near-white core** and a **saturated
 * falloff**, because additive blending sums toward white anyway and a sprite
 * that starts saturated turns to mud the moment three of them overlap. Alpha is
 * carried in both the alpha channel and the RGB magnitude so the same texture
 * works under `AdditiveBlending` (which ignores alpha) and `NormalBlending`.
 */
export function generateSprite(key, opts = {}) {
  const size = opts.size ?? 256;
  const bytes = new Uint8ClampedArray(size * size * 4);
  const n = makeNoise(seedFromKey(key));
  const tint = hexToLinear(opts.color ?? 0xffffff, [0, 0, 0]);
  const core = [1, 1, 1];
  const col = [0, 0, 0];

  const put = (i, r, g, b, a) => {
    bytes[i * 4] = linearToByte(r);
    bytes[i * 4 + 1] = linearToByte(g);
    bytes[i * 4 + 2] = linearToByte(b);
    bytes[i * 4 + 3] = (clamp(a, 0, 1) * 255 + 0.5) | 0;
  };

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    const dy = v - 0.5;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x + 0.5) / size;
      const dx = u - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2; // 0 at centre, 1 at edge
      const th = Math.atan2(dy, dx);
      let a = 0;
      let coreAmt = 0;

      switch (key) {
        case 'glow': {
          // Gaussian, not 1/r²: an inverse-square falloff never reaches zero
          // and leaves a visible square edge on the quad.
          a = Math.exp(-r * r * 7.5);
          coreAmt = Math.exp(-r * r * 34);
          break;
        }
        case 'spark': {
          const radial = Math.exp(-r * r * 22);
          // Four-point diffraction spikes, plus two faint diagonals.
          const spike = Math.pow(Math.abs(Math.cos(th * 2)), 40) * Math.exp(-r * 4.5) * 0.9
            + Math.pow(Math.abs(Math.cos(th * 2 + Math.PI / 4)), 90) * Math.exp(-r * 6.5) * 0.35;
          a = clamp(radial + spike, 0, 1);
          coreAmt = Math.exp(-r * r * 90);
          break;
        }
        case 'star': {
          // Six-point star: the ambient "glass petal glint" of the setting.
          const spike = Math.pow(Math.abs(Math.cos(th * 3)), 26) * Math.exp(-r * 3.4);
          a = clamp(Math.exp(-r * r * 26) + spike * 0.95, 0, 1);
          coreAmt = Math.exp(-r * r * 70);
          break;
        }
        case 'ember': {
          // Hot centre with a turbulent, upward-trailing tail.
          const trail = clamp(1 - Math.abs(dx) * 9, 0, 1) * clamp((dy + 0.5) / 0.9, 0, 1);
          const turb = n.turbulence2(u, v * 0.6, { period: 6, octaves: 3, gain: 0.5, z: 3.2 });
          a = clamp(Math.exp(-r * r * 30) + trail * trail * (0.55 - turb * 0.4), 0, 1);
          coreAmt = Math.exp(-r * r * 120);
          break;
        }
        case 'mote': {
          // A glass petal: a small faceted lozenge with a specular corner.
          const a1 = Math.abs(dx * 0.9 + dy * 0.44);
          const a2 = Math.abs(-dx * 0.44 + dy * 0.9);
          const d = Math.max(a1 / 0.36, a2 / 0.16);
          const facet = clamp(0.5 + (dx - dy) * 3.4, 0, 1);
          coreAmt = clamp(1 - smoothstep(0.0, 0.42, d), 0, 1) * facet;
          // Brightness ramps across the petal rather than filling it evenly:
          // a flat lozenge reads as a paper chip, a graded one reads as a flake
          // of glass catching the key light on one edge.
          a = clamp(1 - smoothstep(0.75, 1.0, d), 0, 1) * (0.22 + 0.78 * facet) * 0.9;
          break;
        }
        case 'smoke': {
          // Puff: turbulence carved into a soft disc. The vignette term is what
          // keeps the quad edge invisible when many puffs overlap.
          const turb = n.turbulence2(u, v, { period: 4, octaves: 5, gain: 0.55, z: 1.1 });
          const warp = n.warp2(u, v, { period: 3, octaves: 3, warp: 0.7 });
          const disc = clamp(1 - smoothstep(0.15, 1.0, r), 0, 1);
          a = clamp(disc * (0.55 + warp * 1.4 - turb * 0.55), 0, 1);
          a *= a;
          coreAmt = 0;
          break;
        }
        case 'streak': {
          // Speed line for slashes and limit breaks: long in u, thin in v.
          const across = Math.exp(-dy * dy * 900);
          const along = Math.pow(clamp(1 - Math.abs(dx) * 2, 0, 1), 0.6);
          a = clamp(across * along, 0, 1);
          coreAmt = Math.pow(across, 4) * along;
          break;
        }
        case 'ring': {
          // Shockwave: a bright annulus with an inner falloff.
          const band = Math.exp(-Math.pow((r - 0.82) * 9, 2));
          a = clamp(band + Math.exp(-r * r * 3) * 0.12, 0, 1);
          coreAmt = Math.exp(-Math.pow((r - 0.82) * 22, 2));
          break;
        }
        default: {
          a = Math.exp(-r * r * 8);
          coreAmt = Math.exp(-r * r * 40);
        }
      }

      if (a <= 0.002) {
        put(i, 0, 0, 0, 0);
        continue;
      }
      mix3(tint, core, clamp(coreAmt, 0, 1), col);
      // Premultiply the colour by coverage as well as writing alpha: additive
      // blending discards the alpha channel entirely, so brightness has to live
      // in RGB or half the effects render as flat cards.
      put(i, col[0] * a, col[1] * a, col[2] * a, a);
    }
  }

  return texFromCanvas(paint(size, size, bytes), {
    srgb: true,
    wrap: THREE.ClampToEdgeWrapping,
    mips: true,
    name: key,
  });
}

// -------------------------------------------------------------- utilities

/**
 * `noise-rgb`: four decorrelated tileable fields in one texture — fBm in R,
 * cellular F1 in G, ridged in B, high-frequency fBm in A. Shaders that need
 * cheap variety (dissolve masks, wind, UV jitter) sample this instead of
 * running their own noise, which is a large win on mobile-class GPUs.
 */
function genNoiseRGB(size, seed) {
  const n = makeNoise(seed);
  const bytes = new Uint8ClampedArray(size * size * 4);
  const cell = new Float32Array(4);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = (x + 0.5) / size;
      const a = n.fbm2(u, v, { period: 4, octaves: 4, gain: 0.5, z: 1.1 }) * 0.5 + 0.5;
      n.worley2(u, v, 8, 1, cell);
      const b = clamp(cell[0], 0, 1);
      const c = n.ridged2(u, v, { period: 6, octaves: 4, gain: 0.5, z: 5.5 });
      const d = n.fbm2(u, v, { period: 24, octaves: 3, gain: 0.5, z: 9.9 }) * 0.5 + 0.5;
      bytes[i] = (clamp(a, 0, 1) * 255 + 0.5) | 0;
      bytes[i + 1] = (b * 255 + 0.5) | 0;
      bytes[i + 2] = (clamp(c, 0, 1) * 255 + 0.5) | 0;
      bytes[i + 3] = (clamp(d, 0, 1) * 255 + 0.5) | 0;
    }
  }
  return texFromCanvas(paint(size, size, bytes), {
    srgb: false,
    wrap: THREE.RepeatWrapping,
    mips: true,
    name: 'noise-rgb',
  });
}

/**
 * Blue noise by void-and-cluster (Ulichney 1993).
 *
 * White noise is the wrong dither: its energy sits across all frequencies, so
 * the eye sees it as grain. Blue noise pushes energy to high frequencies where
 * the eye's contrast sensitivity is lowest, which is why the bible specifies a
 * blue-noise-animated film grain and why every dithered effect (banding removal,
 * stochastic transparency, TAA jitter) wants this texture and not `rand()`.
 *
 * The algorithm: start from a sparse random binary pattern, repeatedly move the
 * point in the tightest cluster into the largest void until it stabilises, then
 * rank every pixel by removing tightest clusters (ranks below the prototype) and
 * filling largest voids (ranks above). Ranks become the output values.
 *
 * Note on phase III of the original paper: once the pattern is more than half
 * full, "tightest cluster of the complement" is *provably* the same location as
 * "largest void of the pattern" — the two energy fields sum to a constant — so
 * one loop covers both phases exactly, not approximately.
 */
function voidAndCluster(size, seed) {
  const n = size * size;
  const rng = new Rng(seed);
  const binary = new Uint8Array(n);
  const energy = new Float32Array(n);

  // σ = 1.9 is the paper's value; the kernel is truncated at 3σ where its
  // contribution has fallen below a thousandth of the peak.
  const SIGMA = 1.9;
  const R = 6;
  const K = 2 * R + 1;
  const kern = new Float32Array(K * K);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      kern[(dy + R) * K + (dx + R)] = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA));
    }
  }

  const splat = (idx, sign) => {
    const cx = idx % size;
    const cy = (idx / size) | 0;
    for (let dy = -R; dy <= R; dy++) {
      const yy = ((cy + dy) % size + size) % size;
      const row = yy * size;
      const krow = (dy + R) * K;
      for (let dx = -R; dx <= R; dx++) {
        const xx = ((cx + dx) % size + size) % size;
        energy[row + xx] += sign * kern[krow + dx + R];
      }
    }
  };

  const tightestCluster = () => {
    let best = -1;
    let bestE = -Infinity;
    for (let i = 0; i < n; i++) {
      if (binary[i] && energy[i] > bestE) {
        bestE = energy[i];
        best = i;
      }
    }
    return best;
  };
  const largestVoid = () => {
    let best = -1;
    let bestE = Infinity;
    for (let i = 0; i < n; i++) {
      if (!binary[i] && energy[i] < bestE) {
        bestE = energy[i];
        best = i;
      }
    }
    return best;
  };

  const M = Math.max(1, Math.round(n * 0.1));
  let placed = 0;
  while (placed < M) {
    const i = rng.int(0, n - 1);
    if (!binary[i]) {
      binary[i] = 1;
      splat(i, 1);
      placed++;
    }
  }

  // Relax the initial white-noise pattern into a blue-noise prototype.
  for (let guard = 0; guard < n * 4; guard++) {
    const c = tightestCluster();
    binary[c] = 0;
    splat(c, -1);
    const v = largestVoid();
    if (v === c) {
      binary[c] = 1;
      splat(c, 1);
      break;
    }
    binary[v] = 1;
    splat(v, 1);
  }

  const proto = binary.slice();
  const rank = new Int32Array(n).fill(-1);

  // Phase I — ranks M-1 .. 0, peeling the prototype apart cluster-first.
  for (let r = M - 1; r >= 0; r--) {
    const c = tightestCluster();
    binary[c] = 0;
    splat(c, -1);
    rank[c] = r;
  }

  // Phases II & III — rebuild the prototype, then fill voids to the end.
  binary.set(proto);
  energy.fill(0);
  for (let i = 0; i < n; i++) if (binary[i]) splat(i, 1);
  for (let r = M; r < n; r++) {
    const v = largestVoid();
    if (v < 0) break;
    binary[v] = 1;
    splat(v, 1);
    rank[v] = r;
  }

  return rank;
}

function genBlueNoise(size, seed) {
  const rank = voidAndCluster(size, seed);
  // A second, independently seeded pattern in G lets shaders draw two
  // uncorrelated blue-noise values per fetch — needed for 2D sample offsets.
  const rank2 = voidAndCluster(size, seed ^ 0x7f4a7c15);
  const n = size * size;
  const bytes = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const a = Math.round((rank[i] / (n - 1)) * 255);
    const b = Math.round((rank2[i] / (n - 1)) * 255);
    bytes[i * 4] = a;
    bytes[i * 4 + 1] = b;
    bytes[i * 4 + 2] = 255 - a;
    bytes[i * 4 + 3] = a;
  }
  return texFromCanvas(paint(size, size, bytes), {
    srgb: false,
    wrap: THREE.RepeatWrapping,
    // Point sampling and no mips: filtering a blue-noise texture destroys the
    // spectral property that makes it worth generating.
    mips: false,
    filter: THREE.NearestFilter,
    name: 'blue-noise',
  });
}

/**
 * `macro-ground`: the low-frequency layer that gives terrain *form*.
 *
 * A tiled ground material is a lie that works only as long as the eye cannot
 * find the tile. At the density a battle stage needs (LookdevScene lands one
 * grass tile every 2.25 m) the detail map is the *only* signal in the frame,
 * every square metre carries the same statistics, and the bottom of the shot
 * reads as carpet — one frequency from the character's feet to the tree line.
 * Real ground has structure an order of magnitude larger than its grain: the
 * dry crown of a rise, the damp trough behind it, a scald where the sun sits.
 *
 * So this map is sampled at ~1/32 the detail tiling, which puts its features at
 * 8–15 m in a stage-scale scene — large enough to be composition, too large to
 * repeat inside one frame. Channels:
 *
 *   R  mid-scale value drift (0.5 neutral) — the ±0.06–0.10 linear swing §4 wants
 *   G  moisture, 0.5 neutral: below is dry and warm, above is damp, dark and smoother
 *   B  roughness drift (0.5 neutral), decorrelated from R so the two do not lock
 *   A  coarse value drift, ~4x R's period — stacked on R to avoid a single-scale read
 *
 * **No domain warping anywhere in this map, deliberately.** The previous build
 * pushed the value and moisture fields through an independent low-frequency
 * vector field to make their boundaries meander like drainage. Warped fBm is
 * the textbook *marble* generator, and that is precisely how the review read
 * the result: "directional smearing and stretch streaks … marbled oil rather
 * than ground". The warp shears a field's iso-contours along a common flow
 * direction, which produces exactly the elongated swirls veined stone is made
 * of — and at ±34% albedo, sampled 12 tiles across a 900 m stage, those swirls
 * are the largest structure in the bottom half of the frame. Every field here
 * is now isotropic, so the macro layer reads as swells and hollows with no
 * grain direction for the eye to lock onto.
 *
 * Moisture is a *localised* field rather than a second smooth fBm: damp ground
 * collects in discrete basins, so a large-cell Worley picks the basins and the
 * value form decides which of them are low enough to hold water. That gives
 * patches with a beginning and an end, which is what the ground actually wants;
 * a smooth field spread over everything is a second material, not a patch.
 */
function genMacroGround(size, seed) {
  const n = makeNoise(seed);
  n.maxPeriod = size * 0.5;
  const bytes = new Uint8ClampedArray(size * size * 4);
  const enc = (x) => (clamp(x * 0.5 + 0.5, 0, 1) * 255 + 0.5) | 0;
  const cell = new Float32Array(4);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = (x + 0.5) / size;

      const mid = n.fbm2(u, v, { period: 6, octaves: 3, gain: 0.5, z: 2.7 });
      const coarse = n.fbm2(u, v, { period: 2, octaves: 2, gain: 0.55, z: 17.9 });
      const rough = n.fbm2(u, v, { period: 5, octaves: 3, gain: 0.5, z: 49.6 });

      // Basins: five cells across the map, so roughly 14 m of stage each.
      n.worley2(u, v, 5, 1, cell);
      const basin = 1 - smoothstep(0.14, 0.55, cell[0]);
      // Only the basins that sit in a *hollow* of the value form hold damp, and
      // the crowns opposite them go mildly dry. The gains are set against the
      // measured distribution of `mid` rather than guessed: a three-octave fBm
      // is concentrated near zero, so the unit-gain version of this expression
      // left the dry half of the field inert on 99% of the map. These land it at
      // roughly 18% damp, 21% dry, 60% untinted, and nothing clips.
      const damp = basin * (0.22 + clamp(-mid * 3.0, 0, 1) * 0.63);
      const dry = clamp(mid * 3.2, 0, 1) * 0.6;

      bytes[i] = enc(mid * 1.15);
      bytes[i + 1] = enc(damp - dry);
      bytes[i + 2] = enc(rough * 1.1);
      bytes[i + 3] = enc(coarse);
    }
  }

  return texFromCanvas(paint(size, size, bytes), {
    srgb: false,
    wrap: THREE.RepeatWrapping,
    mips: true,
    name: 'macro-ground',
  });
}

export function generateUtility(key, opts = {}) {
  if (key === 'noise-rgb') return genNoiseRGB(opts.size ?? 256, seedFromKey(key));
  if (key === 'blue-noise') return genBlueNoise(opts.size ?? 64, seedFromKey(key));
  if (key === 'macro-ground') return genMacroGround(opts.size ?? 256, seedFromKey(key));
  throw new Error(`Textures: unknown utility "${key}"`);
}

/** Which family a key belongs to. AssetForge dispatches on this. */
export function classify(key) {
  if (SURFACES[key]) return 'surface';
  if (key.startsWith('ramp-')) return 'ramp';
  if (UTILITY_KEYS.includes(key)) return 'utility';
  if (SPRITE_KEYS.includes(key)) return 'sprite';
  return null;
}

export { DEFAULT_SIZE, SURFACES };
