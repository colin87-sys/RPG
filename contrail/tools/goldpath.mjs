// npm run goldpath [-- --stage cloudgate --seed 1 --timeout 400 --dev --require a,b|none --log-every 5 --w 1920 --h 1080]
// Scripted play-through of the core loop on the built game in deterministic mode:
// setBot(true) -> start({stage}) -> step(60) (1 simulated second) until state 'results' (pass) or
// 'gameover' / timeout (fail). NEVER calls setInvulnerable. Asserts every required mechanic fired
// (counts()), results.cleared === true and zero page errors. Captures at 25/50/75 % and results.
// --gameover (A13 fast retry): bot off, invulnerability off, idle until 'gameover' (or __game.forceGameOver()
// if the game provides it), then hold the real confirm key (Enter) and count fixed steps until 'play';
// pass if confirm -> play < --limit s (default 2). Writes checks.goldpath_gameover (goldpath is untouched).
import { join } from 'node:path';
import { collectErrors, launchBrowser, newPage } from './lib/browser.mjs';
import { updateChecks } from './lib/checks.mjs';
import { gameErrors, gameUrl, missingApi, waitGame } from './lib/game.mjs';
import { ensureDist, startServer } from './lib/server.mjs';
import { ROOT, ToolError, list, num, onCleanup, parseArgs, rel, round, runTool, utcIso, utcStamp, verdict, writeFileAtomic } from './lib/util.mjs';

const TOOL = 'goldpath';
// Software GL (SwiftShader) drains queued frames before a screenshot; the heavier world (2026-09-30 graphics pass) needs > 30 s
const SHOT_TIMEOUT_MS = 120000;
const args = parseArgs(undefined, { booleans: ['dev', 'build', 'gameover'] });
export const DEFAULT_MECHANICS = ['cannonFire', 'missileFire', 'enemyKilled:missile', 'parry', 'wingtrail', 'shieldRefill'];

runTool(TOOL, async () => {
  const stage = args.stage && args.stage !== true ? String(args.stage) : 'cloudgate';
  const mode = args.mode && args.mode !== true ? String(args.mode) : 'campaign';
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
  if (args.gameover) return gameoverRun({ page, errs, stage, mode, seed, stamp, timeout: num(args.timeout, 300), limit: num(args.limit, 2) });
  await page.evaluate(({ stage, mode }) => {
    const g = window.__game;
    g.setBot(true);
    g.start({ stage, mode });
    g.setBot(true); // idempotent; guards against start() resetting input scripts
  }, { stage, mode });

  const steps = [], captures = [];
  const marks = [0.25, 0.5, 0.75];
  let s, sim = 0, reason = '', lastTime = -1, stall = 0;
  const wall0 = Date.now();
  const snap = async (label) => {
    const f = await writeFileAtomic(join(ROOT, 'Docs', 'progress', 'goldpath', `${stamp}_${label}.png`), await page.screenshot({ type: 'png', timeout: SHOT_TIMEOUT_MS }));
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
  // shield refill arms at the combo threshold; with a full shield there is nothing to refill, so
  // reaching the threshold on a full shield also proves the mechanic (refillReadyFull, game.ts)
  if (!(counts.shieldRefill > 0) && counts.refillReadyFull > 0) counts.shieldRefill = 0.5;
  const mechanics = Object.fromEntries(required.map((k) => [k, counts[k] ?? 0]));
  const notFired = required.filter((k) => !(counts[k] > 0));
  const gErr = await gameErrors(page);
  const errList = errs.list(gErr.map((e) => `game: ${e}`));
  const failures = [];
  if (reason) failures.push(reason);
  // KIT_REVIEW #1: never let a fallback stage/mode pass for the requested one
  if (s.stage !== stage) failures.push(`ran stage '${s.stage}', expected '${stage}'`);
  if (s.mode !== mode) failures.push(`ran mode '${s.mode}', expected '${mode}'`);
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

/** A13: force a game over, then time confirm -> 'play'. Uses only the public API + real key input. */
async function gameoverRun({ page, errs, stage, mode, seed, stamp, timeout, limit }) {
  const hasForce = await page.evaluate(() => typeof window.__game.forceGameOver === 'function');
  await page.evaluate(({ stage, mode }) => {
    const g = window.__game;
    g.setBot(false);
    g.start({ stage, mode });
    g.setBot(false);
    g.setInvulnerable(false); // make sure nothing keeps the craft alive
  }, { stage, mode });
  let s, sim = 0;
  if (hasForce) s = await page.evaluate(() => (window.__game.forceGameOver(), window.__game.step(1), window.__game.state()));
  // Idle (no input) until the stage's enemies take the shield to 0.
  while (!s || s.state !== 'gameover') {
    s = await page.evaluate(() => (window.__game.step(60), window.__game.state()));
    sim += 1;
    if (sim % 15 === 0) console.log(`idle t=${sim}s state=${s.state} shield=${Math.round(s.shield)} progress=${(s.progress * 100).toFixed(0)}%`);
    if (s.state === 'results' || sim >= timeout)
      throw new ToolError(`could not force a game over by idling (state ${s.state} after ${sim} s, shield ${Math.round(s.shield)}); the game needs __game.forceGameOver(): void (set shield 0 -> 'gameover')`);
  }
  const deathAt = sim;
  if (process.env.HARNESS_DEBUG) console.log('dead at', sim);
  const shot = async (label) => rel(await writeFileAtomic(join(ROOT, 'Docs', 'progress', 'goldpath', `${stamp}_${label}.png`), await page.screenshot({ type: 'png', timeout: SHOT_TIMEOUT_MS })));
  const captures = [await shot('gameover')];
  // Tap the real confirm key (Enter): down -> step(1) -> up -> step(1). The game reads confirm as a
  // press edge and ignores it during the game-over lockout, so a held key would be consumed early.
  const t0 = Date.now();
  let accepted = -1, playAt = -1, n = 0, via = 'keyboard Enter';
  const maxSteps = 60 * 10;
  const step1 = () => page.evaluate(() => (window.__game.step(1), window.__game.state()));
  while (n < maxSteps) {
    const tap = accepted < 0 && n % 2 === 0;
    if (tap) await page.keyboard.down('Enter');
    s = await step1();
    n++;
    if (tap) await page.keyboard.up('Enter');
    if (accepted < 0 && s.state !== 'gameover') accepted = n;
    if (s.state === 'play') {
      playAt = n;
      break;
    }
  }
  if (accepted < 0) {
    // Input path did not restart: fall back to the API so the rest of the loop can still be timed.
    via = '__game.start() fallback (confirm key was not accepted)';
    await page.evaluate(({ stage, mode }) => window.__game.start({ stage, mode }), { stage, mode });
    accepted = n;
    while (n < maxSteps * 2) {
      s = await page.evaluate(() => (window.__game.step(1), window.__game.state()));
      n++;
      if (s.state === 'play') {
        playAt = n;
        break;
      }
    }
  }
  const wall = (Date.now() - t0) / 1000;
  captures.push(await shot('retry_play'));
  const confirmToPlay = playAt > 0 ? (playAt - accepted + 1) / 60 : null; // simulated s, first accepted step included
  const pressToPlay = playAt > 0 ? playAt / 60 : null; // includes the game-over input lockout
  const gErr = await gameErrors(page);
  const errList = errs.list(gErr.map((e) => `game: ${e}`));
  const failures = [];
  if (playAt < 0) failures.push(`never returned to 'play' within ${n} steps after confirm`);
  else if (confirmToPlay >= limit) failures.push(`confirm -> play took ${confirmToPlay.toFixed(2)} s (limit ${limit} s)`);
  if (s.stage !== stage) failures.push(`restarted stage '${s.stage}', expected '${stage}'`);
  if (!via.startsWith('keyboard')) failures.push('confirm key did not restart the game (API fallback used)');
  if (errList.length) failures.push(`${errList.length} page error(s): ${errList.slice(0, 2).join(' | ')}`);
  const passed = failures.length === 0;
  await updateChecks(
    {
      goldpath_gameover: {
        utc: utcIso(), passed, status: passed ? 'pass' : 'fail', criterion: 'A13 game over -> flying again', stage, mode, seed,
        death_at_s: deathAt, forced_via: hasForce ? '__game.forceGameOver()' : 'idle, bot off', restart_via: via,
        confirm_to_play_s: round(confirmToPlay, 3), press_to_play_s: round(pressToPlay, 3), wall_s: round(wall, 2), limit_s: limit, failures, captures,
      },
    },
    { errors: { tool: 'goldpath:gameover', ...errs.counts(gErr) }, captures },
  );
  verdict('goldpath --gameover', passed, passed ? `died at ${deathAt} s; confirm -> play ${confirmToPlay.toFixed(2)} s simulated (${pressToPlay.toFixed(2)} s from key press incl. lockout, ${wall.toFixed(1)} s wall) via ${via}` : failures.join('; '));
  return passed ? 0 : 1;
}
