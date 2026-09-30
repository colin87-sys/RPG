/**
 * LAB-ONLY helpers for VFX lane A boards: simple token backdrops (the real skies
 * belong to the world lane), the shared chase-camera rig, a dark craft
 * placeholder, lit test props and bright glow sprites. Not used by the game.
 */
import * as THREE from 'three';
import { palette, stages, type StageId } from '../../style/tokens';
import { tvec } from '../../style/color';
import { applyStageLook } from '../common/lighting';
import { toonMaterial } from '../common/materials';

/** Big inverted sphere with a token gradient: sky / sunset / space. */
export function makeBackdrop(stage: StageId): THREE.Mesh {
  const look = stages[stage];
  const mode = stage === 'cloudgate' ? 0 : stage === 'violetTide' ? 1 : 2;
  const sunDir = new THREE.Vector3(...look.key.dir).normalize();
  if (mode === 2) sunDir.set(0.55, 0.12, -0.83).normalize();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZen: { value: tvec(look.sky.zenith) },
      uMid: { value: tvec(look.sky.mid) },
      uHor: { value: tvec(look.sky.horizon) },
      uMidH: { value: look.sky.midHeight },
      uSun: { value: tvec(look.sky.sunColor) },
      uSunDir: { value: sunDir },
      uSunSize: { value: look.sky.sunSize },
      uGlow: { value: look.sky.sunGlow },
      uMode: { value: mode },
      uCloudLit: { value: tvec(palette.cloudCream) },
      uCloudMid: { value: tvec(palette.cloudMid) },
      uCloudShadow: { value: tvec(palette.cloudShadow) },
      uSea: { value: tvec(palette.cloudSea) },
      uSetDark: { value: tvec(palette.sunsetCloudDark) },
      uSetMag: { value: tvec(palette.sunsetMagenta) },
      uSetInd: { value: tvec(palette.sunsetIndigo) },
      uNeb: { value: tvec(palette.spaceNebula) },
      uStar: { value: tvec(palette.cloudCream) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uZen, uMid, uHor, uSun, uSunDir, uCloudLit, uCloudMid, uCloudShadow, uSea, uSetDark, uSetMag, uSetInd, uNeb, uStar;
      uniform float uMidH, uSunSize, uGlow, uMode;
      varying vec3 vDir;
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p *= 2.03; a *= 0.5; } return s; }
      void main() {
        vec3 d = normalize(vDir);
        float e = d.y;
        float up = clamp(e, 0.0, 1.0);
        vec3 c = up < uMidH ? mix(uHor, uMid, smoothstep(0.0, uMidH, up)) : mix(uMid, uZen, smoothstep(uMidH, 1.0, up));
        float sd = dot(d, normalize(uSunDir));
        float ang = acos(clamp(sd, -1.0, 1.0));
        float az = atan(d.x, -d.z);
        if (uMode < 0.5) {
          // Cloudgate: cream cumulus bank + cloud sea below the horizon
          vec2 q = vec2(az * 3.0, e * 9.0);
          float n = fbm(q + vec2(0.0, 0.0));
          float bank = smoothstep(0.18, 0.02, e) * smoothstep(0.42, 0.62, n + (0.12 - e) * 1.2);
          vec3 cl = mix(uCloudShadow, uCloudLit, smoothstep(0.35, 0.8, n));
          c = mix(c, cl, bank);
          float sea = smoothstep(0.0, -0.06, e);
          vec3 seaC = mix(uSea, uCloudMid, fbm(vec2(az * 6.0, e * 40.0)) * 0.6);
          c = mix(c, seaC, sea);
        } else if (uMode < 1.5) {
          // Violet Tide: hot narrow horizon, layered indigo cloud bands, magenta rims
          float band = exp(-abs(e) * 38.0);
          c = mix(c, uHor, band);
          float n = fbm(vec2(az * 2.5, e * 14.0));
          float layers = smoothstep(0.5, 0.7, n) * smoothstep(0.34, 0.06, e) * smoothstep(-0.02, 0.03, e);
          c = mix(c, mix(uSetDark, uSetMag, smoothstep(0.62, 0.8, n) * 0.5), layers * 0.85);
          float below = smoothstep(0.0, -0.08, e);
          c = mix(c, mix(uSetInd, uSetDark, fbm(vec2(az * 5.0, e * 30.0))), below);
        } else {
          // Wreckfield: near-black with a teal nebula veil and sparse stars
          float n = fbm(vec2(az * 2.0, e * 3.0) + 4.0);
          c = mix(c, uNeb, smoothstep(0.45, 0.85, n) * 0.35);
          vec2 sp = vec2(az * 180.0, e * 180.0);
          float st = step(0.9965, h2(floor(sp))) * (0.4 + 0.6 * h2(floor(sp) + 3.0));
          c += uStar * st * 0.5;
        }
        // sun / planet disc + glow
        float disc = 1.0 - smoothstep(uSunSize * 0.92, uSunSize, ang);
        float glow = exp(-ang / (uSunSize * 3.5)) * uGlow;
        c = mix(c, uSun * (uMode > 1.5 ? 0.9 : 1.6), disc);
        c += uSun * glow * (uMode > 1.5 ? 0.15 : 0.35);
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), mat);
  m.frustumCulled = false;
  m.renderOrder = -100;
  return m;
}

/** Shared chase rig: craft at the origin flying -Z, camera 9 m behind, 2.6 m above, FOV 68. */
export function chaseRig(aspect = 16 / 9): { camera: THREE.PerspectiveCamera; vanish: THREE.Vector2 } {
  const camera = new THREE.PerspectiveCamera(68, aspect, 0.3, 2000);
  camera.position.set(0, 2.6, 9);
  camera.lookAt(0, 0.4, -40);
  camera.updateMatrixWorld();
  const far = new THREE.Vector3(0, 2.6, -5000).project(camera);
  return { camera, vanish: new THREE.Vector2(far.x, far.y) };
}

/** Dark delta-wing placeholder (~12 m long, 9 m span) with orange inserts and a hot exhaust. */
export function craftPlaceholder(): THREE.Group {
  const g = new THREE.Group();
  const hull = toonMaterial({ albedo: palette.armourDark, rim: 1.4 });
  const panel = toonMaterial({ albedo: palette.emblemBlack, rim: 1.2 });
  const insert = toonMaterial({ albedo: palette.accentOrange, emissive: palette.accentOrange, emissiveStrength: 1.4 });
  const glass = toonMaterial({ albedo: palette.canopyBlue, emissive: palette.canopyBlue, emissiveStrength: 0.25 });
  const hot = toonMaterial({ albedo: palette.accentOrange, emissive: palette.accentOrange, emissiveStrength: 2.2, fog: false });
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.8, 11, 8), hull);
  fus.rotation.x = -Math.PI / 2;
  g.add(fus);
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, -3.5);
  wingShape.lineTo(4.5, 3.2);
  wingShape.lineTo(3.6, 4.2);
  wingShape.lineTo(0, 3.0);
  for (const s of [1, -1]) {
    const geo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.18, bevelEnabled: false });
    const w = new THREE.Mesh(geo, panel);
    w.rotation.x = Math.PI / 2;
    w.scale.x = s;
    w.position.y = 0.05;
    g.add(w);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.3, 1.6), hull);
    fin.position.set(s * 4.1, 0.55, 3.4);
    fin.rotation.z = s * -0.35;
    g.add(fin);
    const ins = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 0.25), insert);
    ins.position.set(s * 2.2, 0.25, 1.4);
    ins.rotation.y = s * -0.55;
    g.add(ins);
  }
  const can = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), glass);
  can.scale.set(0.8, 0.6, 2.2);
  can.position.set(0, 0.55, -1.5);
  g.add(can);
  const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.2, 0.3, 10), hot);
  ex.rotation.x = Math.PI / 2;
  ex.position.set(0, 0, 5.6);
  g.add(ex);
  // sits ahead of the rig origin so the whole craft is in frame (see chaseRig note)
  g.position.set(0, 0, -6);
  return g;
}

/** A few lit spheres/boxes on the shared rig. */
export function testProps(): THREE.Group {
  const g = new THREE.Group();
  const mats = [palette.armourLight, palette.enemyBody, palette.cloudCream, palette.armourSteel];
  const spots: [number, number, number, number][] = [
    [-9, 3, -30, 2.2],
    [10, 5, -42, 3],
    [-4, 7, -60, 2.5],
    [15, -2, -26, 2],
  ];
  spots.forEach(([x, y, z, s], i) => {
    const m = toonMaterial({ albedo: mats[i % mats.length], rim: 1.2 });
    const geo = i % 2 === 0 ? new THREE.SphereGeometry(s, 32, 20) : new THREE.BoxGeometry(s * 1.6, s * 1.6, s * 1.6);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.rotation.set(0.4 * i, 0.7 * i, 0);
    g.add(mesh);
  });
  // one dark curved hull mass framing the corridor on the right
  const hullMat = toonMaterial({ albedo: palette.armourDark, rim: 0.8 });
  const hull = new THREE.Mesh(new THREE.TorusGeometry(70, 9, 10, 40, Math.PI * 0.6), hullMat);
  hull.position.set(95, 10, -80);
  hull.rotation.set(Math.PI / 2, 0.2, 0.9);
  g.add(hull);
  return g;
}

/** Bright HDR billboard glow (for bloom tests): radial white core into a token colour. */
export function glowSprite(color: string, intensity: number, size: number): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uCol: { value: tvec(color, intensity) }, uCore: { value: tvec(palette.burstWhite, intensity * 1.2) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float s = length(modelMatrix[0].xyz);
        mv.xy += position.xy * s;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uCol, uCore;
      varying vec2 vUv;
      void main() {
        float r = length(vUv);
        float a = smoothstep(1.0, 0.0, r);
        vec3 c = mix(uCol * a * a, uCore, smoothstep(0.35, 0.0, r));
        gl_FragColor = vec4(c * step(r, 1.0), 1.0);
      }
    `,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  m.scale.setScalar(size);
  return m;
}

/** Build a stage test scene: backdrop + lighting applied. */
export function stageScene(stage: StageId): THREE.Scene {
  applyStageLook(stage);
  const s = new THREE.Scene();
  s.add(makeBackdrop(stage));
  return s;
}

export interface BlitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Board compositor: the GL canvas holds one full-size post-processed frame at a time;
 * copy a source rect of it (canvas px, top-left origin) into a destination rect of the
 * 2D overlay canvas (scaled with high-quality smoothing when sizes differ).
 */
export function blitToOverlay(overlay: CanvasRenderingContext2D, gl: HTMLCanvasElement, src: BlitRect, dst: BlitRect): void {
  overlay.save();
  overlay.imageSmoothingEnabled = true;
  overlay.imageSmoothingQuality = 'high';
  overlay.drawImage(gl, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
  overlay.restore();
}

/** Opaque board background on the overlay (so only blitted frames show). */
export function fillOverlay(overlay: CanvasRenderingContext2D, w: number, h: number): void {
  overlay.save();
  overlay.fillStyle = palette.spaceDeep;
  overlay.fillRect(0, 0, w, h);
  overlay.restore();
}
