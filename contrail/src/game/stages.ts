/**
 * Stage scripts. Events are keyed to NOMINAL time (rail distance / base speed),
 * so boosting brings the next wave sooner and braking later; the level is a place.
 * Cloudgate follows the DESIGN.md pacing template (~180 s).
 */
import { chainSpecs, type SpawnSpec } from './enemies';
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
}

const dart = (holdU: number, sx: number, sy: number, holdT: number, side: number): SpawnSpec => ({
  kind: 'dart', pattern: 'dart', u: 230, x: sx * 1.8, y: sy + 10,
  p: [holdU, sx, sy, holdT, side, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
});
const dartPair = (holdU: number, sx: number, sy: number, holdT = 7): SpawnSpec[] => [dart(holdU, -sx, sy, holdT, -1), dart(holdU + 8, sx, sy + 2, holdT, 1)];
const sniper = (hu: number, hx: number, hy: number, cycles = 2): SpawnSpec => ({
  kind: 'sniper', pattern: 'sniper', u: 260, x: hx * 1.6, y: hy + 12,
  p: [hu, hx, hy, cycles, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
});
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

export const CLOUDGATE: StageDef = {
  id: 'cloudgate',
  name: 'CLOUDGATE',
  lengthS: 180,
  par: 60000,
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
    { at: 152, warning: '// SATURATION ZONE //' },
    {
      at: 154,
      spawn: [...chainSpecs(14, sCurve(), 6.0), ...chainSpecs(12, diveTop(0), 5.0), ...dartPair(80, 12, 0), ...dartPair(100, 16, 6), sniper(165, 20, 8), sniper(160, -20, -4)],
    },
    { at: 160, spawn: [...chainSpecs(12, riseLow(-4), 5.0), ...dartPair(90, 8, -2)] },
    { at: 164, spawn: [sniper(150, 0, 10, 1)] },
  ],
};

export const STAGES: Record<string, StageDef> = { cloudgate: CLOUDGATE };
