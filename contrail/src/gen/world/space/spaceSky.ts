/**
 * Wreckfield space sky: deep-space gradient, faint teal nebula veil (fbm),
 * a distant yellow planet in the stage key-light direction (terminator, bands,
 * atmosphere rim + halo), and an anti-aliased star field (gaussian point
 * sprites, sigma >= 0.7 px, energy conserved: no shimmer).
 *
 * Draw calls: 2 (dome + stars). Everything is camera-relative in the shader
 * (drawn at the far plane, depthTest off), so it works for any camera.
 */
import * as THREE from 'three';
import { palette, stages } from '../../../style/tokens';
import { mix, shade, tvec } from '../../../style/color';
import { Rng } from '../../../core/rng';
import { GLSL_NOISE } from './glslNoise';

export interface SpaceSkyParams {
  starCount: number;
  /** fraction of stars concentrated along the nebula belt */
  starBeltFraction: number;
  starBrightness: number;
  /** point size range in px at 1080p (energy-conserving below 1.4 px) */
  starSizePx: [number, number];
  starWarmFraction: number;
  twinkle: number;
  nebulaStrength: number;
  nebulaScale: number;
  /** roll of the nebula belt (radians, + rises to the right) */
  nebulaTilt: number;
  /** belt centre offset (sin of latitude, - = below the view axis) */
  nebulaOffset: number;
  nebulaWidth: number;
  /** warm scatter around the planet */
  nebulaWarmth: number;
  /** angular radius (radians); default = stages.wreckfield.sky.sunSize */
  planetSize: number;
  /** 0 = full disc lit, 1 = half lit (terminator through the centre) */
  planetPhase: number;
  planetBands: number;
  planetGlow: number;
  planetBrightness: number;
  /** keep the band of sky straight ahead darker (readability), 0..1 */
  centreCalm: number;
}

export const SPACE_SKY_DEFAULTS: SpaceSkyParams = {
  starCount: 5200,
  starBeltFraction: 0.35,
  starBrightness: 1.0,
  starSizePx: [0.7, 2.4],
  starWarmFraction: 0.22,
  twinkle: 0.06,
  nebulaStrength: 1.0,
  nebulaScale: 2.2,
  nebulaTilt: 0.32,
  nebulaOffset: -0.08,
  nebulaWidth: 0.34,
  nebulaWarmth: 0.6,
  planetSize: stages.wreckfield.sky.sunSize,
  planetPhase: 0.55,
  planetBands: 0.6,
  planetGlow: stages.wreckfield.sky.sunGlow,
  planetBrightness: 1.0,
  centreCalm: 0.45,
};

export interface SpaceSky {
  /** the sky dome mesh; the star Points are its child */
  mesh: THREE.Mesh;
  stars: THREE.Points;
  /** unit vector toward the planet (= stage key light) */
  planetDir: THREE.Vector3;
  update(cameraPos: THREE.Vector3, time: number): void;
  dispose(): void;
  stats: { triangles: number; points: number; drawCalls: number };
}

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  p.z = p.w; // far plane
  gl_Position = p;
}
`;

const DOME_FRAG = /* glsl */ `
${GLSL_NOISE}
varying vec3 vDir;
uniform vec3 uZenith; uniform vec3 uMid; uniform vec3 uHorizon; uniform float uMidHeight;
uniform vec3 uNeb; uniform vec3 uNebHi; uniform vec3 uDust; uniform vec3 uWarm;
uniform float uNebStrength; uniform float uNebScale; uniform float uNebWidth; uniform float uNebOffset; uniform float uNebWarmth;
uniform vec3 uBeltN; uniform float uCalm;
uniform vec3 uPlanetDir; uniform vec3 uPlanetSun; uniform vec3 uPlanetAxis; uniform float uPlanetR;
uniform float uPlanetGlow; uniform float uPlanetBands; uniform float uPlanetBright;
uniform vec3 uPlDay; uniform vec3 uPlBandDark; uniform vec3 uPlBandLight; uniform vec3 uPlNight; uniform vec3 uPlRim; uniform vec3 uPlTerm;

void main() {
  vec3 d = normalize(vDir);
  // base gradient measured from the tilted belt plane
  float lat = dot(d, uBeltN) - uNebOffset;
  float h = abs(lat);
  vec3 col = h < uMidHeight ? mix(uHorizon, uMid, smoothstep(0.0, uMidHeight, h)) : mix(uMid, uZenith, smoothstep(uMidHeight, 1.0, h));
  col = mix(uMid, col, 0.55);

  // nebula veil: warped fbm, concentrated in the belt, wisps elsewhere
  vec3 q = d * uNebScale;
  vec3 w = vec3(wfFbm3(q + vec3(3.1, 0.0, 1.7), 3), wfFbm3(q + vec3(-5.2, 2.4, 0.3), 3), wfFbm3(q + vec3(1.3, -4.1, 6.6), 3));
  float n = wfFbm3(q * 1.3 + (w - 0.5) * 1.6, 5);
  float belt = exp(-pow(lat / uNebWidth, 2.0));
  float veil = smoothstep(0.38, 0.85, n) * (0.35 + 0.65 * belt);
  float dust = smoothstep(0.52, 0.78, wfFbm3(q * 2.6 + w * 2.0, 4)) * belt;
  // readability: calm the region straight ahead of the flight corridor (-Z)
  float ahead = max(0.0, -d.z);
  float calm = 1.0 - uCalm * smoothstep(0.80, 0.99, ahead);
  vec3 neb = mix(uNeb, uNebHi, smoothstep(0.6, 1.0, n));
  col = mix(col, neb, clamp(veil * uNebStrength * calm, 0.0, 1.0));
  col = mix(col, uDust, dust * 0.55 * uNebStrength);

  // warm scatter around the planet (key light direction)
  float cp = dot(d, uPlanetDir);
  float ang = acos(clamp(cp, -1.0, 1.0));
  col += uWarm * uNebWarmth * (0.06 * exp(-ang / 0.55) + 0.05 * exp(-ang / 0.2)) * (0.6 + 0.4 * veil);

  // planet
  float R = uPlanetR;
  float aa = fwidth(ang) * 1.2 + 1e-5;
  vec3 tq = d - uPlanetDir * cp;             // tangent-plane offset, |tq| = sin(ang)
  float r = length(tq) / sin(R);
  vec3 tdir = tq / max(length(tq), 1e-6);
  vec3 sunT = normalize(uPlanetSun - uPlanetDir * dot(uPlanetSun, uPlanetDir) + 1e-5);
  float litSide = smoothstep(-0.4, 0.9, dot(tdir, sunT));
  if (ang < R * 1.02 && cp > 0.0) {
    float rr = min(r, 1.0);
    vec3 nrm = normalize(tq / sin(R) - uPlanetDir * sqrt(max(0.0, 1.0 - rr * rr)));
    float ndl = dot(nrm, uPlanetSun);
    // latitude bands on a tilted axis
    float la = dot(nrm, uPlanetAxis);
    float bn = wfFbm3(nrm * 3.0 + vec3(2.0), 4);
    float bands = sin(la * 17.0 + bn * 4.0) * 0.5 + 0.5;
    float fine = sin(la * 43.0 + bn * 7.0) * 0.5 + 0.5;
    vec3 day = mix(uPlDay, uPlBandDark, uPlanetBands * smoothstep(0.55, 0.9, bands) * 0.7);
    day = mix(day, uPlBandLight, uPlanetBands * smoothstep(0.7, 1.0, fine) * 0.35);
    // toon-ish terminator: lit plateau, soft band, warm edge
    float lit = smoothstep(-0.06, 0.16, ndl);
    float limb = mix(0.72, 1.0, sqrt(max(0.0, 1.0 - rr * rr)));
    vec3 pc = mix(uPlNight, day * (0.55 + 0.45 * smoothstep(0.1, 0.7, ndl)) * limb, lit);
    pc += uPlTerm * exp(-pow(ndl / 0.07, 2.0)) * 0.35;
    // atmosphere rim inside the limb, on the lit side
    pc += uPlRim * pow(rr, 7.0) * (0.15 + 0.85 * smoothstep(-0.2, 0.4, ndl)) * 0.8;
    float disc = 1.0 - smoothstep(R - aa, R + aa, ang);
    col = mix(col, pc * uPlanetBright, disc);
  }
  // halo outside the disc, strongest on the lit side
  float outside = max(0.0, ang - R);
  float halo = exp(-outside / (R * 0.35)) * uPlanetGlow * (0.25 + 0.75 * litSide);
  float ring = exp(-outside / (R * 0.035)) * (0.2 + 0.8 * litSide) * 0.55;
  col += uPlRim * (halo * 0.55 + ring) * step(R, ang) * uPlanetBright;

  // dither (about half an sRGB step at the current level)
  float dn = wfHash2(floor(gl_FragCoord.xy)) - 0.5;
  vec3 s = pow(max(col, vec3(1e-5)), vec3(1.0 / 2.2));
  col += dn * (2.2 / 255.0) * pow(s, vec3(1.2));
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  #include <colorspace_fragment>
}
`;

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aBright;
attribute vec3 aColor;
attribute float aPhase;
uniform float uViewH;
uniform float uTime;
uniform float uTwinkle;
uniform float uGain;
uniform vec3 uPlanetDir;
uniform float uPlanetCos;
varying vec3 vColor;
varying float vSigma;
varying float vHalf;
void main() {
  vec3 d = normalize(position);
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * d, 1.0);
  p.z = p.w;
  gl_Position = p;
  float s = aSize * uViewH / 1080.0;
  float sigma = max(0.5 * s, 0.7);
  // energy of the star ~ size^2 * brightness; spread over a wider gaussian when tiny
  float energy = aBright * s * s;
  float peak = energy / (4.0 * sigma * sigma);
  float tw = 1.0 + uTwinkle * sin(uTime * (1.3 + aPhase * 2.0) + aPhase * 40.0) * smoothstep(0.5, 1.0, aBright);
  float c = dot(d, uPlanetDir);
  float hide = 1.0 - smoothstep(uPlanetCos - 0.004, uPlanetCos + 0.0005, c);
  vColor = aColor * peak * tw * uGain * hide;
  vSigma = sigma;
  vHalf = ceil(sigma * 3.0) + 1.0;
  gl_PointSize = vHalf * 2.0;
}
`;

const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vSigma;
varying float vHalf;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * 2.0 * vHalf;
  float g = exp(-0.5 * dot(q, q) / (vSigma * vSigma));
  if (g < 0.004) discard;
  gl_FragColor = vec4(vColor * g, 1.0);
  #include <colorspace_fragment>
}
`;

/** Build the Wreckfield space sky. Pure function of (params, seed). */
export function buildSpaceSky(params: Partial<SpaceSkyParams> = {}, seed = 1): SpaceSky {
  const p: SpaceSkyParams = { ...SPACE_SKY_DEFAULTS, ...params };
  const rng = new Rng(seed).fork('spaceSky');
  const look = stages.wreckfield;
  const planetDir = new THREE.Vector3(...look.key.dir).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  // tangent toward screen-left-up of the planet (toward the frame centre)
  const T = new THREE.Vector3(-1, 0.45, 0);
  T.addScaledVector(planetDir, -T.dot(planetDir)).normalize();
  const ph = p.planetPhase * Math.PI * 0.5;
  const sun = planetDir.clone().multiplyScalar(-Math.cos(ph)).addScaledVector(T, Math.sin(ph)).normalize();
  const axis = up.clone().addScaledVector(planetDir, -up.dot(planetDir)).normalize().lerp(T, 0.25).normalize();
  const beltN = new THREE.Vector3(-Math.sin(p.nebulaTilt), Math.cos(p.nebulaTilt), 0).normalize();

  const domeGeo = new THREE.IcosahedronGeometry(1, 3);
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: tvec(look.sky.zenith) },
      uMid: { value: tvec(look.sky.mid) },
      uHorizon: { value: tvec(mix(look.sky.mid, look.sky.horizon, 0.55)) },
      uMidHeight: { value: look.sky.midHeight },
      uNeb: { value: tvec(palette.spaceNebula) },
      uNebHi: { value: tvec(mix(palette.spaceNebula, palette.skyHorizon, 0.16)) },
      uDust: { value: tvec(shade(palette.spaceDeep, 0.7)) },
      uWarm: { value: tvec(palette.debrisRim) },
      uNebStrength: { value: p.nebulaStrength },
      uNebScale: { value: p.nebulaScale },
      uNebWidth: { value: p.nebulaWidth },
      uNebOffset: { value: p.nebulaOffset },
      uNebWarmth: { value: p.nebulaWarmth },
      uBeltN: { value: beltN },
      uCalm: { value: p.centreCalm },
      uPlanetDir: { value: planetDir },
      uPlanetSun: { value: sun },
      uPlanetAxis: { value: axis },
      uPlanetR: { value: p.planetSize },
      uPlanetGlow: { value: p.planetGlow },
      uPlanetBands: { value: p.planetBands },
      uPlanetBright: { value: p.planetBrightness },
      uPlDay: { value: tvec(palette.planetYellow) },
      uPlBandDark: { value: tvec(mix(palette.planetYellow, palette.debrisRim, 0.75), 0.82) },
      uPlBandLight: { value: tvec(mix(palette.planetYellow, palette.sunCore, 0.55)) },
      uPlNight: { value: tvec(mix(palette.spaceDeep, palette.debrisDark, 0.6), 0.8) },
      uPlRim: { value: tvec(mix(palette.planetYellow, palette.sunCore, 0.35)) },
      uPlTerm: { value: tvec(palette.debrisRim) },
    },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(domeGeo, domeMat);
  mesh.name = 'spaceSky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;

  // --- stars ---
  const N = Math.max(0, Math.round(p.starCount));
  const pos = new Float32Array(N * 3);
  const size = new Float32Array(N);
  const bright = new Float32Array(N);
  const col = new Float32Array(N * 3);
  const phase = new Float32Array(N);
  const cool = tvec(mix(palette.smokeLit, palette.skyHorizon, 0.45));
  const white = tvec(palette.smokeLit);
  const warm = tvec(mix(palette.sunCore, palette.planetYellow, 0.45));
  const blue = tvec(mix(palette.canopyBlue, palette.smokeLit, 0.6));
  const v = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    // uniform on the sphere, or concentrated near the belt
    for (let tries = 0; tries < 20; tries++) {
      const z = rng.signed();
      const a = rng.next() * Math.PI * 2;
      const rr = Math.sqrt(1 - z * z);
      v.set(rr * Math.cos(a), z, rr * Math.sin(a));
      if (i >= N * p.starBeltFraction) break;
      const lat = v.dot(beltN) - p.nebulaOffset;
      if (rng.next() < Math.exp(-(lat * lat) / (p.nebulaWidth * p.nebulaWidth * 0.5))) break;
    }
    pos[i * 3] = v.x;
    pos[i * 3 + 1] = v.y;
    pos[i * 3 + 2] = v.z;
    const u = rng.next();
    const b = Math.pow(u, 3.2); // many faint, few bright
    bright[i] = (0.16 + 0.84 * b) * p.starBrightness;
    size[i] = p.starSizePx[0] + (p.starSizePx[1] - p.starSizePx[0]) * Math.pow(rng.next(), 2.2) * (0.45 + 0.55 * b);
    const k = rng.next();
    const c = k < p.starWarmFraction ? warm : k < p.starWarmFraction + 0.12 ? blue : rng.chance(0.5) ? cool : white;
    col[i * 3] = c.x;
    col[i * 3 + 1] = c.y;
    col[i * 3 + 2] = c.z;
    phase[i] = rng.next();
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  sg.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
  sg.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const starMat = new THREE.ShaderMaterial({
    uniforms: {
      uViewH: { value: 1080 },
      uTime: { value: 0 },
      uTwinkle: { value: p.twinkle },
      uGain: { value: 1.0 },
      uPlanetDir: { value: planetDir },
      uPlanetCos: { value: Math.cos(p.planetSize * 1.03) },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: true, // at the far plane (z = w): hidden behind any geometry
    depthWrite: false,
  });
  const stars = new THREE.Points(sg, starMat);
  stars.name = 'spaceStars';
  stars.frustumCulled = false;
  stars.renderOrder = -999;
  const vp = new THREE.Vector4();
  stars.onBeforeRender = (renderer) => {
    renderer.getCurrentViewport(vp);
    starMat.uniforms.uViewH.value = vp.w > 0 ? vp.w : 1080;
  };
  mesh.add(stars);

  return {
    mesh,
    stars,
    planetDir,
    update(cameraPos: THREE.Vector3, time: number) {
      mesh.position.copy(cameraPos);
      starMat.uniforms.uTime.value = time;
    },
    dispose() {
      domeGeo.dispose();
      domeMat.dispose();
      sg.dispose();
      starMat.dispose();
    },
    stats: { triangles: domeGeo.index ? domeGeo.index.count / 3 : domeGeo.attributes.position.count / 3, points: N, drawCalls: 2 },
  };
}
