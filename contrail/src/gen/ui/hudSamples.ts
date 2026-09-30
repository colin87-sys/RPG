/**
 * Sample HUD states for Look-Dev boards and harness captures (realistic values
 * at 1920x1080; positions scale with the given frame size).
 */
import { createHudState, type HudState } from './hud';

export type HudSampleId = 'normal' | 'space' | 'hazard' | 'danger';

export function sampleHudState(id: HudSampleId, w = 1920, h = 1080): HudState {
  const s = createHudState();
  const sx = w / 1920, sy = h / 1080;
  s.time = 12.4;
  s.score = 124850;
  s.progress = 0.42;
  s.stage = 'CLOUDGATE';
  s.weapon = 'RIVETER';
  s.missiles = 6;
  s.missilesMax = 6;
  s.locks = 3;
  s.specials = [
    { name: 'DRIFT', ready: true, charge: 1 },
    { name: 'WING', ready: false, charge: 0.62 },
  ];
  s.rolls = 2;
  s.rollsMax = 3;
  s.rollRecharge = 0.55;
  s.combo = { chain: 6, timer: 0.68, refill: true, multiplier: 1.6 };
  s.shield = 72;
  s.shieldMax = 100;
  s.reticle = { x: 1010 * sx, y: 470 * sy };
  s.lockMode = true;
  s.targets = [
    { x: 1180 * sx, y: 360 * sy, size: 30 * sy, locked: true, lockCount: 1 },
    { x: 1265 * sx, y: 410 * sy, size: 30 * sy, locked: true, lockCount: 1 },
    { x: 1120 * sx, y: 300 * sy, size: 44 * sy, locked: true, lockCount: 1, hp01: 0.7 },
    { x: 760 * sx, y: 330 * sy, size: 30 * sy, locked: false, lockCount: 0 },
    { x: 840 * sx, y: 610 * sy, size: 36 * sy, locked: false, lockCount: 0 },
  ];
  s.enemyInfo = { label: 'DART PAIR', hp01: 0.7 };
  s.combatText = [
    { text: '6 CHAIN', kind: 'good', age: 0.5 },
    { text: 'SHIELD REFILL', kind: 'good', age: 0.9 },
    { text: 'PARRY +50', kind: 'hot', age: 0.3 },
  ];
  s.speed = 0.62;
  s.prompts = [];
  if (id === 'space') {
    s.stage = 'WRECKFIELD';
    s.lockMode = false;
    s.locks = 0;
    s.targets = s.targets.map((t) => ({ ...t, locked: false, lockCount: 0 }));
    s.targets[0].locked = true;
    s.targets[0].lockCount = 2;
    s.enemyInfo = null;
    s.combo = { chain: 2, timer: 0.35, refill: false, multiplier: 1.2 };
    s.combatText = [{ text: 'DIRECT HIT', kind: 'hot', age: 0.4 }];
    s.prompts = [{ key: 'K', text: 'HOLD TO SWEEP LOCKS, RELEASE TO FIRE' }];
  } else if (id === 'hazard') {
    s.stage = 'WRECKFIELD';
    s.hazard = { on: true, text: '// DEBRIS WAVE INBOUND //', t: 1.2 };
    s.lockMode = false;
    s.locks = 0;
    s.targets = [{ x: 1300 * sx, y: 420 * sy, size: 160 * sy, locked: false, lockCount: 0, hp01: 0.8, boss: true }];
    s.enemyInfo = { label: 'STRIDER', hp01: 0.8 };
    s.danger = 0.3;
    s.shield = 51;
    s.combatText = [{ text: 'BREAK LEFT', kind: 'hot', age: 0.6 }];
  } else if (id === 'danger') {
    s.stage = 'VIOLET TIDE';
    s.shield = 14;
    s.danger = 0.95;
    s.lockMode = false;
    s.locks = 0;
    s.missiles = 1;
    s.specials = [
      { name: 'DRIFT', ready: false, charge: 0.2 },
      { name: 'WING', ready: false, charge: 0.9 },
    ];
    s.rolls = 0;
    s.rollRecharge = 0.3;
    s.combo = { chain: 0, timer: 0, refill: false, multiplier: 1 };
    s.targets = [{ x: 900 * sx, y: 380 * sy, size: 34 * sy, locked: true, lockCount: 1 }];
    s.enemyInfo = { label: 'SNIPER', hp01: 0.35 };
    s.combatText = [
      { text: 'HULL BREACH', kind: 'hot', age: 0.2 },
      { text: 'CHAIN LOST', kind: 'hot', age: 1.0 },
    ];
  }
  return s;
}
