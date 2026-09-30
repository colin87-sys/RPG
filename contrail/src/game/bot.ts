/**
 * Autopilot for the goldpath and attract mode. Reads the simulation and
 * produces an input frame; uses every mechanic so the harness can assert them.
 */
import type { InputFrame } from '../core/input';
import type { Game } from './game';
import { T } from '../data/tuning';
import { Rng } from '../core/rng';

export class Bot {
  private lockHold = 0;
  private driftHold = 0;
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
    // pick target: nearest living enemy ahead
    let tgt = null as null | (typeof g.enemies)[number];
    let bd = Infinity;
    let near = 0;
    for (const e of g.enemies) {
      if (!e.alive || e.u < 6 || e.u > 200) continue;
      if (e.b.pattern === 'chain' && e.age < e.b.delay) continue;
      const d = e.u + Math.abs(e.x - p.x) * 2 + Math.abs(e.y - p.y) * 2 - (e.big ? 40 : 0);
      if (d < bd) { bd = d; tgt = e; }
      if (Math.hypot(e.u, e.x - p.x, e.y - p.y) < 22) near++;
    }
    // aim: reticle point on the line from craft through the target
    if (tgt) {
      const k = T.move.reticleDist / Math.max(8, tgt.u);
      const ax = p.x + (tgt.x - p.x) * k, ay = p.y + (tgt.y - p.y) * k;
      f.moveX = Math.max(-1, Math.min(1, (ax - p.rx) * 0.4));
      f.moveY = Math.max(-1, Math.min(1, (ay - p.ry) * 0.4));
      f.fire = Math.abs(ax - p.rx) < 5 && Math.abs(ay - p.ry) < 4;
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
        if (this.rng.chance(0.3)) { this.skipUntil = now + 0.3; break; } // reaction missed
        f.rollRight = true;
        this.lastRoll = now;
        break;
      }
    }
    // dodge laser telegraphs by steering away from the line
    for (const l of g.lasers) {
      if (!l.alive || l.state === 'off') continue;
      const t = -l.u0 / (l.du || -1e-3);
      const lx = l.x0 + l.dx * t, ly = l.y0 + l.dy * t;
      if (Math.hypot(lx - p.x, ly - p.y) < 5) {
        f.moveY = ly > p.y ? -1 : 1;
        f.moveX = lx > p.x ? -1 : 1;
      }
    }
    // drift when enemies are close
    if (p.drift > 0) { f.drift = this.driftHold++ < 60; }
    else { this.driftHold = 0; f.drift = near >= 2 && p.driftCharge >= 1; }
    // wingtrail when charged and there is a crowd or a big enemy
    f.wingtrail = p.wingCharge >= 1 && (near >= 3 || (tgt?.big ?? false));
    return f;
  };
}
