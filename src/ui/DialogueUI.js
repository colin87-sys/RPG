/**
 * DialogueUI — the speech bubble, built to `docs/reference/bravely03.jpg`.
 *
 * What the plate actually shows, and what this therefore is: a parchment
 * balloon with a cloud-lobed edge and a narrow pointed tail, dark warm-brown
 * serif text tracked noticeably wide, and an `L Auto-Advance / R Skip` pair in
 * the top-right corner. There is **no name plate and no portrait** in the
 * plate — the tail identifies the speaker by pointing at them, which is why
 * `show()` takes an anchor and why `speaker` only reaches the DOM as an
 * accessibility label.
 *
 * The reveal is a per-character typewriter. Characters are pre-rendered as
 * hidden spans grouped into whole words rather than appended to a growing
 * string, because a growing string reflows the paragraph mid-sentence and the
 * last word of every line visibly hops down as it is typed.
 *
 * Driven by `dialogue:line` / `dialogue:choice` / `dialogue:end` from the
 * catalogue. It reports player intent back as `dialogue:advance` and
 * `dialogue:choice-picked`; see the note on `advance()`.
 */
import { bus } from '../core/EventBus.js';
import { gameState } from '../core/GameState.js';
import { input } from '../core/Input.js';

/** Characters revealed per second at `textSpeed` 1. */
const BASE_CPS = 46;
/** Auto-advance dwell once a line finishes, seconds per character, clamped. */
const AUTO_DWELL_PER_CHAR = 0.045;
const AUTO_DWELL_MIN = 1.2;
const AUTO_DWELL_MAX = 4.0;

const reducedMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function el(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

export class DialogueUI {
  /** @param {HTMLElement} host element to mount into (`#ui-root`) */
  constructor(host) {
    this.host = host;
    this.open = false;
    /** @type {HTMLElement[]} one span per revealable character, in order. */
    this.chars = [];
    this.revealed = 0;
    this.autoAdvance = false;
    this.autoTimer = 0;
    /** @type {{prompt:string, options:any[]}|null} */
    this.choice = null;
    this.choiceIndex = 0;
    this._off = [];
    this._build();
    this._subscribe();
  }

  // --------------------------------------------------------------- markup

  _build() {
    this.root = el('div', 'aw-dialogue');
    this.root.hidden = true;

    this.wrap = el('div', 'aw-bubble-wrap', this.root);
    this.bubble = el('div', 'aw-bubble', this.wrap);
    for (const corner of ['tl', 'bl', 'tr', 'br']) el('div', `aw-bubble-lobe ${corner}`, this.bubble);
    el('div', 'aw-bubble-tail', this.bubble);
    this.text = el('p', 'aw-bubble-text', this.bubble);
    this.more = el('div', 'aw-dlg-more', this.bubble);

    this.choicesEl = el('ul', 'aw-choices', this.root);
    this.choicesEl.hidden = true;

    this.keys = el('div', 'aw-dlg-keys', this.root);
    this.autoKey = this._buildKey('V', 'Auto-Advance', () => this.setAutoAdvance(!this.autoAdvance));
    this.skipKey = this._buildKey('X', 'Skip', () => this.advance('skip'));

    // The bubble itself is a click target: pointer advance is the affordance
    // every player reaches for before finding the keyboard binding.
    this.wrap.style.pointerEvents = 'auto';
    this._onClick = () => this.advance('input');
    this.wrap.addEventListener('click', this._onClick);

    this.host.appendChild(this.root);
  }

  /** A key badge + label pair, matching the plate's `L Auto-Advance` chip. */
  _buildKey(glyph, label, onPress) {
    const button = el('button', 'aw-dlg-key', this.keys);
    button.type = 'button';
    el('b', null, button).textContent = glyph;
    el('span', null, button).textContent = label;
    button.addEventListener('click', onPress);
    this._off.push(() => button.removeEventListener('click', onPress));
    return button;
  }

  // ------------------------------------------------------------- bus wiring

  _subscribe() {
    const on = (type, handler) => this._off.push(bus.on(type, handler));
    on('dialogue:line', (payload = {}) => this.show(payload));
    on('dialogue:choice', (payload = {}) => this.showChoice(payload));
    on('dialogue:end', () => this.hide());
    on('cutscene:end', () => this.hide());
  }

  // ---------------------------------------------------------- public API

  /**
   * Present one line.
   *
   * @param {object} line
   * @param {string} [line.speaker]  who is talking; used as the accessible label
   * @param {string} line.text       the line itself
   * @param {{x?:number,y?:number}} [line.anchor]
   *        normalised viewport position of the speaker's head. The tail points
   *        here. Defaults to frame centre, which is where a single-speaker
   *        scene wants it anyway.
   */
  show({ speaker, text, anchor } = {}) {
    const body = String(text ?? '');
    this._layoutText(body);

    const tailX = Math.min(0.94, Math.max(0.06, Number.isFinite(anchor?.x) ? anchor.x : 0.5));
    // The tail is positioned inside the bubble, so the anchor has to be
    // rebased from viewport fraction onto the bubble's own width once it has
    // been laid out. Reading offsetWidth here is deliberate: the bubble was
    // just rewritten and the geometry has to be current for this frame.
    this.root.hidden = false;
    const bubbleWidth = this.wrap.offsetWidth || 1;
    const bubbleLeft = this.wrap.getBoundingClientRect().left;
    const wanted = tailX * window.innerWidth - bubbleLeft;
    const clamped = Math.min(bubbleWidth - bubbleWidth * 0.12, Math.max(bubbleWidth * 0.12, wanted));
    this.wrap.style.setProperty('--aw-tail-x', `${(clamped / bubbleWidth) * 100}%`);

    this.text.setAttribute('aria-label', speaker ? `${speaker}: ${body}` : body);
    this.root.dataset.speaker = speaker ?? '';
    this.open = true;
    this.revealed = 0;
    this.autoTimer = 0;
    this.root.classList.add('is-open');
    this.root.classList.remove('is-complete');
    this._hideChoice();

    if (reducedMotion) this.complete();
  }

  /**
   * Rebuild the paragraph as word spans of character spans.
   *
   * Whole words are kept in one inline-block so a word can never be split
   * across lines as it is revealed; the spaces between them stay ordinary text
   * nodes so wrapping behaves exactly as it would for a plain paragraph.
   */
  _layoutText(body) {
    this.text.replaceChildren();
    this.chars = [];
    const words = body.split(' ');
    words.forEach((word, index) => {
      if (index > 0) this.text.appendChild(document.createTextNode(' '));
      if (!word) return;
      const wordEl = el('span', 'aw-dlg-word', this.text);
      for (const ch of word) {
        const chEl = el('span', 'aw-dlg-ch', wordEl);
        chEl.textContent = ch;
        this.chars.push(chEl);
      }
    });
  }

  /** Reveal the rest of the line immediately. */
  complete() {
    for (let i = this.revealed; i < this.chars.length; i++) this.chars[i].classList.add('is-on');
    this.revealed = this.chars.length;
    this.root.classList.add('is-complete');
    this.autoTimer = this._autoDwell();
  }

  get isTyping() {
    return this.open && this.revealed < this.chars.length;
  }

  /**
   * Player asked to move on.
   *
   * While the line is still typing this finishes it instead — the universal
   * JRPG contract, and the reason `skip` is a separate affordance.
   *
   * `dialogue:advance` is **not** in `docs/ARCHITECTURE.md`'s catalogue: the
   * catalogue has the Director talking to the UI but nothing coming back. The
   * event is additive and the Director is free to ignore it and call
   * `advance()`'s sibling promise instead; see `waitForAdvance()`.
   *
   * @param {'input'|'auto'|'skip'} reason
   */
  advance(reason = 'input') {
    if (!this.open) return;
    if (reason !== 'skip' && this.isTyping) {
      this.complete();
      return;
    }
    this.autoTimer = 0;
    bus.emit('dialogue:advance', { reason });
    this._resolveAdvance?.(reason);
    this._resolveAdvance = null;
  }

  /**
   * Resolves the next time the player advances the line. Lets a Director
   * `await` the UI without subscribing to an off-catalogue event.
   * @returns {Promise<'input'|'auto'|'skip'>}
   */
  waitForAdvance() {
    return new Promise((resolve) => {
      this._resolveAdvance = resolve;
    });
  }

  setAutoAdvance(on) {
    this.autoAdvance = !!on;
    this.autoKey.classList.toggle('is-on', this.autoAdvance);
    this.autoKey.setAttribute('aria-pressed', String(this.autoAdvance));
    if (this.autoAdvance && !this.isTyping && this.open) this.autoTimer = this._autoDwell();
  }

  /** Reading time for the finished line, proportional to its length. */
  _autoDwell() {
    return Math.min(AUTO_DWELL_MAX, Math.max(AUTO_DWELL_MIN, this.chars.length * AUTO_DWELL_PER_CHAR));
  }

  /**
   * Present a branch. Options may be strings or `{text, id}`; the picked
   * option is reported as `dialogue:choice-picked` with its index and id.
   */
  showChoice({ prompt, options } = {}) {
    const list = Array.isArray(options) ? options : [];
    if (!list.length) return;
    if (prompt) this.show({ text: prompt });

    this.choice = { options: list };
    this.choiceIndex = 0;
    this.choicesEl.replaceChildren();
    list.forEach((option, index) => {
      const item = el('li', 'aw-choice', this.choicesEl);
      item.textContent = typeof option === 'string' ? option : (option?.text ?? String(option));
      item.addEventListener('click', () => this._pickChoice(index));
      item.addEventListener('pointerenter', () => this._highlightChoice(index));
    });
    this.choicesEl.hidden = false;
    this.root.hidden = false;
    this.open = true;
    this.root.classList.add('is-open');
    this._highlightChoice(0);
  }

  _highlightChoice(index) {
    if (!this.choice) return;
    const count = this.choice.options.length;
    this.choiceIndex = ((index % count) + count) % count;
    const items = this.choicesEl.children;
    for (let i = 0; i < items.length; i++) items[i].classList.toggle('is-selected', i === this.choiceIndex);
  }

  _pickChoice(index) {
    if (!this.choice) return;
    this._highlightChoice(index);
    const option = this.choice.options[this.choiceIndex];
    bus.emit('dialogue:choice-picked', {
      index: this.choiceIndex,
      id: typeof option === 'string' ? option : option?.id ?? this.choiceIndex,
    });
    this._hideChoice();
  }

  _hideChoice() {
    this.choice = null;
    this.choicesEl.hidden = true;
    this.choicesEl.replaceChildren();
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('is-open', 'is-complete');
    this.root.hidden = true;
    this._hideChoice();
    this._resolveAdvance = null;
  }

  // ------------------------------------------------------------- per frame

  update(dt) {
    if (!this.open) return;
    const step = Math.min(0.1, Math.max(0, dt || 0));

    if (this.choice) {
      this._updateChoiceInput();
      return;
    }

    if (this.isTyping) {
      const speed = Math.max(0.25, gameState.state.settings.textSpeed || 1);
      this.revealed = Math.min(this.chars.length, this.revealed + BASE_CPS * speed * step);
      const upTo = Math.floor(this.revealed);
      for (let i = 0; i < upTo; i++) {
        const ch = this.chars[i];
        if (!ch.classList.contains('is-on')) ch.classList.add('is-on');
      }
      if (upTo >= this.chars.length) this.complete();
    } else if (this.autoAdvance && this.autoTimer > 0) {
      this.autoTimer -= step;
      if (this.autoTimer <= 0) this.advance('auto');
    }

    if (input.consume('confirm')) this.advance('input');
    else if (input.consume('cancel')) this.advance('skip');
    if (input.consume('special')) this.setAutoAdvance(!this.autoAdvance);
  }

  _updateChoiceInput() {
    if (input.consume('up')) this._highlightChoice(this.choiceIndex - 1);
    if (input.consume('down')) this._highlightChoice(this.choiceIndex + 1);
    if (input.consume('confirm')) this._pickChoice(this.choiceIndex);
  }

  dispose() {
    for (const off of this._off) off();
    this._off.length = 0;
    this.wrap.removeEventListener('click', this._onClick);
    this.root.remove();
    this.chars = [];
    this._resolveAdvance = null;
  }
}
