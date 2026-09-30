/**
 * View: maps the rail-space simulation to the three.js scene using the lane
 * modules (craft, enemies, skies, structures, VFX). Owned by the Integrator.
 * step(dt) runs once per simulation step (event-driven spawns, smoke emission);
 * update() runs once per rendered frame (sync instances, particle updates, camera).
 */
import * as THREE from 'three';
import type { Game } from './game';
import { makeFrame } from './rail';
import { T } from '../data/tuning';
import { palette, type StageId } from '../style/tokens';
import { applyStageLook } from '../gen/common/lighting';
import { toonMaterial } from '../gen/common/materials';
import { buildKestrel, KESTREL_VARIANTS, type Kestrel } from '../gen/entities/kestrel';
import {
  ENEMY_VARIANTS, CaltropSwarm, DartSquadron, buildSniper, buildStrider,
  type SniperBuild, type StriderBuild,
} from '../gen/entities/enemies';
import { buildSkyVista } from '../gen/world/sky';
import { CLOUDGATE_VARIANTS, VIOLET_VARIANTS } from '../gen/world/sky/params';
import { buildWreckfield, WRECK_VARIANTS } from '../gen/world/space/wreckfield';
import { buildHullMass, HULL_VARIANTS } from '../gen/world/structures/hullMass';
import { HostileBullets, PlayerShots, HOSTILE_VARIANTS, PLAYER_SHOT_VARIANTS } from '../gen/vfx/projectiles';
import { Beams, BEAM_VARIANTS } from '../gen/vfx/beams';
import { ShockRings, RING_VARIANTS } from '../gen/vfx/rings';
import { SmokeTrails, SMOKE_VARIANTS, SMOKE_EXHAUST } from '../gen/vfx/smoke';
import { Explosions, EXPLOSION_VARIANTS } from '../gen/vfx/explosions';
import { HitPops } from '../gen/vfx/particles-hit';

export const STORY_CAMERAS = ['play', 'hero', 'vista', 'combat', 'hud', 'title'] as const;
export type StoryCamera = (typeof STORY_CAMERAS)[number];

/** Look choices (Reviewer ranking in look/selection.json; frozen in look/approved). */
export const LOOK = { hero: 'B', enemies: 'B', cloudgate: 'C', violet: 'C', wreck: 'C', hull: 'B' } as const;

const V = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const Q = new THREE.Quaternion();
const Q2 = new THREE.Quaternion();
const M = new THREE.Matrix4();
const E = new THREE.Euler();
const frame = makeFrame();

interface WorldSet {
  group: THREE.Group;
  update(cameraPos: THREE.Vector3, time: number): void;
}

export class View {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  storyCam: StoryCamera = 'play';
  readonly craft: Kestrel;
  private caltrops: CaltropSwarm;
  private darts: DartSquadron;
  private snipers: SniperBuild[] = [];
  private striders: StriderBuild[] = [];
  private bigSlots = new Map<number, number>(); // enemy id -> slot (sniper/strider)
  readonly hostile: HostileBullets;
  readonly shots: PlayerShots;
  private missileMesh: THREE.InstancedMesh;
  readonly beams = new Beams(BEAM_VARIANTS.C, 32);
  readonly rings = new ShockRings(RING_VARIANTS.A, 16);
  readonly smoke = new SmokeTrails(4000, SMOKE_VARIANTS.B, 3);
  readonly exhaustTrail = new SmokeTrails(600, SMOKE_EXHAUST, 5);
  readonly explosions = new Explosions(48, EXPLOSION_VARIANTS.A);
  readonly pops = new HitPops(64);
  private world = new Map<StageId, WorldSet>();
  private structures: THREE.Group[] = [];
  private stageId: StageId | null = null;
  private trails = new Map<number, number>(); // missile slot -> trail id
  private beamIds = new Set<number>();
  private exhaustTrailId = -1;
  private pendingDt = 0;
  /** chroma pulse from hits (decays) */
  chromaPulse = 0;
  flash = 0;
  time = 0;

  constructor(private game: Game) {
    this.camera = new THREE.PerspectiveCamera(T.camera.fov, 16 / 9, 0.5, 9000);
    this.craft = buildKestrel(KESTREL_VARIANTS[LOOK.hero], 7);
    this.scene.add(this.craft.root);
    const ev = ENEMY_VARIANTS[LOOK.enemies];
    this.caltrops = new CaltropSwarm(96, ev.caltrop, 3);
    this.darts = new DartSquadron(32, ev.dart, 4);
    this.scene.add(this.caltrops.mesh, this.darts.mesh);
    for (let i = 0; i < 10; i++) {
      const s = buildSniper(ev.sniper, 20 + i);
      s.root.visible = false;
      this.snipers.push(s);
      this.scene.add(s.root);
    }
    for (let i = 0; i < 4; i++) {
      const s = buildStrider(ev.strider, 40 + i);
      s.root.visible = false;
      this.striders.push(s);
      this.scene.add(s.root);
    }
    this.hostile = new HostileBullets(HOSTILE_VARIANTS.B, 320);
    this.shots = new PlayerShots(PLAYER_SHOT_VARIANTS.A, 256);
    this.scene.add(this.hostile.mesh, this.shots.mesh);
    this.missileMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.28, 1.9, 6).rotateX(-Math.PI / 2), toonMaterial({ albedo: palette.armourLight, emissive: palette.exhaustCore, emissiveStrength: 0.2 }), 24);
    this.missileMesh.frustumCulled = false;
    this.missileMesh.count = 0;
    this.scene.add(this.missileMesh);
    this.scene.add(this.beams.group, this.rings.group, this.smoke.group, this.exhaustTrail.group, this.explosions.group, this.pops.group);
    this.bindEvents();
  }

  // ------------------------------------------------------------------ stage world

  private ensureStage(): void {
    const id = this.game.stage.id;
    if (id === this.stageId) return;
    this.stageId = id;
    applyStageLook(id);
    for (const w of this.world.values()) w.group.visible = false;
    let w = this.world.get(id);
    if (!w) {
      if (id === 'wreckfield') {
        const wf = buildWreckfield(WRECK_VARIANTS[LOOK.wreck], 9);
        w = { group: wf.group, update: (c, t) => wf.update(c, t) };
      } else {
        const sv = buildSkyVista(id === 'violetTide' ? VIOLET_VARIANTS[LOOK.violet] : CLOUDGATE_VARIANTS[LOOK.cloudgate], 5);
        w = { group: sv.group, update: (c, t) => sv.update(c, t) };
      }
      this.world.set(id, w);
      this.scene.add(w.group);
    }
    w.group.visible = true;
    // structures along the rail
    for (const g of this.structures) this.scene.remove(g);
    this.structures = [];
    const rail = this.game.rail;
    for (const seg of this.game.stage.structures) {
      const proto = buildHullMass({ ...HULL_VARIANTS[LOOK.hull], side: seg.side } as never, 11);
      const len = proto.lengthMetres;
      const from = seg.from * T.rail.speed, to = seg.to * T.rail.speed;
      for (let s = from; s < to; s += len) {
        const g = s === from ? proto.group : proto.group.clone();
        rail.frameAt(s, frame);
        M.makeBasis(frame.right, frame.up, V.copy(frame.tan).negate());
        g.quaternion.setFromRotationMatrix(M);
        g.position.copy(frame.pos);
        this.scene.add(g);
        this.structures.push(g);
      }
    }
  }

  // ------------------------------------------------------------------ events

  private bindEvents(): void {
    const ev = this.game.events;
    ev.on('enemyKilled', (e) => {
      const w = this.railToWorld(e.pos.z, e.pos.x, e.pos.y, new THREE.Vector3());
      const kind = e.kind === 'strider' || e.kind === 'bulwark' ? 'boss' : e.kind === 'caltrop' ? 'small' : 'big';
      const size = e.kind === 'strider' ? 9 : e.kind === 'caltrop' ? 1.8 : 3.5;
      this.explosions.spawn(w, { size, kind, seed: e.id });
      if (e.big || e.weapon === 'missile') this.rings.spawn(w, { maxRadius: e.big ? 26 : 12, duration: e.big ? 1.2 : 0.8 });
      if (e.big) this.chromaPulse = Math.max(this.chromaPulse, 0.7);
    });
    ev.on('enemyHit', (e) => {
      if (e.weapon === 'cannon' || e.weapon === 'drift') this.pops.spawn(this.railToWorld(e.pos.z, e.pos.x, e.pos.y, new THREE.Vector3()), { scale: 0.8 });
    });
    ev.on('wingtrail', () => {
      const p = this.game.player;
      this.rings.spawn(this.railToWorld(0, p.x, p.y, new THREE.Vector3()), { maxRadius: T.wingtrail.ringMax, duration: 1.0 });
      this.chromaPulse = 1;
    });
    ev.on('parry', () => { this.chromaPulse = Math.max(this.chromaPulse, 0.4); });
    ev.on('playerHit', () => { this.flash = 0.3; this.chromaPulse = Math.max(this.chromaPulse, 0.5); });
    ev.on('stageStart', () => this.resetFx());
  }

  resetFx(): void {
    this.smoke.clear();
    this.exhaustTrail.clear();
    this.explosions.clear();
    this.pops.clear();
    this.rings.clear();
    this.beams.clear();
    this.beamIds.clear();
    this.trails.clear();
    this.exhaustTrailId = -1;
    this.bigSlots.clear();
  }

  railToWorld(u: number, x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
    return this.game.rail.worldOf(this.game.s, u, x, y, out);
  }

  /** orientation at rail offset u, rotated by yaw (about up) and roll (about forward) */
  private railQuat(u: number, yaw: number, roll: number, out: THREE.Quaternion): THREE.Quaternion {
    this.game.rail.frameAt(this.game.s + u, frame);
    M.makeBasis(frame.right, frame.up, V3.copy(frame.tan).negate());
    out.setFromRotationMatrix(M);
    E.set(0, -yaw, -roll, 'YXZ');
    return out.multiply(Q2.setFromEuler(E));
  }

  // ------------------------------------------------------------------ per sim step

  step(dt: number): void {
    const g = this.game;
    this.pendingDt += dt;
    if (g.state !== 'play' && g.state !== 'launch') return;
    // missile smoke (world space, emitted per step so trails stay continuous)
    for (let i = 0; i < g.missiles.length; i++) {
      const m = g.missiles[i];
      const tid = this.trails.get(i);
      if (m.alive && m.launchDelay <= 0) {
        let id = tid;
        if (id === undefined) { id = this.smoke.startTrail(); this.trails.set(i, id); }
        this.smoke.emit(id, this.railToWorld(m.u, m.x, m.y, V), dt);
      } else if (tid !== undefined) {
        this.smoke.endTrail(tid);
        this.trails.delete(i);
      }
    }
    // thin exhaust contrail behind the craft
  }

  // ------------------------------------------------------------------ per render

  update(aspect: number): void {
    const g = this.game;
    this.ensureStage();
    const dt = Math.min(0.1, this.pendingDt);
    this.pendingDt = 0;
    this.time += dt;
    const rail = g.rail, s = g.s, p = g.player;

    // craft
    const craft = this.craft;
    this.railToWorld(0, p.x, p.y, craft.root.position);
    this.railQuat(0, p.yaw, 0, craft.root.quaternion);
    craft.root.visible = g.state !== 'title' && p.alive;
    craft.update(dt, {
      time: this.time, bank: p.bank + p.spin, pitch: p.pitch,
      throttle: p.boost > 0 ? 1.6 : p.braking ? 0.5 : 1, boost: p.boost > 0, drift: p.drift > 0,
      hitFlash: p.hitFlash + (p.invuln > 0 ? 0.25 * (Math.sin(this.time * 40) > 0 ? 1 : 0) : 0),
    });

    // enemies
    let nc = 0, nd = 0;
    const usedS = new Set<number>(), usedT = new Set<number>();
    for (const e of g.enemies) {
      if (!e.alive) continue;
      if (e.b.pattern === 'chain' && e.age < e.b.delay) continue;
      const flash = e.flash > 0 ? 1 : 0;
      this.railToWorld(e.u, e.x, e.y, V);
      if (e.kind === 'caltrop') {
        this.railQuat(e.u, 0, e.roll, Q);
        this.caltrops.set(nc++, V, Q, 1.7, flash); // readability scale (T026)
      } else if (e.kind === 'dart') {
        this.railQuat(e.u, Math.PI, e.roll, Q);
        this.darts.set(nd++, V, Q, 1.3, flash);
      } else {
        const pool = e.kind === 'sniper' ? this.snipers : this.striders;
        const used = e.kind === 'sniper' ? usedS : usedT;
        let slot = this.bigSlots.get(e.id);
        if (slot === undefined || used.has(slot)) {
          slot = pool.findIndex((_, i) => !used.has(i) && ![...this.bigSlots.entries()].some(([id, sl]) => sl === i && id !== e.id && g.enemyById(id)?.kind === e.kind));
          if (slot < 0) continue;
          this.bigSlots.set(e.id, slot);
        }
        used.add(slot);
        const b = pool[slot];
        b.root.visible = true;
        b.root.position.copy(V);
        this.railQuat(e.u, Math.PI + e.yaw, e.roll, b.root.quaternion);
        if (e.kind === 'sniper') {
          let charge = 0;
          for (const l of g.lasers) if (l.alive && l.owner === e.id && l.state === 'telegraph') charge = l.t / l.telegraphS;
          (b as SniperBuild).update(dt, { time: this.time, charge, hitFlash: flash });
        } else {
          (b as StriderBuild).update(dt, { time: this.time, hitFlash: flash, weakPointOpen: e.b.phase === 1 });
        }
      }
    }
    this.snipers.forEach((b, i) => { if (!usedS.has(i)) b.root.visible = false; });
    this.striders.forEach((b, i) => { if (!usedT.has(i)) b.root.visible = false; });
    this.caltrops.setCount(nc);
    this.darts.setCount(nd);
    this.caltrops.update(this.time);
    this.darts.update(this.time);

    // projectiles
    this.hostile.clear();
    let n = 0;
    for (const b of g.bullets) {
      if (!b.alive) continue;
      this.hostile.setInstance(n++, this.railToWorld(b.u, b.x, b.y, V), b.radius * 1.4, 1);
    }
    this.shots.clear();
    n = 0;
    for (const sh of g.shots) {
      if (!sh.alive) continue;
      this.railToWorld(sh.u, sh.x, sh.y, V);
      this.railToWorld(sh.u + sh.vu * 0.01, sh.x + sh.vx * 0.01, sh.y + sh.vy * 0.01, V2);
      this.shots.setInstance(n++, V, V2.sub(V).normalize());
    }
    for (const b of g.bullets) if (b.alive && b.friendly) { /* reflected bullets drawn as hostile-coloured for now */ }
    n = 0;
    for (const m of g.missiles) {
      if (!m.alive || m.launchDelay > 0) continue;
      this.railToWorld(m.u, m.x, m.y, V);
      this.railToWorld(m.u + m.vu * 0.02, m.x + m.vx * 0.02, m.y + m.vy * 0.02, V2);
      Q.setFromUnitVectors(V3.set(0, 0, -1), V2.sub(V).normalize());
      this.missileMesh.setMatrixAt(n++, M.compose(V, Q, V3.set(1, 1, 1)));
    }
    this.missileMesh.count = n;
    this.missileMesh.instanceMatrix.needsUpdate = true;

    // lasers -> beams
    const live = new Set<number>();
    for (const l of g.lasers) {
      if (!l.alive) continue;
      live.add(l.id);
      const L = Math.min(l.length, 420);
      this.railToWorld(l.u0, l.x0, l.y0, V);
      this.railToWorld(l.u0 + l.du * L, l.x0 + l.dx * L, l.y0 + l.dy * L, V2);
      if (!this.beamIds.has(l.id)) { this.beams.add(l.id, V, V2, l.kind); this.beamIds.add(l.id); }
      else this.beams.setEndpoints(l.id, V, V2);
      const t01 = l.state === 'telegraph' ? l.t / l.telegraphS : l.state === 'fire' ? l.t / l.fireS : 1;
      this.beams.setState(l.id, l.state, Math.min(1, t01));
    }
    for (const id of [...this.beamIds]) if (!live.has(id)) { this.beams.remove(id); this.beamIds.delete(id); }

    // camera before particle updates (they billboard to it)
    this.updateCamera(aspect);
    this.beams.update(dt, this.camera);
    this.rings.update(dt, this.camera);
    this.smoke.update(dt, this.camera);
    this.exhaustTrail.update(dt, this.camera);
    this.explosions.update(dt, this.camera);
    this.pops.update(dt, this.camera);
    this.hostile.update(0);
    this.shots.update(0);
    this.chromaPulse = Math.max(0, this.chromaPulse - dt * 2.5);
    this.flash = Math.max(0, this.flash - dt * 3);

    // world (sky/clouds/space) follows the camera
    this.world.get(this.stageId!)?.update(this.camera.position, this.time);
    void rail; void s;
  }

  private updateCamera(aspect: number): void {
    const g = this.game, rail = g.rail, s = g.s, p = g.player, c = g.cam;
    const cam = this.camera;
    cam.aspect = aspect;
    cam.fov = T.camera.fov + c.fovKick;
    let back: number = T.camera.back, up: number = T.camera.up, cx = c.x, cy = c.y, lookU: number = T.camera.lookAhead;
    let lx = c.x + (p.rx - c.x) * 0.3, ly = c.y + (p.ry - c.y) * 0.3, roll = c.roll;
    if (g.state === 'launch') {
      const t = Math.min(1, g.stateT / 2.5), e = 1 - Math.pow(1 - t, 3);
      back = -30 + (T.camera.back + 30) * e; up = 6 - (6 - T.camera.up) * e; lx = p.x; ly = p.y; lookU = e * lookU; roll = 0;
    }
    switch (this.storyCam) {
      case 'hero': back = -16; up = 3; cx = p.x + 9; cy = p.y + 1; lookU = 0; lx = p.x; ly = p.y; roll = 0; break;
      case 'vista': back = 40; up = 16; cx = 0; cy = 0; lookU = 300; lx = 0; ly = 12; roll = 0; break;
      case 'combat': back = 26; up = 7; break;
      case 'title': back = -22; up = 2; cx = p.x - 12; cy = p.y + 1; lookU = 0; lx = p.x; ly = p.y; roll = 0; break;
      default: break;
    }
    const sh = c.shake * Math.sin(c.shakeT * 53), shY = c.shake * Math.cos(c.shakeT * 41);
    rail.worldOf(s, -back, cx + sh, cy + up + shY, cam.position);
    const target = rail.worldOf(s, lookU, lx, ly, V);
    rail.frameAt(s, frame);
    cam.up.copy(frame.up).applyAxisAngle(frame.tan, -roll);
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /** Screen-space (CSS px) position of a rail-space point; null if off-screen/behind. */
  project(u: number, x: number, y: number, w: number, h: number): { x: number; y: number; z: number } | null {
    const v = this.game.rail.worldOf(this.game.s, u, x, y, V).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, z: v.z };
  }

  /** NDC of the rail vanishing point, for speed streaks. */
  vanishing(out: THREE.Vector2): THREE.Vector2 {
    const v = this.game.rail.worldOf(this.game.s, 600, 0, 0, V).project(this.camera);
    return out.set(v.x, v.y);
  }
}
