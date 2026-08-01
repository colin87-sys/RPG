/**
 * PostFX — the full screen-space chain.
 *
 * This layer is doing more work than a post stack usually does, because the
 * reference frames (see docs/REFERENCE_TARGET.md) are *made* of screen space:
 * a wide soft bloom veil, heavy atmospheric depth of field, muted backgrounds
 * and a single saturated jewel of magic burning through it all. Turning this
 * chain off should make the game look suddenly dead, and it does.
 *
 * Chain order, fixed by ARCHITECTURE.md:
 *
 *   RenderPass (HDR half-float, depth texture)
 *     -> depth tap
 *     -> SSAO           contact darkening, tinted toward SHADOW_TINT
 *     -> bloom          progressive mip pyramid, soft knee at 1.0
 *     -> depth of field thin-lens CoC + half-res bokeh gather
 *     -> motion blur    camera-velocity reprojection
 *     -> radial blur    limit-break speedlines
 *     -> composite      chromatic aberration, flash, ACES, LUT grade, grain, vignette
 *     -> FXAA
 *
 * The last four *listed* stages share one render target. They are pure
 * per-pixel arithmetic evaluated in exactly the contracted order inside one
 * shader; splitting them would buy three extra full-resolution half-float round
 * trips and change not one pixel. See compositeShader.js for the full argument.
 *
 * Two contract details worth knowing before you touch anything here:
 *
 *  1. **The renderer's tone mapping is switched off by this module.**
 *     `Engine` sets `ACESFilmicToneMapping`, but three applies tone mapping when
 *     rendering *into a render target* too — which would bake the curve in
 *     before bloom ever sees a value above 1.0, making HDR bloom impossible.
 *     PostFX therefore sets `renderer.toneMapping = NoToneMapping` and applies
 *     the identical ACES fit itself in the composite pass.
 *     `renderer.toneMappingExposure` keeps working exactly as the art bible's
 *     time-of-day table specifies — it is read every frame.
 *
 *  2. **PostFX *is* `engine.composer`.** The engine calls
 *     `composer.render()` / `setSize()` / `dispose()`, and `render()` must
 *     re-resolve `engine.scene.camera ?? engine.camera` every frame because
 *     scenes swap and each one may bring its own camera. The `EffectComposer`
 *     itself lives on `this.effectComposer`.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

import { bus } from '../core/EventBus.js';
import { gameState, rng } from '../core/GameState.js';

import { POST_VERT, COPY_FRAG } from './shaders/postCommon.js';
import { AO_FRAG, AO_BLUR_FRAG, AO_COMPOSITE_FRAG } from './shaders/aoShader.js';
import {
  BLOOM_PREFILTER_FRAG,
  BLOOM_DOWNSAMPLE_FRAG,
  BLOOM_UPSAMPLE_FRAG,
  BLOOM_COMPOSITE_FRAG,
} from './shaders/bloomShader.js';
import { DOF_PREPASS_FRAG, DOF_GATHER_FRAG, DOF_COMPOSITE_FRAG } from './shaders/dofShader.js';
import { MOTION_BLUR_FRAG } from './shaders/motionBlurShader.js';
import { RADIAL_BLUR_FRAG } from './shaders/radialBlurShader.js';
import { COMPOSITE_FRAG } from './shaders/compositeShader.js';
import { GRADES, GRADE_SCALARS, lerpGrade, bakeGradeStrip } from './shaders/colorGrades.js';

/** Colour-cube edge. 32 is the film standard and costs 128 KB per grade. */
const LUT_SIZE = 32;

/** 35 mm full-frame sensor height. Fixes the mm→pixel scale for the CoC maths. */
const SENSOR_HEIGHT_MM = 24;

/**
 * Quality ladder. Everything here is switchable at runtime; nothing here
 * reallocates a target except `bloomMips`, which is handled explicitly.
 *
 * 'low' drops the three depth-consuming passes entirely, which also lets the
 * chain skip two full-resolution round trips — on integrated GPUs that is the
 * difference between 60 and 35 fps, and none of the three are load-bearing for
 * readability the way bloom and the grade are.
 */
const QUALITY = {
  low: { ao: false, aoSamples: 6, bloomMips: 4, dof: false, dofTaps: 16, motionBlur: false, mbTaps: 4, radialTaps: 8, maxCoc: 8 },
  medium: { ao: true, aoSamples: 8, bloomMips: 5, dof: true, dofTaps: 20, motionBlur: true, mbTaps: 5, radialTaps: 10, maxCoc: 11 },
  high: { ao: true, aoSamples: 14, bloomMips: 6, dof: true, dofTaps: 28, motionBlur: true, mbTaps: 8, radialTaps: 14, maxCoc: 16 },
  ultra: { ao: true, aoSamples: 24, bloomMips: 7, dof: true, dofTaps: 40, motionBlur: true, mbTaps: 12, radialTaps: 18, maxCoc: 22 },
};

/** HDR intermediate. No depth buffer — only the beauty pass ever writes depth. */
function hdrTarget(w, h, name) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.name = name;
  return rt;
}

/**
 * Every fullscreen material in this file is built here so the three properties
 * that matter are impossible to forget: no depth test (the composer's buffers
 * carry a depth attachment from the beauty pass and a fullscreen quad must not
 * be culled by it), no depth write, and no blending.
 */
function postMaterial(fragmentShader, uniforms, defines) {
  const m = new THREE.ShaderMaterial({
    uniforms,
    defines: defines ?? {},
    vertexShader: POST_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  return m;
}

/**
 * The beauty pass, rendering into a target the composer does not own.
 *
 * The obvious arrangement — attach a `DepthTexture` to the composer's own
 * ping-pong buffers and let `RenderPass` fill one of them — does not work, and
 * the reason is worth recording because it costs a frame of debugging to
 * rediscover. Those two buffers swap roles every time a pass runs, and the
 * swap count varies with which passes `setQuality` has enabled. Sooner or later
 * a depth-consuming pass (motion blur, the DOF composite) ends up *writing* to
 * the very buffer whose depth attachment it is *sampling* — a framebuffer
 * feedback loop, which is undefined behaviour and which Chrome reports as
 * `GL_INVALID_OPERATION: Feedback loop formed between Framebuffer and active
 * Texture` on every affected draw.
 *
 * Rendering the scene into a private target and blitting it into the chain
 * costs one full-resolution half-float copy per frame and makes the depth
 * texture a stable, never-bound-as-output reference that any pass may sample
 * at any point in the chain. The composer's own buffers then need no depth
 * attachment at all, which claws most of the memory back.
 */
class BeautyPass extends RenderPass {
  constructor(target, camera) {
    super(new THREE.Scene(), camera);
    this.needsSwap = false;
    this.target = target;
    this._copyUniforms = { tDiffuse: { value: target.texture } };
    this._copyMat = postMaterial(COPY_FRAG, this._copyUniforms);
    this._quad = new FullScreenQuad(this._copyMat);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    // RenderPass draws into whatever it is handed as `readBuffer`.
    super.render(renderer, writeBuffer, this.target, deltaTime, maskActive);
    this._copyUniforms.tDiffuse.value = this.target.texture;
    renderer.setRenderTarget(readBuffer);
    this._quad.render(renderer);
  }

  setSize(width, height) {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this._copyMat.dispose();
    this._quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// SSAO
// ---------------------------------------------------------------------------

/**
 * Half-resolution depth-only AO with a separable bilateral resolve.
 * See aoShader.js for why this is hand-written rather than `GTAOPass`.
 */
class AOPass extends Pass {
  constructor(settings) {
    super();
    this.needsSwap = true;

    this.aoUniforms = {
      tDepth: { value: null },
      uInvProj: { value: new THREE.Matrix4() },
      uProj: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 0.35 }, // metres — art bible §6
      uBias: { value: 0.025 },
      uNear: { value: 0.1 },
      uFar: { value: 4000 },
      uPower: { value: 1.35 },
    };
    this.blurUniforms = {
      tAO: { value: null },
      uDirection: { value: new THREE.Vector2() },
      // Per metre. 4.0 means a tap 25 cm away in depth keeps ~37% weight, which
      // holds the occlusion on a chibi character's boot without bleeding it
      // onto the ground plane behind them.
      uDepthSigma: { value: 4.0 },
    };
    this.compositeUniforms = {
      tDiffuse: { value: null },
      tAO: { value: null },
      // SHADOW_TINT #2E4A5F normalised so full occlusion lands at ~45% value
      // in a teal hue rather than at neutral grey. The art bible's shadow rule
      // is not optional for screen-space shadowing either.
      uAOColor: { value: new THREE.Color(0.28, 0.44, 0.56) },
      uIntensity: { value: 0.55 },
    };

    this._aoMat = postMaterial(AO_FRAG, this.aoUniforms, { AO_SAMPLES: settings.aoSamples });
    this._blurMat = postMaterial(AO_BLUR_FRAG, this.blurUniforms);
    this._compMat = postMaterial(AO_COMPOSITE_FRAG, this.compositeUniforms);
    this._quad = new FullScreenQuad(this._aoMat);

    // Half-float, not RGBA8: the alpha channel carries view depth in metres for
    // the bilateral resolve, and 8 bits against a 4 km far plane is useless.
    this._rtA = hdrTarget(1, 1, 'PostFX.ao.a');
    this._rtB = hdrTarget(1, 1, 'PostFX.ao.b');
    this._w = 1;
    this._h = 1;
  }

  setQuality(settings) {
    if (this._aoMat.defines.AO_SAMPLES === settings.aoSamples) return;
    this._aoMat.defines.AO_SAMPLES = settings.aoSamples;
    this._aoMat.needsUpdate = true;
  }

  setSize(width, height) {
    // Half res: contact occlusion is a low-frequency signal and the bilateral
    // resolve reads cleaner from fewer, better-converged pixels than from a
    // full-resolution buffer with the same total sample budget.
    this._w = Math.max(1, width >> 1);
    this._h = Math.max(1, height >> 1);
    this._rtA.setSize(this._w, this._h);
    this._rtB.setSize(this._w, this._h);
    this.aoUniforms.uTexel.value.set(1 / this._w, 1 / this._h);
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!this.aoUniforms.tDepth.value) return;

    this._quad.material = this._aoMat;
    renderer.setRenderTarget(this._rtA);
    this._quad.render(renderer);

    this._quad.material = this._blurMat;
    this.blurUniforms.tAO.value = this._rtA.texture;
    this.blurUniforms.uDirection.value.set(1 / this._w, 0);
    renderer.setRenderTarget(this._rtB);
    this._quad.render(renderer);

    this.blurUniforms.tAO.value = this._rtB.texture;
    this.blurUniforms.uDirection.value.set(0, 1 / this._h);
    renderer.setRenderTarget(this._rtA);
    this._quad.render(renderer);

    this.compositeUniforms.tDiffuse.value = readBuffer.texture;
    this.compositeUniforms.tAO.value = this._rtA.texture;
    this._quad.material = this._compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._quad.render(renderer);
  }

  dispose() {
    this._rtA.dispose();
    this._rtB.dispose();
    this._aoMat.dispose();
    this._blurMat.dispose();
    this._compMat.dispose();
    this._quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// Bloom
// ---------------------------------------------------------------------------

/**
 * Progressive downsample/upsample bloom. The mip count is the only thing
 * `setQuality` changes, and because the upsample is an energy-conserving `mix`
 * rather than an add, raising it widens the veil without brightening it — an
 * 'ultra' frame and a 'low' frame are the same exposure.
 */
class BloomPass extends Pass {
  constructor(settings) {
    super();
    this.needsSwap = true;

    this.prefilterUniforms = {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      // Threshold 1.0 exactly: only genuine HDR overspill blooms. If base
      // albedo starts glowing, something upstream is emitting above 1.0 that
      // should not be, and the fix belongs there, not here.
      uThreshold: { value: 1.0 },
      uKnee: { value: 0.6 },
      // Firefly clamp. A single 60.0 spell-core texel would otherwise pump the
      // entire coarsest mip and strobe the whole frame.
      uClamp: { value: 24.0 },
    };
    this.downUniforms = { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } };
    this.upUniforms = {
      tLower: { value: null },
      tHigher: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 0.72 },
    };
    this.compositeUniforms = {
      tDiffuse: { value: null },
      tBloom: { value: null },
      // REFERENCE_TARGET §8.5 mandates leaning harder on bloom than a realism
      // target would; 0.42 against the art bible's 0.35 is that lean, and the
      // wide radius keeps it a veil rather than a halo.
      uStrength: { value: 0.42 },
      uTint: { value: new THREE.Color(0.96, 1.0, 1.06) },
    };

    this._preMat = postMaterial(BLOOM_PREFILTER_FRAG, this.prefilterUniforms);
    this._downMat = postMaterial(BLOOM_DOWNSAMPLE_FRAG, this.downUniforms);
    this._upMat = postMaterial(BLOOM_UPSAMPLE_FRAG, this.upUniforms);
    this._compMat = postMaterial(BLOOM_COMPOSITE_FRAG, this.compositeUniforms);
    this._quad = new FullScreenQuad(this._preMat);

    this._mips = settings.bloomMips;
    this._down = [];
    this._up = [];
    this._w = 1;
    this._h = 1;
  }

  setQuality(settings) {
    if (settings.bloomMips === this._mips) return;
    this._mips = settings.bloomMips;
    this._freeChains();
    this._buildChains();
  }

  _freeChains() {
    for (const rt of this._down) rt.dispose();
    for (const rt of this._up) rt.dispose();
    this._down.length = 0;
    this._up.length = 0;
  }

  _buildChains() {
    // Stop subdividing at 4 px: below that the tent filter degenerates and the
    // mip contributes nothing but a uniform tint.
    let w = Math.max(1, this._w >> 1);
    let h = Math.max(1, this._h >> 1);
    for (let i = 0; i < this._mips; i++) {
      if (i > 0 && (w < 4 || h < 4)) break;
      this._down.push(hdrTarget(w, h, `PostFX.bloom.down${i}`));
      if (i > 0) this._up.push(hdrTarget(w, h, `PostFX.bloom.up${i - 1}`));
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
    }
  }

  setSize(width, height) {
    this._w = Math.max(1, width);
    this._h = Math.max(1, height);
    this._freeChains();
    this._buildChains();
    this.prefilterUniforms.uTexel.value.set(1 / this._w, 1 / this._h);
  }

  render(renderer, writeBuffer, readBuffer) {
    const down = this._down;
    if (down.length === 0) return;

    this.prefilterUniforms.tDiffuse.value = readBuffer.texture;
    this._quad.material = this._preMat;
    renderer.setRenderTarget(down[0]);
    this._quad.render(renderer);

    this._quad.material = this._downMat;
    for (let i = 1; i < down.length; i++) {
      const src = down[i - 1];
      this.downUniforms.tDiffuse.value = src.texture;
      this.downUniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(down[i]);
      this._quad.render(renderer);
    }

    // Walk back up. `up[i]` holds the accumulated veil at mip i+1's resolution
    // blended into mip i; the last one written is up[0], at half resolution.
    this._quad.material = this._upMat;
    for (let i = down.length - 2; i >= 0; i--) {
      const lower = i === down.length - 2 ? down[i + 1] : this._up[i + 1];
      this.upUniforms.tLower.value = lower.texture;
      this.upUniforms.tHigher.value = down[i].texture;
      this.upUniforms.uTexel.value.set(1 / lower.width, 1 / lower.height);
      renderer.setRenderTarget(this._up[i]);
      this._quad.render(renderer);
    }

    this.compositeUniforms.tDiffuse.value = readBuffer.texture;
    this.compositeUniforms.tBloom.value = (this._up[0] ?? down[0]).texture;
    this._quad.material = this._compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._quad.render(renderer);
  }

  dispose() {
    this._freeChains();
    this._preMat.dispose();
    this._downMat.dispose();
    this._upMat.dispose();
    this._compMat.dispose();
    this._quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// Depth of field
// ---------------------------------------------------------------------------

/** Thin-lens CoC, half-res spiral gather, CoC-weighted composite. */
class DofPass extends Pass {
  constructor(settings) {
    super();
    this.needsSwap = true;

    // Shared between the prepass and the composite so the two can never
    // disagree about where the focal plane is.
    this.coc = {
      uNear: { value: 0.1 },
      uFar: { value: 4000 },
      uFocusDistance: { value: 9 },
      uApertureDiam: { value: 6.7 },
      uFocalLength: { value: 27 },
      uMmToPixels: { value: 180 },
      uMaxCoc: { value: settings.maxCoc },
      // Physical optics makes near blur grow without bound and far blur
      // saturate at A*f/S — the opposite of what this art direction wants,
      // which is a crisp midground and a genuinely soft horizon. These two
      // scalars break that symmetry; they are the one non-physical knob in
      // the pass and they are why it looks like the reference.
      uNearStrength: { value: 0.8 },
      uFarStrength: { value: 2.5 },
    };

    this.prepassUniforms = Object.assign(
      { tDiffuse: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() } },
      this.coc,
    );
    this.gatherUniforms = {
      tHalf: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uMaxCoc: this.coc.uMaxCoc,
    };
    this.compositeUniforms = Object.assign(
      { tDiffuse: { value: null }, tDepth: { value: null }, tBlur: { value: null } },
      this.coc,
    );

    this._preMat = postMaterial(DOF_PREPASS_FRAG, this.prepassUniforms);
    this._gatherMat = postMaterial(DOF_GATHER_FRAG, this.gatherUniforms, { DOF_TAPS: settings.dofTaps });
    this._compMat = postMaterial(DOF_COMPOSITE_FRAG, this.compositeUniforms);
    this._quad = new FullScreenQuad(this._preMat);

    this._rtA = hdrTarget(1, 1, 'PostFX.dof.a');
    this._rtB = hdrTarget(1, 1, 'PostFX.dof.b');
  }

  setQuality(settings) {
    this.coc.uMaxCoc.value = settings.maxCoc;
    if (this._gatherMat.defines.DOF_TAPS !== settings.dofTaps) {
      this._gatherMat.defines.DOF_TAPS = settings.dofTaps;
      this._gatherMat.needsUpdate = true;
    }
  }

  setSize(width, height) {
    const hw = Math.max(1, width >> 1);
    const hh = Math.max(1, height >> 1);
    this._rtA.setSize(hw, hh);
    this._rtB.setSize(hw, hh);
    this.prepassUniforms.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.gatherUniforms.uTexel.value.set(1 / hw, 1 / hh);
    // mm -> px conversion depends on the vertical resolution of the frame the
    // CoC will actually be measured in.
    this._pixelsPerMm = height / SENSOR_HEIGHT_MM;
  }

  /** Called once a frame by PostFX with the live camera. */
  syncCamera(camera, focusDistance, fNumber, bokehScale) {
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const focal = (SENSOR_HEIGHT_MM * 0.5) / Math.tan(fovRad * 0.5);
    this.coc.uFocalLength.value = focal;
    this.coc.uApertureDiam.value = focal / Math.max(0.5, fNumber);
    this.coc.uFocusDistance.value = Math.max(camera.near * 2, focusDistance);
    this.coc.uMmToPixels.value = (this._pixelsPerMm ?? 45) * bokehScale;
    this.coc.uNear.value = camera.near;
    this.coc.uFar.value = camera.far;
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!this.prepassUniforms.tDepth.value) return;

    this.prepassUniforms.tDiffuse.value = readBuffer.texture;
    this._quad.material = this._preMat;
    renderer.setRenderTarget(this._rtA);
    this._quad.render(renderer);

    this.gatherUniforms.tHalf.value = this._rtA.texture;
    this._quad.material = this._gatherMat;
    renderer.setRenderTarget(this._rtB);
    this._quad.render(renderer);

    this.compositeUniforms.tDiffuse.value = readBuffer.texture;
    this.compositeUniforms.tBlur.value = this._rtB.texture;
    this._quad.material = this._compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._quad.render(renderer);
  }

  dispose() {
    this._rtA.dispose();
    this._rtB.dispose();
    this._preMat.dispose();
    this._gatherMat.dispose();
    this._compMat.dispose();
    this._quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// Trauma shake noise
// ---------------------------------------------------------------------------

/** Deterministic 1-D hash; the shake must reproduce for the capture harness. */
function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}

/**
 * Smooth value noise in [-1,1]. Perlin-style smoothstep interpolation matters
 * here: sampling white noise per frame gives a buzz that reads as a dropped
 * frame, whereas a continuous curve reads as a physical camera being hit.
 */
function vnoise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash1(i);
  const b = hash1(i + 1);
  const u = f * f * (3 - 2 * f);
  return (a + (b - a) * u) * 2 - 1;
}

// ---------------------------------------------------------------------------
// PostFX
// ---------------------------------------------------------------------------

export class PostFX {
  constructor(engine) {
    this.engine = engine;
    this.renderer = engine.renderer;

    this.quality = gameState.state.settings.quality ?? 'high';
    const settings = QUALITY[this.quality] ?? QUALITY.high;
    this._settings = settings;

    // See the class docblock: HDR bloom is impossible if the renderer tone maps
    // on the way into the half-float buffer.
    this._rendererToneMapping = this.renderer.toneMapping;
    this.renderer.toneMapping = THREE.NoToneMapping;

    const dpr = this.renderer.getPixelRatio();
    const bw = Math.max(1, Math.round((engine.width || 1280) * dpr));
    const bh = Math.max(1, Math.round((engine.height || 720) * dpr));

    // HDR is mandatory: bloom has to read values above 1.0, so every buffer in
    // the chain is half-float. Half-float rather than full float because the
    // chain is bandwidth-bound and 11 bits of mantissa is far more than an
    // 8-bit display path can resolve after tone mapping.
    this.beauty = new THREE.WebGLRenderTarget(bw, bh, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.beauty.texture.name = 'PostFX.beauty';
    // A real depth texture, not a renderbuffer: AO, DOF and motion blur all
    // sample it, and it is the only reason this module needs no second
    // geometry pass for any of the three.
    this.beauty.depthTexture = new THREE.DepthTexture(bw, bh);

    // The composer's own buffers carry no depth attachment — nothing after the
    // beauty pass depth-tests, and keeping them depth-free is what makes the
    // feedback loop described on BeautyPass structurally impossible.
    const chain = new THREE.WebGLRenderTarget(bw, bh, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    chain.texture.name = 'PostFX.chain';

    this.effectComposer = new EffectComposer(this.renderer, chain);
    this.effectComposer.renderToScreen = true;

    // --- passes ----------------------------------------------------------
    this.renderPass = new BeautyPass(this.beauty, engine.camera);
    this.aoPass = new AOPass(settings);
    this.bloomPass = new BloomPass(settings);
    this.dofPass = new DofPass(settings);

    this.motionBlurUniforms = {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uScale: { value: 0.5 }, // shutter, art bible §6
      uMaxVelocity: { value: 0.045 },
    };
    this.motionBlurPass = new ShaderPass(
      postMaterial(MOTION_BLUR_FRAG, this.motionBlurUniforms, { MB_TAPS: settings.mbTaps }),
    );

    this.radialUniforms = {
      tDiffuse: { value: null },
      uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uStrength: { value: 0 },
    };
    this.radialPass = new ShaderPass(
      postMaterial(RADIAL_BLUR_FRAG, this.radialUniforms, { RADIAL_TAPS: settings.radialTaps }),
    );
    this.radialPass.enabled = false;

    this._lutA = this._makeLutTexture();
    this._lutB = this._makeLutTexture();
    this.compositeUniforms = {
      tDiffuse: { value: null },
      uResolution: { value: new THREE.Vector2(bw, bh) },
      uAberration: { value: 1.2 },
      uFlash: { value: new THREE.Vector3(0, 0, 0) },
      uExposure: { value: 1 },
      uLutA: { value: this._lutA },
      uLutB: { value: this._lutB },
      uLutMix: { value: 1 },
      uLutSize: { value: LUT_SIZE },
      uGrain: { value: 0.035 },
      uGrainSeed: { value: 0 },
      uVignette: { value: 0.28 },
      uVignetteOffset: { value: 1.1 },
      // Literal display values for #0A1218: the vignette is applied *after*
      // sRGB encoding, so converting this to the linear working space (which
      // `new THREE.Color(hex)` would do under colour management) would make it
      // far too dark.
      uVignetteColor: { value: new THREE.Vector3(0.039, 0.071, 0.094) },
    };
    this.compositePass = new ShaderPass(postMaterial(COMPOSITE_FRAG, this.compositeUniforms));

    this.fxaaPass = new FXAAPass();
    this.fxaaPass.material.depthTest = false;
    this.fxaaPass.material.depthWrite = false;
    this.fxaaPass.material.blending = THREE.NoBlending;

    const c = this.effectComposer;
    c.addPass(this.renderPass);
    c.addPass(this.aoPass);
    c.addPass(this.bloomPass);
    c.addPass(this.dofPass);
    c.addPass(this.motionBlurPass);
    c.addPass(this.radialPass);
    c.addPass(this.compositePass);
    c.addPass(this.fxaaPass);

    /** Named handles so other systems (and the debug surface) can poke a
     *  single stage without knowing the chain layout. */
    this.passes = {
      render: this.renderPass,
      ao: this.aoPass,
      bloom: this.bloomPass,
      dof: this.dofPass,
      motionBlur: this.motionBlurPass,
      radial: this.radialPass,
      composite: this.compositePass,
      fxaa: this.fxaaPass,
    };

    // --- temporal state ---------------------------------------------------
    this._gradeFrom = GRADES.neutral;
    this._gradeTo = GRADES.neutral;
    this._gradeName = 'neutral';
    this._gradeMix = 1;
    this._gradeDuration = 1;
    this._bakeLut(this._lutA, GRADES.neutral);
    this._bakeLut(this._lutB, GRADES.neutral);

    this._trauma = 0;
    this._traumaDecay = 1;
    this._shakeClock = 0;
    this._shakeSeed = [rng.range(0, 1000), rng.range(0, 1000), rng.range(0, 1000)];

    this._flashColor = new THREE.Color(1, 1, 1);
    this._flashTime = 0;
    this._flashDuration = 0;
    this._flashIntensity = 0;

    this._aberrationSpike = 0;
    this._aberrationRate = 1;

    this._radialTarget = 0;
    this._radialHold = 0;
    this._gradeExposure = 1;

    /** Focus tracking. Scenes may set `scene.focusDistance`, or call
     *  `postfx.focusOn(objectOrVector)`; otherwise the default suits both the
     *  fixed battle stage and the field camera. */
    this._focusTarget = null;
    this._focusDistance = 9;
    this._focusGoal = 9;
    this._fNumber = 4.0;
    this._bokehScale = 4.0;

    this._prevViewProj = new THREE.Matrix4();
    this._prevCamPos = new THREE.Vector3();
    this._hasHistory = false;
    this._frame = 0;

    this._camPos = new THREE.Vector3();
    this._camQuat = new THREE.Quaternion();
    this._shakeOffset = new THREE.Vector3();
    this._tmpVec = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
    this._tmpAxis = new THREE.Vector3();
    this._viewProj = new THREE.Matrix4();
    this._dpr = this.renderer.getPixelRatio();

    this._engineDt = 0;
    this._haveEngineDt = false;
    this._lastRenderTime = 0;

    // A camera cut must not smear: reprojection across a teleport produces a
    // full-screen streak that reads as a rendering bug.
    this._unsubs = [
      bus.on('scene:changed', () => {
        this._hasHistory = false;
      }),
      // Nothing else owns chromatic aberration, so impact punch is wired here.
      // Deliberately does *not* trigger shake — the battle and VFX layers own
      // that, and doubling it would make every crit feel like an earthquake.
      bus.on('battle:damage', (p) => {
        if (p?.crit) this.punch(2.6, 0.25);
      }),
      bus.on('settings:changed', ({ key }) => {
        if (key === 'motionBlur' || key === 'screenShake') this._applyQuality();
      }),
    ];

    this._bindDepth(this.beauty.depthTexture);
    this.setSize(engine.width || 1280, engine.height || 720);
    this._applyQuality();

    engine.composer = this;
  }

  // -------------------------------------------------------------------------
  // Grades
  // -------------------------------------------------------------------------

  _makeLutTexture() {
    const data = new Uint8Array(LUT_SIZE * LUT_SIZE * LUT_SIZE * 4);
    const tex = new THREE.DataTexture(data, LUT_SIZE * LUT_SIZE, LUT_SIZE, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    // NoColorSpace: the cube stores already-encoded display values, so any
    // implicit sRGB decode on sample would double-transform the grade.
    tex.colorSpace = THREE.NoColorSpace;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
  }

  _bakeLut(texture, params) {
    bakeGradeStrip(params, LUT_SIZE, texture.image.data);
    texture.needsUpdate = true;
  }

  /** Eased fade parameter. Linear cross-fades between two grades read as a
   *  visible ramp start and stop; smoothstep hides both ends. */
  _gradeT() {
    const t = Math.min(1, Math.max(0, this._gradeMix));
    return t * t * (3 - 2 * t);
  }

  /**
   * Cross-fade to a named grade over `t` seconds.
   *
   * Interrupting a fade is the common case (a boss dies mid-transition to
   * 'boss'), so the currently *visible* grade is first frozen by baking the
   * interpolated parameter set into slot A. That keeps the fade continuous —
   * there is never a frame where the grade jumps back to where the last fade
   * started.
   */
  setGrade(name, t = 0.6) {
    const target = GRADES[name];
    if (!target) {
      console.warn(`[PostFX] unknown grade "${name}", staying on "${this._gradeName}"`);
      return;
    }
    const eased = this._gradeT();
    const current = eased >= 1 ? this._gradeTo : lerpGrade(this._gradeFrom, this._gradeTo, eased);
    this._gradeFrom = current;
    this._gradeTo = target;
    this._gradeName = name;
    this._gradeMix = 0;
    this._gradeDuration = Math.max(1e-3, t);
    this._bakeLut(this._lutA, current);
    this._bakeLut(this._lutB, target);
  }

  get grade() {
    return this._gradeName;
  }

  // -------------------------------------------------------------------------
  // Impulses
  // -------------------------------------------------------------------------

  /**
   * Trauma-based camera shake. `intensity` accumulates into a 0..1 trauma
   * value and the actual displacement is trauma², so small hits are barely
   * felt and a full-trauma esper landing is violent — the squared response is
   * what makes a single scalar cover that whole range convincingly.
   */
  shake(intensity = 0.5, seconds = 0.4) {
    if (!gameState.state.settings.screenShake) return;
    this._trauma = Math.min(1, this._trauma + Math.max(0, intensity));
    this._traumaDecay = 1 / Math.max(0.05, seconds);
    // Re-seed so two shakes in quick succession do not replay the same curve.
    this._shakeSeed[0] = rng.range(0, 1000);
    this._shakeSeed[1] = rng.range(0, 1000);
    this._shakeSeed[2] = rng.range(0, 1000);
  }

  /**
   * Additive full-screen flash, applied before the tone map so it rolls off on
   * the filmic shoulder instead of clipping to a flat white card.
   */
  flash(color = 0xffffff, seconds = 0.22, intensity = 1.6) {
    // `Color.set` already lands in the linear working space under three's
    // colour management, which is the space the flash is added in. Converting
    // again here would darken every flash by roughly a stop and a half.
    this._flashColor.set(color);
    this._flashDuration = Math.max(1e-3, seconds);
    this._flashTime = 0;
    this._flashIntensity = Math.max(0, intensity);
  }

  /** Chromatic aberration spike, in pixels of corner separation. */
  punch(pixels = 3, seconds = 0.25) {
    this._aberrationSpike = Math.max(this._aberrationSpike, pixels);
    this._aberrationRate = this._aberrationSpike / Math.max(0.05, seconds);
  }

  /** Limit-break speedlines. 0 at rest; the pass switches itself off there. */
  setRadialBlur(amount = 0) {
    this._radialTarget = Math.min(1, Math.max(0, amount));
  }

  /** Convenience: spike the speedlines and let them fall back to zero. */
  radialPulse(amount = 0.35, seconds = 0.4) {
    this.setRadialBlur(amount);
    this._radialHold = seconds;
  }

  /**
   * Move the speedline focal point, in normalised screen space. Anchoring it
   * on the character triggering the limit break rather than on frame centre is
   * what makes the effect read as *their* adrenaline.
   */
  setRadialCenter(x = 0.5, y = 0.5) {
    this.radialUniforms.uCenter.value.set(x, y);
  }

  // -------------------------------------------------------------------------
  // Depth of field
  // -------------------------------------------------------------------------

  /**
   * @param {number} focusDistance metres from the camera to the focal plane
   * @param {number} aperture      f-number; smaller = shallower
   * @param {number} [bokehScale]  artistic multiplier on the physical CoC
   */
  setDof(focusDistance = 9, aperture = 4.0, bokehScale = this._bokehScale) {
    this._focusTarget = null;
    this._focusGoal = Math.max(0.2, focusDistance);
    this._fNumber = Math.max(0.7, aperture);
    this._bokehScale = Math.max(0, bokehScale);
  }

  /**
   * Track an object (or a fixed point) as the focal plane. Preferred over
   * `setDof` for dialogue and closeups: the focus then follows the subject
   * through the shot instead of drifting off it.
   * @param {THREE.Object3D|THREE.Vector3|null} target
   */
  focusOn(target) {
    this._focusTarget = target ?? null;
  }

  // -------------------------------------------------------------------------
  // Quality
  // -------------------------------------------------------------------------

  setQuality(level) {
    const settings = QUALITY[level];
    if (!settings) {
      console.warn(`[PostFX] unknown quality "${level}"`);
      return;
    }
    this.quality = level;
    this._settings = settings;
    this._applyQuality();
  }

  _applyQuality() {
    const s = this._settings;
    this.aoPass.enabled = s.ao;
    this.aoPass.setQuality(s);
    this.bloomPass.setQuality(s);
    this.dofPass.enabled = s.dof;
    this.dofPass.setQuality(s);

    const mb = this.motionBlurPass.material;
    if (mb.defines.MB_TAPS !== s.mbTaps) {
      mb.defines.MB_TAPS = s.mbTaps;
      mb.needsUpdate = true;
    }
    const rad = this.radialPass.material;
    if (rad.defines.RADIAL_TAPS !== s.radialTaps) {
      rad.defines.RADIAL_TAPS = s.radialTaps;
      rad.needsUpdate = true;
    }
    // Motion blur also honours the player's own setting; quality only gates it.
    this.motionBlurPass.enabled = s.motionBlur && gameState.state.settings.motionBlur !== false;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /** Engine service hook. Only accumulates dt; all work happens in render(). */
  update(dt) {
    this._engineDt += dt;
    this._haveEngineDt = true;
  }

  setSize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const dpr = this.renderer.getPixelRatio();
    if (dpr !== this._dpr) {
      this._dpr = dpr;
      this.effectComposer.setPixelRatio(dpr);
    }
    // EffectComposer.setSize takes logical pixels and multiplies by its own
    // pixel ratio, then forwards the device-pixel size to every pass — which
    // is exactly the resolution our half-res chains need to halve.
    this.effectComposer.setSize(w, h);
    this.compositeUniforms.uResolution.value.set(Math.round(w * dpr), Math.round(h * dpr));
    // A resize invalidates the reprojection history: the previous frame was a
    // different aspect ratio and would smear.
    this._hasHistory = false;
  }

  /** One stable depth reference for every consumer. `RenderTarget.setSize`
   *  keeps the same `DepthTexture` instance and lets the renderer reallocate
   *  its storage, so this survives resizes and never needs re-binding. */
  _bindDepth(depthTexture) {
    this.aoPass.aoUniforms.tDepth.value = depthTexture;
    this.dofPass.prepassUniforms.tDepth.value = depthTexture;
    this.dofPass.compositeUniforms.tDepth.value = depthTexture;
    this.motionBlurUniforms.tDepth.value = depthTexture;
  }

  /** Advance every time-driven parameter. Split out of render() so the
   *  ordering (decay, then upload) is obvious and testable. */
  _advance(dt) {
    // Grade cross-fade.
    if (this._gradeMix < 1) {
      this._gradeMix = Math.min(1, this._gradeMix + dt / this._gradeDuration);
    }
    const t = this._gradeT();
    this.compositeUniforms.uLutMix.value = t;

    const scalars = {};
    for (const key of GRADE_SCALARS) {
      scalars[key] = this._gradeFrom[key] + (this._gradeTo[key] - this._gradeFrom[key]) * t;
    }

    // Shake trauma.
    this._shakeClock += dt;
    if (this._trauma > 0) {
      this._trauma = Math.max(0, this._trauma - this._traumaDecay * dt);
    }

    // Flash decay: quadratic, so the frame is brightest on the first rendered
    // frame after the hit and gone before the player consciously registers it.
    let flash = 0;
    if (this._flashTime < this._flashDuration) {
      this._flashTime += dt;
      const k = Math.max(0, 1 - this._flashTime / this._flashDuration);
      flash = k * k * this._flashIntensity;
    }
    this.compositeUniforms.uFlash.value.set(
      this._flashColor.r * flash,
      this._flashColor.g * flash,
      this._flashColor.b * flash,
    );

    // Aberration: grade baseline plus a linearly decaying impact spike.
    if (this._aberrationSpike > 0) {
      this._aberrationSpike = Math.max(0, this._aberrationSpike - this._aberrationRate * dt);
    }
    this.compositeUniforms.uAberration.value = scalars.aberration + this._aberrationSpike;
    this.compositeUniforms.uGrain.value = scalars.grain;
    this.compositeUniforms.uVignette.value = scalars.vignette;
    this._gradeExposure = scalars.exposure;

    // Radial blur eases in and out — a hard switch reads as a dropped frame.
    if (this._radialHold > 0) {
      this._radialHold -= dt;
      if (this._radialHold <= 0) {
        this._radialHold = 0;
        this._radialTarget = 0;
      }
    }
    const current = this.radialUniforms.uStrength.value;
    const k = 1 - Math.exp(-dt / 0.08);
    const next = current + (this._radialTarget - current) * k;
    this.radialUniforms.uStrength.value = next;
    this.radialPass.enabled = next > 0.002;

    // Focus follow. Exponential, ~0.25 s time constant: fast enough to keep up
    // with a cut-in, slow enough that it never snaps (art bible §7.8).
    const focusK = 1 - Math.exp(-dt / 0.25);
    this._focusDistance += (this._focusGoal - this._focusDistance) * focusK;
  }

  /** Resolve where the focal plane should be for this frame. */
  _resolveFocus(camera) {
    const scene = this.engine.scene;
    if (this._focusTarget) {
      const p = this._focusTarget.isVector3
        ? this._focusTarget
        : this._focusTarget.getWorldPosition(this._tmpVec);
      this._focusGoal = Math.max(0.2, camera.position.distanceTo(p));
    } else if (typeof scene?.focusDistance === 'number') {
      this._focusGoal = Math.max(0.2, scene.focusDistance);
    }
  }

  /**
   * Present one frame.
   *
   * `engine.scene.camera ?? engine.camera` is re-resolved every call, not
   * cached: scenes swap at runtime and each may bring its own camera, and a
   * stale reference here renders the previous scene's viewpoint into the
   * current scene's buffers.
   */
  render() {
    const scene = this.engine.scene;
    if (!scene) return;
    const camera = scene.camera ?? this.engine.camera;
    if (!camera) return;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const real = this._lastRenderTime ? Math.min(0.25, now - this._lastRenderTime) : 1 / 60;
    this._lastRenderTime = now;
    const dt = this._haveEngineDt ? this._engineDt : real;
    this._engineDt = 0;
    this._haveEngineDt = false;

    this._frame++;
    this._advance(dt);
    this._resolveFocus(camera);

    // Engine sets ACES on the renderer; we own tone mapping so bloom can read
    // HDR. Re-assert cheaply in case a scene or a material editor changed it.
    if (this.renderer.toneMapping !== THREE.NoToneMapping) {
      this.renderer.toneMapping = THREE.NoToneMapping;
    }

    this.renderPass.scene = scene.scene;
    this.renderPass.camera = camera;

    // AO's range check and the whole thin-lens CoC assume a perspective
    // frustum. A scene that mounts an orthographic camera (a map screen, a
    // shadow-debug view) gets the rest of the chain and skips these two rather
    // than rendering a wrong result.
    const perspective = camera.isPerspectiveCamera === true;
    this.aoPass.enabled = this._settings.ao && perspective;
    this.dofPass.enabled = this._settings.dof && perspective;

    // --- camera shake ----------------------------------------------------
    this._camPos.copy(camera.position);
    this._camQuat.copy(camera.quaternion);
    const shakeActive = this._trauma > 0.0005 && gameState.state.settings.screenShake;
    if (shakeActive) {
      const s = this._trauma * this._trauma;
      const f = this._shakeClock * 24;
      // Translate in *view* space so the shake always reads as the camera body
      // being struck, whatever direction it is facing.
      this._shakeOffset.set(
        vnoise(f + this._shakeSeed[0]) * s * 0.22,
        vnoise(f * 1.13 + this._shakeSeed[1]) * s * 0.22,
        vnoise(f * 0.71 + this._shakeSeed[2]) * s * 0.06,
      );
      this._shakeOffset.applyQuaternion(this._camQuat);
      camera.position.add(this._shakeOffset);
      const roll = vnoise(f * 0.87 + this._shakeSeed[2] + 41) * s * 0.035;
      this._tmpAxis.set(0, 0, 1).applyQuaternion(this._camQuat);
      this._tmpQuat.setFromAxisAngle(this._tmpAxis, roll);
      camera.quaternion.premultiply(this._tmpQuat);
      camera.updateMatrixWorld(true);
    } else {
      camera.updateMatrixWorld(true);
    }

    // --- per-frame uniforms ----------------------------------------------
    this.aoPass.aoUniforms.uProj.value.copy(camera.projectionMatrix);
    this.aoPass.aoUniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    this.aoPass.aoUniforms.uNear.value = camera.near;
    this.aoPass.aoUniforms.uFar.value = camera.far;

    if (perspective) {
      this.dofPass.syncCamera(camera, this._focusDistance, this._fNumber, this._bokehScale);
    }

    this._viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.motionBlurUniforms.uInvViewProj.value.copy(this._viewProj).invert();
    if (this._hasHistory) {
      this.motionBlurUniforms.uPrevViewProj.value.copy(this._prevViewProj);
      // Normalise the shutter to a 60 Hz reference so a hitch does not produce
      // a single hugely smeared frame, and cut it entirely on a teleport.
      const jump = this._prevCamPos.distanceTo(camera.position);
      const rate = Math.min(2, dt > 1e-5 ? 1 / (dt * 60) : 1);
      this.motionBlurUniforms.uScale.value = jump > 1.5 ? 0 : 0.5 * rate;
    } else {
      this.motionBlurUniforms.uPrevViewProj.value.copy(this._viewProj);
      this.motionBlurUniforms.uScale.value = 0;
    }

    this.compositeUniforms.uExposure.value =
      this.renderer.toneMappingExposure * (this._gradeExposure ?? 1);
    // Quantised per frame index rather than per wall clock, so a capture at a
    // fixed frame count reproduces the same grain field exactly.
    this.compositeUniforms.uGrainSeed.value = (this._frame % 512) * 17.13;

    this.effectComposer.render(dt);

    // --- history + restore ------------------------------------------------
    this._prevViewProj.copy(this._viewProj);
    this._prevCamPos.copy(camera.position);
    this._hasHistory = true;

    if (shakeActive) {
      camera.position.copy(this._camPos);
      camera.quaternion.copy(this._camQuat);
      camera.updateMatrixWorld(true);
    }

    this.renderer.setRenderTarget(null);
  }

  dispose() {
    for (const off of this._unsubs) off?.();
    this._unsubs.length = 0;

    for (const pass of this.effectComposer.passes) pass.dispose?.();
    this.effectComposer.passes.length = 0;
    this.effectComposer.dispose();

    this._lutA.dispose();
    this._lutB.dispose();

    // Hand the renderer back the way we found it, so a torn-down engine that
    // renders without a composer still tone maps.
    this.renderer.toneMapping = this._rendererToneMapping;
    if (this.engine.composer === this) this.engine.composer = null;
  }
}
