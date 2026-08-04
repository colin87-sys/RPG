/**
 * VFXSystem — pooled GPU particles and the named effect registry.
 * STUB: accepts every call and does nothing visible.
 */
export class VFXSystem {
  constructor(engine) {
    this.engine = engine;
    this._handles = 0;
  }
  addTo(scene) {
    this.scene = scene;
  }
  play(name, opts = {}) {
    return { id: ++this._handles, name, opts };
  }
  stop() {}
  update() {}
  dispose() {}
}
