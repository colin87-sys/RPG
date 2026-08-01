/**
 * Lighting — key/fill/rim rig, cascaded shadows, image-based lighting.
 * STUB: single directional key plus hemisphere fill.
 */
import * as THREE from 'three';

export class Lighting {
  constructor(engine, sky) {
    this.engine = engine;
    this.sky = sky;
    this.group = new THREE.Group();

    this.key = new THREE.DirectionalLight(0xffe6c0, 2.6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.camera.near = 0.5;
    this.key.shadow.camera.far = 80;
    const d = 24;
    Object.assign(this.key.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.02;
    this.group.add(this.key, this.key.target);

    this.fill = new THREE.HemisphereLight(0x9fc4e8, 0x30281f, 0.75);
    this.group.add(this.fill);
  }
  addTo(scene) {
    scene.add(this.group);
    this.sync();
  }
  sync() {
    const dir = this.sky?.sunDirection;
    if (dir) this.key.position.copy(dir).multiplyScalar(40);
    this.key.target.position.set(0, 0, 0);
    this.key.target.updateMatrixWorld();
  }
  update() {}
  dispose() {
    this.key.shadow.map?.dispose();
  }
}
