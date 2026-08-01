/**
 * UIRoot — owns #ui-root and mounts HUD panels.
 * STUB: renders a single title card.
 */
export class UIRoot {
  constructor(engine) {
    this.engine = engine;
    this.el = document.getElementById('ui-root');
    this.panel = null;
  }
  open(panel) {
    this.panel = panel;
  }
  close() {
    this.panel = null;
  }
  update() {}
  dispose() {}
}
