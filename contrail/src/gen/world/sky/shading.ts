/**
 * Shared sky-lane shader bits layered on top of the Director's lighting rig
 * (GLSL_LIGHTING is included, never forked): sun in-scatter over the fog so
 * the haze warms toward the key light (cream by day, hot orange at sunset).
 */
import type { StageId } from '../../../style/tokens';
import { colorVec, STAGE_HAZE } from './params';
import { noiseTexture } from './noise';

export function skyCommonUniforms(stage: StageId) {
  const h = STAGE_HAZE[stage];
  return {
    uNoise: { value: noiseTexture() },
    uHazeColor: { value: colorVec(h.color) },
    uHazeStrength: { value: h.strength },
    uHazePower: { value: h.power },
  };
}

/** Requires GLSL_LIGHTING (uKeyDir, uFogDensity, applyFog) above it. */
export const GLSL_SKY_HAZE = /* glsl */ `
uniform vec3 uHazeColor;
uniform float uHazeStrength;
uniform float uHazePower;
// shared fog, then a warm in-scatter lobe toward the key light that grows with distance
vec3 skyFogHaze(vec3 c, vec3 worldPos) {
  c = applyFog(c, worldPos);
  vec3 v = worldPos - cameraPosition;
  float d = length(v);
  float s = pow(max(dot(v / max(d, 1e-3), normalize(uKeyDir)), 0.0), uHazePower);
  float fd = uFogDensity * d;
  float f = 1.0 - exp(-fd * fd * 1.4);
  return c + uHazeColor * s * f * uHazeStrength;
}
`;
