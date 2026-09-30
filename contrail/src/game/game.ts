/**
 * Game: the deterministic simulation and state machine (title -> launch -> play
 * -> results / gameover). Rail-space combat, combo/shield/score rules, special
 * moves. Rendering lives in view.ts; this file never touches three.js scenes.
 */
import { T, type Difficulty } from '../data/tuning';
import { Rng } from '../core/rng';
import { EventBus, type WeaponKind } from '../core/events';
import type { Input, InputFrame } from '../core/input';
import { Rail } from './rail';
import { CARAVAN_EVENTS, STAGES, type StageDef, type StageEvent } from './stages';
import { ENEMY_DEFS, updateEnemy, weakPointsOf, type Combat, type SpawnSpec } from './enemies';
import {
  makeBullet, makeEnemy, makeLaser, makeMissile, makePickup, makeShot, segDistSq,
  type Bullet, type Enemy, type Laser, type Missile, type Pickup, type Shot,
} from './sim';
import { approach, damageMul, makePlayer, parryOpen, speedMul, updatePlayer, type PlayerState } from './player';
import type { GameStateName, GameStateSnapshot } from '../debug/api';
import * as THREE from 'three';

const PLAYER_RADIUS = 2.4; // [A] was 1.4: zero hits in a full run; craft half-span is 4.5 m
const LOCK_ANGLE = 0.075; // rad (~60 px at 1080p, FOV 68)
const scratchV = new THREE.Vector3();
const weakScratch: { u: number; x: number; y: number }[] = [];
/** laser extras kept on the pooled struct: sweep path and emitter offset from its owner */
type LaserX = Laser & { sweep?: { dx: number; dy: number; tu: number; tx: number; ty: number }; off?: { u: number; x: number; y: number } };

export interface CameraRig {
  x: number;
  y: number;
  roll: number;
  shake: number; // current shake amplitude (m)
  shakeT: number;
  fovKick: number;
}

export interface Results {
  rank: string;
  score: number;
  baseScore: number;
  shieldBonus: number;
  killBonus: number;
  bestCombo: number;
  shieldLeft: number;
  timeS: number;
  kills: number;
  spawned: number;
  cleared: boolean;
}

export class Game implements Combat {
  readonly events = new EventBus();
  readonly stats: Record<string, number> = {};
  rng: Rng;
  seed: number;
  state: GameStateName = 'boot';
  stateT = 0;
  paused = false;
  mode: 'campaign' | 'caravan' = 'campaign';
  difficulty: Difficulty = 'normal';
  stage!: StageDef;
  rail!: Rail;
  s = 0; // rail distance (m)
  stageTime = 0; // world-scaled seconds in play
  worldScale = 1;
  hitStop = 0;
  player: PlayerState = makePlayer();
  cam: CameraRig = { x: 0, y: 0, roll: 0, shake: 0, shakeT: 0, fovKick: 0 };
  readonly enemies: Enemy[] = [];
  readonly bullets: Bullet[] = [];
  readonly shots: Shot[] = [];
  readonly missiles: Missile[] = [];
  readonly lasers: Laser[] = [];
  readonly pickups: Pickup[] = [];
  private nextEvent = 0;
  /** caravan: loops of the wave list already played */
  private loopN = 0;
  /** real seconds in play (caravan timer) */
  playT = 0;
  /** boss bookkeeping: seconds since the boss died (-1 = alive / none) */
  bossDownT = -1;
  bossSpawned = false;
  private nextId = 1;
  score = 0;
  chain = 0;
  comboTimer = 0;
  bestChain = 0;
  refilling = false;
  kills = 0;
  spawned = 0;
  results: Results | null = null;
  prompts: { text: string; age: number }[] = [];
  warning: { text: string; age: number } | null = null;
  ring = { active: false, radius: 0, age: 0, id: 0 };
  invulnerable = false; // debug only
  combatText: { text: string; kind: 'hot' | 'good'; age: number }[] = [];
  private fireFrom = 0; // alternate muzzles
  // Combat interface (enemy behaviours read these)
  playerU = 0;
  playerX = 0;
  playerY = 0;
  playerVX = 0;
  playerVY = 0;
  fireRateMul = 1;

  constructor(seed: number, readonly input: Input) {
    this.seed = seed;
    this.rng = new Rng(seed);
    for (let i = 0; i < 96; i++) this.enemies.push(makeEnemy(0));
    for (let i = 0; i < 320; i++) this.bullets.push(makeBullet());
    for (let i = 0; i < 256; i++) this.shots.push(makeShot());
    for (let i = 0; i < 24; i++) this.missiles.push(makeMissile());
    for (let i = 0; i < 24; i++) this.lasers.push(makeLaser(i));
    for (let i = 0; i < 16; i++) this.pickups.push(makePickup());
    this.loadStage('cloudgate');
    this.setState('title');
  }

  // ------------------------------------------------------------------ state

  setState(to: GameStateName): void {
    const from = this.state;
    this.state = to;
    this.stateT = 0;
    this.events.emit('stateChanged', { from, to });
  }

  loadStage(id: string): void {
    const def = STAGES[id];
    if (!def) throw new Error(`unknown stage '${id}' (defined: ${Object.keys(STAGES).join(', ')})`);
    this.stage = def;
    // Wreckfield debris keeps a clear corridor around the world axis: its rail must stay near it
    const wander = def.id === 'wreckfield' ? { x: 5, y: 3 } : def.id === 'violetTide' ? { x: 35, y: 10 } : { x: 60, y: 18 };
    this.rail = new Rail({ length: def.lengthS * T.rail.speed, wanderX: wander.x, wanderY: wander.y, wavelength: 900, seed: def.railSeed });
  }

  /** Reset everything for a fresh run of the current stage. */
  resetStage(): void {
    this.rng = new Rng(this.seed);
    this.s = 0;
    this.stageTime = 0;
    this.worldScale = 1;
    this.hitStop = 0;
    this.player = makePlayer();
    this.cam = { x: 0, y: 0, roll: 0, shake: 0, shakeT: 0, fovKick: 0 };
    for (const e of this.enemies) { e.alive = false; e.justDied = false; }
    for (const b of this.bullets) b.alive = false;
    for (const s of this.shots) s.alive = false;
    for (const m of this.missiles) m.alive = false;
    for (const l of this.lasers) { l.alive = false; l.state = 'off'; }
    for (const p of this.pickups) p.alive = false;
    this.nextEvent = 0;
    this.loopN = 0;
    this.playT = 0;
    this.bossDownT = -1;
    this.bossSpawned = false;
    this.nextId = 1;
    this.score = 0;
    this.chain = 0;
    this.comboTimer = 0;
    this.bestChain = 0;
    this.refilling = false;
    this.kills = 0;
    this.spawned = 0;
    this.results = null;
    this.prompts = [];
    this.warning = null;
    this.ring = { active: false, radius: 0, age: 0, id: 0 };
    this.combatText = [];
    this.events.resetCounts();
    for (const k of Object.keys(this.stats)) delete this.stats[k];
    const d = T.difficulty[this.difficulty];
    this.fireRateMul = d.fireRate;
  }

  start(opts: { stage?: string; mode?: 'campaign' | 'caravan'; difficulty?: string } = {}): void {
    if (opts.mode) {
      if (opts.mode !== 'campaign' && opts.mode !== 'caravan') throw new Error(`mode '${opts.mode}' not implemented yet`);
      this.mode = opts.mode;
    }
    // Caravan is a 120 s loop of Cloudgate waves (DESIGN Modes)
    if (this.mode === 'caravan') this.loadStage('cloudgate');
    else if (opts.stage) this.loadStage(opts.stage);
    if (opts.difficulty && opts.difficulty in T.difficulty) this.difficulty = opts.difficulty as Difficulty;
    this.resetStage();
    this.setState('launch');
    this.events.emit('stageStart', { stage: this.stage.id });
  }

  // ------------------------------------------------------------------ helpers

  private stat(key: string, n = 1): void {
    this.stats[key] = (this.stats[key] ?? 0) + n;
  }

  /** nominal stage time (s) from rail distance */
  get nominal(): number {
    return this.s / T.rail.speed;
  }

  get progress(): number {
    if (this.mode === 'caravan') return Math.min(1, this.playT / T.caravan.duration);
    return Math.min(1, this.s / (this.stage.lengthS * T.rail.speed));
  }

  get multiplier(): number {
    return Math.min(T.combo.multCap, 1 + T.combo.multPerChain * this.chain);
  }

  enemyById(id: number): Enemy | null {
    for (const e of this.enemies) if (e.alive && e.id === id) return e;
    return null;
  }

  /** Camera position in rail space (for aim and lock geometry). */
  camPos(): { u: number; x: number; y: number } {
    return { u: -T.camera.back, x: this.cam.x, y: this.cam.y + T.camera.up };
  }

  /** Map mouse NDC to reticle rail coordinates on the plane u = reticleDist. */
  aimToRail = (nx: number, ny: number, aspect = 16 / 9) => {
    const c = this.camPos();
    const d = T.move.reticleDist - c.u;
    const th = Math.tan(((T.camera.fov * Math.PI) / 180) / 2);
    return { x: c.x + nx * th * aspect * d, y: c.y + ny * th * d };
  };

  // ------------------------------------------------------------------ spawning

  spawn(spec: SpawnSpec): Enemy | null {
    const e = this.enemies.find((x) => !x.alive);
    if (!e) return null;
    const def = ENEMY_DEFS[spec.kind];
    const d = T.difficulty[this.difficulty];
    e.id = this.nextId++;
    e.alive = true;
    e.kind = spec.kind;
    e.maxHp = e.hp = Math.max(1, Math.round(def.hp * d.hp));
    e.radius = def.radius;
    e.value = def.value;
    e.big = def.big;
    e.u = spec.u; e.x = spec.x; e.y = spec.y;
    e.vu = e.vx = e.vy = 0;
    e.yaw = 0; e.roll = 0; e.age = 0; e.flash = 0; e.locks = 0;
    e.justDied = false; e.lastHitBy = ''; e.driftCd = 0; e.ringHit = -1; e.escaped = false;
    const b = e.b;
    b.pattern = spec.pattern;
    b.index = spec.index ?? 0;
    b.delay = spec.delay ?? 0;
    for (let i = 0; i < b.p.length; i++) b.p[i] = spec.p?.[i] ?? 0;
    b.fireT = 1.0 + this.rng.range(0, 0.8);
    b.phase = 0; b.phaseT = 0; b.ax = 0; b.ay = 0; b.au = 0; b.laserId = -1;
    if (spec.kind === 'bulwark') this.bossSpawned = true;
    this.spawned++;
    return e;
  }

  fireBullet(u: number, x: number, y: number, vu: number, vx: number, vy: number, radius = 0.4, damage: number = T.damage.bullet): void {
    const b = this.bullets.find((q) => !q.alive);
    if (!b) return;
    b.alive = true; b.friendly = false;
    b.u = u; b.x = x; b.y = y; b.vu = vu; b.vx = vx; b.vy = vy;
    b.radius = radius; b.age = 0; b.life = 6; b.damage = damage;
    this.stat('bulletsFired');
  }

  startLaser(
    owner: number, u: number, x: number, y: number, tu: number, tx: number, ty: number, kind: 'laser' | 'boss',
    sweep?: { dx: number; dy: number }, opts?: { telegraph?: number; fire?: number },
  ): number {
    const l = this.lasers.find((q) => !q.alive) as LaserX | undefined;
    if (!l) return -1;
    const L = T.laser;
    l.alive = true; l.owner = owner; l.kind = kind;
    l.u0 = u; l.x0 = x; l.y0 = y;
    const du = tu - u, dx = tx - x, dy = ty - y;
    const len = Math.hypot(du, dx, dy) || 1;
    l.du = du / len; l.dx = dx / len; l.dy = dy / len;
    l.length = len + L.overshoot;
    l.state = 'telegraph'; l.t = 0;
    l.telegraphS = opts?.telegraph ?? L.telegraph;
    l.fireS = opts?.fire ?? (sweep ? L.sweepFire : L.fire);
    l.width = kind === 'boss' ? L.bossWidth : L.width;
    l.damagePerS = kind === 'boss' ? T.damage.bossBeamPerS : T.damage.laserPerS;
    l.sweep = sweep ? { ...sweep, tu, tx, ty } : undefined;
    // the beam origin rides on its emitter (offset from the owner's centre)
    const o = owner >= 0 ? this.enemyById(owner) : null;
    l.off = o ? { u: u - o.u, x: x - o.x, y: y - o.y } : undefined;
    this.events.emit('laserTelegraph', { id: l.id });
    return l.id;
  }

  spawnWave(specs: SpawnSpec[]): void {
    for (const sp of specs) this.spawn(sp);
  }

  bossPhase(phase: number): void {
    this.events.emit('bossPhase', { phase });
    this.stat(`bossPhase${phase}`);
    const text = phase === 1 ? '// BULWARK ENGAGED //' : phase === 2 ? '// BULWARK: VENTS OPEN //' : '// BULWARK: BEAM WALL //';
    this.warning = { text, age: 0 };
    this.events.emit('warning', { text, on: true });
  }

  /** The living boss, if any. */
  boss(): Enemy | null {
    for (const e of this.enemies) if (e.alive && e.kind === 'bulwark') return e;
    return null;
  }

  /** Rail-space weak points of an enemy (BULWARK only; empty otherwise). */
  weakPoints(e: Enemy): { u: number; x: number; y: number }[] {
    if (e.kind !== 'bulwark') return [];
    const n = weakPointsOf(e, weakScratch);
    return weakScratch.slice(0, n);
  }

  // ------------------------------------------------------------------ update

  update(dt: number): void {
    const inp = this.input.poll(this.frameCounter++);
    this.stateT += dt;
    switch (this.state) {
      case 'title':
        if (this.input.pressed('confirm')) this.start({ stage: 'cloudgate', mode: 'campaign' });
        return;
      case 'launch':
        this.updateLaunch(dt);
        return;
      case 'play':
        if (this.input.pressed('pause')) this.paused = !this.paused;
        if (this.paused) return;
        this.updatePlay(dt, inp);
        return;
      case 'results':
        this.ageTexts(dt);
        if (this.stateT > 1.5 && this.input.pressed('confirm')) {
          // campaign: advance to the next stage after a clear; otherwise back to the title
          const order = ['cloudgate', 'violetTide', 'wreckfield'];
          const i = order.indexOf(this.stage.id);
          if (this.mode === 'campaign' && this.results?.cleared && i >= 0 && i < order.length - 1) this.start({ stage: order[i + 1], mode: 'campaign' });
          else this.setState('title');
        }
        return;
      case 'gameover':
        if (this.stateT > 0.8 && this.input.pressed('confirm')) { this.start({}); this.launchS = 0.8; } // quick retry (A13 < 2 s)
        return;
      default:
        return;
    }
  }

  frameCounter = 0;
  private hullAcc = 0;
  /** launch intro length: 2.5 s from the title, 0.8 s on a retry */
  launchS = 2.5;

  /** debug: end the run now (harness A13 retry timing) */
  forceGameOver(): void {
    if (this.state !== 'play' && this.state !== 'launch') return;
    this.player.shield = 0;
    this.player.alive = false;
    this.setState('gameover');
    this.events.emit('playerDown', {});
  }

  private updateLaunch(dt: number): void {
    // the craft settles into the chase position while the camera swoops in
    this.s += T.rail.speed * dt * Math.min(1, this.stateT / (this.launchS - 0.1));
    this.cam.x += (0 - this.cam.x) * approach(0.3, dt);
    if (this.stateT >= this.launchS) {
      this.launchS = 2.5;
      this.setState('play');
    }
  }

  private edges() {
    const i = this.input;
    return { rollL: i.pressed('rollLeft'), rollR: i.pressed('rollRight'), drift: i.pressed('drift'), wing: i.pressed('wingtrail'), boost: i.pressed('boost') };
  }

  private updatePlay(dt: number, inp: InputFrame): void {
    const p = this.player;
    // hit-stop freezes the world for a few frames on heavy impacts
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      return;
    }
    this.worldScale = p.drift > 0 ? T.drift.timeScale : p.wingtrail > 0 ? T.wingtrail.timeScale : 1;
    const wdt = dt * this.worldScale;
    this.stageTime += wdt;
    this.playT += dt;

    // --- player ---
    const pev = updatePlayer(p, inp, this.edges(), dt, (nx, ny) => this.aimToRail(nx, ny));
    this.playerX = p.x;
    this.playerY = p.y;
    this.playerVX = p.vx;
    this.playerVY = p.vy;
    if (pev.rollStarted) this.events.emit('roll', { dir: p.rollDir, parried: false });
    if (pev.driftStarted) { this.events.emit('drift', { active: true }); this.stat('driftStarted'); }
    if (pev.driftEnded) this.events.emit('drift', { active: false });
    if (pev.boostStarted) this.events.emit('boost', { active: true });
    if (pev.wingtrailStarted) {
      this.ring = { active: true, radius: 0, age: 0, id: this.ring.id + 1 };
      this.events.emit('wingtrail', { pos: scratchV.set(p.x, p.y, 0) });
      this.cam.shake = Math.max(this.cam.shake, 0.08);
    }

    // --- rail advance ---
    this.s += T.rail.speed * speedMul(p) * wdt;
    this.cam.fovKick += ((p.boost > 0 ? T.camera.fovKickBoost : 0) - this.cam.fovKick) * approach(0.2, dt);

    // --- stage script ---
    if (this.mode === 'caravan') {
      // 120 s loop of Cloudgate waves at x1.4 density; wraps if the list runs out
      const ev = CARAVAN_EVENTS.events;
      const t = this.nominal - this.loopN * CARAVAN_EVENTS.loopS;
      while (this.nextEvent < ev.length && ev[this.nextEvent].at <= t) this.runEvent(ev[this.nextEvent++]);
      if (this.nextEvent >= ev.length && t >= CARAVAN_EVENTS.loopS) { this.loopN++; this.nextEvent = 0; }
    } else {
      const ev = this.stage.events;
      while (this.nextEvent < ev.length && ev[this.nextEvent].at <= this.nominal) this.runEvent(ev[this.nextEvent++]);
    }

    // --- weapons ---
    this.updateCannon(dt, inp);
    this.updateLocks(dt, inp);
    this.updateShots(dt);
    this.updateMissiles(dt);

    // --- world ---
    this.updateEnemies(wdt);
    this.updateBullets(wdt);
    this.updateLasers(wdt, dt);
    this.updateDrift(dt);
    this.updateRing(dt);
    this.updatePickups(wdt);
    this.updateCombo(wdt, dt);
    this.ageTexts(dt);

    // --- camera rig (deterministic, in sim) ---
    this.cam.x += (p.x * T.camera.followX - this.cam.x) * approach(T.camera.lag, dt);
    this.cam.y += (p.y * T.camera.followY - this.cam.y) * approach(T.camera.lag, dt);
    this.cam.roll += (p.bank * T.camera.rollFraction - this.cam.roll) * approach(0.15, dt);
    if (this.cam.shake > 0) this.cam.shake = Math.max(0, this.cam.shake - (T.camera.shakeMax / T.camera.shakeDecay) * dt);
    this.cam.shakeT += dt;

    // --- end conditions ---
    if (!p.alive) {
      this.setState('gameover');
      this.events.emit('playerDown', {});
      return;
    }
    if (this.mode === 'caravan') {
      if (this.playT >= T.caravan.duration) this.finishStage();
      return;
    }
    if (this.stage.boss) {
      // boss stage: ends after the kill (outro), or fails if the rail runs out first (boss escaped)
      if (this.bossDownT >= 0) {
        this.bossDownT += dt;
        if (this.bossDownT >= T.behaviour.bulwark.outro) this.finishStage();
      } else if (this.s >= this.stage.lengthS * T.rail.speed) {
        this.finishStage(false);
      }
      return;
    }
    if (this.s >= this.stage.lengthS * T.rail.speed) this.finishStage();
  }

  private runEvent(e: StageEvent): void {
    if (e.spawn) for (const sp of e.spawn) this.spawn(sp);
    if (e.prompt) this.prompts.push({ text: e.prompt, age: 0 });
    if (e.warning) {
      this.warning = { text: e.warning, age: 0 };
      this.events.emit('warning', { text: e.warning, on: true });
    }
    if (e.pickups)
      for (const pk of e.pickups) {
        if (this.mode === 'caravan' && pk.kind === 'shield') continue; // no shield regen except combo
        const q = this.pickups.find((x) => !x.alive);
        if (!q) continue;
        q.alive = true; q.kind = pk.kind; q.u = 180; q.x = pk.x; q.y = pk.y; q.vu = -30; q.age = 0;
      }
  }

  private updateCannon(dt: number, inp: InputFrame): void {
    const p = this.player;
    p.fireCd -= dt;
    if (!inp.fire || p.drift > 0 || p.wingtrail > 0) return;
    while (p.fireCd <= 0) {
      p.fireCd += 1 / T.cannon.rate;
      const s = this.shots.find((q) => !q.alive);
      if (!s) return;
      const side = (this.fireFrom = 1 - this.fireFrom) ? 1 : -1;
      const ox = p.x + side * 1.6, oy = p.y - 0.2, ou = 3;
      // aim through the reticle point
      const tu = T.move.reticleDist, tx = p.rx, ty = p.ry;
      let du = tu - ou, dx = tx - ox, dy = ty - oy;
      const l = Math.hypot(du, dx, dy);
      du /= l; dx /= l; dy /= l;
      dx += this.rng.signed() * T.cannon.spread;
      dy += this.rng.signed() * T.cannon.spread;
      s.alive = true;
      s.u = ou; s.x = ox; s.y = oy;
      s.vu = du * T.cannon.speed; s.vx = dx * T.cannon.speed; s.vy = dy * T.cannon.speed;
      s.travelled = 0;
      s.damage = T.cannon.damage;
      this.events.emit('cannonFire', { pos: scratchV.set(ox, oy, ou) });
    }
  }

  private updateLocks(dt: number, inp: InputFrame): void {
    const p = this.player;
    if (inp.lock && p.drift <= 0 && p.wingtrail <= 0) {
      p.lockHeld = true;
      p.lockTimer += dt;
      while (p.lockTimer >= T.missiles.lockInterval) {
        p.lockTimer -= T.missiles.lockInterval;
        if (p.lockTargets.length >= Math.min(T.missiles.maxLocks, p.missiles)) break;
        const target = this.findLockTarget();
        if (!target) break;
        target.locks++;
        p.lockTargets.push(target.id);
        this.events.emit('lockAdded', { targetId: target.id, count: p.lockTargets.length });
      }
    } else if (p.lockHeld) {
      p.lockHeld = false;
      p.lockTimer = 0;
      if (p.lockTargets.length > 0) this.launchMissiles();
    }
  }

  /** Best target in the lock cone around the reticle ray that still needs locks. */
  private findLockTarget(): Enemy | null {
    const c = this.camPos();
    const p = this.player;
    let ru = T.move.reticleDist - c.u, rx = p.rx - c.x, ry = p.ry - c.y;
    const rl = Math.hypot(ru, rx, ry);
    ru /= rl; rx /= rl; ry /= rl;
    let best: Enemy | null = null;
    let bestScore = Infinity;
    for (const e of this.enemies) {
      if (!e.alive || e.u < 8 || e.u > 260) continue;
      if (e.b.pattern === 'chain' && e.age < e.b.delay) continue;
      const need = Math.ceil(e.hp / T.missiles.damage);
      if (e.locks >= need) continue;
      let eu = e.u - c.u, ex = e.x - c.x, ey = e.y - c.y;
      const el = Math.hypot(eu, ex, ey);
      eu /= el; ex /= el; ey /= el;
      const ang = Math.acos(Math.max(-1, Math.min(1, eu * ru + ex * rx + ey * ry)));
      const cone = LOCK_ANGLE + Math.atan(e.radius / el);
      if (ang > cone) continue;
      const score = ang + e.locks * 0.02;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  private launchMissiles(): void {
    const p = this.player;
    const n = p.lockTargets.length;
    for (let i = 0; i < n; i++) {
      const m = this.missiles.find((q) => !q.alive);
      if (!m) break;
      const side = i % 2 === 0 ? -1 : 1;
      m.alive = true;
      m.targetId = p.lockTargets[i];
      m.u = 1; m.x = p.x + side * 2.2; m.y = p.y - 0.6;
      // launch kick outward and up, then home
      m.vu = 40; m.vx = side * (14 + (i >> 1) * 3); m.vy = 10 + (i >> 1) * 2;
      m.age = 0;
      m.launchDelay = i * T.missiles.launchStagger;
      m.trailId = -1;
      m.seed = this.rng.nextU32();
      p.missiles--;
    }
    this.events.emit('missileFire', { count: n });
    this.stat('missilesFired', n);
    p.lockTargets.length = 0;
  }

  private updateShots(dt: number): void {
    for (const s of this.shots) {
      if (!s.alive) continue;
      s.u += s.vu * dt; s.x += s.vx * dt; s.y += s.vy * dt;
      s.travelled += T.cannon.speed * dt;
      if (s.travelled > T.cannon.range) { s.alive = false; continue; }
      for (const e of this.enemies) {
        if (!e.alive) continue;
        if (e.kind === 'bulwark' && this.weakHit(e, s.u - s.vu * dt, s.x - s.vx * dt, s.y - s.vy * dt, s.vu / T.cannon.speed, s.vx / T.cannon.speed, s.vy / T.cannon.speed, T.cannon.speed * dt, T.cannon.radius)) {
          s.alive = false;
          this.damageEnemy(e, s.damage * T.behaviour.bulwark.weakMul, 'cannon');
          this.stat('bossWeakHits');
          break;
        }
        const r = e.radius + T.cannon.radius;
        const du = e.u - s.u, dx = e.x - s.x, dy = e.y - s.y;
        // swept test along the shot's last step to avoid tunnelling
        if (Math.abs(du) > r + T.cannon.speed * dt) continue;
        const d2 = segDistSq(e.u, e.x, e.y, s.u - s.vu * dt, s.x - s.vx * dt, s.y - s.vy * dt, s.vu / T.cannon.speed, s.vx / T.cannon.speed, s.vy / T.cannon.speed, T.cannon.speed * dt);
        if (d2 <= r * r || du * du + dx * dx + dy * dy <= r * r) {
          s.alive = false;
          this.damageEnemy(e, s.damage, 'cannon');
          break;
        }
      }
    }
  }

  private updateMissiles(dt: number): void {
    const M = T.missiles;
    for (const m of this.missiles) {
      if (!m.alive) continue;
      if (m.launchDelay > 0) { m.launchDelay -= dt; continue; }
      m.age += dt;
      let tgt = this.enemyById(m.targetId);
      if (!tgt) {
        // retarget the nearest living enemy ahead
        let best: Enemy | null = null, bd = Infinity;
        for (const e of this.enemies) {
          if (!e.alive || e.u < m.u) continue;
          const d = (e.u - m.u) ** 2 + (e.x - m.x) ** 2 + (e.y - m.y) ** 2;
          if (d < bd) { bd = d; best = e; }
        }
        tgt = best;
        if (best) m.targetId = best.id;
      }
      const sp = Math.hypot(m.vu, m.vx, m.vy) || 1;
      let du = m.vu / sp, dx = m.vx / sp, dy = m.vy / sp;
      if (tgt) {
        let tu = tgt.u - m.u, tx = tgt.x - m.x, ty = tgt.y - m.y;
        const tl = Math.hypot(tu, tx, ty) || 1;
        tu /= tl; tx /= tl; ty /= tl;
        const dot = Math.max(-1, Math.min(1, du * tu + dx * tx + dy * ty));
        const ang = Math.acos(dot);
        const maxTurn = M.turnRate * dt * (m.age < 0.25 ? 0.5 : 1);
        if (ang <= maxTurn || ang < 1e-5) { du = tu; dx = tx; dy = ty; }
        else {
          // rotate d toward t by maxTurn
          let pu = tu - du * dot, px = tx - dx * dot, py = ty - dy * dot;
          const pl = Math.hypot(pu, px, py) || 1;
          pu /= pl; px /= pl; py /= pl;
          const c = Math.cos(maxTurn), s = Math.sin(maxTurn);
          du = du * c + pu * s; dx = dx * c + px * s; dy = dy * c + py * s;
        }
      }
      const speed = Math.min(M.speed, sp + 220 * dt);
      m.vu = du * speed; m.vx = dx * speed; m.vy = dy * speed;
      m.u += m.vu * dt; m.x += m.vx * dt; m.y += m.vy * dt;
      if (tgt) {
        const r = tgt.radius + 1.2;
        if ((tgt.u - m.u) ** 2 + (tgt.x - m.x) ** 2 + (tgt.y - m.y) ** 2 <= r * r) {
          m.alive = false;
          tgt.locks = Math.max(0, tgt.locks - 1);
          this.events.emit('missileHit', { pos: scratchV.set(m.x, m.y, m.u), targetId: tgt.id });
          this.damageEnemy(tgt, M.damage, 'missile');
          if (!tgt.alive) this.hitStop = Math.max(this.hitStop, T.feedback.hitStopMissile);
          continue;
        }
      }
      if (m.age > M.maxFlight || m.u > 400 || m.u < -40) m.alive = false;
    }
  }

  private updateEnemies(wdt: number): void {
    const p = this.player;
    for (const e of this.enemies) {
      if (e.justDied) e.justDied = false;
      if (!e.alive) continue;
      if (!updateEnemy(e, wdt, this)) {
        e.alive = false;
        continue;
      }
      if (e.driftCd > 0) e.driftCd -= wdt;
      // contact with the player
      const r = e.radius * 0.8 + PLAYER_RADIUS;
      if (e.u > -3 && e.u < 3 + e.radius) {
        const d2 = e.u * e.u + (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
        if (d2 < r * r && !(e.b.pattern === 'chain' && e.age < e.b.delay)) {
          if (p.drift > 0 || p.wingtrail > 0) continue; // specials are invulnerable passes
          this.hurtPlayer(ENEMY_DEFS[e.kind].contactDamage, 'collision', null);
          if (!e.big) this.damageEnemy(e, 99, 'collision');
        }
      }
    }
  }

  private updateBullets(wdt: number): void {
    const p = this.player;
    for (const b of this.bullets) {
      if (!b.alive) continue;
      b.age += wdt;
      b.u += b.vu * wdt; b.x += b.vx * wdt; b.y += b.vy * wdt;
      if (b.age > b.life || b.u < -30 || b.u > 400) { b.alive = false; continue; }
      if (b.friendly) {
        for (const e of this.enemies) {
          if (!e.alive) continue;
          const r = e.radius + b.radius;
          if ((e.u - b.u) ** 2 + (e.x - b.x) ** 2 + (e.y - b.y) ** 2 <= r * r) {
            b.alive = false;
            this.damageEnemy(e, 3, 'parry');
            break;
          }
        }
        continue;
      }
      const r = b.radius + PLAYER_RADIUS * 0.75;
      if (b.u > -2 && b.u < 2) {
        const d2 = b.u * b.u + (b.x - p.x) ** 2 + (b.y - p.y) ** 2;
        if (d2 <= r * r) {
          if (parryOpen(p)) {
            this.parry(b);
          } else if (p.boost > 0) {
            b.alive = false; // boost deflects
            this.stat('deflect');
          } else if (p.drift > 0 || p.wingtrail > 0) {
            b.alive = false;
          } else {
            b.alive = false;
            this.hurtPlayer(b.damage, 'bullet', b);
          }
        }
      }
    }
  }

  private parry(b: Bullet | null): void {
    const p = this.player;
    if (b) {
      // reflect back toward the nearest enemy (or straight ahead)
      let best: Enemy | null = null, bd = Infinity;
      for (const e of this.enemies) {
        if (!e.alive || e.u < 5) continue;
        const d = e.u * e.u + (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
        if (d < bd) { bd = d; best = e; }
      }
      const tu = best ? best.u : 150, tx = best ? best.x : b.x, ty = best ? best.y : b.y;
      const du = tu - b.u, dx = tx - b.x, dy = ty - b.y;
      const l = Math.hypot(du, dx, dy) || 1;
      b.friendly = true;
      b.vu = (du / l) * 120; b.vx = (dx / l) * 120; b.vy = (dy / l) * 120;
      b.age = 0;
    }
    if (!p.rollParried) {
      p.rollParried = true;
      if (this.mode !== 'caravan') p.shield = Math.min(T.shield.max, p.shield + T.roll.parryShield);
      this.score += T.roll.parryScore;
      this.addChain(1);
      this.combatText.push({ text: `PARRY +${T.roll.parryScore}`, kind: 'good', age: 0 });
    }
    this.events.emit('parry', { pos: scratchV.set(p.x, p.y, 0) });
    this.stat('parries');
  }

  private updateLasers(wdt: number, dt: number): void {
    const p = this.player;
    for (const l of this.lasers) {
      if (!l.alive) continue;
      l.t += wdt;
      const owner = l.owner >= 0 ? this.enemyById(l.owner) : null;
      if (l.owner >= 0 && !owner && l.state === 'telegraph') { l.alive = false; l.state = 'off'; continue; }
      const lx = l as LaserX;
      if (owner) {
        const o = lx.off;
        l.u0 = owner.u + (o ? o.u : -2); l.x0 = owner.x + (o ? o.x : 0); l.y0 = owner.y + (o ? o.y : 0);
      }
      const sw = lx.sweep;
      if (l.state === 'telegraph') {
        if (l.t >= l.telegraphS) {
          l.state = 'fire';
          l.t = 0;
          this.events.emit('laserFire', { id: l.id });
        }
      } else if (l.state === 'fire') {
        if (sw) {
          const f = Math.min(1, l.t / l.fireS);
          const tu = sw.tu, tx = sw.tx + sw.dx * f, ty = sw.ty + sw.dy * f;
          const du = tu - l.u0, dx = tx - l.x0, dy = ty - l.y0;
          const len = Math.hypot(du, dx, dy) || 1;
          l.du = du / len; l.dx = dx / len; l.dy = dy / len;
        }
        const r = l.width + PLAYER_RADIUS * 0.6;
        const d2 = segDistSq(0, p.x, p.y, l.u0, l.x0, l.y0, l.du, l.dx, l.dy, l.length);
        if (d2 <= r * r) {
          if (parryOpen(p) || p.rollParried && p.rolling > 0) this.parry(null);
          else if (p.drift > 0 || p.wingtrail > 0) { /* invulnerable pass */ }
          else this.hurtPlayer(l.damagePerS * Math.max(dt, 1 / 60) * 6, 'laser', null, true);
        }
        if (l.t >= l.fireS) { l.state = 'off'; l.t = 0; }
      } else {
        if (l.t > 0.25) l.alive = false;
      }
    }
  }

  private updateDrift(dt: number): void {
    const p = this.player;
    if (p.drift <= 0) return;
    // exhaust capsule: from the craft along the exhaust direction (yaw swings it sideways/forward)
    const yaw = p.yaw;
    const eu = Math.cos(yaw + Math.PI) * -1; // exhaust points backward (u<0) at yaw 0, forward at yaw pi
    const ex = Math.sin(yaw) * -1;
    const du = -Math.cos(yaw), dx = -Math.sin(yaw) * 1;
    void eu; void ex;
    const len = T.drift.capsuleLength + 8; // [A] tuned: reach enemies slowed near the craft
    const rad = T.drift.capsuleRadius;
    for (const e of this.enemies) {
      if (!e.alive || e.driftCd > 0) continue;
      const d2 = segDistSq(e.u, e.x, e.y, 0, p.x, p.y, du, dx, 0, len);
      const r = rad + e.radius;
      if (d2 <= r * r) {
        e.driftCd = 1 / T.drift.tickRate;
        this.damageEnemy(e, T.drift.tickDamage, 'drift');
      }
    }
    void dt;
  }

  private updateRing(dt: number): void {
    const R = this.ring;
    if (!R.active) return;
    R.age += dt;
    R.radius = T.wingtrail.ringMax * Math.min(1, R.age / T.wingtrail.ringGrow);
    const p = this.player;
    for (const e of this.enemies) {
      if (!e.alive || e.ringHit === R.id) continue;
      if (e.kind === 'bulwark') {
        // the shock ring fills the screen at full size: it strikes the boss weak points once [A]
        if (R.age >= T.wingtrail.ringGrow) { e.ringHit = R.id; this.damageEnemy(e, T.wingtrail.damageBossWeak, 'wingtrail'); this.stat('bossWeakHits'); }
        continue;
      }
      const d = Math.hypot(e.u, e.x - p.x, e.y - p.y);
      if (d - e.radius <= R.radius) {
        e.ringHit = R.id;
        const weak = e.kind === 'strider' && e.b.phase === 1;
        this.damageEnemy(e, weak ? T.wingtrail.damageBossWeak : T.wingtrail.damageSmall, 'wingtrail');
      }
    }
    for (const b of this.bullets) {
      if (!b.alive || b.friendly) continue;
      if (Math.hypot(b.u, b.x - p.x, b.y - p.y) <= R.radius) b.alive = false;
    }
    if (R.age > T.wingtrail.ringGrow + 0.4) R.active = false;
  }

  private updatePickups(wdt: number): void {
    const p = this.player;
    for (const q of this.pickups) {
      if (!q.alive) continue;
      q.age += wdt;
      q.u += q.vu * wdt;
      const d = Math.hypot(q.u, q.x - p.x, q.y - p.y);
      if (p.braking && d < T.brake.magnetRadius) {
        const k = Math.min(1, wdt * 4);
        q.u += (0 - q.u) * k; q.x += (p.x - q.x) * k; q.y += (p.y - q.y) * k;
      }
      if (d < 3.2) {
        q.alive = false;
        if (q.kind === 'shield') p.shield = Math.min(T.shield.max, p.shield + 25);
        else p.missiles = Math.min(T.missiles.ammo + 2, p.missiles + 2);
        this.events.emit('pickup', { kind: q.kind, pos: scratchV.set(q.x, q.y, q.u) });
      } else if (q.u < -20) q.alive = false;
    }
  }

  private addChain(n: number): void {
    this.chain += n;
    this.comboTimer = this.chain <= n ? T.combo.window : Math.min(T.combo.cap, this.comboTimer + T.combo.perKill * n);
    if (this.chain > this.bestChain) this.bestChain = this.chain;
    this.events.emit('comboChanged', { chain: this.chain, refill: this.chain >= T.combo.refillThreshold });
  }

  private updateCombo(wdt: number, dt: number): void {
    const p = this.player;
    if (this.chain > 0) {
      this.comboTimer -= wdt;
      if (this.comboTimer <= 0) {
        this.chain = 0;
        this.comboTimer = 0;
        this.refilling = false;
        this.events.emit('comboChanged', { chain: 0, refill: false });
      }
    }
    const refillNow = this.chain >= T.combo.refillThreshold && p.shield < T.shield.max;
    if (refillNow) {
      const amt = T.combo.refillPerS * dt;
      p.shield = Math.min(T.shield.max, p.shield + amt);
      if (!this.refilling) this.events.emit('shieldRefill', { amount: amt });
      this.stat('shieldRefilled', amt);
    }
    this.refilling = refillNow;
  }

  private ageTexts(dt: number): void {
    for (const t of this.prompts) t.age += dt;
    this.prompts = this.prompts.filter((t) => t.age < 4.5);
    for (const t of this.combatText) t.age += dt;
    this.combatText = this.combatText.filter((t) => t.age < 1.6);
    if (this.warning) {
      this.warning.age += dt;
      if (this.warning.age > 3.2) {
        this.events.emit('warning', { text: this.warning.text, on: false });
        this.warning = null;
      }
    }
  }

  // ------------------------------------------------------------------ damage

  damageEnemy(e: Enemy, dmg: number, weapon: WeaponKind): void {
    if (!e.alive) return;
    let d = dmg;
    if (e.kind === 'strider' && e.b.phase === 1) d *= 2.5; // back exposed
    e.hp -= d;
    e.flash = T.feedback.hitFlashFrames;
    e.lastHitBy = weapon;
    this.events.emit('enemyHit', { id: e.id, pos: scratchV.set(e.x, e.y, e.u), damage: d, weapon });
    if (e.hp <= 0) this.killEnemy(e, weapon);
  }

  private killEnemy(e: Enemy, weapon: WeaponKind): void {
    e.alive = false;
    e.justDied = true;
    this.kills++;
    this.addChain(1);
    const pts = Math.round(e.value * this.multiplier);
    this.score += pts;
    const p = this.player;
    p.wingKills++;
    if (p.wingKills >= T.wingtrail.killsToCharge) p.wingCharge = 1;
    if (e.kind === 'bulwark') {
      this.bossDownT = 0;
      // the wreck takes its beams with it
      for (const l of this.lasers) if (l.alive && l.owner === e.id) { l.alive = false; l.state = 'off'; }
      this.stat('bossKilled');
    }
    if (e.big) {
      this.hitStop = Math.max(this.hitStop, T.feedback.hitStopBossWeak);
      this.cam.shake = Math.max(this.cam.shake, T.camera.shakeMax);
    }
    // release lock bookkeeping on the dead target
    this.stat(`enemyKilled:${weapon}`);
    this.stat(`killed:${e.kind}`);
    this.events.emit('enemyKilled', { id: e.id, kind: e.kind, pos: scratchV.set(e.x, e.y, e.u), value: pts, weapon, big: e.big });
    if (this.chain >= 2) {
      // one live chain line: replace the previous one instead of stacking
      this.combatText = this.combatText.filter((c) => !c.text.endsWith(' CHAIN'));
      this.combatText.push({ text: `${this.chain} CHAIN`, kind: this.chain >= T.combo.refillThreshold ? 'good' : 'hot', age: 0 });
    }
  }

  hurtPlayer(dmg: number, source: string, _b: Bullet | null, continuous = false): void {
    const p = this.player;
    if (this.invulnerable) return;
    if (p.invuln > 0 && !continuous) return;
    if (continuous && p.invuln > 0 && p.invuln < T.shield.invuln - 0.25) return;
    const d = dmg * damageMul(p);
    p.shield -= d;
    p.damageTaken += d;
    if (!continuous || p.invuln <= 0) p.invuln = T.shield.invuln;
    p.hitFlash = 1;
    this.cam.shake = Math.max(this.cam.shake, T.camera.shakeMax * 0.8);
    this.events.emit('playerHit', { damage: d, source, pos: scratchV.set(p.x, p.y, 0) });
    // one live hull line: continuous damage (lasers) accumulates instead of stacking lines
    const prev = this.combatText.find((c) => c.text.startsWith('HULL -') && c.age < 0.8);
    this.hullAcc = (prev ? this.hullAcc : 0) + d;
    if (prev) { prev.text = `HULL -${Math.max(1, Math.round(this.hullAcc))}`; prev.age = 0; }
    else if (this.hullAcc >= 0.5) this.combatText.push({ text: `HULL -${Math.max(1, Math.round(this.hullAcc))}`, kind: 'hot', age: 0 });
    if (p.shield <= 0) {
      p.shield = 0;
      p.alive = false;
    }
  }

  /** true when the segment (a + t*d, t in [0,len]) passes within a weak point of boss e */
  private weakHit(e: Enemy, au: number, ax: number, ay: number, du: number, dx: number, dy: number, len: number, rad: number): boolean {
    const n = weakPointsOf(e, weakScratch);
    const r = T.behaviour.bulwark.weakRadius + rad;
    for (let i = 0; i < n; i++) {
      const w = weakScratch[i];
      if (segDistSq(w.u, w.x, w.y, au, ax, ay, du, dx, dy, len) <= r * r) return true;
    }
    return false;
  }

  private finishStage(cleared = true): void {
    const p = this.player;
    const shieldBonus = Math.round(p.shield * T.score.shieldBonusPerPoint);
    const killBonus = Math.round((this.kills / Math.max(1, this.spawned)) * T.score.timeBonusMax);
    const total = this.score + shieldBonus + killBonus;
    const par = this.mode === 'caravan' ? T.caravan.par : this.stage.par;
    const frac = cleared ? total / par : 0;
    const rank = frac >= T.rank.S ? 'S' : frac >= T.rank.A ? 'A' : frac >= T.rank.B ? 'B' : 'C';
    this.results = {
      rank, score: total, baseScore: this.score, shieldBonus, killBonus, bestCombo: this.bestChain,
      shieldLeft: Math.round(p.shield), timeS: Math.round((this.mode === 'caravan' ? this.playT : this.stageTime) * 10) / 10, kills: this.kills, spawned: this.spawned, cleared,
    };
    if (cleared) this.events.emit('stageClear', { stage: this.stage.id });
    else this.warning = { text: '// BULWARK ESCAPED //', age: 0 };
    this.setState('results');
  }

  // ------------------------------------------------------------------ snapshot

  hostileCount(): number {
    let n = 0;
    for (const b of this.bullets) if (b.alive && !b.friendly) n++;
    for (const l of this.lasers) if (l.alive && l.state !== 'off') n++;
    return n;
  }

  enemyCount(): number {
    let n = 0;
    for (const e of this.enemies) if (e.alive && !(e.b.pattern === 'chain' && e.age < e.b.delay)) n++;
    return n;
  }

  private bossSnapshot(): GameStateSnapshot['boss'] {
    const e = this.boss();
    if (!e) return null;
    return { name: 'BULWARK', phase: e.b.phase, hp01: Math.round((Math.max(0, e.hp) / e.maxHp) * 1000) / 1000 };
  }

  snapshot(): GameStateSnapshot {
    const p = this.player;
    return {
      state: this.state,
      paused: this.paused,
      stage: this.stage.id,
      mode: this.mode,
      difficulty: this.difficulty,
      time: Math.round(this.stageTime * 1000) / 1000,
      frame: this.frameCounter,
      seed: this.seed,
      progress: Math.round(this.progress * 10000) / 10000,
      score: this.score,
      shield: Math.round(p.shield * 10) / 10,
      combo: this.chain,
      bestCombo: this.bestChain,
      kills: this.kills,
      enemiesAlive: this.enemyCount(),
      hostileProjectiles: this.hostileCount(),
      missiles: p.missiles,
      locks: p.lockTargets.length,
      player: {
        x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, bank: Math.round(p.bank * 1000) / 1000,
        rolling: p.rolling > 0, drifting: p.drift > 0, wingtrail: p.wingtrail > 0, boosting: p.boost > 0, braking: p.braking,
        invulnerable: this.invulnerable,
      },
      boss: this.bossSnapshot(),
      results: this.results
        ? { rank: this.results.rank, score: this.results.score, bestCombo: this.results.bestCombo, shieldLeft: this.results.shieldLeft, timeS: this.results.timeS, cleared: this.results.cleared }
        : null,
    };
  }
}
