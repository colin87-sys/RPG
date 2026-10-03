# Reviewer — M2 look lock + M4 peak moment (round 3)

Fresh-context review. It is based only on images, the GAME_FORGE section 12 rubric and STYLE_BIBLE "Current values".

**Inputs opened:**
- **Captures (m2):** cloudgate_hero, cloudgate_combat, cloudgate_hud, violetTide_combat, wreckfield_combat, contact.
- **Progress frames:** m2/20260930T112002Z_combat (identical to the wreckfield capture), m2/20260930T111124Z_combat (previous-round boss frame), goldpath/20260930T111442Z_p25 and _p50.
- **Approved boards:** vista-cloudgate, vista-violet, vista-wreck, hero, hud, enemies, structures, vfx-bullets, vfx-beam.
- **Owner reference 07:** compared by relationship only.

All images opened, so no zero scores. Axis 5 (motion) and axis 8 (technical) are outside these gates.

---

## Gate M2 — look lock (Cloudgate hero, environment, HUD)

| # | Axis | Score | Evidence |
|---|---|---|---|
| 1 | Board match | **7** | The hero matches hero B (steel/light livery, orange vents and nose band, blue canopy, fin tips, ink outline; hero ≈ 725-1160, 490-615), the hull and arches match structures B, and the HUD matches hud C cell for cell. The Cloudgate sky, however, is still a flat cloud sea with no cumulus towers in the hero frame, far from vista-cloudgate C's dense corridor. |
| 2 | Readability | **5** | The hero reads instantly. But in cloudgate_combat about 25 overlapping rounds pile onto the reticle (≈ 715-1115, 440-660), so the STRIDER named in TGT is not visible at all, and no target carries the red corner brackets shown on the hud board. |
| 3 | Lighting & colour | **7** | The palette is disciplined: sky.day blue, cream cloud with cool cast shadows, a near-black hull, and a warm/cool split on the hero. The hull silhouette against the sky still has no rim (combat ≈ 400-560, 100-900), and the RGB triplets on the hull lights persist (hero ≈ 1150-1900, 0-250). |
| 4 | Depth & composition | **7** | The hero frame is the strongest Cloudgate image so far: the hull wall on the right, three arches receding, and a domed hull on the horizon. In combat, the hull, round cluster, reticle and hero all still stack in one central column, and the lower-left 40% of the hero frame is empty cloud. |
| 6 | UI clarity & polish | **7** | The perimeter HUD is clean and legible over bright sky, and damage is now a single "HULL -16" popup rather than a log. Problems: the TGT HP bar is full while nothing is locked (LOCK 0/6), the yellow/black hazard stripe under CLOUDGATE changes width between frames and has no legend, and the HUD capture again shows the same moment as combat rather than a distinct HUD state. |
| 7 | Juice & finish | **6** | This is the most improved axis. cloudgate_combat shows a fired beam (white core with red halo; ≈ 350-830, 560-1080) that matches beams C, and the telegraph line and hot exhaust appear in the other two frames. There is still no explosion, enemy hit flash, player fire or speed streaks in any Cloudgate frame. |

**Average: 39 / 6 = 6.50. No axis is below 5, but the average is under 7. M2 fails.**

---

## Gate M4 — peak moment (wreckfield_combat boss, cloudgate_combat, violetTide_combat)

| # | Axis | Score | Evidence |
|---|---|---|---|
| 1 | Board match | **7** | The BULWARK matches enemies B (dark broad wing, warm edge lights, yellow emitters). The twin yellow lines match the vfx-beam "boss telegraph" cells. violetTide matches vista-violet C (indigo sky, narrow orange horizon, white sun), and its ring shows the three separated R/G/B bands. The boss rounds form a rigid double row, which does not match the scattered field on vfx-bullets B. |
| 2 | Readability | **6** | Violet now shows its shooters: five darts on the horizon (≈ 1090-1260, 480-500), consistent with CONTACTS 11. The boss silhouette is clean, with no asteroid crossing it. But 22 rounds form a solid double wall across the boss's belly and the reticle (≈ 725-1245, 425-545), and the Cloudgate strider is still buried under its own fire. |
| 3 | Lighting & colour | **7** | Each stage has one key light: the Wreck planet at upper right, the Violet low sun ahead, and the high Cloudgate sun. Wreck asteroids now have modelled facets with a warm rim, and the bright-to-dark swing across stages holds. The Violet cloud sea is still mid-value rose (lower third ≈ 30-40% luminance) rather than the dark sunset the bible calls for. |
| 4 | Depth & composition | **6** | The large flat foreground asteroid is gone, and the boss is bigger (≈ 47% of frame width) with planet, boss and asteroids as three depth layers. It is still framed flat-on and symmetric with bullet rows parallel to the frame, so it reads as a wall rather than the overhanging scale of ref 07. Violet is balanced: explosion right, hero centre, sun on the thirds. |
| 6 | UI clarity & polish | **7** | The stacked "HULL -3" log is gone, and Violet's CONTACTS count now agrees with the visible enemies. But the boss health sliver sits inside the upper bullet row, right over the reticle (≈ 910-1140, 457), and no combat frame shows lock brackets. |
| 7 | Juice & finish | **6** | violetTide is a real peak: a hot yellow burst, a three-band ring, debris shards and a smoke trail (≈ 1160-1920, 350-700). Cloudgate fires a beam. But the boss frame, the gate's centrepiece, shows only a telegraph and lit emitters: no fired beam, no hit flash on the boss, no explosion, no smoke. |

**Average: 39 / 6 = 6.50. No axis is below 5, but the average is under 7. M4 fails.**

---

## Paired comparison against earlier rounds

| Gate | Round 1 | Re-gate | Round 3 | Trend |
|---|---|---|---|---|
| M2 | 6.33 (juice 4) | 6.33 | **6.50** | Slightly better, from juice (fired beam) and the cleaner damage popup |
| M4 | 6.00 (juice 4) | 6.00 | **6.50** | Better on readability (Violet shooters visible), composition (foreground asteroid removed) and juice (Violet explosion) |

Which round is better?
- **Wreckfield (round 3 vs 111124Z):** round 3 is better. The left-third asteroid wall and the five-line HULL log are gone, and the boss is larger and readable. But the four huge single rounds became a 22-round double wall, and the boss is still inert.
- **Violet:** round 3 is clearly better. Visible shooters and a full explosion with ring replace an empty sea with no attributable fire.
- **Cloudgate combat:** round 3 is marginally better. The beam firing is new, but the strider is still invisible and the rounds are still clustered.

Four axes stop both gates from reaching 7: readability, juice on the boss, Cloudgate environment density, and lock feedback.

---

## Top 5 defects (ranked by visual impact)

### D-1 — Hostile rounds mass into walls over the reticle and hide their shooter [high]
- **Capture:** cloudgate_combat (≈ 715-1115, 440-660), wreckfield_combat (≈ 725-1245, 425-545), cloudgate_hud.
- **Expected:** Rounds read as separate discs with space around them (vfx-bullets B), and the shooter stays visible (bible keyword 2: "the craft, hostile fire, targets and pickups stay separable").
- **Actual:** In Cloudgate about 25 overlapping discs sit on the reticle and the STRIDER cannot be seen. At the boss, 22 rounds in two rigid rows cover its belly, the reticle and its health sliver.
- **Suggested fix:**
  - Cap the number of simultaneously live rounds in the central 20% of the screen.
  - Stagger boss volleys in time and spread them in depth (fans or arcs, not rows parallel to the image plane).
  - Bias Cloudgate strider fire so it leaves from beside the body, not in front of it.
  - Time the gate captures to show the shooter between volleys.
- **Owner lane:** gameplay patterns (src/game) + Director capture timing.

### D-2 — Boss peak frame is inert: telegraph only, flat-on framing [high]
- **Capture:** wreckfield_combat.
- **Expected:** A peak moment in the spirit of ref 07: a boss beam firing (beams C, white core with yellow/red halo), a hit flash or explosion on the boss, and a camera angle that shows scale.
- **Actual:** Two thin yellow telegraph lines and lit emitters, with the boss centred, symmetric and seen flat-on. The Violet frame has more spectacle than the boss frame.
- **Suggested fix:**
  - Capture during the fire window (t ≈ 0.5 of beam C), with at least one player hit landing (hit flash plus a small explosion on an emitter).
  - Add a 10-20° roll or pitch and a lower camera so a wing overhangs the frame.
- **Owner lane:** Director (capture script and camera) + VFX lane.

### D-3 — No lock brackets or target markers in any combat frame [high]
- **Capture:** all three combat captures (LOCK 0/6, 1/6, 2/6).
- **Expected:** Red corner brackets with lock count and small HP ticks on hostiles, as on the approved hud board.
- **Actual:** No marker on any hostile. TGT shows STRIDER or BULWARK with a full or partial HP bar while nothing on screen is marked, and the enemies in Cloudgate and Violet are tiny and hard to find.
- **Suggested fix:** Render brackets on locked targets and dotted soft markers on unlocked hostiles in range. Make sure the capture includes at least one lock.
- **Owner lane:** HUD lane.

### D-4 — Cloudgate environment thin: no cumulus towers, no rim on the hull, RGB fringe [med]
- **Capture:** cloudgate_hero, cloudgate_combat.
- **Expected:** vista-cloudgate C: a dense corridor with cumulus stacks on the horizon, and a hull with a thin rim only on its silhouette edges.
- **Actual:** The hero frame shows only a flat cloud sea. The hull edge against the sky has no rim. The small hull lights and the arch edges show red/green/blue triplets from the chromatic post effect.
- **Suggested fix:**
  - Place cumulus stacks along the corridor horizon behind the arches.
  - Add a silhouette-edge rim to the hull material.
  - Clamp chromatic aberration to zero for small emissive points, or reduce it near the frame centre.
- **Owner lane:** environment lane + post lane.

### D-5 — HUD signals ambiguous: hazard stripe, HP sliver placement, duplicate HUD capture [med]
- **Capture:** cloudgate_combat, cloudgate_hud, wreckfield_combat.
- **Expected:** Every HUD element maps to a visible cause, and the HUD capture shows a distinct state (lock, chain or shield popups, as on hud-states).
- **Actual:**
  - The yellow/black stripe under CLOUDGATE changes width between frames and has no label.
  - The boss health sliver sits inside a bullet row over the reticle.
  - cloudgate_hud is the combat moment half a second later.
- **Suggested fix:**
  - Label the stripe (for example "BEAM WARN") or tie it to the telegraph.
  - Anchor the boss sliver above the boss's hull, not at a fixed offset.
  - Stage the HUD capture with a lock, a chain of 3 or more, and a popup.
- **Owner lane:** HUD lane + Director capture script.

---

**Verdict:** M2 at 6.50 fails and M4 at 6.50 fails. No axis is below 5, both averages are up since the re-gate, and fixing D-1 to D-3 is the shortest path to 7.
