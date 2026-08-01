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
import { ROSTER } from './characters/roster.js';
import { drawFace, EXPRESSION_NAMES } from './characters/FaceTexture.js';
import { updateOutlineScale } from './render/Outline.js';

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

// Inverted-hull outlines are pushed in **view space**, so their world-space
// offset is a function of the live projection matrix and the drawing-buffer
// height — neither of which any single scene owns. Registering the rescale as
// a service is the only place it can live and be right for every scene: it
// runs after `Scene.update` (so a pose change landing this frame is already
// applied), reads the camera the engine is actually about to render with, and
// costs one uniform write per outline material. Without it every line falls
// back to Outline.js's 50°/1080p reference and drifts on any other lens.
const drawingBufferSize = new THREE.Vector2();
engine.register('outline-scale', {
  update() {
    const cam = engine.scene?.camera ?? engine.camera;
    // Drawing-buffer height, not CSS height: `getDrawingBufferSize` folds in
    // the pixel ratio, and CSS pixels would halve the line on a retina display.
    updateOutlineScale(null, cam, engine.renderer.getDrawingBufferSize(drawingBufferSize).y);
  },
});

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

/**
 * Which composition the lookdev stage should open on.
 *
 * The capture harness (`tools/screenshot.mjs`, frozen) shoots whatever is on
 * screen the moment `gotoLookdev` resolves, and it drives two different
 * scenarios — `lookdev` and `cast` — through that same argument-less hook. So
 * the entry pose *is* a deliverable, and if it is a constant the two scenarios
 * necessarily ship the same frame under two names. `tools/capture.sh` therefore
 * tags the preview URL with the scenario it is capturing, and the mapping from
 * scenario to composition lives here, next to the pose names it references,
 * rather than in shell.
 *
 * The fallback is the battle frame: it is the composition REFERENCE_TARGET §2
 * specifies and the one a bare `npm run dev` should land on.
 */
const LOOKDEV_ENTRY_POSE = { lookdev: 'wide', cast: 'battle', daycycle: 'horizon' };

function lookdevEntryPose() {
  try {
    const scenario = new URL(window.location.href).searchParams.get('scenario');
    return LOOKDEV_ENTRY_POSE[scenario] ?? 'battle';
  } catch {
    return 'battle';
  }
}

/* ------------------------------------------------------------- face review */

/**
 * Flat, full-screen review of the painted faces.
 *
 * The face is the highest-value asset in the game (ANIME_PIPELINE §1) and
 * judging it through the 3D pipeline conflates a texture problem with a
 * shading, UV or camera problem — a lash bar that is too thin and a lash bar
 * that is being eaten by the fringe's cast shadow look identical on a rendered
 * head. So this draws the *canvas source* directly onto a 2D overlay, with no
 * material, no light and no post chain between the painter and the reviewer.
 *
 * It deliberately does not reuse `buildFaceSheetTexture`: that sheet is laid
 * out characters-down / expressions-across, i.e. 4:6 portrait, and fitting a
 * portrait sheet into a 16:9 frame wastes a third of the width and leaves each
 * face ~165 px tall. Transposing it — characters across, expressions down —
 * gives a 6:4 grid that very nearly fills the capture viewport and lands each
 * face at ~250 px, which is the difference between "there is an eye there" and
 * being able to judge the iris ramp and the highlight placement.
 */
const FACE_REVIEW_ID = 'face-review';
const REVIEW_INK = '#e8eef4';
/** Neutral slate: white lies about a warm skin tone's value, black lies the
 *  other way. Same ground `buildFaceSheetTexture` judges against. */
const REVIEW_GROUND = '#2b3138';
const REVIEW_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function faceReviewCanvas() {
  let canvas = document.getElementById(FACE_REVIEW_ID);
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.id = FACE_REVIEW_ID;
  // Above #ui-root and the boot veil both: this is a debug view and anything
  // drawn over it is a defect in the review, not a feature of it.
  canvas.style.cssText =
    'position:fixed;inset:0;width:100%;height:100%;z-index:9999;display:block';
  document.body.appendChild(canvas);
  return canvas;
}

function hideFaceReview() {
  document.getElementById(FACE_REVIEW_ID)?.remove();
}

function paintFaceReview(index) {
  const canvas = faceReviewCanvas();
  const w = window.innerWidth;
  const h = window.innerHeight;
  // The capture harness pins deviceScaleFactor to 1; on real hardware match the
  // engine's own cap so the lash bar is not resampled twice.
  const dpr = window.__AW_CAPTURE__ ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = REVIEW_GROUND;
  ctx.fillRect(0, 0, w, h);

  const label = (text, x, y, px, align = 'center', alpha = 1) => {
    ctx.font = `600 ${px}px ${REVIEW_FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = REVIEW_INK;
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
  };

  const single = Number.isInteger(index) ? ROSTER[((index % ROSTER.length) + ROSTER.length) % ROSTER.length] : null;

  if (single) {
    // One face, as large as the frame allows. Square, so the layout fractions
    // in FACE_LAYOUT are the ones being judged rather than a stretched copy.
    // The caption gets its band reserved before the face is sized, so the name
    // can never be sliced by the bottom edge.
    const caption = Math.round(h * 0.045);
    const size = Math.min(w, h - caption * 2);
    const y0 = caption;
    ctx.save();
    ctx.translate((w - size) / 2, y0);
    drawFace(ctx, single, size, { expression: 'neutral' });
    ctx.restore();
    label(single.name.toUpperCase(), w / 2, y0 + size + caption / 2, Math.round(caption * 0.5));
    return;
  }

  const cols = ROSTER.length;
  const rows = EXPRESSION_NAMES.length;
  const gutter = Math.round(Math.min(w, h) * 0.008);
  const header = Math.round(h * 0.035);
  // Wide enough for the longest expression name at the row-label size —
  // "DETERMINED" ran off the left edge at a tighter margin.
  const side = Math.round(w * 0.08);
  const cell = Math.min(
    (w - side - gutter * (cols + 1)) / cols,
    (h - header - gutter * (rows + 1)) / rows,
  );
  const gridW = cols * cell + gutter * (cols - 1);
  const originX = side + (w - side - gridW) / 2;
  const originY = header + (h - header - (rows * cell + gutter * (rows - 1))) / 2;

  for (let c = 0; c < cols; c++) {
    label(ROSTER[c].name, originX + c * (cell + gutter) + cell / 2, header / 2, Math.round(cell * 0.075));
  }
  for (let r = 0; r < rows; r++) {
    const y = originY + r * (cell + gutter) + cell / 2;
    label(EXPRESSION_NAMES[r].toUpperCase(), side - gutter * 2, y, Math.round(cell * 0.062), 'right', 0.75);
    for (let c = 0; c < cols; c++) {
      ctx.save();
      ctx.translate(originX + c * (cell + gutter), originY + r * (cell + gutter));
      drawFace(ctx, ROSTER[c], cell, { expression: EXPRESSION_NAMES[r] });
      ctx.restore();
    }
  }
}

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
    hideFaceReview();
    await engine.setScene(new TitleScene(engine));
    await framesSettled();
  },
  async gotoLookdev(pose) {
    hideFaceReview();
    await engine.setScene(new LookdevScene(engine, { pose: pose ?? lookdevEntryPose() }));
    await framesSettled(4);
  },
  async gotoField(zoneId = 'lumen-quay') {
    hideFaceReview();
    await engine.setScene(new FieldScene(engine, { zoneId }));
    await framesSettled(4);
  },
  async gotoBattle(encounterId = 'shorewatch-ambush') {
    hideFaceReview();
    await engine.setScene(new BattleScene(engine, { encounterId }));
    await framesSettled(4);
  },
  /**
   * Debug review of the painted faces, drawn flat and full-screen.
   *
   * With no argument: every character across, every expression down. With an
   * index: that one character's neutral face filling the frame.
   *
   * Async because the harness screenshots the moment this resolves, and a
   * canvas written during a task is not on the glass until the compositor has
   * run — `framesSettled` is the same guarantee every scene hook gives.
   *
   * @param {number} [index] roster index, wrapped; omit for the full sheet.
   */
  async showFaceSheet(index) {
    paintFaceReview(typeof index === 'number' ? Math.trunc(index) : undefined);
    await framesSettled(2);
  },
  /** Dismiss the face review without changing scene. */
  hideFaceSheet() {
    hideFaceReview();
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
