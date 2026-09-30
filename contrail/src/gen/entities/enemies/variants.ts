/**
 * ENEMY_VARIANTS: three named parameter sets (A/B/C) for the WARDEN swarm.
 * Same code paths; they change rim/marker/panel/outline response and small
 * proportion tweaks.
 *   A "Ember rim"  : strong wide warm rim, moderate panels, no ink outline.
 *   B "Hard panel" : tighter rim, high panel contrast + seams, dense markers, ink outline.
 *   C "Ink"        : near-silhouette flat bodies, hot markers, ink outline, widest rim.
 */
import type { EnemyLook } from './material';
import type { CaltropParams } from './caltrop';
import type { DartParams } from './dart';
import type { SniperParams } from './sniper';
import type { StriderParams } from './strider';
import type { BulwarkParams } from './bulwark';

export interface EnemyVariant {
  name: string;
  look: EnemyLook;
  caltrop: CaltropParams;
  dart: DartParams;
  sniper: SniperParams;
  strider: StriderParams;
  bulwark: BulwarkParams;
}

function variant(name: string, look: EnemyLook, k: { spike: number; leg: number; wing: number }): EnemyVariant {
  return {
    name,
    look,
    caltrop: { span: 1.4, valley: 0.3, thickness: 0.24, sweep: 0.2 * k.spike, hubRadius: 0.3, backPoints: 0.6, spinRate: 6.5, look },
    dart: { length: 7, span: 4.6 * k.wing, height: 0.95, wingDroop: 0.2, finCant: 0.42, barbs: 1, look },
    sniper: { length: 8, lensRadius: 0.72, ringRadius: 1.2, claws: 3, vanes: 3, nodes: 6, look },
    strider: { height: 16, shoulderWidth: 7.6, legScale: k.leg, jetpackSize: 1, swayAmp: 1, springK: 26, damping: 3.2, look },
    bulwark: { span: 220, length: 150, sweep: 0.62, ventRows: 5, ventsPerRow: 30, emitters: 4, look },
  };
}

export const ENEMY_VARIANTS: Record<'A' | 'B' | 'C', EnemyVariant> = {
  A: variant(
    'Ember rim',
    { rimStrength: 1.35, rimPower: 2.4, rimWrap: 0.45, stageRim: 0.15, panelContrast: 0.65, markerIntensity: 2.2, markerDensity: 0.6, thrusterIntensity: 2.0, seamStrength: 0.25, outline: false, outlinePx: 1.6 },
    { spike: 1, leg: 1, wing: 1 },
  ),
  B: variant(
    'Hard panel',
    { rimStrength: 0.95, rimPower: 3.2, rimWrap: 0.3, stageRim: 0.25, panelContrast: 1.0, markerIntensity: 2.6, markerDensity: 1.0, thrusterIntensity: 2.2, seamStrength: 0.45, outline: true, outlinePx: 1.4 },
    { spike: 0.6, leg: 0.94, wing: 1.06 },
  ),
  C: variant(
    'Ink',
    { rimStrength: 1.7, rimPower: 2.0, rimWrap: 0.6, stageRim: 0.1, panelContrast: 0.3, markerIntensity: 3.0, markerDensity: 0.8, thrusterIntensity: 2.4, seamStrength: 0.0, outline: true, outlinePx: 2.0 },
    { spike: 1.4, leg: 1.07, wing: 0.95 },
  ),
};

export type EnemyVariantId = keyof typeof ENEMY_VARIANTS;
