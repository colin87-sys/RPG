/**
 * BattleUI — the in-combat HUD, built to the structure visible in
 * `docs/reference/bravely01.jpg` (party stack) and `bravely04.jpg` (ability
 * banner, battle-speed cluster).
 *
 * Three surfaces, all plain DOM inside `#ui-root`:
 *
 *   1. the right-hand party stack — name, HP label/value/bar, MP label/value/
 *      thinner bar, and the ornate gold BP diamond, unboxed over the scene;
 *   2. the ability-name banner that crosses lower-centre while a cast resolves;
 *   3. the battle-speed cluster in the top-left corner.
 *
 * Everything is driven from the bus. Nothing here reaches into the battle
 * engine, and nothing here is authoritative: the HUD keeps a *mirror* of the
 * party seeded by `battle:start` and stepped by `battle:damage` / `battle:ko`,
 * because those are the only stat-bearing events in the catalogue. Re-emitting
 * `battle:start` with fresh members resynchronises it at any time, and
 * `setParty()` is exposed for the battle layer to push a correction directly.
 *
 * Layout note: all measurements live in `theme.css` as figures read off the
 * plate. This file only decides *what* is on screen, never how large it is.
 */
import { bus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { characterDef, DEFAULT_PARTY } from '../characters/roster.js';

/** Speed steps the cluster cycles through; index + 1 is the pip count. */
const SPEED_STEPS = 4;
/** How long the ability banner holds once nothing has re-triggered it. */
const BANNER_HOLD_SECONDS = 1.6;
/**
 * Value tween rate, in e-foldings per second. At 11 a four-digit HP swing
 * settles in about a third of a second — fast enough to keep up with a combo,
 * slow enough that the eye reads it as a number falling rather than a swap.
 */
const VALUE_RATE = 11;
/** Below this the bar and numeral go to the critical treatment. */
const CRITICAL_FRACTION = 0.25;

/** Pull the first finite number out of a list of candidate property names. */
function pickNumber(source, keys, fallback) {
  if (source) {
    for (const key of keys) {
      const value = source[key];
      if (Number.isFinite(value)) return value;
    }
  }
  return fallback;
}

/**
 * Coerce whatever the battle layer hands us into the shape the stack renders.
 *
 * The ATB engine is written by another author against `docs/ARCHITECTURE.md`,
 * which fixes `battle:start`'s payload as `{party, enemies, encounterId}` but
 * not the shape of a party member. So this accepts an id string, a roster-like
 * object, or a combat actor, and falls back to the roster's authored stats for
 * anything missing rather than rendering `NaN` over the scene.
 */
function normaliseMember(raw, index) {
  const id = (typeof raw === 'string' ? raw : raw?.id ?? raw?.characterId) ?? `slot${index}`;
  const source = typeof raw === 'string' ? null : raw;
  const def = characterDef(id);
  const stats = source?.stats ?? def?.stats ?? null;

  const maxHp = Math.max(1, Math.round(pickNumber(source, ['maxHp', 'hpMax'], pickNumber(stats, ['hp'], 100))));
  const maxMp = Math.max(0, Math.round(pickNumber(source, ['maxMp', 'mpMax'], pickNumber(stats, ['mp'], 0))));

  const fullName = source?.name ?? def?.name ?? id;
  return {
    id,
    // The plate labels each slot with a single given name ("Seth", "Gloria"),
    // never a full name — a surname would not fit the column and would break
    // the right alignment against the BP diamond.
    name: String(fullName).split(/\s+/)[0],
    maxHp,
    maxMp,
    hp: Math.max(0, Math.min(maxHp, Math.round(pickNumber(source, ['hp', 'currentHp'], maxHp)))),
    mp: Math.max(0, Math.min(maxMp, Math.round(pickNumber(source, ['mp', 'currentMp'], maxMp)))),
    bp: Math.round(pickNumber(source, ['bp'], 0)),
  };
}

/** `eternal-inferno` -> `Eternal Inferno`. */
function prettyAbilityName(id) {
  return String(id)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

export class BattleUI {
  /**
   * @param {HTMLElement} host element to mount into (`#ui-root`)
   */
  constructor(host) {
    this.host = host;
    /** @type {HTMLElement|null} */
    this.root = null;
    /** Row records keyed by character id, in formation order. */
    this.rows = [];
    this.byId = new Map();
    this.speed = Math.round(pickNumber(gameState.state.settings, ['battleSpeed'], 2));
    this.bannerTimer = 0;
    this.visible = false;
    this._off = [];
    this._pulses = new Set();
    this._build();
    this._subscribe();
  }

  // --------------------------------------------------------------- markup

  _build() {
    this.root = el('div', 'aw-battle');
    this.root.hidden = true;

    this.speedEl = el('div', 'aw-speed', this.root);
    this.slowBtn = el('button', 'aw-speed-btn', this.speedEl);
    this.slowBtn.type = 'button';
    this.slowBtn.textContent = '−'; // minus sign, not a hyphen
    this.slowBtn.setAttribute('aria-label', 'Slower battle speed');
    this.fastBtn = el('button', 'aw-speed-btn', this.speedEl);
    this.fastBtn.type = 'button';
    this.fastBtn.textContent = '+';
    this.fastBtn.setAttribute('aria-label', 'Faster battle speed');
    el('span', 'aw-speed-label', this.speedEl).textContent = 'Battle Speed';
    this.pipsEl = el('span', 'aw-speed-pips', this.speedEl);

    this._onSlow = () => this.setSpeed(this.speed - 1);
    this._onFast = () => this.setSpeed(this.speed + 1);
    this.slowBtn.addEventListener('click', this._onSlow);
    this.fastBtn.addEventListener('click', this._onFast);

    this.ability = el('div', 'aw-ability', this.root);
    this.ability.hidden = true;
    this.abilityText = el('span', 'aw-ability-text', this.ability);

    this.party = el('ul', 'aw-party', this.root);
    this.party.setAttribute('aria-label', 'Party status');

    this.host.appendChild(this.root);
    this._renderPips();
  }

  /** Build (or rebuild) one row's DOM. Returns the record the tweens use. */
  _buildRow(member) {
    const root = el('li', 'aw-party-row');
    root.dataset.actor = member.id;

    const name = el('span', 'aw-name', root);
    name.textContent = member.name;

    const hpStat = el('span', 'aw-stat aw-stat--hp', root);
    el('span', 'aw-stat-label', hpStat).textContent = 'HP';
    const hpValue = el('span', 'aw-stat-value', hpStat);

    const mpStat = el('span', 'aw-stat aw-stat--mp', root);
    el('span', 'aw-stat-label', mpStat).textContent = 'MP';
    const mpValue = el('span', 'aw-stat-value', mpStat);

    const hpBar = el('div', 'aw-bar aw-bar--hp', root);
    const hpFill = el('i', null, hpBar);
    const mpBar = el('div', 'aw-bar aw-bar--mp', root);
    const mpFill = el('i', null, mpBar);

    const bp = el('div', 'aw-bp', root);
    const gem = el('div', 'aw-bp-gem', bp);
    el('div', 'aw-bp-face', gem);
    const bpNum = el('span', 'aw-bp-num', bp);
    el('span', 'aw-bp-tag', bp).textContent = 'BP';

    return {
      member,
      root,
      name,
      hpValue,
      mpValue,
      hpFill,
      mpFill,
      bp,
      bpNum,
      // Tweened mirrors of the model. `shown` chases `target`; the DOM is only
      // touched when the rounded integer or the rounded percentage moves.
      hp: { shown: member.hp, target: member.hp, printed: -1, width: -1 },
      mp: { shown: member.mp, target: member.mp, printed: -1, width: -1 },
      bpShown: NaN,
      critical: null,
      ko: false,
    };
  }

  // ------------------------------------------------------------- bus wiring

  _subscribe() {
    const on = (type, handler) => this._off.push(bus.on(type, handler));

    on('battle:start', ({ party } = {}) => {
      this.setParty(Array.isArray(party) && party.length ? party : this._fallbackParty());
      this.show();
    });
    on('battle:end', () => this.hide());

    on('battle:turn-ready', ({ actorId, bp } = {}) => {
      for (const row of this.rows) row.root.classList.toggle('is-active', row.member.id === actorId);
      // `bp` is not in the catalogue's payload; honour it when the battle layer
      // supplies it so BP can track without inventing a new event.
      if (Number.isFinite(bp)) this.setBp(actorId, bp);
    });

    on('battle:action-start', (payload = {}) => {
      const { actorId, abilityId, abilityName, bp } = payload;
      if (Number.isFinite(bp)) this.setBp(actorId, bp);
      if (abilityId || abilityName) this.showAbility(abilityName ?? prettyAbilityName(abilityId));
    });
    on('battle:action-end', () => this.hideAbility());

    on('battle:damage', (payload = {}) => this._applyDamage(payload));

    on('battle:ko', ({ targetId } = {}) => {
      const row = this.byId.get(targetId);
      if (!row) return;
      row.hp.target = 0;
      row.ko = true;
      row.root.classList.add('is-ko');
      row.root.classList.remove('is-active');
    });

    on('battle:limit-ready', ({ actorId } = {}) => {
      this.byId.get(actorId)?.bp.classList.add('is-charged');
    });

    /**
     * The battle scene is allowed to mount without ever emitting
     * `battle:start` — the debug hook `__AW__.gotoBattle()` does exactly that,
     * and the capture harness shoots the frame it produces. Seeding from the
     * saved party there is what keeps the HUD in those captures.
     *
     * Identified by the presence of `encounterId` rather than by
     * `constructor.name`, which the production build minifies away.
     */
    on('scene:changed', ({ scene } = {}) => {
      const isBattle = scene != null && typeof scene.encounterId === 'string';
      if (!isBattle) {
        this.hide();
        return;
      }
      if (!this.rows.length) this.setParty(this._fallbackParty());
      this.show();
    });

    on('settings:changed', ({ key, value } = {}) => {
      if (key === 'battleSpeed' && Number.isFinite(value) && value !== this.speed) {
        this.speed = Math.min(SPEED_STEPS, Math.max(1, Math.round(value)));
        this._renderPips();
      }
    });
  }

  /** The saved party, or the story default, resolved through the roster. */
  _fallbackParty() {
    const ids = gameState.state.party.length ? gameState.state.party : DEFAULT_PARTY;
    return ids.slice(0, 5);
  }

  _applyDamage({ targetId, amount, kind }) {
    const row = this.byId.get(targetId);
    if (!row || !Number.isFinite(amount)) return;
    const magnitude = Math.abs(Math.round(amount));

    if (kind === 'mp') {
      row.mp.target = Math.max(0, Math.min(row.member.maxMp, row.mp.target - magnitude));
      this._pulse(row.mpValue, 'is-damage');
      return;
    }
    if (kind === 'miss' || kind === 'immune') return;

    const healing = kind === 'heal';
    row.hp.target = Math.max(0, Math.min(row.member.maxHp, row.hp.target + (healing ? magnitude : -magnitude)));
    if (healing && row.hp.target > 0 && row.ko) {
      row.ko = false;
      row.root.classList.remove('is-ko');
    }
    this._pulse(row.hpValue, healing ? 'is-heal' : 'is-damage');
  }

  /**
   * Re-triggerable one-shot flash. Restarting a CSS animation needs the class
   * gone for a layout tick; cancelling and re-adding in the same frame is the
   * documented way to force that without a timer that could outlive dispose().
   */
  _pulse(node, className) {
    node.classList.remove('is-damage', 'is-heal');
    // Reading offsetWidth flushes the style change so the animation restarts
    // even when the same class is being reapplied.
    void node.offsetWidth;
    node.classList.add(className);
    this._pulses.add(node);
  }

  // ---------------------------------------------------------- public API

  /** Replace the whole stack. Accepts ids, roster entries or combat actors. */
  setParty(members) {
    const list = (Array.isArray(members) ? members : []).map(normaliseMember);
    this.party.replaceChildren();
    this.rows = [];
    this.byId.clear();
    this._pulses.clear();

    for (const member of list) {
      const row = this._buildRow(member);
      this.party.appendChild(row.root);
      this.rows.push(row);
      this.byId.set(member.id, row);
      // Paint once immediately so the first frame is correct rather than
      // showing four rows counting up from zero.
      this._paintRow(row, true);
    }
  }

  /** Set one member's banked BP. Negative values are the debt state. */
  setBp(actorId, value) {
    const row = this.byId.get(actorId);
    if (!row || !Number.isFinite(value)) return;
    row.member.bp = Math.round(value);
  }

  /** Show the lower-centre ability banner. Re-showing restarts the hold. */
  showAbility(name) {
    if (!name) return;
    this.abilityText.textContent = name;
    this.ability.hidden = false;
    // Same flush as _pulse: `hidden` -> visible in one frame would otherwise
    // skip the open transition entirely.
    void this.ability.offsetWidth;
    this.ability.classList.add('is-open');
    this.bannerTimer = BANNER_HOLD_SECONDS;
  }

  hideAbility() {
    this.ability.classList.remove('is-open');
    this.bannerTimer = 0;
  }

  /** 1..4, mirroring the plate's chevron count. Persisted for the ATB engine. */
  setSpeed(value) {
    const next = Math.min(SPEED_STEPS, Math.max(1, Math.round(value)));
    if (next === this.speed) return;
    this.speed = next;
    this._renderPips();
    // The HUD does not own pacing; it records the player's choice and lets the
    // battle engine read it. Driving engine.timeScale from here would fight
    // hit-stop and cutscenes, which own that channel (ARCHITECTURE.md).
    gameState.setSetting('battleSpeed', next);
  }

  _renderPips() {
    this.pipsEl.replaceChildren();
    for (let i = 0; i < this.speed; i++) el('i', null, this.pipsEl);
    this.slowBtn.disabled = this.speed <= 1;
    this.fastBtn.disabled = this.speed >= SPEED_STEPS;
    this.speedEl.setAttribute('aria-label', `Battle speed ${this.speed} of ${SPEED_STEPS}`);
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this.hideAbility();
    for (const row of this.rows) row.root.classList.remove('is-active');
  }

  // ------------------------------------------------------------- per frame

  update(dt) {
    if (!this.visible) return;
    const step = Math.min(0.1, Math.max(0, dt || 0));

    if (this.bannerTimer > 0) {
      this.bannerTimer -= step;
      if (this.bannerTimer <= 0) this.hideAbility();
    }

    // Frame-rate independent exponential approach. `1 - exp(-rate * dt)` is the
    // correct per-step blend for a constant time constant; a raw `t * dt` lerp
    // would settle at a different speed on every machine.
    const blend = 1 - Math.exp(-VALUE_RATE * step);
    for (const row of this.rows) this._paintRow(row, false, blend);
  }

  _paintRow(row, snap, blend = 1) {
    const { member } = row;

    for (const [pool, valueNode, fillNode, max] of [
      [row.hp, row.hpValue, row.hpFill, member.maxHp],
      [row.mp, row.mpValue, row.mpFill, member.maxMp],
    ]) {
      const delta = pool.target - pool.shown;
      if (snap || Math.abs(delta) < 0.5) pool.shown = pool.target;
      else pool.shown += delta * blend;

      const printed = Math.round(pool.shown);
      if (printed !== pool.printed) {
        pool.printed = printed;
        valueNode.textContent = String(printed);
      }
      // Quantised to a tenth of a percent: writing an unrounded width every
      // frame invalidates layout for a change no one can see.
      const width = max > 0 ? Math.round((Math.max(0, pool.shown) / max) * 1000) / 10 : 0;
      if (width !== pool.width) {
        pool.width = width;
        fillNode.style.width = `${width}%`;
      }
    }

    const critical = !row.ko && row.hp.shown / member.maxHp <= CRITICAL_FRACTION;
    if (critical !== row.critical) {
      row.critical = critical;
      row.root.classList.toggle('is-critical', critical);
    }

    if (member.bp !== row.bpShown) {
      row.bpShown = member.bp;
      row.bpNum.textContent = String(member.bp);
      row.bp.classList.toggle('is-charged', member.bp > 0);
      row.bp.classList.toggle('is-debt', member.bp < 0);
    }
  }

  dispose() {
    for (const off of this._off) off();
    this._off.length = 0;
    this.slowBtn.removeEventListener('click', this._onSlow);
    this.fastBtn.removeEventListener('click', this._onFast);
    for (const node of this._pulses) node.classList.remove('is-damage', 'is-heal');
    this._pulses.clear();
    this.root.remove();
    this.rows = [];
    this.byId.clear();
  }
}
