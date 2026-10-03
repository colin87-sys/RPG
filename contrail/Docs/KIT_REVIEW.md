# KIT_REVIEW — CONTRAIL (GAME_FORGE Phase 3 red-team)

Reviewer: fresh Red-Team agent, no prior context. Inputs: `CLAUDE.md`, `GAME_FORGE.md`, `IDEA_CARD.md`, `START_HERE.md`, `Docs/*`, `look/`, `tools/`, `src/debug/api.ts`, `package.json`, plus spot reads of `src/game/*`, `src/data/tuning.ts`, `src/style/tokens.ts`, `src/gen/vfx/{rings,explosions}.ts`, `.claude/`.
Evidence runs: `date -u` = 2026-09-30T09:27Z; `npm run refcheck` PASS (121 reference hashes, 32 dist files, 398 project files, 0 images, 0 copies); `git ls-files contrail | grep -i refs` shows only `tools/refs.manifest.json`, which holds hashes only. I did not rerun the goldpath: `checks.json` holds a pass from 09:25Z (cloudgate, 184 s, rank A, final shield 100). I found findings 1 and 2 by reading the code, not by running it.

Section 1 lists the findings, highest impact first. Each has a concrete fix. The Director decides whether to fix it now or accept it, and records that here.

---

## 1. Findings ranked by impact

### F1 — False-pass paths in the acceptance tests (A10, A11) [critical]
- `Game.loadStage()` (`src/game/game.ts:119`) does `STAGES[id] ?? STAGES.cloudgate`. `STAGES` only contains `cloudgate` (`src/game/stages.ts:101`).
- `goldpath.mjs` never checks that `state().stage` matches the requested stage. So `npm run goldpath -- --stage violetTide` and `--stage wreckfield` play Cloudgate and can **pass A10** without either stage existing. `perf --scene`, `capture --stage` and `readability --stage` fall back in the same silent way.
- `goldpath.mjs` has no `--mode` option, and `parseArgs` accepts unknown flags without an error. So `npm run goldpath -- --mode caravan` (TASK A11's test method) runs a Cloudgate campaign and can **pass A11**.
- A10 also says "incl. BULWARK phases 1-3", but goldpath asserts no boss phase.
- **Fix:**
  - Make `loadStage` throw on an unknown id.
  - Add `--mode` and `--difficulty` to goldpath, pass them to `start()`, and assert `state().stage === stage && state().mode === mode`.
  - Add `--require-boss-phases 3`, which asserts that the observed `state().boss.phase` reached 3 and `results.cleared`.
  - Make `parseArgs` reject unknown flags, with a per-tool allow-list.
  - Apply the same stage assertion in perf, capture and readability.

### F2 — Several acceptance rows are untestable as written [high]
| Row | Problem | Fix |
|---|---|---|
| A13 Fast retry | Goldpath treats `gameover` as a failure. No option drives the game-over path and times the restart. | Add `goldpath --expect gameover --retry`. It turns the bot off (or sets a zero-shield difficulty), waits for `gameover`, sends the retry input and asserts `state==='play'` within 120 steps (2 s). |
| A14 Roguelite | No mode, no API field, no tool. | Mark it "cut unless time" or specify `mode: 'roguelite'` in api.ts and goldpath. |
| A8 Budgets | Nothing measures bundle size, memory (400 MB), generated-texture total (48 MB, 1024²), or audio files in `dist/`. "1.5 MB gzip-free" is ambiguous; TASK §7 says "uncompressed". | Add an acceptance `bundle` step that sums `dist/**/*.js` bytes uncompressed and fails on audio or image extensions. Add `perf()` fields for `performance.memory` and texture bytes. Change the wording to "uncompressed". |
| A9 Readability | `__game.readabilityMasks` does not exist (T018), so A9 always returns exit 2 (n/a). The row says "every stage", but acceptance runs Cloudgate only. | Implement T018 before M3. Make acceptance loop the stages that exist. |
| A7 Look match | The row asks for a comparison "vs owner refs", but refs are local-only and missing in a fresh clone. The capture set (cams and t) is not named. | Name the captures: `capture --cams hero,vista,hud,combat --t 12,60,150`. Add "owner refs if present; otherwise approved boards only". |
| A1 | The row says "title -> launch", but goldpath calls `start()` directly, so the title input path is never exercised. | Add a goldpath pre-step that presses the start key on `state==='title'` instead of calling `start()`, at least in acceptance. |
| A3 | TASK says `--t 155`; acceptance and harness.md use `--t 150`. A real GPU is never available, so the row is permanently pending. | Pick t=155 everywhere. Add a software-GL pass condition (draw calls and triangles within budget, relative ms no worse than the last milestone +20%). |
| A12 | TASK marks it P1; `acceptance.mjs` runs audiocheck as P0. | Align both (keep P0 in the tool and change TASK, or the reverse). |
| A6 | OK: `checks.json errors.console` exists. | — |

### F3 — Logged timestamps are in the future and out of order [high]
- The real clock is `date -u` 09:27Z, and the last commit is 9cfc500 at 09:26Z.
- DEVLOG entries say 10:05Z, 11:20Z and 12:25Z.
- DECISIONS entries say 10:00Z, 10:40Z, 11:40Z and 12:00Z, and they sit before an 08:55Z entry.
- `look/selection.json` `frozen_utc` = 11:10Z.
- PLAN says "P1 done 11:10Z" and "P2 done 12:25Z".

The run rules depend on real time: hourly DEVLOG and STATS, the 45-minute stuck rule, the 20-minute revert rule, and timelapse order. A resuming agent cannot trust any of these entries. **Fix:** correct the entries from `git log --date=iso` (mark them "corrected"). Add a CLAUDE.md rule: "every timestamp comes from `date -u` run at that moment; never estimate".

### F4 — State files are not usable for resuming [high]
- `PLAN.md` "## Current" still says "P1: kit generation". `checks.json.milestone` reads that heading and reports `"P1"`.
- `TODO.md` shows T001-T009 as open, but all of that work is done. No M0/M1 tasks are queued.
- `STATS.json` was last updated at 04:55Z (commits 0, loc 0, perf 0); there are 35 commits.
- `INTEGRATION_QUEUE.md` shows every module as `ready`, though DEVLOG says all are wired. Its UTC column mixes dates and times.
- `checks.json.perf` (9 draw calls, 2.5k tris) and `acceptance` (08:38Z) are from the stub, taken before integration. There is no current perf number for the real game.

**Fix:**
- Set PLAN Current to "P3 kit red-team".
- Close T001-T009, and add M0/M1 gate tasks.
- Regenerate STATS.json (commits from git, LOC from `wc`).
- Mark queue rows `integrated <commit>`.
- Rerun `npm run acceptance` after the freeze.

### F5 — Milestone status is unclear [high]
TASK §6 gives M0 and M1 gates. Most of the M1 content is already built: lane modules are wired and goldpath passes with real visuals. A Reviewer has also scored "M1 look" at 6.17. No record says M0 or M1 passed its gate. The next agent could restart M0, or skip the M1 perf gate: "perf measured" never happened on the integrated game. **Fix:** in PLAN.md, record M0 as gate-passed with evidence, M1 as in progress with its missing items (perf on the integrated build, T026 re-review), and name the next gate.

### F6 — DESIGN.md, tuning.ts and DECISIONS.md disagree [high]
| Item | DESIGN.md (seed) | DECISIONS | Code |
|---|---|---|---|
| Chase camera | 9 m back, 2.6 m up | 20 m / 5 m | `T.camera` 20 / 5. `LANE_BRIEF.md` still says 9 m / 2.6 m. |
| Dart HP | 6 | 10 | `ENEMY_DEFS.dart.hp` 10 (in `enemies.ts`, not `tuning.ts`) |
| Strider fire | 5 orbs every 2.2 s | 7 orbs every 1.7 s | `enemies.ts:175` `fireT = 1.7`; the comment at line 168 still says 2.2 s |
| Hostile bullet minimum | 0.9% of frame height | 1.8% | tokens 0.018 |
| Explosion core growth | 3x | ~2x | tokens `growScale: 3`, used by `explosions.ts:258`. **The decision was never applied.** |
| BULWARK | 3 phases, 600/800/1000 HP | — | a single `hp: 2400` pool; no phase HP |
| Player hitbox | — | "retuned [A]" with no number | not in tuning |

Other problems:
- `tuning.ts` claims "every number from DESIGN.md lives here". In fact enemy HP, radii, values, contact damage, bullet speeds (60 and 45 m/s), burst counts and the 0.7 s/0.4 s laser timings are hard-coded in `src/game/enemies.ts`.
- **Fix:**
  - Add a "Current" column to DESIGN.md, or regenerate it from `T`, with a DECISIONS link per changed row.
  - Move `ENEMY_DEFS` and the fire patterns into `T.enemies`.
  - Apply or supersede the explosion 2x decision.
  - Fix the LANE_BRIEF camera line.

### F7 — STYLE_BIBLE.md and tokens.ts disagree [high]
- The tokens.ts header says "STYLE_BIBLE.md mirrors these values; the Reviewer checks that they match". The bible is still the seed text, and the Reviewer grades against it.

| Item | Bible | tokens.ts | Decision or code |
|---|---|---|---|
| HUD top band | ~6.5% | `bandTop 0.085` | 8.5% |
| Hostile bullet minimum | 0.9% | 1.8% | — |
| Shock ring thickness | 3% of radius | `thicknessFrac 0.03` | the decision says raise it toward 10-14%; `rings.ts` overrides with 0.042 / 0.036 (module-local constants bypass tokens) |
| Beam | — | core 0.6 m / halo 3 m (20%) | REF_VERIFICATION says the core dominates, about 65% |

- Missing from the bible: the HUD scrim (0.3), the ink outline (`shading.outline`), the Violet far fog `#5C2A55`, ~40 palette tokens (skyZenith, cloudShadow, enemy*, hostile*, hud*), and the three stage light rigs.
- **Fix:**
  - Regenerate bible §2 (palette table), §6 (HUD numbers) and §7 (readability numbers) from tokens.ts.
  - Add a small `tools/stylecheck.mjs`, or a Reviewer checklist line, that diffs the hex values and fractions.
  - Make `rings.ts` read its thickness from `vfx.shockRing`.

### F8 — Run-control hooks are inert in this session layout [medium-high]
- The hooks live in `contrail/.claude/settings.json`. They apply only when Claude Code starts inside `contrail/`, but this session's working directory is the repo root `/home/user/RPG`, which has no `.claude` or CLAUDE.md.
- `stop_guard.mjs` blocks only when `session_window.json` exists, and it does not exist. So "never end the run on your own" and "reread after compaction" have no enforcement.
- **Fix:** at the start of P4, write `contrail/.claude/session_window.json` with the run end time, and either add a root-level pointer (`/home/user/RPG/CLAUDE.md` saying "work in contrail/, read contrail/CLAUDE.md") or start sessions in `contrail/`. Record this in KICKOFF.md.

### F9 — Goldpath says nothing about challenge [medium-high]
- The bot finishes Cloudgate with shield 100 and rank A. The 12:00Z retune fixed the number of bullets, but not the risk to the player.
- The peak-density target (60-90 live hostile projectiles, 25-40 enemies) is never measured, although `state()` exposes `hostileProjectiles` and `enemiesAlive`.
- No gate covers difficulty. M5 says "difficulty tuning" with no number.
- **Fix:**
  - Log the peak `hostileProjectiles` and `enemiesAlive` in goldpath steps.
  - Add a P1 row: "bot takes >= 3 hits and ends with shield <= 85 on normal; peak live hostile projectiles >= 60 at t 140-170".
  - Report the min-shield curve.

### F10 — Reference privacy: clean today, check is narrow [medium]
What is in place:
- Git tracks nothing under `Docs/refs/`; only the hash manifest is tracked.
- `.gitignore` covers `/Docs/refs/` and `/private/`, and no `private/` folder exists.
- No source file references `Docs/refs`.
- I scanned every tracked `.md/.json/.ts` file for any ≥80-character line of ANALYSIS.md, owner_refs.md or SOURCES.md: 0 hits.
- refcheck passes.

Gaps:
- The check is **whole-file SHA-256 only**. A resized, cropped or re-encoded reference frame saved into `look/`, `Docs/progress/` or `Docs/captures/`, all of which are committed to a **public** repo, would pass.
- The text-excerpt check uses only the first 6 lines of each reference text file, and only inside `dist/`.
- `dist/` is not checked for audio file extensions.
- There is no pre-commit guard. The check scans the working tree, not `git ls-files`.

**Fix:**
- Add a perceptual hash (8x8 aHash or dHash of downscaled frames) of every reference image to the manifest, and compare it with every tracked PNG or JPEG.
- Check sampled lines from the whole of each reference text file against tracked `Docs/`.
- Add `.wav/.mp3/.ogg/.flac/.m4a` to the dist ban list.
- Add a `refcheck --tracked` mode, and run it before every push (CLAUDE.md §3).

### F11 — Only one stage exists, and P1 is large [medium]
- `STAGES = { cloudgate }`. Violet Tide, Wreckfield, the BULWARK encounter, Caravan, pickups UI, the upgrade chip, settings and gamepad have no scripts or specs beyond one DESIGN line each.
- The DESIGN pacing template says "adapt for others" but gives no per-stage enemy mix, length or hazard. New enemy families per stage (TASK §2) are not named.
- **Fix:**
  - Add a DESIGN.md stage table: Violet Tide = snipers-heavy with horizon glare, a strider pair and ~160 s; Wreckfield = debris hazards, all families plus BULWARK, ~240 s.
  - Add a BULWARK phase script (phase HP, patterns, recovery windows, weak points).
  - Add Caravan rules (spawn loop, x1.4 density, timer).

### F12 — Read order and gates have gaps [medium]
- Every file in the CLAUDE.md read order exists. `Docs/refs/owner/` is present locally and correctly marked optional.
- Missing from the read order:
  - `Docs/TASK.md` §4/§6 (the gates);
  - `Docs/DECISIONS.md` (the only place that says which DESIGN numbers are stale);
  - `Docs/harness.md`;
  - `Docs/PIPELINE_LESSONS.md`;
  - `Docs/INTEGRATION_QUEUE.md`.
- Gates without a test:
  - M3 "pickups, upgrade chip, settings" has no acceptance row;
  - M4 "peak captures" names no camera or time. There is no boss story camera, and `setTime` cannot target a boss phase;
  - M5 "onboarding, mix, difficulty" has no pass condition.
- GAME_FORGE expects `Docs/reviews/calibration.md`; the file is `calibration_and_M1.md`.
- **Fix:**
  - Add DECISIONS (last 10 entries) and TASK §4/§6 to read-order step 2.
  - Add rows A15 (settings persist, verified via api), A16 (upgrade chip shows on stage start, verified by a capture) and A17 (peak capture set: `capture --cams combat,boss --t <boss phase 3>`).
  - Add a `boss` story camera and `setTime` targets for boss phases.

### F13 — Smaller ambiguities [low]
- The `perf` pass status is "pass (budgets)" while fps is 5. State the software-GL pass rule in TASK.
- `setTime()` uses the bot plus invulnerability while it fast-forwards. A perf or capture at t=150 therefore shows a world the player may never reach in that state (shield 100, a different kill set). Document this in harness.md.
- DESIGN "Rank par" is undefined: `StageDef.par` has no derivation rule.
- DESIGN says "log every change in DESIGN.md", but DESIGN.md is never updated. Pick one: DECISIONS plus a Current column.
- TODO T021: music intensity is density-only and flat. No audio gate exists beyond numeric health.
- IDEA_CARD names the reference game ("ROGUE FLIGHT"). That is fine for intent, but make sure no string from IDEA_CARD reaches the UI. refcheck does not look for the title string. Add a grep of `dist/` for the reference title, case-insensitive.

---

## 2. Ten most likely failure modes of the autonomous run (ranked)
1. **False-green P1:** unknown stages and modes fall back to Cloudgate, so goldpath "passes" A10 and A11, and the agent reports stages 2-3, the boss and Caravan as agent-verified when they are not built.
2. **Number reversion:** agents and lanes tune from DESIGN.md or LANE_BRIEF (9 m camera, dart HP 6, 2.2 s strider) and silently undo logged decisions. Two sources of truth drift further apart.
3. **Reviewer grades against the wrong spec:** the bible (6.5% band, 0.9% bullet, 3% ring) disagrees with the tokens, so correct work is flagged as a defect, or the agent "fixes" the tokens back. Scores stay around 6.2-6.4 below the gate and the run churns.
4. **State rot on resume:** future timestamps, PLAN stuck on P1, open T001-T009 and a zero STATS file make a resumed agent redo kit work, misjudge the cadence, or break the 45-minute and 20-minute rules.
5. **Toothless game:** the bot clears with full shield, and no difficulty or density gate exists, so the build ships spectacle with no tension. "Readable" is achieved by being empty rather than by contrast under 60-90 bullets.
6. **Perf surprise late:** perf numbers are from the stub (9 draw calls), fps is SwiftShader-relative, and only Cloudgate t=150 is measured. BULWARK (460 instanced vents, beams) and Wreckfield debris can blow the 250-call or 450k budget at M4 or M5, when refactors are expensive.
7. **Three stages that look like one:** there is a single StageDef with the same rail wander and the same enemy script. Violet Tide and Wreckfield turn into palette swaps, and the "10-minute" experience and the signature moments feel repetitive.
8. **Readability never measured:** T018 stays open, so A9 remains n/a forever. The differentiator the concept is built on is judged only by eye. Orange-on-sunset bullets (T023, T024) ship.
9. **Module-local constants drift from the approved boards:** `rings.ts` thickness, enemy draw scale 1.7x/1.3x and the Director's inline M1 fixes bypass tokens. In-game frames stop matching `look/approved/`, which were frozen before those fixes, and the M2 "matches board" gate becomes contradictory.
10. **Run control or privacy slip:** hooks are inert at the repo root, so the agent stops early, or API limits kill lanes mid-module without partial commits. Or a lane saves a side-by-side or cropped reference frame into `look/` or `Docs/progress/`: the hash-only refcheck passes, and the frame is pushed to the **public** repo.

---

## 3. Quick wins (≤ 15 min each)
1. `game.ts:119`: throw on an unknown stage. In goldpath, assert `state().stage` and add `--mode`. (Closes F1 false passes.)
2. Correct the future timestamps from `git log`. Add the "timestamps only from `date -u`" rule to CLAUDE.md §3.
3. PLAN Current → P3; close T001-T009; regenerate STATS.json; mark queue rows integrated.
4. Change `vfx.explosion.growScale` to 2 (per decision) or supersede the decision. Change `rings.ts` to read `vfx.shockRing.thicknessFrac`. Raise that value per the decision (0.10-0.14) or log a supersede.
5. STYLE_BIBLE: HUD band 8.5%, bullet 1.8%, scrim 0.3, outline, Violet fog. Replace the §2 table with a pointer to tokens.ts plus the diff list.
6. DESIGN.md: add "Current" values for camera, dart HP, strider fire, bullet size and explosion. LANE_BRIEF: camera 20 m / 5 m.
7. TASK: A3 t=155 matching acceptance (or 150 everywhere); A12 priority aligned with acceptance; "uncompressed" in A8; A7 capture list.
8. CLAUDE.md read order: add DECISIONS (last 10) and TASK §4/§6.
9. refcheck: add audio extensions to the dist ban; add a case-insensitive `dist/` grep for the reference game's title.
10. Write `contrail/.claude/session_window.json` at P4 start, and add a root `/home/user/RPG/CLAUDE.md` pointer to `contrail/CLAUDE.md`.
11. Rerun `npm run acceptance` and `npm run perf -- --t 155` on the integrated build, so `checks.json` stops reporting stub numbers.

---
## Director response (2026-09-30T09:40Z)
| # | Finding | Resolution |
|---|---|---|
| 1 | A10/A11 false passes | **Fixed:** game throws on unknown stage/mode; goldpath asserts stage and mode (`--mode`) |
| 2 | A7/A8/A9/A13/A14 untestable | **Fixed/marked:** A7 names its capture command, A8 concrete commands, A9 notes T018, A13 tool T030, A14 mode missing |
| 3 | Timestamps ahead of the clock | **Fixed:** correction entries in DEVLOG/DECISIONS; CLAUDE.md rule "every timestamp from date -u" |
| 4 | Stale state files | **Fixed:** PLAN, TODO, STATS, checks.json refreshed; acceptance re-run on the integrated build (all P0 pass) |
| 5 | M0/M1 gate status unrecorded | **Fixed:** PLAN milestone table |
| 6 | DESIGN disagrees with code | **Fixed:** current-values table; T031 moves ENEMY_DEFS into tuning.ts |
| 7 | STYLE_BIBLE is seed text | **Fixed:** current-values table + winners list; tokens remain the authority |
| 8 | Hooks inert | **Fixed:** session_window.json created; root CLAUDE.md pointer. Hooks still only load when Claude Code starts in contrail/ (accepted) |
| 9 | No difficulty gate | **Fixed:** A15 challenge row; tuning T027 |
| 10 | refcheck exact-hash only | **Accepted for now:** T029 (perceptual hash, pre-push). Mitigation: lanes never write reference pixels outside private/ |
| 11 | Only Cloudgate specified | **Accepted:** M3/M4 tasks T032-T034 |
| 12 | Read order / A3 / A12 mismatches | **Fixed:** read order adds TASK + DECISIONS; perf t aligned to 150 |
Also found and fixed during the re-run: perf counted only the last post pass (renderer.info autoReset); now whole-frame counts (35 draw calls, 63.5k triangles at t=150).
