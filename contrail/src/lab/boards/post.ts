/**
 * post board: the same test frame (Cloudgate rig: lit props, dark hull mass, dark craft
 * placeholder, bright effect sprites, hostile bullets, a beam) through the PostStack with
 * effects switched on cumulatively: clean, +bloom, +chroma, +scanlines/grain,
 * +vignette/grade, full stack (+speed streaks, analogue softness). Each cell is a
 * 1920x1080 render shown at x0.325; the bottom row shows 1:1 crops.
 */
import * as THREE from 'three';
import type { LabContext } from '../context';
import { palette, post as postTok } from '../../style/tokens';
import { applyStageLook } from '../../gen/common/lighting';
import { PostStack, POST_VARIANTS, type PostToggles } from '../../gen/vfx/post';
import { HostileBullets, HOSTILE_VARIANTS, PlayerShots, PLAYER_SHOT_VARIANTS } from '../../gen/vfx/projectiles';
import { Beams, BEAM_VARIANTS } from '../../gen/vfx/beams';
import { blitToOverlay, chaseRig, craftPlaceholder, fillOverlay, glowSprite, makeBackdrop, testProps } from '../../gen/vfx/postLabScene';

export default async function board(ctx: LabContext) {
  const v = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as 'A' | 'B' | 'C';
  const params = POST_VARIANTS[v];
  const W = ctx.width, H = ctx.height;
  const post = new PostStack(ctx.renderer, { msaaSamples: 4, params });
  post.setSize(W, H, 1);
  const { camera, vanish } = chaseRig(W / H);
  applyStageLook('cloudgate');
  const scene = new THREE.Scene();
  scene.add(makeBackdrop('cloudgate'), testProps(), craftPlaceholder());
  // bright effect sprites (explosion-like cluster + a distant flash)
  const sprites: [string, number, number, number, number, number][] = [
    [palette.burstYellow, 3.0, 4.5, -30, 14, -60],
    [palette.fireOrange, 2.2, 3.2, -26, 11, -57],
    [palette.fireOrange, 2.0, 2.6, -33, 17, -63],
    [palette.burstYellow, 4.0, 1.6, 24, 22, -95],
  ];
  for (const [c, i, s, x, y, z] of sprites) {
    const g = glowSprite(c, i, s);
    g.position.set(x, y, z);
    scene.add(g);
  }
  const hostile = new HostileBullets(HOSTILE_VARIANTS.A, 32);
  const rng = ctx.rng.fork('post-bullets');
  for (let i = 0; i < 14; i++) hostile.setInstance(i, new THREE.Vector3(rng.range(-18, 10), rng.range(-1, 10), rng.range(-80, -25)), 0.9, 1);
  hostile.update(0);
  const shots = new PlayerShots(PLAYER_SHOT_VARIANTS.A, 32);
  const d = new THREE.Vector3(0, 0.02, -1).normalize();
  for (let i = 0; i < 10; i++) shots.setInstance(i, new THREE.Vector3((i % 2 ? 1.4 : -1.4) + rng.range(-0.5, 0.5), 0.6 + rng.range(-0.3, 0.3), -14 - i * 6), d);
  shots.update(0);
  const beams = new Beams(BEAM_VARIANTS.A);
  beams.add('l', new THREE.Vector3(-45, 20, -140), new THREE.Vector3(-3, -3, -8), 'laser');
  beams.setState('l', 'fire', 0.5);
  beams.update(0.3);
  scene.add(hostile.mesh, shots.mesh, beams.group);

  const off: PostToggles = { bloom: false, chroma: false, softness: false, scanlines: false, grain: false, vignette: false, grade: false, streaks: false };
  const steps: { name: string; t: PostToggles; clean?: boolean }[] = [
    { name: 'clean (tone map only)', t: { ...off }, clean: true },
    { name: '+bloom', t: { ...off, bloom: true } },
    { name: '+chroma', t: { ...off, bloom: true, chroma: true } },
    { name: '+scanlines/grain', t: { ...off, bloom: true, chroma: true, scanlines: true, grain: true } },
    { name: '+vignette/grade', t: { ...off, bloom: true, chroma: true, scanlines: true, grain: true, vignette: true, grade: true } },
    { name: 'full stack (+streaks, softness)', t: { bloom: true, chroma: true, softness: true, scanlines: true, grain: true, vignette: true, grade: true, streaks: true } },
  ];
  const frame = (chroma: number = postTok.chroma.base) => ({ time: 4.2, chroma, speed01: 0.75, vanish, flash: 0, danger01: 0 });
  const draw = (s: (typeof steps)[number], chroma?: number) => {
    post.setClean(!!s.clean);
    post.toggles = { ...s.t };
    post.render(scene, camera, frame(chroma));
  };

  fillOverlay(ctx.overlay, W, H);
  const cw = (W - 48) / 3, ch = Math.round((cw * 9) / 16);
  const passes: number[] = [];
  steps.forEach((s, i) => {
    draw(s);
    passes.push(post.lastPassCount);
    const dst = { x: 12 + (i % 3) * (cw + 12), y: 64 + Math.floor(i / 3) * (ch + 12), w: cw, h: ch };
    blitToOverlay(ctx.overlay, ctx.glCanvas, { x: 0, y: 0, w: W, h: H }, dst);
    ctx.label(`${i + 1}. ${s.name}  [${post.lastPassCount} pass${post.lastPassCount > 1 ? 'es' : ''}]`, dst.x + 4, dst.y + 4);
  });
  const by = 64 + 2 * (ch + 12), bh = H - by - 12;
  // 1:1 crops: craft clean vs full, and the top-left corner at ring-pulse chroma
  const craftP = new THREE.Vector3(0, 0.5, -6).project(camera);
  const cx = (craftP.x * 0.5 + 0.5) * W, cy = (1 - (craftP.y * 0.5 + 0.5)) * H;
  const craftCrop = { x: cx - cw / 2, y: cy - bh / 2 - 40, w: cw, h: bh };
  draw(steps[0]);
  blitToOverlay(ctx.overlay, ctx.glCanvas, craftCrop, { x: 12, y: by, w: cw, h: bh });
  ctx.label('1:1 craft, clean', 16, by + 4);
  draw(steps[5]);
  blitToOverlay(ctx.overlay, ctx.glCanvas, craftCrop, { x: 24 + cw, y: by, w: cw, h: bh });
  ctx.label('1:1 craft, full stack', 28 + cw, by + 4);
  draw(steps[5], postTok.chroma.ring);
  blitToOverlay(ctx.overlay, ctx.glCanvas, { x: W - cw, y: 470, w: cw, h: bh }, { x: 36 + 2 * cw, y: by, w: cw, h: bh });
  ctx.label(`1:1 right edge, full, chroma ${postTok.chroma.ring} (ring pulse)`, 40 + 2 * cw, by + 4);

  ctx.title(`Post stack ${v}`, `HDR ${post.hdr ? 'HalfFloat' : 'UnsignedByte'}, MSAA ${post.samples}x, passes clean/full = ${passes[0]}/${passes[5]}, chroma ${postTok.chroma.base}, speed01 0.75`);
  ctx.exportParams({ post: params, hdr: post.hdr, msaa: post.samples, passes: Object.fromEntries(steps.map((s, i) => [s.name, passes[i]])) });
  ctx.ready();
}
