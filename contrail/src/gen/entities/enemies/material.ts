/**
 * Shared WARDEN enemy material, built on the shared lighting rig.
 * - Vertex: GLSL_STD_VERTEX is included VERBATIM; the preprocessor renames its
 *   main() and feeds it a pre-transformed position/normal (rigid bones, caltrop
 *   spin), so key/rim/ambient/fog and instancing behave exactly like every other
 *   material in the game.
 * - Fragment: GLSL_LIGHTING shadeToon (toon ramp, cool shadows) + a strong warm
 *   rim (enemyRim) in the stage rim direction + a share of the stage rim +
 *   emissive channels + applyFog + uHitFlash (-> white) + uSilhouette (flat black).
 */
import * as THREE from 'three';
import { GLSL_LIGHTING, GLSL_STD_VERTEX, lightUniforms } from '../../common/lighting';
import { palette, shading, vfx } from '../../../style/tokens';
import { tvec } from '../../../style/color';

/** Look parameters shared by every enemy (variants A/B/C change these, not code). */
export interface EnemyLook {
  rimStrength: number; // warm rim multiplier
  rimPower: number; // fresnel exponent (lower = wider rim)
  rimWrap: number; // 0..1 minimum warm rim on the side away from the rim light
  stageRim: number; // share of the stage's own rim light
  panelContrast: number; // 0 = panels same as body, 1 = full enemyPanel
  markerIntensity: number; // emissive marker strength
  markerDensity: number; // 0..1 fraction of optional marker lights spawned
  thrusterIntensity: number;
  seamStrength: number; // procedural panel seams 0..1
  outline: boolean; // inverted-hull ink outline (+1 draw call per mesh)
  outlinePx: number; // outline width in pixels at 1080p
}

export interface EnemyMaterialOptions {
  look: EnemyLook;
  bones?: number; // rigid bone count (0 = none)
  instanced?: boolean; // per-instance aInst (x = hit flash, y = spin phase)
  spin?: boolean; // spin around local Z (caltrop)
  seamSpacing?: number; // metres between seam lines
}

const HEAD = /* glsl */ `
attribute vec3 aAlbedo;
attribute vec4 aEmit;
#ifdef USE_BONES
attribute float aBone;
uniform mat4 uBones[BONE_COUNT];
#endif
#ifdef USE_INST_ATTR
attribute vec2 aInst;
#endif
#ifdef USE_SPIN
uniform float uSpinTime;
uniform float uSpinRate;
#endif
#ifdef OUTLINE
attribute vec3 aOutlineN;
uniform float uOutlineNdc;
#endif
varying vec3 vAlbedo;
varying vec4 vEmit;
varying float vFlash;
varying vec3 vLocal;
vec3 enemyPos;
vec3 enemyNrm;
#define position enemyPos
#define normal enemyNrm
#define main enemyStdMain
`;

const TAIL = /* glsl */ `
#undef main
#undef normal
#undef position
void main() {
  vec3 p = position;
  vec3 n = normal;
  #ifdef OUTLINE
    n = aOutlineN;
  #endif
  #ifdef USE_SPIN
    float sa = uSpinTime * uSpinRate + aInst.y * 6.2831853;
    float cs = cos(sa), sn = sin(sa);
    p.xy = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
    n.xy = vec2(cs * n.x - sn * n.y, sn * n.x + cs * n.y);
  #endif
  #ifdef USE_BONES
    mat4 bm = uBones[int(aBone + 0.5)];
    p = (bm * vec4(p, 1.0)).xyz;
    n = mat3(bm) * n;
  #endif
  enemyPos = p;
  enemyNrm = n;
  enemyStdMain();
  #ifdef OUTLINE
    vec3 cn = (projectionMatrix * viewMatrix * vec4(vWorldNormal, 0.0)).xyz;
    vec2 d = cn.xy;
    float l = length(d);
    if (l > 1e-5) gl_Position.xy += (d / l) * uOutlineNdc * gl_Position.w;
  #endif
  vAlbedo = aAlbedo;
  vEmit = aEmit;
  vLocal = position;
  #ifdef USE_INST_ATTR
    vFlash = aInst.x;
  #else
    vFlash = 0.0;
  #endif
}
`;

export const ENEMY_VERTEX = HEAD + GLSL_STD_VERTEX + TAIL;

const FRAG = /* glsl */ `
${GLSL_LIGHTING}
uniform vec3 uWarmRim;
uniform float uWarmRimPower;
uniform float uRimWrap;
uniform float uStageRim;
uniform float uHitFlash;
uniform float uSilhouette;
uniform vec3 uFlashColor;
uniform vec3 uSilColor;
uniform vec4 uChanA;
uniform vec4 uChanB;
uniform float uSeq;
uniform float uVentRate;
uniform float uEnemyTime;
uniform float uSeamSpacing;
uniform float uSeamStrength;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying vec3 vAlbedo;
varying vec4 vEmit;
varying float vFlash;
varying vec3 vLocal;

float seamLines(vec3 p, vec3 n) {
  // lines on the two axes most perpendicular to the (object-space) facet
  vec3 an = abs(n);
  vec2 q = an.x > an.y && an.x > an.z ? p.yz : (an.y > an.z ? p.xz : p.xy);
  vec2 g = abs(fract(q / uSeamSpacing + 0.5) - 0.5) * uSeamSpacing;
  vec2 w = fwidth(q) * 0.9 + 1e-4;
  vec2 s = 1.0 - smoothstep(w * 0.5, w * 1.5, g);
  return max(s.x, s.y);
}

void main() {
  if (uSilhouette > 0.5) {
    gl_FragColor = vec4(uSilColor, 1.0);
    #include <colorspace_fragment>
    return;
  }
  vec3 n = normalize(vWorldNormal);
  vec3 v = normalize(cameraPosition - vWorldPos);
  vec3 alb = vAlbedo;
  if (uSeamStrength > 0.0) {
    vec3 ln = normalize(cross(dFdx(vLocal), dFdy(vLocal)));
    alb *= 1.0 - seamLines(vLocal, ln) * uSeamStrength;
  }
  vec3 c = shadeToon(alb, n);
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  float fr = pow(1.0 - ndv, uWarmRimPower);
  float facing = clamp(dot(n, normalize(uRimDir)) * 0.5 + 0.5, 0.0, 1.0);
  c += uWarmRim * fr * mix(uRimWrap, 1.0, facing);
  c += rimTerm(n, v) * uStageRim;
  // emissive channels
  float chf = floor(vEmit.a + 0.0005);
  float ph = vEmit.a - chf;
  vec4 selA = step(abs(vec4(chf) - vec4(0.0, 1.0, 2.0, 3.0)), vec4(0.5));
  vec4 selB = step(abs(vec4(chf) - vec4(4.0, 5.0, 6.0, 7.0)), vec4(0.5));
  float w = dot(selA, uChanA) + dot(selB, uChanB);
  w *= mix(1.0, 0.8 + 0.2 * sin(uEnemyTime * 3.1 + ph * 6.2831853), selA.y);
  w *= mix(1.0, 0.85 + 0.15 * sin(uEnemyTime * 37.0 + ph * 11.0), selA.z);
  w *= mix(1.0, 0.15 + 0.85 * smoothstep(ph, ph + 0.07, uSeq), selB.x);
  w *= mix(1.0, 0.35 + 0.65 * (0.5 + 0.5 * sin(uEnemyTime * uVentRate - ph * 31.4159)), selB.z);
  vec3 e = vEmit.rgb * w;
  float hot = max(max(e.r, e.g), e.b);
  c += e + vec3(max(hot - 1.0, 0.0) * 0.45);
  c = applyFog(c, vWorldPos);
  c = mix(c, uFlashColor, clamp(max(uHitFlash, vFlash), 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

const OUTLINE_FRAG = /* glsl */ `
${GLSL_LIGHTING}
uniform vec3 uInk;
uniform float uSilhouette;
uniform vec3 uSilColor;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying vec3 vAlbedo;
varying vec4 vEmit;
varying float vFlash;
varying vec3 vLocal;
void main() {
  vec3 c = uSilhouette > 0.5 ? uSilColor : applyFog(uInk, vWorldPos);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

function defines(o: EnemyMaterialOptions, outline: boolean): Record<string, string | number> {
  const d: Record<string, string | number> = {};
  if (o.bones && o.bones > 0) {
    d.USE_BONES = '';
    d.BONE_COUNT = o.bones;
  }
  if (o.instanced || o.spin) d.USE_INST_ATTR = '';
  if (o.spin) d.USE_SPIN = '';
  if (outline) d.OUTLINE = '';
  return d;
}

/** Per-material uniforms (the light rig uniforms are shared by reference). */
function ownUniforms(o: EnemyMaterialOptions, bones: THREE.Matrix4[] | null) {
  const L = o.look;
  return {
    uWarmRim: { value: tvec(palette.enemyRim, L.rimStrength) },
    uWarmRimPower: { value: L.rimPower },
    uRimWrap: { value: L.rimWrap },
    uStageRim: { value: L.stageRim },
    uHitFlash: { value: 0 },
    uSilhouette: { value: 0 },
    uFlashColor: { value: tvec(palette.hitFlash) },
    uSilColor: { value: tvec(palette.hazardBlack) },
    // channels: none, marker, thruster, charge | sequence, weak, vent, eye
    uChanA: { value: new THREE.Vector4(0, L.markerIntensity, L.thrusterIntensity, 0.6) },
    uChanB: { value: new THREE.Vector4(1.6, 0.6, 1.0, L.markerIntensity * 1.2) },
    uSeq: { value: 0 },
    uVentRate: { value: 2.2 },
    uEnemyTime: { value: 0 },
    uSeamSpacing: { value: o.seamSpacing ?? 1 },
    uSeamStrength: { value: L.seamStrength },
    uSpinTime: { value: 0 },
    uSpinRate: { value: 0 },
    uBones: { value: bones ?? [] },
    uOutlineNdc: { value: (2 * L.outlinePx) / 1080 },
    uInk: { value: tvec(shading.outline.color) },
  };
}

export type EnemyUniforms = ReturnType<typeof ownUniforms>;

export interface EnemyMaterialPair {
  body: THREE.ShaderMaterial;
  outline: THREE.ShaderMaterial | null;
  /** The per-material uniforms (body and outline share these objects). */
  u: EnemyUniforms;
  bones: THREE.Matrix4[] | null;
}

/** Build the body material (and the optional ink-outline material that shares its uniforms). */
export function createEnemyMaterial(o: EnemyMaterialOptions): EnemyMaterialPair {
  const bones = o.bones ? Array.from({ length: o.bones }, () => new THREE.Matrix4()) : null;
  const u = ownUniforms(o, bones);
  const body = new THREE.ShaderMaterial({
    uniforms: { ...lightUniforms, ...u },
    defines: defines(o, false),
    vertexShader: ENEMY_VERTEX,
    fragmentShader: FRAG,
  });
  body.userData.enemy = u;
  let outline: THREE.ShaderMaterial | null = null;
  if (o.look.outline) {
    outline = new THREE.ShaderMaterial({
      uniforms: { ...lightUniforms, ...u },
      defines: defines(o, true),
      vertexShader: ENEMY_VERTEX,
      fragmentShader: OUTLINE_FRAG,
      side: THREE.BackSide,
    });
    outline.userData.enemy = u;
  }
  return { body, outline, u, bones };
}

/** Mesh (+ optional outline mesh sharing the geometry) under a group. */
export function enemyMesh(geo: THREE.BufferGeometry, mp: EnemyMaterialPair, count = 0): THREE.Mesh[] {
  const mk = (m: THREE.ShaderMaterial) => (count > 0 ? new THREE.InstancedMesh(geo, m, count) : new THREE.Mesh(geo, m));
  const out: THREE.Mesh[] = [mk(mp.body)];
  if (mp.outline) {
    const o = mk(mp.outline);
    o.userData.outline = true;
    o.renderOrder = -1;
    out.push(o);
  }
  return out;
}

/** Set the flat-black silhouette test on every enemy material under root (flames hide). */
export function setEnemySilhouette(root: THREE.Object3D, on: boolean): void {
  root.traverse((c) => {
    const m = (c as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    if (!m || !(m as THREE.ShaderMaterial).userData) return;
    if (m.userData.enemy) m.userData.enemy.uSilhouette.value = on ? 1 : 0;
    if (m.userData.flame) c.visible = !on;
  });
}

/** Hit flash 0..1 on every enemy material under root (DESIGN: white for 2 frames). */
export function setEnemyHitFlash(root: THREE.Object3D, v: number): void {
  root.traverse((c) => {
    const m = (c as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    if (m && m.userData && m.userData.enemy) m.userData.enemy.uHitFlash.value = v;
  });
}

export const HIT_FLASH_FRAMES = vfx.hitFlashFrames;

// ---------------------------------------------------------------------------
// Flame material: thruster plumes. Normal alpha blending (not additive) so the
// orange stays visible on near-white cloud as well as on dark space.
// Geometry: cone along -Y from the nozzle (uv.y = 0 at nozzle, 1 at tip).
// ---------------------------------------------------------------------------
const FLAME_VERT = /* glsl */ `
#ifdef USE_INST_ATTR
attribute vec2 aInst;
#endif
varying float vPhase;
vec3 enemyPos;
vec3 enemyNrm;
#define position enemyPos
#define normal enemyNrm
#define main enemyStdMain
${GLSL_STD_VERTEX}
#undef main
#undef normal
#undef position
uniform float uFlameTime;
uniform float uFlameLen;
void main() {
  #ifdef USE_INST_ATTR
    vPhase = aInst.y;
  #else
    vPhase = 0.0;
  #endif
  float fl = uFlameLen * (0.86 + 0.14 * sin(uFlameTime * 41.0 + vPhase * 17.0) * sin(uFlameTime * 23.0 + vPhase * 5.0));
  enemyPos = vec3(position.x, position.y * fl, position.z);
  enemyNrm = normal;
  enemyStdMain();
}
`;

const FLAME_FRAG = /* glsl */ `
${GLSL_LIGHTING}
uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uFlameAlpha;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying float vPhase;
void main() {
  float t = clamp(vUv.y, 0.0, 1.0);
  vec3 n = normalize(vWorldNormal);
  vec3 v = normalize(cameraPosition - vWorldPos);
  float core = pow(abs(dot(n, v)), 1.5);
  vec3 c = mix(uEdge, uCore, core * (1.0 - t));
  float a = (1.0 - t) * (1.0 - t) * (0.55 + 0.45 * core) * uFlameAlpha;
  c = applyFog(c, vWorldPos);
  gl_FragColor = vec4(c, a);
  #include <colorspace_fragment>
}
`;

export function createFlameMaterial(instanced: boolean, intensity = 1): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      ...lightUniforms,
      uCore: { value: tvec(palette.exhaustCore, 1.4 * intensity) },
      uEdge: { value: tvec(palette.accentOrange, 1.1 * intensity) },
      uFlameAlpha: { value: 0.95 },
      uFlameTime: { value: 0 },
      uFlameLen: { value: 1 },
    },
    defines: instanced ? { USE_INST_ATTR: '' } : {},
    vertexShader: FLAME_VERT,
    fragmentShader: FLAME_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  m.userData.flame = true;
  return m;
}

/** Flame plume geometry: cone from the nozzle (y = 0, radius r) to a tip at y = -len. */
export function flameGeometry(r: number, len: number, sides = 8): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r * 0.18, len, sides, 3, true);
  g.translate(0, -len / 2, 0);
  // uv.y: 0 at nozzle -> 1 at tip (CylinderGeometry has v = 1 at the top)
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  return g;
}
