# INTEGRATION_QUEUE — CONTRAIL

Lanes append one row per module ready for integration. Only the Integrator (Director) wires modules into `src/main.ts` / scene composition.

| UTC | Lane | Module | Manifest | Evidence (board/capture) | Notes | Status |
|---|---|---|---|---|---|---|
| 2026-09-30 | Entities (hero) | kestrel.ts (+hullMaterial, exhaust, emblem) | src/gen/entities/kestrel.entity.json | look/candidates/hero_{A,B,C}.png | buildKestrel(KESTREL_VARIANTS.B, 7); place/yaw root, pass bank/pitch to update(); 3 draw calls | ready |
| 2026-09-30 | Entities (hero) | pilot.ts | src/gen/entities/pilot.entity.json | look/candidates/hero_*.png (line-up + portraits) | drawPilotPortrait for the HUD pilot frame (UI lane) | ready |
