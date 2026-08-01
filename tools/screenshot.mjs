#!/usr/bin/env node
/**
 * Headless capture harness.
 *
 * Boots the built game in Chromium, drives it through a named scenario, and
 * writes PNGs plus a console log. This is what the art-direction critics
 * actually look at, so it needs to be deterministic: fixed viewport, fixed
 * device pixel ratio, and a seeded RNG injected before any game code runs.
 *
 *   node tools/screenshot.mjs --scenario field --out shots/field
 *   node tools/screenshot.mjs --list
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = parseArgs(process.argv.slice(2));

/**
 * A scenario is a sequence of steps run against the live page. `hook` names a
 * function on `window.__AW__` (the debug surface the Engine exposes) so
 * scenarios stay declarative and the game keeps ownership of how it poses
 * itself.
 */
const SCENARIOS = {
  boot: [{ wait: 2500, shot: 'boot' }],
  lookdev: [
    { hook: ['gotoLookdev'], wait: 4000, shot: 'lookdev-wide' },
    { hook: ['poseCamera', 'sphere-grid'], wait: 1200, shot: 'lookdev-spheres' },
    { hook: ['poseCamera', 'materials'], wait: 1200, shot: 'lookdev-materials' },
    { hook: ['poseCamera', 'hero-closeup'], wait: 1200, shot: 'lookdev-closeup' },
    { hook: ['poseCamera', 'horizon'], wait: 1200, shot: 'lookdev-horizon' },
  ],
  // The money shot: the chibi cast staged as they appear in battle. This is
  // what the art-direction critics judge hardest, because it is the frame the
  // player spends most of the game looking at.
  cast: [
    { hook: ['gotoLookdev'], wait: 4500, shot: 'cast-stage' },
    { hook: ['poseCamera', 'lineup'], wait: 1500, shot: 'cast-lineup' },
    { hook: ['poseCamera', 'hero-closeup'], wait: 1500, shot: 'cast-closeup' },
    { hook: ['poseCamera', 'silhouette'], wait: 1500, shot: 'cast-silhouette' },
  ],
  daycycle: [
    { hook: ['gotoLookdev'], wait: 4000 },
    { hook: ['poseCamera', 'horizon'], wait: 800 },
    { hook: ['setTimeOfDay', 0.24], wait: 1400, shot: 'tod-dawn' },
    { hook: ['setTimeOfDay', 0.5], wait: 1400, shot: 'tod-noon' },
    { hook: ['setTimeOfDay', 0.79], wait: 1400, shot: 'tod-dusk' },
    { hook: ['setTimeOfDay', 0.96], wait: 1400, shot: 'tod-night' },
  ],
  field: [
    { hook: ['gotoField'], wait: 3500, shot: 'field-wide' },
    { hook: ['poseCamera', 'hero-closeup'], wait: 1200, shot: 'field-hero' },
    { hook: ['setTimeOfDay', 0.82], wait: 1500, shot: 'field-dusk' },
    { hook: ['setTimeOfDay', 0.05], wait: 1500, shot: 'field-night' },
  ],
  battle: [
    { hook: ['gotoBattle'], wait: 4000, shot: 'battle-open' },
    { hook: ['poseCamera', 'battle-command'], wait: 1200, shot: 'battle-command' },
    { hook: ['castAbility', 'firaga'], wait: 1400, shot: 'battle-spell' },
    { hook: ['castAbility', 'limit'], wait: 1800, shot: 'battle-limit' },
  ],
  esper: [
    { hook: ['gotoBattle'], wait: 4000 },
    { hook: ['summon', 'bahamut'], wait: 2000, shot: 'esper-rise' },
    { wait: 2500, shot: 'esper-impact' },
    { wait: 2500, shot: 'esper-after' },
  ],
  ui: [
    { hook: ['gotoField'], wait: 3000 },
    { hook: ['openMenu', 'party'], wait: 900, shot: 'menu-party' },
    { hook: ['openMenu', 'abilities'], wait: 900, shot: 'menu-abilities' },
  ],
};

if (args.list) {
  console.log(Object.keys(SCENARIOS).join('\n'));
  process.exit(0);
}

const scenarioName = args.scenario ?? 'boot';
const steps = SCENARIOS[scenarioName];
if (!steps) {
  console.error(`Unknown scenario "${scenarioName}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

const outDir = resolve(args.out ?? `shots/${scenarioName}`);
const url = args.url ?? 'http://localhost:4173/';
const width = Number(args.width ?? 1920);
const height = Number(args.height ?? 1080);

await mkdir(outDir, { recursive: true });

// The container ships a pinned Chromium that predates the npm playwright
// build, so point at it explicitly rather than triggering a browser download.
const CHROME = process.env.AW_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--hide-scrollbars',
  ],
});

const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: 1,
});

const logs = [];
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`));

// Seed determinism before the module graph evaluates: fixed RNG and a frozen
// clock base so procedural art and animation land identically every capture.
await page.addInitScript(() => {
  let seed = 0x2f6e2b1;
  window.__AW_SEED__ = seed;
  window.__AW_CAPTURE__ = true;
});

let failed = false;
try {
  await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForFunction(() => !!window.__AW__, null, { timeout: 90_000 });

  for (const step of steps) {
    if (step.hook) {
      const [name, ...rest] = step.hook;
      await page.evaluate(
        async ([fn, params]) => {
          const api = window.__AW__;
          if (typeof api?.[fn] !== 'function') throw new Error(`missing debug hook: ${fn}`);
          await api[fn](...params);
        },
        [name, rest],
      );
    }
    if (step.wait) await page.waitForTimeout(step.wait);
    if (step.shot) {
      const file = resolve(outDir, `${step.shot}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
  }
} catch (err) {
  failed = true;
  logs.push(`[harness] ${err.message}`);
  console.error(`[harness] ${err.message}`);
  // Still capture whatever is on screen — a broken frame is diagnostic too.
  try {
    await page.screenshot({ path: resolve(outDir, 'FAILURE.png') });
  } catch {}
} finally {
  await writeFile(resolve(outDir, 'console.log'), logs.join('\n'), 'utf8');
  await browser.close();
}

if (logs.some((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'))) {
  console.error('--- page errors ---');
  console.error(logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]')).join('\n'));
  failed = true;
}

process.exit(failed ? 1 : 0);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
