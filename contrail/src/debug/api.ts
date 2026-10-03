/**
 * window.__game — the debug/capture API (GAME_FORGE W5, Appendix C).
 * Exposed when ?debug=1 or ?det=1 (and always in `vite dev`).
 * The harness (tools/*.mjs) drives the game ONLY through this contract.
 * Contract changes happen between milestones, with a commit (kit freeze rule).
 */

export type GameStateName = 'boot' | 'title' | 'launch' | 'play' | 'results' | 'gameover';

export interface GameStateSnapshot {
  state: GameStateName;
  paused: boolean;
  stage: string;
  mode: 'campaign' | 'caravan';
  difficulty: string;
  /** stage time in seconds (scaled world time) */
  time: number;
  /** fixed simulation frames since boot */
  frame: number;
  seed: number;
  progress: number; // 0..1 along the stage rail
  score: number;
  shield: number;
  combo: number; // current chain
  bestCombo: number;
  kills: number;
  enemiesAlive: number;
  hostileProjectiles: number;
  missiles: number; // ammo
  locks: number;
  player: {
    x: number;
    y: number;
    bank: number;
    rolling: boolean;
    wingtrail: boolean;
    invulnerable: boolean;
  };
  boss: { name: string; phase: number; hp01: number } | null;
  results: { rank: string; score: number; bestCombo: number; shieldLeft: number; timeS: number; cleared: boolean } | null;
}

export interface PerfSnapshot {
  drawCalls: number;
  triangles: number;
  /** mean CPU+GPU-submit ms of the last 60 rendered frames (software GL: relative only) */
  frameMs: number;
  programs: number;
  textures: number;
  geometries: number;
  softwareGL: boolean;
}

export interface GameDebugAPI {
  version: string;
  /** true once the game has booted and the first frame rendered */
  ready: boolean;
  /** reseed and reset to the title (or to play if a stage was started) */
  setSeed(seed: number): void;
  /** reset the current stage and fast-forward to stage time t (seconds), no rendering while skipping */
  setTime(t: number): void;
  /** advance exactly n fixed steps (1/60 s each), then render once */
  step(n: number): void;
  /** story camera by name; see cameras() */
  setCamera(name: string): void;
  cameras(): string[];
  state(): GameStateSnapshot;
  /** PNG data URL of the composited frame (WebGL + HUD) */
  capture(): string;
  /** leave the title and start a stage */
  start(opts?: { stage?: string; mode?: 'campaign' | 'caravan'; difficulty?: string }): void;
  /** autopilot on/off (goldpath, attract mode) */
  setBot(on: boolean): void;
  /** captures only; the goldpath must never use this */
  setInvulnerable(on: boolean): void;
  /** event counters since the last start(): e.g. cannonFire, parry, enemyKilled:missile */
  counts(): Record<string, number>;
  /** console errors and uncaught exceptions seen by the page */
  errors(): string[];
  perf(): PerfSnapshot;
  /** post stack clean (tone map only) on/off */
  setPost(clean: boolean): void;
  /** HUD visibility (story cameras 'hero'/'vista' hide it) */
  setHud(on: boolean): void;
  /** S6 readability: GL frame (no HUD) + hostile-projectile mask (white on black), same camera/size */
  readabilityMasks(): Promise<{ frame: string; mask: string }>;
  /** end the current run immediately (A13 retry timing) */
  forceGameOver(): void;
}

declare global {
  interface Window {
    __game?: GameDebugAPI;
    __errors?: string[];
  }
}

/** Install early error capture so errors() also sees boot failures. */
export function installErrorCapture(): void {
  const errs: string[] = (window.__errors = window.__errors ?? []);
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    errs.push(args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' '));
    origError(...args);
  };
  window.addEventListener('error', (e) => errs.push(`uncaught: ${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => errs.push(`unhandled rejection: ${String(e.reason)}`));
}
