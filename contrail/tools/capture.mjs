// npm run capture -- --cams hero,vista,combat,hud,title --seed 1 --t 12 [--stage cloudgate] [--w 1920 --h 1080]
//                     [--feature name] [--dev] [--clean] [--build] [--allow-blank]
// Story-camera captures in deterministic mode. Per camera: fresh page at
// /?det=1&seed&w&h&stage&mute=1 -> __game.ready -> start({stage}) (not for 'title') -> setTime(t)
// (not for 'title': setTime would start a stage) -> setCamera(cam) -> step(2) -> page screenshot.
// Saves Docs/captures/latest/<cam>.png and Docs/progress/<feature|general>/<UTC>_<cam>.png.
import { join } from 'node:path';
import { collectErrors, imageStats, launchBrowser, newPage } from './lib/browser.mjs';
import { updateChecks } from './lib/checks.mjs';
import { gameErrors, gameUrl, waitGame } from './lib/game.mjs';
import { ensureDist, startServer } from './lib/server.mjs';
import { ROOT, ToolError, list, num, onCleanup, parseArgs, rel, runTool, safeName, utcIso, utcStamp, verdict, writeFileAtomic } from './lib/util.mjs';

const TOOL = 'capture';
const args = parseArgs(undefined, { booleans: ['dev', 'clean', 'build', 'allow-blank'] });

runTool(TOOL, async () => {
  const cams = list(args.cams, ['hero', 'vista', 'combat', 'hud', 'title']);
  const seed = num(args.seed, 1), t = num(args.t, 12), w = num(args.w, 1920), h = num(args.h, 1080);
  const stage = args.stage && args.stage !== true ? String(args.stage) : 'cloudgate';
  const feature = safeName(args.feature && args.feature !== true ? args.feature : 'general');
  const stamp = utcStamp();
  if (!args.dev) await ensureDist({ force: !!args.build });
  const server = await startServer({ dev: !!args.dev, port: args.port });
  onCleanup(server.stop);
  const browser = await launchBrowser();
  onCleanup(() => browser.close());

  const files = [], problems = [], stats = {};
  const errTotal = { console: 0, missing_refs: 0 };
  for (const cam of cams) {
    const { context, page } = await newPage(browser, { w, h });
    const errs = collectErrors(page);
    try {
      await page.goto(gameUrl(server.base, { det: 1, seed, w, h, stage, mute: 1, clean: !!args.clean }), { waitUntil: 'load' });
      await waitGame(page);
      const available = await page.evaluate(() => window.__game.cameras());
      if (!available.includes(cam)) throw new ToolError(`unknown camera '${cam}' (available: ${available.join(', ')})`);
      const st = await page.evaluate(
        ({ cam, stage, t }) => {
          const g = window.__game;
          if (cam !== 'title') {
            g.start({ stage });
            g.setTime(t);
          }
          g.setCamera(cam);
          g.step(2);
          return g.state();
        },
        { cam, stage, t },
      );
      const png = await page.screenshot({ type: 'png' });
      const s = await imageStats(browser, png);
      const latest = await writeFileAtomic(join(ROOT, 'Docs', 'captures', 'latest', `${cam}.png`), png);
      const prog = await writeFileAtomic(join(ROOT, 'Docs', 'progress', feature, `${stamp}_${cam}.png`), png);
      files.push(rel(prog));
      const gErr = await gameErrors(page);
      const c = errs.counts(gErr);
      errTotal.console += c.console;
      errTotal.missing_refs += c.missing_refs;
      const errList = errs.list(gErr.map((e) => `game: ${e}`));
      stats[cam] = { state: st.state, time: Math.round(st.time * 100) / 100, luma_mean: s.mean, luma_std: s.std, colors: s.colors, size: `${s.width}x${s.height}` };
      if (s.width !== w || s.height !== h) problems.push(`${cam}: image is ${s.width}x${s.height}, expected ${w}x${h}`);
      if (s.blank && !args.allowBlank) problems.push(`${cam}: blank image (luma std ${s.std})`);
      if (errList.length) problems.push(`${cam}: ${errList.length} page error(s): ${errList.slice(0, 2).join(' | ')}`);
      console.log(`${cam.padEnd(7)} ${rel(latest)}  state=${st.state} t=${st.time.toFixed(1)}s luma ${s.mean}±${s.std}`);
    } catch (e) {
      problems.push(`${cam}: ${e.message}`);
      console.error(`FAIL ${cam}: ${e.message}`);
    } finally {
      await context.close();
    }
  }
  await updateChecks(
    { capture: { utc: utcIso(), passed: problems.length === 0, cams, seed, t, stage, w, h, feature, files, stats, problems } },
    { errors: { tool: TOOL, ...errTotal }, captures: files },
  );
  if (problems.length) {
    verdict(TOOL, false, problems.join(' ; '));
    return 1;
  }
  verdict(TOOL, true, `${files.length} capture(s): Docs/captures/latest/ + Docs/progress/${feature}/${stamp}_*.png`);
  return 0;
});
