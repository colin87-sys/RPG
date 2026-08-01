/**
 * Sky — atmosphere, sun/moon, clouds, time of day.
 * STUB: flat gradient. Replaced by the atmosphere pass.
 */
import * as THREE from 'three';

export class Sky {
  constructor(engine) {
    this.engine = engine;
    this.time = 0.34;
    this._sunDir = new THREE.Vector3(0.4, 0.6, 0.3).normalize();
    this._sunColor = new THREE.Color(0xffe0b0);
  }
  addTo(scene) {
    this.scene = scene;
    scene.background = new THREE.Color(0x2c5b86);
    scene.fog = new THREE.FogExp2(0x2c5b86, 0.006);
  }
  setTimeOfDay(t) {
    this.time = t;
    const elev = Math.sin((t - 0.25) * Math.PI * 2);
    this._sunDir.set(Math.cos(t * Math.PI * 2) * 0.6, Math.max(0.02, elev), 0.4).normalize();
  }
  setWeather() {}
  get sunDirection() {
    return this._sunDir;
  }
  get sunColor() {
    return this._sunColor;
  }
  update() {}
  dispose() {}
}
