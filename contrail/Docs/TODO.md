# TODO — CONTRAIL

| ID | Pri | Lane | Description | Status |
|---|---|---|---|---|
| T001 | P0 | Director | Core skeleton: app, fixed clock, seeded RNG, input, debug API, stub scene | open |
| T002 | P0 | Spec | STYLE_BIBLE.md + src/style/tokens.ts (W2) | open |
| T003 | P0 | Spec | TASK.md + DESIGN.md (W4) | open |
| T004 | P0 | Reference Analyst | Verify every still, contact sheet and frame sequence; REF_VERIFICATION.md + PRINCIPLES.md (W1) | open |
| T005 | P0 | Harness | capture/contact/goldpath/perf/netcheck/refcheck/audiocheck/readability + checks.json (W5) | open |
| T006 | P0 | Lessons | PIPELINE_LESSONS.md (W6) | open |
| T007 | P0 | Director | CLAUDE.md, state files, KICKOFF.md, hooks (W7) | open |
| T008 | P0 | Audio | SFX recipes, generative music, mixer, offline render (W8) | open |
| T009 | P0 | Look-Dev | Lab boards A/B/C: hero, enemies, vistas, HUD, VFX, post (W3) | open |
| T010 | P1 | World | vista-wreck A: big near asteroid overlaps the planet (upper right); keep the planet disc clear of near debris | open |
| T011 | P0 | Director | Game camera far plane >= 1600 m for Wreckfield asteroids; verify sky renderOrder under the post stack's HDR target | open |
| T012 | P1 | VFX | vfx-smoke A over Cloudgate: trails merge with backdrop cumulus at 2.5-3.5 s; add slight cool shadow/contrast vs cloudCream | open |
| T013 | P1 | Director | HUD wiring: parry/refill combat text must use kind 'good' (green); only damage lines red | open |
| T014 | P1 | World | vista-cloudgate B: near-white cloud sea fills the lower ~40% and reads flat; add value variation / cool shadows in the near sea | open |
| T015 | P2 | World | Cloudgate sun inset horizon sparkle; sea diagonal streaks near frame bottom | open |
| T016 | P1 | Entities | enemies C: dart and strider read weakly on spaceDeep; raise marker intensity / rim wrap for Wreckfield | open |
| T017 | P1 | Entities | BULWARK reads bronze under Wreckfield key; boss must stay dark with rows of vents (M4) | open |
| T018 | P1 | Director | Debug API: add readabilityMasks() (frame + hostile-projectile mask PNGs, same camera) for npm run readability (S6) | open |
| T019 | P1 | Director | Wire setPost() once the post stack is integrated (capture --clean) | open |
| T020 | P2 | Director | palette board crops 2 of 5 spheres per cell; widen camera | open |
| T021 | P1 | Audio | laserFire has no cue; music loudness flat 0.6->1.0 (intensity = density only) - owner to judge | open |
| T022 | P1 | Director | lighting.ts rimTerm is additive: edge-on dark surfaces turn grey; scale rim by a clamp of albedo luminance or cap it | open |
| T023 | P1 | VFX | Bullets over the hot sunset horizon: p10 deltaE 20-26; boss telegraph line weak on bright sky | open |
