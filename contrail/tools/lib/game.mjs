// Drive the game through window.__game (src/debug/api.ts). The harness never reaches around it.
import { pollFor } from './browser.mjs';
import { ToolError } from './util.mjs';

/** URL for the game page. Boolean true -> '1'; null/undefined/false are omitted. */
export function gameUrl(base, q = {}) {
  const u = new URL('/', base);
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== false) u.searchParams.set(k, v === true ? '1' : String(v));
  return u.href;
}

/** Wait for __game.ready (fails fast on uncaught boot errors). */
export async function waitGame(page, { timeout = 120000 } = {}) {
  const r = await pollFor(
    page,
    () => {
      const g = window.__game;
      if (g && g.ready) return { ok: true, version: g.version };
      const errs = window.__errors || [];
      if (errs.some((e) => /^uncaught|unhandled/.test(String(e)))) return { ok: false, errors: errs.slice(0, 5) };
      return null;
    },
    null,
    { timeout, what: 'window.__game.ready' },
  ).catch(async (e) => {
    const has = await page.evaluate(() => ({ game: !!window.__game, main: !!document.querySelector('script[type=module]') })).catch(() => ({}));
    throw new ToolError(`${e.message}${has.game ? ' (__game exists but never became ready)' : ' (window.__game is not exposed: is src/main.ts wired with the debug API?)'}`);
  });
  if (!r.ok) throw new ToolError(`game boot failed: ${r.errors.join(' | ')}`);
  return r;
}

/** Missing API methods, so tools can say exactly what the contract lacks. */
export async function missingApi(page, names) {
  return page.evaluate((names) => names.filter((n) => typeof window.__game?.[n] !== 'function'), names);
}

export const gameErrors = (page) => page.evaluate(() => (window.__game?.errors ? window.__game.errors() : window.__errors || [])).catch(() => []);
