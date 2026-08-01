/**
 * LookdevScene — the calibration stage.
 *
 * Not a gameplay scene. It exists so sky, lighting, materials and the post
 * chain can be judged in isolation against known references: a roughness /
 * metalness sphere grid, a neutral chart, a character-height proxy for scale
 * and shadow reading, and a ground plane that shows contact shadows and
 * atmospheric falloff.
 *
 * If the game looks wrong, this scene tells you which layer is lying.
 *
 * OWNED BY: integration. Foundation modules are validated here before they
 * are wired into FieldScene or BattleScene.
 */
import * as THREE from 'three';
import { Scene } from '../core/Engine.js';
import { gameState } from '../core/GameState.js';
import { Sky } from '../render/Sky.js';
import { Lighting } from '../render/Lighting.js';

const CAMERA_POSES = {
  wide: { pos: [9, 4.2, 13], look: [0, 1.4, 0], fov: 42 },
  'sphere-grid': { pos: [0, 2.1, 7.2], look: [0, 2.0, 0], fov: 34 },
  'hero-closeup': { pos: [1.4, 1.15, 2.2], look: [0.2, 0.75, 0], fov: 38 },
  materials: { pos: [-4.5, 1.6, 5.0], look: [-4.2, 0.9, 0], fov: 40 },
  horizon: { pos: [0, 1.7, 10], look: [0, 3.2, -60], fov: 55 },
};

export class LookdevScene extends Scene {
  async mount() {
    const engine = this.engine;
    const forge = engine.get('art');

    this.camera = new THREE.PerspectiveCamera(42, engine.camera.aspect, 0.1, 4000);

    this.sky = this.track(new Sky(engine));
    this.sky.addTo(this.scene);
    this.sky.setTimeOfDay(gameState.state.timeOfDay);
    engine.register('sky', this.sky);

    this.lighting = this.track(new Lighting(engine, this.sky));
    this.lighting.addTo(this.scene);
    engine.register('lighting', this.lighting);

    const env = forge.environment?.(this.sky);
    if (env) this.scene.environment = env;

    this._buildGround(forge);
    this._buildSphereGrid(forge);
    this._buildMaterialBar(forge);
    this._buildScaleProxy(forge);

    engine.get('vfx')?.addTo(this.scene);
    this.poseCamera('wide');
  }

  _buildGround(forge) {
    const geo = new THREE.PlaneGeometry(400, 400, 1, 1);
    const mat = forge.material('dirt', { roughness: 0.95 });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  /** 7x3 roughness/metalness grid — the standard PBR sanity check. */
  _buildSphereGrid(forge) {
    const group = new THREE.Group();
    const geo = new THREE.SphereGeometry(0.36, 48, 32);
    this.track(geo);
    for (let m = 0; m < 3; m++) {
      for (let r = 0; r < 7; r++) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0xbfc6cc,
          roughness: r / 6,
          metalness: m / 2,
          envMapIntensity: 1,
        });
        this.track(mat);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set((r - 3) * 0.9, 1.35 + m * 0.85, 0);
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
    keys.forEach((key, i) => {
      const mesh = new THREE.Mesh(geo, forge.material(key));
      mesh.position.set(-4.2, 0.42, -1.6 - i * 0.95);
      mesh.rotation.y = 0.4;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    });
    this.scene.add(group);
  }

  /**
   * Chibi scale proxy — 3.25 heads tall, matching REFERENCE_TARGET.md.
   * A realistic 1.75 m capsule would calibrate shadow softness and camera
   * framing against proportions the game does not actually use.
   */
  _buildScaleProxy(forge) {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x9aa4ae, roughness: 0.6 });
    this.track(mat);
    // Head is ~38% of a 1.15 m total height; body is a short compact mass.
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
    group.position.set(2.4, 0, 1.2);
    this.scene.add(group);
    this.proxy = group;
  }

  poseCamera(name) {
    const pose = CAMERA_POSES[name] ?? CAMERA_POSES.wide;
    this.camera.position.set(...pose.pos);
    this.camera.lookAt(...pose.look);
    this.camera.fov = pose.fov;
    this.camera.updateProjectionMatrix();
  }

  setTimeOfDay(t) {
    this.sky?.setTimeOfDay(t);
    this.lighting?.sync?.();
  }

  update(dt) {
    this.sky?.update(dt);
    this.lighting?.update?.(dt);
  }
}
