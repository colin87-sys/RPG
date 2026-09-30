/**
 * ShockRings (VFX lane A): thin camera-facing ellipses with RGB-split (rainbow)
 * edges. Pooled: one instanced annulus-strip mesh, one draw call for all live
 * rings, zero allocation per spawn. The strip only covers the band (plus glow
 * margin), so a ring filling 65% of the screen costs almost no overdraw.
 *
 * Blending is premultiplied "additive with partial occlusion": emission adds
 * light (glows on dark space), a small alpha replaces some background so the
 * red/green/blue bands keep their hue over near-white cloud (m4 reference).
 *
 * Numbers: thickness 3% of radius, RGB offset 0.4-0.8% of radius, grows over
 * the spawn duration (0.7-1.3 s) with an ease-out, fades over the last 30%.
 */
import * as THREE from 'three';
import { palette, vfx } from '../../style/tokens';
import { tvec } from '../../style/color';

export interface RingParams {
  /** ellipse width / height on screen (1 = circle) */
  aspect: number;
  /** thickness of ONE colour band / radius (REF_VERIFICATION: 3 bands total ~13% of radius) */
  thicknessFrac: number;
  /** centre-to-centre spacing of the colour bands / radius (REF_VERIFICATION: ~5%) */
  rgbOffsetFrac: number;
  /** radius at birth as a fraction of the final radius (ring pops, then keeps growing) */
  startScale: number;
  minThicknessPx: number;
  minOffsetPx: number;
  /** HDR brightness of the band */
  intensity: number;
  /** 0 = pure additive; >0 replaces some background (keeps hue on bright sky) */
  occlusion: number;
  /** ease-out exponent of radius growth */
  growPower: number;
  /** fraction of the life spent fading (token 0.3) */
  fadeTailFrac: number;
  /** strength of an inner echo ring (0 = none) and its radius scale */
  echo: number;
  echoScale: number;
  /** 0 = 3 separated bands red(inner)/green/blue(outer); 1 = 5-band spectral red->yellow->green->cyan->blue */
  spectral: number;
  /** soft glow around the band */
  glow: number;
  /** 0 = uniform band width, 1 = thinner at top/bottom like a tilted disc */
  foreshorten: number;
  /** 1 = minor axis follows projected world-up (ellipse tilts with camera roll) */
  tiltToWorld: number;
}

const tok = vfx.shockRing;

export const RING_VARIANTS: Record<'A' | 'B' | 'C', RingParams> = {
  /** A: three separated bands (~13% of radius), pops at 45% then grows */
  A: {
    aspect: 1.75,
    thicknessFrac: 0.042,
    rgbOffsetFrac: 0.046,
    startScale: 0.45,
    minThicknessPx: 3,
    minOffsetPx: 3.5,
    intensity: 1.7,
    occlusion: 0.55,
    growPower: 2.4,
    fadeTailFrac: tok.fadeTailFrac,
    echo: 0,
    echoScale: 0.9,
    spectral: 0,
    glow: 0.18,
    foreshorten: 0.35,
    tiltToWorld: 1,
  },
  /** B: slightly slimmer bands, pops at 60%, faint inner echo ring (double-ring read) */
  B: {
    aspect: 1.65,
    thicknessFrac: 0.036,
    rgbOffsetFrac: 0.04,
    startScale: 0.6,
    minThicknessPx: 3,
    minOffsetPx: 3,
    intensity: 1.8,
    occlusion: 0.45,
    growPower: 2.0,
    fadeTailFrac: tok.fadeTailFrac,
    echo: 0.45,
    echoScale: 0.9,
    spectral: 0,
    glow: 0.14,
    foreshorten: 0.2,
    tiltToWorld: 1,
  },
  /** C: 5-band spectral rainbow (~15% of radius), widest growth */
  C: {
    aspect: 1.85,
    thicknessFrac: 0.03,
    rgbOffsetFrac: 0.03,
    startScale: 0.3,
    minThicknessPx: 3,
    minOffsetPx: 3,
    intensity: 1.6,
    occlusion: 0.6,
    growPower: 3.0,
    fadeTailFrac: tok.fadeTailFrac,
    echo: 0,
    echoScale: 0.9,
    spectral: 1,
    glow: 0.2,
    foreshorten: 0.5,
    tiltToWorld: 1,
  },
};

export interface RingSpawnOpts {
  /** major-axis radius in metres at the end of the growth */
  maxRadius: number;
  /** seconds (design range 0.7-1.3) */
  duration: number;
  /** thickness of one colour band as a fraction of radius (default params.thicknessFrac) */
  thickness?: number;
}

const SEGMENTS = 96;

const VERT = /* glsl */ `
attribute vec2 aRing;       // x: angle 0..2pi, y: side -1..1
attribute vec3 aCenter;
attribute vec4 aData;       // radius (m), half band (m), alpha, echo radius scale
uniform vec2 uUpView;
uniform float uAspect;
uniform float uMarginK;
uniform float uOffFracV;
varying vec2 vLocal;
varying vec4 vData;
void main() {
  vData = aData;
  if (aData.z <= 0.0 || aData.x <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float Rx = aData.x, Ry = aData.x / uAspect;
  float c = cos(aRing.x), s = sin(aRing.x);
  vec2 n = normalize(vec2(c / Rx, s / Ry));
  float margin = aData.y * uMarginK + 2.0 * uOffFracV * aData.x + 0.03 * aData.x;
  // strip spans from the echo ring (inside) to the main ring (outside)
  float innerScale = min(aData.w, 1.0);
  vec2 pOut = vec2(Rx * c, Ry * s) + n * margin;
  vec2 pIn = vec2(Rx * c, Ry * s) * innerScale - n * margin;
  vec2 lp = aRing.y > 0.0 ? pOut : pIn;
  vLocal = lp;
  vec2 up = uUpView;
  vec2 right = vec2(up.y, -up.x);
  vec4 cv = modelViewMatrix * vec4(aCenter, 1.0);
  cv.xy += right * lp.x + up * lp.y;
  gl_Position = projectionMatrix * cv;
}
`;

const FRAG = /* glsl */ `
uniform float uAspect;
uniform float uOffFrac;
uniform float uMinThickPx;
uniform float uMinOffPx;
uniform float uIntensity;
uniform float uOcclusion;
uniform float uEcho;
uniform float uGlow;
uniform float uFore;
uniform vec3 uColor;
uniform vec3 uW0, uW1, uW2, uW3, uW4;
varying vec2 vLocal;
varying vec4 vData;

float band(float d, float halfT, float aa) { return 1.0 - smoothstep(halfT - aa, halfT + aa, abs(d)); }

vec4 ring(float R, float halfBand, float px) {
  float Rx = R, Ry = R / uAspect;
  vec2 q = vLocal / vec2(Rx, Ry);
  float ql = max(length(q), 1e-5);
  vec2 g = vec2(q.x / Rx, q.y / Ry) / ql;
  float dU = (ql - 1.0) / max(length(g), 1e-6);
  float dF = (ql - 1.0) * Rx;
  float d = mix(dU, dF, uFore);
  float halfT = max(halfBand, uMinThickPx * 0.5 * px);
  float off = max(uOffFrac * R, uMinOffPx * px);
  float aa = px * 0.8;
  vec3 col = uW0 * band(d + 2.0 * off, halfT, aa) + uW1 * band(d + off, halfT, aa) + uW2 * band(d, halfT, aa)
           + uW3 * band(d - off, halfT, aa) + uW4 * band(d - 2.0 * off, halfT, aa);
  float cover = max(max(col.r, col.g), col.b);
  float glow = exp(-abs(d) / (halfT * 0.9 + 1.5 * px)) * uGlow;
  return vec4(col + glow, cover);
}

void main() {
  float px = max(length(fwidth(vLocal)) * 0.7071, 1e-5);
  vec4 a = ring(vData.x, vData.y, px);
  if (uEcho > 0.0 && vData.w < 1.0) {
    vec4 b = ring(vData.x * vData.w, vData.y * 0.8, px);
    a += b * uEcho;
  }
  float alpha = vData.z;
  vec3 emit = uColor * a.rgb * uIntensity * alpha;
  gl_FragColor = vec4(emit, clamp(a.a * uOcclusion * alpha, 0.0, 1.0));
}
`;

interface Slot {
  alive: boolean;
  age: number;
  duration: number;
  maxR: number;
  thick: number;
  x: number;
  y: number;
  z: number;
}

export class ShockRings {
  readonly group = new THREE.Object3D();
  readonly capacity: number;
  params: RingParams;
  readonly mesh: THREE.Mesh;
  private slots: Slot[] = [];
  private next = 0;
  private aCenter: THREE.InstancedBufferAttribute;
  private aData: THREE.InstancedBufferAttribute;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.InstancedBufferGeometry;
  private upW = new THREE.Vector3();
  private strongest = 0;

  constructor(params: RingParams = RING_VARIANTS.A, capacity = 16) {
    this.params = params;
    this.capacity = capacity;
    const geo = new THREE.InstancedBufferGeometry();
    const ring: number[] = [];
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      ring.push(a, -1, a, 1);
      pos.push(0, 0, 0, 0, 0, 0);
      if (i < SEGMENTS) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aRing', new THREE.Float32BufferAttribute(ring, 2));
    geo.setIndex(idx);
    this.aCenter = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aCenter.setUsage(THREE.DynamicDrawUsage);
    this.aData.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCenter', this.aCenter);
    geo.setAttribute('aData', this.aData);
    geo.instanceCount = 0;
    this.geo = geo;
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
        uUpView: { value: new THREE.Vector2(0, 1) },
        uAspect: { value: 1.7 },
        uMarginK: { value: 3 },
        uOffFracV: { value: 0.046 },
        uOffFrac: { value: 0.006 },
        uMinThickPx: { value: 3 },
        uMinOffPx: { value: 1.5 },
        uIntensity: { value: 1 },
        uOcclusion: { value: 0.4 },
        uEcho: { value: 0 },
        uGlow: { value: 0.2 },
        uFore: { value: 0 },
        uColor: { value: tvec(palette.burstWhite) },
        uW0: { value: new THREE.Vector3() },
        uW1: { value: new THREE.Vector3() },
        uW2: { value: new THREE.Vector3() },
        uW3: { value: new THREE.Vector3() },
        uW4: { value: new THREE.Vector3() },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
    this.group.add(this.mesh);
    for (let i = 0; i < capacity; i++) this.slots.push({ alive: false, age: 0, duration: 1, maxR: 1, thick: 0.04, x: 0, y: 0, z: 0 });
    this.applyParams();
  }

  /** Push params into uniforms (call after editing `params`). */
  applyParams(): void {
    const p = this.params;
    const u = this.mat.uniforms;
    u.uAspect.value = p.aspect;
    u.uOffFrac.value = p.rgbOffsetFrac;
    u.uOffFracV.value = p.rgbOffsetFrac;
    u.uMinThickPx.value = p.minThicknessPx;
    u.uMinOffPx.value = p.minOffsetPx;
    u.uIntensity.value = p.intensity;
    u.uOcclusion.value = p.occlusion;
    u.uEcho.value = p.echo;
    u.uGlow.value = p.glow;
    u.uFore.value = p.foreshorten;
    // channel weights per tap, W0 innermost .. W4 outermost (REF_VERIFICATION: red inside, blue outside)
    const s = p.spectral;
    const W = [
      [0.45 * s, 0, 0], // innermost: deep red (spectral only)
      [1 - 0.45 * s, 0.3 * s, 0], // red / orange-yellow
      [0, 1 - 0.6 * s, 0], // green
      [0, 0.3 * s, 1 - 0.55 * s], // blue / cyan
      [0.12 * s, 0, 0.55 * s], // outermost: blue-violet (spectral only)
    ];
    (u.uW0.value as THREE.Vector3).set(W[0][0], W[0][1], W[0][2]);
    (u.uW1.value as THREE.Vector3).set(W[1][0], W[1][1], W[1][2]);
    (u.uW2.value as THREE.Vector3).set(W[2][0], W[2][1], W[2][2]);
    (u.uW3.value as THREE.Vector3).set(W[3][0], W[3][1], W[3][2]);
    (u.uW4.value as THREE.Vector3).set(W[4][0], W[4][1], W[4][2]);
  }

  /** Spawn a ring (reuses the oldest slot when the pool is full). */
  spawn(pos: THREE.Vector3, opts: RingSpawnOpts): void {
    let i = -1;
    for (let k = 0; k < this.capacity; k++) {
      const j = (this.next + k) % this.capacity;
      if (!this.slots[j].alive) {
        i = j;
        break;
      }
    }
    if (i < 0) i = this.next;
    this.next = (i + 1) % this.capacity;
    const s = this.slots[i];
    s.alive = true;
    s.age = 0;
    s.duration = Math.max(0.05, opts.duration);
    s.maxR = opts.maxRadius;
    s.thick = opts.thickness ?? this.params.thicknessFrac;
    s.x = pos.x;
    s.y = pos.y;
    s.z = pos.z;
  }

  /** 0..1 envelope of the strongest live ring: drive PostFrame.chroma toward post.chroma.ring with it. */
  intensity(): number {
    return this.strongest;
  }

  get liveCount(): number {
    let n = 0;
    for (const s of this.slots) if (s.alive) n++;
    return n;
  }

  clear(): void {
    for (const s of this.slots) s.alive = false;
    this.geo.instanceCount = 0;
  }

  update(dt: number, camera: THREE.Camera): void {
    const p = this.params;
    // projected world-up in view space -> ellipse minor axis
    camera.updateMatrixWorld();
    this.upW.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
    const ux = this.upW.x * p.tiltToWorld;
    const uy = this.upW.y * p.tiltToWorld + (1 - p.tiltToWorld);
    const ul = Math.hypot(ux, uy) || 1;
    (this.mat.uniforms.uUpView.value as THREE.Vector2).set(ux / ul, uy / ul);
    const c = this.aCenter.array as Float32Array;
    const d = this.aData.array as Float32Array;
    let top = 0;
    this.strongest = 0;
    const fadeStart = 1 - p.fadeTailFrac;
    for (let i = 0; i < this.capacity; i++) {
      const s = this.slots[i];
      if (s.alive) {
        s.age += dt;
        if (s.age >= s.duration) s.alive = false;
      }
      if (!s.alive) {
        d[i * 4 + 2] = 0;
        continue;
      }
      const t = Math.min(1, s.age / s.duration);
      const grow = p.startScale + (1 - p.startScale) * (1 - Math.pow(1 - t, p.growPower));
      const R = Math.max(1e-3, s.maxR * grow);
      const f = t <= fadeStart ? 1 : 1 - smooth((t - fadeStart) / Math.max(1e-3, p.fadeTailFrac));
      const born = 1 + 0.6 * Math.max(0, 1 - t / 0.08); // brief birth flash
      const thin = 1 - 0.35 * (1 - f); // thins as it fades
      c[i * 3] = s.x;
      c[i * 3 + 1] = s.y;
      c[i * 3 + 2] = s.z;
      d[i * 4] = R;
      d[i * 4 + 1] = R * s.thick * 0.5 * thin;
      d[i * 4 + 2] = f * born;
      d[i * 4 + 3] = p.echo > 0 ? p.echoScale : 1;
      this.strongest = Math.max(this.strongest, f * (1 - 0.5 * t));
      top = i + 1;
    }
    this.geo.instanceCount = top;
    this.aCenter.needsUpdate = true;
    this.aData.needsUpdate = true;
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
