/**
 * PostFX — the full screen-space chain.
 * STUB: leaves engine.composer null so the engine falls back to direct render.
 */
export class PostFX {
  constructor(engine) {
    this.engine = engine;
    this.quality = 'high';
  }
  setQuality(level) {
    this.quality = level;
  }
  setGrade() {}
  shake() {}
  flash() {}
  setDof() {}
  setRadialBlur() {}
  setSize() {}
  render() {}
  update() {}
  dispose() {}
}
