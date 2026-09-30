/**
 * Look-Dev backdrop for VFX lane B boards only (NOT a game module; the world lane owns the
 * real sky and clouds). Token-driven sky dome (stage gradient + sun/planet disc + sparse stars)
 * and optional lit cloud puffs, so smoke/explosions are judged over dark space and bright sky.
 */
import * as THREE from 'three';
import { stages, palette, type StageId } from '../../style/tokens';
import { tvec } from '../../style/color';
import { Rng } from '../../core/rng';
import { ParticleBatch, linearRGB } from './particles';

export class LabBackdrop {
  readonly group = new THREE.Group();
  readonly sky: THREE.Mesh;
  readonly clouds: ParticleBatch | null;
  private readonly cloudData: Float32Array;
  private readonly nClouds: number;

  constructor(stage: StageId, opts: { clouds?: number; seed?: number; cloudY?: number; cloudZ?: [number, number] } = {}) {
    const look = stages[stage];
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uZen: { value: tvec(look.sky.zenith) },
        uMid: { value: tvec(look.sky.mid) },
        uHor: { value: tvec(look.sky.horizon) },
        uMidH: { value: look.sky.midHeight },
        uSun: { value: tvec(look.sky.sunColor, 1.5) },
        uSunDir: { value: new THREE.Vector3(...look.key.dir).normalize() },
        uSunSize: { value: look.sky.sunSize },
        uSunGlow: { value: look.sky.sunGlow },
        uStars: { value: stage === 'wreckfield' ? 1 : 0 },
        uNebula: { value: tvec(palette.spaceNebula) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZen, uMid, uHor, uSun, uSunDir, uNebula;
        uniform float uMidH, uSunSize, uSunGlow, uStars;
        varying vec3 vDir;
        float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -1.0, 1.0);
          float u = clamp(h, 0.0, 1.0);
          vec3 c = u < uMidH ? mix(uHor, uMid, smoothstep(0.0, uMidH, u)) : mix(uMid, uZen, smoothstep(uMidH, 1.0, u));
          if (h < 0.0) c = mix(uHor, uMid * 0.8, smoothstep(0.0, -0.6, h));
          float sd = acos(clamp(dot(d, normalize(uSunDir)), -1.0, 1.0));
          c += uSun * (1.0 - smoothstep(uSunSize * 0.9, uSunSize, sd));
          c += uSun * uSunGlow * 0.35 * exp(-sd * 3.0);
          if (uStars > 0.5) {
            float neb = smoothstep(0.35, 0.0, abs(d.y - 0.15 + 0.2 * sin(d.x * 2.0)));
            c += uNebula * neb * 0.35;
            vec3 g = floor(d * 260.0);
            float s = hash(g);
            c += vec3(step(0.9965, s) * (0.4 + 0.6 * hash(g + 3.1)));
          }
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 48, 24), mat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.group.add(this.sky);

    this.nClouds = opts.clouds ?? 0;
    this.clouds = null;
    this.cloudData = new Float32Array(0);
    if (this.nClouds > 0) {
      const cb = new ParticleBatch(this.nClouds, {
        sort: true,
        name: 'lab-clouds',
        renderOrder: -5,
        look: { normalStrength: 0.9, stylize: 0.5, term: 0.45, soft: 0.25, keyTint: 0.25, ambTint: 0.5, backlight: 0.3, rim: 0.05, edgeDarken: 0.0, nearFade: [5, 30] },
      });
      this.clouds = cb;
      this.group.add(cb.mesh);
      const r = new Rng(opts.seed ?? 5);
      const lit = linearRGB(palette.cloudCream), shd = linearRGB(palette.cloudShadow);
      this.cloudData = new Float32Array(this.nClouds * 20);
      const y0 = opts.cloudY ?? -55;
      const [zn, zf] = opts.cloudZ ?? [-80, -700];
      for (let i = 0; i < this.nClouds; i++) {
        const o = i * 20;
        const tower = i % 5 === 0;
        const z = r.range(zf, zn);
        const x = r.range(-1, 1) * (120 + -z * 0.9);
        const y = y0 + (tower ? r.range(10, 60) : r.range(-6, 10));
        const w = tower ? r.range(50, 90) : r.range(35, 80);
        const d = this.cloudData;
        d.set([x, y, z, w, lit[0], lit[1], lit[2], 1, shd[0], shd[1], shd[2], 1, 0, 0, 0, 1, r.range(0, 6.28), r.int(0, 3), 1, 0], o);
      }
    }
  }

  /** Keep the dome on the camera and upload clouds (sorted for this camera). */
  prepare(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.sky.position.setFromMatrixPosition(camera.matrixWorld);
    if (this.clouds) {
      const b = this.clouds;
      b.begin();
      for (let i = 0; i < this.nClouds; i++) {
        const o = b.alloc();
        for (let f = 0; f < 20; f++) b.data[o + f] = this.cloudData[i * 20 + f];
      }
      b.finish(camera);
    }
  }
}
