/**
 * CONTRAIL entry: boots the app shell, game simulation, view, placeholder HUD
 * and the window.__game debug API. Owned by the Integrator.
 */
import { readParams } from './core/params';
import { App } from './core/app';
import { Input } from './core/input';
import { Game } from './game/game';
import { View, STORY_CAMERAS, type StoryCamera } from './game/view';
import { Bot } from './game/bot';
import { installErrorCapture, type GameDebugAPI } from './debug/api';
import { palette, hud as hudTok } from './style/tokens';
import { withAlpha } from './style/color';
import { T } from './data/tuning';

installErrorCapture();
const params = readParams();
const app = new App({ params, container: document.getElementById('stage')! });
const input = new Input(app.hudCanvas.parentElement);
const game = new Game(params.seed, input);
const view = new View(game);
const bot = new Bot(game);
let botOn = false;
let hudOn = true;
let frameMsAvg = 16;

function setBot(on: boolean) {
  botOn = on;
  input.setScript(on ? bot.frame : null);
}

/** Placeholder HUD (UI lane replaces it): perimeter text only, open centre. */
function drawHud() {
  const g = app.hudCtx, w = app.hudCanvas.width, h = app.hudCanvas.height;
  g.clearRect(0, 0, w, h);
  if (!hudOn) return;
  const sz = Math.round(h * 0.024);
  g.font = `${sz}px ui-monospace, Menlo, monospace`;
  g.textBaseline = 'middle';
  const st = game.state;
  if (st === 'title') {
    g.fillStyle = palette.hudText; g.textAlign = 'center';
    g.font = `bold ${sz * 4}px ui-monospace, Menlo, monospace`;
    g.fillText('CONTRAIL', w / 2, h * 0.4);
    g.font = `${sz}px ui-monospace, Menlo, monospace`;
    g.fillStyle = palette.hudValue;
    g.fillText('PRESS ENTER', w / 2, h * 0.55);
    return;
  }
  const p = game.player;
  g.strokeStyle = palette.hudLine; g.lineWidth = Math.max(1, h / 540);
  g.strokeRect(w * 0.01, h * 0.01, w * 0.98, h * hudTok.bandTop);
  g.strokeRect(w * 0.01, h * (0.99 - hudTok.bandBottom), w * 0.98, h * hudTok.bandBottom);
  g.textAlign = 'left'; g.fillStyle = palette.hudValue;
  g.fillText(`SCORE ${game.score}`, w * 0.03, h * 0.045);
  g.fillText(`MSL ${p.missiles}  LOCK ${p.lockTargets.length}  ROLL ${p.rollCharges}`, w * 0.03, h * 0.945);
  g.textAlign = 'center';
  g.fillText(`CHAIN ${game.chain}`, w * 0.5, h * 0.945);
  g.fillStyle = palette.shieldRed; g.textAlign = 'right';
  g.fillText(`SHIELD ${Math.round(p.shield)}`, w * 0.97, h * 0.945);
  g.fillStyle = palette.hudText;
  g.fillRect(w * 0.4, h * 0.035, w * 0.2 * game.progress, h * 0.02);
  // reticle
  const r = view.project(T.move.reticleDist, p.rx, p.ry, w, h);
  if (r) { g.beginPath(); g.arc(r.x, r.y, h * 0.04, 0, Math.PI * 2); g.strokeStyle = palette.hudText; g.stroke(); }
  if (game.warning) { g.fillStyle = palette.hazardYellow; g.fillText(game.warning.text, w / 2, h * 0.12); }
  if (st === 'results' && game.results) {
    g.fillStyle = withAlpha(palette.spaceDeep, 0.7); g.fillRect(0, 0, w, h);
    g.fillStyle = palette.hudText; g.textAlign = 'center';
    g.fillText(`STAGE CLEAR  RANK ${game.results.rank}  SCORE ${game.results.score}`, w / 2, h / 2);
  }
  if (st === 'gameover') { g.fillStyle = palette.shieldRed; g.textAlign = 'center'; g.fillText('SIGNAL LOST - PRESS ENTER', w / 2, h / 2); }
}

app.start({
  update: (dt) => game.update(dt),
  render: () => {
    const t0 = performance.now();
    view.update(app.width / app.height);
    app.renderer.render(view.scene, view.camera);
    drawHud();
    frameMsAvg += (performance.now() - t0 - frameMsAvg) * 0.05;
  },
});

if (params.bot) setBot(true);
if (params.skip) game.start({ stage: params.stage ?? 'cloudgate' });

if (params.debug) {
  const api: GameDebugAPI = {
    version: '0.1.0',
    ready: false,
    setSeed(seed) { game.seed = seed >>> 0; game.resetStage(); },
    setTime(t) {
      if (game.state === 'title') game.start({});
      else game.start({ stage: game.stage.id });
      const wasBot = botOn;
      setBot(true);
      game.invulnerable = true;
      let guard = 0;
      while ((game.state === 'launch' || game.stageTime < t) && game.state !== 'results' && guard++ < 60 * 400) app.step(1, false);
      game.invulnerable = false;
      setBot(wasBot);
      app.step(0, true);
    },
    step(n) { app.step(n, true); },
    setCamera(name) { if ((STORY_CAMERAS as readonly string[]).includes(name)) { view.storyCam = name as StoryCamera; hudOn = !['hero', 'vista'].includes(name); } },
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
    setPost() { /* post stack not integrated yet */ },
    setHud(on) { hudOn = on; },
  };
  window.__game = api;
  if (params.cam) api.setCamera(params.cam);
  if (params.t !== null) api.setTime(params.t);
  app.step(0, true);
  requestAnimationFrame(() => { api.ready = true; });
}
