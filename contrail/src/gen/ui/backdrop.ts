/**
 * Stand-in 2D backdrops for HUD/menu look-dev and as a fallback behind menus:
 * a stage sky gradient with soft cloud blobs (Cloudgate), a dark space field
 * (Wreckfield) or a sunset band (Violet Tide). The real 3D sky is the world
 * lane's; these only give the HUD a realistic value range to be judged over.
 * Colours: tokens only. Randomness: seeded Rng.
 */
import { palette, stages, type StageId } from '../../style/tokens';
import { withAlpha, mix } from '../../style/color';
import { Rng } from '../../core/rng';

export interface BackdropOpts {
  seed?: number;
  /** 0..1 how much of the frame the near-white cloud masses cover (Cloudgate) */
  cloud?: number;
  /** force a large near-white cloud mass behind the top and bottom bands (legibility test) */
  brightBands?: boolean;
}

function blob(g: CanvasRenderingContext2D, x: number, y: number, r: number, core: string, edge: string, a: number): void {
  const gr = g.createRadialGradient(x, y - r * 0.25, r * 0.05, x, y, r);
  gr.addColorStop(0, withAlpha(core, a));
  gr.addColorStop(0.55, withAlpha(mix(core, edge, 0.35), a * 0.85));
  gr.addColorStop(1, withAlpha(edge, 0));
  g.fillStyle = gr;
  g.beginPath();
  g.ellipse(x, y, r * 1.35, r, 0, 0, Math.PI * 2);
  g.fill();
}

/** Draw a stage backdrop filling (0,0,w,h). */
export function drawBackdrop(g: CanvasRenderingContext2D, w: number, h: number, stage: StageId, o: BackdropOpts = {}): void {
  const rng = new Rng(o.seed ?? 7).fork(`backdrop-${stage}`);
  const sky = stages[stage].sky;
  const lin = g.createLinearGradient(0, 0, 0, h);
  if (stage === 'cloudgate') {
    lin.addColorStop(0, sky.zenith);
    lin.addColorStop(0.45, sky.mid);
    lin.addColorStop(0.78, sky.horizon);
    lin.addColorStop(1, palette.cloudSea);
  } else if (stage === 'violetTide') {
    lin.addColorStop(0, sky.zenith);
    lin.addColorStop(0.5, sky.mid);
    lin.addColorStop(0.66, palette.sunsetMagenta);
    lin.addColorStop(0.7, sky.horizon);
    lin.addColorStop(0.74, palette.sunsetCloudDark);
    lin.addColorStop(1, palette.sunsetIndigo);
  } else {
    lin.addColorStop(0, sky.zenith);
    lin.addColorStop(0.6, sky.mid);
    lin.addColorStop(1, sky.horizon);
  }
  g.fillStyle = lin;
  g.fillRect(0, 0, w, h);

  if (stage === 'cloudgate') {
    const amount = o.cloud ?? 0.55;
    // cloud sea band low in the frame
    for (let i = 0; i < 26; i++) {
      const x = rng.range(-0.1, 1.1) * w;
      const y = h * rng.range(0.72, 0.98);
      blob(g, x, y, h * rng.range(0.08, 0.18), palette.cloudCream, palette.cloudMid, 0.9);
    }
    // cumulus masses: shadow first, then lit tops
    const n = Math.round(6 + amount * 14);
    for (let i = 0; i < n; i++) {
      const x = rng.range(-0.05, 1.05) * w;
      const y = h * rng.range(0.25, 0.7);
      const r = h * rng.range(0.05, 0.12) * (0.6 + amount);
      blob(g, x + r * 0.2, y + r * 0.35, r * 1.05, palette.cloudShadow, palette.skyHorizon, 0.55);
      blob(g, x, y, r, palette.cloudCream, palette.cloudMid, 0.95);
    }
    if (o.brightBands) {
      // near-white masses right behind the HUD bands (worst case for legibility)
      for (let i = 0; i < 9; i++) blob(g, (i / 8) * w, h * 0.02, h * 0.16, palette.cloudCream, palette.cloudMid, 1);
      for (let i = 0; i < 9; i++) blob(g, (i / 8) * w, h * 1.0, h * 0.2, palette.cloudCream, palette.cloudMid, 1);
    }
    // sun glare high-left (key light side)
    const sg = g.createRadialGradient(w * 0.16, h * 0.08, 0, w * 0.16, h * 0.08, h * 0.45);
    sg.addColorStop(0, withAlpha(palette.sunCore, 0.75));
    sg.addColorStop(1, withAlpha(palette.sunCore, 0));
    g.fillStyle = sg;
    g.fillRect(0, 0, w, h);
  } else if (stage === 'violetTide') {
    const sx = w * 0.5, sy = h * 0.7;
    const sg = g.createRadialGradient(sx, sy, 0, sx, sy, h * 0.35);
    sg.addColorStop(0, palette.sunCore);
    sg.addColorStop(0.08, withAlpha(palette.sunCore, 0.9));
    sg.addColorStop(0.3, withAlpha(palette.sunsetHorizon, 0.35));
    sg.addColorStop(1, withAlpha(palette.sunsetHorizon, 0));
    g.fillStyle = sg;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 18; i++) {
      const y = h * rng.range(0.74, 1.0);
      blob(g, rng.range(-0.1, 1.1) * w, y, h * rng.range(0.06, 0.14), palette.sunsetCloudDark, palette.sunsetIndigo, 0.9);
    }
    for (let i = 0; i < 8; i++) {
      blob(g, rng.range(-0.1, 1.1) * w, h * rng.range(0.2, 0.5), h * rng.range(0.05, 0.1), palette.sunsetIndigo, palette.sunsetZenith, 0.7);
    }
  } else {
    // nebula veil + stars + debris specks
    for (let i = 0; i < 6; i++) blob(g, rng.range(0, 1) * w, rng.range(0.2, 0.9) * h, h * rng.range(0.15, 0.3), palette.spaceNebula, palette.spaceDeep, 0.45);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = withAlpha(palette.smokeLit, rng.range(0.2, 0.9));
      const s = rng.chance(0.08) ? 2 : 1;
      g.fillRect(rng.next() * w, rng.next() * h, s, s);
    }
    const pg = g.createRadialGradient(w * 0.82, h * 0.3, 0, w * 0.82, h * 0.3, h * 0.2);
    pg.addColorStop(0, withAlpha(palette.planetYellow, 0.9));
    pg.addColorStop(0.35, withAlpha(palette.planetYellow, 0.55));
    pg.addColorStop(0.5, withAlpha(palette.debrisRim, 0.12));
    pg.addColorStop(1, withAlpha(palette.debrisRim, 0));
    g.fillStyle = pg;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = palette.debrisDark;
      const x = rng.next() * w, y = rng.next() * h, r = h * rng.range(0.004, 0.03);
      g.beginPath();
      g.moveTo(x - r, y);
      g.lineTo(x - r * 0.3, y - r * 0.8);
      g.lineTo(x + r, y - r * 0.2);
      g.lineTo(x + r * 0.4, y + r * 0.7);
      g.closePath();
      g.fill();
    }
  }
}

/** Simple 2D enemy stand-ins so lock brackets bracket something in HUD boards. */
export function drawEnemyStandIn(g: CanvasRenderingContext2D, x: number, y: number, size: number, kind: 'caltrop' | 'dart' | 'strider'): void {
  const r = size * 0.5;
  g.save();
  g.translate(x, y);
  if (kind === 'caltrop') {
    g.fillStyle = palette.caltropRed;
    g.strokeStyle = palette.enemyBody;
    g.lineWidth = Math.max(1, r * 0.08);
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.3;
      const rr = i % 2 === 0 ? r : r * 0.32;
      g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
    g.stroke();
    g.fillStyle = palette.enemyMarker;
    g.fillRect(-r * 0.12, -r * 0.12, r * 0.24, r * 0.24);
  } else if (kind === 'dart') {
    g.fillStyle = palette.enemyBody;
    g.beginPath();
    g.moveTo(0, -r * 0.35);
    g.lineTo(r, r * 0.3);
    g.lineTo(r * 0.2, r * 0.15);
    g.lineTo(0, r * 0.4);
    g.lineTo(-r * 0.2, r * 0.15);
    g.lineTo(-r, r * 0.3);
    g.closePath();
    g.fill();
    g.strokeStyle = palette.enemyRim;
    g.lineWidth = Math.max(1, r * 0.06);
    g.stroke();
    g.fillStyle = palette.accentOrange;
    g.fillRect(-r * 0.25, r * 0.3, r * 0.14, r * 0.14);
    g.fillRect(r * 0.11, r * 0.3, r * 0.14, r * 0.14);
  } else {
    g.fillStyle = palette.enemyBody;
    g.fillRect(-r * 0.35, -r * 0.9, r * 0.7, r * 0.8); // torso
    g.fillRect(-r * 0.2, -r * 1.05, r * 0.4, r * 0.2); // head
    g.fillRect(-r * 0.75, -r * 0.8, r * 0.35, r * 0.2); // shoulders
    g.fillRect(r * 0.4, -r * 0.8, r * 0.35, r * 0.2);
    g.fillRect(-r * 0.35, -r * 0.1, r * 0.22, r * 1.05); // legs
    g.fillRect(r * 0.13, -r * 0.1, r * 0.22, r * 1.05);
    g.strokeStyle = palette.enemyRim;
    g.lineWidth = Math.max(1, r * 0.04);
    g.strokeRect(-r * 0.35, -r * 0.9, r * 0.7, r * 0.8);
    g.fillStyle = palette.enemyMarker;
    g.fillRect(-r * 0.08, -r * 1.0, r * 0.16, r * 0.08);
  }
  g.restore();
}
