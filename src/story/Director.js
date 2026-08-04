/**
 * Director — dialogue runtime, cutscene choreography, quest state machine.
 * STUB: resolves immediately for every request.
 */
export class Director {
  constructor(engine) {
    this.engine = engine;
    this.active = null;
  }
  async playScript() {}
  async playCutscene() {}
  questStatus() {
    return 'inactive';
  }
  update() {}
  dispose() {}
}
