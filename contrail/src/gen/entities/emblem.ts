/**
 * KESTREL emblem: an original stooping-kestrel mark (swept serrated wings, notched
 * tail, orange chest chevron) on a black disc, drawn in code. Used as the hull
 * decal texture (planar projected on the wings) and by UI/board code.
 */
import * as THREE from 'three';
import { palette } from '../../style/tokens';

export interface EmblemOptions {
  disc?: string;
  ink?: string;
  accent?: string;
}

/** Draw the emblem centred at (cx, cy) with radius r. Bird points up (= craft forward). */
export function drawKestrelEmblem(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, o: EmblemOptions = {}): void {
  const disc = o.disc ?? palette.emblemBlack;
  const ink = o.ink ?? palette.armourLight;
  const accent = o.accent ?? palette.accentOrange;
  g.save();
  g.translate(cx, cy);
  g.scale(r, r);
  g.beginPath();
  g.arc(0, 0, 1, 0, Math.PI * 2);
  g.fillStyle = disc;
  g.fill();
  // thin ring with a notch at the top (forward index mark)
  g.lineWidth = 0.055;
  g.strokeStyle = ink;
  g.beginPath();
  g.arc(0, 0, 0.84, -Math.PI / 2 + 0.22, Math.PI * 1.5 - 0.22);
  g.stroke();
  g.fillStyle = accent;
  g.beginPath();
  g.moveTo(0, -0.97);
  g.lineTo(0.1, -0.78);
  g.lineTo(-0.1, -0.78);
  g.closePath();
  g.fill();

  const shape = (pts: [number, number][], fill: string) => {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  // head + body (long diamond with a hooked beak notch)
  shape([[0, -0.66], [0.1, -0.5], [0.13, -0.24], [0.06, 0.28], [0, 0.34], [-0.06, 0.28], [-0.13, -0.24], [-0.1, -0.5]], ink);
  // wings: swept back, serrated trailing edge (primary feathers)
  for (const s of [1, -1]) {
    shape(
      [
        [0.08 * s, -0.34],
        [0.74 * s, 0.1],
        [0.66 * s, 0.2],
        [0.56 * s, 0.14],
        [0.5 * s, 0.24],
        [0.4 * s, 0.16],
        [0.34 * s, 0.24],
        [0.1 * s, 0.02],
      ],
      ink,
    );
  }
  // notched tail fan
  shape([[0.05, 0.22], [0.16, 0.6], [0.06, 0.54], [0, 0.66], [-0.06, 0.54], [-0.16, 0.6], [-0.05, 0.22]], ink);
  // orange chest chevron + eye mark
  g.strokeStyle = accent;
  g.lineWidth = 0.075;
  g.lineJoin = 'miter';
  g.beginPath();
  g.moveTo(-0.24, -0.2);
  g.lineTo(0, -0.02);
  g.lineTo(0.24, -0.2);
  g.stroke();
  shape([[0, -0.56], [0.045, -0.5], [0, -0.44], [-0.045, -0.5]], disc);
  g.restore();
}

let cached: THREE.CanvasTexture | null = null;

/** Cached 256x256 emblem texture (transparent outside the disc). */
export function getEmblemTexture(): THREE.CanvasTexture {
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  drawKestrelEmblem(g, 128, 128, 124);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  cached = t;
  return t;
}
