/**
 * Generic stylised materials built on the shared lighting rig.
 * Lanes may build richer materials (hull seams, emissive inserts) on top of
 * GLSL_LIGHTING, but must keep the same key/rim/ambient/fog behaviour.
 */
import * as THREE from 'three';
import { GLSL_LIGHTING, GLSL_STD_VERTEX, lightUniforms } from './lighting';
import { tvec } from '../../style/color';

export interface ToonOptions {
  albedo: string; // token hex
  emissive?: string; // token hex
  emissiveStrength?: number;
  rim?: number; // rim multiplier (default 1)
  fog?: boolean; // default true
}

export function toonMaterial(o: ToonOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...lightUniforms,
      uAlbedo: { value: tvec(o.albedo) },
      uEmissive: { value: tvec(o.emissive ?? '#000000', o.emissiveStrength ?? 1) },
      uRimMul: { value: o.rim ?? 1 },
    },
    defines: o.fog === false ? {} : { USE_FOG_RIG: '' },
    vertexShader: GLSL_STD_VERTEX,
    fragmentShader: /* glsl */ `
      ${GLSL_LIGHTING}
      uniform vec3 uAlbedo;
      uniform vec3 uEmissive;
      uniform float uRimMul;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec2 vUv;
      void main() {
        vec3 n = normalize(vWorldNormal);
        vec3 v = normalize(cameraPosition - vWorldPos);
        vec3 c = shadeToon(uAlbedo, n) + rimTerm(n, v) * uRimMul + uEmissive;
        #ifdef USE_FOG_RIG
        c = applyFog(c, vWorldPos);
        #endif
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

/** The deliberately naive material for Reviewer calibration (default grey, flat). */
export function naiveMaterial(hex: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.6, metalness: 0.0 });
}
