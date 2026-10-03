# Reviewer — M2 look lock + M4 peak moment (round 6)

Fresh-context review based only on images, the GAME_FORGE section 12 rubric and the STYLE_BIBLE "Current values" table. Axis 5 (motion) and axis 8 (technical) are out of scope for these gates.

**Inputs opened (all opened, so no zero scores):**
- Captures (m2): cloudgate_hero, cloudgate_combat, violetTide_combat, wreckfield_combat.
- HUD board look/approved/hud.png and captures/latest/title.png.
- Progress: m2/113221Z_combat and 113234Z_combat (the round 6 sources; their md5 matches cloudgate_combat and wreckfield_combat). m2/112924Z_combat and 112958Z_combat (round 5 cloudgate and wreckfield, used for the paired comparison). goldpath/113305Z_p75.
- Boards: vfx-beam (plus hud). Owner ref 07, used for relationship only.

**Key observation (from md5):** cloudgate_hero and violetTide_combat are byte-identical to round 5 (112924Z_hero and 112947Z_combat). Only the two combat frames changed:
- **wreckfield_combat changed materially.** The boss beam is now fired, the hero is in a HULL CRIT state, and the volley is spread wider.
- **cloudgate_combat barely changed.** It is the same moment with the round pile slightly re-arranged.

---

## Gate M2 — look lock (Cloudgate hero, environment, HUD)

| # | Axis | Score | Evidence |
|---|---|---|---|
| 1 | Board match | **7** | This is unchanged. The hero matches hero B (light livery, orange nose band, blue canopy, ink outline; ≈ 730-1160, 490-615), and the hull and arches match structures B. The hero frame's lower half is still a flat cream plane with none of vista-cloudgate C's cumulus towers. goldpath p75 shows the stage renders cloud banks behind the hull. |
| 2 | Readability | **5** | In cloudgate_combat about 25 rounds still clump on the reticle (≈ 640-1090, 400-630). The named STRIDER shows only as a small dark dart at the top of the pile (≈ 878, 405) and two tiny darts at its edges. In the hero frame four rounds sit on the nose and wing (≈ 1000-1190, 560-660). |
| 3 | Lighting & colour | **7** | This is unchanged. There is one high sun, a sky.day/cream/armourDark split, and fringing restrained to 2-3 px. Faint RGB triplets on the hull lights (hero ≈ 1400-1530, 60-130) remain. |
| 4 | Depth & composition | **7** | This is unchanged. The hero frame has a strong recession (hull wall, three arches, domed hull). The lower-left ≈ 35% is empty cloud, and the combat frame stacks the rounds, reticle and hero in one centre column. |
| 6 | UI clarity & polish | **7** | The HUD matches hud C: 8.5% band, scrim, slanted glyphs, and a HULL -16 popup. As before, TGT STRIDER shows full HP at LOCK 0/6 with no red corner brackets anywhere (the hud board shows brackets with counts), and the hazard stripe under CLOUDGATE has no legend. |
| 7 | Juice & finish | **7** | This is unchanged. There is a hero-frame burst with embers, and in combat a hit ring and flame on the hero next to a fired beam. There is still no enemy hit flash and no player fire. |

**Average: 40 / 6 = 6.67. No axis is below 5, but the average is under 7, so M2 FAILS.**

---

## Gate M4 — peak moment (wreckfield_combat boss, cloudgate_combat, violetTide_combat)

| # | Axis | Score | Evidence |
|---|---|---|---|
| 1 | Board match | **7** | The boss beam now matches vfx-beam C "boss fire t=.50": a wide white core with yellow edges, running from the boss nose (≈ 1040, 350) to the frame bottom (≈ 500-1060). The BULWARK still matches enemies B. On the other side, the hero loses its hero B livery entirely (see axis 3), and the rounds remain a rigid 11 + 11 double row rather than the vfx-bullets B scatter. |
| 2 | Readability | **6** | The boss silhouette and the beam read instantly. The hero is now a flat white shape that overlaps the white beam core (≈ 720-1030, 640-750) and survives only through its ink outline. The volley is still a wall across the reticle (≈ 600-1340, 450-600), and the Cloudgate strider is still buried. |
| 3 | Lighting & colour | **6** | Down 1. The beam blows the hero out to near-pure white with no shading, canopy, orange inserts or engine glow. It looks clipped and unlit, not lit by the beam. Violet's cloud sea is still a mid-value rose (≈ 30-40% luminance, against the rule of #5C2A55 and a median under 6%). The stage-to-stage bright-to-dark swing still holds. |
| 4 | Depth & composition | **6** | The beam gives the boss frame a strong far-to-near diagonal, which is a real gain. But the boss is still flat-on and symmetric, the bullet rows run parallel to the frame, and nothing overhangs or crops the way ref 07's underside scale does. Violet is balanced, and Cloudgate is centre-stacked. |
| 6 | UI clarity & polish | **7** | This is better. The damage state reads well: HULL CRIT tag, red portrait frame and visor, SHLD LOW, red "16/100", and a HULL -30 popup. The boss HP sliver still sits inside the volley over the reticle (≈ 920-1145, 457), and no combat frame shows lock brackets. |
| 7 | Juice & finish | **7** | Up 1. The boss frame finally has a payoff: a fired beam, lit emitters, a critical-damage state and a popup. Violet's explosion and three-band ring still carry. There is still no boss hit flash, sparks or debris burst. |

**Average: 39 / 6 = 6.50. No axis is below 5, but the average is under 7, so M4 FAILS.**

---

## Paired comparison against round 5

| Gate | R1 | Re-gate | R3 | R4 | R5 | **R6** | Trend |
|---|---|---|---|---|---|---|---|
| M2 | 6.33 | 6.33 | 6.50 | 6.50 | 6.67 | **6.67** | Flat. The M2 inputs are effectively unchanged. |
| M4 | 6.00 | 6.00 | 6.50 | 6.50 | 6.50 | **6.50** | Flat. Juice +1, lighting -1. |

**Which is better, frame by frame:**
- **wreckfield_combat, round 6 vs 112958Z:** round 6 is better as a peak moment:
  - The beam is fired instead of only telegraphed.
  - The damage-state HUD is present.
  - The rounds are spread wider, with gaps between them.

  Round 5 is better on the hero: the orange/steel livery and engine glow read there, while round 6's hero is a white cutout. On net round 6 wins, but it gives back part of the gain.
- **cloudgate_combat, round 6 vs 112924Z:** these are effectively the same. The pile is re-arranged by a few rounds, with a slightly clearer dark shape at the top. No readability gain.
- **cloudgate_hero and violetTide_combat:** these are identical files (same md5).

---

## Top 5 defects (ranked by visual impact)

### D-1 — Hero blown out to flat white under the boss beam [high]
- **Capture:** wreckfield_combat.png.
- **Expected:** Hero B stays readable during any effect. The beam should light it as a warm rim or tint while the livery, canopy, orange inserts and engine glow survive. vfx-beam C shows the craft keeping its shading under a boss beam.
- **Actual:** The hero (≈ 715-1035, 630-755) is almost uniform white with no shading or colour. It overlaps the white beam core, and only the ink outline separates the two.
- **Suggested fix:**
  - Clamp the beam's light contribution on the hero, or apply it as an additive rim only.
  - Exclude the hero from the beam's bloom/threshold, or tone-map it.
  - Or choose a capture where the hero sits beside the beam core rather than inside it.
- **Owner lane:** vfx (beam lighting) plus post (bloom), with Director/capture.

### D-2 — Boss volley is still a rigid 11 + 11 wall, and the peak is framed flat-on [high]
- **Capture:** wreckfield_combat.png.
- **Expected:**
  - Boss fire as a scattered, depth-spread field (vfx-bullets B).
  - The boss framed off-axis, overhanging or cropping the frame, as in the relationship to ref 07.
  - Boss HP clear of the fire.
- **Actual:**
  - Two perfectly aligned rows of 11 rounds (≈ 600-1340, 450-600), parallel to the frame, sit over the reticle.
  - The boss is symmetric and centred.
  - The HP sliver sits between the rows (≈ 920-1145, 457).
- **Suggested fix:**
  - Stagger the volley in arcs with depth offset.
  - Roll or offset the camera so a wing crops the frame edge.
  - Move the boss HP into the TGT.DATA band, or above the hull.
- **Owner lane:** enemies/vfx (pattern), Director (camera), HUD.

### D-3 — Cloudgate fire pile buries the STRIDER, and there is no lock language [high]
- **Capture:** cloudgate_combat.png.
- **Expected:** Per the hud board: red corner brackets and lock counts on targets, and the named STRIDER readable as a silhouette with separable rounds.
- **Actual:**
  - About 25 overlapping rounds sit on the reticle (≈ 640-1090, 400-630).
  - The strider appears only as a small dark dart at the top edge.
  - There are no brackets, and TGT HP shows full at LOCK 0/6.
  - This is unchanged since round 3.
- **Suggested fix:**
  - Cut the strider's burst count or widen its cone.
  - Capture after the volley has separated.
  - Always bracket the TGT enemy, and hide TGT HP when nothing is locked.
- **Owner lane:** Director (encounter/capture) plus HUD.

### D-4 — Cloudgate hero sky is a flat cloud sea, not the Cloudgate C corridor [medium]
- **Capture:** cloudgate_hero.png.
- **Expected:** vista-cloudgate C's cumulus towers and horizon banks behind the arches. goldpath p75 shows the stage can render cloud banks.
- **Actual:** A featureless cream plane fills the lower half, and the lower-left ≈ 35% is empty. This is unchanged.
- **Suggested fix:**
  - Pick a hero time or camera with cumulus in view, or seed 2-3 tower clusters along the arch corridor.
  - Place a smoke trail or tower in the lower-left.
- **Owner lane:** environment (Cloudgate) plus Director (hero camera).

### D-5 — Violet Tide cloud sea too bright for the "dark sunset" rule [medium]
- **Capture:** violetTide_combat.png.
- **Expected:** Far fog #5C2A55 with median luminance under 6%, and a dark indigo sea under a narrow orange horizon.
- **Actual:** The lower third is a mid-value rose (≈ 30-40% luminance). This flattens the bright-to-dark drama and lowers the contrast of the orange hero. It is unchanged.
- **Suggested fix:**
  - Darken the cloud-sea albedo and the fog toward #5C2A55 below the horizon.
  - Keep the sun and horizon band as the only high values.
- **Owner lane:** environment (Violet Tide) plus post (grade).

---

**Summary:** both gates fail again.
- **M2 (6.67):** a pass needs readability in cloudgate_combat (D-3) and the corridor clouds in the hero frame (D-4). Both are the same defects as the last three rounds.
- **M4 (6.50):** the fired beam finally gives the boss moment a payoff, but it costs the hero's look (D-1). D-2 and D-5 are still open.
