/**
 * Stage scripts. Events are keyed to NOMINAL time (rail distance / base speed),
 * so boosting brings the next wave sooner and braking later; the level is a place.
 * Cloudgate follows the DESIGN.md pacing template (~180 s). Violet Tide (~180 s)
 * leans on dart squadrons and sniper crossfire; Wreckfield (~200 s) on caltrop
 * nets and weaving chains, ending in BULWARK. Caravan re-times Cloudgate's waves.
 */
import { chainSpecs, ringSpecs, strafeSpecs, type SpawnSpec } from './enemies';
import { T } from '../data/tuning';
import type { StageId } from '../style/tokens';

export interface StageEvent {
  at: number; // nominal seconds
  spawn?: SpawnSpec[];
  prompt?: string; // tutorial prompt shown on the HUD
  warning?: string; // hazard banner text
  pickups?: { kind: 'shield' | 'missile'; x: number; y: number }[];
}

export interface StageDef {
  id: StageId;
  name: string;
  lengthS: number; // nominal seconds
  events: StageEvent[];
  /** set pieces the view places along the rail (nominal seconds) */
  structures: { from: number; to: number; side: -1 | 1 }[];
  /** par score for ranking */
  par: number;
  railSeed: number;
  /** boss stage: ends when the boss dies; reaching the rail end first = boss escaped (not cleared) */
  boss?: boolean;
  /** stage card subtitle */
  subtitle: string;
}

const dart = (holdU: number, sx: number, sy: number, holdT: number, side: number): SpawnSpec => ({
  kind: 'dart', pattern: 'dart', u: 230, x: sx * 1.8, y: sy + 10,
  p: [holdU, sx, sy, holdT, side, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
});
const dartPair = (holdU: number, sx: number, sy: number, holdT = 7): SpawnSpec[] => [dart(holdU, -sx, sy, holdT, -1), dart(holdU + 8, sx, sy + 2, holdT, 1)];
const sniper = (hu: number, hx: number, hy: number, cycles = 2, sweep = 0): SpawnSpec => ({
  kind: 'sniper', pattern: 'sniper', u: 260, x: hx * 1.6, y: hy + 12,
  p: [hu, hx, hy, cycles, sweep, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
});
/** sniper whose beam sweeps horizontally across the window at the player's height */
const sweeper = (hu: number, hx: number, hy: number, cycles = 2): SpawnSpec => sniper(hu, hx, hy, cycles, 1);
/** two snipers on opposite sides, staggered so their lines cross */
const crossfire = (hu: number, hx: number, hy: number): SpawnSpec[] => [sniper(hu, -hx, hy), sniper(hu + 15, hx, -hy * 0.5)];
const strider = (hu: number, hx: number, hy: number, index: number, segT: number): SpawnSpec => ({
  kind: 'strider', pattern: 'strider', u: 260, x: hx, y: hy + 25, index,
  p: [hu, hx, hy, segT, 0, 0, 0, 0, index * 2.3, 0, 0, 0, 0, 0, 0, 0],
});

// Chain paths: [x, y, u] control points (rail space)
const sweepRL = (y = 6): [number, number, number][] => [[30, y + 8, 230], [20, y + 4, 120], [-18, y - 4, 55], [-34, y - 10, -25]];
const sweepLR = (y = 6): [number, number, number][] => [[-30, y + 8, 230], [-20, y + 4, 120], [18, y - 4, 55], [34, y - 10, -25]];
const diveTop = (x = 0): [number, number, number][] => [[x + 6, 26, 240], [x, 16, 130], [x - 4, -4, 60], [x - 10, -20, -25]];
const riseLow = (x = 0): [number, number, number][] => [[x - 8, -22, 240], [x, -12, 140], [x + 6, 8, 60], [x + 12, 22, -25]];
const sCurve = (): [number, number, number][] => [[-28, -6, 240], [30, 10, 160], [-30, 6, 80], [26, -8, -25]];
// Wreckfield: tight weaves that swing through the corridor twice (debris slalom)
const weave = (s = 1, y = 0): [number, number, number][] => [[-34 * s, y + 12, 250], [44 * s, y - 10, 165], [-44 * s, y + 8, 85], [30 * s, y - 8, -25]];
const corkscrew = (s = 1): [number, number, number][] => [[0, 30, 250], [36 * s, -18, 170], [-36 * s, -16, 90], [0, 22, -25]];

export const CLOUDGATE: StageDef = {
  id: 'cloudgate',
  name: 'CLOUDGATE',
  subtitle: 'CLOUD CORRIDOR',
  lengthS: 180,
  par: 65000, // bot ~0.8-0.86 (A) after T027
  railSeed: 11,
  structures: [
    { from: 36, to: 74, side: 1 },
    { from: 138, to: 168, side: -1 },
  ],
  events: [
    { at: 0.5, prompt: 'STEER: WASD / MOUSE' },
    { at: 2.5, spawn: chainSpecs(8, sweepRL(4), 5.0), prompt: 'CANNON: HOLD J / LEFT MOUSE' },
    { at: 8, spawn: chainSpecs(8, sweepLR(2), 5.0), prompt: 'MISSILES: HOLD K / RIGHT MOUSE, SWEEP, RELEASE' },
    { at: 13, spawn: chainSpecs(10, diveTop(-4), 4.8) },
    { at: 16, spawn: dartPair(90, 10, 3), prompt: 'PARRY: ROLL Q / E AS FIRE ARRIVES' },
    { at: 22, spawn: dartPair(80, 14, -2) },
    { at: 26, spawn: [sniper(150, 18, 7)], prompt: 'RED LINE = LASER. MOVE OR ROLL' },
    { at: 30, spawn: [...chainSpecs(12, sCurve(), 6.0), ...dartPair(95, 8, 5)] },
    { at: 34, prompt: 'DRIFT: L   WINGTRAIL: SPACE' },
    { at: 36, spawn: [...dartPair(85, 12, 0), ...dartPair(110, 4, 8)] },
    { at: 42, spawn: [sniper(160, -20, 6), sniper(150, 20, -4), ...chainSpecs(10, riseLow(4), 5.0)] },
    { at: 48, spawn: chainSpecs(12, sweepRL(-2), 5.2) },
    { at: 54, spawn: [...dartPair(90, 12, 4), sniper(170, 0, 12)] },
    { at: 60, spawn: [...chainSpecs(10, sweepRL(8), 5.0), ...chainSpecs(10, sweepLR(-6), 5.0)] },
    { at: 66, spawn: [sniper(150, -18, -6), sniper(160, 18, 8), ...dartPair(100, 6, 2)] },
    { at: 72, pickups: [{ kind: 'shield', x: -6, y: 2 }, { kind: 'missile', x: 6, y: -2 }] },
    { at: 78, spawn: chainSpecs(8, diveTop(8), 4.6) },
    { at: 84, pickups: [{ kind: 'missile', x: 0, y: 5 }] },
    { at: 86, spawn: chainSpecs(14, sCurve(), 6.5) },
    { at: 92, spawn: [...chainSpecs(12, sweepLR(4), 5.0), ...dartPair(90, 14, 0)] },
    { at: 99, warning: '// HOSTILE WALKERS INBOUND //' },
    {
      at: 102,
      spawn: [strider(75, -15, 2, 0, 38), strider(92, 0, 7, 1, 38), strider(75, 15, 2, 2, 38)],
    },
    { at: 118, spawn: chainSpecs(8, sweepRL(10), 5.0) },
    { at: 128, spawn: chainSpecs(8, sweepLR(-4), 5.0) },
    { at: 140, spawn: [...chainSpecs(10, sweepRL(6), 5.0), ...dartPair(90, 10, 2)] },
    { at: 144, spawn: [...chainSpecs(10, sweepLR(-6), 5.0), sniper(160, -18, 8)] },
    { at: 148, spawn: [...dartPair(85, 14, -3), ...dartPair(105, 6, 6), sniper(170, 18, -6)] },
    { at: 145, spawn: [strider(95, 0, 8, 3, 25)] }, // T027: gauntlet walker (all families at peak density)
    { at: 152, warning: '// SATURATION ZONE //' },
    {
      at: 154,
      spawn: [...chainSpecs(14, sCurve(), 6.0), ...chainSpecs(12, diveTop(0), 5.0), ...dartPair(80, 12, 0), ...dartPair(100, 16, 6), sniper(165, 20, 8), sniper(160, -20, -4)],
    },
    { at: 158, spawn: chainSpecs(12, riseLow(-4), 5.0) },
    { at: 162, spawn: [strider(85, -14, 3, 4, 14), strider(100, 0, 8, 5, 14), strider(92, 14, 4, 6, 14)] }, // T027: rearguard walkers, few kills = no late refill
    { at: 164, spawn: [sniper(150, 0, 10, 1)] },
    { at: 167, spawn: [sniper(155, -18, 6, 2), sniper(165, 18, -2, 2)] }, // T027: parting crossfire
  ],
};

/** Stage 2: low sun, craft backlit. Squadrons crossing the corridor, sniper crossfire, a strider pair. */
export const VIOLET_TIDE: StageDef = {
  id: 'violetTide',
  name: 'VIOLET TIDE',
  subtitle: 'SUNSET CLOUD SEA',
  lengthS: 180,
  par: 48000,
  railSeed: 23,
  structures: [],
  events: [
    { at: 1, prompt: 'SQUADRONS CROSS THE CORRIDOR: LEAD THEM' },
    { at: 3, spawn: chainSpecs(8, sweepLR(4), 5.0) },
    { at: 7, spawn: strafeSpecs(4, 110, 5, 1) },
    { at: 12, spawn: chainSpecs(10, diveTop(4), 4.8) },
    { at: 15, spawn: dartPair(90, 12, 2) },
    { at: 19, spawn: strafeSpecs(4, 95, -2, -1) },
    { at: 24, spawn: crossfire(150, 20, 6), prompt: 'CROSSFIRE: WATCH BOTH RED LINES' },
    { at: 30, spawn: [...chainSpecs(12, sCurve(), 6.0), ...strafeSpecs(5, 120, 8, 1)] },
    { at: 36, spawn: [sweeper(150, -20, 4), ...dartPair(95, 10, 0)], prompt: 'SWEEPING BEAM: CLIMB OR DIVE' },
    { at: 42, spawn: [...strafeSpecs(4, 100, 6, 1), ...strafeSpecs(4, 125, -4, -1)] },
    { at: 48, spawn: [...chainSpecs(12, sweepRL(-2), 5.2), ...crossfire(160, 18, 8)] },
    { at: 55, spawn: [...dartPair(85, 14, -2), ...dartPair(105, 6, 7)] },
    { at: 61, pickups: [{ kind: 'shield', x: -6, y: 2 }, { kind: 'missile', x: 6, y: -2 }] },
    { at: 66, spawn: [...chainSpecs(10, sweepRL(8), 5.0), ...strafeSpecs(5, 105, 0, -1)] },
    { at: 72, spawn: [sweeper(150, 20, 6), sweeper(165, -20, -2, 1)] },
    { at: 78, spawn: [...chainSpecs(12, riseLow(0), 5.0), ...chainSpecs(10, diveTop(-6), 5.0)] },
    { at: 83, warning: '// TWIN WALKERS //' },
    { at: 86, spawn: [strider(78, -13, 3, 0, 34), strider(88, 13, 6, 1, 34)] },
    { at: 96, spawn: strafeSpecs(4, 130, 10, 1) },
    { at: 106, spawn: chainSpecs(10, sweepLR(-4), 5.0) },
    { at: 118, spawn: [...crossfire(150, 20, 4), ...dartPair(95, 12, 2)] },
    { at: 124, spawn: [...strafeSpecs(5, 100, 4, 1), ...strafeSpecs(5, 120, -3, -1)] },
    { at: 130, spawn: [...chainSpecs(12, sCurve(), 6.0), sweeper(160, 18, 0)] },
    { at: 136, pickups: [{ kind: 'missile', x: 0, y: 4 }] },
    { at: 139, warning: '// SUNSET GAUNTLET //' },
    { at: 141, spawn: [...strafeSpecs(5, 95, 6, -1), sweeper(150, -20, 2), ...dartPair(85, 12, -2)] },
    { at: 147, spawn: [...chainSpecs(12, sweepRL(4), 5.0), ...chainSpecs(12, sweepLR(-4), 5.0), ...dartPair(100, 8, 6)] },
    { at: 152, spawn: [...crossfire(155, 20, 6), ...strafeSpecs(5, 115, -2, 1), ...dartPair(90, 14, 0)] },
    { at: 158, spawn: [...dartPair(85, 10, 4), ...dartPair(105, 16, -3), sweeper(165, 20, 4, 1), strider(100, 0, 9, 2, 17)] },
    { at: 163, spawn: [...chainSpecs(12, riseLow(4), 5.0), ...strafeSpecs(4, 110, 2, -1)] },
    { at: 166, spawn: [sniper(150, -20, 6), sniper(160, 20, -2), sweeper(170, 0, 11, 1), ...dartPair(110, 12, 4, 9)] }, // last light: crossfire finale
  ],
};

/** Stage 3: dark debris field. Caltrop nets, weaving chains, snipers, then BULWARK. */
export const WRECKFIELD: StageDef = {
  id: 'wreckfield',
  name: 'WRECKFIELD',
  subtitle: 'DEBRIS FIELD',
  lengthS: 250, // escape limit; the stage ends when BULWARK dies (~190-205 s)
  boss: true,
  par: 110000,
  railSeed: 37,
  structures: [],
  events: [
    { at: 1, prompt: 'CALTROP NETS CLOSE ON YOU: BREAK OUT' },
    { at: 3, spawn: chainSpecs(12, weave(1, 2), 5.6, 0.14) },
    { at: 7, spawn: chainSpecs(12, weave(-1, -2), 5.6, 0.14) },
    { at: 12, spawn: ringSpecs(10, 1) },
    { at: 18, spawn: [sniper(160, -18, 6), ...chainSpecs(14, corkscrew(1), 6.0, 0.14)] },
    { at: 24, spawn: [...ringSpecs(12, -1), ...dartPair(95, 12, 2)] },
    { at: 30, spawn: [...chainSpecs(12, weave(1, 6), 5.6, 0.14), ...chainSpecs(12, weave(-1, -6), 5.6, 0.14)] },
    { at: 36, spawn: [sweeper(155, 20, 2), ...chainSpecs(10, sweepRL(0), 5.0)] },
    { at: 42, spawn: [...ringSpecs(12, 1), sniper(165, -20, 8)] },
    { at: 48, spawn: [...chainSpecs(14, weave(1, 0), 5.8, 0.13), ...chainSpecs(14, corkscrew(-1), 6.0, 0.13)] },
    { at: 55, spawn: [...dartPair(90, 12, 0), ...crossfire(155, 20, 6)] },
    { at: 61, pickups: [{ kind: 'shield', x: 6, y: 2 }, { kind: 'missile', x: -6, y: -2 }] },
    { at: 65, spawn: [...chainSpecs(16, weave(-1, 3), 6.0, 0.12), ...ringSpecs(10, -1)] },
    { at: 73, spawn: [sniper(150, -18, 6), sweeper(160, 20, -2), sniper(170, 0, 12, 1)] },
    { at: 80, spawn: [...ringSpecs(12, 1), ...chainSpecs(12, weave(1, -4), 5.6, 0.14)] },
    { at: 87, spawn: [...dartPair(85, 14, -2), ...dartPair(105, 6, 6), ...chainSpecs(10, corkscrew(1), 6.0)] },
    { at: 95, spawn: [...ringSpecs(14, -1), sweeper(155, -20, 4)] },
    { at: 101, spawn: [...chainSpecs(14, weave(1, 4), 5.6, 0.13), ...chainSpecs(14, weave(-1, -4), 5.6, 0.13)] },
    { at: 108, pickups: [{ kind: 'shield', x: 0, y: 3 }, { kind: 'missile', x: 8, y: -2 }, { kind: 'missile', x: -8, y: -2 }] },
    { at: 112, spawn: [...chainSpecs(10, sweepLR(2), 5.0), ...crossfire(160, 18, 4)] },
    { at: 119, warning: '// CAPITAL SIGNATURE: BULWARK //' },
    { at: 123, spawn: [{ kind: 'bulwark', pattern: 'bulwark', u: T.behaviour.bulwark.arriveU, x: 0, y: T.behaviour.bulwark.arriveY }] },
  ],
};

/**
 * Caravan: Cloudgate's waves (tutorial prompts dropped, no shield pickups) re-timed
 * x1.4 denser into a 120 s loop.
 */
export const CARAVAN_EVENTS: { loopS: number; events: StageEvent[] } = (() => {
  const t0 = 2.5, lead = 2;
  const events = CLOUDGATE.events
    .filter((e) => e.at >= t0 && (e.spawn || e.warning || e.pickups))
    .map((e) => ({ ...e, prompt: undefined, at: lead + (e.at - t0) / T.caravan.density }));
  return { loopS: T.caravan.duration, events };
})();

export const STAGES: Record<string, StageDef> = { cloudgate: CLOUDGATE, violetTide: VIOLET_TIDE, wreckfield: WRECKFIELD };
