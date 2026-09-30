// npm run webpage  (after npm run build)
// Turns dist/ into dist-web/: the game page as a body fragment (the hosting page
// shell supplies doctype/head/body) plus only the script chunks the game loads
// (no Look-Dev Lab). dist-web/ is what gets published as the shareable web build.
import fs from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'dist-web');

const html = fs.readFileSync(join(DIST, 'index.html'), 'utf8');
const title = html.match(/<title>[\s\S]*?<\/title>/)?.[0] ?? '<title>CONTRAIL</title>';
const style = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? '';
const tags = [...html.matchAll(/<(script|link)\b[^>]*(src|href)="\.\/assets\/[^"]+"[^>]*>(<\/script>)?/g)].map((m) => m[0].replace(/\s+crossorigin/g, ''));
const body = html.match(/<body>([\s\S]*?)<\/body>/)?.[1].trim() ?? '<div id="stage"></div>';

// single dark look: explicit background + dark color-scheme on :root
const page = `${title}
<style>:root{color-scheme:dark;background:#071c24}</style>
${style}
${body}
${tags.join('\n')}
`;

// the chunks the game needs: follow static imports from the entry script
const need = new Set();
const visit = (file) => {
  if (need.has(file)) return;
  need.add(file);
  const src = fs.readFileSync(join(DIST, 'assets', file), 'utf8');
  for (const m of src.matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) visit(m[1]);
};
for (const t of tags) {
  const f = t.match(/assets\/([\w.-]+\.js)/)?.[1];
  if (f) visit(f);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(join(OUT, 'assets'), { recursive: true });
fs.writeFileSync(join(OUT, 'index.html'), page);
for (const f of need) fs.copyFileSync(join(DIST, 'assets', f), join(OUT, 'assets', f));
const bytes = [...need].reduce((s, f) => s + fs.statSync(join(DIST, 'assets', f)).size, 0);
console.log(`PASS webpage: dist-web/index.html + ${need.size} chunks (${(bytes / 1024).toFixed(0)} KiB)`);
