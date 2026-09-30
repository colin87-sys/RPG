/**
 * CONTRAIL full-screen UI cards (Canvas 2D, code-drawn font, tokens only):
 * title, results, pause overlay, "SIGNAL LOST" retry card, stage-start card.
 * All functions draw in CSS px in the current transform; the caller clears.
 * Animations are driven by the data's time fields (seconds since shown).
 */
import { hud, palette } from '../../style/tokens';
import { mix, withAlpha } from '../../style/color';
import { drawText, measureText, GLYPH_STYLES, type GlyphStyle, type TextOpts } from './font';
import { hashString } from '../../core/rng';

/* -------------------------------- data ---------------------------------- */

export interface TitleState {
  /** seconds since the title appeared */
  time: number;
  /** false: "PRESS ENTER / START" prompt; true: the menu */
  showMenu: boolean;
  selected: number;
  /** default ['CAMPAIGN', 'CARAVAN', 'SETTINGS'] */
  items?: string[];
  /** per item: a short tag like 'LOCKED' or 'SOON' (drawn dim, item not selectable) */
  tags?: (string | null)[];
  /** draw the code-drawn backdrop (default true); false to overlay a 3D scene */
  backdrop?: boolean;
  version?: string;
}

export type Rank = 'S' | 'A' | 'B' | 'C';

export interface ResultsData {
  stage: string;
  score: number;
  bestChain: number;
  shieldLeft: number;
  shieldMax?: number;
  timeS: number;
  rank: Rank;
  /** seconds since the results appeared (rows slide in, rank stamps at ~1.1 s) */
  t: number;
  newBest?: boolean;
  bonus?: number;
}

export interface PauseData {
  selected: number;
  /** default ['RESUME', 'RESTART STAGE', 'QUIT TO TITLE'] */
  items?: string[];
  t: number;
  stage?: string;
}

export interface GameOverData {
  /** seconds since the card appeared */
  t: number;
  stage: string;
  score: number;
  /** 0..1 route progress reached */
  progress?: number;
  selected?: number;
  /** default ['RETRY', 'QUIT TO TITLE'] */
  items?: string[];
}

export interface StageCardData {
  /** 1-based stage number */
  index: number;
  stage: string;
  subtitle?: string;
  /** seconds since the card appeared */
  t: number;
  /** total card time (fades out over the last 0.4 s); default 3 */
  duration?: number;
  /** "NEW UPGRADE" chip (signposting fix) */
  upgrade?: { name: string; detail?: string } | null;
}

/** Screens share the HUD variant's glyph face; set once at startup. */
export const screenStyle: { glyph: GlyphStyle; chamfer: number; lineMul: number } = { glyph: GLYPH_STYLES.A, chamfer: 14, lineMul: 1 };
/** touch play: prompts say TAP instead of naming keys */
let touchPrompts = false;
export function setTouchPrompts(on: boolean): void {
  touchPrompts = on;
}

export function setScreenStyle(glyph: GlyphStyle, chamfer = 14, lineMul = 1): void {
  screenStyle.glyph = glyph;
  screenStyle.chamfer = chamfer;
  screenStyle.lineMul = lineMul;
}

/* ------------------------------- helpers -------------------------------- */

const C = hud.colors;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const easeOutBack = (t: number) => {
  const c = 1.7;
  const x = clamp01(t) - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
};
const OUTLINE = withAlpha(palette.hudBacking, 0.8);

function txt(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, o: Partial<TextOpts> = {}): number {
  return drawText(g, s, x, y, size, { color, style: screenStyle.glyph, outline: OUTLINE, ...o });
}
function meas(s: string, size: number, tracking = 0): number {
  return measureText(s, size, { style: screenStyle.glyph, tracking });
}

function plate(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ch: number): void {
  g.beginPath();
  g.moveTo(x + ch, y);
  g.lineTo(x + w, y);
  g.lineTo(x + w, y + h - ch);
  g.lineTo(x + w - ch, y + h);
  g.lineTo(x, y + h);
  g.lineTo(x, y + ch);
  g.closePath();
}

function panel(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, k: number, border: string = C.line, fillA = 0.78): void {
  const ch = screenStyle.chamfer * k * 1.4;
  plate(g, x, y, w, h, ch);
  g.fillStyle = withAlpha(C.backing, fillA);
  g.fill();
  g.strokeStyle = border;
  g.lineWidth = hud.lineWidth * screenStyle.lineMul * k;
  g.stroke();
  // inner rail detail on the top edge
  g.beginPath();
  g.moveTo(x + ch + 16 * k, y + 6 * k);
  g.lineTo(x + ch + 16 * k + w * 0.25, y + 6 * k);
  g.lineWidth = Math.max(1, k);
  g.strokeStyle = withAlpha(border, 0.6);
  g.stroke();
}

/** vertical menu; returns bottom y */
function menu(g: CanvasRenderingContext2D, cx: number, y: number, items: string[], sel: number, k: number, time: number, tags?: (string | null)[]): number {
  const size = 26 * k;
  const rowH = 58 * k;
  const w = 420 * k;
  for (let i = 0; i < items.length; i++) {
    const yy = y + i * rowH;
    const tag = tags?.[i] ?? null;
    const on = i === sel;
    if (on) {
      plate(g, cx - w / 2, yy - rowH * 0.36, w, rowH * 0.72, 10 * k);
      g.fillStyle = withAlpha(C.text, 0.16);
      g.fill();
      g.strokeStyle = C.text;
      g.lineWidth = 2 * k;
      g.stroke();
      const bob = Math.sin(time * 6) * 4 * k;
      txt(g, '>', cx - w / 2 + 22 * k + bob, yy, size * 0.8, C.text);
      txt(g, '<', cx + w / 2 - 22 * k - bob, yy, size * 0.8, C.text, { align: 'right' });
    }
    txt(g, items[i], cx, yy, size, on ? C.value : C.text, { align: 'center', glow: on ? 0.35 : 0, alpha: tag ? 0.5 : 1 });
    if (tag) {
      const tw = meas(items[i], size);
      const tx = cx + tw / 2 + 16 * k;
      const ts = 13 * k;
      const pw = meas(tag, ts) + 14 * k;
      plate(g, tx, yy - 11 * k, pw, 22 * k, 5 * k);
      g.fillStyle = withAlpha(C.backing, 0.8);
      g.fill();
      g.strokeStyle = C.line;
      g.lineWidth = 1.5 * k;
      g.stroke();
      txt(g, tag, tx + 7 * k, yy, ts, C.text, { outline: undefined, alpha: 0.8 });
    }
  }
  return y + items.length * rowH;
}

function dim(g: CanvasRenderingContext2D, w: number, h: number, a: number): void {
  g.fillStyle = withAlpha(palette.spaceDeep, a);
  g.fillRect(0, 0, w, h);
  // faint scanlines
  g.fillStyle = withAlpha(palette.hazardBlack, 0.12 * a);
  const step = Math.max(2, Math.round(h / 360));
  for (let y = 0; y < h; y += step * 2) g.fillRect(0, y, w, step);
}

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/* -------------------------------- title --------------------------------- */

/** Emblem: an original swept-delta chevron with three contrail streaks on a dark disc. */
export function drawEmblem(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, time = 0): void {
  g.save();
  g.fillStyle = palette.emblemBlack;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = r * 0.05;
  g.strokeStyle = C.line;
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, r * 0.86, -2.4, 0.9);
  g.strokeStyle = palette.accentOrange;
  g.lineWidth = r * 0.04;
  g.stroke();
  // three streaks trailing lower-left
  for (let i = 0; i < 3; i++) {
    const off = (i - 1) * r * 0.22;
    const gr = g.createLinearGradient(cx - r * 0.8, cy + r * 0.6, cx, cy);
    gr.addColorStop(0, withAlpha(palette.smokeLit, 0));
    gr.addColorStop(1, withAlpha(palette.smokeLit, 0.9));
    g.strokeStyle = gr;
    g.lineWidth = r * (0.07 - Math.abs(i - 1) * 0.02);
    g.beginPath();
    g.moveTo(cx - r * 0.75 + off, cy + r * 0.62 + off);
    g.lineTo(cx - r * 0.05 + off * 0.3, cy + r * 0.05 + off * 0.3);
    g.stroke();
  }
  // delta chevron
  g.beginPath();
  g.moveTo(cx + r * 0.48, cy - r * 0.46);
  g.lineTo(cx + r * 0.05, cy + r * 0.52);
  g.lineTo(cx + r * 0.08, cy + r * 0.12);
  g.lineTo(cx - r * 0.34, cy + r * 0.12);
  g.closePath();
  g.fillStyle = palette.armourLight;
  g.fill();
  g.beginPath();
  g.moveTo(cx + r * 0.48, cy - r * 0.46);
  g.lineTo(cx + r * 0.2, cy + r * 0.05);
  g.lineTo(cx + r * 0.08, cy + r * 0.12);
  g.closePath();
  g.fillStyle = palette.accentOrange;
  g.fill();
  const pulse = 0.6 + 0.4 * Math.sin(time * 3);
  g.fillStyle = withAlpha(palette.exhaustCore, pulse);
  g.beginPath();
  g.arc(cx - r * 0.3, cy + r * 0.12, r * 0.05, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function titleBackdrop(g: CanvasRenderingContext2D, w: number, h: number, time: number): void {
  const k = h / 1080;
  const lin = g.createLinearGradient(0, 0, 0, h);
  lin.addColorStop(0, palette.sunsetZenith);
  lin.addColorStop(0.55, palette.spaceDeep);
  lin.addColorStop(0.78, mix(palette.spaceDeep, palette.sunsetIndigo, 0.6));
  lin.addColorStop(1, palette.spaceDeep);
  g.fillStyle = lin;
  g.fillRect(0, 0, w, h);
  // horizon glow
  const hy = h * 0.8;
  const hg = g.createLinearGradient(0, hy - 60 * k, 0, hy + 60 * k);
  hg.addColorStop(0, withAlpha(palette.sunsetHorizon, 0));
  hg.addColorStop(0.5, withAlpha(palette.sunsetHorizon, 0.4));
  hg.addColorStop(1, withAlpha(palette.sunsetHorizon, 0));
  g.fillStyle = hg;
  g.fillRect(0, hy - 60 * k, w, 120 * k);
  // perspective grid floor
  g.strokeStyle = withAlpha(C.line, 0.22);
  g.lineWidth = Math.max(1, k);
  g.beginPath();
  for (let i = -14; i <= 14; i++) {
    g.moveTo(w / 2 + i * 12 * k, hy);
    g.lineTo(w / 2 + i * 160 * k, h);
  }
  const scroll = (time * 0.35) % 1;
  for (let j = 0; j < 9; j++) {
    const f = (j + scroll) / 9;
    const y = hy + (h - hy) * f * f;
    g.moveTo(0, y);
    g.lineTo(w, y);
  }
  g.stroke();
  // long contrail streaks sweeping up-right through the title zone
  for (let i = 0; i < 3; i++) {
    const y0 = h * (0.66 + i * 0.05);
    const gr = g.createLinearGradient(0, y0, w, h * 0.2);
    gr.addColorStop(0, withAlpha(palette.smokeLit, 0));
    gr.addColorStop(0.7, withAlpha(palette.smokeLit, 0.18 - i * 0.04));
    gr.addColorStop(1, withAlpha(palette.smokeLit, 0.02));
    g.strokeStyle = gr;
    g.lineWidth = (26 - i * 7) * k;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(-40 * k, y0);
    g.bezierCurveTo(w * 0.35, y0 - 40 * k, w * 0.6, h * (0.34 + i * 0.03), w + 40 * k, h * (0.16 + i * 0.04));
    g.stroke();
  }
  g.lineCap = 'butt';
}

export function drawTitle(g: CanvasRenderingContext2D, w: number, h: number, st: TitleState): void {
  const k = h / 1080;
  g.save();
  if (st.backdrop !== false) titleBackdrop(g, w, h, st.time);
  const cx = w / 2;
  const intro = easeOut(st.time / 0.8);
  // title word with an exhaust streak underline
  const size = 124 * k;
  const tr = 0.22;
  const tw = meas('CONTRAIL', size, tr);
  const ty = h * 0.36;
  const er = 78 * k;
  drawEmblem(g, cx, ty - size * 0.5 - er - 40 * k, er, st.time);
  g.globalAlpha = intro;
  txt(g, 'CONTRAIL', cx, ty, size, C.value, { align: 'center', tracking: tr, weight: 1.25, glow: 0.45 });
  const lineW = tw * intro;
  const ly = ty + size * 0.5 + 26 * k;
  const gr = g.createLinearGradient(cx - lineW / 2, 0, cx + lineW / 2, 0);
  gr.addColorStop(0, withAlpha(palette.accentOrange, 0));
  gr.addColorStop(0.75, palette.accentOrange);
  gr.addColorStop(1, palette.exhaustCore);
  g.fillStyle = gr;
  g.fillRect(cx - lineW / 2, ly, lineW, 5 * k);
  g.fillStyle = C.line;
  g.fillRect(cx - lineW / 2, ly + 12 * k, lineW * 0.6, 2 * k);
  txt(g, 'KESTREL PROGRAM // RAIL SORTIE', cx + lineW / 2, ly + 34 * k, 16 * k, C.text, { align: 'right', tracking: 0.12 });
  g.globalAlpha = 1;

  if (!st.showMenu) {
    const blink = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(st.time * 4));
    txt(g, touchPrompts ? 'TAP TO START' : 'PRESS ENTER / START', cx, h * 0.7, 30 * k, C.value, { align: 'center', alpha: blink, tracking: 0.15, glow: 0.3 });
  } else {
    const items = st.items ?? ['CAMPAIGN', 'CARAVAN', 'SETTINGS'];
    menu(g, cx, h * 0.56, items, st.selected, k, st.time, st.tags);
    txt(g, '[ENTER] / START  SELECT    [ESC]  BACK', cx, h * 0.56 + items.length * 58 * k + 30 * k, 14 * k, C.text, { align: 'center', alpha: 0.85 });
  }
  txt(g, st.version ?? 'V0.1', w - 30 * k, h - 30 * k, 13 * k, C.dim, { align: 'right', outline: undefined });
  g.restore();
}

/* ------------------------------- results -------------------------------- */

const RANK_COLOR: Record<Rank, string> = { S: palette.pickupGold, A: C.text, B: C.value, C: mix(C.value, C.dim, 0.5) };
const RANK_WORD: Record<Rank, string> = { S: 'SUPERB', A: 'SHARP', B: 'STEADY', C: 'SURVIVED' };

export function drawResults(g: CanvasRenderingContext2D, w: number, h: number, d: ResultsData): void {
  const k = h / 1080;
  g.save();
  dim(g, w, h, 0.72 * easeOut(d.t / 0.3));
  const pw = 1100 * k, ph = 600 * k;
  const px = (w - pw) / 2, py = (h - ph) / 2;
  const slide = (1 - easeOut(d.t / 0.35)) * 40 * k;
  g.translate(0, slide);
  panel(g, px, py, pw, ph, k);
  txt(g, 'SORTIE COMPLETE', px + 50 * k, py + 56 * k, 18 * k, C.text, { tracking: 0.2 });
  txt(g, d.stage, px + 50 * k, py + 108 * k, 48 * k, C.value, { weight: 1.15, glow: 0.3 });
  g.fillStyle = C.line;
  g.fillRect(px + 50 * k, py + 150 * k, 560 * k, 2 * k);
  const rows: [string, string][] = [
    ['SCORE', String(Math.round(d.score * easeOut((d.t - 0.3) / 0.8))).padStart(7, '0')],
    ['BEST CHAIN', String(d.bestChain)],
    ['SHIELD LEFT', `${Math.round(d.shieldLeft)}/${d.shieldMax ?? 100}`],
    ['TIME', fmtTime(d.timeS)],
  ];
  if (d.bonus !== undefined) rows.push(['STAGE BONUS', `+${d.bonus}`]);
  rows.forEach(([label, value], i) => {
    const a = easeOut((d.t - 0.25 - i * 0.12) / 0.25);
    if (a <= 0) return;
    const y = py + 200 * k + i * 62 * k;
    g.globalAlpha = a;
    txt(g, label, px + 50 * k + (1 - a) * 30 * k, y, 18 * k, C.text, { tracking: 0.1 });
    txt(g, value, px + 610 * k, y, 30 * k, C.value, { align: 'right' });
    g.fillStyle = withAlpha(C.line, 0.35);
    g.fillRect(px + 50 * k, y + 26 * k, 560 * k, 1 * k);
    g.globalAlpha = 1;
  });
  if (d.newBest && d.t > 1.0) {
    const bx = px + 50 * k, by = py + ph - 70 * k;
    plate(g, bx, by - 16 * k, 170 * k, 32 * k, 7 * k);
    g.fillStyle = C.text;
    g.fill();
    txt(g, 'NEW BEST', bx + 16 * k, by, 16 * k, C.backing, { outline: undefined });
  }
  // rank block, stamps in
  const rx = px + pw - 300 * k, ry = py + 90 * k, rs = 240 * k;
  plate(g, rx, ry, rs, rs * 1.45, 26 * k);
  g.fillStyle = withAlpha(palette.emblemBlack, 0.55);
  g.fill();
  g.strokeStyle = C.line;
  g.lineWidth = 2 * k;
  g.stroke();
  txt(g, 'RANK', rx + 24 * k, ry + 34 * k, 16 * k, C.text, { tracking: 0.2 });
  const st = (d.t - 1.1) / 0.35;
  if (st > 0) {
    const sc = 1.7 - 0.7 * easeOutBack(st);
    const col = RANK_COLOR[d.rank];
    g.globalAlpha = clamp01(st * 2);
    txt(g, d.rank, rx + rs / 2, ry + rs * 0.72, 190 * k * sc, col, { align: 'center', weight: 1.5, glow: 0.8 });
    txt(g, RANK_WORD[d.rank], rx + rs / 2, ry + rs * 1.28, 20 * k, col, { align: 'center', tracking: 0.25 });
    g.globalAlpha = 1;
  }
  txt(g, touchPrompts ? 'TAP TO CONTINUE' : '[ENTER] CONTINUE    [R] RETRY', px + pw - 40 * k, py + ph - 40 * k, 14 * k, C.text, { align: 'right' });
  g.restore();
}

/* -------------------------------- pause --------------------------------- */

export function drawPause(g: CanvasRenderingContext2D, w: number, h: number, d: PauseData): void {
  const k = h / 1080;
  g.save();
  dim(g, w, h, 0.6 * easeOut(d.t / 0.2));
  const pw = 620 * k, ph = 420 * k;
  const px = (w - pw) / 2, py = (h - ph) / 2;
  panel(g, px, py, pw, ph, k);
  txt(g, 'PAUSED', w / 2, py + 70 * k, 50 * k, C.value, { align: 'center', tracking: 0.3, weight: 1.2, glow: 0.3 });
  txt(g, `// HOLDING PATTERN${d.stage ? ` - ${d.stage}` : ''} //`, w / 2, py + 120 * k, 14 * k, C.text, { align: 'center', tracking: 0.1 });
  menu(g, w / 2, py + 190 * k, d.items ?? (touchPrompts ? ['TAP II TO RESUME'] : ['RESUME', 'RESTART STAGE', 'QUIT TO TITLE']), d.selected, k, d.t);
  g.restore();
}

/* ------------------------------ game over ------------------------------- */

export function drawGameOver(g: CanvasRenderingContext2D, w: number, h: number, d: GameOverData): void {
  const k = h / 1080;
  g.save();
  dim(g, w, h, 0.78 * easeOut(d.t / 0.25));
  // deterministic glitch bands (seeded by time slice, no Math.random)
  const slice = Math.floor(d.t * 12);
  for (let i = 0; i < 7; i++) {
    const hsh = hashString(`sl${slice}:${i}`);
    const y = (hsh % 1000) / 1000 * h;
    const bh = (2 + ((hsh >>> 10) % 14)) * k;
    g.fillStyle = withAlpha(i % 3 === 0 ? C.shield : palette.smokeLit, 0.05 + ((hsh >>> 20) % 10) / 120);
    g.fillRect(0, y, w, bh);
  }
  const cy = h * 0.42;
  const size = 96 * k;
  const jit = d.t < 0.6 ? (((hashString(`j${slice}`) % 21) - 10) * k) : 0;
  // chromatic split title
  txt(g, 'SIGNAL LOST', w / 2 - 4 * k + jit, cy, size, C.shield, { align: 'center', tracking: 0.18, weight: 1.3, alpha: 0.7, outline: undefined });
  txt(g, 'SIGNAL LOST', w / 2 + 4 * k - jit, cy, size, palette.playerShotHalo, { align: 'center', tracking: 0.18, weight: 1.3, alpha: 0.35, outline: undefined });
  txt(g, 'SIGNAL LOST', w / 2, cy, size, C.value, { align: 'center', tracking: 0.18, weight: 1.3, glow: 0.4 });
  // hazard-style rule
  const rw = 760 * k;
  g.fillStyle = C.shield;
  g.fillRect(w / 2 - rw / 2, cy + size * 0.5 + 24 * k, rw, 3 * k);
  const pr = Math.round(clamp01(d.progress ?? 0) * 100);
  txt(g, `KESTREL DOWN  //  ${d.stage}  //  ROUTE ${pr}%  //  SCORE ${String(Math.round(d.score)).padStart(7, '0')}`, w / 2, cy + size * 0.5 + 60 * k, 16 * k, C.text, { align: 'center', tracking: 0.05 });
  menu(g, w / 2, h * 0.64, d.items ?? ['RETRY', 'QUIT TO TITLE'], d.selected ?? 0, k, d.t);
  txt(g, touchPrompts ? 'TAP TO RETRY FROM ROUTE START' : '[ENTER] / START  RETRY FROM ROUTE START', w / 2, h * 0.64 + 150 * k, 14 * k, C.text, { align: 'center', alpha: 0.85 });
  g.restore();
}

/* ------------------------------ stage card ------------------------------ */

export function drawStageCard(g: CanvasRenderingContext2D, w: number, h: number, d: StageCardData): void {
  const k = h / 1080;
  const dur = d.duration ?? 3;
  const out = 1 - clamp01((d.t - (dur - 0.4)) / 0.4);
  if (out <= 0) return;
  g.save();
  g.globalAlpha = out;
  const cy = h * 0.4;
  // band backing + rules wiping in from the sides
  const wipe = easeOut(d.t / 0.4);
  const bandH = 170 * k;
  g.fillStyle = withAlpha(C.backing, 0.55);
  g.fillRect(w / 2 - (w / 2) * wipe, cy - bandH / 2, w * wipe, bandH);
  g.fillStyle = C.line;
  g.fillRect(w / 2 - (w * 0.45) * wipe, cy - bandH / 2, w * 0.9 * wipe, 2 * k);
  g.fillRect(w / 2 - (w * 0.45) * wipe, cy + bandH / 2 - 2 * k, w * 0.9 * wipe, 2 * k);
  // tick marks on the rules
  g.fillStyle = C.text;
  for (let i = -6; i <= 6; i++) g.fillRect(w / 2 + i * 60 * k * wipe - 1 * k, cy - bandH / 2 - 6 * k, 2 * k, 6 * k);
  // "STAGE 01" and the name typed in
  const label = `STAGE ${String(d.index).padStart(2, '0')}`;
  txt(g, label, w / 2, cy - 48 * k, 18 * k, C.text, { align: 'center', tracking: 0.4 });
  const n = Math.floor(clamp01((d.t - 0.25) / 0.5) * d.stage.length + 0.001);
  const shown = d.stage.slice(0, n);
  const size = 64 * k;
  const full = meas(d.stage, size, 0.2);
  txt(g, shown, w / 2 - full / 2, cy + 8 * k, size, C.value, { tracking: 0.2, weight: 1.2, glow: 0.35 });
  if (n < d.stage.length && Math.sin(d.t * 30) > 0) {
    g.fillStyle = C.text;
    g.fillRect(w / 2 - full / 2 + meas(shown + 'X', size, 0.2) - size * 0.55, cy + 8 * k - size / 2, size * 0.5, size);
  }
  if (d.subtitle) txt(g, d.subtitle, w / 2, cy + 62 * k, 16 * k, C.text, { align: 'center', tracking: 0.15, alpha: easeOut((d.t - 0.7) / 0.3) });
  // NEW UPGRADE chip
  if (d.upgrade && d.t > 0.8) {
    const p = easeOutBack((d.t - 0.8) / 0.3);
    const cyc = cy + bandH / 2 + 60 * k;
    const tag = 'NEW UPGRADE';
    const ts = 14 * k, ns = 22 * k;
    const tagW = meas(tag, ts) + 24 * k;
    const nameW = meas(d.upgrade.name, ns) + 40 * k;
    const cw = tagW + nameW;
    const chH = 46 * k;
    const cx0 = w / 2 - cw / 2;
    g.save();
    g.translate(w / 2, cyc);
    g.scale(p, p);
    g.translate(-w / 2, -cyc);
    plate(g, cx0, cyc - chH / 2, cw, chH, 10 * k);
    g.fillStyle = withAlpha(C.backing, 0.85);
    g.fill();
    g.strokeStyle = palette.pickupGold;
    g.lineWidth = 2 * k;
    g.stroke();
    plate(g, cx0, cyc - chH / 2, tagW, chH, 10 * k);
    g.fillStyle = palette.pickupGold;
    g.fill();
    txt(g, tag, cx0 + 12 * k, cyc, ts, C.backing, { outline: undefined });
    // diamond pickup icon (shape, not colour alone)
    const ix = cx0 + tagW + 20 * k;
    g.beginPath();
    g.moveTo(ix, cyc - 9 * k);
    g.lineTo(ix + 7 * k, cyc);
    g.lineTo(ix, cyc + 9 * k);
    g.lineTo(ix - 7 * k, cyc);
    g.closePath();
    g.fillStyle = palette.pickupCyan;
    g.fill();
    txt(g, d.upgrade.name, ix + 18 * k, cyc, ns, C.value);
    g.restore();
    if (d.upgrade.detail) txt(g, d.upgrade.detail, w / 2, cyc + chH / 2 + 22 * k, 14 * k, C.text, { align: 'center', alpha: easeOut((d.t - 1.1) / 0.3) });
  }
  g.restore();
}
