#!/usr/bin/env node
/**
 * Fast, parallel-safe integrity check.
 *
 * Bundles the whole module graph with esbuild to a throwaway path. Catches
 * syntax errors, bad imports, and missing exports in about a second — and
 * unlike `vite build` it can be run by many agents at once without them
 * fighting over `dist/`.
 *
 *   node tools/check.mjs            # check everything
 */
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `aw-check-${process.pid}.js`);

try {
  const result = await build({
    entryPoints: ['src/main.js'],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outfile: out,
    logLevel: 'silent',
    write: false,
    loader: { '.css': 'text' },
  });
  if (result.warnings.length) {
    for (const w of result.warnings) {
      console.warn(`warn: ${w.text} (${w.location?.file}:${w.location?.line})`);
    }
  }
  console.log('OK — module graph resolves cleanly.');
} catch (err) {
  for (const e of err.errors ?? [{ text: err.message }]) {
    console.error(`ERROR: ${e.text}`);
    if (e.location) console.error(`   at ${e.location.file}:${e.location.line}:${e.location.column}`);
  }
  process.exit(1);
}
