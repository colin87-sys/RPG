# DECISIONS — CONTRAIL

Format: `## <UTC> — <decision>`, options considered, reason. Newest at the bottom. Never delete entries; supersede them.

## 2026-09-30T04:48Z — Project lives in `contrail/`, a self-contained sub-project of the RPG repo
Options: (a) new nested `git init` repo in a subfolder; (b) new private GitHub repo added as a git submodule; (c) a self-contained folder inside the existing session repo.
Reason: the owner asked for "a new subrepository" inside the session repo `colin87-sys/RPG`. A nested `.git` would not be pushed with the parent, and a new GitHub repo is outside this session's repository scope. (c) keeps every commit pushed to the session branch. The folder is self-contained (own `package.json`, `CLAUDE.md`, `.claude/`), so it can be split into its own repo later with `git subtree split --prefix contrail`.

## 2026-09-30T04:48Z — The third-party reference pack (`Docs/refs/`) is local-only and never committed
Options: commit it (as the kit assumes, private repo); keep it untracked.
Reason: `colin87-sys/RPG` is a **public** repository (checked via the GitHub API at 04:45Z). The kit says the reference stills and clips are copyrighted, must never appear in any published repo, and the repo must never be public. So `/Docs/refs/` is in `.gitignore`. Consequences and mitigations:
- The owner can restore the pack in any new session by unzipping `contrail-kit.zip` into `contrail/` (only `Docs/refs/` is needed).
- `npm run refcheck` uses a committed hash manifest (`tools/refs.manifest.json`, SHA-256 of every reference file, no content), so the "no reference file in the build" check works even in a clone without the pack.
- Our own derived writing (verification notes, principles) lives in committed files **outside** `Docs/refs/`: `Docs/REF_VERIFICATION.md` and `Docs/PRINCIPLES.md` (GAME_FORGE W1 names `Docs/refs/PRINCIPLES.md`; path moved for the reason above).
- Side-by-side comparison images that embed reference pixels go to `private/` (gitignored), never to `Docs/`, `look/` or `lab/`.

## 2026-09-30T04:48Z — Commit and push to the session branch after every commit
Options: GAME_FORGE section 1 says "no pushes to remotes"; START_HERE (cloud section) says push after every commit because the VM is disposable.
Reason: this run is in a disposable cloud container. The owner's START_HERE cloud instructions win. Pushes go only to `claude/lucid-lamport-2w8mqp` of `colin87-sys/RPG`; nothing else is posted.

## 2026-09-30T04:48Z — Seed pack accepted as Phase 0 / W1 groundwork (GAME_FORGE 4.6)
`IDEA_CARD.md` is the idea card. `Docs/seed/*` copied to `Docs/CONCEPT_CARD.md`, `Docs/DESIGN.md`, `Docs/STYLE_BIBLE.md` for extension. The reference pack is verified and extended by a fresh Reference Analyst agent, not rewritten.

## 2026-09-30T04:48Z — Engine and toolchain
- Engine: Web + Three.js (npm `three@0.186`) + Vite 8, TypeScript 7 (`tsc --noEmit` for type checks; Vite strips types). Reason: GAME_FORGE default; IDEA_CARD names web-threejs.
- Test browser: Playwright `1.56.1` pinned exactly, because the container ships its matching Chromium build (`/opt/pw-browsers/chromium-1194`, Chromium 141). A caret range would pull a newer Playwright whose browser is not installed.
- No runtime dependencies other than `three`. Post-processing, HUD, font, audio are written in-house (no CDN, no web fonts, no samples).

## 2026-09-30T04:48Z — Run length and scope
Run length 24h per IDEA_CARD (worked in chunks; state files make it resumable). Scope tier: Slice (P0 = Cloudgate stage complete and polished, P1 = Violet Tide, Wreckfield, BULWARK boss, Caravan mode, gamepad, hangar/livery; P2 = roguelite, cockpit camera, touch).

## 2026-09-30T04:48Z — Rendering is software GL in this container
Headless Chromium gives WebGL2 through ANGLE + SwiftShader (Vulkan). It is fine for captures. fps measured here is **relative frame time, not real fps**; every perf number from this container is labelled `software-GL relative`. A real-GPU measurement is `pending owner review`.

## 2026-09-30T05:50Z — Chase camera 20 m behind / 5 m above (seed said 9 m / 2.6 m)
First stub capture at 9 m: the 9 m-span craft filled ~75% of the frame width. Owner stills show the craft at ~15-20% of width with FOV 68, which implies ~20 m. Seed value was tagged [A]. Tune again in M2 with the real craft.

## 2026-09-30T05:50Z — Agent lanes interrupted by an API session limit, resumed
All 9 background agents stopped at ~05:05Z on an API session limit; the owner asked to try again at ~05:36Z and every lane was resumed from its transcript. Director work (core, simulation, stub) continued inline and was committed.

## 2026-09-30T06:10Z — Reference verification merged (full detail: Docs/REF_VERIFICATION.md, 12 correction entries)
Adopted:
- HUD top band 8.5% (was 6.5%), bottom 9% confirmed; bands get a dark scrim (~30% black). Tokens updated.
- Hostile bullet minimum core size 1.8% of frame height at 60 m (was 0.9%, which would be smaller than the reference); halo ~3.5%.
- Beam: white core dominates (~65% of width), thin warm edge, red halo.
- Explosion core grows ~2x in 0.3 s (was 3x), tagged [O].
- Craft proportions: fins inboard (~55% of half-span), not wingtips; craft size re-evaluated in the lab.
Deliberately kept different (original design, tagged [A]):
- HUD colours keep our tokens (#2CA72F lines, #75E845 text, near-white values) rather than the reference's pure #00B809/#02FC03 greens, so the HUD is not a copy.
- Hazard state keeps diagonal yellow/black stripes plus banner (reference uses blinking solid rails). Stripes add a shape cue beyond colour.
- Shock rings keep a visible growth (30->65% width) instead of popping at full size, but band thickness is raised toward ~10-14% of radius.
- Hostile bullets keep the thin dark outline ring (readability upgrade; reference has none).

## 2026-09-30T08:36Z — Shared fog base height -70 m (was -40)
Sky lane found -40 m sat inside the cloud-sea range and tinted the Violet Tide sea mauve. Height fog now starts below the sea tops.

## 2026-09-30T10:00Z — Hooks live in contrail/.claude/ and never block without an explicit session window
Stop guard blocks only while `contrail/.claude/session_window.json` names a future `until` and no ALLOW_STOP exists. Without the window file it allows stopping, so a cloud session opened at the repo root is never trapped. Hooks apply when Claude Code is started inside `contrail/`.

## 2026-09-30T10:40Z — W3 Reviewer ranking adopted (Docs/reviews/W3_lookdev.md, look/selection.json)
Winners: hero B, enemies B, vista-cloudgate C, vista-violet C, vista-wreck C, structures B, hud/hud-states/screens C, post A, rings A, beams C, bullets B, smoke B, explosion A. Winning set scored 6.4 avg (gate 7): consistency pass dispatched to lanes for D-1 (Violet Tide too bright/mauve), D-2 (hull too light), D-3 (dark enemies vanish on space), D-4 (flat pale Cloudgate sea), D-5 (HUD bands over bright sky), boss salmon, smoke vs clouds.

## 2026-09-30T08:55Z — Violet Tide far fog #C0567E -> #5C2A55
D-1 consistency pass: the bright pink far fog produced a pink strip under the horizon; darker plum keeps the sunset dark (median luminance target < 6%).

## 2026-09-30T11:40Z — M1 look fixes after calibration review (Docs/reviews/calibration_and_M1.md, 6.17 avg)
Calibration PASSED: blind Reviewer ranked art-directed > planted-defect > naive and found both planted defects. M1 fixes (Director): dart bursts fan laterally (bullets no longer stack into "coins"); caltrop/dart drawn at 1.7x/1.3x with hit radii 1.8/3.0 m for readability; faint contact markers on every enemy within 240 m (HUD, small UI edit by the Integrator); chroma pulses only on big kills/parry/hits and smaller; dotted exhaust contrail removed; title uses its drawn backdrop.

## 2026-09-30T12:00Z — Threat tuning [A]: darts HP 6 -> 10, approach fire, strider 7-orb spread every 1.7 s (was 5 / 2.2 s), aimed shots lead 50-80%
Probe: only 19 hostile bullets in 66 s and zero player hits over a full run (shield 100 throughout), far below the DESIGN peak target of 60-90 live projectiles. The 14/s cannon killed darts before their first burst. Numbers were [A]; tuned toward the design's density target.

## 2026-09-30T09:32Z — Timestamp correction
DECISIONS entries headed 2026-09-30T10:00Z, 10:40Z, 11:40Z and 12:00Z were estimated; real times were ~08:44Z-09:26Z (see git log). Content stands. All timestamps now come from `date -u`.

## 2026-09-30T09:32Z — Kit frozen after red-team (Docs/KIT_REVIEW.md)
Fixed: stage/mode false passes, stale DESIGN/STYLE_BIBLE (current-value tables), testability of A7-A13, A15 challenge row, root CLAUDE.md, stop-guard window. Accepted for later: perceptual-hash refcheck and pre-push hook (T029), specs for stages 2-3/boss/Caravan (M3/M4), readability API (T018), gameover driver (T030).

## 2026-09-30T10:02Z — Gameplay lane: tuning single source, Violet Tide, Wreckfield, BULWARK, Caravan, difficulty (T027/T031-T034)
- T031: ENEMY_DEFS and every behaviour number now live in `src/data/tuning.ts` (`T.enemies`, `T.behaviour`, `T.laser`, `T.caravan`); `enemies.ts` re-exports `ENEMY_DEFS = T.enemies`.
- BULWARK hull radius 60 -> 28 m (core sphere) so shots can reach the weak points, which sit outside it. Options: keep one 60 m sphere (weak points unreachable) / per-part hulls (no view data yet). Chose the core sphere + 3 weak-point spheres (r 6 m, x5 damage).
- BULWARK HP kept at DESIGN 600/800/1000 (2400); weak-point multiplier tuned 4 -> 6 -> 5 so the bot's fight lasts ~60 s and Wreckfield ends ~185-190 s. The wingtrail ring cannot physically reach a boss 195 m away, so it deals DESIGN's 30 weak-point damage once per ring when it reaches full size [A].
- Boss escape: reaching the rail end (250 s nominal) with BULWARK alive ends the stage with `cleared: false` (rank C, "BULWARK ESCAPED"). Options: clear anyway / loop the rail. Chose fail so A10 cannot pass without the kill.
- Drone waves only in phase 2: in phase 3 they fed combo refills that erased all boss damage.
- T027 [A]: combo refill (+5/s, [R]) plus parry +3 kept the bot at shield 100 whatever it took. Changed: bullet damage 6 -> 8, parry shield 3 -> 1, dart bursts 3 -> 4 every 1.3 s at 50 m/s with a lead bracket, strider 2 staggered rows of 7 every 1.5 s, strider sweeps staggered per squad index (3 synced sweeps stacked 44 damage), Cloudgate finale gets a walker at 145 s, a rearguard trio at 162 s and a sniper crossfire at 167 s (few kills late = damage sticks). Tried and rejected: shorter combo window (1.0-1.6 s; little effect, hurts the combo feel), removing the late chain (more dart kills refilled instead).
- Bot [A]: parry miss 30% -> 40%, beam reaction delay 0.22-0.52 s (seeded), beam dodge by clearance search over the window (handles sweeps and the boss wall), weak-point targeting with sway lead.
- Caravan: stage forced to Cloudgate; timer is real play time (120 s) so drift does not stretch it; wave list re-timed x1.4 = the density factor; no shield pickups, parries give no shield.
- Title confirm now starts `mode: 'campaign'` explicitly so a previous Caravan run does not leak into the campaign.

## 2026-09-30T10:23Z — Quick retry: 0.8 s relaunch after game over (title launch stays 2.5 s)
A13 measured 2.53 s confirm->play with the full launch; now 0.82 s simulated (1.58 s from key press incl. the 0.8 s anti-mash lockout). forceGameOver() added to the debug API for the harness.

## 2026-09-30T10:47Z — Capture fix: setTime() clears effects spawned during the unrendered skip, then steps 1 s live
Explosions/smoke spawned while fast-forwarding never aged (no render updates), so every capture at t>0 showed a pile-up of a whole minute of fireballs. Earlier M1 review captures were affected. Campaign now advances cloudgate -> violetTide -> wreckfield after a clear; stage cards use each stage's subtitle; BULWARK weak points get HUD markers; results say TARGET ESCAPED on a boss escape.

## 2026-09-30T11:10Z — Juice/readability fixes after M2/M4 review (Docs/reviews/M2_M4.md, 6.33 / 6.00)
Missile regen 12 s -> 4 s [A] (barrages were rare: 0/6 ammo in every frame; Cloudgate goldpath now 41 missile volleys); strider volleys fire as a serpentine stream (0.045 s per orb) instead of all at once (no on-screen 'coin' columns); BULWARK holds at u 150 (was 195) and 130 in phase 3 for scale; chroma base 0.0015 -> 0.001; play-speed streaks 0.45 -> 0.62; captures step 2.5 s of live effects after a skip.

## 2026-09-30T11:20Z — Round-3 fixes: Wreckfield rail kept near the debris corridor (wander 5/3 m), Violet 35/10, Cloudgate 60/18; rounds past the craft shrink and fade; hull damage lines accumulate; combat story camera advances up to 3 s to the next beam firing or strider kill (peak-moment capture)

## 2026-09-30T11:27Z — Strider volley one row of 9 (was 2 rows of 7) so fire does not wall off the shooter; combat camera stops on a firing beam or >= 3 locks
Cloudgate goldpath after the change: rank A, shield 56 (A15 challenge still met).

## 2026-09-30T11:29Z — Round-5: chroma hit/ring 0.006/0.008 -> 0.003/0.004 (fringing too heavy in hero shots); Violet Tide sea lit mix 0.3 -> 0.16, backlit 0.5 -> 0.3, fog #5E3A74 -> #3E2656 (dark-sunset rule)

## 2026-09-30T11:35Z — Strider fires from arm guns (+/-5.5 m) so its stream no longer covers its body; combat camera on a boss stage waits (up to 6 s) for a firing boss beam

## 2026-09-30T11:37Z — M2/M4 gates: plateau at 6.5-6.7 after six review rounds; recorded as NOT PASSED, pending owner review
Rounds (Docs/reviews/): W3 6.4; M1 6.17; M2/M4 r1 6.33/6.00, r2 6.33/6.00, r3 6.50/6.50, r4 6.50/6.50, r5 6.67/6.50, r6 6.67/6.50. No axis below 5 since r2. Fixes that moved scores: effects pile-up bug, missile regen, bullet fade, chroma restraint, boss framing, peak-moment camera. Remaining carried-over defects (T039-T042): Cloudgate strider still partly buried by its stream, no lock-bracket language in captures, Cloudgate hero frame shows the flat sea (hull section), boss volley reads as a rigid wall. Per CLAUDE.md 45-minute rule: logged, queued, moving to wrap-up (P5) so the owner can judge the build; the gate stays open.
