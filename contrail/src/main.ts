/**
 * CONTRAIL entry: boots the app shell, simulation, view (lane modules), post
 * stack, HUD, screens, audio, and the window.__game debug API. Integrator-owned.
 */
import * as THREE from 'three';
import { readParams } from './core/params';
import { App } from './core/app';
import { Input } from './core/input';
import { Game } from './game/game';
import { View, STORY_CAMERAS, type StoryCamera } from './game/view';
import { HudAdapter } from './game/hudAdapter';
import { Bot } from './game/bot';
import { installErrorCapture, type GameDebugAPI } from './debug/api';
import { post as postTok } from './style/tokens';
import { PostStack, POST_VARIANTS } from './gen/vfx/post';
import { Hud } from './gen/ui/hud';
import { drawTitle, drawResults, drawGameOver, drawPause, drawStageCard, setScreenStyle, type Rank } from './gen/ui/screens';
import { GLYPH_STYLES } from './gen/ui/font';
import { AudioEngine } from './gen/audio/engine';
import { bindGameAudio } from './gen/audio/bind';

installErrorCapture();
const params = readParams();
const app = new App({ params, container: document.getElementById('stage')! });
const input = new Input(app.hudCanvas.parentElement);
const game = new Game(params.seed, input);
const view = new View(game);
const hudAdapter = new HudAdapter(game, view);
const hud = new Hud('C');
setScreenStyle(GLYPH_STYLES.C);
const postStack = new PostStack(app.renderer, { clean: params.clean, params: POST_VARIANTS.A });
// count draw calls/triangles for the whole frame (scene + all post passes), not just the last pass
app.renderer.info.autoReset = false;
app.onResize((w, h) => postStack.setSize(w, h, app.pixelRatio));
const audio = new AudioEngine({ muted: params.mute, seed: params.seed });
const audioBind = bindGameAudio(audio, game.events);
game.events.on('stateChanged', ({ to }) => {
  if (to === 'play') { audio.music.setStage(game.stage.id as never); audio.music.start(); }
  if (to === 'title' || to === 'gameover') audio.music.stop(1.5);
  document.body.classList.toggle('playing', to === 'play');
});

const bot = new Bot(game);
let botOn = false;
let hudOn = true;
let frameMsAvg = 16;
let renderTime = 0;
const vanish = new THREE.Vector2();

function setBot(on: boolean) {
  botOn = on;
  input.setScript(on ? bot.frame : null);
}

function drawOverlay(dt: number) {
  const g = app.hudCtx, dpr = app.pixelRatio, w = app.width, h = app.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, app.hudCanvas.width, app.hudCanvas.height);
  if (!hudOn) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const st = game.state;
  if (st === 'title') {
    drawTitle(g, w, h, { time: params.det ? game.stateT + 6 : game.stateT, showMenu: false, selected: 0, backdrop: true, tags: [null, 'SOON', 'SOON'] });
    return;
  }
  if (st === 'launch') {
    drawStageCard(g, w, h, { index: ['cloudgate', 'violetTide', 'wreckfield'].indexOf(game.stage.id) + 1, stage: game.stage.name, subtitle: game.mode === 'caravan' ? 'CARAVAN // 120 S' : game.stage.subtitle, t: game.stateT } as never);
    return;
  }
  if (st === 'play') {
    hud.draw(g, w, h, hudAdapter.update(w, h, dt, renderTime), dt);
    if (game.paused) drawPause(g, w, h, { selected: 0, t: renderTime, stage: game.stage.name });
    return;
  }
  if (st === 'results' && game.results) {
    const r = game.results;
    drawResults(g, w, h, { stage: r.cleared ? game.stage.name : `${game.stage.name} // TARGET ESCAPED`, score: r.score, bestChain: r.bestCombo, shieldLeft: r.shieldLeft, timeS: r.timeS, rank: r.rank as Rank, t: game.stateT, bonus: r.shieldBonus + r.killBonus });
    return;
  }
  if (st === 'gameover') drawGameOver(g, w, h, { t: game.stateT, stage: game.stage.name, score: game.score, progress: game.progress });
}

app.start({
  update: (dt) => {
    game.update(dt);
    view.step(dt);
    audioBind.update(dt);
  },
  render: () => {
    const t0 = performance.now();
    app.renderer.info.reset();
    const dt = 1 / 60;
    renderTime += dt;
    view.update(app.width / app.height);
    const p = game.player;
    const ring = view.rings.intensity();
    postStack.render(view.scene, view.camera, {
      time: renderTime,
      chroma: postTok.chroma.base + (postTok.chroma.ring - postTok.chroma.base) * ring + (postTok.chroma.hit - postTok.chroma.base) * view.chromaPulse,
      speed01: game.state === 'play' ? (p.boost > 0 ? 1 : p.braking ? 0.2 : 0.62) : 0.25,
      vanish: view.vanishing(vanish),
      flash: view.flash,
      danger01: Math.max(0, Math.min(1, (40 - p.shield) / 40)),
    });
    drawOverlay(dt);
    audioBind.setDanger(1 - p.shield / 100);
    frameMsAvg += (performance.now() - t0 - frameMsAvg) * 0.05;
  },
});

if (params.bot) setBot(true);
if (params.skip) game.start({ stage: params.stage ?? 'cloudgate' });

if (params.debug) {
  const api: GameDebugAPI = {
    version: '0.2.0',
    ready: false,
    setSeed(seed) { game.seed = seed >>> 0; game.resetStage(); },
    setTime(t) {
      game.start({ stage: params.stage ?? game.stage.id });
      const wasBot = botOn;
      setBot(true);
      game.invulnerable = true;
      let guard = 0;
      while ((game.state === 'launch' || game.stageTime < t) && game.state !== 'results' && guard++ < 60 * 400) app.step(1, false);
      game.invulnerable = false;
      setBot(wasBot);
      // effects spawned during the unrendered skip never aged: drop them, then let one second of live FX build up
      view.resetFx();
      app.step(150, true); // 2.5 s of live effects (smoke, flashes) before the capture
    },
    step(n) { app.step(n, true); },
    setCamera(name) {
      if ((STORY_CAMERAS as readonly string[]).includes(name)) {
        view.storyCam = name as StoryCamera;
        hudOn = !['hero', 'vista'].includes(name);
      }
    },
    cameras: () => [...STORY_CAMERAS],
    state: () => game.snapshot(),
    capture: () => app.captureDataURL(),
    start(opts) { game.start(opts ?? {}); },
    setBot,
    setInvulnerable(on) { game.invulnerable = on; },
    counts: () => ({ ...(game.events.counts as Record<string, number>), ...game.stats }),
    errors: () => [...(window.__errors ?? [])],
    perf: () => {
      const i = app.renderer.info;
      return { drawCalls: i.render.calls, triangles: i.render.triangles, frameMs: frameMsAvg, programs: i.programs?.length ?? 0, textures: i.memory.textures, geometries: i.memory.geometries, softwareGL: app.softwareGL };
    },
    setPost(clean) { postStack.setClean(clean); },
    setHud(on) { hudOn = on; },
    forceGameOver() { game.forceGameOver(); },
    async readabilityMasks() {
      app.step(0, true);
      const frame = app.glCanvas.toDataURL('image/png');
      const mask = view.readabilityMask(app.glCanvas.width, app.glCanvas.height).toDataURL('image/png');
      return { frame, mask };
    },
  };
  window.__game = api;
  if (params.cam) api.setCamera(params.cam);
  if (params.t !== null) api.setTime(params.t);
  app.step(0, true);
  requestAnimationFrame(() => { api.ready = true; });
}
