/**
 * Touch controls (phones / tablets). Activated by the first touch; hidden for
 * mouse/keyboard play. DOM overlay above the canvases:
 *   left half  - floating thumb stick (appears where the thumb lands)
 *   right side - MSL (hold, sweep, release), ROLL (toward the stick), WING
 *   top right  - pause
 *   elsewhere  - a tap is "confirm" (title, stage card, results, game over)
 * The cannon auto-fires (all input modes). Input.poll() merges touch() into the frame.
 */
import { palette } from '../style/tokens';

export interface TouchState {
  moveX: number;
  moveY: number;
  lock: boolean;
  roll: boolean;
  wingtrail: boolean;
  /** one-poll pulses */
  confirm: boolean;
  pause: boolean;
}

type ButtonKey = 'lock' | 'roll' | 'wingtrail';

const STICK_RADIUS_VMIN = 11;

export class TouchControls {
  active = false;
  /** the overlay is showing gameplay buttons (true while a stage is being played) */
  private playing = false;
  private root: HTMLDivElement;
  private stickZone: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private rotateHint: HTMLDivElement;
  private buttons = new Map<ButtonKey, { el: HTMLDivElement; pointers: Set<number> }>();
  /** everything shown only during play (buttons + pause) */
  private playEls: HTMLDivElement[] = [];
  private stickPointer = -1;
  private stickOrigin = { x: 0, y: 0 };
  private stick = { x: 0, y: 0 };
  private confirmPulse = false;
  private pausePulse = false;
  onActivate: (() => void) | null = null;

  constructor() {
    const root = (this.root = document.createElement('div'));
    root.id = 'touch';
    Object.assign(root.style, { position: 'fixed', inset: '0', zIndex: '5', display: 'none', touchAction: 'none', userSelect: 'none', webkitUserSelect: 'none' } as CSSStyleDeclaration);

    // tap-anywhere layer (confirm) sits underneath the controls
    root.addEventListener('pointerdown', (e) => {
      if (e.target === root) { this.confirmPulse = true; e.preventDefault(); }
    });

    // --- stick (left 48%, below the top HUD band) ---
    const zone = (this.stickZone = document.createElement('div'));
    Object.assign(zone.style, { position: 'absolute', left: '0', top: '14%', width: '48%', bottom: '11vh', touchAction: 'none' } as CSSStyleDeclaration);
    const base = (this.stickBase = document.createElement('div'));
    const knob = (this.stickKnob = document.createElement('div'));
    const r = STICK_RADIUS_VMIN;
    Object.assign(base.style, {
      position: 'absolute', width: `${r * 2}vmin`, height: `${r * 2}vmin`, marginLeft: `${-r}vmin`, marginTop: `${-r}vmin`,
      borderRadius: '50%', border: `2px solid ${palette.hudLine}`, background: `${palette.hudBacking}55`, display: 'none', pointerEvents: 'none',
    } as CSSStyleDeclaration);
    Object.assign(knob.style, {
      position: 'absolute', width: `${r * 0.9}vmin`, height: `${r * 0.9}vmin`, marginLeft: `${-r * 0.45}vmin`, marginTop: `${-r * 0.45}vmin`,
      borderRadius: '50%', background: `${palette.hudText}88`, border: `2px solid ${palette.hudValue}`, display: 'none', pointerEvents: 'none',
    } as CSSStyleDeclaration);
    zone.append(base, knob);
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!this.playing) { this.confirmPulse = true; return; }
      if (this.stickPointer !== -1) return;
      this.stickPointer = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stick = { x: 0, y: 0 };
      this.placeStick(e.clientX, e.clientY, true);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickPointer) return;
      const R = (Math.min(window.innerWidth, window.innerHeight) * STICK_RADIUS_VMIN) / 100;
      let dx = e.clientX - this.stickOrigin.x, dy = e.clientY - this.stickOrigin.y;
      const d = Math.hypot(dx, dy);
      if (d > R) {
        // drag the origin along so reversing direction is instant
        this.stickOrigin.x += (dx / d) * (d - R);
        this.stickOrigin.y += (dy / d) * (d - R);
        dx = e.clientX - this.stickOrigin.x; dy = e.clientY - this.stickOrigin.y;
      }
      const dead = 0.12;
      const mag = Math.min(1, Math.hypot(dx, dy) / R);
      const k = mag < dead ? 0 : (mag - dead) / (1 - dead) / Math.max(mag, 1e-6);
      this.stick = { x: (dx / R) * k, y: (-dy / R) * k };
      this.placeStick(e.clientX, e.clientY, false);
    });
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickPointer = -1;
      this.stick = { x: 0, y: 0 };
      base.style.display = knob.style.display = 'none';
    };
    zone.addEventListener('pointerup', endStick);
    zone.addEventListener('pointercancel', endStick);
    root.append(zone);

    // --- buttons (right side), sizes/positions in vmin from the right/bottom edges ---
    const btn = (key: ButtonKey, label: string, right: number, bottom: number, size: number, hot = false) => {
      const el = document.createElement('div');
      el.textContent = label;
      Object.assign(el.style, {
        position: 'absolute', right: `${right}vmin`, bottom: `calc(${bottom}vmin + 11vh)`, width: `${size}vmin`, height: `${size}vmin`,
        borderRadius: '50%', border: `2px solid ${hot ? palette.lockRed : palette.hudLine}`, background: `${palette.hudBacking}66`,
        color: hot ? palette.lockRed : palette.hudText, font: `700 ${Math.max(2.4, size * 0.2)}vmin monospace`, letterSpacing: '0.05em',
        display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none', userSelect: 'none',
      } as CSSStyleDeclaration);
      const pointers = new Set<number>();
      const down = (e: PointerEvent) => { e.preventDefault(); e.stopPropagation(); pointers.add(e.pointerId); el.setPointerCapture(e.pointerId); this.paint(el, true, hot); };
      const up = (e: PointerEvent) => { pointers.delete(e.pointerId); if (!pointers.size) this.paint(el, false, hot); };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      this.buttons.set(key, { el, pointers });
      this.playEls.push(el);
      root.append(el);
    };
    btn('lock', 'MSL', 4, 0, 20, true);
    btn('roll', 'ROLL', 27, 0, 14);
    btn('wingtrail', 'WING', 7, 23, 12);

    // pause
    const pause = document.createElement('div');
    pause.textContent = 'II';
    Object.assign(pause.style, {
      position: 'absolute', right: '2vmin', top: '15vmin', width: '9vmin', height: '9vmin', borderRadius: '2vmin',
      border: `2px solid ${palette.hudLine}`, background: `${palette.hudBacking}66`, color: palette.hudText,
      font: '700 3.5vmin monospace', display: 'flex', alignItems: 'center', justifyContent: 'center', touchAction: 'none',
    } as CSSStyleDeclaration);
    pause.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.pausePulse = true; });
    root.append(pause);
    this.playEls.push(pause);

    // portrait hint
    const hint = (this.rotateHint = document.createElement('div'));
    hint.textContent = 'ROTATE TO LANDSCAPE';
    Object.assign(hint.style, {
      position: 'absolute', left: '0', right: '0', top: '40%', textAlign: 'center', color: palette.hudValue,
      font: '700 5vmin monospace', letterSpacing: '0.15em', pointerEvents: 'none', display: 'none', textShadow: `0 0 8px ${palette.hudBacking}`,
    } as CSSStyleDeclaration);
    root.append(hint);

    document.body.append(root);
    // native touch default actions (scroll, zoom, long-press menu) off inside the overlay
    root.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    const activate = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || this.active) return;
      this.active = true;
      root.style.display = 'block';
      this.updateLayout();
      // first touch also counts as a tap
      this.confirmPulse = true;
      void this.goFullscreen();
      this.onActivate?.();
    };
    window.addEventListener('pointerdown', activate, { capture: true });
    window.addEventListener('resize', () => this.updateLayout());
    this.updateLayout();
  }

  private placeStick(x: number, y: number, first: boolean): void {
    const zr = this.stickZone.getBoundingClientRect();
    if (first) {
      this.stickBase.style.display = this.stickKnob.style.display = 'block';
      this.stickBase.style.left = `${this.stickOrigin.x - zr.left}px`;
      this.stickBase.style.top = `${this.stickOrigin.y - zr.top}px`;
    } else {
      this.stickBase.style.left = `${this.stickOrigin.x - zr.left}px`;
      this.stickBase.style.top = `${this.stickOrigin.y - zr.top}px`;
    }
    this.stickKnob.style.left = `${x - zr.left}px`;
    this.stickKnob.style.top = `${y - zr.top}px`;
  }

  private paint(el: HTMLDivElement, on: boolean, hot: boolean): void {
    el.style.background = on ? `${hot ? palette.lockRed : palette.hudText}88` : `${palette.hudBacking}66`;
    el.style.color = on ? palette.hudBacking : hot ? palette.lockRed : palette.hudText;
  }

  private async goFullscreen(): Promise<void> {
    try {
      const d = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      if (!document.fullscreenElement) await (d.requestFullscreen?.() ?? d.webkitRequestFullscreen?.());
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      await o?.lock?.('landscape');
    } catch { /* not supported (iOS Safari): the rotate hint covers it */ }
  }

  /** Show gameplay buttons only while a stage is being played. */
  setPlaying(on: boolean): void {
    if (on === this.playing) return;
    this.playing = on;
    this.updateLayout();
  }

  private updateLayout(): void {
    const portrait = window.innerHeight > window.innerWidth;
    this.rotateHint.style.display = this.active && portrait ? 'block' : 'none';
    const show = this.active && this.playing;
    for (const el of this.playEls) el.style.display = show ? 'flex' : 'none';
    if (!show) {
      this.stick = { x: 0, y: 0 };
      this.stickPointer = -1;
      this.stickBase.style.display = this.stickKnob.style.display = 'none';
      for (const [, b] of this.buttons) b.pointers.clear();
    }
  }

  /** Current touch state; pulses (confirm, pause) are consumed by this call. */
  read(): TouchState {
    const held = (k: ButtonKey) => (this.buttons.get(k)?.pointers.size ?? 0) > 0;
    const s: TouchState = {
      moveX: this.stick.x, moveY: this.stick.y,
      lock: held('lock'), roll: held('roll'), wingtrail: held('wingtrail'),
      confirm: this.confirmPulse, pause: this.pausePulse,
    };
    this.confirmPulse = false;
    this.pausePulse = false;
    return s;
  }
}

/** Keyboard/mouse tutorial prompts rewritten for touch play. */
export function touchPrompt(text: string): string {
  return text
    .replace('STEER: WASD / MOUSE', 'STEER: LEFT THUMB')
    .replace('HOLD K / LEFT MOUSE', 'HOLD MSL')
    .replace('ROLL (SPACE)', 'TAP ROLL')
    .replace('WING (E)', 'WING');
}
