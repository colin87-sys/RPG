/**
 * TitleScene — the first thing anyone sees. STUB.
 */
import * as THREE from 'three';
import { Scene } from '../core/Engine.js';

export class TitleScene extends Scene {
  async mount() {
    this.camera = this.engine.camera;
    this.scene.background = new THREE.Color(0x0a1420);
    this.scene.add(new THREE.HemisphereLight(0x88aacc, 0x221a14, 1.2));
    const key = new THREE.DirectionalLight(0xffddaa, 2.0);
    key.position.set(4, 8, 5);
    this.scene.add(key);
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.4, 2),
      new THREE.MeshStandardMaterial({ color: 0x3ec8d8, roughness: 0.25, metalness: 0.6 }),
    );
    mesh.position.y = 1.6;
    this.scene.add(mesh);
    this.mesh = mesh;
  }
  update(dt) {
    this.mesh.rotation.y += dt * 0.4;
  }
  poseCamera() {}
}
