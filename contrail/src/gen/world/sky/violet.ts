/**
 * Layered horizontal cloud bands (cel-layer look). Each band is one camera-wide
 * vertical quad whose top silhouette is a row of domes (two scales, world-space X so
 * it scrolls correctly); a pseudo-normal from the dome profile is lit by the shared
 * key light, the silhouette carries a rim that brightens toward the sun (backlit at
 * sunset), and the shared fog + sun haze shift far bands toward the horizon colour.
 *
 * mode 'wrap'   (Violet Tide): bands approach along -Z and recycle; draw order is a
 *               rotated instance index (one uniform), far first.
 * mode 'follow' (Cloudgate):   distant cumulus banks at fixed distances on the horizon.
 * One instanced draw call, 2 triangles per band.
 */
import * as THREE from 'three';
import type { StageId } from '../../../style/tokens';
import { Rng } from '../../../core/rng';
import { GLSL_LIGHTING, lightUniforms } from '../../common/lighting';
import { GLSL_SKY_NOISE } from './noise';
import { colorVec, type CloudBandParams } from './params';
import { GLSL_SKY_HAZE, skyCommonUniforms } from './shading';

export interface CloudBands {
  group: THREE.Group;
  update(cameraPos: THREE.Vector3, time: number): void;
  stats: { triangles: number; drawCalls: number; bands: number };
}

const MAX_BANDS = 32;

export function buildCloudBands(stage: StageId, params: CloudBandParams, seed: number): CloudBands {
  const P = params;
  const n = Math.min(MAX_BANDS, P.count);
  const rng = new Rng(seed).fork('cloud-bands');
  // per band: (u or distance, topY, seed, height scale); stored far-first
  const bands: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_BANDS; i++) bands.push(new THREE.Vector4());
  for (let i = 0; i < n; i++) {
    const k = n - 1 - i; // far first
    const dist = P.mode === 'wrap' ? k * P.spacing : P.start + k * P.spacing;
    bands[i].set(dist, rng.range(P.topY[0], P.topY[1]), rng.range(0, 500), rng.range(0.85, 1.15));
  }
  const L = n * P.spacing;

  const quad = new THREE.PlaneGeometry(1, 1);
  quad.translate(0, 0.5, 0); // y in [0, 1]
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(quad.index);
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  geo.instanceCount = n;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...lightUniforms,
      ...skyCommonUniforms(stage),
      uBands: { value: bands },
      uCount: { value: n },
      uOffset: { value: 0 },
      uWrap: { value: P.mode === 'wrap' ? 1 : 0 },
      uPhase: { value: 0 },
      uL: { value: L },
      uBack: { value: P.back },
      uStart: { value: P.start },
      uCam: { value: new THREE.Vector3() },
      uBandTime: { value: 0 },
      uDrift: { value: P.drift },
      uHeight: { value: P.height },
      uDome: { value: new THREE.Vector4(P.domeWidth, P.domeAmp, P.detailWidth, P.detailAmp) },
      uBody: { value: colorVec(P.body) },
      uLit: { value: colorVec(P.lit) },
      uShadow: { value: colorVec(P.shadow) },
      uRimC: { value: colorVec(P.rim) },
      uRimWidth: { value: P.rimWidth },
      uBandRimK: { value: P.rimStrength },
      uRimFocus: { value: P.rimFocus },
      uOpacity: { value: P.opacity },
      uSoft: { value: P.soft },
    },
    vertexShader: /* glsl */ `
      uniform vec4 uBands[${MAX_BANDS}];
      uniform int uCount;
      uniform int uOffset;
      uniform float uWrap, uPhase, uL, uBack, uStart, uHeight;
      uniform vec4 uDome;
      uniform vec3 uCam;
      varying vec3 vWorldPos;
      varying float vTop;
      varying float vSeed;
      varying float vFade;
      varying float vHScale;
      void main() {
        int idx = gl_InstanceID + uOffset;
        if (idx >= uCount) idx -= uCount;
        vec4 b = uBands[idx];
        float ahead = uWrap > 0.5 ? mod(b.x - uPhase, uL) - uBack : b.x;
        float fade = 1.0;
        if (uWrap > 0.5) {
          fade = (1.0 - smoothstep(uL - uBack - uL * 0.3, uL - uBack, ahead)) * smoothstep(uStart * 0.4, uStart, ahead);
        }
        vFade = fade;
        if (fade < 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        float hw = ahead * 2.2 + 900.0;
        float h = uHeight * b.w;
        float top = b.y + (uDome.y * 1.3 + uDome.w) * b.w;
        vec3 wp = vec3(uCam.x + position.x * 2.0 * hw, (b.y - h) + position.y * (top - (b.y - h)), uCam.z - ahead);
        vWorldPos = wp;
        vTop = b.y;
        vSeed = b.z;
        vHScale = b.w;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_LIGHTING}
      ${GLSL_SKY_NOISE}
      ${GLSL_SKY_HAZE}
      uniform vec4 uDome;
      uniform float uSoft, uHeight, uBandTime, uDrift, uRimWidth, uBandRimK, uRimFocus, uOpacity;
      uniform vec3 uBody, uLit, uShadow, uRimC;
      varying vec3 vWorldPos;
      varying float vTop;
      varying float vSeed;
      varying float vFade;
      varying float vHScale;

      // row of domes: returns height (0..1) and the dome's local slope in .y
      vec2 domes(float x, float w, float s) {
        float i = floor(x / w);
        vec2 best = vec2(0.0);
        for (int k = -1; k <= 1; k++) {
          float c = i + float(k);
          float h1 = skyHash(c + s), h2 = skyHash(c * 1.73 + s + 3.1), h3 = skyHash(c * 2.31 + s + 7.7);
          float cx = (c + 0.2 + 0.6 * h1) * w;
          float r = w * (0.55 + 0.55 * h2);
          float hh = 0.4 + 0.6 * h3;
          float q = (x - cx) / r;
          float v = hh * sqrt(max(0.0, 1.0 - q * q));
          if (v > best.x) best = vec2(v, -q * hh / max(sqrt(max(1e-3, 1.0 - q * q)), 0.15) / r);
        }
        return best;
      }

      void main() {
        float x = vWorldPos.x + uBandTime * uDrift + vSeed * 37.0;
        float s = mod(vSeed, 97.0);
        vec2 d1 = domes(x, uDome.x * vHScale, s);
        vec2 d2 = domes(x + 13.0, uDome.z * vHScale, s + 11.0);
        float wob = (skyFbmLo(vec2(x * 0.0021, vSeed * 0.013)) - 0.5) * uDome.y * 0.5;
        float top = vTop + (d1.x * uDome.y + d2.x * uDome.w) * vHScale + wob;
        float slope = clamp(d1.y * uDome.y + d2.y * uDome.w, -1.2, 1.2); // dy/dx of the silhouette
        float below = top - vWorldPos.y; // metres below the silhouette
        float aa = max(fwidth(below), 0.02) + uSoft * length(vWorldPos - cameraPosition) * 0.002;
        float a = smoothstep(-aa, aa, below);
        a *= smoothstep(0.0, uHeight * 0.55 * vHScale, vWorldPos.y - (vTop - uHeight * vHScale));
        a *= vFade;
        if (a < 0.004) discard;

        // pseudo-normal: silhouette slope near the top, facing the camera deeper in
        float rimZone = exp(-below / max(uRimWidth, 0.5));
        float up = mix(0.25, 1.0, rimZone);
        vec3 N = normalize(vec3(-slope * up, up, 1.0 - up * 0.7));
        float ndl = dot(N, normalize(uKeyDir));
        float xl = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
        float r = texture2D(uRamp, vec2(xl, 0.5)).r * 1.25;
        float lit = mix(smoothstep(0.1, 0.95, xl), clamp((r - 0.18) / 0.9, 0.0, 1.0), 0.5);
        float strata = skyFbm(vec2(x * 0.004, vWorldPos.y * 0.05 + vSeed));
        float depthT = smoothstep(0.0, uHeight * 0.8 * vHScale, below);
        vec3 c = mix(uBody, uShadow, depthT * 0.6 + (strata - 0.5) * 0.3);
        c = mix(c, uLit, smoothstep(0.45, 0.9, lit) * (1.0 - depthT * 0.7));
        c = mix(c, uShadow, (1.0 - lit) * 0.35);

        // rim toward the sun: azimuth focus + elevation below the key light
        vec3 v = normalize(vWorldPos - cameraPosition);
        vec3 L = normalize(uKeyDir);
        float az = max(dot(normalize(v.xz), normalize(L.xz)), 0.0);
        float focus = pow(az, uRimFocus * 4.0) * 0.8 + 0.2;
        c += uRimC * rimZone * focus * uBandRimK;

        c = skyFogHaze(c, vWorldPos);
        gl_FragColor = vec4(c, clamp(a * uOpacity, 0.0, 1.0));
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `cloudBands:${stage}`;
  mesh.frustumCulled = false;
  mesh.renderOrder = -800;
  const group = new THREE.Group();
  group.name = `bands:${stage}`;
  group.add(mesh);
  const u = mat.uniforms;
  return {
    group,
    update(cameraPos: THREE.Vector3, time: number) {
      u.uCam.value.copy(cameraPos);
      u.uBandTime.value = time;
      if (P.mode !== 'wrap') return;
      const D = -cameraPos.z - P.back;
      const phase = ((D % L) + L) % L;
      u.uPhase.value = phase;
      // bands are far-first with distances k*spacing descending; farthest has u < phase
      let off = 0;
      for (let i = 0; i < n; i++) {
        if (bands[i].x < phase) { off = i; break; }
      }
      u.uOffset.value = off;
    },
    stats: { triangles: n * 2, drawCalls: 1, bands: n },
  };
}
