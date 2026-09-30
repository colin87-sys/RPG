/**
 * Palette / light board: token swatches per stage + lit spheres under each
 * stage's key / rim / ambient setup (GAME_FORGE W3 "Palette/light board").
 */
import * as THREE from 'three';
import type { LabContext } from '../context';
import { palette, stages, type StageId } from '../../style/tokens';
import { applyStageLook } from '../../gen/common/lighting';
import { toonMaterial } from '../../gen/common/materials';

export default async function board(ctx: LabContext) {
  const ids: StageId[] = ['cloudgate', 'violetTide', 'wreckfield'];
  const cells = ctx.grid(3, 1, 12, 64, 300);
  ctx.title('Palette + light', 'spheres lit by each stage rig; swatches below');
  const albedos = [palette.armourLight, palette.armourSteel, palette.enemyBody, palette.cloudCream, palette.accentOrange];
  ctx.clearAll();
  ids.forEach((id, i) => {
    applyStageLook(id); // shared uniforms: render this cell before switching stage
    const look = stages[id];
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(30, cells[i].w / cells[i].h, 0.1, 100);
    cam.position.set(0, 0.6, 9);
    cam.lookAt(0, 0, 0);
    albedos.forEach((a, k) => {
      const m = toonMaterial({ albedo: a, emissive: a === palette.accentOrange ? palette.accentOrange : undefined, emissiveStrength: 0.35 });
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.62, 48, 32), m);
      s.position.set((k - 2) * 1.45, 0, 0);
      scene.add(s);
    });
    ctx.renderCells([{ scene, camera: cam, rect: cells[i], clear: look.sky.mid }], null);
    ctx.label(look.name, cells[i].x + 8, cells[i].y + 8);
  });
  // swatches
  const g = ctx.overlay;
  const keys = Object.keys(palette) as (keyof typeof palette)[];
  const cols = 12, sw = (ctx.width - 24) / cols, sh = 44;
  keys.forEach((k, i) => {
    const x = 12 + (i % cols) * sw, y = ctx.height - 290 + Math.floor(i / cols) * (sh + 4);
    g.fillStyle = palette[k];
    g.fillRect(x, y, sw - 4, sh - 18);
    g.fillStyle = palette.hudValue;
    g.font = '11px ui-monospace, Menlo, monospace';
    g.fillText(`${k} ${palette[k]}`, x, y + sh - 6);
  });
  ctx.exportParams({ stages: ids, albedos });
  ctx.ready();
}
