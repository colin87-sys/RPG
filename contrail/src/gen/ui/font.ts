/**
 * CONTRAIL techno glyph set: an original, angular, monospaced stroke font drawn
 * with Canvas 2D paths (no font files, no bitmaps).
 *
 * Design: glyphs are polylines on a 4 x 6 unit grid (cap height = 6 units, y down,
 * baseline at y = 6). Corners marked in the table are cut at 45 degrees by a
 * parametric chamfer, so the same table yields a square, a lightly bevelled or a
 * heavily chamfered face. Strokes are continuous monolines with square caps and
 * mitred joins (not segmented display glyphs).
 *
 * Coverage: A-Z, 0-9, space and . : / - + % x > < [ ] ( ) ! ? plus \ = , ' # * _ |
 * Lower-case letters are drawn as capitals, except 'x', which is the small
 * multiplication sign (e.g. "x1.6").
 *
 * Units: `size` is the cap height in CSS px. drawText() returns the ink-box width
 * in px (glyph boxes, excluding the half stroke that overhangs each side).
 */

export interface GlyphStyle {
  /** stroke width as a fraction of the cap height */
  stroke: number;
  /** forward lean: horizontal shift per unit of height, pivoting on the text middle (0 = upright) */
  slant: number;
  /** 45-degree corner cut in glyph units (cap height = 6 units); 0 = square corners */
  chamfer: number;
  /** horizontal scale of the 4-unit glyph box */
  aspect: number;
  /** space between glyph boxes in glyph units */
  gap: number;
}

export type GlyphStyleId = 'A' | 'B' | 'C';

/** Three glyph faces used by HUD variants A/B/C (weight, slant, chamfer). */
export const GLYPH_STYLES: Record<GlyphStyleId, GlyphStyle> = {
  A: { stroke: 0.125, slant: 0.12, chamfer: 1.0, aspect: 0.9, gap: 1.8 },
  B: { stroke: 0.105, slant: 0.0, chamfer: 0.7, aspect: 0.88, gap: 1.8 },
  C: { stroke: 0.14, slant: 0.2, chamfer: 1.35, aspect: 0.94, gap: 1.75 },
};

export const DEFAULT_GLYPH_STYLE: GlyphStyle = GLYPH_STYLES.A;

export interface TextOpts {
  /** any CSS colour (normally a token or withAlpha(token, a)) */
  color: string;
  align?: 'left' | 'center' | 'right';
  /** stroke weight multiplier (1 = the style's weight) */
  weight?: number;
  /** soft halo in the text colour, 0..1 (0 = none) */
  glow?: number;
  /** extra space per glyph as a fraction of the cap height (may be negative) */
  tracking?: number;
  /** vertical anchor of y (default 'middle' = centre of the cap height) */
  valign?: 'top' | 'middle' | 'baseline';
  /** dark under-stroke for legibility over bright backgrounds (any CSS colour) */
  outline?: string;
  /** outline thickness in px on each side (default 0.08 x size, clamped to 1.5..4) */
  outlineWidth?: number;
  /** override the style's slant */
  slant?: number;
  /** glyph face (default DEFAULT_GLYPH_STYLE) */
  style?: GlyphStyle;
  /** alpha multiplier 0..1 (default 1) */
  alpha?: number;
}

/* ------------------------------------------------------------------------ */
/* Glyph table. Stroke strings: points "x,y" separated by spaces; a trailing */
/* 'c' chamfers that corner (x1), 'C' chamfers it harder (x1.6); a final 'z' */
/* closes the stroke; "d x,y" is a square dot. Strokes separated by '|'.     */
/* ------------------------------------------------------------------------ */
const TABLE: Record<string, string> = {
  A: '0,6 0,0c 4,0c 4,6|0,3.4 4,3.4',
  B: '0,0 3.2,0c 3.2,3 4,3 4,6c 0,6 z|0,3 3.2,3',
  C: '4,0 0,0c 0,6c 4,6',
  D: '0,0 4,0C 4,6C 0,6 z',
  E: '4,0 0,0 0,6 4,6|0,3 3.1,3',
  F: '4,0 0,0 0,6|0,3 3.1,3',
  G: '4,0 0,0c 0,6c 4,6c 4,3 2.2,3',
  H: '0,0 0,6|4,0 4,6|0,3 4,3',
  I: '1,0 3,0|2,0 2,6|1,6 3,6',
  J: '1.6,0 4,0 4,6c 0,6c 0,4.2',
  K: '0,0 0,6|4,0 1.6,3 0,3|1.6,3 4,6',
  L: '0,0 0,6 4,6',
  M: '0,6 0,0 2,2.6 4,0 4,6',
  N: '0,6 0,0 4,6 4,0',
  O: '0,0c 4,0c 4,6c 0,6c z',
  P: '0,6 0,0 4,0c 4,3.2c 0,3.2',
  Q: '0,0c 4,0c 4,6c 0,6c z|2.5,4.5 4.3,6.3',
  R: '0,6 0,0 4,0c 4,3c 0,3|1.8,3 4,5.2 4,6',
  S: '4,0 0,0c 0,3c 4,3c 4,6c 0,6',
  T: '0,0 4,0|2,0 2,6',
  U: '0,0 0,6c 4,6c 4,0',
  V: '0,0 0,3.6 2,6 4,3.6 4,0',
  W: '0,0 0,6 2,3.6 4,6 4,0',
  X: '0,0 0,1 4,5 4,6|4,0 4,1 0,5 0,6',
  Y: '0,0 0,1.8 2,3.4 4,1.8 4,0|2,3.4 2,6',
  Z: '0,0 4,0 4,1 0,5 0,6 4,6',
  '0': '0,0c 4,0c 4,6c 0,6c z|2.9,1.5 1.1,4.5',
  '1': '0.7,1.5 2.4,0 2.4,6',
  '2': '0,0 4,0c 4,3c 0,3c 0,6 4,6',
  '3': '0,0 4,0c 4,6c 0,6|1.2,3 4,3',
  '4': '3,6 3,0 0,4.2 4,4.2',
  '5': '4,0 0,0 0,2.8 4,2.8c 4,6c 0,6',
  '6': '4,0 0,0c 0,6c 4,6c 4,3c 0,3',
  '7': '0,0 4,0 4,1.4 1.6,6',
  '8': '0.4,3 0.4,0c 3.6,0c 3.6,3|0,3 4,3 4,6c 0,6c z',
  '9': '0,6 4,6c 4,0c 0,0c 0,3c 4,3',
  '.': 'd2,5.7',
  ':': 'd2,2.2|d2,5.7',
  '/': '0.4,6 3.6,0',
  '\\': '0.4,0 3.6,6',
  '-': '0.6,3.2 3.4,3.2',
  '+': '0.4,3.2 3.6,3.2|2,1.6 2,4.8',
  '=': '0.6,2.2 3.4,2.2|0.6,4.2 3.4,4.2',
  '%': '0,6 4,0|0,0 1.2,0 1.2,1.6 0,1.6 z|2.8,4.4 4,4.4 4,6 2.8,6 z',
  x: '1,3 3,5.4|3,3 1,5.4',
  '>': '1,0.8 3.2,3 1,5.2',
  '<': '3,0.8 0.8,3 3,5.2',
  '[': '2.8,-0.4 1.2,-0.4 1.2,6.4 2.8,6.4',
  ']': '1.2,-0.4 2.8,-0.4 2.8,6.4 1.2,6.4',
  '(': '2.8,-0.4 1.4,1 1.4,5 2.8,6.4',
  ')': '1.2,-0.4 2.6,1 2.6,5 1.2,6.4',
  '!': '2,0 2,4.2|d2,5.7',
  '?': '0,1.2 0,0 4,0c 4,2.8c 2,2.8 2,4.2|d2,5.7',
  ',': '2.3,5.2 2.3,6 1.5,7',
  "'": '2,0 2,1.6',
  '#': '1.2,0.6 1.2,5.4|2.8,0.6 2.8,5.4|0,2 4,2|0,4 4,4',
  '*': '2,1.2 2,4.8|0.5,2.1 3.5,3.9|3.5,2.1 0.5,3.9',
  _: '0,6.4 4,6.4',
  '|': '2,-0.4 2,6.4',
};
/** missing glyph: an outlined box, so gaps in coverage are visible in QA captures */
const TOFU = '0.4,0.4 3.6,0.4 3.6,5.6 0.4,5.6 z';

interface RawPoint {
  x: number;
  y: number;
  ch: number; // chamfer multiplier (0 = sharp)
}
interface RawStroke {
  pts: RawPoint[];
  closed: boolean;
  dot: boolean;
}

function parseGlyph(def: string): RawStroke[] {
  return def.split('|').map((s) => {
    const t = s.trim();
    if (t.startsWith('d')) {
      const [x, y] = t.slice(1).split(',').map(Number);
      return { pts: [{ x, y, ch: 0 }], closed: false, dot: true };
    }
    const toks = t.split(/\s+/);
    let closed = false;
    const pts: RawPoint[] = [];
    for (const tok of toks) {
      if (tok === 'z') {
        closed = true;
        continue;
      }
      let ch = 0;
      let body = tok;
      const last = tok[tok.length - 1];
      if (last === 'c') {
        ch = 1;
        body = tok.slice(0, -1);
      } else if (last === 'C') {
        ch = 1.6;
        body = tok.slice(0, -1);
      }
      const [x, y] = body.split(',').map(Number);
      pts.push({ x, y, ch });
    }
    return { pts, closed, dot: false };
  });
}

const RAW = new Map<number, RawStroke[]>();
for (const k of Object.keys(TABLE)) RAW.set(k.charCodeAt(0), parseGlyph(TABLE[k]));
const RAW_TOFU = parseGlyph(TOFU);

/** Compiled glyph for one (aspect, chamfer) pair: flat point lists in glyph units. */
interface CGlyph {
  strokes: Float32Array[];
  closed: boolean[];
  dots: Float32Array; // x, y pairs
}

function compileGlyph(raw: RawStroke[], aspect: number, chamfer: number): CGlyph {
  const strokes: Float32Array[] = [];
  const closed: boolean[] = [];
  const dots: number[] = [];
  for (const s of raw) {
    if (s.dot) {
      dots.push(s.pts[0].x * aspect, s.pts[0].y);
      continue;
    }
    const n = s.pts.length;
    const P = s.pts.map((p) => ({ x: p.x * aspect, y: p.y, ch: p.ch }));
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = P[i];
      const interior = s.closed || (i > 0 && i < n - 1);
      if (p.ch > 0 && chamfer > 0 && interior) {
        const a = P[(i - 1 + n) % n];
        const b = P[(i + 1) % n];
        const da = Math.hypot(a.x - p.x, a.y - p.y);
        const db = Math.hypot(b.x - p.x, b.y - p.y);
        // equal cut on both legs keeps the bevel at 45 degrees on right angles
        const cut = Math.min(chamfer * p.ch, 0.45 * da, 0.45 * db);
        out.push(p.x + ((a.x - p.x) / da) * cut, p.y + ((a.y - p.y) / da) * cut);
        out.push(p.x + ((b.x - p.x) / db) * cut, p.y + ((b.y - p.y) / db) * cut);
      } else {
        out.push(p.x, p.y);
      }
    }
    strokes.push(new Float32Array(out));
    closed.push(s.closed);
  }
  return { strokes, closed, dots: new Float32Array(dots) };
}

interface CFace {
  glyphs: (CGlyph | undefined)[]; // by char code 0..127
  tofu: CGlyph;
}
const faces = new Map<string, CFace>();

function face(st: GlyphStyle): CFace {
  const key = `${st.aspect}|${st.chamfer}`;
  let f = faces.get(key);
  if (!f) {
    const glyphs: (CGlyph | undefined)[] = new Array(128);
    RAW.forEach((raw, code) => {
      if (code < 128) glyphs[code] = compileGlyph(raw, st.aspect, st.chamfer);
    });
    f = { glyphs, tofu: compileGlyph(RAW_TOFU, st.aspect, st.chamfer) };
    faces.set(key, f);
  }
  return f;
}

function glyphFor(f: CFace, code: number): CGlyph | null {
  if (code === 32) return null; // space
  // lower-case letters draw as capitals, except 'x' (the multiplication sign)
  if (code >= 97 && code <= 122 && code !== 120) code -= 32;
  return (code < 128 ? f.glyphs[code] : undefined) ?? f.tofu;
}

/** Horizontal advance per glyph in px. */
export function glyphAdvance(size: number, style: GlyphStyle = DEFAULT_GLYPH_STYLE, tracking = 0): number {
  return (4 * style.aspect + style.gap) * (size / 6) + tracking * size;
}

/** Ink-box width of `text` in px (same number drawText returns). */
export function measureText(text: string, size: number, opts: Partial<TextOpts> = {}): number {
  const st = opts.style ?? DEFAULT_GLYPH_STYLE;
  const n = text.length;
  if (n === 0) return 0;
  return (n - 1) * glyphAdvance(size, st, opts.tracking ?? 0) + 4 * st.aspect * (size / 6);
}

/** Stroke width in px that drawText uses for a given size/weight. */
export function strokeWidthFor(size: number, style: GlyphStyle = DEFAULT_GLYPH_STYLE, weight = 1): number {
  return Math.max(0.9, size * style.stroke * weight);
}

/** Running statistics for QA boards (smallest cap height drawn since reset). */
export const fontStats = { minSize: Infinity, calls: 0 };
export function resetFontStats(): void {
  fontStats.minSize = Infinity;
  fontStats.calls = 0;
}

/**
 * Draw `text` with its anchor at (x, y). Returns the ink-box width in px.
 * y is the vertical middle of the capitals unless opts.valign says otherwise.
 */
export function drawText(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, opts: TextOpts): number {
  const n = text.length;
  const st = opts.style ?? DEFAULT_GLYPH_STYLE;
  const width = measureText(text, size, opts);
  if (n === 0 || size <= 0) return width;
  fontStats.calls++;
  if (size < fontStats.minSize) fontStats.minSize = size;

  const f = face(st);
  const u = size / 6;
  const adv = glyphAdvance(size, st, opts.tracking ?? 0);
  const slant = (opts.slant ?? st.slant) * u;
  const align = opts.align ?? 'left';
  const valign = opts.valign ?? 'middle';
  const top = valign === 'top' ? y : valign === 'baseline' ? y - size : y - size * 0.5;
  const midY = 3; // shear pivot in glyph units
  const lw = strokeWidthFor(size, st, opts.weight ?? 1);
  const dotHalf = (lw * 0.28) / u; // dot square half-size in glyph units (outer ~1.55 x stroke)
  let gx = align === 'center' ? x - width * 0.5 : align === 'right' ? x - width : x;

  g.beginPath();
  for (let i = 0; i < n; i++, gx += adv) {
    const gl = glyphFor(f, text.charCodeAt(i));
    if (!gl) continue;
    for (let s = 0; s < gl.strokes.length; s++) {
      const p = gl.strokes[s];
      for (let k = 0; k < p.length; k += 2) {
        const py = p[k + 1];
        const X = gx + p[k] * u + (midY - py) * slant;
        const Y = top + py * u;
        if (k === 0) g.moveTo(X, Y);
        else g.lineTo(X, Y);
      }
      if (gl.closed[s]) g.closePath();
    }
    const d = gl.dots;
    for (let k = 0; k < d.length; k += 2) {
      const cx = d[k], cy = d[k + 1];
      const x0 = cx - dotHalf, x1 = cx + dotHalf, y0 = cy - dotHalf, y1 = cy + dotHalf;
      g.moveTo(gx + x0 * u + (midY - y0) * slant, top + y0 * u);
      g.lineTo(gx + x1 * u + (midY - y0) * slant, top + y0 * u);
      g.lineTo(gx + x1 * u + (midY - y1) * slant, top + y1 * u);
      g.lineTo(gx + x0 * u + (midY - y1) * slant, top + y1 * u);
      g.closePath();
    }
  }

  const a0 = g.globalAlpha;
  const alpha = a0 * (opts.alpha ?? 1);
  g.lineCap = 'square';
  g.lineJoin = 'miter';
  g.miterLimit = 2.4;
  if (opts.outline) {
    const ow = opts.outlineWidth ?? Math.max(1.5, Math.min(4, size * 0.08));
    g.globalAlpha = alpha;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = opts.outline;
    g.lineWidth = lw + ow * 2;
    g.stroke();
    g.lineJoin = 'miter';
    g.lineCap = 'square';
  }
  g.strokeStyle = opts.color;
  const glow = opts.glow ?? 0;
  if (glow > 0) {
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.globalAlpha = alpha * 0.1 * Math.min(glow, 2);
    g.lineWidth = lw + size * 0.42 * glow;
    g.stroke();
    g.globalAlpha = alpha * 0.2 * Math.min(glow, 2);
    g.lineWidth = lw + size * 0.16 * glow;
    g.stroke();
    g.lineJoin = 'miter';
    g.lineCap = 'square';
  }
  g.globalAlpha = alpha;
  g.lineWidth = lw;
  g.stroke();
  g.globalAlpha = a0;
  return width;
}

/** The characters the table defines (for specimen boards and tests). */
export const GLYPH_SET = Object.keys(TABLE).join('');
