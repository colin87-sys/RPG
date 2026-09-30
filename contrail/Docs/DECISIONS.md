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
