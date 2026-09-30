// npm run goldpath [-- --stage cloudgate --seed 1 --timeout 400 --dev --require a,b|none --log-every 5 --w 1920 --h 1080]
// Scripted play-through of the core loop on the built game in deterministic mode:
// setBot(true) -> start({stage}) -> step(60) (1 simulated second) until state 'results' (pass) or
// 'gameover' / timeout (fail). NEVER calls setInvulnerable. Asserts every required mechanic fired
// (counts()), results.cleared === true and zero page errors. Captures at 25/50/75 % and results.
import { join } from 'node:path';
import { collectErrors, launchBrowser, newPage } from './lib/browser.mjs';
import { updateChecks } from './lib/checks.mjs';
import { gameErrors, gameUrl, missingApi, waitGame } from './lib/game.mjs';
import { ensureDist, startServer } from './lib/server.mjs';
import { ROOT, ToolError, list, num, onCleanup, parseArgs, rel, round, runTool, utcIso, utcStamp, verdict, writeFileAtomic } from './lib/util.mjs';

const TOOL = 'goldpath';
const args = parseArgs(undefined, { booleans: ['dev', 'build'] });
export const DEFAULT_MECHANICS = ['cannonFire', 'missileFire', 'enemyKilled:missile', 'parry', 'drift', 'wingtrail', 'shieldRefill'];

runTool(TOOL, async () => {
  const stage = args.stage && args.stage !== true ? String(args.stage) : 'cloudgate';
  const seed = num(args.seed, 1), timeout = num(args.timeout, 400), w = num(args.w, 1920), h = num(args.h, 1080);
  const logEvery = num(args.logEvery, 5), wallTimeout = num(args.wallTimeout, 1800) * 1000;
  const required = args.require === 'none' ? [] : list(args.require, DEFAULT_MECHANICS);
  const stamp = utcStamp();
  if (!args.dev) await ensureDist({ force: !!args.build });
  const server = await startServer({ dev: !!args.dev, port: args.port });
  onCleanup(server.stop);
  const browser = await launchBrowser();
  onCleanup(() => browser.close());
  const { page } = await newPage(browser, { w, h });
  const errs = collectErrors(page);

  await page.goto(gameUrl(server.base, { det: 1, seed, mute: 1, stage, w, h }), { waitUntil: 'load' });
  await waitGame(page);
  const missing = await missingApi(page, ['setBot', 'start', 'step', 'state', 'counts', 'errors']);
  if (missing.length) throw new ToolError(`__game lacks ${missing.join(', ')}`);
  await page.evaluate((stage) => {
    const g = window.__game;
    g.setBot(true);
    g.start({ stage });
    g.setBot(true); // idempotent; guards against start() resetting input scripts
  }, stage);

  const steps = [], captures = [];
  const marks = [0.25, 0.5, 0.75];
  let s, sim = 0, reason = '', lastTime = -1, stall = 0;
  const wall0 = Date.now();
  const snap = async (label) => {
    const f = await writeFileAtomic(join(ROOT, 'Docs', 'progress', 'goldpath', `${stamp}_${label}.png`), await page.screenshot({ type: 'png' }));
    captures.push(rel(f));
  };
  for (;;) {
    s = await page.evaluate(() => {
      const g = window.__game;
      g.step(60);
      return g.state();
    });
    sim += 1;
    const row = { t: sim, state: s.state, stage_t: round(s.time, 1), progress: round(s.progress, 3), score: s.score, shield: round(s.shield, 1), kills: s.kills };
    if (sim % logEvery === 0 || s.state !== 'play') steps.push(row);
    while (marks.length && s.progress >= marks[0]) await snap(`p${Math.round(marks.shift() * 100)}`);
    if (sim % 30 === 0) console.log(`t=${sim}s state=${s.state} progress=${(s.progress * 100).toFixed(0)}% score=${s.score} shield=${Math.round(s.shield)} kills=${s.kills}`);
    if (s.state === 'results') {
      await snap('results');
      break;
    }
    if (s.state === 'gameover') {
      reason = `game over at t=${sim}s (progress ${(s.progress * 100).toFixed(0)}%, kills ${s.kills})`;
      await snap('gameover');
      break;
    }
    if (s.state === 'title' && sim >= 10) {
      reason = 'start() did not leave the title within 10 s';
      break;
    }
    stall = s.state === 'play' && s.time === lastTime ? stall + 1 : 0;
    lastTime = s.time;
    if (stall >= 10) {
      reason = `simulation stalled at stage time ${s.time}s`;
      break;
    }
    if (sim >= timeout) {
      reason = `timeout after ${timeout} simulated s (state ${s.state}, progress ${(s.progress * 100).toFixed(0)}%)`;
      break;
    }
    if (Date.now() - wall0 > wallTimeout) {
      reason = `wall-clock timeout (${wallTimeout / 1000} s) at t=${sim}s`;
      break;
    }
  }
  if (steps.at(-1)?.t !== sim) steps.push({ t: sim, state: s.state, stage_t: round(s.time, 1), progress: round(s.progress, 3), score: s.score, shield: round(s.shield, 1), kills: s.kills });
  const counts = await page.evaluate(() => window.__game.counts());
  const mechanics = Object.fromEntries(required.map((k) => [k, counts[k] ?? 0]));
  const notFired = required.filter((k) => !(counts[k] > 0));
  const gErr = await gameErrors(page);
  const errList = errs.list(gErr.map((e) => `game: ${e}`));
  const failures = [];
  if (reason) failures.push(reason);
  if (s.state === 'results' && !(s.results && s.results.cleared === true)) failures.push('results.cleared is not true');
  if (notFired.length) failures.push(`mechanic(s) never fired: ${notFired.join(', ')}`);
  if (errList.length) failures.push(`${errList.length} page error(s): ${errList.slice(0, 3).join(' | ')}`);
  const passed = failures.length === 0;
  await updateChecks(
    {
      goldpath: {
        utc: utcIso(),
        passed,
        status: passed ? 'pass' : 'fail',
        stage,
        seed,
        duration_s: sim,
        wall_s: round((Date.now() - wall0) / 1000, 1),
        final: { state: s.state, results: s.results, score: s.score, shield: s.shield, kills: s.kills, bestCombo: s.bestCombo },
        mechanics,
        required,
        missing_mechanics: notFired,
        counts,
        failures,
        captures,
        steps,
      },
    },
    { errors: { tool: TOOL, ...errs.counts(gErr) }, captures },
  );
  console.log(`mechanics: ${required.map((k) => `${k}=${counts[k] ?? 0}`).join(' ')}`);
  verdict(TOOL, passed, passed ? `cleared ${stage} in ${sim} s (rank ${s.results?.rank}, score ${s.score}, shield ${Math.round(s.shield)}), all ${required.length} mechanics fired` : failures.join('; '));
  return passed ? 0 : 1;
});
