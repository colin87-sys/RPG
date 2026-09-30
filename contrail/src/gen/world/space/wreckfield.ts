/**
 * Wreckfield space set: sky + debris field, variants A/B/C and a convenience
 * builder that returns one group plus a single update(cameraPos, time).
 */
import * as THREE from 'three';
import { buildSpaceSky, SPACE_SKY_DEFAULTS, type SpaceSky, type SpaceSkyParams } from './spaceSky';
import { buildDebrisField, DEBRIS_DEFAULTS, type DebrisField, type DebrisParams } from './debris';

export interface WreckParams {
  sky: SpaceSkyParams;
  debris: DebrisParams;
}

/** A = balanced; B = dense wreck storm, strong nebula, small far planet; C = sparse, calm, big planet. */
export const WRECK_VARIANTS: Record<'A' | 'B' | 'C', WreckParams> = {
  A: {
    sky: { ...SPACE_SKY_DEFAULTS },
    debris: { ...DEBRIS_DEFAULTS },
  },
  B: {
    sky: { ...SPACE_SKY_DEFAULTS, nebulaStrength: 1.45, nebulaWidth: 0.42, planetSize: 0.085, planetPhase: 0.62, starCount: 6200, nebulaWarmth: 0.45 },
    debris: { ...DEBRIS_DEFAULTS, fleckCount: 6000, slabCount: 84, asteroidCount: 92, giantCount: 8, slabLightPanels: 0.12, farMix: 0.78 },
  },
  C: {
    sky: { ...SPACE_SKY_DEFAULTS, nebulaStrength: 1.15, planetSize: 0.17, planetPhase: 0.45, planetGlow: 0.5, starCount: 6400, centreCalm: 0.5 },
    debris: { ...DEBRIS_DEFAULTS, fleckCount: 3000, slabCount: 42, asteroidCount: 52, giantCount: 5, fleckLightFraction: 0.25, farMix: 0.86 },
  },
};

export interface Wreckfield {
  group: THREE.Group;
  sky: SpaceSky;
  debris: DebrisField;
  update(cameraPos: THREE.Vector3, time: number): void;
  dispose(): void;
}

export function buildWreckfield(params: WreckParams = WRECK_VARIANTS.A, seed = 1): Wreckfield {
  const sky = buildSpaceSky(params.sky, seed);
  const debris = buildDebrisField(params.debris, seed);
  const group = new THREE.Group();
  group.name = 'wreckfield';
  group.add(sky.mesh, debris.group);
  return {
    group,
    sky,
    debris,
    update(cameraPos, time) {
      sky.update(cameraPos, time);
      debris.update(cameraPos, time);
    },
    dispose() {
      sky.dispose();
      debris.dispose();
    },
  };
}
