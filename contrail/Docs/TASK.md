# TASK — CONTRAIL

## 1. Mission
Ship an original, fully procedural arcade rail shooter slice in the browser: one polished stage (Cloudgate) with the complete mechanic set, then two more stages, a strider mini-boss, the BULWARK capital boss and a 2-minute Caravan mode. Zero assets, zero external requests, readability better than the reference game. Sources: `Docs/CONCEPT_CARD.md`, `Docs/DESIGN.md` (numbers), `Docs/STYLE_BIBLE.md` + `src/style/tokens.ts` (look), `Docs/PRINCIPLES.md`, `Docs/REF_VERIFICATION.md`.

## 2. Experience targets
- **60 s:** title -> launch swoop -> bright Cloudgate corridor; a caltrop chain, first missile barrage with curved smoke, first explosion + chromatic ring + chain pop; a laser telegraph teaches the parry roll; shield refills from a 4-kill chain.
- **10 min:** Cloudgate -> Violet Tide -> Wreckfield with new enemy families per stage, strider trio mini-boss, BULWARK boss, results rank; Caravan invites retries.
- **Signature moments:** (1) 8-missile barrage with long curved smoke converging on bracketed targets; (2) wingtrail spin: slow time + chromatic ring through a swarm; (3) BULWARK filling the sky with vent rows and a wall of yellow beams.

## 3. Priorities
- **P0 (must ship):** Cloudgate stage complete with every core mechanic (cannon, lock-on missiles, roll parry, drift, wingtrail, boost, brake, combo shield refill), hero craft, 4 enemy families, perimeter HUD, title/results/game-over, post stack, synth audio, harness green.
- **P1 (should):** Violet Tide, Wreckfield, BULWARK boss, Caravan mode, gamepad, readability tool (S6), stage-start upgrade chip, settings (volume, difficulty, post intensity).
- **P2 (if time):** roguelite one-life mode, cockpit camera, touch controls, livery swap.

## 4. Acceptance test
| ID | Pri | Requirement | Pass condition | Test method | Status |
|---|---|---|---|---|---|
| A1 | P0 | Stage 1 completes | goldpath: title -> launch -> Cloudgate -> results, exit 0, < 400 s simulated, `results.cleared` | `npm run goldpath` | agent-verified on stub (P1) |
| A2 | P0 | Mechanics present | goldpath counts > 0 for cannonFire, missileFire, enemyKilled:missile, parry, drift, wingtrail, shieldRefill | `npm run goldpath` | agent-verified on stub (P1) |
| A3 | P0 | Frame rate | >= 60 fps median at peak density (t=150 s) on a real GPU at 1080p; in this container report software-GL relative ms and exact draw calls/triangles | `npm run perf -- --t 150` | pending owner review (no GPU) |
| A4 | P0 | Offline | 0 external requests on title, play and lab | `npm run netcheck` | agent-verified |
| A5 | P0 | No reference files shipped | 0 manifest hashes and 0 image files in `dist/` | `npm run refcheck` | agent-verified |
| A6 | P0 | Clean console | 0 console errors / uncaught exceptions through goldpath | checks.json `errors.console` | agent-verified on stub |
| A7 | P0 | Look match | fresh Reviewer avg >= 7 (no axis < 5) on `npm run capture -- --cams hero,vista,combat,hud --t 150` vs `look/approved/` (owner refs by relationship only when `Docs/refs/` is present locally) | reviewer, `Docs/reviews/M2.md` | open (M1 review 6.17) |
| A8 | P0 | Budgets | peak draw calls <= 250, triangles <= 450k (perf exits 1 above); JS in `dist/assets` <= 1.5 MB total; 0 image/audio files in `dist/` | `npm run perf`; `du -cb dist/assets/*.js`; refcheck (images) | open |
| A9 | P1 | Readability (needs `__game.readabilityMasks`, T018) | hostile projectile median deltaE (CIEDE2000) >= 25 vs local background at peak density on every stage; Reviewer readability >= 7 | `npm run readability`, reviewer | open (API T018) |
| A10 | P1 | Stages 2-3 + boss | goldpath clears violetTide and wreckfield incl. BULWARK phases 1-3; goldpath asserts `state().stage` equals `--stage` (unknown stages throw) | `npm run goldpath -- --stage <id>` | open (stages not built) |
| A11 | P1 | Caravan mode | 120 s timed score attack ends in results; goldpath asserts `state().mode` | `npm run goldpath -- --mode caravan` | open (mode throws 'not implemented') |
| A12 | P1 | Audio health | audiocheck passes (peak <= -1 dBFS, no clipping, DC < 0.01, seam ok); labelled pending owner review | `npm run audiocheck` | agent-verified, pending owner review |
| A13 | P1 | Fast retry | game over -> flying again in < 2 s | TODO T030: goldpath `--gameover` option (force shield 0, confirm, measure) | open (tool missing) |
| A14 | P2 | Roguelite mode | one life, pickups, score | goldpath `--mode roguelite` (mode not built) | open |
| A15 | P1 | Challenge | goldpath bot ends Cloudgate with shield < 90 and takes >= 3 hits; peak live hostile projectiles >= 40 at t=150 | goldpath `final.shield`, counts.playerHit; `state().hostileProjectiles` | open (T027) |

## 5. Out of scope
Anime face renderer and voiced cutscenes; branching story paths and multiple endings; 40 weapons / 40 hulls / 100 liveries; online leaderboards and accounts; multiplayer; VR; console builds; licensed or downloaded assets; the reference game's title, logo, characters, story names, font, portrait art, music or exact HUD glyphs; cloud save sync; localisation beyond English; mobile-native packaging.

## 6. Milestones and gates
| M | Content | Gate |
|---|---|---|
| M0 Foundation | Vite build, harness live on the real project, placeholder loop | acceptance P0 checks pass on the real project; 0 console errors; netcheck clean |
| M1 Playable core | Cloudgate playable start to end with lane modules wired (craft, enemies, sky, HUD, VFX, audio) | goldpath passes; perf measured |
| M2 Look lock | Hero, Cloudgate and HUD at final-look quality matching `look/approved/` | A7 Reviewer >= 7 avg, no axis < 5; in-game beats naive baseline |
| M3 Content breadth | Violet Tide, Wreckfield, pickups, upgrade chip, settings | A1-A6, A8 pass; A10 stages 2-3 |
| M4 Peak moment | BULWARK boss, signature moments with VFX + audio | Reviewer >= 7 on peak captures; A10 boss |
| M5 Polish | hit-stop, shake, transitions, mix, onboarding, difficulty tuning, Caravan | P0 + P1 pass; perf budget met |
| M6 Ship candidate | bug bash, final captures, static build, REPORT.md, timelapse, tag | GAME_FORGE section 16 |

## 7. Budgets
60 fps median on a mid-range laptop GPU at 1080p (heaviest scene: Cloudgate t=150 s and BULWARK phase 3); draw calls <= 250; triangles <= 450k; generated textures <= 1024^2 each, <= 48 MB total; JS bundle <= 1.5 MB uncompressed; memory <= 400 MB; **external requests = 0**; images/audio files in `dist/` = 0.

## 8. Deliverables
`dist/` static build (runs from any static server), `Docs/REPORT.md`, final story-camera captures + contact sheet, `Docs/timelapse.webm` + `Docs/timelapse.html`, `checks.json`, tagged commit.

## 9. Progress documentation
Captures after every significant visual change into `Docs/progress/<feature>/<UTC>_<cam>.png` (`npm run capture -- --feature <name>`); DEVLOG at every milestone and hourly; STATS.json hourly; timelapse via `npm run timelapse`.

## 10. Status vocabulary
**implemented** (code exists) / **agent-verified** (harness or Reviewer evidence) / **pending owner review** (visual, audio, feel). Nothing is "accepted" until the owner says so. Audio is always pending owner review.
