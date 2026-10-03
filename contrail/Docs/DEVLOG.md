# DEVLOG — CONTRAIL (append-only, UTC)

## 2026-09-30T04:55Z — Phase 0 done
Kit unzipped into `contrail/` (sub-project of the public RPG repo). Reference pack kept local-only (gitignored) with a committed SHA-256 manifest for refcheck. Env audit: Node 22, Playwright 1.56.1 + Chromium 141, WebGL2 via SwiftShader, OfflineAudioContext OK, no GPU, VP8 ffmpeg for timelapse. Director opened 12 reference stills/sheets (04, 01, 09, 10, 03, 07, 02, 08, 18, m1 sheet, m4 sheet) to ground the look. Next: P1 kit generation.

## 2026-09-30T10:05Z — P1 kit lanes delivered
All 8 lanes + harness + reference analyst finished (after two API session-limit pauses, resumed). Delivered: KESTREL craft, WARDEN enemies (5), Cloudgate/Violet skies + clouds, Wreckfield space + hull mass, original font + perimeter HUD + screens, post stack + rings + bullets + beams, smoke + explosions + sparks, synth audio (25/25 numeric pass), full harness (acceptance green on stub). Director opened hero_B, vista-wreck_A, vfx-smoke_A, hud_A, vista-cloudgate_B, enemies_C, vfx-bullets_A; defects T010-T023 queued. W4 TASK.md, W6 lessons, W7 CLAUDE.md/KICKOFF/hooks written. Fresh Reviewer ranking A/B/C now.

## 2026-09-30T11:20Z — Integration + consistency pass + freeze
Lane modules wired into the game (view.ts, hudAdapter.ts, main.ts): goldpath passes with real visuals (rank A, 7/7 mechanics). W3 Reviewer: 6.4 avg -> consistency pass by 6 lanes (Violet darker, hull dark, HUD contrast 5.76:1, smoke separates, post keeps sky saturated, boss dark). Boards frozen to look/approved/. In-game t=150 capture (Docs/captures/latest/combat.png): dark ribbed hull + gate arches frame the corridor, banked craft reads, bullets pop. Calibration board built (naive / art-directed / planted defects); blind Reviewer running.

## 2026-09-30T12:25Z — P2 done: calibration passed; M1 fixes; threat retune
Blind Reviewer ranked art-directed > planted-defect > naive and found both planted defects (clipped craft, low-contrast label): calibration PASS. M1 look scored 6.17 (gate 7): fixed bullet stacking (fanned bursts), enemy readability (scale + contact markers), chroma restraint, title legibility. Probe found only 19 hostile bullets in 66 s and zero player hits: retuned darts/striders and player hitbox [A]; goldpath PASS (rank A, 7/7 mechanics). Lesson re-learned: pgrep/pkill -f patterns match the calling shell; use a [v]ite bracket pattern.

## 2026-09-30T09:32Z — Timestamp correction + kit frozen (P3)
CORRECTION: the three DEVLOG entries headed 10:05Z, 11:20Z and 12:25Z and DECISIONS entries headed 10:00Z-12:00Z were written with estimated times; git shows that work happened between 08:44Z and 09:26Z. Kept for the record (append-only); from now on every timestamp comes from `date -u` (CLAUDE.md rule). Red-team (Docs/KIT_REVIEW.md) fixes applied: goldpath asserts requested stage/mode and the game throws on unknown stages/modes (no false A10/A11 passes); DESIGN.md and STYLE_BIBLE.md gained "current values" tables; LANE_BRIEF camera 20/5; TASK rows A7/A8/A9/A10/A11/A13 made testable or marked tool-missing, A15 challenge row added; root CLAUDE.md pointer; session window file for the stop guard; state files updated. Kit frozen: harness/hooks/goldpath change only between milestones.

## 2026-09-30T12:01Z — First chunk wrapped (P5 checkpoint)
All P0 acceptance checks pass on the integrated build; goldpath passes for cloudgate, violetTide, wreckfield (boss), caravan and the gameover retry (0.82 s). Readability: Cloudgate 25.4 pass, Violet Tide 21.2 fail (T024). M2/M4 look gates plateaued at 6.67/6.50 (not passed, pending owner review). REPORT.md, final captures, timelapse written; tagged contrail-chunk1. Next: T039-T042 look defects, T037 balance, T024 sunset readability.
