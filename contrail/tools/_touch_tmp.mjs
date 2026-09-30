import { chromium } from 'playwright';
import fs from 'node:fs';
const SP = process.argv[2];
const GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const b = await chromium.launch({ headless: true, args: GL });
const ctx = await b.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await page.goto('http://127.0.0.1:4173/?debug=1&mute=1');
await page.waitForFunction(() => window.__game);
await page.waitForTimeout(1500);
const st = () => page.evaluate(() => window.__game.state());
await page.touchscreen.tap(420, 200); // activate + confirm on title
await page.waitForTimeout(4000);
let s = await st(); console.log('after tap:', s.state, 'touchVisible', await page.evaluate(() => getComputedStyle(document.getElementById('touch')).display));
await page.evaluate(() => window.__game.step(200)); s = await st();
console.log('state', s.state, 'x', s.player?.x);
const cdp = await ctx.newCDPSession(page);
const tp = (x, y, id = 1) => ({ x, y, id });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(150, 250)] });
for (let i = 1; i <= 6; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(150 + i * 10, 250)] }); await page.waitForTimeout(50); }
await page.evaluate(() => window.__game.step(40)); s = await st(); console.log('after stick right x', s.player?.x);
const c = await page.evaluate(() => window.__game.counts()); console.log('cannonFire', c.cannonFire);
// hold MSL then release
const msl = await page.evaluate(() => { const r=[...document.querySelectorAll('#touch div')].find(d=>d.textContent==='MSL').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(160, 250), tp(msl.x, msl.y, 2)] });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(100, 250), tp(msl.x, msl.y, 2)] });
console.log('msl bg', await page.evaluate(() => [...document.querySelectorAll('#touch div')].find(d=>d.textContent==='MSL').style.background));
for (let k=0;k<2;k++){ await page.evaluate(() => window.__game.step(15)); }
console.log('lockAdded', (await page.evaluate(() => window.__game.counts())).lockAdded); s = await st(); console.log('x', s.player?.x);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
console.log('msl bg after', await page.evaluate(() => [...document.querySelectorAll('#touch div')].find(d=>d.textContent==='MSL').style.background));
await page.evaluate(() => window.__game.step(30)); console.log('missileFire', (await page.evaluate(() => window.__game.counts())).missileFire);
fs.writeFileSync(`${SP}/touch_play.png`, await page.screenshot());
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
console.log(JSON.stringify({ errs }));
await b.close();
