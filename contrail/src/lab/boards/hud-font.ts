/**
 * Font specimen: the code-drawn CONTRAIL glyph set at several cap heights, on a
 * near-black and a near-white backdrop, for the variant's glyph face.
 */
import type { LabContext } from '../context';
import { hud, palette } from '../../style/tokens';
import { withAlpha } from '../../style/color';
import { drawText, GLYPH_SET, GLYPH_STYLES, type GlyphStyleId } from '../../gen/ui/font';

export default async function board(ctx: LabContext) {
  const g = ctx.overlay;
  const W = ctx.width, H = ctx.height;
  const id = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as GlyphStyleId;
  const style = GLYPH_STYLES[id];
  ctx.clearAll(palette.spaceDeep);
  // right half: near-white cloud backdrop
  g.fillStyle = palette.spaceDeep;
  g.fillRect(0, 0, W, H);
  g.fillStyle = palette.cloudCream;
  g.fillRect(W / 2, 52, W / 2, H - 52);
  ctx.title('HUD font specimen', `glyph face ${id}: stroke ${style.stroke} slant ${style.slant} chamfer ${style.chamfer}`);
  const lines = ['ABCDEFGHIJKLM', 'NOPQRSTUVWXYZ', '0123456789 x1.6 42%', '. : / - + > < [ ] ( ) ! ?'];
  const sizes = [12, 16, 24, 40];
  for (let side = 0; side < 2; side++) {
    const x0 = side * (W / 2) + 24;
    let y = 90;
    for (const s of sizes) {
      for (const l of lines) {
        drawText(g, l, x0, y, s, {
          color: side === 0 ? hud.colors.text : hud.colors.value,
          style,
          outline: side === 1 ? withAlpha(hud.colors.backing, 0.75) : undefined,
        });
        y += s * 1.75;
      }
      y += 10;
    }
    drawText(g, 'SCORE 0124850  CHAIN 6 x1.6  SHLD 72/100', x0, y + 10, 13, { color: hud.colors.value, style, outline: side === 1 ? withAlpha(hud.colors.backing, 0.75) : undefined });
    drawText(g, 'CONTRAIL', x0, y + 90, 90, { color: hud.colors.value, style, tracking: 0.2, glow: 0.6, outline: side === 1 ? withAlpha(hud.colors.backing, 0.6) : undefined });
  }
  ctx.exportParams({ glyphStyle: id, style, set: GLYPH_SET, sizes });
  ctx.ready();
}
