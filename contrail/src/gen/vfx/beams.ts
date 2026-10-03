/**
 * Beams (VFX lane A): enemy lasers and boss beams. One instanced draw call for
 * every beam. Each beam is a screen-space capsule ribbon along the axis
 * (camera-facing by construction, near-plane clipped, pixel floors on width),
 * so it works for beams pointing straight at the camera too.
 *
 * States (driven by the game):
 *   telegraph: thin bright line with a dark outline (reads on bright sky and on
 *              dark space), flickers faster as t01 -> 1 (0.7 s by design).
 *   fire:      cross-section W-Y-R from the centre out (REF_VERIFICATION owner-006):
 *              flat white core ~62% of the width, thin warm edge line, red halo
 *              (laserRed; burstYellow for boss beams) fading to dark red. Start
 *              flash (width + brightness overshoot) and the tip extends from the
 *              emitter in extendS. Tapers over the last 15% of t01.
 *   off:       fades out over fadeS, then hidden (the id stays registered).
 * Premultiplied blend: emission adds, a partial alpha keeps the halo saturated
 * over bright sky. Beams are never dark.
 */
import * as THREE from 'three';
import { palette, vfx } from '../../style/tokens';
import { mix, shade, tvec } from '../../style/color';

export type BeamKind = 'laser' | 'boss';
export type BeamState = 'telegraph' | 'fire' | 'off';

export interface BeamParams {
  /** total beam width in metres (token vfx.beam.haloWidth = 3.0) */
  width: number;
  /** flat white core as a fraction of the TOTAL width incl. halo (REF_VERIFICATION: core ~65% of the
   *  bright beam, red halo ~25% of it per side -> ~0.48-0.55 of the total) */
  coreFrac: number;
  /** warm edge line width as a fraction of the width, and its px floor */
  edgeFrac: number;
  edgeMinPx: number;
  /** boss beams are this much wider */
  bossScale: number;
  minWidthPx: number;
  coreIntensity: number;
  edgeIntensity: number;
  haloIntensity: number;
  /** premultiplied alpha of the halo (keeps the red saturated on bright sky) */
  haloOcclusion: number;
  /** telegraph line width (m) + px floor, dark outline px + alpha */
  telegraphWidth: number;
  telegraphMinPx: number;
  telegraphOutlinePx: number;
  telegraphOutlineAlpha: number;
  telegraphIntensity: number;
  /** flicker rate at t01 = 0 and t01 = 1 (Hz), depth 0..1 */
  flickerHz: [number, number];
  flickerDepth: number;
  flashS: number;
  flashScale: number;
  flashBoost: number;
  /** emitter flare size (in beam widths) during the flash */
  flare: number;
  extendS: number;
  fadeS: number;
  /** energy flow along the halo */
  flowAmount: number;
  flowSpeed: number;
  flowPeriod: number;
}

const bt = vfx.beam;

const baseBeam: BeamParams = {
  width: bt.haloWidth,
  coreFrac: 0.48,
  edgeFrac: 0.035,
  edgeMinPx: 1.4,
  bossScale: 3,
  minWidthPx: 9,
  coreIntensity: 1.8,
  edgeIntensity: 2.0,
  haloIntensity: 2.2,
  haloOcclusion: 0.7,
  telegraphWidth: 0.14,
  telegraphMinPx: 3,
  telegraphOutlinePx: 2,
  telegraphOutlineAlpha: 0.75,
  telegraphIntensity: 2.0,
  flickerHz: [7, 18],
  flickerDepth: 0.55,
  flashS: 0.12,
  flashScale: 1.6,
  flashBoost: 1.2,
  flare: 1.3,
  extendS: 0.18,
  fadeS: 0.16,
  flowAmount: 0.18,
  flowSpeed: 40,
  flowPeriod: 6,
};

export const BEAM_VARIANTS: Record<'A' | 'B' | 'C', BeamParams> = {
  /** A: verified cross-section, token width */
  A: { ...baseBeam },
  /** B: slimmer core, stronger halo, slower flicker (heavier threat read) */
  B: { ...baseBeam, coreFrac: 0.42, haloIntensity: 2.6, haloOcclusion: 0.8, flickerHz: [5, 14], telegraphOutlinePx: 2.5, bossScale: 3.4 },
  /** C: wider core, brighter flash, faster tip extension, livelier flow */
  C: { ...baseBeam, coreFrac: 0.55, edgeFrac: 0.05, edgeMinPx: 2, haloIntensity: 2.8, haloOcclusion: 0.88, flashScale: 1.4, flashBoost: 1.6, extendS: 0.12, flowAmount: 0.3, telegraphWidth: 0.16, bossScale: 2.1 },
};

const VERT = /* glsl */ `
attribute vec3 aFrom;
attribute vec3 aTo;
attribute vec4 aW;   // half width (m), telegraph half width (m), intensity, alpha
attribute vec4 aK;   // mode (0 telegraph, 1 fire), kind (0 laser, 1 boss), t01, flare
uniform vec2 uViewport;
uniform float uMinW;
uniform float uTeleMinPx;
uniform float uTeleOutPx;
uniform float uMaxHalfFrac; // fired-beam half width cap / frame height (a beam passing the lens never floods the screen)
varying vec2 vAP;
varying float vLen;
varying float vInvW;
varying float vSW;
varying float vLenW;
varying vec4 vW;
varying vec4 vK;
varying float vF;
void main() {
  vW = aW;
  vK = aK;
  if (aW.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  mat4 pv = projectionMatrix * modelViewMatrix;
  vec4 ca = pv * vec4(aFrom, 1.0);
  vec4 cb = pv * vec4(aTo, 1.0);
  float nearW = projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0) * 1.01;
  if (ca.w < nearW && cb.w < nearW) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float sa = 0.0, sb = 1.0;
  if (ca.w < nearW) { float k = (cb.w - nearW) / (cb.w - ca.w); ca = mix(cb, ca, k); sa = 1.0 - k; }
  if (cb.w < nearW) { float k = (ca.w - nearW) / (ca.w - cb.w); cb = mix(ca, cb, k); sb = k; }
  vec2 hv = 0.5 * uViewport;
  vec2 pa = ca.xy / ca.w * hv;
  vec2 pb = cb.xy / cb.w * hv;
  vec2 dv = pb - pa;
  float L = length(dv);
  vec2 dir = L > 1e-3 ? dv / L : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float f = projectionMatrix[1][1] * hv.y;
  vF = f;
  float wa = 1.0 / ca.w, wb = 1.0 / cb.w;
  float extA, extB;
  if (aK.x > 0.5) {
    float g = 1.0 + aK.w;
    float cap = uMaxHalfFrac * uViewport.y * (aK.y > 0.5 ? 1.0 : 0.45);
    extA = min(max(aW.x * f * wa, uMinW * 0.5) * g, cap) + 2.0;
    extB = min(max(aW.x * f * wb, uMinW * 0.5), cap) + 2.0;
  } else {
    extA = max(aW.y * f * wa, uTeleMinPx * 0.5) + uTeleOutPx * 1.6 + 2.0;
    extB = max(aW.y * f * wb, uTeleMinPx * 0.5) + uTeleOutPx * 1.6 + 2.0;
  }
  float s = position.x;
  float e = mix(extA, extB, s);
  vec2 p = mix(pa - dir * extA, pb + dir * extB, s) + n * position.y * e;
  float z = mix(ca.z / ca.w, cb.z / cb.w, s);
  gl_Position = vec4(p / hv, z, 1.0);
  vAP = vec2(mix(-extA, L + extB, s), position.y * e);
  vLen = L;
  // 1/w and (param/w) are affine in screen space -> perspective-correct along-beam param
  float sEnd = mix(-extA / max(L, 1e-3), 1.0 + extB / max(L, 1e-3), s);
  vInvW = mix(wa, wb, sEnd);
  vSW = mix(sa * wa, sb * wb, sEnd);
  vLenW = length(aTo - aFrom);
}
`;

const FRAG = /* glsl */ `
uniform vec2 uViewport;
uniform float uMinW;
uniform float uCoreFrac;
uniform float uEdgeFrac;
uniform float uEdgeMinPx;
uniform float uHaloOcc;
uniform float uTeleMinPx;
uniform float uTeleOutPx;
uniform float uTeleOutA;
uniform vec2 uFlickHz;
uniform float uFlickDepth;
uniform float uFlowAmt;
uniform float uFlowSpeed;
uniform float uFlowPeriod;
uniform float uTime;
uniform vec3 uCore;
uniform vec3 uEdgeL, uEdgeB;
uniform vec3 uHaloL, uHaloB;
uniform vec3 uHaloDarkL, uHaloDarkB;
uniform vec3 uTeleL, uTeleB;
uniform vec3 uOutline;
varying vec2 vAP;
varying float vLen;
varying float vInvW;
varying float vSW;
varying float vLenW;
varying vec4 vW;
varying vec4 vK;
varying float vF;
void main() {
  float f = vF;
  float a = vAP.x;
  float dx = max(0.0, -a) + max(0.0, a - vLen);
  float d = length(vec2(dx, vAP.y));
  float boss = vK.y;
  float I = vW.z;
  vec3 rgb;
  float alpha;
  if (vK.x > 0.5) {
    float hp = max(vW.x * f * vInvW, uMinW * 0.5);
    float x = d / hp;
    float aa = 1.0 / hp;
    float cE = uCoreFrac;
    float ew = max(uEdgeFrac, uEdgeMinPx * aa);
    float core = 1.0 - smoothstep(cE - aa, cE + aa, x);
    float edge = (1.0 - smoothstep(cE + ew - aa, cE + ew + aa, x)) * (1.0 - core);
    float ht = clamp((x - cE) / max(1.0 - cE, 1e-3), 0.0, 1.0);
    float halo = (1.0 - smoothstep(0.55, 1.0, ht)) * (1.0 - core);
    float sW = vSW / max(vInvW, 1e-6) * vLenW;
    float flow = 1.0 + uFlowAmt * sin((sW / uFlowPeriod - uTime * uFlowSpeed / uFlowPeriod) * 6.2831853);
    vec3 hc = mix(mix(uHaloL, uHaloB, boss), mix(uHaloDarkL, uHaloDarkB, boss), smoothstep(0.1, 1.0, ht));
    vec3 ec = mix(uEdgeL, uEdgeB, boss);
    // emitter flare during the start flash
    float fl = vK.w * exp(-pow(length(vec2(a, vAP.y)) / (hp * (1.0 + vK.w)), 2.0) * 2.0);
    rgb = (uCore * core + ec * edge + hc * halo * flow) * I + uCore * fl * I;
    alpha = clamp(core + edge + halo * uHaloOcc + fl * 0.5, 0.0, 1.0);
  } else {
    float lp = max(vW.y * f * vInvW, uTeleMinPx * 0.5);
    float line = 1.0 - smoothstep(lp - 0.6, lp + 0.6, d);
    float op = uTeleOutPx * (1.0 + 0.6 * boss);
    float outer = 1.0 - smoothstep(lp + op - 0.6, lp + op + 0.6, d);
    float hz = mix(uFlickHz.x, uFlickHz.y, vK.z);
    float fk = 1.0 - uFlickDepth * step(0.5, fract(uTime * hz));
    vec3 tc = mix(uTeleL, uTeleB, boss) * I * fk;
    rgb = tc * line + uOutline * (outer - line) * uTeleOutA;
    alpha = line + (outer - line) * uTeleOutA;
  }
  gl_FragColor = vec4(rgb * vW.w, alpha * vW.w);
}
`;

interface BeamSlot {
  id: number | string;
  active: boolean;
  kind: BeamKind;
  state: BeamState;
  prev: BeamState;
  t01: number;
  age: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
}

export class Beams {
  readonly group = new THREE.Object3D();
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  params: BeamParams;
  private slots: BeamSlot[] = [];
  private byId = new Map<number | string, number>();
  private aFrom: THREE.InstancedBufferAttribute;
  private aTo: THREE.InstancedBufferAttribute;
  private aW: THREE.InstancedBufferAttribute;
  private aK: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private time = 0;

  constructor(params: BeamParams = BEAM_VARIANTS.A, capacity = 48) {
    this.params = params;
    this.capacity = capacity;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aFrom = mk(3);
    this.aTo = mk(3);
    this.aW = mk(4);
    this.aK = mk(4);
    geo.setAttribute('aFrom', this.aFrom);
    geo.setAttribute('aTo', this.aTo);
    geo.setAttribute('aW', this.aW);
    geo.setAttribute('aK', this.aK);
    geo.instanceCount = 0;
    this.geo = geo;
    const red = palette.laserRed;
    const yel = palette.burstYellow;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        uViewport: { value: new THREE.Vector2(1920, 1080) },
        uMinW: { value: 9 },
        uCoreFrac: { value: 0.62 },
        uEdgeFrac: { value: 0.03 },
        uEdgeMinPx: { value: 1.4 },
        uHaloOcc: { value: 0.55 },
        uTeleMinPx: { value: 2.2 },
        uTeleOutPx: { value: 1.6 },
        uMaxHalfFrac: { value: 0.045 },
        uTeleOutA: { value: 0.75 },
        uFlickHz: { value: new THREE.Vector2(7, 18) },
        uFlickDepth: { value: 0.55 },
        uFlowAmt: { value: 0.18 },
        uFlowSpeed: { value: 40 },
        uFlowPeriod: { value: 6 },
        uTime: { value: 0 },
        uCore: { value: tvec(bt.core) },
        uEdgeL: { value: tvec(yel) },
        uEdgeB: { value: tvec(palette.exhaustCore) },
        uHaloL: { value: tvec(bt.haloEnemy) },
        uHaloB: { value: tvec(bt.haloBoss) },
        uHaloDarkL: { value: tvec(shade(red, 0.5)) },
        uHaloDarkB: { value: tvec(palette.fireOrange) },
        uTeleL: { value: tvec(mix(red, palette.burstWhite, 0.18)) },
        uTeleB: { value: tvec(mix(yel, palette.fireOrange, 0.3)) },
        uOutline: { value: tvec(palette.hostileOutline) },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    const v = new THREE.Vector4();
    this.mesh.onBeforeRender = (renderer) => {
      renderer.getCurrentViewport(v);
      (this.mat.uniforms.uViewport.value as THREE.Vector2).set(v.z, v.w);
    };
    this.group.add(this.mesh);
    for (let i = 0; i < capacity; i++)
      this.slots.push({ id: -1, active: false, kind: 'laser', state: 'off', prev: 'off', t01: 0, age: 1e9, from: new THREE.Vector3(), to: new THREE.Vector3() });
    this.applyParams();
  }

  applyParams(): void {
    const p = this.params;
    const u = this.mat.uniforms;
    u.uMinW.value = p.minWidthPx;
    u.uCoreFrac.value = p.coreFrac;
    u.uEdgeFrac.value = p.edgeFrac;
    u.uEdgeMinPx.value = p.edgeMinPx;
    u.uHaloOcc.value = p.haloOcclusion;
    u.uTeleMinPx.value = p.telegraphMinPx;
    u.uTeleOutPx.value = p.telegraphOutlinePx;
    u.uTeleOutA.value = p.telegraphOutlineAlpha;
    (u.uFlickHz.value as THREE.Vector2).set(p.flickerHz[0], p.flickerHz[1]);
    u.uFlickDepth.value = p.flickerDepth;
    u.uFlowAmt.value = p.flowAmount;
    u.uFlowSpeed.value = p.flowSpeed;
    u.uFlowPeriod.value = p.flowPeriod;
    // the per-instance intensity (aW.z) scales the core; edge/halo are expressed relative to it
    (u.uCore.value as THREE.Vector3).copy(tvec(bt.core));
    (u.uEdgeL.value as THREE.Vector3).copy(tvec(mix(palette.burstYellow, palette.fireOrange, 0.4), p.edgeIntensity / p.coreIntensity));
    (u.uEdgeB.value as THREE.Vector3).copy(tvec(palette.exhaustCore, p.edgeIntensity / p.coreIntensity));
    (u.uHaloL.value as THREE.Vector3).copy(tvec(bt.haloEnemy, p.haloIntensity / p.coreIntensity));
    (u.uHaloB.value as THREE.Vector3).copy(tvec(bt.haloBoss, p.haloIntensity / p.coreIntensity));
    (u.uHaloDarkL.value as THREE.Vector3).copy(tvec(shade(palette.laserRed, 0.5), p.haloIntensity / p.coreIntensity));
    (u.uHaloDarkB.value as THREE.Vector3).copy(tvec(palette.fireOrange, p.haloIntensity / p.coreIntensity));
  }

  /** Register (or re-target) a beam. It starts 'off' until setState. */
  add(id: number | string, from: THREE.Vector3, to: THREE.Vector3, kind: BeamKind): void {
    let i = this.byId.get(id);
    if (i === undefined) {
      i = this.slots.findIndex((s) => !s.active);
      if (i < 0) return; // pool full
      this.byId.set(id, i);
      const s = this.slots[i];
      s.active = true;
      s.state = 'off';
      s.prev = 'off';
      s.age = 1e9;
      s.t01 = 0;
    }
    const s = this.slots[i];
    s.id = id;
    s.kind = kind;
    s.from.copy(from);
    s.to.copy(to);
  }

  setEndpoints(id: number | string, from: THREE.Vector3, to: THREE.Vector3): void {
    const i = this.byId.get(id);
    if (i === undefined) return;
    this.slots[i].from.copy(from);
    this.slots[i].to.copy(to);
  }

  /** Change state (resets the state clock on a change) and set its progress t01. */
  setState(id: number | string, state: BeamState, t01: number): void {
    const i = this.byId.get(id);
    if (i === undefined) return;
    const s = this.slots[i];
    if (s.state !== state) {
      s.prev = s.state;
      s.state = state;
      s.age = 0;
    }
    s.t01 = Math.min(1, Math.max(0, t01));
  }

  remove(id: number | string): void {
    const i = this.byId.get(id);
    if (i === undefined) return;
    this.slots[i].active = false;
    this.byId.delete(id);
  }

  has(id: number | string): boolean {
    return this.byId.has(id);
  }

  clear(): void {
    for (const s of this.slots) s.active = false;
    this.byId.clear();
    this.geo.instanceCount = 0;
  }

  update(dt: number, _camera?: THREE.Camera): void {
    const p = this.params;
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    const F = this.aFrom.array as Float32Array;
    const T = this.aTo.array as Float32Array;
    const W = this.aW.array as Float32Array;
    const K = this.aK.array as Float32Array;
    let top = 0;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[i];
      if (s.active) s.age += dt;
      let alpha = 0;
      let mode = 0;
      let half = 0;
      let inten = 1;
      let flare = 0;
      let ext = 1;
      const kScale = s.kind === 'boss' ? p.bossScale : 1;
      if (s.active) {
        if (s.state === 'telegraph') {
          mode = 0;
          alpha = Math.min(1, s.age / 0.05);
          inten = p.telegraphIntensity * (0.75 + 0.25 * s.t01);
        } else if (s.state === 'fire') {
          mode = 1;
          alpha = 1;
          const fl = Math.max(0, 1 - s.age / p.flashS);
          const taper = 1 - 0.6 * smooth((s.t01 - 0.85) / 0.15);
          half = p.width * 0.5 * kScale * (1 + (p.flashScale - 1) * fl * fl) * taper;
          inten = p.coreIntensity * (1 + p.flashBoost * fl) * (0.6 + 0.4 * taper);
          flare = p.flare * fl;
          ext = easeOut(Math.min(1, s.age / p.extendS));
        } else if (s.prev === 'fire' && s.age < p.fadeS) {
          mode = 1;
          const k = s.age / p.fadeS;
          alpha = 1 - smooth(k);
          half = p.width * 0.5 * kScale * 0.4 * (1 - 0.5 * k);
          inten = p.coreIntensity * 0.8;
        } else if (s.prev === 'telegraph' && s.age < 0.05) {
          mode = 0;
          alpha = 1 - s.age / 0.05;
          inten = p.telegraphIntensity;
        }
      }
      if (alpha <= 0) {
        W[i * 4 + 3] = 0;
        continue;
      }
      F[i * 3] = s.from.x;
      F[i * 3 + 1] = s.from.y;
      F[i * 3 + 2] = s.from.z;
      T[i * 3] = s.from.x + (s.to.x - s.from.x) * ext;
      T[i * 3 + 1] = s.from.y + (s.to.y - s.from.y) * ext;
      T[i * 3 + 2] = s.from.z + (s.to.z - s.from.z) * ext;
      W[i * 4] = half;
      W[i * 4 + 1] = p.telegraphWidth * 0.5 * (s.kind === 'boss' ? 1.5 : 1);
      W[i * 4 + 2] = inten;
      W[i * 4 + 3] = alpha;
      K[i * 4] = mode;
      K[i * 4 + 1] = s.kind === 'boss' ? 1 : 0;
      K[i * 4 + 2] = s.t01;
      K[i * 4 + 3] = flare;
      top = i + 1;
    }
    this.geo.instanceCount = top;
    this.aFrom.needsUpdate = true;
    this.aTo.needsUpdate = true;
    this.aW.needsUpdate = true;
    this.aK.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

function smooth(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

function easeOut(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}
