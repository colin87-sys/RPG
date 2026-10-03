// Shared helpers for the CONTRAIL harness (GAME_FORGE W5 / Appendix C).
// Pure Node (no dependencies): paths, argv parsing, UTC stamps, atomic writes, hashing, file walks.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root (contrail/), independent of the cwd the tool was started from. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Scratch dir for logs/temp pages (never inside the repo). */
export const TMP = process.env.HARNESS_TMP || os.tmpdir();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Path relative to ROOT with forward slashes (what checks.json stores). */
export const rel = (p) => relative(ROOT, resolve(ROOT, p)).split(sep).join('/');
export const abs = (p) => resolve(ROOT, p);

/** ISO UTC without milliseconds: 2026-09-30T05:12:03Z */
export const utcIso = (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
/** Filename-safe, lexically sortable UTC stamp: 20260930T051203Z */
export const utcStamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
export const UTC_STAMP_RE = /^\d{8}T\d{6}Z/;

/**
 * Tiny argv parser: --key value, --key=value, --flag, --no-flag, positionals in `_`.
 * Keys are camelCased (--keep-server -> keepServer). `booleans` never swallow the next token.
 */
export function parseArgs(argv = process.argv.slice(2), { booleans = [] } = {}) {
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || a === '--') {
      if (a !== '--') out._.push(a);
      continue;
    }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (k.startsWith('no-') && v === undefined) {
      out[camel(k.slice(3))] = false;
      continue;
    }
    if (v === undefined) {
      if (booleans.includes(k) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) v = true;
      else v = argv[++i];
    }
    out[camel(k)] = v;
  }
  return out;
}

export const num = (v, d) => (v === undefined || v === null || v === true || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
export const list = (v, d = []) => (v === undefined || v === true ? d : String(v).split(',').map((s) => s.trim()).filter(Boolean));
export const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'unnamed';

/** Write a file atomically: temp file in the same folder, then rename. */
export async function writeFileAtomic(file, data) {
  const f = abs(file);
  await fsp.mkdir(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, f);
  return f;
}
export const writeJsonAtomic = (file, obj) => writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');

export function sha256File(file) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file).on('error', rej).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex')));
  });
}
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Recursive file list (absolute paths). `skip(absPath, isDir)` prunes. */
export function walkFiles(dir, skip = () => false) {
  const out = [];
  if (!existsSync(dir)) return out;
  const rec = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (!skip(p, true)) rec(p);
      } else if (ent.isFile() && !skip(p, false)) out.push(p);
    }
  };
  if (statSync(dir).isDirectory()) rec(dir);
  return out;
}

export function median(a) {
  return percentile(a, 50);
}
/** Linear-interpolated percentile (p in 0..100). */
export function percentile(a, p) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = ((s.length - 1) * p) / 100;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export const round = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? x : Math.round(x * 10 ** d) / 10 ** d);

/** Final one-line verdict every tool prints (acceptance parses it). */
export function verdict(tool, ok, msg) {
  const line = `${ok ? 'PASS' : 'FAIL'} ${tool}: ${msg}`;
  (ok ? console.log : console.error)(line);
  return line;
}

/** Run main(), print a FAIL line on crash, set the exit code, always run cleanup. */
export async function runTool(tool, main) {
  try {
    const code = await main();
    process.exitCode = typeof code === 'number' ? code : 0;
  } catch (e) {
    verdict(tool, false, e && e.message ? e.message : String(e));
    if (process.env.HARNESS_DEBUG) console.error(e);
    process.exitCode = e && typeof e.exitCode === 'number' ? e.exitCode : 1;
  } finally {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch {}
    }
  }
}
const cleanups = [];
export const onCleanup = (fn) => cleanups.push(fn);

export class ToolError extends Error {
  constructor(msg, exitCode = 1) {
    super(msg);
    this.exitCode = exitCode;
  }
}
