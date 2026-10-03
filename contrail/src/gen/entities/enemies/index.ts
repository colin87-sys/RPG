/** WARDEN swarm enemy builders (Entities lane, enemies). Local frame for all: nose = -Z, up = +Y, metres. */
export { ENEMY_VARIANTS, type EnemyVariant, type EnemyVariantId } from './variants';
export { createEnemyMaterial, setEnemySilhouette, setEnemyHitFlash, HIT_FLASH_FRAMES, type EnemyLook } from './material';
export { buildCaltrop, CaltropSwarm, type CaltropParams, type CaltropBuild } from './caltrop';
export { buildDart, DartSquadron, type DartParams, type DartBuild } from './dart';
export { buildSniper, type SniperParams, type SniperBuild, type SniperState } from './sniper';
export { buildStrider, type StriderParams, type StriderBuild, type StriderState } from './strider';
export { buildBulwark, type BulwarkParams, type BulwarkBuild, type BulwarkState } from './bulwark';
export { countTriangles, countDrawCalls } from './kit';
