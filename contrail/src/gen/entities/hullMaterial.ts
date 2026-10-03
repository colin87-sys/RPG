/**
 * Hard-surface hull material (KESTREL, reusable by other hard-surface entities)
 * plus the geometry format it expects (HullBuilder).
 *
 * Shading (on the shared rig: lightUniforms + GLSL_LIGHTING + GLSL_STD_VERTEX):
 *  - toon ramp key light, cool shadow tint, hemisphere ambient (shadeToon)
 *  - stepped toon specular, fresnel rim (rimTerm), shared fog (applyFog)
 *  - panel seams: per-face metric edge distances baked by HullBuilder (aEdge),
 *    anti-aliased with fwidth and held at >= ~1 px so they survive the chase cam
 *  - surface kinds: paint, glass (canopy), insert (emissive grille), hot (nozzle core),
 *    matte (intakes), trim (lit + slight glow)
 *  - emblem decal: planar object-space projection of a canvas texture on flagged faces
 *  - uHitFlash (0..1 lerp to the hitFlash token) and uSilhouette (1 = flat black)
 *  - moving parts (flaps/fins) deform in the vertex shader from uPart[] matrices,
 *    so the whole hull stays ONE draw call; the inverted-hull outline shares them.
 */
import * as THREE from 'three';
import { GLSL_LIGHTING, GLSL_STD_VERTEX, lightUniforms } from '../common/lighting';
import { palette, shading } from '../../style/tokens';
import { tvec } from '../../style/color';
import { getEmblemTexture } from './emblem';

export const HULL_MAX_PARTS = 8;
export const HULL_MAX_DECALS = 4;

/** Surface kinds, stored in aMat.y. */
export const SURF = { paint: 0, glass: 1, insert: 2, hot: 3, matte: 4, trim: 5 } as const;

export interface FaceStyle {
  /** albedo token hex */
  color: string;
  kind?: number;
  /** emissive strength (insert / hot / trim) */
  emissive?: number;
  /** moving part id 0..HULL_MAX_PARTS-1 (0 = static) */
  part?: number;
  /** decal slot 1..HULL_MAX_DECALS (0 = none) */
  decal?: number;
  /** albedo multiplier for per-panel value variation */
  jitter?: number;
  /** > 1 widens seams on this face (canopy frames, insert frames) */
  seamScale?: number;
  /** include in the inverted-hull outline shell (default true) */
  outline?: boolean;
}

type V3 = THREE.Vector3;
const BIG = 1000;
const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _n = new THREE.Vector3();

function distToLine(p: V3, a: V3, b: V3): number {
  _ab.subVectors(b, a);
  _ac.subVectors(p, a);
  const l = _ab.length();
  if (l < 1e-9) return _ac.length();
  return _n.crossVectors(_ab, _ac).length() / l;
}

/** Part / decal mirror maps: odd ids are starboard (+X), the next even id is port. */
function mirrorId(id: number): number {
  if (id <= 0) return id;
  return id % 2 === 1 ? id + 1 : id - 1;
}

/**
 * Accumulates flat-shaded, non-indexed triangles with the attributes the hull
 * material reads: aAlbedo (linear rgb), aEdge (seam edge distances, metres),
 * aMat (emissive, kind, part, decal). Set `mirror = true` to also emit the
 * X-mirrored copy (port side) of everything added.
 */
export class HullBuilder {
  mirror = false;
  private P: number[] = [];
  private N: number[] = [];
  private A: number[] = [];
  private E: number[] = [];
  private M: number[] = [];
  private triComp: number[] = [];
  private triOutline: number[] = [];
  private comp = 0;
  private colors = new Map<string, THREE.Color>();

  /** Start a new connected component (outline normals are smoothed per component). */
  newComponent(): number {
    return ++this.comp;
  }

  get triangleCount(): number {
    return this.P.length / 9;
  }

  private col(hex: string): THREE.Color {
    let c = this.colors.get(hex);
    if (!c) {
      c = new THREE.Color(hex);
      this.colors.set(hex, c);
    }
    return c;
  }

  private emit(a: V3, b: V3, c: V3, n: V3, s: FaceStyle, sab: boolean, sbc: boolean, sca: boolean, radial: boolean, mirrored: boolean) {
    const k = 1 / (s.seamScale ?? 1);
    let ha: number, hb: number, hc: number;
    let ox: number, oy: number, oz: number;
    if (radial) {
      ha = 1; hb = 0; hc = 0; ox = 0; oy = BIG; oz = BIG;
    } else {
      ha = distToLine(a, b, c) * k;
      hb = distToLine(b, c, a) * k;
      hc = distToLine(c, a, b) * k;
      ox = sbc ? 0 : BIG;
      oy = sca ? 0 : BIG;
      oz = sab ? 0 : BIG;
    }
    const cc = this.col(s.color);
    const j = s.jitter ?? 1;
    const part = mirrored ? mirrorId(s.part ?? 0) : s.part ?? 0;
    const decal = mirrored ? mirrorId(s.decal ?? 0) : s.decal ?? 0;
    const verts = [a, b, c];
    const edges = [
      [ha + ox, oy, oz],
      [ox, hb + oy, oz],
      [ox, oy, hc + oz],
    ];
    for (let i = 0; i < 3; i++) {
      const v = verts[i];
      this.P.push(v.x, v.y, v.z);
      this.N.push(n.x, n.y, n.z);
      this.A.push(cc.r * j, cc.g * j, cc.b * j);
      this.E.push(edges[i][0], edges[i][1], edges[i][2]);
      this.M.push(s.emissive ?? 0, s.kind ?? SURF.paint, part, decal);
    }
    this.triComp.push(this.comp * 2 + (mirrored ? 1 : 0));
    this.triOutline.push(s.outline === false ? 0 : 1);
  }

  /** Triangle with seam flags for edges ab, bc, ca. `normal` overrides the face normal. */
  tri(a: V3, b: V3, c: V3, s: FaceStyle, seams: [boolean, boolean, boolean] = [true, true, true], normal?: V3, radial = false) {
    const n = normal ? normal.clone().normalize() : new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.lengthSq() < 1e-14) return;
    n.normalize();
    this.emit(a, b, c, n, s, seams[0], seams[1], seams[2], radial, false);
    if (this.mirror) {
      const m = (v: V3) => new THREE.Vector3(-v.x, v.y, v.z);
      const nm = new THREE.Vector3(-n.x, n.y, n.z);
      // swapped winding (a, c, b): edges ac(=ca), cb(=bc), ba(=ab)
      this.emit(m(a), m(c), m(b), nm, s, seams[2], seams[1], seams[0], radial, true);
    }
  }

  /** Planar-ish quad a-b-c-d (counter-clockwise seen from outside). Seam flags: ab, bc, cd, da. */
  quad(a: V3, b: V3, c: V3, d: V3, s: FaceStyle, seams: [boolean, boolean, boolean, boolean] = [true, true, true, true]) {
    // Newell normal so both triangles shade as one panel
    const pts = [a, b, c, d];
    const n = new THREE.Vector3();
    for (let i = 0; i < 4; i++) {
      const p = pts[i], q = pts[(i + 1) % 4];
      n.x += (p.y - q.y) * (p.z + q.z);
      n.y += (p.z - q.z) * (p.x + q.x);
      n.z += (p.x - q.x) * (p.y + q.y);
    }
    if (n.lengthSq() < 1e-14) return;
    n.normalize();
    this.tri(a, b, c, s, [seams[0], seams[1], false], n);
    this.tri(a, c, d, s, [false, seams[2], seams[3]], n);
  }

  /** Convex polygon fan (counter-clockwise seen from outside). seams[i] = edge p[i] -> p[i+1]. */
  poly(p: V3[], s: FaceStyle, seams?: boolean[]) {
    const n = p.length;
    const n0 = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n];
      n0.x += (a.y - b.y) * (a.z + b.z);
      n0.y += (a.z - b.z) * (a.x + b.x);
      n0.z += (a.x - b.x) * (a.y + b.y);
    }
    if (n0.lengthSq() < 1e-14) return;
    for (let i = 1; i < n - 1; i++) {
      const sab = i === 1 ? (seams ? seams[0] : true) : false;
      const sbc = seams ? seams[i] : true;
      const sca = i === n - 2 ? (seams ? seams[n - 1] : true) : false;
      this.tri(p[0], p[i], p[i + 1], s, [sab, sbc, sca], n0);
    }
  }

  /** Triangle fan with a radial coordinate (1 at the centre, 0 at the rim) for SURF.hot discs. */
  radialFan(center: V3, rim: V3[], s: FaceStyle) {
    for (let i = 0; i < rim.length; i++) {
      this.tri(center, rim[i], rim[(i + 1) % rim.length], s, [false, false, false], undefined, true);
    }
  }

  build(): { geometry: THREE.BufferGeometry; outline: THREE.BufferGeometry } {
    const g = new THREE.BufferGeometry();
    const nv = this.P.length / 3;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(nv * 2), 2));
    g.setAttribute('aAlbedo', new THREE.Float32BufferAttribute(this.A, 3));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(this.E, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.M, 4));
    g.computeBoundingBox();
    g.computeBoundingSphere();

    // Outline shell: merge vertices per component/part, angle-weighted smooth normals.
    const map = new Map<string, number>();
    const op: number[] = [];
    const on: number[] = [];
    const om: number[] = [];
    const idx: number[] = [];
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
    const T = this.triComp.length;
    for (let t = 0; t < T; t++) {
      if (!this.triOutline[t]) continue;
      const base = t * 9;
      va.fromArray(this.P, base);
      vb.fromArray(this.P, base + 3);
      vc.fromArray(this.P, base + 6);
      fn.fromArray(this.N, base);
      const vs = [va, vb, vc];
      for (let i = 0; i < 3; i++) {
        const v = vs[i];
        const part = this.M[(t * 3 + i) * 4 + 2];
        const key = `${this.triComp[t]}|${part}|${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
        let id = map.get(key);
        if (id === undefined) {
          id = op.length / 3;
          map.set(key, id);
          op.push(v.x, v.y, v.z);
          on.push(0, 0, 0);
          om.push(0, 0, part, 0);
        }
        e1.subVectors(vs[(i + 1) % 3], v).normalize();
        e2.subVectors(vs[(i + 2) % 3], v).normalize();
        const ang = Math.acos(THREE.MathUtils.clamp(e1.dot(e2), -1, 1));
        on[id * 3] += fn.x * ang;
        on[id * 3 + 1] += fn.y * ang;
        on[id * 3 + 2] += fn.z * ang;
        idx.push(id);
      }
    }
    for (let i = 0; i < on.length; i += 3) {
      const l = Math.hypot(on[i], on[i + 1], on[i + 2]) || 1;
      on[i] /= l; on[i + 1] /= l; on[i + 2] /= l;
    }
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', new THREE.Float32BufferAttribute(op, 3));
    og.setAttribute('normal', new THREE.Float32BufferAttribute(on, 3));
    og.setAttribute('aMat', new THREE.Float32BufferAttribute(om, 4));
    og.setIndex(idx);
    og.computeBoundingSphere();
    return { geometry: g, outline: og };
  }
}

/** Look parameters for the hull material (all colours are token hex). */
export interface HullLook {
  seamWidth: number;
  seamDarkness: number;
  specular: number;
  specPower: number;
  rim: number;
  insertGlow: number;
  glass: string;
  glassDeep: string;
  insert: string;
  insertHot: string;
  frame: string;
  outlineColor: string;
  /** world width at 9 m for a 68 deg FOV; scales with view height so it stays ~constant in pixels */
  outlineWidth: number;
  silhouette: string;
  hit: string;
}

export const DEFAULT_HULL_LOOK: HullLook = {
  seamWidth: shading.seamWidth,
  seamDarkness: shading.seamDarkness,
  specular: shading.specular.strength,
  specPower: shading.specular.power,
  rim: 1,
  insertGlow: 1,
  glass: palette.canopyBlue,
  glassDeep: palette.spaceDeep,
  insert: palette.accentOrange,
  insertHot: palette.exhaustCore,
  frame: palette.armourDark,
  outlineColor: shading.outline.color,
  outlineWidth: shading.outline.widthHero,
  silhouette: palette.emblemBlack,
  hit: palette.hitFlash,
};

const HULL_HEAD = /* glsl */ `
attribute vec3 aAlbedo;
attribute vec3 aEdge;
attribute vec4 aMat;
uniform mat4 uPart[${HULL_MAX_PARTS}];
varying vec3 vAlbedo;
varying vec3 vEdge;
varying vec4 vMat;
varying vec3 vObjPos;
`;
const ANCHOR = 'vec3 nrm = normal;';
const INJECT = /* glsl */ `
  {
    mat4 PM = uPart[int(aMat.z + 0.5)];
    p = PM * p;
    nrm = mat3(PM) * nrm;
  }
  vAlbedo = aAlbedo; vEdge = aEdge; vMat = aMat; vObjPos = p.xyz;`;
// Fallback mirrors GLSL_STD_VERTEX's contract if its text ever changes.
const FALLBACK_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 p = vec4(position, 1.0);
  vec3 nrm = normal;${INJECT}
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
    nrm = mat3(instanceMatrix) * nrm;
  #endif
  vec4 wp = modelMatrix * p;
  vWorldPos = wp.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * nrm);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const HULL_VERTEX = HULL_HEAD + (GLSL_STD_VERTEX.includes(ANCHOR) ? GLSL_STD_VERTEX.replace(ANCHOR, ANCHOR + INJECT) : FALLBACK_VERTEX);

const HULL_FRAGMENT = /* glsl */ `
${GLSL_LIGHTING}
uniform sampler2D uEmblem;
uniform vec4 uDecal[${HULL_MAX_DECALS}];
uniform float uSeamWidth;
uniform float uSeamDark;
uniform float uSpecPower;
uniform float uSpecStrength;
uniform float uRimMul;
uniform float uHitFlash;
uniform float uSilhouette;
uniform float uGlow;
uniform float uHeat;
uniform vec3 uHitColor;
uniform vec3 uSilColor;
uniform vec3 uGlass;
uniform vec3 uGlassDeep;
uniform vec3 uInsert;
uniform vec3 uInsertHot;
uniform vec3 uFrame;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec2 vUv;
varying vec3 vAlbedo;
varying vec3 vEdge;
varying vec4 vMat;
varying vec3 vObjPos;

void main() {
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float kind = vMat.y;
  vec3 albedo = vAlbedo;

  // --- panel seams from baked edge distances (metres) ---
  float d = min(min(vEdge.x, vEdge.y), vEdge.z);
  float fw = max(fwidth(d), 1e-5);
  float hw = max(0.5 * uSeamWidth, 0.6 * fw);
  float seam = 1.0 - smoothstep(hw - 0.5 * fw, hw + 0.5 * fw, d);
  // fade out once seams would be sub-pixel noise (beyond ~50 m at 1080p)
  seam *= clamp(1.0 - (fw - 0.05) / 0.05, 0.0, 1.0);

  // --- emblem decal (planar projection in object XZ, forward = texture up) ---
  float decalA = 0.0;
  if (vMat.w > 0.5) {
    vec4 D = uDecal[int(vMat.w + 0.5) - 1];
    vec2 duv = (vObjPos.xz - D.xy) / D.z;
    vec2 tuv = vec2(duv.x * D.w, -duv.y) * 0.5 + 0.5;
    if (tuv.x >= 0.0 && tuv.x <= 1.0 && tuv.y >= 0.0 && tuv.y <= 1.0) {
      vec4 e = texture2D(uEmblem, tuv);
      decalA = e.a;
      albedo = mix(albedo, e.rgb, e.a);
      seam *= 1.0 - e.a;
    }
  }

  vec3 H = normalize(normalize(uKeyDir) + V);
  float ndh = max(dot(N, H), 0.0);
  vec3 col;
  if (kind < 0.5 || kind > 4.5) {
    // painted armour (0) and trim (5)
    albedo *= 1.0 - seam * uSeamDark;
    col = shadeToon(albedo, N);
    float sp = smoothstep(0.3, 0.6, pow(ndh, uSpecPower)) * uSpecStrength;
    col += uKeyColor * sp * (1.0 - seam) * 0.6;
    col += rimTerm(N, V) * uRimMul;
    // clear coat: fresnel reflection of sky above / lit cloud or haze below, plus a
    // thin horizon-line glint (stylised car-paint read; stays under the toon shading)
    vec3 Rc = reflect(-V, N);
    float fresC = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
    vec3 envC = mix(uAmbGround * 1.2 + uFogColor * 0.25, uAmbSky * 1.25, smoothstep(0.38, 0.62, Rc.y * 0.5 + 0.5));
    col = mix(col, envC, fresC * 0.32 * (1.0 - seam));
    col += uFogFar * (1.0 - smoothstep(0.0, 0.05, abs(Rc.y))) * 0.1 * (1.0 - seam) * (0.3 + fresC);
    if (kind > 4.5) col += albedo * vMat.x * uGlow;
  } else if (kind < 1.5) {
    // canopy glass: deep-to-blue body, sky reflection by reflected up, sharp key streak
    vec3 R = reflect(-V, N);
    float up = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 env = mix(uAmbGround * 0.5, uAmbSky * 1.3 + uKeyColor * 0.08, smoothstep(0.4, 0.8, up));
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    vec3 base = mix(uGlassDeep, uGlass, 0.45 + 0.55 * clamp(N.y, 0.0, 1.0));
    col = base * (0.45 + 0.55 * rampLight(N));
    col = mix(col, env, 0.2 + 0.55 * fres);
    col += uKeyColor * smoothstep(0.25, 0.5, pow(ndh, 80.0)) * 0.9;
    col += rimTerm(N, V) * uRimMul * 0.6;
    col = mix(col, shadeToon(uFrame, N), seam * 0.95);
  } else if (kind < 2.5) {
    // emissive insert grille: bright bars across Z inside a dark frame
    float fr = 1.0 - smoothstep(hw * 3.5 - fw, hw * 3.5 + fw, d);
    float b = fract(vObjPos.z * 7.0);
    float bar = smoothstep(0.06, 0.16, b) * (1.0 - smoothstep(0.66, 0.76, b));
    float g = vMat.x * uGlow;
    vec3 hot = mix(uInsert, uInsertHot, 0.45 * bar);
    col = mix(uInsert * 0.45, hot * 1.15, bar) * g;
    col = mix(col, shadeToon(uFrame, N), fr);
  } else if (kind < 3.5) {
    // hot nozzle core: radial ramp orange -> exhaust core
    float r = clamp(vEdge.x, 0.0, 1.0);
    col = mix(uInsert * 0.8, uInsertHot * 1.2, smoothstep(0.15, 0.85, r)) * (0.55 + 0.6 * uHeat) * max(vMat.x, 0.2);
  } else {
    // matte interior (intakes, nozzle walls)
    col = shadeToon(albedo, N) * 0.8 + rimTerm(N, V) * uRimMul * 0.25;
  }

  col = applyFog(col, vWorldPos);
  col = mix(col, uHitColor, clamp(uHitFlash, 0.0, 1.0));
  col = mix(col, uSilColor, uSilhouette);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const OUTLINE_VERTEX = /* glsl */ `
attribute vec4 aMat;
uniform mat4 uPart[${HULL_MAX_PARTS}];
uniform float uOutlineWidth;
varying vec3 vWorldPos;
void main() {
  vec4 p = vec4(position, 1.0);
  vec3 nrm = normal;
  mat4 PM = uPart[int(aMat.z + 0.5)];
  p = PM * p;
  nrm = mat3(PM) * nrm;
  vec4 wp = modelMatrix * p;
  vec3 wn = normalize(mat3(modelMatrix) * nrm);
  float persp = 1.0 - projectionMatrix[3][3];
  float dist = length(cameraPosition - wp.xyz);
  float viewH = 2.0 * mix(1.0, dist, persp) / projectionMatrix[1][1];
  wp.xyz += wn * uOutlineWidth * viewH / 12.1;
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const OUTLINE_FRAGMENT = /* glsl */ `
${GLSL_LIGHTING}
uniform vec3 uOutlineColor;
uniform vec3 uSilColor;
uniform float uSilhouette;
varying vec3 vWorldPos;
void main() {
  vec3 c = applyFog(uOutlineColor, vWorldPos);
  c = mix(c, uSilColor, uSilhouette);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

export interface HullMaterials {
  hull: THREE.ShaderMaterial;
  outline: THREE.ShaderMaterial;
  /** part matrices (index 0 must stay identity); edit in place, shared by hull + outline */
  parts: THREE.Matrix4[];
  /** decal slots: (centre x, centre z, radius, u flip) in object space */
  decals: THREE.Vector4[];
  setHitFlash(v: number): void;
  setSilhouette(on: boolean): void;
  /** emissive insert multiplier (throttle/boost pulse) */
  setGlow(v: number): void;
  /** nozzle core heat 0..1.5 */
  setHeat(v: number): void;
  dispose(): void;
}

/** Hull + outline materials sharing part/decal/silhouette uniforms. */
export function createHullMaterials(look: Partial<HullLook> = {}, emblem: THREE.Texture = getEmblemTexture()): HullMaterials {
  const L: HullLook = { ...DEFAULT_HULL_LOOK, ...look };
  const parts = Array.from({ length: HULL_MAX_PARTS }, () => new THREE.Matrix4());
  const decals = Array.from({ length: HULL_MAX_DECALS }, () => new THREE.Vector4(0, 0, 1, 1));
  const shared = {
    uPart: { value: parts },
    uSilhouette: { value: 0 },
    uSilColor: { value: tvec(L.silhouette) },
  };
  const hull = new THREE.ShaderMaterial({
    name: 'hull',
    uniforms: {
      ...lightUniforms,
      ...shared,
      uEmblem: { value: emblem },
      uDecal: { value: decals },
      uSeamWidth: { value: L.seamWidth },
      uSeamDark: { value: L.seamDarkness },
      uSpecPower: { value: L.specPower },
      uSpecStrength: { value: L.specular },
      uRimMul: { value: L.rim },
      uHitFlash: { value: 0 },
      uGlow: { value: L.insertGlow },
      uHeat: { value: 1 },
      uHitColor: { value: tvec(L.hit) },
      uGlass: { value: tvec(L.glass) },
      uGlassDeep: { value: tvec(L.glassDeep) },
      uInsert: { value: tvec(L.insert) },
      uInsertHot: { value: tvec(L.insertHot) },
      uFrame: { value: tvec(L.frame) },
    },
    vertexShader: HULL_VERTEX,
    fragmentShader: HULL_FRAGMENT,
  });
  const outline = new THREE.ShaderMaterial({
    name: 'hullOutline',
    uniforms: {
      ...lightUniforms,
      ...shared,
      uOutlineWidth: { value: L.outlineWidth },
      uOutlineColor: { value: tvec(L.outlineColor) },
    },
    vertexShader: OUTLINE_VERTEX,
    fragmentShader: OUTLINE_FRAGMENT,
    side: THREE.BackSide,
  });
  const baseGlow = L.insertGlow;
  return {
    hull,
    outline,
    parts,
    decals,
    setHitFlash: (v) => (hull.uniforms.uHitFlash.value = v),
    setSilhouette: (on) => (shared.uSilhouette.value = on ? 1 : 0),
    setGlow: (v) => (hull.uniforms.uGlow.value = baseGlow * v),
    setHeat: (v) => (hull.uniforms.uHeat.value = v),
    dispose: () => {
      hull.dispose();
      outline.dispose();
    },
  };
}

/** Convenience: just the hull ShaderMaterial (no outline). */
export function createHullMaterial(look: Partial<HullLook> = {}): THREE.ShaderMaterial {
  return createHullMaterials(look).hull;
}
