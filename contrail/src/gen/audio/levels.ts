/**
 * Master chain constants (shared by mixer and docs). Ceiling = -1 dBFS nominal:
 * the waveshaper curve end sits at ~-1.1 dBFS, so no sample can exceed -1 dBFS.
 */
export const MASTER_CEILING = {
  dcHz: 18,
  compThresholdDb: -6,
  compKneeDb: 3,
  compRatio: 16,
  compAttackS: 0.0015,
  compReleaseS: 0.12,
  knee: 0.75,
  ceiling: 0.89,
} as const;
