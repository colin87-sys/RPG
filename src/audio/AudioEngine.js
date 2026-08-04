/**
 * AudioEngine — Web Audio graph, adaptive score, procedural SFX.
 * STUB: silent, but honours the full call surface.
 */
export class AudioEngine {
  constructor() {
    this.ready = false;
    this.music = {
      play: () => {},
      setIntensity: () => {},
      stop: () => {},
    };
    this.sfx = { play: () => {} };
  }
  async resume() {
    this.ready = true;
  }
  setBusVolume() {}
  update() {}
  dispose() {}
}
