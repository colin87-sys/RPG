// npm run audiocheck [-- --dev] [--timeout 120]
// Loads /lab/index.html?board=audio (Audio lane). The board offline-renders every SFX and music loop
// and sets window.__audioResults = [{name, kind:'sfx'|'music', durationS, peakDbfs, rmsDbfs, dcOffset,
// clipping, loopSeamOk, spectrogramPng, intensity?}]. Thresholds (GAME_FORGE W8):
//   peak <= -1 dBFS, no clipping, |DC| < 0.01, SFX RMS -30..-10 dBFS,
//   music RMS -24..-12 dBFS (only items at intensity 0.6 when names/fields carry an intensity), loop seam ok.
// Spectrograms -> Docs/captures/audio/<name>.png. Status is always 'pending owner review' (not audible to the agent).
import { join } from 'node:path';
import { collectErrors, launchBrowser, newPage, pollFor } from './lib/browser.mjs';
import { updateChecks } from './lib/checks.mjs';
import { ensureDist, startServer } from './lib/server.mjs';
import { ROOT, ToolError, num, onCleanup, parseArgs, rel, round, runTool, safeName, utcIso, verdict, writeFileAtomic } from './lib/util.mjs';

const TOOL = 'audiocheck';
const args = parseArgs(undefined, { booleans: ['dev', 'build'] });
const T = { peakMax: -1, dcMax: 0.01, sfxRms: [-30, -10], musicRms: [-24, -12], musicIntensity: 0.6 };

/** Intensity from an explicit field or the name (music@0.6, music_i0.6, intensity=0.6, int06). */
function intensityOf(it) {
  if (Number.isFinite(it.intensity)) return it.intensity;
  const m = String(it.name).match(/(?:intensity|int|i|@)[=_:-]?(0?\.\d+|1(?:\.0+)?|0\d)(?![\d])/i);
  if (!m) return null;
  return /^0\d$/.test(m[1]) ? Number(m[1]) / 10 : Number(m[1]);
}

runTool(TOOL, async () => {
  if (!args.dev) await ensureDist({ force: !!args.build });
  const server = await startServer({ dev: !!args.dev, port: args.port });
  onCleanup(server.stop);
  const browser = await launchBrowser();
  onCleanup(() => browser.close());
  const { page } = await newPage(browser, { w: 1280, h: 720 });
  const errs = collectErrors(page);
  await page.goto(`${server.base}/lab/index.html?board=audio&w=1280&h=720`, { waitUntil: 'load' });
  const r = await pollFor(
    page,
    () => {
      if (window.__labError) return { error: String(window.__labError) };
      if (Array.isArray(window.__audioResults)) return { ok: true };
      if (window.__labReady) return (window.__readySince ??= Date.now()) && Date.now() - window.__readySince > 5000 ? { error: 'board is ready but window.__audioResults was never set' } : null;
      return null;
    },
    null,
    { timeout: num(args.timeout, 120) * 1000, what: 'window.__audioResults' },
  );
  if (r.error) {
    if (/unknown board/.test(r.error)) {
      await updateChecks({ audio: { utc: utcIso(), passed: false, status: 'audio board missing', items: 0 } });
      throw new ToolError(`audio board missing (src/lab/boards/audio.ts${args.dev ? '' : ' in dist/: rebuild or pass --dev'})`);
    }
    throw new ToolError(`audio board error: ${r.error.split('\n')[0]}`);
  }
  const items = await page.evaluate(() => window.__audioResults);
  if (!items.length) throw new ToolError('__audioResults is empty');
  const music = items.filter((i) => i.kind === 'music');
  const namedIntensity = music.some((m) => intensityOf(m) !== null);
  const failures = [], spectrograms = [];
  for (const it of items) {
    const f = (msg) => failures.push(`${it.name}: ${msg}`);
    if (!(it.peakDbfs <= T.peakMax)) f(`peak ${round(it.peakDbfs)} dBFS > ${T.peakMax}`);
    if (it.clipping) f('clipping');
    if (!(Math.abs(it.dcOffset) < T.dcMax)) f(`DC offset ${it.dcOffset}`);
    if (it.kind === 'sfx' && !(it.rmsDbfs >= T.sfxRms[0] && it.rmsDbfs <= T.sfxRms[1])) f(`SFX RMS ${round(it.rmsDbfs)} dBFS outside ${T.sfxRms.join('..')}`);
    if (it.kind === 'music') {
      const inten = intensityOf(it);
      const applies = !namedIntensity || (inten !== null && Math.abs(inten - T.musicIntensity) < 1e-6);
      if (applies && !(it.rmsDbfs >= T.musicRms[0] && it.rmsDbfs <= T.musicRms[1])) f(`music RMS ${round(it.rmsDbfs)} dBFS outside ${T.musicRms.join('..')}`);
    }
    if (it.loopSeamOk === false) f('loop seam discontinuity');
    if (typeof it.spectrogramPng === 'string' && it.spectrogramPng.startsWith('data:image/png;base64,')) {
      const p = await writeFileAtomic(join(ROOT, 'Docs', 'captures', 'audio', `${safeName(it.name)}.png`), Buffer.from(it.spectrogramPng.split(',')[1], 'base64'));
      spectrograms.push(rel(p));
    } else f('no spectrogramPng');
  }
  const errList = errs.list();
  if (errList.length) failures.push(`${errList.length} page error(s): ${errList.slice(0, 2).join(' | ')}`);
  const musicRef = music.filter((m) => !namedIntensity || Math.abs((intensityOf(m) ?? -1) - T.musicIntensity) < 1e-6);
  const passed = failures.length === 0;
  await updateChecks(
    {
      audio: {
        utc: utcIso(),
        passed,
        status: 'pending owner review',
        clipping: items.some((i) => i.clipping),
        peak_dbfs: round(Math.max(...items.map((i) => i.peakDbfs)), 2),
        rms_dbfs: musicRef.length ? round(musicRef.reduce((a, m) => a + m.rmsDbfs, 0) / musicRef.length, 2) : null,
        loop_seam_ok: music.every((m) => m.loopSeamOk !== false),
        items: items.length,
        failures,
        thresholds: T,
        spectrograms,
        table: items.map((i) => ({ name: i.name, kind: i.kind, dur: round(i.durationS, 2), peak: round(i.peakDbfs, 1), rms: round(i.rmsDbfs, 1), dc: round(i.dcOffset, 4), clip: !!i.clipping, seam: i.loopSeamOk ?? null })),
      },
    },
    { errors: { tool: TOOL, ...errs.counts() }, captures: [] },
  );
  for (const i of items) console.log(`${i.kind.padEnd(5)} ${String(i.name).padEnd(24)} peak ${round(i.peakDbfs, 1)} rms ${round(i.rmsDbfs, 1)} dc ${round(i.dcOffset, 4)}${i.clipping ? ' CLIP' : ''}${i.loopSeamOk === false ? ' SEAM' : ''}`);
  verdict(TOOL, passed, passed ? `${items.length} item(s) within thresholds; spectrograms in Docs/captures/audio/ (pending owner review)` : failures.slice(0, 8).join('; '));
  return passed ? 0 : 1;
});
