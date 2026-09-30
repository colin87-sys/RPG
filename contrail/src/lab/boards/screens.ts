/**
 * Screens board, 2x2: title (menu), results, stage-start card (with NEW UPGRADE
 * chip), SIGNAL LOST retry card. Each cell is a full 1920x1080 frame scaled in.
 * `&cell=N` renders one full-frame; `&cell=4` = pause overlay, `&cell=5` = title
 * press-start prompt.
 */
import type { LabContext } from '../context';
import { drawGameOver, drawPause, drawResults, drawStageCard, drawTitle, setScreenStyle } from '../../gen/ui/screens';
import { Hud, HUD_VARIANTS, type HudVariantId } from '../../gen/ui/hud';
import { sampleHudState } from '../../gen/ui/hudSamples';
import { drawBackdrop } from '../../gen/ui/backdrop';

type Cell = { title: string; draw: (g: CanvasRenderingContext2D, W: number, H: number, v: HudVariantId) => void };

const CELLS: Cell[] = [
  { title: 'TITLE / MENU', draw: (g, W, H) => drawTitle(g, W, H, { time: 2.2, showMenu: true, selected: 0, tags: [null, 'LOCKED', 'SOON'] }) },
  {
    title: 'RESULTS',
    draw: (g, W, H, v) => {
      drawBackdrop(g, W, H, 'cloudgate', { seed: 5 });
      drawResults(g, W, H, { stage: 'CLOUDGATE', score: 184250, bestChain: 23, shieldLeft: 64, timeS: 183.4, rank: 'A', t: 3, newBest: true, bonus: 640 });
    },
  },
  {
    title: 'STAGE CARD + NEW UPGRADE',
    draw: (g, W, H, v) => {
      drawBackdrop(g, W, H, 'violetTide', { seed: 9 });
      const s = sampleHudState('normal', W, H);
      s.stage = 'VIOLET TIDE';
      s.targets = [];
      s.combatText = [];
      s.lockMode = false;
      s.enemyInfo = null;
      s.progress = 0;
      s.score = 184250;
      s.combo = { chain: 0, timer: 0, refill: false, multiplier: 1 };
      s.reticle = { x: W / 2, y: H * 0.62 };
      new Hud(v).draw(g, W, H, s, 1 / 60);
      drawStageCard(g, W, H, { index: 2, stage: 'VIOLET TIDE', subtitle: 'CROSS THE CLOUD SEA BEFORE NIGHTFALL', t: 1.6, upgrade: { name: 'MISSILE RACK +1', detail: 'LOCK-ON CAPACITY 6 > 7' } });
    },
  },
  {
    title: 'SIGNAL LOST',
    draw: (g, W, H) => {
      drawBackdrop(g, W, H, 'wreckfield', { seed: 4 });
      drawGameOver(g, W, H, { t: 1.4, stage: 'WRECKFIELD', score: 96420, progress: 0.61, selected: 0 });
    },
  },
  {
    title: 'PAUSE',
    draw: (g, W, H, v) => {
      drawBackdrop(g, W, H, 'cloudgate', { seed: 3 });
      new Hud(v).draw(g, W, H, { ...sampleHudState('normal', W, H), paused: true }, 1 / 60);
      drawPause(g, W, H, { selected: 1, t: 1, stage: 'CLOUDGATE' });
    },
  },
  { title: 'TITLE / PRESS START', draw: (g, W, H) => drawTitle(g, W, H, { time: 1.9, showMenu: false, selected: 0 }) },
];

function frame(cell: Cell, W: number, H: number, v: HudVariantId): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  cell.draw(c.getContext('2d')!, W, H, v);
  return c;
}

export default async function board(ctx: LabContext) {
  const v = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as HudVariantId;
  const vv = HUD_VARIANTS[v];
  setScreenStyle(vv.glyph, vv.chamfer, vv.lineMul);
  const g = ctx.overlay;
  ctx.clearAll();
  const only = ctx.q.get('cell');
  if (only !== null) {
    g.drawImage(frame(CELLS[Number(only)], ctx.width, ctx.height, v), 0, 0);
  } else {
    ctx.title('Screens', 'title, results, stage card, game over (each a scaled 1920x1080 frame)');
    const rects = ctx.grid(2, 2, 12, 64, 12);
    for (let i = 0; i < 4; i++) {
      const r = rects[i];
      const cw = Math.min(r.w, (r.h * 16) / 9), ch = (cw * 9) / 16;
      const x = r.x + (r.w - cw) / 2, y = r.y + (r.h - ch) / 2;
      g.drawImage(frame(CELLS[i], 1920, 1080, v), x, y, cw, ch);
      ctx.label(CELLS[i].title, x + 8, y + 8);
    }
  }
  ctx.exportParams({ board: 'screens', variant: vv, cells: CELLS.map((c) => c.title) });
  ctx.ready();
}
