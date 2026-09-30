// npm run lab:capture -- --board hero --variants A,B,C [--dev] [--all] [--w 1920 --h 1080] [--seed 1] [--port n] [--timeout 120]
// Screenshots Look-Dev Lab boards to look/candidates/<board>_<V>.png and writes __labParams to <board>_<V>.json.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectErrors, imageStats, launchBrowser, newPage, pollFor } from './lib/browser.mjs';
import { updateChecks } from './lib/checks.mjs';
import { ensureDist, startServer } from './lib/server.mjs';
import { ROOT, ToolError, list, num, onCleanup, parseArgs, rel, runTool, verdict, writeFileAtomic, writeJsonAtomic } from './lib/util.mjs';

const TOOL = 'lab:capture';
const args = parseArgs(undefined, { booleans: ['dev', 'all', 'build', 'allow-blank'] });

runTool(TOOL, async () => {
  const boards = args.all
    ? readdirSync(join(ROOT, 'src', 'lab', 'boards')).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)).sort()
    : list(args.board);
  if (!boards.length) throw new ToolError('usage: npm run lab:capture -- --board <name> [--variants A,B,C] [--dev] | --all');
  const variants = list(args.variants, ['A', 'B', 'C']).map((v) => v.toUpperCase());
  const w = num(args.w, 1920), h = num(args.h, 1080), seed = num(args.seed, 1), timeout = num(args.timeout, 120) * 1000;
  if (!args.dev) await ensureDist({ force: !!args.build });
  const server = await startServer({ dev: !!args.dev, port: args.port });
  onCleanup(server.stop);
  const browser = await launchBrowser();
  onCleanup(() => browser.close());

  const saved = [], failures = [];
  let errCount = { console: 0, missing_refs: 0 };
  for (const board of boards) {
    for (const v of variants) {
      const tag = `${board}_${v}`;
      const { context, page } = await newPage(browser, { w, h });
      const errs = collectErrors(page);
      const url = `${server.base}/lab/index.html?board=${encodeURIComponent(board)}&variant=${v}&w=${w}&h=${h}&seed=${seed}`;
      const t0 = Date.now();
      try {
        await page.goto(url, { waitUntil: 'load' });
        const r = await pollFor(page, () => (window.__labError ? { error: String(window.__labError) } : window.__labReady ? { ready: true } : null), null, { timeout, what: `__labReady (${tag})` });
        if (r.error) {
          const hint = /unknown board/.test(r.error) && !args.dev ? ' (not in dist/: rebuild with --build or pass --dev)' : '';
          throw new Error(`__labError: ${r.error.split('\n')[0]}${hint}`);
        }
        const png = await page.screenshot({ type: 'png' });
        const stats = await imageStats(browser, png);
        const params = await page.evaluate(() => window.__labParams ?? null);
        const pngPath = await writeFileAtomic(join(ROOT, 'look', 'candidates', `${tag}.png`), png);
        await writeJsonAtomic(join(ROOT, 'look', 'candidates', `${tag}.json`), params ?? { note: 'board did not call ctx.exportParams()' });
        const problems = errs.list();
        if (params === null) problems.push('no __labParams (ctx.exportParams not called)');
        if (stats.blank && !args.allowBlank) problems.push(`blank image (luma std ${stats.std}, ${stats.colors} colours)`);
        const c = errs.counts();
        errCount.console += c.console;
        errCount.missing_refs += c.missing_refs;
        saved.push(rel(pngPath));
        console.log(`${problems.length ? 'WARN' : 'ok  '} ${rel(pngPath)}  ${stats.width}x${stats.height} luma ${stats.mean}±${stats.std} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        if (problems.length) failures.push(`${tag}: ${problems.slice(0, 3).join(' | ')}`);
      } catch (e) {
        failures.push(`${tag}: ${e.message}`);
        console.error(`FAIL ${tag}: ${e.message}`);
        const p = errs.list();
        if (p.length) console.error('  ' + p.slice(0, 5).join('\n  '));
      } finally {
        await context.close();
      }
    }
  }
  await updateChecks({}, { errors: { tool: TOOL, ...errCount }, captures: saved });
  if (failures.length) {
    verdict(TOOL, false, `${failures.length} problem(s): ${failures.join(' ; ')}`);
    return 1;
  }
  verdict(TOOL, true, `${saved.length} board capture(s) in look/candidates/`);
  return 0;
});
