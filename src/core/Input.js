/**
 * Input — one abstract action layer over keyboard, mouse, gamepad and touch.
 *
 * Gameplay code asks "is `confirm` down?" and never learns whether that was a
 * Z key, a gamepad A button, or a tap. Held state is polled from the loop;
 * discrete presses are consumed exactly once so a menu can't eat the same
 * confirm twice in a frame.
 */
import { bus } from './EventBus.js';

/** Logical actions the game understands. */
export const ACTIONS = [
  'up', 'down', 'left', 'right',
  'confirm', 'cancel', 'menu', 'special',
  'camLeft', 'camRight', 'camUp', 'camDown',
  'run', 'interact', 'pause', 'debug',
];

const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'confirm', Enter: 'confirm', KeyZ: 'confirm',
  Escape: 'cancel', KeyX: 'cancel', Backspace: 'cancel',
  Tab: 'menu', KeyC: 'menu',
  KeyQ: 'camLeft', KeyE: 'camRight',
  KeyR: 'camUp', KeyF: 'camDown',
  ShiftLeft: 'run', ShiftRight: 'run',
  KeyF1: 'debug', Backquote: 'debug',
  KeyP: 'pause',
  KeyV: 'special',
};

/** Standard-gamepad button index -> action. */
const PADMAP = {
  0: 'confirm', 1: 'cancel', 2: 'special', 3: 'menu',
  9: 'pause',
  12: 'up', 13: 'down', 14: 'left', 15: 'right',
};

class InputManager {
  constructor() {
    /** @type {Set<string>} actions currently held */
    this.held = new Set();
    /** @type {Set<string>} actions pressed since the last consume */
    this.pressed = new Set();
    /** Analogue stick / dpad resolved to a unit-ish vector. */
    this.axis = { x: 0, y: 0 };
    /** Right stick, for camera. */
    this.camAxis = { x: 0, y: 0 };
    this.pointer = { x: 0, y: 0, down: false, ndcX: 0, ndcY: 0 };
    this.enabled = true;
    this._padPrev = new Set();
    this._bound = false;
  }

  attach(target = window) {
    if (this._bound) return;
    this._bound = true;

    target.addEventListener('keydown', (e) => {
      const action = KEYMAP[e.code];
      if (!action) return;
      // Space and arrows scroll the page; the game owns them.
      if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      this._press(action);
    });

    target.addEventListener('keyup', (e) => {
      const action = KEYMAP[e.code];
      if (action) this._release(action);
    });

    // Losing focus mid-hold would otherwise leave the character sprinting.
    target.addEventListener('blur', () => {
      for (const a of [...this.held]) this._release(a);
    });

    const canvas = document.getElementById('stage') ?? target;
    canvas.addEventListener('pointermove', (e) => this._pointer(e));
    canvas.addEventListener('pointerdown', (e) => {
      this._pointer(e);
      this.pointer.down = true;
      bus.emit('input:pointerdown', { ...this.pointer });
    });
    target.addEventListener('pointerup', () => {
      this.pointer.down = false;
      bus.emit('input:pointerup', { ...this.pointer });
    });
  }

  _pointer(e) {
    const r = (e.target.getBoundingClientRect?.() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight });
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.ndcX = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.ndcY = -((e.clientY - r.top) / r.height) * 2 + 1;
  }

  _press(action) {
    if (!this.enabled) return;
    this.held.add(action);
    this.pressed.add(action);
    bus.emit('input:press', action);
  }

  _release(action) {
    this.held.delete(action);
    bus.emit('input:release', action);
  }

  /** Poll gamepads and refresh derived axes. Called once per frame. */
  update() {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = [...pads].find(Boolean);
    const now = new Set();

    if (pad) {
      for (const [index, action] of Object.entries(PADMAP)) {
        if (pad.buttons[index]?.pressed) {
          now.add(action);
          if (!this._padPrev.has(action)) this._press(action);
        }
      }
      for (const a of this._padPrev) if (!now.has(a)) this._release(a);
      this._padPrev = now;
    }

    const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
    let ax = pad ? dz(pad.axes[0] ?? 0) : 0;
    let ay = pad ? dz(pad.axes[1] ?? 0) : 0;
    if (this.held.has('left')) ax -= 1;
    if (this.held.has('right')) ax += 1;
    if (this.held.has('up')) ay -= 1;
    if (this.held.has('down')) ay += 1;

    const len = Math.hypot(ax, ay);
    if (len > 1) {
      ax /= len;
      ay /= len;
    }
    this.axis.x = ax;
    this.axis.y = ay;

    let cx = pad ? dz(pad.axes[2] ?? 0) : 0;
    let cy = pad ? dz(pad.axes[3] ?? 0) : 0;
    if (this.held.has('camLeft')) cx -= 1;
    if (this.held.has('camRight')) cx += 1;
    if (this.held.has('camUp')) cy -= 1;
    if (this.held.has('camDown')) cy += 1;
    this.camAxis.x = cx;
    this.camAxis.y = cy;

    this.running = this.held.has('run') || !!pad?.buttons[10]?.pressed;
  }

  isDown(action) {
    return this.held.has(action);
  }

  /** True once per press. Consumes the press so only one caller sees it. */
  consume(action) {
    if (!this.pressed.has(action)) return false;
    this.pressed.delete(action);
    return true;
  }

  /** Called at the end of each frame — anything not consumed is discarded. */
  endFrame() {
    this.pressed.clear();
  }
}

export const input = new InputManager();
