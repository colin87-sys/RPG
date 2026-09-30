// Chromium launch (software GL), page error collection, navigation-robust polling, image stats.
import { chromium } from 'playwright';
import { sleep } from './util.mjs';

/** Verified in ENV_AUDIT: WebGL2 + float render targets through ANGLE/SwiftShader, no GPU needed. */
export const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export async function launchBrowser(extraArgs = []) {
  return chromium.launch({ headless: true, args: [...GL_ARGS, ...extraArgs] });
}

/** Fresh context + page with an exact CSS viewport and devicePixelRatio 1 (screenshots are w x h). */
export async function newPage(browser, { w = 1920, h = 1080 } = {}) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  return { context, page };
}

/**
 * Collect console errors, uncaught exceptions, failed requests and HTTP >= 400 responses.
 * net::ERR_ABORTED (navigation/teardown) is recorded as info, not an error.
 */
export function collectErrors(page) {
  const e = { console: [], pageerror: [], requestfailed: [], http: [], aborted: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') e.console.push(m.text());
  });
  page.on('pageerror', (err) => e.pageerror.push(String((err && err.stack) || err)));
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText || 'failed';
    (f.includes('ERR_ABORTED') ? e.aborted : e.requestfailed).push(`${f} ${r.url()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) e.http.push(`${r.status()} ${r.url()}`);
  });
  return {
    raw: e,
    /** all fatal messages (page errors + console errors + failed/404 requests + extra) */
    list(extra = []) {
      return [...e.pageerror.map((s) => `pageerror: ${s}`), ...e.console.map((s) => `console: ${s}`), ...e.requestfailed.map((s) => `requestfailed: ${s}`), ...e.http.map((s) => `http: ${s}`), ...extra];
    },
    /** counts for checks.json errors.by_tool */
    counts(gameErrors = []) {
      const known = new Set(e.console.map((s) => s.slice(0, 160)));
      const extraGame = gameErrors.filter((s) => !known.has(String(s).slice(0, 160)));
      return { console: e.console.length + e.pageerror.length + extraGame.length, missing_refs: e.requestfailed.length + e.http.length };
    },
  };
}

/**
 * Poll `fn(arg)` in the page until it returns a truthy value. Survives reloads/navigations
 * (e.g. the Vite dev optimizer reloading the page), unlike a single waitForFunction.
 */
export async function pollFor(page, fn, arg, { timeout = 60000, interval = 200, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try {
      v = await page.evaluate(fn, arg);
    } catch (err) {
      if (!/Execution context was destroyed|Cannot find context|navigat|Target closed/i.test(String(err && err.message))) throw err;
    }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout after ${Math.round(timeout / 1000)} s waiting for ${what}`);
    await sleep(interval);
  }
}

/** Width/height from a PNG IHDR chunk. */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Luma mean/std and number of distinct (4-bit quantised) colours of an image, computed in a
 * blank Chromium page on a 320 px wide downscale. blank = (colours <= 4 or std < 1).
 */
export async function imageStats(browser, buf, mime = 'image/png') {
  const context = await browser.newContext();
  const p = await context.newPage();
  try {
    const s = await p.evaluate(
      async ({ b64, mime }) => {
        const img = new Image();
        img.src = `data:${mime};base64,${b64}`;
        await img.decode();
        const W = 320, H = Math.max(1, Math.round((320 * img.naturalHeight) / img.naturalWidth));
        const c = new OffscreenCanvas(W, H);
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, W, H);
        const d = g.getImageData(0, 0, W, H).data;
        let s = 0, s2 = 0;
        const cols = new Set();
        for (let i = 0; i < d.length; i += 4) {
          const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          s += y;
          s2 += y * y;
          cols.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
        }
        const n = W * H, mean = s / n;
        return { width: img.naturalWidth, height: img.naturalHeight, mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)), colors: cols.size };
      },
      { b64: buf.toString('base64'), mime },
    );
    s.mean = Math.round(s.mean * 10) / 10;
    s.std = Math.round(s.std * 10) / 10;
    s.blank = s.colors <= 4 || s.std < 1;
    return s;
  } finally {
    await context.close();
  }
}
