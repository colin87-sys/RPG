/**
 * Engine — renderer ownership, the frame loop, and scene arbitration.
 *
 * Everything visual hangs off here. The engine itself knows nothing about
 * combat or story; it drives whatever Scene is currently mounted and exposes
 * a debug surface (`window.__AW__`) the capture harness poses the game with.
 *
 * Frame model: a fixed 60 Hz simulation step with an accumulator, plus a
 * variable-rate render. Combat timing and physics stay deterministic while
 * the camera and post chain run as fast as the display allows.
 */
import * as THREE from 'three';
import { bus } from './EventBus.js';
import { input } from './Input.js';
import { gameState } from './GameState.js';

const FIXED_STEP = 1 / 60;
const MAX_STEPS = 5; // Beyond this we drop time rather than spiral.

/**
 * Base class every scene extends. The lifecycle is deliberately small.
 * `mount` may be async — the engine shows the loading veil until it resolves.
 */
export class Scene {
  constructor(engine) {
    this.engine = engine;
    this.scene = new THREE.Scene();
    /** Scenes may override the engine camera by assigning their own. */
    this.camera = null;
    this._disposables = [];
  }
  /** @returns {Promise<void>|void} */
  async mount() {}
  /** Fixed-rate simulation. */
  fixedUpdate(_dt) {}
  /** Variable-rate update, called once per rendered frame. */
  update(_dt, _alpha) {}
  /** Called when the viewport changes. */
  resize(_w, _h) {}
  /** Track something that needs `.dispose()` at unmount. */
  track(obj) {
    this._disposables.push(obj);
    return obj;
  }
  async unmount() {
    for (const d of this._disposables) {
      try {
        d.dispose?.();
      } catch (err) {
        console.warn('[Scene] dispose failed', err);
      }
    }
    this._disposables.length = 0;
    disposeTree(this.scene);
  }
}

/** Recursively free GPU resources held by a subtree. */
export function disposeTree(root) {
  root.traverse((obj) => {
    obj.geometry?.dispose?.();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) {
      for (const key of Object.keys(m)) {
        const v = m[key];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose?.();
    }
  });
  root.clear?.();
}

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.clock = new THREE.Clock();
    this.accumulator = 0;
    this.elapsed = 0;
    this.frame = 0;
    this.running = false;
    /** Global time scale — cutscenes and hit-stop drive this. */
    this.timeScale = 1;
    /** @type {Scene|null} */
    this.scene = null;
    /** Set by render/PostFX.js once it takes over presentation. */
    this.composer = null;
    /** Populated by subsystems that want a per-frame tick without a scene. */
    this.services = new Map();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // Post chain owns AA; MSAA would fight the HDR buffer.
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(this._targetPixelRatio());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x05070d, 1);

    this.camera = new THREE.PerspectiveCamera(48, 16 / 9, 0.1, 4000);
    this.camera.position.set(0, 4, 10);
    this.camera.lookAt(0, 1.5, 0);

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  _targetPixelRatio() {
    // SwiftShader captures run at DPR 1; on real hardware cap at 2 so a 4K
    // display doesn't quietly quadruple the post-chain cost.
    if (typeof window !== 'undefined' && window.__AW_CAPTURE__) return 1;
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  register(name, service) {
    this.services.set(name, service);
    return service;
  }

  get(name) {
    return this.services.get(name);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(this._targetPixelRatio());
    this.renderer.setSize(w, h, false);
    const cam = this.scene?.camera ?? this.camera;
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    this.composer?.setSize(w, h);
    this.scene?.resize(w, h);
    bus.emit('engine:resize', { width: w, height: h });
  }

  /** Swap the active scene, disposing the outgoing one. */
  async setScene(scene) {
    const previous = this.scene;
    bus.emit('scene:changing', { from: previous?.constructor.name, to: scene.constructor.name });
    this.scene = null; // Stop ticking while we build.
    if (previous) await previous.unmount();
    await scene.mount();
    this.scene = scene;
    this.resize();
    bus.emit('scene:changed', { scene });
    return scene;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(() => this._tick());
    bus.emit('engine:started');
  }

  stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  _tick() {
    // Clamp: a background tab or a long shader compile must not fast-forward
    // the simulation by a full second of steps.
    const raw = Math.min(this.clock.getDelta(), 0.25);
    const dt = raw * this.timeScale;
    this.elapsed += dt;
    this.frame++;

    input.update();

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS) {
      this.scene?.fixedUpdate(FIXED_STEP);
      for (const s of this.services.values()) s.fixedUpdate?.(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.accumulator = 0;

    const alpha = this.accumulator / FIXED_STEP;
    this.scene?.update(dt, alpha);
    for (const s of this.services.values()) s.update?.(dt, alpha);

    gameState.state.playtimeSeconds += raw;

    this.render();
    input.endFrame();
  }

  render() {
    const scene = this.scene;
    if (!scene) return;
    const cam = scene.camera ?? this.camera;
    if (this.composer) this.composer.render();
    else this.renderer.render(scene.scene, cam);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.scene?.unmount();
    this.composer?.dispose?.();
    this.renderer.dispose();
  }
}
