/**
 * Bootstrap. Builds the engine, wires the service registry in dependency
 * order, mounts the title scene, and publishes the debug surface the capture
 * harness drives.
 */
import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { bus } from './core/EventBus.js';
import { input } from './core/Input.js';
import { gameState } from './core/GameState.js';

import { AssetForge } from './art/AssetForge.js';
import { PostFX } from './render/PostFX.js';
import { VFXSystem } from './vfx/VFXSystem.js';
import { Physics } from './physics/Physics.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { UIRoot } from './ui/UIRoot.js';
import { Director } from './story/Director.js';

import { TitleScene } from './world/TitleScene.js';
import { LookdevScene } from './world/LookdevScene.js';
import { FieldScene } from './world/FieldScene.js';
import { BattleScene } from './battle/BattleScene.js';

const canvas = document.getElementById('stage');
const engine = new Engine(canvas);

input.attach(window);

// Order matters: art before anything that builds materials, postfx before the
// first render, ui last so it can query everything else.
engine.register('art', new AssetForge(engine.renderer));
engine.register('postfx', new PostFX(engine));
engine.register('vfx', new VFXSystem(engine));
engine.register('physics', new Physics(engine));
engine.register('audio', new AudioEngine());
engine.register('story', new Director(engine));
engine.register('ui', new UIRoot(engine));

// Audio can only start inside a user gesture; arm it on the first interaction.
const armAudio = () => {
  engine.get('audio').resume();
  window.removeEventListener('pointerdown', armAudio);
  window.removeEventListener('keydown', armAudio);
};
window.addEventListener('pointerdown', armAudio);
window.addEventListener('keydown', armAudio);

// Quality is a global setting with three independent consumers. Lighting
// subscribes for itself (its cascade count changes an array length, so it has
// to rebuild rather than be told), but PostFX and Sky are both passive: Sky's
// step counts are compile-time constants in its fragment program, so without
// this forward the most expensive shader in the renderer would stay at `high`
// on a machine that asked for `low`.
bus.on('settings:changed', ({ key, value }) => {
  if (key !== 'quality') return;
  engine.get('postfx')?.setQuality(value);
  engine.get('sky')?.setQuality(value);
});

/** Wait until the engine has presented `n` frames, so captures see settled state. */
function framesSettled(n = 3) {
  return new Promise((resolve) => {
    let left = n;
    const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

async function boot() {
  await engine.setScene(new TitleScene(engine));
  engine.start();
  document.getElementById('boot')?.classList.add('done');
}

window.__AW__ = {
  engine,
  THREE,
  bus,
  gameState,
  async gotoTitle() {
    await engine.setScene(new TitleScene(engine));
    await framesSettled();
  },
  async gotoLookdev() {
    await engine.setScene(new LookdevScene(engine));
    await framesSettled(4);
  },
  async gotoField(zoneId = 'lumen-quay') {
    await engine.setScene(new FieldScene(engine, { zoneId }));
    await framesSettled(4);
  },
  async gotoBattle(encounterId = 'shorewatch-ambush') {
    await engine.setScene(new BattleScene(engine, { encounterId }));
    await framesSettled(4);
  },
  async poseCamera(pose) {
    engine.scene?.poseCamera?.(pose);
    await framesSettled(2);
  },
  async setTimeOfDay(t) {
    gameState.state.timeOfDay = t;
    engine.get('sky')?.setTimeOfDay(t);
    engine.scene?.setTimeOfDay?.(t);
    await framesSettled(2);
  },
  async castAbility(abilityId) {
    await engine.scene?.debugCast?.(abilityId);
  },
  async summon(esperId) {
    await engine.scene?.debugSummon?.(esperId);
  },
  async openMenu(panel) {
    engine.get('ui').open(panel);
    await framesSettled(2);
  },
  setQuality(level) {
    gameState.setSetting('quality', level);
  },
  stats() {
    const r = engine.renderer.info;
    // `engine.delta` is the last presented frame's real time, published by the
    // engine precisely so it can be read without side effects — the harness
    // polls this between screenshots and must not perturb the simulation.
    // A single frame is noisy under a software rasteriser, so report both the
    // instantaneous rate and the mean since boot.
    return {
      fps: Math.round(1 / Math.max(1e-4, engine.delta || 1 / 60)),
      meanFps: engine.elapsed > 0.5 ? Math.round(engine.frame / engine.elapsed) : 0,
      drawCalls: r.render.calls,
      triangles: r.render.triangles,
      programs: r.programs?.length ?? 0,
      scene: engine.scene?.constructor.name,
    };
  },
};

boot().catch((err) => {
  console.error('[boot] fatal', err);
  const el = document.getElementById('boot');
  if (el) el.innerHTML = `<pre style="color:#f88;padding:2rem;white-space:pre-wrap">${err.stack ?? err}</pre>`;
});
