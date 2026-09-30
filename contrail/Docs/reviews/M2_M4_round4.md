# Reviewer — M2 look lock + M4 peak moment (round 4)

Fresh-context review based only on images, the GAME_FORGE section 12 rubric and the STYLE_BIBLE "Current values" table.

**Inputs opened:** all of them opened, so there are no zero scores.
- **Captures (m2):** cloudgate_hero, cloudgate_combat, violetTide_combat, wreckfield_combat and contact (round 4 sheet, 11:26:45Z).
- **HUD and title:** the look/approved/hud board and captures/latest/title.
- **Progress frames:**
  - m2/112556Z_hero and _combat, 112617Z_combat and 112628Z_combat (the round 4 set).
  - m2/111922Z_hero and _combat, 111951Z_combat and 112002Z_combat (the round 3 set).
  - goldpath/112306Z_p50.
- **Approved boards:** vista-cloudgate, vfx-bullets and hud.
- **Owner reference 07:** used for relationship only.

Axis 5 (motion) and axis 8 (technical) are out of scope for these gates.

**Key observation (from an md5 check):**
- `violetTide_combat.png` is byte-identical to round 3's `111951Z_combat`.
- `wreckfield_combat.png` is byte-identical to round 3's `112002Z_combat`.

Only the two Cloudgate frames changed this round, so two of the three M4 frames carry no new work.

---

## Gate M2 — look lock (Cloudgate hero, environment, HUD)

| # | Axis | Score | Evidence |
|---|---|---|---|
| 1 | Board match | **7** | The hero still matches hero B (light livery, orange nose band and vents, blue canopy, ink outline; ≈ 725-1160, 490-615), and the hull and arches match structures B. The hero-frame sky is still a flat cloud sea with no cumulus towers, far from vista-cloudgate C, even though goldpath p50 shows the game can render those towers. |
| 2 | Readability | **5** | The hero reads at a glance in both frames. In cloudgate_combat about 25 rounds still pile onto the reticle (≈ 650-1085, 400-630), so the STRIDER named in TGT shows only as tiny darts at the edge of the pile (≈ 730, 500; 820-1000, 410-440). In the hero frame four rounds sit on top of the wing and nose (≈ 1000-1190, 560-660). |
| 3 | Lighting & colour | **6** | Palette discipline holds: sky.day blue, cream cloud, near-black hull, warm and cool split on the craft. This round adds heavy RGB chromatic fringing, about 8-12 px of separate red, green and blue edges, on the near arch and cloud edge (hero ≈ 0-330, 100-650) and on the hull edge (≈ 1690-1760, 650-780), which reads as a post error rather than post A. The hull lights still show RGB triplets, and the hull silhouette in combat still has no rim. |
| 4 | Depth & composition | **7** | The hero frame keeps its strong recession (hull wall, three arches, domed hull on the horizon), and the new burst now occupies the upper-left mid-ground. The lower-left ≈ 35% is still empty cloud. In combat the hull, rounds, reticle and hero still stack in one centre column. |
| 6 | UI clarity & polish | **7** | The HUD is unchanged from round 3 and matches hud C: the perimeter is legible and the single "HULL -16" popup works. The TGT HP bar is still full at LOCK 0/6 with no lock brackets (the hud board shows red corner brackets with lock counts), and the hazard stripe under CLOUDGATE has no legend. |
| 7 | Juice & finish | **7** | This round's gain: the hero frame now has a hot yellow burst with spark petals and ember puffs (≈ 360-760, 380-740) plus a hostile tracer, and cloudgate_combat adds an R/G/B shock ring and flame on the hero (≈ 945-1185, 540-660) next to the fired beam. There is still no enemy hit flash, player fire or speed streaks. |

**Average: 39 / 6 = 6.50. No axis is below 5, but the average is under 7, so M2 FAILS.**

---

## Gate M4 — peak moment (wreckfield_combat boss, cloudgate_combat, violetTide_combat)

| # | Axis | Score | Evidence |
|---|---|---|---|
| 1 | Board match | **7** | The BULWARK matches enemies B, and the twin yellow telegraph lines match vfx-beam. Violet matches vista-violet C, and its ring has three separated bands. The boss rounds are still a rigid 11 + 11 double row (≈ 725-1245, 425-545), unlike the scattered field on vfx-bullets B. |
| 2 | Readability | **6** | The five Violet shooters are visible on the horizon (≈ 1090-1260, 480-500), and the boss silhouette is clean. But the boss rounds form a solid wall across the reticle and the boss belly, and the Cloudgate strider is still buried under its own fire. |
| 3 | Lighting & colour | **7** | Each stage has one key light (planet upper right, low violet sun, high Cloudgate sun), and the bright-to-dark swing across stages holds. The Violet cloud sea is still a mid-value rose (lower third ≈ 30-40% luminance) against the bible's dark sunset (#5C2A55, median luminance under 6%). |
| 4 | Depth & composition | **6** | The boss frame is unchanged: flat-on and symmetric, with bullet rows parallel to the frame. It reads as a wall, not the overhanging, cropped scale of ref 07. Violet stays well balanced. |
| 6 | UI clarity & polish | **7** | Violet's CONTACTS 11 matches the visible enemies, and there is no damage log. The boss health sliver still sits inside the upper bullet row, over the reticle (≈ 910-1140, 457), and no combat frame shows lock brackets. |
| 7 | Juice & finish | **6** | The Violet explosion and the new Cloudgate hit ring carry this axis. The boss frame, which should be the gate's centrepiece, still shows only a telegraph and lit emitters: no fired beam, hit flash, explosion or smoke. |

**Average: 39 / 6 = 6.50. No axis is below 5, but the average is under 7, so M4 FAILS.**

---

## Paired comparison against round 3

| Gate | Round 1 | Re-gate | Round 3 | Round 4 | Trend |
|---|---|---|---|---|---|
| M2 | 6.33 | 6.33 | 6.50 | **6.50** | Flat. Juice rose (+1) but lighting fell (-1) because of the new chromatic fringing. |
| M4 | 6.00 | 6.00 | 6.50 | **6.50** | Flat. Two of the three frames are byte-identical to round 3. |

**Which is better, frame by frame:**
- **cloudgate_hero, round 4 vs 111922Z:** round 4 is better on spectacle, because the burst fills the mid-ground and the hero now sits inside the action. Round 3 is cleaner: less RGB fringing, and no rounds pasted over the hero. Net: round 4 is slightly better, provided the fringing is removed.
- **cloudgate_combat, round 4 vs 111922Z:** round 4 is slightly better. The hero hit ring and flame are new feedback, and the pile has moved off the hero. The round pile over the reticle is essentially the same size.
- **violetTide and wreckfield:** identical to round 3, so no change.

---

## Top 5 defects (ranked by visual impact)

### D-1 — Boss peak frame unchanged: bullet wall, no payoff [high]
- **Capture:** wreckfield_combat.png (byte-identical to round 3's 112002Z_combat).
- **Expected:**
  - A peak moment at the scale of ref 07: a fired beam or a hit on the boss (flash, sparks, smoke).
  - Boss fire as a scattered field per vfx-bullets B.
  - A boss framed off-axis so it overhangs the frame.
- **Actual:**
  - A symmetric flat-on boss.
  - An 11 + 11 rigid double row of rounds (≈ 725-1245, 425-545) over the reticle.
  - A telegraph only, with no fired beam or hit.
  - The HP sliver buried in the upper row.
- **Suggested fix:**
  - Capture at the moment the beam fires, or during the boss's hit reaction.
  - Break the fire pattern into staggered arcs with depth spread.
  - Tilt or offset the camera so a wing crops the frame edge.
  - Move the boss HP bar to the top band, or above the boss.
- **Owner lane:** Director/capture (moment choice), plus the enemies and vfx lanes.

### D-2 — Cloudgate fire pile buries the target, and there is no lock language [high]
- **Capture:** cloudgate_combat.png.
- **Expected:** Per the hud board: red corner brackets and lock counts on targets, the STRIDER readable as a silhouette, and hostile rounds separable.
- **Actual:**
  - About 25 rounds overlap in one clump over the reticle (≈ 650-1085, 400-630).
  - The strider is visible only as tiny darts at its edge.
  - There are no brackets.
  - TGT HP shows full at LOCK 0/6.
- **Suggested fix:**
  - Lower the strider's burst count, or spread its emission cone.
  - Offset the capture time until the strider is clear of its own volley.
  - Always draw the target bracket on the enemy named in TGT (hide the TGT HP bar when nothing is locked).
- **Owner lane:** Director (encounter and capture) and the HUD lane.

### D-3 — Heavy RGB chromatic fringing in the hero shot [medium-high]
- **Capture:** cloudgate_hero.png (new this round) and, to a lesser degree, cloudgate_combat.png.
- **Expected:** Light post A: at most a 1-2 px colour fringe at the frame edges. Hull lights as single warm or white points.
- **Actual:**
  - 8-12 px red, green and blue edges on the near arch and cloud rim (≈ 0-330, 100-650) and on the hull edge (≈ 1690-1760, 650-780).
  - The hull lights still render as RGB triplets.
  - The effect reads as a broken render, not as analogue grade.
- **Suggested fix:**
  - Clamp the chromatic-aberration offset, scaled by radius, to the post A board value.
  - Check whether the hero camera or FOV multiplies the offset.
  - Exclude small emissive points from the separation.
- **Owner lane:** post lane.

### D-4 — Cloudgate hero sky is a flat cloud sea, not the Cloudgate C corridor [medium]
- **Capture:** cloudgate_hero.png.
- **Expected:** vista-cloudgate C's cumulus towers and horizon banks behind the arches. goldpath p50 proves the stage can render them.
- **Actual:**
  - A featureless cream plane fills the whole lower half.
  - There are no towers behind the arches.
  - The lower-left ≈ 35% of the frame is empty.
- **Suggested fix:**
  - Choose a hero camera time and path segment that has cumulus in view, or place 2-3 tower clusters along the arch corridor.
  - Let a tower or smoke trail occupy the lower-left.
- **Owner lane:** environment lane (Cloudgate), plus Director (hero camera).

### D-5 — Violet Tide cloud sea too bright for the "dark sunset" rule [medium]
- **Capture:** violetTide_combat.png (unchanged since round 3).
- **Expected:** Far fog #5C2A55, median luminance under 6%, and a dark indigo cloud sea under the narrow orange horizon.
- **Actual:** The lower third is a mid-value rose (≈ 30-40% luminance), which flattens the bright-to-dark drama and lowers the contrast of the hero's orange livery.
- **Suggested fix:**
  - Darken the cloud-sea albedo and fog toward indigo #2A1F5A.
  - Keep the magenta highlight only on sun-facing crests.
  - Re-measure the median luminance.
- **Owner lane:** environment lane (Violet Tide).
