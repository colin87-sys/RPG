// Perceptual average-hash (aHash) computed in Chromium canvas: image -> 16x16 greyscale (high-quality
// downscale) -> bit = luma > mean. 256 bits as 64 hex chars. Near-duplicates (re-encoded, resized,
// lightly edited copies) stay within a few bits; flag Hamming distance <= 6.
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

export const PHASH_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** aHash of each file (null for undecodable/huge files). Uses one blank page in `browser`. */
export async function aHashFiles(browser, files, { maxBytes = 25 * 1024 * 1024 } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const out = new Map();
  try {
    for (const f of files) {
      if (statSync(f).size > maxBytes) {
        out.set(f, null);
        continue;
      }
      const url = `data:${MIME[extname(f).toLowerCase()] || 'image/png'};base64,${readFileSync(f).toString('base64')}`;
      const h = await page
        .evaluate(async (url) => {
          const img = new Image();
          img.src = url;
          await img.decode();
          // two-stage downscale for a fair area average
          const mid = new OffscreenCanvas(128, 128), m = mid.getContext('2d');
          m.imageSmoothingQuality = 'high';
          m.drawImage(img, 0, 0, 128, 128);
          const c = new OffscreenCanvas(16, 16), g = c.getContext('2d', { willReadFrequently: true });
          g.imageSmoothingQuality = 'high';
          g.drawImage(mid, 0, 0, 16, 16);
          const d = g.getImageData(0, 0, 16, 16).data;
          const y = [];
          for (let i = 0; i < d.length; i += 4) y.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
          const mean = y.reduce((a, b) => a + b, 0) / y.length;
          let hex = '';
          for (let i = 0; i < 256; i += 4) hex += ((y[i] > mean) << 3 | (y[i + 1] > mean) << 2 | (y[i + 2] > mean) << 1 | (y[i + 3] > mean)).toString(16);
          return hex;
        }, url)
        .catch(() => null);
      out.set(f, h);
    }
  } finally {
    await context.close();
  }
  return out;
}

const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}
