/**
 * Engine exhaust: per port an inner core cone (exhaustCore), an outer flame cone
 * (accentOrange) and a camera-facing glow disc, all in ONE additive draw call.
 * Shape is built in the vertex shader from per-port uniforms, so update() only
 * writes numbers (no allocation). Length/heat follow throttle through a critically
 * damped spring; flicker is seeded multi-sine noise; boost adds shock diamonds;
 * drift stretches a long hot plume.
 */
import * as THREE from 'three';
import { GLSL_LIGHTING, lightUniforms } from '../common/lighting';
import { palette } from '../../style/tokens';
import { tvec } from '../../style/color';
import { Rng } from '../../core/rng';

export interface ExhaustParams {
  /** flame length in metres at throttle 1 */
  length: number;
  /** flame base radius (m) */
  radius: number;
  boostStretch: number;
  driftStretch: number;
  /** flicker amplitude 0..1 */
  flicker: number;
  /** glow disc strength */
  glow: number;
}

export const DEFAULT_EXHAUST: ExhaustParams = { length: 2.6, radius: 0.3, boostStretch: 1.7, driftStretch: 2.6, flicker: 0.5, glow: 1 };

export interface ExhaustState {
  time: number;
  throttle: number;
  boost: boolean;
  drift: boolean;
}

export interface Exhaust {
  mesh: THREE.Mesh;
  triangles: number;
  update(dt: number, s: ExhaustState): void;
  /** jump springs to the state (menus, boards) */
  snap(s: ExhaustState): void;
  dispose(): void;
}

const MAX_PORTS = 4;
const SEG = 12;
const RINGS = 7;

const VERT = /* glsl */ `
attribute vec4 aFlame;
attribute float aPort;
uniform vec3 uPort[${MAX_PORTS}];
uniform vec4 uFlame[${MAX_PORTS}];
uniform float uTime;
uniform float uBoost;
varying float vT;
varying float vLayer;
varying float vHeat;
varying vec3 vN;
varying vec3 vWorldPos;
varying vec2 vQuad;
void main() {
  int i = int(aPort + 0.5);
  vec3 base = uPort[i];
  vec4 F = uFlame[i];
  float t = aFlame.z;
  float layer = aFlame.w;
  vT = t; vLayer = layer; vHeat = F.w; vQuad = aFlame.xy;
  if (layer < 1.5) {
    float core = 1.0 - step(0.5, layer);
    float len = F.x * mix(1.0, 0.5, core);
    float r0 = F.y * mix(1.0, 0.6, core);
    float prof = pow(1.0 - t, 0.8) * (1.0 + 0.3 * sin(t * 3.14159));
    float wob = 1.0 + F.z * (0.09 * sin(uTime * 41.0 + t * 11.0 + aPort * 2.3) + 0.06 * sin(uTime * 23.0 - t * 7.0));
    float r = r0 * prof * wob;
    vec3 local = vec3(aFlame.x * r, aFlame.y * r, -0.3 + t * len);
    vN = normalize(mat3(modelMatrix) * vec3(aFlame.x, aFlame.y, 0.3));
    vec4 wp = modelMatrix * vec4(base + local, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  } else {
    vec4 wc = modelMatrix * vec4(base + vec3(0.0, 0.0, 0.08), 1.0);
    vec4 vc = viewMatrix * wc;
    float size = F.y * 1.9 * (0.6 + 0.4 * F.w);
    vc.xy += aFlame.xy * size;
    vc.z += 0.15;
    vN = vec3(0.0, 0.0, 1.0);
    vWorldPos = wc.xyz;
    gl_Position = projectionMatrix * vc;
  }
}`;

const FRAG = /* glsl */ `
${GLSL_LIGHTING}
uniform vec3 uCore;
uniform vec3 uMid;
uniform float uBoost;
uniform float uGlowK;
varying float vT;
varying float vLayer;
varying float vHeat;
varying vec3 vN;
varying vec3 vWorldPos;
varying vec2 vQuad;
void main() {
  vec3 col;
  if (vLayer < 1.5) {
    vec3 V = normalize(cameraPosition - vWorldPos);
    float facing = abs(dot(normalize(vN), V));
    float along = 1.0 - vT;
    float core = 1.0 - step(0.5, vLayer);
    float shape = mix(0.35, 1.0, pow(facing, 1.4)) * smoothstep(0.0, 0.35, along) * smoothstep(0.0, 0.08, vT + 0.04);
    float diamonds = 1.0 + uBoost * 0.45 * smoothstep(0.3, 1.0, cos(vT * 26.0 - uTime * 30.0));
    vec3 c = mix(uMid, uCore, core * smoothstep(0.1, 0.8, along) + (1.0 - core) * 0.3 * along * along);
    col = c * shape * mix(0.4, 0.95, core) * (0.5 + 0.5 * vHeat) * diamonds;
  } else {
    float r2 = dot(vQuad, vQuad);
    float g = exp(-r2 * 4.5) * (1.0 - smoothstep(0.8, 1.0, r2));
    col = mix(uMid, uCore, exp(-r2 * 14.0)) * g * (0.25 + 0.4 * vHeat) * uGlowK;
  }
  // attenuate by the shared fog amount (applyFog of black -> fog colour * f)
  float f = clamp(length(applyFog(vec3(0.0), vWorldPos)) / max(length(uFogColor), 1e-3), 0.0, 1.0);
  col *= 1.0 - f;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

class Spring {
  x = 0;
  v = 0;
  constructor(public w: number) {}
  /** exact critically damped step (stable for any dt) */
  step(target: number, dt: number): number {
    const y0 = this.x - target;
    const e = Math.exp(-this.w * dt);
    const c = this.v + this.w * y0;
    this.x = target + (y0 + c * dt) * e;
    this.v = (this.v - this.w * c * dt) * e;
    return this.x;
  }
  set(x: number) {
    this.x = x;
    this.v = 0;
  }
}

export function buildExhaust(ports: THREE.Vector3[], params: Partial<ExhaustParams> = {}, seed = 1): Exhaust {
  const P: ExhaustParams = { ...DEFAULT_EXHAUST, ...params };
  const n = Math.min(ports.length, MAX_PORTS);
  const rng = new Rng(seed).fork('exhaust');
  const flame: number[] = [];
  const port: number[] = [];
  const index: number[] = [];
  let vbase = 0;
  for (let p = 0; p < n; p++) {
    for (let layer = 0; layer < 2; layer++) {
      for (let r = 0; r < RINGS; r++) {
        const t = r / (RINGS - 1);
        for (let s = 0; s <= SEG; s++) {
          const a = (s / SEG) * Math.PI * 2;
          flame.push(Math.cos(a), Math.sin(a), t, layer);
          port.push(p);
        }
      }
      for (let r = 0; r < RINGS - 1; r++)
        for (let s = 0; s < SEG; s++) {
          const a = vbase + r * (SEG + 1) + s;
          const b = a + SEG + 1;
          index.push(a, b, a + 1, a + 1, b, b + 1);
        }
      vbase += RINGS * (SEG + 1);
    }
    // glow quad
    for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      flame.push(x, y, 0, 2);
      port.push(p);
    }
    index.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
    vbase += 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(flame.length / 4 * 3), 3));
  geo.setAttribute('aFlame', new THREE.Float32BufferAttribute(flame, 4));
  geo.setAttribute('aPort', new THREE.Float32BufferAttribute(port, 1));
  geo.setIndex(index);

  const uPort = Array.from({ length: MAX_PORTS }, (_, i) => (ports[i] ? ports[i].clone() : new THREE.Vector3()));
  const uFlame = Array.from({ length: MAX_PORTS }, () => new THREE.Vector4(P.length, P.radius, P.flicker, 1));
  const mat = new THREE.ShaderMaterial({
    name: 'exhaust',
    uniforms: {
      ...lightUniforms,
      uPort: { value: uPort },
      uFlame: { value: uFlame },
      uBoost: { value: 0 },
      uGlowK: { value: P.glow },
      uCore: { value: tvec(palette.exhaustCore) },
      uMid: { value: tvec(palette.accentOrange) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.name = 'exhaust';

  const len = new Spring(12);
  const rad = new Spring(10);
  const heat = new Spring(9);
  const boostK = new Spring(8);
  const phases = Array.from({ length: MAX_PORTS }, () => [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)]);

  const tg = [0, 0, 0, 0];
  const targets = (s: ExhaustState) => {
    const th = Math.max(0, s.throttle);
    let L = P.length * (0.3 + 0.7 * th);
    let R = P.radius * (0.8 + 0.2 * Math.min(th, 1.6));
    let Hh = 0.45 + 0.55 * th;
    if (s.boost) { L *= P.boostStretch; Hh += 0.35; }
    if (s.drift) { L *= P.driftStretch; R *= 1.3; Hh += 0.2; }
    tg[0] = L; tg[1] = R; tg[2] = Hh; tg[3] = s.boost ? 1 : 0;
    return tg;
  };
  const apply = (time: number) => {
    for (let i = 0; i < n; i++) {
      const ph = phases[i];
      const fl = 1 + P.flicker * (0.07 * Math.sin(time * 31 + ph[0]) + 0.05 * Math.sin(time * 17.3 + ph[1]) + 0.04 * Math.sin(time * 53.1 + ph[2]));
      uFlame[i].set(len.x * fl, rad.x, P.flicker, heat.x * (0.94 + 0.06 * fl));
    }
    mat.uniforms.uBoost.value = boostK.x;
  };
  return {
    mesh,
    triangles: index.length / 3,
    update(dt, s) {
      const d = Math.min(Math.max(dt, 0), 0.1);
      const [L, R, Hh, B] = targets(s);
      len.step(L, d); rad.step(R, d); heat.step(Hh, d); boostK.step(B, d);
      apply(s.time);
    },
    snap(s) {
      const [L, R, Hh, B] = targets(s);
      len.set(L); rad.set(R); heat.set(Hh); boostK.set(B);
      apply(s.time);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

export { Spring as ExhaustSpring };
