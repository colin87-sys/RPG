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
  LIGHT, SURFACE_TINT, ENV_INTENSITY, sampleTimeOfDay, mixHex, unitChroma, HERO_TIME_OF_DAY,
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
  grass: 'ground',
  dirt: 'ground',
  sand: 'ground',
};

/**
 * Classes whose env-map contribution is *authored* by §4 rather than left at the
 * scene default, and which therefore take the probe on the material itself.
 *
 * This is not a micro-optimisation, it is a correctness fix. three overwrites
 * `envMapIntensity` with `scene.environmentIntensity` for any Standard-family
 * material that has no `envMap` of its own (WebGLRenderer, "material.envMap ===
 * null && scene.environment !== null"). A scene that dials its probe down — and
 * ours does, to 0.6, to keep environment saturation under character saturation
 * per REFERENCE §3 — silently throws away every per-class intensity the bible
 * specifies: metal's mandated 1.0 becomes 0.6, cloth's 0.25 becomes 0.6. Binding
 * the probe explicitly on these classes is the only way §4's table survives
 * contact with a scene-level probe dial.
 *
 * The set is exactly the classes §4 names a number for. Ground, foliage and the
 * plain `standard` surfaces are deliberately excluded: their intensity *is* the
 * 0.6 default, so the scene's dial and the bible's value are the same lever, and
 * leaving them on `scene.environment` both keeps the diagnostic silhouette pass
 * (which nulls `scene.environment`) honest and leaves the environment's overall
 * ambient level where the lighting rig calibrated it.
 */
const ENV_BOUND_CLASSES = new Set(['metal', 'crystal', 'silk', 'cloth', 'water']);

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

/**
 * Terrain material: a tiled detail set plus a macro layer plus distance-varying
 * detail frequency.
 *
 * The failure this exists to fix is specific. A ground plane textured by one
 * repeating map has *one* spatial frequency, and it has it everywhere: the same
 * grain at the character's feet and at the tree line sixty metres away. The eye
 * reads a constant-frequency field as a flat surface regardless of how good the
 * grain is, so near-field depth collapses and the bottom of the frame turns to
 * carpet. Three things fix it, and all three are needed:
 *
 * 1. **Macro albedo.** `macro-ground` sampled at ~1/32 the detail tiling — 8–15 m
 *    features at stage scale. Dry crowns tint warm and lift in value, damp
 *    troughs tint toward `SHADOW_TINT` and darken. The tints are unit-luminance
 *    chromaticities so the hue push cannot leak into the value structure, and
 *    the value drift is applied as a separate explicit term (§4: ±0.06–0.10
 *    linear). This is the layer that gives the ground *form* rather than texture.
 *
 * 2. **Macro-tied roughness.** §4 asks for ≥ ±0.08 roughness variation and
 *    "macro breakup"; the detail map supplies the former on its own but at the
 *    detail frequency, where it is invisible. Damp patches additionally drop
 *    roughness, because that is what makes a wet patch read as wet rather than
 *    as a dark stain.
 *
 * 3. **Distance-varying detail.** Past `fadeNear` the shader dissolves the
 *    detail albedo into the surface's own mean colour and relaxes the normal
 *    toward geometric, leaving the macro layer as the only structure in the far
 *    field. That is REFERENCE §3's "background elements are near-silhouettes
 *    with very little internal detail" applied to the ground plane.
 *
 *    This used to cross-fade into a re-sample of the *same* detail map at a
 *    quarter tiling, on the theory that the far ground still needs texture for
 *    the atmospheric gradient to grade. It does not, and the re-sample was the
 *    source of the review's "directional smearing and stretch streaks": grass
 *    is 2400 stamped blades laid along a coherent flow field, and magnifying
 *    that tile 4.3× turns 15 cm blades into 70 cm strokes that all lean the
 *    same way. Blown up and mip-blurred across the midground they read as
 *    brush drag. Any map with directional content — grass, sand ripples, dirt
 *    cracks — fails the same way, so the technique is gone rather than tuned.
 *
 * Implemented as a subclass rather than a bare `onBeforeCompile` because scenes
 * clone this material to tint it, and `Material.copy` copies a fixed field list
 * — an instance-assigned `onBeforeCompile` and its uniforms are both silently
 * dropped by `clone()`, which would leave the cloned terrain with the plain
 * shader and no warning anywhere. On the prototype it survives, and `copy()`
 * below carries the uniform values across.
 */
class GroundMaterial extends THREE.MeshStandardMaterial {
  constructor(params) {
    super(params);
    this.isGroundMaterial = true;
    // `Lighting.registerMaterial` decides whether a material already owns a
    // shader hook with `hasOwnProperty('onBeforeCompile')`, because
    // `Material.prototype.onBeforeCompile` is a no-op every material inherits
    // and chaining it would be pointless. A *subclass* prototype method reads
    // the same way, so CSM's `setupMaterial` overwrote this material's hook
    // outright and the entire ground shader silently reverted to stock — no
    // error, no warning, and a frame that looks plausible because the detail
    // maps are still bound. Installing the prototype implementation as an own
    // property makes the chain see it. Clone still works: the constructor runs
    // on every clone, so every instance re-installs it.
    this.onBeforeCompile = GroundMaterial.prototype.onBeforeCompile;
    this.groundUniforms = {
      uGroundMacroMap: { value: null },
      // 1/32 of the detail tiling. Expressed as a ratio, not a world size,
      // because the material never learns how many metres its caller spread the
      // detail map over — but the *ratio* to the detail frequency is exactly
      // what the "is this one frequency or several" read depends on.
      uGroundMacroScale: { value: 1 / 32 },
      // The surface's own mean albedo, in linear light — what the detail layer
      // dissolves into once it is too far away to resolve.
      uGroundMeanColor: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
      uGroundFade: { value: new THREE.Vector2(14, 62) },
      uGroundDrift: { value: 0.34 },
      uGroundRoughVar: { value: 0.11 },
      uGroundDryTint: { value: new THREE.Vector3(1, 1, 1) },
      uGroundDampTint: { value: new THREE.Vector3(1, 1, 1) },
    };
  }

  copy(source) {
    super.copy(source);
    if (source.isGroundMaterial) {
      const src = source.groundUniforms;
      const dst = this.groundUniforms;
      dst.uGroundMacroMap.value = src.uGroundMacroMap.value;
      dst.uGroundMacroScale.value = src.uGroundMacroScale.value;
      dst.uGroundMeanColor.value.copy(src.uGroundMeanColor.value);
      dst.uGroundFade.value.copy(src.uGroundFade.value);
      dst.uGroundDrift.value = src.uGroundDrift.value;
      dst.uGroundRoughVar.value = src.uGroundRoughVar.value;
      dst.uGroundDryTint.value.copy(src.uGroundDryTint.value);
      dst.uGroundDampTint.value.copy(src.uGroundDampTint.value);
    }
    return this;
  }

  /** Ratio of macro tiling to detail tiling. Lower = larger macro features. */
  get macroScale() { return this.groundUniforms.uGroundMacroScale.value; }
  set macroScale(v) { this.groundUniforms.uGroundMacroScale.value = v; }

  /** Peak multiplicative albedo swing of the macro layer (±, linear). */
  get macroDrift() { return this.groundUniforms.uGroundDrift.value; }
  set macroDrift(v) { this.groundUniforms.uGroundDrift.value = v; }

  /** Peak roughness swing driven by the macro layer (±, absolute). */
  get macroRoughness() { return this.groundUniforms.uGroundRoughVar.value; }
  set macroRoughness(v) { this.groundUniforms.uGroundRoughVar.value = v; }

  /** Distance (m) at which detail frequency starts dropping. */
  get detailFadeNear() { return this.groundUniforms.uGroundFade.value.x; }
  set detailFadeNear(v) { this.groundUniforms.uGroundFade.value.x = v; }

  /** Distance (m) at which only the coarse layer survives. */
  get detailFadeFar() { return this.groundUniforms.uGroundFade.value.y; }
  set detailFadeFar(v) { this.groundUniforms.uGroundFade.value.y = v; }

  onBeforeCompile(shader) {
    Object.assign(shader.uniforms, this.groundUniforms);

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      /* glsl */ `#include <common>
        uniform sampler2D uGroundMacroMap;
        uniform float uGroundMacroScale;
        uniform vec3 uGroundMeanColor;
        uniform vec2 uGroundFade;
        uniform float uGroundDrift;
        uniform float uGroundRoughVar;
        uniform vec3 uGroundDryTint;
        uniform vec3 uGroundDampTint;
        float gFar = 0.0;
        float gDamp = 0.0;
        float gRoughDrift = 0.0;`,
    ).replace(
      '#include <map_fragment>',
      /* glsl */ `#include <map_fragment>
        #ifdef USE_MAP
        {
          vec4 gMacro = texture2D( uGroundMacroMap, vMapUv * uGroundMacroScale );
          gFar = smoothstep( uGroundFade.x, uGroundFade.y, length( vViewPosition ) );

          // Dissolve to the surface mean rather than to a magnified re-sample.
          // The macro layer below still varies the far ground's value and hue,
          // so it does not go dead flat — but nothing out there carries a
          // *direction* any more, which is what was reading as brush drag.
          // Multiplied by the diffuse uniform because at this point in the order
          // diffuseColor already carries the material tint, and scenes do tint
          // the stage floor — dissolving toward the untinted mean would leave a
          // ring of raw, more saturated albedo at exactly the distance the fog
          // has not yet taken over.
          diffuseColor.rgb = mix( diffuseColor.rgb, uGroundMeanColor * diffuse, gFar * 0.85 );

          // Two decorrelated periods of value drift, so the macro layer itself
          // is not single-frequency — which would only move the problem up a
          // decade rather than solve it.
          float gDrift = ( gMacro.r - 0.5 ) * 1.35 + ( gMacro.a - 0.5 ) * 0.9;
          float gMoist = gMacro.g * 2.0 - 1.0;
          float gDry = clamp( - gMoist, 0.0, 1.0 );
          gDamp = clamp( gMoist, 0.0, 1.0 );
          gRoughDrift = gMacro.b * 2.0 - 1.0;

          // Unit-luminance chroma: this rotates hue without touching value, so
          // the drift term below is the only thing moving the histogram.
          //
          // Both mixes are pulled back from 0.55/0.70. Hue is the channel the
          // eye reads as *material*, and a ground swinging between warm bounce
          // and cold shadow tint over 15 m stops being one surface with form on
          // it and becomes two substances marbled together. Value drift carries
          // the form; the tint is only allowed to season it.
          vec3 gTint = mix( vec3( 1.0 ), uGroundDryTint, gDry * 0.38 );
          gTint = mix( gTint, uGroundDampTint, gDamp * 0.52 );
          diffuseColor.rgb *= gTint * ( 1.0 + gDrift * uGroundDrift - gDamp * 0.22 );
        }
        #endif`,
    ).replace(
      '#include <roughnessmap_fragment>',
      /* glsl */ `#include <roughnessmap_fragment>
        #ifdef USE_MAP
        // Damp ground is smoother, and that is most of why a wet patch reads as
        // wet rather than as a dark stain painted on dry earth.
        roughnessFactor = clamp(
          roughnessFactor + gRoughDrift * uGroundRoughVar - gDamp * 0.20,
          0.06, 1.0 );
        #endif`,
    ).replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `#include <normal_fragment_maps>
        #ifdef USE_MAP
        // Two reasons to relax the detail normal toward geometric.
        //
        // Distance: held at full strength to the horizon it becomes
        // high-frequency static across the back half of the frame, which is the
        // specific artefact that made the ground read as carpet — the normal,
        // not the albedo, was doing it.
        //
        // Moisture: a damp hollow is packed and smooth where the dry crown is
        // tufted. Without this the macro layer is only a tint, and a tint over
        // identical relief still reads as one material with a stain on it.
        normal = normalize( mix( normal, nonPerturbedNormal,
          clamp( gFar * 0.9 + gDamp * 0.45, 0.0, 1.0 ) ) );
        #endif`,
    );
  }

  /**
   * All ground materials compile the same injected source, so one key is
   * correct and lets three share programs across grass, dirt and sand.
   */
  customProgramCacheKey() {
    return 'aw-ground-1';
  }
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
      case 'ground': {
        mat = new GroundMaterial(common);
        const u = mat.groundUniforms;
        u.uGroundMacroMap.value = this.texture('macro-ground');
        // Measured off the map we just generated rather than authored, so a
        // change to the grass or sand generator cannot leave the far field
        // dissolving toward a colour the near field no longer has.
        const mean = meta.meanLinear;
        u.uGroundMeanColor.value.set(mean[0], mean[1], mean[2]);
        // Dry earth pushes toward the bible's warm bounce; damp earth toward
        // SHADOW_TINT. Both as unit chroma, so the ground gains the teal-amber
        // spread §2.1 asks for without any change to its luminance band.
        const dry = unitChroma(LIGHT.BOUNCE_GROUND);
        const damp = unitChroma(LIGHT.SHADOW_TINT);
        u.uGroundDryTint.value.set(dry[0], dry[1], dry[2]);
        u.uGroundDampTint.value.set(damp[0], damp[1], damp[2]);
        // Sand sits at the top of the albedo bands (§4: 0.28–0.50 linear against
        // grass's 0.12–0.32), so the same multiplicative drift would push its
        // crowns past §2.3's 0.85 ceiling for non-highlight surfaces. Scaled so
        // the absolute swing lands in the same 0.06–0.10 linear window.
        if (baseKey === 'sand') u.uGroundDrift.value = 0.22;
        break;
      }
      default: {
        mat = new THREE.MeshStandardMaterial(common);
        break;
      }
    }

    mat.name = `forge:${baseKey}`;
    mat.userData.forgeClass = cls;
    // §4: "every hero material gets an env-map contribution from
    // art.environment()". If the probe already exists it is bound now; if the
    // scene builds it later, `environment()` back-fills every material the forge
    // has handed out.
    if (this._envTarget && ENV_BOUND_CLASSES.has(cls)) mat.envMap = this._envTarget.texture;

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
    this._bindEnvironment();
    return target.texture;
  }

  /** Push the current probe onto every forge material whose §4 intensity is authored. */
  _bindEnvironment() {
    const tex = this._envTarget?.texture ?? null;
    for (const mat of this._materials.values()) {
      if (!ENV_BOUND_CLASSES.has(mat.userData.forgeClass)) continue;
      if (mat.envMap === tex) continue;
      // Swapping one PMREM for another does not change the program, so only a
      // change in *presence* justifies a recompile — a time-of-day sweep
      // rebuilds the probe repeatedly and must not stall on shader compilation.
      const had = mat.envMap != null;
      mat.envMap = tex;
      if (had !== (tex != null)) mat.needsUpdate = true;
    }
  }

  /**
   * Bind the current probe onto materials the forge did not build.
   *
   * Characters are the reason this is public. `render/ToonMaterial.js` builds
   * the weapon and armour materials, and a metal with `envMapIntensity 1.0` and
   * no `envMap` reflects nothing — a blade lit only by the analytic key is a
   * flat lozenge with one specular line on it, which is exactly what §7.13
   * calls out. Handing the probe in explicitly also protects the authored
   * intensity from `scene.environmentIntensity`, which three would otherwise
   * substitute for it (see `ENV_BOUND_CLASSES`).
   *
   * @param {THREE.Object3D|THREE.Material|Array} target subtree, material, or list
   * @param {Object} [opts] `{ intensity }` to also force `envMapIntensity`
   * @returns {number} how many materials were bound
   */
  applyEnvironment(target, opts = {}) {
    const tex = this._envTarget?.texture ?? null;
    if (!tex || !target) return 0;
    let count = 0;

    const bind = (mat) => {
      if (!mat || !('envMap' in mat)) return;
      const had = mat.envMap != null;
      mat.envMap = tex;
      if (opts.intensity !== undefined) mat.envMapIntensity = opts.intensity;
      if (!had) mat.needsUpdate = true;
      count++;
    };
    const visit = (m) => {
      if (Array.isArray(m)) m.forEach(bind);
      else bind(m);
    };

    if (Array.isArray(target)) target.forEach(visit);
    else if (target.isMaterial) visit(target);
    else if (target.isObject3D) target.traverse((o) => { if (o.material) visit(o.material); });

    return count;
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
