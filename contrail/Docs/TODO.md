# TODO — CONTRAIL

| ID | Pri | Lane | Description | Status |
|---|---|---|---|---|
| T001 | P0 | Director | Core skeleton: app, fixed clock, seeded RNG, input, debug API, stub scene | done |
| T002 | P0 | Spec | STYLE_BIBLE.md + src/style/tokens.ts (W2) | done |
| T003 | P0 | Spec | TASK.md + DESIGN.md (W4) | done |
| T004 | P0 | Reference Analyst | Verify every still, contact sheet and frame sequence; REF_VERIFICATION.md + PRINCIPLES.md (W1) | done |
| T005 | P0 | Harness | capture/contact/goldpath/perf/netcheck/refcheck/audiocheck/readability + checks.json (W5) | done |
| T006 | P0 | Lessons | PIPELINE_LESSONS.md (W6) | done |
| T007 | P0 | Director | CLAUDE.md, state files, KICKOFF.md, hooks (W7) | done |
| T008 | P0 | Audio | SFX recipes, generative music, mixer, offline render (W8) | done |
| T009 | P0 | Look-Dev | Lab boards A/B/C: hero, enemies, vistas, HUD, VFX, post (W3) | done |
| T010 | P1 | World | vista-wreck A: big near asteroid overlaps the planet (upper right); keep the planet disc clear of near debris | done |
| T011 | P0 | Director | Game camera far plane >= 1600 m for Wreckfield asteroids; verify sky renderOrder under the post stack's HDR target | done |
| T012 | P1 | VFX | vfx-smoke A over Cloudgate: trails merge with backdrop cumulus at 2.5-3.5 s; add slight cool shadow/contrast vs cloudCream | open |
| T013 | P1 | Director | HUD wiring: parry/refill combat text must use kind 'good' (green); only damage lines red | done |
| T014 | P1 | World | vista-cloudgate B: near-white cloud sea fills the lower ~40% and reads flat; add value variation / cool shadows in the near sea | done |
| T015 | P2 | World | Cloudgate sun inset horizon sparkle; sea diagonal streaks near frame bottom | open |
| T016 | P1 | Entities | enemies C: dart and strider read weakly on spaceDeep; raise marker intensity / rim wrap for Wreckfield | open |
| T017 | P1 | Entities | BULWARK reads bronze under Wreckfield key; boss must stay dark with rows of vents (M4) | open |
| T018 | P1 | Director | Debug API: add readabilityMasks() (frame + hostile-projectile mask PNGs, same camera) for npm run readability (S6) | done |
| T019 | P1 | Director | Wire setPost() once the post stack is integrated (capture --clean) | open |
| T020 | P2 | Director | palette board crops 2 of 5 spheres per cell; widen camera | done |
| T021 | P1 | Audio | laserFire has no cue; music loudness flat 0.6->1.0 (intensity = density only) - owner to judge | open |
| T022 | P1 | Director | lighting.ts rimTerm is additive: edge-on dark surfaces turn grey; scale rim by a clamp of albedo luminance or cap it | open |
| T023 | P1 | VFX | Bullets over the hot sunset horizon: p10 deltaE 20-26; boss telegraph line weak on bright sky | open |
| T024 | P1 | VFX | Sunset horizon: bullets B p10 deltaE 21 (<25) orange-on-orange; consider cooler halo only in violetTide | open |
| T025 | P1 | Entities | D-3 residual: dart/strider dim on spaceDeep; judge in-game with bloom, else add Wreckfield marker boost | open |
| T026 | P1 | Director | Re-review M1 look after fixes (enemy readability, bullets, chroma, smoke, title) | open |
| T027 | P1 | Director | Difficulty: bot takes ~1 hit per minute; tune toward DESIGN peak 60-90 live hostile projectiles, meaningful shield loss (M5) | open |
| T028 | P0 | Director | Re-run npm run acceptance + perf --t 150 on the integrated build; update STATS.json | done |
| T029 | P1 | Harness | refcheck: perceptual hash for resized/cropped reference frames; audio files banned in dist; run before push | open |
| T030 | P1 | Harness | goldpath --gameover: force shield 0, confirm retry, measure time to flying (A13) | open |
| T031 | P1 | Director | Move ENEMY_DEFS and behaviour numbers into src/data/tuning.ts (single source) | open |
| T032 | P1 | Director | Specify + build Violet Tide and Wreckfield stage scripts, new enemy mixes (M3) | open |
| T033 | P1 | Director | BULWARK boss phases 1-3 script + goldpath (M4) | open |
| T034 | P1 | Director | Caravan mode (120 s) (A11) | open |
| T035 | P1 | VFX/Director | Readability cloudgate t=150: dE00 median 25.3 (barely passes), p10 20.7; low cases are overlapping bullet clusters; raise contrast margin | open |
