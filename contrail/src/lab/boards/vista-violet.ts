/**
 * Violet Tide vista board: same chase camera, sunset stage, placeholder craft
 * backlit by the low sun ahead. Insets: a side glance showing band depth, and
 * later rail samples proving the bands and puffs recycle.
 */
import * as THREE from 'three';
import type { LabContext } from '../context';
import { VIOLET_VARIANTS, type VariantId } from '../../gen/world/sky';
import { CHASE_CAM, railInsets, renderVistaBoard } from './vista-cloudgate';

export default async function board(ctx: LabContext) {
  const v = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as VariantId;
  const names = { A: 'medium bands, large sun', B: 'tight bands, big sun, thin horizon', C: 'wide bands, smaller sun, wider horizon' };
  await renderVistaBoard(
    ctx,
    VIOLET_VARIANTS[v],
    `Violet Tide vista ${v}: ${names[v]}`,
    railInsets({ label: 'side glance 55 deg left, 8 deg down', time: 0, pos: CHASE_CAM.pos.clone(), dir: new THREE.Vector3(-0.82, -0.14, -0.57).normalize() }),
    'low sun ahead (craft backlit); indigo bands receding; dark delta = placeholder craft',
  );
}
