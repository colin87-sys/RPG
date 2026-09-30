# Reviewer — calibration + M1 in-game look

Date: 2026-09-30. Fresh-context Reviewer; judged from images only (GAME_FORGE §12, STYLE_BIBLE). Every listed image was opened. Owner refs (01, 03, 04, 07) were compared by relationship only (value range, temperature, HUD layout, readability).

---

## Part 1 — Calibration (blind: X, Y, Z)

### Paired comparisons
- **X vs Y → X wins.** Both share the same sky, cloud towers, cloud sea and enemy formation. X frames the whole hero craft in the lower centre with its outline, twin orange exhausts, emblems and wingtip fins visible, so the silhouette test passes. In Y the craft is pushed into the bottom-right corner and cut off by the frame. Only the nose, canopy and one wing root show, so the hero does not read as the delta-wing craft. X's green score text is also legible, while Y's white/grey score blends into the cream cloud top behind it.
- **Y vs Z → Y wins.** Y still follows most of the style bible: sky.day blue, cream-lit clouds with cool-violet shadow sides, a steel/orange livery with outline and panel detail, a warm/cool split and a film-grain post stack. Z breaks the AVOID and REJECTED lists. It has flat unlit shading, a default grey ground plane, a pure-red hero (a pure primary), enemies in arbitrary primary colours (green, blue, yellow, red), and a low-contrast overcast sky with no cloud, fog or depth. Y's defect is framing, which is easy to fix. Z's defects are in the whole look.
- **X vs Z → X wins decisively.** It is better on palette, lighting, depth, livery and HUD token use. The only thing Z does better is a slightly larger, more saturated score, and that is not a style gain.

**Ranking: X > Y > Z.**

### Defects per image
**X**
1. The HUD is only a SCORE string. The bible requires a perimeter HUD: top band with 3 segments, bottom band with 3 cells, right ladder, pilot frame, reticle.
2. The score digits sit over the top of the bright left cloud tower, and the green-on-cream contrast drops across "0012840".
3. The distant cloud-bank crest (y≈260-340) has horizontal streak/banding artefacts, like a scanline smear or alpha-slice stepping.
4. Enemies are tiny (about 1% of frame height), dark specks with no warm rim, no marker lights that read, and no lock brackets. No hostile fire is shown, so the threat read is weak.
5. The composition is symmetric and static. There is no dark structure mass on one side (bible §4), so the bright-to-dark range is weak and the frame is almost all bright values.
6. The left cumulus column is a vertical stack of near-identical puffs, so the repetition is visible.
7. There is no visible rim light on the hero. Separation comes only from the ink outline and exhaust.
8. There are no speed streaks or depth cues near the camera. The cloud sea is soft, with no foreground parallax element.

**Y**
1. The hero craft is cut off at the bottom-right. The silhouette test fails and the rear/delta shape and exhausts are gone.
2. The score text is white/grey instead of the hud.text green (a token error), and its digits are lost against the cloud tower. It looks overlapped or occluded, so it is illegible.
3. The centre and lower half are empty cloud, with nothing anchoring the eye near the reticle zone.
4. The same cloud-crest streak artefacts as X.
5. Enemies are the same tiny dark specks with no brackets, as in X.
6. RGB-split fringing shows on the craft edge at the corner, where the post effect sits on top of the cut-off hero.
7. There is no perimeter HUD.

**Z**
1. Flat, unlit, default-material look with no key/rim/fog (AVOID: "default grey materials", "flat unlit shapes").
2. The hero is pure red, off-palette and a pure primary. The livery, canopy blue and orange inserts are lost.
3. Enemies are random primary colours, so colour implies meaning that does not exist and does not match the dark-with-warm-rim rule.
4. The sky is a uniform grey-blue with a hard horizon at mid-frame, and the ground is a flat grey plane. This is the REJECTED "low-contrast overcast" look, with no depth layering.
5. There is no outline or panel seams, and the exhaust nozzles are empty grey discs with no emissive.
6. There is no post stack, no clouds and no structures. The frame has no drama and a very compressed value range.
7. The HUD is only a score string. The green is legible, but there is no perimeter HUD.
8. The horizon line and craft are both centred, so the composition is flat and cut into halves.

---

## Part 2 — M1 in-game look

Images reviewed: `Docs/captures/latest/combat.png`, `hero.png`, `vista.png`, `title.png`, `hud.png`, `contact.png`; `Docs/progress/integration/20260930T085250Z_{combat,hero,title}.png`; boards `look/approved/{hero,vista-cloudgate,hud,structures,vfx-bullets}.png`; owner refs 01, 03, 04, 07.

Note: `Docs/captures/latest/hud.png` and `contact.png` are dated 05:41, about 3 h before the other latest captures. They show the M0 placeholder, with a flat grey diamond craft and a plain-box HUD. The contact sheet a Reviewer receives does not match the current build (see D-5).

### Scores (axes 1-4, 6, 7)
| # | Axis | Score | Evidence |
|---|---|---|---|
| 1 | Board match | **7** | The hero craft matches the hero board B: swept delta, wingtip fins, ink outline, orange stripe and exhausts (hero.png side view ≈ board SIDE). The hull mass and arches match structures B, and the perimeter HUD matches hud.png almost cell for cell. But hostile bullets render as stacked multi-disc "coin" cylinders (combat/vista) instead of the board's single white-core disc with a dark ring. |
| 2 | Readability | **5** | The hero and hostile bullets separate well against cloud. Enemies are only a few pixels wide, dark specks near the hull (combat ≈ 855,490; vista ≈ 900,560), with no lock brackets or health slivers, while the HUD reads "TGT SCANNING / CONTACTS 00". The player cannot tell what is shooting at them. |
| 3 | Lighting & colour harmony | **6** | Sky.day, cream clouds and cool shadow sides follow the palette, and the high-left key reads on the clouds. The hull and arches are flat grey-teal with no warm rim, though the bible requires rim on enemies/craft and separation. RGB split fringes every high-contrast edge across the whole frame (arches, right-hand cloud cluster in combat/vista), not just the screen edges, which muddies the palette. |
| 4 | Depth & composition | **7** | vista.png has good layering: a dark hull on one side, arches receding in scale, a cloud sea and a bright sky, similar in relationship to owner ref 04's corridor. But the right arch ends in a visible cut face (vista ≈ 1850,900), and in combat.png the reticle, bullets and hero crowd into one ~300 px cluster. |
| 6 | UI clarity & polish | **7** | The layout, corner labels, angular cells, green tokens, red shield and pilot frame match hud.png and the perimeter relationship of refs 01/03. Defects: target panel state contradicts the screen (SCANNING / 00 with threats visible), "13 CHAIN" popup duplicates the STREAK cell, the top band is ~8.3% of frame height vs the 6.5% spec, and the title-screen wordmark "CONTRAIL" plus its subtitle are near-invisible translucent text over sky. |
| 7 | Juice & finish | **5** | Explosions show a yellow-white core with small blooms, and small RGB-split rings appear in hero.png. Missile smoke is a thin dotted grey thread (combat ≈ 1000-1250, 730-950), not the bible's thick cream ribbons, and nothing like the ribbon mass in ref 03. There are no visible speed streaks, no cyan player fire and no enemy hit flash. The latest captures carry about a third of ref 07's spectacle. |

**Average (axes 1-4, 6, 7): 37 / 6 = 6.17.** No axis is below 5, but the average is below 7, so **this gate fails.**

Trend: the latest captures are clearly better than the earlier integration set. The integration combat/hero frames had a heavy cream haze and grain that flattened the value range toward the REJECTED overcast look. The latest set restores the deep sky blue and adds the dark hull, so the bright-to-dark drama now exists.

### Top 5 defects (ranked by visual impact)

### D-1 — Enemies unreadable: specks with no brackets, HUD says no contacts   [impact: high]
Capture: /home/user/RPG/contrail/Docs/captures/latest/combat.png (also vista.png)
Expected: Per hud.png board and bible §4/§7: enemies are dark with a warm rim and small emissive marker lights, and are readable at play distance. Targets get red square-corner lock brackets and a health sliver, and the TGT panel names the target with HP. Ref 04 relationship: enemies are mid-size silhouettes with warm glow around them.
Actual: Enemies are a few pixels wide, dark specks against the dark hull (≈855,490) or pale cloud. There are no brackets and no rim, and the top-right panel reads "TGT SCANNING / CONTACTS 00" while four hostile rounds are inbound.
Suggested fix: Spawn/hold the first waves closer (enemy on-screen height ≥ 2.5% of frame at engage), add the warm rim term and emissive markers from the enemies board, draw passive red corner brackets on every on-screen hostile, and drive CONTACTS/TGT from the live enemy list.
Owner lane: enemies + HUD (Integrator for the contacts wiring)

### D-2 — Hostile bullets render as stacked multi-disc "coins"   [impact: high]
Capture: /home/user/RPG/contrail/Docs/captures/latest/vista.png (also combat.png)
Expected: Per vfx-bullets board B: a single camera-facing disc with a white-hot core, yellow-orange halo and thin dark outline ring. The minimum size rule applies.
Actual: Each round shows 3-4 offset copies of the disc stacked diagonally (vista ≈ 900-1100, 550-700), so it reads as a coin stack or cylinder. It is also oversized (~5% of frame height), which hides the craft and target behind it.
Suggested fix: Check for duplicate instanced draws or a trail/ghost pass that re-renders the sprite at previous positions. Render a single billboard, with any motion trail as a thin tapered streak. Scale by distance to the board's size band.
Owner lane: vfx

### D-3 — Global RGB split / chromatic ghosting across the whole frame   [impact: med]
Capture: /home/user/RPG/contrail/Docs/captures/latest/vista.png (also hero.png, combat.png)
Expected: Per bible §5 and the post board: RGB split at the edges only, mild, and a "thick post that hides the craft" is REJECTED.
Actual: Every arch edge, the right-hand cumulus cluster and the hull greebles show strong red/green/blue double images, even near frame centre (hero.png arches at left, vista.png clouds right). The clouds look out of registration rather than stylised.
Suggested fix: Mask the split with a radial falloff (0 inside ~60% radius, max 2-3 px at the corners), and cut the current offset by at least half. Keep the rainbow for the shock ring VFX only.
Owner lane: post

### D-4 — Missile smoke is a thin dotted thread, not a ribbon   [impact: med]
Capture: /home/user/RPG/contrail/Docs/captures/latest/combat.png
Expected: Per bible §5: thick, pale cream-white ribbons that persist ≥ 2 s (target 5 s) and curve with the camera. Ref 03 relationship: smoke is a dominant bright mass crossing the frame.
Actual: A faint grey, dotted, pencil-thin trail runs from the craft down to the lower right (≈1000-1250, 730-950). It is hard to see against cream cloud and has no volume.
Suggested fix: Widen the ribbon to about 1.5-3% of frame height at the emitter and taper it along its length, use cloud.cream with a cool shadow side and soft puff edges, and extend its lifetime to 5 s. Add a subtle darker edge so it separates from bright cloud.
Owner lane: vfx (smoke)

### D-5 — Title wordmark illegible; stale M0 captures in latest/   [impact: med]
Capture: /home/user/RPG/contrail/Docs/captures/latest/title.png (and latest/hud.png, latest/contact.png)
Expected: Per screens board/bible §6: the title is readable at a glance in the code-drawn techno font. Per §12: the Reviewer's contact sheet reflects the current build.
Actual: "CONTRAIL" is drawn as a pale, translucent outline over the sky and nearly disappears. The subtitle "KESTREL PROGRAM // RAIL SORTIE" cannot be read. latest/hud.png and contact.png are 05:41 M0 placeholders showing a grey diamond craft and box HUD, while the other captures are from 08:57.
Suggested fix: Give the wordmark a space.deep backing plate or a solid hud.text fill with a dark stroke, and aim for ≥ 7:1 contrast. Regenerate hud.png and contact.png in the same capture run as the other shots, or remove them.
Owner lane: HUD/screens + harness (Integrator)

Other issues found, not in the top 5: the right arch ends in an exposed cut face (vista ≈ 1850,900). The "13 CHAIN" popup duplicates the STREAK cell. The top band is ~8.3% of frame height vs the 6.5% spec. The hull has no warm rim or key/fill separation, so it reads as close to default grey. There is no cyan player fire and no speed streaks.
