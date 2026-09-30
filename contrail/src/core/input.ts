/**
 * Input: keyboard, mouse and gamepad mapped to one action frame per simulation step.
 * A script source (bot / goldpath) can override the live devices completely.
 * Bindings and dead zones are in DESIGN.md "Controls".
 */

export interface InputFrame {
  /** steering, -1..1 (x right, y up) */
  moveX: number;
  moveY: number;
  /** absolute reticle target in NDC (-1..1) from the mouse; null when the mouse is idle */
  aim: { x: number; y: number } | null;
  fire: boolean;
  lock: boolean;
  boost: boolean;
  brake: boolean;
  rollLeft: boolean;
  rollRight: boolean;
  drift: boolean;
  wingtrail: boolean;
  pause: boolean;
  confirm: boolean;
  back: boolean;
}

export function emptyFrame(): InputFrame {
  return {
    moveX: 0, moveY: 0, aim: null,
    fire: false, lock: false, boost: false, brake: false,
    rollLeft: false, rollRight: false, drift: false, wingtrail: false,
    pause: false, confirm: false, back: false,
  };
}

export type InputScript = (frame: number) => Partial<InputFrame>;

const STICK_DEAD_ZONE = 0.18;
const MOUSE_IDLE_MS = 1500;

export class Input {
  private keys = new Set<string>();
  private mouseButtons = new Set<number>();
  private mouseNdc: { x: number; y: number } | null = null;
  private mouseMovedAt = -1e9;
  private script: InputScript | null = null;
  /** last produced frame, for edge detection by consumers */
  prev: InputFrame = emptyFrame();
  cur: InputFrame = emptyFrame();
  /** true when the latest human input came from a gamepad (HUD prompts) */
  usingGamepad = false;

  constructor(private target: HTMLElement | null) {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      this.usingGamepad = false;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseButtons.clear();
    });
    const el = target ?? window;
    el.addEventListener('mousemove', (e: Event) => {
      const m = e as MouseEvent;
      const w = window.innerWidth, h = window.innerHeight;
      this.mouseNdc = { x: (m.clientX / w) * 2 - 1, y: -((m.clientY / h) * 2 - 1) };
      this.mouseMovedAt = performance.now();
      this.usingGamepad = false;
    });
    el.addEventListener('mousedown', (e: Event) => {
      this.mouseButtons.add((e as MouseEvent).button);
      this.mouseMovedAt = performance.now();
    });
    window.addEventListener('mouseup', (e) => this.mouseButtons.delete(e.button));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setScript(script: InputScript | null): void {
    this.script = script;
  }

  get scripted(): boolean {
    return this.script !== null;
  }

  /** Build the action frame for simulation frame `frame`. Call once per fixed step. */
  poll(frame: number): InputFrame {
    this.prev = this.cur;
    const f = emptyFrame();
    if (this.script) {
      Object.assign(f, this.script(frame));
      this.cur = f;
      return f;
    }
    const k = (c: string) => this.keys.has(c);
    // keyboard
    let mx = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    let my = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
    f.fire = k('KeyJ') || this.mouseButtons.has(0);
    f.lock = k('KeyK') || this.mouseButtons.has(2);
    f.rollLeft = k('KeyQ');
    f.rollRight = k('KeyE');
    f.drift = k('KeyL');
    f.wingtrail = k('Space');
    f.boost = k('ShiftLeft') || k('ShiftRight');
    f.brake = k('KeyC');
    f.pause = k('Escape') || k('KeyP');
    f.confirm = k('Enter') || k('Space') || k('KeyJ');
    f.back = k('Escape') || k('Backspace');

    // gamepad (standard mapping)
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const ax = (i: number) => {
        const v = p.axes[i] ?? 0;
        return Math.abs(v) < STICK_DEAD_ZONE ? 0 : (v - Math.sign(v) * STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE);
      };
      const b = (i: number) => !!p.buttons[i]?.pressed;
      const sx = ax(0), sy = -ax(1);
      if (sx !== 0 || sy !== 0 || p.buttons.some((x) => x.pressed)) this.usingGamepad = true;
      if (Math.abs(sx) > Math.abs(mx)) mx = sx;
      if (Math.abs(sy) > Math.abs(my)) my = sy;
      f.fire ||= b(7); // RT
      f.lock ||= b(6); // LT
      f.rollLeft ||= b(4); // LB
      f.rollRight ||= b(5); // RB
      f.drift ||= b(2); // X
      f.wingtrail ||= b(3); // Y
      f.boost ||= b(0); // A
      f.brake ||= b(1); // B
      f.pause ||= b(9); // Start
      f.confirm ||= b(0);
      f.back ||= b(1);
      if (b(12)) my = 1;
      if (b(13)) my = -1;
      if (b(14)) mx = -1;
      if (b(15)) mx = 1;
    }
    f.moveX = Math.max(-1, Math.min(1, mx));
    f.moveY = Math.max(-1, Math.min(1, my));
    const mouseActive = this.mouseNdc && performance.now() - this.mouseMovedAt < MOUSE_IDLE_MS && f.moveX === 0 && f.moveY === 0;
    f.aim = mouseActive ? { ...this.mouseNdc! } : null;
    this.cur = f;
    return f;
  }

  /** Rising edge helper. */
  pressed(key: keyof InputFrame): boolean {
    return !!this.cur[key] && !this.prev[key];
  }

  released(key: keyof InputFrame): boolean {
    return !this.cur[key] && !!this.prev[key];
  }
}
