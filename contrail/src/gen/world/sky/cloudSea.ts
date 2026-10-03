/**
 * Cloud sea: a displaced grid below the corridor that follows the camera in X/Z.
 * Heights come from world-space domain-warped fbm (so billows scroll correctly as
 * the rail flies); the vertex shader lifts real billows (silhouettes, parallax,
 * crests that occlude the valleys behind them) and the fragment shader re-derives
 * a fine normal from the same field. Lit by the shared key light: cream tops,
 * cool bounce-lit valleys by day; dark indigo with sun-side rims at sunset.
 * Fogged into the horizon haze.
 *
 * Grid: square, radially warped so spacing is ~3 m under the craft and grows to
 * hundreds of metres at the horizon (fogged); snapped to a 4 m step so near
 * vertices do not swim. Opaque, writes depth, renderOrder -900.
 */
import * as THREE from 'three';
import type { StageId } from '../../../style/tokens';
import { GLSL_LIGHTING, lightUniforms } from '../../common/lighting';
import { GLSL_SKY_NOISE } from './noise';
import { colorVec, type CloudSeaParams } from './params';
import { GLSL_SKY_HAZE, skyCommonUniforms } from './shading';

export interface CloudSea {
  mesh: THREE.Mesh;
  update(cameraPos: THREE.Vector3, time: number): void;
  stats: { triangles: number; drawCalls: number };
}

const SEGS = 220; // quads per side
const SNAP = 4; // m

/**
 * Unit grid in [-0.5, 0.5]^2 (XZ). Spacing grows in proportion to distance
 * (exponential), from ~3 m at the centre for a 16 km plane: equal screen density.
 */
function warpedGrid(segs: number, sizeM: number): THREE.BufferGeometry {
  const n = segs + 1;
  const pos = new Float32Array(n * n * 3);
  const half = segs / 2, d0 = 3; // m spacing at the centre
  // solve A (e^{half/B} - 1) = size/2 with A = d0 B
  let B = 10;
  for (let it = 0; it < 60; it++) B *= Math.pow((d0 * B * (Math.exp(half / B) - 1)) / (sizeM / 2), 0.25);
  const A = d0 * B;
  const warp = (i: number) => { const g = i - half; return (Math.sign(g) * A * (Math.exp(Math.abs(g) / B) - 1)) / sizeM; };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 3;
      pos[o] = warp(i);
      pos[o + 1] = 0;
      pos[o + 2] = warp(j);
    }
  }
  const idx = new Uint32Array(segs * segs * 6);
  let k = 0;
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const v = j * n + i;
      idx[k++] = v; idx[k++] = v + n; idx[k++] = v + 1;
      idx[k++] = v + 1; idx[k++] = v + n; idx[k++] = v + n + 1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

const GLSL_SEA_FIELD = /* glsl */ `
uniform float uScale, uStretch, uSeaTime, uDrift, uAmp, uLumps;
uniform vec2 uOff;
vec2 seaP(vec3 wp) { return vec2(wp.x / uStretch, wp.z + uSeaTime * uDrift) * uScale + uOff; }
float dome(float n, float lo, float hi) {
  float b = smoothstep(lo, hi, n);
  return 1.0 - (1.0 - b) * (1.0 - b);
}
// 0..1 cumulus height: union of big and medium domed lumps (cauliflower creases
// where they meet); fine > 0 adds the small octave (fragment normals only).
float seaField(vec2 p, float fine, float lumps) {
  vec2 w = vec2(texture2D(uNoise, p * 0.23 + 0.17).a, texture2D(uNoise, p * 0.23 + 0.61).a) - 0.5;
  vec2 q = p + w * 0.9;
  vec4 a = texture2D(uNoise, q * 0.5);
  vec4 m = texture2D(uNoise, q * 1.35 + vec2(0.43, 0.19));
  float big = dome(a.a * 0.6 + a.r * 0.4, 0.2, 0.8);
  float mid = dome(m.a * 0.65 + m.g * 0.35, 0.35, 0.8);
  float a0 = big * 0.8, b0 = mid * 0.5 + big * 0.45;
  // smooth union (polynomial smax): rounded seams, no creases the grid cannot resolve
  float k = 0.22;
  float hh = clamp(0.5 + 0.5 * (b0 - a0) / k, 0.0, 1.0);
  float u = mix(a0, b0, hh) + k * hh * (1.0 - hh);
  float h = mix(a0, u, lumps);
  if (fine > 0.0) {
    vec4 f = texture2D(uNoise, q * 3.1 + 0.31);
    h += ((f.r - 0.5) * 0.05 + (f.g - 0.5) * 0.03) * fine;
  }
  return clamp(h + 0.08, 0.0, 1.0);
}
`;

export function buildCloudSea(stage: StageId, params: CloudSeaParams, seed: number): CloudSea {
  const geo = warpedGrid(SEGS, params.size);
  // seed only offsets the noise domain (deterministic)
  const off = new THREE.Vector2(((seed * 0.6180339) % 1) * 37.0, ((seed * 0.4142135) % 1) * 53.0);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...lightUniforms,
      ...skyCommonUniforms(stage),
      uLit: { value: colorVec(params.lit) },
      uMidC: { value: colorVec(params.mid) },
      uShadow: { value: colorVec(params.shadow) },
      uRimC: { value: colorVec(params.rim) },
      uBacklit: { value: params.backlit },
      uScale: { value: 1 / params.scale },
      uStretch: { value: params.stretchX },
      uBump: { value: params.bump },
      uContrast: { value: params.contrast },
      uAmp: { value: params.amp },
      uBounce: { value: params.bounce },
      uLumps: { value: params.lumps },
      uShadowStep: { value: params.shadowStep },
      uShadowAmt: { value: params.shadowAmt },
      uOff: { value: off },
      uSeaTime: { value: 0 },
      uDrift: { value: params.drift },
    },
    vertexShader: /* glsl */ `
      ${GLSL_SKY_NOISE}
      ${GLSL_SEA_FIELD}
      varying vec3 vWorldPos;
      varying float vH;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        float d = length(wp.xz - cameraPosition.xz);
        float h = seaField(seaP(wp.xyz), 0.0, uLumps * 0.4);
        // flatten toward the horizon so the far edge never shows a jagged rim
        float amp = uAmp * (1.0 - smoothstep(2500.0, 6500.0, d));
        wp.y += (h - 0.3) * amp;
        vH = h;
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_LIGHTING}
      ${GLSL_SKY_NOISE}
      ${GLSL_SKY_HAZE}
      ${GLSL_SEA_FIELD}
      uniform vec3 uLit, uMidC, uShadow, uRimC;
      uniform float uBacklit, uBump, uContrast, uBounce, uShadowStep, uShadowAmt;
      varying vec3 vWorldPos;
      varying float vH;

      void main() {
        vec3 toFrag = vWorldPos - cameraPosition;
        float dist = length(toFrag);
        float lod = smoothstep(300.0, 2200.0, dist);
        vec2 p = seaP(vWorldPos);
        float e = 0.012;
        float fine = 1.0 - lod;
        float h = seaField(p, fine, uLumps);
        float hx = seaField(p + vec2(e, 0.0), fine, uLumps);
        float hz = seaField(p + vec2(0.0, e), fine, uLumps);
        // true slope of the displaced surface (metres) plus extra fine bump
        float ampF = uAmp * (1.0 - smoothstep(2500.0, 6500.0, dist));
        float dm = e / uScale; // metres per e step along z
        float k = ampF / dm + uBump * (1.0 - lod * 0.85) / e * 0.02;
        vec3 N = normalize(vec3((h - hx) * k / uStretch, 1.0, (h - hz) * k));

        // soft self-shadow: is the surface toward the sun higher than the sun ray?
        vec3 L = normalize(uKeyDir);
        vec2 Lxz = L.xz / max(length(L.xz), 1e-3);
        float rise = L.y / max(length(L.xz), 0.05); // m of ray rise per m along the ground
        float occ = 0.0;
        if (lod < 0.95) {
          float hm = seaField(p, 0.0, uLumps * 0.4) * ampF;
          for (int i = 1; i <= 2; i++) {
            float dd = float(i * i) * uShadowStep * 1.6;
            vec3 sp = vWorldPos + vec3(Lxz.x, 0.0, Lxz.y) * dd;
            float hs = seaField(seaP(sp), 0.0, uLumps * 0.4) * ampF;
            occ = max(occ, smoothstep(-2.0, 18.0, hs - hm - rise * dd));
          }
        }
        occ *= (1.0 - lod) * uShadowAmt;

        // shared ramp for the key light, softened for cloud tops
        float ndl = dot(N, normalize(uKeyDir)) * (1.0 - occ * 0.9);
        float x = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
        float r = texture2D(uRamp, vec2(x, 0.5)).r * 1.25;
        float lit = mix(smoothstep(0.1, 1.0, x), clamp((r - 0.18) / 0.9, 0.0, 1.0), 0.5);
        float crest = smoothstep(0.15, 0.75, (h - 0.25) * uContrast + 0.25);
        float l = lit * mix(0.55, 1.0, crest);
        vec3 c = mix(uShadow, uMidC, smoothstep(0.1, 0.5, l));
        c = mix(c, uLit, smoothstep(0.5, 0.95, l) * crest);
        // valleys: occluded, but lit by sky bounce (cool, never grey)
        float valley = 1.0 - smoothstep(0.08, 0.5, h);
        vec3 skyTint = uAmbSky / max(max(uAmbSky.r, uAmbSky.g), max(uAmbSky.b, 1e-3));
        c = mix(c, c * mix(vec3(0.9), skyTint, 0.25), valley * 0.35);
        c += uMidC * skyTint * uBounce * (1.0 - valley) * (1.0 - lit) * 0.5;
        c *= mix(vec3(1.0), skyTint, 0.12);

        // backlit crests: forward scatter toward the sun on the tops of billows
        vec3 v = toFrag / max(dist, 1e-3);
        float fwd = pow(max(dot(v, normalize(uKeyDir)), 0.0), 3.0);
        float rimE = pow(1.0 - clamp(dot(N, -v), 0.0, 1.0), 2.0);
        c += uRimC * fwd * crest * (0.35 + rimE) * uBacklit;
        // silver edge on crests seen at grazing angles (any direction)
        c += uLit * rimE * crest * 0.12 * (1.0 - lod);

        c = skyFogHaze(c, vWorldPos);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `cloudSea:${stage}`;
  mesh.scale.set(params.size, 1, params.size);
  mesh.position.y = params.y;
  mesh.renderOrder = -900;
  mesh.frustumCulled = false;
  return {
    mesh,
    update(cameraPos: THREE.Vector3, time: number) {
      mesh.position.set(Math.round(cameraPos.x / SNAP) * SNAP, params.y, Math.round(cameraPos.z / SNAP) * SNAP);
      mat.uniforms.uSeaTime.value = time;
    },
    stats: { triangles: SEGS * SEGS * 2, drawCalls: 1 },
  };
}
