/**
 * Hero board (GAME_FORGE W3): KESTREL five angles, close-up, black silhouette test,
 * scale line-up (1.8 m pilot, 1 m cube, metre bar), a Violet Tide backlit cell and
 * an info panel (stats, emblem, pilot portraits). Variant via ?variant=A|B|C.
 * The chase cell is a 1:1 pixel crop of the true 1920x1080 game frame
 * (camera 20 m behind, 5 m above, FOV 68).
 */
import * as THREE from 'three';
import type { LabContext, Rect } from '../context';
import { palette, stages, scale } from '../../style/tokens';
import { withAlpha } from '../../style/color';
import { applyStageLook } from '../../gen/common/lighting';
import { buildKestrel, KESTREL_VARIANTS, type Kestrel, type KestrelState } from '../../gen/entities/kestrel';
import { buildPilotFigure, drawPilotPortrait } from '../../gen/entities/pilot';
import { drawKestrelEmblem } from '../../gen/entities/emblem';
import { HullBuilder, createHullMaterials } from '../../gen/entities/hullMaterial';

const SEED = 7;
const CHASE = { back: 20, up: 5, fov: 68 };

function gradientTex(stops: [number, string][], sun?: { x: number; y: number; r: number }): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const gr = g.createLinearGradient(0, 0, 0, 256);
  for (const [t, col] of stops) gr.addColorStop(t, col);
  g.fillStyle = gr;
  g.fillRect(0, 0, 256, 256);
  if (sun) {
    const rg = g.createRadialGradient(sun.x * 256, sun.y * 256, 0, sun.x * 256, sun.y * 256, sun.r * 256 * 4);
    rg.addColorStop(0, palette.sunCore);
    rg.addColorStop(0.22, withAlpha(palette.sunCore, 0.9));
    rg.addColorStop(0.3, withAlpha(palette.sunsetHorizon, 0.5));
    rg.addColorStop(1, withAlpha(palette.sunsetHorizon, 0));
    g.fillStyle = rg;
    g.fillRect(0, 0, 256, 256);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function unitCube(): THREE.Mesh {
  const b = new HullBuilder();
  b.newComponent();
  const p = (x: number, y: number, z: number) => new THREE.Vector3(x - 0.5, y, z - 0.5);
  const s = { color: palette.armourSteel };
  const top = { color: palette.armourLight };
  b.quad(p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1), s);
  b.quad(p(1, 0, 0), p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), s);
  b.quad(p(1, 0, 1), p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), s);
  b.quad(p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0), s);
  b.quad(p(0, 1, 1), p(1, 1, 1), p(1, 1, 0), p(0, 1, 0), top);
  b.quad(p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1), s);
  const { geometry } = b.build();
  return new THREE.Mesh(geometry, createHullMaterials({ seamWidth: 0.02 }).hull);
}

function persp(fov: number, pos: [number, number, number], look: [number, number, number], up: [number, number, number] = [0, 1, 0]) {
  const c = new THREE.PerspectiveCamera(fov, 1.5, 0.1, 3000);
  c.position.set(...pos);
  c.up.set(...up);
  c.lookAt(...look);
  return c;
}

const LEVEL: KestrelState = { time: 1.2, bank: 0, pitch: 0, throttle: 1, boost: false, drift: false, hitFlash: 0 };

export default async function board(ctx: LabContext) {
  const variant = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as 'A' | 'B' | 'C';
  const params = KESTREL_VARIANTS[variant];
  const k: Kestrel = buildKestrel(params, SEED);
  const kFront = buildKestrel(params, SEED); // second instance for the scale line-up front view
  const pilot = buildPilotFigure();
  const cube = unitCube();
  const W = ctx.width;

  const cloudSky = gradientTex([[0, palette.skyZenith], [0.45, palette.skyDay], [0.8, palette.skyHorizon], [1, palette.cloudCream]]);
  const chaseSky = gradientTex([[0, palette.skyZenith], [0.3, palette.skyDay], [0.5, palette.skyHorizon], [0.56, palette.cloudCream], [0.75, palette.cloudMid], [1, palette.cloudShadow]]);
  const sunsetSky = gradientTex(
    [[0, palette.sunsetZenith], [0.3, palette.sunsetIndigo], [0.46, palette.sunsetMagenta], [0.52, palette.sunsetHorizon], [0.56, palette.sunsetCloudDark], [1, palette.sunsetZenith]],
    { x: 0.5, y: 0.5, r: 0.03 },
  );

  // ---- layout ----
  const m = 12;
  const r1h = 300, r1y = 64;
  const cw = (W - m * 6) / 5;
  const row1: Rect[] = Array.from({ length: 5 }, (_, i) => ({ x: m + i * (cw + m), y: r1y, w: cw, h: r1h }));
  const r2y = r1y + r1h + m, r2h = 330;
  const chaseR: Rect = { x: m, y: r2y, w: 587, h: r2h };
  const violetR: Rect = { x: chaseR.x + chaseR.w + m, y: r2y, w: 440, h: r2h };
  const silR: Rect = { x: violetR.x + violetR.w + m, y: r2y, w: W - (violetR.x + violetR.w + m) - m, h: r2h };
  const r3y = r2y + r2h + m, r3h = ctx.height - r3y - m;
  const scaleR: Rect = { x: m, y: r3y, w: 1100, h: r3h };
  const infoR: Rect = { x: scaleR.x + scaleR.w + m, y: r3y, w: W - (scaleR.x + scaleR.w + m) - m, h: r3h };

  ctx.title('KESTREL hero craft', params.note);
  ctx.clearAll(palette.spaceDeep);

  const scene = new THREE.Scene();
  scene.add(k.root);
  const render = (cam: THREE.Camera, rect: Rect, bg: THREE.Texture | string) => {
    if (typeof bg === 'string') {
      scene.background = null;
      ctx.renderCells([{ scene, camera: cam, rect, clear: bg }], null);
    } else {
      scene.background = bg;
      ctx.renderCells([{ scene, camera: cam, rect }], null);
    }
  };

  // ---- measure stats with the real renderer ----
  applyStageLook('cloudgate');
  k.snap(LEVEL);
  const measureCam = persp(40, [8, 6, 12], [0, 0, 0]);
  ctx.renderer.setViewport(0, 0, 64, 64);
  ctx.renderer.render(scene, measureCam);
  const measured = { calls: ctx.renderer.info.render.calls, triangles: ctx.renderer.info.render.triangles };
  ctx.clearAll(palette.spaceDeep);

  // ---- row 1: five angles (Cloudgate rig) ----
  const views: [string, THREE.PerspectiveCamera][] = [
    ['FRONT', persp(16, [0, 0.4, -42], [0, 0.35, 0])],
    ['SIDE', persp(18, [42, 0.5, -0.4], [0, 0.5, -0.4])],
    ['TOP', persp(18, [0, 42, -0.3], [0, 0, -0.3], [0, 0, -1])],
    ['LOW 3/4', persp(34, [-10, -4.8, -11.5], [0, -0.1, -0.3])],
    ['CLOSE-UP canopy / grilles / emblem', persp(38, [4.4, 3.4, -4.2], [1.2, 0.35, 0.3])],
  ];
  views.forEach(([name, cam], i) => {
    render(cam, row1[i], cloudSky);
    ctx.label(name, row1[i].x + 6, row1[i].y + 6);
  });

  // ---- chase: 1:1 crop of the game frame; craft banking right with a live bank rate ----
  {
    const cam = new THREE.PerspectiveCamera(CHASE.fov, 1920 / 1080, 0.1, 3000);
    cam.position.set(0, CHASE.up, CHASE.back);
    cam.lookAt(0, 1.2, -30);
    cam.updateMatrixWorld();
    const pr = new THREE.Vector3(0, 0, 0).project(cam);
    const sx = (pr.x * 0.5 + 0.5) * 1920, sy = (1 - (pr.y * 0.5 + 0.5)) * 1080;
    cam.setViewOffset(1920, 1080, Math.round(sx - chaseR.w / 2), Math.round(sy - chaseR.h / 2), chaseR.w, chaseR.h);
    const dt = 1 / 60;
    for (let i = 0; i < 40; i++) {
      const tt = 2 + i * dt;
      k.update(dt, { ...LEVEL, time: tt, bank: 0.35 * Math.min(1, i / 30), throttle: 1.15 });
    }
    render(cam, chaseR, chaseSky);
    k.snap(LEVEL);
    ctx.label(`CHASE 1:1 crop of 1080p frame, cam ${CHASE.back} m back/${CHASE.up} m up`, chaseR.x + 6, chaseR.y + 6);
  }

  // ---- violet tide backlit ----
  {
    applyStageLook('violetTide');
    const cam = persp(50, [-5.5, 2.4, 12], [0, 0.4, -4]);
    k.snap({ ...LEVEL, time: 3, throttle: 1.3 });
    render(cam, violetR, sunsetSky);
    ctx.label(`${stages.violetTide.name}: backlit rim`, violetR.x + 6, violetR.y + 6);
    applyStageLook('cloudgate');
    k.snap(LEVEL);
  }

  // ---- silhouette test ----
  {
    k.setSilhouette(true);
    const hw = (silR.w - m) / 2, hh = (silR.h - m) / 2;
    const sub: [string, THREE.PerspectiveCamera, Rect][] = [
      ['front', persp(15, [0, 0.4, -42], [0, 0.35, 0]), { x: silR.x, y: silR.y, w: hw, h: hh }],
      ['side', persp(17, [42, 0.5, -0.4], [0, 0.5, -0.4]), { x: silR.x + hw + m, y: silR.y, w: hw, h: hh }],
      ['top', persp(20, [0, 42, -0.3], [0, 0, -0.3], [0, 0, -1]), { x: silR.x, y: silR.y + hh + m, w: hw, h: hh }],
      ['3/4 rear', persp(22, [16, 14, 30], [0, 0, 0]), { x: silR.x + hw + m, y: silR.y + hh + m, w: hw, h: hh }],
    ];
    for (const [name, cam, rect] of sub) {
      render(cam, rect, palette.cloudCream);
      ctx.label(`SILHOUETTE ${name}`, rect.x + 6, rect.y + 6, palette.hudValue);
    }
    k.setSilhouette(false);
  }

  // ---- scale line-up (orthographic, side + front) ----
  {
    const sc = new THREE.Scene();
    sc.background = gradientTex([[0, palette.skyHorizon], [1, palette.cloudMid]]);
    const craftY = 2.0;
    k.snap(LEVEL);
    k.root.position.set(0, craftY, 0);
    sc.add(k.root);
    kFront.snap(LEVEL);
    kFront.root.position.set(0, craftY, -16.2);
    kFront.root.rotation.y = -Math.PI / 2; // nose toward the camera (+X)
    sc.add(kFront.root);
    pilot.position.set(0, 0, -8.2);
    pilot.rotation.y = -Math.PI / 2 - 0.5;
    sc.add(pilot);
    cube.position.set(0, 0, -9.9);
    sc.add(cube);
    const aspect = scaleR.w / scaleR.h;
    const viewW = 28.5, viewH = viewW / aspect;
    const cz = -7.4; // world z at the view centre (camera right = -Z)
    const below = 1.5;
    const cam = new THREE.OrthographicCamera(-viewW / 2, viewW / 2, viewH - below, -below, 0.1, 200);
    cam.position.set(60, 0, cz);
    cam.lookAt(0, 0, cz);
    ctx.renderCells([{ scene: sc, camera: cam, rect: scaleR }], null);
    const pxPerM = scaleR.w / viewW;
    const groundY = scaleR.y + scaleR.h - below * pxPerM;
    const zToX = (z: number) => scaleR.x + scaleR.w / 2 - (z - cz) * pxPerM;
    const g = ctx.overlay;
    g.save();
    g.strokeStyle = palette.armourDark;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(scaleR.x, groundY);
    g.lineTo(scaleR.x + scaleR.w, groundY);
    g.stroke();
    const tail = 5.35, y0 = groundY + 12;
    for (let i = 0; i < 12; i++) {
      const xa = zToX(tail - i), xb = zToX(tail - i - 1);
      g.fillStyle = i % 2 ? palette.armourLight : palette.armourDark;
      g.fillRect(Math.min(xa, xb), y0, Math.abs(xb - xa), 8);
    }
    g.strokeRect(zToX(tail), y0, 12 * pxPerM, 8);
    g.font = '12px ui-monospace, Menlo, Consolas, monospace';
    g.fillStyle = palette.armourDark;
    g.textAlign = 'center';
    for (let i = 0; i <= 12; i += 2) g.fillText(`${i} m`, zToX(tail - i), y0 + 22);
    g.restore();
    ctx.label(`SCALE: side + front, pilot ${scale.pilot} m, 1 m cube, metre bar`, scaleR.x + 6, scaleR.y + 6);
    scene.add(k.root);
    k.root.position.set(0, 0, 0);
  }

  // ---- info panel ----
  const st = k.stats;
  const tris = { hull: st.hullTriangles, outline: st.outlineTriangles, exhaust: st.exhaustTriangles, total: st.triangles };
  {
    const g = ctx.overlay;
    g.save();
    g.fillStyle = withAlpha(palette.spaceDeep, 1);
    g.fillRect(infoR.x, infoR.y, infoR.w, infoR.h);
    g.strokeStyle = palette.hudLine;
    g.lineWidth = 1;
    g.strokeRect(infoR.x + 0.5, infoR.y + 0.5, infoR.w - 1, infoR.h - 1);
    drawKestrelEmblem(g, infoR.x + 82, infoR.y + 92, 66);
    const pw = 120, ph = 160;
    for (const [i, d] of [[0, 0], [1, 1]] as [number, number][]) {
      g.save();
      g.translate(infoR.x + 170 + i * (pw + 12), infoR.y + 14);
      drawPilotPortrait(g, pw, ph, { danger: d, time: 1.3 });
      g.strokeStyle = d ? palette.shieldRed : palette.hudLine;
      g.lineWidth = 2;
      g.strokeRect(1, 1, pw - 2, ph - 2);
      g.restore();
    }
    g.fillStyle = palette.hudText;
    g.font = '12px ui-monospace, Menlo, Consolas, monospace';
    g.fillText('emblem', infoR.x + 60, infoR.y + 178);
    g.fillText('portrait danger 0 / 1', infoR.x + 180, infoR.y + 190);
    const lines = [
      `variant ${params.name}   seed ${SEED}`,
      `triangles: hull ${tris.hull}  outline ${params.outline ? tris.outline : 0}  exhaust ${tris.exhaust}  = ${tris.total}`,
      `draw calls: ${st.drawCalls}   measured render(): ${measured.calls} calls / ${measured.triangles} tris`,
      `bounds ${st.bounds.join(' x ')} m (x y z)   radius ${k.radius} m   pilot tris ${pilot.userData.triangles}`,
      `livery ${params.livery.primary} / ${params.livery.secondary} / ${params.livery.under}, accent ${params.livery.accent} x${params.accentAmount}`,
      `sweep ${params.wingSweep} deg  dihedral ${params.dihedral}  fins ${params.finHeight} m @ ${params.finCant} deg  nose x${params.noseStretch}  outline ${params.outline ? 'on' : 'off'}`,
    ];
    g.fillStyle = palette.hudValue;
    g.font = '13px ui-monospace, Menlo, Consolas, monospace';
    lines.forEach((l, i) => g.fillText(l, infoR.x + 14, infoR.y + 220 + i * 19));
    // tokens swatches
    const sw = [params.livery.primary, params.livery.secondary, params.livery.under, params.livery.accent, params.livery.glass, 'exhaustCore', 'emblemBlack'] as const;
    sw.forEach((key, i) => {
      g.fillStyle = palette[key];
      g.fillRect(infoR.x + 440 + (i % 4) * 82, infoR.y + 18 + Math.floor(i / 4) * 64, 74, 34);
      g.fillStyle = palette.hudValue;
      g.font = '10px ui-monospace, Menlo, Consolas, monospace';
      g.fillText(key, infoR.x + 440 + (i % 4) * 82, infoR.y + 64 + Math.floor(i / 4) * 64);
    });
    g.restore();
  }

  const exported = {
    board: 'hero',
    variant,
    seed: SEED,
    params,
    chaseCamera: CHASE,
    stats: { ...st, triangles: tris, radius: k.radius, measuredRender: measured, pilotTriangles: pilot.userData.triangles },
    ports: {
      exhaust: k.exhaustPorts.map((p) => p.toArray().map((x) => +x.toFixed(3))),
      wingtips: k.wingtips.map((p) => p.toArray().map((x) => +x.toFixed(3))),
      missiles: k.missilePorts.map((p) => p.toArray().map((x) => +x.toFixed(3))),
      muzzles: k.muzzles.map((p) => p.toArray().map((x) => +x.toFixed(3))),
    },
  };
  ctx.exportParams(exported);
  ctx.ready();
}
