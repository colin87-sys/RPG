// Start/stop the Vite server the harness drives, and build dist/ when needed.
//  - built-game checks: `vite preview` on 4173 serving dist/
//  - --dev: `vite` dev server on 5209 (5210 is the spare harness port)
// A server already listening on the port is reused only if it is this project's server; the
// harness only ever kills processes it started itself (by process-group PID).
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { ROOT, TMP, onCleanup, sleep } from './util.mjs';

export const PREVIEW_PORT = 4173;
export const DEV_PORT = 5209;
const VITE_BIN = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

export function httpGet(url, timeout = 5000) {
  return new Promise((res) => {
    const req = http.get(url, { timeout }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => res({ status: 0, body: '' }));
  });
}

export function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), res(true)));
    s.once('error', () => res(false));
    s.setTimeout(1500, () => (s.destroy(), res(false)));
  });
}

async function isOurDev(base) {
  const a = await httpGet(`${base}/@vite/client`);
  const b = await httpGet(`${base}/lab/index.html`);
  return a.status === 200 && b.status === 200 && b.body.includes('/src/lab/main.ts');
}
async function isOurPreview(base) {
  for (const [url, file] of [
    ['/lab/index.html', 'dist/lab/index.html'],
    ['/', 'dist/index.html'],
  ]) {
    const f = join(ROOT, file);
    if (!existsSync(f)) continue;
    const r = await httpGet(base + url);
    return r.status === 200 && r.body.trim() === readFileSync(f, 'utf8').trim();
  }
  return false;
}

export const distHasGame = () => existsSync(join(ROOT, 'dist', 'index.html'));
export const distExists = () => distHasGame() || existsSync(join(ROOT, 'dist', 'lab', 'index.html'));
export const gameEntryExists = () => existsSync(join(ROOT, 'src', 'main.ts'));

/**
 * `vite build` through the Vite API with the project config (no tsc: types never change the output;
 * `npm run build` is the typechecked build). If src/main.ts does not exist yet, the game input is
 * dropped and only the Look-Dev Lab page is built (labOnly: true).
 */
export async function viteBuild() {
  const { build, loadConfigFromFile } = await import('vite');
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, join(ROOT, 'vite.config.ts'), ROOT, 'warn');
  const cfg = loaded.config;
  let labOnly = false;
  if (!gameEntryExists()) {
    const input = cfg.build?.rollupOptions?.input;
    if (input && typeof input === 'object' && input.main) {
      delete input.main;
      labOnly = true;
    }
  }
  const t0 = Date.now();
  await build({ ...cfg, root: ROOT, configFile: false, logLevel: 'warn' });
  console.log(`built dist/ in ${((Date.now() - t0) / 1000).toFixed(1)} s${labOnly ? ' (lab only: src/main.ts is pending)' : ''}`);
  return { built: true, labOnly };
}

/** Build dist/ if it is missing (or always with force). */
export async function ensureDist({ force = false } = {}) {
  if (!force && distExists()) return { built: false, labOnly: !distHasGame() };
  return viteBuild();
}

/**
 * Start (or reuse) a server. Returns {base, port, reused, pid, stop()}. stop() is also
 * registered as a tool cleanup, so crashes do not leave servers behind.
 */
export async function startServer({ dev = false, port } = {}) {
  port = Number(port && port !== true ? port : dev ? DEV_PORT : PREVIEW_PORT);
  const base = `http://127.0.0.1:${port}`;
  const kind = dev ? 'vite dev' : 'vite preview (dist/)';
  if (!dev && !distExists()) throw new Error('dist/ is missing: run `npm run build` first (or pass --build)');
  if (await portOpen(port)) {
    if (!(dev ? await isOurDev(base) : await isOurPreview(base)))
      throw new Error(`port ${port} is busy with a server that is not this project's ${kind}; stop it or pass --port <n>`);
    console.log(`reusing ${kind} at ${base}`);
    return { base, port, reused: true, pid: null, stop: async () => {} };
  }
  const logFile = join(TMP, `contrail-vite-${dev ? 'dev' : 'preview'}-${port}.log`);
  const fd = openSync(logFile, 'a');
  const args = [VITE_BIN, ...(dev ? [] : ['preview']), '--port', String(port), '--strictPort', '--host', '127.0.0.1'];
  const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
  let exited = false;
  child.on('exit', () => (exited = true));
  const kill = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  const onExit = () => kill('SIGTERM');
  process.on('exit', onExit);
  const stop = async () => {
    if (exited) return;
    kill('SIGTERM');
    for (let i = 0; i < 30 && !exited; i++) await sleep(100);
    if (!exited) kill('SIGKILL');
    process.off('exit', onExit);
  };
  onCleanup(stop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => (kill('SIGTERM'), process.exit(130)));
  const t0 = Date.now();
  const probe = dev ? '/@vite/client' : distHasGame() ? '/' : '/lab/index.html';
  for (;;) {
    if (exited) throw new Error(`${kind} exited early; see ${logFile}:\n${readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n')}`);
    const r = await httpGet(base + probe, 2000);
    if (r.status === 200) break;
    if (Date.now() - t0 > 60000) {
      await stop();
      throw new Error(`${kind} did not answer on ${base} within 60 s (log ${logFile})`);
    }
    await sleep(200);
  }
  console.log(`started ${kind} at ${base} (pid ${child.pid}, log ${logFile})`);
  return { base, port, reused: false, pid: child.pid, stop };
}
