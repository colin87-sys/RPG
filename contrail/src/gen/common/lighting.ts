/**
 * Shared lighting rig: ONE key light, one rim light, hemisphere ambient, fog and
 * the toon ramp, as uniforms shared by every custom material (hull, enemies,
 * clouds, smoke, structures). applyStageLook() re-lights the whole world.
 *
 * Every custom ShaderMaterial should:
 *   uniforms: { ...lightUniforms, ...own }
 *   fragment: include GLSL_LIGHTING and call rampLight / rimTerm / applyFog.
 * Owner: Director (shared infrastructure). Lanes consume, never fork it.
 */
import * as THREE from 'three';
import { palette, shading, stages, type StageId } from '../../style/tokens';
import { tvec } from '../../style/color';

function makeRampTexture(): THREE.DataTexture {
  const N = 256;
  const data = new Uint8Array(N * 4);
  const stops = shading.ramp;
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    let v = stops[stops.length - 1].value;
    for (let s = 0; s < stops.length - 1; s++) {
      const a = stops[s], b = stops[s + 1];
      if (x >= a.at && x <= b.at) {
        const t = (x - a.at) / Math.max(1e-6, b.at - a.at);
        const sm = t * t * (3 - 2 * t);
        v = a.value + (b.value - a.value) * sm;
        break;
      }
    }
    const byte = Math.round(Math.min(1, v / 1.25) * 255); // stored /1.25 so >1 highlights fit
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = byte;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export const lightUniforms = {
  uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
  uKeyColor: { value: new THREE.Vector3(1, 1, 1) },
  uRimDir: { value: new THREE.Vector3(0, 0, 1) },
  uRimColor: { value: new THREE.Vector3(1, 1, 1) },
  uAmbSky: { value: new THREE.Vector3(0.3, 0.3, 0.3) },
  uAmbGround: { value: new THREE.Vector3(0.2, 0.2, 0.2) },
  uFogColor: { value: new THREE.Vector3(0.7, 0.8, 0.9) },
  uFogFar: { value: new THREE.Vector3(0.7, 0.8, 0.9) },
  uFogDensity: { value: 0.001 },
  uFogHeightFalloff: { value: 0.0 },
  uFogBaseHeight: { value: -40.0 },
  uShadowTint: { value: tvec(shading.shadowTint) },
  uHighlightTint: { value: tvec(shading.highlightTint) },
  uRamp: { value: makeRampTexture() },
  uRimPower: { value: shading.rimPower },
  uRimStrength: { value: shading.rimStrength },
  uTime: { value: 0 },
};

export let currentStage: StageId = 'cloudgate';

/** Re-light everything for a stage. Also returns the look for scene background use. */
export function applyStageLook(id: StageId) {
  const look = stages[id];
  currentStage = id;
  const u = lightUniforms;
  u.uKeyDir.value.set(...look.key.dir).normalize();
  u.uKeyColor.value.copy(tvec(look.key.color, look.key.intensity));
  u.uRimDir.value.set(...look.rim.dir).normalize();
  u.uRimColor.value.copy(tvec(look.rim.color, look.rim.intensity));
  u.uAmbSky.value.copy(tvec(look.ambientSky, look.ambientIntensity));
  u.uAmbGround.value.copy(tvec(look.ambientGround, look.ambientIntensity));
  u.uFogColor.value.copy(tvec(look.fog.color));
  u.uFogFar.value.copy(tvec(look.fog.far));
  u.uFogDensity.value = look.fog.density;
  u.uFogHeightFalloff.value = look.fog.heightFalloff;
  return look;
}
applyStageLook('cloudgate');

/**
 * GLSL helpers. Requires varyings vWorldPos (vec3) and vWorldNormal (vec3) in the
 * fragment shader and cameraPosition (provided by three).
 */
export const GLSL_LIGHTING = /* glsl */ `
uniform vec3 uKeyDir;
uniform vec3 uKeyColor;
uniform vec3 uRimDir;
uniform vec3 uRimColor;
uniform vec3 uAmbSky;
uniform vec3 uAmbGround;
uniform vec3 uFogColor;
uniform vec3 uFogFar;
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform float uFogBaseHeight;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform sampler2D uRamp;
uniform float uRimPower;
uniform float uRimStrength;
uniform float uTime;

// Toon ramp over half-lambert; returns a scalar multiplier (can exceed 1).
float rampLight(vec3 n) {
  float ndl = dot(normalize(n), normalize(uKeyDir));
  float x = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
  return texture2D(uRamp, vec2(x, 0.5)).r * 1.25;
}

// Full stylised lighting for an albedo: ramp key + tinted shadows + hemisphere ambient.
vec3 shadeToon(vec3 albedo, vec3 n) {
  vec3 N = normalize(n);
  float r = rampLight(N);
  float hemi = N.y * 0.5 + 0.5;
  vec3 amb = mix(uAmbGround, uAmbSky, hemi);
  vec3 lit = albedo * uKeyColor * r;
  // shadows lean cool, highlights lean warm
  float lf = clamp(r, 0.0, 1.0);
  vec3 tint = mix(uShadowTint, uHighlightTint, lf);
  return lit * mix(vec3(1.0), tint * 1.6, 0.25) * 0.55 + albedo * amb * 0.45;
}

// Fresnel rim, strongest where the rim light is behind the silhouette.
vec3 rimTerm(vec3 n, vec3 viewDir) {
  vec3 N = normalize(n);
  float f = pow(1.0 - clamp(dot(N, viewDir), 0.0, 1.0), uRimPower);
  float facing = clamp(dot(N, normalize(uRimDir)) * 0.5 + 0.6, 0.0, 1.0);
  return uRimColor * f * facing * uRimStrength;
}

// Exponential-squared distance fog + extra density below the cloud-sea base,
// with a colour shift toward uFogFar at long range.
vec3 applyFog(vec3 color, vec3 worldPos) {
  float d = length(worldPos - cameraPosition);
  float fd = uFogDensity * d;
  float f = 1.0 - exp(-fd * fd);
  float below = max(0.0, uFogBaseHeight - worldPos.y);
  f = clamp(f + (1.0 - exp(-below * uFogHeightFalloff)) * 0.8, 0.0, 1.0);
  vec3 fogCol = mix(uFogColor, uFogFar, clamp(fd * 0.6, 0.0, 1.0));
  return mix(color, fogCol, f);
}
`;

/** Standard vertex shader outputting vWorldPos / vWorldNormal (supports instancing). */
export const GLSL_STD_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 p = vec4(position, 1.0);
  vec3 nrm = normal;
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
    nrm = mat3(instanceMatrix) * nrm;
  #endif
  vec4 wp = modelMatrix * p;
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * nrm);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/** Background clear colour for a stage (sky mid), as THREE.Color. */
export function stageClearColor(id: StageId): THREE.Color {
  return new THREE.Color(stages[id].sky.mid);
}

export { palette };
