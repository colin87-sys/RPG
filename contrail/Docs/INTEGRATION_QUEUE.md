# INTEGRATION_QUEUE — CONTRAIL

Lanes append one row per module ready for integration. Only the Integrator (Director) wires modules into `src/main.ts` / scene composition.

| UTC | Lane | Module | Manifest | Evidence (board/capture) | Notes | Status |
|---|---|---|---|---|---|---|
| 2026-09-30 | Entities (hero) | kestrel.ts (+hullMaterial, exhaust, emblem) | src/gen/entities/kestrel.entity.json | look/candidates/hero_{A,B,C}.png | buildKestrel(KESTREL_VARIANTS.B, 7); place/yaw root, pass bank/pitch to update(); 3 draw calls | ready |
| 2026-09-30 | Entities (hero) | pilot.ts | src/gen/entities/pilot.entity.json | look/candidates/hero_*.png (line-up + portraits) | drawPilotPortrait for the HUD pilot frame (UI lane) | ready |
| 2026-09-30 | World (space+structures) | spaceSky (`buildSpaceSky`) | src/gen/world/space/spaceSky.entity.json | look/candidates/vista-wreck_{A,B,C}.png | 2 calls, 1.3k tris + stars; camera-relative far-plane dome | ready |
| 2026-09-30 | World (space+structures) | debrisField (`buildDebrisField`; `buildWreckfield` wraps sky+debris, `WRECK_VARIANTS`) | src/gen/world/space/debris.entity.json | look/candidates/vista-wreck_{A,B,C}.png | 7 calls, 18-34k tris; call update(cameraPos,time) each frame; camera.far >= 1600 | ready |
| 2026-09-30 | World (space+structures) | hullMass (`buildHullMass`, `HULL_VARIANTS`) | src/gen/world/structures/hullMass.entity.json | look/candidates/structures_{A,B,C}.png | 3 calls, 10.7-17.3k tris, ~480 m; place group origin at rail distance, update(time) | ready |
| 08:34Z | VFX-B | smoke.ts (SmokeTrails) | src/gen/vfx/smoke.entity.json | look/candidates/vfx-smoke_{A,B,C}.png | 1 draw call, 3000 puffs; prefer A; exhaust = own instance with SMOKE_EXHAUST | ready |
| 08:34Z | VFX-B | explosions.ts (Explosions) | src/gen/vfx/explosions.entity.json | look/candidates/vfx-explosion_{A,B,C}.png | 2 draw calls (fire/smoke + own Sparks); prefer A | ready |
| 08:34Z | VFX-B | sparks.ts (Sparks) | src/gen/vfx/sparks.entity.json | vfx-explosion boards | 1 draw call, additive | ready |
| 08:34Z | VFX-B | particles-hit.ts (HitPops) | src/gen/vfx/particles-hit.entity.json | vfx-explosion row 3 | 1 draw call, 0.08-0.15 s | ready |
| 2026-09-30 | UI | font (src/gen/ui/font.ts) | src/gen/ui/font.entity.json | lab board hud-font | drawText/measureText, GLYPH_STYLES A/B/C | ready |
| 2026-09-30 | UI | hud (src/gen/ui/hud.ts + hudSamples.ts, backdrop.ts) | src/gen/ui/hud.entity.json | look/candidates/hud_{A,B,C}.png, hud-states_{A,B,C}.png | new Hud('A').draw(g,w,h,state,dt) on app.hudCtx after setTransform(dpr); createHudState() | ready |
| 2026-09-30 | UI | screens (src/gen/ui/screens.ts) | src/gen/ui/screens.entity.json | look/candidates/screens_{A,B,C}.png | drawTitle/drawResults/drawPause/drawGameOver/drawStageCard; setScreenStyle(HUD_VARIANTS.A.glyph) | ready |
