// npm run netcheck [-- --build] [--play 10] [--boards all|a,b]
// Serves dist/ with vite preview, loads the game title, a ~10 s autopilot session and the Lab index
// (plus optional boards), records every request/websocket and fails if any host is not
// 127.0.0.1/localhost (data: and blob: are allowed). External requests are aborted after recording.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { collectErrors, launchBrowser, newPage, pollFor } from './lib/browser.mjs';
import { updateChecks } from './lib/checks.mjs';
import { distHasGame, ensureDist, startServer } from './lib/server.mjs';
import { ROOT, list, num, onCleanup, parseArgs, runTool, sleep, utcIso, verdict, walkFiles } from './lib/util.mjs';

const TOOL = 'netcheck';
const args = parseArgs(undefined, { booleans: ['build'] });
const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLocal(url) {
  if (/^(data|blob|about|chrome-error):/.test(url)) return true;
  try {
    return LOCAL.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

runTool(TOOL, async () => {
  const build = await ensureDist({ force: !!args.build });
  const server = await startServer({ port: args.port });
  onCleanup(server.stop);
  const browser = await launchBrowser(['--autoplay-policy=no-user-gesture-required']);
  onCleanup(() => browser.close());
  const { context, page } = await newPage(browser, { w: num(args.w, 1280), h: num(args.h, 720) });
  const requests = [], external = [];
  const record = (url, kind, pageName) => {
    requests.push({ url, kind, page: pageName });
    if (!isLocal(url)) external.push(`${kind} ${url} (on ${pageName})`);
  };
  let current = '';
  await context.route('**/*', (route) => {
    const u = route.request().url();
    record(u, route.request().resourceType(), current);
    return isLocal(u) ? route.continue() : route.abort('blockedbyclient');
  });
  page.on('websocket', (ws) => record(ws.url(), 'websocket', current));
  const errs = collectErrors(page);

  const playS = num(args.play, 10);
  const pages = [];
  const pending = [];
  if (distHasGame()) {
    pages.push({ name: 'game title', path: '/', wait: async () => (await sleep(3000), true) });
    pages.push({ name: `game autopilot ${playS}s`, path: '/?skip=1&bot=1&mute=1', wait: async () => (await sleep(playS * 1000), true) });
  } else pending.push('game pages skipped: dist/index.html missing (src/main.ts pending)');
  const labWait = async () => pollFor(page, () => (window.__labError ? { error: String(window.__labError) } : window.__labReady ? { ready: true } : null), null, { timeout: 120000, what: '__labReady' });
  pages.push({ name: 'lab index', path: '/lab/index.html', wait: labWait });
  let boards = list(args.boards);
  if (boards[0] === 'all') boards = readdirSync(join(ROOT, 'src', 'lab', 'boards')).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3));
  for (const b of boards) pages.push({ name: `board ${b}`, path: `/lab/index.html?board=${b}&variant=A&w=1280&h=720`, wait: labWait });

  const pageResults = [];
  for (const p of pages) {
    current = p.name;
    const before = requests.length;
    let ok = true, note = '';
    try {
      const resp = await page.goto(server.base + p.path, { waitUntil: 'load', timeout: 60000 });
      if (!resp || resp.status() >= 400) throw new Error(`HTTP ${resp && resp.status()}`);
      const r = await p.wait();
      if (r && r.error) note = `lab error: ${r.error.split('\n')[0]}`;
    } catch (e) {
      ok = false;
      note = e.message.split('\n')[0];
    }
    pageResults.push({ page: p.name, path: p.path, ok, requests: requests.length - before, ...(note ? { note } : {}) });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${p.name.padEnd(22)} ${String(requests.length - before).padStart(4)} requests ${note}`);
  }

  // Informational: external URL strings present in the shipped code (library comments etc.).
  const staticHosts = {};
  for (const f of walkFiles(join(ROOT, 'dist'))) {
    if (!['.js', '.html', '.css'].includes(extname(f))) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) staticHosts[m[1]] = (staticHosts[m[1]] || 0) + 1;
  }
  const hosts = [...new Set(requests.map((r) => (/^[a-z]+:\/\//.test(r.url) ? new URL(r.url).host : r.url.split(':')[0])))];
  const loadFailures = pageResults.filter((r) => !r.ok);
  const passed = external.length === 0 && loadFailures.length === 0;
  const counts = errs.counts();
  await updateChecks(
    {
      network: {
        utc: utcIso(),
        passed,
        status: passed ? (pending.length ? 'pass (lab only; game pending)' : 'pass') : 'fail',
        external_requests: external.length,
        requests_total: requests.length,
        hosts,
        external: external.slice(0, 20),
        pages: pageResults,
        pending,
        lab_only_build: build.labOnly,
        static_url_hosts_in_bundle: staticHosts,
      },
    },
    { errors: { tool: TOOL, ...counts } },
  );
  for (const e of external.slice(0, 20)) console.error(`  external: ${e}`);
  for (const p of pending) console.log(`note: ${p}`);
  if (errs.list().length) console.log(`page errors (not a netcheck failure, see checks.json errors): ${errs.list().slice(0, 3).join(' | ')}`);
  verdict(TOOL, passed, `${external.length} external request(s) of ${requests.length} on ${pageResults.length} page(s)${loadFailures.length ? `; ${loadFailures.length} page(s) failed to load` : ''}${pending.length ? ' [game pages pending]' : ''}`);
  return passed ? 0 : 1;
});
