# CONCEPT CARD (seed) — CONTRAIL (working title, placeholder)

Status: owner-approved starting point. GAME_FORGE Phase 0 promotes this to `Docs/CONCEPT_CARD.md`, verifies it against the references, and extends it. Do not ask questions; log any change in `Docs/DECISIONS.md`.

**One-liner:** a stylish arcade rail shooter where you pilot a lone prototype fighter through cloud seas, sunsets and wreck fields, chaining lock-on missile barrages, drift-sweeps and parry-rolls into huge combos, in an analogue-anime look.
**Genre:** arcade rail shooter / space-and-sky combat. **Camera:** third person chase behind the craft on a spline rail, aim reticle leads the craft. **Platform:** web (Three.js), keyboard + mouse and gamepad, later touch.

**Core loop (one paragraph):** the rail carries you forward at a steady speed; you steer inside a bounded window, hold fire on the cannon, sweep the reticle over targets to lock up to eight missiles and release to fire, kill enemies quickly to build a combo that refills your shield, dodge or parry incoming fire with a barrel roll, and spend recharging specials (drift, wingtrail) to clear swarms and hit boss weak points. Each stage ends with a bigger set piece; the results screen ranks score, best combo and shield left.

**The 60-second experience:** the title cuts to a hangar glimpse, then the craft launches into a bright cloud corridor. A swarm of red star-drones streams in; lock-on missiles paint two smoke ribbons across the sky; the first big explosion, a chromatic shock ring and a "combo" pop teach that speed and chaining are the game. A laser telegraph teaches the parry roll. By 60 s the player has fired a full missile barrage, rolled through a bullet, and watched the shield refill from a four-kill chain.
**The 10-minute experience:** three stages with contrasting light (cloud corridor, violet sunset over a cloud sea, dark wreck field), new enemy families each stage, a strider mini-boss, a capital-ship boss with beam volleys, a results rank, and a 2-minute score-attack mode that invites retries.

**Three signature moments:** (1) missile barrage with long curved smoke ribbons converging on a bracketed target; (2) the wingtrail spin that slows time and sends a chromatic ring through a swarm; (3) the capital boss filling the sky with rows of glowing vents and a wall of yellow beams.

**Scope tier:** Slice. P0 = one complete polished stage plus HUD, hero craft, core mechanics, results. P1 = stages 2-3, boss, caravan mode, hangar/livery screen, gamepad. P2 = roguelite mode, cockpit camera, extra weapon families, touch.

**Art direction that suits procedural generation (chosen):** *analogue-anime hard-surface*: angular low-poly craft with light armour panels, orange emissive inserts and panel-seam shader lines; painterly gradient skies with sprite-based cumulus; thick ribbon smoke; RGB-split, scanlines, grain and bloom post stack; a thin angular green perimeter HUD with an open centre. No photoreal faces: pilots are visored silhouettes or abstract portraits.
**Look keywords (Reviewer grades against these):** (1) *bright-to-dark drama* (2) *readable spectacle* (3) *thin-perimeter HUD, open centre*.

**Names (all original, replace freely):** craft KESTREL; enemy force the WARDEN swarm; drones = caltrops; bipedal mech = strider; capital boss = BULWARK; stages = Cloudgate, Violet Tide, Wreckfield.

**Out of scope (must not be built):** anime face renderer / voiced cutscenes; branching story paths and multiple endings; 40 weapons / 40 hulls / 100 liveries; online leaderboards and accounts; multiplayer; VR; console builds; licensed or downloaded assets; the reference game's title, logo, characters, story names, font, portrait art, music or exact HUD glyphs; save-game cloud sync; localisation beyond English; mobile-native packaging.

## Suggested acceptance rows (Spec Writer merges into TASK.md)
| ID | Pri | Requirement | Pass condition | Test |
|---|---|---|---|---|
| S1 | P0 | Stage 1 completes | goldpath: title -> launch -> clear Cloudgate -> results, exit 0 | `npm run goldpath` |
| S2 | P0 | Mechanics present | goldpath asserts: cannon, lock-on missile kill, roll parry, drift, wingtrail, combo shield refill each fired at least once | goldpath logs |
| S3 | P0 | Frame rate | >= 60 fps median at peak density on a real GPU (label software-GL results as relative) | `npm run perf` |
| S4 | P0 | Offline | 0 external requests; `Docs/refs/` never in build | `npm run netcheck` |
| S5 | P0 | Look match | Reviewer paired comparison vs owner refs by relationship; avg >= 7 on hero, sky, HUD | reviewer |
| S6 | P1 | Readability | at peak-density captures, hostile projectile median contrast (ID-mask, deltaE) >= 25 vs local background; Reviewer readability >= 7 | `npm run readability` + reviewer |
| S7 | P1 | Stages 2-3 + boss | goldpath clears all three stages and the boss | goldpath |
| S8 | P1 | Caravan mode | 120 s timed score attack with results | goldpath variant |
| S9 | P1 | Audio health | passes audiocheck; labelled pending owner review | `npm run audiocheck` |
| S10 | P2 | Roguelite one-life mode | one life, pickup upgrades, score | goldpath variant |
