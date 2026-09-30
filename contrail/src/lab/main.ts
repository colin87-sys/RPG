/**
 * Look-Dev Lab entry. Boards live in src/lab/boards/<name>.ts and are discovered
 * automatically (import.meta.glob), so lanes add boards without touching this file.
 * Each board module: export default async function (ctx: LabContext): Promise<void>
 */
import { LabContext } from './context';
import { palette } from '../style/tokens';

const boards = import.meta.glob('./boards/*.ts');

async function boot() {
  const q = new URLSearchParams(location.search);
  const name = q.get('board');
  const container = document.getElementById('stage')!;
  if (!name) {
    // index page: list boards
    document.body.style.overflow = 'auto';
    const list = Object.keys(boards)
      .map((k) => k.replace('./boards/', '').replace('.ts', ''))
      .sort();
    container.style.position = 'static';
    container.style.padding = '24px';
    container.style.fontFamily = 'ui-monospace, Menlo, Consolas, monospace';
    container.style.color = palette.hudText;
    container.innerHTML =
      `<h1>CONTRAIL Look-Dev Lab</h1><p style="color:${palette.hudValue}">Boards render with the game's own builders. Variants: A, B, C.</p>` +
      list.map((b) => `<p>${b}: ${['A', 'B', 'C'].map((v) => `<a style="color:${palette.hudValue}" href="?board=${b}&variant=${v}">${v}</a>`).join(' ')}</p>`).join('');
    (window as any).__labReady = true;
    return;
  }
  const loader = boards[`./boards/${name}.ts`];
  if (!loader) throw new Error(`unknown board: ${name}`);
  const mod = (await loader()) as { default: (ctx: LabContext) => Promise<void> | void };
  const ctx = new LabContext(container, name, q);
  await mod.default(ctx);
}

boot().catch((e) => {
  console.error(e);
  (window as any).__labError = String(e && (e as Error).stack ? (e as Error).stack : e);
});
