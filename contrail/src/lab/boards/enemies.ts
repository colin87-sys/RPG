/**
 * Enemies board (W3 #2): WARDEN swarm line-up at true relative scale beside the
 * KESTREL and the 1.8 m pilot, readable insets, a cream/space readability strip,
 * a flat-black silhouette row and the BULWARK silhouette with a scale bar.
 * Uses the game's own builders from src/gen/entities/enemies.
 */
import * as THREE from 'three';
import type { LabContext, Rect } from '../context';
import { palette, scale } from '../../style/tokens';
import { withAlpha } from '../../style/color';
import { applyStageLook } from '../../gen/common/lighting';
import type { StageId } from '../../style/tokens';
import {
  ENEMY_VARIANTS, buildCaltrop, buildDart, buildSniper, buildStrider, buildBulwark, CaltropSwarm, DartSquadron,
  setEnemySilhouette, countDrawCalls, type EnemyVariantId,
} from '../../gen/entities/enemies';
import { buildKestrel, KESTREL_VARIANTS } from '../../gen/entities/kestrel';
import { buildPilotFigure } from '../../gen/entities/pilot';
import { toonMaterial } from '../../gen/common/materials';

type Anim = (t: number) => void;
interface Item { obj: THREE.Object3D; anim?: Anim }

const Y = new THREE.Vector3(0, 1, 0);

function settle(anim: Anim | undefined, t0: number) {
  if (!anim) return;
  for (let i = 0; i <= 90; i++) anim(t0 - 1.5 + i / 60);
}

function hero(variant: EnemyVariantId, silhouette = false): Item {
  try {
    const k = buildKestrel(KESTREL_VARIANTS[variant], 1);
    const st = { time: 1, bank: 0, pitch: 0, throttle: 1, boost: false, drift: false, hitFlash: 0 };
    k.snap(st);
    k.update(1 / 60, st);
    if (silhouette) k.setSilhouette(true);
    return { obj: k.root };
  } catch (e) {
    console.warn('kestrel unavailable, placeholder used', e);
    const g = new THREE.Group();
    const s = new THREE.Shape();
    s.moveTo(0, -6); s.lineTo(4.5, 6); s.lineTo(-4.5, 6); s.closePath();
    const m = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.4, bevelEnabled: false }), toonMaterial({ albedo: palette.armourLight }));
    m.rotation.x = Math.PI / 2;
    g.add(m);
    return { obj: g };
  }
}

function pilot(): Item {
  try {
    return { obj: buildPilotFigure() };
  } catch {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.2, 4, 8), toonMaterial({ albedo: palette.accentOrange }));
    m.position.y = 0.9;
    const g = new THREE.Group();
    g.add(m);
    return { obj: g };
  }
}

export default async function board(ctx: LabContext) {
  const vid = (ctx.variant in ENEMY_VARIANTS ? ctx.variant : 'A') as EnemyVariantId;
  const V = ENEMY_VARIANTS[vid];
  const T = 1.35; // board time
  ctx.title('WARDEN swarm line-up', `variant ${vid} "${V.name}"  |  nose = -Z, metres, true scale where marked`);
  ctx.clearAll(palette.spaceDeep);
  const g2 = ctx.overlay;

  // --- factories (each cell gets its own instances)
  const mk = {
    caltrop: (): Item => { const b = buildCaltrop(V.caltrop, 3); return { obj: b.root, anim: (t) => b.update(1 / 60, { time: t }) }; },
    dart: (): Item => { const b = buildDart(V.dart, 5); return { obj: b.root, anim: (t) => b.update(1 / 60, { time: t }) }; },
    sniper: (charge = 0): Item => { const b = buildSniper(V.sniper, 7); return { obj: b.root, anim: (t) => b.update(1 / 60, { time: t, charge }) }; },
    strider: (open = 0): Item => { const b = buildStrider(V.strider, 11); return { obj: b.root, anim: (t) => b.update(1 / 60, { time: t, weakPointOpen: open }) }; },
    bulwark: (): Item => { const b = buildBulwark(V.bulwark, 13); return { obj: b.root, anim: (t) => b.update(1 / 60, { time: t, phase: 1, ventGlow: 1 }) }; },
  };

  const render = (stage: StageId, scene: THREE.Scene, camera: THREE.Camera, rect: Rect, clear: string) => {
    applyStageLook(stage);
    ctx.renderCells([{ scene, camera, rect, clear }], null);
  };
  /** Perspective camera fitted to an object's bounds from a view direction. */
  const fit = (obj: THREE.Object3D, dir: THREE.Vector3, rect: Rect, fov = 30, pad = 1.15) => {
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const sph = box.getBoundingSphere(new THREE.Sphere());
    const cam = new THREE.PerspectiveCamera(fov, rect.w / rect.h, 0.1, 5000);
    const vf = (fov * Math.PI) / 180;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * (rect.w / rect.h));
    const d = (sph.radius * pad) / Math.sin(Math.min(vf, hf) / 2);
    cam.position.copy(sph.center).addScaledVector(dir.clone().normalize(), d);
    cam.lookAt(sph.center);
    cam.near = Math.max(0.05, d - sph.radius * 3);
    cam.far = d + sph.radius * 4;
    cam.updateProjectionMatrix();
    return cam;
  };
  const scaleBar = (x: number, y: number, px: number, text: string) => {
    g2.save();
    g2.strokeStyle = palette.hudValue;
    g2.fillStyle = palette.hudValue;
    g2.lineWidth = 2;
    g2.beginPath();
    g2.moveTo(x, y); g2.lineTo(x + px, y);
    g2.moveTo(x, y - 6); g2.lineTo(x, y + 6);
    g2.moveTo(x + px, y - 6); g2.lineTo(x + px, y + 6);
    g2.stroke();
    g2.font = '13px ui-monospace, Menlo, monospace';
    g2.fillText(text, x + px + 8, y + 4);
    g2.restore();
  };
  const header = (text: string, r: Rect) => ctx.label(text, r.x + 6, r.y + 6, palette.hudText);

  // =====================================================================
  // 1) TRUE-SCALE LINE-UP (orthographic): pilot, caltrop, dart, sniper, KESTREL, strider
  // =====================================================================
  const L0: Rect = { x: 12, y: 60, w: 1256, h: 362 };
  {
    const scene = new THREE.Scene();
    const yaw = -0.62;
    const row: [string, Item, number][] = [
      ['PILOT 1.8 m', pilot(), -2],
      ['CALTROP 1.4 m', mk.caltrop(), -8.5],
      ['DART 7 m', mk.dart(), -15],
      ['SNIPER 8 m', mk.sniper(0.4), -26],
      ['KESTREL 12 m (hero)', hero(vid), -40],
      ['STRIDER 16 m', mk.strider(0), -56],
    ];
    const pxPerM = 17;
    const wM = L0.w / pxPerM, hM = L0.h / pxPerM;
    const cam = new THREE.OrthographicCamera(-wM / 2, wM / 2, hM / 2, -hM / 2, -500, 500);
    const camDir = new THREE.Vector3(0, 0.28, -1).normalize();
    cam.position.copy(camDir.clone().multiplyScalar(100)).add(new THREE.Vector3(-(wM / 2 - 3), 6.4, 0));
    cam.lookAt(cam.position.clone().sub(camDir));
    cam.updateMatrixWorld();
    // ground grid (1 m lines, 5 m major) using line tokens
    const grid = new THREE.GridHelper(80, 80, new THREE.Color(palette.hudLine), new THREE.Color(palette.cloudShadow));
    grid.position.set(-40, -0.02, 0);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    scene.add(grid);
    const labels: [string, THREE.Vector3][] = [];
    for (const [name, it, x] of row) {
      settle(it.anim, T);
      const holder = new THREE.Group();
      holder.add(it.obj);
      holder.rotation.y = name.startsWith('PILOT') ? -0.3 : yaw;
      scene.add(holder);
      holder.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(holder);
      holder.position.set(x - (box.min.x + box.max.x) / 2, -box.min.y + (name.startsWith('CALTROP') ? 0.3 : 0), -(box.min.z + box.max.z) / 2);
      holder.updateMatrixWorld(true);
      const b2 = new THREE.Box3().setFromObject(holder);
      labels.push([name, new THREE.Vector3((b2.min.x + b2.max.x) / 2, b2.max.y, (b2.min.z + b2.max.z) / 2)]);
    }
    render('cloudgate', scene, cam, L0, palette.skyDay);
    header('TRUE SCALE LINE-UP  (grid 1 m, Cloudgate light)', L0);
    for (const [name, p] of labels) {
      const v = p.clone().project(cam);
      const sx = L0.x + ((v.x + 1) / 2) * L0.w, sy = L0.y + ((1 - v.y) / 2) * L0.h;
      g2.save();
      g2.font = '14px ui-monospace, Menlo, monospace';
      const w = g2.measureText(name).width + 10;
      g2.restore();
      ctx.label(name, Math.max(L0.x + 4, Math.min(L0.x + L0.w - w - 4, sx - w / 2)), Math.max(L0.y + 30, sy - 30));
    }
    scaleBar(L0.x + 20, L0.y + L0.h - 18, 5 * pxPerM, '5 m');
  }

  // =====================================================================
  // 2) INSETS: caltrop chain (CaltropSwarm), dart pair (DartSquadron), sniper charging, strider from behind
  // =====================================================================
  const insetY = 430, insetH = 282;
  const iw = (1256 - 3 * 8) / 4;
  const insets: Rect[] = [0, 1, 2, 3].map((i) => ({ x: 12 + i * (iw + 8), y: insetY, w: iw, h: insetH }));
  {
    // caltrop: a hero drone plus a chain from the instanced swarm
    const scene = new THREE.Scene();
    const c = mk.caltrop();
    settle(c.anim, T);
    c.obj.rotation.y = Math.PI + 0.35; // front face (-Z) toward camera (+Z side)
    scene.add(c.obj);
    const sw = new CaltropSwarm(16, V.caltrop, 3);
    const q = new THREE.Quaternion().setFromAxisAngle(Y, Math.PI);
    const p = new THREE.Vector3();
    for (let i = 0; i < 10; i++) {
      const u = i / 9;
      p.set(-2.6 + u * 5.4, 1.3 + Math.sin(u * 3.2) * 0.6, -6 - u * 4);
      sw.set(i, p, q, 1, i === 3 ? 1 : 0);
    }
    sw.setCount(10);
    sw.update(T);
    scene.add(sw.mesh);
    const cam = new THREE.PerspectiveCamera(34, iw / insetH, 0.1, 200);
    cam.position.set(0.3, 0.6, 3.1);
    cam.lookAt(0, 0.35, -2);
    render('cloudgate', scene, cam, insets[0], palette.skyDay);
    header('CALTROP 1.4 m + swarm chain', insets[0]);
    ctx.label('4th in chain: hit flash', insets[0].x + 6, insets[0].y + insetH - 26);
  }
  {
    const scene = new THREE.Scene();
    const sq = new DartSquadron(4, V.dart, 5);
    const q1 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, 2.35, -0.35, 'YXZ'));
    const q2 = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 2.25, -0.3, 'YXZ'));
    sq.set(0, new THREE.Vector3(0, 0, 0), q1, 1, 0);
    sq.set(1, new THREE.Vector3(6.5, 1.6, -7), q2, 1, 0);
    sq.setCount(2);
    sq.update(T);
    scene.add(sq.mesh);
    const cam = new THREE.PerspectiveCamera(34, iw / insetH, 0.1, 400);
    cam.position.set(-3.5, 3.2, 12.5);
    cam.lookAt(2.2, 0.2, -2.5);
    render('cloudgate', scene, cam, insets[1], palette.skyDay);
    header('DART 7 m pair (DartSquadron)', insets[1]);
  }
  {
    const scene = new THREE.Scene();
    const s = mk.sniper(0.85);
    settle(s.anim, T);
    s.obj.rotation.y = Math.PI - 0.75;
    s.obj.rotation.x = 0.1;
    scene.add(s.obj);
    const cam = fit(s.obj, new THREE.Vector3(0.1, 0.25, 1), insets[2], 30, 1.0);
    render('violetTide', scene, cam, insets[2], palette.sunsetIndigo);
    header('SNIPER 8 m charge 0.85', insets[2]);
  }
  {
    const scene = new THREE.Scene();
    const s = mk.strider(1);
    settle(s.anim, T);
    s.obj.rotation.y = 0.55; // back 3/4: jetpack + open weak point
    scene.add(s.obj);
    const cam = fit(s.obj, new THREE.Vector3(0.35, -0.05, 1), insets[3], 30, 1.0);
    render('cloudgate', scene, cam, insets[3], palette.skyDay);
    header('STRIDER 16 m back, weak pt open', insets[3]);
  }

  // =====================================================================
  // 3) READABILITY STRIP: each small enemy on cloudCream (Cloudgate) and spaceDeep (Wreckfield)
  // =====================================================================
  const rY = 720, rH = 166;
  const rw = (1256 - 7 * 6) / 8;
  const kinds: [string, () => Item, THREE.Vector3][] = [
    ['CALTROP', () => mk.caltrop(), new THREE.Vector3(0.25, 0.2, -1)],
    ['DART', () => mk.dart(), new THREE.Vector3(-0.9, 0.35, -0.8)],
    ['SNIPER', () => mk.sniper(0.3), new THREE.Vector3(-0.8, 0.2, -0.55)],
    ['STRIDER', () => mk.strider(0), new THREE.Vector3(-0.45, 0.05, -1)],
  ];
  kinds.forEach(([name, f, dir], i) => {
    (['cream', 'space'] as const).forEach((bg, j) => {
      const r: Rect = { x: 12 + (i * 2 + j) * (rw + 6), y: rY, w: rw, h: rH };
      const scene = new THREE.Scene();
      const it = f();
      settle(it.anim, T);
      scene.add(it.obj);
      const cam = fit(it.obj, dir, r, 30, 1.25);
      render(bg === 'cream' ? 'cloudgate' : 'wreckfield', scene, cam, r, bg === 'cream' ? palette.cloudCream : palette.spaceDeep);
      ctx.label(`${name} ${bg}`, r.x + 4, r.y + r.h - 24);
    });
  });
  ctx.label('READABILITY cloudCream vs spaceDeep', 16, rY + 4, palette.hudText);

  // =====================================================================
  // 4) SILHOUETTE ROW (flat black on cloudCream)
  // =====================================================================
  const sY = 894, sH = 174;
  const sil: [string, () => Item, THREE.Vector3][] = [
    ['caltrop', () => mk.caltrop(), new THREE.Vector3(0.3, 0.25, -1)],
    ['dart', () => mk.dart(), new THREE.Vector3(-0.8, 0.9, -0.6)],
    ['sniper', () => mk.sniper(0), new THREE.Vector3(-1, 0.15, -0.35)],
    ['strider', () => mk.strider(0), new THREE.Vector3(-0.2, 0.0, -1)],
    ['bulwark', () => mk.bulwark(), new THREE.Vector3(0, -0.55, -1)],
  ];
  const sw5 = (1256 - 4 * 6) / 5;
  sil.forEach(([name, f, dir], i) => {
    const r: Rect = { x: 12 + i * (sw5 + 6), y: sY, w: sw5, h: sH };
    const scene = new THREE.Scene();
    const it = f();
    settle(it.anim, T);
    setEnemySilhouette(it.obj, true);
    scene.add(it.obj);
    const cam = fit(it.obj, dir, r, 30, 1.08);
    render('cloudgate', scene, cam, r, palette.cloudCream);
    ctx.label(`SILHOUETTE ${name}`, r.x + 4, r.y + 4, palette.hudText);
  });

  // =====================================================================
  // 5) BULWARK column: below/behind in Wreckfield, front/below in Cloudgate, true-scale strip
  // =====================================================================
  const RX = 1280, RW = 628;
  const b1: Rect = { x: RX, y: 60, w: RW, h: 372 };
  const b2: Rect = { x: RX, y: 440, w: RW, h: 272 };
  const b3: Rect = { x: RX, y: 720, w: RW, h: 348 };
  let bulTris = 0, bulVents = 0, bulDraw = 0;
  {
    const scene = new THREE.Scene();
    const bb = buildBulwark(V.bulwark, 13);
    bb.update(1 / 60, { time: T, phase: 2, ventGlow: 1 });
    bulTris = bb.triangles; bulVents = bb.ventCount; bulDraw = countDrawCalls(bb.root);
    scene.add(bb.root);
    const cam = new THREE.PerspectiveCamera(68, RW / b1.h, 1, 3000);
    cam.position.set(-40, -70, 150);
    cam.lookAt(10, -5, -10);
    render('wreckfield', scene, cam, b1, palette.spaceDeep);
    header('BULWARK ~220 m  from below + behind (Wreckfield, chase FOV 68)', b1);
  }
  {
    const scene = new THREE.Scene();
    const bb = buildBulwark(V.bulwark, 13);
    bb.update(1 / 60, { time: T + 0.4, phase: 1, ventGlow: 1, emitterCharge: 0.6 });
    scene.add(bb.root);
    const cam = new THREE.PerspectiveCamera(50, RW / b2.h, 1, 3000);
    cam.position.set(45, -70, -175);
    cam.lookAt(0, -5, 0);
    render('cloudgate', scene, cam, b2, palette.skyDay);
    header('BULWARK front / below: emitters charging (Cloudgate)', b2);
  }
  {
    // true-scale comparison, orthographic front-below view
    const scene = new THREE.Scene();
    const bb = buildBulwark(V.bulwark, 13);
    bb.update(1 / 60, { time: T, phase: 1, ventGlow: 0.9 });
    scene.add(bb.root);
    const st = mk.strider(0);
    settle(st.anim, T);
    st.obj.position.set(-60, -52, -120);
    st.obj.rotation.y = Math.PI;
    scene.add(st.obj);
    const hk = hero(vid);
    hk.obj.position.set(-30, -52, -120);
    hk.obj.rotation.y = Math.PI;
    scene.add(hk.obj);
    const pxPerM = (RW - 40) / 240;
    const wM = RW / pxPerM, hM = b3.h / pxPerM;
    const cam = new THREE.OrthographicCamera(-wM / 2, wM / 2, hM / 2, -hM / 2, -2000, 2000);
    cam.position.set(0, -20, -140); // ortho: close camera so fog does not lift the dark hull
    cam.lookAt(0, -22, 0);
    render('cloudgate', scene, cam, b3, palette.skyHorizon);
    header('TRUE SCALE vs BULWARK (front)', b3);
    const proj = (p: THREE.Vector3) => { const v = p.clone().project(cam); return [b3.x + ((v.x + 1) / 2) * b3.w, b3.y + ((1 - v.y) / 2) * b3.h]; };
    const [sx, sy] = proj(new THREE.Vector3(-60, -60, -120));
    ctx.label('strider', sx - 30, sy + 8);
    const [kx, ky] = proj(new THREE.Vector3(-30, -60, -120));
    ctx.label('KESTREL', kx - 30, ky + 8);
    scaleBar(b3.x + 20, b3.y + b3.h - 20, 50 * pxPerM, `50 m   span ${V.bulwark.span} m`);
  }
  // column frame
  g2.save();
  g2.strokeStyle = withAlpha(palette.hudLine, 0.6);
  g2.lineWidth = 1;
  for (const r of [L0, ...insets, b1, b2, b3]) g2.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  g2.restore();

  // ---- stats for manifests / report
  const stat = (o: THREE.Object3D) => {
    o.updateMatrixWorld(true);
    let tris = 0, outlineTris = 0;
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh) return;
      const n = m.geometry.attributes.position.count / 3;
      if (m.userData.outline) outlineTris += n; else tris += n;
    });
    const b = new THREE.Box3().setFromObject(o);
    const s = b.getSize(new THREE.Vector3());
    return { triangles: Math.round(tris), outlineTriangles: Math.round(outlineTris), drawCalls: countDrawCalls(o), boundsMetres: [s.x, s.y, s.z].map((x) => +x.toFixed(2)) };
  };
  const stats = {
    caltrop: stat(buildCaltrop(V.caltrop, 3).root),
    dart: stat(buildDart(V.dart, 5).root),
    sniper: stat(buildSniper(V.sniper, 7).root),
    strider: stat(buildStrider(V.strider, 11).root),
    bulwark: { ...stat(buildBulwark(V.bulwark, 13).root), ventInstances: bulVents, trianglesInclVents: bulTris, drawCallsBoard: bulDraw },
  };
  console.log('ENEMY_STATS', JSON.stringify(stats));
  ctx.exportParams({ board: 'enemies', variant: vid, name: V.name, look: V.look, params: { ...V, look: undefined }, scaleTokens: scale, stats });
  ctx.ready();
}
