# Reviewer — M2 look lock + M4 peak moment (re-gate)

Date: 2026-09-30. Fresh-context Reviewer. Judged from images only, against GAME_FORGE §12 and STYLE_BIBLE (starting from the "Current values" table). No author explanations were used.

**Images opened (all opened, none scored 0):**
- Captures in `Docs/captures/m2/`: cloudgate_combat, cloudgate_hero, cloudgate_hud, violetTide_combat, wreckfield_combat, contact.
- Motion/juice evidence: `Docs/progress/m2/20260930T111124Z_combat.png`, `20260930T111114Z_combat.png`; `Docs/progress/goldpath/20260930T110437Z_p25.png`, `_p50.png`, `20260930T105207Z_p75.png`.
- Boards in `look/approved/`: hero, hud, vfx-bullets, enemies, vfx-beam.
- Owner ref 07 (boss scale spectacle), compared by relationship only.

Note on the capture set: `cloudgate_hud.png` and `cloudgate_combat.png` are again the same moment. Both show SCORE 36380, ROUTE 85%, HULL 92/100 and the same bullet cluster on the reticle, and only the camera differs. The two m2 progress frames are byte-for-byte the same moments as violetTide_combat and wreckfield_combat. So there is one frame of evidence per stage, and no sequence to judge motion from.

---

## Gate M2 — look lock (hero, Cloudgate environment, HUD)

Evidence: cloudgate_hero, cloudgate_combat, cloudgate_hud, and goldpath 105207Z_p75 as a supporting Cloudgate frame.

| # | Axis | Score | Evidence |
|---|---|---|---|
| 1 | Board match | **7** | The hero still matches hero board B: steel/light livery, orange wing vents, blue canopy, fin-tip wings and ink outline (hero ≈ 730-1160, 490-620). The hull and arches match structures B, and the HUD matches hud board C cell for cell. The rounds now use the right disc style, but near-camera rounds render at about 150-200 px (≈ 14-18% of frame height, hud ≈ 540-740, 400-600), which is far outside the 2% core scale on vfx-bullets B. |
| 2 | Readability | **5** | The hero reads instantly against cream cloud. The strider is still hidden: about 20 overlapping rounds sit on the reticle (combat ≈ 790-1030, 420-630), so only a sliver of the dark shooter shows behind them (≈ 900,450). There are no lock brackets on it, and oversized near rounds cover the left third of the frame. |
| 3 | Lighting & colour | **7** | The palette is disciplined: sky.day blue, cream clouds with cool shadow sides, near-dark hull masses, and warm/cool splits on the hero. RGB triplets remain on the small hull lights (hero ≈ 1300-1850, 40-200), there is a colour fringe on the left arch edge (hero ≈ 0-120, 450-600), and the hull silhouette against the sky has almost no rim. |
| 4 | Depth & composition | **7** | The corridor reads strongly in hero and p75, with the dark hull on one side and arches receding in three steps. The cloud sea shows cast shadows, and there is more cumulus on the right horizon than last time (combat ≈ 1100-1900, 330-500). In combat, the hull wall and oversized rounds crowd the left 40% of the frame, and everything of interest stacks in one central column. |
| 6 | UI clarity & polish | **7** | The perimeter HUD is clean and legible over bright sky, the scrim works, and the duplicate "N CHAIN" popup is gone. Four problems remain: a "HULL -0" damage popup (combat ≈ 40-190, 200) reports zero damage, no lock brackets appear, the hazard stripe under CLOUDGATE is ambiguous (the only hazard visible is a thin red telegraph line), and the HUD capture repeats the combat moment instead of showing a distinct state. |
| 7 | Juice & finish | **5** | The build does have juice. Goldpath p75 shows a persistent smoke ribbon across the Cloudgate hull, and the red telegraph line is present in all three Cloudgate captures. But none of the three gate frames shows an explosion, a hit flash, cyan player fire, speed streaks or smoke, and the only feedback is the rounds and a "HULL -0" popup. |

**Average: 38 / 6 = 6.33. No axis is below 5, but the average is under 7. M2 fails.**

---

## Gate M4 — peak moment (wreckfield_combat, cloudgate_combat, violetTide_combat)

| # | Axis | Score | Evidence |
|---|---|---|---|
| 1 | Board match | **7** | wreckfield_combat matches enemies B's BULWARK: a dark broad wing, rows of warm edge lights and yellow emitter pods. The yellow planet rim-lights the asteroids, as on the Wreckfield board. violetTide matches its board, with an indigo sky, a narrow orange horizon, a white sun and a backlit warm hero. Rounds match the disc style of vfx-bullets B but are several times the board's scale. |
| 2 | Readability | **5** | The boss silhouette is cleaner than last time, with no asteroids crossing its centre, and its sliver now sits above the reticle. But Violet again shows no shooter at all (CONTACTS 00, TGT SCANNING) while a missile bursts, and in Cloudgate the strider is buried under its own fire. Hostile fire is not attributable to a source in two of the three frames. |
| 3 | Lighting & colour | **7** | Each stage has one key light: a high sun at Cloudgate, a low sun ahead at Violet, and the yellow planet at upper right in Wreckfield. The bright-to-dark swing across stages holds. The Violet cloud sea is still mid-value pink (lower third ≈ 30-45% luminance), brighter than the dark-sunset target, and the foreground asteroid in Wreck is lit as a flat tan plane with no value modelling. |
| 4 | Depth & composition | **6** | The boss is bigger (≈ 40% of frame width) and slightly pitched, which is better. But a huge flat foreground asteroid fills the left ~35% of the Wreck frame (≈ 0-760, 0-980) and pushes the action into a strip on the right. violetTide is an empty sea apart from the hero and one smoke trail. Nothing approaches the overhanging scale of ref 07. |
| 6 | UI clarity & polish | **6** | The boss sliver is off the reticle now, and TGT BULWARK/HP stays consistent. But five identical "HULL -3" popups stack at the top left of the Wreck frame (≈ 30-190, 140-340) and read as a log, not feedback. No frame shows lock brackets. Violet reads CONTACTS 00 while a target explodes 80 px from the reticle. |
| 7 | Juice & finish | **5** | This is the frame that improved most. violetTide shows the missile's persistent cream smoke ribbon, a hot burst and an RGB-edged ring (≈ 1000-1600, 440-800), and goldpath p25 proves that an explosion with orange lobes and the 3-band shock ring renders in Wreckfield. But the boss frame itself still has no beam or telegraph, no explosion, no hit flash and no smoke: only four oversized rounds. |

**Average: 36 / 6 = 6.00. No axis is below 5, but the average is under 7. M4 fails.**

---

## Paired comparison vs previous review (M2 6.33 / M4 6.00)

**The scores are the same as last time. The captures now meet the no-axis-below-5 floor (juice went from 4 to 5 in both gates), but neither gate reaches an average of 7.**

Improved:
- **Juice is now visible.** Missile smoke, a burst and a ring show in violetTide, and goldpath frames show an explosion, the 3-band RGB ring and long smoke ribbons. The missile counter is no longer stuck at 0 everywhere (Wreck shows 1/6).
- **The Cloudgate "coin columns" are gone.** Rounds render as separate discs with a white core and a dark ring.
- **The boss health sliver no longer sits on the reticle.** The boss is larger, pitched slightly and free of asteroids crossing its centre.
- **The duplicate "N CHAIN" popup is removed.** Cloudgate also has more cumulus on the horizon.

Unchanged or regressed:
- **Near-camera rounds have become oversized, which is a regression.** Rounds reach 150-200 px and swamp the Cloudgate frames, and the cluster on the reticle still hides the strider.
- **Lock brackets are still absent from every frame.** Violet still has no visible shooter.
- **Damage popups are new clutter, also a regression.** They include a "HULL -0" and a 5-deep "HULL -3" stack.
- **A big foreground asteroid now walls off the left third of the boss frame.**
- **Capture discipline is unchanged.** The HUD capture still duplicates the combat moment, and the boss capture misses the beam or explosion moment the build can clearly produce.
- **RGB residue remains on the hull lights and arch edges.**

---

## Top 5 defects (ranked by visual impact)

### D-1 — Boss peak frame still lacks beam/explosion; the build's juice misses the gate capture   [impact: high]
Capture: /home/user/RPG/contrail/Docs/captures/m2/wreckfield_combat.png (contrast: /home/user/RPG/contrail/Docs/progress/goldpath/20260930T110437Z_p25.png)
Expected: The peak frame should show the bible §5 effects at once. That means a boss beam per vfx-beam C (yellow telegraph, then a white core with a yellow/red halo), an explosion with a white-yellow core and orange lobes, the 3-band shock ring, and smoke. Ref 07 relationship: effects occupy a large share of the peak frame.
Actual: The only effects are four large rounds in a vertical line and the lit emitters. There is no telegraph, beam, hit flash, burst or smoke. Goldpath p25 shows that explosions, rings and smoke do render in Wreckfield, so the capture timing, the boss pattern or both are missing the moment.
Suggested fix: Script the M4 capture (`?det=1&t=`) to land during a BULWARK beam volley, with the telegraph plus one firing beam. Make sure a player missile salvo with smoke and at least one explosion plus ring from an escort or emitter falls in the same frame. Give the boss a 2-frame white hit flash on damage.
Owner lane: Integrator (capture script, boss pattern timing) + vfx (beam)

### D-2 — Near-camera hostile rounds oversized and clustered on the reticle   [impact: high]
Capture: /home/user/RPG/contrail/Docs/captures/m2/cloudgate_hud.png (also cloudgate_combat.png, cloudgate_hero.png, wreckfield_combat.png)
Expected: Per vfx-bullets B and "Current values", the core is at least 1.8-2.0% of frame height. The board's largest rounds at 20 m are about 5% of height, and rounds stay separable.
Actual: Rounds near the camera reach 150-200 px, about 14-18% of height (hud ≈ 540-740, 400-600; combat ≈ 20-190, 190-360). About 20 rounds overlap on the reticle (≈ 790-1030, 420-630) and hide the strider that fired them. In Wreck, rounds are about 130 px each.
Suggested fix: Clamp screen-space round size to a maximum of about 4-5% of frame height (enforce a floor and a ceiling in the billboard shader). Cull or fade rounds that have passed the craft or come closer than about 15 m. Add a lateral spread or time gap to streams aimed at the camera so rounds do not stack on the reticle.
Owner lane: vfx (bullets) + enemies (fire patterns)

### D-3 — No lock brackets anywhere; shooters invisible or unattributable   [impact: high]
Capture: /home/user/RPG/contrail/Docs/captures/m2/violetTide_combat.png (also cloudgate_combat.png, wreckfield_combat.png)
Expected: Per hud board C, every on-screen hostile carries red square-corner brackets plus a lock count and sliver. Per bible §4/§7, hostiles read at a glance.
Actual: None of the five captures shows brackets. Violet shows CONTACTS 00 / TGT SCANNING while a target explodes next to the reticle. The Cloudgate strider is buried behind rounds, and the boss and its emitters have no brackets.
Suggested fix: Draw passive brackets on every hostile in the frustum, and a separate style on destructible boss sub-parts. Add an edge-of-frame chevron for off-screen shooters. Keep CONTACTS counting the hostiles in the frustum until the last kill has resolved.
Owner lane: HUD + Integrator (target list wiring)

### D-4 — Damage popups: stacked "HULL -3" log and zero-value "HULL -0"   [impact: med]
Capture: /home/user/RPG/contrail/Docs/captures/m2/wreckfield_combat.png (also cloudgate_combat.png ≈ 40-190, 200)
Expected: Per hud board C, popups are short, distinct events ("6 CHAIN / SHIELD REFILL / PARRY +50") in the left mid area. Damage should feed back through the HULL bar, the portrait danger state and a screen hit cue.
Actual: Five identical "HULL -3" lines stack down to y ≈ 340 and read as a debug log. In Cloudgate, "HULL -0" is shown even though no damage was taken.
Suggested fix: Merge damage within about 0.5 s into one popup ("HULL -15"), suppress zero-value popups, cap the stack at 2, and add a brief red edge vignette or portrait flash as the main hit cue.
Owner lane: HUD

### D-5 — Boss frame composition: flat foreground asteroid walls off the left third   [impact: med]
Capture: /home/user/RPG/contrail/Docs/captures/m2/wreckfield_combat.png
Expected: Per bible §4/KEEP "big boss silhouettes" and the ref 07 relationship, the boss dominates, the camera looks up at it, and the foreground stays clear. Enemies board B shows BULWARK from below and behind.
Actual: An untextured tan asteroid plane fills about 0-760 x 0-980 px. The boss (≈ 710-1510, 190-420) is squeezed into the upper centre at about 40% of width, with a second slab crossing the top centre (≈ 950-1250, 0-150).
Suggested fix: Add an asteroid exclusion cone of at least 25° around the camera-to-boss axis during the boss phase, and within 40 m of the camera. Pitch the camera up 10-20° so the boss spans at least 60% of width. Give large near rocks value modelling (shadowed faces toward space.deep) so they do not read as flat cards.
Owner lane: structures (asteroid field) + Integrator (boss camera)

---

Other issues found, not in the top 5:
- The HUD capture duplicates the combat moment. Capture a hazard or danger-portrait state instead.
- RGB triplets remain on hull point lights, and there is fringing on the arch edges.
- The Violet cloud sea is mid-value, brighter than the dark-sunset target.
- No cyan player fire or speed streaks in any gate frame.
- The hazard stripe under the stage name is ambiguous when only a thin telegraph line is present.
