/**
 * Wingtip vapour trails (the game's namesake contrails): one camera-facing
 * ribbon per wingtip, sampled in world space every rendered frame, so hard
 * turns draw visible arcs behind the craft. Intensity follows lateral speed,
 * bank and boost (manoeuvres read as bright streaks; cruise is a faint thread).
 *
 * CPU-built strip (2 ribbons x MAX points x 2 verts), one draw call, no
 * per-frame allocation. Colours come from tokens via setLook().
 */
import * as THREE from 'three';
import { mix, tvec } from '../../style/color';
import { palette } from '../../style/tokens';

const MAX = 56; // points per ribbon

interface Ribbon {
  px: Float32Array; py: Float32Array; pz: Float32Array;
  age: Float32Array; k: Float32Array;
  head: number; count: number;
}

export interface WingVapourLook {
  color: string;
  /** shadow side of the ribbon (two-tone so white vapour reads over white cloud) */
  shadow: string;
  /** seconds a point lives */
  life: number;
  /** ribbon half-width at the tip and at the tail (m) */
  width: [number, number];
  /** alpha at intensity 1 */
  opacity: number;
  /** alpha floor while cruising (intensity 0) */
  cruise: number;
}

export class WingVapour {
  readonly mesh: THREE.Mesh;
  private readonly ribbons: Ribbon[];
  private readonly pos: Float32Array;
  private readonly attr: Float32Array; // along, across, alpha
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private look: WingVapourLook;
  private readonly tmp = new THREE.Vector3();
  private readonly tan = new THREE.Vector3();
  private readonly side = new THREE.Vector3();

  constructor(look: WingVapourLook) {
    this.look = look;
    this.ribbons = [0, 1].map(() => ({
      px: new Float32Array(MAX), py: new Float32Array(MAX), pz: new Float32Array(MAX),
      age: new Float32Array(MAX), k: new Float32Array(MAX), head: 0, count: 0,
    }));
    const nv = 2 * MAX * 2;
    this.pos = new Float32Array(nv * 3);
    this.attr = new Float32Array(nv * 3);
    const idx: number[] = [];
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < MAX - 1; i++) {
        const a = (r * MAX + i) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aV', new THREE.BufferAttribute(this.attr, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: tvec(look.color) }, uShadow: { value: tvec(look.shadow) }, uOpacity: { value: look.opacity } },
      vertexShader: /* glsl */ `
        attribute vec3 aV;
        varying vec3 vV;
        void main() {
          vV = aV;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor, uShadow;
        uniform float uOpacity;
        varying vec3 vV; // along 0 (tip) .. 1 (tail), across -1..1, alpha
        void main() {
          float edge = 1.0 - vV.y * vV.y;
          float a = vV.z * edge * edge * uOpacity * smoothstep(0.0, 0.06, vV.x);
          if (a < 0.003) discard;
          vec3 c = mix(uShadow, uColor, smoothstep(-0.6, 0.5, vV.y));
          gl_FragColor = vec4(c * (1.0 + 0.3 * (1.0 - vV.x)), a);
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'wingVapour';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  setLook(look: WingVapourLook): void {
    this.look = look;
    (this.mat.uniforms.uColor.value as THREE.Vector3).copy(tvec(look.color));
    (this.mat.uniforms.uShadow.value as THREE.Vector3).copy(tvec(look.shadow));
    this.mat.uniforms.uOpacity.value = look.opacity;
  }

  clear(): void {
    for (const r of this.ribbons) { r.count = 0; r.head = 0; }
  }

  /**
   * Age points by dt, then append the current wingtip world positions with
   * intensity k (0 cruise .. 1 hard manoeuvre). Rebuilds the strip for `camera`.
   */
  update(dt: number, tips: [THREE.Vector3, THREE.Vector3] | null, k: number, camera: THREE.Camera): void {
    const L = this.look;
    for (let ri = 0; ri < 2; ri++) {
      const r = this.ribbons[ri];
      for (let i = 0; i < r.count; i++) r.age[(r.head - 1 - i + MAX) % MAX] += dt;
      while (r.count > 0 && r.age[(r.head - r.count + MAX) % MAX] > L.life) r.count--;
      if (tips && dt > 0) {
        const t = tips[ri];
        r.px[r.head] = t.x; r.py[r.head] = t.y; r.pz[r.head] = t.z;
        r.age[r.head] = 0; r.k[r.head] = k;
        r.head = (r.head + 1) % MAX;
        r.count = Math.min(MAX, r.count + 1);
      }
    }
    this.rebuild(camera);
  }

  private rebuild(camera: THREE.Camera): void {
    const L = this.look;
    const cam = camera.position;
    let o = 0;
    for (let ri = 0; ri < 2; ri++) {
      const r = this.ribbons[ri];
      for (let j = 0; j < MAX; j++) {
        // j = 0 newest point
        const valid = j < r.count;
        const a = (r.head - 1 - Math.min(j, Math.max(r.count - 1, 0)) + MAX) % MAX;
        const jp = Math.max(0, j - 1), jn = Math.min(r.count - 1, j + 1);
        const ip = (r.head - 1 - jp + MAX) % MAX, inn = (r.head - 1 - Math.max(jn, 0) + MAX) % MAX;
        this.tan.set(r.px[ip] - r.px[inn], r.py[ip] - r.py[inn], r.pz[ip] - r.pz[inn]);
        this.tmp.set(r.px[a] - cam.x, r.py[a] - cam.y, r.pz[a] - cam.z);
        this.side.crossVectors(this.tan, this.tmp);
        const sl = this.side.length();
        const along = valid ? Math.min(1, r.age[a] / L.life) : 1;
        const w = L.width[0] + (L.width[1] - L.width[0]) * Math.sqrt(along);
        if (sl > 1e-6) this.side.multiplyScalar(w / sl); else this.side.set(0, 0, 0);
        const kk = r.k[a];
        const alpha = valid ? (L.cruise + (1 - L.cruise) * kk) * Math.pow(1 - along, 1.6) : 0;
        for (let s = -1; s <= 1; s += 2) {
          this.pos[o * 3] = r.px[a] + this.side.x * s;
          this.pos[o * 3 + 1] = r.py[a] + this.side.y * s;
          this.pos[o * 3 + 2] = r.pz[a] + this.side.z * s;
          this.attr[o * 3] = along;
          this.attr[o * 3 + 1] = s;
          this.attr[o * 3 + 2] = alpha;
          o++;
        }
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    (this.geo.attributes.aV as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Per-stage looks: white vapour by day, sun-warmed at sunset, faint cyan ion wake in space. */
export const WING_VAPOUR_LOOKS: Record<'cloudgate' | 'violetTide' | 'wreckfield', WingVapourLook> = {
  cloudgate: { color: mix(palette.smokeLit, palette.hitFlash, 0.4), shadow: mix(palette.cloudShadow, palette.skyZenith, 0.25), life: 0.7, width: [0.07, 0.6], opacity: 0.95, cruise: 0.32 },
  violetTide: { color: mix(palette.sunCore, palette.sunsetHorizon, 0.3), shadow: mix(palette.sunsetMagenta, palette.sunsetIndigo, 0.4), life: 0.7, width: [0.07, 0.6], opacity: 0.9, cruise: 0.32 },
  wreckfield: { color: mix(palette.playerShotHalo, palette.playerShotCore, 0.4), shadow: palette.playerShotHalo, life: 0.4, width: [0.05, 0.3], opacity: 0.55, cruise: 0.1 },
};
