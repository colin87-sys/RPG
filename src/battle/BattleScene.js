/**
 * BattleScene — the ATB arena. STUB.
 */
import * as THREE from 'three';
import { Scene } from '../core/Engine.js';

export class BattleScene extends Scene {
  constructor(engine, opts = {}) {
    super(engine);
    this.encounterId = opts.encounterId ?? 'shorewatch-ambush';
  }
  async mount() {
    this.camera = this.engine.camera;
    this.camera.position.set(0, 4.5, 11);
    this.camera.lookAt(0, 1.4, 0);
    this.scene.background = new THREE.Color(0x1a1226);
    this.scene.add(new THREE.HemisphereLight(0x8f7fd0, 0x2a1a20, 1.0));
    const key = new THREE.DirectionalLight(0xffc890, 2.6);
    key.position.set(-6, 10, 8);
    this.scene.add(key);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(18, 64),
      new THREE.MeshStandardMaterial({ color: 0x2b2436, roughness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
  }
  poseCamera() {}
  async debugCast() {}
  async debugSummon() {}
}
