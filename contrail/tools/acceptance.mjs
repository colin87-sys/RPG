// npm run acceptance [-- --skip a,b] [--only a,b] [--stage cloudgate] [--seed 1]
// Runs build (tsc + vite build), netcheck, refcheck, goldpath, perf, audiocheck and readability in
// sequence against one shared `vite preview` of dist/, prints a pass/fail table, writes
// checks.json.acceptance, and exits non-zero if any P0 check fails.
// Exit-code convention of the tools: 0 pass, 1 fail, 2 not available yet (counted as n/a, P1 only).
import { spawn } from 'node:child_process';
import { updateChecks } from './lib/checks.mjs';
import { startServer } from './lib/server.mjs';
import { ROOT, list, num, onCleanup, parseArgs, runTool, utcIso, verdict } from './lib/util.mjs';

const TOOL = 'acceptance';
const args = parseArgs();

function run(cmd, argv) {
  return new Promise((res) => {
    const t0 = Date.now();
    const child = spawn(cmd, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let last = '';
    const tee = (stream, out) =>
      stream.on('data', (d) => {
        out.write(d);
        for (const l of String(d).split('\n')) if (/^(PASS|FAIL) /.test(l.trim())) last = l.trim();
      });
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.on('close', (code) => res({ code, secs: (Date.now() - t0) / 1000, last }));
  });
}

runTool(TOOL, async () => {
  const stage = args.stage && args.stage !== true ? String(args.stage) : 'cloudgate';
  const seed = String(num(args.seed, 1));
  const steps = [
    { name: 'build', pri: 'P0', cmd: 'npm', argv: ['run', '--silent', 'build'] },
    { name: 'netcheck', pri: 'P0', tool: 'netcheck.mjs', argv: [] },
    { name: 'refcheck', pri: 'P0', tool: 'refcheck.mjs', argv: [] },
    { name: 'goldpath', pri: 'P0', tool: 'goldpath.mjs', argv: ['--stage', stage, '--seed', seed] },
    { name: 'perf', pri: 'P0', tool: 'perf.mjs', argv: ['--scene', stage, '--t', '150', '--seconds', '10'] },
    { name: 'audiocheck', pri: 'P0', tool: 'audiocheck.mjs', argv: [] },
    { name: 'readability', pri: 'P1', tool: 'readability.mjs', argv: ['--t', '150', '--stage', stage] },
  ];
  const skip = new Set(list(args.skip)), only = new Set(list(args.only));
  const rows = [];
  let server = null;
  for (const s of steps) {
    if (skip.has(s.name) || (only.size && !only.has(s.name))) {
      rows.push({ step: s.name, pri: s.pri, status: 'skipped', secs: 0, note: '' });
      continue;
    }
    if (s.tool && !server) {
      server = await startServer({}); // one preview for every child (they detect and reuse it)
      onCleanup(server.stop);
    }
    console.log(`\n=== ${s.name} ===`);
    const r = s.tool ? await run(process.execPath, [`tools/${s.tool}`, ...s.argv]) : await run(s.cmd, s.argv);
    const status = r.code === 0 ? 'pass' : r.code === 2 && s.pri !== 'P0' ? 'n/a' : 'FAIL';
    rows.push({ step: s.name, pri: s.pri, status, secs: Math.round(r.secs), note: r.last.replace(/^(PASS|FAIL) [\w:]+: /, '').slice(0, 110) || (r.code ? `exit ${r.code}` : '') });
    if (s.name === 'build' && r.code !== 0) {
      for (const n of steps.slice(1)) rows.push({ step: n.name, pri: n.pri, status: 'blocked', secs: 0, note: 'build failed' });
      break;
    }
  }
  const p0fail = rows.filter((r) => r.pri === 'P0' && (r.status === 'FAIL' || r.status === 'blocked'));
  const passed = p0fail.length === 0 && rows.some((r) => r.status === 'pass');
  console.log('\n| step | pri | status | s | note |\n|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.step} | ${r.pri} | ${r.status} | ${r.secs} | ${r.note} |`);
  await updateChecks({ acceptance: { utc: utcIso(), passed, rows } });
  verdict(TOOL, passed, passed ? 'all P0 checks pass' : `P0 failing: ${p0fail.map((r) => r.step).join(', ')}`);
  return passed ? 0 : 1;
});
