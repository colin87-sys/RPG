# Reviewer — M2 look lock + M4 peak moment (round 5)

Fresh-context review based only on images, the GAME_FORGE section 12 rubric and the STYLE_BIBLE "Current values" table. Axis 5 (motion) and axis 8 (technical) are out of scope for these gates.

**Inputs opened:** all of them opened, so there are no zero scores.
- **Captures (m2):** cloudgate_hero, cloudgate_combat, violetTide_combat, wreckfield_combat.
- **HUD and title:** look/approved/hud and captures/latest/title.
- **Progress frames:**
  - m2/112924Z_hero and _combat, 112947Z_combat and 112958Z_combat (these are the round 5 sources and have the same md5 as the captures).
  - m2/112556Z_hero and _combat, 112617Z_combat and 112628Z_combat (the round 4 set, used for the paired comparison).
  - goldpath/112306Z_p50.
- **Approved boards:** vista-cloudgate, vfx-bullets and hud.
- **Owner reference 07:** used for relationship only.

**Key observation:**
- All four md5s are new, but the scene content is the same as round 4 in every frame. Camera, time, enemy and bullet positions, explosions, HUD values and popups all match pixel for pixel in layout.
- The only visible change is post-processing. The RGB chromatic fringing drops from about 8-12 px to about 2-3 px:
  - hero: the arch at ≈ 0-330, 100-650 and the hull edge at ≈ 1690-1760;
  - combat: the arch at ≈ 1500-1600, 300-700;
  - violet: the smoke puffs at ≈ 1600-1920, 510-560.
- Faint RGB triplets remain on the hull lights (hero ≈ 1400-1530, 60-130).

---

## Gate M2 — look lock (Cloudgate hero, environment, HUD)

| # | Axis | Score | Evidence |
|---|---|---|---|
| 1 | Board match | **7** | The hero matches hero B (light livery, orange nose band, blue canopy, ink outline; ≈ 725-1160, 490-615), and the hull and arches match structures B. The hero-frame lower half is still a flat cream plane with no cumulus towers or horizon banks from vista-cloudgate C. goldpath p50 shows the game already renders those towers. |
| 2 | Readability | **5** | This is unchanged. In cloudgate_combat about 25 rounds pile onto the reticle (≈ 650-1085, 400-630), and the named STRIDER shows only as tiny darts at the edge of the pile (≈ 730, 500; 820-1000, 410-440). In the hero frame four rounds still sit on the wing and nose (≈ 1000-1190, 560-660). |
| 3 | Lighting & colour | **7** | Up 1. The fringing is now a restrained 2-3 px edge that reads as analogue post A rather than a broken render. Palette discipline holds: sky.day blue, cream cloud, near-armourDark hull, warm/cool split on the craft. Faint RGB triplets on the hull lights and no rim on the combat hull silhouette keep this from 8. |
| 4 | Depth & composition | **7** | This is unchanged. The hero frame recedes strongly (hull wall, three arches, domed hull on the horizon), with the burst in the upper-left mid-ground. The lower-left ≈ 35% is still empty cloud, and in combat the rounds, reticle and hero stack in one centre column. |
| 6 | UI clarity & polish | **7** | The HUD matches hud C: 8.5% band, scrim, slanted glyphs, and a clean "HULL -16" popup. As in round 4, TGT HP shows full at LOCK 0/6 with no red lock brackets on any target (the hud board shows brackets with counts), and the yellow hazard stripe under CLOUDGATE has no legend. |
| 7 | Juice & finish | **7** | This is unchanged. The hero frame has a hot yellow burst with petals and embers (≈ 360-760, 380-740) plus a hostile tracer. cloudgate_combat has a hit ring and flame on the hero next to a fired beam. There is still no enemy hit flash, no player fire and no speed streaks. |

**Average: 40 / 6 = 6.67. No axis is below 5, but the average is under 7, so M2 FAILS.**

---

## Gate M4 — peak moment (wreckfield_combat boss, cloudgate_combat, violetTide_combat)

| # | Axis | Score | Evidence |
|---|---|---|---|
| 1 | Board match | **7** | The BULWARK matches enemies B (dark body, warm rim, bright markers), and the twin telegraph lines match vfx-beam. Violet matches vista-violet C, and its ring has three separated bands. The boss rounds are still a rigid 11 + 11 double row (≈ 725-1245, 425-545), unlike the scattered depth-spread field on vfx-bullets B. |
| 2 | Readability | **6** | The five Violet shooters read on the horizon (≈ 1090-1260, 480-500), and the boss silhouette is clean. But the boss rounds form a solid wall over the reticle and the boss belly, and the Cloudgate strider is still buried under its own volley. |
| 3 | Lighting & colour | **7** | Each stage has one key light (planet upper right, low violet sun, high Cloudgate sun), and the bright-to-dark swing between stages holds. The cleaner fringing helps the Violet smoke. The Violet cloud sea is still a mid-value rose (lower third ≈ 30-40% luminance), against the bible's dark sunset (#5C2A55, median under 6%). |
| 4 | Depth & composition | **6** | The boss frame is still flat-on and symmetric, with the bullet rows parallel to the frame. It reads as a wall, not the overhanging, cropped, underside scale of ref 07. Violet is well balanced, and Cloudgate stacks everything in the centre. |
| 6 | UI clarity & polish | **7** | Violet's CONTACTS 11 and TGT SCANNING are coherent. The boss HP sliver still sits inside the upper bullet row, over the reticle (≈ 910-1140, 457), and no combat frame shows lock brackets. |
| 7 | Juice & finish | **6** | The Violet explosion and ring and the Cloudgate hero hit carry this axis. The boss frame, which should be the centrepiece, shows only a telegraph and lit emitters: no fired beam, no hit flash on the boss, no explosion and no smoke. |

**Average: 39 / 6 = 6.50. No axis is below 5, but the average is under 7, so M4 FAILS.**

---

## Paired comparison against round 4

| Gate | Round 1 | Re-gate | Round 3 | Round 4 | Round 5 | Trend |
|---|---|---|---|---|---|---|
| M2 | 6.33 | 6.33 | 6.50 | 6.50 | **6.67** | +0.17. Lighting rose from 6 to 7 because the fringing is fixed. |
| M4 | 6.00 | 6.00 | 6.50 | 6.50 | **6.50** | Flat. The moments are identical, and only the post pass is cleaner. |

**Which is better, frame by frame:**
- **cloudgate_hero, round 5 vs 112556Z:** round 5 is clearly better. The 8-12 px rainbow ghosting on the arches, cloud rim and hull edge is gone. Composition and content are identical.
- **cloudgate_combat, round 5 vs 112556Z:** round 5 is better on post, with a crisper arch edge and beam edge. Readability is identical because the bullet pile is unchanged.
- **violetTide_combat, round 5 vs 112617Z:** round 5 is slightly better, with less RGB smear on the smoke trail and bullet. The content is otherwise identical.
- **wreckfield_combat, round 5 vs 112628Z:** there is effectively no visible difference.

---

## Top 5 defects (ranked by visual impact)

### D-1 — Boss peak frame is a bullet wall with no payoff [high]
- **Capture:** wreckfield_combat.png (the same moment in rounds 3, 4 and 5).
- **Expected:**
  - A peak moment at the scale of ref 07: a fired beam, or the boss taking hits (flash, sparks, smoke, debris).
  - Boss fire as a scattered, depth-spread field per vfx-bullets B.
  - The boss framed off-axis so it overhangs or crops the frame.
- **Actual:**
  - A symmetric flat-on boss.
  - An 11 + 11 rigid double row of rounds (≈ 725-1245, 425-545) over the reticle.
  - A telegraph only, with no fired beam or hit.
  - The HP sliver buried in the upper row.
- **Suggested fix:**
  - Capture during the beam fire, or during the boss's hit reaction.
  - Stagger the volley into arcs with depth spread.
  - Offset or roll the camera so a wing crops the frame edge.
  - Move the boss HP to the top band, or above the hull.
- **Owner lane:** Director/capture (moment choice), plus the enemies and vfx lanes.

### D-2 — Cloudgate fire pile buries the target, and there is no lock language [high]
- **Capture:** cloudgate_combat.png.
- **Expected:** Per the hud board: red corner brackets and lock counts on targets, the STRIDER readable as a silhouette, and rounds separable.
- **Actual:**
  - About 25 rounds overlap in one clump on the reticle (≈ 650-1085, 400-630).
  - The strider is visible only as tiny darts at its edge.
  - There are no brackets.
  - TGT HP shows full at LOCK 0/6.
- **Suggested fix:**
  - Reduce the strider's burst count, or widen its cone.
  - Shift the capture time until the strider is clear of its volley.
  - Always bracket the enemy named in TGT (hide TGT HP when nothing is locked).
- **Owner lane:** Director (encounter and capture) and the HUD lane.

### D-3 — Cloudgate hero sky is a flat cloud sea, not the Cloudgate C corridor [medium]
- **Capture:** cloudgate_hero.png.
- **Expected:** vista-cloudgate C's cumulus towers and horizon banks behind the arches. goldpath p50 proves the stage renders them.
- **Actual:**
  - A featureless cream plane fills the lower half.
  - There are no towers behind the arches.
  - The lower-left ≈ 35% of the frame is empty.
- **Suggested fix:**
  - Choose a hero camera time or segment with cumulus in view, or seed 2-3 tower clusters along the arch corridor.
  - Put a tower or smoke trail in the lower-left.
- **Owner lane:** environment lane (Cloudgate), plus Director (hero camera).

### D-4 — Violet Tide cloud sea too bright for the "dark sunset" rule [medium]
- **Capture:** violetTide_combat.png.
- **Expected:** Far fog #5C2A55, median luminance under 6%, and a dark indigo cloud sea under the narrow orange horizon.
- **Actual:** The lower third is a mid-value rose (≈ 30-40% luminance), which flattens the bright-to-dark drama and lowers the contrast of the orange hero.
- **Suggested fix:**
  - Darken the cloud-sea albedo and fog toward indigo #2A1F5A.
  - Keep the magenta only on sun-facing crests.
  - Re-measure the median luminance.
- **Owner lane:** environment lane (Violet Tide).

### D-5 — Hostile rounds overlap the hero, and residual RGB triplets remain on the hull lights [medium-low]
- **Capture:** cloudgate_hero.png.
- **Expected:**
  - The hero silhouette clear of hostile cores in the showcase shot (silhouette test).
  - Hull lights as single warm or white points.
- **Actual:**
  - Four rounds sit on the nose and wing (≈ 1000-1190, 560-660) and cut the hero's outline.
  - The small hull lights still split into faint R/G/B dots (≈ 1400-1530, 60-130).
- **Suggested fix:**
  - Nudge the hero capture time or seed so the tracer volley passes behind the craft.
  - Exclude small emissive points from the chromatic separation (or mask by luminance or size).
- **Owner lane:** Director (hero capture) and the post lane.
