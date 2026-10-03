/**
 * vfx-bullets board: readability at peak density. 80 hostile bullets + 60 player shots
 * scattered at 20-150 m over Cloudgate, Violet Tide and Wreckfield, chase camera FOV 68,
 * full PostStack at 1920x1080. Top: whole frames (x0.325). Bottom: 1:1 crops around a
 * cluster placed on the horizon (the worst case: cream cloud bank / hot sunset band).
 * Each frame is measured: median CIE76 deltaE of hostile discs vs a local background
 * annulus (a rough stand-in for the harness ID-mask metric, target >= 25).
 */
import * as THREE from 'three';
import type { LabContext } from '../context';
import { palette, post as postTok, type StageId, stages } from '../../style/tokens';
import { withAlpha } from '../../style/color';
import { applyStageLook } from '../../gen/common/lighting';
import { PostStack, POST_VARIANTS } from '../../gen/vfx/post';
import { HostileBullets, HOSTILE_VARIANTS, PlayerShots, PLAYER_SHOT_VARIANTS } from '../../gen/vfx/projectiles';
import { blitToOverlay, chaseRig, craftPlaceholder, fillOverlay, makeBackdrop, testProps } from '../../gen/vfx/postLabScene';

function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const R = lin(r / 255), G = lin(g / 255), B = lin(b / 255);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

export default async function board(ctx: LabContext) {
  const v = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as 'A' | 'B' | 'C';
  const hp = HOSTILE_VARIANTS[v];
  const W = ctx.width, H = ctx.height;
  const post = new PostStack(ctx.renderer, { msaaSamples: 4, params: POST_VARIANTS[v] });
  post.setSize(W, H, 1);
  const { camera, vanish } = chaseRig(W / H);
  const hostile = new HostileBullets(hp, 256);
  const shots = new PlayerShots(PLAYER_SHOT_VARIANTS[v], 256);
  const rng = ctx.rng.fork('bullets-density');
  const tanY = Math.tan(THREE.MathUtils.degToRad(34));
  const tanX = tanY * (W / H);
  const tmp = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const inView = (ndcX: number, ndcY: number, d: number) => {
    // point at distance d along the camera view through NDC (ndcX, ndcY)
    tmp.set(ndcX * tanX * d, ndcY * tanY * d, -d).applyQuaternion(camera.quaternion).add(camera.position);
    return tmp;
  };
  let hi = 0;
  // worst-case cluster on the horizon band (left of centre) for the 1:1 crop
  const clusterNdc = new THREE.Vector2(-0.42, 0.06);
  for (let i = 0; i < 12; i++) {
    const d = rng.range(35, 90);
    hostile.setInstance(hi++, inView(clusterNdc.x + rng.range(-0.14, 0.14), clusterNdc.y + rng.range(-0.18, 0.18), d), hp.radius, 1);
  }
  while (hi < 80) {
    const d = rng.range(20, 150);
    hostile.setInstance(hi++, inView(rng.range(-0.92, 0.92), rng.range(-0.8, 0.85), d), hp.radius, 1);
  }
  for (let i = 0; i < 60; i++) {
    const cl = i < 10;
    const d = cl ? rng.range(35, 80) : rng.range(20, 150);
    const nx = cl ? clusterNdc.x + rng.range(-0.15, 0.15) : rng.range(-0.7, 0.7);
    const ny = cl ? clusterNdc.y + rng.range(-0.18, 0.18) : rng.range(-0.6, 0.6);
    const p = inView(nx, ny, d).clone();
    dir.set(rng.range(-0.04, 0.04), rng.range(-0.02, 0.03), -1).normalize();
    shots.setInstance(i, p, dir);
  }
  hostile.update(0);
  shots.update(0);

  const ids: StageId[] = ['cloudgate', 'violetTide', 'wreckfield'];
  const scenes = ids.map((st) => {
    const s = new THREE.Scene();
    s.add(makeBackdrop(st), testProps(), craftPlaceholder());
    return s;
  });

  fillOverlay(ctx.overlay, W, H);
  const cw = (W - 48) / 3, ch = Math.round((cw * 9) / 16);
  const cropY = 64 + ch + 12, cropH = H - cropY - 12;
  const scratch = document.createElement('canvas');
  scratch.width = W;
  scratch.height = H;
  const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
  const f = camera.projectionMatrix.elements[5] * 0.5 * H;
  const bodyMinPx = (hp.minFrameHeightFrac / (hp.coreFrac * (1 - hp.outlineFrac))) * H * 0.5;
  const results: Record<string, { medianDeltaE: number; minDeltaE: number; p10DeltaE: number; measured: number }> = {};
  const cpx = Math.round((clusterNdc.x * 0.5 + 0.5) * W), cpy = Math.round((1 - (clusterNdc.y * 0.5 + 0.5)) * H);
  const pv = new THREE.Vector3();

  ids.forEach((st, i) => {
    applyStageLook(st);
    scenes[i].add(hostile.mesh, shots.mesh);
    post.render(scenes[i], camera, { time: 5, chroma: postTok.chroma.base, speed01: 0.6, vanish, flash: 0, danger01: 0 });
    // measure
    sctx.drawImage(ctx.glCanvas, 0, 0);
    const img = sctx.getImageData(0, 0, W, H).data;
    const des: number[] = [];
    for (let k = 0; k < 80; k++) {
      hostile.getPosition(k, pv);
      const w = pv.clone().applyMatrix4(camera.matrixWorldInverse).z * -1;
      pv.project(camera);
      const x = (pv.x * 0.5 + 0.5) * W, y = (1 - (pv.y * 0.5 + 0.5)) * H;
      const r = Math.max((hp.radius * f) / w, bodyMinPx);
      if (x < 4 * r || y < 4 * r || x > W - 4 * r || y > H - 4 * r) continue;
      let a = [0, 0, 0], na = 0, b = [0, 0, 0], nb = 0;
      const R2 = Math.ceil(r * 3.4);
      for (let yy = -R2; yy <= R2; yy += 1) {
        for (let xx = -R2; xx <= R2; xx += 1) {
          const dd = Math.hypot(xx, yy) / r;
          const inDisc = dd < 0.85;
          const inRing = dd > 2.4 && dd < 3.4;
          if (!inDisc && !inRing) continue;
          const o = ((Math.round(y) + yy) * W + Math.round(x) + xx) * 4;
          if (inDisc) { a[0] += img[o]; a[1] += img[o + 1]; a[2] += img[o + 2]; na++; }
          else { b[0] += img[o]; b[1] += img[o + 1]; b[2] += img[o + 2]; nb++; }
        }
      }
      const la = srgbToLab(a[0] / na, a[1] / na, a[2] / na);
      const lb = srgbToLab(b[0] / nb, b[1] / nb, b[2] / nb);
      des.push(Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]));
    }
    des.sort((p, q) => p - q);
    const med = des.length ? des[Math.floor(des.length / 2)] : 0;
    results[st] = { medianDeltaE: +med.toFixed(1), minDeltaE: +(des[0] ?? 0).toFixed(1), p10DeltaE: +(des[Math.floor(des.length * 0.1)] ?? 0).toFixed(1), measured: des.length };
    const dst = { x: 12 + i * (cw + 12), y: 64, w: cw, h: ch };
    blitToOverlay(ctx.overlay, ctx.glCanvas, { x: 0, y: 0, w: W, h: H }, dst);
    ctx.label(`${stages[st].name}  dE med ${med.toFixed(0)} / p10 ${results[st].p10DeltaE.toFixed(0)} (n=${des.length})`, dst.x + 4, dst.y + 4);
    const crop = { x: cpx - cw / 2, y: cpy - cropH / 2, w: cw, h: cropH };
    blitToOverlay(ctx.overlay, ctx.glCanvas, crop, { x: dst.x, y: cropY, w: cw, h: cropH });
    ctx.label(`1:1 crop, horizon cluster`, dst.x + 4, cropY + 4);
    // crop outline on the overview
    const g = ctx.overlay;
    g.save();
    g.strokeStyle = withAlpha(palette.hudValue, 0.6);
    g.lineWidth = 1;
    const sc = cw / W;
    g.strokeRect(dst.x + crop.x * sc, dst.y + crop.y * sc, crop.w * sc, crop.h * sc);
    g.restore();
  });
  const params = { hostile: hp, playerShot: PLAYER_SHOT_VARIANTS[v], post: `POST_VARIANTS.${v}`, counts: { hostile: 80, player: 60 }, distanceM: [20, 150], deltaE: results };
  ctx.title(`Bullet readability ${v}`, `80 hostile + 60 player, 20-150 m, FOV 68, full post. core floor ${(hp.minFrameHeightFrac * 100).toFixed(1)}% H`);
  ctx.exportParams(params);
  ctx.ready();
}
