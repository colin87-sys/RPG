/**
 * VFX strip: missile smoke over time (5 frames: t = 0.5, 1.5, 2.5, 3.5, 4.8 s).
 * Two homing missiles curve from bottom-centre toward a distant target, seen from the chase
 * camera (9 m behind, 2.6 m above, FOV 68, slow bank). Simulated in the rail frame with a fixed
 * 1/120 s step; smoke drifts back at 2 m/s. Top row Wreckfield (near-black), bottom row Cloudgate.
 */
import * as THREE from 'three';
import type { LabContext } from '../context';
import { palette, type StageId } from '../../style/tokens';
import { applyStageLook } from '../../gen/common/lighting';
import { SmokeTrails, SMOKE_VARIANTS } from '../../gen/vfx/smoke';
import { Explosions, EXPLOSION_VARIANTS } from '../../gen/vfx/explosions';
import { ParticleBatch, SHAPE, linearRGB } from '../../gen/vfx/particles';
import { LabBackdrop } from '../../gen/vfx/particles-backdrop';

const FRAMES = [0.5, 1.5, 2.5, 3.5, 4.8];
const STEP = 1 / 120;

export default async function board(ctx: LabContext) {
  const v = (['A', 'B', 'C'].includes(ctx.variant) ? ctx.variant : 'A') as 'A' | 'B' | 'C';
  const params = SMOKE_VARIANTS[v];
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(68, 1, 0.3, 3000);

  const smoke = new SmokeTrails(3000, params, 1);
  smoke.wind.set(0, 0, 2);
  scene.add(smoke.group);
  const boom = new Explosions(8, EXPLOSION_VARIANTS[v]);
  scene.add(boom.group);
  const heads = new ParticleBatch(8, { sort: false, name: 'lab-missile-heads', renderOrder: 5 });
  scene.add(heads.mesh);
  const headIn = linearRGB(palette.exhaustCore, 4), headOut = linearRGB(palette.accentOrange, 2);

  const rows: { stage: StageId; bd: LabBackdrop }[] = [
    { stage: 'wreckfield', bd: new LabBackdrop('wreckfield') },
    { stage: 'cloudgate', bd: new LabBackdrop('cloudgate', { clouds: 70, seed: 3 }) },
  ];
  for (const r of rows) scene.add(r.bd.group);

  // missiles (rail frame: craft at origin flying -Z; target ahead, up-right)
  const target = new THREE.Vector3(4, 10, -100);
  const missiles = [-1, 1].map((s, k) => ({
    pos: new THREE.Vector3(1.3 * s, -0.5, -1),
    dir: new THREE.Vector3(0.36 * s, 0.1 + 0.08 * k, -0.85).normalize(),
    trail: smoke.startTrail(),
    alive: true,
  }));
  const speed = 66; // rail-frame speed (110 m/s world minus rail drift, plus curve)
  const toT = new THREE.Vector3();
  const axis = new THREE.Vector3();
  let t = 0;
  let impact = -1;

  const cells = frameRects(ctx);
  ctx.title('VFX strip: missile smoke over time', `variant ${params.name}; 5 s life, 0.8 -> 3.0 m, top Wreckfield / bottom Cloudgate`);
  ctx.clearAll(palette.spaceDeep);

  const setCam = (time: number) => {
    cam.position.set(0, 2.6, 9);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 3.5, -60);
    cam.rotateZ(THREE.MathUtils.degToRad(14 * Math.sin(time * 0.8)));
    cam.rotateY(THREE.MathUtils.degToRad(3 * Math.sin(time * 0.5)));
    cam.updateMatrixWorld();
  };

  for (let f = 0; f < FRAMES.length; f++) {
    while (t < FRAMES[f] - 1e-6) {
      t += STEP;
      setCam(t);
      for (const m of missiles) {
        if (!m.alive) continue;
        // homing with a turn rate that ramps up after launch (long graceful curves)
        const rate = THREE.MathUtils.degToRad(Math.min(140, 20 + 80 * t));
        toT.subVectors(target, m.pos).normalize();
        const ang = m.dir.angleTo(toT);
        if (ang > 1e-4) {
          axis.crossVectors(m.dir, toT).normalize();
          m.dir.applyAxisAngle(axis, Math.min(ang, rate * STEP)).normalize();
        }
        m.pos.addScaledVector(m.dir, speed * STEP);
        smoke.emit(m.trail, m.pos, STEP);
        if (m.pos.distanceTo(target) < 3) {
          m.alive = false;
          smoke.endTrail(m.trail);
          if (impact < 0) {
            impact = t;
            boom.spawn(target, { size: 3, kind: 'big', seed: 42 });
          }
        }
      }
      smoke.update(STEP, cam);
      boom.update(STEP, cam);
    }
    heads.begin();
    for (const m of missiles) {
      if (!m.alive) continue;
      const o = heads.alloc();
      const d = heads.data;
      d.set([m.pos.x, m.pos.y, m.pos.z, 1.6, headIn[0], headIn[1], headIn[2], 1, headOut[0], headOut[1], headOut[2], 0, 0, 0, 0, 1, 0, SHAPE.GLOW, 0.3, 0], o);
    }
    heads.finish(cam);
    rows.forEach((row, ri) => {
      applyStageLook(row.stage);
      rows.forEach((o) => (o.bd.group.visible = o === row));
      row.bd.prepare(cam);
      const rect = cells[ri * FRAMES.length + f];
      ctx.renderCells([{ scene, camera: cam, rect }], null);
      ctx.label(`t=${FRAMES[f].toFixed(1)}s ${row.stage === 'wreckfield' ? 'Wreckfield' : 'Cloudgate'}`, rect.x + 6, rect.y + 6);
    });
    ctx.label(`puffs ${smoke.puffs}`, cells[f].x + 6, cells[f].y + cells[f].h - 26);
  }

  const out = {
    board: 'vfx-smoke',
    variant: v,
    params,
    frames: FRAMES,
    step: STEP,
    wind: [0, 0, 2],
    missileSpeedRailFrame: speed,
    target: target.toArray(),
    impactS: impact,
    drawCalls: { smoke: 1, explosion: 2 },
  };
  ctx.exportParams(out);
  ctx.ready();
}

function frameRects(ctx: LabContext) {
  return ctx.grid(FRAMES.length, 2, 10, 60, 10);
}
