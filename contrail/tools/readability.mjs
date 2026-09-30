// npm run readability -- --t 150 --stage cloudgate [--seed 1] [--cam combat] [--w 1920 --h 1080] [--dev] [--selftest]
// S6: hostile-projectile contrast against the local background, measured with an object-ID mask.
// Contract (proposed, not yet in src/debug/api.ts):
//   __game.readabilityMasks(): Promise<{frame: string, mask: string}>
//   frame = PNG data URL of the composited frame; mask = PNG data URL, same camera and size, hostile
//   projectiles drawn pure white on black (no bloom/AA requirement; > 127 counts as projectile).
// Maths: tools/lib/readability-math.mjs (CIEDE2000 on mean CIELAB, blob vs 1 px-gap ring). Pass: median dE >= 25.
// Exit 2 with "readability API not implemented yet" when the game lacks the method.
import { join } from 'node:path';
import { collectErrors, launchBrowser, newPage } from './lib/browser.mjs';
import { updateChecks } from './lib/checks.mjs';
import { gameErrors, gameUrl, waitGame } from './lib/game.mjs';
import { SHARMA_PAIRS, analyzeReadability } from './lib/readability-math.mjs';
import { ensureDist, startServer } from './lib/server.mjs';
import { toolTheme } from './lib/theme.mjs';
import { ROOT, ToolError, num, onCleanup, parseArgs, rel, round, runTool, utcIso, utcStamp, verdict, writeFileAtomic } from './lib/util.mjs';

const TOOL = 'readability';
const args = parseArgs(undefined, { booleans: ['dev', 'build', 'selftest'] });
const SRC = analyzeReadability.toString();

/** In-page: decode two PNG data URLs, run the analysis, draw an overlay (green pass / red fail boxes). */
async function inPage({ src, frame, mask, opts, ok, bad }) {
  const analyze = (0, eval)(`(${src})`);
  const decode = async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    return { c, g, data: g.getImageData(0, 0, c.width, c.height) };
  };
  const F = await decode(frame), M = await decode(mask);
  const res = analyze(F.data, M.data, opts);
  const g = F.g;
  g.lineWidth = 2;
  for (const r of res.results) {
    g.strokeStyle = r.deltaE >= res.threshold ? ok : bad;
    g.strokeRect(r.x - r.w / 2 - r.ring - 2, r.y - r.h / 2 - r.ring - 2, r.w + 2 * r.ring + 4, r.h + 2 * r.ring + 4);
  }
  const blob = await F.c.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  res.overlay = btoa(bin);
  res.results = res.results.map((r) => ({ x: r.x, y: r.y, area: r.area, deltaE: Math.round(r.deltaE * 100) / 100 }));
  return res;
}

/** Synthetic frame + mask: discs of known colours on known backgrounds. */
async function synthetic(page) {
  return page.evaluate(() => {
    const W = 400, H = 200;
    const mk = () => {
      const c = new OffscreenCanvas(W, H);
      return [c, c.getContext('2d')];
    };
    const [fc, f] = mk(), [mc, m] = mk();
    // left half background grey 128, right half background rgb(40,90,200); discs rgb(250,240,200) and rgb(140,128,128)
    f.fillStyle = 'rgb(128,128,128)';
    f.fillRect(0, 0, W / 2, H);
    f.fillStyle = 'rgb(40,90,200)';
    f.fillRect(W / 2, 0, W / 2, H);
    m.fillStyle = 'rgb(0,0,0)';
    m.fillRect(0, 0, W, H);
    const discs = [
      [100, 60, 'rgb(250,240,200)'],
      [100, 140, 'rgb(140,128,128)'],
      [300, 100, 'rgb(250,240,200)'],
    ];
    f.imageSmoothingEnabled = false;
    for (const [x, y, col] of discs) {
      // hard-edged squares (no AA) so the expected colours are exact
      f.fillStyle = col;
      f.fillRect(x - 8, y - 8, 16, 16);
      m.fillStyle = 'rgb(255,255,255)';
      m.fillRect(x - 8, y - 8, 16, 16);
    }
    const url = (c) => {
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      cv.getContext('2d').drawImage(c.transferToImageBitmap(), 0, 0);
      return cv.toDataURL('image/png');
    };
    return { frame: url(fc), mask: url(mc) };
  });
}

runTool(TOOL, async () => {
  const th = await toolTheme();
  const opts = { threshold: num(args.threshold, 25) };
  const browser = await launchBrowser();
  onCleanup(() => browser.close());

  if (args.selftest) {
    const got = analyzeReadability({ width: 1, height: 1, data: [] }, { width: 1, height: 1, data: [] }, { selftestPairs: SHARMA_PAIRS.map((p) => [p[0], p[1]]) });
    const bad = SHARMA_PAIRS.map((p, i) => ({ want: p[2], got: round(got[i], 4) })).filter((r) => Math.abs(r.want - r.got) > 1e-3);
    console.log(`CIEDE2000 vs Sharma 2005 reference pairs: ${SHARMA_PAIRS.length - bad.length}/${SHARMA_PAIRS.length} match to 1e-3`);
    const { page } = await newPage(browser, { w: 400, h: 200 });
    await page.goto('about:blank');
    const syn = await synthetic(page);
    const res = await page.evaluate(inPage, { src: SRC, ...syn, opts, ok: th.ok, bad: th.bad });
    // expected: disc vs its own background computed directly from the known colours
    const px = (rgb) => ({ width: 1, height: 1, data: [...rgb, 255] });
    const direct = (a, b) => analyzeReadability(px(a), { width: 1, height: 1, data: [255, 255, 255, 255] }, { minArea: 1 }); // not used for ring; see below
    void direct;
    const expect = await page.evaluate(
      ({ src }) => {
        const analyze = (0, eval)(`(${src})`);
        // 3x3 frame: centre = disc colour, border = background; mask = centre only, gap 0, ring 1
        const one = (fg, bg) => {
          const d = [];
          for (let i = 0; i < 9; i++) d.push(...(i === 4 ? fg : bg), 255);
          const m = [];
          for (let i = 0; i < 9; i++) m.push(...(i === 4 ? [255, 255, 255] : [0, 0, 0]), 255);
          return analyze({ width: 3, height: 3, data: d }, { width: 3, height: 3, data: m }, { minArea: 1, gap: 0, ringMin: 1, ringMax: 1 }).results[0].deltaE;
        };
        return [one([250, 240, 200], [128, 128, 128]), one([140, 128, 128], [128, 128, 128]), one([250, 240, 200], [40, 90, 200])];
      },
      { src: SRC },
    );
    const measured = res.results.sort((a, b) => a.x - b.x || a.y - b.y).map((r) => r.deltaE);
    const synOk = res.projectiles === 3 && measured.every((m, i) => Math.abs(m - expect[i]) < 0.05);
    console.log(`synthetic: ${res.projectiles} blobs, measured dE ${measured.join(', ')} vs expected ${expect.map((e) => round(e, 2)).join(', ')}; median ${round(res.median, 2)}, p10 ${round(res.p10, 2)}`);
    const passed = !bad.length && synOk;
    if (bad.length) console.error(`mismatches: ${JSON.stringify(bad)}`);
    verdict(TOOL, passed, passed ? 'selftest ok (CIEDE2000 reference pairs + synthetic mask/ring pipeline)' : 'selftest failed');
    return passed ? 0 : 1;
  }

  const stage = args.stage && args.stage !== true ? String(args.stage) : 'cloudgate';
  const t = num(args.t, 150), seed = num(args.seed, 1), w = num(args.w, 1920), h = num(args.h, 1080);
  const cam = args.cam && args.cam !== true ? String(args.cam) : 'play';
  if (!args.dev) await ensureDist({ force: !!args.build });
  const server = await startServer({ dev: !!args.dev, port: args.port });
  onCleanup(server.stop);
  const { page } = await newPage(browser, { w, h });
  const errs = collectErrors(page);
  await page.goto(gameUrl(server.base, { det: 1, seed, mute: 1, stage, w, h }), { waitUntil: 'load' });
  await waitGame(page);
  if (!(await page.evaluate(() => typeof window.__game.readabilityMasks === 'function'))) {
    await updateChecks({ readability: { utc: utcIso(), status: 'readability API not implemented yet', passed: null } });
    throw new ToolError('readability API not implemented yet (__game.readabilityMasks(): Promise<{frame, mask}>)', 2);
  }
  const masks = await page.evaluate(
    async ({ stage, t, cam }) => {
      const g = window.__game;
      g.start({ stage });
      g.setBot(true);
      g.setTime(t);
      g.setCamera(cam);
      g.step(2);
      return g.readabilityMasks();
    },
    { stage, t, cam },
  );
  const res = await page.evaluate(inPage, { src: SRC, frame: masks.frame, mask: masks.mask, opts, ok: th.ok, bad: th.bad });
  const overlay = await writeFileAtomic(join(ROOT, 'Docs', 'captures', 'readability', `${utcStamp()}_${stage}_t${t}.png`), Buffer.from(res.overlay, 'base64'));
  const gErr = await gameErrors(page);
  const passed = res.passed && errs.list(gErr).length === 0;
  await updateChecks(
    {
      readability: {
        utc: utcIso(),
        passed,
        status: res.projectiles ? (passed ? 'pass' : 'fail') : 'no hostile projectiles in mask',
        stage,
        t,
        cam,
        projectiles: res.projectiles,
        deltaE_median: round(res.median, 2),
        deltaE_p10: round(res.p10, 2),
        threshold: res.threshold,
        method: 'CIEDE2000 between mean CIELAB (D65) of projectile pixels and a local ring (1 px gap, 3-12 px wide, other projectiles excluded); object-ID mask from __game.readabilityMasks()',
        overlay: rel(overlay),
        worst: [...res.results].sort((a, b) => a.deltaE - b.deltaE).slice(0, 10),
      },
    },
    { errors: { tool: TOOL, ...errs.counts(gErr) }, captures: [rel(overlay)] },
  );
  verdict(TOOL, passed, `${res.projectiles} projectile(s), dE00 median ${round(res.median, 1)} / p10 ${round(res.p10, 1)} (need median >= ${res.threshold}); overlay ${rel(overlay)}`);
  return passed ? 0 : 1;
});
