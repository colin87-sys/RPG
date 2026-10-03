// Colours for harness-generated pages (contact sheets, slideshow, overlays) come from the game's
// style tokens (src/style/tokens.ts is pure data; Node 22 strips its types on import).
// Fallbacks are CSS system colours, so the tools never carry their own hex literals.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ROOT } from './util.mjs';

export async function toolTheme() {
  let p = {};
  try {
    p = (await import(pathToFileURL(join(ROOT, 'src', 'style', 'tokens.ts')).href)).palette || {};
  } catch {}
  return {
    bg: p.spaceDeep || 'Canvas',
    panel: p.debrisDark || 'Canvas',
    line: p.hudLine || 'GrayText',
    text: p.hudText || 'CanvasText',
    value: p.hudValue || 'CanvasText',
    dim: p.hudDim || 'GrayText',
    ok: p.hudText || 'CanvasText',
    bad: p.laserRed || 'CanvasText',
    warn: p.hazardYellow || 'CanvasText',
  };
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
