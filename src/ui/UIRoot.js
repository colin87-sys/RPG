/**
 * UIRoot — owns `#ui-root` and the HUD layers mounted inside it.
 *
 * The whole interface is DOM over the canvas rather than drawn in WebGL: text
 * is the one thing a browser renders better than we could, and keeping the HUD
 * out of the render graph means it costs no draw calls and survives every
 * post-processing change PostFX makes.
 *
 * This class stays deliberately thin. It creates the layers, forwards the
 * frame, and owns exactly one piece of state of its own — which full-screen
 * panel is open — because that is the only thing `main.js` and the capture
 * harness ask it about.
 */
import { bus } from '../core/EventBus.js';
import { BattleUI } from './BattleUI.js';
import { DialogueUI } from './DialogueUI.js';

export class UIRoot {
  constructor(engine) {
    this.engine = engine;
    this.el = document.getElementById('ui-root');
    /** @type {string|null} the open full-screen panel, or null. */
    this.panel = null;

    this.battle = new BattleUI(this.el);
    this.dialogue = new DialogueUI(this.el);

    // `ui:open` / `ui:close` are two-way in the catalogue: anything may ask for
    // a panel without holding a reference to this service. `_setPanel` is the
    // shared tail so a bus-driven open does not echo straight back out.
    this._off = [
      bus.on('ui:open', ({ panel } = {}) => this._setPanel(panel ?? null)),
      bus.on('ui:close', () => this._setPanel(null)),
    ];
  }

  /**
   * Open a full-screen panel by name. The battle HUD steps back while one is
   * up (see `#ui-root[data-panel]` in theme.css) so the panel owns the frame.
   */
  open(panel) {
    if (this.panel === panel) return;
    this._setPanel(panel ?? null);
    bus.emit('ui:open', { panel: this.panel });
  }

  close() {
    if (this.panel === null) return;
    this._setPanel(null);
    bus.emit('ui:close', { panel: null });
  }

  _setPanel(panel) {
    this.panel = panel;
    // Drives the dimming rule; an empty string keeps the attribute selector
    // from matching when nothing is open.
    this.el.dataset.panel = panel ?? '';
  }

  update(dt) {
    this.battle.update(dt);
    this.dialogue.update(dt);
  }

  dispose() {
    for (const off of this._off) off();
    this._off.length = 0;
    this.battle.dispose();
    this.dialogue.dispose();
    this.panel = null;
    delete this.el.dataset.panel;
  }
}
