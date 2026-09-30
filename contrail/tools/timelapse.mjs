// npm run timelapse [-- --dir Docs/progress --out Docs/timelapse.webm --fps 4 --w 1280 --h 720 --match hero]
// Collects <UTC>_*.png under --dir (recursive) in UTC name order, renders each to a captioned JPEG in
// Chromium (canvas), pipes the JPEGs to Playwright's ffmpeg (image2pipe/mjpeg -> libvpx VP8 WebM),
// and always writes Docs/timelapse.html: a self-contained slideshow with relative image paths (fallback).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { launchBrowser, newPage } from './lib/browser.mjs';
import { escapeHtml, toolTheme } from './lib/theme.mjs';
import { ROOT, ToolError, UTC_STAMP_RE, abs, num, onCleanup, parseArgs, rel, runTool, utcIso, verdict, walkFiles, writeFileAtomic } from './lib/util.mjs';
import fsp from 'node:fs/promises';

const TOOL = 'timelapse';
const args = parseArgs();

function ffmpegPath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(base)) return null;
  const d = readdirSync(base).filter((n) => n.startsWith('ffmpeg')).sort().pop();
  const p = d && join(base, d, 'ffmpeg-linux');
  return p && existsSync(p) ? p : null;
}

runTool(TOOL, async () => {
  const dir = abs(args.dir && args.dir !== true ? args.dir : 'Docs/progress');
  const out = abs(args.out && args.out !== true ? args.out : 'Docs/timelapse.webm');
  const html = abs(args.html && args.html !== true ? args.html : 'Docs/timelapse.html');
  const fps = num(args.fps, 4), W = num(args.w, 1280), H = num(args.h, 720);
  const match = args.match && args.match !== true ? String(args.match) : '';
  const frames = walkFiles(dir)
    .filter((f) => f.endsWith('.png') && UTC_STAMP_RE.test(basename(f)) && (!match || basename(f).includes(match)))
    .sort((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b));
  if (!frames.length) throw new ToolError(`no <UTC>_*.png frames under ${rel(dir)}${match ? ` matching '${match}'` : ''}`);
  const th = await toolTheme();

  // Fallback slideshow (always written).
  const items = frames.map((f) => ({ src: relative(dirname(html), f).split(sep).join('/'), cap: rel(f) }));
  const page = `<!doctype html><meta charset="utf-8"><title>CONTRAIL timelapse</title><style>
body{margin:0;background:${th.bg};color:${th.text};font:14px ui-monospace,Menlo,Consolas,monospace;display:flex;flex-direction:column;height:100vh}
#v{flex:1;min-height:0;display:flex;align-items:center;justify-content:center}#v img{max-width:100%;max-height:100%}
nav{display:flex;gap:12px;align-items:center;padding:10px 16px;border-top:2px solid ${th.line}}
button{background:${th.panel};color:${th.value};border:1px solid ${th.line};font:inherit;padding:4px 10px}input[type=range]{flex:1}#c{color:${th.value}}
</style><div id="v"><img id="i" alt=""></div><nav><button id="p">pause</button><input id="r" type="range" min="0" value="0"><span id="n"></span><span id="c"></span></nav>
<script>const F=${JSON.stringify(items)};let k=0,on=true;const i=document.getElementById('i'),r=document.getElementById('r'),n=document.getElementById('n'),c=document.getElementById('c');r.max=F.length-1;
function show(j){k=(j+F.length)%F.length;i.src=F[k].src;r.value=k;n.textContent=(k+1)+'/'+F.length;c.textContent=F[k].cap}
document.getElementById('p').onclick=e=>{on=!on;e.target.textContent=on?'pause':'play'};r.oninput=()=>show(+r.value);
addEventListener('keydown',e=>{if(e.key==='ArrowRight')show(k+1);if(e.key==='ArrowLeft')show(k-1);if(e.key===' ')document.getElementById('p').click()});
setInterval(()=>{if(on)show(k+1)},${Math.round(1000 / fps)});show(0);</script>`;
  await writeFileAtomic(html, page);
  console.log(`slideshow: ${rel(html)} (${frames.length} frames)`);

  const ff = ffmpegPath();
  if (!ff) {
    verdict(TOOL, true, `ffmpeg not found; wrote the HTML slideshow only (${rel(html)})`);
    return 0;
  }
  const browser = await launchBrowser();
  onCleanup(() => browser.close());
  const { page: p } = await newPage(browser, { w: 320, h: 200 });
  const tmp = `${out}.${process.pid}.tmp.webm`;
  const proc = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libvpx', '-b:v', '2M', '-r', String(fps), '-pix_fmt', 'yuv420p', '-f', 'webm', tmp], { stdio: ['pipe', 'inherit', 'pipe'] });
  onCleanup(() => proc.exitCode === null && proc.kill('SIGKILL'));
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((res) => proc.on('close', res));
  for (const f of frames) {
    const b64 = await p.evaluate(
      async ({ url, cap, W, H, bg, text }) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const g = c.getContext('2d');
        g.fillStyle = bg;
        g.fillRect(0, 0, W, H);
        const s = Math.min(W / img.naturalWidth, (H - 28) / img.naturalHeight);
        const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
        g.drawImage(img, (W - dw) / 2, (H - 28 - dh) / 2, dw, dh);
        g.fillStyle = text;
        g.font = '16px ui-monospace, Menlo, monospace';
        g.textBaseline = 'middle';
        g.fillText(cap, 10, H - 14);
        return c.toDataURL('image/jpeg', 0.9).split(',')[1];
      },
      { url: `data:image/png;base64,${(await fsp.readFile(f)).toString('base64')}`, cap: rel(f), W, H, bg: th.bg, text: th.value },
    );
    if (!proc.stdin.write(Buffer.from(b64, 'base64'))) await new Promise((r) => proc.stdin.once('drain', r));
  }
  proc.stdin.end();
  const code = await done;
  if (code !== 0) {
    await fsp.rm(tmp, { force: true });
    verdict(TOOL, false, `ffmpeg exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')} (slideshow fallback written: ${rel(html)})`);
    return 1;
  }
  await fsp.rename(tmp, out);
  verdict(TOOL, true, `${rel(out)} (${frames.length} frames @ ${fps} fps, ${Math.round(statSync(out).size / 1024)} KB) + ${rel(html)} [${utcIso()}]`);
  return 0;
});
