/**
 * Sky lane public entry: builds the full sky + cloud set for a stage from one
 * params object and seed. The game and the lab boards both call this.
 *
 *   const vista = buildSkyVista(CLOUDGATE_VARIANTS.B, seed);
 *   scene.add(vista.group);
 *   // every frame (after moving the camera):
 *   vista.update(camera.position, timeSeconds);
 *
 * Needs applyStageLook(params.stage) (shared lighting rig) to have been called.
 */
import * as THREE from 'three';
import { buildSkyDome } from './skyDome';
import { buildCloudField } from './clouds';
import { buildCloudSea } from './cloudSea';
import { buildCloudBands } from './violet';
import type { SkyVistaParams } from './params';

export * from './params';
export { buildSkyDome } from './skyDome';
export { buildCloudField, layoutCloudField } from './clouds';
export { buildCloudSea } from './cloudSea';
export { buildCloudBands } from './violet';
export { puffAtlas } from './puffAtlas';
export { noiseTexture } from './noise';

export interface SkyVista {
  group: THREE.Group;
  update(cameraPos: THREE.Vector3, time: number): void;
  stats: { triangles: number; drawCalls: number; puffs: number; bands: number; textures: string[] };
}

export function buildSkyVista(params: SkyVistaParams, seed: number): SkyVista {
  const s = params.stage;
  const dome = buildSkyDome(s, params.sky);
  const sea = buildCloudSea(s, params.sea, seed);
  const bands = buildCloudBands(s, params.bands, seed);
  const clouds = buildCloudField(s, params.clouds, seed);
  const group = new THREE.Group();
  group.name = `skyVista:${s}`;
  group.add(dome.mesh, sea.mesh, bands.group, clouds.group);
  const parts = [dome.stats, sea.stats, bands.stats, clouds.stats];
  return {
    group,
    update(cameraPos: THREE.Vector3, time: number) {
      dome.update(cameraPos, time);
      sea.update(cameraPos, time);
      bands.update(cameraPos, time);
      clouds.update(cameraPos, time);
    },
    stats: {
      triangles: parts.reduce((a, p) => a + p.triangles, 0),
      drawCalls: parts.reduce((a, p) => a + p.drawCalls, 0),
      puffs: clouds.stats.puffs,
      bands: bands.stats.bands,
      textures: ['puffAtlas 1024x1024 RGBA8', 'skyNoise 256x256 RGBA8', `cloudData ${1024}x${4 * Math.ceil(clouds.stats.puffs / 1024)} RGBA32F`],
    },
  };
}
