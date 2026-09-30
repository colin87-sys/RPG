/**
 * Cloud sea: one large plane below the corridor that follows the camera in X/Z,
 * shaded from world-space domain-warped fbm (so it scrolls correctly as the rail
 * flies), lit by the shared key light (cream tops, cool valleys by day; dark
 * indigo with sun-side rims at sunset), fogged into the horizon haze.
 * Opaque, writes depth (so things below it are hidden), renderOrder -900.
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

export function buildCloudSea(stage: StageId, params: CloudSeaParams, seed: number): CloudSea {
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
  geo.rotateX(-Math.PI / 2);
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
      uOff: { value: off },
      uSeaTime: { value: 0 },
      uDrift: { value: params.drift },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_LIGHTING}
      ${GLSL_SKY_NOISE}
      ${GLSL_SKY_HAZE}
      uniform vec3 uLit, uMidC, uShadow, uRimC;
      uniform float uBacklit, uScale, uStretch, uBump, uContrast, uSeaTime, uDrift;
      uniform vec2 uOff;
      varying vec3 vWorldPos;

      float seaH(vec2 p, float lod) {
        vec2 w = vec2(texture2D(uNoise, p * 0.23 + 0.17).a, texture2D(uNoise, p * 0.23 + 0.61).a) - 0.5;
        vec2 q = p + w * 0.9;
        vec4 a = texture2D(uNoise, q * 0.5);
        vec4 b = texture2D(uNoise, q * 1.7 + 0.31);
        float h = a.a * 0.45 + a.r * 0.3 + mix(b.r * 0.15 + b.g * 0.1, 0.12, lod);
        // billow: round tops, pinched valleys
        return pow(clamp(h, 0.0, 1.0), 1.4);
      }

      void main() {
        vec3 toFrag = vWorldPos - cameraPosition;
        float dist = length(toFrag);
        float lod = smoothstep(300.0, 2200.0, dist);
        vec2 p = vec2(vWorldPos.x / uStretch, vWorldPos.z + uSeaTime * uDrift) * uScale + uOff;
        float e = 0.012;
        float h = seaH(p, lod);
        float hx = seaH(p + vec2(e, 0.0), lod);
        float hz = seaH(p + vec2(0.0, e), lod);
        float k = uBump * (1.0 - lod * 0.85) / e * 0.02;
        vec3 N = normalize(vec3((h - hx) * k / uStretch, 1.0, (h - hz) * k));

        // shared ramp for the key light, softened for cloud tops
        float ndl = dot(N, normalize(uKeyDir));
        float x = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
        float r = texture2D(uRamp, vec2(x, 0.5)).r * 1.25;
        float lit = mix(smoothstep(0.1, 1.0, x), clamp((r - 0.18) / 0.9, 0.0, 1.0), 0.5);
        float crest = smoothstep(0.15, 0.75, (h - 0.25) * uContrast + 0.25);
        float l = lit * mix(0.55, 1.0, crest);
        vec3 c = mix(uShadow, uMidC, smoothstep(0.1, 0.5, l));
        c = mix(c, uLit, smoothstep(0.5, 0.95, l) * crest);
        // hemisphere ambient keeps valleys cool, never grey
        c *= mix(vec3(1.0), uAmbSky / max(max(uAmbSky.r, uAmbSky.g), max(uAmbSky.b, 1e-3)), 0.12);

        // backlit crests: forward scatter toward the sun on the tops of billows
        vec3 v = toFrag / max(dist, 1e-3);
        float fwd = pow(max(dot(v, normalize(uKeyDir)), 0.0), 3.0);
        float rimE = pow(1.0 - clamp(dot(N, -v), 0.0, 1.0), 2.0);
        c += uRimC * fwd * crest * (0.35 + rimE) * uBacklit;

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
      mesh.position.set(cameraPos.x, params.y, cameraPos.z);
      mat.uniforms.uSeaTime.value = time;
    },
    stats: { triangles: 2, drawCalls: 1 },
  };
}
