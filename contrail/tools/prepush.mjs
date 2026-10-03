// npm run prepush — the gate to run before every push: build (tsc + vite build), refcheck, netcheck.
// Stops at the first failure and exits non-zero. Pair it with a git pre-push hook if wanted.
import { spawn } from 'node:child_process';
import { ROOT, runTool, verdict } from './lib/util.mjs';

const run = (cmd, argv) =>
  new Promise((res) => spawn(cmd, argv, { cwd: ROOT, stdio: 'inherit' }).on('close', res));

runTool('prepush', async () => {
  const steps = [
    ['build', 'npm', ['run', '--silent', 'build']],
    ['refcheck', process.execPath, ['tools/refcheck.mjs']],
    ['netcheck', process.execPath, ['tools/netcheck.mjs']],
  ];
  for (const [name, cmd, argv] of steps) {
    console.log(`\n=== prepush: ${name} ===`);
    const code = await run(cmd, argv);
    if (code !== 0) {
      verdict('prepush', false, `${name} failed (exit ${code}); do not push`);
      return 1;
    }
  }
  verdict('prepush', true, 'build + refcheck + netcheck pass');
  return 0;
});
