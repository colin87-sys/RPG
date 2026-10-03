/**
 * VFX strip: explosion key frames (t = 0.03, 0.1, 0.2, 0.3, 0.5, 0.9 s) of a 'big' explosion
 * over Wreckfield (row 1) and Cloudgate (row 2); row 3: 'small' (+ hit pops) and 'boss' on both.
 * Rendered through PostStack (VFX lane A, variant A) so HDR fire drives bloom; each cell is
 * rendered at its own size into the canvas corner and blitted into the board overlay.
 */
import * as THREE from 'three';
import type { LabContext, Rect } from '../context';
import { palette, post as postTok, type StageId } from '../../style/tokens';
import { applyStageLook } from '../../gen/common/lighting';
import { Explosions, EXPLOSION_VARIANTS, type ExplosionKind } from '../../gen/vfx/explosions';
import { HitPops } from '../../gen/vfx/particles-hit';
import { LabBackdrop } from '../../gen/vfx/particles-backdrop';
import { PostStack, POST_VARIANTS } from '../../gen/vfx/post';
import { buildSkyVista, CLOUDGATE_VARIANTS } from '../../gen/world/sky';

const FRAMES = [0.03, 0.1, 0.2, 0.3, 0.5, 0.9];
const STEP = 1 / 240;

export default async function board(ctx: LabContext) {
  const v = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as 'A' | 'B' | 'C';
  const params = EXPLOSION_VARIANTS[v];
  const post = new PostStack(ctx.renderer, { msaaSamples: 4, params: POST_VARIANTS.A });
  const space = new LabBackdrop('wreckfield');
  const vista = buildSkyVista(CLOUDGATE_VARIANTS.C, 1);
  const backdrops: Record<string, { group: THREE.Object3D; prepare: () => void }> = {
    wreckfield: { group: space.group, prepare: () => space.prepare(cam) },
    cloudgate: { group: vista.group, prepare: () => vista.update(cam.position, 0) },
  };
  const scene = new THREE.Scene();
  for (const k of Object.keys(backdrops)) scene.add(backdrops[k].group);
  const cam = new THREE.PerspectiveCamera(50, 1, 0.3, 20000);
  const vanish = new THREE.Vector2(0, 0);

  const renderCell = (stage: StageId, rect: Rect, label: string) => {
    applyStageLook(stage);
    for (const k of Object.keys(backdrops)) backdrops[k].group.visible = k === stage;
    cam.aspect = rect.w / rect.h;
    cam.updateProjectionMatrix();
    backdrops[stage].prepare();
    post.setSize(Math.round(rect.w), Math.round(rect.h), 1);
    post.render(scene, cam, { time: 1, chroma: postTok.chroma.base, speed01: 0, vanish, flash: 0, danger01: 0 });
    const w = Math.round(rect.w), h = Math.round(rect.h);
    ctx.overlay.drawImage(ctx.glCanvas, 0, ctx.height - h, w, h, rect.x, rect.y, w, h);
    ctx.label(label, rect.x + 5, rect.y + 5);
  };

  /** Run one explosion from t=0 and render cells at the requested times. */
  const sequence = (kind: ExplosionKind, size: number, dist: number, times: number[], draw: (t: number) => void, pops = false) => {
    const ex = new Explosions(8, params);
    scene.add(ex.group);
    const hp = new HitPops(16);
    scene.add(hp.group);
    cam.position.set(0, dist * 0.18, dist);
    cam.lookAt(0, size * 0.3, 0);
    cam.updateMatrixWorld();
    ex.spawn(new THREE.Vector3(0, 0, 0), { size, kind, seed: 1234 });
    let t = 0;
    let popped = false;
    for (const target of times) {
      while (t < target - 1e-6) {
        t += STEP;
        if (pops && !popped && t >= target - 0.05) {
          popped = true;
          hp.spawn(new THREE.Vector3(-size * 3.2, size * 1.2, 0));
          hp.spawn(new THREE.Vector3(size * 3.4, -size * 0.6, 0), { scale: 1.5 });
          hp.spawn(new THREE.Vector3(size * 1.5, size * 3.0, 0), { scale: 0.8 });
        }
        ex.update(STEP, cam);
        hp.update(STEP, cam);
      }
      draw(t);
    }
    scene.remove(ex.group);
    scene.remove(hp.group);
    ex.dispose();
    hp.dispose();
  };

  ctx.clearAll(palette.spaceDeep);
  const m = 10, top = 60;
  const cw = (ctx.width - m * 7) / 6, ch = 300;
  const cell = (r: number, c: number): Rect => ({ x: m + c * (cw + m), y: top + r * (ch + m), w: cw, h: ch });
  const bigSize = 3.5, bigDist = 36;
  let f = 0;
  sequence('big', bigSize, bigDist, FRAMES, (t) => {
    renderCell('wreckfield', cell(0, f), `big t=${t.toFixed(2)}s dark`);
    renderCell('cloudgate', cell(1, f), `big t=${t.toFixed(2)}s bright`);
    f++;
  });
  const y3 = top + 2 * (ch + m);
  const w3 = (ctx.width - m * 5) / 4, h3 = ctx.height - y3 - m;
  const cell3 = (c: number): Rect => ({ x: m + c * (w3 + m), y: y3, w: w3, h: h3 });
  sequence('small', 1.0, 12, [0.2], (t) => {
    renderCell('wreckfield', cell3(0), `small (1 m) t=${t.toFixed(2)}s + hit pops`);
    renderCell('cloudgate', cell3(1), `small (1 m) t=${t.toFixed(2)}s + hit pops`);
  }, true);
  sequence('boss', 9, 95, [0.4], (t) => {
    renderCell('wreckfield', cell3(2), `boss (9 m) t=${t.toFixed(2)}s`);
    renderCell('cloudgate', cell3(3), `boss (9 m) t=${t.toFixed(2)}s`);
  });
  ctx.clearAll(palette.spaceDeep);
  ctx.title('VFX strip: explosion', `variant ${params.name}; big 3.5 m @ ${bigDist} m; PostStack A (bloom)`);
  ctx.exportParams({ board: 'vfx-explosion', variant: v, params, frames: FRAMES, step: STEP, post: 'POST_VARIANTS.A', backdrop: { dark: 'LabBackdrop wreckfield', bright: 'buildSkyVista(CLOUDGATE_VARIANTS.C, 1)' }, big: { size: bigSize, dist: bigDist }, small: { size: 1, dist: 12, t: 0.2 }, boss: { size: 9, dist: 95, t: 0.4 }, seed: 1234 });
  ctx.ready();
}
