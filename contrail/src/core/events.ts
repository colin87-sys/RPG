/**
 * Typed gameplay event bus. Gameplay emits; VFX, audio, HUD, stats and the
 * harness listen. Emission is synchronous and allocation-light.
 */
import type * as THREE from 'three';

export interface GameEvents {
  cannonFire: { pos: THREE.Vector3 };
  lockAdded: { targetId: number; count: number };
  missileFire: { count: number };
  missileHit: { pos: THREE.Vector3; targetId: number };
  enemyHit: { id: number; pos: THREE.Vector3; damage: number; weapon: WeaponKind };
  enemyKilled: { id: number; kind: string; pos: THREE.Vector3; value: number; weapon: WeaponKind; big: boolean };
  playerHit: { damage: number; source: string; pos: THREE.Vector3 };
  parry: { pos: THREE.Vector3 };
  roll: { dir: -1 | 1; parried: boolean };
  wingtrail: { pos: THREE.Vector3 };
  comboChanged: { chain: number; refill: boolean };
  shieldRefill: { amount: number };
  laserTelegraph: { id: number };
  laserFire: { id: number };
  warning: { text: string; on: boolean };
  pickup: { kind: string; pos: THREE.Vector3 };
  stageStart: { stage: string };
  stageClear: { stage: string };
  playerDown: Record<string, never>;
  bossPhase: { phase: number };
  uiMove: Record<string, never>;
  uiConfirm: Record<string, never>;
  stateChanged: { from: string; to: string };
}

export type WeaponKind = 'cannon' | 'missile' | 'wingtrail' | 'parry' | 'collision';

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Handler<any>[]>();
  /** per-event counters, read by the harness (goldpath asserts mechanics fired) */
  readonly counts: Partial<Record<keyof GameEvents, number>> = {};

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let list = this.handlers.get(type);
    if (!list) this.handlers.set(type, (list = []));
    list.push(fn);
    return () => {
      const l = this.handlers.get(type);
      if (l) l.splice(l.indexOf(fn), 1);
    };
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    this.counts[type] = (this.counts[type] ?? 0) + 1;
    const list = this.handlers.get(type);
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i](payload);
  }

  resetCounts(): void {
    for (const k of Object.keys(this.counts)) delete this.counts[k as keyof GameEvents];
  }
}
