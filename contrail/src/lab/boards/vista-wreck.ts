/**
 * Wreckfield vista (World lane): chase-camera frame of the space sky + debris
 * field with a placeholder 12 m x 9 m delta (armourLight) to judge contrast,
 * plus an inset of the same field after the camera moved 900 m down -Z
 * (proves stateless recycling). Variants A/B/C = WRECK_VARIANTS.
 */
import * as THREE from 'three';
import type { LabContext } from '../context';
import { palette } from '../../style/tokens';
import { applyStageLook } from '../../gen/common/lighting';
import { toonMaterial } from '../../gen/common/materials';
import { buildWreckfield, WRECK_VARIANTS } from '../../gen/world/space/wreckfield';

/** Simple delta-wing placeholder: 12 m long, 9 m span, nose toward -Z. */
export function placeholderDelta(albedo: string = palette.armourLight): THREE.Mesh {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const nose = v(0, 0.1, -6), l = v(-4.5, 0, 4.6), r = v(4.5, 0, 4.6), tail = v(0, 0.1, 3.2), top = v(0, 1.0, 0.8), bot = v(0, -0.6, 1.2);
  const tris = [
    [nose, top, l], [nose, r, top], [l, top, tail], [top, r, tail],
    [nose, l, bot], [nose, bot, r], [l, tail, bot], [bot, tail, r],
  ];
  const pos: number[] = [];
  for (const t of tris) for (const p of t) pos.push(p.x, p.y, p.z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((pos.length / 3) * 2).fill(0), 2));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, toonMaterial({ albedo, rim: 1.4 }));
  m.name = 'placeholderCraft';
  return m;
}

export default async function board(ctx: LabContext) {
  const variant = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as 'A' | 'B' | 'C';
  const params = WRECK_VARIANTS[variant];
  const seed = Number(ctx.q.get('seed') ?? 7);
  applyStageLook('wreckfield');

  const scene = new THREE.Scene();
  const world = buildWreckfield(params, seed);
  scene.add(world.group);
  const craft = placeholderDelta();
  craft.rotation.z = -0.18; // slight bank so the planet rim catches the wing
  scene.add(craft);

  // chase camera per Director note: 20 m behind, 5 m above, FOV 68, looking down -Z
  const cam = new THREE.PerspectiveCamera(68, 16 / 9, 0.5, 3000);
  cam.position.set(0, 5, 20);
  cam.lookAt(0, 2.2, -60);
  const time = 12.0;
  world.update(cam.position, time);

  const full = { x: 0, y: 0, w: ctx.width, h: ctx.height };
  ctx.renderCells([{ scene, camera: cam, rect: full }], palette.spaceDeep);
  const info = ctx.renderer.info.render;
  const measured = { triangles: info.triangles, calls: info.calls, points: info.points };

  // layer labels: project representative instances
  const proj = (p: THREE.Vector3) => {
    const q = p.clone().project(cam);
    return { x: (q.x * 0.5 + 0.5) * ctx.width, y: (-q.y * 0.5 + 0.5) * ctx.height, ok: q.z < 1 && Math.abs(q.x) < 0.92 && Math.abs(q.y) < 0.85 };
  };
  const pick = (kind: 'asteroid' | 'slab', near: boolean) => {
    const list = world.debris.debugInstances(kind).map((d) => ({ d, s: proj(d.center), dist: d.center.distanceTo(cam.position) }))
      .filter((e) => e.s.ok && e.dist > 40 && e.s.y > 90 && e.s.x < ctx.width - 640 && e.s.y < ctx.height - 120);
    list.sort((a, b) => (near ? a.dist - b.dist : (b.dist < 700 ? 1 : 0) - (a.dist < 700 ? 1 : 0) || b.d.radius - a.d.radius));
    return list[0];
  };
  const slab = pick('slab', true);
  const ast = pick('asteroid', false);
  if (slab) ctx.label(`mid slab ${slab.dist.toFixed(0)} m`, slab.s.x + 10, slab.s.y + 10);
  if (ast) ctx.label(`far asteroid ${ast.dist.toFixed(0)} m`, Math.min(ast.s.x + 10, ctx.width - 260), ast.s.y - 30);
  const pl = proj(cam.position.clone().addScaledVector(world.sky.planetDir, 500));
  ctx.label('planet = key light', Math.min(pl.x - 60, ctx.width - 200), pl.y + 130);
  ctx.label('foreground flecks (streaked)', 24, ctx.height - 120);

  // inset: +900 m down -Z
  const cam2 = cam.clone();
  cam2.position.z -= 900;
  const craft2Z = craft.position.z;
  craft.position.z = craft2Z - 900;
  world.update(cam2.position, time + 20);
  const inset = { x: ctx.width - 16 - 576, y: ctx.height - 16 - 324, w: 576, h: 324 };
  ctx.renderCells([{ scene, camera: cam2, rect: inset, clear: palette.spaceDeep }], null);
  const g = ctx.overlay;
  g.strokeStyle = palette.hudLine;
  g.lineWidth = 2;
  g.strokeRect(inset.x, inset.y, inset.w, inset.h);
  ctx.label('same field after +900 m down -Z (recycled)', inset.x + 6, inset.y + 6);

  const st = world.debris.stats;
  const sky = world.sky.stats;
  ctx.title('Wreckfield vista', `sky+debris ${sky.triangles + st.triangles} tris, ${sky.drawCalls + st.drawCalls} calls | measured frame ${measured.triangles} tris ${measured.calls} calls`);
  ctx.label(`asteroids ${st.instances.asteroids}  slabs ${st.instances.slabs}  flecks ${st.instances.flecks}  stars ${sky.points}`, 16, 60);

  const exported = { board: 'vista-wreck', variant, seed, camera: { pos: [0, 5, 20], lookAt: [0, 2.2, -60], fov: 68 }, time, params, stats: { sky, debris: st, measuredFrame: measured } };
  ctx.exportParams(exported);
  ctx.ready();
}
