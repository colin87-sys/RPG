/**
 * GameState — the authoritative, serialisable model of a playthrough.
 *
 * Rule of the codebase: rendering reads from here, it never writes. Anything
 * that must survive a save/load lives in `state`; anything derived (meshes,
 * materials, tween handles) does not. Mutations go through the small mutator
 * methods below so the bus stays in sync and the UI never has to poll.
 */
import { bus } from './EventBus.js';

/** Elemental wheel. Opposed pairs sit across from each other. */
export const ELEMENTS = ['fire', 'ice', 'lightning', 'water', 'earth', 'wind', 'light', 'dark'];

/** Deterministic RNG so procedural art and captures reproduce exactly. */
export class Rng {
  constructor(seed = 0x2f6e2b1) {
    this.s = seed >>> 0 || 1;
  }
  /** xorshift32 — fast, good enough for art and combat variance. */
  next() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 0x100000000;
  }
  range(min, max) {
    return min + this.next() * (max - min);
  }
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** Sign-symmetric jitter in [-a, a]. */
  jitter(a = 1) {
    return (this.next() * 2 - 1) * a;
  }
}

export const rng = new Rng(
  typeof window !== 'undefined' && window.__AW_SEED__ ? window.__AW_SEED__ : 0x2f6e2b1,
);

function freshState() {
  return {
    version: 1,
    /** Ids into characters/roster.js. Order is the battle formation, front to back. */
    party: [],
    /** Per-character progression keyed by character id. */
    progress: {},
    inventory: { items: {}, gil: 500 },
    /** Espers the player has bonded with, keyed by esper id. */
    espers: {},
    /** Story flags — the quest system's only persistent surface. */
    flags: {},
    /** Current chapter id from story/script.js. */
    chapter: 'prologue',
    /** Where the player stands in the field, so a load can restore position. */
    location: { zone: 'lumen-quay', x: 0, y: 0, z: 0, facing: 0 },
    /** 0..1 across a full day. 0.25 = dawn, 0.5 = noon, 0.8 = dusk. */
    timeOfDay: 0.34,
    playtimeSeconds: 0,
    settings: {
      masterVolume: 0.8,
      musicVolume: 0.7,
      sfxVolume: 0.9,
      quality: 'high', // 'low' | 'medium' | 'high' | 'ultra'
      motionBlur: true,
      screenShake: true,
      textSpeed: 1,
    },
  };
}

class GameStateStore {
  constructor() {
    this.state = freshState();
  }

  reset() {
    this.state = freshState();
    bus.emit('state:reset', this.state);
  }

  /** Replace wholesale (save load). Unknown keys from older saves are kept. */
  hydrate(data) {
    this.state = { ...freshState(), ...data };
    bus.emit('state:loaded', this.state);
  }

  serialize() {
    return JSON.parse(JSON.stringify(this.state));
  }

  // --- flags -------------------------------------------------------------

  getFlag(name, fallback = false) {
    return name in this.state.flags ? this.state.flags[name] : fallback;
  }

  setFlag(name, value = true) {
    const prev = this.state.flags[name];
    if (prev === value) return;
    this.state.flags[name] = value;
    bus.emit('state:flag', { name, value, prev });
  }

  // --- party -------------------------------------------------------------

  addToParty(characterId) {
    if (this.state.party.includes(characterId)) return;
    this.state.party.push(characterId);
    if (!this.state.progress[characterId]) {
      this.state.progress[characterId] = { level: 1, xp: 0, abilities: [], equipment: {} };
    }
    bus.emit('party:joined', { characterId, party: [...this.state.party] });
  }

  removeFromParty(characterId) {
    const i = this.state.party.indexOf(characterId);
    if (i < 0) return;
    this.state.party.splice(i, 1);
    bus.emit('party:left', { characterId, party: [...this.state.party] });
  }

  progressFor(characterId) {
    return this.state.progress[characterId];
  }

  // --- inventory ---------------------------------------------------------

  addItem(itemId, count = 1) {
    const items = this.state.inventory.items;
    items[itemId] = (items[itemId] ?? 0) + count;
    bus.emit('inventory:changed', { itemId, count: items[itemId] });
  }

  consumeItem(itemId, count = 1) {
    const items = this.state.inventory.items;
    if ((items[itemId] ?? 0) < count) return false;
    items[itemId] -= count;
    if (items[itemId] === 0) delete items[itemId];
    bus.emit('inventory:changed', { itemId, count: items[itemId] ?? 0 });
    return true;
  }

  addGil(amount) {
    this.state.inventory.gil = Math.max(0, this.state.inventory.gil + amount);
    bus.emit('inventory:gil', this.state.inventory.gil);
  }

  // --- settings ----------------------------------------------------------

  setSetting(key, value) {
    this.state.settings[key] = value;
    bus.emit('settings:changed', { key, value });
  }
}

export const gameState = new GameStateStore();
