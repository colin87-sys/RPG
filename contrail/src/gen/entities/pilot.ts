/**
 * Pilot: a 1.8 m standing figure in an orange/white flight suit with a visored
 * helmet (no face) for scale line-ups, and a code-drawn visored-helmet portrait
 * for the HUD pilot frame. Colours from tokens only.
 */
import * as THREE from 'three';
import { palette, scale } from '../../style/tokens';
import { mix, shade, withAlpha } from '../../style/color';
import { HullBuilder, SURF, createHullMaterials, type FaceStyle } from './hullMaterial';

type V3 = THREE.Vector3;
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function newellDot(p: V3[], d: V3): number {
  const n = new THREE.Vector3();
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n.dot(d);
}

/** Tapered box: bottom rect (w0 x d0) at y0, top rect (w1 x d1) at y1, centred at (cx, cz). */
function frustum(b: HullBuilder, cx: number, cz: number, y0: number, y1: number, w0: number, d0: number, w1: number, d1: number, s: FaceStyle | ((face: string) => FaceStyle), lean = 0) {
  const st = typeof s === 'function' ? s : () => s;
  const B = [v(cx - w0 / 2, y0, cz - d0 / 2), v(cx + w0 / 2, y0, cz - d0 / 2), v(cx + w0 / 2, y0, cz + d0 / 2), v(cx - w0 / 2, y0, cz + d0 / 2)];
  const T = [v(cx + lean - w1 / 2, y1, cz - d1 / 2), v(cx + lean + w1 / 2, y1, cz - d1 / 2), v(cx + lean + w1 / 2, y1, cz + d1 / 2), v(cx + lean - w1 / 2, y1, cz + d1 / 2)];
  const names = ['front', 'right', 'back', 'left'];
  const c = v(cx + lean / 2, (y0 + y1) / 2, cz);
  for (let i = 0; i < 4; i++) {
    const n = (i + 1) % 4;
    const q = [B[i], B[n], T[n], T[i]];
    const mid = q.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(0.25).sub(c);
    if (newellDot(q, mid) >= 0) b.quad(q[0], q[1], q[2], q[3], st(names[i]));
    else b.quad(q[0], q[3], q[2], q[1], st(names[i]));
  }
  const top = newellDot(T, v(0, 1, 0)) >= 0 ? T : [...T].reverse();
  const bot = newellDot(B, v(0, -1, 0)) >= 0 ? B : [...B].reverse();
  b.poly(top, st('top'));
  b.poly(bot, st('bottom'));
}

/** Standing pilot, feet at y = 0, facing -Z, height = scale.pilot (1.8 m). One draw call. */
export function buildPilotFigure(): THREE.Group {
  const b = new HullBuilder();
  const suit: FaceStyle = { color: palette.armourLight };
  const orange: FaceStyle = { color: palette.accentOrange };
  const steel: FaceStyle = { color: palette.armourSteel };
  const dark: FaceStyle = { color: palette.armourDark };
  b.mirror = true;
  b.newComponent();
  frustum(b, 0.11, 0.02, 0, 0.12, 0.13, 0.3, 0.13, 0.26, dark); // boots
  frustum(b, 0.11, 0, 0.12, 0.5, 0.12, 0.14, 0.14, 0.15, (f) => (f === 'front' ? orange : suit)); // shins
  frustum(b, 0.11, -0.085, 0.44, 0.58, 0.12, 0.03, 0.12, 0.03, orange); // knee pads
  frustum(b, 0.11, 0, 0.5, 0.9, 0.14, 0.16, 0.17, 0.19, suit); // thighs
  frustum(b, 0.29, 0, 1.12, 1.42, 0.1, 0.11, 0.12, 0.13, suit, 0.02); // upper arms
  frustum(b, 0.3, -0.01, 0.86, 1.12, 0.09, 0.1, 0.1, 0.11, (f) => (f === 'front' || f === 'right' ? orange : suit)); // forearms
  frustum(b, 0.3, -0.01, 0.74, 0.86, 0.08, 0.09, 0.09, 0.1, dark); // gloves
  frustum(b, 0.26, 0, 1.36, 1.48, 0.15, 0.2, 0.13, 0.16, orange); // shoulder pads
  b.mirror = false;
  b.newComponent();
  frustum(b, 0, 0, 0.86, 0.99, 0.4, 0.22, 0.4, 0.22, steel); // belt
  frustum(b, 0, 0, 0.99, 1.44, 0.36, 0.22, 0.46, 0.26, (f) => (f === 'front' ? orange : suit)); // torso
  frustum(b, 0, -0.125, 1.08, 1.34, 0.22, 0.02, 0.3, 0.02, suit); // chest plate over orange
  frustum(b, 0, 0, 1.44, 1.53, 0.18, 0.16, 0.16, 0.15, steel); // neck ring
  // helmet: octagonal rings, visor on the front facets
  const R = [
    [1.52, 0.125],
    [1.6, 0.15],
    [1.72, 0.145],
    [1.79, 0.1],
  ];
  const N = 8;
  const rings = R.map(([y, r]) => Array.from({ length: N }, (_, k) => {
    const a = (k / N) * Math.PI * 2 + Math.PI / N;
    return v(Math.sin(a) * r, y, -Math.cos(a) * r * 1.05);
  }));
  b.newComponent();
  const visor: FaceStyle = { color: palette.canopyBlue, kind: SURF.glass, seamScale: 2 };
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < N; j++) {
      const a = rings[i][j], c = rings[i + 1][j], d = rings[i + 1][(j + 1) % N], e = rings[i][(j + 1) % N];
      const front = j === N - 1 || j === 0 || j === N - 2;
      const s = i === 1 && front ? visor : i === 2 && (j === N - 1 || j === 3) ? orange : suit;
      const q = [a, e, d, c];
      const mid = q.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(0.25);
      if (newellDot(q, v(mid.x, 0, mid.z)) >= 0) b.quad(q[0], q[1], q[2], q[3], s);
      else b.quad(q[0], q[3], q[2], q[1], s);
    }
  const topR = rings[rings.length - 1];
  b.poly(newellDot(topR, v(0, 1, 0)) >= 0 ? topR : [...topR].reverse(), suit);
  const { geometry } = b.build();
  const mats = createHullMaterials({ seamWidth: 0.006 });
  const mesh = new THREE.Mesh(geometry, mats.hull);
  mesh.name = 'pilotFigure';
  const g = new THREE.Group();
  g.name = 'pilot';
  g.add(mesh);
  g.userData.height = scale.pilot;
  g.userData.triangles = geometry.getAttribute('position').count / 3;
  return g;
}

/**
 * Visored-helmet portrait (no face) for the HUD pilot frame, drawn into (0,0,w,h).
 * danger 0..1 tints the background, adds red rim and visor alarm reflections.
 * time drives the visor reflection sweep and a small eased breathing bob.
 */
export function drawPilotPortrait(g: CanvasRenderingContext2D, w: number, h: number, opts: { danger: number; time: number }): void {
  const dng = Math.min(1, Math.max(0, opts.danger));
  const t = opts.time;
  const pulse = dng * (0.5 + 0.5 * Math.sin(t * 7.0));
  g.save();
  g.beginPath();
  g.rect(0, 0, w, h);
  g.clip();
  // background
  const bg = g.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, mix(palette.spaceDeep, palette.shieldRed, 0.25 * dng + 0.15 * pulse));
  bg.addColorStop(1, mix(mix(palette.spaceDeep, palette.skyDay, 0.35), palette.shieldRed, 0.35 * dng));
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  // faint grid lines
  g.strokeStyle = withAlpha(palette.hudDim, 0.5);
  g.lineWidth = Math.max(1, h / 300);
  for (let y = h * 0.06; y < h; y += h / 14) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }
  const breathe = Math.sin(t * 1.6);
  const bob = (breathe * breathe * Math.sign(breathe)) * h * 0.006;
  const cx = w * 0.5, s = Math.min(w, h * 0.75);
  const hy = h * 0.42 + bob;
  const rimCol = dng > 0.5 ? palette.shieldRed : palette.skyHorizon;

  // shoulders / collar
  g.fillStyle = palette.armourLight;
  g.beginPath();
  g.moveTo(cx - s * 0.62, h);
  g.lineTo(cx - s * 0.5, h * 0.8 + bob);
  g.lineTo(cx - s * 0.2, h * 0.7 + bob);
  g.lineTo(cx + s * 0.2, h * 0.7 + bob);
  g.lineTo(cx + s * 0.5, h * 0.8 + bob);
  g.lineTo(cx + s * 0.62, h);
  g.closePath();
  g.fill();
  const shadowSide = g.createLinearGradient(cx - s * 0.6, 0, cx + s * 0.6, 0);
  shadowSide.addColorStop(0, withAlpha(palette.armourDark, 0));
  shadowSide.addColorStop(1, withAlpha(mix(palette.armourDark, palette.sunsetIndigo, 0.4), 0.55));
  g.fillStyle = shadowSide;
  g.fill();
  // orange shoulder blocks + chest chevron
  g.fillStyle = palette.accentOrange;
  for (const sd of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx + sd * s * 0.62, h);
    g.lineTo(cx + sd * s * 0.52, h * 0.82 + bob);
    g.lineTo(cx + sd * s * 0.38, h * 0.77 + bob);
    g.lineTo(cx + sd * s * 0.44, h);
    g.closePath();
    g.fill();
  }
  g.beginPath();
  g.moveTo(cx - s * 0.16, h);
  g.lineTo(cx, h * 0.86 + bob);
  g.lineTo(cx + s * 0.16, h);
  g.closePath();
  g.fill();
  // neck ring
  g.fillStyle = palette.armourSteel;
  g.beginPath();
  g.ellipse(cx, h * 0.7 + bob, s * 0.22, s * 0.06, 0, 0, Math.PI * 2);
  g.fill();

  // helmet shell (angular dome)
  const R = s * 0.34;
  const shell: [number, number][] = [[-0.92, 0.55], [-1.0, 0.05], [-0.85, -0.55], [-0.45, -0.92], [0, -1.0], [0.45, -0.92], [0.85, -0.55], [1.0, 0.05], [0.92, 0.55], [0.55, 0.9], [-0.55, 0.9]];
  g.beginPath();
  shell.forEach(([x, y], i) => (i ? g.lineTo(cx + x * R, hy + y * R) : g.moveTo(cx + x * R, hy + y * R)));
  g.closePath();
  const hg = g.createLinearGradient(cx - R, hy - R, cx + R, hy + R);
  hg.addColorStop(0, shade(palette.armourLight, 1.08));
  hg.addColorStop(0.55, palette.armourLight);
  hg.addColorStop(1, mix(palette.armourSteel, palette.sunsetIndigo, 0.25));
  g.fillStyle = hg;
  g.fill();
  // rim light on the right edge
  g.save();
  g.clip();
  g.strokeStyle = withAlpha(rimCol, 0.85);
  g.lineWidth = R * 0.12;
  g.beginPath();
  g.moveTo(cx + R * 0.5, hy - R * 1.02);
  g.lineTo(cx + R * 1.02, hy - R * 0.5);
  g.lineTo(cx + R * 1.06, hy + R * 0.1);
  g.lineTo(cx + R * 0.95, hy + R * 0.6);
  g.stroke();
  g.restore();
  // ridge stripe
  g.fillStyle = palette.accentOrange;
  g.beginPath();
  g.moveTo(cx - R * 0.1, hy - R * 1.0);
  g.lineTo(cx + R * 0.1, hy - R * 1.0);
  g.lineTo(cx + R * 0.14, hy - R * 0.45);
  g.lineTo(cx - R * 0.14, hy - R * 0.45);
  g.closePath();
  g.fill();
  // ear pieces
  g.fillStyle = palette.armourSteel;
  for (const sd of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx + sd * R * 0.98, hy - R * 0.05);
    g.lineTo(cx + sd * R * 0.8, hy + R * 0.4);
    g.lineTo(cx + sd * R * 0.8, hy - R * 0.25);
    g.closePath();
    g.fill();
  }
  // visor
  const vis: [number, number][] = [[-0.82, -0.28], [-0.55, -0.48], [0.55, -0.48], [0.82, -0.28], [0.78, 0.3], [0.45, 0.62], [-0.45, 0.62], [-0.78, 0.3]];
  g.beginPath();
  vis.forEach(([x, y], i) => (i ? g.lineTo(cx + x * R, hy + y * R) : g.moveTo(cx + x * R, hy + y * R)));
  g.closePath();
  const vg = g.createLinearGradient(0, hy - R * 0.5, 0, hy + R * 0.62);
  vg.addColorStop(0, palette.emblemBlack);
  vg.addColorStop(0.6, mix(palette.emblemBlack, palette.canopyBlue, 0.45));
  vg.addColorStop(1, mix(palette.canopyBlue, palette.skyHorizon, 0.3));
  g.fillStyle = vg;
  g.fill();
  g.save();
  g.clip();
  // reflected horizon line (curved) + sweeping highlight bands
  g.strokeStyle = withAlpha(dng > 0.5 ? palette.sunsetHorizon : palette.cloudCream, 0.55);
  g.lineWidth = R * 0.05;
  g.beginPath();
  g.moveTo(cx - R, hy + R * 0.28);
  g.quadraticCurveTo(cx, hy + R * 0.1, cx + R, hy + R * 0.28);
  g.stroke();
  const sweep = ((t * 0.25) % 1.6) - 0.3;
  for (const [off, wd, a] of [[0, 0.22, 0.35], [0.3, 0.08, 0.5]] as [number, number, number][]) {
    const x0 = cx + (sweep + off - 0.5) * 2 * R;
    g.fillStyle = withAlpha(palette.hudValue, a);
    g.beginPath();
    g.moveTo(x0, hy - R * 0.6);
    g.lineTo(x0 + wd * R, hy - R * 0.6);
    g.lineTo(x0 + wd * R - R * 0.5, hy + R * 0.7);
    g.lineTo(x0 - R * 0.5, hy + R * 0.7);
    g.closePath();
    g.fill();
  }
  // tiny HUD glints reflected in the visor
  g.strokeStyle = withAlpha(palette.hudText, 0.6);
  g.lineWidth = Math.max(1, R * 0.025);
  g.beginPath();
  g.arc(cx - R * 0.3, hy - R * 0.05, R * 0.14, 0.4, 2.6);
  g.stroke();
  if (dng > 0) {
    g.fillStyle = withAlpha(palette.shieldRed, 0.45 * pulse + 0.15 * dng);
    g.fillRect(cx - R, hy - R * 0.5, 2 * R, R * 1.2);
  }
  g.restore();
  // visor frame
  g.strokeStyle = palette.armourDark;
  g.lineWidth = Math.max(1, R * 0.05);
  g.beginPath();
  vis.forEach(([x, y], i) => (i ? g.lineTo(cx + x * R, hy + y * R) : g.moveTo(cx + x * R, hy + y * R)));
  g.closePath();
  g.stroke();
  g.restore();
}
