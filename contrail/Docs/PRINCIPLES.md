# PRINCIPLES — CONTRAIL (GAME_FORGE W1 item 2)

Genre: third-person arcade rail shooter. Camera: chase camera on a spline rail, with the reticle leading the craft. Art direction: analogue-anime hard-surface, built procedurally.

This file lives at `Docs/PRINCIPLES.md` instead of `Docs/refs/` because the reference pack is private and gitignored (see DECISIONS 04:48Z).

Numbers marked [O] come from measurements in `Docs/REF_VERIFICATION.md`. Numbers marked `assumption: tune in playtest` are my own starting values. Every rule can be checked on a capture or in a log.

## A. Threat readability (our differentiator)
1. **Every hostile projectile has a bright core.** The core's luminance must be at least 3x the local background. Reason: in the reference hot stage the ratio is 2.3:1 and hostile fire gets lost; on space it is over 20:1. Test: ID-mask luminance ratio in `npm run readability`.
2. **The hostile core is at least 1.8% of frame height and the halo is at least 3.5%.** The reference orbs are 1.9-5.3% [O], so the seed's 0.9% would make our threats smaller than theirs. Test: measure the orb bbox in a 1080p capture.
3. **Hostile fire must differ from its background by at least 60 degrees of hue, or carry a dark outline ring.** Reason: an orange halo on an orange sky was measured as identical (#FD7401 versus #F87400). Test: sample the hue under each projectile at peak density.
4. **Player fire uses cool colours (cyan to white) and is at most 60% the size of hostile orbs.** Reason: the reference mixes yellow player shots with yellow enemy shots, so ownership can't be read. Test: no player projectile hue falls between 20 and 70 degrees.
5. **Lasers telegraph for 0.7 s, then extend from the emitter at 1.5 frame widths per second before they deal damage.** The extension phase is observed in m4 [O]; the 0.7 s telegraph is `assumption: tune in playtest`. Test: laser length grows monotonically over 3 or more frames before a damage tick is logged.
6. **Beam cross-section runs white core : yellow edge line : red halo, with the core about 65% of width** [O]. Reason: the broad core stays readable on any background. Test: sample a cross-section and expect W, then Y, then R moving outward.
7. **Incoming orbs grow at least 2x on screen before impact** (m4: 2.5% to 6.5% [O]). Reason: growth is the only depth cue a round orb has. Test: size ratio of the same orb between spawn and within 20 m of the player.
8. **No hostile fire spawns during a cloud whiteout, or within 0.3 s after it ends.** Reason: frame luminance above 85% hides every warm threat (m3). Test: goldpath log reports no bullet spawns while mean luminance is above 0.85.
9. **Enemy hit feedback is a white 2-frame flash plus a pop.** The reference uses a red-orange body tint lasting 0.3 s, which is hard to tell apart from the enemy's own red lights. Test: the frame after a hit contains more than 50% white pixels in the enemy mask.

## B. Colour coding
10. **Colour meaning is fixed across the game:**
    - green = HUD and friendly UI
    - white = HUD text
    - red = danger (shield bar, locks on the player, lasers, damage tint)
    - yellow = hazard and hostile orbs
    - cyan = player fire and pickups
    Reason: the reference follows most of this, and it survives palette shifts between stages. Test: token audit in `tokens.ts`.
11. **Shape repeats every colour meaning:**
    - reticle = circle
    - lock = square-corner brackets
    - hazard = rails or stripes
    - pickups = diamonds
    Reason: colour-blind play, and hot stages. Test: greyscale capture review.
12. **Green belongs to the HUD only.** Scenes contain no foliage-green and no green emissives; only the RGB-split ring may add green. Test: the green-hue pixel count outside the HUD mask is under 2% except while a ring is active.
13. **Palettes are closed.** Each stage has at most 6 scene hues plus the fixed threat colours. Nothing is random. Test: palette histogram of a capture against the stage tokens.
14. **The canopy is the only cool accent on the craft.** Hull warm light grey #A89A81 to #CDBAA8, emissive yellow inside red-orange frames [O]. Test: craft-mask hue histogram.

## C. Depth cues
15. **Aerial perspective.** Structures gain about 50% value toward the fog colour across the corridor depth (#1F3B48 near, #778C96 far [O]). Test: sample structure luminance at 50 m and at 400 m.
16. **One dark mass per corridor.** Keep a single dark side mass under 6% luminance, covering 20-35% of the frame, beside fog above 45%. Reason: 04. Test: luminance map of the capture.
17. **Parallax layers.** At least 3 layers at all times: near debris or smoke, mid enemies, far cloud or planet. Test: a Look-Dev board with depth buckets.
18. **Smoke ribbons are depth rulers.** They are 16-23% of frame height near the camera and about 6% far away [O], and they persist for at least 2 s (target 5 s). Test: ribbon width at the spawn point versus at 2 s.
19. **Speed streaks stay near the edges.** Streaks live in the outer 25% of the frame; the central 50% stays clear. Reason: streaks sell speed without covering targets. Test: streak mask coverage inside the centre box is under 2%.

## D. Motion feel
20. **A drift is a slide plus a yaw.** The craft yaws at least 60 degrees toward side-on and slides 30-60% of frame width within 0.8 s while the camera looks ahead [O shape; numbers `assumption: tune in playtest`]. Test: craft screen-position delta in the capture.
21. **Rings pop, then hold.** A ring appears at 85% of its final size, eases to 100% within 0.1 s, and grows by at most 10% while fading. Final width is 45-55% of frame width with aspect about 0.58 [O]. Hit ring 0.2 s, wingtrail ring 0.6 s (`assumption: tune in playtest`).
22. **Ring bands.** Three bands, red inside, green, blue outside, totalling 14% of the radius [O]. Test: radial scan of a capture.
23. **Explosions.** Diameter doubles within 0.3 s [O]. Lemon core #F9FF12, orange angular chunks #EA821A. Visible no longer than 0.8 s so they don't hide the next threat (`assumption: tune in playtest`).
24. **Hit-stop is 40-60 ms, screen shake at most 0.15 m.** Reason: feel without breaking aim (`assumption: tune in playtest`). Test: frame-time log.
25. **Combo text.** The event label lives 0.2 s and slides out; the counter persists and counts up [O]. Test: frame sequence.

## E. HUD hierarchy
26. **Perimeter only.** Top band 8.5% and bottom band 9.1% of frame height [O]. The centre 80% x 70% of the frame holds only the reticle, locks and floating pops. Test: HUD mask coverage of the centre box is under 3%.
27. **Band scrim.** Black at 30% opacity under both bands [O]. White primary text keeps at least 4.5:1 contrast over a 92%-luminance sky. Test: contrast sample over Cloudgate.
28. **Three tiers of text:**
    - primary white values at 2% of frame height
    - bright-green state chips
    - green corner labels at 0.75%
    Nothing else. Test: glyph height audit.
29. **Reticle.** Ring 12% of frame height, 12 ticks, a centre cross and a lag circle at 0.5x size [O]. Never scaled with distance. Test: capture measurement.
30. **Danger escalates in fixed steps:**
    - shield bar shrinks
    - pilot frame tints red on the hit frame
    - hazard rails blink at 4 Hz with a banner
    Each step is visible from peripheral vision. Test: the HUD board's hazard-state capture.
31. **Boss health goes in the top-right segment.** That segment is empty otherwise [O]. Test: boss capture.

## F. Camera framing
32. **Rest position.** The craft rests at 50% x / 68% y of the frame and is 12-18% of frame width. The reticle leads it by 8-15% of frame height [partly O; `assumption: tune in playtest`]. Reason: the reference lets the craft wander from 17% to 72% x, which covers targets. We keep more discipline and allow wander only during drift (±30%).
33. **Craft never enters the centre box.** The craft never covers the reticle or the central 20% x 20% box. Test: overlap of the craft mask with the centre box stays under 1% of frames.
34. **Roll.** Camera roll is at most 30% of craft bank, capped at 15 degrees (`assumption: tune in playtest`). Reason: m1-style heavy roll disorients aim.
35. **Bosses fill the frame.** A boss silhouette covers at least 50% of frame width at its intro [O, 07].

## G. Difficulty and pacing
36. **Density ramps in 30-40 s steps, with a 15-30 s breather after each peak** (DESIGN_SEED template; `assumption: tune in playtest`). Test: goldpath spawn log.
37. **Peak density is capped at 60-90 live hostile projectiles.** No more than 4 threat types may be new within any 20 s window. Reason: readability collapses beyond that. Test: spawn log.
38. **Every new mechanic appears first in a safe beat of at least 5 s with at most 1 enemy.** Test: stage script review.
39. **Parry and roll have a cost:** 3 charges with 2 s recharge each (DESIGN_SEED). Reason: reviewers called the reference's roll a spam button.

## H. Effect budgets
40. **At most 2 full-screen post effects peak at the same time.** For example, chromatic aberration at 0.008 during a ring plus bloom. Reason: m1's heavy RGB split and grain hides the targets. Test: post-parameter log.
41. **Chromatic aberration is 0 in the centre 40% of the frame** and at most 0.006 UV at the edges outside ring events. Test: capture of a white grid.
42. **At most 3 rings at a time, at most 40 explosion sprites, at most 6 active smoke ribbons.** Budgets hold at peak density at 60 fps on a real GPU (`assumption: tune in playtest`). Test: `npm run perf`.
43. **Bloom applies to emissives and effects only.** HUD, text and reticle are drawn after bloom.

## Rejected looks
- Default-material grey or untextured Lambert craft. Rule: every mesh has panel seams plus a palette token.
- Saturated primaries used as flat fills in the scene: pure #FF0000, #00FF00 or #0000FF outside the HUD, lasers and rings.
- Flat unlit shapes with no rim light. Rule: every enemy has a rim at least 20% brighter than its body.
- Random or per-object palettes. Rule: stage tokens only.
- **Warm fire on a warm background.** The reference's hot stage puts #FD7401 halos on a #F87400 sky, with a core ratio of 2.3:1.
- **Yellow player shots mixed with yellow enemy shots.** The reference makes it impossible to tell whose shot is whose.
- **Heavy full-frame RGB split plus grain during combat.** In m1 and 06 debris and targets fringe apart.
- **Enemy hit flash in red/orange on an enemy with red lights** (m4). It does not read as a hit.
- **Chase camera that lets the craft wander into the upper third** or over the reticle (reference 04, 05, 07).
- **Thin green HUD labels without a scrim over yellow beams.** The corner labels vanish in 05 and 07.
- **Full-screen whiteout while threats are live** (m3).
- Photoreal PBR, low-contrast overcast sky, neon-only cyberpunk palette, fog that flattens all layers.
- Anime faces, the reference's font, glyph shapes, portrait art, layout copied pixel for pixel, or its emblem designs.
