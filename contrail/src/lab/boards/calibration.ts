/**
 * Reviewer calibration (GAME_FORGE Phase 2): the same test scene rendered
 *   variant A = naive (default grey MeshStandardMaterial, random colours, flat light, no post)
 *   variant B = art-directed (game builders, stage rig, sky vista, post stack)
 *   variant C = art-directed with planted defects (craft clipped by the frame edge, low-contrast HUD label)
 * The Reviewer receives these unlabelled (as X/Y/Z) and must rank B > A and find C's defects.
 */
import * as THREE from 'three';
import type { LabContext } from '../context';
import { palette } from '../../style/tokens';
import { applyStageLook } from '../../gen/common/lighting';
import { buildKestrel, KESTREL_VARIANTS } from '../../gen/entities/kestrel';
import { ENEMY_VARIANTS, buildDart, buildCaltrop } from '../../gen/entities/enemies';
import { buildSkyVista } from '../../gen/world/sky';
import { CLOUDGATE_VARIANTS } from '../../gen/world/sky/params';
import { PostStack, POST_VARIANTS } from '../../gen/vfx/post';
import { drawText } from '../../gen/ui/font';

export default async function board(ctx: LabContext) {
  const v = ctx.variant;
  const W = ctx.width, H = ctx.height;
  applyStageLook('cloudgate');
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(68, W / H, 0.5, 9000);
  cam.position.set(0, 5, 20);
  cam.lookAt(0, 1, -40);
  const craft = buildKestrel(KESTREL_VARIANTS.B, 7);
  const craftState = { time: 1, bank: -0.35, pitch: 0.05, throttle: 1, boost: false, drift: false, hitFlash: 0 };
  craft.snap(craftState);
  scene.add(craft.root);
  const ev = ENEMY_VARIANTS.B;
  const darts = [buildDart(ev.dart, 3), buildDart(ev.dart, 4)];
  darts[0].root.position.set(-12, 6, -90);
  darts[1].root.position.set(10, 9, -110);
  const stars = [0, 1, 2, 3, 4].map((i) => {
    const c = buildCaltrop(ev.caltrop, 10 + i);
    c.root.position.set(-18 + i * 7, 14 - i * 2, -70 - i * 6);
    return c;
  });
  for (const d of darts) { d.root.rotation.y = Math.PI; scene.add(d.root); }
  for (const s of stars) scene.add(s.root);

  if (v === 'A') {
    // naive: strip every custom material, random-ish colours, flat light, plain sky colour
    const cols = ['#9a9a9a', '#b03030', '#3050c0', '#30a040', '#c0c030'];
    let k = 0;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = new THREE.MeshStandardMaterial({ color: new THREE.Color(cols[k++ % cols.length]) });
    });
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    scene.add(new THREE.DirectionalLight(0xffffff, 0.6));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x888888 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -45;
    scene.add(ground);
    ctx.renderer.setClearColor(new THREE.Color('#87a0b8'), 1);
    ctx.renderer.clear();
    ctx.renderer.render(scene, cam);
  } else {
    if (v === 'C') {
      // planted defect 1: craft pushed so its silhouette is clipped by the right frame edge
      craft.root.position.set(19, -3, 4);
    }
    const sky = buildSkyVista(CLOUDGATE_VARIANTS.C, 5);
    scene.add(sky.group);
    sky.update(cam.position, 0);
    const post = new PostStack(ctx.renderer, { params: POST_VARIANTS.A });
    post.setSize(W, H, 1);
    post.render(scene, cam, { time: 1, chroma: 0.0015, speed01: 0.45, vanish: new THREE.Vector2(0, 0.05), flash: 0, danger01: 0 });
  }
  // a HUD label in the corner (C: planted low-contrast colour on bright sky)
  const g = ctx.overlay;
  const col = v === 'C' ? palette.cloudMid : palette.hudText;
  drawText(g, 'SCORE 0012840', 40, 60, 26, { color: col, align: 'left' } as never);
  ctx.exportParams({ variant: v, meaning: 'A naive / B art-directed / C art-directed + planted defects (clipped craft, low-contrast label)' });
  ctx.ready();
}
