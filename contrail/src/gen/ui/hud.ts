/**
 * CONTRAIL perimeter HUD (Canvas 2D). Thin angular green bands at the top and
 * bottom, a right-edge speed ladder and a bottom-right pilot frame; the centre
 * and mid left/right stay open. Reticle (circle), lock brackets (red square
 * corners), hazard state (yellow/black stripes + warning line), combat text,
 * tutorial prompts.
 *
 * Contract:
 * - draw(g, w, h, state, dt) draws in CSS px in the context's CURRENT transform.
 *   The caller clears the canvas and sets g.setTransform(dpr, 0, 0, dpr, 0, 0).
 * - Everything scales with h / 1080; widths follow w. Colours: hud.colors /
 *   palette tokens only; layout: hud tokens.
 * - No per-frame allocations beyond short strings for changed numbers.
 * - Portrait: defaults to drawPilotPortrait (src/gen/entities/pilot.ts). Any
 *   PortraitDrawer is called with g translated to the frame's top-left and
 *   clipped to it; (w, h) = frame size in px. Pass 'placeholder' to use the
 *   built-in visored-helmet silhouette (drawHelmetPlaceholder).
 */
import { hud, palette } from '../../style/tokens';
import { mix, withAlpha } from '../../style/color';
import { drawText, measureText, GLYPH_STYLES, type GlyphStyle, type TextOpts } from './font';
import { drawPilotPortrait } from '../entities/pilot';

/* ------------------------------- state ---------------------------------- */

export interface HudTarget {
  /** screen position, CSS px */
  x: number;
  y: number;
  /** on-screen diameter, CSS px */
  size: number;
  locked: boolean;
  /** missiles assigned to this target (drawn beside the bracket when > 0) */
  lockCount: number;
  /** 0..1 health for the slim sliver (bosses and large enemies) */
  hp01?: number;
  boss?: boolean;
}
export interface HudSpecial {
  name: string;
  ready: boolean;
  /** 0..1 */
  charge: number;
}
export interface HudCombatLine {
  text: string;
  /** hot = red (threat/damage/big hit), good = green (chain, parry, refill) */
  kind: 'hot' | 'good';
  /** seconds since the line appeared */
  age: number;
}
export interface HudPrompt {
  text: string;
  /** key or button label drawn in a key cap, e.g. "K" or "RMB" */
  key?: string;
}
export interface HudState {
  score: number;
  /** 0..1 along the stage rail */
  progress: number;
  stage: string;
  weapon: string;
  missiles: number;
  missilesMax: number;
  /** current lock count (lock-on sweep) */
  locks: number;
  specials: HudSpecial[];
  rolls: number;
  rollsMax: number;
  /** 0..1 recharge of the next roll charge (optional) */
  rollRecharge?: number;
  combo: { chain: number; timer: number; refill: boolean; multiplier: number };
  shield: number;
  shieldMax: number;
  /** reticle centre, CSS px */
  reticle: { x: number; y: number };
  lockMode: boolean;
  targets: HudTarget[];
  enemyInfo: { label: string; hp01: number } | null;
  /** t = seconds since the hazard started (drives the wipe-in) */
  hazard: { on: boolean; text: string; t: number };
  /** 0..1 (pilot frame turns red, shield bar flashes) */
  danger: number;
  combatText: HudCombatLine[];
  /** 0..1 position of the right-edge speed ladder marker */
  speed: number;
  prompts: HudPrompt[];
  paused: boolean;
  /** seconds, drives animation */
  time: number;
  /**
   * 0..1 brightness of the sky behind the bands (0 = space, 1 = near-white cloud).
   * Drives the adaptive band scrim; omit to assume bright (safe default).
   */
  skyLuma?: number;
}

/** A neutral starting state (the Integrator mutates it each frame). */
export function createHudState(): HudState {
  return {
    score: 0,
    progress: 0,
    stage: 'CLOUDGATE',
    weapon: 'RIVETER',
    missiles: 6,
    missilesMax: 6,
    locks: 0,
    specials: [
      { name: 'DRIFT', ready: true, charge: 1 },
      { name: 'WING', ready: false, charge: 0 },
    ],
    rolls: 3,
    rollsMax: 3,
    rollRecharge: 0,
    combo: { chain: 0, timer: 0, refill: false, multiplier: 1 },
    shield: 100,
    shieldMax: 100,
    reticle: { x: 960, y: 540 },
    lockMode: false,
    targets: [],
    enemyInfo: null,
    hazard: { on: false, text: '', t: 0 },
    danger: 0,
    combatText: [],
    speed: 0.5,
    prompts: [],
    paused: false,
    time: 0,
  };
}

/* ------------------------------ variants -------------------------------- */

export interface HudVariant {
  id: string;
  /** multiplier on hud.lineWidth */
  lineMul: number;
  /** band backing alpha (token default hud.backingAlpha) */
  backingAlpha: number;
  /** corner chamfer of band cells and chips, px at 1080p */
  chamfer: number;
  /** glyph face */
  glyph: GlyphStyle;
  /** alpha of the dark under-stroke behind text and reticle (legibility over clouds) */
  outlineAlpha: number;
  /** multiplier on the text outline width */
  outlineMul: number;
  /** band scrim alpha at the screen edge (gradient to backingAlpha at the inner edge) */
  scrimEdge: number;
  /** extra scrim alpha added over a bright sky (x skyLuma) */
  scrimAdapt: number;
}

export type HudVariantId = 'A' | 'B' | 'C';

export const HUD_VARIANTS: Record<HudVariantId, HudVariant> = {
  /** A: token weights, slight lean, medium bevels */
  A: { id: 'A', lineMul: 1, backingAlpha: hud.backingAlpha, chamfer: 14, glyph: GLYPH_STYLES.A, outlineAlpha: 0.75, outlineMul: 1, scrimEdge: 0.45, scrimAdapt: 0.15 },
  /** B: hairline, lighter backing, upright glyphs, small bevels */
  B: { id: 'B', lineMul: 0.75, backingAlpha: 0.2, chamfer: 8, glyph: GLYPH_STYLES.B, outlineAlpha: 0.65, outlineMul: 1, scrimEdge: 0.35, scrimAdapt: 0.15 },
  /** C: heavier lines, denser backing, strong lean, big bevels */
  C: { id: 'C', lineMul: 1.35, backingAlpha: 0.4, chamfer: 22, glyph: GLYPH_STYLES.C, outlineAlpha: 0.85, outlineMul: 1.4, scrimEdge: 0.62, scrimAdapt: 0.18 },
};

export type PortraitDrawer = (g: CanvasRenderingContext2D, w: number, h: number, o: { danger: number; time: number }) => void;

/** Screen rectangles of the HUD parts (CSS px), for tests and layout checks. */
export interface HudLayout {
  topBand: { y0: number; y1: number };
  bottomBand: { y0: number; y1: number };
  ladder: { x: number; y0: number; y1: number };
  pilot: { x: number; y: number; w: number; h: number };
  /** smallest text cap height used, px */
  minText: number;
}

/* ------------------------------- helpers -------------------------------- */

const TAU = Math.PI * 2;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const easeOutBack = (t: number) => {
  const c = 1.9;
  const x = clamp01(t) - 1;
  return 1 + (c + 1) * x * x * x + c * x * x;
};

/** Caches the string of the last number seen, so steady values allocate nothing. */
class NumStr {
  private last = NaN;
  private s = '';
  constructor(private fmt: (n: number) => string) {}
  get(n: number): string {
    if (n !== this.last) {
      this.last = n;
      this.s = this.fmt(n);
    }
    return this.s;
  }
}

function pathPoly(g: CanvasRenderingContext2D, p: number[]): void {
  g.beginPath();
  g.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
  g.closePath();
}

/** chamfered parallelogram chip (slant > 0 leans right) */
function chipPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, slant: number, ch: number): void {
  const c = Math.min(ch, h * 0.45);
  g.beginPath();
  g.moveTo(x + slant + c, y);
  g.lineTo(x + w + slant, y);
  g.lineTo(x + w, y + h - c);
  g.lineTo(x + w - c, y + h);
  g.lineTo(x, y + h);
  g.lineTo(x + slant, y + c * 0);
  g.closePath();
}

/* --------------------------------- Hud ---------------------------------- */

export class Hud {
  readonly variant: HudVariant;
  portrait: PortraitDrawer | null;

  // colours (precomputed strings)
  private readonly cBacking: string;
  private readonly cBackingStrong: string;
  private readonly cOutline: string;
  private readonly cDimFill: string;
  private readonly cLineSoft: string;
  private readonly cDanger: string[] = [];

  // smoothed display values
  private first = true;
  private dScore = 0;
  private dProgress = 0;
  private dShield = 0;
  private dShieldLag = 0;
  private lagHold = 0;
  private dCombo = 0;
  private lastShield = 0;

  // number strings
  private readonly sScore = new NumStr((n) => String(Math.max(0, Math.floor(n))).padStart(7, '0'));
  private readonly sPct = new NumStr((n) => `${n}%`);
  private readonly sMiss = new NumStr((n) => String(n));
  private readonly sMissMax = new NumStr((n) => `/${n}`);
  private readonly sChain = new NumStr((n) => String(n));
  private readonly sMult = new NumStr((n) => `x${(n / 10).toFixed(1)}`);
  private readonly sShield = new NumStr((n) => String(n));
  private readonly sShieldMax = new NumStr((n) => `/${n}`);
  private readonly sLocks = new NumStr((n) => `${n}`);
  private readonly sCharge = new NumStr((n) => `${n}%`);
  private readonly sContacts = new NumStr((n) => String(n).padStart(2, '0'));
  private readonly sTgtCount: NumStr[] = [];

  // layout cache
  private lw = -1;
  private lh = -1;
  private L = {
    k: 1, e: 0, m: 0, T: 0, B: 0, ch: 0, line: 1,
    top: [[], [], []] as number[][],
    bot: [[], [], []] as number[][],
    xL: 0, xC0: 0, xC1: 0, xR: 0, dxT: 0,
    xl: 0, xc0: 0, xc1: 0, xr: 0, dxB: 0, y0: 0, yb: 0, r1: 0, r2: 0,
    Ls: 0, Ms: 0, Vs: 0, Bs: 0,
    pf: { x: 0, y: 0, w: 0, h: 0 },
    ladX: 0, ladY0: 0, ladY1: 0,
  };
  private minText = Infinity;
  private scrimQ = -1;
  private gTop: CanvasGradient | null = null;
  private gBot: CanvasGradient | null = null;

  /** band scrim gradients, rebuilt only when the layout or the adapt level changes */
  private buildScrim(g: CanvasRenderingContext2D, adapt: number): void {
    const L = this.L;
    const inner = withAlpha(hud.colors.backing, Math.min(0.95, this.variant.backingAlpha + adapt));
    const edge = withAlpha(hud.colors.backing, Math.min(0.95, this.variant.scrimEdge + adapt));
    this.gTop = g.createLinearGradient(0, 0, 0, L.T);
    this.gTop.addColorStop(0, edge);
    this.gTop.addColorStop(1, inner);
    this.gBot = g.createLinearGradient(0, L.y0, 0, this.lh);
    this.gBot.addColorStop(0, inner);
    this.gBot.addColorStop(1, edge);
    this.scrimQ = Math.round(adapt * 50);
  }

  constructor(variant: HudVariant | HudVariantId = 'A', portrait: PortraitDrawer | 'placeholder' = drawPilotPortrait) {
    this.variant = typeof variant === 'string' ? HUD_VARIANTS[variant] : variant;
    this.portrait = portrait === 'placeholder' ? drawHelmetPlaceholder : portrait;
    const c = hud.colors;
    this.cBacking = withAlpha(c.backing, this.variant.backingAlpha);
    this.cBackingStrong = withAlpha(c.backing, Math.min(0.9, this.variant.backingAlpha + 0.5));
    this.cOutline = withAlpha(c.backing, this.variant.outlineAlpha);
    this.cDimFill = withAlpha(c.text, 0.28);
    this.cLineSoft = withAlpha(c.line, 0.55);
    for (let i = 0; i <= 16; i++) this.cDanger.push(mix(c.line, c.danger, i / 16));
    for (let i = 0; i < 12; i++) this.sTgtCount.push(new NumStr((n) => String(n)));
  }

  /** Jump smoothed values to the state (e.g. after a restart or for captures). */
  snap(s: HudState): void {
    this.dScore = s.score;
    this.dProgress = s.progress;
    this.dShield = this.dShieldLag = this.lastShield = s.shield;
    this.dCombo = s.combo.timer;
    this.first = false;
  }

  layout(w: number, h: number): HudLayout {
    this.ensureLayout(w, h);
    const L = this.L;
    return {
      topBand: { y0: 0, y1: L.T },
      bottomBand: { y0: L.y0, y1: h },
      ladder: { x: L.ladX, y0: L.ladY0, y1: L.ladY1 },
      pilot: { ...L.pf },
      minText: this.minText,
    };
  }

  private ensureLayout(w: number, h: number): void {
    if (w === this.lw && h === this.lh) return;
    this.scrimQ = -1;
    this.lw = w;
    this.lh = h;
    const L = this.L;
    const k = h / 1080;
    const ref = (16 / 9) * h; // width of a 16:9 frame of this height
    L.k = k;
    L.e = 8 * k;
    L.m = hud.sideMargin * w;
    L.T = hud.bandTop * h;
    L.B = hud.bandBottom * h;
    L.ch = this.variant.chamfer * k;
    L.line = hud.lineWidth * this.variant.lineMul * k;
    L.Ls = hud.glyphHeightLabel * h;
    L.Vs = hud.glyphHeightValue * h;
    L.Ms = 0.019 * h;
    L.Bs = 0.021 * h;
    const { e, T, ch } = L;
    const gap = 12 * k;
    // top band: cells hang from the top edge, wider on the inner edge (y = T)
    L.dxT = 0.6 * (T - e);
    L.xL = 0.305 * w;
    L.xC0 = L.xL + gap;
    L.xC1 = w - L.xL - gap;
    L.xR = w - L.xL;
    L.top[0] = [e, e, L.xL - L.dxT, e, L.xL, T, e + ch, T, e, T - ch];
    L.top[1] = [L.xC0 + L.dxT, e, L.xC1 - L.dxT, e, L.xC1, T, L.xC0, T];
    L.top[2] = [w - L.xL + L.dxT, e, w - e, e, w - e, T - ch, w - e - ch, T, w - L.xL, T];
    // bottom band: cells stand on the bottom edge, wider on the inner edge (y = y0)
    L.y0 = h - L.B;
    L.yb = h - e;
    L.dxB = 0.6 * (L.yb - L.y0);
    L.xl = 0.36 * w;
    L.xc0 = L.xl + gap;
    L.xr = 0.64 * w;
    L.xc1 = L.xr - gap;
    L.bot[0] = [e + ch, L.y0, L.xl, L.y0, L.xl - L.dxB, L.yb, e, L.yb, e, L.y0 + ch];
    L.bot[1] = [L.xc0, L.y0, L.xc1, L.y0, L.xc1 - L.dxB, L.yb, L.xc0 + L.dxB, L.yb];
    L.bot[2] = [L.xr, L.y0, w - e - ch, L.y0, w - e, L.y0 + ch, w - e, L.yb, L.xr + L.dxB, L.yb];
    L.r1 = L.y0 + 0.37 * L.B;
    L.r2 = L.y0 + 0.72 * L.B;
    // pilot frame: size from height (keeps aspect on any screen), right-anchored
    const pf = hud.pilotFrame;
    L.pf.w = pf.w * ref;
    L.pf.h = pf.h * h;
    L.pf.x = w - (1 - pf.x - pf.w) * ref - L.pf.w;
    L.pf.y = pf.y * h;
    L.ladX = w - (1 - hud.ladderX) * ref;
    L.ladY0 = hud.ladderTop * h;
    L.ladY1 = hud.ladderBottom * h;
  }

  /* text helper with variant face + legibility outline */
  private text(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, o?: Partial<TextOpts>): number {
    if (size < this.minText) this.minText = size;
    return drawText(g, s, x, y, size, {
      color,
      style: this.variant.glyph,
      outline: this.cOutline,
      outlineWidth: Math.max(1.5, Math.min(5, size * 0.08)) * this.variant.outlineMul,
      ...o,
    });
  }
  private measure(s: string, size: number): number {
    return measureText(s, size, { style: this.variant.glyph });
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, s: HudState, dt: number): void {
    this.ensureLayout(w, h);
    this.minText = Infinity;
    if (this.first) this.snap(s);
    this.animate(s, dt);
    g.save();
    g.lineCap = 'butt';
    g.lineJoin = 'miter';
    g.miterLimit = 4;
    this.drawBands(g, w, h, s);
    this.drawTop(g, w, s);
    this.drawBottom(g, w, h, s);
    this.drawLadder(g, s);
    this.drawPilot(g, s);
    if (s.hazard.on) this.drawHazard(g, w, s);
    if (!s.paused) {
      this.drawTargets(g, s);
      this.drawReticle(g, s);
      this.drawCombatText(g, s);
      this.drawPrompts(g, w, s);
    }
    g.restore();
  }

  private animate(s: HudState, dt: number): void {
    const a = (rate: number) => 1 - Math.exp(-dt * rate);
    // score counts up quickly but never lags more than ~0.4 s
    this.dScore += (s.score - this.dScore) * a(9);
    if (Math.abs(s.score - this.dScore) < 1) this.dScore = s.score;
    this.dProgress += (s.progress - this.dProgress) * a(6);
    this.dShield += (s.shield - this.dShield) * a(14);
    // damage lag: hold briefly, then drain (reads as "this much was lost")
    if (s.shield < this.lastShield) this.lagHold = 0.45;
    this.lastShield = s.shield;
    if (this.lagHold > 0) this.lagHold -= dt;
    else this.dShieldLag += (s.shield - this.dShieldLag) * a(4);
    if (this.dShieldLag < s.shield) this.dShieldLag = s.shield;
    this.dCombo += (s.combo.timer - this.dCombo) * a(18);
  }

  /* --------------------------- bands (frames) --------------------------- */

  private drawBands(g: CanvasRenderingContext2D, w: number, h: number, s: HudState): void {
    const L = this.L;
    const c = hud.colors;
    const lineCol = s.hazard.on ? c.hazard : c.line;
    // adaptive scrim: darker toward the screen edge, stronger over a bright sky
    const adapt = this.variant.scrimAdapt * clamp01(s.skyLuma ?? 1);
    const aq = Math.round(adapt * 50);
    if (aq !== this.scrimQ || !this.gTop || !this.gBot) this.buildScrim(g, aq / 50);
    for (let i = 0; i < 3; i++) {
      pathPoly(g, L.top[i]);
      g.fillStyle = this.gTop!;
      g.fill();
      g.strokeStyle = lineCol;
      g.lineWidth = L.line;
      g.stroke();
      pathPoly(g, L.bot[i]);
      g.fillStyle = this.gBot!;
      g.fill();
      g.strokeStyle = c.line;
      g.stroke();
    }
    // inner accent rails (double-line detail along the inner edges)
    const k = L.k;
    g.strokeStyle = s.hazard.on ? withAlpha(c.hazard, 0.6) : this.cLineSoft;
    g.lineWidth = Math.max(1, L.line * 0.6);
    g.beginPath();
    const ri = 5 * k;
    g.moveTo(L.e + L.ch + 30 * k, L.T - ri);
    g.lineTo(L.e + L.ch + 30 * k + 0.12 * w, L.T - ri);
    g.moveTo(w - L.e - L.ch - 30 * k, L.T - ri);
    g.lineTo(w - L.e - L.ch - 30 * k - 0.12 * w, L.T - ri);
    g.moveTo(L.xc0 + 40 * k, L.y0 + ri);
    g.lineTo(L.xc0 + 40 * k + 0.07 * w, L.y0 + ri);
    g.moveTo(L.xc1 - 40 * k, L.y0 + ri);
    g.lineTo(L.xc1 - 40 * k - 0.07 * w, L.y0 + ri);
    g.stroke();
    // index squares at the inner corners of each gap
    g.fillStyle = lineCol;
    const q = 4 * k;
    g.fillRect(L.xL - q * 0.5, L.T - q * 0.5, q, q);
    g.fillRect(L.xC1 - q * 0.5, L.T - q * 0.5, q, q);
    g.fillStyle = c.line;
    g.fillRect(L.xl - q * 0.5, L.y0 - q * 0.5, q, q);
    g.fillRect(L.xr - q * 0.5, L.y0 - q * 0.5, q, q);
  }

  /** small label plate sitting on a band's inner border line */
  private tag(g: CanvasRenderingContext2D, x: number, y: number, label: string, align: 'left' | 'right' | 'center', col: string = hud.colors.text, border: string = hud.colors.line): void {
    const L = this.L;
    const size = L.Ls;
    const tw = this.measure(label, size);
    const padX = 8 * L.k;
    const ph = size + 8 * L.k;
    const pw = tw + padX * 2;
    const x0 = align === 'left' ? x : align === 'right' ? x - pw : x - pw * 0.5;
    chipPath(g, x0, y - ph * 0.5, pw, ph, 0, 5 * L.k);
    g.fillStyle = this.cBackingStrong;
    g.fill();
    g.strokeStyle = border;
    g.lineWidth = Math.max(1, L.line * 0.75);
    g.stroke();
    this.text(g, label, x0 + padX, y, size, col, { outline: undefined });
  }

  /* ------------------------------ top band ------------------------------ */

  private drawTop(g: CanvasRenderingContext2D, w: number, s: HudState): void {
    const L = this.L;
    const c = hud.colors;
    const k = L.k;
    const cy = (L.e + L.T) * 0.5 + 1 * k;
    // left: score
    let x = L.e + L.m + 18 * k;
    x += this.text(g, 'SCORE', x, cy, L.Ls, c.text) + 16 * k;
    const sc = this.sScore.get(Math.round(this.dScore));
    // leading zeros dimmed, significant digits bright
    let lead = 0;
    while (lead < sc.length - 1 && sc.charCodeAt(lead) === 48) lead++;
    const adv = this.measure('00', L.Vs) - this.measure('0', L.Vs);
    for (let i = 0; i < sc.length; i++) {
      this.text(g, sc[i], x + i * adv, cy, L.Vs, i < lead ? c.dim : c.value, { outline: i < lead ? undefined : this.cOutline });
    }
    this.tag(g, L.e + L.ch + 22 * k, L.T, 'SYS.STAT', 'left');

    // centre: route progress
    const pw = 0.19 * w;
    const labelW = this.measure('ROUTE', L.Ls);
    const pctW = this.measure('100%', L.Ms);
    const total = labelW + 16 * k + pw + 14 * k + pctW;
    let px = w * 0.5 - total * 0.5;
    this.text(g, 'ROUTE', px, cy, L.Ls, c.text);
    px += labelW + 16 * k;
    const bh = 14 * k;
    const by = cy - bh * 0.5;
    chipPath(g, px, by, pw, bh, 0, 5 * k);
    g.fillStyle = this.cBackingStrong;
    g.fill();
    const p = clamp01(this.dProgress);
    if (p > 0) {
      g.save();
      chipPath(g, px, by, pw, bh, 0, 5 * k);
      g.clip();
      g.fillStyle = c.text;
      g.fillRect(px, by, pw * p, bh);
      g.restore();
    }
    g.strokeStyle = c.line;
    g.lineWidth = L.line;
    chipPath(g, px, by, pw, bh, 0, 5 * k);
    g.stroke();
    // quarter ticks under the bar
    g.beginPath();
    for (let i = 1; i < 4; i++) {
      const tx = px + (pw * i) / 4;
      g.moveTo(tx, by + bh + 2 * k);
      g.lineTo(tx, by + bh + 7 * k);
    }
    g.strokeStyle = this.cLineSoft;
    g.lineWidth = Math.max(1, L.line * 0.6);
    g.stroke();
    this.text(g, this.sPct.get(Math.round(p * 100)), px + pw + 14 * k, cy, L.Ms, c.value);
    this.tag(g, w * 0.5, L.T, s.stage, 'center');

    // right: target data
    const xr0 = L.xR + 26 * k;
    const xr1 = w - L.e - L.m - 18 * k;
    if (s.enemyInfo) {
      let tx = xr0;
      tx += this.text(g, 'TGT', tx, cy, L.Ls, c.text) + 14 * k;
      this.text(g, s.enemyInfo.label, tx, cy, L.Ms, c.value);
      // segmented hp bar, right aligned
      const hw = 0.1 * w, hh = 12 * k, hx = xr1 - hw, hy = cy - hh * 0.5;
      g.fillStyle = this.cBackingStrong;
      g.fillRect(hx, hy, hw, hh);
      const segs = 20;
      const filled = Math.ceil(clamp01(s.enemyInfo.hp01) * segs);
      g.fillStyle = c.lock;
      const sw = hw / segs;
      for (let i = 0; i < filled; i++) g.fillRect(hx + i * sw + 1 * k, hy + 2 * k, sw - 2 * k, hh - 4 * k);
      g.strokeStyle = c.line;
      g.lineWidth = Math.max(1, L.line * 0.75);
      g.strokeRect(hx, hy, hw, hh);
      this.text(g, 'HP', hx - 10 * k, cy, L.Ls, c.text, { align: 'right' });
    } else {
      let tx = xr0;
      tx += this.text(g, 'TGT', tx, cy, L.Ls, c.text) + 14 * k;
      this.text(g, 'SCANNING', tx, cy, L.Ls, c.text, { alpha: 0.55 + 0.25 * Math.sin(s.time * 4) });
      const nx = xr1;
      const cw = this.text(g, this.sContacts.get(s.targets.length), nx, cy, L.Ms, c.value, { align: 'right' });
      this.text(g, 'CONTACTS', nx - cw - 12 * k, cy, L.Ls, c.text, { align: 'right' });
    }
    this.tag(g, w - L.e - L.ch - 22 * k, L.T, 'TGT.DATA', 'right');
  }

  /* ----------------------------- bottom band ---------------------------- */

  private drawBottom(g: CanvasRenderingContext2D, w: number, h: number, s: HudState): void {
    const L = this.L;
    const c = hud.colors;
    const k = L.k;
    const x0 = L.e + L.m + 8 * k;

    // ---- left cell: arms ----
    this.tag(g, L.e + L.ch + 22 * k, L.y0, 'ARMS', 'left');
    // weapon icon: diamond sight with centre pip
    const ix = x0 + 10 * k, iy = L.r1, ir = 9 * k;
    g.beginPath();
    g.moveTo(ix, iy - ir);
    g.lineTo(ix + ir, iy);
    g.lineTo(ix, iy + ir);
    g.lineTo(ix - ir, iy);
    g.closePath();
    g.moveTo(ix - ir * 1.6, iy);
    g.lineTo(ix - ir * 0.55, iy);
    g.moveTo(ix + ir * 0.55, iy);
    g.lineTo(ix + ir * 1.6, iy);
    g.strokeStyle = c.text;
    g.lineWidth = L.line;
    g.stroke();
    g.fillStyle = c.value;
    g.fillRect(ix - 1.5 * k, iy - 1.5 * k, 3 * k, 3 * k);
    this.text(g, s.weapon, ix + 26 * k, L.r1, L.Bs, c.value);
    // missiles: rocket icon + count
    let mx = x0 + 0.125 * w;
    this.drawMissileIcon(g, mx, L.r1, L.Bs * 1.25, c.value);
    mx += 16 * k;
    mx += this.text(g, this.sMiss.get(s.missiles), mx, L.r1, L.Bs, s.missiles > 0 ? c.value : c.lock) + 6 * k;
    this.text(g, this.sMissMax.get(s.missilesMax), mx, L.r1 + (L.Bs - L.Ls) * 0.5, L.Ls, c.text);
    // lock pips (one per missile slot)
    let lx = x0 + 0.2 * w;
    lx += this.text(g, 'LOCK', lx, L.r1, L.Ls, c.text) + 12 * k;
    const n = Math.max(1, s.missilesMax);
    const pw = 11 * k, ph = 14 * k, pg = 5 * k;
    for (let i = 0; i < n; i++) {
      const px = lx + i * (pw + pg);
      chipPath(g, px, L.r1 - ph * 0.5, pw, ph, 3 * k, 0);
      if (i < s.locks) {
        g.fillStyle = c.lock;
        g.fill();
      } else if (i < s.missiles) {
        g.fillStyle = this.cBackingStrong;
        g.fill();
      }
      g.strokeStyle = i < s.missiles ? c.line : c.dim;
      g.lineWidth = Math.max(1, L.line * 0.75);
      g.stroke();
    }
    // specials chips
    let sx = x0;
    const chH = L.Ls + 10 * k;
    for (let i = 0; i < s.specials.length; i++) {
      const sp = s.specials[i];
      sx += this.drawSpecialChip(g, sx, L.r2, chH, sp, s.time) + 12 * k;
    }
    // roll charges: slanted pips with recharge fill on the next one
    sx += 8 * k;
    sx += this.text(g, 'ROLL', sx, L.r2, L.Ls, c.text) + 12 * k;
    const rw = 16 * k, rh = chH * 0.8;
    for (let i = 0; i < s.rollsMax; i++) {
      const rx = sx + i * (rw + 6 * k);
      chipPath(g, rx, L.r2 - rh * 0.5, rw, rh, 5 * k, 0);
      if (i < s.rolls) {
        g.fillStyle = c.text;
        g.fill();
      } else if (i === s.rolls && (s.rollRecharge ?? 0) > 0) {
        g.save();
        g.clip();
        g.fillStyle = this.cDimFill;
        const f = clamp01(s.rollRecharge ?? 0);
        g.fillRect(rx, L.r2 + rh * 0.5 - rh * f, rw + 6 * k, rh * f);
        g.restore();
        chipPath(g, rx, L.r2 - rh * 0.5, rw, rh, 5 * k, 0);
      }
      g.strokeStyle = i < s.rolls ? c.text : c.line;
      g.lineWidth = Math.max(1, L.line * 0.75);
      g.stroke();
    }

    // ---- centre cell: chain ----
    const cx0 = L.xc0 + 0.37 * L.dxB + L.m;
    const cx1 = L.xc1 - 0.37 * L.dxB - L.m;
    this.tag(g, (L.xc0 + L.xc1) * 0.5, L.y0, 'STREAK', 'center');
    const chainActive = s.combo.chain > 0;
    let tx = cx0;
    tx += this.text(g, 'CHAIN', tx, L.r1, L.Ls, c.text) + 14 * k;
    this.text(g, this.sChain.get(s.combo.chain), tx, L.r1, L.Vs * 0.92, chainActive ? c.value : c.dim, { glow: chainActive ? 0.25 : 0 });
    this.text(g, this.sMult.get(Math.round(s.combo.multiplier * 10)), cx1, L.r1, L.Bs, chainActive ? c.text : c.dim, { align: 'right' });
    if (s.combo.refill) {
      // refill chip: shape + words + animated chevrons (not colour alone)
      const label = 'SHLD+';
      const tw = this.measure(label, L.Ls);
      const rw2 = tw + 20 * k;
      const rx = (cx0 + cx1) * 0.5 - rw2 * 0.5 + 30 * k;
      chipPath(g, rx, L.r1 - (L.Ls + 8 * k) * 0.5, rw2, L.Ls + 8 * k, 4 * k, 4 * k);
      g.fillStyle = c.text;
      g.fill();
      this.text(g, label, rx + 12 * k, L.r1, L.Ls, c.backing, { outline: undefined });
    }
    // timer bar
    const bx = L.xc0 + 0.72 * L.dxB + L.m * 0.5;
    const bw = L.xc1 - 0.72 * L.dxB - L.m * 0.5 - bx;
    const bh = 12 * k, by = L.r2 - bh * 0.5;
    chipPath(g, bx, by, bw, bh, 0, 4 * k);
    g.fillStyle = this.cBackingStrong;
    g.fill();
    const tf = clamp01(this.dCombo);
    if (tf > 0) {
      g.save();
      chipPath(g, bx, by, bw, bh, 0, 4 * k);
      g.clip();
      g.fillStyle = tf < 0.25 ? mix(c.text, c.hazard, 0.6) : c.text;
      g.fillRect(bx, by, bw * tf, bh);
      if (s.combo.refill) {
        // chevrons marching right through the fill
        g.strokeStyle = c.backing;
        g.lineWidth = 2 * k;
        const period = 18 * k;
        const off = (s.time * 60 * k) % period;
        g.beginPath();
        for (let xx = bx - period + off; xx < bx + bw * tf; xx += period) {
          g.moveTo(xx, by + 2 * k);
          g.lineTo(xx + 5 * k, by + bh * 0.5);
          g.lineTo(xx, by + bh - 2 * k);
        }
        g.stroke();
      }
      g.restore();
    }
    chipPath(g, bx, by, bw, bh, 0, 4 * k);
    g.strokeStyle = c.line;
    g.lineWidth = L.line;
    g.stroke();

    // ---- right cell: hull / shield ----
    this.tag(g, w - L.e - L.ch - 22 * k, L.y0, 'HULL', 'right');
    const hx0 = L.xr + 0.37 * L.dxB + L.m;
    const hx1 = w - L.e - L.m - 8 * k;
    const sh = clamp01(s.shield / Math.max(1, s.shieldMax));
    const low = sh < 0.25;
    const blink = low ? 0.5 + 0.5 * Math.sin(s.time * 12) : 1;
    this.drawCraftIcon(g, hx0 + 12 * k, L.r1, 13 * k, c.text);
    this.text(g, 'SHLD', hx0 + 34 * k, L.r1, L.Ls, low ? c.shield : c.text);
    const mw = this.text(g, this.sShieldMax.get(s.shieldMax), hx1, L.r1 + (L.Bs - L.Ls) * 0.5, L.Ls, c.text, { align: 'right' });
    this.text(g, this.sShield.get(Math.max(0, Math.ceil(s.shield))), hx1 - mw - 6 * k, L.r1, L.Vs * 0.92, low ? c.shield : c.value, {
      align: 'right',
      alpha: low ? 0.55 + 0.45 * blink : 1,
    });
    if (low) this.text(g, 'LOW', hx0 + 34 * k + this.measure('SHLD', L.Ls) + 14 * k, L.r1, L.Ls, c.shield, { alpha: blink });
    const sbx = L.xr + 0.72 * L.dxB + L.m * 0.5;
    const sbw = hx1 - sbx;
    const sbh = 14 * k, sby = L.r2 - sbh * 0.5;
    g.fillStyle = this.cBackingStrong;
    g.fillRect(sbx, sby, sbw, sbh);
    const lag = clamp01(this.dShieldLag / Math.max(1, s.shieldMax));
    const cur = clamp01(this.dShield / Math.max(1, s.shieldMax));
    if (lag > cur) {
      g.fillStyle = c.value;
      g.globalAlpha = 0.75;
      g.fillRect(sbx + sbw * cur, sby, sbw * (lag - cur), sbh);
      g.globalAlpha = 1;
    }
    g.fillStyle = c.shield;
    g.globalAlpha = low ? 0.6 + 0.4 * blink : 1;
    g.fillRect(sbx, sby, sbw * cur, sbh);
    g.globalAlpha = 1;
    // 10% segment notches
    g.strokeStyle = c.backing;
    g.lineWidth = Math.max(1, 2 * k);
    g.beginPath();
    for (let i = 1; i < 10; i++) {
      const nx = sbx + (sbw * i) / 10;
      g.moveTo(nx, sby);
      g.lineTo(nx, sby + sbh);
    }
    g.stroke();
    g.strokeStyle = low ? c.shield : c.line;
    g.lineWidth = L.line;
    g.strokeRect(sbx, sby, sbw, sbh);
  }

  private drawSpecialChip(g: CanvasRenderingContext2D, x: number, cy: number, h: number, sp: HudSpecial, time: number): number {
    const L = this.L;
    const c = hud.colors;
    const k = L.k;
    const state = sp.ready ? 'READY' : 'CHARGING';
    const nameW = this.measure(sp.name, L.Ls);
    const stW = this.measure(state, L.Ls);
    const pad = 9 * k;
    const w = pad + nameW + 12 * k + stW + pad + 4 * k;
    const y = cy - h * 0.5;
    const sl = 5 * k;
    chipPath(g, x, y, w, h, sl, 4 * k);
    if (sp.ready) {
      g.fillStyle = c.text;
      g.fill();
    } else {
      g.fillStyle = this.cBackingStrong;
      g.fill();
      g.save();
      chipPath(g, x, y, w, h, sl, 4 * k);
      g.clip();
      g.fillStyle = this.cDimFill;
      g.fillRect(x, y, (w + sl) * clamp01(sp.charge), h);
      g.restore();
      chipPath(g, x, y, w, h, sl, 4 * k);
    }
    g.strokeStyle = sp.ready ? c.value : c.line;
    g.lineWidth = Math.max(1, L.line * 0.8);
    g.stroke();
    const tx = x + pad + sl * 0.5;
    this.text(g, sp.name, tx, cy, L.Ls, sp.ready ? c.backing : c.text, { outline: undefined });
    // divider tick
    g.beginPath();
    g.moveTo(tx + nameW + 6 * k + sl * 0.5, y + 3 * k);
    g.lineTo(tx + nameW + 6 * k - sl * 0.2, y + h - 3 * k);
    g.strokeStyle = sp.ready ? c.backing : c.line;
    g.lineWidth = Math.max(1, k);
    g.stroke();
    const pulse = sp.ready ? 0.8 + 0.2 * Math.sin(time * 6) : 1;
    this.text(g, state, tx + nameW + 12 * k, cy, L.Ls, sp.ready ? c.backing : c.value, { outline: undefined, alpha: pulse });
    return w + sl;
  }

  private drawMissileIcon(g: CanvasRenderingContext2D, x: number, cy: number, hgt: number, col: string): void {
    const k = this.L.k;
    const hw = hgt * 0.16;
    const top = cy - hgt * 0.5, bot = cy + hgt * 0.5;
    g.beginPath();
    g.moveTo(x, top);
    g.lineTo(x + hw, top + hgt * 0.28);
    g.lineTo(x + hw, bot - hgt * 0.22);
    g.lineTo(x + hw * 2.1, bot);
    g.lineTo(x - hw * 2.1, bot);
    g.lineTo(x - hw, bot - hgt * 0.22);
    g.lineTo(x - hw, top + hgt * 0.28);
    g.closePath();
    g.fillStyle = col;
    g.fill();
    g.strokeStyle = this.cOutline;
    g.lineWidth = Math.max(1, 1.2 * k);
    g.stroke();
  }

  /** KESTREL delta icon (original, generic delta + canopy notch) */
  private drawCraftIcon(g: CanvasRenderingContext2D, x: number, cy: number, r: number, col: string): void {
    g.beginPath();
    g.moveTo(x, cy - r);
    g.lineTo(x + r * 0.95, cy + r * 0.7);
    g.lineTo(x + r * 0.3, cy + r * 0.45);
    g.lineTo(x, cy + r * 0.9);
    g.lineTo(x - r * 0.3, cy + r * 0.45);
    g.lineTo(x - r * 0.95, cy + r * 0.7);
    g.closePath();
    g.fillStyle = col;
    g.fill();
  }

  /* ------------------------------- ladder ------------------------------- */

  private drawLadder(g: CanvasRenderingContext2D, s: HudState): void {
    const L = this.L;
    const c = hud.colors;
    const k = L.k;
    const x = L.ladX, y0 = L.ladY0, y1 = L.ladY1;
    g.strokeStyle = this.cOutline;
    g.lineWidth = L.line + 2 * k;
    g.beginPath();
    g.moveTo(x, y0);
    g.lineTo(x, y1);
    g.stroke();
    g.strokeStyle = c.line;
    g.lineWidth = L.line;
    g.stroke();
    // ticks: 16 intervals, major every 4 (left side)
    g.beginPath();
    for (let i = 0; i <= 16; i++) {
      const y = y0 + ((y1 - y0) * i) / 16;
      const len = i % 4 === 0 ? 12 * k : 6 * k;
      g.moveTo(x - len, y);
      g.lineTo(x, y);
    }
    g.stroke();
    // end caps: small chevron brackets
    const cw = 7 * k;
    g.beginPath();
    g.moveTo(x - cw, y0 - cw);
    g.lineTo(x, y0);
    g.lineTo(x + cw, y0 - cw);
    g.moveTo(x - cw, y1 + cw);
    g.lineTo(x, y1);
    g.lineTo(x + cw, y1 + cw);
    g.stroke();
    this.text(g, 'SPD', x, y0 - 22 * k, L.Ls, c.text, { align: 'center' });
    // level fill on the right side + marker
    const my = y1 - (y1 - y0) * clamp01(s.speed);
    g.fillStyle = this.cDimFill;
    g.fillRect(x + 3 * k, my, 4 * k, y1 - my);
    const mw = 14 * k;
    g.beginPath();
    g.moveTo(x - 4 * k, my);
    g.lineTo(x - 4 * k - mw, my - mw * 0.55);
    g.lineTo(x - 4 * k - mw, my + mw * 0.55);
    g.closePath();
    g.fillStyle = c.value;
    g.fill();
    g.strokeStyle = this.cOutline;
    g.lineWidth = Math.max(1, k);
    g.stroke();
    g.fillStyle = c.value;
    g.fillRect(x - 2 * k, my - 1.5 * k, 12 * k, 3 * k);
  }

  /* ----------------------------- pilot frame ---------------------------- */

  private drawPilot(g: CanvasRenderingContext2D, s: HudState): void {
    const L = this.L;
    const c = hud.colors;
    const k = L.k;
    const { x, y, w, h } = L.pf;
    const d = clamp01(s.danger);
    const pulse = d > 0.5 ? 0.5 + 0.5 * Math.sin(s.time * 10) : 0;
    const border = this.cDanger[Math.round(clamp01(d + pulse * 0.2) * 16)];
    const ch = L.ch;
    const pts = [x + ch, y, x + w, y, x + w, y + h - ch, x + w - ch, y + h, x, y + h, x, y + ch];
    // portrait
    g.save();
    pathPoly(g, pts);
    g.clip();
    if (this.portrait) {
      g.translate(x, y);
      this.portrait(g, w, h, { danger: d, time: s.time });
    } else {
      g.translate(x, y);
      drawHelmetPlaceholder(g, w, h, { danger: d, time: s.time });
    }
    g.restore();
    pathPoly(g, pts);
    g.strokeStyle = this.cOutline;
    g.lineWidth = L.line * (1 + d) + 3 * k;
    g.stroke();
    g.strokeStyle = border;
    g.lineWidth = L.line * (1 + d);
    g.stroke();
    // corner brackets outside the frame (heavier as danger rises)
    const bl = 18 * k, o = 5 * k;
    g.beginPath();
    g.moveTo(x - o, y + bl);
    g.lineTo(x - o, y + ch - o * 0.4);
    g.lineTo(x + ch - o * 0.4, y - o);
    g.lineTo(x + bl + ch, y - o);
    g.moveTo(x + w + o, y + bl);
    g.lineTo(x + w + o, y - o);
    g.lineTo(x + w - bl, y - o);
    g.lineWidth = L.line;
    g.stroke();
    this.tag(g, x + ch + 10 * k, y, 'K-01', 'left', d > 0.5 ? c.danger : c.text, border);
    if (d > 0.5) this.tag(g, x + w - 10 * k, y + h, 'HULL CRIT', 'right', c.danger, border);
  }

  /* ------------------------------- hazard ------------------------------- */

  private drawHazard(g: CanvasRenderingContext2D, w: number, s: HudState): void {
    const L = this.L;
    const c = hud.colors;
    const k = L.k;
    const t = s.hazard.t;
    const reveal = easeOutCubic(t / 0.35);
    const half = (w * 0.5 - L.e) * reveal;
    const sy = L.T + (L.Ls + 8 * k) * 0.5 + 5 * k, sh = 16 * k;
    // yellow/black striped border strip under the top band (wipes out from the centre)
    g.save();
    g.beginPath();
    g.rect(w * 0.5 - half, sy, half * 2, sh);
    g.clip();
    g.fillStyle = c.hazardDark;
    g.fillRect(w * 0.5 - half, sy, half * 2, sh);
    g.fillStyle = c.hazard;
    const period = 24 * k;
    const off = (s.time * 50 * k) % period;
    g.beginPath();
    for (let x = w * 0.5 - half - period + off; x < w * 0.5 + half + period; x += period) {
      g.moveTo(x, sy + sh);
      g.lineTo(x + sh, sy);
      g.lineTo(x + sh + period * 0.5, sy);
      g.lineTo(x + period * 0.5, sy + sh);
      g.closePath();
    }
    g.fill();
    g.restore();
    // over-line on the top edge of the strip
    g.fillStyle = c.hazard;
    g.fillRect(w * 0.5 - half, sy - 2 * k, half * 2, 2 * k);
    // warning line: centred, blinking, on a dark plate with striped end caps
    if (t > 0.15 && s.hazard.text) {
      const size = 0.021 * this.lh;
      const tw = this.measure(s.hazard.text, size);
      const py = sy + sh + 30 * k;
      const ph = size + 14 * k;
      const pw = tw + 60 * k;
      const px = w * 0.5 - pw * 0.5;
      const a = smooth(0.15, 0.35, t);
      g.globalAlpha = a;
      chipPath(g, px, py - ph * 0.5, pw, ph, 0, 8 * k);
      g.fillStyle = this.cBackingStrong;
      g.fill();
      g.strokeStyle = c.hazard;
      g.lineWidth = L.line;
      g.stroke();
      g.fillStyle = c.hazard;
      for (let i = 0; i < 3; i++) {
        const ox = 8 * k + i * 7 * k;
        g.fillRect(px + ox, py - ph * 0.28, 3 * k, ph * 0.56);
        g.fillRect(px + pw - ox - 3 * k, py - ph * 0.28, 3 * k, ph * 0.56);
      }
      const blink = 0.7 + 0.3 * (Math.sin(s.time * 9) > -0.3 ? 1 : 0);
      this.text(g, s.hazard.text, w * 0.5, py, size, c.hazard, { align: 'center', alpha: blink, glow: 0.3 });
      g.globalAlpha = 1;
    }
  }

  /* --------------------------- reticle & locks -------------------------- */

  private drawReticle(g: CanvasRenderingContext2D, s: HudState): void {
    const L = this.L;
    const c = hud.colors;
    const k = L.k;
    const x = s.reticle.x, y = s.reticle.y;
    const R0 = hud.reticleRadius * this.lh;
    const lock = s.lockMode;
    const R = lock ? R0 * 1.1 : R0;
    const col = lock ? c.text : c.line;
    const lw = L.line * 1.1;
    const spin = lock ? s.time * 1.4 : 0;
    // build path once, stroke twice (dark under-stroke, then colour)
    g.beginPath();
    if (lock) {
      for (let i = 0; i < 4; i++) {
        const a0 = spin + (i * TAU) / 4 + 0.22;
        g.moveTo(x + Math.cos(a0) * R, y + Math.sin(a0) * R);
        g.arc(x, y, R, a0, a0 + TAU / 4 - 0.44);
      }
    } else {
      g.moveTo(x + R, y);
      g.arc(x, y, R, 0, TAU);
    }
    // ticks: 12 outside, 4 long at the cardinals (inward in lock mode)
    for (let i = 0; i < 12; i++) {
      const a = (i * TAU) / 12 + spin * 0.5;
      const major = i % 3 === 0;
      const r0 = lock && major ? R - 14 * k : R;
      const r1 = lock && major ? R - 2 * k : R + (major ? 14 * k : 7 * k);
      g.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
      g.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
    }
    // inner ring + centre cross with a gap
    const ri = R0 * 0.3;
    g.moveTo(x + ri, y);
    g.arc(x, y, ri, 0, TAU);
    const cg = 3 * k, cl = 8 * k;
    g.moveTo(x - cg - cl, y);
    g.lineTo(x - cg, y);
    g.moveTo(x + cg, y);
    g.lineTo(x + cg + cl, y);
    g.moveTo(x, y - cg - cl);
    g.lineTo(x, y - cg);
    g.moveTo(x, y + cg);
    g.lineTo(x, y + cg + cl);
    g.strokeStyle = this.cOutline;
    g.lineWidth = lw + 3 * k;
    g.stroke();
    g.strokeStyle = col;
    g.lineWidth = lw;
    g.stroke();
    if (lock) {
      // lock tally on the lower right of the ring
      const tx = x + R * 1.02, ty = y + R * 0.98;
      const tw = this.text(g, this.sLocks.get(s.locks), tx, ty, L.Ms, c.lock);
      this.text(g, this.sMissMax.get(s.missilesMax), tx + tw + 5 * k, ty + (L.Ms - L.Ls) * 0.5, L.Ls, c.value);
      this.text(g, 'LOCK', tx, ty - L.Ms - 2 * k, L.Ls, c.value);
    }
  }

  private drawTargets(g: CanvasRenderingContext2D, s: HudState): void {
    const L = this.L;
    const c = hud.colors;
    const k = L.k;
    const minHalf = hud.lockBracketSize * this.lh * 0.5;
    for (let i = 0; i < s.targets.length; i++) {
      const t = s.targets[i];
      const half = Math.max(minHalf, t.size * 0.5 + 6 * k);
      const showHp = t.hp01 !== undefined && (t.boss || t.size > 70 * k || t.locked);
      if (t.locked) {
        const breathe = 1 + 0.04 * Math.sin(s.time * 8 + i);
        const hb = half * breathe;
        const cl = Math.max(8 * k, hb * 0.38);
        g.beginPath();
        for (let q = 0; q < 4; q++) {
          const sx = q === 0 || q === 3 ? -1 : 1;
          const sy = q < 2 ? -1 : 1;
          const cx = t.x + sx * hb, cy = t.y + sy * hb;
          g.moveTo(cx - sx * cl, cy);
          g.lineTo(cx, cy);
          g.lineTo(cx, cy - sy * cl);
        }
        g.lineCap = 'square';
        g.strokeStyle = this.cOutline;
        g.lineWidth = L.line * 1.4 + 3 * k;
        g.stroke();
        g.strokeStyle = c.lock;
        g.lineWidth = L.line * 1.4;
        g.stroke();
        g.lineCap = 'butt';
        // centre pip
        g.fillStyle = c.lock;
        g.fillRect(t.x - 2 * k, t.y - 2 * k, 4 * k, 4 * k);
        if (t.lockCount > 0) {
          const str = i < this.sTgtCount.length ? this.sTgtCount[i].get(t.lockCount) : String(t.lockCount);
          this.text(g, str, t.x + hb + 6 * k, t.y - hb + L.Ms * 0.5, L.Ms, c.lock, { outline: this.cOutline });
        }
      } else {
        // contact marker (always, faint) / lockable hint (brighter in lock mode):
        // tiny open corner dots, a different shape from lock brackets
        g.fillStyle = c.lock;
        g.globalAlpha = s.lockMode ? 0.7 : 0.35;
        const d = half * 0.7, q = 3 * k;
        g.fillRect(t.x - d - q, t.y - d - q, q * 2, q * 2);
        g.fillRect(t.x + d - q, t.y - d - q, q * 2, q * 2);
        g.fillRect(t.x - d - q, t.y + d - q, q * 2, q * 2);
        g.fillRect(t.x + d - q, t.y + d - q, q * 2, q * 2);
        g.globalAlpha = 1;
      }
      if (showHp) {
        const sw = half * 2, sh = (t.boss ? 6 : 4) * k;
        const sx = t.x - half, sy = t.y + half + 7 * k;
        g.fillStyle = this.cBackingStrong;
        g.fillRect(sx - 1 * k, sy - 1 * k, sw + 2 * k, sh + 2 * k);
        g.fillStyle = c.lock;
        g.fillRect(sx, sy, sw * clamp01(t.hp01 ?? 0), sh);
        if (t.boss) {
          g.strokeStyle = c.line;
          g.lineWidth = Math.max(1, k);
          g.strokeRect(sx - 1 * k, sy - 1 * k, sw + 2 * k, sh + 2 * k);
        }
      }
    }
  }

  /* ----------------------- combat text & prompts ------------------------ */

  private drawCombatText(g: CanvasRenderingContext2D, s: HudState): void {
    const L = this.L;
    const c = hud.colors;
    const k = L.k;
    const size = 0.022 * this.lh;
    const x0 = L.e + L.m + 10 * k;
    let y = L.T + (s.hazard.on ? 0.1 : 0.065) * this.lh;
    const n = Math.min(5, s.combatText.length);
    for (let i = 0; i < n; i++) {
      const line = s.combatText[i];
      const a = 1 - smooth(1.3, 1.9, line.age);
      if (a <= 0) continue;
      const pop = easeOutBack(line.age / 0.18);
      const sz = size * (0.7 + 0.3 * pop);
      const dx = (1 - easeOutCubic(line.age / 0.2)) * -24 * k;
      this.text(g, line.text, x0 + dx, y, sz, line.kind === 'hot' ? c.lock : c.text, { alpha: a, weight: 1.15, glow: line.age < 0.3 ? 0.5 : 0 });
      y += size * 1.7;
    }
  }

  private drawPrompts(g: CanvasRenderingContext2D, w: number, s: HudState): void {
    const L = this.L;
    const c = hud.colors;
    const k = L.k;
    const size = 0.017 * this.lh;
    let y = L.y0 - 0.06 * this.lh;
    for (let i = s.prompts.length - 1; i >= 0; i--) {
      const p = s.prompts[i];
      const tw = this.measure(p.text, size);
      const kw = p.key ? this.measure(p.key, size) + 16 * k : 0;
      const total = tw + (p.key ? kw + 12 * k : 0);
      let x = w * 0.5 - total * 0.5;
      const ph = size + 16 * k;
      chipPath(g, x - 14 * k, y - ph * 0.5, total + 28 * k, ph, 0, 6 * k);
      g.fillStyle = this.cBackingStrong;
      g.fill();
      g.strokeStyle = this.cLineSoft;
      g.lineWidth = Math.max(1, L.line * 0.75);
      g.stroke();
      if (p.key) {
        const kh = size + 8 * k;
        g.strokeStyle = c.value;
        g.lineWidth = Math.max(1, L.line * 0.75);
        g.strokeRect(x, y - kh * 0.5, kw, kh);
        this.text(g, p.key, x + kw * 0.5, y, size, c.value, { align: 'center', outline: undefined });
        x += kw + 12 * k;
      }
      this.text(g, p.text, x, y, size, c.text, { outline: undefined });
      y -= ph + 8 * k;
    }
  }
}

/* --------------------- built-in portrait placeholder -------------------- */

/**
 * Visored-helmet silhouette (no face), drawn in local coords (0,0)-(w,h).
 * Used when no PortraitDrawer is supplied.
 */
export function drawHelmetPlaceholder(g: CanvasRenderingContext2D, w: number, h: number, o: { danger: number; time: number }): void {
  const p = palette;
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, p.spaceNebula);
  bg.addColorStop(1, p.spaceDeep);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const cx = w * 0.5;
  // shoulders + suit
  g.fillStyle = p.accentOrange;
  g.beginPath();
  g.moveTo(w * -0.05, h);
  g.lineTo(w * 0.1, h * 0.8);
  g.lineTo(w * 0.32, h * 0.72);
  g.lineTo(w * 0.68, h * 0.72);
  g.lineTo(w * 0.9, h * 0.8);
  g.lineTo(w * 1.05, h);
  g.closePath();
  g.fill();
  g.fillStyle = p.armourLight;
  g.fillRect(w * 0.12, h * 0.84, w * 0.2, h * 0.16);
  g.fillRect(w * 0.68, h * 0.84, w * 0.2, h * 0.16);
  g.fillStyle = p.armourDark;
  g.fillRect(w * 0.34, h * 0.7, w * 0.32, h * 0.1); // collar ring
  // helmet shell
  const hr = w * 0.33;
  const hy = h * 0.43;
  const shell = g.createLinearGradient(cx - hr, hy - hr, cx + hr, hy + hr);
  shell.addColorStop(0, p.armourLight);
  shell.addColorStop(0.65, p.armourSteel);
  shell.addColorStop(1, p.armourDark);
  g.fillStyle = shell;
  g.beginPath();
  g.moveTo(cx - hr, hy + hr * 0.7);
  g.lineTo(cx - hr, hy - hr * 0.35);
  g.lineTo(cx - hr * 0.6, hy - hr);
  g.lineTo(cx + hr * 0.6, hy - hr);
  g.lineTo(cx + hr, hy - hr * 0.35);
  g.lineTo(cx + hr, hy + hr * 0.7);
  g.lineTo(cx + hr * 0.55, hy + hr * 1.05);
  g.lineTo(cx - hr * 0.55, hy + hr * 1.05);
  g.closePath();
  g.fill();
  // crest stripe
  g.fillStyle = p.accentOrange;
  g.fillRect(cx - hr * 0.09, hy - hr, hr * 0.18, hr * 0.55);
  // visor: dark glass band with a cool sheen and a moving glint (no face)
  const vis = g.createLinearGradient(0, hy - hr * 0.3, 0, hy + hr * 0.5);
  vis.addColorStop(0, p.armourDark);
  vis.addColorStop(0.6, p.emblemBlack);
  vis.addColorStop(1, p.canopyBlue);
  g.fillStyle = vis;
  g.beginPath();
  g.moveTo(cx - hr * 0.85, hy - hr * 0.2);
  g.lineTo(cx + hr * 0.85, hy - hr * 0.2);
  g.lineTo(cx + hr * 0.8, hy + hr * 0.35);
  g.lineTo(cx + hr * 0.4, hy + hr * 0.6);
  g.lineTo(cx - hr * 0.4, hy + hr * 0.6);
  g.lineTo(cx - hr * 0.8, hy + hr * 0.35);
  g.closePath();
  g.fill();
  g.save();
  g.clip();
  const gx = cx - hr + ((o.time * 0.25) % 1) * hr * 3;
  g.fillStyle = withAlpha(p.hudValue, 0.35);
  g.beginPath();
  g.moveTo(gx, hy - hr * 0.3);
  g.lineTo(gx + hr * 0.2, hy - hr * 0.3);
  g.lineTo(gx - hr * 0.3, hy + hr * 0.7);
  g.lineTo(gx - hr * 0.5, hy + hr * 0.7);
  g.closePath();
  g.fill();
  // HUD reflection line in the visor
  g.fillStyle = withAlpha(p.hudText, 0.55);
  g.fillRect(cx - hr * 0.6, hy + hr * 0.05, hr * 0.5, Math.max(1, h * 0.008));
  g.restore();
  // scanlines
  g.fillStyle = withAlpha(p.spaceDeep, 0.22);
  for (let y = 0; y < h; y += 3) g.fillRect(0, y, w, 1);
  // danger tint
  if (o.danger > 0.02) {
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = withAlpha(p.shieldRed, Math.min(0.85, o.danger * 0.9));
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = withAlpha(p.shieldRed, 0.12 * o.danger * (0.6 + 0.4 * Math.sin(o.time * 10)));
    g.fillRect(0, 0, w, h);
  }
}
