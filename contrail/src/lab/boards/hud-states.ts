/**
 * HUD states board, 2x2: normal over bright Cloudgate sky (near-white masses
 * behind both bands), normal over dark space, hazard state, danger state (low
 * shield, red pilot frame). Each cell is a full 1920x1080 frame rendered
 * off-screen and scaled into the grid. `&cell=N` renders one state full-frame.
 */
import type { LabContext } from '../context';
import { Hud, HUD_VARIANTS, type HudVariantId } from '../../gen/ui/hud';
import { sampleHudState, type HudSampleId } from '../../gen/ui/hudSamples';
import { drawBackdrop, drawEnemyStandIn } from '../../gen/ui/backdrop';
import type { StageId } from '../../style/tokens';

const CELLS: { id: HudSampleId; stage: StageId; title: string; bright?: boolean }[] = [
  { id: 'normal', stage: 'cloudgate', title: 'NORMAL / BRIGHT SKY (near-white behind bands)', bright: true },
  { id: 'space', stage: 'wreckfield', title: 'NORMAL / DARK SPACE' },
  { id: 'hazard', stage: 'wreckfield', title: 'HAZARD STATE' },
  { id: 'danger', stage: 'violetTide', title: 'DANGER STATE (shield 14, red pilot frame)' },
];

function renderFrame(variant: HudVariantId, cell: (typeof CELLS)[number], W: number, H: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  drawBackdrop(g, W, H, cell.stage, { seed: 11, cloud: 0.8, brightBands: cell.bright });
  const s = sampleHudState(cell.id, W, H);
  s.targets.forEach((t, i) => drawEnemyStandIn(g, t.x, t.y, t.size, t.boss ? 'strider' : i % 2 ? 'dart' : 'caltrop'));
  new Hud(variant).draw(g, W, H, s, 1 / 60);
  return c;
}

export default async function board(ctx: LabContext) {
  const id = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as HudVariantId;
  const g = ctx.overlay;
  ctx.clearAll();
  const only = ctx.q.get('cell');
  if (only !== null) {
    g.drawImage(renderFrame(id, CELLS[Number(only)], ctx.width, ctx.height), 0, 0);
  } else {
    ctx.title('HUD states', 'normal/bright, normal/dark, hazard, danger (each a scaled 1920x1080 frame)');
    const rects = ctx.grid(2, 2, 12, 64, 12);
    CELLS.forEach((cell, i) => {
      const r = rects[i];
      // keep 16:9 inside the cell
      const cw = Math.min(r.w, (r.h * 16) / 9), ch = (cw * 9) / 16;
      const x = r.x + (r.w - cw) / 2, y = r.y + (r.h - ch) / 2;
      g.drawImage(renderFrame(id, cell, 1920, 1080), x, y, cw, ch);
      ctx.label(cell.title, x + cw * 0.3, y + ch * 0.8);
    });
  }
  ctx.exportParams({ board: 'hud-states', variant: HUD_VARIANTS[id], cells: CELLS.map((c) => ({ state: c.id, backdrop: c.stage, brightBands: !!c.bright })) });
  ctx.ready();
}
