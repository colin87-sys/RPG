/**
 * Painterly gradient sky dome: an inverted sphere that follows the camera,
 * zenith / mid / horizon from stages[stage].sky, a narrow horizon band, sun disc
 * and halo at the shared key direction (uKeyDir = sun), soft posterised banding
 * and faint high cirrus. Depth test/write off, drawn first (renderOrder -1000).
 */
import * as THREE from 'three';
import { stages, type StageId } from '../../../style/tokens';
import { tvec } from '../../../style/color';
import { GLSL_LIGHTING, lightUniforms } from '../../common/lighting';
import { GLSL_SKY_NOISE } from './noise';
import { colorVec, type SkyDomeParams } from './params';
import { skyCommonUniforms } from './shading';

export interface SkyDome {
  mesh: THREE.Mesh;
  update(cameraPos: THREE.Vector3, time: number): void;
  stats: { triangles: number; drawCalls: number };
}

export const SKY_RADIUS = 5000;

export function buildSkyDome(stage: StageId, params: SkyDomeParams): SkyDome {
  const look = stages[stage].sky;
  const geo = new THREE.SphereGeometry(SKY_RADIUS, 48, 24);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...lightUniforms,
      ...skyCommonUniforms(stage),
      uZenith: { value: tvec(look.zenith) },
      uMid: { value: tvec(look.mid) },
      uHorizon: { value: tvec(look.horizon) },
      uMidHeight: { value: look.midHeight },
      uBandColor: { value: colorVec(params.bandColor) },
      uHorizonBand: { value: params.horizonBand },
      uSunColor: { value: tvec(look.sunColor) },
      uSunSize: { value: look.sunSize * params.sunScale },
      uSunIntensity: { value: params.sunIntensity },
      uGlowInner: { value: colorVec(params.glowInner) },
      uGlowOuter: { value: colorVec(params.glowOuter) },
      uGlowSize: { value: params.glowSize },
      uGlowStretch: { value: params.glowStretch },
      uGlow: { value: look.sunGlow * params.glowStrength },
      uCirrus: { value: params.cirrus },
      uCirrusColor: { value: colorVec(params.cirrusColor) },
      uBanding: { value: params.banding },
      uBandSteps: { value: params.bandSteps },
      uWobble: { value: params.wobble },
      uSkyTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
        gl_Position.z = gl_Position.w * 0.99999; // always at the far plane, never clipped
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_LIGHTING}
      ${GLSL_SKY_NOISE}
      uniform vec3 uZenith, uMid, uHorizon, uBandColor, uSunColor, uGlowInner, uGlowOuter, uCirrusColor;
      uniform float uMidHeight, uHorizonBand, uSunSize, uSunIntensity, uGlowSize, uGlowStretch, uGlow;
      uniform float uCirrus, uBanding, uBandSteps, uWobble, uSkyTime;
      varying vec3 vDir;

      // soft staircase: painterly bands without hard steps
      float paint(float t) {
        float k = uBandSteps;
        float q = (floor(t * k) + smoothstep(0.3, 0.7, fract(t * k))) / k;
        return mix(t, q, uBanding);
      }

      void main() {
        vec3 d = normalize(vDir);
        vec3 L = normalize(uKeyDir);
        // low-frequency wobble so gradient bands are hand-painted, not ruler-straight
        vec2 wp = d.xz / (abs(d.y) + 0.35);
        float wob = (skyFbmLo(wp * 0.35 + vec2(0.13, 0.71)) - 0.5) * uWobble;
        float e = d.y + wob * smoothstep(0.0, 0.08, d.y);

        float eu = max(e, 0.0);
        float t1 = paint(smoothstep(0.0, uHorizonBand, eu));
        float t2 = paint(smoothstep(uHorizonBand * 0.6, max(uMidHeight, uHorizonBand + 0.05), eu));
        float t3 = paint(pow(smoothstep(uMidHeight, 1.0, eu), 0.8));
        vec3 c = mix(uHorizon, uBandColor, t1);
        c = mix(c, uMid, t2);
        c = mix(c, uZenith, t3);

        // below the horizon: blend to the far fog colour (matches the cloud-sea edge)
        c = mix(c, uFogFar, smoothstep(0.0, -0.025, e));

        // sun halo (stretched along the horizon), inner glow, disc
        vec3 dd = d - L;
        float q = length(vec3(dd.x * uGlowStretch, dd.y, dd.z * uGlowStretch));
        float cosA = clamp(dot(d, L), -1.0, 1.0);
        float ang = acos(cosA);
        float outer = exp(-pow(q / uGlowSize, 2.0));
        float inner = exp(-ang / (uSunSize * 2.2));
        c = mix(c, uGlowOuter, clamp(outer * uGlow * 0.6, 0.0, 1.0) * smoothstep(-0.05, 0.02, e));
        c += uGlowInner * inner * uGlow * 0.9;
        float disc = 1.0 - smoothstep(uSunSize * 0.92, uSunSize * 1.04, ang);
        c = mix(c, uSunColor * uSunIntensity, disc);

        // faint high cirrus streaks (projected onto a high plane, stretched)
        vec2 cp = d.xz / (d.y + 0.12);
        vec2 sp = vec2(cp.x * 0.09 + cp.y * 0.04, cp.y * 0.55 - cp.x * 0.1) + vec2(uSkyTime * 0.0015, 0.0);
        float cn = skyFbm(sp * vec2(1.1, 2.4) + vec2(0.4, 0.2));
        float cm = smoothstep(0.56, 0.8, cn) * skyFbmLo(sp * 0.4 + 0.3);
        cm *= smoothstep(0.06, 0.3, e) * (1.0 - smoothstep(0.75, 1.0, e));
        c = mix(c, uCirrusColor, clamp(cm * uCirrus * 1.6, 0.0, 1.0));

        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `skyDome:${stage}`;
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  const tris = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  return {
    mesh,
    update(cameraPos: THREE.Vector3, time: number) {
      mesh.position.copy(cameraPos);
      mat.uniforms.uSkyTime.value = time;
    },
    stats: { triangles: tris, drawCalls: 1 },
  };
}
