/**
 * AssetForge — the material library, and the only place textures are cached.
 *
 * Generation is expensive (a 512² surface set is roughly 150 ms of pure JS) and
 * a scene needs six to ten of them, so everything here is **lazy and cached**:
 * nothing is built until someone asks for it, and asking twice is free. A full
 * field scene warms in well under two seconds; a lookdev scene with the whole
 * material bar warms in about one.
 *
 * Three things in this file are load-bearing and easy to get wrong:
 *
 * 1. **Colour space.** Albedo and emissive carry authored colour and are tagged
 *    sRGB; normal, roughness and AO are numbers and stay linear. Mislabelling
 *    a roughness map as sRGB is the single most common cause of "my PBR looks
 *    plasticky" and it is silent — nothing warns you.
 *
 * 2. **The environment map.** `environment()` renders the live sky into a cube
 *    target and prefilters it with `PMREMGenerator`. Without it every metal and
 *    crystal surface in the game renders black, because a metal has no diffuse
 *    response and nothing but the environment to reflect. If the Sky module
 *    exposes real dome geometry we prefilter that; otherwise we build a
 *    physically-plausible gradient dome from the ART_BIBLE time-of-day keys so
 *    the probe is never missing.
 *
 * 3. **Ownership.** `Engine.disposeTree` walks a scene on unmount and disposes
 *    every material and texture it finds. That is correct for scene-local
 *    resources and catastrophic for a shared library — the second scene to use
 *    `material('stone')` would get a destroyed GPU object. Everything handed
 *    out of here therefore has a guarded `dispose()` that only the forge itself
 *    can bypass (`_own` below). This is a deliberate override of the base
 *    class's behaviour, not an accident.
 *
 * OWNED BY: art. Registered as the `art` service in main.js.
 */
import * as THREE from 'three';
import {
  generateSurface, generateRamp, generateSprite, generateUtility,
  classify, SURFACES,
} from './Textures.js';
import {
  LIGHT, SURFACE_TINT, ENV_INTENSITY, sampleTimeOfDay, mixHex, HERO_TIME_OF_DAY,
} from './Palette.js';

/** Surfaces whose material wants a class other than plain Standard. */
const MATERIAL_CLASS = {
  steel: 'metal',
  gold: 'metal',
  crystal: 'crystal',
  silk: 'silk',
  cloth: 'cloth',
  foliage: 'foliage',
  cloud: 'cloud',
  rune: 'rune',
  'water-normal': 'water',
};

/** Friendly aliases so callers can ask for the thing rather than the map. */
const KEY_ALIAS = { water: 'water-normal', 'water-material': 'water-normal' };

/**
 * Stable hash of an options object, so `material('stone', {repeat: 4})` and
 * `material('stone', {repeat: 8})` are distinct cache entries but the same call
 * twice is not. Keys are sorted because object literal order is a caller detail.
 */
function optionHash(opts) {
  if (!opts) return '';
  const keys = Object.keys(opts).sort();
  let out = '';
  for (const k of keys) {
    const v = opts[k];
    if (v === undefined || typeof v === 'function') continue;
    out += `${k}=${v && v.isColor ? v.getHexString() : v};`;
  }
  return out;
}

export class AssetForge {
  constructor(renderer) {
    this.renderer = renderer;
    /** key -> THREE.Texture (ramps, sprites, utilities, and base surface maps). */
    this._textures = new Map();
    /** surface key + opts -> { maps, meta } */
    this._sets = new Map();
    /** material key + opts -> THREE.Material */
    this._materials = new Map();
    /** Everything the forge allocated, in creation order, for `dispose()`. */
    this._owned = [];

    // 8x is the knee of the quality/bandwidth curve for these maps; 16x costs
    // real memory bandwidth on integrated GPUs for a difference nobody sees at
    // the shallow grazing angles a fixed battle camera actually produces.
    const caps = renderer?.capabilities;
    this._anisotropy = Math.min(8, caps?.getMaxAnisotropy?.() ?? 1);

    this._pmrem = null;
    this._envTarget = null;
    this._envKey = '';
    this._probeMaterial = null;
    this._probeGeometry = null;

    /** Rough wall-clock budget tracking, surfaced by `stats()`. */
    this._generationMs = 0;
  }

  // ------------------------------------------------------------- textures

  /**
   * Fetch a texture by key.
   *
   * For a surface, the *primary* map is returned (albedo, except `water-normal`
   * whose primary is its normal map). Any other map of that surface is reached
   * with `texture('stone/normal')` or `texture('stone', { map: 'roughness' })`.
   *
   * @param {string} key
   * @param {Object} [opts] `size`, `seed`, `repeat`, `map`, plus per-surface options.
   * @returns {THREE.Texture}
   */
  texture(key, opts = {}) {
    let baseKey = KEY_ALIAS[key] ?? key;
    let map = opts.map ?? null;
    const slash = baseKey.indexOf('/');
    if (slash > 0) {
      map = baseKey.slice(slash + 1);
      baseKey = baseKey.slice(0, slash);
    }
    const cacheKey = `${baseKey}#${map ?? ''}#${optionHash(opts)}`;
    const hit = this._textures.get(cacheKey);
    if (hit) return hit;

    const kind = classify(baseKey);
    let tex = null;

    if (kind === 'surface') {
      const set = this._surfaceSet(baseKey, opts);
      const wanted = map ?? set.meta.primary;
      const base = set.maps[wanted] ?? set.maps[set.meta.primary];
      // Repeat lives on the texture, so a caller wanting different tiling gets
      // a clone. Clones share `.source`, so the pixels are uploaded once no
      // matter how many tilings exist.
      tex = opts.repeat && opts.repeat !== 1 ? this._retile(base, opts.repeat) : base;
    } else if (kind === 'ramp') {
      tex = this._own(generateRamp(baseKey, opts));
    } else if (kind === 'sprite') {
      tex = this._own(generateSprite(baseKey, opts));
    } else if (kind === 'utility') {
      tex = this._own(generateUtility(baseKey, opts));
    } else {
      console.warn(`[AssetForge] unknown texture key "${key}" — falling back to noise-rgb.`);
      tex = this.texture('noise-rgb');
    }

    this._textures.set(cacheKey, tex);
    return tex;
  }

  /** Generate (or fetch) the full map set for a surface. */
  _surfaceSet(key, opts) {
    const cacheKey = `${key}#${optionHash({ size: opts.size, seed: opts.seed, element: opts.element, glow: opts.glow, bump: opts.bump })}`;
    const hit = this._sets.get(cacheKey);
    if (hit) return hit;

    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const set = generateSurface(key, opts);
    this._generationMs += (typeof performance !== 'undefined' ? performance.now() : 0) - t0;

    for (const name of Object.keys(set.maps)) {
      const tex = set.maps[name];
      tex.anisotropy = this._anisotropy;
      const r = set.meta.repeat;
      if (!set.meta.clamped && r !== 1) tex.repeat.set(r, r);
      this._own(tex);
    }
    this._sets.set(cacheKey, set);
    return set;
  }

  /** A tiling variant of a base map that shares its pixel source. */
  _retile(base, repeat) {
    const t = base.clone();
    t.repeat.set(repeat, repeat);
    t.anisotropy = this._anisotropy;
    t.needsUpdate = true;
    return this._own(t);
  }

  // ------------------------------------------------------------ materials

  /**
   * A fully configured material for a named surface: every generated map bound,
   * colour spaces correct, anisotropic filtering from renderer capabilities,
   * and the roughness/metalness/env-intensity the bible specifies for that
   * class of surface.
   *
   * `roughness` and `metalness` are left at 1.0 wherever a map exists, because
   * three multiplies the scalar by the map — the absolute value is baked into
   * the texture inside the bible's range, and a scalar of 1 is what lets it
   * through unchanged. Passing `{ roughness: 0.9 }` therefore *scales* the
   * baked value rather than replacing it, which is the useful behaviour.
   *
   * @param {string} key
   * @param {Object} [opts]
   * @returns {THREE.Material}
   */
  material(key, opts = {}) {
    const cacheKey = `${key}#${optionHash(opts)}`;
    const hit = this._materials.get(cacheKey);
    if (hit) return hit;
    const mat = this._own(this._buildMaterial(key, opts));
    this._materials.set(cacheKey, mat);
    return mat;
  }

  _buildMaterial(key, opts) {
    let baseKey = KEY_ALIAS[key] ?? key;
    if (!SURFACES[baseKey]) {
      // Never return a bare grey Standard material — ART_BIBLE §7.1 forbids it
      // outright, and a missing key is far easier to spot as obviously-wrong
      // stone than as the default grey that half of three.js looks like.
      console.warn(`[AssetForge] no surface "${key}"; substituting stone.`);
      baseKey = 'stone';
    }
    const set = this._surfaceSet(baseKey, opts);
    const meta = set.meta;
    const repeat = opts.repeat ?? meta.repeat;
    const maps = this._bindMaps(set, repeat, meta.clamped);
    const cls = MATERIAL_CLASS[baseKey] ?? 'standard';

    const common = {
      map: maps.albedo ?? null,
      normalMap: maps.normal ?? null,
      roughnessMap: maps.roughness ?? null,
      aoMap: maps.ao ?? null,
      roughness: 1,
      metalness: meta.spec?.metalness ?? 0,
      // Normal strength is baked into the map; the scalar exists so a caller
      // can dial a surface back on a small prop where full-strength relief
      // would read as noise at that screen size.
      normalScale: new THREE.Vector2(1, 1),
      aoMapIntensity: 0.9,
      envMapIntensity: ENV_INTENSITY.default,
    };

    let mat;
    switch (cls) {
      case 'metal': {
        // MeshPhysicalMaterial for `anisotropy` — the bible makes an anisotropic
        // highlight direction mandatory on metal, and Standard cannot express
        // it. Rotation 0 aligns the highlight with U, which is the axis the
        // brushed streaks in the texture run along.
        mat = new THREE.MeshPhysicalMaterial({
          ...common,
          metalness: 1,
          anisotropy: baseKey === 'gold' ? 0.45 : 0.6,
          anisotropyRotation: 0,
          envMapIntensity: ENV_INTENSITY.metal,
        });
        break;
      }
      case 'crystal': {
        // Opacity rather than `transmission`: real transmission forces three to
        // render a full-resolution copy of the scene every frame, and at the
        // scale crystals appear here (props, esper shards) the refraction is
        // invisible while the cost is not. The interior read comes from the
        // emissive map and the fresnel the low roughness produces.
        mat = new THREE.MeshPhysicalMaterial({
          ...common,
          transparent: true,
          opacity: opts.opacity ?? 0.68,
          roughness: 1,
          metalness: 0,
          ior: 1.8,
          specularIntensity: 1,
          emissive: new THREE.Color(0xffffff),
          emissiveMap: maps.emissive ?? null,
          emissiveIntensity: opts.emissiveIntensity ?? 1.4,
          envMapIntensity: ENV_INTENSITY.crystal,
          depthWrite: false,
        });
        break;
      }
      case 'silk': {
        mat = new THREE.MeshPhysicalMaterial({
          ...common,
          sheen: 0.75,
          sheenRoughness: 0.35,
          sheenColor: new THREE.Color(SURFACE_TINT.SILK_SPEC),
          anisotropy: 0.4,
          anisotropyRotation: Math.PI / 2, // along the warp, which runs in V
          envMapIntensity: ENV_INTENSITY.cloth,
        });
        break;
      }
      case 'cloth': {
        // §4: "sheen colour = albedo lightened 20%". `meanHex` is the measured
        // average of the map we just generated, so this stays correct even if
        // the dye colour in the generator changes.
        mat = new THREE.MeshPhysicalMaterial({
          ...common,
          sheen: 0.85,
          sheenRoughness: 0.8,
          sheenColor: new THREE.Color(mixHex(meta.meanHex, 0xffffff, 0.2)),
          envMapIntensity: ENV_INTENSITY.cloth,
        });
        break;
      }
      case 'foliage': {
        // alphaTest rather than transparency: foliage is dense and overlapping,
        // and sorted transparency on a canopy produces popping edges as the
        // camera drifts. A cutout writes depth and sorts for free.
        mat = new THREE.MeshStandardMaterial({
          ...common,
          alphaTest: opts.alphaTest ?? 0.45,
          side: THREE.DoubleSide,
          envMapIntensity: 0.35,
        });
        break;
      }
      case 'cloud': {
        mat = new THREE.MeshStandardMaterial({
          ...common,
          transparent: true,
          depthWrite: false,
          roughness: 1,
          metalness: 0,
          side: THREE.DoubleSide,
          envMapIntensity: 0.4,
        });
        break;
      }
      case 'rune': {
        // Unlit and additive: a rune is light projected onto a surface, not a
        // surface. Lighting it would let the scene's shadows fall across a
        // glyph that is supposed to be its own light source.
        mat = new THREE.MeshBasicMaterial({
          map: maps.emissive ?? maps.albedo ?? null,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: true,
        });
        break;
      }
      case 'water': {
        mat = new THREE.MeshPhysicalMaterial({
          color: new THREE.Color(SURFACE_TINT.WATER_ABSORB),
          normalMap: maps.normal ?? null,
          roughnessMap: maps.roughness ?? null,
          normalScale: new THREE.Vector2(0.7, 0.7),
          roughness: 1,
          metalness: 0,
          transparent: true,
          opacity: opts.opacity ?? 0.88,
          ior: 1.333,
          // §4 water: fresnel reflectance floor 0.02 — that is exactly what
          // `specularIntensity 1` at ior 1.333 gives on a dielectric.
          specularIntensity: 1,
          envMapIntensity: ENV_INTENSITY.metal,
        });
        break;
      }
      default: {
        mat = new THREE.MeshStandardMaterial(common);
        break;
      }
    }

    mat.name = `forge:${baseKey}`;

    // Caller overrides last, so a scene can always dial a surface without
    // needing a new key. Colour is special-cased because passing a hex through
    // Object.assign onto `.color` would replace the Color instance.
    for (const [k, v] of Object.entries(opts)) {
      if (k === 'repeat' || k === 'size' || k === 'seed' || k === 'map' || k === 'element' || k === 'glow' || k === 'bump') continue;
      if (k === 'color' || k === 'emissive' || k === 'sheenColor') {
        if (mat[k]) mat[k].set(v);
        else mat[k] = new THREE.Color(v);
      } else if (k === 'normalScale' && typeof v === 'number') {
        mat.normalScale.set(v, v);
      } else if (k in mat) {
        mat[k] = v;
      }
    }
    mat.needsUpdate = true;
    return mat;
  }

  /** Clone the set's maps at the requested tiling, sharing their pixel sources. */
  _bindMaps(set, repeat, clamped) {
    const out = {};
    for (const name of Object.keys(set.maps)) {
      const base = set.maps[name];
      if (clamped || repeat === base.repeat.x) {
        out[name] = base;
        continue;
      }
      out[name] = this._retile(base, repeat);
    }
    return out;
  }

  // ---------------------------------------------------------- environment

  /**
   * Build (and cache) a prefiltered radiance environment map from the sky.
   *
   * Cached against the sky's time-of-day and weather: regenerating a PMREM is
   * ~10 ms of GPU work, which is fine on a time-of-day change and ruinous per
   * frame. Call it again after `sky.setTimeOfDay()` and it rebuilds; call it
   * again with nothing changed and it hands back the same texture.
   *
   * @param {Object|THREE.Scene} [sky] a `render/Sky.js` instance or a scene
   * @returns {THREE.Texture} a CubeUV-packed PMREM, ready for `scene.environment`
   */
  environment(sky, opts = {}) {
    const key = this._environmentKey(sky, opts);
    if (this._envTarget && this._envKey === key) return this._envTarget.texture;
    if (!this.renderer) return null;

    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(this.renderer);
    const probe = this._buildProbeScene(sky, opts);
    // sigma 0: the sky we feed in is already smooth, and PMREM's own GGX
    // prefilter provides every roughness level. A pre-blur would only cost a
    // pass and soften the sun disc that drives the specular highlight.
    const target = this._pmrem.fromScene(probe.scene, 0, 1, 4000, { size: opts.size ?? 256 });
    probe.dispose();

    if (this._envTarget) this._envTarget.dispose();
    this._envTarget = target;
    this._envKey = key;
    target.texture.name = 'forge:environment';
    return target.texture;
  }

  _environmentKey(sky, opts) {
    const t = sky?.time ?? sky?.timeOfDay ?? opts.timeOfDay ?? HERO_TIME_OF_DAY;
    const weather = sky?.weather ?? opts.weather ?? 'clear';
    // Quantised: a smooth time-of-day sweep must not rebuild the probe on every
    // frame, and 1/128 of a day is finer than the eye can track in ambient.
    return `${Math.round(t * 128)}|${weather}|${opts.size ?? 256}`;
  }

  /**
   * Assemble a scene containing only sky.
   *
   * Preference order: (0) the Sky module's own `createEnvironmentSource()`;
   * (1) real dome geometry the Sky module exposes, wrapped in proxy meshes that
   * share its geometry and material so nothing is reparented out from under it;
   * (2) an equirect/cube background texture on the sky's scene; (3) a procedural
   * gradient dome built from the ART_BIBLE keys. The last case is not a fallback
   * for failure — during bring-up the Sky module may be a stub, and metal still
   * has to look like metal.
   *
   * Case 0 exists because our dome is a *camera-riding* box whose vertex program
   * pins depth to the far plane: it is only correct when it re-centres on
   * whatever camera is drawing it. `_skyProxies` freezes `matrixWorld`, which
   * leaves the box wherever the game camera last stood — for a PMREM cube camera
   * sitting at the origin that means five of the six faces sample nothing.
   * `createEnvironmentSource` hands back a proxy that still carries Sky's
   * `onBeforeRender`, so the probe sees exactly the dome on screen.
   */
  _buildProbeScene(sky, opts) {
    if (typeof sky?.createEnvironmentSource === 'function') return sky.createEnvironmentSource();

    const scene = new THREE.Scene();
    const temporary = [];

    const proxies = this._skyProxies(sky);
    for (const p of proxies) scene.add(p);

    const bg = sky?.scene?.background ?? (sky?.isScene ? sky.background : null);
    if (bg && bg.isTexture) scene.background = bg;

    if (proxies.length === 0 && !scene.background) {
      const dome = this._proceduralDome(sky, opts);
      scene.add(dome);
      temporary.push(dome);
    }

    return {
      scene,
      dispose() {
        // Proxy meshes borrow geometry and material from the live sky, so only
        // the scene graph links are released here. The procedural dome's
        // geometry and material are forge-owned and reused across rebuilds.
        scene.clear();
      },
    };
  }

  /** Locate renderable sky geometry on whatever the caller passed. */
  _skyProxies(sky) {
    if (!sky) return [];
    let root = null;
    if (sky.isObject3D) root = sky;
    else root = sky.dome ?? sky.mesh ?? sky.skyMesh ?? sky.group ?? sky.object3D ?? null;

    const sources = [];
    if (root) {
      root.updateWorldMatrix(true, true);
      root.traverse((o) => {
        if (o.isMesh && o.visible && o.material) sources.push(o);
      });
    } else if (sky.scene?.isScene) {
      // A Sky that added its dome straight to the game scene: take only the
      // objects that are plausibly sky, never the terrain and characters.
      for (const child of sky.scene.children) {
        if (!child.visible) continue;
        if (!/sky|dome|cloud|star|moon|ring|sun|atmos/i.test(child.name)) continue;
        child.updateWorldMatrix(true, true);
        child.traverse((o) => {
          if (o.isMesh && o.visible && o.material) sources.push(o);
        });
      }
    }

    return sources.map((src) => {
      const proxy = new THREE.Mesh(src.geometry, src.material);
      proxy.matrixAutoUpdate = false;
      proxy.matrix.copy(src.matrixWorld);
      proxy.frustumCulled = false;
      return proxy;
    });
  }

  /**
   * A physically-plausible sky dome from the ART_BIBLE time-of-day keys:
   * zenith-to-horizon gradient, a warm ground bounce below the horizon, a sun
   * disc bright enough to produce a real specular highlight, and the shattered
   * moon-ring band that gives every metal surface in the game its secondary
   * teal kick. Values are radiance, not display colour — this is rendered into
   * a linear half-float target with tone mapping disabled.
   */
  _proceduralDome(sky, opts) {
    if (!this._probeGeometry) {
      this._probeGeometry = this._own(new THREE.SphereGeometry(1000, 32, 24));
    }
    if (!this._probeMaterial) {
      this._probeMaterial = this._own(new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          uZenith: { value: new THREE.Color(0x33628f) },
          uHorizon: { value: new THREE.Color(0xbfd9e2) },
          uGround: { value: new THREE.Color(LIGHT.BOUNCE_GROUND) },
          uSunColor: { value: new THREE.Color(LIGHT.KEY_SUN) },
          uSunDir: { value: new THREE.Vector3(0.4, 0.6, 0.3).normalize() },
          uSunIntensity: { value: 3.0 },
          uSkyIntensity: { value: 1.0 },
          uRingColor: { value: new THREE.Color(LIGHT.RING_GLOW) },
          uRingAxis: { value: new THREE.Vector3(0.32, 0.86, -0.4).normalize() },
          uRingAlpha: { value: 0.6 },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uZenith, uHorizon, uGround, uSunColor, uRingColor;
          uniform vec3 uSunDir, uRingAxis;
          uniform float uSunIntensity, uSkyIntensity, uRingAlpha;
          varying vec3 vDir;

          void main() {
            vec3 d = normalize(vDir);
            // pow 0.42 rather than a linear ramp: real Rayleigh scattering
            // concentrates the horizon transition into the bottom 20 degrees.
            float up = clamp(d.y, 0.0, 1.0);
            vec3 sky = mix(uHorizon, uZenith, pow(up, 0.42));
            float below = clamp(-d.y, 0.0, 1.0);
            vec3 ground = mix(uHorizon, uGround, smoothstep(0.0, 0.35, below)) * 0.55;
            vec3 col = mix(ground, sky, smoothstep(-0.06, 0.06, d.y)) * uSkyIntensity;

            float c = max(dot(d, uSunDir), 0.0);
            // Two lobes: a tight disc that becomes the specular highlight, and
            // a broad forward-scatter glow that lifts the whole sun quadrant.
            col += uSunColor * uSunIntensity * (pow(c, 1400.0) * 60.0 + pow(c, 8.0) * 0.28);

            // The shattered moon-ring: a great-circle band, and the reason a
            // blade catches teal on its shadow side in every frame of this game.
            float band = 1.0 - smoothstep(0.02, 0.075, abs(dot(d, uRingAxis)));
            col += uRingColor * band * uRingAlpha * 1.6 * smoothstep(-0.15, 0.1, d.y);

            gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
          }
        `,
      }));
    }

    const t = sky?.time ?? sky?.timeOfDay ?? opts.timeOfDay ?? HERO_TIME_OF_DAY;
    const key = sampleTimeOfDay(t);
    const u = this._probeMaterial.uniforms;
    u.uZenith.value.setHex(key.zenith, THREE.SRGBColorSpace);
    u.uHorizon.value.setHex(key.horizon, THREE.SRGBColorSpace);
    u.uGround.value.setHex(mixHex(LIGHT.BOUNCE_GROUND, key.fog, 0.4), THREE.SRGBColorSpace);
    u.uSunColor.value.setHex(key.sun, THREE.SRGBColorSpace);
    u.uSunIntensity.value = key.sunIntensity;
    // Sky radiance is scaled off the key's ambient budget so that a night probe
    // does not light a scene like noon; §3 defines ambient relative to a 3.0 key.
    u.uSkyIntensity.value = 0.35 + key.ambient * 1.9;
    u.uRingAlpha.value = key.ringAlpha;

    const dir = sky?.sunDirection;
    if (dir && dir.isVector3) u.uSunDir.value.copy(dir).normalize();
    else {
      const elev = (key.sunElevationDeg * Math.PI) / 180;
      const az = t * Math.PI * 2;
      u.uSunDir.value.set(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev)).normalize();
    }
    const sunCol = sky?.sunColor;
    if (sunCol && sunCol.isColor) u.uSunColor.value.copy(sunCol);

    const dome = new THREE.Mesh(this._probeGeometry, this._probeMaterial);
    dome.frustumCulled = false;
    return dome;
  }

  // ------------------------------------------------------------- lifetime

  /**
   * Take ownership of a disposable and neutralise its public `dispose()`.
   * See the class comment: `Engine.disposeTree` would otherwise destroy the
   * shared library the first time any scene using it unmounts.
   */
  _own(res) {
    if (!res || res.__forgeOwned) return res;
    const proto = res.isTexture
      ? THREE.Texture.prototype.dispose
      : res.isBufferGeometry
        ? THREE.BufferGeometry.prototype.dispose
        : THREE.Material.prototype.dispose;
    Object.defineProperty(res, '__forgeOwned', { value: true, enumerable: false });
    Object.defineProperty(res, '__forgeDispose', { value: () => proto.call(res), enumerable: false });
    res.dispose = () => {};
    this._owned.push(res);
    return res;
  }

  /**
   * Pre-generate a set of surfaces. Scenes call this during their async
   * `mount()` so the cost lands on the loading veil rather than as a stutter
   * the first time a prop enters frame.
   */
  warm(keys) {
    for (const key of keys) {
      try {
        this.material(key);
      } catch (err) {
        console.warn(`[AssetForge] warm("${key}") failed`, err);
      }
    }
    return this;
  }

  stats() {
    return {
      textures: this._textures.size,
      surfaceSets: this._sets.size,
      materials: this._materials.size,
      generationMs: Math.round(this._generationMs),
      anisotropy: this._anisotropy,
      environment: this._envKey || null,
    };
  }

  dispose() {
    for (const res of this._owned) {
      try {
        res.__forgeDispose?.();
      } catch (err) {
        console.warn('[AssetForge] dispose failed', err);
      }
    }
    this._owned.length = 0;
    this._textures.clear();
    this._sets.clear();
    this._materials.clear();
    this._envTarget?.dispose();
    this._envTarget = null;
    this._envKey = '';
    this._pmrem?.dispose();
    this._pmrem = null;
    this._probeMaterial = null;
    this._probeGeometry = null;
  }
}
