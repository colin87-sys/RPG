/**
 * URL parameters that drive captures and debugging.
 *   ?seed=<int>       RNG seed (default 1)
 *   ?det=1            deterministic mode: time advances only via __game.step(n)
 *   ?debug=1          expose window.__game (always on in dev and det mode)
 *   ?cam=<name>       story camera (see src/debug/cameras.ts)
 *   ?t=<seconds>      fast-forward the stage to this time after boot
 *   ?stage=<id>       cloudgate | violetTide | wreckfield
 *   ?clean=1          post stack off (tone mapping only), for harness comparisons
 *   ?mode=<id>        campaign | caravan
 *   ?skip=1           skip title, start playing immediately
 *   ?bot=1            autopilot (attract mode / goldpath)
 *   ?mute=1           no audio output
 *   ?w=&h=            fixed render size (captures)
 */
export interface Params {
  seed: number;
  det: boolean;
  debug: boolean;
  cam: string | null;
  t: number | null;
  stage: string | null;
  clean: boolean;
  mode: string | null;
  skip: boolean;
  bot: boolean;
  mute: boolean;
  w: number | null;
  h: number | null;
  raw: URLSearchParams;
}

export function readParams(search = typeof location !== 'undefined' ? location.search : ''): Params {
  const q = new URLSearchParams(search);
  const num = (k: string): number | null => {
    const v = q.get(k);
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const flag = (k: string) => q.get(k) === '1' || q.get(k) === 'true';
  const det = flag('det');
  return {
    seed: (num('seed') ?? 1) >>> 0,
    det,
    debug: flag('debug') || det || import.meta.env.DEV,
    cam: q.get('cam'),
    t: num('t'),
    stage: q.get('stage'),
    clean: flag('clean'),
    mode: q.get('mode'),
    skip: flag('skip'),
    bot: flag('bot'),
    mute: flag('mute') || det,
    w: num('w'),
    h: num('h'),
    raw: q,
  };
}
