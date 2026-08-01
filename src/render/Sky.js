/**
 * Sky — the atmosphere, the celestial bodies and all outdoor lighting colour.
 *
 * The dome is one inverted box carrying a single ShaderMaterial that does real
 * analytic scattering (see `shaders/skyAtmosphere.js`). Everything the player
 * sees outdoors is keyed off it: `Lighting.js` takes the key direction and
 * colour from here, `scene.fog` is set from the horizon radiance this dome is
 * actually painting, and `renderer.toneMappingExposure` follows the ART_BIBLE
 * time-of-day table.
 *
 * Three decisions worth knowing before editing anything:
 *
 * 1. **Physical base, calibrated transform.** The scattering integral owns all
 *    of the angular structure — the aureole, the azimuthal asymmetry, the
 *    twilight wedge, the Belt of Venus. It does not own the final chroma. Two
 *    tint uniforms re-key the dome onto the ART_BIBLE zenith/horizon values,
 *    and those tints are solved *through the ACES tone curve*, so the hex in
 *    the bible is the hex on the screen rather than a number buried in the HDR
 *    buffer. A hand-authored gradient would have been far easier and would have
 *    failed the brief's "sun position must drive colour across the whole dome".
 *
 * 2. **The moon is the ring.** WORLD_BIBLE.md shattered Erevane's moon into an
 *    orbital ring; the brief asks for a cratered moon with a correct phase.
 *    Both render, as the same object: the ring is the debris band and the
 *    "moon" is Lunareth's largest surviving shard riding on it, lit by the real
 *    sun direction so its phase is never authored and never wrong.
 *
 * 3. **`sunColor` reports what the dome renders.** The sun tint uniform is
 *    derived from the reported colour rather than the other way round, so the
 *    key light and the disc in frame cannot drift apart.
 *
 * OWNED BY: render/Sky.js + render/shaders/sky*.js.
 */
import * as THREE from 'three';
import { bus } from '../core/EventBus.js';
import { gameState, rng } from '../core/GameState.js';
import { SKY_VERT } from './shaders/skyAtmosphere.js';
import { buildSkyFragment } from './shaders/skyFragment.js';
import { makeAtmosphereParams, skyRadiance, sunTransmittance } from './shaders/skyModel.js';

/* -------------------------------------------------------------------------- */
/* ART_BIBLE.md section 3 — the four time-of-day keys, verbatim.               */
/* -------------------------------------------------------------------------- */

/**
 * Keys sit at t = 0.00 / 0.25 / 0.50 / 0.75 and wrap. Every field is
 * interpolated with a periodic Catmull-Rom rather than a piecewise lerp: a lerp
 * is only C0, and its slope discontinuity at each key shows up as a visible
 * kick in exposure and fog density whenever time scrubs through dawn or dusk —
 * which the no-popping requirement forbids.
 *
 * `elevation` and `turbidity` are ours, not the bible's. The bible pins dawn to
 * 8 degrees and noon to 62; dusk gets 6 (slightly lower than dawn, so the hero
 * key is the redder of the two twilights) and midnight -20 (deep enough for a
 * genuinely dark sky, shallow enough that the ozone twilight band never fully
 * dies). Turbidity rises at dawn and dusk because more aerosol is physically
 * what makes the aureole large and the sun red.
 */
const TOD_KEYS = [
  {
    name: 'night',
    sun: 0xa8c8e8, sunIntensity: 0.9,
    zenith: 0x0b1226, horizon: 0x1e3050,
    fog: 0x16283c, fogDensity: 0.0035,
    exposure: 1.25, ambient: 0.18,
    elevation: -20, turbidity: 0.8, ringAlpha: 1.0,
  },
  {
    name: 'dawn',
    sun: 0xff9e5e, sunIntensity: 2.2,
    zenith: 0x2a3e66, horizon: 0xffb37e,
    fog: 0xc58a6b, fogDensity: 0.0045,
    exposure: 1.05, ambient: 0.35,
    elevation: 8, turbidity: 1.7, ringAlpha: 0.15,
  },
  {
    name: 'noon',
    sun: 0xffead0, sunIntensity: 3.0,
    zenith: 0x33628f, horizon: 0xbfd9e2,
    fog: 0xa8c4cc, fogDensity: 0.0018,
    exposure: 1.0, ambient: 0.55,
    elevation: 62, turbidity: 1.0, ringAlpha: 0.04,
  },
  {
    name: 'dusk',
    sun: 0xff6b3d, sunIntensity: 2.4,
    zenith: 0x35275e, horizon: 0xff9e6b,
    fog: 0x8a5e7a, fogDensity: 0.0055,
    exposure: 1.15, ambient: 0.3,
    elevation: 6, turbidity: 2.1, ringAlpha: 0.6,
  },
];

/** Palette constants used directly by the dome (ART_BIBLE section 2.1). */
const RING_GLOW = 0x5fb8b0;
const FOG_FAR = 0xc4b49a;

/** Base HDR radiance of the solar disc, pre-tonemap. Deliberately far above
 *  1.0 so the disc clips to white and gives the bloom pass something real to
 *  overspill from — ART_BIBLE section 2.3 explicitly allows the sun through. */
const SUN_DISC_RADIANCE = 26;

/**
 * Weather presets. No preset drops cloud coverage below 0.20: REFERENCE_TARGET
 * section 4 is explicit that the reference frames always carry visible cloud
 * structure, so "clear" here means fair-weather cumulus, not an empty sky.
 */
const WEATHER = {
  clear: {
    coverage: 0.42, coverageHigh: 0.30, density: 1.0, absorb: 1.0,
    tint: 0xffffff, turbidity: 1.0, mieG: 0.78, fogMul: 1.0, sunMul: 1.0,
    aurora: 0, ash: 0, storm: 0, starMul: 1.0, milkyMul: 1.0, windMul: 1.0,
    altitude: 2.2, thickness: 1.5, detail: 0.35,
  },
  overcast: {
    coverage: 0.88, coverageHigh: 0.60, density: 1.5, absorb: 1.7,
    tint: 0xb6c0c6, turbidity: 2.4, mieG: 0.60, fogMul: 2.0, sunMul: 0.40,
    aurora: 0, ash: 0, storm: 0, starMul: 0.12, milkyMul: 0.05, windMul: 1.3,
    altitude: 1.5, thickness: 2.2, detail: 0.22,
  },
  storm: {
    coverage: 0.95, coverageHigh: 0.78, density: 2.1, absorb: 2.5,
    tint: 0x6e7880, turbidity: 3.4, mieG: 0.52, fogMul: 3.0, sunMul: 0.22,
    aurora: 0, ash: 0, storm: 1, starMul: 0.03, milkyMul: 0.0, windMul: 2.4,
    altitude: 1.2, thickness: 3.0, detail: 0.30,
  },
  aurora: {
    coverage: 0.20, coverageHigh: 0.34, density: 0.7, absorb: 0.9,
    tint: 0xc6d4dc, turbidity: 0.75, mieG: 0.80, fogMul: 0.8, sunMul: 1.0,
    aurora: 1, ash: 0, storm: 0, starMul: 1.2, milkyMul: 1.3, windMul: 0.7,
    altitude: 2.6, thickness: 1.2, detail: 0.40,
  },
  ash: {
    coverage: 0.72, coverageHigh: 0.52, density: 1.3, absorb: 1.9,
    tint: 0x8e7a63, turbidity: 4.2, mieG: 0.68, fogMul: 2.6, sunMul: 0.45,
    aurora: 0, ash: 1, storm: 0, starMul: 0.2, milkyMul: 0.1, windMul: 1.1,
    altitude: 2.0, thickness: 2.0, detail: 0.28,
  },
};

const WEATHER_SCALARS = [
  'coverage', 'coverageHigh', 'density', 'absorb', 'turbidity', 'mieG',
  'fogMul', 'sunMul', 'aurora', 'ash', 'storm', 'starMul', 'milkyMul',
  'windMul', 'altitude', 'thickness', 'detail',
];

/* -------------------------------------------------------------------------- */
/* Small maths helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Uniform Catmull-Rom through four samples; u in [0,1] between p1 and p2. */
function catmullRom(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2
    + (3 * p1 - p0 - 3 * p2 + p3) * u3);
}

/**
 * Smoothstep that accepts a descending edge pair.
 *
 * `THREE.MathUtils.smoothstep` early-returns 0 for `x <= min`, so calling it
 * with min > max silently produces a constant zero — and most of the fades in
 * this file (night falling, aurora appearing) are naturally written descending.
 */
function sstep(x, a, b) {
  if (a === b) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * three's ACESFilmicToneMapping, reproduced exactly so the sky can be
 * calibrated in the space the player actually sees. Matrices are transcribed
 * from `tonemapping_pars_fragment`; GLSL `mat3(c0, c1, c2)` is column-major, so
 * these row-major arrays are the transpose of the literals in that chunk.
 */
const ACES_IN = [
  0.59719, 0.35458, 0.04823,
  0.07600, 0.90834, 0.01566,
  0.02840, 0.13383, 0.83777,
];
const ACES_OUT = [
  1.60475, -0.53108, -0.07367,
  -0.10208, 1.10813, -0.00605,
  -0.00327, -0.07276, 1.07602,
];

function mat3Apply(m, v, out) {
  const x = v[0];
  const y = v[1];
  const z = v[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[3] * x + m[4] * y + m[5] * z;
  out[2] = m[6] * x + m[7] * y + m[8] * z;
  return out;
}

const _acesA = [0, 0, 0];
const _acesB = [0, 0, 0];

/** Linear scene radiance -> linear display value, exactly as the GPU does it. */
function acesFilmic(rgb, exposure, out) {
  const s = exposure / 0.6;
  _acesA[0] = rgb[0] * s;
  _acesA[1] = rgb[1] * s;
  _acesA[2] = rgb[2] * s;
  mat3Apply(ACES_IN, _acesA, _acesB);
  for (let i = 0; i < 3; i++) {
    const v = _acesB[i];
    _acesB[i] = (v * (v + 0.0245786) - 0.000090537)
      / (v * (0.983729 * v + 0.432951) + 0.238081);
  }
  mat3Apply(ACES_OUT, _acesB, out);
  for (let i = 0; i < 3; i++) out[i] = Math.min(1, Math.max(0, out[i]));
  return out;
}

const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

/* -------------------------------------------------------------------------- */

export class Sky {
  constructor(engine) {
    this.engine = engine;
    this.time = gameState.state.timeOfDay ?? 0.34;

    /** Multiplies the ART_BIBLE fog density; zones may push it for a look. */
    this.fogDensityScale = 1.0;
    /**
     * Orbital phase of the surviving shard, in days. 0.86 keeps it up through
     * dusk and the whole of the night and gives a gibbous phase around midnight
     * with the terminator lying across the crater fields — the only phase where
     * the procedural lunar surface is worth the instructions it costs.
     */
    this.lunarPhase = 0.86;

    this._sunDir = new THREE.Vector3(0, 1, 0);
    this._moonDir = new THREE.Vector3(0, 1, 0);
    this._keyDir = new THREE.Vector3(0, 1, 0);
    this._sunColor = new THREE.Color(0xffead0);

    /** Public, read by Lighting.js / PostFX.js. Values follow the bible table. */
    this.sunIntensity = 3.0;
    this.ambientLevel = 0.55;
    this.exposure = 1.0;
    this.zenithColor = new THREE.Color();
    this.horizonColor = new THREE.Color();
    this.fogColor = new THREE.Color(0x16283c);
    this.fogDensity = 0.0018;
    this.ringGlowColor = new THREE.Color(RING_GLOW);

    // Weather crossfade state. `_wx` is the live blend the uniforms read.
    this._wxFrom = { ...WEATHER.clear, tint: new THREE.Color(0xffffff) };
    this._wxTo = { ...WEATHER.clear, tint: new THREE.Color(0xffffff) };
    this._wx = { ...WEATHER.clear, tint: new THREE.Color(0xffffff) };
    this._wxT = 1;
    this._wxDuration = 1;
    this.weather = 'clear';

    this._flash = 0;
    this._boltTimer = 4;
    this._invalidate = false;

    // Scratch. Per-frame work must not allocate: this runs behind everything.
    this._dirA = [0, 0, 0];
    this._sunArr = [0, 1, 0];
    this._radiance = [0, 0, 0];
    this._physical = [0, 0, 0];
    this._shown = [0, 0, 0];
    this._trial = [0, 0, 0];
    this._transmit = [0, 0, 0];
    this._tint = [1, 1, 1];
    this._target = [0, 0, 0];
    this._vecA = new THREE.Vector3();
    this._vecB = new THREE.Vector3();
    this._colA = new THREE.Color();
    this._colB = new THREE.Color();
    this._mat4 = new THREE.Matrix4();

    this._buildMesh();
    this._buildRingBasis();
    this.setQuality(gameState.state.settings?.quality ?? 'high');
    this.setTimeOfDay(this.time);
  }

  /* ------------------------------------------------------------------ setup */

  _buildMesh() {
    // A unit box riding on the camera. Its size is irrelevant because the
    // vertex program pins depth to the far plane; it only has to enclose the
    // near clip, which one unit of half-extent does for any sane near value.
    this._geometry = new THREE.BoxGeometry(2, 2, 2);

    this.uniforms = {
      uTime: { value: 0 },
      uObserverAltitude: { value: 0.2 },

      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uBetaR: { value: new THREE.Vector3() },
      uBetaM: { value: new THREE.Vector3() },
      uBetaMe: { value: new THREE.Vector3() },
      uBetaO: { value: new THREE.Vector3() },
      uMieG: { value: 0.78 },
      uSunIrradiance: { value: 6 },
      uMultiScatter: { value: new THREE.Vector3() },

      uZenithTint: { value: new THREE.Vector3(1, 1, 1) },
      uHorizonTint: { value: new THREE.Vector3(1, 1, 1) },
      uHorizonSunward: { value: 1 },

      uSunTint: { value: new THREE.Color(0xffead0) },
      uSunAngularRadius: { value: 0.011 },
      uSunDiscIntensity: { value: SUN_DISC_RADIANCE },
      uHaloStrength: { value: 1.0 },

      uCloudCoverage: { value: 0.42 },
      uCloudCoverageHigh: { value: 0.3 },
      uCloudDensity: { value: 1 },
      uCloudAbsorb: { value: 1 },
      uCloudAltitude: { value: 2.2 },
      uCloudThickness: { value: 1.5 },
      uCloudDetail: { value: 0.35 },
      uCloudTint: { value: new THREE.Color(0xffffff) },
      uCloudLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uCloudLightColor: { value: new THREE.Color(0xffead0) },
      uCloudAmbient: { value: new THREE.Color(0x33628f) },
      uCloudUnderlight: { value: new THREE.Color(0x8a5e7a) },
      uWind: { value: new THREE.Vector2(0.004, 0.0016) },
      uLightning: { value: 0 },
      uLightningDir: { value: new THREE.Vector3(1, 0.2, 0).normalize() },
      uLightningColor: { value: new THREE.Color(0xdfe8ff) },

      uStarRot: { value: new THREE.Matrix3() },
      uGalacticPole: { value: new THREE.Vector3(-0.62, 0.55, 0.56).normalize() },
      uStarDensity: { value: 90 },
      uStarCoverage: { value: 0.55 },
      uStarBrightness: { value: 1.7 },
      uStarFade: { value: 0 },
      uMilkyWay: { value: 0.35 },

      uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonRot: { value: new THREE.Matrix3() },
      uMoonFade: { value: 0 },
      uMoonRadius: { value: 0.026 },
      uMoonBump: { value: 0.030 },
      uMoonSunColor: { value: new THREE.Color(0xfff4e2) },
      uMoonHaloColor: { value: new THREE.Color(0x000000) },
      uEarthshine: { value: new THREE.Color(0x000000) },
      uRingAxis: { value: new THREE.Vector3(0.578, 0.4387, -0.688).normalize() },
      uRingColor: { value: new THREE.Color(RING_GLOW) },
      uRingAlpha: { value: 0.6 },

      uAurora: { value: 0 },
      uAuroraLow: { value: new THREE.Color(0x7df0b4) },
      uAuroraHigh: { value: new THREE.Color(0xb06bf0) },
      uAsh: { value: 0 },
      uAshTint: { value: new THREE.Color(0x8e7a63) },
      uAshEmber: { value: new THREE.Color(0x000000) },
      uGroundColor: { value: new THREE.Color(0x16283c) },
    };

    // The shard is tidally locked, so its surface frame is a constant rotation.
    // Baking it is both the correct physics and what keeps the crater field
    // byte-identical between screenshot runs.
    this.uniforms.uMoonRot.value.setFromMatrix4(
      this._mat4.makeRotationAxis(new THREE.Vector3(0.31, 0.83, 0.47).normalize(), 1.94));

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: buildSkyFragment('high'),
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });

    this.mesh = new THREE.Mesh(this._geometry, this.material);
    this.mesh.name = 'Sky';
    // Drawn last among opaques so early-Z rejects every pixel terrain already
    // covers. Combined with NDC depth 1.0 and depthWrite off, the dome can
    // neither occlude anything nor be occluded by anything but real geometry.
    this.mesh.renderOrder = 1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.onBeforeRender = Sky._followCamera;
  }

  /**
   * Ride the active camera. `onBeforeRender` runs *before* three computes this
   * object's modelViewMatrix for the draw, so mutating the world matrix here is
   * honoured on the same frame — and it works for any camera, including the one
   * PMREM uses when baking the environment probe.
   */
  static _followCamera(renderer, scene, camera) {
    this.position.copy(camera.position);
    this.updateMatrix();
    this.updateMatrixWorld(true);
  }

  /**
   * Orthonormal basis for the ring's orbital plane. `u` is its horizontal
   * diameter (zero elevation by construction) and `v` its steepest direction,
   * so the orbital angle maps straight to an elevation with no spherical
   * trigonometry and the peak is simply at sin(theta) = sign(v.y).
   */
  _buildRingBasis() {
    const axis = this.uniforms.uRingAxis.value;
    this._ringU = new THREE.Vector3(0, 1, 0).cross(axis).normalize();
    this._ringV = axis.clone().cross(this._ringU).normalize();
    this._ringThetaPeak = this._ringV.y >= 0 ? Math.PI / 2 : -Math.PI / 2;
  }

  addTo(scene) {
    this.scene = scene;
    scene.add(this.mesh);
    // The dome covers every direction, so a background could only ever be seen
    // through a bug. Fog is the opposite: the reference leans on atmospheric
    // perspective harder than on any other single effect, so it is mandatory.
    scene.background = null;
    scene.fog = new THREE.FogExp2(0x000000, this.fogDensity);
    scene.fog.color.copy(this.fogColor);
    return this;
  }

  /**
   * Rebuild the fragment program at a new cost point. Step counts are compile
   * time constants, so this genuinely changes the ALU spent per pixel rather
   * than branching around it — and the dome covers every outdoor pixel, which
   * makes it the single most valuable quality knob in the renderer.
   */
  setQuality(level) {
    this.quality = level;
    const src = buildSkyFragment(level);
    if (this.material.fragmentShader !== src) {
      this.material.fragmentShader = src;
      this.material.needsUpdate = true;
    }
    // The CPU mirror integrates the same function and does not have to match
    // the shader's step count, but it must not be wildly coarser or the
    // reported sun colour drifts from the rendered one.
    this._modelSteps = level === 'low' ? { viewSteps: 8, lightSteps: 3 }
      : level === 'ultra' ? { viewSteps: 18, lightSteps: 5 }
        : { viewSteps: 12, lightSteps: 4 };
    this._invalidate = true;
    return this;
  }

  /* --------------------------------------------------------- time of day -- */

  /** Periodic Catmull-Rom over one numeric field of TOD_KEYS. */
  _todScalar(field, t) {
    const f = ((t % 1) + 1) % 1;
    const seg = Math.floor(f * 4) % 4;
    const u = f * 4 - Math.floor(f * 4);
    const k = TOD_KEYS;
    return catmullRom(
      k[(seg + 3) % 4][field], k[seg][field],
      k[(seg + 1) % 4][field], k[(seg + 2) % 4][field], u);
  }

  /**
   * Same spline over a colour field. ART_BIBLE section 3 requires linear-space
   * interpolation; a THREE.Color built from an sRGB hex already holds linear
   * working values, so the channel-wise spline below is linear by construction.
   * Negative lobes of the spline are clamped away.
   */
  _todColor(field, t, out) {
    const f = ((t % 1) + 1) % 1;
    const seg = Math.floor(f * 4) % 4;
    const u = f * 4 - Math.floor(f * 4);
    const k = TOD_KEYS;
    const c0 = Sky._keyColor(k[(seg + 3) % 4], field);
    const c1 = Sky._keyColor(k[seg], field);
    const c2 = Sky._keyColor(k[(seg + 1) % 4], field);
    const c3 = Sky._keyColor(k[(seg + 2) % 4], field);
    out.setRGB(
      Math.max(0, catmullRom(c0.r, c1.r, c2.r, c3.r, u)),
      Math.max(0, catmullRom(c0.g, c1.g, c2.g, c3.g, u)),
      Math.max(0, catmullRom(c0.b, c1.b, c2.b, c3.b, u)),
      THREE.LinearSRGBColorSpace,
    );
    return out;
  }

  /** Lazily convert a key's sRGB hex to a linear THREE.Color, once per key. */
  static _keyColor(key, field) {
    const slot = `_linear_${field}`;
    if (!key[slot]) key[slot] = new THREE.Color(key[field]);
    return key[slot];
  }

  /**
   * Sun and shard directions.
   *
   * Elevation follows the bible's key angles through the same periodic spline
   * as everything else; azimuth advances linearly so the sun genuinely sweeps
   * the dome — rising in +X at dawn, crossing +Z at noon, setting in -X at
   * dusk. A sun that only changes elevation produces a sky whose colour is a
   * function of height alone, which is precisely the failure the brief names.
   */
  _updateSunDirection(t) {
    const elevation = THREE.MathUtils.degToRad(this._todScalar('elevation', t));
    const azimuth = THREE.MathUtils.degToRad(90 - (t - 0.25) * 360);
    const ce = Math.cos(elevation);
    this._sunDir.set(ce * Math.sin(azimuth), Math.sin(elevation), ce * Math.cos(azimuth));

    const theta = this._ringThetaPeak + Math.PI * 2 * (t - this.lunarPhase);
    this._moonDir.copy(this._ringU).multiplyScalar(Math.cos(theta))
      .addScaledVector(this._ringV, Math.sin(theta)).normalize();
  }

  /**
   * Solve a per-channel tint that lands `physical` on `targetLinear` after ACES
   * at the given exposure.
   *
   * Fixed-point iteration rather than a closed form, because ACES mixes
   * channels through two 3x3 matrices and is therefore not separable — there is
   * no useful inverse. Six iterations land well inside a JND for anything in
   * the sky's range, and this runs on a time-of-day change, not per frame.
   */
  _solveTint(physical, targetLinear, exposure, out) {
    out[0] = out[1] = out[2] = 1;
    for (let iter = 0; iter < 6; iter++) {
      for (let c = 0; c < 3; c++) this._trial[c] = physical[c] * out[c];
      acesFilmic(this._trial, exposure, this._shown);
      for (let c = 0; c < 3; c++) {
        const ratio = targetLinear[c] / Math.max(1e-4, this._shown[c]);
        // The bounds exist to stop a pathological weather/turbidity combination
        // running away, not to shape the look: with the calibration above, the
        // solved tints sit between 0.05 and 1.2 at every bible key, and only
        // the dusk horizon — where the art direction genuinely asks for a hue
        // physics will not produce — approaches the floor.
        out[c] = THREE.MathUtils.clamp(out[c] * THREE.MathUtils.clamp(ratio, 0.2, 5), 0.05, 12);
      }
    }
    return out;
  }

  /** Write a unit direction into the shared probe scratch and return it. */
  _probeDir(x, y, z) {
    const inv = 1 / Math.max(1e-6, Math.hypot(x, y, z));
    this._dirA[0] = x * inv;
    this._dirA[1] = y * inv;
    this._dirA[2] = z * inv;
    return this._dirA;
  }

  /**
   * Drive the entire dome from a single scalar.
   *
   * Order matters: sun geometry, then the atmosphere coefficients the CPU model
   * needs, then the calibration probes (which use that model), then every
   * uniform derived from the results.
   */
  setTimeOfDay(t) {
    this.time = ((t % 1) + 1) % 1;
    this._updateSunDirection(this.time);

    const u = this.uniforms;
    const wx = this._wx;
    const sun = this._sunDir;
    this._sunArr[0] = sun.x;
    this._sunArr[1] = sun.y;
    this._sunArr[2] = sun.z;

    this.sunIntensity = Math.max(0, this._todScalar('sunIntensity', this.time)) * wx.sunMul;
    this.ambientLevel = Math.max(0, this._todScalar('ambient', this.time));
    this.exposure = this._todScalar('exposure', this.time);
    this.fogDensity = Math.max(0, this._todScalar('fogDensity', this.time))
      * wx.fogMul * this.fogDensityScale;

    this._todColor('sun', this.time, this._sunColor);
    this._todColor('zenith', this.time, this.zenithColor);
    this._todColor('horizon', this.time, this.horizonColor);

    // --- atmosphere coefficients -------------------------------------------
    const turbidity = Math.max(0.2, this._todScalar('turbidity', this.time) * wx.turbidity);
    this._params = makeAtmosphereParams({
      turbidity,
      mieG: wx.mieG,
      altitude: u.uObserverAltitude.value,
      ...this._modelSteps,
    });

    // Second-order surrogate, scaled by how much of the dome is still lit so it
    // falls off smoothly through sunset rather than propping up the night sky.
    // The floor stands in for airglow and integrated starlight, and is the
    // reason a moonless midnight zenith is deep navy instead of pure black.
    // 0.9 / 0.18 were solved against the bible table, not guessed: they put the
    // raw integral within ~40% of every zenith and horizon key across the day.
    const skyLit = sstep(sun.y, -0.32, 0.12);
    const ms = 0.9 * skyLit + 0.18;
    this._params.multiScatter[0] = ms;
    this._params.multiScatter[1] = ms * 1.02;
    this._params.multiScatter[2] = ms * 1.12;

    u.uBetaR.value.fromArray(this._params.betaR);
    u.uBetaM.value.fromArray(this._params.betaM);
    u.uBetaMe.value.fromArray(this._params.betaMe);
    u.uBetaO.value.fromArray(this._params.betaO);
    u.uMieG.value = this._params.mieG;
    u.uSunIrradiance.value = this._params.sunIrradiance;
    u.uMultiScatter.value.fromArray(this._params.multiScatter);
    u.uSunDir.value.copy(sun);
    u.uMoonDir.value.copy(this._moonDir);

    // --- calibrate the dome onto the bible ---------------------------------
    this._probeDir(0, 1, 0);
    skyRadiance(this._dirA, this._sunArr, this._params, this._physical);
    this._target[0] = this.zenithColor.r;
    this._target[1] = this.zenithColor.g;
    this._target[2] = this.zenithColor.b;
    this._solveTint(this._physical, this._target, this.exposure, this._tint);
    u.uZenithTint.value.fromArray(this._tint);

    // Horizon probe in the SUN's azimuth, 1.5 degrees up — the band the bible's
    // horizon key actually describes, since a dusk sky is only orange on the
    // side the sun is on. The shader blends this tint back toward the zenith
    // tint away from the sun so the anti-solar sky keeps its own physics.
    const toward = this._vecA.set(sun.x, 0, sun.z);
    if (toward.lengthSq() < 1e-6) toward.set(0, 0, 1);
    toward.normalize().multiplyScalar(Math.cos(0.026));
    this._probeDir(toward.x, Math.sin(0.026), toward.z);
    skyRadiance(this._dirA, this._sunArr, this._params, this._physical);
    this._target[0] = this.horizonColor.r;
    this._target[1] = this.horizonColor.g;
    this._target[2] = this.horizonColor.b;
    this._solveTint(this._physical, this._target, this.exposure, this._tint);
    u.uHorizonTint.value.fromArray(this._tint);
    // With the sun down there is no sunward side worth preserving, so the
    // horizon key applies all the way round the skyline.
    u.uHorizonSunward.value = sstep(sun.y, -0.10, 0.05);

    // --- sun disc ------------------------------------------------------------
    // disc = transmittance * tint, and tint = reported / normalised
    // transmittance, so the rendered disc chroma is identically `sunColor`.
    // That identity is what Lighting.js relies on, so it is derived, not tuned.
    sunTransmittance(this._sunArr, this._params, this._transmit);
    const peak = Math.max(this._transmit[0], this._transmit[1], this._transmit[2], 1e-4);
    u.uSunTint.value.setRGB(
      THREE.MathUtils.clamp(this._sunColor.r / Math.max(0.03, this._transmit[0] / peak), 0, 12),
      THREE.MathUtils.clamp(this._sunColor.g / Math.max(0.03, this._transmit[1] / peak), 0, 12),
      THREE.MathUtils.clamp(this._sunColor.b / Math.max(0.03, this._transmit[2] / peak), 0, 12),
      THREE.LinearSRGBColorSpace,
    );
    // Fade the disc geometrically rather than letting the lifted horizon ray
    // keep it alive after sunset.
    u.uSunDiscIntensity.value = SUN_DISC_RADIANCE * sstep(sun.y, -0.012, 0.012) * wx.sunMul;
    // The aureole swells as the sun drops (longer path, more forward scatter)
    // and with aerosol load. This is the glare the bloom pass lives on.
    u.uHaloStrength.value = (0.55 + 0.9 * (1 - sstep(sun.y, 0.0, 0.35)))
      * THREE.MathUtils.clamp(turbidity * 0.55, 0.3, 2.2);

    // --- key light direction --------------------------------------------------
    // Below the horizon the key becomes the ring/shard, as ART_BIBLE section 3
    // requires at night. Slerped, and only across the couple of degrees either
    // side of the horizon, so shadows swing once and smoothly.
    // The window is wide on purpose: it is the largest single reorientation the
    // key light ever makes, and across -6 to +2.3 degrees of solar elevation the
    // slew stays under ~4.5 degrees per 0.0025 of a day.
    const nightBlend = 1 - sstep(sun.y, -0.10, 0.04);
    const nightKey = this._vecB.copy(this._moonDir);
    if (nightKey.y < 0.18) {
      // Keep the azimuth, lift the elevation: a key light arriving from under
      // the ground plane lights nothing and reads as a bug.
      nightKey.setY(0.18).normalize();
    }
    this._slerpDir(sun, nightKey, nightBlend, this._keyDir);

    // --- moon, ring, stars ----------------------------------------------------
    const darkness = sstep(sun.y, 0.34, -0.06);
    const moonUp = sstep(this._moonDir.y, -0.03, 0.10);
    u.uMoonFade.value = moonUp * (0.10 + 0.90 * darkness);
    u.uMoonSunColor.value.copy(this._sunColor)
      .lerp(this._colA.setHex(0xfff4e2), 0.55)
      .multiplyScalar(0.55 + 0.45 * darkness);
    u.uMoonHaloColor.value.copy(this.ringGlowColor).multiplyScalar(0.055 * darkness);
    u.uEarthshine.value.copy(this.ringGlowColor).multiplyScalar(0.11 * darkness);
    u.uRingAlpha.value = Math.max(0, this._todScalar('ringAlpha', this.time));

    u.uStarFade.value = darkness * wx.starMul;
    u.uMilkyWay.value = 0.35 * wx.milkyMul;
    u.uStarRot.value.setFromMatrix4(this._mat4.makeRotationAxis(
      this._vecA.set(0.35, 0.92, 0.18).normalize(), this.time * Math.PI * 2));

    // --- clouds ---------------------------------------------------------------
    u.uCloudLightDir.value.copy(this._keyDir);
    // Clouds are lit by whatever the key is, in the key's colour, so a night
    // deck is silvered by the ring instead of vanishing — REFERENCE_TARGET is
    // explicit that the sky keeps visible structure even at night. Sunlight
    // reaching cloud top is far less attenuated than light reaching the ground,
    // hence the generous multiplier by day.
    u.uCloudLightColor.value.copy(this._sunColor)
      .multiplyScalar(THREE.MathUtils.lerp(0.55, 2.4, sstep(sun.y, -0.15, 0.2)) * wx.sunMul);
    // Ambient above is the zenith sky, plus a little ring glow at night.
    u.uCloudAmbient.value.copy(this.zenithColor).multiplyScalar(2.4)
      .add(this._colA.copy(this.ringGlowColor).multiplyScalar(0.06 * darkness));
    // Below is the horizon warmed toward the sun — this is what puts the sunset
    // on the undersides without a special case for dusk.
    u.uCloudUnderlight.value.copy(this.horizonColor).multiplyScalar(1.5)
      .lerp(this._sunColor, 0.35 * (1 - sstep(sun.y, 0.05, 0.4)));

    this._applyWeatherUniforms();
    this._updateFogColor(this._lastCamera);
    this._invalidate = false;
    return this;
  }

  /** Shortest-arc interpolation between two unit vectors. */
  _slerpDir(a, b, w, out) {
    if (w <= 0.0001) return out.copy(a);
    if (w >= 0.9999) return out.copy(b);
    const d = THREE.MathUtils.clamp(a.dot(b), -1, 1);
    const theta = Math.acos(d);
    const s = Math.sin(theta);
    // Near-parallel or near-antiparallel: the slerp weights blow up, and a
    // normalised lerp is both stable and visually identical there.
    if (s < 1e-3) return out.copy(a).lerp(b, w).normalize();
    return out.copy(a).multiplyScalar(Math.sin((1 - w) * theta) / s)
      .addScaledVector(b, Math.sin(w * theta) / s).normalize();
  }

  /* -------------------------------------------------------------- weather -- */

  /**
   * Crossfade to a named weather state.
   *
   * `t` is the crossfade duration in SECONDS; 0 cuts immediately. The contract
   * does not pin the unit down, and seconds is the reading under which
   * `setWeather('storm', 6)` means something a designer would actually want.
   */
  setWeather(name, t = 2.5) {
    const preset = WEATHER[name];
    if (!preset) {
      console.warn(`[Sky] unknown weather "${name}"`);
      return this;
    }
    this.weather = name;
    for (const k of WEATHER_SCALARS) {
      this._wxFrom[k] = this._wx[k];
      this._wxTo[k] = preset[k];
    }
    this._wxFrom.tint.copy(this._wx.tint);
    this._wxTo.tint.set(preset.tint);
    this._wxDuration = Math.max(0, t);
    if (this._wxDuration > 0) {
      this._wxT = 0;
    } else {
      this._wxT = 1;
      this._blendWeather(1);
      this.setTimeOfDay(this.time);
    }
    return this;
  }

  _blendWeather(w) {
    // Smootherstep on the blend so both ends of a weather change have zero
    // derivative; a linear fade is visible as a distinct "start" and "stop"
    // even when the endpoints themselves are correct.
    const s = w * w * w * (w * (w * 6 - 15) + 10);
    for (const k of WEATHER_SCALARS) {
      this._wx[k] = THREE.MathUtils.lerp(this._wxFrom[k], this._wxTo[k], s);
    }
    this._wx.tint.copy(this._wxFrom.tint).lerp(this._wxTo.tint, s);
    // Weather moves the scattering coefficients, so the whole calibration has
    // to be re-solved rather than just the cloud uniforms.
    this._invalidate = true;
  }

  _applyWeatherUniforms() {
    const u = this.uniforms;
    const wx = this._wx;
    u.uCloudCoverage.value = wx.coverage;
    u.uCloudCoverageHigh.value = wx.coverageHigh;
    u.uCloudDensity.value = wx.density;
    u.uCloudAbsorb.value = wx.absorb;
    u.uCloudAltitude.value = wx.altitude;
    u.uCloudThickness.value = wx.thickness;
    u.uCloudDetail.value = wx.detail;
    u.uCloudTint.value.copy(wx.tint);
    u.uWind.value.set(0.0040 * wx.windMul, 0.0016 * wx.windMul);
    // The curtain is invisible against a lit sky, and forcing it through
    // daylight is the fastest way to make a signature effect look cheap.
    u.uAurora.value = wx.aurora * sstep(this._sunDir.y, 0.08, -0.10);
    u.uAsh.value = wx.ash;
    u.uAshEmber.value.setHex(0xff6b2b).multiplyScalar(0.07 * wx.ash);
  }

  /* ------------------------------------------------------------------ fog -- */

  /**
   * Match `scene.fog` to the horizon the dome is painting in the camera's view
   * direction.
   *
   * Luminance comes from the rendered horizon so distant geometry dissolves
   * into the sky with no seam — the single thing that makes atmospheric
   * perspective read as depth rather than as a grey wash. Chroma is pulled
   * halfway to the bible's fog key and then a little toward FOG_FAR, because
   * section 2.1 wants far haze warmer than near fog. Exp2 fog carries one
   * colour only, so that warm bias is baked in here rather than faked with a
   * second fog term.
   */
  _updateFogColor(camera) {
    this._lastCamera = camera ?? this._lastCamera ?? null;
    let dx = 0;
    let dz = 1;
    if (this._lastCamera) {
      this._lastCamera.getWorldDirection(this._vecA);
      const len = Math.hypot(this._vecA.x, this._vecA.z);
      if (len > 1e-4) {
        dx = this._vecA.x / len;
        dz = this._vecA.z / len;
      }
    }
    // 1.5 degrees up: the band the eye actually reads as "the horizon".
    const el = 0.026;
    const ce = Math.cos(el);
    this._probeDir(dx * ce, Math.sin(el), dz * ce);
    skyRadiance(this._dirA, this._sunArr, this._params, this._radiance);

    const tint = this.uniforms.uHorizonTint.value;
    const rr = this._radiance[0] * tint.x;
    const rg = this._radiance[1] * tint.y;
    const rb = this._radiance[2] * tint.z;
    const lum = Math.max(1e-4, LR * rr + LG * rg + LB * rb);

    // Chroma-only blends: divide by each colour's own luminance, mix the
    // resulting unit-luminance chromaticities, multiply the horizon's real
    // luminance back in. Mixing raw values instead would darken the fog
    // relative to the sky and draw a visible band along the skyline.
    const key = this._todColor('fog', this.time, this._colA);
    const keyLum = Math.max(1e-4, LR * key.r + LG * key.g + LB * key.b);
    let cr = THREE.MathUtils.lerp(rr / lum, key.r / keyLum, 0.55);
    let cg = THREE.MathUtils.lerp(rg / lum, key.g / keyLum, 0.55);
    let cb = THREE.MathUtils.lerp(rb / lum, key.b / keyLum, 0.55);

    const far = this._colB.setHex(FOG_FAR);
    const farLum = Math.max(1e-4, LR * far.r + LG * far.g + LB * far.b);
    cr = THREE.MathUtils.lerp(cr, far.r / farLum, 0.14);
    cg = THREE.MathUtils.lerp(cg, far.g / farLum, 0.14);
    cb = THREE.MathUtils.lerp(cb, far.b / farLum, 0.14);

    this.fogColor.setRGB(cr * lum, cg * lum, cb * lum, THREE.LinearSRGBColorSpace);
    // The below-horizon fill uses the same colour, slightly darker, so the
    // dome and the fog meet without a seam wherever terrain runs out.
    this.uniforms.uGroundColor.value.copy(this.fogColor).multiplyScalar(0.82);

    if (this.scene?.fog) {
      this.scene.fog.color.copy(this.fogColor);
      this.scene.fog.density = this.fogDensity;
    }
  }

  /* ------------------------------------------------------------- lightning - */

  /**
   * Storm strokes. Seeded rng, never Math.random, so a capture reproduces;
   * multi-stroke, because a single clean flash reads as a screen fade rather
   * than as lightning; and it publishes an `audio:cue` with the acoustic delay
   * already derived from the bolt's apparent distance.
   */
  _updateLightning(dt) {
    const storm = this._wx.storm;
    if (storm <= 0.02) {
      this._flash = Math.max(0, this._flash - dt * 4);
    } else {
      this._boltTimer -= dt * storm;
      if (this._boltTimer <= 0) {
        this._boltTimer = rng.range(2.5, 10.0);
        const az = rng.range(0, Math.PI * 2);
        const el = rng.range(0.03, 0.42);
        const ce = Math.cos(el);
        this.uniforms.uLightningDir.value.set(ce * Math.sin(az), Math.sin(el), ce * Math.cos(az));
        this._flash = rng.range(0.55, 1.4);
        // A bolt near the horizon is a distant one; sound lags by d / 343 m/s.
        const distanceKm = THREE.MathUtils.lerp(11, 1.5, sstep(el, 0.03, 0.42));
        bus.emit('audio:cue', {
          id: 'thunder',
          params: { delay: (distanceKm * 1000) / 343, intensity: this._flash, distanceKm },
        });
      }
      // Real strokes flicker: several return strokes over roughly 200 ms.
      // Modulating the decay rate reproduces that without a state machine.
      const flicker = 0.65 + 0.35 * Math.sin(this.uniforms.uTime.value * 47.0);
      this._flash = Math.max(0, this._flash - dt * 3.4 * (0.4 + flicker));
    }
    this.uniforms.uLightning.value = this._flash;
  }

  /* ----------------------------------------------------------------- tick -- */

  update(dt) {
    const u = this.uniforms;
    // Driven from the engine clock rather than accumulated dt so cloud and
    // aurora animation reproduce exactly for a given elapsed time.
    u.uTime.value = this.engine?.elapsed ?? u.uTime.value + dt;

    if (this._wxT < 1 && this._wxDuration > 0) {
      this._wxT = Math.min(1, this._wxT + dt / this._wxDuration);
      this._blendWeather(this._wxT);
    }

    const camera = this.engine?.scene?.camera ?? this.engine?.camera ?? null;
    if (camera) {
      // Altitude in kilometres, clamped low so a camera dipping below the
      // ground plane cannot put the observer inside the planet.
      const alt = THREE.MathUtils.clamp(0.05 + camera.position.y / 1000, 0.02, 8);
      if (Math.abs(alt - u.uObserverAltitude.value) > 1e-4) {
        u.uObserverAltitude.value = alt;
        if (this._params) this._params.altitude = alt;
      }
    }

    if (this._invalidate) this.setTimeOfDay(this.time);
    else this._updateFogColor(camera);

    this._updateLightning(dt);

    // Exposure is part of the time-of-day contract in ART_BIBLE section 3 and
    // nothing else currently owns it. If PostFX takes over tone mapping it
    // should read `sky.exposure` rather than have this removed.
    if (this.engine?.renderer) this.engine.renderer.toneMappingExposure = this.exposure;
  }

  /* ------------------------------------------------------------ accessors -- */

  /**
   * The dominant light direction in the dome: the sun by day, the ring/shard
   * at night. Lighting.js aims the key light down this vector.
   */
  get sunDirection() {
    return this._keyDir;
  }

  /** Exactly the chroma the dome renders for the sun disc and the cloud light. */
  get sunColor() {
    return this._sunColor;
  }

  /** The physical sun, before the night crossfade to the ring. */
  get trueSunDirection() {
    return this._sunDir;
  }

  get moonDirection() {
    return this._moonDir;
  }

  /**
   * A throwaway scene holding a second mesh that shares this dome's geometry
   * and material, for `AssetForge.environment()` to run PMREM over. Sharing
   * rather than cloning means the probe is always exactly the sky on screen,
   * and disposing the handle frees nothing the live dome still needs.
   */
  createEnvironmentSource() {
    const scene = new THREE.Scene();
    const proxy = new THREE.Mesh(this._geometry, this.material);
    proxy.frustumCulled = false;
    proxy.matrixAutoUpdate = false;
    proxy.renderOrder = 1000;
    proxy.onBeforeRender = Sky._followCamera;
    scene.add(proxy);
    return {
      scene,
      dispose() {
        scene.remove(proxy);
      },
    };
  }

  dispose() {
    this.mesh.onBeforeRender = () => {};
    this.mesh.parent?.remove(this.mesh);
    this._geometry.dispose();
    this.material.dispose();
    if (this.scene) this.scene.fog = null;
    this.scene = null;
    this._lastCamera = null;
  }
}
