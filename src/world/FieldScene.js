/**
 * FieldScene — explorable world. STUB.
 */
import * as THREE from 'three';
import { Scene } from '../core/Engine.js';

export class FieldScene extends Scene {
  constructor(engine, opts = {}) {
    super(engine);
    this.zoneId = opts.zoneId ?? 'lumen-quay';
  }
  async mount() {
    this.camera = this.engine.camera;
    this.camera.position.set(0, 6, 14);
    this.camera.lookAt(0, 1, 0);
    this.scene.background = new THREE.Color(0x16324a);
    this.scene.add(new THREE.HemisphereLight(0x9fc4e8, 0x2a2018, 1.0));
    const sun = new THREE.DirectionalLight(0xffe0b0, 2.4);
    sun.position.set(10, 14, 6);
    this.scene.add(sun);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x415a3a, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);
  }
  poseCamera() {}
  setTimeOfDay() {}
}
