/**
 * LookdevScene — the calibration stage *and* the cast stage.
 *
 * Two jobs in one scene, deliberately, because they have to agree:
 *
 *  1. **Calibration bay** (off at -X, out of every cast framing): the
 *     roughness/metalness sphere grid, the named-material bar and the chibi
 *     scale proxy. If the game looks wrong, this tells you which layer is
 *     lying — sky, probe, lighting rig, texture pipeline or post chain.
 *  2. **Battle stage** (centre, +X): the six roster characters staged exactly
 *     as REFERENCE_TARGET.md §2 describes a battle frame — a loose staggered
 *     diagonal on the right of frame, facing left, standing on visible ground
 *     with contact shadows, idling. This is the frame the art-direction
 *     critics judge, so it is composed to ART_BIBLE §5 rather than merely
 *     populated: three depth layers, a foreground occluder, thirds placement
 *     and visible atmospheric separation.
 *
 * The two never share a framing. Every cast pose is aimed down the +Z axis
 * with zero yaw so screen-right is world +X, which makes the staggered
 * diagonal solvable on paper instead of by nudging.
 *
 * OWNED BY: integration. Foundation modules are validated here before they
 * are wired into FieldScene or BattleScene.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Scene } from '../core/Engine.js';
import { gameState, Rng } from '../core/GameState.js';
import { Sky } from '../render/Sky.js';
import { Lighting } from '../render/Lighting.js';
import { buildCharacter } from '../characters/CharacterFactory.js';
import { LIGHT, HERO_TIME_OF_DAY } from '../art/Palette.js';
import { makeNoise } from '../art/noise.js';

/**
 * Stage frame. The battle camera looks down -Z with no yaw, so `s` below is
 * literally screen-right in metres and `d` is depth from the camera plane —
 * which is how the staggered diagonal was solved (see `PARTY`).
 */
const STAGE = {
  camX: 1.75,   // camera x; the party sits to the right of it, enemies to the left
  camZ: 8.55,   // camera z; the party occupies z ≈ 0.7 … 3.6
  camY: 2.32,   // gives a 14° downward pitch onto a 0.72 m aim height at 6.4 m
  aimY: 0.72,   // chest height on a 1.1 m chibi
  fov: 48,      // REFERENCE §2: "wide, roughly 45–55°"
};

/** Calibration bay origin — far enough out that no cast pose can see it. */
const BAY = { x: -10, z: -1 };

/**
 * Multiplier on the ART_BIBLE §3 fog density, via the hook Sky publishes.
 *
 * The bible's densities (0.0018 noon … 0.0055 dusk) are authored for a world
 * where the subject is 1.75 m tall. Ours is 1.1 m, and every distance in the
 * staging shrinks with it — at 0.0055 the fog has removed 2% of contrast by
 * 25 m, where §5.5 requires layers to be *visibly* separating. Scaling the
 * density is exactly what `fogDensityScale` exists for, and it is the single
 * biggest contributor to REFERENCE §3's "heavy atmospheric perspective is the
 * signature": at 5× the treeline reads as the near-silhouette the reference
 * frames show instead of a fully-lit forest.
 */
const FOG_SCALE = 5.0;

/**
 * The staggered diagonal, solved in screen space and converted back to world.
 *
 * `ndc` is the intended horizontal position in the lineup frame (0 = centre,
 * 1 = right edge) and `depth` the distance from the camera plane. Depth
 * zig-zags while `ndc` climbs monotonically, which is what turns a straight
 * rank into the loose diagonal the reference uses: no two characters share a
 * screen column, and the rear ranks read *higher* in frame because the camera
 * looks down. Order is front-line first, exactly like `gameState.party`.
 */
const PARTY = [
  { id: 'auren',  ndc: 0.10, depth: 5.0, yaw: 0.30 },
  { id: 'kite',   ndc: 0.24, depth: 6.4, yaw: 0.44 },
  { id: 'yshara', ndc: 0.38, depth: 5.4, yaw: 0.22 },
  { id: 'bramm',  ndc: 0.52, depth: 7.2, yaw: 0.38 },
  { id: 'seren',  ndc: 0.66, depth: 6.0, yaw: 0.16 },
  { id: 'emrys',  ndc: 0.80, depth: 7.8, yaw: 0.34 },
];

/** Half-width of the lineup frustum per metre of depth, at STAGE.fov / 16:9. */
const TAN_HALF_H = Math.tan((STAGE.fov * Math.PI) / 360) * (16 / 9);

/** World position for a party slot. Facing is -X plus a turn toward camera. */
function partyPlacement(slot) {
  return {
    x: STAGE.camX + slot.ndc * TAN_HALF_H * slot.depth,
    z: STAGE.camZ - slot.depth,
    yaw: -Math.PI / 2 + slot.yaw,
  };
}

/**
 * A camera pose is a composition (ART_BIBLE §5), so each entry carries its
 * focal plane and its grade as well as its coordinates. `silhouette` flips the
 * stage into the flattened-value check the same section mandates.
 */
const CAMERA_POSES = {
  /** REFERENCE §2's fixed side-view battle framing. */
  lineup: {
    pos: [STAGE.camX, STAGE.camY, STAGE.camZ],
    look: [STAGE.camX, STAGE.aimY, STAGE.camZ - 6.4],
    fov: STAGE.fov, focus: 6.2, aperture: 4.0, grade: 'battle',
  },
  /** Same lens, same station point, values flattened. */
  silhouette: {
    pos: [STAGE.camX, STAGE.camY, STAGE.camZ],
    look: [STAGE.camX, STAGE.aimY, STAGE.camZ - 6.4],
    fov: STAGE.fov, focus: 6.2, aperture: 22, grade: 'neutral', silhouette: true,
  },
  /** Auren, three-quarter front, slightly low so he reads heroic. */
  'hero-closeup': {
    pos: [0.96, 0.88, 4.62], look: [2.15, 0.98, 3.55],
    fov: 34, focus: 1.6, aperture: 4.0, grade: 'memory',
  },
  /** Pulled-back version of the battle axis: whole stage, party still right. */
  wide: {
    pos: [STAGE.camX, 3.30, 15.5], look: [STAGE.camX, 0.90, 6.0],
    fov: 50, focus: 12.5, aperture: 5.6, grade: 'dusk',
  },
  /** Sky-dominant landscape for the day-cycle sweep; party on the right third. */
  horizon: {
    pos: [-0.4, 2.0, 12.6], look: [6.55, 8.34, -26.8],
    fov: 52, focus: 12, aperture: 8, grade: 'dusk',
  },
  'sphere-grid': {
    pos: [BAY.x, 2.1, BAY.z + 7.2], look: [BAY.x, 2.0, BAY.z],
    fov: 34, focus: 7.2, aperture: 5.6, grade: 'neutral',
  },
  materials: {
    pos: [BAY.x - 4.3, 1.6, BAY.z + 10.2], look: [BAY.x - 4.0, 0.9, BAY.z + 5.2],
    fov: 40, focus: 5.2, aperture: 4.0, grade: 'neutral',
  },
};

/** Ambient fill left burning in silhouette mode: enough to see form, not value. */
const SILHOUETTE_FILL = 0.04;

export class LookdevScene extends Scene {
  constructor(engine) {
    super(engine);
    /** Isolated stream: the shared `rng` is consumed by combat and VFX too, and
     *  the stage dressing must be byte-identical between captures regardless. */
    this.rng = new Rng(0x10057ade);
    this.noise = makeNoise(0x10057ade);
    /** @type {Array<ReturnType<typeof buildCharacter>>} */
    this.cast = [];
    this.focusDistance = 8;
    this._silhouette = false;
    this._pose = 'wide';
  }

  async mount() {
    const engine = this.engine;
    const forge = engine.get('art');

    this.camera = new THREE.PerspectiveCamera(STAGE.fov, engine.camera.aspect, 0.08, 4000);

    // ART_BIBLE §3: dusk is the hero key and t = 0.72 is the game's default
    // field time. A calibration stage lit at an arbitrary hour calibrates
    // nothing, so the scene owns the clock on entry and publishes it back so
    // the debug hook and any later scene agree with what is on screen.
    gameState.state.timeOfDay = HERO_TIME_OF_DAY;

    this.sky = this.track(new Sky(engine));
    this.sky.fogDensityScale = FOG_SCALE;
    this.sky.addTo(this.scene);
    this.sky.setTimeOfDay(HERO_TIME_OF_DAY);
    engine.register('sky', this.sky);

    this.lighting = this.track(new Lighting(engine, this.sky));
    this.lighting.addTo(this.scene);
    engine.register('lighting', this.lighting);

    // Silhouette mode has to overwrite the rig *after* it has run, and the rig
    // ticks as a service — i.e. after `Scene.update`. Registering the override
    // as a service immediately behind `lighting` is the only ordering that
    // survives without reaching into Lighting's internals.
    engine.register('lookdev-stage', { update: () => this._afterRig() });

    this._refreshEnvironment(forge);

    this._buildGround(forge);
    this._buildTreeline(forge);
    this._buildForeground(forge);
    this._buildMist(forge);
    this._buildMotes(forge);
    this._buildBacklight();

    this._buildSphereGrid(forge);
    this._buildMaterialBar(forge);
    this._buildScaleProxy(forge);

    this._buildCast(forge);

    // Every character material was created after `addTo`, so the CSM patch has
    // to be re-applied or the party sums all four cascade lights unattenuated.
    this.lighting.refreshMaterials();
    this.lighting.sync();

    engine.get('vfx')?.addTo(this.scene);
    this.poseCamera('wide');
  }

  /* --------------------------------------------------------------- probe */

  /**
   * Rebuild the specular probe from the live dome.
   *
   * Without this the sphere grid's metal row is lit only by the analytic rig,
   * which has no directional environment at all — metal renders as a dark ball
   * with one highlight, which is exactly the "metal is black" failure this
   * scene exists to catch. The forge caches on the sky's time-of-day, so
   * calling it again after a clock change is cheap when nothing moved and
   * correct when something did.
   */
  _refreshEnvironment(forge = this.engine.get('art')) {
    const env = forge?.environment?.(this.sky);
    if (!env) return;
    this._environment = env;
    if (!this._silhouette) this.scene.environment = env;
  }

  /* -------------------------------------------------------------- terrain */

  /**
   * The ground's analytic height field.
   *
   * Shared by the mesh displacement and by everything planted on it, so a prop
   * can never float or sink — sampling a displaced mesh back would mean either
   * a raycast per instance or an index lookup that silently breaks the first
   * time the tessellation changes.
   */
  _groundHeight(x, z) {
    const n = this.noise;
    const swell = n.fbm3(x * 0.0032, 0, z * 0.0032, { octaves: 4, gain: 0.55 }) * 9.0;
    const ripple = n.fbm3(x * 0.055, 11, z * 0.055, { octaves: 3, gain: 0.5 }) * 0.09;
    // The stage itself is levelled: the party must stand on flat ground or the
    // staggered diagonal stops being a diagonal and the contact decals tilt.
    const flat = 1 - Math.exp(-(((Math.hypot(x - 4, z - 1)) / 16) ** 2));
    return swell * flat + ripple * Math.max(0.15, flat);
  }

  /**
   * Ground: 1.6 km of gently rolling dirt.
   *
   * Large enough that the plane's own edge is buried far inside the fog
   * (FogExp2 at the dusk key reaches unity around 350 m), and displaced rather
   * than flat because a mathematically level plane under a low sun produces a
   * single uniform value across the entire lower half of frame — no form, no
   * shadow information, and nothing for the atmospheric gradient to grade.
   */
  _buildGround(forge) {
    const SIZE = 900;
    const SEG = 128;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this._groundHeight(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();
    this.track(geo);

    // Repeat is solved from texel density, not taste: 900 m / 400 puts one
    // tile every 2.25 m, which at the chibi scale is roughly one tile per two
    // body heights — fine enough that the near ground carries detail, coarse
    // enough that the tiling period never lands inside a single frame.
    this.groundMaterial = forge.material('grass', { repeat: 400 });
    const ground = new THREE.Mesh(geo, this.groundMaterial);
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.ground = ground;
    this.scene.add(ground);

    // The silhouette check needs the backdrop to hold value while the subjects
    // lose it, so the ground swaps to an unlit mid-tone. Tinted parchment, not
    // grey — ART_BIBLE §7.2 has no exemption for diagnostic frames.
    this.groundSilhouetteMaterial = this.track(new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xc4b49a).multiplyScalar(0.62),
      fog: true,
    }));
  }

  /**
   * Distant treeline. REFERENCE §3: background elements are near-silhouettes
   * with very little internal detail, washed toward the fog colour.
   *
   * Bark, not foliage: bark's albedo band is 0.10–0.25 linear, which is already
   * the near-black the reference frames show at distance, and an opaque surface
   * costs no alpha test on ~200 instances. Instanced from one merged conifer so
   * the whole treeline is a single draw call.
   */
  _buildTreeline(forge) {
    const parts = [];
    // Total height ~5.2 m. Sized against the cast, not against a human: a
    // botanically correct 20 m conifer beside a 1.1 m chibi reads as a
    // skyscraper and destroys the scale the whole look depends on.
    const trunk = new THREE.CylinderGeometry(0.09, 0.17, 1.5, 6, 1);
    trunk.translate(0, 0.75, 0);
    parts.push(trunk);
    for (let i = 0; i < 4; i++) {
      const y = 0.85 + i * 1.0;
      const r = 1.25 - i * 0.24;
      const h = 1.75 - i * 0.20;
      const cone = new THREE.ConeGeometry(r, h, 9, 1);
      cone.translate(0, y + h * 0.5, 0);
      parts.push(cone);
    }
    const conifer = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    this.track(conifer);

    const COUNT = 260;
    const mat = forge.material('bark', { repeat: 2 });
    const trees = new THREE.InstancedMesh(conifer, mat, COUNT);
    trees.name = 'treeline';
    trees.castShadow = false;
    trees.receiveShadow = false;
    trees.frustumCulled = false;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const rng = this.rng;
    for (let i = 0; i < COUNT; i++) {
      // Log-distributed radius: an even scatter over an annulus puts almost
      // everything at the far edge, and the whole point is layered depth. The
      // inner limit is set by the fog — closer than ~22 m a tree still reads at
      // near-full contrast and starts competing with the party.
      const radius = 22 * Math.exp(rng.next() * Math.log(240 / 22));
      const angle = rng.range(-Math.PI, Math.PI);
      const tx = 4 + Math.cos(angle) * radius;
      const tz = 1 + Math.sin(angle) * radius;
      // Sunk half a metre so the trunk flare never shows a floating seam where
      // the instanced base cuts the tessellated ground.
      p.set(tx, this._groundHeight(tx, tz) - 0.5, tz);
      const scale = rng.range(0.80, 1.28) * (0.92 + radius / 900);
      s.set(scale * rng.range(0.85, 1.1), scale, scale * rng.range(0.85, 1.1));
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
      trees.setMatrixAt(i, m.compose(p, q, s));
    }
    trees.instanceMatrix.needsUpdate = true;
    this.scene.add(trees);
    this.treeline = trees;
  }

  /**
   * Foreground occluders — ART_BIBLE §5.1's "single cheapest depth win".
   *
   * Placed to fall inside the near-DOF of both the lineup and horizon poses so
   * they blur, and against the left edge where the enemy half of a battle frame
   * would otherwise be empty stage.
   */
  _buildForeground(forge) {
    const group = new THREE.Group();
    group.name = 'foreground';

    // `alphaTest: 0` deliberately: the silhouette comes from the *geometry* of
    // each blade, not from a cutout. A leaf-shaped alpha stamped on a quad this
    // close to the lens reads as a decal of a leaf, which is what the first
    // pass of this scene shipped and why it was wrong. Cloned so the tint below
    // cannot leak into anyone else's foliage — the clone shares the forge's
    // textures, and the forge guards them against `disposeTree`.
    const mat = forge.material('foliage', { alphaTest: 0 }).clone();
    // §5.1: a foreground occluder is exposed at least 1.5 stops under the
    // subject, and §3 keeps environment saturation below character saturation.
    mat.color.setHex(0x53664f);
    mat.envMapIntensity = 0.25;
    this.track(mat);

    const blade = this._makeBladeGeometry();
    const rng = this.rng;

    // Two banks, because the poses stand in two different places. The `near`
    // bank frames the bottom-left of the lineup and horizon shots; the `far`
    // bank sits behind the lineup camera entirely and only ever appears in the
    // pulled-back `wide`, where the near bank is already mid-ground.
    const clumps = [
      { x: -0.10, z: 6.15, h: 1.55, n: 150, spread: 1.05 },
      { x: -1.65, z: 6.90, h: 1.85, n: 140, spread: 1.25 },
      { x: 7.10, z: 6.05, h: 1.10, n: 80, spread: 0.80 },
      { x: 0.35, z: 13.0, h: 2.35, n: 170, spread: 1.40 },
      { x: 3.80, z: 13.5, h: 2.10, n: 130, spread: 1.20 },
    ];

    // Merged into one geometry: ~670 blades as individual meshes would be 670
    // draw calls for what is, visually, two bushes.
    const pieces = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (const c of clumps) {
      for (let i = 0; i < c.n; i++) {
        const a = rng.range(0, Math.PI * 2);
        // sqrt of a uniform gives a uniform *areal* density; without it every
        // clump piles up at its own centre and reads as a spike.
        const r = c.spread * Math.sqrt(rng.next());
        const bx = c.x + Math.cos(a) * r;
        const bz = c.z + Math.sin(a) * r;
        const h = c.h * rng.range(0.45, 1.2);
        p.set(bx, this._groundHeight(bx, bz) - 0.04, bz);
        e.set(rng.jitter(0.16), rng.range(0, Math.PI * 2), rng.jitter(0.22));
        q.setFromEuler(e);
        s.set(h * rng.range(0.6, 1.0), h, h);
        pieces.push(blade.clone().applyMatrix4(m.compose(p, q, s)));
      }
    }
    const merged = mergeGeometries(pieces, false);
    for (const g of pieces) g.dispose();
    blade.dispose();
    this.track(merged);

    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = 'foreground-grass';
    mesh.frustumCulled = false;
    group.add(mesh);
    this.scene.add(group);
    this.foreground = group;
  }

  /**
   * One unit-height grass blade: a tapered strip that curls away from vertical.
   *
   * Built rather than imported as a quad because the blade *is* the silhouette
   * — REFERENCE §3's background/foreground elements are read as shapes, and a
   * fan of thirty of these gives a clump an organic edge that no amount of
   * texturing on a rectangle can. UVs run several times along the blade so the
   * foliage albedo lands as leaf-scale detail rather than one stretched leaf.
   */
  _makeBladeGeometry() {
    const SEG = 6;
    const pos = [];
    const nrm = [];
    const uv = [];
    const idx = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      // Quadratic droop: a blade is stiff at the base and falls away at the
      // tip, which is what stops a clump reading as a hedgehog of spikes.
      const lean = t * t * 0.42;
      const halfWidth = 0.09 * (1 - t) ** 0.75;
      const y = t * (1 - lean * 0.35);
      const z = lean;
      pos.push(-halfWidth, y, z, halfWidth, y, z);
      nrm.push(0, 0.35, 1, 0, 0.35, 1);
      uv.push(0, t * 3.2, 1, t * 3.2);
      if (i < SEG) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Ground mist. REFERENCE §3 calls volumetric mist the signature of the look —
   * present in nearly every frame, pooling low and catching light.
   *
   * Additive rather than alpha-blended: additive is order-independent, so a
   * dozen overlapping cards need no sorting and cannot pop as the camera moves,
   * and mist that *adds* light is exactly what a backlit bank does. The tint is
   * the sky's own near-fog colour so the bank always agrees with the fog the
   * scene is already rendering.
   */
  _buildMist(forge) {
    const tex = forge.texture('smoke');
    const mat = this.track(new THREE.MeshBasicMaterial({
      map: tex,
      // FOG_NEAR at a fraction of unity: additive cards stack, so the per-card
      // radiance has to sit well under the value the bank is meant to reach or
      // six overlaps blow past the bloom threshold and the mist starts glowing.
      color: new THREE.Color(LIGHT.FOG_NEAR).multiplyScalar(0.16),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: true,
      fog: false,
    }));
    this.mistMaterial = mat;

    const geo = new THREE.PlaneGeometry(1, 1);
    this.track(geo);
    const group = new THREE.Group();
    group.name = 'mist';
    const rng = this.rng;
    this._mistCards = [];
    // Two populations. The low bank pools at ankle height across the whole
    // stage — REFERENCE §3's mist "pooling low to the ground". The tall bank
    // sits behind the party and in front of the treeline, which is what gives
    // the cast a bright field to silhouette against instead of tree trunks.
    for (let i = 0; i < 46; i++) {
      const tall = i >= 30;
      const card = new THREE.Mesh(geo, mat);
      const w = tall ? rng.range(16, 34) : rng.range(6, 17);
      card.scale.set(w, w * (tall ? rng.range(0.28, 0.45) : rng.range(0.18, 0.30)), 1);
      card.position.set(
        rng.range(-24, 26),
        tall ? rng.range(1.4, 3.4) : rng.range(0.18, 0.85),
        tall ? rng.range(-26, -6) : rng.range(-16, 11),
      );
      card.renderOrder = 6;
      group.add(card);
      this._mistCards.push({ mesh: card, drift: rng.range(0.05, 0.16), phase: rng.range(0, 6.28) });
    }
    this.scene.add(group);
    this.mist = group;
  }

  /**
   * Glasspetal drift — WORLD_BIBLE §1's spent magic, and REFERENCE §5's
   * "persistent ambient particles drift even outside of combat".
   *
   * One `Points` cloud, animated on the CPU because 900 sprites is far below
   * the point where a GPU simulation pays for its own upload.
   */
  _buildMotes(forge) {
    const COUNT = 900;
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    const rng = this.rng;
    this._moteSeed = new Float32Array(COUNT * 3);
    const teal = new THREE.Color(LIGHT.RING_GLOW);
    const amber = new THREE.Color(0xffc24d);
    const c = new THREE.Color();
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = rng.range(-24, 26);
      pos[i * 3 + 1] = rng.range(0.05, 7.5);
      pos[i * 3 + 2] = rng.range(-26, 14);
      // §2.2's rule of one jewel: petals are teal-dominant with an amber
      // minority, so the drift never becomes a second competing accent.
      c.copy(teal).lerp(amber, Math.pow(rng.next(), 3)).multiplyScalar(rng.range(0.35, 0.9));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      this._moteSeed[i * 3] = rng.range(0, 6.28);
      this._moteSeed[i * 3 + 1] = rng.range(0.05, 0.20);   // fall rate
      this._moteSeed[i * 3 + 2] = rng.range(0.25, 0.8);    // sway amplitude
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.track(geo);
    const mat = this.track(new THREE.PointsMaterial({
      map: forge.texture('mote'),
      size: 0.09,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    }));
    const points = new THREE.Points(geo, mat);
    points.name = 'glasspetals';
    points.frustumCulled = false;
    points.renderOrder = 7;
    this.scene.add(points);
    this.motes = points;
  }

  /**
   * The silhouette pass's only light: a hard back-key from beyond the party,
   * raking toward camera. Off in every other pose.
   */
  _buildBacklight() {
    const light = new THREE.DirectionalLight(0xdfe8ff, 3.4);
    light.position.set(6.5, 5.0, -22);
    light.target.position.set(4.0, 0.6, 1.0);
    light.castShadow = false;
    light.visible = false;
    this.scene.add(light, light.target);
    this.backLight = light;
  }

  /* ------------------------------------------------------------------ cast */

  /**
   * Build the six roster characters and stage them.
   *
   * `lighting` is passed so `ToonMaterial` aliases the rig's key/rim uniform
   * objects — that is what makes the whole party re-key on a time-of-day change
   * without a per-frame call — and `forge` so the toon ramp and detail normals
   * come from the shared library instead of the shader's internal fallback.
   */
  _buildCast(forge) {
    const shadowGeo = new THREE.PlaneGeometry(1, 1);
    shadowGeo.rotateX(-Math.PI / 2);
    this.track(shadowGeo);
    // Contact shadow blobs. The cascades give the cast a real cast shadow, but
    // at the dusk key the sun is low enough that the shadow lands metres away
    // and nothing anchors the feet. A tinted radial decal under each character
    // is the cheap, art-directable grounding the reference frames show.
    const shadowMat = this.track(new THREE.MeshBasicMaterial({
      alphaMap: forge.texture('glow'),
      color: new THREE.Color(LIGHT.SHADOW_TINT).multiplyScalar(0.28),
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      fog: true,
      toneMapped: true,
    }));
    this.contactShadowMaterial = shadowMat;

    const group = new THREE.Group();
    group.name = 'cast';
    for (const slot of PARTY) {
      const place = partyPlacement(slot);
      const character = buildCharacter(slot.id, forge, { lighting: this.lighting, outline: true });
      character.root.position.set(place.x, 0, place.z);
      character.root.rotation.y = place.yaw;
      // Idle is already playing from the factory; restate it so the clip is
      // explicit at the call site and a future pose change is one edit.
      character.animator.play('idle', { fade: 0 });
      // The whole party looks slightly toward the enemy half of the stage,
      // which is what stops six idle chibi from staring at nothing.
      character.animator.lookAt?.(new THREE.Vector3(-9, 1.1, place.z * 0.35 - 1.0));
      group.add(character.root);

      const blob = new THREE.Mesh(shadowGeo, shadowMat);
      const r = character.height * 1.35;
      blob.scale.set(r, 1, r * 0.86);
      blob.position.set(place.x, 0.012, place.z);
      blob.renderOrder = 2;
      group.add(blob);

      this.cast.push(character);
    }
    this.scene.add(group);
    this.castGroup = group;
    this.hero = this.cast[0];
  }

  /* ------------------------------------------------------- calibration bay */

  /** 7x3 roughness/metalness grid — the standard PBR sanity check. */
  _buildSphereGrid(forge) {
    const group = new THREE.Group();
    group.name = 'sphere-grid';
    const geo = new THREE.SphereGeometry(0.36, 48, 32);
    this.track(geo);
    // Not a bare colour: ART_BIBLE §7.1 forbids an unmapped Standard material
    // anywhere in a build, and a probe sphere with no normal detail cannot show
    // whether the normal pipeline is even connected.
    const detail = forge.texture('marble/normal', { repeat: 2 });
    for (let m = 0; m < 3; m++) {
      for (let r = 0; r < 7; r++) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0xbfc6cc,
          roughness: r / 6,
          metalness: m / 2,
          normalMap: detail,
          normalScale: new THREE.Vector2(0.18, 0.18),
          envMapIntensity: 1,
        });
        this.track(mat);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(BAY.x + (r - 3) * 0.9, 1.35 + m * 0.85, BAY.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
    }
    this.scene.add(group);
  }

  /** A row of the named library materials, so texture work is legible. */
  _buildMaterialBar(forge) {
    const keys = ['stone', 'marble', 'wood', 'bark', 'cloth', 'leather', 'steel', 'gold', 'crystal'];
    const geo = new THREE.BoxGeometry(0.72, 0.72, 0.72);
    this.track(geo);
    const group = new THREE.Group();
    group.name = 'material-bar';
    keys.forEach((key, i) => {
      const mesh = new THREE.Mesh(geo, forge.material(key));
      mesh.position.set(BAY.x - 4.0, 0.42, BAY.z + 5.2 - i * 0.95);
      mesh.rotation.y = 0.4;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    });
    this.scene.add(group);
  }

  /**
   * Chibi scale proxy — 3.25 heads tall, matching REFERENCE_TARGET.md.
   * Kept alongside the real cast so a factory regression that changes body
   * proportions shows up as a mismatch against a fixed reference, not as a
   * vague feeling that the party got taller.
   */
  _buildScaleProxy(forge) {
    const group = new THREE.Group();
    group.name = 'scale-proxy';
    const mat = this.track(new THREE.MeshStandardMaterial({
      color: 0x9aa4ae,
      roughness: 0.62,
      metalness: 0,
      normalMap: forge.texture('cloth/normal', { repeat: 3 }),
      normalScale: new THREE.Vector2(0.35, 0.35),
    }));
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.26, 8, 24), mat);
    body.position.y = 0.35;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.225, 32, 24), mat);
    head.position.y = 0.9;
    for (const m of [body, head]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.track(m.geometry);
      group.add(m);
    }
    group.position.set(BAY.x + 2.4, 0, BAY.z + 1.2);
    this.scene.add(group);
    this.proxy = group;
  }

  /* ---------------------------------------------------------------- poses */

  poseCamera(name) {
    const pose = CAMERA_POSES[name] ?? CAMERA_POSES.wide;
    this._pose = name in CAMERA_POSES ? name : 'wide';
    this._setSilhouette(pose.silhouette === true);

    this.camera.position.set(...pose.pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(...pose.look);
    this.camera.fov = pose.fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    // PostFX reads `scene.focusDistance` every frame; setting both it and the
    // aperture means a pose change is a lens change, which is what the bible's
    // "a pose is a composition" clause actually asks for.
    this.focusDistance = pose.focus;
    const postfx = this.engine.get('postfx');
    if (postfx) {
      postfx.setDof(pose.focus, pose.aperture);
      postfx.setGrade(pose.grade ?? 'dusk', 0);
    }
    // The rig fits its cascades to the active camera; a cut without this leaves
    // the first frame after the cut shadowed for the previous framing.
    this.lighting?.sync();
  }

  /**
   * Flatten the frame to black shapes (ART_BIBLE §5.6): kill every front light,
   * hold the backdrop at value with an unlit ground, and rake a single hard key
   * in from behind the party so the edges separate.
   */
  _setSilhouette(on) {
    if (on === this._silhouette) return;
    this._silhouette = on;

    this.scene.environment = on ? null : (this._environment ?? null);
    this.backLight.visible = on;
    this.mist.visible = !on;
    this.motes.visible = !on;
    this.ground.material = on ? this.groundSilhouetteMaterial : this.groundMaterial;
    this.ground.receiveShadow = !on;
    // Catch-lights and rune glow are unlit by design, so they survive a
    // blackout as bright specks and break the read.
    for (const c of this.cast) {
      for (const mesh of c.root.children) {
        if (mesh.material === c.materials.glow) mesh.visible = !on;
      }
      c.bones.head.traverse((o) => {
        if (o.isMesh && o.material === c.materials.glow) o.visible = !on;
      });
    }
    // `rimBoost` is the rig's own multiplier, so the toon rim goes with it and
    // no material has to be touched.
    this.lighting.rimBoost = on ? 0 : 1;
    this.lighting.sync();
  }

  /**
   * Runs as a service registered directly after `lighting`, i.e. once the rig
   * has already written this frame's state. In silhouette mode it zeroes the
   * front-lighting terms the rig just published — both the analytic lights and
   * the uniform block the toon materials read.
   */
  _afterRig() {
    if (!this._silhouette) return;
    const L = this.lighting;
    if (!L) return;
    for (const l of L.csm?.lights ?? []) l.intensity = 0;
    L.fill.intensity = SILHOUETTE_FILL;
    L.rim.intensity = 0;
    const u = L.uniforms;
    u.uKeyColor.value.setRGB(0, 0, 0);
    u.uRimColor.value.setRGB(0, 0, 0);
    u.uFillSky.value.copy(L.fill.color).multiplyScalar(SILHOUETTE_FILL);
    u.uFillGround.value.copy(L.fill.groundColor).multiplyScalar(SILHOUETTE_FILL);
  }

  setTimeOfDay(t) {
    this.sky?.setTimeOfDay(t);
    // The probe is baked from the dome, so it is stale the instant the clock
    // moves; without this the metal row keeps reflecting the previous hour.
    this._refreshEnvironment();
    this.lighting?.sync();
  }

  /* ----------------------------------------------------------------- tick */

  update(dt) {
    // Sky and Lighting tick as registered services; calling them here as well
    // would double-integrate the weather crossfade and the rig easing.

    // Under SwiftShader the first textured frames can take a quarter of a
    // second. Feeding that straight into six verlet cloth rigs means 15
    // substeps each and a visible whip; clamping keeps the pose stable and
    // costs nothing at real frame rates.
    const step = Math.min(dt, 1 / 30);
    for (const c of this.cast) c.update(step);

    const t = this.engine.elapsed;
    for (const m of this._mistCards) {
      // Slow lateral crawl only: mist that bobs vertically reads as smoke.
      m.mesh.position.x += m.drift * step;
      if (m.mesh.position.x > 30) m.mesh.position.x -= 58;
      m.mesh.quaternion.copy(this.camera.quaternion);
      m.mesh.position.y += Math.sin(t * 0.21 + m.phase) * 0.0009;
    }

    const pos = this.motes.geometry.getAttribute('position');
    const seed = this._moteSeed;
    for (let i = 0; i < pos.count; i++) {
      const phase = seed[i * 3];
      const fall = seed[i * 3 + 1];
      const sway = seed[i * 3 + 2];
      let y = pos.getY(i) - fall * step;
      if (y < 0.02) y += 7.5;
      pos.setY(i, y);
      // Petals are flat and light: they scull sideways as they fall rather
      // than dropping straight, which is the whole reason to animate them.
      pos.setX(i, pos.getX(i) + Math.sin(t * 0.55 + phase) * sway * step);
      pos.setZ(i, pos.getZ(i) + Math.cos(t * 0.41 + phase * 1.7) * sway * 0.6 * step);
    }
    pos.needsUpdate = true;
  }

  resize(w, h) {
    if (!this.camera) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async unmount() {
    for (const c of this.cast) c.dispose();
    this.cast.length = 0;
    // Services outlive the scene that registered them; leaving a disposed rig
    // in the registry would hand the next scene a dead CSM.
    for (const name of ['sky', 'lighting', 'lookdev-stage']) {
      this.engine.services.delete(name);
    }
    this.scene.environment = null;
    this._environment = null;
    await super.unmount();
  }
}
