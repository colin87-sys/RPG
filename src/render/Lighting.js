/**
 * Lighting — the three-point rig, the cascaded shadow solver and the dynamic
 * light budget.
 *
 * REFERENCE_TARGET section 1 is unambiguous about what this module exists to
 * deliver: a chibi character, roughly eighty pixels tall, must separate from a
 * misty desaturated background in every single frame. That is a *lighting*
 * problem before it is a shading problem, and it decomposes into exactly three
 * jobs:
 *
 *  1. **KEY** — one directional light, colour and direction taken verbatim from
 *     `Sky` so the shadow direction and the sun disc in frame can never drift
 *     apart. Its relative intensity through the day is the ART_BIBLE section 3
 *     table, which `Sky` already interpolates; re-deriving it here would give
 *     the game two disagreeing opinions about noon.
 *
 *  2. **FILL** — a hemisphere light, never an `AmbientLight` (ART_BIBLE section
 *     7.5: ambient above 20% kills form, and a constant term kills it entirely).
 *     Its sky colour is the *actual* rendered sky zenith pushed halfway to
 *     `SHADOW_TINT`, which is the literal formula in section 2.1's shadow rule.
 *     Its ground colour is `BOUNCE_GROUND`. Both are run through a saturation
 *     floor before they reach the light, so the rule ("a white surface in full
 *     shadow must not eyedrop to zero saturation") is enforced by construction
 *     rather than by hoping the inputs were tinted.
 *
 *  3. **RIM** — a second directional light 150 degrees around in azimuth from
 *     the key, lifted above the horizon, tinted toward `RING_GLOW`. In this art
 *     style the rim is not garnish; it is the entire reason the silhouette
 *     survives against fog of a similar value. It does not cast shadows — a
 *     shadowing back light fights the key for the same surfaces and costs a
 *     second full shadow pass for no visual gain.
 *
 * **Cascades.** Shadow texel density is what makes a 1.2 m chibi read as a solid
 * object rather than a smudge, and a single ortho frustum stretched over a 120 m
 * field cannot deliver it. We drive `three/examples/jsm/csm/CSM.js` (verified
 * present in three 0.185; the WebGPU-only `CSMShadowNode` is the one to avoid),
 * with a custom split so cascade 0 lands around 9 m — the distance the fixed
 * side-view battle camera actually stands at. CSM's own `practical` mode hard-
 * codes lambda 0.5, which spends far too much of the near cascade on empty air.
 *
 * CSM requires every lit material to be registered so its shader can select a
 * cascade instead of summing all of them. In a codebase where a dozen authors
 * build materials in parallel, "remember to call `setupMaterial`" is a bug
 * waiting to happen, so this module scans the active scene on a low-frequency
 * cadence and registers what it finds. Registration chains rather than replaces
 * `onBeforeCompile`, and `dispose()` unpatches everything — `AssetForge` caches
 * materials across scene swaps, so a stale closure holding a dead CSM instance
 * would otherwise survive into the next scene.
 *
 * **Light budget.** Adding or removing a light changes `NUM_POINT_LIGHTS`, which
 * invalidates every program in the scene. Doing that on a spell cast is a
 * guaranteed multi-frame hitch in the middle of combat. So the pool is allocated
 * once, at a size fixed by quality, and its lights are *always present and
 * always visible* — idle ones simply sit at intensity 0. Acquire never fails; if
 * the pool is saturated it evicts the lowest-priority, oldest light, because a
 * missing light on a Firaga is far more visible than a dimmed torch.
 *
 * OWNED BY: render/Lighting.js.
 */
import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { bus } from '../core/EventBus.js';
import { gameState, rng } from '../core/GameState.js';
import {
  LIGHT,
  MIN_SHADOW_SATURATION,
  SURFACE_TINT,
  HERO_TIME_OF_DAY,
  sampleTimeOfDay,
} from '../art/Palette.js';

/* -------------------------------------------------------------------------- */
/* Tuning constants — every one of these is a decision, not a magic number.    */
/* -------------------------------------------------------------------------- */

/**
 * Quality tiers.
 *
 * `cascades` never drops below 3 even on `low`: two cascades over a 120 m range
 * puts the split at ~25 m, and the far cascade's texels become coarse enough
 * that a character's contact shadow detaches. `shadowMapSize` never drops below
 * 1024 because ART_BIBLE section 7.6 lists sub-1024 key shadows as a failed
 * review. `pointLights` is the hard budget the pool allocates up front.
 */
const QUALITY = {
  low: { cascades: 3, shadowMapSize: 1024, pointLights: 3, shadowPoint: false },
  medium: { cascades: 3, shadowMapSize: 2048, pointLights: 4, shadowPoint: false },
  high: { cascades: 4, shadowMapSize: 2048, pointLights: 6, shadowPoint: true },
  ultra: { cascades: 4, shadowMapSize: 3072, pointLights: 8, shadowPoint: true },
};

/**
 * Split blend between a uniform and a logarithmic cascade distribution.
 *
 * 0 is uniform (wastes the near cascade), 1 is logarithmic (starves the far
 * one). 0.72 puts the first break at ~9 m for a 0.1–120 m range over four
 * cascades, which brackets the fixed side-view battle stage: the whole party
 * and the enemy line sit inside cascade 0 at roughly 1 cm texels.
 */
const SPLIT_LAMBDA = 0.72;

/** Default shadow range in metres. Beyond this, fog has eaten the contrast
 *  anyway (ART_BIBLE section 5.5 wants layers separated by 25–40 m), so shadows
 *  there would cost texels to render something the grade throws away. */
const DEFAULT_SHADOW_DISTANCE = 120;

/** Distance the cascade light is pulled back along its own direction. Must
 *  clear the tallest caster above a cascade slice; a boss occupying 60% of
 *  frame height is under 10 m, so 45 m is generous without wasting depth range. */
const LIGHT_MARGIN = 45;

/** Rim azimuth offset. Not 180: a true back light rims both edges equally and
 *  reads as a halo. 150 leaves one edge dominant, which is what the reference
 *  frames show and what gives the silhouette a direction. */
const RIM_AZIMUTH_DEG = 150;

/** Rim elevation is derived from the key's, but clamped into this band. Below
 *  the floor it grazes the ground and misses the oversized chibi head — the one
 *  part of the silhouette that must always catch it. Above the ceiling it
 *  becomes a second key and flattens the form. */
const RIM_ELEVATION_MIN_DEG = 14;
const RIM_ELEVATION_MAX_DEG = 40;
const RIM_ELEVATION_FROM_KEY = 0.32;
const RIM_ELEVATION_BASE_DEG = 17;

/** ART_BIBLE section 5.6 sizes rims at 0.8 (`RING_GLOW`) to 1.2 (key-coloured).
 *  REFERENCE_TARGET asks for the strong end of that, every frame. */
const RIM_INTENSITY_NIGHT = 0.85;
const RIM_INTENSITY_DAY = 1.32;

/** How far the rim's chroma is allowed to drift from `RING_GLOW` toward the key
 *  in full daylight. A dusk rim wants a trace of the sun's amber in it; letting
 *  it go further than this loses the cool separation the palette depends on. */
const RIM_KEY_TINT = 0.2;

/**
 * ART_BIBLE section 2.1's shadow rule has two clauses, and at some times of day
 * they disagree with the recipe printed beside them. `mix(skyZenith,
 * SHADOW_TINT, 0.5)` at dusk — where the zenith key is the violet `#35275E` —
 * lands on hue 227, which is 21 degrees outside the "+/-8 degrees of hue 206"
 * window the same paragraph calls mandatory and testable. The mix sets value
 * and saturation from the sky the player can actually see; this window then
 * pins the hue, so both clauses hold instead of one silently losing.
 */
const SHADOW_HUE_DEG = 206;
const SHADOW_HUE_WINDOW_DEG = 8;

/**
 * How much of the ground bounce's chroma survives at night.
 *
 * The bounce must stay *warmer* than the key (section 2.1) even when the key is
 * the cold ring, so its hue is never touched — only its saturation is pulled
 * back, because at night there is no warm sun to bounce and a full-strength
 * amber floor would be light with no source. Drifting the hue toward the fill
 * instead was the obvious move and the wrong one: an amber-to-teal chroma mix
 * passes straight through neutral at its midpoint, which is exactly the grey
 * shadow the rule exists to forbid.
 */
const BOUNCE_NIGHT_CHROMA = 0.55;

/** Fraction of the section 3 `ambient` budget the hemisphere keeps once a PMREM
 *  probe is also lighting the scene. The probe supplies directional sky
 *  occlusion the hemisphere cannot; the hemisphere supplies ground bounce and
 *  the mandated shadow tint the probe has no ground to produce. */
const HEMI_SHARE_WITH_PROBE = 0.62;

/**
 * Target penumbra width in metres.
 *
 * three 0.185 deprecates `PCFSoftShadowMap` and silently downgrades it to
 * `PCFShadowMap`, whose kernel *is* driven by `shadow.radius` — measured in
 * texels. Texel size differs by an order of magnitude between the near and far
 * cascade, so a single radius would give a mushy far shadow and a hard near
 * one. Solving the radius per cascade from this world-space target instead
 * keeps the penumbra visually constant, which is what "soft shadows" has to
 * mean when the subject can be anywhere in the frustum.
 */
const PENUMBRA_METRES = 0.035;
const PENUMBRA_RADIUS_MIN = 1;
/** Above ~3 the fixed 9-tap PCF kernel starts to show as banding, not blur. */
const PENUMBRA_RADIUS_MAX = 3;

/**
 * VSM's `radius` drives a separable Gaussian over the moment map rather than a
 * PCF tap pattern, so it can be pushed several times further for the same cost
 * — which is the whole reason core selects VSM. Bounded above because the blur
 * is applied in shadow-map space: past ~6 texels the near cascade's penumbra
 * starts detaching a chibi's feet from its own contact shadow.
 */
const VSM_RADIUS_MIN = 1.5;
const VSM_RADIUS_MAX = 6;
/** Enough taps that the widest kernel above does not band on flat ground. */
const VSM_BLUR_SAMPLES = 12;

/** Shadows are never fully black — section 2.3 crushes blacks to ~0.02 and
 *  tints them, so leaving 6% of the key in shadow keeps form readable inside
 *  the shadow mass instead of dumping it onto the fill alone. */
const SHADOW_INTENSITY = 0.94;

/** Exponential-smoothing time constants, in seconds. All comfortably above the
 *  150 ms floor ART_BIBLE section 7.8 puts on any visible state change. */
const TAU_COLOR = 0.45;
const TAU_DIRECTION = 0.6;
const TAU_EXPOSURE = 0.5;

/** How often the scene is rescanned for materials that still need CSM wiring.
 *  Meshes stream in during a mount and props spawn during play; 5 Hz is
 *  imperceptible as latency and costs one `traverse` of a few thousand nodes. */
const MATERIAL_SCAN_INTERVAL = 0.2;

/* -------------------------------------------------------------------------- */
/* Maths helpers — all allocation-free.                                        */
/* -------------------------------------------------------------------------- */

/** Smoothstep that tolerates a descending edge pair (`THREE.MathUtils.smoothstep`
 *  early-returns 0 when min > max, silently killing descending fades). */
function sstep(x, a, b) {
  if (a === b) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential approach. Lerping by a constant per frame
 * makes the glide speed a function of the display refresh rate, which shows up
 * as a different time-of-day transition on a 144 Hz monitor than in a 60 fps
 * capture — and the capture is what gets reviewed.
 */
function approach(dt, tau) {
  return 1 - Math.exp(-dt / Math.max(1e-4, tau));
}

/** Shortest-arc interpolation between unit vectors, stable at both degenerate
 *  ends. Lerping directions instead would swing the key through the origin when
 *  the sun crosses the horizon at night. */
function slerpDir(a, b, w, out) {
  if (w <= 1e-4) return out.copy(a);
  if (w >= 1 - 1e-4) return out.copy(b);
  const d = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  const theta = Math.acos(d);
  const s = Math.sin(theta);
  if (s < 1e-3) return out.copy(a).lerp(b, w).normalize();
  return out.copy(a).multiplyScalar(Math.sin((1 - w) * theta) / s)
    .addScaledVector(b, Math.sin(w * theta) / s).normalize();
}

const LR = 0.2126;
const LG = 0.7152;
const LB = 0.0722;

function lumOf(c) {
  return LR * c.r + LG * c.g + LB * c.b;
}

/**
 * Mix two colours' *chromaticities* while keeping `out`'s luminance equal to
 * `a`'s.
 *
 * A plain linear lerp between a bright key and a dim tint is dominated by
 * whichever has the larger magnitude, so `RING_GLOW.lerp(sunColor, 0.2)` at
 * noon produces near-white rather than a cool rim with a hint of sun in it.
 * Normalising both to unit luminance first mixes hue and saturation only; the
 * value is then restored explicitly. `Palette.toonRamp` makes the same move for
 * the same reason, and the two must agree or the character's rim band and the
 * rim light will disagree about colour.
 */
function mixChroma(a, b, t, out) {
  const ya = lumOf(a) || 1e-6;
  const yb = lumOf(b) || 1e-6;
  out.setRGB(
    (a.r / ya) * (1 - t) + (b.r / yb) * t,
    (a.g / ya) * (1 - t) + (b.g / yb) * t,
    (a.b / ya) * (1 - t) + (b.b / yb) * t,
    THREE.LinearSRGBColorSpace,
  );
  const y = lumOf(out) || 1e-6;
  return out.multiplyScalar(ya / y);
}

/* -------------------------------------------------------------------------- */

/**
 * One slot in the dynamic point-light pool. The light itself is permanent; only
 * its envelope state is recycled.
 */
class LightSlot {
  constructor(index, canCastShadow) {
    this.index = index;
    this.serial = 0;
    this.active = false;
    this.priority = 0;
    this.age = 0;

    // Envelope, in seconds. `hold = Infinity` marks a persistent light that
    // only starts its release ramp when the owner calls `release()`.
    this.t = 0;
    this.attack = 0.06;
    this.hold = Infinity;
    this.release = 0.35;

    this.peak = 0;
    this.flicker = 0;
    this.phase = 0;
    /** Last envelope value, pre-flicker. Released lights ramp down from this
     *  rather than from 1.0, so cancelling a light mid-attack fades from where
     *  it actually was instead of jumping to full brightness first. */
    this.env = 0;
    this.releaseFrom = 1;

    const light = new THREE.PointLight(0xffffff, 0, 10, 2);
    light.castShadow = false;
    // Never toggled. `visible = false` removes the light from the render state
    // and changes NUM_POINT_LIGHTS, which is precisely the recompile the pool
    // exists to prevent.
    light.visible = true;
    if (canCastShadow) {
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.camera.near = 0.15;
      light.shadow.camera.far = 24;
      light.shadow.bias = -0.0008;
      light.shadow.normalBias = 0.03;
      light.shadow.radius = 2;
      light.shadow.intensity = SHADOW_INTENSITY;
      // Rendering six cube faces for a light at zero intensity is pure waste,
      // but the shadow map must exist before the first frame samples it — so it
      // is baked once at startup and then frozen until something acquires the
      // slot. `_warmFrames` counts those first renders down.
      this._warmFrames = 2;
    }
    this.light = light;
    this.canCastShadow = canCastShadow;
  }

  dispose() {
    this.light.shadow?.map?.dispose();
    this.light.parent?.remove(this.light);
  }
}

/**
 * The token handed back by `acquire`. Holding the slot itself would let a stale
 * caller release a light that has since been recycled under it, which produces
 * a spell whose glow vanishes because a torch three seconds ago called
 * `release()` late. The serial check makes that impossible.
 */
class LightHandle {
  constructor(pool, slot) {
    this._pool = pool;
    this._slot = slot;
    this._serial = slot.serial;
    this.light = slot.light;
  }

  get alive() {
    return this._slot.active && this._slot.serial === this._serial;
  }

  setPosition(x, y, z) {
    if (this.alive) {
      if (x && typeof x === 'object') this._slot.light.position.copy(x);
      else this._slot.light.position.set(x, y, z);
    }
    return this;
  }

  setColor(c) {
    if (this.alive) this._slot.light.color.set(c);
    return this;
  }

  /** Retarget the envelope peak without restarting the envelope. */
  setIntensity(v) {
    if (this.alive) this._slot.peak = Math.max(0, v);
    return this;
  }

  /** Begin the release ramp. Persistent lights fade rather than snap off —
   *  ART_BIBLE section 7.8 forbids an un-eased visible state change. */
  release() {
    if (this.alive) this._pool._beginRelease(this._slot);
    return this;
  }
}

/* -------------------------------------------------------------------------- */

export class Lighting {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {import('./Sky.js').Sky|null} sky Outdoor scenes pass their dome;
   *   interiors may pass null, in which case the rig drives itself from the
   *   ART_BIBLE time-of-day table directly.
   */
  constructor(engine, sky = null) {
    this.engine = engine;
    this.sky = sky ?? engine?.get?.('sky') ?? null;
    this.scene = null;

    this.group = new THREE.Group();
    this.group.name = 'LightingRig';
    // The rig is analytic: its lights are positioned in world space every frame
    // and nothing is ever parented under it, so culling it would be a no-op cost.
    this.group.frustumCulled = false;

    /** Multiplier scenes may push to make the rim hotter for a shot. */
    this.rimBoost = 1;
    /** Furthest distance that receives cascaded shadows, in metres. */
    this.shadowDistance = DEFAULT_SHADOW_DISTANCE;
    /** Fallback clock for scenes with no sky dome. */
    this.timeOfDay = gameState.state.timeOfDay ?? HERO_TIME_OF_DAY;

    // ---- fill ------------------------------------------------------------
    // Colours are placeholders; `_sampleTarget` overwrites them before the
    // first frame. Position is the hemisphere axis and stays world-up.
    this.fill = new THREE.HemisphereLight(LIGHT.FOG_NEAR, LIGHT.BOUNCE_GROUND, 0.55);
    this.fill.position.set(0, 1, 0);
    this.group.add(this.fill);

    // ---- rim -------------------------------------------------------------
    this.rim = new THREE.DirectionalLight(LIGHT.RING_GLOW, RIM_INTENSITY_DAY);
    this.rim.castShadow = false;
    this.rim.name = 'RimLight';
    this.group.add(this.rim, this.rim.target);

    /**
     * Shared uniform block for hand-written toon materials.
     *
     * The character shader cannot read three's `directionalLights` array and
     * know which entry is the rim — the renderer sorts shadow casters first and
     * the cascade count changes with quality. So the rim term is published here
     * as stable object identities: a `ShaderMaterial` that splices these
     * straight into its `uniforms` gets them updated every frame for free, with
     * no per-frame lookup and no chance of reading a cascade by mistake.
     *
     * `uKeyColor` / `uRimColor` are premultiplied by intensity so the shader
     * does not need to know the rig's intensity convention.
     */
    this.uniforms = {
      uKeyDirection: { value: new THREE.Vector3(0, 1, 0) },
      uKeyColor: { value: new THREE.Color(1, 1, 1) },
      uRimDirection: { value: new THREE.Vector3(0, 1, 0) },
      uRimColor: { value: new THREE.Color(1, 1, 1) },
      uRimPower: { value: 2.6 },
      uRimStrength: { value: 1.0 },
      uFillSky: { value: new THREE.Color() },
      uFillGround: { value: new THREE.Color() },
      uShadowTint: { value: new THREE.Color(LIGHT.SHADOW_TINT) },
    };

    // ---- eased rig state -------------------------------------------------
    this._target = Lighting._makeRigState();
    this._current = Lighting._makeRigState();

    // ---- scratch ---------------------------------------------------------
    this._vecA = new THREE.Vector3();
    this._vecB = new THREE.Vector3();
    this._zenith = new THREE.Color(0x33628f);
    this._shadowTint = new THREE.Color(LIGHT.SHADOW_TINT);
    this._bounce = new THREE.Color(LIGHT.BOUNCE_GROUND);
    this._ringGlow = new THREE.Color(LIGHT.RING_GLOW);
    this._hsl = { h: 0, s: 0, l: 0 };
    this._lensKey = '';
    this._lastFrame = -1;
    this._scanTimer = 0;

    // ---- CSM + point pool -------------------------------------------------
    /** @type {Map<THREE.Material, Function|null>} material -> prior onBeforeCompile */
    this._patched = new Map();
    /** @type {LightSlot[]} */
    this._slots = [];
    this.csm = null;

    this.quality = gameState.state.settings?.quality ?? 'high';
    this._build(this.quality);

    // Quality is a global setting; main.js only forwards it to PostFX, so the
    // rig subscribes for itself rather than requiring a second forwarder.
    this._unsubscribe = bus.on('settings:changed', ({ key, value }) => {
      if (key === 'quality') this.setQuality(value);
    });

    this.sync();
  }

  /** The eased state the rig is actually driving lights from. */
  static _makeRigState() {
    return {
      keyDir: new THREE.Vector3(0.3, 0.85, 0.43).normalize(),
      keyColor: new THREE.Color(0xffead0),
      keyIntensity: 3,
      fillSky: new THREE.Color(0x2e4a5f),
      fillGround: new THREE.Color(LIGHT.BOUNCE_GROUND),
      fillIntensity: 0.55,
      rimDir: new THREE.Vector3(-0.5, 0.5, -0.7).normalize(),
      rimColor: new THREE.Color(LIGHT.RING_GLOW),
      rimIntensity: RIM_INTENSITY_DAY,
      exposure: 1,
    };
  }

  /* ------------------------------------------------------------------ setup */

  /**
   * Build (or rebuild) everything whose *count* is fixed by quality: the
   * cascade lights and the point-light pool. Anything that changes an array
   * length in the shader belongs here and nowhere else, so recompiles happen
   * exactly at a quality change and never during play.
   */
  _build(level) {
    const q = QUALITY[level] ?? QUALITY.high;
    this._q = q;

    const camera = this._activeCamera();
    this.csm = new CSM({
      camera,
      parent: this.group,
      cascades: q.cascades,
      maxFar: this.shadowDistance,
      mode: 'custom',
      customSplitsCallback: Lighting._splitCallback,
      shadowMapSize: q.shadowMapSize,
      lightIntensity: this._current.keyIntensity,
      lightDirection: this._vecA.copy(this._current.keyDir).negate().normalize().clone(),
      lightNear: 0.5,
      // Must cover the deepest cascade's extent along the light axis plus the
      // pull-back margin; a low sun stretches that well past the shadow range.
      lightFar: this.shadowDistance * 2.5 + LIGHT_MARGIN,
      lightMargin: LIGHT_MARGIN,
    });
    // Blended seams. Set before `updateFrustums` so the per-cascade bounds are
    // expanded by the fade margin, and before any material is registered so the
    // CSM_FADE define is baked into the first compile rather than causing a
    // second one.
    this.csm.fade = true;
    this.csm.updateFrustums();
    this._applyCascadeBias();

    for (let i = 0; i < q.pointLights; i++) {
      // Exactly one slot is allowed to cast: ART_BIBLE section 7.6 forbids a
      // shadowless point light on a hero subject, but a cube shadow per spell
      // would blow the frame budget, so the rig offers one and prioritises it.
      const slot = new LightSlot(i, q.shadowPoint && i === 0 && this._pointShadowsSupported());
      this.group.add(slot.light);
      this._slots.push(slot);
    }
  }

  /**
   * Cascade split. CSM's built-in `practical` mode is a fixed 50/50 blend of
   * uniform and logarithmic; we want a heavier logarithmic bias so the first
   * cascade hugs the subject. Returns normalised distances ending at 1.
   */
  static _splitCallback(amount, near, far, target) {
    for (let i = 1; i < amount; i++) {
      const uniform = (near + ((far - near) * i) / amount) / far;
      const logarithmic = (near * (far / near) ** (i / amount)) / far;
      target.push(THREE.MathUtils.lerp(uniform, logarithmic, SPLIT_LAMBDA));
    }
    target.push(1);
  }

  /**
   * Per-cascade depth and normal bias, derived from each cascade's own world-
   * space texel size rather than hand-tuned.
   *
   * Normal bias does the real work: it displaces the shadow lookup along the
   * surface normal by a little over one texel, which is exactly the geometric
   * cause of slope-dependent acne, and because the offset is proportional to
   * texel size the near cascade gets a 2 cm nudge (invisible on a 1.2 m chibi)
   * while the far cascade gets the larger offset it actually needs. A constant
   * bias tuned for the far cascade would peter-pan the near one; a constant
   * tuned for the near cascade would leave the far one crawling with acne.
   *
   * The depth bias is the small residual, expressed in the shadow camera's
   * normalised depth so it stays a fixed *world* distance regardless of how the
   * light's near/far range is configured.
   */
  _applyCascadeBias() {
    const size = this._q.shadowMapSize;
    const lights = this.csm.lights;
    const vsm = this._shadowType() === THREE.VSMShadowMap;
    for (let i = 0; i < lights.length; i++) {
      const shadow = lights[i].shadow;
      const cam = shadow.camera;
      const texel = (cam.right - cam.left) / size;
      const depthRange = Math.max(1e-3, cam.far - cam.near);
      shadow.normalBias = texel * 1.35 + 0.004;
      if (vsm) {
        // VSM compares moments, not depths: acne comes from variance
        // underestimation, not from the depth-slope error a PCF bias corrects,
        // and a negative bias here would simply pull the whole occluder
        // distribution forward and bleed light through solid geometry. The
        // normal bias above still earns its keep — it is a *geometric* offset,
        // independent of the comparison. Softness is the blur kernel: `radius`
        // is the separable blur's texel reach, so the same penumbra target
        // converts directly, and `blurSamples` is what stops that blur banding
        // on the far cascade where the kernel is widest in world terms.
        shadow.bias = 0;
        shadow.radius = THREE.MathUtils.clamp(
          PENUMBRA_METRES / Math.max(1e-5, texel),
          VSM_RADIUS_MIN, VSM_RADIUS_MAX,
        );
        shadow.blurSamples = VSM_BLUR_SAMPLES;
      } else {
        shadow.bias = -(texel * 0.5 + 0.02) / depthRange;
        shadow.radius = THREE.MathUtils.clamp(
          PENUMBRA_METRES / Math.max(1e-5, texel),
          PENUMBRA_RADIUS_MIN, PENUMBRA_RADIUS_MAX,
        );
      }
      shadow.intensity = SHADOW_INTENSITY;
    }
  }

  /** The renderer's shadow filter. Core owns it and may change it. */
  _shadowType() {
    return this.engine?.renderer?.shadowMap?.type ?? THREE.PCFShadowMap;
  }

  /**
   * Whether a `PointLight` in the pool may cast.
   *
   * three does not implement VSM for cube shadow maps: `WebGLShadowMap` warns
   * and skips the render, but the *program* is still generated with the point
   * shadow branch while `shadowmap_pars_fragment` omits the sampler array under
   * VSM — so every lit material in the scene fails to compile with
   * "'pointShadowMap' : undeclared identifier" and the frame goes black. The
   * pool therefore drops its one shadow-capable slot when core selects VSM,
   * which costs a cube shadow nobody can see and saves the whole renderer.
   */
  _pointShadowsSupported() {
    return this._shadowType() !== THREE.VSMShadowMap;
  }

  addTo(scene) {
    this.scene = scene;
    scene.add(this.group);
    this.refreshMaterials();
    this.sync();
    return this;
  }

  /** The camera the cascades must be fitted to — a scene may override the
   *  engine's, and BattleScene does exactly that for the fixed side view. */
  _activeCamera() {
    return this.engine?.scene?.camera ?? this.engine?.camera ?? null;
  }

  /* --------------------------------------------------------------- quality */

  /**
   * Rescale the rig. Cascade count and shadow resolution both change program
   * defines or texture allocations, so this tears the CSM down and rebuilds it;
   * every registered material is unpatched first and re-registered after, which
   * is what keeps a material from carrying a closure into a dead CSM instance.
   */
  setQuality(level) {
    if (!QUALITY[level] || level === this.quality) return this;
    this.quality = level;

    this._detachAll();
    this._teardown();
    this._build(level);
    this.refreshMaterials();
    this.sync();
    return this;
  }

  /** Change the cascaded shadow range. Cheap — no reallocation, just a refit. */
  setShadowDistance(metres) {
    this.shadowDistance = Math.max(20, metres);
    if (this.csm) {
      this.csm.maxFar = this.shadowDistance;
      this.csm.lightFar = this.shadowDistance * 2.5 + LIGHT_MARGIN;
      for (const l of this.csm.lights) {
        l.shadow.camera.far = this.csm.lightFar;
        l.shadow.camera.updateProjectionMatrix();
      }
      this.csm.updateFrustums();
      this._applyCascadeBias();
    }
    return this;
  }

  /* ------------------------------------------------------- material wiring */

  /**
   * Register one material with the cascade shader.
   *
   * `CSM.setupMaterial` overwrites `onBeforeCompile`; a character or water
   * material that installed its own hook would silently lose it, so the prior
   * hook is captured and chained. `hasOwnProperty` is the test that matters —
   * `Material.prototype.onBeforeCompile` is a no-op that every material
   * inherits, and treating that as a custom hook would chain a useless call on
   * every compile.
   */
  registerMaterial(material) {
    if (!material || this._patched.has(material) || !this.csm) return false;
    if (!Lighting._isLitMaterial(material)) return false;

    const own = Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile');
    const prior = own ? material.onBeforeCompile : null;

    this.csm.setupMaterial(material);
    const csmHook = material.onBeforeCompile;
    material.onBeforeCompile = function chainedCsmHook(shader, renderer) {
      csmHook.call(this, shader, renderer);
      if (prior) prior.call(this, shader, renderer);
    };
    material.needsUpdate = true;
    this._patched.set(material, prior);
    return true;
  }

  /**
   * Anything that walks three's lighting chunks. `ShaderMaterial` counts only
   * when it opted into lights; if such a shader does not `#include
   * <lights_fragment_begin>` the defines are inert, which is harmless — but if
   * it does, it gets correct cascade selection for free.
   */
  static _isLitMaterial(m) {
    return !!(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial
      || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial
      || (m.isShaderMaterial && m.lights === true));
  }

  /** Sweep the active scene for materials that still need wiring. */
  refreshMaterials() {
    if (!this.scene || !this.csm) return;
    this.scene.traverse((obj) => {
      const mat = obj.material;
      if (!mat) return;
      if (Array.isArray(mat)) {
        for (const m of mat) this.registerMaterial(m);
      } else {
        this.registerMaterial(mat);
      }
    });
  }

  /** Restore every patched material to the state it was handed to us in. */
  _detachAll() {
    for (const [material, prior] of this._patched) {
      if (prior) material.onBeforeCompile = prior;
      else delete material.onBeforeCompile;
      if (material.defines) {
        delete material.defines.USE_CSM;
        delete material.defines.CSM_CASCADES;
        delete material.defines.CSM_FADE;
      }
      material.needsUpdate = true;
    }
    this._patched.clear();
    // Clear CSM's own bookkeeping without letting its `dispose` delete the
    // hooks we have just restored.
    this.csm?.shaders.clear();
  }

  /* ------------------------------------------------------------- rig state */

  /**
   * Read the authoritative sources into `_target`. Never touches a light — the
   * easing in `update` is what actually drives them, so a scrub of the
   * time-of-day slider glides instead of cutting.
   */
  _sampleTarget() {
    const T = this._target;
    const sky = this.sky;
    let ambient;
    let sunHeight;

    if (sky) {
      // Sky already interpolates the ART_BIBLE section 3 table through a
      // periodic spline and already swings the key over to the moon-ring below
      // the horizon. Re-deriving any of it here would give the game two
      // opinions about what noon looks like.
      T.keyDir.copy(sky.sunDirection).normalize();
      T.keyColor.copy(sky.sunColor);
      T.keyIntensity = Math.max(0, sky.sunIntensity);
      T.exposure = sky.exposure;
      this._zenith.copy(sky.zenithColor);
      ambient = sky.ambientLevel;
      sunHeight = (sky.trueSunDirection ?? sky.sunDirection).y;
    } else {
      // Interior / no dome. Same table, same azimuth convention as Sky, so a
      // character walking indoors keeps a consistent key direction.
      const k = sampleTimeOfDay(this.timeOfDay);
      const elevation = THREE.MathUtils.degToRad(k.sunElevationDeg);
      const azimuth = THREE.MathUtils.degToRad(90 - (this.timeOfDay - 0.25) * 360);
      sunHeight = Math.sin(elevation);
      // A key arriving from below the floor lights nothing; keep the azimuth
      // and lift it, exactly as Sky does when the sun sets.
      const lifted = Math.max(Math.sin(elevation), 0.18);
      const ce = Math.sqrt(Math.max(0, 1 - lifted * lifted));
      T.keyDir.set(ce * Math.sin(azimuth), lifted, ce * Math.cos(azimuth)).normalize();
      T.keyColor.setHex(k.sun, THREE.SRGBColorSpace);
      T.keyIntensity = k.sunIntensity;
      T.exposure = k.exposure;
      this._zenith.setHex(k.zenith, THREE.SRGBColorSpace);
      ambient = k.ambient;
    }

    // `dayness` drives every "is this a sunlit frame" decision in the rig. It
    // is a function of the *true* sun height, not the key's, so the night rig
    // does not flip back to daylight just because the ring happens to be high.
    const dayness = sstep(sunHeight, -0.10, 0.25);

    // ---- fill ------------------------------------------------------------
    // ART_BIBLE section 2.1, literally: sky colour = mix(skyZenith, SHADOW_TINT, 0.5),
    // then held inside the hue window and above the saturation floor.
    T.fillSky.copy(this._zenith).lerp(this._shadowTint, 0.5);
    this._enforceShadowRule(T.fillSky, true);

    // Ground bounce keeps BOUNCE_GROUND's hue at every hour and loses only
    // chroma as the sun goes; see BOUNCE_NIGHT_CHROMA for why the hue is left
    // alone. The saturation floor still applies.
    T.fillGround.copy(this._bounce).getHSL(this._hsl, THREE.SRGBColorSpace);
    T.fillGround.setHSL(
      this._hsl.h,
      Math.max(
        MIN_SHADOW_SATURATION,
        this._hsl.s * THREE.MathUtils.lerp(BOUNCE_NIGHT_CHROMA, 1, dayness),
      ),
      this._hsl.l,
      THREE.SRGBColorSpace,
    );

    // Section 3's `ambient` column is the summed hemisphere + probe budget.
    // When a PMREM probe is present it carries the directional part, so the
    // hemisphere steps back to avoid double-counting the sky.
    const probed = !!this.scene?.environment;
    T.fillIntensity = ambient * (probed ? HEMI_SHARE_WITH_PROBE : 1);

    // ---- rim -------------------------------------------------------------
    // Azimuth 150 degrees around from the key; elevation derived from the key's
    // so a low dusk key gets a low, raking rim and a high noon key gets a
    // steeper one, both inside the band that actually catches a chibi head.
    const keyAz = Math.atan2(T.keyDir.x, T.keyDir.z);
    const rimAz = keyAz + THREE.MathUtils.degToRad(RIM_AZIMUTH_DEG);
    const keyElDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(T.keyDir.y, -1, 1)));
    const rimElDeg = THREE.MathUtils.clamp(
      RIM_ELEVATION_BASE_DEG + keyElDeg * RIM_ELEVATION_FROM_KEY,
      RIM_ELEVATION_MIN_DEG, RIM_ELEVATION_MAX_DEG,
    );
    const rimEl = THREE.MathUtils.degToRad(rimElDeg);
    const rce = Math.cos(rimEl);
    T.rimDir.set(rce * Math.sin(rimAz), Math.sin(rimEl), rce * Math.cos(rimAz)).normalize();

    // RING_GLOW is the palette's named rim colour; a fraction of the key's
    // chroma is folded in so a sunset rim carries a trace of the sun without
    // ever losing the cool separation the whole look depends on.
    mixChroma(this._ringGlow, T.keyColor, RIM_KEY_TINT * dayness, T.rimColor);
    T.rimIntensity = THREE.MathUtils.lerp(RIM_INTENSITY_NIGHT, RIM_INTENSITY_DAY, dayness)
      * this.rimBoost;
  }

  /**
   * ART_BIBLE section 2.1's testable clause, enforced in place.
   *
   * `Palette.applyShadowRule` implements the same policy by blending further
   * toward `SHADOW_TINT`, which is only an approximate correction — one blend
   * step is not guaranteed to clear the floor, and it measurably does not for
   * the dim, near-neutral fill colours this rig produces at night. Setting
   * saturation and hue directly in HSL is exact in one step, preserves
   * lightness (so a correction can never shift the scene's exposure), and
   * allocates nothing on a path that runs every frame the clock is moving.
   * Saturation is measured in sRGB because that is what an eyedropper reports.
   *
   * @param {boolean} clampHue also pin the hue into the +/-8 degree window.
   *   True for sky-derived fill, false for the deliberately warm ground bounce.
   */
  _enforceShadowRule(c, clampHue) {
    c.getHSL(this._hsl, THREE.SRGBColorSpace);
    const s = Math.max(this._hsl.s, MIN_SHADOW_SATURATION);
    let h = this._hsl.h;
    if (clampHue) {
      // Signed shortest angular distance, so a hue at 350 corrects downward
      // through zero rather than the long way round.
      let delta = ((this._hsl.h * 360 - SHADOW_HUE_DEG + 540) % 360) - 180;
      delta = THREE.MathUtils.clamp(delta, -SHADOW_HUE_WINDOW_DEG, SHADOW_HUE_WINDOW_DEG);
      h = (((SHADOW_HUE_DEG + delta) / 360) % 1 + 1) % 1;
    }
    if (h === this._hsl.h && s === this._hsl.s) return c;
    return c.setHSL(h, s, this._hsl.l, THREE.SRGBColorSpace);
  }

  /** Push `_current` into the actual lights and the shared uniform block. */
  _applyState() {
    const S = this._current;

    // The cascade lights are the key: CSM owns their transform, we own their
    // radiometry. Direction is the vector light *travels*, hence the negation.
    if (this.csm) {
      this.csm.lightDirection.copy(S.keyDir).negate().normalize();
      this.csm.lightIntensity = S.keyIntensity;
      for (const l of this.csm.lights) {
        l.color.copy(S.keyColor);
        l.intensity = S.keyIntensity;
      }
    }

    this.fill.color.copy(S.fillSky);
    this.fill.groundColor.copy(S.fillGround);
    this.fill.intensity = S.fillIntensity;

    // Directional lights in three are aimed from `position` toward `target`;
    // parking the rim at a fixed radius keeps it well outside any scene and
    // makes its world direction exactly `rimDir`.
    this.rim.position.copy(S.rimDir).multiplyScalar(60);
    this.rim.target.position.set(0, 0, 0);
    this.rim.target.updateMatrixWorld();
    this.rim.color.copy(S.rimColor);
    this.rim.intensity = S.rimIntensity;

    const u = this.uniforms;
    u.uKeyDirection.value.copy(S.keyDir);
    u.uKeyColor.value.copy(S.keyColor).multiplyScalar(S.keyIntensity);
    u.uRimDirection.value.copy(S.rimDir);
    u.uRimColor.value.copy(S.rimColor).multiplyScalar(S.rimIntensity);
    u.uFillSky.value.copy(S.fillSky).multiplyScalar(S.fillIntensity);
    u.uFillGround.value.copy(S.fillGround).multiplyScalar(S.fillIntensity);

    // ART_BIBLE section 3 pins exposure to the time of day. Sky writes the same
    // value un-eased; services tick in registration order and `lighting` is
    // registered after `sky`, so the eased value is the one that survives.
    const renderer = this.engine?.renderer;
    if (renderer) renderer.toneMappingExposure = S.exposure;
  }

  /**
   * Re-read every source and apply it immediately, with no easing.
   *
   * Used on a scene mount and on a scripted time-of-day jump, where a glide
   * would mean the capture harness screenshots a frame mid-transition.
   */
  sync() {
    this._sampleTarget();
    const S = this._current;
    const T = this._target;
    S.keyDir.copy(T.keyDir);
    S.keyColor.copy(T.keyColor);
    S.keyIntensity = T.keyIntensity;
    S.fillSky.copy(T.fillSky);
    S.fillGround.copy(T.fillGround);
    S.fillIntensity = T.fillIntensity;
    S.rimDir.copy(T.rimDir);
    S.rimColor.copy(T.rimColor);
    S.rimIntensity = T.rimIntensity;
    S.exposure = T.exposure;
    this._applyState();
    this._fitCascades(true);
    return this;
  }

  /* ------------------------------------------------------------------ tick */

  /**
   * @param {number} dt seconds, already scaled by `engine.timeScale`.
   *
   * Guarded against double-integration: scenes call this directly *and* the
   * engine ticks it as a registered service, so without the frame stamp the
   * easing would run twice per frame and the light pool envelopes would decay
   * at double speed.
   */
  update(dt) {
    const frame = this.engine?.frame ?? -1;
    if (frame >= 0 && frame === this._lastFrame) return;
    this._lastFrame = frame;

    this._sampleTarget();

    const S = this._current;
    const T = this._target;
    const kc = approach(dt, TAU_COLOR);
    const kd = approach(dt, TAU_DIRECTION);
    const ke = approach(dt, TAU_EXPOSURE);

    slerpDir(S.keyDir, T.keyDir, kd, this._vecB);
    S.keyDir.copy(this._vecB);
    slerpDir(S.rimDir, T.rimDir, kd, this._vecB);
    S.rimDir.copy(this._vecB);

    S.keyColor.lerp(T.keyColor, kc);
    S.fillSky.lerp(T.fillSky, kc);
    S.fillGround.lerp(T.fillGround, kc);
    S.rimColor.lerp(T.rimColor, kc);
    S.keyIntensity += (T.keyIntensity - S.keyIntensity) * kc;
    S.fillIntensity += (T.fillIntensity - S.fillIntensity) * kc;
    S.rimIntensity += (T.rimIntensity - S.rimIntensity) * kc;
    S.exposure += (T.exposure - S.exposure) * ke;

    this._applyState();
    this._fitCascades(false);
    this._updatePool(dt);

    this._scanTimer -= dt;
    if (this._scanTimer <= 0) {
      this._scanTimer = MATERIAL_SCAN_INTERVAL;
      this.refreshMaterials();
    }
  }

  /**
   * Refit the cascades to this frame's camera.
   *
   * Two things must be true before `csm.update()` can be trusted. First, the
   * camera's world matrix has to be current: scenes move the camera in their
   * own `update`, but three only refreshes `matrixWorld` inside `render()`,
   * which happens *after* services tick — without this the cascades would trail
   * the camera by one frame and pop shadows in during a fast pan. Second, a
   * lens or camera change invalidates the split distances entirely, so the
   * frustum is re-derived whenever the projection actually changed rather than
   * every frame (`updateFrustums` re-solves bounds for every cascade).
   */
  _fitCascades(force) {
    const csm = this.csm;
    if (!csm) return;
    const cam = this._activeCamera();
    if (!cam) return;

    const key = `${cam.uuid}|${cam.fov}|${cam.aspect}|${cam.near}|${cam.far}|${cam.zoom}`;
    if (force || key !== this._lensKey || csm.camera !== cam) {
      this._lensKey = key;
      csm.camera = cam;
      csm.maxFar = this.shadowDistance;
      csm.updateFrustums();
      this._applyCascadeBias();
    }

    cam.updateMatrixWorld();
    csm.update();
  }

  /* ------------------------------------------------------------ light pool */

  /**
   * Take a dynamic point light.
   *
   * Never returns null — a saturated pool evicts its lowest-priority, oldest
   * light instead, because a spell with no glow is a far more visible failure
   * than a torch that dimmed for a second. Callers may hold the handle for as
   * long as they like; a stale `release()` after eviction is a no-op.
   *
   * @param {object} o
   * @param {THREE.ColorRepresentation} [o.color]
   * @param {number} [o.intensity]  peak intensity
   * @param {number} [o.distance]   attenuation radius in metres
   * @param {number} [o.decay]      2 is physically correct
   * @param {THREE.Vector3} [o.position]
   * @param {number} [o.attack]     seconds to reach peak
   * @param {number} [o.hold]       seconds at peak; omit for a persistent light
   * @param {number} [o.release]    seconds to fade after `hold` or `release()`
   * @param {number} [o.flicker]    0..1 practical-fire modulation depth
   * @param {number} [o.priority]   higher survives eviction
   * @param {boolean} [o.shadow]    request the shadow-capable slot
   * @returns {LightHandle}
   */
  acquire(o = {}) {
    const slot = this._pickSlot(o.priority ?? 0, o.shadow === true);

    slot.serial++;
    slot.active = true;
    slot.age = 0;
    slot.t = 0;
    slot.priority = o.priority ?? 0;
    slot.attack = Math.max(0, o.attack ?? 0.06);
    slot.hold = o.hold === undefined ? Infinity : Math.max(0, o.hold);
    slot.release = Math.max(1e-3, o.release ?? 0.35);
    slot.peak = Math.max(0, o.intensity ?? 1.5);
    slot.flicker = THREE.MathUtils.clamp(o.flicker ?? 0, 0, 1);
    slot.env = 0;
    slot.releaseFrom = 1;
    // Seeded, never Math.random: a torch's flicker is on screen, so it has to
    // reproduce byte-for-byte between capture runs (ARCHITECTURE rule 7).
    slot.phase = rng.range(0, Math.PI * 2);

    const light = slot.light;
    // Default to the bible's practical tint — the one warm source it allows on
    // a night frame — so an un-coloured acquire is still on-palette.
    light.color.set(o.color ?? SURFACE_TINT.PRACTICAL);
    light.distance = o.distance ?? 12;
    light.decay = o.decay ?? 2;
    light.intensity = 0;
    if (o.position) light.position.copy(o.position);

    // The cube render is unfrozen only while a caller actually wants shadows,
    // so an idle or borrowed casting slot costs nothing.
    if (slot.canCastShadow) slot.light.shadow.autoUpdate = o.shadow === true;

    return new LightHandle(this, slot);
  }

  /**
   * Choose a slot. Free slots first, and the shadow-capable one is held back
   * unless it was asked for — otherwise the first spell of a battle takes the
   * only casting slot and the torch that needed it gets a flat light.
   *
   * With nothing free, evict. Preference goes to a victim the request actually
   * outranks; if every active light outranks it we still take the weakest,
   * because `acquire` returning nothing would mean a spell renders unlit and
   * that is the more visible failure.
   */
  _pickSlot(priority, wantsShadow) {
    if (wantsShadow) {
      for (const s of this._slots) if (!s.active && s.canCastShadow) return s;
    }
    for (const s of this._slots) if (!s.active && !s.canCastShadow) return s;
    for (const s of this._slots) if (!s.active) return s;

    let victim = null;
    let fallback = this._slots[0];
    for (const s of this._slots) {
      if (s.priority < fallback.priority
        || (s.priority === fallback.priority && s.age > fallback.age)) fallback = s;
      if (s.priority > priority) continue;
      if (!victim || s.priority < victim.priority
        || (s.priority === victim.priority && s.age > victim.age)) victim = s;
    }
    const chosen = victim ?? fallback;
    this._retire(chosen);
    return chosen;
  }

  _beginRelease(slot) {
    const cut = Math.max(0, slot.t - slot.attack);
    slot.hold = slot.hold === Infinity ? cut : Math.min(slot.hold, cut);
    slot.releaseFrom = slot.env;
  }

  _retire(slot) {
    slot.active = false;
    // Bumping the serial invalidates any handle still pointing here, so a late
    // `release()` from the previous owner cannot cut the new light short.
    slot.serial++;
    slot.light.intensity = 0;
    if (slot.canCastShadow) slot.light.shadow.autoUpdate = false;
  }

  /** Advance every active envelope. Runs once per frame, after the rig eases. */
  _updatePool(dt) {
    for (const slot of this._slots) {
      // Bake the shadow map for the casting slot on the first frames only; from
      // then on it is frozen until something acquires the slot, which keeps six
      // cube faces out of the frame budget while the light is idle.
      if (slot.canCastShadow && slot._warmFrames > 0) {
        slot._warmFrames--;
        if (slot._warmFrames === 0 && !slot.active) slot.light.shadow.autoUpdate = false;
      }
      if (!slot.active) continue;

      slot.t += dt;
      slot.age += dt;

      let env;
      if (slot.t < slot.attack) {
        const x = slot.t / slot.attack;
        env = x * x * (3 - 2 * x);
      } else if (slot.t < slot.attack + slot.hold) {
        env = 1;
      } else {
        const x = (slot.t - slot.attack - slot.hold) / slot.release;
        if (x >= 1) {
          this._retire(slot);
          continue;
        }
        env = slot.releaseFrom * (1 - x * x * (3 - 2 * x));
      }
      slot.env = env;

      if (slot.flicker > 0) {
        // Two incommensurate rates: a single sine reads as a pulsing bulb, and
        // real flame carries a slow buffet under a fast shimmer.
        const t = slot.t + slot.phase;
        const slow = 0.5 - 0.5 * Math.sin(t * 6.7);
        const fast = 0.5 - 0.5 * Math.sin(t * 19.3 + slot.phase * 2.13);
        env *= 1 - slot.flicker * (0.62 * slow + 0.38 * fast);
      }

      slot.light.intensity = slot.peak * env;
    }
  }

  /* --------------------------------------------------------------- teardown */

  _teardown() {
    if (this.csm) {
      for (const l of this.csm.lights) l.shadow?.map?.dispose();
      this.csm.remove();
      this.csm = null;
    }
    for (const slot of this._slots) slot.dispose();
    this._slots.length = 0;
  }

  dispose() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    // Unpatch before teardown: AssetForge caches materials across scene swaps,
    // so a chained hook still pointing at a destroyed CSM would follow them
    // into the next scene and throw on the first compile there.
    this._detachAll();
    this._teardown();
    this.group.parent?.remove(this.group);
    this.rim.dispose?.();
    this.fill.dispose?.();
    this.scene = null;
    this.sky = null;
  }
}
