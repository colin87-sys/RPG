/**
 * Fills the UI lane's HudState from the simulation each rendered frame.
 */
import { createHudState, type HudState, type HudTarget } from '../gen/ui/hud';
import type { Game } from './game';
import type { View } from './view';
import { T } from '../data/tuning';

const KIND_LABEL: Record<string, string> = { caltrop: 'CALTROP', dart: 'DART', sniper: 'LANCER', strider: 'STRIDER', bulwark: 'BULWARK' };

export class HudAdapter {
  readonly s: HudState = createHudState();
  private hazardT = 0;
  private targets: HudTarget[] = [];

  constructor(private game: Game, private view: View) {}

  update(w: number, h: number, dt: number, time: number): HudState {
    const g = this.game, p = g.player, s = this.s;
    s.score = g.score;
    s.progress = g.progress;
    s.stage = g.stage.name;
    s.missiles = p.missiles;
    s.missilesMax = T.missiles.ammo;
    s.locks = p.lockTargets.length;
    s.specials[0].name = 'DRIFT';
    s.specials[0].ready = p.driftCharge >= 1;
    s.specials[0].charge = p.driftCharge;
    s.specials[1].name = 'WING';
    s.specials[1].ready = p.wingCharge >= 1;
    s.specials[1].charge = p.wingCharge;
    s.rolls = p.rollCharges;
    s.rollsMax = T.roll.charges;
    s.rollRecharge = p.rollCharges < T.roll.charges ? 1 - p.rollRecharge / T.roll.rechargeEach : 0;
    s.combo.chain = g.chain;
    s.combo.timer = g.chain > 0 ? g.comboTimer / T.combo.cap : 0;
    s.combo.refill = g.refilling;
    s.combo.multiplier = g.multiplier;
    s.shield = p.shield;
    s.shieldMax = T.shield.max;
    const r = this.view.project(T.move.reticleDist, p.rx, p.ry, w, h);
    if (r) { s.reticle.x = r.x; s.reticle.y = r.y; }
    s.lockMode = p.lockHeld;
    // targets on screen (locked ones get brackets; big ones an hp sliver)
    this.targets.length = 0;
    let boss: { label: string; hp01: number } | null = null;
    for (const e of g.enemies) {
      if (!e.alive || e.u < 4 || e.u > 320) continue;
      if (e.b.pattern === 'chain' && e.age < e.b.delay) continue;
      const lc = p.lockTargets.reduce((n, id) => n + (id === e.id ? 1 : 0), 0);
      if (!lc && !e.big) continue;
      const q = this.view.project(e.u, e.x, e.y, w, h);
      if (!q) continue;
      const size = Math.max(14, (e.radius / Math.max(8, e.u + T.camera.back)) * h * 1.2);
      this.targets.push({ x: q.x, y: q.y, size, locked: lc > 0, lockCount: lc, hp01: e.big ? e.hp / e.maxHp : undefined, boss: e.kind === 'bulwark' } as HudTarget);
      if (e.big && (!boss || e.hp / e.maxHp < boss.hp01)) boss = { label: KIND_LABEL[e.kind] ?? e.kind.toUpperCase(), hp01: e.hp / e.maxHp };
    }
    s.targets = this.targets;
    s.enemyInfo = boss;
    if (g.warning) { this.hazardT += dt; s.hazard.on = true; s.hazard.text = g.warning.text; s.hazard.t = this.hazardT; }
    else { this.hazardT = 0; s.hazard.on = false; }
    s.danger = Math.max(0, Math.min(1, (40 - p.shield) / 40));
    s.combatText = g.combatText.map((c) => ({ text: c.text, kind: c.kind, age: c.age })) as HudState['combatText'];
    s.speed = p.boost > 0 ? 0.95 : p.braking ? 0.2 : 0.55;
    s.prompts = g.prompts.filter((pr) => pr.age < 4).map((pr) => ({ text: pr.text }));
    s.skyLuma = g.stage.id === 'wreckfield' ? 0 : g.stage.id === 'violetTide' ? 0.3 : 1;
    s.paused = g.paused;
    s.time = time;
    return s;
  }
}
