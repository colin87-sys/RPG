/**
 * Projectiles (VFX lane A): instanced pools, one draw call each.
 *
 * HostileBullets: camera-facing discs = white-hot core + yellow-orange halo +
 *   thin dark outline ring (+ a faint additive glow outside). The white CORE is
 *   never smaller on screen than vfx.hostileBullet.minFrameHeightFrac (1.8%) of the
 *   frame height at any distance; the halo disc is then ~3.5-3.8% (REF_VERIFICATION).
 *   The white-hot core + dark outline are our readability upgrade [A]; the refs show
 *   flat yellow cores without an outline. Premultiplied blend: the disc replaces the background (reads
 *   on white cloud), the outline darkens it (reads on hot orange), the glow adds.
 * PlayerShots: thin cool cyan-white streaks along the velocity (screen-space
 *   capsules), additive with a little occlusion; narrower and cooler than hostile
 *   fire, and drawn before it (renderOrder 35 < 40) so it never covers it.
 *
 * Two ways to drive them:
 *   1) built-in sim: spawn(pos, vel, ...) -> id; update(dt) integrates and expires.
 *   2) low-level: setInstance(i, ...) writes slot i directly (vel = 0, no expiry),
 *      then update(0) (or update(dt)) uploads. Mixing both on the same slots is not supported.
 */
import * as THREE from 'three';
import { palette, vfx } from '../../style/tokens';
import { mix, tvec } from '../../style/color';

// ------------------------------------------------------------------ shared pool
class Pool {
  readonly capacity: number;
  readonly alive: Uint8Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly vel: Float32Array;
  private free: Int32Array;
  private freeTop: number;
  top = 0; // highest live index + 1

  constructor(capacity: number) {
    this.capacity = capacity;
    this.alive = new Uint8Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.free = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this.free[i] = capacity - 1 - i;
    this.freeTop = capacity;
  }

  alloc(): number {
    if (this.freeTop === 0) return -1;
    const i = this.free[--this.freeTop];
    this.alive[i] = 1;
    this.age[i] = 0;
    if (i + 1 > this.top) this.top = i + 1;
    return i;
  }

  release(i: number): void {
    if (i < 0 || i >= this.capacity || !this.alive[i]) return;
    this.alive[i] = 0;
    this.free[this.freeTop++] = i;
  }

  /** claim a specific slot (low-level API) */
  claim(i: number): void {
    if (this.alive[i]) return;
    for (let k = 0; k < this.freeTop; k++) {
      if (this.free[k] === i) {
        this.free[k] = this.free[this.freeTop - 1];
        this.freeTop--;
        break;
      }
    }
    this.alive[i] = 1;
    this.age[i] = 0;
    this.life[i] = Infinity;
    this.vel[i * 3] = this.vel[i * 3 + 1] = this.vel[i * 3 + 2] = 0;
    if (i + 1 > this.top) this.top = i + 1;
  }

  get count(): number {
    return this.capacity - this.freeTop;
  }

  reset(): void {
    this.alive.fill(0);
    for (let i = 0; i < this.capacity; i++) this.free[i] = this.capacity - 1 - i;
    this.freeTop = this.capacity;
    this.top = 0;
  }

  shrinkTop(): void {
    while (this.top > 0 && !this.alive[this.top - 1]) this.top--;
  }
}

const premultiplied = {
  transparent: true,
  depthWrite: false,
  depthTest: true,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
} as const;

function viewportHook(mesh: THREE.Mesh, uniform: THREE.IUniform): void {
  const v = new THREE.Vector4();
  mesh.onBeforeRender = (renderer) => {
    renderer.getCurrentViewport(v);
    (uniform.value as THREE.Vector2).set(v.z, v.w);
  };
}

// ------------------------------------------------------------------ hostile bullets
export interface HostileBulletParams {
  /** default world radius of the visible disc (m) */
  radius: number;
  /** min on-screen CORE diameter / frame height (token 0.018), applied at every distance */
  minFrameHeightFrac: number;
  /** core radius / halo radius (0.5 -> halo disc ~2x the core, as in the refs) */
  coreFrac: number;
  /** dark outline thickness / body radius, and its px floor */
  outlineFrac: number;
  minOutlinePx: number;
  outlineAlpha: number;
  coreIntensity: number;
  haloIntensity: number;
  /** faint additive glow outside the outline: amount and extent (body radii) */
  glow: number;
  glowExtent: number;
  /** halo shimmer amount and rate */
  pulse: number;
  pulseHz: number;
  /** 0..1 how far the halo rim shifts toward fireOrange (lower keeps it yellow: separates from hot-orange skies) */
  haloDeep?: number;
}

const hb = vfx.hostileBullet;

export const HOSTILE_VARIANTS: Record<'A' | 'B' | 'C', HostileBulletParams> = {
  /** A: token spec, balanced core/halo */
  A: { radius: 0.9, minFrameHeightFrac: hb.minFrameHeightFrac, coreFrac: 0.5, outlineFrac: 0.12, minOutlinePx: 2.0, outlineAlpha: 0.9, coreIntensity: 2.6, haloIntensity: 1.1, glow: 0.3, glowExtent: 1.6, pulse: 0.1, pulseHz: 7 },
  /** B: bigger floor, heavier outline (max bright-sky separation) */
  B: { radius: 0.95, minFrameHeightFrac: 0.008, coreFrac: 0.58, haloDeep: 0.15, outlineFrac: 0.12, minOutlinePx: 1.5, outlineAlpha: 1.0, coreIntensity: 2.6, haloIntensity: 1.0, glow: 0.1, glowExtent: 1.5, pulse: 0.08, pulseHz: 6 },
  /** C: hotter core, thinner outline, stronger glow (dark-stage bias) */
  C: { radius: 0.85, minFrameHeightFrac: hb.minFrameHeightFrac, coreFrac: 0.55, outlineFrac: 0.1, minOutlinePx: 1.6, outlineAlpha: 0.85, coreIntensity: 3.4, haloIntensity: 1.3, glow: 0.45, glowExtent: 1.8, pulse: 0.12, pulseHz: 8 },
};

const HB_VERT = /* glsl */ `
attribute vec4 aPosRad;   // world xyz, radius (m)
attribute vec2 aAlphaSeed;
uniform vec2 uViewport;
uniform float uMinFrac;
uniform float uMaxFrac;   // body diameter cap / frame height (near rounds do not balloon)
uniform float uQuad;      // quad half-size in body radii
varying vec2 vQ;
varying float vRpx;
varying vec2 vAS;
void main() {
  vAS = aAlphaSeed;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(aPosRad.xyz, 1.0);
  if (aAlphaSeed.x <= 0.0 || clip.w <= 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float f = projectionMatrix[1][1] * 0.5 * uViewport.y;
  float rpx = min(max(aPosRad.w * f / clip.w, uMinFrac * uViewport.y * 0.5), uMaxFrac * uViewport.y * 0.5);
  vRpx = rpx;
  vQ = position.xy * uQuad;
  clip.xy += vQ * rpx / (0.5 * uViewport) * clip.w;
  gl_Position = clip;
}
`;

const HB_FRAG = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uHalo;
uniform vec3 uHaloDeep;
uniform vec3 uOutline;
uniform float uCoreFrac;
uniform float uOutlineFrac;
uniform float uMinOutlinePx;
uniform float uOutlineAlpha;
uniform float uGlow;
uniform float uGlowExt;
uniform float uPulse;
uniform float uPulseHz;
uniform float uTime;
varying vec2 vQ;
varying float vRpx;
varying vec2 vAS;
void main() {
  float rho = length(vQ);
  float aa = 1.0 / max(vRpx, 1.0);
  float ow = max(uOutlineFrac, uMinOutlinePx * aa);
  float haloEdge = 1.0 - ow;
  float coreR = uCoreFrac * haloEdge;
  float body = 1.0 - smoothstep(1.0 - aa * 0.7, 1.0 + aa * 0.7, rho);
  float inner = 1.0 - smoothstep(haloEdge - aa * 0.7, haloEdge + aa * 0.7, rho);
  float core = 1.0 - smoothstep(coreR - aa, coreR + aa, rho);
  float sh = 1.0 + uPulse * sin(uTime * 6.2831853 * uPulseHz + vAS.y * 6.2831853);
  float t = clamp((rho - coreR) / max(haloEdge - coreR, 1e-3), 0.0, 1.0);
  vec3 halo = mix(mix(mix(uCore, uHalo, 0.75), uHalo, smoothstep(0.0, 0.3, t)), uHaloDeep, smoothstep(0.45, 1.0, t)) * sh;
  vec3 emit = mix(halo, uCore, core) * inner;
  float ring = (body - inner) * uOutlineAlpha;
  float g = uGlow * exp(-max(rho - 1.0, 0.0) * 3.2) * (1.0 - body) * (1.0 - smoothstep(uGlowExt - 0.2, uGlowExt, rho));
  vec3 rgb = emit + uOutline * ring + uHalo * g * 0.5;
  float a = vAS.x;
  gl_FragColor = vec4(rgb * a, (inner + ring) * a);
}
`;

export class HostileBullets {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  params: HostileBulletParams;
  private pool: Pool;
  private aPosRad: THREE.InstancedBufferAttribute;
  private aAS: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private time = 0;

  constructor(params: HostileBulletParams = HOSTILE_VARIANTS.A, capacity = 256) {
    this.params = params;
    this.capacity = capacity;
    this.pool = new Pool(capacity);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPosRad = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aAS = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    this.aPosRad.setUsage(THREE.DynamicDrawUsage);
    this.aAS.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < capacity; i++) (this.aAS.array as Float32Array)[i * 2 + 1] = fract(i * 0.61803398875);
    geo.setAttribute('aPosRad', this.aPosRad);
    geo.setAttribute('aAlphaSeed', this.aAS);
    geo.instanceCount = 0;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      ...premultiplied,
      // danger is always visible: rounds draw over explosions, smoke and hull (no depth test)
      depthTest: false,
      vertexShader: HB_VERT,
      fragmentShader: HB_FRAG,
      uniforms: {
        uViewport: { value: new THREE.Vector2(1920, 1080) },
        uMinFrac: { value: 0.009 },
        uMaxFrac: { value: 0.036 },
        uQuad: { value: 2 },
        uCore: { value: tvec(hb.core) },
        uHalo: { value: tvec(hb.halo) },
        uHaloDeep: { value: tvec(hb.halo) },
        uOutline: { value: tvec(hb.outline) },
        uCoreFrac: { value: 0.4 },
        uOutlineFrac: { value: 0.16 },
        uMinOutlinePx: { value: 1.3 },
        uOutlineAlpha: { value: 0.85 },
        uGlow: { value: 0.3 },
        uGlowExt: { value: 1.9 },
        uPulse: { value: 0.1 },
        uPulseHz: { value: 7 },
        uTime: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 40;
    viewportHook(this.mesh, this.mat.uniforms.uViewport);
    this.applyParams();
  }

  applyParams(): void {
    const p = this.params;
    const u = this.mat.uniforms;
    // body (outline outer edge) floor derived from the core floor
    u.uMinFrac.value = p.minFrameHeightFrac / (p.coreFrac * (1 - p.outlineFrac));
    u.uQuad.value = Math.max(1.05, p.glowExtent);
    (u.uCore.value as THREE.Vector3).copy(tvec(hb.core, p.coreIntensity));
    (u.uHalo.value as THREE.Vector3).copy(tvec(hb.halo, p.haloIntensity));
    // deeper orange toward the rim (derived: halo -> fireOrange) so the halo never reads as cream
    (u.uHaloDeep.value as THREE.Vector3).copy(tvec(mix(hb.halo, palette.fireOrange, p.haloDeep ?? 0.55), p.haloIntensity));
    u.uCoreFrac.value = p.coreFrac;
    u.uOutlineFrac.value = p.outlineFrac;
    u.uMinOutlinePx.value = p.minOutlinePx;
    u.uOutlineAlpha.value = p.outlineAlpha;
    u.uGlow.value = p.glow;
    u.uGlowExt.value = p.glowExtent;
    u.uPulse.value = p.pulse;
    u.uPulseHz.value = p.pulseHz;
  }

  /** Spawn a bullet; returns its id (slot) or -1 when the pool is full. */
  spawn(pos: THREE.Vector3, vel: THREE.Vector3, radius = this.params.radius, life = 8): number {
    const i = this.pool.alloc();
    if (i < 0) return -1;
    const pr = this.aPosRad.array as Float32Array;
    pr[i * 4] = pos.x;
    pr[i * 4 + 1] = pos.y;
    pr[i * 4 + 2] = pos.z;
    pr[i * 4 + 3] = radius;
    const v = this.pool.vel;
    v[i * 3] = vel.x;
    v[i * 3 + 1] = vel.y;
    v[i * 3 + 2] = vel.z;
    this.pool.life[i] = life;
    (this.aAS.array as Float32Array)[i * 2] = 1;
    return i;
  }

  /** Low-level: write slot i directly (claims it; no motion, no expiry). alpha 0 hides it. */
  setInstance(i: number, pos: THREE.Vector3, radius: number, alpha = 1): void {
    if (i < 0 || i >= this.capacity) return;
    this.pool.claim(i);
    const pr = this.aPosRad.array as Float32Array;
    pr[i * 4] = pos.x;
    pr[i * 4 + 1] = pos.y;
    pr[i * 4 + 2] = pos.z;
    pr[i * 4 + 3] = radius;
    (this.aAS.array as Float32Array)[i * 2] = alpha;
  }

  kill(id: number): void {
    this.pool.release(id);
    if (id >= 0 && id < this.capacity) (this.aAS.array as Float32Array)[id * 2] = 0;
  }

  isAlive(id: number): boolean {
    return id >= 0 && id < this.capacity && this.pool.alive[id] === 1;
  }

  getPosition(id: number, out: THREE.Vector3): THREE.Vector3 {
    const pr = this.aPosRad.array as Float32Array;
    return out.set(pr[id * 4], pr[id * 4 + 1], pr[id * 4 + 2]);
  }

  get count(): number {
    return this.pool.count;
  }

  clear(): void {
    this.pool.reset();
    (this.aAS.array as Float32Array).fill(0);
    for (let i = 0; i < this.capacity; i++) (this.aAS.array as Float32Array)[i * 2 + 1] = fract(i * 0.61803398875);
    this.geo.instanceCount = 0;
  }

  update(dt: number): void {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    const pool = this.pool;
    const pr = this.aPosRad.array as Float32Array;
    const as = this.aAS.array as Float32Array;
    const v = pool.vel;
    for (let i = 0; i < pool.top; i++) {
      if (!pool.alive[i]) continue;
      pool.age[i] += dt;
      if (pool.age[i] >= pool.life[i]) {
        pool.release(i);
        as[i * 2] = 0;
        continue;
      }
      pr[i * 4] += v[i * 3] * dt;
      pr[i * 4 + 1] += v[i * 3 + 1] * dt;
      pr[i * 4 + 2] += v[i * 3 + 2] * dt;
    }
    pool.shrinkTop();
    this.geo.instanceCount = pool.top;
    this.aPosRad.needsUpdate = true;
    this.aAS.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ------------------------------------------------------------------ player shots
export interface PlayerShotParams {
  /** world streak length (m) and width (m) */
  length: number;
  width: number;
  minWidthPx: number;
  maxWidthPx: number;
  minLengthPx: number;
  coreIntensity: number;
  haloIntensity: number;
  /** core width / total width */
  coreFrac: number;
  /** 0..1 how much the tail fades */
  tailFade: number;
  /** small premultiplied alpha so the cyan keeps its hue on white cloud */
  occlusion: number;
}

const ps = vfx.playerShot;

export const PLAYER_SHOT_VARIANTS: Record<'A' | 'B' | 'C', PlayerShotParams> = {
  /** A: thin cyan-white needles */
  A: { length: 3.5, width: 0.16, minWidthPx: 3, maxWidthPx: 6, minLengthPx: 10, coreIntensity: 1.2, haloIntensity: 0.95, coreFrac: 0.3, tailFade: 0.85, occlusion: 0.35 },
  /** B: longer, dimmer tracers */
  B: { length: 5, width: 0.13, minWidthPx: 2.6, maxWidthPx: 5, minLengthPx: 12, coreIntensity: 1.1, haloIntensity: 0.85, coreFrac: 0.28, tailFade: 0.9, occlusion: 0.3 },
  /** C: short bright bolts */
  C: { length: 2.4, width: 0.18, minWidthPx: 3.2, maxWidthPx: 7, minLengthPx: 8, coreIntensity: 1.4, haloIntensity: 1.0, coreFrac: 0.34, tailFade: 0.7, occlusion: 0.4 },
};

const PS_VERT = /* glsl */ `
attribute vec4 aHead;   // world head xyz, length (m)
attribute vec4 aDir;    // unit direction xyz, alpha
uniform vec2 uViewport;
uniform float uWidth;
uniform float uMinW;
uniform float uMaxW;
uniform float uMinL;
varying vec2 vAP;       // px along from the tail, px across
varying float vLen;
varying float vHW;
varying float vAlpha;
void main() {
  vAlpha = aDir.w;
  if (aDir.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  mat4 pv = projectionMatrix * modelViewMatrix;
  vec4 ch = pv * vec4(aHead.xyz, 1.0);
  vec4 ct = pv * vec4(aHead.xyz - aDir.xyz * aHead.w, 1.0);
  float nearW = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0) * 1.01;
  if (ch.w < nearW && ct.w < nearW) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (ch.w < nearW) ch = mix(ct, ch, (ct.w - nearW) / (ct.w - ch.w));
  if (ct.w < nearW) ct = mix(ch, ct, (ch.w - nearW) / (ch.w - ct.w));
  vec2 half_ = 0.5 * uViewport;
  vec2 hp = ch.xy / ch.w * half_;
  vec2 tp = ct.xy / ct.w * half_;
  vec2 dv = hp - tp;
  float L = length(dv);
  vec2 dir = L > 1e-4 ? dv / L : vec2(0.0, 1.0);
  if (L < uMinL) { tp = hp - dir * uMinL; L = uMinL; }
  float f = projectionMatrix[1][1] * half_.y;
  float hw = clamp(uWidth * 0.5 * f / ch.w, uMinW * 0.5, uMaxW * 0.5);
  float s = position.x;
  vec2 n = vec2(-dir.y, dir.x);
  vec2 p = mix(tp - dir * hw, hp + dir * hw, s) + n * position.y * hw;
  float z = mix(ct.z / ct.w, ch.z / ch.w, s);
  gl_Position = vec4(p / half_, z, 1.0);
  vAP = vec2(mix(-hw, L + hw, s), position.y * hw);
  vLen = L;
  vHW = hw;
}
`;

const PS_FRAG = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uHalo;
uniform float uCoreFrac;
uniform float uTailFade;
uniform float uOcc;
varying vec2 vAP;
varying float vLen;
varying float vHW;
varying float vAlpha;
void main() {
  float a = vAP.x;
  float dx = max(0.0, -a) + max(0.0, a - vLen);
  float d = length(vec2(dx, vAP.y)) / max(vHW, 1e-3);
  float aa = 1.0 / max(vHW, 1.0);
  float core = 1.0 - smoothstep(uCoreFrac - aa, uCoreFrac + aa, d);
  float halo = 1.0 - smoothstep(0.35, 1.0, d);
  float along = clamp(a / max(vLen, 1e-3), 0.0, 1.0);
  float taper = mix(1.0 - uTailFade, 1.0, pow(along, 0.7));
  vec3 rgb = (uCore * core + uHalo * halo * (1.0 - core)) * taper * vAlpha;
  gl_FragColor = vec4(rgb, halo * uOcc * taper * vAlpha);
}
`;

export class PlayerShots {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  params: PlayerShotParams;
  private pool: Pool;
  private aHead: THREE.InstancedBufferAttribute;
  private aDir: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;

  constructor(params: PlayerShotParams = PLAYER_SHOT_VARIANTS.A, capacity = 256) {
    this.params = params;
    this.capacity = capacity;
    this.pool = new Pool(capacity);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aHead = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aDir = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aHead.setUsage(THREE.DynamicDrawUsage);
    this.aDir.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aHead', this.aHead);
    geo.setAttribute('aDir', this.aDir);
    geo.instanceCount = 0;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      ...premultiplied,
      vertexShader: PS_VERT,
      fragmentShader: PS_FRAG,
      uniforms: {
        uViewport: { value: new THREE.Vector2(1920, 1080) },
        uWidth: { value: 0.14 },
        uMinW: { value: 2.6 },
        uMaxW: { value: 6 },
        uMinL: { value: 9 },
        uCore: { value: tvec(ps.core) },
        uHalo: { value: tvec(ps.halo) },
        uCoreFrac: { value: 0.35 },
        uTailFade: { value: 0.85 },
        uOcc: { value: 0.2 },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 35;
    viewportHook(this.mesh, this.mat.uniforms.uViewport);
    this.applyParams();
  }

  applyParams(): void {
    const p = this.params;
    const u = this.mat.uniforms;
    u.uWidth.value = p.width;
    u.uMinW.value = p.minWidthPx;
    u.uMaxW.value = p.maxWidthPx;
    u.uMinL.value = p.minLengthPx;
    (u.uCore.value as THREE.Vector3).copy(tvec(ps.core, p.coreIntensity));
    (u.uHalo.value as THREE.Vector3).copy(tvec(ps.halo, p.haloIntensity));
    u.uCoreFrac.value = p.coreFrac;
    u.uTailFade.value = p.tailFade;
    u.uOcc.value = p.occlusion;
  }

  /** Spawn a shot; the streak points along vel. Returns id or -1 when full. */
  spawn(pos: THREE.Vector3, vel: THREE.Vector3, life = 0.9): number {
    const i = this.pool.alloc();
    if (i < 0) return -1;
    const v = this.pool.vel;
    v[i * 3] = vel.x;
    v[i * 3 + 1] = vel.y;
    v[i * 3 + 2] = vel.z;
    this.pool.life[i] = life;
    this.write(i, pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, this.params.length, 1);
    return i;
  }

  /** Low-level: write slot i directly (dir need not be normalised). */
  setInstance(i: number, pos: THREE.Vector3, dir: THREE.Vector3, length = this.params.length, alpha = 1): void {
    if (i < 0 || i >= this.capacity) return;
    this.pool.claim(i);
    this.write(i, pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, length, alpha);
  }

  private write(i: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, len: number, alpha: number): void {
    const h = this.aHead.array as Float32Array;
    const d = this.aDir.array as Float32Array;
    const l = Math.hypot(dx, dy, dz) || 1;
    h[i * 4] = x;
    h[i * 4 + 1] = y;
    h[i * 4 + 2] = z;
    h[i * 4 + 3] = len;
    d[i * 4] = dx / l;
    d[i * 4 + 1] = dy / l;
    d[i * 4 + 2] = dz / l;
    d[i * 4 + 3] = alpha;
  }

  kill(id: number): void {
    this.pool.release(id);
    if (id >= 0 && id < this.capacity) (this.aDir.array as Float32Array)[id * 4 + 3] = 0;
  }

  isAlive(id: number): boolean {
    return id >= 0 && id < this.capacity && this.pool.alive[id] === 1;
  }

  get count(): number {
    return this.pool.count;
  }

  clear(): void {
    this.pool.reset();
    (this.aDir.array as Float32Array).fill(0);
    this.geo.instanceCount = 0;
  }

  update(dt: number): void {
    const pool = this.pool;
    const h = this.aHead.array as Float32Array;
    const d = this.aDir.array as Float32Array;
    const v = pool.vel;
    for (let i = 0; i < pool.top; i++) {
      if (!pool.alive[i]) continue;
      pool.age[i] += dt;
      if (pool.age[i] >= pool.life[i]) {
        pool.release(i);
        d[i * 4 + 3] = 0;
        continue;
      }
      h[i * 4] += v[i * 3] * dt;
      h[i * 4 + 1] += v[i * 3 + 1] * dt;
      h[i * 4 + 2] += v[i * 3 + 2] * dt;
    }
    pool.shrinkTop();
    this.geo.instanceCount = pool.top;
    this.aHead.needsUpdate = true;
    this.aDir.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

function fract(x: number): number {
  return x - Math.floor(x);
}
