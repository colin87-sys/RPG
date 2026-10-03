// checks.json merge-writer (GAME_FORGE Appendix C). Read-modify-write under a lock, atomic rename.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, TMP, sleep, utcIso, writeJsonAtomic } from './util.mjs';

export const CHECKS = join(ROOT, 'checks.json');
const LOCK = join(TMP, 'contrail-checks.json.lock');
const MAX_CAPTURES = 100;

/** Appendix C skeleton. Unmeasured values are null + status 'not run' (never a fake pass). */
export function skeleton() {
  return {
    utc: '',
    commit: '',
    milestone: '',
    goldpath: { passed: false, duration_s: null, steps: [], status: 'not run' },
    perf: { scene: '', fps_median: null, fps_p1_low: null, draw_calls: null, method: '', status: 'not run' },
    errors: { console: 0, missing_refs: 0, by_tool: {} },
    network: { external_requests: null, status: 'not run' },
    refcheck: { ref_files_in_build: null, status: 'not run' },
    audio: { clipping: null, peak_dbfs: null, rms_dbfs: null, loop_seam_ok: null, status: 'not run' },
    captures: [],
  };
}

export function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'no-commit';
  }
}

/** Milestone from --milestone or Docs/PLAN.md ("## Current" section, else the 'in progress' row). M-ids win over P-ids. */
export function milestone(override) {
  if (override && override !== true) return String(override);
  try {
    const t = readFileSync(join(ROOT, 'Docs', 'PLAN.md'), 'utf8');
    const pick = (s) => (s && (s.match(/\bM\d+\b/) || s.match(/\bP\d+\b/))?.[0]) || '';
    const cur = t.split(/^##\s+Current\b/m)[1]?.split(/^##\s/m)[0];
    const fromCur = pick(cur);
    if (fromCur) return fromCur;
    const row = t.split('\n').find((l) => l.startsWith('|') && /in progress/i.test(l));
    return pick(row);
  } catch {
    return '';
  }
}

async function withLock(fn, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const fh = await fsp.open(LOCK, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fsp.stat(LOCK);
        if (Date.now() - st.mtimeMs > 30000) await fsp.rm(LOCK, { force: true }); // stale
      } catch {}
      if (Date.now() - t0 > timeoutMs) throw new Error(`checks.json lock busy (${LOCK})`);
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(LOCK, { force: true });
  }
}

export async function readChecks() {
  try {
    return JSON.parse(await fsp.readFile(CHECKS, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Merge into checks.json. `sections` replaces whole top-level sections (e.g. {goldpath: {...}}).
 * opts.errors = {tool, ...counts} replaces errors.by_tool[tool] and recomputes the totals.
 * opts.captures = [paths] appended (deduped, capped at the latest 100).
 */
export async function updateChecks(sections = {}, opts = {}) {
  return withLock(async () => {
    let cur = await readChecks();
    if (!cur || typeof cur !== 'object') {
      try {
        await fsp.access(CHECKS);
        await fsp.copyFile(CHECKS, `${CHECKS}.corrupt-${Date.now()}.bak`);
      } catch {}
      cur = skeleton();
    }
    const out = { ...skeleton(), ...cur };
    for (const [k, v] of Object.entries(sections)) out[k] = v;
    if (opts.errors) {
      const { tool, ...rest } = opts.errors;
      const by = { ...(out.errors?.by_tool || {}) };
      by[tool] = { utc: utcIso(), ...rest };
      const sum = (f) => Object.values(by).reduce((a, e) => a + (Number(e[f]) || 0), 0);
      out.errors = { console: sum('console'), missing_refs: sum('missing_refs'), by_tool: by };
    }
    if (opts.captures?.length) {
      const seen = new Set();
      out.captures = [...(out.captures || []), ...opts.captures].reverse().filter((p) => (seen.has(p) ? false : seen.add(p))).reverse().slice(-MAX_CAPTURES);
    }
    out.utc = utcIso();
    out.commit = gitCommit();
    out.milestone = milestone(opts.milestone) || out.milestone || '';
    await writeJsonAtomic(CHECKS, out);
    return out;
  });
}
