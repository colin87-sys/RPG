/**
 * Cloudgate vista board: one 1920x1080 chase-camera frame (camera (0, 5, 20)
 * looking down -Z, FOV 68) built with the game's sky builders, a dark placeholder
 * craft at the origin for contrast, and insets: toward the sun, and later rail
 * samples (t = 20 s / 900 m and t = 300 s / 13.5 km) proving the field recycles.
 * Exports renderVistaBoard for the Violet Tide board.
 */
import * as THREE from 'three';
import type { LabContext, Rect } from '../context';
import { palette, stages } from '../../style/tokens';
import { applyStageLook } from '../../gen/common/lighting';
import { toonMaterial } from '../../gen/common/materials';
import { buildSkyVista, CLOUDGATE_VARIANTS, type SkyVistaParams, type VariantId } from '../../gen/world/sky';
import { puffAtlasData, ATLAS_SIZE } from '../../gen/world/sky/puffAtlas';

export const CHASE_CAM = { pos: new THREE.Vector3(0, 5, 20), fov: 68 };
const RAIL_SPEED = 45;

/** Dark delta placeholder (12 m long, 9 m span) standing in for the real craft. */
export function placeholderCraft(): THREE.Mesh {
  const nose = [0, 0.2, -6], lt = [-4.5, 0, 6], rt = [4.5, 0, 6], tail = [0, 0.1, 4], top = [0, 1.1, 1.5], bot = [0, -0.6, 1.5];
  const tris = [nose, lt, top, nose, top, rt, lt, tail, top, tail, rt, top, nose, bot, lt, nose, rt, bot, lt, bot, tail, tail, bot, rt];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, toonMaterial({ albedo: palette.armourDark, emissive: palette.accentOrange, emissiveStrength: 0.0 }));
  m.name = 'placeholderCraft';
  return m;
}

export interface InsetSpec {
  label: string;
  time: number;
  /** camera position for this inset */
  pos: THREE.Vector3;
  /** look direction */
  dir: THREE.Vector3;
  fov?: number;
}

export async function renderVistaBoard(ctx: LabContext, params: SkyVistaParams, title: string, insets: InsetSpec[], note: string) {
  const seed = Number(ctx.q.get('seed') ?? 1);
  applyStageLook(params.stage);
  const scene = new THREE.Scene();
  const vista = buildSkyVista(params, seed);
  scene.add(vista.group);
  const craft = placeholderCraft();
  scene.add(craft);

  const cam = new THREE.PerspectiveCamera(CHASE_CAM.fov, ctx.width / ctx.height, 0.5, 20000);
  const shoot = (pos: THREE.Vector3, dir: THREE.Vector3, time: number, rect: Rect, fov = CHASE_CAM.fov) => {
    cam.fov = fov;
    cam.position.copy(pos);
    cam.lookAt(pos.x + dir.x * 100, pos.y + dir.y * 100, pos.z + dir.z * 100);
    craft.position.set(pos.x, pos.y - CHASE_CAM.pos.y, pos.z - CHASE_CAM.pos.z);
    vista.update(cam.position, time);
    ctx.renderCells([{ scene, camera: cam, rect }], null);
  };

  ctx.clearAll(stages[params.stage].sky.mid);
  const full: Rect = { x: 0, y: 0, w: ctx.width, h: ctx.height };
  shoot(CHASE_CAM.pos, new THREE.Vector3(0, 0, -1), 0, full);
  const info = { calls: ctx.renderer.info.render.calls, triangles: ctx.renderer.info.render.triangles };

  // insets along the right edge / bottom-left
  const iw = 520, ih = Math.round((iw * 9) / 16), pad = 14;
  const slots: Rect[] = [
    { x: ctx.width - iw - pad, y: 66, w: iw, h: ih },
    { x: ctx.width - iw - pad, y: ctx.height - ih - pad, w: iw, h: ih },
    { x: pad, y: ctx.height - ih - pad, w: iw, h: ih },
  ];
  insets.forEach((s, i) => shoot(s.pos, s.dir, s.time, slots[i], s.fov));

  ctx.title(title, note);
  const g = ctx.overlay;
  insets.forEach((s, i) => {
    const r = slots[i];
    g.strokeStyle = palette.hudLine;
    g.lineWidth = 2;
    g.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    ctx.label(s.label, r.x + 6, r.y + 6);
  });
  ctx.label(`main: chase cam (0, 5, 20) -> -Z, FOV 68, t = 0 | ${vista.stats.triangles} sky tris, ${vista.stats.drawCalls} sky draws, ${vista.stats.puffs} puffs`, 16, 62);

  if (ctx.q.get('debug') === 'atlas') {
    const d = puffAtlasData();
    const img = g.createImageData(ATLAS_SIZE, ATLAS_SIZE);
    for (let i = 0; i < ATLAS_SIZE * ATLAS_SIZE; i++) {
      const row = ATLAS_SIZE - 1 - Math.floor(i / ATLAS_SIZE), col = i % ATLAS_SIZE;
      const o = (row * ATLAS_SIZE + col) * 4;
      const a = d[i * 4 + 3] / 255, ny = d[i * 4 + 1] / 255, ao = d[i * 4 + 2] / 255;
      const v = (0.25 + 0.75 * ao * (0.4 + 0.6 * ny)) * 255;
      img.data[o] = v * a + 20 * (1 - a);
      img.data[o + 1] = v * a + 30 * (1 - a);
      img.data[o + 2] = v * a + 60 * (1 - a);
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 56);
  }

  const out = {
    board: ctx.board,
    variant: ctx.variant,
    seed,
    camera: { position: [0, 5, 20], lookDir: [0, 0, -1], fov: CHASE_CAM.fov },
    insets: insets.map((s) => ({ label: s.label, time: s.time, position: s.pos.toArray(), dir: s.dir.toArray() })),
    stats: { ...vista.stats, mainFrameRendererInfo: info },
    params,
  };
  ctx.exportParams(out);
  ctx.ready();
}

export function railInsets(extra: InsetSpec): InsetSpec[] {
  const at = (t: number) => new THREE.Vector3(0, CHASE_CAM.pos.y, CHASE_CAM.pos.z - RAIL_SPEED * t);
  return [
    extra,
    { label: 't = 20 s, camera 900 m down -Z', time: 20, pos: at(20), dir: new THREE.Vector3(0, 0, -1) },
    { label: 't = 300 s, camera 13.5 km down -Z', time: 300, pos: at(300), dir: new THREE.Vector3(0, 0, -1) },
  ];
}

export default async function board(ctx: LabContext) {
  const v = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as VariantId;
  const params = CLOUDGATE_VARIANTS[v];
  const key = new THREE.Vector3(...stages.cloudgate.key.dir);
  const sunDir = key.clone().normalize();
  const names = { A: 'sparse towers', B: 'medium banks', C: 'dense, narrow corridor' };
  await renderVistaBoard(
    ctx,
    params,
    `Cloudgate vista ${v}: ${names[v]}`,
    railInsets({ label: 'toward the sun (high-left key)', time: 0, pos: CHASE_CAM.pos.clone(), dir: sunDir.multiplyScalar(0.8).add(new THREE.Vector3(0, -0.25, -0.2)).normalize() }),
    'sky + cumulus + cloud sea + horizon banks; dark delta = placeholder craft',
  );
}
