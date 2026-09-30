// npm run perf -- --scene cloudgate --t 150 --seconds 10 [--w 1920 --h 1080] [--dev] [--no-bot] [--warmup 20]
// Deterministic mode, setTime(t) to the heaviest moment, then real-time-ish: one step(1) per
// requestAnimationFrame for N wall seconds. Frame time = interval between consecutive rAF
// callbacks (includes SwiftShader raster); reports median and p99 (the "1% low").
// Budgets (LANE_BRIEF rule 6): <= 250 draw calls and <= 450k triangles at peak -> exit 1 if exceeded.
import { collectErrors, launchBrowser, newPage } from './lib/browser.mjs';
import { updateChecks } from './lib/checks.mjs';
import { gameErrors, gameUrl, waitGame } from './lib/game.mjs';
import { ensureDist, startServer } from './lib/server.mjs';
import { median, num, onCleanup, parseArgs, percentile, round, runTool, utcIso, verdict } from './lib/util.mjs';

const TOOL = 'perf';
const args = parseArgs(undefined, { booleans: ['dev', 'build', 'bot'] });
const BUDGET = { draw_calls: 250, triangles: 450000 };

runTool(TOOL, async () => {
  const scene = args.scene && args.scene !== true ? String(args.scene) : 'cloudgate';
  const t = num(args.t, 150), seconds = num(args.seconds, 10), w = num(args.w, 1920), h = num(args.h, 1080), seed = num(args.seed, 1);
  const bot = args.bot !== false;
  if (!args.dev) await ensureDist({ force: !!args.build });
  const server = await startServer({ dev: !!args.dev, port: args.port });
  onCleanup(server.stop);
  const browser = await launchBrowser();
  onCleanup(() => browser.close());
  const { page } = await newPage(browser, { w, h });
  const errs = collectErrors(page);
  await page.goto(gameUrl(server.base, { det: 1, seed, mute: 1, stage: scene, w, h }), { waitUntil: 'load' });
  await waitGame(page);
  const r = await page.evaluate(
    async ({ scene, t, seconds, bot, warmup }) => {
      const g = window.__game;
      g.start({ stage: scene });
      g.setBot(bot);
      g.setTime(t);
      const raf = () => new Promise((res) => requestAnimationFrame(res));
      for (let i = 0; i < warmup; i++) {
        await raf();
        g.step(1);
      }
      const frames = [], stepMs = [], dc = [], tri = [];
      let last = await raf();
      const end = last + seconds * 1000;
      for (;;) {
        const s0 = performance.now();
        g.step(1);
        stepMs.push(performance.now() - s0);
        const p = g.perf();
        dc.push(p.drawCalls);
        tri.push(p.triangles);
        const now = await raf();
        frames.push(now - last);
        last = now;
        if (now >= end) break;
      }
      const st = g.state();
      return { frames, stepMs, dc, tri, perf: g.perf(), state: { state: st.state, time: st.time, enemies: st.enemiesAlive, projectiles: st.hostileProjectiles } };
    },
    { scene, t, seconds, bot, warmup: num(args.warmup, 20) },
  );
  const fMed = median(r.frames), fP99 = percentile(r.frames, 99);
  const dcMax = Math.max(...r.dc), triMax = Math.max(...r.tri);
  const method = r.perf.softwareGL ? 'software-GL relative (SwiftShader, no GPU)' : 'hardware GL (headless Chromium)';
  const gErr = await gameErrors(page);
  const errList = errs.list(gErr.map((e) => `game: ${e}`));
  const failures = [];
  if (dcMax > BUDGET.draw_calls) failures.push(`draw calls ${dcMax} > ${BUDGET.draw_calls}`);
  if (triMax > BUDGET.triangles) failures.push(`triangles ${triMax} > ${BUDGET.triangles}`);
  if (errList.length) failures.push(`${errList.length} page error(s): ${errList.slice(0, 2).join(' | ')}`);
  const passed = failures.length === 0;
  const perf = {
    utc: utcIso(),
    passed,
    status: passed ? 'pass (budgets)' : 'fail',
    scene,
    t,
    seconds,
    w,
    h,
    frames: r.frames.length,
    frame_ms_median: round(fMed, 2),
    frame_ms_p99: round(fP99, 2),
    fps_median: round(1000 / fMed, 1),
    fps_p1_low: round(1000 / fP99, 1),
    step_ms_median: round(median(r.stepMs), 2),
    draw_calls: Math.round(median(r.dc)),
    draw_calls_max: dcMax,
    triangles: Math.round(median(r.tri)),
    triangles_max: triMax,
    programs: r.perf.programs,
    textures: r.perf.textures,
    geometries: r.perf.geometries,
    enemies_alive: r.state.enemies,
    hostile_projectiles: r.state.projectiles,
    sim_state: r.state.state,
    bot,
    budget: { ...BUDGET, ok: dcMax <= BUDGET.draw_calls && triMax <= BUDGET.triangles },
    method,
    failures,
  };
  await updateChecks({ perf }, { errors: { tool: TOOL, ...errs.counts(gErr) } });
  console.log(`${scene} t=${t}s ${w}x${h}: ${perf.frames} frames, median ${perf.frame_ms_median} ms (${perf.fps_median} fps), p99 ${perf.frame_ms_p99} ms (${perf.fps_p1_low} fps 1% low), step ${perf.step_ms_median} ms, draw calls ${perf.draw_calls} (max ${dcMax}), triangles ${perf.triangles} (max ${triMax}), enemies ${r.state.enemies}, hostile shots ${r.state.projectiles} [${method}]`);
  verdict(TOOL, passed, passed ? `budgets ok (draw calls max ${dcMax}/${BUDGET.draw_calls}, triangles max ${triMax}/${BUDGET.triangles}); fps ${perf.fps_median} median / ${perf.fps_p1_low} 1% low is ${method}` : failures.join('; '));
  return passed ? 0 : 1;
});
