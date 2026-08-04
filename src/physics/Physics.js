/**
 * Physics — character controller, collision queries, projectile integration.
 * STUB: flat-ground controller with no collision.
 */
import * as THREE from 'three';

export class Physics {
  constructor(engine) {
    this.engine = engine;
    this.gravity = -22;
    this.bodies = [];
  }
  setGroundProvider(fn) {
    this._ground = fn;
  }
  groundHeight(x, z) {
    return this._ground ? this._ground(x, z) : 0;
  }
  addCharacter(root, opts = {}) {
    const body = {
      root,
      velocity: new THREE.Vector3(),
      radius: opts.radius ?? 0.35,
      height: opts.height ?? 1.75,
      grounded: true,
    };
    this.bodies.push(body);
    return body;
  }
  remove(body) {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
  }
  fixedUpdate(dt) {
    for (const b of this.bodies) {
      b.velocity.y += this.gravity * dt;
      b.root.position.addScaledVector(b.velocity, dt);
      const g = this.groundHeight(b.root.position.x, b.root.position.z);
      if (b.root.position.y <= g) {
        b.root.position.y = g;
        b.velocity.y = 0;
        b.grounded = true;
      } else {
        b.grounded = false;
      }
    }
  }
  dispose() {
    this.bodies.length = 0;
  }
}
