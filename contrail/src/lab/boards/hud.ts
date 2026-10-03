/**
 * HUD board: full 1920x1080 perimeter HUD over a bright Cloudgate stand-in sky
 * with a realistic sample state (3 locks, chain 6 with refill, shield 72).
 * Also measures the drawn band extents from a transparent HUD-only layer.
 */
import type { LabContext } from '../context';
import { Hud, HUD_VARIANTS, type HudVariantId } from '../../gen/ui/hud';
import { sampleHudState } from '../../gen/ui/hudSamples';
import { drawBackdrop, drawEnemyStandIn } from '../../gen/ui/backdrop';
import { fontStats, resetFontStats } from '../../gen/ui/font';
import { hud } from '../../style/tokens';
import { luminance, rgbToHex } from '../../style/color';

/** rows (top-down) where the HUD layer has ink in a column band */
export function measureBands(c: HTMLCanvasElement, x0: number, x1: number) {
  const g = c.getContext('2d')!;
  const { width: w, height: h } = c;
  const d = g.getImageData(x0, 0, x1 - x0, h).data;
  const cols = x1 - x0;
  const rowInk = (y: number) => {
    for (let x = 0; x < cols; x++) if (d[(y * cols + x) * 4 + 3] > 40) return true;
    return false;
  };
  let top = 0;
  for (let y = 0; y < h * 0.3; y++) if (rowInk(y)) top = y;
  let bot = h;
  for (let y = h - 1; y > h * 0.7; y--) if (rowInk(y)) bot = y;
  return { topPx: top + 1, topPct: ((top + 1) / h) * 100, bottomPx: h - bot, bottomPct: ((h - bot) / h) * 100, w };
}

export default async function board(ctx: LabContext) {
  const W = ctx.width, H = ctx.height;
  const id = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as HudVariantId;
  const g = ctx.overlay;
  ctx.clearAll();
  drawBackdrop(g, W, H, 'cloudgate', { seed: 3, cloud: 0.7, brightBands: ctx.q.get('bright') !== '0' });
  const s = sampleHudState('normal', W, H);
  const kinds = ['caltrop', 'caltrop', 'dart', 'caltrop', 'dart'] as const;
  s.targets.forEach((t, i) => drawEnemyStandIn(g, t.x, t.y, t.size, kinds[i]));
  // HUD on its own transparent layer (measured), then composited
  const layer = document.createElement('canvas');
  layer.width = W;
  layer.height = H;
  const lg = layer.getContext('2d')!;
  const h = new Hud(id);
  resetFontStats();
  h.draw(lg, W, H, s, 1 / 60);
  // measure the bands in a column through the score cell (no reticle/text there)
  const m = measureBands(layer, Math.round(W * 0.2), Math.round(W * 0.2) + 4);
  g.drawImage(layer, 0, 0);
  const lay = h.layout(W, H);
  // contrast of value text (hudValue) against the composited band background at text rows
  const gd = g.getImageData(0, 0, W, H).data;
  const L = (x: number, y: number) => {
    const i = (Math.round(y) * W + Math.round(x)) * 4;
    return luminance(rgbToHex(gd[i] / 255, gd[i + 1] / 255, gd[i + 2] / 255));
  };
  const probes: [number, number][] = [
    [W * 0.2, H * 0.03], [W * 0.84, H * 0.047], [W * 0.29, H * 0.943], [W * 0.475, H * 0.943], [W * 0.8, H * 0.943], [W * 0.1, H * 0.99],
  ];
  const bgL = Math.max(...probes.map(([x, y]) => L(x, y)));
  const contrast = (luminance(hud.colors.value) + 0.05) / (bgL + 0.05);
  const params = {
    board: 'hud',
    variant: HUD_VARIANTS[id],
    tokens: { bandTop: hud.bandTop, bandBottom: hud.bandBottom, backingAlpha: hud.backingAlpha, lineWidth: hud.lineWidth },
    measured: {
      topBandPct: +m.topPct.toFixed(2),
      bottomBandPct: +m.bottomPct.toFixed(2),
      smallestTextCapPx: +fontStats.minSize.toFixed(1),
      textCalls: fontStats.calls,
      worstBandBgLuminance: +bgL.toFixed(3),
      probeLuminance: probes.map(([x, y]) => +L(x, y).toFixed(3)),
      valueTextContrast: +contrast.toFixed(2),
    },
    layout: lay,
    state: { score: s.score, locks: s.locks, chain: s.combo.chain, refill: s.combo.refill, shield: s.shield },
  };
  (window as any).__hudMeasure = params.measured;
  ctx.exportParams(params);
  ctx.ready();
}
