/**
 * App shell: WebGL canvas + HUD canvas, renderer setup, resize, and the
 * fixed-step main loop. Owned by the Integrator. Game code plugs in through
 * the AppHooks interface; the post stack plugs in through Renderable.
 */
import * as THREE from 'three';
import { Clock, FIXED_DT } from './clock';
import type { Params } from './params';

export interface AppHooks {
  /** one fixed simulation step */
  update(dt: number): void;
  /** draw the current state (called once per animation frame, and after step(n)) */
  render(alpha: number): void;
}

export interface AppOptions {
  params: Params;
  container: HTMLElement;
}

export class App {
  readonly renderer: THREE.WebGLRenderer;
  readonly glCanvas: HTMLCanvasElement;
  readonly hudCanvas: HTMLCanvasElement;
  readonly hudCtx: CanvasRenderingContext2D;
  readonly clock: Clock;
  readonly params: Params;
  /** CSS pixel size and device pixel ratio actually used */
  width = 1;
  height = 1;
  pixelRatio = 1;
  hooks: AppHooks | null = null;
  private resizeListeners: ((w: number, h: number) => void)[] = [];
  private running = false;
  paused = false;
  readonly softwareGL: boolean;

  constructor(opts: AppOptions) {
    this.params = opts.params;
    this.clock = new Clock(opts.params.det);
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.id = 'gl';
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.id = 'hud';
    opts.container.appendChild(this.glCanvas);
    opts.container.appendChild(this.hudCanvas);
    const capture = opts.params.det || opts.params.debug;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.glCanvas,
      antialias: false, // MSAA happens on the HDR target in the post stack
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: capture, // captures read the buffer after render
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping; // the post stack tone-maps
    const ctx = this.hudCanvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.hudCtx = ctx;
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.softwareGL = /swiftshader|llvmpipe|software/i.test(rendererName);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clock.resetWall();
    });
  }

  onResize(fn: (w: number, h: number) => void): void {
    this.resizeListeners.push(fn);
    fn(this.width, this.height);
  }

  resize(): void {
    const p = this.params;
    const w = p.w ?? window.innerWidth;
    const h = p.h ?? window.innerHeight;
    // Fixed-size captures render at exactly w x h device pixels.
    const pr = p.w && p.h ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.width = w;
    this.height = h;
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.glCanvas.style.width = `${w}px`;
    this.glCanvas.style.height = `${h}px`;
    this.hudCanvas.width = Math.round(w * pr);
    this.hudCanvas.height = Math.round(h * pr);
    this.hudCanvas.style.width = `${w}px`;
    this.hudCanvas.style.height = `${h}px`;
    for (const fn of this.resizeListeners) fn(w, h);
  }

  start(hooks: AppHooks): void {
    this.hooks = hooks;
    if (this.running) return;
    this.running = true;
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      if (!this.hooks) return;
      if (this.clock.deterministic) return; // driven by step(n) only
      const n = this.paused ? 0 : this.clock.stepsFor(now);
      for (let i = 0; i < n; i++) {
        this.hooks.update(FIXED_DT);
        this.clock.tick();
      }
      this.hooks.render(this.clock.alpha);
    };
    requestAnimationFrame(loop);
  }

  /** Advance exactly n fixed steps, then render once. Works in any mode. */
  step(n: number, render = true): void {
    if (!this.hooks) return;
    for (let i = 0; i < n; i++) {
      this.hooks.update(FIXED_DT);
      this.clock.tick();
    }
    if (render) this.hooks.render(0);
  }

  /** Composite GL + HUD into one PNG data URL (for __game.capture()). */
  captureDataURL(): string {
    const c = document.createElement('canvas');
    c.width = this.glCanvas.width;
    c.height = this.glCanvas.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(this.glCanvas, 0, 0);
    ctx.drawImage(this.hudCanvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }
}
