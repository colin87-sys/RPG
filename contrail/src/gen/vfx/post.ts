/**
 * PostStack (VFX lane A): the analogue-video post chain.
 *
 *   scene -> MSAA HalfFloat target (fallback: sRGB UnsignedByte)
 *   -> bloom: prefilter 1/2 -> down 1/4 -> down 1/8 -> up += 1/4 -> up += 1/2  (dual filter)
 *   -> composite (full res): radial chromatic aberration + analogue softness + bloom,
 *      filmic shoulder / ACES tone map, lift-gamma-gain grade, vignette, danger tint,
 *      radial speed streaks, white flash, scanlines, film grain.
 *
 * Passes per frame: full stack = 6 full-screen quad passes (5 of them at <= 1/2 res);
 * clean mode = 1 pass (tone map only). The HUD canvas is never post-processed.
 * Deterministic: grain and streaks animate only from PostFrame.time.
 */
import * as THREE from 'three';
import { palette, post as postTok, vfx } from '../../style/tokens';
import { hexToRgb } from '../../style/color';
import { GLSL_SPEED_STREAKS, STREAK_VARIANTS, type StreakParams } from './streaks';

export interface PostFrame {
  time: number;
  /** chromatic aberration at the frame edge, in UV (frame-width) units; base post.chroma.base = 0.0015 */
  chroma: number;
  speed01: number;
  /** NDC of the vanishing point (speed streak origin) */
  vanish: THREE.Vector2;
  /** 0..1 white flash */
  flash: number;
  danger01: number;
}

export interface PostParams {
  exposure: number;
  /** linear value where the filmic shoulder starts; below it the image is untouched (token colours survive) */
  toneShoulder: number;
  /** 0 = shoulder-only filmic curve, 1 = ACES (Hill fit) */
  acesMix: number;
  bloomThreshold: number;
  bloomKnee: number;
  bloomStrength: number;
  /** weight of the wider bloom mips (token post.bloom.radius) */
  bloomRadius: number;
  /** multiplies PostFrame.chroma */
  chromaScale: number;
  /** edge weighting exponent of the radial split (2 = quadratic toward the corners) */
  chromaFalloff: number;
  scanlineLines: number;
  scanlineOpacity: number;
  grain: number;
  /** grain cell size in px at 1080p */
  grainSize: number;
  vignette: number;
  /** 0..1 amount of the lift/gain/saturation grade */
  gradeAmount: number;
  saturation: number;
  gamma: number;
  /** horizontal analogue softness in px */
  softness: number;
  /** max red edge tint at danger01 = 1 */
  dangerTint: number;
  /** max white mix at flash = 1 */
  flashMax: number;
  streaks: StreakParams;
}

/** Per-effect switches (the post board uses them to build the on/off grid). */
export interface PostToggles {
  bloom: boolean;
  chroma: boolean;
  softness: boolean;
  scanlines: boolean;
  grain: boolean;
  vignette: boolean;
  grade: boolean;
  streaks: boolean;
}

const tokenPost: PostParams = {
  exposure: postTok.exposure,
  toneShoulder: 0.8,
  acesMix: 0,
  bloomThreshold: postTok.bloom.threshold,
  bloomKnee: 0.12,
  bloomStrength: postTok.bloom.strength,
  bloomRadius: postTok.bloom.radius,
  chromaScale: 1,
  chromaFalloff: 2,
  scanlineLines: postTok.scanlines.lines,
  scanlineOpacity: postTok.scanlines.opacity,
  grain: postTok.grain,
  grainSize: 1,
  vignette: postTok.vignette,
  gradeAmount: 1,
  saturation: postTok.grade.saturation,
  gamma: postTok.grade.gamma,
  softness: 0.35,
  dangerTint: 0.22,
  flashMax: 0.75,
  streaks: STREAK_VARIANTS.A,
};

export const POST_VARIANTS: Record<'A' | 'B' | 'C', PostParams> = {
  /** A "broadcast": token numbers, shoulder-only tone map (token colours unchanged below 0.8 linear) */
  A: { ...tokenPost, gradeAmount: 0.5, streaks: { ...STREAK_VARIANTS.A, opacity: 0.42 } },
  /** B "clean anime": lighter texture, a touch more bloom, sparser streaks */
  B: {
    ...tokenPost,
    bloomStrength: 0.72,
    bloomRadius: 0.7,
    grain: 0.025,
    scanlineOpacity: 0.04,
    vignette: 0.2,
    softness: 0.2,
    chromaScale: 0.85,
    streaks: STREAK_VARIANTS.B,
  },
  /** C "VHS heavy": half ACES contrast, stronger split/texture, denser streaks */
  C: {
    ...tokenPost,
    acesMix: 0.5,
    bloomStrength: 0.6,
    chromaScale: 1.3,
    grain: 0.05,
    grainSize: 1.5,
    scanlineOpacity: 0.08,
    vignette: 0.3,
    saturation: 1.12,
    softness: 0.6,
    streaks: STREAK_VARIANTS.C,
  },
};

export const POST_ALL_ON: PostToggles = {
  bloom: true,
  chroma: true,
  softness: true,
  scanlines: true,
  grain: true,
  vignette: true,
  grade: true,
  streaks: true,
};

// ---------------------------------------------------------------- shaders
const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const PREFILTER = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 pf(vec3 c) {
  c = min(c, vec3(64.0));
  float br = lum(c);
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  return c * contrib;
}
void main() {
  vec3 a = pf(texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb);
  vec3 b = pf(texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb);
  vec3 c = pf(texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb);
  vec3 d = pf(texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb);
  // Karis average: suppresses single-pixel fireflies
  float wa = 1.0 / (1.0 + lum(a)), wb = 1.0 / (1.0 + lum(b)), wc = 1.0 / (1.0 + lum(c)), wd = 1.0 / (1.0 + lum(d));
  gl_FragColor = vec4((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd), 1.0);
}
`;

const DOWN = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
  s += texture2D(tSrc, vUv - uTexel).rgb;
  s += texture2D(tSrc, vUv + uTexel).rgb;
  s += texture2D(tSrc, vUv + vec2(uTexel.x, -uTexel.y)).rgb;
  s += texture2D(tSrc, vUv - vec2(uTexel.x, -uTexel.y)).rgb;
  gl_FragColor = vec4(s / 8.0, 1.0);
}
`;

const UP = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uWeight;
varying vec2 vUv;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 s = texture2D(tSrc, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(0.0, h.y * 2.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  gl_FragColor = vec4(s / 12.0 * uWeight, 1.0);
}
`;

const COMPOSITE = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2 uRes;
uniform float uTime;
uniform float uClean;
uniform float uExposure;
uniform float uShoulder;
uniform float uAcesMix;
uniform float uBloom;
uniform float uChroma;
uniform float uChromaFalloff;
uniform float uSoft;
uniform float uScanLines;
uniform float uScanOpacity;
uniform float uGrain;
uniform float uGrainSize;
uniform float uVignette;
uniform float uGrade;
uniform float uSaturation;
uniform float uGamma;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uDanger;
uniform vec3 uDangerColor;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uSpeed;
uniform vec2 uVanish;
uniform vec3 uStreakColor;
varying vec2 vUv;
${GLSL_SPEED_STREAKS}

vec3 shoulder(vec3 x, float k) {
  vec3 over = k + (1.0 - k) * (1.0 - exp(-(x - k) / (1.0 - k)));
  return mix(x, over, step(vec3(k), x));
}
vec3 rrtOdt(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 c) {
  const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = inM * (c / 0.6);
  c = rrtOdt(c);
  return clamp(outM * c, 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 soft(vec2 uv) {
  vec2 o = vec2(uSoft / uRes.x, 0.0);
  return 0.5 * (texture2D(tScene, uv - o).rgb + texture2D(tScene, uv + o).rgb);
}

void main() {
  vec2 uv = vUv;
  vec3 hdr;
  float aspect = uRes.x / uRes.y;
  vec2 ca = (uv - 0.5) * vec2(aspect, 1.0);
  float rC = length(ca) / length(vec2(0.5 * aspect, 0.5)); // 0 centre .. 1 corner
  if (uClean > 0.5) {
    hdr = texture2D(tScene, uv).rgb;
  } else {
    vec2 dirS = ca / max(length(ca), 1e-5);
    vec2 off = dirS * uChroma * pow(rC, uChromaFalloff) * vec2(1.0, aspect);
    hdr.r = soft(uv + off).r;
    hdr.g = soft(uv).g;
    hdr.b = soft(uv - off).b;
    hdr += texture2D(tBloom, uv).rgb * uBloom;
  }
  hdr *= uExposure;
  vec3 tm = mix(shoulder(max(hdr, 0.0), uShoulder), aces(max(hdr, 0.0)), uAcesMix);
  vec3 c = toSRGB(tm);
  if (uClean < 0.5) {
    // grade (display space): lift shadows cool, gain highlights warm, saturation
    vec3 sh3 = (1.0 - c) * (1.0 - c) * (1.0 - c);
    vec3 g = c * mix(vec3(1.0), uGain, uGrade) + uLift * sh3;
    g = pow(max(g, 0.0), vec3(1.0 / uGamma));
    float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
    g = mix(vec3(l), g, uSaturation);
    c = mix(c, clamp(g, 0.0, 1.0), min(uGrade * 2.0, 1.0));
    // vignette + danger edge tint
    float edge = smoothstep(0.35, 1.0, rC);
    c *= 1.0 - uVignette * edge * edge;
    float pulse = 0.65 + 0.35 * sin(uTime * 12.566);
    c = mix(c, uDangerColor, uDanger * smoothstep(0.55, 1.05, rC) * pulse);
    // radial speed streaks
    vec2 vpx = (uVanish * 0.5 + 0.5) * uRes;
    float st = speedStreaks(vUv * uRes, vpx, uRes, uTime, uSpeed);
    c = mix(c, uStreakColor, st);
    // white flash
    c = mix(c, uFlashColor, uFlash);
    // scanlines: 2-px period at 1080p (row phase chosen so alternate rows darken)
    float L = (gl_FragCoord.y - 0.5) * uScanLines / uRes.y;
    c *= 1.0 - uScanOpacity * (0.5 + 0.5 * cos(6.2831853 * L));
    // film grain, 24 fps, triangular distribution, strongest in mid-tones
    float fi = mod(floor(uTime * 24.0), 61.0);
    vec2 gp = floor(gl_FragCoord.xy / max(uGrainSize * uRes.y / 1080.0, 1.0));
    float n = hash12(gp + fi * vec2(37.0, 17.0)) + hash12(gp * 1.37 + fi * vec2(11.0, 53.0)) - 1.0;
    float lm = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c += n * uGrain * (0.55 + 0.45 * (1.0 - abs(lm * 2.0 - 1.0)));
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

function passMaterial(frag: string, uniforms: Record<string, THREE.IUniform>, additive = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: frag,
    depthTest: false,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NoBlending,
    transparent: additive,
  });
}

function rgbVec(hex: string): THREE.Vector3 {
  const [r, g, b] = hexToRgb(hex);
  return new THREE.Vector3(r, g, b);
}

export class PostStack {
  readonly renderer: THREE.WebGLRenderer;
  params: PostParams;
  /** per-effect switches (all on by default) */
  toggles: PostToggles = { ...POST_ALL_ON };
  /** true when the scene target is HalfFloat (HDR); false = sRGB 8-bit fallback */
  readonly hdr: boolean;
  /** MSAA samples actually used on the scene target */
  readonly samples: number;
  /** number of full-screen passes issued by the last render() */
  lastPassCount = 0;

  private cleanMode: boolean;
  private sceneRT: THREE.WebGLRenderTarget;
  private mips: THREE.WebGLRenderTarget[] = [];
  private fsScene = new THREE.Scene();
  private fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private mPre: THREE.ShaderMaterial;
  private mDown: THREE.ShaderMaterial;
  private mUp: THREE.ShaderMaterial;
  private mComp: THREE.ShaderMaterial;
  private w = 1;
  private h = 1;
  private pr = 1;
  private tmpColor = new THREE.Color();
  private clearColor = new THREE.Color();

  constructor(renderer: THREE.WebGLRenderer, opts: { clean?: boolean; msaaSamples?: number; params?: PostParams } = {}) {
    this.renderer = renderer;
    this.cleanMode = !!opts.clean;
    this.params = opts.params ?? POST_VARIANTS.A;
    const ext = renderer.extensions;
    this.hdr = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    const gl = renderer.getContext() as WebGL2RenderingContext;
    let samples = Math.max(0, Math.floor(opts.msaaSamples ?? 4));
    try {
      const fmt = this.hdr ? gl.RGBA16F : gl.RGBA8;
      const sup = gl.getInternalformatParameter(gl.RENDERBUFFER, fmt, gl.SAMPLES) as Int32Array | null;
      const maxS = sup && sup.length ? Math.max(...Array.from(sup)) : 0;
      samples = Math.min(samples, maxS, renderer.capabilities.maxSamples);
    } catch {
      samples = 0;
    }
    this.samples = samples;
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      colorSpace: this.hdr ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace,
      samples,
      depthBuffer: true,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    for (let i = 0; i < 3; i++) {
      this.mips.push(
        new THREE.WebGLRenderTarget(1, 1, {
          type: this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
          depthBuffer: false,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
        }),
      );
    }
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.mPre = passMaterial(PREFILTER, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 0.85 },
      uKnee: { value: 0.1 },
    });
    this.mDown = passMaterial(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.mUp = passMaterial(UP, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } }, true);
    this.mComp = passMaterial(COMPOSITE, {
      tScene: { value: this.sceneRT.texture },
      tBloom: { value: this.mips[0].texture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uClean: { value: 0 },
      uExposure: { value: 1 },
      uShoulder: { value: 0.8 },
      uAcesMix: { value: 0 },
      uBloom: { value: 0 },
      uChroma: { value: 0 },
      uChromaFalloff: { value: 2 },
      uSoft: { value: 0 },
      uScanLines: { value: 540 },
      uScanOpacity: { value: 0 },
      uGrain: { value: 0 },
      uGrainSize: { value: 1 },
      uVignette: { value: 0 },
      uGrade: { value: 0 },
      uSaturation: { value: 1 },
      uGamma: { value: 1 },
      uLift: { value: rgbVec(postTok.grade.lift) },
      uGain: { value: rgbVec(postTok.grade.gain) },
      uDanger: { value: 0 },
      uDangerColor: { value: rgbVec(palette.shieldRed) },
      uFlash: { value: 0 },
      uFlashColor: { value: rgbVec(palette.hitFlash) },
      uSpeed: { value: 0 },
      uVanish: { value: new THREE.Vector2() },
      uStreakColor: { value: rgbVec(vfx.speedStreaks.color) },
      uStrCount: { value: 200 },
      uStrDensity: { value: 0.5 },
      uStrWidth: { value: 1.5 },
      uStrLenMin: { value: 0.05 },
      uStrLenMax: { value: 0.3 },
      uStrOpacity: { value: 0.4 },
      uStrInner: { value: 0.3 },
      uStrEdge: { value: 1.8 },
      uStrRate: { value: 1 },
    });
    this.quad = new THREE.Mesh(tri, this.mComp);
    this.quad.frustumCulled = false;
    this.fsScene.add(this.quad);
  }

  get clean(): boolean {
    return this.cleanMode;
  }

  setClean(on: boolean): void {
    this.cleanMode = on;
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.pr = pixelRatio;
    const W = Math.max(1, Math.round(this.w * pixelRatio));
    const H = Math.max(1, Math.round(this.h * pixelRatio));
    this.sceneRT.setSize(W, H);
    let mw = W, mh = H;
    for (const m of this.mips) {
      mw = Math.max(1, Math.ceil(mw / 2));
      mh = Math.max(1, Math.ceil(mh / 2));
      m.setSize(mw, mh);
    }
    (this.mComp.uniforms.uRes.value as THREE.Vector2).set(W, H);
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.fsScene, this.fsCam);
    this.lastPassCount++;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, f: PostFrame): void {
    const r = this.renderer;
    const p = this.params;
    const t = this.toggles;
    const clean = this.cleanMode;
    this.lastPassCount = 0;
    const prevAutoClear = r.autoClear;
    r.getClearColor(this.clearColor);
    const prevAlpha = r.getClearAlpha();

    // 1) scene into the (MSAA) target; three resolves it when the target changes
    r.setRenderTarget(this.sceneRT);
    const bg = scene.background;
    if (bg && (bg as THREE.Color).isColor) this.tmpColor.copy(bg as THREE.Color);
    else this.tmpColor.set(palette.spaceDeep);
    r.setClearColor(this.tmpColor, 1);
    r.clear(true, true, true);
    r.autoClear = false;
    r.render(scene, camera);

    // 2) bloom chain (5 passes, <= 1/2 res)
    const bloomOn = !clean && t.bloom && p.bloomStrength > 0;
    if (bloomOn) {
      const [m0, m1, m2] = this.mips;
      const pu = this.mPre.uniforms;
      pu.tSrc.value = this.sceneRT.texture;
      (pu.uTexel.value as THREE.Vector2).set(1 / this.sceneRT.width, 1 / this.sceneRT.height);
      pu.uThreshold.value = p.bloomThreshold;
      pu.uKnee.value = p.bloomKnee;
      this.pass(this.mPre, m0);
      const du = this.mDown.uniforms;
      du.tSrc.value = m0.texture;
      (du.uTexel.value as THREE.Vector2).set(1 / m0.width, 1 / m0.height);
      this.pass(this.mDown, m1);
      du.tSrc.value = m1.texture;
      (du.uTexel.value as THREE.Vector2).set(1 / m1.width, 1 / m1.height);
      this.pass(this.mDown, m2);
      const uu = this.mUp.uniforms;
      uu.uWeight.value = p.bloomRadius;
      uu.tSrc.value = m2.texture;
      (uu.uTexel.value as THREE.Vector2).set(1 / m2.width, 1 / m2.height);
      this.pass(this.mUp, m1); // m1 += up(m2)
      uu.tSrc.value = m1.texture;
      (uu.uTexel.value as THREE.Vector2).set(1 / m1.width, 1 / m1.height);
      this.pass(this.mUp, m0); // m0 += up(m1)
    }

    // 3) composite to the canvas
    const u = this.mComp.uniforms;
    u.uClean.value = clean ? 1 : 0;
    u.uTime.value = f.time;
    u.uExposure.value = p.exposure;
    u.uShoulder.value = p.toneShoulder;
    u.uAcesMix.value = p.acesMix;
    u.uBloom.value = bloomOn ? p.bloomStrength : 0;
    u.uChroma.value = t.chroma ? f.chroma * p.chromaScale : 0;
    u.uChromaFalloff.value = p.chromaFalloff;
    u.uSoft.value = t.softness ? p.softness * this.pr : 0;
    u.uScanLines.value = p.scanlineLines;
    u.uScanOpacity.value = t.scanlines ? p.scanlineOpacity : 0;
    u.uGrain.value = t.grain ? p.grain : 0;
    u.uGrainSize.value = p.grainSize;
    u.uVignette.value = t.vignette ? p.vignette : 0;
    u.uGrade.value = t.grade ? p.gradeAmount : 0;
    u.uSaturation.value = p.saturation;
    u.uGamma.value = p.gamma;
    u.uDanger.value = Math.min(1, Math.max(0, f.danger01)) * p.dangerTint * (t.vignette ? 1 : 0);
    u.uFlash.value = Math.min(1, Math.max(0, f.flash)) * p.flashMax;
    u.uSpeed.value = t.streaks ? Math.min(1, Math.max(0, f.speed01)) : 0;
    (u.uVanish.value as THREE.Vector2).copy(f.vanish);
    const s = p.streaks;
    u.uStrCount.value = s.count;
    u.uStrDensity.value = s.density;
    u.uStrWidth.value = s.widthPx;
    u.uStrLenMin.value = s.lenMin;
    u.uStrLenMax.value = s.lenMax;
    u.uStrOpacity.value = s.opacity;
    u.uStrInner.value = s.inner;
    u.uStrEdge.value = s.edgeBoost;
    u.uStrRate.value = s.rate;
    r.setRenderTarget(null);
    r.setViewport(0, 0, this.w, this.h);
    this.pass(this.mComp, null);

    r.autoClear = prevAutoClear;
    r.setClearColor(this.clearColor, prevAlpha);
  }

  dispose(): void {
    this.sceneRT.dispose();
    for (const m of this.mips) m.dispose();
    for (const m of [this.mPre, this.mDown, this.mUp, this.mComp]) m.dispose();
    this.quad.geometry.dispose();
  }
}
