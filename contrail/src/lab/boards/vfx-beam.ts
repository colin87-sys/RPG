/**
 * vfx-beam board: telegraph -> fire -> fade (5 frames) for the enemy laser and the boss
 * beam over bright Cloudgate sky and dark Wreckfield space. Every frame is a 1920x1080
 * render through the full PostStack; cells show a x0.5 crop around the beam. Bottom
 * strip: 1:1 crops of the laser telegraph and the laser fire cross-section on bright sky.
 */
import * as THREE from 'three';
import type { LabContext } from '../context';
import { post as postTok, type StageId } from '../../style/tokens';
import { applyStageLook } from '../../gen/common/lighting';
import { PostStack, POST_VARIANTS } from '../../gen/vfx/post';
import { Beams, BEAM_VARIANTS, type BeamKind } from '../../gen/vfx/beams';
import { blitToOverlay, chaseRig, craftPlaceholder, fillOverlay, makeBackdrop, testProps } from '../../gen/vfx/postLabScene';

type Frame = { name: string; apply: (b: Beams, id: string) => void };

export default async function board(ctx: LabContext) {
  const v = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as 'A' | 'B' | 'C';
  const bp = BEAM_VARIANTS[v];
  const W = ctx.width, H = ctx.height;
  const post = new PostStack(ctx.renderer, { msaaSamples: 4, params: POST_VARIANTS.A });
  post.setSize(W, H, 1);
  const { camera, vanish } = chaseRig(W / H);
  const beams = new Beams(bp);
  const ends: Record<BeamKind, [THREE.Vector3, THREE.Vector3]> = {
    laser: [new THREE.Vector3(-38, 16, -120), new THREE.Vector3(7, -1, -12)],
    boss: [new THREE.Vector3(26, 48, -170), new THREE.Vector3(-5, -8, -22)],
  };
  const scenes: Record<string, THREE.Scene> = {};
  for (const st of ['cloudgate', 'wreckfield'] as StageId[]) {
    const s = new THREE.Scene();
    s.add(makeBackdrop(st), testProps(), craftPlaceholder());
    scenes[st] = s;
  }
  const frames: Frame[] = [
    { name: 'telegraph t=.20', apply: (b, id) => { b.setState(id, 'telegraph', 0.2); b.update(0.14); } },
    { name: 'telegraph t=.85', apply: (b, id) => { b.setState(id, 'telegraph', 0.85); b.update(0.6); } },
    { name: 'fire +0.04 s (flash)', apply: (b, id) => { b.setState(id, 'telegraph', 1); b.update(0.7); b.setState(id, 'fire', 0.1); b.update(0.04); } },
    { name: 'fire t=.50', apply: (b, id) => { b.setState(id, 'fire', 0.5); b.update(0.3); } },
    { name: 'fade +0.07 s', apply: (b, id) => { b.setState(id, 'fire', 1); b.update(0.4); b.setState(id, 'off', 0); b.update(0.07); } },
  ];
  const render = (st: StageId, kind: BeamKind, f: Frame) => {
    applyStageLook(st);
    scenes[st].add(beams.group);
    beams.clear();
    beams.add('b', ends[kind][0], ends[kind][1], kind);
    beams.setState('b', 'off', 0);
    beams.update(1);
    f.apply(beams, 'b');
    post.render(scenes[st], camera, { time: 2, chroma: postTok.chroma.base, speed01: 0.4, vanish, flash: 0, danger01: 0 });
  };
  const cropFor = (kind: BeamKind, cw: number, ch: number, t = 0.4) => {
    const a = ends[kind][0].clone().project(camera), b = ends[kind][1].clone().project(camera);
    const x = ((a.x + (b.x - a.x) * t) * 0.5 + 0.5) * W, y = (1 - ((a.y + (b.y - a.y) * t) * 0.5 + 0.5)) * H;
    return { x: Math.min(W - cw, Math.max(0, x - cw / 2)), y: Math.min(H - ch, Math.max(0, y - ch / 2)), w: cw, h: ch };
  };

  fillOverlay(ctx.overlay, W, H);
  const cw = (W - 12 * 6) / 5, ch = Math.round((cw * 9) / 16);
  const rows: [StageId, BeamKind, string][] = [
    ['cloudgate', 'laser', 'laser / sky'],
    ['wreckfield', 'laser', 'laser / space'],
    ['cloudgate', 'boss', 'boss / sky'],
    ['wreckfield', 'boss', 'boss / space'],
  ];
  rows.forEach(([st, kind, name], r) => {
    frames.forEach((f, c) => {
      render(st, kind, f);
      const dst = { x: 12 + c * (cw + 12), y: 64 + r * (ch + 12), w: cw, h: ch };
      blitToOverlay(ctx.overlay, ctx.glCanvas, cropFor(kind, cw * 2, ch * 2), dst);
      ctx.label(`${name}: ${f.name}`, dst.x + 4, dst.y + 4);
    });
  });
  const sy = 64 + 4 * (ch + 12);
  const sh = H - sy - 12, sw = (W - 36) / 2;
  render('cloudgate', 'laser', frames[1]);
  blitToOverlay(ctx.overlay, ctx.glCanvas, cropFor('laser', sw, sh, 0.55), { x: 12, y: sy, w: sw, h: sh });
  ctx.label('1:1 laser telegraph on sky', 16, sy + 4);
  render('cloudgate', 'laser', frames[3]);
  blitToOverlay(ctx.overlay, ctx.glCanvas, cropFor('laser', sw, sh, 0.55), { x: 24 + sw, y: sy, w: sw, h: sh });
  ctx.label('1:1 laser fire on sky (W-Y-R cross-section)', 28 + sw, sy + 4);

  ctx.title(`Beams ${v}`, `width ${bp.width} m (boss x${bp.bossScale}), core ${Math.round(bp.coreFrac * 100)}%, telegraph ${bp.telegraphWidth} m + dark outline ${bp.telegraphOutlinePx}px; cells are x0.5 crops`);
  ctx.exportParams({ beam: bp, ends: { laser: ends.laser.map((p) => p.toArray()), boss: ends.boss.map((p) => p.toArray()) }, frames: frames.map((f) => f.name), post: 'POST_VARIANTS.A' });
  ctx.ready();
}
