// npm run contact -- <dir> [--out path] [--cols n] [--title text] [--width 1920]
// Contact sheet: an HTML grid of the images in <dir> (file:// URLs) with filenames and sizes,
// rendered in Chromium and screenshotted (full page) to <dir>/contact.png or --out.
import { readdirSync, statSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser, newPage } from './lib/browser.mjs';
import { escapeHtml, toolTheme } from './lib/theme.mjs';
import { TMP, ToolError, abs, num, onCleanup, parseArgs, rel, runTool, utcIso, verdict, writeFileAtomic } from './lib/util.mjs';

const TOOL = 'contact';
const args = parseArgs();
const IMG = new Set(['.png', '.jpg', '.jpeg', '.webp']);

runTool(TOOL, async () => {
  const dir = args._[0];
  if (!dir) throw new ToolError('usage: npm run contact -- <dir> [--out path] [--cols n] [--title text]');
  const d = abs(dir);
  if (!statSync(d, { throwIfNoEntry: false })?.isDirectory()) throw new ToolError(`not a directory: ${dir}`);
  const out = args.out && args.out !== true ? abs(args.out) : join(d, 'contact.png');
  const files = readdirSync(d)
    .filter((f) => IMG.has(extname(f).toLowerCase()) && !/^contact/i.test(f) && resolve(d, f) !== out)
    .sort();
  if (!files.length) throw new ToolError(`no images in ${dir}`);
  const cols = Math.max(1, num(args.cols, Math.min(4, Math.ceil(Math.sqrt(files.length)))));
  const width = num(args.width, 1920);
  const title = args.title && args.title !== true ? String(args.title) : `${rel(d)} — ${files.length} image(s)`;
  const th = await toolTheme();

  const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:${th.bg};color:${th.text};font:14px ui-monospace,Menlo,Consolas,monospace}
header{display:flex;justify-content:space-between;align-items:baseline;padding:16px 20px 12px;border-bottom:2px solid ${th.line};margin-bottom:14px}
header b{font-size:22px} header span{color:${th.value}}
.grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px;padding:0 20px 20px}
figure{margin:0;background:${th.panel};border:1px solid ${th.dim}}
img{display:block;width:100%;height:auto}
figcaption{padding:6px 8px;color:${th.value};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
figcaption i{color:${th.text};font-style:normal;float:right;padding-left:8px}
</style><header><b>${escapeHtml(title)}</b><span>${utcIso()}</span></header><div class="grid">${files
    .map((f) => `<figure><img src="${pathToFileURL(join(d, f)).href}"><figcaption><i></i>${escapeHtml(f)}</figcaption></figure>`)
    .join('')}</div><script>for(const f of document.querySelectorAll('figure')){const i=f.querySelector('img');const s=()=>f.querySelector('i').textContent=i.naturalWidth?i.naturalWidth+'x'+i.naturalHeight:'MISSING';i.complete?s():(i.onload=s,i.onerror=s)}</script>`;
  const htmlFile = join(TMP, `contrail-contact-${process.pid}.html`);
  await fsp.writeFile(htmlFile, html);
  onCleanup(() => fsp.rm(htmlFile, { force: true }));

  const browser = await launchBrowser();
  onCleanup(() => browser.close());
  const { page } = await newPage(browser, { w: width, h: 1080 });
  await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 60000 });
  const broken = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).length);
  const png = await page.screenshot({ type: 'png', fullPage: true });
  await writeFileAtomic(out, png);
  if (broken) {
    verdict(TOOL, false, `${rel(out)} written but ${broken} image(s) failed to load`);
    return 1;
  }
  verdict(TOOL, true, `${rel(out)} (${files.length} images, ${cols} cols) from ${basename(d)}/`);
  return 0;
});
