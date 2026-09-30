/** Debug board (enemies lane): BULWARK ortho front cell with terms toggled. */
import * as THREE from 'three';
import type { LabContext } from '../context';
import { palette } from '../../style/tokens';
import { applyStageLook } from '../../gen/common/lighting';
import { ENEMY_VARIANTS, buildBulwark } from '../../gen/entities/enemies';

export default async function board(ctx: LabContext) {
  const cells = ctx.grid(2, 2);
  const cases: [string, (u: any) => void][] = [
    ['as-is', () => {}],
    ['no warm rim', (u) => u.uWarmRim.value.set(0, 0, 0)],
    ['no stage rim', (u) => (u.uStageRim.value = 0)],
    ['no emissive', (u) => { u.uChanA.value.set(0, 0, 0, 0); u.uChanB.value.set(0, 0, 0, 0); }],
  ];
  ctx.clearAll();
  cases.forEach(([name, f], i) => {
    const scene = new THREE.Scene();
    const bb = buildBulwark(ENEMY_VARIANTS.B.bulwark, 13);
    bb.update(1 / 60, { time: 1, phase: 1, ventGlow: 0.9 });
    bb.root.traverse((c: any) => { const u = c.material?.userData?.enemy; if (u && u.uWarmRim) f(u); });
    scene.add(bb.root);
    const r = cells[i];
    const hM = 240 * (r.h / r.w);
    const cam = new THREE.OrthographicCamera(-120, 120, hM / 2, -hM / 2, -2000, 2000);
    cam.position.set(0, -20, -140);
    cam.lookAt(0, -22, 0);
    applyStageLook('cloudgate');
    ctx.renderCells([{ scene, camera: cam, rect: r, clear: palette.skyHorizon }], null);
    ctx.label(name, r.x + 6, r.y + 6);
  });
  ctx.ready();
}
