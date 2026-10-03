/**
 * Autopilot for the goldpath and attract mode. Reads the simulation and
 * produces an input frame; uses every mechanic so the harness can assert them.
 */
import type { InputFrame } from '../core/input';
import type { Game } from './game';
import { T } from '../data/tuning';
import { Rng } from '../core/rng';

/** seconds before the bot notices a new beam telegraph (min + random spread) [A] */
const BEAM_REACT_MIN = 0.22;
const BEAM_REACT_SPREAD = 0.3;

export class Bot {
  private lockHold = 0;
  private lastRoll = -10;
  /** a human-like bot: misses some parry timings (seeded, deterministic) */
  private rng = new Rng(97);
  private skipUntil = -1;

  constructor(private g: Game) {}

  frame = (): Partial<InputFrame> => {
    const g = this.g;
    const f: Partial<InputFrame> = {};
    if (g.state === 'title' || g.state === 'results' || g.state === 'gameover') {
      f.confirm = (g.frameCounter % 20) < 2;
      return f;
    }
    if (g.state !== 'play') return f;
    const p = g.player;
    // pick target: nearest living enemy ahead; the boss's weak points when nothing small is close
    let tgt = null as null | (typeof g.enemies)[number];
    let bd = Infinity;
    let near = 0;
    let boss = null as null | (typeof g.enemies)[number];
    for (const e of g.enemies) {
      if (!e.alive) continue;
      if (e.kind === 'bulwark') { boss = e; continue; }
      if (e.u < 6 || e.u > 200) continue;
      if (e.b.pattern === 'chain' && e.age < e.b.delay) continue;
      const d = e.u + Math.abs(e.x - p.x) * 2 + Math.abs(e.y - p.y) * 2 - (e.big ? 40 : 0);
      if (d < bd) { bd = d; tgt = e; }
      if (Math.hypot(e.u, e.x - p.x, e.y - p.y) < 22) near++;
    }
    let aimU = 0, aimX = 0, aimY = 0, has = false;
    if (tgt && (!boss || tgt.u < 110)) { aimU = tgt.u; aimX = tgt.x; aimY = tgt.y; has = true; }
    else if (boss && boss.u < 260) {
      // cycle weak points every few seconds (reactors, then the chin core)
      const wp = g.weakPoints(boss);
      const w = wp[Math.floor(g.stageTime / 4) % wp.length];
      const tof = Math.hypot(w.u, w.x - p.x, w.y - p.y) / T.cannon.speed; // lead the sway
      aimU = w.u; aimX = w.x + boss.vx * tof; aimY = w.y; has = true;
    }
    // aim: reticle point on the line from craft through the target
    if (has) {
      const k = T.move.reticleDist / Math.max(8, aimU);
      const ax = p.x + (aimX - p.x) * k, ay = p.y + (aimY - p.y) * k;
      f.moveX = Math.max(-1, Math.min(1, (ax - p.rx) * 0.4));
      f.moveY = Math.max(-1, Math.min(1, (ay - p.ry) * 0.4));
    } else {
      f.moveX = Math.max(-1, Math.min(1, -p.rx * 0.1));
      f.moveY = Math.max(-1, Math.min(1, -p.ry * 0.1));
    }
    // missiles: hold lock for a while when missiles are available and targets exist
    if (p.missiles > 0 && tgt) {
      this.lockHold++;
      f.lock = this.lockHold < 50 && p.lockTargets.length < p.missiles;
      if (this.lockHold > 60) this.lockHold = 0;
    } else this.lockHold = 0;
    // parry: roll when a hostile bullet is about to arrive
    const now = g.stageTime;
    for (const b of g.bullets) {
      if (!b.alive || b.friendly || b.vu >= 0) continue;
      const tHit = -b.u / b.vu;
      if (tHit < 0 || tHit > 0.1) continue;
      const px = b.x + b.vx * tHit, py = b.y + b.vy * tHit;
      if (Math.hypot(px - p.x, py - p.y) < 2.6 && p.rollCharges > 0 && now - this.lastRoll > 0.5 && now > this.skipUntil) {
        if (this.rng.chance(0.4)) { this.skipUntil = now + 0.3; break; } // reaction missed
        f.roll = true; f.rollDir = 1;
        this.lastRoll = now;
        break;
      }
    }
    // dodge beams: find where each live beam crosses the player plane (u = 0), including the
    // whole path of a sweep, and steer to the nearest spot with clearance
    const here = this.clearance(p.x, p.y);
    if (here < 0) {
      let best = here, bx = p.x, by = p.y;
      for (let cx = -16; cx <= 16; cx += 2) {
        for (let cy = -9; cy <= 9; cy += 1.5) {
          const c = this.clearance(cx, cy) - Math.hypot(cx - p.x, cy - p.y) * 0.12;
          if (c > best) { best = c; bx = cx; by = cy; }
        }
      }
      const rxT = (bx / T.move.windowX) * T.move.reticleWindowX, ryT = (by / T.move.windowY) * T.move.reticleWindowY;
      f.moveX = Math.max(-1, Math.min(1, (rxT - p.rx) * 0.5));
      f.moveY = Math.max(-1, Math.min(1, (ryT - p.ry) * 0.5));
      // still inside a beam that is about to fire / firing: roll through it (parry) if possible
      if (this.beamImminent && p.rollCharges > 0 && now - this.lastRoll > 0.5 && p.rolling <= 0) {
        f.roll = true; f.rollDir = -1;
        this.lastRoll = now;
      }
    }
    // wingtrail when charged and there is a crowd or a big enemy
    f.wingtrail = p.wingCharge >= 1 && (near >= 2 || this.g.enemies.filter((e) => e.alive && e.u > 0 && e.u < 160).length >= 4 || (tgt?.big ?? false));
    return f;
  };

  private beamImminent = false;
  private lastT: number[] = new Array(64).fill(99);
  private react: number[] = new Array(64).fill(0.3);

  /** Distance from (x, y) to the nearest beam footprint minus its hit radius (negative = inside). */
  private clearance(x: number, y: number): number {
    const g = this.g;
    let best = Infinity;
    this.beamImminent = false;
    for (const l of g.lasers) {
      if (!l.alive || l.state === 'off') continue;
      // human-like reaction: a new beam is noticed only after a seeded delay
      if (l.state === 'telegraph' && l.t < this.lastT[l.id]) this.react[l.id] = BEAM_REACT_MIN + this.rng.next() * BEAM_REACT_SPREAD;
      this.lastT[l.id] = l.state === 'telegraph' ? l.t : 99;
      if (l.state === 'telegraph' && l.t < this.react[l.id]) continue;
      const r = l.width + 2.4 * 0.6 + 1.2; // beam + craft + margin
      const sw = (l as typeof l & { sweep?: { dx: number; dy: number; tu: number; tx: number; ty: number } }).sweep;
      let d: number;
      if (sw) {
        // segment from the sweep's start to its end (the remaining part while firing)
        const f0 = l.state === 'fire' ? Math.min(1, l.t / l.fireS) : 0;
        const ax = sw.tx + sw.dx * f0, ay = sw.ty + sw.dy * f0, bx = sw.tx + sw.dx, by = sw.ty + sw.dy;
        const vx = bx - ax, vy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)));
        d = Math.hypot(x - ax - vx * t, y - ay - vy * t);
      } else {
        const t = -l.u0 / (l.du || -1e-3);
        d = Math.hypot(l.x0 + l.dx * t - x, l.y0 + l.dy * t - y);
      }
      const c = d - r;
      if (c < best) best = c;
      if (c < 0 && (l.state === 'fire' || l.telegraphS - l.t < 0.08)) this.beamImminent = true;
    }
    return best;
  }
}
