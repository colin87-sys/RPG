/**
 * Look-Dev Lab board context. A board renders one frame (or a strip of frames)
 * using the game's own builders, then calls ctx.ready() so the capture tool can
 * screenshot it. URL: lab/index.html?board=<name>&variant=A&w=1920&h=1080
 */
import * as THREE from 'three';
import { palette } from '../style/tokens';
import { withAlpha } from '../style/color';
import { Rng } from '../core/rng';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cell {
  scene: THREE.Scene;
  camera: THREE.Camera;
  rect: Rect;
  /** optional clear colour for this cell (token hex) */
  clear?: string;
}

export class LabContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly overlay: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  readonly variant: string;
  readonly board: string;
  readonly q: URLSearchParams;
  readonly rng: Rng;
  readonly glCanvas: HTMLCanvasElement;
  readonly overlayCanvas: HTMLCanvasElement;

  constructor(container: HTMLElement, board: string, q: URLSearchParams) {
    this.q = q;
    this.board = board;
    this.variant = (q.get('variant') ?? 'A').toUpperCase();
    this.width = Number(q.get('w') ?? 1920);
    this.height = Number(q.get('h') ?? 1080);
    this.rng = new Rng(Number(q.get('seed') ?? 1));
    this.glCanvas = document.createElement('canvas');
    this.overlayCanvas = document.createElement('canvas');
    for (const c of [this.glCanvas, this.overlayCanvas]) {
      c.width = this.width;
      c.height = this.height;
      c.style.width = `${this.width}px`;
      c.style.height = `${this.height}px`;
      container.appendChild(c);
    }
    document.body.style.width = `${this.width}px`;
    document.body.style.height = `${this.height}px`;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.glCanvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    this.overlay = this.overlayCanvas.getContext('2d')!;
  }

  /** Uniform grid of cells inside the board area (below the title strip). */
  grid(cols: number, rows: number, margin = 12, top = 64, bottom = 12): Rect[] {
    const out: Rect[] = [];
    const W = this.width - margin * (cols + 1);
    const H = this.height - top - bottom - margin * (rows - 1);
    const cw = W / cols, ch = H / rows;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) out.push({ x: margin + c * (cw + margin), y: top + r * (ch + margin), w: cw, h: ch });
    return out;
  }

  /** Render cells with scissor viewports. Rect y is from the top (canvas coords). */
  renderCells(cells: Cell[], background: string | null = palette.spaceDeep): void {
    const r = this.renderer;
    if (background !== null) this.clearAll(background);
    r.setScissorTest(true);
    for (const cell of cells) {
      const { x, y, w, h } = cell.rect;
      const yy = this.height - y - h;
      r.setViewport(x, yy, w, h);
      r.setScissor(x, yy, w, h);
      if (cell.clear) {
        r.setClearColor(new THREE.Color(cell.clear), 1);
        r.clear(true, true, true);
      } else {
        r.clear(false, true, true);
      }
      if (cell.camera instanceof THREE.PerspectiveCamera) {
        cell.camera.aspect = w / h;
        cell.camera.updateProjectionMatrix();
      }
      r.render(cell.scene, cell.camera);
    }
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
  }

  /** Clear the whole GL canvas (call once before several renderCells(..., null)). */
  clearAll(background: string = palette.spaceDeep): void {
    const r = this.renderer;
    r.setScissorTest(false);
    r.setClearColor(new THREE.Color(background), 1);
    r.clear(true, true, true);
  }

  /** Board title strip: board name, variant, and a one-line note. */
  title(text: string, note = ''): void {
    const g = this.overlay;
    g.save();
    g.fillStyle = withAlpha(palette.spaceDeep, 0.92);
    g.fillRect(0, 0, this.width, 52);
    g.fillStyle = palette.hudText;
    g.font = 'bold 22px ui-monospace, Menlo, Consolas, monospace';
    g.textBaseline = 'middle';
    g.fillText(`${text}  [${this.board} / variant ${this.variant}]`, 16, 26);
    if (note) {
      g.fillStyle = palette.hudValue;
      g.font = '15px ui-monospace, Menlo, Consolas, monospace';
      g.textAlign = 'right';
      g.fillText(note, this.width - 16, 26);
    }
    g.restore();
  }

  /** Small label at a cell corner (x, y in canvas px from top-left). */
  label(text: string, x: number, y: number, color: string = palette.hudValue): void {
    const g = this.overlay;
    g.save();
    g.font = '14px ui-monospace, Menlo, Consolas, monospace';
    const w = g.measureText(text).width + 10;
    g.fillStyle = withAlpha(palette.spaceDeep, 0.75);
    g.fillRect(x, y, w, 20);
    g.fillStyle = color;
    g.textBaseline = 'middle';
    g.fillText(text, x + 5, y + 10);
    g.restore();
  }

  /** Expose the parameter set so tools/capture can write look/candidates/<board>_<variant>.json */
  exportParams(obj: unknown): void {
    (window as any).__labParams = obj;
  }

  /** Signal that the board is fully rendered. */
  ready(): void {
    (window as any).__labReady = true;
  }
}
