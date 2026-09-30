// S6 readability maths. `analyzeReadability` is SELF-CONTAINED (no imports, no closures) so it can be
// shipped into the page with Function.prototype.toString and run on canvas ImageData, and also be
// unit-tested in Node. Colour difference: CIEDE2000 (Sharma, Wu, Dalal 2005), sRGB -> linear ->
// XYZ (D65) -> CIELAB.
//
// Method per hostile projectile (connected component of the object-ID mask, 8-connected, mask > 127):
//   projectile colour = mean CIELAB of frame pixels under the blob
//   local background  = mean CIELAB of a ring: chessboard dilation of the blob by (gap + ring) px minus
//                       dilation by gap px, minus every mask pixel (other projectiles excluded);
//                       gap = 1 px (skips anti-aliased edge), ring = clamp(round(0.75 * r_eq), 3, 12) px
//   deltaE = CIEDE2000(projectile, background)
// Summary: median and 10th percentile over projectiles (blobs < minArea px ignored). Pass: median >= 25.
export function analyzeReadability(frame, mask, opts) {
  const o = Object.assign({ minArea: 4, gap: 1, ringMin: 3, ringMax: 12, ringK: 0.75, threshold: 25, maxBlobs: 2000 }, opts || {});
  const W = frame.width, H = frame.height, F = frame.data, M = mask.data;
  if (mask.width !== W || mask.height !== H) throw new Error(`frame ${W}x${H} and mask ${mask.width}x${mask.height} differ`);
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const LUT = new Float64Array(256);
  for (let i = 0; i < 256; i++) LUT[i] = lin(i);
  const fxyz = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  function lab(i) {
    const r = LUT[F[i]], g = LUT[F[i + 1]], b = LUT[F[i + 2]];
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
    const fx = fxyz(x), fy = fxyz(y), fz = fxyz(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function de2000(l1, l2) {
    const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
    const rad = Math.PI / 180, deg = 180 / Math.PI;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
    const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const hp = (b, a) => (b === 0 && a === 0 ? 0 : ((Math.atan2(b, a) * deg) % 360 + 360) % 360);
    const h1p = hp(b1, a1p), h2p = hp(b2, a2p);
    const dLp = L2 - L1, dCp = C2p - C1p;
    let dhp = 0;
    if (C1p * C2p !== 0) {
      dhp = h2p - h1p;
      if (dhp > 180) dhp -= 360;
      else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
    const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hbp = h1p + h2p;
    if (C1p * C2p !== 0) {
      if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
      else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    }
    const Tt = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
    const dTh = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
    const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
    const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
    const Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * Tt;
    const Rt = -Math.sin(2 * dTh * rad) * Rc;
    return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
  }
  if (o.selftestPairs) return o.selftestPairs.map((p) => de2000(p[0], p[1]));

  const on = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) on[i] = M[i * 4] > 127 ? 1 : 0;
  const label = new Int32Array(W * H);
  const blobs = [];
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!on[s] || label[s]) continue;
    const id = blobs.length + 1;
    const px = [];
    label[s] = id;
    stack.push(s);
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (stack.length) {
      const p = stack.pop();
      px.push(p);
      const x = p % W, y = (p - x) / W;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (on[q] && !label[q]) {
            label[q] = id;
            stack.push(q);
          }
        }
    }
    blobs.push({ id, px, x0, y0, x1, y1 });
    if (blobs.length >= o.maxBlobs) break;
  }
  const results = [];
  for (const b of blobs) {
    if (b.px.length < o.minArea) continue;
    const req = Math.sqrt(b.px.length / Math.PI);
    const ring = Math.max(o.ringMin, Math.min(o.ringMax, Math.round(o.ringK * req)));
    const R = o.gap + ring;
    // chessboard distance to the blob inside its bbox + R (BFS, 8-neighbour)
    const bx0 = Math.max(0, b.x0 - R), by0 = Math.max(0, b.y0 - R), bx1 = Math.min(W - 1, b.x1 + R), by1 = Math.min(H - 1, b.y1 + R);
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
    const dist = new Int16Array(bw * bh).fill(-1);
    let q = [];
    for (const p of b.px) {
      const x = p % W, y = (p - x) / W, k = (y - by0) * bw + (x - bx0);
      dist[k] = 0;
      q.push(k);
    }
    for (let d = 1; d <= R && q.length; d++) {
      const nq = [];
      for (const k of q) {
        const x = k % bw, y = (k - x) / bw;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
            const nk = ny * bw + nx;
            if (dist[nk] < 0) {
              dist[nk] = d;
              nq.push(nk);
            }
          }
      }
      q = nq;
    }
    let fL = 0, fa = 0, fb = 0;
    for (const p of b.px) {
      const c = lab(p * 4);
      fL += c[0];
      fa += c[1];
      fb += c[2];
    }
    const n = b.px.length;
    let gL = 0, ga = 0, gb = 0, gn = 0;
    for (let k = 0; k < dist.length; k++) {
      if (dist[k] <= o.gap) continue;
      const x = (k % bw) + bx0, y = ((k - (k % bw)) / bw) + by0, p = y * W + x;
      if (on[p]) continue;
      const c = lab(p * 4);
      gL += c[0];
      ga += c[1];
      gb += c[2];
      gn++;
    }
    if (!gn) continue;
    const fg = [fL / n, fa / n, fb / n], bg = [gL / gn, ga / gn, gb / gn];
    results.push({ x: Math.round((b.x0 + b.x1) / 2), y: Math.round((b.y0 + b.y1) / 2), w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, area: n, ring, ringPx: gn, deltaE: de2000(fg, bg), fg, bg });
  }
  const des = results.map((r) => r.deltaE).sort((a, b) => a - b);
  const pct = (p) => {
    if (!des.length) return null;
    const i = ((des.length - 1) * p) / 100, lo = Math.floor(i), hi = Math.ceil(i);
    return des[lo] + (des[hi] - des[lo]) * (i - lo);
  };
  return { width: W, height: H, blobs: blobs.length, projectiles: results.length, median: pct(50), p10: pct(10), threshold: o.threshold, passed: results.length > 0 && pct(50) >= o.threshold, results };
}

/** Sharma et al. (2005) CIEDE2000 reference pairs used by --selftest. */
export const SHARMA_PAIRS = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
  [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
  [[50, 0, 0], [50, -1, 2], 2.3669],
  [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
  [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
  [[50, 2.5, 0], [73, 25, -18], 27.1492],
  [[50, 2.5, 0], [61, -5, 29], 22.8977],
  [[50, 2.5, 0], [56, -27, -3], 31.903],
  [[50, 2.5, 0], [58, 24, 15], 19.4535],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
];
