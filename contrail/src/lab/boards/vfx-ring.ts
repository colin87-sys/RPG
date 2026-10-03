/**
 * vfx-ring board: shock ring key frames (t = 0, .15, .35, .55, .8, 1.0 of its life)
 * over bright Cloudgate and dark Wreckfield, each frame rendered at 1920x1080 through
 * the full PostStack (chroma boosted by the ring envelope), shown downscaled; bottom row:
 * two larger views at t = .55 and a 1:1 crop of the band on bright sky.
 */
import * as THREE from 'three';
import type { LabContext } from '../context';
import { post as postTok, palette, type StageId } from '../../style/tokens';
import { applyStageLook } from '../../gen/common/lighting';
import { PostStack, POST_VARIANTS } from '../../gen/vfx/post';
import { ShockRings, RING_VARIANTS } from '../../gen/vfx/rings';
import { HostileBullets, HOSTILE_VARIANTS } from '../../gen/vfx/projectiles';
import { blitToOverlay, chaseRig, craftPlaceholder, fillOverlay, makeBackdrop, testProps } from '../../gen/vfx/postLabScene';

export default async function board(ctx: LabContext) {
  const v = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as 'A' | 'B' | 'C';
  const ringParams = RING_VARIANTS[v];
  const W = ctx.width, H = ctx.height;
  const post = new PostStack(ctx.renderer, { msaaSamples: 4, params: POST_VARIANTS.A });
  post.setSize(W, H, 1);
  const { camera, vanish } = chaseRig(W / H);
  const rings = new ShockRings(ringParams);
  const bullets = new HostileBullets(HOSTILE_VARIANTS.A, 32);
  const rng = ctx.rng.fork('ring-bullets');
  for (let i = 0; i < 10; i++)
    bullets.setInstance(i, new THREE.Vector3(rng.range(-14, 14), rng.range(0, 10), rng.range(-70, -30)), 0.9, 1);
  bullets.update(0);
  const center = new THREE.Vector3(0, 4.5, -40);
  const duration = 1.0;
  const maxRadius = 29; // ~50% of frame width at 49 m (REF_VERIFICATION: 44-56%)

  const scenes: Record<string, THREE.Scene> = {};
  for (const st of ['cloudgate', 'wreckfield'] as StageId[]) {
    const s = new THREE.Scene();
    s.add(makeBackdrop(st), testProps(), craftPlaceholder());
    scenes[st] = s;
  }
  const renderAt = (stage: StageId, t01: number) => {
    applyStageLook(stage);
    scenes[stage].add(rings.group, bullets.mesh); // shared pools move to the scene being drawn
    rings.clear();
    rings.spawn(center, { maxRadius, duration });
    rings.update(t01 * duration, camera);
    const k = rings.intensity();
    post.render(scenes[stage], camera, {
      time: 3 + t01,
      chroma: postTok.chroma.base + (postTok.chroma.ring - postTok.chroma.base) * k,
      speed01: 0.5,
      vanish,
      flash: 0,
      danger01: 0,
    });
  };

  fillOverlay(ctx.overlay, W, H);
  const ts = [0, 0.15, 0.35, 0.55, 0.8, 1.0];
  const cw = (W - 12 * 7) / 6, ch = Math.round((cw * 9) / 16);
  const rows: [StageId, string][] = [['cloudgate', 'Cloudgate (bright)'], ['wreckfield', 'Wreckfield (dark)']];
  rows.forEach(([st, name], r) => {
    ts.forEach((t, c) => {
      renderAt(st, t);
      const dst = { x: 12 + c * (cw + 12), y: 64 + r * (ch + 12), w: cw, h: ch };
      blitToOverlay(ctx.overlay, ctx.glCanvas, { x: 0, y: 0, w: W, h: H }, dst);
      ctx.label(`${name.split(' ')[0]} t=${t.toFixed(2)}`, dst.x + 4, dst.y + 4);
    });
  });
  const y3 = 64 + 2 * (ch + 12);
  const bw = 736, bh = 414;
  renderAt('cloudgate', 0.55);
  blitToOverlay(ctx.overlay, ctx.glCanvas, { x: 0, y: 0, w: W, h: H }, { x: 12, y: y3, w: bw, h: bh });
  ctx.label('Cloudgate t=0.55 (x0.38)', 16, y3 + 4);
  // 1:1 crop on the ring's right flank (band + RGB order), bright sky
  const p = new THREE.Vector3(maxRadius * 0.93, 0, 0).applyQuaternion(camera.quaternion).add(center).project(camera);
  const cx = Math.round((p.x * 0.5 + 0.5) * W), cy = Math.round((1 - (p.y * 0.5 + 0.5)) * H);
  const cropW = 400, cropH = bh;
  blitToOverlay(ctx.overlay, ctx.glCanvas, { x: cx - cropW / 2, y: cy - cropH / 2, w: cropW, h: cropH }, { x: W - 12 - cropW, y: y3, w: cropW, h: cropH });
  ctx.label('1:1 crop, band on bright sky', W - 8 - cropW, y3 + 4);
  renderAt('wreckfield', 0.55);
  blitToOverlay(ctx.overlay, ctx.glCanvas, { x: 0, y: 0, w: W, h: H }, { x: 24 + bw, y: y3, w: bw, h: bh });
  ctx.label('Wreckfield t=0.55 (x0.38)', 28 + bw, y3 + 4);

  const params = { ring: ringParams, spawn: { center: center.toArray(), maxRadius, duration }, post: 'POST_VARIANTS.A', keyframes: ts };
  ctx.title(`Shock ring ${v}`, `aspect ${ringParams.aspect}, band ${(ringParams.thicknessFrac * 100).toFixed(1)}% x3, spacing ${(ringParams.rgbOffsetFrac * 100).toFixed(1)}% of R, spectral ${ringParams.spectral}`);
  ctx.overlay.fillStyle = palette.hudValue;
  ctx.exportParams(params);
  ctx.ready();
}
